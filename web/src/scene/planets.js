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
import { fetchSolarSystemBody, fetchSolarSystemOrbit } from '../api.js'
import { loadCached, saveCached } from '../cache.js'
import { getSunEquatorial } from '../astronomy.js'
import { icrfToScene, latLngToVector3 } from './geo.js'
import { planetRadius } from '../scale.js'

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
  mercury: { label: 'Mercure', color: 0x9c9187 },
  venus: { label: 'Vénus', color: 0xf0d9a6 },
  mars: { label: 'Mars', color: 0xd0553a },
  jupiter: { label: 'Jupiter', color: 0xd7b98e },
  saturn: { label: 'Saturne', color: 0xe6cf9b },
  uranus: { label: 'Uranus', color: 0x8fd8e0 },
  neptune: { label: 'Neptune', color: 0x5b7ce8 },
}

const PLANET_IDS = Object.keys(PLANETS)

/**
 * Self-lit like the NEO points and the Sun marker, not shaded by `sunLight`.
 * A directional light has one direction for the whole scene — the Sun as seen
 * from the Earth — so lighting a planet with it would draw its terminator
 * facing the wrong way. The real fix (the Sun's direction *from that planet*)
 * belongs with the planets-as-pivots lot, where the globe needs it too. Until
 * then a flat disc is honest; a wrong phase would not be.
 */
const planetGeometry = new THREE.SphereGeometry(1, 24, 24)

/** At true scale even Jupiter is sub-pixel from the Earth; same floor as the globe. */
const PLANET_MIN_RADIUS_PX = 2.5

/** A table is refetched once "now" comes within this much of its end. */
const TABLE_MARGIN_MS = 30 * 86_400_000

/** Dimmer than the Earth's own orbit (0.5): that one is the heliocentric view's yardstick. */
const ORBIT_OPACITY = 0.35

/**
 * @typedef {{
 *   id: string, label: string, mesh: THREE.Mesh, radiusKm: number,
 *   positionKm: THREE.Vector3, known: boolean,
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
  const nowMs = Date.now()
  return nowMs >= record.start * 1000 && nowMs <= record.stop * 1000
}

/**
 * The Sun, in km and scene axes, from the very series the scene places
 * everything else with — `main.js`'s `updateAstronomy()` does exactly this.
 * Reusing it (rather than a cleaner ephemeris) is the point: see
 * `orbitSamplesKm` below.
 */
function sunPositionKmAt(date, out) {
  const { ra, dec, distanceKm } = getSunEquatorial(date)
  return out.copy(latLngToVector3(dec, ra, 1)).multiplyScalar(distanceKm)
}

/**
 * Turns a stored geocentric orbit table into the heliocentric polyline the
 * scene draws, by subtracting that same low-precision Sun at each sample's own
 * date.
 *
 * **This subtraction is the whole design, not a detail.** Asking Horizons for
 * the heliocentric orbit directly gives a cleaner curve — but the scene's
 * heliocentric view is built as `geocentric − Sun`, and its Sun comes from
 * `astronomy.js`, which works in the equinox *of date* where the scene's axes
 * are J2000. Measured 2026-09-22: 951 057 km (0,363°) apart today, exactly the
 * precession accumulated since J2000, growing to 6 995 236 km by 2191. A DE441
 * ellipse would therefore miss Mercury by 966 557 km — 0,127 scene unit, half
 * the planet's own drawn radius. Subtracting the same Sun makes both errors
 * cancel where it matters: measured miss between planet and line, 8 630 km for
 * Mercury and 204 999 km for Neptune, i.e. 0,001 and 0,002 unit — which is the
 * chord approximation, not the Sun.
 *
 * The price is that the drawn curve is that far from DE441's true ellipse
 * (1,41 % of the radius for Mercury, 0,16 % for Neptune). A line that is
 * slightly the wrong ellipse but passes through its planet beats the true
 * ellipse sitting beside it — `docs/agent/decisions.md`, 2026-09-18.
 */
function orbitSamplesKm(record) {
  const span = record.stop - record.start
  const last = record.positions.length - 1
  const sun = new THREE.Vector3()
  return record.positions.map(([x, y, z], k) => {
    const point = icrfToScene(x, y, z, new THREE.Vector3())
    return point.sub(sunPositionKmAt(new Date((record.start + (k / last) * span) * 1000), sun))
  })
}

/**
 * @param {object} options
 * @param {THREE.Scene} options.scene
 * @param {object} options.labels  labels.js — only `create` is used
 * @param {object} options.traces  scene/orbitTrace.js
 * @param {(out: THREE.Vector3, geocentricKm: THREE.Vector3, t: number) => void} options.placeKm
 * @param {(worldPos: THREE.Vector3, px: number) => number} options.minRadiusAt
 * @param {() => boolean} options.isHeliocentric  the only thing the point of view is asked
 * @param {{changed: Function}} options.on  a table landed, or the load finished
 */
export function createPlanets({ scene, labels, traces, placeKm, minRadiusAt, isHeliocentric, on }) {
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

  let loading = false
  let loadingOrbits = false

  /** @type {PlanetBody[]} */
  const bodies = PLANET_IDS.map((id) => {
    const mesh = new THREE.Mesh(planetGeometry, new THREE.MeshBasicMaterial({ color: PLANETS[id].color }))
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
    }
  })

  for (const body of bodies) {
    if (orbitTables[body.id]) traces.setKm(body.orbit, orbitSamplesKm(orbitTables[body.id]), () => true)
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

  /** Places and sizes every planet that has a table, for the current scale and camera. */
  function update(nowSeconds, t) {
    // An orbit around the Sun means nothing from the Earth's point of view:
    // the samples are relative to the pivot, so in the geocentric view they
    // would be read as distances from the Earth and draw a ring around it.
    const drawOrbits = isHeliocentric()

    for (const body of bodies) {
      updatePositionKm(body, nowSeconds)
      body.mesh.visible = body.known
      if (body.known) {
        placeKm(body.mesh.position, body.positionKm, t)
        // The mesh is a unit sphere, so the radius *is* the scale.
        body.mesh.scale.setScalar(
          Math.max(planetRadius(body.radiusKm, t), minRadiusAt(body.mesh.position, PLANET_MIN_RADIUS_PX)),
        )
      }
      if (drawOrbits) traces.update(body.orbit, t)
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
      const record = { start: res.start, stop: res.stop, positions: res.positions }
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
