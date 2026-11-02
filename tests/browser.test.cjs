const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
let browser;
const extension = path.resolve(__dirname, '../extension');
before(async () => {
  fs.mkdirSync(path.join(__dirname, '../test-results'), { recursive: true });
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
});
after(async () => { await browser?.close(); });
test('video captions start with masked tab URL and translate a stable original cue',async()=>{
 const page=await panelFixture();
 try {
  await page.evaluate(()=>{
   chrome.tabs.query=async()=>[{id:7}];
   chrome.tabs.sendMessage=async(id,message,options)=>{
    harness.messages.push({...message,documentId:options.documentId});
    if(message.type==='qingread:media-start')return {ok:true};
    if(message.type==='qingread:media-read')return {text:'Do not delete the backup.',version:1};
    return {ok:true};
   };
  });
  await page.locator('[data-view=video]').click();await page.locator('#video-start').click();
  await page.waitForFunction(()=>harness.messages.some(m=>m.type==='qingread:media-show'));
  const state=await page.evaluate(()=>harness);
  assert.equal(state.userActivation,true);assert.equal(state.injected,1);
  assert.equal(state.messages.find(m=>m.type==='qingread:media-show').text,'請勿刪除備份。');
  assert.equal(state.messages.find(m=>m.type==='qingread:media-start').documentId,'doc-7');
  await page.locator('#video-stop').click();
  assert.equal(await page.locator('#video-start').isEnabled(),true);
  assert.equal(await page.evaluate(()=>harness.destroyed),1);
 }finally{await page.close();}
});
test('video reports real permission failures before model download and cleans up the late engine',async()=>{
 const page=await panelFixture();
 try {
  await page.evaluate(()=>{
   Translator.create=()=>new Promise(resolve=>{harness.finishCreate=()=>resolve({destroy(){harness.destroyed++;}});});
   chrome.scripting.executeScript=async()=>{throw new Error('Cannot access contents of url "https://www.youtube.com/watch?v=test". Extension manifest must request permission to access this host.');};
  });
  await page.locator('[data-view=video]').click();await page.locator('#video-start').click();
  await page.waitForFunction(()=>!document.querySelector('#video-access').hidden);
  assert.equal(await page.locator('#video-start').isEnabled(),true);
  await page.evaluate(()=>harness.finishCreate());
  await page.waitForFunction(()=>harness.destroyed===1);
  await page.locator('#video-access').click();
  assert.equal(await page.locator('#grant-site').isVisible(),true);
  assert.match(await page.locator('#detail').textContent(),/PageAccessError/);
 }finally{await page.close();}
});
test('stopping video during engine setup prevents late caption startup',async()=>{
 const page=await panelFixture();
 try {
  await page.evaluate(()=>{Translator.create=()=>new Promise(resolve=>{harness.finishCreate=()=>resolve({destroy(){harness.destroyed++;}});});});
  await page.locator('[data-view=video]').click();await page.locator('#video-start').click();
  await page.waitForFunction(()=>Boolean(harness.finishCreate));await page.locator('#video-stop').click();
  await page.evaluate(()=>harness.finishCreate());await page.waitForFunction(()=>harness.destroyed===1);
  assert.equal(await page.evaluate(()=>harness.messages.some(m=>m.type==='qingread:media-start')),false);
 }finally{await page.close();}
});
test('caption controller reuses repeated translations within one session and resets on restart', async () => {
  const page = await panelFixture();
  try {
    await page.evaluate(() => {
      harness.cue = { text:'Keep the backup.', version:1, timelineVersion:1 };
      chrome.tabs.sendMessage = async (_id, message) => {
        harness.messages.push(message);
        return message.type === 'qingread:media-read' ? harness.cue : { ok:true, applied:true };
      };
    });
    await page.locator('[data-view=video]').click();
    assert.equal(await page.locator('#video-bilingual').isChecked(), true);
    await page.locator('#video-start').click();
    await page.waitForFunction(() => harness.messages.filter(m => m.type === 'qingread:media-show').length === 1);
    assert.equal(await page.locator('#video-bilingual').isDisabled(), true);
    assert.equal(await page.evaluate(() => harness.messages.find(m => m.type === 'qingread:media-start').bilingual), true);
    await page.evaluate(() => { harness.cue.version = 2; });
    await page.waitForFunction(() => harness.messages.filter(m => m.type === 'qingread:media-show').length === 2);
    assert.equal(await page.evaluate(() => harness.translations.length), 1);
    await page.locator('#video-stop').click();
    assert.equal(await page.locator('#video-mode').isEnabled(), true);
    await page.locator('#video-bilingual').uncheck();
    await page.locator('#video-start').click();
    await page.waitForFunction(() => harness.translations.length === 2);
    assert.equal(await page.evaluate(() => harness.messages.filter(m => m.type === 'qingread:media-start').at(-1).bilingual), false);
    await page.locator('#video-stop').click();
  } finally { await page.close(); }
});

test('caption controller observes new cues while the engine is busy and translates only the latest', async () => {
  const page = await panelFixture();
  try {
    await page.evaluate(() => {
      harness.cue = { text:'First sentence.', version:1, timelineVersion:1 };
      chrome.tabs.sendMessage = async (_id, message) => {
        harness.messages.push(message);
        return message.type === 'qingread:media-read' ? harness.cue : { ok:true, applied:true };
      };
      Translator.create = async () => ({
        translate(text) {
          harness.translations.push(text);
          if (text === 'First sentence.') return new Promise(resolve => { harness.finishFirst = () => resolve('第一句'); });
          return Promise.resolve('最新一句');
        }, destroy() {}
      });
    });
    await page.locator('[data-view=video]').click();
    await page.locator('#video-start').click();
    await page.waitForFunction(() => Boolean(harness.finishFirst));
    await page.evaluate(() => { harness.cue = { text:'Intermediate sentence.', version:2, timelineVersion:1 }; });
    await page.waitForFunction(() => harness.messages.filter(m => m.type === 'qingread:media-read').length >= 6);
    await page.evaluate(() => { harness.cue = { text:'Latest sentence.', version:3, timelineVersion:1 }; harness.finishFirst(); });
    await page.waitForFunction(() => harness.translations.length === 2);
    assert.deepEqual(await page.evaluate(() => harness.translations), ['First sentence.', 'Latest sentence.']);
    await page.locator('#video-stop').click();
  } finally { await page.close(); }
});

test('caption status follows visible captions and reports slow or skipped results without pausing playback', async () => {
  const page = await panelFixture('pending');
  try {
    await page.clock.install({ time: new Date('2026-10-29T00:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-29T00:00:01Z'));
    await page.evaluate(() => {
      harness.cue = {text:'First complete sentence.',version:1,timelineVersion:1,paused:false,display:{visible:false,current:false}};
      harness.applied = true;
      chrome.tabs.sendMessage = async (_id, message) => {
        harness.messages.push(message);
        return message.type === 'qingread:media-read' ? harness.cue : {ok:true,applied:harness.applied};
      };
    });
    await page.locator('[data-view=video]').click();
    await page.locator('#video-start').click();
    await page.clock.runFor(3500);
    assert.match(await page.locator('#video-status').textContent(), /正在等翻譯.*影片持續播放/);
    await page.evaluate(() => harness.release());
    await page.clock.runFor(250);
    assert.doesNotMatch(await page.locator('#video-status').textContent(), /舒適閱讀中/,
      'An accepted result is not proof it is actually visible');
    await page.evaluate(() => { harness.cue.display = {visible:true,current:true}; });
    await page.clock.runFor(250);
    assert.match(await page.locator('#video-status').textContent(), /舒適閱讀中.*最近翻譯/);
    await page.evaluate(() => {
      harness.cue = {...harness.cue,text:'A different topic.',version:2,display:{visible:false,current:false}};
      harness.applied = false;
    });
    await page.clock.runFor(1000);
    await page.evaluate(() => harness.release());
    await page.clock.runFor(250);
    assert.match(await page.locator('#video-status').textContent(), /已略過 1 段過期結果/);
    assert.doesNotMatch(await page.locator('#video-status').textContent(), /舒適閱讀中/);
    assert.equal(await page.evaluate(() => harness.messages.some(m => /pause|seek|rate/.test(m.type))), false);
    await page.locator('#video-stop').click();
    assert.equal(await page.locator('#video-status').textContent(), '字幕已停止。');
  } finally { await page.close(); }
});

async function speechPanel(){
  const page=await panelFixture();
  await page.evaluate(()=>{
    harness.recognizers=[];harness.timeline=1;harness.time=4.5;harness.trackStops=0;
    chrome.permissions={request:async()=>true};chrome.runtime={sendMessage:async()=>({streamId:'synthetic'})};
    const track={stop(){harness.trackStops++;},addEventListener(){}};
    Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>({getTracks:()=>[track]})}});
    globalThis.AudioContext=class{constructor(){this.audioWorklet={addModule:async()=>{}};this.destination={};}createMediaStreamSource(){return {connect(){}};}async resume(){}async close(){}};
    globalThis.AudioWorkletNode=class{constructor(){this.port={postMessage(message){harness.audioEpoch=message.epoch;harness.resets=(harness.resets||0)+1;}};harness.audioPort=this.port;}connect(){}};
    chrome.tabs.sendMessage=async(_id,message)=>{
      harness.messages.push(message);
      if(message.type==='qingread:media-read')return {paused:false,time:harness.time,timelineVersion:harness.timeline};
      return {ok:true,applied:true};
    };
    Translator.create=async()=>({destroy(){},translate:async text=>{harness.translations.push(text);return '測試譯文';}});
    QingReadLocal.request=async(path,options)=>{
      harness.speechSignal=options.signal;
      return new Promise(resolve=>harness.recognizers.push(resolve));
    };
    harness.emitFrame=sequence=>{harness.time=4.5+sequence*4;harness.audioPort.onmessage({data:{samples:new Float32Array(72000),sequence,epoch:harness.audioEpoch||0,durationMs:4500,overlapMs:sequence?500:0}});};
  });
  await page.locator('[data-view=video]').click();await page.selectOption('#video-mode','speech');await page.locator('#video-start').click();
  await page.waitForFunction(()=>Boolean(harness.audioPort));
  return page;
}
test('speech keeps only the latest waiting frame, rejects seeked audio, and stops late results',async()=>{
  const page=await speechPanel();
  try{
    await page.evaluate(()=>harness.emitFrame(0));await page.waitForFunction(()=>harness.recognizers.length===1);
    await page.evaluate(()=>harness.emitFrame(1));await page.evaluate(()=>harness.emitFrame(2));
    await page.evaluate(()=>harness.recognizers[0]({text:'Please keep the original file.',segments:[{start:0,end:4}]}));
    await page.waitForFunction(()=>harness.recognizers.length===2);
    assert.equal(await page.evaluate(()=>harness.translations.length),1);
    await page.evaluate(()=>harness.recognizers[1]({text:'The original file is safe.',segments:[{start:0,end:4}]}));
    await page.waitForFunction(()=>harness.translations.length===2);
    assert.equal(await page.evaluate(()=>harness.translations[1]),'The original file is safe.','A skipped window must not remove a coincidental repeat');
    await page.waitForFunction(()=>document.querySelector('#video-status').textContent.includes('最近辨識'));
    assert.match(await page.locator('#video-status').textContent(),/已略過 1 段/);
    await page.evaluate(()=>harness.emitFrame(3));await page.waitForFunction(()=>harness.recognizers.length===3);
    await page.evaluate(()=>{harness.timeline++;harness.recognizers[2]({text:'Old timeline audio',segments:[]});});
    await page.waitForFunction(()=>document.querySelector('#video-status').textContent.includes('已略過 2 段'));
    await page.waitForFunction(()=>harness.resets===1);
    await page.evaluate(()=>harness.audioPort.onmessage({data:{samples:new Float32Array(72000),sequence:3,epoch:0}}));
    assert.equal(await page.evaluate(()=>harness.recognizers.length),3,'An old worklet message arriving after reset must be rejected');
    assert.equal(await page.evaluate(()=>harness.translations.length),2);
    await page.evaluate(()=>harness.emitFrame(4));await page.waitForFunction(()=>harness.recognizers.length===4);
    await page.locator('#video-stop').click();
    assert.equal(await page.evaluate(()=>harness.speechSignal.aborted),true);
    await page.evaluate(()=>harness.recognizers[3]({text:'Late after stop',segments:[]}));
    assert.equal(await page.evaluate(()=>harness.translations.length),2);
    assert.equal(await page.evaluate(()=>harness.trackStops),1);
  }finally{await page.close();}
});
test('speech deduplicates only overlapping adjacent windows and exposes stage timings',async()=>{
  const page=await speechPanel();
  try{
    await page.evaluate(()=>harness.emitFrame(0));await page.waitForFunction(()=>harness.recognizers.length===1);
    await page.evaluate(()=>harness.recognizers[0]({text:'Please keep the original file.',segments:[{start:0,end:4}]}));
    await page.waitForFunction(()=>document.querySelector('#video-status').textContent.includes('最近辨識'));
    await page.evaluate(()=>harness.emitFrame(1));await page.waitForFunction(()=>harness.recognizers.length===2);
    await page.evaluate(()=>harness.recognizers[1]({text:'The original file is safe.',segments:[{start:0,end:3}]}));
    await page.waitForFunction(()=>harness.translations.length===2);
    assert.equal(await page.evaluate(()=>harness.translations[1]),'is safe.');
    await page.waitForFunction(()=>document.querySelector('#video-status').textContent.includes('最近辨識'));
    assert.match(await page.locator('#video-status').textContent(),/辨識.*秒＋翻譯.*秒/);
    await page.locator('#video-stop').click();
  }finally{await page.close();}
});

