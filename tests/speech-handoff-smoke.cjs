// Real tab audio, panel rollback, offscreen handoff and HTTP transport.
// The video/audio and speech/translation answers are artificial fixtures.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
(async()=>{
 const root=path.resolve(__dirname,'..'),results=path.join(root,'test-results');fs.mkdirSync(results,{recursive:true});
 const temporary=fs.mkdtempSync(path.join(results,'speech-handoff-')),extension=path.join(temporary,'extension');
 const soakIndex=process.argv.indexOf('--soak-minutes'),soakMinutes=soakIndex<0?0:Number(process.argv[soakIndex+1]);
 if(!Number.isFinite(soakMinutes)||soakMinutes<0||soakMinutes>60)throw new Error('Invalid soak duration');
 const report={checks:[],artificialContent:true,permissionDialogTested:false,soakMinutes,samples:[]};let context,panel;
 const helper=spawn(path.join(root,'companion/.venv/Scripts/python.exe'),[path.join(root,'tests/inference_fixture_server.py'),'--synthetic-speech'],{windowsHide:true,stdio:['ignore','pipe','ignore']});
 try{
  const port=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>reject(new Error('Helper timeout')),10000);helper.once('error',reject);helper.stdout.on('data',chunk=>{output+=chunk;if(output.includes('\n')){clearTimeout(timer);resolve(JSON.parse(output.split('\n')[0]).port);}});});
  fs.cpSync(path.join(root,'extension'),extension,{recursive:true});
  const manifestPath=path.join(extension,'manifest.json'),manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  manifest.permissions.push('tabCapture');manifest.optional_permissions=manifest.optional_permissions.filter(p=>p!=='tabCapture');
  manifest.host_permissions=['http://127.0.0.1/*'];fs.writeFileSync(manifestPath,JSON.stringify(manifest));
  for(const name of ['manifest.json','local-client.js']){const file=path.join(extension,name);fs.writeFileSync(file,fs.readFileSync(file,'utf8').replaceAll('127.0.0.1:8765',`127.0.0.1:${port}`));}
  context=await chromium.launchPersistentContext(path.join(temporary,'profile'),{headless:true,
   ...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chromium'}),
   ignoreDefaultArgs:['--disable-extensions','--mute-audio'],args:['--enable-unsafe-extension-debugging',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),id=new URL(worker.url()).host;
  panel=await context.newPage();await panel.goto(`chrome-extension://${id}/panel.html`);
  const source=await context.newPage();await source.route('https://speech.test/**',r=>r.fulfill({contentType:'text/html',body:`<!doctype html><style>video{width:900px;height:500px}#movie_player{position:relative;width:900px;height:560px}</style><div id="movie_player"><video></video><button id="play">Play artificial video</button><button id="fullscreen">Fullscreen</button></div><script>
   document.querySelector('#fullscreen').onclick=()=>document.querySelector('#movie_player').requestFullscreen();
   document.querySelector('#play').onclick=async()=>{
    const canvas=document.createElement('canvas');canvas.width=900;canvas.height=500;const drawing=canvas.getContext('2d');
    setInterval(()=>{drawing.fillStyle='#27453f';drawing.fillRect(0,0,900,500);drawing.fillStyle='white';drawing.font='24px sans-serif';drawing.fillText('Artificial speech handoff fixture',40,100);},100);
    window.audio=new AudioContext();const tone=audio.createOscillator(),gain=audio.createGain(),output=audio.createMediaStreamDestination();gain.gain.value=.01;tone.connect(gain);gain.connect(output);tone.start();
    const stream=canvas.captureStream(5);stream.addTrack(output.stream.getAudioTracks()[0]);const video=document.querySelector('video');video.srcObject=stream;await audio.resume();await video.play();
   };</script>`}));
  await source.goto('https://speech.test/');await source.locator('#play').click();
  const cdp=await context.browser().newBrowserCDPSession();const {targetInfos}=await cdp.send('Target.getTargets',{filter:[{type:'tab'}]});
  await cdp.send('Extensions.triggerAction',{id,targetId:targetInfos.find(t=>t.url===source.url()).targetId});
  const tabId=await panel.evaluate(async()=>(await activeTab()).id);
  await worker.evaluate(tabId=>chrome.scripting.executeScript({target:{tabId},func:()=>{const attach=Element.prototype.attachShadow;globalThis.shadows=new Map();Element.prototype.attachShadow=function(options){const shadow=attach.call(this,options);shadows.set(this,shadow);return shadow;};}}),tabId);
  const read=()=>worker.evaluate(async tabId=>(await chrome.scripting.executeScript({target:{tabId},func:()=>globalThis.shadows.get(document.querySelector('[data-qingread-media]'))?.textContent}))[0].result,tabId);
  const waitText=async(previous)=>{const deadline=Date.now()+30000;let text;while(!(text=await read())||!text.includes('Artificial speech segment')||text===previous){if(Date.now()>deadline)throw new Error('No updated artificial speech caption');await new Promise(r=>setTimeout(r,200));}return text;};
  await panel.evaluate(async()=>{await chrome.storage.session.set({companionToken:'a'.repeat(43)});document.querySelector('#engine').value='local';document.querySelector('#engine').dispatchEvent(new Event('change'));document.querySelector('[data-view=video]').click();document.querySelector('#video-mode').value='speech';});
  await panel.waitForFunction(()=>!document.querySelector('#video-start').disabled);
  await panel.evaluate(()=>document.querySelector('#video-start').click());
  let previous=await waitText();report.checks.push('real tab audio reaches HTTP speech recognition and recovers from one SPEECH_BUSY reply');
  await worker.evaluate(()=>{const original=globalThis.captureTabAudio;globalThis.captureTabAudio=async target=>{if(target.waitForRelease&&!globalThis.injectedFailure){globalThis.injectedFailure=true;throw new Error('人工測試：背景音訊取得失敗');}return original(target);};});
  await panel.evaluate(()=>document.querySelector('#video-collapse').click());
  await panel.waitForFunction(()=>document.querySelector('#video-background-status').textContent.includes('已恢復側欄'),null,{timeout:15000});
  previous=await waitText(previous);report.checks.push('forced background capture failure restores live side-panel audio and subsequent subtitles');
  await panel.evaluate(()=>document.querySelector('#video-collapse').click());
  await panel.waitForFunction(()=>document.querySelector('#video-background-status').textContent.includes('背景已接手'),null,{timeout:15000});
  await panel.close();panel=null;await source.locator('#fullscreen').click();
  previous=await waitText(previous);report.checks.push('second handoff succeeds and subsequent speech captions survive panel destruction and fullscreen');
  const deadline=Date.now()+soakMinutes*60000,started=Date.now();
  while(Date.now()<deadline){
   await new Promise(r=>setTimeout(r,Math.min(10000,deadline-Date.now())));
   const state=await worker.evaluate(async()=>{
    const contexts=await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']});
    const captures=await chrome.tabCapture.getCapturedTabs();
    return {offscreen:contexts.length,activeCaptures:captures.filter(t=>t.status==='active').length};
   });
   assert.equal(state.offscreen,1);assert.equal(state.activeCaptures,1);
   const text=await read();assert.ok(text?.includes('Artificial speech segment'));assert.notEqual(text,previous);previous=text;
   report.samples.push({elapsedMs:Date.now()-started,...state});
   if(report.samples.length%6===0)console.log(JSON.stringify({progressMinutes:Math.round((Date.now()-started)/60000),checks:report.checks.length}));
  }
  if(soakMinutes)report.checks.push(`continuous ${soakMinutes} minute native audio/offscreen soak`);
  const opened=context.waitForEvent('page');await worker.evaluate(url=>chrome.tabs.create({url,active:false}),`chrome-extension://${id}/panel.html`);panel=await opened;await panel.waitForLoadState();
  await panel.waitForFunction(()=>document.querySelector('#video-status').textContent.includes('背景字幕執行中'));
  await worker.evaluate(tabId=>chrome.scripting.executeScript({target:{tabId},func:()=>globalThis.shadows.get(document.querySelector('[data-qingread-background]')).querySelector('button').click()}),tabId);
  await source.waitForFunction(()=>!document.querySelector('[data-qingread-media]')&&!document.querySelector('[data-qingread-background]'));
  await panel.waitForFunction(async()=>!(await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})).length,null,{timeout:15000});
  report.checks.push('stop removes subtitles, releases audio and closes the idle offscreen document');report.passed=true;
 }catch(error){report.passed=false;report.error=error.message;if(panel)report.status=await panel.locator('#video-status').textContent().catch(()=>'?');throw error;}
 finally{
  console.log(JSON.stringify(report));await context?.close();helper.kill();
  fs.writeFileSync(path.join(results,'speech-handoff-smoke.json'),JSON.stringify(report,null,2));
  if(path.dirname(temporary)===results&&path.basename(temporary).startsWith('speech-handoff-'))fs.rmSync(temporary,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
