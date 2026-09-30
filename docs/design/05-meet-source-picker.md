# Screen-Share Source Picker — Wireframes and Spec

<overview>
The app's own picker for choosing which screen or window to share in a call ([FR-16](../business/requirements.md):
"the application never picks a source automatically"). It is a modal child window of the
[call window](04-meet-call-window.md). Flows: [03 F3, F3b](03-meet-flows.md). Shared pieces (status panel
SC-5, interaction states, tokens): [06](06-meet-shared-components.md).

Design Read: a **choose-one-thing dialog** like the screen-share sheet of any conferencing tool — a grid of
labelled thumbnails, two tabs, one primary action, and no pre-selection.

The picker can be **skipped**: on Linux, if Spike B shows the operating system's own picker works (F3b),
the app never creates this window. Everything in the design is contained in this one window, so skipping is "do not open
it"; nothing else in the call flow depends on it.

Legend: `[ Button ]`, `( )` unselected card, `(●)` selected card with check glyph, `(i)` information,
`(!)` warning glyph plus text, callouts `(1)` map to the "What is on it" table.
</overview>

<architecture>
## 1. Wireframes (default size 640×520 CSS px, minimum 400×400, resizable)

### SP-1 Loading (light theme)

```
┌──────────────────────────────────────────────────────────────────────┐
│ Choose what to share — Google Chat Desktop                      [x]  │ (1)
├──────────────────────────────────────────────────────────────────────┤
│ meet.google.com is asking to share your screen or a window.          │ (2)
│ (i) Only what you choose is shared. Nothing is shared until you      │ (3)
│     press Share.                                                     │
│                                                                      │
│  ┌──────────┬──────────┐                                             │
│  │ Screens  │ Windows  │                                [ Refresh ]  │ (4)(5)
│  └──────────┴──────────┘  (Refresh disabled while loading)           │
│  ┌─ ─ ─ ─ ─ ─ ─ ─┐ ┌─ ─ ─ ─ ─ ─ ─ ─┐ ┌─ ─ ─ ─ ─ ─ ─ ─┐              │
│  │ ░░░░░░░░░░░░░ │ │ ░░░░░░░░░░░░░ │ │ ░░░░░░░░░░░░░ │              │ (6) skeleton cards
│  │ ░░░░░░░░░░░░░ │ │ ░░░░░░░░░░░░░ │ │ ░░░░░░░░░░░░░ │
│  └─ ─ ─ ─ ─ ─ ─ ─┘ └─ ─ ─ ─ ─ ─ ─ ─┘ └─ ─ ─ ─ ─ ─ ─ ─┘              │
│  Looking for screens and windows…                                    │
├──────────────────────────────────────────────────────────────────────┤
│ Select a screen or window to share.            [ Cancel ] [ Share ]  │ (7)(8)
│                                                        (disabled)    │
└──────────────────────────────────────────────────────────────────────┘
```

### SP-1 dark theme (full drawing)

```
┌──────────────────────────────────────────────────────────────────────┐  bg #1F1F1F
│ Choose what to share — Google Chat Desktop                      [x]  │  OS title bar
├──────────────────────────────────────────────────────────────────────┤
│ meet.google.com is asking to share your screen or a window.          │  text #F5F5F5
│ (i) Only what you choose is shared. Nothing is shared until you      │  secondary #B3B3B3
│     press Share.                                                     │
│  ┌──────────┬──────────┐                                             │
│  │ Screens  │ Windows  │                            [ Refresh ]      │  Refresh disabled:
│  └──────────┴──────────┘                                             │  text #B3B3B3
│  ┌─ ─ ─ ─ ─ ─ ─ ─┐ ┌─ ─ ─ ─ ─ ─ ─ ─┐ ┌─ ─ ─ ─ ─ ─ ─ ─┐              │  skeleton fill #5A5A5A
│  │ ░░░░░░░░░░░░░ │ │ ░░░░░░░░░░░░░ │ │ ░░░░░░░░░░░░░ │              │  (static, no shimmer)
│  └─ ─ ─ ─ ─ ─ ─ ─┘ └─ ─ ─ ─ ─ ─ ─ ─┘ └─ ─ ─ ─ ─ ─ ─ ─┘              │
│  Looking for screens and windows…                                    │
├──────────────────────────────────────────────────────────────────────┤  border #3B3B3B
│ Select a screen or window to share.            [ Cancel ] [ Share ]  │  Share disabled:
└──────────────────────────────────────────────────────────────────────┘  fill #5A5A5A, text #B3B3B3
```

### SP-2 List, Screens tab, nothing selected (light theme)

