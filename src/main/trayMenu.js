'use strict';

// The tray context-menu TEMPLATE, as a pure function so it is testable without Electron (tray.js
// requires `electron` at load time). docs/architecture/tray-lifecycle.md "Tray icon and context
// menu"; docs/design/06-meet-native-wording.md section 3.
//
// "Show call window" (P3) is the first entry and exists only while a call window exists;
// `hasCallWindow()` is read at build time and tray.refreshMenu() is driven by the call window's
// onChange hook (event-driven, never the blink tick). "Back to Chat" (FR-19) is likewise read at build time
// (`isSignInActive()`) and the menu is rebuilt by the sign-in flow's onModeChange.

function buildTrayMenuTemplate({
  getNotificationsMuted,
  getVersionLabel,
  hasCallWindow,
  isSignInActive = () => false,
  onBackToChat = () => {},
  onShowCallWindow,
  onToggleShowHide,
  onToggleMute,
  onOpenSettings,
  onOpenHelp,
  onExit,
}) {
  const template = [];
  if (hasCallWindow()) {
    template.push({ label: 'Show call window', click: () => onShowCallWindow() }, { type: 'separator' });
  }
  template.push(
    { label: 'Show/Hide Google Chat', click: () => onToggleShowHide() },
    // FR-19 (sign-in-flow.md section 3a): only while the sign-in mode is on, directly after Show/Hide.
    ...(isSignInActive() ? [{ label: 'Back to Chat', click: () => onBackToChat() }] : []),
    { type: 'separator' },
    {
      label: 'Mute notifications',
      type: 'checkbox',
      checked: getNotificationsMuted(),
      click: () => onToggleMute(),
    },
    { type: 'separator' },
    { label: 'Settings…', click: () => onOpenSettings() },
    // UI-06: the in-app user guide, next to Settings (same group), above Exit.
    { label: 'Help', click: () => onOpenHelp() },
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
