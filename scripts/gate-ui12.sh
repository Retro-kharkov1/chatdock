#!/usr/bin/env bash
# UI-12 gate (runs inside the Docker Linux container).
# Expects the repo mounted READ-WRITE at /src: step 1 regenerates the checked-in help.html from docs/user-guide.md
# (the only file written to the mount). Then a syntax check of the changed JS and only the UI-12 test, the existing
# downloads tests and the help drift tests, run on a copy in /tmp/w. The full suite is not run.
# Exit code: 0 = all pass, non-zero = a check failed.
set -e
cd /src
node --version
node scripts/build-help.js
node scripts/build-help.js --check
rm -rf /tmp/w
cp -r /src /tmp/w
cd /tmp/w
for f in src/main/downloads.js src/main/index.js test/downloadsFeedback.test.js; do
  node --check "$f"
  echo "check ok: $f"
done
node --test test/downloadsFeedback.test.js test/downloads.test.js test/downloadsSignIn.test.js test/helpBuild.test.js
