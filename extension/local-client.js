'use strict';
globalThis.QingReadLocal = {
  TIMEOUT_MS: 180000,
  credentialRevision: 0,
  credentialWrites: Promise.resolve(),
  needsUpdate(health) {
    return Boolean(health?.runtime && (health.runtime.updateRequired !== false ||
      !/^[a-f0-9]{64}$/.test(health.runtime.revision || '')));
  },
  healthChecks(health) {
    const models=Array.isArray(health?.models)?health.models:[];
    const modelReady=Boolean(health?.ollama && health.selected_model && models.includes(health.selected_model));
    const update=this.needsUpdate(health);
    return [
      {ready:!update && Boolean(health.runtime),label:'助手更新',detail:update
        ?'檔案已有更新，執行中的助手尚未載入。先停止字幕並等工作結束，再雙擊 companion/start.cmd，最後重新檢查連線。'
        :health.runtime?'已載入目前程式。':'舊助手未提供更新檢查。先結束工作並關閉原助手，再開新版 companion/start.cmd。'},
      {ready:Boolean(health.ollama),label:'Ollama',detail:health.ollama?'已連線。':'請先啟動 Ollama，再按「重新檢查連線」。'},
      {ready:modelReady,label:'文字翻譯與摘要',detail:modelReady?'已選擇可用的本機模型。':!health.ollama?'等 Ollama 連線後，選擇已下載的模型。':!models.length?'Ollama 尚未有本機文字模型；先下載模型，再重新檢查連線。':'請在下方選擇模型，再按「使用這個模型」。'},
      {ready:Boolean(health.pdf_installed && health.pdf_assets_ready),label:'PDF 排版',detail:!health.pdf_installed?'PDF 套件尚未就緒，請先執行 companion/install.cmd，再開 start.cmd。':health.pdf_assets_ready?'排版資源已準備；翻譯另需文字模型。':'按「下載 PDF 排版資源」準備；翻譯另需文字模型。'},
      {ready:Boolean(health.speech_ready),label:'語音辨識',detail:health.speech_ready?'辨識模型已準備；字幕翻譯另需所選翻譯引擎。':'需要聆聽無字幕影片時，按「下載語音辨識模型」準備。'}
    ];
  },
  writeCredentials(action) {
    const pending=this.credentialWrites.then(action);
    this.credentialWrites=pending.catch(()=>{});
    return pending;
  },
  async savedToken() {
    const revision=this.credentialRevision;
    const session=await chrome.storage.session.get('companionToken');
    if(revision!==this.credentialRevision)return;
    if(session.companionToken)return session.companionToken;
    if(!chrome.storage.local)return;
    await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
    const saved=await chrome.storage.local.get('rememberedCompanionToken');
    if(revision===this.credentialRevision && /^[A-Za-z0-9_-]{30,100}$/.test(saved.rememberedCompanionToken || ''))return saved.rememberedCompanionToken;
  },
  async rememberDevice(enabled) {
    const revision=++this.credentialRevision;
    if(!enabled)return this.writeCredentials(async()=>{
      if(revision!==this.credentialRevision)return false;
      const token=await this.savedToken();
      if(token)await chrome.storage.session.set({companionToken:token});
      await chrome.storage.local.remove('rememberedCompanionToken');
      return true;
    });
    const token=await this.savedToken();
    if(!token)return false;
    await this.request('/health',{token});
    return this.writeCredentials(async()=>{
      if(revision!==this.credentialRevision)return false;
      await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
      await chrome.storage.local.set({rememberedCompanionToken:token});
      return true;
    });
  },
  async forgetDevice() {
    this.credentialRevision++;
    await this.writeCredentials(()=>Promise.all([chrome.storage.session.remove('companionToken'),chrome.storage.local.remove('rememberedCompanionToken')]));
  },
  stageText(event) {
    return ({queued:'正在排隊，等候本機模型…',reading:'本機模型正在處理原文…',generating:'本機模型正在產生結果…',reconnecting:'本機助手暫時沒有回應，正在重新查詢同一筆翻譯…',cancelling:'正在取消本機工作，等候釋放模型…'})[event.stage] || '';
  },
  cancellationText(results) {
    if(!results.length)return '';
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
  async connect({signal,onPending,remember=false} = {}) {
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
          await this.pair(result.token,{signal,remember}); paired=true; return;
        }
        throw new Error(({denied:'已拒絕或未在時間內確認；尚未配對。可再按連接。',expired:'配對已逾時，請重新按連接。',cancelled:'已取消配對。',unavailable:'無法開啟助手確認視窗，請使用下方手動配對。'})[result.state] || '配對未完成，請重新按連接。');
      }
      throw new Error('配對已逾時，請重新按連接。');
    } finally {
      if(request?.id && !paired)void this.pairingRequest('cancel',{id:request.id,nonce}).catch(()=>{});
    }
  },
  async pair(token, {signal,remember=false} = {}) {
    const revision=++this.credentialRevision;
    if (!/^[A-Za-z0-9_-]{30,100}$/.test(token)) throw new Error('請輸入助手視窗中的完整配對碼。');
    await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    await this.request('/health', { token, signal });
    if(signal?.aborted || revision!==this.credentialRevision)throw new DOMException('Stopped','AbortError');
    await this.writeCredentials(async()=>{
      if(signal?.aborted || revision!==this.credentialRevision)throw new DOMException('Stopped','AbortError');
      await chrome.storage.session.set({ companionToken: token });
      if(remember){
        await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
        await chrome.storage.local.set({rememberedCompanionToken:token});
      }else await chrome.storage.local?.remove?.('rememberedCompanionToken');
      if(signal?.aborted){
        await chrome.storage.session.remove('companionToken');
        await chrome.storage.local?.remove?.('rememberedCompanionToken');
        throw new DOMException('Stopped','AbortError');
      }
    });
  },
  async request(path, { body, method, signal, token, binary = false, onProgress, managed = false, keepalive = false, clientId } = {}) {
    if (managed) return this.runInference(path, {body,signal,token,onProgress});
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    token ||= await this.savedToken();
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    if (!token) throw new Error('請先開啟「PDF 與助手設定」完成配對。');
    const headers = { Authorization: `Bearer ${token}` };
    if(clientId)headers['X-QingRead-Client']=clientId;
    if(onProgress)headers.Accept='application/x-ndjson';
    if (body && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
      headers['Content-Type'] = 'application/json'; body = JSON.stringify(body);
    }
    const readFailure = error => {
      if (signal?.aborted) return new DOMException('Stopped', 'AbortError');
      const invalid = error?.name === 'SyntaxError';
      const failure = new Error(invalid
        ? '本機助手回應格式不正確。請到「PDF 與助手設定」重新檢查連線，再重試。'
        : '無法連線到本機助手，或處理逾時。請雙擊 companion/start.cmd，再到「PDF 與助手設定」按「重新檢查連線」。');
      failure.code = invalid ? 'COMPANION_RESPONSE' : 'COMPANION_CONNECTION';
      return failure;
    };
    let response;
    try {
      response = await fetch('http://127.0.0.1:8765' + path, {
        method: method || (body ? 'POST' : 'GET'), headers, body,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.TIMEOUT_MS)]) : AbortSignal.timeout(this.TIMEOUT_MS),
        keepalive,
        credentials: 'omit', cache: 'no-store', redirect: 'error'
      });
    } catch (error) {
      throw readFailure(error);
    }
    if (!response.ok) {
      const value = await response.json().catch(() => ({}));
      const error=new Error(value.message || `本機助手回應錯誤（${response.status}）。`);
      error.code=value.error;error.status=response.status;throw error;
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
    // fetch resolves at the headers. A connection can still fail while reading the body.
    let value;
    try { value = await (binary ? response.blob() : response.json()); }
    catch (error) { throw readFailure(error); }
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    return value;
  },
  async runInference(path, {body,signal,token,onProgress}) {
    if (signal?.aborted) throw new DOMException('Stopped','AbortError');
    token ||= await this.savedToken();
    if (signal?.aborted) throw new DOMException('Stopped','AbortError');
    if (!token) throw new Error('請先開啟「PDF 與助手設定」完成配對。');
    const kind = ({'/translate':'translate','/summarize':'summarize','/explain':'explain'})[path];
    if (!kind) throw new Error('不支援此本機工作。');
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');
    const route = '/inference/' + id;
    // Extension fetch may omit Origin on GET. Pin the same authenticated client
    // identity across creation, polling and cancellation instead of trusting that header.
    const clientId=chrome.runtime?.id;
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
          let result = await this.request(route,{method:'DELETE',token,signal:cleanupSignal,keepalive:true,clientId});
          while (!['done','failed','cancelled'].includes(result.stage)) {
            await delay(100,cleanupSignal);
            result = await this.request(route,{token,signal:cleanupSignal,clientId});
          }
          return result.error === 'CLEANUP_FAILED' ? 'unconfirmed' : result.stage;
        } catch { return 'unconfirmed'; }
      })();
    };
    combined.addEventListener('abort',cancel,{once:true});
    try {
      if (combined.aborted) throw new DOMException('Stopped','AbortError');
      // Files on disk and the already-running helper can have the same version
      // but different capabilities. Check the process before sending source text.
      const health = await this.request('/health',{token,signal:combined});
      if (this.needsUpdate(health) || health?.inference_jobs !== true || health?.inference_client_identity !== true ||
          (body.profile === 'video' && health?.video_inference !== true) ||
          (body.summaryMode?.startsWith('video-') && health?.video_summary !== true) ||
          (body.summaryDetail === 'concise' && health?.video_summary_concise !== true)) {
        const error = new Error('目前執行中的本機助手尚未載入必要更新。請先停止字幕並等工作結束，再重新啟動本專案的 companion/start.cmd；新版會在閒置時交接，舊助手首次升級需先關閉原助手。完成後重新檢查連線並重試。');
        error.code = 'COMPANION_UPDATE_REQUIRED';
        throw error;
      }
      if (combined.aborted) throw new DOMException('Stopped','AbortError');
      started = true;
      let result = await this.request(route,{body:{...body,kind},token,signal:combined,clientId});
      let previous = '';
      // Only retry status reads for ordinary translation. Live captions have a tighter timing budget.
      let remainingPollRetries = kind === 'translate' && !body.profile ? 2 : 0;
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
        for (;;) {
          try {
            result = await this.request(route,{token,signal:combined,clientId});
            break;
          } catch (error) {
            if (error.code !== 'COMPANION_CONNECTION' || error.status !== undefined ||
                remainingPollRetries === 0 || combined.aborted) throw error;
            remainingPollRetries--;
            previous = '';
            onProgress?.({stage:'reconnecting'});
            await delay(500,combined);
          }
        }
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
      if(error.code==='NOT_FOUND'&&error.status===404)throw new Error('本機工作紀錄已失效，可能因助手重新啟動或結果過期。請重新開始；已顯示的部分內容尚未完整。');
      throw error;
    } finally { combined.removeEventListener('abort',cancel); }
  },
  translator(source, {onProgress,expectedIdentity,profile} = {}) {
    const controller = new AbortController();
    const active = new Set(), settled = [], local = this;
    const remember = result => {settled.push(result);if(settled.length>32)settled.shift();};
    const handle = {
      managed:true, identity:expectedIdentity, lastMetrics:null,
      translate(text, {signal} = {}) {
        handle.lastMetrics=null;
        const pending = local.request('/translate', {
          body: { text, source, ...(profile ? {profile} : {}), ...(handle.identity ? {expectedModelIdentity:handle.identity} : {}) }, signal: signal ? AbortSignal.any([controller.signal, signal]) : controller.signal,
          managed:true, onProgress
        });
        active.add(pending);
        pending.then(()=>{active.delete(pending);remember({status:'fulfilled'});},error=>{active.delete(pending);remember({status:'rejected',reason:{cancelState:error.cancelState}});});
        return pending.then(result=>{
          handle.identity=result.modelIdentity || handle.identity;
          handle.lastMetrics={...result.timings,cached:result.cached === true};
          return result.text;
        });
      },
      async destroy() {controller.abort();const previous=settled.slice();return previous.concat(await Promise.allSettled([...active]));}
    };
    return handle;
  }
};
