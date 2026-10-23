'use strict';

// BUG-09 network evidence (attachNetworkDiagnostics, hostOfInterest). Pure: fake session, fake clock, no Electron.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatLine } = require('../src/main/diagLog');
const { attachNetworkDiagnostics, hostOfInterest } = require('../src/main/callDiagnostics');

function setup(opts = {}) {
  const handlers = {};
  const session = {
    webRequest: {
      onErrorOccurred: (h) => (handlers.err = h),
      onCompleted: (h) => (handlers.done = h),
    },
  };
  const lines = [];
  const clock = { t: 0 };
  const api = attachNetworkDiagnostics(session, {
    diag: (event, fields) => lines.push({ event, fields, text: formatLine(event, fields) }),
    now: () => clock.t,
    setIntervalFn: () => ({}),
    clearIntervalFn: () => {},
    ...opts,
  });
  return { handlers, lines, clock, api };
}

test('hostOfInterest is an exact-suffix match on label boundaries', () => {
  assert.equal(hostOfInterest('https://meet.google.com/abc?x=1'), 'meet.google.com');
  assert.equal(hostOfInterest('https://google.com/'), 'google.com');
  assert.equal(hostOfInterest('https://STUN.L.Google.com./x'), 'stun.l.google.com');
  assert.equal(hostOfInterest('https://rr1.googlevideo.com/x'), 'rr1.googlevideo.com');
  assert.equal(hostOfInterest('https://evilgoogle.com/'), null);
  assert.equal(hostOfInterest('https://google.com.evil.example/'), null);
  assert.equal(hostOfInterest('https://evil.example/google.com'), null);
  assert.equal(hostOfInterest('https://evil.example/?u=meet.google.com'), null);
  assert.equal(hostOfInterest('not a url'), null);
  assert.equal(hostOfInterest(undefined), null);
});

test('an error line carries host, resource type and error only (no path, query, userinfo)', () => {
  const { handlers, lines } = setup();
  handlers.err({
    url: 'https://user:pw@meet.google.com/_/path/SECRETPATH?token=SECRETQ#frag',
    resourceType: 'webSocket',
    error: 'net::ERR_CONNECTION_RESET',
    requestHeaders: { Cookie: 'SECRETCOOKIE' },
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, 'net-error');
  assert.deepEqual(lines[0].fields, {
    host: 'meet.google.com',
    resourceType: 'webSocket',
    error: 'net::ERR_CONNECTION_RESET',
  });
  for (const secret of ['SECRETPATH', 'SECRETQ', 'SECRETCOOKIE', 'frag', 'pw', 'user']) {
    assert.ok(!lines[0].text.includes(secret), secret);
  }
});

test('errors for non-allow-listed hosts are not logged', () => {
  const { handlers, lines } = setup();
  handlers.err({ url: 'https://evilgoogle.com/', resourceType: 'xhr', error: 'net::ERR_FAILED' });
  assert.equal(lines.length, 0);
});

test('non-2xx completions are counted per host and status, flushed as one line; 2xx and others ignored', () => {
  const { handlers, lines, api } = setup();
  handlers.done({ url: 'https://meet.google.com/a?q=1', statusCode: 403 });
  handlers.done({ url: 'https://meet.google.com/b', statusCode: 403 });
  handlers.done({ url: 'https://meet.google.com/c', statusCode: 200 });
  handlers.done({ url: 'https://example.com/c', statusCode: 500 });
  handlers.done({ url: 'https://clients6.google.com/c', statusCode: 503 });
  assert.equal(lines.length, 0);
  api.flush();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].event, 'net-status');
  assert.equal(lines[0].fields.non2xx, 'meet.google.com 403=2 clients6.google.com 503=1');
  assert.ok(!lines[0].text.includes('/a'));
  api.flush();
  assert.equal(lines.length, 1);
});

test('lines per minute are capped; the excess is reported once at the next minute', () => {
  const { handlers, lines, clock } = setup({ maxLinesPerMinute: 3 });
  for (let i = 0; i < 10; i++) {
    handlers.err({ url: 'https://meet.google.com/x', resourceType: 'xhr', error: 'net::ERR_FAILED' });
  }
  assert.equal(lines.length, 3);
  clock.t = 61000;
  handlers.err({ url: 'https://meet.google.com/x', resourceType: 'xhr', error: 'net::ERR_FAILED' });
  assert.equal(lines[3].event, 'net-diag-suppressed');
  assert.deepEqual(lines[3].fields, { lines: 7 });
  assert.equal(lines[4].event, 'net-error');
  assert.equal(lines.length, 5);
});

test('malformed details never throw', () => {
  const { handlers } = setup();
  assert.doesNotThrow(() => handlers.err(undefined));
  assert.doesNotThrow(() => handlers.done(null));
  assert.doesNotThrow(() => handlers.err({ url: 5 }));
});
