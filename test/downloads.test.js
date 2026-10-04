'use strict';

// UI-04 downloads (docs/architecture/google-app-windows.md section 4 "Downloads", section 8 dialog table,
// coverage-map row "Downloads"). RED until src/main/downloads.js and googleLink.js exist.
//
// MODULE API ASSUMED (src/main/downloads.js, deps injected, no Electron import):
//
//   createDownloadHandler({
//     getAppWindowForContents,  // (webContents) => BrowserWindow | null   (googleAppWindow manager lookup)
//     getMainWindow,            // () => BrowserWindow | null
//     closeEmptyWindow,         // (webContents) => boolean: googleAppWindow manager closeIfEmpty (empty-window
//                               //   auto-close); true when the window never displayed a page and was destroyed
//     getDownloadsDir,          // () => string, the OS Downloads folder
//     showMessageBox,           // (parentWindow | undefined, options) => Promise<{ response }> (dialog.showMessageBox)
//     openExternal,             // (url) => void, system browser by the scheme rule
//     downloadChainHosts,       // optional exact hosts, default DOWNLOAD_CHAIN_HOSTS (googleLink.js); lets the
//                               //   test inject one (assumed seam; the spec says "a host added to the list")
//     log,                      // (message, ...args) => void
//   }) -> handler(event, item, webContents)    // session 'will-download' listener
//
//   The spec lists isAppWindowContents / isMainWindowContents; getAppWindowForContents / getMainWindow carry the
//   same information AND give the parent for the blocked notice (to argue).
//
//   Rules asserted: contents that are neither an app window nor the main window are left alone (no call on the
//   item at all). Allowed -> item.setSaveDialogOptions({ defaultPath: join(downloadsDir, basename(name)) }),
//   never setSavePath, never cancel, never event.preventDefault. Blocked -> item.cancel() + ONE notice.
//   item 'done' (completed | cancelled | interrupted) -> closeEmptyWindow(webContents) (app windows only).
//   Notice: showMessageBox(parent, { title: 'Download blocked', message: '...', buttons, defaultId: 0, cancelId: 0,
//   signal }); parent is the originating window when it is visible and not minimized, else undefined/null
//   (unparented); an empty window (closeEmptyWindow returned true) is also unparented.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { load } = require('./helpers/pending');
const { createFakeBrowserWindowClass, createDialogFake, makeEvent, settle } = require('./helpers/electronFakes');

const DIR = path.join(path.sep, 'users', 'u', 'Downloads');
const DRIVE_FILE = 'https://drive.google.com/file/d/1/view';
const USERCONTENT_DL = 'https://drive.usercontent.google.com/download?id=1&export=download';
const TITLE = 'Download blocked';
const MESSAGE = 'This download comes from an address the app does not allow.';
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

function setup({ honorSignal = true, downloadChainHosts } = {}) {
  const BrowserWindow = createFakeBrowserWindowClass();
  const appWins = [];
  const main = new BrowserWindow({});
  const dialog = createDialogFake({ honorSignal });
  const state = { external: [], logs: [], closeEmpty: [] };
  const empty = new Set();
  const deps = {
    getAppWindowForContents: (wc) => appWins.find((w) => w.webContents === wc) || null,
    getMainWindow: () => main,
    closeEmptyWindow: (wc) => {
      state.closeEmpty.push(wc);
      return empty.has(wc);
    },
    getDownloadsDir: () => DIR,
    showMessageBox: dialog.showMessageBox,
    openExternal: (u) => state.external.push(u),
    log: (...a) => state.logs.push(a),
  };
  if (downloadChainHosts !== undefined) deps.downloadChainHosts = downloadChainHosts;
  const handler = load('downloads.js').createDownloadHandler(deps);
  const newAppWin = () => {
    const w = new BrowserWindow({});
    appWins.push(w);
    return w;
  };
  const run = (item, contents) => {
    const event = makeEvent();
    handler(event, item, contents);
    return event;
  };
  const markEmpty = (w) => empty.add(w.webContents);
  return { handler, run, dialog, state, main, newAppWin, markEmpty, appWins, BrowserWindow, deps };
}

const item = (url, extra = {}) => new FakeItem({ url, ...extra });

// --- app window: allowed (strict, whole chain) ------------------------------------------------------------------------------------

