/**
 * The Horizons position tables the scene reads — the Sun's, the Moon's, the
 * planets', the moons' and the NEOs' — and the two rules they all share:
 * whether a stored table may still be used, and where a body is at an instant.
 *
 * A table is `{timeScale, start, stepSeconds, positions}`: geocentric (or
 * planet-centred) ICRF km, one row per step from `start`, in UTC seconds. Pure —
 * no fetch, no storage — so the owners keep their own loading (each loads
 * differently: one body, one per planet in sequence, or a planet's moons until
 * the route says none is missing) and only the rules live here.
 */

import { TIME_SCALE } from '../data/api.js'
import { sampleCatmullRom } from './interpolate.js'
import { icrfToScene } from '../scene/geo.js'

/**
 * Catmull-Rom points per table interval when a table is redrawn as a line — the
 * planets', the moons' and the Earth's orbits share the factor, so that every
 * line hugs its body to the same degree.
 */
export const ORBIT_SMOOTHING = 8

/** Time of the last sample, in seconds. */
export function tableEndSeconds(table) {
  return table.start + (table.positions.length - 1) * table.stepSeconds
}

/**
 * Whether a stored table may still be used at the wall-clock instant `nowMs`.
 *
 * Wall clock on purpose, at every caller: this decides whether a *cached* table
 * is still worth keeping, a fact about the real world — not about the simulated
 * date.
 *
 * - The time scale must be the one the backend serves now: a TDB table from
 *   before 2026-10-21 runs 69 s late.
 * - `marginMs`: how long before its end a table is given up.
 *
 * (2026-11-05, lot 3: the `history` option is gone — it demanded a table reaching
 * back to `defaultMinMs`, the 1st of the month minus 3 months. The Sun's and the
 * planets' tables are now yearly slices checked one by one, `slices.js`, and
 * the clock's lower bound is `clockBounds`.)
 *
 * @param {{marginMs?: number}} [options]
 */
export function tableCovers(table, nowMs, { marginMs = 0 } = {}) {
  if (!table?.positions?.length) return false
  if (table.timeScale !== TIME_SCALE) return false
  if (nowMs < table.start * 1000) return false
  return nowMs < tableEndSeconds(table) * 1000 - marginMs
}

/** Fractional row of `seconds` in the table: 0 on the first sample, `length - 1` on the last. */
export function tableIndexAt(table, seconds) {
  return (seconds - table.start) / table.stepSeconds
}

const interpIcrf = [0, 0, 0]

/**
 * Position at fractional row `f`, in km and **scene** axes: cubic Catmull-Rom
 * in ICRF (interpolate.js, which clamps `f` to the table), then one change of
 * axes. Interpolating after the change would cost the same and gain nothing;
 * converting each row first would cost a conversion per neighbour.
 *
 * @param {number[][]} rows  ICRF km
 * @param {import('three').Vector3} out
 */
export function sampleKm(rows, f, out) {
  sampleCatmullRom(rows, f, interpIcrf)
  return icrfToScene(interpIcrf[0], interpIcrf[1], interpIcrf[2], out)
}

/** `sampleKm` at an instant (seconds) of a table. Clamped past either end, like `sampleKm`. */
export function tablePositionKm(table, seconds, out) {
  return sampleKm(table.positions, tableIndexAt(table, seconds), out)
}
