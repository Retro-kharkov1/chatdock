'use strict';

// Owner request (2026-09-22, mid-incident on the notification bug): a visible build/version
// indicator in the tray menu, specifically to answer "is this a stale process or the current
// build?" — the exact question the notification investigation lost a whole diagnostic round to
// answering by hand (process-start-time vs. source-mtime archaeology). A bare `app.getVersion()`
// (e.g. "0.1.0") does NOT answer that: every dev run and every packaged build shares the same
// package.json version between releases. This module derives a per-build marker at runtime
// instead, so it can never go stale the way a hand-typed string would.

/**
 * formatBuildTimestamp(mtimeMs)
 *
 * Formats a file mtime (milliseconds since epoch) as a compact, sortable local timestamp
 * (`YYYY-MM-DD HH:mm`) for display in the tray menu. Pure/testable — no Date.now(), no
 * filesystem access; the caller supplies the mtime.
 *
 * @param {number} mtimeMs
 * @returns {string} e.g. "2026-09-22 12:49". Returns "unknown" for a non-finite input (missing
 *   stat, e.g. a packaging layout that doesn't expose the entry file's mtime) rather than
 *   producing "Invalid Date" or throwing — this is a diagnostic aid, not something that should be
 *   able to crash the tray menu build.
 */
function formatBuildTimestamp(mtimeMs) {
  if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs)) return 'unknown';
  const d = new Date(mtimeMs);
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    ` ${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/**
 * buildVersionLabel(version, isPackaged, mtimeMs)
 *
 * Builds the exact string shown as the tray menu's disabled version line. Combines three
 * independent facts, all read from live sources by the caller (never hardcoded):
 * - `version`: `app.getVersion()` — tracks package.json automatically, per the owner's explicit
 *   "cannot drift" requirement.
 * - `isPackaged`: `app.isPackaged` — distinguishes a real installed build from a dev run from
 *   source, since a colleague/owner testing a plain `electron .` process is a different situation
 *   from testing the installed app (see the notification investigation this was born from).
 * - `mtimeMs`: the entry file's mtime, run through `formatBuildTimestamp` — a per-build marker
 *   that changes on every `electron-builder` packaging run (fresh asar) or every source edit (for
 *   dev), without needing a git commit hash or any build-time string injection this repo doesn't
 *   have wired up.
 *
 * @param {string} version
 * @param {boolean} isPackaged
 * @param {number} mtimeMs
 * @returns {string} e.g. "0.1.0 (packaged, built 2026-09-22 13:11)" or
 *   "0.1.0 (source, built 2026-09-22 12:49)".
 */
function buildVersionLabel(version, isPackaged, mtimeMs) {
  const kind = isPackaged ? 'packaged' : 'source';
  return `${version} (${kind}, built ${formatBuildTimestamp(mtimeMs)})`;
}

module.exports = { formatBuildTimestamp, buildVersionLabel };
