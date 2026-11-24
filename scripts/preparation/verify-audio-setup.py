"""Offline installation health check; uses synthetic audio, never a user's movie."""
import argparse
import contextlib
import importlib.util
import os
from pathlib import Path
import shutil
import sys

parser = argparse.ArgumentParser()
parser.add_argument('--data-root', required=True)
args = parser.parse_args()
os.environ['LOCAL_DATA_ROOT'] = str(Path(args.data_root).resolve())
os.environ['OWC_AUDIO_DEVICE'] = 'cpu'
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
for tool in ('ffmpeg', 'ffprobe'):
    if not shutil.which(tool):
        raise RuntimeError(f'{tool} is missing from PATH.')
worker_path = Path(__file__).resolve().parents[2] / 'observer/audio_worker.py'
spec = importlib.util.spec_from_file_location('cinema_audio_worker', worker_path)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
print('Offline health: importing audio dependencies and language resources...', flush=True)
with contextlib.redirect_stdout(sys.stderr):
    import numpy as np
    import torchaudio
    import en_core_web_sm
    en_core_web_sm.load()
    model = worker.Describer()
    print('Offline health: loading CoNeTTE on CPU...', file=sys.stderr, flush=True)
    model.load()
    # Direct describe() exercises inference even on silent synthetic input.
    print('Offline health: running synthetic 10-second audio inference...', file=sys.stderr, flush=True)
    caption = model.describe(np.zeros(worker.SAMPLE_RATE * 10, dtype=np.float32))
if not isinstance(caption, str) or not caption.strip():
    raise RuntimeError('Audio model did not produce a caption.')
print('Offline health passed: dependencies, language resource, model load and synthetic 10-second inference.')
