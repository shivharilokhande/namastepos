// NamastePOS backend — deploy identity ("is the new code actually live?").
//
// Why this exists (2026-09-05)
// ----------------------------
// GET /v1/health answered with package.json's `version`, which has been the
// literal string "1.0.0" for every deploy this service has ever had, and no
// response header carried a build marker either. So after pushing a commit
// there was no way to tell from OUTSIDE whether Render had picked it up — the
// only answer lived in the Render dashboard, which no script, no uptime
// monitor and no agent can read. Every deploy was therefore unverifiable by
// anything except a human clicking around.
//
// This module makes the health payload a build marker instead: short commit
// SHA, branch, and when this process started (so a restart on the SAME commit
// is visible too — that is how you tell "redeployed" from "still up").
//
// Where the SHA comes from
// ------------------------
//   RENDER_GIT_COMMIT  Render injects this into every service automatically,
//                      at build time AND runtime, for all runtimes. Nothing
//                      has to be configured for it to be there; it is listed
//                      under "Default Environment Variables > All runtimes"
//                      as "The commit SHA for a service or deploy".
//                      https://render.com/docs/environment-variables
//                      (RENDER_GIT_BRANCH, same list, carries the branch.)
//   GIT_COMMIT         Generic escape hatch so this is not Render-only — a
//                      Docker build ARG or a CI step can set it and the same
//                      field keeps working if we ever move hosts.
//   neither            "unknown". Local dev, jest and CI have no such var and
//                      must not be a special case: the field is ALWAYS
//                      present with a string value, so a consumer can compare
//                      it unconditionally and never has to handle a missing
//                      key. Nothing here can throw.
//
// What it deliberately does NOT do
// --------------------------------
// A commit SHA is not a secret (the repo is public) but the rest of the
// environment is. Values are pattern-checked, not echoed: anything that is
// not a plausible git SHA or a plausible branch name is reported as
// "unknown" rather than passed through. That means a typo'd or hijacked env
// var can never turn this PUBLIC endpoint into a way to read arbitrary
// environment content. No paths, no service ids, no other RENDER_* values.
//
// Cost: two property reads, one regex over <= 40 characters, no I/O and no DB
// round-trip. /v1/health is hit every 5 minutes by UptimeRobot; this adds
// nothing measurable to it.
//
// NOTE these are read from process.env directly rather than through
// config/env.js on purpose. They are platform-injected build markers, not
// configuration anybody sets or that has a sensible default — env.js is the
// source of truth for things we CHOOSE, this is the source of truth for what
// the platform TELLS us. (env.js carries a pointer comment to here.)

// A git SHA: hex, 7 (short) to 40 (full) chars. Render sends the full 40.
const SHA_RE = /^[0-9a-f]{7,40}$/i;
// Git ref characters only, and short. `main`, `release/1.2`, `fix-NP-140`.
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,64}$/;

// Captured once, at first require — i.e. at boot. Derived from process.uptime()
// rather than plain Date.now() so it is the actual process start instant even
// if this module is required late in the boot sequence.
const STARTED_AT = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();

/** Short (7-char) deployed commit SHA, or 'unknown'. Never throws. */
function commit() {
  const raw = String(process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || '').trim();
  if (!SHA_RE.test(raw)) return 'unknown';
  return raw.slice(0, 7).toLowerCase();
}

/** Deployed branch, or 'unknown'. Never throws. */
function branch() {
  const raw = String(process.env.RENDER_GIT_BRANCH || process.env.GIT_BRANCH || '').trim();
  if (!BRANCH_RE.test(raw)) return 'unknown';
  return raw;
}

/**
 * The build marker block spliced into both health payloads.
 * Always the same four keys, always strings/numbers, never absent.
 */
function buildInfo() {
  return {
    commit: commit(),
    branch: branch(),
    startedAt: STARTED_AT,
    uptimeSeconds: Math.floor(process.uptime()),
  };
}

module.exports = { buildInfo, commit, branch, STARTED_AT };
