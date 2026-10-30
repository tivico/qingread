const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCueBuffer, TIMING } = require('../extension/caption-state.js');
const cue = (text, version, timelineVersion = 1) => ({ text, version, timelineVersion });

test('caption waits for stable wording and submits it once', () => {
  const buffer = createCueBuffer();
  buffer.observe(cue('Hello', 1), 0);
  assert.equal(buffer.take(300), null);
  buffer.observe(cue('Hello world.', 2), 350);
  assert.equal(buffer.take(350 + TIMING.settle - 1), null);
  assert.deepEqual(buffer.take(350 + TIMING.settle), cue('Hello world.', 2));
  assert.equal(buffer.take(5000), null);
});

test('continuously growing captions have a bounded wait', () => {
  const buffer = createCueBuffer();
  for (let i = 0; i <= 10; i++) {
    buffer.observe(cue('word '.repeat(i + 1), i), i * 200);
    if (i < 10) assert.equal(buffer.take(i * 200), null);
  }
  assert.equal(buffer.take(TIMING.maxWait).version, 10);
});

test('unrelated new cue gets its own stability window', () => {
  const buffer = createCueBuffer();
  buffer.observe(cue('First phrase', 1), 0);
  buffer.observe(cue('Different phrase', 2), 1900);
  assert.equal(buffer.take(2000), null);
  assert.equal(buffer.take(2550).text, 'Different phrase');
});

test('after a maximum-wait submission the next growing phrase waits again', () => {
  const buffer = createCueBuffer();
  for (let i = 0; i <= 10; i++) buffer.observe(cue('word '.repeat(i + 1), i), i * 200);
  assert.equal(buffer.take(2000).version, 10);
  buffer.observe(cue('word '.repeat(12), 11), 2200);
  assert.equal(buffer.take(2250), null);
  assert.equal(buffer.take(2850).version, 11);
});

test('while translation is busy only the latest cue survives', () => {
  const buffer = createCueBuffer();
  buffer.observe(cue('First phrase', 1), 0);
  assert.equal(buffer.take(650).version, 1);
  buffer.observe(cue('Second phrase', 2), 700);
  buffer.observe(cue('Third phrase', 3), 1500);
  assert.equal(buffer.take(2150).version, 3);
  assert.equal(buffer.take(5000), null);
});

test('blank source drops pending work and seek permits a new translation', () => {
  const buffer = createCueBuffer();
  buffer.observe(cue('Hello', 1), 0);
  buffer.observe(cue('', 2), 500);
  assert.equal(buffer.take(2000), null);
  buffer.observe(cue('Hello', 1, 2), 2100);
  assert.deepEqual(buffer.take(2750), cue('Hello', 1, 2));
});

test('normalization removes layout-only line breaks before translating', () => {
  const buffer = createCueBuffer();
  buffer.observe(cue('  Hello\n  world.  ', 1), 0);
  assert.equal(buffer.take(650).text, 'Hello world.');
});

test('rolling captions preserve the wait budget but coincidental short overlap does not', () => {
  const buffer = createCueBuffer();
  buffer.observe(cue('Earlier context keep all these files', 1), 0);
  buffer.observe(cue('Earlier context keep all these files safe', 2), 1500);
  buffer.observe(cue('keep all these files safe today', 3), 1900);
  assert.equal(buffer.take(2000).version, 3);
  buffer.observe(cue('A different sentence for you', 4), 2100);
  buffer.observe(cue('for you another topic starts', 5), 4000);
  assert.equal(buffer.take(4100), null);
  buffer.observe(cue('another topic starts again', 6, 2), 4200);
  assert.equal(buffer.take(4250), null, 'A seek must start a new budget');
});

test('fast YouTube rolling trace cannot keep resetting the first translation', () => {
  const { events } = require('./fixtures/youtube-fast-caption-timing.json');
  const buffer = createCueBuffer(), sent = [];
  let index = 0;
  for (let now = 0; now <= 17000; now += 250) {
    while (index + 1 < events.length && events[index + 1].ms <= now) index++;
    buffer.observe(cue(events[index].text, index), now);
    if (buffer.take(now)) sent.push(now);
  }
  assert.equal(sent[0], 2000, 'Previously the first request waited until 12,750 ms');
  assert.ok(sent.length >= 6 && sent.length <= 9, 'Batch rolling updates without a request for each word');
  for (let i = 1; i < sent.length; i++) assert.ok(sent[i] - sent[i-1] <= 2500);
});
