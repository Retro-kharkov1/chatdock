# Settings Surface — Design Spec

<overview>
Design Read (per `design-taste-frontend` §0 Brief Inference): this is a **utility preferences panel
for a single-user background app**, not a product settings page — it should read like Windows
Settings / a menu-bar-app preferences window: quiet, native-feeling, four rows and done, no marketing
chrome, no empty states to fill. Covers the surface for the controls in
[requirements.md](../business/requirements.md) FR-10 (start at login), FR-11 (notification sound),
FR-12 (mute notifications), plus the new **blink tray icon on unread** control the owner asked for.
See [Rationale](02-rationale.md) for why this surface exists instead of an ever-growing tray menu,
and [Wireframes](01-settings-wireframes.md) for the layouts referenced throughout.

Grounded in: Windows "Toggle switches" guidance — *"Use a toggle switch for binary settings when
changes become effective immediately after the user changes them"*
(https://learn.microsoft.com/windows/apps/develop/ui/controls/toggles) — which is the basis for the
immediate-apply decision below; Fluent UI's `fluent-switch` web component, which follows the
[W3C ARIA switch pattern](https://w3c.github.io/aria-practices/#switch)
(https://learn.microsoft.com/fluent-ui/web-components/components/switch); and WCAG 2.2 AA success
criteria cited inline in the Accessibility section.
</overview>

<architecture>
## 1. What the surface is

A **dedicated native Electron `BrowserWindow`** — plain HTML/CSS/JS owned entirely by this app, not a
panel injected into the Google Chat page. This is a hard constraint, not a style preference: the main
window renders `chat.google.com`, a third-party page this app does not control and — per the
project's own `wrapper-not-a-rewrite` posture (see [overview.md](../architecture/overview.md) and
[notifications.md](../architecture/notifications.md)) — must not have UI injected into its DOM.
Building settings as an overlay/panel drawn on top of Google's page would mean fighting that page's
own layout and z-index on every Google-side redesign, for no benefit; a second, independent
`BrowserWindow` costs nothing extra (Electron already runs one Chromium instance) and is fully under
this app's control for theming, accessibility, and layout stability.

- **Title**: "Google Chat Desktop — Settings"
- **Size**: 380×460 CSS px, fixed (not resizable) — four short rows plus an About line do not need
  reflow, and a fixed size avoids building responsive layout for content that never changes shape.
- **Window chrome**: standard OS title bar with a close (X) control only — no minimize, no maximize
  (`resizable: false, minimizable: false, maximizable: false`). It does **not** affect `isQuitting` and
  does **not** quit the app — quitting stays exclusively a tray "Exit" action per the space's
  `quit-only-from-tray` rule and FR-07 ("no in-page Exit control").
- **Closing the window destroys it (`win.destroy()`/lets the default `close` → GC'd `BrowserWindow`
  happen — not `hide()`), decided and committed here, not left as a destroys/hides fork.** Rationale:
  this app is resident in the tray for multi-day uptimes, and the Settings window is opened
  infrequently (a handful of times, not continuously) — the cost of a fresh construction on each open
  is a small, static, four-row HTML document with no heavy assets, which is cheap relative to holding a
  second `BrowserWindow`'s renderer process alive in memory for the app's entire lifetime for a surface
  used rarely. Destroying also removes an entire class of stale-state bug for free: a **hidden** window
  would carry forward its previous scroll position, focus target, and — critically — any inline error
  state (e.g. a failed "Start at login" toggle, §5/§6) into the *next* open, where it would read as if
  that failure just happened again, confusing the owner about whether the retry actually worked. A
  destroyed window is guaranteed to start from a fresh `Loading` state (§5, Wireframe E) every time it
  opens, which is both simpler to reason about and matches the "reflects actual current OS-level state,
  never cached" rule this spec already applies to Start at login (§3) — extending "always re-read the
  live source of truth" from that one control to the whole window's lifecycle is more consistent than
  making it the exception.
  - **Consequence for §2's Instancing rule, restated so it does not silently contradict this:**
    "focuses the existing window rather than opening a duplicate" applies only while a Settings window
    instance currently exists in memory — i.e., between one open and that same window later being
    closed. Because close now always destroys the instance, "already open" and "instance exists" are
    the same condition; there is no window left to focus once it has been closed. A second
    "Settings…" invocation after a prior close therefore constructs a fresh window (§5 Loading state
    applies), not a resurrection of the old one — this is expected, not a gap.
- **Instancing**: single instance while open. If a second "Settings…" invocation arrives while one
  Settings window instance is already alive (not yet closed/destroyed), it focuses that existing
  window rather than opening a duplicate (same pattern as the main window's single-instance behavior in
  FR-08, applied to this window too, for the same reason — no duplicate, driftable instances of the
  same controls, and no risk of two windows racing to write the same `settings.json`). Once the window
  is closed (destroyed, per above), a later "Settings…" invocation constructs a new instance from
  scratch.
- **Not modal** to the main chat window — openable and usable whether the chat window is currently
  shown or hidden to tray, since the whole point of a background tray app is that settings should be
  reachable without first restoring the main window.

## 2. Entry points

1. **Tray context menu → "Settings…"** (the only entry point — the app lives in the tray all day, so
   this is where a user already looks for control). Opens/focuses the Settings window.

**Decided: no native OS application-menu entry point.** An earlier revision of this spec proposed a
second entry point — a plain Electron application menu with a "Settings…" item (`Ctrl+,`) — flagged
there for `business-analyst` to ratify since it wasn't sourced from any FR. It was not ratified; it is
removed. Reasoning, recorded here rather than just silently dropped: the owner never asked for a
second way into Settings, the tray already carries "Settings…" and is reachable in exactly the same
number of steps, and a native application menu is the single surface most likely to reintroduce a
second quit path — Electron's default app-menu role and its `role: 'quit'`/`role: 'close'` template
items call `app.quit()` or close the focused `BrowserWindow` directly, bypassing the `isQuitting`-gated
`close` handler entirely (see [tray-lifecycle.md](../architecture/tray-lifecycle.md)), which is exactly
the failure mode `quit-only-from-tray` exists to prevent. A carefully hand-written custom template with
no quit role, as the earlier revision proposed, is a weaker guarantee than the surface not existing at
all — every future edit to that menu is a fresh chance to reintroduce a quit-capable item by mistake.
Not adding an unrequested feature that carries the project's highest-consequence risk is the safer
trade. See [Rationale §7](02-rationale.md#7-rejected-a-native-application-menu-entry-point) for the
full record.

**Limitation, stated plainly rather than glossed over: Settings has no keyboard-only entry point.**
The tray icon is a pointer target (mouse, touch, or equivalent) — Electron's `Tray` has no built-in
way to reach it purely by keyboard, so the only route into the Settings window requires a pointer. A
system-wide `globalShortcut` accelerator was considered as a recovery and was **rejected by the
project owner** — see [Rationale §7](02-rationale.md#7-rejected-a-native-application-menu-entry-point)
for the full reasoning (in short: the whole tray surface — Exit, Mute, Show/Hide — is already
pointer-only, so this is consistent with existing UX rather than a new gap, and a system-wide shortcut
is disproportionate to a rarely-opened settings window on a single-user utility). **This is a
permanent, recorded limitation, not a planned future fix.** It applies only to the route *into* the
window: once the Settings window is open, by whatever means, full keyboard operability inside it
(Tab/Space/Enter/Escape, visible focus, correct name/role/value — §8) is unaffected and remains fully
in force.

No entry point exists inside the Google Chat page itself — consistent with FR-07's existing rule that
the page carries no in-app chrome controls of this app's own.

## 3. Control inventory

Two labeled sections. Section order and row order match the priority a user is likely to want them
in (login behavior once, notification behavior grouped together).

### General
| # | Control | Type | Default | Persisted key | Applies |
|---|---|---|---|---|---|
| 1 | **Start at login** | switch (`role="switch"`, native `<input type="checkbox">`) | off | read live from OS at every window open (Windows: `app.getLoginItemSettings().openAtLogin`; Linux: existence of the XDG `.desktop` file) — never trusted from a cached preference, per FR-10's existing "reflects actual current OS-level state" rule | immediately |

### Notifications
| # | Control | Type | Default | Persisted key | Applies |
|---|---|---|---|---|---|
| 2 | **Notification sound** | switch | on | `settings.json → soundEnabled` | immediately |
| 3 | **Mute notifications** | switch | off | `settings.json → notificationsMuted` | immediately |
| 4 | **Blink tray icon on unread** *(new)* | switch | on | `settings.json → blinkOnUnread` | immediately |

### Footer (read-only, not a control)
| # | Element | Content |
|---|---|---|
| — | **About line** | Same string as the tray menu's FR-13 diagnostic line, e.g. `Google Chat Desktop 0.1.0 (packaged, built 2026-09-22 13:58)`. Read-only, not clickable, small/muted type. Included here in addition to the tray menu (not instead of) because it is exactly where a user goes when something needs troubleshooting — see Rationale §5. |

Every switch label is a short, literal description of what the control does (per Windows guidance:
*"label it with one or two words... that describe the functionality it controls"*) — no jargon, no
restated On/Off text; the switch's position communicates state, the label names the feature.

## 4. Interaction rules

- **Immediate apply, no Save/Cancel.** Every switch takes effect the instant it is toggled — there is
  no "Apply"/"Save"/"Cancel" button anywhere on this surface. See
  [Rationale §3](02-rationale.md#3-immediate-apply-not-saveCancel) for why.
- **Optimistic UI + reconciliation.** On toggle, the switch visually flips immediately; the main
  process is asked to apply the change (write `settings.json`, and for Start at login, call the OS
  API / write the XDG file). If the OS call fails, the switch **reverts** to its previous state and an
  inline error appears (see §6, Unavailable/error state) — the UI never claims a setting is on when
  the OS disagrees.
- **Live two-way sync for Mute notifications only.** This is the one control also reachable from the
  tray menu (see Rationale §2). The Settings window and the tray checkbox both render the same
  `notificationsMuted` value and both push toggles through the same main-process handler, which then
  broadcasts the new value to whichever surface didn't originate the change (tray → settings window,
  if open; settings window → tray checkbox). No independent "settings-window mute" and "tray mute" —
  one boolean, two views, always consistent within one IPC round-trip.
- **Blink pauses, doesn't grey out, while muted.** When `notificationsMuted` is true, the "Blink tray
  icon on unread" switch stays interactive (the user's preference for *when unmuted* is still worth
  recording) but shows an inline status note under the label: "Paused — notifications are muted." This
  is a text state, not a color-only cue (WCAG 1.4.1). See §6 and the Wireframes' "Muted" state.
- **Keyboard**: Tab moves through controls top-to-bottom (Start at login → Notification sound → Mute
  notifications → Blink tray icon on unread → [Retry link, if present]); Space or Enter toggles a
  focused switch; Escape closes the window (equivalent to clicking the title-bar close button — does
  not quit the app). No keyboard trap; focus order matches visual/DOM order (WCAG 2.4.3).

## 5. States

| State | Trigger | What's shown |
|---|---|---|
| **Loading** | Window just opened, before the main process has returned live OS state (Start at login) and `settings.json` contents. Sub-200ms in the common case (local disk read), but must be designed, not assumed instant. | Switch rows render in a disabled, low-emphasis "skeleton" appearance (no flicker of a wrong default value); see Wireframe E. |
| **Default / ready** | Normal state once data has loaded. | All four switches reflect live values; About line shows the build string. |
| **Toggling** | Between click and main-process acknowledgment. | Switch shows its new (optimistic) position immediately — no separate spinner for the common, fast, local-disk-write case (sound/mute/blink). Start at login's OS call is the one case worth a brief (≤1s) inline "Applying…" caption under that row, since it is the one control that can genuinely fail (see next row). |
| **Unavailable / error (Start at login only)** | **Resolved (was contradictory before this revision — see below): the OS-level call throws, OR a read-back verification after a non-throwing call shows the change did not take.** Windows: `setLoginItemSettings` throws; or, immediately after a non-throwing call, `getLoginItemSettings().openAtLogin` is read back and disagrees with what was just requested. Linux: writing the XDG `.desktop` file throws (e.g. `~/.config/autostart/` isn't writable); or, immediately after a non-throwing write, the file's existence/target is re-read and disagrees with what was just written. | Switch reverts to its prior (usually off) state; an inline message appears under the row: a warning glyph + text, e.g. "Couldn't enable Start at login — couldn't write to the autostart folder." plus a "Try again" text link. Never a silently-dead toggle. See Wireframe C. |
| **Muted (Blink note)** | `notificationsMuted = true`. | Blink tray icon on unread switch unchanged, but shows the "Paused — notifications are muted." note described above. See Wireframe D. |

**Error-state lifecycle, made coherent with §1's destroy-on-close decision:** the inline error row
above lives only in the in-memory state of the current window instance — there is no persisted
"last error" written to `settings.json` or anywhere else. Because closing the Settings window
destroys that instance (§1), the error necessarily disappears when the window is closed; the *next*
"Settings…" open constructs a brand-new window that always starts at **Loading** (previous row) and
re-derives **Default/ready** or a fresh **Unavailable/error** row purely from live re-reads (OS
login-item state, `settings.json`) — never from anything carried over from the prior instance. This
is deliberate, not an oversight: a stale error surviving into a later open (the risk a *hidden*
window would have carried, per §1's rationale) would misreport "this failed again" when the user
may not have retried anything at all since the last open.

## 6. Platform honesty — Start at login

This is the one control with genuine Windows/Linux mechanism divergence (see
[tray-lifecycle.md](../architecture/tray-lifecycle.md)'s "Start at login" section and FR-10's platform
note): Windows uses Electron's native login-item API; Linux has no Electron API and relies on a
hand-written XDG autostart `.desktop` file, which can fail for reasons Windows can't (unwritable
`~/.config/autostart/`, an unusual desktop environment not implementing the autostart spec). The design
response is the same on both platforms — **attempt, verify by read-back, then report success or a
specific failure** — so the user never sees an unexplained dead toggle, and so the "silently doesn't
take" case in §5 is actually implementable rather than decorative:

- **Decision: implement read-back verification, not the thrown-exception-only subset.** After calling
  `setLoginItemSettings`/writing the `.desktop` file without it throwing, the design immediately reads
  the state back (`getLoginItemSettings().openAtLogin` on Windows; re-checking the `.desktop` file's
  existence/target on Linux) and compares it to what was just requested. This is chosen over dropping
  the silent-no-op clause because it is genuinely implementable — both platforms expose a synchronous
  way to read current state back — and it closes a real gap: a call that returns without throwing but
  did not actually take (documented as possible for Windows's login-item API) would otherwise present
  as a false "success" to the user, which is worse than the extra read-back check.
- Success (call didn't throw AND read-back matches): switch stays in its new position, no extra text.
- Failure (call threw, OR call didn't throw but read-back disagrees): switch reverts, inline error +
  "Try again" link (§5) — same error presentation for both causes; the message text does not need to
  distinguish "threw" from "read back and disagreed" from the user's point of view.
- What remains genuinely undetectable, and is NOT claimed as detected: whether an autostart entry that
  read back as "correctly set" will actually be *honored* at next login by an unusual desktop
  environment that doesn't fully implement the XDG autostart spec. Read-back verification confirms the
  file/registry-key state the app itself controls, not a third-party DE's future behavior — no
  proactive warning is shown for that narrower case, since a warning the app can't actually confirm
  would itself be a false/uncertain signal. If the owner hits this in practice, the fix is a targeted
  follow-up (detect the specific DE and adjust), not speculative UI now.

## 7. Visual design tokens

Plain HTML/CSS, no framework dependency (four rows do not justify pulling in a component library).
Tokens below are informative starting values for the implementer — not a locked palette; verify actual
contrast once rendered.

| Token | Light | Dark |
|---|---|---|
| `--bg` | `#FFFFFF` | `#1F1F1F` |
| `--text-primary` | `#1B1B1B` (≈17:1 on `--bg`) | `#F5F5F5` (≈15:1 on `--bg`) |
| `--text-secondary` (helper/About text) | `#5C5C5C` (≈6:1 on `--bg`) | `#B3B3B3` (≈8:1 on `--bg`) |
| `--border` (row dividers) | `#E1E1E1` | `#3B3B3B` |
| `--accent` (switch-on track) | `#0F6CBD` (≈4.6:1 on `--bg`, ≥3:1 UI-component minimum) | `#479EF5` (≈8:1 on `--bg`) |
| `--track-off` (switch-off track) | `#C7C7C7` | `#5A5A5A` |
| `--error` (inline error text/icon) | `#A80000` (≈6.3:1 on `--bg`) | `#F1707B` (≈6.5:1 on `--bg`) |
| `--focus-ring` | `#0F6CBD`, 2px, 2px offset (≈4.6:1 against `--bg`) | `#479EF5`, 2px, 2px offset (≈8:1 against `--bg`) |
| Font | OS default UI font (Segoe UI on Windows, system sans on Linux) | same |
| Base type size | 14px label / 12px helper text | same |
| Row height (touch/click target) | ≥ 44px (label + switch + padding) | same |

Theme selection: `nativeTheme.shouldUseDarkColors` (Electron) drives a `data-theme="dark"` attribute on
`<html>` at load and live-updates on `nativeTheme.on('updated', ...)` — the window always matches the
current OS theme, it does not carry its own light/dark toggle (this app has no in-app theme preference
to manage; it mirrors the OS, consistent with it being a small native utility window).

## 8. Accessibility conformance (WCAG 2.2 AA)

- **1.4.3 Contrast (Minimum)** (https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html) —
  all text/background pairs above meet ≥4.5:1 (≥3:1 for the switch track, a non-text UI component,
  per **1.4.11 Non-text Contrast**: https://www.w3.org/WAI/WCAG21/Understanding/non-text-contrast.html).
  Verified for both listed themes; re-verify against actual rendered colors before implementation
  ships (this spec's hex values are starting points, not a substitute for a real contrast check).
- **1.4.1 Use of Color** (https://www.w3.org/WAI/WCAG21/Understanding/use-of-color.html) — the error
  state (§5) and the muted/paused note (§4) are both conveyed with a text string plus an icon, never
  by color/position of the switch alone.
- **2.1.1 Keyboard / 2.4.3 Focus Order** — every control operable via Tab/Space/Enter/Escape, no mouse
  required (§4).
- **2.4.7 Focus Visible** (https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html) — every
  interactive element (switches, the "Try again" link, the close button) gets the `--focus-ring` token
  above on `:focus-visible`.
- **2.5.8 Target Size (Minimum)**
  (https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html) — each row's full clickable
  area is ≥44px tall (well above the 24×24 CSS px AA minimum), reducing mis-taps and helping users
  with reduced fine motor control.
- **Flash-rate heuristic borrowed from WCAG 2.3.1, applied as design judgment, not a conformance
  claim.** WCAG 2.3.1 ("Three Flashes or Below Threshold",
  https://www.w3.org/WAI/WCAG21/Understanding/three-flashes-or-below-threshold.html) governs *web
  content*; a native OS tray icon is not a web-content artifact and cannot be "WCAG conformant" in the
  formal sense. This spec nonetheless uses the same 3-flashes-per-second threshold as a sensible
  design heuristic for the blinking tray icon (§9), which alternates at ~1Hz — well under that
  threshold — and the "Blink tray icon on unread" switch itself is the built-in opt-out for anyone
  sensitive to the flashing; no separate "reduce motion" control is needed because disabling this one
  feature *is* the reduce-motion path (see Rationale §5 for why a second control was rejected as
  redundant). This bullet is retained under "Accessibility conformance" because it documents a real
  inclusive-design decision, not because the tray icon itself is asserted to meet WCAG 2.2 AA.
- **4.1.2 Name, Role, Value**
  (https://www.w3.org/WAI/WCAG21/Understanding/name-role-value.html) — switches are
  `<input type="checkbox" role="switch">` with a programmatically associated `<label>`, exposing the
  correct name/role/checked-state to assistive tech; error text is associated to its switch via
  `aria-describedby` so a screen reader announces the failure reason when the control receives focus.
- **Framework-provided controls preferred** (Microsoft Inclusive Design step 2) — native
  `<input type="checkbox">` is used under the hood rather than a hand-rolled div-based switch, so
  keyboard operability and AT semantics are inherited, not reimplemented.

## 9. Tray icon blink — state machine (FR-05/FR-12/FR-14 interaction) — settled

Prose + inline arrows, not a diagram tool, per this project's wireframe/diagram notation convention.

**Resolved by `business-analyst` as FR-14, adopting this design's own recommendation from a prior
revision (see Rationale §6) — the re-entry gap the skeptic gate previously flagged is closed, not
still open.** Three independent triggers govern the blink; none of them depends on window-open
history, so the machine below is memoryless with respect to any earlier open/close of the window:

Idle (unread = 0) → a new message arrives (FR-05) → unread count becomes >0 →
  if `notificationsMuted` is true → tray icon shows the **static** unread badge (existing FR-05
    behavior), no blinking, regardless of `blinkOnUnread`.
  else if `blinkOnUnread` is false → tray icon shows the **static** unread badge, no blinking.
  else (`blinkOnUnread` true and not muted) → tray icon **blinks**: alternates between the plain icon
    and the badged icon on a fixed ~1s interval (a deliberate, small, event-gated timer — only runs
    while unread > 0, not a continuous poll, so it does not reopen the NFR-02 "no busy-polling"
    concern).

From **Unread (blinking)**, three triggers each stop the blink, independently of each other:

1. **Trigger — window becomes visible.** The user shows/focuses the main window — not a timer, not
   "unread reaches 0" — and blinking **stops immediately**, regardless of which conversation is shown
   when the window becomes visible and regardless of whether other unread remains elsewhere. The
   static badge (if any unread remains) continues per the existing FR-05 clearing rule (cleared
   per-conversation as the user actually views it) → state becomes **Unread (static)**, or **Idle** if
   that was the only unread conversation.
2. **Trigger — unread returns to zero while the window is still hidden.** E.g. the owner reads the
   conversation somewhere else (their phone) without ever opening this app's window. Blinking stops
   and the badge clears in the same step → **Idle** directly, with no intermediate static-badge state.
   This is a new trigger, added specifically because an icon still flashing for messages that no
   longer exist is wrong — it did not exist in the pre-FR-14 draft of this spec.
3. **Trigger — the setting itself changes.** `blinkOnUnread` is turned off, or `notificationsMuted`
   becomes true, while blinking is active → blinking stops immediately; the badge stays if unread > 0
   (→ **Unread (static)**) or the icon returns to **Idle** if unread is already 0.

**Resume — settled, memoryless with respect to window-open history:** once in **Unread (static)**
(reached via trigger 1 or 3 above, with unread > 0 still remaining), **any new** message arrival —
while the window is hidden, `blinkOnUnread` is on, and not muted — (re)starts blinking. This holds
**even when the still-unread conversation that caused the earlier stop was never actually opened or
viewed** — i.e. blinking resumes for the new arrival regardless of whether an earlier window-open
already silenced blinking for a different, still-unread conversation. Reasoning (business-analyst's
accepted rationale): the blink is a per-event notification affordance ("something new just happened"),
not a persistent "you have unread" state indicator — that job belongs to the static badge, which
already persists correctly per FR-05. Gating a genuinely new event on an unrelated earlier window-open
would make the blink under-notify exactly when it's supposed to catch attention.

This matches the two behaviors the owner already fixed before design started (blink stops on window
open, not on a timer; muted suppresses blink but keeps the static unread indicator), plus the two
additions FR-14 settles: memoryless resume on any new arrival, and stop-on-zero-while-hidden.
</architecture>

<topics>
- [Wireframes](01-settings-wireframes.md)
- [Rationale](02-rationale.md)
- [Requirements — FR-10, FR-11, FR-12, FR-13](../business/requirements.md)
- [Tray & Lifecycle](../architecture/tray-lifecycle.md)
- [Notifications](../architecture/notifications.md)
</topics>
