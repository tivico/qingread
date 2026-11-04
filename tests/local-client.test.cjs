const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../extension/local-client.js'), 'utf8');
const token = 'a'.repeat(43);

function client(fetch, saved = { companionToken: token }, persisted = {}) {
  const context = {
    fetch, Blob, ArrayBuffer, TextDecoder, AbortController, AbortSignal, DOMException, crypto, setTimeout, clearTimeout,
    chrome: {runtime:{id:'a'.repeat(32)}, storage: { session: {
      get: async () => saved,
      setAccessLevel: async () => {},
      set: async value => Object.assign(saved, value),
      remove: async key => { delete saved[key]; }
    }, local: {get: async()=>persisted, set: async value=>Object.assign(persisted,value), remove: async key=>{delete persisted[key];}, setAccessLevel: async()=>{}} } }
  };
  vm.runInNewContext(source, context);
  return context.QingReadLocal;
}

// Managed-job fixtures declare their server capability separately from job replies.
function managedClient(fetch) {
  return client((url, options) => url.endsWith('/health')
    ? Promise.resolve(new Response(JSON.stringify({inference_jobs:true,inference_client_identity:true})))
    : fetch(url, options));
}

test('cleanup reports no completed helper job when no managed work was created',()=>{
 const local=client(()=>{throw new Error('No request expected');});
 assert.equal(local.cancellationText([]),'');
 assert.match(local.cancellationText([{status:'fulfilled'}]),/已確認/);
 assert.match(local.cancellationText([{status:'rejected',reason:{cancelState:'unconfirmed'}}]),/尚未確認/);
});

test('an old running companion is rejected before any model job is submitted', async () => {
  for (const health of [{version:'0.3.8',inference_jobs:true}, {inference_jobs:true,inference_client_identity:false}, null]) {
    const calls=[];
    const local=client(async(url,options)=>{
      calls.push({url,method:options.method});
      return new Response(JSON.stringify(url.endsWith('/health')?health:{stage:'done',text:'Unexpected'}));
    });
    await assert.rejects(local.request('/summarize',{body:{text:'Private source'},managed:true}),
      error=>error.code==='COMPANION_UPDATE_REQUIRED' && /重新啟動.*companion\/start.cmd/.test(error.message));
    assert.deepEqual(calls.map(call=>call.method),['GET']);
    assert.ok(calls[0].url.endsWith('/health'));
  }
});
test('video inference requires the companion capability and preserves text plus timing metadata', async () => {
  for (const supported of [false, true]) {
    const bodies=[];
    const local=client(async(url,options)=>{
      if(url.endsWith('/health'))return new Response(JSON.stringify({
        inference_jobs:true,inference_client_identity:true,video_inference:supported
      }));
      if(options.method==='POST')bodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({stage:'done',text:'字幕譯文',timings:{queueMs:10,loadMs:20,generationMs:800}}));
    });
    const translator=local.translator('en',{profile:'video'});
    if(!supported){
      await assert.rejects(translator.translate('Keep this file.'),error=>error.code==='COMPANION_UPDATE_REQUIRED');
      assert.equal(bodies.length,0);
    }else{
      assert.equal(await translator.translate('Keep this file.'),'字幕譯文');
      assert.equal(bodies[0].profile,'video');
      assert.equal(translator.lastMetrics.queueMs,10);
      assert.equal(translator.lastMetrics.generationMs,800);
      assert.equal(translator.lastMetrics.cached,false);
    }
    await translator.destroy();
  }
});

test('stopping during compatibility check never creates or cancels a nonexistent model job', async () => {
  const controller=new AbortController(),calls=[];
  const local=client(async(url,options)=>{
    calls.push(options.method);controller.abort();
    return new Response(JSON.stringify({inference_jobs:true,inference_client_identity:true}));
  });
  await assert.rejects(local.request('/summarize',{body:{text:'Source'},managed:true,signal:controller.signal}),{name:'AbortError'});
  assert.deepEqual(calls,['GET']);
});

test('each new job rechecks the running companion after a restart', async () => {
  let checks=0,submissions=0;
  const local=client(async(url,options)=>{
    if(url.endsWith('/health'))return new Response(JSON.stringify({inference_jobs:true,inference_client_identity:++checks===1}));
    if(options.method==='POST')submissions++;
    return new Response(JSON.stringify({stage:'done',text:'Complete'}));
  });
  await local.request('/summarize',{body:{text:'First'},managed:true});
  await assert.rejects(local.request('/summarize',{body:{text:'Second'},managed:true}),error=>error.code==='COMPANION_UPDATE_REQUIRED');
  assert.equal(checks,2);assert.equal(submissions,1);
});