async function fixture(url='https://fixture.test/') {
  const page = await browser.newPage();
  await page.route(new URL(url).origin+'/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: fs.readFileSync(path.join(__dirname, 'fixture.html')) }));
  await page.goto(url);
  await page.evaluate(() => {
    const attach = Element.prototype.attachShadow;
    globalThis.testShadows = new WeakMap();
    Element.prototype.attachShadow = function (options) { const shadow = attach.call(this, options); testShadows.set(this, shadow); return shadow; };
    globalThis.chrome = { runtime: { id: 'test', getURL: p => 'chrome-extension://test/' + p, onMessage: { addListener: fn => { globalThis.listener = fn; } } } };
    globalThis.message = msg => new Promise(resolve => listener(msg, { id: 'test', url: 'chrome-extension://test/panel.html' }, resolve));
  });
  await page.addScriptTag({ path: path.join(extension, 'content.js') });
  return page;
}
test('extraction excludes hidden, form, editable and code content; inline text is preserved', async () => {
  const page = await fixture();
  try {
    const result = await page.evaluate(() => message({ type: 'qingread:collect', job: 'one', scope: 'page' }));
    const text = result.items.map(i => i.text).join('\n');
    assert.doesNotMatch(text, /SECRET/);
    assert.match(text, /Friday\. Do not delete the backup\./);
    assert.match(text, /Keep inline spaces\./);
    assert.ok(result.items.length > 3);
  } finally { await page.close(); }
});
const moeaArticleUrl='https://www.moea.gov.tw/MNS/doit/industrytech/IndustryTech.aspx?menu_id=13545&it_id=563#top';
test('MOEA page-wrapper form yields article prose without form controls or site chrome',async()=>{
  const page=await fixture(moeaArticleUrl);
  try{
    await page.setContent(fs.readFileSync(path.join(__dirname,'fixtures/moea-article.html'),'utf8'));
    const result=await page.evaluate(async()=>{
      const summary=await message({type:'qingread:summary-source',job:'summary',scope:'page'});
      const batch=await message({type:'qingread:collect',job:'translate',scope:'page'});
      const item=batch.items.find(item=>item.text.startsWith('第一段'));
      const applied=item?await message({type:'qingread:apply',job:'translate',id:item.id,text:'人工譯文'}):null;
      const again=await message({type:'qingread:summary-source',job:'summary2',scope:'page'});
      return {summary,batch,applied,again};
    });
    const expected=['科技文章','人工圖譜文章','這是人工文章摘要。','第一段說明圖譜如何連結資料。','第二段說明導入成本與維護需求。'];
    assert.deepEqual(result.summary.items.map(item=>item.text),expected);
    assert.deepEqual(result.batch.items.map(item=>item.text),expected);
    assert.equal(result.applied.applied,true);
    assert.deepEqual(result.again.items.map(item=>item.text),expected,'Summary reads originals after translation');
  }finally{await page.close();}
});

test('MOEA form exception is scoped by host, article path and verified page structure',async()=>{
  for(const variant of ['other-host','other-path','missing-state','missing-title','nested-form-container']){
    const url=variant==='other-host'?'https://example.test/MNS/doit/industrytech/IndustryTech.aspx':variant==='other-path'?'https://www.moea.gov.tw/account':moeaArticleUrl;
    const page=await fixture(url);
    try{
      await page.setContent(fs.readFileSync(path.join(__dirname,'fixtures/moea-article.html'),'utf8'));
      await page.evaluate(variant=>{
        if(variant==='missing-state')document.querySelector('[name=__VIEWSTATE]').remove();
        if(variant==='missing-title')document.querySelector('#holderContent_lblTitle').remove();
        if(variant==='nested-form-container'){const container=document.createElement('section');document.body.prepend(container);container.append(document.querySelector('form'));}
      },variant);
      const result=await page.evaluate(()=>message({type:'qingread:summary-source',job:'test',scope:'page'}));
      assert.equal(result.items.length,0,variant);
    }finally{await page.close();}
  }
});

test('MOEA article eligibility is recomputed before applying a delayed translation',async()=>{
  const page=await fixture(moeaArticleUrl);
  try{
    await page.setContent(fs.readFileSync(path.join(__dirname,'fixtures/moea-article.html'),'utf8'));
    const result=await page.evaluate(async()=>{
      const batch=await message({type:'qingread:collect',job:'old',scope:'page'});
      const item=batch.items.find(item=>item.text.startsWith('第一段'));
      document.querySelector('[name=__VIEWSTATE]').remove();
      return {found:Boolean(item),applied:item?await message({type:'qingread:apply',job:'old',id:item.id,text:'舊譯文'}):null};
    });
    assert.equal(result.found,true);assert.equal(result.applied.applied,false);
  }finally{await page.close();}
});

test('selected translation sends only the selected characters', async () => {
  const page = await fixture();
  try {
    const result = await page.evaluate(() => {
      const range = document.createRange(), node = document.querySelector('#selection').firstChild;
      range.setStart(node, 0); range.setEnd(node, 26);
      getSelection().removeAllRanges(); getSelection().addRange(range);
      return message({ type: 'qingread:collect', job: 'select', scope: 'selection' });
    });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].text, 'Select only this sentence.');
  } finally { await page.close(); }
});
test('safe insertion, stale-result rejection, deduplication and restoration', async () => {
  const page = await fixture();
  try {
    const outcome = await page.evaluate(async () => {
      const before = document.querySelector('#article').innerHTML;
      const batch = await message({ type: 'qingread:collect', job: 'safe', scope: 'page' });
      const article = batch.items.find(i => i.text.startsWith('The deployment'));
      const applied = await message({ type: 'qingread:apply', job: 'safe', id: article.id, text: '<img src=x onerror="window.pwned=true">' });
      const count = document.querySelectorAll('[data-qingread]').length;
      const shadow = testShadows.get(document.querySelector('[data-qingread]'));
      const noImage = shadow.querySelector('img') === null && shadow.querySelector('span').textContent.startsWith('<img') && !window.pwned;
      const next = await message({ type: 'qingread:collect', job: 'next', scope: 'page' });
      const noDuplicate = !next.items.some(i => i.text.startsWith('The deployment'));
      const changed = next.items.find(i => i.text.startsWith('This list'));
      document.querySelector('#item').firstChild.textContent = 'Changed by the website.';
      const stale = await message({ type: 'qingread:apply', job: 'next', id: changed.id, text: '舊譯文' });
      const oldJob = await message({ type: 'qingread:apply', job: 'safe', id: article.id, text: '延遲結果' });
      await message({ type: 'qingread:restore' });
      return { applied, count, noImage, noDuplicate, stale, oldJob, restored: document.querySelectorAll('[data-qingread]').length === 0, unchanged: before === document.querySelector('#article').innerHTML };
    });
    assert.equal(outcome.applied.applied, true);
    assert.equal(outcome.count, 1);
    for (const key of ['noImage', 'noDuplicate', 'restored', 'unchanged']) assert.equal(outcome[key], true, key);
    assert.equal(outcome.stale.applied, false);
    assert.equal(outcome.oldJob.applied, false);
  } finally { await page.close(); }
});

async function panelFixture(mode = 'normal') {
  const page = await browser.newPage({ viewport: { width: 380, height: 1000 } });
  await page.route('https://panel.test/**', route => {
    const relative = new URL(route.request().url()).pathname.slice(1) || 'panel.html';
    return route.fulfill({ body: fs.readFileSync(path.join(extension, relative)), contentType: relative.endsWith('.svg') ? 'image/svg+xml' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.js') ? 'text/javascript' : 'text/html' });
  });
  await page.addInitScript(({ mode }) => {
    const state = globalThis.harness = { messages: [], translations: [], currentTab: 7, mode, created: 0, destroyed: 0, userActivation: false, injected: 0 };
    const items = [{ id: 'one', text: 'The default software uses a mouse.' }, { id: 'two', text: 'Do not delete the backup.' }];
    globalThis.chrome = {
      storage: { local: { setAccessLevel: async () => {}, get: async () => ({}), set: async () => {} } },
      scripting: { executeScript: async () => { state.injected++; return [{ documentId: 'doc-7', frameId: 0 }]; } },
      tabs: {
        query: async () => [{ id: state.currentTab, url: 'https://article.test/' }],
        onActivated: { addListener: fn => { const previous=state.onActivated; state.onActivated=(...args)=>{previous?.(...args);fn(...args);}; } },
        onUpdated: { addListener: fn => { const previous=state.onUpdated; state.onUpdated=(...args)=>{previous?.(...args);fn(...args);}; } },
        onRemoved: { addListener: fn => { const previous=state.onRemoved; state.onRemoved=(...args)=>{previous?.(...args);fn(...args);}; } },
        sendMessage: async (id, message, options) => {
          state.messages.push({ id, ...message, documentId: options.documentId });
          if (message.type.endsWith('collect') || message.type === 'qingread:summary-source') return { items, limited: false };
          if (message.type.endsWith('restore')) return { restored: true };
          return { applied: true };
        }
      }
    };
    Object.defineProperty(globalThis, 'Translator', { configurable: true, value: {
      availability: async () => 'available',
      create(options) {
        state.created++; state.options = { sourceLanguage: options.sourceLanguage, targetLanguage: options.targetLanguage };
        state.userActivation = navigator.userActivation.isActive;
        return Promise.resolve({
          destroy() { state.destroyed++; },
          translate(text, translateOptions) {
            state.translations.push(text);
            if (mode === 'pending') return new Promise((resolve, reject) => {
              state.release = () => resolve('延遲譯文');
              translateOptions.signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true });
            });
            return Promise.resolve(text.startsWith('The default') ? '默認軟件使用鼠標。' : '請勿刪除備份。');
          }
        });
      }
    } });
  }, { mode });
  await page.goto('https://panel.test/panel.html');
  await page.waitForFunction(() => !document.querySelector('#start').disabled);
  return page;
}

test('language detection uses filtered original text and preserves click activation',async()=>{
  const page=await panelFixture();
  try {
    await page.evaluate(()=>{
      globalThis.LanguageDetector={create:async()=>{
        harness.detectGesture=navigator.userActivation.isActive;
        return {destroy(){harness.detectorDestroyed=true;},detect:async text=>{harness.detectedText=text;return [{detectedLanguage:'ja'}];}};
      }};
    });
    await page.locator('[data-view=settings]').click();await page.locator('#detect').click();
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('已辨識'));
    assert.equal(await page.locator('#source').inputValue(),'ja');
    assert.equal(await page.evaluate(()=>harness.detectedText),'The default software uses a mouse.\nDo not delete the backup.');
    assert.equal(await page.evaluate(()=>harness.detectGesture),true);
    assert.equal(await page.evaluate(()=>harness.detectorDestroyed),true);
    assert.equal(await page.evaluate(()=>harness.messages.some(m=>m.type==='qingread:summary-source')),true);
  }finally{await page.close();}
});

test('switching tabs during detector download cancels detection and releases the late detector',async()=>{
  const page=await panelFixture();
  try {
    await page.evaluate(()=>{
      const inject=chrome.scripting.executeScript;
      chrome.scripting.executeScript=async options=>options.func?[{result:{text:'Article text',language:'en'}}]:inject(options);
      globalThis.LanguageDetector={create:()=>new Promise(resolve=>{harness.finishDetector=()=>resolve({destroy(){harness.detectorDestroyed=true;},detect:async()=>[{detectedLanguage:'ja'}]});})};
    });
    await page.locator('[data-view=settings]').click();await page.locator('#detect').click();
    await page.waitForFunction(()=>Boolean(harness.finishDetector));
    await page.evaluate(()=>{harness.currentTab=8;harness.onActivated({tabId:8});harness.finishDetector();});
    await page.waitForFunction(()=>harness.detectorDestroyed);
    assert.equal(await page.locator('#source').inputValue(),'en');
    assert.doesNotMatch(await page.locator('#status').textContent(),/已辨識/);
  }finally{await page.close();}
});

test('stopping summary while tab query is pending never injects or submits text',async()=>{
  const page=await panelFixture();
  try {
    await page.evaluate(()=>{
      chrome.tabs.query=()=>new Promise(resolve=>{harness.finishQuery=()=>resolve([{id:7,url:'https://article.test/'}]);});
      QingReadLocal.request=async()=>{harness.summarySent=true;return {text:'late'};};
    });
    await page.locator('[data-view=summary]').click();await page.locator('#summary-start').click();
    await page.waitForFunction(()=>Boolean(harness.finishQuery));await page.locator('#summary-stop').click();
    await page.evaluate(async()=>{harness.finishQuery();await new Promise(r=>setTimeout(r,50));});
    assert.equal(await page.evaluate(()=>harness.injected),0);
    assert.equal(await page.evaluate(()=>Boolean(harness.summarySent)),false);
    assert.match(await page.locator('#summary-status').textContent(),/已停止/);
  }finally{await page.close();}
});

test('disabling hover clears pending word lookup and stale words when moving to whitespace',async()=>{
  const page=await fixture();
  try {
    await page.addScriptTag({path:path.join(extension,'media-content.js')});
    const result=await page.evaluate(async()=>{
      const node=document.querySelector('#article').firstChild;
      document.caretRangeFromPoint=()=>({startContainer:node,startOffset:2});
      const move=()=>document.querySelector('#article').dispatchEvent(new PointerEvent('pointermove',{bubbles:true,altKey:true,clientX:30,clientY:30}));
      await message({type:'qingread:hover-enable',enabled:true});move();
      await message({type:'qingread:hover-enable',enabled:false});
      await new Promise(r=>setTimeout(r,550));
      const disabled=await message({type:'qingread:hover-read'});
      await message({type:'qingread:hover-enable',enabled:true});move();
      await new Promise(r=>setTimeout(r,550));
      const word=await message({type:'qingread:hover-read'});
      document.caretRangeFromPoint=()=>null;move();
      const moved=await message({type:'qingread:hover-read'});
      return {disabled,word,moved};
    });
    assert.equal(result.disabled.word,'');assert.equal(result.word.word,'The');assert.equal(result.moved.word,'');
  }finally{await page.close();}
});

test('turning hover off aborts the lookup and a new session does not wait for its stale response',async()=>{
  const page=await panelFixture();
  try{
    await page.evaluate(()=>{
      harness.lookups=[];
      QingReadLocal.request=async(path,options)=>{
        if(path==='/health')return {};
        return new Promise((resolve,reject)=>harness.lookups.push({signal:options.signal,resolve,reject}));
      };
      chrome.tabs.sendMessage=async(_id,message)=>{
        harness.messages.push(message);
        return message.type==='qingread:hover-read'?{word:'backup',version:1}:{ok:true};
      };
    });
    await page.locator('[data-view=video]').click();await page.locator('#hover').check();
    await page.waitForFunction(()=>harness.lookups.length===1);
    await page.locator('#hover').uncheck();
    assert.equal(await page.evaluate(()=>harness.lookups[0].signal?.aborted),true);
    await page.locator('#hover').check();
    await page.waitForFunction(()=>harness.lookups.length===2);
    await page.evaluate(()=>harness.lookups[0].reject(new Error('Stale lookup error')));
    assert.doesNotMatch(await page.locator('#video-status').textContent(),/Stale lookup error/);
    await page.waitForTimeout(700);
    assert.equal(await page.evaluate(()=>harness.lookups.length),2,'Old cleanup must not release the new lookup lock');
    await page.evaluate(()=>harness.lookups[1].resolve({text:'備份'}));
    await page.waitForFunction(()=>harness.messages.some(m=>m.type==='qingread:hover-show'));
    assert.deepEqual(await page.evaluate(()=>harness.messages.filter(m=>m.type==='qingread:hover-show').map(m=>m.text)),['備份']);
  }finally{await page.close();}
});

