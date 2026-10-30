"""Only coarse phases and numeric counters cross the PDF worker boundary."""
import json
from pathlib import Path

PHASES={'analysis','ocr','translation','output','processing'}
def write_progress(directory,phase,current=None,total=None):
    if phase not in PHASES:return
    value={'phase':phase}
    if type(current) is int and type(total) is int and 0<=current<=total<=100000:
        value.update(current=current,total=total)
    target=Path(directory)/'progress.json'
    try:
        temporary=target.with_suffix('.tmp')
        temporary.write_text(json.dumps(value),encoding='utf-8');temporary.replace(target)
    except OSError:pass  # Progress must not fail an otherwise valid document job.

def event_phase(stage):
    if not isinstance(stage,str):return 'processing'
    lower=stage.lower()
    if any(word in lower for word in ('translate','extract terms')):return 'translation'
    if any(word in lower for word in ('typesetting','font','drawing','save pdf','merge')):return 'output'
    if any(word in lower for word in ('parse','detect','layout')):return 'analysis'
    return 'processing'

async def track_events(events,directory,state):
    async for event in events:
        if event.get('type') in {'progress_start','progress_update','progress_end'}:
            write_progress(directory,event_phase(event.get('stage')),event.get('stage_current'),event.get('stage_total'))
        if event.get('type')=='finish':state['finished']=True
        if event.get('type')=='error':
            state['error']=True
            if event.get('error')=='Scanned PDF detected.':state['error_code']='PDF_SCAN_DETECTED'
        yield event
