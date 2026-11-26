const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const extension=path.resolve(__dirname,'../extension'),videoId='abcdefghijk';let browser;
before(async()=>{browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});});
after(async()=>{await browser?.close();});
const markup=`<ytd-watch-flexy video-id="${videoId}"></ytd-watch-flexy><ytd-watch-metadata><h1>人工測試影片</h1></ytd-watch-metadata>
<ytd-transcript-renderer style="display:block"><input placeholder="Search">
<ytd-transcript-segment-renderer style="display:block"><span class="segment-timestamp">0:03</span><span class="segment-text">Keep the original file.</span></ytd-transcript-segment-renderer>
<ytd-transcript-segment-renderer style="display:block"><span class="segment-timestamp">1:25</span><span class="segment-text">Verify the backup.</span></ytd-transcript-segment-renderer>
</ytd-transcript-renderer><div class="comments">UNRELATED COMMENTS</div>`;
async function transcript(url=`https://www.youtube.com/watch?v=${videoId}`){
 const page=await browser.newPage();
 await page.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:markup}));await page.goto(url);
 await page.evaluate(()=>{
  chrome={runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,onMessage:{addListener:fn=>globalThis.readTranscript=(options={})=>new Promise(resolve=>fn({type:'qingread:video-transcript',...options},{id:'test',url:'chrome-extension://test/panel.html'},resolve))}}};
 });
 await page.addScriptTag({path:path.join(extension,'transcript-content.js')});return page;
}
test('expanded transcript reads timed rows and excludes comments and hidden rows',async()=>{
 const page=await transcript();try{
  await page.evaluate(()=>{const hidden=document.querySelector('ytd-transcript-segment-renderer').cloneNode(true);hidden.hidden=true;hidden.querySelector('.segment-text').textContent='HIDDEN';document.querySelector('ytd-transcript-renderer').append(hidden);});
  const result=await page.evaluate(()=>readTranscript());
  assert.deepEqual(result.segments,[{start:3,text:'Keep the original file.'},{start:85,text:'Verify the backup.'}]);
  assert.equal(result.url,`https://www.youtube.com/watch?v=${videoId}`);assert.equal(result.skipped,0);
  assert.equal(result.title,'人工測試影片');
 }finally{await page.close();}
});
test('filtered, hidden, missing-time, wrong-video and unsupported transcript sources fail explicitly',async()=>{
 for(const variant of ['search','hidden','time','stale','host','order','loading']){
  const page=await transcript(variant==='host'?`https://example.test/watch?v=${videoId}`:undefined);
  try{
   await page.evaluate(variant=>{
    if(variant==='search')document.querySelector('input').value='backup';
    if(variant==='hidden')document.querySelector('ytd-transcript-renderer').hidden=true;
    if(variant==='time')document.querySelectorAll('.segment-timestamp').forEach(n=>n.remove());
    if(variant==='stale')document.querySelector('ytd-watch-flexy').setAttribute('video-id','otherid1234');
    if(variant==='order')document.querySelectorAll('.segment-timestamp')[1].textContent='0:01';
    if(variant==='loading'){
      document.querySelector('ytd-transcript-renderer').remove();
      document.body.insertAdjacentHTML('beforeend','<ytd-engagement-panel-section-list-renderer target-id="engagement-panel-searchable-transcript" visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"><tp-yt-paper-spinner active></tp-yt-paper-spinner></ytd-engagement-panel-section-list-renderer>');
    }
   },variant);
   const result=await page.evaluate(()=>readTranscript());assert.ok(result.error,variant);
   if(variant==='loading')assert.match(result.error,/仍在載入/);
  }finally{await page.close();}
 }
});
test('one click waits for the player to match the requested video before reading the transcript',async()=>{
 const page=await transcript();
 try{
  await page.clock.install();
  await page.evaluate(()=>document.querySelector('ytd-watch-flexy').setAttribute('video-id',''));
  const loading=await page.evaluate(()=>readTranscript({prepare:true,job:'loading'}));
  assert.equal(loading.pending,true);assert.equal(loading.segments,undefined);
  await page.evaluate(id=>document.querySelector('ytd-watch-flexy').setAttribute('video-id',id),videoId);
  const stabilizing=await page.evaluate(()=>readTranscript({prepare:true,job:'loading'}));
  assert.equal(stabilizing.pending,true);
  await page.clock.fastForward(700);
  const result=await page.evaluate(()=>readTranscript({prepare:true,job:'loading'}));
  assert.equal(result.videoId,videoId);assert.equal(result.segments.length,2);
 }finally{await page.close();}
});

