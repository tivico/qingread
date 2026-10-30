const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LIMITS, splitText, localize, errorText } = require('../extension/core.js');
const { parseGlossary, applyGlossary } = require('../extension/core.js');
test('glossary uses longest literal match without chained replacements or regex execution',()=>{
  const rules=parseGlossary('內存 => 記憶體\n內存池 => 記憶體池\na.b => $&\n記憶體 => RAM');
  assert.equal(applyGlossary('內存池 內存 a.b axb 記憶體',rules),'記憶體池 記憶體 $& axb RAM');
  assert.equal(applyGlossary('原文',parseGlossary('')),'原文');
});
test('glossary rejects duplicate, empty, malformed and excessive rules',()=>{
  for(const input of ['a => b\na => c','a =>','a => b => c',Array.from({length:101},(_,i)=>`${i} => a`).join('\n')])assert.throws(()=>parseGlossary(input));
});
test('optional terminology changes only the five explicit traditional Chinese terms', () => {
  assert.equal(localize('默認軟件使用鼠標，視頻存在硬盤。資訊與名稱保持不變。'), '預設軟體使用滑鼠，影片存在硬碟。資訊與名稱保持不變。');
});

test('long input retains every character and never breaks a Unicode code point', () => {
  const input = ('A sentence. 繁體中文🙂𠮷\n').repeat(400);
  const chunks = splitText(input);
  assert.equal(chunks.join(''), input);
  assert.ok(chunks.every(chunk => Array.from(chunk).length <= LIMITS.chunk));
  assert.ok(chunks.every(chunk => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(chunk)));
});
test('input without punctuation still has bounded chunks', () => {
  assert.deepEqual(splitText('a'.repeat(2500)).map(x => x.length), [1200, 1200, 100]);
  assert.deepEqual(splitText(''), []);
  assert.throws(() => splitText('abc', 0));
});
test('error messages do not include potentially sensitive error content', () => {
  assert.match(errorText({ name: 'NetworkError' }), /下載/);
  assert.match(errorText({ name: 'NotSupportedError' }), /不支援/);
  assert.ok(!errorText(new Error('secret article')).includes('secret article'));
});
test('manifest defaults to temporary access with optional site grants and restricts network to local companion', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../extension/manifest.json')));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions.slice().sort(), ['activeTab', 'scripting', 'sidePanel', 'storage']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.deepEqual(manifest.optional_host_permissions, ['http://127.0.0.1/*', 'https://*/*', 'http://*/*']);
  assert.deepEqual(manifest.optional_permissions, ['tabCapture']);
  assert.match(manifest.content_security_policy.extension_pages, /connect-src 'self' http:\/\/127.0.0.1:8765;/);
});

test('toolbar opens panel directly using action gesture without automatically toggling it',()=>{
  const vm=require('node:vm');let clicked,behavior,opened;
  const chrome={sidePanel:{setPanelBehavior:async value=>{behavior=value;},open:async value=>{opened=value;}},runtime:{onInstalled:{addListener(){}},onStartup:{addListener(){}},onMessage:{addListener(){}}},action:{onClicked:{addListener(fn){clicked=fn;}}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../extension/background.js'),'utf8'),{chrome,console});
  assert.equal(behavior.openPanelOnActionClick,false);
  clicked({id:7,windowId:3});assert.equal(opened.windowId,3);
});

test('injection diagnostics classify known browser errors without exposing raw messages',()=>{
 const classify=require('../extension/core.js').injectionErrorName;
 for(const [message,expected] of [['Cannot access contents of url "https://learn.nvidia.com/private"','PageAccessError'],['No tab with id: 7','PageChangedError'],['Could not load file: content.js','ExtensionLoadError'],['secret article','PageInjectionError']])assert.equal(classify(new Error(message)),expected);
});
