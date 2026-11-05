/**
 * The yearly slices of the solar-system tables (lot 3, 2026-11-05).
 *
 * The backend serves each body as one **civil year**, immutable, with two rows of
 * overlap on each side (`/api/solar-system/positions?body=&year=`, backend/API.md).
 * The years kept are Y−1 to Y+4 around the wall-clock year Y — six slices that
 * cover 1 January (Y−1) to 1 January (Y+5), so always [now − 1 year, now + 4 years].
 * This module holds the rules that glue them together and that the eye cannot
 * check: which years, where the clock stops, how six slices become one continuous
 * table, and whether a slice read back from localStorage may be used. Pure — no
 * fetch, no storage, no Three.js (`sliceSet.js` and the owners do the loading).
 *
 * A **table** is what `positionTable.js` reads: `{timeScale, start, stepSeconds,
 * positions}`. A **slice record** is the same plus what is needed to cut it:
 * `{frame, timeScale, year, sliceStart, sliceEnd, start, stepSeconds, positions}`.
 */

import { TIME_SCALE } from '../data/api.js'

/** Years kept before and after the wall-clock year (user's call, 2026-11-05). */
export const YEARS_BACK = 1
export const YEARS_FORWARD = 4

/** Rows of overlap on each side of a slice (same rule as `small-body/precision`). */
export const OVERLAP_ROWS = 2

const DAY_MS = 86_400_000
const DAY_S = 86_400

/** The frame a positions slice must declare, in the backend's own words — see ORBIT_FRAME for why it is not a constant of ours. */
export const POSITIONS_FRAME = 'ICRF geocentric'

/**
 * The frame the orbit route must declare, **in its own words**, for a stored
 * table to be usable.
 *
 * The first version of this guard was a constant the client made up and stamped
 * on whatever it received, and that failed for a reason worth remembering: the
 * route was switched to heliocentric while the *server* cache still held the old
 * geocentric tables for another forty days. A client fetching in that window got
 * geocentric samples and labelled them heliocentric itself — and then drew them
 * as such, which is how the planets ended up ringed by their own retrograde
 * loops instead of their orbits.
 *
 * So the marker has to come from the side that knows. Storing the response's own
 * `frame` string and demanding this exact value rejects all three bad cases at
 * once: tables from before the field existed, tables mislabelled by the old
 * guard (they say 'heliocentric', not 'ICRF heliocentric'), and any future
 * response that changes frame again without anyone thinking of this cache.
 */
export const ORBIT_FRAME = 'ICRF heliocentric'

/**
 * The frame the orientation route must declare, **in its own words**, for a
 * stored record to be used — the same guard, for the same reason, as ORBIT_FRAME:
 * a cache that outlives a change of frame is a wrong picture drawn confidently.
 */
export const ORIENTATION_FRAME = 'ICRF'

/** 1 January 00:00 UTC of a year, Unix seconds. */
export const yearStartSeconds = (year) => Date.UTC(year, 0, 1) / 1000

/** The UTC year of a wall-clock or simulated instant in ms. */
export const yearOfMs = (ms) => new Date(ms).getUTCFullYear()

/**
 * The years the backend serves for a wall-clock instant: Y−1 … Y+4.
 *
 * @returns {{minYear: number, maxYear: number}}
 */
export function yearRange(wallMs) {
  const year = yearOfMs(wallMs)
  return { minYear: year - YEARS_BACK, maxYear: year + YEARS_FORWARD }
}

/**
 * The years of the range in loading order: the current year, then outward. At the
 * same distance the future comes first — the clock reaches four years that way and
 * one year back, so the forward side is the one that needs the head start.
 *
 * @returns {number[]}
 */
export function yearsByDistance(currentYear, { minYear, maxYear }) {
  const years = []
  for (let y = minYear; y <= maxYear; y++) years.push(y)
  return years.sort((a, b) => Math.abs(a - currentYear) - Math.abs(b - currentYear) || b - a)
}

