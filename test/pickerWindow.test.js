'use strict';

// UI-01 screen-share picker, main-process side (docs/architecture/meet-call-window.md section 7;
// ipc-contract.md "Screen-share picker window"). RED until src/main/pickerWindow.js exists.
//
// API contract assumed (the doc names the channels and rules, not the module surface):
//
//   src/main/pickerWindow.js
//   PICKER_CHANNELS = { getSources: 'picker:get-sources', choose: 'picker:choose', cancel: 'picker:cancel' }
//
//   buildPickerWindowOptions({ parent, preloadPath }) -> BrowserWindow options: parent, modal: true,
//     webPreferences { contextIsolation: true, nodeIntegration: false, sandbox: true, preload:
//     preloadPath, partition: <its own NON-persistent partition: not 'persist:*', not the app's> }.
//
//   configurePickerSession(ses): every permission request is denied (callback(false)) and every check
//     is false, whatever the origin or permission.
//
//   createPickerWindow({ BrowserWindow, session, parent, preloadPath, htmlPath }) -> window
//     new BrowserWindow(buildPickerWindowOptions(...)); configurePickerSession(session.fromPartition(
//     <that partition>)); will-navigate is ALWAYS prevented; setWindowOpenHandler denies;
//     loadFile(htmlPath) (never loadURL, never a remote address).
//
//   createPickerController({ createWindow, getSources, bundledFileUrl, log })
//     createWindow({ parent }) -> window (the real one wraps createPickerWindow)
//     getSources() -> Promise<DesktopCapturerSource[]> (screens + windows; each { id, name,
//       thumbnail: { toDataURL() } }); called ONLY when the renderer asks (asynchronously), never when
//       the window opens - so the loading state shows at once
//     bundledFileUrl: the exact frame URL main accepts (the bundled file)
//     -> {
//          open(parent) -> Promise<{ sourceId, sources } | null>   // null = cancel / window closed / abort
//          abortPending(), isOpen(), raise() (restore+show+focus the picker), flash() (flashFrame on it)
//          handlers: { getSources(event), choose(event, payload), cancel(event) }
//          register(ipcMain)  // ipcMain.handle(get-sources), ipcMain.handle(choose), ipcMain.on(cancel)
//        }
//     `event` = { sender: <webContents with .id>, senderFrame: { url } }.
//     handlers.getSources -> [{ id, name, kind: 'screen'|'window', thumbnail: <data URL> }]; an invalid
//       sender gets [] and getSources() is not called; a getSources() failure REJECTS (the renderer shows
//       its error state) and leaves the request pending.
//     handlers.choose(event, { sourceId }) -> { ok: boolean }: ok only for a valid sender, a request
//       still pending and an id from the list THIS picker was sent; then open() resolves
//       { sourceId, sources: <the raw list> } and the window is closed.
//     handlers.cancel(event): valid sender -> open() resolves null and the window is closed.
//     Invalid senders are dropped and logged WITHOUT content (no source ids, no thumbnails).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFakeBrowserWindowClass, FakeWebContents, settle } = require('./helpers/electronFakes');
const { PARTITION } = require('../src/main/session.js');
const { load } = require('./helpers/pending');

const FILE_URL = 'file:///app/src/renderer/picker/picker.html';
const PRELOAD = '/app/src/preload/pickerPreload.js';
const HTML = '/app/src/renderer/picker/picker.html';
const THUMB_1 = 'data:image/png;base64,AAAA-screen';
const THUMB_2 = 'data:image/png;base64,BBBB-window';

const RAW_SOURCES = [
  { id: 'screen:1:0', name: 'Entire screen', thumbnail: { toDataURL: () => THUMB_1 } },
  { id: 'window:42:0', name: 'Some window', thumbnail: { toDataURL: () => THUMB_2 } },
];

function deferred() {
  const d = {};
  d.promise = new Promise((resolve, reject) => { d.resolve = resolve; d.reject = reject; });
  return d;
}

function setup({ sources = RAW_SOURCES } = {}) {
  const Win = createFakeBrowserWindowClass();
  const state = { logs: [], getSourcesCalls: 0, parents: [], next: null };
  const controller = load('pickerWindow.js').createPickerController({
    createWindow: ({ parent }) => { state.parents.push(parent); return new Win({}); },
    getSources: () => {
      state.getSourcesCalls += 1;
      return state.next ? state.next.promise : Promise.resolve(sources);
    },
    bundledFileUrl: FILE_URL,
    log: (...args) => state.logs.push(args),
  });
  const parent = { id: 'call-window' };
  const win = () => Win.instances[Win.instances.length - 1];
  const good = () => ({ sender: win().webContents, senderFrame: { url: FILE_URL } });
  return { controller, state, parent, win, good, Win };
}

// --- window options and hardening ------------------------------------------------------------------

