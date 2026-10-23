const { contextBridge, webFrame } = require('electron');
contextBridge.exposeInMainWorld('spellProbe', {
  isMisspelled: (w) => webFrame.isWordMisspelled(w),
  suggestions: (w) => webFrame.getWordSuggestions(w),
});