/**
 * The order the solar-system tables are loaded in (contract, 2026-11-05): the
 * Sun's six slices first (every placement is relative to it, and it bounds the
 * clock), then the current year of the Moon and the planets, then their other
 * years moving away from the current one.
 *
 * @param {number} currentYear
 * @param {string[]} bodyIds  the Moon and the planets, in the order they are asked
 * @returns {{body: string, year: number}[]}
 */
export function loadPlan(currentYear, bodyIds, range = { minYear: currentYear - YEARS_BACK, maxYear: currentYear + YEARS_FORWARD }) {
  const years = yearsByDistance(currentYear, range)
  const jobs = years.map((year) => ({ body: 'sun', year }))
  for (const year of years) for (const body of bodyIds) jobs.push({ body, year })
  return jobs
}

/** Failures in a row after which the loading plan stops: the server is down, 45 s a request would only pile up. */
export const MAX_CONSECUTIVE_FAILURES = 3

/**
 * Runs the jobs one after the other (one request at a time: `php -S` on Windows
 * serves a single request at once), `run` answering whether the job succeeded.
 * Stops after MAX_CONSECUTIVE_FAILURES failures in a row — a single bad slice
 * must not hold back the others, a dead server must not be asked a hundred times.
 *
 * @returns {Promise<boolean>} false when it stopped early
 */
export async function runJobs(jobs, run, maxFailures = MAX_CONSECUTIVE_FAILURES) {
  let failures = 0
  for (const job of jobs) {
    if (await run(job)) failures = 0
    else if (++failures >= maxFailures) return false
  }
  return true
}

/**
 * The closest of the loaded years to `year` (the earlier one on a tie), or null
 * when none is loaded. Orientation uses it: a record of another year still turns
 * the body right (the rate is exact), only the pole is a little stale.
 */
export function nearestYear(years, year) {
  let best = null
  for (const y of years) {
    if (best === null || Math.abs(y - year) < Math.abs(best - year) || (Math.abs(y - year) === Math.abs(best - year) && y < best)) best = y
  }
  return best
}

// --- the clock's bounds ----------------------------------------------------------

/**
 * The instants the simulated clock may reach, ms: [wall − 1 year, wall + 4 years]
 * floored to a UTC midnight (so the bounds stay on the same dates for a whole day),
 * then cut to the Sun's assembled table when that is shorter. The same dates as
 * `cursorBounds(wallMs)` of the trajectory tool (tracking/model.js, unchanged): a
 * test pins the equality, so the clock and the cursor cannot drift apart.
 *
 * Real time is exempt from the bounds (clock.js), so a wall clock past the
 * tables still tracks the wall.
 *
 * @param {{startMs: ?number, endMs: ?number}} [coverage]  the Sun's table span, null ends = unknown
 * @returns {{minMs: number, maxMs: number}}
 */
export function clockBounds(wallMs, coverage = null) {
  const at = (years) => {
    const d = new Date(wallMs)
    d.setUTCFullYear(d.getUTCFullYear() + years)
    return Math.floor(d.getTime() / DAY_MS) * DAY_MS
  }
  let minMs = at(-YEARS_BACK)
  let maxMs = at(YEARS_FORWARD)
  if (coverage) {
    if (coverage.startMs !== null && coverage.startMs !== undefined) minMs = Math.max(minMs, coverage.startMs)
    if (coverage.endMs !== null && coverage.endMs !== undefined) maxMs = Math.min(maxMs, coverage.endMs)
  }
  return { minMs, maxMs: Math.max(minMs, maxMs) }
}

// --- positions: validation and assembly ---------------------------------------------

/** A step the slices can be cut on: whole seconds, dividing the day (6 h, 1 d…). */
const validStep = (step) => Number.isInteger(step) && step > 0 && step <= DAY_S && DAY_S % step === 0

const validRow = (row) => Array.isArray(row) && row.length === 3 && row.every(Number.isFinite)

const inRange = (year, range) => Number.isInteger(year) && year >= range.minYear && year <= range.maxYear

/**
 * A slice record from a `/api/solar-system/positions?year=` answer, **before**
 * validation. `positions` is `[]` when Horizons gave nothing (null), which the
 * validator refuses.
 */
