/**
 * The moons of whichever planet the scene is centred on — meshes, tables, the
 * on-demand load, and the drawn orbit of each.
 *
 * Same shape as `scene/planets.js`, with three differences that all come from
 * one fact: **a moon only exists here while its planet is the pivot.**
 *
 * 1. Its positions are relative to its planet, not to the Earth (the backend
 *    asks Horizons with `CENTER='500@599'`). Since that planet *is* the pivot,
 *    the samples are already pivot-relative and go through `placeRelativeKm`
 *    untouched — no frame conversion, no subtraction, nothing to get wrong.
 * 2. Nothing is fetched until a planet is centred on. Loading all 39 up front
 *    would cost 39 Horizons requests for moons nobody is looking at.
 * 3. Its orbit costs no extra request: a position table spans about eleven
 *    orbits, so its first `orbit_samples` points *are* one loop. The backend
 *    says how many, and says `covers_full_orbit: false` for the four slowest
 *    irregulars whose period outruns the one-year window cap.
 */

import * as THREE from 'three'
import { fetchMoons } from '../api.js'
import { loadCached, saveCached } from '../cache.js'
import { loadColorMap, makeLitBodyMaterial } from './bodies.js'
import { SSS_MAP_LEFT_EDGE_LON, icrfToScene, mapUShift, setBodyOrientation } from './geo.js'
import { poleOf } from './orientation.js'
import { moonRadius } from '../scale.js'
import { sampleCatmullRom, subdivideTable } from '../interpolate.js'

/** French names, by backend id. The backend owns the physics, this owns the wording. */
const MOON_LABELS = {
  phobos: 'Phobos',
  deimos: 'Déimos',
  ganymede: 'Ganymède',
  callisto: 'Callisto',
  io: 'Io',
  europa: 'Europe',
  himalia: 'Himalia',
  amalthea: 'Amalthée',
  thebe: 'Thébé',
  elara: 'Élara',
  pasiphae: 'Pasiphaé',
  titan: 'Titan',
  rhea: 'Rhéa',
  iapetus: 'Japet',
  dione: 'Dioné',
  tethys: 'Téthys',
  enceladus: 'Encelade',
  mimas: 'Mimas',
  hyperion: 'Hypérion',
  phoebe: 'Phœbé',
  titania: 'Titania',
  oberon: 'Obéron',
  umbriel: 'Umbriel',
  ariel: 'Ariel',
  miranda: 'Miranda',
  puck: 'Puck',
  sycorax: 'Sycorax',
  portia: 'Portia',
  juliet: 'Juliette',
  triton: 'Triton',
  proteus: 'Protée',
  nereid: 'Néréide',
  larissa: 'Larissa',
  galatea: 'Galatée',
  despina: 'Despina',
  thalassa: 'Thalassa',
  naiad: 'Naïade',
  halimede: 'Halimède',
  charon: 'Charon',
}

/**
 * One grey for all of them, deliberately. A planet gets its own colour because
 * seven of them share the screen and the colour is what tells them apart; the
 * moons of one planet are never confused with each other — they are a system
 * around a body at the centre, and their names are right there. A palette of
 * nine more hues would only compete with the planets'.
 */
const MOON_COLOR = 0xc8c8c8

const moonGeometry = new THREE.SphereGeometry(1, 20, 20)

/**
 * Charon is the only moon with a surface, and the one that is a half of a
 * double system (radius 606 km against Pluto's 1 188): New Horizons mapped it,
 * so it wears a map, and the 48 segments are for the same reason as the
 * planets' - a textured limb is read against black.
 *
 * `tint` multiplies the greyscale USGS mosaic (same role as `tint` in
 * planets.js, and as easy to change): neutral grey, very slightly warm,
 * #e2dcd4 - Charon is the grey one next to Pluto's beige, and the red polar cap
 * (Mordor Macula) is not in a greyscale map anyway. Left edge 0 deg E, like
 * Pluto's (mapUShift in geo.js).
 */
