const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { chromium } = require('playwright');
const extension = path.resolve(__dirname, '../extension');
let browser;
before(async () => {
  fs.mkdirSync(path.resolve(__dirname, '../test-results'), { recursive: true });
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
});
after(async () => { await browser?.close(); });

async function mediaPage({ bilingual = false, mode = 'captions' } = {}) {
  const page = await browser.newPage({ viewport: { width: 1100, height: 740 } });
  await page.clock.install({ time: new Date('2026-10-29T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-29T00:00:01Z'));
  await page.setContent(`<style>
    body{margin:0;background:#f3f5f4;font:18px system-ui;color:#18382f}
    main{width:960px;margin:40px auto}h1{font-size:22px}
    #movie_player{position:relative;background:#16232c;border-radius:12px;overflow:hidden}
    video{display:block;width:960px;height:540px}
    .scene{position:absolute;top:80px;left:80px;color:#dbe6e8;font-size:30px}
    .ytp-caption-window-container{position:absolute;bottom:50px;left:60px;color:white}
  </style><main><h1>清讀 · 字幕閱讀測試（人工影片畫面）</h1><div id="movie_player">
    <video></video><div class="scene">A quieter way to read<br><small>Sample lesson · 01:24</small></div>
    <div class="ytp-caption-window-container"><span class="ytp-caption-segment">First caption.</span></div>
  </div></main>`);
  await page.evaluate(() => {
    const attach = Element.prototype.attachShadow;
    globalThis.shadows = new WeakMap();
    Element.prototype.attachShadow = function (options) { const shadow = attach.call(this, options); shadows.set(this, shadow); return shadow; };
    globalThis.chrome = { runtime: { id: 'test', getURL: p => 'chrome-extension://test/' + p, onMessage: { addListener: fn => { globalThis.listener = fn; } } } };
    globalThis.message = msg => new Promise(resolve => listener(msg, { id: 'test', url: 'chrome-extension://test/panel.html' }, resolve));
    Object.defineProperty(document.querySelector('video'), 'paused', { value: false, configurable: true });
    globalThis.setCue = async text => {
      document.querySelector('.ytp-caption-segment').textContent = text;
      return message({ type: 'qingread:media-read', session: 'test' });
    };
    globalThis.showCue = async (text, translation) => {
      const snapshot = await setCue(text);
      const result = await message({ ...snapshot, type: 'qingread:media-show', session: 'test', original: snapshot.text, text: translation });
      return { snapshot, result };
    };
    globalThis.displayState = () => {
      const box = document.querySelector('[data-qingread-media]');
      const shadow = box && shadows.get(box);
      return {
        exists: Boolean(box), text: shadow?.querySelector('p').textContent,
        originalHidden: shadow?.querySelector('small').hidden,
        sameBox: box === globalThis.firstBox,
        sourceOpacity: getComputedStyle(document.querySelector('.ytp-caption-window-container')).opacity,
        bottom: box?.getBoundingClientRect().bottom
      };
    };
  });
  await page.addScriptTag({ path: path.join(extension, 'media-content.js') });
  await page.evaluate(async ({ bilingual, mode }) => {
    await message({ type: 'qingread:media-start', session: 'test', mode, bilingual });
  }, { bilingual, mode });
  return page;
}

test('comfort captions keep one box across word growth, short gaps, and a delayed replacement', async () => {
  const page = await mediaPage();
  try {
    await page.evaluate(async () => { await showCue('First caption.', '先閱讀完整的一段字幕，不必追著每個字移動。'); globalThis.firstBox = document.querySelector('[data-qingread-media]'); });
    const initial = await page.evaluate(() => displayState());
    assert.equal(initial.sourceOpacity, '0');
    assert.equal(initial.originalHidden, true);
    await page.clock.runFor(300);
    await page.evaluate(() => setCue('First caption. More words'));
    await page.clock.runFor(300);
    await page.evaluate(() => setCue(''));
    await page.clock.runFor(400);
    await page.evaluate(() => showCue('Second caption.', '下一段準備好後，在相同位置整段替換。'));
    assert.equal((await page.evaluate(() => displayState())).text, initial.text);
    await page.clock.runFor(1100);
    const updated = await page.evaluate(() => displayState());
    assert.equal(updated.sameBox, true);
    assert.equal(updated.text, '下一段準備好後，在相同位置整段替換。');
    assert.equal(updated.bottom, initial.bottom);
    await page.screenshot({ path: path.resolve(__dirname, '../test-results/video-comfort.png') });
    await page.evaluate(() => message({ type: 'qingread:media-stop', session: 'test' }));
    const stopped = await page.evaluate(() => displayState());
    assert.equal(stopped.exists, false);
    assert.equal(stopped.sourceOpacity, '1');
  } finally { await page.close(); }
});

test('latest pending translation replaces intermediate results after minimum reading time', async () => {
  const page = await mediaPage();
  try {
    await page.evaluate(() => showCue('First.', '第一句保留閱讀時間。'));
    await page.clock.runFor(400);
    await page.evaluate(() => showCue('Second.', '不應閃一下的第二句。'));
    await page.clock.runFor(400);
    await page.evaluate(() => showCue('Third.', '目前最新的第三句。'));
    assert.equal((await page.evaluate(() => displayState())).text, '第一句保留閱讀時間。');
    await page.clock.runFor(1300);
    assert.equal((await page.evaluate(() => displayState())).text, '目前最新的第三句。');
  } finally { await page.close(); }
});

test('pause preserves captions for reading, while seek clears them and rejects old timeline results', async () => {
  const page = await mediaPage();
  try {
    const { snapshot } = await page.evaluate(() => showCue('First.', '暫停時可以慢慢讀。'));
    await page.evaluate(() => {
      const video = document.querySelector('video');
      Object.defineProperty(video, 'paused', { value: true, configurable: true });
      video.dispatchEvent(new Event('pause'));
    });
    await page.clock.runFor(15000);
    assert.equal((await page.evaluate(() => displayState())).text, '暫停時可以慢慢讀。');
    await page.evaluate(() => document.querySelector('video').dispatchEvent(new Event('seeking')));
    assert.equal((await page.evaluate(() => displayState())).exists, false);
    const result = await page.evaluate(snapshot => message({ ...snapshot, type: 'qingread:media-show', session: 'test', original: snapshot.text, text: '快轉前的舊譯文' }), snapshot);
    assert.equal(result.applied, false);
    assert.equal((await page.evaluate(() => displayState())).sourceOpacity, '1');
    await page.evaluate(() => showCue('First.', '快轉後的新譯文'));
    assert.equal((await page.evaluate(() => displayState())).text, '快轉後的新譯文');
  } finally { await page.close(); }
});

test('silence restores original captions after a short grace period without permanent stale text', async () => {
  const page = await mediaPage();
  try {
    await page.evaluate(() => showCue('First.', '短暫換句不閃爍。'));
    await page.clock.runFor(2100);
    await page.evaluate(() => setCue(''));
    await page.clock.runFor(1100);
    assert.equal((await page.evaluate(() => displayState())).exists, true);
    await page.clock.runFor(200);
    assert.equal((await page.evaluate(() => displayState())).exists, false);
    assert.equal((await page.evaluate(() => displayState())).sourceOpacity, '1');
    await page.evaluate(() => showCue('First.', '等待下一句的舊譯文。'));
    await page.evaluate(() => setCue('A completely different sentence.'));
    await page.clock.runFor(6100);
    assert.equal((await page.evaluate(() => displayState())).exists, false);
  } finally { await page.close(); }
});

test('growing source accepts a translated prefix but unrelated late results are rejected', async () => {
  const page = await mediaPage();
  try {
    const snapshot = await page.evaluate(() => setCue('Keep the backup'));
    await page.evaluate(() => setCue('Keep the backup for seven days.'));
    const result = await page.evaluate(snapshot => message({ ...snapshot, type: 'qingread:media-show', session: 'test', original: snapshot.text, text: '保留備份' }), snapshot);
    assert.equal(result.applied, true);
    await page.evaluate(() => setCue('The lesson has ended.'));
    const stale = await page.evaluate(snapshot => message({ ...snapshot, type: 'qingread:media-show', session: 'test', original: snapshot.text, text: '不得回填的舊譯文' }), snapshot);
    assert.equal(stale.applied, false);
    assert.equal((await page.evaluate(() => displayState())).text, '保留備份');
  } finally { await page.close(); }
});

test('bilingual option uses stable original text and fullscreen relocation preserves the overlay', async () => {
  const page = await mediaPage({ bilingual: true });
  try {
    await page.evaluate(async () => { await showCue('Read at your own pace.', '照自己的步調閱讀。'); globalThis.firstBox = document.querySelector('[data-qingread-media]'); });
    assert.equal((await page.evaluate(() => displayState())).originalHidden, false);
    await page.evaluate(() => {
      Object.defineProperty(document, 'fullscreenElement', { value: document.querySelector('#movie_player'), configurable: true });
      document.dispatchEvent(new Event('fullscreenchange'));
    });
    assert.equal((await page.evaluate(() => displayState())).sameBox, true);
    assert.equal(await page.evaluate(() => document.querySelector('[data-qingread-media]').parentNode.id), 'movie_player');
    await page.screenshot({ path: path.resolve(__dirname, '../test-results/video-comfort-bilingual.png') });
    await page.evaluate(() => document.querySelector('video').remove());
    await page.clock.runFor(100);
    assert.equal((await page.evaluate(() => displayState())).sourceOpacity, '1');
  } finally { await page.close(); }
});

test('rolling-line tolerance rejects expired overlap and short coincidental word matches', async () => {
  const page = await mediaPage();
  try {
    const first = await page.evaluate(() => setCue('Earlier context avoid overly technical jargon'));
    await page.evaluate(() => setCue('avoid overly technical jargon and formulas'));
    const accepted = await page.evaluate(snapshot => message({ ...snapshot, type:'qingread:media-show', session:'test', original:snapshot.text, text:'避免過度專業的術語' }), first);
    assert.equal(accepted.applied, true);
    await page.clock.runFor(3100);
    const expired = await page.evaluate(snapshot => message({ ...snapshot, type:'qingread:media-show', session:'test', original:snapshot.text, text:'不可延長過期內容' }), first);
    assert.equal(expired.applied, false);
    const short = await page.evaluate(() => setCue('A different sentence ends for you'));
    await page.evaluate(() => setCue('for you another topic begins'));
    const unrelated = await page.evaluate(snapshot => message({ ...snapshot, type:'qingread:media-show', session:'test', original:snapshot.text, text:'兩個共通字不代表同一句' }), short);
    assert.equal(unrelated.applied, false);
  } finally { await page.close(); }
});

test('media-read reports actual overlay visibility separately from accepted pending text', async () => {
  const page = await mediaPage();
  try {
    let cue = await page.evaluate(() => setCue('First caption.'));
    assert.equal(cue.display.visible, false);
    await page.evaluate(() => showCue('First caption.', '第一句'));
    cue = await page.evaluate(() => setCue('First caption.'));
    assert.deepEqual(cue.display, {visible:true,current:true,pending:false});
    await page.evaluate(() => showCue('A new topic.', '第二句'));
    cue = await page.evaluate(() => message({type:'qingread:media-read',session:'test'}));
    assert.deepEqual(cue.display, {visible:true,current:false,pending:true});
    await page.clock.runFor(2100);
    cue = await page.evaluate(() => message({type:'qingread:media-read',session:'test'}));
    assert.deepEqual(cue.display, {visible:true,current:true,pending:false});
    await page.evaluate(() => setCue(''));
    await page.clock.runFor(2200);
    cue = await page.evaluate(() => message({type:'qingread:media-read',session:'test'}));
    assert.deepEqual(cue.display, {visible:false,current:false,pending:false});
  } finally { await page.close(); }
});

test('late rejected speech never extends the lifetime of a displayed caption', async () => {
  const page = await mediaPage({ mode: 'speech' });
  try {
    const { snapshot } = await page.evaluate(() => showCue('Spoken sentence.', '語音字幕。'));
    await page.clock.runFor(7500);
    const result = await page.evaluate(snapshot => message({ ...snapshot, timelineVersion: snapshot.timelineVersion - 1,
      type: 'qingread:media-show', session: 'test', original: 'Old speech', text: '舊語音' }), snapshot);
    assert.equal(result.applied, false);
    await page.clock.runFor(600);
    assert.equal((await page.evaluate(() => displayState())).exists, false);
  } finally { await page.close(); }
});

test('recorded YouTube rolling-caption timing stays readable with simulated translation latency', async () => {
  for (const fixture of ['youtube-caption-timing', 'youtube-fast-caption-timing']) {
  const timing = require(`./fixtures/${fixture}.json`);
  const reports = [];
  // Both fast and slower engines exercise invalidation while the source keeps rolling.
  for (const latency of [350, 1300]) {
    const page = await mediaPage();
    try {
      await page.addScriptTag({ path: path.join(extension, 'caption-state.js') });
      await page.evaluate(({ events, latency }) => {
        const buffer = QingReadCaptions.createCueBuffer();
        const start = performance.now();
        let busy = false, previous = null, firstBox = null;
        globalThis.replayReport = { latency, submissions:0, accepted:0, rejected:0, blanks:0, boxReplacements:0, displayed:[] };
        // Record the actual DOM change. A 100 ms polling sample can round one
        // change up and the next down, falsely turning a 2 s hold into 1.9 s.
        const attach = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function (options) {
          const shadow = attach.call(this, options);
          new MutationObserver(() => {
            const text = shadow.querySelector('p')?.textContent;
            if (text && text !== previous) {
              replayReport.displayed.push({ms:performance.now()-start,text});
              previous = text;
            }
          }).observe(shadow, {childList:true,subtree:true,characterData:true});
          return shadow;
        };
        for (const event of events) setTimeout(() => { void setCue(event.text); }, event.ms);
        setInterval(async () => {
          const source = await message({ type:'qingread:media-read', session:'test' });
          buffer.observe(source, performance.now());
          if (busy) return;
          const candidate = buffer.take(performance.now());
          if (!candidate) return;
          busy = true;
          const number = ++replayReport.submissions;
          setTimeout(async () => {
            const response = await message({ ...candidate, type:'qingread:media-show', session:'test', original:candidate.text, text:`人工測試譯文 ${number}` });
            replayReport[response.applied ? 'accepted' : 'rejected']++;
            busy = false;
          }, latency);
        }, 250);
        setInterval(() => {
          const box = document.querySelector('[data-qingread-media]');
          if (box && !firstBox) firstBox = box;
          if (firstBox && !box) replayReport.blanks++;
          if (box && box !== firstBox) replayReport.boxReplacements++;
        }, 100);
      }, { events: timing.events, latency });
      await page.clock.runFor(timing.events.at(-1).ms + 3500);
      const report = await page.evaluate(() => replayReport);
      reports.push(report);
      assert.ok(report.displayed.length >= 2, 'The latest captions must actually become readable: ' + JSON.stringify(report));
      assert.ok(report.submissions < timing.events.length / 2, 'Word growth must not produce a request per update');
      assert.equal(report.blanks, 0, 'The display must not blink blank between valid translations');
      assert.equal(report.boxReplacements, 0, 'One overlay must survive the rolling source');
      for (let i = 1; i < report.displayed.length; i++)
        assert.ok(report.displayed[i].ms - report.displayed[i-1].ms >= 2000, 'Every displayed block needs reading time: ' + JSON.stringify({fixture,report}));
    } finally { await page.close(); }
  }
  fs.writeFileSync(path.resolve(__dirname, `../test-results/${fixture}-replay.json`), JSON.stringify({
    source:timing.source, sampleStartSeconds:timing.sampleStartSeconds, sampleEndSeconds:timing.sampleEndSeconds,
    sourceChanges:timing.events.length-1, translation:'simulated; not a real model quality test', reports
  }, null, 2));
  }
});
