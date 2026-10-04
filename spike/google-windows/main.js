'use strict';

// THROWAWAY host-observation harness for UI-04 (docs/architecture/google-app-windows.md,
// implementation step 1). Not product code, never packaged (build.files only includes src/**).
// Delete when UI-04 ships and the manual rows are recorded.
//
//   node_modules\.bin\electron spike\google-windows
//   options: --profile=product|harness   (default product: the real signed-in session)
//            --url=<https Google link>   open a test window at start
//            --no-chat                   do not open the main Chat window
//            --exit-after=<seconds>      quit by itself (used for smoke runs)
//
// What it does: runs on the product's persistent partition (PARTITION, imported, never a literal) with
// the product's UA, opens the Chat window and, on demand, test windows for URLs pasted into a small
// control window. Everything the page does that matters for the UI-04 host rules is written to
// spike\google-windows\out\hosts.log.
//
// PRIVACY CONTRACT of the log: hosts and path SHAPES only. Path segments that are not short lowercase
// words become ":id"; query strings are reduced to parameter NAMES; fragments to "#"; no cookies, tokens,
// headers other than content-type/disposition kind, message text, titles or file names. A short
// lowercase path word (for example a Sites page name) can still survive; skim the log before sharing it.
//
// Behaviour: nothing is hidden from the page. Google navigation and popups are allowed (popups open as
// real child windows so redirect chains and window.opener can be observed); downloads are logged and then
// cancelled so no file lands; non-Google targets are refused (logged) because this runs on the real
// profile. Google windows get contextIsolation, sandbox, no nodeIntegration and NO preload. Only the
// local control window has a preload.

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, Menu, ipcMain, session } = require('electron');
const { PARTITION, buildDesktopUserAgent } = require('../../src/main/session');

const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : d;
};
const flag = (n) => process.argv.includes(`--${n}`);
const PROFILE = arg('profile', 'product');
const START_URL = arg('url', '');
const EXIT_AFTER = Number(arg('exit-after', '0'));
const OUT = path.join(__dirname, 'out');
const LOG = path.join(OUT, 'hosts.log');
const CHAT_URL = 'https://chat.google.com/';

if (PROFILE === 'harness') {
  // Own throwaway profile (sign in once here); the installed app may keep running.
  app.setPath('userData', path.join(__dirname, '.profile'));
} else {
  // The product's profile: the REAL signed-in session. The installed app must be fully quit first.
  app.setPath('userData', path.join(app.getPath('appData'), 'google-chat-desktop'));
}

// Chromium locks the profile; a running product app with the same userData holds this lock.
if (!app.requestSingleInstanceLock()) {
  console.error(
    'This profile is in use. Fully quit Google Chat Desktop (tray icon > Exit) and run again.'
  );
  app.exit(2);
}

fs.mkdirSync(OUT, { recursive: true });

// ---------- redaction ----------
const KEEP_WORDS = new Set([
  'my-drive', 'shared-with-me', 'recent', 'starred', 'trash',
  // mixed-case sign-in path words (generic, not identifiers)
  'ServiceLogin', 'AccountChooser', 'CheckCookie', 'SetSID', 'MergeSession', 'AddSession',
]);
function shapeSegment(seg) {
  if (/^[a-z_]{1,24}$/.test(seg) || /^\d{1,2}$/.test(seg) || /^v\d{1,2}$/.test(seg) || KEEP_WORDS.has(seg)) return seg;
  return ':id';
}
/** shape(url) - scheme/host/path-shape/query-names only. Never throws, never returns values. */
function shape(value) {
  if (typeof value !== 'string' || value === '') return '(none)';
  let u;
  try {
    u = new URL(value);
  } catch {
    return '(unparseable)';
  }
  if (u.protocol === 'blob:') return 'blob:' + shape(u.pathname);
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return u.protocol; // about:, data:, file:, ...
  const segs = u.pathname.split('/').filter(Boolean).map(shapeSegment);
  const names = [...new Set([...u.searchParams.keys()].map((k) => (/^[A-Za-z_]{1,24}$/.test(k) ? k : '?')))].sort();
  return (
    `${u.protocol === 'http:' ? 'http://' : ''}${u.username || u.password ? '(userinfo)@' : ''}${u.host}` +
    `/${segs.join('/')}` +
    `${u.pathname.endsWith('/') && segs.length ? '/' : ''}` +
    `${names.length ? '?' + names.join('&') : ''}${u.hash ? '#' : ''}`
  );
}
const originOf = (value) => {
  try {
    const o = new URL(value).origin;
    return o === 'null' ? '(opaque)' : o;
  } catch {
    return '(none)';
  }
};
const hostOf = (value) => {
  try {
    return new URL(value).hostname;
  } catch {
    return '';
  }
};