```
┌──────────────────────────────────────────────────────────────────────┐
│ Choose what to share — Google Chat Desktop                      [x]  │
├──────────────────────────────────────────────────────────────────────┤
│ meet.google.com is asking to share your screen or a window.          │
│ (i) Only what you choose is shared. Nothing is shared until you      │
│     press Share.                                                     │
│  ┌──────────┬──────────┐                                             │
│  │▌Screens▐ │ Windows  │                                [ Refresh ]  │
│  └──────────┴──────────┘                                             │
│  ┌───────────────────┐  ┌───────────────────┐                        │
│  │                   │  │                   │                        │
│  │   (thumbnail)     │  │   (thumbnail)     │                        │ (6) cards
│  │                   │  │                   │                        │
│  └───────────────────┘  └───────────────────┘                        │
│  ( ) Screen 1 (main)     ( ) Screen 2                                │ (9) label
│      1920 × 1080             2560 × 1440                             │
├──────────────────────────────────────────────────────────────────────┤
│ Select a screen or window to share.            [ Cancel ] [ Share ]  │
│                                                        (disabled)    │
└──────────────────────────────────────────────────────────────────────┘
```

### SP-3 List, Windows tab, one item selected (light theme)

```
│  ┌──────────┬──────────┐                                             │
│  │ Screens  │▌Windows▐ │                                [ Refresh ]  │
│  └──────────┴──────────┘                                             │
│  ┌───────────────┐ ┌═══════════════╗ ┌───────────────┐               │
│  │  (thumbnail)  │ ║  (thumbnail)  ║ │  (thumbnail)  │               │
│  └───────────────┘ ╚═══════════════╝ └───────────────┘               │
│  ( ) [ic] Report.xlsx  (●)[ic] Google Chat  ( ) [ic] Notes –         │
│       – Excel               (check, thick        Notepad             │
│                              border)                                 │
│  ┌───────────────┐ ┌───────────────┐                                 │  region scrolls,
│  │  (thumbnail)  │ │  (thumbnail)  │  …                              │  footer stays fixed
│  ...                                                                 │
├──────────────────────────────────────────────────────────────────────┤
│ Selected: Google Chat                          [ Cancel ] [ Share ]  │ (7)(8) Share enabled
└──────────────────────────────────────────────────────────────────────┘
```

Selection is shown three ways at once: thick `--accent` border, a check glyph on the card, and the
footer text "Selected: <name>". The main Chat window appears in this list like any other window; the
call window itself does not (see §7).

### SP-3 dark theme (full drawing; only the token values change)

```
┌──────────────────────────────────────────────────────────────────────┐  bg #1F1F1F
│ Choose what to share — Google Chat Desktop                      [x]  │  OS title bar
├──────────────────────────────────────────────────────────────────────┤
│ meet.google.com is asking to share your screen or a window.          │  text #F5F5F5
│ (i) Only what you choose is shared. Nothing is shared until you      │  secondary #B3B3B3
│     press Share.                                                     │
│  ┌──────────┬──────────┐                                             │
│  │ Screens  │▌Windows▐ │                                [ Refresh ]  │  active tab underline
│  └──────────┴──────────┘                                             │  accent #479EF5
│  ┌───────────────┐ ┌═══════════════╗ ┌───────────────┐               │  card border
│  │  (thumbnail)  │ ║  (thumbnail)  ║ │  (thumbnail)  │               │  control #8A8A8A;
│  └───────────────┘ ╚═══════════════╝ └───────────────┘               │  selected accent
│  ( ) [ic] Report.xlsx  (●)[ic] Google Chat  ( ) [ic] Notes –         │  #479EF5, 3 px
├──────────────────────────────────────────────────────────────────────┤
│ Selected: Google Chat                          [ Cancel ] [ Share ]  │  Share = accent fill,
└──────────────────────────────────────────────────────────────────────┘  text #1B1B1B
```

### SP-4 Empty: no windows to share (Windows tab)

```
│  ┌──────────┬──────────┐                                             │
│  │ Screens  │▌Windows▐ │                                [ Refresh ]  │
│  └──────────┴──────────┘                                             │
│                                                                      │
│                    (i) No windows to share                           │ (10)
│        Open the window you want to share, then press Refresh.        │
│        You can also share a whole screen from the Screens tab.       │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│ Select a screen or window to share.            [ Cancel ] [ Share ]  │
│                                                        (disabled)    │
```

### SP-5 Empty: nothing found at all

