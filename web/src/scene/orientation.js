/**
 * How each body is turned: fetching `/api/solar-system/orientation`, caching it,
 * and writing the result into a mesh's quaternion.
 *
 * A module-level cache rather than a factory, like `loadColorMap` in bodies.js
 * and for the same reason: two unrelated owners need the same records. The seven
 * planets belong to `scene/planets.js`, the Moon to `main.js`, and neither
 * should carry its own copy of the epoch rule below.
 *
 * Since 2026-11-05 (lot 3) a record is **one body × one civil year**, its epoch
 * the 1st of January of that year (it was the 1st of the current month, which
 * only ever served the real current month). The body is turned with the record
 * of the **simulated clock's year**, fetched when the clock changes year; until it
 * lands, the loaded year nearest to it serves — a rigid body's rate is exact, only
 * the pole of a record a few years away is a little stale (measured, backend
 * contract: the Moon's pole 0,54° over a year, the planets' ≤ 0,02°; the jump
 * when one record gives way to the next is ≈ 0,5° for the Moon, ≤ 0,005° for a
 * planet).
 */

import * as THREE from 'three'
import { fetchSolarSystemOrientation } from '../data/api.js'
import { loadCached, saveCached } from '../data/cache.js'
import { nearestYear, orientationFromResponse, orientationKey, validOrientation, yearOfMs, yearRange } from '../ephemeris/slices.js'
import { icrfToScene, setBodyOrientation } from './geo.js'

/** A request that failed is asked again after this long, if the clock is still in that year. */
const RETRY_MS = 60_000

/**
 * Loaded records by body, then by year.
 * @type {Map<string, Map<number, {frame: string, year: number, epoch: number, pole: number[], primeMeridian: number[], rateDegPerDay: number}>>}
 */
const buckets = new Map()

/** Bodies whose orientation was asked for (`loadOrientationFor`): only those follow the clock's year with a fetch. */
const wanted = new Set()

/** body:year → when the request failed (a number) or `0` while it is in flight. */
const requests = new Map()

/** The simulated year `orientBody` last saw — what `poleOf`, which has no date, answers for. */
let lastSimYear = yearOfMs(Date.now())

/**
 * One body's records, the cached ones read on first sight (best-effort, once per
 * body): a planet drawn from the cache needs its orientation without being
 * centred on.
 */
function bucketOf(id) {
  let bucket = buckets.get(id)
  if (!bucket) {
    bucket = new Map()
    buckets.set(id, bucket)
    const range = yearRange(Date.now())
    for (let year = range.minYear; year <= range.maxYear; year++) {
      const stored = loadCached(orientationKey(id, year))?.data
      if (validOrientation(stored, year, range)) bucket.set(year, stored)
    }
  }
  return bucket
}

/** The record of the loaded year nearest to `year`, or undefined. */
function recordFor(id, year) {
  const bucket = bucketOf(id)
  const nearest = nearestYear(bucket.keys(), year)
  return nearest === null ? undefined : bucket.get(nearest)
}

// One request at a time, like every Horizons load here: when the clock crosses a
// 1 January every body asked for needs a new record at once.
let chain = Promise.resolve()

function requestYear(id, year) {
  const range = yearRange(Date.now())
  const wantedYear = Math.min(range.maxYear, Math.max(range.minYear, year))
  if (bucketOf(id).has(wantedYear)) return
  const key = `${id}:${wantedYear}`
  const failedAt = requests.get(key)
  if (failedAt === 0 || (failedAt !== undefined && Date.now() - failedAt < RETRY_MS)) return
  requests.set(key, 0)
  chain = chain.then(async () => {
    try {
      const res = await fetchSolarSystemOrientation(id, wantedYear)
      const record = orientationFromResponse(res, id)
      if (!record || !validOrientation(record, wantedYear, yearRange(Date.now()))) throw new Error('orientation refusée')
      bucketOf(id).set(wantedYear, record)
      saveCached(orientationKey(id, wantedYear), record)
      requests.delete(key)
      // No redraw is announced: this changes nothing any panel says, and the
      // render loop is a plain rAF, so the body turns on the next frame.
    } catch {
      // Remembered with its date so the per-frame check above does not ask again
      // at once. An unoriented body is the state the scene shipped with, so this
      // costs detail and nothing else.
      requests.set(key, Date.now())
    }
  })
}

/**
 * Asks for how one body is turned, for the clock's year, and keeps following the
 * clock's year from now on (`orientBody` fetches the next year's record when the
 * clock crosses a 1 January).
 *
 * Cheap to be wrong about: a body with no record keeps the identity rotation,
 * which puts its north on the scene's +Y. That is the *celestial* pole, not the
 * body's, so it is wrong for everyone except the Earth — whose axis really is
 * +Y, the scene being equatorial.
 */
export function loadOrientationFor(id) {
  wanted.add(id)
  requestYear(id, lastSimYear)
}

const poleScene = new THREE.Vector3()
const meridianScene = new THREE.Vector3()

/**
 * Points a body's north at its pole and its prime meridian where it is now, and
 * says whether it could: `prime_meridian` is where longitude 0 pointed at
 * `epoch`, so the phase is the rate times the elapsed days, turned about the
 * pole.
 *
 * The rate's sign carries the direction — negative for Venus and Uranus — which
 * is exactly why `applyAxisAngle` is given it unmodified. The rotation is
 * propagated rather than sampled because it has to be: Jupiter turns 2,4 times
 * between two daily samples, so no table could ever carry this.
 */
export function orientBody(quaternion, id, nowSeconds) {
  const simYear = yearOfMs(nowSeconds * 1000)
  lastSimYear = simYear
  if (wanted.has(id)) requestYear(id, simYear)
  const record = recordFor(id, simYear)
  if (!record) return false
  icrfToScene(record.pole[0], record.pole[1], record.pole[2], poleScene).normalize()
  icrfToScene(record.primeMeridian[0], record.primeMeridian[1], record.primeMeridian[2], meridianScene)
  const days = (nowSeconds - record.epoch) / 86_400
  meridianScene.applyAxisAngle(poleScene, THREE.MathUtils.degToRad(record.rateDegPerDay * days))
  setBodyOrientation(quaternion, poleScene, meridianScene)
  return true
}

/**
 * A body's north pole in scene axes (unit vector), or null while its record has
 * not landed. Exists for the moons that are locked to their planet and so take
 * the planet's pole (Charon, orbiting in Pluto's equator): the pole is the one
 * thing they need from this module, the rest being computed from their position.
 */
export function poleOf(id, out) {
  const record = recordFor(id, lastSimYear)
  if (!record) return null
  return icrfToScene(record.pole[0], record.pole[1], record.pole[2], out).normalize()
}
