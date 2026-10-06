'use strict';

// Task 0 net (docs/development/plan-google-chat-desktop-mvp.md) for
// parseUnreadCount(title) and shouldMuteOrSilence(mutedFlag, soundEnabledFlag, notificationOptions)
// — src/main/notifications.js — FR-05, FR-11, FR-12 (docs/business/requirements.md).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseUnreadCount, shouldMuteOrSilence } = require('../src/main/notifications.js');

// --- parseUnreadCount (FR-05: tray unread indicator) ---------------------------------------

test('FR-05: title with a "(N)" prefix parses the unread count', () => {
  assert.equal(parseUnreadCount('(3) Google Chat'), 3);
});

test('FR-05: multi-digit unread count parses correctly', () => {
  assert.equal(parseUnreadCount('(42) Google Chat'), 42);
});

test('FR-05: title with no "(N)" prefix resolves to 0', () => {
  assert.equal(parseUnreadCount('Google Chat'), 0);
});

test('FR-05: malformed prefix (non-digit inside parens) resolves to 0, does not throw', () => {
  assert.equal(parseUnreadCount('(abc) Google Chat'), 0);
});

test('FR-05: empty string resolves to 0', () => {
  assert.equal(parseUnreadCount(''), 0);
});

test('FR-05: prefix not anchored at the start of the title resolves to 0', () => {
  assert.equal(parseUnreadCount('Google Chat (3)'), 0);
});

test('FR-05: "(0)" prefix parses to 0 (zero unread, not "no prefix")', () => {
  assert.equal(parseUnreadCount('(0) Google Chat'), 0);
});

test('FR-05: non-string input (number) resolves to 0, does not throw', () => {
  assert.equal(parseUnreadCount(42), 0);
});

test('FR-05: non-string input (null) resolves to 0, does not throw', () => {
  assert.equal(parseUnreadCount(null), 0);
});

test('FR-05: non-string input (undefined) resolves to 0, does not throw', () => {
  assert.equal(parseUnreadCount(undefined), 0);
});

test('FR-05: non-string input (object) resolves to 0, does not throw', () => {
  assert.equal(parseUnreadCount({}), 0);
});

// --- parseUnreadCount: count shapes Google Chat really emits (compatibility audit) ---------------
for (const [title, expected] of [
  ['(99+) Google Chat', 99],
  ['(1,234) Google Chat', 1234],
  ['(1.234) Google Chat', 1234],
  ['(1 234) Google Chat', 1234],
  ['(1 234) Google Chat', 1234],
  ['(1 234) Google Chat', 1234],
  ['(1 234) Google Chat', 1234],
  ['  (5) Google Chat', 5],
  ['\n\t(7) Google Chat', 7],
  ['(1,234+) Google Chat', 1234],
  ['(0+) Google Chat', 0],
]) {
  test(`parseUnreadCount: ${JSON.stringify(title)} -> ${expected}`, () => {
    assert.equal(parseUnreadCount(title), expected);
  });
}

for (const title of ['(+) Google Chat', '(1,) Google Chat', '(,1) Google Chat', '(1,2) Google Chat', '(1..2) Google Chat', '(1 2 3x) Google Chat', '( ) Google Chat', '(99++) Google Chat']) {
  test(`parseUnreadCount: malformed ${JSON.stringify(title)} -> 0 and never throws`, () => {
    assert.doesNotThrow(() => parseUnreadCount(title));
    assert.equal(parseUnreadCount(title), 0);
  });
}

// --- shouldMuteOrSilence (FR-11 sound control, FR-12 mute) ----------------------------------
// Every combination of {muted, soundEnabled, page-requested-silent} is pinned, per the task
// brief: a wrong branch here silently loses messages.

test('FR-12: muted suppresses entirely regardless of sound setting (sound on)', () => {
  const result = shouldMuteOrSilence(true, true, {});
  assert.equal(result, null);
});

test('FR-12: muted suppresses entirely regardless of sound setting (sound off)', () => {
  const result = shouldMuteOrSilence(true, false, {});
  assert.equal(result, null);
});

test('FR-12: muted suppresses entirely even when the page itself requested silent:true', () => {
  const result = shouldMuteOrSilence(true, true, { silent: true });
  assert.equal(result, null);
});

test('FR-12: muted suppresses entirely even when notificationOptions is undefined', () => {
  const result = shouldMuteOrSilence(true, true, undefined);
  assert.equal(result, null);
});

test('FR-11: unmuted + sound off forces silent, even when the page did not request silent', () => {
  const result = shouldMuteOrSilence(false, false, {});
  assert.deepEqual(result, { silent: true });
});

test('unmuted + sound on + page did not request silent plays normally (not silent)', () => {
  const result = shouldMuteOrSilence(false, true, {});
  assert.deepEqual(result, { silent: false });
});

test("page's own silent:true is respected even when the app's sound setting is on", () => {
  const result = shouldMuteOrSilence(false, true, { silent: true });
  assert.deepEqual(result, { silent: true });
});

test("page's own silent:true combined with sound off is still silent (both agree)", () => {
  const result = shouldMuteOrSilence(false, false, { silent: true });
  assert.deepEqual(result, { silent: true });
});

test('unmuted + sound on + page explicitly requested silent:false plays normally', () => {
  const result = shouldMuteOrSilence(false, true, { silent: false });
  assert.deepEqual(result, { silent: false });
});

test('notificationOptions of null is treated the same as {} (unmuted, sound on)', () => {
  const result = shouldMuteOrSilence(false, true, null);
  assert.deepEqual(result, { silent: false });
});

test('notificationOptions of undefined is treated the same as {} (unmuted, sound off forces silent)', () => {
  const result = shouldMuteOrSilence(false, false, undefined);
  assert.deepEqual(result, { silent: true });
});

test('other properties on notificationOptions are preserved (shallow-copied through) when not suppressed', () => {
  const result = shouldMuteOrSilence(false, true, { body: 'hello', tag: 'conv-1' });
  assert.equal(result.body, 'hello');
  assert.equal(result.tag, 'conv-1');
  assert.equal(result.silent, false);
});

test('the returned options object is a copy, not the same reference as the input', () => {
  const input = { body: 'hello' };
  const result = shouldMuteOrSilence(false, true, input);
  assert.notEqual(result, input);
});
