'use strict';

// UI-08: native right-click menu (docs/architecture/context-menu.md). buildContextMenuTemplate is a pure function
// from `context-menu` params to a menu template; createContextMenu binds it to a contents with every Electron
// object injected.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { buildContextMenuTemplate, createContextMenu, LABELS } = require('../src/main/contextMenu');

const ALL_FLAGS = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true };

function recorder() {
  const calls = [];
  const actions = {
    replaceMisspelling: (w) => calls.push(['replace', w]),
    addToDictionary: (w) => calls.push(['dict', w]),
    copyLink: (u) => calls.push(['link', u]),
    copyImage: (x, y) => calls.push(['copyImage', x, y]),
    saveImage: (u) => calls.push(['save', u]),
  };
  return { calls, actions };
}

const labels = (t) => t.map((i) => i.label ?? (i.type === 'separator' ? '|' : i.role));
const build = (params) => {
  const r = recorder();
  return { template: buildContextMenuTemplate(params, r.actions), ...r };
};

test('editable field: Cut/Copy/Paste/Select all enabled exactly per editFlags', () => {
  const { template } = build({ isEditable: true, editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true } });
  assert.deepEqual(labels(template), [LABELS.cut, LABELS.copy, LABELS.paste, LABELS.selectAll]);
  assert.deepEqual(template.map((i) => i.enabled), [false, false, true, true]);
  assert.deepEqual(template.map((i) => i.role), ['cut', 'copy', 'paste', 'selectAll']);
});

test('editable field with missing or non-boolean flags: everything disabled, still a menu', () => {
  const { template } = build({ isEditable: true });
  assert.equal(template.length, 4);
  assert.ok(template.every((i) => i.enabled === false));
  const t2 = build({ isEditable: true, editFlags: { canCut: 'yes', canCopy: 1 } }).template;
  assert.ok(t2.every((i) => i.enabled === false));
});

test('misspelled word in an editable field: suggestions (max 5), separator, Add to dictionary, then edit items', () => {
  const { template, calls } = build({
    isEditable: true,
    editFlags: ALL_FLAGS,
    misspelledWord: 'teh',
    dictionarySuggestions: ['the', 'ten', 'tea', 'tech', 'tehr', 'sixth'],
  });
  assert.deepEqual(labels(template).slice(0, 8), ['the', 'ten', 'tea', 'tech', 'tehr', '|', LABELS.addToDictionary, '|']);
  assert.ok(!labels(template).includes('sixth'));
  template[0].click();
  template.find((i) => i.label === LABELS.addToDictionary).click();
  assert.deepEqual(calls, [['replace', 'the'], ['dict', 'teh']]);
});

test('misspelled word without suggestions: disabled placeholder plus Add to dictionary', () => {
  const { template } = build({ isEditable: true, editFlags: ALL_FLAGS, misspelledWord: 'qzx', dictionarySuggestions: [] });
  assert.equal(template[0].label, LABELS.noSuggestions);
  assert.equal(template[0].enabled, false);
  assert.equal(template[0].click, undefined);
  assert.equal(template[2].label, LABELS.addToDictionary);
});

test('spelling items need an editable field; junk suggestions are dropped', () => {
  assert.deepEqual(build({ isEditable: false, misspelledWord: 'teh', dictionarySuggestions: ['the'] }).template, []);
  const { template } = build({ isEditable: true, editFlags: ALL_FLAGS, misspelledWord: 'teh', dictionarySuggestions: ['ok', '', 5, null, 'x'.repeat(500)] });
  assert.equal(template[0].label, 'ok');
  assert.equal(template[1].type, 'separator');
});

test('non-editable selection: only Copy; no selection: nothing', () => {
  const sel = build({ isEditable: false, selectionText: 'hello', editFlags: ALL_FLAGS }).template;
  assert.deepEqual(labels(sel), [LABELS.copy]);
  assert.equal(sel[0].role, 'copy');
  assert.deepEqual(build({ isEditable: false, selectionText: '', editFlags: ALL_FLAGS }).template, []);
  assert.deepEqual(build({ isEditable: false, selectionText: 'x', editFlags: { canCopy: false } }).template, []);
});

test('link: Copy link writes the filtered URL (wrapper unwrapped); bad scheme gives no item', () => {
  const direct = build({ linkURL: 'https://example.com/a' });
  assert.deepEqual(labels(direct.template), [LABELS.copyLink]);
  direct.template[0].click();
  const wrapped = build({ linkURL: 'https://www.google.com/url?q=https%3A%2F%2Fexample.org%2Fx' });
  wrapped.template[0].click();
  assert.deepEqual(direct.calls, [['link', 'https://example.com/a']]);
  assert.deepEqual(wrapped.calls, [['link', 'https://example.org/x']]);
  for (const linkURL of ['javascript:alert(1)', 'tel:123', 'file:///c:/x', '', undefined, 5]) {
    assert.deepEqual(build({ linkURL }).template, [], String(linkURL));
  }
});

