'use strict';

// UI-05 / FR-18, docs/architecture/smart-copy.md section 2 and 8 (row "Preload detector"),
// docs/architecture/ipc-contract.md (smartcopy:signal). The preload is loaded with a stubbed `electron`, `window`
// and `document` (the stub-load approach of test/pickerPreload.test.js). RED until src/preload/preload.js gains
// the detector.
//
// CONTRACT ASSUMED (the implementer may argue with it and then change the tests together, never silently):
//   * the detector registers capture-phase listeners on `window` for exactly 'mousedown' and 'mouseup';
//   * it reads `window.getSelection()` (rangeCount, isCollapsed, anchorNode/Offset, focusNode/Offset, toString())
//     and `document.activeElement` (following `.shadowRoot.activeElement` of open roots);
//   * element kind is read from the standard DOM surface only: tagName/localName, isContentEditable,
//     getAttribute('role'), parentElement, closest()/matches() with the selector list the design names;
//     the clicked element comes from event.composedPath()[0];
//   * a signal is ipcRenderer.send('smartcopy:signal', { kind: 'selection' }) and nothing else;
//   * nothing is exposed beyond the three __gcdBridge functions.
// The fake elements below implement closest()/matches() for tag, [attr], [attr=value] and comma lists, so either
// implementation style works against them.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const PRELOAD = path.join(__dirname, '..', 'src', 'preload', 'preload.js');

// --- minimal DOM ---------------------------------------------------------------------------------------------

function matchesSimple(el, sel) {
  const m = /^([a-z0-9]*)(?:\[([a-z-]+)(?:=["']?([^"'\]]*)["']?)?\])?$/i.exec(sel.trim());
  if (!m) return false;
  const [, tag, attr, value] = m;
  if (tag && el.localName !== tag.toLowerCase()) return false;
  if (attr) {
    const actual = el.getAttribute(attr);
    if (actual === null) return false;
    if (value !== undefined && actual !== value) return false;
  }
  return true;
}

function el(localName, { attrs = {}, parent = null, editable = false } = {}) {
  const node = {
    nodeType: 1,
    localName,
    tagName: localName.toUpperCase(),
    nodeName: localName.toUpperCase(),
    parentElement: parent,
    parentNode: parent,
    shadowRoot: null,
    _attrs: attrs,
    _editable: editable,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this._attrs, name) ? this._attrs[name] : null;
    },
    hasAttribute(name) {
      return this.getAttribute(name) !== null;
    },
    matches(selector) {
      return selector.split(',').some((s) => matchesSimple(this, s));
    },
    closest(selector) {
      for (let n = this; n; n = n.parentElement) if (n.matches(selector)) return n;
      return null;
    },
    contains(other) {
      for (let n = other; n; n = n.parentElement) if (n === this) return true;
      return false;
    },
  };
  Object.defineProperty(node, 'isContentEditable', {
    get() {
      for (let n = node; n; n = n.parentElement) if (n._editable) return true;
      return false;
    },
  });
  return node;
}

function text(parent) {
  return { nodeType: 3, nodeName: '#text', parentElement: parent, parentNode: parent };
}

// --- environment ---------------------------------------------------------------------------------------------

