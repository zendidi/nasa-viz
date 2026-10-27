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
 */

import * as THREE from 'three'
import { fetchSolarSystemBody } from '../data/api.js'
import { loadCached, saveCached } from '../data/cache.js'
import { subdivideTable } from './interpolate.js'
import { getMoonEquatorial, getSunEquatorial } from './astronomy.js'
import { icrfToScene, latLngToVector3 } from '../scene/geo.js'
import { ORBIT_SMOOTHING, TABLE_MARGIN_MS, sampleKm, tableCovers, tableEndSeconds, tableIndexAt } from './positionTable.js'

// Refetched once "now" comes within TABLE_MARGIN_MS of the table's end — same rule as the planets'.
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

function covers(record) {
  // Wall clock on purpose: this decides whether a *cached* table is still worth
  // keeping, a fact about the real world — not about the simulated date.
  // A table that starts later than HISTORY_MONTHS back is one stored before
  // the history existed (2026-10-27): still valid going forward, but it would
  // stop the clock at the 1st of the month going back. Refetched once.
  return tableCovers(record, Date.now(), { history: true, marginMs: TABLE_MARGIN_MS })
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
  const stored = loadCached(body)?.data ?? null
  /** @type {{start: number, stepSeconds: number, positions: number[][]} | null} */
  let table = covers(stored) ? stored : null
  let loading = false

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
    if (table) {
      const f = tableIndexAt(table, date.getTime() / 1000)
      if (f >= 0 && f <= table.positions.length - 1) return sampleKm(table.positions, f, out)
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
    if (!table) return null
    // One sidereal year centred on the simulated instant, not the whole ~15-month
    // window, which would draw ~3 months twice.
    const { from, to } = orbitWindowIndices(table.start, table.stepSeconds, table.positions.length, centerMs)
    return subdivideTable(table.positions.slice(from, to + 1), ORBIT_SMOOTHING).map(([x, y, z]) => icrfToScene(x, y, z, new THREE.Vector3()).negate())
  }

  /**
   * Cache-first like the planets, and for the same reason: this is keyless JPL,
   * so it is not thrift — a year of daily Sun positions has nothing to refresh
   * until it nears its end.
   */
  async function load() {
    if (table || loading) return
    loading = true
    try {
      const res = await fetchSolarSystemBody(body)
      const served = res.bodies[0]
      const record = { timeScale: res.time_scale, start: res.start, stepSeconds: res.step_seconds, positions: served.positions ?? [] }
      if (covers(record)) {
        table = record
        saveCached(body, record)
        on.changed()
      }
    } catch {
      // The series carries the scene meanwhile; retried on the next page load.
    }
    loading = false
  }

  return {
    positionKmAt,
    earthOrbitSamplesKm,
    load,
    /** Start of the loaded window in ms (the first sample), null without a table — the simulated clock's lower bound. */
    get startMs() {
      return table ? table.start * 1000 : null
    },
    /** End of the loaded window in ms (the last sample), null without a table — the simulated clock's upper bound. */
    get endMs() {
      return table ? tableEndSeconds(table) * 1000 : null
    },
    /** False while the low-precision series is standing in. */
    get known() {
      return table !== null
    },
  }
}
