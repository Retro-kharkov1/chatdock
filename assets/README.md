# Icon assets

A single hybrid mark — Google Chat's speech bubble fused with Electron's
orbit/nucleus motif — as the source of every app, installer and tray icon
this project needs. See `assets/src/master.svg` for the design rationale in
comments; the short version: the tail is an orbit-trail curl (not a plain
speech-bubble nub), and the interior ring + nucleus dot are Electron's atom
motif doing the bubble's only interior mark, clipped to the bubble body so
the two motifs resolve into one silhouette instead of two shapes glued
together.

Trademark note: this is a deliberate *evocation* of the Google Chat bubble
form (rounded-square silhouette + tail), not a redrawing of Google's actual
logo — no Google artwork, color codes, or wordmark were copied. That
distinction matters because "Google Chat" is Google's trademark; this
project is an independent, unofficial desktop client; the maintainer should
confirm the trademark position before any wider distribution. Evoking the form is also just the better
design outcome here — a hybrid mark that only worked by being a literal copy
of someone else's logo wouldn't be a hybrid.

## Directory layout

```
assets/
  src/            hand-authored SVG sources — the only files ever hand-edited
    master.svg          full mark, 128x128 viewBox — source for all app/installer icons
    mark-tray.svg        tight-cropped, heavier-stroke variant — source for all tray icons
    badge-unread.svg      small halo dot, composited onto the tray mark's corner
    badge-muted.svg        small halo crescent, composited onto the tray mark's corner
  icons/          generated — app / installer icons (regenerate, don't hand-edit)
  tray/           generated — tray icon variants (regenerate, don't hand-edit)
scripts/
  generate-icons.js   regenerates everything in assets/icons/ and assets/tray/ from assets/src/
```

## What consumes what

| File | Build target | Wiring (the implementer's job, not done here) |
|---|---|---|
| `assets/icons/icon.ico` | Windows app icon + NSIS installer icon | `electron-builder.yml` / `package.json` → `build.win.icon` |
| `assets/icons/icon.png` (512×512) | Linux AppImage icon | `build.linux.icon` (electron-builder also accepts a `build/icons/` directory of multiple PNG sizes — `icon-16.png` … `icon-512.png` are provided for that form too) |
| `assets/tray/tray-normal.ico`, `tray-normal-<size>.png` | Default tray icon | `new Tray(...)` in `src/main/tray.js`, per [`tray-lifecycle.md`](../docs/architecture/tray-lifecycle.md) |
| `assets/tray/tray-unread.ico`, `tray-unread-<size>.png` | Tray icon while unread messages are pending, **Linux only** (Windows carries the unread signal on the taskbar overlay instead — see below) | swapped in wherever `setTrayUnread(n)` is implemented, per [`notifications.md`](../docs/architecture/notifications.md)'s "Tray unread indicator" section |
| `assets/tray/overlay-unread-16.png`, `overlay-unread-32.png` | Windows taskbar overlay badge on the **main window**, not the tray icon | `BrowserWindow.setOverlayIcon(icon, 'Unread messages')` / `setOverlayIcon(null, '')` to clear — this is the mechanism `notifications.md` names explicitly for Windows; the small size is deliberate, `setOverlayIcon` composites onto the corner of the existing taskbar icon |
| `assets/tray/tray-muted.ico`, `tray-muted-<size>.png` | Tray icon for a muted / quiet-hours state | **not yet wired to anything — see "Open design question" below** |

macOS assets (`.icns`) are intentionally **not produced** — macOS is out of
scope per [`packaging-release.md`](../docs/architecture/packaging-release.md)
and [ADR-0003](../docs/adr/0003-packaging-and-code-signing-approach.md).

## Regenerating

The script needs `sharp` (SVG rasterization) and `png-to-ico` (multi-res
`.ico` packing) as devDependencies. They are deliberately **not** added to
this repo's own `package.json` — that file doesn't exist yet (the app hasn't
been scaffolded), and wiring dependencies into it is the implementer's
call, not this task's. Once a `package.json` exists:

```sh
npm install --save-dev sharp png-to-ico
node scripts/generate-icons.js
```

The script is idempotent and side-effect-free outside `assets/icons/` and
`assets/tray/` — re-running it after any edit to `assets/src/*.svg` is the
only supported way those directories change. Never hand-edit a generated
PNG/ICO; edit the source SVG and regenerate.

## Design decisions

- **Palette is deliberately two colors**, not a blend of Google's four brand
  colors and Electron's teal: a single confident green (`#149960`, chosen to
  read unambiguously as "chat/message" the way Google's, WhatsApp's and
  Telegram's own icons all lean on saturated green/blue) for the silhouette,
  and white for the interior ring + nucleus. Both source brands are cool
  hues; a green digit alongside a teal digit at 16px stops being two colors
  and starts being one smear, which is why the accent is white instead of
  literally Electron-teal — the Electron reference lives in the *shape*
  (orbit ring + nucleus), not in a second competing hue.
- **The orbit ring is clipped to the bubble body** (`clip-path` referencing
  the same rounded-rect the silhouette uses) rather than drawn as a free
  ellipse overlapping the edge — this is what keeps ring + bubble + tail
  reading as one object instead of "a bubble with an atom icon dropped on
  top."
- **The tail is an orbit-trail curl**, not a triangular speech-bubble nub —
  it shares the silhouette's fill and overlaps the bubble body enough that
  no seam is visible at any rendered size, satisfying the brief's "orbit
  paths do structural work" requirement literally at the tail, not just
  figuratively at the ring.
- **`mark-tray.svg` is a separate source file**, not a downscale of
  `master.svg` — its own viewBox crop and a heavier ring stroke / larger
  nucleus so the interior mark doesn't thin out to invisibility once
  anti-aliased down to 16px.
- **2026-09-22 revision — the mark now fills the canvas much more
  aggressively**, after maintainer feedback that it read as "small and floating"
  at real desktop/tray size. Both source SVGs were rescaled: `master.svg`'s
  geometry was uniformly scaled ~1.23× and re-centered on its 128×128
  viewBox (alpha-bbox occupancy measured on the generated PNGs: **71%×69% →
  88%×85%** at every size from 16px to 512px — a consistent, size-independent
  jump because it lives in the shared source geometry, not a per-size
  script parameter). `mark-tray.svg` reuses that same rescaled geometry with
  its own independently-tuned, deliberately asymmetric `0 0 124 124`
  viewBox crop (more room on the left, where the tail tip sits, than the
  right) — tuned against real generated pixels, not geometry alone: a
  symmetric `126×126` crop, and later a symmetric `124×124` crop centered
  exactly on the shared bounding box, each produced a 16px PNG whose alpha
  channel's bounding box touched 100% of the canvas on one axis (a real,
  reproduced edge-touch caught by reading the generated pixels back). The
  shipped asymmetric `0 0 124 124` crop is the one that measured a genuine
  margin on every axis across every generated tray size
  (16/20/22/24/32/48px — see Verification below). Badge size/offset in
  `generate-icons.js` were left unchanged and re-verified against the
  larger base mark — still read correctly at 16px with the ring/nucleus
  intact under both the unread and muted badges.
