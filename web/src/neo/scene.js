/**
 * Everything about near-Earth objects in the scene: the points themselves, the
 * per-object sheets that colour and size them, the real positions from JPL
 * Horizons, and the two drawings of the selected one — its geocentric path over
 * the feed's week (Earth-centred view) and its whole heliocentric ellipse
 * (Sun-centred view).
 *
 * These are not three independent things, which is why they are one module:
 * they share the selection, the NEO's own colour, the approach ring that both
 * drawings position, and the two stores (`details`, `positions`) that the
 * loaders below fill. Splitting them would mean inventing a shared bag to pass
 * between them.
 *
 * It knows nothing of the overlay: what it draws it draws, what the panels must
 * redraw it announces through `on`.
 */

import * as THREE from 'three'
import { fetchNeoDetails, fetchNeoPositions } from '../api.js'
import { loadCached, saveCached } from '../cache.js'
import { NEO_DEFAULT_COLOR, NEO_HAZARD_COLOR, TAXONOMY, taxonomyKey } from '../neoInfo.js'
import {
  sampleOrbit,
  sampleOrbitBetween,
  bundleOrbitSamples,
  orbitApsides,
  orbitNodes,
  orbitPosition,
  julianDate,
} from '../orbit.js'
import { eclipticAuToSceneKm, hashToDirection, icrfToScene } from '../scene/geo.js'
import { neoEllipsesVisible } from '../focus.js'
import { NEO_FLOOR_PX, neoFloorFactor, neoFloorPx, neoRadius } from '../scale.js'

// Unit spheres shared by every NEO, scaled per frame in update().
const neoGeometry = new THREE.SphereGeometry(1, 10, 10)
const neoHitGeometry = new THREE.SphereGeometry(1, 8, 8)
const neoMaterials = {
  default: new THREE.MeshBasicMaterial({ color: NEO_DEFAULT_COLOR }),
  hazard: new THREE.MeshBasicMaterial({ color: NEO_HAZARD_COLOR }),
  ...Object.fromEntries(Object.entries(TAXONOMY).map(([key, { color }]) => [key, new THREE.MeshBasicMaterial({ color })])),
}
const neoHitMaterial = new THREE.MeshBasicMaterial({ visible: false })

// Floor on the invisible hit sphere's on-screen radius, in pixels: wider than
// the drawn dot (whose own floor shrinks as you zoom out, `neoFloorPx`) so small
// ones stay clickable without inflating what is drawn.
const NEO_HIT_MIN_RADIUS_PX = 8

const DESIGNATION_PATTERN = /^[A-Za-z0-9 /-]{1,40}$/
const NEO_DETAILS_MAX_AGE_MS = 7 * 86_400_000
const NEO_DETAILS_BATCH = 10 // backend maximum per call
const NEO_POSITIONS_BATCH = 10 // backend maximum per call

const TRAJECTORY_PAST_DIM = 0.3
const APPROACH_MARKER_MIN_PX = 7
const APPROACH_MARKER_NEO_FACTOR = 1.8
const ARROW_PX = 7 // the arrow is twice this long on screen, whatever the zoom

const ORBIT_SAMPLES = 360
const ORBIT_ARC_DAYS = 30
const ORBIT_ARC_SAMPLES = 120
const ORBIT_COLOR = 0x7fe0ff
const ORBIT_DASH_STRIDE = 2 // below the ecliptic: one segment drawn out of this many
const ORBIT_MARKER_PX = 4

/**
 * The whole feed's orbits at once — off by default, the user's call
 * (2026-10-12), because a hundred-odd ellipses is the one drawing here that can
 * bury everything else.
 *
 * Two settings carry the readability, and both are deliberate:
 *
 * - **72 samples per orbit, not the selected one's 360.** These lines are
 *   re-projected every frame like every other trace, and `traces.update` places
 *   *two* vertices per segment (LineSegments, not a strip), so a 150-object
 *   feed costs 2 x 72 x 150 ≈ 21 600 placements a frame — already the heaviest
 *   thing in the loop, and five times that at 360. The figure is counted, not
 *   measured on screen: there is no browser test on this project, so if the
 *   scene drags with the box ticked, this constant is the lever;
 * - **hazardous ones drawn apart, and brighter.** Same reason the planets each
 *   wear their own colour rather than sharing the NEO cyan: a hundred identical
 *   lines say nothing about which is which, and PHA is the one distinction this
 *   view is really about.
 */
const ALL_ORBITS_SAMPLES = 72
const ALL_ORBITS_OPACITY = 0.12
const ALL_ORBITS_HAZARD_OPACITY = 0.3

