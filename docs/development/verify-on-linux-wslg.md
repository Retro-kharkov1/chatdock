# Verify on Linux (WSL2 + WSLg)

The Linux verification target is **WSL2 + WSLg on Windows 11** (decision
2026-09-30). It runs a real Linux userland and kernel with a GUI shown on the Windows desktop.
Linux packages are built in Docker ([build-linux-in-docker.md](build-linux-in-docker.md)); this page
covers running and probing them.

## What WSLg is, and is not

WSLg is **not a native Linux desktop**. Weston (a Wayland compositor) plus Xwayland run inside a
system distro and project windows to Windows over RDP. Consequences, checked on 2026-10-02
(WSL2 + WSLg on Windows 11):

| Area | In WSLg | Effect on verification |
|---|---|---|
| Display | X11 (`DISPLAY=:0`) and Wayland (`wayland-0`) both present; `XDG_SESSION_TYPE` is empty | Both Ozone backends can be run: `--ozone-platform=x11` or `wayland` |
| Screen capture portal | Weston has no `zwlr_screencopy_manager_v1`, so no `xdg-desktop-portal` ScreenCast backend can start (`xdg-desktop-portal-wlr` fails with "Compositor doesn't support zwlr_screencopy_manager_v1"; GNOME/KDE backends need their own compositor) | **The OS screen-share picker cannot be verified here.** Verify it on GNOME/KDE with PipeWire before enabling it |
| Camera | No `/dev/video*` (no USB passthrough by default) | Camera capture is not testable; `getUserMedia({video})` fails with `NotFoundError` |
| Microphone / speaker | PulseAudio server at `/mnt/wslg/PulseServer` with `RDPSource` / `RDPSink` | Mic capture works and its release is observable with `pactl list short source-outputs` |
| Notifications, tray, autostart | Depend on a desktop shell WSLg does not have | Not representative of GNOME/KDE; verify elsewhere |
| GPU / DRM | No DRM render node under Wayland (`drmGetDevices2() has not found any devices`) | Software rendering; GPU behaviour is not representative |
| Window list for capture | Wayland session lists screens only; X11 lists screens and windows | Window-share behaviour differs from a real Wayland desktop |

## One-time setup (Ubuntu 24.04 distro)

```bash
sudo apt-get update
sudo apt-get install -y libasound2t64 libxss1 libxtst6 libnotify4 libcups2t64 libxkbcommon0 \
  libatspi2.0-0t64 libdrm2 pulseaudio-utils
# Node 22.12 or newer is required to install the electron npm package (Ubuntu's nodejs 18 is too old)
curl -fsSL https://nodejs.org/dist/v22.20.0/node-v22.20.0-linux-x64.tar.xz -o node.txz
mkdir -p ~/node22 && tar -xJf node.txz -C ~/node22 --strip-components=1
```

Keep the working copy on the WSL filesystem (`~/...`), not under `/mnt/c`: it is much faster and
avoids permission problems.

## Run the packaged Linux build

The AppImage and deb in `release/` (see the Docker build page) can be started from WSL:

```bash
chmod +x /mnt/c/<repo>/release/Google-Chat-Desktop-*.AppImage
/mnt/c/<repo>/release/Google-Chat-Desktop-*.AppImage --appimage-extract-and-run
```

Not exercised in the 2026-10-02 session; the Meet harness below was.

## Run the Meet harness (Spike B)

Copy `spike/meet/{main.js,picker.html,picker-preload.js,package.json}` and
`src/main/{session.js,origins.js}` into `~/spike-b/` keeping the relative layout, then:

```bash
cd ~/spike-b && export PATH=~/node22/bin:$PATH
npm i electron@44.4.3
./node_modules/.bin/electron spike/meet --mode=auto --ozone-platform=x11      # or wayland
./node_modules/.bin/electron spike/meet --ozone-platform=x11                  # live, maintainer checklist
```

Results land in `spike/meet/out/` (`auto-results.json`, `spike-b.log`). Camera and microphone release
is read from PulseAudio source-outputs and `/dev/video*` (see `linuxDevices` in `main.js`).
Findings and their limits: [ADR-0004](../adr/0004-desktop-shell-technology-and-electron-retention.md),
section "Spike B result".

## What WSLg cannot replace

Before claiming Linux support for a feature in the list below, check it on a native Linux desktop
(GNOME on Wayland and an X11 session at minimum): OS screen-share picker via PipeWire, camera,
tray icon, native notifications, autostart, GPU rendering, window-manager specifics (focus, close
behaviour).