// Google-owned hosts only: this runs on the real profile, so nothing else is ever loaded.
const GOOGLE_HOST =
  /(^|\.)(google\.com|googleusercontent\.com|youtube\.com|gstatic\.com|googleapis\.com|googledrive\.com|googlevideo\.com)$/;
function isGoogleUrl(value) {
  try {
    const u = new URL(value);
    if (u.protocol === 'about:') return value === 'about:blank';
    if (u.protocol === 'blob:') return isGoogleUrl(u.pathname);
    if (u.protocol !== 'https:') return false;
    return GOOGLE_HOST.test(u.hostname) || u.hostname === 'forms.gle' || u.hostname === 'g.co';
  } catch {
    return false;
  }
}

// ---------- log ----------
const t0 = Date.now();
const seen = new Set();
function log(tag, obj, { dedupe = false } = {}) {
  const body = obj === undefined ? '' : JSON.stringify(obj);
  if (dedupe) {
    const key = tag + body;
    if (seen.has(key)) return;
    seen.add(key);
  }
  const line = `[+${((Date.now() - t0) / 1000).toFixed(2)}s] ${tag} ${body}`;
  console.log(line);
  fs.appendFileSync(LOG, line + '\n');
}
fs.appendFileSync(LOG, `\n==== run ${new Date().toISOString()} ====\n`);

// ---------- window bookkeeping ----------
const labels = new Map(); // webContents.id -> label
let controlWin = null;
let chatWin = null;
let testCount = 0;
const labelOf = (wc) => (wc && labels.get(wc.id)) || (wc ? `wc${wc.id}` : '(none)');

const GOOGLE_WEB_PREFS = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  partition: PARTITION,
  // deliberately NO preload
});

function createGoogleWindow(label) {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: `Spike ${label}`,
    webPreferences: { ...GOOGLE_WEB_PREFS },
  });
  labels.set(win.webContents.id, label);
  // The page's own <title> can be a file name; keep it out of the OS title bar of a screen-shared harness.
  win.webContents.on('page-title-updated', (e) => e.preventDefault());
  win.on('closed', () => log('window-closed', { label }));
  return win;
}

function openChat() {
  if (chatWin && !chatWin.isDestroyed()) {
    chatWin.focus();
    return 'Chat window already open.';
  }
  chatWin = createGoogleWindow('chat');
  chatWin.loadURL(CHAT_URL).catch((e) => log('load-failed', { label: 'chat', code: e && e.code }));
  return 'Chat window opened.';
}

function openTest(url) {
  if (typeof url !== 'string' || url.length > 2048) return { ok: false, reason: 'not a URL' };
  let u;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: 'not a URL' };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'https only' };
  if (!isGoogleUrl(u.href)) return { ok: false, reason: 'not a Google host (harness refuses to load it)' };
  const label = `test-${++testCount}`;
  const win = createGoogleWindow(label);
  log('test-window-open', { label, url: shape(u.href) });
  win.loadURL(u.href).catch((e) => log('load-failed', { label, code: e && e.code }));
  return { ok: true, label };
}