export function positionsSliceFromResponse(res, id) {
  const served = res.bodies?.find((body) => body.id === id) ?? res.bodies?.[0]
  return {
    frame: res.frame,
    timeScale: res.time_scale,
    year: res.year,
    sliceStart: res.slice_start,
    sliceEnd: res.slice_end,
    start: res.start,
    stepSeconds: res.step_seconds,
    radiusKm: served?.radius_km,
    equatorialKm: served?.equatorial_radius_km,
    polarKm: served?.polar_radius_km,
    positions: served?.positions ?? [],
  }
}

/**
 * Whether a positions slice (served, or read back from localStorage) may be used
 * for `year`. Everything that makes one wrong without looking wrong is checked:
 *
 * - the clock (`time_scale`): a TDB slice runs 69 s late, ~2 000 km on a planet;
 * - the frame, in the backend's own words (see ORBIT_FRAME);
 * - the year, which must be the one asked for **and** inside the range around
 *   the wall clock — a slice left over from last year is out of it;
 * - the step, and that the rows are exactly those the contract promises:
 *   `start = slice_start − 2 steps`, `slice_start`/`slice_end` the 1 Januaries,
 *   `span / step + 5` rows (two of overlap each side, both ends included) — a
 *   slice a row short would misplace everything after it once assembled.
 *
 * @param {{minYear: number, maxYear: number}} range
 */
export function validPositionsSlice(record, year, range) {
  if (!record || typeof record !== 'object') return false
  if (!inRange(year, range) || record.year !== year) return false
  if (record.frame !== POSITIONS_FRAME || record.timeScale !== TIME_SCALE) return false
  const step = record.stepSeconds
  if (!validStep(step)) return false
  if (record.sliceStart !== yearStartSeconds(year) || record.sliceEnd !== yearStartSeconds(year + 1)) return false
  if (record.start !== record.sliceStart - OVERLAP_ROWS * step) return false
  const rows = (record.sliceEnd - record.sliceStart) / step + 2 * OVERLAP_ROWS + 1
  return Array.isArray(record.positions) && record.positions.length === rows && record.positions.every(validRow)
}

/**
 * The slices of one body as **one continuous table**: only the run of
 * consecutive years that contains `currentYear` (a missing year cuts the
 * coverage — rows across a hole would be interpolated through nothing), each
 * slice cut at the `slice_start` / `slice_end` it was served with, the overlap
 * between neighbours dropped and the overlap at the two **outer** ends kept (it
 * is what gives the first and last day their full Catmull-Rom neighbourhood). The
 * result is, row for row, the table Horizons would have served in one piece.
 *
 * A slice on another clock or step than the current year's is a different table:
 * it ends the run like a hole.
 *
 * @param {Map<number, object>|Record<number, object>} slices  valid slice records by year
 * @returns {{timeScale: string, start: number, stepSeconds: number, positions: number[][], firstYear: number, lastYear: number} | null}
 */
export function assembleSlices(slices, currentYear) {
  const get = slices instanceof Map ? (y) => slices.get(y) : (y) => slices[y]
  const anchor = get(currentYear)
  if (!anchor) return null
  const compatible = (record) => record && record.timeScale === anchor.timeScale && record.stepSeconds === anchor.stepSeconds
  let first = currentYear
  let last = currentYear
  while (compatible(get(first - 1))) first--
  while (compatible(get(last + 1))) last++

  const positions = []
  for (let year = first; year <= last; year++) {
    const record = get(year)
    const from = year === first ? 0 : (record.sliceStart - record.start) / record.stepSeconds
    const to = year === last ? record.positions.length : (record.sliceEnd - record.start) / record.stepSeconds
    for (let i = from; i < to; i++) positions.push(record.positions[i])
  }
  const head = get(first)
  return { timeScale: head.timeScale, start: head.start, stepSeconds: head.stepSeconds, positions, firstYear: first, lastYear: last }
}

// --- orbits and orientation -----------------------------------------------------------

/** An orbit record from a `/api/solar-system/orbit?year=` answer, before validation. */
export function orbitFromResponse(res) {
  return { frame: res.frame, timeScale: res.time_scale, year: res.year, start: res.start, stop: res.stop, positions: res.positions ?? [] }
}

