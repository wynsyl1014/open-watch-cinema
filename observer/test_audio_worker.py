import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from audio_worker import Describer, SAMPLE_RATE


class AudioWorkerTests(unittest.TestCase):
    def test_decodes_and_describes_only_retained_spans(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / "film.wav"
            subprocess.run([
                "ffmpeg", "-v", "error", "-f", "lavfi",
                "-i", f"sine=frequency=440:sample_rate={SAMPLE_RATE}:duration=4", str(source),
            ], check=True, capture_output=True)
            config = {"modelId": "test-model", "revision": "test", "segmentMs": 2000}
            worker = Describer()
            request = {"inputPath": str(source), "fromMs": 0, "toMs": 4000, "ranges": [
                {"fromMs": 300, "toMs": 700}, {"fromMs": 2500, "toMs": 3250},
            ]}
            with (
                patch("audio_worker.configuration", return_value=config),
                patch("audio_worker.emit"),
                patch("audio_worker.subprocess.run", wraps=subprocess.run) as run,
                patch.object(worker, "describe", return_value="A steady tone.") as describe,
            ):
                result = worker.chunk(request)
            decodes = [call.args[0] for call in run.call_args_list if call.args[0][0] == "ffmpeg"]
            self.assertEqual([(command[command.index("-ss") + 1], command[command.index("-t") + 1])
                              for command in decodes], [("0.300", "0.400"), ("2.500", "0.750")])
            self.assertEqual([len(call.args[0]) for call in describe.call_args_list], [12800, 24000])
            self.assertEqual([(item["fromMs"], item["toMs"]) for item in result["descriptions"]],
                             [(300, 700), (2500, 3250)])
