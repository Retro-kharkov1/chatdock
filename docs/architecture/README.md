# Architecture

<topics>
- [Overview](overview.md) — process/window model, session persistence (FR-03/FR-04), window-state persistence (FR-02).
- [Notifications](notifications.md) — FR-05a/b/c: what the code does today, the candidate delivery mechanisms pending Spikes A and C, the application-log requirement; see also [ADR-0004](../adr/0004-desktop-shell-technology-and-electron-retention.md) and [ADR-0002](../adr/0002-notification-delivery-mechanism.md).
- [Tray & Lifecycle](tray-lifecycle.md) — close-to-tray, tray menu, single-instance, start-at-login, sound/mute, the settings store, and the FR-14 attention indicators (tray blink and taskbar flash).
- [Meet Call Window](meet-call-window.md) — FR-16/NFR-07: Meet link classifier and routing, the Meet-only call window, media permissions, screen-share picker, close/quit handling, test map and implementation order.
- [Google App Windows](google-app-windows.md) — FR-17/UI-04: Google service links in app-owned windows sharing the session, exact host lists, Chat links into the main window, downloads, permissions, test map and implementation order.
- [IPC Contract](ipc-contract.md) — the exact preload surface, channel by channel (including the picker channels).
- [Packaging & Release](packaging-release.md) — electron-builder targets, Linux packaging (NFR-08) and the GitHub Actions release matrix (FR-09/NFR-05); see also [ADR-0003](../adr/0003-packaging-and-code-signing-approach.md).
- [Project Rules](project-rules.md) — the standing rules other documents cite (wrapper not a rewrite, security baseline, quit only from the tray, and others).
</topics>
