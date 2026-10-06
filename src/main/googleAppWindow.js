'use strict';

// UI-04 / FR-17, docs/architecture/google-app-windows.md sections 2 and 4: Google app windows.
//
// One bare browser-like BrowserWindow per link, deduplicated, on the SHARED persistent partition so the
// signed-in session carries over. The app draws nothing in it: no toolbar, no bridge, no IPC channel. The only
// app-authored surface is the single native close confirmation. Every collaborator is injected (see
// test/helpers/googleAppWindowHarness.js for the contract), so this module has no Electron import.
//
// Close destroys: never quits, never hides. Tray Exit never asks about an app window (it only flips isQuitting,
// which makes every window's will-prevent-unload override synchronous).

const { PARTITION } = require('./session');
const { createCloseProbe } = require('./closeProbe');
const { bindEditShortcuts } = require('./editShortcuts');
const { isOpenableExternalScheme } = require('./meetLink');
const { classifyGoogleLink, isGoogleNavigationUrl, isDownloadHop } = require('./googleLink');

const WINDOW_TITLE = 'Google Chat Desktop';
const ERR_ABORTED = -3; // a superseded or cancelled navigation, not a load failure

// docs/architecture/google-app-windows.md section 8, "Native dialog wording": exact strings.
const CLOSE_CONFIRM = Object.freeze({
  title: 'Close this window?',
  message: 'This page has changes that may not be saved.',
  buttons: Object.freeze(['Close window', 'Keep window open']),
});