```
│  ┌──────────┬──────────┐                                             │
│  │ Screens  │ Windows  │                                [ Refresh ]  │
│  └──────────┴──────────┘                                             │
│                    (!) Nothing to share was found                    │
│        No screens or windows could be listed. Press Refresh to       │
│        try again, or cancel to go back to the call.                  │
├──────────────────────────────────────────────────────────────────────┤
│ Nothing selected.                              [ Cancel ] [ Share ]  │
│                                                        (disabled)    │
```

### SP-6 Error: the list of screens and windows could not be loaded (light theme)

Generic listing failure, worded to be true on Windows and Linux.

```
┌──────────────────────────────────────────────────────────────────────┐
│ Choose what to share — Google Chat Desktop                      [x]  │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│                                (!)                                   │
│               Couldn't load screens and windows                      │ (11)
│     The list of things you can share couldn't be loaded.             │
│     Nothing has been shared. You can try again or cancel.            │
│                     Code: <error name>                               │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│                                          [ Cancel ]  [ Try again ]   │
└──────────────────────────────────────────────────────────────────────┘
```

### SP-6 dark theme (full drawing)

```
┌──────────────────────────────────────────────────────────────────────┐  bg #1F1F1F
│ Choose what to share — Google Chat Desktop                      [x]  │  OS title bar
├──────────────────────────────────────────────────────────────────────┤
│                                (!)                                   │  --error #F1707B
│               Couldn't load screens and windows                      │  text #F5F5F5
│     The list of things you can share couldn't be loaded.             │  text #F5F5F5
│     Nothing has been shared. You can try again or cancel.            │
│                     Code: <error name>                               │  secondary #B3B3B3
├──────────────────────────────────────────────────────────────────────┤  border #3B3B3B
│                                          [ Cancel ]  [ Try again ]   │  primary accent #479EF5,
└──────────────────────────────────────────────────────────────────────┘  text #1B1B1B
```

No "Open system settings" button and no OS privacy wording: neither Windows nor the Linux desktops in
scope offer a dependable destination or cause the app can name. (The macOS-style permission case is out of
scope; if macOS is ever added it needs its own state.)

### SP-7 Inline error: the selected source disappeared

```
│  ┌───────────────┐ ┌───────────────┐                                 │
│  │  (thumbnail)  │ │  (thumbnail)  │  …                              │
│  ...                                                                 │
├──────────────────────────────────────────────────────────────────────┤
│ (!) That window was closed. Choose another one.  [ Cancel ] [ Share ]│ (7)
│                                                        (disabled)    │
```

The list is refreshed at the same time; the selection is cleared; focus moves to the first card.

### SP-8 Exactly one source returned in total (light theme; happens on Linux with PipeWire when the app picker is used)

A PipeWire session lists only what the user already picked in the desktop's own dialog. With one source
the Screens/Windows split is meaningless, so the tabs are hidden.

```
│ meet.google.com is asking to share your screen or a window.          │
│ (i) Only what you choose is shared. Nothing is shared until you      │
│     press Share.                                                     │
│                                                       [ Refresh ]    │
│  ┌───────────────────┐                                               │
│  │   (thumbnail)     │                                               │
│  └───────────────────┘                                               │
│  ( ) Shared by your desktop                                          │
│      Selected in your desktop's own picker                           │
├──────────────────────────────────────────────────────────────────────┤
│ Select what you want to share.                 [ Cancel ] [ Share ]  │
│                                                        (disabled)    │
```

The single card is **not** pre-selected: the user still selects it and presses Share. Two clicks after the
desktop's dialog is the price of never choosing for the user; it disappears if Spike B allows F3b (the app
picker is then skipped on Linux). With two or more sources the normal tabs return; a tab with no
items uses SP-4.

### SP-0 Linux, operating system picker (app picker skipped) — gap, not designed by the app

```
┌──────────────────────────────────────────────────────────────────────┐
│ OS-drawn screen-share picker (xdg-desktop-portal / PipeWire)         │
│ The app draws nothing. Choose or cancel happens entirely here.       │
└──────────────────────────────────────────────────────────────────────┘
```

**Conditional on Spike B** ([OQ-4](08-meet-open-questions.md)): the amended space rule already permits the
OS picker to replace the app picker on Linux only, if the user still chooses explicitly and nothing is
silent or pre-selected. It applies only if Spike B shows it works; otherwise SP-1…SP-8 is used on Linux
too.

### SP narrow layout (window 400–559 px, or 200 % zoom): cards stack as a single column

```
│ ┌────┐ ( ) Screen 1 (main) · 1920 × 1080        │
│ │thmb│                                           │
│ └────┘                                           │
│ ┌────┐ (●) Google Chat                           │
│ │thmb│                                           │
│ └────┘                                           │
```

## 2. What this window is for

