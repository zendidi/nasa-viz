/**
 * The trajectory tool's cursor (2026-11-05): a second instant, T′, that the
 * tracked objects are placed at while everything else — the clock, the planets,
 * the Earth that is drawn — stays at the scene's own instant T.
 *
 * T′ = T + offset. The offset is the only state, and it belongs to the cursor:
 * the clock changing speed, or jumping, moves T and leaves the offset alone (user's
 * call, "si on change de vitesse, on change juste de vitesse"). Only an explicit
 * `reset()` — the "0" of the tool, or "Maintenant" of the time panel — zeroes it.
 *
 * Pure and wall-clock-free like ephemeris/clock.js: every method is given T and
 * the wall time, so it runs in Node.
 */

// A tab left in the background must not make the playing cursor leap by minutes.
const MAX_STEP_SECONDS = 0.25
// Below half a second the offset is arithmetic noise from T + offset − T: it is zero.
const SNAP_SECONDS = 0.5

/**
 * @param {object} options
 * @param {(wallMs: number) => {minS: number, maxS: number}} options.bounds  the instants T′ may reach
 */
export function createCursor({ bounds }) {
  let offset = 0
  /** T′ seconds per real second while playing; 0 when paused. */
  let playRate = 0
  let lastWallMs = null

  const clamp = (tS, wallMs) => {
    const { minS, maxS } = bounds(wallMs)
    return Math.min(maxS, Math.max(minS, tS))
  }

  function setTPrime(tPrimeS, nowS, wallMs) {
    const next = clamp(tPrimeS, wallMs) - nowS
    offset = Math.abs(next) < SNAP_SECONDS ? 0 : next
  }

  return {
    /** T′ for the scene's instant `nowS`: exactly T while the offset is zero (even where the bounds would cut it). */
    tPrimeAt: (nowS, wallMs) => (offset === 0 ? nowS : clamp(nowS + offset, wallMs)),
    get offsetSeconds() {
      return offset
    },
    get playRate() {
      return playRate
    },
    /** Puts T′ at an absolute instant (clamped to the bounds). */
    setTPrime,
    /** Moves T′ by `seconds` from where it is now. */
    shift(seconds, nowS, wallMs) {
      setTPrime((offset === 0 ? nowS : clamp(nowS + offset, wallMs)) + seconds, nowS, wallMs)
    },
    /** Offset zero and playback stopped: the objects are back at the scene's time. */
    reset() {
      offset = 0
      playRate = 0
    },
    /** Starts playing at `rate` T′-seconds per real second, or pauses with 0. */
    play(rate) {
      playRate = rate
      lastWallMs = null
    },
    /**
     * Advances a playing cursor to this frame. Stops it on reaching the end of the
     * range it is heading for. Returns whether T′ moved.
     */
    step(nowS, wallMs) {
      const dt = lastWallMs === null ? 0 : Math.min(MAX_STEP_SECONDS, Math.max(0, (wallMs - lastWallMs) / 1000))
      lastWallMs = wallMs
      if (playRate === 0 || dt === 0) return false
      const before = offset
      const current = offset === 0 ? nowS : clamp(nowS + offset, wallMs)
      const { minS, maxS } = bounds(wallMs)
      setTPrime(current + playRate * dt, nowS, wallMs)
      if ((playRate > 0 && current + playRate * dt >= maxS) || (playRate < 0 && current + playRate * dt <= minS)) playRate = 0
      return offset !== before
    },
  }
}
