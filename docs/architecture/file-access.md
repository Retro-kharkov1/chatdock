# File access: drop and attach (BUG-07, BUG-08)

## Symptom

On Windows a file dragged from Explorer into a Chat conversation did not attach (BUG-07), and the composer's
attach control did not result in an upload (BUG-08). Both work in Google Chrome.

## Root cause (one cause for both)

Google's web apps read a user-chosen file through **File System Access handles**:
`DataTransferItem.getAsFileSystemHandle()` for a drop, and `showOpenFilePicker()` for the picker, then
`handle.getFile()`. Chromium (Chrome) grants that read implicitly because the user just chose the file. In Electron the
same read goes through the session's permission handlers as the **`fileSystem`** permission
(<https://www.electronjs.org/docs/latest/api/session>, `setPermissionCheckHandler`: `details.filePath`,
`details.fileAccessType`). `configurePersistentSession` (`src/main/session.js`) denies every permission it does not list,
and `fileSystem` was not listed, so `getFile()` rejected with `NotAllowedError`: the page got the handle but never the bytes.

A plain `<input type="file">` does not use that permission and kept working, which is why the failure looked
intermittent. Every window uses the shared partition (`PARTITION`), so the main window, the Google app windows
(`src/main/googleAppWindow.js`) and the Meet call window (`src/main/callWindow.js`) were all affected.

## The fix

`src/main/fileAccess.js` (pure, unit-tested in `test/fileAccess.test.js`), wired into both handlers in `session.js`:

| Rule | Value |
|---|---|
| Access | **read only** (`fileAccessType === 'readable'`); writable, missing or unknown is denied |
| Requesting origin | `https://chat.google.com`, `https://meet.google.com`, and the Google-app link list (`LINK_LIST_HOSTS`: drive, docs, calendar, mail, keep, contacts, sites). Never `accounts.google.com`, look-alikes, `http:` or the dev loopback origin |
| Top-level page | not required (see below); when a signal is present (`webContents` URL or `embeddingOrigin`), it must be on the list too |
| Consent | the user's own drop or pick: Chromium creates a handle only for a file the user chose |

Electron 44 calls the `fileSystem` check handler with `webContents = null`, no `embeddingOrigin`, and
`details = {fileAccessType, filePath, isDirectory, isMainFrame: false}`, so a top-level requirement (as used for
clipboard and fullscreen) would deny every real request. The requesting origin is the frame's own origin, so a foreign frame embedded in Chat
does not inherit the grant.

No preload or IPC surface was added or widened. `contextIsolation`, `nodeIntegration`, `sandbox`, `webSecurity`,
`backgroundThrottling` and the close-to-tray behaviour are untouched.

## A dropped file never navigates a window

If a page does not handle a drop, Chromium would navigate to the `file:` URL. The existing `will-navigate`/`will-redirect`
guards (main window via the sign-in wiring and link router, app windows, call window) refuse it; `file:` is dropped by
`linkRouter` (`test/linkRouter.test.js`). Checked in Docker: a drop outside any drop target left the URL unchanged in the main,
Docs, Drive and Meet windows.

## Verification record

Linux, Docker only (`electron@44.4.3`, Xvfb + openbox, the real `src/main/index.js`, with `chat/meet/docs/drive.google.com`
mapped to a local HTTPS test page that implements a drop target, `<input type=file>` and `showOpenFilePicker`; the
native GTK chooser driven with xdotool; no Google account involved):

| Window | Before: drop | Before: picker -> read | After: drop | After: picker -> read | `<input type=file>` |
|---|---|---|---|---|---|
| Main (Chat) | NotAllowedError | NotAllowedError | read ok | read ok | ok before and after |
| Docs app window | NotAllowedError | NotAllowedError | read ok | read ok | ok |
| Drive app window | NotAllowedError | NotAllowedError | read ok | read ok | ok |
| Meet call window | NotAllowedError | AbortError (no dialog) | read ok | AbortError (no dialog), see below | ok |

Open item: `showOpenFilePicker()` inside the Meet **call window** rejects with `AbortError` before any permission request
and without showing a dialog, both before and after this fix, while the same origin loaded in a Docs window works. It was not
caused by `autoHideMenuBar` or the initial `focus()` (both tried). The Docker X11 focus model may be the reason; it was not
reproduced or ruled out on Windows. Whether any real Meet feature depends on the picker was not checked.

Not verified: the real signed-in Chat/Drive/Docs pages (no Google account is available to the build), and anything on Windows
(see the owner check list in the release notes of the fix). Linux behaviour must not be read as Windows behaviour.
