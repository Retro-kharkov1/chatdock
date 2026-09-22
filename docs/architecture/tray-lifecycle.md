# Tray & Lifecycle (FR-06, FR-07, FR-08, FR-10, FR-11, FR-12, FR-14, FR-15)

<overview>
Grounded in `~/.claude/skills/electron-desktop.md` §7 (tray, close-to-tray, single-instance,
auto-launch mechanics — not restated here) plus the space's `quit-only-from-tray` rule, which is a
hard constraint: the window's close button must never terminate the process, under any refactor.
</overview>

<architecture>
## Close-to-tray (FR-06)

An internal `isQuitting` flag (module-level in `src/main/index.js`, `false` initially) is checked
in the window's `close` handler:

```js
mainWindow.on('close', (event) => {
  if (!isQuitting) {
    event.preventDefault();
    mainWindow.hide();
  }
});
```

`isQuitting` is set `true` **only** by the tray menu's Exit handler, immediately before calling
`app.quit()`. `window-all-closed` does **not** call `app.quit()` (Electron's Linux/Windows default
would otherwise quit the app when the last window closes — this must be overridden). The renderer
process is never destroyed by hide — this is the same live-window requirement notifications depend
on (space's `hidden-window-must-stay-live` rule; see [Notifications](notifications.md)).

**This exact `win.hide()` call is the mechanism `electron/electron#31016` names** (a historical
Windows-only freeze bug where `backgroundThrottling: false` did not reliably keep a hidden window's
JS running). That bug is not this app's live risk — it was not observed on this project's pinned
Electron version, and the flag it required is not set here anyway (see
[ADR-0002](../adr/0002-notification-delivery-mechanism.md) Revision 3). What close-to-tray's
`win.hide()` **does** need to get right is a genuine `document.visibilityState` transition to
`"hidden"` — Google Chat's own page uses that value, not window-focus, to decide whether to raise a
notification (see [Notifications](notifications.md)'s "Page Visibility dependency"). `win.hide()`
already produces a correct, real `visible → hidden` transition on its own; no special handling is
needed here. The launch-time equivalent below does need special handling, because a window that is
never shown at all does not get a transition for free.

### Hidden-autostart must force a real visibility transition (FR-10 + FR-05 interaction)

A window created with `show: false` (this app's default, see
[overview.md](overview.md)) reports `document.visibilityState` as `"visible"` from construction
until a real `show()`/`hide()` transition happens, per Electron's own `BrowserWindow` docs ("Page
visibility" section). On the `--hidden` autostart launch path (`src/main/autostart.js`), the window
is never shown at all — so without correction, it would report `"visible"` for its entire life and
Google Chat would never raise a notification while the app was quietly running in the tray after a
login-time autostart. This is the same suppression bug [ADR-0002](../adr/0002-notification-delivery-mechanism.md)
documents from the `backgroundThrottling` direction, reached instead via the launch path — caught
by applying that ADR's reasoning in the other direction before it shipped as a field bug, not by
a real incident.

Fix, in `src/main/index.js`'s `ready-to-show` handler: when `launchedHidden` is true, call
`mainWindow.showInactive()` immediately followed by `mainWindow.hide()` — a real,
no-focus-stolen, no-visible-flicker `visible → hidden` transition, so Chromium reports the correct
`"hidden"` state from the first load, matching what the close-to-tray path already gets for free.

## Application menu suppression is part of `quit-only-from-tray`, not a separate concern

**This is the single highest-consequence line in this document.** The `isQuitting`/`close` handler
above only guards the path through `mainWindow`'s own close handler. **Electron installs a default
application menu unless the app actively suppresses it, and that default menu carries its own
Quit/Exit item wired straight to `app.quit()` — a route that never touches `isQuitting` and never
touches the `close` handler at all.** Left at Electron's default, the quit-only-from-tray guarantee
above is false the moment the app launches, regardless of how correct the tray/close wiring is,
because a second, unguarded quit path already exists by default before this app adds a single line
of its own menu code. This is why [requirements.md](../business/requirements.md) ("No native OS
application menu — decided") rejected `ux-ui-designer`'s proposed native `Settings…` menu entry
outright rather than accepting a hand-built menu template that simply omits a Quit item: a template
without Quit is still a menu, still one edit away from regaining one, and still adds a discoverable
path this app does not want. The only guarantee strong enough to satisfy `quit-only-from-tray` is
the surface not existing at all.

**Requirement, stated as code, called at the very top of `src/main/index.js`'s startup sequence**
(same startup phase as the single-instance lock below — before `app.whenReady()`, definitely before
any window is created):

```js
const { Menu } = require('electron');
Menu.setApplicationMenu(null);
```

`setApplicationMenu(null)` suppresses Electron's default menu entirely (`electronjs.org/docs/latest/api/menu`
— "Passing `null` will suppress the default menu. On Windows and Linux, this has the additional
effect of removing the menu bar from the window."). No menu is built and left empty; no menu is
built and stripped of Quit — the surface is simply never installed. This holds on both Windows and
Linux (the two in-scope platforms per [ADR-0003](../adr/0003-packaging-and-code-signing-approach.md)).

**What this costs, and how it's paid for:** Electron's default application menu is also where the
standard Edit-role accelerators — Ctrl+C/Ctrl+X/Ctrl+V/Ctrl+A/Ctrl+Z/Ctrl+Shift+Z (copy/cut/paste/
select-all/undo/redo) — get wired to the focused `webContents`' clipboard/edit commands on Windows
and Linux. This is a known, documented Electron behavior, not an edge case: with no application menu
installed, these keyboard shortcuts stop reaching `webContents.copy()`/`paste()`/etc. (right-click
context-menu copy/paste on an editable field is unaffected — that is Chromium's own native context
menu and does not depend on Electron's application menu at all; only the *keyboard* accelerators do).
For a chat app, losing Ctrl+C/Ctrl+V in the compose box or in a copied message is a real, user-visible
regression the owner would hit immediately, not a theoretical one.

**Fix, without reintroducing any menu:** bind these five/six accelerators explicitly via
`before-input-event` on the main window's `webContents`, dispatching straight to the corresponding
edit command, instead of relying on a Menu (any Menu) to supply them:

```js
// src/main/index.js — after mainWindow is created, before it's shown
mainWindow.webContents.on('before-input-event', (event, input) => {
  if (input.type !== 'keyDown' || !(input.control || input.meta)) return;
  const key = input.key.toLowerCase();
  const wc = mainWindow.webContents;
  const actions = {
    c: () => wc.copy(),
    x: () => wc.cut(),
    v: () => wc.paste(),
    a: () => wc.selectAll(),
    z: () => (input.shift ? wc.redo() : wc.undo()),
  };
  if (actions[key]) { event.preventDefault(); actions[key](); }
});
```

This restores keyboard-shortcut parity with what the (now-absent) default menu would have provided,
entirely inside the main window's own input handling — it introduces no `Menu` instance, no visible
menu bar, and therefore no second quit-capable surface. The Settings window (see below) does not
need this: it has no free-text editing surface beyond simple form inputs, which Chromium's built-in,
menu-independent keydown handling for `<input>`/`<select>` elements already covers without any
explicit wiring.

## Tray icon and context menu (FR-07, FR-10, FR-11, FR-12)

Created after `app.whenReady()` (per `electron-desktop.md` §7 — a `Tray` created earlier throws).
Context menu, in order:

| Entry | Type | Action | Why it earns its place |
|---|---|---|---|
| Show/Hide Google Chat | action | toggles `mainWindow.isVisible()` — `hide()` vs `show(); focus()` | FR-07's explicit requirement: close-to-tray removes the taskbar path back in on some platforms/configs, so the tray needs its own way in. |
| Mute notifications | checkbox | see "Notification sound, mute, and icon blinking" below | Owner-requested (FR-12). The **only** preference checkbox still on the tray — Start at login and Notification sound moved to the Settings window (FR-15); see that section. |
| Settings… | action | opens/focuses the Settings `BrowserWindow` — see "Settings window (FR-15)" below | New entry point for Start at login, Notification sound, and Blink tray icon on unread, added so the tray menu stops growing with every new preference (FR-15). |
| Exit | action | `isQuitting = true; app.quit();` | The **only** path that terminates the process — no in-page Exit control exists (space's `quit-only-from-tray` rule, FR-07). |
| *(separator)* — build/version label | disabled, non-clickable | none | Owner-requested mid-incident (2026-09-22), see "Build/version diagnostic line" below (FR-13). |

**Amended per FR-15/Wireframe F** (supersedes the 7-item menu this table originally described):
"Start at login" and "Notification sound" checkboxes are removed from this menu — they are now
Settings-window-only controls (see "Settings window (FR-15)" below). This shrinks the menu from 7
entries to 5.

Left-click/double-click on the tray icon mirrors the Show/Hide entry (Windows/Linux convention —
macOS's different menu-bar convention is moot, out of scope per ADR-0003).

### Build/version diagnostic line (FR-13)

A disabled (non-clickable), visually de-emphasized menu entry, placed last and after a separator so
it never competes with the actual controls above it. Requested by the owner mid-investigation of
the notification bug this ADR-0002 revision records: a colleague testing an installed build and the
owner testing a dev run from source were, for a time, unknowingly looking at different code, and
resolving that ambiguity by hand (process-start-time/source-mtime archaeology) cost a full
diagnostic round. A bare `app.getVersion()` does not answer "is this the current build?" — every dev
run and every packaged build shares the same `package.json` version between releases.

`src/main/version.js`'s `buildVersionLabel(version, isPackaged, mtimeMs)` combines three
independently-read, never-hardcoded facts:
- `app.getVersion()` — tracks `package.json` automatically.
- `app.isPackaged` — distinguishes an installed build from a dev run from source.
- the entry file's mtime (`fs.statSync(__filename).mtimeMs`), formatted `YYYY-MM-DD HH:mm` — a
  per-build marker that changes on every `electron-builder` packaging run or source edit, with no
  git-hash or build-time string injection this repo doesn't already have wired up.

Example rendered label: `0.1.0 (packaged, built 2026-09-22 13:58)`. See FR-13 in
[requirements.md](../business/requirements.md) for the acceptance criteria.

### Start at login (FR-10)
**Managed exclusively from the Settings window (FR-15) — no tray checkbox.** Mechanism unchanged
from the original design, only the surface that calls it moves; see "Settings window (FR-15)"
below for how the Settings window's switch reaches this code.

Windows: `app.setLoginItemSettings({ openAtLogin: checked })` (Electron native API, confirmed
Windows/macOS-only per `electronjs.org/docs/latest/api/app` — no Linux support). Read current state
via `app.getLoginItemSettings().openAtLogin`, and — per the design spec's read-back-verification
decision (`00-settings-surface-spec.md` §6) — re-read it immediately after every `setLoginItemSettings`
call to confirm the change actually took, never trusting a non-throwing call alone.

Linux: no Electron API exists. Implement via a hand-written XDG autostart entry: on enable, write
`~/.config/autostart/google-chat-desktop.desktop` (standard `Exec=`/`Name=`/`Type=Application`
fields pointing at the packaged binary — see the XDG Desktop Entry / Autostart specifications); on
disable, delete that file. Read current state by checking whether the file exists, and — same
read-back-verification rule — re-check the file's existence/target immediately after every write.
This is a real Windows/Linux implementation difference (NFR-01), not an oversight.

Both platforms report success/failure back through the `settings:set` IPC response (see "Settings
window (FR-15)" below) rather than through a value silently written and hoped-for.

### Notification sound, mute, and icon blinking (FR-11, FR-12, FR-14)
Three independent booleans — `soundEnabled` (default `true`), `notificationsMuted` (default
`false`), and `blinkOnUnread` (default `true`) — persisted alongside window-state and
`startAtLogin`'s Linux marker in a small `settings.json` under `userData` (see
[overview.md](overview.md)'s window-state persistence for the equivalent pattern), loaded at
startup and written on every change. All four settings (including Start at login) are owned by one
main-process module, `src/main/settingsStore.js`, which is the single read/write authority — see
"Settings window (FR-15)" below for why that matters (it is what makes the two-way Mute sync
possible without an echo loop).

**Notification sound is Settings-window-only (FR-11/FR-15)** — no tray checkbox, same rationale as
Start at login (not a "need this in the next two seconds" control).

**Mute notifications is the one setting exposed on *both* the tray menu and the Settings window**
(FR-12/FR-15) — see "Settings window (FR-15)" below for the exact two-way sync wiring.

**Blink tray icon on unread is Settings-window-only (FR-14/FR-15)** — see "Blink tray icon on
unread (FR-14)" below for the timer/state-machine wiring; this section only owns the persisted flag.

`soundEnabled`/`notificationsMuted` need to reach the injected `Notification` wrapper in
[notifications.md](notifications.md) piece 2, since that's where notifications are actually
created — that file owns the canonical wrapper snippet (including the mute/sound branches); this
section only owns where the flags come from and how they're persisted. On toggle, and at initial
injection (`dom-ready`/`did-finish-load`), the main process pushes current values into the page via
``webContents.executeJavaScript(`window.__gcdSoundEnabled = ${soundEnabled}; window.__gcdMuted =
${notificationsMuted};`)``, evaluated **before** the wrapper snippet so the globals exist when the
wrapper first reads them.

Muting does **not** affect the tray unread indicator (piece 3 of notifications.md) — that stays
driven by `page-title-updated` independent of these flags, per FR-12's explicit requirement that
mute silences notifications, not the unread count. Muting **does** stop any active blink
immediately (FR-14's "poking" rule) — see "Blink tray icon on unread (FR-14)" below.

## Settings window (FR-15)

Full surface/layout/interaction design lives in `docs/design/00-settings-surface-spec.md` (owned by
`ux-ui-designer`) — this section is only the wiring an implementer cannot find there: the window's
place in the process model, the IPC channels, who owns the authoritative state, and how a change
made on one surface reaches the other without an echo loop.

### Process model
A second `BrowserWindow` (`src/main/settingsWindow.js`), constructed on demand from the tray's
"Settings…" entry — the **only** entry point; there is no native application-menu item, per
"Application menu suppression" above and [requirements.md](../business/requirements.md)'s "No
native OS application menu — decided" — and **destroyed on close** (`win.on('closed', () => { settingsWindow = null; })`), not hidden — matching
the design spec §1's fresh-state-every-open decision. It loads a local, bundled, static HTML
document (never a remote/third-party origin) with its **own preload script**,
`src/preload/settingsPreload.js`, kept deliberately separate from the main window's
`src/preload/preload.js`. This separation is a security boundary, not a file-organization
preference: the main window's preload exposes its bridge to `chat.google.com`, a third-party page
this app does not control; exposing settings read/write APIs on that same bridge would hand a
remote page a way to call them. The Settings window's preload only ever runs against this app's own
local HTML, so `ipcMain`'s Settings channels skip the sender-origin check `ipc-contract.md`'s
`notification:clicked` channel requires — origin validation is moot when the only content that can
ever load in that window is content this app shipped itself.

Single-instance for this window (design spec §1 "Instancing"): the "Settings…" handler checks
`if (settingsWindow) { settingsWindow.focus(); return; }` before constructing a new one.

### Single source of truth
`src/main/settingsStore.js` owns all four persisted booleans (`startAtLogin`, `soundEnabled`,
`notificationsMuted`, `blinkOnUnread`) plus the OS-level read/write calls for `startAtLogin`. It
exposes exactly one mutation entry point:

```js
// src/main/settingsStore.js
async function applySetting(key, value) {
  // 1. For startAtLogin: call the OS API (Windows) / write-or-delete the XDG file (Linux),
  //    then read back and compare, per the design spec's read-back-verification rule.
  //    For the other three keys: just persist to settings.json (no OS call, cannot fail
  //    the same way).
  // 2. On success: write settings.json, update in-memory state, return { ok: true, value }.
  // 3. On failure (threw, or read-back disagrees — startAtLogin only): leave the persisted
  //    value unchanged, return { ok: false, message }.
}
```

`applySetting` is called from exactly two places — the tray menu's Mute checkbox click handler
(direct in-process function call, since the tray menu is already main-process code) and the
`settings:set` IPC handler below (from the Settings window) — and both call sites go through this
one function. This single-writer shape is what makes the sync guarantees below possible: there is
no second code path that could write `settings.json` or call the OS login-item API without also
running the side effects (tray checkbox update, broadcast) that keep every surface consistent.

Side effects `applySetting` performs after a successful write, before returning:
- If `key === 'notificationsMuted'`: set the tray's Mute `MenuItem.checked = value` directly (the
  tray menu is a plain Electron `Menu` this process already holds a reference to — no IPC needed to
  update a native menu item from the same process that built it).
- If `key === 'notificationsMuted'` and `value === true`, or `key === 'blinkOnUnread'` and
  `value === false`: call `trayBlink.stopBlinking()` immediately (see "Blink tray icon on unread"
  below) — a mid-blink mute or blink-disable must not wait for the next tick to take effect.
- Broadcast `settings:changed` (see IPC table) to the Settings window, **if one is currently open
  and it is not the window that originated this call** (see "Echo-loop prevention" below).

### IPC channels (added to `ipc-contract.md`)
Three channels, all between the Settings window and main — see `ipc-contract.md` for the full
contract table; summarized here for context:
- `settings:get` (invoke/handle) — Settings window's initial load (design spec §5 Loading state)
  asks for a snapshot of all four settings plus the version string for the About line.
- `settings:set` (invoke/handle) — a switch toggle in the Settings window; calls `applySetting`
  and returns its `{ ok, value | message }` result directly, which is what the design spec §4's
  "optimistic UI + reconciliation" reverts against on failure.
- `settings:changed` (main → renderer, `webContents.send`) — the tray→Settings direction of Mute
  sync (design spec §4 "Live two-way sync"): pushed whenever `applySetting` changes a value from a
  call that did **not** originate in the currently-open Settings window.

### Echo-loop prevention
Because `applySetting` is the only writer, "echo" can only happen if the Settings window that just
triggered a `settings:set` call also receives its own change back via `settings:changed` and
re-renders — harmless (the value is identical) but wasteful and a source of UI flicker. Prevented by
tracking the *sending* `WebContents` id on each `settings:set` invocation and excluding that same id
from the `settings:changed` broadcast for that call:

```js
ipcMain.handle('settings:set', async (event, { key, value }) => {
  const result = await settingsStore.applySetting(key, value);
  if (result.ok && settingsWindow && event.sender.id !== settingsWindow.webContents.id) {
    // Only relevant for key === 'notificationsMuted' today (the only externally-triggerable
    // key besides the caller's own change), but the guard is written generically so any future
    // setting gaining a second entry point (another tray checkbox, a second window) is safe
    // by construction rather than by remembering to add a check.
    settingsWindow.webContents.send('settings:changed', { key, value: result.value });
  }
  return result;
});
```
The tray menu's Mute click handler calls `applySetting` directly (not through this handler), so its
`event.sender` never matches the Settings window's id, and its change is always broadcast to an
open Settings window — which is exactly the FR-15 "toggled from the tray while Settings is open"
scenario this wiring exists for.

## Blink tray icon on unread (FR-14)

FR-14 (`requirements.md`) has already settled the two behavioral questions the adversarial review
raised — what stops blinking, and whether it can resume. This section is the wiring: where the
single timer lives, what event drives the stop, where the start/resume trigger is hooked in, and
the interaction with mute/blink-off. It does not re-derive FR-14's decisions; it implements them.

### Timer module — single handle, start/stop only, never paused
`src/main/trayBlink.js` owns the one blink timer, module-level, never exported as mutable state:

```js
// src/main/trayBlink.js
let timerHandle = null; // null = not blinking. The only state this module holds.

function startBlinking() {
  if (timerHandle !== null) return; // already blinking — FR-14's "no second timer" case;
                                     // also how "resume" stays safe (see below).
  timerHandle = setInterval(tick, 1000); // FR-14's ~1s alternation; NFR-06's one allowed timer.
}

function stopBlinking() {
  if (timerHandle === null) return;
  clearInterval(timerHandle);
  timerHandle = null;
  setStaticTrayState(); // restore the correct non-blinking icon (idle or unread-static per
                         // notifications.md piece 3's current unread count) — never left
                         // mid-blink-cycle when the timer stops.
}

function tick() {
  // Icon-image swap only (tray.setImage()-equivalent) — no menu rebuild, no settings read,
  // no other work, per NFR-06's per-tick cost bound.
}

function isBlinking() {
  return timerHandle !== null;
}

module.exports = { startBlinking, stopBlinking, isBlinking };
```

`startBlinking` being a no-op whenever a timer is already running is what makes FR-14's "resume"
behavior safe: a resume is just another call to `startBlinking()` from the same code path as the
original start (see "Start/resume trigger" below) — there is no separate "resume" function and
therefore no second way to accidentally create a second `setInterval`. `stopBlinking` always
`clearInterval`s and nulls the handle together, never one without the other, so "cleared, not
merely paused" (NFR-06) is a property of this module's only two entry points, not something callers
have to get right themselves.

### Stop triggers — window becomes visible, or unread returns to zero while still hidden
FR-14 names two independent stop triggers (`requirements.md` FR-14, "Stop condition"), and this
architecture wires both to the same `stopBlinking()` entry point rather than inventing a second stop
path:

**Trigger 1 — the window's `'show'` and `'restore'` events.** Blinking stops the instant the window
**becomes visible**, independent of OS focus, the conversation shown, or remaining unread elsewhere.
Electron's `BrowserWindow` emits `'show'` whenever the window transitions to visible — via `show()`
**or** `showInactive()` — and `'restore'` when it transitions out of the minimized state; both are
transition events, not polled state, so they fire exactly once per transition regardless of which
caller triggered it (the tray's Show/Hide entry, a notification click's `win.show()` in
notifications.md piece 2, `second-instance`'s `mainWindow.show()`, a taskbar restore). Wiring both
to the same stop call, once, in `src/main/index.js`, is what keeps this a single hook instead of a
call sprinkled into every place the window can become visible:

```js
mainWindow.on('show', trayBlink.stopBlinking);
mainWindow.on('restore', trayBlink.stopBlinking);
```

`stopBlinking()` is itself a no-op when not currently blinking (see above), so this firing on paths
that were never blinking in the first place — e.g. the hidden-autostart `showInactive()` → `hide()`
pair described earlier in this document, which fires `'show'` immediately followed by `'hide'` at
a moment nothing has ever started blinking yet — is harmless by construction, not something this
wiring needs to special-case.

**Trigger 2 — unread count returns to zero while the window is still hidden.** This is the case
FR-14 added for the read-elsewhere scenario (the owner reads the message on another device, unread
drops to 0 while the window here is still hidden): an icon that keeps blinking for a message that is
no longer unread misreports state. This trigger is **not** a timer — it is driven by the same
unread-count fact `notifications.md` piece 3's `setTrayUnread(n)` already tracks, one call site,
same function:

```js
// src/main/tray.js — setTrayUnread(n), extended (notifications.md piece 3's existing function)
function setTrayUnread(n) {
  // ...existing overlay/badge logic, unchanged...
  if (n > 0 && !mainWindow.isVisible() && settingsStore.get('blinkOnUnread') && !settingsStore.get('notificationsMuted')) {
    trayBlink.startBlinking();
  } else if (n === 0) {
    trayBlink.stopBlinking(); // FR-14 trigger 2 — unread cleared elsewhere while still hidden;
                               // no-op (see trayBlink.js) if blinking wasn't running.
  }
}
```

Both triggers converge on the exact same `stopBlinking()` — module-level `timerHandle`, `clearInterval`
+ null together, never one without the other (see "Timer module" above) — so there is still only one
function in the codebase that can ever stop a timer, and only one (`startBlinking`) that can ever
start one. A stop from trigger 2 while trigger 1 also fires moments later (window opened right after
the unread count synced to zero) is just two calls into the same no-op-safe function, not two
competing stop mechanisms.

### Start/resume trigger — the same `setTrayUnread(n)` call site as trigger 2 above
FR-14's start condition is "the first unread message" and its resume condition is "any subsequent
arrival while still hidden" — both are the same event from this module's point of view, because
`startBlinking()`'s own no-op-if-already-running guard is what tells the two apart; the caller does
not need to know which case it is. This is the same `setTrayUnread(n)` extension shown under "Stop
triggers" above — the `n > 0` branch starts/resumes, the `n === 0` branch (trigger 2) stops; both
live in one function, one call site, so start and one of the two stops can never drift out of sync
with each other. `mainWindow.isVisible()` is read once, synchronously, at the moment of the arrival
— not polled — so this is still event-driven per NFR-02, and gates on the same "hidden/minimized"
state FR-05's static badge already uses (see the visible-but-unfocused note below for why that gate
is correct here even though it means something different for the badge).

### Interaction with Settings/tray toggles
Both are handled in `settingsStore.applySetting` (see "Settings window (FR-15)" above), not here:
turning Mute on, or turning Blink off, while a blink is in progress calls `stopBlinking()`
immediately rather than waiting for the next `tick()` — FR-14's "mute suppresses blink, not the
underlying unread fact" rule and the Settings window's "immediate apply, no delay" rule (design spec
§4) both require the mid-blink case to stop on the same event loop turn as the toggle, not on the
next 1s tick.

### NFR-06 as a checkable property, not an aspiration
"No duplicate or orphaned interval handles" is not observable from outside the process as written —
nothing external can inspect Node's internal timer table. Made concrete instead as two things a test
actually can assert, both against `src/main/trayBlink.js`'s public surface above:

1. **Unit test with fake timers** (owned by `qa-automation`, built against this module): spy on
   global `setInterval`/`clearInterval` (e.g. `jest.spyOn(global, 'setInterval')` /
   `jest.useFakeTimers()`), then drive a sequence that exercises exactly the cases FR-14 names —
   `startBlinking()` called twice in a row (simulating two arrivals while already blinking) asserts
   `setInterval` was called **once**, not twice; `stopBlinking()` called twice in a row (simulating
   a stop event firing on an already-stopped state, e.g. two `'show'`/`'restore'` events in
   quick succession) asserts `clearInterval` was called **once**, not twice; a start → stop →
   start (arrival → window opened → new arrival) sequence asserts `isBlinking()` is `true`, `false`,
   `true` at each step and that `setInterval` was called exactly twice total (once per genuine
   start, none wasted on the no-op calls). `isBlinking()` is exported from the module specifically
   to give this test a way to assert intermediate state without reaching into module-private
   variables. Also covers `setTrayUnread`'s own two branches directly (not just `trayBlink.js` in
   isolation): `setTrayUnread(1)` while hidden calls `startBlinking()`; a subsequent
   `setTrayUnread(0)` while still hidden (FR-14 trigger 2) calls `stopBlinking()` even though the
   window never became visible; and `setTrayUnread(0)` called when nothing was blinking is a no-op
   (asserted via `isBlinking()` staying `false` and `clearInterval` not being called an extra time)
   — this is the case that proves trigger 1 and trigger 2 converge on the same safe `stopBlinking()`
   rather than needing to be told apart by the caller.
2. **Manual real-build pass**: open/hide the window 20 times in rapid succession while unread stays
   above 0 (the exact scenario NFR-06's prose already names) and confirm no visible timer-related
   CPU/behavior anomaly — this stays a code-review/manual-verification criterion (a human watching
   the tray icon and a process monitor), not a runtime-testable assertion, because "no anomaly" is
   not itself a machine-checkable predicate the way call counts in (1) are. Both methods are
   required — the unit test proves the module's internal discipline; the manual pass is the closest
   available approximation to actually observing OS-level timer/resource behavior end-to-end.

### The visible-but-unfocused case — what the tray shows, and what doesn't apply
Neither the static unread badge (notifications.md piece 3) nor blinking (this section) triggers
while the main window is visible-but-unfocused (on screen, behind another app) — both are gated on
`!mainWindow.isVisible()` / "hidden/minimized", and a visible-but-unfocused window is, by
definition, visible. This is a deliberate reuse of FR-05's existing gate, not an oversight this
document is introducing: **the mechanism that actually draws the user's eye in that state is the OS
notification toast itself**, which FR-05 already requires unconditionally in this exact scenario
(`requirements.md` FR-05, "New message while window is open but unfocused on another app" — a
notification is shown regardless of focus). The tray icon's job, both static and blinking, starts
only where the OS notification's job ends — once the window is no longer even visible for a toast
to have been shown against. A tray-icon change on top of an already-delivered OS toast would be a
second, redundant attention mechanism for the same event, not a gap.

What this does **not** cover, and is worth naming rather than leaving implicit: if the user misses
or dismisses that toast, there is currently no persistent visual reminder on the tray icon while the
window remains visible-but-unfocused with that message still unread — the static badge only starts
once the window is hidden/minimized, and by then the message may already be several actions in the
past for the user. This is a real, if narrow, residual gap between "an alert fired once" and "a
persistent unread indicator," and it exists today under the *current* FR-05/FR-14 wording, which
this document does not have standing to change. Flagged here for `business-analyst`/the owner to
confirm is acceptable (a toast is enough) or to decide the badge/blink gate should key off OS focus
rather than window visibility — a real, small design choice with its own tradeoff (an OS-focus gate
would also badge/blink while the user is actively alt-tabbed away mid-task on the *same* machine,
which the current visibility-only gate deliberately avoids). Not decided unilaterally here.

## Single-instance enforcement (FR-08)

At the very top of `src/main/index.js`, before any window is created:

```js
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
  });
  // ... proceed with app.whenReady() etc.
}
```
(`https://www.electronjs.org/docs/latest/api/app` — confirmed: a `false` return means another
instance already holds the lock, and this process must quit immediately; the primary instance
receives `second-instance` with the second launch's argv, which this app does not need to act on
beyond focusing the existing window.)
</architecture>
