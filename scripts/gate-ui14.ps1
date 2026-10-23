# UI-14 gate (host launcher): runs scripts/gate-ui14.sh inside a Docker Linux container (the builder image carries
# Node.js). The repo is mounted read-write because the script regenerates src/renderer/help/help.html. The steps live
# in the .sh file, not in an inline string.
# Exit code: 0 = all pass, non-zero = a check failed.
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$image = 'google-chat-desktop-builder:local'
docker run --rm --entrypoint bash -v "${repo}:/src" $image /src/scripts/gate-ui14.sh
exit $LASTEXITCODE
