#!/usr/bin/env bash
# UI-14 gate (runs inside the Docker Linux container).
# Expects the repo mounted READ-WRITE at /src: step 1 regenerates the checked-in help.html from docs/user-guide.md
# (the only file written to the mount). Then a syntax check of the changed JS and only the UI-14 test, the existing
# Google app window tests and the help drift tests, run on a copy in /tmp/w. The full suite is not run.
# Exit code: 0 = all pass, non-zero = a check failed.
set -e
cd /src
node --version
node scripts/build-help.js
node scripts/build-help.js --check
rm -rf /tmp/w
cp -r /src /tmp/w
cd /tmp/w
for f in src/main/printShortcut.js src/main/googleAppWindow.js src/main/index.js test/printShortcut.test.js; do
  node --check "$f"
  echo "check ok: $f"
done
node --test test/printShortcut.test.js test/historyNav.test.js test/zoom.test.js test/googleAppWindow.test.js test/helpBuild.test.js
