'use strict';

// BUG-05: where a URL requested by a replayed notification click goes. Pure factory, every
// collaborator injected, no Electron import.
//
// In Chrome, Chat's service worker answers a notification click with clients.openWindow(url) or
// client.focus()/navigate(). A replayed click cannot make those calls natively, so the worker
// preload hands the URL to main and it lands here:
//   - an exact Chat origin (https://chat.google.com, no userinfo) opens in the app's own window;
//   - everything else goes through the one link router (Meet -> call window, http/https/mailto ->
//     system browser, other schemes dropped), so the scheme and Meet rules cannot be bypassed.
// The URL is never logged: it carries conversation ids.

function createNotificationOpener({ inAppOrigins, loadInApp, route, focus, log }) {
  function open(rawUrl, ctx) {
    if (typeof rawUrl !== 'string' || rawUrl === '') return;
    let url;
    try {
      url = new URL(rawUrl, ctx && typeof ctx.scope === 'string' ? ctx.scope : undefined);
    } catch {
      log('[gcd] notification click: unparseable URL ignored');
      return;
    }
    try {
      if (inAppOrigins.includes(url.origin) && url.username === '' && url.password === '') {
        loadInApp(url.href);
        focus();
        return;
      }
      route(url.href);
    } catch (err) {
      log('[gcd] notification click: opening failed', err && err.name);
    }
  }
  return { open };
}

module.exports = { createNotificationOpener };
