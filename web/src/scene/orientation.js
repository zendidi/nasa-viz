/**
 * How each body is turned: fetching `/api/solar-system/orientation`, caching it,
 * and writing the result into a mesh's quaternion.
 *
 * A module-level cache rather than a factory, like `loadColorMap` in bodies.js
 * and for the same reason: two unrelated owners need the same records. The seven
 * planets belong to `scene/planets.js`, the Moon to `main.js`, and neither
 * should carry its own copy of the epoch rule below.
 */

import * as THREE from 'three'
import { fetchSolarSystemOrientation } from '../api.js'
import { loadCached, saveCached } from '../cache.js'
import { icrfToScene, setBodyOrientation } from './geo.js'

const CACHE_KEY = 'solar-system-orientation'

/**
 * The frame the route must declare, **in its own words**, for a stored record to
 * be used — the same guard, for the same reason, as `ORBIT_FRAME` in planets.js:
 * a cache that outlives a change of frame is a wrong picture drawn confidently.
 */
const ORIENTATION_FRAME = 'ICRF'

/**
 * First of the current UTC month, in seconds — the route's own anchor (`SolarSystemClient::windowStart`).
 *
 * Wall clock on purpose, even under the simulated clock: this picks which
 * record is *fetched and cached*, and the route only serves the real current
 * month. `orientBody` then propagates that record to whatever date the scene
 * shows (rate × elapsed days), which stays exact for a rigid body; only the
 * pole is held fixed, and it moves far too slowly to show within a year.
 */
function currentEpochSeconds() {
  const now = new Date()
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000
}

/**
 * Whether a stored orientation is still the current one.
 *
 * The test is the epoch, not an age: the route anchors on the first of the UTC
 * month and holds the pole fixed across it, so a record from last month is a
 * pole that was never refreshed — while the phase it carries would go on
 * propagating happily and silently. A month-old epoch is therefore stale by
 * construction, and an epoch from *this* month stays exact however long the tab
 * has been open, since a rigid body turns at a constant rate about a fixed axis.
 *
 * The null guards are not paranoia: all three fields come back null together
 * when Horizons did not answer, and a null rate turns the phase into NaN — which
 * is not a body pointing the wrong way, it is a body that disappears.
 */
function covers(record, epochNow) {
  return (
    record?.frame === ORIENTATION_FRAME &&
    record?.epoch === epochNow &&
    Array.isArray(record.pole) &&
    Array.isArray(record.primeMeridian) &&
    Number.isFinite(record.rateDegPerDay)
  )
}

/** @type {Record<string, {frame: string, epoch: number, pole: number[], primeMeridian: number[], rateDegPerDay: number}>} */
const records = {}
for (const [id, record] of Object.entries(loadCached(CACHE_KEY)?.data ?? {})) {
  if (covers(record, currentEpochSeconds())) records[id] = record
}

/** Bodies fetched or in flight, so a second visit doesn't re-ask. */
const asked = new Set()

/**
 * Fetches how one body is turned, once.
 *
 * Cheap to be wrong about: a body with no record keeps the identity rotation,
 * which puts its north on the scene's +Y. That is the *celestial* pole, not the
 * body's, so it is wrong for everyone except the Earth — whose axis really is
 * +Y, the scene being equatorial.
 */
export function loadOrientationFor(id) {
  if (asked.has(id) || records[id]) return
  asked.add(id)
  fetchSolarSystemOrientation(id)
    .then((res) => {
      const served = res.bodies[0]
      if (!served?.pole || !served?.prime_meridian) return
      const record = {
        frame: res.frame,
        epoch: res.epoch,
        pole: served.pole,
        primeMeridian: served.prime_meridian,
        rateDegPerDay: served.rotation_deg_per_day,
      }
      if (!covers(record, currentEpochSeconds())) return
      records[id] = record
      saveCached(CACHE_KEY, records)
      // No redraw is announced: this changes nothing any panel says, and the
      // render loop is a plain rAF, so the body turns on the next frame.
    })
    .catch(() => {
      // Dropped from the set so the next call tries again. An unoriented body is
      // the state the scene shipped with, so this costs detail and nothing else.
      asked.delete(id)
    })
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
  const record = records[id]
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
  const record = records[id]
  if (!record) return null
  return icrfToScene(record.pole[0], record.pole[1], record.pole[2], out).normalize()
}
