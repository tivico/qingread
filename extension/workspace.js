'use strict';
const el = id => document.getElementById(id);
const local = QingReadLocal;
let connected = false, polling = false;
let previewSupported=false;
let helperUpdateRequired=false;
let submittingPdf=false, healthRevision=0;
let pairing = null;
let connectionEpoch=0;
const notice = text => { el('notice').textContent = text; };
function showChecks(checks) {
  el('setup-checks').replaceChildren(...checks.map(check=>{
    const item=document.createElement('li'),title=document.createElement('strong'),detail=document.createElement('span');
    title.textContent=`${check.ready?'已就緒':'待處理'} · ${check.label}`;
    detail.textContent=check.detail;
    item.dataset.ready=String(check.ready);item.append(title,detail);return item;
  }));
}
async function attempt(action) { try { await action(); } catch (error) { notice(error.message); } }
function updateWorkspaceControls() {
  const available=connected && !helperUpdateRequired;
  el('model').disabled=!available || !el('model').options.length;
  el('save-model').disabled=!available || !el('model').value;
  for(const id of ['prepare-pdf','prepare-speech'])el(id).disabled=!available;
  el('translate-pdf').disabled=!available || submittingPdf;
  el('preview-pdf').disabled=!available || submittingPdf || !previewSupported;
  for(const id of ['pdf','pages','pdf-source','scanned'])el(id).disabled=submittingPdf;
}
updateWorkspaceControls();
el('model').onchange=updateWorkspaceControls;
async function refresh() {
  const epoch=connectionEpoch;
  const revision=++healthRevision;
  let health;
  try { health = await local.request('/health'); }
  catch(error){
    if(epoch!==connectionEpoch || revision!==healthRevision)return;
    connected=false;previewSupported=false;
    el('health').textContent='助手連線未完成，尚未確認功能狀態。';
    el('model').replaceChildren();
    el('jobs').textContent='重新連線後可查看工作進度。';
    updateWorkspaceControls();
    showChecks([{ready:false,label:'助手連線',detail:error.message}]);
    throw error;
  }
  if(epoch!==connectionEpoch || revision!==healthRevision)return;
  connected = true;
  const update=local.needsUpdate(health),models=Array.isArray(health.models)?health.models:[];
  helperUpdateRequired=update;
  previewSupported=health.pdf_preview===true;
  showChecks(local.healthChecks(health));
  el('health').textContent = update?'助手可連線，但尚未載入更新；請查看準備檢查。':`助手已連線 · 版本 ${health.version || '未提供'}；各功能狀態請查看準備檢查。`;
  el('model').replaceChildren(...models.map(name => { const option = document.createElement('option'); option.value = name; option.textContent = name; return option; }));
  el('model').value = models.includes(health.selected_model) ? health.selected_model : models[0] || '';
  updateWorkspaceControls();
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
  previewSupported=false;
  el('health').textContent='尚未連線';el('model').replaceChildren();el('jobs').replaceChildren();
  updateWorkspaceControls();
  el('pair-status').textContent='已清除本外掛儲存的配對。';
  showChecks([{ready:false,label:'助手連線',detail:'尚未配對，請按「連接本機助手」。'}]);
  notice('已忘記這台電腦。已送出的工作不會因此停止；需要時請重新連接。');
});
el('refresh').onclick = () => attempt(refresh);
el('save-model').onclick = () => attempt(async () => { await local.request('/settings', { body: { model: el('model').value } }); await refresh();notice('已選擇本機翻譯模型。'); });
for (const [id, kind] of [['prepare-pdf','pdf-assets'], ['prepare-speech','speech']]) el(id).onclick = () => attempt(async () => { await local.request('/prepare', { body: { kind } }); notice('開始下載，請查看工作狀態。'); await jobs(); });
async function submitPdf(preview=false) {
  if(submittingPdf)return;
  if(!connected)throw new Error('請先連接本機助手，再提交文件。');
  if(helperUpdateRequired)throw new Error('助手尚未載入更新，文件未送出。請先停止字幕並等工作結束，再開 companion/start.cmd 並重新檢查連線。');
  if(preview&&!previewSupported)throw new Error('請重新啟動新版助手，確認支援兩頁試翻後再試。');
  const file = el('pdf').files[0];
  if (!file || file.size > 64 * 1024 * 1024) throw new Error('請選擇 64 MB 以內的 PDF。');
  if(el('scanned').checked && el('pdf-source').value!=='en')throw new Error('掃描辨識僅支援英文。請選擇英文，或取消勾選掃描模式。');
  const epoch=connectionEpoch;
  submittingPdf=true;
  updateWorkspaceControls();
  notice(preview?'正在檢查文件並提交前 2 頁試翻…':'正在檢查並上傳文件…');
  try {
    const query = new URLSearchParams({ source: el('pdf-source').value, pages: preview?'':el('pages').value.trim(), scanned: el('scanned').checked,preview });
    await local.request('/pdf?' + query, { body: file });
    if(epoch!==connectionEpoch)return;
    notice(preview?'已提交前 2 頁試翻；完成後請先檢查譯文與排版，再決定是否翻整份。':'文件已交給本機助手。可關閉此頁，稍後再查看。'); await jobs();
  } finally {
    submittingPdf=false;
    updateWorkspaceControls();
  }
}
el('translate-pdf').onclick=()=>attempt(()=>submitPdf(false));
el('preview-pdf').onclick=()=>attempt(()=>submitPdf(true));
async function jobs() {
  if (polling) return; polling = true;
  const epoch=connectionEpoch;
  try {
    const result = await local.request('/jobs');
    if(epoch!==connectionEpoch || !connected)return;
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
      const cancel = ['queued','running'].includes(job.state);
      const remove = document.createElement('button'); remove.textContent = cancel ? '取消工作' : '清除原檔、譯本與快取';
      if(job.phase==='cancelling'&&cancel){remove.disabled=true;remove.textContent='正在取消…';}
      remove.onclick = () => attempt(async () => {
        remove.disabled=true;
        try{
          const result=await local.request('/jobs/' + job.id + (cancel ? '/cancel' : ''), {method:'DELETE'});
          if(cancel)notice(result.cancelling ? '已要求取消，正在等候工作程序結束。' : '工作已結束，已保留工作檔案。');
          else notice('已清除工作檔案。');
          await jobs();
        }catch(error){
          remove.disabled=false;
          if(cancel && error.code==='NOT_FOUND')throw new Error('目前助手未提供這個取消功能。請先等這份工作結束，之後雙擊 companion/start.cmd 載入新版。');
          throw error;
        }
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
