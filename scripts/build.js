'use strict';

// The one entry point that packages the app: `npm run dist`, `npm run pack`, the CI release job
// and the Linux Docker build all go through here, so every artifact carries the same GitVersion
// version.
//
//   node scripts/build.js [--from-build-info] [electron-builder args...]
//
// 1. Stamp: resolve the GitVersion version and write build-info.json (generate-build-info.js).
//    With --from-build-info the existing build-info.json is used as is instead - this is for the
//    Linux Docker build, where GitVersion ran on the host (the container has neither .git nor
//    the .NET SDK) and build-info.json was copied in. It is validated, never derived.
// 2. Package: electron-builder with -c.extraMetadata.version=<version>, which sets
//    package.json's version at pack time, so the installer/deb/AppImage names, latest*.yml,
//    the Windows file/product version and app.getVersion() all agree.
// 3. Verify: every .exe/.AppImage/.deb name and every latest*.yml this run produced must contain
//    the version, otherwise the build fails. (Skipped for --dir, which produces no installers.)

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { generateBuildInfo, OUTPUT_PATH } = require('./generate-build-info.js');
const { generateHelp } = require('./build-help.js');
const { findArtifactsMissingVersion, VersionResolutionError } = require('./lib/versionResolver.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(REPO_ROOT, 'release');

function fail(message) {
  console.error(`[build] FAILED: ${message}`);
  process.exit(1);
}

function loadExistingBuildInfo() {
  let info;
  try {
    info = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
  } catch (err) {
    throw new VersionResolutionError(`--from-build-info needs a readable build-info.json (${err.message}).`);
  }
  if (!info || typeof info.version !== 'string' || !info.version) {
    throw new VersionResolutionError('build-info.json has no version.');
  }
  return info;
}

function snapshot() {
  if (!fs.existsSync(RELEASE_DIR)) return new Map();
  return new Map(fs.readdirSync(RELEASE_DIR).map((n) => [n, fs.statSync(path.join(RELEASE_DIR, n)).mtimeMs]));
}

function main() {
  const args = process.argv.slice(2);
  const fromBuildInfo = args.includes('--from-build-info');
  const builderArgs = args.filter((a) => a !== '--from-build-info');

  let info;
  try {
    info = fromBuildInfo ? loadExistingBuildInfo() : generateBuildInfo();
  } catch (err) {
    return fail(err.message);
  }
  console.log(`[build] version ${info.version} (${info.shortSha}, ${info.buildSource})`);

  // UI-06: regenerate the Help page from docs/user-guide.md so the package carries the current guide.
  // (docs/ is not packaged; src/renderer/help/help.html is, through the `src/**/*` files entry.)
  generateHelp();

  const before = snapshot();
  const cli = require.resolve('electron-builder/out/cli/cli.js');
  const result = spawnSync(
    process.execPath,
    [cli, ...builderArgs, `-c.extraMetadata.version=${info.version}`],
    { cwd: REPO_ROOT, stdio: 'inherit' }
  );
  if (result.status !== 0) return fail(`electron-builder exited with ${result.status === null ? result.signal : result.status}`);

  if (builderArgs.includes('--dir')) return;
  const after = snapshot();
  const produced = [...after.keys()].filter((n) => !before.has(n) || after.get(n) !== before.get(n));
  const contents = {};
  for (const n of produced.filter((x) => /^latest.*\.yml$/.test(x))) {
    contents[n] = fs.readFileSync(path.join(RELEASE_DIR, n), 'utf8');
  }
  const bad = findArtifactsMissingVersion(info.version, produced, contents);
  if (bad.length) return fail(`artifacts without version ${info.version}: ${bad.join(', ')}`);
  console.log(`[build] verified version ${info.version} in: ${produced.filter((n) => /\.(exe|AppImage|deb)$|^latest.*\.yml$/.test(n)).join(', ')}`);
}

main();
