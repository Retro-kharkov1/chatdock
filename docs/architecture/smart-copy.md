# Smart Copy (FR-18, UI-05)

<overview>
Design for two copy conveniences (maintainer request UI-05, 2026-10-04): right-click on a link copies the link URL, and
releasing the left mouse button after selecting text copies the selection, each confirmed by a small hint next to
the cursor. Behaviour and acceptance criteria: [FR-18](../business/requirements.md). The standing rules are in
[Project Rules](project-rules.md) and are not restated.

**Shape of the solution (two mechanisms, one per window kind):**

| Window | Right-click link | Copy-on-select |
|---|---|---|
| Main Chat window | main process, `context-menu` (section 1) | **its existing preload** detects the gesture and sends one no-payload signal; main calls `webContents.copy()` (section 2) |
| Google app windows (FR-17) | main process, `context-menu`; **no preload, ever** | **none** (decision A, section 3) |

Maintainer rule 2026-10-04: never copy-on-select in the message composer or any editable field. That cannot be known
without reading the page, so copy-on-select exists **only** in the main Chat window, whose existing preload gains
**one narrow, validated, one-way channel** (recorded in [Project Rules](project-rules.md) and
[IPC Contract](ipc-contract.md)). Google app windows cannot detect editable fields without a preload, so they get **no
copy-on-select at all** (decision A, 2026-10-04); right-click link copy still works there. The only other added
surface is one app-owned hint window (*Design scaled to the wrapper*: wording below, no mockup). Evidence base:
`node_modules/electron/electron.d.ts` of Electron 44.4.3.

**Scope:** right-click link copy in the main Chat window and every Google app window ([Google App Windows](google-app-windows.md),
FR-17, hop windows included); copy-on-select in the main Chat window only. **Not** the Meet call window, the Settings
window or the screen-share picker: they never call the binder (section 8 pins this with a test).

**Hint wording (the only app-authored text):**

| Event | Hint |
|---|---|
| A link address copied (http, https, mailto alike) | `Link copied` |
| Selection copied | `Copied` |

Shown about 1.5 s next to the cursor, then gone. No sound, no OS notification. A right-click on a link with any
other scheme (`tel:`, `javascript:`, `data:`, ...) copies nothing and shows **no hint** (no error cue either).
</overview>

<architecture>
## 1. Right-click on a link: `context-menu` in the main process (both window kinds)

