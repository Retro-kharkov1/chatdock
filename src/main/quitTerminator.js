'use strict';

// Quit-hang fix (docs/architecture/meet-call-window.md section 8, "Risk to watch"; maintainer decision
// 2026-10-02). On Windows, with the desktop-Chrome UA set and a Google page loaded, the main process
// can stay alive after app.quit() has run to completion. The remedy is to flush persisted state and
// then force-terminate. Sequence:
//
//   will-quit #1 : preventDefault, flush every flusher concurrently (bounded by timeoutMs), then
//                  requestQuit() (app.quit()) again.
//   will-quit #2 : let through.
//   quit         : terminate() - only if the flush phase completed.
//
// Electron does not emit before-quit/will-quit/quit on Windows when the OS shuts down or the user logs
// off (https://www.electronjs.org/docs/latest/api/app), so this never runs on that path; onSessionEnd
// (BrowserWindow 'session-end') additionally disables the terminate in case a quit is requested later.
// Nothing here ever reads or logs cookie/storage contents: the log gets the flusher name and the
// error message only.

const DEFAULT_TIMEOUT_MS = 3000;

function createQuitTerminator({
  flushers = [],
  timers = { setTimeout, clearTimeout },
  timeoutMs = DEFAULT_TIMEOUT_MS,
  requestQuit,
  terminate,
  log = () => {},
} = {}) {
  let state = 'idle'; // idle -> flushing -> flushed
  let sessionEnded = false;

  function runOne(f) {
    return new Promise((resolve) => {
      try {
        Promise.resolve(f.run()).then(resolve, (err) => {
          log(`[gcd] quit flush "${f.name}" failed: ${err && err.message}`);
          resolve();
        });
      } catch (err) {
        log(`[gcd] quit flush "${f.name}" failed: ${err && err.message}`);
        resolve();
      }
    });
  }

  function flushAll() {
    return new Promise((resolve) => {
      let timer = timers.setTimeout(() => {
        timer = null;
        log(`[gcd] quit flush timed out after ${timeoutMs} ms; continuing`);
        resolve();
      }, timeoutMs);
      Promise.all(flushers.map(runOne)).then(() => {
        if (timer !== null) {
          timers.clearTimeout(timer);
          timer = null;
        }
        resolve();
      });
    });
  }

  return {
    onWillQuit(event) {
      if (state === 'flushed') return;
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      if (state === 'flushing') return;
      state = 'flushing';
      flushAll().then(() => {
        state = 'flushed';
        requestQuit();
      });
    },

    onQuit() {
      if (state !== 'flushed' || sessionEnded) return;
      terminate();
    },

    onSessionEnd() {
      sessionEnded = true;
    },
  };
}

/** The persisted-state flushers of one session (the app's persistent partition). */
function sessionFlushers(ses) {
  return [
    { name: 'cookies', run: () => ses.cookies.flushStore() },
    { name: 'storage', run: () => ses.flushStorageData() },
  ];
}

module.exports = { createQuitTerminator, sessionFlushers, DEFAULT_TIMEOUT_MS };
