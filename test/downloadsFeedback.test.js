'use strict';

// UI-12 / ADR-0006: download progress on the taskbar, one completion notice, "Show in folder".
//
// Coverage map (acceptance -> test):
//   1 progress while running, cleared on completion / cancel / failure   -> 'progress: ...' tests
//   2 one notice per completed download, click or action reveals, Mute   -> 'notice: ...' tests
//   3 failure and cancel: no notice, no reveal                           -> 'cancel / failure: ...'
//   4 no new app-drawn surface; wording                                  -> 'wording: ...', source test
//   5 nothing logged with a file name / path / URL                       -> 'logging: ...'
//   ADR conditions: exact matching only, never a path outside this handler's own completed items
//                                                                        -> 'reveal: ...' tests
//   Blocked / sign-in-blocked downloads never produce progress or notice -> 'blocked: ...'

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createFakeBrowserWindowClass, makeEvent } = require('./helpers/electronFakes');
const { createDownloadHandler, COMPLETE, redactPath, completionBody } = require('../src/main/downloads');

const DIR = path.resolve(path.sep, 'users', 'u', 'Downloads');
const DRIVE_FILE = 'https://drive.google.com/file/d/1/view';

class FakeItem extends EventEmitter {
  constructor({ url = DRIVE_FILE, filename = 'report.pdf', savePath = path.join(DIR, 'report.pdf') } = {}) {
    super();
    this.url = url;
    this.filename = filename;
    this.savePath = savePath;
    this.received = 0;
    this.total = 0;
    this.cancelCalls = 0;
  }

  getURL() { return this.url; }
  getURLChain() { return [this.url]; }
  getFilename() { return this.filename; }
  getSavePath() { return this.savePath; }
  getReceivedBytes() { return this.received; }
  getTotalBytes() { return this.total; }
  setSaveDialogOptions() {}
  cancel() { this.cancelCalls += 1; }
  progress(received, total, state = 'progressing') {
    this.received = received;
    this.total = total;
    this.emit('updated', makeEvent(), state);
  }
  finish(state = 'completed') { this.emit('done', makeEvent(), state); }
}

function setup(over = {}) {
  const BrowserWindow = createFakeBrowserWindowClass();
  const main = new BrowserWindow({});
  const rec = { progress: [], notices: [], revealed: [], logs: [] };
  const deps = {
    getAppWindowForContents: () => null,
    getMainWindow: () => main,
    closeEmptyWindow: () => false,
    getDownloadsDir: () => DIR,
    showMessageBox: async () => ({ response: 0 }),
    openExternal: () => {},
    setProgress: (v) => rec.progress.push(v),
    showCompletionNotice: (n) => rec.notices.push(n),
    revealItem: (p) => rec.revealed.push(p),
    fileExists: () => true,
    log: (...a) => rec.logs.push(a),
    ...over,
  };
  const handler = createDownloadHandler(deps);
  const run = (item) => handler(makeEvent(), item, main.webContents);
  return { run, rec, main };
}

// --- 1. progress -------------------------------------------------------------------------------------------------------------

test('progress: reports received/total while running and clears (-1) on completion', () => {
  const t = setup();
  const it = new FakeItem();
  t.run(it);
  it.progress(25, 100);
  it.progress(50, 100);
  it.finish('completed');
  assert.deepEqual(t.rec.progress, [0.25, 0.5, -1]);
});

test('progress: an unknown total shows the indeterminate value (2)', () => {
  const t = setup();
  const it = new FakeItem();
  t.run(it);
  it.progress(10, 0);
  assert.deepEqual(t.rec.progress, [2]);
});

test('progress: concurrent downloads aggregate, and the bar clears only when the last one ends', () => {
  const t = setup();
  const a = new FakeItem();
  const b = new FakeItem({ savePath: path.join(DIR, 'b.pdf') });
  t.run(a);
  t.run(b);
  a.progress(50, 100);
  b.progress(0, 300);
  a.finish('completed');
  b.finish('cancelled');
  assert.deepEqual(t.rec.progress, [0.5, 50 / 400, 0, -1]);
});

test('progress: an item still waiting for the Save dialog (no update yet) does not move the bar', () => {
  const t = setup();
  t.run(new FakeItem());
  assert.deepEqual(t.rec.progress, []);
});

test('progress: cancelled and interrupted downloads clear the bar', () => {
  for (const state of ['cancelled', 'interrupted']) {
    const t = setup();
    const it = new FakeItem();
    t.run(it);
    it.progress(5, 10);
    it.finish(state);
    assert.deepEqual(t.rec.progress, [0.5, -1], state);
  }
});

