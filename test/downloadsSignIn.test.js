'use strict';

// FR-19 downloads during the sign-in mode (docs/architecture/sign-in-flow.md section 4 "Downloads from the main
// window", section 6, test map row "Downloads"). The existing test/downloads.test.js stays untouched and green: outside
// the mode (predicate absent or false) nothing changes, re-pinned below.
//
// MODULE API ASSUMED (extends createDownloadHandler of src/main/downloads.js; the addition is OPTIONAL):
//
//   createDownloadHandler({ ...existing,
//     isMainDownloadBlocked,   // () => boolean, evaluated PER DOWNLOAD (index.js: signInFlow.isActive); absent -> false
//   })
//   handler(event, item, webContents), for a download whose contents is the MAIN window and isMainDownloadBlocked() true:
//     * item.cancel() - EVERY main-window download, whatever scheme or host (this is not the "address not allowed" check);
//       no setSaveDialogOptions, no setSavePath;
//     * ONE native notice per window (coalesced as today) with SIGN-IN wording: title "Download blocked", detail
//       "Downloads are not allowed while you sign in. Finish signing in, then try again.", buttons ["Close"] ONLY
//       (no "Open in browser": the existing action would hand the URL of an untrusted page to the system browser),
//       defaultId 0, cancelId 0; openExternal is never called, whatever the answer;
//     * parent: the main window when visible and not minimized, else none (same as today).
//   App-window downloads are unaffected in both states; contents that are neither stay untouched.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { load } = require('./helpers/pending');
const { createFakeBrowserWindowClass, createDialogFake, makeEvent, settle } = require('./helpers/electronFakes');

const DIR = path.join(path.sep, 'users', 'u', 'Downloads');
const DRIVE_FILE = 'https://drive.google.com/file/d/1/view';
const TITLE = 'Download blocked';
const SIGN_IN_DETAIL = 'Downloads are not allowed while you sign in. Finish signing in, then try again.';
const OLD_MESSAGE = 'This download comes from an address the app does not allow.';
const CLOSE = 'Close';
const OPEN = 'Open in browser';

class FakeItem extends EventEmitter {
  constructor({ url, chain, filename = 'report.pdf' }) {
    super();
    this.url = url;
    this.chain = chain === undefined ? [url] : chain;
    this.filename = filename;
    this.saveDialogOptions = [];
    this.savePathCalls = 0;
    this.cancelCalls = 0;
  }

  getURL() { return this.url; }
  getURLChain() { return this.chain; }
  getFilename() { return this.filename; }
  setSaveDialogOptions(o) { this.saveDialogOptions.push(o); }
  setSavePath() { this.savePathCalls += 1; }
  cancel() { this.cancelCalls += 1; }
  finish(state = 'completed') { this.emit('done', makeEvent(), state); }
}

const item = (url, extra = {}) => new FakeItem({ url, ...extra });

/** `mode`: true / false / 'absent' (the dependency is not passed at all) / a function. */
function setup({ mode = true } = {}) {
  const BrowserWindow = createFakeBrowserWindowClass();
  const main = new BrowserWindow({});
  const appWins = [];
  const dialog = createDialogFake();
  const state = { external: [], logs: [], closeEmpty: [], blocked: mode === true };
  const deps = {
    getAppWindowForContents: (wc) => appWins.find((w) => w.webContents === wc) || null,
    getMainWindow: () => main,
    closeEmptyWindow: (wc) => { state.closeEmpty.push(wc); return false; },
    getDownloadsDir: () => DIR,
    showMessageBox: dialog.showMessageBox,
    openExternal: (u) => state.external.push(u),
    log: (...a) => state.logs.push(a),
  };
  if (typeof mode === 'function') deps.isMainDownloadBlocked = mode;
  else if (mode !== 'absent') deps.isMainDownloadBlocked = () => state.blocked;
  const handler = load('downloads.js').createDownloadHandler(deps);
  const run = (it, contents) => {
    const event = makeEvent();
    handler(event, it, contents);
    return event;
  };
  const newAppWin = () => {
    const w = new BrowserWindow({});
    appWins.push(w);
    return w;
  };
  return { run, dialog, state, main, newAppWin };
}

// ---- mode on: every main-window download is cancelled, sign-in wording --------------------------------------------------------------------

