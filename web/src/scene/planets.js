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
import { fetchSolarSystemBody, fetchSolarSystemOrbit, fetchSolarSystemOrientation } from '../api.js'
import { loadCached, saveCached } from '../cache.js'
import { loadColorMap, makeLitBodyMaterial } from './bodies.js'
import { icrfToScene, setBodyOrientation } from './geo.js'
import { pivotRadius, planetRadius } from '../scale.js'

/**
 * French label and colour per body, in the order the backend lists them
 * (outward from the Sun). The backend owns the physics — Horizons id, IAU
 * name, mean radius; this owns the wording and the look, the same split
 * `ui/panels.js` made between the scene's state and what is shown of it.
 *
 * Colours are the eye's, not a measurement: recognisable hues (rust Mars,
 * blue Neptune), kept clear of the NEO palette (`neoInfo.js` — cyan default,
 * red hazard, and the four taxonomy colours) so a planet is never mistaken
 * for an asteroid.
 */
const PLANETS = {
  mercury: { label: 'Mercure', color: 0x9c9187, map: '/textures/2k_mercury.jpg' },
  venus: { label: 'Vénus', color: 0xf0d9a6, map: '/textures/2k_venus_surface.jpg' },
  mars: { label: 'Mars', color: 0xd0553a, map: '/textures/2k_mars.jpg' },
  jupiter: { label: 'Jupiter', color: 0xd7b98e, map: '/textures/2k_jupiter.jpg' },
  saturn: { label: 'Saturne', color: 0xe6cf9b, map: '/textures/2k_saturn.jpg' },
  uranus: { label: 'Uranus', color: 0x8fd8e0, map: '/textures/2k_uranus.jpg' },
  neptune: { label: 'Neptune', color: 0x5b7ce8, map: '/textures/2k_neptune.jpg' },
}

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
 * Screen floor for a planet, in pixels of radius. Everything out here is
 * sub-pixel at true scale — Neptune's real radius is 7,7 units seen from 1,41
 * million of them — so the floor is not a nicety: it is the only reason a
 * planet is visible at all in the 100 % réel view, which since 2026-09-29 is
 * the *only* place the geocentric view shows one (`planetFade` below).
 *
 * 3,5 px, deliberately under `MIN_RADIUS_PX.sun` in main.js: once both bodies
 * are on their floors the pixel sizes are all the scene says about size, and a
 * Jupiter wider than the Sun — 10x its real radius — would be a lie the eye
 * reads instantly.
 */
const PLANET_MIN_RADIUS_PX = 3.5

/**
 * The scale below which the geocentric view draws no planet at all — the
 * user's call, 2026-09-29: keep them at 100 % réel only.
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
 * The heliocentric view keeps them at every scale: `SUN_CURVE` is built for
 * exactly this range, and a planet around the Sun reads correctly there.
 *
 * Faded rather than switched, so the move animates instead of popping.
 * 0,875 is slider step 7 of `SCALE_STEPS` = 8 — step 7 therefore already shows
 * nothing, and the whole fade happens inside the step 7 -> 8 transition.
 */
const GEOCENTRIC_FADE_FROM = 0.875

/**
 * How much of a planet is drawn: 0 not at all, 1 fully. `hidden` is asked of the
 * point of view — and it is specifically *the Earth's* view, not "anything but
 * the Sun's": centred on Mars, the scene must obviously draw the planets at
 * every scale, Mars included.
 */
function planetFade(t, hidden) {
  if (!hidden) return 1
  return Math.min(1, Math.max(0, (t - GEOCENTRIC_FADE_FROM) / (1 - GEOCENTRIC_FADE_FROM)))
}

/** A table is refetched once "now" comes within this much of its end. */
const TABLE_MARGIN_MS = 30 * 86_400_000

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
const ORBIT_FRAME = 'ICRF heliocentric'

/** Dimmer than the Earth's own orbit (0.5): that one is the heliocentric view's yardstick. */
const ORBIT_OPACITY = 0.35

/**
 * The frame the orientation route must declare for a stored record to be used —
 * same guard, for the same reason, as `ORBIT_FRAME` above: a cache that outlives
 * a change of frame is a wrong picture drawn confidently.
 */
const ORIENTATION_FRAME = 'ICRF'

