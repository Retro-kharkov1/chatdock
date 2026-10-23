#!/usr/bin/env bash
# BUG-09 experiment gate (runs inside the Docker Linux container): syntax check of the changed JS, then the new tests
# and the existing tests of the touched modules. Repo mounted read-only at /src; copied to /tmp/w, nothing is written to the mount.
# Exit code: 0 = all pass, non-zero = a check failed.
set -e
cp -r /src /tmp/w
cd /tmp/w
node --version
for f in src/main/expFlags.js src/main/blankPopup.js src/main/meetPermissions.js src/main/session.js src/main/index.js test/bug09Exp.test.js; do
  node --check "$f"
  echo "check ok: $f"
done
node --test test/bug09Exp.test.js test/meetPermissions.test.js test/googlePermissions.test.js test/linkRouter.test.js test/linkRouterSignIn.test.js test/session.test.js test/sessionPermissions.test.js
