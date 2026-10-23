#!/usr/bin/env bash
# BUG-10 reload acceptance, in-container driver. Mounts: /src repo (read-only), /out artifacts (writable), /cache volume.
# Env: GCD_TREE=fix (the repo's own src, default) or GCD_TREE=prefix (src without the BUG-10 wiring).
# The prefix tree is DERIVED from the fix tree inside the container copy (the repo is untouched): src/main/mainReload.js is
# deleted and prefixTransform.js removes the three index.js pieces BUG-10 added (the require and the create/bind/dispose
# block). It fails loudly when the anchors are not found or any "mainReload" text remains.
# Copies the repo, points the COPY's package.json "main" at the test-only hook, installs the Electron version pinned in
# package.json (runtime only), generates a throwaway self-signed TLS certificate, runs the driver under Xvfb.
set -euo pipefail
TREE="${GCD_TREE:-fix}"
WORK=/work/app
RT=/work/rt
TLS=/work/tls
mkdir -p "$WORK" "$RT" "$TLS"
tar -C /src --exclude=node_modules --exclude=./release --exclude=./artifacts --exclude=./.git -cf - . | tar -C "$WORK" --no-same-owner -xf -
if [ "$TREE" = "prefix" ]; then
  node "$WORK/test/e2e/reload/prefixTransform.js" "$WORK/src/main/index.js"
  rm -f "$WORK/src/main/mainReload.js"
  if grep -rq "mainReload" "$WORK/src"; then echo "[e2e] prefix tree still references mainReload" >&2; exit 2; fi
  echo "[e2e] tree=prefix: index.js without mainReload wiring, mainReload.js removed"
else
  echo "[e2e] tree=fix: src as in the repo (mainReload.js sha256 $(sha256sum "$WORK/src/main/mainReload.js" | cut -c1-16))"
fi
node -e "const f='$WORK/package.json';const p=require(f);p.main='test/e2e/reload/hookMain.js';require('fs').writeFileSync(f,JSON.stringify(p,null,2));"
EV=$(node -p "require('$WORK/package.json').devDependencies.electron")
echo "[e2e] electron $EV"
cd "$RT"
npm init -y >/dev/null
npm install --no-audit --no-fund "electron@$EV"
if [ ! -f node_modules/electron/path.txt ]; then
  (cd node_modules/electron && node install.js)
fi
ELECTRON_BIN=$(node -p "require('$RT/node_modules/electron')")
echo "[e2e] electron binary: $ELECTRON_BIN"
[ -x "$ELECTRON_BIN" ] || { echo "[e2e] electron binary not executable" >&2; exit 2; }

openssl req -x509 -newkey rsa:2048 -nodes -keyout "$TLS/key.pem" -out "$TLS/cert.pem" -days 1 -subj "/CN=stub" \
  -addext "subjectAltName=DNS:chat.google.com,DNS:accounts.google.com,DNS:other.example" 2>/dev/null
export GCD_E2E_RUN=1 GCD_TREE="$TREE" GCD_ELECTRON="$ELECTRON_BIN" GCD_ELECTRON_VERSION="$EV" GCD_APP_DIR="$WORK" GCD_OUT_DIR=/out GCD_CERT_DIR="$TLS"
set +e
xvfb-run -a -s "-screen 0 1280x800x24" node "$WORK/test/e2e/reload/reloadAcceptance.js"
rc=$?
chmod -R a+rwX /out 2>/dev/null || true
exit $rc
