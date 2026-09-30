'use strict';

// Guards the electron-builder settings that fixed two Linux packaging defects found by the
// Docker build (docs/development/build-linux-in-docker.md):
//  1. the deb installed to "/opt/Google Chat Desktop/"; the space broke the SUID chrome-sandbox
//     launch ("failed to execvp: /opt/Google");
//  2. the deb Depends field had no ALSA library.
// The install directory comes from `productName`, which electron-builder only accepts at the
// top level, so it is overridden for Linux builds on the command line (-c.productName=...) in
// scripts/build-linux-docker.ps1 and .github/workflows/release.yml. Those are asserted too.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

test('linux executableName is set and contains no whitespace', () => {
  const name = pkg.build.linux.executableName;
  assert.equal(typeof name, 'string');
  assert.ok(name.length > 0);
  assert.doesNotMatch(name, /\s/);
});

test('deb depends includes ALSA and keeps the electron-builder default dependencies', () => {
  const depends = pkg.build.deb.depends;
  assert.ok(Array.isArray(depends));
  assert.ok(depends.includes('libasound2t64 | libasound2'));
  // `depends` REPLACES electron-builder's deb defaults (the "default" keyword is snap-only), so
  // the defaults must be repeated explicitly.
  for (const dep of ['libgtk-3-0', 'libnotify4', 'libnss3', 'libxss1', 'libxtst6', 'xdg-utils',
    'libatspi2.0-0', 'libuuid1', 'libsecret-1-0']) {
    assert.ok(depends.includes(dep), `missing default dependency ${dep}`);
  }
});

test('Linux builds override productName with a space-free value (install dir /opt/<productName>)', () => {
  const pattern = /-c\.productName=([^\s"']+)/;
  for (const file of ['scripts/build-linux-docker.ps1', '.github/workflows/release.yml']) {
    const m = read(file).match(pattern);
    assert.ok(m, `${file} must pass -c.productName=<space-free> for Linux`);
    assert.doesNotMatch(m[1], /\s/);
  }
});

test('Windows target keeps the user-visible productName with no linux override in package.json', () => {
  assert.equal(pkg.build.productName, 'Google Chat Desktop');
  assert.deepEqual(pkg.build.win.target, ['nsis']);
  assert.equal(pkg.build.linux.desktop.entry.Name, 'Google Chat Desktop');
});
