# Linux package notes

How to build: see [Build with Docker](build-with-docker.md)
(`scripts/docker-build.sh linux` or `scripts/docker-build.ps1 -Target linux`). That guide covers
prerequisites, versioning and troubleshooting; this page keeps the notes about the Linux
artifacts themselves.

The builder applies the existing `build` / `linux` config in `package.json`; there is no second
build definition. The one Linux-only difference is `-c.productName=GoogleChatDesktop` on the
command line (see "Install path and names"), set in `build/docker/entrypoint.sh` and in the Linux
matrix entry of `release.yml`.

> The older `scripts/build-linux-docker.ps1` (version resolved on the host, Docker needing Node and
> .NET on the host) is superseded by `scripts/docker-build.ps1` and kept only until the tests that
> still reference it are updated.

## Release notes: unsigned artifacts

The Linux artifacts are not signed. The AppImage has no embedded signature, and the deb is not
in a signed apt repository, so `electron-updater` update verification relies on the checksums in
`latest-linux.yml` only.

## Notes on running the result

Linux verification target: WSL2 + WSLg on Windows 11, see
[verify-on-linux-wslg.md](verify-on-linux-wslg.md) (including what it cannot prove).

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
  (in `build/docker/entrypoint.sh` and the Linux matrix entry of `release.yml`). The Windows
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
