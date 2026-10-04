'use strict';

// UI-04 / FR-17 coverage-first net: the pure Google link classifier (docs/architecture/google-app-windows.md
// sections 1, 2, 3, 7 and the coverage-map rows classifyGoogleLink, Wrapper, isGoogleNavigationUrl,
// isDownloadHop, classifyChatTarget). RED until src/main/googleLink.js exists.
//
// MODULE API ASSUMED (src/main/googleLink.js, pure, no Electron import, never throws for any input):
//
//   classifyGoogleLink(input) -> { outcome: 'main-window' | 'app-window' | 'none', url, hop? }
//     'app-window'  link-list host (drive, docs, calendar, mail, keep, contacts, sites) or forms.gle
//                   (hop: true); `url` = the NORMALISED href of the target (fragment kept).
//     'main-window' https://chat.google.com exact origin (path handling is classifyChatTarget).
//     'none'        everything else, incl. accounts.google.com and drive.usercontent.google.com.
//     Exact-origin rule: https, hostname equal, port '', no userinfo; www.google.com/url?q= unwrapped once.
//   isGoogleNavigationUrl(url) -> boolean            the nav list (link list + accounts.google.com).
//   isDownloadHop({ url, fromUrl, isRedirect, windowUrl }) -> boolean   section 2 download-hop rule.
//     On a brand-new window's initial load fromUrl is the REQUESTED url and windowUrl is empty.
//   isDownloadChainUrl(url, hosts = DOWNLOAD_CHAIN_HOSTS) -> boolean   nav-list origin, usercontent /download,
//     or an exact host in `hosts`; https only. The optional 2nd argument is how the test injects a host
//     (assumed; the spec says "injected into the list for the test" without naming the seam).
//   DOWNLOAD_CHAIN_HOSTS: frozen, empty array. Never widens isGoogleNavigationUrl.
//   classifyChatTarget(url, source) -> 'main-window' | 'focus-main' | 'download' | 'browser'
//     source: 'main' (popup of the main window) | 'app' (a Google app window). Download shapes win; a
//     leading /u/<n> is stripped first.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./helpers/pending');

const DRIVE_EXAMPLE = 'https://drive.google.com/file/d/FILE_ID/view?usp=sharing';
const wrap = (target) => `https://www.google.com/url?q=${encodeURIComponent(target)}`;

// --- classifyGoogleLink: link list -------------------------------------------------------------------

const LINK_LIST_HOSTS = [
  'drive.google.com',
  'docs.google.com',
  'calendar.google.com',
  'mail.google.com',
  'keep.google.com',
  'contacts.google.com',
  'sites.google.com',
];

for (const host of LINK_LIST_HOSTS) {
  test(`classifyGoogleLink: https://${host}/x opens an app window with the normalised href`, () => {
    const r = load('googleLink.js').classifyGoogleLink(`https://${host}/x?y=1`);
    assert.equal(r.outcome, 'app-window');
    assert.equal(r.url, `https://${host}/x?y=1`);
    assert.ok(!r.hop);
  });
}

test('classifyGoogleLink: the owner example (Drive file view) is an app window', () => {
  const r = load('googleLink.js').classifyGoogleLink(DRIVE_EXAMPLE);
  assert.deepEqual({ outcome: r.outcome, url: r.url }, { outcome: 'app-window', url: DRIVE_EXAMPLE });
});

test('classifyGoogleLink: uppercase scheme and host normalise and pass; the url is the normalised href', () => {
  const r = load('googleLink.js').classifyGoogleLink('HTTPS://DRIVE.GOOGLE.COM/file/d/1/view');
  assert.equal(r.outcome, 'app-window');
  assert.equal(r.url, 'https://drive.google.com/file/d/1/view');
});

test('classifyGoogleLink: the default port :443 normalises away and passes', () => {
  const r = load('googleLink.js').classifyGoogleLink('https://docs.google.com:443/document/d/1/edit');
  assert.equal(r.outcome, 'app-window');
  assert.equal(r.url, 'https://docs.google.com/document/d/1/edit');
});

test('classifyGoogleLink: a fragment is kept in the returned url (the window factory needs it)', () => {
  const r = load('googleLink.js').classifyGoogleLink('https://docs.google.com/document/d/1/edit#heading=h.abc');
  assert.equal(r.url, 'https://docs.google.com/document/d/1/edit#heading=h.abc');
});

