'use strict';
// Spike-only preload for the minimal source picker. Narrow surface: receive the source list,
// report one explicit choice or a cancel. The main process validates the sender.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('picker', {
  onSources: (cb) => ipcRenderer.on('picker:sources', (_e, sources) => cb(sources)),
  choose: (id) => ipcRenderer.send('picker:choose', String(id)),
  cancel: () => ipcRenderer.send('picker:cancel'),
});
