'use strict';
globalThis.QingReadLocal = {
  TIMEOUT_MS: 180000,
  stageText(event) {
    return ({queued:'正在排隊，等候本機模型…',reading:'本機模型正在處理原文…',generating:'本機模型正在產生結果…',cancelling:'正在取消本機工作，等候釋放模型…'})[event.stage] || '';
  },
  cancellationText(results) {
    return results.every(result=>result.status==='fulfilled' || ['cancelled','done','failed'].includes(result.reason?.cancelState))
      ? '助手已確認該筆工作結束。' : '已送出取消要求，尚未確認助手停止；請稍後查看助手狀態。';
  },
  async pairingRequest(action, body, signal) {
    let response;
    try {
      response = await fetch('http://127.0.0.1:8765/pair/' + action, {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body),
        signal:signal ? AbortSignal.any([signal,AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
        credentials:'omit', cache:'no-store', redirect:'error'
      });
    } catch (error) {
      if (signal?.aborted) throw new DOMException('Stopped','AbortError');
      throw new Error('無法連線到本機助手。請先啟動 companion/start.cmd，再按連接。');
    }
    const value = await response.json().catch(()=>({}));
    if (!response.ok) throw new Error(response.status===401 || response.status===404
      ? '助手可能仍是舊版，或配對已過期。請重新啟動新版助手再試；也可使用手動配對。'
      : value.message || '助手未能完成配對，請稍後重試。');
    return value;
  },
  async connect({signal,onPending} = {}) {
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join('');
    let request, paired = false;
    try {
      request = await this.pairingRequest('start',{nonce});
      if (!/^[A-Za-z0-9_-]{43}$/.test(request.id || '') || !/^\d{6}$/.test(request.code || ''))
        throw new Error('助手配對回應格式不正確，請更新並重新啟動助手。');
      if(signal?.aborted)throw new DOMException('Stopped','AbortError');
      onPending?.(request.code);
      const deadline = Date.now()+120000;
      while (Date.now()<deadline) {
        await new Promise((resolve,reject)=>{
          const abort=()=>{clearTimeout(timer);reject(new DOMException('Stopped','AbortError'));};
          const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},750);
          signal?.addEventListener('abort',abort,{once:true});
          if(signal?.aborted)abort();
        });
        const result=await this.pairingRequest('status',{id:request.id,nonce},signal);
        if(result.state==='pending')continue;
        if(result.state==='approved'){
          if(signal?.aborted)throw new DOMException('Stopped','AbortError');
          await this.pair(result.token,{signal}); paired=true; return;
        }
        throw new Error(({denied:'已拒絕或未在時間內確認；尚未配對。可再按連接。',expired:'配對已逾時，請重新按連接。',cancelled:'已取消配對。',unavailable:'無法開啟助手確認視窗，請使用下方手動配對。'})[result.state] || '配對未完成，請重新按連接。');
      }
      throw new Error('配對已逾時，請重新按連接。');
    } finally {
      if(request?.id && !paired)void this.pairingRequest('cancel',{id:request.id,nonce}).catch(()=>{});
    }
  },
  async pair(token, {signal} = {}) {
    if (!/^[A-Za-z0-9_-]{30,100}$/.test(token)) throw new Error('請輸入助手視窗中的完整配對碼。');
    await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    await this.request('/health', { token, signal });
    if(signal?.aborted)throw new DOMException('Stopped','AbortError');
    await chrome.storage.session.set({ companionToken: token });
  },
  async request(path, { body, method, signal, token, binary = false, onProgress, managed = false, keepalive = false } = {}) {
    if (managed) return this.runInference(path, {body,signal,token,onProgress});
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    token ||= (await chrome.storage.session.get('companionToken')).companionToken;
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    if (!token) throw new Error('請先開啟「PDF 與助手設定」完成配對。');
    const headers = { Authorization: `Bearer ${token}` };
    if(onProgress)headers.Accept='application/x-ndjson';
    if (body && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
      headers['Content-Type'] = 'application/json'; body = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetch('http://127.0.0.1:8765' + path, {
        method: method || (body ? 'POST' : 'GET'), headers, body,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.TIMEOUT_MS)]) : AbortSignal.timeout(this.TIMEOUT_MS),
        keepalive,
        credentials: 'omit', cache: 'no-store', redirect: 'error'
      });
    } catch (error) {
      if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
      throw new Error('無法連線到本機助手，或處理逾時。請確認助手視窗仍開啟。');
    }
    if (!response.ok) {
      const value = await response.json().catch(() => ({}));
      throw new Error(value.message || `本機助手回應錯誤（${response.status}）。`);
    }
    if(onProgress && response.headers?.get('content-type')?.includes('application/x-ndjson')){
      const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
      try{
        while(true){
          const {value,done}=await reader.read();
          buffer+=decoder.decode(value,{stream:!done});
          if(buffer.length>200000)throw new Error('摘要回應過長，已停止讀取。');
          let end;
          while((end=buffer.indexOf('\n'))>=0){
            const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
            if(!line.trim())continue;
            const event=JSON.parse(line);
            if(event.error)throw new Error(event.message || '摘要尚未完成。');
            if(signal?.aborted)throw new DOMException('Stopped','AbortError');
            if(event.done)return event;
            onProgress(event);
          }
          if(done)throw new Error('摘要連線中斷，尚未收到完整結果。');
        }
      }catch(error){
        if(signal?.aborted)throw new DOMException('Stopped','AbortError');
        throw error;
      }finally{
        await reader.cancel().catch(()=>{});reader.releaseLock();
      }
    }
    const value = await (binary ? response.blob() : response.json());
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    return value;
  },
  async runInference(path, {body,signal,token,onProgress}) {
    if (signal?.aborted) throw new DOMException('Stopped','AbortError');
    token ||= (await chrome.storage.session.get('companionToken')).companionToken;
    if (signal?.aborted) throw new DOMException('Stopped','AbortError');
    if (!token) throw new Error('請先開啟「PDF 與助手設定」完成配對。');
    const kind = ({'/translate':'translate','/summarize':'summarize','/explain':'explain'})[path];
    if (!kind) throw new Error('不支援此本機工作。');
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');
    const route = '/inference/' + id;
    const deadline = AbortSignal.timeout(this.TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal,deadline]) : deadline;
    const delay = (ms, currentSignal) => new Promise((resolve,reject) => {
      const abort = () => { clearTimeout(timer); currentSignal.removeEventListener('abort',abort); reject(new DOMException('Stopped','AbortError')); };
      const timer = setTimeout(() => {currentSignal.removeEventListener('abort',abort);resolve();},ms);
      currentSignal.addEventListener('abort',abort,{once:true});
      if(currentSignal.aborted)abort();
    });
    let cancellation, started = false, finished = false;
    const cancel = () => {
      if (!started || finished) return;
      cancellation ||= (async () => {
        const cleanupSignal = AbortSignal.timeout(3000);
        try {
          let result = await this.request(route,{method:'DELETE',token,signal:cleanupSignal,keepalive:true});
          while (!['done','failed','cancelled'].includes(result.stage)) {
            await delay(100,cleanupSignal);
            result = await this.request(route,{token,signal:cleanupSignal});
          }
          return result.error === 'CLEANUP_FAILED' ? 'unconfirmed' : result.stage;
        } catch { return 'unconfirmed'; }
      })();
    };
    combined.addEventListener('abort',cancel,{once:true});
    try {
      if (combined.aborted) throw new DOMException('Stopped','AbortError');
      started = true;
      let result = await this.request(route,{body:{...body,kind},token,signal:combined});
      let previous = '';
      while (true) {
        if (combined.aborted) throw new DOMException('Stopped','AbortError');
        if (!['queued','reading','generating','cancelling','done','failed','cancelled'].includes(result.stage)) throw new Error('助手工作狀態格式不正確，請重新啟動新版助手。');
        if (result.stage === 'done') { finished=true; return {...result,done:true}; }
        if (result.stage === 'failed' || result.stage === 'cancelled') {
          finished=true;
          if (result.error === 'TIMEOUT') throw new DOMException('Engine timed out','TimeoutError');
          if (result.stage === 'cancelled') throw new DOMException('Stopped','AbortError');
          const error=new Error(result.message || '本機工作失敗，請重試。');error.code=result.error;throw error;
        }
        const state = JSON.stringify([result.stage,result.text]);
        if(state!==previous){onProgress?.(result);previous=state;}
        await delay(250,combined);
        result = await this.request(route,{token,signal:combined});
      }
    } catch(error) {
      cancel();
      const cancelState = cancellation ? await cancellation : undefined;
      if (combined.aborted) {
        const stopped = new DOMException(deadline.aborted && !signal?.aborted ? 'Engine timed out' : 'Stopped', deadline.aborted && !signal?.aborted ? 'TimeoutError' : 'AbortError');
        stopped.cancelState = cancelState;
        throw stopped;
      }
      if(error.message==='找不到此功能。')throw new Error('請重新啟動新版助手，以使用可取消的本機翻譯。');
      throw error;
    } finally { combined.removeEventListener('abort',cancel); }
  },
  translator(source, {onProgress,expectedIdentity} = {}) {
    const controller = new AbortController();
    const active = new Set(), settled = [], local = this;
    const remember = result => {settled.push(result);if(settled.length>32)settled.shift();};
    const handle = {
      managed:true, identity:expectedIdentity,
      translate(text, {signal} = {}) {
        const pending = local.request('/translate', {
          body: { text, source, ...(handle.identity ? {expectedModelIdentity:handle.identity} : {}) }, signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
          managed:true, onProgress
        });
        active.add(pending);
        pending.then(()=>{active.delete(pending);remember({status:'fulfilled'});},error=>{active.delete(pending);remember({status:'rejected',reason:{cancelState:error.cancelState}});});
        return pending.then(result=>{handle.identity=result.modelIdentity || handle.identity;return result.text;});
      },
      async destroy() {controller.abort();const previous=settled.slice();return previous.concat(await Promise.allSettled([...active]));}
    };
    return handle;
  }
};
