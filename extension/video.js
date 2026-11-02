'use strict';
(() => {
  const el = id => document.getElementById(id);
  let remote=null, handingOff=false;
  const background=async(action,data={})=>{
    const value=await chrome.runtime.sendMessage({type:'qingread:video-control',action,...data});
    if(value?.error)throw new Error(value.error);return value;
  };
  let session = null, hoverTarget = null, hoverLookup = null, hoverVersion = -1, hoverEpoch = 0;
  const say = text => { if (el('video-status').textContent !== text) el('video-status').textContent = text; };
  const send = (target,message) => chrome.tabs.sendMessage(target.tabId,message,{documentId:target.documentId}).catch(()=>{throw new DOMException('Receiver unavailable','PageReadError');});
  let accessError = null;
  const mediaError = error => /^(Page|Extension)/.test(error.name) ? QingReadCore.errorText(error) : error.name === 'Error' ? error.message : QingReadCore.errorText(error);
  el('video-access').onclick = () => {document.querySelector('[data-view=web]').click();if(accessError)showFailure(accessError,{stage:'page-read'});};
  async function target(check = () => {}) {
    const tab = await activeTab();
    check(tab);
    return inject(tab, 'media-content.js');
  }
  function stop(reason='字幕已停止。') {
    const old=session; session=null;
    if (old) {
      clearInterval(old.timer); old.controller.abort();
      old.speechQueue?.clear();old.lastSpeech=null;
      const cleanup=old.translator?.destroy();
      if(old.translator?.managed)void cleanup.then(results=>{if(!session && el('video-status').textContent===reason)say(reason+' '+QingReadLocal.cancellationText(results));});
      old.stream?.getTracks().forEach(track=>track.stop()); void old.audio?.close().catch(()=>{});
      if(old.target) void send(old.target,{type:'qingread:media-stop',session:old.id}).catch(()=>{});
    }
    el('video-start').disabled=false; el('video-stop').disabled=true; el('video-collapse').disabled=true;
    el('video-mode').disabled=false; el('video-bilingual').disabled=false; say(reason);
  }
  function live(s) { if(session!==s) throw new DOMException('Stopped','AbortError'); }
  const {captions,speech,watchSpeech}=QingReadVideoPipeline.create({getSession:()=>session,stop,say,send,waitForEngine});
  el('video-start').onclick=async()=>{
    if(session||handingOff)return;
    if(remote?.active){say('已有背景字幕，請先停止再開始新的字幕。');return;}
    if(running){say('請先停止網頁或文字翻譯，再開始字幕。');return;}
    if(!ready){say('請先確認所選翻譯引擎與語言組合可用。');return;}
    const s={id:crypto.randomUUID(),controller:new AbortController(),engine:el('engine').value,source:el('source').value,mode:el('video-mode').value,busy:false,reading:false,dropped:0,glossary:glossaryRules.map(rule=>[...rule]),terms:el('terms').checked,
      cues:QingReadCaptions.createCueBuffer(),speechQueue:QingReadSpeech.createLatestBuffer(),cache:new Map(),cacheEnabled:el('engine').value!=='local',bilingual:el('video-bilingual').checked,skipped:0};session=s;
    el('video-access').hidden=true;accessError=null;
    el('video-start').disabled=true;el('video-stop').disabled=false;el('video-collapse').disabled=true;
    el('video-mode').disabled=true;el('video-bilingual').disabled=true;say('正在準備影片字幕…');
    try {
      // All APIs requiring a user gesture are initiated before the first await.
      const permission=(s.mode==='speech'?chrome.permissions.request({permissions:['tabCapture']}):Promise.resolve(true)).then(granted=>({granted}),error=>({error}));
      s.creation=Promise.resolve(el('engine').value==='local'?QingReadLocal.translator(s.source):globalThis.Translator?.create({sourceLanguage:s.source,targetLanguage:'zh-Hant',signal:s.controller.signal})).then(translator=>({translator}),error=>({error}));
      // Detect page access failure before waiting on model downloads.
      s.target=await target(tab=>{live(s);s.tabId=tab.id;s.windowId=tab.windowId;});live(s);
      const permitted=await permission;live(s);if(permitted.error)throw permitted.error;
      if(!permitted.granted)throw new Error('需要分頁音訊權限才能進行語音辨識。');
      const created=await waitForEngine(s.creation,s);live(s);
      if(created.error)throw created.error;
      if(!created.translator)throw new Error('Chrome 語言包尚不可用，請選本機模型或更新 Chrome。');
      s.translator=created.translator;
      const result=await send(s.target,{type:'qingread:media-start',session:s.id,mode:s.mode,bilingual:s.bilingual});live(s);
      if(!result?.ok)throw new Error(result?.error || '無法啟動影片字幕。');
      if(s.mode==='captions') {s.timer=setInterval(()=>void captions(s),250);say('等候原文字幕；請在播放器開啟字幕。');}
      else {
        const capture=await chrome.runtime.sendMessage({type:'qingread:capture',tabId:s.target.tabId});live(s);
        if(!capture?.streamId)throw new Error(capture?.error || '無法擷取分頁音訊。');
        const stream=await navigator.mediaDevices.getUserMedia({audio:{mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:capture.streamId}},video:false});
        if(session!==s){stream.getTracks().forEach(t=>t.stop());return;}s.stream=stream;
        s.audio=new AudioContext();await s.audio.audioWorklet.addModule('audio-worklet.js');live(s);
        const source=s.audio.createMediaStreamSource(stream), processor=new AudioWorkletNode(s.audio,'qingread-audio');
        s.processor=processor;s.timer=setInterval(()=>void watchSpeech(s),250);
        source.connect(s.audio.destination);source.connect(processor);processor.connect(s.audio.destination);
        processor.port.onmessage=event=>{if(session===s)void speech(s,event.data);};
        stream.getTracks().forEach(track=>track.addEventListener('ended',()=>{if(session===s)stop('音訊擷取已結束。');}));
        await s.audio.resume();say('正在聆聽此分頁，每 4 秒處理一段，邊界保留 0.5 秒重疊。');
      }
      s.started=true;el('video-collapse').disabled=false;
    }catch(error){
      if(session===s){stop(mediaError(error));if(error.name==='PageAccessError'){accessError=error;el('video-access').hidden=false;}}
      else s.translator?.destroy();
    }finally{if(!s.translator)void s.creation?.then(result=>result.translator?.destroy());}
  };
  el('video-stop').onclick=()=>{
    if(handingOff)void background('cancel-prepare').catch(()=>{});
    if(remote?.active)void background('stop').then(updateRemote,error=>say(error.message));
    else stop();
  };
  function updateRemote(state){
    if(handingOff)return;
    const wasActive=remote?.active;remote=state;
    if(session)return;
    if(state?.active){
      el('video-start').disabled=true;el('video-stop').disabled=false;el('video-collapse').disabled=false;
      el('video-mode').disabled=true;el('video-bilingual').disabled=true;
      say('背景字幕執行中。'+state.status);
    }else if(wasActive){
      el('video-start').disabled=false;el('video-stop').disabled=true;el('video-collapse').disabled=true;
      el('video-mode').disabled=false;el('video-bilingual').disabled=false;say(state?.status||'背景字幕已結束。');
    }
  }
  async function closePanel(){
    const result=await background('collapse');
    if(result?.manual)el('video-background-status').textContent=('字幕已在背景繼續。這個 Chrome 請用側欄右上角 × 收起；更新至 Chrome 141 以上可一鍵收合。');
  }
  el('video-collapse').onclick=async()=>{
    if(handingOff)return;
    if(remote?.active){try{await closePanel();}catch(error){say(error.message);}return;}
    const s=session;if(!s?.started)return;
    handingOff=true;el('video-collapse').disabled=true;
    el('video-background-status').textContent='正在交接字幕，成功後會收合側欄…';
    try{
      await background('prepare',{ticket:s.id,target:s.target,config:{engine:s.engine,source:s.source,mode:s.mode,terms:s.terms,bilingual:s.bilingual,glossary:s.glossary}});
      live(s);
      // Stop the old owner only after the background engine is ready.
      stop('背景引擎已準備，正在接手字幕…');
      const state=await background('commit',{ticket:s.id});
      if(!state?.active)throw new Error('背景字幕沒有啟動，請重新開始。');
      remote=state;el('video-background-status').textContent='背景已接手；可收起側欄並使用全螢幕。';await closePanel();
    }catch(error){
      void background('cancel-prepare').catch(()=>{});
      el('video-background-status').textContent=error.name==='AbortError'?'已取消收合。':error.message;
    }finally{
      handingOff=false;
      if(remote?.active)updateRemote(remote);
      else el('video-collapse').disabled=!session?.started;
    }
  };
  if(chrome.runtime?.sendMessage){
    const refreshRemote=()=>{if(!handingOff)void background('status').then(updateRemote).catch(()=>{});};
    refreshRemote();setInterval(refreshRemote,1000);
  }

  el('start').addEventListener('click',()=>{if(remote?.active)void background('stop').then(updateRemote).catch(()=>{});if(session)stop('開始網頁翻譯，已停止字幕。');});
  el('text-start').addEventListener('click',()=>{if(remote?.active)void background('stop').then(updateRemote).catch(()=>{});if(session)stop('開始文字翻譯，已停止字幕。');});
  el('test-engine').addEventListener('click',()=>{if(remote?.active)void background('stop').then(updateRemote).catch(()=>{});if(session)stop('測試翻譯引擎，已停止字幕。');});
  async function disableHover(){
    hoverEpoch++;const old=hoverTarget;hoverTarget=null;hoverVersion=-1;
    hoverLookup?.controller.abort();hoverLookup=null;
    el('hover').checked=false;
    if(old)await send(old,{type:'qingread:hover-enable',enabled:false}).catch(()=>{});
  }
  el('hover').onchange=async()=>{
    if(!el('hover').checked){await disableHover();return;}
    const epoch=++hoverEpoch;
    try {
      await QingReadLocal.request('/health');if(epoch!==hoverEpoch)return;
      const next=await target(()=>{if(epoch!==hoverEpoch)throw new DOMException('Stopped','AbortError');});
      if(epoch!==hoverEpoch)return;hoverTarget=next;
      await send(next,{type:'qingread:hover-enable',enabled:true});
      if(epoch===hoverEpoch)say('按住 Alt，將滑鼠停在英文單字上。');
    }catch(error){if(epoch===hoverEpoch){void disableHover();say(mediaError(error));}}
  };
  setInterval(async()=>{
    if(!hoverTarget || hoverLookup)return;
    const current=hoverTarget,epoch=hoverEpoch,lookup={controller:new AbortController()};
    hoverLookup=lookup;
    const isCurrent=()=>current===hoverTarget && epoch===hoverEpoch && hoverLookup===lookup;
    try {
      const result=await send(current,{type:'qingread:hover-read'});
      if(!isCurrent() || !result?.word || result.version===hoverVersion)return;hoverVersion=result.version;
      const answer=await QingReadLocal.request('/explain',{body:{text:result.word,source:'en'},managed:true,signal:lookup.controller.signal});
      if(isCurrent())await send(current,{type:'qingread:hover-show',version:result.version,text:answer.text});
    }catch(error){if(isCurrent() && error.name!=='AbortError')say(mediaError(error));}
    finally{if(hoverLookup===lookup)hoverLookup=null;}
  },600);
  chrome.tabs.onActivated.addListener(info=>{
    if(session && (!Number.isInteger(session.windowId) || info.windowId===session.windowId))stop('切換分頁，已停止字幕。');
    if(!Number.isInteger(hoverTarget?.windowId) || info.windowId===hoverTarget.windowId)void disableHover();
  });
  chrome.tabs.onUpdated.addListener((id,change)=>{if(change.status==='loading'||change.url){if(session?.tabId===id)stop('來源頁面已變更，已停止字幕。');if(hoverTarget?.tabId===id)void disableHover();}});
  chrome.tabs.onRemoved?.addListener(id=>{if(session?.tabId===id)stop('來源分頁已關閉，已停止字幕。');if(hoverTarget?.tabId===id)void disableHover();});
  window.addEventListener('pagehide',()=>{stop();void disableHover();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){if(session)stop('側邊欄已隱藏，已停止字幕。');void disableHover();}});
})();
