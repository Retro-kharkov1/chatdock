# Contributing

Thanks for considering a contribution. This app is a thin wrapper around the Google Chat web app, so
the bar for changes is: keep the wrapper thin and keep the security defaults intact. Please read the
parts below that apply before opening a pull request.

## Getting set up

Requires Node.js 20 or newer.

```
npm ci
npm start       # run the app from source
npm test        # run the test suite
```

Building installers is described in [packaging-release.md](docs/architecture/packaging-release.md)
(`npm run dist`, needs the .NET SDK for versioning) and
[build-linux-in-docker.md](docs/development/build-linux-in-docker.md) (Linux artifacts in a container).

## Tests

`npm test` must be green before you ask for review. Please do not delete or weaken a failing test to
get there; if a test fails, that is the finding. New behaviour needs a test.

Anything that depends on the OS (notifications, tray, autostart, installers) cannot be proven by unit
tests alone. Say in the pull request which platform you actually ran it on.

## Ground rules

These are summarized from [Project Rules](docs/architecture/project-rules.md); changes that bend them
need a discussion first.

- **Wrapper, not a rewrite.** Do not scrape, modify or inject UI or script into Google Chat or Meet.
- **Keep the Electron security baseline.** `contextIsolation` on, `nodeIntegration` off, `sandbox` on,
  no `<webview>`, a minimal `contextBridge` surface, allow-listed navigation and external schemes.
- **Hidden window must stay live.** Hiding the window must not throttle the page or lose notifications.
- **Quit only from the tray.** The close button hides; it never quits.
- Never log message text, chat names, cookies or tokens.

## Documentation

Docs live in [docs/](docs/README.md). Significant, hard-to-reverse decisions get an ADR in
`docs/adr/`. Update the requirements or architecture doc when behaviour changes.

## Pull requests

- One logical change per pull request; keep unrelated cleanups separate.
- Describe what changes for a user of the app, and why, not which files moved.
- Make sure `npm test` passes and the app starts before asking for review.
