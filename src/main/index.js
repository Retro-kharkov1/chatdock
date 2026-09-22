'use strict';

const path = require('path');

// --- Pure decision functions (task 0's covered net — test/index.test.js) -------------------
// These two stay dependency-free so they remain unit-testable under plain `node:test` with no
// Electron runtime. Everything else in this file (the actual app bootstrap, below) is guarded to
// run only when loaded by the real Electron binary, so `require('../src/main/index.js')` from
// `node --test` still works exactly as it did in the scaffold pass.

/**
 * isAllowedSender(frameOrigin, allowlist)
 *
 * Pure check behind docs/architecture/ipc-contract.md's "Sender validation" section: before
 * acting on the `notification:clicked` IPC message, the main-process handler (wired below) must
 * confirm the message actually came from a frame whose origin is one this app legitimately loads
 * (`chat.google.com`, plus `accounts.google.com` during sign-in — see
 * docs/architecture/overview.md's `will-navigate` allowlist), not from some other origin that
 * ended up execution context via a bug or a compromised page.
 *
 * @param {string} frameOrigin The origin to check, as read from `event.senderFrame`'s origin
 *   (e.g. `"https://chat.google.com"`). Origins never include a path, so this is a plain string
 *   equality check against the allowlist — no prefix/substring matching, precisely so a
 *   similar-looking-but-different origin (e.g. `"https://chat.google.com.evil.example"` or
 *   `"https://evilchat.google.com"`) is rejected rather than accidentally matched.
 * @param {string[]} allowlist The allowed origins (see overview.md's `will-navigate` allowlist —
 *   the same list backs both checks, per ipc-contract.md).
 * @returns {boolean} `true` only if `frameOrigin` is a case-sensitive exact match for one entry
 *   in `allowlist`. `false` for any non-string `frameOrigin`, an empty/missing allowlist, or no
 *   match — never throws.
 */
