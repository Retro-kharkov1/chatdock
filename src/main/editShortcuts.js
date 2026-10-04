'use strict';

// Clipboard / undo accelerators for windows that have no application menu.
//
// Menu.setApplicationMenu(null) (index.js; docs/architecture/tray-lifecycle.md "Application menu suppression")
// also removes the Edit-role routing of Ctrl+C/X/V/A/Z(+Shift) on Windows/Linux. They are restored by dispatching
// straight to the contents' own edit commands - no Menu, so no second quit-capable surface. Used by the main
// window and by every Google app window (docs/architecture/google-app-windows.md section 4). Anything else
// (Ctrl+W, Ctrl+Q, Ctrl+Y ...) is deliberately left alone: no close or quit path is created here.
// No Electron import: the contents is passed in.

/** Bind the accelerators on one webContents. */
function bindEditShortcuts(webContents) {
  webContents.on('before-input-event', (event, input) => {
    if (!input || input.type !== 'keyDown' || !(input.control || input.meta)) return;
    const key = String(input.key).toLowerCase();
    const actions = {
      c: () => webContents.copy(),
      x: () => webContents.cut(),
      v: () => webContents.paste(),
      a: () => webContents.selectAll(),
      z: () => (input.shift ? webContents.redo() : webContents.undo()),
    };
    if (Object.prototype.hasOwnProperty.call(actions, key)) {
      event.preventDefault();
      actions[key]();
    }
  });
}

module.exports = { bindEditShortcuts };
