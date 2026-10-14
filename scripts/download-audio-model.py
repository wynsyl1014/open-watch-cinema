"""Download public model weights for offline use; never upload media or run inference."""
import argparse
import json
import os
from pathlib import Path
from urllib.request import urlopen

from huggingface_hub import snapshot_download

parser = argparse.ArgumentParser()
parser.add_argument('--data-root', required=True)
args = parser.parse_args()
root = Path(args.data_root).resolve()
model_id = 'Labbeti/conette'
revision = 'f7c6d0338832ee22df1e7c9d579cf5911a1a115d'
model_path = snapshot_download(
    model_id, revision=revision, cache_dir=root / 'audio-model-cache',
    allow_patterns=['config.json', 'pytorch_model.bin'],
)
root.mkdir(parents=True, exist_ok=True)
resources = root / 'audio-resources'
resources.mkdir(parents=True, exist_ok=True)
with urlopen('https://storage.googleapis.com/us_audioset/youtube_corpus/v1/csv/class_labels_indices.csv', timeout=30) as response:
    (resources / 'class_labels_indices.csv').write_bytes(response.read())
import nltk
if not nltk.download('stopwords', download_dir=str(resources / 'nltk'), quiet=True):
    raise RuntimeError('Could not download the CoNeTTE stopwords resource.')
config = root / 'audio-model.json'
temporary = config.with_suffix('.tmp')
temporary.write_text(json.dumps({
    'modelId': model_id, 'revision': revision, 'modelPath': model_path,
    'device': 'cpu', 'segmentMs': 10_000,
    'resourcesPath': str(resources),
}, indent=2) + '\n', encoding='utf-8')
os.replace(temporary, config)
print(f'Audio model downloaded. Configuration: {config}', flush=True)
