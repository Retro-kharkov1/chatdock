# Sign-in Flow (FR-19)

<overview>
Design for letting the **main window** complete a Google sign-in that passes through the organisation's own
identity provider (IdP): SAML single sign-on (Okta, Microsoft Entra / Azure AD, ADFS, Ping, OneLogin, a
Google-hosted IdP, a custom domain), and second-step or passkey pages that live on another origin. Behaviour and
acceptance criteria: [FR-19](../business/requirements.md). Builds on [ADR-0001](../adr/0001-google-sign-in-strategy.md)
(why the main window signs in at all) and [Overview](overview.md); the standing rules are in
[Project Rules](project-rules.md) and are not restated. This feature is a **new exception** to the
security baseline's "navigation is checked against an allow-list", recorded there (fourth exception).

**Status: the mode (sections 1 to 3) is shipped** in `src/main/signInFlow.js` (the state machine and the two predicates)
and `src/main/signInWiring.js` (the main window's listeners, Back to Chat, the refused-step notice, the title setter),
bound once from `index.js`; it was exercised in a real Electron 44 run against local HTTPS stand-ins (entry (a) and (b),
the IdP page in the main window, title, no bridge, tray entry, refused-redirect notice once, download refusal,
`beforeunload`, exit). **Not yet done: the manual rows of section 8 with a real identity provider and a real Google
account** (and WebAuthn, section 5). The mode-independent hardening of section 4 shipped earlier. Section 4 marks each
row *shipped* or *pending* against the current code, and a *pending* row **must not be stated as a current fact** by any
document.

**Problem.** The main window's `will-navigate` list is `https://chat.google.com` and `https://accounts.google.com`
(`src/main/origins.js`, `src/main/index.js`, `linkRouter.onWillNavigate`). Server redirects are not checked
(`will-redirect` has no listener), so Chat to Google to IdP lands on the IdP page. The next step, started *by that
page* (a script, a form submit, a link), is a `will-navigate` to an origin that is not listed. It is prevented and
handed to the system browser, which has a different session: the sign-in dies half-way. The list cannot simply
be extended, because the IdP origin is different for every organisation.

**Decision.** A small state machine, **sign-in mode**, in the main process. While it is on, the main frame may
navigate to any acceptable `https` origin that is not a Google application host; when Chat loads again, the user
chooses "Back to Chat" in the tray, or a limit fires, it is off and the window is back on the fixed list.
Everything an origin can *do* (permissions, bridges, notifications, downloads) stays chat-only or blocked, so what
the mode widens is **where the window may go**, not what a page there may do.

**Not in scope / not supported:** Windows integrated authentication (Kerberos/NTLM single sign-on needs the Chromium
`auth-server-allowlist` switch and an administrator decision; unchanged, `login` events are not handled), IdPs on a
non-default port or an IP address (**not supported**, refused by section 2; an explicit setting is open question 2),
client certificates, and sign-in inside Google app windows or the Meet call window (unchanged).
</overview>

<architecture>
## 1. Sign-in mode: states and transitions

One boolean plus a few counters per main window, owned by a pure factory `createSignInFlow` in
`src/main/signInFlow.js` (no Electron import; every collaborator injected, like `linkRouter.js`).

All main-frame events below are filtered the same way: **`isMainFrame === true` and `isSameDocument !== true`**
(read from the event details object, to be confirmed by the implementer against `node_modules/electron/electron.d.ts`
for Electron 44). A subframe event, in particular a subframe `will-redirect`, **never** cancels, allows or counts
anything: it cannot cancel the top navigation and cannot drive the mode.

| Event (main frame, not same-document) | Mode off | Mode on |
|---|---|---|
| Main frame **commits** (`did-navigate`) on exactly `https://accounts.google.com` | **Entry** (a): mode on, start timers | refresh the idle timer; counts as a hop only if the origin changed |
| Main frame **commits** on an acceptable, non-refused origin and the navigation **chain passed through `accounts.google.com`** (below) | **Entry** (b): mode on, start timers | refresh the idle timer; hop rule as above |
| `will-navigate` to an acceptable `https` URL (section 2) that is not refused | normal rule (fixed list, then router) | **allowed** |
| `will-redirect` to an acceptable `https` URL | not checked (unchanged, see residual risk below) | allowed |
| `will-redirect` to anything else (non-`https`, userinfo, port, IP literal, internal-name or IDN host, refused host) | not checked | `preventDefault()`: the **whole navigation is cancelled** (nothing opens in the browser), scheme logged, and the **refused-step notice** (section 3a) is shown once per sign-in |
| `will-navigate` to anything else (including `http:` and refused hosts) | normal rule: router (browser, Meet call window, Google app window) | normal rule: router (the order Meet, Google app, browser is unchanged for what the mode refuses) |
| Main frame **commits** on `https://chat.google.com` (or the dev loopback origin) | no-op | **Exit** (`signed-in`) |
| Idle timer fires (no main-frame commit for **10 minutes**) or hard cap fires (**30 minutes** since entry) | n/a | **Abort** (`timeout`) |
| More than **40 cross-origin main-frame commits** since entry | n/a | **Abort** (`hop-cap`) |
| Tray "Back to Chat" (section 3a) or the "Back to Chat" button of the refused-step notice (section 3a) | entry not shown; if reached anyway (a stale notice) **no-op**, the abort does nothing and `START_URL` is not loaded | **Abort** (`user`) |
| Main window destroyed, app quitting | clear timers | clear timers, mode off (**not** an abort: nothing is loaded, no reason is recorded) |

**Hop counting.** The entry commit sets the baseline origin and the counter to zero. A later commit counts as one
hop **only if its origin differs from the previous commit's origin**; page steps inside one origin (a typical IdP
form sequence) only refresh the idle timer. The limit is 40 (the previous draft's 20 same-or-cross commits was too
low for multi-step IdPs). It exists to bound a redirect loop, not to measure a legitimate sign-in.

