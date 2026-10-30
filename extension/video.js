'use strict';
(() => {
  const el = id => document.getElementById(id);
  let session = null, hoverTarget = null, hoverBusy = false, hoverVersion = -1, hoverEpoch = 0;
  const say = text => { if (el('video-status').textContent !== text) el('video-status').textContent = text; };
  const send = (target,message) => chrome.tabs.sendMessage(target.tabId,message,{documentId:target.documentId}).catch(()=>{throw new DOMException('Receiver unavailable','PageReadError');});
  let accessError = null;
  const mediaError = error => /^(Page|Extension)/.test(error.name) ? QingReadCore.errorText(error) : error.name === 'Error' ? error.message : QingReadCore.errorText(error);
  el('video-access').onclick = () => {document.querySelector('[data-view=web]').click();if(accessError)showFailure(accessError,{stage:'page-read'});};
  async function target() {
    const tab = await activeTab();
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
    el('video-start').disabled=false; el('video-stop').disabled=true;
    el('video-mode').disabled=false; el('video-bilingual').disabled=false; say(reason);
  }
  function live(s) { if(session!==s) throw new DOMException('Stopped','AbortError'); }
  function captionStatus(s) {
    const cue = s.latestCue;
    if (!cue) return;
    const elapsed = s.busy ? performance.now() - s.busySince : 0;
    const detail = [s.lastTranslationMs === undefined ? '' : `最近翻譯 ${(s.lastTranslationMs/1000).toFixed(1)} 秒`,
      s.skipped ? `已略過 ${s.skipped} 段過期結果` : ''].filter(Boolean).join('；');
    let status;
    if (s.busy && elapsed >= 2000) status = `正在等翻譯（${Math.floor(elapsed/1000)} 秒）；影片持續播放，完成後只顯示仍相關的字幕。`;
    else if (cue.display?.visible && cue.paused) status = '影片已暫停，可閱讀目前的字幕。';
    else if (cue.display?.visible && cue.display.current) status = '舒適閱讀中：整段更新、保留閱讀時間。';
    else if (cue.display?.visible) status = '正在追上目前字幕；暫時保留上一段供閱讀。';
    else if (s.busy) status = '正在翻譯最新字幕；影片持續播放。';
    else if (cue.text) status = '等候下一段可用譯文；目前顯示影片原字幕。';
    else status = '等候原文字幕；請確認播放器字幕已開啟。';
    say(status + (detail ? `（${detail}）` : ''));
  }
  async function display(s,text,version,started,timelineVersion) {
    let output = s.cacheEnabled ? s.cache.get(text) : undefined;
    if (output === undefined) {
      output=await waitForEngine(s.translator.translate(text,{signal:s.controller.signal}),s); live(s);
      if (typeof output !== 'string' || !output.trim() || output.length > 12000) throw new Error('模型沒有回傳有效字幕。');
      if(s.cacheEnabled)s.cache.set(text, output);
      if (s.cache.size > 32) s.cache.delete(s.cache.keys().next().value);
    }
    const translated=QingReadCore.applyGlossary(s.terms ? QingReadCore.localize(output) : output, s.glossary);
    if(Date.now()-started>QingReadSpeech.POLICY.maxResultAgeMs && s.mode==='speech') return {applied:false};
    return send(s.target,{type:'qingread:media-show',session:s.id,original:text,text:translated,version,mode:s.mode,timelineVersion});
  }
  async function captions(s) {
    if(s.reading) return;
    s.reading=true;
    try {
      const cue=await send(s.target,{type:'qingread:media-read',session:s.id}); live(s);
      s.latestCue = cue;
      s.cues.observe(cue, performance.now());
      captionStatus(s);
    } catch(error) { if(session===s) stop(mediaError(error)); }
    finally {s.reading=false;}
    if(session!==s || s.busy)return;
    const cue=s.cues.take(performance.now());
    if(!cue)return;
    s.busy=true; s.busySince=performance.now(); captionStatus(s);
    try {
      const result=await display(s,cue.text.slice(0,6000),cue.version,Date.now(),cue.timelineVersion); live(s);
      s.lastTranslationMs=performance.now()-s.busySince;
      if(result?.applied===false)s.skipped++;
    } catch(error) { if(session===s) stop(mediaError(error)); }
    finally {s.busy=false;if(session===s)captionStatus(s);}
  }
  function wav(samples) {
    const data=new ArrayBuffer(44+samples.length*2), view=new DataView(data);
    const write=(offset,text)=>{for(let i=0;i<text.length;i++)view.setUint8(offset+i,text.charCodeAt(i));};
    write(0,'RIFF');view.setUint32(4,data.byteLength-8,true);write(8,'WAVEfmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,16000,true);view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);write(36,'data');view.setUint32(40,samples.length*2,true);
    for(let i=0;i<samples.length;i++)view.setInt16(44+i*2,Math.round(Math.max(-1,Math.min(1,samples[i]))*32767),true);
    return data;
  }
  function speechStatus(s,stage){
    if(s.speechPaused)stage='影片已暫停，等候播放。';
    const detail=s.speechTiming?`最近辨識 ${s.speechTiming.recognition.toFixed(1)} 秒＋翻譯 ${s.speechTiming.translation.toFixed(1)} 秒；${s.speechTiming.total>4?'處理慢於每 4 秒的輸入，會略過舊片段':'目前處理速度可跟上輸入'}`:'';
    say(`${stage}${detail?`（${detail}）`:''} 已略過 ${s.speechQueue.dropped+s.dropped} 段；最多保留最新一段等待處理。`);
  }
  function syncSpeechTimeline(s,state){
    s.speechPaused=state.paused;
    if(s.speechTimeline===undefined){s.speechTimeline=state.timelineVersion;return true;}
    if(s.speechTimeline===state.timelineVersion)return true;
    s.speechTimeline=state.timelineVersion;s.speechQueue.clear();s.lastSpeech=null;
    s.speechAudioEpoch=(s.speechAudioEpoch||0)+1;
    s.processor?.port.postMessage?.({type:'reset',epoch:s.speechAudioEpoch});
    return false;
  }
  async function watchSpeech(s){
    if(s.watchReading)return;s.watchReading=true;
    try{
      const state=await send(s.target,{type:'qingread:media-read',session:s.id});live(s);
      const paused=s.speechPaused;
      if(!syncSpeechTimeline(s,state)||paused!==state.paused)speechStatus(s,'正在聆聽此分頁。');
    }catch(error){if(session===s)stop(mediaError(error));}finally{s.watchReading=false;}
  }
  async function speech(s,frame) {
    if(!(frame?.samples instanceof Float32Array)||frame.samples.length!==72000)return;
    if(frame.epoch!==(s.speechAudioEpoch||0)){s.dropped++;return;}
    const capturedAt=Date.now();
    try{
      const state=await send(s.target,{type:'qingread:media-read',session:s.id});live(s);
      if(!syncSpeechTimeline(s,state)||frame.epoch!==(s.speechAudioEpoch||0)){s.dropped++;return;}
      if(state?.paused){s.speechQueue.clear();s.lastSpeech=null;return;}
      s.speechQueue.offer({...frame,capturedAt,state});
      if(s.busy)speechStatus(s,'正在辨識與翻譯。');
      void drainSpeech(s);
    }catch(error){if(session===s)stop(mediaError(error));}
  }
  async function drainSpeech(s){
    if(session!==s||s.busy)return;
    const frame=s.speechQueue.take(Date.now());if(!frame)return;
    s.busy=true;const started=performance.now();let recognition=0,translation=0,timed=false;
    speechStatus(s,'正在辨識。');
    try {
      const state=await send(s.target,{type:'qingread:media-read',session:s.id});live(s);
      if(state?.paused||state.timelineVersion!==frame.state.timelineVersion){s.lastSpeech=null;s.dropped++;return;}
      const result=await QingReadLocal.request('/speech?language='+encodeURIComponent(s.source),{body:wav(frame.samples),signal:s.controller.signal});live(s);
      recognition=(performance.now()-started)/1000;
      const current=await send(s.target,{type:'qingread:media-read',session:s.id});live(s);
      if(current.paused||current.timelineVersion!==state.timelineVersion||Date.now()-frame.capturedAt>QingReadSpeech.POLICY.maxResultAgeMs){s.lastSpeech=null;s.dropped++;return;}
      if(result.text){
        const prior=s.lastSpeech;
        const contiguous=prior&&prior.sequence+1===frame.sequence&&prior.timeline===state.timelineVersion&&Math.abs(frame.state.time-prior.time-4)<1;
        const text=QingReadSpeech.trimOverlap(prior?.text,result.text,{contiguous,overlapMs:frame.overlapMs,segments:result.segments});
        s.lastSpeech={text:result.text,sequence:frame.sequence,timeline:state.timelineVersion,time:frame.state.time};
        if(text.trim()){
          speechStatus(s,'正在翻譯。');const translating=performance.now();
          const shown=await display(s,text,0,frame.capturedAt,state.timelineVersion);live(s);
          translation=(performance.now()-translating)/1000;timed=true;if(shown?.applied===false)s.dropped++;
        }
      }else s.lastSpeech=null;
    }catch(error){if(session===s)stop(mediaError(error));}
    finally{
      s.busy=false;
      if(session===s){if(timed)s.speechTiming={recognition,translation,total:(performance.now()-started)/1000};speechStatus(s,'正在聆聽此分頁。');void drainSpeech(s);}
    }
  }
  el('video-start').onclick=async()=>{
    if(session)return;
    if(running){say('請先停止網頁或文字翻譯，再開始字幕。');return;}
    if(!ready){say('請先確認所選翻譯引擎與語言組合可用。');return;}
    const s={id:crypto.randomUUID(),controller:new AbortController(),source:el('source').value,mode:el('video-mode').value,busy:false,reading:false,dropped:0,glossary:glossaryRules.map(rule=>[...rule]),terms:el('terms').checked,
      cues:QingReadCaptions.createCueBuffer(),speechQueue:QingReadSpeech.createLatestBuffer(),cache:new Map(),cacheEnabled:el('engine').value!=='local',bilingual:el('video-bilingual').checked,skipped:0};session=s;
    el('video-access').hidden=true;accessError=null;
    el('video-start').disabled=true;el('video-stop').disabled=false;
    el('video-mode').disabled=true;el('video-bilingual').disabled=true;say('正在準備影片字幕…');
    try {
      // All APIs requiring a user gesture are initiated before the first await.
      const permission=(s.mode==='speech'?chrome.permissions.request({permissions:['tabCapture']}):Promise.resolve(true)).then(granted=>({granted}),error=>({error}));
      s.creation=Promise.resolve(el('engine').value==='local'?QingReadLocal.translator(s.source):globalThis.Translator?.create({sourceLanguage:s.source,targetLanguage:'zh-Hant',signal:s.controller.signal})).then(translator=>({translator}),error=>({error}));
      // Detect page access failure before waiting on model downloads.
      s.target=await target();live(s);
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
    }catch(error){
      if(session===s){stop(mediaError(error));if(error.name==='PageAccessError'){accessError=error;el('video-access').hidden=false;}}
      else s.translator?.destroy();
    }finally{if(!s.translator)void s.creation?.then(result=>result.translator?.destroy());}
  };
  el('video-stop').onclick=()=>stop();
  el('start').addEventListener('click',()=>{if(session)stop('開始網頁翻譯，已停止字幕。');});
  el('text-start').addEventListener('click',()=>{if(session)stop('開始文字翻譯，已停止字幕。');});
  el('test-engine').addEventListener('click',()=>{if(session)stop('測試翻譯引擎，已停止字幕。');});
  async function disableHover(){hoverEpoch++;const old=hoverTarget;hoverTarget=null;hoverVersion=-1;el('hover').checked=false;if(old)await send(old,{type:'qingread:hover-enable',enabled:false}).catch(()=>{});}
  el('hover').onchange=async()=>{
    if(!el('hover').checked){await disableHover();return;}
    const epoch=++hoverEpoch;
    try {await QingReadLocal.request('/health');if(epoch!==hoverEpoch)return;const next=await target();if(epoch!==hoverEpoch)return;hoverTarget=next;await send(hoverTarget,{type:'qingread:hover-enable',enabled:true});say('按住 Alt，將滑鼠停在英文單字上。');}
    catch(error){await disableHover();say(error.message);}
  };
  setInterval(async()=>{
    if(!hoverTarget || hoverBusy)return;
    hoverBusy=true;const current=hoverTarget;
    try {
      const result=await send(current,{type:'qingread:hover-read'});
      if(!result?.word || result.version===hoverVersion)return;hoverVersion=result.version;
      const answer=await QingReadLocal.request('/explain',{body:{text:result.word,source:'en'},managed:true});
      if(current===hoverTarget)await send(current,{type:'qingread:hover-show',version:result.version,text:answer.text});
    }catch(error){say(error.message);}finally{hoverBusy=false;}
  },600);
  chrome.tabs.onActivated.addListener(info=>{
    if(session && (!Number.isInteger(session.target?.windowId) || info.windowId===session.target.windowId))stop('切換分頁，已停止字幕。');
    if(!Number.isInteger(hoverTarget?.windowId) || info.windowId===hoverTarget.windowId)void disableHover();
  });
  chrome.tabs.onUpdated.addListener((id,change)=>{if(change.status==='loading'){if(session?.target?.tabId===id)stop('頁面重新載入，已停止字幕。');if(hoverTarget?.tabId===id)void disableHover();}});
  window.addEventListener('pagehide',()=>{stop();void disableHover();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden){if(session)stop('側邊欄已隱藏，已停止字幕。');void disableHover();}});
})();
