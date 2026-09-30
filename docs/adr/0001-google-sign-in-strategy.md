# ADR-0001: Google sign-in strategy — plain BrowserWindow primary, system-browser cookie-import fallback

**Date**: 2026-09-22
**Status**: accepted (escalation clause in Risks amended by [ADR-0004](0004-desktop-shell-technology-and-electron-retention.md), proposed)
**Deciders**: tech-lead

## Context

FR-03 requires the user to complete Google sign-in inside the application window, and FR-04
requires the resulting session to survive restarts/reboots. Requirements.md's Risk 1 concluded
this is achievable via a plain `BrowserWindow` (never `<webview>`) with a standard desktop Chrome
user agent, citing `ankurk91/google-chat-electron` and `iWorkforces/GogChat` as working precedent.

Independently, `~/.claude/skills/electron-desktop.md` (§4, "The Google OAuth embedded-browser
block") concludes Google's block is a deliberate, hardening anti-phishing policy with **no
reliable Electron-side workaround**, citing a Google Account Community thread and two GitHub
issues (`agentify-sh/desktop#11`, `firebase-js-sdk#2478`).

These two conclusions were reconciled by re-checking the cited evidence directly rather than
picking whichever was convenient:

- **`ankurk91/google-chat-electron`** — the project requirements.md cited as supporting evidence —
  is **archived** (2026-09-06). It carries an **open, unresolved** issue,
  [#52 "Unable to login - This browser or app may not be secure"](https://github.com/ankurk91/google-chat-electron/issues/52)
  (filed 2021-12-30), that sat unfixed for the rest of the project's active life. Its own README
  now tells users to switch to the same author's successor project,
  [`ankurk91/google-chat-tauri`](https://github.com/ankurk91/google-chat-tauri), stating "Sign-in
  works there, including Google Workspace accounts." That successor explicitly **does not bundle
  Chromium** — it uses the OS-native webview (WebView2 / WKWebView / WebKitGTK), "the web engine
  your system already has." That is a strong first-party signal, from the same author who built
  both projects, that Electron's bundled-Chromium `BrowserWindow` approach became unreliable for
  this exact use case.
- **`iWorkforces/GogChat`** — the other project requirements.md cited — is actively maintained
  (open feature-request issues from as recently as 2026-04), uses `BrowserWindow` as its default
  backend, and its own architecture explicitly tests a custom desktop user agent as a
  `critical`-phase concern. Its issue tracker has **zero** reports of the Google sign-in block. This
  is current, real-world confirmation that a deliberately-configured plain `BrowserWindow` can
  complete first-party Google sign-in today.
- **`agentify-sh/desktop#11`** and **`firebase-js-sdk#2478`** (the skill's cited evidence) are a
  **different scenario**: a third-party site's "Sign in with Google" **OAuth consent popup**
  embedded inside that site's own embedded browser — not a user directly navigating to Google's own
  first-party `accounts.google.com` sign-in page, which is what FR-03 actually describes (Google
  Chat redirecting an unauthenticated user to its own login). Google's detection is documented to
  key more aggressively off embedded OAuth-consent popups than off a direct first-party navigation
  in a full `BrowserWindow` — but `ankurk91`'s archived project shows that distinction is **not a
  permanent guarantee**; the same first-party-navigation case failed there too, at some point after
  the project's last active maintenance.

**Conclusion**: the evidence does not support either extreme ("it definitely works" or "it can
never work"). It supports a primary/fallback strategy with the fallback pre-designed rather than
improvised at implementation time, because the failure mode (Google tightening detection further)
is exactly what already happened to the precedent project this spec partly relies on.

## Decision

Two-tier strategy:

1. **Primary**: plain `BrowserWindow` (never `<webview>`), a dedicated persistent session partition
   (`persist:google-chat`), and an explicit standard desktop Chrome user agent set via
   `session.setUserAgent()` — mirroring GogChat's currently-working, actively-maintained
   configuration. This is what FR-03/FR-04 assume and what the implementer builds first.
2. **Fallback** (pre-designed now, not improvised later): if a real sign-in attempt during build-out
   or release verification shows Google's block ("This browser or app may not be secure" /
   `disallowed_useragent`), the app:
   - Opens the user's **default OS browser** via `shell.openExternal('https://chat.google.com/')`
     and asks the user to sign in there — a fully trusted, non-embedded browser Google does not
     block.
   - Reads the resulting `.google.com` session cookies out of that default browser's local cookie
     store using [`chrome-cookies-secure`](https://github.com/bertrandom/chrome-cookies-secure)
     (npm, actively published — v3.0.2 as of this writing — uses Windows DPAPI via `win-dpapi` on
     Windows and `keytar`/Secret Service (GNOME Keyring/KWallet) on Linux to decrypt the browser's
     own cookie store; no custom decryption code needed). **Known limitation, confirmed directly
     from the module's own README**: Chrome only flushes its cookie SQLite database to disk "every
     30 seconds or so" — an import attempted immediately after a fresh sign-in can read stale or
     missing cookies. The implementer should account for this (e.g. a short retry/delay before the
     import, or an explicit "waiting for browser to finish signing you in" step) rather than treat a
     single failed read as a hard failure. The README does not document whether the cookie DB can be
     locked while Chrome is actively running (unlike the flush-delay caveat, this is **not**
     confirmed by the module's own documentation) — treat it as an untested risk to watch for during
     task 2's real verification, not an assumed fact.
   - Imports each relevant cookie into the app's own `persist:google-chat` partition via
     `session.cookies.set()`, then reloads the wrapped `BrowserWindow` — now authenticated without
     ever completing the login form inside Electron's own Chromium.
   - Only supports a Chromium-based default browser (Chrome/Edge/Brave/etc.) — `chrome-cookies-secure`
     does not read Firefox's cookie store; this is a stated, explicit limitation, not a silent gap.
   - (macOS's Keychain-Access-dialog caveat, present in the module's README, is moot — macOS is out
     of scope per ADR-0003.)

This is a **cookie-import handoff**, not an OAuth authorization-code exchange — there is no OAuth
client involved (the app does not talk to Google's API directly, per the space's
`wrapper-not-a-rewrite` rule), only reuse of the session cookie a normal sign-in already produces.

## Alternatives Considered

### Alternative 1: Assume the primary path always works (requirements.md's original framing)
- **Pros**: simplest; no fallback code to build or maintain.
- **Cons**: the precedent project this exact framing cites already failed this way and had to be
  replaced by a different framework.
- **Why not**: betting the entire login requirement on an unverified assumption, when the direct
  precedent shows the assumption can and did fail, is not an acceptable risk posture for the
  requirement the whole app depends on.

### Alternative 2: Registered custom-protocol OAuth handoff (classic `myapp://` deep-link pattern)
- **Pros**: standard pattern for apps that own an OAuth client and need an access/refresh token.
- **Cons**: does not apply here — this app has no registered OAuth client and does not exchange an
  authorization code for an API token; it needs a **browser session cookie**, not an OAuth token.
- **Why not**: solves a different problem than the one FR-03 has.

### Alternative 3: Migrate off Electron to a native-webview framework (e.g. Tauri), matching what
  `ankurk91` actually did
- **Pros**: the only approach with a confirmed permanent fix if Google closes the first-party
  navigation loophole entirely.
- **Cons**: a full stack rewrite — different language/toolchain, not a config change — for a
  personal utility explicitly scoped as an Electron app.
- **Why not**: disproportionate to invoke now, before the primary path has even been tried. Named
  explicitly below as the escalation path if both tiers of this ADR fail.

## Consequences

### Positive
- The implementer has a concrete, already-designed fallback instead of having to invent one live
  during a failed sign-in, mid-implementation.
- The decision is traceable to verified, dated evidence rather than either agent's assumption.

### Negative
- The fallback adds a real dependency (`chrome-cookies-secure`) and a code path that touches
  another application's (the OS browser's) protected cookie storage — must be implemented under the
  space's `electron-security-baseline` rule: never log, persist elsewhere, or transmit the cookies;
  they only ever move from the OS browser's store into this app's own OS-encrypted session
  partition, on-machine.
- Only covers Chromium-based default browsers; a Firefox-default user is not covered by the
  fallback and would need a manually-documented workaround if the primary path also fails for them.

### Risks
- **Escalation boundary — this is now a load-bearing decision record, not just an internal hedge.**
  The owner directly asked whether Electron was the right framework choice for this app at all, and
  specifically whether a VS Code extension would be a better base. Answered and recorded here so
  the reasoning survives past that one conversation: **VS Code is itself built on Electron** — it is
  the same underlying technology, not an alternative to it. A VS Code-extension form of this app
  would additionally be strictly worse for this product's actual requirement, because (a) it
  requires VS Code itself to be running for the wrapper to run at all — defeating FR-06/FR-08's
  always-available-tray-app model — and (b) VS Code extension notifications are in-editor toast
  UI, not OS-native notifications, which fails FR-05 outright (the single core requirement this
  whole app exists for). **Decision: stay on plain Electron.** This is not a default-by-omission;
  it was evaluated against the concrete alternative the owner raised and rejected on requirement
  grounds, not convenience.

  Separately — the actual escalation path, if both the primary and the cookie-import fallback in
  this ADR fail (i.e. Google closes the first-party navigation loophole the same way it apparently
  did for `ankurk91/google-chat-electron`): the only precedented durable fix is **Alternative 3,
  migrate to Tauri** (a native-webview framework, not another Electron-based option like a VS Code
  extension would have been) — this remains the documented escalation path, unchanged by the
  Electron-vs-VS-Code question above, which was about the *primary* choice, not this fallback.
  *(Amended by [ADR-0004](0004-desktop-shell-technology-and-electron-retention.md), proposed: the
  escalation is now defined by triggers T1/T2 there, and Tauri's Meet-on-Linux status is an open
  question, not a settled fix.)*
  Escalating to Tauri is a scope decision for the owner, not something to improvise
  mid-implementation. If this happens, treat it as "the documented risk fully materialized," not a
  fresh crisis — and note precisely what would trigger it: Google's sign-in block reproducing on
  the *primary* `BrowserWindow` path **and** the cookie-import fallback also failing (e.g. because
  the owner's default browser sign-in itself gets blocked, or cookie import proves unreliable in
  practice) — not merely one tier being imperfect.
- **Verification is mandatory, not optional**: per the space's `verify-on-a-real-desktop` rule, the
  implementer must perform a real sign-in (not a pre-seeded dev session) during initial build-out
  and again before each release — the conflicting evidence above means this cannot be assumed to
  keep working from one release to the next without re-checking.