test('a hover read returning after disable never submits a word to the model',async()=>{
  const page=await panelFixture();
  try{
    await page.evaluate(()=>{
      harness.lookups=0;
      QingReadLocal.request=async(path)=>{if(path==='/explain')harness.lookups++;return {};};
      chrome.tabs.sendMessage=async(_id,message)=>message.type==='qingread:hover-read'
        ?new Promise(resolve=>{harness.finishRead=()=>resolve({word:'backup',version:1});}):{ok:true};
    });
    await page.locator('[data-view=video]').click();await page.locator('#hover').check();
    await page.waitForFunction(()=>Boolean(harness.finishRead));await page.locator('#hover').uncheck();
    await page.evaluate(async()=>{harness.finishRead();await new Promise(resolve=>setTimeout(resolve,0));});
    assert.equal(await page.evaluate(()=>harness.lookups),0);
  }finally{await page.close();}
});

test('a stale hover setup failure cannot disable a newly enabled session',async()=>{
  const page=await panelFixture();
  try{
    await page.evaluate(()=>{
      let first=true;
      QingReadLocal.request=async()=>{
        if(first){first=false;return new Promise((_resolve,reject)=>{harness.failOldSetup=()=>reject(new Error('Old health failure'));});}
        return {};
      };
    });
    await page.locator('[data-view=video]').click();await page.locator('#hover').check();
    await page.waitForFunction(()=>Boolean(harness.failOldSetup));
    await page.locator('#hover').uncheck();await page.locator('#hover').check();
    await page.waitForFunction(()=>harness.messages.some(m=>m.type==='qingread:hover-enable'&&m.enabled));
    await page.evaluate(async()=>{harness.failOldSetup();await new Promise(resolve=>setTimeout(resolve,0));});
    assert.equal(await page.locator('#hover').isChecked(),true);
    assert.doesNotMatch(await page.locator('#video-status').textContent(),/Old health failure/);
  }finally{await page.close();}
});

for(const kind of ['web','video'])test(`${kind} setup binds its source before injection completes`,async()=>{
  const page=await panelFixture();
  try{
    await page.evaluate(()=>{
      chrome.tabs.query=async()=>[{id:7,windowId:3,url:'https://article.test/'}];
      chrome.scripting.executeScript=async()=>new Promise(resolve=>{harness.finishInjection=()=>resolve([{documentId:'doc-7'}]);});
    });
    if(kind==='video')await page.locator('[data-view=video]').click();
    const start=kind==='web'?'#start':'#video-start';
    await page.locator(start).click();await page.waitForFunction(()=>Boolean(harness.finishInjection));
    await page.evaluate(()=>harness.onActivated({windowId:4,tabId:99}));
    assert.equal(await page.locator(start).isDisabled(),true,'Another window cannot stop setup');
    await page.evaluate(()=>harness.onUpdated(7,{url:'https://article.test/new'}));
    assert.equal(await page.locator(start).isEnabled(),true,'Source navigation must stop pending injection');
    await page.evaluate(()=>harness.finishInjection());
    assert.equal(await page.evaluate(()=>harness.messages.some(m=>['qingread:collect','qingread:media-start'].includes(m.type))),false);
  }finally{await page.close();}
});

test('panel creates engine from user click, targets exact document, applies terms and restores', async () => {
  const page = await panelFixture();
  try {
    await page.locator('[data-view=settings]').click();
    await page.locator('#terms').check();
    await page.locator('[data-view=web]').click();
    await page.locator('#start').click();
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('完成 2 段'));
    const result = await page.evaluate(() => ({ ...harness, messages: harness.messages }));
    assert.equal(result.userActivation, true);
    assert.deepEqual(result.options, { sourceLanguage: 'en', targetLanguage: 'zh-Hant' });
    const applications = result.messages.filter(m => m.type.endsWith('apply'));
    assert.equal(applications.length, 2);
    assert.equal(applications[0].text, '預設軟體使用滑鼠。');
    assert.ok(applications.every(m => m.id === 'one' || m.id === 'two'));
    assert.ok(applications.every(m => m.documentId === 'doc-7'));
    assert.equal(result.destroyed, 1);
    await page.screenshot({ path: path.join(__dirname, '../test-results/panel-completed.png'), fullPage: true });
    await page.locator('#restore').click();
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('已還原'));
  } finally { await page.close(); }
});

test('unavailable language pair disables translation without creating a model', async () => {
  const page=await panelFixture();
  try {
    await page.evaluate(()=>{Translator.availability=async()=> 'unavailable';});
    await page.selectOption('#source','ja');
    await page.waitForFunction(()=>document.querySelector('#engine-status').textContent.includes('不支援所選'));
    assert.equal(await page.locator('#start').isDisabled(),true);
    assert.equal(await page.evaluate(()=>harness.created),0);
    await page.selectOption('#engine','local');
    assert.equal(await page.locator('#start').isEnabled(),true);
  }finally{await page.close();}
});

test('first translation failure reports error instead of completed zero paragraphs',async()=>{
  const page=await panelFixture();
  try{
    await page.evaluate(()=>{Translator.create=async()=>({destroy(){},translate:async()=>{throw new DOMException('download failed','NetworkError');}});});
    await page.locator('#start').click();
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('語言包下載失敗'));
    assert.doesNotMatch(await page.locator('#status').textContent(),/完成 0/);
    const positions=await page.evaluate(()=>({status:document.querySelector('#status').getBoundingClientRect().top,video:document.querySelector('#video-start').getBoundingClientRect().top,height:innerHeight}));
    assert.ok(positions.status<positions.height);
    assert.equal(await page.locator('#video-start').isVisible(),false);
  }finally{await page.close();}
});

test('engine test translates built-in text without collecting or injecting a webpage',async()=>{
  const page=await panelFixture();
  try{
    await page.locator('#test-engine').click();
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('引擎有回應'));
    const state=await page.evaluate(()=>harness);
    assert.equal(state.injected,0);assert.equal(state.messages.length,0);
    assert.deepEqual(state.translations,['Do not delete the backup.']);
    assert.match(await page.locator('#detail').textContent(),/請勿刪除備份/);
  }finally{await page.close();}
});

test('missing page permission is reported without waiting for engine download',async()=>{
  const page=await panelFixture();
  try{
    await page.evaluate(()=>{
      Translator.create=()=>new Promise(resolve=>{harness.resolveEngine=()=>resolve({destroy(){harness.destroyed++;}});});
      chrome.scripting.executeScript=async()=>{throw new Error('Cannot access contents');};
    });
    await page.locator('#start').click();
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('無法讀取這個分頁'));
    await page.evaluate(()=>harness.resolveEngine());
    await page.waitForFunction(()=>harness.destroyed===1);
    assert.equal(await page.locator('#start').isEnabled(),true);
  }finally{await page.close();}
});

test('Google results are extracted without translating search navigation or input',async()=>{
  const page=await fixture('https://www.google.com/search?q=test');
  try{
    const result=await page.evaluate(async()=>{
      document.body.innerHTML='<nav>SEARCH_NAVIGATION</nav><form><input value="PRIVATE_QUERY"></form><div id="rso"><div><a href="https://example.com"><h3>Unreal Engine 5</h3></a><div style="-webkit-line-clamp:2"><span>Unreal Engine 5 empowers all creators across all industries to deliver stunning real-time content and experiences.</span></div></div></div>';
      const batch=await message({type:'qingread:collect',job:'search',scope:'page'});
      const item=batch.items.find(i=>i.text.includes('empowers'));
      const applied=await message({type:'qingread:apply',job:'search',id:item.id,text:'讓創作者打造即時內容與體驗。'});
      return {text:batch.items.map(i=>i.text).join(' '),applied,visible:document.querySelector('[data-qingread]').getBoundingClientRect().height>0};
    });
    assert.doesNotMatch(result.text,/SEARCH_NAVIGATION|PRIVATE_QUERY/);assert.equal(result.applied.applied,true);assert.equal(result.visible,true);
  }finally{await page.close();}
});

test('saved glossary is applied to translated output, invalid edits preserve prior rules', async()=>{
  const page=await panelFixture();
  try {
    await page.locator('[data-view=settings]').click();
    await page.locator('summary').filter({hasText:'自訂譯文詞彙表'}).click();
    await page.locator('#glossary').fill('默認軟件 => 預設應用程式');
    await page.locator('#save-glossary').click();
    await page.waitForFunction(()=>document.querySelector('#glossary-status').textContent.includes('已儲存 1'));
    await page.locator('#glossary').fill('格式不正確');await page.locator('#save-glossary').click();
    await page.locator('[data-view=web]').click();
    await page.locator('#start').click();
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('完成 2'));
    assert.equal(await page.evaluate(()=>harness.messages.find(m=>m.type==='qingread:apply').text),'預設應用程式使用鼠標。');
  }finally{await page.close();}
});

test('viewport priority applies before paragraph cap and pending order follows scrolling', async()=>{
  const page=await fixture();
  try {
    const result=await page.evaluate(async()=>{
      document.body.replaceChildren();document.body.style.cssText='margin:0;padding:0;max-width:none';
      for(let i=0;i<250;i++){const p=document.createElement('p');p.textContent=`Paragraph ${i}`;p.style.cssText='height:100px;margin:0';document.body.append(p);}
      scrollTo(0,22000);
      const batch=await message({type:'qingread:collect',job:'priority',scope:'page'});
      scrollTo(0,23000);
      const order=await message({type:'qingread:prioritize',job:'priority'});
      return {first:batch.items[0].text,next:batch.items.find(item=>item.id===order.ids[0]).text,count:batch.items.length,limited:batch.limited};
    });
    assert.equal(result.first,'Paragraph 220');assert.equal(result.next,'Paragraph 230');assert.equal(result.count,200);assert.equal(result.limited,true);
  }finally{await page.close();}
});

test('stop during model translation prevents delayed insertion; unrelated tab reload does not stop', async () => {
  const page = await panelFixture('pending');
  try {
    await page.locator('#start').click();
    await page.waitForFunction(() => harness.translations.length === 1);
    await page.evaluate(() => harness.onUpdated(99, { status: 'loading' }));
    assert.equal(await page.locator('#stop').isEnabled(), true);
    await page.locator('#stop').click();
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('已停止'));
    const messages = await page.evaluate(() => harness.messages);
    assert.equal(messages.filter(m => m.type.endsWith('apply')).length, 0);
    assert.equal(await page.locator('#start').isEnabled(), true);
  } finally { await page.close(); }
});

for(const kind of ['web','video'])for(const event of ['url','removed'])test(`${kind} work stops on source ${event} and can restart`,async()=>{
  const page=await panelFixture('pending');
  try{
    if(kind==='video')await page.evaluate(()=>{
      chrome.tabs.sendMessage=async(_id,message)=>{
        harness.messages.push(message);
        return message.type==='qingread:media-read'?{text:'Keep the original file.',version:1,timelineVersion:1}:{ok:true,applied:true};
      };
    });
    const start=kind==='web'?'#start':'#video-start',stop=kind==='web'?'#stop':'#video-stop';
    if(kind==='video')await page.locator('[data-view=video]').click();
    await page.locator(start).click();await page.waitForFunction(()=>harness.translations.length===1);
    const emit=(id,event)=>page.evaluate(({id,event})=>event==='url'?harness.onUpdated(id,{url:'https://article.test/next'}):harness.onRemoved(id),{id,event});
    await emit(99,event);assert.equal(await page.locator(stop).isEnabled(),true);
    await emit(7,event);
    assert.equal(await page.locator(start).isEnabled(),true);
    await page.evaluate(()=>harness.release());
    assert.equal(await page.evaluate(()=>harness.messages.filter(m=>['qingread:apply','qingread:media-show'].includes(m.type)).length),0);
    await page.locator(start).click();await page.waitForFunction(()=>harness.translations.length===2);
    await page.locator(stop).click();
  }finally{await page.close();}
});