/** The href without its fragment: the registry key (a #heading link finds the existing window). */
function keyOf(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

function hasFragment(url) {
  try {
    return new URL(url).hash !== '';
  } catch {
    return false;
  }
}

function createGoogleAppWindowManager({
  BrowserWindow,
  getRouter,
  isQuitting,
  showMessageBox,
  openExternal,
  timers = { setTimeout, clearTimeout },
  probeMs = 3000,
  hopMs = 10000,
  iconPath,
  bindSmartCopy, // optional (UI-05): context-menu link copy for every window; absent = no smart copy
  log = () => {},
}) {
  /** @type {Map<string, Entry>} href-without-fragment -> window entry (hop windows are pending until decided) */
  const registry = new Map();

  /**
   * @typedef {{
   *   win: any, key: string, requestedUrl: string, pending: boolean, displayed: boolean,
   *   hopTimer: any, hopOriginalUrl: string, probe: any,
   *   dialog: null | { controller: AbortController }
   * }} Entry
   */

  const aliveWin = (entry) => Boolean(entry.win) && !entry.win.isDestroyed();

  function safe(fn, what) {
    try {
      return fn();
    } catch (err) {
      log('[gcd] app window:', what, err && err.name);
      return undefined;
    }
  }

  function raise(entry) {
    if (!aliveWin(entry)) return;
    if (entry.win.isMinimized()) entry.win.restore();
    entry.win.show();
    entry.win.focus();
  }

  function destroy(entry) {
    if (aliveWin(entry)) entry.win.destroy();
  }

  /** System browser by the scheme rule (the router applies the same rule; the hop paths call this directly). */
  function sendToBrowser(url) {
    if (!isOpenableExternalScheme(url)) {
      log('[gcd] app window: link not opened: disallowed scheme');
      return;
    }
    openExternal(url);
  }

  /** Route a link that leaves an app window through the shared router (source 'app'). Never throws. */
  function routeAway(url) {
    safe(() => getRouter().route(url, { source: 'app' }), 'route');
  }

  // --- forms.gle entry hop (section 2) ---------------------------------------------------------------------------
  function clearHopTimer(entry) {
    if (entry.hopTimer !== null) {
      timers.clearTimeout(entry.hopTimer);
      entry.hopTimer = null;
    }
  }

  /** The hop did not reach a nav-list page: the user is never left with nothing - the ORIGINAL url goes to the browser. */
  function failHop(entry) {
    if (!entry.pending) return;
    entry.pending = false;
    clearHopTimer(entry);
    destroy(entry);
    sendToBrowser(entry.hopOriginalUrl);
  }

  /** did-navigate on a pending hop window: show on a nav-list landing, otherwise fall back to the browser. */
  function decideHop(entry, landedUrl) {
    if (!entry.pending) return;
    if (!isGoogleNavigationUrl(landedUrl)) {
      failHop(entry);
      return;
    }
    entry.pending = false;
    entry.displayed = true;
    clearHopTimer(entry);
    const finalKey = keyOf(landedUrl);
    const existing = finalKey === null ? undefined : registry.get(finalKey);
    if (existing && existing !== entry && aliveWin(existing)) {
      destroy(entry); // the final page already has a window: focus that one instead
      raise(existing);
      return;
    }
    if (finalKey !== null) {
      if (registry.get(entry.key) === entry) registry.delete(entry.key);
      entry.key = finalKey;
      registry.set(finalKey, entry);
    }
    entry.win.show();
    entry.win.focus();
  }

  // --- navigation and popups (main frame only) --------------------------------------------------------------------------
  function onNavigate(entry, type, event, navUrl, _inPlace, isMainFrame) {
    const main = event && typeof event.isMainFrame === 'boolean' ? event.isMainFrame : isMainFrame;
    if (main === false) return; // sub-frames are unrestricted
    const target = event && typeof event.url === 'string' ? event.url : navUrl;

    if (entry.pending) {
      // Hidden hop window: only a nav-list target may load; hidden content outside the list never does.
      if (isGoogleNavigationUrl(target)) return;
      event.preventDefault();
      entry.pending = false;
      clearHopTimer(entry);
      destroy(entry);
      sendToBrowser(target);
      return;
    }

    const windowUrl = entry.win.webContents.getURL() || '';
    if (isGoogleNavigationUrl(target)) return;
    if (
      isDownloadHop({
        url: target,
        // On a brand-new window's initial load there is no page yet: the source is the REQUESTED url.
        fromUrl: windowUrl !== '' ? windowUrl : entry.requestedUrl,
        isRedirect: type === 'will-redirect',
        windowUrl,
      })
    ) {
      return;
    }
    event.preventDefault();
    routeAway(target); // Meet -> call window, Chat -> by classifyChatTarget(url, 'app'), forms.gle -> hop, else browser
    // A window that never displayed an allowed page and whose navigation just left for elsewhere would stay blank:
    // destroy it (section 2, same family as the empty window after a download). A displayed window is never closed.
    if (!entry.displayed) destroy(entry);
  }

  /** Always deny. A nav-list target is recreated through the factory (hardened options, never inherited). */
  function onPopup(details) {
    const url = details && details.url;
    safe(() => {
      if (isGoogleNavigationUrl(url)) {
        openGoogleAppWindow(new URL(url).href);
      } else {
        routeAway(url);
      }
    }, 'popup');
    return { action: 'deny' };
  }

  // --- close path (section 4 "will-prevent-unload") -------------------------------------------------------------------------
  function showCloseConfirm(entry) {
    const controller = new AbortController();
    const slot = { controller };
    entry.dialog = slot;
    let shown;
    try {
      shown = Promise.resolve(
        showMessageBox(entry.win, {
          type: 'warning',
          title: CLOSE_CONFIRM.title,
          message: CLOSE_CONFIRM.message,
          buttons: CLOSE_CONFIRM.buttons.slice(),
          defaultId: 1,
          cancelId: 1,
          noLink: true,
          signal: controller.signal,
        })
      );
    } catch (err) {
      shown = Promise.reject(err);
    }
    shown
      .then(
        (result) => (result && Number.isInteger(result.response) ? result.response : 1),
        () => 1
      )
      .then((response) => {
        if (entry.dialog !== slot || !aliveWin(entry)) return; // stale: the window is gone or the box was replaced
        entry.dialog = null;
        if (response === 0) destroy(entry); // "Close window"
        else raise(entry); // "Keep window open" / Escape
      });
  }

  function onPreventUnload(entry, event) {
    if (isQuitting()) {
      event.preventDefault(); // synchronous: a quit is never held up by an unsaved-changes objection
      return;
    }
    if (!entry.probe.isActive()) return; // page-initiated (reload / navigation): the page's own protection stands
    // The FIRST objection of an app-initiated close is consumed; the window stays and the user is asked once.
    entry.probe.clear();
    showCloseConfirm(entry);
  }

  function onClose(entry, event) {
    if (isQuitting()) return; // the will-prevent-unload override completes the quit
    if (entry.dialog) {
      event.preventDefault(); // one dialog per window: the close is already represented
      raise(entry);
      return;
    }
    if (entry.probe.isActive()) return; // a probe is already in flight
    entry.probe.start(); // let the close proceed so the page's beforeunload runs
  }

  function onClosed(entry) {
    entry.probe.clear();
    clearHopTimer(entry);
    entry.pending = false;
    const slot = entry.dialog;
    entry.dialog = null;
    if (slot) safe(() => slot.controller.abort(), 'abort dialog'); // the box goes with its parent
    if (registry.get(entry.key) === entry) registry.delete(entry.key);
  }

  // --- creation -------------------------------------------------------------------------------------------------------------
  function createWindow(url, key, hop) {
    const options = {
      width: 1200,
      height: 800,
      title: WINDOW_TITLE,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        partition: PARTITION, // the shared session: the Google sign-in carries over
        // No bridge script at all: the contents has no preload and no IPC channel.
      },
    };
    if (iconPath) options.icon = iconPath;
    if (hop) options.show = false; // a hop window is invisible until its landing page is known

    const created = new BrowserWindow(options);
    /** @type {Entry} */
    const entry = {
      win: created,
      key,
      requestedUrl: url,
      pending: hop,
      displayed: false,
      hopTimer: null,
      hopOriginalUrl: url,
      probe: null,
      dialog: null,
    };
    entry.probe = createCloseProbe({ timers, probeMs, onTimeout: () => destroy(entry) });
    registry.set(key, entry); // synchronously, before the load: two quick clicks cannot create two windows

    const contents = created.webContents;
    contents.setWindowOpenHandler(onPopup);
    bindEditShortcuts(contents); // the application menu is null: Ctrl+C/V/X/A/Z are restored per window
    if (typeof bindSmartCopy === 'function') bindSmartCopy(contents); // UI-05: right-click link copy only
    contents.on('will-navigate', (event, navUrl, inPlace, isMainFrame) =>
      safe(() => onNavigate(entry, 'will-navigate', event, navUrl, inPlace, isMainFrame), 'will-navigate')
    );
    contents.on('will-redirect', (event, navUrl, inPlace, isMainFrame) =>
      safe(() => onNavigate(entry, 'will-redirect', event, navUrl, inPlace, isMainFrame), 'will-redirect')
    );
    contents.on('will-prevent-unload', (event) => onPreventUnload(entry, event)); // always registered
    contents.on('did-navigate', (_event, navUrl) =>
      safe(() => {
        if (entry.pending) {
          decideHop(entry, typeof navUrl === 'string' ? navUrl : contents.getURL());
        } else {
          entry.displayed = true; // a page was committed: never auto-closed as an "empty" window
        }
      }, 'did-navigate')
    );
    contents.on('did-fail-load', (_event, errorCode, _description, _failedUrl, isMainFrame) =>
      safe(() => {
        if (isMainFrame === false || errorCode === ERR_ABORTED) return;
        if (entry.pending) failHop(entry);
      }, 'did-fail-load')
    );
    created.on('close', (event) => safe(() => onClose(entry, event), 'close'));
    created.on('closed', () => safe(() => onClosed(entry), 'closed'));

    if (hop) {
      entry.hopTimer = timers.setTimeout(() => {
        entry.hopTimer = null;
        safe(() => failHop(entry), 'hop timeout');
      }, hopMs);
    }
    Promise.resolve(created.loadURL(url)).catch((err) => log('[gcd] app window load failed', err && err.name));
    if (!hop) created.focus();
    return entry;
  }

  // --- the entry points -----------------------------------------------------------------------------------------------------
  /** openGoogleAppWindow(url, { hop }) - the router's collaborator, also used for nav-list popups. */
  function openGoogleAppWindow(rawUrl, opts) {
    const hop = Boolean(opts && opts.hop);
    const key = keyOf(rawUrl);
    if (key === null) return;
    const url = new URL(rawUrl).href; // always the normalised href, whoever the caller is
    // Defence in depth: only a Google link may reach a window that holds the session.
    const permitted = hop ? classifyGoogleLink(url).hop === true : isGoogleNavigationUrl(url);
    if (!permitted) {
      log('[gcd] app window: refused a link outside the lists');
      return;
    }

    const existing = registry.get(key);
    if (existing && aliveWin(existing)) {
      if (existing.pending) return; // coalesced: never shows or focuses the hidden hop window
      const contents = existing.win.webContents;
      if (hasFragment(url) && keyOf(contents.getURL()) === key) {
        // Same document, new fragment: a same-document navigation (no reload) that scrolls to the heading.
        Promise.resolve(contents.loadURL(url)).catch((err) => log('[gcd] app window load failed', err && err.name));
      }
      raise(existing); // otherwise only focus: never navigate away from what the user is reading
      return;
    }
    createWindow(url, key, hop);
  }

  /** The downloads module's lookup: the app window that owns these contents, else null. */
  function getAppWindowForContents(webContents) {
    if (!webContents) return null;
    for (const entry of registry.values()) {
      if (aliveWin(entry) && entry.win.webContents === webContents) return entry.win;
    }
    return null;
  }

  /**
   * Empty-window auto-close (section 2): a window that never displayed a page (its only navigation became a
   * download) is destroyed. A window that displayed a page, a pending hop and unknown contents are left alone.
   */
  function closeIfEmpty(webContents) {
    if (!webContents) return false;
    for (const entry of registry.values()) {
      if (!aliveWin(entry) || entry.win.webContents !== webContents) continue;
      if (entry.displayed || entry.pending) return false;
      destroy(entry);
      return true;
    }
    return false;
  }

  return { openGoogleAppWindow, getAppWindowForContents, closeIfEmpty };
}

module.exports = { createGoogleAppWindowManager, CLOSE_CONFIRM };
