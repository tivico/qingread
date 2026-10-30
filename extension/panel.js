/* global QingReadCore */
'use strict';
const { LIMITS, LANGUAGES, splitText, localize, errorText } = QingReadCore;
const $ = id => document.getElementById(id);
let running = null;
let ready = false;
let availabilityEpoch = 0;
let glossaryRules = [];
let siteAccessTarget = null;
async function checkAvailability() {
  const epoch = ++availabilityEpoch, source = $('source').value;
  if ($('engine').value === 'local') {
    ready = true; $('engine-status').textContent = '需要啟動並配對本機助手；可在下方「PDF 與助手設定」完成。'; controls(Boolean(running)); return;
  }
  ready = false; controls(Boolean(running));
  if (typeof globalThis.Translator?.availability !== 'function' || typeof globalThis.Translator?.create !== 'function') {
    $('engine-status').textContent = '此環境未提供 Chrome 語言組合檢查，請更新瀏覽器或手動選本機助手。'; return;
  }
  $('engine-status').textContent = '正在檢查所選語言 → 繁體中文…';
  try {
    const availability = await Translator.availability({sourceLanguage:source,targetLanguage:'zh-Hant'});
    if (epoch !== availabilityEpoch) return;
    ready = ['available','downloadable','downloading'].includes(availability);
    $('engine-status').textContent = ({available:'語言組合可用 · 翻譯成繁體中文',downloadable:'按開始準備語言包，首次可能需要下載。',downloading:'此語言組合準備中，開始後可查看進度。',unavailable:'此環境不支援所選語言組合。請換語言或手動選本機助手。'})[availability] || '無法確認語言組合，請稍後重新選取。';
  } catch { if(epoch===availabilityEpoch) $('engine-status').textContent = '語言組合檢查失敗，請重新選取語言再試。'; }
  if(epoch===availabilityEpoch) controls(Boolean(running));
}
function status(text, detail) {
  $('grant-site').hidden = true;
  $('status').textContent = text;
  if (detail !== undefined) $('detail').textContent = detail;
}
function controls(busy) {
  $('start').disabled = busy || !ready;
  $('text-start').disabled = busy || !ready;
  $('source').disabled = busy; $('scope').disabled = busy;
  $('terms').disabled = busy;
  $('stop').disabled = !busy;
  $('restore').disabled = busy;
  $('engine').disabled = busy; $('detect').disabled = busy;
  $('glossary').disabled = busy; $('save-glossary').disabled = busy;
  $('test-engine').disabled = busy || !ready;
}
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!Number.isInteger(tab?.id) || tab.id < 0) throw new DOMException('No active tab', 'PageMissingError');
  // URL is a permission-protected property, not proof that a tab is readable.
  if (tab.url && !/^https?:\/\//i.test(tab.url)) throw new DOMException('Restricted scheme', 'PageRestrictedError');
  return tab;
}
async function inject(tab, file = 'content.js') {
  let result;
  try { result = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [file] }); }
  catch (cause) {
    const name = QingReadCore.injectionErrorName(cause);
    siteAccessTarget = null;
    if (name === 'PageAccessError') {
      // Only parse the browser's known permission error format; never display its raw URL/query.
      const match = String(cause?.message || '').match(/Cannot access contents of url ["'](https?:\/\/[^"']+)["']/i);
      try {
        const url = new URL(tab.url || match?.[1]);
        if (/^https?:$/.test(url.protocol)) siteAccessTarget = {tabId:tab.id, windowId:tab.windowId, origin:url.origin, pattern:url.protocol+'//'+url.hostname+'/*'};
      } catch { /* Fall back to Chrome's tab-based request when URL is withheld. */ }
    }
    const error = new DOMException('Page injection failed', name);
    error.accessTarget = siteAccessTarget;
    throw error;
  }
  const documentId = result[0]?.documentId;
  if (!documentId) throw new DOMException('Missing document', 'PageReadError');
  return { tabId: tab.id, windowId: tab.windowId, documentId };
}
function send(target, message) {
  return chrome.tabs.sendMessage(target.tabId, message, { documentId: target.documentId }).catch(() => { throw new DOMException('Missing receiver', 'PageReadError'); });
}
function createTranslator(job, source) {
  if ($('engine').value === 'local') return Promise.resolve(QingReadLocal.translator(source,{expectedIdentity:job.resumeIdentity,onProgress:event=>{
    if(running!==job || job.controller.signal.aborted)return;
    const message=QingReadLocal.stageText(event);
    if(message){if(job.report)job.report(message);else status(message);}
  }}));
  return Translator.create({sourceLanguage:source,targetLanguage:'zh-Hant',signal:job.controller.signal,monitor(monitor) {
    monitor.addEventListener('downloadprogress', event => {if(running===job){const message=`正在準備語言包 ${Math.round(event.loaded*100)}%…`; if(job.report)job.report(message);else status(message);}});
  }});
}
function waitForEngine(promise, job) {
  return new Promise((resolve,reject) => {
    const signal=job.controller.signal;
    const abort=()=>{clearTimeout(timer);reject(new DOMException('Stopped','AbortError'));};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);reject(new DOMException('Engine timed out','TimeoutError'));},QingReadLocal.TIMEOUT_MS);
    signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted)abort();
    Promise.resolve(promise).then(resolve,reject).finally(()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);});
  });
}
function showFailure(error, job) {
  if (error.name === 'PageAccessError') siteAccessTarget = error.accessTarget || null;
  const stage = job.stage || 'engine-create';
  const labels = {'engine-create':'啟動翻譯引擎','page-read':'讀取網頁','engine-translate':'翻譯文字','page-apply':'顯示譯文'};
  const pageError = ['PageAccessError','PageReadError','PageMissingError','PageRestrictedError','PageChangedError','ExtensionLoadError','PageInjectionError'].includes(error.name);
  const name = /^[A-Za-z]{1,40}$/.test(error.name || '') ? error.name : 'Error';
  const label = pageError ? labels['page-read'] : labels[stage];
  const unknown = !pageError && name === 'Error' && $('engine').value === 'chrome';
  const hint = pageError ? (error.name === 'PageAccessError' ? (siteAccessTarget ? `請按「允許 ${new URL(siteAccessTarget.origin).hostname}」，在 Chrome 提示中確認；只申請這個網站。` : '請按「允許此網站」，再到 Chrome 工具列的拼圖選單確認允許。') : errorText(error))
    : stage.startsWith('engine') ? '按「測試引擎」確認固定句子能否翻譯；若同樣失敗，可在引擎選單改用已配對的本機模型。'
    : '重新整理網頁後重試。';
  status(unknown ? `${label}失敗，尚無法確認原因。` : failure(error),
    `失敗步驟：${label}
清讀 0.3.8 · ${$('engine').value} · ${$('source').value} → zh-Hant
診斷：${pageError ? 'page-read' : stage} / ${name}
${hint}`);
  if (error.name === 'PageAccessError') { $('grant-site').textContent = siteAccessTarget ? '允許 '+new URL(siteAccessTarget.origin).hostname : '允許此網站'; $('grant-site').hidden = false; }
}
function failure(error) {
  return ['PageAccessError','PageReadError','PageMissingError','PageRestrictedError','PageChangedError','ExtensionLoadError','PageInjectionError','TimeoutError','AbortError'].includes(error.name) || $('engine').value==='chrome' ? errorText(error) : error.message;
}
function assertLive(job) {
  if (running !== job || job.controller.signal.aborted) throw new DOMException('Stopped', 'AbortError');
}
function cancel(reason) {
  const job = running;
  if (!job) return;
  running = null;
  job.controller.abort();
  const cleanup = job.translator?.destroy();
  if (job.target) void send(job.target, { type: 'qingread:cancel', job: job.id }).catch(() => {});
  controls(false);
  status(reason, '已完成的譯文會保留。再次開始可處理尚未翻譯的段落；如需重翻，請先還原網頁。');
  if(job.translator?.managed){
    const cancelling=reason+' 正在通知助手取消…';status(cancelling);
    void cleanup.then(results=>{if(!running && $('status').textContent===cancelling)status(reason+' '+QingReadLocal.cancellationText(results));});
  }
}
async function start() {
  if (!ready || running) return;
  const source = $('source').value;
  if (!Object.hasOwn(LANGUAGES, source)) return;
  const job = { id: crypto.randomUUID(), controller: new AbortController(), translator: null, target: null, stage: 'engine-create', glossary: glossaryRules.map(rule => [...rule]) };
  running = job; controls(true);
  $('start').scrollIntoView({block:'start'});
  $('progress').value = 0;
  status('正在準備本機翻譯…', '首次使用可能需要下載語言包。請保持側邊欄開啟；下載期間可以停止。');
  try {
    const tabResult = activeTab().then(tab => { job.tabId = tab.id; return { tab }; }, error => ({ error }));
    // Call create directly inside the click handler, before awaiting other APIs.
    // Chrome may require transient user activation to download a language pack.
    job.creation = Promise.resolve(createTranslator(job,source)).then(translator=>({translator}),error=>({error}));
    job.stage = 'page-read';
    const result = await tabResult;
    if (result.error) throw result.error;
    const tab = result.tab;
    const currentTab = await activeTab(); assertLive(job);
    if (currentTab.id !== tab.id) throw new DOMException('Page changed', 'AbortError');
    status('正在讀取目前網頁…', '檢查頁面存取權與可翻譯文字。');
    job.target = await inject(tab); assertLive(job);
    const batch = await send(job.target, { type: 'qingread:collect', job: job.id, scope: $('scope').value });
    assertLive(job);
    if (batch?.error === 'changed') throw new DOMException('Page changed during extraction','PageChangedError');
    if (!batch || batch.error || !Array.isArray(batch.items) || batch.items.length > LIMITS.paragraphs) throw new DOMException('Invalid batch','PageReadError');
    if (batch.frames?.length) globalThis.QingReadFrames?.show(batch.frames,job.target);
    if (!batch.items.length) {
      if (batch.reason === 'embedded') status('偵測到內嵌頁面，尚未翻譯課文。', '請展開「課文沒有翻到？」，選擇課文來源並在新分頁開啟，再點清讀翻譯。');
      else if (batch.reason === 'selection') status('請先在網頁反白要翻譯的文字。', '選好文字後，再按開始翻譯。');
      else if (batch.reason === 'translated') status('目前辨識範圍內的段落已翻譯。', '如需重翻，請先按還原目前網頁。若仍有漏掉的正文，可反白指定文字。');
      else status('沒有讀到可翻譯的正文。', '可先反白畫面上的文字，改選「只翻譯反白文字」重試；若仍沒有結果，可能是框架或特殊頁面結構，請提供網址協助排查。');
      return;
    }
    status(`找到 ${batch.items.length} 段，正在準備翻譯引擎…`, '若長時間沒有進展，可停止後按「測試引擎」。');
    job.stage = 'engine-create';
    const created = await waitForEngine(job.creation,job); assertLive(job);
    if(created.error)throw created.error;
    job.translator=created.translator;
    let completed = 0, skipped = 0, failed = 0, characters = 0;
    $('progress').max = batch.items.length;
    const pending = [...batch.items];
    while (pending.length) {
      assertLive(job);
      if ($('scope').value !== 'selection') {
        const order = await send(job.target, {type:'qingread:prioritize',job:job.id}); assertLive(job);
        if (Array.isArray(order?.ids)) {
          const ranks = new Map(order.ids.map((id,index) => [id,index]));
          pending.sort((a,b) => (ranks.get(a.id) ?? Infinity)-(ranks.get(b.id) ?? Infinity));
        }
      }
      const item = pending.shift();
      if (typeof item.id !== 'string' || typeof item.text !== 'string' || (characters += item.text.length) > LIMITS.characters) throw new Error('limit');
      status(`正在翻譯第 ${completed + skipped + failed + 1}／${batch.items.length} 段…`, '文字由所選的本機引擎處理，請保持側邊欄開啟。');
      try {
        job.stage = 'engine-translate';
        const outputs = [];
        for (const chunk of splitText(item.text)) {
          const output = await waitForEngine(job.translator.translate(chunk, { signal: job.controller.signal }),job);
          assertLive(job);
          if (typeof output !== 'string' || !output.trim() || output.length > 20000) throw new Error('output');
          outputs.push(output.trim());
        }
        const translated = outputs.join('\n');
        job.stage = 'page-apply';
        const response = await send(job.target, { type: 'qingread:apply', job: job.id, id: item.id, text: QingReadCore.applyGlossary($('terms').checked ? localize(translated) : translated, job.glossary) });
        assertLive(job);
        if (!response || response.error) throw new DOMException('Invalid apply response','PageReadError');
        if (response.applied) completed++; else skipped++;
      } catch (error) {
        assertLive(job);
        if (completed === 0 || ['AbortError','NotSupportedError','TimeoutError','PageAccessError','PageReadError'].includes(error.name)) throw error;
        failed++;
        // A missing document invalidates all remaining results; never redirect them to a new page.
        const current = await activeTab();
        if (current.id !== job.target.tabId) throw new DOMException('Page changed', 'AbortError');
        if (failed >= 3) throw error;
      }
      $('progress').value = completed + skipped + failed;
    }
    status(`完成 ${completed} 段${skipped ? `，頁面變動略過 ${skipped} 段` : ''}${failed ? `，失敗 ${failed} 段` : ''}。`, batch.limited ? '本頁達到處理上限。可再次開始處理其餘段落；超過 60,000 字元的單一段落請改用反白翻譯。' : (batch.frames?.length ? '僅完成外層頁面，不含內嵌課文。請展開「課文沒有翻到？」查看課文來源。' : '可以繼續閱讀。動態新增內容需再次按開始；還原會移除本外掛插入的譯文。'));
  } catch (error) {
    if (running === job) showFailure(error, job);
  } finally {
    job.controller.abort();
    job.translator?.destroy();
    if(!job.translator) void job.creation?.then(result=>result.translator?.destroy());
    if (running === job) { running = null; controls(false); }
  }
}
$('start').addEventListener('click', start);
$('test-engine').onclick = async () => {
  if(running || !ready)return;
  const job={id:crypto.randomUUID(),controller:new AbortController(),translator:null};running=job;controls(true);
  const source=$('source').value;
  const sample={en:'Do not delete the backup.',ja:'バックアップを削除しないでください。',ko:'백업을 삭제하지 마세요.',de:'Löschen Sie die Sicherung nicht.',fr:'Ne supprimez pas la sauvegarde.',es:'No elimine la copia de seguridad.'}[source];
  status('正在測試引擎…','只翻譯內建句子，不讀取網頁；首次可能下載模型。');
  try {
    job.creation=Promise.resolve(createTranslator(job,source)).then(translator=>({translator}),error=>({error}));
    const created=await waitForEngine(job.creation,job);assertLive(job);if(created.error)throw created.error;job.translator=created.translator;
    job.stage='engine-translate';
    const text=await waitForEngine(job.translator.translate(sample,{signal:job.controller.signal}),job);assertLive(job);
    if(typeof text!=='string'||!text.trim())throw new Error('模型沒有回傳文字。');
    status('引擎有回應。請確認下方譯文是否為中文。',`原文：${sample}\n譯文：${text}\n若這裡正常、網頁沒中文，請檢查頁面權限或反白範圍。`);
  }catch(error){if(running===job)showFailure(error,job);}
  finally {job.controller.abort();job.translator?.destroy();if(!job.translator)void job.creation?.then(result=>result.translator?.destroy());if(running===job){running=null;controls(false);}}
};
$('stop').addEventListener('click', () => cancel('已停止翻譯。'));
$('restore').addEventListener('click', async () => {
  $('restore').disabled = true;
  try {
    const tab = await activeTab();
    const target = await inject(tab);
    const result = await send(target, { type: 'qingread:restore' });
    if (!result?.restored) throw new Error('restore');
    $('progress').value = 0;
    status('已還原目前網頁。', '原文保持不變，僅移除清讀插入的譯文。');
  } catch (error) { status(errorText(error)); }
  finally { $('restore').disabled = Boolean(running); }
});
for (const id of ['source', 'scope', 'terms', 'engine']) {
  $(id).addEventListener('change', () => {
    if (id === 'engine' || id === 'source') void checkAvailability();
    void chrome.storage.local.set({ source: $('source').value, scope: $('scope').value, terms: $('terms').checked, engine: $('engine').value }).catch(() => status('設定未能儲存，本次仍可使用。'));
  });
}
// Pasted-text jobs never read a page, so another tab cannot invalidate them.
chrome.tabs.onActivated.addListener(info => { if (Number.isInteger(running?.target?.windowId) && info.windowId !== running.target.windowId) return; if (running && running.kind !== 'text') cancel('已切換分頁，翻譯已停止。'); });
chrome.tabs.onUpdated.addListener((id, change) => {
  if (running && change.status === 'loading' && id === running.tabId) cancel('頁面已重新載入，翻譯已停止。');
});
window.addEventListener('pagehide', () => cancel('側邊欄已關閉。'));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') cancel('側邊欄已隱藏，翻譯已停止。');
});
(async () => {
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    const preferences = await chrome.storage.local.get(['source', 'scope', 'terms', 'engine', 'glossary']);
    if (typeof preferences.glossary === 'string') {
      try { glossaryRules = QingReadCore.parseGlossary(preferences.glossary); $('glossary').value = preferences.glossary; }
      catch { $('glossary-status').textContent = '已儲存的詞彙表格式有誤，本次不套用；請重新編輯儲存。'; }
    }
    if (preferences.engine === 'local') $('engine').value = 'local';
    if (Object.hasOwn(LANGUAGES, preferences.source)) $('source').value = preferences.source;
    // Start each new panel with a whole-page scope; stale selection preferences
    // otherwise make an ordinary click do nothing on a newly opened page.
    $('scope').value = 'page';
    $('terms').checked = preferences.terms === true;
  } catch { /* Preferences are optional; never prevent translation. */ }
  await checkAvailability();
  $('start').textContent = '開始翻譯'; controls(false);
  status(ready ? '準備好了，請開啟外文網頁後開始。' : (typeof globalThis.Translator?.create === 'function' ? '所選語言組合尚未準備好，請查看引擎狀態。' : '這個 Chrome 尚未提供本機翻譯介面。'), ready ? '請先選對原文語言。側邊欄只在你按開始後擷取網頁。' : '可重新選擇語言、更新瀏覽器或手動改用本機助手；不會自動切換雲端服務。');
})();
$('save-glossary').onclick = async () => {
  try {
    const rules = QingReadCore.parseGlossary($('glossary').value);
    await chrome.storage.local.set({glossary:$('glossary').value}); glossaryRules = rules;
    $('glossary-status').textContent = `已儲存 ${rules.length} 組，套用於下次網頁／字幕翻譯。舊網頁譯文請先還原；PDF 不套用。`;
  } catch(error) { $('glossary-status').textContent = error.message; }
};
$('workspace').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('workspace.html') });
$('detect').onclick = async () => {
  if (running) return;
  document.querySelector('[data-view=web]').click();
  const job = {id:crypto.randomUUID(),kind:'detect',controller:new AbortController(),translator:null,stage:'engine-create'};
  running = job; controls(true);
  status('正在辨識原文語言…', '僅使用可讀取的正文；可按停止取消。');
  try {
    if (!globalThis.LanguageDetector) throw new Error('此 Chrome 尚無語言辨識功能，請手動選擇原文語言。');
    // Start model preparation inside the click; observe rejection immediately.
    job.creation = Promise.resolve(LanguageDetector.create({signal:job.controller.signal})).then(translator=>({translator}),error=>({error}));
    const tab = await activeTab(); assertLive(job); job.tabId = tab.id;
    job.stage = 'page-read';
    job.target = await inject(tab); assertLive(job);
    // Reuse original-text extraction so hidden text, forms and inserted translations stay excluded.
    const batch = await send(job.target, {type:'qingread:summary-source',job:job.id,scope:'page'}); assertLive(job);
    if (!Array.isArray(batch?.items)) throw new DOMException('Invalid source','PageReadError');
    const sample = Array.from(batch.items.map(item=>item.text).join('\n')).slice(0,1500).join('');
    if (!sample.trim()) throw new Error('沒有讀到可辨識的正文，請手動選擇原文語言。');
    job.stage = 'engine-create';
    const created = await waitForEngine(job.creation,job); assertLive(job);
    if (created.error) throw created.error;
    job.translator = created.translator;
    const result = await waitForEngine(job.translator.detect(sample,{signal:job.controller.signal}),job); assertLive(job);
    const language = result[0]?.detectedLanguage;
    if (!Object.hasOwn(LANGUAGES, language)) throw new Error('辨識結果不在目前支援的語言中，請手動選擇。');
    $('source').value = language; $('source').dispatchEvent(new Event('change'));
    status('已辨識原文語言，按「開始翻譯」即可閱讀。');
  } catch (error) {
    if (running === job) {
      if (/^(Page|Extension)/.test(error.name)) showFailure(error,job);
      else status(error.name === 'Error' ? error.message : errorText(error));
    }
  } finally {
    job.controller.abort(); job.translator?.destroy();
    if (!job.translator) void job.creation?.then(result=>result.translator?.destroy());
    if (running === job) {running = null; controls(false);}
  }
};

