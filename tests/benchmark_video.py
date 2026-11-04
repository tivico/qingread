"""Compare subtitle inference profiles using synthetic text and an isolated companion."""
import argparse
import json
from pathlib import Path
import statistics
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'companion'))
from app import Companion


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser()
    parser.add_argument('--live', action='store_true')
    args = parser.parse_args()
    if not args.live:
        parser.error('Use --live to test the configured local model')
    selected = json.loads((ROOT / 'companion/data/config.json').read_text(encoding='utf-8'))['model']
    samples = [
        'Keep the original file and check the translation.',
        'Open the settings and give this package read-only access.',
        'The API returns a response. Do not delete the backup.',
    ]
    report = {'model': selected, 'profiles': {}, 'scope': 'synthetic text; isolated companion'}
    results = ROOT / 'test-results'
    results.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(dir=results) as directory:
        app = Companion(directory)
        app.config['model'] = selected

        def run(text, profile):
            identifier = uuid.uuid4().hex
            body = {'kind': 'translate', 'source': 'en', 'text': text}
            if profile:
                body['profile'] = profile
            app.start_inference(identifier, 'benchmark', body)
            deadline = time.monotonic() + 190
            while time.monotonic() < deadline:
                state = app.inference_jobs.get(identifier, 'benchmark')
                if state['stage'] in {'failed', 'cancelled'}:
                    raise RuntimeError(state.get('error', state['stage']))
                if state['stage'] == 'done':
                    return {'elapsedMs': state['elapsedMs'], 'timings': state['timings'],
                        'cached': state['cached'], 'text': state['text']}
                time.sleep(.02)
            app.inference_jobs.cancel(identifier, 'benchmark')
            raise RuntimeError('Benchmark deadline exceeded')

        try:
            for profile in [None, 'video']:
                name = profile or 'general'
                warmup = run('Prepare the subtitle translator.', profile)
                measured = [run(text, profile) for text in samples]
                report['profiles'][name] = {'warmup': warmup, 'samples': measured,
                    'medianMs': statistics.median(item['elapsedMs'] for item in measured)}
                print(json.dumps({'profile': name, 'medianMs': report['profiles'][name]['medianMs']}), flush=True)
            report['repeat'] = run(samples[-1], 'video')
            if not report['repeat']['cached']:
                raise RuntimeError('Repeated subtitle did not use its profile cache')
        finally:
            app.inference_jobs.close()
    (results / 'video-inference-benchmark.json').write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