**Entry conditions, decided.**
- (a) Any main-frame commit on exactly `accounts.google.com`, whatever the path. Rejected: a path list
  (`/v3/signin`, `/ServiceLogin`, `/o/saml2`, ...), because it rots whenever Google renames a step. It is safe as a
  trigger because that origin is already allowed in the main window and its only role there is sign-in.
- (b) **Returning user auto-redirected to the IdP**: Chat redirects to `accounts.google.com`, which redirects at once
  to the IdP, so the window may never *commit* on `accounts.google.com`. The factory therefore also tracks the
  navigation chain with a per-navigation flag *chain-via-sign-in*. **Order is fixed:** on every main-frame
  `did-start-navigation` the flag is first **cleared** and then **set** if that navigation's own target is exactly
  `accounts.google.com`; each later **`will-redirect`** of the same navigation (main frame, not same-document; this is
  the redirect source, `did-redirect-navigation` is not used) only **sets** it when its target is exactly
  `accounts.google.com`, and never clears it. The flag is also cleared when a main-frame commit consumes it and on a
  main-frame load failure. (Clear-then-set means a flag from an abandoned navigation cannot leak into the next one.)
  If the commit that consumes the flag is on an
  acceptable, non-refused, non-Chat origin, the mode turns on (entry b). Entry is on **commit**, never on
  `will-redirect`, so a navigation that is cancelled or fails cannot flip the mode. While the mode is still off, the
  redirect hops themselves are unchecked (unchanged behaviour); the flag only decides whether the landing page starts
  the mode. A Chat page that bounces through `accounts.google.com` and back to Chat for a session refresh commits on
  Chat, consumes the flag without entry, and changes nothing. A session-refresh bounce that *does commit* on
  `accounts.google.com` briefly turns the mode on (entry a) and off again when Chat commits; this is harmless and
  not special-cased.

**Exit.**
- *Signed in or returned:* a main-frame commit on the exact Chat origin (not a lookalike host: the comparison is on
  the parsed origin, never a substring). A page that bounces through `accounts.google.com` for a session refresh
  simply re-enters and exits again.
- *Abort* has exactly **four causes**, three reasons: the idle timer (10 minutes, reason `timeout`), the hard cap
  (30 minutes, reason `timeout`), the hop cap (40 cross-origin commits, `hop-cap`) and the user's "Back to Chat"
  (`user`). It is the single path that clears timers, turns the mode off and
  returns the window to **`START_URL`** (the generic Chat root, never a private address). A destroyed main window or
  a quit is **not** an abort: it only clears the timers (`dispose()`), loads nothing and records no reason. If the user is still signed
  out, Chat redirects to `accounts.google.com` and a *new* sign-in begins with fresh timers. Consequence: an app
  left on a sign-in page reloads it every 10 minutes; accepted, the alternative is a window stuck on a third-party
  page. Timers: the idle timer is reset by every main-frame commit, so a user typing a code or waiting for a phone
  prompt on one page is not interrupted before 10 minutes, and no sign-in lasts beyond 30.
- **Abort overrides the page's `beforeunload`.** A sign-in page (or a hostile one) may register a `beforeunload`
  prompt, which would hold the window on the page and defeat the timeout. While an abort is in progress
  (`isAborting()` is true: set by `abort()` immediately before `loadStartUrl()`), the main window's
  `will-prevent-unload` handler calls `event.preventDefault()` (Electron: this ignores the `beforeunload` handler and
  lets the page unload) and does nothing else. `isAborting()` is cleared **only** by (1) a main-frame commit on the
  origin of `START_URL` (not by any other commit: an unrelated commit mid-abort, for example the page's own
  navigation racing the load, must not end the override early), (2) a main-frame load failure, or (3) a 10 s
  safety timer. The existing quit guard (`quitGuard.guardContents`) on the same contents only calls `preventDefault()`
  while a quit is in progress; **when nobody calls `preventDefault()` Chromium shows its default "leave site"
  confirmation**, which is what would hold the window on the page. So the abort override must run for the same event:
  the wiring registers it on the main contents (listener order or an explicit check inside the guard; the implementer
  chooses) and a test pins the **outcome**: after an abort the unload proceeds without a dialog. With no abort in
  progress and no quit, nothing changes from today. Result: the window always returns to `START_URL`.
- *Window closed (X) or hidden:* **does not exit the mode** (open question 1). Closing hides the window and the page
  keeps running (*Hidden window must stay live*); a push approval ("tap yes on your phone") completes in the
  background and navigates the page, and aborting on hide would destroy that. Hidden time still counts against the
  same timers, so the window is back on Chat after at most 30 minutes.

**What the mode never does:** it does not change the session partition, the user agent, `webPreferences`, or any
permission handler; it does not inject anything; it does not read the page. It answers "may the main frame go to
this URL right now", cancels downloads (section 4), sets the window's native title to the current site and host,
and shows one native notice when it cancels a redirect (section 3a).

