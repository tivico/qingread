'use strict';
globalThis.QingReadVideoSummary = (() => {
  // Byte budgets conservatively bound tokens for CJK/emoji as well as English.
  const CHUNK_SIZE = 5000, MAX_CHARS = 240000, NOTE_SIZE = 6000;
  const length = text => Array.from(text).length;
  const bytes = text => new TextEncoder().encode(text).length;
  const pointBytes = point => point.length === 2 ? 4 : point.charCodeAt(0) <= 127 ? 1 : point.charCodeAt(0) <= 2047 ? 2 : 3;
  function time(seconds) {
    const value = Math.floor(seconds), s = String(value % 60).padStart(2,'0');
    const m = Math.floor(value / 60);
    return m < 60 ? `${m}:${s}` : `${Math.floor(m/60)}:${String(m%60).padStart(2,'0')}:${s}`;
  }
  function chunks(segments) {
    if (!Array.isArray(segments) || !segments.length || segments.length > 12000) throw new Error('逐字稿段落格式或數量不正確。');
    let count = 0, last = -1, current = null; const output = [];
    for (const segment of segments) {
      if (!Number.isFinite(segment.start) || segment.start < last || segment.start < 0 ||
          typeof segment.text !== 'string' || !segment.text.trim()) throw new Error('逐字稿文字或時間格式不正確。');
      last = segment.start;
      const points = Array.from(segment.text); count += points.length;
      if (count > MAX_CHARS) throw new Error('逐字稿超過 240,000 字元上限。');
      for (let offset = 0; offset < points.length;) {
        if (!current || current.size >= CHUNK_SIZE) {
          current = {start:segment.start, end:segment.start, text:'', size:0}; output.push(current);
        }
        const prefix = current.text ? '\n' : '';
        const room = CHUNK_SIZE - current.size - prefix.length;
        if (room <= 0) { current.size = CHUNK_SIZE; continue; }
        let end=offset, used=0;
        while(end<points.length && used+pointBytes(points[end])<=room)used+=pointBytes(points[end++]);
        if(end===offset){current.size=CHUNK_SIZE;continue;}
        const piece=points.slice(offset,end).join('');offset=end;
        current.text += prefix+piece; current.size += prefix.length+used; current.end = segment.start;
      }
    }
    return output;
  }
  function groups(notes) {
    const output = []; let current = '', size = 0;
    for (const note of notes) {
      const entry = `[${time(note.start)}–${time(note.end)}]\n${note.text}`;
      const extra = bytes(entry) + (current ? 2 : 0);
      if (extra > NOTE_SIZE) throw new Error('分段摘要過長，請更換模型後重試。');
      if (size+extra > NOTE_SIZE) { output.push(current); current = ''; size = 0; }
      current += (current ? '\n\n' : '')+entry; size = bytes(current);
    }
    if (current) output.push(current);
    return output;
  }
  async function summarize(segments, {request, signal, onChunk, onStage, onProgress, onTiming, detail='concise'}) {
    if(!['concise','detailed'].includes(detail))throw new Error('影片摘要詳略設定不正確。');
    const parts = chunks(segments), notes = [], timings=[]; let identity;
    function check() { if (signal.aborted) throw new DOMException('Stopped','AbortError'); }
    async function run(text, summaryMode) {
      check();
      const started=Date.now();
      const result = await request('/summarize', {managed:true, signal,
        body:{text, summaryMode, ...(detail==='concise'?{summaryDetail:'concise'}:{}), ...(identity ? {expectedModelIdentity:identity} : {})},
        onProgress:event => {check(); onProgress?.(event);}});
      check();
      if (result.truncated) throw new Error('模型輸出達到上限，摘要尚未完整。已完成段落仍保留，可更換模型重試。');
      if (typeof result.text !== 'string' || !result.text.trim() || bytes(result.text) > 1800)
        throw new Error('模型沒有回傳有效的精簡摘要，請更換模型後重試。');
      if (!/^[a-f0-9]{64}$/.test(result.modelIdentity || '')) throw new Error('無法確認本機模型身分，請更新助手或更換模型後重試。');
      if (identity && result.modelIdentity !== identity) throw new Error('本機模型已變更，請重新整理摘要。');
      identity = result.modelIdentity;
      const timing={mode:summaryMode,elapsedMs:Date.now()-started,cached:result.cached===true};
      for(const key of ['queueMs','prepareMs','loadMs','promptMs','generationMs']) {
        const value=result.timings?.[key];
        if(Number.isFinite(value) && value>=0)timing[key]=value;
      }
      timings.push(timing);onTiming?.(timings.map(value=>({...value})));
      return result.text;
    }
    for (let i=0; i<parts.length; i++) {
      check(); onStage(`正在整理第 ${i+1}／${parts.length} 段字幕`);
      const text = await run(parts[i].text, 'video-chunk');
      const note = {start:parts[i].start, end:parts[i].end, text}; notes.push(note); onChunk(note, i+1, parts.length);
    }
    let level = notes;
    while (true) {
      check(); const batches = groups(level), next = [];
      for (let i=0; i<batches.length; i++) {
        onStage(`正在整合總覽 ${i+1}／${batches.length}`);
        const text = await run(batches[i], 'video-overview');
        next.push({start:notes[0].start, end:notes.at(-1).end, text});
      }
      if (next.length === 1) return {text:next[0].text, notes, timings};
      if (next.length >= level.length) throw new Error('摘要無法縮減，請更換模型後重試。');
      level = next;
    }
  }
  return {time, chunks, groups, summarize};
})();
