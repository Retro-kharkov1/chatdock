# Settings Surface — Rationale

<overview>
Records the four judgement calls the brief asked for, why each of the four controls earns its place
(and what was deliberately rejected), and how this design reconciles with
[requirements.md](../business/requirements.md)'s existing FR numbering. Written so a reviewer can
challenge any specific call rather than accept the design on faith.
</overview>

<architecture>
## 1. Surface type: a dedicated native settings window, not an in-page panel or popup

Rejected: injecting a panel into the Google Chat page's own DOM. The main window renders a real,
uncontrolled third-party page; this project's own architecture docs already treat that page as
something to wrap, never rewrite or inject UI into (`wrapper-not-a-rewrite`, see
[notifications.md](../architecture/notifications.md)'s notification-click bridge, which goes out of
its way to delegate to the page's own `Notification` object rather than replace its behavior). A
settings panel drawn over Google's page would need to fight that page's own layout/z-index/keyboard
focus on every Google-side redesign, for a feature that has nothing to do with the page's content.

Rejected: a tray-anchored popup (menu-bar-app style, "click the tray icon, a small panel drops down
next to it"). Electron doesn't give a reliable way to anchor a window's screen position to the tray
icon's location that behaves identically on Windows and Linux (`Tray.getBounds()` exists but its
usefulness varies across Linux desktop environments/app-indicator implementations); building that
gap-filling logic for four toggles is unjustified effort against the alternative.

Chosen: a **second, independent `BrowserWindow`** the app fully owns (own HTML/CSS, own theme
handling, own accessibility tree) — the same pattern Electron apps use for "Preferences" everywhere
(VS Code, Slack, Discord all use a distinct settings surface, not an in-page overlay). Costs nothing
architecturally (Electron is already running one Chromium instance); the only new surface is a very
small, static HTML document.

## 2. Tray menu keeps ONE quick toggle (Mute); everything else moves to Settings

**This decision overrides existing tray UX the owner already uses, and that override was checked
with the owner before being finalized — not asserted unilaterally.** The project carries a standing
rule that UX the owner already uses is not removed without asking (see
`feedback_ask_before_changing_liked_ux` in the space's working notes). Moving "Start at login" and
"Notification sound" out of the tray menu, where the owner currently reaches them today, is exactly
that kind of removal — so this design did not silently apply its own "urgency" heuristic and treat
that as sufficient license to override the rule. The proposal (below) was put to the owner directly,
who was asked to choose between keeping the full checkbox set on the tray vs. shrinking it to Mute
only; the owner chose the smaller tray. That answer, not the heuristic on its own, is why the layout
in [Wireframe F](01-settings-wireframes.md#f-tray-context-menu--updated-replaces-the-fr-07-tables-current-7-item-menu)
stands.

The tension named in the brief is real: the tray is the fastest path to "mute right now," but every
control mirrored in two places is a control that can drift (checkbox says one thing, settings window
says another, because one write path was missed). The urgency reasoning below is why this design
*proposed* the smaller tray to the owner — it is not, on its own, why the rule was allowed to be
overridden; the owner's explicit choice is what did that:

- **Mute notifications stays on the tray**, because it's the one control with a plausible "I need
  this to happen in the next two seconds, without stopping what I'm doing" use case (a call starting,
  a meeting) — exactly the scenario the owner's own "quiet hours" phrasing described. It is
  **live-synced** with the same control in Settings (one `notificationsMuted` boolean, two rendered
  views, one write path) rather than being a second independent setting — see spec §4. This avoids
  the drift risk while keeping the fast path.
- **Start at login, Notification sound, and Blink tray icon on unread move to Settings only.** None
  of these have a "need this in the next two seconds" case — start-at-login only matters at the next
  login, sound/blink preferences are "set once and forget." Leaving them in the tray menu too would
  be duplication with no corresponding urgency to justify the drift risk. This also **shrinks the
  tray menu** from 7 entries (today: Show/Hide, 3 checkboxes, Exit, separator, version) to 5 (Show/
  Hide, 1 checkbox, Settings…, Exit, separator, version) — directly answering the owner's own framing
  ("so that all this can be managed") that the tray menu was becoming the wrong place to manage a
  growing list of preferences.

## 3. Immediate-apply, not Save/Cancel

For four independent booleans with no interdependency (toggling one never invalidates another) and
no destructive/hard-to-reverse consequence (every toggle is instantly reversible by toggling back),
Save/Cancel adds a mode (pending vs. committed) with no corresponding user benefit — it only invites
the "did I remember to save?" failure mode. This matches the platform's own guidance: *"Use a toggle
switch for binary settings when changes become effective immediately after the user changes them"*
(Windows "Toggle switches" guidance,
https://learn.microsoft.com/windows/apps/develop/ui/controls/toggles) — the guidance's own worked
example is literally "kitchen lights," a background-utility analogy that fits this app closely. It
also matches every reference app this design is implicitly benchmarked against (Windows Settings,
macOS System Settings, Slack's own tray/menu preferences) — none use Save/Cancel for boolean toggles.
Save/Cancel would only be warranted if a setting were expensive/risky to apply (e.g., "delete all
local data") or interdependent (e.g., a form with several fields that must be submitted together) —
neither applies here.

## 4. Platform honesty

Already covered in the spec (§5 states table, §6). The summary rule: **attempt, then show success
silently or failure explicitly** — never a toggle that flips back to its old position with no
explanation (a genuine dead-end interaction the skeptic gate would rightly reject), and never a
toggle presented as "on" when the underlying OS state disagrees (which is exactly the bug FR-10's own
acceptance criteria already guard against by requiring the checkbox to "reflect the actual current
OS-level state," not a cached preference). Design carries this rule through Start at login being the
one control that can genuinely fail per-platform.

## 5. Feature-list judgement — what earns its place, and what doesn't

**Built, with justification (repeated from the spec, argued here):**
- Start at login (FR-10) — explicitly requested, has a real platform-mechanism difference worth
  designing around (§4 above).
- Notification sound (FR-11) — explicitly requested.
- Mute notifications (FR-12) — explicitly requested, the one control kept on the tray too.
- Blink tray icon on unread — the owner's literal ask ("blink the tray icon... like in the old
  days"), and the reason a Settings surface was requested at all.
- **About/version line** — the only addition not directly requested. **Corrected 2026-09-30:** this
  rationale originally said the line mirrored the tray's FR-13 diagnostic string. FR-15 (ratified) is
  authoritative and narrower: the About line shows the **app name and version number only**, and is not
  the FR-13 string. Justified because it's zero-cost (one static label, no new state), purely informational
  (nothing to keep in sync), and sits where a user conventionally looks for "what version is this". The
  build-identification detail (SHA, source, timestamp) stays in the tray's FR-13 line, the documented
  reason for which is the incident recorded in
  [ADR-0002](../adr/0002-notification-delivery-mechanism.md).

**Deliberately NOT built (argued against, not silently omitted):**
- **Scheduled "quiet hours"** (auto-mute on a time window/per-day schedule) — the owner's own phrasing
  suggested this, but `requirements.md`'s FR-12 already resolved it as out of scope in favor of a
  manual toggle, and this design does not reopen that call. A time-picker UI, per-day schedules, and
  timezone handling are real added surface for a personal single-user utility with no stated need for
  automation.
- **A second "reduce motion"/"disable blink" control** — redundant with the blink switch itself, which
  already *is* the opt-out (spec §8, WCAG 2.3.1) and, since 2026-09-30, also switches off the taskbar flash
  (owner-approved default: one setting for both; a separate flash setting would be a new control needing a
  wireframe, and is not provided). Adding a second control
  for the same effect would only add confusion ("which one do I turn off?").
- **Custom notification sound file picker / volume control** — FR-11's own scope note already rules
  this out ("Custom notification sounds are not requested and are out of scope"); no reason to reopen
  it here.
- **In-app theme picker (light/dark override)** — the window already mirrors the OS theme live (spec
  §7); a separate in-app override would be a second, competing source of truth for something the OS
  already controls.
- **Save/Cancel buttons, a "Reset to defaults" button, a second Quit/Exit control inside Settings** —
  see §3 for Save/Cancel; a Reset button has no requested need and four independent toggles are cheap
  to manually revert; a second Exit control would violate the standing `quit-only-from-tray`
  architectural constraint (FR-07) that Exit is reachable *only* from the tray menu — Settings must
  not create a second quit path.

Net: the settings surface stays at exactly the four controls asked for/justified, plus one read-only
info line. Nothing padded in.

## 6. Reconciliation with requirements.md — proposed IDs (business-analyst to confirm/assign)

This document does not edit `requirements.md` (out of this task's boundary — `business-analyst` owns
that file and is actively writing it in parallel). Flagging here what that document will need to
reflect once this design is accepted:

> **Superseded 2026-09-30.** The proposals below became FR-14 and FR-15, and FR-14 was then amended by the
> owner: the attention indicator is the tray blink **and** the taskbar flash, starts while the main window
> is **not focused** (hidden, minimized, or visible without focus) and stops when it **gains focus** (the
> "shown/focused" wording in the first bullet was imprecise; "becomes visible" is no longer a stop
> trigger). The text below is kept as the record of what the design proposed; `requirements.md` FR-14 is
> the authority and the spec §9 is corrected to match.

- **New FR, proposed "FR-14" — Blink tray icon on unread.** Acceptance criteria should mirror the
  state machine in [the spec §9](00-settings-surface-spec.md#9-attention-indicators--state-machine-fr-05fr-12fr-14-interaction--settled-corrected-2026-09-30):
  blinks only while unread > 0 AND the setting is on AND not muted; stops immediately when the main
  window is shown/focused (not on a timer, not tied to unread reaching 0); muted suppresses blink but
  keeps the existing FR-05 static badge.
- **New FR, proposed "FR-15" — Dedicated Settings window.** Acceptance criteria should cover: opens
  from the tray's "Settings…" entry (the sole entry point — see §7); single-instance (reuses/focuses an
  existing open Settings window rather than opening a second one); usable whether the main chat window
  is shown or hidden; closing it never quits the app.
- **Amendment to FR-07's tray menu table** — "Start at login" and "Notification sound" checkboxes are
  removed from the tray context menu (moved to the new Settings window only); the tray gains a
  "Settings…" action; "Mute notifications" stays on the tray, live-synced with Settings. See
  [Wireframe F](01-settings-wireframes.md#f-tray-context-menu--updated-replaces-the-fr-07-tables-current-7-item-menu)
  for the resulting menu order.
- **FR-10 / FR-11's Gherkin scenarios** reference "the tray menu's checkbox" — these should be
  reworded to "the Settings window's switch" (Mute's scenarios in FR-12 can keep referencing either
  surface, since both are now valid entry points for that one control).

No change proposed to FR-12's own "manual toggle, not a scheduled window" decision (§5 above concurs
with it).

## 7. Rejected: a native application menu entry point

An earlier revision of this design proposed a second Settings entry point — a plain Electron
application menu with a "Settings…" item and a `Ctrl+,` accelerator — and flagged it for
`business-analyst` to ratify, since it wasn't sourced from any existing FR. It was not ratified;
the entry point is removed (see spec §2). Recording the decision and its reasoning here, not just the
outcome, so it isn't silently re-added later:

- **The owner never asked for a second way in.** The tray's "Settings…" is already a single click
  away at all times the app is running; an application menu would add a second, redundant path for a
  need nobody named.
- **A native application menu is the single most likely surface to reintroduce a second quit path.**
  Electron's default app-menu template and its `role: 'quit'`/`role: 'close'` items call `app.quit()`
  or close the focused `BrowserWindow` directly, bypassing the `isQuitting`-gated `close` handler this
  project relies on entirely (see [tray-lifecycle.md](../architecture/tray-lifecycle.md)) — exactly
  the failure mode `quit-only-from-tray` exists to prevent, and this project treats that rule as
  absolute, alongside `wrapper-not-a-rewrite`.
- **A carefully-written custom template is a weaker guarantee than no surface at all.** The earlier
  revision's answer to the quit-path risk was "build a fully custom `Menu.buildFromTemplate` with no
  quit role" — that is real mitigation, but it only holds as long as every future edit to that menu
  remembers the constraint. Removing the surface removes the risk permanently instead of relying on
  future edits to stay careful. Between "an unrequested feature that needs an ongoing discipline to
  stay safe" and "the feature doesn't exist," the second is the better trade when nobody asked for the
  first.

**Cost, named rather than silently absorbed:** the tray icon is a mouse/pointer target; Electron's
`Tray` exposes no built-in way to reach it purely by keyboard, so dropping the application menu does
remove a keyboard-only path to Settings that `Ctrl+,` would have given a keyboard-only user. This is a
genuine limitation relative to the earlier draft, not a neutral simplification, and it is recorded as
such rather than glossed over.

**Proposed recovery considered — a global keyboard shortcut via Electron's `globalShortcut` module —
was rejected by the project owner.** The proposal was: bind a system-wide accelerator (e.g.
`Ctrl+Shift+,`) directly to the same "open/focus Settings window" handler the tray item calls, on the
reasoning that `globalShortcut` carries no `role`-based menu items and therefore none of the
application-menu's quit-path risk. **Decision: rejected, not built.** Reasoning:

- **The regression is smaller than it first appears, because the whole tray surface is already
  pointer-only.** Exit, Mute, and Show/Hide all live on the tray today and none of them has a keyboard
  path. Settings being reachable only by pointer is consistent with the app's existing UX, not a new
  gap this feature introduces on its own.
- **Adding a keyboard route for Settings alone, while Exit and Mute stay pointer-only, would be an
  inconsistent place to spend the mechanism** — Settings is the least frequently used of the four tray
  actions, making it an odd first (and only) candidate for keyboard reachability.
- **A global shortcut is disproportionate to the need.** It registers system-wide, fires whether or not
  this app is focused, and can silently fail to register at all when another running application
  already holds the same key combination — a failure mode with no good UI answer for a settings window
  that is opened rarely, since there is nowhere in this app's surface to even notice or report that the
  registration silently failed.
- **This is a single-user personal utility** whose owner already reaches every other tray action with a
  mouse; a keyboard-only route serves a use case this app does not otherwise support anywhere.

**Recorded plainly, not softened into a promise:** reaching Settings requires a pointer (mouse, touch,
or equivalent) on the tray icon. No keyboard route into the Settings window exists, and none is
planned — this is a stated limitation, not a gap awaiting a future fix. **This limitation is scoped to
the route *into* the window only.** It does not affect §8's WCAG-grounded accessibility claims about
behavior **inside** the window once open — full keyboard operability (Tab/Space/Enter/Escape), visible
focus indicators, and correct name/role/value semantics for every control remain fully in force and
are unaffected by this decision; a keyboard user who has the window open, by whatever means it was
opened, can operate every control in it without a mouse.
</architecture>

<topics>
- [Settings Surface Spec](00-settings-surface-spec.md)
- [Wireframes](01-settings-wireframes.md)
</topics>
