'use strict';

// Generates `build-info.json` at the repo root — the per-build identity the tray menu (or any
// other part of the app) can read to answer "which build is this, and where did it come from?"
// See docs/architecture/packaging-release.md for the CI wiring and
// docs/adr/0003-packaging-and-code-signing-approach.md-adjacent GitVersion decision for why this
// exists: a bare `app.getVersion()` never changes between two builds of the same commit count,
// and this repo has no tags yet, so the version alone cannot distinguish two builds.
//
// Contract (pinned — a consumer, e.g. the tray menu, depends on these exact field names):
//   {
//     "version":     string  // GitVersion FullSemVer, e.g. "0.1.0-13+Branch.main.Sha.abc1234"
//     "shortSha":    string  // 7-char short commit SHA, or "unknown" if git is unavailable
//     "branch":      string  // branch name, or "unknown" if git is unavailable
//     "buildSource": "ci" | "local"
//     "builtAt":     string  // ISO-8601 UTC timestamp of when this file was generated
//   }
//
// Resolution order, each falling through to the next on failure — this script must NEVER throw
// and must NEVER block a build, per the "local build must not break" requirement:
//   1. CI fast path: if GitVersion_FullSemVer / GitVersion_ShortSha / GitVersion_BranchName env
//      vars are present (set by the `gittools/actions/gitversion/execute` step in
//      .github/workflows/release.yml), use them directly — no need to re-run GitVersion.
//   2. Local GitVersion: try invoking `dotnet-gitversion` (or `gitversion` on PATH) and parse its
//      JSON output. Requires the GitVersion .NET tool to be installed
//      (`dotnet tool install --global GitVersion.Tool`) — most developer machines will not have
//      this, and that is fine (see step 3).
//   3. Fallback (no GitVersion available, anywhere): fall back to plain `git` commands for the
//      sha/branch, and a fixed, clearly-marked placeholder version. This is what makes
//      `npm run dist` / `npm run pack` work on a machine with Node and git but no GitVersion.
//   4. Last resort (git itself unavailable, or not a git checkout at all — e.g. a source tarball):
//      every field becomes "unknown" rather than throwing.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const OUTPUT_PATH = path.join(REPO_ROOT, 'build-info.json');
const FALLBACK_VERSION = '0.0.0-local';

function isCI() {
  // GitHub Actions (and most CI providers) set CI=true. This is the one signal this script
  // trusts to label a build "ci" vs "local" — deliberately not "did GitVersion succeed", since a
  // developer machine that happens to have GitVersion installed is still a local build.
  return process.env.CI === 'true' || process.env.CI === '1';
}

function fromCIEnv() {
  const version = process.env.GitVersion_FullSemVer;
  const shortSha = process.env.GitVersion_ShortSha;
  const branch = process.env.GitVersion_BranchName;
  if (!version || !shortSha || !branch) return null;
  return { version, shortSha, branch };
}

function fromLocalGitVersion() {
  const candidates = ['dotnet-gitversion', 'gitversion'];
  for (const bin of candidates) {
    try {
      const raw = execFileSync(bin, [REPO_ROOT], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const parsed = JSON.parse(raw);
      if (parsed && parsed.FullSemVer && parsed.ShortSha && parsed.BranchName) {
        return {
          version: parsed.FullSemVer,
          shortSha: parsed.ShortSha,
          branch: parsed.BranchName,
        };
      }
    } catch (err) {
      // Not installed, not on PATH, or failed to parse — try the next candidate / fall through.
      continue;
    }
  }
  return null;
}

function gitFallback() {
  const run = (args) => {
    try {
      return execFileSync('git', args, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch (err) {
      return null;
    }
  };
  const shortSha = run(['rev-parse', '--short', 'HEAD']) || 'unknown';
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown';
  return { version: `${FALLBACK_VERSION}+${shortSha}`, shortSha, branch };
}

function resolveIdentity() {
  if (isCI()) {
    const fromEnv = fromCIEnv();
    if (fromEnv) return fromEnv;
    // CI but the GitVersion step didn't run/export — still don't fail the build over it.
  }
  const local = fromLocalGitVersion();
  if (local) return local;
  return gitFallback();
}

function main() {
  let identity;
  try {
    identity = resolveIdentity();
  } catch (err) {
    // Absolute last resort — this function must never throw.
    identity = { version: `${FALLBACK_VERSION}+unknown`, shortSha: 'unknown', branch: 'unknown' };
  }

  const buildInfo = {
    version: identity.version,
    shortSha: identity.shortSha,
    branch: identity.branch,
    buildSource: isCI() ? 'ci' : 'local',
    builtAt: new Date().toISOString(),
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(buildInfo, null, 2) + '\n', 'utf8');
  // eslint-disable-next-line no-console
  console.log(`[generate-build-info] wrote ${OUTPUT_PATH}`);
  // eslint-disable-next-line no-console
  console.log(`[generate-build-info] ${JSON.stringify(buildInfo)}`);
}

main();
