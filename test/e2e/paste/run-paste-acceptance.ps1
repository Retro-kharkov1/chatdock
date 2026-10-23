# BUG-11 paste acceptance launcher (host side): builds the runner image and runs the headless Electron paste
# acceptance twice inside Docker Linux containers (Xvfb): tree=fix (the repo's src) and tree=prefix (pre-fix
# editShortcuts.js). Read-only on the repo (mounted :ro); writes to <repo>\artifacts\paste-acceptance\{fix,prefix}.
# Expected verdict: fix = every run row passes; prefix = row 2 (image paste) fails.
# Exit code: 0 = fix passes all run rows AND prefix row 2 fails (the row discriminates); 1 = otherwise; 2 = harness error.
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$root = Join-Path $repo 'artifacts\paste-acceptance'
$image = 'gcd-e2e-paste:local'
docker build -t $image (Join-Path $repo 'test\e2e\paste\docker')
if ($LASTEXITCODE -ne 0) { exit 2 }
$rc = @{}
foreach ($tree in 'fix', 'prefix') {
  $out = Join-Path $root $tree
  New-Item -ItemType Directory -Force $out | Out-Null
  Get-ChildItem $out -File -ErrorAction SilentlyContinue | Remove-Item -Force
  docker run --rm --shm-size=1g -e "GCD_TREE=$tree" -v "${repo}:/src:ro" -v "${out}:/out" -v gcd-e2e-cache:/cache $image bash -c "sed 's/\r$//' /src/test/e2e/paste/in-container.sh > /tmp/run.sh && bash /tmp/run.sh"
  $rc[$tree] = $LASTEXITCODE
  Write-Host "[e2e] tree=$tree exit code $($rc[$tree]); artifacts: $out"
}
$row2prefix = $null
$rowsFile = Join-Path $root 'prefix\rows.json'
if (Test-Path $rowsFile) { $row2prefix = (Get-Content $rowsFile -Raw | ConvertFrom-Json | Where-Object { $_.id -eq '2' }).status }
$summary = "fix exit=$($rc['fix']) prefix exit=$($rc['prefix']) prefix row 2=$row2prefix"
Set-Content -Path (Join-Path $root 'verdict.txt') -Value $summary
Write-Host "[e2e] $summary"
if ($rc['fix'] -eq 2 -or $rc['prefix'] -eq 2) { exit 2 }
if ($rc['fix'] -eq 0 -and $row2prefix -eq 'FAIL') { exit 0 }
exit 1
