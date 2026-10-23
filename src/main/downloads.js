'use strict';

// UI-04 / FR-17, docs/architecture/google-app-windows.md section 4 "Downloads" and section 8 (dialog table).
//
// ONE session `will-download` listener for two kinds of originating contents: a Google app window and the main
// window (Chat attachments). Any other contents is left to Electron's default, untouched.
//
// Rules common to both:
//   (a) the save dialog is ALWAYS shown: setSavePath is never called; setSaveDialogOptions({ defaultPath }) gives
//       the OS Downloads folder joined to the BASENAME of the suggested name, so a hostile name cannot carry a path
//       (and '', '.', '..' fall back to a fixed name, they never resolve to the folder itself or its parent);
//   (b) nothing is ever opened or launched. UI-12 (ADR-0006): while a download runs the taskbar shows its progress, and a
//       COMPLETED item raises one native notice whose click (or action) reveals exactly the path this Save dialog
//       produced (item.getSavePath()) in its folder, through the injected `revealItem`. Only paths registered here at
//       completion can be revealed (exact string match); failure and cancel clear the progress and show nothing;
//   (c) cancelling the dialog cancels the item (Electron);
//   (d) file names and URLs are never logged: only started / completed / cancelled / interrupted / blocked and
//       the scheme.
// Origin check differs by source:
//   app window  strict, on the WHOLE chain: the final URL and every URL of getURLChain() must be https (or blob:,
//               whose inner origin is used) on the nav list, usercontent /download, or a download-chain host;
//   main window scheme only (https or blob:), no host check: Chat attachment hosts are not yet observed.
// A failed check cancels the item and shows ONE native "Download blocked" box per originating window; further
// blocked downloads in that window while it is open are cancelled and folded into it.
// FR-19 (sign-in-flow.md section 4): while the sign-in mode is on (`isMainDownloadBlocked()`, read per download) EVERY
// main-window download is cancelled, with sign-in wording and no "Open in browser" (that action would hand the URL of
// an untrusted page to the system browser). App windows and the mode-off main window are unchanged.
//
// No Electron import: every collaborator is injected (see test/downloads.test.js for the contract).

const path = require('path');
const { DOWNLOAD_CHAIN_HOSTS, isDownloadChainUrl } = require('./googleLink');

const FALLBACK_FILE_NAME = 'download';

/** UI-12 / ADR-0006: wording of the one completion notice. The body carries the (truncated) file name, shown only. */
const COMPLETE = Object.freeze({
  title: 'Download complete',
  bodySuffix: 'Click to show it in its folder.',
  action: 'Show in folder',
});
const MAX_NAME_IN_NOTICE = 80;
const MAX_REVEALABLE = 50;
const EXISTS_TIMEOUT_MS = 1500; // F1: a dead network share must not hold the reveal for long
const NAME_TAIL = 12; // F4: the end of a long name (the extension) always stays visible

const BLOCKED = Object.freeze({
  title: 'Download blocked',
  message: 'This download comes from an address the app does not allow.',
  close: 'Close',
  openInBrowser: 'Open in browser',
});

/** FR-19: the notice for a main-window download refused while the sign-in mode is on (title shared with BLOCKED). */
const SIGN_IN_BLOCKED = Object.freeze({
  title: BLOCKED.title,
  message: 'Downloads are not allowed while you sign in. Finish signing in, then try again.',
  close: BLOCKED.close,
});

/** Scheme only, for logging. */
function schemeOf(url) {
  if (typeof url !== 'string') return 'unparseable';
  const m = /^\s*([a-z][a-z0-9+.-]*):/i.exec(url);
  return m ? m[1].toLowerCase() : 'unparseable';
}

/** Basename of a suggested name, whatever separators it uses; never '', '.', '..' or dots/spaces only. */
function safeBaseName(name) {
  const raw = typeof name === 'string' ? name.replace(/\0/g, '') : '';
  const last = raw.split(/[\\/]/).pop();
  return /^[. ]*$/.test(last) ? FALLBACK_FILE_NAME : last;
}

/** Log form of a root: a class only. A UNC root names a server and a share, so it is reduced to `\\...`. */
function redactRoot(root) {
  return root.startsWith('\\\\') || root.startsWith('//') ? '\\\\...' : root;
}

/** Log form of a path: the root class and the folder depth only. No folder, file, server or share name. */
function redactPath(p, pathModule = path) {
  if (typeof p !== 'string' || p === '') return '<none>';
  try {
    const parsed = pathModule.parse(p);
    const folders = pathModule.dirname(p).slice(parsed.root.length).split(/[\\/]/).filter(Boolean);
    return `${redactRoot(parsed.root)}...[depth ${folders.length}]`;
  } catch {
    return '<unparseable>';
  }
}

