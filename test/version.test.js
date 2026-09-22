'use strict';

// Coverage for src/main/version.js — the tray menu's disabled version/build line, sourced from
// `build-info.json` (see scripts/generate-build-info.js for the generator and field contract).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readBuildInfo, buildVersionLabel } = require('../src/main/version.js');

test('buildVersionLabel formats a well-formed CI build-info object', () => {
  const buildInfo = {
    version: '0.0.1-14',
    shortSha: '00b6e49',
    branch: 'main',
    buildSource: 'ci',
    builtAt: '2026-09-22T12:10:30.155Z',
  };
  assert.equal(buildVersionLabel(buildInfo), '0.0.1-14 (00b6e49, ci)');
});

test('buildVersionLabel formats a well-formed local build-info object', () => {
  const buildInfo = {
    version: '0.0.0-local+00b6e49',
    shortSha: '00b6e49',
    branch: 'main',
    buildSource: 'local',
    builtAt: '2026-09-22T12:10:30.155Z',
  };
  assert.equal(buildVersionLabel(buildInfo), '0.0.0-local+00b6e49 (00b6e49, local)');
});

test('buildVersionLabel returns an honest unknown-build marker for null (missing file)', () => {
  assert.equal(buildVersionLabel(null), 'build info unavailable');
});

test('buildVersionLabel returns an honest unknown-build marker for undefined', () => {
  assert.equal(buildVersionLabel(undefined), 'build info unavailable');
});

test('buildVersionLabel returns an honest unknown-build marker for non-object input', () => {
  assert.equal(buildVersionLabel('not an object'), 'build info unavailable');
  assert.equal(buildVersionLabel(42), 'build info unavailable');
});

test('buildVersionLabel returns an honest unknown-build marker when version is missing', () => {
  assert.equal(
    buildVersionLabel({ shortSha: '00b6e49', buildSource: 'local' }),
    'build info unavailable'
  );
});

test('buildVersionLabel returns an honest unknown-build marker when version is not a string', () => {
  assert.equal(
    buildVersionLabel({ version: 123, shortSha: '00b6e49', buildSource: 'local' }),
    'build info unavailable'
  );
});

test('buildVersionLabel degrades shortSha to "unknown sha" rather than throwing when missing', () => {
  assert.equal(
    buildVersionLabel({ version: '0.1.0-1', buildSource: 'ci' }),
    '0.1.0-1 (unknown sha, ci)'
  );
});

test('buildVersionLabel degrades buildSource to "unknown source" for an unexpected value', () => {
  assert.equal(
    buildVersionLabel({ version: '0.1.0-1', shortSha: 'abc1234', buildSource: 'not-a-real-source' }),
    '0.1.0-1 (abc1234, unknown source)'
  );
});

test('buildVersionLabel never throws on a malformed/partial build-info object', () => {
  assert.doesNotThrow(() => buildVersionLabel({}));
  assert.equal(buildVersionLabel({}), 'build info unavailable');
});

test('readBuildInfo returns null when the file does not exist', () => {
  const result = readBuildInfo(() => require('node:os').tmpdir() + '/definitely-not-a-real-dir-xyz');
  assert.equal(result, null);
});

test('readBuildInfo returns null when the file contains malformed JSON', () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'version-test-'));
  fs.writeFileSync(path.join(dir, 'build-info.json'), '{ not valid json', 'utf8');
  try {
    const result = readBuildInfo(() => dir);
    assert.equal(result, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readBuildInfo parses a well-formed build-info.json', () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'version-test-'));
  const buildInfo = {
    version: '0.0.1-14',
    shortSha: '00b6e49',
    branch: 'main',
    buildSource: 'local',
    builtAt: '2026-09-22T12:10:30.155Z',
  };
  fs.writeFileSync(path.join(dir, 'build-info.json'), JSON.stringify(buildInfo), 'utf8');
  try {
    const result = readBuildInfo(() => dir);
    assert.deepEqual(result, buildInfo);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readBuildInfo never throws when appGetAppPath itself throws', () => {
  assert.doesNotThrow(() =>
    readBuildInfo(() => {
      throw new Error('boom');
    })
  );
  assert.equal(
    readBuildInfo(() => {
      throw new Error('boom');
    }),
    null
  );
});