/**
 * Whether a stored orientation is still the current one.
 *
 * The test is the epoch, not an age: the route anchors on the first of the UTC
 * month and holds the pole fixed across it (Mars's moved five units in the
 * fifth decimal over 40 days), so a record from last month is a pole that was
 * never refreshed — while the phase it carries would still propagate happily
 * and silently. A month-old epoch is therefore stale by construction, and an
 * epoch from *this* month is exact however long the tab has been open, since a
 * rigid body turns at a constant rate about a fixed axis.
 */
function orientationCovers(record, epochNow) {
  return (
    record?.frame === ORIENTATION_FRAME &&
    record?.epoch === epochNow &&
    Array.isArray(record.pole) &&
    Array.isArray(record.primeMeridian) &&
    // A record whose three fields are null is what the route serves when
    // Horizons didn't answer, and a null rate would turn the phase into NaN —
    // which is not a planet pointing the wrong way, it is a planet that
    // disappears. Rejected here rather than guarded in the render loop.
    Number.isFinite(record.rateDegPerDay)
  )
}

/** First of the current UTC month, in seconds — the route's own anchor (`SolarSystemClient::windowStart`). */
function currentEpochSeconds() {
  const now = new Date()
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000
}

/**
 * @typedef {{
 *   id: string, label: string, mesh: THREE.Mesh, radiusKm: number,
 *   positionKm: THREE.Vector3, known: boolean, fade: number,
 * }} PlanetBody
 */

/** Whether a stored table still brackets "now" with room to spare. */
function covers(record) {
  if (!record?.positions?.length) return false
  const nowMs = Date.now()
  const endMs = (record.start + (record.positions.length - 1) * record.stepSeconds) * 1000
  return nowMs >= record.start * 1000 && nowMs < endMs - TABLE_MARGIN_MS
}

/**
 * An orbit is only usable while "now" is inside the period it covers — that is
 * the whole reason the line passes through its planet. No margin: the last
 * sample is as good as the first.
 */
function orbitCovers(record) {
  if (!record?.positions?.length) return false
  // Drawing a geocentric table as heliocentric rings the Earth's position
  // instead of the Sun's, and the retrograde loops look deliberate. Rejecting a
  // wrong or missing frame costs one refetch and self-heals, where renaming the
  // cache key would have orphaned the old data for good.
  if (record.frame !== ORBIT_FRAME) return false
  const nowMs = Date.now()
  return nowMs >= record.start * 1000 && nowMs <= record.stop * 1000
}

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
  return record.positions.map(([x, y, z]) => icrfToScene(x, y, z, new THREE.Vector3()))
}

/**
 * @param {object} options
 * @param {THREE.Scene} options.scene
 * @param {object} options.labels  labels.js — only `create` is used
 * @param {object} options.traces  scene/orbitTrace.js
 * @param {(out: THREE.Vector3, geocentricKm: THREE.Vector3, t: number) => void} options.placeKm
 * @param {(worldPos: THREE.Vector3, px: number) => number} options.minRadiusAt
 * @param {() => boolean} options.isHeliocentric  is the Sun the pivot? (orbits)
 * @param {() => boolean} options.hidesPlanets  does the pivot hide planets below 100 % reel?
 * @param {() => string | null} options.focusPlanetId  which planet is the pivot, if any
 * @param {THREE.Vector3} options.sunPositionKm  live geocentric Sun, mutated in place by
 *   main.js's `updateAstronomy()` — held by reference on purpose, so the lighting
 *   follows it without a per-frame hand-off
 * @param {{changed: Function}} options.on  a table landed, or the load finished
 */
