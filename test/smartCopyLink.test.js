'use strict';

// UI-05 / FR-18, docs/architecture/smart-copy.md section 1 and 8 (rows "copyableLinkUrl" and "Binder, links").
// RED until src/main/smartCopy.js exists.
//
// API CONTRACT ASSUMED (the implementer may argue with it and then change the tests together, never silently):
//   src/main/smartCopy.js (no Electron import; every collaborator injected)
//     copyableLinkUrl(raw) -> string | null     pure, never throws
//     createSmartCopy({
//       clipboard,          // { writeText(text) }
//       showHint,           // (kind) => void; kind is 'link-copied' or 'copied' (the two hint body classes)
//       timers,             // { setTimeout, clearTimeout }
//       log,                // (...args) => void; outcome only, never URLs or selected text
//       ipcMain,            // { on(channel, listener) }  the 'smartcopy:signal' listener is registered by bindSmartCopyMain
//       notificationOrigins // ['https://chat.google.com'] (originCheck.js exact equality)
//     }) -> {
//       bindSmartCopyMain(mainWindow), // BrowserWindow: context-menu link copy on mainWindow.webContents + the signal handler
//       bindSmartCopyApp(webContents), // Google app windows: context-menu link copy only
//     }
//   Both binders listen ONLY to 'context-menu' on the contents (the IPC listener lives on ipcMain).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { load } = require('./helpers/pending');
const { createManualClock, makeEvent } = require('./helpers/electronFakes');

const copyableLinkUrl = (raw) => load('smartCopy.js').copyableLinkUrl(raw);
const wrap = (target) => 'https://www.google.com/url?q=' + encodeURIComponent(target);

// --- copyableLinkUrl -----------------------------------------------------------------------------------------

test('copyableLinkUrl: http, https and mailto links come back exactly as given', () => {
  for (const url of [
    'https://example.com/',
    'http://example.com/a?b=1&c=2#frag',
    'https://example.com/a%20b/%D0%B0',
    'mailto:someone@example.com',
    'mailto:someone@example.com?subject=Hi%20there',
  ]) {
    assert.equal(copyableLinkUrl(url), url, url);
  }
});

test('copyableLinkUrl: the canonical form that linkURL delivers is returned unchanged (https://example.com/ keeps its slash)', () => {
  assert.equal(copyableLinkUrl('https://example.com/'), 'https://example.com/');
});

test('copyableLinkUrl: a direct link is not re-serialised (host case and explicit default port stay as given)', () => {
  assert.equal(copyableLinkUrl('https://EXAMPLE.com:443/Path'), 'https://EXAMPLE.com:443/Path');
});

test('copyableLinkUrl: a www.google.com/url?q= wrapper gives the decoded q text verbatim', () => {
  assert.equal(copyableLinkUrl(wrap('https://example.com/a?b=1&c=2')), 'https://example.com/a?b=1&c=2');
  assert.equal(copyableLinkUrl(wrap('https://example.com')), 'https://example.com');
  assert.equal(copyableLinkUrl(wrap('mailto:a@example.com')), 'mailto:a@example.com');
  assert.equal(copyableLinkUrl(wrap('https://example.com/x') + '&sa=D&ust=1'), 'https://example.com/x');
});

test('copyableLinkUrl: a wrapper inside a wrapper is unwrapped exactly once (the inner wrapper URL is the text)', () => {
  const inner = wrap('https://final.example/page');
  assert.equal(copyableLinkUrl(wrap(inner)), inner);
});

test('copyableLinkUrl: a wrapper with a duplicated q, a port or userinfo gives null (table of section 8)', () => {
  const q = encodeURIComponent('https://example.com/');
  assert.equal(copyableLinkUrl('https://www.google.com/url?q=' + q + '&q=' + q), null);
  assert.equal(copyableLinkUrl('https://www.google.com:8443/url?q=' + q), null);
  assert.equal(copyableLinkUrl('https://user:pw@www.google.com/url?q=' + q), null);
});

test('copyableLinkUrl: a wrapper whose target has another scheme gives null', () => {
  for (const target of ['javascript:alert(1)', 'data:text/html,x', 'tel:+123456', 'file:///c:/x', 'not a url', '']) {
    assert.equal(copyableLinkUrl(wrap(target)), null, target);
  }
});

test('copyableLinkUrl: javascript, data, blob, file, vbscript, tel and ftp links give null', () => {
  for (const url of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<b>x</b>',
    'blob:https://example.com/0000',
    'file:///c:/secret.txt',
    'vbscript:msgbox(1)',
    'tel:+15555550100',
    'ftp://example.com/',
  ]) {
    assert.equal(copyableLinkUrl(url), null, url);
  }
});

test('copyableLinkUrl: garbage, empty and non-string input give null and never throw', () => {
  const hostile = { toString() { throw new Error('boom'); } };
  for (const raw of ['', 'not a url', '   ', undefined, null, 0, 123, true, {}, [], ['https://example.com/'], hostile, Symbol('s'), () => 'https://example.com/']) {
    assert.equal(copyableLinkUrl(raw), null, typeof raw);
  }
});

