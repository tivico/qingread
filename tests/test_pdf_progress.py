import asyncio,io,json,sys,tempfile,threading,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'companion'))
from app import Companion,UserError
from pdf_progress import event_phase,write_progress,track_events

class PdfProgressTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        def model(route,payload=None,timeout=None):return {'models':[{'name':'local:test'}]} if route=='/api/tags' else {}
        self.app=Companion(self.temp.name,model);self.app.config['model']='local:test'
        (self.app.data/'assets').mkdir();(self.app.data/'assets/ready.json').write_text('{}')
    def tearDown(self):self.temp.cleanup()
    def pdf(self,pages=3,text=True):
        import pymupdf
        with pymupdf.open() as doc:
            for i in range(pages):
                page=doc.new_page()
                if text or i>=2:page.insert_text((60,60),'Synthetic page '+str(i+1))
            return doc.tobytes()
    def test_preview_physically_limits_input_and_metadata_even_with_other_page_selection(self):
        import pymupdf
        with patch('app.threading.Thread'):
            job=self.app.start_pdf(self.pdf(),'en','3',preview=True)
        with pymupdf.open(self.app.jobs_root/job['id']/'input.pdf') as doc:self.assertEqual(len(doc),2)
        self.assertTrue(job['preview']);self.assertEqual(job['page_count'],3);self.assertEqual(job['selected_pages'],'1-2')
        self.assertEqual(job['phase'],'queued')
    def test_one_page_preview_and_scanned_preview_cannot_run_beyond_two_pages(self):
        import pymupdf
        for count,scanned in [(1,False),(3,True)]:
            with patch('app.threading.Thread'):
                job=self.app.start_pdf(self.pdf(count,text=not scanned),'en',scanned=scanned,preview=True)
            with pymupdf.open(self.app.jobs_root/job['id']/'input.pdf') as doc:self.assertEqual(len(doc),min(2,count))
            self.app.jobs[job['id']]['state']='cancelled'
    def test_text_on_later_pages_does_not_hide_image_only_preview(self):
        with self.assertRaises(UserError) as error:self.app.start_pdf(self.pdf(text=False),'en',preview=True)
        self.assertEqual(error.exception.code,'PDF_SCAN')
    def test_coarse_progress_never_contains_raw_stage_text_and_tracks_finish(self):
        directory=Path(self.temp.name)
        async def events():
            yield {'type':'progress_update','stage':'Translate Paragraphs','stage_current':1,'stage_total':3,'secret':'private source'}
            yield {'type':'finish','translate_result':'private file path'}
        state={}
        async def consume():return [event async for event in track_events(events(),directory,state)]
        self.assertEqual(len(asyncio.run(consume())),2);self.assertTrue(state['finished'])
        value=json.loads((directory/'progress.json').read_text())
        self.assertEqual(value,{'phase':'translation','current':1,'total':3})
        for stage,phase in [('Parse Page Layout','analysis'),('Typesetting','output'),('Save PDF','output'),('unknown private string','processing')]:self.assertEqual(event_phase(stage),phase)
        write_progress(directory,'ocr',-1,5)
        self.assertEqual(json.loads((directory/'progress.json').read_text()),{'phase':'ocr'})
    def test_engine_error_is_never_treated_as_finish(self):
        async def events():yield {'type':'error','error':'Scanned PDF detected.'}
        state={}
        async def consume():return [item async for item in track_events(events(),self.temp.name,state)]
        asyncio.run(consume())
        self.assertTrue(state['error']);self.assertFalse(state.get('finished',False));self.assertEqual(state['error_code'],'PDF_SCAN_DETECTED')
    def test_cancel_stays_running_until_worker_exits_and_progress_cannot_overwrite_cancel(self):
        job,directory=self.app.new_job('pdf');job.update(state='running',phase='translation')
        (directory/'options.json').write_text('{}')
        self.assertTrue(self.app.delete_job(job['id'])['cancelling'])
        self.assertEqual(job['state'],'running');self.assertEqual(job['phase'],'cancelling')
        self.app.run_pdf(job,directory)
        self.assertEqual(job['state'],'cancelled');self.assertEqual(job['phase'],'cancelled')
    def test_parent_reads_only_whitelisted_phase_and_numeric_counts(self):
        job,directory=self.app.new_job('pdf');(directory/'options.json').write_text('{}')
        write_progress(directory,'ocr',1,2)
        class Process:
            returncode=1
            def __init__(self):self.calls=0
            def poll(self):self.calls+=1;return None if self.calls==1 else 1
        seen=[]
        def wait(_seconds):seen.append(self.app.public_job(job));return False
        with patch('app.subprocess.Popen',return_value=Process()),patch.object(job['cancel'],'wait',side_effect=wait):self.app.run_pdf(job,directory)
        self.assertEqual((seen[0]['phase'],seen[0]['current'],seen[0]['total']),('ocr',1,2))
        self.assertEqual(job['phase'],'failed');self.assertNotIn('current',job)

if __name__=='__main__':unittest.main()
