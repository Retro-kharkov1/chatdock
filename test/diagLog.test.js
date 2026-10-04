'use strict';

// BUG-05 attempt 2: the temporary notification-click diagnostic log must never carry message text,
// titles or ids (src/main/diagLog.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createDiagLog, redactUrl, redactPath, describeShape, MAX_BYTES } = require('../src/main/diagLog.js');

test('redactPath keeps known route words and replaces every other segment with :id', () => {
  assert.equal(redactPath('/room/AAAAb3KxY_8/thread/Zq9'), '/room/:id/thread/:id');
  assert.equal(redactPath('/dm/abcdefghij'), '/dm/:id');
  assert.equal(redactPath('/u/0/app/chat/Jane-Doe'), '/u/:id/app/chat/:id');
});

test('redactUrl drops query values and fragment text but keeps key names; garbage is not echoed', () => {
  assert.equal(redactUrl('https://chat.google.com/room/AAAA?token=secret&x=1#msg-9'), 'https://chat.google.com/room/:id?token&x#frag');
  assert.equal(redactUrl('/room/AAAA', 'https://chat.google.com'), 'https://chat.google.com/room/:id');
  assert.equal(redactUrl('http://[bad'), '<unparseable>');
});

test('describeShape reports keys and types, never string content', () => {
  const s = describeShape({ title: 'Secret subject', url: '/room/AAAA/thread/BBBB', n: 3, nested: { a: ['x'] } });
  assert.equal(s.includes('Secret'), false);
  assert.match(s, /title:str\(14\)/);
  assert.match(s, /url:url\(https:\/\/x\.invalid\/room\/:id\/thread\/:id\)/);
  assert.match(s, /n:number/);
});

test('describeShape is bounded in depth and key count', () => {
  const deep = { a: { b: { c: { d: 1 } } } };
  assert.match(describeShape(deep), /\{\.\.\.\}/);
  const wide = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, 1]));
  assert.equal(describeShape(wide).split(',').length, 12);
});

test('note writes one line with timestamp, pid, event and fields; newlines are flattened', () => {
  const lines = [];
  const log = createDiagLog({ append: (_f, t) => lines.push(t), size: () => 0, reset() {}, file: 'f', now: () => 0, pid: 42 });
  log.note('toast.click', { id: 'x', note: 'a\nb', skip: undefined });
  assert.equal(lines.length, 1);
  assert.equal(lines[0], '1970-01-01T00:00:00.000Z pid=42 toast.click id=x note=a b\n');
});

test('the file is reset once it passes the size cap, and an fs failure never throws', () => {
  let resets = 0;
  const log = createDiagLog({ append() {}, size: () => MAX_BYTES + 1, reset: () => resets++, file: 'f' });
  log.note('e');
  assert.equal(resets, 1);
  const broken = createDiagLog({ append() { throw new Error('disk'); }, size: () => 0, reset() {}, file: 'f' });
  assert.doesNotThrow(() => broken.note('e'));
});
