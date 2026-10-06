'use strict';

// UI-05 / FR-18, docs/architecture/smart-copy.md section 2 and 8 (row "Main signal handler"),
// docs/architecture/ipc-contract.md (smartcopy:signal). RED until src/main/smartCopy.js exists.
//
// API CONTRACT ASSUMED: see the header of test/smartCopyLink.test.js (createSmartCopy deps). The signal handler is
// registered by bindSmartCopyMain(mainWindow) as ipcMain.on('smartcopy:signal', (event, payload) => ...). It copies
// with mainWindow.webContents.copy() and shows the hint 'copied'. The 100 ms trailing-edge window runs on the
// injected `timers`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { load } = require('./helpers/pending');
const { createManualClock } = require('./helpers/electronFakes');
const { buildOrigins } = require('../src/main/origins');

const CHAT_URL = 'https://chat.google.com/room/AAAA';
const SECRET = 'SECRET-SELECTED-TEXT-42';

function setup() {
  const clock = createManualClock();
  const ipcMain = new EventEmitter();
  const hints = [];
  const logs = [];
  const copied = [];

  const webContents = new EventEmitter();
  webContents.mainFrame = { url: CHAT_URL };
  webContents.selection = 'word';
  webContents.copy = () => copied.push(webContents.selection);
  webContents.isDestroyed = () => win.destroyed;

  const win = new EventEmitter();
  win.destroyed = false;
  win.webContents = webContents;
  win.isDestroyed = () => win.destroyed;

  const api = load('smartCopy.js').createSmartCopy({
    clipboard: { writeText: () => {} },
    showHint: (...args) => hints.push(args),
    timers: clock,
    log: (...args) => logs.push(args),
    ipcMain,
    notificationOrigins: buildOrigins(null).notificationOrigins,
  });
  api.bindSmartCopyMain(win);

  const goodEvent = () => ({ sender: webContents, senderFrame: webContents.mainFrame });
  // The payload defaults only when it is OMITTED: an explicit `undefined` must reach the handler as undefined
  // (a default parameter would have silently replaced it with a valid payload).
  const send = (event = goodEvent(), ...rest) =>
    ipcMain.emit('smartcopy:signal', event, ...(rest.length > 0 ? rest : [{ kind: 'selection' }]));
  return { clock, ipcMain, hints, logs, copied, win, webContents, send, goodEvent };
}

// --- registration ---------------------------------------------------------------------------------------------

test('signal: bindSmartCopyMain listens on the smartcopy:signal channel', () => {
  const t = setup();
  assert.deepEqual(t.ipcMain.eventNames(), ['smartcopy:signal']);
});

// --- accepted -------------------------------------------------------------------------------------------------

test('signal: a valid signal calls copy() once and shows the "copied" hint once', () => {
  const t = setup();
  t.send();
  assert.equal(t.copied.length, 1);
  assert.equal(t.hints.length, 1);
  assert.equal(t.hints[0][0], 'copied');
});

// --- rejected -------------------------------------------------------------------------------------------------

function assertDropped(t, what) {
  assert.deepEqual(t.copied, [], what + ': no copy');
  assert.deepEqual(t.hints, [], what + ': no hint');
  t.clock.tick(1000);
  assert.deepEqual(t.copied, [], what + ': no trailing copy either');
  assert.equal(t.logs.length >= 1, true, what + ': the rejection is logged');
}

test('signal: a sender that is not the main window webContents is dropped', () => {
  const t = setup();
  const other = new EventEmitter();
  other.mainFrame = { url: CHAT_URL };
  t.send({ sender: other, senderFrame: other.mainFrame });
  assertDropped(t, 'other sender');
});

test('signal: a null or missing senderFrame is dropped', () => {
  const t = setup();
  t.send({ sender: t.webContents, senderFrame: null });
  t.send({ sender: t.webContents });
  assertDropped(t, 'null frame');
});

test('signal: a sub-frame (not the main frame) is dropped', () => {
  const t = setup();
  t.send({ sender: t.webContents, senderFrame: { url: CHAT_URL } });
  assertDropped(t, 'sub-frame');
});

