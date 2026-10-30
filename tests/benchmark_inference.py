"""Opt-in synthetic local inference benchmark; never changes the user's settings."""
import argparse
import json
from pathlib import Path
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'companion'))
from app import Companion


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--live',action='store_true')
    args=parser.parse_args()
    if not args.live:
        parser.error('Use --live to run synthetic text on the configured local model')
    selected=json.loads((ROOT/'companion/data/config.json').read_text(encoding='utf-8')).get('model')
    report={'model':selected,'scope':'synthetic text; isolated companion; production settings unchanged'}
    with tempfile.TemporaryDirectory(dir=ROOT/'test-results') as directory:
        app=Companion(directory)
        app.config['model']=selected
        def start(text):
            identifier=uuid.uuid4().hex
            app.start_inference(identifier,'benchmark',{'kind':'translate','text':text,'source':'en'})
            return identifier
        def finish(identifier):
            started=time.monotonic()
            while time.monotonic()-started < 190:
                state=app.inference_jobs.get(identifier,'benchmark')
                if state['stage'] in {'done','failed','cancelled'}: return state
                time.sleep(.02)
            raise RuntimeError('Benchmark deadline exceeded')
        def sample(text):
            state=finish(start(text))
            if state['stage']!='done':raise RuntimeError(state.get('error','not done'))
            return {'seconds':round(state['elapsedMs']/1000,3),'cached':state['cached'],'outputCharacters':len(state['text'])}
        try:
            report['baseline']=sample('Do not delete the backup. The price is 25 dollars.')
            print(json.dumps({'baseline':report['baseline']},ensure_ascii=False),flush=True)
            identifier=start('This is a synthetic performance test. Keep the original document and verify each translated sentence. '*75)
            time.sleep(.75)
            before=app.inference_jobs.get(identifier,'benchmark')
            if before['stage'] in {'done','failed','cancelled'}:raise RuntimeError('Long sample finished before cancellation; cancellation not exercised')
            started=time.monotonic()
            app.inference_jobs.cancel(identifier,'benchmark')
            cancelled=finish(identifier)
            report['cancellation']={'before':before['stage'],'after':cancelled['stage'],'seconds':round(time.monotonic()-started,3)}
            if cancelled['stage']!='cancelled':raise RuntimeError('Cancellation not confirmed')
            print(json.dumps({'cancellation':report['cancellation']}),flush=True)
            report['followup']=sample('Keep the original file. This is a new translation request.')
            report['repeat']=sample('Keep the original file. This is a new translation request.')
            if not report['repeat']['cached']:raise RuntimeError('Repeated translation did not use the cache')
        finally:
            app.inference_jobs.close()
    (ROOT/'test-results/inference-benchmark.json').write_text(json.dumps(report,indent=2,ensure_ascii=False),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False),flush=True)


if __name__=='__main__':main()
