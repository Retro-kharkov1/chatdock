# Google App Windows (FR-17, UI-04)

<overview>
Design for opening links to Google services (Drive, Docs, Calendar and so on) in app-owned windows that share
the signed-in session, instead of the system browser, so the user never signs in twice. Behaviour and
acceptance criteria: [FR-17](../business/requirements.md). The standing rules (security baseline, quit only
from the tray, wrapper not a rewrite, design scaled to the wrapper) are in [Project Rules](project-rules.md)
and are not restated; this feature is the *second* exception to the baseline's "external links go to the
system browser", recorded there. It builds directly on [Meet Call Window](meet-call-window.md) (cited as
**Meet doc**): same exact-origin discipline, same router, same close-probe and quit rules.

**Scope is deliberately minimal (owner decision 2026-10-04).** Each opened link is a bare browser-like
window showing only the Google page. The app draws **nothing** in it: no toolbar, address bar, banner or
progress UI, no preload, no IPC. The only app-drawn artefacts are three native OS dialogs (save dialog for
downloads, one close confirmation, one blocked-download notice). No wireframes or mockups (*Design scaled to the wrapper*).

**Known limitations accepted by this scope:**
- No address bar or back button; the user navigates with the page's own controls (and Alt+Left where the OS
  provides it). The application menu is `null`, so shortcuts such as Ctrl+W do not exist; the X button closes (only the clipboard/undo keys are restored, section 4).
- Sign-in popups that rely on `window.opener` (OAuth-style flows from Docs add-ons) may not complete, see
  section 4 [U] and the fallback there.
- Voice typing, add-on camera/microphone use and desktop notifications from Calendar/Gmail are denied (section 6).
- A link to a Google host outside the list (Maps, Looker Studio, Apps Script, Groups, `g.co`) still opens in
  the system browser, where the user signs in separately. (`forms.gle` is followed only when it redirects to a
  listed host, section 2.)

**Status of the host lists.** Drive, Docs (Docs/Sheets/Slides/Forms) and Calendar are the owner's stated need.
Mail, Keep, Contacts and Sites are **orchestrator-chosen defaults awaiting owner confirmation** (open question 1);
removing one is deleting a row and its tests. Hosts the orchestrator left out (`g.co`, Maps, Apps Script, Looker
Studio, Groups) are likewise owner-confirmable.
</overview>

<architecture>
## 1. Routing (who decides what)

For any link that leaves the **main window** (its popups, and a `will-navigate` to a non-Chat host; a `will-navigate`
to Chat itself stays in the main window and never reaches the router), in this order:

| # | Test | Outcome |
|---|---|---|
| 1 | Meet (`classifyLink`, unchanged) | existing call window |
| 2 | `https://chat.google.com`, exact origin | by source and path (`classifyChatTarget`, section 3): **main window**, **focus main window only**, **main-window download**, or system browser |
| 3 | host in the **link list** or the **entry-hop list** (section 2) | **new Google app window** (section 4) |
| 4 | `http`, `https`, `mailto` | system browser (existing `isOpenableExternalScheme`) |
| 5 | anything else | not opened, logged by scheme only (existing) |

Origin rule for 2 and 3 is the Meet rule: parse with WHATWG `URL`; `protocol === 'https:'`, hostname in the
list by **exact string equality**, `port === ''` (default `:443` normalises away), `username === ''` and
`password === ''`. No suffix, substring or wildcard match; no trailing-dot host. The same `https://www.google.com/url?q=`
**unwrap-once** rule applies (path exactly `/url`, exactly one `q`; the decoded target must pass on its own,
a wrapper inside a wrapper fails). The outcome's `url` is the **normalised href of the target**, never the
raw input or the wrapper. Every non-string or unparseable input falls through to row 4/5 and never throws.

A link that leaves a **Google app window** (popup or main-frame navigation) uses the same table with two
differences: row 3 tests the **navigation list** (plus the entry-hop list, so a `forms.gle` link clicked inside an
app window follows the same hop as from Chat, section 2), and the Chat source is `app` (section 3).

The call window's own popup/navigation routing is **unchanged** in this feature (it keeps injecting only
`classifyLink`; `test/callWindow.test.js` pins that a Chat or other Google URL from Meet goes to the system
browser). Extending Meet's in-call links (for example shared meeting notes) is a follow-up, see open question 3.

## 2. Hostname lists (exact; no wildcards)

Four lists plus one narrow rule, in one pure module (section 7). **Link list** = hosts that a link from Chat may
open in a Google app window. **In-window navigation list (nav list)** = hosts an already-open app window may
move between (link list plus `accounts.google.com`). **Entry-hop list** = `forms.gle` only. **Download-chain
hosts** = extra exact hosts tolerated **only as an intermediate or final hop of an app-window download chain**
(section 4); **initially empty**, filled only from spike evidence (section 10 step 1) plus an owner decision, never
a pattern, and never also added to the nav list. The **download-hop rule** (below) is not a list membership:
`drive.usercontent.google.com` is **not on the nav list**.

