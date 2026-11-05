/**
 * The planets in the scene: their meshes, their real geocentric positions from
 * JPL Horizons, and the background load that fills them in.
 *
 * Same shape as the NEO module, for the same reason: what colours a planet,
 * where it is and how big it is drawn are one subject, and nothing outside
 * needs the position tables. What the overlay must redraw is announced through
 * `on`; what the labels need is read off `bodies`.
 *
 * It knows nothing of the point of view. A planet is placed from its geocentric
 * km vector through `placeKm`, exactly like the Moon — which is what makes it
 * appear in both the Earth-centred and the Sun-centred view without a second
 * data source (docs/planetes-et-lunes.md §2).
 */

import * as THREE from 'three'
import { fetchSolarSystemOrbit } from '../data/api.js'
import { loadCached, saveCached } from '../data/cache.js'
import { loadColorMap, makeLitBodyMaterial, makeRing } from './bodies.js'
import { SSS_MAP_LEFT_EDGE_LON, icrfToScene, mapUShift } from './geo.js'
import { polylinePointAt, subdivideClosedLoop } from '../ephemeris/interpolate.js'
import { orientBody } from './orientation.js'
import { ORBIT_SMOOTHING, sampleKm, tableIndexAt } from '../ephemeris/positionTable.js'
import { createSliceSet } from '../ephemeris/sliceSet.js'
import { MAX_CONSECUTIVE_FAILURES, orbitFromResponse, orbitKey, validOrbit, yearOfMs, yearRange } from '../ephemeris/slices.js'
import { SCALE_STEPS, pivotRadius, planetRadius, stepToT } from '../view/scale.js'

/**
 * French label and colour per body, in the order the backend lists them
 * (outward from the Sun). The backend owns the physics — Horizons id, IAU
 * name, mean radius; this owns the wording and the look, the same split
 * `ui/panels.js` made between the scene's state and what is shown of it.
 *
 * Colours are the eye's, not a measurement: recognisable hues (rust Mars,
 * blue Neptune), kept clear of the NEO palette (`neo/info.js` — cyan default,
 * red hazard, and the four taxonomy colours) so a planet is never mistaken
 * for an asteroid.
 */
const PLANETS = {
  mercury: { label: 'Mercure', color: 0x9c9187, map: '/textures/2k_mercury.jpg' },
  // Cloud deck by default: from space Venus is a featureless yellowish sphere,
  // and the ground under the clouds is not what a camera there would see. The
  // radar surface is opt-in, from a checkbox that only exists while Venus is
  // the pivot (`setVenusSurface`).
  venus: {
    label: 'Vénus',
    color: 0xf0d9a6,
    map: '/textures/2k_venus_atmosphere.jpg',
    surfaceMap: '/textures/2k_venus_surface.jpg',
  },
  mars: { label: 'Mars', color: 0xd0553a, map: '/textures/2k_mars.jpg' },
  jupiter: { label: 'Jupiter', color: 0xd7b98e, map: '/textures/2k_jupiter.jpg' },
  saturn: {
    label: 'Saturne',
    color: 0xe6cf9b,
    map: '/textures/2k_saturn.jpg',
    /**
     * Which radii the two ends of the 2048 × 125 ring band stand for — the one
     * thing the band itself cannot say, and the same kind of unknown the maps'
     * longitude was.
     *
     * **Measured, not assumed** (`tools/calibration/saturn-ring-radii.py`). The
     * alpha channel has exactly two edges that collapse in a single column — the
     * outer edge of the B ring and the outer edge of the A ring — found by
     * steepest slope, because a threshold returns the wrong one: the Cassini
     * division is not empty, and its alpha climbs back over any half-height
     * threshold fifteen columns past the edge. Against NASA NSSDCA's Saturnian
     * Rings Fact Sheet (117 507 km and 136 780 km) those two fix a linear map,
     * **r(u) = 69 289 + 71 766 u km**, at 35 km per column.
     *
     * Two structures that took no part in the fit then check it: the inner edge
     * of the Encke division lands 41 km out (1,2 columns, table 133 410), and
     * the C/B boundary 224 km out (6,4 columns, table 91 975) — that one is a
     * soft ramp in the band rather than an edge, so six columns is the noise of
     * reading it, not a fault in the map.
     *
     * So the band runs 1,150 to 2,340 Saturn equatorial radii: it starts inside
     * the D ring, too faint to have been drawn at all (alpha is flat zero over
     * the first 110 columns), and ends 1 229 km **past** the F ring (139 826 km,
     * NSSDCA) — the F ring itself is not in the band, but the band does not stop
     * short of it (an older note here said it did; corrected 2026-10-21).
     *
     * In km on purpose. The mesh is scaled by the body's **mean** radius, which
     * is not the equatorial one a ring table counts in, so dividing by
     * `radiusKm` at build time is what puts the ring at the right absolute
     * distance instead of 3,4 % too far out.
     */
    ring: { map: '/textures/2k_saturn_ring_alpha.png', innerKm: 69_289, outerKm: 141_055 },
  },
  uranus: { label: 'Uranus', color: 0x8fd8e0, map: '/textures/2k_uranus.jpg' },
  neptune: { label: 'Neptune', color: 0x5b7ce8, map: '/textures/2k_neptune.jpg' },
  // A dwarf planet, drawn as a planet because the user likes it (2026-10-16).
  // Its map is the USGS/New Horizons mosaic: greyscale, left edge at 0 deg E
  // (the SSS maps start at 180), south of ~-25 deg black because it was in polar
  // night in 2015 - an absence of data, left as is.
  //
  // `tint` is what the grey map is multiplied by (the shader's uColor), tweak it
  // here: #e8cfb0 is a pale orange-beige, a hint of the tholin-stained real
  // colour without the saturation of the legend swatch (`color`, which also
  // names the orbit). Greyscale x tint darkens the disc to ~half; the
  // 0,12 + 0,88 lighting floor is unchanged.
  pluto: {
    label: 'Pluton',
    color: 0xd2a77c,
    map: '/textures/1k_pluto.jpg',
    tint: 0xe8cfb0,
    mapLeftEdgeLon: 0,
  },
}

