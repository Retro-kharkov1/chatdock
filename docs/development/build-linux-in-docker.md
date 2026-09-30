# Build for Linux in Docker

Builds the Linux artifacts (AppImage and deb, x64) from the current working tree inside a
container. The only host requirement is Docker (Docker Desktop with the WSL2 backend on Windows).

## Command

```powershell
powershell -File scripts/build-linux-docker.ps1
```

Optional: `-Version 0.2.0` overrides the artifact version (same `-c.extraMetadata.version`
mechanism as `.github/workflows/release.yml`); `-Image` selects another builder image.

Output goes to `release/` (git-ignored): `Google-Chat-Desktop-<version>.AppImage`,
`google-chat-desktop_<version>_amd64.deb`, `latest-linux.yml`.

## How it works

- Uses the existing `build` / `linux` config in `package.json`; no second build definition. The one
  Linux-only difference is `-c.productName=GoogleChatDesktop` on the command line (see
  "Install path and names").
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

- The deb installs to `/opt/GoogleChatDesktop/` (no spaces) and ships `chrome-sandbox`, which the
  package post-install sets to `root:root` mode `4755` when the kernel does not allow
  unprivileged user namespaces.
- The deb `Depends` field includes `libasound2t64 | libasound2` (ALSA), so `apt install ./...deb`
  pulls it in on a minimal image.

## Install path and names

- electron-builder installs the deb to `/opt/<sanitized productName>`, and only the top-level
  `productName` feeds that; `linux.executableName` changes the binary, desktop-entry and icon
  names only. The earlier `/opt/Google Chat Desktop/` path made the SUID sandbox launch die with
  `failed to execvp: /opt/Google`. Linux builds therefore pass `-c.productName=GoogleChatDesktop`
  (in `scripts/build-linux-docker.ps1` and the Linux matrix entry of `release.yml`). The Windows
  build does not pass it, so the NSIS installer, install directory and `productName` are unchanged.
- The runtime app name (and so the user-data directory) comes from `package.json`, which the
  override does not touch. The desktop entry keeps `Name=Google Chat Desktop` via
  `linux.desktop.entry.Name`.
- `linux.executableName` is `google-chat-desktop`. The AppImage is named explicitly with
  `appImage.artifactName` (`Google-Chat-Desktop-<version>.AppImage`), which now matches the URL
  in `latest-linux.yml`; the deb keeps its default name `google-chat-desktop_<version>_amd64.deb`.
- `deb.depends` **replaces** the default deb dependencies of electron-builder (the `"default"`
  keyword exists only for snap), so the defaults are listed explicitly next to ALSA. If the
  defaults change on an electron-builder upgrade, review that list.
- `test/packaging-config.test.js` guards these settings.

## Running in a container

- Inside Docker, Chromium's own sandbox needs user namespaces, which the default seccomp profile
  blocks. For container smoke tests use `--security-opt seccomp=unconfined`; do not use
  `--no-sandbox` to hide the problem.
