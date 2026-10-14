#!/usr/bin/env python3
"""Offline audio descriptions. One resident model, bounded clips, JSON-lines protocol."""
from __future__ import annotations

import contextlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'

SAMPLE_RATE = 32_000
PROTOCOL_STREAM = sys.stdout
PROMPT_VERSION = 2  # CoNeTTE Clotho caption style; invalidates earlier Qwen checkpoints.


def emit(value):
    print(json.dumps(value, ensure_ascii=True), file=PROTOCOL_STREAM, flush=True)


def configuration():
    root = Path(os.environ.get('LOCAL_DATA_ROOT') or Path(__file__).resolve().parents[1] / 'local-data')
    config = json.loads((root / 'audio-model.json').read_text(encoding='utf-8-sig'))
    if config.get('modelId') != 'Labbeti/conette':
        raise ValueError('Audio now uses CoNeTTE. Run audio setup to update the model.')
    if not Path(config['modelPath']).is_dir():
        raise ValueError('Local audio model files are missing. Run audio setup again.')
    if not (Path(config.get('resourcesPath', '')) / 'class_labels_indices.csv').is_file():
        raise ValueError('CoNeTTE audio resources are missing. Run audio setup again.')
    config['device'] = os.environ.get('OWC_AUDIO_DEVICE', config.get('device', 'cpu'))
    segment_ms = config.get('segmentMs', 10_000)
    if not isinstance(segment_ms, int) or not 2_000 <= segment_ms <= 20_000:
        raise ValueError('Audio segmentMs must be between 2000 and 20000.')
    return config


def availability():
    try:
        config = configuration()
        for module in ('torch', 'transformers', 'numpy', 'librosa', 'conette', 'en_core_web_sm'):
            if importlib.util.find_spec(module) is None:
                raise ValueError(f'Audio dependency {module} is missing.')
        return {
            'ok': True, 'status': 'available', 'model': config['modelId'],
            'revision': config['revision'], 'segmentMs': config.get('segmentMs', 10_000),
            'promptVersion': PROMPT_VERSION, 'device': config['device'],
        }
    except Exception as error:
        return {'ok': True, 'status': 'unavailable', 'note': f'Run audio setup first. {error}'}


class Describer:
    def __init__(self):
        self.model = None
        self.config = None

    def load(self):
        if self.model is not None:
            return
        import torch
        from conette import CoNeTTEConfig, CoNeTTEModel
        self.config = configuration()
        import nltk
        import conette.huggingface.model as conette_model
        from conette.transforms.audioset_mapping import load_audioset_idx_to_name
        from functools import partial
        resources = Path(self.config['resourcesPath'])
        nltk.data.path.insert(0, str(resources / 'nltk'))
        # CoNeTTE's constructor omits the public loader's cache_path argument.
        conette_model.load_audioset_idx_to_name = partial(load_audioset_idx_to_name, cache_path=resources)
        device = self.config['device']
        torch.set_num_threads(max(1, min(8, (os.cpu_count() or 2) // 2)))
        self.model = CoNeTTEModel.from_pretrained(
            self.config['modelPath'], local_files_only=True,
            config=CoNeTTEConfig.from_pretrained(self.config['modelPath'], local_files_only=True),
            device=device, offline=True,
        ).eval()

    def describe(self, samples):
        import torch
        self.load()
        with torch.inference_mode():
            output = self.model([torch.from_numpy(samples.copy()).unsqueeze(0)],
                                sr=[SAMPLE_RATE], task='clotho')
        result = output['cands'][0].strip()
        if not result:
            raise ValueError('Audio model returned an empty description.')
        return ' '.join(result.split())[:700]

    def chunk(self, request):
        import numpy as np
        start, end = request['fromMs'], request['toMs']
        if not isinstance(start, int) or not isinstance(end, int) or start < 0 or not 0 < end - start <= 300_000:
            raise ValueError('Audio chunk must be a positive range of at most 300 seconds.')
        config = configuration()
        probe = subprocess.run([
            'ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=index',
            '-of', 'json', request['inputPath'],
        ], capture_output=True, check=True, timeout=30)
        if not json.loads(probe.stdout).get('streams'):
            return {'status': 'source_missing', 'descriptions': [], 'note': 'No audio stream in this film.'}
        decoded = subprocess.run([
            'ffmpeg', '-v', 'error', '-ss', f'{start / 1000:.3f}', '-i', request['inputPath'],
            '-t', f'{(end - start) / 1000:.3f}', '-map', '0:a:0', '-vn', '-ac', '1',
            '-ar', str(SAMPLE_RATE), '-f', 'f32le', 'pipe:1',
        ], capture_output=True, timeout=120)
        if decoded.returncode:
            raise ValueError(decoded.stderr.decode('utf-8', errors='replace')[-1000:])
        samples = np.frombuffer(decoded.stdout, dtype='<f4')
        expected = round((end - start) * SAMPLE_RATE / 1000)
        if len(samples) < expected - SAMPLE_RATE // 4:
            raise ValueError('Audio decode ended before the requested chunk; refusing to describe missing audio.')
        segment_ms = config.get('segmentMs', 10_000)
        descriptions = []
        for from_ms in range(start, end, segment_ms):
            to_ms = min(from_ms + segment_ms, end)
            clip = samples[round((from_ms - start) * SAMPLE_RATE / 1000):round((to_ms - start) * SAMPLE_RATE / 1000)]
            if not len(clip) or not np.isfinite(clip).all():
                raise ValueError('Audio decode returned empty or non-finite samples.')
            rms = float(np.sqrt(np.mean(clip.astype(np.float64) ** 2)))
            if rms < 0.0003:
                description, source = 'Near-silent audio in this interval.', 'acoustic_measurement'
            else:
                description, source = self.describe(clip), 'local_audio_model'
            descriptions.append({
                'id': f'audio-{from_ms}-{to_ms}', 'fromMs': from_ms, 'toMs': to_ms,
                'availableAtMs': to_ms, 'text': description, 'source': source,
            })
            emit({'type': 'progress', 'throughMs': to_ms})
        return {
            'status': 'ready', 'model': config['modelId'], 'revision': config['revision'],
            'promptVersion': PROMPT_VERSION, 'segmentMs': segment_ms, 'descriptions': descriptions,
        }


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'status':
        emit(availability())
    else:
        describer = Describer()
        for line in sys.stdin:
            try:
                request = json.loads(line)
                # Libraries may print diagnostics. Keep the protocol channel JSON-only.
                with contextlib.redirect_stdout(sys.stderr):
                    # Progress uses the saved protocol stream below.
                    result = describer.chunk(request)
                emit({'type': 'result', 'ok': True, **result})
            except Exception as error:
                emit({'type': 'result', 'ok': False, 'error': str(error)[:1500]})
