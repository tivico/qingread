const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../extension/video-offscreen.js'),'utf8');
const target={tabId:7,windowId:3,documentId:'document-7'};
const config={engine:'chrome',source:'en',mode:'captions',terms:false,bilingual:true,glossary:[]};
function offscreen({create,media}={}){
 let listener;const calls=[],clocks=[],tracks=[],engines=[];
 const engine=()=>{const e={destroyed:0,destroy(){this.destroyed++;}};engines.push(e);return e;};
 const context={AbortController,DOMException,setTimeout,clearTimeout,crypto,Promise,
  chrome:{runtime:{id:'ext',getURL:file=>'chrome-extension://ext/'+file,onMessage:{addListener:fn=>listener=fn},sendMessage:async msg=>{calls.push(msg);return msg.action==='media'?{ok:true}:msg.action==='capture'?{streamId:'stream'}:{ok:true};}}},
  QingReadLocal:{TIMEOUT_MS:1000,cancellationText:()=>'',request:async()=>({}),translator:()=>engine()},
  QingReadCaptions:{createCueBuffer:()=>({})},QingReadSpeech:{createLatestBuffer:()=>({clear(){}})},QingReadVideoPipeline:{create:()=>({captions(){},speech(){},watchSpeech(){}})},
  Translator:{create:create||async function(){return engine();}},
  Worker:class{constructor(){clocks.push(this);}terminate(){this.terminated=true;}},
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
 assert.match((await h.call('commit',{ticket:'one'})).error,/逾時/);
 await h.call('stop');assert.equal(h.engines[0].destroyed,1);assert.equal(h.clocks[0].terminated,true);
 assert.equal((await h.call('status')).active,false);
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
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/video-background.js'),'utf8'),{chrome,setTimeout,Promise,QingReadLocal:{savedToken:async()=>{throw new Error('Must not read credentials');}}});
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
});
