# BUG-09 acceptance row launcher (host side): builds the runner image and runs the headless Electron
# acceptance inside a Docker Linux container (Xvfb, Chromium fake media devices, stub Chat/Meet origins).
# Read-only on the repo (mounted :ro); writes screenshots/logs to <repo>/artifacts/meet-media-acceptance.
# Exit code: 0 = all checks pass, 1 = a check failed, 2 = harness error.
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$out = Join-Path $repo 'artifacts\meet-media-acceptance'
New-Item -ItemType Directory -Force $out | Out-Null
Get-ChildItem $out -File -ErrorAction SilentlyContinue | Remove-Item -Force
$image = 'gcd-e2e-electron:local'
docker build -t $image (Join-Path $repo 'test\e2e\docker')
if ($LASTEXITCODE -ne 0) { exit 2 }
docker run --rm --shm-size=1g -v "${repo}:/src:ro" -v "${out}:/out" -v gcd-e2e-cache:/cache $image bash -c "sed 's/\r$//' /src/test/e2e/in-container.sh > /tmp/run.sh && bash /tmp/run.sh"
$rc = $LASTEXITCODE
Write-Host "[e2e] exit code $rc; artifacts: $out"
exit $rc