**Residual risk, stated.** `will-redirect` has no listener today, so with the mode **off** a server redirect
from an allowed origin to any origin still loads in the main window (unchanged). Putting a check there is not done
in this change because Chat legitimately redirects between Google hosts for some Workspace setups (for example
Gmail-hosted Chat) and cancelling a redirect cancels the whole navigation (Electron: `will-redirect` "Calling
`event.preventDefault()` will prevent the navigation (not just the redirect)"). It is mitigated by section 4, which
makes **any non-Chat page in the main window inert**: no bridge, no injected script, no IPC accepted, no permission,
no download. Tightening redirects with the mode off is open question 3. With the mode **on**, a redirect to a refused
host (for example an IdP that ends by redirecting to a Google application host) is cancelled and the window stays on
the previous page until a limit or "Back to Chat" returns it; if the manual runs show a legitimate chain doing this,
the host is reconsidered by evidence, not by a wildcard.

## 2. What an acceptable IdP URL is (security)

`isAcceptableIdpUrl(url)` is the single definition of "acceptable" (pure, exported, unit-tested table) and contains
**the first six rules below only; it does not know the refused set**. The refused set is a **separate check**
(`isRefusedHost(url)`, below) and every decision point combines them: *acceptable and not refused*. Neither predicate
is defined in terms of the other. Parse with WHATWG `URL` and
**validate the parsed `hostname`** (never the raw string: the parser already normalises `0x7f.1`, `2130706433`,
`127.1`, uppercase and percent forms, and the rules below apply to the result). Otherwise it returns false and nothing
throws (non-string or unparseable input is false):

| Rule | Reason |
|---|---|
| `protocol === 'https:'` | No `http`, `file`, `data`, `javascript`, `blob`, `about`, `view-source`, custom schemes. |
| `username === ''` and `password === ''` | `https://chat.google.com@evil.example` shape. |
| `port === ''` | Default `:443` normalises away; no non-default port (**not supported**, open question 2). |
| parsed hostname is not an IPv4 literal (dotted quad after normalisation, so `0x7f.1` and `2130706433` become `127.0.0.1` and are refused) and not an IPv6 literal (`[...]`) | Local-network and obfuscated-address confusion. IP-address IdPs are **not supported**. |
| hostname is not `localhost`, does not end in `.localhost`, does not end in `.local`, does not end in `.` | Loopback, mDNS and trailing-dot confusion. |
| **no label of the hostname starts with `xn--`** | Internationalised (punycode) hosts are refused **in the mode**, because the page cannot be told apart from a lookalike and the window has no address bar. A legitimate IDN-hosted IdP is therefore **not supported**; the cost is accepted. |

The refused-set rule is **not** part of this table: see the next heading.

**Single-label and internal hostnames are accepted** (`https://adfs/`, `adfs.corp.example`): on-premises ADFS and
similar IdPs commonly use them and refusing them would break exactly the target users. **Risk, stated:** a hostile
redirect can therefore place the window on a page served by a machine on the user's own network. It is bounded by
Chromium's TLS validation (no certificate override is added, so the host needs a certificate trusted by the OS), by
the inert-page rules of section 4, by the limits above, and by the host shown in the window title (section 3a).

**Refused set (`isRefusedHost`, mode on, main window only).** A Google application host or content host must keep its
own routing. These are never loaded in the main window during the mode and keep their
**normal routing** (Meet to the call window, a Google application host to a Google app window, anything else to the
system browser) when reached by `will-navigate`; a *redirect* to one is cancelled:
- every Google application host in `LINK_LIST_HOSTS` of `src/main/googleLink.js` (currently `drive`, `docs`,
  `calendar`, `mail`, `keep`, `contacts`, `sites`, all `.google.com`) and `ENTRY_HOP_HOST` (`forms.gle`) and
  `USERCONTENT_HOST` (`drive.usercontent.google.com`), **imported from `googleLink.js`, never copied**, so a list
  change there changes this set;
- `meet.google.com` (media permissions are granted to it, `meetPermissions.js`, so it must stay in the call window);
- `googleusercontent.com` and every `*.googleusercontent.com` host (user-controlled content, never a navigation
  target, see the second exception in [Project Rules](project-rules.md)).

`https://chat.google.com` is not refused: it is the exit. `accounts.google.com` is not refused: it is the entry origin
and already on the fixed list. Other `google.com` hosts (for example `www.google.com`) are ordinary acceptable hosts.

The check applies to the **main frame only**. Subframe navigation (IdP login iframes, Google's own sync frames) is
not restricted by this feature or by today's code (`will-navigate` is main-frame only; Electron `will-frame-navigate`
covers subframes and is not used). No URL is ever logged; a refusal logs the scheme only (as `linkRouter.js`).

Everything the mode allows is still subject to Chromium's own TLS checks: no `certificate-error` or
`setCertificateVerifyProc` override is added, so an IdP with an untrusted certificate fails to load rather than
being waved through.

## 3. Popups, links and the captive state

- **Popups** (`setWindowOpenHandler`) are **unchanged and always denied**; the target goes through the router
  (system browser for `https`, as today). There is no in-app sign-in popup window. Reason: the flows that need a
  popup with `window.opener` (OAuth-style) are not the sign-in of Chat; WebAuthn and passkeys use
  `navigator.credentials`, not a popup (section 5). A "Help" or "Privacy" link on an IdP page almost always opens
  in a new tab, so it correctly goes to the system browser.
- **Same-tab link click on an IdP page to a non-IdP site.** This **cannot be told apart** from an IdP step
  (a "Sign in with Okta" button is also a user-initiated GET to another origin). Electron's
  `will-navigate` details carry the URL, `isMainFrame`, `frame` and `initiator` only, no user-gesture flag, and
  `Sec-Fetch-User` does not separate a link from a submit button. Decision: such a click **stays in the window**
  and the user is bounded by the mode's limits (10 minutes idle, 30 minutes, 40 cross-origin commits) or leaves with
  "Back to Chat", after which the window returns to Chat. A **new-tab/`target=_blank` click goes to the system
  browser**. An `http:` same-tab link is not loaded in the window either: it goes to the system browser through the
  router (it is a `will-navigate`, not a redirect). Stated as a limitation in FR-19.

### 3a. What the user can see and do (native surfaces only)

No in-window UI is drawn (*Design scaled to the wrapper*); the two surfaces below are native and get a wording spec,
not a mockup.

- **Window title shows the site, then the host.** While the mode is on, the main window's native title is
  `Sign-in · <registrable domain> — <full host>` of the current main-frame page, **registrable domain first** (eTLD+1),
  for example `Sign-in · evil.example — signin-verify.evil.example`, so a long or truncated title cannot hide the real
  domain behind a deceptive subdomain. When the host is itself the registrable domain the host is not repeated
  (`Sign-in · login.example`). The title is set on each main-frame commit. The registrable domain comes from the
  Public Suffix List (the implementer picks the means, for example a small bundled library, and records it); if it
  cannot be determined (single-label intranet host such as `adfs`, or an unknown suffix) the title is
  `Sign-in · <full host>`. The page's own title is not used
  for the window during the mode: the wiring `preventDefault()`s **the `BrowserWindow`'s** `page-title-updated` (the
  event whose `preventDefault()` "will prevent the native window's title from changing"; the `webContents` event of the
  same name is only a notification, and preventing it changes nothing, which a real run showed) for the main window only
  while `isActive()`, and calls `setWindowTitle(title)`. On exit or abort the wiring stops preventing and restores the title
  from the contents' own title, so Chat's title (and `(N)` unread prefix handling, which is separate, section 4)
  behaves as today. The host is the parsed hostname (an IDN host would show punycode, but it is refused anyway).
  This is the only anti-spoofing cue the window can give without an address bar; it does not replace the user's care.
