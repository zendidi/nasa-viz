/**
 * The real Sun and Moon: their two Horizons tables, the geocentric positions
 * every placement goes through, and the cadence at which the lighting and the
 * drawn orbits follow the simulated clock.
 *
 * It does not know the bodies that show them: main.js wires `on.sunDirection`
 * (the light, the marker, the terminator) and `on.rebuildOrbits` (the Earth's
 * and Moon's drawn lines), and hears through `on.sunTableChanged` that the
 * clock's bounds have moved.
 */

import * as THREE from 'three'
import { createMoonTable, createSunTable } from '../ephemeris/sunTable.js'
import { AU_KM, LUNAR_DISTANCE_KM } from '../view/scale.js'

// Real drift is slow (~1°/day for the Sun, ~0.5°/h for the Moon) — no need to
// recompute every frame at ×1: the gate is 60 s of *simulated* time, which is
// one minute of wall time at ×1 (the cadence the scene always had) and every
// frame from 1 h/s up, so the lighting and the Moon move smoothly when sped up.
// The drawn orbits are re-sampled with it so their first sample stays the body's
// current position (earthSystem.rebuildOrbits()) — but at most every 250 ms of wall time:
// that rebuild allocates new geometry, and a Moon orbit 0,07° stale (1 h/s) is
// invisible where a per-frame GPU re-upload would not be free.
const ASTRONOMY_STEP_MS = 60_000
const ORBIT_REBUILD_MIN_WALL_MS = 250

/**
 * @param {object} options
 * @param {object} options.clock  clock.js
 * @param {{sunDirection: (dir: THREE.Vector3) => void,
 *          rebuildOrbits: (simMs: number, options?: {earth?: boolean}) => void,
 *          sunTableChanged: (wallMs: number) => void}} options.on
 */
export function createSunMoon({ clock, on }) {
  /*
   * Real equatorial Sun direction (right ascension/declination, same convention
   * as star placement) drives the light, the visible Sun marker, and (via the
   * globe's shader uniform, in world space) the day/night terminator. This is a
   * fixed-stars-style frame, deliberately NOT tied to the globe's own real
   * rotation (set from the ERA in animate(), see docs/agent/decisions.md) — the
   * shader transforms its own normal into world space via modelMatrix each
   * fragment, so the globe's spin sweeps the terminator across the texture with
   * no extra per-frame JS work needed.
   */
  const sunDirWorld = new THREE.Vector3()
  let moonDistanceKm = LUNAR_DISTANCE_KM
  let sunDistanceKm = AU_KM

  // Geocentric positions in km, scene axes — the common frame every placement
  // goes through, whichever body the scene is centred on (see placeKm()).
  const sunPositionKm = new THREE.Vector3()
  const moonPositionKm = new THREE.Vector3()

  // The Sun comes from JPL Horizons, with `astronomy.js`'s series standing in
  // until the table lands. Created with the module because update() runs on
  // the very first frame, long before any fetch returns.
  const sunTable = createSunTable({
    on: {
      // Everything derived from the Sun has to be redone when the real one
      // arrives: the scene's positions, and the Earth's own drawn orbit.
      changed: () => {
        const wallMs = Date.now()
        update(new Date(clock.nowMs(wallMs)))
        on.rebuildOrbits(clock.nowMs(wallMs))
        on.sunTableChanged(wallMs) // the table's real end replaces the 1st-of-month + 365 d guess
      },
    },
  })

  // The Moon, on the Sun's exact terms (2026-10-21): Horizons table, series as
  // stand-in. The series alone was 0,38° (2 500 km) off on median — more than the
  // Moon's own apparent radius on an eclipse day.
  const moonTable = createMoonTable({
    on: {
      changed: () => {
        const simMs = clock.nowMs(Date.now())
        update(new Date(simMs))
        on.rebuildOrbits(simMs, { earth: false })
      },
    },
  })

  /** Sim time of the last update(), to know when the next one is due (step). */
  let astronomySimMs = NaN
  let orbitsRebuiltWallMs = 0

  function update(now) {
    astronomySimMs = now.getTime()

    sunTable.positionKmAt(now, sunPositionKm)
    sunDistanceKm = sunPositionKm.length()
    sunDirWorld.copy(sunPositionKm).divideScalar(sunDistanceKm)
    on.sunDirection(sunDirWorld)

    // Real direction and distance only — where that lands in the scene depends
    // on the current scale, applied per frame in applyScale().
    moonTable.positionKmAt(now, moonPositionKm)
    moonDistanceKm = moonPositionKm.length()
  }

  /** Per frame: recomputes once 60 simulated seconds have gone by, the orbits at most every 250 ms. */
  function step(simMs, wallMs) {
    if (Math.abs(simMs - astronomySimMs) < ASTRONOMY_STEP_MS) return
    update(new Date(simMs))
    if (wallMs - orbitsRebuiltWallMs >= ORBIT_REBUILD_MIN_WALL_MS) {
      orbitsRebuiltWallMs = wallMs
      // The Earth's line comes from the Sun table and does not depend on "now";
      // only the fallback series (no table yet) samples forward from it.
      on.rebuildOrbits(simMs, { earth: !sunTable.known })
    }
  }

  /** After the clock jumped: everything at once, not 60 s later. */
  function jump(simMs, wallMs) {
    update(new Date(simMs))
    orbitsRebuiltWallMs = wallMs
    on.rebuildOrbits(simMs, { earth: !sunTable.known })
  }

  return {
    sunTable,
    moonTable,
    sunPositionKm,
    moonPositionKm,
    get sunDistanceKm() {
      return sunDistanceKm
    },
    get moonDistanceKm() {
      return moonDistanceKm
    },
    update,
    step,
    jump,
  }
}