test('invalid rows are reported as omitted instead of claiming full coverage',async()=>{
 const page=await transcript();try{
  await page.evaluate(()=>document.querySelector('.segment-timestamp').textContent='1:99');
  const result=await page.evaluate(()=>readTranscript());assert.equal(result.skipped,1);assert.equal(result.segments.length,1);
 }finally{await page.close();}
});
const modernMarkup=`<ytd-engagement-panel-section-list-renderer visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED" style="display:block">
<input placeholder="Search"><transcript-segment-view-model style="display:block">
<div aria-hidden="true" class="ytwTranscriptSegmentViewModelTimestamp">0:08</div><div class="ytwTranscriptSegmentViewModelTimestampA11yLabel">8 秒</div>
<span class="ytAttributedStringHost" role="text">Keep the <b>backup</b>.</span></transcript-segment-view-model>
<transcript-segment-view-model style="display:block"><div aria-hidden="true" class="ytwTranscriptSegmentViewModelTimestamp">24:01</div>
<span role="text">Final conclusion.</span></transcript-segment-view-model></ytd-engagement-panel-section-list-renderer>`;
test('current YouTube transcript view-model rows read timestamps, formatted text and final segments',async()=>{
 const page=await transcript();try{
  await page.evaluate(html=>{document.querySelector('ytd-transcript-renderer').remove();document.body.insertAdjacentHTML('beforeend',html);},modernMarkup);
  const result=await page.evaluate(()=>readTranscript());
  assert.deepEqual(result.segments,[{start:8,text:'Keep the backup.'},{start:1441,text:'Final conclusion.'}]);
  await page.evaluate(()=>document.querySelector('input').value='backup');
  assert.match((await page.evaluate(()=>readTranscript())).error,/搜尋條件/);
 }finally{await page.close();}
});
test('one-click preparation expands description once, opens transcript once and waits for stable modern rows',async()=>{
 const page=await transcript();try{
  await page.evaluate(html=>{
   document.querySelector('ytd-transcript-renderer').remove();
   globalThis.clicks={expand:0,open:0};
   document.querySelector('ytd-watch-metadata').insertAdjacentHTML('beforeend','<div id="description-inline-expander"><button id="expand">more</button><ytd-video-description-transcript-section-renderer hidden><button>Show transcript</button></ytd-video-description-transcript-section-renderer></div>');
   document.querySelector('#expand').onclick=()=>{clicks.expand++;document.querySelector('ytd-video-description-transcript-section-renderer').hidden=false;document.querySelector('#expand').hidden=true;};
   document.querySelector('ytd-video-description-transcript-section-renderer button').onclick=()=>{clicks.open++;setTimeout(()=>document.body.insertAdjacentHTML('beforeend',html),100);};
  },modernMarkup);
  const result=await page.evaluate(async()=>{
   const replies=[];
   for(let i=0;i<15;i++){const r=await readTranscript({prepare:true,job:'auto-test'});replies.push(r);if(!r.pending)return {replies,clicks};await new Promise(resolve=>setTimeout(resolve,100));}
   throw new Error('Never completed');
  });
  assert.deepEqual(result.clicks,{expand:1,open:1});assert.equal(result.replies.at(-1).segments.length,2);
  assert.ok(result.replies.some(r=>r.message?.includes('確認載入完成')));
 }finally{await page.close();}
});
test('preparation refuses a changed video and never opens unrelated page buttons',async()=>{
 const page=await transcript();try{
  await page.evaluate(()=>{document.querySelector('ytd-transcript-renderer').remove();document.body.insertAdjacentHTML('beforeend','<button id="unrelated">Show transcript</button>');globalThis.unrelated=0;document.querySelector('#unrelated').onclick=()=>unrelated++;});
  assert.equal((await page.evaluate(()=>readTranscript({prepare:true,job:'one'}))).pending,true);
  await page.evaluate(()=>{history.pushState({},'', '/watch?v=otherid1234');document.querySelector('ytd-watch-flexy').setAttribute('video-id','otherid1234');});
  assert.match((await page.evaluate(()=>readTranscript({prepare:true,job:'one'}))).error,/影片已變更/);
  assert.equal(await page.evaluate(()=>unrelated),0);
 }finally{await page.close();}
});