test('app window: a Drive download whose url and every chain entry are on the nav list proceeds with a save dialog', () => {
  const t = setup();
  const win = t.newAppWin();
  const it = item(DRIVE_FILE, { chain: [DRIVE_FILE, 'https://docs.google.com/x'] });
  const event = t.run(it, win.webContents);
  assert.equal(event.defaultPrevented, false);
  assert.equal(it.cancelCalls, 0);
  assert.equal(it.savePathCalls, 0, 'never setSavePath: the save dialog is always shown');
  assert.deepEqual(it.saveDialogOptions, [{ defaultPath: path.join(DIR, 'report.pdf') }]);
  assert.equal(t.dialog.calls.length, 0);
});

test('app window: a chain through drive.usercontent.google.com/download (final url too) is allowed', () => {
  const t = setup();
  const win = t.newAppWin();
  const it = item(USERCONTENT_DL, { chain: ['https://drive.google.com/uc?export=download&id=1', USERCONTENT_DL] });
  t.run(it, win.webContents);
  assert.equal(it.cancelCalls, 0);
  assert.equal(it.saveDialogOptions.length, 1);
});

test('app window: accounts.google.com is on the chain list (nav list) and passes', () => {
  const t = setup();
  const win = t.newAppWin();
  const it = item(DRIVE_FILE, { chain: ['https://accounts.google.com/x', DRIVE_FILE] });
  t.run(it, win.webContents);
  assert.equal(it.cancelCalls, 0);
});

test('app window: a blob: url whose inner origin is a nav-list host is allowed', () => {
  const t = setup();
  const win = t.newAppWin();
  const blob = 'blob:https://docs.google.com/0b1f-uuid';
  const it = item(blob, { chain: [blob] });
  t.run(it, win.webContents);
  assert.equal(it.cancelCalls, 0);
  assert.equal(it.saveDialogOptions.length, 1);
});

test('app window: a download-chain host injected into the list passes, and that host is still not navigable', () => {
  const t = setup({ downloadChainHosts: ['dl.example-google.test'] });
  const win = t.newAppWin();
  const url = 'https://dl.example-google.test/file';
  const it = item(url, { chain: [DRIVE_FILE, url] });
  t.run(it, win.webContents);
  assert.equal(it.cancelCalls, 0);
  assert.equal(load('googleLink.js').isGoogleNavigationUrl(url), false);
});

test('app window: with the default (empty) download-chain list the same host is blocked', () => {
  const t = setup();
  const win = t.newAppWin();
  const url = 'https://dl.example-google.test/file';
  const it = item(url, { chain: [DRIVE_FILE, url] });
  t.run(it, win.webContents);
  assert.equal(it.cancelCalls, 1);
});

test('app window: a suffix or lookalike of an injected chain host is blocked', () => {
  const t = setup({ downloadChainHosts: ['dl.example-google.test'] });
  const win = t.newAppWin();
  for (const url of ['https://evil.dl.example-google.test/f', 'https://dl.example-google.test.evil.example/f']) {
    const it = item(url, { chain: [url] });
    t.run(it, win.webContents);
    assert.equal(it.cancelCalls, 1, url);
  }
});

// --- app window: blocked -------------------------------------------------------------------------------------------------------------

test('app window: ONE unlisted hop in the chain cancels the download even when the final url is listed', () => {
  const t = setup();
  const win = t.newAppWin();
  const it = item(DRIVE_FILE, { chain: [DRIVE_FILE, 'https://evil.example/bounce', DRIVE_FILE] });
  t.run(it, win.webContents);
  assert.equal(it.cancelCalls, 1);
  assert.deepEqual(it.saveDialogOptions, [], 'no save dialog for a blocked download');
});

for (const url of [
  'http://docs.google.com/x',
  'https://evil.example/x',
  'https://docs.google.com.evil.example/x',
  'https://drive.usercontent.google.com/other?id=1',
  'https://drive.usercontent.google.com/download/x',
  'https://lh3.googleusercontent.com/x',
  'https://doc-0g-1k-docs.googleusercontent.com/x',
  'https://docs.google.com:8443/x',
  'https://forms.gle/abc',
  'blob:https://evil.example/uuid',
  'blob:null/uuid',
  'file:///C:/x.bin',
  'ftp://docs.google.com/x',
  'data:text/plain,hi',
]) {
  test(`app window: ${url} is cancelled and shows the blocked notice`, () => {
    const t = setup();
    const win = t.newAppWin();
    const it = item(url);
    t.run(it, win.webContents);
    assert.equal(it.cancelCalls, 1);
    assert.equal(t.dialog.calls.length, 1);
  });
}

