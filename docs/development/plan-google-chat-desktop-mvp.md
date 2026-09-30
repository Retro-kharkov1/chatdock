# Plan: Google Chat Desktop MVP

> **Partly superseded, 2026-09-30.** This plan covers FR-01..FR-15 and predates FR-05a/b/c, the
> focus-based FR-14 with taskbar flash, FR-16, NFR-07 and NFR-08. Its notification tasks (5, 5b, 6) and the
> blink/`show`-`restore` wiring describe designs that
> [notifications.md](../architecture/notifications.md) and [tray-lifecycle.md](../architecture/tray-lifecycle.md)
> now replace or reopen. Do not implement from those tasks. A follow-up plan for the new work is to be
> written after Spikes A, B and C; once the MVP is fully shipped, fold this file's durable content into the
> architecture docs and delete it (`tech-writing`).

<overview>
The implementation plan for the first shippable version of `google-chat-desktop`, covering all of
FR-01…FR-15 and NFR-01…NFR-06. Read [Architecture](../architecture/README.md) and
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
│   │   ├── trayBlink.js           — FR-14 single-timer blink module (tray-lifecycle.md)
│   │   ├── autostart.js           — FR-10 (Windows: setLoginItemSettings; Linux: XDG .desktop file)
│   │   ├── settingsStore.js       — FR-10/FR-11/FR-12/FR-14 single-writer settings authority
│   │   │                             (tray-lifecycle.md "Settings window (FR-15)")
│   │   └── settingsWindow.js      — FR-15 Settings BrowserWindow (tray-lifecycle.md)
│   ├── preload/
│   │   ├── preload.js             — IPC contract (ipc-contract.md), main window only
│   │   └── settingsPreload.js     — FR-15's separate preload for the Settings window
│   │                                 (tray-lifecycle.md "Process model" — security boundary, not
│   │                                 shared with preload.js)
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
needs the click-to-focus bridge already wired), **4b depends on 4** (the Mute checkbox needs
the base tray menu), and **4c depends on 4** (the version line is a tray-menu entry). **4c is a
later, owner-requested addition, already implemented and unit-tested — see its own entry below for
what "done" means for it.** Task 5's done-criterion was re-scoped after a real incident surfaced a
defect in its original mitigation (see task 5's own entry) — the fix is implemented, but the
confirming real-desktop check (a real inbound message producing a real notification, post-fix) has
not yet been run and is still this task's open item, same as **5b**, which has not been run at all.

**FR-15 and FR-14 (owner-added after the original FR-01…FR-12 scope, see
[requirements.md](../business/requirements.md)) are new tasks 4d and 4e, not folded into 4b.**
4b now covers only FR-12's tray-side Mute checkbox plus the `settingsStore` foundation all of
FR-10/FR-11/FR-12/FR-14 share — it does **not** cover FR-10 (start-at-login) or FR-11 (notification
sound) hand-verification, because as of FR-15 those two have no tray UI left to trigger them with;
that verification moved to 4d, where their only remaining UI (the Settings window) is actually built.
**4d (Settings window, FR-15) depends on 4b** (needs `settingsStore` and its `applySetting`
single-writer entry point) and on **6** (needs a real unread count to show a meaningful
About-line/Mute-sync scenario, and the design spec's live two-way sync is exercised against the same
tray Mute checkbox 4b builds). **4e (Blink, FR-14) depends on 4d** (blink is Settings-only per
FR-14/FR-15 — `blinkOnUnread` has no toggle to test against until the Settings window exists) and on
**6** (blink hooks into `setTrayUnread`, task 6's own deliverable).
8 depends on 2–7 (now also 4d/4e) being functionally complete; 9 is packaging; 10 is last.

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

### 4b. Mute tray checkbox + settingsStore foundation (FR-12, plus the shared persistence layer FR-10/FR-11/FR-14 build on)
**Satisfies**: FR-12 in full; lays the persistence foundation FR-10/FR-11 (task 4d) and FR-14 (task
4e) depend on, without implementing their own UI here.
**Depends on**: task 4 (base tray menu exists) and task 0's `shouldMuteOrSilence` net being green.
**Amended per FR-15/Wireframe F**: this task's original scope (Start at login and Notification sound
also on the tray menu) is superseded — see [tray-lifecycle.md](../architecture/tray-lifecycle.md)'s
"Amended per FR-15/Wireframe F" note and [requirements.md](../business/requirements.md) FR-07/FR-15.
Those two checkboxes are removed from the tray menu entirely; **Mute notifications is the only
preference checkbox that stays**. Do not add Start-at-login/Notification-sound checkboxes to the
tray menu under this task — that would build the exact stale layout the owner overruled.
**Done when**:
- `src/main/settingsStore.js` exists with the single `applySetting(key, value)` mutation entry
  point described in [tray-lifecycle.md](../architecture/tray-lifecycle.md)'s "Single source of
  truth" section, persisting all four booleans (`startAtLogin`, `soundEnabled`,
  `notificationsMuted`, `blinkOnUnread`) to `settings.json` under `userData` — even though only
  `notificationsMuted` has a caller yet at this point in the sequence, all four keys/defaults exist
  now so 4d/4e call into an already-stable module rather than extending its shape later.
