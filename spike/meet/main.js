'use strict';

// THROWAWAY harness for ADR-0004 "Spike B" (Meet in an Electron window). Not product code.
//
//   node_modules\.bin\electron spike\meet                 live mode: opens https://meet.google.com/new
//   node_modules\.bin\electron spike\meet --mode=auto     automated probes, writes spike\meet\out\
//   options: --url=<https://meet.google.com/...>  --unload=log|override  --profile=harness|product
//
// Mirrors the intended call-window config: shared partition PARTITION (imported, not changed),
// the app's desktop-Chrome UA, contextIsolation true, nodeIntegration false, sandbox true, NO
// preload on the Meet window, media/display-capture granted only to https://meet.google.com
// (request AND check handler), screen share only through an explicit picker.
//
// Logs: console + spike\meet\out\spike-b.log. Only origin+path of URLs is logged (never query,
// cookies or credentials).

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { app, BrowserWindow, session, desktopCapturer, ipcMain } = require('electron');
const { PARTITION, buildDesktopUserAgent } = require('../../src/main/session');

const MEET = 'https://meet.google.com';
const NAV_HOSTS = new Set(['meet.google.com', 'accounts.google.com']);
const arg = (n, d) => {
  const a = process.argv.find((x) => x.startsWith(`--${n}=`));
  return a ? a.slice(n.length + 3) : d;
};
const MODE = arg('mode', 'live');
const UNLOAD = arg('unload', 'log'); // live mode: log | override
const PROFILE = arg('profile', 'harness');
const START_URL = arg('url', `${MEET}/new`);
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const LOG = path.join(OUT, 'spike-b.log');
fs.writeFileSync(LOG, '');

if (PROFILE === 'harness') {
  // Own profile so the product app can keep running; a real login is needed once here.
  app.setPath('userData', path.join(__dirname, '.profile'));
} else {
  // Same profile as the product ('google-chat-desktop' under %APPDATA%): the product app MUST be fully quit.
  app.setPath('userData', path.join(app.getPath('appData'), 'google-chat-desktop'));
}

