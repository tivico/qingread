// Real unpacked extension + isolated helper. Artificial transcript; opt-in real local model.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
(async()=>{
 const root=path.resolve(__dirname,'..'),results=path.join(root,'test-results');fs.mkdirSync(results,{recursive:true});
 const temp=fs.mkdtempSync(path.join(results,'video-summary-smoke-')),extension=path.join(temp,'extension');
 fs.cpSync(path.join(root,'extension'),extension,{recursive:true});
 const manifest=JSON.parse(fs.readFileSync(path.join(extension,'manifest.json'),'utf8'));
 manifest.host_permissions=['http://127.0.0.1/*'];fs.writeFileSync(path.join(extension,'manifest.json'),JSON.stringify(manifest));
 const live=process.argv.includes('--live-model'),urlIndex=process.argv.indexOf('--url'),publicUrl=urlIndex>=0?process.argv[urlIndex+1]:null;
 if(publicUrl){const parsed=new URL(publicUrl);assert.equal(parsed.origin,'https://www.youtube.com');assert.equal(parsed.pathname,'/watch');assert.match(parsed.searchParams.get('v')||'',/^[\w-]{11}$/);}
 const trace=[],metrics=[],report={liveModel:live,scope:publicUrl?'public YouTube page; isolated helper/profile; production configuration unchanged':'artificial transcript; isolated helper/profile; production configuration unchanged'};
 const helper=spawn(path.join(root,'companion/.venv/Scripts/python.exe'),[path.join(root,'tests/inference_fixture_server.py'),...(live?['--live-model']:[])],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 let context;let stderr='';helper.stderr.on('data',chunk=>stderr+=chunk);
 try{
  const port=await new Promise((resolve,reject)=>{
   let output='';const timer=setTimeout(()=>reject(new Error('Fixture did not start: '+stderr)),10000);
   helper.on('error',e=>{clearTimeout(timer);reject(e);});
   helper.stdout.on('data',chunk=>{output+=chunk;if(output.includes('\n')){clearTimeout(timer);try{resolve(JSON.parse(output.split('\n')[0]).port);}catch(e){reject(e);}}});
   helper.on('exit',()=>{clearTimeout(timer);reject(new Error('Fixture exited: '+stderr));});
  });
  context=await chromium.launchPersistentContext(path.join(temp,'profile'),{headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chromium'}),ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  await context.route('http://127.0.0.1:8765/**',async route=>{
   const req=route.request(),headers=await req.allHeaders(),forwarded={Authorization:'Bearer '+'a'.repeat(43),'Content-Type':'application/json'};
   if(headers.origin)forwarded.Origin=headers.origin;
   if(headers['x-qingread-client'])forwarded['X-QingRead-Client']=headers['x-qingread-client'];
   if(req.method()==='POST')trace.push(JSON.parse(req.postData()));
   const response=await fetch(`http://127.0.0.1:${port}${new URL(req.url()).pathname}`,{method:req.method(),headers:forwarded,...(req.postData()?{body:req.postData()}:{})});
   const body=await response.text();
   try{const value=JSON.parse(body);if(value.stage==='done')metrics.push({timings:value.timings,cached:value.cached,truncated:value.truncated,outputCharacters:value.text?.length});}catch{}
   await route.fulfill({status:response.status,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body});
  });
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:10000});
  const id=new URL(worker.url()).host,panel=await context.newPage();await panel.goto(`chrome-extension://${id}/panel.html`);
  await panel.evaluate(()=>chrome.storage.session.set({companionToken:'a'.repeat(43)}));
  const video=await context.newPage(),videoId='abcdefghijk',url=publicUrl||`https://www.youtube.com/watch?v=${videoId}`;
  const intro='This lesson explains how to protect project files. Keep the original document and verify backups before editing. The optional workshop costs NT$120 and lasts 30 minutes. ';
  const tail='Final conclusion: existing reservations remain valid. Only new reservations are paused. The reopening time is Monday at 09:00.';
  const html=`<!doctype html><meta charset="utf-8"><style>ytd-transcript-renderer,ytd-transcript-segment-renderer{display:block}</style><ytd-watch-flexy video-id="${videoId}"></ytd-watch-flexy><ytd-watch-metadata><h1>人工影片：檔案保護與預約</h1></ytd-watch-metadata><ytd-transcript-renderer><ytd-transcript-segment-renderer><span class="segment-timestamp">0:00</span><span class="segment-text">${intro.repeat(33)}</span></ytd-transcript-segment-renderer><ytd-transcript-segment-renderer><span class="segment-timestamp">10:00</span><span class="segment-text">${tail}</span></ytd-transcript-segment-renderer></ytd-transcript-renderer>`;
  if(!publicUrl)await video.route('https://www.youtube.com/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:html}));
  await video.goto(url);await video.bringToFront();
  const cdp=await context.browser().newBrowserCDPSession();
  const {targetInfos}=await cdp.send('Target.getTargets',{filter:[{type:'tab'}]});
  await cdp.send('Extensions.triggerAction',{id,targetId:targetInfos.find(t=>t.url===video.url()).targetId});
  const started=Date.now();
  await panel.evaluate(()=>{document.querySelector('[data-view=summary]').click();document.querySelector('#vs-start').click();});
  let lastStatus='',lastLog=0;
  while(Date.now()-started<570000){
    const progress=await panel.evaluate(()=>({done:document.querySelector('#vs-stop').disabled,status:document.querySelector('#vs-status').textContent}));
    if(progress.done)break;
    if(progress.status!==lastStatus && Date.now()-lastLog>10000){console.log(JSON.stringify({progress:progress.status}));lastStatus=progress.status;lastLog=Date.now();}
    await panel.waitForTimeout(1000);
  }
  const state=await panel.evaluate(()=>({status:document.querySelector('#vs-status').textContent,source:document.querySelector('#vs-source').textContent,
   overview:document.querySelector('#vs-overview').textContent,notes:[...document.querySelectorAll('#vs-notes article')].map(n=>n.textContent),links:[...document.querySelectorAll('#vs-notes a')].map(n=>n.href)}));
  report.seconds=(Date.now()-started)/1000;report.result=state;
  assert.match(state.status,/影片摘要已完成/);assert.ok(state.overview.trim());
  assert.match(state.overview,/\p{Script=Han}/u);
  assert.ok(state.notes.every(value=>/\p{Script=Han}/u.test(value)),'Every completed segment must contain Chinese summary text');
  if(!publicUrl){assert.equal(state.notes.length,2);assert.ok(trace.findLast(p=>p.summaryMode==='video-chunk').text.endsWith(tail));}
  assert.equal(trace.at(-1).summaryMode,'video-overview');assert.ok(trace.slice(1).every(p=>p.expectedModelIdentity));
  report.nativeInjection=true;report.tailIncluded=publicUrl?null:true;report.modelCalls=trace.length;report.metrics=metrics;
  if(publicUrl)fs.writeFileSync(path.join(results,'video-summary-inputs.json'),JSON.stringify({chunks:trace.filter(value=>value.summaryMode==='video-chunk')},null,2));
  if(publicUrl)report.publicUrl=publicUrl;
  await panel.screenshot({path:path.join(results,publicUrl?'video-summary-youtube.png':live?'video-summary-native-live.png':'video-summary-native.png'),fullPage:true});
  console.log(JSON.stringify(report));
 }catch(error){report.error=error.message;throw error;}
 finally{fs.writeFileSync(path.join(results,publicUrl?'video-summary-youtube.json':live?'video-summary-native-live.json':'video-summary-native.json'),JSON.stringify(report,null,2));await context?.close();helper.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
