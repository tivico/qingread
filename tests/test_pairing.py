import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
from app import Companion, make_server
from pairing import Pairing

ORIGIN = 'chrome-extension://' + 'a' * 32
NONCE = 'b' * 64


class PairingTest(unittest.TestCase):
    def setUp(self):
        self.release = threading.Event()
        self.now = 100
        self.approval = True
        def confirm(origin, code, cancel):
            self.release.wait(2)
            return self.approval
        self.pairing = Pairing(confirm=confirm, clock=lambda: self.now)

    def tearDown(self):
        self.release.set()

    def finish(self):
        self.release.set()
        deadline = time.monotonic()+2
        while self.pairing.dialog_active and time.monotonic()<deadline:
            time.sleep(.005)
        self.assertFalse(self.pairing.dialog_active)

    def test_requires_approval_and_binds_origin_and_secret(self):
        request = self.pairing.start(ORIGIN, NONCE)
        self.assertNotIn('token',request)
        self.assertEqual(self.pairing.poll(ORIGIN,request['id'],NONCE)['state'],'pending')
        self.assertIsNone(self.pairing.poll('chrome-extension://'+'c'*32,request['id'],NONCE))
        self.assertIsNone(self.pairing.poll(ORIGIN,request['id'],'c'*64))
        self.finish()
        self.assertEqual(self.pairing.poll(ORIGIN,request['id'],NONCE)['state'],'approved')
        self.assertIsNone(self.pairing.poll(ORIGIN,request['id'],NONCE))

    def test_deny_expiry_and_cancel_never_approve(self):
        for operation in ['deny','expire','cancel']:
            with self.subTest(operation=operation):
                self.setUp()
                request = self.pairing.start(ORIGIN,NONCE)
                if operation=='deny': self.approval=False
                if operation=='expire': self.now=221
                if operation=='cancel':
                    self.assertEqual(self.pairing.poll(ORIGIN,request['id'],NONCE,True)['state'],'cancelled')
                self.finish()
                result=self.pairing.poll(ORIGIN,request['id'],NONCE)
                if operation=='cancel': self.assertIsNone(result)
                else:self.assertEqual(result['state'],'denied' if operation=='deny' else 'expired')

    def test_duplicate_and_rapid_requests_do_not_spawn_more_dialogs(self):
        self.pairing.start(ORIGIN,NONCE)
        self.assertIsNone(self.pairing.start(ORIGIN,NONCE))
        self.finish()
        self.assertIsNone(self.pairing.start(ORIGIN,NONCE))
        self.now=111
        self.assertIsNotNone(self.pairing.start(ORIGIN,NONCE))

    def test_dialog_failure_is_explicit(self):
        def broken(*args):raise RuntimeError('no desktop')
        self.pairing.confirm=broken
        request=self.pairing.start(ORIGIN,NONCE)
        self.finish()
        self.assertEqual(self.pairing.poll(ORIGIN,request['id'],NONCE)['state'],'unavailable')

    def test_http_pairing_rejects_websites_and_delivers_only_once(self):
        with tempfile.TemporaryDirectory() as directory:
            app=Companion(directory)
            app.pairing=self.pairing
            server=make_server(app,0)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
            def request(route,body,origin=ORIGIN,headers=None):
                h={'Content-Type':'application/json',**(headers or {})}
                if origin is not None:h['Origin']=origin
                req=urllib.request.Request(f'http://127.0.0.1:{server.server_port}'+route,data=json.dumps(body).encode(),headers=h)
                try:
                    with opener.open(req,timeout=3) as r:return r.status,json.load(r)
                except urllib.error.HTTPError as e:
                    with e:return e.code,json.load(e)
            try:
                for origin in [None,'null','https://evil.test']:
                    self.assertEqual(request('/pair/start',{'nonce':NONCE},origin)[0],403)
                self.assertEqual(request('/pair/start',{'nonce':NONCE},headers={'Host':'evil.test'})[0],403)
                self.assertEqual(request('/pair/start',{'nonce':[]})[0],400)
                status,started=request('/pair/start',{'nonce':NONCE});self.assertEqual(status,202)
                body={'id':started['id'],'nonce':NONCE}
                self.assertEqual(request('/pair/status',body)[1],{'state':'pending'})
                self.assertEqual(request('/pair/status',{**body,'nonce':'c'*64})[0],404)
                self.assertEqual(request('/summarize',{'text':'test'})[0],401)
                self.finish()
                status,result=request('/pair/status',body)
                self.assertEqual(status,200);self.assertEqual(result['state'],'approved')
                self.assertTrue(result['token']==app.config['token'])
                self.assertEqual(request('/pair/status',body)[0],404)
            finally:server.shutdown();server.server_close();thread.join()


if __name__=='__main__':unittest.main()
