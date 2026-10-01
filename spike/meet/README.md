# Spike B harness (THROWAWAY) - Meet in an Electron 44 window

Not product code. Never packaged (`build.files` only includes `src/**`). Delete when UI-01 ships.
Result of record: ADR-0004, "Spike B" section. Imports `PARTITION` and `buildDesktopUserAgent`
from `src/main/session.js` (read-only use).

## Launch (from the repo root, in a NORMAL, NON-elevated terminal)

    node_modules\.bin\electron spike\meet

Options: `--url=https://meet.google.com/<code>`, `--unload=log|override`,
`--profile=harness|product`, `--mode=auto`.

**Do not launch from an Administrator terminal.** In an elevated process Windows Graphics Capture
fails with `0x80070005` and `getDisplayMedia` rejects with `NotReadableError` (observed, see ADR).

`--profile=harness` (default) uses `spike\meet\.profile` (own cookies, sign in once, product app may keep
running). `--profile=product` uses `%APPDATA%\google-chat-desktop`, i.e. the real signed-in session; the
product app must be fully quit first (shared profile files).

Log: console and `spike\meet\out\spike-b.log` (origin+path only, no query strings, cookies or credentials).

## Owner checklist (about 5 minutes)

Run 1, `node_modules\.bin\electron spike\meet`:

1. Sign-in. The window opens meet.google.com/new and redirects to accounts.google.com. Sign in with a test
   or real account. Record: does Google show "This browser or app may not be secure"? Does it complete and land
   on Meet? (log lines `did-navigate`, `navigation-denied`).
2. Start the instant meeting. Allow nothing in any Electron dialog (there is none). Record: camera preview
   visible, mic level moves, other devices selectable. (`permission` log lines show what was asked/denied.)
3. Present now > pick a screen: the harness picker window must appear. Record: Meet shows "you are presenting".
   Then stop and try again and press Cancel in the picker: Meet should show no share and no error loop.
4. Press F5 inside the call. Record: does Meet reload or does nothing happen? Log line `will-prevent-unload`
   with `"appInitiatedClose":false` means Meet objected to a page-initiated unload.
5. Click the window X while in the call. Record: window closes or stays; log lines `will-prevent-unload`,
   `STILL-OPEN-5s-AFTER-CLOSE`. After it closes, confirm the camera LED is off and the `devices+3s` /
   `devices+10s` log lines show `"inUse":false` for webcam and microphone.

Run 2, `node_modules\.bin\electron spike\meet --unload=override`: repeat step 5. Record whether the X now
closes at once during a call.

Run 3 (optional, only to answer "does the existing session work"): quit the product app fully, run
`node_modules\.bin\electron spike\meet --profile=product`, record whether Meet opens signed in with no login.

Send back `spike\meet\out\spike-b.log` plus your notes (the log contains no credentials).

## Linux (WSL2 + WSLg)

Setup and limits: `docs/development/verify-on-linux-wslg.md`. Launch with `--ozone-platform=x11` or
`--ozone-platform=wayland`. On Linux the device-release evidence comes from PulseAudio source-outputs
(`pactl`) and `/dev/video*`, not the Windows ConsentStore. Under WSLg the owner steps 1 to 5 above must
be done by hand in the WSLg window (there is no camera there; the mic is `RDPSource`).

## Automated probes

    node_modules\.bin\electron spike\meet --mode=auto      (non-elevated; takes about 80 s; windows flash)

Writes `out\auto-results.json` and `out\real-meet.png`. It briefly uses the real camera and microphone and
drives the harness picker by simulating a click on its buttons (a test driver; the product never auto-selects).
The probe pages are served locally under the real `https://meet.google.com` origin through
`session.protocol.handle`, so the permission handlers see the true origin.