test('classifyGoogleLink: Docs, Sheets, Slides and Forms paths all live on the one docs host', () => {
  const { classifyGoogleLink } = load('googleLink.js');
  for (const p of ['/document/d/1/edit', '/spreadsheets/d/1/edit', '/presentation/d/1/edit', '/forms/d/1/viewform']) {
    assert.equal(classifyGoogleLink(`https://docs.google.com${p}`).outcome, 'app-window', p);
  }
});

// --- classifyGoogleLink: Chat, never-entry hosts ---------------------------------------------------------

test('classifyGoogleLink: https://chat.google.com/x is the main-window outcome with the normalised href', () => {
  const r = load('googleLink.js').classifyGoogleLink('https://CHAT.google.com/room/AAA?x=1');
  assert.equal(r.outcome, 'main-window');
  assert.equal(r.url, 'https://chat.google.com/room/AAA?x=1');
});

for (const url of [
  'https://accounts.google.com/signin/v2',
  'https://drive.usercontent.google.com/download?id=1',
  'https://myaccount.google.com/',
  'https://maps.google.com/',
  'https://g.co/abc',
  'https://lh3.googleusercontent.com/x',
  'https://accounts.youtube.com/x',
  'https://meet.google.com/abc-defg-hij',
  'https://www.google.com/search?q=x',
]) {
  test(`classifyGoogleLink: ${url} is never an entry point (none)`, () => {
    assert.equal(load('googleLink.js').classifyGoogleLink(url).outcome, 'none');
  });
}

// --- classifyGoogleLink: forms.gle entry hop -----------------------------------------------------------------

test('classifyGoogleLink: https://forms.gle/abc is an app window flagged hop: true', () => {
  const r = load('googleLink.js').classifyGoogleLink('https://forms.gle/abc');
  assert.equal(r.outcome, 'app-window');
  assert.equal(r.hop, true);
  assert.equal(r.url, 'https://forms.gle/abc');
});

for (const url of [
  'http://forms.gle/abc',
  'https://forms.gle:8443/abc',
  'https://evilforms.gle/abc',
  'https://forms.gle.evil.example/abc',
  'https://user@forms.gle/abc',
  'https://sub.forms.gle/abc',
]) {
  test(`classifyGoogleLink: ${url} is none`, () => {
    assert.equal(load('googleLink.js').classifyGoogleLink(url).outcome, 'none');
  });
}

// --- classifyGoogleLink: lookalikes and malformed input --------------------------------------------------------

for (const url of [
  'http://drive.google.com/x',
  'https://drive.google.com:8443/x',
  'https://user@drive.google.com/x',
  'https://user:pw@docs.google.com/x',
  'https://drive.google.com.evil.example/x',
  'https://docs.google.com.evil.example/x',
  'https://evil-docs.google.com/x',
  'https://xdocs.google.com/x',
  'https://sub.docs.google.com/x',
  'https://docs.google.com./x',
  'https://google.com/x',
  'file:///C:/x.html',
  'javascript:alert(1)',
  'data:text/html,hi',
  'mailto:a@b.example',
  'ftp://drive.google.com/x',
  'not a url',
  '',
]) {
  test(`classifyGoogleLink: lookalike or bad input ${JSON.stringify(url)} is none`, () => {
    assert.equal(load('googleLink.js').classifyGoogleLink(url).outcome, 'none');
  });
}

test('classifyGoogleLink: non-string input never throws and is none', () => {
  const { classifyGoogleLink } = load('googleLink.js');
  for (const v of [undefined, null, 42, {}, [], true, Symbol('x'), () => 1]) {
    assert.equal(classifyGoogleLink(v).outcome, 'none', String(typeof v));
  }
});

// --- wrapper: www.google.com/url?q= unwrapped once ------------------------------------------------------------------

test('wrapper: a Drive target opens an app window with the TARGET href, never the wrapper', () => {
  const r = load('googleLink.js').classifyGoogleLink(wrap(DRIVE_EXAMPLE));
  assert.equal(r.outcome, 'app-window');
  assert.equal(r.url, DRIVE_EXAMPLE);
});

test('wrapper: a forms.gle target is an app window with hop: true and the target href', () => {
  const r = load('googleLink.js').classifyGoogleLink(wrap('https://forms.gle/abc'));
  assert.equal(r.outcome, 'app-window');
  assert.equal(r.hop, true);
  assert.equal(r.url, 'https://forms.gle/abc');
});

