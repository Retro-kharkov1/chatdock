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

  // 3) BUG-05 attempt 2 DIAGNOSTICS (temporary, see src/main/diagLog.js). Only event names, counts and
  // redacted URL paths go to the console - never message text, titles or ids. Each line is picked up
  // by the main process through the `[gcd-sw]` console prefix.
  if (!self.__gcdDiagInstalled) {
    self.__gcdDiagInstalled = true;
    const KNOWN = ['', 'room', 'dm', 'space', 'chat', 'app', 'u', 'mole', 'thread', 'frame', 'api', 'home', 'welcome'];
    const d = (msg) => {
      try {
        console.log('[gcd-sw] diag ' + msg);
      } catch (e) {
        // never break the worker
      }
    };
    const redact = (u) => {
      try {
        const x = new URL(String(u), self.registration.scope);
        const keys = [];
        x.searchParams.forEach((_v, k) => keys.push(k));
        return x.origin + x.pathname.split('/').map((s) => (KNOWN.indexOf(s) !== -1 ? s : ':id')).join('/') +
          (keys.length ? '?' + keys.slice(0, 8).join('&') : '') + (x.hash ? '#frag' : '');
      } catch (e) {
        return '<unparseable>';
      }
    };
    const shape = (v, depth) => {
      if (v === null) return 'null';
      const t = typeof v;
      if (t === 'string') return /^(https?:\/\/|\/)/.test(v) ? 'url(' + redact(v) + ')' : 'str(' + v.length + ')';
      if (t !== 'object') return t;
      if (depth >= 3) return '{...}';
      if (Array.isArray(v)) return '[' + v.length + ']';
      return '{' + Object.keys(v).slice(0, 12).map((k) => k.slice(0, 24) + ':' + shape(v[k], depth + 1)).join(',') + '}';
    };
    self.__gcdDiag = { d, redact, shape };
    const active = () => typeof self.__gcdSwReplayUntil === 'number' && Date.now() < self.__gcdSwReplayUntil;
    self.__gcdListenerCount = 0;
    const origAdd = self.addEventListener;
    if (typeof origAdd === 'function') {
      self.addEventListener = function (type) {
        if (type === 'notificationclick') {
          self.__gcdListenerCount += 1;
          d('listener added type=notificationclick total=' + self.__gcdListenerCount);
        }
        return origAdd.apply(this, arguments);
      };
    }
    if (clientsProto && typeof clientsProto.matchAll === 'function') {
      const origMatch = clientsProto.matchAll;
      clientsProto.matchAll = function (opts) {
        const p = origMatch.apply(this, arguments);
        if (active()) {
          d('clients.matchAll during replay');
          try {
            p.then((list) => d('clients.matchAll resolved count=' + (list ? list.length : -1)), () => d('clients.matchAll rejected'));
          } catch (e) {
            // diagnostics only
          }
        }
        return p;
      };
    }
    const clientProto = self.Client && self.Client.prototype;
    if (clientProto && typeof clientProto.postMessage === 'function') {
      const origPost = clientProto.postMessage;
      clientProto.postMessage = function (msg) {
        if (active()) d('client.postMessage during replay shape=' + shape(msg, 0));
        return origPost.apply(this, arguments);
      };
    }
    // observe focus/navigate/openWindow reaching the (already patched) methods
    if (clientsProto && typeof clientsProto.openWindow === 'function') {
      const patchedOpen = clientsProto.openWindow;
      clientsProto.openWindow = function (url) {
        d('clients.openWindow called replay=' + active() + ' url=' + redact(url));
        return patchedOpen.apply(this, arguments);
      };
    }
    if (wcProto && typeof wcProto.focus === 'function') {
      const patchedFocus = wcProto.focus;
      wcProto.focus = function () {
        d('windowClient.focus called replay=' + active());
        return patchedFocus.apply(this, arguments);
      };
    }
    if (wcProto && typeof wcProto.navigate === 'function') {
      const patchedNav = wcProto.navigate;
      wcProto.navigate = function (url) {
        d('windowClient.navigate called replay=' + active() + ' url=' + redact(url));
        return patchedNav.apply(this, arguments);
      };
    }
    self.addEventListener('error', function (e) {
      if (active()) d('worker error during replay name=' + (e && e.error && e.error.name));
    });
    self.addEventListener('unhandledrejection', function (e) {
      if (active()) d('unhandled rejection during replay name=' + (e && e.reason && e.reason.name));
    });
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
    const dg = self.__gcdDiag;
    if (dg) {
      dg.d('replay start listeners=' + self.__gcdListenerCount + ' onnotificationclick=' + (typeof self.onnotificationclick) +
        ' dataShape=' + dg.shape(notification.data, 0) + ' tagLen=' + notification.tag.length);
    }
    self.dispatchEvent(event);
    if (dg) dg.d('replay dispatched');
  } catch (err) {
    console.warn('[gcd-sw] notificationclick replay failed', err && err.name);
  }
}

try {
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
