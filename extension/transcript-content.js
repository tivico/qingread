// Open YouTube's own transcript UI, then read timed text. No private API or downloads.
(() => {
  if (globalThis.__qingReadTranscript) return;
  globalThis.__qingReadTranscript = true;
  let preparation = null;
  const visible = node => node && !node.closest('[hidden], [aria-hidden="true"]') &&
    getComputedStyle(node).visibility !== 'hidden' && node.getClientRects().length > 0;
  const rowSelector = 'ytd-transcript-segment-renderer, transcript-segment-view-model';
  function transcriptRoots() {
    const roots = new Set([...document.querySelectorAll('ytd-transcript-renderer')].filter(visible));
    for (const row of document.querySelectorAll('transcript-segment-view-model')) {
      if (!visible(row)) continue;
      const root = row.closest('ytd-engagement-panel-section-list-renderer');
      if (root && visible(root)) roots.add(root);
    }
    return [...roots];
  }
  function pending(message) { return {pending:true, message}; }
  function prepare(state) {
    // Each action runs once per user request; polling cannot keep toggling the panel.
    const openers = [...document.querySelectorAll('ytd-watch-metadata ytd-video-description-transcript-section-renderer button')];
    const opener = openers.find(visible);
    if (opener && !state.actions.has('open')) {
      state.actions.add('open'); opener.click();
      return pending('已找到逐字稿入口，正在等待 YouTube 載入字幕…');
    }
    const expand = document.querySelector('ytd-watch-metadata #description-inline-expander #expand');
    if (!state.actions.has('open') && visible(expand) && !state.actions.has('expand')) {
      state.actions.add('expand'); expand.click();
      return pending('正在展開影片說明，尋找逐字稿…');
    }
    const tab = [...document.querySelectorAll('ytd-engagement-panel-section-list-renderer [role="tab"]')]
      .find(node => visible(node) && node.getAttribute('aria-selected') !== 'true' &&
        /^(字幕記錄|字幕记录|轉錄稿|转录稿|逐字稿|transcript)$/i.test((node.getAttribute('aria-label') || node.textContent).trim()));
    if (state.actions.has('open') && tab && !state.actions.has('tab')) {
      state.actions.add('tab'); tab.click();
      return pending('正在切換到字幕記錄，等待文字載入…');
    }
    return pending(state.actions.has('open') ? 'YouTube 正在載入逐字稿，請稍候…' : '正在尋找這支影片的逐字稿入口…');
  }
  function read(message) {
    const url = new URL(location.href), id = url.searchParams.get('v');
    if (url.hostname !== 'www.youtube.com' || url.pathname !== '/watch' || !/^[\w-]{11}$/.test(id || ''))
      return {error:'目前支援電腦版 YouTube 影片頁，請開啟 www.youtube.com/watch 的影片。'};
    const watch = document.querySelector('ytd-watch-flexy[video-id]');
    if (watch && watch.getAttribute('video-id') !== id) return {error:'影片正在切換，請等載入完成再試。'};
    const auto = message.prepare === true;
    if (auto && (typeof message.job !== 'string' || !/^[\w-]{1,80}$/.test(message.job))) return {error:'字幕讀取工作識別不正確，請重新開始。'};
    if (auto && preparation?.job === message.job && preparation.videoId !== id) return {error:'擷取期間影片已變更，請重新開始。'};
    if (auto && preparation?.job !== message.job) preparation = {job:message.job,videoId:id,actions:new Set(),signature:null,stableSince:0};
    const panels = transcriptRoots();
    if (panels.length > 1) return {error:'偵測到多份字幕記錄，請關閉多餘的逐字稿後重試。'};
    if (!panels.length) {
      if (auto) return prepare(preparation);
      const loading = document.querySelector('ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"] tp-yt-paper-spinner[active]');
      return {error:loading ? 'YouTube 逐字稿仍在載入，請稍後重試。' : '尚未讀到逐字稿。請按「整理目前影片重點」，清讀會自動尋找並展開。'};
    }
    const panel = panels[0];
    if ([...panel.querySelectorAll('input')].some(input => input.value.trim()))
      return {error:'逐字稿目前有搜尋條件，請清空後再按整理，避免只摘要搜尋結果。'};
    const rows = [...panel.querySelectorAll(rowSelector)].filter(visible);
    if (!rows.length) return auto ? pending('已展開逐字稿，正在等待字幕文字…') : {error:'尚未讀到逐字稿段落，請等待字幕載入後重試。'};
    if (rows.length > 12000) return {error:'逐字稿超過本版的 12,000 段上限，請改用較短影片。未送出部分原文。'};
    const segments = []; let chars = 0, skipped = 0;
    for (const row of rows) {
      const modern = row.matches('transcript-segment-view-model');
      const stamp = row.querySelector(modern ? '.ytwTranscriptSegmentViewModelTimestamp, .ytTranscriptSegmentViewModelTimestamp' : '.segment-timestamp')?.textContent.trim() || '';
      const text = (row.querySelector(modern ? 'span[role="text"]' : '.segment-text')?.textContent || '').replace(/\s+/gu, ' ').trim();
      if (!/^\d{1,3}:\d{2}(?::\d{2})?$/.test(stamp) || !text) { skipped++; continue; }
      const parts = stamp.split(':').map(Number);
      if (parts.slice(1).some(n => n >= 60)) { skipped++; continue; }
      const start = parts.reduce((total, n) => total * 60 + n, 0);
      if (segments.length && start < segments.at(-1).start) return {error:'逐字稿時間順序異常，請重新整理影片後重試。'};
      chars += Array.from(text).length;
      if (chars > 240000) return {error:'逐字稿超過本版的 240,000 字元上限，請改用較短影片。未送出部分原文。'};
      segments.push({start, text});
    }
    if (!segments.length) return {error:'讀不到帶時間的字幕文字。請重新整理影片後再試；若仍失敗，可能是尚未支援的 YouTube 版型。'};
    if (auto) {
      // A loaded panel can still be adding rows. Wait for one stable snapshot.
      const signature = JSON.stringify(segments);
      if (signature !== preparation.signature) { preparation.signature=signature; preparation.stableSince=Date.now(); }
      if (Date.now()-preparation.stableSince < 600) return pending('已找到 '+segments.length+' 段字幕，正在確認載入完成…');
    }
    const video = document.querySelector('#movie_player video');
    const duration = Number.isFinite(video?.duration) ? video.duration : null;
    if (duration !== null && segments.at(-1).start > duration + 2) return {error:'逐字稿時間與影片長度不符，請重新整理後再試。'};
    return {videoId:id, url:'https://www.youtube.com/watch?v='+id,
      title:(document.querySelector('ytd-watch-metadata h1')?.textContent || document.title).trim().slice(0,200),
      segments, skipped, duration};
  }
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('panel.html') || message?.type !== 'qingread:video-transcript') return;
    try { reply(read(message)); } catch { reply({error:'無法讀取逐字稿，請重新整理影片後再試。'}); }
  });
})();
