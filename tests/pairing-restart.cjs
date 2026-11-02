// Real extension storage across two isolated Chromium processes; no user credentials.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const root=path.resolve(__dirname,'..'),extension=path.join(root,'extension');
 fs.mkdirSync(path.join(root,'test-results'),{recursive:true});
 const temp=fs.mkdtempSync(path.join(root,'test-results/pairing-restart-'));
 const token='p'.repeat(43),report={checks:[]};let context;
 async function launch(){
  context=await chromium.launchPersistentContext(path.join(temp,'profile'),{headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chromium'}),ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  await context.route('http://127.0.0.1:8765/**',async route=>{
   const request=route.request();assert.equal((await request.allHeaders()).authorization,`Bearer ${token}`);
   assert.ok(!request.url().includes('/pair/'),'Saved pairing must not start consent again');
   await route.fulfill({json:request.url().endsWith('/health')?{models:[],ollama:true,pdf_preview:true}:{jobs:[]}});
  });
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const page=await context.newPage();await page.goto(`chrome-extension://${new URL(worker.url()).host}/workspace.html`);
  return page;
 }
 try{
  let page=await launch();
  // Call the production authenticated pairing method, omitting only the OS consent UI.
  await page.evaluate(token=>QingReadLocal.pair(token,{remember:true}),token);
  await context.close();context=null;
  page=await launch();
  await page.waitForFunction(()=>document.querySelector('#health').textContent.includes('助手已連線'));
  assert.equal(await page.locator('#remember-device').isChecked(),true);
  assert.equal(await page.evaluate(async()=>(await chrome.storage.session.get('companionToken')).companionToken),undefined);
  report.checks.push('new Chromium process: remembered local credential reconnects with empty session storage');
  await page.locator('#forget-device').click();
  await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('已忘記'));
  await page.reload();await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('按「連接本機助手」'));
  assert.equal(await page.locator('#remember-device').isChecked(),false);
  assert.equal(await page.locator('#health').textContent(),'尚未連線');
  report.checks.push('forget: reload remains disconnected');report.passed=true;
 }finally{
  await context?.close();fs.writeFileSync(path.join(root,'test-results/pairing-restart.json'),JSON.stringify(report,null,2));
 }
 console.log(JSON.stringify(report));
})().catch(error=>{console.error(error.message);process.exitCode=1;});
