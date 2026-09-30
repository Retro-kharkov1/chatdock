'use strict';

// Generates `build-info.json` at the repo root - the per-build identity read by the tray menu's
// version line (src/main/version.js) and by scripts/build.js, which stamps the same version into
// the installer names, file properties, latest*.yml and app.getVersion().
//
// Contract (a consumer depends on these exact field names):
//   {
//     "version":     string  // GitVersion SemVer, e.g. "0.0.1-61" or "0.1.0" - THE build version
//     "fullSemVer":  string  // GitVersion FullSemVer (diagnostic)
//     "shortSha":    string  // 7-char short commit SHA
//     "branch":      string  // branch name
//     "buildSource": "ci" | "local"
//     "builtAt":     string  // ISO-8601 UTC timestamp of when this file was generated
//   }
//
// Version source: GitVersion only, configured by GitVersion.yml (see versionResolver.js). In CI
// the gittools/actions step already ran GitVersion and exported GitVersion_* variables; locally
// the GitVersion tool pinned in dotnet-tools.json is run. There is NO fallback: on any failure
// this script prints the reason and exits 1, so a build can never ship an unstamped version.

const fs = require('fs');
const path = require('path');
const {
  resolveIdentity,
  runGitVersionLocal,
} = require('./lib/versionResolver.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const OUTPUT_PATH = path.join(REPO_ROOT, 'build-info.json');

function isCI(env) {
  return env.CI === 'true' || env.CI === '1';
}

/** Resolves the identity via GitVersion, writes build-info.json, returns the object written. */
function generateBuildInfo({ env = process.env, repoRoot = REPO_ROOT, outputPath = OUTPUT_PATH } = {}) {
  const identity = resolveIdentity({ env, runGitVersion: () => runGitVersionLocal(repoRoot) });
  const buildInfo = {
    version: identity.version,
    fullSemVer: identity.fullSemVer,
    shortSha: identity.shortSha,
    branch: identity.branch,
    buildSource: isCI(env) ? 'ci' : 'local',
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(outputPath, JSON.stringify(buildInfo, null, 2) + '\n', 'utf8');
  return buildInfo;
}

module.exports = { generateBuildInfo, OUTPUT_PATH };

if (require.main === module) {
  try {
    const info = generateBuildInfo();
    console.log(`[generate-build-info] wrote ${OUTPUT_PATH}`);
    console.log(`[generate-build-info] ${JSON.stringify(info)}`);
  } catch (err) {
    console.error(`[generate-build-info] FAILED: ${err.message}`);
    process.exit(1);
  }
}
