# Notifications (FR-05a, FR-05b, FR-05c)

<overview>
The implementation surface for FR-05, which [requirements.md](../business/requirements.md) splits into
three parts of different certainty: **FR-05a** (a native notification appears while the window is
hidden, minimized or unfocused; unconditional), **FR-05b** (title = chat name, body = message; conditional)
and **FR-05c** (click brings the window forward, unconditional; click opens *that* conversation,
conditional). The decision record is [ADR-0004](../adr/0004-desktop-shell-technology-and-electron-retention.md)
(Spikes A and C); [ADR-0002](../adr/0002-notification-delivery-mechanism.md) is the history of the
page-`Notification` design and of the `backgroundThrottling` incident.

**Status: the delivery mechanism is not decided.** Everything under "Candidate delivery mechanisms" is a
design to be chosen between once Spikes A and C report; nothing there is a claim about how Google Chat
or Electron actually behave. Statements tagged **[U]** are unverified. Statements about the current code
cite `file:line` as of 2026-09-30 and must be re-checked when the code moves.
</overview>

<architecture>
## 1. What the code does today (input as of commit d7f69e1, 2026-09-30; not a durable description: an implementer is concurrently adding `src/main/attention.js` and `src/main/appIdentity.js`, so re-read the code before relying on a row)

| Piece | Where | Behaviour |
|---|---|---|
| Page-`Notification` bridge | `src/main/notifications.js:90-117` (`buildNotificationBridgeScript`), injected by `src/main/index.js:209-223` on `dom-ready`, `did-finish-load` and every sound/mute toggle | Wraps **`window.Notification`** in the page's main world: mute returns a stub, sound-off forces `silent`, and adds a `click` listener that calls `window.__gcdBridge.notificationClicked()`. It does **not** touch `ServiceWorkerRegistration.showNotification`. |
| Click handling | `src/main/index.js:430-439`, `src/preload/preload.js:12-14` | `notification:clicked` (sender origin checked) then `focusMainWindow()` (restore if minimized, show, focus). Nothing resolves a conversation. |
| Permission | `src/main/session.js:46-48` | Request handler grants only `notifications`; there is no permission *check* handler. |
| Unread indicator | `src/main/index.js:363-368`, `src/main/notifications.js:130-134` | `page-title-updated` is parsed for a `(N)` prefix; drives the Windows overlay badge (`tray.js:129-137`), the tray glyph and the blink gate. Event-driven, no polling. |
| Toast identity | `src/main/index.js:121-125` | `app.setAppUserModelId('dev.retro-kharkov1.google-chat-desktop')` is called unconditionally, and `package.json` `build.appId` is the same string, so a dev run and a packaged build share one AppUserModelID. |
| Persistent log | none | The only diagnostics are `console.error` calls (`index.js:216, 433`). There is **no persistent application log** (needed by FR-05c, see section 6). |

### Reported diagnosis (earlier `electron-developer` investigation, reproduced in harnesses, **not confirmed against a real signed-in Chat**)

| Report | Consequence for the design |
|---|---|
| `ServiceWorkerRegistration.showNotification()` shows no toast in Electron 44.4.3 on Windows | If Chat notifies through the service worker (the 2026-09-30 finding in FR-05's history), the bridge above never sees it and Chromium may not show it either. Candidate cause of BUG-01. [U] |
| The bridge only wraps `window.Notification` | Confirmed by reading the code (table above). |
| Dev and packaged builds share one AUMID; the toast header shows "Electron" | Confirmed for the AUMID (table above). The header text is a report. [U] |
| A synthetic toast click produced `close`, not `click` | If real clicks behave the same, no click-based design (FR-05c) works. Spike A must click a **real** toast. [U] |

None of these is a settled root cause. The owner also observed that toasts started appearing after
diagnostic activity, so the failure may be state-dependent (Focus Assist, per-app notification settings,
AUMID/shortcut registration) rather than a code defect. The design below does not assume either.

## 2. Page Visibility dependency (kept; still load-bearing for any page-level path)

Google Chat decides whether to raise a **page-level** notification by reading `document.visibilityState`.
If the page believes it is `"visible"` it does not alert. That is why `backgroundThrottling` must stay at
Electron's default and why the hidden-autostart path forces a real `showInactive()` then `hide()` (see
[tray-lifecycle.md](tray-lifecycle.md)); the full incident is ADR-0002 Revision 3. Any change that could
distort `visibilityState` (a throttling flag, an overlay window) must be verified by hiding the window and
receiving a real message, not by reasoning (space rule `hidden-window-must-stay-live`).

This dependency governs **only the page-level path**. Whether the service-worker path also consults
visibility is unknown [U] (Spike C).

## 3. Candidate delivery mechanisms (choose after Spikes A and C)

