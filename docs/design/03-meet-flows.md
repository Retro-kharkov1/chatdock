# Google Meet Call — Flows and Use Cases

<overview>
Behaviour of the in-app Google Meet feature ([FR-16 and NFR-07](../business/requirements.md)) as a set of
short flows. This file answers "what connects to what"; the drawings of the surfaces are in
[Call window](04-meet-call-window.md), [Source picker](05-meet-source-picker.md) and
[Shared components](06-meet-shared-components.md). The reasoning is in [Rationale](07-meet-rationale.md),
what is undecided is in [Open questions](08-meet-open-questions.md), and the exact wording changes this
design needs in the requirements is in [Proposed requirement amendments](09-meet-proposed-amendments.md).

Design Read (per `design-taste-frontend` §0 Brief Inference): **quiet utility chrome around a page the
app does not own.** Google Meet draws the call itself. The app draws something only where Meet's page
cannot speak for itself: while it loads, when it fails to load, when the user must choose what to share,
and when a destructive close needs confirming. Those surfaces look like the existing
[Settings window](00-settings-surface-spec.md) and never compete with the call.

Notation: prose with inline arrows. No diagram tool. Surface identifiers (CW-, SP-, SC-) refer to the
wireframe files above.
</overview>

<architecture>
## 0. Definitions — three terms, each defined once

The word "call" is not used loosely anywhere in this design. Three different facts drive three different
decisions, and each has its own name, its own way of being observed, and its own failure direction.

| Term | Meaning | How the shell learns it | Drives | If the signal is missing or wrong |
|---|---|---|---|---|
| **Call window exists** | The call window has been created and not yet destroyed, in any state (opening, error, sign-in, Meet page) | Certain: the app owns the window | One-window rule; tray "Show call window" entry | Cannot be missing |
| **Meeting page on screen** | The call window shows a Meet page that is **not** a known non-meeting page. Known non-meeting pages: an app panel (opening, error, crashed), `accounts.google.com`, and `meet.google.com` at path `/` or `/landing`. Everything else counts as a meeting page | Certain enough: the requested address, page-navigation events and the app's own panel state. Defined by exclusion on purpose | Second Meet link routing (§F4) | An address form the rule does not recognise counts as a meeting page. Result: the second link gets "focus and notify", never "navigate away". Safe direction |
| **Live call** | Meet's page **objects to being closed** — it asks the browser engine to block unloading (the "Leave site?" behaviour a Meet tab shows while you are in a call). The shell asks the page to close and sees whether it objects | Only at the moment of a close request, and only if the Meet page really behaves this way. **Unverified; must be proven in Spike B** (ADR-0004) | Close confirmation (F5); Exit confirmation (F6) | Treated as **not live**: no confirmation, the window closes or the app exits at once. The cost is that a close during a call is not guarded; the alternative (assume live) would prompt at the end of every call |

### Close handling — invariants (behaviour level; the mechanism is in the architecture document)

The call window's own web contents **is** Meet's page, so closing the window naturally asks Meet's page
whether it agrees to be unloaded. The shell must handle Meet's answer; if it did not, a page that objects
would leave the close doing nothing at all. These rules are the behaviour the design requires:

