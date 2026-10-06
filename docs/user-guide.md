# Google Chat Desktop — User Guide

Google Chat Desktop is an **unofficial** desktop app for Google Chat on Windows and Linux. It is not
affiliated with, authorized, or endorsed by Google. "Google Chat" is a trademark of Google LLC.

The app shows the normal Google Chat website in its own window and adds what a browser tab does not
do well: it keeps running in the system tray, so **you still get notifications when the window is
closed**.

This guide is also available inside the app: choose **Help** in the tray menu, or the **Help** link in
Settings.

## Signing in and staying signed in

- On first start, sign in with your Google account in the app window, the same way as on the website
  (including 2-step verification if you use it). No separate browser is needed.
<!-- unpublished: SSO -->
- If your organisation signs you in through its own sign-in page (single sign-on), that page opens in the app
  window and the app returns to Chat when you are done. The window title shows which site you are on. If you end up
  on a page you did not want, choose **Back to Chat** in the tray menu (shown only during such a sign-in). If a step of
  the sign-in cannot open in the app, a message says so once and offers **Back to Chat**. Links that open in a new tab go
  to your browser, and files cannot be downloaded until you have signed in. After 10 minutes without a page change, or 30
  minutes in total, the app goes back to Chat by itself. Sign-in pages on a non-standard port, at an IP address, or with an
  international (non-ASCII) site name are not supported.
<!-- /unpublished: SSO -->
- You stay signed in between launches and after restarting your computer. You are asked to sign in
  again only if Google ends the session (for example, you signed out of that account on another device).
- Only one copy of the app runs at a time. Starting it again just brings the existing window forward.
- The app remembers the size and position of its window.

## The window and the tray

- **The close button (X) hides the window to the tray; it does not quit.** The app keeps running and
  keeps delivering notifications.
- **Click the tray icon** to show or hide the Chat window. **Right-click it** for the menu:

| Menu entry | What it does |
|---|---|
| **Show call window** | Only while a Google Meet call window is open. Brings that window to the front. It is the first entry. |
| **Show/Hide Google Chat** | Shows or hides the Chat window. Does not touch a call in progress. |
| **Mute notifications** | Tick to silence notifications (see below). |
| **Settings…** | Opens the Settings window. |
| **Help** | Opens this guide in its own window. Choosing it again brings that window forward. |
| **Exit** | Quits the app completely. |
| *Version line* | A grey, non-clickable line at the bottom showing the version and build. |

- **The only way to quit is Exit in the tray menu.** Closing a window never quits the app.
- **Start at login:** the app can start automatically when you sign in to your computer, directly into
  the tray with no window. After a fresh install this is turned on the first time the app runs; a choice
  you make later is never overridden. Change it in Settings.

## Notifications

- A notification appears when a new message arrives while the Chat window is hidden in the tray,
  minimized, or visible but not the active window. You do not get one for the conversation you are
  looking at.
- **Tray icon and taskbar.** While there are unread messages:
  - On Windows, a small badge appears on the taskbar button. On Linux the tray icon itself changes.
  - If the window is not active, the tray icon blinks and, on Windows, the taskbar button flashes.
    Both stop as soon as you bring the Chat window to the front and click into it.
- **Clicking a notification** brings the window to the front, even from the tray or when minimized,
  and opens that conversation. This works for the pop-up and for the entry in the Windows notification
  centre.
- **Mute** silences notifications and stops the blinking and flashing, but the unread indicator still
  shows, so you do not miss that something arrived.

## Google Meet calls

Meet links in Chat (links in messages, Join buttons, calendar cards) open in a separate **call window**
inside the app, signed in with the same account. Only one call window exists at a time.

- **Camera and microphone** work in the call window; allowing them is handled for you, only for Google Meet.
- **Sharing your screen.** When Meet asks to share, the app shows its own picker:
  - Choose the **Screens** or **Windows** tab, select one item, then press **Share**. Nothing is
    selected for you and nothing is shared until you press Share.
  - Listing screens can take a few seconds; a loading message is shown. **Refresh** reloads the list.
  - **Cancel**, Escape or closing the picker shares nothing.
  - Only the picture is shared; the computer's sound is not.
  - If you pick the call window itself, it is labelled "(this call)".
  - On Windows, screen sharing does not work if the app is run as Administrator.
- **Closing the call window** (X, Alt+F4 or the taskbar) ends the call for you and releases the camera,
  microphone and any screen sharing. It never quits the app. If Meet reports that you are in a call, you
  are asked first: **"Close the call window?"** with **Close window** or **Keep window open** (the
  default). Leaving with Meet's own Leave button first avoids the question.
- **Exit during a call.** Choosing Exit in the tray while in a call asks **"Exit Google Chat Desktop?"**
  with **Exit** or **Cancel** (the default). It also warns that you will not get message notifications
  until you start the app again. Without a call, Exit quits at once.
- **A second Meet link while a call is open** does not open another window. The call window comes to the
  front and a notification says **"A call is already open. The new link was not opened."** (shown even
  when muted). Clicking it brings the call window forward. If the window is not showing a meeting (for
  example the Meet start page), the new link loads there instead.
  Known limitation: after you leave a call, Meet's goodbye page counts as an open call. Close the call
  window and click the link again.
- **If the Meet page stops working**, a message offers **Reload** or **Close window**.
- Links clicked inside the call window (other than Meet) open in your browser.
- **Show call window** in the tray menu brings a hidden or buried call window back.

## Links, Google files and downloads

