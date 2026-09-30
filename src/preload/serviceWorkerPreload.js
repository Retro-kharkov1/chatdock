'use strict';

// Service-worker preload (BUG-01-B). Registered with
// `session.registerPreloadScript({ type: 'service-worker', ... })` - see
// src/main/serviceWorkerNotifications.js for the main-process half and the doc citations.
//
// Verified on Electron 44.4.3: this script runs in the worker's ISOLATED world (no
// `ServiceWorkerRegistration`, no `self`), with `require('electron')` giving `contextBridge`,
// `ipcRenderer`, `nativeImage`. To intercept the worker's own `registration.showNotification()`
// it must patch the MAIN world, which `contextBridge.executeInMainWorld` reaches.
//
// Surface: one narrow bridge function, `__gcdSwBridge.show(payload)`, sending one IPC channel.
// The patched showNotification does NOT call the original (which shows no toast in Electron and
// would double up if that ever changes) unless the bridge itself fails.

const { contextBridge, ipcRenderer } = require('electron');

const CHANNEL = 'notification:sw-show';

try {
  contextBridge.exposeInMainWorld('__gcdSwBridge', {
    show: (payload) => ipcRenderer.send(CHANNEL, payload),
  });

  contextBridge.executeInMainWorld({
    func: () => {
      const proto = self.ServiceWorkerRegistration && self.ServiceWorkerRegistration.prototype;
      if (!proto || typeof proto.showNotification !== 'function' || proto.__gcdPatched) return;
      const original = proto.showNotification;
      proto.__gcdPatched = true;
      proto.showNotification = function (title, options) {
        try {
          const opts = options || {};
          self.__gcdSwBridge.show({
            title: String(title),
            body: typeof opts.body === 'string' ? opts.body : '',
            silent: opts.silent === true,
            tag: typeof opts.tag === 'string' ? opts.tag : '',
          });
          return Promise.resolve();
        } catch (err) {
          console.warn('[gcd-sw] bridge failed, falling back to the original showNotification', err);
          return original.call(this, title, options);
        }
      };
    },
  });
} catch (err) {
  // Never break the worker over a failed patch; the page-level bridge and the unread-count
  // fallback remain.
  console.error('[gcd-sw] service-worker preload failed', err);
}
