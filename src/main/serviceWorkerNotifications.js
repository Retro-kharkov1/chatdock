'use strict';

const { isAllowedSender } = require('./originCheck');

// BUG-01-B, main-process half of the service-worker route (Electron 44.4.3).
//
// Chat's own service worker may call `self.registration.showNotification()`, which the page-level
// bridge cannot see (different JS realm) and which shows no toast in Electron. Electron documents
// service-worker preload scripts (`ses.registerPreloadScript({type: 'service-worker'})`) and
// `ServiceWorkerMain.ipc`: the preload (src/preload/serviceWorkerPreload.js) patches the worker's
// main-world `showNotification` and sends the request over IPC; this module receives it.
//   https://www.electronjs.org/docs/latest/api/session#sesregisterpreloadscriptscript
//   https://www.electronjs.org/docs/latest/api/service-worker-main
//   https://www.electronjs.org/docs/latest/api/ipc-main-service-worker
//
// Security: the worker is untrusted web content - a request is honoured only when the worker's
// scope origin is on the notification allowlist (chat origin only, not the sign-in origin), and the
// payload is sanitised downstream.
//
// Hooking (verified on 44.4.3): getWorkerFromVersionID returns the SAME ServiceWorkerMain object on
// every call and across worker stop/start cycles, and its ipc listeners survive a restart - so one
// listener per wrapper object (WeakSet) is correct. It is deliberately NOT keyed by versionId: the
// running-status-changed details reported versionId 0 for every event in the probe, so a
// versionId key would wrongly skip every worker after the first.

const CHANNEL = 'notification:sw-show';
// BUG-05: worker -> main "open this URL" (what a replayed click asked clients.openWindow/navigate
// for) and main -> worker "replay a notificationclick with this record".
const OPEN_CHANNEL = 'notification:sw-open';
const CLICK_CHANNEL = 'notification:sw-click';

/**
 * @param {Electron.Session|object} ses Session (or a stand-in exposing registerPreloadScript and
 *   serviceWorkers).
 * @param {object} opts
 * @param {string} opts.preloadPath Absolute path of the service-worker preload script.
 * @param {string[]} opts.allowedOrigins
 * @param {(payload: unknown, ctx: {scope: string}) => void} opts.onShow Receives the (unsanitised)
 *   payload and the worker's scope (from the transport, not the payload).
 * @param {(url: string, ctx: {scope: string}) => void} [opts.onOpen] A replayed click asked to open
 *   a URL (BUG-05). The URL is untrusted; the receiver decides where it goes.
 * @param {(msg: string, err?: unknown) => void} [opts.log]
 */
function attachServiceWorkerNotifications(ses, { preloadPath, allowedOrigins, onShow, onOpen = () => {}, log = () => {} }) {
  ses.registerPreloadScript({ type: 'service-worker', filePath: preloadPath });

  const hooked = new WeakSet();

  function hook(worker) {
    if (!worker || hooked.has(worker)) return;
    hooked.add(worker);
    const allowedScope = (event, what) => {
      let origin;
      try {
        origin = new URL(event.serviceWorker.scope).origin;
      } catch {
        origin = undefined;
      }
      if (isAllowedSender(origin, allowedOrigins)) return event.serviceWorker.scope;
      log(`[gcd] rejected service-worker ${what} from disallowed scope: ${origin}`);
      return null;
    };
    worker.ipc.on(CHANNEL, (event, payload) => {
      const scope = allowedScope(event, 'notification');
      if (scope !== null) onShow(payload, { scope });
    });
    worker.ipc.on(OPEN_CHANNEL, (event, url) => {
      const scope = allowedScope(event, 'open request');
      if (scope !== null && typeof url === 'string') onOpen(url, { scope });
    });
  }

  function hookVersion(versionId) {
    try {
      hook(ses.serviceWorkers.getWorkerFromVersionID(versionId));
    } catch (err) {
      log('[gcd] service worker hook failed', err);
    }
  }

  // A worker is (re)started on demand and torn down when idle, so hook on every status change,
  // not once at startup.
  // Workers already running when this is attached (cheap, best effort). Note the versionId
  // caveat above: two workers both reporting 0 cannot be told apart through this API, so a second
  // Chat worker is only reachable if it reports a distinct id - flagged for the real-Chat check.
  try {
    const running = ses.serviceWorkers.getAllRunning && ses.serviceWorkers.getAllRunning();
    for (const id of Object.keys(running || {})) hookVersion(Number(id));
  } catch (err) {
    log('[gcd] enumerating running service workers failed', err);
  }

  ses.serviceWorkers.on('running-status-changed', (details) => {
    if (details && details.runningStatus !== 'stopped') hookVersion(details.versionId);
  });
  // S2: a worker's console is web-controlled text - only lines from an allowed scope (identified by
  // the worker version, not by anything the line itself claims) are surfaced in the app log.
  ses.serviceWorkers.on('console-message', (_event, details) => {
    if (!details || typeof details.message !== 'string' || !details.message.startsWith('[gcd-sw]')) return;
    try {
      const info = ses.serviceWorkers.getInfoFromVersionID(details.versionId);
      if (info && isAllowedSender(new URL(info.scope).origin, allowedOrigins)) log(details.message);
    } catch {
      // unknown worker / unparseable scope: drop the line
    }
  });

  /**
   * BUG-05: replays a toast click into the worker that raised it, so Chat's own `notificationclick`
   * listener runs (it never could, because the browser does not own the notification). Starts the
   * worker if it was torn down. Never throws; a failure is logged without the record's contents.
   * @param {string|undefined} scope The worker scope recorded with the toast.
   * @param {object} record {title, body, tag, data}
   */
  async function deliverClick(scope, record) {
    let origin;
    try {
      origin = new URL(scope).origin;
    } catch {
      origin = undefined;
    }
    if (!isAllowedSender(origin, allowedOrigins)) {
      log('[gcd] notification click not replayed: no allowed worker scope recorded');
      return;
    }
    try {
      const worker = await ses.serviceWorkers.startWorkerForScope(scope);
      worker.send(CLICK_CHANNEL, record);
    } catch (err) {
      log('[gcd] notification click not replayed: worker unavailable', err && err.name);
    }
  }

  return { deliverClick };
}

module.exports = { attachServiceWorkerNotifications, CHANNEL, OPEN_CHANNEL, CLICK_CHANNEL };
