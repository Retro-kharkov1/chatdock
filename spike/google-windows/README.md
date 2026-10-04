# UI-04 host-observation spike (THROWAWAY)

Not product code, never packaged (`build.files` only includes `src/**`). Delete when UI-04 ships.
Purpose: step 1 of `docs/architecture/google-app-windows.md` section 10. It records which hosts, path shapes and
redirect chains Google actually uses, on your real signed-in session, so the host rules are set from evidence.
Imports `PARTITION` and `buildDesktopUserAgent` from `src/main/session.js` (read-only use).

## Before you start

1. **Fully quit the installed Google Chat Desktop** (tray icon > Exit, not just closing the window). The harness
   uses the same profile (`%APPDATA%\google-chat-desktop`); if the app is still running the harness prints
   "This profile is in use" and exits.
2. Use a **normal, non-elevated** terminal (not "Run as administrator").

## Launch (from the repo root)

    node_modules\.bin\electron spike\google-windows

Options: `--url=<https Google link>` opens a test window at start; `--no-chat` skips the Chat window;
`--profile=harness` uses a throwaway profile `spike\google-windows\.profile` instead of your real session (you would
have to sign in there; the installed app may then keep running).

You get a small **control window** (paste URLs, write markers) and the **Chat window**. Closing the control
window quits the harness.

## What is logged, and what is not

`spike\google-windows\out\hosts.log` (appended per run, git-ignored). Hosts and **path shapes** only: unknown path
segments become `:id`, query strings become parameter names, no cookies, tokens, headers beyond content-type and
attachment/inline, titles, message text or file names. A short lowercase path word (for example a Sites page
name) can survive, so skim the log before sharing it. Downloads are logged and then **cancelled** (no file lands).
Non-Google addresses are refused. The harness grants only `clipboard-sanitized-write` and `fullscreen`; every other
permission is denied and logged.

## Owner checklist (about 15 minutes)

Before each action type a short **marker** in the control window (for example `step 4: Download, small file`) and
press Enter, so the log lines can be matched to what you did. Do not put file names or message text in markers.

1. Launch. Confirm the Chat window shows your chats (signed in). If it shows the sign-in page, the profile is not
   the real one: stop and tell the orchestrator.
2. Paste your Drive example `https://drive.google.com/file/d/FILE_ID/view?usp=sharing`
   into the control window and open it. Let the preview load. Marker `step 2: Drive view`.
3. In that window use **Preview** (if offered), then **Copy link** (the share/link button), then paste somewhere to
   confirm the copy worked. If the file is a video, play it and press the fullscreen button, then Esc.
4. Click **Download** on a small file. A real download starts and the harness cancels it: that is expected. Marker
   `step 4: Download small`.
5. Open a **large file** (more than about 100 MB, so Drive says it cannot scan for viruses) and click Download, then
   **Download anyway** on the warning page. Marker before each click. The warning page must stay visible long enough
   for you to click.
6. Open a Google **Doc** and use File > Download > PDF (and one more format), then a **Sheet** with File > Download >
   CSV. Marker per export.
7. Open a **Slides** deck and click **Present** (fullscreen), then Esc. Also open a Doc and click any link inside it
   that goes to another Google file, then a link to a Chat conversation if you have one.
8. Paste a `https://forms.gle/...` link (any form you own) and open it. Marker `step 8: forms.gle`.
9. In the **Chat window**: click an image preview, open and download an attachment, copy and open a message
   permalink, use "open in new window" / pop-out on a conversation, and click a link to another space. Marker before
   each. Note whether an **unsent draft** survived opening a permalink in the same window.
10. Close the control window. Send `spike\google-windows\out\hosts.log` (after skimming it) to the orchestrator, plus
    your notes: anything that visibly failed, looked blocked, asked you to sign in again (re-auth hops), or showed
    a "this browser may not be secure" message.

## Answers the log gives (for the spec)

| Question | Log lines to read |
|---|---|
| Hosts and redirect chains for View/Preview | `request`, `redirect`, `will-redirect`, `did-navigate` per `win` |
| Download and large-file confirm | `will-download` (`url` + `chain`, `mime`), the page that preceded it, and the `request` with `method` POST for the "Download anyway" form |
| Docs/Sheets export | `will-download` chain, `response` `disposition: attachment` |
| `forms.gle` | `redirect` lines from `forms.gle` (and the final `did-navigate`) |
| Copy link, Present, video | `permission-request`/`permission-check` with `requesting` and `topLevel`/`embedding`; `fullscreen-enter` |
| Re-auth hops | `accounts.google.com` / `accounts.youtube.com` as `main:true` versus `main:false` |
| What Chat opens | `window-open` from `win: chat` (`url` shape, `disposition`, `featureKeys`) and the following `popup-created` chain |
