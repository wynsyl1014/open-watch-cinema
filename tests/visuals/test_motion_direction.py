import math
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "observer"))
from storyboard_images import PpmFrame
from worker import opencv_metrics


class MotionDirectionTests(unittest.TestCase):
    def setUp(self):
        self.frame = PpmFrame(32, 32, bytes(32 * 32 * 3))
        self.first_metrics, self.previous = opencv_metrics(self.frame, None, cv2, np)
        self.flow = np.zeros((32, 32, 2), dtype=np.float32)

    def measure(self):
        with patch.object(cv2, "calcOpticalFlowFarneback", return_value=self.flow):
            metrics, _ = opencv_metrics(self.frame, self.previous, cv2, np)
        return metrics

    def test_first_frame_has_no_direction(self):
        self.assertEqual(self.first_metrics["motionDirection"], "still")

    def test_weak_flow_and_the_existing_frame_wide_floor(self):
        self.flow[:, :, 0] = 0.2
        metrics = self.measure()
        self.assertEqual(metrics["motionMeanPixels"], 0.2)
        self.assertEqual(metrics["motionDirection"], "still")
        self.flow[:, :, 0] = 0
        self.flow[0, :32, 0] = 4
        metrics = self.measure()
        self.assertLess(metrics["motionMeanPixels"], 0.15)
        self.assertEqual(metrics["motionDirection"], "still")
        self.flow[1, :8, 0] = 4
        metrics = self.measure()
        self.assertGreater(metrics["motionMeanPixels"], 0.15)
        self.assertEqual(metrics["motionDirection"], "right")

    def test_opposing_motion_preserves_strength_without_inventing_a_direction(self):
        self.flow[:, :16, 0] = 4
        for opposing in (-4, -3.99999, -3):
            with self.subTest(opposing=opposing):
                self.flow[:, 16:, 0] = opposing
                metrics = self.measure()
                self.assertEqual(metrics["motionDirection"], "still")
                self.assertEqual(metrics["motionMeanPixels"], round((4 - opposing) / 2, 4))
                self.assertEqual(metrics["motionCoverage"], 1)
                self.assertEqual(metrics["motionScore"], 1)

    def test_coherent_flow_preserves_all_eight_directions(self):
        labels = ("right", "down-right", "down", "down-left", "left", "up-left", "up", "up-right")
        for index, label in enumerate(labels):
            with self.subTest(label=label):
                angle = index * math.pi / 4
                self.flow[:] = (math.cos(angle), math.sin(angle))
                self.assertEqual(self.measure()["motionDirection"], label)

    def test_clear_majority_can_give_a_direction_despite_some_opposing_flow(self):
        self.flow[:, :28, 0] = -1
        self.flow[:, 28:, 0] = 1
        self.assertEqual(self.measure()["motionDirection"], "left")

    def test_coherent_mixed_flow_preserves_the_speed_weighted_angle(self):
        self.flow[:, :16, 0] = 2
        self.flow[:, 16:, 1] = 1
        self.assertEqual(self.measure()["motionDirection"], "right")
