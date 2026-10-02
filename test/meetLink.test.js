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

// --- Added by the UI-01 coverage-first net (docs/architecture/meet-call-window.md section 2 and 10) ---

// Mixed-case scheme: the scheme is case-insensitive in WHATWG parsing; the opened url is normalised.
pending('mixed-case scheme (HTTPS://, HtTpS://) on a meet link -> call window, url normalised', () => {
  const { classifyLink } = load('meetLink.js');
  for (const input of ['HTTPS://meet.google.com/abc-defg-hij', 'HtTpS://Meet.Google.Com/abc-defg-hij']) {
    const r = classifyLink(input);
    assert.equal(r.outcome, CALL, input);
    assert.equal(r.url, MEET, input);
  }
});

pending('mixed-case scheme on the wrapper still unwraps', () => {
  const r = load('meetLink.js').classifyLink(`HTTPS://www.google.com/url?q=${enc(MEET)}`);
  assert.equal(r.outcome, CALL);
  assert.equal(r.url, MEET);
});

// Percent-encoded host letters are decoded by the URL parser: the parsed host IS meet.google.com, so
// the outcome follows the parsed (normalised) form and the returned url is that normalised form.
pending('percent-encoded host letters decode to the real host -> call window with the normalised url', () => {
  const { classifyLink } = load('meetLink.js');
  for (const input of ['https://meet%2Egoogle.com/abc-defg-hij', 'https://%6Deet.google.com/abc-defg-hij']) {
    const r = classifyLink(input);
    assert.equal(r.outcome, CALL, input);
    assert.equal(r.url, MEET, input);
  }
});

pending('percent-encoded userinfo terminator (meet.google.com%2F@evil.example) -> system browser', () => {
  assert.equal(outcomeOf('https://meet.google.com%2F@evil.example/'), BROWSER);
});

pending('tab and newline characters are stripped by the parser: the opened url carries none of them', () => {
  const { classifyLink } = load('meetLink.js');
  for (const input of ['https://mee\tt.google.com/abc-defg-hij', 'https://meet.google.com/\nabc-defg-hij', 'https://meet.google.com/abc-\r\ndefg-hij']) {
    const r = classifyLink(input);
    assert.equal(r.outcome, CALL, JSON.stringify(input));
    assert.equal(r.url, MEET, JSON.stringify(input));
  }
});

pending('tab or newline hiding a foreign host is still a foreign host -> system browser', () => {
  assert.equal(outcomeOf('https://evil.example\t/https://meet.google.com/abc'), BROWSER);
  assert.equal(outcomeOf('https://meet.google.com.\tevil.example/abc'), BROWSER);
});

pending('punycode / IDN lookalikes of the host -> system browser', () => {
  const { classifyLink } = load('meetLink.js');
  for (const input of [
    'https://meеt.google.com/abc', // Cyrillic small letter ie in place of the second "e"
    'https://xn--met-sdd.google.com/abc', // the punycode form of the line above
    'https://meet.googlе.com/abc', // Cyrillic ie in "google"
    'https://meet.google.cοm/abc', // Greek omicron in "com"
  ]) {
    assert.equal(classifyLink(input).outcome, BROWSER, input);
  }
});

// Wrapper-host hardening: only https://www.google.com/url (no explicit port, no userinfo) unwraps.
pending('wrapper host in uppercase is the same host -> unwraps', () => {
  const r = load('meetLink.js').classifyLink(`https://WWW.GOOGLE.COM/url?q=${enc(MEET)}`);
  assert.equal(r.outcome, CALL);
  assert.equal(r.url, MEET);
});