for (const url of [
  'https://anywhere.example/file.bin',
  'https://chat.google.com/api/get_attachment_url?x=1',
  'https://lh3.googleusercontent.com/x',
  'blob:https://login.idp.example/uuid',
  'http://login.idp.example/x',
  'file:///C:/x.bin',
  'data:text/plain,hi',
]) {
  test(`mode on: a main-window download from ${url.split('/')[0]}//... is cancelled, no save dialog, ONE sign-in notice`, () => {
    const t = setup();
    const it = item(url);
    t.run(it, t.main.webContents);
    assert.equal(it.cancelCalls, 1);
    assert.deepEqual(it.saveDialogOptions, [], 'no save dialog for a cancelled download');
    assert.equal(it.savePathCalls, 0);
    assert.equal(t.dialog.calls.length, 1);
  });
}

test('mode on: the notice carries the sign-in wording - title "Download blocked" and the sign-in detail, not the address wording', () => {
  const t = setup();
  t.run(item('https://anywhere.example/file.bin'), t.main.webContents);
  const call = t.dialog.calls[0];
  const text = t.dialog.textOf(call);
  assert.equal(call.options.title, TITLE);
  assert.ok(text.includes(SIGN_IN_DETAIL), text);
  assert.equal(text.includes(OLD_MESSAGE), false, 'the existing "address the app does not allow" wording is for the other case');
});

test('mode on: the notice offers NO "Open in browser" - only "Close", default and Escape', () => {
  const t = setup();
  t.run(item('https://anywhere.example/file.bin'), t.main.webContents);
  const { options } = t.dialog.calls[0];
  assert.deepEqual(options.buttons, [CLOSE]);
  assert.equal(options.defaultId, 0);
  assert.equal(options.cancelId, 0);
});

test('mode on: the system browser is never called with the download url, whatever the user answers (even a forged "button 1")', async () => {
  const t = setup();
  t.run(item('https://evil.example/payload.exe'), t.main.webContents);
  t.dialog.calls[0].resolve(1);
  await settle();
  const second = setup();
  second.run(item('https://evil.example/payload.exe'), second.main.webContents);
  second.dialog.answer(second.dialog.calls[0], CLOSE);
  await settle();
  assert.deepEqual(t.state.external, []);
  assert.deepEqual(second.state.external, []);
});

test('mode on: the notice is parented to the visible main window, unparented when it is hidden or minimized', () => {
  const visible = setup();
  visible.run(item('https://anywhere.example/f'), visible.main.webContents);
  assert.equal(visible.dialog.calls[0].parent, visible.main);

  const hidden = setup();
  hidden.main.visible = false;
  hidden.run(item('https://anywhere.example/f'), hidden.main.webContents);
  assert.ok(hidden.dialog.calls[0].parent == null);

  const minimized = setup();
  minimized.main.minimized = true;
  minimized.run(item('https://anywhere.example/f'), minimized.main.webContents);
  assert.ok(minimized.dialog.calls[0].parent == null);
});

test('mode on: coalescing as today - further downloads are cancelled and folded into the one open box', () => {
  const t = setup();
  const a = item('https://anywhere.example/a');
  const b = item('https://anywhere.example/b');
  const c = item('http://anywhere.example/c');
  t.run(a, t.main.webContents);
  t.run(b, t.main.webContents);
  t.run(c, t.main.webContents);
  assert.equal(a.cancelCalls + b.cancelCalls + c.cancelCalls, 3);
  assert.equal(t.dialog.calls.length, 1);
});

test('mode on: after the box is answered, a new blocked download shows a new box (still sign-in wording)', async () => {
  const t = setup();
  t.run(item('https://anywhere.example/a'), t.main.webContents);
  t.dialog.answer(t.dialog.calls[0], CLOSE);
  await settle();
  t.run(item('https://anywhere.example/b'), t.main.webContents);
  assert.equal(t.dialog.calls.length, 2);
  assert.ok(t.dialog.textOf(t.dialog.calls[1]).includes(SIGN_IN_DETAIL));
});

test('mode on: the main window never asks the app-window auto-close hook', () => {
  const t = setup();
  t.run(item('https://anywhere.example/a'), t.main.webContents);
  assert.deepEqual(t.state.closeEmpty, []);
});

