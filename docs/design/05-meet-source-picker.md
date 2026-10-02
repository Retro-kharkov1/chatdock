# Screen-Share Source Picker — Wireframes and Spec

<overview>
The one surface the application draws for Google Meet: the picker for choosing which screen or window to
share in a call ([FR-16](../business/requirements.md): the application never picks a source
automatically). It is a **modal child window of the call window**. The call window itself contains only the
Meet page. Everything else Meet-related the application says (close and exit confirmations, the "call
already open" notification, the tray entry, the crash dialog) is native; see
[06-meet-native-wording.md](06-meet-native-wording.md).

Design Read: a **choose-one-thing dialog** like the screen-share sheet of any conferencing tool — a grid of
labelled thumbnails, two tabs, one primary action, and no pre-selection.

On **Linux the application's own picker is used** (the desktop portal's picker is unverified and not part
of this scope; see FR-16).

Legend: `[ Button ]`, `( )` unselected card, `(●)` selected card with check glyph, `(i)` information,
`(!)` warning glyph plus text. Wireframes are drawn light; dark uses the same layout with the tokens in §6.
</overview>

<architecture>
## 1. Wireframes (default size 640×520 CSS px, minimum 400×400, resizable)

### SP-1 Loading

Shown at once when Meet asks to share. Listing sources takes 3 to 8 s on Windows (Spike B), so the window
never waits for the list before appearing.

```
┌──────────────────────────────────────────────────────────────────────┐
│ Choose what to share — Google Chat Desktop                      [x]  │
├──────────────────────────────────────────────────────────────────────┤
│ meet.google.com is asking to share your screen or a window.          │
│ (i) Only what you choose is shared. Nothing is shared until you      │
│     press Share.                                                     │
│                                                                      │
│  ┌──────────┬──────────┐                                             │
│  │ Screens  │ Windows  │                                [ Refresh ]  │
│  └──────────┴──────────┘  (Refresh disabled while loading)           │
│  ┌─ ─ ─ ─ ─ ─ ─ ─┐ ┌─ ─ ─ ─ ─ ─ ─ ─┐ ┌─ ─ ─ ─ ─ ─ ─ ─┐              │
│  │ ░░░░░░░░░░░░░ │ │ ░░░░░░░░░░░░░ │ │ ░░░░░░░░░░░░░ │              │ skeleton cards
│  └─ ─ ─ ─ ─ ─ ─ ─┘ └─ ─ ─ ─ ─ ─ ─ ─┘ └─ ─ ─ ─ ─ ─ ─ ─┘              │
│  Looking for screens and windows…                                    │
├──────────────────────────────────────────────────────────────────────┤
│ Select a screen or window to share.            [ Cancel ] [ Share ]  │
│                                                        (disabled)    │
└──────────────────────────────────────────────────────────────────────┘
```

### SP-2 List, nothing selected (Screens tab)

```
│  ┌──────────┬──────────┐                                             │
│  │▌Screens▐ │ Windows  │                                [ Refresh ]  │
│  └──────────┴──────────┘                                             │
│  ┌───────────────────┐  ┌───────────────────┐                        │
│  │   (thumbnail)     │  │   (thumbnail)     │                        │
│  └───────────────────┘  └───────────────────┘                        │
│  ( ) Screen 1 (main)     ( ) Screen 2                                │
│      1920 × 1080             2560 × 1440                             │
├──────────────────────────────────────────────────────────────────────┤
│ Select a screen or window to share.            [ Cancel ] [ Share ]  │
│                                                        (disabled)    │
```

### SP-3 List, one item selected (Windows tab)

```
│  ┌──────────┬──────────┐                                             │
│  │ Screens  │▌Windows▐ │                                [ Refresh ]  │
│  └──────────┴──────────┘                                             │
│  ┌───────────────┐ ┌═══════════════╗ ┌───────────────┐               │
│  │  (thumbnail)  │ ║  (thumbnail)  ║ │  (thumbnail)  │               │
│  └───────────────┘ ╚═══════════════╝ └───────────────┘               │
│  ( ) [ic] Report.xlsx  (●)[ic] Google Chat  ( ) [ic] Notes –         │
│       – Excel                                    Notepad             │
├──────────────────────────────────────────────────────────────────────┤
│ Selected: Google Chat                          [ Cancel ] [ Share ]  │
└──────────────────────────────────────────────────────────────────────┘
```

