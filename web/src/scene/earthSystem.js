/**
 * The Earth, the Moon and the ISS as drawn, and the two orbit lines the scene
 * draws for itself (the Earth's, the Moon's). One module because they are one
 * system on screen: all three share `earthSystemScale`, the ISS is a child of
 * the globe, and the Moon's line only exists from the Earth's view.
 *
 * Where the Sun and the Moon are comes from main.js's astronomy
 * (`moonPositionKm` by reference, the two tables for the orbit samples); this
 * module places, sizes, orients and labels from it.
 */

import * as THREE from 'three'
import { getEarthPoleJ2000, getEarthRotationAngle } from '../ephemeris/astronomy.js'
import { issAt } from '../ephemeris/iss.js'
import { LABEL_WHEN_SMALLER_THAN_PX } from './labels.js'
import { EARTH_RADIUS, ISS_READABLE_RADIUS, earthSystemScale, issOrbitRadius, issRadius } from '../view/scale.js'
import { MOON_RADIUS, cloudDriftAt, makeGlobe, makeIssMarker, makeMoon } from './bodies.js'
import { EARTH_POSITION_KM } from './frame.js'
import { icrfToScene, latLngToVector3 } from './geo.js'
import { orientBody } from './orientation.js'

// Floor on each body's on-screen radius, in pixels — at true scale almost
// everything is sub-pixel (the whole Earth–Moon system is ~5 px when framing a
// NEO at 0.5 au), so without these nothing would show at all.
// (The Sun's: scene/sun.js, SUN_MIN_RADIUS_PX.)
const MIN_RADIUS_PX = { earth: 2, moon: 1.5, iss: 2.5 }

// --- orbits of the bodies the scene places itself (Moon, Earth) -----------------
//
// Drawn from the very series that places the body, never from a neighbouring
// model: a line that doesn't pass through its own body is worse than no line.
// The fixed 384 400 km reference circle used to miss the Moon by 1 scene unit
// (it ignores both the 5 % apogee/perigee swing and the orbit's 5° tilt to the
// ecliptic), and the Earth's Kepler ellipse misses the globe by ~945 000 km.
// Sampling starts at "now", so sample 0 *is* the body — the trace goes through
// it by construction, at every scale and in both views.

const MOON_ORBIT_DAYS = 27.321582 // sidereal month
const MOON_ORBIT_SAMPLES = 96
const EARTH_ORBIT_DAYS = 365.256
const EARTH_ORBIT_SAMPLES = 180
const DAY_MS = 86_400_000

function sampleBodyOrbit(startMs, count, days, positionAt) {
  return Array.from({ length: count + 1 }, (_, i) =>
    positionAt(new Date(startMs + (i / count) * days * DAY_MS)),
  )
}

const SCENE_UP = new THREE.Vector3(0, 1, 0)

/**
 * @param {object} options
 * @param {THREE.Scene} options.scene
 * @param {import('./frame.js').ViewFrame} options.frame
 * @param {object} options.traces  scene/orbitTrace.js
 * @param {object} options.labels  labels.js
 * @param {(worldPos: THREE.Vector3, px: number) => number} options.minRadiusAt
 * @param {object} options.sunTable  sunTable.js — the Earth's orbit samples
 * @param {object} options.moonTable  sunTable.js — the Moon's orbit samples
 * @param {THREE.Vector3} options.moonPositionKm  live geocentric Moon, mutated in place by main.js
 */