| Host | Link list | Nav list | Why |
|---|---|---|---|
| `drive.google.com` | yes | yes | Files, folders, the owner's example (`/file/d/<id>/view`). |
| `docs.google.com` | yes | yes | One host serves Docs (`/document`), Sheets (`/spreadsheets`), Slides (`/presentation`), Forms (`/forms`) and Drawings; there are no separate `sheets.`, `slides.` or `forms.` hosts, so none are listed. |
| `calendar.google.com` | yes | yes | Event links. |
| `mail.google.com` | yes (default, to confirm) | yes | Gmail links. Orchestrator-chosen. |
| `keep.google.com` | yes (default, to confirm) | yes | Notes. Orchestrator-chosen. |
| `contacts.google.com` | yes (default, to confirm) | yes | Contacts. Orchestrator-chosen. |
| `sites.google.com` | yes (default, to confirm) | yes | New Google Sites (`/view/...`). Custom-domain sites go to the browser. Orchestrator-chosen. |
| `accounts.google.com` | **no** | yes | Re-authentication and consent inside an app window. Never an entry point: a sign-in page from a chat message is a phishing shape, so a Chat link to it goes to the system browser. |
| `forms.gle` | **entry-hop only** | **no** | Google Forms short link (owner-confirmed 2026-10-04). Followed **only if its redirect lands on a nav-list host** (in practice `docs.google.com/forms/...`); otherwise it goes to the system browser. Mechanism below. |
| *(none yet)* | no | no | **Download-chain hosts** (empty list, `DOWNLOAD_CHAIN_HOSTS = []`, frozen). Exact hostnames only; added with spike evidence and an owner decision. |

**Entry-hop (`forms.gle`).** The classifier returns `app-window` with `hop: true`. The same hop applies whether the
link came from Chat or was clicked (popup or navigation) inside an app window: `forms.gle` is not on the nav
list, so it is never navigated **in place**; the app window's navigation is `preventDefault()`ed and the link is
opened through the factory as a new hidden hop window. The factory creates the window with `show: false`, adds the
registry entry **synchronously** keyed by the requested href and flagged *pending*, and loads the URL:
- `will-redirect` to a **nav-list** host: allow it; keep waiting. `will-redirect` to **any non-nav-list target**:
  `preventDefault()` (hidden content outside the list is never loaded), `destroy()` the window and send that
  target to the system browser by the scheme rule.
- `did-navigate` is the decision point only for the **no-redirect** case and for the final landing: on a nav-list
  host -> `show()` (re-dedupe by the **final** href without fragment: if a window for it exists, destroy the new
  one and focus that one; otherwise re-key the entry to the final href); on any other host (including `forms.gle`
  answering itself) -> `destroy()` and send the **original** URL to the system browser.
- A load failure, or no decision within 10 s -> `destroy()` and send the **original** URL to the system browser
  (the user is never left with nothing).
- **While pending, a repeated click on the same link is coalesced:** it finds the pending entry and does nothing:
  it never shows or focuses the hidden window and creates no second one. Once the entry is re-keyed or removed, a
  later click behaves normally (final href dedupe, or a fresh hop).

The user never sees an app window whose content is outside the list.

**`drive.usercontent.google.com` is not a link target and not a navigation target (narrowed after review).**
It serves user-controlled bytes, and the nav list would have let it render top-level in a window holding the
session. It is permitted only by the **download-hop rule**, evaluated on the main frame of an app window:
- **Server-redirect hop:** a `will-redirect` whose destination is `https://drive.usercontent.google.com/download...`
  (path exactly `/download`) **and** whose navigation started from a page on `drive.google.com` or
  `docs.google.com` is allowed (the window follows it so Chromium turns the response into a download). **Source
  on a brand-new window's initial load:** the window has no page yet, so the source is the **requested URL**
  (the one passed to `loadURL`); for example `https://drive.google.com/uc?export=download&id=...` (a link-list host)
  redirecting to `drive.usercontent.google.com/download?...` is allowed. In later navigations the source is the
  current page, as above.
- **Empty window after a download:** an app window whose only navigation became a download (it never displayed a
  page: no `did-navigate` to a committed page, URL still empty) is **closed automatically** when the download
  ends (completed, cancelled or interrupted), so no blank window is left behind. A window that has displayed a page
  is never auto-closed. For a blocked download the same empty window closes at once and the notice is shown
  unparented (section 4).
- **Blank window after a routed-away initial load:** an app window that **has never displayed an allowed page**
  (no `did-navigate` yet) and whose main-frame navigation or redirect is routed away (system browser, call window,
  main window), for example a signed-out calendar link redirecting to the `workspace.google.com` marketing page, is
  **destroyed** right after the route, so no blank window is left behind; the target still goes where the router
  sends it. Same family as the empty window after a download. A window that has displayed an allowed page is never
  auto-closed this way; sub-frame navigations and popups never trigger it.
- **Interstitial follow-up:** the large-file virus-scan interstitial ("can't scan this file for viruses") is an
  **HTML page on that host** (`/download?id=...`), and its "Download anyway" form submits back to the same host
  (`/download?...&confirm=...`). It is Google-generated HTML, so rendering it is accepted **only when** the window
  arrived there through the hop above, and a further navigation from it is allowed only to `/download` on the same
  host (path exactly) or back to a nav-list host. Anything else from that page is blocked and routed to the browser.
  If the spike (section 10, step 1) shows the interstitial renders differently, change only this clause, with
  evidence.
- **Never:** a popup target, a `will-navigate` that is not a redirect and does not meet the interstitial clause,
  a Chat link, an entry point, or a link-list/nav-list member. A direct navigation to it (for example a link to
  it clicked inside a page, or a Chat link) is `preventDefault()`ed and routed to the system browser.
- A download **initiated from an allow-listed page** (script/form in a sub-frame or fetch that ends in
  `will-download`) never needs the host to be navigable; it is governed only by the download rules in section 4.