export function createPlanets({
  scene,
  labels,
  traces,
  placeKm,
  minRadiusAt,
  isHeliocentric,
  hidesPlanets,
  focusPlanetId,
  sunPositionKm,
  on,
}) {
  const group = new THREE.Group()
  scene.add(group)

  /**
   * Daily Horizons tables, one per planet, each carrying its own start and the
   * mean radius the backend stated: they are fetched and cached one at a time,
   * so nothing may assume they share a clock even though a fresh set does.
   *
   * @type {Record<string, {start: number, stepSeconds: number, radiusKm: number, positions: number[][]}>}
   */
  const tables = {}
  for (const [id, record] of Object.entries(loadCached('solar-system')?.data ?? {})) {
    if (PLANET_IDS.includes(id) && covers(record)) tables[id] = record
  }

  /**
   * Drawn orbits: the raw geocentric samples as the backend sent them, kept
   * raw on purpose — the heliocentric polyline is derived from them at load
   * time (`orbitSamplesKm`) and would go stale if `astronomy.js` ever changed.
   *
   * @type {Record<string, {start: number, stop: number, positions: number[][]}>}
   */
  const orbitTables = {}
  for (const [id, record] of Object.entries(loadCached('solar-system-orbits')?.data ?? {})) {
    if (PLANET_IDS.includes(id) && orbitCovers(record)) orbitTables[id] = record
  }

  /**
   * How each planet is turned: the route's two ICRF unit vectors and its signed
   * rate, kept exactly as served. Fetched only for a planet that becomes the
   * pivot, like its colour map and for the same reason — from anywhere else a
   * planet is a few pixels wide, where which way it faces cannot be seen.
   *
   * @type {Record<string, {frame: string, epoch: number, pole: number[],
   *   primeMeridian: number[], rateDegPerDay: number}>}
   */
  const orientations = {}
  for (const [id, record] of Object.entries(loadCached('solar-system-orientation')?.data ?? {})) {
    if (PLANET_IDS.includes(id) && orientationCovers(record, currentEpochSeconds())) orientations[id] = record
  }

  let loading = false
  let loadingOrbits = false

  /** @type {PlanetBody[]} */
  const bodies = PLANET_IDS.map((id) => {
    const mesh = new THREE.Mesh(planetGeometry, makeLitBodyMaterial(PLANETS[id].color))
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
      orbit: traces.make(PLANETS[id].color, ORBIT_OPACITY, { parent: scene }),
      radiusKm: tables[id]?.radiusKm ?? 0,
      positionKm: new THREE.Vector3(),
      known: false,
      // Matches the material as constructed (opaque, opacity 1), so the first
      // frame that needs a fade is seen as a change — see `applyFade`.
      fade: 1,
    }
  })

  for (const body of bodies) {
    if (orbitTables[body.id]) traces.setKm(body.orbit, orbitSamplesKm(orbitTables[body.id]), () => true)
  }

  // --- textures ------------------------------------------------------------

  /** Planets already wearing their map, so a second visit doesn't re-assign. */
  const textured = new Set()

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
    if (textured.has(id) || !PLANETS[id]?.map) return
    const body = bodies.find((b) => b.id === id)
    if (!body) return
    textured.add(id)
    loadColorMap(PLANETS[id].map)
      .then((map) => {
        body.mesh.material.uniforms.uMap.value = map
        body.mesh.material.uniforms.uColor.value.setHex(TEXTURED_TINT)
        // No `on.changed()`: that redraws the *panel*, and a texture changes
        // nothing it says. The render loop is a plain rAF, so the new map is on
        // screen on the next frame by itself.
      })
      .catch(() => {
        // Left flat and forgotten rather than retried in place: a planet in its
        // legend colour is the state this scene shipped with for months, so a
        // map that fails to load costs nothing but detail. Dropping it from the
        // set lets the next visit to this pivot try again.
        textured.delete(id)
      })
  }

  // --- orientation ---------------------------------------------------------

  /** Planets whose orientation is fetched or in flight, so a second visit doesn't re-ask. */
  const oriented = new Set()

  /**
   * Fetches how one planet is turned. Same trigger as the colour map — becoming
   * the pivot — and cheap to be wrong about: a planet with no record keeps the
   * identity rotation, which puts its north on the scene's +Y. That is the
   * celestial pole, not the body's, so it is wrong for everyone except the
   * Earth; at the 3,5 px a non-pivot planet gets, it is also invisible.
   *
   * Not part of `load()`: one Horizons request per planet per month is cheap,
   * but seven of them on the first frame would queue in front of the positions,
   * which are what decides whether anything is drawn at all.
   */
  function loadOrientationFor(id) {
    if (oriented.has(id) || orientations[id]) return
    oriented.add(id)
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
        if (!orientationCovers(record, currentEpochSeconds())) return
        orientations[id] = record
        saveCached('solar-system-orientation', orientations)
        // No `on.changed()`, for the reason `loadTextureFor` gives: this changes
        // nothing the panel says, and the render loop picks it up next frame.
      })
      .catch(() => {
        // Dropped from the set so the next visit tries again. An unoriented
        // planet is the state the scene shipped with, so this costs detail and
        // nothing else.
        oriented.delete(id)
      })
  }

  const poleScene = new THREE.Vector3()
  const meridianScene = new THREE.Vector3()

  /**
   * Points one planet's north at its pole and its prime meridian where it is
   * now: `prime_meridian` is where longitude 0 pointed at `epoch`, so the phase
   * is the rate times the elapsed days, turned about the pole.
   *
   * The rate's sign carries the direction — negative for Venus and Uranus —
   * which is exactly why `applyAxisAngle` is given it unmodified. The rotation
   * is propagated rather than sampled because it has to be: Jupiter turns 2,4
   * times between two daily samples, so no table could ever carry this.
   */
  function orient(body, nowSeconds) {
    const record = orientations[body.id]
    if (!record) return
    icrfToScene(record.pole[0], record.pole[1], record.pole[2], poleScene).normalize()
    icrfToScene(record.primeMeridian[0], record.primeMeridian[1], record.primeMeridian[2], meridianScene)
    const days = (nowSeconds - record.epoch) / 86_400
    meridianScene.applyAxisAngle(poleScene, THREE.MathUtils.degToRad(record.rateDegPerDay * days))
    setBodyOrientation(body.mesh.quaternion, poleScene, meridianScene)
  }

  // --- position ------------------------------------------------------------

  const interpA = new THREE.Vector3()
  const interpB = new THREE.Vector3()

  /**
   * Linear interpolation in the daily table. Measured on Mars
   * (docs/planetes-et-lunes.md §3c): at most 5 645 km, 0,002 % of its
   * distance — well under a scene unit at every readable setting. No clamping
   * branch like the NEO's: a table that no longer brackets "now" is refetched
   * rather than read past its end (`covers`).
   */
  function updatePositionKm(body, nowSeconds) {
    const table = tables[body.id]
    if (!table) return
    const f = (nowSeconds - table.start) / table.stepSeconds
    const i = THREE.MathUtils.clamp(Math.floor(f), 0, table.positions.length - 2)
    const a = table.positions[i]
    const b = table.positions[i + 1]
    icrfToScene(a[0], a[1], a[2], interpA)
    icrfToScene(b[0], b[1], b[2], interpB)
    body.positionKm.lerpVectors(interpA, interpB, THREE.MathUtils.clamp(f - i, 0, 1))
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
    if (body.mesh.material.transparent !== fade < 1) {
      body.mesh.material.transparent = fade < 1
      body.mesh.material.needsUpdate = true
    }
  }

  /** Places and sizes every planet that has a table, for the current scale and camera. */
  function update(nowSeconds, t) {
    const heliocentric = isHeliocentric()
    const fade = planetFade(t, hidesPlanets())
    const pivotId = focusPlanetId()

    for (const body of bodies) {
      // Kept up to date even when nothing is drawn: `positionKm` is what the
      // camera's reach reads (`updateCameraLimits` in main.js), and it costs
      // two table lookups.
      updatePositionKm(body, nowSeconds)
      body.mesh.visible = body.known && fade > 0.001
      if (body.mesh.visible) {
        applyFade(body, fade)
        placeKm(body.mesh.position, body.positionKm, t)
        orient(body, nowSeconds)
        // The real direction from this planet to the Sun, in scene axes. Both
        // vectors are geocentric km, so the difference is exact — unaffected by
        // what the scale slider did to either body's drawn position.
        body.mesh.material.uniforms.uSunDir.value.subVectors(sunPositionKm, body.positionKm).normalize()
        // The pivot is the scene's anchor, so it keeps the anchor radius like the
        // Earth and the Sun do when they are centred on; every other planet keeps
        // the compressed-proportion curve. The mesh is a unit sphere, so the
        // radius *is* the scale.
        const radius = body.id === pivotId ? pivotRadius(body.radiusKm, t) : planetRadius(body.radiusKm, t)
        body.mesh.scale.setScalar(Math.max(radius, minRadiusAt(body.mesh.position, PLANET_MIN_RADIUS_PX)))
      }
      // Drawn only from the Sun, because the stored samples ARE heliocentric and
      // `traces.update` reads them as relative to the pivot. From the Earth they
      // would draw a ring around the Earth; from Mars, a ring around Mars. Both
      // are wrong, and fixing the second one means subtracting the pivot's own
      // heliocentric position — see docs/agent/backlog.md.
      if (heliocentric) traces.update(body.orbit, t)
      else body.orbit.line.visible = false
    }
  }

  // --- loading -------------------------------------------------------------

  /**
   * One request per planet, in sequence — the backend serves one body per call
   * (backend/API.md), and the dev server is single-threaded, so firing seven at
   * once would only make the ISS and the NEO feed queue behind them. Each table
   * is drawn as soon as it lands.
   *
   * Nothing here is on the NASA quota (Horizons is keyless), so unlike the feed
   * this isn't cache-first out of thrift: it is cache-first because a planet's
   * position for next spring is already known, and a year-long table has
   * nothing to refresh until it nears its end.
   */
  async function load() {
    const missing = bodies.filter((body) => !tables[body.id])
    loading = missing.length > 0
    on.changed()

    for (const body of missing) {
      let res
      try {
        res = await fetchSolarSystemBody(body.id)
      } catch {
        break // the rest stay unplaced; retried on the next page load
      }
      const served = res.bodies[0]
      body.radiusKm = served.radius_km
      const record = {
        start: res.start,
        stepSeconds: res.step_seconds,
        radiusKm: served.radius_km,
        positions: served.positions ?? [],
      }
      // Held to the same test as a table read back from localStorage: one that
      // doesn't bracket "now" would be interpolated past its own end, which
      // would place the planet somewhere it never was.
      if (covers(record)) {
        tables[body.id] = record
        saveCached('solar-system', tables)
      }
      on.changed()
    }

    loading = false
    on.changed()

    await loadOrbits()
  }

  /**
   * The orbits come **after** every position, and that order is the point: a
   * position is what the scene needs to draw a planet at all, an orbit is
   * décor. On a cold cache the seven positions already cost 35 to 110 s of
   * Horizons latency; the orbits double it, and none of it should delay a
   * planet appearing.
   */
  async function loadOrbits() {
    const missing = bodies.filter((body) => !orbitTables[body.id])
    loadingOrbits = missing.length > 0
    on.changed()

    for (const body of missing) {
      let res
      try {
        res = await fetchSolarSystemOrbit(body.id)
      } catch {
        break // the rest go undrawn; retried on the next page load
      }
      if (!res.positions) continue
      // The server's own word for the frame, not ours — see ORBIT_FRAME.
      const record = { frame: res.frame, start: res.start, stop: res.stop, positions: res.positions }
      if (!orbitCovers(record)) continue
      orbitTables[body.id] = record
      saveCached('solar-system-orbits', orbitTables)
      traces.setKm(body.orbit, orbitSamplesKm(record), () => true)
      on.changed()
    }

    loadingOrbits = false
    on.changed()
  }

  return {
    group,
    /** The camera's reach — and, when planets become pivots, the registry — read these. */
    bodies,
    update,
    load,
    loadTextureFor,
    loadOrientationFor,
    /**
     * The record main.js needs to make `id` the pivot, or null if it cannot be
     * one yet. The position is brought up to date before handing it over: a
     * table that landed this very frame has no `positionKm` until the render
     * loop runs, and a pivot resolved to (0,0,0) would silently mean "the
     * Earth" while the panel claimed otherwise.
     */
    focusBody(id, nowSeconds) {
      const body = bodies.find((candidate) => candidate.id === id)
      if (!body || !tables[id]) return null
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
      return PLANET_IDS.filter((id) => tables[id] !== undefined)
    },
    /**
     * Whether a planet is drawn at all at scale `t` and the current point of
     * view. Exposed so the zoom reach agrees with what is on screen instead of
     * re-deriving the rule: an invisible Neptune must not be what decides how
     * far the camera may pull back (`updateCameraLimits` in main.js).
     */
    drawnAt(t) {
      return planetFade(t, hidesPlanets()) > 0.001
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
      return {
        known: bodies.filter((body) => tables[body.id]).length,
        orbits: bodies.filter((body) => orbitTables[body.id]).length,
        total: bodies.length,
        loading,
        loadingOrbits,
      }
    },
    /** Swatches for the panel — the scene's own colours, as CSS. */
    legend() {
      return bodies.map((body) => ({
        label: body.label,
        color: `#${PLANETS[body.id].color.toString(16).padStart(6, '0')}`,
      }))
    },
  }
}
