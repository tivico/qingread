'use strict';
// Caption/speech processing shared by the panel and its offscreen owner.
globalThis.QingReadVideoPipeline = {
 errorText(error) {
  return /^(Page|Extension)/.test(error.name) ? QingReadCore.errorText(error) :
    error.name === 'Error' ? error.message : QingReadCore.errorText(error);
 },
 timingText(timing) {
  const fields = [['waitMs','送翻前等待'],['translationMs','翻譯往返'],['queueMs','助手排隊'],
    ['prepareMs','模型檢查'],['loadMs','模型載入'],['promptMs','模型讀文'],['generationMs','生成譯文']];
  const parts = fields.filter(([key])=>typeof timing[key]==='number'&&Number.isFinite(timing[key])&&timing[key]>=0)
    .map(([key,label])=>`${label} ${(timing[key]/1000).toFixed(2)} 秒`);
  if(timing.cached)parts.push('本筆使用快取');
  return parts.join(' · ');
 },
 create({getSession,stop,say,send,waitForEngine}) {
  const mediaError = error => QingReadVideoPipeline.errorText(error);
  function live(s) { if(getSession()!==s) throw new DOMException('Stopped','AbortError'); }
  function captionStatus(s) {
    const cue = s.latestCue;
    if (!cue) return;
    const elapsed = s.busy ? performance.now() - s.busySince : 0;
    const detail = [s.lastTranslationMs === undefined ? '' : `最近翻譯 ${(s.lastTranslationMs/1000).toFixed(1)} 秒`,
      s.accepted || s.skipped ? `已收到 ${s.accepted || 0} 筆譯文，已略過 ${s.skipped || 0} 筆舊結果` : ''].filter(Boolean).join('；');
    let status;
    if (s.busy && elapsed >= 2000) status = `正在等翻譯（${Math.floor(elapsed/1000)} 秒）；影片持續播放，完成後只顯示仍相關的字幕。`;
    else if (cue.display?.visible && cue.paused) status = '影片已暫停，可閱讀目前的字幕。';
    else if (cue.display?.visible && cue.display.current) status = '舒適閱讀中：整段更新、保留閱讀時間。';
    else if (cue.display?.visible) status = '正在追上目前字幕；暫時保留上一段供閱讀。';
    else if (s.busy) status = '正在翻譯最新字幕；影片持續播放。';
    else if (cue.text) status = '等候下一段可用譯文；目前顯示影片原字幕。';
    else status = '等候原文字幕；請確認播放器字幕已開啟。';
    say(status + (detail ? `（${detail}）` : ''),s.lastCaptionTiming);
  }
  async function display(s,text,version,started,timelineVersion) {
    let output = s.cacheEnabled ? s.cache.get(text) : undefined;
    if (output === undefined) {
      output=await waitForEngine(s.translator.translate(text,{signal:s.controller.signal}),s); live(s);
      s.lastModelMetrics=s.translator.lastMetrics;
      if (typeof output !== 'string' || !output.trim() || output.length > 12000) throw new Error('模型沒有回傳有效字幕。');
      if(s.cacheEnabled)s.cache.set(text, output);
      if (s.cache.size > 32) s.cache.delete(s.cache.keys().next().value);
    }else s.lastModelMetrics={cached:true};
    const translated=QingReadCore.applyGlossary(s.terms ? QingReadCore.localize(output) : output, s.glossary);
    if(Date.now()-started>QingReadSpeech.POLICY.maxResultAgeMs && s.mode==='speech') return {applied:false};
    return send(s.target,{type:'qingread:media-show',session:s.id,original:text,text:translated,version,mode:s.mode,timelineVersion,
      allowRecent:s.mode==='captions'});
  }
  async function captions(s) {
    if(s.reading) return;
    s.reading=true;
    try {
      const cue=await send(s.target,{type:'qingread:media-read',session:s.id}); live(s);
      s.latestCue = cue;
      s.cues.observe(cue, performance.now());
      captionStatus(s);
    } catch(error) { if(getSession()===s) stop(mediaError(error)); }
    finally {s.reading=false;}
    if(getSession()!==s || s.busy)return;
    const cue=s.cues.take(performance.now(),s.captionLatencyMs || 0);
    if(!cue)return;
    s.busy=true; s.busySince=performance.now(); captionStatus(s);
    try {
      const result=await display(s,cue.text.slice(0,6000),cue.version,Date.now(),cue.timelineVersion); live(s);
      s.lastTranslationMs=performance.now()-s.busySince;
      s.lastCaptionTiming={...(cue.waitMs === undefined ? {} : {waitMs:cue.waitMs}),
        translationMs:s.lastTranslationMs,...s.lastModelMetrics};
      if(!s.lastModelMetrics?.cached)s.captionLatencyMs=s.captionLatencyMs === undefined ?
        s.lastTranslationMs : s.captionLatencyMs*.7+s.lastTranslationMs*.3;
      if(result?.applied===false)s.skipped++;
      else if(result?.applied===true)s.accepted=(s.accepted || 0)+1;
    } catch(error) { if(getSession()===s) stop(mediaError(error)); }
    finally {s.busy=false;if(getSession()===s)captionStatus(s);}
  }
  function wav(samples) {
    const data=new ArrayBuffer(44+samples.length*2), view=new DataView(data);
    const write=(offset,text)=>{for(let i=0;i<text.length;i++)view.setUint8(offset+i,text.charCodeAt(i));};
    write(0,'RIFF');view.setUint32(4,data.byteLength-8,true);write(8,'WAVEfmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,16000,true);view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);write(36,'data');view.setUint32(40,samples.length*2,true);
    for(let i=0;i<samples.length;i++)view.setInt16(44+i*2,Math.round(Math.max(-1,Math.min(1,samples[i]))*32767),true);
    return data;
  }
  function speechStatus(s,stage){
    if(s.speechBusySince!==undefined)stage='上一段語音仍在辨識，正在等候；只保留最新片段。';
    if(s.speechPaused)stage='影片已暫停，等候播放。';
    const detail=s.speechTiming?`最近辨識 ${s.speechTiming.recognition.toFixed(1)} 秒＋翻譯 ${s.speechTiming.translation.toFixed(1)} 秒；${s.speechTiming.total>4?'處理慢於每 4 秒的輸入，會略過舊片段':'目前處理速度可跟上輸入'}`:'';
    say(`${stage}${detail?`（${detail}）`:''} 已略過 ${s.speechQueue.dropped+s.dropped} 段；最多保留最新一段等待處理。`,
      s.speechTiming ? {translationMs:s.speechTiming.translation*1000,...s.lastModelMetrics} : undefined);
  }
  function syncSpeechTimeline(s,state){
    s.speechPaused=state.paused;
    if(s.speechTimeline===undefined){s.speechTimeline=state.timelineVersion;return true;}
    if(s.speechTimeline===state.timelineVersion)return true;
    s.speechTimeline=state.timelineVersion;s.speechQueue.clear();s.lastSpeech=null;s.speechRetryAt=0;s.speechBusySince=undefined;
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
      if(s.speechRetryAt)void drainSpeech(s);
    }catch(error){if(getSession()===s)stop(mediaError(error));}finally{s.watchReading=false;}
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
    }catch(error){if(getSession()===s)stop(mediaError(error));}
  }
  async function drainSpeech(s){
    if(getSession()!==s||s.busy)return;
    if(s.speechBusySince!==undefined&&Date.now()-s.speechBusySince>=QingReadSpeech.POLICY.busyTimeoutMs){
      stop('語音辨識持續忙碌，已停止字幕。請稍後重新開始；若仍無法恢復，請檢查本機助手。');return;
    }
    if(Date.now()<(s.speechRetryAt||0))return;
    const frame=s.speechQueue.take(Date.now());if(!frame)return;
    s.busy=true;const started=performance.now();let recognition=0,translation=0,timed=false;
    speechStatus(s,'正在辨識。');
    try {
      const state=await send(s.target,{type:'qingread:media-read',session:s.id});live(s);
      if(state?.paused||state.timelineVersion!==frame.state.timelineVersion){s.lastSpeech=null;s.dropped++;return;}
      const result=await QingReadLocal.request('/speech?language='+encodeURIComponent(s.source),{body:wav(frame.samples),signal:s.controller.signal});live(s);
      s.speechBusySince=undefined;s.speechRetryAt=0;
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
    }catch(error){
      if(getSession()===s){
        if(error.code==='SPEECH_BUSY'&&error.status===429){
          s.speechBusySince??=Date.now();s.speechRetryAt=Date.now()+QingReadSpeech.POLICY.busyRetryMs;s.lastSpeech=null;
          if(!s.speechQueue.pending)s.speechQueue.offer(frame);else s.dropped++;
        }else stop(mediaError(error));
      }
    }
    finally{
      s.busy=false;
      if(getSession()===s){if(timed)s.speechTiming={recognition,translation,total:(performance.now()-started)/1000};speechStatus(s,'正在聆聽此分頁。');void drainSpeech(s);}
    }
  }
  return {captions,speech,watchSpeech};
 }
};