test('progress: a throwing setProgress never breaks the download or the notice', () => {
  const t = setup({ setProgress: () => { throw new Error('gone'); } });
  const it = new FakeItem();
  t.run(it);
  it.progress(1, 2);
  it.finish('completed');
  assert.equal(it.cancelCalls, 0);
  assert.equal(t.rec.notices.length, 1);
});

// --- 2. notice ---------------------------------------------------------------------------------------------------------------

test('notice: exactly one per completed download; click reveals exactly the Save-dialog path', async () => {
  const t = setup();
  const it = new FakeItem();
  t.run(it);
  it.finish('completed');
  assert.equal(t.rec.notices.length, 1);
  assert.equal(t.rec.revealed.length, 0, 'nothing is revealed until the user clicks');
  await t.rec.notices[0].onReveal();
  assert.deepEqual(t.rec.revealed, [it.savePath]);
});

test('notice: two downloads give two notices, each revealing its own path', async () => {
  const t = setup();
  const a = new FakeItem({ savePath: path.join(DIR, 'a.pdf') });
  const b = new FakeItem({ savePath: path.join(DIR, 'b.pdf') });
  t.run(a);
  t.run(b);
  b.finish('completed');
  a.finish('completed');
  assert.equal(t.rec.notices.length, 2);
  await t.rec.notices[0].onReveal();
  await t.rec.notices[1].onReveal();
  assert.deepEqual(t.rec.revealed, [b.savePath, a.savePath]);
});

test('notice: Mute on -> no notice, but the progress still ran', () => {
  const t = setup({ isNoticeMuted: () => true });
  const it = new FakeItem();
  t.run(it);
  it.progress(1, 2);
  it.finish('completed');
  assert.equal(t.rec.notices.length, 0);
  assert.deepEqual(t.rec.progress, [0.5, -1]);
});

test('notice: without showCompletionNotice (old callers) nothing is raised and nothing breaks', () => {
  const t = setup({ showCompletionNotice: null });
  const it = new FakeItem();
  t.run(it);
  it.finish('completed');
  assert.deepEqual(t.rec.revealed, []);
});

test('wording: title, action and body are the specified texts', () => {
  assert.equal(COMPLETE.title, 'Download complete');
  assert.equal(COMPLETE.action, 'Show in folder');
  const t = setup();
  const it = new FakeItem();
  t.run(it);
  it.finish('completed');
  const n = t.rec.notices[0];
  assert.equal(n.title, 'Download complete');
  assert.equal(n.actionText, 'Show in folder');
  assert.equal(n.body, 'report.pdf\nClick to show it in its folder.');
});

test('wording: a very long name is cut in the middle, the extension stays, control characters are removed', () => {
  const body = completionBody(path.join(DIR, `${'x'.repeat(300)}invoice.pdf.exe`));
  const [name] = body.split('\n');
  assert.equal(name.length, 80);
  assert.ok(name.includes('...'));
  assert.ok(name.endsWith('.pdf.exe'));
  assert.equal(completionBody(path.join(DIR, 'a\u0007b.txt')).split('\n')[0], 'a b.txt');
});

test('F4 wording: bidi overrides, other format characters and C1 controls cannot disguise the name', () => {
  const nameOf = (n) => completionBody(path.join(DIR, n)).split('\n')[0];
  assert.equal(nameOf('invoice‮txt.exe'), 'invoicetxt.exe');
  assert.equal(nameOf('a⁦b⁩c​d‏e﻿f.pdf'), 'abcdef.pdf');
  assert.equal(nameOf('a\u0085b\u009Fc\u007Fd.txt'), 'a b c d.txt');
  assert.equal(completionBody(path.join(DIR, 'a‮b.pdf')).split('\n')[1], COMPLETE.bodySuffix);
});

// --- 3. cancel / failure -----------------------------------------------------------------------------------------------------

test('cancel / failure: no notice, no reveal, bar cleared', () => {
  for (const state of ['cancelled', 'interrupted']) {
    const t = setup();
    const it = new FakeItem();
    t.run(it);
    it.progress(1, 2);
    it.finish(state);
    assert.equal(t.rec.notices.length, 0, state);
    assert.deepEqual(t.rec.revealed, [], state);
    assert.equal(t.rec.progress.at(-1), -1, state);
  }
});

