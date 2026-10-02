# Design

<topics>
## Settings surface
- [Settings Surface Spec](00-settings-surface-spec.md) — entry points, control inventory, interaction
  rules, states, accessibility conformance.
- [Wireframes](01-settings-wireframes.md) — ASCII layouts for every state, light + dark, plus the
  updated tray menu and tray-icon state table.
- [Rationale](02-rationale.md) — the four judgement calls (surface type, tray-vs-settings duplication,
  immediate-apply, platform honesty), why each feature earns its place, and what was deliberately not
  built.

## Google Meet call (FR-16, NFR-07)
Scaled to the wrapper on 2026-10-02: the call window holds only the Meet page, so the one surface the
application draws is the screen-share picker; everything else is native and needs a wording spec only.
- [Screen-share source picker](05-meet-source-picker.md) — wireframes and spec: loading, list, selected,
  empty, listing failure, source gone; behaviour, accessibility, tokens.
- [Native dialog, notification and tray wording](06-meet-native-wording.md) — close and exit
  confirmations, "Show call window" tray entry, "call already open" notification, Meet crash dialog.
</topics>