| # | Rule |
|---|---|
| I1 | **A close is never silently swallowed.** Every app-initiated close ends in exactly one of: the window destroyed; SC-2 shown and answered; or, while the source picker is open, the picker raised and flashed. This covers the title-bar X, Alt+F4 and taskbar close. The Exit probe in F6 is the one exception to the picker outcome: on Exit the picker is closed as part of exiting (its request is denied) and only the call-window probe applies, so Exit never ends in "picker raised". "Nothing happened" is not an allowed outcome |
| I2 | **Live call.** If Meet's page objects to the close, the shell intercepts the objection and shows SC-2. **Close window** overrides the objection and destroys the window. **Keep window open** does nothing further; the window stays open and focused |
| I3 | **Hung page.** A page that never answers the unload check within a timeout is treated as not live and the window is destroyed. Proposed timeout: **3 seconds** (owner may change it). Nothing is shown during the wait beyond the window staying as it is |
| I4 | **The override applies only to app-initiated closes.** Navigations started by the page itself (a Meet reload, Meet-internal navigation, a link) are **not** overridden: the shell never blanket-overrides objections. What the user sees then is **unverified**. A browser tab shows a "Leave site?" prompt; in Electron an unhandled objection may instead block the navigation silently. Which one happens is Spike B's question and the fallbacks are in [08](08-meet-open-questions.md), OQ-18 |
| I5 | **Exit is a close attempt.** The Exit check (F6) closes the call window as its probe. It bypasses the picker block: if the source picker is open it is closed first as part of exiting (its display-capture request is denied, nothing is shared), and then only the call-window probe applies. A page that does not object is destroyed and Exit proceeds; a page that objects gets SC-2 and only then, if the user confirms Exit, is the objection overridden. "Cancel" leaves an objecting page untouched, which is the only case where there is anything to cancel |
| I6 | **No user activation, no objection.** A browser engine honours a page's unload objection only after the user has interacted with the page. A user who joined but never clicked or typed in the window may not trigger it. That is the "signal missing" case: the close goes through without a dialog ([08](08-meet-open-questions.md), OQ-1) |

Why two failure directions: a wrong "not live" costs one unguarded close, which the user can undo by
rejoining, and the opposite error would prompt at the end of every call. A wrong "not a meeting page"
would navigate a running call away with no warning, so that predicate fails the other way, toward
protecting the call. Messages are worded
so that each is true in every state where it can appear (checked in the wording table in
[06 §2](06-meet-shared-components.md)).

**Architecture (decided by the technical lead).** The call window is a window whose own web contents is
Meet (no preload script, navigation limited by NFR-07). A **child "app view"** — a bundled local page
with its own preload script, its own non-persistent session, sandboxed, and not allowed to navigate —
is layered with it and draws CW-1, CW-3, CW-4 and the strip. It talks to the main process over two
messages: state (main to view, the full state) and actions (view to main: retry, reload, close,
dismiss-strip). Consequences for the design: the panels give way when Meet loads; Google sign-in and the
Meet landing page are shown by the Meet view with the app view hidden; a crashed Meet page leaves the app
view alive to draw CW-4; nothing app-owned is ever drawn inside the Meet page; and because Meet is the
window's own web contents, closing the window does consult Meet's unload objection (hence the invariants
above).

## 1. Surfaces in this feature

| Id | Surface | Owner of the pixels | File |
|---|---|---|---|
| CW | Call window (one at a time) | Google Meet inside; app-owned view for loading/error/crash/status | [04](04-meet-call-window.md) |
| SP | Screen-share source picker (modal child of the call window) | App | [05](05-meet-source-picker.md) |
| SC-1 | Status strip inside the call window | App | [06](06-meet-shared-components.md) |
| SC-2 | Native confirmation dialog | Operating system | [06](06-meet-shared-components.md) |
| SC-3 | "Call already open" OS notification | Operating system | [06](06-meet-shared-components.md) |
| SC-4 | Tray menu entry "Show call window" | Operating system | [06](06-meet-shared-components.md) |
| SC-5 | Status panel (loading / error / crashed) | App | [06](06-meet-shared-components.md) |

Unchanged and reused: main Chat window, Settings window, Chat new-message notifications (FR-05), tray
blink and taskbar flash (FR-14). The Settings window gets **no new control** unless the owner picks
option B for the close confirmation ([Rationale §2](07-meet-rationale.md), drawn as a conditional row in
[06 §8](06-meet-shared-components.md)).

## 2. Flows

Each flow ends in a named end state.

### F1 — Open a call from Chat (happy path)
1. In the main window the user activates a Meet link (message link, Chat's Join button, a calendar card,
   or a page navigation that would load Meet in the main frame — NFR-07 intercepts that case).
