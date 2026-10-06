<#
.SYNOPSIS
  Builds the Linux artifacts (AppImage + deb, x64) inside an electron-builder Docker container.

  SUPERSEDED by scripts/docker-build.ps1 / scripts/docker-build.sh (docs/development/build-with-docker.md),
  which need only Docker on the host and also build the Windows installer. This script is kept
  because test/buildVersionWiring.test.js and test/packaging-config.test.js still assert on it;
  remove it together with those assertions.

.DESCRIPTION
  Reuses the electron-builder config already in package.json ("build" / "linux") - no parallel
  build definition. Uses the image documented at
  https://www.electron.build/docs/features/multi-platform-build/ (electronuserland/builder).

  Design points (see docs/development/build-linux-in-docker.md):
  - Version: GitVersion (GitVersion.yml, tool pinned in dotnet-tools.json) runs ON THE HOST via
    scripts/generate-build-info.js, because the container has neither .git nor the .NET SDK. The
    resulting build-info.json is copied into the container and scripts/build.js --from-build-info
    stamps that exact version into the artifact names, latest-linux.yml and app.getVersion().
    There is no version override and no fallback: if GitVersion cannot run, the script fails
    before Docker starts.
  - The repo is mounted READ-ONLY at /src and copied into the container's own filesystem
    (/project) without node_modules/, release/ and .git/, so Windows-built node_modules are
    never reused and the slow Windows bind mount is not used for npm/build I/O.
  - Dependencies are installed inside the container with `npm ci` (lockfile-exact).
  - Only the finished artifacts are written back to <repo>/release (git-ignored).
  - Electron/electron-builder downloads are cached in named Docker volumes.

.PARAMETER Image
  Builder image. Pinned by default; bump deliberately.

.EXAMPLE
  powershell -File scripts/build-linux-docker.ps1
#>
[CmdletBinding()]
param(
  [string]$Image = 'electronuserland/builder:24'
)

$ErrorActionPreference = 'Stop'

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$out = Join-Path $repo 'release'
New-Item -ItemType Directory -Force -Path $out | Out-Null

# Resolve the version with GitVersion on the host (fails loudly; see .DESCRIPTION).
Push-Location $repo
try {
  node scripts/generate-build-info.js
  if ($LASTEXITCODE -ne 0) { throw "GitVersion version resolution failed (exit $LASTEXITCODE); not starting the Docker build." }
} finally { Pop-Location }
$buildInfo = Get-Content (Join-Path $repo 'build-info.json') -Raw | ConvertFrom-Json
Write-Host "Building version $($buildInfo.version) ($($buildInfo.shortSha))"

# LF-only script text: it is executed by bash inside the container, so CRLF must not leak in.
$inner = @(
  'set -euo pipefail',
  'mkdir -p /project && cd /src',
  'tar --exclude=./node_modules --exclude=./release --exclude=./.git -cf - . | tar -xf - -C /project',
  'cd /project',
  # CRLF-checked-out sources are fine for JS; strip CR from any shell scripts defensively.
  "find . -path ./node_modules -prune -o -name '*.sh' -type f -exec sed -i 's/\r$//' {} +",
  'npm ci --no-audit --no-fund',
  'npm test',
  'node scripts/build.js --from-build-info --linux --x64 -c.productName=GoogleChatDesktop --publish never',
  # Remove only previous LINUX artifacts; other platforms' files in release/ (e.g. the Windows installer) stay.
  "rm -rf /out/linux-unpacked /out/latest-linux.yml /out/*.AppImage /out/*.deb",
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