/** Legend colour of the Earth (not a `PLANETS` entry): ocean blue, apart from Neptune's 0x5b7ce8. */
const EARTH_SWATCH = 0x3f8fd8

const PLANET_IDS = Object.keys(PLANETS)

/**
 * What `uColor` becomes once a planet wears its map. White, so the shader's
 * multiply is a straight replace and the photograph is shown as photographed
 * (`makeLitBodyMaterial` in bodies.js says why).
 *
 * The consequence is deliberate and visible: a textured planet is no longer
 * drawn in its legend colour. That colour still names it everywhere it is
 * *needed* — the swatch, the label, its orbit — and a body only gets its map
 * when you centre on it, which is exactly when it is far too big to be confused
 * with anything.
 */
const TEXTURED_TINT = 0xffffff

/**
 * 48 segments, not the 24 that were enough while a planet was a flat disc of at
 * most a few pixels. A map is only ever loaded for a planet you have centred
 * on, and at that size 24 segments put a visible 15° facet on the limb — the
 * one place a sphere's silhouette is read against black. Seven shared-geometry
 * spheres at 48x48 is ~4 600 triangles, nothing next to the starfield.
 */
const planetGeometry = new THREE.SphereGeometry(1, 48, 48)

/**
 * A planet's flattening, as the factors its unit sphere is stretched by: the
 * equator to `equatorial / mean`, the pole (local +Y, see scene/geo.js) to
 * `polar / mean`. [1, 1] — the shared sphere — for a body the backend gives no
 * shape for. Saturn comes out 1,035 × 0,934, an ellipse of 0,90 against the
 * round ball it was until 2026-10-21; Jupiter 0,935.
 *
 * Baked into the geometry, not into `mesh.scale`: the ring is the mesh's child
 * and must not be squashed with it, and the scale already carries the pixel
 * floor. The mean radius stays the unit, so ring radii in km / mean still land
 * at the right absolute distance.
 *
 * @param {{radiusKm: number, equatorialKm?: number, polarKm?: number} | undefined} record
 * @returns {[number, number]}
 */
export function shapeOf(record) {
  if (!record?.radiusKm || !record.equatorialKm || !record.polarKm) return [1, 1]
  return [record.equatorialKm / record.radiusKm, record.polarKm / record.radiusKm]
}

/**
 * Screen floor for a planet, in pixels of radius. Everything out here is
 * sub-pixel at true scale — Neptune's real radius is 7,7 units seen from 1,41
 * million of them — so the floor is not a nicety: it is the only reason a
 * planet is visible at all in the 100 % réel view, which since 2026-09-29 is
 * the *only* place a pivot-centred view shows another planet (`planetFade` below).
 *
 * 3,5 px, deliberately under `MIN_RADIUS_PX.sun` in main.js: once both bodies
 * are on their floors the pixel sizes are all the scene says about size, and a
 * Jupiter wider than the Sun — 10x its real radius — would be a lie the eye
 * reads instantly.
 */
const PLANET_MIN_RADIUS_PX = 3.5

/**
 * The scale below which a pivot-centred view (the Earth, or any planet) draws no
 * *other* planet and no planetary orbit line — the user's call, 2026-09-29 for
 * the Earth, extended on 2026-10-16 to the planets (it replaces the 2026-09-29
 * rule "centred on Mars, draw the planets at every scale"): keep them at
 * 100 % réel only. The pivot planet itself is never faded.
 *
 * Why: that view compresses distance through `EARTH_CURVE`, which is
 * `a + b·log10(d)`. Measured across it, the whole solar system lands between
 * 19,1 (Venus at 0,28 au) and 26,2 (Neptune at 29,1 au) — seven scene units
 * for a hundred-fold range of real distance. Worse, that band is exactly where
 * the NEOs are: the curve is pinned so a NEO at 0,5 au sits at 20,00, which
 * falls *between* Venus at 19,12 and Mercury at 20,09. So at the readable end
 * the planets are not merely squashed, they are interleaved with the asteroid
 * cloud — a picture that reads clearly and says something false. At t = 1 the
 * geocentric view is metrically true, so that is where a planet belongs and
 * nowhere else.
 *
 * The Sun's view keeps them at every scale: `SUN_CURVE` is built for
 * exactly this range, and a planet around the Sun reads correctly there.
 *
 * Faded rather than switched, so the move animates instead of popping.
 * It starts at the slider's last-but-one cran, so that cran still shows
 * nothing and the whole fade happens inside the transition to 100 % réel.
 * Derived rather than written out: it was 0,875 (cran 7 of t = k/8) until the
 * slider was cut to t ∈ [0,5 ; 1] on 2026-10-27, where cran 7 is 0,9375.
 */
