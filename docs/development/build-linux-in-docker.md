# Build for Linux in Docker

Builds the Linux artifacts (AppImage and deb, x64) from the current working tree inside a
container. The only host requirement is Docker (Docker Desktop with the WSL2 backend on Windows).

## Command

```powershell
powershell -File scripts/build-linux-docker.ps1
```

Optional: `-Image` selects another builder image. There is no version parameter: the version always
comes from GitVersion (see "Version" below).

Host requirements: Docker, Node.js and the .NET SDK (the last only to run GitVersion on the host).

Output goes to `release/` (git-ignored; the script first removes only previous Linux artifacts - `*.AppImage`, `*.deb`, `latest-linux.yml`, `linux-unpacked` - and leaves other platforms' files such as the Windows installer): `Google-Chat-Desktop-<version>.AppImage`,
`google-chat-desktop_<version>_amd64.deb`, `latest-linux.yml`. For example
`Google-Chat-Desktop-0.0.1-61.AppImage` and `google-chat-desktop_0.0.1-61_amd64.deb`.

## Version

The same GitVersion configuration as CI (`GitVersion.yml`; tool pinned in `dotnet-tools.json`) runs on
the **host**, because the container has neither `.git` nor the .NET SDK. The script runs
`node scripts/generate-build-info.js`, which writes `build-info.json`; that file is copied into the
container and `node scripts/build.js --from-build-info` stamps its `version` into the artifact names,
`latest-linux.yml` and `app.getVersion()`, then fails the build if any produced name or manifest lacks it.
If GitVersion cannot run, the script stops before Docker starts. Full flow:
[packaging-release.md](../architecture/packaging-release.md), "Version flow".

## How it works

- Uses the existing `build` / `linux` config in `package.json`; no second build definition. The one
  Linux-only difference is `-c.productName=GoogleChatDesktop` on the command line (see
  "Install path and names").
- Image: `electronuserland/builder:24`, per
  <https://www.electron.build/docs/features/multi-platform-build/>.
- The repo is mounted read-only and copied into the container without `node_modules/`,
  `release/` and `.git/` (`build-info.json` is copied on purpose, see "Version"). Dependencies are installed in the container
  (`npm ci`), so Windows-built `node_modules` are never reused and CRLF/permission issues of the
  bind mount do not affect the build. `npm test` runs before packaging.
- Electron and electron-builder downloads are cached in the named volumes
  `gcd-electron-cache`, `gcd-electron-builder-cache` and `gcd-npm-cache`.

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
