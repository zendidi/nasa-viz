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

/** Named speeds, in simulated seconds per real second. */
export const CLOCK_RATES = Object.freeze({ REAL: 1, HOUR_PER_SECOND: 3600, DAY_PER_SECOND: 86_400 })

/**
 * The speed slider's stops (2026-10-27), from fast backwards to fast forwards,
 * pause in the middle. Notched rather than continuous: these are rates a person
 * can name ("un jour par seconde"), and a continuous log slider lands on 3 712 s/s.
 * Reverse goes as far as the ephemeris tables do — HISTORY_MONTHS before the
 * 1st of the current month (`defaultMinMs`) — and stops there like the forward end does.
 */
export const RATE_STOPS = Object.freeze([
  -604_800, -86_400, -21_600, -3600, -60, 0, 1, 60, 3600, 21_600, 86_400, 604_800,
])

const DAY_MS = 86_400_000

/** Months the position tables reach back before the 1st of the month (`SolarSystemClient::HISTORY_MONTHS`). */
export const HISTORY_MONTHS = 3

/** The 1st of the current UTC month: the window every table is anchored on (`SolarSystemClient::windowStart`). */
function windowStartMs(wallMs) {
  const now = new Date(wallMs)
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
}

/**
 * Where reversed time stops when no table says otherwise: HISTORY_MONTHS
 * before the 1st of the current UTC month, which is where the planet and Sun
 * position tables start (`SolarSystemClient::positionsStart`).
 */
export function defaultMinMs(wallMs) {
  const now = new Date(wallMs)
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - HISTORY_MONTHS, 1)
}

/**
 * Where simulated time stops when no table says otherwise: a year from the 1st
 * of the current UTC month, which is the window the planet and Sun tables are
 * fetched on (`SolarSystemClient::windowStart` + 365 days).
 */
export function defaultMaxMs(wallMs) {
  return windowStartMs(wallMs) + 365 * DAY_MS
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

    /**
     * "Maintenant": a hard reset — back to the wall time, at ×1, as if the
     * clock had just been created. Nothing of the previous run survives: the
     * next speed change starts from the wall time.
     */
    reset(wall) {
      anchorSim = wall
      anchorWall = wall
      rate = CLOCK_RATES.REAL
    },

    /**
     * Jumps to an instant (sim ms), clamped to the bounds, keeping the rate: the
     * line is re-anchored so `nowMs(wall)` is the target exactly. At ×1 this
     * leaves real time (`anchorSim !== anchorWall`), as it should — the ISS is
     * a live position and must not be drawn at a simulated instant.
     */
    jumpTo(targetMs, wall) {
      anchorSim = Math.min(max, Math.max(min, targetMs))
      anchorWall = wall
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

    /** True when the time has run into the bound it is heading for, and stays there. */
    atLimit(wall) {
      if (isRealTime()) return false
      if (rate > 0) return unclamped(wall) >= max
      if (rate < 0) return unclamped(wall) <= min
      return false
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
