from fractions import Fraction
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "observer"))
from video_decode import DecodeBackend, SourceVideoDecoder


class DecodeTests(unittest.TestCase):
    def test_hardware_failure_sticks_only_for_this_mac_worker(self):
        with patch("video_decode.sys.platform", "darwin"):
            backend = DecodeBackend.for_storyboards()
        ok = subprocess.CompletedProcess([], 0, b"pixels", b"")
        unavailable = subprocess.CompletedProcess([], 187, b"", b"No device")
        with patch("video_decode.subprocess.run", side_effect=[unavailable, ok, ok]) as run:
            backend.run(["-i", "film"])
            backend.run(["-i", "film"])
        commands = [args.args[0] for args in run.call_args_list]
        self.assertIn("videotoolbox", commands[0])
        self.assertTrue(all("-hwaccel" not in command for command in commands[1:]))
        with patch("video_decode.sys.platform", "win32"):
            self.assertFalse(DecodeBackend.for_storyboards().videotoolbox)
        self.assertFalse(DecodeBackend().videotoolbox)

    def test_interruption_and_timeout_never_retry(self):
        for code in (-15, 130, 255):
            with patch("video_decode.subprocess.run", return_value=subprocess.CompletedProcess(
                    [], code, b"", b"interrupted")) as run:
                with self.assertRaises(RuntimeError):
                    DecodeBackend(True).run([])
                run.assert_called_once()
        with patch("video_decode.subprocess.run", side_effect=subprocess.TimeoutExpired([], 30)) as run:
            with self.assertRaises(subprocess.TimeoutExpired):
                DecodeBackend(True).run([])
            run.assert_called_once()

    def test_vfr_batch_matches_individual_seeks_even_with_coincident_frames_and_eof(self):
        with tempfile.TemporaryDirectory() as root:
            video = Path(root) / "vfr.mkv"
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i",
                            "testsrc2=size=96x64:rate=24:duration=2",
                            "-vf", "select='not(mod(n,3))+eq(n,10)'",
                            "-fps_mode", "vfr", "-c:v", "ffv1", str(video)], check=True)
            decoder = SourceVideoDecoder(video, cv2, np)
            times = [125, 126, 127, 375, 416, 417, 418, 500, 1571, 1970, 2050]
            decoder.plan_frames(reversed(times))
            with patch.object(decoder, "extract_frame", wraps=decoder.extract_frame) as single:
                actual = {time: decoder.transient_frame(time) for time in reversed(times[:-2])}
                single.assert_not_called()
                with self.assertRaisesRegex(RuntimeError, "No source frame"):
                    decoder.transient_frame(2050)
                single.assert_called_once_with(2050)
            for time, pixels in actual.items():
                np.testing.assert_array_equal(pixels, decoder.extract_frame(time), err_msg=f"{time} ms")
            self.assertLessEqual(len(decoder.recent_pixels), 6)

    def test_transport_stream_disguised_as_mp4_preserves_per_seek_gop(self):
        with tempfile.TemporaryDirectory() as root:
            video = Path(root) / "transport.mp4"
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i",
                            "testsrc2=size=96x64:rate=24:duration=2",
                            "-c:v", "mpeg2video", "-g", "12", "-f", "mpegts", str(video)], check=True)
            decoder = SourceVideoDecoder(video, cv2, np)
            decoder.plan_frames([0, 125, 500])
            self.assertFalse(decoder.batch_groups)

    def test_sparse_frames_and_group_limits(self):
        decoder = object.__new__(SourceVideoDecoder)
        decoder.time_base = Fraction(1, 1000)
        decoder.batch_supported = True
        decoder.batch_groups, decoder.batch_pixels = {}, {}
        decoder.plan_frames([*range(20), 8000, 16001])
        self.assertEqual(len(decoder.batch_groups[0]), 16)
        self.assertEqual(decoder.batch_groups[16], [16, 17, 18, 19, 8000])
        self.assertNotIn(16001, decoder.batch_groups)
