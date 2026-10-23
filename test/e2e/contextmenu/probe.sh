#!/usr/bin/env bash
# UI-08 spellcheck probe, in-container: installs the pinned Electron, runs spellProbe/main.js under Xvfb. Mounts: /src repo (ro), /cache.
set -euo pipefail
mkdir -p /work/rt /work/p && cp /src/test/e2e/contextmenu/spellProbe/*.js /work/p/
EV=$(node -p "require('/src/package.json').devDependencies.electron")
cd /work/rt && npm init -y >/dev/null && npm install --no-audit --no-fund "electron@$EV" >/dev/null
[ -f node_modules/electron/path.txt ] || (cd node_modules/electron && node install.js)
BIN=$(node -p "require('/work/rt/node_modules/electron')")
export GCD_DICT_FILE=/cache/en-US-10-1.bdic
echo "[probe] electron $EV"
timeout 300 xvfb-run -a -s "-screen 0 1280x800x24" "$BIN" --no-sandbox /work/p/main.js 2>&1 | grep -v -E "dbus|DBus|libva|vaapi|GPU|gpu|ERROR:.*(viz|gl_)" || true
