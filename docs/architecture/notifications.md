# Notifications (FR-05a, FR-05b, FR-05c)

<overview>
The implementation surface for FR-05, which [requirements.md](../business/requirements.md) splits into
three parts of different certainty: **FR-05a** (a native notification appears while the window is hidden,
minimized or unfocused; unconditional), **FR-05b** (title = chat name, body = message; conditional) and
**FR-05c** (click brings the window forward, unconditional; click opens *that* conversation, conditional).
The decision record is [ADR-0004](../adr/0004-desktop-shell-technology-and-electron-retention.md)
(Spikes A and C); [ADR-0002](../adr/0002-notification-delivery-mechanism.md) is the history of the
page-`Notification` design and of the `backgroundThrottling` incident.

**Status.** The BUG-01 fix is implemented: Chat's service-worker and page-initiated
`showNotification()` calls are intercepted and re-raised as main-process Electron toasts (mechanism **M2**),
with an unread-count fallback (**M3**). What is **not** delivered: the specific-conversation click
(FR-05c step 2) and any claim that the chat name is in the title (FR-05b), both still Spike C and an owner
decision. Section 1 describes what the code does and cites the files; it is a description of the code as
verified on 2026-09-30 after the fix, so re-read the named file before relying on a detail. Statements
tagged **[U]** are unverified.
</overview>

<architecture>
## 1. What the code does (verified in `src/`, 2026-09-30, after the BUG-01 fix)

### Delivery paths

| Path | Files | Behaviour |
|---|---|---|
| **Service-worker interception (M2)** | `src/preload/serviceWorkerPreload.js`, `src/main/serviceWorkerNotifications.js` | `session.registerPreloadScript({ type: 'service-worker' })`. The preload runs in the worker's **isolated** world, so it uses `contextBridge.executeInMainWorld` to patch the worker's `ServiceWorkerRegistration.prototype.showNotification`, and sends `{ title, body, silent, tag }` over IPC channel `notification:sw-show` (`ipcRenderer.send`). Main receives it on `ServiceWorkerMain.ipc` and accepts it **only** if the worker's **scope origin** is in the notification allowlist (chat origin only, not the sign-in origin). |
| **Page-initiated `showNotification` (M2, page side)** | `src/main/notifications.js` (injected script) | The same patch on the page realm's `ServiceWorkerRegistration.prototype.showNotification`, forwarded over `notification:show`. Calls made inside Chat's own worker never pass through the page realm, hence the worker path above. |
| **Page `window.Notification` (M1)** | `src/main/notifications.js` | Still wraps the page constructor: mute returns a stub, sound-off forces `silent`, adds a click listener (`notification:clicked`) and now also sends `notification:arrived` so the attention controller sees the arrival. Chat's own click handling on that object is untouched. |
| **Unread-count fallback (M3)** | `src/main/nativeToast.js`, `src/main/unreadTracker.js` | See "Fallback" below. The documented floor. |

**Policy on both interception paths: the original `showNotification` is NOT called.** In Electron 44.4.3
it shows no toast (reported by the implementer, verified by reading the Windows toast store; not re-run
here), and calling both would double up if Electron ever fixed it. The original is called **only** as a
fallback when the bridge is missing or throws, so a notification is never silently lost.

**Recorded trade-off:** because the browser never owns the notification, Chat's worker
`notificationclick` handler and `registration.getNotifications()` **never fire**. A native toast click only
brings the window forward (FR-05c step 1). Opening the conversation (step 2) and any behaviour that relies
on the worker's click handler are **not** delivered by this path. If Spike C shows Chat's own click routing
would have worked, this trade-off is what made it unreachable (mechanism M0 above is therefore closed for
this build).

### Main-process toast service (`src/main/nativeToast.js`)

Everything Electron-shaped is injected. Rules, in the order they are applied to an intercepted request:
- **Sanitising:** title and body are `slice` (to 2x the cap), markup-stripped, then `slice` again to the
  cap (title 200, body 1000); any remaining `<` or `>` is replaced by a look-alike so a Linux notification
  server cannot render markup. Capping first keeps the regex linear on hostile input. No usable title means
  no toast.
- **Tag:** forwarded, capped at 100 characters; a **same-tag toast replaces** (closes) the previous one
  (at most 50 tags tracked).
- **De-dup:** an identical title+body within **200 ms** is treated as double delivery and dropped.
- **Rate limit:** at most **3 toasts per second**; the excess is coalesced into one summary toast
  ("N more notifications"), which is itself mute-aware.
- **Mute (FR-12):** a muted request creates no toast but still counts as an arrival (the attention
  controller applies mute itself). **Sound (FR-11):** `silent` is forced when sound is off.