// ---------- per-webContents observation (main Chat, test windows AND every popup) ----------
function attach(wc) {
  const lab = () => labelOf(wc);
  const from = () => shape(wc.getURL());

  const navInfo = (ev, args) => {
    let initiator;
    try {
      initiator = ev.initiator ? shape(ev.initiator.url) : undefined;
    } catch {
      initiator = undefined;
    }
    return {
      url: typeof ev.url === 'string' ? ev.url : typeof args[0] === 'string' ? args[0] : undefined,
      isMainFrame: typeof ev.isMainFrame === 'boolean' ? ev.isMainFrame : null,
      isSameDocument: typeof ev.isSameDocument === 'boolean' ? ev.isSameDocument : null,
      initiator,
    };
  };
  const guard = (tag, ev, args) => {
    const n = navInfo(ev, args);
    const allowed = isGoogleUrl(n.url);
    log(tag, {
      win: lab(),
      main: n.isMainFrame,
      to: shape(n.url),
      from: from(),
      initiator: n.initiator,
      inPage: n.isSameDocument,
      ...(allowed ? {} : { blocked: 'non-google' }),
    });
    // Main-frame only: sub-frames are never restricted (same as the spec's navigation rule).
    if (!allowed && n.isMainFrame !== false) ev.preventDefault();
  };

  wc.on('will-navigate', (ev, ...args) => guard('will-navigate', ev, args));
  wc.on('will-redirect', (ev, ...args) => guard('will-redirect', ev, args));
  wc.on('will-frame-navigate', (ev, ...args) => {
    const n = navInfo(ev, args);
    if (n.isMainFrame === false) {
      log(
        'will-frame-navigate(sub)',
        { win: lab(), main: false, to: shape(n.url), initiator: n.initiator },
        { dedupe: true }
      );
    }
  });
  wc.on('did-navigate', (_e, url, code) => log('did-navigate', { win: lab(), main: true, url: shape(url), status: code }));
  wc.on('did-navigate-in-page', (_e, url, isMain) => {
    if (isMain) log('did-navigate-in-page', { win: lab(), main: true, url: shape(url) }, { dedupe: true });
  });
  wc.on('did-frame-navigate', (_e, url, code, _t, isMain) => {
    if (!isMain) log('did-frame-navigate(sub)', { win: lab(), main: false, url: shape(url), status: code }, { dedupe: true });
  });
  wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (code !== -3) log('did-fail-load', { win: lab(), main: isMain, code, desc, url: shape(url) });
  });
  wc.on('render-process-gone', (_e, d) => log('render-process-gone', { win: lab(), reason: d && d.reason }));
  wc.on('enter-html-full-screen', () => log('fullscreen-enter', { win: lab(), page: from() }));
  wc.on('leave-html-full-screen', () => log('fullscreen-leave', { win: lab(), page: from() }));

  wc.setWindowOpenHandler((details) => {
    const allowed = isGoogleUrl(details.url);
    let featureKeys = '';
    try {
      featureKeys = String(details.features || '')
        .split(',')
        .map((f) => f.split('=')[0].trim())
        .filter(Boolean)
        .join(',');
    } catch {
      /* ignore */
    }
    log('window-open', {
      win: lab(),
      url: shape(details.url),
      from: from(),
      disposition: details.disposition,
      frameNamed: Boolean(details.frameName),
      featureKeys,
      decision: allowed ? 'allow-as-child-window' : 'deny-non-google',
    });
    if (!allowed) return { action: 'deny' };
    return { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { ...GOOGLE_WEB_PREFS } } };
  });

  wc.on('did-create-window', (child, details) => {
    labels.set(child.webContents.id, `popup-of-${lab()}`);
    log('popup-created', { win: `popup-of-${lab()}`, url: shape(details.url) });
    child.webContents.on('page-title-updated', (e) => e.preventDefault());
  });
}

app.on('web-contents-created', (_e, wc) => {
  if (wc.session === controlSession()) return; // the local control page is not observed
  if (wc.getType && wc.getType() !== 'window' && wc.getType() !== 'webview') return;
  attach(wc);
});

// ---------- session-level observation (product partition) ----------
const interesting = /download|export|attachment|confirm|get_|scan|^\/uc$/;
function configureSession(ses) {
  ses.setUserAgent(buildDesktopUserAgent());

  ses.on('will-download', (_e, item, wc) => {
    let chain = [];
    try {
      chain = item.getURLChain().map(shape);
    } catch {
      /* ignore */
    }
    log('will-download', {
      win: labelOf(wc),
      page: wc ? shape(wc.getURL()) : '(none)',
      url: shape(item.getURL()),
      chain,
      mime: item.getMimeType(), // never getFilename()
      bytes: item.getTotalBytes(),
      userGesture: item.hasUserGesture(),
      action: 'cancelled-by-harness',
    });
    item.cancel(); // log, then cancel: no file may land
  });

  // Permissions: log every request/check with requesting and top-level origin. Grant only the two the
  // spec proposes (so Copy link / Present can be exercised); everything else is denied (and logged).
  const GRANT = new Set(['clipboard-sanitized-write', 'fullscreen']);
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const decision = GRANT.has(permission);
    log(
      'permission-request',
      {
        win: labelOf(wc),
        permission,
        requesting: originOf(details && details.requestingUrl),
        topLevel: wc ? originOf(wc.getURL()) : '(none)',
        mainFrame: details ? details.isMainFrame : null,
        decision: decision ? 'grant' : 'deny',
      },
      { dedupe: true }
    );
    callback(decision);
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    const decision = GRANT.has(permission);
    log(
      'permission-check',
      {
        win: labelOf(wc),
        permission,
        requesting: originOf(requestingOrigin) !== '(none)' ? originOf(requestingOrigin) : originOf(details && details.requestingUrl),
        embedding: originOf(details && details.embeddingOrigin),
        mainFrame: details ? details.isMainFrame : null,
        decision: decision ? 'grant' : 'deny',
      },
      { dedupe: true }
    );
    return decision;
  });

  // Request level evidence the Electron events do not carry (HTTP method, redirect status, the
  // "Download anyway" form POST, content type vs attachment). Main-frame requests always; other
  // resource types only when the path/query looks like a download/export/attachment/confirm request.
  const urls = ['<all_urls>'];
  const want = (d) => {
    if (d.resourceType === 'mainFrame') return true;
    try {
      const u = new URL(d.url);
      const names = [...u.searchParams.keys()].join('&');
      return interesting.test(`${u.pathname}?${names}`);
    } catch {
      return false;
    }
  };
  const who = (d) => (d.webContentsId ? labelOf({ id: d.webContentsId }) : '(none)');
  ses.webRequest.onBeforeRequest({ urls }, (d, cb) => {
    if (want(d) || d.resourceType === 'subFrame') {
      log(
        'request',
        { win: who(d), type: d.resourceType, method: d.method, url: shape(d.url) },
        { dedupe: d.resourceType !== 'mainFrame' }
      );
    }
    cb({});
  });
  ses.webRequest.onBeforeRedirect({ urls }, (d) => {
    if (want(d) || d.resourceType === 'subFrame') {
      log('redirect', {
        win: who(d),
        type: d.resourceType,
        status: d.statusCode,
        from: shape(d.url),
        to: shape(d.redirectURL),
      });
    }
  });
  ses.webRequest.onHeadersReceived({ urls }, (d, cb) => {
    if (want(d) || d.resourceType === 'subFrame') {
      const h = d.responseHeaders || {};
      const get = (name) => {
        const k = Object.keys(h).find((x) => x.toLowerCase() === name);
        return k ? String(h[k][0] || h[k]) : '';
      };
      const disp = get('content-disposition').toLowerCase();
      log(
        'response',
        {
          win: who(d),
          type: d.resourceType,
          status: d.statusCode,
          url: shape(d.url),
          contentType: get('content-type').split(';')[0].trim().toLowerCase(),
          disposition: disp.startsWith('attachment') ? 'attachment' : disp ? 'inline' : 'none',
        },
        { dedupe: d.resourceType !== 'mainFrame' }
      );
    }
    cb({});
  });
}

