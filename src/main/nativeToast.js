'use strict';

// FR-05a / FR-11 / FR-12: the main-process side of "a native toast must appear".
//
// Why this exists (BUG-01-B, verified on Electron 44.4.3 / Windows 11 by reading the OS toast
// store, wpndatabase.db): Chromium's page `new Notification()` produces a real toast, but
// `ServiceWorkerRegistration.showNotification()` - whether called from the page OR from Chat's
// service worker itself - produces NOTHING. So those calls are intercepted (page: notifications.js
// bridge; service worker: serviceWorkerNotifications.js + preload/serviceWorkerPreload.js) and
// re-raised here as a main-process Electron `Notification`. Mute / sound rules live here, next to
// `settingsStore`, so they cannot drift from the settings.
//
// POLICY, identical on both interception paths: the request is forwarded to this service and the
// ORIGINAL showNotification is NOT called. It shows nothing in Electron, and calling both would
// double up if Electron ever fixes it. The original is called only as a fallback when forwarding
// is impossible (bridge missing / throwing), so a notification is never silently lost.
// TRADE-OFF (recorded for the docs): because the original is not called, the browser never owns
// the notification, so the worker's `notificationclick` handler and `registration.getNotifications()`
// see nothing. BUG-05 closes that gap: the request keeps Chat's `data` and the worker scope, and
// index.js replays a `notificationclick` into that worker on click (serviceWorkerNotifications.js).
//
// One path per message: the unread-count fallback below only fires when no interceptor reported
// an arrival for that increase. Everything Electron-shaped is injected (test/nativeToast.test.js).

const MAX_TITLE = 200;
const MAX_BODY = 1000;
const MAX_TAG = 100;
const MAX_TRACKED_TAGS = 50;
const MAX_DATA_JSON = 16384; // BUG-05: notification `data` kept for the click replay (in memory only)

/**
 * BUG-05: Chat attaches `data` to its notification for its own worker `notificationclick` handler.
 * It is kept (as a plain-JSON clone, capped) so the click can be replayed there. Returns
 * undefined for anything absent, not JSON-safe, circular or oversized. The content is never logged.
 */
