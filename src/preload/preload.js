'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The complete IPC surface — see docs/architecture/ipc-contract.md. Nothing beyond these three
// fire-and-forget senders is exposed to the renderer, per the Electron security baseline (docs/architecture/project-rules.md) -
// never expose `ipcRenderer` itself. `notificationClicked` is a
// fire-and-forget send: the notification-click wrapper injected into the page's main world (see
// docs/architecture/notifications.md piece 2) calls `window.__gcdBridge.notificationClicked()`
// when Chat's own page code fires a `click` event on a notification this app created. The main
// process responds by showing/focusing the window — no return value is needed here.
contextBridge.exposeInMainWorld('__gcdBridge', {
  notificationClicked: () => ipcRenderer.send('notification:clicked'),
  // BUG-01: the page made its own native toast (window.Notification) - only an arrival signal.
  notificationArrived: () => ipcRenderer.send('notification:arrived'),
  // BUG-01-B: a page-initiated ServiceWorkerRegistration.showNotification, which Electron does not
  // display; main re-raises it as a native toast. Payload is sanitised main-side.
  notificationShow: (payload) => ipcRenderer.send('notification:show', payload),
});
