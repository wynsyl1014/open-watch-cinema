import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import cv2
import numpy as np

from economy_storyboard import economy_images
from full_storyboard import FALLBACK_HEIGHTS
from storyboard_images import StoryboardPicture, encode_reviewed_part, storyboard_canvas
from storyboard_marks import COLORS, crop_region, mark_crop_pair
from storyboard_selection import compare_frames, review_candidate, select_scene_views, select_storyboard_indices
from worker import ImageSettings, SourceVideoDecoder, StoryboardComposer, analyse_segment, decode_frames


def metric(**changes):
    return dict(dict(sharpness=100, clippedFraction=0, brightness=0.5,
                     motionMeanPixels=0, sceneScore=0, motionScore=0, perceptualHash="ffffffffffffffff",
                     averageRgb=[0.5, 0.5, 0.5]), **changes)


def balanced_settings_dict(**changes):
    return dict({
        "mode": "balanced",
        "assetVersion": 4,
        "storyboardHeight": 268,
        "storyboardJpegQuality": 86,
        "minStoryboardJpegQuality": 60,
        "storyboardMaxBytes": 1_572_864,
    }, **changes)


def read_image(path):
    return cv2.imdecode(np.frombuffer(path.read_bytes(), dtype=np.uint8), cv2.IMREAD_COLOR)


def write_storyboard(composer, times, filename):
    result, = composer.write_storyboards([{"panelTimesMs": times, "filename": filename}])
    return result


