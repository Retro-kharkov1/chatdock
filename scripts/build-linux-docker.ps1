<#
.SYNOPSIS
  Builds the Linux artifacts (AppImage + deb, x64) inside an electron-builder Docker container.

.DESCRIPTION
  Reuses the electron-builder config already in package.json ("build" / "linux") - no parallel
  build definition. Uses the image documented at
  https://www.electron.build/docs/features/multi-platform-build/ (electronuserland/builder).

  Design points (see docs/development/build-linux-in-docker.md):
  - The repo is mounted READ-ONLY at /src and copied into the container's own filesystem
    (/project) without node_modules/, release/, .git/ and build-info.json, so Windows-built
    node_modules are never reused and the slow Windows bind mount is not used for npm/build I/O.
  - Dependencies are installed inside the container with `npm ci` (lockfile-exact).
  - Only the finished artifacts are written back to <repo>/release (git-ignored).
  - Electron/electron-builder downloads are cached in named Docker volumes.

.PARAMETER Version
  Optional. Overrides the artifact/app version at pack time (-c.extraMetadata.version),
  same mechanism as .github/workflows/release.yml.

.PARAMETER Image
  Builder image. Pinned by default; bump deliberately.

.EXAMPLE
  powershell -File scripts/build-linux-docker.ps1
#>
[CmdletBinding()]
param(
  [string]$Version = '',
  [string]$Image = 'electronuserland/builder:24'
)

$ErrorActionPreference = 'Stop'

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$out = Join-Path $repo 'release'
New-Item -ItemType Directory -Force -Path $out | Out-Null

$versionArg = ''
if ($Version) { $versionArg = "-c.extraMetadata.version=$Version" }

# LF-only script text: it is executed by bash inside the container, so CRLF must not leak in.
$inner = @(
  'set -euo pipefail',
  'mkdir -p /project && cd /src',
  'tar --exclude=./node_modules --exclude=./release --exclude=./.git --exclude=./build-info.json -cf - . | tar -xf - -C /project',
  'cd /project',
  # CRLF-checked-out sources are fine for JS; strip CR from any shell scripts defensively.
  "find . -path ./node_modules -prune -o -name '*.sh' -type f -exec sed -i 's/\r$//' {} +",
  'npm ci --no-audit --no-fund',
  'npm test',
  'npm run generate-build-info',
  "npx electron-builder --linux --x64 --publish never $versionArg",
  'rm -rf /out/*',
  'cp -v release/*.AppImage release/*.deb release/latest-linux.yml /out/ 2>/dev/null || cp -v release/*.AppImage release/*.deb /out/'
) -join "`n"

docker run --rm `
  --env ELECTRON_CACHE=/root/.cache/electron `
  --env ELECTRON_BUILDER_CACHE=/root/.cache/electron-builder `
  -v "${repo}:/src:ro" `
  -v "${out}:/out" `
  -v gcd-electron-cache:/root/.cache/electron `
  -v gcd-electron-builder-cache:/root/.cache/electron-builder `
  -v gcd-npm-cache:/root/.npm `
  $Image bash -c $inner

if ($LASTEXITCODE -ne 0) { throw "Docker build failed (exit $LASTEXITCODE)" }
Get-ChildItem $out | Select-Object Name, @{n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } }
