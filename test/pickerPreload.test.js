'use strict';

// UI-01 picker preload (docs/architecture/ipc-contract.md "Screen-share picker window"; meet-call-window.md
// section 7). RED until src/preload/pickerPreload.js exists.
//
// Contract: the preload exposes, via contextBridge.exposeInMainWorld('__gcdPickerBridge', api), exactly
//   getSources() -> ipcRenderer.invoke('picker:get-sources')
//   choose(sourceId) -> ipcRenderer.invoke('picker:choose', { sourceId })
//   cancel() -> ipcRenderer.send('picker:cancel')
// and nothing else: no ipcRenderer object, no extra function, no other exposed global.
// The preload is a file of its own, never shared with another window (the main window's preload.js and
// settingsPreload.js do not mention the picker channels).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const PRELOAD = path.join(__dirname, '..', 'src', 'preload', 'pickerPreload.js');

function loadPreload() {
  const exposed = [];
  const sent = [];
  const invoked = [];
  const electronStub = {
    contextBridge: { exposeInMainWorld: (name, api) => exposed.push({ name, api }) },
    ipcRenderer: {
      invoke: (...args) => { invoked.push(args); return Promise.resolve('invoke-result'); },
      send: (...args) => sent.push(args),
      on: () => { throw new Error('the picker preload must not subscribe to channels'); },
    },
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
  return { exposed, sent, invoked };
}

test('pickerPreload: the file exists as its own preload', () => {
  assert.equal(fs.existsSync(PRELOAD), true);
});

test('pickerPreload: exposes exactly one global, __gcdPickerBridge', () => {
  const { exposed } = loadPreload();
  assert.equal(exposed.length, 1);
  assert.equal(exposed[0].name, '__gcdPickerBridge');
});

test('pickerPreload: the bridge has exactly getSources, choose and cancel (nothing else, no ipcRenderer)', () => {
  const { exposed } = loadPreload();
  assert.deepEqual(Object.keys(exposed[0].api).sort(), ['cancel', 'choose', 'getSources']);
  for (const key of Object.keys(exposed[0].api)) assert.equal(typeof exposed[0].api[key], 'function', key);
});

test('pickerPreload: getSources invokes picker:get-sources with no payload', async () => {
  const { exposed, invoked } = loadPreload();
  const result = await exposed[0].api.getSources();
  assert.deepEqual(invoked, [['picker:get-sources']]);
  assert.equal(result, 'invoke-result');
});

test('pickerPreload: choose invokes picker:choose with { sourceId } and returns the reply', async () => {
  const { exposed, invoked } = loadPreload();
  const result = await exposed[0].api.choose('screen:1:0');
  assert.deepEqual(invoked, [['picker:choose', { sourceId: 'screen:1:0' }]]);
  assert.equal(result, 'invoke-result');
});

test('pickerPreload: cancel is fire-and-forget on picker:cancel', () => {
  const { exposed, sent, invoked } = loadPreload();
  exposed[0].api.cancel();
  assert.deepEqual(sent, [['picker:cancel']]);
  assert.deepEqual(invoked, []);
});

test('picker channels are not reachable from the other windows\' preloads (no shared bridge)', () => {
  for (const file of ['preload.js', 'settingsPreload.js', 'serviceWorkerPreload.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', file), 'utf8');
    assert.equal(source.includes('picker:'), false, file);
    assert.equal(source.includes('__gcdPickerBridge'), false, file);
  }
});
