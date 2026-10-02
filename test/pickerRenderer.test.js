'use strict';

// UI-01 picker renderer: static checks on the shipped files (there is no DOM runtime in this suite),
// docs/architecture/meet-call-window.md section 7 + docs/design/05-meet-source-picker.md.
// RED until src/renderer/picker/ exists (file names are the implementer's: every .html / .js / .css
// file in that directory is read together).
//
// Hook contract (skill frontend-test-hooks, project convention: none existed, so `data-testid`).
// Proposed hooks the implementer should add to the picker markup (so e2e/real-browser checks and any
// later DOM test never select by class or text):
//   picker-loading-state, picker-error-state, picker-empty-state, picker-source-list,
//   picker-share-button, picker-cancel-button, picker-retry-button
// Security properties checked statically: strict CSP in the document, no inline script, no markup
// injection APIs (text via textContent), no remote resources, Escape cancels, nothing pre-selected.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'src', 'renderer', 'picker');

function files(ext) {
  return fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith(ext)).map((f) => ({ name: f, text: fs.readFileSync(path.join(DIR, f), 'utf8') })) : [];
}
const everything = () => files('.html').concat(files('.js'), files('.css'));

test('picker renderer: the directory has one HTML document and a script', () => {
  assert.equal(fs.existsSync(DIR), true);
  assert.equal(files('.html').length, 1);
  assert.ok(files('.js').length >= 1);
});

test('picker renderer: the document carries a strict CSP (no unsafe-inline / unsafe-eval, no remote sources)', () => {
  const [html] = files('.html');
  const tag = /<meta[^>]*Content-Security-Policy[^>]*>/i.exec(html.text);
  assert.ok(tag, 'a Content-Security-Policy meta tag is required');
  const csp = /content="([^"]*)"|content='([^']*)'/i.exec(tag[0]);
  assert.ok(csp, 'the CSP meta tag carries a policy');
  const policy = csp[1] !== undefined ? csp[1] : csp[2];
  assert.match(policy, /default-src\s+'none'|default-src\s+'self'/);
  assert.equal(/unsafe-inline|unsafe-eval/.test(policy.replace(/style-src[^;]*/i, '')), false, 'no unsafe-* outside style-src');
  assert.equal(/https?:\/\//.test(policy), false, 'no remote origin in the policy');
});

test('picker renderer: no inline script and no remote resource in the document', () => {
  const [html] = files('.html');
  assert.equal(/<script(?![^>]*\bsrc=)[^>]*>\s*\S/i.test(html.text), false, 'inline script');
  assert.equal(/\son[a-z]+\s*=/i.test(html.text), false, 'inline event handler attribute');
  assert.equal(/(src|href)\s*=\s*["']https?:\/\//i.test(html.text), false, 'remote resource');
});

test('picker renderer: text is rendered with textContent - no innerHTML, outerHTML, insertAdjacentHTML, document.write, eval', () => {
  assert.ok(files('.js').length >= 1, 'the picker script must exist');
  for (const f of files('.js')) {
    for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) {
      assert.equal(f.text.includes(banned), false, `${f.name} uses ${banned}`);
    }
    assert.match(f.text, /textContent/);
  }
});

test('picker renderer: talks to main only through window.__gcdPickerBridge (no require, no ipcRenderer, no fetch)', () => {
  const text = files('.js').map((f) => f.text).join('\n');
  assert.match(text, /__gcdPickerBridge/);
  for (const banned of ['require(', 'ipcRenderer', 'fetch(', 'XMLHttpRequest', 'WebSocket']) {
    assert.equal(text.includes(banned), false, banned);
  }
});

test('picker renderer: Escape cancels, and the document asks main for the list only after it is showing (loading state first)', () => {
  const text = files('.js').map((f) => f.text).join('\n');
  assert.match(text, /Escape/);
  assert.match(text, /getSources/);
  assert.match(text, /cancel/);
});

test('picker renderer: the stable test hooks exist (data-testid)', () => {
  const text = everything().map((f) => f.text).join('\n');
  for (const hook of ['picker-loading-state', 'picker-error-state', 'picker-empty-state', 'picker-source-list', 'picker-share-button', 'picker-cancel-button', 'picker-retry-button']) {
    assert.ok(text.includes(hook), `missing test hook ${hook}`);
  }
  assert.match(text, /data-testid/);
});

test('picker renderer: nothing is pre-selected (no "selected" / "checked" / "aria-selected=true" in the static markup)', () => {
  const [html] = files('.html');
  assert.equal(/\bchecked\b|aria-selected=["']true["']|\bselected\b(?!-)/i.test(html.text.replace(/<!--[\s\S]*?-->/g, '')), false);
});
