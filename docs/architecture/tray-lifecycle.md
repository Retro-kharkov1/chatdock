# Tray & Lifecycle (FR-06, FR-07, FR-08, FR-10, FR-11, FR-12, FR-14, FR-15)

<overview>
Grounded in standard Electron desktop practice (tray, close-to-tray, single-instance,
auto-launch mechanics — not restated here) plus the *Quit only from the tray* project rule, which is a
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
while the source picker is open; a one-shot probe of Meet's unload objection, and only on a live call the
native confirm P1; otherwise destroy; see [meet-call-window.md](meet-call-window.md) §8), which never hides. Closing either must still never
quit the process, which `window-all-closed` (below) guarantees while the main window exists hidden. Do not
copy the hide handler onto them: a hidden call window would keep the camera and microphone live (FR-16).

`isQuitting` is set `true` in the app's **`before-quit` handler** (in `src/main/index.js`), not in the Exit handler: the Exit handler only calls `app.quit()`, and `before-quit` is
what an OS shutdown also reaches, so shutdown lets the `close` handler through instead of being turned into
a hide. **`before-quit` must therefore never be prevented and never show a dialog.** Because `app.quit()` closes
every window first, a page whose `beforeunload` objection is not overridden would cancel the quit and leave
`isQuitting` stuck at true (so the main window's X would destroy it); the rules that prevent this (override
while quitting, reset if a quit is cancelled) are in [meet-call-window.md](meet-call-window.md) §8 and
apply to the main window's contents too: a `will-prevent-unload` handler is **always registered** on the
main window's contents and, while `isQuitting` is true, calls `event.preventDefault()` synchronously
(Spike B showed that without it a `beforeunload` objection silently blocks `app.quit()`: `before-quit`
fires, `will-quit` never does). `before-quit` also starts a one-shot timer that `will-quit` clears; if it
ever fires the quit did not happen and `isQuitting` is reset to `false`. Any confirm in front of
Exit or a window close is added *before* `app.quit()` or inside a `close` interception that yields to
`isQuitting` (see [meet-call-window.md](meet-call-window.md) §8). Tray Exit is never silently ignored: while
the close confirm (P1) is open it dismisses that confirm and shows the Exit confirm (P2) (fallback if an open
native box cannot be dismissed: focus P1, show P2 after the answer); if P2 is already open it focuses it.
`window-all-closed` does **not** call
`app.quit()` (Electron's Linux/Windows default
would otherwise quit the app when the last window closes — this must be overridden). The renderer
process is never destroyed by hide — this is the same live-window requirement notifications depend
on (the *Hidden window must stay live* project rule; see [Notifications](notifications.md)).

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

## Application menu suppression is part of the *Quit only from the tray* project rule, not a separate concern

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
path this app does not want. The only guarantee strong enough to satisfy the *Quit only from the tray* project rule is
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

Created after `app.whenReady()` (a `Tray` created earlier throws).
Context menu, in order:

| Entry | Type | Action | Why it earns its place |
|---|---|---|---|
| Show call window — **conditional on a call window existing; owner-approved 2026-10-01 (P3, FR-07)** | action, first entry | present only while a call window exists, **in every one of its states** (opening, error, crashed, sign-in, Meet page); restores, raises and focuses the **call window**, and **when the source picker is open focus goes to the picker**; never touches the main window. **No tooltip change.** The menu is rebuilt (`refreshMenu`, event-driven, not from the blink tick, so NFR-06 holds) when the call window is created and destroyed. See [meet-call-window.md](meet-call-window.md) §4 and §7. | Buried call windows are otherwise reachable only by the OS window switcher. Additive to FR-07's "at minimum" list; recorded in FR-07. |
| Show/Hide Google Chat | action | toggles the **main window only** (`toggleShowHide` in `src/main/index.js`): `hide()` vs restore/`show()`/`focus()`. While a call window is open it never hides, closes or focuses the call (recommended default, not an owner decision; see [meet-call-window.md](meet-call-window.md)). | FR-07's explicit requirement: close-to-tray removes the taskbar path back in on some platforms/configs, so the tray needs its own way in. |
| Mute notifications | checkbox | see "Notification sound, mute, and icon blinking" below | Owner-requested (FR-12). The **only** preference checkbox still on the tray — Start at login and Notification sound moved to the Settings window (FR-15); see that section. |
| Settings… | action | opens/focuses the Settings `BrowserWindow` — see "Settings window (FR-15)" below | New entry point for Start at login, Notification sound, and Icon blinking (the setting label is under redesign, see [design docs](../design/00-settings-surface-spec.md)), added so the tray menu stops growing with every new preference (FR-15). |
| Exit | action | `app.quit()` (`isQuitting` is set by `before-quit`, see above). **Owner-approved 2026-10-01 (P2, FR-07):** if a call window exists, Exit first **probes it as a close attempt**; only if Meet's page objects (a live call) does an asynchronous native confirm "Exit Google Chat Desktop?" (`dialog.showMessageBox`) appear, and `app.quit()` then runs only on "Exit"; a non-objecting call window is destroyed and Exit proceeds with no dialog; a crashed call window (its crash dialog open) never blocks Exit; see [meet-call-window.md](meet-call-window.md) §8. | The **only** path that terminates the process — no in-page Exit control exists (the *Quit only from the tray* project rule, FR-07). |
| *(separator)* — build/version label | disabled, non-clickable | none | Owner-requested mid-incident (2026-09-22), see "Build/version diagnostic line" below (FR-13). |

