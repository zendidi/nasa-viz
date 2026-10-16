/**
 * Where the Sun is, from JPL Horizons rather than from a series.
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
import { fetchSolarSystemBody } from './api.js'
import { loadCached, saveCached } from './cache.js'
import { sampleCatmullRom, subdivideTable } from './interpolate.js'
import { getSunEquatorial } from './astronomy.js'
import { icrfToScene, latLngToVector3 } from './scene/geo.js'

/** Refetched once "now" comes within this of the table's end — same rule as the planets'. */
/** Curve points per daily sample in the Earth's orbit line — same factor as the planets' orbits. */
const ORBIT_SMOOTHING = 8

const TABLE_MARGIN_MS = 30 * 86_400_000

function covers(record, marginMs = 0) {
  if (!record?.positions?.length) return false
  // Wall clock on purpose: this decides whether a *cached* table is still worth
  // keeping, a fact about the real world — not about the simulated date.
  const nowMs = Date.now()
  const endMs = (record.start + (record.positions.length - 1) * record.stepSeconds) * 1000
  return nowMs >= record.start * 1000 && nowMs < endMs - marginMs
}

/**
 * @param {{changed: Function}} on  fired when the table lands, so the caller can
 *   redraw anything it derived from the fallback Sun
 */
export function createSunTable({ on }) {
  const stored = loadCached('sun')?.data ?? null
  /** @type {{start: number, stepSeconds: number, positions: number[][]} | null} */
  let table = covers(stored, TABLE_MARGIN_MS) ? stored : null
  let loading = false

  const interpKm = [0, 0, 0]

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
      const f = (date.getTime() / 1000 - table.start) / table.stepSeconds
      if (f >= 0 && f <= table.positions.length - 1) {
        sampleCatmullRom(table.positions, f, interpKm)
        return icrfToScene(interpKm[0], interpKm[1], interpKm[2], out)
      }
    }
    const { ra, dec, distanceKm } = getSunEquatorial(date)
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
  function earthOrbitSamplesKm() {
    if (!table) return null
    return subdivideTable(table.positions, ORBIT_SMOOTHING).map(([x, y, z]) => icrfToScene(x, y, z, new THREE.Vector3()).negate())
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
      const res = await fetchSolarSystemBody('sun')
      const served = res.bodies[0]
      const record = { start: res.start, stepSeconds: res.step_seconds, positions: served.positions ?? [] }
      if (covers(record, TABLE_MARGIN_MS)) {
        table = record
        saveCached('sun', record)
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
    /** End of the loaded window in ms (the last sample), null without a table — the simulated clock's upper bound. */
    get endMs() {
      return table ? (table.start + (table.positions.length - 1) * table.stepSeconds) * 1000 : null
    },
    /** False while the low-precision series is standing in. */
    get known() {
      return table !== null
    },
  }
}