const safeUrl = (u) => {
  try {
    const x = new URL(u);
    return x.origin + x.pathname;
  } catch {
    return String(u).slice(0, 80);
  }
};
const originOf = (u) => {
  try {
    return new URL(u).origin;
  } catch {
    return undefined;
  }
};
const t0 = Date.now();
function log(tag, obj) {
  const line = `[+${((Date.now() - t0) / 1000).toFixed(2)}s] ${tag} ${obj === undefined ? '' : JSON.stringify(obj)}`;
  console.log(line);
  fs.appendFileSync(LOG, line + '\n');
}
const results = { electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform, mode: MODE };
function saveResults() {
  fs.writeFileSync(path.join(OUT, 'auto-results.json'), JSON.stringify(results, null, 2));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- OS-level camera/mic in-use evidence (Windows ConsentStore) ----------
function linuxDevices(kind) {
  // Linux/WSLg evidence: PulseAudio source-outputs = live mic capture streams; /dev/video* + open fds = camera.
  try {
    if (kind === 'microphone') {
      const out = execFileSync('pactl', ['list', 'short', 'source-outputs'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const n = out.split('\n').filter((l) => l.trim()).length;
      return { sourceOutputs: n, inUse: n > 0 };
    }
    const vids = fs.readdirSync('/dev').filter((f) => /^video\d+$/.test(f));
    if (!vids.length) return { absent: true, note: 'no /dev/video* node' };
    const held = vids.filter((v) => {
      try {
        return execFileSync('fuser', [`/dev/${v}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0;
      } catch {
        return false;
      }
    });
    return { nodes: vids, inUse: held.length > 0 };
  } catch (e) {
    return { error: String(e && e.message).slice(0, 80) };
  }
}
function consent(kind) {
  if (process.platform === 'linux') return linuxDevices(kind);
  if (process.platform !== 'win32') return { note: 'win32/linux only' };
  const key = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\${kind}\\NonPackaged\\${process.execPath.replace(/\\/g, '#')}`;
  try {
    const out = execFileSync('reg', ['query', key], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const get = (n) => {
      const m = out.match(new RegExp(`${n}\\s+REG_QWORD\\s+0x([0-9a-fA-F]+)`));
      return m ? BigInt('0x' + m[1]) : undefined;
    };
    const start = get('LastUsedTimeStart');
    const stop = get('LastUsedTimeStop');
    return { start: String(start), stop: String(stop), inUse: start !== undefined && start !== 0n && stop === 0n };
  } catch {
    return { absent: true };
  }
}
const devState = () => ({ webcam: consent('webcam'), microphone: consent('microphone') });

// ---------- session ----------
let callWin = null;
let pickerWin = null;
const permissionLog = [];

function isGrantable(permission, origin, details) {
  if (origin !== MEET) return false;
  if (permission === 'display-capture') return true;
  if (permission === 'media') {
    const types = (details && (details.mediaTypes || (details.mediaType ? [details.mediaType] : []))) || [];
    return types.every((t) => t === 'video' || t === 'audio');
  }
  return false;
}
const slimDetails = (d) => {
  if (!d) return d;
  const o = {};
  for (const [k, v] of Object.entries(d)) {
    if (k === 'requestingUrl' || k === 'embeddingOrigin') o[k] = safeUrl(v);
    else if (typeof v !== 'object') o[k] = v;
    else o[k] = v;
  }
  return o;
};

function configureSession(ses) {
  ses.setUserAgent(buildDesktopUserAgent());

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const origin = originOf(details && details.requestingUrl) || originOf(wc && wc.getURL());
    const grant = isGrantable(permission, origin, details);
    const rec = { handler: 'request', permission, origin, grant, details: slimDetails(details) };
    permissionLog.push(rec);
    log('permission', rec);
    callback(grant);
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
    const origin = originOf(requestingOrigin) || originOf(details && details.requestingUrl);
    const grant = isGrantable(permission, origin, details);
    const rec = { handler: 'check', permission, origin, requestingOrigin, grant, details: slimDetails(details) };
    permissionLog.push(rec);
    log('permission', rec);
    return grant;
  });

  ses.setDisplayMediaRequestHandler(
    (request, callback) => {
      log('display-media-request', {
        securityOrigin: request.securityOrigin,
        videoRequested: request.videoRequested,
        audioRequested: request.audioRequested,
        userGesture: request.userGesture,
        frame: request.frame ? safeUrl(request.frame.url) : null,
      });
      permissionLog.push({ handler: 'displayMedia', origin: request.securityOrigin, userGesture: request.userGesture });
      // NB: Electron delivers securityOrigin WITH a trailing slash (https://meet.google.com/), so normalise.
      if (originOf(request.securityOrigin) !== MEET) return callback(null);
      openPicker(callback);
    },
    { useSystemPicker: false }
  );
}

// ---------- minimal explicit picker (never auto-selects) ----------
async function openPicker(callback) {
  let settled = false;
  const done = (streams, why) => {
    if (settled) return;
    settled = true;
    log('picker-result', { why, chosen: streams ? { name: streams.video.name } : null });
    try {
      callback(streams); // null = cancel
    } catch (e) {
      log('picker-callback-threw', { message: String(e && e.message) });
    }
    if (pickerWin && !pickerWin.isDestroyed()) pickerWin.destroy();
    pickerWin = null;
  };
  const tg = Date.now();
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
  log('desktopCapturer.getSources', { ms: Date.now() - tg, count: sources.length, kinds: sources.map((s) => s.id.split(':')[0]) });
  results.sourceCount = sources.length;
  results.sourceKinds = sources.map((s) => `${s.id.split(':')[0]}:${s.name}`);
  results.getSourcesMs = Date.now() - tg;
  pickerWin = new BrowserWindow({
    width: 760,
    height: 520,
    parent: callWin && !callWin.isDestroyed() ? callWin : undefined,
    modal: !!(callWin && !callWin.isDestroyed()),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'picker-preload.js'),
    },
  });
  const pw = pickerWin;
  const ok = (e) => pw && !pw.isDestroyed() && e.sender === pw.webContents;
  const onChoose = (e, id) => {
    if (!ok(e)) return;
    const s = sources.find((x) => x.id === id);
    done(s ? { video: s } : null, s ? 'chosen' : 'unknown-id');
  };
  const onCancel = (e) => ok(e) && done(null, 'cancel-button');
  ipcMain.on('picker:choose', onChoose);
  ipcMain.on('picker:cancel', onCancel);
  pw.on('closed', () => {
    ipcMain.removeListener('picker:choose', onChoose);
    ipcMain.removeListener('picker:cancel', onCancel);
    done(null, 'picker-closed');
  });
  await pw.loadFile(path.join(__dirname, 'picker.html'));
  pw.webContents.send(
    'picker:sources',
    sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }))
  );
}

// ---------- call-window factory (intended config) ----------
function createCallWindow({ url, unloadMode, tag = 'call', show = true }) {
  const win = new BrowserWindow({
    width: 1100,
    height: 780,
    show,
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // no preload, by design
    },
  });
  const wc = win.webContents;
  const info = { tag, closeRequested: false, closed: false, objections: 0 };
  win.__info = info;
  wc.setWindowOpenHandler(({ url: u }) => {
    log('window-open-denied', { tag, url: safeUrl(u) });
    return { action: 'deny' };
  });
  const guard = (ev, u) => {
    const host = (() => { try { return new URL(u).hostname; } catch { return ''; } })();
    const ok = originOf(u) && new URL(u).protocol === 'https:' && NAV_HOSTS.has(host);
    if (!ok) {
      log('navigation-denied', { tag, url: safeUrl(u) });
      ev.preventDefault();
    }
  };
  wc.on('will-navigate', (ev) => guard(ev, ev.url));
  wc.on('will-redirect', (ev) => guard(ev, ev.url));
  wc.on('did-navigate', (_e, u) => log('did-navigate', { tag, url: safeUrl(u) }));
  wc.on('did-fail-load', (_e, code, desc, u, isMain) => log('did-fail-load', { tag, code, desc, url: safeUrl(u), isMain }));
  wc.on('render-process-gone', (_e, d) => log('render-process-gone', { tag, ...d }));
  if (unloadMode !== 'none') wc.on('will-prevent-unload', (ev) => {
    info.objections += 1;
    log('will-prevent-unload', { tag, appInitiatedClose: info.closeRequested, mode: unloadMode });
    if (unloadMode === 'override') ev.preventDefault();
    if (typeof info.onObjection === 'function') info.onObjection(ev);
  });
  win.on('close', () => {
    info.closeRequested = true;
    log('window-close-event', { tag });
    setTimeout(() => {
      if (!win.isDestroyed()) log('STILL-OPEN-5s-AFTER-CLOSE (silent block of the close?)', { tag, objections: info.objections });
    }, 5000);
  });
  win.on('closed', () => {
    info.closed = true;
    log('window-closed', { tag, devices: devState() });
    setTimeout(() => log('devices+3s', devState()), 3000);
    setTimeout(() => log('devices+10s', devState()), 10000);
  });
  if (url) wc.loadURL(url).catch((e) => log('loadURL-rejected', { tag, message: String(e && e.message) }));
  return win;
}

// ---------- live mode ----------
function runLive(ses) {
  configureSession(ses);
  callWin = createCallWindow({ url: START_URL, unloadMode: UNLOAD });
  log('live-start', { url: safeUrl(START_URL), unload: UNLOAD, profile: PROFILE, userAgent: buildDesktopUserAgent(), devices: devState() });
  callWin.webContents.on('did-finish-load', async () => {
    try {
      const title = await callWin.webContents.executeJavaScript('document.title');
      log('page', { url: safeUrl(callWin.webContents.getURL()), title });
    } catch {}
  });
  app.on('window-all-closed', () => app.quit());
}

// ---------- auto mode ----------
const PROBE_HTML = `<!doctype html><title>probe</title><body>spike probe</body>`;
const UNLOAD_HTML = `<!doctype html><title>load#0</title><body>unload probe</body><script>
addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = 'x'; return 'x'; });
sessionStorage.n = (+(sessionStorage.n || 0)) + 1; document.title = 'load#' + sessionStorage.n;
</script>`;

function installProbeProtocol(ses) {
  // Serves two local pages UNDER real https://meet.google.com / https://accounts.google.com origins so
  // the permission handlers see the true origins. Everything else passes through to the network.
  ses.protocol.handle('https', (req) => {
    const u = new URL(req.url);
    if ((u.hostname === 'meet.google.com' || u.hostname === 'accounts.google.com') && u.pathname.startsWith('/__spike/')) {
      const html = u.pathname === '/__spike/unload' ? UNLOAD_HTML : PROBE_HTML;
      return new Response(html, { headers: { 'content-type': 'text/html' } });
    }
    return ses.fetch(req, { bypassCustomProtocolHandlers: true });
  });
}

const PROBE_JS = `(async () => {
  const out = {};
  const err = (e) => ({ name: e && e.name, message: String(e && e.message).slice(0, 160) });
  out.origin = location.origin;
  out.ua = navigator.userAgent;
  out.uaBrands = (navigator.userAgentData && navigator.userAgentData.brands || []).map(b => b.brand + '/' + b.version);
  for (const n of ['camera', 'microphone']) {
    try { out['permissions.query.' + n] = (await navigator.permissions.query({ name: n })).state; } catch (e) { out['permissions.query.' + n] = err(e); }
  }
  try { out.enumerateDevices = (await navigator.mediaDevices.enumerateDevices()).map(d => d.kind + ':' + (d.label ? 'labelled' : 'unlabelled')); } catch (e) { out.enumerateDevices = err(e); }
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    out.getUserMedia = s.getTracks().map(t => ({ kind: t.kind, label: t.label, readyState: t.readyState }));
    window.__s = s;
  } catch (e) { out.getUserMedia = err(e); }
  try {
    const a = await navigator.mediaDevices.getUserMedia({ audio: true });
    out.getUserMediaAudioOnly = a.getTracks().map(t => ({ kind: t.kind, label: t.label, readyState: t.readyState }));
    window.__a = a;
  } catch (e) { out.getUserMediaAudioOnly = err(e); }
  try { out.enumerateDevicesAfter = (await navigator.mediaDevices.enumerateDevices()).map(d => d.kind + ':' + (d.label ? 'labelled' : 'unlabelled')); } catch (e) { out.enumerateDevicesAfter = err(e); }
  return out;
})()`;

const DISPLAY_JS = `(async () => {
  try {
    const s = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const r = s.getTracks().map(t => ({ kind: t.kind, label: t.label, readyState: t.readyState, displaySurface: (t.getSettings() || {}).displaySurface }));
    s.getTracks().forEach(t => t.stop());
    return { ok: true, tracks: r };
  } catch (e) { return { ok: false, name: e && e.name, message: String(e && e.message).slice(0, 160) }; }
})()`;

async function waitPicker(ms = 40000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pickerWin && !pickerWin.isDestroyed() && !pickerWin.webContents.isLoading()) {
      await sleep(500);
      return pickerWin;
    }
    await sleep(100);
  }
  return null;
}

