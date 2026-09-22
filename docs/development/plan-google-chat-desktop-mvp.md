# Plan: Google Chat Desktop MVP

<overview>
The implementation plan for the first shippable version of `google-chat-desktop`, covering all of
FR-01…FR-12 and NFR-01…NFR-05. Read [Architecture](../architecture/README.md) and
[ADRs](../adr/README.md) before starting — this plan sequences the work; the design docs define it.
Written for the `electron-developer` agent. **Target platforms: Windows and Linux only** — macOS is
out of scope (owner decision, see [ADR-0003](../adr/0003-packaging-and-code-signing-approach.md)).
</overview>

## Toolchain choices

- **Language**: plain modern JavaScript (CommonJS, Node 20+/current Electron-bundled Node), no
  TypeScript. Justification: this is a small, single-purpose personal wrapper — the main-process
  logic is a few hundred lines across a handful of files with a narrow, already-fully-specified IPC
  contract ([ipc-contract.md](../architecture/ipc-contract.md)); TypeScript's value (catching
  contract drift across a large surface, many contributors) doesn't apply at this size, and adding
  `tsc`/a bundler is pure overhead for a repo an implementer should be able to run with
  `npm install && npm start`. Revisit only if the codebase grows meaningfully past the wrapper
  shell described here.
- **No bundler**: Electron's main and preload processes run directly under Node; there is no
  framework UI to bundle (the entire renderer content is Google's own page). `electron-builder`
  packages the raw `src/` tree as-is.
- **Packaging**: `electron-builder` (see [packaging-release.md](../architecture/packaging-release.md)
  and [ADR-0003](../adr/0003-packaging-and-code-signing-approach.md)) — Windows + Linux only.
- **Electron version**: pinned in `package.json` (`electron` as a devDependency, not a floating
  range) — currently 44.4.3. The freeze-vs-`#31016` question task 5 was originally written to spike
  on is closed for this version: empirically confirmed to keep a hidden window's page JS/timers
  running at normal speed with `backgroundThrottling` left at its default, and to *not* reproduce
  the historical `electron/electron#31016` freeze (task 5's own real-message check is separately
  still open — see task 5). Pinning (rather than floating) matters precisely because that
  confirmation is version-specific: a future Chromium/Electron bump could in principle change
  hidden-window behavior again, so a version bump is a deliberate act, not an automatic one — see
  [ADR-0002](../adr/0002-notification-delivery-mechanism.md) Revision 3 for the full history of what
  was verified and when.
- **Test runner**: Node's built-in `node:test` + `node:assert` (no extra dependency — sufficient for
  the small set of pure-function unit tests task 0 requires; revisit only if the test surface grows
  well past what's listed there).

## Repository layout

```
google-chat-desktop/
├── package.json
├── .gitignore
├── .github/
│   └── workflows/
│       └── release.yml            — GitHub Actions build matrix (packaging-release.md), Windows+Linux
├── src/
│   ├── main/
│   │   ├── index.js               — app entry: single-instance lock, app lifecycle, window creation
│   │   ├── window-state.js        — FR-02 persistence (overview.md)
│   │   ├── session.js             — FR-03/FR-04 persistent partition + UA (overview.md, ADR-0001)
│   │   ├── auth-fallback.js       — ADR-0001's cookie-import fallback (built only if/when triggered)
│   │   ├── notifications.js       — FR-05 (notifications.md, ADR-0002), FR-11/FR-12 sound/mute
│   │   ├── tray.js                — FR-06/FR-07/FR-08 (tray-lifecycle.md)
│   │   ├── autostart.js           — FR-10 (Windows: setLoginItemSettings; Linux: XDG .desktop file)
│   │   └── settings.js            — FR-11/FR-12 persisted flags (settings.json under userData)
│   ├── preload/
│   │   └── preload.js             — IPC contract (ipc-contract.md)
│   └── assets/
│       ├── icon.{ico,png}         — app icon per platform (no .icns — macOS out of scope)
│       └── tray/
│           ├── tray.png
│           └── tray-unread.png    — Linux badge substitute (tray-lifecycle.md)
├── test/                          — task 0's unit-test net (node:test)
└── docs/                          — this pyramid
```

**Structural constraint carried by task 0**: the pure, deterministic pieces of logic listed there
must live in small standalone functions/modules with their Electron-API dependencies passed in
(e.g. `resolveWindowState(saved, displays, defaultSize)` rather than a function that calls
`screen.getAllDisplays()` internally) — this is what makes them unit-testable without a running
Electron process. Implementers should structure `window-state.js`, `notifications.js`, `tray.js`,
and `preload.js` accordingly from the start, not retrofit it later.

## Task breakdown (in order)

Task 0 is a coverage-first gate and must be GREEN before tasks 3, 4b, 6, and 7 (which depend on the
logic it covers) are considered done. Tasks 1–4 are sequential (each depends on the previous); 4b,
4c, 5, 5b, 6, 7 can proceed in parallel once task 1 lands, but **5b depends on 5** (click-to-conversation
needs the click-to-focus bridge already wired), **4b depends on 4** (sound/mute menu items need
the base tray menu), and **4c depends on 4** (the version line is a tray-menu entry). **4c is a
later, owner-requested addition, already implemented and unit-tested — see its own entry below for
what "done" means for it.** Task 5's done-criterion was re-scoped after a real incident surfaced a
defect in its original mitigation (see task 5's own entry) — the fix is implemented, but the
confirming real-desktop check (a real inbound message producing a real notification, post-fix) has
not yet been run and is still this task's open item, same as **5b**, which has not been run at all.
8 depends on 2–7 being functionally complete; 9 is packaging; 10 is last.

### 0. Testable-surface unit-test net (coverage-first, before dependent tasks)
**Satisfies**: supports FR-02, FR-05, FR-07/10/11/12, NFR-04 — routed to `qa-automation`.
**Why this task exists**: every other task's done-criteria in this plan is hand-verification on a
real desktop, which is correct and required (space's `verify-on-a-real-desktop` rule) for anything
touching actual OS/window/notification behavior — but it is not a substitute for a GREEN automated
net over the pieces that are pure, deterministic logic with no UI or OS dependency. This task
identifies and covers exactly that subset; it does not pad coverage onto code that has no
meaningful pure-logic shape.
**In scope, each as a small standalone function**:
- `resolveWindowState(saved, displays, defaultSize)` — the off-screen-fallback math behind FR-02's
  "persisted position outside all displays → fall back to default, centered" scenario. Test: saved
  position within a display's work area is kept; saved position outside every display's work area
  falls back to the centered default; multi-display edge cases (position valid on a secondary
  display, not the primary).
- `parseUnreadCount(title)` — the tray-badge regex from notifications.md piece 3 (`/^\((\d+)\)/`).
  Test: `"(3) Google Chat"` → `3`; `"Google Chat"` (no count) → `0`; malformed/unexpected title
  shapes (`"(abc) Google Chat"`, empty string) don't throw and resolve to `0`.
- `isAllowedSender(frameOrigin, allowlist)` — the sender-origin check ipc-contract.md's
  `notification:clicked` handler must apply. Test: origins in the allowlist pass; anything else
  (including a similar-looking but different origin, e.g. a typo/subdomain trick) is rejected.
- `shouldMuteOrSilence(mutedFlag, soundEnabledFlag, notificationOptions)` — the decision logic
  behind FR-11/FR-12's wrapper branches (suppress entirely vs. force-silent vs. pass through),
  factored out of the `executeJavaScript` string so it's testable as plain JS before being
  interpolated into the injected snippet. Test: muted → suppress regardless of sound setting;
  unmuted + sound off → silent; unmuted + sound on + page didn't request silent → not silent;
  page's own `options.silent: true` is respected even when the app's sound setting is on.
- `decideSingleInstanceAction(gotLock)` — the branch behind FR-08's lock-vs-quit decision. Test:
  `false` → the "quit immediately" branch is selected; `true` → the "proceed, register
  second-instance handler" branch is selected.
**Explicitly NOT covered here, and why** (hand-verification only, per the tasks below): actual
window show/hide/focus and OS notification delivery (task 5/5b — requires a real OS notification
center); actual tray icon/badge rendering (task 6); the real Google sign-in flow (task 2 — requires
Google's live servers); the real autostart-at-login effect (task 4b — requires an actual OS login
event); actual notification sound playback (task 4b/5). These are correctly out of scope for a unit
net — they have no meaningful pure-logic shape independent of the OS, and simulating them would
test the simulation, not the real behavior.
**Done when**: the functions above exist as extracted, standalone, exported modules; a `node:test`
suite covers every scenario listed; `npm test` is green; this net exists **before** tasks 3, 4b, 6,
and 7 are implemented against it (TDD — the net is written first, then the implementation is built
to satisfy it), not written retroactively to match whatever got built.

### 1. Project scaffold + single window loading Google Chat
**Satisfies**: FR-01, part of NFR-04 (security baseline).
**Done when**: `npm start` opens one resizable `BrowserWindow` at the FR-01 default size, loading
`https://chat.google.com/app/chat/SPACE_ID`, with `contextIsolation: true`, `nodeIntegration:
false`, `sandbox: true`, no `<webview>` anywhere in the codebase, `setWindowOpenHandler` denying
popups by default, and `will-navigate` allowlisted per [overview.md](../architecture/overview.md)
(that allowlist is provisional — see task 2).

### 2. Persistent session + sign-in (primary path)
**Satisfies**: FR-03, FR-04.
**Done when**: `persist:google-chat` partition + custom UA are wired per
[overview.md](../architecture/overview.md); a **real** Google sign-in is completed by hand (not a
pre-seeded dev session), **including a 2FA/security-challenge step if the test account has one
enabled** — this is what actually settles overview.md's provisional `will-navigate` allowlist (add
any additional origin the real 2FA flow hits, rather than treating the starting list as final); the
app is fully quit (tray Exit) and relaunched, and the signed-in view loads with no sign-in prompt;
the machine is rebooted and the same holds. If the primary path shows Google's block during this
real sign-in attempt, stop and implement ADR-0001's fallback (`auth-fallback.js`) before continuing
— do not proceed past this task with a broken primary path.

### 3. Window-state persistence
**Satisfies**: FR-02.
**Depends on**: task 0's `resolveWindowState` net being green.
**Done when**: both FR-02 gherkin scenarios pass by hand — resize/move, quit via tray Exit, relaunch,
geometry restored; and with a saved position forced outside all connected displays, relaunch centers
the default size on the primary display; `resolveWindowState` (task 0) is the actual function this
wiring calls, not a re-implementation of the same logic inline.

### 4. Close-to-tray + base tray menu + single-instance
**Satisfies**: FR-06, FR-07 (Show/Hide + Exit entries), FR-08.
**Depends on**: task 0's `decideSingleInstanceAction` net being green.
**Done when**: all three FR-06/07/08 gherkin scenarios in requirements.md pass by hand, including
the process-still-running-after-X-click check via OS process list, and Exit being the only path
that actually terminates the process.

### 4b. Start-at-login, sound control, mute (FR-10, FR-11, FR-12)
**Satisfies**: FR-10, FR-11, FR-12.
**Depends on**: task 4 (base tray menu exists) and task 0's `shouldMuteOrSilence` net being green.
**Done when**: the "Start at login" / "Notification sound" / "Mute notifications" checkboxes are
added to the tray menu per [tray-lifecycle.md](../architecture/tray-lifecycle.md); FR-10's three
gherkin scenarios pass by hand on **both** Windows (native `setLoginItemSettings`) and Linux (XDG
autostart `.desktop` file) separately — state plainly which platform(s) were actually checked, per
the space's `verify-on-a-real-desktop` rule, since the two mechanisms are genuinely different code
paths, not a shared implementation; FR-11/FR-12's gherkin scenarios pass by hand (sound off →
silent notification; mute on → no notification but tray unread count still updates); all three
settings persist across a full quit-and-relaunch.

### 4c. Build/version diagnostic line in the tray menu (FR-13) — STATUS: DONE
**Satisfies**: FR-13.
**Depends on**: task 4 (base tray menu exists).
**Origin**: owner request, made mid-investigation of the FR-05 notification failure task 5 records
below — not part of the plan's original scope, added once the diagnostic need was real (see
[ADR-0002](../adr/0002-notification-delivery-mechanism.md) Revision 3 and
[requirements.md](../business/requirements.md) FR-13).
**Implemented as**: `src/main/version.js`'s `buildVersionLabel(version, isPackaged, mtimeMs)` (pure,
unit-testable — `formatBuildTimestamp`/`buildVersionLabel` covered under `test/`), wired into the
tray menu as a disabled, last-position entry after a separator (`src/main/tray.js`,
[tray-lifecycle.md](../architecture/tray-lifecycle.md)).
**Done when**: the tray menu shows a disabled build/version line combining `app.getVersion()`,
packaged-vs-source, and a build timestamp; the three FR-13 gherkin scenarios in requirements.md
pass; `buildVersionLabel`/`formatBuildTimestamp` have green unit coverage. **All of the above is
already true** — recorded here as done, not as pending work, so this plan's picture of the project
matches its actual state.

