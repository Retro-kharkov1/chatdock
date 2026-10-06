'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The Settings window's own, separate bridge — docs/architecture/ipc-contract.md "Settings
// window". Deliberately never merged into preload.js (the main window's bridge, reachable by
// chat.google.com, a third-party origin this app does not control). This preload only ever runs
// against this app's own local, bundled HTML — no remote content ever loads in this window.
contextBridge.exposeInMainWorld('__gcdSettingsBridge', {
  getAll: () => ipcRenderer.invoke('settings:get'),
  set: (key, value) => ipcRenderer.invoke('settings:set', { key, value }),
  // BUG-06: one-way, number only; main validates and clamps it (never trusts the value).
  reportContentHeight: (height) => ipcRenderer.send('settings:content-height', height),
  // UI-06: no arguments, no payload; main checks the sender and opens the Help window.
  openHelp: () => ipcRenderer.send('settings:open-help'),
  onChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('settings:changed', listener);
    return () => ipcRenderer.removeListener('settings:changed', listener);
  },
});