test('wrapper: a Chat target is the main-window outcome with the target href', () => {
  const r = load('googleLink.js').classifyGoogleLink(wrap('https://chat.google.com/room/AAA'));
  assert.equal(r.outcome, 'main-window');
  assert.equal(r.url, 'https://chat.google.com/room/AAA');
});

for (const [name, url] of [
  ['duplicated q', `https://www.google.com/url?q=${encodeURIComponent(DRIVE_EXAMPLE)}&q=${encodeURIComponent('https://evil.example/')}`],
  ['wrapper inside a wrapper', wrap(wrap(DRIVE_EXAMPLE))],
  ['wrapper with a port', `https://www.google.com:8443/url?q=${encodeURIComponent(DRIVE_EXAMPLE)}`],
  ['wrapper with userinfo', `https://u@www.google.com/url?q=${encodeURIComponent(DRIVE_EXAMPLE)}`],
  ['wrapper over http', `http://www.google.com/url?q=${encodeURIComponent(DRIVE_EXAMPLE)}`],
  ['wrapper path not exactly /url', `https://www.google.com/url/x?q=${encodeURIComponent(DRIVE_EXAMPLE)}`],
  ['wrapper whose target is evil', wrap('https://drive.google.com.evil.example/x')],
  ['wrapper whose target is a lookalike', wrap('https://docs.google.com:8443/x')],
  ['wrapper with no q', 'https://www.google.com/url'],
  ['wrapper whose target is not a url', wrap('not a url')],
]) {
  test(`wrapper: ${name} is none`, () => {
    assert.equal(load('googleLink.js').classifyGoogleLink(url).outcome, 'none');
  });
}

// --- isGoogleNavigationUrl --------------------------------------------------------------------------------------------

for (const host of [...LINK_LIST_HOSTS, 'accounts.google.com']) {
  test(`isGoogleNavigationUrl: https://${host}/x is on the nav list`, () => {
    assert.equal(load('googleLink.js').isGoogleNavigationUrl(`https://${host}/x`), true);
  });
}

test('isGoogleNavigationUrl: uppercase host and default port pass', () => {
  const { isGoogleNavigationUrl } = load('googleLink.js');
  assert.equal(isGoogleNavigationUrl('https://DOCS.google.com:443/x'), true);
});

for (const url of [
  'https://drive.usercontent.google.com/download?id=1',
  'https://forms.gle/abc',
  'https://lh3.googleusercontent.com/x',
  'https://doc-0g-1k-docs.googleusercontent.com/x',
  'https://accounts.youtube.com/x',
  'https://chat.google.com/room/x',
  'https://meet.google.com/abc-defg-hij',
  'https://maps.google.com/',
  'https://www.google.com/url?q=https%3A%2F%2Fdrive.google.com%2Fx',
  'http://docs.google.com/x',
  'https://docs.google.com:8443/x',
  'https://u@docs.google.com/x',
  'https://docs.google.com.evil.example/x',
  'https://docs.google.com./x',
  'javascript:alert(1)',
  'garbage',
]) {
  test(`isGoogleNavigationUrl: ${url} is NOT on the nav list`, () => {
    assert.equal(load('googleLink.js').isGoogleNavigationUrl(url), false);
  });
}

test('isGoogleNavigationUrl: non-string input never throws and is false', () => {
  const { isGoogleNavigationUrl } = load('googleLink.js');
  for (const v of [undefined, null, 1, {}]) assert.equal(isGoogleNavigationUrl(v), false);
});

// --- isDownloadHop ----------------------------------------------------------------------------------------------------------

const USERCONTENT_DL = 'https://drive.usercontent.google.com/download?id=1&export=download';
const DRIVE_PAGE = 'https://drive.google.com/file/d/1/view';
const DOCS_PAGE = 'https://docs.google.com/document/d/1/edit';

test('isDownloadHop: a will-redirect to usercontent /download from a drive.google.com page is allowed', () => {
  const { isDownloadHop } = load('googleLink.js');
  assert.equal(isDownloadHop({ url: USERCONTENT_DL, fromUrl: DRIVE_PAGE, isRedirect: true, windowUrl: DRIVE_PAGE }), true);
});