Selection is shown three ways at once: thick `--accent` border, a check glyph on the card, and the footer
text "Selected: <name>". The main Chat window appears in the list like any other window.

### SP-4 Empty

Windows tab with no items (Screens tab still works):

```
│                    (i) No windows to share                           │
│        Open the window you want to share, then press Refresh.        │
│        You can also share a whole screen from the Screens tab.       │
```

Nothing found at all (both lists empty):

```
│                    (!) Nothing to share was found                    │
│        No screens or windows could be listed. Press Refresh to       │
│        try again, or cancel to go back to the call.                  │
├──────────────────────────────────────────────────────────────────────┤
│ Nothing selected.                              [ Cancel ] [ Share ]  │
```

### SP-5 Error: the list could not be loaded

Generic wording, true on Windows and Linux. Replaces the tabs and grid.

```
│                                (!)                                   │
│               Couldn't load screens and windows                      │
│     The list of things you can share couldn't be loaded.             │
│     Nothing has been shared. You can try again or cancel.            │
│                     Code: <error name>                               │
├──────────────────────────────────────────────────────────────────────┤
│                                          [ Cancel ]  [ Try again ]   │
```

No "Open system settings" button: neither Windows nor the Linux desktops in scope offer a dependable
destination.

### SP-6 Inline error: the selected source disappeared

```
├──────────────────────────────────────────────────────────────────────┤
│ (!) That window was closed. Choose another one.  [ Cancel ] [ Share ]│
│                                                        (disabled)    │
```

The list is refreshed at the same time; the selection is cleared; focus moves to the first card.

### Narrow layout (window 400 to 559 px, or 200 % zoom): one column of rows, small thumbnail plus label.

## 2. What is on it

| Region / control | Content | Notes |
|---|---|---|
| Native title bar | "Choose what to share — Google Chat Desktop"; close (X) only | No minimize, no maximize. Close = Cancel |
| Origin line | "meet.google.com is asking to share your screen or a window." | Always the requesting origin |
| Reassurance | "Only what you choose is shared. Nothing is shared until you press Share." | Static text |
| Tabs | Screens, Windows | One active; left/right arrow keys switch |
| Refresh | Button | Repeats the listing; disabled while loading |
| Source cards | Still thumbnail (taken when the list loads, not live) plus label | One selectable card per source. Screens: "Screen N" (+ "(main)"), resolution. Windows: application icon, window title; long titles truncate and the full title is the accessible name |
| Footer status | "Select a screen or window to share." / "Selected: <name>" / error text | Polite live region |
| Buttons | Cancel, Share (primary) | Share disabled until one card is selected |

Grid columns: 3 at 600 px and wider, 2 at 560 to 599 px, 1 below 560 px. The list scrolls; header and
footer stay fixed.

## 3. States and behaviour

| State | Trigger | What the user sees | What they can do |
|---|---|---|---|
| Loading (SP-1) | Picker opened | Skeleton cards, "Looking for screens and windows…" | Cancel |
| List (SP-2) | Sources returned | Cards of the active tab | Select, switch tab, Refresh, Cancel |
| Selected (SP-3) | A card chosen | Marked card, "Selected: <name>" | Share, change selection, Cancel |
| Empty (SP-4) | Zero items | Empty message | Refresh, other tab, Cancel |
| Listing failed (SP-5) | The listing call failed | Error panel | Try again, Cancel |
| Source gone (SP-6) | Selected source vanished before Share | Inline error, list refreshed, selection cleared | Choose another, Cancel |
| Shared | Share with a valid selection | Picker closes; Meet shows presenting | — |
| Cancelled | Cancel, Escape, X | Picker closes; **request denied**; call window focused | — |

