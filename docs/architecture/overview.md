# Process & Window Model, Session, Window-State Persistence

<overview>
Implements FR-01, FR-02, FR-03, FR-04, and carries the window model that FR-15 and FR-16 extend. Grounded in standard Electron desktop practice (security defaults, session persistence, OAuth embedded-browser block)
(process architecture and session/UA mechanics — not restated in full here) and
[ADR-0001](../adr/0001-google-sign-in-strategy.md) (sign-in strategy — read that ADR before this
doc for the *why*; this doc covers the concrete configuration). Rules cited as *Italic Name* project rule are defined in
[Project Rules](project-rules.md).
</overview>

<architecture>
## Processes

- **Main process** (`src/main/index.js`): the only process with Node/Electron main-process API
  access. Owns `app` lifecycle, the single `BrowserWindow`, the `Tray`, the persistent session, and
  all notification/tray/IPC wiring described in the sibling docs.
- **Windows**: one **main** `BrowserWindow` (this section), plus two on-demand secondary windows that
  are destroyed on close and never replace it: the **Settings window** (FR-15, local bundled HTML, own
  preload; see [Tray & Lifecycle](tray-lifecycle.md)) and the **Meet call window** (FR-16, third-party
  Meet page with no preload, plus a small app-owned local view for loading/error/crash UI; see
  [Meet Call Window](meet-call-window.md)). At most one of each exists.
