#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
command -v uv >/dev/null || { echo 'Install uv from https://docs.astral.sh/uv/getting-started/installation/ first.'; exit 1; }
if [ ! -x observer/.conette-venv/bin/python ]; then
  uv venv --python 3.10 observer/.conette-venv
fi
audio_python=observer/.conette-venv/bin/python
uv pip install --python "$audio_python" torch==1.13.1 torchaudio==0.13.1
uv pip install --python "$audio_python" -r observer/audio-requirements.txt
"$audio_python" scripts/download-audio-model.py --data-root "${LOCAL_DATA_ROOT:-local-data}"
echo 'Audio setup finished. No inference or live test was run. Use Add audio descriptions in the cinema.'
