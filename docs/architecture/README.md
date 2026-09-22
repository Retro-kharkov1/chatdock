# Architecture

<topics>
- [Overview](overview.md) — process/window model, session persistence (FR-03/FR-04), window-state persistence (FR-02).
- [Notifications](notifications.md) — the FR-05 mechanism in full, including click→specific-conversation and FR-11/FR-12 sound/mute; see also [ADR-0002](../adr/0002-notification-delivery-mechanism.md) for why.
- [Tray & Lifecycle](tray-lifecycle.md) — close-to-tray, tray menu, single-instance, start-at-login, sound/mute (FR-06/FR-07/FR-08/FR-10/FR-11/FR-12).
- [IPC Contract](ipc-contract.md) — the exact preload surface, channel by channel.
- [Packaging & Release](packaging-release.md) — electron-builder targets and the GitHub Actions release matrix (FR-09/NFR-05); see also [ADR-0003](../adr/0003-packaging-and-code-signing-approach.md).
</topics>
