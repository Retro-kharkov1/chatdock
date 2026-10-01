# ADR-0003: Packaging and code-signing approach

**Date**: 2026-09-22
**Status**: accepted
**Deciders**: tech-lead, owner (macOS scope decision)

## Context

FR-09 originally required installers for Windows, macOS, and Linux. This ADR went through two
revisions before landing here — both are kept in the history below because the reasoning matters
for anyone revisiting this later.

**Revision 1 (superseded):** the original version of this ADR treated macOS code signing as a
cosmetic Gatekeeper-warning tradeoff — ship unsigned, the user clicks through a first-run warning,
done. That was wrong. Confirmed directly against
`https://www.electronjs.org/docs/latest/api/notification`:

> "On MacOS, notifications use the UNNotification API as their underlying framework. This API
> requires an application to be code-signed in order for notifications to appear."
> "Unsigned binaries will emit a `failed` event when notifications are called."
> "In unsigned development builds, notifications are not delivered to Notification Center..."

FR-05 (OS-native notifications) is the single stated core requirement of this whole application. An
unsigned macOS build doesn't degrade that requirement, it removes it entirely on that platform:
every `new Notification()` call from Google Chat's own page fails silently (a `failed` event fires
internally; nothing appears in Notification Center). Signing requires an active Apple Developer
Program membership (US $99/year) plus a macOS build host — this repo's only build machine is
Windows, though a macOS GitHub Actions runner (`macos-latest`) would have covered the host
requirement without a physical Mac.

**Revision 2 (this version, current) — macOS dropped from scope, owner decision.** Presented with
the real tradeoff (pay $99/year for a platform vs. ship an installer whose core feature doesn't
work there), the owner confirmed they do not use macOS. Paying an annual fee to make a platform
work that nobody will actually run is not justified for a single-user personal utility — there is
no one to benefit from it. **Target platforms are Windows and Linux only.** This is a deliberate,
owner-made scope decision with a stated cause (the signing-cost-vs-usage tradeoff above), not an
oversight or a fallback default — a future reader should not need to re-derive this from the
git history.

## Decision

- **Build mechanism**: `electron-builder`, driven by a GitHub Actions matrix with one job per target
  OS (`windows-latest`, `ubuntu-latest`), each building natively on its own platform — per
  standard Electron CI practice, which documents the matrix shape and the exact env vars
  electron-builder reads for signing (`CSC_LINK`/`CSC_KEY_PASSWORD`) — not restated here.
- **Windows**: NSIS installer target. **Unsigned** for the initial release (no code-signing
  certificate acquired) — functional, notifications work normally (no signing dependency on this
  platform), but triggers a Microsoft SmartScreen "unknown publisher" warning on first run. Signing
  later requires purchasing a code-signing certificate — an explicit, separate decision for the
  owner, not assumed in scope.
- **Linux**: two targets — **AppImage** (runs anywhere, no installation) and **deb** (installs
  properly via `apt`/`dpkg` on the Debian/Ubuntu family, the Linux the owner is actually likely to
  run). Building the deb requires `linux.category` and `linux.maintainer` in the electron-builder
  config, which AppImage does not need — see
  [packaging-release.md](../architecture/packaging-release.md) for what those fields do. Neither
  format has a signing requirement, so there is nothing to defer for either one; notifications have
  no signing dependency on this platform.
  <sub>Correction, same date: the implementation brief specified "AppImage/deb" without this ADR
  having been checked against it first — a tech-lead briefing gap, not an implementer deviation.
  Both targets are already built and working, and a `.deb` is strictly more useful for the owner's
  actual Debian/Ubuntu usage than AppImage alone, so this ADR is updated to match reality rather
  than reverting working packaging to satisfy the original wording.</sub>
- **macOS: out of scope**, per the owner decision above. `mac` is not a target in the
  electron-builder config or the CI matrix (see [packaging-release.md](../architecture/packaging-release.md)).
  The matrix stays structured as one-job-per-OS (rather than, say, a single combined job), so adding
  a `macos-latest` job later — if the owner acquires a Mac, or reconsiders — is additive (one new
  matrix entry + the signing secrets from Revision 1's design), not a pipeline rewrite. If macOS is
  ever revisited, re-read Revision 1's analysis above first — the code-signing-for-notifications
  requirement doesn't go away just because time has passed.
- **Revisit trigger**: if the owner acquires a Windows code-signing certificate, the same CI matrix
  already has the plumbing to consume it (`CSC_LINK`/`CSC_KEY_PASSWORD`) — no pipeline redesign
  needed, only adding the secret and flipping the electron-builder config for Windows.

## Alternatives Considered

### Alternative 1: Ship macOS anyway, unsigned (Revision 1's original framing)
- **Pros**: technically satisfies FR-09's original three-platform wording.
- **Cons**: ships an installer whose core feature (FR-05) is silently dead, for a platform the owner
  doesn't use — pure maintenance and CI cost with zero benefit to anyone.
- **Why not**: no user to benefit from it; the owner explicitly declined the cost of making it work
  correctly (signing) and declining to ship it broken is the more honest choice than shipping a
  half-working artifact for its own sake.

### Alternative 2: Ship macOS anyway, signed (pay for Apple Developer Program)
- **Pros**: would have been the only way to ship a fully-working macOS build.
- **Cons**: recurring $99/year cost for a platform the owner does not use.
- **Why not**: the owner's explicit call — no justification for the cost given zero usage.

### Alternative 3: Delay the whole release pending a macOS decision
- **Pros**: none beyond the above two — this was never necessary once the owner answered directly.
- **Cons**: blocks Windows/Linux, which have no macOS-shaped gap at all, on a question that's now
  resolved.
- **Why not**: superseded by the owner's answer; no reason to block shipping platforms that work.

## Consequences

### Positive
- Windows and Linux ship fully functional, including FR-05, with a smaller CI matrix and no
  Apple-tooling dependency to maintain.
- No silent gap: there is no macOS artifact promising a "chat notifier" that doesn't notify.
- Re-adding macOS later (if the owner's situation changes) is additive, not a redesign — the
  analysis and the exact config change needed are preserved in Revision 1 above.

### Negative
- FR-09 and NFR-05 below no longer describe macOS at all — see `requirements.md`'s updated FR-09/
  NFR-05/NFR-01 for the corresponding scope change; this is a genuine requirements-doc edit, not
  just an implementation detail, and is recorded there too so the two documents don't drift.

### Risks
- None — this is a fully accepted, owner-confirmed scope decision, not an open risk.
