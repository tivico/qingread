'use strict';
(() => {
  const el = id => document.getElementById(id);
  let epoch = 0;
  function reset() { epoch++; el('frames-list').replaceChildren(); el('frames-status').textContent = ''; }
  function show(frames,target) {
    reset(); const generation = epoch;
    el('frames-status').textContent = '以下為內嵌來源，可能包含影片。請選擇課文；僅開新分頁，不會自動開始翻譯。';
    for (const frame of frames.slice(0,10)) {
      let url;
      try { url = new URL(frame.url); if (!/^https?:$/.test(url.protocol) || url.username || url.password) continue; } catch { continue; }
      const button = document.createElement('button');
      button.style.cssText = 'display:block;width:100%;margin:8px 0;overflow-wrap:anywhere';
      button.textContent = `${String(frame.title || '內嵌頁面').slice(0,80)} · ${url.hostname} ↗`;
      button.onclick = async () => {
        button.disabled = true;
        try {
          const current = await activeTab();
          if (generation !== epoch || current.id !== target.tabId) throw new Error('changed');
          const fresh = await send(target,{type:'qingread:frames'});
          if (generation !== epoch || !fresh?.frames?.some(item => item.url === url.href)) throw new Error('changed');
          await chrome.tabs.create({url:url.href});
        } catch { el('frames-status').textContent = '頁面或內嵌來源已改變，請重新尋找課文。'; }
        finally { button.disabled = false; }
      };
      el('frames-list').append(button);
    }
    if (!el('frames-list').children.length) el('frames-status').textContent = '沒有可另開的網址；內嵌內容可能使用 srcdoc、特殊來源，或尚未載入。';
  }
  globalThis.QingReadFrames = {show};
  el('scan-frames').onclick = async () => {
    reset(); const generation = epoch;
    el('frames-status').textContent = '正在檢查可見內嵌頁面…';
    try {
      const tab = await activeTab(), target = await inject(tab);
      const result = await send(target,{type:'qingread:frames'});
      if (generation !== epoch) return;
      show(result?.frames || [],target);
    } catch (error) { if (generation === epoch) el('frames-status').textContent = QingReadCore.errorText(error); }
  };
  chrome.tabs.onActivated.addListener(reset);
  chrome.tabs.onUpdated.addListener((_id,change) => { if (change.status === 'loading') reset(); });
})();
