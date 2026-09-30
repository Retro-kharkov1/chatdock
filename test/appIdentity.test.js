'use strict';

// BUG-01-G: dev and packaged builds share one Windows AppUserModelID, so the toast header reads
// "Electron" for the dev build and both flavors collide in Action Center / Start Menu identity.
// index.js calls app.setAppUserModelId('dev.retro-kharkov1.google-chat-desktop') unconditionally.
//
//   GREEN  facts the fix must preserve: the packaged identity is electron-builder's appId.
//   RED    contract proposed for the implementer:
//            src/main/appIdentity.js
//            resolveAppUserModelId({ isPackaged: boolean }) -> string
//          packaged -> exactly package.json build.appId (electron-builder registers that id for the
//          installed NSIS app and the toast header then shows the productName); dev -> a different,
//          non-empty, stable id (so a dev run never impersonates the installed app).
//          The pure function is testable; the real toast header is manual (checklist in report).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const pkg = require('../package.json');
const { pending, load } = require('./helpers/pending');

test('packaged identity source of truth: package.json build.appId is the documented app id', () => {
  assert.equal(pkg.build.appId, 'dev.retro-kharkov1.google-chat-desktop');
});

test('the product name shown to users is defined (toast header must show this, not "Electron")', () => {
  assert.equal(pkg.build.productName, 'Google Chat Desktop');
});

pending('packaged build AUMID equals package.json build.appId', () => {
  const { resolveAppUserModelId } = load('appIdentity.js');
  assert.equal(resolveAppUserModelId({ isPackaged: true }), pkg.build.appId);
});

pending('dev build AUMID is a non-empty string different from the packaged one', () => {
  const { resolveAppUserModelId } = load('appIdentity.js');
  const dev = resolveAppUserModelId({ isPackaged: false });
  assert.equal(typeof dev, 'string');
  assert.notEqual(dev.length, 0);
  assert.notEqual(dev, resolveAppUserModelId({ isPackaged: true }));
});

pending('dev build AUMID is stable across calls (a changing id would spawn a new Start Menu identity each run)', () => {
  const { resolveAppUserModelId } = load('appIdentity.js');
  assert.equal(
    resolveAppUserModelId({ isPackaged: false }),
    resolveAppUserModelId({ isPackaged: false })
  );
});

pending('dev build AUMID keeps the app id as a prefix (still recognisably this app)', () => {
  const { resolveAppUserModelId } = load('appIdentity.js');
  assert.equal(resolveAppUserModelId({ isPackaged: false }).startsWith(pkg.build.appId), true);
});
