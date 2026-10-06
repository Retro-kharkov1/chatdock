# Meet — Native Dialog, Notification and Tray Wording

<overview>
Wording spec only, no mockups: every message below is drawn by the operating system (message boxes,
notifications, tray menu), so it inherits the OS theme, focus handling and screen-reader support. The only
surface the application draws itself is the [source picker](05-meet-source-picker.md). Requirements:
[FR-16](../business/requirements.md) and [FR-07](../business/requirements.md).

Rules for all of them: buttons are verbs that name the outcome, never "OK" or "Yes"; the safe answer is the
default and the Escape answer; no dialog is ever answered by a timeout.
</overview>

<architecture>
## 1. P1 — Close the call window (live call only)

Shown when the user closes the call window (X, Alt+F4, taskbar close) and Meet's page objects to being
closed. A native message box parented to the call window.

| Part | Text |
|---|---|
| Title | Close the call window? |
| Body | You will leave the call, and your camera, microphone and screen sharing will stop. |
| Buttons | **Close window** / **Keep window open** — default and Escape: Keep window open |

*Close window* destroys the window and releases the devices; *Keep window open* leaves it open and focused.

## 2. P2 — Exit while a live call exists (tray Exit)

Native message box, not parented to a window.

| Part | Text |
|---|---|
| Title | Exit Google Chat Desktop? |
| Body | You will leave the call, and your camera, microphone and screen sharing will stop. You won't get message notifications until you start the app again. |
| Buttons | **Exit** / **Cancel** — default and Escape: Cancel |

Interplay with P1: if Exit is chosen while P1 is open, P1 is dismissed (as Keep window open) and P2 is
shown; if P1 cannot be dismissed programmatically, P1 is focused and P2 is shown as soon as P1 is answered.
Choosing Exit while P2 is open focuses P2; no second one is opened.

Both dialogs appear only for a live call. If the live-call signal is missing, neither appears: Close
destroys the window and Exit quits at once. The sentence "You will leave the call…" is true only if Meet's
page objects to closing solely while the user is in or joining a call; that is unverified against real
Meet and must be rechecked in the first maintainer-run call.

## 3. P3 — Tray entry "Show call window"

First entry of the tray menu, present only while a call window exists; absent otherwise.

```
no call window (unchanged)            call window exists
┌─────────────────────────────┐      ┌─────────────────────────────┐
│ Show/Hide Google Chat       │      │ Show call window            │  new, first
├─────────────────────────────┤      ├─────────────────────────────┤
│ [ ] Mute notifications      │      │ Show/Hide Google Chat       │
├─────────────────────────────┤      ├─────────────────────────────┤
│ Settings…                   │      │ [ ] Mute notifications      │
├─────────────────────────────┤      ├─────────────────────────────┤
│ Exit                        │      │ Settings…                   │
├─────────────────────────────┤      ├─────────────────────────────┤
│ <build line>                │      │ Exit                        │
└─────────────────────────────┘      ├─────────────────────────────┤
                                     │ <build line>                │
                                     └─────────────────────────────┘
```

Label: "Show call window". It restores, raises and focuses the call window (focus goes to the picker if one
is open) and never touches the main window. The tray icon image and tooltip are unchanged.

## 4. "Call already open" notification

OS notification, shown when a Meet link is activated while the call window shows a meeting (FR-16).

| Property | Value |
|---|---|
| Title | Google Meet |
| Body | A call is already open. The new link was not opened. |
| Shown when Mute is on | Yes (app status, not a chat message) |
| Unread state, tray badge, blink, flash | Not affected |
| Sound | Assumed to follow the Notification sound setting (FR-11); unconfirmed |
| Repeats | Repeated clicks in a short period replace the same notification |
| Click | Restores, raises and focuses the call window (the picker, if open) |
| Suppressed by the OS (Focus Assist, Do Not Disturb) | The call window still comes forward; that is the fallback signal |
| Not shown | When no meeting is on screen: the new link loads into the existing window |

The wording is slightly early on Meet's own end page (the call has just ended) and false there; that is the
documented known limitation in FR-16.

## 5. Meet page crash

Native message box parented to the call window, shown when the Meet page's process ends unexpectedly.

| Part | Text |
|---|---|
| Title | The call window stopped working |
| Body | The Google Meet page in this window has stopped. You can reload it or close the window. |
| Buttons | **Reload** / **Close window** — default: Reload; Escape: Close window |

*Reload* reloads the same Meet address; *Close window* destroys the window with no further confirmation (a
crashed page cannot object). An open source picker is closed and its request denied first.

## 6. What is not specified

No wording exists for: a status strip or banner in the call window, a "link not opened" message, an
opening or slow-load panel, a page-load-failure panel (open question in FR-16), offline messages, or a
Settings row for the close confirmation. None was requested.
</architecture>

<topics>
- [Source picker](05-meet-source-picker.md)
</topics>