Not listed, deliberately: Tasks (no standalone web host; it lives inside Calendar/Gmail), `chat.google.com`
(main window, section 3), `meet.google.com` (call window), `myaccount.google.com`, `accounts.youtube.com`,
`www.google.com` (only as the unwrap wrapper), `g.co` and other shorteners, Maps, Apps Script, Looker Studio,
Groups (all owner-confirmable, open question 1).

**`*.googleusercontent.com` decision: not navigable, not wildcarded.** These are *content* hosts
(`lh3.`, `doc-xx-xx-docs.`, `*.sites.`, and per-user sandboxed origins) that serve user-uploaded bytes and
sandboxed embeds. They load **as sub-resources and sub-frames** (images, thumbnails, embedded viewers) with
no restriction, because navigation checks apply to the **main frame** only (as in the Meet doc section 4).
They are not allowed as **top-level navigation targets**: a wildcard would let any user-controlled subdomain
render arbitrary content in a window that holds the Google session, and the project rule forbids suffix
matching. A main-frame navigation or redirect to one is `preventDefault()`ed and routed (system browser).
Consequence to verify in the manual run [U]: whether a Drive/Docs download or export still reaches the
`will-download` handler (section 5) without a top-level hop to an unlisted `googleusercontent` host.
If a download-only hop is observed, add that **exact** hostname to the **download-chain hosts** list (not the nav
list) with evidence and an owner decision (Meet doc open question 4 discipline), never a pattern. Only a host that
must render a page in the window goes on the nav list, with its own evidence and decision.

`accounts.youtube.com` (cross-domain cookie sync) normally runs in sub-frames; if a real re-authentication
shows it as a blocked main-frame navigation, treat it the same way (evidence, then exact host). This mirrors
the provisional-list rule for sign-in in [Overview](overview.md).

## 3. chat.google.com links: main window, download, or browser (by source and path)

Today a `window.open('https://chat.google.com/...')` from Chat goes to the system browser (the earlier finding).
**Risk found in review:** `mainWindow.loadURL` reloads Chat and drops the current view and any unsent draft, and
Chat itself uses `window.open` for things that are not "go to this conversation" (pop-outs, attachment
opens of the `get_attachment_url` kind). Sending those into the main window would hijack it. Decision: the
router classifies a `chat.google.com` target by **source** and **path** (pure function `classifyChatTarget(url,
source)`, section 7). `source` is `'main'` (a **popup** of the main window; the main window's `will-navigate` is
not a source, because Chat-to-Chat navigation stays in place and never reaches the router) or `'app'` (a Google
app window). `openMainWindow` with a reload is used only for the `main-window` outcome.

**Evaluation order (precedence): row 1 before row 2.** A path matching **both** a download shape and a
conversation shape (for example `/room/x/attachment/1`) is a **download**: download shapes win. A leading
`/u/<n>` is stripped before either test.

| # | Path shape (provisional, evidence-gated by the manual "observe what Chat opens" row) | Source `main` | Source `app` |
|---|---|---|---|
| 1 | attachment/download shapes: path under `/api/` or containing `attachment` or `download` | `download`: **not loaded into any window**; `mainWindow.webContents.downloadURL(url)` ends in the main-window `will-download` rules (section 4); the main view is untouched | `browser`: the system browser. An app window must not drive a download into the main window (a link inside a Doc is not a user action in Chat). |
| 2 | conversation shapes: `/`, `/room/`, `/dm/`, `/space/`, `/app/` | `focus-main`: show, restore and focus the main window only, **no `loadURL`**, until the manual observation records Chat's actual pop-out paths (then this row may be revised with evidence) | `main-window`: `openMainWindow(url)`: same URL without fragment as current -> show and focus only, no reload; else `loadURL`, restore/show/focus (like tray Show). A hidden window keeps running (*Hidden window must stay live*). |
| 3 | anything else on `chat.google.com` (pop-outs, unknown shapes) | `browser` (today's behaviour) | `browser` |

`classifyChatTarget` returns `'main-window' | 'focus-main' | 'download' | 'browser'`. The path lists are provisional:
they are defined in `googleLink.js` as data, and the manual run records what Chat really opens (pop-out,
attachment, "open in new window", message permalink) before they are frozen. A shape not on any list defaults to
the system browser, never the main window.

- The main window's `will-navigate` list is unchanged (`chat.google.com`, `accounts.google.com`); a *link*
  to Chat is a different path, reached through `setWindowOpenHandler`, which always denies and routes.
- A Google app window never renders Chat a second time (its navigation to Chat is routed per the table).
- Accepted loss: loading a conversation permalink reloads Chat. Chat keeps drafts server-side for conversations;
  this is checked in the manual run, and if drafts are lost the `main-window` outcome narrows to "focus only".

## 4. Google app window (new `src/main/googleAppWindow.js`)

**Model: one window per link, deduplicated.** Recommended over reuse: a document is a long-lived task and
reuse would navigate a window the user is still reading or editing away. Opening a link whose normalised
href (fragment dropped) already has a window focuses that window instead of creating another. **Fragment
rule:** if the new link carries a fragment (a `#heading` link) and that window's *current* URL without fragment
equals the link's, call `loadURL(<full href>)` on it (a same-document fragment navigation: no reload, scrolls to
the heading) and focus; if the window has since moved to another page, or the link has no fragment, **only focus**
(never navigate away from what the user is reading). No cap on the
number of windows (the user closes them; a cap would silently refuse a link). A registry
`Map<key, BrowserWindow>` is cleared on `closed`. The entry is added **synchronously at creation**, before the
load, so two quick clicks cannot create two windows (same rule as the call window).

