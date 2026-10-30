// Real extension and real companion. Never clicks native consent; permits a human to approve.
// Without human approval it cancels after 30 seconds (PAIR_CANCEL_MS overrides the wait).
const {chromium}=require('playwright'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const root=path.resolve(__dirname,'..'),results=path.join(root,'test-results'),extension=path.join(root,'extension');
 const profile=fs.mkdtempSync(path.join(results,'pairing-profile-'));
 const context=await chromium.launchPersistentContext(profile,{headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chromium'}),ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:10000}),id=new URL(worker.url()).host;
  const local=await context.newPage();await local.goto('http://127.0.0.1:8765/health');
  const cdp=await context.browser().newBrowserCDPSession();
  const {targetInfos}=await cdp.send('Target.getTargets',{filter:[{type:'tab'}]});
  await cdp.send('Extensions.triggerAction',{id,targetId:targetInfos.find(t=>t.url===local.url()).targetId});
  const page=await context.newPage();await page.goto(`chrome-extension://${id}/workspace.html`);
  await page.evaluate(()=>{
   globalThis.testController=new AbortController();
   globalThis.testResult=null;
   QingReadLocal.connect({signal:testController.signal,onPending:code=>{document.querySelector('#pair-status').textContent='確認數字：'+code;globalThis.testCode=code;}}).then(()=>{testResult='approved';},error=>{testResult=error.name==='AbortError'?'cancelled':error.message;});
  });
  await page.waitForFunction(()=>globalThis.testCode || globalThis.testResult);
  assert.match(await page.evaluate(()=>globalThis.testCode || ''),/^\d{6}$/);
  console.log('Real native pairing confirmation requested; waiting for human approval or automatic cancellation.');
  await page.screenshot({path:path.join(results,'pairing-real-pending.png'),fullPage:true});
  await new Promise(r=>setTimeout(r,Number(process.env.PAIR_CANCEL_MS)||30000));
  await page.evaluate(()=>testController.abort());
  await page.waitForFunction(()=>globalThis.testResult!==null);
  const outcome=await page.evaluate(()=>testResult);assert.ok(['approved','cancelled'].includes(outcome),outcome);
  const credentialSaved=await page.evaluate(async()=>Boolean((await chrome.storage.session.get('companionToken')).companionToken));
  assert.equal(credentialSaved,outcome==='approved');
  const report={realExtension:true,realCompanion:true,requestAccepted:true,outcome,credentialSaved};
  fs.writeFileSync(path.join(results,'pairing-smoke.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }finally{await context.close();}
})().catch(e=>{console.error(e.name+': '+e.message);process.exitCode=1;});
