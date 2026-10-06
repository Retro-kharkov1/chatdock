'use strict';

// BUG-06: the Settings bridge gains exactly one narrow, fire-and-forget function.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const PRELOAD = path.join(__dirname, '..', 'src', 'preload', 'settingsPreload.js');

function loadPreload() {
  const exposed = [];
  const sent = [];
  const electronStub = {
    contextBridge: { exposeInMainWorld: (name, api) => exposed.push({ name, api }) },
    ipcRenderer: { invoke: () => Promise.resolve(), send: (...a) => sent.push(a), on() {}, removeListener() {} },
  };
  const original = Module._load;
  Module._load = function patched(request, ...rest) {
    if (request === 'electron') return electronStub;
    return original.call(this, request, ...rest);
  };
  try {
    delete require.cache[PRELOAD];
    require(PRELOAD);
  } finally {
    Module._load = original;
    delete require.cache[PRELOAD];
  }
  return { exposed, sent };
}

test('settingsPreload: bridge is exactly getAll, set, onChanged, reportContentHeight, openHelp', () => {
  const { exposed } = loadPreload();
  assert.equal(exposed.length, 1);
  assert.equal(exposed[0].name, '__gcdSettingsBridge');
  assert.deepEqual(Object.keys(exposed[0].api).sort(), ['getAll', 'onChanged', 'openHelp', 'reportContentHeight', 'set']);
});

test('settingsPreload: reportContentHeight sends only the number on settings:content-height', () => {
  const { exposed, sent } = loadPreload();
  exposed[0].api.reportContentHeight(412);
  assert.deepEqual(sent, [['settings:content-height', 412]]);
});

test('settingsPreload: openHelp sends settings:open-help with NO payload, even if the page passes arguments', () => {
  const { exposed, sent } = loadPreload();
  exposed[0].api.openHelp('https://evil.example', { x: 1 });
  assert.deepEqual(sent, [['settings:open-help']]);
});
