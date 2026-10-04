'use strict';

// BUG-06 renderer wiring, static checks (no DOM runtime in this suite).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', f), 'utf8');

test('settings.js observes the content root and reports its height through the bridge', () => {
  const js = read('settings.js');
  assert.match(js, /new ResizeObserver/);
  assert.match(js, /appRoot/);
  assert.match(js, /reportContentHeight/);
  assert.match(js, /getBoundingClientRect\(\)\.height/);
});

test('settings.js reports a height on the load-failure path too (window must still show)', () => {
  const js = read('settings.js');
  const catchBlock = js.slice(js.lastIndexOf('} catch (err) {'));
  assert.match(catchBlock, /startReportingHeight/);
});

test('settings.css does not force a fixed height or overflow on the content', () => {
  const css = read('settings.css');
  assert.doesNotMatch(css, /overflow-y\s*:\s*scroll/);
  assert.doesNotMatch(css, /\b(height|min-height)\s*:\s*100vh/);
});