### 5. Notifications — native bridge (content/timing) — STATUS: re-scoped after a real incident, verification still open
**Satisfies**: FR-05 (content/timing), NFR-02.

**This task's original framing is superseded — read this before acting on it.** It originally
named the Windows `hide()` bug (`electron/electron#31016`) as the thing to spike on, and treated
`backgroundThrottling: false` as the mechanism under test. That framing is closed, not open:

- The `#31016` freeze was **not** reproduced on this project's pinned Electron version (44.4.3): a
  1s `setInterval` was measured still firing every ~1s over 6s while the window was hidden. The
  hidden-page-freeze risk this task was written to spike on does not apply here.
- `backgroundThrottling: false` was tried as the mitigation for that risk, and **caused a real
  production-path failure**: a colleague's message to a hidden window produced no notification at
  all, because the flag pins `document.visibilityState` at `"visible"`, and Google Chat correctly
  declines to notify a page it believes is visible. This was root-caused by `electron-developer` and
  is recorded in full in [ADR-0002](../adr/0002-notification-delivery-mechanism.md) Revision 3. The
  flag is reverted; `backgroundThrottling` is left at Electron's default.
- Do **not** re-open this task to re-litigate `backgroundThrottling` — that question is closed. Do
  not, either, treat "the docs say the default should work" as sufficient on its own: it wasn't
  sufficient for the reverted flag, and it isn't the standard here either — see the next paragraph.