- **Click:** the toast's `click` calls `focusMainWindow()` (restore, show, focus): FR-05c step 1 only.
  Live toast objects are held until closed so they are not garbage-collected before a click.
- **No toast for the conversation being viewed (FR-05a):** the shell only surfaces calls Chat chose to
  make on this path, so Chat's own suppression stays in force. The fallback applies its own coarser rule.

### Fallback (M3) and the shared unread baseline

`src/main/unreadTracker.js` is **one** baseline shared by the attention controller and the toast service, so
they cannot disagree about whether a title change was an arrival. Raw `(N)` counts go in; only two events
come out: `onIncrease(n)` (a real rise) and `onObserve(n)` (the baseline, a decrease, a confirmed zero;
never starts anything). Rules:
- `onPageLoaded` seeds the baseline from the count already in the title at `did-finish-load`.
- The first non-zero count after a load is the baseline (pre-existing unread), not an arrival.
- A rise within **4 s** of the baseline being set raises the baseline instead of counting as an increase
  (Chat ramps the count while spaces load); a genuine message in that window is covered by the arrival events.
- A zero counts only after it persists **1 s** (a transient title without `(N)` parses as 0).
- Only zeros for **20 s** after load makes the baseline 0, so a later 0 to N is an increase.

On a real increase the toast service matches it to an arrival: one arrival matches one increase (an arrival
up to **5 s before** it, or one within **2.5 s after**). Only an **unmatched** increase raises a **generic**
toast, and only if the main window is not focused and the count is non-zero. That toast currently reads
"1 unread message" / "N unread messages". **Delta from this doc's earlier rule:** whether `(N)` counts
messages or conversations is unknown [U], so a wording that claims a message count may be false; the safe
wording is "New message in Google Chat". Left for the implementer to confirm or change (open question 3).
Content is generic by necessity: this path meets FR-05a but not FR-05b.

### Permissions

`src/main/session.js` grants the `notifications` permission **only to the notification origins** (the chat
origin, plus a loopback origin in a dev run) in **both** the request handler and the (new) check handler.
It also grants `clipboard-sanitized-write` (what `navigator.clipboard.writeText` needs, BUG-02) to the chat
origin **only**, from a separate `clipboardOrigins` allowlist (default `[CHAT_ORIGIN]`), so the dev loopback
origin gets no clipboard write. **Every other permission is denied**, including camera, microphone and
display capture (the Meet gate is still design, see [meet-call-window.md](meet-call-window.md)) and the
other clipboard permissions (`clipboard-read`, `clipboard-write`, `clipboard`, `clipboard-sanitized-read`).
A dev run only:
`GCD_DEV_START_URL` (unpackaged builds, loopback `http`, no userinfo; `src/main/origins.js`) points the
window at a local harness page and adds its origin to both lists.

### Toast identity (Windows)

`src/main/appIdentity.js`: a packaged build uses the literal `dev.retro-kharkov1.google-chat-desktop`; a dev
run appends `.dev`, so a dev run cannot impersonate the installed app. See
[packaging-release.md](packaging-release.md) for why the id is a literal and must not change.

## 2. Page Visibility dependency (kept; load-bearing for any page-level path)

Google Chat decides whether to raise a **page-level** notification by reading `document.visibilityState`.
If the page believes it is `"visible"` it does not alert. That is why `backgroundThrottling` must stay at
Electron's default and why the hidden-autostart path forces a real `showInactive()` then `hide()` (see
[tray-lifecycle.md](tray-lifecycle.md)); the full incident is ADR-0002 Revision 3. Any change that could
distort `visibilityState` (a throttling flag, an overlay window) must be verified by hiding the window and
receiving a real message, not by reasoning (the *Hidden window must stay live* project rule). Whether the
service-worker path also consults visibility is unknown [U] (Spike C).

## 3. Mechanism status (against the earlier candidates)

| ID | Mechanism | Status |
|---|---|---|
| M0 | Chromium shows Chat's own notification natively | **Closed for this build**: the toast does not appear in Electron 44.4.3 / Windows (implementer's finding), and the shipped policy no longer calls the original. |
| M1 | Page `Notification` bridge | Implemented, extended with the arrival signal. |
| **M2** | Intercept `showNotification`, re-raise as a main-process `Notification` | **Feasible on 44.4.3 and implemented** on both the worker and page paths. The Experimental `ServiceWorkerMain` API works for this. It yields **FR-05a, and FR-05c step 1**; the chat name in the title (FR-05b) depends on whether Chat's payload carries it, which is Spike C and **not yet established**. |
| M3 | Generic toast from an unmatched unread increase | Implemented as the floor. |

