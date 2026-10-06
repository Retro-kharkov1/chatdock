<#
.SYNOPSIS
  Builds the installers (Windows NSIS, Linux AppImage + deb) in a Docker container.
  Windows hosts with Docker Desktop (also runs on PowerShell 7 on Linux/macOS).

.DESCRIPTION
  The only host requirement is Docker. The container carries Node.js, Wine and the .NET SDK +
  GitVersion; the version is computed inside it from the repository's git history (no fallback).
  Output goes to <repo>\release. See docs/development/build-with-docker.md.

.PARAMETER Target
  linux | win | all (default all).

.PARAMETER RebuildImage
  Rebuild the builder image from scratch (pulls a fresh base).

.PARAMETER CleanCache
  Delete the download cache volume first.

.EXAMPLE
  powershell -File scripts/docker-build.ps1 -Target all
#>
[CmdletBinding()]
param(
  [ValidateSet('linux', 'win', 'all')]
  [string]$Target = 'all',
  [switch]$RebuildImage,
  [switch]$CleanCache
)

$ErrorActionPreference = 'Stop'

$image = if ($env:GCD_BUILDER_IMAGE) { $env:GCD_BUILDER_IMAGE } else { 'google-chat-desktop-builder:local' }
$cacheVolume = if ($env:GCD_CACHE_VOLUME) { $env:GCD_CACHE_VOLUME } else { 'gcd-builder-cache' }
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$out = Join-Path $repo 'release'
$sw = [Diagnostics.Stopwatch]::StartNew()

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw 'docker not found. Install Docker Desktop (WSL2 backend) and start it.'
}
docker info *> $null
if ($LASTEXITCODE -ne 0) { throw 'Cannot reach the Docker daemon. Start Docker Desktop and wait until it reports "running".' }

if ($CleanCache) { docker volume rm -f $cacheVolume | Out-Null }

$buildArgs = @()
if ($RebuildImage) { $buildArgs += @('--no-cache', '--pull') }
Write-Host "==> Building the builder image ($image)"
docker build @buildArgs -t $image -f (Join-Path $repo 'build\docker\Dockerfile') (Join-Path $repo 'build\docker')
if ($LASTEXITCODE -ne 0) { throw "Image build failed (exit $LASTEXITCODE)" }

New-Item -ItemType Directory -Force -Path $out | Out-Null

Write-Host "==> Running the build: target=$Target"
$runArgs = @('--rm', '--security-opt', 'no-new-privileges')
# On a Linux/macOS host running PowerShell, keep output owned by the invoking user.
if (-not $IsWindows -and $PSVersionTable.PSVersion.Major -ge 6) {
  $runArgs += @('-e', "HOST_UID=$(id -u)", '-e', "HOST_GID=$(id -g)")
}
docker run @runArgs `
  -v "${repo}:/src:ro" `
  -v "${out}:/out" `
  -v "${cacheVolume}:/cache" `
  $image $Target
if ($LASTEXITCODE -ne 0) { throw "Docker build failed (exit $LASTEXITCODE)" }

Write-Host "==> Artifacts in $out (total $([math]::Round($sw.Elapsed.TotalMinutes, 1)) min)"
Get-ChildItem $out -File | Select-Object Name, @{ n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } }
