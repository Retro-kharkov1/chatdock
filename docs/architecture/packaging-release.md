# Packaging & Release (FR-09, NFR-05)

<overview>
The decision and its tradeoffs live in
[ADR-0003](../adr/0003-packaging-and-code-signing-approach.md) — read that first. This doc is the
concrete `electron-builder` configuration and CI shape. **Target platforms: Windows and Linux only**
— macOS is out of scope, an owner decision recorded in ADR-0003 (code signing required for macOS
notifications to work at all, and the owner doesn't use macOS, so there is no one to benefit from
the recurring Apple Developer Program cost).
</overview>

<architecture>
## electron-builder configuration (`package.json` → `"build"`, or `electron-builder.yml`)

```json
{
  "appId": "dev.retro-kharkov1.google-chat-desktop",
  "productName": "Google Chat Desktop",
  "directories": { "output": "release" },
  "files": ["src/**/*", "assets/icons/**/*", "assets/tray/**/*", "package.json"],
  "publish": { "provider": "github" },
  "win": { "target": ["nsis"], "icon": "assets/icons/icon.ico" },
  "nsis": {
    "oneClick": false,
    "allowToChangeInstallationDirectory": true,
    "createDesktopShortcut": true,
    "createStartMenuShortcut": true
  },
  "linux": {
    "target": ["AppImage", "deb"],
    "icon": "assets/icons/icon.png",
    "category": "Network",
    "maintainer": "95210642+Retro-kharkov1@users.noreply.github.com",
    "executableName": "google-chat-desktop",
    "desktop": { "entry": { "Name": "Google Chat Desktop", "StartupWMClass": "Google Chat Desktop" } }
  },
  "deb": { "depends": ["libgtk-3-0", "libnotify4", "libnss3", "libxss1", "libxtst6",
                       "xdg-utils", "libatspi2.0-0", "libuuid1", "libsecret-1-0",
                       "libasound2t64 | libasound2"] },
  "appImage": { "artifactName": "Google-Chat-Desktop-${version}.${ext}" }
}
```
`package.json` `"build"` is the authority; this listing mirrors it as of 2026-09-30 except that it omits
`build-info.json` from `files` (which `package.json` includes). The Linux CI leg additionally passes `-c.productName=GoogleChatDesktop`
so the `.deb` installs to `/opt/GoogleChatDesktop/` (no space); the Windows build does not.

**NFR-08 (Linux install path, executable name, audio dependency) is already implemented and documented
in [build-linux-in-docker.md](../development/build-linux-in-docker.md), "Install path and names"; that file
is its single home and this one does not repeat it.** What this document adds is what remains **unverified**
against NFR-08's scenarios:
- The **AppImage artifact name** has no spaces (`Google-Chat-Desktop-<version>.AppImage`); the
  directory a user puts it in and the product name in launchers are out of NFR-08's scope.
- The **autostart entry's `Exec` path** for both artifacts (the AppImage case is an open item, see
  [tray-lifecycle.md](tray-lifecycle.md) "Start at login").
- The **install-and-launch on a clean Debian/Ubuntu system** and the **audible sound** scenarios are
  environment checks: the Linux leg has never run outside Docker or CI (see the untested-leg note below),
  and `test/packaging-config.test.js` guards configuration, not the installed result. Which package supplies
  the audio dependency is stated by the implementer (currently `libasound2t64 | libasound2`).
