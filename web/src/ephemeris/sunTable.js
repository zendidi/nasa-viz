/**
 * Where the Sun — and since 2026-10-21 the Moon — is, from JPL Horizons rather
 * than from a series. Written for the Sun; the Moon reuses it whole
 * (`createMoonTable`).
 *
 * `astronomy.js` still computes a Sun, and it is still what this falls back to
 * before the table lands — but it works in the **equinox of date** where the
 * scene's axes are J2000. Measured 2026-09-29: 956 143 km apart, 0,3656°, which
 * is 300 scene units at true scale. That is the precession accumulated since
 * J2000, and it grows (1 017 187 km by mid-2027).
 *
 * The error was everywhere at once, because the Sun is not decoration here: it
 * places the terminator on the globe, lights the Moon's phase, is subtracted to
 * build the whole heliocentric view, and anchors every planet and NEO drawn in
 * it. One table fixes all of them together.
 *
 * It costs **one keyless request a month** — the very shape the backend already
 * serves for a planet, so `?body=sun` reuses that route, that cache and that
 * window with no new machinery.
 *
 * Since 2026-11-05 (lot 3) it is one request per **civil year**, six of them
 * (Y−1 to Y+4), assembled into one continuous table (`slices.js`, `sliceSet.js`):
 * the table is then [now − 1 year, now + 4 years] and bounds the simulated clock.
 * The same table is what the trajectory tool subtracts from its objects.
 */

import * as THREE from 'three'
import { subdivideTable } from './interpolate.js'
import { getMoonEquatorial, getSunEquatorial } from './astronomy.js'
import { icrfToScene, latLngToVector3 } from '../scene/geo.js'
import { ORBIT_SMOOTHING, sampleKm, tableEndSeconds, tableIndexAt } from './positionTable.js'
import { createSliceSet } from './sliceSet.js'
import { runJobs, yearOfMs, yearRange, yearsByDistance } from './slices.js'

// Curve points per daily sample in the Earth's orbit line — same factor as the planets' orbits
// (ORBIT_SMOOTHING; both in positionTable.js).
const SIDEREAL_YEAR_DAYS = 365.256

/**
 * Which samples of a table draw the Earth's orbit: at most one sidereal year,
 * centred on `centerMs`, shifted to stay inside the table when the centred window
 * would overflow one side. Inclusive indices; the whole table if it is shorter
 * than a year.
 *
 * @returns {{from: number, to: number}}
 */
export function orbitWindowIndices(startSeconds, stepSeconds, count, centerMs) {
  const last = count - 1
  const span = Math.floor((SIDEREAL_YEAR_DAYS * 86400) / stepSeconds) // intervals, so <= 1 year
  if (span >= last) return { from: 0, to: Math.max(0, last) }
  const f = (centerMs / 1000 - startSeconds) / stepSeconds
  const from = Math.min(Math.max(Math.round(f - span / 2), 0), last - span)
  return { from, to: from + span }
}

/**
 * The Sun's table. See `createBodyTable` for the machinery shared with the Moon.
 *
 * @param {{changed: Function}} on  fired when the table lands, so the caller can
 *   redraw anything it derived from the fallback Sun
 */
export function createSunTable({ on }) {
  return createBodyTable({ body: 'sun', fallback: getSunEquatorial, on })
}

/**
 * The Moon's table, on exactly the Sun's terms (2026-10-21). Its series stood
 * in alone until then: 0,38° (2 500 km) from DE441 on median and 0,67° at worst
 * over a year — three quarters of it the precession since J2000, the very error
 * the Sun's table was brought in to remove. Daily Catmull-Rom costs 94 km at
 * worst (measured), against 4 150 for the series.
 *
 * @param {{changed: Function}} on  fired when the table lands
 */
export function createMoonTable({ on }) {
  return createBodyTable({ body: 'moon', fallback: getMoonEquatorial, on })
}

/**
 * A geocentric daily Horizons table for one body (`?body=` on the planets'
 * route), with its low-precision series standing in until it lands.
 *
 * @param {{body: string, fallback: (date: Date) => {ra: number, dec: number, distanceKm: number},
 *   on: {changed: Function}}} options
 */
