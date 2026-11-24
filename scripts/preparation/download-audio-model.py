"""Download public model weights for offline use; never upload media. Verify offline with synthetic audio before activation."""
import argparse
import json
import os
import csv
import io
import subprocess
import sys
import tempfile
import socket
from pathlib import Path
from urllib.request import urlopen

from huggingface_hub import snapshot_download

parser = argparse.ArgumentParser()
parser.add_argument('--data-root', required=True)
args = parser.parse_args()
root = Path(args.data_root).resolve() / '模型' / '声音描述'
model_id = 'Labbeti/conette'
revision = 'f7c6d0338832ee22df1e7c9d579cf5911a1a115d'
print('Downloading the pinned CoNeTTE model checkpoint...', flush=True)
model_path = snapshot_download(
    model_id, revision=revision, cache_dir=root / 'audio-model-cache',
    allow_patterns=['config.json', 'pytorch_model.bin'],
)
model = Path(model_path)
json.loads((model / 'config.json').read_text(encoding='utf-8'))
if not (model / 'pytorch_model.bin').is_file() or (model / 'pytorch_model.bin').stat().st_size < 1_000_000:
    raise RuntimeError('The downloaded model checkpoint is missing or incomplete.')
root.mkdir(parents=True, exist_ok=True)
resources = root / 'audio-resources'
resources.mkdir(parents=True, exist_ok=True)
print('Downloading AudioSet labels...', flush=True)
with urlopen('https://storage.googleapis.com/us_audioset/youtube_corpus/v1/csv/class_labels_indices.csv', timeout=30) as response:
    labels = response.read()
rows = list(csv.DictReader(io.StringIO(labels.decode('utf-8-sig'))))
if len(rows) != 527 or not {'index', 'mid', 'display_name'}.issubset(rows[0]):
    raise RuntimeError('Unexpected AudioSet labels file; existing labels retained.')
labels_temp = resources / 'class_labels_indices.csv.tmp'
labels_temp.write_bytes(labels)
os.replace(labels_temp, resources / 'class_labels_indices.csv')
import nltk
print('Downloading NLTK stopwords...', flush=True)
socket.setdefaulttimeout(60)
if not nltk.download('stopwords', download_dir=str(resources / 'nltk'), quiet=True):
    raise RuntimeError('Could not download the CoNeTTE stopwords resource.')
config = root / 'audio-model.json'
temporary = config.with_suffix('.tmp')
temporary.write_text(json.dumps({
    'modelId': model_id, 'revision': revision, 'modelPath': model_path,
    'device': 'cpu', 'segmentMs': 10_000,
    'resourcesPath': str(resources),
}, indent=2) + '\n', encoding='utf-8')
# Validate candidate configuration offline before making it active.
try:
    with tempfile.TemporaryDirectory(prefix='audio-health-', dir=root) as staging:
        candidate = Path(staging) / '模型' / '声音描述'
        candidate.mkdir(parents=True)
        (candidate / 'audio-model.json').write_bytes(temporary.read_bytes())
        print('Starting offline model health check (up to 10 minutes on CPU)...', flush=True)
        subprocess.run([sys.executable, str(Path(__file__).resolve().with_name('verify-audio-setup.py')),
                        '--data-root', staging], check=True, timeout=600)
    settings = json.loads(temporary.read_text(encoding='utf-8'))
    settings['modelPath'] = str(model.relative_to(root))
    settings['resourcesPath'] = str(resources.relative_to(root))
    temporary.write_text(json.dumps(settings, indent=2) + '\n', encoding='utf-8')
    os.replace(temporary, config)
finally:
    temporary.unlink(missing_ok=True)
print(f'Audio model downloaded. Configuration: {config}', flush=True)
