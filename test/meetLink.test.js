'use strict';

// NFR-07 Meet link classifier - pure logic, ALL RED (module does not exist yet).
//
// Contract proposed for the implementer (argue with it if it does not fit, then change the test
// deliberately, not silently):
//
//   src/main/meetLink.js
//   classifyLink(input) -> { outcome: 'call-window' | 'system-browser', url: string }
//     - never throws, for ANY input type
//     - outcome 'call-window': `url` is the WHATWG-normalised href of the URL that must be opened
//       (for a www.google.com/url?q= wrapper: the unwrapped TARGET's normalised href). Opening the
//       parsed/normalised form, not the raw string, is deliberate - it removes parser differentials.
//     - outcome 'system-browser': everything else (`url` is not asserted).
//
// Rule (docs/business/requirements.md NFR-07): scheme https, hostname exactly meet.google.com,
// origin equal to https://meet.google.com (explicit non-default port and userinfo refused);
// only https://www.google.com/url?q=<target> is unwrapped, once, target must pass the same test.

const assert = require('node:assert/strict');
const { pendingMeet: pending, load } = require('./helpers/pending');

const CALL = 'call-window';
const BROWSER = 'system-browser';
const enc = encodeURIComponent;
const MEET = 'https://meet.google.com/abc-defg-hij';

function outcomeOf(input) {
  return load('meetLink.js').classifyLink(input).outcome;
}

// --- Positive cases --------------------------------------------------------------------------

pending('plain https meet link -> call window, url is the normalised link', () => {
  const r = load('meetLink.js').classifyLink(MEET);
  assert.equal(r.outcome, CALL);
  assert.equal(r.url, MEET);
});

pending('uppercase host is the same host -> call window, normalised to lowercase', () => {
  const r = load('meetLink.js').classifyLink('https://MEET.GOOGLE.COM/abc-defg-hij');
  assert.equal(r.outcome, CALL);
  assert.equal(r.url, MEET);
});

pending('explicit default port :443 -> call window', () => {
  assert.equal(outcomeOf('https://meet.google.com:443/abc-defg-hij'), CALL);
});

pending('query string and fragment on a meet link are fine -> call window', () => {
  assert.equal(outcomeOf('https://meet.google.com/abc-defg-hij?authuser=1#x'), CALL);
});

pending('meet link with only a path root -> call window', () => {
  assert.equal(outcomeOf('https://meet.google.com/'), CALL);
});

pending('backslash after the host is a path separator for https URLs (parser-consistent) -> call window with normalised url', () => {
  const r = load('meetLink.js').classifyLink('https://meet.google.com\\@evil.example/x');
  assert.equal(r.outcome, CALL);
  assert.equal(r.url, 'https://meet.google.com/@evil.example/x');
});

pending('www.google.com/url?q= wrapper around a meet link -> call window, url is the unwrapped target', () => {
  const r = load('meetLink.js').classifyLink(`https://www.google.com/url?q=${enc(MEET)}`);
  assert.equal(r.outcome, CALL);
  assert.equal(r.url, MEET);
});

pending('wrapper with extra parameters after q still unwraps the q target', () => {
  const r = load('meetLink.js').classifyLink(`https://www.google.com/url?q=${enc(MEET)}&sa=D&usg=x`);
  assert.equal(r.outcome, CALL);
  assert.equal(r.url, MEET);
});

pending('wrapper target with uppercase host passes the same test -> call window', () => {
  const r = load('meetLink.js').classifyLink(`https://www.google.com/url?q=${enc('https://MEET.GOOGLE.COM/abc')}`);
  assert.equal(r.outcome, CALL);
  assert.equal(r.url, 'https://meet.google.com/abc');
});

// --- Adversarial host / scheme / port / userinfo ---------------------------------------------

