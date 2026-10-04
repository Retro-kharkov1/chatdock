'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

// --- Pure decision functions (task 0's covered net — test/index.test.js) -------------------
// These two stay dependency-free so they remain unit-testable under plain `node:test` with no
// Electron runtime. Everything else in this file (the actual app bootstrap, below) is guarded to
// run only when loaded by the real Electron binary, so `require('../src/main/index.js')` from
// `node --test` still works exactly as it did in the scaffold pass.

// isAllowedSender lives in originCheck.js (shared with the service-worker IPC path) and is
// re-exported below, so test/index.test.js and this module's API are unchanged.
const { isAllowedSender } = require('./originCheck');

/**
 * decideSingleInstanceAction(gotLock)
 *
 * Pure mapping behind FR-08 / docs/architecture/tray-lifecycle.md's single-instance
 * enforcement: `app.requestSingleInstanceLock()` returns a boolean, and this function names the
 * two branches that boolean selects, so the branch-selection itself is unit-testable without a
 * real second Electron process.
 *
 * @param {boolean} gotLock The return value of `app.requestSingleInstanceLock()`.
 * @returns {'quit'|'proceed'} `'quit'` when `gotLock` is falsy — another instance already holds
 *   the lock, and this process must call `app.quit()` immediately without creating any window.
 *   `'proceed'` when `gotLock` is truthy — this is the primary instance; continue with
 *   `app.on('second-instance', ...)` registration and normal `app.whenReady()` startup.
 */
function decideSingleInstanceAction(gotLock) {
  return gotLock ? 'proceed' : 'quit';
}

module.exports = { isAllowedSender, decideSingleInstanceAction };

// --- App bootstrap (tasks 1, 3, 4, 4b, 5, 5b, 6, 7) -----------------------------------------
// Guarded so this only runs under the real Electron binary (`process.versions.electron` is only
// set there) — `node --test` loading this module for the two functions above never reaches this
// branch. See docs/architecture/overview.md, notifications.md, tray-lifecycle.md,
// ipc-contract.md, and ADR-0001/0002/0003 for the design this implements.
if (process.versions.electron) {
  bootstrap();
}