function isAllowedSender(frameOrigin, allowlist) {
  if (typeof frameOrigin !== 'string' || !Array.isArray(allowlist)) return false;
  return allowlist.includes(frameOrigin);
}

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
  const { app, BrowserWindow, ipcMain, shell } = require('electron');
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
  } = require('./notifications');
  const { createAppTray, setUnreadOverlay } = require('./tray');
  const { getSettingsPath, loadSettings, saveSettings } = require('./settings');
  const { getStartAtLogin, setStartAtLogin } = require('./autostart');
  const { readBuildInfo, buildVersionLabel } = require('./version');

  // Owner request (2026-09-22): tray version line, now sourced from `build-info.json`
  // (GitVersion-derived, wired by ci-cd-engineer) rather than this file's own mtime — see
  // version.js's header comment for why. Read once at startup, not on every menu open: the
  // running process's own build doesn't change while it's running.
  const versionLabel = buildVersionLabel(readBuildInfo(() => app.getAppPath()));

  const START_URL = 'https://chat.google.com/app/chat/SPACE_ID';
  const DEFAULT_SIZE = { width: 1200, height: 800 };

  // Provisional per overview.md — task 2 (real sign-in, out of scope this pass) is what actually
  // settles this list. If a real sign-in with 2FA hits a blocked navigation, add the origin it
  // needed here rather than treating this as final. Do not present this as a completed list.
  const ALLOWED_ORIGINS = ['https://chat.google.com', 'https://accounts.google.com'];

  // FR-10's third scenario: launched by the OS's autostart mechanism, the app must come up with
  // the window hidden, not forced open. Both autostart.js branches arrange to pass this flag.
  const launchedHidden = process.argv.includes('--hidden');

  // --- Single-instance lock (FR-08) — must happen before any window is created. ---------------
  const gotLock = app.requestSingleInstanceLock();
  if (decideSingleInstanceAction(gotLock) === 'quit') {
    app.quit();
    return;
  }

  // Windows notification/AppUserModelID — needed for Start Menu/Action Center toast identity in
  // dev, before the installer sets this up for a packaged build (electron-desktop.md §5).
  if (process.platform === 'win32') {
    app.setAppUserModelId('dev.retro-kharkov1.google-chat-desktop');
  }

  /** @type {Electron.BrowserWindow | null} */
  let mainWindow = null;
  let trayController = null;
  let isQuitting = false;
  let currentUnreadCount = 0;

  const windowStatePath = getWindowStatePath();
  const settingsPath = getSettingsPath();
  let settings = loadSettings(settingsPath);

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
      trayController.resolveIconState(currentUnreadCount, settings.notificationsMuted)
    );
  }

  /**
   * Re-injects the notification bridge with the current sound/mute values. Called on dom-ready,
   * did-finish-load, and every sound/mute toggle (tray-lifecycle.md's "Sound & mute" section).
   * Failure is logged distinctly, not swallowed — see notifications.md's "Failure mode to log,
   * not swallow": a silently-broken click-to-focus bridge must be detectable, not indistinguishable
   * from success.
   */
  function injectNotificationBridge() {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const script = buildNotificationBridgeScript(settings.soundEnabled, settings.notificationsMuted);
    mainWindow.webContents.executeJavaScript(script, false).catch((err) => {
      console.error(
        '[gcd] DEGRADED: notification bridge injection failed — click-to-focus and sound/mute' +
          ' control will not work until this is fixed. Likely cause: a CSP change on Google\'s' +
          ' side (see docs/architecture/notifications.md).',
        err
      );
    });
  }

  function persistSettings() {
    saveSettings(settingsPath, settings);
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
        // FR-05 / space rule `hidden-window-must-stay-live`: a hidden window must keep running
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

    // FR-06 / space rule `quit-only-from-tray`: the close (X) button hides, it never quits.
    mainWindow.on('close', (event) => {
      if (!isQuitting) {
        event.preventDefault();
        flushWindowState();
        mainWindow.hide();
      }
    });

    mainWindow.on('closed', () => {
      mainWindow = null;
    });

    // Security baseline (electron-desktop.md §3, space rule `electron-security-baseline`): deny
    // every popup by default, hand target=_blank/window.open to the system browser instead.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });

    // will-navigate allowlist — anything outside ALLOWED_ORIGINS is handed to the system browser
    // instead of loaded in-app. Provisional list, see ALLOWED_ORIGINS's own comment above.
    mainWindow.webContents.on('will-navigate', (event, url) => {
      let origin;
      try {
        origin = new URL(url).origin;
      } catch {
        event.preventDefault();
        return;
      }
      if (!ALLOWED_ORIGINS.includes(origin)) {
        event.preventDefault();
        shell.openExternal(url);
      }
    });

    mainWindow.webContents.on('dom-ready', injectNotificationBridge);
    mainWindow.webContents.on('did-finish-load', injectNotificationBridge);

    // FR-05 piece 3: tray unread indicator, driven by the page's own title prefix.
    attachUnreadTitleListener(mainWindow.webContents, (unreadCount) => {
      currentUnreadCount = unreadCount;
      setUnreadOverlay(mainWindow, unreadCount);
      refreshTrayIconState();
    });

    mainWindow.loadURL(START_URL);
  }

  function createTray() {
    trayController = createAppTray({
      getSoundEnabled: () => settings.soundEnabled,
      getNotificationsMuted: () => settings.notificationsMuted,
      getStartAtLogin: () => getStartAtLogin(),
      getVersionLabel: () => versionLabel,
      onToggleShowHide: toggleShowHide,
      onToggleStartAtLogin: () => {
        const next = !getStartAtLogin();
        setStartAtLogin(next);
        trayController.refreshMenu();
      },
      onToggleSound: () => {
        settings.soundEnabled = !settings.soundEnabled;
        persistSettings();
        injectNotificationBridge();
        trayController.refreshMenu();
      },
      onToggleMute: () => {
        settings.notificationsMuted = !settings.notificationsMuted;
        persistSettings();
        injectNotificationBridge();
        refreshTrayIconState();
        trayController.refreshMenu();
      },
      onExit: () => {
        app.quit();
      },
    });
    refreshTrayIconState();
  }

  // FR-08: focus the existing window instead of a second instance.
  app.on('second-instance', () => {
    focusMainWindow();
  });

  // Space rule `quit-only-from-tray`: only the tray's Exit entry (and OS shutdown, which also
  // fires before-quit) actually terminates the process.
  app.on('before-quit', () => {
    isQuitting = true;
    flushWindowState();
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
    focusMainWindow();
  });

  app.whenReady().then(() => {
    // Session configuration (UA + permission handler) MUST happen before the window's page
    // loads, using the same partition the BrowserWindow is constructed with — otherwise the
    // first load happens with the default (non-desktop) UA and no notification-permission grant.
    const { session } = require('electron');
    configurePersistentSession(session.fromPartition(PARTITION));

    createWindow();
    createTray();

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
