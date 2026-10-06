'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The complete IPC surface — see docs/architecture/ipc-contract.md. Nothing beyond these three
// fire-and-forget senders is exposed to the renderer, per the Electron security baseline (docs/architecture/project-rules.md) -
// never expose `ipcRenderer` itself. `notificationClicked` is a
// fire-and-forget send: the notification-click wrapper injected into the page's main world (see
// docs/architecture/notifications.md piece 2) calls `window.__gcdBridge.notificationClicked()`
// when Chat's own page code fires a `click` event on a notification this app created. The main
// process responds by showing/focusing the window — no return value is needed here.
//
// ORIGIN GATE (docs/architecture/ipc-contract.md "Origin gating"): this preload runs in whatever page the
// main window shows - Chat, but also accounts.google.com and any redirect target. It exposes the bridge and
// installs the smart-copy detector ONLY on the chat origin (main frame); anywhere else it does nothing at all.
// The dev loopback stand-in (GCD_DEV_START_URL, unpackaged only) cannot be recognised here - no argv, env or
// page input may decide it - so on a loopback origin the preload asks MAIN, which answers from the sender
// frame and its own origin list (a production run answers false).
const CHAT_ORIGIN = 'https://chat.google.com';
const BRIDGE_PROBE_CHANNEL = 'gcd:bridge-probe'; // keep in step with src/main/mainFrameGate.js

function isOwnerOfBridge() {
  try {
    if (window.parent !== undefined && window.parent !== window) return false; // main frame only
    const origin = window.location.origin;
    if (origin === CHAT_ORIGIN) return true;
    if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return false;
    return ipcRenderer.sendSync(BRIDGE_PROBE_CHANNEL) === true;
  } catch {
    return false;
  }
}

if (isOwnerOfBridge()) {
  contextBridge.exposeInMainWorld('__gcdBridge', {
    notificationClicked: () => ipcRenderer.send('notification:clicked'),
    // BUG-01: the page made its own native toast (window.Notification) - only an arrival signal.
    notificationArrived: () => ipcRenderer.send('notification:arrived'),
    // BUG-01-B: a page-initiated ServiceWorkerRegistration.showNotification, which Electron does not
    // display; main re-raises it as a native toast. Payload is sanitised main-side.
    notificationShow: (payload) => ipcRenderer.send('notification:show', payload),
  });
  installSmartCopyDetector();
}

// UI-05 / FR-18 (docs/architecture/smart-copy.md section 2): copy-on-select detector. INTERNAL: nothing here is
// exposed through contextBridge, so the page can neither call it nor see it. It listens (capture phase, never
// preventDefault/stopPropagation) for a genuine left-button gesture that ends with a changed, non-empty,
// non-editable selection and sends ONE payload-free signal; the main process validates it and calls
// webContents.copy(). No text, coordinates or element data ever leave this script. When unsure the answer is
// "editable": no copy.
function installSmartCopyDetector() {
  const EDITABLE = 'input, textarea, [role="textbox"]';
  const DRAG_PX = 4;
  let down = null;

  function isEditableElement(el) {
    for (let node = el, guard = 0; node && guard < 64; guard += 1) {
      if (node.isContentEditable === true) return true;
      if (typeof node.closest === 'function' && node.closest(EDITABLE) !== null) return true;
      // Leave an open or closed shadow tree through its host (getRootNode().host is reachable from inside).
      const root = typeof node.getRootNode === 'function' ? node.getRootNode() : null;
      node = root && root.host ? root.host : null;
    }
    return false;
  }

  /** true when the node is (inside) an editable element, or when it cannot be resolved to an element. */
  function isEditableNode(node) {
    if (!node) return true;
    const el = node.nodeType === 1 ? node : node.parentElement || (node.parentNode && node.parentNode.host) || null;
    if (!el) return true;
    return isEditableElement(el);
  }

  function eventTarget(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    return path.length > 0 ? path[0] : event.target;
  }

  /** document.activeElement followed through open shadow roots; every level is tested. */
  function activeIsEditable() {
    let active = document.activeElement;
    for (let guard = 0; active && guard < 16; guard += 1) {
      if (isEditableElement(active)) return true;
      const inner = active.shadowRoot && active.shadowRoot.activeElement;
      if (!inner) return false;
      active = inner;
    }
    return false;
  }

  function boundary(sel) {
    if (!sel) return null;
    return [sel.anchorNode, sel.anchorOffset, sel.focusNode, sel.focusOffset];
  }

  function sameBoundary(a, b) {
    if (a === null || b === null) return a === b;
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
  }

  function plainLeftButton(event) {
    return event.isTrusted === true && event.button === 0 && !event.ctrlKey && !event.altKey && !event.metaKey;
  }

  window.addEventListener(
    'mousedown',
    (event) => {
      down = null;
      try {
        if (!plainLeftButton(event)) return;
        down = {
          x: event.screenX,
          y: event.screenY,
          detail: event.detail,
          editableTarget: isEditableNode(eventTarget(event)),
          boundary: boundary(window.getSelection()),
        };
      } catch {
        down = null;
      }
    },
    { capture: true }
  );

  window.addEventListener(
    'mouseup',
    (event) => {
      const start = down;
      down = null;
      try {
        if (start === null || !plainLeftButton(event)) return;
        const moved = Math.hypot(event.screenX - start.x, event.screenY - start.y);
        const multiClick = Math.max(start.detail || 0, event.detail || 0) >= 2;
        if (!multiClick && !(moved >= DRAG_PX)) return;
        if (start.editableTarget || isEditableNode(eventTarget(event))) return;

        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed || sel.toString().trim() === '') return;
        if (sameBoundary(start.boundary, boundary(sel))) return; // stale: this gesture did not change the selection
        if (isEditableNode(sel.anchorNode) || isEditableNode(sel.focusNode) || activeIsEditable()) return;

        ipcRenderer.send('smartcopy:signal', { kind: 'selection' });
      } catch {
        // never disturb the page
      }
    },
    { capture: true }
  );
}
