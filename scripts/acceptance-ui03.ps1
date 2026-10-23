<#
 UI-03 acceptance job. Runs the documented Docker Linux build (scripts/docker-build.ps1 -Target linux),
 prints artifact sha256/sizes, then installs the deb in an ubuntu Docker container and starts the app
 under Xvfb (scripts/acceptance-ui03-smoke.sh). Evidence: release/acceptance-ui03/ (git-ignored).
 Needs Docker Desktop. Exit 0 only if build and smoke both pass.
#>
$ErrorActionPreference = 'Continue'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $repo
Write-Host "== build start $(Get-Date -Format o)"
& powershell -NoProfile -ExecutionPolicy Bypass -File scripts/docker-build.ps1 -Target linux
$rc = $LASTEXITCODE; Write-Host "BUILD_EXIT=$rc"
if ($rc -ne 0) { exit 1 }
$ev = Join-Path $repo 'release\acceptance-ui03'; New-Item -ItemType Directory -Force $ev | Out-Null
Get-ChildItem release -File | Where-Object { $_.Name -match 'AppImage$|\.deb$|latest-linux\.yml$' } |
  ForEach-Object { '{0}  {1} bytes  sha256={2}' -f $_.Name, $_.Length, (Get-FileHash $_.FullName -Algorithm SHA256).Hash } |
  Tee-Object (Join-Path $ev 'artifacts.txt')
Write-Host "== smoke start $(Get-Date -Format o)"
docker run --rm --name gcd-ui03-smoke --security-opt seccomp=unconfined `
  -v "${repo}\release:/deb:ro" -v "${repo}\release:/out" -v "${repo}\scripts:/scripts:ro" `
  ubuntu:24.04 bash /scripts/acceptance-ui03-smoke.sh
$rc = $LASTEXITCODE; Write-Host "SMOKE_EXIT=$rc"; exit $rc
