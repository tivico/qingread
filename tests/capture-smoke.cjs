// Isolated real Chrome tab audio capture. No personal tabs, helper or model.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const root=path.resolve(__dirname,'..'),results=path.join(root,'test-results');
 fs.mkdirSync(results,{recursive:true});
 const temporary=fs.mkdtempSync(path.join(results,'capture-')),extension=path.join(temporary,'extension');
 const report={checks:[],permissionDialogTested:false};let context;
 try{
  fs.cpSync(path.join(root,'extension'),extension,{recursive:true});
  // Pregrant in this disposable copy; production keeps optional, explicit consent.
  const manifestPath=path.join(extension,'manifest.json'),manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  manifest.permissions.push('tabCapture');manifest.optional_permissions=manifest.optional_permissions.filter(p=>p!=='tabCapture');
  fs.writeFileSync(manifestPath,JSON.stringify(manifest));
  context=await chromium.launchPersistentContext(path.join(temporary,'profile'),{headless:true,
   ...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chromium'}),
   ignoreDefaultArgs:['--disable-extensions','--mute-audio'],args:['--enable-unsafe-extension-debugging',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),id=new URL(worker.url()).host;
  const panel=await context.newPage();await panel.goto(`chrome-extension://${id}/panel.html`);
  const source=await context.newPage();await source.route('https://capture.test/**',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><title>Artificial audio capture fixture</title><button>Play test tone</button><script>document.querySelector("button").onclick=async()=>{window.audio=new AudioContext();const tone=audio.createOscillator();tone.frequency.value=440;tone.connect(audio.destination);tone.start();await audio.resume();}</script>'}));
  await source.goto('https://capture.test/');await source.locator('button').click();
  const target=await worker.evaluate(async()=>{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});return {tabId:tab.id,windowId:tab.windowId};});
  const uninvoked=await panel.evaluate(target=>chrome.runtime.sendMessage({type:'qingread:capture',...target}),target);
  assert.equal(uninvoked.code,'CAPTURE_INVOKE');report.checks.push('missing toolbar invocation classified before capture');
  const cdp=await context.browser().newBrowserCDPSession();
  const {targetInfos}=await cdp.send('Target.getTargets',{filter:[{type:'tab'}]});
  await cdp.send('Extensions.triggerAction',{id,targetId:targetInfos.find(t=>t.url===source.url()).targetId});
  const acquire=(waitForRelease=false)=>panel.evaluate(async ({target,waitForRelease})=>{
   const reply=await chrome.runtime.sendMessage({type:'qingread:capture',...target,...(waitForRelease?{waitForRelease:true}:{})});
   if(reply.error)return reply;
   window.captureStream=await navigator.mediaDevices.getUserMedia({audio:{mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:reply.streamId}},video:false});
   return {live:captureStream.getAudioTracks()[0].readyState==='live'};
  },{target,waitForRelease});
  assert.equal((await acquire()).live,true);report.checks.push('toolbar invocation, worker stream ID and extension-page consumption');
  const signal=await panel.evaluate(async()=>{
   const audio=new AudioContext(),analyser=audio.createAnalyser();audio.createMediaStreamSource(captureStream).connect(analyser);analyser.connect(audio.destination);
   await audio.resume();let peak=0;
   for(let i=0;i<20&&!peak;i++){
    await new Promise(r=>setTimeout(r,100));
    const values=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(values);
    peak=Math.max(...values.map(Math.abs));
   }
   await audio.close();return peak;
  });
  assert.ok(signal>0.001,`Expected artificial audio, peak=${signal}`);report.audioPeak=signal;report.checks.push('captured artificial 440 Hz tone');
  const duplicate=await panel.evaluate(target=>chrome.runtime.sendMessage({type:'qingread:capture',...target}),target);
  assert.equal(duplicate.code,'CAPTURE_BUSY');report.checks.push('duplicate capture classified as busy');
  await panel.evaluate(()=>captureStream.getTracks().forEach(t=>t.stop()));
  assert.equal((await acquire(true)).live,true);report.checks.push('handoff wait permits immediate restart after stopping tracks');
  await panel.evaluate(()=>captureStream.getTracks().forEach(t=>t.stop()));
  console.log(JSON.stringify(report));
 }finally{
  await context?.close();fs.writeFileSync(path.join(results,'capture-smoke.json'),JSON.stringify(report,null,2));
  // Delete only the temporary directory just created beneath test-results.
  if(path.dirname(temporary)===results&&path.basename(temporary).startsWith('capture-'))fs.rmSync(temporary,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
