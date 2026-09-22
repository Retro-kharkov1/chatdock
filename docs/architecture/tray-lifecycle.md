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

**This exact `win.hide()` call is the mechanism named in `electron/electron#31016`** (Windows-only
bug where `backgroundThrottling: false` does not reliably keep a hidden window's JS running) — see
[Notifications](notifications.md)'s "Fallback" section and [ADR-0002](../adr/0002-notification-delivery-mechanism.md)
for the verification trigger and contingency. Not an issue for close-to-tray itself (hiding still
works correctly); it only affects whether notifications keep firing while hidden.

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

Left-click/double-click on the tray icon mirrors the Show/Hide entry (Windows/Linux convention —
macOS's different menu-bar convention is moot, out of scope per ADR-0003).

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
