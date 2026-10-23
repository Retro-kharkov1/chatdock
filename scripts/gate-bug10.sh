#!/usr/bin/env bash
# BUG-10 gate (runs inside the Docker Linux container): syntax check of the changed JS, then test/mainReload.test.js only.
# Expects the repo mounted read-only at /src. Copies it to /tmp/w; nothing is written to the mount.
# Exit code: 0 = all pass, non-zero = a check failed.
set -e
cp -r /src /tmp/w
cd /tmp/w
node --version
for f in src/main/mainReload.js src/main/index.js test/mainReload.test.js; do
  node --check "$f"
  echo "check ok: $f"
done
node --test test/mainReload.test.js