- "Mute notifications" is the **only** new checkbox added to the tray menu, calling
  `settingsStore.applySetting('notificationsMuted', ...)` directly (in-process, no IPC — it's already
  main-process code, per tray-lifecycle.md).
- FR-12's gherkin scenarios pass by hand: mute on → no OS notification but tray unread count still
  updates; the checkbox state persists across a full quit-and-relaunch.
- FR-10 (start-at-login mechanism functions in `autostart.js`, both Windows `setLoginItemSettings`
  and Linux XDG `.desktop` file, read-back-verified per the design spec) and FR-11 (sound-suppression
  branch in the notification wrapper) may be implemented here as plain functions, but their
  hand-verification is **not** part of this task's done-criteria — there is no tray UI left to
  trigger them with; that happens in task 4d where their actual UI exists.

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

### 4d. Settings window (FR-15) — new task, not in the plan's original scope
**Satisfies**: FR-15 in full; also carries FR-10 and FR-11's hand-verification (their only UI, per
4b's amended scope above).
**Origin**: owner request, made after the original FR-01…FR-12 scope — "so that all this can be
managed... instead of an ever-growing tray menu" (`requirements.md` FR-15). Full surface/layout
lives in `docs/design/00-settings-surface-spec.md` (owned by `ux-ui-designer`); this task implements
the wiring `docs/architecture/tray-lifecycle.md`'s "Settings window (FR-15)" section defines.
**Depends on**: task 4b (`settingsStore.applySetting` and all four persisted keys must already
exist) and task 6 (Tray unread indicator — exercises the tray Mute checkbox this task's two-way sync
targets against a live tray state, and the About line needs `app.getVersion()`/task 4c's version
plumbing already in place).
**Done when**:
- `src/main/settingsWindow.js` opens a second `BrowserWindow` from the tray's "Settings…" entry
  only — **no native application-menu entry point exists** (see
  [tray-lifecycle.md](../architecture/tray-lifecycle.md)'s "Application menu suppression" and
  `requirements.md`'s "No native OS application menu — decided"); a second click while one is
  already open focuses the existing window rather than opening a duplicate.
- It loads a local bundled HTML document only, with its own `src/preload/settingsPreload.js`,
  separate from the main window's `preload.js` (the security-boundary requirement in
  tray-lifecycle.md's "Process model" — verify by inspection that no code path shares one preload
  between the two windows).
- `settings:get`/`settings:set`/`settings:changed` are implemented per
  [ipc-contract.md](../architecture/ipc-contract.md) and the echo-loop-prevention wiring in
  tray-lifecycle.md (`event.sender.id` check) — verify by hand: toggling Mute from the **tray**
  while Settings is open updates the Settings window's Mute switch live (no page reload, no
  flicker/double-render from the echo guard); toggling Mute **from Settings** updates the tray
  checkbox live in the other direction.