2. The link passes the exact-origin test (NFR-07) → no call window exists → the main window is left
   exactly as it was.
3. The call window is created and **shown immediately** in CW-1 Opening (app-owned view with the meeting
   address) → Meet's page loads → the app view steps aside and the window shows Meet's own content (CW-2).
4. **End state:** the user is in the call in the call window, or one of the failure states in F2, F11,
   F12.

### F2 — The Meet page fails to load
CW-1 Opening → the load fails (the failure reason comes from the load error: no network, DNS, secure
connection, blocked, unknown) → CW-3 error panel with the reason and two buttons:
- **Try again** → CW-1 (same address) → F1 step 3 or CW-3 again.
- **Close window** → the window is destroyed, no confirmation (no page to object). End state: no call
  window; main window and tray unchanged.

There is no automatic retry: it would depend on knowing when the network is back, which the shell may not
be able to observe. If the page is slow but has not failed, after 10 seconds CW-1 adds "This is taking
longer than expected." with **Reload** and **Close window** (a timer only, no network signal).

### F3 — Share a screen or window (app picker)
Applies on Windows always, and on Linux unless F3b is in effect.
1. In the call the user chooses Meet's own "Present now". Meet asks the page for display capture.
2. The origin check (NFR-07) passes → the app shows the picker (SP-1 Loading) as a **modal child of the
   call window**. **No item is pre-selected**, because a pre-selected item would be an automatic choice.
3. Sources arrive → SP-2 list (Screens tab first). The user may switch tab, press **Refresh**, and
   selects exactly one item (a click, Space, or an arrow key on a focused card) → **Share** becomes
   available.
4. **Share** → the picker closes, the chosen source is given to Meet, Meet shows its own "presenting"
   state. **End state: sharing.**
5. **Cancel**, Escape, or the picker's close (X) → the picker closes, the request is denied, nothing is
   shared, focus returns to the call window, and Meet shows its own "not presenting" state.
   **End state: not sharing.** No source was chosen automatically at any point.

Failure and edge branches:
- Zero sources → SP-4 / SP-5 (Refresh, Cancel).
- The listing itself fails → SP-6 (Try again, Cancel).
- Exactly one source returned in total → SP-8 (no tabs, one card; the user still selects it and presses
  Share).
- The chosen source disappeared before Share → SP-7 inline error, selection cleared.

**While the picker is open** (the call window is blocked behind it):
- The user tries to close the call window (X, Alt+F4, taskbar close) → nothing closes, and the picker is
  **raised and focused, and its title bar/taskbar button flashes once**, so the attempt is never silent.
  The user finishes or cancels the picker, then closes.
- Tray **Show call window** → the call window is raised together with the picker and focus lands on the
  **picker** (it is the window that can take input).
- A second Meet link → the meeting page is on screen, so F4 applies: notification, and the picker (with
  its call window) is raised and focused.
- Tray Exit → F6 as usual, and Exit bypasses the picker block (I1, I5): the picker is closed as part of
  exiting, its request is denied, and only the call-window probe applies. If the user then cancels the
  Exit confirmation, the picker has already been closed and Meet shows its own "not presenting" state.

### F3b — Share a screen on Linux with the operating system's picker
**Conditional on Spike B** (ADR-0004): the amended space rule already allows, on Linux only, the OS
picker (for example xdg-desktop-portal) to replace the app picker, provided the user still chooses
explicitly and nothing is silent or pre-selected. It is used only if Spike B shows it works.
Same trigger as F3 step 1 → the app **skips** SP entirely → the user chooses in the OS picker, or cancels
it. The app draws nothing of its own and never picks a source. **End state:** sharing, or not sharing
(Meet shows its own state). If Spike B says it does not work, F3 applies on Linux too. SP-0 marks the
gap; SP-8 is what the app picker shows when a Linux session returns a single source.