test('isDownloadHop: a will-redirect to usercontent /download from a docs.google.com page is allowed', () => {
  const { isDownloadHop } = load('googleLink.js');
  assert.equal(isDownloadHop({ url: USERCONTENT_DL, fromUrl: DOCS_PAGE, isRedirect: true, windowUrl: DOCS_PAGE }), true);
});

test('isDownloadHop: the same URL as a non-redirect will-navigate from a drive page is refused', () => {
  const { isDownloadHop } = load('googleLink.js');
  assert.equal(isDownloadHop({ url: USERCONTENT_DL, fromUrl: DRIVE_PAGE, isRedirect: false, windowUrl: DRIVE_PAGE }), false);
});

for (const [name, fromUrl] of [
  ['a Chat page', 'https://chat.google.com/room/x'],
  ['a calendar page', 'https://calendar.google.com/x'],
  ['an evil page', 'https://evil.example/x'],
  ['a lookalike drive host', 'https://drive.google.com.evil.example/x'],
  ['no origin (a popup has no fromUrl)', undefined],
  ['an unparseable origin', 'not a url'],
]) {
  test(`isDownloadHop: a redirect started from ${name} is refused`, () => {
    const { isDownloadHop } = load('googleLink.js');
    assert.equal(isDownloadHop({ url: USERCONTENT_DL, fromUrl, isRedirect: true, windowUrl: fromUrl }), false);
  });
}

for (const url of [
  'https://drive.usercontent.google.com/download/x?id=1',
  'https://drive.usercontent.google.com/foo',
  'https://drive.usercontent.google.com/',
  'http://drive.usercontent.google.com/download?id=1',
  'https://drive.usercontent.google.com:8443/download?id=1',
  'https://u@drive.usercontent.google.com/download?id=1',
  'https://drive.usercontent.google.com.evil.example/download?id=1',
  'https://lh3.googleusercontent.com/download',
]) {
  test(`isDownloadHop: a redirect to ${url} is refused (path exactly /download, https, exact host)`, () => {
    const { isDownloadHop } = load('googleLink.js');
    assert.equal(isDownloadHop({ url, fromUrl: DRIVE_PAGE, isRedirect: true, windowUrl: DRIVE_PAGE }), false);
  });
}

test('isDownloadHop: the interstitial form submit back to /download?...&confirm= from a window on usercontent /download is allowed', () => {
  const { isDownloadHop } = load('googleLink.js');
  const windowUrl = 'https://drive.usercontent.google.com/download?id=1';
  const url = 'https://drive.usercontent.google.com/download?id=1&export=download&confirm=t&uuid=u';
  assert.equal(isDownloadHop({ url, fromUrl: windowUrl, isRedirect: false, windowUrl }), true);
});

test('isDownloadHop: a further navigation from the interstitial to another path on that host is refused', () => {
  const { isDownloadHop } = load('googleLink.js');
  const windowUrl = 'https://drive.usercontent.google.com/download?id=1';
  const url = 'https://drive.usercontent.google.com/other?id=1';
  assert.equal(isDownloadHop({ url, fromUrl: windowUrl, isRedirect: false, windowUrl }), false);
});

test('isDownloadHop: a navigation from the interstitial to another host is not a hop', () => {
  const { isDownloadHop } = load('googleLink.js');
  const windowUrl = 'https://drive.usercontent.google.com/download?id=1';
  assert.equal(isDownloadHop({ url: 'https://evil.example/download', fromUrl: windowUrl, isRedirect: false, windowUrl }), false);
});

test('isDownloadHop: a non-hop URL on a nav-list host is not a hop (it is judged by the nav list instead)', () => {
  const { isDownloadHop } = load('googleLink.js');
  assert.equal(isDownloadHop({ url: DOCS_PAGE, fromUrl: DRIVE_PAGE, isRedirect: true, windowUrl: DRIVE_PAGE }), false);
});

test('isDownloadHop: garbage input never throws and is false', () => {
  const { isDownloadHop } = load('googleLink.js');
  for (const v of [undefined, null, 1, 'x', {}, { url: 5 }, { url: USERCONTENT_DL }]) {
    assert.equal(isDownloadHop(v), false, JSON.stringify(v));
  }
});

// --- isDownloadHop: initial load of a brand-new window -------------------------------------------------------------

