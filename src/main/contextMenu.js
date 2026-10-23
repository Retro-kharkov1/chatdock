'use strict';

// UI-08 / docs/architecture/browser-parity-gaps.md row 1, docs/architecture/context-menu.md. Electron draws no
// context menu of its own, so right-click in the composer, the search box and on images did nothing. This module
// builds a native popup menu from the contents' `context-menu` params in the main process: no page injection, no new
// IPC or preload surface, no permission change. Chromium emits `context-menu` only when the page did not
// preventDefault() the contextmenu event, so a page that draws its own menu (Chat message actions) never gets a
// second one from here.
//
// The menu never contains a quit, exit or close entry (project rule "Quit only from the tray"). Logging: outcome
// words only; never a URL, selected text, a misspelled word or a suggestion.
//
// buildContextMenuTemplate is pure (params + injected actions -> template); createContextMenu is the only part that
// touches Electron objects, and they are all injected, so both run under plain node:test.

const { copyableLinkUrl } = require('./smartCopy');

const MAX_SUGGESTIONS = 5;
const MAX_WORD_LENGTH = 128;

const LABELS = Object.freeze({
  noSuggestions: 'No spelling suggestions',
  addToDictionary: 'Add to dictionary',
  cut: 'Cut',
  copy: 'Copy',
  paste: 'Paste',
  selectAll: 'Select all',
  copyLink: 'Copy link',
  copyImage: 'Copy image',
  saveImage: 'Save image as...',
});

function nonEmptyString(value, max) {
  return typeof value === 'string' && value !== '' && value.length <= max;
}

function httpsUrl(value) {
  if (!nonEmptyString(value, 8192)) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function spellingSection(params, actions) {
  if (!params.isEditable || !nonEmptyString(params.misspelledWord, MAX_WORD_LENGTH)) return [];
  const suggestions = (Array.isArray(params.dictionarySuggestions) ? params.dictionarySuggestions : [])
    .filter((s) => nonEmptyString(s, MAX_WORD_LENGTH))
    .slice(0, MAX_SUGGESTIONS);
  const items = suggestions.length
    ? suggestions.map((s) => ({ label: s, click: () => actions.replaceMisspelling(s) }))
    : [{ label: LABELS.noSuggestions, enabled: false }];
  items.push({ type: 'separator' });
  items.push({ label: LABELS.addToDictionary, click: () => actions.addToDictionary(params.misspelledWord) });
  return items;
}

function editSection(params) {
  const flags = params.editFlags && typeof params.editFlags === 'object' ? params.editFlags : {};
  if (params.isEditable) {
    return [
      { role: 'cut', label: LABELS.cut, enabled: flags.canCut === true },
      { role: 'copy', label: LABELS.copy, enabled: flags.canCopy === true },
      { role: 'paste', label: LABELS.paste, enabled: flags.canPaste === true },
      { role: 'selectAll', label: LABELS.selectAll, enabled: flags.canSelectAll === true },
    ];
  }
  if (nonEmptyString(params.selectionText, Number.MAX_SAFE_INTEGER) && flags.canCopy === true) {
    return [{ role: 'copy', label: LABELS.copy }];
  }
  return [];
}

function linkSection(params, actions) {
  const url = copyableLinkUrl(params.linkURL); // same http/https/mailto + wrapper rules as the silent right-click copy
  return url === null ? [] : [{ label: LABELS.copyLink, click: () => actions.copyLink(url) }];
}

function imageSection(params, actions) {
  if (params.mediaType !== 'image') return [];
  const items = [];
  if (params.hasImageContents === true) {
    items.push({ label: LABELS.copyImage, click: () => actions.copyImage(params.x, params.y) });
  }
  if (httpsUrl(params.srcURL)) {
    const src = params.srcURL;
    items.push({ label: LABELS.saveImage, click: () => actions.saveImage(src) });
  }
  return items;
}

/**
 * buildContextMenuTemplate(params, actions) -> template (array, possibly empty). Pure; never throws.
 * actions: { replaceMisspelling(word), addToDictionary(word), copyLink(url), copyImage(x, y), saveImage(url) }.
 * Sections (spelling, edit, link, image) are separated by one separator; an empty result means "show no menu".
 */
function buildContextMenuTemplate(params, actions) {
  try {
    if (!params || typeof params !== 'object' || !actions) return [];
    const sections = [
      spellingSection(params, actions),
      editSection(params),
      linkSection(params, actions),
      imageSection(params, actions),
    ].filter((s) => s.length > 0);
    const template = [];
    sections.forEach((section, i) => {
      if (i > 0) template.push({ type: 'separator' });
      template.push(...section);
    });
    return template;
  } catch {
    return [];
  }
}

/**
 * createContextMenu({ Menu, BrowserWindow, clipboard, log }) -> { bindContextMenu(webContents) }
 * Binds one `context-menu` listener on the given contents (main window, Google app windows).
 */
function createContextMenu({ Menu, BrowserWindow, clipboard, log = () => {} }) {
  function bindContextMenu(webContents) {
    webContents.on('context-menu', (_event, params) => {
      try {
        if (webContents.isDestroyed()) return;
        const guard = (name, fn) => (...args) => {
          try {
            if (!webContents.isDestroyed()) fn(...args);
          } catch (err) {
            log('[gcd] contextmenu action failed: ' + name, err && err.name);
          }
        };
        const actions = {
          replaceMisspelling: guard('replace', (word) => webContents.replaceMisspelling(word)),
          addToDictionary: guard('dictionary', (word) => webContents.session.addWordToSpellCheckerDictionary(word)),
          copyLink: guard('copy-link', (url) => clipboard.writeText(url)),
          copyImage: guard('copy-image', (x, y) => webContents.copyImageAt(x, y)),
          // Goes through the session's existing will-download handler (save dialog, scheme / host rules).
          saveImage: guard('save-image', (url) => webContents.downloadURL(url)),
        };
        const template = buildContextMenuTemplate(params, actions);
        if (template.length === 0) return;
        const window = BrowserWindow.fromWebContents(webContents);
        if (!window || window.isDestroyed()) return;
        Menu.buildFromTemplate(template).popup({ window });
        log('[gcd] contextmenu shown');
      } catch (err) {
        log('[gcd] contextmenu failed', err && err.name);
      }
    });
  }
  return { bindContextMenu };
}

module.exports = { buildContextMenuTemplate, createContextMenu, LABELS };