- **Tray entry "Back to Chat".** A new item in the tray context menu ([Tray Lifecycle](tray-lifecycle.md)), **visible
  only while the mode is on**, placed directly after "Show/Hide Google Chat". Label exactly `Back to Chat`. Action:
  `abort('user')` (cancels the mode, loads `START_URL` with the `beforeunload` override of section 1), then shows,
  raises and focuses the main window (it is the way out of a wrong page, so the window must be seen). **When the mode
  is off the abort is a no-op** (nothing is loaded, no state changes) but the main window is **still shown and
  focused**, so a click on a stale menu item is harmless. No tooltip
  change, no confirm dialog. The menu is rebuilt event-driven when the mode turns on or off (`onModeChange`), not from
  the blink tick, so NFR-06 holds. This replaces the first draft's "no escape except the timeout".
  **Desktops without a tray** (some Linux sessions) have no such entry and only the timers (10 minutes idle, 30 in
  total, 40 cross-origin commits) bound the mode; accepted and stated in FR-19.
- **Refused-step notice.** When the mode cancels a **redirect** (section 1 table), the user would otherwise see a page
  that silently stays put. The wiring shows **one native message box per sign-in** (a flag reset when the mode turns
  on; later cancelled redirects in the same sign-in show nothing), non-blocking (`dialog.showMessageBox`, not awaited
  by the navigation path), attached to the main window when it is visible and unattached when it is hidden. Wording
  spec (English, neutral; the URL and host are **not** shown, per the no-URL rule): title/message **"This sign-in step
  can't open in the app"**; detail "The page asked to continue somewhere the app does not open. You can go back to
  Chat and start the sign-in again, or close this message and keep using this page."; two buttons, **"Back to
  Chat"** (default; `abort('user')`, then show and focus the window, a no-op abort if the mode has already ended)
  and **"Close"** (dismiss, nothing else; also the result of Escape or closing the box). It is an injected
  collaborator (`notifyRefusedStep`), so the factory stays Electron-free. No new window or in-page UI.

## 4. No new authority for IdP pages

The mode widens navigation only. The following hold for **every origin other than the Chat origin** (and the dev
loopback origin) in the main window, with or without the mode. **The status column is the truth about the code
today**, checked against `src/main/index.js`, `mainFrameGate.js`, `notifications.js`, `src/preload/preload.js` and
`src/preload/serviceWorkerPreload.js`; the "Today" column describes the state *before* the hardening. The behaviour of
the shipped rows is recorded in [IPC Contract](ipc-contract.md) "Origin gating".

