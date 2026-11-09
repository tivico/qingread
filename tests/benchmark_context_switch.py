"""Compare short-caption context sizes after a normal text task, without changing live settings."""
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
from inference import ModelStream


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--live', action='store_true', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit('Output exists; choose a new filename.')
    model = json.loads((ROOT / 'companion/data/config.json').read_text(encoding='utf-8'))['model']
    context = [4096]
    (ROOT / 'test-results').mkdir(exist_ok=True)
    class ContextStream(ModelStream):
        def events(self, payload):
            if payload.get('keep_alive') == '10m':
                payload['options']['num_ctx'] = context[0]
            yield from super().events(payload)
    report = {'model': model, 'scope': 'artificial short text; isolated helper; context override only; live configuration unchanged; helper cache cleared before each request; model/prompt caches not forcibly cleared', 'samples': []}
    with tempfile.TemporaryDirectory(dir=ROOT / 'test-results') as folder:
        app = Companion(folder, managed_stream=ContextStream)
        app.config['model'] = model
        def run(text, profile=None):
            app.translation_cache.clear()
            identifier = uuid.uuid4().hex
            body = {'kind': 'translate', 'source': 'en', 'text': text}
            if profile: body['profile'] = profile
            state = app.start_inference(identifier, 'context-benchmark', body)
            while state['stage'] not in {'done', 'failed', 'cancelled'}:
                time.sleep(.05)
                state = app.inference_jobs.get(identifier, 'context-benchmark')
            if state['stage'] != 'done' or state.get('truncated') or state.get('cached'):
                raise RuntimeError('Incomplete or cached sample; do not count it as a valid measurement.')
            return {key: state[key] for key in ['elapsedMs', 'timings', 'text']}
        try:
            for index, size in enumerate([4096, 8192, 8192, 4096]):
                context[0] = size
                normal = run('Check the document and keep the original file.')
                caption = run('Wait, keep the original file. We will check the translation first.', 'video')
                report['samples'].append({'round': index + 1, 'videoContext': size, 'general': normal, 'caption': caption})
                print(json.dumps({'round': index + 1, 'context': size, 'captionMs': caption['elapsedMs'],
                                  'loadMs': caption['timings'].get('loadMs')}), flush=True)
        finally:
            app.inference_jobs.close()
    report['medianCaptionMs'] = {str(size): statistics.median(row['caption']['elapsedMs'] for row in report['samples'] if row['videoContext'] == size) for size in [4096, 8192]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open('x', encoding='utf-8') as file:
        json.dump(report, file, ensure_ascii=False, indent=2)


if __name__ == '__main__':
    main()