function cloneData(value) {
  if (value === undefined || value === null) return undefined;
  try {
    const json = JSON.stringify(value);
    if (typeof json !== 'string' || json.length > MAX_DATA_JSON) return undefined;
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

/**
 * Some Linux notification servers render markup (b, i, u, a, img) in the body. Web content is
 * untrusted, so tag-like markup is removed and any remaining angle bracket is replaced by a
 * look-alike that cannot start a tag - the text stays readable.
 */
function stripMarkup(text, max) {
  // Cap BEFORE the regex: `<\/?[A-Za-z!?][^>]*>` is quadratic on "<a<a<a..." with no ">", which
  // would stall the main process on a large payload. 2x the final cap keeps the result correct
  // (markup removal only shortens) while bounding the work.
  return text
    .slice(0, max * 2)
    .replace(/<\/?[A-Za-z!?][^>]*>/g, '')
    .replace(/</g, '‹')
    .replace(/>/g, '›');
}

/**
 * Validates and normalises an untrusted toast request from a renderer / service worker. Never
 * throws; returns null for anything without a usable title.
 * @param {unknown} raw
 * @returns {{title: string, body: string, silent: boolean, tag: string}|null}
 */
function sanitizeToastRequest(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = typeof raw.title === 'string' ? stripMarkup(raw.title, MAX_TITLE).trim() : '';
  if (!title) return null;
  const request = {
    title: title.slice(0, MAX_TITLE),
    body: typeof raw.body === 'string' ? stripMarkup(raw.body, MAX_BODY).slice(0, MAX_BODY) : '',
    silent: raw.silent === true,
    tag: typeof raw.tag === 'string' ? raw.tag.slice(0, MAX_TAG) : '',
  };
  const data = cloneData(raw.data);
  if (data !== undefined) request.data = data;
  return request;
}

/**
 * @param {object} deps
 * @param {(req: {title: string, body: string, silent: boolean, tag?: string}) => ({close?: () => void}|void)} deps.showNativeToast
 *   Creates + shows the OS toast (wires click -> focus in index.js). May return a handle with
 *   `close()`, which is what lets a same-tag toast REPLACE the previous one.
 * @param {() => boolean} deps.getMuted
 * @param {() => boolean} deps.getSoundEnabled
 * @param {() => boolean} deps.isWindowFocused
 * @param {() => void} deps.onArrival Feeds the attention controller (FR-14 preferred trigger).
 * @param {() => number} [deps.now]
 * @param {(fn: () => void, ms: number) => unknown} [deps.setTimer]
 * @param {number} [deps.fallbackDelayMs] How long an unread increase waits for a real arrival
 *   report before the generic fallback toast is raised.
 * @param {number} [deps.arrivalMatchMs] An arrival this recent BEFORE an increase is taken to be
 *   that increase's message (the toast usually precedes the title update by 50-300 ms).
 * @param {number} [deps.dedupeMs] Identical title+body inside this window = double delivery.
 * @param {number} [deps.maxPerWindow] Toast rate limit (S2)...
 * @param {number} [deps.rateWindowMs] ...per this window; the excess is coalesced into one summary.
 */
function createToastService({
  showNativeToast,
  getMuted,
  getSoundEnabled,
  isWindowFocused,
  onArrival,
  now = Date.now,
  setTimer = setTimeout,
  fallbackDelayMs = 2500,
  arrivalMatchMs = 5000,
  dedupeMs = 200,
  maxPerWindow = 3,
  rateWindowMs = 1000,
}) {
  let lastUnread = 0;
  let fallbackPending = false;
  let arrivals = []; // timestamps of arrivals not yet matched to an unread increase
  let lastKey = null;
  let lastKeyAt = 0;
  let recentShown = [];
  let coalesced = 0;
  let flushPending = false;
  const tagged = new Map(); // tag -> handle of the toast currently on screen for it

  function recordArrival() {
    const t = now();
    arrivals = arrivals.filter((at) => t - at <= arrivalMatchMs); // D3: prune by age on every arrival
    arrivals.push(t);
  }

  /** Displays one toast; a same-tag toast replaces (closes) the previous one instead of stacking. */
  function display(request) {
    const { tag } = request;
    if (tag) {
      const previous = tagged.get(tag);
      if (previous && typeof previous.close === 'function') {
        try {
          previous.close();
        } catch {
          // already gone
        }
      }
      tagged.delete(tag);
    }
    const handle = showNativeToast(request);
    if (tag && handle) {
      tagged.set(tag, handle);
      if (tagged.size > MAX_TRACKED_TAGS) tagged.delete(tagged.keys().next().value);
    }
  }

  function flushCoalesced() {
    flushPending = false;
    const count = coalesced;
    coalesced = 0;
    if (count === 0 || getMuted()) return;
    display({
      title: 'Google Chat',
      body: count === 1 ? '1 more notification' : `${count} more notifications`,
      silent: !getSoundEnabled(),
      tag: '',
    });
  }

  function raise(request) {
    if (getMuted()) return false; // FR-12: suppressed entirely.
    const t = now();
    recentShown = recentShown.filter((at) => t - at < rateWindowMs);
    if (recentShown.length >= maxPerWindow) {
      coalesced += 1; // S2: excess is summarised, not dropped silently and not spammed
      if (!flushPending) {
        flushPending = true;
        setTimer(flushCoalesced, rateWindowMs);
      }
      return false;
    }
    recentShown.push(t);
    display({ ...request, silent: request.silent || !getSoundEnabled() }); // FR-11
    return true;
  }

  return {
    /**
     * An intercepted notification: re-raise it natively. Counts as an arrival even when muted
     * (the attention controller applies the mute rule itself).
     * @param {unknown} raw
     * @param {{scope?: string}} [source] Where it came from, set by the trusted transport (never by
     *   the payload): the service-worker scope that the click is replayed into (BUG-05).
     * @returns {boolean} whether a toast was shown
     */
    show(raw, source) {
      const request = sanitizeToastRequest(raw);
      if (!request) return false;
      if (source && typeof source.scope === 'string') request.scope = source.scope;
      const t = now();
      const key = `${request.title}\u0000${request.body}`;
      if (key === lastKey && t - lastKeyAt < dedupeMs) return false; // F5: double delivery
      lastKey = key;
      lastKeyAt = t;
      recordArrival();
      const shown = raise(request);
      onArrival();
      return shown;
    },

    /** The page created its own native toast (window.Notification path): only note the arrival. */
    noteArrival() {
      recordArrival();
      onArrival();
    },

    /** Test hook: number of arrivals not yet matched to an unread increase. */
    _pendingArrivals: () => arrivals.length,

    /** Settled unread count (baseline, decrease, confirmed zero) - from unreadTracker. */
    onUnreadObserve(count) {
      lastUnread = Number.isFinite(count) && count > 0 ? count : 0;
    },

    /**
     * A real rise above the unread baseline (from unreadTracker). Unread-count fallback (M3, the
     * documented floor): raise one generic toast unless a real arrival explains this increase -
     * either one that already happened within `arrivalMatchMs` (consumed here, one arrival matches
     * one increase) or one that turns up within `fallbackDelayMs`. Content is generic by necessity
     * (FR-05b is not met on this path).
     */
    onUnreadIncrease(count) {
      lastUnread = Number.isFinite(count) && count > 0 ? count : 0;
      const t = now();
      arrivals = arrivals.filter((at) => t - at <= arrivalMatchMs);
      if (arrivals.length > 0) {
        arrivals.shift();
        return;
      }
      if (fallbackPending) return;
      fallbackPending = true;
      const increaseAt = t;
      setTimer(() => {
        fallbackPending = false;
        const idx = arrivals.findIndex((at) => at >= increaseAt);
        if (idx !== -1) {
          arrivals.splice(idx, 1); // explained by a real arrival after all
          return;
        }
        if (isWindowFocused() || lastUnread === 0) return;
        raise({
          title: 'Google Chat',
          body: lastUnread === 1 ? '1 unread message' : `${lastUnread} unread messages`,
          silent: false,
          tag: '',
        });
      }, fallbackDelayMs);
    },
  };
}

module.exports = { sanitizeToastRequest, createToastService, MAX_TITLE, MAX_BODY };
