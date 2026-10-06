#!/usr/bin/env bash
# In-container build driver. Usage: gcd-build [linux|win|all]
#
# Mounts expected:  /src  repository, read-only (including .git)
#                   /out  host release/ folder (writable)
#                   /cache named volume for npm / Electron / NuGet downloads
# Optional env:     HOST_UID, HOST_GID  owner for files written to /out (Linux hosts)
#
# Flow: copy the source into the container's own filesystem -> resolve the version with GitVersion
# from the copied git history -> npm ci -> npm test -> scripts/build.js per target -> copy the
# artifacts to /out. There is no version override and no fallback: if GitVersion cannot run, the
# build stops (owner rule, see scripts/lib/versionResolver.js).
set -euo pipefail

TARGET="${1:-all}"
case "$TARGET" in
  linux | win | all) ;;
  *) echo "usage: gcd-build [linux|win|all]" >&2; exit 2 ;;
esac

SRC=/src
WORK=/project
OUT=/out

step() { printf '\n==> %s\n' "$*"; }
die() { printf '\n[gcd-build] FAILED: %s\n' "$*" >&2; exit 1; }
timed() { # timed <label> <command...>
  local label="$1"; shift
  local t0=$SECONDS
  "$@"
  printf '[gcd-build] %s: %ss\n' "$label" "$((SECONDS - t0))"
}

[ -d "$SRC" ] || die "$SRC is not mounted (mount the repository there, read-only)."
[ -d "$OUT" ] || die "$OUT is not mounted (mount the host release/ folder there)."
[ -d "$SRC/.git" ] || die "$SRC/.git is not a directory. The version comes from git history, so a full clone is required (a git worktree or a source archive will not work)."

# The repository belongs to another uid on the host; the copy below is owned by root, but the
# mounted .git is read by git and GitVersion directly, so trust it.
git config --global --add safe.directory '*'

if [ "$(git -C "$SRC" rev-parse --is-shallow-repository 2>/dev/null || echo false)" = "true" ]; then
  die "the repository is a shallow clone. GitVersion needs the full history and tags: run 'git fetch --unshallow --tags' on the host."
fi

step "Copy source into the container (excluding node_modules, release, secrets, spike scratch)"
rm -rf "$WORK"/* "$WORK"/.[!.]* 2>/dev/null || true
mkdir -p "$WORK"
# --no-same-owner: extracted files belong to root, not to the host uid. A stale host build-info.json
# is excluded on purpose: the version is always resolved here from git.
timed copy bash -c 'tar -C "$0" \
    --exclude=node_modules --exclude=./release --exclude=./build-info.json \
    --exclude="./spike/*/.profile" --exclude="./spike/*/out" \
    --exclude="./.env*" --exclude="*.pem" --exclude="*.pfx" --exclude="*.p12" --exclude="*.key" \
    -cf - . | tar -C "$1" --no-same-owner -xf -' "$SRC" "$WORK"
cd "$WORK"

# Defensive: strip CR from shell scripts checked out with CRLF on a Windows host.
find . -name node_modules -prune -o -name '*.sh' -type f -exec sed -i 's/\r$//' {} +

step "Resolve the version with GitVersion (git history in the copied .git)"
timed gitversion node scripts/generate-build-info.js \
  || die "GitVersion could not produce a version. See the message above; there is no fallback."
VERSION="$(node -p "require('./build-info.json').version")"
printf '[gcd-build] version %s\n' "$VERSION"

step "npm ci"
timed npm-ci npm ci --no-audit --no-fund

step "npm test"
timed tests npm test

# Remove only the previous artifacts of the target being built; other platforms' files in
# release/ are left alone.
publish_linux() {
  rm -rf "$OUT/linux-unpacked" "$OUT/latest-linux.yml" "$OUT"/*.AppImage "$OUT"/*.deb
  cp -v release/*.AppImage release/*.deb release/latest-linux.yml "$OUT"/
  CHOWN_FILES+=("$OUT"/*.AppImage "$OUT"/*.deb "$OUT/latest-linux.yml")
}
publish_win() {
  rm -rf "$OUT/win-unpacked" "$OUT/latest.yml" "$OUT"/*.exe "$OUT"/*.exe.blockmap
  cp -v release/*.exe release/latest.yml "$OUT"/
  if compgen -G 'release/*.exe.blockmap' > /dev/null; then cp -v release/*.exe.blockmap "$OUT"/; fi
  CHOWN_FILES+=("$OUT"/*.exe "$OUT"/*.exe.blockmap "$OUT/latest.yml")
}

CHOWN_FILES=()

if [ "$TARGET" = linux ] || [ "$TARGET" = all ]; then
  step "Build Linux (AppImage + deb)"
  # -c.productName=GoogleChatDesktop: space-free install dir /opt/GoogleChatDesktop (same override as
  # the Linux entry in .github/workflows/release.yml; see docs/development/build-linux-in-docker.md).
  timed build-linux node scripts/build.js --from-build-info --linux --x64 -c.productName=GoogleChatDesktop --publish never
  publish_linux
fi

if [ "$TARGET" = win ] || [ "$TARGET" = all ]; then
  step "Build Windows (NSIS installer, via Wine)"
  timed build-win node scripts/build.js --from-build-info --win --x64 --publish never
  publish_win
fi

if [ -n "${HOST_UID:-}" ] && [ -n "${HOST_GID:-}" ]; then
  chown "$HOST_UID:$HOST_GID" "${CHOWN_FILES[@]}" 2>/dev/null \
    || echo "[gcd-build] warning: could not chown output files to $HOST_UID:$HOST_GID" >&2
fi

step "Artifacts (version $VERSION)"
for f in "${CHOWN_FILES[@]}"; do
  [ -f "$f" ] && printf '%s  %s bytes\n' "$(sha256sum "$f" | cut -d' ' -f1)  $(basename "$f")" "$(stat -c %s "$f")"
done
printf '\n[gcd-build] done: target=%s version=%s total=%ss\n' "$TARGET" "$VERSION" "$SECONDS"
