# Google Chat Desktop

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Sponsor](https://img.shields.io/badge/Sponsor-GitHub%20Sponsors-EA4AAA?logo=github-sponsors)](https://github.com/sponsors/Retro-kharkov1)

An Electron desktop client for Google Chat on **Windows** and **Linux**. It wraps the Google Chat
web app (`https://chat.google.com/`) in its own window and adds what a browser tab cannot do well.

- **Notifications while hidden.** Close the window and messages still arrive as native system
  notifications; the page keeps running in the background.
- **Tray.** The close button hides the window to the system tray. Click the tray icon to bring it back.
- **Stays logged in.** The Google sign-in session is kept between launches.
- **Quit only from the tray.** The close button never quits; use the tray menu's Exit.

It is a wrapper, not a rewrite: Google Chat runs as-is and the app does not modify the page.

> **Disclaimer.** This is an unofficial project. It is not affiliated with, authorized, or endorsed by
> Google. "Google Chat" is a trademark of Google LLC.

## ☕ Support this project

If this app saves you time, consider supporting its development:

[![Sponsor](https://img.shields.io/badge/Sponsor-GitHub%20Sponsors-EA4AAA?logo=github-sponsors)](https://github.com/sponsors/Retro-kharkov1)

- **Buy Me a Coffee:** [buymeacoffee.com/retro.kharkov](https://buymeacoffee.com/retro.kharkov)
- **USDT (crypto donation):** <!-- TODO: add wallet address once created -->

## Install

Download the latest installer for your platform from the
[Releases](https://github.com/Retro-kharkov1/google-chat-desktop/releases) page.

- **Windows**: run `Google Chat Desktop Setup <version>.exe`.
- **Linux**: either run the `.AppImage` directly (mark it executable first:
  `chmod +x Google-Chat-Desktop-*.AppImage`), or install the `.deb`
  (`sudo apt install ./google-chat-desktop_*.deb`).

macOS is not supported and not built.

### The installers are unsigned

The Windows installer is **not code-signed**, because a signing certificate costs money and this is a
free, personal-scale project (see [ADR-0003](docs/adr/0003-packaging-and-code-signing-approach.md)).
Windows SmartScreen will therefore show **"Windows protected your PC"** with an "unknown publisher"
warning. Click **More info**, then **Run anyway**. The Linux artifacts are unsigned too; update
integrity relies on the checksums published with each release.

## User guide

How to use every feature (tray, notifications, Meet calls, links, settings, troubleshooting):
[User guide](docs/user-guide.md).

## Build from source

Requirements: Node.js 20 or newer. The Windows build also needs the .NET SDK, because the release
version is computed by GitVersion.

```
npm ci
npm start          # run the app from source
npm test           # unit tests
npm run dist       # build the installer for the current OS into release/
```

To build the installers without installing Node.js or .NET, use Docker (Windows, Linux or macOS
host; produces the Windows installer and the Linux AppImage + deb):

```
scripts/docker-build.sh all                              # Linux / macOS
powershell -File scripts/docker-build.ps1 -Target all    # Windows (Docker Desktop)
```

See [Build with Docker](docs/development/build-with-docker.md) for prerequisites, versioning and
troubleshooting.

## Documentation

See [docs/](docs/README.md): requirements, architecture, design and decision records.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
