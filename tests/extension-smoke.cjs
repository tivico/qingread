const {chromium}=require('playwright');
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
(async()=>{
 const root=path.resolve(__dirname,'..'),results=path.join(root,'test-results');fs.mkdirSync(results,{recursive:true});
 const profile=fs.mkdtempSync(path.join(results,'extension-profile-')),extension=path.join(root,'extension');
 const context=await chromium.launchPersistentContext(profile,{headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chromium'}),ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
 const report={loaded:false};
 try {
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:10000});
  const id=new URL(worker.url()).host;assert.match(worker.url(),/^chrome-extension:/);report.loaded=true;
  const panel=await context.newPage();await panel.goto(`chrome-extension://${id}/panel.html`);
  await panel.evaluate(()=>{globalThis.tabEvents=[];chrome.tabs.onActivated.addListener(info=>tabEvents.push({kind:'activated',...info}));chrome.tabs.onUpdated.addListener((id,change)=>{if(change.status||change.url)tabEvents.push({kind:'updated',id,...change});});});
  const article=await context.newPage();
  const url=(process.env.LIVE_SUMMARY||process.env.CAPTURE_SUMMARY_SOURCE)?'https://code.claude.com/docs/zh-TW/overview':'https://article.test/overview';
  if(!process.env.LIVE_SUMMARY&&!process.env.CAPTURE_SUMMARY_SOURCE)await article.route('https://article.test/**',r=>r.fulfill({contentType:'text/html',body:'<main><h1>Reading review</h1><p>This article explains a local reading assistant. It translates visible text and summarizes the current page. The summary stays on this computer.</p></main>'}));
  await article.goto(url,{waitUntil:'domcontentloaded',timeout:60000});await article.bringToFront();
  await panel.evaluate(()=>{document.querySelector('[data-view="summary"]').click();document.querySelector('#summary-start').click();});
  await panel.waitForFunction(()=>!document.querySelector('#summary-grant').hidden);
  assert.match(await panel.locator('#summary-grant').textContent(),/允許|檢查網站存取/);
  await panel.evaluate(()=>document.querySelector('#summary-grant').click());
  await panel.waitForFunction(()=>document.querySelector('#summary-status').textContent.includes('尚未取得授權'));
  report.realTabAccessRequest=true;
  report.realPermissionDenied=true;
  // This invokes Chrome's real toolbar action, granting activeTab, without mocking chrome APIs.
  const browserCDP=await context.browser().newBrowserCDPSession();
  async function trigger(url){const {targetInfos}=await browserCDP.send('Target.getTargets',{filter:[{type:'tab'}]});const target=targetInfos.find(t=>t.url===url);assert.ok(target,'No tab target');await browserCDP.send('Extensions.triggerAction',{id,targetId:target.targetId});}
  await trigger(article.url());
  await article.bringToFront();
  const extracted=await panel.evaluate(async()=>{const tab=await activeTab();const target=await inject(tab);const batch=await send(target,{type:'qingread:summary-source',job:crypto.randomUUID(),scope:'page'});return {chars:batch.items.map(x=>x.text).join('\n\n').length,text:batch.items.map(x=>x.text).join('\n\n')};});
  assert.ok(extracted.chars>50);report.toolbarAccessAndExtraction=true;report.sourceCharacters=extracted.chars;
  if(process.env.CAPTURE_SUMMARY_SOURCE)fs.writeFileSync(path.join(results,'summary-benchmark-source.txt'),extracted.text);
  if(process.env.LIVE_SUMMARY){
   const local=await context.newPage();await local.goto('http://127.0.0.1:8765/health');await trigger(local.url());
   const token=JSON.parse(fs.readFileSync(path.join(root,'companion/data/config.json'),'utf8')).token;
   await panel.evaluate(token=>chrome.storage.session.set({companionToken:token}),token);
   await article.bringToFront();await panel.evaluate(()=>{globalThis.summaryTiming={started:Date.now()};new MutationObserver(()=>{if(!summaryTiming.first&&document.querySelector('#summary-result').textContent)summaryTiming.first=Date.now();}).observe(document.querySelector('#summary-result'),{childList:true,subtree:true});document.querySelector('#summary-start').click();});
   await panel.waitForFunction(()=>document.querySelector('#summary-stop').disabled,{},{timeout:240000});
   const status=await panel.locator('#summary-status').textContent();assert.match(status,/摘要已完成/);
   assert.ok((await panel.locator('#summary-result').textContent()).trim().length>20);assert.equal(await panel.locator('#summary-output').getAttribute('hidden'),null);
   report.realLocalSummary=true;report.timing=await panel.evaluate(()=>({firstTextSeconds:(summaryTiming.first-summaryTiming.started)/1000,totalSeconds:(Date.now()-summaryTiming.started)/1000}));
   await panel.screenshot({path:path.join(results,'summary-real-extension.png'),fullPage:true});
  }
  fs.writeFileSync(path.join(results,'extension-smoke.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
 }catch(error){const panel=context.pages().find(p=>p.url().endsWith('/panel.html'));report.tabEvents=panel?await panel.evaluate(()=>globalThis.tabEvents):[];fs.writeFileSync(path.join(results,'extension-smoke.json'),JSON.stringify({...report,failed:true,error:error.message},null,2));throw error;}
 finally{await context.close();}
})().catch(e=>{console.error(e.name+': '+e.message);process.exitCode=1;});