- **Badges are rendered fresh at each target size** and composited onto a
  freshly-rendered base at that same size (see `compositeBadge` in
  `generate-icons.js`) — never scaled down from one large composite — and
  sized/positioned to mostly overflow the mark's corner (~40% of the badge
  diameter, offset so more than half sits outside the icon's own bounds).
  An earlier pass sized the badge at ~50% of the icon and centered it near
  the ring; it visually ate the nucleus and made the base mark unreadable
  once a badge was present. Verified against the corrected version.
- **Unread and muted are differentiated by shape, not only color**
  (red dot vs. gray crescent) — a colorblind user or a compressed/low-color
  desktop theme still gets the distinction. This follows the same principle
  `accessibility-wcag` applies to any status/error signal: never color-only.

## Verification performed

Same bar both times this asset set was built: render the generated files
(never the SVG sources directly), composite them onto real light/dark
backgrounds, and look at them — never trust a clean script exit alone.

**Current revision (fill-the-canvas pass, 2026-09-22):**
- Rendered every generated file via `sharp` at its real target resolution
  (16/24/32/48/256 for the app icon; 16/20/22/24/32/48 for all three tray
  states), composited onto a light (`#ECECEC`) and a dark (`#202020`)
  synthetic desktop background, and visually inspected the result as
  contact sheets and a direct before/after side-by-side at 256px.
- Measured the actual glyph occupancy (alpha-channel bounding box as a
  percentage of canvas) on the generated PNGs, not estimated from the SVG
  source: app icon **71.1%×68.8% → 87.5%×85.2%** at 256px, consistent
  (87.5%±3pp on both axes) from 16px through 512px — a decisive, uniform
  jump, not a per-size tweak. Tray-normal was already tight going in
  (93.8%×93.8% at 16px) and the goal was "bigger everywhere, never smaller
  anywhere, never touching the edge": final measured occupancy across every
  tray size is 90.6%–95.8% on one axis and 89.6%–93.8% on the other
  (16/20/22/24/32/48px), with **no size on any axis measuring 100%** — i.e.
  no edge-touch — after two rejected intermediate crops each *did* measure
  a 100% (edge-touching) alpha bbox at 16px and were backed off before
  shipping (see the design-decisions entry above for the exact numbers).
- Re-confirmed `assets/icons/icon.ico` still contains all seven claimed
  frame sizes ((16,16) through (256,256)) by reading it back with Pillow
  after regeneration, not by trusting the script's exit code.
- Re-checked the unread (red dot) and muted (gray crescent) tray states
  specifically at 16px against the larger base mark: both badges still sit
  in the corner without covering the nucleus or breaking the ring, on both
  backgrounds.

**Original build:** rendered every generated file via `sharp` at its real
target resolution, composited onto light/dark backgrounds, and visually
inspected the result. Confirmed `icon.ico`'s frame sizes with Pillow.

## Open design question left for the maintainer / implementer

The brief for this asset set asked for a "muted / quiet-hours" tray state,
and the assets exist (`tray-muted.ico`, `tray-muted-<size>.png`). But
`docs/architecture/tray-lifecycle.md` and `docs/business/requirements.md`
(FR-07) currently say the opposite of what the muted icon implies is live:
"Mute notifications" is explicitly flagged as **unrequested scope, not
implemented**, and `docs/business/requirements.md`'s "Open question —
notification sound/quiet-hours behavior" section confirms quiet-hours is an
open question, not a decided feature. So this asset is forward-looking, not
tied to an existing trigger — nothing in the current docs calls
`setTrayUnread`-style code to swap in `tray-muted`. Before
the implementer wires it up, the maintainer needs to actually decide the
open question the requirements doc already flags, otherwise the muted icon
ships as a dead, unreachable asset. Recommend closing that open question
before, not during, the icon-wiring task.