### F4 — A second Meet link while a call window exists
The link is never opened as a second window. What happens depends on the call window's page:
- **Meeting page on screen** → the existing window is **restored if minimized, raised and focused**
  (visible answer to the click), the existing call is **not** navigated, and SC-3 shows the OS
  notification "A call is already open. The new link was not opened." (regardless of Mute; a burst of
  clicks replaces the same notification). Clicking the notification focuses the call window.
  End state: same window in front, the new link untouched in Chat, where it can be clicked again after
  leaving.
- **No meeting page on screen** (CW-1 opening, CW-3 error, CW-4 crashed, Google sign-in, Meet landing
  page) → nothing can be lost, so the new link is **loaded into the existing window** (CW-1 for the new
  address), the window is raised and focused, and **no notification** is shown, because "a call is already
  open" would be false. End state: one window, now opening the new address.

This split is a change to the FR-16 working default and needs the owner's confirmation
([09](09-meet-proposed-amendments.md), item A3).

### F5 — The user closes the call window
Triggers: title-bar X, Alt+F4, taskbar/dock "Close window". If the window is minimized it is first
restored and focused.
1. The shell asks the Meet page to close (the "live call" check, §0; invariants I1 to I6 apply).
2. **Page objects (live call)** → the shell intercepts the objection and shows SC-2 "Close the call
   window?" with **Close window** and **Keep window open** (default and Escape = Keep window open).
   - **Keep window open** → dialog closes, focus returns to the call window, page untouched. End state:
     still in the call.
   - **Close window** → the objection is overridden for this one app-initiated close and the window is
     destroyed; camera, microphone and any screen capture are released (FR-16); the tray "Show call
     window" entry disappears. **End state: no call window**, app running, main window unchanged.
3. **Page does not object** (after Meet's own Leave, on "You left the meeting", on the pre-join screen if
   Meet does not object there, Meet landing, sign-in, any app panel, no user activation yet, or the signal
   is missing) → the window is destroyed at once, no dialog. Same end state.
4. **Page never answers** (hung) → after the timeout in I3 (proposed 3 seconds) it is treated as not
   live and the window is destroyed. Same end state.
5. Meet's own reloads and navigations are not app-initiated closes and are not overridden (I4). Whether
   the user then sees a prompt or the navigation is blocked silently is unverified (OQ-18).

The X is the **normal** way to finish after leaving through Meet's own Leave button (Meet's end page has
no in-app close), which is exactly why the confirmation is keyed on the live call and not on "a meeting
page is showing". If the owner does not want the confirmation at all, or wants it switchable, see
[Rationale §2](07-meet-rationale.md), options B and C.

### F6 — Tray Exit while a call window exists
Exit stays the only way to quit. The Exit check **is a close attempt** on the call window (I5), so:
- **Live call** (page objects) → SC-2 "Exit Google Chat Desktop?" — **Exit** overrides the objection and
  ends the process (call ends, devices released), **Cancel** (default, Escape) leaves the objecting page
  and the app untouched.
- **Not live** (page does not object, hung past the timeout, no user activation yet, signal missing) → the
  probe destroys the non-objecting call window and Exit proceeds at once, no dialog; there was nothing to
  cancel, so Cancel semantics apply only to the live case.
- **No call window** → Exit behaves exactly as today.
This is a change to FR-07's Exit behaviour and needs ratifying ([09](09-meet-proposed-amendments.md),
item A2).

### F7 — Getting back to a call window that is behind other windows
Four independent routes, none needing the main window:
1. The call window has its own taskbar button and its own entry in Alt+Tab / the window switcher (title
   ends "— Google Chat Desktop"). This is the only keyboard-reachable route and works without the tray.
2. Tray right-click → **Show call window** (present while a call window exists, in any state). It
   restores, raises and focuses the call window; if a picker is open, focus goes to the picker. The main
   window is not touched.
3. Click a Meet link again in Chat → F4.
4. Click the "call already open" notification (only after F4 on a meeting page).

