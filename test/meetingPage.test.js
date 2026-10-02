'use strict';

// UI-01 meeting-page predicate (docs/architecture/meet-call-window.md section 5). RED until
// src/main/meetingPage.js exists.
//
// API under test:
//   src/main/meetingPage.js
//   isMeetingPage(address: unknown) -> boolean
//     Decided from the address (webContents.getURL()) ONLY, by exclusion. NOT a meeting page when the
//     parsed origin is not exactly https://meet.google.com (accounts.google.com, about:blank, Chromium
//     error pages, http://meet.google.com ...) or when the path is exactly "/" or "/landing".
//     EVERYTHING ELSE - including any address form that cannot be recognised - is a meeting page: the
//     failure direction is "focus and notify", never "navigate away from a call". Never throws.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers/pending');

const NOT_MEETING = [
  ['meet root', 'https://meet.google.com/'],
  ['meet bare origin', 'https://meet.google.com'],
  ['meet landing', 'https://meet.google.com/landing'],
  ['meet root with a query', 'https://meet.google.com/?authuser=1'],
  ['meet landing with a query and fragment', 'https://meet.google.com/landing?hl=en#x'],
  ['accounts sign-in', 'https://accounts.google.com/signin/v2/identifier'],
  ['accounts root', 'https://accounts.google.com/'],
  ['about:blank', 'about:blank'],
  ['Chromium error page', 'chrome-error://chromewebdata/'],
  ['chat origin', 'https://chat.google.com/'],
  ['http meet (not the exact origin)', 'http://meet.google.com/abc-defg-hij'],
  ['foreign origin', 'https://example.org/abc-defg-hij'],
];

for (const [label, address] of NOT_MEETING) {
  test(`isMeetingPage: ${label} is NOT a meeting page`, () => {
    assert.equal(load('meetingPage.js').isMeetingPage(address), false);
  });
}

const MEETING = [
  ['a meeting code', 'https://meet.google.com/abc-defg-hij'],
  ['a meeting code with a query', 'https://meet.google.com/abc-defg-hij?authuser=1'],
  ['a meeting code with a fragment', 'https://meet.google.com/abc-defg-hij#x'],
  ['a meeting code with default port and upper-case host', 'https://MEET.GOOGLE.COM:443/abc-defg-hij'],
  ['a lookup path', 'https://meet.google.com/lookup/abcdefg'],
  ['a path that only starts with /landing (not exactly /landing)', 'https://meet.google.com/landing/x'],
  ['an end-of-call page (same address as the meeting; documented limitation)', 'https://meet.google.com/abc-defg-hij'],
];

for (const [label, address] of MEETING) {
  test(`isMeetingPage: ${label} IS a meeting page`, () => {
    assert.equal(load('meetingPage.js').isMeetingPage(address), true);
  });
}

// Unknown means "meeting": safe direction. An empty address is what getURL() returns while the very
// first load has not committed yet, so a second link in that window focuses and notifies.
const UNKNOWN = [
  ['empty string (nothing committed yet)', ''],
  ['garbage', 'not a url'],
  ['percent garbage', '%%%'],
  ['undefined', undefined],
  ['null', null],
  ['a number', 42],
  ['an object', {}],
];

for (const [label, address] of UNKNOWN) {
  test(`isMeetingPage: an unrecognised address (${label}) counts as a meeting page and never throws`, () => {
    const { isMeetingPage } = load('meetingPage.js');
    assert.doesNotThrow(() => isMeetingPage(address));
    assert.equal(isMeetingPage(address), true);
  });
}