test('blocked notice: wording is "Download blocked" / "This download comes from an address the app does not allow."', () => {
  const t = setup();
  const win = t.newAppWin();
  t.run(item('https://evil.example/x'), win.webContents);
  const text = t.dialog.textOf(t.dialog.calls[0]);
  assert.ok(text.includes(TITLE));
  assert.ok(text.includes(MESSAGE));
});

test('blocked notice (https): buttons ["Close", "Open in browser"], Close is the DEFAULT and the Escape answer', () => {
  const t = setup();
  const win = t.newAppWin();
  t.run(item('https://evil.example/x'), win.webContents);
  const { options } = t.dialog.calls[0];
  assert.deepEqual(options.buttons, [CLOSE, OPEN]);
  assert.equal(options.defaultId, 0);
  assert.equal(options.cancelId, 0);
});

for (const url of ['blob:https://evil.example/uuid', 'file:///C:/x.bin', 'ftp://docs.google.com/x', 'data:text/plain,hi']) {
  test(`blocked notice (${url.split(':')[0]}:): only "Close", default and Escape`, () => {
    const t = setup();
    const win = t.newAppWin();
    t.run(item(url), win.webContents);
    const { options } = t.dialog.calls[0];
    assert.deepEqual(options.buttons, [CLOSE]);
    assert.equal(options.defaultId, 0);
    assert.equal(options.cancelId, 0);
  });
}

test('blocked notice: "Open in browser" calls the browser stub with the item url once and never loads it in-app', async () => {
  const t = setup();
  const win = t.newAppWin();
  t.run(item('https://evil.example/x?y=1'), win.webContents);
  t.dialog.answer(t.dialog.calls[0], OPEN);
  await settle();
  assert.deepEqual(t.state.external, ['https://evil.example/x?y=1']);
  assert.deepEqual(win.webContents.loadCalls, []);
});

test('blocked notice: "Close" and the Escape answer open nothing', async () => {
  const t = setup();
  const win = t.newAppWin();
  t.run(item('https://evil.example/x'), win.webContents);
  t.dialog.answer(t.dialog.calls[0], CLOSE);
  await settle();
  assert.deepEqual(t.state.external, []);
});

test('blocked notice: it is parented to the visible originating window and carries an AbortSignal', () => {
  const t = setup();
  const win = t.newAppWin();
  t.run(item('https://evil.example/x'), win.webContents);
  const call = t.dialog.calls[0];
  assert.equal(call.parent, win);
  assert.ok(call.options.signal && typeof call.options.signal.aborted === 'boolean');
});

// --- coalescing: one box per originating window ---------------------------------------------------------------------------------------

test('coalescing: a second blocked download in the same window while the box is open is cancelled with NO second box', () => {
  const t = setup();
  const win = t.newAppWin();
  const first = item('https://evil.example/first');
  const second = item('https://evil.example/second');
  t.run(first, win.webContents);
  t.run(second, win.webContents);
  assert.equal(second.cancelCalls, 1);
  assert.equal(t.dialog.calls.length, 1);
});

test('coalescing: "Open in browser" opens the FIRST item\'s url, not the later one', async () => {
  const t = setup();
  const win = t.newAppWin();
  t.run(item('https://evil.example/first'), win.webContents);
  t.run(item('https://evil.example/second'), win.webContents);
  t.dialog.answer(t.dialog.calls[0], OPEN);
  await settle();
  assert.deepEqual(t.state.external, ['https://evil.example/first']);
});

test('coalescing: after the box is answered, a new blocked download shows a new box', async () => {
  const t = setup();
  const win = t.newAppWin();
  t.run(item('https://evil.example/first'), win.webContents);
  t.dialog.answer(t.dialog.calls[0], CLOSE);
  await settle();
  t.run(item('https://evil.example/second'), win.webContents);
  assert.equal(t.dialog.calls.length, 2);
});

test('coalescing: the limit is per originating window - two windows each get a box', () => {
  const t = setup();
  const a = t.newAppWin();
  const b = t.newAppWin();
  t.run(item('https://evil.example/a'), a.webContents);
  t.run(item('https://evil.example/b'), b.webContents);
  assert.equal(t.dialog.calls.length, 2);
});

// --- parent state --------------------------------------------------------------------------------------------------------------------------

test('parent state: a HIDDEN parent -> the box is shown unparented', () => {
  const t = setup();
  const win = t.newAppWin();
  win.visible = false;
  t.run(item('https://evil.example/x'), win.webContents);
  assert.ok(t.dialog.calls[0].parent == null);
});

test('parent state: a MINIMIZED parent -> the box is shown unparented', () => {
  const t = setup();
  const win = t.newAppWin();
  win.minimized = true;
  t.run(item('https://evil.example/x'), win.webContents);
  assert.ok(t.dialog.calls[0].parent == null);
});

