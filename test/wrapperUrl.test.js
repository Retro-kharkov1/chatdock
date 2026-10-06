'use strict';

// UI-05 / FR-18, docs/architecture/smart-copy.md sections 1 and 6, 8 (row "wrapperUrl"). RED until
// src/main/wrapperUrl.js exists.
//
// API CONTRACT ASSUMED: src/main/wrapperUrl.js exports { unwrapTarget(u: URL) -> string | null,
// WRAPPER_ORIGIN, WRAPPER_PATH } and is the ONLY definition: meetLink.js, googleLink.js and smartCopy.js
// import it (no third copy). The behaviour of the existing unwrapTarget is preserved: the decoded `q` when the
// URL is exactly https://www.google.com/url with a single `q`, no port, no userinfo; otherwise null.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./helpers/pending');

const TARGET = 'https://example.com/a?b=1&c=2';
const WRAPPED = 'https://www.google.com/url?q=' + encodeURIComponent(TARGET);

function unwrap(href) {
  return load('wrapperUrl.js').unwrapTarget(new URL(href));
}

function source(file) {
  return fs.readFileSync(path.join(__dirname, '..', 'src', 'main', file), 'utf8');
}

function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('wrapperUrl: exports unwrapTarget and the wrapper constants', () => {
  const mod = load('wrapperUrl.js');
  assert.equal(typeof mod.unwrapTarget, 'function');
  assert.equal(mod.WRAPPER_ORIGIN, 'https://www.google.com');
  assert.equal(mod.WRAPPER_PATH, '/url');
});

test('wrapperUrl: a single q is returned decoded', () => {
  assert.equal(unwrap(WRAPPED), TARGET);
});

test('wrapperUrl: other query parameters next to a single q do not matter', () => {
  assert.equal(unwrap(WRAPPED + '&sa=D&ust=123'), TARGET);
});

test('wrapperUrl: no q, or two q values, give null', () => {
  assert.equal(unwrap('https://www.google.com/url'), null);
  assert.equal(unwrap(WRAPPED + '&q=' + encodeURIComponent('https://other.example/')), null);
});

test('wrapperUrl: a port, userinfo, another path, another host or http give null', () => {
  const q = '?q=' + encodeURIComponent(TARGET);
  assert.equal(unwrap('https://www.google.com:8443/url' + q), null);
  assert.equal(unwrap('https://user:pw@www.google.com/url' + q), null);
  assert.equal(unwrap('https://www.google.com/urls' + q), null);
  assert.equal(unwrap('https://www.google.com/url/' + q), null);
  assert.equal(unwrap('https://google.com/url' + q), null);
  assert.equal(unwrap('https://www.google.com.evil.example/url' + q), null);
  assert.equal(unwrap('http://www.google.com/url' + q), null);
});

test('wrapperUrl: the default port :443 is normalised away and still unwraps', () => {
  assert.equal(unwrap('https://www.google.com:443/url?q=' + encodeURIComponent(TARGET)), TARGET);
});

test('wrapperUrl: it does not unwrap twice (a nested wrapper comes back as text)', () => {
  const inner = 'https://www.google.com/url?q=' + encodeURIComponent('https://final.example/');
  assert.equal(unwrap('https://www.google.com/url?q=' + encodeURIComponent(inner)), inner);
});

test('source pin: meetLink.js, googleLink.js and smartCopy.js import wrapperUrl and define no unwrapTarget of their own', () => {
  for (const file of ['meetLink.js', 'googleLink.js', 'smartCopy.js']) {
    const code = stripComments(source(file));
    assert.match(code, /require\(['"]\.\/wrapperUrl(\.js)?['"]\)/, file + ' imports wrapperUrl');
    assert.equal(/function\s+unwrapTarget\b/.test(code), false, file + ' has no local unwrapTarget function');
    assert.equal(/(const|let|var)\s+unwrapTarget\s*=\s*(function|\()/.test(code), false, file + ' has no local unwrapTarget value');
  }
});

test('source pin: wrapperUrl.js is pure (no Electron import)', () => {
  assert.equal(/require\(['"]electron['"]\)/.test(stripComments(source('wrapperUrl.js'))), false);
});