The person is in a call and has asked Meet to present. They decide **what** to reveal to the other
participants: one screen, one window, or nothing. Because it exposes their screen, the window is explicit,
slow to commit by accident, and always cancellable.

## 3. What is on it

| # | Region / control | Content | Notes |
|---|---|---|---|
| 1 | Native title bar | "Choose what to share — Google Chat Desktop"; close (X) only | No minimize, no maximize. Close = Cancel |
| 2 | Origin line | "meet.google.com is asking to share your screen or a window." | Always shows the requesting origin (which is always meet.google.com) |
| 3 | Reassurance | "Only what you choose is shared. Nothing is shared until you press Share." | Static text |
| 4 | Tabs | Screens, Windows | `tablist`; one active; left/right arrow keys switch |
| 5 | Refresh | Button | Reloads the list; disabled while loading |
| 6 | Source cards | Thumbnail (a still image taken when the list loads, not live) plus label | One selectable card per source |
| 7 | Footer status | "Select a screen or window to share." / "Selected: <name>" / error text | Live region, polite |
| 8 | Buttons | Cancel, Share (primary) | Share disabled until one card is selected |
| 9 | Card label | Screens: "Screen N" (+ "(main)"), resolution. Windows: application icon, window title | Long titles truncate with an ellipsis and the full title is in the accessible name and a tooltip |
| 10 | Empty message | Heading + one explanation | SP-4, SP-5 |
| 11 | Error panel | SC-5 pattern: glyph, heading, reason, code | SP-6; replaces tabs and grid |
| 12 | Single-source layout | One card, no tabs, label "Shared by your desktop" | SP-8 |

Grid columns by window width: 3 columns at ≥ 600 px, 2 at 560–599 px, 1 (list rows with a small
thumbnail) below 560 px. The tab panel scrolls; header and footer stay fixed.

## 4. Every state

| State | Trigger | What the user sees | What they can do |
|---|---|---|---|
| SP-1 Loading | Picker opened; sources being listed | Skeleton cards, "Looking for screens and windows…" | Cancel; Refresh and Share disabled |
| SP-2 List, none selected | Sources returned | Cards of the active tab | Select, switch tab, Refresh, Cancel |
| SP-3 List, one selected | A card chosen | Selected card marked, "Selected: <name>" | Share, change selection, Cancel |
| SP-4 Windows empty | Windows tab has zero items | Empty message | Refresh, switch to Screens, Cancel |
| SP-5 Nothing at all | Both lists empty | Empty message | Refresh, Cancel |
| SP-6 Listing failed | The listing call failed or was refused | Error panel (generic wording) | Try again → SP-1; Cancel |
| SP-8 Single source | Exactly one source returned | One card, no tabs | Select it, Share, Refresh, Cancel |
| SP-7 Source gone | Selected source vanished before Share | Inline error in footer, list refreshed, selection cleared | Choose another, Cancel |
| Tab switched | Tab pressed | Other list; selection cleared | As SP-2 |
| Shared | Share pressed with a valid selection | Picker closes; Meet shows presenting | — |
| Cancelled | Cancel, Escape, X | Picker closes; request denied; call window focused | — |

## 5. Behaviour

| Control | Behaviour |
|---|---|
| Card | Click, or Space/Enter when focused, selects it (exactly one). No double-click-to-share: a single accidental double-click must not expose a screen |
| Arrow keys in the card group | Native radio behaviour, accepted and documented: an arrow key moves focus **and selects** that card. This is still a deliberate user action; Share is still required. Tabbing into the group focuses the first card **without selecting it**, so nothing is selected until the user acts |
| Tabs | Switch list; clear selection; no request is made |
| Refresh | Repeats the listing (SP-1 → result). The selection is cleared |
| Share | If the selected source still exists, closes and passes it to Meet. If not, SP-7 |
| Cancel / Escape / X | Denies the request; nothing shared; focus returns to the call window |
| Initial focus | The active tab. Nothing is pre-selected and nothing is pre-focused on a card |
| Modality | Modal to the call window: the call window cannot be interacted with until the picker closes. It does not block the main window, the tray or other apps |
| Close attempt on the call window while open | Never silent: the picker is raised, focused and flashed once (title bar; taskbar button on Windows, urgency hint on Linux) |
| Tray "Show call window", notification click, second Meet link while open | The call window is raised together with the picker; **focus lands on the picker** |
| Tray Exit while open | Exit bypasses the picker block: the picker is closed as part of exiting (request denied, nothing shared), then the normal Exit rules apply (F6). If the user cancels the Exit confirmation the picker is already gone and Meet shows its own "not presenting" state |
| Second request while open | Not expected; if it happens the picker stays as it is and the newer request replaces the older one, which is denied |
| Not wired | System-audio sharing option: not provided; see OQ-7 |

