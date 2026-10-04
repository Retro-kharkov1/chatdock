'use strict';

// Preload for the harness CONTROL window only (a local file, never a Google page).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('harness', {
  open: (url) => ipcRenderer.invoke('harness:open', url),
  mark: (text) => ipcRenderer.invoke('harness:mark', text),
  chat: () => ipcRenderer.invoke('harness:chat'),
  info: () => ipcRenderer.invoke('harness:info'),
});