/** `neo.designation` from the backend; parsed from the name for feeds cached before that field existed. */
export function designationOf(neo) {
  if (neo.designation) return neo.designation
  const match = /\(([^()]+)\)\s*$/.exec(neo.name)
  return (match ? match[1] : neo.name).trim()
}

/**
 * @typedef {{
 *   neo: object, designation: string, diameterKm: number,
 *   fallbackDir: THREE.Vector3, group: THREE.Group, mesh: THREE.Mesh, hit: THREE.Mesh,
 *   positionKm: THREE.Vector3, source: 'horizons'|'horizons-clamped'|'approx'|null,
 * }} NeoEntry
 */

/**
 * @param {object}       options
 * @param {THREE.Scene}  options.scene
 * @param {THREE.Camera} options.camera
 * @param {object}       options.traces  scene/orbitTrace.js
 * @param {(out: THREE.Vector3, geocentricKm: THREE.Vector3, t: number) => void} options.placeKm
 * @param {(out: THREE.Vector3, relativeKm: any, t: number) => void} options.placeRelativeKm
 * @param {(worldPos: THREE.Vector3, px: number) => number} options.minRadiusAt
 * @param {() => string} options.focusId  which body the scene is centred on
 * @param {{detailsProgress: Function, detailsApplied: Function, positionsChanged: (settled: boolean) => void}} options.on
 */
