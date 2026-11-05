/**
 * The point of view: which body the scene is centred on, and how anything known
 * in km lands in scene units from there.
 *
 * The pivot IS the scene's origin: nothing is drawn at an absolute position,
 * everything goes through placeKm() below. Switching pivot therefore only
 * changes two things — which position is subtracted, and which readable curve
 * compresses what's left (docs/points-de-vue.md).
 *
 * One object, handed whole to every module that places something (planets,
 * moons, NEOs, tracked objects, orbit traces), instead of the five or six loose
 * closures each used to take. main.js owns it and is the only caller of `set`.
 */

import * as THREE from 'three'
import { FOCUSES, hidesPlanets } from '../view/focus.js'
import { EARTH_RADIUS, pivotRadius, sceneDistance, sunRadius } from '../view/scale.js'

/** The Earth, in the geocentric km every body position is expressed in. */
export const EARTH_POSITION_KM = new THREE.Vector3(0, 0, 0)

/**
 * @typedef {{id: string, radiusKm: number, positionKm: THREE.Vector3}} FocusPlanet
 *
 * @typedef {{
 *   readonly id: string,
 *   readonly focus: object,
 *   readonly planet: FocusPlanet | null,
 *   set: (id: string, planet: FocusPlanet | null) => void,
 *   positionKm: () => THREE.Vector3,
 *   setEarthOffsetKm: (offsetKm: THREE.Vector3 | null) => void,
 *   radius: (t: number) => number,
 *   geocentric: () => boolean,
 *   hidesPlanets: () => boolean,
 *   placeKm: (out: THREE.Vector3, geocentricKm: THREE.Vector3, t: number) => THREE.Vector3,
 *   placeRelativeKm: (out: THREE.Vector3, relativeKm: THREE.Vector3, t: number) => THREE.Vector3,
 *   placeHeliocentricKm: (out: THREE.Vector3, heliocentricKm: THREE.Vector3, t: number) => THREE.Vector3,
 * }} ViewFrame
 */

/**
 * @param {object} options
 * @param {THREE.Vector3} options.sunPositionKm  live geocentric Sun, mutated in
 *   place by main.js — held by reference, so a Sun pivot and every heliocentric
 *   placement follow it with no hand-off
 * @returns {ViewFrame}
 */
export function createViewFrame({ sunPositionKm }) {
  let id = 'earth'

  /**
   * The planet's own record when a planet is the pivot, null otherwise. Resolved
   * once on the switch rather than looked up per placement: `placeKm` runs for
   * every NEO and every body, dozens of times a frame.
   *
   * It is also the guard. `setFocus` only assigns it once the planet's Horizons
   * table has landed, so anything reading it can trust `positionKm`.
   *
   * @type {FocusPlanet | null}
   */
  let planet = null

  /**
   * Where the Earth pivot's origin is, in the geocentric km every body position
   * is expressed in (2026-11-05). Zero — and then `EARTH_POSITION_KM` itself, so
   * nothing changes by even a bit — except while the tracking tool's cursor is
   * away from the scene's time: the view then follows the Earth *at the cursor's
   * instant* (the "ghost Earth", tracking/scene.js), because a flyby at 38 000 km
   * of that Earth would otherwise happen far off the camera's target.
   * Set by the owner of the cursor, every frame, before anything is placed.
   */
  const earthOffsetKm = new THREE.Vector3()
  let earthShifted = false

  const positionKm = () => {
    if (planet) return planet.positionKm
    if (id === 'sun') return sunPositionKm
    return earthShifted ? earthOffsetKm : EARTH_POSITION_KM
  }

  /**
   * The pivot's own radius in scene units — what the camera must not enter.
   * `pivotRadius` covers all three cases by construction (see scale.js); the Earth
   * branch stays written out because EARTH_RADIUS is the anchor the others are
   * defined against, and reading it as a constant here is the clearer statement.
   */
  const radius = (t) => {
    if (planet) return pivotRadius(planet.radiusKm, t)
    return id === 'sun' ? sunRadius(t, true) : EARTH_RADIUS
  }

  const placeRelative = new THREE.Vector3()

  /** Scene position of a body known by its geocentric km vector, at scale t. */
  function placeKm(out, geocentricKm, t) {
    placeRelative.subVectors(geocentricKm, positionKm())
    const distanceKm = placeRelative.length()
    if (distanceKm < 1e-6) return out.set(0, 0, 0)
    return out.copy(placeRelative).multiplyScalar(sceneDistance(distanceKm, t, FOCUSES[id].curve) / distanceKm)
  }

  /** Same, for a sample already expressed relative to the pivot (orbit traces). */
  function placeRelativeKm(out, relativeKm, t) {
    const distanceKm = relativeKm.length()
    if (distanceKm < 1e-6) return out.set(0, 0, 0)
    return out.copy(relativeKm).multiplyScalar(sceneDistance(distanceKm, t, FOCUSES[id].curve) / distanceKm)
  }

  const placeHeliocentric = new THREE.Vector3()

  /**
   * Same, for a sample expressed relative to the **Sun** — orbital elements and
   * the backend's orbit tables both come that way.
   *
   * It is `placeKm` with one addition, and that is the whole trick: adding the
   * live geocentric Sun turns a heliocentric sample into a geocentric one, which
   * is the frame every body position in this scene already speaks. The pivot's
   * own subtraction then happens once, inside `placeKm`, instead of being
   * re-derived per caller.
   *
   * What it buys: a heliocentric orbit used to be readable only from the Sun,
   * where "relative to the pivot" and "relative to the Sun" are the same vector.
   * Drawn from the Earth it ringed the Earth, from Mars it ringed Mars — which is
   * why the planets' orbits were simply hidden anywhere but the Sun
   * (docs/agent/backlog.md, `orbite-planete-centree-pivot`). Now they are right
   * from every pivot.
   *
   * Note what is *not* subtracted: the pivot's position at each sample's own
   * date. Taking the current one translates the whole orbit rigidly, which is the
   * intended picture — where that orbit lies relative to us now. Subtracting a
   * moving pivot would draw the relative motion instead, i.e. the retrograde
   * rosettes that the 2026-09-29 cache bug accidentally put on screen.
   */
  function placeHeliocentricKm(out, heliocentricKm, t) {
    placeHeliocentric.addVectors(heliocentricKm, sunPositionKm)
    return placeKm(out, placeHeliocentric, t)
  }

  return {
    get id() {
      return id
    },
    /** The pivot's entry in FOCUSES: its curve, rings and frame label. */
    get focus() {
      return FOCUSES[id]
    },
    get planet() {
      return planet
    },
    set(nextId, nextPlanet) {
      id = nextId
      planet = nextPlanet
    },
    positionKm,
    /** `null` (or a zero shift) puts the Earth pivot back on the Earth; a vector moves its origin there (geocentric km, scene axes). */
    setEarthOffsetKm(offsetKm) {
      earthShifted = offsetKm !== null && offsetKm.lengthSq() > 0
      if (earthShifted) earthOffsetKm.copy(offsetKm)
    },
    radius,
    /** Whether the pivot is the Earth (or the Moon): where geocentric drawings make sense. */
    geocentric: () => id === 'earth' || id === 'moon',
    // Every pivot but the Sun hides the *other* planets and the planetary orbit
    // lines below 100 % reel (2026-10-16; Earth since 2026-09-29). The pivot planet
    // itself stays drawn: planets.js exempts it.
    hidesPlanets: () => hidesPlanets(id),
    placeKm,
    placeRelativeKm,
    placeHeliocentricKm,
  }
}