**Google links open inside the app, already signed in.** A link to one of these opens in its own app
window:

| Service | Examples |
|---|---|
| Drive | files and folders |
| Docs, Sheets, Slides, Forms | documents, spreadsheets, presentations, forms (short `forms.gle` links too) |
| Calendar | events |
| Gmail, Keep, Contacts, Sites | mail, notes, contacts, sites |

- Clicking the same link again brings the existing window forward. A link to a heading in an open
  document scrolls that window to the heading.
- Closing such a window does not quit the app or touch the Chat window. If the page has unsaved changes
  it asks **"Close this window?"** with **Keep window open** or **Close window**.
- A Chat conversation link clicked in one of these windows opens in the main Chat window.
- These windows do not get camera, microphone or notifications. Presenting a slideshow or a Drive
  video in full screen works.
- A short Forms link that does not lead to Google Forms opens in your browser instead.

**Other links open in your default browser** (any `http` or `https` address, and `mailto:` addresses),
including Google services not listed above, such as Maps.

**Some links are never opened.** Any other kind of link, such as `file:` or `ms-settings:`, is ignored for
safety: nothing opens and nothing is shown.

**Downloads always ask where to save.** Attachments from Chat and downloads from Drive or Docs windows
show a Save dialog (starting in your Downloads folder), and the file is never opened automatically.
If a download comes from an address the app does not allow, it is cancelled and a **"Download blocked"**
message appears. The default button is **Close**; **Open in browser** is offered where possible.

## Copying and keyboard shortcuts

- **Copy link** in Chat works.
- In the Chat window and in Google app windows these shortcuts work: **Ctrl+C** copy, **Ctrl+X** cut,
  **Ctrl+V** paste, **Ctrl+A** select all, **Ctrl+Z** undo, **Ctrl+Shift+Z** redo.
- There is no application menu bar; everything else is handled by the Chat page itself.

<!-- UI-05: publish when shipped -->
## Quick copy with the mouse

- **Right-click a link** to copy its address. A small **"Link copied"** hint appears next to the pointer
  for about a second and a half. Only normal web and email links are copied. This works only where
  Google Chat or the Google page lets the right-click through; where the page shows its own right-click
  menu, nothing is copied.
- **Select text with the mouse** (drag, double-click or triple-click) and it is copied when you release
  the button, with a **"Copied"** hint.
- **It does not copy** from the message box or search box, from a single click or keyboard selection, or
  when selecting text in Google Docs, Sheets, Slides, Gmail or Keep windows (where selecting and pasting
  over is routine). It is not active in the call window, Settings or this Help window. Ctrl+C keeps working everywhere.
- Anything copied goes to the system clipboard, so clipboard history, if you use one, will contain it.
<!-- /UI-05 -->

## Settings

Open **Settings…** from the tray menu. Changes apply immediately; there is no Save button. Press
Escape or the window's close button to close it. Closing Settings never quits the app.

| Setting | What it does | Default |
|---|---|---|
| **Start at login** | Starts the app automatically when you sign in, minimized to the tray. It shows the real state of your system, so if you turned the startup entry off elsewhere (for example in the Windows Task Manager), it shows off. If it cannot be changed, the switch goes back and a message with **Try again** appears. | On after a fresh install |
| **Notification sound** | Plays a sound with new-message notifications. Off keeps notifications but silent. | On |
| **Mute notifications** | Silences notifications. The unread indicator still shows. Also available in the tray menu; both stay in sync. | Off |
| **Blink tray icon on unread** | Blinks the tray icon, and flashes the taskbar button on Windows, for new messages while the window is not active. While muted, a note says it is paused. | On |

The **Help** link near the bottom of the window opens this guide. The bottom of the window shows the app
name and version.

## Linux notes

- **Install:** use the `.AppImage` (mark it executable first, then run it) or the `.deb`
  (`sudo apt install ./google-chat-desktop_*.deb`).
- **Tray:** whether the tray icon and its menu appear depends on your desktop environment. If you do not
  see a tray icon, the window can still be opened by starting the app again, but you cannot reach Exit or
  Settings from the tray.
- **Start at login** works by adding a startup entry to your user's autostart folder.
- **How well it is tested:** Linux builds have only been checked in a Windows-hosted Linux environment
  (WSL2), which does not behave like a real desktop. Notifications, the tray, start at login, the
  camera and the screen-share picker have not been confirmed on a real Linux desktop. Treat Linux as
  less proven than Windows.
- The taskbar flash on Linux depends on your window manager.

## Troubleshooting

- **Windows says "Windows protected your PC" when installing.** The installer is not code-signed, so
  Windows SmartScreen warns about an unknown publisher. Click **More info**, then **Run anyway**.
- **How do I fully quit?** Right-click the tray icon and choose **Exit**. On Windows the icon may be
  hidden behind the **^** arrow in the taskbar. If no tray icon is available, end the app's process from
  your system's task manager.
- **I do not get notifications.**
  - Check that **Mute notifications** is off (tray menu or Settings).
  - You will not get one for the conversation you are currently looking at in the active window.
  - On Windows, check that Focus Assist / Do Not Disturb is off and that notifications are allowed for
    the app in Windows notification settings. Missed ones may still be in the notification centre.
  - Make sure the app is running (tray icon present) and you are signed in.
- **Where is the version?** In the grey line at the bottom of the tray menu and at the bottom of the
  Settings window.
- **I was signed out.** Sign in again in the app window; Google may have ended the session.
