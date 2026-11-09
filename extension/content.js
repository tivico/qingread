(() => {
  if (globalThis.__qingReadInstalled) return;
  globalThis.__qingReadInstalled = true;
  const BLOCKS = 'p,[data-as="p"],h1,h2,h3,h4,h5,h6,li,blockquote,td,th,dd,dt,figcaption,div,article,section';
  const INLINE_CODE = 'code,kbd,samp';
  const DOC_BODY = '.mdx-content[data-page-title][data-page-href]';
  const DOC_TITLE = 'header[data-layout-item="page-header"] h1';
  const REPLACED = 'data-qingread-original';
  const STRUCTURAL = 'li,td,th,dd,dt';
  const PROTECTED_CONTENT = 'form,button,input,select,textarea,details,summary,[role="button"],[role="tab"],[contenteditable],pre,iframe,img,picture,video,audio,canvas,math,svg:not([aria-hidden="true"])';
  const EXCLUDE = 'script,style,noscript,template,pre,textarea,input,select,button,[role="tablist"],[role="tab"],[contenteditable]:not([contenteditable="false"]),[role="textbox"],[hidden],[inert],[aria-hidden="true"],[data-qingread]';
  const FORM_UI = 'label,fieldset,[role="form"],[role="search"]';
  const PAGE_CHROME = 'header,[role="banner"],[role="menu"],[role="menubar"],nav,aside,[role="navigation"],[role="complementary"],footer';
  const WIKI_CHROME = '.infobox,.navbox,.sidebar,.metadata,.ambox,.reflist,.mw-references-wrap,.reference,.mw-editsection,.toc,.catlinks,.noprint';
  const isWikipedia = /(^|\.)wikipedia\.org$/.test(location.hostname);
  const records = new Map();
  const rendered = new Map();
  const renderedSelection = new Map();
  let currentJob = null, currentJobUrl = null;
  let selectionJob = null;
  let layoutStyle = null;
  let displaySheet = null;
  let translationOnly = false;
  let collectionEpoch = 0, summaryEpoch = 0;
  const normalize = text => text.replace(/\s+/gu, ' ').trim();
  function pageFormArticle() {
    // This public ASP.NET article template puts the entire page in one form.
    // Allow only its verified reading region, never arbitrary form contents.
    if (!['www.moea.gov.tw','moea.gov.tw'].includes(location.hostname) ||
        !/^\/MNS\/doit\/industrytech\/IndustryTech\.aspx$/i.test(location.pathname)) return null;
    const root=document.getElementById('divContent'), form=root?.closest('form');
    if (!form || form.id!=='form1' || form.parentElement!==document.body ||
        !form.querySelector('input[type="hidden"][name="__VIEWSTATE"]') ||
        !root.querySelector('#holderContent_lblTitle') || !root.querySelector('#holderContent_lblIntro')) return null;
    return {root,form};
  }
  const readContext = () => ({ancestors:new WeakMap(),excluded:new WeakMap(),clientRects:new WeakMap(),rects:new WeakMap(),article:pageFormArticle()});
  function excluded(element, context) {
    if (!context.excluded.has(element)) {
      const form=element.closest('form');
      const blockedForm=form && !(form===context.article?.form && context.article.root.contains(element));
      context.excluded.set(element,Boolean(element.closest(EXCLUDE) || blockedForm || (form && element.closest(FORM_UI))));
    }
    return context.excluded.get(element);
  }
  function rectOf(element, context) {
    if (!context.rects.has(element)) context.rects.set(element,element.getBoundingClientRect());
    return context.rects.get(element);
  }
  function distance(element, context = readContext()) {
    const rect = rectOf(element,context);
    if (rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth) return 0;
    return 1 + Math.max(0, rect.top - innerHeight, -rect.bottom, rect.left - innerWidth, -rect.right);
  }
  function allowed(node, context = readContext()) {
    const element = node.parentElement;
    if (!element) return false;
    if (excluded(element,context)) return false;
    const trail = [];
    let visible = true;
    for (let parent = element; parent; parent = parent.parentElement) {
      if (context.ancestors.has(parent)) {visible=context.ancestors.get(parent);break;}
      trail.push(parent);
    }
    for (const parent of trail.reverse()) {
      if (!visible) {context.ancestors.set(parent,false);continue;}
      const style = getComputedStyle(parent);
      visible = !(style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0);
      if (visible && (['hidden','clip'].includes(style.overflowY) || ['hidden','clip'].includes(style.overflowX))) {
        const rect = rectOf(parent,context);
        visible = !((['hidden','clip'].includes(style.overflowY) && rect.height <= 0) || (['hidden','clip'].includes(style.overflowX) && rect.width <= 0));
      }
      context.ancestors.set(parent,visible);
    }
    if (!visible) return false;
    if (!context.clientRects.has(element)) context.clientRects.set(element,element.getClientRects().length > 0);
    return context.clientRects.get(element);
  }
  const blockOf = node => node.parentElement.closest(BLOCKS) || node.parentElement;
  function sourcePart(node, roots, range, context) {
    if (!node.data || !allowed(node, context)) return '';
    if (range) {
      if (!range.intersectsNode(node)) return '';
      const start = node === range.startContainer ? range.startOffset : 0;
      const end = node === range.endContainer ? range.endOffset : node.length;
      return node.data.slice(start, end);
    }
    const root = roots.find(root => root.contains(node));
    if (!root || (node.parentElement.closest(PAGE_CHROME) && !root.matches(DOC_TITLE)) ||
        (isWikipedia && node.parentElement.closest(WIKI_CHROME))) return '';
    return node.data;
  }
  function appendSource(parts, node, text) {
    if (!text) return;
    const last = parts.at(-1);
    if (node.parentElement.closest(INLINE_CODE)) {
      if (last?.literal !== undefined) last.literal += text;
      else parts.push({literal:text});
    } else if (typeof last === 'string') parts[parts.length - 1] += text;
    else parts.push(text);
  }
  function snapshot(parts) {
    if (parts.length <= 1 && typeof parts[0] !== 'object') return {text:normalize(parts[0] || '')};
    const cleaned = parts.map(part => typeof part === 'string' ? part.replace(/\s+/gu, ' ') : part);
    if (typeof cleaned[0] === 'string') cleaned[0] = cleaned[0].trimStart();
    if (typeof cleaned.at(-1) === 'string') cleaned[cleaned.length - 1] = cleaned.at(-1).trimEnd();
    const text = cleaned.map(part => typeof part === 'string' ? part : part.literal).join('');
    return {text, parts:cleaned.filter(Boolean)};
  }
  function matchesSource(record, context) {
    const current = sourceOf(record, context);
    return current?.text === record.text && JSON.stringify(current.parts) === JSON.stringify(record.parts);
  }
  function sourceOf(record, context = readContext()) {
    const {element, roots, selection} = record;
    if (!element.isConnected) return null;
    let range = null;
    if (selection) {
      const {first, start, last, end} = selection;
      if (!element.contains(first) || !element.contains(last) || first.length < start || last.length < end) return null;
      range = document.createRange();
      range.setStart(first, start);
      range.setEnd(last, end);
      if (range.collapsed) return null;
    }
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, node => {
      if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
      return node.matches(BLOCKS) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
    });
    const parts = [];
    for (let node; (node = walker.nextNode());) {
      if (blockOf(node) === element) appendSource(parts, node, sourcePart(node, roots, range, context));
    }
    return snapshot(parts);
  }
  function pageMutation(change) {
    if (change.type === 'attributes' && change.attributeName === REPLACED) return false;
    const owned = node => (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest('[data-qingread]');
    if (owned(change.target)) return false;
    return change.type !== 'childList' || [...change.addedNodes, ...change.removedNodes].some(node => !owned(node));
  }
  function touches(change, element) {
    return element.contains(change.target) ||
      (change.type === 'attributes' && change.target.contains(element)) ||
      (change.type === 'childList' && [...change.removedNodes].some(node => node.contains(element)));
  }
  function stylesheetMutation(change) {
    const styles = 'style,link[rel~="stylesheet"]';
    const target = change.target.nodeType === Node.ELEMENT_NODE ? change.target : change.target.parentElement;
    return target?.closest(styles) || (change.type === 'childList' &&
      [...change.addedNodes, ...change.removedNodes].some(node => node.matches?.(styles)));
  }
  function readOriginal(read) {
    if (!displaySheet || displaySheet.disabled) return read();
    displaySheet.disabled = true;
    try { return read(); }
    finally { displaySheet.disabled = false; }
  }
  function canReplace(record, context) {
    const {element, roots, selection} = record;
    if (selection || element.matches('html,body,' + PROTECTED_CONTENT) || element.querySelector(PROTECTED_CONTENT) ||
        element.style.getPropertyPriority('display') === 'important') return false;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode());) {
      if (!node.data.trim() || !allowed(node, context)) continue;
      if (blockOf(node) !== element || !sourcePart(node, roots, null, context)) return false;
    }
    return true;
  }
  function placeTranslation(item, replace) {
    if (item.replacing === replace) return;
    const {element} = item.record;
    const {host} = item;
    item.replacing = replace;
    host.toggleAttribute('data-qingread-only', replace);
    host.style.setProperty('margin', replace ? item.originalMargin : '4px 0 12px', 'important');
    if (replace) {
      if (element.matches(STRUCTURAL)) {
        const slot = document.createElement(element.localName);
        slot.dataset.qingread = 'replacement';
        for (const name of ['colspan', 'rowspan', 'scope', 'value']) {
          if (element.hasAttribute(name)) slot.setAttribute(name, element.getAttribute(name));
        }
        slot.append(host);
        element.after(slot);
        item.slot = slot;
      } else element.after(host);
      if (/^h[1-6]$/u.test(element.localName)) {
        host.setAttribute('role', 'heading');
        host.setAttribute('aria-level', element.localName.slice(1));
        host.removeAttribute('aria-label');
      }
      element.setAttribute(REPLACED, 'zh');
    } else {
      element.removeAttribute(REPLACED);
      host.removeAttribute('role');
      host.removeAttribute('aria-level');
      host.setAttribute('aria-label', item.record.selection ? '反白文字的繁體中文譯文' : '繁體中文譯文');
      if (element.matches(STRUCTURAL + ',blockquote,article,section,.faq-title')) element.append(host);
      else element.after(host);
      item.slot?.remove();
      item.slot = null;
    }
  }
  function removeTranslation(item) {
    if (item.replacing) item.record.element.removeAttribute(REPLACED);
    item.host.remove();
    item.slot?.remove();
  }
  function setDisplayMode(only) {
    if (translationOnly === only) return;
    if (only) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(`@layer qingread-display { [${REPLACED}="zh"]{display:none!important} }`);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      displaySheet = sheet;
    }
    translationOnly = only;
    pruneRendered();
    if (!only && displaySheet) {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter(sheet => sheet !== displaySheet);
      displaySheet = null;
    }
  }
  function pruneRendered(changes) {
    // Temporarily show original layout for synchronous checks. The browser paints after it is restored.
    const updates = readOriginal(() => {
      const context = readContext();
      const stylesChanged = changes?.some(stylesheetMutation);
      const updates = [];
      for (const translations of [rendered, renderedSelection]) {
        for (const [element, item] of translations) {
          const moved = changes?.some(change => change.type === 'childList' &&
            [...change.removedNodes].some(node => node.contains(element) || node.contains(item.host)));
          const needsCheck = !changes || stylesChanged || item.record.article !== context.article?.root ||
            changes.some(change => touches(change, element));
          if (moved || !item.host.isConnected || !element.isConnected ||
              (needsCheck && !matchesSource(item.record, context))) {
            updates.push([item, null]);
            translations.delete(element);
          } else if (needsCheck) {
            updates.push([item, translationOnly && canReplace(item.record, context)]);
          }
        }
      }
      return updates;
    });
    for (const [item, replace] of updates) {
      if (replace === null) removeTranslation(item);
      else placeTranslation(item, replace);
    }
    if (!rendered.size && !renderedSelection.size) renderedObserver.disconnect();
  }
  const renderedObserver = new MutationObserver(changes => {
    const relevant = changes.filter(pageMutation);
    if (relevant.length || [rendered, renderedSelection].some(items =>
      [...items.values()].some(item => !item.host.isConnected))) pruneRendered(relevant);
  });
  const mutationOptions = {subtree:true,childList:true,characterData:true,attributes:true};
  function clearSelectionTranslations() {
    for (const item of renderedSelection.values()) removeTranslation(item);
    renderedSelection.clear();
    selectionJob = null;
  }
  function removeTranslations() {
    collectionEpoch++;summaryEpoch++;
    renderedObserver.disconnect();
    clearSelectionTranslations();
    for (const item of rendered.values()) removeTranslation(item);
    rendered.clear(); records.clear(); currentJob = null; currentJobUrl = null;
    setDisplayMode(false);
    layoutStyle?.remove(); layoutStyle = null;
  }
  function readableRoot(root) {
    const context=readContext();
    if (!root || excluded(root,context) || root.closest(PAGE_CHROME)) return false;
    const rect = root.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node, visited = 0;
    while ((node = walker.nextNode()) && ++visited <= 25000) {
      if (/\p{L}/u.test(node.textContent) && allowed(node,context) && !node.parentElement.closest(PAGE_CHROME)) return true;
    }
    return false;
  }
  function readingRoot(scope) {
    if (scope === 'selection') return document.body;
    const formArticle=pageFormArticle();
    if (formArticle && readableRoot(formArticle.root)) return formArticle.root;
    const google = ['www.google.com','www.google.com.tw'].includes(location.hostname) && location.pathname === '/search' ? document.getElementById('rso') : null;
    const wiki = isWikipedia ? document.querySelector('#mw-content-text .mw-parser-output') : null;
    const course = /(^|\.)skilljar\.com$/.test(location.hostname) ? document.getElementById('skilljar-content') : null;
    const docs = document.querySelector(DOC_BODY);
    for (const candidate of [google, wiki, course, docs]) if (readableRoot(candidate)) return candidate;
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
  async function collect(message) {
    const summary = message.type === 'qingread:summary-source';
    const sourceUrl = location.href;
    if (!summary && typeof message.sourceUrl === 'string' && message.sourceUrl !== sourceUrl) return {error:'changed'};
    const epoch = summary ? ++summaryEpoch : ++collectionEpoch;
    const live = () => summary ? epoch === summaryEpoch : epoch === collectionEpoch && currentJob === message.job && location.href === sourceUrl;
    if (!summary) { records.clear(); currentJob = message.job; currentJobUrl = sourceUrl; }
    if (rendered.size || renderedSelection.size) pruneRendered();
    const first = await collectAttempt(message, summary, live);
    // Retake a changed page once, but never retry a selection, a stopped job or a superseded request.
    if (first.error === 'changed' && message.scope !== 'selection' && live()) return collectAttempt(message, summary, live);
    return first;
  }
  async function collectAttempt(message, summary, live) {
    const primaryRoot = readOriginal(() => readingRoot(message.scope));
    // FAQs are supplementary reading content, not a replacement for the course.
    const faqRoots = message.scope !== 'selection' && /(^|\.)skilljar\.com$/.test(location.hostname)
      ? [...document.querySelectorAll('#sj-custom-footer .faq-container')] : [];
    const selection = message.scope === 'selection' ? window.getSelection() : null;
    if (message.scope === 'selection' && (!selection || selection.isCollapsed || !selection.rangeCount)) {
      return { items: [], reason: 'selection' };
    }
    const range = selection?.getRangeAt(0).cloneRange();
    const selectionRoot = range?.commonAncestorContainer;
    const title = primaryRoot?.matches(DOC_BODY) ? primaryRoot.previousElementSibling?.querySelector(DOC_TITLE) : null;
    const root = selectionRoot?.nodeType === Node.TEXT_NODE ? selectionRoot.parentElement :
      (selectionRoot || (faqRoots.length ? document.body : title ? primaryRoot.parentElement : primaryRoot));
    if (!root) return { items: [], limited: false };
    const roots = range ? [root] : [title, primaryRoot, ...faqRoots].filter(Boolean);
    const frames = message.scope === 'selection' ? [] : embeddedPages();
    const courseShell = location.hostname === 'learn.nvidia.com' && /^\/courses\/course\/?$/.test(location.pathname) && frames.length > 0 && message.scope !== 'selection';
    if (courseShell) return {items:[],frames,reason:'embedded',limited:false};
    const groups = new Map();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let context = readContext(), changed = false;
    const article = context.article?.root;
    const relevant = change => {
      if (!pageMutation(change)) return false;
      if (stylesheetMutation(change)) return true;
      const target = change.target.nodeType === Node.ELEMENT_NODE ? change.target : change.target.parentElement;
      if (!range && target?.closest(PAGE_CHROME) && !title?.contains(target) &&
          !target.contains(title ?? null) && change.attributeName !== 'role') return false;
      return roots.some(element => touches(change, element));
    };
    const observer = new MutationObserver(changes => { changed ||= changes.some(relevant); });
    observer.observe(document.documentElement, mutationOptions);
    const valid = () => live() && !changed && !observer.takeRecords().some(relevant) &&
      roots.every(element => element.isConnected) && pageFormArticle()?.root === article;
    let visited = 0;
    try {
      const scan = () => {
        for (let step = 0; step < 512; step++) {
          const node = walker.nextNode();
          if (!node || ++visited > 25000) return true;
          const text = sourcePart(node, roots, range, context);
          if (!text) continue;
          const element = blockOf(node);
          if (!groups.has(element)) groups.set(element, {element, nodes:[], parts:[]});
          const group = groups.get(element);
          group.nodes.push(node);
          appendSource(group.parts, node, text);
        }
        return false;
      };
      while (!readOriginal(scan)) {
        await new Promise(resolve=>setTimeout(resolve,0));
        if (!valid()) return {error:'changed'};
        context = readContext();
      }
    const items = [], batchRecords = new Map();
    let characters = 0, alreadyTranslated = 0;
    let limited = visited > 25000;
    const ordered = [...groups.values()];
    context = readContext();
    if (!range && !summary) ordered.sort((a,b) => distance(a.element,context)-distance(b.element,context));
    for (const group of ordered) {
      const source = snapshot(group.parts);
      const {text, parts} = source;
      const prose = parts ? parts.filter(part => typeof part === 'string').join('') : text;
      if (text.length < 2 || !/\p{L}/u.test(prose)) continue;
      // Short link-only blocks are usually navigation, not article prose.
      if (!range && text.length < 160 && group.nodes.filter(n => normalize(n.textContent)).every(n => n.parentElement.closest('a'))) continue;
      if (!summary && !range && rendered.has(group.element)) { alreadyTranslated++; continue; }
      if (items.length >= 200 || characters + text.length > 60000) { limited = true; continue; }
      const id = crypto.randomUUID();
      if (!summary) {
        const first = group.nodes[0], last = group.nodes.at(-1);
        const selection = range && {
          first, last, start: first === range.startContainer ? range.startOffset : 0,
          end: last === range.endContainer ? range.endOffset : last.length
        };
        batchRecords.set(id, {element:group.element, roots, selection, ...source, article});
      }
      items.push(summary ? {id, text} : {id, ...source}); characters += text.length;
    }
    if (!valid()) return {error:'changed'};
    for (const [id, record] of batchRecords) records.set(id, record);
    return { items, frames, characters, limited, alreadyTranslated, reason: !items.length && alreadyTranslated ? 'translated' : undefined };
    } finally { observer.disconnect(); }
  }
  function apply(message) {
    if (message.job !== currentJob) return { applied: false };
    if (location.href !== currentJobUrl) return { error:'changed' };
    const record = records.get(message.id);
    if (!record || typeof message.text !== 'string' || message.text.length > 100000) return { applied: false };
    records.delete(message.id);
    if (!record.selection && rendered.has(record.element)) return { applied: false };
    const source = readOriginal(() => {
      const context = readContext();
      if (!matchesSource(record, context)) return null;
      const style = getComputedStyle(record.element);
      return {color:style.color, fontSize:style.fontSize, fontFamily:style.fontFamily, fontWeight:style.fontWeight,
        lineHeight:style.lineHeight, margin:style.margin, replace:translationOnly && canReplace(record, context)};
    });
    if (!source) return { applied: false };
    const host = document.createElement('div');
    host.dataset.qingread = 'translation';
    if (record.selection) host.dataset.qingreadScope = 'selection';
    if (/(^|\.)skilljar\.com$/.test(location.hostname) && record.element.closest('.dp-curriculum .lesson-modular') && !layoutStyle) {
      layoutStyle = document.createElement('style');
      layoutStyle.dataset.qingread = 'layout';
      layoutStyle.textContent = '.dp-curriculum .lesson-modular:has([data-qingread="translation"]){height:auto!important;min-height:44px;max-height:none!important;align-items:center!important}.dp-curriculum .lesson-modular:has([data-qingread="translation"]) .lesson-wrapper{min-width:0;flex:1;height:auto!important;max-height:none!important}';
      document.head.append(layoutStyle);
    }
    host.lang = 'zh-Hant';
    host.style.cssText = 'display:block!important;clear:none!important;margin:4px 0 12px!important;max-width:100%;';
    host.style.color = source.color;
    host.style.fontSize = source.fontSize;
    host.style.fontFamily = source.fontFamily;
    host.style.fontWeight = source.fontWeight;
    host.style.lineHeight = source.lineHeight;
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = 'div{font-family:system-ui,"Microsoft JhengHei",sans-serif;font-size:inherit;font-weight:400;line-height:1.75;color:inherit;border-inline-start:2px solid #aa8bf1;padding:0 0 0 10px;white-space:pre-wrap;overflow-wrap:anywhere;text-align:start}:host([data-qingread-only]) div{font:inherit;border:0;padding:0}';
    const box = document.createElement('div');
    const text = document.createElement('span'); text.textContent = message.text;
    box.append(text); shadow.append(style, box);
    if (record.selection && selectionJob !== message.job) {
      clearSelectionTranslations();
      selectionJob = message.job;
    }
    const previousSelection = renderedSelection.get(record.element);
    if (previousSelection) removeTranslation(previousSelection);
    renderedSelection.delete(record.element);
    const item = {host, record, originalMargin:source.margin};
    placeTranslation(item, source.replace);
    (record.selection ? renderedSelection : rendered).set(record.element, item);
    renderedObserver.observe(document.documentElement, mutationOptions);
    return { applied: true };
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('panel.html'))) return;
    try {
      if (['qingread:collect','qingread:summary-source'].includes(message?.type) && typeof message.job === 'string') {
        void collect(message).then(respond,()=>respond({error:'page'}));return true;
      }
      else if (message?.type === 'qingread:frames') respond({frames:embeddedPages()});
      else if (message?.type === 'qingread:prioritize' && message.job === currentJob) {
        if (location.href !== currentJobUrl) { respond({error:'changed'}); return; }
        const context=readContext();respond({ ids: [...records].sort((a,b) => distance(a[1].element,context)-distance(b[1].element,context)).map(([id]) => id) });
      }
      else if (message?.type === 'qingread:apply') respond(apply(message));
      else if (message?.type === 'qingread:display') {
        if (typeof message.translationOnly === 'boolean') setDisplayMode(message.translationOnly);
        respond({translationOnly});
      }
      else if (message?.type === 'qingread:restore') { removeTranslations(); respond({ restored: true }); }
      else if (message?.type === 'qingread:cancel') { if (currentJob === message.job) { collectionEpoch++;currentJob = null;currentJobUrl = null;records.clear(); } respond({ stopped: true }); }
    } catch { respond({ error: 'page' }); }
  });
})();