No `mac` key — macOS is not a build target (ADR-0003). No `win.certificateFile` entry yet — per
ADR-0003, Windows ships unsigned for the initial release. Adding a certificate later is additive
(see ADR-0003's "Revisit trigger"). If macOS is ever reconsidered, re-read ADR-0003's Revision 1
history first — the code-signing-for-notifications requirement doesn't go away with time; adding it
back is a `mac: { target: ["dmg"] }` entry plus the signing secrets, not a redesign.

**Linux ships two targets, not one:**
- **AppImage** — a single self-contained executable that runs on any modern distro without
  installation; the "works everywhere, no package manager involved" option.
- **deb** — a proper `apt`/`dpkg`-installable package for Debian/Ubuntu-family systems, which is
  the Linux the owner is actually likely to run. It integrates with the system's application menu
  and package database the way AppImage deliberately does not.

Building a `.deb` requires two `linux` keys that AppImage does not need — they are **load-bearing,
not decoration**, and omitting them breaks the deb build:
- `category` — the freedesktop.org menu category (`"Network"` here) the installed app is filed
  under in the desktop environment's application menu.
- `maintainer` — required by Debian packaging metadata (the `Maintainer:` control-file field);
  electron-builder refuses to produce a `.deb` without it.

## Version flow

**One version, from GitVersion only, on every build path.** `GitVersion.yml` (workflow `GitHubFlow/v1`)
is the single configuration. `package.json` `version` (`0.1.0`) is a placeholder that is never
shipped: it is overridden at pack time. There is **no fallback** (no `git describe`, no commit count, no
`0.0.0-local`); if GitVersion cannot run, the build fails with the reason.

| Path | How GitVersion runs | Entry point |
|---|---|---|
| Windows, local | `dotnet tool run dotnet-gitversion`, tool pinned in `dotnet-tools.json` (6.8.2; CI uses `6.8.x`). Needs the .NET SDK on PATH and a full checkout. `dotnet tool restore` is run automatically. | `npm run dist` / `npm run pack` |
| Linux, Docker | On the **host** (the container has no `.git` and no .NET SDK), then `build-info.json` is copied in and validated, not re-derived. | `scripts/build-linux-docker.ps1` |
| CI | `gittools/actions/gitversion/execute` exports `GitVersion_*`; the script reads them. | `node scripts/build.js` in `release.yml` |

Why a local .NET tool rather than GitVersion's Docker image: Windows `npm run dist` would then need
Docker, and the pin in a committed manifest is what makes local and CI versions comparable.

`scripts/build.js` does three things: (1) writes `build-info.json` (`scripts/generate-build-info.js`);
(2) runs electron-builder with `-c.extraMetadata.version=<SemVer>`; (3) fails the build if any produced
`.exe`/`.AppImage`/`.deb` name or `latest*.yml` `version:` lacks that version. A `beforePack` hook
(`scripts/beforePack.js`) also refuses to package when the version differs from `build-info.json`, which
catches a bare `npx electron-builder` that would otherwise ship the placeholder.

The stamped value is GitVersion's `SemVer`. It appears in: the installer/deb/AppImage file names,
`latest*.yml`, the Windows exe File/Product version, `app.getVersion()`, `build-info.json` `version` and
the tray line (FR-13, `<version> (<shortSha>, <ci|local>)`). The field contract is in the header of
`scripts/generate-build-info.js`.

Numbers: with no tag, the version is `0.0.1-<commits since start>` (e.g. `0.0.1-61`), which rises with
every commit on `main`. Tag `v0.1.0` and that commit builds as `0.1.0`; later commits become
`0.1.1-<n>`. Two builds of the **same commit** get the same version (uncommitted edits do not change it);
`build-info.json` `builtAt` and the short SHA still tell them apart. Shallow clones break GitVersion, so
CI keeps `fetch-depth: 0`.

## GitHub Actions release matrix

Follow `~/.claude/skills/electron-desktop.md` §8's matrix shape (one job per OS, each building
natively on its own runner), scoped to the two in-scope platforms: `windows-latest` and
`ubuntu-latest`. No `macos-latest` job. This is a structural choice, not a shortcut: keeping the
matrix as one-job-per-OS (rather than collapsing to a single combined job) means a `macos-latest`
entry could be added later without restructuring the workflow, if the owner's situation changes —
just a new matrix entry plus ADR-0003's signing secrets. For this repo's initial release, the
Windows signing-related env var (`CSC_LINK`, etc.) is **omitted**, which is what makes that build
unsigned.

There is no dedicated third-party "electron-builder" GitHub Action pinned in this workflow. The
first-party guidance at `electron.build/docs/features/github-actions/` (checked 2026-09-22) is to
run electron-builder directly — `npx electron-builder <platform-flag> --publish always` on a tag
push, `--publish never` otherwise — rather than depend on a third-party Action whose name/ownership
could move. `.github/workflows/release.yml` runs `node scripts/build.js` (which calls electron-builder, see "Version flow") for both matrix legs.

