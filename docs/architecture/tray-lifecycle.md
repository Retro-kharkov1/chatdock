# Tray & Lifecycle (FR-06, FR-07, FR-08, FR-10, FR-11, FR-12)

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

## Tray icon and context menu (FR-07, FR-10, FR-11, FR-12)

Created after `app.whenReady()` (per `electron-desktop.md` §7 — a `Tray` created earlier throws).
Context menu, in order:

| Entry | Type | Action | Why it earns its place |
|---|---|---|---|
| Show/Hide Google Chat | action | toggles `mainWindow.isVisible()` — `hide()` vs `show(); focus()` | FR-07's explicit requirement: close-to-tray removes the taskbar path back in on some platforms/configs, so the tray needs its own way in. |
| Start at login | checkbox | see "Start at login (FR-10)" below | Owner-requested (FR-10). |
| Notification sound | checkbox | see "Sound & mute (FR-11/FR-12)" below | Owner-requested (FR-11). |
| Mute notifications | checkbox | see "Sound & mute (FR-11/FR-12)" below | Owner-requested (FR-12). |
| Exit | action | `isQuitting = true; app.quit();` | The **only** path that terminates the process — no in-page Exit control exists (space's `quit-only-from-tray` rule, FR-07). |
| *(separator)* — build/version label | disabled, non-clickable | none | Owner-requested mid-incident (2026-09-22), see "Build/version diagnostic line" below (FR-13). |

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
Windows: `app.setLoginItemSettings({ openAtLogin: checked })` (Electron native API, confirmed
Windows/macOS-only per `electronjs.org/docs/latest/api/app` — no Linux support). Read current state
at startup via `app.getLoginItemSettings().openAtLogin` to initialize the checkbox correctly rather
than trusting a possibly-stale stored preference.

Linux: no Electron API exists. Implement via a hand-written XDG autostart entry: on enable, write
`~/.config/autostart/google-chat-desktop.desktop` (standard `Exec=`/`Name=`/`Type=Application`
fields pointing at the packaged binary — see the XDG Desktop Entry / Autostart specifications); on
disable, delete that file. Read current state at startup by checking whether the file exists. This
is a real Windows/Linux implementation difference (NFR-01), not an oversight.

### Sound & mute (FR-11, FR-12)
Two independent booleans — `soundEnabled` (default `true`) and `notificationsMuted` (default
`false`) — persisted alongside window-state in a small `settings.json` under `userData` (see
[overview.md](overview.md)'s window-state persistence for the equivalent pattern), loaded at
startup and written on every toggle.

Both flags need to reach the injected `Notification` wrapper in [notifications.md](notifications.md)
piece 2, since that's where notifications are actually created — that file owns the canonical
wrapper snippet (including the mute/sound branches); this section only owns where the flags come
from and how they're persisted. On toggle, and at initial injection (`dom-ready`/`did-finish-load`),
the main process pushes current values into the page via
``webContents.executeJavaScript(`window.__gcdSoundEnabled = ${soundEnabled}; window.__gcdMuted =
${notificationsMuted};`)``, evaluated **before** the wrapper snippet so the globals exist when the
wrapper first reads them.

Muting does **not** affect the tray unread indicator (piece 3 of notifications.md) — that stays
driven by `page-title-updated` independent of these flags, per FR-12's explicit requirement that
mute silences notifications, not the unread count.

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
