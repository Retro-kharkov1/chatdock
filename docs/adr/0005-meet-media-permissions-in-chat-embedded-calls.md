# ADR-0005: Camera and microphone for the Meet call embedded in Chat

**Status**: accepted
**Deciders**: maintainers
**Amends**: the Meet permission gate in [Meet call window](../architecture/meet-call-window.md) section 6

## Context

Calls started from a Chat conversation did not get camera or microphone. Google Chat runs the call as a
cross-origin `https://meet.google.com` iframe inside the `https://chat.google.com` page. The original gate
required the requesting origin and the top-level origin to both be `https://meet.google.com`, which is true
only in the app-owned call window. In the embedded case the top level is Chat, so every request was denied.

Evidence, from the app's own diagnostics log (redacted, app 0.1.2-4):

```
permission-check permission="media" requesting="https://meet.google.com" topLevel="https://chat.google.com" embedding="https://chat.google.com" frame="sub" mediaType="audio" decision="deny"
permission-check permission="media" requesting="https://meet.google.com" topLevel="https://chat.google.com" embedding="<none>" frame="sub" mediaType="video" decision="deny"
```

About 25 such lines for `audio` and `video`, and no `media` permission-request line, because the check
handler denies before a request is ever made. The same log shows a denied `background-sync` check and a
denied `screen-wake-lock` request.

## Decision

Camera and microphone use a second, separate gate, `meetMediaGate` in `src/main/meetPermissions.js`:

- The requesting origin must equal `https://meet.google.com` exactly.
- The top-level origin must equal `https://meet.google.com` or `https://chat.google.com` exactly.
  In the check handler the top level is `details.embeddingOrigin`, falling back to `webContents.getURL()`
  when it is absent (the log shows `embedding="<none>"` for some checks). When both are present, both must
  pass the gate and either failing denies, so a Docs or Drive window that embeds Chat embedding Meet is
  denied in the check handler as it is in the request handler.
- Origins are compared after `new URL(x).origin`: no subdomain, port, userinfo, `http` or wildcard match.
- Applies to `media` (audio and video) and `speaker-selection`, in both the request and the check handler.

Unchanged: `display-capture` and the display-media (screen share) handler keep the strict gate, Meet as
requester and Meet as top level, and screen share still goes only through the app's own source picker.
Chat as a requester still gets no `media`. Every grant and deny is already written to the diagnostics log by
the shared decision logger.

`screen-wake-lock` is not granted. A call does not need it to capture camera or microphone, and Meet uses
it only to keep the screen awake. Not granting it keeps the permission surface minimal. Revisit only if a
retest shows a call fails without it.

## Consequences

- A Meet frame that Chat embeds can now use camera and microphone. Any other frame inside Chat still cannot,
  and Meet inside any other top level still cannot.
- Accepted residual risk: the request handler sees only the asker's URL and the top-level page, not an
  intermediate third-party frame between Chat and Meet. The requester must still be exactly Meet, and the
  check handler, which also sees the embedding frame, denies such a frame; Meet itself is a first-party
  origin, so this is accepted.
- The window-open `about:blank` drop seen in the same log is not changed here; it is looked at only if a
  retest of this fix still fails.
- Tests: `test/meetPermissions.test.js` covers the grants and the negatives (third-party top level,
  `meet.google.com.evil.com`, `http`, port, userinfo, subdomain, Chat as requester).
