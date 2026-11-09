"""Opt-in timing comparison on identical inputs; isolated helper, existing local model."""
import argparse
import json
from pathlib import Path
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
    parser.add_argument('--source', type=Path)
    parser.add_argument('--samples', type=int, choices=[1, 2, 3], default=3)
    parser.add_argument('--indices', type=int, nargs='+')
    parser.add_argument('--details', nargs='+', default=['detailed', 'concise'])
    args = parser.parse_args()
    if not args.live:
        parser.error('Use --live to run the configured local model')
    if args.source:
        source = json.loads(args.source.read_text(encoding='utf-8'))
        parts = source['chunks']
        indices = args.indices if args.indices is not None else sorted({0, len(parts)//2, len(parts)-1})[:args.samples]
        if any(index<0 or index>=len(parts) for index in indices):
            parser.error('Source index is outside the available chunks')
        samples = [parts[i]['text'] for i in indices]
    else:
        samples = [(
            'This artificial lesson explains how to protect project files. Keep the original document and verify backups before editing. '
            'The optional workshop costs NT$120 and lasts 30 minutes. Existing reservations remain valid; only new reservations are paused. '
            'The reopening time is Monday at 09:00. Do not delete the backup. '
        ) * 13]
    selected = json.loads((ROOT / 'companion/data/config.json').read_text(encoding='utf-8'))['model']
    results = ROOT / 'test-results'
    results.mkdir(exist_ok=True)
    report = {'model':selected, 'scope':'identical input; isolated helper; production settings unchanged', 'samples':[]}
    output = results / ('video-summary-benchmark-' + '-'.join(args.details) + '.json')
    with tempfile.TemporaryDirectory(dir=results) as directory:
        app = Companion(directory)
        app.config['model'] = selected
        def run(text, detail):
            identifier = uuid.uuid4().hex
            app.translation_cache.clear()
            body = {'kind':'summarize', 'text':text, 'summaryMode':'video-chunk'}
            if detail != 'baseline':
                body['summaryDetail'] = detail
            app.start_inference(identifier, 'benchmark', body)
            first = None
            while True:
                state = app.inference_jobs.get(identifier, 'benchmark')
                if state.get('text') and first is None:
                    first = state['elapsedMs']
                if state['stage'] in {'done','failed','cancelled'}:
                    break
                time.sleep(.02)
            if state['stage'] != 'done':
                raise RuntimeError(state.get('message', state['stage']))
            if state['truncated']:
                raise RuntimeError('Summary was truncated')
            if not any('\u3400' <= char <= '\u9fff' for char in state['text']):
                raise RuntimeError('Summary did not contain Chinese output')
            return {'detail':detail, 'inputCharacters':len(text), 'elapsedMs':state['elapsedMs'],
                'firstTextMs':first, 'timings':state['timings'], 'cached':state['cached'],
                'truncated':state['truncated'], 'outputCharacters':len(state['text']), 'text':state['text']}
        try:
            run('Artificial warmup notice: Keep the original file.', args.details[0])
            for index, text in enumerate(samples):
                order = args.details if index % 2 == 0 else list(reversed(args.details))
                for detail in order:
                    value = run(text, detail)
                    report['samples'].append({'sample':index, **value})
                    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
                    print(json.dumps({k:v for k,v in value.items() if k!='text'}, ensure_ascii=False), flush=True)
        finally:
            app.inference_jobs.close()


if __name__ == '__main__':
    main()