export function createEarthSystem({ scene, frame, traces, labels, minRadiusAt, sunTable, moonTable, moonPositionKm }) {
  const { group: globe, material: globeMaterial, sphere: globeSphere, clouds: globeClouds } = makeGlobe()
  scene.add(globe)

  // Child of globe (not scene) so it turns with the real Earth rotation set in
  // animate() — its position is computed in the globe's own unrotated
  // lat/lng frame, same as the texture, so it always sits over the right spot.
  const issMarker = makeIssMarker()
  issMarker.visible = false // until a position is known
  globe.add(issMarker)

  const moon = makeMoon()
  scene.add(moon)

  // Straight in the scene, not in a group: the Earth's orbit is the heliocentric
  // view's own yardstick (and its 1 au circle), worth drawing even with nothing
  // selected. Each declares its own frame — the Earth's samples are heliocentric
  // (the Sun table, negated), the Moon's are geocentric like every body position.
  const earthOrbitTrace = traces.make(0x4fa8ff, 0.5, { parent: scene, frame: 'heliocentric' })
  const moonOrbitTrace = traces.make(0x8ea3b8, 0.5, { parent: scene, frame: 'geocentric' })

  const labelEls = {
    earth: labels.create('Terre'),
    moon: labels.create('Lune'),
    iss: labels.create('ISS'),
    moonOrbit: labels.create('orbite lunaire', 'ring'),
  }

  let issPosition = null

  const earthPole = new THREE.Vector3()
  const earthTilt = new THREE.Quaternion()
  const earthSpin = new THREE.Quaternion()
  const tmpWorldPos = new THREE.Vector3()
  const issLabelPos = new THREE.Vector3()
  const moonOrbitLabelPos = new THREE.Vector3()

  /** The Earth's drawn radius in world units — system scale and pixel floor included. */
  function earthWorldRadius() {
    return EARTH_RADIUS * globe.scale.x * globeSphere.scale.x
  }

  const moonWorldRadius = () => MOON_RADIUS * moon.scale.x

  /** @param {number} startMs simulated time the samples start from — sample 0 is the body "now" */
  function rebuildOrbits(startMs, { earth = true } = {}) {
    traces.setKm(
      moonOrbitTrace,
      sampleBodyOrbit(startMs, MOON_ORBIT_SAMPLES, MOON_ORBIT_DAYS, (date) =>
        moonTable.positionKmAt(date, new THREE.Vector3()),
      ),
      () => true,
    )
    // Straight from the Sun table when there is one — the Earth seen from the Sun
    // is the Sun seen from the Earth, negated. Those are the very samples the
    // globe's own position is interpolated from, so the Earth lands on its line by
    // construction. Only while the fallback series is standing in is the curve
    // sampled a year forward from now instead.
    if (!earth) return
    traces.setKm(
      earthOrbitTrace,
      sunTable.earthOrbitSamplesKm(startMs) ??
        sampleBodyOrbit(startMs, EARTH_ORBIT_SAMPLES, EARTH_ORBIT_DAYS, (date) =>
          sunTable.positionKmAt(date, new THREE.Vector3()).negate(),
        ),
      () => true,
    )
  }

  /**
   * The Moon's orbit is geocentric, so it collapses onto the Earth from anywhere
   * else: Earth's view only.
   *
   * The Earth's is heliocentric, and since 2026-10-12 that means it draws from
   * every pivot — through the globe itself when the Earth is the pivot, exactly
   * as Mars's orbit does from Mars. It follows the planets' own fade so that the
   * heliocentric orbits come and go as one set: from the Earth or a planet, where
   * the other planets are only drawn at 100 % réel, an orbit left on screen with no planet on
   * it would be the one line in the scene with nothing to point at.
   */
  function updateOrbits(t, earthOrbitDrawn) {
    if (frame.id === 'earth') traces.update(moonOrbitTrace, t)
    else moonOrbitTrace.line.visible = false

    if (earthOrbitDrawn) traces.update(earthOrbitTrace, t)
    else earthOrbitTrace.line.visible = false
  }

  return {
    globe,
    rebuildOrbits,

    /** The day/night terminator: the globe shader's own uniform (unit vector, world space). */
    setSunDirection(dirWorld) {
      // The globe shader reads sunDirection in world space and does its own
      // modelMatrix transform per-fragment, so the globe's real rotation (set
      // from the ERA in animate()) sweeps the terminator across the texture with
      // no extra per-frame work here.
      globeMaterial.uniforms.sunDirection.value.copy(dirWorld)
    },

    setIssPosition(position) {
      issPosition = position
      issMarker.visible = true
    },

    /** The globe's real orientation and its clouds' drift at `now` (simulated). */
    orient(now) {
      // Recomputed fresh from the clock every frame (not accumulated per frame) so
      // it's exactly right regardless of frame rate or a backgrounded tab, with no
      // drift to correct for.
      // Tilted onto the pole of date, then spun by the ERA about it (astronomy.js):
      // the scene's axes are J2000, and the J2000 pole is 0,15° off the real one in
      // 2026; GMST, used until 2026-10-21, turned the globe 0,34° too far.
      const [px, py, pz] = getEarthPoleJ2000(now)
      earthTilt.setFromUnitVectors(SCENE_UP, icrfToScene(px, py, pz, earthPole))
      earthSpin.setFromAxisAngle(SCENE_UP, (getEarthRotationAngle(now) * Math.PI) / 180)
      globe.quaternion.multiplyQuaternions(earthTilt, earthSpin)
      // Same discipline for the clouds: a function of the clock, not a per-frame
      // increment, so a backgrounded tab comes back where it should be.
      // It adds to the globe's rotation rather than replacing it — the layer is a
      // child of the sphere (scene/bodies.js).
      globeClouds.rotation.y = cloudDriftAt(now)
    },

    /**
     * Places and sizes the three bodies and their two lines.
     *
     * @param {{realTime: boolean, earthOrbitDrawn: boolean}} state  whether the
     *   simulated clock is on the real time (the ISS has no table behind it), and
     *   whether the heliocentric orbits are drawn at all (`planets.drawnAt`)
     */
    update(nowSeconds, t, { realTime, earthOrbitDrawn }) {
      const isEarthFocus = frame.id === 'earth'
      // Shrinking the globe *group* (not just the sphere) takes the ISS with it,
      // so low orbit stays low orbit when the Earth is only a marker.
      const earthScale = earthSystemScale(t, isEarthFocus)

      frame.placeKm(globe.position, EARTH_POSITION_KM, t)
      globe.scale.setScalar(earthScale)
      const earthRadius = Math.max(EARTH_RADIUS * earthScale, minRadiusAt(globe.position, MIN_RADIUS_PX.earth))
      globeSphere.scale.setScalar(earthRadius / (EARTH_RADIUS * earthScale))

      frame.placeKm(moon.position, moonPositionKm, t)
      const moonRadius = MOON_RADIUS * earthScale
      moon.scale.setScalar(Math.max(moonRadius, minRadiusAt(moon.position, MIN_RADIUS_PX.moon)) / MOON_RADIUS)
      // Tidally locked, which is exactly why this cannot be skipped: with no
      // rotation applied the Moon's near side points at a fixed direction in space,
      // so the far side turns towards the viewer over a month. The orientation
      // route says where the Moon's pole and prime meridian are, and the sub-Earth
      // libration falls out of it on its own — the near side stays facing the
      // Earth because that is what the real rotation does, not because anything
      // here aims it.
      orientBody(moon.quaternion, 'moon', nowSeconds)

      // Low orbit is invisible from any other pivot (the Moon is already back on
      // top of the Earth there), and an ISS dot pinned at the Earth's pixel would
      // only add noise.
      // Hidden the moment the simulated time is not the real time: the ISS is a live
      // position with no table behind it, so at any other date it would be a lie.
      // Placed at the real "now" from the ten-minute track, not on the last poll's
      // reading (up to ~460 km behind until 2026-10-21) — and not at all once the
      // track has run out: a stale cached reading is no longer drawn as live.
      const issNow = isEarthFocus && realTime ? issAt(issPosition?.track, nowSeconds) : null
      const issShown = issNow !== null
      issMarker.visible = issShown
      if (issShown) {
        issMarker.position.copy(latLngToVector3(issNow.latitude, issNow.longitude, issOrbitRadius(issNow.altitude_km, t)))
        issMarker.getWorldPosition(tmpWorldPos)
        issMarker.scale.setScalar(
          Math.max(issRadius(t), minRadiusAt(tmpWorldPos, MIN_RADIUS_PX.iss)) / ISS_READABLE_RADIUS,
        )
      }

      updateOrbits(t, earthOrbitDrawn)
    },

    /** What hides a label or a pick behind it: the Earth alone (labels), or with the Moon (picking). */
    earthOccluder: () => ({ center: globe.position, radius: earthWorldRadius() }),
    occluders: () => [
      { center: globe.position, radius: earthWorldRadius() },
      { center: moon.position, radius: moonWorldRadius() },
    ],

    /**
     * One entry per label, returned apart rather than as a list: main.js
     * interleaves them with the Sun's and the rings', and the list order is the
     * spacing arbitration (labels.js).
     */
    labelEntries(t) {
      const small = (worldPos, radius) => labels.projectedRadiusPx(worldPos, radius) < LABEL_WHEN_SMALLER_THAN_PX
      const issPos = issMarker.visible ? issMarker.getWorldPosition(issLabelPos) : null

      // The lunar orbit names itself a quarter of a revolution ahead of the Moon,
      // so the two labels don't stack.
      const moonOrbitDrawn = moonOrbitTrace.line.visible && moonOrbitTrace.km
      if (moonOrbitDrawn) {
        moonOrbitLabelPos.fromArray(moonOrbitTrace.km, Math.floor(MOON_ORBIT_SAMPLES / 4) * 3)
        frame.placeKm(moonOrbitLabelPos, moonOrbitLabelPos, t)
      }

      return {
        earth: { el: labelEls.earth, worldPos: globe.position, occludable: false, show: small(globe.position, earthWorldRadius()) },
        moon: { el: labelEls.moon, worldPos: moon.position, occludable: true, show: small(moon.position, moonWorldRadius()) },
        // Only once the scale makes it a speck.
        iss: {
          el: labelEls.iss,
          worldPos: issPos,
          occludable: true,
          show: issMarker.visible && t > 0.001 && issPos !== null && small(issPos, issRadius(t)),
        },
        moonOrbit: { el: labelEls.moonOrbit, worldPos: moonOrbitLabelPos, occludable: true, show: Boolean(moonOrbitDrawn) },
      }
    },
  }
}