- **Main renderer**: the main `BrowserWindow`, loading
  `https://chat.google.com/` (FR-01) directly — never an Electron `<webview>`
  tag (per ADR-0001 and the *Electron security baseline* project rule). Treated as untrusted
  third-party content: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
  `webSecurity: true` (Electron's own current defaults — not weakened).
- **Preload** (`src/preload/preload.js`): the narrow contextBridge surface — see
  [IPC Contract](ipc-contract.md). Also the injection point for the notification-click bridge (see
  [Notifications](notifications.md)); that injection runs in the page's own **main world** via
  `webContents.executeJavaScript()`, not through `contextBridge` — the two are different mechanisms
  and are not to be confused when reading the code.

## Window configuration (`BrowserWindow` constructor options)

```js
{
  width: 1200, height: 800,       // FR-01 default size; overridden by persisted state below
  show: false,                    // see "Window-state persistence" below, and the FR-10 note in
                                   // tray-lifecycle.md about what this implies for page visibility
  webPreferences: {
    partition: 'persist:google-chat',   // FR-03/FR-04 — see "Session persistence" below
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    // `backgroundThrottling` is deliberately left UNSET (Electron's default, `true`). It was
    // tried as `false` to satisfy FR-05 / the *Hidden window must stay live* project rule, then reverted: it broke
    // notifications instead of protecting them, by pinning `document.visibilityState` at
    // `"visible"` while the window was actually hidden — Google Chat reads that value and
    // suppresses notifications for a "visible" tab. Do not re-add this flag without reading
    // ADR-0002 Revision 3 first; see notifications.md's "Page Visibility dependency" for the full
    // mechanism this depends on.
    preload: path.join(__dirname, '../preload/preload.js'),
  },
}
```

`setWindowOpenHandler()` denies every popup by default and hands any `target=_blank`/`window.open`
call to `shell.openExternal()` instead of opening it inside the app (per
the *Electron security baseline* project rule), **with one exception**: a Google Meet link (exact match, see
[Meet Call Window](meet-call-window.md) and the project rule's "Single exception") is denied as a popup and
opened in the app-owned call window instead. `will-navigate` is validated against an allowlist starting
with `chat.google.com`/`accounts.google.com` origins; anything else is prevented and handed to the
system browser the same way, except that the main window navigating itself to a Meet URL is prevented and
routed to the call window (the Meet routing is design, not yet built). **Owner decision 2026-10-01:** the
system-browser hand-off applies only to `http`, `https` and `mailto`; any other scheme is not opened (see
[Meet Call Window](meet-call-window.md) §2 rule 4; today's handlers still pass every URL on). **Today** the session's permission
handlers (request **and** check, `src/main/session.js`) grant only `notifications` (the chat origin, plus a
dev loopback origin) and `clipboard-sanitized-write` (the chat origin only, BUG-02, from a separate
`clipboardOrigins` allowlist so the dev loopback origin gets no clipboard write); everything else is denied,
including `clipboard-read`, `clipboard-write`, `clipboard` and `clipboard-sanitized-read`. The Meet design extends them with an origin gate for camera, microphone and display capture
(see [Meet Call Window](meet-call-window.md) §4).

**This allowlist is provisional, not settled.** Google's sign-in flow — especially 2-factor/
security-challenge steps (prompt approval, backup codes, security-key/WebAuthn challenges) — can
route through additional origins beyond `accounts.google.com` (observed patterns include
`myaccount.google.com`, WebAuthn/FIDO redirect pages, and SMS/voice-challenge intermediate pages,
though the exact set depends on the account's configured 2FA methods and is not fully enumerable
without a live sign-in). A too-narrow allowlist would bounce a real 2FA step out to the system
browser mid-flow, breaking FR-03's "no separate external browser window was required" scenario for
some accounts. **Task 2's real sign-in verification is what actually settles this list** — if a
real sign-in with 2FA enabled hits a blocked navigation, add that origin rather than treating the
starting list above as final. Do not present this table as complete before that verification has
happened.

## Session persistence (FR-03, FR-04)

- **Partition**: `session.fromPartition('persist:google-chat')`. The `persist:` prefix is required
  — a partition name without it is in-memory-only and forgets everything (including the login
  cookie) the moment the window closes, which would silently fail FR-04. (Confirmed:
  `https://www.electronjs.org/docs/latest/api/session`.)
- **User agent**: `session.setUserAgent('<standard desktop Chrome UA string, matching the Chromium
  version Electron currently bundles>')` set once at startup, before the window loads. See
  ADR-0001 for why this specific configuration (not `<webview>`, not the unmodified Electron UA)
  is the primary sign-in path, and the pre-designed fallback if it fails.
- **On-disk location** (what "logged in across reboots" concretely depends on): Electron persists
  the partition under `app.getPath('userData')/Partitions/google-chat/` —
  - Windows: `%APPDATA%\google-chat-desktop\Partitions\google-chat\`
  - Linux: `~/.config/google-chat-desktop/Partitions/google-chat/`
- **What silently breaks it**: renaming the partition string between releases (creates a fresh,
  empty partition — the user appears logged out with no error); changing the app's `appId`/product
  name in a way that changes `userData`'s resolved path; a user or cleanup tool clearing the
  `userData` folder; running a debug build with a different partition name than the packaged build
  (a common "works in dev, logged out when packaged" trap — the same category of dev-vs-packaged bug). Google revoking the session server-side is
  the one **expected** case (FR-04's third scenario) — the app must not treat that as a bug, it
  must just show the sign-in flow again.

## Window-state persistence (FR-02)

Recommended: the `electron-window-state` npm package (widely used, purpose-built for exactly FR-02
including the off-screen-fallback behavior) — the implementer confirms it is still maintained
before adding it as a dependency; if not, a hand-rolled equivalent (persist
`{width, height, x, y, isMaximized}` as JSON under `userData`, restore on `ready-to-show`, and on
restore check the saved `x,y` against `screen.getAllDisplays()`'s combined work area — falling back
to the FR-01 default size centered on the primary display if the saved position falls outside all
current displays) is a small, self-contained piece of main-process code with no extra dependency.
Either way, this logic lives in `src/main/window-state.js` and is applied before the window is
shown (`show: false` at construction, `win.show()` once state is applied, avoiding a visible
resize/reposition flash).
</architecture>
