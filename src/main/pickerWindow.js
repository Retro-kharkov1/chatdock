'use strict';

// FR-16 / docs/architecture/meet-call-window.md section 7 and ipc-contract.md "Screen-share picker
// window": the ONLY surface the app draws for Meet. A small modal child of the call window that
// loads this app's own bundled HTML with its own preload and its own non-persistent partition.
//
// No Electron import at load time: BrowserWindow / session / ipcMain / desktopCapturer are injected,
// so everything here is unit-testable with fakes.
//
// Thumbnails show live screen content: they travel only main -> picker renderer and are never
// logged, persisted or forwarded.

const PICKER_CHANNELS = Object.freeze({
  getSources: 'picker:get-sources',
  choose: 'picker:choose',
  cancel: 'picker:cancel',
});

/** Its own NON-persistent partition (no `persist:` prefix): never the app session, so Meet's
 * permission handlers do not apply to the picker and nothing it does is stored. */
const PICKER_PARTITION = 'gcd-picker';

const PICKER_TITLE = 'Choose what to share — Google Chat Desktop';

function buildPickerWindowOptions({ parent, preloadPath }) {
  return {
    parent,
    modal: true,
    title: PICKER_TITLE,
    width: 640,
    height: 520,
    minWidth: 400,
    minHeight: 400,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: preloadPath,
      partition: PICKER_PARTITION,
    },
  };
}

/** Every permission request on the picker partition is denied; every check is false. */
function configurePickerSession(ses) {
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
}

function createPickerWindow({ BrowserWindow, session, parent, preloadPath, htmlPath }) {
  const options = buildPickerWindowOptions({ parent, preloadPath });
  configurePickerSession(session.fromPartition(options.webPreferences.partition));
  const win = new BrowserWindow(options);
  // Navigation is never allowed (the document is local and static); popups are never created.
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.loadFile(htmlPath);
  return win;
}

/**
 * createPickerController({ createWindow, getSources, bundledFileUrl, log })
 *
 * One request at a time. `open(parent)` shows the window at once (the renderer shows its loading
 * state), and the slow `getSources()` runs only when the renderer asks for it.
 */
function createPickerController({ createWindow, getSources, bundledFileUrl, log = () => {} }) {
  /** @type {{ win: any, resolve: Function, rawSources: any[] | null, sentIds: Set<string> | null } | null} */
  let request = null;

  function windowAlive(req) {
    return req && req.win && !req.win.isDestroyed();
  }

  /** Resolve the pending request exactly once, drop references, close the window. */
  function finish(req, result) {
    if (request !== req) return;
    request = null;
    req.resolve(result);
    if (req.win && !req.win.isDestroyed()) req.win.destroy();
  }

  /** Accept a message only from the picker's own webContents and the bundled file's frame. */
  function isValidSender(event, channel) {
    const ok =
      request !== null &&
      windowAlive(request) &&
      event &&
      event.sender &&
      event.sender.id === request.win.webContents.id &&
      event.senderFrame &&
      event.senderFrame.url === bundledFileUrl;
    // Dropped and logged without content: no source ids, no thumbnails.
    if (!ok) log('[gcd] picker message dropped: invalid sender', channel);
    return Boolean(ok);
  }

  function open(parent) {
    if (request) finish(request, null); // a newer request replaces the older one, which is denied
    return new Promise((resolve) => {
      const win = createWindow({ parent });
      const req = { win, resolve, rawSources: null, sentIds: null };
      request = req;
      win.on('closed', () => finish(req, null)); // X, Escape-closes, OS close, parent teardown
    });
  }

  const handlers = {
    async getSources(event) {
      if (!isValidSender(event, PICKER_CHANNELS.getSources)) return [];
      const req = request;
      const raw = await getSources(); // rejects on failure: the renderer shows its error state
      if (request !== req) return []; // torn down while listing
      req.rawSources = raw;
      req.sentIds = new Set(raw.map((s) => s.id));
      return raw.map((s) => ({
        id: s.id,
        name: s.name,
        kind: typeof s.id === 'string' && s.id.startsWith('screen:') ? 'screen' : 'window',
        thumbnail: s.thumbnail.toDataURL(),
      }));
    },

    async choose(event, payload) {
      if (!isValidSender(event, PICKER_CHANNELS.choose)) return { ok: false };
      const req = request;
      const sourceId = payload && typeof payload === 'object' ? payload.sourceId : undefined;
      if (typeof sourceId !== 'string' || sourceId === '') return { ok: false };
      if (!req.sentIds || !req.sentIds.has(sourceId)) return { ok: false };
      finish(req, { sourceId, sources: req.rawSources });
      return { ok: true };
    },

    cancel(event) {
      if (!isValidSender(event, PICKER_CHANNELS.cancel)) return;
      finish(request, null);
    },
  };

  function raise() {
    if (!request || !windowAlive(request)) return;
    const win = request.win;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  function flash() {
    if (!request || !windowAlive(request)) return;
    request.win.flashFrame(true);
  }

  return {
    open,
    abortPending: () => {
      if (request) finish(request, null);
    },
    isOpen: () => request !== null && windowAlive(request),
    raise,
    flash,
    handlers,
    register(ipcMain) {
      ipcMain.handle(PICKER_CHANNELS.getSources, (event) => handlers.getSources(event));
      ipcMain.handle(PICKER_CHANNELS.choose, (event, payload) => handlers.choose(event, payload));
      ipcMain.on(PICKER_CHANNELS.cancel, (event) => handlers.cancel(event));
    },
  };
}

module.exports = {
  PICKER_CHANNELS,
  PICKER_PARTITION,
  buildPickerWindowOptions,
  configurePickerSession,
  createPickerWindow,
  createPickerController,
};
