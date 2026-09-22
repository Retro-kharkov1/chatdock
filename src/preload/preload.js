'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The complete IPC surface — see docs/architecture/ipc-contract.md. Nothing beyond this one
// function is exposed to the renderer, per the space's `electron-security-baseline` rule and
// `electron-desktop.md` §2 (never expose `ipcRenderer` itself). `notificationClicked` is a
// fire-and-forget send: the notification-click wrapper injected into the page's main world (see
// docs/architecture/notifications.md piece 2) calls `window.__gcdBridge.notificationClicked()`
// when Chat's own page code fires a `click` event on a notification this app created. The main
// process responds by showing/focusing the window — no return value is needed here.
contextBridge.exposeInMainWorld('__gcdBridge', {
  notificationClicked: () => ipcRenderer.send('notification:clicked'),
});
