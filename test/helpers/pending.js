'use strict';

// BUG-01 coverage-first net: helper for tests that specify NEW required behaviour that the product
// code does not implement yet ("red" tests).
//
//   pending(name, fn)            BUG-01 set. ENFORCED BY DEFAULT since BUG-01 landed (a failure is a
//                                real failure). `GCD_ENFORCE_BUG01=0 npm test` downgrades it back to
//                                node:test `todo` (still runs, does not fail the suite) - only
//                                useful to bisect a regression, never in CI.
//   pendingMeet(name, fn)        NFR-07 Meet link classifier set (src/main/meetLink.js). ENFORCED BY
//                                DEFAULT since UI-01 started (coverage-first net: red until the module
//                                lands, then green). `GCD_ENFORCE_MEET=0 npm test` downgrades it to
//                                node:test `todo` - only useful to bisect, never in CI.
//
// Modules that do not exist yet MUST be loaded with `load()` inside the test body, never with a
// top-level `require`, so a missing module fails only its own test instead of the whole file.

const { test } = require('node:test');

const DEFAULT_ENFORCE = true;
const ENFORCE =
  process.env.GCD_ENFORCE_BUG01 === '1' ||
  (DEFAULT_ENFORCE && process.env.GCD_ENFORCE_BUG01 !== '0');

const DEFAULT_ENFORCE_MEET = true;
const ENFORCE_MEET =
  process.env.GCD_ENFORCE_MEET === '1' ||
  (DEFAULT_ENFORCE_MEET && process.env.GCD_ENFORCE_MEET !== '0');

function pending(name, fn) {
  const options = ENFORCE ? {} : { todo: 'BUG-01 spec - not enforced' };
  return test(`[BUG-01] ${name}`, options, fn);
}

function pendingMeet(name, fn) {
  const options = ENFORCE_MEET ? {} : { todo: 'NFR-07 Meet classifier - not implemented yet (awaiting design approval)' };
  return test(`[NFR-07 Meet pending] ${name}`, options, fn);
}

/** load(relPathFromSrcMain) - lazy require of a src/main module that may not exist yet. */
function load(relPath) {
  return require(`../../src/main/${relPath}`);
}

module.exports = { pending, pendingMeet, load };
