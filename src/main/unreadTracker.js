'use strict';

// ONE shared unread baseline for the attention controller and the toast service (review F2), so
// the two can never disagree about whether a title change was an arrival.
//
// Raw counts (parsed from the page title) go in; only two kinds of event come out:
//   onIncrease(n)  a real rise above the baseline - the FR-14 "degraded trigger" and the input of
//                  the generic-toast floor;
//   onObserve(n)   every other change of the settled count: the baseline itself, a decrease, a
//                  CONFIRMED zero. Consumers keep their bookkeeping in sync but never start
//                  anything from it.
//
// Rules:
//   - The first non-zero count after a page load is the baseline (pre-existing unread), so a late
//     initial count on a slow first sign-in is not an arrival. If nothing but zeros is seen for
//     `quietBaselineMs` after the load, the baseline becomes 0 and a later 0 -> N is an increase.
//     (A genuine message inside that first quiet window is still handled by the arrival events -
//     service-worker / page notifications - which do not depend on this tracker.)
//   - Chat ramps the count while spaces load (1 -> 3 -> 5). Rises inside `rampMs` after the
//     baseline was set raise the baseline (onObserve) instead of counting as increases, so launch
//     does not blink/flash/toast. Same trade-off as above: a real message in that window is
//     covered by the arrival events, not by this tracker.
//   - onPageLoaded(currentCount) seeds the baseline from the title's current count: Chat may have
//     set "(N)" before did-finish-load, in which case no further title event would seed it and the
//     next real N -> N+1 would be swallowed as the baseline.
//   - A zero must persist for `zeroHoldMs` before it counts: a transient title without "(N)" parses
//     as 0, and treating it as "everything read" would make the next "(N)" look like an increase.
//
// Timers and the clock are injected so this is unit-tested without waiting (test/unreadTracker.test.js).

/**
 * @param {object} deps
 * @param {(n: number) => void} deps.onObserve
 * @param {(n: number) => void} deps.onIncrease
 * @param {() => number} [deps.now]
 * @param {(fn: () => void, ms: number) => unknown} [deps.setTimer]
 * @param {(handle: unknown) => void} [deps.clearTimer]
 * @param {number} [deps.zeroHoldMs]
 * @param {number} [deps.quietBaselineMs]
 * @param {number} [deps.rampMs]
 */
function createUnreadTracker({
  onObserve,
  onIncrease,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  zeroHoldMs = 1000,
  quietBaselineMs = 20000,
  rampMs = 4000,
}) {
  let baselined = false;
  let stable = 0;
  let loadedAt = now();
  let baselinedAt = 0;
  let zeroTimer = null;

  function cancelZero() {
    if (zeroTimer !== null) {
      clearTimer(zeroTimer);
      zeroTimer = null;
    }
  }

  return {
    /**
     * Call on every page load: forget the baseline, cancel a pending zero, and seed the baseline
     * from the count the title already shows (0/undefined seeds nothing).
     * @param {number} [currentCount]
     */
    onPageLoaded(currentCount) {
      cancelZero();
      baselined = false;
      stable = 0;
      loadedAt = now();
      const n = Number.isFinite(currentCount) && currentCount > 0 ? Math.floor(currentCount) : 0;
      if (n > 0) {
        baselined = true;
        baselinedAt = now();
        stable = n;
        onObserve(n);
      }
    },

    /** Feed every parsed title count, including repeats. */
    onRawCount(raw) {
      const n = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;

      if (!baselined && now() - loadedAt >= quietBaselineMs) {
        baselined = true; // only zeros for the whole quiet window: the baseline is 0
        baselinedAt = now() - rampMs; // no ramp: a rise from 0 now is real
        stable = 0;
      }

      if (n === 0) {
        if (stable === 0 || zeroTimer !== null) return; // nothing to confirm / already confirming
        zeroTimer = setTimer(() => {
          zeroTimer = null;
          stable = 0;
          onObserve(0);
        }, zeroHoldMs);
        return;
      }

      cancelZero();
      if (!baselined) {
        baselined = true;
        baselinedAt = now();
        stable = n;
        onObserve(n);
        return;
      }
      if (n > stable) {
        stable = n;
        if (now() - baselinedAt < rampMs) onObserve(n); // initial load ramp: still baseline
        else onIncrease(n);
      } else if (n < stable) {
        stable = n;
        onObserve(n);
      }
    },
  };
}

module.exports = { createUnreadTracker };