test('isDownloadHop initial load: a will-redirect to usercontent /download with fromUrl = the requested drive uc url and empty windowUrl is allowed', () => {
  const { isDownloadHop } = load('googleLink.js');
  const fromUrl = 'https://drive.google.com/uc?export=download&id=1';
  assert.equal(isDownloadHop({ url: USERCONTENT_DL, fromUrl, isRedirect: true, windowUrl: '' }), true);
});

test('isDownloadHop initial load: the same with a requested docs.google.com url is allowed', () => {
  const { isDownloadHop } = load('googleLink.js');
  assert.equal(isDownloadHop({ url: USERCONTENT_DL, fromUrl: 'https://docs.google.com/document/d/1/export?format=pdf', isRedirect: true, windowUrl: '' }), true);
});

for (const fromUrl of ['https://calendar.google.com/x', 'https://evil.example/x', 'https://chat.google.com/api/x']) {
  test(`isDownloadHop initial load: a requested url on ${fromUrl} is refused`, () => {
    const { isDownloadHop } = load('googleLink.js');
    assert.equal(isDownloadHop({ url: USERCONTENT_DL, fromUrl, isRedirect: true, windowUrl: '' }), false);
  });
}

for (const empty of ['', undefined, null]) {
  test(`isDownloadHop initial load: both fromUrl and windowUrl empty (${String(empty)}) is refused`, () => {
    const { isDownloadHop } = load('googleLink.js');
    assert.equal(isDownloadHop({ url: USERCONTENT_DL, fromUrl: empty, isRedirect: true, windowUrl: empty }), false);
  });
}

test('isDownloadHop initial load: a non-redirect to usercontent from the requested drive url is still refused', () => {
  const { isDownloadHop } = load('googleLink.js');
  assert.equal(isDownloadHop({ url: USERCONTENT_DL, fromUrl: 'https://drive.google.com/uc?id=1', isRedirect: false, windowUrl: '' }), false);
});

// --- DOWNLOAD_CHAIN_HOSTS and isDownloadChainUrl ----------------------------------------------------------------------------------

test('DOWNLOAD_CHAIN_HOSTS is frozen and empty', () => {
  const { DOWNLOAD_CHAIN_HOSTS } = load('googleLink.js');
  assert.equal(Object.isFrozen(DOWNLOAD_CHAIN_HOSTS), true);
  assert.equal(DOWNLOAD_CHAIN_HOSTS.length, 0);
});

for (const host of [...LINK_LIST_HOSTS, 'accounts.google.com']) {
  test(`isDownloadChainUrl: nav-list origin https://${host}/x is true`, () => {
    assert.equal(load('googleLink.js').isDownloadChainUrl(`https://${host}/x?y=1`), true);
  });
}

test('isDownloadChainUrl: usercontent /download (exact path) is true', () => {
  assert.equal(load('googleLink.js').isDownloadChainUrl(USERCONTENT_DL), true);
});

for (const url of [
  'https://drive.usercontent.google.com/other?id=1',
  'https://drive.usercontent.google.com/download/x',
  'https://drive.usercontent.google.com/',
  'https://lh3.googleusercontent.com/x',
  'https://doc-0g-1k-docs.googleusercontent.com/x',
  'https://forms.gle/abc',
  'https://chat.google.com/api/x',
  'https://meet.google.com/abc-defg-hij',
  'http://docs.google.com/x',
  'https://docs.google.com:8443/x',
  'https://u@docs.google.com/x',
  'https://docs.google.com.evil.example/x',
  'blob:https://docs.google.com/uuid',
  'garbage',
]) {
  test(`isDownloadChainUrl: ${url} is false (https only; blob: is unwrapped by downloads.js, not here)`, () => {
    assert.equal(load('googleLink.js').isDownloadChainUrl(url), false);
  });
}

test('isDownloadChainUrl: with a host injected, that exact host is true and a suffix or lookalike is false', () => {
  const { isDownloadChainUrl } = load('googleLink.js');
  const hosts = ['dl.example-google.test'];
  assert.equal(isDownloadChainUrl('https://dl.example-google.test/f', hosts), true);
  assert.equal(isDownloadChainUrl('https://evil.dl.example-google.test/f', hosts), false);
  assert.equal(isDownloadChainUrl('https://dl.example-google.test.evil.example/f', hosts), false);
  assert.equal(isDownloadChainUrl('https://xdl.example-google.test/f', hosts), false);
  assert.equal(isDownloadChainUrl('http://dl.example-google.test/f', hosts), false);
  assert.equal(isDownloadChainUrl('https://dl.example-google.test:8443/f', hosts), false);
});