test('copyableLinkUrl: longer than 8192 characters gives null, exactly 8192 is accepted', () => {
  const base = 'https://example.com/';
  assert.equal(copyableLinkUrl(base + 'a'.repeat(8192 - base.length + 1)), null);
  const ok = base + 'a'.repeat(8192 - base.length);
  assert.equal(ok.length, 8192);
  assert.equal(copyableLinkUrl(ok), ok);
});

test('copyableLinkUrl: any control character gives null', () => {
  for (const url of ['https://example.com/a\tb', 'https://example.com/a\nb', 'https://example.com/\u0000', 'https://example.com/\u007f', 'https://example.com/\u001b[0m']) {
    assert.equal(copyableLinkUrl(url), null, JSON.stringify(url));
  }
});

// --- link binders --------------------------------------------------------------------------------------------

function setup() {
  const written = [];
  const hints = [];
  const logs = [];
  const clock = createManualClock();
  const ipcMain = new EventEmitter();
  const api = load('smartCopy.js').createSmartCopy({
    clipboard: { writeText: (text) => written.push(text) },
    showHint: (...args) => hints.push(args),
    timers: clock,
    log: (...args) => logs.push(args),
    ipcMain,
    notificationOrigins: ['https://chat.google.com'],
  });
  return { api, written, hints, logs, ipcMain };
}

function mainWindowFake() {
  const webContents = new EventEmitter();
  webContents.mainFrame = {};
  webContents.isDestroyed = () => false;
  webContents.copy = () => {};
  const win = new EventEmitter();
  win.webContents = webContents;
  win.isDestroyed = () => false;
  return win;
}

const VARIANTS = [
  ['bindSmartCopyApp', (api) => { const wc = new EventEmitter(); api.bindSmartCopyApp(wc); return wc; }],
  ['bindSmartCopyMain', (api) => { const win = mainWindowFake(); api.bindSmartCopyMain(win); return win.webContents; }],
];

function rightClick(wc, linkURL) {
  const event = makeEvent();
  wc.emit('context-menu', event, { linkURL, x: 10, y: 20 });
  return event;
}

for (const [name, bind] of VARIANTS) {
  test(`${name}: a right-click on an http(s) link writes the URL once and shows "Link copied"`, () => {
    const t = setup();
    const wc = bind(t.api);
    rightClick(wc, 'https://example.com/page');
    assert.deepEqual(t.written, ['https://example.com/page']);
    assert.equal(t.hints.length, 1);
    assert.equal(t.hints[0][0], 'link-copied');
  });

  test(`${name}: a mailto link is copied with its scheme and the same hint`, () => {
    const t = setup();
    const wc = bind(t.api);
    rightClick(wc, 'mailto:a@example.com');
    assert.deepEqual(t.written, ['mailto:a@example.com']);
    assert.equal(t.hints[0][0], 'link-copied');
  });

  test(`${name}: a wrapped link writes the target`, () => {
    const t = setup();
    const wc = bind(t.api);
    rightClick(wc, wrap('https://example.com/target'));
    assert.deepEqual(t.written, ['https://example.com/target']);
    assert.equal(t.hints.length, 1);
  });

  test(`${name}: tel:, javascript:, an empty or missing linkURL write nothing and show no hint`, () => {
    const t = setup();
    const wc = bind(t.api);
    for (const linkURL of ['tel:+15555550100', 'javascript:alert(1)', 'data:text/plain,x', '', undefined, null]) {
      rightClick(wc, linkURL);
    }
    assert.deepEqual(t.written, []);
    assert.deepEqual(t.hints, []);
  });

  test(`${name}: a context-menu without params never throws`, () => {
    const t = setup();
    const wc = bind(t.api);
    assert.doesNotThrow(() => wc.emit('context-menu', makeEvent(), undefined));
    assert.doesNotThrow(() => wc.emit('context-menu', makeEvent(), {}));
    assert.deepEqual(t.written, []);
  });

  test(`${name}: the event is not prevented, only context-menu is listened to, and no URL reaches the log`, () => {
    const t = setup();
    const wc = bind(t.api);
    assert.deepEqual(wc.eventNames(), ['context-menu']);
    const event = rightClick(wc, 'https://example.com/secret-path-123');
    assert.equal(event.defaultPrevented, false);
    assert.equal(JSON.stringify(t.logs).includes('secret-path-123'), false);
  });
}

test('bindSmartCopyApp registers nothing on ipcMain (no signal handler for Google app windows)', () => {
  const t = setup();
  t.api.bindSmartCopyApp(new EventEmitter());
  assert.deepEqual(t.ipcMain.eventNames(), []);
});

test('source pin: smartCopy.js has no Electron import and builds no Menu', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const code = fs
    .readFileSync(path.join(__dirname, '..', 'src', 'main', 'smartCopy.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/require\(['"]electron['"]\)/.test(code), false);
  assert.equal(/\bMenu\b/.test(code), false);
});
