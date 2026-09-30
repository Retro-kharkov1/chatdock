# ADR-0002: Notification delivery mechanism

**Date**: 2026-09-22
**Status**: accepted (superseded on the `backgroundThrottling` point — see "Revision 3" below)
**Deciders**: tech-lead

> **Status update, 2026-09-30 (pointer only; the decision text below is not rewritten).** Piece 1 and
> Revision 3 (`backgroundThrottling`, Page Visibility) stand for any **page-level** notification. **Piece 2
> (the injected `window.Notification` wrapper) and the fallback in "Risks" are under review**: Chat very
> likely notifies through a service worker, which this wrapper does not see, and its premise that Chat's own
> click handler navigates to the conversation is unverified. FR-05 is now split into FR-05a/b/c
> ([requirements.md](../business/requirements.md)); the open mechanism choice, and the wording of the fallback
> as the FR-05a floor (M3), live in [notifications.md](../architecture/notifications.md) and
> [ADR-0004](0004-desktop-shell-technology-and-electron-retention.md) (Spikes A and C). The fallback's
> "adopt only if a regression is observed" trigger no longer applies as written: BUG-01 is such an observation
> on Windows, so the fallback is now a live candidate. A superseding ADR will follow the spikes.

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

## Revision 3 (2026-09-22, later same day) — the mitigation below broke the feature it protected

