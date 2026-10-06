'use strict';

// UI-04 / FR-17, docs/architecture/google-app-windows.md sections 1, 2, 3, 7. The ONLY place that knows the
// Google host lists. Pure: no Electron import, no fs or process access, never throws for any input type.
//
// Origin rule (the Meet rule, meetLink.js): WHATWG URL parse; protocol === 'https:', hostname equal by exact
// string comparison, port === '' (the default :443 normalises away), no userinfo. No suffix, substring or
// wildcard match; a trailing-dot host never matches. www.google.com/url?q= is unwrapped ONCE.

const { CHAT_ORIGIN } = require('./origins');

const { unwrapTarget } = require('./wrapperUrl');

/** Hosts a link from Chat may open in a Google app window (section 2, "link list"). */
const LINK_LIST_HOSTS = Object.freeze([
  'drive.google.com',
  'docs.google.com',
  'calendar.google.com',
  'mail.google.com', // default, to be confirmed by the maintainer
  'keep.google.com', // default, to be confirmed by the maintainer
  'contacts.google.com', // default, to be confirmed by the maintainer
  'sites.google.com', // default, to be confirmed by the maintainer
]);

/** Re-authentication inside an app window: navigable, but never an entry point. */
const ACCOUNTS_HOST = 'accounts.google.com';

/** Hosts an already-open app window may move between (link list plus accounts.google.com). */
const NAV_LIST_HOSTS = Object.freeze([...LINK_LIST_HOSTS, ACCOUNTS_HOST]);

/** Google Forms short link: followed only through the entry hop (section 2). */
const ENTRY_HOP_HOST = 'forms.gle';

/** Serves user-controlled bytes: never navigable, only a download hop (section 2). */
const USERCONTENT_HOST = 'drive.usercontent.google.com';
const USERCONTENT_DOWNLOAD_PATH = '/download';

/**
 * Extra exact hosts tolerated ONLY as a hop of an app-window download chain. Initially empty; filled only
 * from spike evidence plus a maintainer decision, never a pattern, and never also added to the nav list.
 */
const DOWNLOAD_CHAIN_HOSTS = Object.freeze([]);

const CHAT_HOST = new URL(CHAT_ORIGIN).hostname;

// Hosts from which a server redirect may lead to the usercontent download endpoint.
const DOWNLOAD_HOP_SOURCE_HOSTS = Object.freeze(['drive.google.com', 'docs.google.com']);

