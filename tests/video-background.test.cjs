const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../extension/video-offscreen.js'),'utf8');
const target={tabId:7,windowId:3,documentId:'document-7'};
const config={engine:'chrome',source:'en',mode:'captions',terms:false,bilingual:true,glossary:[]};
function captureWorker({granted=true,active=7,nativeError,queryError,captureStates=[[]]}={}){
 let listener,now=0,polls=0;const queries=[],captures=[],warnings=[];
 const chrome={
  runtime:{id:'ext',getURL:f=>'chrome-extension://ext/'+f,onInstalled:{addListener(){}},onStartup:{addListener(){}},onMessage:{addListener:fn=>listener=fn}},
  sidePanel:{setPanelBehavior:async()=>{}},action:{onClicked:{addListener(){}}},
  tabs:{query:async query=>{queries.push(query);if(queryError)throw new Error('No window with id');return [{id:typeof active==='function'?active(queries.length):active}];}},
  permissions:{contains:async()=>granted},
  tabCapture:{getCapturedTabs:async()=>captureStates[Math.min(polls++,captureStates.length-1)],getMediaStreamId:async options=>{captures.push(options);if(nativeError)throw new Error(nativeError);return 'stream';}}
 };
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/background.js'),'utf8'),{chrome,importScripts(){},Date:{now:()=>now},setTimeout:(fn,ms)=>{now+=ms;fn();},console:{warn:(...args)=>warnings.push(args)}});
 const call=(message={type:'qingread:capture',tabId:7,windowId:3},sender={id:'ext',url:'chrome-extension://ext/panel.html'})=>{
  let resolve;const result=new Promise(r=>resolve=r);const accepted=listener(message,sender,resolve);
  return accepted?result:Promise.resolve(undefined);
 };
 return {call,queries,captures,warnings};
}

test('audio capture validates the source window instead of whichever window is current',async()=>{
 const h=captureWorker();assert.equal((await h.call()).streamId,'stream');
 assert.deepEqual(JSON.parse(JSON.stringify(h.queries)),[{active:true,windowId:3}]);
 assert.deepEqual(JSON.parse(JSON.stringify(h.captures)),[{targetTabId:7}]);
});

test('audio capture rejects missing sources, changed tabs, missing permission and untrusted senders before native capture',async()=>{
 for(const [options,message,code] of [
  [{},{type:'qingread:capture',tabId:7},'CAPTURE_TARGET'],
  [{active:8},undefined,'CAPTURE_TARGET'],[{queryError:true},undefined,'CAPTURE_TARGET'],[{granted:false},undefined,'CAPTURE_PERMISSION']
 ]){
  const h=captureWorker(options);assert.equal((await h.call(message)).code,code);assert.equal(h.captures.length,0);
 }
 const h=captureWorker();
 assert.equal(await h.call(undefined,{id:'ext',url:'https://video.test/'}),undefined);
 assert.equal(h.queries.length,0);
});

test('native capture errors distinguish toolbar invocation, an active stream and unknown failures',async()=>{
 for(const [nativeError,code,word] of [
  ['Extension has not been invoked for the current page (see activeTab permission).','CAPTURE_INVOKE',/工具列/],
  ['Cannot capture a tab with an active stream.','CAPTURE_BUSY',/已有音訊擷取/],
  ['Unexpected native failure','CAPTURE_FAILED',/重新整理/]
 ]){
  const h=captureWorker({nativeError}),result=await h.call();
  assert.equal(result.code,code);assert.match(result.error,word);
  assert.ok(h.warnings[0].includes(nativeError));
 }
});

