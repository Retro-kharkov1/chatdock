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
project is a personal-use, private-repo desktop client, which is the owner's
call to make, not this task's. Evoking the form is also just the better
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

| File | Build target | Wiring (electron-developer's job, not done here) |
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
been scaffolded), and wiring dependencies into it is `electron-developer`'s
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
  `master.svg` — tighter crop (less dead space around the mark, since tray
  icons benefit from filling more of a much smaller canvas) and a heavier
  ring stroke / larger nucleus (11px → 12.5px stroke, 7.5 → 8.5 radius) so
  the interior mark doesn't thin out to invisibility once anti-aliased down
  to 16px.
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

Rendered every generated file (not just the SVG sources) via `sharp` at
its real target resolution, composited onto both a light (`#ECECEC`) and a
dark (`#1E1E1E`/`#202020`) synthetic desktop background, and visually
inspected the result — reported in the task response, not just "the script
exited 0". Confirmed `assets/icons/icon.ico` actually contains all seven
claimed frame sizes (16/24/32/48/64/128/256) by reading it back with Pillow,
not by trusting the generation step.

## Open design question left for the owner / electron-developer

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
`electron-developer` wires it up, the owner needs to actually decide the
open question the requirements doc already flags, otherwise the muted icon
ships as a dead, unreachable asset. Recommend closing that open question
before, not during, the icon-wiring task.
