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
