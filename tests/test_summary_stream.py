import sys
from pathlib import Path
import tempfile
import unittest
import threading
import json
import urllib.request

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'companion'))
from app import Companion, UserError, make_server


class SummaryStreamTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.calls=[]
        self.selected='local:test'
        def request(route,payload=None,timeout=None):
            if route=='/api/tags':return {'models':[{'name':self.selected}]}
            if route=='/api/show':return {}
            self.calls.append(payload)
            return {'message':{'content':'摘要'}}
        self.events=[{'message':{'content':'第一點。'}},{'message':{'content':'第二點。'},'done':True,'done_reason':'stop'}]
        def stream(payload):
            self.calls.append(payload)
            yield from self.events
        self.app=Companion(self.temp.name,request,stream)
        self.app.config['model']=self.selected

    def tearDown(self):self.temp.cleanup()

    def test_progress_precedes_completion_and_summary_budget_does_not_change_translation(self):
        events=list(self.app.stream_summary('原文'))
        self.assertEqual(events[0]['stage'],'reading')
        self.assertEqual(events[1]['text'],'第一點。')
        self.assertEqual(events[-1]['text'],'第一點。第二點。')
        self.assertTrue(events[-1]['done'])
        self.assertEqual(self.calls[0]['options']['num_predict'],512)
        self.app.translate('hello')
        self.assertEqual(self.calls[-1]['options']['num_predict'],4096)

    def test_cache_matches_content_and_model_and_is_bounded(self):
        list(self.app.stream_summary('原文'))
        self.assertTrue(list(self.app.stream_summary('原文'))[-1]['cached'])
        self.assertEqual(len(self.calls),1)
        list(self.app.stream_summary('改過原文'))
        self.selected='local:other';self.app.config['model']=self.selected
        list(self.app.stream_summary('原文'))
        self.assertEqual(len(self.calls),3)
        for i in range(10):list(self.app.stream_summary(str(i)))
        self.assertEqual(len(self.app.summary_cache),8)
        key=next(iter(self.app.summary_cache))
        self.app.summary_cache[key]=(0,'expired')
        self.assertFalse(list(self.app.stream_summary('2'))[-1]['cached'])

    def test_truncation_is_explicit_and_never_cached(self):
        self.events[-1]['done_reason']='length'
        event=list(self.app.stream_summary('原文'))[-1]
        self.assertTrue(event['truncated'])
        self.assertFalse(self.app.summary_cache)

    def test_interrupted_stream_and_early_close_release_model_lock(self):
        self.events=self.events[:1]
        with self.assertRaises(UserError):list(self.app.stream_summary('原文'))
        self.assertTrue(self.app.inference.acquire(blocking=False));self.app.inference.release()
        events=self.app.stream_summary('原文');next(events);events.close()
        self.assertTrue(self.app.inference.acquire(blocking=False));self.app.inference.release()

    def test_busy_fails_immediately_and_split_thinking_is_never_visible(self):
        self.app.inference.acquire()
        with self.assertRaises(UserError) as error:next(self.app.stream_summary('原文'))
        self.assertEqual(error.exception.code,'MODEL_BUSY');self.app.inference.release()
        self.events=[{'message':{'content':part}} for part in ['<thi','nk>secret',' thoughts</think>','重點。']]
        self.events.append({'done':True,'message':{'content':''}})
        events=list(self.app.stream_summary('原文'))
        self.assertEqual(events[-1]['text'],'重點。')
        self.assertFalse(any('secret' in e.get('text','') or '<thi' in e.get('text','') for e in events))

    def test_http_sends_progress_before_model_finishes_and_labels_midstream_failure(self):
        released=threading.Event()
        def slow(payload):
            yield {'message':{'content':'第一點。'}}
            released.wait(3)
            raise UserError('MODEL_UNAVAILABLE','模型已中斷。',503)
        self.app.model_stream=slow
        server=make_server(self.app,0)
        worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
        request=urllib.request.Request(f'http://127.0.0.1:{server.server_port}/summarize',
            data=json.dumps({'text':'原文'}).encode(),headers={'Authorization':'Bearer '+self.app.config['token'],
                'Content-Type':'application/json','Accept':'application/x-ndjson'})
        try:
            with opener.open(request,timeout=5) as response:
                self.assertEqual(response.status,200)
                self.assertEqual(json.loads(response.readline())['stage'],'reading')
                self.assertEqual(json.loads(response.readline())['text'],'第一點。')
                self.assertFalse(released.is_set())
                released.set()
                self.assertEqual(json.loads(response.readline())['error'],'MODEL_UNAVAILABLE')
                self.assertEqual(response.read(),b'')
        finally:
            released.set();server.shutdown();server.server_close();worker.join()


if __name__=='__main__':unittest.main()