async function activate(win) {
  const wc = win.webContents;
  win.focus();
  wc.sendInputEvent({ type: 'mouseDown', x: 40, y: 40, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x: 40, y: 40, button: 'left', clickCount: 1 });
  await wc.executeJavaScript('0', true);
  return wc.executeJavaScript('navigator.userActivation.hasBeenActive');
}

async function observeClose(win, ms = 3500) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    if (win.isDestroyed()) return { closed: true, afterMs: Date.now() - t };
    await sleep(50);
  }
  return { closed: false };
}

async function unloadScenario(name, { activateFirst, listener, action }) {
  const win = createCallWindow({ url: `${MEET}/__spike/unload`, unloadMode: listener === 'none' ? 'none' : 'log', tag: name });
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  const activated = activateFirst ? await activate(win) : await win.webContents.executeJavaScript('navigator.userActivation.hasBeenActive');
  const seen = { objections: 0 };
  win.__info.onObjection = (ev) => {
    seen.objections += 1;
    if (listener === 'preventDefault') ev.preventDefault();
  };
  const r = await action(win, seen);
  if (!win.isDestroyed()) {
    r.titleAfter = await win.webContents.executeJavaScript('document.title').catch(() => null);
    win.destroy();
  }
  return { name, activated, listener, objectionsSeen: win.__info.objections, ...r };
}

