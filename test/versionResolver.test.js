'use strict';

// Coverage for scripts/lib/versionResolver.js - the single place that turns GitVersion output
// into the build identity (see docs/architecture/packaging-release.md, "Version flow").
// Owner rule: GitVersion is the ONLY version source, on every build path, and there is no
// fallback - a resolution problem must throw, never degrade to a guessed version.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  VersionResolutionError,
  identityFromGitVersionJson,
  identityFromCIEnv,
  resolveIdentity,
  assertVersionMatches,
  findArtifactsMissingVersion,
} = require('../scripts/lib/versionResolver.js');

const gv = {
  SemVer: '0.0.1-61',
  FullSemVer: '0.0.1-61',
  ShortSha: '2b721e0',
  BranchName: 'main',
};

test('identityFromGitVersionJson maps GitVersion output to the build identity', () => {
  assert.deepEqual(identityFromGitVersionJson(gv), {
    version: '0.0.1-61',
    fullSemVer: '0.0.1-61',
    shortSha: '2b721e0',
    branch: 'main',
  });
});

test('identityFromGitVersionJson throws on missing or empty fields (no partial identity)', () => {
  for (const field of ['SemVer', 'FullSemVer', 'ShortSha', 'BranchName']) {
    const bad = { ...gv };
    delete bad[field];
    assert.throws(() => identityFromGitVersionJson(bad), VersionResolutionError, field);
    assert.throws(() => identityFromGitVersionJson({ ...gv, [field]: '' }), VersionResolutionError, field);
  }
  assert.throws(() => identityFromGitVersionJson(null), VersionResolutionError);
  assert.throws(() => identityFromGitVersionJson('x'), VersionResolutionError);
});

test('identityFromGitVersionJson rejects a SemVer that is not a valid semver string', () => {
  assert.throws(() => identityFromGitVersionJson({ ...gv, SemVer: 'unknown' }), VersionResolutionError);
  assert.throws(() => identityFromGitVersionJson({ ...gv, SemVer: '0.0.0-local+abc' }), /local/);
});

test('identityFromCIEnv returns null when no GitVersion_* variable is set', () => {
  assert.equal(identityFromCIEnv({}), null);
  assert.equal(identityFromCIEnv({ CI: 'true' }), null);
});

test('identityFromCIEnv maps the variables exported by the gitversion/execute action', () => {
  const env = {
    GitVersion_SemVer: '0.1.0',
    GitVersion_FullSemVer: '0.1.0',
    GitVersion_ShortSha: 'abc1234',
    GitVersion_BranchName: 'main',
  };
  assert.deepEqual(identityFromCIEnv(env), {
    version: '0.1.0',
    fullSemVer: '0.1.0',
    shortSha: 'abc1234',
    branch: 'main',
  });
});

test('identityFromCIEnv throws when the variables are only partly present', () => {
  assert.throws(() => identityFromCIEnv({ GitVersion_SemVer: '0.1.0' }), VersionResolutionError);
});

test('resolveIdentity prefers the CI variables and does not run GitVersion again', () => {
  let ran = false;
  const id = resolveIdentity({
    env: {
      GitVersion_SemVer: '0.1.0',
      GitVersion_FullSemVer: '0.1.0',
      GitVersion_ShortSha: 'abc1234',
      GitVersion_BranchName: 'main',
    },
    runGitVersion: () => { ran = true; return gv; },
  });
  assert.equal(id.version, '0.1.0');
  assert.equal(ran, false);
});

test('resolveIdentity runs GitVersion when no CI variables exist', () => {
  assert.equal(resolveIdentity({ env: {}, runGitVersion: () => gv }).version, '0.0.1-61');
});

test('resolveIdentity fails loudly when GitVersion cannot run - no fallback version', () => {
  const boom = () => { throw new VersionResolutionError('GitVersion is not available'); };
  assert.throws(() => resolveIdentity({ env: {}, runGitVersion: boom }), /GitVersion is not available/);
});

test('assertVersionMatches passes when versions agree', () => {
  assert.doesNotThrow(() => assertVersionMatches('0.0.1-61', { version: '0.0.1-61' }));
});

test('assertVersionMatches throws for a missing build-info, a missing version, or a mismatch', () => {
  assert.throws(() => assertVersionMatches('0.1.0', null), VersionResolutionError);
  assert.throws(() => assertVersionMatches('0.1.0', {}), VersionResolutionError);
  assert.throws(() => assertVersionMatches('0.1.0', { version: '0.0.1-61' }), /0\.1\.0.*0\.0\.1-61/s);
});

test('findArtifactsMissingVersion flags installers and update manifests without the version', () => {
  const v = '0.0.1-61';
  const good = [
    'Google Chat Desktop Setup 0.0.1-61.exe',
    'Google-Chat-Desktop-0.0.1-61.AppImage',
    'google-chat-desktop_0.0.1-61_amd64.deb',
    'latest.yml',
    'latest-linux.yml',
    'Google Chat Desktop Setup 0.0.1-61.exe.blockmap',
  ];
  // latest*.yml are checked by content, not name - names here are only what the caller lists.
  assert.deepEqual(
    findArtifactsMissingVersion(v, good.filter((n) => !n.startsWith('latest')), {}),
    []
  );
  assert.deepEqual(
    findArtifactsMissingVersion(v, ['Google Chat Desktop Setup 0.1.0.exe', 'x.deb'], {}),
    ['Google Chat Desktop Setup 0.1.0.exe', 'x.deb']
  );
});

test('findArtifactsMissingVersion checks latest*.yml content for the version', () => {
  const v = '0.0.1-61';
  const contents = {
    'latest.yml': 'version: 0.0.1-61\npath: a.exe\n',
    'latest-linux.yml': 'version: 0.1.0\npath: a.AppImage\n',
  };
  assert.deepEqual(
    findArtifactsMissingVersion(v, ['latest.yml', 'latest-linux.yml'], contents),
    ['latest-linux.yml']
  );
});

test('findArtifactsMissingVersion ignores files that are not build artifacts', () => {
  assert.deepEqual(findArtifactsMissingVersion('0.0.1-61', ['builder-debug.yml', 'win-unpacked'], {}), []);
});
