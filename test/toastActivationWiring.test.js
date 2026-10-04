'use strict';

// BUG-05 attempt 2: guards the index.js wiring of the protocol-activated toast, because the behaviour
// itself only exists on a real Windows desktop (verified by hand, see docs/architecture/notifications.md
// "Why attempt 1 failed"). Each assertion names the defect it prevents.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.js'), 'utf8');

test('Windows toasts are built with the protocol-activation XML (a default foreground toast never delivers a click)', () => {
  assert.match(src, /toastXml: buildToastXml\(\{[^}]*scheme: PROTOCOL_SCHEME/);
});

test('the toast scheme is registered with the OS, packaged and dev', () => {
  assert.match(src, /app\.setAsDefaultProtocolClient\(PROTOCOL_SCHEME\)/);
  assert.match(src, /app\.setAsDefaultProtocolClient\(PROTOCOL_SCHEME, process\.execPath/);
});

test('a toast is NOT released on `close` (the pop-up timing out into the Action Center still has to be clickable)', () => {
  const closeHandler = src.slice(src.indexOf("t.on('close'"), src.indexOf("t.on('failed'"));
  assert.ok(closeHandler.length > 0);
  assert.doesNotMatch(closeHandler, /liveToasts\.delete|release\(/);
});

test('a rejected custom toast falls back to Electron\'s own toast instead of losing the notification', () => {
  assert.match(src, /toast = make\(false\)/);
});

test('both delivery paths (in-process click and second-instance argv) resolve through handleToastClick', () => {
  assert.match(src, /handleToastClick\(id, 'click-event'\)/);
  assert.match(src, /findActivationId\(argv, PROTOCOL_SCHEME\)/);
  assert.match(src, /handleToastClick\(id, 'second-instance'\)/);
});

test('diagnostics never log message text: only redacted shapes are passed to the diag trail', () => {
  const diagCalls = src.match(/diag\('toast\.show'[\s\S]*?\}\);/)[0];
  assert.doesNotMatch(diagCalls, /\btitle\b|\bbody\b/);
});
