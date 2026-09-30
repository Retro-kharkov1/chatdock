'use strict';

// electron-builder `beforePack` hook: refuses to package when the version electron-builder is
// about to use differs from the GitVersion version in build-info.json. Covers a bare
// `npx electron-builder` (no -c.extraMetadata.version), which would otherwise silently ship the
// placeholder version from package.json. scripts/build.js is the supported entry point.

const fs = require('fs');
const path = require('path');
const { assertVersionMatches } = require('./lib/versionResolver.js');

exports.default = async function beforePack(context) {
  let buildInfo = null;
  try {
    buildInfo = JSON.parse(fs.readFileSync(path.join(context.packager.projectDir, 'build-info.json'), 'utf8'));
  } catch (err) {
    // assertVersionMatches reports the missing file with the fix.
  }
  assertVersionMatches(context.packager.appInfo.version, buildInfo);
};