function bootstrap() {
  const {
    app,
    BrowserWindow,
    ipcMain,
    shell,
    Menu,
    Notification,
    dialog,
    desktopCapturer,
    session,
  } = require('electron');
  const {
    resolveWindowState,
    getWindowStatePath,
    loadSavedWindowState,
    saveWindowState,
    getOrderedDisplays,
  } = require('./window-state');
  const { PARTITION, configurePersistentSession } = require('./session');
  const {
    buildNotificationBridgeScript,
    attachUnreadTitleListener,
    parseUnreadCount,
  } = require('./notifications');
  const { createAppTray, setUnreadOverlay } = require('./tray');
  const { createAttentionController, bindWindowFocus } = require('./attention');
  const { createUnreadTracker } = require('./unreadTracker');
  const { buildOrigins, parseDevStartUrl, START_URL } = require('./origins');
  const { resolveAppUserModelId, resolveProtocolScheme } = require('./appIdentity');
  const { createToastService } = require('./nativeToast');
  const { attachServiceWorkerNotifications } = require('./serviceWorkerNotifications');
  const { createSettingsStore, getSettingsPath } = require('./settingsStore');
  const { openSettingsWindow, getSettingsWindow } = require('./settingsWindow');
  const trayBlink = require('./trayBlink');
  const { readBuildInfo, buildVersionLabel } = require('./version');
  const { classifyLink, isOpenableExternalScheme } = require('./meetLink');
  const { createLinkRouter } = require('./linkRouter');
  const { classifyGoogleLink, classifyChatTarget } = require('./googleLink');
  const { createGoogleAppWindowManager } = require('./googleAppWindow');
  const { bindEditShortcuts } = require('./editShortcuts');
  const { createDownloadHandler } = require('./downloads');
  const { createMainWindowActions } = require('./mainWindowActions');
  const { createNotificationOpener } = require('./notificationOpen');
  const { createDiagLog, redactUrl, describeShape } = require('./diagLog');
  const {
    buildToastXml,
    findActivationId,
    createToastRegistry,
    createClickDeduper,
  } = require('./toastActivation');
  const { createCallWindowManager } = require('./callWindow');
  const { createQuitGuard } = require('./quitGuard');
  const { createQuitTerminator, sessionFlushers } = require('./quitTerminator');
  const { createDisplayMediaGate } = require('./meetPermissions');
  const { createPickerController, createPickerWindow } = require('./pickerWindow');

  // Application-menu suppression (docs/architecture/tray-lifecycle.md "Application menu
  // suppression is part of quit-only-from-tray, not a separate concern") — the single
  // highest-consequence line in this pass. Electron installs a default application menu unless
  // this is called, and that default menu carries its own Quit/Exit item wired straight to
  // `app.quit()` — a second, unguarded quit path that bypasses the `isQuitting`-gated `close`
  // handler entirely. Called at the very top of startup, before the single-instance lock and
  // definitely before any window is created (electronjs.org/docs/latest/api/menu:
  // "Passing null will suppress the default menu.").
  Menu.setApplicationMenu(null);

  // Owner request (2026-09-22): tray version line, now sourced from `build-info.json`
  // (GitVersion-derived, wired by ci-cd-engineer) rather than this file's own mtime — see
  // version.js's header comment for why. Read once at startup, not on every menu open: the
  // running process's own build doesn't change while it's running.
  const versionLabel = buildVersionLabel(readBuildInfo(() => app.getAppPath()));

  const DEFAULT_SIZE = { width: 1200, height: 800 };

  // Provisional per overview.md — task 2 (real sign-in, out of scope this pass) is what actually
  // settles this list. If a real sign-in with 2FA hits a blocked navigation, add the origin it
  // needed here rather than treating this as final. Do not present this as a completed list.
  // Dev-only test seam (never active in a packaged build, loopback http only - see origins.js):
  // point the window at a local harness page so notification/attention behaviour can be
  // exercised without a signed-in Chat session.
  const devStart = parseDevStartUrl(process.env.GCD_DEV_START_URL, app.isPackaged);
  const startUrl = devStart ? devStart.url : START_URL;
  // ALLOWED_ORIGINS: navigation + app IPC. NOTIFICATION_ORIGINS: who may notify (service-worker
  // IPC, the `notifications` permission) - chat only, not the sign-in origin.
  const { navigationOrigins: ALLOWED_ORIGINS, notificationOrigins: NOTIFICATION_ORIGINS } =
    buildOrigins(devStart ? devStart.origin : null);

  // FR-10's third scenario: launched by the OS's autostart mechanism, the app must come up with
  // the window hidden, not forced open. Both autostart.js branches arrange to pass this flag.
  const launchedHidden = process.argv.includes('--hidden');

  // --- BUG-05 attempt 2: temporary diagnostic trail for the notification click path ------------
  // <userData>/logs/notification-diag.log (src/main/diagLog.js): event names and redacted shapes only.
  const diagFile = path.join(app.getPath('userData'), 'logs', 'notification-diag.log');
  try {
    fs.mkdirSync(path.dirname(diagFile), { recursive: true });
  } catch {
    // diagnostics only
  }
  const diag = createDiagLog({
    append: (f, t) => fs.appendFileSync(f, t),
    size: (f) => {
      try {
        return fs.statSync(f).size;
      } catch {
        return 0;
      }
    },
    reset: (f) => fs.writeFileSync(f, ''),
    file: diagFile,
    pid: process.pid,
  }).note;
  // Only option-looking arguments (never paths or values) are recorded.
  const argFlags = () => process.argv.slice(1).filter((a) => a.startsWith('-')).map((a) => a.split('=')[0]).join(' ');
  // BUG-05 attempt 2: a toast click launches `<app>.exe <scheme>://toast/<id>` (toastActivation.js).
  const PROTOCOL_SCHEME = resolveProtocolScheme({ isPackaged: app.isPackaged });
  diag('proc.start', {
    packaged: app.isPackaged,
    flags: argFlags(),
    comLaunch: process.argv.includes('-Embedding'),
    toastUrlLaunch: Boolean(findActivationId(process.argv, PROTOCOL_SCHEME)),
  });
  // Diagnostics only: Windows' COM-activation callback (never observed to fire on Electron 44.4.3).
  if (process.platform === 'win32' && typeof Notification.handleActivation === 'function') {
    Notification.handleActivation((details) => {
      diag('activation.com', { type: details && details.type });
    });
  }

  // --- Single-instance lock (FR-08) — must happen before any window is created. ---------------
  const gotLock = app.requestSingleInstanceLock();
  diag('proc.lock', { gotLock });
  if (decideSingleInstanceAction(gotLock) === 'quit') {
    app.quit();
    return;
  }

  // Windows notification/AppUserModelID — needed for Start Menu/Action Center toast identity in
  // dev, before the installer sets this up for a packaged build.
  if (process.platform === 'win32') {
    // BUG-01-G: packaged = build.appId (unchanged for installed users), dev = distinct stable id.
    app.setAppUserModelId(resolveAppUserModelId({ isPackaged: app.isPackaged }));
  }

  /** @type {Electron.BrowserWindow | null} */
  let mainWindow = null;
  let trayController = null;
  let currentUnreadCount = 0;

  const windowStatePath = getWindowStatePath();
  const settingsPath = getSettingsPath();
  // Single-writer settings authority (docs/architecture/tray-lifecycle.md "Single source of
  // truth") — owns all four persisted booleans plus the OS-level start-at-login read/write. The
  // getter callbacks below are resolved lazily (trayController/settingsWindow don't exist yet at
  // this point in bootstrap) so applySetting's side effects always see the current instances.
  const settingsStore = createSettingsStore({
    settingsPath,
    // First run of an installed build turns Start at login on (once); dev runs never do.
    enableStartAtLoginOnFirstRun: app.isPackaged,
    getTrayController: () => trayController,
    // Mute-on / Icon-blinking-off must stop BOTH indicators (FR-14 stop 3), so the store's stop
    // hook is the attention controller's stop, not the bare tray timer.
    getTrayBlink: () => ({ stopBlinking: () => attention.stop() }),
    getSettingsWindow: () => getSettingsWindow(),
  });

  let saveStateTimer = null;
  function flushWindowState() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    clearTimeout(saveStateTimer);
    saveStateTimer = null;
    const bounds = mainWindow.getBounds();
    saveWindowState(windowStatePath, {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      isMaximized: mainWindow.isMaximized(),
    });
  }
  function scheduleWindowStateSave() {
    clearTimeout(saveStateTimer);
    saveStateTimer = setTimeout(flushWindowState, 500);
  }

  function focusMainWindow() {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  }

  function toggleShowHide() {
    if (!mainWindow) return;
    if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
      mainWindow.hide();
    } else {
      focusMainWindow();
    }
  }

  function refreshTrayIconState() {
    if (!trayController) return;
    trayController.setIconState(
      trayController.resolveIconState(currentUnreadCount, settingsStore.get('notificationsMuted'))
    );
  }

  // FR-14 / FR-15: tray blink + taskbar flash from one state machine (attention.js). Only OS
  // input focus of the main window stops them - see bindWindowFocus below.
  // "Focused" = the main window has OS input focus. isFocused() alone is not trustworthy for a
  // window that was just minimized or hidden (observed on Electron 44.4.3 / Windows 11: it kept
  // reporting true after minimize()), and FR-14 defines hidden and minimized as not focused.
  const isMainWindowFocused = () =>
    Boolean(
      mainWindow &&
        !mainWindow.isDestroyed() &&
        mainWindow.isVisible() &&
        !mainWindow.isMinimized() &&
        mainWindow.isFocused()
    );
  const attention = createAttentionController({
    isWindowFocused: isMainWindowFocused,
    getBlinkOnUnread: () => settingsStore.get('blinkOnUnread'),
    getNotificationsMuted: () => settingsStore.get('notificationsMuted'),
    startBlinking: () => trayBlink.startBlinking(),
    stopBlinking: () => trayBlink.stopBlinking(),
    // A hidden window has no taskbar button, so this is a no-op there; the tray blink is the
    // indicator in that state. Never show the window just to flash it.
    flashFrame: (flag) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.flashFrame(flag);
    },
  });

  // --- UI-01 (FR-16): Meet links open in an app-owned call window --------------------------------
  // docs/architecture/meet-call-window.md. Quit path first: every owned contents gets a
  // will-prevent-unload listener, and isQuitting is reset if a quit is cancelled.
  const quitGuard = createQuitGuard();

  // Quit-hang fix (meet-call-window.md section 8): flush the persistent partition, then force-terminate
  // after will-quit/quit. Settings and window state are written synchronously (writeFileSync), so the
  // only async persisted state is the partition's cookie store and DOM storage. The session is resolved
  // lazily (at quit) because it is created in whenReady.
  const quitTerminator = createQuitTerminator({
    flushers: [
      { name: 'cookies', run: () => sessionFlushers(session.fromPartition(PARTITION))[0].run() },
      { name: 'storage', run: () => sessionFlushers(session.fromPartition(PARTITION))[1].run() },
    ],
    requestQuit: () => app.quit(),
    terminate: () => process.kill(process.pid),
    log: (...args) => console.error(...args),
  });

  const APP_ICON = path.join(__dirname, '../../assets/icons/icon.png');
  const PICKER_HTML = path.join(__dirname, '../renderer/picker/picker.html');
  const logLine = (...args) => console.error(...args);

  // The picker is the ONLY surface the app draws for Meet. Its source listing is asynchronous and
  // runs only when the picker renderer asks (the window shows its loading state first).
  const picker = createPickerController({
    createWindow: ({ parent }) =>
      createPickerWindow({
        BrowserWindow,
        session,
        parent,
        preloadPath: path.join(__dirname, '../preload/pickerPreload.js'),
        htmlPath: PICKER_HTML,
      }),
    getSources: async () => {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 180 },
      });
      // Sharing the call window itself produces an endless mirror: label it (still selectable).
      const callWin = callWindows.getWindow();
      const ownId = callWin && typeof callWin.getMediaSourceId === 'function' ? callWin.getMediaSourceId() : null;
      for (const source of sources) {
        if (ownId && source.id === ownId) source.name = source.name + ' (this call)';
      }
      return sources;
    },
    bundledFileUrl: pathToFileURL(PICKER_HTML).href,
    log: logLine,
  });
  picker.register(ipcMain);

  // The session-wide screen-share gate (userGesture + origin + call window + one at a time).
  const displayGate = createDisplayMediaGate({
    getCallWindow: () => callWindows.getWindow(),
    picker,
    log: logLine,
  });

  // System browser for http/https/mailto (the router, the hop fallback and the download notice all use it).
  const openInSystemBrowser = (target) => {
    shell.openExternal(target).catch((err) => logLine('[gcd] openExternal failed', err && err.name));
  };

  // Router and call window refer to each other (a Meet link opens the window; a link inside the
  // window is routed again), so both are resolved lazily.
  // The CALL window keeps a router WITHOUT the Google collaborators (google-app-windows.md section 5: the call
  // window is unchanged; a Chat or Drive link clicked inside a call goes to the system browser as before).
  const callLinkRouter = createLinkRouter({
    classifyLink,
    isOpenableExternalScheme,
    openCallWindow: (target) => callWindows.openCallWindow(target),
    openExternal: openInSystemBrowser,
    log: logLine,
  });

  const callWindows = createCallWindowManager({
    BrowserWindow,
    Notification,
    getRouter: () => callLinkRouter,
    isQuitting: quitGuard.isQuitting,
    showMessageBox: (parent, options) => dialog.showMessageBox(parent, options),
    picker,
    abortPending: displayGate.abortPending,
    // Event-driven tray refresh (not the blink tick): "Show call window" appears and goes.
    onChange: () => {
      if (trayController) trayController.refreshMenu();
    },
    quitApp: () => app.quit(),
    iconPath: APP_ICON,
    log: logLine,
  });

  // --- UI-04 (FR-17): links to Google services open in app-owned windows on the shared session ----------------
  // docs/architecture/google-app-windows.md. What a Chat link does to the main window (focus / reload / download):
  const mainActions = createMainWindowActions({ getMainWindow: () => mainWindow, log: logLine });

  // The router of the MAIN window (popups and navigations away from Chat) and of the Google app windows.
  const linkRouter = createLinkRouter({
    classifyLink,
    isOpenableExternalScheme,
    classifyGoogleLink,
    classifyChatTarget,
    openCallWindow: (target) => callWindows.openCallWindow(target),
    openMainWindow: mainActions.openMainWindow,
    focusMainWindow: mainActions.focusMainWindow,
    downloadInMainWindow: mainActions.downloadInMainWindow,
    openGoogleAppWindow: (target, opts) => googleAppWindows.openGoogleAppWindow(target, opts),
    openExternal: openInSystemBrowser,
    log: logLine,
  });

  const googleAppWindows = createGoogleAppWindowManager({
    BrowserWindow,
    getRouter: () => linkRouter,
    isQuitting: quitGuard.isQuitting,
    showMessageBox: (parent, options) => dialog.showMessageBox(parent, options),
    openExternal: openInSystemBrowser,
    iconPath: APP_ICON,
    log: logLine,
  });

  // Registered ONCE on the shared session in whenReady: app windows (strict chain check) and the main window
  // (scheme only). Always asks where to save; opens nothing afterwards.
  const downloadHandler = createDownloadHandler({
    getAppWindowForContents: (contents) => googleAppWindows.getAppWindowForContents(contents),
    getMainWindow: () => mainWindow,
    closeEmptyWindow: (contents) => googleAppWindows.closeIfEmpty(contents),
    getDownloadsDir: () => app.getPath('downloads'),
    showMessageBox: (parent, options) =>
      parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options),
    openExternal: openInSystemBrowser,
    log: logLine,
  });

  // Live native toasts must be referenced until closed or Electron may garbage-collect them
  // before the user clicks.
  const liveToasts = new Set();
  // BUG-05: set once the session hooks exist (app ready); replays a click into Chat's worker.
  let swNotifications = null;

  // BUG-05: a URL asked for by a replayed click (clients.openWindow / navigate). Chat's own origin
  // opens in the app window; everything else goes through the link router.
  const notificationOpener = createNotificationOpener({
    inAppOrigins: NOTIFICATION_ORIGINS,
    loadInApp: (url) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      diag('open.in-app', { url: redactUrl(url), alreadyThere: mainWindow.webContents.getURL() === url });
      if (mainWindow.webContents.getURL() !== url) {
        mainWindow.webContents.loadURL(url).catch((err) => logLine('[gcd] notification open failed', err && err.name));
      }
    },
    route: (url) => {
      diag('open.route', { url: redactUrl(url) });
      linkRouter.route(url);
    },
    focus: () => focusMainWindow(),
    log: logLine,
  });

  // BUG-05 attempt 2: every toast gets an id carried in its activation arguments, and the record
  // (worker scope + Chat's `data`) is kept under it, so a click that arrives as a fresh
  // `-Embedding` process (Action Center) still finds its way back to the conversation.
  function registerProtocolHandler() {
    if (process.platform !== 'win32') return; // toasts are Windows-specific here
    try {
      // Unpackaged runs must pass the entry script or the OS would start a bare electron.exe.
      const ok = app.isPackaged
        ? app.setAsDefaultProtocolClient(PROTOCOL_SCHEME)
        : process.argv[1]
          ? app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [path.resolve(process.argv[1])])
          : false;
      diag('protocol.register', { scheme: PROTOCOL_SCHEME, ok });
    } catch (err) {
      logLine('[gcd] protocol registration failed', err && err.name);
      diag('protocol.register', { scheme: PROTOCOL_SCHEME, ok: false, error: err && err.name });
    }
  }

  const toastRegistry = createToastRegistry({ newId: () => require('crypto').randomUUID() });
  const clickDeduper = createClickDeduper();
  let lastClickAt = 0;

  /** One resolution point for a toast click, whichever path delivered it. */
  function handleToastClick(id, via) {
    lastClickAt = Date.now();
    focusMainWindow(); // FR-05c step 1
    const record = id ? toastRegistry.get(id) : undefined;
    diag('click.resolve', {
      via,
      hasId: Boolean(id),
      recordFound: Boolean(record),
      hasScope: Boolean(record && record.scope),
      hasData: Boolean(record && record.data !== undefined),
      windowVisible: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()),
    });
    if (!id || !record) return;
    if (!clickDeduper.accept(id)) {
      diag('click.deduped', { via });
      return;
    }
    // FR-05c step 2 (BUG-05): run Chat's own notificationclick handler with the data it attached.
    if (record.scope && swNotifications) {
      swNotifications.deliverClick(record.scope, {
        title: record.title,
        body: record.body,
        tag: record.tag,
        data: record.data,
      });
    }
  }

  function showNativeToast({ title, body, silent, tag, data, scope }) {
    const id = toastRegistry.register({ title, body, tag, data, scope });
    const useXml = process.platform === 'win32';
    const make = (withXml) =>
      new Notification(
        withXml
          ? { title, body, silent, toastXml: buildToastXml({ title, body, silent, id, scheme: PROTOCOL_SCHEME }) }
          : { title, body, silent }
      );
    let toast = make(useXml);
    let replaced = false;
    const wire = (t, withXml) => {
      liveToasts.add(t);
      t.on('click', () => {
        diag('toast.click', { inProcess: true });
        handleToastClick(id, 'click-event');
      });
      // Not released on `close`: on Windows `close` also fires when the pop-up merely times out into
      // the Action Center, where the toast can still be clicked. Released only on a same-tag
      // replacement (close() below), a failure, or by the size bound on liveToasts.
      t.on('close', (event) => {
        diag('toast.close', { reason: event && event.reason });
      });
      t.on('failed', (_e, error) => {
        liveToasts.delete(t);
        console.error('[gcd] native toast failed:', error);
        diag('toast.failed', { custom: withXml });
        // A rejected custom XML must never cost the user the notification: retry once with Electron's own.
        if (withXml && !replaced) {
          toast = make(false);
          wire(toast, false);
          toast.show();
        }
      });
    };
    wire(toast, useXml);
    toast.show();
    // Bound the strong references (a long session raises many toasts).
    while (liveToasts.size > 100) liveToasts.delete(liveToasts.values().next().value);
    diag('toast.show', {
      custom: useXml,
      silent,
      hasScope: Boolean(scope),
      scopeOrigin: scope ? redactUrl(scope) : undefined,
      hasData: data !== undefined,
      dataShape: data !== undefined ? describeShape(data) : undefined,
      tagLen: typeof tag === 'string' ? tag.length : 0,
    });
    // Handle for same-tag replacement (nativeToast.js): the newer toast closes this one.
    return {
      close: () => {
        replaced = true;
        liveToasts.delete(toast);
        toast.close();
      },
    };
  }

  // Main-process toast service: re-raises service-worker notifications (Electron shows none),
  // applies mute/sound, feeds attention, and runs the unread-count fallback.
  const toasts = createToastService({
    showNativeToast,
    getMuted: () => settingsStore.get('notificationsMuted'),
    getSoundEnabled: () => settingsStore.get('soundEnabled'),
    isWindowFocused: isMainWindowFocused,
    onArrival: () => attention.onArrival(),
  });

  // ONE unread baseline for both consumers (F2): a real increase feeds the attention controller
  // and the generic-toast floor; every other settled change only keeps their bookkeeping in sync.
  const unread = createUnreadTracker({
    onIncrease: (n) => {
      attention.onUnreadCount(n);
      toasts.onUnreadIncrease(n);
    },
    onObserve: (n) => {
      attention.observeUnreadCount(n);
      toasts.onUnreadObserve(n);
    },
  });

  /**
   * Re-injects the notification bridge with the current sound/mute values. Called on dom-ready,
   * did-finish-load, and every sound/mute toggle (tray-lifecycle.md's "Sound & mute" section).
   * Failure is logged distinctly, not swallowed — see notifications.md's "Failure mode to log,
   * not swallow": a silently-broken click-to-focus bridge must be detectable, not indistinguishable
   * from success.
   */
  function injectNotificationBridge() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const script = buildNotificationBridgeScript(
      settingsStore.get('soundEnabled'),
      settingsStore.get('notificationsMuted')
    );
    mainWindow.webContents.executeJavaScript(script, false).catch((err) => {
      console.error(
        '[gcd] DEGRADED: notification bridge injection failed — click-to-focus and sound/mute' +
          ' control will not work until this is fixed. Likely cause: a CSP change on Google\'s' +
          ' side (see docs/architecture/notifications.md).',
        err
      );
    });
  }

  function createWindow() {
    const saved = loadSavedWindowState(windowStatePath);
    const displays = getOrderedDisplays();
    const state = resolveWindowState(saved, displays, DEFAULT_SIZE);

    mainWindow = new BrowserWindow({
      width: state.width,
      height: state.height,
      x: state.x,
      y: state.y,
      show: false,
      icon: path.join(__dirname, '../../assets/icons/icon.png'),
      webPreferences: {
        partition: PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // FR-05 / project rule "Hidden window must stay live" (docs/architecture/project-rules.md): a hidden window must keep running
        // its page script so notifications keep firing. See ADR-0002 for the Windows hide()
        // caveat.
        //
        // IMPORTANT: do NOT set `backgroundThrottling: false` here. It was tried and reverted
        // (2026-09-22 incident: colleague sent a real message to a hidden window, no Windows
        // toast appeared). Per Electron's own BrowserWindow docs ("Page visibility" section,
        // https://www.electronjs.org/docs/latest/api/browser-window): "If backgroundThrottling
        // is disabled, visibility state stays visible even when the window is minimized,
        // occluded, or hidden." Google Chat's own page reads document.visibilityState to decide
        // whether to suppress a native Notification for the conversation currently loaded
        // (treating "visible" as "the user is already looking at this, don't alert them again").
        // With backgroundThrottling:false, Chat never saw the page go hidden, so it never fired
        // a Notification at all — this is not a rendering/permission/wrapper failure, the
        // notification pipeline itself is fine (verified with a self-triggered Notification()
        // call reaching the OS). Electron's default (backgroundThrottling left unset, i.e. true)
        // was empirically confirmed on this Electron version (44.4.3) to still run page JS/timers
        // at ~1x real time while hidden (a 1s setInterval fired every ~1s over 6s while
        // document.hidden was true) — the pre-Electron-27 full-freeze bug ADR-0002 was guarding
        // against is in fact fixed upstream, so this override is unnecessary AND actively harmful.
        preload: path.join(__dirname, '../preload/preload.js'),
      },
    });

    if (state.isMaximized) {
      mainWindow.maximize();
    }

    mainWindow.once('ready-to-show', () => {
      if (!launchedHidden) {
        mainWindow.show();
        return;
      }
      // FR-10's autostart-hidden case, plus the same Page-visibility gap the comment above
      // documents from the other direction: per Electron's BrowserWindow docs ("Page
      // visibility"), "When a BrowserWindow is created with show: false, the initial visibility
      // state remains visible despite the window being hidden." A window that is created hidden
      // and never explicitly shown/hidden would therefore report document.visibilityState as
      // "visible" to Chat's page for its entire life, reproducing the exact same notification
      // suppression bug — just via the launch path instead of the backgroundThrottling path.
      // showInactive() (no focus stolen, no flicker for the user) followed immediately by
      // hide() forces a real shown->hidden transition so Chromium reports the correct "hidden"
      // state from the first load, the same as the close-to-tray path already gets for free.
      mainWindow.showInactive();
      mainWindow.hide();
    });

    mainWindow.on('resize', scheduleWindowStateSave);
    mainWindow.on('move', scheduleWindowStateSave);

    // FR-14 stop trigger 1: ONLY the main window gaining OS input focus stops the indicators.
    // 'show'/'restore' are deliberately NOT bound any more - a window that is shown or restored
    // behind other windows must keep blinking/flashing (FR-14 reverses the old "becomes visible"
    // rule). The binding is extracted to attention.js so it is unit-tested.
    bindWindowFocus(mainWindow, attention);

    // Clipboard accelerator restoration (docs/architecture/tray-lifecycle.md "Application menu
    // suppression" — "What this costs, and how it's paid for"): suppressing the application menu
    // above also disables the standard Ctrl+C/X/V/A/Z(+Shift) keyboard accelerators on
    // Windows/Linux, since Electron normally routes them through the menu's Edit role. Restored
    // here by dispatching straight to the focused webContents' own edit commands, without
    // reintroducing any Menu (and therefore no second quit-capable surface).
    // The same helper binds the Google app windows (googleAppWindow.js).
    bindEditShortcuts(mainWindow.webContents);

    // FR-06 / project rule "Quit only from the tray" (docs/architecture/project-rules.md): the close (X) button hides, it never quits.
    mainWindow.on('close', (event) => {
      if (!quitGuard.isQuitting()) {
        event.preventDefault();
        flushWindowState();
        mainWindow.hide();
      }
    });

    // OS shutdown / logoff (Windows): never force-terminate on that path.
    mainWindow.on('session-end', () => quitTerminator.onSessionEnd());

    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    // Electron security baseline (docs/architecture/project-rules.md): deny
    // every popup by default, hand target=_blank/window.open to the system browser instead.
    // UI-01: through the link router - Meet links open the call window, http/https/mailto go to
    // the system browser, every other scheme is dropped (meet-call-window.md section 3).
    mainWindow.webContents.setWindowOpenHandler((details) => linkRouter.onWindowOpen(details));
    // The main window's contents always gets a will-prevent-unload listener (quit path).
    quitGuard.guardContents(mainWindow.webContents);

    // will-navigate allowlist - anything outside ALLOWED_ORIGINS is prevented and routed (Meet to the
    // call window, http/https/mailto to the system browser). Provisional list, see ALLOWED_ORIGINS.
    mainWindow.webContents.on('will-navigate', (event, url) => {
      linkRouter.onWillNavigate(event, typeof event.url === 'string' ? event.url : url, {
        allowedOrigins: ALLOWED_ORIGINS,
      });
    });

    mainWindow.webContents.on('dom-ready', injectNotificationBridge);
    // BUG-05 attempt 2 diagnostics: what the app window did after a toast click (redacted paths only).
    const afterClick = () => Date.now() - lastClickAt < 20000;
    mainWindow.webContents.on('did-start-navigation', (_e, url, isInPlace, isMainFrame) => {
      if (afterClick() && isMainFrame) diag('nav.start', { url: redactUrl(url), inPlace: isInPlace });
    });
    mainWindow.webContents.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (afterClick() && isMainFrame) diag('nav.in-page', { url: redactUrl(url) });
    });
    mainWindow.webContents.on('did-finish-load', () => {
      injectNotificationBridge();
      // Seed the shared baseline from the count the title already shows (D1a).
      unread.onPageLoaded(parseUnreadCount(mainWindow.webContents.getTitle()));
    });

    // FR-05 piece 3: tray unread indicator, driven by the page's own title prefix.
    attachUnreadTitleListener(mainWindow.webContents, (unreadCount) => {
      currentUnreadCount = unreadCount;
      setUnreadOverlay(mainWindow, unreadCount);
      refreshTrayIconState();
      // Unread-count trigger (FR-14's acceptable degraded trigger + the generic-toast floor),
      // through the shared baseline. Real arrival events (service-worker / page notifications)
      // reach attention.onArrival directly.
      unread.onRawCount(unreadCount);
    });

    mainWindow.loadURL(startUrl);
  }

  function createTray() {
    trayController = createAppTray({
      getNotificationsMuted: () => settingsStore.get('notificationsMuted'),
      getVersionLabel: () => versionLabel,
      onToggleShowHide: toggleShowHide,
      onToggleMute: async () => {
        // Direct in-process call (tray-lifecycle.md "applySetting is called from exactly two
        // places... the tray menu's Mute checkbox click handler (direct in-process function
        // call...)") — settingsStore.applySetting itself refreshes the tray menu (its
        // notificationsMuted side effect) and broadcasts to an open Settings window.
        const next = !settingsStore.get('notificationsMuted');
        await settingsStore.applySetting('notificationsMuted', next);
        injectNotificationBridge();
        refreshTrayIconState();
        attention.onSettingsChanged();
      },
      onOpenSettings: () => {
        openSettingsWindow({ appIconPath: path.join(__dirname, '../../assets/icons/icon.png') });
      },
      onExit: () => {
        // Exit rules for a live call (P2) live in the call window manager.
        callWindows.requestExit();
      },
      hasCallWindow: () => callWindows.hasCallWindow(),
      onShowCallWindow: () => callWindows.showCallWindow(),
    });
    refreshTrayIconState();

    // FR-14 icon-swap wiring (docs/architecture/tray-lifecycle.md "Blink tray icon on unread" —
    // "Icon-image swap only... no menu rebuild, no settings read, no other work"): trayBlink.js
    // owns only the timer; this module supplies which glyph to show on each tick and which glyph
    // to restore once blinking stops.
    trayBlink.configure({
      onTick: (showBadge) => {
        trayController.setIconState(showBadge ? 'unread' : 'normal');
      },
      onStop: () => {
        refreshTrayIconState();
      },
    });
  }

  // FR-08: focus the existing window instead of a second instance.
  app.on('second-instance', (_event, argv) => {
    // A toast click launches a second process with the activation URL in its argv (the in-process
    // `click` normally got there first; the deduper collapses the pair).
    const id = findActivationId(argv, PROTOCOL_SCHEME);
    diag('second-instance', {
      flags: Array.isArray(argv) ? argv.filter((a) => typeof a === 'string' && a.startsWith('-')).map((a) => a.split('=')[0]).join(' ') : '',
      toastUrl: Boolean(id),
    });
    if (id) {
      handleToastClick(id, 'second-instance');
    } else {
      focusMainWindow();
    }
  });

  // Project rule "Quit only from the tray" (docs/architecture/project-rules.md): only the tray's Exit entry (and OS shutdown, which also
  // fires before-quit) actually terminates the process.
  app.on('before-quit', (event) => {
    quitGuard.onBeforeQuit(event);
    flushWindowState();
  });

  // The quit really happens: stop the isQuitting reset timer.
  app.on('will-quit', (event) => {
    quitGuard.onWillQuit();
    quitTerminator.onWillQuit(event);
  });

  // After the normal quit sequence and the flush: end the process (it can otherwise linger on Windows).
  app.on('quit', () => {
    quitTerminator.onQuit();
  });

  // Electron's Linux/Windows default would quit when the last window closes — overridden per
  // FR-06 (close-to-tray keeps the process running with no window at all being a valid state,
  // even though in practice the window is only ever hidden, never destroyed, by this app).
  app.on('window-all-closed', () => {
    // Intentionally not calling app.quit() — see tray-lifecycle.md.
  });

  ipcMain.on('notification:clicked', (event) => {
    const senderOrigin = event.senderFrame ? event.senderFrame.origin : undefined;
    if (!isAllowedSender(senderOrigin, ALLOWED_ORIGINS)) {
      console.error(
        `[gcd] rejected notification:clicked from disallowed origin: ${senderOrigin}`
      );
      return;
    }
    diag('page.notification-clicked');
    focusMainWindow();
  });

  // Sender check shared by the page-bridge notification channels (chat origin only, like the
  // service-worker channel - the sign-in origin has no business raising notifications).
  function fromAllowedFrame(event, channel) {
    const origin = event.senderFrame ? event.senderFrame.origin : undefined;
    if (isAllowedSender(origin, NOTIFICATION_ORIGINS)) return true;
    console.error(`[gcd] rejected ${channel} from disallowed origin: ${origin}`);
    return false;
  }

  // The page created its own native toast (window.Notification path): arrival signal only.
  ipcMain.on('notification:arrived', (event) => {
    if (fromAllowedFrame(event, 'notification:arrived')) toasts.noteArrival();
  });

  // A page-initiated ServiceWorkerRegistration.showNotification (Electron shows no toast for it).
  ipcMain.on('notification:show', (event, payload) => {
    if (!fromAllowedFrame(event, 'notification:show')) return;
    // The scope comes from the page's registration but is only honoured on the sender's own origin.
    let scope;
    try {
      const claimed = payload && typeof payload.scope === 'string' ? new URL(payload.scope) : null;
      if (claimed && claimed.origin === event.senderFrame.origin) scope = claimed.href;
    } catch {
      scope = undefined;
    }
    if (scope === undefined) scope = event.senderFrame.origin + '/';
    diag('page.show-notification', { scopeOrigin: redactUrl(scope), hasData: Boolean(payload && payload.data !== undefined) });
    toasts.show(payload, { scope });
  });

  // Settings window channels (docs/architecture/ipc-contract.md "Settings window"). No sender-
  // origin check here — unlike 'notification:clicked' above, the Settings window only ever loads
  // this app's own bundled local HTML, never a third-party origin (see settingsWindow.js).
  ipcMain.handle('settings:get', async () => {
    const all = settingsStore.getAll();
    return { ...all, version: versionLabel };
  });

  ipcMain.handle('settings:set', async (event, payload) => {
    const { key, value } = payload || {};
    const result = await settingsStore.applySetting(key, value, {
      originSenderId: event.sender.id,
    });
    if (result.ok) {
      if (key === 'soundEnabled' || key === 'notificationsMuted') injectNotificationBridge();
      if (key === 'notificationsMuted') refreshTrayIconState();
      attention.onSettingsChanged();
    }
    return result;
  });

  app.whenReady().then(() => {
    // Session configuration (UA + permission handler) MUST happen before the window's page
    // loads, using the same partition the BrowserWindow is constructed with — otherwise the
    // first load happens with the default (non-desktop) UA and no notification-permission grant.
    const persistentSession = session.fromPartition(PARTITION);
    configurePersistentSession(persistentSession, {
      notificationOrigins: NOTIFICATION_ORIGINS,
      displayMediaHandler: displayGate.handler,
    });
    // BUG-01-B: intercept Chat's own service-worker showNotification (see
    // serviceWorkerNotifications.js). Must be registered before the page loads its worker.
    swNotifications = attachServiceWorkerNotifications(persistentSession, {
      preloadPath: path.join(__dirname, '../preload/serviceWorkerPreload.js'),
      allowedOrigins: NOTIFICATION_ORIGINS,
      onShow: (payload, ctx) => toasts.show(payload, ctx),
      onOpen: (url, ctx) => notificationOpener.open(url, ctx),
      log: (msg, err) => console.error(msg, err === undefined ? '' : err),
      diag,
    });
    // UI-04: the single download listener for app windows and the main window.
    persistentSession.on('will-download', downloadHandler);
    // Windows (and Linux) hand `<scheme>://` URLs to this app; a toast's protocol activation uses it.
    registerProtocolHandler();

    createWindow();
    createTray();
    if (findActivationId(process.argv, PROTOCOL_SCHEME)) {
      // This process was itself started by a toast click (no instance was running): the record died
      // with the previous process, so there is nothing to replay; the window just comes forward.
      diag('cold-start.toast-launch');
      focusMainWindow();
    }

    app.on('activate', () => {
      // No macOS dock re-open behavior needed (out of scope, ADR-0003) — kept only so this
      // handler exists if a future BrowserWindow.getAllWindows() check is ever needed; currently
      // a no-op since the single window is created once and only ever hidden/shown.
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}