**M2 does not deliver FR-05c step 2** (opening *that* conversation). That needs a further mechanism, for
example driving Chat's router from an identifier, which is **not designed** here, touches the
*Wrapper, not a rewrite* project rule, and is a separate owner decision (FR-05's open question) and a separate design.

**One path per message.** The de-dup and the arrival-matching above are how a message avoids a second toast
from the fallback; the page-created `window.Notification` toast is the browser's own and is never also
re-raised.

## 4. Tray unread indicator

`page-title-updated` remains the unread-count source: it drives the Windows overlay badge, the tray glyph and
the shared tracker. The tray glyph precedence is now **unread wins over muted** (`resolveIconState` in
`src/main/tray.js`): the static unread indicator is visible whenever anything is unread, independent of mute
and focus, as FR-05a and FR-12 require; the muted glyph shows only when nothing is unread. (The earlier
muted-first precedence hid unread on Linux.)

## 5. Application log (still required, not yet built)

FR-05c's degraded outcome requires a **warning-level entry in a persistent application log**. The code still
only calls `console.error` (for example `index.js` bridge-injection failure, rejected origins, toast
`failed`, service-worker hook failures), so there is **no persistent log** and the FR-05c requirement is
unmet. Minimum contract, unchanged: a size-bounded, rotated file under `app.getPath('userData')`; at least
`warn` and `error`; **never** message text, sender or chat names, cookies, tokens or credentials (the
*Electron security baseline* project rule); a click-resolution warning records only that resolution failed, the mechanism
in use and a timestamp. The service-worker console lines (`[gcd-sw]`) are already filtered by the worker's
scope before being logged, so web-controlled text from other scopes is never surfaced.

## 6. Failure modes to log, not swallow

- Page-bridge `executeJavaScript` injection failure (logged distinctly).
- A service-worker preload or hook failure: logged; the page bridge and the unread fallback remain, so a
  broken worker path degrades to generic toasts rather than to nothing.
- A worker request from a disallowed scope, or a page channel from a disallowed origin: rejected and logged.
- A click that cannot be resolved to a conversation (FR-05c): warning, window still comes forward (once the
  log exists).
- Stale toast clicked after the app fully exited: no live process to receive it; a known limit.

## 7. Verification (the *Verify on a real desktop* project rule)

Every FR-05 scenario tagged `[manual-only]` needs a real toast on a real desktop, and the report must state
which platform was tested. Windows verification does not establish Linux (libnotify) behaviour, which has
never been run in this repo. The `[automatable]` scenarios use stubs; a stub cannot prove a real toast
appears or a real click is delivered. **Not yet confirmed against a real signed-in Google Chat** (only a
harness): what Chat's payload carries (title, tag, data), whether the worker path fires in real use, and
what `(N)` counts.

## Open questions and assumptions

1. **Owner:** FR-05 answer (a) or (b) for FR-05b and step 2 (bounded second source, or generic content and
   focus-only click). M2 is in place either way.
2. **Spike C (real Chat):** does the payload carry the chat name; is the worker actually the source; does the
   payload's `tag` name the sender or the conversation?
3. **`(N)` semantics [U] and the fallback wording:** conversations or messages; change the fallback text to
   "New message in Google Chat" if it cannot be settled.
4. **Version-id caveat:** the worker `running-status-changed` details reported `versionId` 0 in the
   implementer's probe, so the hook is keyed on the wrapper object, not the id; a second worker reporting 0 is
   indistinguishable through this API and is flagged for the real-Chat check.
5. **The trade-off above** (worker click handler and `getNotifications()` never fire) is accepted for now;
   revisit if Spike C finds Chat needs them.
6. **BUG-02 (clipboard writes): fixed.** `clipboard-sanitized-write` is granted to the chat origin only
   (see section above); covered by `test/sessionPermissions.test.js`.
7. **Application log** (section 5) is a required, unbuilt component.
</architecture>

<topics>
- [ADR-0004](../adr/0004-desktop-shell-technology-and-electron-retention.md) — Spikes A, B, C and escalation triggers.
- [ADR-0002](../adr/0002-notification-delivery-mechanism.md) — history of the page-`Notification` design.
- [Tray & Lifecycle](tray-lifecycle.md) — FR-14 attention indicators that consume the arrival event.
- [IPC Contract](ipc-contract.md) — the notification channels and the worker channel.
- [Packaging & Release](packaging-release.md) — the AppUserModelID.
- [Requirements FR-05](../business/requirements.md) — the authority.
</topics>
