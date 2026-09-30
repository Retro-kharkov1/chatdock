# Meet Feature — Rationale

<overview>
The judgement calls behind the Meet design, with the alternatives that were rejected, so a reviewer can
challenge a specific call. Behaviour lives in [03](03-meet-flows.md); drawings in
[04](04-meet-call-window.md), [05](05-meet-source-picker.md), [06](06-meet-shared-components.md).
Guidance consulted: Windows dialogs and flyouts
(https://learn.microsoft.com/windows/apps/develop/ui/controls/dialogs-and-flyouts/), Windows
confirmations (https://learn.microsoft.com/windows/win32/uxguide/mess-confirm), Windows dialog box
guidelines (https://learn.microsoft.com/windows/win32/uxguide/win-dialog-box), WCAG 2.2
(https://www.w3.org/WAI/WCAG22/Understanding/), and ARIA tabs and radio patterns
(https://www.w3.org/WAI/ARIA/apg/patterns/).
</overview>

<architecture>
## 1. Second Meet link: depends on what the window shows

- **Meeting page on screen:** raise and focus the existing window and show the "call already open"
  notification. A notification alone fails when the OS suppresses notifications and leaves the window
  where it was, so the click looks ignored; focus alone does not say the new link was deliberately not
  opened. Together either signal is enough.
- **No meeting page on screen** (opening, error, crashed, sign-in, Meet landing): load the new link into
  the existing window. There is no call to protect, "a call is already open" would be false, and refusing
  the link would leave the user stuck on an error panel with a link that will not open.
- **How the two are told apart fails safe.** "Meeting page on screen" is defined by exclusion (known
  non-meeting pages), so an address form the shell does not recognise counts as a meeting page and the
  running call is never navigated away.
- Rejected: opening a second window (owner decision: one call at a time), and navigating a live call to
  the new link (drops a call on a mis-click).

## 2. Closing the call window: confirm only while Meet says a call is live

The first version confirmed whenever a meeting page was showing. That was wrong: after Meet's own Leave
button, "You left the meeting" is at the same address and has no in-app close, so the window's X is the
**normal** way to finish a call, and the dialog would fire at the end of every call. The X is not the rare
path; the correct claim is that closing *during* a call is the rare and costly case.

Chosen signal: the shell asks the Meet page to close, and Meet's own page objects (as a Meet tab does
with "Leave site?") only while a call is live. That is Meet-authored, cheap, and needs no guess about
page states. It is **unverified** and Spike B must prove it. When the signal is missing the design fails
toward **no confirmation** (a close is unguarded), because the opposite error prompts on every call.

The dialog wording is true whenever it can appear (it fires only when Meet objects) and does not describe
camera state, so the pre-join screen cannot show camera-off wording.

Owner options:
| Option | Meaning | Cost |
|---|---|---|
| **A (designed)** | Confirm on live call, no setting | One unguarded close if the signal is missing |
| **B** | A plus a Settings switch "Confirm before closing a call" (default on), drawn in [06 §8](06-meet-shared-components.md) | A fifth Settings row and one persisted value |
| **C** | No confirmation at all | Accidental X during a call drops it; rejoin depends on the host |

Recommendation: A, moving to C if Spike B cannot prove the signal. B only if the owner finds even a
correct confirmation irritating. The Windows guidance asks for a confirmation only when a distinct choice
carries a non-obvious risk (https://learn.microsoft.com/windows/win32/uxguide/mess-confirm); a live call
meets that test, an ended one does not.

## 3. Exit: same check, same fallback

The tray Exit is the only quit. If a call window exists the shell runs the same live-call check as for a
close; a live call gets one confirmation, everything else exits as today. It adds no second quit path.
This changes FR-07's Exit behaviour for that case, so it is an owner-ratification item (A2 in
[09](09-meet-proposed-amendments.md)).

## 4. Reaching a buried call window: no indicator in the main window, no tray icon or tooltip change

Chosen: taskbar button and window switcher (a normal window), tray "Show call window", clicking a Meet
link again, and the notification.
- **Main window strip rejected.** It would take vertical space in Chat for the whole call to duplicate
  the taskbar, and it would be UI attached to a page the app does not own.
- **New tray icon art rejected.** The tray icon already encodes three unread/blink states from the plain
  and badge images (FR-14: no new icon art); a call state would double the table.
- **Tooltip change dropped** (scope ruling). It is unreliable on Linux desktops and adds a state to a
  passive surface nobody is reading during a call.
- **Label "Show call window", not "Return to call".** The window exists in error and sign-in states where
  there is no call; the label says only what is true.
- **Taskbar flash for the call window rejected.** The user is looking at it; flashing it for Chat
  messages would compete with the call.

## 5. What stays Meet's, and what the app draws

The app draws only what Meet's page cannot: loading, failure, crash, the source choice, and confirmation.
It never draws over Meet or injects into it and never re-explains Meet's own device, permission or
reconnecting messages. That keeps the wrapper-not-a-rewrite posture and avoids two conflicting
explanations of one situation. The panels and strip live in a separate app-owned view because they cannot
live in the Meet page (see [04](04-meet-call-window.md) overview).

## 6. No new Settings control by default

Candidates: confirm-on-close switch (option B, drawn but not adopted), remember call-window size,
picker "share audio" default. None is requested; each adds a persisted value and Settings row. They are
open questions so the owner decides, not the design.

## 7. Picker choices

- **No pre-selection, no double-click-to-share, cancel always available.** Screen content is sensitive
  and the requirement forbids an automatic choice.
- **Arrow keys select (native radio behaviour), accepted.** It is still a deliberate action and Share is
  required; a custom listbox would have re-implemented what the native control already does. Tabbing into
  the group does not select.
- **Selection clears on tab switch or Refresh.** A selection the user cannot see must not be shareable.
- **Disabled Share with a visible reason.** Acceptable only because the reason is on screen at all times.
- **Modal to the call window, and never silent about it.** A close attempt while the picker is open raises
  and flashes the picker instead of doing nothing.
- **Single source (PipeWire) shows one unselected card.** Keeps "never choose for the user" even at the
  cost of a second click; disappears if the OS picker replaces the app picker on Linux.

## 8. The strip's "A link was not opened." message

Blocking a popup silently leaves the user clicking a dead link inside the call. The message is neutral
about what to do next because the right next step (copy, open in the system browser, or nothing) is the
owner's decision (OQ-3); the browser route would contradict the requirement that the call window denies
its own popups.

## 9. Offline messages dropped

The call window cannot reliably observe the network, Meet already shows its own reconnecting state, and a
duplicate message that can be wrong is worse than none. Automatic retry on the error panel was dropped for
the same reason: it cannot depend on a network signal.

## 10. Window basics

Native title bar and standard window buttons, no application menu, no in-window Exit, OS theme. That is the
Settings window's convention carried over so the app's windows feel like one product. The call window is
resizable and full-screen capable because Meet needs that.
</architecture>

<topics>
- [Flows](03-meet-flows.md)
- [Call window](04-meet-call-window.md)
- [Source picker](05-meet-source-picker.md)
- [Shared components](06-meet-shared-components.md)
- [Open questions](08-meet-open-questions.md)
- [Proposed requirement amendments](09-meet-proposed-amendments.md)
</topics>
