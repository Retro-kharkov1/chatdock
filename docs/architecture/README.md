# Architecture

<topics>
- [Overview](overview.md) — process/window model, session persistence (FR-03/FR-04), window-state persistence (FR-02).
- [Notifications](notifications.md) — FR-05a/b/c: what the code does today, the candidate delivery mechanisms pending Spikes A and C, the application-log requirement; see also [ADR-0004](../adr/0004-desktop-shell-technology-and-electron-retention.md) and [ADR-0002](../adr/0002-notification-delivery-mechanism.md).
- [Tray & Lifecycle](tray-lifecycle.md) — close-to-tray, tray menu, single-instance, start-at-login, sound/mute, the settings store, and the FR-14 attention indicators (tray blink and taskbar flash).
- [Meet Call Window](meet-call-window.md) — FR-16/NFR-07: Meet link classifier and routing, the Meet-only call window, media permissions, screen-share picker, close/quit handling, test map and implementation order.
- [Google App Windows](google-app-windows.md) — FR-17/UI-04: Google service links in app-owned windows sharing the session, exact host lists, Chat links into the main window, downloads, permissions, test map and implementation order.
- [Smart Copy](smart-copy.md) — FR-18/UI-05: right-click copies a link (main and Google windows); selecting text copies it in the main Chat window only (existing preload sends one no-payload signal, never in editable fields; Google windows have no copy-on-select); app-owned hint window, spike, test map and implementation order.
- [Sign-in Flow](sign-in-flow.md) — FR-19: a "sign-in in progress" mode that lets the user's identity provider (SAML single sign-on, second-step and passkey pages) load in the main window only until Chat loads again, a limit, or the tray entry "Back to Chat", with no new permission, bridge, download or IPC for those pages; entry/exit, security rules, test map and implementation order.
- [File access](file-access.md) — BUG-07/BUG-08: why dropping or picking a file did nothing (the denied `fileSystem` permission, then a cancelled picker), the narrow read-only grant, the picker fallback, what was verified where.
- [IPC Contract](ipc-contract.md) — the exact preload surface, channel by channel (including the picker channels).
- [Packaging & Release](packaging-release.md) — electron-builder targets, Linux packaging (NFR-08) and the GitHub Actions release matrix (FR-09/NFR-05); see also [ADR-0003](../adr/0003-packaging-and-code-signing-approach.md).
- [Browser parity gaps](browser-parity-gaps.md) — what Chrome does for Google Chat that the shell does not yet (context menu, spellcheck, reload, zoom, fullscreen and clipboard grants, downloads feedback, and more): evidence, severity, proposed fixes and the project rule each touches.
- [Project Rules](project-rules.md) — the standing rules other documents cite (wrapper not a rewrite, security baseline, quit only from the tray, and others).
</topics>