test('handoff capture waits for native release and rechecks the source before acquiring audio',async()=>{
 const message={type:'qingread:capture',tabId:7,windowId:3,waitForRelease:true};
 const h=captureWorker({captureStates:[[{tabId:7,status:'active'}],[]]});
 assert.equal((await h.call(message)).streamId,'stream');assert.equal(h.queries.length,2);assert.equal(h.captures.length,1);
 const changed=captureWorker({active:query=>query===1?7:8,captureStates:[[{tabId:7,status:'pending'}],[]]});
 assert.equal((await changed.call(message)).code,'CAPTURE_TARGET');assert.equal(changed.captures.length,0);
 const busy=captureWorker({captureStates:[[{tabId:7,status:'active'}]]});
 assert.equal((await busy.call(message)).code,'CAPTURE_BUSY');assert.equal(busy.captures.length,0);
});
function offscreen({create,media,clock}={}){
 let listener;const calls=[],clocks=[],tracks=[],engines=[];
 const engine=()=>{const e={destroyed:0,destroy(){this.destroyed++;}};engines.push(e);return e;};
 const context={AbortController,DOMException,setTimeout,clearTimeout,crypto,Promise,
  chrome:{runtime:{id:'ext',getURL:file=>'chrome-extension://ext/'+file,onMessage:{addListener:fn=>listener=fn},sendMessage:async msg=>{calls.push(msg);return msg.action==='media'?{ok:true}:msg.action==='capture'?{streamId:'stream'}:{ok:true};}}},
  QingReadLocal:{TIMEOUT_MS:1000,cancellationText:()=>'',request:async()=>({video_inference:true}),translator:()=>engine()},
  QingReadCaptions:{createCueBuffer:()=>({})},QingReadSpeech:{createLatestBuffer:()=>({clear(){}})},QingReadVideoPipeline:{create:()=>({captions(){},speech(){},watchSpeech(){}})},
  Translator:{create:create||async function(){return engine();}},
  Worker:clock||class{constructor(){clocks.push(this);}terminate(){this.terminated=true;}},
  navigator:{mediaDevices:{getUserMedia:media||(async()=>{const t={stopped:false,stop(){this.stopped=true;},addEventListener(){}};tracks.push(t);return {getTracks:()=>[t]};})}},
  AudioContext:class{constructor(){this.audioWorklet={addModule:async()=>{}};this.destination={};}createMediaStreamSource(){return {connect(){}};}async resume(){}async close(){this.closed=true;}},
  AudioWorkletNode:class{constructor(){this.port={};}connect(){}}
 };
 vm.runInNewContext(source,context);
 const call=(action,data={})=>new Promise(resolve=>listener({type:'qingread:video-offscreen',action,...data},{id:'ext',url:'chrome-extension://ext/background.js'},resolve));
 return {call,calls,clocks,tracks,engines};
}
test('offscreen handoff prepares without touching source, commits once and releases resources on stop',async()=>{
 const h=offscreen();
 await h.call('prepare',{config,target,ticket:'one'});
 assert.equal(h.calls.some(x=>x.action==='media'),false);
 const state=await h.call('commit',{ticket:'one'});assert.equal(state.active,true);
 assert.equal(h.calls.filter(x=>x.message?.type==='qingread:media-start').length,1);
 assert.equal(h.calls.find(x=>x.message?.type==='qingread:media-start').message.handoff,'one');
 assert.match((await h.call('commit',{ticket:'one'})).error,/逾時/);
 await h.call('stop');assert.equal(h.engines[0].destroyed,1);assert.equal(h.clocks[0].terminated,true);
 assert.equal((await h.call('status')).active,false);
});
test('failed caption commit restores the original page owner before releasing the background engine',async()=>{
 const h=offscreen({clock:class{constructor(){throw new Error('Worker could not start');}}});
 await h.call('prepare',{config,target,ticket:'original'});
 assert.match((await h.call('commit',{ticket:'original'})).error,/Worker/);
 const messages=h.calls.filter(call=>call.action==='media').map(call=>call.message);
 assert.equal(messages.length,2);
 assert.equal(messages[0].handoff,'original');
 assert.equal(messages[1].session,'original');
 assert.equal(messages[1].handoff,messages[0].session);
 assert.equal(messages[1].background,false);
 assert.equal(h.engines[0].destroyed,1);
 assert.equal((await h.call('status')).active,false);
});
test('cancelling a matching handoff ticket stops the committed background session',async()=>{
 const h=offscreen();
 await h.call('prepare',{config,target,ticket:'original'});
 await h.call('commit',{ticket:'original'});
 await h.call('cancel-prepare',{ticket:'other'});
 assert.equal((await h.call('status')).active,true);
 await h.call('cancel-prepare',{ticket:'original'});
 assert.equal((await h.call('status')).active,false);
 assert.equal(h.engines[0].destroyed,1);
});
test('caption pipeline reports read and translation errors through its shared error handler',async()=>{
 const core=require('../extension/core.js');
 for(const stage of ['read','translate']){
  const stopped=[];
  const cue={text:'A useful sentence.',version:1,timelineVersion:1};
  const session={reading:false,busy:false,controller:new AbortController(),cues:{observe(){},take:()=>cue},cacheEnabled:false,
   translator:{translate:async()=>{throw new Error('模型連線中斷。');}}};
  let current=session;
  const context={QingReadCore:core,performance,Date,Promise};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/video-pipeline.js'),'utf8'),context);
  const pipeline=context.QingReadVideoPipeline.create({
   getSession:()=>current,stop:message=>{stopped.push(message);current=null;},say(){},
   send:async()=>{if(stage==='read')throw new DOMException('unavailable','PageReadError');return cue;},
   waitForEngine:async promise=>promise
  });
  await pipeline.captions(session);
  assert.equal(stopped.length,1);
  assert.match(stopped[0],stage==='read'?/網頁回應/:/模型連線中斷/);
 }
});
test('cancelling background model preparation destroys a late Chrome translator without starting captions',async()=>{
 let finish,started;const ready=new Promise(r=>started=r);let destroyed=0;
 const h=offscreen({create:()=>new Promise(resolve=>{finish=resolve;started();})});
 const pending=h.call('prepare',{config,target,ticket:'one'});await ready;
 await h.call('cancel-prepare');finish({destroy(){destroyed++;}});
 assert.ok((await pending).error);await new Promise(r=>setImmediate(r));
 assert.equal(destroyed,1);assert.equal(h.calls.some(x=>x.action==='media'),false);
});
test('source navigation cancels a background engine that is still preparing',async()=>{
 let started;const ready=new Promise(r=>started=r);
 const h=offscreen({create:({signal})=>new Promise((resolve,reject)=>{started();signal.addEventListener('abort',()=>reject(new DOMException('Stopped','AbortError')));})});
 const pending=h.call('prepare',{config,target,ticket:'one'});await ready;
 await h.call('event',{kind:'updated',tabId:7});assert.ok((await pending).error);
 assert.equal((await h.call('status')).preparing,false);
});
test('background speech stops tracks and clock, while unrelated browser events leave it running',async()=>{
 const h=offscreen();await h.call('prepare',{config:{...config,mode:'speech'},target,ticket:'one'});
 await h.call('commit',{ticket:'one'});
 await h.call('event',{kind:'activated',windowId:99,tabId:8});assert.equal((await h.call('status')).active,true);
 await h.call('event',{kind:'removed',tabId:99});assert.equal((await h.call('status')).active,true);
 await h.call('event',{kind:'activated',windowId:3,tabId:8});
 assert.equal(h.tracks[0].stopped,true);assert.equal(h.clocks[0].terminated,true);assert.equal((await h.call('status')).active,false);
});
test('stopping while background audio acquisition is pending stops late tracks without starting an audio graph',async()=>{
 let finish,started;const ready=new Promise(r=>started=r);let stopped=false;
 const h=offscreen({media:()=>new Promise(resolve=>{finish=resolve;started();})});
 await h.call('prepare',{config:{...config,mode:'speech'},target,ticket:'one'});
 const pending=h.call('commit',{ticket:'one'});await ready;await h.call('stop');
 finish({getTracks:()=>[{stop(){stopped=true;}}]});assert.ok((await pending).error);
 assert.equal(stopped,true);assert.equal(h.clocks.length,0);
});
test('background broker refuses web/content credential requests and stale overlay stops',async()=>{
 let listener;const calls=[];
 const chrome={runtime:{id:'ext',getURL:f=>'chrome-extension://ext/'+f,getContexts:async()=>[{}],sendMessage:async msg=>{calls.push(msg);return {active:true,id:'current',target};},onMessage:{addListener:fn=>listener=fn}},tabs:{onActivated:{addListener(){}},onUpdated:{addListener(){}},onRemoved:{addListener(){}}}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/video-background.js'),'utf8'),{chrome,setTimeout,Promise,
  captureTabAudio:async source=>{calls.push({captureTarget:source});return {streamId:'shared-capture'};},
  QingReadLocal:{savedToken:async()=>{throw new Error('Must not read credentials');}}});
 const call=(message,sender)=>new Promise(resolve=>listener(message,sender,resolve));
 for(const sender of [{id:'ext',url:'https://video.test/',tab:{id:7}},{id:'other',url:'chrome-extension://ext/video-offscreen.html'}]){
  assert.ok((await call({type:'qingread:video-host',action:'token'},sender)).error);
  assert.ok((await call({type:'qingread:video-control',action:'stop'},sender)).error);
 }
 assert.ok((await call({type:'qingread:video-stop-overlay',session:'current'},{id:'ext',tab:{id:7},documentId:'old-document'})).error);
 assert.ok((await call({type:'qingread:video-stop-overlay',session:'old'},{id:'ext',tab:{id:7},documentId:'document-7'})).error);
 assert.equal(calls.some(x=>x.action==='stop'),false);
 await call({type:'qingread:video-stop-overlay',session:'current'},{id:'ext',tab:{id:7},documentId:'document-7'});
 assert.equal(calls.filter(x=>x.action==='stop').length,1);
 const captured=await call({type:'qingread:video-host',action:'capture',target},{id:'ext',url:'chrome-extension://ext/video-offscreen.html'});
 assert.equal(captured.streamId,'shared-capture');
 assert.deepEqual(JSON.parse(JSON.stringify(calls.find(x=>x.captureTarget).captureTarget)),{...target,waitForRelease:true});
});
