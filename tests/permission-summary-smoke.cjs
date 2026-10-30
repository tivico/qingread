// Real extension, native toolbar activeTab grant, and the reported public article.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
  const root=path.resolve(__dirname,'..'),results=path.join(root,'test-results');fs.mkdirSync(results,{recursive:true});
  const profile=fs.mkdtempSync(path.join(results,'permission-summary-')),extension=path.join(root,'extension');
  const context=await chromium.launchPersistentContext(profile,{headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chromium'}),ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging',`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
  try{
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:10000});
    const id=new URL(worker.url()).host,panel=await context.newPage();await panel.goto(`chrome-extension://${id}/panel.html`);
    await panel.evaluate(()=>{QingReadLocal.request=async()=>({text:'人工測試：已讀取公告正文。'});document.querySelector('[data-view=summary]').click();});
    const article=await context.newPage();
    await article.goto('https://aa.nttu.edu.tw/p/406-1002-179272,r1386.php?Lang=zh-tw',{waitUntil:'domcontentloaded',timeout:60000});
    await article.bringToFront();
    await panel.evaluate(()=>document.querySelector('#summary-start').click());
    await panel.waitForFunction(()=>!document.querySelector('#summary-grant').hidden);
    const hidden=await panel.locator('#summary-site-entry').isVisible();
    const cdp=await context.browser().newBrowserCDPSession();
    const {targetInfos}=await cdp.send('Target.getTargets',{filter:[{type:'tab'}]});
    const target=targetInfos.find(item=>item.url===article.url());assert.ok(target);
    await cdp.send('Extensions.triggerAction',{id,targetId:target.targetId});
    await article.bringToFront();
    // Check the permission path after the native toolbar action. No chrome APIs are mocked.
    await panel.evaluate(async()=>{globalThis.permissionResult=await requestSiteAccess(null);});
    assert.equal(await panel.evaluate(()=>permissionResult.granted),true);
    const extracted=await panel.evaluate(async()=>{
      const tab=await activeTab(),target=await inject(tab),batch=await send(target,{type:'qingread:summary-source',job:crypto.randomUUID(),scope:'page'});
      return {characters:batch.characters,paragraphs:batch.items?.length};
    });
    assert.ok(extracted.characters>100);assert.ok(extracted.paragraphs>0);
    await panel.evaluate(()=>document.querySelector('#summary-start').click());
    await panel.waitForFunction(()=>document.querySelector('#summary-status').textContent.includes('摘要已完成'));
    const report={initialUrlHidden:hidden,nativeToolbarGrant:true,extracted,summaryCompleted:true,scope:'real browser and public page; synthetic model reply; no saved credentials'};
    fs.writeFileSync(path.join(results,'permission-summary-smoke.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
  }finally{await context.close();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
