// Actual extension/offscreen/worker/fullscreen lifecycle, isolated profile and helper.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),{spawn}=require('node:child_process');
(async()=>{
 const root=path.resolve(__dirname,'..'),results=path.join(root,'test-results');fs.mkdirSync(results,{recursive:true});
 const profile=fs.mkdtempSync(path.join(results,'background-video-')),extension=path.join(profile,'extension');
 const helper=spawn(path.join(root,'companion/.venv/Scripts/python.exe'),[path.join(root,'tests/inference_fixture_server.py'),...(process.argv.includes('--live-model')?['--live-model']:[])],{windowsHide:true,stdio:['ignore','pipe','ignore']});
 const report={checks:[],liveModel:process.argv.includes('--live-model')},requests=[];let context,panel;
 try{
  const port=await new Promise((resolve,reject)=>{let out='';const timer=setTimeout(()=>reject(new Error('Helper timeout')),10000);helper.once('error',reject);helper.stdout.on('data',chunk=>{out+=chunk;if(out.includes('\n')){clearTimeout(timer);resolve(JSON.parse(out.split('\n')[0]).port);}});});
  // Playwright page routing does not intercept offscreen fetches. Use an isolated
  // copy with only the fixed loopback port/CSP changed; never call the user's helper.
  fs.cpSync(path.join(root,'extension'),extension,{recursive:true});
  for(const name of ['local-client.js','manifest.json']){const file=path.join(extension,name);fs.writeFileSync(file,fs.readFileSync(file,'utf8').replaceAll('127.0.0.1:8765',`127.0.0.1:${port}`));}
  context=await chromium.launchPersistentContext(path.join(profile,'profile'),{headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chromium'}),ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  await context.route('http://127.0.0.1:8765/**',async route=>{
   const request=route.request(),headers=await request.allHeaders(),endpoint=new URL(request.url()).pathname;
   const response=await fetch(`http://127.0.0.1:${port}${endpoint}`,{method:request.method(),headers:{Authorization:'Bearer '+'a'.repeat(43),'Content-Type':'application/json',...(headers.origin?{Origin:headers.origin}:{}),...(headers['x-qingread-client']?{'X-QingRead-Client':headers['x-qingread-client']}: {})},...(request.postData()?{body:request.postData()}:{})});
   const body=await response.text();requests.push({endpoint,method:request.method(),status:response.status});await route.fulfill({status:response.status,contentType:'application/json',body});
  });
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const id=new URL(worker.url()).host;
  panel=await context.newPage();await panel.goto(`chrome-extension://${id}/panel.html`);
  const cdp=await context.browser().newBrowserCDPSession();
  async function grant(page){await page.bringToFront();const {targetInfos}=await cdp.send('Target.getTargets',{filter:[{type:'tab'}]});await cdp.send('Extensions.triggerAction',{id,targetId:targetInfos.find(t=>t.url===page.url()).targetId});}
  const local=await context.newPage();await local.goto(`http://127.0.0.1:${port}/health`);await grant(local);
  const article=await context.newPage();await article.route('https://video.test/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><style>body{margin:0;background:#222}#movie_player{width:900px;height:600px;background:#27453f}video{width:100%;height:90%}#movie_player:fullscreen{width:100vw;height:100vh}</style><div id="movie_player"><video></video><div class="ytp-caption-window-container"><span class="ytp-caption-segment">Keep the original file and check the translation.</span></div><button id="fullscreen">Full screen</button></div><script>document.querySelector("#fullscreen").onclick=()=>document.querySelector("#movie_player").requestFullscreen()</script>'}));
  await article.goto('https://video.test/watch');await grant(article);
  await article.evaluate(async()=>{
   const canvas=document.createElement('canvas');canvas.width=900;canvas.height=540;
   const drawing=canvas.getContext('2d');drawing.fillStyle='#27453f';drawing.fillRect(0,0,900,540);
   const video=document.querySelector('video');video.muted=true;video.srcObject=canvas.captureStream(2);
   setInterval(()=>drawing.fillRect(0,0,900,540),500);
   await video.play();
  });
  // Observe shadow DOM text without changing the product's closed-shadow behavior.
  const tabId=await panel.evaluate(async()=>(await activeTab()).id);
  await worker.evaluate(tabId=>chrome.scripting.executeScript({target:{tabId},func:()=>{const original=Element.prototype.attachShadow;globalThis.shadows=new Map();Element.prototype.attachShadow=function(options){const result=original.call(this,options);shadows.set(this,result);return result;};}}),tabId);
  await panel.evaluate(()=>{chrome.storage.session.set({companionToken:'a'.repeat(43)});document.querySelector('#engine').value='local';document.querySelector('#engine').dispatchEvent(new Event('change'));document.querySelector('[data-view=video]').click();document.querySelector('#video-start').click();});
  await panel.waitForFunction(()=>!document.querySelector('#video-collapse').disabled);
  await article.waitForFunction(()=>Boolean(document.querySelector('[data-qingread-media]')),null,{timeout:120000});
  await article.evaluate(()=>{
   globalThis.handoffBox=document.querySelector('[data-qingread-media]');
   globalThis.handoffRemoved=false;
   new MutationObserver(changes=>{
    if(changes.some(change=>[...change.removedNodes].some(node=>node===handoffBox||node.contains(handoffBox))))handoffRemoved=true;
   }).observe(document.documentElement,{subtree:true,childList:true});
  });
  await panel.evaluate(()=>document.querySelector('#video-collapse').click());
  await article.waitForFunction(()=>Boolean(document.querySelector('[data-qingread-background]')),null,{timeout:20000});
  await panel.waitForFunction(()=>document.querySelector('#video-background-status').textContent.includes('背景已接手'));
  const state=await panel.evaluate(()=>chrome.runtime.sendMessage({type:'qingread:video-control',action:'status'}));assert.equal(state.active,true);
  assert.equal(await article.evaluate(()=>handoffBox.isConnected&&!handoffRemoved),true);
  report.checks.push('handoff preserves the visible subtitle box until the background adopts the source');
  await panel.close();panel=null;
  await article.locator('#fullscreen').click();
  await article.waitForFunction(()=>document.fullscreenElement?.id==='movie_player');
  await article.waitForFunction(()=>Boolean(document.querySelector('[data-qingread-media]')),null,{timeout:120000});
  assert.equal(await article.locator('[data-qingread-media]').evaluate(node=>node.parentElement.id),'movie_player');
  assert.equal(await article.locator('[data-qingread-background]').evaluate(node=>node.parentElement.id),'movie_player');
  const read=()=>worker.evaluate(async tabId=>(await chrome.scripting.executeScript({target:{tabId},func:()=>globalThis.shadows.get(document.querySelector('[data-qingread-media]'))?.textContent}))[0].result,tabId);
  assert.ok((await read()).includes('Keep the original file'));
  await article.evaluate(()=>document.querySelector('.ytp-caption-segment').textContent='Watch the next sentence while the controls are closed.');
  const deadline=Date.now()+120000;while(!(await read())?.includes('Watch the next sentence')){if(Date.now()>deadline)throw new Error('No subsequent background caption');await new Promise(resolve=>setTimeout(resolve,200));}
  report.checks.push('panel destroyed: offscreen worker translates subsequent cues in real fullscreen, with bilingual overlay and stop control');
  await article.screenshot({path:path.join(results,'background-video-fullscreen.png')});
  // Reopen controls in an inactive tab, so the source stays the active video.
  const opened=context.waitForEvent('page');await worker.evaluate(url=>chrome.tabs.create({url,active:false}),`chrome-extension://${id}/panel.html`);panel=await opened;await panel.waitForLoadState();
  await panel.waitForFunction(()=>document.querySelector('#video-status').textContent.includes('背景字幕執行中'));
  await panel.waitForFunction(()=>document.querySelector('#video-timing').textContent.includes('翻譯往返'));
  if(report.liveModel)assert.match(await panel.locator('#video-timing').textContent(),/模型載入.*模型讀文.*生成譯文/);
  report.checks.push('reopened controls receive subtitle timing metrics from the background owner');
  assert.equal(await panel.locator('#video-stop').isDisabled(),false);report.checks.push('reopened panel recovers background status and stop control');
  await worker.evaluate(tabId=>chrome.scripting.executeScript({target:{tabId},func:()=>globalThis.shadows.get(document.querySelector('[data-qingread-background]')).querySelector('button').click()}),tabId);
  await article.waitForFunction(()=>!document.querySelector('[data-qingread-background]')&&!document.querySelector('[data-qingread-media]'));
  await panel.waitForFunction(()=>document.querySelector('#video-stop').disabled);
  report.checks.push('fullscreen stop clears captions and restores panel controls');
  await panel.waitForFunction(async()=>!(await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})).length,null,{timeout:15000});
  report.checks.push('idle offscreen document closes after cleanup');report.passed=true;
 }catch(error){report.passed=false;report.error=error.message;if(panel)report.status=await panel.locator('#video-background-status').textContent().catch(()=>'?');throw error;}
 finally{fs.writeFileSync(path.join(results,'background-video-smoke.json'),JSON.stringify({...report,requests},null,2));console.log(JSON.stringify(report));await context?.close();helper.kill();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
