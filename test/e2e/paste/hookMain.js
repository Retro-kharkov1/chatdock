'use strict';

// BUG-11 paste acceptance hook, TEST-ONLY. in-container.sh points the package.json "main" of the throwaway COPY of
// the repo (inside the container) at this file; the repository's package.json and src/** are unchanged. Without
// GCD_E2E_HOOK=1 it just loads the app. It records built/popped menus (so the UI-08 context-menu Paste can be
// activated like a click) and serves GET /state and POST /eval on 127.0.0.1:GCD_HOOK_PORT for the driver.

function install() {
  const electron = require('electron');
  const http = require('http');
  const { app, Menu, BrowserWindow, clipboard } = electron;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const state = { menus: [], popups: 0, contextEvents: [] };

  const origBuild = Menu.buildFromTemplate.bind(Menu);
  Menu.buildFromTemplate = (template) => {
    const menu = origBuild(template);
    const rec = {
      id: state.menus.length,
      popped: false,
      menu,
      items: menu.items.map((i) => ({ label: i.label, role: i.role || null, type: i.type, enabled: i.enabled })),
    };
    state.menus.push(rec);
    const origPopup = menu.popup.bind(menu);
    menu.popup = (opts) => {
      rec.popped = true;
      state.popups += 1;
      try {
        origPopup(opts);
      } catch (err) {
        rec.popupError = err && err.name;
      }
      setTimeout(() => {
        try {
          menu.closePopup();
        } catch {
          /* already closed */
        }
      }, 300);
    };
    return menu;
  };

  app.on('web-contents-created', (_e, wc) => {
    wc.on('context-menu', (_ev, p) => {
      state.contextEvents.push({ isEditable: p.isEditable, editFlags: p.editFlags });
    });
  });

  const chatContents = () =>
    electron.webContents.getAllWebContents().find((w) => !w.isDestroyed() && /^https:\/\/chat\.google\.com/.test(w.getURL())) || null;

  function ctxFor() {
    const wc = chatContents();
    return {
      electron,
      app,
      clipboard,
      wc,
      state,
      sleep,
      clickItem(label) {
        const rec = [...state.menus].reverse().find((m) => m.popped);
        if (!rec) throw new Error('no popped menu');
        const item = rec.menu.items.find((i) => i.label === label);
        if (!item) throw new Error('no item "' + label + '"');
        if (!item.enabled) throw new Error('item "' + label + '" is disabled');
        item.click({}, BrowserWindow.fromWebContents(wc), wc);
        return true;
      },
    };
  }

  const snapshot = () => ({
    pid: process.pid,
    popups: state.popups,
    menus: state.menus.map(({ id, popped, items, popupError }) => ({ id, popped, items, popupError })),
    contextEvents: state.contextEvents,
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
