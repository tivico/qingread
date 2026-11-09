const {test}=require('node:test');
const assert=require('node:assert/strict');
require('../extension/video-summary-core.js');
const core=globalThis.QingReadVideoSummary, identity='a'.repeat(64);
const answer=text=>({text,modelIdentity:identity});

test('video chunking retains Unicode and the end of long transcripts',()=>{
  const text=('保留🙂𠮷abc').repeat(2000)+'TAIL';
  const chunks=core.chunks([{start:3,text}]);
  assert.ok(chunks.length>2);
  assert.equal(chunks.map(p=>p.text).join(''),text);
  assert.ok(chunks.every(p=>Array.from(p.text).length<=5000 && p.start===3));
  assert.ok(chunks.every(p=>Buffer.byteLength(p.text,'utf8')<=5000));
  assert.equal(core.time(3661),'1:01:01');
  assert.equal(core.time(65.9),'1:05');
});
test('invalid, out-of-order and oversized transcripts are rejected before inference',()=>{
  for(const input of [[],[{start:-1,text:'bad'}],[{start:2,text:'one'},{start:1,text:'two'}],
    [{start:0,text:' '}],[{start:0,text:'x'.repeat(240001)}]])assert.throws(()=>core.chunks(input));
});
test('all transcript chunks precede the overview and share the same model identity',async()=>{
  const calls=[],notes=[];
  const result=await core.summarize([{start:0,text:'x'.repeat(5500)},{start:90,text:'TAIL'}],{
    signal:new AbortController().signal,onStage:()=>{},onChunk:n=>notes.push(n),
    request:async(path,options)=>{calls.push(options.body);return answer(options.body.summaryMode==='video-chunk'?'本段重點':'影片總覽');}
  });
  assert.equal(notes.length,2);assert.equal(result.text,'影片總覽');
  assert.ok(calls[1].text.endsWith('TAIL'));
  assert.deepEqual(calls.map(c=>c.summaryMode),['video-chunk','video-chunk','video-overview']);
  assert.ok(calls.slice(1).every(c=>c.expectedModelIdentity===identity));
  assert.match(calls.at(-1).text,/1:30/);
});
test('long video summaries reduce recursively without dropping notes or exceeding input limits',async()=>{
  const calls=[],notes=[];
  await core.summarize([{start:0,text:'x'.repeat(239000)+'TAIL'}],{
    signal:new AbortController().signal,onStage:()=>{},onChunk:n=>notes.push(n),
    request:async(path,options)=>{calls.push(options.body);return answer('x'.repeat(1700));}
  });
  assert.equal(notes.length,48);
  assert.ok(calls.findLast(c=>c.summaryMode==='video-chunk').text.endsWith('TAIL'));
  assert.ok(calls.every(c=>Buffer.byteLength(c.text,'utf8')<=6000));
  assert.ok(calls.filter(c=>c.summaryMode==='video-overview').length>16);
});
test('abort between chunks and during a pending request never publishes late notes',async()=>{
  const controller=new AbortController();let count=0;
  await assert.rejects(core.summarize([{start:0,text:'x'.repeat(6000)}],{
    signal:controller.signal,onStage:()=>{},onChunk:()=>{count++;controller.abort();},request:async()=>answer('重點')
  }),{name:'AbortError'});
  assert.equal(count,1);
  const other=new AbortController();let release,late=0;
  const pending=core.summarize([{start:0,text:'test'}],{signal:other.signal,onStage:()=>{},onChunk:()=>late++,
    request:()=>new Promise(resolve=>{release=resolve;})});
  other.abort();release(answer('晚到'));await assert.rejects(pending,{name:'AbortError'});assert.equal(late,0);
});
test('truncated output, missing identity and changed models preserve only completed chunks',async()=>{
  for(const failure of [{text:'partial',truncated:true,modelIdentity:identity},{text:'bad'},answer('x'.repeat(1801)),{text:'new',modelIdentity:'b'.repeat(64)}]){
    let calls=0;const notes=[];
    await assert.rejects(core.summarize([{start:0,text:'x'.repeat(6000)}],{
      signal:new AbortController().signal,onStage:()=>{},onChunk:n=>notes.push(n),
      request:async()=>++calls===1?answer('第一段'):failure
    }));
    assert.equal(notes.length,1);
  }
});
test('concise and detailed modes send identical complete transcript inputs and collect reliable metrics',async()=>{
 const inputs={};
 for(const detail of ['concise','detailed']){
  const calls=[],updates=[];
  const result=await core.summarize([{start:0,text:'x'.repeat(6000)+'TAIL'}],{
   detail,signal:new AbortController().signal,onStage:()=>{},onChunk:()=>{},onTiming:values=>updates.push(values),
   request:async(path,options)=>{calls.push(options.body);return {...answer('重點'),cached:calls.length===2,timings:{promptMs:100,generationMs:250,loadMs:-1,prepareMs:'invalid'}};}
  });
  inputs[detail]=calls.filter(value=>value.summaryMode==='video-chunk').map(value=>value.text);
  assert.ok(calls.every(value=>detail==='concise'?value.summaryDetail==='concise':!value.summaryDetail));
  assert.equal(updates.length,3);assert.equal(result.timings.length,3);
  assert.equal(result.timings[1].cached,true);assert.equal(result.timings[0].promptMs,100);
  assert.equal(result.timings[0].loadMs,undefined);assert.equal(result.timings[0].prepareMs,undefined);
 }
 assert.deepEqual(inputs.concise,inputs.detailed);assert.ok(inputs.concise.at(-1).endsWith('TAIL'));
});
