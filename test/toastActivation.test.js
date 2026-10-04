'use strict';

// BUG-05 attempt 2: toast id <-> protocol activation URL <-> stored record (src/main/toastActivation.js).
// Real-Windows finding behind it (Electron 44.4.3): a default (foreground) toast never delivers a click to
// the app; a protocol-activated toast does (in-process `click`, plus `<app>.exe <url>` for cold start).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  activationUrl, buildToastXml, parseActivationUrl, findActivationId,
  createToastRegistry, createClickDeduper, escapeXml,
} = require('../src/main/toastActivation.js');

const ID = '3f2b8c1e-5d4a-4c7e-9a10-1b2c3d4e5f60';
const S = 'gcd-chat';

test('activation URL round-trips through parse', () => {
  assert.equal(activationUrl(S, ID), `gcd-chat://toast/${ID}`);
  assert.equal(parseActivationUrl(activationUrl(S, ID), S), ID);
});

test('parse tolerates a trailing slash, scheme case and surrounding whitespace', () => {
  assert.equal(parseActivationUrl(`GCD-CHAT://toast/${ID}/`, S), ID);
  assert.equal(parseActivationUrl(` gcd-chat://toast/${ID} `, S), ID);
});

test('parse rejects other schemes, other hosts, extra path/query/fragment, bad ids and non-strings', () => {
  for (const bad of [
    undefined, null, 5, {}, '', 'x'.repeat(600),
    `https://toast/${ID}`, `other://toast/${ID}`, `gcd-chat://open/${ID}`, `gcd-chat://toast/`, 'gcd-chat://toast',
    `gcd-chat://toast/${ID}/extra`, `gcd-chat://toast/${ID}?x=1`, `gcd-chat://toast/${ID}#f`,
    'gcd-chat://toast/short', `gcd-chat://toast/${'a'.repeat(65)}`, 'gcd-chat://toast/..%2f..%2fetc', `gcd-chat://toast/${ID}<s>`,
  ]) {
    assert.equal(parseActivationUrl(bad, S), null, String(bad).slice(0, 40));
  }
});

test('findActivationId picks our URL out of a second-instance argv and ignores everything else', () => {
  assert.equal(findActivationId(['--allow-file-access-from-files', '--source-app-id', `gcd-chat://toast/${ID}`], S), ID);
  assert.equal(findActivationId(['-Embedding'], S), null);
  assert.equal(findActivationId(undefined, S), null);
  assert.equal(findActivationId(['gcd-chat-dev://toast/' + ID], S), null);
});

test('toast XML: protocol activation with our URL, title and body, markup escaped', () => {
  const xml = buildToastXml({ title: 'A <b>&</b> "q"', body: "it's <x>", id: ID, scheme: S });
  assert.match(xml, new RegExp(`launch="gcd-chat://toast/${ID}"`));
  assert.match(xml, /activationType="protocol"/);
  assert.match(xml, /<text>A &lt;b&gt;&amp;&lt;\/b&gt; &quot;q&quot;<\/text>/);
  assert.match(xml, /<text>it&apos;s &lt;x&gt;<\/text>/);
  assert.equal(xml.includes('<b>'), false);
  assert.equal(xml.includes('<audio'), false);
});

test('toast XML: silent adds the silent audio element, an empty body adds no second text', () => {
  const xml = buildToastXml({ title: 't', body: '', silent: true, id: ID, scheme: S });
  assert.match(xml, /<audio silent="true"\/>/);
  assert.equal((xml.match(/<text>/g) || []).length, 1);
});

test('escapeXml strips characters that are illegal in XML 1.0', () => {
  assert.equal(escapeXml('a\u0000b\u0008c\u001Fd￿e'), 'abcde');
  assert.equal(escapeXml('tab\tnl\n'), 'tab\tnl\n');
});

test('registry stores and returns records, and is bounded (oldest dropped)', () => {
  let n = 0;
  const reg = createToastRegistry({ newId: () => `id-${++n}-xxxxxxxx`, max: 3 });
  const ids = [1, 2, 3, 4].map((i) => reg.register({ i }));
  assert.equal(reg.size(), 3);
  assert.equal(reg.get(ids[0]), undefined);
  assert.deepEqual(reg.get(ids[3]), { i: 4 });
});

test('deduper: the same id inside the window is dropped once, a different id and a later click pass', () => {
  let t = 1000;
  const d = createClickDeduper({ windowMs: 1500, now: () => t });
  assert.equal(d.accept('a'), true);
  t += 200;
  assert.equal(d.accept('a'), false);
  assert.equal(d.accept('b'), true);
  t += 2000;
  assert.equal(d.accept('a'), true);
});

test('protocol scheme: packaged and dev differ, are valid schemes, and the dev one never equals the installed one', () => {
  const { resolveProtocolScheme } = require('../src/main/appIdentity.js');
  assert.equal(resolveProtocolScheme({ isPackaged: true }), 'gcd-chat');
  assert.equal(resolveProtocolScheme({ isPackaged: false }), 'gcd-chat-dev');
  for (const p of [true, false]) assert.match(resolveProtocolScheme({ isPackaged: p }), /^[a-z][a-z0-9+.-]*$/);
});
