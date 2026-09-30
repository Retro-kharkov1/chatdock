'use strict';

// BUG-01 net, notification bridge (FR-05a, FR-11, FR-12) - src/main/notifications.js
// buildNotificationBridgeScript(). The real injected script is evaluated in a vm page stand-in
// (test/helpers/pageHarness.js).
//
//   Section 1  GREEN  characterization of the working window.Notification path.
//   Section 2  GREEN  robustness that must hold before and after the fix.
//   Section 3  required behaviour: the same mute/sound rules on the page-realm
//              ServiceWorkerRegistration.showNotification path (BUG-01-B). The three
//              "[CHAR BUG-01-B]" tests that pinned the bug were retired when the fix landed.
//   Calls made by Chat's own service worker never pass through the page realm; they are handled
//   by src/preload/serviceWorkerPreload.js + src/main/serviceWorkerNotifications.js
//   (test/serviceWorkerNotifications.test.js, test/nativeToast.test.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPage } = require('./helpers/pageHarness');
const { pending } = require('./helpers/pending');
const { attachUnreadTitleListener } = require('../src/main/notifications.js');
const { EventEmitter } = require('node:events');

const TITLE = 'Olena';

// Guards RED tests against passing vacuously on the unpatched code: the wrapper must be engaged.
function assertSwWrapped(page) {
  assert.notEqual(page.currentShowNotification(), page.originalShowNotification);
}
const BODY = 'Hi there';

// --- Section 1: window.Notification path (works today) --------------------------------------

test('Notification path: the bridge replaces window.Notification', () => {
  const page = createPage();
  page.inject(true, false);
  assert.notEqual(page.windowNotification, page.FakeNotification);
});

test('Notification path: unmuted + sound on delegates to the native constructor, not silent, content preserved', () => {
  const page = createPage();
  page.inject(true, false);
  page.newNotification(TITLE, { body: BODY, tag: 'space/abc', data: { k: 1 } });
  assert.equal(page.record.nativeNotifications.length, 1);
  const native = page.record.nativeNotifications[0];
  assert.equal(native.title, TITLE);
  assert.equal(native.options.body, BODY);
  assert.equal(native.options.tag, 'space/abc');
  assert.deepEqual(native.options.data, { k: 1 });
  assert.equal(native.options.silent, false);
});

test('Notification path (FR-11): sound off forces silent:true', () => {
  const page = createPage();
  page.inject(false, false);
  page.newNotification(TITLE, { body: BODY });
  assert.equal(page.record.nativeNotifications[0].options.silent, true);
});

test('Notification path (FR-11): the page own silent:true is kept when sound is on', () => {
  const page = createPage();
  page.inject(true, false);
  page.newNotification(TITLE, { silent: true });
  assert.equal(page.record.nativeNotifications[0].options.silent, true);
});

test('Notification path (FR-12): muted never constructs a native notification', () => {
  const page = createPage();
  page.inject(true, true);
  page.newNotification(TITLE, { body: BODY });
  assert.equal(page.record.nativeNotifications.length, 0);
});

test('Notification path (FR-12): muted returns a stub that page code can call without throwing', () => {
  const page = createPage();
  page.inject(true, true);
  const stub = page.newNotification(TITLE, {});
  assert.doesNotThrow(() => {
    stub.close();
    stub.addEventListener('click', () => {});
    stub.removeEventListener('click', () => {});
  });
});

test('Notification path (FR-05c step 1): a click on the native toast reaches window.__gcdBridge.notificationClicked', () => {
  const page = createPage();
  page.inject(true, false);
  page.newNotification(TITLE, {});
  page.record.nativeNotifications[0].fireClick();
  assert.equal(page.record.bridgeClicks, 1);
});

test('Notification path: the page own click listeners are not blocked by the bridge listener', () => {
  const page = createPage();
  page.inject(true, false);
  const n = page.newNotification(TITLE, {});
  let pageHandlerRan = false;
  n.addEventListener('click', () => {
    pageHandlerRan = true;
  });
  page.record.nativeNotifications[0].fireClick();
  assert.equal(pageHandlerRan, true);
  assert.equal(page.record.bridgeClicks, 1);
});