function withPreload(fn) {
  const exposed = [];
  const sent = [];
  const listeners = [];
  const state = { selection: null, activeElement: null };

  const electronStub = {
    contextBridge: { exposeInMainWorld: (name, api) => exposed.push({ name, api }) },
    ipcRenderer: {
      send: (...args) => sent.push(args),
      invoke: () => { throw new Error('the preload must not invoke'); },
      on: () => { throw new Error('the preload must not subscribe to channels'); },
    },
  };

  const body = el('body');
  const documentFake = {
    body,
    get activeElement() {
      return state.activeElement || body;
    },
  };
  const windowFake = {
    document: documentFake,
    location: { origin: 'https://chat.google.com' }, // the preload only runs its detector on the chat origin
    addEventListener: (type, listener, options) => listeners.push({ type, listener, options }),
    getSelection: () => state.selection,
  };

  const savedWindow = global.window;
  const savedDocument = global.document;
  global.window = windowFake;
  global.document = documentFake;
  const original = Module._load;
  Module._load = function patched(request, ...rest) {
    if (request === 'electron') return electronStub;
    return original.call(this, request, ...rest);
  };
  try {
    delete require.cache[PRELOAD];
    require(PRELOAD);
    const env = {
      exposed,
      sent,
      listeners,
      body,
      state,
      calls: { preventDefault: 0, stopPropagation: 0 },
      fire(type, init) {
        const target = init.target || body;
        const event = {
          type,
          isTrusted: true,
          button: 0,
          ctrlKey: false,
          altKey: false,
          metaKey: false,
          shiftKey: false,
          detail: 1,
          clientX: 100,
          clientY: 100,
          screenX: 100,
          screenY: 100,
          pageX: 100,
          pageY: 100,
          x: 100,
          y: 100,
          ...init,
          target,
          composedPath: () => [target],
          preventDefault: () => { env.calls.preventDefault += 1; },
          stopPropagation: () => { env.calls.stopPropagation += 1; },
          stopImmediatePropagation: () => { env.calls.stopPropagation += 1; },
        };
        for (const l of listeners.filter((x) => x.type === type)) {
          if (typeof l.listener === 'function') l.listener(event);
          else l.listener.handleEvent(event);
        }
        return event;
      },
      signals: () => sent.filter((a) => a[0] === 'smartcopy:signal'),
    };
    return fn(env);
  } finally {
    Module._load = original;
    delete require.cache[PRELOAD];
    if (savedWindow === undefined) delete global.window; else global.window = savedWindow;
    if (savedDocument === undefined) delete global.document; else global.document = savedDocument;
  }
}

function selectionOf(anchorNode, focusNode, str = 'some selected words', extra = {}) {
  return {
    rangeCount: 1,
    isCollapsed: false,
    anchorNode,
    anchorOffset: 0,
    focusNode,
    focusOffset: 4,
    toString: () => str,
    ...extra,
  };
}

/** A paragraph with plain text inside the page body. */
function paragraph(env) {
  const p = el('p', { parent: env.body });
  return { p, t: text(p) };
}

/**
 * Drive a gesture: `before` is the selection when the button goes down, `after` when it comes up.
 * `down`/`up` are event inits.
 */
function gesture(env, { before, after, down = {}, up = {} }) {
  env.state.selection = before;
  env.fire('mousedown', { ...down });
  env.state.selection = after;
  env.fire('mouseup', { ...up });
}

function dragged(env) {
  const { t } = paragraph(env);
  const old = selectionOf(t, t, 'old', { anchorOffset: 0, focusOffset: 1 });
  const next = selectionOf(t, t, 'some selected words', { anchorOffset: 2, focusOffset: 9 });
  return { t, old, next };
}

const DRAG_UP = { clientX: 160, screenX: 160, pageX: 160, x: 160 };

// --- registration and exposed surface -------------------------------------------------------------------------

test('preload: registers capture-phase mousedown and mouseup on window, and nothing else', () => {
  withPreload((env) => {
    assert.deepEqual(env.listeners.map((l) => l.type).sort(), ['mousedown', 'mouseup']);
    for (const l of env.listeners) {
      const capture = l.options === true || (l.options && l.options.capture === true);
      assert.equal(capture, true, l.type + ' is a capture listener');
    }
  });
});

test('preload: the exposed surface is unchanged (__gcdBridge with exactly three functions) and nothing new is exposed', () => {
  withPreload((env) => {
    assert.equal(env.exposed.length, 1);
    assert.equal(env.exposed[0].name, '__gcdBridge');
    assert.deepEqual(Object.keys(env.exposed[0].api).sort(), ['notificationArrived', 'notificationClicked', 'notificationShow']);
  });
});

test('source pin: the preload imports only electron, and the channel is spelled exactly once as smartcopy:signal', () => {
  const code = fs.readFileSync(PRELOAD, 'utf8');
  const requires = [...code.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(requires)], ['electron']);
  assert.match(code, /smartcopy:signal/);
});

// --- positive gestures ----------------------------------------------------------------------------------------

test('detector: a drag of at least 4 px ending a changed, non-editable selection sends exactly one payload-free signal', () => {
  withPreload((env) => {
    const { old, next } = dragged(env);
    gesture(env, { before: old, after: next, up: { clientX: 104, screenX: 104, pageX: 104, x: 104 } });
    assert.deepEqual(env.signals(), [['smartcopy:signal', { kind: 'selection' }]]);
    assert.deepEqual(Object.keys(env.signals()[0][1]), ['kind']);
  });
});

