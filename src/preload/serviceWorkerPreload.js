'use strict';

// Service-worker preload (BUG-01-B, BUG-05). Registered with
// `session.registerPreloadScript({ type: 'service-worker', ... })` - see
// src/main/serviceWorkerNotifications.js for the main-process half and the doc citations.
//
// Verified on Electron 44.4.3: this script runs in the worker's ISOLATED world (no
// `ServiceWorkerRegistration`, no `self`), with `require('electron')` giving `contextBridge`,
// `ipcRenderer`, `nativeImage`. To intercept the worker's own `registration.showNotification()`
// it must patch the MAIN world, which `contextBridge.executeInMainWorld` reaches.
//
// Surface: two narrow bridge functions, `__gcdSwBridge.show(payload)` and `.open(url)`, each
// sending one IPC channel. The patched showNotification does NOT call the original (which shows no
// toast in Electron and would double up if that ever changes) unless the bridge itself fails.
//
// BUG-05: because the original is never called the browser never owns the notification, so Chat's
// own `notificationclick` listener could not fire. Main now sends the toast's record back on click
// (CLICK_CHANNEL) and `replayClick` below dispatches a `notificationclick` event to the listeners
// Chat registered. Window-opening calls are not allowed outside a real click, so while a replay is
// active `clients.openWindow`, `WindowClient.focus` and `WindowClient.navigate` are answered here
// and the URL is handed to main (OPEN_CHANNEL), which opens it in the app. Outside a replay they
// are untouched.

const { contextBridge, ipcRenderer } = require('electron');

// ORIGIN GATE (docs/architecture/ipc-contract.md "Origin gating"): this preload is registered on the whole
// session, so it runs in the service worker of EVERY origin that session ever loads. It exposes the bridge
// and patches the worker only when the worker's own origin is the chat origin; otherwise it does nothing.
// (Main also refuses non-chat scopes - serviceWorkerNotifications.js - this is the second layer.)
//
// The preload's isolated world has no `self`/`location` (verified on 44.4.3: only `globalThis`, `process`
// and the electron modules), so the origin is read in the worker's MAIN world via
// `contextBridge.executeInMainWorld`, which returns the value (verified on 44.4.3; API:
// https://www.electronjs.org/docs/latest/api/context-bridge#contextbridgeexecuteinmainworldscript).
// `self.location` is the worker script's URL, fixed by the browser, and this runs before any worker
// script does, so the worker cannot have replaced it. A failed read means "not chat".
const CHAT_ORIGIN = 'https://chat.google.com';

function readWorkerOrigin() {
  try {
    return contextBridge.executeInMainWorld({ func: () => self.location.origin });
  } catch {
    return undefined;
  }
}

const CHANNEL = 'notification:sw-show';
const OPEN_CHANNEL = 'notification:sw-open';
const CLICK_CHANNEL = 'notification:sw-click';

// Everything below that goes through executeInMainWorld is serialised and must not use closure
// variables from this file.
function installPatches() {
  // 1) showNotification -> bridge (data kept, JSON-safe; never throws over uncloneable data).
  const proto = self.ServiceWorkerRegistration && self.ServiceWorkerRegistration.prototype;
  if (proto && typeof proto.showNotification === 'function' && !proto.__gcdPatched) {
    const original = proto.showNotification;
    proto.__gcdPatched = true;
    proto.showNotification = function (title, options) {
      try {
        const opts = options || {};
        const payload = {
          title: String(title),
          body: typeof opts.body === 'string' ? opts.body : '',
          silent: opts.silent === true,
          tag: typeof opts.tag === 'string' ? opts.tag : '',
        };
        try {
          if (opts.data !== undefined && opts.data !== null) payload.data = JSON.parse(JSON.stringify(opts.data));
        } catch (e) {
          // data that is not JSON-safe is dropped; the toast itself still goes out
        }
        self.__gcdSwBridge.show(payload);
        return Promise.resolve();
      } catch (err) {
        console.warn('[gcd-sw] bridge failed, falling back to the original showNotification', err);
        return original.call(this, title, options);
      }
    };
  }

  // 2) window-opening calls, answered only while a click replay is active.
  const replayActive = () => typeof self.__gcdSwReplayUntil === 'number' && Date.now() < self.__gcdSwReplayUntil;
  const resolveUrl = (u) => new URL(String(u), self.registration.scope).href;
  const hand = (u) => {
    try {
      self.__gcdSwBridge.open(resolveUrl(u));
    } catch (e) {
      console.warn('[gcd-sw] could not hand a URL to the app');
    }
  };
  const clientsProto = self.Clients && self.Clients.prototype;
  if (clientsProto && typeof clientsProto.openWindow === 'function' && !clientsProto.__gcdPatched) {
    const originalOpen = clientsProto.openWindow;
    clientsProto.__gcdPatched = true;
    clientsProto.openWindow = function (url) {
      if (!replayActive()) return originalOpen.apply(this, arguments);
      hand(url);
      return Promise.resolve(null);
    };
  }
  const wcProto = self.WindowClient && self.WindowClient.prototype;
  if (wcProto && !wcProto.__gcdPatched) {
    wcProto.__gcdPatched = true;
    if (typeof wcProto.focus === 'function') {
      const originalFocus = wcProto.focus;
      wcProto.focus = function () {
        if (!replayActive()) return originalFocus.apply(this, arguments);
        return Promise.resolve(this); // main focuses the window itself
      };
    }
    if (typeof wcProto.navigate === 'function') {
      const originalNavigate = wcProto.navigate;
      wcProto.navigate = function (url) {
        if (!replayActive()) return originalNavigate.apply(this, arguments);
        hand(url);
        return Promise.resolve(this);
      };
    }
  }
}

function replayClick(record) {
  try {
    const rec = record && typeof record === 'object' ? record : {};
    const notification = {
      title: typeof rec.title === 'string' ? rec.title : '',
      body: typeof rec.body === 'string' ? rec.body : '',
      tag: typeof rec.tag === 'string' ? rec.tag : '',
      data: rec.data === undefined ? null : rec.data,
      silent: null,
      actions: [],
      requireInteraction: false,
      timestamp: Date.now(),
      close() {},
    };
    const event = new self.ExtendableEvent('notificationclick');
    Object.defineProperty(event, 'notification', { value: notification });
    Object.defineProperty(event, 'action', { value: '' });
    Object.defineProperty(event, 'reply', { value: null });
    // A script-dispatched event is not "active", so the native waitUntil throws; the listener's
    // promises are simply allowed to run on.
    Object.defineProperty(event, 'waitUntil', { value: function () {} });
    self.__gcdSwReplayUntil = Date.now() + 10000;
    self.dispatchEvent(event);
  } catch (err) {
    console.warn('[gcd-sw] notificationclick replay failed', err && err.name);
  }
}

if (readWorkerOrigin() === CHAT_ORIGIN) try {
  contextBridge.exposeInMainWorld('__gcdSwBridge', {
    show: (payload) => ipcRenderer.send(CHANNEL, payload),
    open: (url) => ipcRenderer.send(OPEN_CHANNEL, url),
  });
  contextBridge.executeInMainWorld({ func: installPatches });
  ipcRenderer.on(CLICK_CHANNEL, (_event, record) => {
    contextBridge.executeInMainWorld({ func: replayClick, args: [record] });
  });
} catch (err) {
  // Never break the worker over a failed patch; the page-level bridge and the unread-count
  // fallback remain.
  console.error('[gcd-sw] service-worker preload failed', err);
}
