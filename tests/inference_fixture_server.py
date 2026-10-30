"""Short-lived real HTTP helper for the isolated extension transport test."""
import json,sys,tempfile,time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'companion'))
from app import Companion,Handler,make_server
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
        app=Companion(directory,model,managed_stream=Stream)
        app.config.update(token='a'*43,model='synthetic:test');app.traditional=lambda text:text
        if '--legacy-owner' in sys.argv:Handler.inference_owner=lambda self:self.headers.get('Origin') or 'local'
        server=make_server(app,0)
        print(json.dumps({'port':server.server_port}),flush=True)
        try:server.serve_forever()
        finally:app.inference_jobs.close();server.server_close()
