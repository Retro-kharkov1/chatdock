'use strict';

// UI-06: the in-app Help window. An app-owned, single-instance window that loads this app's own
// generated, static user guide (src/renderer/help/help.html, built from docs/user-guide.md by
// scripts/build-help.js). Same trust model as the screen-share picker (pickerWindow.js): local bundled
// HTML only, sandbox + contextIsolation, no nodeIntegration, NO preload (nothing is exposed to the
// page, so there is no bridge and no IPC channel for this window), and its own NON-persistent
// partition on which every permission is denied.
//
// No Electron import at load time: BrowserWindow / session are injected, so everything here is
// unit-testable with fakes.

const { pathToFileURL } = require('url');
const { bindEditShortcuts } = require('./editShortcuts');

/** Its own NON-persistent partition (no `persist:` prefix): never the app session. */
const HELP_PARTITION = 'gcd-help';

const HELP_TITLE = 'Google Chat Desktop — Help';

function buildHelpWindowOptions({ iconPath } = {}) {
  return {
    title: HELP_TITLE,
    width: 820,
    height: 760,
    minWidth: 420,
    minHeight: 360,
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: false,
    autoHideMenuBar: true,
    icon: iconPath,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      partition: HELP_PARTITION,
      // Deliberately NO `preload`: the page has no bridge.
    },
  };
}

/** Every permission request on the Help partition is denied; every check is false. */
function configureHelpSession(ses) {
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
}

function stripHash(url) {
  const i = url.indexOf('#');
  return i === -1 ? url : url.slice(0, i);
}

/**
 * decideHelpNavigation(url, helpUrl) -> 'anchor' | 'external' | 'deny'
 *   'anchor'   - the guide's own file, only the #fragment differs: in-page, allowed.
 *   'external' - http / https / mailto: goes to the system browser.
 *   'deny'     - everything else (file: elsewhere, other schemes, junk): nothing happens.
 */
function decideHelpNavigation(url, helpUrl, isOpenableExternalScheme) {
  if (typeof url !== 'string' || url === '') return 'deny';
  if (stripHash(url) === stripHash(helpUrl)) return 'anchor';
  return isOpenableExternalScheme(url) ? 'external' : 'deny';
}

/**
 * createHelpWindowController({ BrowserWindow, session, htmlPath, iconPath, openExternal,
 *                              isOpenableExternalScheme, log })
 *
 * One window at a time: open() while it exists restores and focuses it. Closing it destroys it (no
 * `close` interception) and can never quit the app - nothing here touches `app` or any quit path.
 */
function createHelpWindowController({
  BrowserWindow,
  session,
  htmlPath,
  iconPath,
  openExternal,
  isOpenableExternalScheme,
  log = () => {},
}) {
  const helpUrl = pathToFileURL(htmlPath).href;
  /** @type {any} */
  let win = null;

  const alive = () => win !== null && !win.isDestroyed();

  function route(url) {
    const decision = decideHelpNavigation(url, helpUrl, isOpenableExternalScheme);
    if (decision === 'deny') log('[gcd] help navigation denied');
    if (decision === 'external') openExternal(url);
    return decision;
  }

  function create() {
    const options = buildHelpWindowOptions({ iconPath });
    configureHelpSession(session.fromPartition(options.webPreferences.partition));
    const created = new BrowserWindow(options);
    if (typeof created.setMenu === 'function') created.setMenu(null);
    const contents = created.webContents;

    // Navigation inside the window is denied; the in-page #anchor case is the only exception, and an
    // external link is handed to the system browser instead of loading here.
    const onNavigate = (event, url) => {
      const target = typeof event.url === 'string' ? event.url : url;
      if (route(target) !== 'anchor') event.preventDefault();
    };
    contents.on('will-navigate', onNavigate);
    contents.on('will-frame-navigate', onNavigate);
    contents.on('will-redirect', (event) => event.preventDefault());
    // target="_blank" / window.open: never a new window; http(s)/mailto go to the system browser.
    contents.setWindowOpenHandler((details) => {
      route(details && details.url);
      return { action: 'deny' };
    });

    // No application menu exists, so restore the clipboard accelerators (select + copy a passage)
    // and give Escape the usual "close this window" meaning. Closing never quits the app.
    bindEditShortcuts(contents);
    contents.on('before-input-event', (event, input) => {
      if (input && input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault();
        if (!created.isDestroyed()) created.close();
      }
    });

    created.on('closed', () => {
      if (win === created) win = null;
    });
    // loadFile returns a promise in Electron; a failure is logged without content.
    const loading = created.loadFile(htmlPath);
    if (loading && typeof loading.catch === 'function') {
      loading.catch((err) => log('[gcd] help load failed', err && err.name));
    }
    return created;
  }

  function open() {
    if (alive()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      return win;
    }
    win = create();
    return win;
  }

  return {
    open,
    isOpen: () => alive(),
    getWindow: () => (alive() ? win : null),
  };
}

module.exports = {
  HELP_PARTITION,
  HELP_TITLE,
  buildHelpWindowOptions,
  configureHelpSession,
  decideHelpNavigation,
  createHelpWindowController,
};
