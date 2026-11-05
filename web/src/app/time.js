/**
 * The time panel's controller: speed, pause and "Maintenant", the clock's
 * bounds, and the redraw after any jump of the simulated date.
 *
 * The clock itself (ephemeris/clock.js) is created in main.js, since nearly
 * everything reads it. What a jump has to redo outside the clock — the Sun and
 * Moon, the scale panel, the open sheets — main.js does in `on.jumped`.
 */

import { clockBounds } from '../ephemeris/slices.js'

/**
 * @param {object} options
 * @param {object} options.clock  clock.js
 * @param {{startMs: ?number, endMs: ?number}} options.sunTable  whose window bounds the clock
 * @param {(state: object) => void} options.render  panels.renderTime
 * @param {{jumped: (simMs: number, wallMs: number) => void, reset: () => void}} options.on
 */
export function createTimeControls({ clock, sunTable, render, on }) {
  /**
   * The bounds are [wall − 1 year, wall + 4 years] floored to a UTC midnight —
   * the range of the yearly slices, and the trajectory tool's cursor (`clockBounds`,
   * slices.js, 2026-11-05) — cut to the Sun's assembled table when that is
   * shorter (a slice that has not arrived, or failed). Both ends matter since time
   * can run backwards (2026-10-27). Real time stays exempt (clock.js).
   * It used to be the Sun table's window of the month (1st − 3 months, + 365 d).
   */
  function refreshBounds(wallMs) {
    const { minMs, maxMs } = clockBounds(wallMs, { startMs: sunTable.startMs, endMs: sunTable.endMs })
    clock.setBounds(minMs, maxMs, wallMs)
  }

  function renderPanel(simMs, wallMs) {
    render({
      rate: clock.rate,
      realTime: clock.isRealTime(),
      simMs,
      atLimit: clock.atLimit(wallMs),
      limitMs: clock.rate < 0 ? clock.minMs : clock.maxMs,
    })
  }

  /** Everything that was computed "once a minute" from the old time has to be redone now, not 60 s later. */
  function afterJump() {
    const wallMs = Date.now()
    const simMs = clock.nowMs(wallMs)
    on.jumped(simMs, wallMs)
    renderPanel(simMs, wallMs)
  }

  /**
   * The speed "Lecture" goes back to: the last non-zero one, ×1 until another is
   * picked. Pausing from the slider's own pause stop counts too, so the button
   * always resumes whatever was running before — without the hard reset of
   * "Maintenant", the simulated date stays where it was paused.
   */
  let resumeRate = 1

  function togglePause() {
    setRate(clock.rate === 0 ? resumeRate : 0)
  }

  function setRate(rate) {
    if (clock.rate !== 0 && rate === 0) resumeRate = clock.rate
    const wallMs = Date.now()
    clock.setRate(rate, wallMs)
    refreshBounds(wallMs)
    afterJump()
  }

  function reset() {
    resumeRate = 1
    clock.reset(Date.now())
    afterJump()
    on.reset()
  }

  return { refreshBounds, renderPanel, afterJump, togglePause, setRate, reset }
}
