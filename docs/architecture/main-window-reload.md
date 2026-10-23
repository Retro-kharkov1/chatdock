# Main-window reload and recovery (BUG-10)

<overview>
The main Chat window had no way to reload and no recovery from a failed load: launching offline left a blank or
engine error page, and the only way out was quitting from the tray and relaunching
([Browser parity gaps](browser-parity-gaps.md) row 3). The app removes the application menu (needed so there is no
second Quit path, see [Project Rules](project-rules.md)), which also removed the menu accelerators that would
otherwise provide Reload.

This change adds keyboard reload and an automatic back-off retry for the **main window only**. All of it lives in
`src/main/mainReload.js`, wired in `src/main/index.js`. No preload change, no IPC channel, no new window, no
permission or origin change.
</overview>

<architecture>
## Keyboard reload

Handled on the main window's `before-input-event`, key-down only, ignoring auto-repeat and any Alt chord:

| Keys | Action |
|------|--------|
| F5, Ctrl+R (Cmd+R) | `webContents.reload()` |
| Ctrl+Shift+R, Ctrl+F5, Shift+F5 | `webContents.reloadIgnoringCache()` |

A matching key is consumed (`preventDefault`) so the page does not also see it. Unsent drafts are lost on reload,
the same as in Chrome.

## Retry after a failed load

A main-frame `did-fail-load` (offline launch, DNS failure, connection reset, ...) starts a retry in the main process.
Sub-frame failures and `ERR_ABORTED` (-3, a navigation replaced by another one) are ignored.

- **Back-off:** 2 s, 5 s, 10 s, 30 s, 60 s, then 60 s repeating until the load succeeds. The attempt counter resets
  after a successful load.
- **Target:** the failed URL when its origin is one of the Chat origins (`NOTIFICATION_ORIGINS`), otherwise the fixed
  start URL. Never any other failed URL, so a failure cannot make the shell re-load an arbitrary address.
- **Recovery is "an http(s) page finished loading".** The engine's own error page also fires a finished load; its URL
  is not http(s), so it does not count as recovery.
- **Manual reload after a failure** (F5 and the others) skips the wait: it resets the counter and loads the retry
  target at once.
- A rejected `loadURL` promise only logs; the next `did-fail-load` schedules the next attempt.

## Hidden window must stay live

The retry is a main-process timer plus `loadURL`. It never shows, focuses, throttles or destroys the window, so a
window hidden in the tray recovers by itself and notifications resume without anyone touching the app. The timer is
cleared on the window's `closed` event.

## Sign-in mode (FR-19)

While the sign-in mode is on ([Sign-in Flow](sign-in-flow.md)):

- no automatic retry is started, and a pending one is dropped when its timer fires; the mode's own limits (idle time,
  total time, origin changes, **Back to Chat**) end it and return to Chat;
- a manual reload reloads the current page only, through the navigation events the flow already watches, so the
  30-minute and 40-origin limits still bound it;
- nothing here opens an origin.

## Logging

Outcome words only (for example "main load failed, code -106", "main reload: retry"). No URL, cookie, credential or
page text.

## Test map

`test/mainReload.test.js`:

| Acceptance | Covered by |
|------------|------------|
| AC1 F5, Ctrl+R, Ctrl+Shift+R reload the main window | `reloadKind` table, accelerator tests |
| AC2 a failed main-frame load recovers without quitting | back-off delays, reset, manual retry, target selection |
| AC3 retry works while hidden, window stays live | static check that no window method is touched; timer is main-process |
| AC4 FR-19 limits still hold | no retry while the mode is on, pending retry dropped, manual reload only |
| Safety | `ERR_ABORTED` and sub-frame ignored, error page is not a recovery, destroyed or disposed contents, wiring in `index.js` |

## Verified where

Unit level only (Linux container, Node test runner). Not yet verified on a real Windows desktop: offline launch, the
retry once the network returns, and a retry while the window is hidden to the tray (see the *Verify on a real desktop*
rule in [Project Rules](project-rules.md)).
</architecture>
