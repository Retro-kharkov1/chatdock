# ADR-0006: Download progress, completion notification and "Show in folder"

**Status**: accepted, merge to main pending a security or skeptic pass
**Deciders**: maintainers (approved by top-management, 2026-10-23)
**Amends**: the download rule of the Electron security baseline and
[Google app windows](../architecture/google-app-windows.md) section 4 "Downloads", rule (b)
**Item**: UI-12, gap row 7 in [Browser parity gaps](../architecture/browser-parity-gaps.md)

## Context

Downloads always showed a Save dialog and then gave no feedback: no progress, no completion signal, no way to
find the file. The old rule said that nothing is opened, revealed or launched when a download ends, and that no
notification is shown. A large download left the user guessing. Opening or running a downloaded file stays out
of scope: that is the part of a browser's download bubble that carries real risk.

## Decision

1. **Progress.** While a download runs, the main window's taskbar button shows its progress
   (`BrowserWindow.setProgressBar`). Several downloads aggregate (received over total, summed). An unknown total
   shows the indeterminate state. The bar clears when the last running download completes, is cancelled or fails.
   A download waiting for the Save dialog does not move the bar.
2. **One completion notification** per completed download, native, through Electron's `Notification`. No new
   window, panel or app-drawn surface. The Mute setting suppresses it; the Sound setting decides whether it is silent.
3. **Show in folder.** Clicking the notification, or its action button where the OS draws one, calls
   `shell.showItemInFolder` for exactly one path: the one `item.getSavePath()` returned for that completed item,
   i.e. the path the app's own `will-download` Save dialog produced.
4. A cancelled or failed download shows no notification and no "Show in folder".

### Wording (native notification, English)

| Part | Text |
|---|---|
| Title | `Download complete` |
| Body | `<file name, at most 80 characters, control characters removed>` then a new line and `Click to show it in its folder.` |
| Action button (where supported) | `Show in folder` |

The file name is displayed to the user only; it is never logged.

### Conditions (top-management, 2026-10-23)

- **Exact matching only.** `downloads.js` registers a path at completion (bounded to 50 entries, oldest evicted).
  Reveal runs only when the requested path is string-equal to a registered one, is absolute and still exists.
  The notification carries a closure over its own path; there is no IPC channel, no path argument and no
  renderer input to the reveal. No prefix, folder, pattern or normalisation matching.
- **Every reveal is logged, path redacted to a file-name-free form**: the filesystem root and the folder depth only,
  for example `C:\...[depth 3]`. Refusals, a vanished file and failures are logged without any path.
- **Security or skeptic pass before the code merges to main.**
- Never opened, executed or launched: `openPath`, `openExternal` of a file and `execFile` are not used for
  downloads. Never a path outside this app's own completed items. `downloads.js` keeps no Electron import and its
  source is asserted free of `shell`; the single `showItemInFolder` call lives in `index.js` and is asserted to be
  the only one.

## Security baseline text (replaces the download paragraph)

Downloads always show the Save dialog. Nothing is ever opened or launched. The shell shows download progress on the
taskbar and raises one native completion notice (Mute respected) for a completed item; clicking it (or its action)
may reveal in the file manager, through `shell.showItemInFolder`, exactly the path that this app's own
`will-download` Save dialog produced for that completed item, matched exactly, logged with the path redacted to
a root class (a UNC server or share name is never logged) and folder depth. Never reveal an arbitrary path. Never log a file name, full path, URL query, cookie or credential.

## Consequences

- Users get feedback and a one-click route to the file, closer to browser behaviour.
- Residual risk: the file the user saved is shown in the file manager, where a later double click is the user's own
  act and is outside the app. A file name is visible in the notification and in the OS notification history or on a
  lock screen, as chat messages already are. A file replaced between completion and the click is revealed as
  whatever exists at that path, because the app checks existence only. A hostile file name cannot change the path:
  the default name is the base name of the suggestion and the user chooses the final path in the Save dialog.
- The action button is drawn only where the OS supports notification actions (documented for macOS only, which is
  out of scope); on Windows and Linux the click is the reveal path. Windows and Linux behaviour must be checked by
  hand.
- A download from a window other than the main window or a Google app window is still left to Electron's default
  and gets none of this.
- Tests: `test/downloadsFeedback.test.js` (progress, notice, mute, cancel and failure, exact matching, eviction,
  logging, source guards).

## Security review

A security review of the first implementation approved it with concerns. Fixed in the same branch:

- F1: the file-exists check before a reveal is asynchronous (`fs.promises.access`) and bounded by a 1.5 s timeout. A
  hung or failing check (for example a disconnected network share) counts as "not present": nothing is revealed and the
  main process is never blocked. The exact-match registry check is unchanged.
- F2: a UNC root is logged as `\\...` only, so neither server nor share name reaches the log. Drive and POSIX roots are
  logged as before. The log still carries the root class and folder depth only.
- F3: a path that is downloaded again is removed and re-added, so it takes the newest position in the 50-entry
  registry and is not the next one evicted.
- F4: the notice name has control characters (C0, DEL, C1) replaced by a space and Unicode format characters (`\p{Cf}`,
  including bidi overrides) removed. A name longer than 80 characters is cut in the middle, so its last 12 characters
  (the extension) stay visible.
- Line endings of `src/main/downloads.js` were kept as they were.

Accepted, no code: F5 (the name is visible on the lock screen and in the notification history, as chat previews are).
Open, by hand: F6 (the notification click and the progress bar on a hidden window must be checked on Windows and Linux).
