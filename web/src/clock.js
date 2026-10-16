/**
 * The simulated clock: one time for everything that is *placed or oriented in
 * time* (planets, Sun, Moon, Earth's spin, moons, NEOs), so it can run faster
 * than the wall without any of them knowing.
 *
 * Pure and wall-clock-free on purpose: every method takes the wall time as an
 * argument instead of reading `Date.now()`. That is what makes the invariants
 * testable in Node, and it keeps one frame consistent — main.js reads the wall
 * once per frame and hands the same value to every call.
 *
 * What does NOT go through here: anything that decides whether a cache is still
 * valid (`covers()`, `fetchedAt` ages) or animates the interface
 * (`performance.now()`). Those measure the real world, not the scene.
 *
 * The model is a line anchored at one point: `sim = anchorSim + (wall -
 * anchorWall) * rate`. Changing the rate re-anchors at the current instant, so
 * the sim time is continuous — the only thing a speed change may alter is its
 * slope. Left at ×1 from the start (or after `reset`), `anchorSim === anchorWall`
 * and the result is the wall time exactly, not "close to it".
 */

/** The three speeds offered. No reverse: the ephemeris tables start at the 1st of the month. */
export const CLOCK_RATES = Object.freeze({ REAL: 1, HOUR_PER_SECOND: 3600, DAY_PER_SECOND: 86_400 })

const DAY_MS = 86_400_000

/**
 * Where simulated time stops when no table says otherwise: a year from the 1st
 * of the current UTC month, which is the window the planet and Sun tables are
 * fetched on (`SolarSystemClient::windowStart` + 365 days).
 */
export function defaultMaxMs(wallMs) {
  const now = new Date(wallMs)
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) + 365 * DAY_MS
}

/**
 * @param {object} options
 * @param {number} options.wallMs  the wall time the clock starts at (and tracks at ×1)
 * @param {number} [options.minMs]
 * @param {number} [options.maxMs]
 */
export function createClock({ wallMs, minMs = -Infinity, maxMs = Infinity }) {
  let anchorSim = wallMs
  let anchorWall = wallMs
  let rate = CLOCK_RATES.REAL
  let min = minMs
  let max = maxMs

  const unclamped = (wall) => anchorSim + (wall - anchorWall) * rate

  // Real time is exempt from the bounds. They exist to stop an *accelerated*
  // clock at the end of the tables; a clock that is simply tracking the wall
  // must keep doing so past that date (the tables lapse, the app stays right).
  const isRealTime = () => rate === CLOCK_RATES.REAL && anchorSim === anchorWall

  function nowMs(wall) {
    const sim = unclamped(wall)
    return isRealTime() ? sim : Math.min(max, Math.max(min, sim))
  }

  return {
    nowMs,

    /**
     * Changes speed without a jump: the new line passes through the sim time
     * this very instant had, clamped included — so a clock stopped at its limit
     * restarts from the limit, not from where the unclamped line had wandered to.
     */
    setRate(nextRate, wall) {
      anchorSim = nowMs(wall)
      anchorWall = wall
      rate = nextRate
    },

    /** "Maintenant": back to the wall time, at ×1. */
    reset(wall) {
      anchorSim = wall
      anchorWall = wall
      rate = CLOCK_RATES.REAL
    },

    /** Bounds in sim ms. Re-anchors first so moving a bound never makes the time jump through the old line. */
    setBounds(nextMin, nextMax, wall) {
      anchorSim = nowMs(wall)
      anchorWall = wall
      min = nextMin
      max = nextMax
    },

    /** True while the sim time is the wall time — the ISS (a live position) is only valid then. */
    isRealTime,

    /** True when the time has run into the upper bound and stays there. */
    atLimit(wall) {
      return !isRealTime() && rate > 0 && unclamped(wall) >= max
    },

    get rate() {
      return rate
    },
    get maxMs() {
      return max
    },
    get minMs() {
      return min
    },
  }
}
