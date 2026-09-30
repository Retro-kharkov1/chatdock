'use strict';

// Guards that every build path goes through scripts/build.js (the GitVersion stamp), so no path
// can package the placeholder version from package.json again. See
// docs/architecture/packaging-release.md, "Version flow".

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('npm dist and pack go through scripts/build.js', () => {
  assert.match(pkg.scripts.dist, /scripts\/build\.js/);
  assert.match(pkg.scripts.pack, /scripts\/build\.js/);
  assert.doesNotMatch(pkg.scripts.dist, /^electron-builder/);
});

test('electron-builder refuses to package without the GitVersion stamp (beforePack guard)', () => {
  assert.equal(pkg.build.beforePack, 'scripts/beforePack.js');
  assert.ok(fs.existsSync(path.join(root, pkg.build.beforePack)));
});

test('the release workflow packages through scripts/build.js, not bare electron-builder', () => {
  const wf = read('.github/workflows/release.yml');
  assert.match(wf, /run: node scripts\/build\.js /);
  assert.doesNotMatch(wf, /run: npx electron-builder/);
  assert.match(wf, /fetch-depth: 0/);
});

test('the Linux Docker script resolves the version on the host and forwards it, with no override', () => {
  const ps = read('scripts/build-linux-docker.ps1');
  assert.match(ps, /node scripts\/generate-build-info\.js/);
  assert.match(ps, /build\.js --from-build-info/);
  assert.doesNotMatch(ps, /\$Version/);
  // build-info.json must reach the container; only .git is excluded from the copy.
  assert.doesNotMatch(ps, /--exclude=\.\/build-info\.json/);
  assert.match(ps, /--exclude=\.\/\.git/);
});

test('GitVersion is pinned as a local dotnet tool and matches the CI major.minor', () => {
  const manifest = JSON.parse(read('dotnet-tools.json'));
  const tool = manifest.tools['gitversion.tool'];
  assert.ok(tool, 'gitversion.tool missing from dotnet-tools.json');
  assert.ok(tool.commands.includes('dotnet-gitversion'));
  const ci = read('.github/workflows/release.yml').match(/versionSpec:\s*"(\d+\.\d+)\.x"/);
  assert.ok(ci, 'CI versionSpec not found');
  assert.ok(tool.version.startsWith(ci[1] + '.'), `local ${tool.version} vs CI ${ci[1]}.x`);
});

test('no fallback version remains in the build scripts', () => {
  for (const f of ['scripts/generate-build-info.js', 'scripts/build.js', 'scripts/lib/versionResolver.js']) {
    assert.doesNotMatch(read(f).replace(/\/\/.*$/gm, ''), /0\.0\.0-local|git describe|rev-list/, f);
  }
});

test('the Linux Docker script never wipes the whole output dir (Windows installer must survive)', () => {
  const ps = read('scripts/build-linux-docker.ps1');
  assert.ok(!ps.includes("'rm -rf /out/*'"), 'must not empty /out wholesale');
  assert.ok(ps.includes('rm -rf /out/linux-unpacked /out/latest-linux.yml /out/*.AppImage /out/*.deb'));
});
