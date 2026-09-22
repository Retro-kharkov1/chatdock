# ADR-0002: Notification delivery mechanism

**Date**: 2026-09-22
**Status**: accepted
**Deciders**: tech-lead

## Context

FR-05 is the core of the product: a message arriving while the window is hidden/minimized must
produce an OS-native notification with sender + preview, must not fire for a conversation the user
is actively viewing, must let a click restore the window and navigate to the right conversation,
and must drive a tray unread indicator. `NFR-02` additionally forbids busy-polling.

**Revision note (this pass) — a Windows-specific bug in the exact mechanism below.** Confirmed
directly against `https://github.com/electron/electron/issues/31016` ("Disabling
`backgroundThrottling` not working with hide() on Windows"): on Windows, setting
`backgroundThrottling: false` reliably prevents throttling when a window is *occluded* or
*minimized*, but **not** when it is hidden via `win.hide()` specifically — which is exactly the
mechanism [tray-lifecycle.md](../architecture/tray-lifecycle.md) uses for close-to-tray (FR-06).
(On macOS the same setting reportedly works correctly for all three states — moot for this repo
now that macOS is out of scope per ADR-0003, noted only because it's why the upstream issue frames
this as Windows-specific rather than a general Electron limitation.) Windows is this repo's only
in-scope, currently-verifiable build platform for this bug. The fix
landed in `https://github.com/electron/electron/pull/38924`, merged into Electron `main` on
2023-09-26, explicitly marked `no-backport` (a maintainer declined backporting it to Electron 26 as
a breaking change) — so it is only present starting with whichever Electron major first shipped
after that merge (Electron 27, released 2023-10-10, or later). **This plan must verify the pinned
Electron version (see the plan's "Toolchain choices" — "latest stable at implementation start") is
new enough to include this fix before treating piece 1 below as reliable on Windows**, and this is
not a formality: even with a modern Electron version, this specific interaction (`hide()` +
`backgroundThrottling: false`) is exactly the historically-broken case, not a generic throttling
setting that's obviously fine now. Task 5 in the implementation plan makes this an explicit,
named spike, not an assumption.

The requirements doc's Open Question (FR-05) already identifies the base mechanism: Electron
implements the standard Web Notifications API directly in the renderer (confirmed:
`https://www.electronjs.org/docs/latest/tutorial/notifications` — `new Notification()` in a
renderer produces a native OS notification with no main-process code, and this is the documented
default when a wrapped page already calls the API itself, which Google Chat does for its own
browser-tab notification support — see `electron-desktop.md` §5). The open risk was whether
Chromium's background-tab throttling delays or drops this once the window has been hidden a long
time. This was answered by reading Electron's own documentation, not by running the app — that
distinction matters, so it is stated plainly rather than labeled "empirical": confirmed by
documentation at `https://www.electronjs.org/docs/latest/api/browser-window`:
`webPreferences.backgroundThrottling` defaults to `true` (throttles timers/animations and the Page
Visibility API once a window is hidden/backgrounded) and must be set `false` to keep a hidden
window's script execution — and Google Chat's own message-arrival→Notification-call path — running
at normal speed. This is also `electron-desktop.md` §6 and the space's own
`hidden-window-must-stay-live` rule. **The actual empirical confirmation FR-05's Open Question
asked for has not happened yet — it happens at task 5's real-desktop verification** (see the plan),
which is also where the Windows-specific `hide()` bug below (revision note) gets its real answer.
Nothing in this ADR should be read as having already run and observed the behavior on a real
machine.

A separate, undocumented gap surfaced during this design: the native bridge covers notification
**content and timing** correctly, but **not** "clicking it restores/focuses the window." A page's
own `notification.onclick` handler runs inside the renderer and can at most call something like
`window.focus()` on its own browsing context — that does not un-hide or focus the actual OS-level
Electron `BrowserWindow`, which is a main-process-only operation (`win.show()`/`win.focus()`).
Electron does not publicly expose a main-process event for a renderer-created Web Notification
being clicked, so this half of FR-05 needs its own, narrowly-scoped bridge.

## Decision

Two independent mechanisms, kept separate because they solve different halves of FR-05:

1. **Notification content + timing** — unmodified native bridging. `webPreferences.backgroundThrottling: false`
   on the single `BrowserWindow` keeps the hidden page's own JS (including its own Web Notification
   calls) running normally. `session.setPermissionRequestHandler` grants the `notifications`
   permission for the app's own persistent partition up front (deny-by-default for every other
   permission) so no in-app permission prompt is needed for a single-purpose app whose whole value
   is notifications. Nothing about content, sender, or preview text is touched — Google Chat's own
   page produces it exactly as it would in a background browser tab.
