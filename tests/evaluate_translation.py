"""Repeatable artificial-text comparison; semantic quality is always human-reviewed."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
CORPUS = ROOT / 'tests/fixtures/translation-quality.json'
RUBRIC = ['忠實度', '完整度', '術語與繁中用語', '通順度']


def review_warnings(source, translation):
    warnings = []
    if re.sub(r'\s+', '', source) == re.sub(r'\s+', '', translation):
        warnings.append('譯文與原文相同；請核對是否未翻譯，或原文僅為代碼／專名。')
    if not re.search(r'[\u3400-\u4dbf\u4e00-\u9fff]', translation):
        warnings.append('未偵測到中文字；請核對目標語言，純代碼／專名可能不需翻譯。')
    if re.search(r'[\u3040-\u30ff]', translation):
        warnings.append('仍含日文假名；請核對是原文殘留，還是必須保留的名稱。')
    return warnings


def load_corpus(path=CORPUS):
    raw = Path(path).read_bytes()
    corpus = json.loads(raw)
    ids = [case['id'] for case in corpus['cases']]
    if len(set(ids)) != len(ids) or not ids:
        raise ValueError('案例識別不得重複，且至少需要一筆。')
    return corpus, hashlib.sha256(raw).hexdigest()


def imported_results(corpus, translations):
    expected = {case['id'] for case in corpus['cases']}
    if not isinstance(translations, dict) or set(translations) != expected:
        raise ValueError('匯入資料必須包含所有案例，且不能多出其他案例。請先產生範本。')
    if any(not isinstance(value, str) or not value.strip() or len(value) > 10000 for value in translations.values()):
        raise ValueError('每筆譯文需為非空白文字，最多 10,000 字元。')
    return {identifier: {'text': text, 'seconds': None, 'cached': None} for identifier, text in translations.items()}


def live_results(corpus, data_dir):
    sys.path.insert(0, str(ROOT / 'companion'))
    from app import Companion
    selected = json.loads((Path(data_dir) / 'config.json').read_text(encoding='utf-8')).get('model')
    if not selected:
        raise ValueError('請先在清讀設定選擇本機模型。')
    outputs, identity = {}, None
    # Never share the production job registry, pairing token, or translation cache.
    with tempfile.TemporaryDirectory(dir=ROOT / 'test-results') as directory:
        app = Companion(directory)
        app.config['model'] = selected
        try:
            for case in corpus['cases']:
                identifier = uuid.uuid4().hex
                body = {'kind': 'translate', 'source': case['language'], 'text': case['source']}
                if case.get('profile'):
                    body['profile'] = case['profile']
                if identity:
                    body['expectedModelIdentity'] = identity
                started = time.monotonic()
                state = app.start_inference(identifier, 'quality-evaluation', body)
                while state['stage'] not in {'done', 'failed', 'cancelled'}:
                    time.sleep(.05)
                    state = app.inference_jobs.get(identifier, 'quality-evaluation')
                if state['stage'] != 'done' or state.get('truncated') or not state.get('text'):
                    raise ValueError(f"{case['id']} 未完整完成；不以部分輸出計為成功。")
                if not state.get('modelIdentity'):
                    raise ValueError('模型未提供內容識別，不能建立可比較結果。')
                identity = state['modelIdentity']
                outputs[case['id']] = {'text': state['text'], 'seconds': round(time.monotonic() - started, 3),
                    'timings': state.get('timings', {}), 'cached': state.get('cached', False)}
                print(f"{case['id']}: {outputs[case['id']]['seconds']} 秒", flush=True)
        finally:
            app.inference_jobs.close()
    return outputs, {'model': selected, 'modelIdentity': identity, 'helperRevision': app.runtime_revision,
                     'scope': '正式助手推論流程、隔離工作與空白助手快取；未卸載模型，不能將首筆稱為冷啟動；不含網頁擷取、前端詞彙替換、PDF 或語音辨識。'}


def make_run(corpus, digest, system, outputs, provenance=None):
    return {'schema': 1, 'createdUtc': datetime.now(timezone.utc).isoformat(), 'corpusSha256': digest,
        'system': system, 'target': corpus['target'], 'scope': corpus['scope'], 'provenance': provenance or {},
        'cases': [{'id': case['id'], **outputs[case['id']],
                   'missingLiterals': [value for value in case['requiredLiterals'] if value not in outputs[case['id']]['text']],
                   'reviewWarnings': review_warnings(case['source'], outputs[case['id']]['text']),
                   'review': {**{name: None for name in RUBRIC}, 'notes': ''}}
                  for case in corpus['cases']]}


def validate_run(run, corpus, digest):
    if run.get('corpusSha256') != digest or run.get('target') != corpus['target']:
        raise ValueError('原文版本或目標語言不同，不能混合比較。')
    cases = run.get('cases', [])
    expected = {case['id'] for case in corpus['cases']}
    if len(cases) != len(expected) or {case['id'] for case in cases} != expected:
        raise ValueError('結果有遺漏或重複案例，不能產生比較報告。')
    for case in cases:
        if not isinstance(case.get('text'), str) or not case['text'].strip():
            raise ValueError('結果含有空白譯文。')
        for name in RUBRIC:
            score = case.get('review', {}).get(name)
            if score is not None and (type(score) is not int or score not in (0, 1, 2)):
                raise ValueError('人工分數只能填 0、1、2 或 null（尚未評分）。')


def report(corpus, digest, runs):
    for run in runs:
        validate_run(run, corpus, digest)
    lines = ['# 翻譯品質對照（人工樣本）', '', corpus['scope'], '',
        '同一份原文依 A、B 等代號呈現；系統對照另存 key.json，請評閱者先不查看。', '',
        '四項人工評分：忠實度、完整度、術語與繁中用語、通順度。各項 0＝明顯錯誤、1＝可理解但需修改、2＝符合要求；未評分必須保留 null。', '',
        '缺少固定字串只表示值得核對，不能自動判定誤譯；字串全部存在也不代表語意正確。速度不計入品質分數，外部匯入未量測速度會留空。', '',
        '## 評閱狀態', '']
    mapping = {}
    by_run = []
    for index, run in enumerate(runs):
        alias = chr(ord('A') + index)
        mapping[alias] = {'system': run['system'], 'provenance': run.get('provenance', {}), 'createdUtc': run.get('createdUtc')}
        reviewed = sum(all(type(case.get('review', {}).get(name)) is int for name in RUBRIC) for case in run['cases'])
        lines.append(f"- {alias}：{reviewed}/{len(corpus['cases'])} 筆完成四項人工評分。")
        by_run.append((alias, {case['id']: case for case in run['cases']}))
    for case in corpus['cases']:
        lines.extend(['', f"## {case['id']}", '', '**原文**', '', '```text', case['source'], '```', '', '**核對重點：** ' + case['reviewNotes']])
        for alias, outputs in by_run:
            output = outputs[case['id']]
            seconds = output.get('seconds')
            lines.extend(['', f"### 譯文 {alias}", '', '```text', output['text'], '```', '',
                          '耗時：' + (str(seconds) + ' 秒' if seconds is not None else '未量測') + '；固定字串待核對：' + ('、'.join(output.get('missingLiterals', [])) or '無'),
                          '語言待核對：' + ('；'.join(review_warnings(case['source'], output['text'])) or '無明顯字元訊號；仍須核對語意。'),
                          '人工評分：' + '；'.join(f"{name}＝{output.get('review', {}).get(name) if output.get('review', {}).get(name) is not None else '待評'}" for name in RUBRIC)])
    return '\n'.join(lines) + '\n', mapping


def write_new(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf-8') as file:
        file.write(text)


def main():
    parser = argparse.ArgumentParser(description='清讀人工原文品質驗收；不會自動連接商用服務')
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--live', action='store_true')
    action.add_argument('--template', action='store_true')
    action.add_argument('--import-translations', type=Path)
    action.add_argument('--reports', nargs='+', type=Path)
    parser.add_argument('--system', default='qingread-local')
    parser.add_argument('--data-dir', type=Path, default=ROOT / 'companion/data')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        corpus, digest = load_corpus()
        if args.output.exists():
            raise ValueError('輸出檔已存在，請換檔名；不覆蓋既有結果或人工評分。')
        if args.template:
            value = {case['id']: '' for case in corpus['cases']}
        elif args.reports:
            if not 1 <= len(args.reports) <= 26:
                raise ValueError('每份比較限 1 到 26 組結果。')
            text, key = report(corpus, digest, [json.loads(path.read_text(encoding='utf-8-sig')) for path in args.reports])
            key_path = args.output.with_suffix('.key.json')
            if key_path.exists():
                raise ValueError('系統代號對照檔已存在，請換輸出檔名。')
            write_new(key_path, json.dumps(key, ensure_ascii=False, indent=2))
            write_new(args.output, text)
            print('已產生比較報告；語意品質仍需人工評閱。')
            return 0
        else:
            if not re.fullmatch(r'[A-Za-z0-9_.-]{1,60}', args.system):
                raise ValueError('系統名稱限英數字、句點、底線與連字號，最多 60 字。')
            if args.live:
                (ROOT / 'test-results').mkdir(exist_ok=True)
                outputs, provenance = live_results(corpus, args.data_dir)
            else:
                outputs = imported_results(corpus, json.loads(args.import_translations.read_text(encoding='utf-8-sig')))
                provenance = {'scope': '使用者自行取得的譯文；未由本工具量測速度或驗證服務設定。'}
            value = make_run(corpus, digest, args.system, outputs, provenance)
        write_new(args.output, json.dumps(value, ensure_ascii=False, indent=2) + '\n')
        print('結果已儲存；尚未進行人工語意評分。')
        return 0
    except (OSError, ValueError, KeyError, TypeError) as error:
        print('驗收未完成：' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
