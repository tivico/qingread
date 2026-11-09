'use strict';
(() => {
  const el = id => document.getElementById('vs-'+id), core = QingReadVideoSummary;
  let task = null, source = null, accessError = null;
  const live = job => task === job && !job.controller.signal.aborted;
  const CAPTURE_TIMEOUT_MS = 30000, POLL_MS = 300;
  function wait(signal) {
    return new Promise((resolve,reject)=>{
      const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(new DOMException('Stopped','AbortError'));};
      const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},POLL_MS);
      signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    });
  }
  async function capture(target,job) {
    const started=Date.now();
    while(live(job)) {
      const batch=await send(target,{type:'qingread:video-transcript',prepare:true,job:job.id});
      if(!live(job))throw new DOMException('Stopped','AbortError');
      if(!batch?.pending)return batch;
      const elapsed=Date.now()-started;
      el('status').textContent=(batch.message || '正在準備逐字稿…')+`（${Math.floor(elapsed/1000)} 秒）`;
      if(elapsed>=CAPTURE_TIMEOUT_MS)throw new Error('已等候 30 秒，YouTube 仍未提供可讀字幕。這支影片可能沒有逐字稿，或網站載入失敗。可稍後重新按整理；不會改用說明或留言產生摘要。');
      await wait(job.controller.signal);
    }
    throw new DOMException('Stopped','AbortError');
  }
  function controls(busy) { el('start').disabled=busy; el('stop').disabled=!busy; el('detail').disabled=busy; }
  function renderSummary(target,text) {
    target.replaceChildren();target.classList.add('vs-summary');
    function inline(parent,value) {
      for(const part of value.split(/(\*\*[^*\n]+\*\*)/g)) {
        if(part.startsWith('**') && part.endsWith('**') && part.length>4){const strong=document.createElement('strong');strong.textContent=part.slice(2,-2);parent.append(strong);}
        else parent.append(document.createTextNode(part));
      }
    }
    let list=null,paragraph=null;
    for(const line of text.split(/\r?\n/)) {
      const value=line.trim();if(!value){list=null;paragraph=null;continue;}
      const ordered=value.match(/^(\d{1,3})[.、)]\s+(.+)$/),bullet=value.match(/^[-*•]\s+(.+)$/);
      if(ordered || bullet){
        const tag=ordered?'OL':'UL';
        if(!list || list.tagName!==tag){list=document.createElement(tag);if(ordered)list.start=Number(ordered[1]);target.append(list);}
        const item=document.createElement('li');inline(item,ordered?ordered[2]:bullet[1]);list.append(item);paragraph=null;
      }else{
        list=null;
        if(!paragraph){paragraph=document.createElement('p');target.append(paragraph);}else paragraph.append(document.createTextNode(' '));
        inline(paragraph,value.replace(/^#{1,6}\s+/,''));
      }
    }
  }
  const plainSummary=text=>text.replace(/\*\*([^*\n]+)\*\*/g,'$1').replace(/^#{1,6}\s+/gm,'').replace(/^\s*\*\s+/gm,'• ');
  function showTiming(timings) {
    const seconds=key=>(timings.reduce((sum,value)=>sum+(value[key]||0),0)/1000).toFixed(1);
    el('timing').textContent=`已完成 ${timings.length} 筆，含 ${timings.filter(value=>value.cached).length} 筆快取。累計：模型讀取原文 ${seconds('promptMs')} 秒、生成文字 ${seconds('generationMs')} 秒、載入 ${seconds('loadMs')} 秒、排隊 ${seconds('queueMs')} 秒。每筆往返合計 ${seconds('elapsedMs')} 秒。`;
  }
  function reveal() {
    if(!el('output').hidden && !el('section').closest('[data-page]').hidden && !document.hidden)
      el('output').scrollIntoView({block:'start'});
  }
  function showSource() {
    el('source').hidden=!source;
    el('source').textContent=source ? `摘要來源：${source.title}。${source.coverage}${source.changed ? '保留開始時讀取的字幕，不會隨分頁更新。' : ''}` : '';
  }
  function stop(message='已停止影片摘要。') {
    const old=task; task=null; old?.controller.abort(); controls(false);
    if (!old) return;
    const prior=message+(source?.notes.length ? ' 下方是已完成的分段摘要，總覽尚未完成。' : '');
    el('status').textContent=prior;
    if(old.request) void Promise.allSettled([old.request]).then(results=>{
      if(!task && el('status').textContent===prior) el('status').textContent=prior+' '+QingReadLocal.cancellationText(results);
    });
  }
  function reset() {
    source=null; showSource(); accessError=null; el('access').hidden=true;
    el('output').hidden=true; el('overview').textContent=''; el('notes').replaceChildren();
    el('preview').textContent=''; el('copy').disabled=true;
    el('timing').textContent='完成一段後會顯示模型讀取與生成耗時。';
  }
  function addNote(note) {
    source.notes.push(note);
    const article=document.createElement('article'), link=document.createElement('a'), text=document.createElement('div');
    link.textContent=`${core.time(note.start)}–${core.time(note.end)}`;
    const url=source.url+'&t='+Math.floor(note.start)+'s', tabId=source.tabId, videoId=source.videoId;
    link.href=url; link.target='_blank'; link.rel='noopener noreferrer';
    link.setAttribute('aria-label',`回看影片 ${core.time(note.start)}`);
    link.onclick=async event=>{
      event.preventDefault();
      try {
        const tab=await chrome.tabs.get(tabId).catch(()=>null);
        let same=false;try{const current=new URL(tab?.url);same=current.hostname==='www.youtube.com' && current.pathname==='/watch' && current.searchParams.get('v')===videoId;}catch{}
        if(same) await chrome.tabs.update(tabId,{url,active:true});
        else await chrome.tabs.create({url});
      } catch { el('status').textContent='無法開啟時間連結，可在連結上按右鍵另開分頁。'; }
    };
    renderSummary(text,note.text); article.append(link,text); el('notes').append(article);
    const first=el('output').hidden;
    el('output').hidden=false; el('copy').disabled=false;
    if(first)reveal();
  }
  el('start').onclick=async()=>{
    if(task)return;
    reset();const job={id:crypto.randomUUID(),detail:el('detail').value,controller:new AbortController(),captured:false};task=job;controls(true);
    el('status').textContent='正在尋找 YouTube 逐字稿，找到後會自動展開…';
    try {
      const tab=await activeTab(); if(!live(job))return;
      job.tabId=tab.id;job.windowId=tab.windowId;
      const target=await inject(tab,'transcript-content.js');if(!live(job))return;
      const batch=await capture(target,job);if(!live(job))return;
      if(batch?.error)throw new Error(batch.error);
      if (!/^[\w-]{11}$/.test(batch?.videoId || '') || batch.url!==`https://www.youtube.com/watch?v=${batch.videoId}`)
        throw new Error('影片來源格式不正確，請重新整理影片後重試。');
      core.chunks(batch.segments); // Validate the complete snapshot before sending any text.
      const first=batch.segments[0].start,last=batch.segments.at(-1).start;
      const chars=batch.segments.reduce((sum,item)=>sum+Array.from(item.text).length,0);
      source={tabId:tab.id,windowId:tab.windowId,title:batch.title || 'YouTube 影片',url:batch.url,videoId:batch.videoId,notes:[],overview:'',
        coverage:`${job.detail==='concise'?'精簡重點':'詳細整理'}。已讀取 ${batch.segments.length} 段／${chars} 字元，字幕起點範圍 ${core.time(first)}–${core.time(last)}${Number.isFinite(batch.duration) ? `，影片長 ${core.time(batch.duration)}` : ''}。${batch.skipped ? `另有 ${batch.skipped} 段無法讀取。` : ''}只根據讀到的字幕整理，未確認涵蓋全片，也未分析畫面。`};
      job.captured=true;showSource();let stage='';
      const result=await core.summarize(batch.segments,{
        signal:job.controller.signal,
        detail:job.detail,
        onTiming:timings=>{if(live(job))showTiming(timings);},
        request:(path,options)=>{job.request=QingReadLocal.request(path,options);return job.request;},
        onStage:text=>{if(live(job)){stage=text;el('preview').textContent='';el('status').textContent=text+'…';}},
        onProgress:event=>{if(live(job)){el('status').textContent=stage+'。'+QingReadLocal.stageText(event);el('preview').textContent=event.text ? '本段產生中，尚未完成：\n'+event.text : '';}},
        onChunk:note=>{if(live(job))addNote(note);}
      });
      if(!live(job))return;
      source.overview=result.text;renderSummary(el('overview'),result.text);el('output').hidden=false;
      el('preview').textContent='';el('copy').disabled=false;
      el('status').textContent='影片摘要已完成。時間連結對應各段原始字幕起點，請對照原片核對。';
    } catch(error) {
      if(!live(job))return;
      el('preview').textContent='';
      el('status').textContent=(error.name==='Error' ? error.message : QingReadCore.errorText(error))+
        (source?.notes.length ? ' 下方僅保留已完成段落，整份摘要尚未完成。' : '');
      if(error.name==='PageAccessError'){accessError=error;el('access').hidden=false;}
    } finally { if(task===job){task=null;controls(false);} }
  };
  el('stop').onclick=()=>stop();
  el('access').onclick=()=>{document.querySelector('[data-view=web]').click();if(accessError)showFailure(accessError,{stage:'page-read'});};
  el('copy').onclick=async()=>{
    if(!source)return;
    const text=[source.title,source.url,source.coverage,plainSummary(source.overview) || '部分結果：總覽尚未完成。',
      ...source.notes.map(note=>`${core.time(note.start)}–${core.time(note.end)}\n${source.url}&t=${Math.floor(note.start)}s\n${plainSummary(note.text)}`)].join('\n\n');
    try{await navigator.clipboard.writeText(text);}catch{el('status').textContent='複製未成功，可反白結果手動複製。';}
  };
  chrome.tabs.onActivated.addListener(info=>{
    if(task && !task.captured && (task.windowId===undefined || task.windowId===info.windowId) && info.tabId!==task.tabId)stop('擷取前已切換分頁，請回到影片重新開始。');
    if(source && info.windowId===source.windowId && info.tabId!==source.tabId){source.changed=true;showSource();}
  });
  function moved(id){
    if(task && !task.captured && id===task.tabId)stop('擷取前影片已變更，請重新開始。');
    if(source && id===source.tabId){source.changed=true;showSource();}
  }
  chrome.tabs.onUpdated.addListener((id,change)=>{if(change.url || change.status==='loading')moved(id);});
  chrome.tabs.onRemoved?.addListener(moved);
  window.addEventListener('pagehide',()=>stop());
  document.addEventListener('visibilitychange',reveal);
  document.querySelector('[data-view=summary]').addEventListener('click',reveal);
  document.getElementById('video-summary-open').onclick=()=>{
    document.querySelector('[data-view=summary]').click();el('section').scrollIntoView({block:'start'});
  };
})();