test('Notification path: injecting twice does not double-wrap (one native toast per call)', () => {
  const page = createPage();
  page.inject(true, false);
  page.inject(true, false);
  page.newNotification(TITLE, {});
  assert.equal(page.record.nativeNotifications.length, 1);
});

test('Notification path: re-injecting new flags takes effect live (mute toggled after first injection)', () => {
  const page = createPage();
  page.inject(true, false);
  page.newNotification(TITLE, {});
  page.inject(true, true);
  page.newNotification(TITLE, {});
  assert.equal(page.record.nativeNotifications.length, 1);
});

test('Notification path: Notification.permission and requestPermission are preserved', async () => {
  const page = createPage();
  page.inject(true, false);
  assert.equal(page.windowNotification.permission, 'granted');
  assert.equal(await page.windowNotification.requestPermission(), 'granted');
});

// --- Section 2: robustness (must stay green after the fix) ----------------------------------

test('robustness: the bridge does not throw in a page without ServiceWorkerRegistration', () => {
  const page = createPage({ withServiceWorker: false });
  assert.doesNotThrow(() => page.inject(true, false));
});

test('robustness: a script with hostile-looking flag values is still a valid boolean-literal script', () => {
  const page = createPage();
  assert.doesNotThrow(() => page.inject('yes', 0));
});

// --- Title-change fallback input (FR-05 unread state; FR-14 degraded trigger input) ---------

test('title listener: every page-title-updated event reports the parsed unread count', () => {
  const wc = new EventEmitter();
  const seen = [];
  attachUnreadTitleListener(wc, (n) => seen.push(n));
  wc.emit('page-title-updated', {}, '(2) Google Chat');
  wc.emit('page-title-updated', {}, '(5) Google Chat');
  wc.emit('page-title-updated', {}, 'Google Chat');
  assert.deepEqual(seen, [2, 5, 0]);
});

test('title listener: an unchanged count is still reported (the consumer must not assume deduplication)', () => {
  const wc = new EventEmitter();
  const seen = [];
  attachUnreadTitleListener(wc, (n) => seen.push(n));
  wc.emit('page-title-updated', {}, '(2) Google Chat');
  wc.emit('page-title-updated', {}, '(2) Google Chat');
  assert.deepEqual(seen, [2, 2]);
});

// --- Section 3: service-worker path in the PAGE realm (BUG-01-B, review F4) ------------------
// Policy (same as the service-worker preload): the request is forwarded to the main process, which
// raises the real toast; the ORIGINAL showNotification is NOT called (Electron shows nothing for
// it, and calling both would double up if that ever changes). The original is only called as a
// fallback when forwarding is impossible (no bridge method / the bridge throws). Chat's own
// service worker never passes through this realm - see serviceWorkerPreload.js. The QA tests that
// asserted "the original is called" were rewritten for this policy (see the BUG-01 report, F4).

pending('SW path: the bridge wraps ServiceWorkerRegistration.prototype.showNotification', () => {
  const page = createPage();
  page.inject(true, false);
  assert.notEqual(page.currentShowNotification(), page.originalShowNotification);
});

pending('SW path (FR-05a): unmuted + sound on hands ONE request to main - title, body, tag preserved, not silent - and does not call the original', async () => {
  const page = createPage();
  page.inject(true, false);
  await page.showViaServiceWorker(TITLE, { body: BODY, tag: 'space/abc', data: { url: '/chat/x' } });
  assert.deepEqual(JSON.parse(JSON.stringify(page.record.bridgeShows)), [
    { title: TITLE, body: BODY, silent: false, tag: 'space/abc' },
  ]);
  assert.equal(page.record.swShowCalls.length, 0);
});

pending('SW path (FR-12): muted suppresses entirely - nothing reaches main and the original is never called', async () => {
  const page = createPage();
  page.inject(true, true);
  await page.showViaServiceWorker(TITLE, { body: BODY });
  assert.equal(page.record.bridgeShows.length, 0);
  assert.equal(page.record.swShowCalls.length, 0);
});

