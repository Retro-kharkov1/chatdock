# Build for Linux in Docker

Builds the Linux artifacts (AppImage and deb, x64) from the current working tree inside a
container. The only host requirement is Docker (Docker Desktop with the WSL2 backend on Windows).

## Command

```powershell
powershell -File scripts/build-linux-docker.ps1
```

Optional: `-Version 0.2.0` overrides the artifact version (same `-c.extraMetadata.version`
mechanism as `.github/workflows/release.yml`); `-Image` selects another builder image.

Output goes to `release/` (git-ignored): `Google Chat Desktop-<version>.AppImage`,
`google-chat-desktop_<version>_amd64.deb`, `latest-linux.yml`.

## How it works

- Uses the existing `build` / `linux` config in `package.json`; no second build definition.
- Image: `electronuserland/builder:24`, per
  <https://www.electron.build/docs/features/multi-platform-build/>.
- The repo is mounted read-only and copied into the container without `node_modules/`,
  `release/`, `.git/` and `build-info.json`. Dependencies are installed in the container
  (`npm ci`), so Windows-built `node_modules` are never reused and CRLF/permission issues of the
  bind mount do not affect the build. `npm test` runs before packaging.
- Electron and electron-builder downloads are cached in the named volumes
  `gcd-electron-cache`, `gcd-electron-builder-cache` and `gcd-npm-cache`.
- Because `.git` is excluded, `build-info.json` reports `unknown` branch/sha and version
  `0.0.0-local`. Use the GitHub Actions workflow for release-identity builds.

## Release notes: unsigned artifacts

The Linux artifacts are not signed. The AppImage has no embedded signature, and the deb is not
in a signed apt repository, so `electron-updater` update verification relies on the checksums in
`latest-linux.yml` only.

## Notes on running the result

- The deb installs to `/opt/Google Chat Desktop/` and ships `chrome-sandbox`, which must be
  `root:root` mode `4755` when the kernel does not allow unprivileged user namespaces.
- The deb `Depends` field does not list an ALSA library. On a minimal Ubuntu install the app
  fails with `libasound.so.2: cannot open shared object file`; install `libasound2t64`
  (Ubuntu 24.04) or `libasound2`.
- Inside Docker, Chromium's own sandbox needs user namespaces, which the default seccomp profile
  blocks. For container smoke tests use `--security-opt seccomp=unconfined`; do not use
  `--no-sandbox` to hide the problem.