test('parent state: blocked download in an empty app window -> closeEmptyWindow is asked and the box is unparented', () => {
  const t = setup();
  const win = t.newAppWin();
  t.markEmpty(win);
  t.run(item('https://evil.example/x'), win.webContents);
  assert.equal(t.state.closeEmpty.length >= 1, true);
  assert.equal(t.state.closeEmpty[0], win.webContents);
  assert.ok(t.dialog.calls[0].parent == null);
});

test('parent state: the parent destroyed while a parented box is open -> the box is dismissed via its AbortSignal', () => {
  const t = setup();
  const win = t.newAppWin();
  t.run(item('https://evil.example/x'), win.webContents);
  win.destroy();
  assert.equal(t.dialog.aborted(t.dialog.calls[0]), true);
});

test('parent state: a late "Open in browser" arriving after the parent was destroyed is ignored (box that ignores the signal)', async () => {
  const t = setup({ honorSignal: false });
  const win = t.newAppWin();
  t.run(item('https://evil.example/x'), win.webContents);
  win.destroy();
  t.dialog.answer(t.dialog.calls[0], OPEN);
  await settle();
  assert.deepEqual(t.state.external, []);
});

test('parent state: an UNPARENTED box is not dismissed by its former parent closing', () => {
  const t = setup();
  const win = t.newAppWin();
  win.visible = false;
  t.run(item('https://evil.example/x'), win.webContents);
  win.destroy();
  assert.equal(t.dialog.aborted(t.dialog.calls[0]), false);
});

// --- empty-window auto-close: download ended -----------------------------------------------------------------------------------------------

for (const state of ['completed', 'cancelled', 'interrupted']) {
  test(`download ended (${state}): the factory is told so an empty window can be auto-closed`, () => {
    const t = setup();
    const win = t.newAppWin();
    const it = item(DRIVE_FILE);
    t.run(it, win.webContents);
    assert.equal(t.state.closeEmpty.length, 0, 'not while the download is in progress');
    it.finish(state);
    assert.deepEqual(t.state.closeEmpty, [win.webContents]);
  });
}

test('download ended: for the main window the auto-close hook is never called (only app windows can be empty)', () => {
  const t = setup();
  const it = item('https://anywhere.example/file');
  t.run(it, t.main.webContents);
  it.finish('completed');
  assert.deepEqual(t.state.closeEmpty, []);
});

// --- main window: scheme only ----------------------------------------------------------------------------------------------------------------

test('main window: https from ANY host gets the save dialog (no host check)', () => {
  const t = setup();
  for (const url of ['https://lh3.googleusercontent.com/x', 'https://anywhere.example/file.bin', 'https://chat.google.com/api/get_attachment_url?x=1']) {
    const it = item(url);
    t.run(it, t.main.webContents);
    assert.equal(it.cancelCalls, 0, url);
    assert.deepEqual(it.saveDialogOptions, [{ defaultPath: path.join(DIR, 'report.pdf') }], url);
  }
  assert.equal(t.dialog.calls.length, 0);
});

test('main window: the chain is not checked - an evil hop with an https final url still gets the save dialog', () => {
  const t = setup();
  const it = item('https://chat.google.com/x', { chain: ['https://evil.example/r', 'https://chat.google.com/x'] });
  t.run(it, t.main.webContents);
  assert.equal(it.cancelCalls, 0);
});

test('main window: a blob: url gets the save dialog', () => {
  const t = setup();
  const it = item('blob:https://chat.google.com/uuid');
  t.run(it, t.main.webContents);
  assert.equal(it.cancelCalls, 0);
  assert.equal(it.saveDialogOptions.length, 1);
});

for (const url of ['http://chat.google.com/x', 'file:///C:/x.bin', 'ftp://example.org/x', 'data:text/plain,hi']) {
  test(`main window: ${url.split(':')[0]}: is cancelled with the blocked notice`, () => {
    const t = setup();
    const it = item(url);
    t.run(it, t.main.webContents);
    assert.equal(it.cancelCalls, 1);
    assert.equal(t.dialog.calls.length, 1);
    assert.deepEqual(it.saveDialogOptions, []);
    assert.equal(t.dialog.calls[0].parent, t.main);
  });
}

test('main window: a hidden main window (tray) gets the blocked box unparented', () => {
  const t = setup();
  t.main.visible = false;
  t.run(item('file:///C:/x.bin'), t.main.webContents);
  assert.ok(t.dialog.calls[0].parent == null);
});

