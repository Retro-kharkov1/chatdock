# Tray & Lifecycle (FR-06, FR-07, FR-08, FR-10, FR-11, FR-12, FR-14, FR-15)

<overview>
Grounded in `~/.claude/skills/electron-desktop.md` §7 (tray, close-to-tray, single-instance,
auto-launch mechanics — not restated here) plus the space's `quit-only-from-tray` rule, which is a
hard constraint: the window's close button must never terminate the process, under any refactor.

Three windows now exist: the **main Chat window** (close-to-tray, FR-06), the **Settings window**
(destroyed on close, FR-15) and, when a Meet link is opened, the **call window** (destroyed on close,
FR-16; see [meet-call-window.md](meet-call-window.md)). Close-to-tray, tray Show/Hide and the
attention indicators of FR-14 all concern the **main window only**. Closing either of the other two
never quits the app and never hides or closes the main window.
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

This hide-on-close handler is on the **main window only** (FR-06). The Settings window has none (it is
destroyed on close). The call window has a **different** `close` handler (yield to `isQuitting`; block
while the source picker is open; on a live call ask, if approved; otherwise destroy; see
[meet-call-window.md](meet-call-window.md) §3 and §3b), which never hides. Closing either must still never
quit the process, which `window-all-closed` (below) guarantees while the main window exists hidden. Do not
copy the hide handler onto them: a hidden call window would keep the camera and microphone live (FR-16).

`isQuitting` is set `true` in the app's **`before-quit` handler** (`src/main/index.js:418-421`, as of
commit d7f69e1), not in the Exit handler: the Exit handler only calls `app.quit()`, and `before-quit` is
what an OS shutdown also reaches, so shutdown lets the `close` handler through instead of being turned into
a hide. **`before-quit` must therefore never be prevented and never show a dialog.** Because `app.quit()` closes
every window first, a page whose `beforeunload` objection is not overridden would cancel the quit and leave
`isQuitting` stuck at true (so the main window's X would destroy it); the rules that prevent this (override
while quitting, reset if a quit is cancelled) are in [meet-call-window.md](meet-call-window.md) §3b and
apply to the main window's contents too. Any confirm in front of
Exit or a window close is added *before* `app.quit()` or inside a `close` interception that yields to
`isQuitting` (see [meet-call-window.md](meet-call-window.md) §3b). `window-all-closed` does **not** call
`app.quit()` (Electron's Linux/Windows default
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
explicit wiring. The Meet call window is not covered by this fix and, with no menu, its edit shortcuts are
Meet's own page behaviour [U: verify in Spike B].

## Tray icon and context menu (FR-07, FR-10, FR-11, FR-12)

Created after `app.whenReady()` (per `electron-desktop.md` §7 — a `Tray` created earlier throws).
Context menu, in order:

| Entry | Type | Action | Why it earns its place |
|---|---|---|---|
| Show call window — **conditional, PENDING OWNER APPROVAL (design OQ-10, amendment A4)** | action, first entry | present only while a call window exists, **in every one of its states** (opening, error, crashed, sign-in, Meet page); restores, raises and focuses the **call window**, and **when the source picker is open focus goes to the picker**; never touches the main window. **No tooltip change** (dropped from the design). The menu is rebuilt (`refreshMenu`, event-driven, not from the blink tick) when the call window is created and destroyed. See [meet-call-window.md](meet-call-window.md) §3b. | Buried call windows are otherwise reachable only by the OS window switcher. Additive to FR-07's "at minimum" list; not yet recorded in requirements. |
| Show/Hide Google Chat | action | toggles the **main window only** (`toggleShowHide`, `src/main/index.js:172-179`): `hide()` vs restore/`show()`/`focus()`. While a call window is open it never hides, closes or focuses the call (owner-approved default; see [meet-call-window.md](meet-call-window.md)). | FR-07's explicit requirement: close-to-tray removes the taskbar path back in on some platforms/configs, so the tray needs its own way in. |
| Mute notifications | checkbox | see "Notification sound, mute, and icon blinking" below | Owner-requested (FR-12). The **only** preference checkbox still on the tray — Start at login and Notification sound moved to the Settings window (FR-15); see that section. |
| Settings… | action | opens/focuses the Settings `BrowserWindow` — see "Settings window (FR-15)" below | New entry point for Start at login, Notification sound, and Icon blinking (the setting label is under redesign, see [design docs](../design/00-settings-surface-spec.md)), added so the tray menu stops growing with every new preference (FR-15). |
| Exit | action | `app.quit()` (`isQuitting` is set by `before-quit`, see above). **Proposed, PENDING OWNER APPROVAL (design OQ-2):** if a call window exists, Exit first **probes it as a close attempt**; only if Meet's page objects (a live call) does an asynchronous native confirm "Exit Google Chat Desktop?" appear, and `app.quit()` then runs only on "Exit"; a non-objecting call window is destroyed and Exit proceeds with no dialog; see [meet-call-window.md](meet-call-window.md) §3b. | The **only** path that terminates the process — no in-page Exit control exists (space's `quit-only-from-tray` rule, FR-07). |
| *(separator)* — build/version label | disabled, non-clickable | none | Owner-requested mid-incident (2026-09-22), see "Build/version diagnostic line" below (FR-13). |

