"""Compare explicitly named local models on public/artificial text; never change live settings."""
import argparse
import json
from pathlib import Path
import sys
import tempfile
import time

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'companion'))
from app import Companion, local_request, local_stream

FACTS=('Library notice: The library is closed on Friday, 6 November, for maintenance and reopens on Monday, 9 November, at 09:00. '
       'Do not delete existing reservations; they remain valid. Only new reservations are paused. '
       'The 30-minute online workshop costs NT$120 and is optional. The free reading room does not require a ticket. '
       'The local summarizer processes only visible page text, up to 6,000 characters. It does not read unopened links or upload articles to the cloud.')
TRANSLATION='Do not delete the backup. The optional workshop costs NT$120 and lasts 30 minutes. Only new reservations are paused; existing reservations remain valid.'


def benchmark(model, source):
    # Discard only the candidate's runner/cache, not other installed models or user settings.
    local_request('/api/generate',{'model':model,'keep_alive':0},timeout=20)
    metrics={}
    def stream(payload):
        for event in local_stream(payload):
            if event.get('done'):
                metrics.update({key:event.get(key) for key in ['prompt_eval_count','prompt_eval_duration','eval_count','eval_duration','load_duration','total_duration']})
            yield event
    with tempfile.TemporaryDirectory() as directory:
        app=Companion(directory,model_stream=stream);app.config['model']=model
        result={'model':model,'cases':{}}
        for name,text in [('public_article',source),('facts_and_negation',FACTS)]:
            metrics.clear();start=time.monotonic();first=None;last=None
            for event in app.stream_summary(text):
                if event.get('text') and first is None:
                    first=time.monotonic()-start
                    print(json.dumps({'model':model,'case':name,'first_seconds':round(first,2)}),flush=True)
                last=event
            if first is None or not last or last.get('type') == 'error' or not last.get('text'):
                raise RuntimeError(f'{name}: model returned no usable summary')
            result['cases'][name]={'input_characters':len(text),'first_seconds':round(first,2),'total_seconds':round(time.monotonic()-start,2),
                'truncated':last['truncated'],'output':last['text'],'metrics':dict(metrics)}
            print(json.dumps({'model':model,'case':name,'total_seconds':result['cases'][name]['total_seconds'],'truncated':last['truncated']}),flush=True)
        start=time.monotonic();translated=app.translate(TRANSLATION,'en')
        result['translation']={'input':TRANSLATION,'output':translated['text'],'seconds':round(time.monotonic()-start,2)}
        start=time.monotonic();cached=list(app.stream_summary(source))[-1]
        result['repeat']={'seconds':round(time.monotonic()-start,2),'cached':cached['cached']}
        return result


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('models',nargs='+')
    parser.add_argument('--source',type=Path,default=ROOT/'test-results/summary-benchmark-source.txt')
    parser.add_argument('--output',type=Path,default=ROOT/'test-results/model-comparison.json')
    args=parser.parse_args()
    source=args.source.read_text(encoding='utf-8')
    if not 1<=len(source)<=6000:raise SystemExit('Source must contain 1-6000 characters')
    args.output.parent.mkdir(parents=True,exist_ok=True)
    reports=[]
    for model in args.models:
        try:reports.append(benchmark(model,source))
        except Exception as error:reports.append({'model':model,'error':str(error)})
        args.output.write_text(json.dumps(reports,ensure_ascii=False,indent=2),encoding='utf-8')
    print('Saved '+str(args.output),flush=True)
    if any('error' in report for report in reports):raise SystemExit(1)