export function createNeoScene({ scene, camera, traces, placeKm, placeRelativeKm, minRadiusAt, focusId, on }) {
  const group = new THREE.Group()
  scene.add(group)

  /** @type {NeoEntry[]} */
  let entries = []

  // Real positions for the loaded feed, keyed by designation (JPL Horizons via
  // /api/neo/positions). null = Horizons couldn't resolve that object.
  let positions = { range: null, stepSeconds: 3600, objects: {} }
  let positionsLoading = false

  // Per-object sheets from /api/neo/details, keyed by designation: object, or
  // null when neither JPL SBDB nor IMCCE knows it. Kept in localStorage across
  // feeds (catalogues change weekly at most) — see loadDetails().
  /** @type {Record<string, {data: object|null, fetchedAt: number}>} */
  const details = {}
  {
    const cached = loadCached('neo-details')
    const now = Date.now()
    for (const [designation, record] of Object.entries(cached?.data ?? {})) {
      if (now - record.fetchedAt < NEO_DETAILS_MAX_AGE_MS) details[designation] = record
    }
  }
  const detailsLoading = new Set()
  const detailsErrors = new Map()

  let currentFeed = null
  let currentFetchedAt = null

  // --- the points ---------------------------------------------------------

  /** Hazard wins (safety first); otherwise the spectral complex when a catalogue knows it. */
  function materialFor(neo, designation) {
    if (neo.is_potentially_hazardous) return neoMaterials.hazard
    const key = taxonomyKey(details[designation]?.data?.taxonomy?.complex)
    return key ? neoMaterials[key] : neoMaterials.default
  }

  /** A measured diameter (IMCCE / JPL SBDB) beats the H-based estimate range. */
  function diameterKmOf(neo, designation) {
    const measured = details[designation]?.data?.diameter_km?.value
    return measured ?? (neo.estimated_diameter_km.min + neo.estimated_diameter_km.max) / 2
  }

  function addPoints(objects) {
    group.clear()
    entries = objects.map((neo) => {
      const pointGroup = new THREE.Group()
      const designation = designationOf(neo)
      const mesh = new THREE.Mesh(neoGeometry, materialFor(neo, designation))
      // Oversized invisible hit-sphere under the visible mesh makes small NEOs
      // easier to click without inflating what's rendered.
      const hit = new THREE.Mesh(neoHitGeometry, neoHitMaterial)
      mesh.userData.neo = neo
      hit.userData.neo = neo
      pointGroup.add(mesh, hit)
      group.add(pointGroup)

      return {
        neo,
        designation,
        diameterKm: diameterKmOf(neo, designation),
        fallbackDir: hashToDirection(neo.id),
        group: pointGroup,
        mesh,
        hit,
        positionKm: new THREE.Vector3(),
        source: null,
      }
    })
  }

  /**
   * Current position of a NEO, in km, scene axes. Linear interpolation in the
   * hourly Horizons table (a NEO's path is nearly straight over an hour); clamped
   * to the table's ends if "now" is outside the feed's date range (old cached
   * feed). Without a table: arbitrary but stable direction at the close-approach
   * distance — flagged 'approx' and said so in the modal.
   */
  const interpA = new THREE.Vector3()
  const interpB = new THREE.Vector3()

  function updatePositionKm(entry, nowSeconds) {
    const table = positions.objects[entry.designation]
    if (table && table.positions.length > 0) {
      const rows = table.positions
      const f = (nowSeconds - table.start) / positions.stepSeconds
      const clamped = THREE.MathUtils.clamp(f, 0, rows.length - 1)
      const i = Math.min(Math.floor(clamped), Math.max(rows.length - 2, 0))
      const a = rows[i]
      const b = rows[Math.min(i + 1, rows.length - 1)]
      icrfToScene(a[0], a[1], a[2], interpA)
      icrfToScene(b[0], b[1], b[2], interpB)
      entry.positionKm.lerpVectors(interpA, interpB, clamped - i)
      entry.source = clamped === f ? 'horizons' : 'horizons-clamped'
      return
    }
    if (entry.neo.close_approach) {
      entry.positionKm.copy(entry.fallbackDir).multiplyScalar(entry.neo.close_approach.miss_distance_km)
      entry.source = 'approx'
      return
    }
    entry.source = null
  }

  function describePosition(entry) {
    updatePositionKm(entry, Date.now() / 1000)
    const km = Math.round(entry.positionKm.length()).toLocaleString('fr-FR')
    switch (entry.source) {
      case 'horizons':
        return `<p><strong>Distance actuelle</strong> ${km} km <span class="muted">(position réelle, JPL Horizons)</span></p>`
      case 'horizons-clamped': {
        const table = positions.objects[entry.designation]
        const f = (Date.now() / 1000 - table.start) / positions.stepSeconds
        const edge = f < 0 ? table.start : table.start + (table.positions.length - 1) * positions.stepSeconds
        const when = new Date(edge * 1000).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
        return `<p><strong>Distance au ${when}</strong> ${km} km <span class="muted">(hors de la période du flux — clic sur « Mettre à jour »)</span></p>`
      }
      case 'approx':
        return '<p class="muted">Position approximative : direction arbitraire, placée à sa distance d\'approche la plus proche.</p>'
      default:
        return '<p class="muted">Position inconnue.</p>'
    }
  }

  // --- the selected NEO's real path around the Earth over the feed's range ---
  //
  // Same Horizons table the point itself is placed from, so the line and the NEO
  // always agree; each sample goes through the very same scale mapping, so the
  // path follows the slider. Past samples are dimmed, the closest approach is
  // ringed.

  const trajectoryLine = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 }),
  )
  trajectoryLine.frustumCulled = false // its vertices move every frame; the bounding sphere would be stale
  trajectoryLine.visible = false
  scene.add(trajectoryLine)

  // A flat ring kept facing the camera, not a wireframe sphere: a sphere's
  // triangles read as a lumpy cage once you zoom in on the NEO. Both drawings
  // position it — the geocentric path and the heliocentric orbit.
  const approachMarker = new THREE.Mesh(
    new THREE.RingGeometry(0.88, 1, 48),
    new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.85 }),
  )
  approachMarker.visible = false
  scene.add(approachMarker)

  // Arrowhead on the NEO's current position, pointing where it is going: the
  // dimmed past already says which end is which, this says it outright. A cone
  // with its base at the origin and its tip along +Y, so scaling keeps the base
  // put and the quaternion swings the tip onto the motion.
  const arrowGeometry = new THREE.ConeGeometry(0.6, 2, 12)
  arrowGeometry.translate(0, 1, 0)
  const trajectoryArrow = new THREE.Mesh(arrowGeometry, new THREE.MeshBasicMaterial({ color: 0xffffff }))
  trajectoryArrow.visible = false
  scene.add(trajectoryArrow)

  /** @type {NeoEntry|null} */
  let selected = null
  let trajectoryTable = null // the Horizons table the geometry was built from
  let trajectoryKm = null // samples in km, scene axes
  let trajectoryClosestIndex = 0

  function select(entry) {
    if (selected === entry) return
    selected = entry
    trajectoryTable = null
  }

  function entryOf(neo) {
    return entries.find((e) => e.neo === neo) ?? null
  }

  function buildTrajectory(table) {
    const rows = table.positions
    trajectoryKm = new Float32Array(rows.length * 3)
    let closest = Infinity
    const sample = new THREE.Vector3()
    rows.forEach((row, i) => {
      icrfToScene(row[0], row[1], row[2], sample)
      trajectoryKm.set([sample.x, sample.y, sample.z], i * 3)
      const distance = sample.length()
      if (distance < closest) {
        closest = distance
        trajectoryClosestIndex = i
      }
    })
    trajectoryLine.geometry.dispose()
    trajectoryLine.geometry = new THREE.BufferGeometry()
    trajectoryLine.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rows.length * 3), 3))
    trajectoryLine.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(rows.length * 3), 3))
    trajectoryTable = table
  }

  const trajectorySample = new THREE.Vector3()
  const arrowFrom = new THREE.Vector3()
  const arrowTo = new THREE.Vector3()
  const arrowDir = new THREE.Vector3()
  const ARROW_AXIS = new THREE.Vector3(0, 1, 0)

  /**
   * Puts the arrow on the NEO and aims it along the hourly segment "now" falls
   * in (the nearest end's segment when "now" is outside the table). Position
   * comes from the interpolated km vector through `placeKm`, like the dot; the
   * direction from the two placed samples, so it follows the scale's bending.
   */
  function updateArrow(nowIndex, count, t) {
    const clamped = THREE.MathUtils.clamp(nowIndex, 0, count - 1)
    const i = Math.min(Math.floor(clamped), count - 2)
    arrowFrom.fromArray(trajectoryKm, i * 3)
    arrowTo.fromArray(trajectoryKm, (i + 1) * 3)
    arrowDir.copy(arrowFrom).lerp(arrowTo, clamped - i)
    placeKm(trajectoryArrow.position, arrowDir, t)
    placeKm(arrowFrom, arrowFrom, t)
    placeKm(arrowTo, arrowTo, t)
    arrowDir.subVectors(arrowTo, arrowFrom)
    if (arrowDir.lengthSq() < 1e-20) {
      trajectoryArrow.visible = false
      return
    }
    arrowDir.normalize()
    trajectoryArrow.quaternion.setFromUnitVectors(ARROW_AXIS, arrowDir)
    // Base just past the dot rather than inside it, or the dot hides the arrow.
    trajectoryArrow.position.addScaledVector(arrowDir, selected.mesh.scale.x)
    trajectoryArrow.scale.setScalar(minRadiusAt(trajectoryArrow.position, ARROW_PX))
    trajectoryArrow.material.color.copy(selected.mesh.material.color)
    trajectoryArrow.visible = true
  }

  function updateTrajectory(nowSeconds, t) {
    // Geocentric path only makes sense centred on the Earth; the heliocentric
    // view draws the whole orbit instead (docs/points-de-vue.md).
    const table = selected && focusId() === 'earth' ? positions.objects[selected.designation] : null
    if (!table || table.positions.length < 2) {
      trajectoryLine.visible = false
      trajectoryArrow.visible = false
      approachMarker.visible = false
      return
    }
    if (table !== trajectoryTable) buildTrajectory(table)

    const linePositions = trajectoryLine.geometry.getAttribute('position')
    const colors = trajectoryLine.geometry.getAttribute('color')
    const { r, g, b } = selected.mesh.material.color
    const nowIndex = (nowSeconds - table.start) / positions.stepSeconds

    for (let i = 0; i < linePositions.count; i++) {
      trajectorySample.fromArray(trajectoryKm, i * 3)
      placeKm(trajectorySample, trajectorySample, t)
      linePositions.setXYZ(i, trajectorySample.x, trajectorySample.y, trajectorySample.z)
      const dim = i < nowIndex ? TRAJECTORY_PAST_DIM : 1
      colors.setXYZ(i, r * dim, g * dim, b * dim)
      if (i === trajectoryClosestIndex) approachMarker.position.copy(trajectorySample)
    }
    linePositions.needsUpdate = true
    colors.needsUpdate = true
    trajectoryLine.visible = true
    updateArrow(nowIndex, linePositions.count, t)

    approachMarker.visible = true
    approachMarker.quaternion.copy(camera.quaternion) // billboard
    approachMarker.scale.setScalar(
      Math.max(
        selected.mesh.scale.x * APPROACH_MARKER_NEO_FACTOR,
        minRadiusAt(approachMarker.position, APPROACH_MARKER_MIN_PX),
      ),
    )
  }

  /** Human summary of the drawn path, for the modal. */
  function describeTrajectory(entry) {
    const table = positions.objects[entry.designation]
    if (focusId() !== 'earth' || !table || table.positions.length < 2) return ''
    const closestAt = new Date((table.start + trajectoryClosestIndex * positions.stepSeconds) * 1000)
    return `<p class="muted">Trajectoire réelle tracée dans la scène (JPL Horizons) — passé atténué, cercle = passage au plus près${
      entry === selected ? ` le ${closestAt.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}` : ''
    }.</p>`
  }

  // --- the selected NEO's whole heliocentric orbit (Sun-centred view only) ---
  //
  // Kepler ellipse from the SBDB elements /api/neo/details already caches (no
  // extra request, no quota): the full revolution in a neutral cyan — solid above
  // the ecliptic, stitch-dashed below, the same convention as the SVG schematic
  // in the modal — a ±30-day arc around the close approach in the NEO's own
  // colour, and perihelion/aphelion/node markers. Samples are kept heliocentric
  // in km, scene axes, then pushed through the very same compression as every
  // body each frame, so the trace follows the slider and always passes through
  // the NEO's own point.

  const heliocentricGroup = new THREE.Group()
  heliocentricGroup.visible = false
  scene.add(heliocentricGroup)

  const orbitFrame = { parent: heliocentricGroup, frame: 'heliocentric' }
  const orbitAbove = traces.make(ORBIT_COLOR, 0.8, orbitFrame)
  const orbitBelow = traces.make(ORBIT_COLOR, 0.55, orbitFrame)
  const orbitArc = traces.make(0xffffff, 1, orbitFrame) // recoloured with the NEO

  function makeOrbitMarker(color, filled) {
    const mesh = new THREE.Mesh(
      filled ? new THREE.SphereGeometry(1, 12, 12) : new THREE.RingGeometry(0.7, 1, 24),
      new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }),
    )
    mesh.visible = false
    heliocentricGroup.add(mesh)
    return mesh
  }

  const orbitMarkers = {
    perihelion: makeOrbitMarker(0xffcc33, true),
    aphelion: makeOrbitMarker(0x9fd2ff, true),
    ascending: makeOrbitMarker(ORBIT_COLOR, false),
    descending: makeOrbitMarker(ORBIT_COLOR, false),
  }

  // The elements the drawn orbit was built from, so a NEO selected before its
  // sheet arrived gets its trace as soon as /api/neo/details answers.
  let orbitBuiltFrom = null
  let orbitApproachKm = null // the approach point, km, scene axes — null if unknown

  /**
   * Elements of one object, or null when there is no ellipse to sample: the
   * sheet hasn't landed, or the solution is parabolic/hyperbolic and has no
   * revolution at all. The single admissibility test for every drawing here.
   */
  function ellipseElements(designation) {
    const orbit = details[designation]?.data?.orbit
    return orbit && orbit.e >= 0 && orbit.e < 1 && orbit.a_au > 0 ? orbit : null
  }

  /** Elements of the selected NEO, or null while its sheet is missing. */
  function selectedOrbitElements() {
    return selected ? ellipseElements(selected.designation) : null
  }

  function buildHeliocentricOrbit(orbit) {
    const points = sampleOrbit(orbit, ORBIT_SAMPLES)
    traces.setAu(orbitAbove, points, (i) => points[i].z >= 0)
    traces.setAu(orbitBelow, points, (i) => points[i].z < 0 && i % ORBIT_DASH_STRIDE === 0)

    // Arc around the close approach — clamped so a short-period object doesn't
    // get an "arc" wrapping its whole orbit twice.
    const approach = selected.neo.close_approach
    const approachAt = approach ? new Date(approach.datetime ?? `${approach.date}T12:00Z`) : null
    if (approachAt && !Number.isNaN(approachAt.getTime())) {
      const jd = julianDate(approachAt)
      const halfWindow = Math.min(ORBIT_ARC_DAYS, (orbit.period_days ?? 4 * ORBIT_ARC_DAYS) / 4)
      traces.setAu(orbitArc, sampleOrbitBetween(orbit, jd - halfWindow, jd + halfWindow, ORBIT_ARC_SAMPLES), () => true)
      orbitApproachKm = eclipticAuToSceneKm(orbitPosition(orbit, jd), new THREE.Vector3())
    } else {
      traces.setAu(orbitArc, [], () => false)
      orbitApproachKm = null
    }

    const { perihelion, aphelion } = orbitApsides(orbit)
    const { ascending, descending } = orbitNodes(orbit)
    for (const [key, point] of Object.entries({ perihelion, aphelion, ascending, descending })) {
      orbitMarkers[key].userData.km = eclipticAuToSceneKm(point, new THREE.Vector3())
    }

    orbitArc.line.material.color.copy(selected.mesh.material.color)
    orbitBuiltFrom = orbit
  }

  function updateHeliocentricOrbit(t) {
    const orbit = neoEllipsesVisible(focusId(), t) ? selectedOrbitElements() : null
    heliocentricGroup.visible = orbit !== null
    if (!orbit) {
      orbitBuiltFrom = null
      return
    }
    if (orbit !== orbitBuiltFrom) buildHeliocentricOrbit(orbit)

    for (const trace of [orbitAbove, orbitBelow, orbitArc]) traces.update(trace, t)

    for (const mesh of Object.values(orbitMarkers)) {
      placeRelativeKm(mesh.position, mesh.userData.km, t)
      mesh.quaternion.copy(camera.quaternion) // billboard, like the approach ring
      mesh.scale.setScalar(minRadiusAt(mesh.position, ORBIT_MARKER_PX))
      mesh.visible = true
    }

    if (orbitApproachKm) {
      placeRelativeKm(approachMarker.position, orbitApproachKm, t)
      approachMarker.quaternion.copy(camera.quaternion)
      approachMarker.scale.setScalar(
        Math.max(selected.mesh.scale.x * APPROACH_MARKER_NEO_FACTOR, minRadiusAt(approachMarker.position, APPROACH_MARKER_MIN_PX)),
      )
      approachMarker.visible = true
    }
  }

  /** Human summary of the heliocentric trace, for the modal. `t` is the slider's own value. */
  function describeOrbit(entry, t) {
    if (focusId() !== 'sun') return ''
    const orbit = entry === selected ? selectedOrbitElements() : null
    if (!orbit) return ''
    if (!neoEllipsesVisible(focusId(), t)) {
      return `<p class="muted">Orbite complète visible en échelle réelle (Maj + molette jusqu'à « 100 % réel ») :
      en échelle comprimée, la courbe déforme les ellipses.</p>`
    }
    return `<p class="muted">Orbite complète tracée dans la scène (képlérienne, éléments JPL SBDB) —
    trait plein au-dessus de l'écliptique, pointillé en dessous, arc vif = ±${ORBIT_ARC_DAYS} jours autour de l'approche.</p>`
  }

  // --- the whole feed's orbits at once (opt-in, Sun-centred view only) -------
  //
  // Same elements, same compression, same frame as the selected NEO's ellipse —
  // the only new thing is that all of them share two polylines instead of
  // getting one each (`bundleOrbitSamples` in orbit.js). Two, not one, because
  // the hazardous ones are drawn brighter and in their own colour.
  //
  // Costs no request: /api/neo/details is already fetched for every object of
  // the feed, for the point colours and the modal, so the elements are in
  // localStorage before this is ever switched on.

  const allOrbitsGroup = new THREE.Group()
  allOrbitsGroup.visible = false
  scene.add(allOrbitsGroup)

  const allOrbits = {
    default: traces.make(NEO_DEFAULT_COLOR, ALL_ORBITS_OPACITY, { parent: allOrbitsGroup, frame: 'heliocentric' }),
    hazard: traces.make(NEO_HAZARD_COLOR, ALL_ORBITS_HAZARD_OPACITY, { parent: allOrbitsGroup, frame: 'heliocentric' }),
  }

  let allOrbitsEnabled = false
  // The panel's "Points dans la scène" box. It commands the orbits box: with
  // the points hidden there is nothing for an orbit to belong to, so the
  // bundles, the selected NEO's drawings and picking all go with them — but
  // the orbits choice itself is kept and comes back with the points.
  let pointsEnabled = true
  // Raised whenever the elements behind the bundles changed — a new feed, or a
  // batch of sheets landing — and acted on lazily, in update(): rebuilding
  // while the box is unticked would re-sample a hundred ellipses for nothing.
  let allOrbitsStale = true

  /** Drawable elements of every object of the feed, split by hazard. */
  function allOrbitElements() {
    const split = { default: [], hazard: [] }
    for (const entry of entries) {
      const orbit = ellipseElements(entry.designation)
      if (orbit) split[entry.neo.is_potentially_hazardous ? 'hazard' : 'default'].push(orbit)
    }
    return split
  }

  function buildAllOrbits() {
    for (const [key, orbits] of Object.entries(allOrbitElements())) {
      const { points, keepSegment } = bundleOrbitSamples(orbits, ALL_ORBITS_SAMPLES)
      traces.setAu(allOrbits[key], points, keepSegment)
    }
    allOrbitsStale = false
  }

  function updateAllOrbits(t) {
    // Sun pivot at 100 % réel only, like the selected NEO's ellipse
    // (`neoEllipsesVisible`). Not because the frame forbids other pivots —
    // since 2026-10-12 it would draw correctly from any — but because every
    // compressed curve bends the ellipses and a hundred of them pile up; the
    // geocentric one squeezes the whole solar system into seven scene units
    // (19,1 to 26,2, measured in scene/planets.js). See `neo-ellipse-pivot` in
    // docs/agent/backlog.md.
    allOrbitsGroup.visible = pointsEnabled && allOrbitsEnabled && neoEllipsesVisible(focusId(), t)
    if (!allOrbitsGroup.visible) return
    if (allOrbitsStale) buildAllOrbits()
    for (const trace of Object.values(allOrbits)) traces.update(trace, t)
  }

  // --- per-frame placement -------------------------------------------------

  const earthPlaced = new THREE.Vector3()
  const ORIGIN_KM = new THREE.Vector3()
  const spreads = []

  /**
   * The dots' pixel floor for this frame, from the cloud's spread on screen:
   * the median placed NEO's distance to the placed Earth, in pixels at the
   * Earth. Measured on placed positions, so it holds for every pivot and every
   * scale — NEOs are geocentric whatever the scene is centred on.
   */
  function floorPx(t) {
    placeKm(earthPlaced, ORIGIN_KM, t)
    spreads.length = 0
    for (const entry of entries) if (entry.source) spreads.push(entry.group.position.distanceTo(earthPlaced))
    if (spreads.length === 0) return neoFloorPx(Infinity)
    spreads.sort((a, b) => a - b)
    return neoFloorPx(spreads[spreads.length >> 1] / minRadiusAt(earthPlaced, 1))
  }

  /** Places every point at the current instant and scale, then the two drawings. */
  function update(nowSeconds, t) {
    for (const entry of entries) {
      updatePositionKm(entry, nowSeconds)
      entry.group.visible = entry.source !== null
      if (entry.source) placeKm(entry.group.position, entry.positionKm, t)
    }
    const floor = floorPx(t)
    let minKm = Infinity
    let maxKm = 0
    for (const entry of entries) {
      if (!entry.source) continue
      minKm = Math.min(minKm, entry.diameterKm)
      maxKm = Math.max(maxKm, entry.diameterKm)
    }
    for (const entry of entries) {
      if (!entry.source) continue
      // Never under the 1 px dot, even for the smallest at the -25 % end.
      const px = Math.max(NEO_FLOOR_PX.min, floor * neoFloorFactor(entry.diameterKm, minKm, maxKm))
      const radius = Math.max(neoRadius(entry.diameterKm, t), minRadiusAt(entry.group.position, px))
      entry.mesh.scale.setScalar(radius)
      entry.hit.scale.setScalar(Math.max(radius, minRadiusAt(entry.group.position, NEO_HIT_MIN_RADIUS_PX)))
    }
    group.visible = pointsEnabled
    if (pointsEnabled) {
      updateTrajectory(nowSeconds, t)
      updateHeliocentricOrbit(t)
    } else {
      trajectoryLine.visible = false
      trajectoryArrow.visible = false
      approachMarker.visible = false
      heliocentricGroup.visible = false
      orbitBuiltFrom = null
    }
    updateAllOrbits(t)
  }

  // --- loading -------------------------------------------------------------

  /**
   * Sheets from JPL SBDB / IMCCE ssoCard / Sentry for the given designations,
   * in background batches: they colour the points by spectral type, give the
   * measured diameter when one exists, and fill the modal. Cached in
   * localStorage per designation (not per feed) — these catalogues barely move.
   */
  async function loadDetails(designations) {
    const missing = [...new Set(designations)].filter(
      (d) => !(d in details) && !detailsLoading.has(d) && DESIGNATION_PATTERN.test(d),
    )
    if (missing.length === 0) return
    for (const designation of missing) detailsLoading.add(designation)
    on.detailsProgress()

    for (let i = 0; i < missing.length; i += NEO_DETAILS_BATCH) {
      const batch = missing.slice(i, i + NEO_DETAILS_BATCH)
      try {
        const { objects } = await fetchNeoDetails(batch)
        const now = Date.now()
        for (const [designation, data] of Object.entries(objects)) {
          details[designation] = { data, fetchedAt: now }
          detailsErrors.delete(designation)
        }
        saveCached('neo-details', details)
        applyDetails()
      } catch (err) {
        for (const designation of batch) detailsErrors.set(designation, err.message)
      } finally {
        for (const designation of batch) detailsLoading.delete(designation)
      }
      on.detailsProgress()
    }
  }

  /** Re-colours and re-sizes the points once their sheets are known. */
  function applyDetails() {
    // Elements just landed for a batch, so the bundled orbits are a batch short.
    allOrbitsStale = true
    for (const entry of entries) {
      entry.mesh.material = materialFor(entry.neo, entry.designation)
      entry.diameterKm = diameterKmOf(entry.neo, entry.designation)
    }
    on.detailsApplied()
  }

  /**
   * Real NEO positions from JPL Horizons (keyless, not part of the NASA quota).
   * Cached in localStorage per feed date range; only designations not cached yet
   * are fetched, in small batches so the scene fills in progressively. NEOs
   * without a position meanwhile show at their approximate (fallback) spot.
   */
  async function loadPositions(feed) {
    const range = `${feed.start_date}_${feed.end_date}`
    const cached = loadCached('neo-positions')
    positions = cached && cached.data.range === range ? cached.data : { range, stepSeconds: 3600, objects: {} }

    const missing = [...new Set(entries.map((e) => e.designation))].filter((d) => !(d in positions.objects))
    // The backend rejects anything outside this pattern for the whole batch.
    for (const designation of missing.filter((d) => !DESIGNATION_PATTERN.test(d))) {
      positions.objects[designation] = null
    }
    const fetchable = missing.filter((d) => DESIGNATION_PATTERN.test(d))

    positionsLoading = fetchable.length > 0
    on.positionsChanged(false)

    for (let i = 0; i < fetchable.length; i += NEO_POSITIONS_BATCH) {
      let res
      try {
        res = await fetchNeoPositions(feed.start_date, feed.end_date, fetchable.slice(i, i + NEO_POSITIONS_BATCH))
      } catch {
        break // leave the rest approximate; retried on next load
      }
      if (feed !== currentFeed) return // superseded by a newer feed meanwhile
      positions.stepSeconds = res.step_seconds
      Object.assign(positions.objects, res.objects)
      saveCached('neo-positions', positions)
      on.positionsChanged(false)
    }

    if (feed !== currentFeed) return
    positionsLoading = false
    on.positionsChanged(true)
  }

  /** A new feed replaces the points and starts both background loads. */
  function showFeed(feed, fetchedAt) {
    currentFeed = feed
    currentFetchedAt = fetchedAt
    allOrbitsStale = true
    select(null)
    addPoints(feed.objects)
  }

  /** Starts the two background loads for the feed just shown. */
  function loadFeedExtras(feed) {
    loadPositions(feed)
    loadDetails(entries.map((entry) => entry.designation))
  }

  return {
    /** The group the NEO points live in — picking raycasts against it. */
    group,
    get entries() {
      return entries
    },
    get currentFeed() {
      return currentFeed
    },
    get currentFetchedAt() {
      return currentFetchedAt
    },
    /** `.visible` and the marker positions feed the scene labels. */
    heliocentricGroup,
    orbitMarkers,
    showFeed,
    loadFeedExtras,
    /**
     * Recomputes every point's position at `nowSeconds` outside the render
     * loop — the scale label and the camera anchors quote those distances and
     * must not read a frame-old table.
     */
    refreshPositions(nowSeconds) {
      for (const entry of entries) updatePositionKm(entry, nowSeconds)
    },
    loadDetails,
    select,
    entryOf,
    /** Forces the drawn orbit to be rebuilt — the pivot changed under it. */
    invalidateOrbit() {
      orbitBuiltFrom = null
    },
    /** The whole feed's orbits, on or off (off by default — see ALL_ORBITS_SAMPLES). */
    setAllOrbits(enabled) {
      allOrbitsEnabled = enabled
    },
    /**
     * For the panel's checkbox. `available` is counted from the sheets rather
     * than from what is drawn: the panel is redrawn the moment the box is
     * ticked, one frame before the bundles exist.
     */
    /** The NEO points on or off — and with them every NEO drawing (see pointsEnabled). */
    setPoints(enabled) {
      pointsEnabled = enabled
      if (!enabled) select(null)
    },
    allOrbitsStatus() {
      return {
        points: pointsEnabled,
        enabled: allOrbitsEnabled,
        available: entries.filter((entry) => ellipseElements(entry.designation)).length,
        total: entries.length,
      }
    },
    update,
    /** What the sheet for one designation currently holds, for the modal. */
    sheet(designation) {
      return {
        data: details[designation]?.data,
        loading: detailsLoading.has(designation),
        error: detailsErrors.get(designation) ?? null,
      }
    },
    /** For the panel's positions line: how many of the points have a real position. */
    positionsStatus() {
      return {
        known: entries.filter((e) => positions.objects[e.designation]).length,
        total: entries.length,
        loading: positionsLoading,
      }
    },
    describePosition,
    describeTrajectory,
    describeOrbit,
  }
}
