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
 * 2. Nothing is fetched until a planet is centred on. Loading all 38 up front
 *    would cost 38 Horizons requests for moons nobody is looking at.
 * 3. Its orbit costs no extra request: a position table spans about eleven
 *    orbits, so its first `orbit_samples` points *are* one loop. The backend
 *    says how many, and says `covers_full_orbit: false` for the four slowest
 *    irregulars whose period outruns the one-year window cap.
 */

import * as THREE from 'three'
import { fetchMoons } from '../api.js'
import { loadCached, saveCached } from '../cache.js'
import { makeLitBodyMaterial } from './bodies.js'
import { icrfToScene } from './geo.js'
import { moonRadius } from '../scale.js'

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
 * Smaller floor than a planet's 3,5 px: at the readable end a moon is drawn
 * beside the planet it orbits, and a moon that never shrinks below a planet's
 * minimum would read as another planet.
 */
const MOON_MIN_RADIUS_PX = 2.5

/** Fainter than a planet's orbit (0,35): there are up to nine at once, around one body. */
const ORBIT_OPACITY = 0.22

/** A stored table is usable while "now" sits inside the window it covers. */
function covers(record) {
  if (!record?.positions?.length) return false
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
   * Meshes are created as tables arrive rather than all 38 up front: a planet's
   * moons are the only ones ever on screen, so 38 hidden meshes would be 38
   * draw-call candidates and 38 materials for nothing.
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
    const mesh = new THREE.Mesh(moonGeometry, makeLitBodyMaterial(MOON_COLOR))
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

  const interpA = new THREE.Vector3()
  const interpB = new THREE.Vector3()
  const sunDir = new THREE.Vector3()

  /**
   * Linear interpolation in the moon's own table. Clamped rather than refused
   * past the end: unlike a planet's yearly table, a moon's window is days long
   * and can lapse while the tab stays open. A moon frozen at its last known
   * sample is wrong by a fraction of an orbit; a moon that vanishes mid-session
   * looks like a bug. The refetch happens on the next visit.
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

  /** Draws the loop from the first `orbitSamples` points of the position table. */
  function setOrbit(body) {
    const table = tables[body.id]
    if (!table?.orbitSamples) return
    const points = table.positions
      .slice(0, table.orbitSamples)
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