const GEOCENTRIC_FADE_FROM = stepToT(SCALE_STEPS - 1)

/**
 * How much of a planet (or of its orbit line) is drawn: 0 not at all, 1 fully.
 * `hidden` is asked of the point of view (`hidesPlanets` in focus.js: every
 * pivot but the Sun). The pivot planet's own *body* is exempt, see `update`.
 */
function planetFade(t, hidden) {
  if (!hidden) return 1
  return Math.min(1, Math.max(0, (t - GEOCENTRIC_FADE_FROM) / (1 - GEOCENTRIC_FADE_FROM)))
}

// ORBIT_FRAME (the frame the orbit route must declare, in its own words, and why)
// moved with the rest of the validation to ephemeris/slices.js on 2026-11-05.

/** Dimmer than the Earth's own orbit (0.5): that one is the heliocentric view's yardstick. */
const ORBIT_OPACITY = 0.35

/** An orbit that failed is asked again after this long, the next time the orbit loader runs. */
const ORBIT_RETRY_MS = 5 * 60_000

/**
 * @typedef {{
 *   id: string, label: string, mesh: THREE.Mesh, radiusKm: number,
 *   positionKm: THREE.Vector3, known: boolean, fade: number,
 *   ring: THREE.Mesh | null,
 * }} PlanetBody
 */

// Which stored tables and orbits may be used is decided slice by slice in
// ephemeris/slices.js (2026-11-05); the old whole-table `covers` / `orbitCovers`
// against the wall clock are gone with the monthly window.

// Catmull-Rom points per orbit segment: 360 -> 2 880 segments (ORBIT_SMOOTHING, positionTable.js).

/**
 * Turns a stored orbit table into the polyline the scene draws. Since
 * 2026-09-29 that is a change of axes and nothing else: the backend serves these
 * samples **heliocentric** (`CENTER='500@10'`), which is what the heliocentric
 * view wants, so there is nothing left to subtract.
 *
 * It used to subtract, and the reason is worth keeping. The curve was fetched
 * geocentric and the client took away *its own* Sun at each sample's date, so
 * that two errors cancelled and the line passed through its planet even though
 * that Sun was 951 057 km off. A DE441 ellipse would have missed Mercury by
 * 966 557 km — 0,127 unit, half the planet's drawn radius — so subtracting the
 * same wrong Sun was the lesser evil (docs/agent/decisions.md, 2026-09-18).
 *
 * The scene's Sun now comes from Horizons too (`sunTable.js`), so the trade is
 * over: the line is DE441's true ellipse and passes through the planet by
 * construction rather than by cancellation. Mercury gets back the 1,41 % of
 * orbital radius the old approximation cost it. The subtraction could not have
 * survived anyway — these samples span a whole sidereal period, 165 years for
 * Neptune, where a Sun table covers one.
 */
function orbitSamplesKm(record) {
  // Smoothed for drawing only: 360 chords left Mercury up to ~4 400 km off its
  // line at perihelion (sagitta ~3 900 km, Mercury's radius is 2 440 km).
  // Nothing indexes these points by time — traces draw every consecutive pair —
  // and bodies are placed from their own daily tables, not from this polyline.
  return subdivideClosedLoop(record.positions, ORBIT_SMOOTHING).map(([x, y, z]) => icrfToScene(x, y, z, new THREE.Vector3()))
}

/**
 * @param {object} options
 * @param {THREE.Scene} options.scene
 * @param {object} options.labels  labels.js — only `create` is used
 * @param {object} options.traces  scene/orbitTrace.js
 * @param {import('./frame.js').ViewFrame} options.frame  the pivot and its placers
 * @param {(worldPos: THREE.Vector3, px: number) => number} options.minRadiusAt
 * @param {THREE.Vector3} options.sunPositionKm  live geocentric Sun, mutated in place by
 *   main.js's `updateAstronomy()` — held by reference on purpose, so the lighting
 *   follows it without a per-frame hand-off
 * @param {{changed: Function}} options.on  a table landed, or the load finished
 */
