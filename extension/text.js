'use strict';
(() => {
  const el = id => document.getElementById(id);
  let active = null;
  let retry = null;
  const settings = () => JSON.stringify([el('source').value,el('engine').value,el('terms').checked,glossaryRules]);
  let outputComplete = false, outputRevision = 0;
  function count() { el('text-count').textContent = `${el('text-input').value.length.toLocaleString()} / 6,000 字元`; }
  function invalidate() { retry=null;el('text-retry').hidden=true;outputComplete = false; outputRevision++; el('text-output').value = ''; el('text-copy').disabled = true; count(); }
  function stop() { active?.controller.abort(); }
  el('text-input').addEventListener('input', () => { invalidate(); el('text-status').textContent = '原文已變更，請重新翻譯。'; });
  el('text-clear').onclick = () => {
    stop(); el('text-input').value = ''; invalidate();
    el('text-status').textContent = '已清空原文與譯文。';
  };
  el('text-stop').onclick = stop;
  async function translate(resume = false) {
    if (!ready || running) return;
    const input = el('text-input').value;
    if (!input.trim()) { el('text-status').textContent = '請先輸入或貼上原文。'; el('text-input').focus(); return; }
    if (input.length > 6000) { el('text-status').textContent = '每次最多 6,000 字元，請分次翻譯。'; return; }
    const snapshot = settings(), saved = resume ? retry : null;
    if(resume && (!saved || saved.input!==input || saved.settings!==snapshot)) {
      retry=null;el('text-retry').hidden=true;el('text-status').textContent='原文或翻譯設定已變更，請重新翻譯全文。';return;
    }
    const chunks = splitText(input), outputs = saved ? [...saved.outputs] : [];
    const job = {id:crypto.randomUUID(),kind:'text',controller:new AbortController(),translator:null,resumeIdentity:saved?.identity,
      report: message => { if (active === job && !job.controller.signal.aborted) el('text-status').textContent = message + (outputs.length && !outputComplete && !message.includes('尚未完整') ? ` 已完成 ${outputs.length} / ${chunks.length} 段，尚未完整。` : ''); }};
    const glossary = glossaryRules.map(rule => [...rule]), terms = el('terms').checked;
    active = running = job; controls(true);
    el('text-input').readOnly = true; el('text-stop').disabled = false; invalidate();
    el('text-retry').disabled=true;
    if(outputs.length){el('text-output').value=QingReadCore.applyGlossary(terms?localize(outputs.join('\n')):outputs.join('\n'),glossary);el('text-copy').disabled=false;}
    job.report('正在準備翻譯引擎…');
    try {
      // Preserve click activation for Chrome's model preparation.
      job.creation = Promise.resolve(createTranslator(job,el('source').value)).then(translator=>({translator}),error=>({error}));
      const result = await waitForEngine(job.creation,job); assertLive(job);
      if (result.error) throw result.error;
      job.translator = result.translator;
      for (const chunk of chunks.slice(outputs.length)) {
        job.report(`正在翻譯 ${outputs.length + 1} / ${chunks.length}…${outputs.length ? ' 已顯示部分譯文，尚未完整。' : ''}`);
        const output = await waitForEngine(job.translator.translate(chunk,{signal:job.controller.signal}),job);
        assertLive(job);
        if (typeof output !== 'string' || !output.trim() || output.length > 20000) throw new Error('Invalid output');
        outputs.push(output.trim());
        // Only publish complete chunks; never present token fragments as finished text.
        const translation = outputs.join('\n');
        el('text-output').value = QingReadCore.applyGlossary(terms ? localize(translation) : translation,glossary);
        outputRevision++;
        el('text-copy').disabled = false;
      }
      outputComplete = true;
      job.report('翻譯完成。可複製譯文，或修改原文後再翻一次。');
    } catch (error) {
      job.cancelled = error.name === 'AbortError' || error.name === 'TimeoutError';
      if (active === job && el('text-input').value) {
        const reason = error.name === 'AbortError' ? '已停止。' : failure(error);
        el('text-status').textContent = reason + (outputs.length
          ? ` 已保留 ${outputs.length} / ${chunks.length} 段譯文，尚未完整；可先複製。`
          : ' 本次未產生完整譯文。');
        if(outputs.length && outputs.length<chunks.length && error.code!=='MODEL_CHANGED' &&
            (el('engine').value!=='local' || job.translator?.identity)) {
          retry={input,settings:snapshot,outputs:[...outputs],identity:job.translator?.identity};
          el('text-retry').hidden=false;
        }
      }
    } finally {
      job.controller.abort();
      const cleanup = job.translator?.destroy();
      if (job.cancelled && job.translator?.managed && active === job && el('text-input').value) {
        const prior = el('text-status').textContent;
        el('text-status').textContent = '正在取消本機工作…' + (outputs.length ? ' 已完成的部分譯文會保留。' : '');
        const results = await cleanup;
        if(active===job && el('text-input').value)el('text-status').textContent = prior + ' ' + QingReadLocal.cancellationText(results);
      }
      if (!job.translator) void job.creation?.then(result=>result.translator?.destroy());
      if (running === job) {running = null; controls(false);}
      if (active === job) {active = null; el('text-input').readOnly = false; el('text-stop').disabled = true;el('text-retry').disabled=false;}
    }
  }
  el('text-start').onclick=()=>translate(false);
  el('text-retry').onclick=()=>translate(true);
  el('text-copy').onclick = async () => {
    const output = el('text-output').value;
    if (!output) return;
    const revision = outputRevision;
    try {
      await navigator.clipboard.writeText(output);
      if (revision === outputRevision) el('text-status').textContent = outputComplete ? '已複製譯文。' : '已複製部分譯文；內容尚未完整。';
    }
    catch { if (revision === outputRevision) el('text-status').textContent = '無法自動複製，請反白譯文手動複製。' + (outputComplete ? '' : '目前內容尚未完整。'); }
  };
})();