**Amended per FR-15/Wireframe F** (supersedes the 7-item menu this table originally described):
"Start at login" and "Notification sound" checkboxes are removed from this menu — they are now
Settings-window-only controls (see "Settings window (FR-15)" below). This shrinks the menu from 7
entries to 5 (6 while a call window exists, if "Show call window" is approved).

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

The label is built by `buildVersionLabel(buildInfo)` in `src/main/version.js` from `build-info.json`
(GitVersion-derived, generated by `npm run generate-build-info`); as of commit d7f69e1 it renders
`<version> (<shortSha>, <ci|local>)`, or `build info unavailable`. **This differs from FR-13's wording**
(version, "packaged" or "source", and a build timestamp taken from the entry file's mtime), which is
authoritative for the requirement: the code has moved to a build-info source and the requirement text has
not been updated. Recorded as a discrepancy for the business-analyst rather than resolved here; the tray
line's content is FR-13's, and this document does not define a third format.

**The Settings window's About line is a different, narrower thing (FR-15, ratified): the app name and the
version number only**, with no build timestamp, no packaged/source word and no SHA. It must not reuse the
tray string. See FR-13 in [requirements.md](../business/requirements.md) for the acceptance criteria.

### Start at login (FR-10)
**Managed exclusively from the Settings window (FR-15) — no tray checkbox.** Mechanism unchanged
from the original design, only the surface that calls it moves; see "Settings window (FR-15)"
below for how the Settings window's switch reaches this code.

**NFR-08 (Linux):** the autostart `Exec` path must be the space-free installed executable. Today
`src/main/autostart.js:64-66` writes `"${process.execPath}" --hidden` (quoted). For the `.deb` that is
`/opt/GoogleChatDesktop/google-chat-desktop` (space-free, see
[build-linux-in-docker.md](../development/build-linux-in-docker.md) "Install path and names"). **Open
item, unverified:** inside an **AppImage** `process.execPath` points into the temporary mount, which
does not exist after the app exits, so an autostart entry written from an AppImage run would not launch at
next login; the AppImage path (`APPIMAGE` environment variable) is the usual stable reference. The
implementer must check this on a real AppImage run and either fix or state the limitation; NFR-08's
scenario "the autostart entry points at the space-free executable" should be tested for both artifacts.

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

**Icon blinking (`blinkOnUnread`) is Settings-window-only (FR-14/FR-15)** and, by the owner-approved
default, is **one setting for both the tray blink and the taskbar flash**; the persisted key keeps its
name, only the user-facing label changes (design task). See "Attention indicators (FR-14)" below for the
timer/flash wiring; this section only owns the persisted flag.

`soundEnabled`/`notificationsMuted` must reach **whichever code creates the toast**. Today that is the
injected `Notification` wrapper (`src/main/notifications.js:90-117`); if the delivery mechanism changes
(M2/M3 in [notifications.md](notifications.md)) the creating code is in the main process and reads
`settingsStore` directly, with no page globals. [notifications.md](notifications.md) owns which; this
section only owns where the flags come from and how they're persisted. While the page wrapper is in use,
main pushes current values into the page on toggle and at initial injection
(`dom-ready`/`did-finish-load`) via
``webContents.executeJavaScript(`window.__gcdSoundEnabled = ...; window.__gcdMuted = ...;`)``, evaluated
**before** the wrapper snippet.

Muting does **not** affect the unread indicator — that stays driven by `page-title-updated`
independent of these flags, per FR-12. Muting **does** stop any active tray blink immediately (FR-14's
"poking" rule, decided by the owner for the blink). That muting also stops the **taskbar flash** is a
**working assumption** in FR-14, not an owner decision; the design implements it and it is one line to
change if the owner disagrees. The one notification that ignores mute is the app-status "A call is already
open" notification of FR-16, which is not a chat message.

**Delta from the requirement (tray glyph):** `resolveIconState` (`src/main/tray.js:41-45`) prefers
`'muted'` over `'unread'`, so on Linux the unread state is invisible while muted, contradicting FR-05a and
FR-12. Tracked as an open question in [notifications.md](notifications.md) §5; do not treat the current
precedence as correct.

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
  `value === false`: call `attention.stop()` immediately (stops the tray blink **and** clears the taskbar
  flash; see "Attention indicators (FR-14)" below) — FR-14 stop trigger 3; a mid-blink mute or
  blink-disable must not wait for the next tick to take effect.
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

## Attention indicators (FR-14): tray blink and taskbar flash

FR-14 (`requirements.md`) is the single authority for when the indicators start and stop; this section is
only the wiring. It replaces the earlier "hidden / becomes visible" design. Owner-approved defaults
applied here: **one** setting (`blinkOnUnread`) governs both the blink and the flash, and new-message
indicators continue while the user is in the Meet call window or the Settings window (they are not the
main Chat window, so the main window is still "not focused").

### What the code does today, and where it differs from FR-14 (input as of commit d7f69e1, 2026-09-30; not a durable description: `src/main/attention.js` and `src/main/appIdentity.js` are being added concurrently, so re-read the code before relying on a row)

| FR-14 says | Code today | Delta |
|---|---|---|
| Start while the window is **not focused** (hidden, minimized, or visible without focus) | Gate is `isWindowVisible: () => mainWindow.isVisible()` (`src/main/index.js:194-200`, `src/main/tray.js:171`): starts only when `!isVisible()` | A window that is visible but behind another app never starts the blink. Whether `isVisible()` is false for a **minimized** window is not established here [U] (the code's own `toggleShowHide`, `index.js:172-179`, treats minimized separately, which suggests it is not); verify, but the gate must be focus-based either way. |
| Stop when the window **gains focus** | Stop is wired to `'show'` and `'restore'` (`index.js:297-298`) | `show()` without focus (for example `showInactive()`) or a restore that the OS does not focus stops the indicators though FR-14 says it must not. |
| Taskbar button flashes (Windows) | `flashFrame` is never called | Unimplemented (ADR-0004 S2). |
| (Re)start on every **arrival** while not focused | `updateBlink(n)` calls `startBlinking()` for **any** `n > 0` title update (`tray.js:171-172`) | A title update that lowers the count (5 to 3) or repeats it also restarts the blink; only an increase or an arrival event should. |
| Stop on unread = 0 | `n === 0` calls `stopBlinking()` (`tray.js:173-174`) | Correct; keep. |
| Stop on mute-on or blinking-off | `applySetting` (`settingsStore.js`) calls `stopBlinking()` | Correct for the blink; must also clear the flash. |

### Module shape

`src/main/trayBlink.js` keeps owning the **single** blink timer exactly as before (module-level
`timerHandle`, start is a no-op if set, stop clears and nulls together; NFR-06). A thin
`attention` layer (new, may live in `tray.js` or its own module) is the only caller of both effects so the
two can never disagree:

```js
// attention.start(): called on an arrival while the main window is not focused,
//   blinkOnUnread on, notificationsMuted off.
//   trayBlink.startBlinking();            // one timer, no-op if already running
//   mainWindow.flashFrame(true);          // one OS request, no app-side timer (NFR-06)
// attention.stop(): every stop trigger converges here.
//   trayBlink.stopBlinking();             // clearInterval + null, restores static icon
//   mainWindow.flashFrame(false);         // always explicit, see the flash note below
```

`attention.stop()` is safe to call unconditionally (both halves are no-ops when idle), so all three FR-14
stop triggers call the same function.

### Start and stop wiring

- **Start, arrival.** The arrival event is, in order of preference, (1) the moment the delivery mechanism
  raises a toast (M2/M3 in [notifications.md](notifications.md)); (2) the FR-14 degraded trigger, the
  `page-title-updated` count **increasing** versus the previous observed count. The implementation states
  which one it uses. The gate reads `!mainWindow.isFocused()` **once, at the arrival**, not polled
  (NFR-02). Replace `isWindowVisible` with an `isWindowFocused` dependency in `createUnreadBlinkGate` and
  add the previous-count comparison there so the pure gate stays unit-testable without Electron.
- **Stop 1, focus.** `mainWindow.on('focus', attention.stop)`. Remove the `'show'` and `'restore'`
  listeners. `focusMainWindow()` (restore, show, `focus()`) still stops them because the `focus` event then
  fires; `showInactive()` in the hidden-autostart path does not, which is correct.
- **Stop 2, unread returns to zero.** The `n === 0` branch, unchanged in principle, now calls
  `attention.stop()`.
- **Stop 3, setting change.** `applySetting` (above) calls `attention.stop()`.
- **Mute while active:** covered by stop 3 (for the flash this is the working assumption above). **Mute turned off, or blinking turned back on, with unread
  pending:** nothing starts until the next arrival (FR-14 working assumption).
- **Focus in another of our windows** (Settings, call window) does not stop anything: only the **main**
  window's `focus` event does.

### The flash: what is and is not established

- Electron documents `win.flashFrame(flag)` as "Starts or stops flashing the window to attract user's
  attention" (browser-window API). The excerpt fetched for this document does **not** say when the flash
  ends on Windows, so this design **always calls `flashFrame(false)` on stop** instead of relying on the OS
  to end it at focus.
- **Risk, unverified:** `win.hide()` removes the window's taskbar button on Windows, so `flashFrame(true)`
  on a window that is **hidden to tray** may have no visible effect. FR-14's manual scenario "the taskbar
  button visibly flashes" is written for hidden, minimized and behind-other-windows. If a real Windows
  desktop shows no flash for the hidden case, the requirement cannot be met for that state by
  `flashFrame` alone; the options (for example keeping a minimized taskbar button instead of hiding, which
  changes FR-06's close-to-tray behaviour) are an **owner decision** and this document does not choose.
- Linux: `flashFrame` maps to a window-manager urgency hint whose visible effect is desktop-dependent;
  best-effort per FR-14, verified on a real Linux desktop and not assumed.
- WCAG 2.3.1's flash threshold cited in the design docs applies to the ~1 Hz tray alternation the app
  controls. The OS taskbar flash rate is not app-controlled, so no rate claim is made for it.

### NFR-06 as a checkable property

The two-part QA method is unchanged in shape, restated in focus terms: (1) a unit test with spied
`setInterval`/`clearInterval` and a stubbed `flashFrame` over the 20-cycle sequence in NFR-06 (first arrival
while not focused; gain focus (stop); lose focus; arrival (restart); arrival while already blinking (zero
extra `setInterval`); show without focus (must **not** stop); mute on/off; blinking on/off; count to zero
while not focused), asserting on every cycle that `flashFrame(true)` is requested on each start and
`flashFrame(false)` on each stop; (2) the same sequence by hand on a real build, moving the window between
hidden, minimized, visible-behind-another-window and focused. `_resetForTests` and `isBlinking()` remain
the test seams. New test seams needed: an injectable `isFocused` and `flashFrame` on the gate.

### Superseded, removed from this document

The former "visible-but-unfocused case" section (which argued the OS toast is enough and that a tray
signal would be redundant) is obsolete: FR-14 now requires the tray blink and taskbar flash in exactly that
state, so the "residual gap" it flagged is closed by the requirement, not by a design choice here.

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