test('cancel in the Save dialog (no update ever, state cancelled): no notice and the bar stays clear', () => {
  const t = setup();
  const it = new FakeItem({ savePath: '' });
  t.run(it);
  it.finish('cancelled');
  assert.equal(t.rec.notices.length, 0);
  assert.equal(t.rec.progress.at(-1), -1);
});

// --- reveal: exact matching --------------------------------------------------------------------------------------------------

test('reveal: a completed item with an empty or relative save path raises no notice', () => {
  for (const savePath of ['', 'relative/file.pdf', `${DIR}${path.sep}a\0b.pdf`]) {
    const t = setup();
    const it = new FakeItem({ savePath });
    t.run(it);
    it.finish('completed');
    assert.equal(t.rec.notices.length, 0, JSON.stringify(savePath));
  }
});

test('reveal: the file no longer exists -> nothing is revealed', async () => {
  const t = setup({ fileExists: () => false });
  const it = new FakeItem();
  t.run(it);
  it.finish('completed');
  await t.rec.notices[0].onReveal();
  assert.deepEqual(t.rec.revealed, []);
  assert.ok(t.rec.logs.some((l) => /file gone/.test(l[0])));
});

test('F1 reveal: an async existence check that answers true reveals the file', async () => {
  const t = setup({ fileExists: async () => true });
  const it = new FakeItem();
  t.run(it);
  it.finish('completed');
  await t.rec.notices[0].onReveal();
  assert.deepEqual(t.rec.revealed, [it.savePath]);
});

test('F1 reveal: an existence check that never answers is cut by the timeout, nothing is revealed, no path is logged', async () => {
  const t = setup({ fileExists: () => new Promise(() => {}), existsTimeoutMs: 20 });
  const it = new FakeItem();
  t.run(it);
  it.finish('completed');
  const started = Date.now();
  await t.rec.notices[0].onReveal();
  assert.ok(Date.now() - started < 1000, 'returned promptly');
  assert.deepEqual(t.rec.revealed, []);
  assert.ok(t.rec.logs.some((l) => /unreachable/.test(l[0])));
  assert.equal(JSON.stringify(t.rec.logs).includes('Downloads'), false);
});

test('F1 reveal: a rejecting or throwing existence check is treated as not present', async () => {
  for (const fileExists of [() => Promise.reject(new Error('EIO')), () => { throw new Error('EIO'); }]) {
    const t = setup({ fileExists });
    const it = new FakeItem();
    t.run(it);
    it.finish('completed');
    await t.rec.notices[0].onReveal();
    assert.deepEqual(t.rec.revealed, []);
  }
});

test('F1 index.js: the existence check is asynchronous, existsSync is not used', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.js'), 'utf8');
  assert.equal(/existsSync/.test(src.replace(/\/\/.*$/gm, '')), false);
});

test('reveal: a throwing reveal is contained and logged by error name only', async () => {
  const t = setup({ revealItem: () => { throw new TypeError('C:\\secret\\name.txt'); } });
  const it = new FakeItem();
  t.run(it);
  it.finish('completed');
  await assert.doesNotReject(async () => t.rec.notices[0].onReveal());
  assert.equal(JSON.stringify(t.rec.logs).includes('secret'), false);
});

test('reveal: the handler exposes no way to reveal a path it did not produce (only the onReveal closure)', async () => {
  const t = setup();
  const it = new FakeItem();
  t.run(it);
  it.finish('completed');
  const keys = Object.keys(t.rec.notices[0]).sort();
  assert.deepEqual(keys, ['actionText', 'body', 'onReveal', 'title']);
  assert.equal(t.rec.notices[0].onReveal.length, 0, 'onReveal takes no path argument');
  await t.rec.notices[0].onReveal('/etc/passwd');
  assert.deepEqual(t.rec.revealed, [it.savePath]);
});

test('F3 reveal: a re-downloaded path moves to the newest position and is not the next one evicted', async () => {
  const t = setup();
  const again = path.join(DIR, 'again.pdf');
  const finish = (p) => {
    const it = new FakeItem({ savePath: p });
    t.run(it);
    it.finish('completed');
  };
  finish(again);
  for (let i = 1; i <= 40; i++) finish(path.join(DIR, `g${i}.pdf`));
  finish(again); // refreshed: now newest
  for (let i = 41; i <= 55; i++) finish(path.join(DIR, `g${i}.pdf`)); // 56 adds in total, 'again' stays within the 50 newest
  const last = t.rec.notices.filter((n) => n.body.startsWith('again.pdf')).pop();
  await last.onReveal();
  assert.deepEqual(t.rec.revealed, [again]);
});

