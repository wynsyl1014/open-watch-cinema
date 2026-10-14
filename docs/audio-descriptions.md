# Local audio descriptions

Audio descriptions accompany the existing dialogue, visual, and motion tracks in each AI tick. The film is analyzed locally during preparation; the ChatGPT connection receives text descriptions, never raw audio. Audio setup and processing do not use a paid API or upload the film.

## Setup and use

Windows: run `./setup-audio.ps1` in PowerShell. macOS: run `bash setup-audio.command`. Both use [uv](https://docs.astral.sh/uv/getting-started/installation/) to create `observer/.conette-venv` with Python 3.10 and download the public model into the local data directory. If uv's Windows Python discovery fails, pass an existing Python 3.10 executable with `./setup-audio.ps1 -Python C:/path/to/python.exe`. The separate environment allows upgrades from the previous Qwen setup without replacing its Python installation.

Setup downloads the pinned CoNeTTE checkpoint and tokenizer resources, records the exact model revision in `local-data/audio-model.json`, and does not run inference. The audio environment and downloaded weights are ignored by Git. `LOCAL_DATA_ROOT` can move the model/configuration along with the other local data. The AudioSet label map and NLTK stopwords are stored under `audio-resources` there; the spaCy tokenizer is installed in the private environment.

After setup, restart the cinema and MCP adapter, reload the page, and choose **Prepare for AI viewing** for a new film or **Add audio descriptions** for an already prepared film. The latter retains its visual files and selected dialogue track. Finished audio chunks are checkpointed and reused on retry; an interrupted chunk is regenerated. The CLI can opt in with `npm run observer:precompute -- --input path/to/film.mp4 --audio`.

Audio is an optional addition to the existing readiness contract. Missing setup or unavailable audio does not make completed visuals/dialogue unusable. The job message and `audioTrack.status` distinguish missing setup, pending work, failed analysis, no source audio, and completed descriptions.

## Local model and scope

The provider is [Labbeti/CoNeTTE](https://github.com/Labbeti/conette-audio-captioning), using its Clotho caption style. The worker loads the pinned local checkpoint with offline mode enabled. One model stays resident across the chunks of a preparation job and exits when the job ends. Model identity and caption profile version invalidate older Qwen audio checkpoints when preparation runs again.

The default is CPU inference, including on Windows with AMD graphics. The [local benchmark](audio-benchmark.md) measured roughly 0.25 seconds of warm inference per ten-second clip. Optional `OWC_AUDIO_DEVICE` overrides the configured device; CUDA requires a compatible PyTorch installation. `OWC_AUDIO_PYTHON` can select another compatible audio interpreter; remove an override pointing to the old Qwen environment. GPU acceleration is not configured by the Windows setup script.

The first audio stream is decoded to mono 32 kHz. Each owned preparation chunk is divided into independent 10-second clips; `segmentMs` in the configuration accepts 2–20 seconds. The final clip can be shorter. The model produces short captions of:

- Speech and audible vocal sounds. Detailed delivery and emotional tone are not guaranteed.
- Music: audible instrumentation, rhythm, and changes where discernible.
- Ambience and sound effects.

The model does not receive subtitles, visuals, character names, or prior clips. It uses a trained caption style rather than a natural-language instruction prompt. Its output remains fallible; speaker attributes, sounds, and events are not verified facts. This version does not attribute delivery to a particular subtitle line or named speaker. Near-silent clips are labeled using an acoustic energy threshold; absent descriptions must never be interpreted as silence.

## Storage and delivery

Each completed preparation chunk can contain `audio.json`, referenced by its manifest `audioRef`. `audioStatus`, `audioDescriptionCount`, and `audioProfile` support resumable work. A changed model revision, prompt version, segment size, or device regenerates audio checkpoints on the next preparation run. Existing packages without this extension report `not_prepared`.

An illustrative description has this form:

```json
{
  "id": "audio-728000-738000",
  "fromMs": 728000,
  "toMs": 738000,
  "availableAtMs": 738000,
  "text": "Quiet speech with long pauses. Soft piano continues underneath.",
  "source": "local_audio_model"
}
```

Ticks and detailed windows return `audioDescriptions`; readiness and provider metadata appear in `availability.audioTrack` for ticks and `audioTrack` for windows. `sourceChunkId` links each delivered description to its prepared chunk. The returned text is media evidence, not an instruction to the receiving AI.

A description is released only when its entire analyzed clip has played: `availableAtMs` must equal `toMs` and be behind both the requested window end and the room playhead. Audio never uses the optional lookahead setting. Delivery uses an end-exclusive previous cursor and an inclusive new cursor: `(fromMs, toMs]` over `availableAtMs`. This avoids both early release and losing a description when a tick ends midway through its clip.

Audio shares the media cursor and `seekVersion`. Ordinary polling does not repeat completed clips; seeks intentionally supply destination context. If a response would exceed item limits, ticks shrink their delivery range and retain backlog rather than advancing past undelivered audio. A seek during a file read causes the server to reject the stale response and request a retry with unchanged cursors.

## Validation status

The separate three-clip benchmark is retained as a historical exploratory result in [audio-benchmark.md](audio-benchmark.md). Windows CPU preparation completed on September 15, 2026 using the pinned CoNeTTE revision `f7c6d0338832ee22df1e7c9d579cf5911a1a115d`: all 26 of 26 chunks for one test film were ready, with 761 descriptions. In observed room checks that day, descriptions arrived through MCP without duplicate or early releases; pause/resume behaved as expected, and the latest seek destination was delivered. Two seek changes between polls did not independently confirm both landings. The session also encountered an outdated cached `seekVersion` schema; see [the cursor upgrade guidance](seek-sync.md). A later companion viewing session on September 18 reached the closing sequence.

These observations do not establish caption accuracy, nuanced emotional delivery, all-platform support, or a full-film throughput rate. Preparation elapsed time was not a throughput benchmark. The Windows CPU path is the validated path available here; macOS setup, GPU acceleration, clean-machine setup, and network-isolated/offline setup were not live validated. Preparation still processes the full film; scheduling only current and upcoming chunks remains a separate improvement.

## Manual acceptance checklist

Use a test film and opt in to audio during **Prepare for AI viewing** or **Add audio descriptions**.

- Let one audio clip play to its end and confirm its description is released at the clip end, not earlier.
- Pause and poll repeatedly; confirm completed descriptions do not repeat. Resume and confirm the next completed clip arrives once.
- Seek forward, then test a seek back separately; confirm each destination's descriptions are released only after its clips complete.
- In a temporary test instance with no audio setup, prepare a new test film; confirm visual and dialogue readiness still succeeds and the audio status remains diagnostic. Do not remove a working audio environment or overwrite an existing film package for this check.

Automated regression coverage in `tests/audio-descriptions.test.mjs` validates complete chunk coverage, completion timestamps, no-lookahead release, acknowledged no-replay behavior, and retention of undelivered captions when item limits are reached. These tests use synthetic packages without model downloads or inference. Run `node --test tests/audio-descriptions.test.mjs` or `npm test`.

The optional runtime uses a separate Python 3.10 environment with CoNeTTE 0.4.0, PyTorch 1.13.1, and Transformers 4.30.2. This older dependency stack is a maintenance limitation; it does not change the visual observer's environment or add npm dependencies. Setup downloads packages, the pinned model, and tokenizer resources. Subsequent inference is configured to load local resources. No model weights or prepared film assets are committed to the repository. The provider's [model card](https://huggingface.co/Labbeti/conette) describes its training and intended captioning interface; this integration has not established film-specific caption accuracy.

Windows setup resolves the private environment's base Python executable to its physical path. This prevents a Python installed through a packaged desktop host from working during setup but failing when launched by the cinema outside that host. Audio availability failures retain diagnostic text instead of silently reporting a missing setup.
