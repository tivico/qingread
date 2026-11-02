'use strict';
const el = id => document.getElementById(id);
const local = QingReadLocal;
let connected = false, polling = false;
let previewSupported=false;
let pairing = null;
let connectionEpoch=0;
const notice = text => { el('notice').textContent = text; };
async function attempt(action) { try { await action(); } catch (error) { notice(error.message); } }
async function refresh() {
  const epoch=connectionEpoch;
  const health = await local.request('/health');
  if(epoch!==connectionEpoch)return;
  connected = true;
  previewSupported=health.pdf_preview===true;el('preview-pdf').disabled=!previewSupported;
  el('health').textContent = `助手已連線 · Ollama ${health.ollama ? '已啟動' : '未連線'} · PDF 資源${health.pdf_assets_ready ? '已準備' : '未準備'} · 語音${health.speech_ready ? '已準備' : '未準備'}`;
  el('model').replaceChildren(...health.models.map(name => { const option = document.createElement('option'); option.value = name; option.textContent = name; return option; }));
  el('model').value = health.selected_model || health.models[0] || '';
  await jobs();
}
el('connect').onclick = () => {
  if(pairing)return;
  const controller=new AbortController();pairing=controller;
  el('connect').disabled=true;el('pair').disabled=true;el('pair-cancel').hidden=false;
  el('remember-device').disabled=true;
  el('pair-status').textContent='正在連接本機助手…';
  // Start the permission request inside this click, before the first await.
  void (async()=>{
    try {
      if(!await chrome.permissions.request({origins:['http://127.0.0.1/*']}))throw new Error('需要允許本機連線才能配對。');
      if(controller.signal.aborted)throw new DOMException('Stopped','AbortError');
      await local.connect({signal:controller.signal,remember:el('remember-device').checked,onPending:code=>{
        el('pair-status').textContent=`確認數字：${code}。請在「清讀 · 允許本機連線」視窗確認數字相同，再按「是」。不需輸入或複製數字；視窗最多等候 90 秒。`;
      }});
      if(controller.signal.aborted)throw new DOMException('Stopped','AbortError');
      el('pair-status').textContent='配對完成，可以使用本機助手。';notice('配對完成。');
      await refresh();
    }catch(error){
      el('pair-status').textContent=error.name==='AbortError'?'已取消配對。':error.message;
    }finally{
      if(pairing===controller){pairing=null;el('connect').disabled=false;el('pair').disabled=false;el('remember-device').disabled=false;el('pair-cancel').hidden=true;}
    }
  })();
};
el('pair-cancel').onclick=()=>pairing?.abort();
window.addEventListener('pagehide',()=>pairing?.abort());
el('pair').onclick = () => {
  if(pairing)return;
  const controller=new AbortController();pairing=controller;
  el('connect').disabled=true;el('pair').disabled=true;el('remember-device').disabled=true;el('pair-cancel').hidden=false;
  // Request permission directly within the click's user activation.
  const permission = chrome.permissions.request({ origins: ['http://127.0.0.1/*'] });
  void attempt(async () => {try{
    if (!await permission) throw new Error('需要本機連線權限才能使用助手。');
    await local.pair(el('token').value.trim(),{signal:controller.signal,remember:el('remember-device').checked});
    if(controller.signal.aborted)throw new DOMException('Stopped','AbortError');
    el('token').value = ''; await refresh(); notice('配對完成。');
  }catch(error){
    if(error.name==='AbortError')notice('已取消配對。');else throw error;
  }finally{
    if(pairing===controller){pairing=null;el('connect').disabled=false;el('pair').disabled=false;el('remember-device').disabled=false;el('pair-cancel').hidden=true;}
  }
  });
};
el('remember-device').onchange=()=>attempt(async()=>{
  const epoch=connectionEpoch;
  const enabled=el('remember-device').checked;
  el('remember-device').disabled=true;
  try{
    const saved=await local.rememberDevice(enabled);
    if(epoch!==connectionEpoch)return;
    notice(enabled ? saved?'已記住這台電腦，下次開啟可直接連線。':'完成配對後會記住這台電腦。' : '已取消記住；目前連線保留到瀏覽器關閉或外掛重新載入。');
  }catch(error){
    if(epoch!==connectionEpoch)return;
    el('remember-device').checked=Boolean((await chrome.storage.local.get('rememberedCompanionToken')).rememberedCompanionToken);
    throw error;
  }
  finally{el('remember-device').disabled=false;}
});
el('forget-device').onclick=()=>attempt(async()=>{
  pairing?.abort();connectionEpoch++;connected=false;
  await local.forgetDevice();
  el('remember-device').checked=false;el('token').value='';
  previewSupported=false;el('preview-pdf').disabled=true;
  el('health').textContent='尚未連線';el('model').replaceChildren();el('jobs').replaceChildren();
  el('pair-status').textContent='已清除本外掛儲存的配對。';
  notice('已忘記這台電腦。已送出的工作不會因此停止；需要時請重新連接。');
});
el('refresh').onclick = () => attempt(refresh);
el('save-model').onclick = () => attempt(async () => { await local.request('/settings', { body: { model: el('model').value } }); notice('已選擇本機翻譯模型。'); });
for (const [id, kind] of [['prepare-pdf','pdf-assets'], ['prepare-speech','speech']]) el(id).onclick = () => attempt(async () => { await local.request('/prepare', { body: { kind } }); notice('開始下載，請查看工作狀態。'); await jobs(); });
async function submitPdf(preview=false) {
  if(preview&&!previewSupported)throw new Error('請重新啟動新版助手，確認支援兩頁試翻後再試。');
  const file = el('pdf').files[0];
  if (!file || file.size > 64 * 1024 * 1024) throw new Error('請選擇 64 MB 以內的 PDF。');
  for(const id of ['translate-pdf','preview-pdf','pdf','pages','pdf-source','scanned'])el(id).disabled=true;
  notice(preview?'正在檢查文件並提交前 2 頁試翻…':'正在檢查並上傳文件…');
  try {
    const query = new URLSearchParams({ source: el('pdf-source').value, pages: preview?'':el('pages').value.trim(), scanned: el('scanned').checked,preview });
    await local.request('/pdf?' + query, { body: file }); notice(preview?'已提交前 2 頁試翻；完成後請先檢查譯文與排版，再決定是否翻整份。':'文件已交給本機助手。可關閉此頁，稍後再查看。'); await jobs();
  } finally {
    for(const id of ['translate-pdf','pdf','pages','pdf-source','scanned'])el(id).disabled=false;
    el('preview-pdf').disabled=!previewSupported;
  }
}
el('translate-pdf').onclick=()=>attempt(()=>submitPdf(false));
el('preview-pdf').onclick=()=>attempt(()=>submitPdf(true));
async function jobs() {
  if (polling) return; polling = true;
  const epoch=connectionEpoch;
  try {
    const result = await local.request('/jobs');
    if(epoch!==connectionEpoch)return;
    const nodes = result.jobs.slice().reverse().map(job => {
      const node = document.createElement('article'), title = document.createElement('strong'), description = document.createElement('p');
      title.textContent = `${{pdf:'PDF 翻譯',speech:'語音模型','pdf-assets':'PDF 資源'}[job.kind] || '工作'} · ${{queued:'等待中',running:'處理中',done:'完成',failed:'失敗',cancelled:'已取消'}[job.state] || job.state}`;
      description.textContent = job.message; node.append(title, description);
      if(job.kind==='pdf'){
        const stage=document.createElement('p');
        const label={queued:'排隊',analysis:'分析文件',ocr:'辨識掃描文字',translation:'翻譯文字',output:'排版與輸出',processing:'引擎處理中',cancelling:'取消中',done:'完成',failed:'失敗',cancelled:'已取消'}[job.phase];
        stage.textContent=(job.preview?`前 ${Math.min(2,job.page_count||2)} 頁試翻。`:'')+(label?`階段：${label}`:'');
        if(Number.isInteger(job.current)&&Number.isInteger(job.total)&&job.total>0&&job.current>=0&&job.current<=job.total)stage.textContent+=`（本階段 ${job.current} / ${job.total}）`;
        node.append(stage);
      }
      for (const file of job.outputs) {
        const button = document.createElement('button'); button.className = 'download'; button.textContent = '下載 ' + file.name;
        button.onclick = () => attempt(async () => {
          const blob = await local.request(`/jobs/${job.id}/files/${encodeURIComponent(file.name)}`, { binary: true });
          const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = file.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
        }); node.append(button);
      }
      const remove = document.createElement('button'); remove.textContent = ['queued','running'].includes(job.state) ? '取消工作' : '清除原檔、譯本與快取';
      if(job.phase==='cancelling'&&['queued','running'].includes(job.state)){remove.disabled=true;remove.textContent='正在取消…';}
      remove.onclick = () => attempt(async () => {
        remove.disabled=true;
        try{const result=await local.request('/jobs/' + job.id, { method: 'DELETE' });notice(result.cancelling?'已要求取消，正在等候工作程序結束。':'已清除工作檔案。');await jobs();}
        catch(error){remove.disabled=false;throw error;}
      }); node.append(remove); return node;
    });
    el('jobs').replaceChildren(...nodes);
    if (!nodes.length) el('jobs').textContent = '目前沒有工作。';
  } finally { polling = false; }
}
setInterval(() => { if (connected && !document.hidden) void attempt(jobs); }, 3000);
void attempt(async()=>{
  const epoch=connectionEpoch;
  const saved=await local.savedToken();
  if(epoch!==connectionEpoch)return;
  const remembered=await chrome.storage.local.get('rememberedCompanionToken');
  if(epoch!==connectionEpoch)return;
  el('remember-device').checked=Boolean(remembered.rememberedCompanionToken);
  if(saved)await refresh();
  else notice('按「連接本機助手」開始；請先啟動 companion/start.cmd。');
});