const WRAPPER_HOST_BROWSER_CASES = [
  ['wrapper with a non-default port', `https://www.google.com:8443/url?q=${enc(MEET)}`],
  ['wrapper with userinfo', `https://a@www.google.com/url?q=${enc(MEET)}`],
  ['wrapper with user and password', `https://a:b@www.google.com/url?q=${enc(MEET)}`],
  ['wrapper whose userinfo names the real host', `https://www.google.com@evil.example/url?q=${enc(MEET)}`],
  ['wrapper with a trailing-dot host', `https://www.google.com./url?q=${enc(MEET)}`],
  ['wrapper path in a different case', `https://www.google.com/URL?q=${enc(MEET)}`],
  ['wrapper path with a suffix', `https://www.google.com/url/extra?q=${enc(MEET)}`],
];

for (const [label, input] of WRAPPER_HOST_BROWSER_CASES) {
  pending(`system browser (wrapper host): ${label}`, () => {
    assert.equal(outcomeOf(input), BROWSER);
  });
}

pending('wrapper q target keeps its query and fragment in the opened url', () => {
  const target = 'https://meet.google.com/abc-defg-hij?authuser=1&pli=1#fragment';
  const r = load('meetLink.js').classifyLink(`https://www.google.com/url?q=${enc(target)}`);
  assert.equal(r.outcome, CALL);
  assert.equal(r.url, target);
});

pending('wrapper url is never what is opened: the result is the target, not the wrapper', () => {
  const wrapper = `https://www.google.com/url?q=${enc(MEET)}&sa=D`;
  const r = load('meetLink.js').classifyLink(wrapper);
  assert.notEqual(r.url, wrapper);
  assert.equal(r.url, MEET);
});

pending('duplicated q is refused in either order, even when both values are the same meet link', () => {
  const { classifyLink } = load('meetLink.js');
  const evil = enc('https://evil.example/');
  assert.equal(classifyLink(`https://www.google.com/url?q=${enc(MEET)}&q=${evil}`).outcome, BROWSER);
  assert.equal(classifyLink(`https://www.google.com/url?q=${evil}&q=${enc(MEET)}`).outcome, BROWSER);
  assert.equal(classifyLink(`https://www.google.com/url?q=${enc(MEET)}&q=${enc(MEET)}`).outcome, BROWSER);
});

pending('classifyLink never throws, for exotic inputs of any type', () => {
  const { classifyLink } = load('meetLink.js');
  const exotic = [Symbol('x'), 10n, NaN, true, new Date(0), Object.create(null), { toString() { throw new Error('boom'); } }, 'https://', 'https://:443', 'https://[::1', '\u0000'];
  for (const input of exotic) {
    assert.doesNotThrow(() => classifyLink(input));
    assert.equal(classifyLink(input).outcome, BROWSER);
  }
});

// --- isOpenableExternalScheme (architecture section 2, rule 5) ---------------------------------

pending('isOpenableExternalScheme: http, https and mailto (any case) are openable', () => {
  const { isOpenableExternalScheme } = load('meetLink.js');
  for (const url of ['https://example.org/page', 'http://example.org/page', 'HTTPS://example.org/page', 'mailto:someone@example.org', 'MAILTO:someone@example.org']) {
    assert.equal(isOpenableExternalScheme(url), true, url);
  }
});

const NOT_OPENABLE = [
  'file:///C:/Windows/System32/calc.exe',
  'ms-settings:privacy',
  'javascript:alert(1)',
  'data:text/html,hello',
  'ftp://example.org/x',
  'ssh://host.example',
  'myapp://do-something',
  'blob:https://example.org/uuid',
  'vbscript:msgbox(1)',
  'not a url',
  '%%%',
  '//example.org/x',
  'example.org/x',
  '',
  '   ',
];

for (const url of NOT_OPENABLE) {
  pending(`isOpenableExternalScheme: ${JSON.stringify(url)} is not openable`, () => {
    assert.equal(load('meetLink.js').isOpenableExternalScheme(url), false);
  });
}

pending('isOpenableExternalScheme: non-string input is not openable and never throws', () => {
  const { isOpenableExternalScheme } = load('meetLink.js');
  for (const bad of [null, undefined, 42, {}, [], () => {}]) {
    assert.equal(isOpenableExternalScheme(bad), false);
  }
});
