#!/usr/bin/env bash
# BUG-09 network-evidence gate (runs inside the Docker Linux container): syntax check of the changed JS, then the tests.
# Expects the repo mounted read-only at /src. Copies it to /tmp/w; nothing is written to the mount.
# Exit code: 0 = all pass, non-zero = a check failed.
set -e
cp -r /src /tmp/w
cd /tmp/w
node --version
for f in src/main/callDiagnostics.js src/main/index.js test/callDiagnosticsNet.test.js; do
  node --check "$f"
  echo "check ok: $f"
done
node --test test/callDiagnosticsNet.test.js test/callDiagnostics.test.js test/diagLog.test.js
