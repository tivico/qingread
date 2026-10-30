(() => {
  if (globalThis.__qingReadMedia) return;
  globalThis.__qingReadMedia = true;
  let session = null, video = null, box = null, textNode = null, originalNode = null, lastCue = '', cueVersion = 0, mode = 'captions', timelineVersion = 0, videoEvents;
  const MIN_HOLD = 2000, GAP_HOLD = 1200, MAX_STALE = 6000, SPEECH_HOLD = 8000;
  let displayed = null, pending = null, emptySince = null, bilingual = false, sizeObserver;
  const cueHistory = new Map();
  let sourceStyle = null, mutedSource = null;
  const normalize = text => text.replace(/\s+/gu, ' ').trim().slice(0,6000);
  let hoverEnabled = false, hoverTimer, word = '', wordVersion = 0, point = {x:0,y:0}, tooltip;
  function clearWord() {
    clearTimeout(hoverTimer); word = ''; wordVersion++; tooltip?.remove();
  }
  function restoreSource() {
    sourceStyle?.remove(); sourceStyle = null;
    mutedSource?.removeAttribute('data-qingread-source-muted'); mutedSource = null;
  }
  function muteSource() {
    if (mode !== 'captions' || !video?.closest('#movie_player')) return;
    const source = video.closest('#movie_player').querySelector('.ytp-caption-window-container');
    if (!source || source === mutedSource) return;
    restoreSource(); mutedSource = source;
    source.setAttribute('data-qingread-source-muted','');
    sourceStyle = document.createElement('style');
    // Keep YouTube's original cues in the DOM for reading, without a second moving caption.
    sourceStyle.textContent = '[data-qingread-source-muted]{opacity:0!important}';
    document.documentElement.append(sourceStyle);
  }
  function remove() {
    box?.remove(); box = null; displayed = pending = null;
    restoreSource();
  }
  function visibleVideo() {
    return [...document.querySelectorAll('video')].filter(v => v.getBoundingClientRect().width > 60).sort((a,b) => Number(b === document.pictureInPictureElement) - Number(a === document.pictureInPictureElement) || b.clientWidth*b.clientHeight - a.clientWidth*a.clientHeight)[0];
  }
  function cue() {
    if (!video?.isConnected || video.ended || video.seeking) return '';
    const youtube = video.closest('#movie_player')?.querySelector('.ytp-caption-window-container');
    if (youtube && video.closest('#movie_player')) return normalize([...youtube.querySelectorAll('.ytp-caption-segment')].map(n=>n.textContent).join(' '));
    const tracks = [...video.textTracks].filter(t => t.mode === 'showing');
    return normalize(tracks.flatMap(t => [...(t.activeCues || [])].map(c => c.text)).join(' '));
  }
  function readCue() {
    const current = cue();
    if (current !== lastCue) {
      lastCue = current; cueVersion++;
      emptySince = current ? null : performance.now();
      cueHistory.set(cueVersion, {text:current, at:performance.now()});
      if (cueHistory.size > 32) cueHistory.delete(cueHistory.keys().next().value);
    }
    return { text: current, version: cueVersion, timelineVersion, time: video?.currentTime || 0, paused: video?.paused ?? true,
      display: { visible:Boolean(box?.isConnected), current:Boolean(displayed && matchesCurrent(displayed)), pending:Boolean(pending) } };
  }
  function matchesCurrent(message) {
    if (mode === 'speech') return message.timelineVersion === timelineVersion && !video?.paused;
    if (message.timelineVersion !== undefined && message.timelineVersion !== timelineVersion) return false;
    const source = normalize(message.original);
    if (!lastCue) return false;
    if (message.version === cueVersion && source === lastCue) return true;
    const seen = cueHistory.get(message.version);
    if (message.timelineVersion !== timelineVersion || seen?.text !== source || performance.now()-seen.at > 3000) return false;
    if (lastCue === source || lastCue.startsWith(source + ' ')) return true;
    // YouTube rolls the first line out while extending the second. A recent
    // suffix of at least three words can still be part of the current caption.
    const words = source.split(' ');
    for (let start = 1; start <= words.length-3; start++) {
      const suffix = words.slice(start).join(' ');
      if (lastCue === suffix || lastCue.startsWith(suffix + ' ')) return true;
    }
    return false;
  }
  function position() {
    if (!box || !video?.isConnected) return;
    const parent = document.fullscreenElement || document.documentElement;
    // A fullscreen <video> cannot render HTML children; custom-player containers can.
    if (parent.tagName !== 'VIDEO' && box.parentNode !== parent) parent.append(box);
    const rect = video.getBoundingClientRect();
    const width = Math.max(80, Math.min(960, rect.width * .88, innerWidth - 16));
    Object.assign(box.style, {
      left:Math.max(8,Math.min(rect.left+(rect.width-width)/2,innerWidth-width-8))+'px',
      bottom:Math.max(8,innerHeight-rect.bottom+Math.min(64,rect.height*.15))+'px',
      width:width+'px', '--caption-max-height':Math.max(90,Math.min(320,rect.height*.48))+'px'
    });
  }
  function show(original, translated) {
    if (!video?.isConnected) return;
    if (!box) {
      box = document.createElement('div'); box.dataset.qingreadMedia = 'true';
      const shadow = box.attachShadow({mode:'closed'}), style = document.createElement('style');
      style.textContent = ':host{position:fixed!important;z-index:2147483646!important;pointer-events:none!important;display:block!important;color-scheme:dark}section{box-sizing:border-box;background:rgba(15,24,22,.92);color:white;border-radius:10px;padding:10px 18px;text-align:center;font:600 clamp(16px,2.2vw,21px)/1.55 system-ui;box-shadow:0 3px 15px #0005;max-height:var(--caption-max-height,240px);overflow:auto;pointer-events:auto;scrollbar-width:thin}small{display:block;font:14px/1.5 system-ui;color:#d5dedb;margin-bottom:5px}small[hidden]{display:none}p{margin:0;min-height:3.1em;display:flex;align-items:center;justify-content:center;white-space:pre-wrap;overflow-wrap:anywhere}';
      const wrapper = document.createElement('section'); originalNode = document.createElement('small'); textNode = document.createElement('p'); wrapper.append(originalNode,textNode); shadow.append(style,wrapper);
      document.documentElement.append(box);
    }
    position();
    originalNode.hidden = !bilingual;
    if (originalNode.textContent !== original) originalNode.textContent = original;
    if (textNode.textContent !== translated) textNode.textContent = translated;
    muteSource();
  }
  function refreshDisplay() {
    if (!session) return;
    if (!video?.isConnected) { remove(); return; }
    const now = performance.now();
    if (mode === 'captions') readCue();
    if (pending && !matchesCurrent(pending)) pending = null;
    if (pending && (!displayed || now - displayed.shownAt >= MIN_HOLD)) {
      displayed = {...pending, shownAt:now}; pending = null;
      show(displayed.original, displayed.text);
    }
    if (!displayed) return;
    const age = now - displayed.shownAt;
    if (mode === 'speech') { if (age >= SPEECH_HOLD) remove(); return; }
    // Pausing is a reading action: keep the caption until resume, seek, or stop.
    if (video.paused) return;
    if ((emptySince !== null && now-emptySince >= GAP_HOLD && age >= MIN_HOLD) ||
        (!matchesCurrent(displayed) && age >= MAX_STALE)) remove();
    else muteSource();
  }
  function invalidateTimeline() {
    timelineVersion++; cueVersion++; cueHistory.clear(); lastCue = ''; emptySince = null; remove();
  }
  document.addEventListener('fullscreenchange', position);
  window.addEventListener('resize', position, {passive:true});
  document.addEventListener('scroll', position, {passive:true,capture:true});
  setInterval(refreshDisplay, 100);
  document.addEventListener('pointermove', event => {
    // Invalidate immediately: a response for the previous pointer position is stale.
    clearWord();
    if (!hoverEnabled || !event.altKey || event.target.closest('input,textarea,select,[contenteditable],form')) return;
    const {clientX:x, clientY:y} = event; point = {x,y};
    hoverTimer = setTimeout(() => {
      if (!hoverEnabled) return;
      const caret = document.caretRangeFromPoint(x,y), node = caret?.startContainer;
      if (!node || node.nodeType !== Node.TEXT_NODE || node.parentElement?.closest('input,textarea,form,[contenteditable]')) return;
      const text = node.textContent, offset = caret.startOffset;
      const start = text.slice(0,offset).match(/[A-Za-z'-]*$/)?.[0] || '';
      const end = text.slice(offset).match(/^[A-Za-z'-]*/)?.[0] || '';
      const next = start + end;
      if (next.length > 1 && next.length < 60 && next !== word) { word = next; wordVersion++; tooltip?.remove(); }
    }, 500);
  }, {passive:true});
  document.addEventListener('keyup', event => { if (event.key === 'Alt') clearWord(); });
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('panel.html')) return;
    if (message.type === 'qingread:media-start') {
      remove(); sizeObserver?.disconnect(); video = visibleVideo(); session = message.session; mode = message.mode;
      bilingual = message.bilingual === true; cueHistory.clear(); lastCue = ''; emptySince = null; cueVersion++;
      videoEvents?.abort(); videoEvents = new AbortController(); timelineVersion++;
      if (video) {
        for (const event of ['seeking','emptied','ended','loadstart']) video.addEventListener(event, invalidateTimeline, {signal:videoEvents.signal});
        video.addEventListener('pause', () => { if (mode === 'speech') invalidateTimeline(); }, {signal:videoEvents.signal});
        sizeObserver = new ResizeObserver(position); sizeObserver.observe(video);
      }
      reply({ ok: Boolean(video), error: video ? null : '找不到目前頁面的影片。跨網站內嵌影片可能不支援。' });
    } else if (message.type === 'qingread:media-stop' && message.session === session) { session = null; videoEvents?.abort(); sizeObserver?.disconnect(); remove(); reply({ok:true}); }
    else if (message.type === 'qingread:media-read' && message.session === session) reply(readCue());
    else if (message.type === 'qingread:media-show' && message.session === session) {
      if (mode === 'captions') readCue();
      const valid = typeof message.original === 'string' && typeof message.text === 'string' &&
        Boolean(message.text.trim()) && message.text.length <= 12000 && matchesCurrent(message);
      if (valid && !(displayed?.original === message.original && displayed?.text === message.text && matchesCurrent(displayed))) {
        pending = {original:normalize(message.original),text:message.text,version:message.version,timelineVersion:message.timelineVersion};
        refreshDisplay();
      }
      reply({ok:true,applied:valid});
    } else if (message.type === 'qingread:hover-enable') { hoverEnabled = Boolean(message.enabled); clearWord(); reply({ok:true}); }
    else if (message.type === 'qingread:hover-read') reply({word,version:wordVersion});
    else if (message.type === 'qingread:hover-show') {
      if (hoverEnabled && word && message.version === wordVersion && typeof message.text === 'string') {
        tooltip?.remove(); tooltip = document.createElement('div');
        Object.assign(tooltip.style,{position:'fixed',left:Math.min(point.x+12,Math.max(8,innerWidth-340))+'px',top:Math.min(point.y+20,Math.max(8,innerHeight-240))+'px',zIndex:'2147483647',width:'310px',pointerEvents:'none'});
        const shadow = tooltip.attachShadow({mode:'closed'}), content = document.createElement('div');
        content.style.cssText = 'font:15px/1.6 system-ui;background:#fff;color:#17392f;padding:16px;border:1px solid #b8cdc0;border-radius:12px;box-shadow:0 4px 22px #0003;white-space:pre-wrap;max-height:200px;overflow:hidden';
        content.textContent = message.text.slice(0,1500); shadow.append(content); document.documentElement.append(tooltip);
      } reply({ok:true});
    }
  });
})();
