// Real Ollama catalog and extension APIs; synthetic translations, no model requests.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
  const root=path.resolve(__dirname,'..'),results=path.join(root,'test-results');
  fs.mkdirSync(results,{recursive:true});
  const profile=fs.mkdtempSync(path.join(results,'linked-cards-'));
  const extension=path.join(root,'extension'),url='https://ollama.com/library?sort=newest';
  const descriptions='a[href^="/library/"] > div[title] > p';
  let context;
  try{
    context=await chromium.launchPersistentContext(profile,{headless:true,
      ...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chromium'}),
      ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging',
        `--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:10000});
    const id=new URL(worker.url()).host,panel=await context.newPage();
    await panel.goto(`chrome-extension://${id}/panel.html`);
    await panel.evaluate(()=>{
      document.querySelector('#engine').value='local';document.querySelector('#engine').dispatchEvent(new Event('change'));
      globalThis.submissions=[];
      QingReadLocal.translator=()=>({translate:async text=>{submissions.push(text);return '人工測試譯文：此處只驗證介紹擷取與插入。';},destroy(){}});
    });
    const article=await context.newPage();
    const response=await article.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
    assert.equal(response.status(),200,'Catalog unavailable');
    const originals=await article.locator(descriptions).allTextContents();
    assert.ok(originals.length>10,'Catalog structure changed; update the live test selector');
    assert.ok(originals.some(text=>text.trim().length<160),'No short description to verify');
    await article.bringToFront();
    const cdp=await context.browser().newBrowserCDPSession();
    const {targetInfos}=await cdp.send('Target.getTargets',{filter:[{type:'tab'}]});
    const target=targetInfos.find(item=>item.url===article.url());assert.ok(target);
    await cdp.send('Extensions.triggerAction',{id,targetId:target.targetId});
    const batches=[];
    for(let round=0;round<5;round++){
      await panel.evaluate(()=>document.querySelector('#start').click());
      await panel.waitForFunction(()=>!document.querySelector('#start').disabled,{},{timeout:60000});
      const status=await panel.locator('#status').textContent();
      assert.match(status,/^完成 \d+ 段|目前辨識範圍內的段落已翻譯/);
      const coverage=await article.locator(descriptions).evaluateAll(nodes=>({
        total:nodes.length,translated:nodes.filter(node=>node.nextElementSibling?.matches('[data-qingread=translation]')).length
      }));
      batches.push({status,...coverage});
      if(coverage.translated===coverage.total)break;
    }
    assert.equal(batches.at(-1).translated,originals.length,'Some model descriptions were missed');
    assert.deepEqual(await article.locator(descriptions).allTextContents(),originals,'Original text changed');
    const submitted=await panel.evaluate(()=>submissions.length);
    await panel.evaluate(()=>document.querySelector('#start').click());
    await panel.waitForFunction(()=>!document.querySelector('#start').disabled);
    assert.equal(await panel.evaluate(()=>submissions.length),submitted,'Completed cards were translated twice');
    await article.screenshot({path:path.join(results,'linked-cards-after.png')});
    await panel.evaluate(()=>document.querySelector('#restore').click());
    await panel.waitForFunction(()=>document.querySelector('#status').textContent==='已還原目前網頁。');
    assert.equal(await article.locator('[data-qingread=translation]').count(),0);
    assert.deepEqual(await article.locator(descriptions).allTextContents(),originals);
    const report={url,descriptionCount:originals.length,shortDescriptions:originals.filter(text=>text.trim().length<160).length,
      batches,noDuplicateSubmissions:true,restored:true,scope:'real public catalog and native extension APIs; synthetic translation; no model quality evaluation'};
    fs.writeFileSync(path.join(results,'linked-cards-smoke.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
  }finally{
    await context?.close();
    const resolved=path.resolve(profile);
    if(path.dirname(resolved)!==results||!path.basename(resolved).startsWith('linked-cards-'))throw new Error('Unexpected profile path');
    fs.rmSync(resolved,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