test('picker options: modal child of the call window with its own preload and hardened webPreferences', () => {
  const parent = {};
  const o = load('pickerWindow.js').buildPickerWindowOptions({ parent, preloadPath: PRELOAD });
  assert.equal(o.parent, parent);
  assert.equal(o.modal, true);
  assert.equal(o.webPreferences.contextIsolation, true);
  assert.equal(o.webPreferences.nodeIntegration, false);
  assert.equal(o.webPreferences.sandbox, true);
  assert.equal(o.webPreferences.preload, PRELOAD);
});

test('picker options: its own NON-persistent partition, never the main session', () => {
  const { partition } = load('pickerWindow.js').buildPickerWindowOptions({ parent: {}, preloadPath: PRELOAD }).webPreferences;
  assert.equal(typeof partition, 'string');
  assert.notEqual(partition, '');
  assert.equal(partition.startsWith('persist:'), false);
  assert.notEqual(partition, PARTITION);
});

test('picker options: no weakening flags', () => {
  const { webPreferences } = load('pickerWindow.js').buildPickerWindowOptions({ parent: {}, preloadPath: PRELOAD });
  assert.notEqual(webPreferences.webSecurity, false);
  assert.notEqual(webPreferences.webviewTag, true);
  assert.notEqual(webPreferences.nodeIntegrationInSubFrames, true);
});

test('configurePickerSession: every permission request is denied and every check is false', () => {
  const h = {};
  load('pickerWindow.js').configurePickerSession({
    setPermissionRequestHandler: (fn) => { h.request = fn; },
    setPermissionCheckHandler: (fn) => { h.check = fn; },
  });
  for (const permission of ['media', 'display-capture', 'notifications', 'clipboard-sanitized-write', 'fullscreen', 'unknown']) {
    let granted = 'unset';
    h.request({ getURL: () => 'file:///x' }, permission, (v) => { granted = v; }, { requestingUrl: FILE_URL });
    assert.equal(granted, false, `request ${permission}`);
    assert.equal(h.check(null, permission, FILE_URL, {}), false, `check ${permission}`);
  }
});

function createPicker() {
  const Win = createFakeBrowserWindowClass();
  const sessions = [];
  const session = {
    fromPartition: (name) => {
      const ses = { name, request: null, check: null, setPermissionRequestHandler(fn) { ses.request = fn; }, setPermissionCheckHandler(fn) { ses.check = fn; } };
      sessions.push(ses);
      return ses;
    },
  };
  const parent = {};
  const win = load('pickerWindow.js').createPickerWindow({ BrowserWindow: Win, session, parent, preloadPath: PRELOAD, htmlPath: HTML });
  return { Win, win, sessions, parent };
}

test('createPickerWindow: creates one window from the built options and loads the bundled file (never a URL)', () => {
  const { Win, win, parent } = createPicker();
  assert.equal(Win.instances.length, 1);
  assert.equal(win.options.parent, parent);
  assert.equal(win.options.modal, true);
  assert.equal(win.options.webPreferences.preload, PRELOAD);
  assert.deepEqual(win.loadFileCalls, [HTML]);
  assert.deepEqual(win.webContents.loadCalls, []);
});

test('createPickerWindow: permissions are denied on the picker partition, which is the one the window was created with', () => {
  const { win, sessions } = createPicker();
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].name, win.options.webPreferences.partition);
  let granted = 'unset';
  sessions[0].request(null, 'media', (v) => { granted = v; }, {});
  assert.equal(granted, false);
});

test('createPickerWindow: will-navigate is always prevented and popups are denied', () => {
  const { win } = createPicker();
  for (const url of ['https://example.org/', FILE_URL, 'file:///etc/passwd', 'not a url']) {
    assert.equal(win.webContents.navigate(url).defaultPrevented, true, url);
  }
  assert.deepEqual(win.webContents.windowOpen('https://example.org/'), { action: 'deny' });
});

// --- controller: lifecycle --------------------------------------------------------------------------------

test('picker open: the window is created at once as a child of the given parent, and no sources are listed yet (loading state first)', () => {
  const { controller, state, parent } = setup();
  controller.open(parent);
  assert.deepEqual(state.parents, [parent]);
  assert.equal(state.getSourcesCalls, 0);
  assert.equal(controller.isOpen(), true);
});

test('picker cancel from the picker itself: open() resolves null and the window is closed', async () => {
  const { controller, parent, win, good } = setup();
  const result = controller.open(parent);
  controller.handlers.cancel(good());
  assert.equal(await result, null);
  assert.equal(win().destroyed, true);
  assert.equal(controller.isOpen(), false);
});

test('picker: the user closing the window (X / Escape closes it) resolves null', async () => {
  const { controller, parent, win } = setup();
  const result = controller.open(parent);
  win().close();
  assert.equal(await result, null);
  assert.equal(controller.isOpen(), false);
});

