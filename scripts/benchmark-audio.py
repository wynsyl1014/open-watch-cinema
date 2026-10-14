"""Compare local CPU audio models on identical intervals; never modifies cinema packages."""
import argparse
import csv
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import statistics
import subprocess
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', choices=['conette', 'yamnet'], required=True)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output-root', type=Path, default=Path('local-data/audio-benchmark'))
    parser.add_argument('--starts', type=float, nargs='+', default=[60, 300, 600])
    parser.add_argument('--seconds', type=float, default=10)
    parser.add_argument('--repeats', type=int, default=3)
    parser.add_argument('--download-only', action='store_true')
    parser.add_argument('--revision', default='f7c6d0338832ee22df1e7c9d579cf5911a1a115d',
                        help='Pinned CoNeTTE checkpoint revision.')
    args = parser.parse_args()
    if not 1 <= args.seconds <= 30 or args.repeats < 1 or any(t < 0 for t in args.starts):
        parser.error('Use nonnegative starts, 1–30 second clips, and at least one repeat.')
    root = args.output_root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    os.environ['HF_HOME'] = str(root / 'hf')
    os.environ['TFHUB_CACHE_DIR'] = str(root / 'tfhub')
    os.environ['CUDA_VISIBLE_DEVICES'] = '-1'
    os.environ['TF_CPP_MIN_LOG_LEVEL'] = '2'
    import numpy as np
    loaded = time.perf_counter()
    if args.model == 'conette':
        import torch
        from conette import CoNeTTEConfig, CoNeTTEModel
        torch.set_num_threads(8)
        torch.manual_seed(0)
        model = CoNeTTEModel.from_pretrained('Labbeti/conette', revision=args.revision,
            config=CoNeTTEConfig.from_pretrained('Labbeti/conette', revision=args.revision)).to('cpu').eval()
        sample_rate = 32000

        def infer(samples):
            with torch.inference_mode():
                return {'caption': model([torch.from_numpy(samples.copy()).unsqueeze(0)],
                                        sr=[sample_rate], task='clotho')['cands'][0]}
        packages = ['conette', 'torch', 'torchaudio', 'transformers', 'numpy']
    else:
        import tensorflow as tf
        import tensorflow_hub as hub
        tf.config.threading.set_intra_op_parallelism_threads(8)
        tf.config.threading.set_inter_op_parallelism_threads(1)
        model = hub.load('https://tfhub.dev/google/yamnet/1')
        with open(model.class_map_path().numpy(), encoding='utf-8') as file:
            labels = [row['display_name'] for row in csv.DictReader(file)]
        sample_rate = 16000

        def infer(samples):
            scores = model(samples)[0].numpy().mean(axis=0)
            return {'labels': [{'label': labels[i], 'score': float(scores[i])}
                               for i in np.argsort(scores)[::-1][:5]]}
        packages = ['tensorflow', 'tensorflow-hub', 'tf-keras', 'numpy']
    load_seconds = time.perf_counter() - loaded
    if args.download_only:
        print('Model cached. Rerun without --download-only for cached load timings.', flush=True)
        return
    report = {'model': args.model, 'device': 'cpu', 'threads': 8,
              'checkpoint': args.revision if args.model == 'conette' else 'https://tfhub.dev/google/yamnet/1',
              'python': platform.python_version(), 'platform': platform.platform(),
              'versions': {p: importlib.metadata.version(p) for p in packages},
              'loadSeconds': load_seconds, 'clipSeconds': args.seconds, 'clips': [],
              'note': 'No human ground truth. Scores are model scores, not calibrated confidence. '
                      'First inference per clip excluded from warm median; decode measured separately.'}
    for start in args.starts:
        began = time.perf_counter()
        result = subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(start), '-i', str(args.input),
                                 '-t', str(args.seconds), '-map', '0:a:0', '-vn', '-ac', '1',
                                 '-ar', str(sample_rate), '-f', 'f32le', 'pipe:1'],
                                capture_output=True, check=True, timeout=60)
        samples = np.frombuffer(result.stdout, dtype='<f4')
        expected = round(sample_rate * args.seconds)
        if len(samples) < expected or not np.isfinite(samples).all():
            raise ValueError('Clip did not decode to the complete requested interval.')
        samples = samples[:expected]  # FFmpeg resampling can emit a few trailing samples.
        clip = {'startSeconds': start, 'decodeSeconds': time.perf_counter() - began, 'runs': []}
        for repeat in range(args.repeats + 1):
            began = time.perf_counter()
            output = infer(samples)
            clip['runs'].append({'seconds': time.perf_counter() - began, 'output': output})
        clip['warmMedianSeconds'] = statistics.median(r['seconds'] for r in clip['runs'][1:])
        clip['realTimeFactor'] = clip['warmMedianSeconds'] / args.seconds
        report['clips'].append(clip)
        (root / f'{args.model}.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
        print(json.dumps(clip), flush=True)


if __name__ == '__main__':
    main()
