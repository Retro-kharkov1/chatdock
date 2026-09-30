'use strict';

// Runs the REAL script produced by buildNotificationBridgeScript() inside a node:vm context that
// stands in for Google Chat's page main world: a fake `window.Notification`, a fake
// `ServiceWorkerRegistration` (the API Chat is believed to use for its real notifications) and a
// fake `window.__gcdBridge`. No Electron, no mocks of the code under test - the injected string is
// evaluated exactly as `webContents.executeJavaScript()` would evaluate it.

const vm = require('node:vm');
const { buildNotificationBridgeScript } = require('../../src/main/notifications.js');

function createPage({ withServiceWorker = true } = {}) {
  const sandbox = {};
  sandbox.window = sandbox; // page code sees `window === globalThis`

  const record = {
    nativeNotifications: [], // every instance the ORIGINAL Notification constructor produced
    swShowCalls: [], // every call that reached the ORIGINAL showNotification
    bridgeClicks: 0,
    bridgeArrivals: 0,
    bridgeShows: [], // payloads handed to the main process (page-initiated SW notifications)
  };

  class FakeNotification {
    constructor(title, options) {
      this.title = title;
      this.options = options;
      this.listeners = {};
      record.nativeNotifications.push(this);
    }
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    }
    removeEventListener() {}
    close() {}
    /** Simulates the OS reporting a click on the toast. */
    fireClick() {
      (this.listeners.click || []).forEach((fn) => fn({ type: 'click' }));
    }
  }
  FakeNotification.permission = 'granted';
  FakeNotification.requestPermission = () => Promise.resolve('granted');
  sandbox.Notification = FakeNotification;

  let originalShowNotification = null;
  const registration = {};
  if (withServiceWorker) {
    class FakeServiceWorkerRegistration {
      showNotification(title, options) {
        record.swShowCalls.push({ title, options, receiver: this });
        return Promise.resolve();
      }
    }
    originalShowNotification = FakeServiceWorkerRegistration.prototype.showNotification;
    sandbox.ServiceWorkerRegistration = FakeServiceWorkerRegistration;
    registration.instance = new FakeServiceWorkerRegistration();
  }

  sandbox.__gcdBridge = {
    notificationClicked() {
      record.bridgeClicks += 1;
    },
    notificationArrived() {
      record.bridgeArrivals += 1;
    },
    notificationShow(payload) {
      record.bridgeShows.push(payload);
    },
  };

  vm.createContext(sandbox);

  return {
    record,
    bridge: sandbox.__gcdBridge,
    FakeNotification,
    registration: registration.instance,
    originalShowNotification,
    /** Same as the app's injectNotificationBridge(): evaluate the real script in the page. */
    inject(soundEnabled, muted) {
      vm.runInContext(buildNotificationBridgeScript(soundEnabled, muted), sandbox);
    },
    /** `new Notification(...)` as page code would write it. */
    newNotification(title, options) {
      return new sandbox.Notification(title, options);
    },
    /** `registration.showNotification(...)` as page code would write it. */
    showViaServiceWorker(title, options) {
      return registration.instance.showNotification(title, options);
    },
    currentShowNotification() {
      return sandbox.ServiceWorkerRegistration.prototype.showNotification;
    },
    get windowNotification() {
      return sandbox.Notification;
    },
  };
}

module.exports = { createPage };