test('image: Copy image at the click point, Save image only for https sources', () => {
  const ok = build({ mediaType: 'image', hasImageContents: true, srcURL: 'https://lh3.googleusercontent.com/a', x: 12, y: 34 });
  assert.deepEqual(labels(ok.template), [LABELS.copyImage, LABELS.saveImage]);
  ok.template[0].click();
  ok.template[1].click();
  assert.deepEqual(ok.calls, [['copyImage', 12, 34], ['save', 'https://lh3.googleusercontent.com/a']]);

  const blob = build({ mediaType: 'image', hasImageContents: true, srcURL: 'blob:https://chat.google.com/abc' });
  assert.deepEqual(labels(blob.template), [LABELS.copyImage]);
  const data = build({ mediaType: 'image', hasImageContents: false, srcURL: 'data:image/png;base64,AAAA' });
  assert.deepEqual(data.template, []);
  const http = build({ mediaType: 'image', hasImageContents: true, srcURL: 'http://example.com/a.png' });
  assert.deepEqual(labels(http.template), [LABELS.copyImage]);
  assert.deepEqual(build({ mediaType: 'video', hasImageContents: true, srcURL: 'https://e.com/v' }).template, []);
});

test('sections are separated by exactly one separator, never leading, trailing or doubled', () => {
  const { template } = build({
    isEditable: false,
    selectionText: 'x',
    editFlags: ALL_FLAGS,
    linkURL: 'https://example.com/',
    mediaType: 'image',
    hasImageContents: true,
    srcURL: 'https://example.com/i.png',
  });
  assert.deepEqual(labels(template), [LABELS.copy, '|', LABELS.copyLink, '|', LABELS.copyImage, LABELS.saveImage]);
});

test('nothing to offer: empty template for plain page, empty params, junk input; never throws', () => {
  assert.deepEqual(build({}).template, []);
  assert.deepEqual(build({ isEditable: false, mediaType: 'none' }).template, []);
  for (const bad of [null, undefined, 5, 'x']) assert.deepEqual(buildContextMenuTemplate(bad, recorder().actions), []);
  assert.deepEqual(buildContextMenuTemplate({ isEditable: true }, null), []);
  const hostile = { get isEditable() { throw new Error('boom'); } };
  assert.deepEqual(buildContextMenuTemplate(hostile, recorder().actions), []);
});

test('no quit, exit or close entry in any template (quit-only-from-tray)', () => {
  const { template } = build({
    isEditable: true,
    editFlags: ALL_FLAGS,
    misspelledWord: 'teh',
    dictionarySuggestions: ['the'],
    linkURL: 'https://example.com/',
    mediaType: 'image',
    hasImageContents: true,
    srcURL: 'https://example.com/i.png',
  });
  for (const item of template) {
    assert.ok(!['quit', 'close', 'minimize', 'reload', 'forceReload', 'toggleDevTools'].includes(item.role), String(item.role));
    assert.ok(!/quit|exit|close/i.test(item.label || ''), String(item.label));
  }
  const src = fs.readFileSync(path.join(__dirname, '../src/main/contextMenu.js'), 'utf8');
  assert.ok(!/role:\s*'(quit|close)'|app\.quit|process\.exit/.test(src));
});

function fakeContents() {
  const wc = new EventEmitter();
  wc.destroyed = false;
  wc.calls = [];
  wc.isDestroyed = () => wc.destroyed;
  wc.replaceMisspelling = (w) => wc.calls.push(['replace', w]);
  wc.copyImageAt = (x, y) => wc.calls.push(['copyImageAt', x, y]);
  wc.downloadURL = (u) => wc.calls.push(['downloadURL', u]);
  wc.session = { addWordToSpellCheckerDictionary: (w) => wc.calls.push(['dict', w]) };
  return wc;
}

function harness({ windowGone = false } = {}) {
  const popups = [];
  const logs = [];
  const clip = [];
  const win = { isDestroyed: () => false };
  const Menu = {
    buildFromTemplate: (template) => ({ template, popup: (opts) => popups.push({ template, opts }) }),
  };
  const BrowserWindow = { fromWebContents: () => (windowGone ? null : win) };
  const api = createContextMenu({ Menu, BrowserWindow, clipboard: { writeText: (t) => clip.push(t) }, log: (...a) => logs.push(a.join(' ')) });
  const wc = fakeContents();
  api.bindContextMenu(wc);
  return { wc, popups, logs, clip, win };
}