The main window shows **no** call indicator of its own, the tray icon image does not change, and the tray
tooltip is not changed (see [Rationale §4](07-meet-rationale.md)).

### F8 — The network drops during a call
The app does nothing of its own. Meet's page shows its own "Reconnecting" state and handles the rest;
the shell cannot reliably observe the network from the call window, and a strip repeating Meet's message
would add nothing. If the Meet page itself is reloaded or navigated while offline and the load fails →
F2. End state: back in the call by Meet's own means, or F2.

### F9 — A Chat message arrives during a call
Unchanged from FR-05 / FR-14 (owner decision): the OS notification still appears (unless muted), the tray
blinks and the taskbar flashes because the main window is not focused. Clicking the notification brings
the **main** window forward (FR-05c); the call window keeps running. End state: main window in front, call
still open.

### F10 — Something in the call page tries to open another site
Meet's page (or a link inside it) asks to open a page that is not on `meet.google.com` or
`accounts.google.com`. The popup or navigation is blocked (NFR-07) and **the user is told** through SC-1:
"A link was not opened." with a dismiss button. The message stays until dismissed; a new block after a
dismiss shows it again. Whether the link should instead be copied or opened in the system browser is the
owner's choice ([08](08-meet-open-questions.md), OQ-3). End state: still in the call.

### F11 — The Meet page's process crashes
The page process dies (the call and its devices go with it). The separate app-owned view (which did not
crash) shows CW-4: "The call window stopped working. Your call has ended." with **Reload** (→ CW-1,
reloads the same address so the user can rejoin) and **Close window** (destroyed, no dialog: the dead page
cannot object). If the app view itself cannot be shown, the user sees a blank window and can close it
(no dialog). End state: rejoining, or no call window.

### F12 — Google asks the user to sign in inside the call window
The shared session has expired or was revoked: Meet redirects to `accounts.google.com`, which is
permitted in the call window. The window shows Google's own sign-in page (CW-5, Google-owned). After a
successful sign-in Google sends the user back to the Meet address → F1 step 3.

**If Google blocks sign-in in an embedded window here** (a "this browser or app may not be secure"
page): the app draws nothing over it. The way out is: close the call window (no dialog), sign in from
the **main window**, which has the app's sign-in strategy and its pre-designed fallback
([ADR-0001](../adr/0001-google-sign-in-strategy.md)), then click the Meet link in Chat again (the session
is shared, so the call window then loads signed in). Because the block page has no in-app instruction,
this route is the documented behaviour, and the call window's error state does not repeat it. End state:
signed in and rejoined, or window closed.

### F13 — The call ends by itself
The user leaves through Meet's own Leave button, or the host ends the call. Meet shows its own "You left
the meeting" page (Meet-owned). Options: Meet's "Rejoin" (stays in CW-2), Meet's "Return to home screen"
(Meet landing), or close the window — **which does not prompt** (F5 step 3: the page no longer objects).
End state: window closed, or rejoined.

## 3. Use cases (short)

| # | Actor | Trigger | What happens | Ends as |
|---|---|---|---|---|
| UC-1 | User | Clicks Meet link, no call window | Window opens at once, Meet loads | In the call (F1) |
| UC-2 | User | Meet page cannot load | Error panel, retry or close | Retry, or window gone (F2) |
| UC-3 | User | Presses "Present now" (Windows) | Picker, choose, Share | Sharing (F3) |
| UC-4 | User | Cancels the picker | Nothing shared, no auto-choice | Not sharing (F3) |
| UC-5 | User | Presses "Present now" (Linux, if Spike B allows) | OS picker, no app picker | Sharing or not (F3b) |
| UC-6 | User | Second Meet link, meeting page on screen | Existing window focused + notification | Same call (F4) |
| UC-7 | User | Second Meet link, no meeting page on screen | New link loads in the existing window | Opening the new address (F4) |
| UC-8 | User | Closes the window during a live call | Confirm; leave or stay | Window gone or still in call (F5) |
| UC-9 | User | Closes the window after Meet's Leave | No prompt | Window gone (F5, F13) |
| UC-10 | User | Exit from tray during a live call | Confirm; exit or cancel | App gone or unchanged (F6) |
| UC-11 | User | Call window is buried | Taskbar, tray "Show call window", link, notification | Window in front (F7) |
| UC-12 | User | Tries to close while the picker is open | Picker raised and flashed | Picker answered first (F3) |
| UC-13 | Network | Connection lost in a call | Meet's own handling only | Back in the call or F2 (F8) |
| UC-14 | Chat | New message during call | Notification, blink, flash as usual | Main in front on click (F9) |
| UC-15 | Call page | Tries to open another site | Blocked, user told in strip | Still in call (F10) |
| UC-16 | Meet page | Process crashes | Crashed panel | Rejoin or window gone (F11) |
| UC-17 | Google | Session expired / embedded sign-in blocked | Google's page; main-window sign-in route | Rejoined or closed (F12) |

