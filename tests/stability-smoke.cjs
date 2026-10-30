// Opt-in real extension + production helper HTTP + installed local model.
// Isolated profile/data/token; HTTP is forwarded to a random test port.
// Does not automate pairing consent or the persistent-host permission dialog.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');

(async()=>{
  assert.ok(process.argv.includes('--live-model'),'Pass --live-model to use the installed model.');
  const root=path.resolve(__dirname,'..'),results=path.join(root,'test-results');
  fs.mkdirSync(results,{recursive:true});
  const temp=fs.mkdtempSync(path.join(results,'stability-')),extension=path.join(root,'extension');
  const helper=spawn(path.join(root,'companion/.venv/Scripts/python.exe'),[path.join(root,'tests/inference_fixture_server.py'),'--live-model'],{windowsHide:true,stdio:['ignore','pipe','ignore']});
  const report={scope:'real extension, native activeTab grant, real helper and local model; isolated pairing token; loopback HTTP forwarded to a random port',checks:[]};
  let context,panel,offline=false;
  const requests=[],errors=[];
  try{
    const port=await new Promise((resolve,reject)=>{
      let output='';const timer=setTimeout(()=>reject(new Error('Helper startup timed out')),10000);
      helper.once('error',error=>{clearTimeout(timer);reject(error);});
      helper.once('exit',()=>{clearTimeout(timer);reject(new Error('Helper exited'));});
      helper.stdout.on('data',chunk=>{output+=chunk;if(output.includes('\n')){clearTimeout(timer);try{resolve(JSON.parse(output.split('\n')[0]).port);}catch(error){reject(error);}}});
    });
    context=await chromium.launchPersistentContext(path.join(temp,'profile'),{headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chromium'}),ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
    await context.route('http://127.0.0.1:8765/**',async route=>{
      if(offline)return route.abort('connectionrefused');
      const request=route.request(),incoming=await request.allHeaders(),method=request.method();
      const headers={Authorization:'Bearer '+'a'.repeat(43),'Content-Type':'application/json'};
      for(const name of ['origin','x-qingread-client'])if(incoming[name])headers[name]=incoming[name];
      const endpoint=new URL(request.url()).pathname;
      const response=await fetch(`http://127.0.0.1:${port}${endpoint}`,{method,headers,...(request.postData()?{body:request.postData()}:{})});
      const body=await response.text();
      let value={};try{value=JSON.parse(body);}catch{}
      requests.push({method,endpoint,stage:value.stage,cached:value.cached,status:response.status});
      await route.fulfill({status:response.status,contentType:'application/json',body});
    });
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:10000});
    const id=new URL(worker.url()).host;
    panel=await context.newPage();panel.on('pageerror',error=>errors.push(error.message));
    await panel.goto(`chrome-extension://${id}/panel.html`);
    const cdp=await context.browser().newBrowserCDPSession();
    async function grant(page){
      await page.bringToFront();
      const {targetInfos}=await cdp.send('Target.getTargets',{filter:[{type:'tab'}]});
      const target=targetInfos.find(item=>item.url===page.url());assert.ok(target);
      await cdp.send('Extensions.triggerAction',{id,targetId:target.targetId});
    }
    const local=await context.newPage();await local.goto('http://127.0.0.1:8765/health');await grant(local);
    const article=await context.newPage();
    await article.goto('https://aa.nttu.edu.tw/p/406-1002-179272,r1386.php?Lang=zh-tw',{waitUntil:'domcontentloaded',timeout:60000});
    await grant(article);
    const click=selector=>panel.evaluate(selector=>document.querySelector(selector).click(),selector);
    await click('[data-view=summary]');await click('#summary-start');
    await panel.waitForFunction(()=>document.querySelector('#summary-stop').disabled);
    assert.match(await panel.locator('#summary-status').textContent(),/配對/);
    assert.equal(requests.filter(item=>item.method==='POST').length,0);
    report.checks.push('unpaired: no source submission');
    // Inject a test credential into the isolated session, not the user's pairing data.
    await panel.evaluate(()=>chrome.storage.session.set({companionToken:'a'.repeat(43)}));
    async function summarize(label){
      const start=Date.now();await click('#summary-start');
      await panel.waitForFunction(()=>document.querySelector('#summary-stop').disabled,null,{timeout:190000});
      assert.match(await panel.locator('#summary-status').textContent(),/摘要已完成/);
      const text=await panel.locator('#summary-result').textContent();assert.ok(text.length>20);
      report.checks.push({label,seconds:(Date.now()-start)/1000,characters:text.length});
    }
    await summarize('public NTTU article: complete summary');
    // Public pages can change (e.g. late visitor counts), so cache assertions
    // must use a stable source rather than assuming the website never updates.
    await article.evaluate(()=>{document.body.innerHTML='<main><p>This synthetic article describes a local reading assistant. Keep the original text, review the translation, and stop processing when necessary.</p></main>';});
    await summarize('stable synthetic source');
    await summarize('identical source: cached summary');
    assert.match(await panel.locator('#summary-status').textContent(),/沿用/);
    // New synthetic source avoids cache and gives the stop action real model work.
    await article.evaluate(()=>{document.body.innerHTML='<main><p>'+('This synthetic document explains how to retain source files, check translations, and stop local processing safely. '.repeat(45))+'</p></main>';});
    const baseline=requests.length;
    await click('#summary-start');
    const until=Date.now()+30000;
    while(!requests.slice(baseline).some(item=>['reading','generating'].includes(item.stage))){
      if(Date.now()>until)throw new Error('Model did not reach an active stage before cancellation');
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    await click('#summary-stop');
    await panel.waitForFunction(()=>document.querySelector('#summary-status').textContent.includes('助手已確認'),null,{timeout:10000});
    assert.ok(requests.slice(baseline).some(item=>item.method==='DELETE'));
    assert.ok(requests.slice(baseline).some(item=>item.stage==='cancelled'));
    report.checks.push('stop: helper confirms cancelled');
    await article.evaluate(()=>{document.body.innerHTML='<main><p>This is a new article after stopping. Keep the original file and verify each translated sentence before sharing.</p></main>';});
    await summarize('new summary after stopping');
    offline=true;await click('#summary-start');
    await panel.waitForFunction(()=>document.querySelector('#summary-stop').disabled,null,{timeout:15000});
    assert.match(await panel.locator('#summary-status').textContent(),/無法連線/);
    offline=false;await summarize('retry after simulated connection refusal');
    await panel.evaluate(()=>{document.querySelector('#engine').value='local';document.querySelector('#engine').dispatchEvent(new Event('change'));document.querySelector('[data-view=text]').click();document.querySelector('#text-input').value='Do not delete the backup. Keep the original file.';document.querySelector('#text-input').dispatchEvent(new Event('input'));document.querySelector('#text-start').click();});
    await panel.waitForFunction(()=>!document.querySelector('#text-start').disabled,null,{timeout:190000});
    assert.ok((await panel.locator('#text-output').inputValue()).trim().length>5);
    report.checks.push('text translation: actual local model output');
    assert.deepEqual(errors,[]);
    report.passed=true;
  }catch(error){
    report.passed=false;report.error=error.message;
    if(panel)report.lastStatus=await panel.locator('#summary-status').textContent().catch(()=>'unavailable');
    throw error;
  }finally{
    report.requests=requests;report.pageErrors=errors;
    fs.writeFileSync(path.join(results,'stability-smoke.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({passed:report.passed,checks:report.checks,error:report.error}));
    // Explicitly cancel any test jobs before terminating our own helper.
    if(panel)await panel.evaluate(()=>document.querySelector('#summary-stop').click()).catch(()=>{});
    await context?.close();helper.kill();
  }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
