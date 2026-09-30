# Meet Feature — Shared Components

<overview>
Elements used by more than one surface of the Meet feature, drawn once here with all states and the list
of every surface that uses them. Per-surface wireframes refer to these by identifier:
[Call window](04-meet-call-window.md), [Source picker](05-meet-source-picker.md), flows and definitions
in [03](03-meet-flows.md).

| Id | Component | Consumers |
|---|---|---|
| SC-1 | Status strip | Call window (CW-2a) |
| SC-2 | Native confirmation dialog | Close call window (F5); Exit with a live call (F6) |
| SC-3 | "Call already open" notification | Second Meet link while a meeting page is on screen (F4) |
| SC-4 | Tray menu entry "Show call window" | Tray (F7) |
| SC-5 | Status panel | Call window CW-1, CW-3, CW-4; Source picker SP-6 |
| SC-6 | Interaction states and tokens | Every app-owned surface (call-window panels, strip, picker) |

Applies uniformly to routes/surfaces: the main Chat window and the Settings window are **not** consumers
and are unchanged, except that the tray menu (SC-4) is the shared entry point, and the Settings window
gains one row only if the owner picks option B (§8).

**Architecture (decided by the technical lead).** SC-1 and SC-5 in the call window are drawn by a child
app view layered with the Meet view (see [04](04-meet-call-window.md) overview).
</overview>

<architecture>
## 1. SC-1 Status strip

A 48 px band between the title bar and the Meet content of the call window (72 px when the text wraps
below 640 px window width). It has one message and one control, so its dismiss button can be a full
44×44 target with a 2 px inset.