test('signal: a main window sitting on the sign-in origin or a look-alike origin is dropped', () => {
  for (const url of [
    'https://accounts.google.com/signin',
    'https://chat.google.com.evil.example/room/1',
    'http://chat.google.com/room/1',
    'https://chat.google.com:8443/room/1',
    'about:blank',
    'not a url',
    '',
  ]) {
    const t = setup();
    t.webContents.mainFrame = { url };
    t.send({ sender: t.webContents, senderFrame: t.webContents.mainFrame });
    assertDropped(t, url);
  }
});

test('signal: any payload other than exactly { kind: "selection" } is dropped, and its content is not logged', () => {
  const payloads = [
    { kind: 'selection', text: SECRET },
    { kind: 'selection', extra: 1 },
    { kind: 'link', href: 'https://example.com/' },
    { kind: SECRET },
    { kind: 'Selection' },
    {},
    null,
    undefined,
    'selection',
    SECRET,
    42,
    ['selection'],
    [{ kind: 'selection' }],
  ];
  for (const payload of payloads) {
    const t = setup();
    t.send(t.goodEvent(), payload);
    assertDropped(t, JSON.stringify(payload));
    assert.equal(JSON.stringify(t.logs).includes(SECRET), false, 'no content in the log');
  }
});

test('signal: a destroyed main window drops the signal without throwing', () => {
  const t = setup();
  t.win.destroyed = true;
  assert.doesNotThrow(() => t.send());
  assert.deepEqual(t.copied, []);
  assert.deepEqual(t.hints, []);
});

// --- trailing-edge rate limit ---------------------------------------------------------------------------------

test('rate limit: a signal after an idle window copies at once (leading edge)', () => {
  const t = setup();
  t.send();
  assert.equal(t.copied.length, 1);
  t.clock.tick(5000);
  t.send();
  assert.equal(t.copied.length, 2);
});

test('rate limit: a lone signal causes no trailing copy', () => {
  const t = setup();
  t.send();
  t.clock.tick(1000);
  assert.equal(t.copied.length, 1);
  assert.equal(t.hints.length, 1);
});

test('rate limit: two signals within 100 ms give one immediate and one trailing copy at the end of the window; the last selection wins', () => {
  const t = setup();
  t.webContents.selection = 'word';
  t.send();
  assert.deepEqual(t.copied, ['word']);
  t.clock.tick(50);
  t.webContents.selection = 'paragraph';
  t.send();
  assert.deepEqual(t.copied, ['word'], 'the second signal does not copy at once');
  t.clock.tick(49);
  assert.deepEqual(t.copied, ['word'], 'not before the window ends');
  t.clock.tick(1);
  assert.deepEqual(t.copied, ['word', 'paragraph'], 'the trailing copy sees the then-current selection');
  assert.equal(t.hints.length, 2, 'one hint per actual copy');
});

test('rate limit: five signals inside the window collapse into one trailing copy', () => {
  const t = setup();
  t.send();
  for (let i = 0; i < 5; i++) {
    t.clock.tick(10);
    t.send();
  }
  assert.equal(t.copied.length, 1);
  t.clock.tick(100);
  assert.equal(t.copied.length, 2);
  assert.equal(t.hints.length, 2);
  t.clock.tick(5000);
  assert.equal(t.copied.length, 2, 'nothing more fires later');
});

test('rate limit: after the window has fully passed the next signal is leading again', () => {
  const t = setup();
  t.send();
  t.clock.tick(10);
  t.send();
  t.clock.tick(5000);
  assert.equal(t.copied.length, 2);
  t.send();
  assert.equal(t.copied.length, 3);
});

test('rate limit: the main window destroyed before the trailing timer fires gives no copy, no hint and no throw', () => {
  const t = setup();
  t.send();
  t.clock.tick(10);
  t.send();
  t.win.destroyed = true;
  assert.doesNotThrow(() => t.clock.tick(1000));
  assert.equal(t.copied.length, 1);
  assert.equal(t.hints.length, 1);
});

test('rate limit: the window closed event clears the pending timers', () => {
  const t = setup();
  t.send();
  t.clock.tick(10);
  t.send();
  assert.equal(t.clock.pending() > 0, true);
  t.win.emit('closed');
  assert.equal(t.clock.pending(), 0);
  t.clock.tick(1000);
  assert.equal(t.copied.length, 1);
});

// --- logging --------------------------------------------------------------------------------------------------

test('logging: an accepted signal logs an outcome only, never selection content', () => {
  const t = setup();
  t.webContents.selection = SECRET;
  t.send();
  assert.equal(JSON.stringify(t.logs).includes(SECRET), false);
});