pending('SW path (FR-12): muted still returns a promise that resolves, so page code awaiting it does not break', async () => {
  const page = createPage();
  page.inject(true, true);
  const result = page.showViaServiceWorker(TITLE, {});
  assert.equal(typeof result.then, 'function');
  await result;
  assertSwWrapped(page);
});

pending('SW path: the returned promise resolves when forwarded to main', async () => {
  const page = createPage();
  page.inject(true, false);
  const result = page.showViaServiceWorker(TITLE, {});
  assert.equal(typeof result.then, 'function');
  await result;
  assertSwWrapped(page);
});

pending('SW path (FR-11): sound off forces silent:true in the request', async () => {
  const page = createPage();
  page.inject(false, false);
  await page.showViaServiceWorker(TITLE, { body: BODY });
  assert.equal(page.record.bridgeShows[0].silent, true);
});

pending('SW path (FR-11): the page own silent:true is kept when sound is on', async () => {
  const page = createPage();
  page.inject(true, false);
  await page.showViaServiceWorker(TITLE, { silent: true });
  assertSwWrapped(page);
  assert.equal(page.record.bridgeShows[0].silent, true);
});

pending('SW path: called with no options object is treated as {} (sound on -> silent:false, empty body and tag)', async () => {
  const page = createPage();
  page.inject(true, false);
  await page.showViaServiceWorker(TITLE, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(page.record.bridgeShows[0])), {
    title: TITLE,
    body: '',
    silent: false,
    tag: '',
  });
});

pending('SW path: injecting twice does not double-wrap (one request per call)', async () => {
  const page = createPage();
  page.inject(true, false);
  page.inject(true, false);
  await page.showViaServiceWorker(TITLE, {});
  assertSwWrapped(page);
  assert.equal(page.record.bridgeShows.length, 1);
  assert.equal(page.record.swShowCalls.length, 0);
});

pending('SW path: re-injected flags take effect live (mute on after first injection)', async () => {
  const page = createPage();
  page.inject(true, false);
  await page.showViaServiceWorker(TITLE, {});
  page.inject(true, true);
  await page.showViaServiceWorker(TITLE, {});
  assert.equal(page.record.bridgeShows.length, 1);
});

pending('SW path fallback: with no main-process bridge method the ORIGINAL is called, real registration as receiver, silent resolved', async () => {
  const page = createPage();
  page.inject(false, false);
  delete page.bridge.notificationShow; // e.g. an older preload without the new method
  await page.showViaServiceWorker(TITLE, { body: BODY });
  assert.equal(page.record.swShowCalls.length, 1);
  assert.equal(page.record.swShowCalls[0].receiver, page.registration);
  assert.equal(page.record.swShowCalls[0].options.silent, true);
});

pending('SW path fallback: a throwing bridge falls back to the original instead of losing the notification', async () => {
  const page = createPage();
  page.inject(true, false);
  page.bridge.notificationShow = () => { throw new Error('ipc gone'); };
  await page.showViaServiceWorker(TITLE, {});
  assert.equal(page.record.swShowCalls.length, 1);
});

pending('both paths coexist: muted suppresses window.Notification AND the SW path together', async () => {
  const page = createPage();
  page.inject(true, true);
  page.newNotification(TITLE, {});
  await page.showViaServiceWorker(TITLE, {});
  assert.equal(page.record.nativeNotifications.length, 0);
  assert.equal(page.record.swShowCalls.length, 0);
  assert.equal(page.record.bridgeShows.length, 0);
});

pending('Notification path (FR-14): a native toast the page made is reported to main as an arrival', () => {
  const page = createPage();
  page.inject(true, false);
  page.newNotification(TITLE, {});
  assert.equal(page.record.bridgeArrivals, 1);
});

pending('Notification path (FR-12): muted reports no arrival', () => {
  const page = createPage();
  page.inject(true, true);
  page.newNotification(TITLE, {});
  assert.equal(page.record.bridgeArrivals, 0);
});
