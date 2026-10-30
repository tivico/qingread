from pathlib import Path
import sys,time,json
root=Path(__file__).resolve().parents[1];sys.path.insert(0,str(root/'companion'))
from app import Companion
app=Companion(root/'companion'/'data')
start=time.monotonic()
result=app.transcribe((root/'test-results'/'speech-sample.wav').read_bytes(),'en')
print(json.dumps({**result,'seconds':round(time.monotonic()-start,2)},ensure_ascii=False))
assert 'backup' in result['text'].lower(), 'Speech integration did not recognize test sentence'