2. **Click → window focus AND landing on the specific conversation** (sharpened by the owner this
   pass — "jump into the chat to that message," their own framing of exactly this mechanism as
   "hooks") — a minimal main-world script injected via `webContents.executeJavaScript()` on
   `dom-ready` (and re-injected on `did-finish-load`, since Google Chat is an SPA and may recreate
   `window.Notification` on route/session changes) that wraps the native `Notification` constructor:
   it **delegates to the original constructor and returns the same live instance unchanged** (so
   appearance/timing/content are untouched, and Google Chat's own code retains a working reference
   to attach its own click handler to) and additionally attaches a `click` listener that sends a
   single fire-and-forget signal to main (`notification:clicked`, no payload beyond nothing
   sensitive). Main responds with `win.show(); win.focus();`. Conversation navigation itself is
   **not** reimplemented — Google Chat's own unmodified click handler still runs (because the
   wrapper delegates rather than replaces) and, in the expected case, already navigates its in-page
   router to the right conversation; the wrapper only adds the missing OS-window-focus step. This
   keeps the "surface to the OS, don't rewrite the page" principle from the space's
   `wrapper-not-a-rewrite` rule: the only added surface is a single write-only click signal. Full
   mechanics — the ordering guarantee, the two named edge cases, and the degraded fallback if Chat's
   page turns out not to navigate on its own — live in
   [notifications.md](../architecture/notifications.md) piece 2 and the plan's task 5b, since this
   is the design's most fragile point and deserves its own dedicated hand-verification, not just an
   ADR-level assertion.
3. **Tray unread indicator** — driven by `webContents.on('page-title-updated', ...)`, a first-party
   Electron event requiring no injection: Google Chat sets an unread count in the document title
   when backgrounded (e.g. `"(3) Google Chat"`), matched with a small regex in the main process.
   `win.setOverlayIcon()` on Windows, and a tray-icon swap (unread/no-unread variant) on Linux (no
   standard badge API there — see NFR-01). macOS is out of scope (ADR-0003) — no Dock-badge path.
   Cleared when the title no longer carries a count or the window regains focus on the relevant
   conversation.

## Alternatives Considered

### Alternative 1: Rely purely on the native bridge, do nothing for click→focus
- **Pros**: zero injected code, simplest possible implementation.
- **Cons**: silently fails the "clicking a notification restores/focuses the window" half of FR-05
  — the notification would appear but be unclickable in the way the requirement demands.
- **Why not**: fails an explicit, gherkin-specified scenario in FR-05.

### Alternative 2: Main-process poll of the DOM/title, fire main-process `Notification`s directly,
  reimplement sender/preview parsing
- **Pros**: full main-process control — click handling is a first-class main-process API
  (`notification.on('click', ...)`), no injection needed.
- **Cons**: re-implements content Google Chat already produces correctly (a "rewrite," against the
  space's `wrapper-not-a-rewrite` rule), fragile to Chat's DOM/title format changing, and a poll
  loop risks violating NFR-02's "no busy-polling" unless strictly event-driven off
  `page-title-updated` rather than a timer.
- **Why not** as primary: unnecessary complexity and rule violation when the native bridge already
  produces correct content. **Kept as the documented fallback** (below) for exactly the case the
  requirements doc's Open Question already flagged.

## Consequences

### Positive
- Notification content is always exactly what Google Chat itself would show — no drift risk from a
  hand-maintained content parser.
- The click→focus gap (missed in the original requirements framing) is closed with the smallest
  possible injected surface — one delegated constructor wrapper, one fire-and-forget IPC signal.

### Negative
- The main-world injection is Electron-version- and Chat-SPA-behavior-sensitive; re-injection on
  `did-finish-load` mitigates route changes but a future Chat redesign that lazily re-defines
  `Notification` after both lifecycle events could silently break click routing again — the
  implementer should log (not swallow) an injection failure so this surfaces instead of degrading
  silently.

### Risks
- **Fallback, pre-designed — the stated primary contingency for a known, named bug, not a
  speculative "maybe" for edge cases.** Electron issue #31016 (see Context, above) is a documented,
  reproducible failure of exactly this mechanism (`hide()` + `backgroundThrottling: false`) on
  Windows — the one platform this repo can currently verify on. This is not the same as the
  original, softer framing ("if empirical testing shows...for long hidden periods"): the bug is
  known to exist independent of how long the window has been hidden, and the concrete trigger for
  adopting the fallback is **"Task 5's real-desktop verification on Windows or Linux (the two
  in-scope platforms) shows a notification missing or delayed while the window was hidden via
  close-to-tray (`win.hide()`, not merely occluded/minimized)."** When that trigger fires, do not
  spend further time debugging piece 1 first — go straight to the fallback below, because the root cause is
  already identified and is not fixable from this app's code (it is Electron/Chromium's own
  compositor behavior).
  Design: observe `page-title-updated` for an unread-count transition (`0 → N`) and fire a
  **main-process** `Notification` with generic content (`"You have N new message(s) in Google
  Chat"` — sender/preview are not recoverable this way without DOM scraping, an accepted
  degradation), whose `click` handler is the native, fully-supported
  `notification.on('click', () => { win.show(); win.focus(); })` — no injection needed for this
  fallback path. This stays event-driven (triggered by the title-change event, not a timer), so it
  does not violate NFR-02.
- Confirming which path (primary or fallback) is actually needed requires the real-desktop
  verification the space's `hidden-window-must-stay-live` rule already mandates: "verified by
  actually hiding the window and observing a real incoming message produce a real OS notification
  — never by reading the code and reasoning that it should work." Given issue #31016, "reasoning
  that `backgroundThrottling: false` should handle it" is specifically the reasoning already known
  to fail on Windows — this is not a generic disclaimer, it's the actual failure mode to check for.
