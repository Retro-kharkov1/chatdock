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

/**
 * @param {Electron.Session|object} ses Session (or a stand-in exposing registerPreloadScript and
 *   serviceWorkers).
 * @param {object} opts
 * @param {string} opts.preloadPath Absolute path of the service-worker preload script.
 * @param {string[]} opts.allowedOrigins
 * @param {(payload: unknown) => void} opts.onShow Receives the (unsanitised) payload.
 * @param {(msg: string, err?: unknown) => void} [opts.log]
 */
function attachServiceWorkerNotifications(ses, { preloadPath, allowedOrigins, onShow, log = () => {} }) {
  ses.registerPreloadScript({ type: 'service-worker', filePath: preloadPath });

  const hooked = new WeakSet();

  function hook(worker) {
    if (!worker || hooked.has(worker)) return;
    hooked.add(worker);
    worker.ipc.on(CHANNEL, (event, payload) => {
      let origin;
      try {
        origin = new URL(event.serviceWorker.scope).origin;
      } catch {
        origin = undefined;
      }
      if (!isAllowedSender(origin, allowedOrigins)) {
        log(`[gcd] rejected service-worker notification from disallowed scope: ${origin}`);
        return;
      }
      onShow(payload);
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
}

module.exports = { attachServiceWorkerNotifications, CHANNEL };
