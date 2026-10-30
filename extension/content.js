(() => {
  if (globalThis.__qingReadInstalled) return;
  globalThis.__qingReadInstalled = true;
  const BLOCKS = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,td,th,dd,dt,figcaption,div,article,section';
  const EXCLUDE = 'script,style,noscript,template,pre,code,kbd,samp,textarea,input,select,button,form,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[hidden],[inert],[aria-hidden="true"],[data-qingread]';
  const PAGE_CHROME = 'header,[role="banner"],[role="menu"],[role="menubar"],nav,aside,[role="navigation"],[role="complementary"],footer';
  const WIKI_CHROME = '.infobox,.navbox,.sidebar,.metadata,.ambox,.reflist,.mw-references-wrap,.reference,.mw-editsection,.toc,.catlinks,.noprint';
  const isWikipedia = /(^|\.)wikipedia\.org$/.test(location.hostname);
  const records = new Map();
  const rendered = new Map();
  let currentJob = null;
  let layoutStyle = null;
  const normalize = text => text.replace(/\s+/gu, ' ').trim();
  function distance(element) {
    const rect = element.getBoundingClientRect();
    if (rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth) return 0;
    return 1 + Math.max(0, rect.top - innerHeight, -rect.bottom, rect.left - innerWidth, -rect.right);
  }
  function allowed(node) {
    const element = node.parentElement;
    if (!element || element.closest(EXCLUDE)) return false;
    for (let parent = element; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
      const rect = parent.getBoundingClientRect();
      if ((['hidden','clip'].includes(style.overflowY) && rect.height <= 0) || (['hidden','clip'].includes(style.overflowX) && rect.width <= 0)) return false;
    }
    return element.getClientRects().length > 0;
  }
  function textOf(record) {
    if (!record.element.isConnected || record.nodes.some(n => !n.isConnected || !record.element.contains(n) || !allowed(n))) return null;
    return normalize(record.nodes.map(n => n.textContent).join(''));
  }
  function removeTranslations() {
    for (const item of rendered.values()) item.host.remove();
    rendered.clear(); records.clear(); currentJob = null;
    layoutStyle?.remove(); layoutStyle = null;
  }
  function readableRoot(root) {
    if (!root || root.closest(EXCLUDE + ',' + PAGE_CHROME)) return false;
    const rect = root.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node, visited = 0;
    while ((node = walker.nextNode()) && ++visited <= 25000) {
      if (/\p{L}/u.test(node.textContent) && allowed(node) && !node.parentElement.closest(PAGE_CHROME)) return true;
    }
    return false;
  }
  function readingRoot(scope) {
    if (scope === 'selection') return document.body;
    const google = ['www.google.com','www.google.com.tw'].includes(location.hostname) && location.pathname === '/search' ? document.getElementById('rso') : null;
    const wiki = isWikipedia ? document.querySelector('#mw-content-text .mw-parser-output') : null;
    const course = /(^|\.)skilljar\.com$/.test(location.hostname) ? document.getElementById('skilljar-content') : null;
    for (const candidate of [google, wiki, course]) if (readableRoot(candidate)) return candidate;
    // Selector lists use DOM order, not priority. Inspect main landmarks first,
    // and reject collapsed FAQ articles before choosing any semantic container.
    const mains = [...document.querySelectorAll('main,[role="main"]')].filter(readableRoot);
    if (mains.length === 1) return mains[0];
    if (mains.length > 1) return document.body;
    const articles = [...document.querySelectorAll('article')].filter(readableRoot);
    return articles.length === 1 ? articles[0] : document.body;
  }
  function embeddedPages() {
    return [...document.querySelectorAll('iframe')].filter(frame => {
      const rect = frame.getBoundingClientRect();
      return rect.width >= 300 && rect.height >= 150 && allowed({parentElement:frame});
    }).slice(0,10).map(frame => {
      let url = null;
      try { const parsed = new URL(frame.getAttribute('src'),location.href); if (!frame.hasAttribute('srcdoc') && frame.getAttribute('src') && /^https?:$/.test(parsed.protocol) && !parsed.username && !parsed.password) url = parsed.href; } catch {}
      return {url, title:(frame.title || '內嵌頁面').slice(0,80)};
    });
  }
  function collect(message) {
    const primaryRoot = readingRoot(message.scope);
    // FAQs are supplementary reading content, not a replacement for the course.
    const faqRoots = message.scope !== 'selection' && /(^|\.)skilljar\.com$/.test(location.hostname)
      ? [...document.querySelectorAll('#sj-custom-footer .faq-container')] : [];
    const root = faqRoots.length ? document.body : primaryRoot;
    if (!root) return { items: [], limited: false };
    const frames = message.scope === 'selection' ? [] : embeddedPages();
    const courseShell = location.hostname === 'learn.nvidia.com' && /^\/courses\/course\/?$/.test(location.pathname) && frames.length > 0 && message.scope !== 'selection';
    const summary = message.type === 'qingread:summary-source';
    if (!summary) { records.clear(); currentJob = message.job; }
    for (const [element, item] of rendered) {
      if (!element.isConnected || !item.host.isConnected || textOf(item.record) !== item.record.text) {
        item.host.remove(); rendered.delete(element);
      }
    }
    if (courseShell) return {items:[],frames,reason:'embedded',limited:false};
    const selection = message.scope === 'selection' ? window.getSelection() : null;
    if (message.scope === 'selection' && (!selection || selection.isCollapsed || !selection.rangeCount)) {
      return { items: [], reason: 'selection' };
    }
    // Selection is a snapshot; never send adjacent unselected text to the engine.
    const range = selection?.getRangeAt(0);
    const groups = new Map();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let visited = 0;
    let node;
    while ((node = walker.nextNode())) {
      if (++visited > 25000) break;
      // Whitespace-only nodes can separate two inline spans ("Hello" + " " + "world").
      if (!node.textContent || !allowed(node)) continue;
      if (faqRoots.length && !primaryRoot?.contains(node) && !faqRoots.some(faq => faq.contains(node))) continue;
      if (!range && (node.parentElement.closest(PAGE_CHROME) || (isWikipedia && node.parentElement.closest(WIKI_CHROME)))) continue;
      if (range && !range.intersectsNode(node)) continue;
      let text = node.textContent;
      if (range) {
        const start = node === range.startContainer ? range.startOffset : 0;
        const end = node === range.endContainer ? range.endOffset : text.length;
        text = text.slice(start, end);
      }
      const element = node.parentElement.closest(BLOCKS) || node.parentElement;
      if (!groups.has(element)) groups.set(element, { element, nodes: [], parts: [] });
      const group = groups.get(element);
      group.nodes.push(node); group.parts.push(text);
    }
    const items = [];
    let characters = 0, alreadyTranslated = 0;
    let limited = visited > 25000;
    const ordered = [...groups.values()];
    if (!range && !summary) ordered.sort((a,b) => distance(a.element)-distance(b.element));
    for (const group of ordered) {
      const text = normalize(group.parts.join(''));
      if (text.length < 2 || !/\p{L}/u.test(text)) continue;
      // Short link-only blocks are usually navigation, not article prose.
      if (!range && text.length < 160 && group.nodes.filter(n => normalize(n.textContent)).every(n => n.parentElement.closest('a'))) continue;
      if (!summary && rendered.has(group.element)) { alreadyTranslated++; continue; }
      if (items.length >= 200 || characters + text.length > 60000) { limited = true; continue; }
      const id = crypto.randomUUID();
      // Full node text is used solely for detecting page edits during translation.
      const record = { element: group.element, nodes: group.nodes, text: normalize(group.nodes.map(n => n.textContent).join('')) };
      if (!summary) records.set(id, record);
      items.push({ id, text }); characters += text.length;
    }
    return { items, frames, characters, limited, alreadyTranslated, reason: !items.length && alreadyTranslated ? 'translated' : undefined };
  }
  function apply(message) {
    if (message.job !== currentJob) return { applied: false };
    const record = records.get(message.id);
    if (!record || typeof message.text !== 'string' || message.text.length > 100000) return { applied: false };
    records.delete(message.id);
    if (textOf(record) !== record.text || rendered.has(record.element)) return { applied: false };
    const host = document.createElement('div');
    host.dataset.qingread = 'translation';
    if (/(^|\.)skilljar\.com$/.test(location.hostname) && record.element.closest('.dp-curriculum .lesson-modular') && !layoutStyle) {
      layoutStyle = document.createElement('style');
      layoutStyle.textContent = '.dp-curriculum .lesson-modular:has([data-qingread="translation"]){height:auto!important;min-height:44px;max-height:none!important;align-items:center!important}.dp-curriculum .lesson-modular:has([data-qingread="translation"]) .lesson-wrapper{min-width:0;flex:1;height:auto!important;max-height:none!important}';
      document.head.append(layoutStyle);
    }
    host.lang = 'zh-Hant';
    host.style.cssText = 'display:block!important;clear:none!important;margin:4px 0 12px!important;max-width:100%;';
    host.setAttribute('aria-label', '繁體中文譯文');
    const originalStyle = getComputedStyle(record.element);
    host.style.color = originalStyle.color;
    host.style.fontSize = originalStyle.fontSize;
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = ':host{color:inherit}div{font-family:system-ui,"Microsoft JhengHei",sans-serif;font-size:inherit;font-weight:400;line-height:1.75;color:inherit;border-inline-start:2px solid #aa8bf1;padding:0 0 0 10px;white-space:pre-wrap;overflow-wrap:anywhere;text-align:start}';
    const box = document.createElement('div');
    const text = document.createElement('span'); text.textContent = message.text;
    box.append(text); shadow.append(style, box);
    // Keep table/list structure valid; otherwise place the translation beside its block.
    if (record.element.matches('li,td,th,dd,dt,blockquote,article,section,.faq-title')) record.element.append(host);
    else record.element.after(host);
    rendered.set(record.element, { host, record });
    return { applied: true };
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('panel.html'))) return;
    try {
      if (['qingread:collect','qingread:summary-source'].includes(message?.type) && typeof message.job === 'string') respond(collect(message));
      else if (message?.type === 'qingread:frames') respond({frames:embeddedPages()});
      else if (message?.type === 'qingread:prioritize' && message.job === currentJob) respond({ ids: [...records].sort((a,b) => distance(a[1].element)-distance(b[1].element)).map(([id]) => id) });
      else if (message?.type === 'qingread:apply') respond(apply(message));
      else if (message?.type === 'qingread:restore') { removeTranslations(); respond({ restored: true }); }
      else if (message?.type === 'qingread:cancel') { if (currentJob === message.job) { currentJob = null; records.clear(); } respond({ stopped: true }); }
    } catch { respond({ error: 'page' }); }
  });
})();