function streamResponse(chunks, { close = true } = {}) {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (close) controller.close();
    },
    cancel() { cancelled = true; }
  });
  const response = new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
  return { response, stream, wasCancelled: () => cancelled };
}

const bytes = text => new TextEncoder().encode(text);
const line = value => JSON.stringify(value) + '\n';

test('unpaired requests stop before fetching or sending text', async () => {
  let fetched = false;
  const local = client(async () => { fetched = true; }, {});
  await assert.rejects(local.request('/translate', { body: { text: 'private source' } }), /配對/);
  assert.equal(fetched, false);
});

test('pairing stores a token only after successful health authentication', async () => {
  const saved = {};
  const local = client(async (_url, options) => {
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    return new Response('{}', { status: options.headers.Authorization === `Bearer ${token}` ? 200 : 401 });
  }, saved);
  await assert.rejects(local.pair('b'.repeat(43)));
  assert.equal(saved.companionToken, undefined);
  await local.pair(token);
  assert.equal(saved.companionToken, token);
});

test('stream handles one-byte UTF-8 fragments through progress and completion', async () => {
  const encoded = bytes(line({ text: '繁體🙂', done: false }) + line({ text: '繁體🙂完成', done: true }));
  const { response, stream } = streamResponse(Array.from(encoded, byte => Uint8Array.of(byte)));
  let request;
  const local = client(async (url, options) => { request = { url, options }; return response; });
  const progress = [];
  const result = await local.request('/summarize', { body: { text: '人工原文' }, onProgress: e => progress.push(e.text) });
  assert.equal(result.text, '繁體🙂完成');
  assert.deepEqual(progress, ['繁體🙂']);
  assert.equal(request.url, 'http://127.0.0.1:8765/summarize');
  assert.equal(request.options.headers.Accept, 'application/x-ndjson');
  assert.equal(JSON.parse(request.options.body).text, '人工原文');
  assert.equal(stream.locked, false);
});

test('stream without completion rejects instead of accepting partial text', async () => {
  const { response, stream } = streamResponse([bytes(line({ text: '部分摘要', done: false }))]);
  const progress = [];
  await assert.rejects(client(async () => response).request('/summarize', {
    onProgress: e => progress.push(e.text)
  }), /尚未收到完整結果/);
  assert.deepEqual(progress, ['部分摘要']);
  assert.equal(stream.locked, false);
});

test('midstream model failure cancels reader and ignores a following success', async () => {
  const fixture = streamResponse([bytes(
    line({ error: 'MODEL_INCOMPLETE', message: '模型回應尚未完成。' }) + line({ done: true, text: '錯誤成功' })
  )], { close: false });
  await assert.rejects(client(async () => fixture.response).request('/summarize', {
    onProgress: () => assert.fail('Errors must not become progress')
  }), /尚未完成/);
  assert.equal(fixture.wasCancelled(), true);
  assert.equal(fixture.stream.locked, false);
});

test('abort during progress discards a completion already buffered in the same packet', async () => {
  const fixture = streamResponse([bytes(line({ text: '部分摘要' }) + line({ done: true, text: '晚到結果' }))], { close: false });
  const controller = new AbortController();
  await assert.rejects(client(async () => fixture.response).request('/summarize', {
    signal: controller.signal, onProgress: () => controller.abort()
  }), { name: 'AbortError' });
  assert.equal(fixture.wasCancelled(), true);
  assert.equal(fixture.stream.locked, false);
});

test('malformed and oversized stream records release the reader', async () => {
  for (const payload of ['{invalid JSON}\n', 'x'.repeat(200001)]) {
    const fixture = streamResponse([bytes(payload)], { close: false });
    await assert.rejects(client(async () => fixture.response).request('/summarize', { onProgress() {} }));
    assert.equal(fixture.wasCancelled(), true);
    assert.equal(fixture.stream.locked, false);
  }
});

test('a JSON-only companion still works when progress was requested', async () => {
  const local = client(async () => new Response(JSON.stringify({ text: '完整摘要' }), {
    headers: { 'Content-Type': 'application/json' }
  }));
  const result = await local.request('/summarize', { onProgress: () => assert.fail('JSON fallback has no progress events') });
  assert.equal(result.text, '完整摘要');
});

test('destroying a translator aborts its pending request', async () => {
  let fetched;
  const started = new Promise(resolve => { fetched = resolve; });
  const local = managedClient((_url, options) => options.method === 'DELETE' ? Promise.resolve(new Response('{"stage":"cancelled"}')) : new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true });
    fetched();
  }));
  const translator = local.translator('en');
  const pending = translator.translate('人工原文');
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await started;
  translator.destroy();
  await rejected;
});

