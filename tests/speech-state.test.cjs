const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {POLICY,createLatestBuffer,trimOverlap}=require('../extension/speech-state');
test('audio worklet preserves 500 ms overlap and emits at a four second stride at 16/44.1/48 kHz',()=>{
  for(const rate of [16000,44100,48000]){
    const frames=[];let Processor;
    const context={Float32Array,sampleRate:rate,AudioWorkletProcessor:class{constructor(){this.port={postMessage:frame=>frames.push(frame)};}},registerProcessor:(_name,processor)=>{Processor=processor;}};
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../extension/audio-worklet.js'),'utf8'),context);
    const processor=new Processor();
    for(let start=0;start<rate*8.5;start+=128){
      const samples=Float32Array.from({length:Math.min(128,rate*8.5-start)},(_,i)=>(start+i)/(rate*10));
      processor.process([[samples,samples]]);
    }
    assert.equal(frames.length,2);assert.equal(frames[0].samples.length,72000);
    assert.equal(frames[0].overlapMs,0);assert.equal(frames[1].overlapMs,500);
    assert.equal(frames[1].sequence,1);
    assert.deepEqual(frames[0].samples.slice(-8000),frames[1].samples.slice(0,8000));
    processor.port.onmessage({data:{type:'reset'}});
    for(let start=0;start<rate*4.5;start+=128)processor.process([[new Float32Array(Math.min(128,rate*4.5-start))]]);
    assert.equal(frames[2].sequence,0);assert.equal(frames[2].overlapMs,0);
    assert.equal(frames[2].epoch,1);
    assert.ok(frames[2].samples.every(value=>value===0),'Seek reset must discard all earlier audio');
  }
});
test('speech buffer holds only the latest frame and expires queued audio',()=>{
  const queue=createLatestBuffer();
  queue.offer({sequence:1,capturedAt:0});queue.offer({sequence:2,capturedAt:100});
  assert.equal(queue.take(200).sequence,2);assert.equal(queue.dropped,1);assert.equal(queue.take(200),null);
  queue.offer({sequence:3,capturedAt:200});assert.equal(queue.take(200+POLICY.maxQueueAgeMs+1),null);
  assert.equal(queue.dropped,2);queue.offer({sequence:4,capturedAt:10000});queue.clear();assert.equal(queue.pending,false);
});
test('speech overlap removes only a recent contiguous matching word prefix near the segment start',()=>{
  const options={contiguous:true,overlapMs:500,segments:[{start:0,end:2}]};
  assert.equal(trimOverlap('Please keep the original file.','The original file is safe.',options),'is safe.');
  assert.equal(trimOverlap('Please keep the original file.','The original file is safe.',{...options,contiguous:false}),'The original file is safe.');
  assert.equal(trimOverlap('Please keep the original file.','The original file is safe.',{...options,segments:[{start:1}]}),'The original file is safe.');
  assert.equal(trimOverlap('Thank you','Thank you again',options),'Thank you again');
  assert.equal(trimOverlap('Whole previous sentence','Unrelated new speech',options),'Unrelated new speech');
});

function busyPipeline(request){
 let now=0;const stopped=[],shown=[],bodies=[];
 const s={controller:new AbortController(),source:'en',mode:'speech',speechQueue:createLatestBuffer(),dropped:0,glossary:[],cache:new Map(),translator:{translate:async()=> '譯文'}};
 let current=s,state={paused:false,time:4.5,timelineVersion:1};
 const stop=message=>{stopped.push(message);current=null;s.controller.abort();s.speechQueue.clear();};
 const context={Float32Array,ArrayBuffer,DataView,Promise,Date:{now:()=>now},performance:{now:()=>now},
  QingReadCore:require('../extension/core.js'),QingReadSpeech:{POLICY,createLatestBuffer,trimOverlap},
  QingReadLocal:{request:async(_path,options)=>{bodies.push(options.body);return request(bodies.length);}}};
 vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../extension/video-pipeline.js'),'utf8'),context);
 const pipeline=context.QingReadVideoPipeline.create({getSession:()=>current,stop,say(){},waitForEngine:p=>p,
  send:async(_target,message)=>{if(message.type==='qingread:media-show'){shown.push(message);return {applied:true};}return {...state};}});
 const flush=()=>new Promise(r=>setImmediate(r));
 return {s,stopped,shown,bodies,stop,
  async emit(sequence){state.time=4.5+sequence*4;await pipeline.speech(s,{samples:new Float32Array(72000).fill((sequence+1)/10),epoch:s.speechAudioEpoch||0,sequence,overlapMs:0});await flush();},
  async tick(ms){now+=ms;await pipeline.watchSpeech(s);await flush();},
  async seek(){state.timelineVersion++;await pipeline.watchSpeech(s);await flush();}
 };
}
const speechBusy=()=>Object.assign(new Error('上一段語音還在辨識'),{code:'SPEECH_BUSY',status:429});

test('busy speech waits before retrying and preserves a newer frame that arrived during the failed request',async()=>{
 let reject;const h=busyPipeline(count=>count===1?new Promise((_resolve,r)=>reject=r):{text:'Latest speech',segments:[]});
 await h.emit(0);await h.emit(1);reject(speechBusy());await h.tick(0);
 assert.equal(h.stopped.length,0);assert.equal(h.bodies.length,1);
 await h.tick(POLICY.busyRetryMs-1);assert.equal(h.bodies.length,1);
 await h.tick(1);assert.equal(h.bodies.length,2);assert.equal(h.shown.length,1);
 assert.equal(new DataView(h.bodies[1]).getInt16(44,true),Math.round(.2*32767));
 assert.equal(h.s.speechBusySince,undefined);assert.equal(h.s.dropped,1);
});

test('persistent speech busy has a finite wait budget and never spins requests',async()=>{
 const h=busyPipeline(()=>{throw speechBusy();});await h.emit(0);
 for(let elapsed=0;elapsed<POLICY.busyTimeoutMs;elapsed+=POLICY.busyRetryMs)await h.tick(POLICY.busyRetryMs);
 assert.equal(h.stopped.length,1);assert.match(h.stopped[0],/持續忙碌/);
 assert.ok(h.bodies.length<=POLICY.busyTimeoutMs/POLICY.busyRetryMs);
 assert.equal(h.shown.length,0);
});

test('stop and seek discard busy speech retries rather than replaying old audio',async()=>{
 for(const action of ['stop','seek']){
  const h=busyPipeline(()=>{throw speechBusy();});await h.emit(0);
  if(action==='stop')h.stop('Stopped');else await h.seek();
  await h.tick(POLICY.busyRetryMs);assert.equal(h.bodies.length,1);assert.equal(h.shown.length,0);
 }
});

test('unrelated speech errors still stop immediately instead of being retried',async()=>{
 const h=busyPipeline(()=>{throw Object.assign(new Error('請重新配對'),{status:401,code:'AUTH'});});
 await h.emit(0);assert.deepEqual(h.stopped,['請重新配對']);assert.equal(h.bodies.length,1);
});
