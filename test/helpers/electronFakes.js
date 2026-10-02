'use strict';

// UI-01 coverage-first net: stubbed Electron objects for the Meet call window tests. No GUI, no
// Electron runtime - plain objects and EventEmitters that mimic exactly the surface the architecture
// doc (docs/architecture/meet-call-window.md) says the modules touch.
//
// The fakes model the Electron behaviours the design depends on (Spike B, ADR-0004):
//   * `win.close()` emits a cancellable 'close' event. If it is not prevented, the page's
//     `beforeunload` is "run": pageBehavior 'none' -> the window is destroyed; 'objects' -> the
//     contents emit 'will-prevent-unload' and the window is destroyed ONLY if a listener called
//     `event.preventDefault()` (the override); 'hang' -> the page never answers.
//   * `win.destroy()` emits 'closed' but never 'close' (as in Electron).
//   * Any call on a destroyed window throws, like Electron's "Object has been destroyed".

const { EventEmitter } = require('node:events');

/** settle(): let queued promise callbacks (dialog answers, picker answers) run. */
function settle() {
  return new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
}

/** A manual clock that is injected as { setTimeout, clearTimeout }; tick(ms) fires due timers in order. */
function createManualClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    tick(ms) {
      const target = now + ms;
      for (;;) {
        let dueId = null;
        let due = null;
        for (const [id, t] of timers) {
          if (t.at <= target && (due === null || t.at < due.at)) {
            dueId = id;
            due = t;
          }
        }
        if (due === null) break;
        timers.delete(dueId);
        now = due.at;
        due.fn();
      }
      now = target;
    },
    pending() {
      return timers.size;
    },
  };
}

function makeEvent(extra = {}) {
  return {
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    ...extra,
  };
}

let nextContentsId = 100;

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.id = nextContentsId++;
    this.url = '';
    this.destroyed = false;
    this.loadCalls = [];
    this.reloadCalls = 0;
    this.windowOpenHandler = null;
  }

  getURL() {
    return this.url;
  }

  loadURL(url) {
    this._alive();
    this.loadCalls.push(url);
    this.url = url;
    return Promise.resolve();
  }

  reload() {
    this._alive();
    this.reloadCalls += 1;
  }

  setWindowOpenHandler(fn) {
    this.windowOpenHandler = fn;
  }

  isDestroyed() {
    return this.destroyed;
  }

  _alive() {
    if (this.destroyed) throw new Error('Object has been destroyed');
  }

  // --- test drivers --------------------------------------------------------------------------

  /** Simulate Meet calling window.open(url): returns the handler's decision. */
  windowOpen(url) {
    return this.windowOpenHandler({ url, frameName: '', features: '', disposition: 'new-window' });
  }

  /** Emit a main-frame (default) or sub-frame will-navigate / will-redirect; returns the event. */
  navigate(url, { type = 'will-navigate', isMainFrame = true } = {}) {
    const event = makeEvent({ url, isMainFrame });
    this.emit(type, event, url, false, isMainFrame);
    return event;
  }

  /** Emit the page's beforeunload objection (Chromium -> will-prevent-unload); returns the event. */
  objectToUnload() {
    const event = makeEvent();
    this.emit('will-prevent-unload', event);
    return event;
  }

  /** Emit render-process-gone. */
  crash(reason = 'crashed') {
    this.emit('render-process-gone', makeEvent(), { reason, exitCode: 1 });
  }
}

/**
 * createFakeBrowserWindowClass() -> class with static `instances`. `pageBehavior` on the CLASS sets the
 * default for new windows ('none' | 'objects' | 'hang'); set it per instance to change it later.
 */
