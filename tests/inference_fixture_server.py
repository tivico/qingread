"""Short-lived real HTTP helper for the isolated extension transport test."""
import json,sys,tempfile,time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'companion'))
from app import Companion,Handler,make_server,validate_wav,UserError
if __name__=='__main__':
    with tempfile.TemporaryDirectory() as directory:
        def model(route,payload=None,timeout=None):
            return {'models':[{'name':'synthetic:test','digest':'fixture'}]} if route=='/api/tags' else {}
        class Stream:
            def __init__(self,operation):self.operation=operation
            def events(self,payload):
                time.sleep(.35);self.operation.check()
                yield {'message':{'content':'人工測試摘要'},'done':True}
            def cancel(self):pass
            def close(self):pass
        if '--live-model' in sys.argv:
            selected=json.loads((Path(__file__).resolve().parents[1]/'companion/data/config.json').read_text(encoding='utf-8')).get('model')
            app=Companion(directory)
            app.config.update(token='a'*43,model=selected)
        else:
            app=Companion(directory,model,managed_stream=Stream)
            app.config.update(token='a'*43,model='synthetic:test');app.traditional=lambda text:text
        if '--synthetic-speech' in sys.argv:
            from itertools import count
            speech_count=count(1)
            def transcribe(raw,language):
                validate_wav(raw)
                number=next(speech_count)
                if number==1:
                    raise UserError('SPEECH_BUSY','上一段人工語音仍在辨識',429)
                return {'text':f'Artificial speech segment {number}.','segments':[{'start':0,'end':4.5}], 'language':'en'}
            app.transcribe=transcribe
            health_before_speech=app.health
            def speech_health():
                health=health_before_speech();health['speech_ready']=True;return health
            app.health=speech_health
        if '--legacy-owner' in sys.argv:
            Handler.inference_owner=lambda self:self.headers.get('Origin') or 'local'
            current_health=app.health
            def legacy_health():
                health=current_health();health.pop('inference_client_identity',None);return health
            app.health=legacy_health
        server=make_server(app,0)
        print(json.dumps({'port':server.server_port}),flush=True)
        try:server.serve_forever()
        finally:app.inference_jobs.close();server.server_close()