const BROWSER_CASES = [
  ['http scheme', 'http://meet.google.com/abc-defg-hij'],
  ['userinfo tricks (meet.google.com@evil)', 'https://meet.google.com@evil.example/'],
  ['userinfo before the real host', 'https://a@meet.google.com/abc'],
  ['user and password before the real host', 'https://a:b@meet.google.com/abc'],
  ['non-default port 8443', 'https://meet.google.com:8443/abc-defg-hij'],
  ['non-default port 444', 'https://meet.google.com:444/abc'],
  ['trailing dot on the host', 'https://meet.google.com./abc-defg-hij'],
  ['percent-encoded trailing dot', 'https://meet.google.com%2e/abc'],
  ['meet.google.com as a prefix of an attacker domain', 'https://meet.google.com.evil.example/abc'],
  ['lookalike prefix (evilmeet.google.com)', 'https://evilmeet.google.com/abc'],
  ['lookalike prefix (notmeet.google.com)', 'https://notmeet.google.com/abc'],
  ['hyphen lookalike (meet-google.com)', 'https://meet-google.com/abc'],
  ['a deeper subdomain (x.meet.google.com)', 'https://x.meet.google.com/abc'],
  ['the bare parent domain', 'https://google.com/meet'],
  ['www.google.com (not a wrapper path)', 'https://www.google.com/meet'],
  ['the chat host', 'https://chat.google.com/'],
  ['meet host embedded in the path of another host', 'https://evil.example/https://meet.google.com/abc'],
  ['meet host in the query of another host', 'https://evil.example/?u=https://meet.google.com/abc'],
  ['meet host in the fragment of another host', 'https://evil.example/#https://meet.google.com/abc'],
  ['ftp scheme', 'ftp://meet.google.com/abc'],
  ['javascript scheme', 'javascript:alert(1)//meet.google.com'],
  ['data scheme', 'data:text/html,https://meet.google.com'],
  ['file scheme', 'file://meet.google.com/abc'],
  ['scheme-relative URL (unparseable without base)', '//meet.google.com/abc'],
  ['no scheme at all', 'meet.google.com/abc'],
  ['empty string', ''],
  ['garbage', '%%%'],
  ['whitespace only', '   '],
  ['IPv4 host', 'https://142.250.0.1/abc'],
];

for (const [label, input] of BROWSER_CASES) {
  pending(`system browser: ${label}`, () => {
    assert.equal(outcomeOf(input), BROWSER);
  });
}

pending('non-string inputs (null, undefined, number, object) -> system browser, never throw', () => {
  const { classifyLink } = load('meetLink.js');
  for (const bad of [null, undefined, 42, {}, [], () => {}]) {
    assert.equal(classifyLink(bad).outcome, BROWSER);
  }
});

// --- Adversarial wrapper cases ---------------------------------------------------------------

const WRAPPER_BROWSER_CASES = [
  ['wrapper without www', `https://google.com/url?q=${enc(MEET)}`],
  ['wrapper on another host', `https://evil.example/url?q=${enc(MEET)}`],
  ['wrapper on a lookalike www host', `https://www.google.com.evil.example/url?q=${enc(MEET)}`],
  ['http wrapper', `http://www.google.com/url?q=${enc(MEET)}`],
  ['wrapper on a different path', `https://www.google.com/search?q=${enc(MEET)}`],
  ['wrapper path with trailing slash', `https://www.google.com/url/?q=${enc(MEET)}`],
  ['wrapper using url= instead of q=', `https://www.google.com/url?url=${enc(MEET)}`],
  ['wrapper target is http', `https://www.google.com/url?q=${enc('http://meet.google.com/abc')}`],
  ['wrapper target is another host', `https://www.google.com/url?q=${enc('https://evil.example/')}`],
  ['wrapper target is a lookalike host', `https://www.google.com/url?q=${enc('https://meet.google.com.evil.example/x')}`],
  ['wrapper target has a non-default port', `https://www.google.com/url?q=${enc('https://meet.google.com:444/x')}`],
  ['wrapper target has userinfo', `https://www.google.com/url?q=${enc('https://a@meet.google.com/x')}`],
  ['wrapper target has a trailing-dot host', `https://www.google.com/url?q=${enc('https://meet.google.com./x')}`],
  ['unparseable q', 'https://www.google.com/url?q=%%%not-a-url'],
  ['empty q', 'https://www.google.com/url?q='],
  ['missing q', 'https://www.google.com/url'],
  ['q is a bare meet host with no scheme', `https://www.google.com/url?q=${enc('meet.google.com/abc')}`],
  ['nested wrapper (target is itself a wrapper)', `https://www.google.com/url?q=${enc(`https://www.google.com/url?q=${enc(MEET)}`)}`],
  ['nested wrapper, spec example with double-encoded q', 'https://www.google.com/url?q=https%3A%2F%2Fwww.google.com%2Furl%3Fq%3Dhttps%253A%252F%252Fmeet.google.com%252Fabc'],
  ['double-encoded target (decoded once it is not a URL)', `https://www.google.com/url?q=${enc(enc(MEET))}`],
  ['first of two q parameters points elsewhere', `https://www.google.com/url?q=${enc('https://evil.example/')}&q=${enc(MEET)}`],
];

for (const [label, input] of WRAPPER_BROWSER_CASES) {
  pending(`system browser (wrapper): ${label}`, () => {
    assert.equal(outcomeOf(input), BROWSER);
  });
}

pending('unwrapping happens once: a wrapper is not a call-window result even if its target unwraps to Meet', () => {
  const inner = `https://www.google.com/url?q=${enc(MEET)}`;
  const outer = `https://www.google.com/url?q=${enc(inner)}`;
  assert.equal(outcomeOf(outer), BROWSER);
});