export function createPlanets({
  scene,
  labels,
  traces,
  frame,
  minRadiusAt,
  sunPositionKm,
  on,
}) {
  const group = new THREE.Group()
  scene.add(group)

  /**
   * Yearly Horizons slices, one set per planet (2026-11-05: Y−1 to Y+4, each
   * year fetched, cached and validated on its own), assembled by `tableOf` into
   * the continuous daily (or 6-hourly) table a planet is placed from. They are
   * fetched one at a time, so nothing may assume the planets share the same
   * years loaded.
   */
  const sets = Object.fromEntries(PLANET_IDS.map((id) => [id, createSliceSet(id)]))
  const tableOf = (id) => sets[id].table()

  /**
   * Drawn orbits: the raw heliocentric samples as the backend sent them, kept
   * raw on purpose — the polyline is derived from them at load time
   * (`orbitSamplesKm`) and would go stale if the axes ever changed. One record
   * per planet × year (the orbit of a year starts on its 1 January); the one
   * drawn is the simulated clock's year, loaded on demand, and the previous one
   * stays on until the new one arrives.
   *
   * @type {Record<string, Map<number, {frame: string, timeScale: string, year: number, start: number, stop: number, positions: number[][]}>>}
   */
  const orbitRecords = Object.fromEntries(PLANET_IDS.map((id) => [id, new Map()]))
  /** What each planet's line shows right now (null: none yet). `Pluto`'s offset rule reads it. */
  const drawnOrbit = Object.fromEntries(PLANET_IDS.map((id) => [id, null]))
  /** The simulated year the orbits are wanted for. */
  let orbitYear = yearOfMs(Date.now())
  {
    const range = yearRange(Date.now())
    for (const id of PLANET_IDS) {
      for (let year = range.minYear; year <= range.maxYear; year++) {
        const stored = loadCached(orbitKey(id, year))?.data
        if (validOrbit(stored, year, range)) orbitRecords[id].set(year, stored)
      }
    }
  }

  /** True while main.js's loading plan is running, so the panel keeps saying "…" between two slices. */
  let planRunning = false
  let loadingOrbits = false
  // Whether the positions plan is over: the orbits come after every position (see `loadOrbits`).
  let orbitsEnabled = false
  // Why a load stopped, in the backend's own words ("JPL Horizons est en panne : ..."),
  // kept for the panel instead of swallowed: "les autres n'ont pas répondu" alone
  // never said who. Cleared when the next attempt starts.
  let loadError = null
  let orbitsError = null
  /** planet:year → when its orbit failed; asked again after ORBIT_RETRY_MS, when a pump next runs. */
  const orbitFailures = new Map()

  /** @type {PlanetBody[]} */
  /** Gives a body its own ellipsoid once its record says how flat it is (see `shapeOf`). */
  function applyShape(body, record) {
    const [equator, pole] = shapeOf(record)
    body.shape = [equator, pole]
    if (body.mesh.geometry !== planetGeometry) body.mesh.geometry.dispose()
    body.mesh.geometry = equator === 1 && pole === 1 ? planetGeometry : planetGeometry.clone().scale(equator, pole, equator)
  }

  const bodies = PLANET_IDS.map((id) => {
    const mesh = new THREE.Mesh(planetGeometry, makeLitBodyMaterial(PLANETS[id].color, null, { ringShadow: !!PLANETS[id].ring }))
    // Nothing to place until a table arrives — and there is no fallback
    // position for a planet the way an approach distance is one for a NEO.
    mesh.visible = false
    group.add(mesh)
    return {
      id,
      label: PLANETS[id].label,
      mesh,
      // Named at every scale, unlike the Sun and the ISS which are only named
      // once they shrink to dots: a planet is never anything else here
      // (Jupiter peaks at 0,80 units against the pivot's 2), so the name is
      // the only thing telling one from another.
      labelEl: labels.create(PLANETS[id].label),
      // Each orbit wears its planet's own colour rather than the NEO ellipse's
      // neutral cyan: there is only ever one NEO ellipse on screen, but seven
      // orbits at once in the same colour would say nothing about which ring
      // belongs to which dot.
      orbit: traces.make(PLANETS[id].color, ORBIT_OPACITY, { parent: scene, frame: 'heliocentric' }),
      radiusKm: sets[id].shape()?.radiusKm ?? 0,
      positionKm: new THREE.Vector3(),
      known: false,
      // Matches the material as constructed (opaque, opacity 1), so the first
      // frame that needs a fade is seen as a change — see `applyFade`.
      fade: 1,
      // Saturn's, once it has been centred on; null everywhere else.
      ring: null,
      // [equator, pole] stretch of the unit sphere, see `shapeOf`.
      shape: [1, 1],
    }
  })

  /** Sizes and shapes a planet from the radii its slices state, the first time a slice is in. */
  function syncShape(body) {
    const shape = sets[body.id].shape()
    if (!shape) return
    body.radiusKm = shape.radiusKm
    applyShape(body, shape)
  }

  for (const body of bodies) syncShape(body)

  /**
   * Draws the planet's orbit of `year` if it is loaded and not already the one on
   * screen. Returns whether a line is drawn for that year.
   */
  function showOrbit(body, year) {
    const record = orbitRecords[body.id].get(year)
    if (!record) return false
    if (drawnOrbit[body.id]?.record !== record) {
      drawnOrbit[body.id] = { year, record }
      traces.setKm(body.orbit, orbitSamplesKm(record), () => true)
    }
    return true
  }

  for (const body of bodies) showOrbit(body, orbitYear)

  // --- textures ------------------------------------------------------------

  /** Planets already wearing their map, so a second visit doesn't re-assign. */
  const textured = new Set()

  /** True while Venus is asked to show the radar surface instead of its clouds. */
  let venusSurface = false

  const mapUrlFor = (id) => (id === 'venus' && venusSurface ? PLANETS.venus.surfaceMap : PLANETS[id].map)

  /**
   * Loads the map a planet should wear *now* and puts it on. The check after
   * the load is for the checkbox being flipped while the image was in flight:
   * the older answer must not land on top of the newer one.
   */
  function applyMap(body) {
    const url = mapUrlFor(body.id)
    return loadColorMap(url).then((map) => {
      if (mapUrlFor(body.id) !== url) return
      body.mesh.material.uniforms.uMap.value = map
      body.mesh.material.uniforms.uColor.value.setHex(PLANETS[body.id].tint ?? TEXTURED_TINT)
      body.mesh.material.uniforms.uMapShift.value = mapUShift(PLANETS[body.id].mapLeftEdgeLon ?? SSS_MAP_LEFT_EDGE_LON)
      // No `on.changed()`: that redraws the *panel*, and a texture changes
      // nothing it says. The render loop is a plain rAF, so the new map is on
      // screen on the next frame by itself.
    })
  }

  /**
   * Venus: radar surface (true) or cloud deck (false). The surface map is
   * fetched the first time it is asked for, like every other map here. If
   * Venus has not been centred on yet nothing is loaded: `loadTextureFor` will
   * pick the right one.
   */
  function setVenusSurface(enabled) {
    venusSurface = enabled
    const body = bodies.find((b) => b.id === 'venus')
    // A failed load leaves the previous map on, which is a correct picture, only not the requested one.
    if (body && textured.has('venus')) applyMap(body).catch(() => {})
  }

  /**
   * Gives one planet its colour map. Called when that planet becomes the pivot
   * and at no other time — the same rule the moons follow, for the same reason:
   * the detail only exists at the moment you centre on the body, and the seven
   * maps are 2,6 Mo that nobody browsing the Sun view should pay for.
   *
   * Deliberately *not* added to the `<link rel="preload">` list in index.html:
   * that list exists to jump the queue of a single-request `php -S`, and adding
   * megabytes of planet maps ahead of the Horizons calls would destroy the very
   * benefit it was built for (see the comment in index.html).
   *
   * The swap needs no recompile — `uMap` starts on a shared white texel and the
   * shader source never changes — so a planet simply stops being flat on the
   * frame the image decodes, with no hitch.
   */
  function loadTextureFor(id) {
    const body = bodies.find((b) => b.id === id)
    if (!body) return
    // Before the guard, not after: a ring that failed to build must get another
    // chance on the next visit even though the map itself landed first time.
    buildRingFor(body)
    if (textured.has(id) || !PLANETS[id]?.map) return
    textured.add(id)
    applyMap(body)
      .catch(() => {
        // Left flat and forgotten rather than retried in place: a planet in its
        // legend colour is the state this scene shipped with for months, so a
        // map that fails to load costs nothing but detail. Dropping it from the
        // set lets the next visit to this pivot try again.
        textured.delete(id)
      })
  }

  /**
   * Hangs a planet's ring system under its mesh, once. Parented to the mesh and
   * not to the group, which is what makes it free: it inherits the orientation
   * (so it lies in the equatorial plane, which is why this step waited for step
   * 4) and the drawn scale (so it follows the pixel floor with its planet).
   *
   * Spinning with the planet is harmless rather than wrong: the band has one
   * repeated row, so the ring carries no azimuthal detail to smear. The real
   * rings do not turn as a solid anyway — they orbit, each radius at its own
   * rate — and nothing here could show that.
   */
  function buildRingFor(body) {
    const spec = PLANETS[body.id]?.ring
    if (!spec || body.ring || !body.radiusKm) return
    const ring = makeRing({
      innerRadius: spec.innerKm / body.radiusKm,
      outerRadius: spec.outerKm / body.radiusKm,
      // So the planet's shadow on the ring is the ellipsoid's, not a ball's.
      shape: body.shape,
    })
    body.ring = ring
    body.mesh.add(ring)
    // The planet's own shader casts the ring's shadow on itself: it needs the
    // same radii (in planet radii) and, once decoded, the same band.
    body.mesh.material.uniforms.uRingRadii.value.set(spec.innerKm / body.radiusKm, spec.outerKm / body.radiusKm)
    loadColorMap(spec.map, { wrapS: THREE.ClampToEdgeWrapping })
      .then((map) => {
        ring.material.uniforms.uMap.value = map
        body.mesh.material.uniforms.uRingMap.value = map
      })
      .catch(() => {
        // A ring with no band is a white annulus, which is worse than no ring:
        // it would read as a solid disc. Dropped entirely, and rebuilt on the
        // next visit to this pivot.
        body.mesh.remove(ring)
        body.ring = null      })
  }

  // --- position ------------------------------------------------------------

  /**
   * Cubic Catmull-Rom in the daily table (interpolate.js), in ICRF km, then one
   * conversion to scene axes. Max error vs hourly Horizons, 2026-10-01 ->
   * 2027-10-01 (measured 2026-10-15): Mercury 848 km (linear: 63 258 km, worst
   * near superior conjunction at 1.29 au), Venus 52 (16 106), Mars 15 (6 839),
   * Jupiter 36 (5 729). Quintic only helps Mercury (1.8 km) — not worth it.
   * Edge intervals use the quadratic through the three nearest samples.
   *
   * 2026-11-05 (lot 3): a planet whose assembled table does not hold the instant is
   * **not known** — hidden, with its label and line — instead of pinned to the
   * table's edge (`tablePositionKm` clamps) where it would look placed. The clock
   * is bounded to the Sun's coverage, so this only shows when a planet's own
   * slice is missing (a failed year, or still on its way).
   */
  function updatePositionKm(body, nowSeconds) {
    body.known = false
    const table = tableOf(body.id)
    if (!table) return
    const f = tableIndexAt(table, nowSeconds)
    if (f < 0 || f > table.positions.length - 1) return
    sampleKm(table.positions, f, body.positionKm)
    body.known = true
  }

  /**
   * Writes a planet's fade into its material — and only when it changed.
   *
   * `transparent` is not a per-frame flag in three.js: it feeds the program
   * cache key through `parameters.opaque`, which injects `#define OPAQUE` into
   * the shader, and three.js only rebuilds a program when `material.version`
   * moves. So the switch needs `needsUpdate`, and assigning it every frame
   * would recompile the shader every frame. Gated on a change, a recompile
   * happens on the two frames of a transition that actually cross 1.
   *
   * The opacity itself goes to `uOpacity`: a hand-written ShaderMaterial gets
   * no automatic `material.opacity`.
   *
   * Going back to opaque at full fade is the point of the switch: a transparent
   * mesh is drawn in the sorted pass *after* the opaque bodies, so at true scale
   * a planet would paint over the Sun marker it is really behind — the same trap
   * `scene/starfield.js` documents for the sky.
   */
  function applyFade(body, fade) {
    if (body.fade === fade) return
    body.fade = fade
    body.mesh.material.uniforms.uOpacity.value = fade
    // The ring is already a transparent material, so it needs the fade value
    // but never the `transparent` switch below.
    if (body.ring) body.ring.material.uniforms.uOpacity.value = fade
    if (body.mesh.material.transparent !== fade < 1) {
      body.mesh.material.transparent = fade < 1
      body.mesh.material.needsUpdate = true
    }
  }

  /**
   * Pluto's line is shifted so that Pluto is ON it: offset = (Pluto's
   * heliocentric position, as it is placed) - (the point of the drawn polyline
   * at the same instant, f * ORBIT_SMOOTHING with f = (t - start) / step).
   * Applied through `trace.offsetKm` only while Pluto is the pivot.
   *
   * Two errors in one vector, both measured 2026-10-16:
   * - the line is the Pluto-Charon barycentre's (backend/API.md: plu060 for the
   *   body `999` ends in 2199): Pluto is 0,1085 * 19 591 = ~2 126 km from it,
   *   1,79 Pluto radii;
   * - the line's own interpolation (361 samples 251,56 d apart, x8 Catmull-Rom,
   *   chords), on a Keplerian Pluto (a = 39,48 au, e = 0,249): 0 km on a sample,
   *   ~340 km a month later, mean 2 400, worst 6 400 km (5,4 radii).
   * Together: a few hundred to ~8 500 km, on an orbit 5,9e9 km across - invisible
   * anywhere but at the body, which is the point. Neptune with the same method
   * (a = 30,07 au, 167 d step): mean 1 800, worst 2 850 km, 0,12 of its
   * 24 622 km radius, so it is left alone. Measured from `trace.km`, the Float32 vertices really
   * drawn (ulp 512 km at 5e9 km), so that quantisation is absorbed too.
   */
  const plutoOffset = new THREE.Vector3()
  const plutoLinePoint = new THREE.Vector3()
  function plutoOrbitOffset(body, pivotId, nowSeconds) {
    if (body.id !== 'pluto') return
    // The record of the line actually drawn (2026-11-05: one per year, and the
    // previous year's stays on until the new one lands), not whichever is newest.
    const record = drawnOrbit.pluto?.record
    const trace = body.orbit
    // Outside the drawn period the line is another year's: Pluto is not on it and
    // the offset would be a clamped, meaningless vector.
    if (pivotId !== 'pluto' || !record || !trace.km || !body.known || nowSeconds < record.start || nowSeconds > record.stop) {
      trace.offsetKm = null
      return
    }
    const step = (record.stop - record.start) / (record.positions.length - 1)
    polylinePointAt(trace.km, ((nowSeconds - record.start) / step) * ORBIT_SMOOTHING, plutoLinePoint)
    // Heliocentric = geocentric - Sun: the inverse of `placeHeliocentricKm`.
    plutoOffset.subVectors(body.positionKm, sunPositionKm).sub(plutoLinePoint)
    trace.offsetKm = plutoOffset
  }

  /** Places and sizes every planet that has a table, for the current scale and camera. */
  function update(nowSeconds, t) {
    const fade = planetFade(t, frame.hidesPlanets())
    const pivotId = frame.planet ? frame.planet.id : null
    followClockYear(nowSeconds)

    for (const body of bodies) {
      // Kept up to date even when nothing is drawn: `positionKm` is what the
      // camera's reach reads (`updateCameraLimits` in main.js), and it costs
      // two table lookups.
      updatePositionKm(body, nowSeconds)
      // The pivot is always drawn in full; the others, and every orbit line
      // (the pivot's own included, as in the Earth's view), follow `fade`.
      const bodyFade = body.id === pivotId ? 1 : fade
      body.mesh.visible = body.known && bodyFade > 0.001
      if (body.mesh.visible) {
        applyFade(body, bodyFade)
        frame.placeKm(body.mesh.position, body.positionKm, t)
        orientBody(body.mesh.quaternion, body.id, nowSeconds)
        // The real direction from this planet to the Sun, in scene axes. Both
        // vectors are geocentric km, so the difference is exact — unaffected by
        // what the scale slider did to either body's drawn position.
        body.mesh.material.uniforms.uSunDir.value.subVectors(sunPositionKm, body.positionKm).normalize()
        // Same world-space direction for the ring: its shader reads it against
        // the ring plane's own normal, which the parent's orientation carries.
        if (body.ring) body.ring.material.uniforms.uSunDir.value.copy(body.mesh.material.uniforms.uSunDir.value)
        // The pivot is the scene's anchor, so it keeps the anchor radius like the
        // Earth and the Sun do when they are centred on; every other planet keeps
        // the compressed-proportion curve. The mesh is a unit sphere, so the
        // radius *is* the scale.
        const radius = body.id === pivotId ? pivotRadius(body.radiusKm, t) : planetRadius(body.radiusKm, t)
        body.mesh.scale.setScalar(Math.max(radius, minRadiusAt(body.mesh.position, PLANET_MIN_RADIUS_PX)))
      }
      // Drawn from every pivot since 2026-10-12. The samples are heliocentric
      // and they now say so (`frame: 'heliocentric'`), so the trace subtracts
      // the pivot's own heliocentric position instead of being read as already
      // relative to it — which is what used to ring the Earth from the Earth
      // and Mars from Mars, and why these lines were shown from the Sun only.
      // The centred planet's own orbit is included, and passes through the
      // pivot at the origin: that is the picture the backlog entry asked for.
      //
      // Tied to the same fade as the planets, not drawn unconditionally: from a
      // pivot that hides planets they only exist at 100 % réel, and an orbit
      // with no planet on it would be the one line here pointing at nothing.
      // That includes the pivot's own line, as the Earth's disappears from the
      // Earth's view (2026-10-16).
      //
      // 2026-11-05: and to the planet being placed — a planet outside its table's
      // coverage is hidden (see `updatePositionKm`), and its line, which would
      // point at nothing, goes with it.
      if (fade > 0.001 && body.known) {
        plutoOrbitOffset(body, pivotId, nowSeconds)
        traces.update(body.orbit, t)
        // Opacity only — `transparent` was set true at construction and must
        // stay a constructor-time property, see docs/agent/decisions.md.
        body.orbit.line.material.opacity = ORBIT_OPACITY * fade
      } else {
        body.orbit.line.visible = false
      }
    }
  }

  // --- loading -------------------------------------------------------------

  /**
   * One slice of one planet: a civil year of its positions (2026-11-05: Y−1 to
   * Y+4, was one table per planet). Resolves true when the year is held. The
   * order they are asked in is main.js's plan (`loadPlan`, slices.js): the
   * current year of every planet before any other year.
   *
   * One request at a time — the backend serves one body per call
   * (backend/API.md), and the dev server is single-threaded, so firing several at
   * once would only make the ISS and the NEO feed queue behind them. Each slice
   * is used as soon as it lands.
   *
   * Nothing here is on the NASA quota (Horizons is keyless), so unlike the feed
   * this isn't cache-first out of thrift: it is cache-first because a planet's
   * position for next spring is already known, and a slice is immutable.
   */
  async function loadYear(id, year) {
    const set = sets[id]
    if (set.has(year)) return true
    loadError = null
    on.changed()
    const ok = await set.load(year)
    if (ok) syncShape(bodies.find((body) => body.id === id))
    else loadError = set.error
    on.changed()
    return ok
  }

  /**
   * Tells the panel a loading plan is running (and that it is over), so its
   * "positions réelles : n/8…" does not flicker between two slices.
   */
  function setPlanRunning(running) {
    planRunning = running
    on.changed()
  }

  /** Wall-clock-year range the orbits may be asked for. */
  const clampToRange = (year) => {
    const range = yearRange(Date.now())
    return Math.min(range.maxYear, Math.max(range.minYear, year))
  }

  /**
   * Orbits follow the simulated clock's year, not the wall's (2026-11-05): the
   * line of a year is a sidereal period from its 1 January, and the planet is on
   * it throughout that year (Venus ≤ 1 425 km, Jupiter 311 km off, measured by the
   * backend) but leaves it outside. So when the clock crosses a 1 January the new
   * year's orbits are drawn if they are loaded, asked for otherwise, and the
   * previous ones stay on until they arrive.
   */
  function followClockYear(nowSeconds) {
    const year = clampToRange(yearOfMs(nowSeconds * 1000))
    if (year === orbitYear) return
    orbitYear = year
    for (const body of bodies) showOrbit(body, year)
    pumpOrbits()
  }

  const recentlyFailed = (id, year) => Date.now() - (orbitFailures.get(`${id}:${year}`) ?? -Infinity) < ORBIT_RETRY_MS
  let orbitsPumping = false

  /**
   * The orbits come **after** every position, and that order is the point: a
   * position is what the scene needs to draw a planet at all, an orbit is
   * décor. On a cold cache the positions already cost minutes of Horizons
   * latency; the orbits add to it, and none of it should delay a planet
   * appearing. main.js calls this once its plan is over; from then on the
   * orbits of the clock's year are loaded as the clock reaches it.
   */
  async function pumpOrbits() {
    if (orbitsPumping || !orbitsEnabled) return
    orbitsPumping = true
    orbitsError = null
    let failures = 0
    try {
      for (;;) {
        const year = orbitYear // re-read each turn: the clock may have crossed a 1 January meanwhile
        const body = bodies.find((candidate) => !orbitRecords[candidate.id].has(year) && !recentlyFailed(candidate.id, year))
        if (!body) break
        loadingOrbits = true
        on.changed()
        try {
          const res = await fetchSolarSystemOrbit(body.id, year)
          const record = orbitFromResponse(res)
          if (!validOrbit(record, year, yearRange(Date.now()))) throw new Error(`orbite de ${body.label} ${year} refusée`)
          orbitRecords[body.id].set(year, record)
          saveCached(orbitKey(body.id, year), record)
          failures = 0
          if (year === orbitYear) showOrbit(body, year)
        } catch (err) {
          orbitsError = err.message
          orbitFailures.set(`${body.id}:${year}`, Date.now())
          if (++failures >= MAX_CONSECUTIVE_FAILURES) break // the rest go undrawn; asked again at the next year change or page load
        }
        on.changed()
      }
    } finally {
      orbitsPumping = false
      loadingOrbits = false
      on.changed()
    }
  }

  function loadOrbits() {
    orbitsEnabled = true
    return pumpOrbits()
  }

  return {
    group,
    /** The camera's reach — and, when planets become pivots, the registry — read these. */
    bodies,
    update,
    loadYear,
    setPlanRunning,
    loadOrbits,
    loadTextureFor,
    setVenusSurface,
    /**
     * The record main.js needs to make `id` the pivot, or null if it cannot be
     * one yet. The position is brought up to date before handing it over: a
     * table that landed this very frame has no `positionKm` until the render
     * loop runs, and a pivot resolved to (0,0,0) would silently mean "the
     * Earth" while the panel claimed otherwise.
     */
    focusBody(id, nowSeconds) {
      const body = bodies.find((candidate) => candidate.id === id)
      if (!body || !tableOf(id)) return null
      updatePositionKm(body, nowSeconds)
      return body.known ? body : null
    },
    /**
     * Which planets the "Point de vue" panel may offer. Read off `tables`, not
     * off `body.known`, for the same reason `status()` is: `known` is only
     * raised by the render loop, so a table that just landed would leave its
     * button disabled until the next repaint.
     */
    focusableIds() {
      return PLANET_IDS.filter((id) => tableOf(id) !== null)
    },
    /**
     * Whether the planets other than the pivot (and the orbit lines) are drawn
     * at scale `t` and the current point of view. Exposed so the zoom reach agrees with what is on screen instead of
     * re-deriving the rule: an invisible Neptune must not be what decides how
     * far the camera may pull back (`updateCameraLimits` in main.js).
     */
    drawnAt(t) {
      return planetFade(t, frame.hidesPlanets()) > 0.001
    },
    /**
     * What labels.js should place for the planets, in the scene's own order
     * (outward from the Sun). Where these sit in the caller's list is what
     * decides who yields to whom when two names collide.
     */
    labelEntries() {
      return bodies.map((body) => ({
        el: body.labelEl,
        worldPos: body.mesh.position,
        occludable: true,
        show: body.mesh.visible,
      }))
    },
    /**
     * For the panel: how many planets have a usable table. Counted on the
     * tables, not on `body.known` — that flag is only raised by the render
     * loop, so counting it would report the table that just landed as missing
     * until the next frame, and leave the final count one short.
     */
    status() {
      const known = bodies.filter((body) => tableOf(body.id)).length
      return {
        known,
        orbits: bodies.filter((body) => drawnOrbit[body.id]).length,
        total: bodies.length,
        // Only while a planet still lacks its table: the other years load behind a complete "8/8".
        loading: (planRunning || PLANET_IDS.some((id) => sets[id].loading)) && known < bodies.length,
        loadingOrbits,
        error: loadError ?? orbitsError,
      }
    },
    /**
     * Swatches for the panel — the scene's own colours, as CSS. The Earth is
     * slotted in after Venus: it is not a body of this module (the globe is the
     * origin of the geocentric tables) but it is one of the eight planets the
     * panel counts, and a legend that skips it reads as a missing swatch.
     */
    legend() {
      const swatches = bodies.map((body) => ({
        label: body.label,
        color: `#${PLANETS[body.id].color.toString(16).padStart(6, '0')}`,
      }))
      const afterVenus = swatches.findIndex((s) => s.label === PLANETS.venus.label) + 1
      swatches.splice(afterVenus, 0, { label: 'Terre', color: `#${EARTH_SWATCH.toString(16).padStart(6, '0')}` })
      return swatches
    },
  }
}