// Navigation changes only the visible controls; it does not restart active jobs.
for (const button of document.querySelectorAll('[data-view]')) {
  button.addEventListener('click', () => {
    for (const item of document.querySelectorAll('[data-view]')) item.setAttribute('aria-pressed', String(item === button));
    for (const page of document.querySelectorAll('[data-page]')) page.hidden = page.dataset.page !== button.dataset.view;
    document.querySelector('.engine-card').hidden = button.dataset.view === 'summary';
  });
}

// Keep this call in the click handler: awaiting a tab lookup first loses user activation.
async function requestSiteAccess(target) {
  if (target && typeof chrome.permissions?.request === 'function') {
    const granted = await chrome.permissions.request({origins:[target.pattern]});
    if (!granted) return '尚未允許此網站。請再按授權按鈕，或點工具列的清讀圖示後重試。';
    const current = await activeTab();
    if (current.id !== target.tabId || !current.url || new URL(current.url).origin !== target.origin)
      throw new DOMException('Source changed', 'PageChangedError');
    await inject(current);
    return '網站授權完成，已確認可以載入讀取程式。請重新按功能的開始按鈕。Chrome 會記住此網站授權，可在外掛的網站存取權撤回。';
  }
  const tab = await activeTab();
  if (typeof chrome.permissions?.addHostAccessRequest !== 'function')
    return '請在工具列直接點清讀圖示，再按開始；不要只從側邊欄選單開啟。';
  await chrome.permissions.addHostAccessRequest({tabId:tab.id});
  return '已送出網站授權請求，尚未取得授權。請到 Chrome 工具列的擴充功能（拼圖）選單允許此網站，再重新開始。';
}

$('grant-site').onclick = async () => {
  const button = $('grant-site'); button.disabled = true;
  try {
    status(await requestSiteAccess(siteAccessTarget), '授權後可按開始翻譯。Chrome 會記住此網站授權，可在外掛的網站存取權撤回。');
  } catch (error) {
    if (error.name?.endsWith('Error') && error.name !== 'Error') showFailure(error,{stage:'page-read'});
    else status('Chrome 未完成網站授權。', '請到清讀詳細資料檢查網站存取權，或直接點工具列清讀圖示後重試。');
  } finally { button.disabled = false; }
};

chrome.tabs.onActivated.addListener(info => {if(Number.isInteger(siteAccessTarget?.windowId) && info.windowId !== siteAccessTarget.windowId)return;siteAccessTarget=null; $('grant-site').hidden=true;});
chrome.tabs.onUpdated.addListener((id,change) => {if(siteAccessTarget?.tabId===id && (change.status==='loading'||change.url)){siteAccessTarget=null; $('grant-site').hidden=true;}});