**What genuinely remains unverified, and is the actual done-criterion for this task**: a real
inbound message from another person, arriving while the window is hidden to tray, producing a real
OS notification with sender + preview — the owner's own check, per the space's
`hidden-window-must-stay-live` rule ("verified by actually hiding the window and observing a real
incoming message produce a real OS notification — never by reading the code and reasoning that it
should work"). This is not a code-reasoning question and nobody but the owner (or someone with a
second Google account to message the owner's test account) can run it. **Done when**: window hidden
to tray, a real message sent from another account, a real OS notification appears with sender +
preview, on at least the platform(s) actually available to test. State plainly which platform(s)
this ran on. If a notification is still missing or delayed under this condition (a genuinely new
finding, not the already-diagnosed `backgroundThrottling` case), implement
[ADR-0002](../adr/0002-notification-delivery-mechanism.md)'s documented fallback (generic-content,
main-process `Notification` triggered off `page-title-updated`) before marking this task done.

### 5b. Click → land on the specific conversation (FR-05's sharpened requirement) — STILL OPEN
**Satisfies**: FR-05 (click behavior — deep-link to the specific conversation, not just window
focus).
**Status**: unverified, and does not inherit task 5's now-closed `backgroundThrottling`/`#31016`
question — this task was never about that mechanism, it is about whether Google Chat's own page
navigates on notification click, which is an independent, still-open question.
**Depends on**: task 5 (the click-to-focus bridge and IPC channel must exist first) — specifically,
the *bridge/IPC wiring*, not the now-closed spike framing task 5 originally carried; and, like task
5, on a real inbound message from another person while the window is hidden, since there is no way
to trigger a real notification-click flow without one.
**Why this is its own task, not folded into task 5**: this is the design's most fragile point (an
injection into a page Google controls and can change at any time) and the owner's requirement here
is materially sharper than "the window comes back" — it must land on **that** conversation, with
**that** message visible. Hand-verification is mandatory and cannot be inferred from task 5's
success.
**Done when**: with the window hidden to tray, a message arrives in conversation "B" while
conversation "A" was the last one open; clicking the resulting notification shows the app with
conversation "B" open and the triggering message visible — not conversation "A", and not merely "a"
conversation. This must be checked with **at least two different conversations** open in sequence
(not just "click brings the window back and happens to already be on the right one") to actually
exercise the deep-link behavior rather than a coincidence. If Google Chat's own page does not
navigate to the right conversation on notification click (see
[notifications.md](../architecture/notifications.md)'s "Does the page already do this for us?"),
implement the named fallback there — and if even the fallback can't resolve a target conversation,
confirm the degraded case is visibly logged (not silently passing as if deep-linking worked) before
marking this task done.

### 6. Tray unread indicator
**Satisfies**: FR-05's unread-indicator scenarios.
**Depends on**: task 0's `parseUnreadCount` net being green.
**Done when**: unread messages while hidden show a visible tray badge/overlay (per-OS mechanism in
[notifications.md](../architecture/notifications.md)); it clears once the relevant conversation is
viewed; the wiring calls `parseUnreadCount` (task 0), not a re-implementation of the same regex.

### 7. IPC contract implementation
**Satisfies**: NFR-04 (security baseline), supports task 5/5b.
**Depends on**: task 0's `isAllowedSender` net being green.
**Done when**: `preload.js` exposes exactly the surface in
[ipc-contract.md](../architecture/ipc-contract.md) — nothing more; sender-origin validation on the
`notification:clicked` main-process handler calls `isAllowedSender` (task 0), not a re-implemented
check.

### 8. NFR verification pass
**Satisfies**: NFR-01, NFR-02, NFR-03.
**Done when**: idle CPU with the window hidden and no new messages is negligible (no busy-polling
anywhere in the codebase — grep for `setInterval`/`setTimeout` polling loops and justify any that
remain); memory footprint is in line with one Chromium tab of Google Chat; time from launch to
signed-in view is comparable to opening an already-authenticated site in a new browser tab, on each
of Windows/Linux the implementer has access to (state plainly which platforms were actually
checked, per the space's `verify-on-a-real-desktop` rule).

### 9. Packaging + CI release matrix
**Satisfies**: FR-09, NFR-05.
**Done when**: `.github/workflows/release.yml` produces an NSIS `.exe`, an `.AppImage`, and a `.deb`
from one tagged run (Windows + Linux only, per ADR-0003), each artifact matches the signing status
documented in [packaging-release.md](../architecture/packaging-release.md), and the release notes
explicitly state the Windows SmartScreen warning per the space's `installers-are-part-of-done` rule.
Note: the Linux leg cannot be built locally on a Windows dev machine (AppImage packaging needs
Linux-native `mksquashfs`) — it is produced and verified only by the `ubuntu-latest` matrix job, and
is untested until that workflow has actually run once end-to-end.

### 10. End-to-end real-desktop verification
**Satisfies**: all FR/NFR IDs, as a final gate.
**Done when**: a packaged (not `npm start`-launched) build is installed from the produced installer
on at least one real machine per in-scope platform, and every FR-01…FR-12 gherkin scenario in
requirements.md is driven by hand against that packaged build — login survives a full
quit-and-relaunch, a notification appears with the window hidden and clicking it lands on the
specific conversation (not just any window focus), the tray menu quits, single-instance works,
start-at-login/sound/mute all behave as specified. State plainly which platform(s) this actually ran
on; do not claim cross-platform coverage from a single-platform check (space's
`verify-on-a-real-desktop` rule).

## Open questions this plan resolved as design decisions of its own

These were left open by requirements.md and required a design-time call — flagged here explicitly
per the instruction not to bury them:

- **Which cross-platform sign-in evidence to trust** (the primary/fallback split), and **Electron
  vs. a VS Code-extension form** (rejected — VS Code is itself Electron, and its notifications
  aren't OS-native, failing FR-05) — see [ADR-0001](../adr/0001-google-sign-in-strategy.md).
- **How "click a notification" actually reaches the OS window, and now the specific conversation**
  — see [ADR-0002](../adr/0002-notification-delivery-mechanism.md) and task 5b above.
- **macOS dropped from scope entirely** (owner decision, signing-cost-vs-usage tradeoff) — see
  [ADR-0003](../adr/0003-packaging-and-code-signing-approach.md).
- **"Quiet hours" and "mute" treated as one manual toggle, not a scheduled time window** — see
  requirements.md's FR-12 design-decision note.
- **Window-state library vs. hand-rolled** — recommended `electron-window-state`, with a documented
  hand-rolled fallback if that package turns out unmaintained at implementation time (see
  [overview.md](../architecture/overview.md)).
- **JavaScript over TypeScript** for this project's size — see "Toolchain choices" above.
- **Coverage-first unit-test net (task 0)** — scoped to genuinely pure/deterministic logic only; see
  task 0's own "explicitly NOT covered" list for what stays hand-verification-only and why.