test('mode on: logging stays status-only - the scheme at most, never a file name, host, path or id', () => {
  const t = setup();
  t.run(item('https://secret-host-xyz.example/secret-path-xyz', { filename: 'blocked-secret.bin' }), t.main.webContents);
  const logged = JSON.stringify(t.state.logs);
  for (const secret of ['secret-host-xyz', 'secret-path-xyz', 'blocked-secret']) assert.equal(logged.includes(secret), false, secret);
});

// ---- the predicate is read per download -----------------------------------------------------------------------------------------

test('the predicate is evaluated per download: a download after the mode ended gets the normal save dialog', () => {
  const t = setup();
  const during = item('https://anywhere.example/a');
  t.run(during, t.main.webContents);
  assert.equal(during.cancelCalls, 1);
  t.state.blocked = false;
  const after = item('https://anywhere.example/b', { filename: 'b.pdf' });
  t.run(after, t.main.webContents);
  assert.equal(after.cancelCalls, 0);
  assert.deepEqual(after.saveDialogOptions, [{ defaultPath: path.join(DIR, 'b.pdf') }]);
});

test('the predicate may be any function - it is called with no dependency on the item', () => {
  let asked = 0;
  const t = setup({ mode: () => { asked += 1; return true; } });
  t.run(item('https://anywhere.example/a'), t.main.webContents);
  assert.ok(asked >= 1);
});

// ---- mode off / predicate absent: unchanged -----------------------------------------------------------------------------------------------------

for (const mode of [false, 'absent']) {
  const label = mode === false ? 'predicate false' : 'predicate absent';

  test(`${label}: a main-window https download gets the save dialog, is not cancelled, shows no notice (unchanged)`, () => {
    const t = setup({ mode });
    const it = item('https://anywhere.example/file.bin');
    t.run(it, t.main.webContents);
    assert.equal(it.cancelCalls, 0);
    assert.deepEqual(it.saveDialogOptions, [{ defaultPath: path.join(DIR, 'report.pdf') }]);
    assert.equal(t.dialog.calls.length, 0);
  });

  test(`${label}: the existing blocked notice (scheme check) keeps its wording and its "Open in browser" action`, async () => {
    const t = setup({ mode });
    const it = item('http://chat.google.com/x');
    t.run(it, t.main.webContents);
    assert.equal(it.cancelCalls, 1);
    const call = t.dialog.calls[0];
    assert.equal(call.options.title, TITLE);
    assert.ok(t.dialog.textOf(call).includes(OLD_MESSAGE));
    assert.equal(t.dialog.textOf(call).includes(SIGN_IN_DETAIL), false);
  });
}

// ---- app windows and other contents: unaffected in both states ------------------------------------------------------------------------------

for (const mode of [true, false]) {
  test(`app windows are unaffected (predicate ${mode}): an allowed Drive download proceeds with its save dialog`, () => {
    const t = setup({ mode });
    const win = t.newAppWin();
    const it = item(DRIVE_FILE);
    t.run(it, win.webContents);
    assert.equal(it.cancelCalls, 0);
    assert.deepEqual(it.saveDialogOptions, [{ defaultPath: path.join(DIR, 'report.pdf') }]);
    assert.equal(t.dialog.calls.length, 0);
  });

  test(`app windows are unaffected (predicate ${mode}): a blocked app-window download keeps the address wording and "Open in browser"`, async () => {
    const t = setup({ mode });
    const win = t.newAppWin();
    t.run(item('https://evil.example/x'), win.webContents);
    const call = t.dialog.calls[0];
    assert.ok(t.dialog.textOf(call).includes(OLD_MESSAGE));
    assert.deepEqual(call.options.buttons, [CLOSE, OPEN]);
    t.dialog.answer(call, OPEN);
    await settle();
    assert.deepEqual(t.state.external, ['https://evil.example/x']);
  });

  test(`other contents are left to Electron (predicate ${mode}): no call on the item, no dialog`, () => {
    const t = setup({ mode });
    const it = item('https://evil.example/x');
    t.run(it, { id: 999 });
    assert.equal(it.cancelCalls, 0);
    assert.deepEqual(it.saveDialogOptions, []);
    assert.equal(t.dialog.calls.length, 0);
  });
}
