# BUG-09 experiment: gate first, then the Windows NSIS installer, built from THIS worktree in a Docker Linux container.
# Local artifact only (artifacts\bug09-exp): no release, no upload, no tag. Why not scripts\docker-build.ps1: it builds the
# tree it runs from, but its entrypoint requires a real .git directory and GitVersion; a worktree has neither
# (see the header of build-bug09-exp.sh). Exit code: 0 = gate and build passed.
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$out = Join-Path $repo 'artifacts\bug09-exp'
$image = 'google-chat-desktop-builder:local'
$cache = if ($env:GCD_CACHE_VOLUME) { $env:GCD_CACHE_VOLUME } else { 'gcd-builder-cache' }

Write-Host '==> Gate'
& (Join-Path $PSScriptRoot 'gate-bug09-exp.ps1')
if ($LASTEXITCODE -ne 0) { throw "Gate failed (exit $LASTEXITCODE); no build" }

New-Item -ItemType Directory -Force -Path $out | Out-Null
Write-Host '==> Build (win NSIS)'
docker run --rm --security-opt no-new-privileges --entrypoint bash `
  -v "${repo}:/src:ro" -v "${out}:/out" -v "${cache}:/cache" `
  $image /src/scripts/build-bug09-exp.sh
if ($LASTEXITCODE -ne 0) { throw "Build failed (exit $LASTEXITCODE)" }
Get-ChildItem $out -File | Select-Object Name, @{ n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } }
