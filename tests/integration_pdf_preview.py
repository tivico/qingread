"""Opt-in real BabelDOC preview on synthetic pages with an isolated helper."""
import json,re,sys,tempfile,threading,time
from pathlib import Path
from unittest.mock import patch
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT/'companion'))
import app as module
import pymupdf
if '--live' not in sys.argv:raise SystemExit('Use --live with existing local model and PDF assets')
assets=ROOT/'companion/data/assets'
if not (assets/'ready.json').exists():raise SystemExit('PDF assets are not prepared')
selected=json.loads((ROOT/'companion/data/config.json').read_text(encoding='utf-8')).get('model')
with tempfile.TemporaryDirectory(dir=ROOT/'test-results') as directory:
    helper=module.Companion(directory);helper.config['model']=selected
    (helper.data/'assets').mkdir();(helper.data/'assets/ready.json').write_text('{}')
    server=module.make_server(helper,0);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    with pymupdf.open() as doc:
        for number in range(3):
            page=doc.new_page();page.insert_text((60,50),f'Synthetic page {number+1}',fontsize=18)
            for line in range(24):
                page.insert_text((60,85+line*25),'Keep the original document. The total cost is 25 dollars.',fontsize=13)
        raw=doc.tobytes()
    original=module.subprocess.Popen
    def worker(*args,**kwargs):
        kwargs['env']={**kwargs['env'],'QINGREAD_ASSETS':str(assets)}
        return original(*args,**kwargs)
    report={'model':selected,'inputPages':3,'scope':'synthetic PDF; isolated jobs and helper; existing assets reused; production settings unchanged'}
    try:
        with patch.object(module,'PORT',server.server_port),patch.object(module.subprocess,'Popen',side_effect=worker):
            job=helper.start_pdf(raw,'en',preview=True);started=time.monotonic();phases=[]
            while time.monotonic()-started<240:
                current=helper.public_job(helper.get_job(job['id']))
                if current.get('phase') not in phases:phases.append(current.get('phase'));print(json.dumps({'phase':current.get('phase')}),flush=True)
                if current['state'] in {'done','failed','cancelled'}:break
                time.sleep(.1)
            if current['state']!='done':raise RuntimeError(current['message'])
            report.update(seconds=round(time.monotonic()-started,3),phases=phases,preview=job['preview'],outputPages=[],hanCharacters=0)
            for output in current['outputs']:
                with pymupdf.open(helper.jobs_root/job['id']/'output'/output['name']) as doc:
                    report['outputPages'].append(len(doc))
                    text=''.join(page.get_text() for page in doc)
                    report['hanCharacters']+=len(re.findall(r'[\u4e00-\u9fff]',text))
                    if re.search(r'[\u4e00-\u9fff]',doc[0].get_text()):doc[0].get_pixmap(matrix=pymupdf.Matrix(1,1)).save(str(ROOT/'test-results/pdf-preview-page.png'))
            # A bilingual PDF may interleave 2 source and 2 translated pages.
            if not report['outputPages'] or any(count not in (2,4) for count in report['outputPages']):raise RuntimeError('Unexpected preview page count')
            if not report['hanCharacters']:raise RuntimeError('Preview contains no extracted Chinese text')
            second=helper.start_pdf(raw,'en',preview=True)
            deadline=time.monotonic()+5
            while helper.get_job(second['id'])['process'] is None and time.monotonic()<deadline:time.sleep(.01)
            started=time.monotonic();helper.delete_job(second['id'])
            while time.monotonic()-started<15:
                cancelled=helper.get_job(second['id'])
                if cancelled['state'] not in ('queued','running'):break
                time.sleep(.02)
            if cancelled['state']!='cancelled' or cancelled['process'] is not None:raise RuntimeError('Worker cancellation not confirmed')
            report['startupCancellationSeconds']=round(time.monotonic()-started,3)
    finally:
        for current in list(helper.jobs.values()):
            if current['state'] in ('queued','running'):current['cancel'].set()
        deadline=time.monotonic()+15
        while any(j['process'] is not None for j in helper.jobs.values()) and time.monotonic()<deadline:time.sleep(.1)
        server.shutdown();server.server_close();thread.join()
    (ROOT/'test-results/pdf-preview-integration.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(json.dumps(report),flush=True)