**What was decided above, restated plainly:** to guard against Electron issue `#31016` (a feared
freeze of a hidden window's JS on Windows), this ADR set `webPreferences.backgroundThrottling:
false` on the single `BrowserWindow`. That decision is **reverted**. It was implemented, and in
the owner's real test — a colleague sent a message to a hidden window — **no notification
appeared.** `electron-developer` traced the cause.

**Root cause: the mitigation caused the exact class of failure it was defending against, by a
different mechanism than the one it guarded against.** Per Electron's own `BrowserWindow` docs,
"Page visibility" section (`https://www.electronjs.org/docs/latest/api/browser-window`):

> "If `backgroundThrottling` is disabled, visibility state stays `visible` even when the window is
> minimized, occluded, or hidden."

Google Chat's own page reads `document.visibilityState` to decide whether to raise a native
`Notification` for the conversation currently loaded — if it believes the tab is visible, it
suppresses the alert, exactly as it would in a real foregrounded browser tab where alerting the
user is redundant. That is correct behavior on Chat's part; it was never told the window was
actually hidden. With `backgroundThrottling: false`, `visibilityState` never left `"visible"`, so
Chat never called `Notification()` for the hidden case at all. This is not a wrapper, permission,
or delivery-pipeline failure — a self-triggered `Notification()` call was confirmed to still reach
the OS correctly. **The notification pipeline was fine the entire time; the guard was lying to the
page about its own visibility, and the page correctly declined to notify a "visible" tab.**

**The freeze bug this ADR feared is empirically not present at this project's pinned Electron
version (44.4.3), and the original "Open Question" framing above — treating this as read-from-docs,
not yet tested — is now closed.** Direct measurement: with `backgroundThrottling` left at its
default (`true`, i.e. the flag removed entirely), a 1-second `setInterval` was observed firing
every ~1 second over a 6-second window while `document.hidden` was `true`. The page is not frozen
or meaningfully throttled while hidden on this Electron version. Electron `#31016`/`#38924`'s
`no-backport` history (Context, above) is accurate as a historical record of *when* the freeze was
fixed upstream, but this ADR's original conclusion — that the fix's applicability to *this* pinned
version still needed verification before relying on it — has now been answered: it applies. The
freeze this ADR spent most of its Context section reasoning about from documentation was never
actually observed against this app; the thing that broke was the mitigation, which nobody had
checked for side effects before shipping.

**Decision, corrected:** `backgroundThrottling` is **not** set (left at Electron's default,
`true`). `src/main/index.js` carries a comment at the `webPreferences` block pointing back to this
ADR section, recording that the flag was tried, reverted, and must not be reintroduced without
re-reading this reasoning first — re-adding it silently reproduces the exact failure described
above.

**A second, related defect was found by applying the same reasoning in the other direction, before
it could bite the same way.** The same "Page visibility" docs section also states: "When a
`BrowserWindow` is created with `show: false`, the initial visibility state remains `visible`
despite the window being hidden." This app creates its window with `show: false` at construction
(see [overview.md](../architecture/overview.md)) and, on FR-10's hidden-autostart path
(`--hidden` launch flag), never calls a real `show()`/`hide()` transition — so a window launched
hidden at OS login would have reported `visibilityState: "visible"` for its entire life, silently
reproducing this same notification-suppression bug via the launch path instead of the
`backgroundThrottling` path. This was not observed in the field (it did not trigger the failure
that prompted this ADR revision — that came from the `backgroundThrottling` path instead) but was
caught by asking "where else does this same premise hold" once the underlying mechanism was
understood. Fixed by forcing a real `showInactive()` → `hide()` transition on the hidden-autostart
path so Chromium reports a genuine `visible → hidden` change from the first load, matching what the
close-to-tray path already gets for free. See
[tray-lifecycle.md](../architecture/tray-lifecycle.md) for the concrete code.

**Why this belongs in this ADR and not just a code comment:** the code comment says "don't
re-enable this flag." This ADR is what that comment points at, and it is the record of *why*: not
"we tried a setting and it didn't work," but a design that shipped a mitigation for an unverified
risk without checking whether the mitigation itself had a side effect on the very feature it was
protecting. That reasoning failure, not the specific flag, is the thing a future change to this
window's `webPreferences` needs to re-derive before touching this area again — see the "Judgement"
note at the end of this ADR's Consequences section.

## Decision

Two independent mechanisms, kept separate because they solve different halves of FR-05:

1. **Notification content + timing** — unmodified native bridging, `backgroundThrottling` left at
   Electron's default (`true`). **Superseded per "Revision 3" above: this piece originally set
   `webPreferences.backgroundThrottling: false` to keep the hidden page's JS running; that flag is
   reverted because it made Google Chat's own `document.visibilityState` check believe the window
   was always visible, so Chat never fired a `Notification` while hidden — see Revision 3 for the
   full trace.** At this project's pinned Electron version (44.4.3), the default already keeps the
   hidden page's timers/JS — including its own Web Notification calls — running at normal speed, so
   no override is needed. `session.setPermissionRequestHandler` grants the `notifications`
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
- **Superseded by Revision 3, above — kept here only as history, not as the current fallback
  trigger.** This ADR originally treated Electron issue #31016 (a Windows-specific freeze of a
  hidden window's JS under `hide()` + `backgroundThrottling: false`) as the primary risk to design a
  fallback for. Real-desktop verification (Revision 3) found something different: `#31016`'s freeze
  was never actually observed on this project's pinned Electron version (44.4.3) — a 1s interval was
  confirmed still firing every ~1s over 6s while the window was hidden. What actually broke
  notifications was the `backgroundThrottling: false` mitigation itself, by a different mechanism
  (Page Visibility API, not JS execution throttling) than the one `#31016` describes. **The `#31016`
  freeze bug remains a real thing that happened to Electron historically, but it is not this app's
  live risk given the pinned version and the corrected `webPreferences` — do not re-derive a need
  for the fallback below from `#31016` alone.**
  Design, kept as a documented, currently-inactive contingency for a possible future regression (an
  Electron upgrade that reintroduces hidden-window JS throttling — not a currently-observed
  condition): observe `page-title-updated` for an unread-count transition (`0 → N`) and fire a
  **main-process** `Notification` with generic content (`"You have N new message(s) in Google
  Chat"` — sender/preview are not recoverable this way without DOM scraping, an accepted
  degradation), whose `click` handler is the native, fully-supported
  `notification.on('click', () => { win.show(); win.focus(); })` — no injection needed for this
  fallback path. This stays event-driven (triggered by the title-change event, not a timer), so it
  does not violate NFR-02.
- **The concrete trigger for actually adopting this fallback, restated post-Revision-3**: a future
  real-desktop verification (e.g. after an Electron version bump) shows a notification missing or
  delayed while the window is hidden via close-to-tray, **with `backgroundThrottling` left at its
  default** (i.e. not the already-diagnosed-and-reverted case above). Until that is observed, do not
  build the fallback speculatively — it is a documented option, not a task.
- **Judgement carried forward for future design work in this repo**: the failure this revision
  records was not "we picked the wrong flag" — it was shipping a mitigation for a *documented but
  unverified-against-this-app* risk (`#31016`) without checking whether the mitigation itself had a
  side effect on the exact feature it was protecting. The empirical check (task 5's real-desktop
  verification) was always the thing that would have caught this, and it did, just after the flag
  had already shipped rather than before. A future ADR in this repo that proposes a preventive
  `webPreferences`/Electron-behavior override for a risk found only in documentation or an upstream
  issue tracker, not in this app's own measured behavior, should run that empirical check **before**
  the override ships, not after — see also the `hidden-window-must-stay-live` rule this ADR already
  cites: "verified by actually hiding the window and observing a real incoming message produce a
  real OS notification — never by reading the code and reasoning that it should work." That rule was
  right; this ADR just didn't fully follow it before the fact.
