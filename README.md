# google-chat-desktop
Electron desktop client for Google Chat - persistent Google login, native system notifications, tray-minimize.

## Installing

Download the latest installer for your platform from the
[Releases](https://github.com/Retro-kharkov1/google-chat-desktop/releases) page.

- **Windows** — run `Google Chat Desktop Setup <version>.exe`.
- **Linux** — either run the `.AppImage` directly (mark it executable first:
  `chmod +x Google-Chat-Desktop-*.AppImage`), or install the `.deb` package
  (`sudo apt install ./google-chat-desktop_*.deb` or `sudo dpkg -i
  google-chat-desktop_*.deb`).

### A note on the Windows warning

The Windows installer is **not code-signed** (see
[ADR-0003](docs/adr/0003-packaging-and-code-signing-approach.md) for why — in short, a
signing certificate costs money and this is a personal-use tool). The first time you run
the installer, Windows SmartScreen will show **"Windows protected your PC"** with an
"unknown publisher" warning. This is expected, not a sign of a bad build — click **"More
info"**, then **"Run anyway"** to continue. macOS is not built at all (see the same ADR);
Windows and Linux are the only supported platforms.
