'use strict';

// UI-08 acceptance hook, TEST-ONLY. It is never part of the app: in-container.sh points the package.json "main" of
// the throwaway COPY of the repo (inside the container) at this file, so the repository's package.json and src/**
// are unchanged and production behaviour has no hook. Without GCD_E2E_HOOK=1 it just loads the app.
//
// What it does (observation plus one control channel):
//   - wraps Menu.buildFromTemplate to record every built menu and whether it was popped (the real popup still runs);
//   - records every `context-menu` event's params, every session `will-download` item, spellcheck events and any
//     dialog.showSaveDialog call;
//   - serves GET /state and POST /eval on 127.0.0.1:GCD_HOOK_PORT so the driver can send real input events to the
//     Chat window, read the clipboard and activate a menu item.

function install() {
  const electron = require('electron');
  const http = require('http');
  const { app, Menu, BrowserWindow, clipboard, dialog } = electron;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const state = { menus: [], popups: 0, contextEvents: [], downloads: [], items: [], dialogs: [], spell: [] };

  const describe = (i) => ({ label: i.label, role: i.role || null, type: i.type, enabled: i.enabled, visible: i.visible });
  const origBuild = Menu.buildFromTemplate.bind(Menu);
  Menu.buildFromTemplate = (template) => {
    const menu = origBuild(template);
    const rec = { id: state.menus.length, at: Date.now(), popped: false, menu, items: menu.items.map(describe) };
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
      state.contextEvents.push({
        at: Date.now(),
        isEditable: p.isEditable,
        misspelledWord: p.misspelledWord,
        dictionarySuggestions: p.dictionarySuggestions,
        mediaType: p.mediaType,
        hasImageContents: p.hasImageContents,
        linkURL: p.linkURL,
        srcURL: p.srcURL,
        selectionLength: (p.selectionText || '').length,
        editFlags: p.editFlags,
      });
    });
  });

  function ensureSpell(s) {
    if (process.env.GCD_DICT_URL) s.setSpellCheckerDictionaryDownloadURL(process.env.GCD_DICT_URL);
    s.setSpellCheckerLanguages(['en-US']);
    return s.getSpellCheckerLanguages();
  }

  const sessions = [];
  app.on('session-created', (s) => {
    sessions.push(s);
    for (const ev of ['initialized', 'download-begin', 'download-success', 'download-failure']) {
      const name = 'spellcheck-dictionary-' + ev;
      s.on(name, (_e, lang) => state.spell.push({ ev, lang, at: Date.now(), sid: sessions.indexOf(s) }));
    }
    try {
      ensureSpell(s);
    } catch {
      /* the driver calls ensureSpell again once the window exists */
    }
    s.on('will-download', (_e, item) => {
      const rec = { at: Date.now(), url: item.getURL(), filename: item.getFilename(), savePathAtEvent: item.getSavePath() };
      state.downloads.push(rec);
      state.items.push(item);
      // Read later: the app's own will-download listener (registered after this one) sets the save-dialog options.
      setTimeout(() => {
        try {
          rec.later = {
            savePath: item.getSavePath(),
            state: item.getState(),
            saveDialogOptions: item.getSaveDialogOptions(),
            receivedBytes: item.getReceivedBytes(),
          };
        } catch (err) {
          rec.laterError = err && err.message;
        }
      }, 1500);
    });
  });

  for (const k of ['showSaveDialog', 'showSaveDialogSync']) {
    dialog[k] = () => {
      state.dialogs.push({ api: k, at: Date.now() });
      return k.endsWith('Sync') ? undefined : Promise.resolve({ canceled: true, filePath: '' });
    };
  }

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
      ensureSpell,
      chatSid: () => (wc ? sessions.indexOf(wc.session) : -1),
      spellInfo: () => ({ sessions: sessions.length, enabled: wc.session.isSpellCheckerEnabled(), langs: wc.session.getSpellCheckerLanguages(), available: wc.session.availableSpellCheckerLanguages.slice(0, 5) }),
      /** Activates an item of the most recently popped menu, as a click on it would (never a disabled one). */
      clickItem(label) {
        const rec = [...state.menus].reverse().find((m) => m.popped);
        if (!rec) throw new Error('no popped menu');
        const item = rec.menu.items.find((i) => i.label === label);
        if (!item) throw new Error('no item "' + label + '"');
        if (!item.enabled) throw new Error('item "' + label + '" is disabled');
        item.click({}, BrowserWindow.fromWebContents(wc), wc);
        return true;
      },
      /** The tray menu's Exit item (the only quit path), activated like a tray click. */
      trayExit() {
        const rec = [...state.menus].reverse().find((m) => !m.popped && m.menu.items.some((i) => i.label === 'Exit'));
        if (!rec) throw new Error('no tray menu with Exit');
        const item = rec.menu.items.find((i) => i.label === 'Exit');
        setTimeout(() => item.click({}, undefined, undefined), 50);
        return true;
      },
    };
  }

  const snapshot = () => ({
    pid: process.pid,
    popups: state.popups,
    menus: state.menus.map(({ id, at, popped, items, popupError }) => ({ id, at, popped, items, popupError })),
    contextEvents: state.contextEvents,
    downloads: state.downloads,
    dialogs: state.dialogs,
    spell: state.spell,
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