/**
 * Whether an orbit record may be drawn for `year`. Not "does it bracket now" any
 * more (it did, until 2026-11-05, with an orbit anchored on the month): an orbit
 * is the period from 1 January of its year, and the planet is on it throughout
 * that year (measured: ≤ 1 425 km for Venus, 993 Mercury, 311 Jupiter).
 *
 * @param {{minYear: number, maxYear: number}} range
 */
export function validOrbit(record, year, range) {
  if (!record || typeof record !== 'object') return false
  if (!inRange(year, range) || record.year !== year) return false
  // Drawing a geocentric table as heliocentric rings the Earth's position
  // instead of the Sun's, and the retrograde loops look deliberate. Rejecting a
  // wrong or missing frame costs one refetch and self-heals, where renaming the
  // cache key would have orphaned the old data for good.
  if (record.frame !== ORBIT_FRAME || record.timeScale !== TIME_SCALE) return false
  if (record.start !== yearStartSeconds(year)) return false
  return Array.isArray(record.positions) && record.positions.length > 2 && record.positions.every(validRow)
}

/** An orientation record from a `/api/solar-system/orientation?year=` answer, or null when Horizons gave no pole. */
export function orientationFromResponse(res, id) {
  const served = res.bodies?.find((body) => body.id === id) ?? res.bodies?.[0]
  if (!served?.pole || !served?.prime_meridian) return null
  return {
    frame: res.frame,
    year: res.year,
    epoch: res.epoch,
    pole: served.pole,
    primeMeridian: served.prime_meridian,
    rateDegPerDay: served.rotation_deg_per_day,
  }
}

/**
 * Whether a stored orientation may be used for `year`. The epoch must be that
 * year's 1 January (the route's anchor); the null guards are not paranoia: all
 * three fields come back null together when Horizons did not answer, and a null
 * rate turns the phase into NaN — which is not a body pointing the wrong way, it
 * is a body that disappears.
 *
 * @param {{minYear: number, maxYear: number}} range
 */
export function validOrientation(record, year, range) {
  return (
    !!record &&
    typeof record === 'object' &&
    inRange(year, range) &&
    record.year === year &&
    record.frame === ORIENTATION_FRAME &&
    record.epoch === yearStartSeconds(year) &&
    Array.isArray(record.pole) &&
    record.pole.length === 3 &&
    record.pole.every(Number.isFinite) &&
    Array.isArray(record.primeMeridian) &&
    record.primeMeridian.length === 3 &&
    record.primeMeridian.every(Number.isFinite) &&
    Number.isFinite(record.rateDegPerDay)
  )
}

// --- localStorage keys -------------------------------------------------------------------

/** One key per body × year (cache.js adds its `nasa-viz:` prefix). */
export const positionsKey = (id, year) => `positions-${id}-${year}`
export const orbitKey = (id, year) => `orbit-${id}-${year}`
export const orientationKey = (id, year) => `orientation-${id}-${year}`

const SLICE_KEY = /^(positions|orbit|orientation)-([a-z]+)-(\d{4})$/

/**
 * The single-record keys the viewer wrote before the slices: one entry holding
 * every planet (`solar-system`…), or the Sun's / the Moon's whole table. They are
 * never read again and weigh up to a megabyte each.
 */
export const LEGACY_KEYS = Object.freeze(['solar-system', 'solar-system-orbits', 'solar-system-orientation', 'sun', 'moon'])

/**
 * What to delete from the stored keys at start-up: the legacy keys, and the
 * slices (of any kind) whose year left the range around the wall clock. A key
 * that is none of those is not ours to touch.
 *
 * @param {string[]} keys  without the prefix
 * @returns {string[]}
 */
export function staleKeys(keys, wallMs) {
  const { minYear, maxYear } = yearRange(wallMs)
  return keys.filter((key) => {
    if (LEGACY_KEYS.includes(key)) return true
    const match = SLICE_KEY.exec(key)
    if (!match) return false
    const year = Number(match[3])
    return year < minYear || year > maxYear
  })
}
