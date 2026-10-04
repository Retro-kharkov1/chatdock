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
//   (b) nothing is opened, revealed or launched when a download ends;
//   (c) cancelling the dialog cancels the item (Electron);
//   (d) file names and URLs are never logged: only started / completed / cancelled / interrupted / blocked and
//       the scheme.
// Origin check differs by source:
//   app window  strict, on the WHOLE chain: the final URL and every URL of getURLChain() must be https (or blob:,
//               whose inner origin is used) on the nav list, usercontent /download, or a download-chain host;
//   main window scheme only (https or blob:), no host check: Chat attachment hosts are not yet observed.
// A failed check cancels the item and shows ONE native "Download blocked" box per originating window; further
// blocked downloads in that window while it is open are cancelled and folded into it.
//
// No Electron import: every collaborator is injected (see test/downloads.test.js for the contract).

const path = require('path');
const { DOWNLOAD_CHAIN_HOSTS, isDownloadChainUrl } = require('./googleLink');

const FALLBACK_FILE_NAME = 'download';

const BLOCKED = Object.freeze({
  title: 'Download blocked',
  message: 'This download comes from an address the app does not allow.',
  close: 'Close',
  openInBrowser: 'Open in browser',
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

function createDownloadHandler({
  getAppWindowForContents,
  getMainWindow,
  closeEmptyWindow,
  getDownloadsDir,
  showMessageBox,
  openExternal,
  downloadChainHosts = DOWNLOAD_CHAIN_HOSTS,
  log = () => {},
}) {
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

  function showBlockedNotice(origin, parent, url) {
    if (notices.has(origin)) return; // folded into the box that is already open for this window
    const openable = schemeOf(url) === 'https';
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
          message: BLOCKED.message,
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
      item.once('done', (_event, state) => {
        log('[gcd] download', state);
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

module.exports = { createDownloadHandler, BLOCKED, safeBaseName };