test('detector: a vertical drag of 4 px counts too', () => {
  withPreload((env) => {
    const { old, next } = dragged(env);
    gesture(env, { before: old, after: next, up: { clientY: 104, screenY: 104, pageY: 104, y: 104 } });
    assert.equal(env.signals().length, 1);
  });
});

test('detector: a double click and a triple click with a changed selection each send one signal', () => {
  for (const detail of [2, 3]) {
    withPreload((env) => {
      const { old, next } = dragged(env);
      gesture(env, { before: old, after: next, down: { detail }, up: { detail } });
      assert.equal(env.signals().length, 1, 'detail ' + detail);
    });
  }
});

test('detector: Shift held is allowed', () => {
  withPreload((env) => {
    const { old, next } = dragged(env);
    gesture(env, { before: old, after: next, up: { ...DRAG_UP, shiftKey: true } });
    assert.equal(env.signals().length, 1);
  });
});

test('detector: the signal carries no text, coordinates or element data', () => {
  withPreload((env) => {
    const { old, next } = dragged(env);
    gesture(env, { before: old, after: next, up: DRAG_UP });
    const [, payload] = env.signals()[0];
    assert.deepEqual(payload, { kind: 'selection' });
    assert.equal(env.signals()[0].length, 2);
    assert.equal(JSON.stringify(env.sent).includes('some selected words'), false);
  });
});

test('detector: two successive gestures with different selections each send once', () => {
  withPreload((env) => {
    const { old, next } = dragged(env);
    gesture(env, { before: old, after: next, up: DRAG_UP });
    gesture(env, { before: next, after: old, up: DRAG_UP });
    assert.equal(env.signals().length, 2);
  });
});

// --- no gesture -----------------------------------------------------------------------------------------------

test('detector: a plain click, even with a changed selection, sends nothing', () => {
  withPreload((env) => {
    const { old, next } = dragged(env);
    gesture(env, { before: old, after: next });
    assert.deepEqual(env.signals(), []);
  });
});

test('detector: a 3 px drag is not a drag (horizontal and vertical)', () => {
  withPreload((env) => {
    const { old, next } = dragged(env);
    gesture(env, { before: old, after: next, up: { clientX: 103, screenX: 103, pageX: 103, x: 103 } });
    gesture(env, { before: old, after: next, up: { clientY: 103, screenY: 103, pageY: 103, y: 103 } });
    assert.deepEqual(env.signals(), []);
  });
});

test('detector: untrusted (page-dispatched) events send nothing', () => {
  withPreload((env) => {
    const { old, next } = dragged(env);
    gesture(env, { before: old, after: next, up: { ...DRAG_UP, isTrusted: false } });
    gesture(env, { before: old, after: next, down: { isTrusted: false }, up: { ...DRAG_UP, isTrusted: false } });
    assert.deepEqual(env.signals(), []);
  });
});

test('detector: a right or middle button sends nothing', () => {
  for (const button of [1, 2]) {
    withPreload((env) => {
      const { old, next } = dragged(env);
      gesture(env, { before: old, after: next, down: { button }, up: { ...DRAG_UP, button } });
      assert.deepEqual(env.signals(), [], 'button ' + button);
    });
  }
});

test('detector: Ctrl, Alt or Meta held at mouseup sends nothing', () => {
  for (const key of ['ctrlKey', 'altKey', 'metaKey']) {
    withPreload((env) => {
      const { old, next } = dragged(env);
      gesture(env, { before: old, after: next, up: { ...DRAG_UP, [key]: true } });
      assert.deepEqual(env.signals(), [], key);
    });
  }
});

test('detector: a selection unchanged since mousedown (stale) sends nothing', () => {
  withPreload((env) => {
    const { old } = dragged(env);
    gesture(env, { before: old, after: old, up: DRAG_UP });
    gesture(env, { before: old, after: { ...old }, down: { detail: 2 }, up: { detail: 2 } });
    assert.deepEqual(env.signals(), []);
  });
});