test('isDownloadChainUrl: a download-chain host is never navigable (isGoogleNavigationUrl stays false)', () => {
  const { isGoogleNavigationUrl } = load('googleLink.js');
  assert.equal(isGoogleNavigationUrl('https://dl.example-google.test/f'), false);
});

test('isDownloadChainUrl: non-string input never throws and is false', () => {
  const { isDownloadChainUrl } = load('googleLink.js');
  for (const v of [undefined, null, 1, {}]) assert.equal(isDownloadChainUrl(v), false);
});

// --- classifyChatTarget -----------------------------------------------------------------------------------------------------------

const CONVERSATION_URLS = [
  'https://chat.google.com/',
  'https://chat.google.com/room/AAAA',
  'https://chat.google.com/dm/BBBB',
  'https://chat.google.com/space/CCCC',
  'https://chat.google.com/app/chat/DDDD',
  'https://chat.google.com/u/0/',
  'https://chat.google.com/u/1/room/AAAA',
  'https://chat.google.com/room/AAAA#msg',
];

const DOWNLOAD_URLS = [
  'https://chat.google.com/api/get_attachment_url?url_type=FIFE_URL',
  'https://chat.google.com/api/anything',
  'https://chat.google.com/u/0/api/get_attachment_url',
  'https://chat.google.com/attachment/xyz',
  'https://chat.google.com/download/file.pdf',
  'https://chat.google.com/files/download?id=1',
];

// Both a download shape and a conversation shape: the download shape wins (precedence).
const BOTH_SHAPES_URLS = [
  'https://chat.google.com/room/x/attachment/1',
  'https://chat.google.com/dm/y/download',
  'https://chat.google.com/u/2/space/z/attachment/9',
];

const UNKNOWN_URLS = [
  'https://chat.google.com/popout/room/AAAA',
  'https://chat.google.com/some-unknown-shape',
  'https://chat.google.com/mole/world',
];

for (const url of CONVERSATION_URLS) {
  test(`classifyChatTarget: conversation ${url} from source main -> focus-main (never loadURL)`, () => {
    assert.equal(load('googleLink.js').classifyChatTarget(url, 'main'), 'focus-main');
  });
  test(`classifyChatTarget: conversation ${url} from source app -> main-window`, () => {
    assert.equal(load('googleLink.js').classifyChatTarget(url, 'app'), 'main-window');
  });
}

for (const url of [...DOWNLOAD_URLS, ...BOTH_SHAPES_URLS]) {
  test(`classifyChatTarget: download shape ${url} from source main -> download`, () => {
    assert.equal(load('googleLink.js').classifyChatTarget(url, 'main'), 'download');
  });
  test(`classifyChatTarget: download shape ${url} from source app -> browser (an app window never drives a main-window download)`, () => {
    assert.equal(load('googleLink.js').classifyChatTarget(url, 'app'), 'browser');
  });
}

for (const url of UNKNOWN_URLS) {
  for (const source of ['main', 'app']) {
    test(`classifyChatTarget: pop-out or unknown ${url} from source ${source} -> browser (never the main window)`, () => {
      assert.equal(load('googleLink.js').classifyChatTarget(url, source), 'browser');
    });
  }
}

test('classifyChatTarget: a non-Chat, lookalike or garbage target -> browser and never throws', () => {
  const { classifyChatTarget } = load('googleLink.js');
  for (const source of ['main', 'app']) {
    for (const v of ['https://evil.example/room/x', 'https://chat.google.com.evil.example/room/x', 'http://chat.google.com/room/x', 'https://chat.google.com:8443/room/x', 'garbage', undefined, null, 5]) {
      assert.equal(classifyChatTarget(v, source), 'browser', `${source} ${String(v)}`);
    }
  }
});

test('classifyChatTarget: an unknown or missing source never throws and never yields a main-window load or a download', () => {
  const { classifyChatTarget } = load('googleLink.js');
  for (const source of [undefined, null, 'main-popup', 5]) {
    assert.doesNotThrow(() => classifyChatTarget('https://chat.google.com/room/A', source));
    assert.notEqual(classifyChatTarget('https://chat.google.com/room/A', source), 'main-window');
    assert.notEqual(classifyChatTarget('https://chat.google.com/api/x', source), 'download');
  }
});
