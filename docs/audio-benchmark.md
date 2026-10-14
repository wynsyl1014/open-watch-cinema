# Local audio model comparison

## Decision at benchmark time — September 14, 2026

CoNeTTE was a promising replacement for the CPU Qwen captioning path. YAMNet was a much faster option for basic sound labels. Both were fast enough on this small sample to justify bounded integration testing. Neither established accuracy on film soundtracks or nuanced dialogue delivery. A later Windows CPU integration run is documented in [audio-descriptions.md](audio-descriptions.md); it exercised preparation and playback timing but did not establish caption accuracy.

## Historical measured results — September 14, 2026

Machine: Ryzen 7 9800X3D, Windows, CPU only, eight inference threads. Three ten-second intervals from the user's local film at 01:00, 05:00, and 10:00, chosen before examining model output. These are exploratory samples, not verified speech/music/effects ground truth. Both models received the same intervals from the first audio stream, decoded at their native rate: CoNeTTE 32 kHz and YAMNet 16 kHz.

Models ran sequentially to avoid competing with each other. One first inference per clip was excluded; the table shows the median of the next three calls. Decode time was about 0.05 seconds per clip. Downloads were completed beforehand. Load measurements include imports and cached model initialization, and can include upstream metadata/tokenizer checks.

| Model | Cached load | 01:00 clip | 05:00 clip | 10:00 clip |
| --- | ---: | ---: | ---: | ---: |
| CoNeTTE | 7.21 s | 0.253 s | 0.273 s | 0.242 s |
| YAMNet | 4.31 s | 0.0076 s | 0.0068 s | 0.0069 s |

Including decode, these sampled ten-second intervals took roughly 0.30–0.32 seconds for CoNeTTE and 0.056–0.060 seconds for YAMNet. These are warm repeated-input measurements, not guaranteed full-film throughput; preparation elapsed time was not measured as a throughput benchmark. No apples-to-apples Qwen benchmark was run; the earlier slow two-second Qwen test included loading and used a different clip duration.

## Output differences

| Start | CoNeTTE caption | Leading YAMNet labels (mean score) |
| --- | --- | --- |
| 01:00 | “a man is giving a speech with his voice” | Speech 0.682; Silence 0.062; Inside, small room 0.048 |
| 05:00 | “a woman is singing a song while a person sings in the background” | Music 0.854; Plucked string instrument 0.048; Guitar 0.048 |
| 10:00 | “a woman is speaking and then a phone rings” | Silence 0.114; Vehicle 0.087; Inside, small room 0.062; Telephone 0.059 |

Outputs were stable across the four calls per clip. CoNeTTE supplied concise sentences without the unwanted Q&A seen in the earlier Qwen sample. That does not establish correctness: singing, speaker attributes, and the phone event need listening verification. YAMNet's low, scattered scores at 10:00 suggest ambiguity; they must not be turned into confident claims. Scores are not calibrated probabilities, and averaging can hide brief events.

No human listening labels or accuracy score are available. Neither result proves a capability to identify subtle dialogue tone. Listening to these intervals and a small labeled set of speech, music, and effects remains necessary before treating captions as accurate. The later Windows integration exercised transport and timing separately; it did not provide those labels or a formal accuracy score. The current cinema configuration and existing film packages were not changed by this benchmark.

## Reproduce

Use separate environments, because CoNeTTE pins an older PyTorch stack. From the project root, with `uv` and FFmpeg installed:

```powershell
uv venv --python 3.10 local-data/audio-benchmark/conette-env
uv pip install --python local-data/audio-benchmark/conette-env/Scripts/python.exe -r scripts/benchmark-conette-requirements.txt
uv venv --python 3.12 local-data/audio-benchmark/yamnet-env
uv pip install --python local-data/audio-benchmark/yamnet-env/Scripts/python.exe -r scripts/benchmark-yamnet-requirements.txt
```

For each model, first run with `--download-only`, then without it:

```powershell
local-data/audio-benchmark/conette-env/Scripts/python.exe scripts/benchmark-audio.py --model conette --input 'path/to/film.mkv' --download-only
local-data/audio-benchmark/conette-env/Scripts/python.exe scripts/benchmark-audio.py --model conette --input 'path/to/film.mkv'
local-data/audio-benchmark/yamnet-env/Scripts/python.exe scripts/benchmark-audio.py --model yamnet --input 'path/to/film.mkv' --download-only
local-data/audio-benchmark/yamnet-env/Scripts/python.exe scripts/benchmark-audio.py --model yamnet --input 'path/to/film.mkv'
```

`--starts`, `--seconds`, and `--repeats` customize sampling. JSON results, caches, and environments stay under ignored `local-data/audio-benchmark`; no film audio is uploaded. The script does not write cinema preparation checkpoints. Each result includes package versions and per-call outputs/timings. CoNeTTE uses checkpoint `f7c6d0338832ee22df1e7c9d579cf5911a1a115d`, package 0.4.0, PyTorch 1.13.1, and Transformers 4.30.2. YAMNet uses Google's TF Hub model version 1 with TensorFlow 2.20.0. Runtime warnings from the older CoNeTTE tokenizer and TensorFlow APIs did not prevent inference; these compatibility issues remain a maintenance cost.

Sources: [CoNeTTE author repository](https://github.com/Labbeti/conette-audio-captioning), [Google YAMNet example and model interface](https://www.tensorflow.org/hub/tutorials/yamnet).