function createFakeBrowserWindowClass() {
  class FakeBrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new FakeWebContents();
      this.pageBehavior = FakeBrowserWindow.pageBehavior;
      this.destroyed = false;
      this.minimized = false;
      this.visible = true;
      this.calls = [];
      this.closeCalls = 0;
      this.destroyCalls = 0;
      FakeBrowserWindow.instances.push(this);
    }

    _alive() {
      if (this.destroyed) throw new Error('Object has been destroyed');
    }

    _call(name) {
      this._alive();
      this.calls.push(name);
    }

    count(name) {
      return this.calls.filter((c) => c === name).length;
    }

    loadURL(url) {
      this._alive();
      return this.webContents.loadURL(url);
    }

    /** Local bundled file (the picker only; the Meet window must never call this). */
    loadFile(filePath) {
      this._alive();
      this.loadFileCalls = (this.loadFileCalls || []).concat(filePath);
      return Promise.resolve();
    }

    isDestroyed() {
      return this.destroyed;
    }

    isMinimized() {
      this._alive();
      return this.minimized;
    }

    isVisible() {
      this._alive();
      return this.visible;
    }

    restore() {
      this._call('restore');
      this.minimized = false;
    }

    show() {
      this._call('show');
      this.visible = true;
    }

    hide() {
      this._call('hide');
      this.visible = false;
    }

    focus() {
      this._call('focus');
    }

    moveTop() {
      this._call('moveTop');
    }

    flashFrame() {
      this._call('flashFrame');
    }

    setAlwaysOnTop() {
      this._call('setAlwaysOnTop');
    }

    /** What the OS does on X / Alt+F4 / taskbar close, and what win.close() does. */
    close() {
      this._alive();
      this.closeCalls += 1;
      const event = makeEvent();
      this.emit('close', event);
      if (event.defaultPrevented) return;
      if (this.pageBehavior === 'objects') {
        const unload = makeEvent();
        this.webContents.emit('will-prevent-unload', unload);
        if (unload.defaultPrevented) this.destroy();
        return;
      }
      if (this.pageBehavior === 'hang') return;
      this.destroy();
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.destroyCalls += 1;
      this.webContents.destroyed = true;
      this.emit('closed');
    }
  }
  FakeBrowserWindow.instances = [];
  FakeBrowserWindow.pageBehavior = 'none';
  return FakeBrowserWindow;
}

/** createFakeNotificationClass() -> class with static `instances`; `.click()` simulates a user click. */
function createFakeNotificationClass() {
  class FakeNotification extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.shown = 0;
      FakeNotification.instances.push(this);
    }

    show() {
      this.shown += 1;
    }

    close() {}

    click() {
      this.emit('click');
    }
  }
  FakeNotification.instances = [];
  return FakeNotification;
}

/**
 * createDialogFake({ honorSignal }) -> { showMessageBox, calls, open() , answer(call, label), textOf(call) }
 * showMessageBox(parent, options) mirrors dialog.showMessageBox(parentWindow, options): it returns a
 * promise resolving { response, checkboxChecked }. An open box stays open until answered by the test.
 * honorSignal true (default): aborting options.signal resolves the box with options.cancelId (what
 * Electron documents). honorSignal false: abort does nothing (the fallback path in section 8).
 */
function createDialogFake({ honorSignal = true } = {}) {
  const calls = [];
  function showMessageBox(parent, options) {
    const call = { parent, options, settled: false, response: undefined };
    call.promise = new Promise((resolve) => {
      call.resolve = (response) => {
        if (call.settled) return;
        call.settled = true;
        call.response = response;
        resolve({ response, checkboxChecked: false });
      };
    });
    if (options && options.signal && honorSignal) {
      options.signal.addEventListener('abort', () => call.resolve(options.cancelId), { once: true });
    }
    calls.push(call);
    return call.promise;
  }
  return {
    showMessageBox,
    calls,
    open: () => calls.filter((c) => !c.settled),
    /** Answer a box by its button label (exact). */
    answer: (call, label) => call.resolve(call.options.buttons.indexOf(label)),
    /** All human-readable text of a box (title + message + detail) for tolerant wording checks. */
    textOf: (call) => [call.options.title, call.options.message, call.options.detail].filter(Boolean).join(' '),
    /** True when the box was created with an AbortSignal that has been aborted. */
    aborted: (call) => Boolean(call.options.signal && call.options.signal.aborted),
  };
}

/** createPickerStub() -> the minimal picker surface the call window manager uses (section 7). */
function createPickerStub() {
  const stub = {
    open: false,
    raised: 0,
    flashed: 0,
    isOpen: () => stub.open,
    raise: () => { stub.raised += 1; },
    flash: () => { stub.flashed += 1; },
  };
  return stub;
}

const MEET_ORIGIN = 'https://meet.google.com';
const ACCOUNTS_ORIGIN = 'https://accounts.google.com';
const MEET_URL = 'https://meet.google.com/abc-defg-hij';
const MEET_URL_2 = 'https://meet.google.com/xyz-uvwx-rst';

module.exports = {
  settle,
  createManualClock,
  makeEvent,
  FakeWebContents,
  createFakeBrowserWindowClass,
  createFakeNotificationClass,
  createDialogFake,
  createPickerStub,
  MEET_ORIGIN,
  ACCOUNTS_ORIGIN,
  MEET_URL,
  MEET_URL_2,
};
