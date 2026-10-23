'use strict';

// BUG-10 reload acceptance hook, TEST-ONLY. in-container.sh points the package.json "main" of the throwaway COPY of the
// repo (inside the container) at this file; the repository's package.json and src/** are unchanged. Without
// GCD_E2E_HOOK=1 it just loads the app. It records, for the MAIN window (the first BrowserWindow created): every
// loadURL / reload / reloadIgnoringCache call on its webContents (tagged 'driver' while the driver is the caller, else
// 'app'), and every did-fail-load / did-finish-load. It serves GET /state and POST /eval on 127.0.0.1:GCD_HOOK_PORT.
// Only host + path of a URL is recorded (no query, no cookie, no credential).

function install() {
  const electron = require('electron');
  const http = require('http');
  const { app } = electron;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const t0 = Date.now();
  const state = { loads: [], events: [], driverCaller: false };
  let win = null;

  const hostPath = (u) => {
    try {
      const p = new URL(u);
      return p.protocol + '//' + p.host + p.pathname;
    } catch {
      return String(u).slice(0, 40);
    }
  };

  app.on('browser-window-created', (_e, w) => {
    if (win) return;
    win = w;
    const wc = w.webContents;
    const by = () => (state.driverCaller ? 'driver' : 'app');
    const origLoad = wc.loadURL.bind(wc);
    wc.loadURL = (u, o) => {
      state.loads.push({ t: Date.now() - t0, kind: 'loadURL', url: hostPath(u), by: by() });
      return origLoad(u, o);
    };
    const origReload = wc.reload.bind(wc);
    wc.reload = () => {
      state.loads.push({ t: Date.now() - t0, kind: 'reload', by: by() });
      return origReload();
    };
    const origHard = wc.reloadIgnoringCache.bind(wc);
    wc.reloadIgnoringCache = () => {
      state.loads.push({ t: Date.now() - t0, kind: 'reloadIgnoringCache', by: by() });
      return origHard();
    };
    wc.on('did-fail-load', (_ev, code, desc, url, isMainFrame) => {
      state.events.push({ t: Date.now() - t0, ev: 'fail', code, desc, url: hostPath(url), isMainFrame });
    });
    wc.on('did-finish-load', () => {
      state.events.push({ t: Date.now() - t0, ev: 'finish', url: hostPath(wc.getURL()) });
    });
  });

  const ctxFor = () => ({
    electron,
    app,
    sleep,
    win,
    wc: win && !win.isDestroyed() ? win.webContents : null,
    state,
    hostPath,
    /** Run fn with loads tagged 'driver'. */
    asDriver(fn) {
      state.driverCaller = true;
      try {
        return fn();
      } finally {
        state.driverCaller = false;
      }
    },
  });

  const snapshot = () => ({
    pid: process.pid,
    hasWindow: !!win,
    destroyed: win ? win.isDestroyed() : null,
    now: Date.now() - t0,
    loads: state.loads,
    events: state.events,
  });

  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const server = http.createServer((req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj === undefined ? null : obj));
    };
    if (req.method === 'GET' && req.url === '/state') return send(200, snapshot());
    if (req.method === 'POST' && req.url === '/eval') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        try {
          const { code } = JSON.parse(body);
          const result = await new AsyncFunction('ctx', code)(ctxFor());
          send(200, { result: result === undefined ? null : result });
        } catch (err) {
          send(200, { error: String((err && err.message) || err) });
        }
      });
      return;
    }
    send(404, { error: 'not found' });
  });
  server.listen(Number(process.env.GCD_HOOK_PORT), '127.0.0.1');
}

// Plain node (node --test scanning test/) has no Electron: do nothing.
if (process.versions.electron) {
  if (process.env.GCD_E2E_HOOK === '1') install();
  require('../../../src/main/index.js');
}
