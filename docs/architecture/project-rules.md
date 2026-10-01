# Project Rules

<overview>
Six standing rules that the other documents cite by name (rendered as *Italic Name* project rule). They
are decisions of the maintainer, stated here so each document can point at one place. Where a design
document and a rule differ, the rule wins.
</overview>

<rules>
## Wrapper, not a rewrite

The app loads Google Chat as it is and adds only what a browser tab cannot do (tray, native
notifications, window state). It does not scrape the page, inject UI or script into Chat or Meet, or
re-implement Chat features. The only added page surface is the preload's narrow, write-only signals
(see [IPC Contract](ipc-contract.md)). Anything that would read or drive the page is a separate,
explicit maintainer decision.

## Electron security baseline

Chat and Meet are untrusted third-party content.

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`; no
  `<webview>` tag.
- The preload exposes only a small named function surface through `contextBridge`; never
  `ipcRenderer` itself.
- Popups and navigation are checked against an allow-list; external links open in the system browser
  and only for the `http`, `https` and `mailto` schemes.
- Single exception: a Google Meet link whose origin is exactly `https://meet.google.com` (no other
  port, no userinfo, no lookalike host) opens in the app-owned call window. That window denies its own
  popups, and its permissions are scoped to Meet.
- Screen sharing: the user always chooses the source explicitly; nothing is pre-selected. On Linux the
  OS picker is allowed.
- Never log, persist elsewhere or transmit cookies, tokens, credentials, message text, or sender and
  chat names.

## Hidden window must stay live

Closing the window hides it; the page keeps running at normal speed so messages still arrive and
notifications still fire. Background throttling must not delay or drop them. This is verified by
hiding the window and receiving a real message, not by reasoning.

## Quit only from the tray

The close (X) button hides the window and never quits. Only the tray's Exit entry (and OS shutdown)
terminates the process. There is no in-page Exit control.

## Verify on a real desktop

Anything that depends on the OS (notifications, tray, autostart, installers) is verified on a real
desktop session, not only by unit tests or reasoning. Reports state which platforms were actually
checked.

## Installers are part of done

A release is not done until the installers have been built and run. Release notes state plainly that
the artifacts are unsigned and what the user will see (Windows SmartScreen warning), see
[Packaging & Release](packaging-release.md).
</rules>
