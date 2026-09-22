'use strict';

// Task 0 net (docs/development/plan-google-chat-desktop-mvp.md) for
// resolveWindowState(saved, displays, defaultSize) — FR-02 (docs/business/requirements.md).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveWindowState } = require('../src/main/window-state.js');

const DEFAULT_SIZE = { width: 1200, height: 800 };

function display(x, y, width, height) {
  return { workArea: { x, y, width, height } };
}

test('FR-02: saved position within the primary display work area is kept as-is', () => {
  const saved = { width: 1000, height: 700, x: 100, y: 50, isMaximized: false };
  const displays = [display(0, 0, 1920, 1080)];

  const result = resolveWindowState(saved, displays, DEFAULT_SIZE);

  assert.deepEqual(result, { width: 1000, height: 700, x: 100, y: 50, isMaximized: false });
});

test('FR-02: saved isMaximized true is preserved when the saved position is on-screen', () => {
  const saved = { width: 1000, height: 700, x: 100, y: 50, isMaximized: true };
  const displays = [display(0, 0, 1920, 1080)];

  const result = resolveWindowState(saved, displays, DEFAULT_SIZE);

  assert.equal(result.isMaximized, true);
});

test('FR-02: missing isMaximized on an otherwise well-formed saved state defaults to false', () => {
  const saved = { width: 1000, height: 700, x: 100, y: 50 };
  const displays = [display(0, 0, 1920, 1080)];

  const result = resolveWindowState(saved, displays, DEFAULT_SIZE);

  assert.equal(result.isMaximized, false);
});

test('FR-02: saved position on a secondary (non-primary) display is kept, not treated as off-screen', () => {
  // displays[0] is the primary display by convention (see window-state.js JSDoc). The saved
  // position sits only within the second display's work area.
  const saved = { width: 800, height: 600, x: 2000, y: 100, isMaximized: false };
  const displays = [display(0, 0, 1920, 1080), display(1920, 0, 1920, 1080)];

  const result = resolveWindowState(saved, displays, DEFAULT_SIZE);

  assert.deepEqual(result, { width: 800, height: 600, x: 2000, y: 100, isMaximized: false });
});

test('FR-02 Scenario: saved position outside every connected display falls back to the centered default on the primary display', () => {
  const saved = { width: 800, height: 600, x: 5000, y: 5000, isMaximized: false };
  const displays = [display(0, 0, 1920, 1080)];

  const result = resolveWindowState(saved, displays, DEFAULT_SIZE);

  assert.equal(result.width, DEFAULT_SIZE.width);
  assert.equal(result.height, DEFAULT_SIZE.height);
  assert.equal(result.x, Math.round((1920 - DEFAULT_SIZE.width) / 2));
  assert.equal(result.y, Math.round((1080 - DEFAULT_SIZE.height) / 2));
  assert.equal(result.isMaximized, false);
});

test('FR-02: centering respects a primary display work area that is offset (not at 0,0)', () => {
  const saved = null;
  const displays = [display(100, 200, 1600, 900)];

  const result = resolveWindowState(saved, displays, DEFAULT_SIZE);

  assert.equal(result.x, Math.round(100 + (1600 - DEFAULT_SIZE.width) / 2));
  assert.equal(result.y, Math.round(200 + (900 - DEFAULT_SIZE.height) / 2));
});

test('first launch: null saved state falls back to the centered default', () => {
  const displays = [display(0, 0, 1920, 1080)];

  const result = resolveWindowState(null, displays, DEFAULT_SIZE);

  assert.equal(result.width, DEFAULT_SIZE.width);
  assert.equal(result.height, DEFAULT_SIZE.height);
  assert.equal(result.isMaximized, false);
});

test('first launch: undefined saved state falls back to the centered default', () => {
  const displays = [display(0, 0, 1920, 1080)];

  const result = resolveWindowState(undefined, displays, DEFAULT_SIZE);

  assert.equal(result.width, DEFAULT_SIZE.width);
  assert.equal(result.height, DEFAULT_SIZE.height);
});

test('malformed saved state (missing numeric fields) does not throw and falls back to default', () => {
  const displays = [display(0, 0, 1920, 1080)];

  assert.doesNotThrow(() => {
    const result = resolveWindowState({ width: 800 }, displays, DEFAULT_SIZE);
    assert.equal(result.width, DEFAULT_SIZE.width);
  });
});

test('malformed saved state (non-numeric x/y) does not throw and falls back to default', () => {
  const saved = { width: 800, height: 600, x: 'not-a-number', y: 50 };
  const displays = [display(0, 0, 1920, 1080)];

  const result = resolveWindowState(saved, displays, DEFAULT_SIZE);

  assert.equal(result.width, DEFAULT_SIZE.width);
  assert.equal(result.height, DEFAULT_SIZE.height);
});

test('malformed saved state (a string instead of an object) does not throw and falls back to default', () => {
  const displays = [display(0, 0, 1920, 1080)];

  assert.doesNotThrow(() => {
    const result = resolveWindowState('garbage', displays, DEFAULT_SIZE);
    assert.equal(result.width, DEFAULT_SIZE.width);
  });
});

test('malformed saved state (NaN/Infinity coordinates) does not throw and falls back to default', () => {
  const saved = { width: 800, height: 600, x: NaN, y: Infinity };
  const displays = [display(0, 0, 1920, 1080)];

  const result = resolveWindowState(saved, displays, DEFAULT_SIZE);

  assert.equal(result.width, DEFAULT_SIZE.width);
});

test('empty displays array with a well-formed saved state falls back to default with undefined position', () => {
  const saved = { width: 800, height: 600, x: 100, y: 100, isMaximized: false };

  const result = resolveWindowState(saved, [], DEFAULT_SIZE);

  assert.equal(result.width, DEFAULT_SIZE.width);
  assert.equal(result.height, DEFAULT_SIZE.height);
  assert.equal(result.x, undefined);
  assert.equal(result.y, undefined);
  assert.equal(result.isMaximized, false);
});

test('empty displays array with no saved state falls back to default with undefined position, without throwing', () => {
  assert.doesNotThrow(() => {
    const result = resolveWindowState(null, [], DEFAULT_SIZE);
    assert.equal(result.x, undefined);
    assert.equal(result.y, undefined);
  });
});

test('non-array displays value is treated as no displays, without throwing', () => {
  const saved = { width: 800, height: 600, x: 100, y: 100, isMaximized: false };

  assert.doesNotThrow(() => {
    const result = resolveWindowState(saved, undefined, DEFAULT_SIZE);
    assert.equal(result.width, DEFAULT_SIZE.width);
    assert.equal(result.x, undefined);
  });
});

test('saved position exactly on the top-left boundary of a display work area counts as on-screen', () => {
  const saved = { width: 800, height: 600, x: 0, y: 0, isMaximized: false };
  const displays = [display(0, 0, 1920, 1080)];

  const result = resolveWindowState(saved, displays, DEFAULT_SIZE);

  assert.equal(result.x, 0);
  assert.equal(result.y, 0);
});

test('saved position exactly on the bottom-right exclusive boundary of a display work area is off-screen', () => {
  // work area is [x, x+width) x [y, y+height) — a position at x+width is outside it.
  const saved = { width: 800, height: 600, x: 1920, y: 500, isMaximized: false };
  const displays = [display(0, 0, 1920, 1080)];

  const result = resolveWindowState(saved, displays, DEFAULT_SIZE);

  // Falls back to the centered default rather than being kept at the boundary.
  assert.equal(result.width, DEFAULT_SIZE.width);
  assert.notEqual(result.x, 1920);
});
