// Uses a real extension origin in an isolated browser profile; no user credentials.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
(async()=>{
  const root=path.resolve(__dirname,'..'),results=path.join(root,'test-results');fs.mkdirSync(results,{recursive:true});
  const temp=fs.mkdtempSync(path.join(results,'origin-smoke-')),extension=path.join(temp,'extension');
  fs.cpSync(path.join(root,'extension'),extension,{recursive:true});
  const manifest=JSON.parse(fs.readFileSync(path.join(extension,'manifest.json'),'utf8'));
  manifest.host_permissions=['http://127.0.0.1/*'];fs.writeFileSync(path.join(extension,'manifest.json'),JSON.stringify(manifest));
  const trace=[],legacy=process.argv.includes('--legacy-owner');
  const helper=spawn(path.join(root,'companion/.venv/Scripts/python.exe'),[path.join(root,'tests/inference_fixture_server.py'),...(legacy?['--legacy-owner']:[])],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  let context;
  try{
    const port=await new Promise((resolve,reject)=>{
      let output='';const timer=setTimeout(()=>reject(new Error('Fixture did not start')),10000);
      helper.on('error',error=>{clearTimeout(timer);reject(error);});
      helper.stdout.on('data',chunk=>{output+=chunk;if(output.includes('\n')){clearTimeout(timer);try{resolve(JSON.parse(output.split('\n')[0]).port);}catch(error){reject(error);}}});
      helper.on('exit',()=>{clearTimeout(timer);reject(new Error('Fixture exited'));});
    });
    context=await chromium.launchPersistentContext(path.join(temp,'profile'),{headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chromium'}),ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
    await context.route('http://127.0.0.1:8765/**',async route=>{
      const request=route.request(),headers=await request.allHeaders(),method=request.method();
      trace.push({method,hasOrigin:Boolean(headers.origin),hasClient:Boolean(headers['x-qingread-client'])});
      const forwarded={'Authorization':'Bearer '+'a'.repeat(43),'Content-Type':'application/json'};
      if(headers.origin)forwarded.Origin=headers.origin;
      if(headers['x-qingread-client'])forwarded['X-QingRead-Client']=headers['x-qingread-client'];
      const response=await fetch(`http://127.0.0.1:${port}${new URL(request.url()).pathname}`,{method,headers:forwarded,...(request.postData()?{body:request.postData()}:{})});
      await route.fulfill({status:response.status,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:await response.text()});
    });
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:10000});
    const id=new URL(worker.url()).host,panel=await context.newPage();await panel.goto(`chrome-extension://${id}/panel.html`);
    const outcome=await panel.evaluate(async()=>{
      await chrome.storage.session.set({companionToken:'a'.repeat(43)});
      try{return {ok:true,result:await QingReadLocal.request('/summarize',{body:{text:'Synthetic source.'},managed:true})};}
      catch(error){return {ok:false,message:error.message};}
    });
    fs.writeFileSync(path.join(results,legacy?'inference-origin-smoke-legacy.json':'inference-origin-smoke.json'),JSON.stringify({trace,outcome},null,2));
    console.log(JSON.stringify({trace,outcome}));
    assert.equal(outcome.ok,!legacy);
    if(legacy){assert.match(outcome.message,/重新啟動/);assert.equal(trace.filter(item=>item.method==='POST').length,0);}
  }finally{await context?.close();helper.kill();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
