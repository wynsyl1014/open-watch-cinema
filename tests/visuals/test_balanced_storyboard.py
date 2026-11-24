import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "observer"))
from balanced_storyboard import balanced_parts, balanced_pictures
from full_storyboard import full_pictures
from storyboard_selection import PreparedScene, select_scene_views


def balanced_images(frames, times_ms, *args, **kwargs):
    frame_at = dict(zip(times_ms, frames)).__getitem__
    return balanced_parts(balanced_pictures(frame_at, times_ms, *args, **kwargs))


def full_images(*args, **kwargs):
    return [part for picture in full_pictures(*args, **kwargs) for part in picture.rendered(cv2)]


class Detector:
    def __init__(self, block_anchor=False):
        self.block_anchor = block_anchor

    def setInputSize(self, size):
        self.width, self.height = size

    def detect(self, image):
        faces = [[0, 0, self.width, self.height]] if self.block_anchor else []
        return None, np.asarray(faces, dtype=np.float32)


class BalancedStoryboardTests(unittest.TestCase):
    def setUp(self):
        self.scene = np.full((268, 476, 3), 38, np.uint8)
        cv2.putText(self.scene, 'S', (200, 150), cv2.FONT_HERSHEY_SIMPLEX, 2, (90, 90, 90), 2)
        self.action = self.scene.copy()
        self.action[160:180, 225:245] = 230

    def test_blank_and_very_dark_title(self):
        black = np.zeros_like(self.scene)
        title = black.copy()
        title[80:84, 10:45, 0] = 2
        self.assertEqual(balanced_images([black], [0]), [])
        outputs = balanced_images([black, title, black, title], [0, 125, 250, 375])
        self.assertEqual([v["mediaTimeMs"] for _, views in outputs for v in views], [125,375])

    def test_faint_textured_fade_retains_first_credit(self):
        rng = np.random.default_rng(17)
        texture = cv2.GaussianBlur(rng.normal(0, 1, (268,476)).astype(np.float32),
                                   (0, 0), 5)
        field = cv2.normalize(texture, None, 22, 45, cv2.NORM_MINMAX).astype(np.uint8)
        field = cv2.cvtColor(field, cv2.COLOR_GRAY2BGR)
        title = field.copy()
        cv2.putText(title, 'A', (225,90), cv2.FONT_HERSHEY_SIMPLEX, .7, (70,70,70), 1)
        result = balanced_images([field, title], [500, 1000])
        self.assertEqual([v['mediaTimeMs'] for _,vs in result for v in vs], [1000])

    def test_safe_inset_and_native_crop(self):
        outputs = balanced_images([self.scene, self.action], [1000, 1500], face_detector=Detector())
        self.assertEqual(len(outputs), 1)
        image, (scene, crop) = outputs[0]
        self.assertEqual(image.shape, self.scene.shape)
        self.assertEqual(scene["type"], "full")
        x,y,w,h = crop["box"]
        self.assertEqual(crop["mediaTimeMs"], 1500)
        self.assertEqual(crop["anchorTimeMs"], scene["mediaTimeMs"])
        inset = image[y:y+h, x:x+w]
        self.assertEqual(cv2.boundingRect(np.uint8(inset[:, :, 0] > 180))[2:], (20, 20))
        np.testing.assert_array_equal(inset, self.source_crop(self.action, crop))

    def test_occupied_anchor_delivers_separate_crop(self):
        outputs = balanced_images([self.scene, self.action], [1000, 1500], face_detector=Detector(True))
        self.assertEqual(len(outputs), 2)
        piece, (view,) = outputs[1]
        h,w = piece.shape[:2]
        self.assertEqual(view["box"], [0,0,w,h])
        self.assertEqual(view["anchorTimeMs"], outputs[0][1][0]["mediaTimeMs"])
        self.assertLess(w*h, 476*268)
        np.testing.assert_array_equal(piece, self.source_crop(self.action, view))

    def test_midpoint_inset_can_cover_texture_but_avoids_protected_corners(self):
        class CornerFaces(Detector):
            def detect(self, image):
                return None, np.asarray([(x * self.width, y * self.height, .19 * self.width, .22 * self.height)
                                         for x in (0, .81) for y in (0, .78)]
                                        + [(0, .39 * self.height, .19 * self.width, .22 * self.height),
                                           (.81 * self.width, .39 * self.height, .19 * self.width, .22 * self.height),
                                           (.39 * self.width, .78 * self.height, .22 * self.width, .22 * self.height)],
                                        dtype=np.float32)

        scene = self.scene.copy()
        for y in (15, 31):
            cv2.line(scene, (180, y), (294, y), (116, 116, 116), 1)
        action = scene.copy()
        action[160:180, 225:245] = 230
        ((image, (_, crop)),) = balanced_images([scene, action], [0, 500], face_detector=CornerFaces())
        x, y, w, h = crop['box']
        self.assertEqual((x, y), ((476 - w) // 2, 4))
        self.assertGreater(np.count_nonzero(cv2.Canny(scene, 28, 65)[y:y+h, x:x+w]) / (w*h), .045)
        np.testing.assert_array_equal(image[y:y+h, x:x+w], self.source_crop(action, crop))

    def test_separate_crops_share_one_strip_with_original_pixel_geometry(self):
        second = self.action.copy()
        second[79:137, 315:345] = 210
        ((_, (anchor,)), (strip, (first, last))) = balanced_images(
            [self.scene, self.action, second], [0, 500, 1000], face_detector=Detector(True))
        self.assertEqual([view['mediaTimeMs'] for view in (anchor, first, last)], [0, 500, 1000])
        self.assertEqual([view['anchorTimeMs'] for view in (first, last)], [0, 0])
        self.assertEqual(last['box'][0], first['box'][2] + 1)
        self.assertEqual(strip.shape[:2], (last['box'][3], last['box'][0] + last['box'][2]))
        self.assertGreater(first['box'][1], 0)
        np.testing.assert_array_equal(strip[:, first['box'][2]], np.tile((175, 191, 205), (strip.shape[0], 1)))
        for source, view in ((self.action, first), (second, last)):
            x, y, w, h = view['box']
            np.testing.assert_array_equal(strip[y:y+h, x:x+w], self.source_crop(source, view))

    def test_smooth_pan_keeps_endpoints_and_skips_already_shown_start(self):
        rng = np.random.default_rng(71)
        backdrop = cv2.GaussianBlur(rng.integers(0, 255, (268, 650, 3), dtype=np.uint8), (5, 5), 0)

        def frame(time):
            offset = round(time * .16)
            return backdrop[:, offset:offset + 476].copy()

        def review(start, end):
            return [(time, frame(time)) for time in range(start + 125, end, 125)]

        times = [0, 500, 1000]
        frames = list(map(frame, times))
        ((strip, views),) = balanced_images(frames, times, review)
        self.assertEqual([view['mediaTimeMs'] for view in views], [0, 1000])
        np.testing.assert_array_equal(strip, np.hstack((frames[0], frames[-1])))

        scene = PreparedScene()
        balanced_images(frames[:1], times[:1], review, scene=scene)
        ((strip, (view,)),) = balanced_images(frames, times, review, scene=scene)
        self.assertEqual(view['mediaTimeMs'], 1000)
        np.testing.assert_array_equal(strip, frames[-1])

        def action_review(start, end):
            samples = review(start, end)
            for time, image in samples:
                if time == 250:
                    image[100:130, 200:240] = 255
            return samples

        views = [view for _, views in balanced_images(frames, times, action_review) for view in views]
        self.assertIn(250, [view['mediaTimeMs'] for view in views])
        self.assertIn(500, [view['mediaTimeMs'] for view in views])

    def test_dense_review_recovers_blink_between_identical_endpoints(self):
        rng = np.random.default_rng(2)
        scene = rng.integers(0, 110, size=self.scene.shape, dtype=np.uint8)
        blink = scene.copy()
        blink[110:132, 190:240] = 240
        review = lambda start, end: [(0, scene), (125, blink), (250, scene)]
        outputs = balanced_images([scene,scene], [0,250], review=review)
        views = [v for _,vs in outputs for v in vs]
        self.assertEqual([(v["mediaTimeMs"], v["type"]) for v in views], [(0,"full"),(125,"crop")])
        self.assertEqual(views[1]["anchorTimeMs"], 0)
        np.testing.assert_array_equal(outputs[1][0], self.source_crop(blink, views[1]))

    def test_scene_change_after_three_and_a_half_seconds_keeps_context(self):
        background = 255 - self.scene
        for end, expected in ((3500, [3500]), (3501, [2500, 3501])):
            with self.subTest(end=end):
                scene = PreparedScene()
                balanced_images([self.scene], [0], scene=scene)
                outputs = balanced_images([self.scene, background], [2500, end],
                                          scene=scene, frame_reason='scene_change')
                self.assertEqual([v['mediaTimeMs'] for _, views in outputs for v in views], expected)
                self.assertEqual(scene.anchor[0], end)
                self.assertEqual(scene.latest[0], end)

    def test_short_groups_keep_endpoints_after_gap_and_only_latest_panorama_in_sequence(self):
        white = 255 - self.scene
        green = self.scene.copy()
        green[:, :, 1] = 220
        scene = PreparedScene()
        balanced_images([white], [0], scene=scene)

        outputs = balanced_images([self.scene, self.scene, green], [3500, 4000, 4500], scene=scene)
        self.assertEqual([(v['mediaTimeMs'], v['type']) for _, views in outputs for v in views],
                         [(3500, 'full'), (4500, 'full')])

        outputs = balanced_images([green, self.scene, self.action], [5000, 5750, 7000],
                                  face_detector=Detector(), scene=scene, frame_reason='motion_peak')
        ((image, (panorama, crop)),) = outputs
        self.assertEqual(image.shape, self.scene.shape)
        self.assertEqual((panorama['mediaTimeMs'], crop['mediaTimeMs'], crop['anchorTimeMs']), (5750, 7000, 5750))
        self.assertEqual(scene.anchor[0], 5750)
        self.assertEqual(scene.latest[0], 7000)

    def test_recent_cut_passes_the_insert_and_final_frame_to_selection(self):
        scene = PreparedScene()
        balanced_images([self.scene], [0], scene=scene)
        insert = 255 - self.scene
        frame_at = Mock(side_effect={500: self.scene, 1000: insert, 2000: self.scene}.__getitem__)
        review = Mock()
        with patch('balanced_storyboard.select_scene_views', wraps=select_scene_views) as select:
            pictures = balanced_pictures(frame_at, [500, 1000, 2000], review,
                                          scene=scene, frame_reason='scene_change')
        self.assertEqual([call.args[0] for call in frame_at.call_args_list], [500, 1000, 2000])
        review.assert_not_called()
        frames, times, _ = select.call_args.args
        self.assertEqual(len(frames), 2)
        self.assertEqual(times, [1000, 2000])
        (_, views), = balanced_parts(pictures)
        self.assertEqual([(v['mediaTimeMs'], v['sourceIndex'], v['type']) for v in views],
                         [(1000, 1, 'full'), (2000, 2, 'full')])
        self.assertEqual(scene.latest[0], 2000)

    def test_short_group_keeps_a_distinct_middle_panorama(self):
        insert = 255 - self.scene
        for previous_time in (None, 0):
            with self.subTest(previous_time=previous_time):
                scene = PreparedScene()
                if previous_time is not None:
                    balanced_images([self.scene], [previous_time], scene=scene)
                outputs = balanced_images([self.scene, insert, self.scene], [500, 1000, 2000], scene=scene)
                expected = [500, 1000, 2000] if previous_time is None else [1000, 2000]
                self.assertEqual([v['mediaTimeMs'] for _, views in outputs for v in views], expected)

    def test_long_group_keeps_three_panoramas(self):
        white = 255 - self.scene
        green = self.scene.copy()
        green[:, :, 1] = 220
        outputs = balanced_images([self.scene, white, green], [1000, 2000, 3501])
        self.assertEqual([v['mediaTimeMs'] for _, views in outputs for v in views], [1000, 2000, 3501])

    def test_distant_actions_keep_their_full_frame(self):
        rng = np.random.default_rng(3)
        scene = rng.integers(35, 90, size=self.scene.shape, dtype=np.uint8)
        action = scene.copy()
        action[63:87, 56:80] = 245
        action[165:189, 399:423] = 88

        def review_between(start, end):
            return [(125, action)]

        def unexpected_review(start, end):
            self.fail("A selected frame with distant actions should be retained directly")

        for endpoint, review, action_time in ((action, unexpected_review, 250),
                                              (scene, review_between, 125)):
            frames = [scene, endpoint]
            profiles = (
                ("balanced", lambda: balanced_images(frames, [0, 250], review, Detector())),
                ("full", lambda: full_images(frames, [0, 250], review, Detector(), 480)),
            )
            for profile, compose in profiles:
                with self.subTest(profile=profile, action_time=action_time):
                    outputs = compose()
                    views = [(image, view) for image, views in outputs for view in views]
                    self.assertEqual([(v["mediaTimeMs"], v["type"]) for _, v in views],
                                     [(0, "full"), (action_time, "full")])
                    image, view = views[-1]
                    x, y, w, h = view["box"]
                    np.testing.assert_array_equal(image[y:y+h, x:x+w], action)

    def test_review_discontinuity_or_io_failure_keeps_full_endpoint(self):
        def failed(start, end):
            raise RuntimeError("decoder unavailable")
        for review in (failed, lambda start,end: []):
            result = balanced_images([self.scene,self.scene], [0,500], review=review)
            views = [v for _,vs in result for v in vs]
            self.assertEqual([(v["mediaTimeMs"], v["type"]) for v in views], [(0,"full"),(500,"full")])

    def test_verified_static_duplicate_and_overlapping_timestamps(self):
        review = lambda start,end: [(125,self.scene), (250,self.scene)]
        result = balanced_images([self.scene]*3, [0,250,250], review=review)
        self.assertEqual(len(result), 1)
        self.assertEqual(len(result[0][1]), 1)

    def test_full_recovers_a_native_stroke_between_identical_previews(self):
        rng = np.random.default_rng(13)
        texture = rng.integers(30, 120, (268, 476, 3), dtype=np.uint8)
        source = cv2.resize(texture, (1920, 1080))
        changed = source.copy()
        changed[500:504, 905:909] = 235
        def review(start, end):
            return [(125, changed)]
        pictures = full_images([source, source], [0, 250], review, None, 480)
        self.assertEqual([(v["mediaTimeMs"], v["type"]) for _,vs in pictures for v in vs],
                         [(0, "full"), (125, "crop")])
        self.assertEqual(pictures[0][0].shape[:2], (480, 853))
        self.assertGreater(pictures[1][0].max(), 190)

    def test_full_reviews_native_detail_against_the_previous_group(self):
        source = cv2.resize(self.scene, (1920, 1080))
        stroke = source.copy()
        stroke[500:504, 905:909] = 235
        scene = PreparedScene()
        full_images([source], [0], None, None, 480, scene=scene)

        def review(start, end):
            self.assertEqual((start, end), (0, 250))
            return [(125, stroke)]

        pictures = full_images([source], [250], review, None, 480, scene=scene)
        (pixels, (view,)), = pictures
        self.assertEqual((view["type"], view["mediaTimeMs"], view["anchorTimeMs"]), ("crop", 125, 0))
        self.assertGreater(pixels.max(), 190)

    def test_full_keeps_pan_endpoints_and_retains_action_during_a_pan(self):
        rng = np.random.default_rng(71)
        backdrop = cv2.GaussianBlur(rng.integers(0, 255, (268, 650, 3), dtype=np.uint8), (5, 5), 0)

        def frame(time):
            offset = round(time * .16)
            return backdrop[:, offset:offset + 476].copy()

        def review(start, end):
            return [(time, frame(time)) for time in range(start + 125, end, 125)]

        def full_times(pictures):
            return [view["mediaTimeMs"] for _, (view,) in pictures if view["type"] == "full"]

        times = [0, 500, 1000]
        frames = list(map(frame, times))
        self.assertEqual(full_times(full_images(frames, times, review, None, 480)), [0, 1000])
        scene = PreparedScene()
        full_images(frames[:1], times[:1], review, None, 480, scene=scene)
        self.assertEqual(full_times(full_images(frames[1:], times[1:], review, None, 480, scene=scene)), [1000])

        def action_review(start, end):
            samples = review(start, end)
            for time, image in samples:
                if time == 250:
                    image[100:130, 200:240] = 255
            return samples

        self.assertEqual(full_times(full_images(frames, times, action_review, None, 480)),
                         [0, 250, 500, 1000])

    def test_full_recent_cut_keeps_insert_local_action_and_native_detail(self):
        rng = np.random.default_rng(27)
        previous = cv2.resize(rng.integers(20, 100, (268, 476, 3), dtype=np.uint8), (1920, 1080))
        tail = 255 - previous
        insert = np.roll(previous, 600, axis=1)
        insert[:, :, 2] = 245
        stroke = tail.copy()
        stroke[500:504, 905:909] = 10
        action = previous.copy()
        action[470:570, 850:960] = 240

        for label, candidate, expected in (
            ("same-as-previous", previous, [(1500, "full")]),
            ("same-as-tail", tail, [(1500, "full")]),
            ("insert", insert, [(1000, "full"), (1500, "full")]),
            ("native-stroke", stroke, [(1000, "full"), (1500, "crop")]),
            ("local-action", action, [(1000, "crop"), (1500, "full")]),
        ):
            with self.subTest(label=label):
                scene = PreparedScene()
                full_images([previous], [0], None, None, 480, scene=scene)
                pictures = full_images([previous, candidate, tail], [500, 1000, 1500], None, None, 480,
                                       scene=scene, frame_reason="scene_change")
                self.assertEqual([(v["mediaTimeMs"], v["type"]) for _, views in pictures for v in views], expected)

    def test_full_recent_cut_still_reviews_motion_between_static_preroll_frames(self):
        previous = self.scene
        tail = 255 - previous

        def review(start, end):
            self.assertEqual((start, end), (0, 500))
            return [(125, previous), (250, self.action), (375, previous)]

        scene = PreparedScene()
        full_images([previous], [0], None, None, 480, scene=scene)
        pictures = full_images([previous, tail], [500, 1000], review, None, 480, scene=scene,
                               frame_reason="scene_change")
        self.assertEqual([v["mediaTimeMs"] for _, views in pictures for v in views], [250, 1000])

    def test_full_magnifies_in_an_empty_corner_or_sends_the_same_source_crop(self):
        source, action = [cv2.resize(im, (1919, 1079)) for im in [self.scene, self.action]]
        inline = full_images([source, action], [2000, 2500], None, Detector(), 1080)
        separate = full_images([source, action], [2000, 2500], None, Detector(True), 1080)
        balanced = balanced_images([source, action], [2000, 2500], face_detector=Detector(True))
        self.assertEqual(len(inline), 1)
        self.assertEqual(len(separate), 2)
        canvas, (anchor, inset_view) = inline[0]
        x, y, w, h = inset_view["box"]
        piece, (separate_view,) = separate[1]
        inset = canvas[y:y+h, x:x+w]
        self.assertLessEqual(abs(piece.shape[0] - h), 1)
        self.assertLessEqual(abs(piece.shape[1] - w), 1)
        _,_,sw,sh = cv2.boundingRect(np.uint8(inset[:, :, 0] > 180))
        self.assertGreater(min(sw, sh), 110)
        self.assertEqual(inset_view["mediaTimeMs"], 2500)
        self.assertEqual(inset_view["sourceBox"], separate_view["sourceBox"])
        balanced_piece, (balanced_view,) = balanced[1]
        self.assertEqual(inset_view["sourceBox"], balanced_view["sourceBox"])
        for pixels, view, interpolation in ((inset, inset_view, cv2.INTER_CUBIC),
                                            (piece, separate_view, cv2.INTER_CUBIC),
                                            (balanced_piece, balanced_view, cv2.INTER_AREA)):
            self.assertEqual(view["anchorTimeMs"], anchor["mediaTimeMs"])
            crop = self.source_crop(action, view)
            height, width = pixels.shape[:2]
            expected = cv2.resize(crop, (width, height), interpolation=interpolation)
            np.testing.assert_array_equal(pixels, expected)

    def source_crop(self, frame, view):
        height, width = frame.shape[:2]
        left, top, right, bottom = view["sourceBox"]
        self.assertTrue(0 <= left < right <= 1 and 0 <= top < bottom <= 1)
        l, t, r, b = (round(left * width), round(top * height),
                      round(right * width), round(bottom * height))
        return frame[t:b, l:r]


if __name__ == "__main__":
    unittest.main()
