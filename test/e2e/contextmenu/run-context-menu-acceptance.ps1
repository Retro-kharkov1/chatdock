# UI-08 acceptance table launcher (host side): builds the runner image and runs the headless Electron acceptance
# inside a Docker Linux container (Xvfb, local https stub of the Chat origin, test-only hook in the container's copy).
# Read-only on the repo (mounted :ro); writes logs, screenshots, result.txt, rows.json to <repo>/artifacts/context-menu-acceptance.
# Exit code: 0 = every row passes, 1 = a row failed or was not run, 2 = harness error.
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$out = Join-Path $repo 'artifacts\context-menu-acceptance'
New-Item -ItemType Directory -Force $out | Out-Null
Get-ChildItem $out -File -ErrorAction SilentlyContinue | Remove-Item -Force
$image = 'gcd-e2e-contextmenu:local'
docker build -t $image (Join-Path $repo 'test\e2e\contextmenu\docker')
if ($LASTEXITCODE -ne 0) { exit 2 }
docker run --rm --shm-size=1g -v "${repo}:/src:ro" -v "${out}:/out" -v gcd-e2e-cache:/cache $image bash -c "sed 's/\r$//' /src/test/e2e/contextmenu/in-container.sh > /tmp/run.sh && bash /tmp/run.sh"
$rc = $LASTEXITCODE
Write-Host "[e2e] exit code $rc; artifacts: $out"
exit $rc