test('network errors show an actionable message without exposing raw details', async () => {
  const local = client(async () => { throw new Error('secret token or source'); });
  await assert.rejects(local.request('/health'), error => {
    assert.match(error.message, /無法連線到本機助手/);
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
});

test('cancelling one translation aborts its fetch without destroying the reusable translator', async () => {
  let firstSignal, started;
  const began = new Promise(resolve => { started = resolve; });
  const local = managedClient((_url, options) => {
    if(options.method === 'DELETE')return Promise.resolve(new Response('{"stage":"cancelled"}'));
    if (JSON.parse(options.body).text === 'second') return Promise.resolve(new Response('{"stage":"done","text":"第二筆"}'));
    firstSignal = options.signal;
    started();
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort',
      () => reject(new DOMException('Stopped', 'AbortError')), {once:true}));
  });
  const translator = local.translator('en'), job = new AbortController();
  const pending = assert.rejects(translator.translate('first', {signal:job.signal}), {name:'AbortError'});
  await began;
  job.abort();
  const cancelledByJob = firstSignal.aborted;
  const next = await translator.translate('second');
  translator.destroy(); // Also clean up the old implementation when reproducing the failure.
  await pending;
  assert.equal(cancelledByJob, true);
  assert.equal(next, '第二筆');
});

test('an already cancelled translation never sends text to the companion', async () => {
  let calls = 0;
  const local = client(async () => { calls++; return new Response('{"text":"不應送出"}'); });
  const job = new AbortController(); job.abort();
  await assert.rejects(local.translator('en').translate('private text', {signal:job.signal}), {name:'AbortError'});
  assert.equal(calls, 0);
});

test('cancellation while reading a JSON body discards its late result', async () => {
  let finishBody, started;
  const began = new Promise(resolve => { started = resolve; });
  const local = client(async () => ({ok:true, json:() => new Promise(resolve => {
    finishBody = resolve; started();
  })}));
  const job = new AbortController();
  const pending = local.request('/translate', {signal:job.signal,body:{text:'test'}});
  const rejected = assert.rejects(pending, {name:'AbortError'});
  await began; job.abort(); finishBody({text:'晚到的譯文'});
  await rejected;
});

test('managed work reports queue and generation stages before returning cached metadata', async () => {
  const stages=['queued','reading','generating','done'], seen=[], requests=[];
  const local=managedClient(async (url,options)=>{
    requests.push({url,options});
    const stage=stages.shift();
    return new Response(JSON.stringify({stage,...(stage==='done'?{text:'完成',cached:true}:{})}));
  });
  const result=await local.request('/translate',{body:{text:'原文',source:'en'},managed:true,onProgress:event=>seen.push(event.stage)});
  assert.deepEqual(seen,['queued','reading','generating']);
  assert.equal(result.text,'完成');assert.equal(result.cached,true);
  assert.match(requests[0].url,/^http:\/\/127\.0\.0\.1:8765\/inference\/[0-9a-f]{32}$/);
  assert.deepEqual(JSON.parse(requests[0].options.body),{text:'原文',source:'en',kind:'translate'});
  assert.equal(requests.filter(r=>r.options.method==='POST').length,1);
  assert.ok(requests.every(r=>r.options.headers['X-QingRead-Client']==='a'.repeat(32)));
});

test('managed cancellation confirms cleanup even when creation has not returned', async () => {
  let began, route, deletes=0, polls=0;
  const started=new Promise(resolve=>{began=resolve;});
  const local=managedClient((url,options)=>{
    if(options.method==='POST'){
      route=url;began();
      return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Stopped','AbortError')),{once:true}));
    }
    assert.equal(url,route);
    assert.equal(options.headers['X-QingRead-Client'],'a'.repeat(32));
    if(options.method==='DELETE'){deletes++;assert.equal(options.keepalive,true);return Promise.resolve(new Response('{"stage":"cancelling"}'));}
    polls++;return Promise.resolve(new Response('{"stage":"cancelled"}'));
  });
  const controller=new AbortController();
  const pending=local.request('/translate',{body:{text:'test'},managed:true,signal:controller.signal});
  const rejected=assert.rejects(pending,error=>error.name==='AbortError'&&error.cancelState==='cancelled');
  await started;controller.abort();await rejected;
  assert.equal(deletes,1);assert.equal(polls,1);
});

test('managed deadline requests cancellation and reports timeout rather than a network failure', async () => {
  let cancelled=false;
  const local=managedClient(async (_url,options)=>{
    if(options.method==='DELETE'){cancelled=true;return new Response('{"stage":"cancelled"}');}
    return new Response('{"stage":"reading"}');
  });
  local.TIMEOUT_MS=20;
  await assert.rejects(local.request('/translate',{body:{text:'test'},managed:true}),error=>error.name==='TimeoutError'&&error.cancelState==='cancelled');
  assert.equal(cancelled,true);
});