test('binder: shows one popup on the contents window and does not preventDefault', () => {
  const h = harness();
  let prevented = false;
  h.wc.emit('context-menu', { preventDefault: () => (prevented = true) }, { isEditable: true, editFlags: ALL_FLAGS });
  assert.equal(h.popups.length, 1);
  assert.equal(h.popups[0].opts.window, h.win);
  assert.equal(prevented, false);
  assert.deepEqual(h.logs, ['[gcd] contextmenu shown']);
});

test('binder: no popup when there is nothing to offer, the window is gone or the contents is destroyed', () => {
  const h = harness();
  h.wc.emit('context-menu', {}, { isEditable: false });
  assert.equal(h.popups.length, 0);
  h.wc.destroyed = true;
  h.wc.emit('context-menu', {}, { isEditable: true, editFlags: ALL_FLAGS });
  assert.equal(h.popups.length, 0);
  const g = harness({ windowGone: true });
  g.wc.emit('context-menu', {}, { isEditable: true, editFlags: ALL_FLAGS });
  assert.equal(g.popups.length, 0);
  assert.doesNotThrow(() => g.wc.emit('context-menu', {}, undefined));
});

test('binder: actions reach the contents; Save image uses downloadURL (the session will-download path)', () => {
  const h = harness();
  h.wc.emit('context-menu', {}, {
    isEditable: true,
    editFlags: ALL_FLAGS,
    misspelledWord: 'teh',
    dictionarySuggestions: ['the'],
    linkURL: 'https://example.com/',
    mediaType: 'image',
    hasImageContents: true,
    srcURL: 'https://example.com/i.png',
    x: 1,
    y: 2,
  });
  const t = h.popups[0].template;
  for (const label of ['the', LABELS.addToDictionary, LABELS.copyLink, LABELS.copyImage, LABELS.saveImage]) {
    t.find((i) => i.label === label).click();
  }
  assert.deepEqual(h.wc.calls, [
    ['replace', 'the'],
    ['dict', 'teh'],
    ['copyImageAt', 1, 2],
    ['downloadURL', 'https://example.com/i.png'],
  ]);
  assert.deepEqual(h.clip, ['https://example.com/']);
});

test('binder: a throwing action is contained and logged without content', () => {
  const h = harness();
  h.wc.downloadURL = () => {
    throw new TypeError('secret-url-in-message');
  };
  h.wc.emit('context-menu', {}, { mediaType: 'image', hasImageContents: false, srcURL: 'https://example.com/i.png' });
  assert.doesNotThrow(() => h.popups[0].template[0].click());
  const joined = h.logs.join('\n');
  assert.match(joined, /action failed: save-image TypeError/);
  assert.ok(!joined.includes('secret-url') && !joined.includes('example.com'));
});

test('logging never carries the word, suggestions, link, image URL or selection', () => {
  const h = harness();
  h.wc.emit('context-menu', {}, {
    isEditable: true,
    editFlags: ALL_FLAGS,
    misspelledWord: 'privateword',
    dictionarySuggestions: ['suggestion1'],
    selectionText: 'topsecret',
    linkURL: 'https://example.com/token=abc',
  });
  h.popups[0].template.find((i) => i.label === 'suggestion1').click();
  const joined = h.logs.join('\n');
  for (const s of ['privateword', 'suggestion1', 'topsecret', 'token=abc']) assert.ok(!joined.includes(s), s);
});

test('wiring: googleAppWindow binds the optional hook once per window and works without it', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main/googleAppWindow.js'), 'utf8');
  assert.equal((src.match(/bindContextMenu\(contents\)/g) || []).length, 1);
  assert.match(src, /typeof bindContextMenu === 'function'/);
});

test('wiring: index.js binds the main window and the Google app windows; call, settings, picker and help windows do not', () => {
  const idx = fs.readFileSync(path.join(__dirname, '../src/main/index.js'), 'utf8');
  assert.match(idx, /contextMenu\.bindContextMenu\(mainWindow\.webContents\)/);
  assert.match(idx, /bindContextMenu: contextMenu\.bindContextMenu/);
  for (const f of ['callWindow.js', 'settingsWindow.js', 'pickerWindow.js', 'helpWindow.js']) {
    const s = fs.readFileSync(path.join(__dirname, '../src/main', f), 'utf8');
    assert.ok(!/contextMenu|bindContextMenu/.test(s), f);
  }
});

test('no new preload surface: preloads do not reference the context menu', () => {
  const dir = path.join(__dirname, '../src/preload');
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.ok(!/context-?menu/i.test(s), f);
  }
});