test('main window: a Chat downloadURL download ends in this same handler (an https attachment gets the save dialog)', () => {
  const t = setup();
  const it = item('https://chat.google.com/api/get_attachment_url?x=1', { filename: 'photo.png' });
  t.run(it, t.main.webContents);
  assert.deepEqual(it.saveDialogOptions, [{ defaultPath: path.join(DIR, 'photo.png') }]);
});

// --- other contents untouched --------------------------------------------------------------------------------------------------------------------

test('contents that are neither an app window nor the main window are left to Electron: no call on the item, no dialog', () => {
  const t = setup();
  const it = item('https://evil.example/x');
  const event = t.run(it, { id: 999 });
  assert.equal(event.defaultPrevented, false);
  assert.equal(it.cancelCalls, 0);
  assert.equal(it.savePathCalls, 0);
  assert.deepEqual(it.saveDialogOptions, []);
  assert.equal(t.dialog.calls.length, 0);
});

test('a download from a destroyed or unknown webContents does not throw', () => {
  const t = setup();
  assert.doesNotThrow(() => t.run(item('https://evil.example/x'), undefined));
  assert.doesNotThrow(() => t.run(item('https://evil.example/x'), null));
});

// --- save path: basename only -----------------------------------------------------------------------------------------------------------------------

test('save path: a hostile name with a traversal is neutralised to its basename inside the Downloads folder', () => {
  const t = setup();
  const win = t.newAppWin();
  const it = item(DRIVE_FILE, { filename: '../../evil.exe' });
  t.run(it, win.webContents);
  assert.deepEqual(it.saveDialogOptions, [{ defaultPath: path.join(DIR, 'evil.exe') }]);
});

test('save path: an absolute name keeps only its basename', () => {
  const t = setup();
  const it = item('https://anywhere.example/x', { filename: '/etc/passwd' });
  t.run(it, t.main.webContents);
  assert.deepEqual(it.saveDialogOptions, [{ defaultPath: path.join(DIR, 'passwd') }]);
});

test('save path: a Windows-style traversal name keeps only its basename', { skip: process.platform !== 'win32' }, () => {
  const t = setup();
  const it = item('https://anywhere.example/x', { filename: '..\\..\\Windows\\evil.exe' });
  t.run(it, t.main.webContents);
  assert.deepEqual(it.saveDialogOptions, [{ defaultPath: path.join(DIR, 'evil.exe') }]);
});

for (const name of ['..', '.', '']) {
  test(`save path: the degenerate name ${JSON.stringify(name)} never resolves outside the Downloads folder`, () => {
    const t = setup();
    const it = item('https://anywhere.example/x', { filename: name });
    t.run(it, t.main.webContents);
    assert.equal(path.dirname(it.saveDialogOptions[0].defaultPath), DIR);
  });
}

// --- nothing is opened or launched, nothing logged but status ---------------------------------------------------------------------------------------

test('finish: a completed download opens nothing - no browser call, no dialog', () => {
  const t = setup();
  const win = t.newAppWin();
  const it = item(DRIVE_FILE);
  t.run(it, win.webContents);
  it.finish('completed');
  assert.deepEqual(t.state.external, []);
  assert.equal(t.dialog.calls.length, 0);
});

test('source: downloads.js never opens or reveals a file (no openPath, showItemInFolder, shell) and logs nothing but status', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'downloads.js'), 'utf8');
  const code = source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal(/openPath|showItemInFolder|\bshell\b|setSavePath/.test(code), false);
  assert.equal(/require\(['"]electron['"]\)/.test(code), false, 'no Electron import: collaborators are injected');
});

test('logging: only status words and the scheme - never a file name, url, host or document id', () => {
  const t = setup();
  const win = t.newAppWin();
  const ok = item(DRIVE_FILE, { filename: 'secret-name-xyz.pdf', chain: ['https://drive.google.com/file/d/SECRETID123/view'] });
  t.run(ok, win.webContents);
  ok.finish('completed');
  t.run(item('https://evil.example/secret-path-xyz', { filename: 'blocked-secret.bin' }), win.webContents);
  const logged = JSON.stringify(t.state.logs);
  for (const secret of ['secret-name-xyz', 'SECRETID123', 'secret-path-xyz', 'blocked-secret', 'evil.example', 'drive.google.com']) {
    assert.equal(logged.includes(secret), false, secret);
  }
  assert.match(logged, /started/);
  assert.match(logged, /completed/);
  assert.match(logged, /blocked/);
});