**Amended per FR-15/Wireframe F** (supersedes the 7-item menu this table originally described):
"Start at login" and "Notification sound" checkboxes are removed from this menu — they are now
Settings-window-only controls (see "Settings window (FR-15)" below). This shrinks the menu from 7
entries to 5 (6 while a call window exists).

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
(GitVersion-derived, written by `scripts/build.js`; `version` is the same SemVer as the installer name, see [packaging-release.md](packaging-release.md) "Version flow"); it renders
`<version> (<shortSha>, <ci|local>)`, or `build info unavailable`. **This differs from FR-13's wording**
(version, "packaged" or "source", and a build timestamp taken from the entry file's mtime), which is
authoritative for the requirement: the code has moved to a build-info source and the requirement text has
not been updated. Recorded as a discrepancy for the business-analyst rather than resolved here; the tray
line's content is FR-13's, and this document does not define a third format.

**The Settings window's About line is a different, narrower thing (FR-15, ratified): the app name and the
version number only**, with no build timestamp, no packaged/source word and no SHA. It must not reuse the
tray string. See FR-13 in [requirements.md](../business/requirements.md) for the acceptance criteria.

### Start at login (FR-10)
**First-run default (owner decision 2026-09-30): ON.** After a fresh install every setting is on —
Start at login, Notification sound, Icon blinking; Mute stays off (on would silence the app). The
app itself applies it, once, in `createSettingsStore` (`settingsStore.js`): when `settings.json`
does not exist yet and the build is packaged (`enableStartAtLoginOnFirstRun: app.isPackaged`) it calls
the same `setStartAtLogin(true)` and writes the file. Any existing file — including one from an older
version — counts as "already chosen", so a restart never re-enables an entry the user turned off
(Settings switch or Task Manager). One code path for Windows and Linux; the NSIS installer is not
involved (an installer-side Run-key write would be Windows-only and would bypass the read-back).
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
implementer must check this on a real AppImage run and either fix or state the limitation (`linuxExecLine()` now registers `$APPIMAGE` when set; still unverified on a real AppImage run); NFR-08's
scenario "the autostart entry points at the space-free executable" should be tested for both artifacts.

Windows: `app.setLoginItemSettings({ openAtLogin, path, args: ['--hidden'], name })` (Electron native
API, confirmed Windows/macOS-only per `electronjs.org/docs/latest/api/app` — no Linux support).
Read current state via `app.getLoginItemSettings({ path, args, name }).openAtLogin` with **exactly the
same options as the write** (`windowsLoginItemOptions()` in `autostart.js`): Electron compares the
registry Run value to `"<exe>" <args>`, so a bare `getLoginItemSettings()` never matches an entry
registered with `--hidden` and reports false — that was the "Couldn't change Start at login —
Windows didn't apply the change" bug (0.0.1-61). `name` is pinned to the AppUserModelID. The state is
ON only if the Run entry exists **and** `HKCU\...\Explorer\StartupApproved\Run` does not carry the
Task Manager "Disabled" flag (first byte odd); a user-disabled entry reports OFF truthfully, and
turning the switch ON again re-enables it (Electron's set clears the flag). Then, and — per the design spec's read-back-verification
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

`soundEnabled`/`notificationsMuted` reach **both** places that create a toast. Intercepted
service-worker and page `showNotification` calls are re-raised by the main-process toast service
(`src/main/nativeToast.js`), which reads `settingsStore` directly (mute suppresses, sound-off forces
`silent`). The page `window.Notification` wrapper still needs the flags in the page, so main pushes current
values on toggle and at injection (`dom-ready`/`did-finish-load`) via
``webContents.executeJavaScript(`window.__gcdSoundEnabled = ...; window.__gcdMuted = ...;`)``, evaluated
**before** the wrapper snippet. [notifications.md](notifications.md) owns the delivery mechanics; this section
only owns where the flags come from and how they're persisted.

Muting does **not** affect the unread indicator — that stays driven by `page-title-updated`
independent of these flags, per FR-12. Muting **does** stop any active tray blink immediately (FR-14's
"poking" rule, decided by the owner for the blink). That muting also stops the **taskbar flash** is a
**working assumption** in FR-14, not an owner decision; the design implements it and it is one line to
change if the owner disagrees. The one notification that will ignore mute is the app-status "A call is
already open" notification of FR-16 (Meet is not built yet), which is not a chat message.

**Tray glyph precedence (fixed):** `resolveIconState` (`src/main/tray.js`) now returns `'unread'` before
`'muted'`, so the static unread indicator stays visible while muted, including on Linux where the tray glyph
is the only unread signal (FR-05a, FR-12). The muted glyph shows only when nothing is unread.

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

FR-14 (`requirements.md`) is the single authority for when the indicators start and stop; this section
describes how the code wires it (`src/main/attention.js`, `src/main/trayBlink.js`,
`src/main/unreadTracker.js`, `src/main/index.js`; verified 2026-09-30 after the BUG-01 fix, re-read the file
before relying on a detail). Owner-approved defaults applied: **one** setting (`blinkOnUnread`) governs both
the blink and the flash, and new-message indicators continue while the user is in the Meet call window or
the Settings window (they are not the main Chat window, so the main window is still "not focused").

### Shape

- **`createAttentionController`** (`attention.js`) is one small state machine so the blink and the flash can
  never disagree. Inputs: `onArrival()` (preferred trigger), `onUnreadCount(n)` (an increase is the FR-14
  degraded trigger), `observeUnreadCount(n)` (settled observations that never start anything), `onFocus()`,
  `onSettingsChanged()`, and `stop()`. `start()` calls `trayBlink.startBlinking()` (idempotent, owns the single
  timer, NFR-06) and `flashFrame(true)` (one OS request, no app timer); `stop()` calls
  `trayBlink.stopBlinking()` and `flashFrame(false)`. Dependencies are read at event time.
- **The old wiring is gone:** `createUnreadBlinkGate`, the `'show'`/`'restore'` stop listeners, and the bare
  `trayBlink.stopBlinking` settings hook no longer exist.
- **Stop 1, focus:** `bindWindowFocus(win, controller)` binds **only** `'focus'`. `show`, `restore`, `hide`
  and `minimize` are not inputs, so a window shown or restored behind other windows keeps blinking.
- **Stop 2, unread returns to zero:** a confirmed zero (`observe`/`onUnreadCount(0)`) stops both.
- **Stop 3, setting change:** `settingsStore`'s stop hook is `attention.stop()`, and `index.js` also calls
  `attention.onSettingsChanged()` after a mute or setting change, which stops when blinking is now off or
  mute is on. Turning them back on starts nothing; the next arrival does.

### "Focused" is defined in one place

`isMainWindowFocused` in `index.js` is `focused && visible && !minimized`. `isFocused()` alone is not
trustworthy: on Electron 44.4.3 / Windows 11 it kept returning true after `minimize()`, and FR-14 defines
hidden and minimized as not focused. The same predicate gates the generic-toast fallback.

### Trigger sources and the shared baseline

- **Arrival** comes from the toast service (`onArrival` after an intercepted notification, or the page
  bridge's `notification:arrived`); see [notifications.md](notifications.md).
- **Unread count** comes from the title via the **shared** `unreadTracker`: a real increase calls both
  `attention.onUnreadCount` and `toasts.onUnreadIncrease`; every other settled change calls
  `attention.observeUnreadCount` / `toasts.onUnreadObserve` and starts nothing. The baseline is seeded from the
  title count at `did-finish-load`; a rise within 4 s of the baseline raises the baseline instead of counting
  as an increase (load ramp); a zero counts only after 1 s; 20 s of only zeros makes the baseline 0.
  The implementation states which trigger it uses, as FR-14 requires: arrival when available, count increase
  as the degraded trigger, both idempotent together.
- The unread **glyph wins over muted** (`resolveIconState`), so the static indicator stays visible while
  muted (FR-05a, FR-12); the blink never runs while muted.

### The flash: what is and is not established

- `flashFrame(flag)` is wired as `mainWindow.flashFrame(flag)` guarded against a destroyed window. **When the
  window is hidden to tray it is a no-op** (a hidden window has no Windows taskbar button); the tray blink is
  the indicator in that state, and the code never shows the window just to flash it. This is the limit that
  the earlier design flagged, now the implemented behaviour, and it means FR-14's "taskbar button flashes"
  scenario for the **hidden-to-tray** state is met by the tray blink only. Whether that is acceptable, or the
  owner wants a minimized taskbar button instead (which changes FR-06's close-to-tray), is an **owner decision**.
- `stop()` always calls `flashFrame(false)` explicitly rather than relying on the OS to end the flash at
  focus. Linux: `flashFrame` maps to a window-manager urgency hint, desktop-dependent, best-effort, verified on
  a real Linux desktop.
- Mute also stopping the flash is a **working assumption** in FR-14 (the owner decided mute for the tray blink
  only); it is implemented and is one line to change.
- WCAG 2.3.1's flash threshold applies to the ~1 Hz tray alternation the app controls; the OS taskbar flash
  rate is not app-controlled, so no rate claim is made for it.

### NFR-06 as a checkable property

The two-part QA method is unchanged in shape, in focus terms: (1) a unit test with spied
`setInterval`/`clearInterval` and a stubbed `flashFrame` over the 20-cycle sequence in NFR-06, asserting on
every cycle that `flashFrame(true)` is requested on each start and `flashFrame(false)` on each stop, that
`show` without focus does **not** stop, and that a repeat arrival while active adds no timer;
(2) the same sequence by hand on a real build, moving the window between hidden, minimized,
visible-behind-another-window and focused. `trayBlink._resetForTests` and `isBlinking()` remain the seams;
`test/attention.test.js` and `test/unreadTracker.test.js` cover the controller and tracker with injected
clocks.

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