**The Linux leg cannot be built on this repo's Windows development machine.** AppImage packaging
needs Linux-native tooling (`mksquashfs`); a real local build attempt on Windows fails with
`mksquashfs process failed ENOENT`. In practice this means the Linux artifacts are produced only by
the `ubuntu-latest` job in the GitHub Actions matrix, and **that leg is untested until the release
workflow has actually run once** — this is a real, current gap, not a theoretical one, and should
not be assumed verified before the first tagged release completes.

## What "installer" means per platform right now (NFR-05)

| Platform | Artifact | Signing status | What the user sees on first run | Does FR-05 (notifications) work? |
|---|---|---|---|---|
| Windows | NSIS `.exe` | Unsigned | SmartScreen "Windows protected your PC" — user clicks "More info" → "Run anyway". | No signing dependency on this platform. FR-05a delivery: the BUG-01 fix (main-process re-raise of Chat's notifications) is implemented and verified in a harness on Windows 11; **not yet confirmed against a real signed-in Chat**, so "works" is not claimed for a release until a real toast from real Chat is observed. |
| Linux | `.AppImage` and `.deb` | N/A — no signing concept for either format | AppImage runs directly once marked executable (`chmod +x`); some distros show a first-run "untrusted executable" dialog depending on the desktop environment. `.deb` installs via the distro's normal package manager (`apt install ./*.deb` or a GUI installer) with no first-run warning at all. Neither is an electron-builder concern. | No signing dependency for either artifact. Real delivery (libnotify) has never been verified in this repo. |

macOS is not built — see [ADR-0003](../adr/0003-packaging-and-code-signing-approach.md) for why
(code signing is required for macOS notifications to function at all; the owner doesn't use macOS,
so paying for it was not justified).

Every release's notes state this table's rows explicitly, per the space's
`installers-are-part-of-done` rule — never let the owner discover the SmartScreen warning by
surprise.

### Release notes must also state (2026-09-30 requirements)

- **Meet (FR-16):** whether the `[manual-only]` Meet scenarios (login carry-over, camera and microphone,
  screen share, device release on close) were re-run for this release and on which platform. Meet in an
  embedded browser is unsupported by Google and can break on a user-agent or embedding change, so "not
  re-verified" must be written, not omitted.
- **Notifications (FR-05):** which platform the real-toast and real-click checks were run on. A Windows pass
  does not cover Linux.
- **Windows toast identity:** the toast header and per-app notification settings depend on the AppUserModelID
  (see "Windows toast identity" below); a change to `appId` or the runtime AUMID must be called out
  because it can orphan the user's notification settings.

## Windows toast identity (AppUserModelID) and the dev seam

- **Packaged AUMID = `build.appId`**, `dev.retro-kharkov1.google-chat-desktop`, unchanged for installed
  users. **A dev (unpackaged) run uses the same string plus `.dev`**, so it cannot impersonate the installed
  app (shared Action Center grouping, header "Electron"). Implemented in `src/main/appIdentity.js`.
- **The id is a string literal in `appIdentity.js` and is never read from `package.json` at runtime:**
  electron-builder **strips the `build` block** from the `package.json` it ships inside `app.asar`, so
  `require('../../package.json').build.appId` throws in a packaged build (found by running the packaged
  app). `package.json` `build.appId` remains the single source of truth; `test/appIdentity.test.js` fails if
  the two ever differ. Any code that needs a `build`-block value at runtime must not read it from the
  packaged `package.json`.
- **Do not change the packaged value**: renaming an AUMID orphans the per-app notification settings of
  installed users.
- **Dev-only test seam `GCD_DEV_START_URL`** (`src/main/origins.js`): honoured only when `app.isPackaged` is
  false, only for a loopback `http` URL (`localhost` or `127.0.0.1`) with no userinfo; it points the window at
  a local harness page and adds that origin to the navigation and notification allowlists. Never active in a
  packaged build, so it adds nothing to the released artifact's attack surface.
</architecture>
