'use strict';

// BUG-09 call-failure diagnostics (src/main/callDiagnostics.js). Pure: fake emitters, no Electron.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { formatLine } = require('../src/main/diagLog');
const {
  attachContentsDiagnostics,
  attachProcessDiagnostics,
  describeDeniedBlankOpen,
  logWebRtcSwitches,
} = require('../src/main/callDiagnostics');
const { createLinkRouter } = require('../src/main/linkRouter');

function recorder() {
  const lines = [];
  return { lines, diag: (event, fields) => lines.push({ event, fields, text: formatLine(event, fields) }) };
}

function fakeContents(url = 'https://chat.google.com/room/AAA?token=SECRET') {
  const c = new EventEmitter();
  c.getURL = () => url;
  c.isDestroyed = () => false;
  return c;
}

test('did-fail-load of a sub-frame is logged with code, description and a redacted URL', () => {
  const { lines, diag } = recorder();
  const c = fakeContents();
  attachContentsDiagnostics(c, { diag });
  c.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://meet.google.com/call/x?authuser=0&k=SECRET', false, 1, 2);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, 'did-fail-load');
  assert.deepEqual(lines[0].fields, {
    owner: 'main',
    mainFrame: false,
    code: -105,
    description: 'ERR_NAME_NOT_RESOLVED',
    url: 'https://meet.google.com/call/x',
  });
  assert.ok(!lines[0].text.includes('SECRET'));
});

test('did-fail-provisional-load is logged under its own event name', () => {
  const { lines, diag } = recorder();
  const c = fakeContents();
  attachContentsDiagnostics(c, { diag });
  c.emit('did-fail-provisional-load', {}, -3, 'ERR_ABORTED', 'https://chat.google.com/a?b=c', true);
  assert.equal(lines[0].event, 'did-fail-provisional-load');
  assert.equal(lines[0].fields.mainFrame, true);
  assert.equal(lines[0].fields.url, 'https://chat.google.com/a');
});

test('media-started-playing and media-paused log the page origin only', () => {
  const { lines, diag } = recorder();
  const c = fakeContents('https://chat.google.com/room/AAA?token=SECRET');
  attachContentsDiagnostics(c, { diag });
  c.emit('media-started-playing');
  c.emit('media-paused');
  assert.deepEqual(
    lines.map((l) => [l.event, l.fields.origin]),
    [
      ['media-started-playing', 'https://chat.google.com'],
      ['media-paused', 'https://chat.google.com'],
    ]
  );
  assert.ok(lines.every((l) => !l.text.includes('SECRET') && !l.text.includes('/room')));
});

test('a destroyed contents does not break a media event', () => {
  const { lines, diag } = recorder();
  const c = fakeContents();
  c.isDestroyed = () => true;
  attachContentsDiagnostics(c, { diag });
  c.emit('media-paused');
  assert.equal(lines[0].fields.origin, '<none>');
});

test('a throwing diag sink never reaches the emitter', () => {
  const c = fakeContents();
  attachContentsDiagnostics(c, {
    diag: () => {
      throw new Error('sink down');
    },
  });
  assert.doesNotThrow(() => c.emit('did-fail-load', {}, -1, 'x', 'https://a.example/', false));
});

test('render-process-gone and child-process-gone are logged with reason and exit code', () => {
  const { lines, diag } = recorder();
  const app = new EventEmitter();
  attachProcessDiagnostics(app, { diag });
  app.emit('render-process-gone', {}, fakeContents('https://meet.google.com/call?x=SECRET'), { reason: 'crashed', exitCode: 11 });
  app.emit('child-process-gone', {}, { type: 'GPU', reason: 'launch-failed', exitCode: 18, name: 'GPU process' });
  app.emit('child-process-gone', {}, { type: 'Utility', reason: 'crashed', exitCode: 1, serviceName: 'network.mojom.NetworkService' });
  assert.deepEqual(lines[0].fields, { origin: 'https://meet.google.com', reason: 'crashed', exitCode: 11 });
  assert.equal(lines[1].event, 'child-process-gone');
  assert.equal(lines[1].fields.type, 'GPU');
  assert.equal(lines[1].fields.reason, 'launch-failed');
  assert.equal(lines[2].fields.service, 'network.mojom.NetworkService');
  assert.ok(!lines[0].text.includes('SECRET'));
});

test('describeDeniedBlankOpen: only about:blank, opener origin, disposition and features', () => {
  const out = describeDeniedBlankOpen({
    url: 'about:blank',
    disposition: 'new-window',
    features: 'popup=yes,width=100',
    referrer: { url: 'https://chat.google.com/room/AAA?token=SECRET', policy: 'strict-origin' },
  });
  assert.deepEqual(out, { openerOrigin: 'https://chat.google.com', disposition: 'new-window', features: 'popup=yes,width=100' });
  assert.equal(describeDeniedBlankOpen({ url: 'https://example.com/x', referrer: { url: 'https://chat.google.com/' } }), null);
  assert.equal(describeDeniedBlankOpen(undefined), null);
});

test('describeDeniedBlankOpen: a missing referrer is <none>, a long features string is truncated, URLs in it are reduced', () => {
  const out = describeDeniedBlankOpen({
    url: 'about:blank',
    disposition: 'other',
    features: `${'a'.repeat(300)} https://x.example/p?q=SECRET`,
  });
  assert.equal(out.openerOrigin, '<none>');
  assert.ok(out.features.length < 200);
  const reduced = describeDeniedBlankOpen({ url: 'about:blank', features: 'https://x.example/p?q=SECRET' });
  assert.equal(reduced.features, 'https://x.example/p');
});

test('the link router still denies about:blank and the diag call does not change the decision', () => {
  const router = createLinkRouter({
    classifyLink: (url) => ({ outcome: 'system-browser', url }),
    isOpenableExternalScheme: () => false,
    openCallWindow: () => {
      throw new Error('must not open');
    },
    openExternal: () => {
      throw new Error('must not open');
    },
    log: () => {},
  });
  assert.deepEqual(
    router.onWindowOpen({ url: 'about:blank', disposition: 'new-window', features: '', referrer: { url: 'https://chat.google.com/' } }),
    { action: 'deny' }
  );
});

test('logWebRtcSwitches: no switches set -> "none"', () => {
  const { lines, diag } = recorder();
  logWebRtcSwitches({ commandLine: { hasSwitch: () => false, getSwitchValue: () => '' } }, { diag });
  assert.deepEqual(lines[0].fields, { count: 0, switches: 'none' });
});

test('logWebRtcSwitches: set switches are listed with their values', () => {
  const { lines, diag } = recorder();
  const set = { 'disable-webrtc-hw-encoding': '', 'force-webrtc-ip-handling-policy': 'default_public_interface_only' };
  const commandLine = {
    hasSwitch: (n) => Object.prototype.hasOwnProperty.call(set, n),
    getSwitchValue: (n) => set[n] || '',
  };
  logWebRtcSwitches({ commandLine }, { diag });
  assert.equal(lines[0].fields.count, 2);
  assert.deepEqual(JSON.parse(lines[0].fields.switches), set);
});

test('logWebRtcSwitches never throws when commandLine is unavailable', () => {
  const { diag } = recorder();
  assert.doesNotThrow(() => logWebRtcSwitches({}, { diag }));
});