## 6. Accessibility (WCAG 2.2 AA)

- **Semantics.** Tabs follow the ARIA tabs pattern (https://www.w3.org/WAI/ARIA/apg/patterns/tabs/). The
  card grid is a `radiogroup` of native radio inputs styled as cards
  (https://www.w3.org/WAI/ARIA/apg/patterns/radio/), so selection state is exposed with no custom
  role. Native radios select on arrow keys; this is accepted (see Behaviour). Each card's accessible name is its full label, for example "Screen 1, main, 1920 by 1080" or
  "Google Chat, window". Thumbnails are decorative (`alt=""`); the label carries the meaning.
- **Announcements.** Footer status is a polite live region: "12 windows found", "Selected: Google Chat",
  "That window was closed. Choose another one."
- **Keyboard.** Tab order: tabs, Refresh, the current card (one tab stop for the radio group), Cancel,
  Share. Escape cancels. No keyboard trap.
- **Focus visible (2.4.7).** Two-pixel `--focus-ring`, two-pixel offset, on tabs, cards, Refresh, buttons.
- **Target size (2.5.8).** Cards, tabs and buttons at least 44 px in the short dimension.
- **Non-colour selection (1.4.1).** Thick border, check glyph, footer text.
- **Contrast (1.4.3, 1.4.11).** Card boundary `--control-border` is at least 3:1 on `--bg`; selected border
  is `--accent`. Values in [06 §7](06-meet-shared-components.md).
- **Reflow (1.4.10).** One column below 560 px; no horizontal scroll.
- **Reduced motion.** Skeleton is static (no shimmer) in every case; the only motion is the spinner in SC-5
  panels, replaced by static text under `prefers-reduced-motion`.
- **Theme.** Follows the OS theme live, as the Settings window does.

Interaction states (hover, active, focus, cursor) for tabs, cards and buttons: [06 §6](06-meet-shared-components.md).

## 7. Why it is like this

- **No pre-selection.** Any default would be the app choosing for the user. The disabled Share button is
  the price; the persistent footer sentence tells the user why it is disabled, which is why disabling a
  commit button is acceptable here (Windows guidance discourages disabled commit buttons because the
  reason is usually invisible: https://learn.microsoft.com/windows/win32/uxguide/win-dialog-box).
- **Still thumbnails, not live previews.** A live preview of every window is heavy and unnecessary to pick
  one; a thumbnail plus the window title identifies the source.
- **Screens first, windows second.** Sharing a whole screen is the common case and works when the window
  list is empty.
- **Modal to the call window only.** The user must not close the call under an open request, but nothing
  else should freeze.
- **Origin shown.** The user sees which page is asking, matching the exact-origin rule (NFR-07).
- **The call window is left out of the list.** Sharing the window that shows the call produces an endless
  mirror. Whether the shell can identify its own call window in the source list is unverified (OQ-6); if
  it cannot, the card is shown with the label suffix " (this call)" and is still selectable.

## 8. What was not designed, and why

| Not designed | Why |
|---|---|
| Live previews, refresh on a timer | Not needed to choose; manual Refresh is enough |
| Sharing system audio | Not requested (OQ-7) |
| Choosing a screen region or a browser tab | Not part of "screens and windows" |
| An OS-permission state ("Open system settings") | The macOS-style case; macOS is out of scope. No dependable destination on Windows or Linux |
| The OS picker on Linux | Drawn by the OS; only the app picker's absence is designed (SP-0), conditional on Spike B |
| A remembered choice | A source must be chosen explicitly every time |
| Sharing while the picker's own window is a candidate | The picker is not listed |

## 9. What was not verified

- Thumbnail load time and the size of the window list are assumptions; SP-1 is designed for slow lists but
  no real list was timed.
- Contrast values are hand-estimated and were not measured on a rendered build.
- Whether a listing failure (SP-6) is distinguishable from an empty list in the shell's source-listing
  call is unchecked; if not, SP-5 covers both and SP-6 is reserved for an explicit error.
- That a PipeWire session really returns a single source (SP-8) is an assumption from how the desktop's
  own picker works, not observed.
- Nothing was opened in a browser or Electron.
</architecture>

<topics>
- [Flows](03-meet-flows.md)
- [Call window](04-meet-call-window.md)
- [Shared components](06-meet-shared-components.md)
- [Rationale](07-meet-rationale.md)
- [Open questions](08-meet-open-questions.md)
</topics>
