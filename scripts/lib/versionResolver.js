'use strict';

// Single place that turns GitVersion output into the build identity every build path stamps.
//
// Owner rule (2026-09-30): GitVersion, configured by the repo's GitVersion.yml, is the ONLY
// version source - local Windows build, Linux Docker build and CI alike. There is deliberately
// NO fallback (no `git describe`, no commit count, no placeholder such as "0.0.0-local"): if
// GitVersion cannot run, resolution throws and the build stops. A fallback that quietly yields a
// different number is how two artifacts end up with versions nobody can compare.
//
// See docs/architecture/packaging-release.md, "Version flow".

const { execFileSync } = require('child_process');

class VersionResolutionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VersionResolutionError';
  }
}

// Plain semver 2.0 (optional pre-release, no build metadata - the stamped version must be
// identical in the file names, latest*.yml and app.getVersion(), and '+' is not filename-safe).
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new VersionResolutionError(`GitVersion output is missing "${label}".`);
  }
  return value.trim();
}

function buildIdentity(semVer, fullSemVer, shortSha, branch) {
  if (!SEMVER.test(semVer)) {
    throw new VersionResolutionError(
      `GitVersion SemVer "${semVer}" is not a plain semantic version (expected e.g. 0.1.0 or 0.0.1-61).`
    );
  }
  return { version: semVer, fullSemVer, shortSha, branch };
}

/** Maps the JSON printed by `gitversion /output json`. Throws on any missing field. */
function identityFromGitVersionJson(json) {
  if (!json || typeof json !== 'object') {
    throw new VersionResolutionError('GitVersion did not return a JSON object.');
  }
  return buildIdentity(
    requireString(json.SemVer, 'SemVer'),
    requireString(json.FullSemVer, 'FullSemVer'),
    requireString(json.ShortSha, 'ShortSha'),
    requireString(json.BranchName, 'BranchName')
  );
}

/**
 * Maps the GitVersion_* variables exported by the gittools/actions gitversion/execute step.
 * Returns null when none are set (not a CI run); throws when only some are set.
 */
function identityFromCIEnv(env) {
  const keys = ['GitVersion_SemVer', 'GitVersion_FullSemVer', 'GitVersion_ShortSha', 'GitVersion_BranchName'];
  if (!keys.some((k) => env[k])) return null;
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) {
    throw new VersionResolutionError(`Incomplete GitVersion CI environment, missing: ${missing.join(', ')}.`);
  }
  return buildIdentity(
    env.GitVersion_SemVer.trim(),
    env.GitVersion_FullSemVer.trim(),
    env.GitVersion_ShortSha.trim(),
    env.GitVersion_BranchName.trim()
  );
}

/** CI variables when present, otherwise `runGitVersion()`. Never returns a guessed identity. */
function resolveIdentity({ env, runGitVersion }) {
  const fromEnv = identityFromCIEnv(env);
  if (fromEnv) return fromEnv;
  return identityFromGitVersionJson(runGitVersion());
}

/**
 * Runs the GitVersion version pinned in dotnet-tools.json (restoring the local tool first; the
 * restore is a no-op once cached). Throws VersionResolutionError with the reason on any failure.
 */
function runGitVersionLocal(repoRoot) {
  const run = (args) =>
    execFileSync('dotnet', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    run(['tool', 'restore']);
    const out = run(['tool', 'run', 'dotnet-gitversion', repoRoot, '/output', 'json']);
    return JSON.parse(out);
  } catch (err) {
    const detail = String((err && err.stderr) || (err && err.message) || err).trim().split('\n').slice(0, 6).join('\n');
    throw new VersionResolutionError(
      'GitVersion could not run. The build version comes only from GitVersion (GitVersion.yml); ' +
        'there is no fallback.\nNeeds the .NET SDK on PATH (https://dotnet.microsoft.com/download) and ' +
        'a full git checkout.\nCause:\n' + detail
    );
  }
}

/** The version electron-builder reported for the package must equal the stamped build version. */
function assertVersionMatches(packageVersion, buildInfo) {
  if (!buildInfo || typeof buildInfo !== 'object' || typeof buildInfo.version !== 'string') {
    throw new VersionResolutionError(
      'build-info.json is missing or has no version. Build with `npm run dist` / `npm run pack` ' +
        '(scripts/build.js), which stamps the GitVersion version.'
    );
  }
  if (packageVersion !== buildInfo.version) {
    throw new VersionResolutionError(
      `Packaged version "${packageVersion}" differs from the GitVersion build version ` +
        `"${buildInfo.version}" in build-info.json. Build with scripts/build.js, or pass ` +
        `-c.extraMetadata.version=${buildInfo.version} to electron-builder.`
    );
  }
}

const ARTIFACT_NAME = /\.(exe|AppImage|deb)$/;
const UPDATE_MANIFEST = /^latest.*\.yml$/;

/**
 * Returns the artifacts whose identity lacks `version`: installers/packages by file name,
 * latest*.yml by content (`contents` maps file name to text). Other files are ignored.
 */
function findArtifactsMissingVersion(version, fileNames, contents) {
  return fileNames.filter((name) => {
    if (ARTIFACT_NAME.test(name)) return !name.includes(version);
    if (UPDATE_MANIFEST.test(name)) {
      const text = contents[name];
      return typeof text !== 'string' || !new RegExp(`^version:\\s*${version.replace(/[.+]/g, '\\$&')}\\s*$`, 'm').test(text);
    }
    return false;
  });
}

module.exports = {
  VersionResolutionError,
  identityFromGitVersionJson,
  identityFromCIEnv,
  resolveIdentity,
  runGitVersionLocal,
  assertVersionMatches,
  findArtifactsMissingVersion,
};
