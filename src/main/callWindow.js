'use strict';

// FR-16 / docs/architecture/meet-call-window.md sections 4, 5, 8 and 9: the Meet call window.
//
// A singleton BrowserWindow that shows ONLY the Meet page: no preload, no app-drawn surface, no
// window-state persistence. Everything the user must be told (live-call close, Exit, a crash) is a
// native message box held in ONE dialog slot. All collaborators are injected (see
// test/helpers/callWindowHarness.js for the contract), so this module is unit-tested with fakes and
// has no Electron import.
//
// Close never quits and never hides: a hidden call would keep the camera and microphone live.

const { MEET_ORIGIN } = require('./meetLink');
const { isMeetingPage } = require('./meetingPage');
const { PARTITION } = require('./session');
const { createCloseProbe } = require('./closeProbe');

const ACCOUNTS_ORIGIN = 'https://accounts.google.com';
/** Main-frame navigation limits of the call window (meet + re-authentication). Do not widen without evidence. */
const CALL_WINDOW_ORIGINS = Object.freeze([MEET_ORIGIN, ACCOUNTS_ORIGIN]);

// docs/design/06-meet-native-wording.md - exact strings.
const WORDING = Object.freeze({
  notification: { title: 'Google Meet', body: 'A call is already open. The new link was not opened.' },
  p1: {
    title: 'Close the call window?',
    body: 'You will leave the call, and your camera, microphone and screen sharing will stop.',
    buttons: ['Close window', 'Keep window open'],
  },
  p2: {
    title: 'Exit Google Chat Desktop?',
    body:
      'You will leave the call, and your camera, microphone and screen sharing will stop. ' +
      "You won't get message notifications until you start the app again.",
    buttons: ['Exit', 'Cancel'],
  },
  crash: {
    title: 'The call window stopped working',
    body: 'The Google Meet page in this window has stopped. You can reload it or close the window.',
    buttons: ['Reload', 'Close window'],
  },
});