test('reveal: the registry is bounded and an evicted path is refused', async () => {
  const t = setup();
  const first = new FakeItem({ savePath: path.join(DIR, 'f0.pdf') });
  t.run(first);
  first.finish('completed');
  for (let i = 1; i <= 50; i++) {
    const it = new FakeItem({ savePath: path.join(DIR, `f${i}.pdf`) });
    t.run(it);
    it.finish('completed');
  }
  await t.rec.notices[0].onReveal();
  assert.deepEqual(t.rec.revealed, [], 'the oldest of 51 was evicted');
  await t.rec.notices[50].onReveal();
  assert.equal(t.rec.revealed.length, 1);
});

// --- blocked ----------------------------------------------------------------------------------------------------------------

test('blocked: a refused download (sign-in mode) produces no progress, notice or reveal', () => {
  const t = setup({ isMainDownloadBlocked: () => true });
  const it = new FakeItem();
  t.run(it);
  assert.equal(it.cancelCalls, 1);
  assert.deepEqual(t.rec.progress, []);
  assert.deepEqual(t.rec.notices, []);
});

test('blocked: a download from a disallowed scheme in the main window is cancelled without feedback', () => {
  const t = setup();
  const it = new FakeItem({ url: 'http://evil.example/x' });
  t.run(it);
  assert.equal(it.cancelCalls, 1);
  assert.deepEqual(t.rec.notices, []);
});

// --- 5. logging --------------------------------------------------------------------------------------------------------------

test('F2 logging: a UNC path logs neither server nor share', () => {
  for (const p of ['\\\\fileserver01\\finance-share\\Q3\\bob\\x.pdf', '\\\\?\\UNC\\fileserver01\\finance-share\\x.pdf']) {
    const out = redactPath(p, path.win32);
    assert.ok(out.startsWith('\\\\...'), out);
    assert.equal(/fileserver|finance|bob|x\.pdf/.test(out), false, out);
  }
  assert.equal(redactPath('\\\\fileserver01\\finance-share\\Q3\\bob\\x.pdf', path.win32), '\\\\......[depth 2]');
});

test('logging: redactPath keeps only the root and the folder depth', () => {
  assert.equal(redactPath(path.join(DIR, 'secret-name.pdf')), `${path.parse(DIR).root}...[depth 3]`);
  assert.equal(redactPath(path.resolve(path.sep, 'a.txt')), `${path.parse(DIR).root}...[depth 0]`);
  assert.equal(redactPath(''), '<none>');
  assert.equal(redactPath('C:\\Users\\bob\\Downloads\\x.pdf', path.win32), 'C:\\...[depth 3]');
  assert.equal(redactPath('/home/bob/x.pdf', path.posix), '/...[depth 2]');
  assert.equal(redactPath(null), '<none>');
});

test('logging: a full run (progress, notice, reveal, gone, refused) logs no name, path, url or query', async () => {
  const t = setup();
  const it = new FakeItem({
    url: 'https://drive.google.com/file/d/SECRETID/view?token=SECRETQ',
    filename: 'secret-name-xyz.pdf',
    savePath: path.join(DIR, 'secret-name-xyz.pdf'),
  });
  t.run(it);
  it.progress(1, 2);
  it.finish('completed');
  await t.rec.notices[0].onReveal();
  const logged = JSON.stringify(t.rec.logs);
  for (const secret of ['secret-name', 'SECRETID', 'SECRETQ', 'token', 'drive.google.com', 'users', 'Downloads', 'report']) {
    assert.equal(logged.includes(secret), false, secret);
  }
  assert.match(logged, /download reveal/);
});

// --- source guards -----------------------------------------------------------------------------------------------------------

function stripComments(source) {
  return source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

test('source: downloads.js still has no Electron import and never opens or launches anything', () => {
  const code = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'downloads.js'), 'utf8'));
  assert.equal(/require\(['"]electron['"]\)/.test(code), false);
  assert.equal(/openPath|showItemInFolder|\bshell\b|openExternal\(\s*savePath|setSavePath/.test(code), false);
});

test('source: index.js reaches showItemInFolder exactly once, never openPath, and adds no window for downloads', () => {
  const code = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.js'), 'utf8'));
  assert.equal((code.match(/showItemInFolder/g) || []).length, 1);
  assert.equal(/openPath/.test(code), false);
});
