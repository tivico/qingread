import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
import urllib.error
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
from app import Companion, make_server
from inference import InferenceJobs, InferenceError, ModelStream, TIMEOUT_SECONDS


def wait_for(read, predicate=lambda value:value['stage'] in {'done','failed','cancelled'}, seconds=3):
    deadline = time.monotonic()+seconds
    while time.monotonic() < deadline:
        value = read()
        if predicate(value):
            return value
        time.sleep(.01)
    raise AssertionError(f'Timed out waiting for state: {value}')


class InferenceTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.revision = 'digest-one'
        self.calls = []
        self.parts = [{'message':{'content':'翻譯結果'},'done':True}]
        def request(route, payload=None, timeout=None):
            if route == '/api/tags': return {'models':[{'name':'local:test','digest':self.revision}]}
            if route == '/api/show': return {}
            raise AssertionError(route)
        fixture = self
        class FakeStream:
            def __init__(self, op): self.op = op
            def events(self, payload):
                fixture.calls.append(payload)
                yield from fixture.parts
            def cancel(self): pass
            def close(self): pass
        self.app = Companion(self.directory.name, request, managed_stream=FakeStream)
        self.app.config['model'] = 'local:test'
        self.app.traditional = lambda value:value

    def tearDown(self):
        self.app.inference_jobs.close()
        self.directory.cleanup()

    def run_text(self, text='source', source='en', kind='translate'):
        identifier = uuid.uuid4().hex
        self.app.start_inference(identifier, 'local', {'kind':kind,'text':text,'source':source})
        return wait_for(lambda:self.app.inference_jobs.get(identifier, 'local'))

    def test_cache_requires_same_text_source_kind_and_model_digest(self):
        self.assertFalse(self.run_text()['cached'])
        self.assertTrue(self.run_text()['cached'])
        self.run_text('different'); self.run_text(source='ja'); self.run_text(kind='explain')
        self.assertEqual(len(self.calls), 4)
        self.revision = 'digest-two'
        self.assertFalse(self.run_text()['cached'])
        self.revision = None
        self.assertFalse(self.run_text()['cached']);self.assertFalse(self.run_text()['cached'])
        self.assertEqual(len(self.calls), 7)

    def test_cache_expiry_capacity_and_failure_exclusion(self):
        self.run_text()
        key = next(iter(self.app.translation_cache))
        self.app.translation_cache[key] = (0, 'expired')
        self.assertFalse(self.run_text()['cached'])
        for i in range(35): self.run_text(str(i))
        self.assertEqual(len(self.app.translation_cache), 32)
        before = len(self.app.translation_cache)
        for parts in [[], [{'message':{'content':''},'done':True}], [{'message':{'content':'partial'},'done':True,'done_reason':'length'}]]:
            self.parts = parts
            self.assertEqual(self.run_text('broken')['stage'], 'failed')
            self.assertEqual(len(self.app.translation_cache), before)

    def test_resume_rejects_a_changed_model_digest_before_generation(self):
        identity = self.run_text()['modelIdentity']
        self.revision = 'new-model-under-same-name'
        identifier = uuid.uuid4().hex
        self.app.start_inference(identifier,'local',{'kind':'translate','text':'next chunk','expectedModelIdentity':identity})
        result = wait_for(lambda:self.app.inference_jobs.get(identifier,'local'))
        self.assertEqual(result['error'],'MODEL_CHANGED')
        self.assertEqual(len(self.calls),1)

    def test_cancellation_waits_for_transport_cleanup_before_releasing_channel(self):
        entered, cancelled, close_gate = threading.Event(), threading.Event(), threading.Event()
        class Slow:
            def __init__(self, op): pass
            def events(self, payload):
                entered.set(); cancelled.wait(2)
                yield {'message':{'content':'late'},'done':True}
            def cancel(self): cancelled.set()
            def close(self): close_gate.wait(2)
        self.app.managed_stream = Slow
        identifier = uuid.uuid4().hex
        self.app.start_inference(identifier, 'local', {'kind':'translate','text':'test'})
        try:
            self.assertTrue(entered.wait(1))
            self.assertEqual(self.app.inference_jobs.cancel(identifier,'local')['stage'], 'cancelling')
            self.assertTrue(cancelled.wait(1))
            self.assertFalse(self.app.inference.acquire(blocking=False))
            close_gate.set()
            state = wait_for(lambda:self.app.inference_jobs.get(identifier,'local'))
            self.assertEqual(state['stage'], 'cancelled')
            self.assertNotEqual(state.get('text'), 'late')
            self.assertFalse(self.app.translation_cache)
            self.assertTrue(self.app.inference.acquire(blocking=False)); self.app.inference.release()
        finally: cancelled.set();close_gate.set()

    def test_queued_cancel_never_runs_model_and_cancel_before_create_is_retained(self):
        jobs = self.app.inference_jobs
        self.app.inference.acquire()
        identifier = uuid.uuid4().hex
        try:
            jobs.start(identifier,'local',lambda op:self.fail('Cancelled queued work ran'))
            jobs.cancel(identifier,'local')
            self.assertEqual(wait_for(lambda:jobs.get(identifier,'local'))['stage'],'cancelled')
        finally: self.app.inference.release()
        identifier = uuid.uuid4().hex
        jobs.cancel(identifier,'local')
        self.assertEqual(jobs.start(identifier,'local',lambda op:self.fail('Creation raced cancellation'))['stage'],'cancelled')
        with self.assertRaises(InferenceError): jobs.get(identifier,'another-owner')

    def test_deadline_stops_running_work_and_bounds_queue(self):
        jobs = InferenceJobs(threading.Semaphore(1),timeout=.08,active_limit=1)
        gate = threading.Event()
        class Transport:
            def cancel(self): gate.set()
            def close(self): pass
        def work(op):
            op.transport=Transport();gate.wait(1);op.check()
        jobs.start('one','local',work)
        with self.assertRaises(InferenceError): jobs.start('two','local',work)
        state = wait_for(lambda:jobs.get('one','local'))
        self.assertEqual((state['stage'],state['error']),('failed','TIMEOUT'))
        self.assertTrue(jobs.semaphore.acquire(blocking=False));jobs.semaphore.release()

    def test_http_authentication_owner_and_settings_invalidate_cache(self):
        self.run_text()
        server=make_server(self.app,0)
        worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        def request(path, body=None, method=None, origin='chrome-extension://'+'a'*32, token=None):
            req=urllib.request.Request(f'http://127.0.0.1:{server.server_port}'+path,
                data=None if body is None else json.dumps(body).encode(),method=method,
                headers={'Authorization':'Bearer '+(token or self.app.config['token']),'Origin':origin,'Content-Type':'application/json'})
            with opener.open(req,timeout=3) as response:return json.load(response)
        try:
            identifier=uuid.uuid4().hex
            with self.assertRaises(urllib.error.HTTPError) as denied:
                request('/inference/'+identifier,method='DELETE',token='wrong')
            self.assertEqual(denied.exception.code,401)
            self.assertEqual(request('/inference/'+identifier,method='DELETE')['stage'],'cancelled')
            with self.assertRaises(urllib.error.HTTPError) as other:
                request('/inference/'+identifier,origin='chrome-extension://'+'b'*32)
            self.assertEqual(other.exception.code,404)
            request('/settings',{'model':'local:test'})
            self.assertFalse(self.app.translation_cache)
            self.assertEqual(self.app.translation_cache_generation,1)
        finally: server.shutdown();server.server_close();worker.join()

    def test_socket_cancel_interrupts_wait_before_first_token_and_next_job_can_run(self):
        entered, disconnected = threading.Event(), threading.Event()
        after_headers = [False]
        class ModelHandler(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_POST(self):
                self.rfile.read(int(self.headers['Content-Length']))
                if after_headers[0]:
                    self.send_response(200);self.send_header('Content-Type','application/x-ndjson');self.end_headers()
                    self.wfile.write(b'{"message":{"content":"partial"}}\n');self.wfile.flush()
                entered.set()
                self.connection.settimeout(3)
                if self.connection.recv(1) == b'': disconnected.set()
        server=ThreadingHTTPServer(('127.0.0.1',0),ModelHandler)
        worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
        import http.client
        connection=http.client.HTTPConnection
        self.app.managed_stream=ModelStream
        try:
            with patch('inference.http.client.HTTPConnection',side_effect=lambda host,port,timeout:connection(host,server.server_port,timeout=timeout)):
                for partial in (False,True):
                    after_headers[0]=partial;entered.clear();disconnected.clear()
                    identifier=uuid.uuid4().hex
                    self.app.start_inference(identifier,'local',{'kind':'translate','text':'socket test'})
                    self.assertTrue(entered.wait(2))
                    if partial:wait_for(lambda:self.app.inference_jobs.get(identifier,'local'),lambda state:state['stage']=='generating')
                    started=time.monotonic()
                    self.app.inference_jobs.cancel(identifier,'local')
                    result=wait_for(lambda:self.app.inference_jobs.get(identifier,'local'))
                    self.assertEqual(result['stage'],'cancelled')
                    self.assertLess(time.monotonic()-started,1)
                    self.assertTrue(disconnected.wait(1))
                    self.assertTrue(self.app.inference.acquire(blocking=False));self.app.inference.release()
        finally: server.shutdown();server.server_close();worker.join()

    def test_frontend_and_managed_backend_share_three_minute_budget(self):
        client=(Path(__file__).resolve().parents[1]/'extension/local-client.js').read_text(encoding='utf-8')
        self.assertIn(f'TIMEOUT_MS: {TIMEOUT_SECONDS*1000}',client)

    def test_terminal_record_survives_client_polling_budget(self):
        result=self.run_text()
        op=self.app.inference_jobs.jobs[result['id']]
        with patch('inference.time.monotonic',return_value=op.finished+61):
            self.assertEqual(self.app.inference_jobs.get(op.id,'local')['stage'],'done')
        with patch('inference.time.monotonic',return_value=op.finished+TIMEOUT_SECONDS+1):
            with self.assertRaises(InferenceError):self.app.inference_jobs.get(op.id,'local')

    def test_http_extension_identity_survives_missing_get_origin_without_weakening_auth(self):
        server=make_server(self.app,0);worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        identifier=uuid.uuid4().hex
        def request(method,origin=None,client='a'*32,token=None):
            headers={'Authorization':'Bearer '+(token or self.app.config['token']),'Content-Type':'application/json','X-QingRead-Client':client}
            if origin:headers['Origin']=origin
            data=json.dumps({'kind':'summarize','text':'Synthetic source'}).encode() if method=='POST' else None
            req=urllib.request.Request(f'http://127.0.0.1:{server.server_port}/inference/{identifier}',data=data,method=method,headers=headers)
            with opener.open(req,timeout=3) as response:return json.load(response)
        try:
            request('POST','chrome-extension://'+'a'*32)
            self.assertEqual(wait_for(lambda:request('GET'))['stage'],'done')
            self.assertEqual(request('DELETE')['stage'],'done')
            for args,status in [({'client':'b'*32},404),({'origin':'chrome-extension://'+'b'*32},403),({'client':'invalid'},400),({'token':'wrong'},401),({'origin':'https://website.test'},403)]:
                with self.subTest(args=args):
                    with self.assertRaises(urllib.error.HTTPError) as error:request('GET',**args)
                    self.assertEqual(error.exception.code,status)
        finally:server.shutdown();server.server_close();worker.join()


if __name__ == '__main__': unittest.main()
