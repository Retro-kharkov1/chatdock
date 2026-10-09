# File access: drop and attach (BUG-07, BUG-08)

## Symptom

On Windows a file dragged from Explorer into a Chat conversation did not attach (BUG-07), and the composer's
attach control did not result in an upload (BUG-08). Both work in Google Chrome.

## Root cause of the first failure (drop, and a picked file that could not be read)

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

## The fix for the first failure

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
| Meet call window | NotAllowedError | AbortError (cancelled, see below) | read ok | AbortError (cancelled, see below) | ok |

## BUG-08 second cause: the picker is cancelled, not denied

After the read grant, drag-and-drop worked on Windows (owner check) but the composer's "+" still opened no chooser.

Evidence from Docker/Linux (Electron 44.4.3, Chromium log `--vmodule=*web_contents_based_canceller*,*file_system_chooser*`):

```
file_system_chooser.cc:357]        Showing chooser
web_contents_based_canceller.cc:84] Visibility changed: 1        (1 = occluded)
web_contents_based_canceller.cc:97] Cancelling
file_system_chooser.cc:456]        Cancelling chooser
file_system_chooser.cc:313]        AbortedCallback               -> the page gets AbortError, no dialog
```

`showOpenFilePicker()` (and the save/directory pickers) use a chooser that Chromium cancels as soon as the page's contents
stop being visible. In the Docker run the Meet call window (1100x780) was fully covered by the 1125x825 GTK dialog, so it was
occluded and the picker was cancelled ~35 ms after it was shown; the same page in a 1500x880 call window opened the dialog
and returned the file (no change except the window size). The plain `<input type="file">` chooser has no such canceller and
worked in every window, including the one where the picker failed. The earlier "Meet picker aborts" observation was this,
not the `fileSystem` permission and not X11 focus.

Why this is believed to be the Windows symptom, and what is not proven: the same canceller runs on Windows, a cancelled
picker looks exactly like "nothing happens", and the main-window picker works in Docker only while the window is larger than
the dialog. That the owner's Windows main window is cancelled by the same visibility signal is NOT proven; the owner steps
include a log capture that shows it either way.

### Fix

`src/preload/pickerFallback.js`, registered for the shared session in `session.js` (`registerPreloadScript`, type `frame`;
see <https://www.electronjs.org/docs/latest/api/session>), runs before the page's own scripts in the main Chat window, the
Google app windows and the Meet call window and deletes three globals from the page world: `showOpenFilePicker`,
`showSaveFilePicker`, `showDirectoryPicker`. A page that feature-detects them (Google's apps also run in Firefox and Safari,
which do not have them) then takes the `<input type="file">` chooser path. It exposes no API and adds no IPC channel.
Drops are unaffected (`DataTransfer.files` and `getAsFileSystemHandle()` stay; the read grant above covers the latter).

Docker result after the fix, all four real windows (main, Docs, Drive, Meet call window): `typeof showOpenFilePicker`,
`showSaveFilePicker`, `showDirectoryPicker` are `undefined` at the first script of the page and `'showOpenFilePicker' in window`
is false; a page that falls back to `<input type="file">` gets the chosen file in all four, including the Meet call window where
the picker was cancelled before; drop still reads the file.

Risk: if a page calls the picker without feature detection it now throws a TypeError instead of being cancelled. If Chat's "+"
turns out not to use the picker at all, this change does nothing for it and the log capture in the owner steps shows what does
happen.

Not verified: the real signed-in Chat/Drive/Docs pages (no Google account is available to the build), and anything on Windows
(see the owner check list in the release notes of the fix). Linux behaviour must not be read as Windows behaviour.