The requirement (FR-05a) is a native toast in three "not focused" states. Four mechanisms can deliver it;
they are ordered by how little they add.

| ID | Mechanism | Content (FR-05b) | Click (FR-05c) | What must be true | Status |
|---|---|---|---|---|---|
| **M0** | Chromium shows Chat's own notification natively; the shell only fixes the environment (toast identity, permissions, OS state) | Chat's own | Chat's own service-worker `notificationclick` handler | The toast fails today for an environmental reason, not a missing bridge (Spike A). The click reaches the handler and it routes to the conversation. | Zero code if it holds. [U] |
| **M1** | The current page-`Notification` bridge | Chat's own | Focus only, plus whatever Chat's page does | Chat calls the page `Notification`, not the service worker. | Implemented; reported not to cover the service-worker path. |
| **M2** | Observe Chat's service-worker `showNotification` call and re-raise it as a **main-process** Electron `Notification` | Title and body from the payload (FR-05b, if the payload carries the chat name) | Native `notification.on('click')` in main: **step 1 only** (window forward). Step 2 (open that conversation) is **not** delivered by M2 | Electron can run script in the service-worker context (`session.registerPreloadScript` documents `service-worker` contexts; `ServiceWorkerMain` exposes `ipc`, `send`, `scope`, `scriptURL`, and is marked Experimental; the fetched docs do not say notification events are supported). The payload carries the chat name. [U] | Candidate. |
| **M3** | The ADR-0002 Revision 3 fallback: a main-process `Notification` raised when the `page-title-updated` unread count **increases** | Generic, worded so it stays true whatever the count means: "New message in Google Chat" (never "N new messages": see §5 on what `(N)` counts) | Focus only (native click) | Only that the title carries a count. | Documented floor: satisfies FR-05a and FR-05c step 1, not FR-05b or FR-05c step 2. |

Decision rule, so the choice is mechanical once evidence exists:

1. If Spike A shows M0 works end to end (real toast, real click), stop: fix the environment, add no bridge.
2. Else if Spike C shows a usable payload and the owner picks answer **(a)** in FR-05's open question, build
   M2. **Be plain about what M2 buys: at best FR-05b (chat name in the title) and FR-05c step 1 (window
   forward).** FR-05c step 2 (open *that* conversation) needs a further mechanism, for example driving
   Chat's router from an identifier, which is **not designed** here and touches the space rule
   `wrapper-not-a-rewrite`; it is a separate owner decision and a separate design. Building M2 does not make
   step 2 available.
3. Else build M3 (owner answer **(b)**, or M2 proves infeasible). M3 is the guaranteed floor for FR-05a.

**One path per message.** Two paths active for the same message would show two toasts. Whatever is built
must name which path is authoritative and suppress the others (for example M2 or M3 active means the M1
bridge stays installed for mute/sound but must not raise a second toast). The de-duplication key is
undecided [U] and is an implementation question for Spike C.

### Rules that hold for every mechanism

- **Mute (FR-12) and sound (FR-11):** mute means no toast is created; sound-off creates it with
  `silent: true`. Under M1 that is the injected wrapper; under M2/M3 it is the main-process code that
  creates the `Notification`, reading `settingsStore` directly. Muting never affects the unread indicator.
- **No toast for the conversation being viewed (FR-05a).** Under M0/M1/M2 that decision stays with Chat,
  because the shell only surfaces calls Chat chose to make. Under M3 Chat's decision is invisible, so the
  shell applies a coarser rule: **no toast while the main window is focused**. That is a superset of the
  requirement (a focused window showing a *different* conversation also gets no toast); it is the closest
  M3 can get without the conversation id, and it is stated here so it is not mistaken for full parity.
- **Unread indicator (FR-05a):** global, independent of focus, stays until the unread count is zero. The
  source is the `page-title-updated` count (section 5).
- **Click, step 1 (unconditional):** `focusMainWindow()` (restore, show, focus). This already exists
  (`index.js:165-170`) and covers hidden-to-tray and minimized.
- **Click, step 2 (conditional, answer (a) only):** show the conversation the notification was for. How is
  Spike C's output and needs an owner decision because reaching a conversation from a payload id means
  driving Chat's router, which touches the space rule `wrapper-not-a-rewrite`. Not designed here.

## 4. Windows toast identity (proposal for Spike A to validate)

Toasts on Windows are attributed to an AppUserModelID that must match a Start Menu shortcut carrying it
(Electron notifications tutorial, cited in ADR-0004). Today dev and packaged share one AUMID
(`index.js:124`). Proposal, **not yet validated**: derive the AUMID from `app.isPackaged` (the packaged
value stays the `appId`; a dev run gets a distinct suffix) so a dev run cannot register or shadow the
identity a packaged install owns. Open point: whether the NSIS installer's shortcut carries the AUMID
that the runtime call sets [U]. Spike A owns the answer; until then do not change the packaged value,
because renaming an AUMID can orphan the user's per-app notification settings.

