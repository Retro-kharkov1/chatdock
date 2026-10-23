'use strict';

// BUG-09 EXPERIMENT ONLY (branch wip/BUG-09-exp, never merged). Launch-time switches for the two experiments:
//   wakeLock   (A) grant Meet's `screen-wake-lock` (meetPermissions.js, session.js)
//   blankPopup (B) allow the one about:blank popup Chat opens for the call (blankPopup.js)
//
// Read once in the main process at startup from the command line or the environment. Never persisted, never shown in
// a UI, never sent over IPC or exposed to a page. Precedence: command line, then environment, then `baked`.
// With no `baked` argument every flag is OFF (the safe default). Only index.js of THIS build passes the baked
// values (EXPERIMENT_BAKED_DEFAULTS, both ON); main carries none of this file.
//
//   --exp-wake-lock[=0|1]      env GCD_EXP_WAKE_LOCK
//   --exp-blank-popup[=0|1]    env GCD_EXP_BLANK_POPUP
// Values: 1/true/on enable, 0/false/off disable, a bare switch enables, anything else is ignored.

const FLAGS = Object.freeze({
  wakeLock: Object.freeze({ arg: '--exp-wake-lock', env: 'GCD_EXP_WAKE_LOCK' }),
  blankPopup: Object.freeze({ arg: '--exp-blank-popup', env: 'GCD_EXP_BLANK_POPUP' }),
});

/** This artifact only: both experiments ON unless the command line or environment says otherwise. */
const EXPERIMENT_BAKED_DEFAULTS = Object.freeze({ wakeLock: true, blankPopup: true });

function parseValue(raw) {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'on') return true;
  if (v === '0' || v === 'false' || v === 'off') return false;
  return undefined;
}

function fromArgv(argv, name) {
  let result;
  if (!Array.isArray(argv)) return undefined;
  for (const a of argv) {
    if (typeof a !== 'string') continue;
    if (a === name) result = true;
    else if (a.startsWith(`${name}=`)) {
      const v = parseValue(a.slice(name.length + 1));
      if (v !== undefined) result = v; // the last valid occurrence wins
    }
  }
  return result;
}

/** resolveExpFlags({ argv, env, baked }) -> { wakeLock: boolean, blankPopup: boolean }. */
function resolveExpFlags({ argv = [], env = {}, baked = {} } = {}) {
  const out = {};
  for (const [key, def] of Object.entries(FLAGS)) {
    const a = fromArgv(argv, def.arg);
    const e = parseValue(env && env[def.env]);
    out[key] = a ?? e ?? baked[key] === true;
  }
  return out;
}

module.exports = { FLAGS, EXPERIMENT_BAKED_DEFAULTS, resolveExpFlags };
