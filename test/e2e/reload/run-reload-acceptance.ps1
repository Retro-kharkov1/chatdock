# BUG-10 reload acceptance launcher (host side): builds the runner image and runs the headless Electron reload
# acceptance twice inside Docker Linux containers (Xvfb): tree=fix (the repo's src) and tree=prefix (the same src with the
# mainReload wiring removed, derived in the container by prefixTransform.js). Read-only on the repo (mounted :ro); writes
# to <repo>\artifacts\reload-acceptance\{fix,prefix}.
# Expected verdict: fix = every run row passes; prefix = rows 1, 2, 3, 4 fail (row 5 is a guard and passes on both).
# Exit code: 0 = fix passes all run rows AND prefix rows 1-4 all fail (the rows discriminate); 1 = otherwise; 2 = harness error.
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$root = Join-Path $repo 'artifacts\reload-acceptance'
$image = 'gcd-e2e-reload:local'
docker build -t $image (Join-Path $repo 'test\e2e\reload\docker')
if ($LASTEXITCODE -ne 0) { exit 2 }
$rc = @{}
foreach ($tree in 'fix', 'prefix') {
  $out = Join-Path $root $tree
  New-Item -ItemType Directory -Force $out | Out-Null
  Get-ChildItem $out -File -ErrorAction SilentlyContinue | Remove-Item -Force
  docker run --rm --shm-size=1g -e "GCD_TREE=$tree" -v "${repo}:/src:ro" -v "${out}:/out" -v gcd-e2e-cache:/cache $image bash -c "sed 's/\r$//' /src/test/e2e/reload/in-container.sh > /tmp/run.sh && bash /tmp/run.sh"
  $rc[$tree] = $LASTEXITCODE
  Write-Host "[e2e] tree=$tree exit code $($rc[$tree]); artifacts: $out"
}
$prefixStatus = @{}
$rowsFile = Join-Path $root 'prefix\rows.json'
if (Test-Path $rowsFile) { Get-Content $rowsFile -Raw | ConvertFrom-Json | ForEach-Object { $prefixStatus[$_.id] = $_.status } }
$fixStatus = @{}
$fixRows = Join-Path $root 'fix\rows.json'
if (Test-Path $fixRows) { Get-Content $fixRows -Raw | ConvertFrom-Json | ForEach-Object { $fixStatus[$_.id] = $_.status } }
$fixTxt = ($fixStatus.Keys | Sort-Object | ForEach-Object { "r$_=$($fixStatus[$_])" }) -join ' '
$preTxt = ($prefixStatus.Keys | Sort-Object | ForEach-Object { "r$_=$($prefixStatus[$_])" }) -join ' '
$summary = "fix exit=$($rc['fix']) [$fixTxt]; prefix exit=$($rc['prefix']) [$preTxt]"
Set-Content -Path (Join-Path $root 'verdict.txt') -Value $summary
Write-Host "[e2e] $summary"
if ($rc['fix'] -eq 2 -or $rc['prefix'] -eq 2) { exit 2 }
$discriminates = ('1', '2', '3', '4' | Where-Object { $prefixStatus[$_] -eq 'FAIL' }).Count -eq 4
if ($rc['fix'] -eq 0 -and $discriminates) { exit 0 }
exit 1
