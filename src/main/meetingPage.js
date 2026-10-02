'use strict';

// docs/architecture/meet-call-window.md section 5: "meeting page" is decided from the ADDRESS only,
// by exclusion. Anything not positively excluded (including every unrecognised form) is a meeting
// page - the failure direction is "focus and notify", never "navigate away from a call".

const { MEET_ORIGIN } = require('./meetLink');

function isMeetingPage(address) {
  if (typeof address !== 'string') return true;
  let u;
  try {
    u = new URL(address);
  } catch {
    return true; // empty / unparseable: nothing committed yet, or unknown -> safe direction
  }
  if (u.origin !== MEET_ORIGIN) return false;
  if (u.pathname === '/' || u.pathname === '/landing') return false;
  return true;
}

module.exports = { isMeetingPage };
