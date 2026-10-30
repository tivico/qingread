'use strict';
(() => {
  const el = id => document.getElementById(id);
  let task = null, sourceTabId = null, sourceWindowId = null, accessTarget = null;
  function revealResult() {
    const output = el('summary-output');
    if (!output.hidden && !output.closest('[data-page]').hidden && !document.hidden) {
      output.scrollIntoView({block:'start'});
    }
  }
  function stop(message = '已停止摘要。') {
    const old = task;
    const wasRunning=Boolean(task);
    clearInterval(task?.timer);
    task?.controller.abort(); task = null;
    el('summary-start').disabled = false; el('summary-stop').disabled = true;
    el('summary-status').textContent = message + (wasRunning && el('summary-result').textContent ? ' 下方是尚未完成的部分摘要。' : '');
    if(old?.request){
      const prior=el('summary-status').textContent,cancelling=prior+' 正在通知助手取消…';
      el('summary-status').textContent=cancelling;
      void Promise.allSettled([old.request]).then(results=>{if(!task && el('summary-status').textContent===cancelling)el('summary-status').textContent=prior+' '+QingReadLocal.cancellationText(results);});
    }
  }
  function clear() {
    accessTarget = null; el('summary-grant').hidden = true;
    stop('頁面已變更，請重新整理摘要。'); sourceTabId = null; sourceWindowId = null;
    el('summary-result').textContent = ''; el('summary-copy').disabled = true;
    el('summary-output').hidden = true;
  }
  el('summary-start').onclick = async () => {
    if (task) return;
    const job = {controller: new AbortController(), tabId: null}; task = job;
    accessTarget = null; el('summary-grant').hidden = true;
    el('summary-start').disabled = true; el('summary-stop').disabled = false;
    el('summary-copy').disabled = true; el('summary-result').textContent = '';
    el('summary-output').hidden = true;
    el('summary-status').textContent = '正在讀取本頁正文…';
    try {
      const tab = await activeTab();
      if (task !== job) return;
      job.tabId = tab.id; sourceTabId = tab.id; sourceWindowId = tab.windowId;
      const target = await inject(tab);
      if (task !== job) return;
      const batch = await send(target, {type:'qingread:summary-source', job:crypto.randomUUID(), scope:'page'});
      if (batch?.error === 'changed') throw new DOMException('Page changed during extraction','PageChangedError');
      if (!Array.isArray(batch?.items)) throw new Error('無法讀取正文，請重新整理網頁後重試。');
      if (batch.reason === 'embedded') throw new Error('課文在內嵌頁面中。請到網頁翻譯頁籤展開「課文沒有翻到？」，開啟課文來源後再摘要。');
      const source = batch.items.map(item => item.text).join('\n\n');
      if (!source.trim()) throw new Error('沒有讀到正文。請先展開要閱讀的內容再試。');
      const points = Array.from(source), partial = Boolean(batch.frames?.length) || batch.limited || points.length > 6000;
      const text = points.slice(0,6000).join('');
      const coverage = `${partial ? '部分內容：' : '本次擷取內容：'}${Math.min(points.length,6000)} 字元${partial ? (batch.frames?.length ? '（未包含內嵌頁面，未涵蓋全文）' : '（達到上限，未涵蓋全文）') : ''}`;
      if (task !== job) return;
      el('summary-status').textContent = coverage + '。本機模型讀取原文中，產生文字後會立即顯示…';
      const started = Date.now();
      job.timer = setInterval(() => {
        if (task === job) el('summary-status').textContent = coverage + `。${job.hasText ? '正在產生摘要，下方內容尚未完成' : job.stageMessage || '正在等候助手回報處理階段'}，已等候 ${Math.floor((Date.now()-started)/1000)} 秒。`;
      },1000);
      job.request = QingReadLocal.request('/summarize', {body:{text},signal:job.controller.signal,managed:true,onProgress:event=>{
        if(task===job)job.stageMessage=QingReadLocal.stageText(event);
        if(task!==job || typeof event.text!=='string' || !event.text.trim())return;
        el('summary-result').textContent=event.text;
        el('summary-output').hidden=false;
        if(!job.hasText)revealResult();
        job.hasText=true;
      }});
      const result = await job.request;
      if (task !== job) return;
      // currentWindow can change when another Chrome window gains focus.
      const current = Number.isInteger(tab.windowId)
        ? (await chrome.tabs.query({active:true,windowId:tab.windowId}))[0] : await activeTab();
      if (task !== job) return;
      if (current?.id !== tab.id) {
        clear(); el('summary-status').textContent = '來源分頁已變更，這次摘要未顯示。請在要閱讀的分頁重新整理摘要。';
        return;
      }
      if (typeof result?.text !== 'string' || !result.text.trim()) throw new Error('模型沒有回傳摘要。');
      el('summary-result').textContent = result.text;
      el('summary-output').hidden = false;
      el('summary-copy').disabled = false;
      el('summary-status').textContent = (result.truncated ? '已達輸出上限，下方是部分摘要。' : result.cached ? '摘要已完成，沿用相同內容與模型的近期結果。' : '摘要已完成，請看「本頁摘要」。') + coverage + '。摘要可能有遺漏或誤解，請對照原文。';
      revealResult();
    } catch (error) {
      if (task === job) {
        el('summary-status').textContent = ['TimeoutError','PageAccessError','PageReadError','PageRestrictedError','PageMissingError','PageChangedError','ExtensionLoadError','PageInjectionError'].includes(error.name) ? QingReadCore.errorText(error) : (error.name === 'AbortError' ? '已停止摘要。' : error.message === '找不到此功能。' ? '請重新啟動新版本機助手，再整理摘要。' : error.message);
        if(job.hasText)el('summary-status').textContent+=' 下方僅為已收到的部分摘要，尚未完成。';
        if (error.name === 'PageAccessError') {
          accessTarget = error.accessTarget;
          el('summary-grant').textContent = accessTarget ? '允許 ' + new URL(accessTarget.origin).hostname : '允許此網站';
          el('summary-grant').hidden = false;
          el('summary-status').textContent += ' 請按下方授權按鈕，確認後重新整理摘要。';
        }
      }
    } finally {
      clearInterval(job.timer);
      if (task === job) { task = null; el('summary-start').disabled = false; el('summary-stop').disabled = true; }
    }
  };
  el('summary-stop').onclick = () => stop();
  el('summary-grant').onclick = async () => {
    const target = accessTarget, source = sourceTabId;
    el('summary-grant').disabled = true;
    try {
      const message = await requestSiteAccess(target);
      if (source === sourceTabId && target === accessTarget) el('summary-status').textContent = message;
    } catch (error) {
      if (source === sourceTabId && target === accessTarget) el('summary-status').textContent = error.name === 'PageChangedError' ? QingReadCore.errorText(error) : 'Chrome 未完成網站授權。請點工具列清讀圖示後重試。';
    } finally { el('summary-grant').disabled = false; }
  };
  el('summary-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(el('summary-status').textContent + '\n\n' + el('summary-result').textContent); }
    catch { el('summary-status').textContent = '複製未成功，可直接反白摘要文字複製。'; }
  };
  chrome.tabs.onActivated.addListener(info => {
    if (Number.isInteger(sourceWindowId) && Number.isInteger(info.windowId) && info.windowId !== sourceWindowId) return;
    if (info.tabId !== sourceTabId) clear();
  });
  chrome.tabs.onUpdated.addListener((id, change) => { if (change.status === 'loading' && id === sourceTabId) clear(); });
  window.addEventListener('pagehide', () => stop());
  // Temporary hiding does not invalidate captured text. Page/tab changes and explicit stop still cancel.
  document.addEventListener('visibilitychange', revealResult);
  document.querySelector('[data-view="summary"]').addEventListener('click', revealResult);
})();