test('switching tabs cancels translation without applying to another tab', async () => {
  const page = await panelFixture('pending');
  try {
    await page.locator('#start').click();
    await page.waitForFunction(() => harness.translations.length === 1);
    await page.evaluate(() => { harness.currentTab = 8; harness.onActivated({ tabId: 8 }); });
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('已切換分頁'));
    const messages = await page.evaluate(() => harness.messages);
    assert.equal(messages.filter(m => m.type.endsWith('apply')).length, 0);
  } finally { await page.close(); }
});
test('cancelled jobs cannot insert results and later collection includes dynamic content', async () => {
  const page = await fixture();
  try {
    const result = await page.evaluate(async () => {
      const batch = await message({ type: 'qingread:collect', job: 'cancel', scope: 'page' });
      await message({ type: 'qingread:cancel', job: 'cancel' });
      const applied = await message({ type: 'qingread:apply', job: 'cancel', id: batch.items[0].id, text: '不應顯示' });
      document.querySelector('button').click();
      const next = await message({ type: 'qingread:collect', job: 'dynamic', scope: 'page' });
      return { applied, dynamic: next.items.some(i => i.text.includes('New content loaded')) };
    });
    assert.equal(result.applied.applied, false);
    assert.equal(result.dynamic, true);
  } finally { await page.close(); }
});
test('page limits and untrusted senders cannot bypass collection boundaries', async () => {
  const page = await fixture();
  try {
    const result = await page.evaluate(async () => {
      for (let i = 0; i < 250; i++) document.body.append(Object.assign(document.createElement('p'), { textContent: `Paragraph number ${i}` }));
      let responded = false;
      listener({ type: 'qingread:restore' }, { id: 'other', url: 'https://evil.example/' }, () => { responded = true; });
      const batch = await message({ type: 'qingread:collect', job: 'limit', scope: 'page' });
      return { responded, count: batch.items.length, limited: batch.limited };
    });
    assert.equal(result.responded, false);
    assert.equal(result.count, 200);
    assert.equal(result.limited, true);
  } finally { await page.close(); }
});
test('panel handles the real browser API being unavailable without a cloud fallback', async () => {
  const page = await browser.newPage({ viewport: { width: 380, height: 950 } });
  try {
    await page.route('https://panel.test/**', route => {
      const relative = new URL(route.request().url()).pathname.slice(1) || 'panel.html';
      const file = path.join(extension, relative);
      route.fulfill({ body: fs.readFileSync(file), contentType: relative.endsWith('.svg') ? 'image/svg+xml' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.js') ? 'text/javascript' : 'text/html' });
    });
    await page.addInitScript(() => {
      Object.defineProperty(globalThis, 'Translator', { value: undefined, configurable: true });
      globalThis.chrome = { storage: { local: { setAccessLevel: async () => {}, get: async () => ({}) } }, tabs: { onActivated: { addListener() {} }, onUpdated: { addListener() {} } } };
    });
    await page.goto('https://panel.test/panel.html');
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('尚未提供'));
    assert.equal(await page.locator('#start').isDisabled(), true);
    await page.screenshot({ path: path.join(__dirname, '../test-results/panel.png'), fullPage: true });
  } finally { await page.close(); }
});

test('video rejects late captions, removes expired cues and blocks messages from websites', async () => {
  const page=await fixture();
  try {
    await page.evaluate(()=>{document.body.innerHTML='<div id="movie_player"><video style="width:640px;height:360px"></video><div class="ytp-caption-window-container"><span class="ytp-caption-segment">First caption.</span></div></div>';Object.defineProperty(document.querySelector('video'),'paused',{value:false,configurable:true});});
    await page.addScriptTag({path:path.join(extension,'media-content.js')});
    const result=await page.evaluate(async()=>{
      await message({type:'qingread:media-start',session:'video',mode:'captions'});
      const first=await message({type:'qingread:media-read',session:'video'});
      document.querySelector('.ytp-caption-segment').textContent='Second caption.';
      await message({type:'qingread:media-show',session:'video',mode:'captions',version:first.version,original:first.text,text:'過期譯文'});
      const stale=document.querySelector('[data-qingread-media]');
      const second=await message({type:'qingread:media-read',session:'video'});
      await message({type:'qingread:media-show',session:'video',mode:'captions',version:second.version,original:second.text,text:'<img src=x onerror=alert(1)> 第二句'});
      const box=document.querySelector('[data-qingread-media]');
      const shadow=testShadows.get(box);
      let untrusted=false;
      listener({type:'qingread:media-stop',session:'video'},{id:'other',url:'https://evil.test'},()=>{untrusted=true;});
      return {stale:Boolean(stale),text:shadow.textContent,images:shadow.querySelectorAll('img').length,untrusted};
    });
    assert.equal(result.stale,false);assert.equal(result.images,0);assert.match(result.text,/第二句/);assert.equal(result.untrusted,false);
    await page.evaluate(()=>{document.querySelector('.ytp-caption-segment').textContent='';});
    await page.waitForFunction(()=>!document.querySelector('[data-qingread-media]'));
    const speech=await page.evaluate(async()=>{
      const video=document.querySelector('video');Object.defineProperty(video,'paused',{value:false,configurable:true});
      await message({type:'qingread:media-start',session:'speech',mode:'speech'});
      const before=await message({type:'qingread:media-read',session:'speech'});
      video.dispatchEvent(new Event('seeking'));
      await message({type:'qingread:media-show',session:'speech',mode:'speech',timelineVersion:before.timelineVersion,original:'old',text:'舊片段'});
      const stale=Boolean(document.querySelector('[data-qingread-media]'));
      const after=await message({type:'qingread:media-read',session:'speech'});
      await message({type:'qingread:media-show',session:'speech',mode:'speech',timelineVersion:after.timelineVersion,original:'new',text:'新片段'});
      const current=Boolean(document.querySelector('[data-qingread-media]'));
      video.dispatchEvent(new Event('pause'));
      const paused=Boolean(document.querySelector('[data-qingread-media]'));
      await message({type:'qingread:media-stop',session:'speech'});
      return {stale,current,paused};
    });
    assert.deepEqual(speech,{stale:false,current:true,paused:false});
  }finally{await page.close();}
});

test('companion client uses fixed loopback, omits credentials and stores pairing only after authentication', async () => {
  const page=await browser.newPage();
  try {
    await page.goto('about:blank');
    await page.evaluate(()=>{
      globalThis.saved={};globalThis.requests=[];
      globalThis.chrome={storage:{session:{setAccessLevel:async()=>{},get:async()=>saved,set:async value=>Object.assign(saved,value)}}};
      globalThis.fetch=async(url,options)=>{requests.push({url,...options});return {ok:true,json:async()=>url.endsWith('/health')?{inference_jobs:true,inference_client_identity:true}:{stage:'done',text:'譯文'}};};
    });
    await page.addScriptTag({path:path.join(extension,'local-client.js')});
    const result=await page.evaluate(async()=>{
      await QingReadLocal.pair('a'.repeat(43));
      await QingReadLocal.translator('en').translate('Hello');
      globalThis.fetch=async()=>({ok:false,status:401,json:async()=>({message:'配對碼不正確'})});
      let failed=false;try{await QingReadLocal.pair('b'.repeat(43));}catch{failed=true;}
      return {requests:requests.map(r=>({url:r.url,credentials:r.credentials,redirect:r.redirect,auth:r.headers.Authorization})),saved,failed};
    });
    assert.equal(result.failed,true);assert.equal(result.saved.companionToken,'a'.repeat(43));
    assert.ok(result.requests.every(r=>r.url.startsWith('http://127.0.0.1:8765/')&&r.credentials==='omit'&&r.redirect==='error'));
  }finally{await page.close();}
});

test('document workspace renders job downloads safely and shows model/resource readiness', async () => {
  const page=await browser.newPage({viewport:{width:1000,height:1000}});
  try {
    await page.route('https://workspace.test/**',route=>{
      const name=new URL(route.request().url()).pathname.slice(1)||'workspace.html';
      return route.fulfill({body:fs.readFileSync(path.join(extension,name)),contentType:name.endsWith('.svg')?'image/svg+xml':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'});
    });
    await page.addInitScript(()=>{
      globalThis.chrome={storage:{session:{get:async()=>({companionToken:'a'.repeat(43)})},local:{get:async()=>({})}}};
      globalThis.fetch=async url=>({ok:true,json:async()=>url.endsWith('/health')?{models:['local:small'],selected_model:'local:small',ollama:true,speech_ready:true,pdf_assets_ready:true}:{jobs:[{id:'a'.repeat(32),kind:'pdf',state:'done',message:'已產生譯本',outputs:[{name:'<script>sample.pdf',size:100}]}]}});
    });
    await page.goto('https://workspace.test/workspace.html');
    await page.waitForFunction(()=>document.querySelector('#health').textContent.includes('已連線'));
    assert.equal(await page.locator('#model').inputValue(),'local:small');
    assert.equal(await page.locator('#jobs script').count(),0);
    await page.screenshot({path:path.join(__dirname,'../test-results/workspace.png'),fullPage:true});
  }finally{await page.close();}
});

test('PDF preview submits only explicit trial mode and renders phases plus cancellation acknowledgement',async()=>{
  const page=await browser.newPage();
  try{
    await page.route('https://pdf.test/**',route=>{
      const name=new URL(route.request().url()).pathname.slice(1)||'workspace.html';
      return route.fulfill({body:fs.readFileSync(path.join(extension,name)),contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'});
    });
    await page.addInitScript(()=>{
      globalThis.pdfHarness={uploads:[],job:null};
      chrome={storage:{session:{get:async()=>({companionToken:'a'.repeat(43)})},local:{get:async()=>({})}}};
      fetch=async(url,options)=>{
        let result;
        if(url.endsWith('/health'))result={models:['local:test'],selected_model:'local:test',ollama:true,pdf_assets_ready:true,pdf_preview:true};
        else if(url.includes('/pdf?')){
          pdfHarness.uploads.push(url);
          pdfHarness.job={id:'a'.repeat(32),kind:'pdf',state:'running',phase:'ocr',message:'正在辨識掃描文字。',preview:true,page_count:3,current:1,total:2,outputs:[]};result=pdfHarness.job;
        }else if(options.method==='DELETE'){pdfHarness.job.phase='cancelling';result={cancelling:true};}
        else result={jobs:pdfHarness.job?[pdfHarness.job]:[]};
        return {ok:true,json:async()=>result};
      };
    });
    await page.goto('https://pdf.test/workspace.html');
    await page.waitForFunction(()=>!document.querySelector('#preview-pdf').disabled);
    await page.locator('#pdf').setInputFiles({name:'synthetic.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-synthetic')});
    await page.locator('#pages').fill('3');
    await page.locator('#preview-pdf').click();
    await page.waitForFunction(()=>document.querySelector('#jobs').textContent.includes('辨識掃描文字'));
    const url=new URL(await page.evaluate(()=>pdfHarness.uploads[0]));
    assert.equal(url.searchParams.get('preview'),'true');assert.equal(url.searchParams.get('pages'),'');
    assert.match(await page.locator('#jobs').textContent(),/前 2 頁試翻.*本階段 1 \/ 2/s);
    await page.locator('#jobs button').filter({hasText:'取消工作'}).click();
    await page.waitForFunction(()=>document.querySelector('#jobs').textContent.includes('正在取消'));
    assert.equal(await page.locator('#jobs button').isDisabled(),true);
    await page.evaluate(()=>{pdfHarness.job.state='cancelled';pdfHarness.job.phase='cancelled';delete pdfHarness.job.current;delete pdfHarness.job.total;});
    await page.locator('#refresh').click();
    await page.waitForFunction(()=>document.querySelector('#jobs').textContent.includes('已取消'));
    assert.match(await page.locator('#jobs button').textContent(),/清除原檔/);
    assert.doesNotMatch(await page.locator('#jobs').textContent(),/本階段/);
  }finally{await page.close();}
});

test('old companion cannot silently turn a two-page preview into a full document upload',async()=>{
  const page=await browser.newPage();
  try{
    await page.route('https://old-pdf.test/**',route=>{
      const name=new URL(route.request().url()).pathname.slice(1)||'workspace.html';
      return route.fulfill({body:fs.readFileSync(path.join(extension,name)),contentType:name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'});
    });
    await page.addInitScript(()=>{
      chrome={storage:{session:{get:async()=>({companionToken:'a'.repeat(43)})},local:{get:async()=>({})}}};
      globalThis.uploaded=false;
      fetch=async url=>{if(url.includes('/pdf?'))uploaded=true;return {ok:true,json:async()=>url.endsWith('/health')?{models:[],ollama:true}:{jobs:[]}};};
    });
    await page.goto('https://old-pdf.test/workspace.html');
    await page.waitForFunction(()=>document.querySelector('#health').textContent.includes('已連線'));
    assert.equal(await page.locator('#preview-pdf').isDisabled(),true);
    await page.evaluate(()=>document.querySelector('#preview-pdf').onclick());
    await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('重新啟動新版助手'));
    assert.equal(await page.evaluate(()=>uploaded),false);
  }finally{await page.close();}
});

test('generic engine failures identify their stage without blaming page permission or exposing text', async()=>{
  const page=await panelFixture();
  try {
    await page.setViewportSize({width:360,height:740});
    await page.evaluate(()=>{Translator.create=async()=>{throw new Error('secret article');};});
    await page.locator('#start').click();
    await page.waitForFunction(()=>document.querySelector('#detail').textContent.includes('engine-create / Error'));
    assert.doesNotMatch(await page.locator('#status').textContent(),/存取權/);
    assert.doesNotMatch(await page.locator('#detail').textContent(),/secret article/);
    const manifest=JSON.parse(fs.readFileSync(path.join(extension,'manifest.json')));
    assert.equal(await page.locator('.badge').textContent(),'v'+manifest.version);
    const bounds=await page.locator('#status').boundingBox();assert.ok(bounds.y+bounds.height<740);
    await page.screenshot({path:path.join(__dirname,'../test-results/panel-error.png'),fullPage:true});
    await page.evaluate(()=>{Translator.create=async()=>({destroy(){},translate:async()=>{throw new Error('secret article');}});});
    await page.locator('#test-engine').click();
    await page.waitForFunction(()=>document.querySelector('#detail').textContent.includes('engine-translate / Error'));
    await page.locator('[data-view=video]').click();
    assert.equal(await page.locator('#video-start').isVisible(),true);
    assert.equal(await page.locator('#start').isVisible(),false);
  }finally{await page.close();}
});

test('missing URL does not reject a valid tab before injection; site request targets only current tab',async()=>{
  const page=await panelFixture();
  try {
    await page.evaluate(()=>{chrome.tabs.query=async()=>[{id:7}];});
    await page.locator('#start').click();
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('完成 2'));
    assert.equal(await page.evaluate(()=>harness.injected),1);
    await page.evaluate(()=>{
      chrome.scripting.executeScript=async()=>{throw new Error('access denied');};
      chrome.permissions={addHostAccessRequest:async request=>{harness.siteRequest=request;}};
    });
    await page.locator('#start').click();
    await page.locator('#grant-site').click();
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('尚未取得授權'));
    assert.deepEqual(await page.evaluate(()=>harness.siteRequest),{tabId:7});
    assert.match(await page.locator('#detail').textContent(),/撤回/);
    // Neither a pending nor denied permission request retries collection automatically.
    assert.equal(await page.evaluate(()=>harness.messages.filter(m=>m.type==='qingread:collect').length),1);
  }finally{await page.close();}
});
test('restricted tab is distinct from a missing URL and never injects',async()=>{
  const page=await panelFixture();
  try {
    await page.evaluate(()=>{chrome.tabs.query=async()=>[{id:7,url:'chrome://settings/'}];});
    await page.locator('#start').click();
    await page.waitForFunction(()=>document.querySelector('#detail').textContent.includes('PageRestrictedError'));
    assert.equal(await page.evaluate(()=>harness.injected),0);
    assert.equal(await page.locator('#grant-site').isVisible(),false);
  }finally{await page.close();}
});

test('Wikipedia translates body paragraphs without UI, infobox or reference clutter; selection remains available',async()=>{
  const page=await fixture('https://en.wikipedia.org/wiki/Unreal_Engine_5');
  try {
    const result=await page.evaluate(async()=>{
      document.body.innerHTML=`<nav><p>Contents</p></nav><aside><p id="outside">Appearance options</p></aside>
        <main><h1>Unreal Engine 5</h1><div id="mw-content-text"><div class="mw-parser-output">
        <table class="infobox" style="float:right;width:220px;height:300px"><tbody><tr><td>Original author</td></tr></tbody></table>
        <p id="intro">Unreal Engine 5 is a real-time engine.<sup class="reference">Reference marker</sup></p>
        <div class="mw-heading"><h2>History</h2><span class="mw-editsection">Edit</span></div><p>It was released in April 2022.</p>
        <div class="reflist"><p>Citation text</p></div><div class="navbox">Related navigation</div>
        </div></div></main>`;
      const batch=await message({type:'qingread:collect',job:'wiki',scope:'page'});
      const item=batch.items.find(i=>i.text.startsWith('Unreal Engine 5 is'));
      await message({type:'qingread:apply',job:'wiki',id:item.id,text:'Unreal Engine 5 是一套即時引擎。'});
      const host=document.querySelector('[data-qingread]'),shadow=testShadows.get(host),style=getComputedStyle(shadow.querySelector('div'));
      const snapshot={texts:batch.items.map(i=>i.text),label:shadow.querySelector('small'),background:style.backgroundColor,padding:style.paddingTop,clear:getComputedStyle(host).clear,position:host.getBoundingClientRect().top,tableBottom:document.querySelector('.infobox').getBoundingClientRect().bottom};
      const range=document.createRange();range.selectNodeContents(document.querySelector('#outside'));getSelection().removeAllRanges();getSelection().addRange(range);
      snapshot.selected=(await message({type:'qingread:collect',job:'selected',scope:'selection'})).items.map(i=>i.text);
      return snapshot;
    });
    assert.deepEqual(result.texts,['Unreal Engine 5 is a real-time engine.','History','It was released in April 2022.']);
    assert.equal(result.label,null);assert.equal(result.background,'rgba(0, 0, 0, 0)');assert.equal(result.padding,'0px');assert.equal(result.clear,'none');
    assert.ok(result.position<result.tableBottom,'translation should not be pushed below floated infobox');
    assert.deepEqual(result.selected,['Appearance options']);
    await page.screenshot({path:path.join(__dirname,'../test-results/wikipedia-reading.png'),fullPage:true});
  }finally{await page.close();}
});
test('generic article scope avoids navigation while fallback handles ordinary pages',async()=>{
  const page=await fixture();
  try {
    const result=await page.evaluate(async()=>{
      document.body.innerHTML='<nav><p>Site menu</p></nav><main><p>Article paragraph.</p><aside><p>Related links</p></aside></main><footer><p>Footer links</p></footer>';
      return (await message({type:'qingread:collect',job:'main',scope:'page'})).items.map(i=>i.text);
    });
    assert.deepEqual(result,['Article paragraph.']);
  }finally{await page.close();}
});

test('Skilljar reads course content rather than collapsed FAQ articles or mobile duplicates',async()=>{
  const page=await fixture('https://anthropic.skilljar.com/introduction-to-agent-skills');
  try {
    const result=await page.evaluate(async()=>{
      document.body.innerHTML='<div id="skilljar-content"><div id="dp-details"><div class="hide-for-small"><h3>About this course</h3><p>Learn to build reusable skills.</p></div><div style="display:none"><p>Mobile duplicate.</p></div></div></div><div id="sj-custom-footer"><article style="height:0;overflow:hidden"><p>Hidden FAQ content.</p></article></div>';
      const batch=await message({type:'qingread:collect',job:'course',scope:'page'});
      for(const item of batch.items)await message({type:'qingread:apply',job:'course',id:item.id,text:'課程中文測試'});
      const again=await message({type:'qingread:collect',job:'again',scope:'page'});
      return {texts:batch.items.map(i=>i.text),reason:again.reason,count:again.alreadyTranslated};
    });
    assert.deepEqual(result.texts,['About this course','Learn to build reusable skills.']);
    assert.equal(result.reason,'translated');assert.equal(result.count,2);
  }finally{await page.close();}
});
test('hidden first article cannot hide visible main; collapsed-only candidates fall back to body',async()=>{
  const page=await fixture();
  try {
    const result=await page.evaluate(async()=>{
      document.body.innerHTML='<article hidden><p>Hidden article.</p></article><main><p>Visible main body.</p></main>';
      const first=(await message({type:'qingread:collect',job:'main',scope:'page'})).items.map(i=>i.text);
      document.body.innerHTML='<div><p>Visible course body.</p></div><article style="height:0;overflow:hidden"><p>Hidden FAQ.</p></article>';
      const second=(await message({type:'qingread:collect',job:'fallback',scope:'page'})).items.map(i=>i.text);
      return {first,second};
    });
    assert.deepEqual(result.first,['Visible main body.']);assert.deepEqual(result.second,['Visible course body.']);
  }finally{await page.close();}
});

test('Skilljar FAQ supplements course; closed answers stay private and opening collects only new content',async()=>{
  const page=await fixture('https://anthropic.skilljar.com/introduction-to-agent-skills');
  try {
    const result=await page.evaluate(async()=>{
      document.body.innerHTML=`<style>.faq-content{height:0;overflow:hidden}.faq-input:checked~.faq-content{height:auto}.faq-label{display:grid;grid-template-columns:1fr 20px}</style>
      <div id="skilljar-content"><p>Course introduction.</p></div><div id="sj-custom-footer">
      <div class="faq-container"><input class="faq-input" id="faq-1" type="checkbox"><label class="faq-label" for="faq-1"><div class="faq-title">What is Skilljar?</div><span>+</span></label><article class="faq-content"><div><p>Skilljar hosts educational content.</p></div></article></div><p>Copyright navigation.</p></div>`;
      const first=await message({type:'qingread:collect',job:'closed',scope:'page'});
      for(const item of first.items) await message({type:'qingread:apply',job:'closed',id:item.id,text:'第一輪譯文'});
      const titleInside=document.querySelector('.faq-title [data-qingread]')!==null;
      document.querySelector('#faq-1').click();
      const opened=await message({type:'qingread:collect',job:'open',scope:'page'});
      for(const item of opened.items) await message({type:'qingread:apply',job:'open',id:item.id,text:'Skilljar 提供教育內容。'});
      const answerInside=document.querySelector('.faq-content [data-qingread]')!==null;
      document.querySelector('#faq-1').click();
      const collapsedHeight=document.querySelector('.faq-content').getBoundingClientRect().height;
      const closedAgain=await message({type:'qingread:collect',job:'closed-again',scope:'page'});
      document.querySelector('#faq-1').click();
      const reopened=await message({type:'qingread:collect',job:'reopened',scope:'page'});
      return {first:first.items.map(i=>i.text),opened:opened.items.map(i=>i.text),titleInside,answerInside,collapsedHeight,closedCount:closedAgain.items.length,reopened:reopened.items.map(i=>i.text)};
    });
    assert.deepEqual(result.first,['Course introduction.','What is Skilljar?']);
    assert.deepEqual(result.opened,['Skilljar hosts educational content.']);
    assert.equal(result.titleInside,true);assert.equal(result.answerInside,true);assert.equal(result.collapsedHeight,0);assert.equal(result.closedCount,0);
    assert.deepEqual(result.reopened,['Skilljar hosts educational content.']);
  }finally{await page.close();}
});

test('fixed-height curriculum grows with translations and restores original layout',async()=>{
  const page=await fixture('https://anthropic.skilljar.com/introduction-to-agent-skills');
  try {
    const result=await page.evaluate(async()=>{
      document.body.innerHTML='<style>.lesson-modular{display:flex;height:44px;align-items:center}.lesson-wrapper{width:200px}</style><div id="skilljar-content"><ul class="dp-curriculum"><li class="lesson-modular"><div class="lesson-wrapper"><div>What are skills?</div></div></li><li class="lesson-modular"><div class="lesson-wrapper"><div>Creating your first skill</div></div></li></ul></div>';
      const batch=await message({type:'qingread:collect',job:'layout',scope:'page'});
      for(const item of batch.items) await message({type:'qingread:apply',job:'layout',id:item.id,text:'這是一段比較長的課程中文翻譯，需要足夠空間顯示。'});
      const rows=[...document.querySelectorAll('li')];
      const good=rows[0].getBoundingClientRect().height>44&&rows[0].querySelector('[data-qingread]').getBoundingClientRect().bottom<=rows[1].getBoundingClientRect().top;
      await message({type:'qingread:restore'});
      return {good,height:rows[0].getBoundingClientRect().height};
    });
    assert.equal(result.good,true);assert.equal(result.height,44);
  }finally{await page.close();}
});
test('summary extraction reads original translated paragraphs without invalidating translation job',async()=>{
  const page=await fixture();
  try {
    const result=await page.evaluate(async()=>{
      const batch=await message({type:'qingread:collect',job:'translate',scope:'page'});
      await message({type:'qingread:apply',job:'translate',id:batch.items[0].id,text:'中文已翻譯'});
      const summary=await message({type:'qingread:summary-source',job:'summary',scope:'page'});
      const applied=await message({type:'qingread:apply',job:'translate',id:batch.items[1].id,text:'後續中文'});
      return {texts:summary.items.map(i=>i.text).join(' '),applied};
    });
    assert.match(result.texts,/A quieter way/);assert.doesNotMatch(result.texts,/中文已翻譯|SECRET/);assert.equal(result.applied.applied,true);
  }finally{await page.close();}
});
test('summary UI uses local endpoint, labels partial text and renders safely',async()=>{
  const page=await panelFixture();
  try {
    await page.evaluate(()=>{
      const send=chrome.tabs.sendMessage;
      chrome.tabs.sendMessage=async(id,msg,opts)=>msg.type==='qingread:summary-source'?{items:[{text:'A'.repeat(7000)}]}:send(id,msg,opts);
      QingReadLocal.request=async(path,options)=>{harness.summary={path,text:options.body.text};return {text:'<img src=x> 三個摘要重點'};};
    });
    await page.locator('[data-view=summary]').click();await page.locator('#summary-start').click();
    await page.waitForFunction(()=>document.querySelector('#summary-result').textContent.includes('三個摘要'));
    const request=await page.evaluate(()=>harness.summary);assert.equal(request.path,'/summarize');assert.equal(request.text.length,6000);
    assert.match(await page.locator('#summary-status').textContent(),/未涵蓋全文/);assert.equal(await page.locator('#summary-result img').count(),0);
    await page.screenshot({path:path.join(__dirname,'../test-results/summary.png'),fullPage:true});
    await page.evaluate(()=>harness.onActivated({tabId:8}));assert.match(await page.locator('#summary-result').textContent(),/三個摘要/);
    assert.match(await page.locator('#summary-source').textContent(),/摘要來源：/);
  }finally{await page.close();}
});
for(const change of ['url','removed'])test(`captured summary survives source ${change} without a loading event`,async()=>{
  const page=await panelFixture();
  try{
    await page.evaluate(()=>{
      QingReadLocal.request=(_path,options)=>new Promise(resolve=>{
        harness.summarySignal=options.signal;
        harness.finishSummary=()=>resolve({text:'原文快照摘要'});
      });
    });
    await page.locator('[data-view=summary]').click();await page.locator('#summary-start').click();
    await page.waitForFunction(()=>Boolean(harness.finishSummary));
    await page.evaluate(change=>{
      if(change==='url')harness.onUpdated(99,{url:'https://other.test/'});
      else harness.onRemoved(99);
    },change);
    assert.equal(await page.evaluate(()=>harness.summarySignal.aborted),false);
    await page.evaluate(change=>{
      if(change==='url')harness.onUpdated(7,{url:'https://article.test/next'});
      else harness.onRemoved(7);
    },change);
    assert.equal(await page.evaluate(()=>harness.summarySignal.aborted),false);
    await page.evaluate(()=>harness.finishSummary());
    assert.equal(await page.locator('#summary-result').textContent(),'原文快照摘要');
    assert.match(await page.locator('#summary-source').textContent(),/原文快照/);
    assert.equal(await page.locator('#summary-start').isEnabled(),true);
  }finally{await page.close();}
});

test('stopped summary never displays delayed model output',async()=>{
  const page=await panelFixture();
  try {
    await page.evaluate(()=>{QingReadLocal.request=()=>new Promise(resolve=>{harness.releaseSummary=()=>resolve({text:'late'});});});
    await page.locator('[data-view=summary]').click();await page.locator('#summary-start').click();
    await page.waitForFunction(()=>Boolean(harness.releaseSummary));await page.locator('#summary-stop').click();
    await page.evaluate(()=>harness.releaseSummary());assert.equal(await page.locator('#summary-result').textContent(),'');
  }finally{await page.close();}
});

test('summary with embedded content explains its actual coverage limit',async()=>{
  const page=await panelFixture();
  try {
    await page.evaluate(()=>{
      chrome.tabs.sendMessage=async()=>({items:[{text:'Short article.'}],frames:[{title:'Lesson'}]});
      QingReadLocal.request=async()=>({text:'文章摘要'});
    });
    await page.locator('[data-view=summary]').click();await page.locator('#summary-start').click();
    await page.waitForFunction(()=>document.querySelector('#summary-result').textContent==='文章摘要');
    assert.match(await page.locator('#summary-status').textContent(),/未包含內嵌頁面/);
    assert.doesNotMatch(await page.locator('#summary-status').textContent(),/達到上限/);
  }finally{await page.close();}
});

test('completed summary is brought into view in a short side panel',async()=>{
  const page=await panelFixture();
  try {
    await page.setViewportSize({width:380,height:520});
    await page.evaluate(()=>{QingReadLocal.request=async()=>({text:'總覽：這份公告說明開館時間。\n\n一、週五閉館。\n二、週一恢復。'});});
    await page.locator('[data-view=summary]').click();await page.locator('#summary-start').click();
    await page.waitForFunction(()=>!document.querySelector('#summary-copy').disabled);
    const result=await page.locator('#summary-result').boundingBox();
    assert.ok(result.y>=0 && result.y<480,`Summary starts outside viewport: ${result.y}`);
    await page.screenshot({path:path.join(__dirname,'../test-results/summary-short-panel.png'),fullPage:false});
  }finally{await page.close();}
});

test('another browser window cannot cancel or erase this window summary',async()=>{
  const page=await panelFixture();
  try {
    await page.evaluate(()=>{
      chrome.tabs.query=async query=>[{id:query.windowId===10?7:harness.currentTab,windowId:10,url:'https://article.test/'}];
      QingReadLocal.request=()=>new Promise(resolve=>{harness.finishSummary=()=>resolve({text:'本視窗的摘要。'});});
    });
    await page.locator('[data-view=summary]').click();await page.locator('#summary-start').click();
    await page.waitForFunction(()=>Boolean(harness.finishSummary));
    await page.evaluate(()=>{harness.currentTab=99;harness.onActivated({tabId:99,windowId:20});harness.finishSummary();});
    await page.waitForFunction(()=>document.querySelector('#summary-stop').disabled);
    assert.equal(await page.locator('#summary-result').textContent(),'本視窗的摘要。');
    await page.evaluate(()=>harness.onActivated({tabId:98,windowId:20}));
    assert.equal(await page.locator('#summary-result').textContent(),'本視窗的摘要。');
    await page.evaluate(()=>harness.onActivated({tabId:8,windowId:10}));
    assert.equal(await page.locator('#summary-result').textContent(),'本視窗的摘要。');
  }finally{await page.close();}
});

test('summary keeps its captured source when active tab changes before completion',async()=>{
  const page=await panelFixture();
  try {
    await page.evaluate(()=>{QingReadLocal.request=async()=>{harness.currentTab=8;return {text:'前一頁摘要'};};});
    await page.locator('[data-view=summary]').click();await page.locator('#summary-start').click();
    await page.waitForFunction(()=>document.querySelector('#summary-stop').disabled);
    assert.equal(await page.locator('#summary-result').textContent(),'前一頁摘要');
    assert.match(await page.locator('#summary-source').textContent(),/摘要來源：article.test/);
    assert.doesNotMatch(await page.locator('#summary-status').textContent(),/整理中/);
  }finally{await page.close();}
});

test('temporarily hidden panel keeps summary running and reveals the completed result on return',async()=>{
  const page=await panelFixture();
  try {
    await page.setViewportSize({width:380,height:520});
    await page.evaluate(()=>{
      QingReadLocal.request=(_path,options)=>new Promise(resolve=>{
        harness.summarySignal=options.signal;
        harness.finishSummary=()=>resolve({text:'背景整理後的摘要。'});
      });
    });
    await page.locator('[data-view=summary]').click();await page.locator('#summary-start').click();
    await page.waitForFunction(()=>Boolean(harness.finishSummary));
    await page.evaluate(()=>{
      Object.defineProperty(document,'hidden',{configurable:true,value:true});
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForFunction(()=>document.querySelector('#summary-status').textContent.includes('已等候'));
    assert.equal(await page.evaluate(()=>harness.summarySignal.aborted),false);
    await page.evaluate(()=>harness.finishSummary());
    await page.waitForFunction(()=>!document.querySelector('#summary-copy').disabled);
    await page.evaluate(()=>{
      Object.defineProperty(document,'hidden',{configurable:true,value:false});
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const result=await page.locator('#summary-result').boundingBox();
    assert.ok(result.y>=0 && result.y<480,`Returned summary outside viewport: ${result.y}`);
    assert.equal(await page.locator('#summary-result').textContent(),'背景整理後的摘要。');
    assert.match(await page.locator('#summary-status').textContent(),/摘要已完成/);
  }finally{await page.close();}
});

test('summary finishing in another panel view stays available when returning to summary',async()=>{
  const page=await panelFixture();
  try {
    await page.setViewportSize({width:380,height:520});
    await page.evaluate(()=>{QingReadLocal.request=()=>new Promise(resolve=>{harness.finishSummary=()=>resolve({text:'切回後可見的摘要。'});});});
    await page.locator('[data-view=summary]').click();await page.locator('#summary-start').click();
    await page.waitForFunction(()=>Boolean(harness.finishSummary));
    await page.locator('[data-view=text]').click();
    await page.evaluate(()=>harness.finishSummary());
    await page.waitForFunction(()=>!document.querySelector('#summary-copy').disabled);
    assert.equal(await page.locator('[data-page=text]').isVisible(),true);
    assert.equal(await page.locator('[data-page=summary]').isVisible(),false);
    await page.locator('[data-view=summary]').click();
    const result=await page.locator('#summary-result').boundingBox();
    assert.ok(result.y>=0 && result.y<480,`Summary starts outside viewport after navigation: ${result.y}`);
  }finally{await page.close();}
});

test('site permission prompts for one host and verifies injection after grant without translating',async()=>{
  const page=await panelFixture();
  try {
    await page.evaluate(()=>{
      chrome.tabs.query=async()=>[{id:7,url:'https://learn.nvidia.com/courses/course-detail?secret=tracking'}];
      const inject=chrome.scripting.executeScript;
      chrome.scripting.executeScript=async options=>{if(!harness.granted)throw new Error('Cannot access contents of url "https://learn.nvidia.com/courses/course-detail?secret=tracking"');return inject(options);};
      chrome.permissions={request:async request=>{harness.permission=request;harness.gesture=navigator.userActivation.isActive;harness.granted=true;return true;}};
    });
    await page.locator('#start').click();await page.locator('#grant-site').click();
    await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('已確認可以載入'));
    const state=await page.evaluate(()=>harness);assert.deepEqual(state.permission,{origins:['https://learn.nvidia.com/*']});assert.equal(state.gesture,true);assert.equal(state.messages.length,0);
    assert.doesNotMatch(await page.locator('#detail').textContent(),/secret|tracking/);
  }finally{await page.close();}
});
test('script load failure does not suggest unnecessary site permission',async()=>{
  const page=await panelFixture();
  try {
    await page.evaluate(()=>{chrome.scripting.executeScript=async()=>{throw new Error('Could not load file: content.js');};});
    await page.locator('#start').click();await page.waitForFunction(()=>document.querySelector('#detail').textContent.includes('ExtensionLoadError'));
    assert.equal(await page.locator('#grant-site').isVisible(),false);
  }finally{await page.close();}
});

test('NVIDIA course shell reports embedded lesson instead of translating outer menus',async()=>{
 const page=await fixture('https://learn.nvidia.com/courses/course?course_id=test');
 try {
  await page.route('https://lesson.test/**',r=>r.fulfill({body:'<p>Embedded lesson.</p>',contentType:'text/html'}));
  const result=await page.evaluate(async()=>{
   document.body.innerHTML='<header><div>Products Solutions</div></header><div><a href="#intro">Introduction</a></div><iframe title="Lesson" src="https://lesson.test/unit" style="width:600px;height:400px"></iframe><iframe src="https://lesson.test/hidden" style="display:none;width:600px;height:400px"></iframe>';
   const batch=await message({type:'qingread:collect',job:'lesson',scope:'page'});
   const summary=await message({type:'qingread:summary-source',job:'summary',scope:'page'});
   return {batch,summary};
  });
  assert.equal(result.batch.reason,'embedded');assert.equal(result.batch.items.length,0);assert.equal(result.batch.frames.length,1);assert.equal(result.summary.reason,'embedded');
 }finally{await page.close();}
});
test('frame discovery opens only an explicitly selected live http source',async()=>{
 const page=await panelFixture();
 try {
  await page.evaluate(()=>{
   chrome.tabs.sendMessage=async()=>({frames:[{title:'Lesson',url:'https://lesson.test/unit'},{title:'Unsafe',url:'javascript:alert(1)'}]});
   chrome.tabs.create=async options=>{harness.opened=options;};
  });
  await page.locator('summary').filter({hasText:'課文沒有翻到'}).click();await page.locator('#scan-frames').click();
  await page.waitForFunction(()=>document.querySelector('#frames-list').children.length===1);
  assert.equal(await page.evaluate(()=>harness.opened),undefined);
  await page.locator('#frames-list button').click();assert.deepEqual(await page.evaluate(()=>harness.opened),{url:'https://lesson.test/unit'});
 }finally{await page.close();}
});

test('text tab translates pasted text from the click without reading the page; terms and glossary apply',async()=>{
  const page=await panelFixture();
  try {
    await page.evaluate(()=>{Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{harness.clipboard=text;}}});});
    await page.locator('[data-view=settings]').click();
    await page.locator('#terms').check();
    await page.locator('summary').filter({hasText:'自訂譯文詞彙表'}).click();
    await page.locator('#glossary').fill('滑鼠 => 滑鼠裝置');await page.locator('#save-glossary').click();
    await page.waitForFunction(()=>document.querySelector('#glossary-status').textContent.includes('已儲存 1'));
    await page.locator('[data-view=text]').click();
    assert.equal(await page.locator('#start').isVisible(),false);
    await page.locator('#text-input').fill('The default software uses a mouse.');
    assert.equal(await page.locator('#text-count').textContent(),'34 / 6,000 字元');
    await page.locator('#text-start').click();
    await page.waitForFunction(()=>document.querySelector('#text-status').textContent.includes('翻譯完成'));
    // Model output → Taiwan terms → user glossary, same order as webpage translation.
    assert.equal(await page.locator('#text-output').inputValue(),'預設軟體使用滑鼠裝置。');
    const state=await page.evaluate(()=>harness);
    assert.equal(state.userActivation,true);
    assert.deepEqual(state.options,{sourceLanguage:'en',targetLanguage:'zh-Hant'});
    assert.equal(state.injected,0);assert.equal(state.messages.length,0);
    assert.equal(state.destroyed,1);
    assert.equal(await page.locator('#text-input').isEditable(),true);
    await page.locator('#text-copy').click();
    await page.waitForFunction(()=>document.querySelector('#text-status').textContent.includes('已複製'));
    assert.equal(await page.evaluate(()=>harness.clipboard),'預設軟體使用滑鼠裝置。');
    await page.screenshot({path:path.join(__dirname,'../test-results/text.png'),fullPage:true});
    await page.locator('#text-input').fill('Changed.');
    assert.equal(await page.locator('#text-output').inputValue(),'');
    assert.equal(await page.locator('#text-copy').isDisabled(),true);
    assert.match(await page.locator('#text-status').textContent(),/原文已變更/);
  }finally{await page.close();}
});

test('text tab rejects empty or oversized input before creating an engine and keeps every chunk of long text',async()=>{
  const page=await panelFixture();
  try {
    await page.locator('[data-view=text]').click();
    await page.locator('#text-start').click();
    await page.waitForFunction(()=>document.querySelector('#text-status').textContent.includes('請先輸入'));
    // maxlength only limits typing; script-set or pasted values still reach the length check.
    await page.evaluate(()=>{document.querySelector('#text-input').value='a'.repeat(6001);});
    await page.locator('#text-start').click();
    await page.waitForFunction(()=>document.querySelector('#text-status').textContent.includes('最多 6,000'));
    assert.equal(await page.evaluate(()=>harness.created),0);
    const input='Do not delete the backup. '.repeat(100).trim();
    await page.locator('#text-input').fill(input);
    await page.locator('#text-start').click();
    await page.waitForFunction(()=>document.querySelector('#text-status').textContent.includes('翻譯完成'));
    const translations=await page.evaluate(()=>harness.translations);
    assert.ok(translations.length>1);assert.equal(translations.join(''),input);
    assert.equal((await page.locator('#text-output').inputValue()).split('\n').length,translations.length);
    await page.locator('#text-clear').click();
    assert.equal(await page.locator('#text-input').inputValue(),'');assert.equal(await page.locator('#text-output').inputValue(),'');
    assert.equal(await page.locator('#text-count').textContent(),'0 / 6,000 字元');
  }finally{await page.close();}
});

test('stopping text translation discards a delayed result and unlocks the input',async()=>{
  const page=await panelFixture();
  try {
    await page.evaluate(()=>{Translator.create=async()=>({destroy(){harness.destroyed++;},translate:()=>new Promise(resolve=>{harness.releaseText=()=>resolve('延遲譯文');})});});
    await page.locator('[data-view=text]').click();
    await page.locator('#text-input').fill('Do not delete the backup.');
    await page.locator('#text-start').click();
    await page.waitForFunction(()=>Boolean(harness.releaseText));
    assert.equal(await page.locator('#text-input').isEditable(),false);
    // Text and webpage translation share one running job.
    assert.equal(await page.locator('#start').isDisabled(),true);
    await page.locator('#text-stop').click();
    await page.waitForFunction(()=>document.querySelector('#text-status').textContent.includes('已停止'));
    await page.evaluate(async()=>{harness.releaseText();await new Promise(resolve=>setTimeout(resolve,50));});
    assert.equal(await page.locator('#text-output').inputValue(),'');
    assert.equal(await page.locator('#text-copy').isDisabled(),true);
    assert.equal(await page.locator('#text-input').isEditable(),true);
    assert.equal(await page.locator('#text-start').isEnabled(),true);
    assert.equal(await page.evaluate(()=>harness.destroyed),1);
  }finally{await page.close();}
});

for (const outcome of ['complete', 'stop', 'failure', 'clear']) {
  test(`long pasted text shows completed chunks early and handles ${outcome} without losing or mislabeling output`, async () => {
    const page = await panelFixture();
    try {
      await page.evaluate(() => {
        Object.defineProperty(navigator, 'clipboard', {configurable:true,value:{writeText:async text => { harness.clipboard = text; }}});
        Translator.create = async () => ({
          destroy() { harness.destroyed++; },
          translate(text) {
            harness.translations.push(text);
            if (harness.translations.length === 1) return Promise.resolve('第一段完整譯文。');
            return new Promise((resolve, reject) => {
              harness.finishText = () => resolve('第二段完整譯文。');
              harness.failText = () => reject(new Error('engine failed'));
            });
          }
        });
      });
      await page.locator('[data-view=text]').click();
      await page.locator('#text-input').fill('A'.repeat(1500));
      await page.locator('#text-start').click();
      await page.waitForFunction(() => Boolean(harness.finishText));
      assert.equal(await page.locator('#text-output').inputValue(), '第一段完整譯文。');
      assert.match(await page.locator('#text-status').textContent(), /尚未完整/);
      assert.equal(await page.locator('#text-input').isEditable(), false);
      await page.locator('#text-copy').click();
      await page.waitForFunction(() => harness.clipboard === '第一段完整譯文。');
      assert.match(await page.locator('#text-status').textContent(), /已複製部分譯文.*尚未完整/);
      if (outcome === 'complete') {
        await page.evaluate(() => harness.finishText());
        await page.waitForFunction(() => document.querySelector('#text-status').textContent.includes('翻譯完成'));
        assert.equal(await page.locator('#text-output').inputValue(), '第一段完整譯文。\n第二段完整譯文。');
        await page.locator('#text-copy').click();
        await page.waitForFunction(() => document.querySelector('#text-status').textContent === '已複製譯文。');
      } else if (outcome === 'clear') {
        // A clipboard request finishing after clear must not overwrite the clear status.
        await page.evaluate(() => { navigator.clipboard.writeText = () => new Promise(resolve => { harness.finishCopy = resolve; }); });
        await page.locator('#text-copy').click();
        await page.waitForFunction(() => Boolean(harness.finishCopy));
        await page.locator('#text-clear').click();
        await page.evaluate(() => { harness.finishText(); harness.finishCopy(); });
        await page.waitForFunction(() => !document.querySelector('#text-input').readOnly);
        assert.equal(await page.locator('#text-output').inputValue(), '');
        assert.equal(await page.locator('#text-input').inputValue(), '');
        assert.equal(await page.locator('#text-status').textContent(), '已清空原文與譯文。');
        assert.equal(await page.locator('#text-copy').isDisabled(), true);
      } else {
        if (outcome === 'stop') await page.locator('#text-stop').click();
        else await page.evaluate(() => harness.failText());
        await page.waitForFunction(() => !document.querySelector('#text-input').readOnly);
        await page.evaluate(() => harness.finishText());
        assert.equal(await page.locator('#text-output').inputValue(), '第一段完整譯文。');
        assert.match(await page.locator('#text-status').textContent(), /已保留 1 \/ 2 段譯文，尚未完整/);
        assert.equal(await page.locator('#text-copy').isEnabled(), true);
        await page.locator('#text-input').fill('A different source.');
        assert.equal(await page.locator('#text-output').inputValue(), '');
        assert.equal(await page.locator('#text-copy').isDisabled(), true);
      }
      assert.equal(await page.locator('#text-start').isEnabled(), true);
      assert.equal(await page.evaluate(() => harness.destroyed), 1);
      assert.equal(await page.evaluate(() => harness.injected), 0);
    } finally { await page.close(); }
  });
}

for (const changed of [false,true]) {
  test(`partial text retry ${changed ? 'rejects changed settings' : 'starts at the failed chunk and preserves completed output'}`,async()=>{
    const page=await panelFixture();
    try {
      await page.evaluate(()=>{
        Translator.create=async()=>({destroy(){},translate:async text=>{
          harness.translations.push(text);
          if(harness.translations.length===2)throw new Error('second chunk failed');
          return harness.translations.length===1?'第一段。':'第二段。';
        }});
      });
      await page.locator('[data-view=text]').click();
      await page.locator('#text-input').fill('A'.repeat(1500));
      await page.locator('#text-start').click();
      await page.waitForFunction(()=>!document.querySelector('#text-retry').hidden);
      assert.equal(await page.locator('#text-output').inputValue(),'第一段。');
      if(changed)await page.evaluate(()=>{document.querySelector('#terms').checked=!document.querySelector('#terms').checked;});
      await page.locator('#text-retry').click();
      if(changed){
        assert.match(await page.locator('#text-status').textContent(),/設定已變更/);
        assert.equal(await page.evaluate(()=>harness.translations.length),2);
      }else{
        await page.waitForFunction(()=>document.querySelector('#text-status').textContent.includes('翻譯完成'));
        const translated=await page.evaluate(()=>harness.translations);
        assert.equal(translated.length,3);assert.equal(translated[2],translated[1]);
        assert.equal(await page.locator('#text-output').inputValue(),'第一段。\n第二段。');
      }
      assert.equal(await page.locator('#text-retry').isVisible(),false);
    }finally{await page.close();}
  });
}

test('local text shows queue and generation phases and waits for cancellation acknowledgement',async()=>{
  const page=await panelFixture();
  try{
    await page.evaluate(()=>{
      chrome.storage.session={get:async()=>({companionToken:'a'.repeat(43)})};
      harness.stage='queued';
      fetch=async(url,options)=>{
        harness.messages.push({url,method:options.method});
        if(url.endsWith('/health'))return new Response(JSON.stringify({inference_jobs:true,inference_client_identity:true}));
        if(options.method==='DELETE')harness.stage='cancelling';
        return new Response(JSON.stringify({stage:harness.stage}));
      };
    });
    await page.selectOption('#engine','local');
    await page.locator('[data-view=text]').click();await page.locator('#text-input').fill('Synthetic input.');
    await page.locator('#text-start').click();
    await page.waitForFunction(()=>document.querySelector('#text-status').textContent.includes('正在排隊'));
    await page.evaluate(()=>{harness.stage='generating';});
    await page.waitForFunction(()=>document.querySelector('#text-status').textContent.includes('產生結果'));
    await page.locator('#text-stop').click();
    await page.waitForFunction(()=>document.querySelector('#text-status').textContent.includes('正在取消'));
    assert.equal(await page.locator('#text-start').isEnabled(),false);
    await page.evaluate(()=>{harness.stage='cancelled';});
    await page.waitForFunction(()=>document.querySelector('#text-status').textContent.includes('助手已確認'));
    assert.equal(await page.locator('#text-start').isEnabled(),true);
    assert.equal(await page.locator('#text-output').inputValue(),'');
    assert.equal(await page.evaluate(()=>harness.messages.filter(m=>m.method==='DELETE').length),1);
  }finally{await page.close();}
});

test('switching tabs keeps text translation running and leaves webpage status untouched',async()=>{
  const page=await panelFixture();
  try {
    await page.evaluate(()=>{Translator.create=async()=>({destroy(){harness.destroyed++;},translate:()=>new Promise(resolve=>{harness.releaseText=()=>resolve('請勿刪除備份。');})});});
    const webStatus=await page.locator('#status').textContent();
    await page.locator('[data-view=text]').click();
    await page.locator('#text-input').fill('Do not delete the backup.');
    await page.locator('#text-start').click();
    await page.waitForFunction(()=>Boolean(harness.releaseText));
    await page.evaluate(()=>{harness.currentTab=8;harness.onActivated({tabId:8});});
    assert.equal(await page.locator('#text-stop').isEnabled(),true);
    assert.doesNotMatch(await page.locator('#text-status').textContent(),/已停止/);
    await page.evaluate(()=>harness.releaseText());
    await page.waitForFunction(()=>document.querySelector('#text-status').textContent.includes('翻譯完成'));
    assert.equal(await page.locator('#text-output').inputValue(),'請勿刪除備份。');
    assert.equal(await page.locator('#status').textContent(),webStatus);
    assert.equal(await page.locator('#start').isEnabled(),true);
  }finally{await page.close();}
});

test('text tab with local engine posts only the pasted text and shows companion errors',async()=>{
  const page=await panelFixture();
  try {
    await page.evaluate(()=>{chrome.storage.session={get:async()=>({})};});
    await page.selectOption('#engine','local');await page.selectOption('#source','ja');
    await page.locator('[data-view=text]').click();
    await page.locator('#text-input').fill('バックアップを削除しないでください。');
    await page.locator('#text-start').click();
    await page.waitForFunction(()=>document.querySelector('#text-status').textContent.includes('完成配對'));
    assert.equal(await page.locator('#text-output').inputValue(),'');
    await page.evaluate(()=>{QingReadLocal.request=async(path,options)=>{harness.local={path,body:options.body};return {text:'請勿刪除備份。'};};});
    await page.locator('#text-start').click();
    await page.waitForFunction(()=>document.querySelector('#text-status').textContent.includes('翻譯完成'));
    assert.deepEqual(await page.evaluate(()=>harness.local),{path:'/translate',body:{text:'バックアップを削除しないでください。',source:'ja'}});
    assert.equal(await page.locator('#text-output').inputValue(),'請勿刪除備份。');
    assert.equal(await page.evaluate(()=>harness.created),0);
  }finally{await page.close();}
});


test('summary offers its own permission action and keeps requests scoped to the failed page',async()=>{
 const page=await panelFixture();try{
  await page.evaluate(()=>{
   const execute=chrome.scripting.executeScript;
   chrome.scripting.executeScript=async options=>{if(!harness.granted)throw new Error('Cannot access contents of url "https://article.test/overview"');return execute(options);};
   chrome.permissions={request:async request=>{harness.permission=request;harness.gesture=navigator.userActivation.isActive;harness.granted=true;return true;}};
   QingReadLocal.request=async()=>({text:'授權之後的摘要。'});
  });
  await page.locator('[data-view=summary]').click();await page.locator('#summary-start').click();await page.locator('#summary-grant').click();
  await page.waitForFunction(()=>document.querySelector('#summary-status').textContent.includes('網站授權完成'));
  assert.deepEqual(await page.evaluate(()=>harness.permission),{origins:['https://article.test/*']});
  assert.equal(await page.evaluate(()=>harness.gesture),true);
  await page.locator('#summary-start').click();await page.waitForFunction(()=>document.querySelector('#summary-result').textContent==='授權之後的摘要。');
 }finally{await page.close();}
});
test('summary permission fallback handles hidden URLs and clears on navigation',async()=>{
 const page=await panelFixture();try{
  await page.evaluate(()=>{
   chrome.tabs.query=async()=>[{id:7}];
   chrome.scripting.executeScript=async()=>{throw new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.');};
   chrome.permissions={addHostAccessRequest:async value=>{harness.accessRequest=value;}};
  });
  await page.locator('[data-view=summary]').click();await page.locator('#summary-start').click();await page.locator('#summary-grant').click();
  await page.waitForFunction(()=>document.querySelector('#summary-status').textContent.includes('尚未取得授權'));
  assert.deepEqual(await page.evaluate(()=>harness.accessRequest),{tabId:7});
  await page.evaluate(()=>harness.onActivated({tabId:8}));
  assert.equal(await page.locator('#summary-grant').isVisible(),false);
 }finally{await page.close();}
});
test('hidden-URL summary can grant only the pasted NTTU host and then read the article',async()=>{
  const page=await panelFixture();
  try{
    await page.evaluate(()=>{
      const url='https://aa.nttu.edu.tw/p/406-1002-179272,r1386.php?Lang=zh-tw';
      chrome.tabs.query=async()=>[{id:7,...(harness.granted?{url}:{})}];
      chrome.scripting.executeScript=async()=>{if(!harness.granted)throw new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.');return [{documentId:'article'}];};
      chrome.permissions={request:async options=>{harness.permission=options;harness.gesture=navigator.userActivation.isActive;harness.granted=true;return true;}};
      QingReadLocal.request=async()=>{harness.summaryRequests=(harness.summaryRequests||0)+1;return {text:'公告摘要。'};};
    });
    await page.locator('[data-view=summary]').click();await page.locator('#summary-start').click();
    await page.waitForFunction(()=>!document.querySelector('#summary-site-entry').hidden);
    assert.equal(await page.evaluate(()=>harness.summaryRequests||0),0);
    await page.locator('#summary-site-url').fill('https://aa.nttu.edu.tw/p/406-1002-179272,r1386.php?Lang=zh-tw');
    assert.equal(await page.locator('#summary-grant').textContent(),'允許 aa.nttu.edu.tw');
    await page.locator('#summary-grant').click();
    await page.waitForFunction(()=>document.querySelector('#summary-status').textContent.includes('網站授權完成'));
    assert.deepEqual(await page.evaluate(()=>harness.permission),{origins:['https://aa.nttu.edu.tw/*']});
    assert.equal(await page.evaluate(()=>harness.gesture),true);
    assert.equal(await page.locator('#summary-grant').isVisible(),false);
    assert.equal(await page.locator('#summary-site-url').inputValue(),'');
    await page.locator('#summary-start').click();await page.waitForFunction(()=>document.querySelector('#summary-result').textContent==='公告摘要。');
  }finally{await page.close();}
});

test('pending site requests are not repeated and are verified after native permission changes',async()=>{
  const page=await panelFixture();
  try{
    await page.evaluate(()=>{
      chrome.tabs.query=async()=>[{id:7}];
      chrome.scripting.executeScript=async()=>{if(!harness.granted)throw new Error('Cannot access contents of the page.');return [{documentId:'article'}];};
      chrome.permissions={addHostAccessRequest:async()=>{harness.requests=(harness.requests||0)+1;}};
    });
    await page.locator('[data-view=summary]').click();await page.locator('#summary-start').click();
    await page.waitForFunction(()=>!document.querySelector('#summary-grant').hidden);
    for(let i=0;i<3;i++)await page.locator('#summary-grant').click();
    assert.equal(await page.evaluate(()=>harness.requests),1);
    assert.match(await page.locator('#summary-status').textContent(),/尚未取得授權/);
    await page.evaluate(()=>{harness.granted=true;});
    await page.locator('#summary-grant').click();
    await page.waitForFunction(()=>document.querySelector('#summary-status').textContent.includes('網站授權完成'));
    assert.equal(await page.locator('#summary-grant').isVisible(),false);
  }finally{await page.close();}
});

test('a granted host that still rejects injection gives a terminal action instead of another grant loop',async()=>{
  const page=await panelFixture();
  try{
    await page.evaluate(()=>{
      chrome.scripting.executeScript=async()=>{throw new Error('Cannot access contents of url "https://article.test/"');};
      chrome.permissions={request:async()=>true};
    });
    await page.locator('[data-view=summary]').click();await page.locator('#summary-start').click();
    await page.waitForFunction(()=>!document.querySelector('#summary-grant').hidden);
    await page.locator('#summary-grant').click();
    await page.waitForFunction(()=>document.querySelector('#summary-status').textContent.includes('網站已授權'));
    assert.equal(await page.locator('#summary-grant').isVisible(),false);
    assert.match(await page.locator('#summary-status').textContent(),/重新整理.*網站存取設定/);
  }finally{await page.close();}
});

test('pasted permission URLs reject credentials and never inject into a different active host',async()=>{
  const page=await panelFixture();
  try{
    await page.evaluate(()=>{
      chrome.tabs.query=async()=>[{id:7,...(harness.granted?{url:'https://different.test/'}:{})}];
      chrome.scripting.executeScript=async()=>{harness.injectCalls=(harness.injectCalls||0)+1;throw new Error('Cannot access contents of the page.');};
      chrome.permissions={request:async()=>{harness.permissions=(harness.permissions||0)+1;harness.granted=true;return true;}};
    });
    await page.locator('[data-view=summary]').click();await page.locator('#summary-start').click();
    await page.waitForFunction(()=>!document.querySelector('#summary-site-entry').hidden);
    await page.locator('#summary-site-url').fill('https://user:secret@aa.nttu.edu.tw/');await page.locator('#summary-grant').click();
    assert.equal(await page.evaluate(()=>harness.permissions||0),0);
    assert.match(await page.locator('#summary-status').textContent(),/不接受含帳號密碼/);
    await page.locator('#summary-site-url').fill('https://aa.nttu.edu.tw/');await page.locator('#summary-grant').click();
    await page.waitForFunction(()=>document.querySelector('#summary-status').textContent.includes('頁面正在切換'));
    assert.equal(await page.evaluate(()=>harness.injectCalls),1,'After granting a pasted host, origin must be checked before injection');
  }finally{await page.close();}
});

test('summary script loading error never asks for more site permissions',async()=>{
 const page=await panelFixture();try{
  await page.evaluate(()=>{chrome.scripting.executeScript=async()=>{throw new Error('Could not load file: content.js');};});
  await page.locator('[data-view=summary]').click();await page.locator('#summary-start').click();
  await page.waitForFunction(()=>document.querySelector('#summary-stop').disabled);
  assert.equal(await page.locator('#summary-grant').isVisible(),false);
  assert.doesNotMatch(await page.locator('#summary-status').textContent(),/頁籤處理授權/);
 }finally{await page.close();}
});


test('activation in another window does not stop this window caption session',async()=>{
 const page=await panelFixture();try{
  await page.evaluate(()=>{
   chrome.tabs.query=async()=>[{id:7,windowId:10,url:'https://article.test/'}];
   chrome.tabs.sendMessage=async(_id,message)=>{harness.messages.push(message);return message.type==='qingread:media-read'?{text:'',version:1}:{ok:true};};
  });
  await page.locator('[data-view=video]').click();await page.locator('#video-start').click();
  await page.waitForFunction(()=>harness.messages.some(m=>m.type==='qingread:media-start'));
  await page.evaluate(()=>harness.onActivated({tabId:99,windowId:20}));
  assert.equal(await page.locator('#video-stop').isEnabled(),true);
  await page.evaluate(()=>harness.onActivated({tabId:8,windowId:10}));
  assert.equal(await page.locator('#video-stop').isEnabled(),false);
 }finally{await page.close();}
});
test('activation in another window does not cancel this window webpage translation',async()=>{
 const page=await panelFixture();try{
  await page.evaluate(()=>{
   chrome.tabs.query=async()=>[{id:7,windowId:10,url:'https://article.test/'}];
   Translator.create=async()=>({translate:()=>new Promise(resolve=>{harness.finishTranslation=()=>resolve('翻譯結果');}),destroy(){}});
  });
  await page.locator('#start').click();await page.waitForFunction(()=>Boolean(harness.finishTranslation));
  await page.evaluate(()=>harness.onActivated({tabId:99,windowId:20}));
  assert.equal(await page.locator('#stop').isEnabled(),true);
  await page.evaluate(()=>harness.onActivated({tabId:8,windowId:10}));
  await page.evaluate(()=>harness.finishTranslation());
  await page.waitForFunction(()=>document.querySelector('#stop').disabled);
  assert.equal(await page.evaluate(()=>harness.messages.some(m=>m.type==='qingread:apply')),false);
 }finally{await page.close();}
});

test('switching tabs while hover setup is pending cancels the late setup',async()=>{
 const page=await panelFixture();try{
  await page.evaluate(()=>{QingReadLocal.request=()=>new Promise(resolve=>{harness.finishHealth=()=>resolve({});});});
  await page.locator('[data-view=settings]').click();
  await page.evaluate(()=>{document.querySelector('#hover').checked=true;document.querySelector('#hover').dispatchEvent(new Event('change'));});
  await page.waitForFunction(()=>Boolean(harness.finishHealth));
  await page.evaluate(()=>{harness.onActivated({tabId:8,windowId:10});harness.finishHealth();});
  assert.equal(await page.locator('#hover').isChecked(),false);
  assert.equal(await page.evaluate(()=>harness.injected),0);
 }finally{await page.close();}
});


async function pairingWorkspace(mode='pending') {
 const page=await browser.newPage({viewport:{width:900,height:1000}});
 await page.route('https://pairing.test/**',r=>{
  const name=new URL(r.request().url()).pathname.slice(1)||'workspace.html';
  return r.fulfill({body:fs.readFileSync(path.join(extension,name)),contentType:name.endsWith('.svg')?'image/svg+xml':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html'});
 });
 await page.addInitScript(mode=>{
  globalThis.pairHarness={mode,saved:{},persisted:{},requests:[],gesture:false};
  globalThis.chrome={permissions:{request:async()=>{pairHarness.gesture=navigator.userActivation.isActive;return mode!=='permission-denied';}},storage:{session:{setAccessLevel:async()=>{},get:async()=>pairHarness.saved,set:async value=>Object.assign(pairHarness.saved,value),remove:async key=>{delete pairHarness.saved[key];}},local:{setAccessLevel:async()=>{},get:async()=>pairHarness.persisted,set:async value=>Object.assign(pairHarness.persisted,value),remove:async key=>{delete pairHarness.persisted[key];}}}};
  globalThis.fetch=async(url,options)=>{
   pairHarness.requests.push(url);
   let value={};
   if(url.endsWith('/pair/start')){
    if(mode==='old')return {ok:false,status:401,json:async()=>({})};
    value={id:'a'.repeat(43),code:'123456',expires_in:120};
   }else if(url.endsWith('/pair/status'))value=pairHarness.mode==='approved'?{state:'approved',token:'b'.repeat(43)}:{state:pairHarness.mode};
   else if(url.endsWith('/pair/cancel'))value={state:'cancelled'};
   else if(url.endsWith('/health'))value={models:[],ollama:false,speech_ready:false,pdf_assets_ready:false};
   else value={jobs:[]};
   return {ok:true,json:async()=>value};
  };
 },mode);
 await page.goto('https://pairing.test/workspace.html');
 return page;
}
test('one-click pairing displays matching code, blocks duplicate clicks and saves only after approval',async()=>{
 const page=await pairingWorkspace();try{
  await page.locator('#connect').click();await page.waitForFunction(()=>document.querySelector('#pair-status').textContent.includes('123456'));
  assert.equal(await page.locator('#connect').isDisabled(),true);assert.equal(await page.locator('#pair').isDisabled(),true);
  assert.equal(await page.evaluate(()=>pairHarness.saved.companionToken),undefined);
  assert.equal(await page.evaluate(()=>pairHarness.gesture),true);
  await page.screenshot({path:path.join(__dirname,'../test-results/pairing-pending.png'),fullPage:true});
  await page.evaluate(()=>{pairHarness.mode='approved';});
  await page.waitForFunction(()=>document.querySelector('#pair-status').textContent.includes('配對完成'));
  assert.equal(await page.evaluate(()=>pairHarness.saved.companionToken),'b'.repeat(43));
  assert.equal(await page.locator('#connect').isEnabled(),true);
  assert.equal(await page.evaluate(()=>pairHarness.requests.filter(x=>x.endsWith('/pair/start')).length),1);
 }finally{await page.close();}
});
test('cancelled pairing never saves a credential and asks assistant to dismiss confirmation',async()=>{
 const page=await pairingWorkspace();try{
  await page.locator('#connect').click();await page.waitForFunction(()=>document.querySelector('#pair-status').textContent.includes('123456'));
  await page.locator('#pair-cancel').click();await page.waitForFunction(()=>document.querySelector('#pair-status').textContent.includes('已取消'));
  await page.waitForFunction(()=>pairHarness.requests.some(x=>x.endsWith('/pair/cancel')));
  assert.equal(await page.evaluate(()=>pairHarness.saved.companionToken),undefined);
  assert.equal(await page.locator('#connect').isEnabled(),true);
 }finally{await page.close();}
});
test('pairing denial, expiry, unavailable desktop, old companion and denied browser permission are actionable',async()=>{
 for(const [mode,expected] of [['denied','已拒絕'],['expired','已逾時'],['unavailable','手動配對'],['old','舊版'],['permission-denied','允許本機連線']]){
  const page=await pairingWorkspace(mode);try{
   await page.locator('#connect').click();await page.waitForFunction(expected=>document.querySelector('#pair-status').textContent.includes(expected),expected);
   assert.equal(await page.evaluate(()=>pairHarness.saved.companionToken),undefined);
   assert.equal(await page.locator('#connect').isEnabled(),true);
   if(mode==='permission-denied')assert.equal(await page.evaluate(()=>pairHarness.requests.length),0);
  }finally{await page.close();}
 }
});


test('summary shows incremental text before completion and ignores updates after stop',async()=>{
 const page=await panelFixture();try{
  await page.evaluate(()=>{QingReadLocal.request=(_path,options)=>new Promise(resolve=>{harness.summaryProgress=options.onProgress;harness.summaryFinish=()=>resolve({text:'完成摘要'});});});
  await page.locator('[data-view=summary]').click();await page.locator('#summary-start').click();
  await page.waitForFunction(()=>Boolean(harness.summaryProgress));
  await page.evaluate(()=>harness.summaryProgress({text:'第一個重點。',done:false}));
  assert.equal(await page.locator('#summary-result').textContent(),'第一個重點。');
  assert.equal(await page.locator('#summary-output').isVisible(),true);
  assert.equal(await page.locator('#summary-copy').isDisabled(),true);
  await page.locator('#summary-stop').click();
  await page.evaluate(()=>{harness.summaryProgress({text:'晚到文字'});harness.summaryFinish();});
  assert.equal(await page.locator('#summary-result').textContent(),'第一個重點。');
  assert.match(await page.locator('#summary-status').textContent(),/尚未完成/);
 }finally{await page.close();}
});
test('summary truncation is labeled as partial instead of completed',async()=>{
 const page=await panelFixture();try{
  await page.evaluate(()=>{QingReadLocal.request=async()=>({text:'部分內容',truncated:true});});
  await page.locator('[data-view=summary]').click();await page.locator('#summary-start').click();
  await page.waitForFunction(()=>!document.querySelector('#summary-copy').disabled);
  assert.match(await page.locator('#summary-status').textContent(),/部分摘要/);
  assert.doesNotMatch(await page.locator('#summary-status').textContent(),/摘要已完成/);
 }finally{await page.close();}
});
test('stream client preserves split UTF-8 text and rejects a stream without completion',async()=>{
 const page=await browser.newPage();try{
  await page.goto('about:blank');
  await page.evaluate(()=>{
   globalThis.chrome={storage:{session:{get:async()=>({companionToken:'a'.repeat(43)})},local:{get:async()=>({})}}};
   globalThis.progress=[];
   globalThis.makeResponse=complete=>{
    const payload=JSON.stringify({text:'繁體重點',done:false})+'\n'+(complete?JSON.stringify({text:'繁體重點完成',done:true})+'\n':'');
    const bytes=new TextEncoder().encode(payload);
    return new Response(new ReadableStream({start(c){for(const b of bytes)c.enqueue(new Uint8Array([b]));c.close();}}),{headers:{'Content-Type':'application/x-ndjson'}});
   };
   globalThis.fetch=async(_url,options)=>{globalThis.streamAccept=options.headers.Accept;return makeResponse(true);};
  });
  await page.addScriptTag({path:path.join(extension,'local-client.js')});
  const result=await page.evaluate(async()=>{
   const result=await QingReadLocal.request('/summarize',{body:{text:'原文'},onProgress:e=>progress.push(e.text)});
   globalThis.fetch=async()=>makeResponse(false);let error='';
   try{await QingReadLocal.request('/summarize',{body:{text:'原文'},onProgress:()=>{}});}catch(e){error=e.message;}
   return {result,progress,error,accept:streamAccept};
  });
  assert.equal(result.result.text,'繁體重點完成');assert.deepEqual(result.progress,['繁體重點']);
  assert.equal(result.accept,'application/x-ndjson');assert.match(result.error,/尚未收到完整結果/);
 }finally{await page.close();}
});

test('summary switches tabs mid-generation without duplicate work and copies source attribution',async()=>{
 const page=await panelFixture();try{
  await page.evaluate(()=>{
   const query=chrome.tabs.query;
   chrome.tabs.query=async q=>(await query(q)).map(tab=>({...tab,title:'Original <b>article</b>'}));
   harness.summaryCalls=0;
   QingReadLocal.request=(_path,options)=>new Promise(resolve=>{
    harness.summaryCalls++;harness.summarySignal=options.signal;
    harness.progress=options.onProgress;harness.finish=()=>resolve({text:'完整摘要'});
   });
   Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{harness.copied=text;}}});
  });
  await page.locator('[data-view=summary]').click();await page.locator('#summary-start').click();
  await page.waitForFunction(()=>Boolean(harness.progress));
  await page.evaluate(()=>{harness.progress({text:'部分摘要'});harness.currentTab=8;harness.onActivated({tabId:8});});
  assert.equal(await page.locator('#summary-result').textContent(),'部分摘要');
  assert.equal(await page.locator('#summary-start').isDisabled(),true);
  assert.equal(await page.evaluate(()=>harness.summarySignal.aborted),false);
  await page.evaluate(()=>harness.finish());
  assert.equal(await page.evaluate(()=>harness.summaryCalls),1);
  assert.match(await page.locator('#summary-source').textContent(),/Original <b>article<\/b>/);
  assert.equal(await page.locator('#summary-source b').count(),0);
  await page.locator('#summary-copy').click();
  assert.match(await page.evaluate(()=>harness.copied),/Original <b>article<\/b>[\s\S]*完整摘要/);
 }finally{await page.close();}
});

for(const change of ['activated','url','removed'])test(`summary cancels source ${change} during extraction before submitting text`,async()=>{
 const page=await panelFixture();try{
  await page.evaluate(()=>{
   const send=chrome.tabs.sendMessage;
   chrome.tabs.sendMessage=(id,msg,options)=>msg.type==='qingread:summary-source'?new Promise(resolve=>{harness.releaseExtraction=()=>resolve({items:[{text:'Old source'}]});}):send(id,msg,options);
   harness.submitted=false;QingReadLocal.request=async()=>{harness.submitted=true;return {text:'Unexpected'};};
  });
  await page.locator('[data-view=summary]').click();await page.locator('#summary-start').click();
  await page.waitForFunction(()=>Boolean(harness.releaseExtraction));
  await page.evaluate(change=>{
   if(change==='activated')harness.onActivated({tabId:8});
   else if(change==='url')harness.onUpdated(7,{url:'https://article.test/next'});
   else harness.onRemoved(7);
   harness.releaseExtraction();
  },change);
  assert.equal(await page.evaluate(()=>harness.submitted),false);
  assert.equal(await page.locator('#summary-result').textContent(),'');
  assert.equal(await page.locator('#summary-start').isEnabled(),true);
 }finally{await page.close();}
});

test('workspace remembers an approved connection only when opted in and can forget it',async()=>{
 const page=await pairingWorkspace('approved');try{
  assert.equal(await page.locator('#remember-device').isChecked(),false);
  await page.locator('#remember-device').check();await page.locator('#connect').click();
  await page.waitForFunction(()=>document.querySelector('#pair-status').textContent.includes('配對完成'));
  assert.equal(await page.evaluate(()=>pairHarness.persisted.rememberedCompanionToken),'b'.repeat(43));
  await page.locator('#forget-device').click();
  await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('已忘記'));
  assert.deepEqual(await page.evaluate(()=>[pairHarness.saved,pairHarness.persisted]),[{},{}]);
  assert.equal(await page.locator('#remember-device').isChecked(),false);
  assert.equal(await page.locator('#health').textContent(),'尚未連線');
 }finally{await page.close();}
});

for(const outcome of ['success','failed','cancelled'])test(`caption collapse handoff ${outcome} preserves ownership and never closes before readiness`,async()=>{
 const page=await panelFixture();try{
  await page.evaluate(()=>{
   chrome.tabs.query=async()=>[{id:7,windowId:3,url:'https://article.test/'}];
   chrome.tabs.sendMessage=async(id,message)=>{harness.messages.push(message);return message.type==='qingread:media-read'?{text:'Keep the backup.',version:1,timelineVersion:1}:{ok:true};};
   harness.remoteCalls=[];harness.remoteState={active:false};
   chrome.runtime={sendMessage:async message=>{
    harness.remoteCalls.push(message.action);
    if(message.action==='prepare')return new Promise(resolve=>{harness.prepared=resolve;});
    if(message.action==='commit'){harness.remoteState={active:true,status:'字幕持續執行。'};return harness.remoteState;}
    if(message.action==='collapse')return {closed:true};
    if(message.action==='stop'){harness.remoteState={active:false,status:'已停止。'};return harness.remoteState;}
    return harness.remoteState;
   }};
  });
  await page.locator('[data-view=video]').click();await page.locator('#video-start').click();
  await page.waitForFunction(()=>!document.querySelector('#video-collapse').disabled);
  await page.locator('#video-collapse').click();await page.waitForFunction(()=>Boolean(harness.prepared));
  assert.equal(await page.evaluate(()=>harness.destroyed),0);
  assert.equal(await page.evaluate(()=>harness.remoteCalls.includes('collapse')),false);
  if(outcome==='cancelled')await page.locator('#video-stop').click();
  await page.evaluate(outcome=>harness.prepared(outcome==='failed'?{error:'背景引擎無法啟動。'}:{ready:true}),outcome);
  if(outcome==='success'){
   await page.waitForFunction(()=>harness.remoteCalls.includes('collapse'));
   assert.equal(await page.evaluate(()=>harness.destroyed),1);
   await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('pagehide'));});
   assert.equal(await page.evaluate(()=>harness.remoteCalls.includes('stop')),false);
   assert.equal(await page.evaluate(()=>harness.remoteCalls.filter(x=>x==='commit').length),1);
  }else{
   await page.waitForFunction(()=>document.querySelector('#video-background-status').textContent.includes('背景引擎無法啟動')||document.querySelector('#video-background-status').textContent.includes('已取消收合'));
   assert.equal(await page.evaluate(()=>harness.remoteCalls.includes('commit')),false);
   assert.equal(await page.evaluate(()=>harness.remoteCalls.includes('collapse')),false);
   if(outcome==='failed'){
    assert.equal(await page.evaluate(()=>harness.destroyed),0);
    assert.equal(await page.locator('#video-stop').isEnabled(),true);
    await page.locator('#video-stop').click();
   }
  }
 }finally{await page.close();}
});