test('a reusable local translator pins model identity for later chunks and preserves model-change errors', async () => {
  const bodies=[], identity='a'.repeat(64);
  const local=managedClient(async (_url,options)=>{
    bodies.push(JSON.parse(options.body));
    return new Response(JSON.stringify(bodies.length===1?{stage:'done',text:'第一段',modelIdentity:identity}:{stage:'failed',error:'MODEL_CHANGED',message:'模型已變更'}));
  });
  const translator=local.translator('en');
  assert.equal(await translator.translate('first'),'第一段');
  await assert.rejects(translator.translate('second'),error=>error.code==='MODEL_CHANGED');
  assert.equal(bodies[1].expectedModelIdentity,identity);
  assert.equal(translator.identity,identity);
});

test('destroy after an unconfirmed cancellation never reports that the assistant stopped', async () => {
  let entered;
  const started=new Promise(resolve=>{entered=resolve;});
  const local=managedClient((_url,options)=>{
    if(options.method==='DELETE')throw new Error('connection lost');
    entered();return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Stopped','AbortError')),{once:true}));
  });
  const translator=local.translator('en'), controller=new AbortController();
  const pending=translator.translate('test',{signal:controller.signal});
  const rejected=assert.rejects(pending,error=>error.name==='AbortError'&&error.cancelState==='unconfirmed');
  await started;controller.abort();await rejected;
  assert.match(local.cancellationText(await translator.destroy()),/尚未確認/);
});

test('a lost managed job gives a restart action and never resubmits the source automatically',async()=>{
  let submissions=0,cleanup=0;
  const local=managedClient(async(_url,options)=>{
    if(options.method==='POST'){submissions++;return new Response('{"stage":"reading"}');}
    if(options.method==='DELETE'){cleanup++;return new Response('{"stage":"cancelled"}');}
    return new Response('{"error":"NOT_FOUND","message":"找不到此本機工作。"}',{status:404});
  });
  await assert.rejects(local.request('/summarize',{body:{text:'Synthetic source'},managed:true}),error=>/工作紀錄已失效.*請重新開始/.test(error.message));
  assert.equal(submissions,1);assert.equal(cleanup,1);
});

test('remembered pairing survives a fresh session without pairing again; default pairing stays temporary',async()=>{
  const saved={},persisted={},calls=[];
  const fetch=async(url,options)=>{calls.push({url,auth:options.headers.Authorization});return new Response('{}');};
  const local=client(fetch,saved,persisted);
  await local.pair(token);
  assert.deepEqual(persisted,{});
  await local.pair(token,{remember:true});
  assert.equal(persisted.rememberedCompanionToken,token);
  const restarted=client(fetch,{},persisted);
  await restarted.request('/health');
  assert.equal(calls.at(-1).auth,`Bearer ${token}`);
  assert.equal(calls.some(call=>call.url.includes('/pair/')),false);
  await restarted.forgetDevice();
  assert.deepEqual(persisted,{});
  await assert.rejects(restarted.request('/health'),/配對/);
});

test('opting out keeps a restored connection for this session only',async()=>{
  const saved={},persisted={rememberedCompanionToken:token};
  const local=client(async()=>new Response('{}'),saved,persisted);
  await local.rememberDevice(false);
  assert.deepEqual(persisted,{});
  assert.equal(saved.companionToken,token);
  await local.request('/health');
});

test('failed authentication never persists an opted-in pairing',async()=>{
  const saved={},persisted={};
  const local=client(async()=>new Response('{}',{status:401}),saved,persisted);
  await assert.rejects(local.pair(token,{remember:true}));
  assert.deepEqual(saved,{});assert.deepEqual(persisted,{});
});

test('forgetting during authentication prevents delayed pairing from restoring credentials',async()=>{
  let resolve,started;
  const ready=new Promise(r=>started=r),saved={},persisted={};
  const local=client(()=>new Promise(r=>{resolve=r;started();}),saved,persisted);
  const pending=local.pair(token,{remember:true});
  await ready;await local.forgetDevice();resolve(new Response('{}'));
  await assert.rejects(pending,{name:'AbortError'});
  assert.deepEqual(saved,{});assert.deepEqual(persisted,{});
});

test('opting out while remember authentication is pending does not resave the credential',async()=>{
  let resolve,started;const ready=new Promise(r=>started=r),persisted={};
  const local=client(()=>new Promise(r=>{resolve=r;started();}),{companionToken:token},persisted);
  const pending=local.rememberDevice(true);
  await ready;await local.rememberDevice(false);resolve(new Response('{}'));
  assert.equal(await pending,false);assert.deepEqual(persisted,{});
});