test('picker abortPending: closes the picker, resolves null, drops the references', async () => {
  const { controller, parent, win } = setup();
  const result = controller.open(parent);
  controller.abortPending();
  assert.equal(await result, null);
  assert.equal(win().destroyed, true);
  assert.equal(controller.isOpen(), false);
});

test('picker abortPending with nothing open is a harmless no-op', () => {
  const { controller } = setup();
  assert.doesNotThrow(() => controller.abortPending());
  assert.equal(controller.isOpen(), false);
});

test('picker raise and flash act on the PICKER window; both are no-ops when it is closed', () => {
  const { controller, parent, win } = setup();
  assert.doesNotThrow(() => { controller.raise(); controller.flash(); });
  controller.open(parent);
  controller.raise();
  controller.flash();
  assert.ok(win().count('focus') >= 1);
  assert.equal(win().count('flashFrame'), 1);
});

// --- controller: get-sources -----------------------------------------------------------------------------

test('picker get-sources: lists screens and windows with kind and a data-URL thumbnail', async () => {
  const { controller, parent, good } = setup();
  controller.open(parent);
  const list = await controller.handlers.getSources(good());
  assert.deepEqual(list, [
    { id: 'screen:1:0', name: 'Entire screen', kind: 'screen', thumbnail: THUMB_1 },
    { id: 'window:42:0', name: 'Some window', kind: 'window', thumbnail: THUMB_2 },
  ]);
});

test('picker get-sources is asynchronous: the handler returns before the (slow) listing finishes', async () => {
  const { controller, parent, good, state } = setup();
  state.next = deferred();
  controller.open(parent);
  let resolved = false;
  const pending = controller.handlers.getSources(good()).then((v) => { resolved = true; return v; });
  await settle();
  assert.equal(resolved, false);
  assert.equal(state.getSourcesCalls, 1);
  state.next.resolve(RAW_SOURCES);
  assert.equal((await pending).length, 2);
});

test('picker get-sources failing rejects (the renderer shows its error state) and the request stays pending', async () => {
  const { controller, parent, good, state } = setup();
  state.next = deferred();
  const result = controller.open(parent);
  const failing = controller.handlers.getSources(good());
  state.next.reject(new Error('capture failed'));
  await assert.rejects(failing);
  assert.equal(controller.isOpen(), true);
  controller.handlers.cancel(good());
  assert.equal(await result, null);
});

// --- controller: choose -----------------------------------------------------------------------------------

test('picker choose: an id from the list that was sent -> ok, open() resolves the choice with the raw list, window closed', async () => {
  const { controller, parent, win, good } = setup();
  const result = controller.open(parent);
  await controller.handlers.getSources(good());
  const reply = await controller.handlers.choose(good(), { sourceId: 'window:42:0' });
  assert.deepEqual(reply, { ok: true });
  assert.deepEqual(await result, { sourceId: 'window:42:0', sources: RAW_SOURCES });
  assert.equal(win().destroyed, true);
});

test('picker choose: an id that was never sent is refused and never reaches the request', async () => {
  const { controller, parent, good } = setup();
  const result = controller.open(parent);
  await controller.handlers.getSources(good());
  assert.deepEqual(await controller.handlers.choose(good(), { sourceId: 'screen:999:0' }), { ok: false });
  controller.handlers.cancel(good());
  assert.equal(await result, null);
});

test('picker choose before any list was sent is refused (there is nothing to choose from)', async () => {
  const { controller, parent, good } = setup();
  const result = controller.open(parent);
  assert.deepEqual(await controller.handlers.choose(good(), { sourceId: 'screen:1:0' }), { ok: false });
  controller.handlers.cancel(good());
  assert.equal(await result, null);
});

test('picker choose: an empty or malformed selection is refused', async () => {
  const { controller, parent, good } = setup();
  const result = controller.open(parent);
  await controller.handlers.getSources(good());
  for (const payload of [undefined, null, {}, { sourceId: '' }, { sourceId: 42 }, { sourceId: ['screen:1:0'] }, 'screen:1:0']) {
    assert.deepEqual(await controller.handlers.choose(good(), payload), { ok: false }, JSON.stringify(payload));
  }
  controller.handlers.cancel(good());
  assert.equal(await result, null);
});

test('picker choose after the request is gone (cancelled or aborted) is refused and resolves nothing again', async () => {
  const { controller, parent, win, good } = setup();
  const result = controller.open(parent);
  const event = good();
  await controller.handlers.getSources(event);
  controller.abortPending();
  assert.equal(await result, null);
  assert.deepEqual(await controller.handlers.choose({ sender: win().webContents, senderFrame: { url: FILE_URL } }, { sourceId: 'screen:1:0' }), { ok: false });
});

