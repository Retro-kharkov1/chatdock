# Call Window — Wireframes and Spec

<overview>
The app-owned window that shows a Google Meet call ([FR-16](../business/requirements.md)). Google Meet
draws the call; the app draws the frame, the loading, failure and crash panels, and one status strip.
Flows and the definitions of "call window exists", "meeting page on screen" and "live call":
[03](03-meet-flows.md). Shared pieces (strip SC-1, panel SC-5, confirm SC-2):
[06](06-meet-shared-components.md). Tokens are inherited from the
[Settings spec §7](00-settings-surface-spec.md).

**Architecture (decided by the technical lead).** The window's own web contents is Meet (no preload). A
child **app view** — bundled local page, own preload, own non-persistent session, sandboxed, no
navigation — draws CW-1, CW-3, CW-4 and the strip, driven by a full-state message from the main process
and four actions back (retry, reload, close, dismiss-strip). The panels **give way when Meet loads**;
Google sign-in (CW-5) and the Meet landing page are shown by the Meet view with the app view hidden; a
crashed Meet page leaves the app view alive to draw CW-4. Nothing app-owned is drawn inside the Meet
page. Because Meet is the window's own web contents, closing the window consults Meet's unload objection;
the close invariants are in [03 §0](03-meet-flows.md).

Legend: `[ Button ]` a button, `(spinner)` an indeterminate progress indicator, `(i)` information glyph,
`(!)` warning glyph plus text, numbered callouts `(1)` map to the "What is on it" table.
</overview>

<architecture>
## 1. Wireframes

### CW-1 Opening (light theme) — shown the instant the window is created

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Google Meet — Google Chat Desktop                        [–]  [□]  [x]  │ (1)
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │ (2) strip region:
│                                                                          │     empty, 0 px high
│                                (spinner)                                │ (4)
│                          Opening the call…                               │ (5)
│                     meet.google.com/abc-defg-hij                         │ (6)
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
      default size 1024×720, minimum 480×360 (see §4)
```

CW-1 slow (after 10 seconds, timer only, without the page finishing):

```
│                                (spinner)                                │
│                          Opening the call…                               │
│                     meet.google.com/abc-defg-hij                         │
│              (i) This is taking longer than expected.                    │ (7)
│                     [ Reload ]     [ Close window ]                      │ (8)
```

### CW-2 Meet page (light theme frame; content drawn by Google Meet)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Meet – abc-defg-hij — Google Chat Desktop                [–]  [□]  [x]  │ (1)
├──────────────────────────────────────────────────────────────────────────┤
│ (strip region — SC-1 appears here only while it has a message)           │ (2)
├──────────────────────────────────────────────────────────────────────────┤
│ ┌──────────────────────────────────────────────────────────────────────┐ │
│ │        Content drawn by Google Meet: pre-join screen, the call,      │ │ (3)
│ │        Meet's own controls, its "You left the meeting" page, its     │ │
│ │        reconnecting, permission and device messages.                 │ │
│ │        The app does not add, move or restyle anything here.          │ │
│ └──────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────┘
```

### CW-2a Meet page with the status strip showing (light and dark)

