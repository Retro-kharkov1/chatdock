'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The screen-share picker's own bridge (docs/architecture/ipc-contract.md "Screen-share picker
// window"). Exactly three functions, never merged into another window's preload, never exposing
// ipcRenderer itself. It only ever runs against this app's bundled local picker document.
contextBridge.exposeInMainWorld('__gcdPickerBridge', {
  getSources: () => ipcRenderer.invoke('picker:get-sources'),
  choose: (sourceId) => ipcRenderer.invoke('picker:choose', { sourceId }),
  cancel: () => ipcRenderer.send('picker:cancel'),
});
