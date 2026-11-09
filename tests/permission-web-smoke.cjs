// Real extension + public website + native toolbar permission. Translation is synthetic.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
  const root=path.resolve(__dirname,'..'),results=path.join(root,'test-results');
  fs.mkdirSync(results,{recursive:true});
  const profile=fs.mkdtempSync(path.join(results,'permission-web-'));
  const url=process.argv.includes('--url')?process.argv[process.argv.indexOf('--url')+1]:'https://www.netdocuments.com/blog/inspire-2026-recap/';
  assert.match(url,/^https:\/\//);
  const extension=path.join(root,'extension');
  let context;
  try{
    context=await chromium.launchPersistentContext(profile,{headless:true,
      ...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chromium'}),
      ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging',
        `--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:10000});
    const id=new URL(worker.url()).host,panel=await context.newPage();
    await panel.setViewportSize({width:390,height:900});
    await panel.goto(`chrome-extension://${id}/panel.html`);
    await panel.evaluate(()=>{
      document.querySelector('#engine').value='local';document.querySelector('#engine').dispatchEvent(new Event('change'));
      QingReadLocal.translator=()=>({translate:async()=> '人工測試譯文；只驗證網站授權、擷取與插入。',destroy(){}});
    });
    const article=await context.newPage();
    const response=await article.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
    assert.equal(response.status(),200,'Public website was not available; do not count a block page as a passing extraction');
    await article.bringToFront();
    await panel.evaluate(()=>document.querySelector('#start').click());
    await panel.waitForFunction(()=>!document.querySelector('#grant-site').hidden);
    const urlHidden=await panel.locator('#site-entry').isVisible();
    if(urlHidden){
      await panel.evaluate(url=>{const field=document.querySelector('#site-url');field.value=url;field.dispatchEvent(new Event('input'));},url);
      assert.equal(await panel.locator('#grant-site').textContent(),'允許 '+new URL(url).hostname);
    }
    await panel.screenshot({path:path.join(results,'permission-web-before.png'),fullPage:true});
    const cdp=await context.browser().newBrowserCDPSession();
    const {targetInfos}=await cdp.send('Target.getTargets',{filter:[{type:'tab'}]});
    const target=targetInfos.find(item=>item.url===article.url());assert.ok(target);
    await cdp.send('Extensions.triggerAction',{id,targetId:target.targetId});
    await article.bringToFront();
    const extracted=await panel.evaluate(async()=>{
      const access=await requestSiteAccess(null);
      if(!access.granted)throw new Error('Native toolbar permission did not enable injection');
      const target=await inject(await activeTab());
      const batch=await send(target,{type:'qingread:collect',scope:'page',job:crypto.randomUUID()});
      return {paragraphs:batch.items.length,characters:batch.characters,
        expectedArticle:batch.items.some(item=>item.text.includes('Inspire 2026 recap'))};
    });
    assert.ok(extracted.paragraphs>5);assert.ok(extracted.characters>1000);assert.ok(extracted.expectedArticle);
    await panel.evaluate(()=>document.querySelector('#start').click());
    await panel.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('完成 '),{},{timeout:30000});
    const inserted=await article.locator('[data-qingread]').count();assert.ok(inserted>0);
    const report={url,initialUrlHidden:urlHidden,nativeToolbarGrant:true,extracted,inserted,
      scope:'isolated Chromium; real public website and extension APIs; synthetic translation; persistent permission dialog not accepted or verified'};
    fs.writeFileSync(path.join(results,'permission-web-smoke.json'),JSON.stringify(report,null,2));
    await panel.screenshot({path:path.join(results,'permission-web-after.png'),fullPage:true});
    console.log(JSON.stringify(report));
  }finally{
    await context?.close();
    const resolved=path.resolve(profile);
    if(path.dirname(resolved)!==results||!path.basename(resolved).startsWith('permission-web-'))throw new Error('Refusing to remove unexpected profile path');
    fs.rmSync(resolved,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
