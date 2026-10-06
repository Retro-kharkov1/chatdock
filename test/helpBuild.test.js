'use strict';

// UI-06: docs/user-guide.md -> static help.html (scripts/lib/helpGuide.js, scripts/build-help.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const g = require('../scripts/lib/helpGuide.js');

const root = path.join(__dirname, '..');
const guide = fs.readFileSync(path.join(root, 'docs', 'user-guide.md'), 'utf8');
const generatedPath = path.join(root, 'src', 'renderer', 'help', 'help.html');

const SAMPLE = [
  '# Title',
  '',
  'Intro with **bold** and `code <b>` and a [link](https://example.com/?a=1&b=2).',
  '',
  '## First',
  '',
  '- one',
  '- two',
  '  - nested',
  '',
  '<!-- UI-05: publish when shipped -->',
  '## Smart copy',
  '',
  'Secret UI05 text.',
  '<!-- /UI-05 -->',
  '',
  '## Last',
  '',
  '| A | B |',
  '|---|---|',
  '| x | <script>alert(1)</script> |',
  '',
].join('\n');

test('UI-05 section is excluded when the flag is off, markers and all', () => {
  const html = g.renderGuideHtml(SAMPLE, { publishUi05: false });
  assert.doesNotMatch(html, /Smart copy|UI05|UI-05|smart-copy/);
  assert.match(html, /First/);
  assert.match(html, /Last/);
});

test('UI-05 section is included (markers removed) when the flag is flipped', () => {
  const html = g.renderGuideHtml(SAMPLE, { publishUi05: true });
  assert.match(html, /Smart copy/);
  assert.match(html, /Secret UI05 text/);
  assert.doesNotMatch(html, /UI-05|<!--\s*\//);
});

const SSO_SAMPLE = [
  '# T',
  '',
  '## Sign in',
  '',
  '- before',
  '<!-- unpublished: SSO -->',
  '- Secret SSO bullet.',
  '<!-- /unpublished: SSO -->',
  '- after',
  '',
  '<!-- unpublished: FUTURE -->',
  'Unlisted future text.',
  '<!-- /unpublished: FUTURE -->',
  '',
].join('\n');

test('named unpublished sections: a flag that is off hides its section, the list stays intact, unlisted names fail closed', () => {
  // FR-19 shipped, so SSO is published by default (next test); the mechanism is exercised with the flag forced off.
  const html = g.renderGuideHtml(SSO_SAMPLE, { publish: { SSO: false } });
  assert.doesNotMatch(html, /Secret SSO|Unlisted future|unpublished/);
  assert.match(html, /<li>before<\/li><li>after<\/li>/);
});

test('named unpublished sections: flipping a flag publishes just that section, markers removed', () => {
  const html = g.renderGuideHtml(SSO_SAMPLE, { publish: { SSO: true } });
  assert.match(html, /<li>Secret SSO bullet\.<\/li>/);
  assert.doesNotMatch(html, /Unlisted future|unpublished/);
});

test('the SSO flag is on (FR-19 shipped): the real guide publishes its SSO note, markers removed; off, it stays out', () => {
  assert.equal(g.PUBLISH_FLAGS.SSO, true);
  assert.match(guide, /<!-- unpublished: SSO -->/);
  const html = g.renderGuideHtml(guide);
  assert.match(html, /single sign-on/);
  assert.match(html, /Back to Chat/);
  assert.doesNotMatch(html, /unpublished/);
  assert.doesNotMatch(g.renderGuideHtml(guide, { publish: { SSO: false } }), /single sign-on|Back to Chat|unpublished/);
});

test('markup: lists, nesting, tables, inline code/bold, heading ids and a contents list with working anchors', () => {
  const html = g.renderGuideHtml(SAMPLE);
  assert.match(html, /<h2 id="first">First<\/h2>/);
  assert.match(html, /<li>one<\/li>/);
  assert.match(html, /<li>two<ul><li>nested<\/li><\/ul><\/li>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>code &lt;b&gt;<\/code>/);
  assert.match(html, /<th>A<\/th>/);
  assert.match(html, /<nav[\s\S]*href="#first"[\s\S]*href="#last"/);
});

test('all text is escaped; a script in the source never becomes a tag; unsafe link targets become plain text', () => {
  const html = g.renderGuideHtml(SAMPLE + '\n[x](javascript:alert(1)) [y](file:///c:/a)\n');
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /href="https:\/\/example\.com\/\?a=1&amp;b=2"/);
  assert.doesNotMatch(html, /href="javascript:|href="file:/);
});

test('generated HTML has no script, no event handler, no remote resource, and a strict CSP', () => {
  const html = g.renderGuideHtml(guide);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(html, /<(img|iframe|object|embed|link|source|video|audio)[^>]+(src|href)="(https?:)?\/\//i);
  const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html);
  assert.ok(csp, 'CSP meta tag present');
  assert.match(csp[1], /default-src 'none'/);
  assert.doesNotMatch(csp[1], /script-src|unsafe-inline|unsafe-eval|\*|https?:/);
  assert.match(csp[1], /style-src 'self'/);
  assert.match(csp[1], /base-uri 'none'/);
  assert.match(csp[1], /form-action 'none'/);
  // Only a local stylesheet is referenced.
  assert.deepEqual(html.match(/<link [^>]*>/g), ['<link rel="stylesheet" href="help.css" />']);
});

test('UI-05 has shipped: the flag is on and the real guide renders its Quick copy section and the Help entries', () => {
  assert.equal(g.PUBLISH_UI05, true);
  const html = g.renderGuideHtml(guide);
  assert.match(html, /<h2 id="quick-copy-with-the-mouse">Quick copy with the mouse<\/h2>/);
  assert.match(html, /Link copied/);
  assert.doesNotMatch(html, /UI-05/);
  assert.match(html, /<h2 id="settings">/);
  assert.match(html, /<strong>Help<\/strong>/);
});

test('the checked-in help.html is current (run `npm run build-help` after editing docs/user-guide.md)', () => {
  assert.equal(fs.readFileSync(generatedPath, 'utf8'), g.renderGuideHtml(guide));
});

test('help.css exists next to the page and the packaged files glob covers both', () => {
  assert.ok(fs.existsSync(path.join(path.dirname(generatedPath), 'help.css')));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.build.files.includes('src/**/*'));
  assert.equal(typeof pkg.scripts['build-help'], 'string');
});

test('scripts/build.js regenerates the guide before packaging', () => {
  const build = fs.readFileSync(path.join(root, 'scripts', 'build.js'), 'utf8');
  assert.match(build, /require\('\.\/build-help\.js'\)/);
  assert.match(build, /generateHelp\(\)/);
});