const TEXTURED_MOONS = {
  charon: { map: '/textures/1k_charon.jpg', tint: 0xe2dcd4, mapLeftEdgeLon: 0 },
}
const texturedMoonGeometry = new THREE.SphereGeometry(1, 48, 48)

/**
 * Moons in synchronous rotation, whose orbit lies in the equator of the planet
 * they follow: nothing is served for them (no `/orientation` route entry), the
 * pose is computed here. Pole = the planet's pole, longitude 0 = the face that
 * looks at the planet (Charon's sub-Pluto point is 0 deg by convention). The
 * other moons stay unoriented grey spheres.
 */
const LOCKED_MOONS = new Set(['charon'])
const lockPole = new THREE.Vector3()
const lockMeridian = new THREE.Vector3()

/**
 * Smaller floor than a planet's 3,5 px: at the readable end a moon is drawn
 * beside the planet it orbits, and a moon that never shrinks below a planet's
 * minimum would read as another planet.
 */
const MOON_MIN_RADIUS_PX = 2.5

/** Fainter than a planet's orbit (0,35): there are up to nine at once, around one body. */
const ORBIT_OPACITY = 0.22

/** Curve points per hourly sample in a moon's orbit line — same factor as the planets'. */
const ORBIT_SMOOTHING = 8

/** A stored table is usable while "now" sits inside the window it covers. */
function covers(record) {
  if (!record?.positions?.length) return false
  // Wall clock on purpose: cache validity, not scene time.
  const nowMs = Date.now()
  const endMs = (record.start + (record.positions.length - 1) * record.stepSeconds) * 1000
  return nowMs >= record.start * 1000 && nowMs < endMs
}

/**
 * @param {object} options
 * @param {THREE.Scene} options.scene
 * @param {object} options.labels  labels.js — only `create` is used
 * @param {object} options.traces  scene/orbitTrace.js
 * @param {(out: THREE.Vector3, relativeKm: THREE.Vector3, t: number) => void} options.placeRelativeKm
 * @param {(worldPos: THREE.Vector3, px: number) => number} options.minRadiusAt
 * @param {() => {id: string, positionKm: THREE.Vector3} | null} options.focusPlanet
 *   the pivot's own record when it is a planet — the moons' whole reason to exist
 * @param {THREE.Vector3} options.sunPositionKm  live geocentric Sun, mutated in place by main.js
 * @param {{changed: Function}} options.on
 */
