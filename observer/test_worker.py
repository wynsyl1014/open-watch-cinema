import subprocess
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

import cv2
import numpy as np

from worker import analyse_segment, decode_frames, select_storyboard_indices, write_storyboard


def metric(**changes):
    return dict(dict(sharpness=100, clippedFraction=0, brightness=0.5,
                     motionMeanPixels=0, sceneScore=0, motionScore=0, perceptualHash="ffffffffffffffff",
                     averageRgb=[0.5, 0.5, 0.5]), **changes)


class StoryboardTests(unittest.TestCase):
    def analyse_samples(self, samples, start_ms=0, visual_start_ms=None):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / "source.mp4"
            source.touch()
            with patch("worker.decode_frames", return_value=[None] * len(samples)), \
                 patch("worker.opencv_metrics", side_effect=[(item, {}) for item in samples]), \
                 patch("worker.write_storyboard"):
                return analyse_segment(source, start_ms, len(samples) * 500, 2, root, "test", visual_start_ms)

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
        result = self.analyse_samples([metric() for _ in range(34)], start_ms=296000, visual_start_ms=298000)
        times = [frame["mediaTimeMs"] for frame in result["frames"]]
        self.assertEqual(times, [298000, 310000])
        self.assertTrue(all(time >= 298000 for time in times))

    def test_extra_visual_heartbeat_does_not_throttle_motion_detection(self):
        samples = [metric() for _ in range(30)]
        samples[25] = metric(motionScore=0.3)
        result = self.analyse_samples(samples)
        self.assertIn((12500, "motion_peak"),
                      [(frame["mediaTimeMs"], frame["frameReason"]) for frame in result["frames"]])

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

    def test_short_and_sparse_segments_stay_in_bounds(self):
        self.assertEqual(select_storyboard_indices([metric()], 0, 2000, "scene_change"), [0, 0, 0])
        self.assertEqual(select_storyboard_indices([metric(), metric()], 1, 2000, "scene_change"), [0, 1, 1])

    def test_source_detail_is_not_enlarged_analysis(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            stripes = np.tile(((np.arange(512) // 2) % 2 * 255).astype(np.uint8), (288, 1))
            original = np.repeat(stripes[:, :, None], 3, axis=2)
            cv2.imwrite(str(root / "source.png"), original)
            subprocess.run(["ffmpeg", "-v", "error", "-loop", "1", "-i", str(root / "source.png"),
                            "-t", "1", "-c:v", "ffv1", str(root / "source.mkv")], check=True,
                           capture_output=True)
            frames = decode_frames(root / "source.mkv", 0, 1000, 2)
            self.assertEqual((frames[0].width, frames[0].height), (192, 108))
            write_storyboard(root / "source.mkv", [0, 0, 500], root, "strip.jpg", cv2, np)
            strip = cv2.imread(str(root / "strip.jpg"))
            self.assertEqual(strip.shape, (288, 1544, 3))
            enlarged = cv2.resize(np.frombuffer(frames[0].pixels, np.uint8).reshape(108, 192, 3), (512, 288))
            source_error = np.abs(strip[:, :512].astype(float) - original).mean()
            enlarged_error = np.abs(enlarged.astype(float) - original).mean()
            self.assertLess(source_error, enlarged_error / 4)


if __name__ == "__main__":
    unittest.main()