class StoryboardTests(unittest.TestCase):
    def test_ten_bit_source_produces_rgb24_frames_for_scan_and_review(self):
        with tempfile.TemporaryDirectory() as temporary:
            video = Path(temporary) / "ten-bit.mkv"
            subprocess.run([
                "ffmpeg", "-v", "error", "-f", "lavfi",
                "-i", "testsrc2=size=160x90:rate=8,format=yuv420p10le",
                "-t", "1", "-c:v", "ffv1", str(video),
            ], check=True, capture_output=True)

            scan = decode_frames(video, 0, 1000, 2)
            self.assertEqual(len(scan), 2)
            self.assertTrue(all(len(frame.pixels) == 192 * 108 * 3 for frame in scan))
            decoder = SourceVideoDecoder(video, cv2, np)
            first = decoder.extract_frame(0)
            self.assertEqual(first.shape, (90, 160, 3))
            self.assertEqual(first.dtype, np.uint8)
            review = list(decoder.extract_images(0, 250, review_mode="balanced"))
            self.assertEqual([timestamp for timestamp, _ in review], [0, 125, 250])
            np.testing.assert_array_equal(review[0][1], first)

    def analyse_samples(self, samples, start_ms=0, visual_start_ms=None, *, sample_fps=2, visual_end_ms=None):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.mp4"
            source.touch()
            fake_composer = SimpleNamespace(
                source={"streamIndex": 0, "width": 1920, "height": 1080, "sampleAspectRatio": "1:1", "rotation": 0.0},
                write_storyboards=Mock(side_effect=lambda items, **kwargs: [{
                    "parts": [{"filename": item["filename"], "mediaTimeMs": item["panelTimesMs"][-1],
                               "image": {"width": 476, "height": 268}}],
                    "panels": [{"mediaTimeMs": t} for t in item["panelTimesMs"]],
                    "image": {"width": 476, "height": 268},
                } for item in items]),
            )
            step_ms = 1000 / sample_fps
            with patch("worker.decode_frames", return_value=[None] * len(samples)), \
                 patch("worker.opencv_metrics", side_effect=[(item, {}) for item in samples]), \
                 patch("worker.StoryboardComposer", return_value=fake_composer):
                result = analyse_segment(
                    source, start_ms, round(len(samples) * step_ms), sample_fps, root, "test",
                    visual_start_ms, balanced_settings_dict(), visual_end_ms=visual_end_ms,
                )
            items, = fake_composer.write_storyboards.call_args.args
            self.assertEqual([item['frameReason'] for item in items], [frame['frameReason'] for frame in result['frames']])
            return result

    def test_static_scene_gets_sparse_heartbeat_images(self):
        result = self.analyse_samples([metric() for _ in range(80)])
        self.assertEqual([frame["mediaTimeMs"] for frame in result["frames"]], [0, 12000, 24000, 36000])
        self.assertTrue(all(frame["frameReason"] == "visual_heartbeat" for frame in result["frames"]))
        self.assertTrue(all(max(frame["panelTimesMs"]) <= frame["mediaTimeMs"] for frame in result["frames"]))

    def test_real_cut_after_heartbeat_is_not_suppressed_and_resets_deadline(self):
        samples = [metric() for _ in range(58)]
        samples[4] = metric(sceneScore=0.9)
        result = self.analyse_samples(samples)
        self.assertEqual([(frame["mediaTimeMs"], frame["frameReason"]) for frame in result["frames"]],
                         [(0, "visual_heartbeat"), (2500, "scene_change"),
                          (14500, "visual_heartbeat"), (26500, "visual_heartbeat")])

    def test_chunk_ownership_starts_with_a_revealed_image(self):
        samples = [metric() for _ in range(34)]
        samples[1] = metric(sceneScore=0.9)
        result = self.analyse_samples(samples, start_ms=296000, visual_start_ms=298000)
        times = [frame["mediaTimeMs"] for frame in result["frames"]]
        self.assertEqual(times, [298000, 310000])
        self.assertTrue(all(time >= 298000 for time in times))

    def test_extra_visual_heartbeat_does_not_throttle_motion_detection(self):
        samples = [metric() for _ in range(30)]
        samples[25] = metric(motionScore=0.3)
        result = self.analyse_samples(samples)
        self.assertIn((12500, "motion_peak"),
                      [(frame["mediaTimeMs"], frame["frameReason"]) for frame in result["frames"]])

    def test_sustained_saturated_motion_still_triggers_periodic_motion_peaks(self):
        samples = [metric()] + [metric(motionScore=1.0) for _ in range(19)]
        result = self.analyse_samples(samples)
        peaks = [frame["mediaTimeMs"] for frame in result["frames"] if frame["frameReason"] == "motion_peak"]
        self.assertEqual(peaks, [3000, 6000, 9000])

    def test_events_outside_ownership_window_are_excluded_without_event_time_shadow(self):
        samples = [metric() for _ in range(16)]
        samples[1] = metric(sceneScore=0.9)   # pre-roll cut settling before visual_start_ms
        samples[12] = metric(sceneScore=0.9)  # tail cut settling at 6500ms >= visual_end_ms
        result = self.analyse_samples(samples, start_ms=0, visual_start_ms=2000, visual_end_ms=6500)
        self.assertTrue(all(2000 <= obs["fromMs"] < 6500 for obs in result["observations"]))
        self.assertTrue(all("eventTimeMs" not in obs for obs in result["observations"]))
        self.assertEqual([f["mediaTimeMs"] for f in result["frames"]], [2000])

    def test_crossed_lookahead_keeps_order_filenames_and_visual_clock_monotonic(self):
        # If an earlier trigger (12000ms heartbeat) settles later (12750ms) than a
        # following trigger (12250ms motion_peak -> 12250ms), both lists and filenames
        # must stay chronological, and the next heartbeat must count 12s from 12750ms.
        samples = [metric() for _ in range(104)]
        samples[49] = metric(motionScore=0.3)

        def fake_select(metrics_list, index, step_ms, reason):
            if index == 48:
                return [48, 51]  # 12000ms -> delivers at 12750ms
            return [index]

        with patch("storyboard_selection.select_storyboard_indices", side_effect=fake_select):
            result = self.analyse_samples(samples, sample_fps=4)
        obs_times = [obs["fromMs"] for obs in result["observations"]]
        frame_times = [frame["mediaTimeMs"] for frame in result["frames"]]
        self.assertEqual(obs_times, sorted(obs_times))
        self.assertEqual(frame_times, [0, 12250, 12750, 24750])
        self.assertEqual([frame["filename"] for frame in result["frames"]], [
            "test-0001-0.jpg",
            "test-0002-12250.jpg",
            "test-0003-12750.jpg",
            "test-0004-24750.jpg",
        ])

    def test_post_cut_stability(self):
        samples = [metric(), metric(sceneScore=0.9), metric(), metric()]
        self.assertEqual(select_storyboard_indices(samples, 1, 500, "scene_change")[-1], 2)

    def test_sharp_exposed_low_motion_sample_wins(self):
        for bad in [metric(sharpness=0), metric(clippedFraction=1), metric(motionMeanPixels=10)]:
            with self.subTest(bad=bad):
                self.assertEqual(select_storyboard_indices([bad, metric()], 0, 500, "motion_peak")[-1], 1)

    def test_dedup_prefers_distinct_context(self):
        samples = [metric(perceptualHash="0000000000000000"), metric(), metric(), metric()]
        self.assertIn(0, select_storyboard_indices(samples, 3, 500, "motion_peak"))

    def test_short_and_sparse_segments_keep_natural_panel_count(self):
        self.assertEqual(select_storyboard_indices([metric()], 0, 2000, "scene_change"), [0])
        self.assertEqual(select_storyboard_indices([metric(), metric()], 1, 2000, "scene_change"), [0, 1])
        frame = self.analyse_samples([metric()])["frames"][0]
        self.assertEqual(frame["panelTimesMs"], [0])

    def test_source_detail_is_not_enlarged_analysis(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            stripes = np.tile(((np.arange(853) // 2) % 2 * 255).astype(np.uint8), (480, 1))
            original = np.repeat(stripes[:, :, None], 3, axis=2)
            cv2.imwrite(str(root / "source.png"), original)
            subprocess.run(["ffmpeg", "-v", "error", "-loop", "1", "-i", str(root / "source.png"),
                            "-t", "1", "-c:v", "ffv1", str(root / "source.mkv")], check=True,
                           capture_output=True)
            frames = decode_frames(root / "source.mkv", 0, 1000, 2)
            self.assertEqual((frames[0].width, frames[0].height), (192, 108))
            settings = ImageSettings.from_mapping({
                "mode": "full",
                "assetVersion": 4,
                "storyboardHeight": 480,
                "storyboardJpegQuality": 92,
            })
            composer = StoryboardComposer(root / "source.mkv", root, settings, cv2, np)
            result = write_storyboard(composer, [0], "full.jpg")
            rendered = read_image(root / result["parts"][0]["filename"])
            self.assertEqual(rendered.shape[:2], (480, 853))
            enlarged = cv2.resize(np.frombuffer(frames[0].pixels, np.uint8).reshape(108, 192, 3), (853, 480))
            source_error = np.abs(rendered.astype(float) - original).mean()
            enlarged_error = np.abs(enlarged.astype(float) - original).mean()
            self.assertLess(source_error, enlarged_error / 4)

    def test_compare_frames_separates_local_crop_broad_full_and_still_review(self):
        base = np.full((268, 476, 3), 40, dtype=np.uint8)
        self.assertEqual(compare_frames(base, base.copy()), ("review", None))

        local = base.copy()
        local[120:145, 200:225] = 230
        kind, box = compare_frames(base, local)
        self.assertEqual(kind, "crop")
        self.assertIsNotNone(box)

        spread = base.copy()
        spread[15:45, 20:55] = 230
        spread[210:240, 410:445] = 230
        self.assertEqual(compare_frames(base, spread), ("full", None))

    def test_review_candidate_drops_minimalist_static_frames_with_compression_noise(self):
        # Smooth gradient has <7 corners so align_frames returns None, yet the frames
        # only differ by slight compression noise and must not be emitted as cuts.
        gradient = np.tile(np.linspace(40, 90, 476, dtype=np.uint8), (268, 1))
        before = np.repeat(gradient[:, :, None], 3, axis=2)
        noisy_mid = before.copy()
        noisy_mid[10:20, 10:20] = np.clip(noisy_mid[10:20, 10:20].astype(int) + 3, 0, 255).astype(np.uint8)
        noisy_after = before.copy()
        noisy_after[30:40, 30:40] = np.clip(noisy_after[30:40, 30:40].astype(int) + 2, 0, 255).astype(np.uint8)
        result = review_candidate(before, noisy_after, 0, 250, lambda s, e: [(125, noisy_mid)])
        self.assertEqual(result, [])

    def test_full_mode_select_scene_views_still_filters_flat_review_frames(self):
        scene = np.random.default_rng(11).integers(0, 180, size=(268, 476, 3), dtype=np.uint8)
        black = np.zeros_like(scene)
        records = select_scene_views(
            [scene, scene.copy()], [0, 250],
            lambda s, e: [(125, black)],
            locate_crops=True,
            detail_review=lambda start, end, preview: [],
        )
        self.assertEqual([ts for _, ts, _, _ in records], [0, 250])


class PreparedAssetTests(unittest.TestCase):
    def settings(self, mode="full", **changes):
        height = 480 if mode == "full" else 268 if mode == "balanced" else 124
        return ImageSettings.from_mapping(dict({
            "mode": mode,
            "assetVersion": 3 if mode == "economy" else 4,
            "storyboardHeight": height,
            "storyboardJpegQuality": 86,
        }, **changes))

    def composer(self, root, settings=None, *, previous_views=()):
        root.mkdir(parents=True, exist_ok=True)
        source = root / "source.mp4"
        if not source.exists():
            source.touch()
        probe = SimpleNamespace(returncode=0, stderr=b"", stdout=json.dumps({
            "streams": [{"index": 2, "width": 1920, "height": 1080, "sample_aspect_ratio": "1:1"}]
        }).encode())
        with patch("video_decode.subprocess.run", return_value=probe):
            return StoryboardComposer(source, root / "图片", settings or self.settings(), cv2, np,
                                      previous_views=previous_views)

    def test_settings_reject_legacy_versions_and_retired_fields(self):
        with self.assertRaises(ValueError):
            ImageSettings.from_mapping({"mode": "balanced", "assetVersion": 2,
                                        "storyboardHeight": 268, "storyboardJpegQuality": 86})
        with self.assertRaises(ValueError):
            ImageSettings.from_mapping({"mode": "full", "assetVersion": 3, "storyboardHeight": 480,
                                        "storyboardJpegQuality": 86})
        with self.assertRaises(ValueError):
            ImageSettings.from_mapping({"mode": "full", "assetVersion": 4, "storyboardHeight": 480,
                                        "storyboardJpegQuality": 86, "masterJpegQuality": 86})
        with self.assertRaises(ValueError):
            ImageSettings.from_mapping({"assetVersion": 3, "storyboardHeight": 480, "storyboardJpegQuality": 86})
        with self.assertRaises(ValueError):
            ImageSettings.from_mapping({"mode": "balanced", "assetVersion": 4, "storyboardHeight": 268,
                                        "storyboardJpegQuality": 86, "minStoryboardJpegQuality": 60})

    def test_all_modes_write_finished_storyboards_without_masters(self):
        scene = np.random.default_rng(7).integers(0, 120, size=(268, 476, 3), dtype=np.uint8)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for mode in ("economy", "balanced", "full"):
                settings = self.settings(mode=mode)
                composer = self.composer(root, settings)
                with patch.object(composer.decoder, "extract_frame", return_value=scene) as extract:
                    result = write_storyboard(composer, [0, 0, 250], f"{mode}.jpg")
                self.assertEqual(extract.call_count, 2)
                self.assertNotIn("hdFrame", result)
                self.assertEqual([p["mediaTimeMs"] for p in result["panels"]], [0, 0, 250])
                self.assertFalse((composer.output_dir / "masters").exists())

    def test_reviewed_economy_keeps_full_views_and_actual_motion_times(self):
        scene = np.random.default_rng(2).integers(0, 110, size=(268, 476, 3), dtype=np.uint8)
        blink = scene.copy()
        blink[110:132, 190:240] = 245
        with tempfile.TemporaryDirectory() as temporary:
            settings = self.settings(mode="economy")
            for samples, times in (([(125, scene)], [0]), ([(125, blink)], [0, 125]), ([], [0, 250])):
                composer = self.composer(Path(temporary), settings)
                with self.subTest(times=times), patch.object(composer.decoder, "transient_frame", return_value=scene), \
                        patch.object(composer.decoder, "extract_images", return_value=samples):
                    result = write_storyboard(composer, [0, 250, 250], "compact.jpg")
                    part, = result["parts"]
                    views = part["image"]["views"]
                    self.assertEqual([v["mediaTimeMs"] for v in views], times)
                    self.assertEqual(part["mediaTimeMs"], times[-1])
                    self.assertEqual([v["box"] for v in views], [[222 * i, 0, 221, 124] for i in range(len(times))])
                    self.assertTrue(all(v["type"] == "full" for v in views))
                    pixels = read_image(composer.output_dir / part["filename"])
                    self.assertEqual(pixels.shape[:2], (124, 222 * len(times) - 1))
                    if times[-1] == 125:
                        self.assertGreater(int(pixels[56, 222 + 100].min()), 220)
                    self.assertFalse((composer.output_dir / "masters").exists())

    def test_shared_context_is_committed_once_across_groups(self):
        scene = np.full((268, 476, 3), 38, np.uint8)
        cv2.putText(scene, "S", (200, 150), cv2.FONT_HERSHEY_SIMPLEX, 2, (90, 90, 90), 2)
        action = scene.copy()
        action[160:180, 225:245] = 230
        frames = {0: scene, 250: action, 500: action}

        with tempfile.TemporaryDirectory() as temporary:
            for mode in ("economy", "balanced", "full"):
                with self.subTest(mode=mode):
                    composer = self.composer(Path(temporary), self.settings(mode=mode))
                    with patch.object(composer.decoder, "transient_frame", side_effect=frames.__getitem__), \
                            patch.object(composer.decoder, "extract_images", return_value=[(375, action)]):
                        first, second, repeated = composer.write_storyboards([
                            {"panelTimesMs": [0, 500], "filename": f"{mode}-first.jpg"},
                            {"panelTimesMs": [0, 250, 500], "filename": f"{mode}-second.jpg"},
                            {"panelTimesMs": [0, 250, 500], "filename": f"{mode}-duplicate.jpg"},
                        ])

                    first_views = [view for part in first["parts"] for view in part["image"]["views"]]
                    self.assertEqual([view["mediaTimeMs"] for view in first_views], [0, 500])
                    if mode in ("balanced", "full"):
                        self.assertEqual(second["parts"], [])
                    else:
                        second_part, = second["parts"]
                        new_view, = second_part["image"]["views"]
                        self.assertEqual(new_view["mediaTimeMs"], 250)
                        self.assertEqual(new_view["box"][:2], [0, 0])
                        self.assertEqual(new_view["type"], "full")
                    self.assertEqual(repeated["parts"], [])
                    self.assertFalse((composer.output_dir / f"{mode}-duplicate.jpg").exists())

    def test_balanced_and_full_reuse_a_live_anchor_and_refresh_after_fifteen_seconds(self):
        scene = np.random.default_rng(18).integers(40, 140, (268, 476, 3), dtype=np.uint8)
        times = [1000, 3500, 16000, 16500, 17000]
        items = [{"panelTimesMs": [time], "filename": f"{time}.jpg"} for time in times]
        with tempfile.TemporaryDirectory() as temporary:
            for mode in ("balanced", "full"):
                with self.subTest(mode=mode):
                    writer = self.composer(Path(temporary) / mode, self.settings(mode=mode))
                    calls = []

                    def review(start, end):
                        calls.append((start, end))
                        self.assertTrue(not (writer.output_dir / "1000.jpg").exists() or start >= 16500)
                        return [(time, scene) for time in range(start + 125, end, 125)]

                    writer.transient_frame = lambda _: scene
                    writer.extract_images = review
                    results = writer.write_storyboards(items)
                    self.assertEqual([len(result["parts"]) for result in results], [1, 0, 0, 1, 0])
                    self.assertEqual(calls, [(1000, 3500), (1000, 16000), (16500, 17000)])
                    self.assertEqual(sorted(path.name for path in writer.output_dir.iterdir()), ["1000.jpg", "16500.jpg"])

    def test_balanced_cut_keeps_only_new_panorama_and_any_new_action_in_previous_shot(self):
        rng = np.random.default_rng(28)
        scene = rng.integers(20, 120, (268, 476, 3), dtype=np.uint8)
        new_shot = rng.integers(150, 255, scene.shape, dtype=np.uint8)
        action = scene.copy()
        action[122:146, 210:238] = 245
        with tempfile.TemporaryDirectory() as temporary:
            for lookback in (scene, action):
                with self.subTest(changed=lookback is action):
                    writer = self.composer(Path(temporary), self.settings(mode="balanced"))
                    writer.transient_frame = {1000: scene, 1500: lookback, 2000: new_shot}.__getitem__
                    writer.extract_images = lambda start, end: [(t, scene) for t in range(start + 125, end, 125)]
                    first, cut = writer.write_storyboards([
                        {"panelTimesMs": [1000], "filename": "a.jpg"},
                        {"panelTimesMs": [1500, 2000], "filename": "b.jpg"},
                    ])
                    views = [view for part in cut["parts"] for view in part["image"]["views"]]
                    expected = [(1500, "crop"), (2000, "full")] if lookback is action else [(2000, "full")]
                    self.assertEqual([(view["mediaTimeMs"], view["type"]) for view in views], expected)
                    if lookback is action:
                        self.assertEqual(views[0]["anchorTimeMs"], 1000)

    def test_balanced_lookback_keeps_new_local_action_before_the_last_displayed_frame(self):
        scene = np.random.default_rng(19).integers(20, 120, (268, 476, 3), dtype=np.uint8)
        later = scene.copy()
        earlier = scene.copy()
        later[122:146, 210:238] = 245
        earlier[122:146, 235:263] = 185
        next_shot = 255 - scene
        frames = {0: scene, 250: earlier, 500: later, 750: next_shot}
        with tempfile.TemporaryDirectory() as temporary:
            writer = self.composer(Path(temporary), self.settings(mode="balanced"))
            writer.transient_frame = frames.__getitem__
            writer.extract_images = lambda *_: None
            _, second = writer.write_storyboards([
                {"panelTimesMs": [0, 500], "filename": "first.jpg"},
                {"panelTimesMs": [250, 750], "filename": "cut.jpg"},
            ])
        views = [view for part in second["parts"] for view in part["image"]["views"]]
        self.assertEqual([(v["mediaTimeMs"], v["type"], v.get("anchorTimeMs")) for v in views],
                         [(250, "crop", 0), (750, "full", None)])

    def test_recent_scene_change_skips_static_preroll_in_balanced_and_full(self):
        rng = np.random.default_rng(84)
        previous = rng.integers(0, 120, (268, 476, 3), dtype=np.uint8)
        frames = {0: previous, 500: 255 - previous, 1000: previous, 3500: 255 - previous}
        items = [{"panelTimesMs": [0], "filename": "first.jpg"},
                 {"panelTimesMs": [500, 1000, 3500], "filename": "cut.jpg", "frameReason": "scene_change"}]
        with tempfile.TemporaryDirectory() as temporary:
            for mode in ("balanced", "economy", "full"):
                with self.subTest(mode=mode):
                    writer = self.composer(Path(temporary) / mode, self.settings(mode=mode))
                    writer.transient_frame = Mock(side_effect=frames.__getitem__)
                    writer.extract_images = lambda *_: None
                    planned = []
                    with patch.object(writer.decoder, "plan_frames", side_effect=planned.extend):
                        _, cut = writer.write_storyboards(items)
                    views = [view for part in cut["parts"] for view in part["image"]["views"]]
                    expected = [(500, 0), (1000, 1), (3500, 2)] if mode == "economy" else [(3500, 2)]
                    self.assertEqual([(v["mediaTimeMs"], v["sourceIndex"]) for v in views], expected)
                    self.assertTrue(all(v["type"] == "full" for v in views))
                    self.assertEqual([panel["mediaTimeMs"] for panel in cut["panels"]], items[1]["panelTimesMs"])
                    expected_times = [0, 500, 1000, 3500]
                    self.assertEqual(planned, expected_times)
                    self.assertEqual([call.args[0] for call in writer.transient_frame.call_args_list], expected_times)

    def test_balanced_recent_cut_keeps_the_insert_without_a_second_decode(self):
        rng = np.random.default_rng(85)
        scene = rng.integers(0, 120, (268, 476, 3), dtype=np.uint8)
        frames = {0: scene, 500: scene, 1000: 255 - scene, 2000: scene}
        items = [{"panelTimesMs": [0], "filename": "first.jpg"},
                 {"panelTimesMs": [500, 1000, 2000], "filename": "cut.jpg", "frameReason": "scene_change"}]
        with tempfile.TemporaryDirectory() as temporary:
            writer = self.composer(Path(temporary), self.settings(mode="balanced"))
            writer.transient_frame = frames.__getitem__
            writer.extract_images = Mock(side_effect=AssertionError("Recent cuts only use their candidate frames"))
            _, cut = writer.write_storyboards(items)
        writer.extract_images.assert_not_called()
        views = [view for part in cut["parts"] for view in part["image"]["views"]]
        self.assertEqual([(v["mediaTimeMs"], v["sourceIndex"], v["type"]) for v in views],
                         [(1000, 1, "full"), (2000, 2, "full")])

    def test_balanced_removed_panorama_leaves_marks_on_the_retained_anchor(self):
        rng = np.random.default_rng(86)
        previous = rng.integers(0, 120, (268, 476, 3), dtype=np.uint8)
        frames = {0: previous, 500: previous, 1000: 255 - previous}
        frames[1750] = frames[1000].copy()
        frames[1750][122:146, 210:238] = 245
        frames[2500] = frames[1750].copy()
        frames[2500][158:180, 232:256] = 245
        items = [{"panelTimesMs": [0], "filename": "first.jpg"},
                 {"panelTimesMs": [500, 1000, 1750], "filename": "motion.jpg", "frameReason": "motion_peak"},
                 {"panelTimesMs": [2500], "filename": "next.jpg", "frameReason": "motion_peak"}]
        with tempfile.TemporaryDirectory() as temporary:
            writer = self.composer(Path(temporary), self.settings(mode="balanced"))
            writer.transient_frame = frames.__getitem__
            writer.extract_images = lambda *_: None
            writer.face_detector = None
            _, motion, next_group = writer.write_storyboards(items)
            panorama, crop = motion["parts"]
            next_crop, = next_group["parts"]
            self.assertEqual([(v["type"], v["mediaTimeMs"]) for v in panorama["image"]["views"]], [("full", 1000)])
            original = read_image(writer.output_dir / panorama["filename"])
            for part, time, sign in ((crop, 1750, 1), (next_crop, 2500, -1)):
                view, = part["image"]["views"]
                self.assertEqual((view["type"], view["mediaTimeMs"], view["anchorTimeMs"]), ("crop", time, 1000))
                for pixels in (crop_region(original, view["sourceBox"]), read_image(writer.output_dir / part["filename"])):
                    difference = pixels[:, :, 2].astype(int) - pixels[:, :, 0].astype(int)
                    self.assertGreater(np.count_nonzero(difference * sign > 30), 10)

    def test_pending_panorama_is_backmarked_within_a_batch_and_rebuilt_in_the_next(self):
        scene = np.full((268, 476, 3), 38, np.uint8)
        cv2.putText(scene, "S", (200, 150), cv2.FONT_HERSHEY_SIMPLEX, 2, (90, 90, 90), 2)
        center = scene.copy()
        center[160:180, 225:245] = 230
        corner = center.copy()
        corner[20:40, 407:431] = 230
        frames = {0: scene, 500: center, 750: corner}
        first = {"panelTimesMs": [0, 500], "filename": "first.jpg"}
        later = {"panelTimesMs": [0, 750], "filename": "later.jpg"}

        with tempfile.TemporaryDirectory() as temporary:
            for mode in ("balanced", "full"):
                with self.subTest(mode=mode):
                    root = Path(temporary)

                    def composer(directory, previous_views=()):
                        writer = self.composer(root / mode / directory, self.settings(mode=mode), previous_views=previous_views)
                        writer.transient_frame = frames.__getitem__
                        writer.extract_images = lambda *_: None
                        writer.face_detector = SimpleNamespace(setInputSize=lambda _: None, detect=lambda _: (None, []))
                        return writer

                    control = composer("control")
                    inline, = control.write_storyboards([first])[0]["parts"]
                    self.assertEqual([view["type"] for view in inline["image"]["views"]], ["full", "crop"])
                    joint = composer("joint")
                    across_groups, across_groups_later = joint.write_storyboards([first, later])
                    staged = composer("staged")
                    first_block, = staged.write_storyboards([first])
                    self.assertFalse((staged.output_dir / "later.jpg").exists())
                    inline, = first_block["parts"]
                    anchor_before = (staged.output_dir / inline["filename"]).read_bytes()
                    previous = [view for part in first_block["parts"] for view in part["image"]["views"]]
                    self.assertEqual([view["mediaTimeMs"] for view in previous], [0, 500])
                    self.assertEqual([view["type"] for view in previous], ["full", "crop"])
                    resumed = composer("staged", previous)
                    second_block, = resumed.write_storyboards([later])
                    refreshed, = second_block["parts"]
                    new_view, = refreshed["image"]["views"]
                    self.assertEqual((new_view["type"], new_view["mediaTimeMs"]), ("full", 750))
                    self.assertEqual((staged.output_dir / inline["filename"]).read_bytes(), anchor_before)

                    anchor, early = across_groups["parts"]
                    late, = across_groups_later["parts"]
                    panorama = read_image(joint.output_dir / anchor["filename"])
                    for part, sign in ((early, 1), (late, -1)):
                        view, = part["image"]["views"]
                        self.assertEqual(view["anchorTimeMs"], 0)
                        self.assertEqual(view["box"][:2], [0, 0])
                        for pixels in (crop_region(panorama, view["sourceBox"]), read_image(joint.output_dir / part["filename"])):
                            color_difference = pixels[:, :, 2].astype(int) - pixels[:, :, 0]
                            self.assertGreater(np.count_nonzero(color_difference * sign > 30), 10)

    def test_overlapping_source_markers_preserve_both_pairs_and_hold_on_tiny_regions(self):
        source = np.full((40, 50, 3), 38, np.uint8)
        panorama = source.copy()
        occupied = np.zeros(source.shape[:2], bool)
        details = [source.copy(), source.copy()]
        for index, detail in enumerate(details):
            mark_crop_pair(source, detail, panorama, index, 268, occupied)
            colored_in_source = (panorama == COLORS[index]).all(axis=-1)
            colored_in_detail = (detail == COLORS[index]).all(axis=-1)
            np.testing.assert_array_equal(colored_in_source, colored_in_detail)
            self.assertGreater(colored_in_source.sum(), 20)
        self.assertGreater(np.count_nonzero((panorama == COLORS[0]).all(axis=-1)), 20)

        tiny = source[:3, :4].copy()
        anchor, detail = tiny.copy(), tiny.copy()
        mark_crop_pair(tiny, detail, anchor, 0, 268)
        np.testing.assert_array_equal(anchor, detail)
        self.assertEqual(tuple(anchor[0, -1]), COLORS[0])
        np.testing.assert_array_equal(anchor[1:], tiny[1:])

    def test_reviewed_economy_fits_original_candidates_directly_to_the_cell(self):
        scene = np.random.default_rng(17).integers(0, 256, size=(540, 960, 3), dtype=np.uint8)
        settings = self.settings(mode="economy")
        (strip, views), = economy_images([scene] * 3, [500] * 3, None, settings, cv2, np)
        expected = storyboard_canvas([scene], 124, cv2, np, width=221, gutter_width=1)
        np.testing.assert_array_equal(strip, expected)
        self.assertEqual([v["mediaTimeMs"] for v in views], [500])

    def test_balanced_persists_every_part_with_its_time_and_budget(self):
        with tempfile.TemporaryDirectory() as temporary:
            settings = self.settings(mode="balanced", storyboardMaxBytes=5000, minStoryboardJpegQuality=60)
            composer = self.composer(Path(temporary), settings)
            pixels = np.zeros((144, 256, 3), np.uint8)
            pictures = [StoryboardPicture(pixels, [{"type": "full", "mediaTimeMs": t, "box": [0, 0, 256, 144]}])
                        for t in (100, 225, 350)]
            with patch.object(composer.decoder, "extract_frame", return_value=pixels), \
                 patch("balanced_storyboard.balanced_pictures", return_value=pictures):
                parts = write_storyboard(composer, [0, 100, 350], "group.jpg")["parts"]
            self.assertEqual([part["mediaTimeMs"] for part in parts], [100, 225, 350])
            self.assertEqual(len(set(part["filename"] for part in parts)), 3)
            for part in parts:
                self.assertEqual((composer.output_dir / part["filename"]).stat().st_size, part["image"]["bytes"])
                self.assertLessEqual(part["image"]["bytes"], 5000)

    def test_balanced_and_full_share_the_crop_from_decoded_review_frames(self):
        scene = np.random.default_rng(2).integers(0, 110, (268, 476, 3), dtype=np.uint8)
        action = scene.copy()
        action[110:132, 190:240] = 245
        frames = [cv2.resize(frame, (951, 535)) for frame in (scene, action, scene)]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            video = root / "odd-size.mkv"
            subprocess.run(["ffmpeg", "-v", "error", "-f", "rawvideo", "-pix_fmt", "bgr24",
                            "-s", "951x535", "-framerate", "8", "-i", "pipe:0", "-c:v", "ffv1", str(video)],
                           input=b"".join(frame.tobytes() for frame in frames), check=True, capture_output=True)
            crops = {}
            for mode in ("balanced", "full"):
                composer = StoryboardComposer(video, root, self.settings(mode=mode), cv2, np)
                composer.face_detector = None
                parts = write_storyboard(composer, [0, 250], f"{mode}.jpg")["parts"]
                anchor, crop = [view for part in parts for view in part["image"]["views"]]
                self.assertEqual((anchor["type"], anchor["mediaTimeMs"]), ("full", 0))
                self.assertEqual((crop["type"], crop["mediaTimeMs"], crop["anchorTimeMs"]), ("crop", 125, 0))
                crops[mode] = crop
            self.assertEqual(crops["balanced"]["sourceBox"], crops["full"]["sourceBox"])
            self.assertLess(crops["balanced"]["box"][2], crops["full"]["box"][2])

    def test_full_part_budget_resizes_the_inset_coordinates_with_the_scene(self):
        canvas = np.random.default_rng(3).integers(0, 256, (1080, 1920, 3), dtype=np.uint8)
        settings = self.settings(mode="full", storyboardHeight=1080,
                                 storyboardMaxBytes=600_000, minStoryboardJpegQuality=75)
        views = [{"sourceIndex": 0, "mediaTimeMs": 0, "type": "full", "box": [0, 0, 1920, 1080]},
                 {"sourceIndex": 1, "mediaTimeMs": 500, "type": "crop", "box": [1500, 300, 300, 150],
                  "anchorTimeMs": 0, "sourceBox": [0.25, 0.4, 0.5, 0.6]}]
        encoded, image = encode_reviewed_part(canvas, views, settings, cv2, fallback_heights=FALLBACK_HEIGHTS)
        self.assertLessEqual(len(encoded), 600_000)
        self.assertTrue(image["budgetLimited"])
        self.assertEqual(image["views"][0]["box"], [0, 0, image["width"], image["height"]])
        self.assertLess(image["height"], 1080)
        self.assertEqual(image["views"][1]["box"],
                         [round(value * image["height"] / 1080) for value in views[1]["box"]])
        self.assertEqual(image["views"][1]["anchorTimeMs"], views[1]["anchorTimeMs"])
        self.assertEqual(image["views"][1]["sourceBox"], views[1]["sourceBox"])

if __name__ == "__main__":
    unittest.main()