`webContents.on('context-menu', (event, params))` (d.ts: "Emitted when there is a new context menu that needs to be
handled") carries `params.linkURL` ("URL of the link that encloses the node the context menu was invoked on"),
`x`, `y`. Nothing is injected into the page.

- **Native menu today: none.** Electron shows no default context menu, and `src/` has no `context-menu` listener
  (searched). A right-click on a non-link stays exactly as it is; the app adds **no menu** on any right-click.
- **Behaviour:** `params.linkURL` non-empty and passing `copyableLinkUrl` (below) -> `clipboard.writeText(url)` in main,
  then the hint `Link copied`. Otherwise nothing at all (no write, no hint).
- **The feature is conditional on the page letting the event through [U].** Chromium raises `context-menu` only if
  the page did not `preventDefault()` its own `contextmenu` DOM event. Where Chat or Docs draws its own right-click
  menu on a link, no event arrives and nothing is copied. The spike (section 7, item 1) records, per Chat surface
  (message text, link preview card, thread list, search results) and per app window, whether the event arrives. The
  FR-18 right-click scenarios are therefore stated as conditional.
- **No preload fallback (decision B, 2026-10-04).** A `{ kind: 'link', href }` payload on the preload channel is
  **not authorised**: it would make the channel carry a page-derived string, which needs maintainer approval and a
  [Project Rules](project-rules.md) change. If the spike shows Chat suppresses `contextmenu` on links in the main
  window, the outcome is: **report to the maintainer**; right-click link copy then works in Google app windows only (a
  documented limitation). Nothing is built for it.
- **`copyableLinkUrl(raw) -> string | null` (pure, `src/main/smartCopy.js`, never throws):**
  1. Non-string, empty, longer than 8192 chars, or containing a control character -> `null`.
  2. Parse with WHATWG `URL`; unparseable -> `null`.
  3. **Unwrap once:** if it is exactly `https://www.google.com/url` (no port, no userinfo, path `/url`, exactly one
     `q`) the target is the decoded `q` value. This is the existing `unwrapTarget`, which is today **duplicated and not
     exported** in `src/main/meetLink.js` and `src/main/googleLink.js`: it moves to a new small module
     **`src/main/wrapperUrl.js`** (exports `unwrapTarget(u)`, with the wrapper constants); `meetLink.js`,
     `googleLink.js` and `smartCopy.js` all import it. No third copy. The existing link tests pin the behaviour of the
     refactor. **Exactly once:** a wrapper whose target is itself a `https://www.google.com/url?q=...` wrapper yields
     that **inner wrapper URL as text** (it is a valid `https:` target, step 4), not the final destination; it is never
     unwrapped a second time. Pinned by a test.
  4. The target must parse and its protocol must be `http:`, `https:` or `mailto:` (the existing
     `isOpenableExternalScheme`). `javascript:`, `data:`, `blob:`, `file:`, `tel:` and everything else -> `null`.
  5. **What is returned (real behaviour, review finding 6).** `params.linkURL` is a Chromium `GURL` spec, **already
     canonicalised** before it reaches the app: host lower-cased, empty path made `/` (`https://example.com` arrives as
     `https://example.com/`), spaces and non-ASCII percent-encoded. The author's original spelling is not
     recoverable and is not promised. A direct link is therefore returned exactly as given (the canonical form,
     never re-serialised again); a wrapped link returns the decoded `q` text verbatim (it is what the author put in
     the wrapper). `mailto:` is copied with its scheme (a recommended default, not a decision).

## 2. Copy-on-select in the main window: a preload signal

The existing `src/preload/preload.js` (sandboxed; its only imports stay `electron`) gains an **internal** listener. It
exposes **nothing** through `contextBridge`: the page can neither call it nor see it. Page-visible surface: unchanged
(`__gcdBridge` keeps its three functions).

**Detector (in the preload, capture phase on `window`, `mousedown` and `mouseup`, never `preventDefault`/`stopPropagation`):**

1. Only `event.isTrusted` and `button === 0`; Ctrl, Alt or Meta held -> ignored (Shift allowed).
2. On `mousedown`, remember `{x, y, detail, target-in-editable?}` and the selection's boundary points
   (`anchorNode`, `anchorOffset`, `focusNode`, `focusOffset`); no text is stored.
3. On `mouseup`, it is a **selection gesture** if `max(downDetail, upDetail) >= 2` (double, triple click) or the
   pointer moved at least 4 px between down and up (a drag). A plain click is not.
4. Then, immediately (the selection is final at `mouseup`; no timer, no delay), `const sel = window.getSelection()`.
   **Send nothing** unless all hold:
   - `sel.rangeCount > 0`, `!sel.isCollapsed` and `sel.toString().trim() !== ''`;
   - **not stale (review finding 8, fixed here):** the boundary points differ from those remembered at `mousedown`
     (a drag that starts on blank area or a scrollbar while an old selection survives does not re-copy it);
   - **not editable:** none of the `mousedown` target, the `mouseup` target (both from `composedPath()[0]`), the
     selection's anchor and focus nodes' parent elements, and `document.activeElement` (followed through open shadow
     roots) is, or is inside, `input`, `textarea`, an element with `isContentEditable === true`, or `[role="textbox"]`.
     `activeElement` is part of the test because Chromium reports a selection made inside an `input` or `textarea`
     with the anchor on the container, not on the field. When unsure the answer is "editable": no copy.
5. `ipcRenderer.send('smartcopy:signal', { kind: 'selection' })`. **No text, no coordinates, no element data.**

**Main handler (`src/main/smartCopy.js`, injected deps):** accepts only if `event.sender === mainWindow.webContents`,
`event.senderFrame` is **non-null** (a null frame, e.g. a navigated-away or destroyed frame, is rejected) and
`=== event.sender.mainFrame`, the frame URL's origin is in the notification origins (chat only;
`src/main/originCheck.js`, exact equality; so a main window sitting on `accounts.google.com` for sign-in is rejected),
the payload is exactly `{ kind: 'selection' }` (anything else, and any extra key, is dropped), and the window is not
destroyed. Rejections are logged as outcome only, no content.

