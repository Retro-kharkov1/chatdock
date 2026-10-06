#!/usr/bin/env bash
# Builds the installers in a Docker container. Linux / macOS hosts.
#
#   scripts/docker-build.sh [linux|win|all] [--rebuild-image] [--clean-cache]
#
# Output goes to ./release. The only host requirement is Docker; the container carries Node.js,
# Wine and the .NET SDK + GitVersion. Details: docs/development/build-with-docker.md
set -euo pipefail

IMAGE="${GCD_BUILDER_IMAGE:-google-chat-desktop-builder:local}"
CACHE_VOLUME="${GCD_CACHE_VOLUME:-gcd-builder-cache}"
TARGET=all
REBUILD=0
CLEAN=0

usage() {
  cat <<'EOF'
Usage: scripts/docker-build.sh [linux|win|all] [--rebuild-image] [--clean-cache]

  linux            AppImage + deb (x64)
  win              NSIS installer (x64, built with Wine)
  all              both (default)
  --rebuild-image  rebuild the builder image from scratch (pulls a fresh base)
  --clean-cache    delete the download cache volume first
EOF
}

for arg in "$@"; do
  case "$arg" in
    linux | win | all) TARGET="$arg" ;;
    --rebuild-image) REBUILD=1 ;;
    --clean-cache) CLEAN=1 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

command -v docker > /dev/null || { echo "docker not found. Install Docker Engine or Docker Desktop." >&2; exit 1; }
docker info > /dev/null 2>&1 || { echo "Cannot reach the Docker daemon. Is it running, and is your user allowed to use it?" >&2; exit 1; }

if [ "$CLEAN" = 1 ]; then docker volume rm -f "$CACHE_VOLUME" > /dev/null; fi

BUILD_ARGS=()
if [ "$REBUILD" = 1 ]; then BUILD_ARGS+=(--no-cache --pull); fi
echo "==> Building the builder image ($IMAGE)"
docker build "${BUILD_ARGS[@]}" -t "$IMAGE" -f "$REPO/build/docker/Dockerfile" "$REPO/build/docker"

# Create release/ as the current user, otherwise Docker would create it as root.
mkdir -p "$REPO/release"

echo "==> Running the build: target=$TARGET"
docker run --rm \
  --security-opt no-new-privileges \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  -v "$REPO:/src:ro" \
  -v "$REPO/release:/out" \
  -v "$CACHE_VOLUME:/cache" \
  "$IMAGE" "$TARGET"

echo "==> Artifacts in $REPO/release"
ls -l "$REPO/release"