/** The notice body: the base name cut to a fixed length plus the click hint. */
function completionBody(savePath, pathModule = path) {
  // F4: controls (C0, DEL, C1) become a space; format characters (bidi overrides, zero-width, ...) are removed.
  let name = pathModule
    .basename(savePath)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\p{Cf}/gu, '');
  if (name.length > MAX_NAME_IN_NOTICE) {
    name = `${name.slice(0, MAX_NAME_IN_NOTICE - 3 - NAME_TAIL)}...${name.slice(-NAME_TAIL)}`;
  }
  return `${name}\n${COMPLETE.bodySuffix}`;
}

function createDownloadHandler({
  getAppWindowForContents,
  getMainWindow,
  closeEmptyWindow,
  getDownloadsDir,
  showMessageBox,
  openExternal,
  downloadChainHosts = DOWNLOAD_CHAIN_HOSTS,
  isMainDownloadBlocked = () => false,
  // UI-12 (all optional; absent = that feedback is simply off, so older callers and tests are unchanged):
  setProgress = () => {}, // (value) taskbar progress: 0..1, 2 = indeterminate, -1 = clear
  showCompletionNotice = null, // ({ title, body, actionText, onReveal }) one native notice; null = none
  isNoticeMuted = () => false, // the Mute setting
  revealItem = null, // (absolutePath) reveal in the file manager; called only for a registered path
  fileExists = () => true, // may be async; bounded by existsTimeoutMs
  existsTimeoutMs = EXISTS_TIMEOUT_MS,
  pathModule = path,
  log = () => {},
}) {
  /** Paths produced by this handler's own completed downloads: the only ones revealItem may ever receive. */
  const revealable = new Set();
  /** running items -> { received, total }; an item joins the aggregate at its first 'updated' (after the dialog). */
  const progress = new Map();

  function pushProgress() {
    try {
      const live = [...progress.values()];
      if (live.length === 0) {
        setProgress(-1);
        return;
      }
      if (live.some((p) => !(p.total > 0))) {
        setProgress(2);
        return;
      }
      const received = live.reduce((a, p) => a + p.received, 0);
      const total = live.reduce((a, p) => a + p.total, 0);
      setProgress(Math.min(1, Math.max(0, received / total)));
    } catch (err) {
      log('[gcd] download: progress failed', err && err.name);
    }
  }

  /** True only when fileExists answers true within the timeout; a hang or an error counts as not present. */
  function checkPresent(savePath) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), existsTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      Promise.resolve()
        .then(() => fileExists(savePath))
        .then((v) => resolve(v === true), () => resolve(false))
        .finally(() => clearTimeout(timer));
    });
  }

  async function reveal(savePath) {
    // Exact match against what this handler registered; nothing else reaches the file manager.
    if (typeof revealItem !== 'function' || !revealable.has(savePath) || !pathModule.isAbsolute(savePath)) {
      log('[gcd] download reveal refused');
      return;
    }
    const present = await checkPresent(savePath);
    if (!present) {
      log('[gcd] download reveal: file gone or unreachable', redactPath(savePath, pathModule));
      return;
    }
    try {
      revealItem(savePath);
      log('[gcd] download reveal', redactPath(savePath, pathModule));
    } catch (err) {
      log('[gcd] download reveal failed', err && err.name);
    }
  }

  function noticeCompleted(item) {
    if (typeof showCompletionNotice !== 'function') return;
    let savePath = '';
    try {
      savePath = typeof item.getSavePath === 'function' ? item.getSavePath() : '';
    } catch {
      savePath = '';
    }
    if (typeof savePath !== 'string' || savePath === '' || savePath.includes('\0') || !pathModule.isAbsolute(savePath)) {
      return;
    }
    revealable.delete(savePath); // F3: a re-download moves to the newest position
    revealable.add(savePath);
    while (revealable.size > MAX_REVEALABLE) revealable.delete(revealable.values().next().value);
    if (isNoticeMuted() === true) {
      log('[gcd] download notice suppressed (muted)');
      return;
    }
    try {
      showCompletionNotice({
        title: COMPLETE.title,
        body: completionBody(savePath, pathModule),
        actionText: COMPLETE.action,
        onReveal: () => reveal(savePath).catch(() => {}),
      });
    } catch (err) {
      log('[gcd] download: notice failed', err && err.name);
    }
  }

  /** originating window -> the open "Download blocked" box for it (coalescing: one per window) */
  const notices = new Map();

  /** One URL of an app-window chain: https on an allowed host, or blob: with an allowed inner origin. */
  function appUrlAllowed(url) {
    if (typeof url !== 'string') return false;
    if (/^blob:/i.test(url)) {
      try {
        const origin = new URL(url).origin;
        return origin !== 'null' && isDownloadChainUrl(`${origin}/`, downloadChainHosts);
      } catch {
        return false;
      }
    }
    return isDownloadChainUrl(url, downloadChainHosts);
  }

  function appDownloadAllowed(item) {
    const chain = item.getURLChain();
    const urls = [item.getURL(), ...(Array.isArray(chain) ? chain : [])];
    return urls.every(appUrlAllowed);
  }

  /** Main window: scheme only. */
  function mainDownloadAllowed(item) {
    const scheme = schemeOf(item.getURL());
    return scheme === 'https' || scheme === 'blob';
  }

  /** A parent is only used while it is visible and not minimized; otherwise the box is unparented. */
  function usableParent(win, empty) {
    if (empty || !win) return undefined;
    try {
      if (win.isDestroyed() || !win.isVisible() || win.isMinimized()) return undefined;
    } catch {
      return undefined;
    }
    return win;
  }

  function showBlockedNotice(origin, parent, url, signIn = false) {
    if (notices.has(origin)) return; // folded into the box that is already open for this window
    const openable = !signIn && schemeOf(url) === 'https';
    const controller = new AbortController();
    const slot = { dismissed: false };
    notices.set(origin, slot);

    const onParentClosed = () => {
      slot.dismissed = true; // a late answer is ignored even if the box ignores the signal
      controller.abort();
    };
    if (parent) parent.once('closed', onParentClosed);
    const cleanup = () => {
      notices.delete(origin);
      if (parent) {
        try {
          parent.removeListener('closed', onParentClosed);
        } catch {
          // parent already gone
        }
      }
    };

    let shown;
    try {
      shown = Promise.resolve(
        showMessageBox(parent, {
          type: 'warning',
          title: BLOCKED.title,
          message: signIn ? SIGN_IN_BLOCKED.message : BLOCKED.message,
          buttons: openable ? [BLOCKED.close, BLOCKED.openInBrowser] : [BLOCKED.close],
          defaultId: 0, // "Close": a stray Enter never launches a browser
          cancelId: 0,
          noLink: true,
          signal: controller.signal,
        })
      );
    } catch (err) {
      shown = Promise.reject(err);
    }
    shown
      .then(
        (result) => (result && Number.isInteger(result.response) ? result.response : 0),
        () => 0
      )
      .then((response) => {
        cleanup();
        if (slot.dismissed) return;
        if (openable && response === 1) {
          try {
            openExternal(url);
          } catch (err) {
            log('[gcd] download: open in browser failed', err && err.name);
          }
        }
      });
  }

  function block(item, origin, contents, isApp) {
    const url = item.getURL();
    item.cancel();
    log('[gcd] download blocked', schemeOf(url));
    // An app window that never displayed a page (the blocked download was its only navigation) closes at once.
    const empty = isApp ? Boolean(closeEmptyWindow(contents)) : false;
    showBlockedNotice(origin, usableParent(origin, empty), url);
  }

  /** FR-19: cancel a main-window download during the sign-in mode (a pure refusal; nothing is offered or opened). */
  function blockForSignIn(item, mainWin) {
    item.cancel();
    log('[gcd] download blocked', 'sign-in');
    showBlockedNotice(mainWin, usableParent(mainWin, false), item.getURL(), true);
  }

  function handler(event, item, webContents) {
    if (!webContents || !item) return;
    let appWin = null;
    let mainWin = null;
    try {
      appWin = getAppWindowForContents(webContents);
      if (!appWin) {
        const main = getMainWindow();
        if (main && !main.isDestroyed() && main.webContents === webContents) mainWin = main;
      }
    } catch (err) {
      log('[gcd] download: lookup failed', err && err.name);
      return;
    }
    const origin = appWin || mainWin;
    if (!origin) return; // not ours: Electron's default applies
    const isApp = Boolean(appWin);

    try {
      if (!isApp && isMainDownloadBlocked() === true) {
        blockForSignIn(item, mainWin);
        return;
      }
      const allowed = isApp ? appDownloadAllowed(item) : mainDownloadAllowed(item);
      if (!allowed) {
        block(item, origin, webContents, isApp);
        return;
      }
      // Always ask where to save: no setSavePath. The default folder is the OS Downloads folder.
      item.setSaveDialogOptions({
        defaultPath: path.join(getDownloadsDir(), safeBaseName(item.getFilename())),
      });
      log('[gcd] download started', schemeOf(item.getURL()));
      item.on('updated', (_event, state) => {
        if (state !== 'progressing' && state !== 'interrupted') return;
        try {
          progress.set(item, { received: item.getReceivedBytes(), total: item.getTotalBytes() });
        } catch {
          progress.set(item, { received: 0, total: 0 });
        }
        pushProgress();
      });
      item.once('done', (_event, state) => {
        log('[gcd] download', state);
        progress.delete(item); // completion, cancel and failure all clear this item's share of the bar
        pushProgress();
        if (state === 'completed') noticeCompleted(item);
        if (isApp) {
          try {
            closeEmptyWindow(webContents); // an empty window left behind by a download hop closes now
          } catch (err) {
            log('[gcd] download: auto-close failed', err && err.name);
          }
        }
      });
    } catch (err) {
      // Fail closed: a download whose checks could not complete is not allowed to proceed.
      log('[gcd] download handling failed', err && err.name);
      try {
        item.cancel();
      } catch {
        // already cancelled
      }
    }
  }

  return handler;
}

module.exports = { createDownloadHandler, BLOCKED, SIGN_IN_BLOCKED, COMPLETE, safeBaseName, redactPath, completionBody };
