'use strict';

// Origin gating for everything the app offers to the MAIN window's page (docs/architecture/ipc-contract.md
// "Origin gating"). The main window is not only ever on Chat: sign-in (accounts.google.com) and any
// redirect target load in it too, and none of those may reach the app's channels or feed its state.
//
// "Trusted" means: the main window's own webContents, its MAIN frame, currently on one of `origins`
// (the notification origins: the chat origin, plus the loopback stand-in in an unpackaged dev run -
// never the sign-in origin). Pure and Electron-free, so it is unit-tested.

const BRIDGE_PROBE_CHANNEL = 'gcd:bridge-probe';

/** @returns {string|undefined} the http(s) origin of `url`, undefined for anything else. */
function urlOrigin(url) {
  if (typeof url !== 'string' || url === '') return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : undefined;
  } catch {
    return undefined;
  }
}

function alive(webContents) {
  if (!webContents || typeof webContents !== 'object') return false;
  try {
    return typeof webContents.isDestroyed === 'function' ? !webContents.isDestroyed() : true;
  } catch {
    return false;
  }
}

/** URL of the main frame (what the user is looking at), falling back to getURL(). */
function mainFrameUrl(webContents) {
  try {
    const frame = webContents.mainFrame;
    if (frame && typeof frame.url === 'string') return frame.url;
    return typeof webContents.getURL === 'function' ? webContents.getURL() : undefined;
  } catch {
    return undefined;
  }
}

/** True when the webContents is alive and its main frame is on one of `origins`. */
function isChatMainFrame(webContents, origins) {
  if (!alive(webContents) || !Array.isArray(origins)) return false;
  const origin = urlOrigin(mainFrameUrl(webContents));
  return origin !== undefined && origins.includes(origin);
}

/**
 * IPC sender check: the event comes from `webContents` itself, from its main frame, whose origin is
 * on the list AND the window is on that origin right now (a frame created on Chat that has since
 * navigated away is refused).
 */
function isTrustedMainSender(event, webContents, origins) {
  if (!event || !alive(webContents) || !Array.isArray(origins)) return false;
  if (event.sender !== webContents) return false;
  const frame = event.senderFrame;
  if (!frame || frame !== webContents.mainFrame) return false;
  if (!origins.includes(frame.origin)) return false;
  return isChatMainFrame(webContents, origins);
}

/**
 * @param {object} deps
 * @param {() => object|null} deps.getWebContents the main window's webContents (null before it exists)
 * @param {string[]} deps.origins
 * @param {(msg: string) => void} [deps.log]
 */
function createMainFrameGuard({ getWebContents, origins, log = () => {} }) {
  return {
    /** true to proceed; false (logged, channel name only - never the payload) to drop the message. */
    accept(event, channel) {
      if (isTrustedMainSender(event, getWebContents(), origins)) return true;
      let origin;
      try {
        origin = event && event.senderFrame ? event.senderFrame.origin : undefined;
      } catch {
        origin = undefined;
      }
      log(`[gcd] rejected ${channel} from an untrusted sender (origin: ${origin})`);
      return false;
    },
  };
}

/**
 * The preload cannot know the dev loopback origin (no argv/env/page input is allowed to decide it), so
 * off the chat origin it asks MAIN synchronously. MAIN answers from the transport (sender frame) and its
 * own origin list: `true` only for a trusted main frame, so a production run answers false for any
 * loopback page.
 */
function registerBridgeProbe(ipcMain, { getWebContents, origins }) {
  ipcMain.on(BRIDGE_PROBE_CHANNEL, (event) => {
    event.returnValue = isTrustedMainSender(event, getWebContents(), origins) === true;
  });
}

module.exports = {
  BRIDGE_PROBE_CHANNEL,
  urlOrigin,
  mainFrameUrl,
  isChatMainFrame,
  isTrustedMainSender,
  createMainFrameGuard,
  registerBridgeProbe,
};
