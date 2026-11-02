'use strict';
(() => {
  let session=null, prepared=null, preparing=null, preparingTarget=null, status='背景字幕尚未啟動。';
  const host=async(action,data={})=>{
    const result=await chrome.runtime.sendMessage({type:'qingread:video-host',action,...data});
    if(result?.error)throw new Error(result.error);
    return result;
  };
  // Offscreen documents only expose runtime; never send credentials to a website.
  QingReadLocal.savedToken=async()=> (await host('token')).token;
  const send=(target,message)=>host('media',{target,message});
  const say=text=>{status=text;};
  function snapshot(){return {active:Boolean(session),preparing:Boolean(prepared||preparing),id:session?.id,target:session?.target,status,mode:session?.mode};}
  function waitForEngine(promise,s){
    return new Promise((resolve,reject)=>{
      const abort=()=>reject(new DOMException('Stopped','AbortError'));
      const timer=setTimeout(()=>reject(new Error('字幕翻譯逾時。')),QingReadLocal.TIMEOUT_MS);
      s.controller.signal.addEventListener('abort',abort,{once:true});
      Promise.resolve(promise).then(resolve,reject).finally(()=>{clearTimeout(timer);s.controller.signal.removeEventListener('abort',abort);});
      if(s.controller.signal.aborted)abort();
    });
  }
  function idle(){void host('idle').catch(()=>{});}
  function discardPrepared(){
    preparing?.abort();preparing=null;preparingTarget=null;
    if(prepared){clearTimeout(prepared.timer);prepared.translator.destroy();prepared=null;}
  }
  function stop(reason='字幕已停止。'){
    const old=session;session=null;say(reason);
    if(old){
      old.clock?.terminate();old.controller.abort();old.speechQueue.clear();
      old.stream?.getTracks().forEach(track=>track.stop());void old.audio?.close().catch(()=>{});
      void send(old.target,{type:'qingread:media-stop',session:old.id}).catch(()=>{});
      Promise.resolve(old.translator.destroy()).then(results=>{
        if(!session&&status===reason&&old.translator.managed)say(reason+' '+QingReadLocal.cancellationText(results));
      }).catch(()=>{}).finally(idle);
    }else idle();
  }
  const pipeline=QingReadVideoPipeline.create({getSession:()=>session,stop,say,send,waitForEngine});
  async function prepare(config,target,ticket){
    if(session||prepared||preparing)throw new Error('已有背景字幕工作，請先停止再收合。');
    const controller=new AbortController();preparing=controller;preparingTarget=target;
    let translator;
    try{
      if(config.engine==='local'){
        await QingReadLocal.request('/health',{signal:controller.signal});
        translator=QingReadLocal.translator(config.source);
      }else{
        if(!globalThis.Translator)throw new Error('此 Chrome 無法在背景使用語言包；側欄字幕會繼續，請更新瀏覽器後再試。');
        const creation=Promise.resolve(Translator.create({sourceLanguage:config.source,targetLanguage:'zh-Hant',signal:controller.signal}));
        void creation.then(value=>{if(controller.signal.aborted)value.destroy();},()=>{});
        translator=await waitForEngine(creation,{controller});
      }
      if(preparing!==controller||controller.signal.aborted){translator?.destroy();throw new DOMException('Stopped','AbortError');}
      prepared={config,target,ticket,translator};
      prepared.timer=setTimeout(()=>{discardPrepared();idle();},20000);
      return {ready:true};
    }catch(error){
      const cancelled=controller.signal.aborted;controller.abort();idle();
      if(config.engine==='chrome'&&!cancelled)throw new Error('目前 Chrome 無法在背景啟動這組語言包，側欄字幕仍會繼續。可先停止字幕，改選已配對的本機模型後重新開始並收合。');
      throw error;
    }
    finally{if(preparing===controller){preparing=null;preparingTarget=null;}}
  }
  async function commit(ticket){
    if(!prepared||prepared.ticket!==ticket)throw new Error('字幕交接已逾時，請重新開始字幕。');
    const p=prepared;prepared=null;clearTimeout(p.timer);
    const s={...p.config,id:crypto.randomUUID(),target:p.target,tabId:p.target.tabId,windowId:p.target.windowId,translator:p.translator,controller:new AbortController(),busy:false,reading:false,dropped:0,skipped:0,
      cues:QingReadCaptions.createCueBuffer(),speechQueue:QingReadSpeech.createLatestBuffer(),cache:new Map(),cacheEnabled:p.config.engine!=='local'};
    session=s;
    const live=()=>{if(session!==s)throw new DOMException('Stopped','AbortError');};
    try{
      const result=await send(s.target,{type:'qingread:media-start',session:s.id,mode:s.mode,bilingual:s.bilingual,background:true});live();
      if(!result?.ok)throw new Error(result?.error||'找不到影片。');
      if(s.mode==='speech'){
        const capture=await host('capture',{target:s.target});live();
        const stream=await navigator.mediaDevices.getUserMedia({audio:{mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:capture.streamId}},video:false});
        if(session!==s){stream.getTracks().forEach(t=>t.stop());live();}s.stream=stream;
        s.audio=new AudioContext();await s.audio.audioWorklet.addModule('audio-worklet.js');live();
        const source=s.audio.createMediaStreamSource(stream),processor=new AudioWorkletNode(s.audio,'qingread-audio');
        s.processor=processor;source.connect(s.audio.destination);source.connect(processor);processor.connect(s.audio.destination);
        processor.port.onmessage=event=>{if(session===s)void pipeline.speech(s,event.data);};
        stream.getTracks().forEach(track=>track.addEventListener('ended',()=>{if(session===s)stop('音訊擷取已結束。');}));
        await s.audio.resume();live();
      }
      s.clock=new Worker('video-clock.js');
      s.clock.onmessage=()=>{if(session===s)void (s.mode==='captions'?pipeline.captions(s):pipeline.watchSpeech(s));};
      s.clock.onerror=()=>{if(session===s)stop('背景字幕計時器中斷，請重新開始。');};
      say('字幕正在背景執行，可全螢幕觀看；影片右上角可停止。');return snapshot();
    }catch(error){if(session===s)stop(error.message);throw error;}
  }
  chrome.runtime.onMessage.addListener((message,sender,reply)=>{
    if(message.type!=='qingread:video-offscreen'||sender.id!==chrome.runtime.id||sender.url!==chrome.runtime.getURL('background.js'))return;
    void (async()=>{
      if(message.action==='prepare')return prepare(message.config,message.target,message.ticket);
      if(message.action==='commit')return commit(message.ticket);
      if(message.action==='status')return snapshot();
      if(message.action==='cancel-prepare'){discardPrepared();idle();return snapshot();}
      if(message.action==='stop'){discardPrepared();stop(message.reason);return snapshot();}
      if(message.action==='event'){
        const target=session?.target||prepared?.target||preparingTarget;
        if(target&&((message.kind==='activated'&&message.windowId===target.windowId&&message.tabId!==target.tabId)||(message.kind!=='activated'&&message.tabId===target.tabId))){discardPrepared();stop('來源頁面已變更，已停止字幕。');}
        return snapshot();
      }
      throw new Error('不支援此字幕操作。');
    })().then(reply,error=>reply({error:error.message}));return true;
  });
})();
