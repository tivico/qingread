'use strict';
const el = id => document.getElementById(id);
const local = QingReadLocal;
let connected = false, polling = false;
let pairing = null;
const notice = text => { el('notice').textContent = text; };
async function attempt(action) { try { await action(); } catch (error) { notice(error.message); } }
async function refresh() {
  const health = await local.request('/health'); connected = true;
  el('health').textContent = `助手已連線 · Ollama ${health.ollama ? '已啟動' : '未連線'} · PDF 資源${health.pdf_assets_ready ? '已準備' : '未準備'} · 語音${health.speech_ready ? '已準備' : '未準備'}`;
  el('model').replaceChildren(...health.models.map(name => { const option = document.createElement('option'); option.value = name; option.textContent = name; return option; }));
  el('model').value = health.selected_model || health.models[0] || '';
  await jobs();
}
el('connect').onclick = () => {
  if(pairing)return;
  const controller=new AbortController();pairing=controller;
  el('connect').disabled=true;el('pair').disabled=true;el('pair-cancel').hidden=false;
  el('pair-status').textContent='正在連接本機助手…';
  // Start the permission request inside this click, before the first await.
  void (async()=>{
    try {
      if(!await chrome.permissions.request({origins:['http://127.0.0.1/*']}))throw new Error('需要允許本機連線才能配對。');
      if(controller.signal.aborted)throw new DOMException('Stopped','AbortError');
      await local.connect({signal:controller.signal,onPending:code=>{
        el('pair-status').textContent=`確認數字：${code}。請在「清讀 · 允許本機連線」視窗確認數字相同，再按「是」。不需輸入或複製數字；視窗最多等候 90 秒。`;
      }});
      el('pair-status').textContent='配對完成，可以使用本機助手。';notice('配對完成。');
      await refresh();
    }catch(error){
      el('pair-status').textContent=error.name==='AbortError'?'已取消配對。':error.message;
    }finally{
      if(pairing===controller){pairing=null;el('connect').disabled=false;el('pair').disabled=false;el('pair-cancel').hidden=true;}
    }
  })();
};
el('pair-cancel').onclick=()=>pairing?.abort();
window.addEventListener('pagehide',()=>pairing?.abort());
el('pair').onclick = () => {
  if(pairing)return;
  // Request permission directly within the click's user activation.
  const permission = chrome.permissions.request({ origins: ['http://127.0.0.1/*'] });
  void attempt(async () => {
    if (!await permission) throw new Error('需要本機連線權限才能使用助手。');
    await local.pair(el('token').value.trim()); el('token').value = ''; await refresh(); notice('配對完成。');
  });
};
el('refresh').onclick = () => attempt(refresh);
el('save-model').onclick = () => attempt(async () => { await local.request('/settings', { body: { model: el('model').value } }); notice('已選擇本機翻譯模型。'); });
for (const [id, kind] of [['prepare-pdf','pdf-assets'], ['prepare-speech','speech']]) el(id).onclick = () => attempt(async () => { await local.request('/prepare', { body: { kind } }); notice('開始下載，請查看工作狀態。'); await jobs(); });
el('translate-pdf').onclick = () => attempt(async () => {
  const file = el('pdf').files[0];
  if (!file || file.size > 64 * 1024 * 1024) throw new Error('請選擇 64 MB 以內的 PDF。');
  el('translate-pdf').disabled = true;
  try {
    const query = new URLSearchParams({ source: el('pdf-source').value, pages: el('pages').value.trim(), scanned: el('scanned').checked });
    await local.request('/pdf?' + query, { body: file }); notice('文件已交給本機助手。可關閉此頁，稍後再查看。'); await jobs();
  } finally { el('translate-pdf').disabled = false; }
});
async function jobs() {
  if (polling) return; polling = true;
  try {
    const result = await local.request('/jobs');
    const nodes = result.jobs.slice().reverse().map(job => {
      const node = document.createElement('article'), title = document.createElement('strong'), description = document.createElement('p');
      title.textContent = `${{pdf:'PDF 翻譯',speech:'語音模型','pdf-assets':'PDF 資源'}[job.kind] || '工作'} · ${{queued:'等待中',running:'處理中',done:'完成',failed:'失敗',cancelled:'已取消'}[job.state] || job.state}`;
      description.textContent = job.message; node.append(title, description);
      for (const file of job.outputs) {
        const button = document.createElement('button'); button.className = 'download'; button.textContent = '下載 ' + file.name;
        button.onclick = () => attempt(async () => {
          const blob = await local.request(`/jobs/${job.id}/files/${encodeURIComponent(file.name)}`, { binary: true });
          const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = file.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
        }); node.append(button);
      }
      const remove = document.createElement('button'); remove.textContent = ['queued','running'].includes(job.state) ? '取消工作' : '清除原檔、譯本與快取';
      remove.onclick = () => attempt(async () => { await local.request('/jobs/' + job.id, { method: 'DELETE' }); await jobs(); }); node.append(remove); return node;
    });
    el('jobs').replaceChildren(...nodes);
    if (!nodes.length) el('jobs').textContent = '目前沒有工作。';
  } finally { polling = false; }
}
setInterval(() => { if (connected && !document.hidden) void attempt(jobs); }, 3000);
void attempt(async()=>{
  const saved=await chrome.storage.session.get('companionToken');
  if(saved.companionToken)await refresh();
  else notice('按「連接本機助手」開始；請先啟動 companion/start.cmd。');
});