`new BrowserWindow` with `webPreferences: { contextIsolation: true, nodeIntegration: false,
nodeIntegrationInSubFrames: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false,
webviewTag: false, partition: PARTITION }`. **No `preload` key at all.** `PARTITION` is the
constant exported by `src/main/session.js` (never a string literal) so the Google sign-in carries over and the
quit flush covers it. Defaults: 1200x800 (FR-01's size), no window-state persistence, the app icon already used
by the main window, initial title "Google Chat Desktop" which then follows the page's own `<title>`.
Tests assert the options the window is **created with**, not only the live contents (NFR-07's discipline).

- **Navigation (main frame only):** `will-navigate` **and** `will-redirect`: URL passes the exact-origin test
  against the **navigation list**, or satisfies the **download-hop rule** of section 2 (the only way
  `drive.usercontent.google.com` is ever followed): stay in this window. Otherwise `preventDefault()` and route (section 1):
  Meet -> call window, Chat -> by `classifyChatTarget(url, 'app')`, `forms.gle` -> entry hop in a new window,
  anything else -> system browser by scheme (a link-list host is
  always on the nav list, so it never reaches this branch). Sub-frames are unrestricted.
- **Popups:** `setWindowOpenHandler` **always returns `{ action: 'deny' }`**; the target is classified:
  nav-list host (including `accounts.google.com`, which is allowed here as a popup target; **never**
  `drive.usercontent.google.com`, which goes to the system browser) -> a new app window
  through the same factory (so it always gets the hardened options, never inherited ones); `forms.gle` -> the
  entry hop of section 2 through the same factory; Meet and Chat as in
  section 1 (Chat with source `app`); anything else -> system browser. A popup is never a raw `BrowserWindow` Electron creates.
  **[U] OAuth-style popups** that need `window.opener`/`postMessage` back to the page do not work with
  deny-and-recreate. Fallback, only if the manual run shows it matters: for popups to `accounts.google.com`
  return `{ action: 'allow', overrideBrowserWindowOptions: <the same hardened webPreferences> }`. Do not do it
  speculatively.
- **Close destroys, never quits, never hides** (hiding a Google editor window has no purpose). `window-all-closed`
  stays a no-op. Closing an app window never touches the main window or the tray.
- **Downloads (Drive "Download", Docs "Download as", Sheets export, and Chat attachments)** are handled on the
  **session** (`will-download`, `src/main/downloads.js`) for **two kinds of originating `webContents`: an app
  window (registry lookup) and the main window.** Any other contents is left to Electron's default as today.
  Common rules: (a) a **save dialog is always shown**: do not call `setSavePath`; call
  `setSaveDialogOptions({ defaultPath })` with the OS Downloads folder joined to `path.basename` of the suggested
  file name (so a hostile name cannot carry a path); (b) when the download finishes, **nothing is opened or
  launched**, no `shell.openPath`, no `showItemInFolder`, no notification; (c) cancel in the dialog cancels the
  item; (d) file names and URLs are never logged, only `started`/`completed`/`cancelled`/`blocked` and the scheme.
  **Origin check differs by source:**
  - **App window: strict, on the whole chain.** The final URL (`item.getURL()`) **and every entry of
    `item.getURLChain()`** must be `https:` (or `blob:`, whose inner origin is used) with an origin on the nav
    list, **or** be `https://drive.usercontent.google.com/download` (path exactly), **or** have a hostname on the
    **download-chain hosts** list (section 2; empty today). Implemented as `isDownloadChainUrl` (section 7). Reason: the final URL alone
    would let a download that was bounced through an unlisted host (a redirect chain started from a sub-frame or
    fetch, where navigation checks do not apply) pass on its last hop. Any failure -> `item.cancel()` and the
    **blocked-download notice** below.
  - **Main window: scheme only.** `https:` or `blob:`, no host check; the save-dialog and no-auto-open rules
    apply. Reason: Chat attachment downloads are served from hosts that have not been observed
    (possibly `*.googleusercontent.com`), and a host check now would turn a working feature into a silent
    failure. The manual spike records the hosts; a strict list may follow with evidence. Behaviour change versus
    today: the save dialog is now always shown for the main window too (no silent save into Downloads).
  - **Blocked-download notice (no silent dead button).** On any `blocked` outcome the app shows **one native
    message box** (`dialog.showMessageBox`, at most one open per originating window):
    title "Download blocked", message "This download comes from an address the app does not allow." Buttons:
    "Close" (**default** and Esc, so a stray Enter never launches a browser) and "Open in browser" (only when the
    item URL is `https:`, where it follows the existing scheme rule and `shell.openExternal`); for a `blob:` or
    other URL only "Close". **Coalescing:** while a notice is open for a window, a further blocked download in that
    window is cancelled and **folded into the same notice**: no second box and no count (the box concerns the first
    item; "Open in browser" opens that first item's URL). **Parent state:** parent visible -> parented to it;
    parent **hidden, minimized or being auto-closed (empty window)** -> shown **unparented**, so it is never
    stuck behind or invisible; parent **destroyed while the box is open** -> the box is dismissed (via the dialog's
    `AbortSignal`; a result arriving after dismissal is ignored, so "Open in browser" cannot fire). An unparented
    box is not dismissed by its former parent closing. Chosen over "open in
    browser automatically" (an unrequested browser launch is surprising) and over a toast (the app has no
    in-window UI, and notifications are denied). It gives a user whose download is blocked a working next step.
- **`will-prevent-unload` is registered at creation, always** (Meet doc section 8 rule 1). While `isQuitting`
  (the quit guard's getter, see `src/main/quitGuard.js`) it calls `event.preventDefault()` synchronously, so a
  quit is never held up by a Docs "unsaved changes" objection. Decision on that objection otherwise:
  **honour it on an app-initiated close (X, Alt+F4) with a native confirm; do not override it for a
  page-initiated reload/navigation** (the same split as the Meet doc section 8 rules 4 to 6). Docs autosaves, so
  the objection appears only while a save is in flight, which is exactly when a confirm is worth one click.
  Mechanics are the Meet close probe (`appClose` flag, one-shot probe about 3 s, first objection only, hung page
  or missing signal means close without a dialog, `destroy()` as the override because the dialog is async).
  Factor the probe out of `callWindow.js` into a shared helper rather than copying it. Differences from the
  call window: no picker, no P2/Exit interplay, **tray Exit never asks about an app window** (see section 8
  and open question 2), and at most one dialog per window.
- **Keyboard shortcuts:** the application menu is `null`, which also removes Ctrl+C/X/V/A/Z and Shift+Ctrl+Z
  (redo) on Windows/Linux. Every app window (hop windows included) binds `before-input-event` at creation through
  the shared `src/main/editShortcuts.js` (`bindEditShortcuts`), the same helper the main window uses (Ctrl or Cmd +
  C/X/V/A/Z, with Shift = redo; no Ctrl+Y, the main window has none). It dispatches to the contents' own edit
  commands and creates no menu; Ctrl+W, Ctrl+Q and every other key are left alone, so there is still no keyboard
  close or quit path.
- **Renderer crash:** no dialog. The window shows Chromium's own crashed-tab page; the user closes it. (Cheaper
  than a second dialog and no data of the app's is lost; revisit only if it is observed to matter.)
- **Logging:** scheme and outcome only. Never URLs, document names, cookies or file names.

## 5. Window-open surface on the shared session (what changes outside the new module)

- `configurePersistentSession` gains the `clipboard-sanitized-write` and `fullscreen` grants of section 6 and
  nothing else, and both handlers (request and check) are extended **to also read the top-level origin**.
- `src/main/index.js` constructs the router with two new **optional** collaborators, `openMainWindow` and
  `openGoogleAppWindow`. When they are absent the router behaves exactly as today, which keeps
  `test/linkRouter.test.js` and `test/callWindow.test.js` green without edits. `classifyLink` and
  `isOpenableExternalScheme` are **not changed** (their tests pin that Chat and other Google hosts are
  `system-browser` there); the new classification is a separate function (section 7), applied after Meet.

## 6. Permissions (shared session; decide by origin, never by window)

The session handlers already grant `notifications` and `clipboard-sanitized-write` to the Chat origin and the
Meet media set to Meet only (Meet doc section 6). This feature adds two grants (clipboard write, fullscreen) and
widens nothing else.

**`session.js` change (explicit).** Today the handlers decide on the requesting origin only. For the two new
grants they must decide on **requesting origin AND top-level origin**, both in `GOOGLE_APP_CLIPBOARD_FULLSCREEN_ORIGINS
= { https://docs.google.com, https://drive.google.com }` (a separate constant, like BUG-02's list; not derived from
the nav list). Sources: in `setPermissionCheckHandler` the top-level origin is `details.embeddingOrigin`; in
`setPermissionRequestHandler` (no such field) it is the origin of `webContents.getURL()` of the asking contents.
A missing, empty or unparseable top-level origin -> deny. This is what keeps a docs/drive frame **embedded under
Chat** (top-level `chat.google.com`) at **no new grant**: its requesting origin is listed but its top-level is
not. Existing Chat and Meet decisions keep their current logic, untouched. The unit tests pin the field names
against the Electron version in use (a rename must fail a test, not silently deny or grant).

| Permission | Decision | Why |
|---|---|---|
| `clipboard-sanitized-write` | **grant** only when requesting origin **and** top-level origin are both in the two-origin set above | Docs/Drive "Copy link" and Sheets cell copy use `navigator.clipboard.writeText`. Sanitized write needs a user gesture and cannot read. Granted to the two hosts that need it; the others get it only on evidence [U: verify in the manual run]. |
| `fullscreen` | **grant** under the same requesting-and-top-level rule (decision after review) | Slides "Present" and Drive video use the HTML Fullscreen API; without it Present silently does nothing. Fullscreen is exited with Esc (the page keeps that), so no app menu is needed. Main window (Chat) and call window are unchanged. Granted to docs/drive only; others on evidence. |
| `clipboard-read`, `clipboard-sanitized-read`, raw write | deny | Paste uses the OS shortcut and needs no permission. |
| `media` (camera, microphone), `speaker-selection`, display capture | deny for every app-window origin | Only Meet may use them (origin gate unchanged). Docs voice typing is a known loss. |
| `notifications` | deny (Chat origin only, unchanged) | Calendar/Gmail desktop toasts are not wanted; Chat's own are the app's job. |
| everything else (geolocation, midi, usb, hid, serial, `window-management`, ...) | deny | Default stays deny. |

`setDisplayMediaRequestHandler` is unchanged (Meet-gated); a request from a Google app window fails its
origin gate and is denied without a picker.

## 7. Units

| Unit | File (suggested) | Kind | Purpose |
|---|---|---|---|
| Google link classifier | `src/main/googleLink.js` | pure, no Electron import | `classifyGoogleLink(input) -> { outcome: 'main-window' \| 'app-window' \| 'none', url, hop? }` (`hop: true` for `forms.gle`); `classifyChatTarget(url, source: 'main' \| 'app') -> 'main-window' \| 'focus-main' \| 'download' \| 'browser'` (section 3, path lists as data, download shapes win); `isGoogleNavigationUrl(url) -> boolean` (nav list test); `isDownloadHop({ url, fromUrl, isRedirect, windowUrl }) -> boolean` (section 2 rule; `fromUrl` is the requested URL on a brand-new window's initial load, `windowUrl` empty); `isDownloadChainUrl(url) -> boolean` (nav-list origin, or `usercontent /download`, or a **download-chain host**; `https:` only, `blob:` is unwrapped by `downloads.js`); the frozen host lists (`DOWNLOAD_CHAIN_HOSTS` frozen and empty) and `CHAT_ORIGIN` reuse. Never throws. |
| Router extension | `src/main/linkRouter.js` | existing pure factory | `route()` order of section 1; two optional deps; `onWillNavigate` unchanged. A second small router function (or option) serves the app window's own popup/navigation with the **navigation** list. |
| App window factory | `src/main/googleAppWindow.js` | main process, deps injected | Section 4: options, registry (with *pending* hop entries), dedupe, forms.gle hop, navigation, popups, empty-window auto-close, close probe, `will-prevent-unload`. |
| Downloads | `src/main/downloads.js` | main process, deps injected | Section 4 download rules for app windows and the main window; takes `isAppWindowContents`, `isMainWindowContents`, the dialog/path collaborators and the blocked-notice (per-window coalescing, parent-state handling); reports "download ended" to the factory for the empty-window auto-close. |
| Permission list | `src/main/session.js` | existing | The added origin set and the requesting-plus-top-level check for clipboard and fullscreen (section 6). |

Wiring in `src/main/index.js`: pass `openMainWindow` (load/show/focus on `mainWindow`) and
`openGoogleAppWindow` into `createLinkRouter`; pass `isQuitting` and `PARTITION` into the factory; register the
download handler once on the session. No change to the tray; no change to the preload or IPC contract
([IPC Contract](ipc-contract.md): the app windows have no bridge and no channel).

## 8. Interplay with existing behaviour

- **Tray.** Show/Hide and left-click act on the **main window only**; app windows are never hidden, shown or
  focused by them. There is no tray entry for app windows. The tray icon and its blink are unaffected.
- **Attention (FR-14).** "Not focused" still means the **main window** is not focused (as for the call and
  Settings windows): focus in an app window does not stop the blink or flash.
- **Quit.** Tray Exit (and OS shutdown) is unconditional: `isQuitting` makes every app window's
  `will-prevent-unload` override synchronously, windows close with the app, then the existing quit flush and
  `quitTerminator` run. An app window never blocks Exit and never triggers P2 (P2 is for a live call). Unsaved
  Docs edits are lost only if Docs had not yet autosaved; accepted.
- **Hidden main window.** Opening a Chat link from an app window while the main window is hidden shows it (section 3).
- **Call window.** A Meet link clicked in an app window opens/focuses the call window by the existing
  `openCallWindow` rules; the singleton and second-link rule are untouched.

### Native dialog wording (the only app-authored text)

| Dialog | When | Text | Buttons (default, Esc) |
|---|---|---|---|
| Close app window | close probe saw an objection | Title "Close this window?"; message "This page has changes that may not be saved." | "Close window", "Keep window open" (default and Esc: keep) |
| Save dialog | every download (app windows and main window) | the OS save dialog; default folder = OS Downloads | OS standard |
| Download blocked | a download failed the origin check (one box per window; a second blocked download while open is folded in) | Title "Download blocked"; message "This download comes from an address the app does not allow." | "Close" (default and Esc), "Open in browser" (https only) |

## 9. Test-coverage map (Coverage-First: net written and green before the code it covers)

U = unit (`node:test`, no Electron). I = integration (real Electron; stand-in pages served under the Google
origins as in `spike/meet/`). M = manual on a real desktop.

| Surface | Level | What is asserted |
|---|---|---|
| `classifyGoogleLink` | U | Every link-list host `https` -> `app-window` with normalised href; owner's example `https://drive.google.com/file/d/FILE_ID/view?usp=sharing` -> `app-window`; `https://chat.google.com/x` -> `main-window` outcome (path handling is `classifyChatTarget`); `accounts.google.com` and `drive.usercontent.google.com` -> `none` (never an entry point); `https://forms.gle/abc` -> `app-window` with `hop: true`; `http://forms.gle/..`, `forms.gle:8443`, `evilforms.gle`, `forms.gle.evil.example` -> `none`; `http:` form, `:8443`, userinfo, `docs.google.com.evil.example`, `evil-docs.google.com`, `xdocs.google.com`, trailing dot, uppercase host (normalises, passes), `file:`/`javascript:`/garbage/non-string -> `none`, never throws. |
| Wrapper | U | `www.google.com/url?q=<drive link>` -> `app-window` with the **target's** href (also `q=<forms.gle link>` -> hop); duplicated `q`, wrapper-in-wrapper, wrapper with port/userinfo, wrapper whose target is evil -> `none`. |
| `isGoogleNavigationUrl` | U | The nav list exactly (link list plus `accounts.google.com`); **not** `drive.usercontent.google.com`, not `forms.gle`, no `*.googleusercontent.com`, no `accounts.youtube.com`, no `chat`/`meet`. |
| `isDownloadHop` | U | `will-redirect` to `https://drive.usercontent.google.com/download?id=..` from a drive.google.com / docs.google.com page -> allowed; same URL as a non-redirect `will-navigate` from a drive page -> refused; from a Chat link, a popup or a window on another host -> refused; path `/download/x`, `/foo`, `/` -> refused; `http:` or port -> refused; interstitial follow-up `/download?...&confirm=t` from a window already on `usercontent /download` -> allowed, `/other` from there -> refused. **Initial load:** `will-redirect` to `https://drive.usercontent.google.com/download?id=..` with `fromUrl` = the requested `https://drive.google.com/uc?export=download&id=..` and empty `windowUrl` -> allowed; same with a requested `docs.google.com` URL -> allowed; requested URL on any other host, or empty `fromUrl` with empty `windowUrl` -> refused. |
| `isDownloadChainUrl` and download-chain hosts | U | `DOWNLOAD_CHAIN_HOSTS` is frozen and **empty**; every nav-list origin and `usercontent /download` -> true; `usercontent /other`, `*.googleusercontent.com`, `forms.gle`, `http:`, port, userinfo -> false; with a host injected into the list for the test, that exact host -> true and a suffix/lookalike of it -> false, and `isGoogleNavigationUrl` for it stays **false** (the list never widens the nav list). |
| `classifyChatTarget` | U | Source `app`: conversation shapes -> `main-window`; download shapes (`/api/get_attachment_url`-style, `attachment`, `download`) -> `browser`. Source `main`: download shapes -> `download`; conversation shapes -> `focus-main`; pop-out or unknown path -> `browser` (both sources). **Precedence:** a path matching both (`/room/x/attachment/1`, `/dm/y/download`) -> the download-shape outcome. `/u/<n>` prefix stripped; lookalike hosts never reach it. Same-URL `main-window` target -> focus only (no `loadURL`, tested at the wiring level). |
| Router | U | Order Meet > Chat > Google app > external > dropped; `openMainWindow`/`openGoogleAppWindow` called once with the normalised url and `openExternal` never; main-window chat attachment popup calls `downloadURL`, not `loadURL`; main-window popup with a conversation shape focuses the main window and never calls `loadURL`; app-window attachment link -> `openExternal`, never `downloadURL`; `forms.gle` from an app window -> the app-window collaborator with `hop: true`, not `openExternal`; absent collaborators -> exactly today's behaviour (existing router and call-window tests unchanged and green); popup always `{action:'deny'}`. |
| Window factory | U | Dedupe by href-without-fragment; registry set synchronously (two calls, one window); removed on `closed`; destroy on close. **Fragment rule:** link with `#h` to an open window still on that page -> `loadURL(full href)` + focus, no new window; window moved elsewhere or link without fragment -> focus only. `forms.gle` hop: created hidden; `will-redirect` to docs -> allowed, then shown at `did-navigate` (re-deduped by final href); `will-redirect` to a non-nav-list target -> `preventDefault()` called, window destroyed, **that target** to the browser stub, never shown; no-redirect `did-navigate` on a non-nav-list host (or `forms.gle` itself) -> destroyed, original URL to the browser stub; failure / 10 s timeout -> destroyed, original URL to the browser stub. **Coalescing:** a second click while pending creates no window and never calls `show()`/`focus()`; after the hop resolves, a click behaves normally. A `forms.gle` popup or navigation from inside an app window uses the same hop (never navigates in place). **Empty-window auto-close:** an app window with no displayed page whose only navigation became a download is destroyed when the download ends; a window that displayed a page is not. **Routed-away initial load:** a never-displayed window whose main-frame `will-navigate`/`will-redirect` is routed to the browser (or to the call window) is destroyed after the route and its registry entry freed; allowed navigations and download hops, sub-frame navigations and popups never destroy it; a window that displayed a page (`did-navigate`) is never auto-closed (`test/googleAppWindow.test.js`, "initial load"). **Keyboard shortcuts:** each app window (hop windows too) handles Ctrl/Cmd + C, X, V, A, Z and Shift+Z through the shared helper on its own contents only; key-up, no modifier, Ctrl+W/Q/Y are neither handled nor consumed; `index.js` uses the same helper for the main window (`test/editShortcuts.test.js`). |
| Window options | I | Created with exactly `contextIsolation: true`, `nodeIntegration: false`, `nodeIntegrationInSubFrames: false`, `sandbox: true`, `webSecurity: true`, `allowRunningInsecureContent: false`, `webviewTag: false`, shared `PARTITION`, **no preload**. |
| Navigation and popups | I | In-list nav stays; `accounts.google.com` stays; unlisted host (`maps.google.com`) and `*.googleusercontent.com` main-frame nav/redirect blocked and sent to the browser stub; `drive.usercontent.google.com` as a popup or direct `will-navigate` -> browser stub, as a `will-redirect` hop from a drive page -> stays; popup to a list host creates a **hardened** window (options asserted), popup to evil goes to the browser stub; Chat -> main-window stub; Meet -> call-window stub. |
| Downloads | U + I | **App window:** https/blob where final URL **and every chain entry** are nav-list origins (or `usercontent /download`) proceed with a save dialog (default path basename-only, traversal name neutralised); a chain with one unlisted hop (final URL listed) is cancelled; other scheme/origin cancelled; a chain host added to the download-chain list passes, and the same host is still not navigable. **Blocked notice:** buttons "Close" (**default**, Esc) and, for https, "Open in browser" (calls the browser stub for the first item's URL, never loads in-app; blob: "Close" only); a second blocked download while a box is open is cancelled with **no second box**; parent hidden/minimized or empty-window auto-close -> box shown unparented; parent destroyed while open -> box dismissed and a late "Open in browser" result ignored. **Main window:** https/blob any host gets the save dialog, other schemes cancelled with the notice; **Chat `downloadURL` path** ends in the same handler. No `shell.openPath` anywhere; nothing logged but status. |
| Permissions | U | `clipboard-sanitized-write` and `fullscreen`: granted only when requesting **and** top-level are docs or drive (check handler via `embeddingOrigin`, request handler via the asking contents' URL); denied for: calendar, mail, **docs/drive frame embedded under `chat.google.com`** (requesting listed, top-level Chat), embedded frame under a non-listed top, empty/unparseable top-level; read/media/notifications/display-capture denied for all app-window origins; existing Chat and Meet decisions unchanged. |
| Fullscreen | I + M | Stand-in docs page requesting fullscreen in an app window: entered and Esc exits; same request from the main window (Chat) unchanged. Manual: Slides "Present" and a Drive video enter and leave fullscreen. |
| `will-prevent-unload` | I | Objecting stub (a page that registers `beforeunload` and sets a returnValue, as the probe expects) in an app window: app close (X/Alt+F4) -> dialog (stubbed), "Close window" destroys, "Keep" keeps; quit -> completes and `will-quit` is reached; page-initiated objection not overridden; probe timeout/hung page closes without a dialog; page with no objection closes with no dialog. |
| Quit with windows | I | Several app windows open, then quit: process exits (watch the Windows hang, Meet doc section 8). |
| Owner example end to end | M | Signed-in app, paste the Drive example in Chat, click it: opens in a separate window, already signed in, file previews; **View, Preview, Download and (with a large file) the virus-scan confirm** each work or show the blocked notice, never nothing; Download shows the save dialog and nothing auto-opens. Windows and Linux separately. |
| Observe what Chat actually opens | M | In the real signed-in main window, trigger every Chat action that calls `window.open`: attachment open/download, image preview, message permalink, pop-out, "open in new window", link to another space. Record URL shape and which row of section 3 handles it; freeze the `classifyChatTarget` path lists on this evidence. Confirm an unsent draft survives a permalink load. |
| Open points | M | `window.opener` popups, "Copy link" in Docs and Drive, Calendar/Gmail/Keep/Sites/Contacts links, `forms.gle` (lands on docs, shown only then; also clicked inside a Doc), a non-listed Google link (Maps) goes to the browser, a Drive `uc?export=download` link from Chat (empty window closes after the save), a conversation link clicked in the main window only focuses it. Host observation is step 1 of the order, not here. |

## 10. Implementation order

Each step starts with its tests from section 9 (red), then code, then green. Steps 2 to 3 change no Electron
behaviour. `security-engineer` reviews steps 2, 3, 5, 6 and 7.

1. **Host-observation spike, before any window or download code.** With the real signed-in session in a throwaway
   harness (a bare window on the shared partition that only **logs** main-frame `will-navigate`/`will-redirect`
   URLs (host and path shape only, no query) and `will-download` URL chains), record what hosts these actually
   hit: Drive **View**, **Preview**, **Download**, the **large-file virus-scan confirm** (is it a top-level HTML
   page on `drive.usercontent.google.com`, which request does the "Download anyway" form make), Docs/Sheets
   **export** (Download as), `forms.gle` redirect, Docs "Copy link", Slides Present, and the Chat
   `window.open` observation (section 9). Output: this document's host rules (section 2 hop clause, section 3
   path lists, section 4 chain rule) are confirmed or amended **with evidence and an owner decision** before
   step 2. If a real download needs an unlisted host (for example a `*.googleusercontent.com` hop), add that
   **exact** hostname to the **download-chain hosts** list only, never a pattern, and never to the nav list
   without the owner.
2. `src/main/googleLink.js` against its unit tests (lists, exact-origin, unwrap, hop rule, Chat target classes).
3. Router extension with the two optional deps; existing router/call-window tests stay green.
4. `openMainWindow` and Chat-download wiring (smallest visible win: Chat links stop going to the browser).
5. `googleAppWindow.js` (options, registry, dedupe, fragment rule, forms.gle hop, navigation, popups) and its
   integration tests; wire `openGoogleAppWindow`.
6. `downloads.js` (app-window and main-window rules, blocked notice) and the session `will-download` registration.
7. Clipboard and fullscreen origin set with the requesting-plus-top-level check in `session.js`.
8. Close probe shared helper, `will-prevent-unload`, the one native dialog, quit-with-windows test.
9. Manual run (section 9 M rows); record outcomes in this document; add any evidenced host exactly, with an
   owner decision.

## Open questions

1. **Host list confirmation (orchestrator-chosen defaults).** Mail, Keep, Contacts, Sites are in the link list
   by the orchestrator's choice; `forms.gle` is in as a conditional hop (owner decision). `g.co`, Maps, Apps
   Script, Looker Studio, Groups stay in the system browser. Confirm or change each; add exact hosts on request.
2. **Tray Exit with an app window mid-save:** default is no prompt (Docs autosaves). Say so if you want a
   confirm there.
3. **Google links clicked inside the Meet call window** keep going to the system browser (call window
   unchanged): an **owner-confirmable default**. Say so if shared notes opened from a call should also use an
   app window.
4. **Main-window downloads now always ask where to save** (section 4); previously Electron's default applied.
   Confirm this behaviour change is wanted.

</architecture>

<topics>
- [Requirements FR-17](../business/requirements.md) — behaviour and acceptance criteria.
- [Meet Call Window](meet-call-window.md) — origin rule, router, close probe and quit rules this reuses.
- [Project Rules](project-rules.md) — the security baseline and its two exceptions.
- [Overview](overview.md) — window model and session partition.
</topics>
