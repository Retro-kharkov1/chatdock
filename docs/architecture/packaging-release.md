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
  "files": ["src/**/*", "package.json"],
  "win": { "target": ["nsis"] },
  "linux": { "target": ["AppImage"] }
}
```
No `mac` key — macOS is not a build target (ADR-0003). No `win.certificateFile` entry yet — per
ADR-0003, Windows ships unsigned for the initial release. Adding a certificate later is additive
(see ADR-0003's "Revisit trigger"). If macOS is ever reconsidered, re-read ADR-0003's Revision 1
history first — the code-signing-for-notifications requirement doesn't go away with time; adding it
back is a `mac: { target: ["dmg"] }` entry plus the signing secrets, not a redesign.

## GitHub Actions release matrix

Follow `~/.claude/skills/electron-desktop.md` §8's matrix shape (one job per OS, each building
natively on its own runner), scoped to the two in-scope platforms: `windows-latest` and
`ubuntu-latest`. No `macos-latest` job. This is a structural choice, not a shortcut: keeping the
matrix as one-job-per-OS (rather than collapsing to a single combined job) means a `macos-latest`
entry could be added later without restructuring the workflow, if the owner's situation changes —
just a new matrix entry plus ADR-0003's signing secrets. For this repo's initial release, the
Windows signing-related env var (`CSC_LINK`, etc.) is **omitted**, which is what makes that build
unsigned.

## What "installer" means per platform right now (NFR-05)

| Platform | Artifact | Signing status | What the user sees on first run | Does FR-05 (notifications) work? |
|---|---|---|---|---|
| Windows | NSIS `.exe` | Unsigned | SmartScreen "Windows protected your PC" — user clicks "More info" → "Run anyway". | Yes — no signing dependency on this platform. |
| Linux | `.AppImage` | N/A — no signing concept for this format | Runs directly once marked executable (`chmod +x`); some distros show a first-run "untrusted executable" dialog depending on the desktop environment, not an electron-builder concern. | Yes — no signing dependency on this platform. |

macOS is not built — see [ADR-0003](../adr/0003-packaging-and-code-signing-approach.md) for why
(code signing is required for macOS notifications to function at all; the owner doesn't use macOS,
so paying for it was not justified).

Every release's notes state this table's rows explicitly, per the space's
`installers-are-part-of-done` rule — never let the owner discover the SmartScreen warning by
surprise.
</architecture>