## 4. Every control has a destination

| Control | Where | Destination |
|---|---|---|
| Try again | CW-3 | CW-1 (retry, same address) |
| Reload | CW-1 slow, CW-4 | CW-1 |
| Close window | CW-1 slow, CW-3, CW-4 | Window destroyed, no dialog |
| Title-bar minimize / maximize | Call window | OS behaviour on that window |
| Title-bar close | Call window | F5 (or raises the picker, if one is open) |
| Dismiss (x) | SC-1 | Strip hides; focus returns to where it was |
| Close window / Keep window open | SC-2 close | Window destroyed / back to the call |
| Exit / Cancel | SC-2 exit | Process ends / back to where the user was |
| Screens / Windows tabs | SP | Switches the list; any selection is cleared |
| Refresh | SP-2..SP-5, SP-8 | SP-1, then a fresh list |
| Source card | SP | Selects exactly one source |
| Share | SP | Picker closes, source given to Meet (or SP-7) |
| Cancel / Escape / title-bar close | SP | Picker closes, request denied |
| Try again | SP-6 | SP-1 |
| Show call window | Tray menu | Call window restored, raised, focused (picker if open) |
| Notification click | SC-3 | Call window (picker if open) focused |
| Settings switch "Confirm before closing a call" | Settings, only under option B | Turns the SC-2 close confirm on/off |
| Meet's own buttons | CW-2 | Owned by Google; not designed here |

## 5. Traceability to requirements

| Requirement scenario | Covered by |
|---|---|
| FR-16 open from link, Join button, calendar card, main-frame navigation | F1 |
| FR-16 login carries over | F1, F12 |
| FR-16 app picker, cancel shares nothing | F3 |
| FR-16 Linux/PipeWire uses OS picker | F3b (conditional on Spike B) |
| FR-16 closing destroys, never quits, releases devices | F5, F2, F11 |
| FR-16 second link focuses, notification regardless of mute, click focuses | F4 (meeting page only; see A3) |
| FR-16 tray Show/Hide does not affect the call window | F7 |
| FR-14 indicators still fire in a call | F9 |
| NFR-07 call window navigation limited | F10, F12 |

Drawn but not in the requirements text — every one is an owner-ratification item listed with exact
wording in [09](09-meet-proposed-amendments.md): the live-call close confirmation (A1), Exit confirmation
(A2), the second-link split (A3), the tray "Show call window" entry (A4), the link-blocked message (A5),
the crashed panel (A6), the Linux OS-picker conditional (A7), and the app view's web-preferences
assertion (A8, for the business analyst).
</architecture>

<topics>
- [Call window](04-meet-call-window.md)
- [Source picker](05-meet-source-picker.md)
- [Shared components](06-meet-shared-components.md)
- [Rationale](07-meet-rationale.md)
- [Open questions](08-meet-open-questions.md)
- [Proposed requirement amendments](09-meet-proposed-amendments.md)
- [Requirements — FR-16, NFR-07](../business/requirements.md)
</topics>
