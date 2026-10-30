const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright');
let browser;
before(async()=>{browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});});
after(async()=>{await browser?.close();});
async function pageForLongContent(){
  const page=await browser.newPage();
  await page.route('https://example.test/**',route=>route.fulfill({contentType:'text/html',body:'<html><body></body></html>'}));
  await page.goto('https://example.test');
  await page.setContent('<main id="root">'+ '<section>'.repeat(8)+Array.from({length:300},(_,i)=>`<p id="p${i}">${Array.from({length:10},(_,j)=>`<span>Sentence ${i} word ${j}. </span>`).join('')}</p>`).join('')+'</section>'.repeat(8)+'</main>');
  await page.evaluate(()=>{
    globalThis.styles=0;globalThis.ticks=0;
    const original=getComputedStyle;
    window.getComputedStyle=(...args)=>{styles++;return original(...args);};
    globalThis.chrome={runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,onMessage:{addListener:fn=>{globalThis.listener=fn;}}}};
    globalThis.message=msg=>new Promise(resolve=>listener(msg,{id:'test',url:'chrome-extension://test/panel.html'},resolve));
  });
  await page.addScriptTag({path:path.resolve(__dirname,'../extension/content.js')});
  return page;
}
test('long extraction reuses ancestor checks and yields without changing limits or summary order',async()=>{
  const page=await pageForLongContent();
  try{
    const result=await page.evaluate(async()=>{
      const timer=setInterval(()=>ticks++,0),started=performance.now();
      const batch=await message({type:'qingread:summary-source',job:'long',scope:'page'});
      clearInterval(timer);return {batch,styles,ticks,ms:performance.now()-started};
    });
    fs.mkdirSync(path.resolve(__dirname,'../test-results'),{recursive:true});
    fs.writeFileSync(path.resolve(__dirname,'../test-results/extraction-benchmark.json'),JSON.stringify(result,null,2));
    assert.equal(result.batch.items.length,200);assert.equal(result.batch.limited,true);
    assert.match(result.batch.items[0].text,/Sentence 0 word 0/);
    assert.match(result.batch.items[199].text,/Sentence 199 word 0/);
    assert.ok(result.styles<7500,`Repeated style checks: ${result.styles}`);
    assert.ok(result.ticks>0,'Long extraction must allow browser tasks to run');
  }finally{await page.close();}
});
test('new extraction and apply recheck changed ancestor styles and dynamic content',async()=>{
  const page=await pageForLongContent();
  try{
    const first=await page.evaluate(()=>message({type:'qingread:collect',job:'one',scope:'page'}));
    await page.evaluate(()=>{document.querySelector('#root').style.display='none';});
    assert.equal((await page.evaluate(item=>message({type:'qingread:apply',job:'one',id:item.id,text:'不可顯示'}),first.items[0])).applied,false);
    assert.equal((await page.evaluate(()=>message({type:'qingread:collect',job:'hidden',scope:'page'}))).items.length,0);
    await page.evaluate(()=>{document.querySelector('#root').style.display='';document.querySelector('#p0').textContent='New visible content after mutation.';});
    const next=await page.evaluate(()=>message({type:'qingread:summary-source',job:'visible',scope:'page'}));
    assert.equal(next.items[0].text,'New visible content after mutation.');
  }finally{await page.close();}
});
test('cancel or page mutation during a collection prevents partial mixed snapshots',async()=>{
  for(const mode of ['cancel','mutation']){
    const page=await pageForLongContent();
    try{
      const result=await page.evaluate(async mode=>{
        const pending=message({type:'qingread:collect',job:'changing',scope:'page'});
        setTimeout(()=>{if(mode==='cancel')void message({type:'qingread:cancel',job:'changing'});else document.querySelector('#root').style.visibility='hidden';},0);
        return pending;
      },mode);
      assert.equal(result.error,'changed');assert.equal(result.items,undefined);
    }finally{await page.close();}
  }
});