**Rate limit is trailing-edge (review finding 2).** A 100 ms window limits copies. A signal arriving while the window is idle
copies at once (leading); signals arriving inside the window do not copy at once but set **one** pending trailing copy
that fires at the window's end against the then-current selection, so the **last** signal wins. Example: double click
then triple click within 100 ms ends with the paragraph on the clipboard, not the word. The timer checks
`isDestroyed()` before acting and is cleared on the window's `closed`. Each actual `copy()` shows the hint
`Copied` at `screen.getCursorScreenPoint()` (restarting its 1.5 s).

**Decision (review: text vs signal): send a signal, main calls `webContents.copy()`; not the text.**

| | Signal + `copy()` (chosen) | Send selected text, main `clipboard.writeText` |
|---|---|---|
| Result equals Ctrl+C (rich text/HTML, links, images in the selection) | yes: pasting into Docs or Gmail keeps formatting | no: plain text only, formatting lost |
| Selected text crosses IPC, needs a length bound, may be truncated or refused | no payload at all | yes: a cap that either truncates or silently drops big selections |
| Page can alter what lands on the clipboard | via its own `copy` handler (`clipboardData.setData`), same as for the user's Ctrl+C: accepted, see below | no `copy` event fires: not possible |
| Confirmation needs a clipboard read/diff | **no**: the hint means "a non-empty, non-editable selection was seen and `copy()` was issued", not "the clipboard changed". It can be wrong where the page's `copy` handler cancels the default or writes nothing, or where the selection lives in a cross-origin iframe the preload cannot see (no signal, so no copy and no hint). Accepted. | no |