| Surface | Today | Required | Status |
|---|---|---|---|
| Permissions (`session.js`) | notifications and clipboard-sanitized-write by exact requesting origin (chat only); Meet/Google-app grants need their own origins | **No change**; pinned by a test that an IdP origin, as requester and as top-level origin, is denied every permission (notifications, clipboard, media, fullscreen, display capture). | holds today; the full pin (IdP origin as requester and as top-level origin, every permission) is **shipped** (`test/signInPermissions.test.js`, next to `test/sessionPermissions.test.js`) |
| Preload `contextBridge` (`__gcdBridge`) | exposed to **whatever the main window loads**, including `accounts.google.com` (the preload runs per document, `src/preload/preload.js`) | **Change.** The preload checks `location.origin` first (main frame only) and, when it is not the Chat origin, does nothing: no `exposeInMainWorld`, no listeners. **`CHAT_ORIGIN` is hard-coded in the preload** (a sandboxed preload cannot `require` the main-process modules; a test asserts it equals `origins.js` `CHAT_ORIGIN`). **Dev loopback origin, as implemented:** there is no dev constant. Only when `location.origin` matches an `http://localhost` or `http://127.0.0.1` (optional port) pattern does the preload ask main **synchronously** (`ipcRenderer.sendSync('gcd:bridge-probe')`); main answers from the transport (`event.senderFrame`, the main window's own contents, its main frame currently on one of `NOTIFICATION_ORIGINS`), so the answer is `true` only for the chat origin or, in an **unpackaged** run with `GCD_DEV_START_URL`, that loopback origin. No `process.argv`, `additionalArguments`, environment variable or page input decides it. The probe **cannot be answered `true` for any other origin** (an IdP, `accounts.google.com`, a packaged-build loopback page): the preload never asks off the loopback pattern and main re-checks the sender. Residual: in an unpackaged dev run the loopback page gets the bridge by design. | **shipped** (`preload.js`, `mainFrameGate.js` `registerBridgeProbe`) |
| Smart-copy detector (`smartcopy:signal`, inside the same preload) | installed on every document it loads; main rejects any sender not on a chat origin (`smartCopy.js`) | **Change.** Same guard: the detector is not installed off-origin, so no listener runs on a password page. Main-side rejection stays as the second layer. | **shipped** (`installSmartCopyDetector()` runs only inside the same `isOwnerOfBridge()` guard) |
| Notification-bridge injection (`executeJavaScript` on `dom-ready` and `did-finish-load`, `injectNotificationBridge` in `index.js`) | runs on whatever page is loaded | **Change.** The origin check lives **inside `injectNotificationBridge` itself** (main frame URL origin must be the Chat origin or the dev origin, else return), so every caller (`dom-ready`, `did-finish-load`, tray Mute, `settings:set`) is covered by one check and a new caller cannot forget it. The check **reuses `mainFrameGate.isChatMainFrame(webContents, NOTIFICATION_ORIGINS)`**; the sign-in factory adds no parallel "is chat page" predicate. | **shipped** (`notifications.js` `createNotificationBridgeInjector`) |
| Unread count: title listener (`page-title-updated`, `attachUnreadTitleListener`) **and** the seeding in the `did-finish-load` handler (`unread.onPageLoaded(parseUnreadCount(getTitle()))`, `index.js`, `did-finish-load` handler) | both trust any title | **Change.** Both are gated on the main frame being on a notification origin through **`mainFrameGate.isChatMainFrame`** (the listener takes it as a predicate and fails closed without one; the seeding uses `readTrustedUnreadCount`). The seeding path is gated too, otherwise an IdP page title like `(99) x` at load time seeds the shared baseline and raises the tray badge or blink. | **shipped** |
| `notification:clicked` IPC | validated against the **navigation** list (includes `accounts.google.com`) | **Change.** Validated against the notification (chat-only) list like the other channels. The navigation list is then used only for `will-navigate`. | **shipped** (`mainFrameGuard.accept`, which also requires the sender to be the main window's own main frame) |
| Service-worker preload (`__gcdSwBridge`) | session-level, so it is registered for service workers of **any** origin in the session; main accepts only worker scopes on the chat list | The worker preload is gated to the Chat origin as well (the same hard-coded `CHAT_ORIGIN`), so an IdP origin's service worker gets no bridge. The worker's isolated world has no `self`/`location`, so the origin is read in the worker's main world with `contextBridge.executeInMainWorld` before anything is exposed; a failed read means "not chat". There is no dev-origin path in the worker preload (a loopback worker gets no bridge). Main also drops every message whose worker scope is not on the chat list (second layer). | **shipped** (`serviceWorkerPreload.js`; main-side check also holds) |
| Downloads from the main window | the single session listener: a save dialog is always shown; **the origin check is the scheme only (`https` or `blob:`), no host and no redirect-chain check** (`downloads.js` header). The strict final-URL-and-chain check applies to **app windows** only. | **Change, mode only.** While `isActive()`, **every** main-window download is cancelled and a native notice is shown (coalesced per window, as `downloads.js` `showBlockedNotice`). The notice uses **sign-in-specific wording** ("Download blocked" as title; detail "Downloads are not allowed while you sign in. Finish signing in, then try again.") and **offers no "Open in browser"** action, because the existing notice's action would hand the download URL of an untrusted page to the system browser. The downloads module receives an injected `isMainDownloadBlocked()` predicate (`signInFlow.isActive`) and picks the wording from it. **Outside the mode nothing changes**, including the existing notice. A download is not part of a sign-in, so cancelling is a pure refusal of an IdP page's download. | **shipped** (`downloads.js` `isMainDownloadBlocked`, bound to `signInFlow.isActive` in `index.js`; the sign-in notice text is in the `message` field, as the existing notice's text is) |
| `nodeIntegration`, `contextIsolation`, `sandbox`, `webSecurity`, `webviewTag` | per baseline | **No change.** The mode creates no window and sets no `webPreferences`. | holds today |

`ipc-contract.md` records the origin-gating rows; the download rule is stated in the `downloads.js` header and here, and
`overview.md` and `tray-lifecycle.md` describe the mode and the tray entry as shipped.

## 5. WebAuthn, security keys and passkeys (evidence and what is not known)

What is established from the Electron 44.4.3 type definitions (`node_modules/electron/electron.d.ts`):
- `app.configureWebAuthn` exists for **macOS only** (`@platform darwin`, Touch ID platform authenticator); "until this is
  called ... platform-authenticator requests are not serviced". macOS is out of scope for this application.
- `session` `select-webauthn-account` is emitted when `navigator.credentials.get()` finds several discoverable credentials
  and "may also fire on other platforms when a roaming FIDO2 authenticator returns multiple discoverable
  credentials". **With no listener the request is cancelled** (`NotAllowedError`). The application has no listener
  today, so a roaming key holding several passkeys for one site would cancel.
- Nothing in the type definitions describes a native prompt on Windows or Linux.

What is **not** established and is therefore a manual verification, not an assumption: whether a **USB/NFC security
key** (touch prompt), **Windows Hello / platform passkey** (Windows) and **a phone as a passkey (hybrid/QR)**
complete in Electron 44 on Windows 11 and on Linux, with and without the discoverable-credential account choice.
The sign-in does not depend on them in the common case, because Google offers other second steps (prompt, code,
backup code), but an IdP that *requires* a security key would be blocked. Decision: no application code for WebAuthn in this
change; `select-webauthn-account` handling (an app-drawn chooser) is added **only if** the manual run shows the
multi-credential case failing, as a separate decision (it is a new surface). The recorded outcome per
platform goes into FR-19's manual rows.

## 6. Interaction with the rest of the application

| Area | Effect |
|---|---|
| Notifications and unread ([Notifications](notifications.md)) | While an IdP page shows, nothing arrives from it: bridge absent, title ignored (listener and load-time seeding), IPC and service-worker channels chat-only. The last unread count is kept, and refreshed by the first Chat title after exit. No behaviour change when the mode is off. |
| Hidden-window rule | Unchanged; the mode runs while hidden (section 1). |
| Quit only from the tray | Unchanged. Timers are cleared on quit and created `unref`ed, so they never delay exit. A `beforeunload` prompt on an IdP page is treated by the existing quit guard exactly like one from Chat, **except** during an abort, where it is overridden (section 1). "Back to Chat" is an extra tray entry; it is not a quit path. A destroyed window or a quit clears the timers only (no abort). |
| Meet call window, Google app windows ([Google App Windows](google-app-windows.md)) | Unchanged. Their navigation lists, popups and `accounts.google.com` handling are separate. A Meet link or a Google application link in the main window during the mode is **refused by the mode** (section 2) and so reaches the router as today: Meet to the call window, a listed Google application host to a Google app window. |
| Router order | The router's own order (Meet, Chat, Google app, browser) is unchanged. The mode adds **one step before the router** for `will-navigate`: allowed if the fixed list says so, else allowed if the mode permits, else the router. What the mode refuses falls through to the router in its existing order. |
| Downloads ([Google App Windows](google-app-windows.md) section 4) | Main-window downloads are cancelled while the mode is on, with sign-in-specific wording and no "Open in browser" (section 4); app-window downloads are unaffected. |
| Tray ([Tray Lifecycle](tray-lifecycle.md)) | One conditional entry "Back to Chat" (section 3a). |
| Session, user agent ([ADR-0001](../adr/0001-google-sign-in-strategy.md)) | Unchanged. |

## 7. Contracts

```js
// src/main/signInFlow.js - pure factory, no Electron import.
createSignInFlow({
  chatOrigins,          // string[]: the same NOTIFICATION_ORIGINS index.js passes to mainFrameGate; exit origins
                        //   (exit test = mainFrameGate.urlOrigin(url) in chatOrigins; no new isChatPage)
  signInOrigin,         // 'https://accounts.google.com'; entry origin
  refusedHosts,         // string[]: LINK_LIST_HOSTS + forms.gle + drive.usercontent.google.com + meet.google.com,
                        //           built in index.js from googleLink.js / meet constants, never literals here
  refusedHostSuffixes,  // string[]: ['googleusercontent.com'] (matches the host and every subdomain)
  startUrl,             // START_URL
  loadStartUrl,         // () => void   (index.js: mainWindow.loadURL(startUrl))
  setWindowTitle,       // (title: string | null) => void  native title "Sign-in · <eTLD+1> — <host>"; null restores
  notifyRefusedStep,    // () => void   shows the once-per-sign-in refused-step notice (section 3a); its "Back to Chat"
                        //   button calls abort('user') from the wiring
  onModeChange,         // (active: boolean) => void       index.js: refresh the tray menu
  setTimer, clearTimer, // injected, default setTimeout/clearTimeout; timers unref'd
  log,                  // (...args) => void; scheme only, never a URL
  idleMs = 10 * 60 * 1000, capMs = 30 * 60 * 1000, maxHops = 40,
}) -> {
  isActive(): boolean,
  isAborting(): boolean,                         // true from abort() until a commit on START_URL's origin, a load
                                                 //   failure, or the 10 s safety timer
  allowNavigation(url): boolean,                 // will-navigate: mode on, isAcceptableIdpUrl and not isRefusedHost
  onStartNavigation(url, details): void,         // did-start-navigation: clear chain-via-sign-in, THEN set if url is
                                                 //   on accounts.google.com
  onWillRedirect(event, url, details): void,     // main frame, not same-document only; mode on and not (acceptable and
                                                 //   not refused): preventDefault + notifyRefusedStep (once per sign-in);
                                                 //   also sets (never clears) chain-via-sign-in when url is on accounts.google.com
  onCommitted(url, details): void,               // entry (a)/(b), refresh, hop count, exit
  onLoadFailed(details): void,                   // clears chain-via-sign-in
  abort(reason): void,                           // 'timeout' | 'hop-cap' | 'user'; idempotent; a no-op when the mode is off
  dispose(): void,                               // clears timers only (window destroyed / quit); not an abort
}
isAcceptableIdpUrl(url): boolean                 // exported, section 2: the six rules only, NO refused-set check
isRefusedHost(url): boolean                      // exported, section 2: the refused set only
```

`details` is `{ isMainFrame, isSameDocument }` taken from the Electron event; the factory ignores any call where
`isMainFrame !== true` or `isSameDocument === true`.

`linkRouter.onWillNavigate(event, url, { allowedOrigins, source, allow })` gains the optional `allow(url) => boolean`;
absent, behaviour is byte-for-byte today's; a throwing `allow` fails closed (router path). Wiring in `index.js`:
`will-navigate` passes `allow: signInFlow.allowNavigation`; `did-start-navigation`, `will-redirect`, `did-navigate`
and `did-fail-load` call the matching methods; `page-title-updated` is `preventDefault()`ed while `isActive()`;
`will-prevent-unload` consults `isAborting()` (next to `quitGuard.guardContents`, section 1). **As built**, that glue is the
module `src/main/signInWiring.js` (`bindSignInFlow`, `createBackToChat`, `createRefusedStepNotice`, `createTitleSetter`),
which `index.js` calls once, so it is unit-testable; `bindSignInFlow` owns the main window's `will-navigate`, and
`index.js` registers none of its own; the downloads module gets `isMainDownloadBlocked: signInFlow.isActive`;
the tray menu builder adds "Back to Chat" while `isActive()` and its click calls `abort('user')` then shows the main
window (and, with the mode off, still just shows and focuses it); `closed` calls `dispose()`.

## 8. Test coverage map

Unit tests use stubbed Electron and injected timers, like the existing suites (`test/linkRouter.test.js`,
`test/smartCopyPreload.test.js`, `test/sessionPermissions.test.js`). Written first (*Coverage-First*), green on
today's behaviour where the behaviour already exists.

| Area | Kind | Test file | Cases |
|---|---|---|---|
| `isAcceptableIdpUrl` | U | `test/signInFlow.test.js` | accepts `https://login.example.com/x`, uppercase host, single-label internal host (`https://adfs/`), `adfs.corp.example`, `www.google.com`, and the lookalike `chat.google.com.evil.example` (an ordinary acceptable host; `mainFrameGate.isChatMainFrame` is false for it); also accepts `meet.google.com` and `docs.google.com` **(proving the predicate has no refused-set rule)**; rejects `http:`, `file:`, `data:`, `javascript:`, `blob:`, `about:blank`, userinfo (`https://chat.google.com@evil.example`), `:8443`, `https://10.0.0.1`, `https://0x7f.1`, `https://2130706433`, `https://127.1`, `[::1]`, `localhost`, `a.localhost`, `printer.local`, `host.`, any `xn--` label in any position (`xn--e1afmkfd.example`, `login.xn--p1ai`), non-string, `''`, unparseable. |
| Refused set | U | same | `isRefusedHost` alone is true for each host below and false for `www.google.com`, `chat.google.com` and `accounts.google.com`; with the mode on, `allowNavigation` (= acceptable and not refused) is false for every host of `LINK_LIST_HOSTS` (the test iterates the imported list, so a new entry is covered), `forms.gle`, `drive.usercontent.google.com`, `meet.google.com`, `x.googleusercontent.com`, `googleusercontent.com`; true for `www.google.com`; a redirect to each is cancelled; a `will-navigate` to each reaches the router (Meet to the call window, a listed host to the app window, others to the browser). |
| State machine | U | same | off by default; entry (a) on commit at `accounts.google.com` only (not on `will-navigate`, not on a lookalike); **entry (b)**: `did-start-navigation` or `will-redirect` through `accounts.google.com` then a commit on an IdP origin turns the mode on, a chain that ends on Chat does not, a cancelled or failed chain does not and clears the flag, a chain through a non-Google origin does not; **chain-flag order**: `did-start-navigation` clears then sets (a flag set by navigation A is gone when navigation B, not on `accounts.google.com`, starts and commits on an IdP: no entry), a later `will-redirect` to `accounts.google.com` sets without clearing, and a `will-redirect` is the source (`did-redirect-navigation` is not consulted); a session-refresh bounce that commits on `accounts.google.com` turns the mode on and the Chat commit turns it off; allow during on, not off; exit on Chat commit; idle timeout, hard cap and hop cap with a fake clock call `loadStartUrl` once; **hop cap counts only cross-origin commits** (41 same-origin commits do not abort, the 41st cross-origin commit does); timer reset by commits; `abort` idempotent; `abort('user')` returns to `START_URL`; **`abort('user')` with the mode off loads nothing and changes nothing**; **`dispose` clears timers, loads nothing, calls no `abort`** (there is no `teardown` reason); timers unref'd; re-entry after exit starts fresh counters. |
| Redirect gate | U | same | with mode on: `http:`, userinfo, port, IP, `xn--`, refused host: `preventDefault`; acceptable: not prevented; with mode off: never prevented (pins the unchanged behaviour); **subframe `will-redirect` (`isMainFrame` false) and `isSameDocument` never prevent, allow or count, in either mode**; the first cancelled redirect of a sign-in calls `notifyRefusedStep` once, a second one in the same sign-in does not, a new sign-in calls it again, and mode off or a subframe never calls it. |
| Abort vs `beforeunload` | U | same and `test/signInWiring.test.js` | after `abort('timeout')`, `abort('hop-cap')` and `abort('user')` the `will-prevent-unload` handler calls `preventDefault()` (the **outcome**: the unload proceeds with no dialog; the test does not pin listener order); `isAborting()` clears on a commit **on `START_URL`'s origin**, on a load failure and after the safety timer, and does **not** clear on a commit on any other origin; with no abort and no quit nothing is prevented (the default dialog is left alone). |
| Native title | U | `test/signInWiring.test.js` | during the mode `page-title-updated` is prevented and `setWindowTitle` receives `Sign-in · <eTLD+1> — <host>` on each commit (`https://signin-verify.evil.example/` gives `Sign-in · evil.example — signin-verify.evil.example`; a host equal to its registrable domain gives `Sign-in · login.example`; a multi-part suffix such as `a.b.example.co.uk` gives `example.co.uk` first; a single-label host `adfs` gives `Sign-in · adfs`; the registrable domain is always the first host-derived text in the string); on exit and on abort it is restored and no longer prevented; with the mode off the page title is never touched. |
| Tray entry | U | the tray test suite | "Back to Chat" present only while the mode is on, after "Show/Hide Google Chat"; its click calls `abort('user')` and shows the main window; **a click when the mode is off (stale menu) still shows and focuses the window and loads nothing**; the menu is rebuilt on `onModeChange` and not from the blink tick. |
| Router predicate | U | `test/linkRouter.test.js` | `allow` true: passes untouched; `allow` absent: identical to today; `allow` throws: fail closed to routing; fixed list still passes without `allow`; Meet URL during the mode goes to the call window; an `http:` URL during the mode goes to the browser. |
| Preload off-origin | U (shipped; keep green) | `test/smartCopyPreload.test.js` and the bridge preload test | on `https://chat.google.com`: bridge exposed, detector installed, no probe sent; on `accounts.google.com`, an IdP origin, `about:blank` (opaque origin): no `exposeInMainWorld`, no listeners, no `ipcRenderer.send`, **no `sendSync`**; on a loopback `http://localhost:PORT` / `http://127.0.0.1:PORT` origin the preload sends the `gcd:bridge-probe` `sendSync` and exposes the bridge only when the answer is exactly `true`; a probe answer of `false`, a non-boolean or a throw exposes nothing; a subframe never exposes; the preload's hard-coded `CHAT_ORIGIN` and probe channel name equal `origins.js` / `mainFrameGate.js`; `process.argv` is never read. Main side (`test/mainFrameGate.test.js`): the probe answers `true` only for the main window's own main frame on a notification origin and `false` for `accounts.google.com`, an IdP origin, another sender or a subframe, and in a packaged run for a loopback page. |
| Worker preload | U (shipped; keep green) | `test/serviceWorkerPreload.test.js` | off-origin worker, and a failed origin read: no bridge, no patches; chat-origin worker: bridge and patches. |
| Gates in main | U (shipped; keep green) | `test/index.test.js`, `test/notificationBridge.test.js`, `test/attentionWiring.test.js` | injection skipped off-origin (the check is inside `injectNotificationBridge`, tested through both the `dom-ready` and `did-finish-load` callers); title `(99)` ignored off-origin **in the listener and in the `did-finish-load` seeding**; `notification:clicked` rejected from `accounts.google.com` and an IdP origin; accepted from Chat. |
| Downloads | U | `test/downloads.test.js` | mode on: a main-window `https` download is cancelled and the **sign-in wording** notice shown (coalesced) **with no "Open in browser" action**; mode off: unchanged (save dialog, scheme-only check, existing notice and its action); app-window downloads unaffected in both. |
| Permissions | U | `test/sessionPermissions.test.js` | an IdP origin (requesting and top-level) is denied notifications, clipboard (all kinds), media, display capture, fullscreen, speaker-selection. |
| Wiring | U | new `test/signInWiring.test.js` (pattern of `googleWiring.test.js`) | listeners registered on the main window only; popup handler unchanged (denies, routes to browser); `closed` disposes; no other window type receives the listeners. |
| SSO with a real account | M | FR-19 manual rows | Okta, Entra ID/Azure AD, ADFS, Google-hosted IdP, a custom domain (whichever the maintainer has an account for); Windows and Linux; **including a returning, already-known user who is redirected straight to the IdP (entry b)**. |
| 2-step on another origin | M | same | Google prompt, SMS/voice code, backup code, authenticator code. |
| Security key and passkey | M | same | USB/NFC key, Windows Hello, phone passkey (hybrid/QR), several discoverable credentials; Windows 11 and Linux; record per platform (section 5). |
| Bridge absent on the real sign-in page | M | same | in an unpackaged run with DevTools open on the main window, on the real Google sign-in page and on a real IdP page: `window.__gcdBridge` is `undefined` and no app IPC channel is reachable; on Chat it is defined. |
| Captive, abort and tray | M | same | same-tab non-IdP link stays in window and the window returns to Chat at the timeout; `target=_blank` goes to the browser; a page with a `beforeunload` prompt still returns to Chat on timeout and on "Back to Chat"; the window title shows the registrable domain first, then the host; "Back to Chat" appears only during the mode; on a desktop **without a tray** only the timers bound the mode (record whether such a session was available). |
| Refused-step notice | M | same | a sign-in whose chain redirects to a refused host (if one is found, or by a test harness page): the notice "This sign-in step can't open in the app" appears **once**, its "Back to Chat" returns to Chat, "Close" and Escape leave the page as it was; a second refused redirect in the same sign-in shows nothing; a new sign-in shows it again. |
| Hidden during push approval | M | same | hide the window while a phone approval is pending, approve, reopen: window on Chat, signed in; notifications work afterwards. |
| Real desktop | M | same | per *Verify on a real desktop*: which platforms were actually checked is stated in the report. |

## 9. Implementation order

*(Steps 1 to 5 are done; step 6, the manual rows with a real provider, is open.)*

1. **Tests first** for rows U above: the off-origin preload, the main-side gates, the permissions pin and the router
   predicate characterisation (these pass or fail against today's code and pin it).
2. **Hardening that is independent of the mode (done, shipped):** the preload origin guard (bridge and detector,
   hard-coded Chat origin plus the main-answered dev probe), the worker preload guard, the bridge-injection gate, the
   title and load-time-seeding gates, `notification:clicked` against the chat list. Closed the exposure on
   `accounts.google.com`. Only the permissions pin test and the downloads row remain *pending*.
3. `src/main/signInFlow.js` with `isAcceptableIdpUrl`, then the optional `allow` on `linkRouter.onWillNavigate`.
4. Wiring in `index.js` (`will-navigate` predicate, `did-start-navigation`, `will-redirect`, `did-navigate`,
   `did-fail-load`, `page-title-updated`, `will-prevent-unload`, downloads predicate, tray entry, `closed`).
5. Documentation at ship: `project-rules.md` (already states the exception), `overview.md`, `ipc-contract.md`,
   `tray-lifecycle.md`, `origins.js` header comment; remove the "provisional" and *pending* wording.
6. Manual verification rows on a real desktop; results recorded in FR-19.

## Open questions

1. **Hide or close during sign-in:** the first draft aborted on hide. Kept as "no abort" so background push approval works
   (section 1); the escape from a wrong page is now the tray "Back to Chat" and the timers. Maintainer decision if the
   alternative (abort on hide) is wanted.
2. **Non-default port (some on-premises IdPs use one), IP-literal IdPs and IDN-hosted IdPs** are **not supported**. If
   real users need them, the smallest change is an explicit, user-visible setting that adds exact entries; not designed here.
3. **`will-redirect` with the mode off** is unchecked (residual risk, section 1). Tightening needs evidence of which
   Chat redirects occur; a one-release log of redirect **schemes and whether the origin was Google** (no URLs) would give it.
4. **Limit values** (10 minutes idle, 30 minutes cap, 40 cross-origin commits) are reasoned defaults, not measured; the
   manual SSO runs should record the longest legitimate sign-in seen and the most origins visited.
5. **WebAuthn multi-credential chooser** is added only if the manual run shows it failing (section 5).
</architecture>