function parse(input) {
  if (typeof input !== 'string') return null;
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

/** True for https, no port, no userinfo, and a hostname equal to one of `hosts` (exact). */
function isExactHttpsHost(u, hosts) {
  return (
    u !== null &&
    u.protocol === 'https:' &&
    u.port === '' &&
    u.username === '' &&
    u.password === '' &&
    hosts.includes(u.hostname)
  );
}

const GMAIL_HOST = 'mail.google.com';

/**
 * Gmail-integrated Chat: a mail.google.com URL whose path (after an optional /mail and /u/<n>) is /chat or
 * /chat/..., or whose hash route is #chat or #chat/... Returns the Chat-relative remainder
 * (lower-cased, e.g. '/space/AAAA' or '/') or null for any other Gmail URL ('#chatter', '/chatter' are not Chat).
 */
function gmailChatRest(u) {
  if (!isExactHttpsHost(u, [GMAIL_HOST])) return null;
  const strip = (p) => p.replace(/^\/mail(?=\/|$)/i, '').replace(/^\/u\/\d+(?=\/|$)/, '');
  let rest = null;
  const path = strip(u.pathname);
  if (/^\/chat(\/|$)/i.test(path)) rest = path.slice(5);
  else if (/^#chat(\/|$)/i.test(u.hash)) rest = u.hash.slice(5);
  if (rest === null) return null;
  rest = rest.replace(/^\/u\/\d+(?=\/|$)/, '');
  return (rest === '' ? '/' : rest).toLowerCase();
}

function classifyParsed(u) {
  if (isExactHttpsHost(u, [CHAT_HOST]) || gmailChatRest(u) !== null) return { outcome: 'main-window', url: u.href };
  if (isExactHttpsHost(u, LINK_LIST_HOSTS)) return { outcome: 'app-window', url: u.href };
  if (isExactHttpsHost(u, [ENTRY_HOP_HOST])) return { outcome: 'app-window', url: u.href, hop: true };
  return null;
}

/**
 * classifyGoogleLink(input) -> { outcome: 'main-window' | 'app-window' | 'none', url, hop? }
 * `url` is the normalised href of the TARGET (never the raw input or the wrapper); '' for 'none'.
 */
function classifyGoogleLink(input) {
  const NONE = { outcome: 'none', url: '' };
  const u = parse(input);
  if (u === null) return NONE;
  const direct = classifyParsed(u);
  if (direct) return direct;
  const target = unwrapTarget(u);
  if (target === null) return NONE;
  return classifyParsed(parse(target)) || NONE;
}

/** isGoogleNavigationUrl(url) - true for an exact nav-list origin (link list plus accounts.google.com). */
function isGoogleNavigationUrl(url) {
  return isExactHttpsHost(parse(url), NAV_LIST_HOSTS);
}

function isUsercontentDownload(u) {
  return isExactHttpsHost(u, [USERCONTENT_HOST]) && u.pathname === USERCONTENT_DOWNLOAD_PATH;
}

/**
 * isDownloadChainUrl(url, hosts = DOWNLOAD_CHAIN_HOSTS) - an https URL that may appear anywhere in an
 * app-window download chain: a nav-list origin, usercontent /download (path exactly), or an exact host of
 * `hosts`. `blob:` is unwrapped by downloads.js, not here. Never widens isGoogleNavigationUrl.
 */
function isDownloadChainUrl(url, hosts = DOWNLOAD_CHAIN_HOSTS) {
  const u = parse(url);
  if (u === null) return false;
  if (isExactHttpsHost(u, NAV_LIST_HOSTS)) return true;
  if (isUsercontentDownload(u)) return true;
  return Array.isArray(hosts) && hosts.length > 0 && isExactHttpsHost(u, hosts);
}

/**
 * isDownloadHop({ url, fromUrl, isRedirect, windowUrl }) - the download-hop rule of section 2, evaluated on
 * the main frame of an app window. The only way drive.usercontent.google.com is ever followed.
 *   - server-redirect hop: a redirect to usercontent /download from a drive/docs page. On a brand-new
 *     window's initial load there is no page yet (windowUrl empty), so the source is `fromUrl`, the
 *     REQUESTED url;
 *   - interstitial follow-up: from a window already on usercontent /download, a navigation to /download on
 *     the same host (redirect or not).
 * Anything else is false. Never throws.
 */
function isDownloadHop(arg) {
  if (!arg || typeof arg !== 'object') return false;
  const target = parse(arg.url);
  if (!isUsercontentDownload(target)) return false;
  const windowUrl = typeof arg.windowUrl === 'string' ? arg.windowUrl : '';
  const fromUrl = typeof arg.fromUrl === 'string' ? arg.fromUrl : '';
  const source = parse(windowUrl !== '' ? windowUrl : fromUrl);
  if (source === null) return false;
  if (isUsercontentDownload(source)) return true; // interstitial follow-up
  return arg.isRedirect === true && isExactHttpsHost(source, DOWNLOAD_HOP_SOURCE_HOSTS);
}

// --- Chat targets (section 3) ----------------------------------------------------------------------------------

// Provisional path shapes, as DATA, awaiting the manual "observe what Chat opens" run. A shape on no list
// defaults to the system browser, never the main window.
const CHAT_DOWNLOAD_PREFIXES = Object.freeze(['/api/']);
const CHAT_DOWNLOAD_WORDS = Object.freeze(['attachment', 'download']);
const CHAT_CONVERSATION_EXACT = Object.freeze(['/']);
const CHAT_CONVERSATION_PREFIXES = Object.freeze(['/room/', '/dm/', '/space/', '/app/']);

/**
 * classifyChatTarget(url, source) -> 'main-window' | 'focus-main' | 'download' | 'browser'
 * source: 'main' (a popup of the main window) | 'app' (a Google app window). A leading /u/<n> is stripped;
 * download shapes are tested BEFORE conversation shapes (they win). Any other source is treated as unknown
 * and can only yield 'browser'.
 */
function classifyChatTarget(url, source) {
  const u = parse(url);
  const gmailRest = gmailChatRest(u);
  if (gmailRest === null && !isExactHttpsHost(u, [CHAT_HOST])) return 'browser';
  if (source !== 'main' && source !== 'app') return 'browser';
  let lower;
  if (gmailRest !== null) {
    // Gmail-integrated Chat: the Chat-relative remainder; any non-download shape is a conversation.
    lower = gmailRest;
  } else {
    let path = u.pathname.replace(/^\/u\/\d+(?=\/|$)/, '');
    if (path === '') path = '/';
    lower = path.toLowerCase();
  }

  const isDownload =
    CHAT_DOWNLOAD_PREFIXES.some((p) => lower.startsWith(p)) || CHAT_DOWNLOAD_WORDS.some((w) => lower.includes(w));
  // A mail.google.com target never drives a main-window download (the main view stays on the chat origin).
  if (isDownload) return source === 'main' && gmailRest === null ? 'download' : 'browser';

  const isConversation =
    gmailRest !== null ||
    CHAT_CONVERSATION_EXACT.includes(lower) || CHAT_CONVERSATION_PREFIXES.some((p) => lower.startsWith(p));
  // Gmail Chat targets are NEVER loaded into the main window (it would leave the chat origin: notifications,
  // clipboard and unread are origin-bound): focus only, from both sources, until real-account evidence exists.
  if (isConversation) return source === 'main' || gmailRest !== null ? 'focus-main' : 'main-window';

  return 'browser';
}

module.exports = {
  LINK_LIST_HOSTS,
  NAV_LIST_HOSTS,
  ENTRY_HOP_HOST,
  USERCONTENT_HOST,
  DOWNLOAD_CHAIN_HOSTS,
  CHAT_ORIGIN,
  classifyGoogleLink,
  classifyChatTarget,
  isGoogleNavigationUrl,
  isDownloadHop,
  isDownloadChainUrl,
};