## 5. Tray unread indicator and the arrival event

`page-title-updated` remains the unread-count source, whichever delivery mechanism is chosen. Two facts
that FR-14 (attention indicators, see [tray-lifecycle.md](tray-lifecycle.md)) depends on:

- **What `(N)` counts is unknown [U].** The title prefix may be the number of unread **conversations**, not
  messages, so a second message in an already-unread conversation might not change it (an arrival missed by
  the count-increase trigger) and "N new messages" would be false. Treat it as a Spike A/C observation: type
  several messages into one conversation and one into another, and record how the title moves. Until then no
  user-visible text may claim a message count.
- Today the only signal is a count, so a "new message arrived" event can be derived only as **the count
  increased** (FR-14's stated degraded trigger). M2 and M3 produce a real arrival event (the moment the
  main-process `Notification` is created); the attention code should accept either source through one
  function so the implementation states which trigger it uses, as FR-14 requires.
- **Delta from the requirement, tray glyph precedence** (`src/main/tray.js:41-45`): `resolveIconState`
  returns `'muted'` before `'unread'`, so on Linux, where the tray glyph is the only unread signal, an
  unread message while muted is **not visible**. FR-05a and FR-12 both require the indicator to stay
  visible while muted. Windows is unaffected because the overlay badge (`tray.js:129-137`) is set
  independently. Options: a combined muted+unread glyph (new icon art, an owner call) or keeping the
  unread glyph and expressing mute in the tooltip. Open question 4 below.

## 6. Application log (new component required by FR-05c)

FR-05c's degraded outcome requires a **warning-level entry in a persistent application log**. No such log
exists (section 1). Minimum contract:

- A file under `app.getPath('userData')` (for example `logs/`), size-bounded with rotation, so a long-lived
  tray process cannot grow it without limit.
- Levels at least `warn` and `error`; `console.*` output is not a substitute.
- **Never** message text, sender names, chat names, cookies, tokens or any credential (space rule
  `electron-security-baseline`). A click-resolution warning records only that resolution failed, the
  mechanism in use and a timestamp.
- The existing `console.error` degradation messages (`index.js:216, 433`) move onto it so they survive
  a packaged run with no console.

## 7. Failure modes to log, not swallow

- `executeJavaScript` injection failure (already logged distinctly, `index.js:215-222`); with the log in
  section 6 it becomes persistent.
- The wrapper never invoked because Chat redefines `Notification` after both lifecycle events.
- A service-worker preload (M2) that fails to register or receives no events: the app must log that the
  service-worker path is not observing, or a silent M2 failure looks identical to "no messages".
- A click that cannot be resolved to a conversation (FR-05c): warning, window still comes forward.
- Stale toast clicked after the app fully exited: the click cannot reach a live process; this is a known
  limit, not fixable without native toast-activation relaunch (out of scope, unchanged from ADR-0002).

## 8. Verification (space rule `verify-on-a-real-desktop`)

Every FR-05 scenario tagged `[manual-only]` needs a real toast on a real desktop, and the report must
state which platform was tested. Windows verification does not establish Linux (libnotify) behaviour, which
has never been run in this repo. The `[automatable]` scenarios use a stubbed notification source and stubbed
handlers; a stub cannot prove a real toast appears or a real click is delivered (the reported synthetic-click
result is exactly that gap).

## Open questions and assumptions

1. **Owner:** FR-05 answer (a) or (b) (bounded second source, or generic content and focus-only click).
   Blocks M2 versus M3.
2. **Spike A:** does a real (not synthetic) click on a real toast raise `click`? If not, FR-05c is not
   satisfiable by any of M1-M3 on Windows without a different activation route.
3. **Spike C:** does the payload carry the chat name, and does Chat's service-worker `notificationclick`
   route to the conversation when the click is delivered to it (M0)?
4. **Owner/UX:** tray glyph precedence while muted with unread (section 5).
5. **Assumption:** M3's coarser suppression rule (no toast while focused) is acceptable as the degraded
   behaviour.
6. **Assumption:** the AUMID split (section 4) is safe; needs Spike A evidence.
</architecture>

<topics>
- [ADR-0004](../adr/0004-desktop-shell-technology-and-electron-retention.md) — Spikes A, B, C and escalation triggers.
- [ADR-0002](../adr/0002-notification-delivery-mechanism.md) — history of the page-`Notification` design.
- [Tray & Lifecycle](tray-lifecycle.md) — FR-14 attention indicators that consume the arrival event.
- [IPC Contract](ipc-contract.md) — `notification:clicked` and the provisional service-worker channel.
- [Requirements FR-05](../business/requirements.md) — the authority.
</topics>