// --- sender validation ------------------------------------------------------------------------------------

function strangers(win) {
  return [
    ['another webContents id', { sender: new FakeWebContents(), senderFrame: { url: FILE_URL } }],
    ['the right id but another frame url', { sender: win.webContents, senderFrame: { url: 'https://meet.google.com/abc' } }],
    ['the right id but a different local file', { sender: win.webContents, senderFrame: { url: 'file:///app/src/renderer/settings.html' } }],
    ['no senderFrame', { sender: win.webContents }],
    ['no sender', { senderFrame: { url: FILE_URL } }],
    ['an empty event', {}],
  ];
}

test('picker sender validation: get-sources from anyone but the picker is dropped (empty list, listing never started)', async () => {
  const { controller, parent, win, state } = setup();
  controller.open(parent);
  for (const [label, event] of strangers(win())) {
    assert.deepEqual(await controller.handlers.getSources(event), [], label);
  }
  assert.equal(state.getSourcesCalls, 0);
});

test('picker sender validation: choose from anyone but the picker is refused even for a valid id', async () => {
  const { controller, parent, win, good } = setup();
  const result = controller.open(parent);
  await controller.handlers.getSources(good());
  for (const [label, event] of strangers(win())) {
    assert.deepEqual(await controller.handlers.choose(event, { sourceId: 'screen:1:0' }), { ok: false }, label);
  }
  controller.handlers.cancel(good());
  assert.equal(await result, null, 'the request was never resolved with a choice');
});

test('picker sender validation: cancel from anyone but the picker is ignored (the request stays pending)', async () => {
  const { controller, parent, win } = setup();
  controller.open(parent);
  for (const [, event] of strangers(win())) controller.handlers.cancel(event);
  assert.equal(controller.isOpen(), true);
  assert.equal(win().destroyed, false);
});

test('picker sender validation: a dropped message is logged without content (no source ids, no thumbnails)', async () => {
  const { controller, parent, good, state } = setup();
  controller.open(parent);
  await controller.handlers.getSources(good());
  const outsider = { sender: new FakeWebContents(), senderFrame: { url: 'https://evil.example/' } };
  await controller.handlers.choose(outsider, { sourceId: 'screen:1:0' });
  assert.ok(state.logs.length >= 1);
  const logged = JSON.stringify(state.logs);
  assert.equal(logged.includes('screen:1:0'), false);
  assert.equal(logged.includes('data:image'), false);
  assert.equal(logged.includes(THUMB_1), false);
});

test('picker thumbnails (live screen content) are never logged on the happy path either', async () => {
  const { controller, parent, good, state } = setup();
  const result = controller.open(parent);
  await controller.handlers.getSources(good());
  await controller.handlers.choose(good(), { sourceId: 'screen:1:0' });
  await result;
  const logged = JSON.stringify(state.logs);
  assert.equal(logged.includes('data:image'), false);
  assert.equal(logged.includes('AAAA'), false);
});

// --- IPC registration ------------------------------------------------------------------------------------

function fakeIpcMain() {
  const registered = { handle: {}, on: {} };
  return {
    registered,
    handle: (channel, fn) => { registered.handle[channel] = fn; },
    on: (channel, fn) => { registered.on[channel] = fn; },
  };
}

test('picker register: exactly the three final channels, two invoke handlers and one send listener', () => {
  const { controller } = setup();
  const ipc = fakeIpcMain();
  controller.register(ipc);
  assert.deepEqual(Object.keys(ipc.registered.handle).sort(), ['picker:choose', 'picker:get-sources']);
  assert.deepEqual(Object.keys(ipc.registered.on), ['picker:cancel']);
});

test('picker register: the channels drive the controller end to end', async () => {
  const { controller, parent, good } = setup();
  const ipc = fakeIpcMain();
  controller.register(ipc);
  const result = controller.open(parent);
  const list = await ipc.registered.handle['picker:get-sources'](good());
  assert.equal(list.length, 2);
  assert.deepEqual(await ipc.registered.handle['picker:choose'](good(), { sourceId: 'screen:1:0' }), { ok: true });
  assert.equal((await result).sourceId, 'screen:1:0');
});

test('picker register: the cancel listener denies the pending request', async () => {
  const { controller, parent, good } = setup();
  const ipc = fakeIpcMain();
  controller.register(ipc);
  const result = controller.open(parent);
  ipc.registered.on['picker:cancel'](good());
  assert.equal(await result, null);
});

test('PICKER_CHANNELS names the three final channels', () => {
  const { PICKER_CHANNELS } = load('pickerWindow.js');
  assert.deepEqual(PICKER_CHANNELS, { getSources: 'picker:get-sources', choose: 'picker:choose', cancel: 'picker:cancel' });
});