async function runAuto(ses) {
  results.permissionNamesNote = 'see permissionLog';
  app.on('window-all-closed', () => {}); // keep the driver alive between scenario windows
  configureSession(ses);

  // Part 0: real Meet in a fresh/harness profile, before any interception is installed.
  log('auto-part0-real-meet', { profile: PROFILE, devices: devState() });
  callWin = createCallWindow({ url: START_URL, unloadMode: 'log', tag: 'real-meet' });
  await Promise.race([new Promise((r) => callWin.webContents.once('did-finish-load', r)), sleep(20000)]);
  await sleep(4000);
  const wc = callWin.webContents;
  const text = await wc.executeJavaScript('document.body ? document.body.innerText.slice(0, 300) : ""').catch(() => '');
  results.realMeet = {
    finalUrl: safeUrl(wc.getURL()),
    title: await wc.executeJavaScript('document.title').catch(() => null),
    textSnippet: text.replace(/\s+/g, ' '),
    redirectedToAccountsGoogle: /^https:\/\/accounts\.google\.com\//.test(wc.getURL()),
  };
  try {
    fs.writeFileSync(path.join(OUT, 'real-meet.png'), (await wc.capturePage()).toPNG());
  } catch {}
  log('auto-part0-result', results.realMeet);
  if (!callWin.isDestroyed()) callWin.destroy();
  saveResults();

  installProbeProtocol(ses);

  // Part 1: permissions + getUserMedia + display capture from the allowed origin.
  permissionLog.length = 0;
  callWin = createCallWindow({ url: `${MEET}/__spike/probe`, unloadMode: 'log', tag: 'probe-meet' });
  await new Promise((r) => callWin.webContents.once('did-finish-load', r));
  await activate(callWin);
  results.devicesBefore = devState();
  results.probeMeet = await callWin.webContents.executeJavaScript(PROBE_JS, true);
  await sleep(1500);
  results.devicesWhileCaptured = devState();
  saveResults();

  // display capture, explicit choice: the driver clicks the picker's first source button (simulated user click)
  let p;
  const shareVia = async (label, selector) => {
    const pr = callWin.webContents.executeJavaScript(DISPLAY_JS, true);
    const pw = await waitPicker();
    results['pickerShown_' + label] = !!pw;
    if (pw) {
      // No such source kind (e.g. Wayland session lists screens only): cancel instead of throwing.
      const hit = await pw.webContents.executeJavaScript(`(() => { const b = document.querySelector(${JSON.stringify(selector)}); if (b) b.click(); return !!b; })()`);
      results['sourceKindAvailable_' + label] = hit;
      if (!hit) await pw.webContents.executeJavaScript("document.getElementById('cancel').click()");
    }
    results['display_' + label] = await Promise.race([pr, sleep(20000).then(() => ({ timeout: true }))]);
  };
  await shareVia('screen', '[data-source^="screen:"]');
  await shareVia('window', '[data-source^="window:"]');
  results.pickerShownOnShareStart = results.pickerShown_screen;  // display capture, cancel
  p = callWin.webContents.executeJavaScript(DISPLAY_JS, true);
  const pw2 = await waitPicker();
  results.pickerShownSecondTime = !!pw2;
  if (pw2) await pw2.webContents.executeJavaScript("document.getElementById('cancel').click()");
  results.displayCancelled = await Promise.race([p, sleep(20000).then(() => ({ timeout: true }))]);
  // display capture with no user gesture
  p = callWin.webContents.executeJavaScript(DISPLAY_JS, false);
  const pw3 = await waitPicker();
  results.pickerShownWithoutUserGesture = !!pw3;
  if (pw3) await pw3.webContents.executeJavaScript("document.getElementById('cancel').click()");
  results.displayNoGesture = await Promise.race([p, sleep(20000).then(() => ({ timeout: true }))]);
  if (pickerWin && !pickerWin.isDestroyed()) pickerWin.destroy();
  saveResults();

  // Release: destroy the window that still holds camera+mic tracks.
  const beforeClose = devState();
  callWin.destroy();
  const rel = [];
  for (let i = 0; i < 12; i++) {
    await sleep(1000);
    rel.push({ tSec: i + 1, ...devState() });
  }
  results.release = { beforeClose, afterDestroy: rel };

  // Part 2: same probe from a non-meet origin must be denied.
  const accountsWin = createCallWindow({ url: 'https://accounts.google.com/__spike/probe', unloadMode: 'log', tag: 'probe-accounts' });
  await new Promise((r) => accountsWin.webContents.once('did-finish-load', r));
  await activate(accountsWin);
  results.probeAccounts = await accountsWin.webContents.executeJavaScript(PROBE_JS, true);
  accountsWin.destroy();
  results.permissionLog = permissionLog.slice();
  saveResults();

  // Part 3: close / unload mechanics with a stand-in page that has an unconditional beforeunload handler.
  results.unload = [];
  const S = results.unload;
  S.push(await unloadScenario('U0 close, NO user activation, no listener', { activateFirst: false, listener: 'none', action: async (w) => { w.close(); return observeClose(w); } }));
  S.push(await unloadScenario('U1 close, activated, NO will-prevent-unload listener', { activateFirst: true, listener: 'none', action: async (w) => { w.close(); return observeClose(w); } }));
  S.push(await unloadScenario('U2 close, activated, listener logs only', { activateFirst: true, listener: 'log', action: async (w) => { w.close(); return observeClose(w); } }));
  S.push(await unloadScenario('U3 close, activated, listener preventDefault', { activateFirst: true, listener: 'preventDefault', action: async (w) => { w.close(); return observeClose(w); } }));
  S.push(await unloadScenario('U4 webContents.close({waitForBeforeUnload}), activated, no listener', { activateFirst: true, listener: 'none', action: async (w) => { w.webContents.close({ waitForBeforeUnload: true }); return observeClose(w); } }));
  S.push(await unloadScenario('P1 page location.reload(), activated, no listener', { activateFirst: true, listener: 'none', action: async (w) => { w.webContents.executeJavaScript('location.reload()', true); await sleep(3500); return { windowOpen: !w.isDestroyed() }; } }));
  S.push(await unloadScenario('P2 page location.reload(), activated, listener preventDefault', { activateFirst: true, listener: 'preventDefault', action: async (w) => { w.webContents.executeJavaScript('location.reload()', true); await sleep(3500); return { windowOpen: !w.isDestroyed() }; } }));
  saveResults();

  // Part 4: quit with an objecting page. First no listener, then with a preventDefault listener.
  const q = createCallWindow({ url: `${MEET}/__spike/unload`, unloadMode: 'none', tag: 'quit-probe' });
  await new Promise((r) => q.webContents.once('did-finish-load', r));
  results.quitActivated = await activate(q);
  const ev = [];
  app.on('before-quit', () => ev.push('before-quit'));
  app.on('will-quit', () => ev.push('will-quit'));
  setTimeout(() => app.exit(0), 170000).unref(); // hard stop
  q.on('closed', () => ev.push('window-closed'));
  results.quit = { attempts: [] };
  app.quit();
  await sleep(4000);
  results.quit.attempts.push({ listener: 'none', events: ev.slice(), windowStillOpen: !q.isDestroyed(), processAlive: true });
  saveResults();
  if (!q.isDestroyed()) {
    q.webContents.on('will-prevent-unload', (e) => e.preventDefault());
    ev.length = 0;
    app.on('will-quit', () => {
      results.quit.attempts.push({ listener: 'preventDefault', events: ev.slice(), note: 'will-quit reached' });
      saveResults();
      setTimeout(() => process.exit(0), 500); // app.exit() was observed not to terminate the process after a completed quit
    });
    app.quit();
    await sleep(4000);
    results.quit.attempts.push({ listener: 'preventDefault', events: ev.slice(), windowStillOpen: !q.isDestroyed(), processAlive: true });
  }
  saveResults();
  log('auto-done', { file: path.join(OUT, 'auto-results.json') });
  app.exit(0);
}

app.whenReady().then(() => {
  const ses = session.fromPartition(PARTITION);
  (MODE === 'auto' ? runAuto(ses) : Promise.resolve(runLive(ses))).catch((e) => {
    log('FATAL', { message: String(e && e.stack) });
    app.exit(1);
  });
});
