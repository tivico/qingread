"""Opt-in timing of synthetic speech fixture; no production config writes."""
import io,json,sys,tempfile,time,uuid,wave
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'companion'))
from app import Companion
if '--live' not in sys.argv:raise SystemExit('Use --live with the synthetic test-results/speech-sample.wav fixture')
with wave.open(str(ROOT/'test-results/speech-sample.wav'),'rb') as audio:
    rate=audio.getframerate();channels=audio.getnchannels();width=audio.getsampwidth()
    frames=audio.readframes(int(rate*4.5))
buffer=io.BytesIO()
with wave.open(buffer,'wb') as audio:
    audio.setparams((channels,width,rate,0,'NONE','not compressed'));audio.writeframes(frames)
with tempfile.TemporaryDirectory(dir=ROOT/'test-results') as directory:
    app=Companion(directory)
    app.config['model']=json.loads((ROOT/'companion/data/config.json').read_text(encoding='utf-8')).get('model')
    own=ROOT/'companion/data/models/whisper-small'
    if (own/'model.bin').exists():app.whisper_path=lambda:own
    report={'audioSeconds':len(frames)/(rate*channels*width),'strideSeconds':4,'model':app.config['model'],'recognitionSeconds':[]}
    try:
        for _ in range(2):
            started=time.monotonic();recognized=app.transcribe(buffer.getvalue(),'en')
            report['recognitionSeconds'].append(round(time.monotonic()-started,3))
            print(json.dumps({'recognitionSeconds':report['recognitionSeconds'][-1],'characters':len(recognized['text'])}),flush=True)
        if not recognized['text']:raise RuntimeError('Synthetic audio produced no text')
        identifier=uuid.uuid4().hex;started=time.monotonic()
        app.start_inference(identifier,'benchmark',{'kind':'translate','text':recognized['text'],'source':'en'})
        while time.monotonic()-started<190:
            state=app.inference_jobs.get(identifier,'benchmark')
            if state['stage'] in {'done','failed','cancelled'}:break
            time.sleep(.02)
        if state['stage']!='done':raise RuntimeError('Translation benchmark failed')
        report['translationSeconds']=round(time.monotonic()-started,3)
        report['warmRecognitionPlusFirstTranslationSeconds']=round(report['recognitionSeconds'][-1]+report['translationSeconds'],3)
        report['scope']='synthetic audio; isolated companion; excludes browser capture and network polling; single sample'
        (ROOT/'test-results/speech-benchmark.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
        print(json.dumps(report),flush=True)
    finally:app.inference_jobs.close()