async function panel(){
 const page=await browser.newPage({viewport:{width:390,height:1000}});
 await page.route('https://panel.test/**',r=>{
  const name=new URL(r.request().url()).pathname.slice(1)||'panel.html';
  return r.fulfill({body:fs.readFileSync(path.join(extension,name)),contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.svg')?'image/svg+xml':'text/html'});
 });
 await page.addInitScript(({videoId})=>{
  const state=globalThis.harness={calls:[],messages:[],opened:[],listeners:{},segments:[{start:3,text:'x'.repeat(5500)},{start:85,text:'TAIL'}]};
  const event=name=>({addListener:fn=>(state.listeners[name]||=[]).push(fn)});
  state.emit=(name,...args)=>(state.listeners[name]||[]).forEach(fn=>fn(...args));
  globalThis.chrome={storage:{local:{setAccessLevel:async()=>{},get:async()=>({}),set:async()=>{}}},
   scripting:{executeScript:async()=>[{documentId:'doc'}]},
   tabs:{query:async()=>[{id:7,windowId:1,url:`https://www.youtube.com/watch?v=${videoId}`}],
    get:async()=>({url:state.moved?'https://www.youtube.com/watch?v=otherid1234':`https://www.youtube.com/watch?v=${videoId}`}),
    update:async(id,options)=>state.opened.push({id,...options}),create:async options=>state.opened.push(options),
    onActivated:event('activated'),onUpdated:event('updated'),onRemoved:event('removed'),
    sendMessage:async(id,message)=>{state.messages.push(message);if(message.type==='qingread:video-transcript'){
      if(state.delayCapture)return new Promise(resolve=>state.releaseCapture=()=>resolve({videoId,url:`https://www.youtube.com/watch?v=${videoId}`,segments:state.segments}));
      if(state.capturePending)return {pending:true,message:'正在等待字幕載入…'};
      if(state.captureError)return {error:'無法讀取逐字稿'};
      return {videoId,url:`https://www.youtube.com/watch?v=${videoId}`,title:'人工測試影片',segments:state.segments,skipped:1};
    }return {ok:true};}
   }};
  Object.defineProperty(globalThis,'Translator',{configurable:true,value:{availability:async()=>'available'}});
 },{videoId});
 await page.goto('https://panel.test/panel.html');
 await page.evaluate(()=>{
  QingReadLocal.request=async(path,options)=>{
    harness.calls.push(options.body);
    if(harness.wait && harness.calls.length===2){
      harness.signal=options.signal;
      return new Promise(resolve=>harness.release=()=>resolve({text:'晚到的結果',modelIdentity:'a'.repeat(64)}));
    }
    if(harness.fail && harness.calls.length===2)throw new Error('模型中斷');
    return {text:options.body.summaryMode==='video-overview'?'總覽：保留原檔並確認備份。':'重點：確認備份。 <script>unsafe()</script>',modelIdentity:'a'.repeat(64)};
  };
 });
 await page.locator('[data-view=summary]').click();return page;
}
test('video summary UI includes late transcript content, source coverage, safe text, timestamp navigation and copying',async()=>{
 const page=await panel();try{
  await page.locator('#vs-start').click();await page.waitForFunction(()=>document.querySelector('#vs-status').textContent.includes('影片摘要已完成'));
  assert.equal(await page.locator('#vs-notes article').count(),2);
  assert.match(await page.locator('#vs-source').textContent(),/未確認涵蓋全片/);
  assert.match(await page.locator('#vs-source').textContent(),/另有 1 段/);
  assert.ok(await page.evaluate(()=>harness.calls[1].text.endsWith('TAIL')));
  assert.equal(await page.locator('#vs-notes script').count(),0);
  await page.locator('#vs-notes a').first().click();
  assert.deepEqual(await page.evaluate(()=>harness.opened[0]),{id:7,url:`https://www.youtube.com/watch?v=${videoId}&t=3s`,active:true});
  await page.evaluate(()=>{harness.moved=true;});await page.locator('#vs-notes a').last().click();
  assert.equal((await page.evaluate(()=>harness.opened[1])).id,undefined,'Do not navigate a tab now showing a different video');
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>harness.copied=text},configurable:true}));
  await page.locator('#vs-copy').click();assert.match(await page.evaluate(()=>harness.copied),/總覽：保留原檔/);
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false);
  fs.mkdirSync(path.join(__dirname,'../test-results'),{recursive:true});
  await page.screenshot({path:path.join(__dirname,'../test-results/video-summary-panel.png'),fullPage:true});
 }finally{await page.close();}
});
test('stop preserves completed chunks, aborts the active job, and ignores late results',async()=>{
 const page=await panel();try{
  await page.evaluate(()=>harness.wait=true);await page.locator('#vs-start').click();
  await page.waitForFunction(()=>Boolean(harness.release));await page.locator('#vs-stop').click();
  assert.equal(await page.evaluate(()=>harness.signal.aborted),true);assert.equal(await page.locator('#vs-notes article').count(),1);
  await page.evaluate(()=>harness.release());await page.waitForFunction(()=>document.querySelector('#vs-status').textContent.includes('助手已確認'));
  assert.equal(await page.locator('#vs-notes article').count(),1);assert.equal(await page.locator('#vs-overview').textContent(),'');
  assert.equal(await page.locator('#vs-copy').isEnabled(),true);
 }finally{await page.close();}
});
test('captured source survives tab changes and closure; pre-capture navigation cancels late extraction',async()=>{
 const page=await panel();try{
  await page.evaluate(()=>harness.wait=true);await page.locator('#vs-start').click();await page.waitForFunction(()=>Boolean(harness.release));
  await page.evaluate(()=>{harness.emit('activated',{tabId:8,windowId:1});harness.emit('removed',7);});
  assert.equal(await page.evaluate(()=>harness.signal.aborted),false);
  assert.match(await page.locator('#vs-source').textContent(),/保留開始時讀取/);
  await page.evaluate(()=>harness.release());await page.waitForFunction(()=>document.querySelector('#vs-status').textContent.includes('影片摘要已完成'));
  await page.evaluate(()=>{harness.delayCapture=true;harness.calls=[];});await page.locator('#vs-start').click();
  await page.waitForFunction(()=>Boolean(harness.releaseCapture));
  await page.evaluate(()=>{harness.emit('updated',7,{url:'https://www.youtube.com/watch?v=otherid1234'});harness.releaseCapture();});
  await page.waitForFunction(()=>document.querySelector('#vs-status').textContent.includes('擷取前影片已變更'));
  assert.equal(await page.evaluate(()=>harness.calls.length),0);
 }finally{await page.close();}
});
test('missing transcript sends no model requests; inference failure keeps partial notes and supports retry',async()=>{
 const page=await panel();try{
  await page.evaluate(()=>harness.captureError=true);await page.locator('#vs-start').click();await page.waitForFunction(()=>document.querySelector('#vs-status').textContent.includes('無法讀取逐字稿'));
  assert.equal(await page.evaluate(()=>harness.calls.length),0);
  await page.evaluate(()=>{harness.captureError=false;harness.fail=true;});await page.locator('#vs-start').click();
  await page.waitForFunction(()=>document.querySelector('#vs-status').textContent.includes('整份摘要尚未完成'));
  assert.equal(await page.locator('#vs-notes article').count(),1);
  await page.evaluate(()=>{harness.fail=false;harness.calls=[];});await page.locator('#vs-start').click();
  await page.waitForFunction(()=>document.querySelector('#vs-status').textContent.includes('影片摘要已完成'));
  assert.equal(await page.locator('#vs-notes article').count(),2);
 }finally{await page.close();}
});
test('preparation polling shows progress, stops immediately and can retry without a model request',async()=>{
 const page=await panel();try{
  await page.evaluate(()=>harness.capturePending=true);await page.locator('#vs-start').click();
  await page.waitForFunction(()=>harness.messages.filter(m=>m.type==='qingread:video-transcript').length>=2);
  assert.match(await page.locator('#vs-status').textContent(),/等待字幕載入/);
  assert.equal(await page.evaluate(()=>harness.calls.length),0);
  await page.locator('#vs-stop').click();
  const count=await page.evaluate(()=>harness.messages.length);await page.waitForTimeout(400);
  assert.equal(await page.evaluate(()=>harness.messages.length),count);
  await page.evaluate(()=>harness.capturePending=false);await page.locator('#vs-start').click();
  await page.waitForFunction(()=>document.querySelector('#vs-status').textContent.includes('影片摘要已完成'));
  const jobs=await page.evaluate(()=>harness.messages.filter(m=>m.type==='qingread:video-transcript').map(m=>m.job));
  assert.ok(jobs.every(Boolean));assert.notEqual(jobs[0],jobs.at(-1));
 }finally{await page.close();}
});
test('preparation timeout is bounded and never summarizes unrelated text',async()=>{
 const page=await panel();try{
  await page.evaluate(()=>{harness.capturePending=true;const now=Date.now;let elapsed=0;Date.now=()=>now()+elapsed++*31000;});
  await page.locator('#vs-start').click();
  await page.waitForFunction(()=>document.querySelector('#vs-status').textContent.includes('已等候 30 秒'));
  assert.equal(await page.evaluate(()=>harness.calls.length),0);assert.equal(await page.locator('#vs-start').isEnabled(),true);
 }finally{await page.close();}
});
test('summary detail changes output requests without reducing source and renders safe readable formatting',async()=>{
 const page=await panel();try{
  await page.evaluate(()=>{
   QingReadLocal.request=async(path,options)=>{harness.calls.push(options.body);return {text:'**總覽：** 保留原檔。\n\n1. **確認備份**\n2. <img src=x onerror=alert(1)>\n\n* 不要刪除。',modelIdentity:'a'.repeat(64),timings:{promptMs:1200,generationMs:2300,loadMs:100,queueMs:0}};};
  });
  assert.equal(await page.locator('#vs-detail').inputValue(),'concise');
  await page.locator('#vs-start').click();await page.waitForFunction(()=>document.querySelector('#vs-status').textContent.includes('影片摘要已完成'));
  assert.ok(await page.evaluate(()=>harness.calls.every(value=>value.summaryDetail==='concise')));
  assert.equal(await page.locator('#vs-overview strong').count(),2);
  assert.equal(await page.locator('#vs-overview ol li').count(),2);assert.equal(await page.locator('#vs-overview ul li').count(),1);
  assert.equal(await page.locator('#vs-output img').count(),0);assert.doesNotMatch(await page.locator('#vs-overview').textContent(),/\*\*/);
  assert.match(await page.locator('#vs-timing').textContent(),/讀取原文 3.6 秒、生成文字 6.9 秒/);
  const first=await page.evaluate(()=>harness.calls.filter(value=>value.summaryMode==='video-chunk').map(value=>value.text));
  await page.locator('#vs-detail').selectOption('detailed');await page.evaluate(()=>harness.calls=[]);
  await page.locator('#vs-start').click();await page.waitForFunction(()=>document.querySelector('#vs-status').textContent.includes('影片摘要已完成'));
  assert.ok(await page.evaluate(()=>harness.calls.every(value=>!value.summaryDetail)));
  assert.deepEqual(await page.evaluate(()=>harness.calls.filter(value=>value.summaryMode==='video-chunk').map(value=>value.text)),first);
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:async value=>harness.copied=value},configurable:true}));
  await page.locator('#vs-copy').click();assert.doesNotMatch(await page.evaluate(()=>harness.copied),/\*\*/);
 }finally{await page.close();}
});
