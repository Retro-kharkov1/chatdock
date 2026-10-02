'use strict';

// The tray context-menu TEMPLATE, as a pure function so it is testable without Electron (tray.js
// requires `electron` at load time). docs/architecture/tray-lifecycle.md "Tray icon and context
// menu"; docs/design/06-meet-native-wording.md section 3.
//
// "Show call window" (P3) is the first entry and exists only while a call window exists;
// `hasCallWindow()` is read at build time and tray.refreshMenu() is driven by the call window's
// onChange hook (event-driven, never the blink tick).

function buildTrayMenuTemplate({
  getNotificationsMuted,
  getVersionLabel,
  hasCallWindow,
  onShowCallWindow,
  onToggleShowHide,
  onToggleMute,
  onOpenSettings,
  onExit,
}) {
  const template = [];
  if (hasCallWindow()) {
    template.push({ label: 'Show call window', click: () => onShowCallWindow() }, { type: 'separator' });
  }
  template.push(
    { label: 'Show/Hide Google Chat', click: () => onToggleShowHide() },
    { type: 'separator' },
    {
      label: 'Mute notifications',
      type: 'checkbox',
      checked: getNotificationsMuted(),
      click: () => onToggleMute(),
    },
    { type: 'separator' },
    { label: 'Settings…', click: () => onOpenSettings() },
    { type: 'separator' },
    // The only path that terminates the process (project rule "Quit only from the tray").
    { label: 'Exit', click: () => onExit() },
    { type: 'separator' },
    // Disabled diagnostic line (FR-13), deliberately last.
    { label: getVersionLabel(), enabled: false }
  );
  return template;
}

module.exports = { buildTrayMenuTemplate };
