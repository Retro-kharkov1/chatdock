'use strict';

// BUG-09 diagnostics helpers (src/main/diagLog.js). Pure: no Electron, the file writer gets a fake fs.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  redactUrl,
  redactOrigin,
  truncateText,
  formatLine,
  createDiagLogger,
  createRotatingFileWriter,
} = require('../src/main/diagLog');

test('redactUrl keeps scheme, host and path only', () => {
  assert.equal(
    redactUrl('https://meet.google.com/abc-defg-hij?authuser=0&token=SECRET#frag'),
    'https://meet.google.com/abc-defg-hij'
  );
});

test('redactUrl drops userinfo, query and fragment, keeps an explicit port', () => {
  const out = redactUrl('https://user:pw@example.com:8443/a/b?q=1#x');
  assert.equal(out, 'https://example.com:8443/a/b');
  assert.ok(!out.includes('pw'));
  assert.ok(!out.includes('user'));
});

test('redactUrl keeps about:blank and about:srcdoc, reduces other about: URLs to the scheme', () => {
  assert.equal(redactUrl('about:blank'), 'about:blank');
  assert.equal(redactUrl('about:srcdoc'), 'about:srcdoc');
  assert.equal(redactUrl('about:blank?x=1#y'), 'about:blank');
  assert.equal(redactUrl('about:config'), 'about:');
});

test('redactUrl reduces opaque schemes to the scheme alone', () => {
  assert.equal(redactUrl('data:text/html,<h1>secret</h1>'), 'data:');
  assert.equal(redactUrl('javascript:alert(document.cookie)'), 'javascript:');
  assert.equal(redactUrl('mailto:someone@example.com?subject=hi'), 'mailto:');
  assert.equal(redactUrl('ms-settings:privacy'), 'ms-settings:');
});

test('redactUrl reduces a blob URL to its origin', () => {
  assert.equal(redactUrl('blob:https://chat.google.com/6f1c-uuid'), 'blob:https://chat.google.com/');
});

test('redactUrl on junk never throws and never echoes the input', () => {
  for (const junk of [undefined, null, 42, {}, '', 'not a url', '://x']) {
    assert.equal(redactUrl(junk), '<unparseable>');
  }
});

test('redactUrl caps a very long path', () => {
  const out = redactUrl(`https://example.com/${'a'.repeat(1000)}?q=1`);
  assert.ok(out.length < 260);
  assert.ok(out.endsWith('...'));
});

test('redactOrigin returns the origin only', () => {
  assert.equal(redactOrigin('https://chat.google.com/room/x?y=1#z'), 'https://chat.google.com');
  assert.equal(redactOrigin('https://meet.google.com'), 'https://meet.google.com');
  assert.equal(redactOrigin(undefined), '<none>');
  assert.equal(redactOrigin(''), '<none>');
  assert.equal(redactOrigin('garbage'), '<unparseable>');
  assert.equal(redactOrigin(7), '<unparseable>');
});

test('truncateText cuts to the limit and reports the dropped length', () => {
  const out = truncateText('x'.repeat(500), 300);
  assert.ok(out.startsWith('x'.repeat(300)));
  assert.ok(out.endsWith('...(+200 chars)'));
});

test('truncateText leaves short text and collapses whitespace to one line', () => {
  assert.equal(truncateText('a\n\n  b\tc'), 'a b c');
  assert.equal(truncateText(undefined), '');
});

test('truncateText strips query and fragment from URLs inside the text', () => {
  const out = truncateText('Failed to load https://chat.google.com/api/x?token=SECRET&k=v#frag now');
  assert.equal(out, 'Failed to load https://chat.google.com/api/x now');
  assert.ok(!out.includes('SECRET'));
});

test('formatLine quotes string values so spaces and newlines cannot forge fields', () => {
  const line = formatLine('evt', { a: 'x y\nz=1', n: 3, skipped: undefined });
  assert.equal(line, 'evt a="x y\\nz=1" n=3');
});

test('logger is a no-op without a writer and never throws', () => {
  const { diag } = createDiagLogger();
  assert.doesNotThrow(() => diag('e', { a: 1 }));
});

test('logger writes a timestamped line and collapses identical consecutive lines', () => {
  const lines = [];
  const { diag } = createDiagLogger({ write: (l) => lines.push(l), now: () => 'T' });
  diag('e', { a: 'x' });
  diag('e', { a: 'x' });
  diag('e', { a: 'x' });
  diag('e', { a: 'y' });
  assert.deepEqual(lines, ['T e a="x"', 'T repeated x2', 'T e a="y"']);
});

test('logger swallows a throwing writer', () => {
  const { diag } = createDiagLogger({
    write: () => {
      throw new Error('disk full');
    },
  });
  assert.doesNotThrow(() => diag('e', {}));
});

test('rotating writer appends, rotates past the limit and never throws', () => {
  const calls = [];
  const fsImpl = {
    mkdirSync: (d) => calls.push(['mkdir', d]),
    statSync: () => {
      throw new Error('ENOENT');
    },
    renameSync: (a, b) => calls.push(['rename', a, b]),
    appendFileSync: (f, t) => calls.push(['append', f, t]),
  };
  const w = createRotatingFileWriter('/logs', { maxBytes: 20, fsImpl });
  w.write('0123456789'); // 11 bytes with newline
  w.write('0123456789'); // would reach 22 > 20: rotate first
  const kinds = calls.map((c) => c[0]);
  assert.deepEqual(kinds, ['mkdir', 'append', 'rename', 'append']);
  assert.ok(w.file.endsWith('diagnostics.log'));

  const broken = createRotatingFileWriter('/logs', {
    fsImpl: {
      mkdirSync: () => {
        throw new Error('EACCES');
      },
    },
  });
  assert.doesNotThrow(() => broken.write('x'));
});