export function createMoons({ scene, labels, traces, placeRelativeKm, minRadiusAt, focusPlanet, sunPositionKm, on }) {
  const group = new THREE.Group()
  scene.add(group)

  /**
   * Tables by moon id, and which planet each batch belongs to. Read back from
   * localStorage at startup so a revisit draws immediately.
   *
   * @type {Record<string, {planet: string, start: number, stepSeconds: number, radiusKm: number,
   *   orbitSamples: number|null, positions: number[][]}>}
   */
  const tables = {}
  for (const [id, record] of Object.entries(loadCached('moons')?.data ?? {})) {
    if (MOON_LABELS[id] && covers(record)) tables[id] = record
  }

  /** Planets whose load has finished, so a second visit doesn't re-ask. */
  const loaded = new Set()
  let loadingPlanet = null

  /**
   * Meshes are created as tables arrive rather than all 39 up front: a planet's
   * moons are the only ones ever on screen, so 39 hidden meshes would be 39
   * draw-call candidates and 39 materials for nothing.
   *
   * @type {Record<string, {id: string, label: string, mesh: THREE.Mesh, labelEl: HTMLElement,
   *   orbit: object, radiusKm: number, positionKm: THREE.Vector3, known: boolean, fade: number}>}
   */
  const bodies = {}

  function ensureBody(id, radiusKm) {
    if (bodies[id]) {
      bodies[id].radiusKm = radiusKm
      return bodies[id]
    }
    const mesh = new THREE.Mesh(
      TEXTURED_MOONS[id] ? texturedMoonGeometry : moonGeometry,
      makeLitBodyMaterial(MOON_COLOR),
    )
    mesh.visible = false
    group.add(mesh)
    bodies[id] = {
      id,
      label: MOON_LABELS[id],
      mesh,
      labelEl: labels.create(MOON_LABELS[id]),
      orbit: traces.make(MOON_COLOR, ORBIT_OPACITY, { parent: scene }),
      radiusKm,
      positionKm: new THREE.Vector3(),
      known: false,
      fade: 1,
    }
    return bodies[id]
  }

  /** Moons already asked for their map, so each is fetched once (and retried only after a failure). */
  const textured = new Set()

  /** Same rule as the planets: the map is fetched when its moon is first drawn, not at startup. */
  function loadMapFor(body) {
    const spec = TEXTURED_MOONS[body.id]
    if (!spec || textured.has(body.id)) return
    textured.add(body.id)
    loadColorMap(spec.map)
      .then((map) => {
        const { uniforms } = body.mesh.material
        uniforms.uMap.value = map
        uniforms.uColor.value.setHex(spec.tint)
        uniforms.uMapShift.value = mapUShift(spec.mapLeftEdgeLon ?? SSS_MAP_LEFT_EDGE_LON)
      })
      .catch(() => textured.delete(body.id))
  }

  const sunDir = new THREE.Vector3()
  const interpIcrf = [0, 0, 0]

  /**
   * Cubic Catmull-Rom in the moon's own hourly table (interpolate.js), in ICRF
   * km, then one conversion to scene axes — same discipline as planets.js.
   * Max error on a synthetic circular orbit at Io's radius (421 700 km, period
   * 1,769 d, 3 600 s step; measured 2026-10-16): linear 1 154 km (two thirds of
   * Io's own 1 822 km radius), cubic 22 km in the interior and 88 km on the
   * first/last interval, where the quadratic through the three nearest samples
   * replaces the missing neighbour.
   *
   * Clamped rather than refused past the end (`sampleCatmullRom` clamps `f`):
   * unlike a planet's yearly table, a moon's window is days long and can lapse
   * while the tab stays open. A moon frozen at its last known sample is wrong by
   * a fraction of an orbit; a moon that vanishes mid-session looks like a bug.
   * The refetch happens on the next visit.
   */
  function updatePositionKm(body, nowSeconds) {
    const table = tables[body.id]
    if (!table) return
    const f = (nowSeconds - table.start) / table.stepSeconds
    sampleCatmullRom(table.positions, f, interpIcrf)
    icrfToScene(interpIcrf[0], interpIcrf[1], interpIcrf[2], body.positionKm)
    body.known = true
  }

  /**
   * Draws the loop from the first `orbitSamples` points of the position table,
   * redrawn by `subdivideTable` — the same Catmull-Rom curve `updatePositionKm`
   * places the moon on. Straight hourly chords stopped holding the moon on its
   * line once placement went cubic: Io's chords sag up to ~1 154 km below the
   * curve (circle r = 421 700 km, 1,769 d, 3 600 s step), 0,63 of its radius.
   */
  function setOrbit(body) {
    const table = tables[body.id]
    if (!table?.orbitSamples) return
    const points = subdivideTable(table.positions.slice(0, table.orbitSamples), ORBIT_SMOOTHING)
      .map(([x, y, z]) => icrfToScene(x, y, z, new THREE.Vector3()))
    traces.setKm(body.orbit, points, () => true)
  }

  /** Places and sizes the current pivot's moons; hides every other. */
  function update(nowSeconds, t) {
    const planet = focusPlanet()

    for (const body of Object.values(bodies)) {
      const mine = planet !== null && tables[body.id]?.planet === planet.id
      body.mesh.visible = mine && body.known
      body.orbit.line.visible = false
      if (!mine) continue

      updatePositionKm(body, nowSeconds)
      body.mesh.visible = body.known
      if (!body.known) continue

      // Already relative to the pivot, because the pivot IS this moon's planet.
      placeRelativeKm(body.mesh.position, body.positionKm, t)

      loadMapFor(body)
      // Locked moon: pole of its planet, longitude 0 toward the planet. The
      // position is pivot-relative (the planet is the pivot), so "toward the
      // planet" is simply minus the position. Skipped until the planet's own
      // orientation has landed - the pole is the one thing it comes from.
      if (LOCKED_MOONS.has(body.id) && poleOf(planet.id, lockPole)) {
        lockMeridian.copy(body.positionKm).negate()
        setBodyOrientation(body.mesh.quaternion, lockPole, lockMeridian)
      }

      // The Sun's direction from the moon itself: the planet's geocentric
      // position plus the moon's own offset from it. The offset is tiny next to
      // an astronomical unit, so this differs little from the planet's own
      // direction — but it costs one subtraction and it is the true one.
      sunDir.copy(sunPositionKm).sub(planet.positionKm).sub(body.positionKm).normalize()
      body.mesh.material.uniforms.uSunDir.value.copy(sunDir)

      body.mesh.scale.setScalar(
        Math.max(moonRadius(body.radiusKm, t), minRadiusAt(body.mesh.position, MOON_MIN_RADIUS_PX)),
      )
      traces.update(body.orbit, t)
    }
  }

  /**
   * Loads one planet's moons, then stops asking. The route answers `missing > 0`
   * while it still has tables to fetch — one Horizons call per request, so a
   * cold cache converges in as many calls as the planet has moons and a warm one
   * in exactly one. Capped so a planet whose moons Horizons keeps refusing can't
   * spin: `missing` also counts moons it had nothing for.
   */
  async function loadFor(planetId) {
    if (!planetId || loaded.has(planetId) || loadingPlanet === planetId) return
    loadingPlanet = planetId
    on.changed()

    for (let attempt = 0; attempt < 12; attempt++) {
      let res
      try {
        res = await fetchMoons(planetId)
      } catch {
        break // retried the next time this planet is centred on
      }
      for (const moon of res.moons ?? []) {
        const record = {
          planet: planetId,
          start: moon.start,
          stepSeconds: moon.step_seconds,
          radiusKm: moon.radius_km,
          orbitSamples: moon.covers_full_orbit ? moon.orbit_samples : null,
          positions: moon.positions ?? [],
        }
        if (!covers(record)) continue
        tables[moon.id] = record
        const body = ensureBody(moon.id, moon.radius_km)
        setOrbit(body)
      }
      saveCached('moons', tables)
      on.changed()
      if (!res.missing) {
        loaded.add(planetId)
        break
      }
    }

    loadingPlanet = null
    on.changed()
  }

  // Tables read back from localStorage need their meshes and orbits too.
  for (const [id, record] of Object.entries(tables)) setOrbit(ensureBody(id, record.radiusKm))

  return {
    group,
    loadFor,
    update,
    /** Distances from the pivot, in km — the camera's reach reads these. */
    distancesKm() {
      const planet = focusPlanet()
      if (!planet) return []
      return Object.values(bodies)
        .filter((body) => body.known && tables[body.id]?.planet === planet.id)
        .map((body) => body.positionKm.length())
    },
    /** What labels.js should place — only the pivot's own moons are ever visible. */
    labelEntries() {
      return Object.values(bodies).map((body) => ({
        el: body.labelEl,
        worldPos: body.mesh.position,
        occludable: true,
        show: body.mesh.visible,
      }))
    },
    /** For the panel: how many moons the centred planet has drawn, and whether more are coming. */
    status() {
      const planet = focusPlanet()
      if (!planet) return null
      const mine = Object.values(tables).filter((record) => record.planet === planet.id)
      return { planet: planet.id, known: mine.length, loading: loadingPlanet === planet.id }
    },
  }
}