test('detector: a collapsed, empty, whitespace-only or missing selection sends nothing', () => {
  withPreload((env) => {
    const { t, old } = dragged(env);
    const variants = [
      selectionOf(t, t, '', { isCollapsed: true }),
      selectionOf(t, t, 'x', { isCollapsed: true }),
      selectionOf(t, t, '   \n\t '),
      selectionOf(t, t, '', { isCollapsed: false }),
      selectionOf(t, t, 'x', { rangeCount: 0 }),
      null,
    ];
    for (const after of variants) {
      gesture(env, { before: old, after, up: DRAG_UP });
    }
    assert.deepEqual(env.signals(), []);
  });
});

// --- editable surfaces ----------------------------------------------------------------------------------------

function editableCases(env) {
  const input = el('input', { parent: env.body });
  const textarea = el('textarea', { parent: env.body });
  const editableDiv = el('div', { parent: env.body, editable: true });
  const inner = el('span', { parent: editableDiv });
  const roleBox = el('div', { parent: env.body, attrs: { role: 'textbox' } });
  const roleInner = el('span', { parent: roleBox });
  const wrapperOfTextarea = el('div', { parent: env.body });
  return { input, textarea, editableDiv, inner, roleBox, roleInner, wrapperOfTextarea };
}

test('detector: an anchor or focus inside input, textarea, contenteditable or [role=textbox] sends nothing', () => {
  withPreload((env) => {
    const e = editableCases(env);
    const plain = text(paragraph(env).p);
    const old = selectionOf(plain, plain, 'old');
    const editableNodes = [e.input, e.textarea, e.editableDiv, e.inner, text(e.inner), e.roleBox, e.roleInner, text(e.roleInner)];
    for (const node of editableNodes) {
      gesture(env, { before: old, after: selectionOf(node, plain), up: DRAG_UP });
      gesture(env, { before: old, after: selectionOf(plain, node), up: DRAG_UP });
    }
    assert.deepEqual(env.signals(), []);
  });
});

test('detector: a mousedown or mouseup target inside an editable field sends nothing', () => {
  withPreload((env) => {
    const e = editableCases(env);
    const { old, next } = dragged(env);
    for (const target of [e.input, e.textarea, e.inner, e.roleInner]) {
      gesture(env, { before: old, after: next, down: { target }, up: { ...DRAG_UP } });
      gesture(env, { before: old, after: next, up: { ...DRAG_UP, target } });
    }
    assert.deepEqual(env.signals(), []);
  });
});

test('detector: an editable document.activeElement sends nothing (selection anchored on the container)', () => {
  withPreload((env) => {
    const e = editableCases(env);
    const { old } = dragged(env);
    const containerSelection = selectionOf(e.wrapperOfTextarea, e.wrapperOfTextarea, 'typed text');
    for (const active of [e.input, e.textarea, e.editableDiv, e.inner, e.roleBox]) {
      env.state.activeElement = active;
      gesture(env, { before: old, after: containerSelection, up: DRAG_UP });
    }
    assert.deepEqual(env.signals(), []);
  });
});

test('detector: an editable activeElement inside an open shadow root sends nothing', () => {
  withPreload((env) => {
    const host = el('div', { parent: env.body });
    const innerTextarea = el('textarea', { parent: null });
    host.shadowRoot = { activeElement: innerTextarea };
    env.state.activeElement = host;
    const { old, next } = dragged(env);
    gesture(env, { before: old, after: next, up: DRAG_UP });
    assert.deepEqual(env.signals(), []);
  });
});

test('detector: a plain active element (not editable, shadow host without an editable focus) still copies', () => {
  withPreload((env) => {
    const host = el('div', { parent: env.body });
    host.shadowRoot = { activeElement: el('button', { parent: null }) };
    env.state.activeElement = host;
    const { old, next } = dragged(env);
    gesture(env, { before: old, after: next, up: DRAG_UP });
    assert.equal(env.signals().length, 1);
  });
});

// --- does not interfere with the page -------------------------------------------------------------------------

test('detector: it never calls preventDefault or stopPropagation, whether it sends or not', () => {
  withPreload((env) => {
    const { old, next } = dragged(env);
    gesture(env, { before: old, after: next, up: DRAG_UP });
    gesture(env, { before: old, after: next });
    gesture(env, { before: old, after: next, down: { button: 2 }, up: { button: 2 } });
    gesture(env, { before: old, after: next, up: { ...DRAG_UP, isTrusted: false } });
    assert.equal(env.signals().length, 1);
    assert.equal(env.calls.preventDefault, 0);
    assert.equal(env.calls.stopPropagation, 0);
  });
});
