// Shared by the extension panel and Node's built-in test runner. No dependencies.
(function (root) {
  const LIMITS = Object.freeze({ paragraphs: 200, characters: 60000, chunk: 1200 });
  const LANGUAGES = Object.freeze({ en: '英文', ja: '日文', ko: '韓文', de: '德文', fr: '法文', es: '西班牙文' });
  const TERMS = Object.freeze({ '軟件': '軟體', '硬盤': '硬碟', '鼠標': '滑鼠', '默認': '預設', '視頻': '影片' });
  function localize(text) {
    return text.replace(/軟件|硬盤|鼠標|默認|視頻/gu, term => TERMS[term]);
  }
  function parseGlossary(value = '') {
    if (typeof value !== 'string' || value.length > 17000) throw new Error('詞彙表太長，最多 100 組。');
    const rules = [], seen = new Set();
    for (const line of value.split(/\r?\n/u)) {
      if (!line.trim()) continue;
      const parts = line.split('=>').map(part => part.trim());
      if (parts.length !== 2 || parts.some(part => !part || part.length > 80)) throw new Error('每行請填「原譯詞 => 慣用詞」，左右各最多 80 字元。');
      if (seen.has(parts[0])) throw new Error('同一個原譯詞只能設定一次。');
      seen.add(parts[0]); rules.push(parts);
    }
    if (rules.length > 100) throw new Error('詞彙表最多 100 組。');
    return rules;
  }
  function applyGlossary(text, rules) {
    if (!rules.length) return text;
    const mapping = new Map(rules);
    const patterns = [...mapping.keys()].sort((a,b) => b.length-a.length).map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return text.replace(new RegExp(patterns.join('|'), 'gu'), term => mapping.get(term));
  }
  function translationWarnings(source, output, language) {
    const warnings=[];
    if(language==='ja' && /[\u3040-\u30ff]/u.test(output))warnings.push('譯文仍含日文，請核對是否有原文未翻或必須保留的專名。');
    const words=source.match(/\p{L}{2,}/gu)||[];
    if(source.length>=40 && words.length>=4 && !/\p{Script=Han}/u.test(output) &&
       (output.match(/\p{L}{2,}/gu)||[]).length>=4)warnings.push('譯文沒有中文字，可能未翻成繁中；純代碼與專名可能不需翻譯，請對照原文。');
    return warnings;
  }
  function splitText(text, limit = LIMITS.chunk) {
    if (!Number.isInteger(limit) || limit < 2) throw new Error('Invalid chunk size');
    const points = Array.from(text);
    const chunks = [];
    while (points.length) {
      let end = Math.min(limit, points.length);
      if (end < points.length) {
        for (let i = end - 1; i > end / 2; i--) {
          if (/[。！？.!?\n\s]/u.test(points[i])) { end = i + 1; break; }
        }
      }
      chunks.push(points.splice(0, end).join(''));
    }
    return chunks;
  }
  async function translateWebItem(item, translateChunk, format) {
    async function translateProse(text) {
      const outputs = [];
      for (const chunk of splitText(text)) outputs.push(await translateChunk(chunk));
      return format(outputs.join('\n'));
    }
    if (!item.parts) return translateProse(item.text);

    // Keep sentence context when the engine can preserve placeholders.
    const literals = [];
    let prefix = 'ZXQRCODE';
    while (item.text.includes(prefix)) prefix += 'X';
    const masked = item.parts.map(part => typeof part === 'string' ? part :
      prefix + (literals.push(part.literal) - 1) + 'QXZ').join('');
    if (Array.from(masked).length <= LIMITS.chunk) {
      const output = await translateChunk(masked);
      const pattern = new RegExp(prefix + '(\\d+)QXZ', 'gu');
      const markers = [...output.matchAll(pattern)];
      const ids = markers.map(match => Number(match[1]));
      const prose = output.replace(pattern, '');
      if (ids.length === literals.length && new Set(ids).size === literals.length &&
          ids.every(id => id < literals.length) && !prose.includes(prefix) && /\p{L}/u.test(prose)) {
        let translated = '', cursor = 0;
        for (const [index, marker] of markers.entries()) {
          translated += format(output.slice(cursor, marker.index)) + literals[ids[index]];
          cursor = marker.index + marker[0].length;
        }
        return translated + format(output.slice(cursor));
      }
    }

    // If placeholders were rewritten, translate only the surrounding prose.
    const output = [];
    for (const part of item.parts) {
      if (typeof part !== 'string') output.push(part.literal);
      else if (!/\p{L}/u.test(part)) output.push(part);
      else output.push(part.match(/^\s*/u)[0] + await translateProse(part.trim()) + part.match(/\s*$/u)[0]);
    }
    return output.join('');
  }
  function injectionErrorName(error) {
    const message = String(error?.message || '');
    if (/extension context invalidated|could not load file|cannot load file/i.test(message)) return 'ExtensionLoadError';
    if (/no tab with id|frame.*removed|no frame with id|document.*unloaded|frame.*not found/i.test(message)) return 'PageChangedError';
    if (/cannot access.*chrome:\/\/|extensions gallery cannot be scripted|cannot access a chrome/i.test(message)) return 'PageRestrictedError';
    if (/cannot access contents|host permission|permission.*denied|access.*denied/i.test(message)) return 'PageAccessError';
    return 'PageInjectionError';
  }
  function errorText(error) {
    switch (error?.name) {
      case 'ExtensionLoadError': return '清讀的讀取程式未能載入。請重新載入外掛並重新整理網頁，確認外掛資料夾完整。';
      case 'PageChangedError': return '頁面正在切換或已重新載入。請等頁面穩定後再開始。';
      case 'PageInjectionError': return '讀取程式未能啟動，原因尚未確認；這不一定是網站權限問題。';
      case 'PageAccessError': return '需要先允許清讀讀取這個網站，才能開始翻譯。請使用下方網站授權入口。';
      case 'PageMissingError': return '找不到目前分頁。請先開啟要翻譯的網頁。';
      case 'PageRestrictedError': return '這類分頁不能翻譯。請開啟一般網站，Chrome 設定頁等內部頁面不支援。';
      case 'PageReadError': return '沒有收到網頁回應。請重新整理網頁並重開清讀，再試一次。';
      case 'TimeoutError': return '本機工作超過三分鐘沒有完成，已要求停止。可按「測試引擎」確認模型狀態。';
      case 'NotSupportedError': return '這個 Chrome 或所選語言組合尚不支援本機翻譯。請更新 Chrome，或改選來源語言。';
      case 'NotAllowedError': return 'Chrome 未允許啟動。請保持側邊欄開啟，再按一次「開始翻譯」。';
      case 'QuotaExceededError': return '這段文字超過引擎限制，請先選取較短文字再試。';
      case 'NetworkError': return '語言包下載失敗。請確認網路與磁碟空間，再重新開始。';
      case 'AbortError': return '翻譯已停止。';
      default: return '本次操作未完成。請查看下方失敗步驟，再決定如何重試。';
    }
  }
  root.QingReadCore = Object.freeze({ LIMITS, LANGUAGES, TERMS, localize, splitText, translateWebItem, errorText, injectionErrorName, parseGlossary, applyGlossary, translationWarnings });
  if (typeof module !== 'undefined') module.exports = root.QingReadCore;
})(globalThis);