function createCallWindowManager({
  BrowserWindow,
  Notification,
  getRouter,
  isQuitting,
  showMessageBox,
  picker,
  abortPending,
  onChange = () => {},
  quitApp,
  timers = { setTimeout, clearTimeout },
  probeMs = 3000,
  dismissWaitMs = 500,
  iconPath,
  log = () => {},
}) {
  /** @type {any} */
  let win = null;

  // --- close probe state (section 8 rules 4-6) ---
  // One-shot close probe (closeProbe.js): while active, an app-initiated close is being probed and the
  // FIRST objection is ours. A hung page (no answer in probeMs) is treated as not live.
  const probe = createCloseProbe({ timers, probeMs, onTimeout: () => destroyWindow() });
  let exitProbe = false; // the probe was started by tray Exit (objection -> P2, destruction -> quit)

  // --- dialog slot: at most one native box at a time ---
  /** @type {null | { kind: 'p1'|'p2'|'crash', controller: AbortController, done: Promise<void>,
   *   dismissing: boolean, onKept: Function|null, onClosed: Function|null }} */
  let slot = null;

  let lastNote = null; // keeps the toast referenced and lets a repeat replace it

  const alive = () => Boolean(win) && !win.isDestroyed();

  function safe(fn, what) {
    try {
      return fn();
    } catch (err) {
      log('[gcd] call window:', what, err && err.name);
      return undefined;
    }
  }

  // --- raising / focusing -----------------------------------------------------------------------
  function raiseCallWindow() {
    if (!alive()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.moveTop();
    win.focus();
  }

  /** Focus target: the picker when one is open (it is a modal child), otherwise the call window. */
  function focusTarget() {
    if (!alive()) return;
    if (picker.isOpen()) {
      if (win.isMinimized()) win.restore();
      picker.raise();
      return;
    }
    raiseCallWindow();
  }

  // --- probe helpers ------------------------------------------------------------------------------
  function clearProbe() {
    probe.clear();
  }

  function destroyWindow() {
    if (alive()) win.destroy();
  }

  /** Start a one-shot close probe and let the close proceed so Meet's beforeunload runs. */
  function startProbe() {
    probe.start();
  }

  // --- dialog slot ----------------------------------------------------------------------------------
  /**
   * Open a native box. `onAnswer(response, entry)` runs only if the box is still the slot's
   * occupant, was not dismissed by us, and the window is still alive; anything else is discarded.
   */
  function openDialog(kind, wording, { defaultId, cancelId, type }, onAnswer) {
    const controller = new AbortController();
    let finishDone;
    const entry = {
      kind,
      controller,
      done: new Promise((resolve) => { finishDone = resolve; }),
      dismissing: false,
      onKept: null,
      onClosed: null,
    };
    slot = entry;

    let shown;
    try {
      shown = Promise.resolve(
        showMessageBox(win, {
          type,
          title: wording.title,
          message: wording.body,
          buttons: wording.buttons.slice(),
          defaultId,
          cancelId,
          noLink: true,
          signal: controller.signal,
        })
      );
    } catch (err) {
      shown = Promise.reject(err);
    }
    shown
      .then(
        (result) => (result && Number.isInteger(result.response) ? result.response : cancelId),
        () => cancelId
      )
      .then((response) => {
        finishDone();
        if (entry.dismissing) return; // aborted by us: the answer is discarded
        if (slot !== entry || !alive()) return; // stale
        slot = null;
        onAnswer(response, entry);
      });
    return entry;
  }

  /**
   * Dismiss the open box (AbortSignal: "behaves as if cancelled by the user") and wait up to
   * dismissWaitMs for it to settle. Resolves true when it is gone, false when the box ignores the
   * signal (then it stays the slot's occupant and the fallback of section 8 applies).
   */
  function dismissSlot() {
    const entry = slot;
    if (!entry) return Promise.resolve(true);
    entry.dismissing = true;
    safe(() => entry.controller.abort(), 'abort dialog');
    return new Promise((resolve) => {
      let timer = null;
      let finished = false;
      const end = (gone) => {
        if (finished) return;
        finished = true;
        if (timer !== null) timers.clearTimeout(timer);
        if (gone) {
          if (slot === entry) slot = null;
        } else {
          entry.dismissing = false; // fallback: the box stays, its real answer will be handled
        }
        resolve(gone);
      };
      entry.done.then(() => end(true));
      timer = timers.setTimeout(() => end(false), dismissWaitMs);
    });
  }

  // --- the three dialogs ---------------------------------------------------------------------------
  function showP1() {
    openDialog('p1', WORDING.p1, { type: 'warning', defaultId: 1, cancelId: 1 }, (response, entry) => {
      if (response === 0) {
        destroyWindow(); // 'closed' completes a remembered Exit (entry.onClosed is run there)
        if (entry.onClosed) entry.onClosed();
        return;
      }
      raiseCallWindow(); // keep: stays open and focused
      if (entry.onKept) entry.onKept();
    });
  }

  function showP2() {
    openDialog('p2', WORDING.p2, { type: 'warning', defaultId: 1, cancelId: 1 }, (response) => {
      if (response === 0) quitApp();
      else raiseCallWindow();
    });
  }

  function showCrash() {
    openDialog('crash', WORDING.crash, { type: 'error', defaultId: 0, cancelId: 1 }, (response) => {
      if (response === 0) {
        if (alive()) win.webContents.reload(); // returns to a normal Meet load; the user rejoins
      } else {
        destroyWindow(); // a crashed page cannot object: no further confirmation
      }
    });
  }

  // --- window events ----------------------------------------------------------------------------------
  function onClose(event) {
    // 1. quitting: the handler yields (the will-prevent-unload override completes the quit).
    if (isQuitting()) return;
    // 2. picker open: the close is blocked and never silent.
    if (picker.isOpen()) {
      event.preventDefault();
      picker.raise();
      picker.flash();
      return;
    }
    // 3. a dialog already represents the close: ignored.
    if (slot) {
      event.preventDefault();
      raiseCallWindow();
      return;
    }
    // 4. otherwise probe: let the close proceed so Meet's beforeunload runs.
    if (probe.isActive()) return; // a probe is already in flight
    startProbe();
  }

  function onPreventUnload(event) {
    if (isQuitting()) {
      event.preventDefault(); // synchronous: a quit always completes
      return;
    }
    if (!probe.isActive()) return; // page-initiated objection: Meet's own protection stands (documented limit)
    // The FIRST objection of an app-initiated close is consumed: a live call. The window stays open
    // (we do not preventDefault); the answer to the native box decides.
    const forExit = exitProbe;
    clearProbe();
    exitProbe = false;
    if (forExit) showP2();
    else showP1();
  }

  function onRenderProcessGone(_event, details) {
    if (details && details.reason === 'clean-exit') return;
    safe(() => abortPending(), 'abort picker');
    const exiting = exitProbe;
    clearProbe();
    exitProbe = false;
    if (exiting) {
      quitApp(); // a crashed page has no live call to protect: Exit is not swallowed
      return;
    }
    if (!slot) {
      showCrash();
      return;
    }
    // One dialog at a time: dismiss the open one first.
    const open = slot;
    dismissSlot().then((gone) => {
      if (!alive()) return;
      if (gone) showCrash();
      else open.onKept = showCrash; // cannot dismiss: show the crash box after it is answered
    });
  }

  function onClosedEvent() {
    // Exit was requested (probe in flight, or a remembered Exit behind an undismissable P1) and the
    // window is gone: the Exit proceeds. Never swallowed.
    const exitPending = exitProbe || Boolean(slot && slot.onClosed);
    clearProbe();
    exitProbe = false;
    const entry = slot;
    slot = null;
    if (entry) safe(() => entry.controller.abort(), 'abort dialog'); // the box goes with its parent
    safe(() => abortPending(), 'abort picker'); // a source is never handed to a gone page
    win = null;
    safe(() => onChange(), 'tray refresh');
    if (exitPending) quitApp();
  }

  // --- creation ------------------------------------------------------------------------------------------
  function createWindow(url) {
    const options = {
      width: 1100,
      height: 780,
      title: 'Google Meet',
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: PARTITION, // the shared session: the Google login carries over
        // NO preload: the Meet contents has no bridge and no IPC channel.
      },
    };
    if (iconPath) options.icon = iconPath;

    const created = new BrowserWindow(options);
    win = created; // set synchronously, before the load: two quick links cannot create two windows
    const contents = created.webContents;

    contents.setWindowOpenHandler((details) => getRouter().onWindowOpen(details));
    const onNavigate = (event, navUrl, _inPlace, isMainFrame) => {
      const main = event && typeof event.isMainFrame === 'boolean' ? event.isMainFrame : isMainFrame;
      if (main === false) return; // sub-frame navigation is not restricted (Meet embeds frames)
      const target = event && typeof event.url === 'string' ? event.url : navUrl;
      getRouter().onWillNavigate(event, target, { allowedOrigins: CALL_WINDOW_ORIGINS });
    };
    contents.on('will-navigate', onNavigate);
    contents.on('will-redirect', onNavigate);
    contents.on('will-prevent-unload', onPreventUnload); // always registered
    contents.on('render-process-gone', onRenderProcessGone);
    created.on('close', onClose);
    created.on('closed', onClosedEvent);

    safe(() => onChange(), 'tray refresh');
    Promise.resolve(created.loadURL(url)).catch((err) => log('[gcd] call window load failed', err && err.name));
    created.focus();
    return created;
  }

  // --- section 5: the single entry for a Meet link ---------------------------------------------------------
  function notifyAlreadyOpen() {
    if (lastNote) safe(() => lastNote.close(), 'close toast'); // repeated clicks replace the notification
    const note = new Notification({
      title: WORDING.notification.title,
      body: WORDING.notification.body,
    });
    lastNote = note;
    note.on('click', () => {
      if (!alive()) return; // a destroyed window: no new window, no main-window focus
      focusTarget();
    });
    note.show(); // shown regardless of mute: app status, not a chat message
  }

  function openCallWindow(url) {
    if (!alive()) {
      createWindow(url);
      return;
    }
    if (!isMeetingPage(win.webContents.getURL())) {
      Promise.resolve(win.webContents.loadURL(url)).catch((err) =>
        log('[gcd] call window load failed', err && err.name)
      );
      focusTarget();
      return;
    }
    focusTarget();
    notifyAlreadyOpen();
  }

  function showCallWindow() {
    focusTarget();
  }

  // --- section 8 "Exit is never swallowed" ---------------------------------------------------------------------
  async function runExit() {
    if (isQuitting() || !alive()) {
      quitApp();
      return;
    }
    if (slot) {
      const open = slot;
      if (open.dismissing) {
        raiseCallWindow(); // already being handled
        return;
      }
      if (open.kind === 'p2') {
        raiseCallWindow(); // P2 is the call window's modal child
        return;
      }
      if (open.kind === 'crash') {
        // A crashed page has no live call to protect: dismiss and quit. Not dropped even if the
        // box ignores the signal (quitting destroys the window and the box goes with its parent).
        await dismissSlot();
        quitApp();
        return;
      }
      // P1 open: a live call is already known, no second probe.
      const gone = await dismissSlot();
      if (!alive()) {
        quitApp(); // the window went away meanwhile: the Exit proceeds
        return;
      }
      if (gone) {
        showP2(); // P1 dismissed (treated as keep)
        return;
      }
      // Fallback: the box cannot be dismissed. Focus it and remember the Exit.
      open.onClosed = () => quitApp(); // "Close window": the call is gone, no P2
      open.onKept = () => showP2(); // "Keep window open": now ask about Exit
      raiseCallWindow();
      return;
    }

    // No dialog: picker first, then run the close probe as an exit probe.
    safe(() => abortPending(), 'abort picker');
    if (probe.isActive()) {
      exitProbe = true; // a close probe is already in flight: it now also carries the Exit
      return;
    }
    exitProbe = true;
    win.close(); // 'close' handler starts the probe and lets Meet's beforeunload run
  }

  function requestExit() {
    return runExit().catch((err) => {
      log('[gcd] call window exit failed', err && err.name);
      quitApp(); // never swallowed
    });
  }

  return {
    openCallWindow,
    showCallWindow,
    requestExit,
    hasCallWindow: alive,
    getWindow: () => (alive() ? win : null),
  };
}

module.exports = { createCallWindowManager, CALL_WINDOW_ORIGINS, WORDING };