- Start at login, Notification sound, and Blink tray icon on unread (the `blinkOnUnread` persisted
  flag only — the timer/blink behavior itself is task 4e) are each a switch in the Settings window,
  applying immediately with no Save/Cancel step (`requirements.md` "When changes take effect —
  decided"), reconciling (reverting the optimistic UI change) on an `{ ok: false }` result per the
  design spec §4.
- FR-10's three gherkin scenarios pass by hand on **both** Windows and Linux separately, triggered
  from the Settings window now (state plainly which platform(s) were actually checked, per the
  space's `verify-on-a-real-desktop` rule).
- FR-11's gherkin scenario passes by hand (sound off, toggled from Settings → next notification is
  silent).
- The read-only About line (version/build info, per the design spec) renders correctly for both a
  dev run and a packaged build.
- All four settings persist across a full quit-and-relaunch.

### 4e. Blink tray icon on unread (FR-14) — new task, not in the plan's original scope
**Satisfies**: FR-14 in full.
**Origin**: owner request, added alongside FR-15 — "draw my eye when messages arrive, like the old
days" (`requirements.md` FR-14). Implements
[tray-lifecycle.md](../architecture/tray-lifecycle.md)'s "Blink tray icon on unread (FR-14)"
section, which is itself the authoritative source for the start/resume and stop conditions below —
this task does not restate or re-derive them, only builds against them.
**Depends on**: task 4d (`blinkOnUnread` has no toggle to test against before the Settings window
exists) and task 6 (Tray unread indicator — blink hooks into the same `setTrayUnread(n)` task 6
builds, extending it rather than adding a second handler).
**Done when**:
- `src/main/trayBlink.js` exists with exactly the module-level, single-timer-handle shape in
  tray-lifecycle.md (`startBlinking`/`stopBlinking`/`isBlinking`, no other exported mutable state).
- `setTrayUnread(n)` is extended per tray-lifecycle.md's "Stop triggers"/"Start/resume trigger"
  sections: `n > 0` while hidden and `blinkOnUnread`/not muted starts or resumes blinking; `n === 0`
  stops it (FR-14's second stop trigger — unread cleared elsewhere while still hidden); the window's
  `'show'`/`'restore'` events also stop it (FR-14's first stop trigger).
- The `qa-automation`-owned fake-timer unit test described in tray-lifecycle.md's "NFR-06 as a
  checkable property" section is green **before** this task is marked done (coverage-first, same
  discipline as task 0, even though this test lives alongside this task rather than in task 0 itself
  because `trayBlink.js`'s behavior isn't meaningfully testable until the module exists) — asserting
  no duplicate `setInterval` on repeated starts, no duplicate `clearInterval` on repeated stops, and
  the `setTrayUnread(0)`-while-hidden stop path specifically.
- Hand-verified by real inbound messages (reuses task 5's real-message channel, no separate
  incident needed): first unread message while hidden starts blinking; a second message while
  already blinking does not restart the visible cycle or create a second timer; opening the window
  stops blinking regardless of remaining unread elsewhere; with the window still hidden, the unread
  count returning to 0 (simulate by reading the conversation from another device/account, or by
  whatever mechanism actually drives Google Chat's unread state to 0 remotely) stops blinking without
  the window ever becoming visible; toggling Mute on mid-blink (from either tray or Settings) stops
  blinking immediately but leaves the static unread badge showing; toggling "Blink tray icon on
  unread" off in Settings mid-blink stops it immediately too. State plainly which platform(s) this
  ran on, per the space's `verify-on-a-real-desktop` rule — NFR-06's "20 rapid open/hide cycles while
  unread stays above 0" manual pass (tray-lifecycle.md) is part of this task's own hand-verification,
  not deferred to task 8.

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
**Satisfies**: NFR-01, NFR-02, NFR-03. (NFR-06 — the blink timer's single-handle discipline — is
verified in task 4e itself, not here, since it needs `trayBlink.js` to already exist; this task's
grep sweep below should find and pass over that one interval, not flag it.)
**Done when**: idle CPU with the window hidden and no new messages is negligible (no busy-polling
anywhere in the codebase — grep for `setInterval`/`setTimeout` polling loops and justify any that
remain; the one expected survivor is `src/main/trayBlink.js`'s single `setInterval`, which is not a
polling loop but the FR-14 blink mechanism itself, already covered by task 4e's own NFR-06 net —
any *other* `setInterval`/`setTimeout` found here is a real finding, not this one); memory footprint
is in line with one Chromium tab of Google Chat; time from launch to signed-in view is comparable to
opening an already-authenticated site in a new browser tab, on each of Windows/Linux the implementer
has access to (state plainly which platforms were actually checked, per the space's
`verify-on-a-real-desktop` rule).

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
on at least one real machine per in-scope platform, and every FR-01…FR-15 gherkin scenario in
requirements.md is driven by hand against that packaged build — login survives a full
quit-and-relaunch, a notification appears with the window hidden and clicking it lands on the
specific conversation (not just any window focus), the tray menu quits, single-instance works,
start-at-login/sound/mute all behave as specified, the tray icon blinks on arrival and stops both on
window-show and on unread-returning-to-zero-while-hidden (FR-14), the Settings window opens only
from the tray (never from a native application menu — confirm none exists) and its Mute switch
stays in live two-way sync with the tray checkbox (FR-15). Also confirm, on the packaged build, that
standard copy/paste keyboard shortcuts (Ctrl+C/Ctrl+V at minimum) still work inside the Google Chat
page despite the suppressed application menu (see
[tray-lifecycle.md](../architecture/tray-lifecycle.md)'s "Application menu suppression" `before-input-event`
wiring) — this is exactly the kind of regression that looks fine in a dev run and only shows up in a
packaged build. State plainly which platform(s) this actually ran on; do not claim cross-platform
coverage from a single-platform check (space's `verify-on-a-real-desktop` rule).

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