function createBodyTable({ body, fallback, on }) {
  // The slices read back from localStorage are in from the first frame; the
  // assembled table is the set's own (memoised, same object until a slice lands).
  const set = createSliceSet(body)
  /** A `retry()` is running: a second click must not start a second loop. */
  let retrying = false
  const table = () => set.table()

  /**
   * Geocentric Sun in km, scene axes, at `date`.
   *
   * Falls back to the series whenever the table cannot answer — before the first
   * load, offline, or for a date outside the window. That fallback is not a
   * formality: the scene draws its first frame long before any fetch returns,
   * and a Sun at the origin would put the terminator through the Earth's centre.
   * Callers that care about the difference watch `known`.
   *
   * Catmull-Rom on the daily samples, in ICRF km, then one change of axes. The
   * Sun is subtracted to build the heliocentric view, so its interpolation error
   * lands on every planet's drawn position: linear was up to 5 750 km off over a
   * year (measured 2026-10-15), more than twice Mercury's 2 440 km radius.
   */
  function positionKmAt(date, out) {
    const current = table()
    if (current) {
      const f = tableIndexAt(current, date.getTime() / 1000)
      if (f >= 0 && f <= current.positions.length - 1) return sampleKm(current.positions, f, out)
    }
    const { ra, dec, distanceKm } = fallback(date)
    return out.copy(latLngToVector3(dec, ra, distanceKm))
  }

  /**
   * The Earth's orbit, as the Sun's own samples negated — the Earth seen from
   * the Sun *is* the Sun seen from the Earth, reversed.
   *
   * Taken from the table rather than sampled over a year from "now", and that is
   * what makes the Earth sit on its own line: the line is the table redrawn by
   * `subdivideTable` — the very Catmull-Rom curve `positionKmAt` places the
   * globe on — so the globe is a point of it by construction. Straight chords
   * between the daily samples no longer were once placement went cubic
   * (2026-10-15): up to ~5 700 km off, nearly an Earth radius. Sampling a year
   * forward from now would also run off the end of a table that starts on the
   * 1st of the month.
   *
   * @returns {THREE.Vector3[] | null} null while only the fallback series is available
   */
  function earthOrbitSamplesKm(centerMs = Date.now()) {
    const current = table()
    if (!current) return null
    // One sidereal year centred on the simulated instant, not the whole ~6-year
    // window, which would draw the orbit six times over.
    const { from, to } = orbitWindowIndices(current.start, current.stepSeconds, current.positions.length, centerMs)
    return subdivideTable(current.positions.slice(from, to + 1), ORBIT_SMOOTHING).map(([x, y, z]) => icrfToScene(x, y, z, new THREE.Vector3()).negate())
  }

  /**
   * One year's slice, cache-first (it was read at creation) and keyless like the
   * planets': nothing to refresh, a slice is immutable. Resolves true when the
   * year is held. A failure is silent for the scene — the series carries it
   * meanwhile, the next page load asks again — and kept in `error` for the tool.
   */
  async function loadYear(year) {
    const had = set.has(year)
    const ok = await set.load(year)
    if (ok && !had) on.changed()
    return ok
  }

  /** Every year the range still lacks, nearest to the current one first, stopping when the server is down. */
  async function retry() {
    if (retrying) return
    retrying = true
    try {
      const years = yearsByDistance(yearOfMs(Date.now()), yearRange(Date.now()))
      await runJobs(years.filter((year) => !set.has(year)), loadYear)
    } finally {
      retrying = false
    }
  }

  return {
    positionKmAt,
    earthOrbitSamplesKm,
    loadYear,
    retry,
    /** The years of the range not held yet. */
    missingYears: () => set.missingYears(),
    /** Start of the assembled table in ms (its first row, the outer overlap included), null without one — the simulated clock's lower bound. */
    get startMs() {
      const current = table()
      return current ? current.start * 1000 : null
    },
    /** End of the assembled table in ms (its last row), null without one — the simulated clock's upper bound. */
    get endMs() {
      const current = table()
      return current ? tableEndSeconds(current) * 1000 : null
    },
    /** False while the low-precision series is standing in. */
    get known() {
      return table() !== null
    },
    /**
     * The assembled table, null before the first slice. The same object until a
     * slice lands or the wall year turns, so the trajectory tool can tell "changed"
     * by identity.
     */
    get assembled() {
      return table()
    },
    /** Moves on anything the tool's panel shows (a request started or ended, a slice landed). */
    get revision() {
      return set.revision
    },
    /** What the tool's panel says about this table: `ready` once a table exists, `error` when the last request failed with none yet. */
    get state() {
      if (table()) return { status: 'ready', error: null }
      if (!set.loading && set.error) return { status: 'error', error: set.error }
      return { status: 'loading', error: null }
    },
  }
}
