# BUG-10 gate (host launcher): runs scripts/gate-bug10.sh inside a Docker Linux container (the builder image carries
# Node.js). Repo mounted read-only; nothing is written. The steps live in the .sh file, not in an inline string.
# Exit code: 0 = all pass, non-zero = a check failed.
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$image = 'google-chat-desktop-builder:local'
docker run --rm --entrypoint bash -v "${repo}:/src:ro" $image /src/scripts/gate-bug10.sh
exit $LASTEXITCODE