Light (`--bg-strip` #F3F3F3, text #1B1B1B, glyph `--error` #A80000, 1 px `--border` #E1E1E1 below):

```
hidden (default): 0 px high, no elements in the tab order
link blocked
│ (!) A link was not opened.                                       [ x ]  │
narrow (< 640 px window): wraps, 72 px high
│ (!) A link was not opened.                                       [ x ]  │
```

Dark (`--bg-strip` #2B2B2B, text #F5F5F5, glyph `--error` #F1707B, 1 px `--border` #3B3B3B below,
dismiss hover `--hover` #333333, focus ring `--focus-ring` #479EF5):

```
│ (!) A link was not opened.                                       [ x ]  │  #2B2B2B
```

| State | Trigger | Content | Leaves when |
|---|---|---|---|
| Hidden | No message | Nothing | — |
| Link blocked | The call page tried to open another site (popup or navigation) and the shell blocked it | Warning glyph + "A link was not opened." + dismiss | The user dismisses. Another block after a dismiss shows it again. Blocks while it is showing change nothing |

Announced politely on appearance; never steals focus. Offline and back-online messages were dropped (the
network is not reliably observable from the call window; Meet shows its own state). Whether a blocked link
should also be copied or opened elsewhere is the owner's decision ([08](08-meet-open-questions.md), OQ-3).
Consumers: call window only.

## 2. SC-2 Native confirmation dialog

Drawn by the operating system (a message box parented to the call window, or to no window for Exit), so it
inherits the OS theme, focus handling and screen-reader support. The wording is fixed here; the look is
the OS's. Both dialogs appear only when the **live call** check (Meet's page objects to being closed, see
[03 §0](03-meet-flows.md)) says yes.

Close the call window (F5):

```
┌───────────────────────────────────────────────────┐
│ Close the call window?                            │
│                                                   │
│ You will leave the call, and your camera,         │
│ microphone and screen sharing will stop.          │
│                                                   │
│        [ Close window ]   [ Keep window open ]    │  default + Escape:
└───────────────────────────────────────────────────┘  Keep window open
```

Exit while a live call exists (F6):

```
┌───────────────────────────────────────────────────┐
│ Exit Google Chat Desktop?                         │
│                                                   │
│ You will leave the call, and your camera,         │
│ microphone and screen sharing will stop. You      │
│ won't get message notifications until you start   │
│ the app again.                                    │
│                                                   │
│               [ Exit ]   [ Cancel ]               │  default + Escape: Cancel
└───────────────────────────────────────────────────┘
```

Wording check — each message is true in every state where it can appear:

| Message | Appears when | True in every such state because |
|---|---|---|
| "You will leave the call…" (both dialogs) | Meet's page objects to closing | The page objects only while the user is in, or joining, a call; it never appears on an error panel, sign-in page, landing page or Meet's end page (those do not object). Nothing in it mentions the camera being off or on |
| "A call is already open. The new link was not opened." (SC-3) | A meeting page is on screen | Any address not known to be a non-meeting page. On Meet's own end page the wording is slightly early (the call has just ended); accepted, flagged in [08](08-meet-open-questions.md), OQ-11 |
| Tray "Show call window" | A call window exists | Says only that a window exists |

States: shown; answered (each button leads somewhere, F5/F6). Not answered by timeout; the safe answer is
the default and the Escape answer. Buttons are verbs that name the outcome, never "OK/Yes". Consumers:
the two above only. Dark theme is the OS's and is not redrawn.

## 3. SC-3 "Call already open" notification

OS notification, shown when a second Meet link is activated while the call window shows a meeting page. It
is not a Chat message: it does not change unread state, the tray badge, the blink or the flash.

```
Windows toast                                   Linux (notification daemon)
┌─────────────────────────────────────┐        ┌──────────────────────────────────┐
│ [app icon]  Google Chat Desktop     │        │ [icon] Google Meet               │
│ Google Meet                         │        │ A call is already open. The new  │
│ A call is already open. The new     │        │ link was not opened.             │
│ link was not opened.                │        └──────────────────────────────────┘
└─────────────────────────────────────┘
```

| Property | Value |
|---|---|
| Title | "Google Meet" |
| Body | "A call is already open. The new link was not opened." |
| Shown when Mute is on | Yes (app status, not a chat message) |
| Sound | Follows the Notification sound setting (FR-11) |
| Repeats | Repeated clicks within a short period replace the same notification instead of stacking |
| Click | Restores if minimized, raises and focuses the call window (the picker, if one is open) |
| Ignored or dismissed | Nothing further; the call window was already brought forward when the link was clicked |
| Suppressed by the OS (Focus Assist, Do Not Disturb) | The call window still comes forward; that is the fallback signal |
| Not shown | When no meeting page is on screen: the new link loads into the existing window instead (F4) |

Consumer: the second-link handler only.

## 4. SC-4 Tray menu entry

Existing menu: [Settings wireframe F](01-settings-wireframes.md). Additive change while a call window
exists, in any of its states (the entry is absent otherwise, so the menu is unchanged when there is no
call window):

```
no call window (unchanged)            call window exists
┌─────────────────────────────┐      ┌─────────────────────────────┐
│ Show/Hide Google Chat       │      │ Show call window            │ ← new, first
├─────────────────────────────┤      ├─────────────────────────────┤
│ [ ] Mute notifications      │      │ Show/Hide Google Chat       │
├─────────────────────────────┤      ├─────────────────────────────┤
│ Settings…                   │      │ [ ] Mute notifications      │
├─────────────────────────────┤      ├─────────────────────────────┤
│ Exit                        │      │ Settings…                   │
├─────────────────────────────┤      ├─────────────────────────────┤
│ 0.0.1-19 (0ce64f7, local)   │      │ Exit                        │ ← F6 confirm if live
└─────────────────────────────┘      ├─────────────────────────────┤
                                     │ 0.0.1-19 (0ce64f7, local)   │
                                     └─────────────────────────────┘
```

| Item | Behaviour |
|---|---|
| Show call window | Restores, raises and focuses the call window; if a picker is open, focus goes to the picker. Never touches the main window |
| Show/Hide Google Chat | Main window only; the call window stays as it is |
| Tray icon image, tooltip | **Unchanged.** No call state on either |
| Left/double click | Unchanged: toggles the main window |

The tray is pointer-only; the recorded limitation in the [Settings spec §2](00-settings-surface-spec.md)
applies. The keyboard route to a buried call window is the OS window switcher (F7 route 1).

## 5. SC-5 Status panel

A centred block for whenever the app has to say something in a whole window: glyph, heading, one reason
line, optional address and code, and up to two buttons. Max content width 480 px; buttons stack
vertically below 560 px.

```
                         (glyph)
                         Heading
                      One reason line.
                     optional address line
                     Code: optional code
              [ Primary action ]  [ Secondary action ]
```

| Consumer | Glyph | Heading | Actions |
|---|---|---|---|
| CW-1 Opening | spinner | Opening the call… | none (slow: Reload, Close window) |
| CW-3 Load error | warning | Couldn't open the call | Try again, Close window |
| CW-4 Crashed | warning | The call window stopped working | Reload, Close window |
| SP-6 Listing failed | warning | Couldn't load screens and windows | Try again, Cancel |

Rules: focus goes to the heading when an error panel appears; the primary action is first in tab order;
the spinner becomes static text under reduced motion; the glyph is never the only carrier of meaning.

## 6. SC-6 Interaction states (all app-owned Meet surfaces)

| Element | Cursor | Hover | Active (pressed) | Focus-visible | Disabled |
|---|---|---|---|---|---|
| Primary button | pointer | `--accent-hover` fill | `--accent-pressed` fill | 2 px `--focus-ring`, 2 px offset | Fill `--track-off`, text `--text-secondary`, cursor not-allowed; the reason is always visible in text |
| Secondary button | pointer | `--hover` fill | `--pressed` fill | same ring | same |
| Tab | pointer | `--hover` fill | `--pressed` fill | same ring | — |
| Source card | pointer | `--hover` fill, border `--text-secondary` | `--pressed` fill | same ring around the whole card | — |
| Selected card | pointer | as above | as above | ring outside, selected border inside, both distinguishable | — |
| Strip dismiss | pointer | `--hover` fill | `--pressed` fill | same ring | — |
| Skeleton card | default | none | none | not focusable | — |

## 7. Tokens

Inherited without change from [Settings spec §7](00-settings-surface-spec.md): `--bg`, `--text-primary`,
`--text-secondary`, `--border`, `--accent`, `--track-off`, `--error`, `--focus-ring`, font, base type
sizes, 44 px minimum row height. New tokens for this feature:

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--bg-strip` | `#F3F3F3` | `#2B2B2B` | Status strip background |
| `--hover` | `#F0F0F0` | `#333333` | Hover fill |
| `--pressed` | `#E6E6E6` | `#3D3D3D` | Pressed fill |
| `--control-border` | `#767676` | `#8A8A8A` | Card and secondary-button outline (at least 3:1 on `--bg`) |
| `--accent-hover` | `#115EA3` | `#62ABF5` | Primary hover |
| `--accent-pressed` | `#0C3B5E` | `#7DB9F7` | Primary pressed |

Theme follows the OS theme live (`nativeTheme`), as the Settings window does. Meet's own content is not
themed by the app. All values are starting points, hand-estimated, not measured (see §10).

## 8. Conditional Settings row (only under close-confirmation option B)

Drawn so the owner can judge option B ([Rationale §2](07-meet-rationale.md)); **not part of the design
unless chosen**. It would be a fifth row, in a new "Calls" section below Notifications, following the same row pattern and immediate-apply rule as the existing
switches (window height grows from 460 to about 540 px; no other change to that window).

```
│  CALLS                                        │
│  ──────────────────────────────────────────   │
│  Confirm before closing a call         [x]    │
│  (i) Asks before the call window closes       │
│      during a call. Off closes it at once.    │
```

Default on. Off means the SC-2 close dialog is never shown; the Exit dialog is not affected. Tab order:
after "Blink tray icon on unread". Persisted like the other settings. Not drawn in dark: same tokens as
Settings wireframe B.

## 9. Why it is like this

One strip and one panel pattern keep every "the app has something to say" moment in the same place and
style. Confirmations use the OS dialog because it is built and tested for focus, screen readers and
theming, and the feature needs no custom content in it.

## 10. What was not designed, and what was not verified

- Not designed: an in-app notification centre; a "call in progress" bar in the main window
  ([Rationale §4](07-meet-rationale.md)); any tray icon or tooltip change for calls; offline strips.
- Not verified: contrast values (hand-estimated); how each OS renders the notification and whether Focus
  Assist or Do Not Disturb hides it; the wording of SC-2 was not tested with a user.
- **The SC-2 wording "You will leave the call…" rests on an unverified assumption:** that Meet's page
  objects to being closed only while the user is in or joining a call. If Spike B shows Meet objects in
  other states (for example an idle pre-join screen), the sentence must be revisited before it ships.
</architecture>

<topics>
- [Flows](03-meet-flows.md)
- [Call window](04-meet-call-window.md)
- [Source picker](05-meet-source-picker.md)
- [Rationale](07-meet-rationale.md)
- [Open questions](08-meet-open-questions.md)
- [Proposed requirement amendments](09-meet-proposed-amendments.md)
</topics>
