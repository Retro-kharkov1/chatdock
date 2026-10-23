'use strict';

// BUG-10 / docs/architecture/main-window-reload.md. Reload and recovery for the MAIN window:
//   1. F5 / Ctrl+R (Cmd+R) reload the page; Ctrl+Shift+R / Ctrl+F5 reload ignoring the cache.
//   2. A failed main-frame load (offline launch, DNS, connection reset ...) is retried with a back-off, in the main
//      process, so a blank page recovers by itself and the user never has to quit and relaunch. No app-drawn page.
//   3. The retry is a main-process timer plus loadURL: it never shows, focuses, throttles or destroys the window, so a
//      hidden window recovers while hidden ("Hidden window must stay live").
//   4. FR-19 (sign-in mode): no automatic retry while the mode is on (the mode's own limits - idle, total time, origin
//      changes, Back to Chat - end it and return to Chat); a pending retry is dropped when the mode turns on. A manual
//      reload during the mode reloads the current page only and goes through the same navigation events the flow
//      already watches, so the 30-minute and 40-origin limits still bound it. Nothing here opens an origin.
//
// A retry target is either the failed URL, when its origin is a Chat origin, or the fixed start URL. Never any other
// failed URL. No cookie, credential, URL or page text is logged: outcome words only.
// No Electron import: the contents and timers are injected, so it runs under plain node:test.

const ERR_ABORTED = -3; // a navigation superseded by another one; not a failure to recover from
const DEFAULT_BACKOFF_MS = Object.freeze([2000, 5000, 10000, 30000, 60000]); // last value repeats

function isHttpUrl(url) {
  try {
    const p = new URL(url).protocol;
    return p === 'https:' || p === 'http:';
  } catch {
    return false;
  }
}

/** Classify a before-input-event input: 'reload', 'hard' or null. Key-down only, no auto-repeat, no Alt. */
function reloadKind(input) {
  if (!input || input.type !== 'keyDown' || input.isAutoRepeat === true || input.alt) return null;
  const key = String(input.key).toLowerCase();
  const mod = input.control === true || input.meta === true;
  if (key === 'f5') return mod || input.shift ? 'hard' : 'reload';
  if (key === 'r' && mod) return input.shift ? 'hard' : 'reload';
  return null;
}

/**
 * @param {object} deps
 * @param {object} deps.webContents the main window's contents
 * @param {string} deps.startUrl fixed Chat start page
 * @param {(url: string) => boolean} deps.isChatUrl true when the URL's origin is a Chat origin
 * @param {() => boolean} deps.isSignInActive FR-19 mode on right now
 * @param {(msg: string, detail?: string) => void} [deps.log]
 */