Light (`--bg-strip` #F3F3F3, text `--text-primary` #1B1B1B, glyph `--error` #A80000):

```
├──────────────────────────────────────────────────────────────────────────┤
│ (!) A link was not opened.                                       [ x ]  │ (2) 48 px high
├──────────────────────────────────────────────────────────────────────────┤
│                       Meet content, pushed down 48 px                    │
```

Dark (`--bg-strip` #2B2B2B, text `--text-primary` #F5F5F5, glyph `--error` #F1707B, dismiss hover
`--hover` #333333, focus ring #479EF5):

```
├──────────────────────────────────────────────────────────────────────────┤  window bg #1F1F1F
│ (!) A link was not opened.                                       [ x ]  │  strip #2B2B2B
├──────────────────────────────────────────────────────────────────────────┤  1 px `--border` #3B3B3B
```

The strip carries this one message only (offline and back-online strips were dropped: the shell cannot
reliably observe the network from the call window, and Meet shows its own reconnecting state).

### CW-3 Load error (light theme)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Google Meet — Google Chat Desktop                        [–]  [□]  [x]  │
├──────────────────────────────────────────────────────────────────────────┤
│                                  (!)                                     │ (4)
│                         Couldn't open the call                           │ (5)
│                  You're not connected to the internet.                   │ (9)
│                     meet.google.com/abc-defg-hij                         │ (6)
│                      Code: ERR_INTERNET_DISCONNECTED                     │ (10)
│                    [ Try again ]     [ Close window ]                    │ (8)
└──────────────────────────────────────────────────────────────────────────┘
```

Reason lines, chosen from the load error class (this is the only network knowledge the window uses):
"You're not connected to the internet." · "Google Meet can't be reached right now." · "A secure connection
to Google Meet couldn't be made." · "The page couldn't be loaded." (fallback for anything else).

### CW-3 Load error (dark theme)

```
┌──────────────────────────────────────────────────────────────────────────┐  bg #1F1F1F
│ Google Meet — Google Chat Desktop                        [–]  [□]  [x]  │  OS title bar
├──────────────────────────────────────────────────────────────────────────┤
│                                  (!)                                     │  --error #F1707B
│                         Couldn't open the call                           │  text #F5F5F5
│                  You're not connected to the internet.                   │  text #F5F5F5
│                     meet.google.com/abc-defg-hij                         │  secondary #B3B3B3
│                      Code: ERR_INTERNET_DISCONNECTED                     │  secondary #B3B3B3
│                    [ Try again ]     [ Close window ]                    │  primary: accent #479EF5
└──────────────────────────────────────────────────────────────────────────┘
```

### CW-4 Meet page process crashed (light theme; dark uses the CW-3 dark mapping)

Drawn by the separate app-owned view, which is not the process that crashed.

```
│                                  (!)                                     │
│                    The call window stopped working                       │
│                        Your call has ended.                              │
│                     meet.google.com/abc-defg-hij                         │
│                     [ Reload ]     [ Close window ]                      │
```

### CW-5 Google sign-in inside the call window (Google-owned content)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Sign in – Google Accounts — Google Chat Desktop          [–]  [□]  [x]  │
├──────────────────────────────────────────────────────────────────────────┤
│                 Google's own sign-in page (accounts.google.com)          │
│                 The app draws nothing on it. If Google refuses to        │
│                 sign in here, see flows F12: close this window, sign     │
│                 in from the main window, click the link again.           │
└──────────────────────────────────────────────────────────────────────────┘
```
The instruction inside the box is documentation for the reader; the window itself shows only Google's page.

### CW-6 Full screen (from Meet's own full-screen control)

The window fills the display; the title bar and strip region are hidden. Escape or Meet's control leaves
full screen. Nothing app-owned is visible, and nothing app-owned needs to be: with the offline strips
gone, the only strip message is "A link was not opened.", which is simply shown when the strip region is
visible again, if the user has not yet dismissed it.

## 2. What this window is for

The person is in, or about to join, a Google Meet call started from a Chat link. The decision they make
here is only "stay in this call" or "leave it"; everything about the call itself belongs to Meet. The
app's job is to make sure the window is never blank, never silently broken, and never closed by accident
in the middle of a conversation.

## 3. What is on it

| # | Region / control | Content | Notes |
|---|---|---|---|
| 1 | Native title bar | Title follows the page title; falls back to "Google Meet"; always ends with " — Google Chat Desktop". Minimize, maximize/restore, close | OS-drawn. No application menu (FR-15 decision). Close = F5 |
| 2 | Status strip (SC-1) | One message: "A link was not opened." with a dismiss button; 48 px high; absent (0 px) when empty | Above the content, never over it. Only its dismiss button is in the tab order |
| 3 | Meet content | Google's page | Owned by Google; keyboard and screen-reader behaviour is Meet's |
| 4 | Status glyph | Spinner (loading) or warning glyph | Glyph plus text, never colour alone |
| 5 | Heading | "Opening the call…", "Couldn't open the call", "The call window stopped working" | Focus target for error states |
| 6 | Address | Host and path of the requested link, no query string | Lets the user recognise which call |
| 7 | Slow-load note | "This is taking longer than expected." | After 10 s, announced politely |
| 8 | Buttons | Try again / Reload (primary), Close window (secondary) | Primary first in tab order |
| 9 | Reason | One plain-language line | From the load error class |
| 10 | Error code | `Code: <name>` | Small, `--text-secondary` |

Applies uniformly to: this is a single window. The frame rules (native title bar, size limits, title
format, no menu) hold for every state CW-1 to CW-6.

## 4. Size and layout by window width

| Window width | App-owned parts |
|---|---|
| ≥ 900 px | Panels centred, max content width 480 px; strip text on one line |
| 640 – 899 px | Same |
| 480 – 639 px (minimum) | Panel margins 16 px; strip text wraps and the strip grows to 72 px; buttons stack vertically, full width, primary first |
| below 480 px | Not reachable: minimum window size is 480×360 CSS px |

Default size 1024×720, opens centred on the display that shows the main window (primary display if the
main window is hidden). Size and position are **not** remembered between calls (deliberately the cheap
option; [08](08-meet-open-questions.md), OQ-9). Resizable, minimizable, maximizable, Meet full screen
allowed.

## 5. Signals the shell may not observe, and what happens without them

| Signal | Used for | If it is not available |
|---|---|---|
| Meet page objects to closing ("live call") | Close and Exit confirmations | Treated as not live: no confirmation; close and Exit act at once. Also the case when the user has not yet interacted with the page (the engine ignores the objection) |
| Meet page answers the unload check at all | Close and Exit | A page that does not answer within the timeout (proposed 3 s) is treated as not live and the window is destroyed; a close is never left doing nothing (invariant I1) |
| Requested address, navigation events | "Meeting page on screen", strip trigger, address line | Page counts as a meeting page (second link then focuses and notifies, never navigates) |
| Load failure and its error class | CW-3, reason line | The app view stays on CW-1; after 10 s the slow-load note offers Reload and Close window. Reason line falls back to "The page couldn't be loaded." |
| Page process gone | CW-4 | The app view is a separate process and still draws CW-4; if it too cannot, the window is blank and a close is destroyed at once (a dead page cannot object; invariant I3) |
| Page title | Window title | "Google Meet — Google Chat Desktop" |
| Blocked popup / navigation | Strip message | Cannot be missing: the shell is the one blocking it |
| Network online/offline | **Not used** | Not applicable: no offline strip, no automatic retry |

## 6. Every state

| State | Trigger | What the user sees | What they can do |
|---|---|---|---|
| CW-1 Opening | Link accepted; window created (or a new link loaded into a window with no meeting page, flows F4) | Panel: spinner, "Opening the call…", address | Close (X, no dialog), wait |
| CW-1 slow | 10 s without load completing | Adds slow-load note, Reload, Close window | Reload → CW-1; Close window → destroyed |
| CW-2 Meet page | Page loaded | Google Meet's content | Everything Meet offers; close → F5 |
| CW-2a Strip | Popup/navigation blocked | Strip "A link was not opened." | Dismiss |
| CW-3 Load error | Page load failed | Error panel, reason, code | Try again, Close window |
| CW-4 Crashed | Page process gone | Crashed panel | Reload, Close window |
| CW-5 Sign-in | Session invalid; redirect to accounts.google.com | Google's sign-in page | Sign in (Google-owned) or close; blocked embedded sign-in → flows F12 |
| CW-6 Full screen | Meet's full-screen control | Meet fills the display | Leave through Meet or Escape |
| Ended by Meet | User left or host ended | Meet's end page | Meet's Rejoin / Return to home; close without a dialog |
| Picker open | Meet requested display capture | SP modal over this window; this window not interactive | Finish or cancel the picker; a close attempt raises and flashes the picker |
| Close requested, live call | X, Alt+F4, taskbar close; Meet objects | SC-2 confirm | Close window / Keep window open |
| Close requested, not live | Same triggers; Meet does not object | Window closes | — |

## 7. Behaviour

| Control / event | Behaviour |
|---|---|
| Title-bar close and all other close routes | F5. The window is **destroyed**, never hidden (FR-16). While the picker is open: nothing closes, the picker is raised, focused and flashed |
| Try again / Reload | Reloads the same Meet address; state returns to CW-1 |
| Close window (panels) | Destroys the window immediately, no dialog |
| Strip dismiss | Hides the strip; focus returns to the previously focused element |
| Second Meet link | Meeting page on screen: raise + focus this window (picker if open) + SC-3 notification. Otherwise: load the new link here (CW-1), raise and focus, no notification (F4) |
| Page process gone | CW-4; devices are released with the process |
| Popup / navigation to a host other than `meet.google.com`, `accounts.google.com` | Blocked; strip "A link was not opened." (F10) |
| Tray "Show call window" | Restores, raises, focuses this window; picker gets focus if open |
| Taskbar | Own taskbar button and switcher entry. Does **not** flash for Chat messages (FR-14 flashes the main window only) |
| Not wired | "Open in browser" on the error panel (OQ-8); automatic retry (no network signal) |

## 8. Accessibility (WCAG 2.2 AA), app-owned parts only

- **Reading order and focus.** Panel: heading, reason, address, code, buttons. On entering CW-3 or CW-4
  focus moves to the heading (`tabindex="-1"`), then Tab reaches the primary button. CW-1 announces
  "Opening the call" through a polite live region and does not steal focus.
- **Names, roles, values (4.1.2).** Panels are a `main` landmark with an `h1`. Spinner is
  `role="progressbar"`, no value, labelled "Opening the call". Strip is `role="status"`; its dismiss button
  is named "Dismiss".
- **Status messages (4.1.3).** "A link was not opened." is announced without moving focus.
- **Use of colour (1.4.1).** Warnings are glyph plus text.
- **Contrast (1.4.3, 1.4.11).** Tokens from Settings spec §7 and [06 §7](06-meet-shared-components.md);
  hand-estimated (§11).
- **Target size (2.5.8).** Buttons are at least 44 px tall. The strip is 48 px high so its dismiss control
  is a full 44×44 target with 2 px inset.
- **Focus visible (2.4.7).** Two-pixel `--focus-ring` with two-pixel offset on every interactive element.
- **Reflow and zoom (1.4.10).** Layout holds to the 480 px window minimum; text wraps.
- **Reduced motion.** Under `prefers-reduced-motion` the spinner is replaced by static "Loading…" text.
- **Not app-owned.** Meet's own content: keyboard, captions, screen-reader support are Google's.

Interaction states: [06 §6](06-meet-shared-components.md).

## 9. Why it is like this

- **Shown immediately.** A blank or late window reads as "nothing happened", so the user clicks again.
- **A strip, not an overlay.** An overlay would cover Meet's controls; a strip above the page never does.
- **Confirmation keyed on a live call, not on a page.** See [Rationale §2](07-meet-rationale.md).
- **No app content inside Meet's area.** The rule for the main window (nothing injected into a page the
  app does not own) holds here too.
- **No offline strip.** Unobservable from here, and Meet already shows its own state.

## 10. What was not designed, and why

| Not designed | Why |
|---|---|
| Meet's pre-join, in-call and end screens | Google's page |
| Camera/microphone permission and device errors | Meet reports them itself |
| Offline / back-online messages, automatic retry | No dependable network signal in the call window |
| "Open in browser" on the error panel | Owner's Spike B fallback answer (OQ-8) |
| Remembering size and position | Not requested (OQ-9) |
| Mini / picture-in-picture window | Not requested |
| Behaviour on OS shutdown or log-off with a call open | The OS ends the process; nowhere reliable to ask |
| A "hung page" message | None. A hung page is handled by the close timeout only: the user's close is answered within the timeout by destroying the window (invariant I3) |
| Tray icon or tooltip change for a call | Dropped by decision ([Rationale §4](07-meet-rationale.md)) |

## 11. What was not verified

- Contrast ratios: hand-estimated from Settings spec values, not measured on a rendered build.
- No layout was opened in a browser or Electron; all drawings are text.
- That the live-call check works (Meet objects to being closed only during a call, and does so once the
  user has interacted with the page), that the app can intercept and override the objection for an
  app-initiated close only, and that the address, crash and title signals can be obtained, is unchecked;
  all depend on Spike B and the architecture document.
- Meet itself running inside Electron is unproven (ADR-0004 Spike B).
</architecture>

<topics>
- [Flows](03-meet-flows.md)
- [Source picker](05-meet-source-picker.md)
- [Shared components](06-meet-shared-components.md)
- [Rationale](07-meet-rationale.md)
- [Open questions](08-meet-open-questions.md)
- [Proposed requirement amendments](09-meet-proposed-amendments.md)
</topics>