Parity with Ctrl+C and a payload-free channel outweigh the one advantage of the alternative. The residual risk
(the page's `copy` event) is the same one the user already has with Ctrl+C and is **accepted**.

**Accepted risk, page-chosen content (review finding 9).** (a) `copy()` fires the page's `copy` event, so the page may put
different data than the visible selection on the clipboard, exactly as it can for Ctrl+C. (b) A page script can
set the selection programmatically; if the user then releases a genuine, trusted left button in a way that
satisfies the detector, that page-chosen text is copied. Both need a real user mouse gesture, and the page can
already write the clipboard from a user gesture (`navigator.clipboard.writeText`, `clipboard-sanitized-write` is
granted for Docs and Drive). No new capability is handed to the page, and the page cannot trigger a copy without a
trusted `mouseup` (`isTrusted` cannot be forged; `select()`, `execCommand` and dispatched events do nothing).

**Known limits [U], spike items:** selections inside cross-origin iframes of the Chat page are invisible to the
main-frame preload (no sub-frame preload, none is added); selections inside closed shadow roots cannot be seen and
are treated as not selected. The spike (section 7, item 4) checks whether Chat renders any text or editor inside an
open or closed shadow root; if an editor can sit in a **closed** root the preload cannot see it, so the detector's
"editable" answer is incomplete there and the maintainer is told (the rule "when unsure, no copy" cannot be applied to
what cannot be seen).

## 3. Google app windows: no copy-on-select (decision A)

Google app windows get **no copy-on-select**. They have no preload (by rule), so the app cannot tell an editable field
(search box, rename field, whole-page editors in Docs, Sheets, Slides, Gmail, Keep) from plain text, and the maintainer rule
is never to copy-on-select in an editable field. Selecting text there behaves exactly as today; Ctrl+C works as today.
Right-click link copy (section 1) still works in these windows. Consequently this design has **no**
`before-mouse-event` handler, no clipboard poll/diff, no read budget, no `SELECT_COPY_EXCLUDED_HOSTS` list and no
latency spike item; the "stale selection" edge and the hint-confirmation caveat of that path do not exist.
*Considered and rejected:* `before-mouse-event` + `copy()` with a clipboard diff and a host exclusion list (see the
overview).

## 4. The hint window (`src/main/copyHint.js` and `src/renderer/copy-hint.html`)

Electron has no tooltip API, so the hint is a small app-owned `BrowserWindow`. Rejected: an OS notification (maintainer
choice) and a `WebContentsView` overlay in each window (cannot be click-through, one per window).

- **Options:** `frame: false`, `transparent: true`, `focusable: false`, `skipTaskbar: true`, `show: false`,
  `resizable: false`, `movable: false`, `hasShadow: false`, `alwaysOnTop: true` with
  `setAlwaysOnTop(true, 'pop-up-menu')`, size from the fixed widths below (DIPs, height 28). `webPreferences`:
  `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webSecurity: true`, `webviewTag: false`,
  **no preload**.
- **Own session, all permissions denied (review finding 3).** `partition: 'gcd-copy-hint'`: an explicit **non-persistent**
  named partition (no `persist:` prefix), so it never shares the Google session and nothing is stored. After creation
  the manager applies the pattern of `pickerWindow.js` (`configurePickerSession`, lines 49 to 53):
  `setPermissionRequestHandler((_, __, cb) => cb(false))` and `setPermissionCheckHandler(() => false)`. "No
  partition" is rejected: it would silently fall into the default session.
- After creation: `setIgnoreMouseEvents(true)` (click-through), `setWindowOpenHandler(() => ({action: 'deny'}))`,
  `will-navigate` prevented. Content is `loadFile` of the bundled local HTML only; no remote URL, ever.
- **Never steals focus:** `focusable: false` plus `showInactive()` (never `show()`/`focus()`); not a parent of anything.
- **No blank flash (review finding 11).** The sequence is strictly: create (hidden) -> `await loadFile` (the `did-finish-load`
  of the local page) -> `await executeJavaScript(<swap to the wanted string>)` -> `setBounds` (size and position) ->
  `showInactive()`. The window is never shown before the page is loaded and the right text is in it. For a reused
  window the text is swapped and the bounds set before the timer restarts; if it is already visible, the swap is one
  frame, accepted. Until the first load completes, a hint request is queued (latest wins), never dropped.
- **Text without IPC (review finding 6).** One reused instance (created lazily). The page (`copy-hint.html` plus a local
  `copy-hint.css`) contains **no script**. Both strings live in the CSS as `body.copied::before { content: "Copied" }`
  and `body.link-copied::before { content: "Link copied" }`. Main switches by `executeJavaScript` of one of **two fixed
  string constants** (`document.body.className='copied'` / `='link-copied'`) picked from a frozen two-entry table on
  its **own** page; nothing page-supplied or user-supplied is ever concatenated into the script. CSP, a `<meta>` in
  the page: `default-src 'none'; style-src 'self'` (no `script-src`, so the page can run no script of its own;
  `executeJavaScript` is an app-side call, not page script). Fixed widths: `Copied` 76, `Link copied` 104.
- **Position:** `screen.getCursorScreenPoint()` taken at the event (DIPs), offset **+12 px right, +18 px down**, clamped
  inside `screen.getDisplayNearestPoint(cursor).workArea` (flipped left of or above the cursor when it would overflow).
  **Mixed-DPI (review finding 12) is an explicit spike item**: on Windows with two monitors at different scale factors,
  `setBounds` in DIPs is known to land off when the window moves between displays. The spike verifies the hint lands
  within 2 DIP of the intended point on each monitor, including when the previous hint was on the other one. Fallback if
  it does not: set size and position in one `setBounds` call after `setPosition` onto the target display (a
  hide/move/show), and if still off, anchor to the bottom centre of the cursor's display.
- **Lifetime and destruction safety (review finding 10).** `showInactive()`, a single 1.5 s timer; a new hint **restarts** the
  timer and replaces the text (never a second window). `hide()` at expiry. Every asynchronous continuation (after
  `loadFile`, after `executeJavaScript`, the 1.5 s timer, the idle timer) first checks `win.isDestroyed()` and does
  nothing if true. The manager clears its timers and nulls its instance on the window's `closed`. The signal handler's
  trailing-edge timer (section 2) does the same for the main window. Destroyed on app quit (before the quit flush; never blocks Exit) and after 5 minutes without a hint
  (NFR-02); recreated on demand, the first hint after that is ~100 to 200 ms late [U].
- **Theme:** `prefers-color-scheme`, following the OS through `nativeTheme` (as `src/renderer/settings.css` relies on).
  Light: dark text on near-white, dark mode inverted, 1 px border, 6 px radius, system font 12 px, `nowrap`.
- **Not an app window for any purpose:** not in the Google app window registry, not counted by `window-all-closed`,
  not an attention/focus source (FR-14 watches the main window only), no tray entry.
- **Platform risks, verified on a real desktop [U]:** Wayland may ignore the requested position, and a transparent window
  needs a compositor on Linux; if either fails the fallback is an opaque window.

## 5. Interaction with existing behaviour

- **Edit shortcuts:** untouched; Ctrl+C/X/V/A/Z behave as in `editShortcuts.js`.
- **BUG-02 / FR-17 clipboard permission:** the page's own `navigator.clipboard.writeText` is unchanged; smart copy uses no
  page permission. No change to `session.js`.
- **Google app windows (UI-04):** `createGoogleAppWindowManager` receives an **optional** `bindSmartCopy` dependency
  (absent means today's behaviour) and calls it next to `bindEditShortcuts(contents)`. Window options (no preload,
  hardening) do not change. The binder it gets is the Google-window variant: `context-menu` link copy only.
- **Meet call window, Settings window, picker:** not bound; a test pins that `callWindow.js` never references the binder.
- **Chat main window:** `index.js` binds the main-window variant (`context-menu` for links, and the `smartcopy:signal`
  handler) next to `bindEditShortcuts(mainWindow.webContents)`. The preload gains the internal listener of section 2;
  its exposed `__gcdBridge` surface does not change. [IPC Contract](ipc-contract.md) lists the channel.
- **Logging:** outcome only (`link copied`, `selection copied`, `signal rejected`). Never URLs, selected text or clipboard content.
- **Privacy side effect (state it to the user):** anything selected lands on the OS clipboard, so Windows clipboard
  history and cloud sync see it. Intended; mentioned in the release notes.
- **No setting:** no tray entry or Settings toggle in this version; see the maintainer question.

## 6. Units

| Unit | File | Kind | Purpose |
|---|---|---|---|
| Wrapper unwrap | `src/main/wrapperUrl.js` | pure, new | `unwrapTarget(u)`; imported by `meetLink.js`, `googleLink.js`, `smartCopy.js` |
| Link filter | `src/main/smartCopy.js` | pure | `copyableLinkUrl(raw)` (section 1) |
| Binders | `src/main/smartCopy.js` | main, deps injected (`clipboard`, `showHint`, `timers`, `log`, origin check) | `bindSmartCopyMain(webContents)` (links + trailing-edge signal handler), `bindSmartCopyApp(webContents)` (links only); no Electron import |
| Selection detector | `src/preload/preload.js` | preload, internal | section 2; no new exposed function |
| Hint window | `src/main/copyHint.js` | main, deps injected (`BrowserWindow`, `screen`, `session`) | `showHint(kind, cursorPoint)`: position, timers, idle destroy, partition |
| Hint page | `src/renderer/copy-hint.html` + `copy-hint.css` | static, no script | two fixed strings as CSS `content`, theme-aware, CSP `default-src 'none'; style-src 'self'` |

Wiring only: `index.js` (main binder, the hint manager, destroy at quit), `googleAppWindow.js` (one optional dependency,
one call per window), and the three importers of `wrapperUrl.js`.

## 7. Spike

A throwaway harness, no product code, run on a real desktop before the dependent code is written. Items:
1. **`context-menu` arrival per surface:** which Chat surfaces (message text, link preview card, thread list, search
   results) and which app windows raise it on a link. If the main window never does: report to the maintainer (decision B,
   section 1); no preload fallback is built.
2. **Preload detector on real Chat:** a drag, double-click and triple-click in a message produce exactly one signal; the
   composer, the search box, a thread reply box and a rename field produce none; selections in Chat iframes (if any)
   noted; **shadow roots:** whether Chat puts any text or editable element inside an open or closed shadow root
   (closed roots are invisible to the detector, section 2).
3. **Mixed-DPI placement (section 4):** two monitors with different scaling, hint within 2 DIP of the cursor.
4. **Multi-click timing:** double then triple click in quick succession ends with the paragraph on the clipboard
   (trailing-edge limit, section 2).

## 8. Test-coverage map (Coverage-First)

U = unit (`node:test`, stubbed Electron, like `test/editShortcuts.test.js`, `test/googleAppWindow.test.js` and the
stub-load approach of `test/pickerPreload.test.js` for the preload). M = manual on a real desktop.

**Written and green BEFORE the spike** (they do not depend on a spike outcome): the `wrapperUrl` refactor (existing
`meetLink`/`googleLink` tests stay green, plus a test that all three modules import the one function), `copyableLinkUrl`,
the main-side `smartcopy:signal` handler (sender/frame/origin/payload validation, trailing-edge rate limit, `copy()` + hint, no
content logged), the preload detector against a stubbed `window`/`document`/`ipcRenderer` (all rows below), the hint
**Deferred until the spike** (their constants or existence depend on it): the mixed-DPI placement rows only.
There are no Google-window selection rows (decision A) and no preload link fallback rows (decision B).

| Surface | Level | Timing | What is asserted |
|---|---|---|---|
| `wrapperUrl` | U | before | the unwrap rules (single `q`, no port/userinfo, path `/url`); one export imported by `meetLink.js`, `googleLink.js`, `smartCopy.js` (source pin: no local `function unwrapTarget` in the other two) |
| `copyableLinkUrl` | U | before | http/https/mailto returned as given; **`https://example.com/` (canonical form, what `linkURL` delivers) returned unchanged and not re-serialised; the test does not feed `https://example.com` and expect a different output**; `www.google.com/url?q=<https target>` -> the decoded `q` text; duplicated `q`, wrapper with port/userinfo, wrapper whose target is `javascript:` -> `null`; **wrapper inside wrapper -> the inner wrapper URL as text, unwrapped exactly once (not the final destination)**; `javascript:`, `data:`, `blob:`, `file:`, `vbscript:`, `tel:`, garbage, empty, non-string, over-long, control characters -> `null`; never throws |
| Preload detector | U | before | trusted left `mouseup` after drag >= 4 px, double, triple click with a non-collapsed non-editable selection -> exactly one `send('smartcopy:signal', {kind:'selection'})`; single click, 3 px drag, untrusted (`isTrusted` false, page-dispatched) events, right/middle button, Ctrl/Alt/Meta -> none; selection unchanged since `mousedown` -> none (stale); collapsed or whitespace-only -> none; anchor or focus inside `input`, `textarea`, `contenteditable`, `[role=textbox]`, `activeElement` an editable (incl. through a shadow root), `mousedown` or `mouseup` target editable -> none; no `preventDefault`/`stopPropagation`; no text or element data in the payload; nothing new on `__gcdBridge` |
| Main signal handler | U | before | accepted only from `mainWindow.webContents` main frame whose origin is chat; other sender/frame/origin, **null `senderFrame`**, a **main window on `accounts.google.com`**, extra keys, wrong `kind`, non-object -> dropped and logged without content; on accept `copy()` once and hint `Copied`; **trailing-edge limit: a signal after an idle window copies at once; 2 signals within 100 ms -> one immediate and one trailing `copy()` at the window end (last signal wins, e.g. double then triple click), 5 signals in the window -> one trailing copy; `isDestroyed()` true at the trailing timer -> no `copy()`, no hint, no throw; `closed` clears the timer**; destroyed window -> nothing |
| Binder, links | U | before | `context-menu` with a good `linkURL` -> `clipboard.writeText` once with the filtered URL and hint `Link copied`; mailto -> same hint; bad scheme (`tel:`), empty `linkURL` -> no write, no hint; wrapped link -> target written; event not `preventDefault`ed and no `Menu` built; no write on any other event |
| Hint window | U | before | options exactly as section 4 (focusable false, transparent, frameless, skipTaskbar, alwaysOnTop, sandbox, contextIsolation, no nodeIntegration, **no preload**, `partition: 'gcd-copy-hint'` without `persist:`); permission request handler denies and check handler returns false for every permission; `setIgnoreMouseEvents(true)`; `showInactive` never `show`/`focus`; **never shown before load and text swap resolved (call order: `loadFile` resolved, swap resolved, `showInactive`)**; a request during the first load is queued, latest wins; one instance reused; restart of the 1.5 s timer; hide at expiry; position = cursor + offset, flipped and clamped (two displays, one with a negative origin); idle destroy after 5 min; destroyed at quit; popups denied, navigation prevented; only the two table strings can be set; **the page has no `<script>` and its CSP has no `script-src` (source pin); the injected script is one of the two fixed constants;** **`isDestroyed()` true before the swap, the show, the expiry or the idle timer -> no call on the window, no throw; `closed` clears timers and nulls the instance** |
| Hint mixed-DPI | U/M | **deferred** | placement rows per spike item 3 |
| Wiring | U | before | `googleAppWindow` calls the optional binder once per created window (hop windows too) and works unchanged without it; `index.js` source binds the main-window variant; `callWindow.js`, the Settings window and `pickerWindow.js` never reference the binder; the preload still passes the existing exposed-surface test |
| Spike | M | first | section 7 |
| End to end | M | after | Main window: drag, double-click, triple-click in a message -> clipboard and hint; **composer, thread reply box, search box in Chat: select text -> no copy, no hint, clipboard untouched**; main window on the sign-in page -> no copy; right-click on a link in a Chat message (plain and wrapped) -> target and `Link copied` where the event arrives (recorded per surface); right-click on text, empty area, `tel:` link -> nothing; **Drive, Calendar and Docs windows: select text -> nothing copied, no hint; right-click link copy where the event arrives**; Meet call window -> neither feature; Ctrl+C unchanged; pasting a main-window auto-copy into Docs keeps formatting; focus stays in the page while the hint shows; hint near each screen edge, light and dark OS theme; Windows and Linux (X11, Wayland) separately |

## 9. Implementation order

Each step starts with its tests from section 8 (red where it is code), then code, then green.

1. **Spike** (section 7).
2. `wrapperUrl.js` extraction, then `copyableLinkUrl`.
3. Preload detector and the main signal handler, with their tests (the "before" rows).
4. Link binder, `copyHint.js`, `copy-hint.html` and `copy-hint.css`.
5. Spike-dependent: mixed-DPI fix.
6. Wiring: main window in `index.js`, then the optional dependency in `googleAppWindow.js`; the "not Meet" pin tests.
7. Manual end-to-end run on Windows and Linux; record outcomes here. `security-engineer` reviews steps 3 to 6 (the new
   preload code and channel first).

## 10. Open questions for the maintainer

Composer behaviour is **decided** (2026-10-04): never copied, by the preload; Google app windows have no copy-on-select
(decision A); the preload link fallback is not authorised (decision B). Remaining:
1. **Settings toggle** to switch smart copy off: recommended as a follow-up only if it annoys in practice.
2. **If the spike shows Chat suppresses `contextmenu` on links in the main window:** right-click link copy then works in
   app windows only; the maintainer decides whether that is acceptable or whether to authorise a preload payload (a
   [Project Rules](project-rules.md) change).
</architecture>

<topics>
- [Requirements FR-18](../business/requirements.md) — behaviour and acceptance criteria.
- [Google App Windows](google-app-windows.md) — the windows this also covers (UI-04); keyboard shortcuts in section 4.
- [Project Rules](project-rules.md) — wrapper not a rewrite, security baseline (the narrow main-window preload channel), design scaled to the wrapper.
- [IPC Contract](ipc-contract.md) — the `smartcopy:signal` channel.
</topics>
