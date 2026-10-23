#!/usr/bin/env bash
# BUG-09 experiment build (runs inside the builder container, entrypoint overridden to bash).
# Builds ONLY the Windows NSIS installer of this worktree. Local artifact: no publish, no upload.
# Mounts: /src = the worktree (read-only), /out = host artifacts/bug09-exp, /cache = the shared download cache.
#
# Deviation from build/docker/entrypoint.sh, on purpose: that driver needs /src/.git to be a directory and resolves the
# version with GitVersion; a git worktree has a .git FILE pointing outside the mount. This throwaway branch is never
# merged, so the version is fixed to 0.1.0-exp.bug09 and written to build-info.json by hand. The full npm test run is
# skipped here (the gate script ran the relevant tests just before).
set -euo pipefail
VERSION="0.1.0-exp.bug09"
WORK=/project
OUT=/out

[ -d /src ] && [ -d "$OUT" ] || { echo "[bug09-exp] /src or /out not mounted" >&2; exit 2; }
rm -rf "$WORK"/* "$WORK"/.[!.]* 2>/dev/null || true
mkdir -p "$WORK"
tar -C /src --exclude=node_modules --exclude=./release --exclude=./build-info.json --exclude=./artifacts --exclude=./.git \
    --exclude="./spike/*/.profile" --exclude="./spike/*/out" --exclude="./.env*" --exclude="*.pem" --exclude="*.pfx" \
    --exclude="*.p12" --exclude="*.key" -cf - . | tar -C "$WORK" --no-same-owner -xf -
cd "$WORK"
find . -name node_modules -prune -o -name '*.sh' -type f -exec sed -i 's/\r$//' {} +

cat > build-info.json <<JSON
{
  "version": "$VERSION",
  "fullSemVer": "$VERSION",
  "shortSha": "d9c0453",
  "branch": "wip/BUG-09-exp",
  "buildSource": "local",
  "builtAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

npm ci --no-audit --no-fund
node scripts/build.js --from-build-info --win --x64 --publish never

rm -f "$OUT"/*.exe
cp -v release/*.exe "$OUT"/
sha256sum "$OUT"/*.exe
echo "[bug09-exp] done version=$VERSION"
