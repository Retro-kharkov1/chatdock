'use strict';

// Coverage for src/main/version.js — the tray menu's disabled version/build line (owner request,
// 2026-09-22, born from losing a diagnostic round to "is the owner testing a stale process?").

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { formatBuildTimestamp, buildVersionLabel } = require('../src/main/version.js');

test('formatBuildTimestamp formats a known mtime as YYYY-MM-DD HH:mm', () => {
  const mtimeMs = new Date(2026, 8, 22, 12, 49, 34).getTime(); // 2026-09-22 12:49:34 local
  assert.equal(formatBuildTimestamp(mtimeMs), '2026-09-22 12:49');
});

test('formatBuildTimestamp pads single-digit month/day/hour/minute', () => {
  const mtimeMs = new Date(2026, 0, 5, 3, 7, 0).getTime(); // 2026-01-05 03:07
  assert.equal(formatBuildTimestamp(mtimeMs), '2026-01-05 03:07');
});

test('formatBuildTimestamp returns "unknown" for a missing/non-finite mtime, never throws', () => {
  assert.equal(formatBuildTimestamp(NaN), 'unknown');
  assert.equal(formatBuildTimestamp(undefined), 'unknown');
  assert.equal(formatBuildTimestamp('not-a-number'), 'unknown');
});

test('buildVersionLabel marks a dev run as "source"', () => {
  const mtimeMs = new Date(2026, 8, 22, 12, 49).getTime();
  assert.equal(
    buildVersionLabel('0.1.0', false, mtimeMs),
    '0.1.0 (source, built 2026-09-22 12:49)'
  );
});

test('buildVersionLabel marks app.isPackaged=true as "packaged"', () => {
  const mtimeMs = new Date(2026, 8, 22, 13, 12).getTime();
  assert.equal(
    buildVersionLabel('0.1.0', true, mtimeMs),
    '0.1.0 (packaged, built 2026-09-22 13:12)'
  );
});

test('buildVersionLabel degrades to "unknown" rather than throwing when mtime is missing', () => {
  assert.equal(buildVersionLabel('0.1.0', false, NaN), '0.1.0 (source, built unknown)');
});

test('buildVersionLabel always reflects the version string passed in (tracks package.json, never hardcoded)', () => {
  assert.equal(buildVersionLabel('2.4.1', true, 0).startsWith('2.4.1 '), true);
});
