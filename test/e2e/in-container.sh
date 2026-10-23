#!/usr/bin/env bash
# BUG-09 acceptance row, in-container driver. Mounts: /src repo (read-only), /out artifacts (writable), /cache volume.
# Copies the repo, installs the Electron version pinned in package.json (runtime only), generates a throwaway
# self-signed TLS certificate for the stub origins, then runs the driver under Xvfb.
set -euo pipefail
WORK=/work/app
RT=/work/rt
TLS=/work/tls
mkdir -p "$WORK" "$RT" "$TLS"
tar -C /src --exclude=node_modules --exclude=./release --exclude=./artifacts --exclude=./.git -cf - . | tar -C "$WORK" --no-same-owner -xf -
EV=$(node -p "require('$WORK/package.json').devDependencies.electron")
echo "[e2e] electron $EV"
cd "$RT"
npm init -y >/dev/null
npm install --no-audit --no-fund "electron@$EV"
if [ ! -f node_modules/electron/path.txt ]; then
  echo "[e2e] electron binary missing after npm install; running its installer explicitly"
  (cd node_modules/electron && node install.js)
fi
ls -la node_modules/electron node_modules/electron/dist 2>&1 | head -30 || true
ELECTRON_BIN=$(node -p "require('$RT/node_modules/electron')")
echo "[e2e] electron binary: $ELECTRON_BIN"
[ -x "$ELECTRON_BIN" ] || { echo "[e2e] electron binary not executable" >&2; exit 2; }
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$TLS/key.pem" -out "$TLS/cert.pem" -days 1 -subj "/CN=stub" \
  -addext "subjectAltName=DNS:chat.google.com,DNS:meet.google.com,DNS:thirdparty.example" 2>/dev/null
export GCD_E2E_RUN=1 GCD_ELECTRON="$ELECTRON_BIN" GCD_APP_DIR="$WORK" GCD_OUT_DIR=/out GCD_CERT_DIR="$TLS"
set +e
xvfb-run -a -s "-screen 0 1280x800x24" node "$WORK/test/e2e/meetMediaAcceptance.js"
rc=$?
chmod -R a+rwX /out 2>/dev/null || true
exit $rc
