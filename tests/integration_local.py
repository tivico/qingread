"""Opt-in real local model/PDF test. Uses synthetic text and an existing model."""
from pathlib import Path
import json,sys,threading,time
root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'companion'))
from app import Companion,make_server
app=Companion(root/'companion'/'data')
models=app.models()
model=next((m for m in models if 'Breeze2' in m), models[0])
app.config['model']=model;app.save_config()
start=time.monotonic()
result=app.translate('Do not delete the backup. The total cost is USD 1,250.50.')
print(json.dumps({'model':model,'text':result['text'],'seconds':round(time.monotonic()-start,2)},ensure_ascii=False),flush=True)
if '--pdf' in sys.argv:
    server=make_server(app);threading.Thread(target=server.serve_forever,daemon=True).start()
    try:
        raw=(root/'tmp'/'pdfs'/'sample.pdf').read_bytes()
        if '--scan' in sys.argv:
            import pymupdf
            with pymupdf.open(stream=raw,filetype='pdf') as original:
                bitmap=original[0].get_pixmap(matrix=pymupdf.Matrix(2,2)).tobytes('png')
                with pymupdf.open() as scan:
                    page=scan.new_page(width=595,height=842);page.insert_image(page.rect,stream=bitmap);raw=scan.tobytes()
        job=app.start_pdf(raw,'en',scanned='--scan' in sys.argv)
        print('PDF job '+job['id'],flush=True)
        deadline=time.monotonic()+600
        while time.monotonic()<deadline:
            current=app.get_job(job['id'])
            if current['state'] not in {'running','queued'}:break
            time.sleep(2)
        else:app.delete_job(job['id']);raise RuntimeError('PDF exceeded test deadline')
        print(json.dumps(app.public_job(current),ensure_ascii=False),flush=True)
        if current['state']!='done':raise RuntimeError('PDF integration failed')
        import pymupdf
        output=root/'test-results';output.mkdir(exist_ok=True)
        for file in current['outputs']:
            pdf=app.jobs_root/job['id']/'output'/file['name']
            with pymupdf.open(pdf) as document:
                print(json.dumps({'output':file['name'],'pages':len(document),'text':document[0].get_text()[:2000]},ensure_ascii=False),flush=True)
                document[0].get_pixmap(matrix=pymupdf.Matrix(1.4,1.4)).save(str(output/(file['name']+'.png')))
    finally:server.shutdown();server.server_close()
