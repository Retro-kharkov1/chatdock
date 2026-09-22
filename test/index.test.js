'use strict';

// Task 0 net (docs/development/plan-google-chat-desktop-mvp.md) for
// isAllowedSender(frameOrigin, allowlist) and decideSingleInstanceAction(gotLock)
// — src/main/index.js — NFR-04 (IPC sender-origin guard) and FR-08 (single-instance).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isAllowedSender, decideSingleInstanceAction } = require('../src/main/index.js');

// --- isAllowedSender (NFR-04 / ipc-contract.md sender validation) --------------------------
// The IPC origin guard for `notification:clicked`. Attacks, not just the happy path — a
// permissive bug here is a real security hole in an app embedding an authenticated page.

const ALLOWLIST = ['https://chat.google.com', 'https://accounts.google.com'];

test('an allowlisted origin (chat.google.com) is accepted', () => {
  assert.equal(isAllowedSender('https://chat.google.com', ALLOWLIST), true);
});

test('the sign-in allowlisted origin (accounts.google.com) is accepted', () => {
  assert.equal(isAllowedSender('https://accounts.google.com', ALLOWLIST), true);
});

test('an origin not in the allowlist is rejected', () => {
  assert.equal(isAllowedSender('https://example.com', ALLOWLIST), false);
});

test('attack: a subdomain lookalike (evilchat.google.com) is rejected', () => {
  assert.equal(isAllowedSender('https://evilchat.google.com', ALLOWLIST), false);
});

test('attack: an attacker-controlled subdomain of the real origin (chat.google.com.evil.example) is rejected', () => {
  assert.equal(isAllowedSender('https://chat.google.com.evil.example', ALLOWLIST), false);
});

test('attack: a prefix trick embedding the real origin as a path is rejected', () => {
  assert.equal(isAllowedSender('https://evil.example/https://chat.google.com', ALLOWLIST), false);
});

test('attack: a suffix trick (chat.google.com appended to a different host) is rejected', () => {
  assert.equal(isAllowedSender('https://evil-chat.google.com', ALLOWLIST), false);
});

test('attack: same origin but with a trailing slash is rejected (origins never carry a path)', () => {
  assert.equal(isAllowedSender('https://chat.google.com/', ALLOWLIST), false);
});

test('attack: same origin but different scheme (http instead of https) is rejected', () => {
  assert.equal(isAllowedSender('http://chat.google.com', ALLOWLIST), false);
});

test('attack: case-different origin is rejected (case-sensitive exact match)', () => {
  assert.equal(isAllowedSender('https://Chat.Google.Com', ALLOWLIST), false);
});

test('attack: origin with a non-standard port is rejected', () => {
  assert.equal(isAllowedSender('https://chat.google.com:8443', ALLOWLIST), false);
});

test('non-string frameOrigin (null) is rejected, does not throw', () => {
  assert.equal(isAllowedSender(null, ALLOWLIST), false);
});

test('non-string frameOrigin (undefined) is rejected, does not throw', () => {
  assert.equal(isAllowedSender(undefined, ALLOWLIST), false);
});

test('non-string frameOrigin (number) is rejected, does not throw', () => {
  assert.equal(isAllowedSender(42, ALLOWLIST), false);
});

test('non-string frameOrigin (object) is rejected, does not throw', () => {
  assert.equal(isAllowedSender({ toString: () => 'https://chat.google.com' }, ALLOWLIST), false);
});

test('empty allowlist rejects any origin, does not throw', () => {
  assert.equal(isAllowedSender('https://chat.google.com', []), false);
});

test('missing/non-array allowlist (undefined) rejects any origin, does not throw', () => {
  assert.equal(isAllowedSender('https://chat.google.com', undefined), false);
});

test('missing/non-array allowlist (null) rejects any origin, does not throw', () => {
  assert.equal(isAllowedSender('https://chat.google.com', null), false);
});

test('empty string frameOrigin against a non-empty allowlist is rejected', () => {
  assert.equal(isAllowedSender('', ALLOWLIST), false);
});

// --- decideSingleInstanceAction (FR-08) -----------------------------------------------------

test('FR-08: gotLock=false selects the "quit" branch (another instance already holds the lock)', () => {
  assert.equal(decideSingleInstanceAction(false), 'quit');
});

test('FR-08: gotLock=true selects the "proceed" branch (this is the primary instance)', () => {
  assert.equal(decideSingleInstanceAction(true), 'proceed');
});