| Control | Behaviour |
|---|---|
| Card | Click, or Space/Enter, selects it (exactly one). No double-click-to-share: an accidental double-click must not expose a screen |
| Arrow keys in the card group | Native radio behaviour: an arrow key moves focus and selects that card. Still a deliberate action; Share is required. Tabbing in focuses the first card **without selecting it** |
| Tabs | Switch list; clear selection |
| Share | If the selected source still exists, closes and passes it to Meet; otherwise SP-6 |
| Initial focus | The active tab. Nothing is pre-selected |
| Modality | Modal to the call window; does not block the main window, the tray or other apps |
| Close attempt on the call window while open | Never silent: the picker is raised, focused and flashed once |
| Tray "Show call window", notification click, second Meet link while open | Call window raised together with the picker; focus lands on the picker |
| Tray Exit while open | The picker is closed as part of exiting (request denied, nothing shared), then the normal Exit rules apply |
| Meet page crash while open | The picker is closed, its request denied, then the native crash dialog is shown |
| Second request while open | Not expected; the newer request replaces the older one, which is denied |

## 4. Accessibility (WCAG 2.2 AA)

- Tabs follow the ARIA tabs pattern; the card grid is a `radiogroup` of native radio inputs styled as
  cards, so selection state needs no custom role. Each card's accessible name is its full label, for
  example "Screen 1, main, 1920 by 1080". Thumbnails are decorative (`alt=""`).
- Keyboard: Tab order is tabs, Refresh, the current card (one stop for the group), Cancel, Share. Escape
  cancels. No keyboard trap.
- Visible focus: two-pixel `--focus-ring` with a two-pixel offset on tabs, cards, Refresh and buttons.
- Targets at least 44 px in the short dimension. Selection is never colour alone (border, check glyph,
  footer text). Reflow: one column below 560 px, no horizontal scroll.
- Reduced motion: the skeleton is static in every case.
- The window follows the OS theme live, as the Settings window does.

## 5. Interaction states

| Element | Hover | Active | Disabled |
|---|---|---|---|
| Primary button (Share, Try again) | `--accent-hover` fill | `--accent-pressed` fill | Fill `--track-off`, text `--text-secondary`, not-allowed cursor; the reason is always visible in the footer text |
| Secondary button (Cancel, Refresh) | `--hover` fill | `--pressed` fill | as above |
| Tab, source card | `--hover` fill (card border `--text-secondary`) | `--pressed` fill | — |

## 6. Tokens

Inherited from the [Settings spec §7](00-settings-surface-spec.md): `--bg`, `--text-primary`,
`--text-secondary`, `--border`, `--accent`, `--track-off`, `--error`, `--focus-ring`, font and sizes. New:

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--hover` | `#F0F0F0` | `#333333` | Hover fill |
| `--pressed` | `#E6E6E6` | `#3D3D3D` | Pressed fill |
| `--control-border` | `#767676` | `#8A8A8A` | Card and secondary-button outline (at least 3:1 on `--bg`) |
| `--accent-hover` | `#115EA3` | `#62ABF5` | Primary hover |
| `--accent-pressed` | `#0C3B5E` | `#7DB9F7` | Primary pressed |

Dark theme: background `#1F1F1F`, text `#F5F5F5`, secondary `#B3B3B3`, border `#3B3B3B`, accent `#479EF5`
with `#1B1B1B` text on it, error `#F1707B`, skeleton fill `#5A5A5A`. Values are hand-estimated starting
points, not measured on a rendered build.

## 7. Why it is like this, and what is not designed

- **No pre-selection.** Any default would be the app choosing for the user. The disabled Share button is
  the price; the persistent footer sentence says why it is disabled.
- **Thumbnails, not live previews.** A thumbnail plus the window title identifies the source.
- **Screens first.** Sharing a whole screen is the common case and works when the window list is empty.
- **Modal to the call window only.** The user must not close the call under an open request, but nothing
  else freezes.
- **Not designed:** live previews or timed refresh, system-audio sharing, region or browser-tab sharing, a
  remembered choice, an OS-permission state, the desktop portal's picker on Linux.
- **The call window in the source list.** Sharing the window that shows the call produces an endless
  mirror. Whether the shell can identify its own call window in the list is unverified; if it cannot, the
  card gets the label suffix " (this call)" and stays selectable.
- **Not verified:** Wayland in WSLg listed screens only and took about 3 s (Spike B); whether that holds
  on a native desktop is unknown. Nothing here was rendered in a browser or Electron.
</architecture>

<topics>
- [Native dialog, notification and tray wording](06-meet-native-wording.md)
</topics>
