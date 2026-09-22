# Settings Surface — Wireframes

<overview>
ASCII pseudographic layouts — spatial structure only, no visual styling. Paired with
[the spec](00-settings-surface-spec.md) for control labels/behavior and token values. `[x]`/`[ ]`
represent a switch in its on/off visual position (not literal checkbox glyphs — the implementer
renders an actual switch/toggle control, per the spec's `role="switch"` note); `(i)`/`(!)` mark
helper/error text. Window is fixed 380×460 CSS px in every state below.
</overview>

<architecture>
## A. Settings window — light theme, default/ready state

```
┌──────────────────────────────────────────────┐  380×460, fixed, not resizable
│ Google Chat Desktop — Settings            [x] │  ← native title bar, close only
├──────────────────────────────────────────────┤
│                                                │
│  GENERAL                                      │
│  ──────────────────────────────────────────   │
│  Start at login                        [ ]    │
│  (i) Launches minimized to the tray           │
│      when you log in.                         │
│                                                │
│  NOTIFICATIONS                                │
│  ──────────────────────────────────────────   │
│  Notification sound                    [x]    │
│  (i) Plays a sound with new-message           │
│      notifications.                           │
│                                                │
│  Mute notifications                    [ ]    │
│  (i) Silences notifications. The tray         │
│      icon still shows unread messages.        │
│      Also on the tray menu.                   │
│                                                │
│  Blink tray icon on unread              [x]    │
│  (i) Blinks on a new message; stops           │
│      the moment you open the window.          │
│                                                │
├──────────────────────────────────────────────┤
│  Google Chat Desktop 0.1.0                    │
│  (packaged, built 2026-09-22 13:58)           │
└──────────────────────────────────────────────┘
```

Tab order (top → bottom): Start at login → Notification sound → Mute notifications → Blink tray icon
on unread. About line is static text, not in the tab sequence.

## B. Settings window — dark theme, default/ready state

Same layout as A; only token values change (see spec §7). Shown separately because dark-theme
contrast must be verified independently, not assumed from the light spec:

```
┌──────────────────────────────────────────────┐  bg #1F1F1F
│ Google Chat Desktop — Settings            [x] │  text #F5F5F5
├──────────────────────────────────────────────┤
│                                                │
│  GENERAL                                      │
│  ──────────────────────────────────────────   │  border #3B3B3B
│  Start at login                        [ ]    │  track-off #5A5A5A
│  (i) Launches minimized to the tray           │  helper #B3B3B3
│      when you log in.                         │
│                                                │
│  NOTIFICATIONS                                │
│  ──────────────────────────────────────────   │
│  Notification sound                    [x]    │  switch-on #479EF5
│  (i) Plays a sound with new-message           │
│      notifications.                           │
│                                                │
│  Mute notifications                    [ ]    │
│  (i) Silences notifications. The tray         │
│      icon still shows unread messages.        │
│      Also on the tray menu.                   │
│                                                │
│  Blink tray icon on unread              [x]    │
│  (i) Blinks on a new message; stops           │
│      the moment you open the window.          │
│                                                │
├──────────────────────────────────────────────┤
│  Google Chat Desktop 0.1.0                    │
│  (packaged, built 2026-09-22 13:58)           │
└──────────────────────────────────────────────┘
```

## C. Settings window — Start at login error/unavailable state (light theme shown; same structure in dark)

```
┌──────────────────────────────────────────────┐
│ Google Chat Desktop — Settings            [x] │
├──────────────────────────────────────────────┤
│                                                │
│  GENERAL                                      │
│  ──────────────────────────────────────────   │
│  Start at login                        [ ]    │  ← reverted to off after failed apply
│  (!) Couldn't enable Start at login —         │
│      couldn't write to the autostart          │
│      folder.  [Try again]                     │
│                                                │
│  NOTIFICATIONS                                │
│  ──────────────────────────────────────────   │
│  Notification sound                    [x]    │
│  ...                                          │
```
(remaining rows unchanged from state A) — `(!)` = warning glyph + text, `--error` token; "Try again"
is a keyboard-focusable text link, next in tab order right after the Start at login switch.

## D. Settings window — Mute active, Blink paused note (light theme shown)

```
│  Mute notifications                    [x]    │
│  (i) Silences notifications. The tray         │
│      icon still shows unread messages.        │
│      Also on the tray menu.                   │
│                                                │
│  Blink tray icon on unread              [x]    │  ← preference unchanged, stays on
│  (i) Blinks on a new message; stops           │
│      the moment you open the window.          │
│  (i) Paused — notifications are muted.        │  ← extra status line, not color-only
```
(GENERAL section and window chrome unchanged from state A/B.)

## E. Settings window — loading state (brief, on window open before data arrives)

```
┌──────────────────────────────────────────────┐
│ Google Chat Desktop — Settings            [x] │
├──────────────────────────────────────────────┤
│                                                │
│  GENERAL                                      │
│  ──────────────────────────────────────────   │
│  Start at login                    [░░░░]     │  ← disabled, low-emphasis, no
│                                                │     value shown yet
│  NOTIFICATIONS                                │
│  ──────────────────────────────────────────   │
│  Notification sound                [░░░░]     │
│  Mute notifications                [░░░░]     │
│  Blink tray icon on unread          [░░░░]     │
│                                                │
├──────────────────────────────────────────────┤
│  (About line appears once version data loads) │
└──────────────────────────────────────────────┘
```
All rows are keyboard-unreachable (`tabindex="-1"`/`disabled`) while loading — nothing to interact
with yet, and no risk of toggling a value before its real state is known.

## F. Tray context menu — updated (replaces the FR-07 table's current 7-item menu)

```
┌───────────────────────────────────┐
│ Show/Hide Google Chat              │  ← action, mirrors left/double-click
├───────────────────────────────────┤
│ [x] Mute notifications             │  ← checkbox, quick toggle (kept — see Rationale §2)
├───────────────────────────────────┤
│ Settings…                          │  ← opens/focuses the Settings window
├───────────────────────────────────┤
│ Exit                               │  ← only action that terminates the process
├───────────────────────────────────┤
│ 0.1.0 (packaged, built 2026-09-22  │  ← disabled, de-emphasized, FR-13
│ 13:58)                             │
└───────────────────────────────────┘
```
Removed from the tray vs. today's menu: **Start at login** and **Notification sound** checkboxes —
moved to the Settings window only (Rationale §2). **Mute notifications** stays on the tray (fastest
path to "silence it right now") and is live-synced with the same control in Settings (spec §4).

## G. Tray icon — state table (not a screen; the icon itself has no interactive layout)

Settled per spec §9/FR-14 — three visual states cover every possible icon appearance; no additional
"has the window been opened since blinking last stopped" axis is needed (see note below the table).

| State | Condition | Visual |
|---|---|---|
| Idle | unread = 0 | plain icon, no badge |
| Unread (static) | unread > 0, AND (`notificationsMuted` OR `blinkOnUnread` off OR blinking has been stopped by one of the transitions below and no qualifying new message has arrived since) | plain icon + badge overlay (Windows: `setOverlayIcon`; Linux: badged icon variant — see [notifications.md](../architecture/notifications.md) piece 3) |
| Unread (blinking) | unread > 0, `blinkOnUnread` on, NOT muted, and blinking currently active | alternates plain ↔ badged icon every ~1s (see spec §9) |

**Transitions (all settled, spec §9):**

| From → To | Trigger |
|---|---|
| Idle → Unread (blinking) | new message arrives, `blinkOnUnread` on, not muted |
| Idle → Unread (static) | new message arrives, AND (`notificationsMuted` OR `blinkOnUnread` off) |
| Unread (blinking) → Unread (static or Idle) | window becomes visible — stops blinking immediately, regardless of which conversation is shown or how much unread remains; lands on Unread (static) if any unread remains elsewhere, Idle if that was the only unread |
| Unread (blinking or static) → Idle | unread count returns to 0 while the window is still hidden (e.g. read on the owner's phone) — badge clears and blink stops in the same step |
| Unread (blinking) → Unread (static) | `blinkOnUnread` turned off, or `notificationsMuted` turned on, while blinking is active |
| Unread (static) → Unread (blinking) | a **new** message arrives while unread > 0, `blinkOnUnread` on, not muted — resumes **regardless of window-open history**, including when the earlier stop was caused by opening the window without viewing the still-unread conversation that triggered it |

**Why no fourth axis is needed:** an earlier revision of this table flagged that representing
resume-after-stop might require tracking "has the window been opened since blinking last stopped" as
a separate axis. FR-14's settled decision (spec §9) makes resume memoryless with respect to that
history — any new arrival resumes blinking outright, so the three states above, plus the transition
table, fully describe every reachable icon appearance without a fourth dimension.
</architecture>

<topics>
- [Settings Surface Spec](00-settings-surface-spec.md)
- [Rationale](02-rationale.md)
</topics>