// ---------- control window + IPC ----------
const controlSession = () => session.fromPartition('gcd-spike-control'); // in-memory, never the product partition

function createControl() {
  controlWin = new BrowserWindow({
    width: 560,
    height: 360,
    title: 'UI-04 host spike - control',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      session: controlSession(),
      preload: path.join(__dirname, 'control-preload.js'),
    },
  });
  controlWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  controlWin.webContents.on('will-navigate', (e) => e.preventDefault());
  controlWin.loadFile(path.join(__dirname, 'control.html'));
  controlWin.on('closed', () => app.quit());
  if (flag('selftest-control')) {
    // Smoke test of the control page + IPC: types a URL and a marker and clicks both buttons.
    controlWin.webContents.once('did-finish-load', () => {
      controlWin.webContents
        .executeJavaScript(
          `document.getElementById('url').value='https://forms.gle/abc';document.getElementById('open').click();` +
            `document.getElementById('mark').value='selftest marker';document.getElementById('markbtn').click();` +
            `new Promise(r=>setTimeout(()=>r(document.getElementById('out').textContent),500))`
        )
        .then((t) => log('selftest-control', { out: t }))
        .catch((e) => log('selftest-control', { error: String(e) }));
    });
  }
}

function fromControl(e) {
  return controlWin && !controlWin.isDestroyed() && e.sender === controlWin.webContents;
}
ipcMain.handle('harness:open', (e, url) => (fromControl(e) ? openTest(url) : { ok: false, reason: 'refused' }));
ipcMain.handle('harness:mark', (e, text) => {
  if (!fromControl(e)) return false;
  log('MARK', { text: String(text || '').slice(0, 120) });
  return true;
});
ipcMain.handle('harness:chat', (e) => ({ message: fromControl(e) ? openChat() : 'refused' }));
ipcMain.handle('harness:info', (e) =>
  fromControl(e) ? { profile: PROFILE === 'harness' ? 'harness (.profile)' : 'product (real session)', log: LOG } : null
);

// ---------- lifecycle ----------
app.on('window-all-closed', () => app.quit());

app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // as in the product: no menu, so no Ctrl+W / reload shortcuts
  configureSession(session.fromPartition(PARTITION));
  log('start', {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    profile: PROFILE,
    partition: PARTITION,
    userAgent: buildDesktopUserAgent(),
  });
  createControl();
  if (!flag('no-chat')) openChat();
  if (START_URL) {
    const r = openTest(START_URL);
    if (!r.ok) log('start-url-refused', { reason: r.reason });
  }
  if (EXIT_AFTER > 0) setTimeout(() => app.quit(), EXIT_AFTER * 1000);
});