function createMainReload({
  webContents,
  startUrl,
  isChatUrl,
  isSignInActive,
  log = () => {},
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (handle) => clearTimeout(handle),
  backoffMs = DEFAULT_BACKOFF_MS,
}) {
  let failedTarget = null; // set by a main-frame failure, cleared by the next successful http(s) load
  let attempt = 0;
  let timer = null;
  let disposed = false;

  const alive = () => !disposed && webContents && !webContents.isDestroyed();

  function cancelTimer() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  function load(target, why) {
    if (!alive()) return;
    log('[gcd] main reload: ' + why);
    const rejected = (err) => log('[gcd] main reload load rejected', err && err.name); // did-fail-load schedules the next try
    try {
      // Called synchronously (not from a microtask) so the call happens inside the timer tick.
      Promise.resolve(webContents.loadURL(target)).catch(rejected);
    } catch (err) {
      rejected(err);
    }
  }

  function retryDelay() {
    return backoffMs[Math.min(attempt, backoffMs.length - 1)];
  }

  function scheduleRetry() {
    cancelTimer();
    const delay = retryDelay();
    attempt += 1;
    diag('schedule', 'delay=' + delay);
    timer = setTimer(() => {
      timer = null;
      diag('timer', 'failedTarget=' + (failedTarget !== null));
      if (!alive() || failedTarget === null) return;
      if (isSignInActive()) {
        log('[gcd] main reload: retry dropped, sign-in in progress');
        return;
      }
      load(failedTarget, 'retry');
    }, delay);
  }

  // DIAG (BUG-10): outcome words, URL scheme and host only. Remove once the acceptance rows are stable.
  const scheme = (u) => {
    try {
      return new URL(u).protocol;
    } catch {
      return 'none';
    }
  };
  const host = (u) => {
    try {
      return new URL(u).host;
    } catch {
      return '-';
    }
  };
  const safeFrameUrl = () => {
    try {
      return (webContents.mainFrame && webContents.mainFrame.url) || '';
    } catch {
      return '';
    }
  };
  const diag = (what, detail) => log('[gcd] main reload diag: ' + what + ' ' + (detail || ''));

  let navSinceFail = false; // a main-frame, cross-document navigation started after the last failure

  function onStartNavigation(event, ...legacy) {
    const d = event && typeof event === 'object' && 'isMainFrame' in event ? event : null;
    const isMain = d ? d.isMainFrame : legacy[1];
    const sameDoc = d ? d.isSameDocument : legacy[0];
    const url = d ? d.url : legacy[0];
    diag('start-nav', 'main=' + isMain + ' same=' + sameDoc + ' ' + scheme(url) + '@' + host(url));
    if (isMain === true && sameDoc !== true) navSinceFail = true;
  }

  function onFailLoad(_event, errorCode, _description, failedUrl, isMainFrame) {
    diag('fail-event', 'main=' + isMainFrame + ' code=' + errorCode + ' ' + scheme(failedUrl) + '@' + host(failedUrl));
    if (!alive() || isMainFrame !== true || errorCode === ERR_ABORTED) return;
    navSinceFail = false;
    failedTarget = typeof failedUrl === 'string' && isHttpUrl(failedUrl) && isChatUrl(failedUrl) ? failedUrl : startUrl;
    log('[gcd] main load failed, code ' + errorCode);
    if (isSignInActive()) {
      cancelTimer(); // FR-19: the mode's own limits decide; no automatic navigation here
      return;
    }
    scheduleRetry();
  }

  function onLoaded() {
    if (!alive()) return;
    let url = '';
    try {
      // getURL() is the virtual URL: after a failed load it still returns the FAILED http(s) URL while the engine's
      // error page is shown. The committed document URL (mainFrame.url) is chrome-error://..., which is what tells the
      // error page apart from a real page. Fall back to getURL() when the frame URL is unavailable.
      const frame = webContents.mainFrame;
      url = frame && typeof frame.url === 'string' && frame.url !== '' ? frame.url : webContents.getURL();
    } catch {
      return;
    }
    diag('finish', 'frame=' + scheme(safeFrameUrl()) + ' get=' + scheme(url) + '@' + host(url) + ' navSinceFail=' + navSinceFail);
    if (!isHttpUrl(url)) return; // the engine's own error page also finishes a load: not a recovery
    // The error page's finish arrives with no new navigation since the failure, whatever URL the engine reports.
    if (failedTarget !== null && !navSinceFail) return;
    failedTarget = null;
    attempt = 0;
    cancelTimer();
  }

  /** Manual reload (accelerator). After a failure it restarts the load of the retry target at once. */
  function reloadNow(hard) {
    if (!alive()) return;
    if (failedTarget !== null && !isSignInActive()) {
      cancelTimer();
      attempt = 0;
      load(failedTarget, 'manual retry');
      return;
    }
    log('[gcd] main reload: manual');
    if (hard) webContents.reloadIgnoringCache();
    else webContents.reload();
  }

  function onInput(event, input) {
    const kind = reloadKind(input);
    if (kind === null) return;
    event.preventDefault();
    try {
      reloadNow(kind === 'hard');
    } catch (err) {
      log('[gcd] main reload failed', err && err.name);
    }
  }

  function bind() {
    webContents.on('did-fail-load', onFailLoad);
    webContents.on('did-start-navigation', onStartNavigation);
    webContents.on('did-finish-load', onLoaded);
    webContents.on('before-input-event', onInput);
  }

  function dispose() {
    disposed = true;
    cancelTimer();
  }

  return { bind, dispose, reloadNow, isRecovering: () => failedTarget !== null };
}

module.exports = { createMainReload, reloadKind, DEFAULT_BACKOFF_MS };
