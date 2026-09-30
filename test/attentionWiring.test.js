'use strict';

// BUG-01-D wiring: the window-event binding extracted from index.js bootstrap() into
// attention.js#bindWindowFocus. FR-14: ONLY focus stops the indicators; show / restore / hide /
// minimize must not.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createAttentionController, bindWindowFocus } = require('../src/main/attention.js');

function setup() {
  const win = new EventEmitter();
  const state = { focused: false };
  const log = { starts: 0, stops: 0, flash: [] };
  const controller = createAttentionController({
    isWindowFocused: () => state.focused,
    getBlinkOnUnread: () => true,
    getNotificationsMuted: () => false,
    startBlinking: () => { log.starts += 1; },
    stopBlinking: () => { log.stops += 1; },
    flashFrame: (f) => log.flash.push(f),
  });
  bindWindowFocus(win, controller);
  return { win, state, log, controller };
}

test('window "focus" stops both indicators', () => {
  const { win, log, controller } = setup();
  controller.onArrival();
  win.emit('focus');
  assert.equal(log.stops, 1);
  assert.equal(log.flash[log.flash.length - 1], false);
});

for (const ev of ['show', 'restore', 'hide', 'minimize', 'blur']) {
  test(`window "${ev}" does NOT stop the indicators (FR-14 reverses the old visibility rule)`, () => {
    const { win, log, controller } = setup();
    controller.onArrival();
    win.emit(ev);
    assert.equal(log.stops, 0);
    assert.equal(log.flash.includes(false), false);
  });
}

test('only the focus event is bound', () => {
  const { win } = setup();
  assert.deepEqual(win.eventNames(), ['focus']);
});
