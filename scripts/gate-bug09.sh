#!/usr/bin/env bash
# BUG-09 gate (runs inside the Docker Linux container): syntax check of the changed JS, then the new/affected tests.
# Expects the repo mounted read-only at /src. Copies it to /tmp/w; nothing is written to the mount.
# Exit code: 0 = all pass, non-zero = a check failed.
set -e
cp -r /src /tmp/w
cd /tmp/w
node --version
for f in src/main/callDiagnostics.js src/main/linkRouter.js src/main/index.js test/callDiagnostics.test.js; do
  node --check "$f"
  echo "check ok: $f"
done
node --test test/callDiagnostics.test.js test/diagLog.test.js test/linkRouter.test.js test/linkRouterSignIn.test.js
