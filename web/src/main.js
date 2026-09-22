import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { fetchIssPosition, fetchNeoFeed, fetchApod, fetchUsage } from './api.js'
import { loadCached, saveCached } from './cache.js'
import { getSunEquatorial, getMoonEquatorial, getGreenwichSiderealTime } from './astronomy.js'
import { orbitSchematicSvg } from './orbit.js'
import { FOCUSES } from './focus.js'
import { createPanels } from './ui/panels.js'
import { createStarfield } from './scene/starfield.js'
import { createPicking } from './picking.js'
import { createOrbitTraces } from './scene/orbitTrace.js'
import { createNeoScene, designationOf } from './neo/scene.js'
import { createSceneLabels, LABEL_RING_MIN_RADIUS_PX, LABEL_WHEN_SMALLER_THAN_PX } from './labels.js'
import { latLngToVector3 } from './scene/geo.js'
import { MOON_RADIUS, makeGlobe, makeIssMarker, makeSunMarker, makeMoon, createDistanceRings } from './scene/bodies.js'
import {
  NEO_DEFAULT_COLOR,
  NEO_HAZARD_COLOR,
  NEO_CREDITS,
  TAXONOMY,
  taxonomyKey,
  cssColor,
  escapeHtml,
  sourcesBlockHtml,
  detailsBlockHtml,
} from './neoInfo.js'
import {
  AU_KM,
  EARTH_RADIUS,
  LUNAR_DISTANCE_KM,
  ISS_READABLE_RADIUS,
  SUN_READABLE_RADIUS,
  SCALE_STEPS,
  lerpLog,
  sceneDistance,
  sceneDistanceToKm,
  earthSystemScale,
  issOrbitRadius,
  issRadius,
  sunRadius,
  worldPerPixel,
  describeScale,
  remapCameraDistance,
} from './scale.js'

// Distances and sizes of everything but the Earth depend on the "réalisme"
// scale (scaleT, see scale.js and docs/echelle-reelle.md): readable at 0,
// true proportions at 1. The light only needs a direction.
const SUN_LIGHT_DISTANCE = 30

// Floor on each body's on-screen radius, in pixels — at true scale almost
// everything is sub-pixel (the whole Earth–Moon system is ~5 px when framing a
// NEO at 0.5 au), so without these nothing would show at all.
const MIN_RADIUS_PX = { earth: 2, moon: 1.5, iss: 2.5, sun: 3 }

const app = document.getElementById('app')

// --- scene setup ---------------------------------------------------------

const scene = new THREE.Scene()
// Far plane covers the Sun at true scale (~47 000 units); the logarithmic
// depth buffer keeps that range from z-fighting close to the Earth.
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 1e6)
camera.position.set(0, 3, 8)

const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true })
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
app.appendChild(renderer.domElement)

const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
// min/max distance and zoom speed follow the scale — see updateCameraLimits().
controls.minDistance = 3.5
controls.maxDistance = 20

renderer.outputColorSpace = THREE.SRGBColorSpace

// Dimmed vs. the old flat-shaded globe (0.6): the day/night shader now handles
// day-side lighting explicitly and the night texture supplies its own city
// lights, so a strong ambient would wash both out.
scene.add(new THREE.AmbientLight(0xffffff, 0.15))
const sunLight = new THREE.DirectionalLight(0xffffff, 1.2)
scene.add(sunLight)

// The sky loads itself in the background and never blocks the scene (scene/starfield.js).
const starfield = createStarfield(scene)

const { group: globe, material: globeMaterial, sphere: globeSphere } = makeGlobe()
scene.add(globe)

// Child of globe (not scene) so it turns with the real Earth rotation set in
// animate() — its position is computed in the globe's own unrotated
// lat/lng frame, same as the texture, so it always sits over the right spot.
const issMarker = makeIssMarker()
issMarker.visible = false // until a position is known
globe.add(issMarker)

const sunMarker = makeSunMarker()
scene.add(sunMarker)

const moon = makeMoon()
scene.add(moon)

const distanceRings = createDistanceRings(scene)

// --- astronomy (real Sun/Moon positions) --------------------------------------

/**
 * Real equatorial Sun direction (right ascension/declination, same convention
 * as star placement) drives the light, the visible Sun marker, and (via the
 * globe's shader uniform, in world space) the day/night terminator. This is a
 * fixed-stars-style frame, deliberately NOT tied to the globe's own real
 * rotation (set from GMST in animate(), see docs/agent/decisions.md) — the
 * shader transforms its own normal into world space via modelMatrix each
 * fragment, so the globe's spin sweeps the terminator across the texture with
 * no extra per-frame JS work needed.
 */
const sunDirWorld = new THREE.Vector3()
const moonDirWorld = new THREE.Vector3()
let moonDistanceKm = LUNAR_DISTANCE_KM
let sunDistanceKm = AU_KM

// Geocentric positions in km, scene axes — the common frame every placement
// goes through, whichever body the scene is centred on (see placeKm()).
const sunPositionKm = new THREE.Vector3()
const moonPositionKm = new THREE.Vector3()
const EARTH_POSITION_KM = new THREE.Vector3(0, 0, 0)

function updateAstronomy() {
  const now = new Date()

  const { ra, dec, distanceKm } = getSunEquatorial(now)
  sunDirWorld.copy(latLngToVector3(dec, ra, 1))
  sunDistanceKm = distanceKm
  sunPositionKm.copy(sunDirWorld).multiplyScalar(sunDistanceKm)
  sunLight.position.copy(sunDirWorld).multiplyScalar(SUN_LIGHT_DISTANCE)
  // The globe shader reads sunDirection in world space and does its own
  // modelMatrix transform per-fragment, so the globe's real rotation (set
  // from GMST in animate()) sweeps the terminator across the texture with
  // no extra per-frame work here.
  globeMaterial.uniforms.sunDirection.value.copy(sunDirWorld)

  // Real direction and distance only — where that lands in the scene depends
  // on the current scale, applied per frame in applyScale().
  const moonPos = getMoonEquatorial(now)
  moonDirWorld.copy(latLngToVector3(moonPos.dec, moonPos.ra, 1))
  moonDistanceKm = moonPos.distanceKm
  moonPositionKm.copy(moonDirWorld).multiplyScalar(moonDistanceKm)
}

// --- point de vue (le corps au centre de la scène) ----------------------------
//
// The pivot IS the scene's origin: nothing is drawn at an absolute position,
// everything goes through placeKm() below. Switching pivot therefore only
// changes two things — which position is subtracted, and which readable curve
// compresses what's left (docs/points-de-vue.md).

let focusId = 'earth'
const focusOf = () => FOCUSES[focusId]
const focusPositionKm = () => (focusId === 'sun' ? sunPositionKm : EARTH_POSITION_KM)
/** The pivot's own radius in scene units — what the camera must not enter. */
const focusRadius = (t) => (focusId === 'sun' ? sunRadius(t, true) : EARTH_RADIUS)

const placeRelative = new THREE.Vector3()

/** Scene position of a body known by its geocentric km vector, at scale t. */
function placeKm(out, geocentricKm, t) {
  placeRelative.subVectors(geocentricKm, focusPositionKm())
  const distanceKm = placeRelative.length()
  if (distanceKm < 1e-6) return out.set(0, 0, 0)
  return out.copy(placeRelative).multiplyScalar(sceneDistance(distanceKm, t, focusOf().curve) / distanceKm)
}

/** Same, for a sample already expressed relative to the pivot (orbit traces). */
function placeRelativeKm(out, relativeKm, t) {
  const distanceKm = relativeKm.length()
  if (distanceKm < 1e-6) return out.set(0, 0, 0)
  return out.copy(relativeKm).multiplyScalar(sceneDistance(distanceKm, t, focusOf().curve) / distanceKm)
}

updateAstronomy()
// Real drift is slow (~1°/day for the Sun, ~0.5°/h for the Moon) — no need to
// recompute every frame. The drawn orbits are re-sampled with it so their first
// sample stays the body's current position (rebuildBodyOrbits()).
setInterval(() => {
  updateAstronomy()
  rebuildBodyOrbits()
}, 60_000)

// --- NEOs ----------------------------------------------------------------------

// Orbit traces are shared: the NEO's ellipse and the Moon's and Earth's own
// orbits are the same kind of line, re-projected every frame.
const traces = createOrbitTraces({ placeKm, placeRelativeKm })

// The NEO points, the sheets that colour them, their real positions, and the
// two drawings of the selected one all live together (neo/scene.js) — they
// share a selection, a colour and an approach ring.
const neoScene = createNeoScene({
  scene,
  camera,
  traces,
  placeKm,
  placeRelativeKm,
  minRadiusAt,
  focusId: () => focusId,
  on: {
    // A sheet arriving changes what the modal can show, then what the legend
    // and the scale label know about diameters.
    detailsProgress: () => {
      if (modalNeo) renderNeoModal()
    },
    detailsApplied: () => {
      if (neoScene.currentFeed) renderNeoPanel(neoScene.currentFeed, null, neoScene.currentFetchedAt)
      renderScalePanel()
    },
    positionsChanged: (settled) => {
      renderNeoPositionsStatus()
      if (settled) renderScalePanel()
    },
  },
})

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

// Straight in the scene, not in a group: the Earth's orbit is the heliocentric
// view's own yardstick (and its 1 au circle), worth drawing even with nothing
// selected. The Moon's samples are geocentric like every body position, so it
// goes through placeKm() rather than the pivot-relative path.
const earthOrbitTrace = traces.make(0x4fa8ff, 0.5, { parent: scene })
const moonOrbitTrace = traces.make(0x8ea3b8, 0.5, { parent: scene, relativeToPivot: false })

function sampleBodyOrbit(count, days, positionAt) {
  return Array.from({ length: count + 1 }, (_, i) =>
    positionAt(new Date(Date.now() + (i / count) * days * DAY_MS)),
  )
}

function rebuildBodyOrbits() {
  traces.setKm(
    moonOrbitTrace,
    sampleBodyOrbit(MOON_ORBIT_SAMPLES, MOON_ORBIT_DAYS, (date) => {
      const { ra, dec, distanceKm } = getMoonEquatorial(date)
      return latLngToVector3(dec, ra, distanceKm)
    }),
    () => true,
  )
  traces.setKm(
    earthOrbitTrace,
    sampleBodyOrbit(EARTH_ORBIT_SAMPLES, EARTH_ORBIT_DAYS, (date) => {
      // The Earth seen from the Sun is the Sun seen from the Earth, negated —
      // the same vector the globe is placed from.
      const { ra, dec, distanceKm } = getSunEquatorial(date)
      return latLngToVector3(dec, ra, distanceKm).negate()
    }),
    () => true,
  )
}

rebuildBodyOrbits()

/** Each is meaningless from the other pivot: the Moon's collapses onto the Earth, and vice versa. */
function updateBodyOrbits(t) {
  if (focusId === 'earth') traces.update(moonOrbitTrace, t)
  else moonOrbitTrace.line.visible = false

  if (focusId === 'sun') traces.update(earthOrbitTrace, t)
  else earthOrbitTrace.line.visible = false
}

// --- ISS -------------------------------------------------------------------------

let issPosition = null

function applyIssPosition(position) {
  issPosition = position
  issMarker.visible = true
}

// --- scale ("réalisme") ------------------------------------------------------------

let scaleStep = 0 // slider position, 0..SCALE_STEPS
let scaleT = 0 // current value, animated toward scaleStep / SCALE_STEPS
let scaleTransition = null // { from, to, startMs }
const SCALE_TRANSITION_MS = 1500

function setScaleStep(step) {
  const next = THREE.MathUtils.clamp(Math.round(step), 0, SCALE_STEPS)
  if (next === scaleStep && !scaleTransition) return
  scaleStep = next
  scaleTransition = { from: scaleT, to: next / SCALE_STEPS, startMs: performance.now() }
  renderScalePanel()
}

/** NEO distances from the current pivot — what the scale label and the camera anchors quote. */
function neoDistancesKm() {
  neoScene.refreshPositions(Date.now() / 1000)
  return neoScene.entries.filter((e) => e.source).map((e) => e.positionKm.distanceTo(focusPositionKm()))
}

/** The pivot's yardsticks, at their real current distance. */
function focusReferences() {
  return focusId === 'sun' ? [{ label: 'Terre', km: sunDistanceKm }] : [{ label: 'Lune', km: moonDistanceKm }]
}

function medianOf(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[sorted.length >> 1]
}

/**
 * Camera distances that should "stay put" relative to the scene when t
 * changes: close to the surface (unchanged), the Moon, the median NEO.
 * Filtered to stay strictly increasing at both t values.
 */
function cameraAnchors(tFrom, tTo, neoMedianKm) {
  const from = [controls.minDistance]
  const to = [controls.minDistance]
  const curve = focusOf().curve
  const candidates = focusReferences().map((reference) => reference.km)
  if (neoMedianKm !== null) candidates.push(neoMedianKm)
  for (const km of candidates) {
    const a = sceneDistance(km, tFrom, curve)
    const b = sceneDistance(km, tTo, curve)
    if (a > from[from.length - 1] && b > to[to.length - 1]) {
      from.push(a)
      to.push(b)
    }
  }
  return { from, to }
}

const cameraOffset = new THREE.Vector3()

function stepScaleTransition(nowMs) {
  if (!scaleTransition) return
  const u = Math.min(1, (nowMs - scaleTransition.startMs) / SCALE_TRANSITION_MS)
  const eased = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2
  const next = THREE.MathUtils.lerp(scaleTransition.from, scaleTransition.to, eased)

  const { from, to } = cameraAnchors(scaleT, next, medianOf(neoDistancesKm()))
  cameraOffset.subVectors(camera.position, controls.target)
  cameraOffset.setLength(remapCameraDistance(cameraOffset.length(), from, to))
  camera.position.copy(controls.target).add(cameraOffset)

  scaleT = next
  if (u === 1) scaleTransition = null
}

/** Zoom range follows how far the scene extends at the current scale. */
function updateCameraLimits() {
  const curve = focusOf().curve
  let farthest = 0
  for (const reference of focusReferences()) {
    farthest = Math.max(farthest, sceneDistance(reference.km, scaleT, curve))
  }
  for (const entry of neoScene.entries) {
    if (entry.source) farthest = Math.max(farthest, sceneDistance(entry.positionKm.distanceTo(focusPositionKm()), scaleT, curve))
  }
  // The drawn orbit is part of the scene's extent: you must be able to pull
  // back far enough to see the whole ellipse, aphelion included.
  if (neoScene.heliocentricGroup.visible) {
    farthest = Math.max(farthest, neoScene.orbitMarkers.aphelion.position.length())
  }
  // The pivot is the anchor: never let the camera dive inside it (the Sun at
  // true scale is 218 units across, where the Earth is 2).
  controls.minDistance = focusRadius(scaleT) * lerpLog(1.75, 1.3, scaleT)
  controls.maxDistance = Math.max(20, farthest * 2.5)
  // OrbitControls' dolly is multiplicative (×0.95 per wheel notch at speed 1):
  // spanning 2.6 → ~60 000 would take ~190 notches without this.
  controls.zoomSpeed = Math.max(1, Math.log(controls.maxDistance / controls.minDistance) / 3)
}

// --- changer de point de vue ------------------------------------------------------

const focusOffset = new THREE.Vector3()

/**
 * Switching pivot re-places the whole scene at once — interpolating between two
 * different compressions would mean nothing visually — but the camera keeps its
 * direction and the same *physical* framing: its distance is read back as a real
 * distance through the old curve, then re-compressed with the new one.
 */
function setFocus(nextId) {
  if (nextId === focusId || !FOCUSES[nextId]) return

  focusOffset.subVectors(camera.position, controls.target)
  const framedKm = sceneDistanceToKm(focusOffset.length(), scaleT, focusOf().curve)

  focusId = nextId
  recenterTween = null
  distanceRings.rebuild(focusOf().rings)
  rebuildRingLabels()
  neoScene.invalidateOrbit()

  controls.target.set(0, 0, 0)
  updateCameraLimits()
  // Same physical distance — but bounded so the switch always lands on
  // something worth looking at: hugging the Earth at 130 000 km is *inside*
  // the Sun (radius 696 000 km), and framing the NEO cloud from the Earth is
  // a pinhole around the Sun.
  const reference = focusReferences()[0]
  const framed = sceneDistance(framedKm, scaleT, focusOf().curve)
  const closest = Math.max(controls.minDistance, focusRadius(scaleT) * 3)
  const furthest = Math.min(controls.maxDistance, sceneDistance(reference.km, scaleT, focusOf().curve) * 1.8)
  camera.position.copy(focusOffset.setLength(THREE.MathUtils.clamp(framed, closest, Math.max(closest, furthest))))

  renderScalePanel()
  renderViewPanel()
  if (modalNeo) renderNeoModal()
}

// Dragging with the right button wanders off the pivot; this brings it back to
// the centre of the view without touching the zoom or the viewing angle.
const RECENTER_MS = 600
let recenterTween = null

function recenterCamera() {
  if (controls.target.lengthSq() > 1e-12) recenterTween = { from: controls.target.clone(), startMs: performance.now() }
}

const recenterTarget = new THREE.Vector3()

function stepRecenter(nowMs) {
  if (!recenterTween) return
  const u = Math.min(1, (nowMs - recenterTween.startMs) / RECENTER_MS)
  const eased = 1 - Math.pow(1 - u, 3)
  recenterTarget.copy(recenterTween.from).multiplyScalar(1 - eased)
  camera.position.add(recenterTarget).sub(controls.target)
  controls.target.copy(recenterTarget)
  if (u === 1) recenterTween = null
}

const tmpWorldPos = new THREE.Vector3()

/** Scene radius needed for `px` pixels at a world position, given the current camera. */
function minRadiusAt(worldPos, px) {
  const distance = camera.position.distanceTo(worldPos)
  return px * worldPerPixel(distance, camera.fov, renderer.domElement.clientHeight)
}

/** The Earth's drawn radius in world units — system scale and pixel floor included. */
function earthWorldRadius() {
  return EARTH_RADIUS * globe.scale.x * globeSphere.scale.x
}

/** Places and sizes every scale-dependent object for scaleT and the current camera. */
function applyScale(nowSeconds) {
  const t = scaleT
  const isEarthFocus = focusId === 'earth'
  // Shrinking the globe *group* (not just the sphere) takes the ISS with it,
  // so low orbit stays low orbit when the Earth is only a marker.
  const earthScale = earthSystemScale(t, isEarthFocus)

  placeKm(globe.position, EARTH_POSITION_KM, t)
  globe.scale.setScalar(earthScale)
  const earthRadius = Math.max(EARTH_RADIUS * earthScale, minRadiusAt(globe.position, MIN_RADIUS_PX.earth))
  globeSphere.scale.setScalar(earthRadius / (EARTH_RADIUS * earthScale))

  placeKm(moon.position, moonPositionKm, t)
  const moonRadius = MOON_RADIUS * earthScale
  moon.scale.setScalar(Math.max(moonRadius, minRadiusAt(moon.position, MIN_RADIUS_PX.moon)) / MOON_RADIUS)

  placeKm(sunMarker.position, sunPositionKm, t)
  sunMarker.scale.setScalar(
    Math.max(sunRadius(t, focusId === 'sun'), minRadiusAt(sunMarker.position, MIN_RADIUS_PX.sun)) / SUN_READABLE_RADIUS,
  )

  // Low orbit is invisible from any other pivot (the Moon is already back on
  // top of the Earth there), and an ISS dot pinned at the Earth's pixel would
  // only add noise.
  issMarker.visible = issPosition !== null && isEarthFocus
  if (issPosition && isEarthFocus) {
    issMarker.position.copy(
      latLngToVector3(issPosition.latitude, issPosition.longitude, issOrbitRadius(issPosition.altitude_km, t)),
    )
    issMarker.getWorldPosition(tmpWorldPos)
    issMarker.scale.setScalar(
      Math.max(issRadius(t), minRadiusAt(tmpWorldPos, MIN_RADIUS_PX.iss)) / ISS_READABLE_RADIUS,
    )
  }

  distanceRings.group.visible = t > 0.001
  for (const ring of distanceRings.list) {
    ring.line.scale.setScalar(sceneDistance(ring.distanceKm, t, focusOf().curve))
  }

  updateBodyOrbits(t)
  neoScene.update(nowSeconds, t)
}

// --- UI overlay --------------------------------------------------------------

// The overlay owns its markup, its wording and its DOM events (ui/panels.js);
// the scene keeps its state and hands it over already computed. What comes back
// are the render entry points and the three containers drawn into below.
const panels = createPanels({
  app,
  wheelTarget: renderer.domElement,
  on: {
    update: async () => {
      await Promise.all([refreshIss(), refreshNeo(), refreshApod()])
      await refreshUsage()
    },
    scaleStep: (step) => setScaleStep(step),
    scaleStepBy: (direction) => setScaleStep(scaleStep + direction),
    focus: (id) => setFocus(id),
    recenter: () => recenterCamera(),
    deselect: () => neoScene.select(null),
    modalClosed: () => {
      modalNeo = null
    },
  },
})
const { sceneLabels } = panels

/** Legend swatches: the two constant colours, plus every spectral complex actually loaded. */
function neoLegend() {
  const present = new Set()
  for (const entry of neoScene.entries) {
    if (entry.neo.is_potentially_hazardous) continue
    const key = taxonomyKey(neoScene.sheet(entry.designation).data?.taxonomy?.complex)
    if (key) present.add(key)
  }
  return [
    { color: cssColor(NEO_DEFAULT_COLOR), label: 'standard' },
    { color: cssColor(NEO_HAZARD_COLOR), label: 'dangereux' },
    ...[...present].map((key) => ({ color: cssColor(TAXONOMY[key].color), label: TAXONOMY[key].label })),
  ]
}

function renderNeoPanel(feed, error, fetchedAt) {
  panels.renderNeo(feed, error, fetchedAt, error ? [] : neoLegend())
}

function renderNeoPositionsStatus() {
  panels.renderNeoPositions(neoScene.positionsStatus())
}

function renderScalePanel() {
  const focus = focusOf()
  panels.renderScale({
    step: scaleStep,
    frame: focus.frame,
    description: describeScale(scaleStep / SCALE_STEPS, {
      curve: focus.curve,
      references: focusReferences(),
      neoDistancesKm: neoDistancesKm(),
      neoDiametersKm: neoScene.entries.filter((e) => e.source).map((e) => e.diameterKm),
    }),
  })
}

function renderViewPanel() {
  panels.renderView(focusId)
}

/** The NEO the modal is showing, so it can be re-rendered when its sheet arrives. */
let modalNeo = null

function showNeoModal(neo) {
  modalNeo = neo
  const entry = neoScene.entryOf(neo)
  if (entry) neoScene.select(entry)
  renderNeoModal()
  neoScene.loadDetails([entry ? entry.designation : designationOf(neo)])
}

function renderNeoModal() {
  const neo = modalNeo
  if (!neo) return
  const approach = neo.close_approach
  const entry = neoScene.entryOf(neo)
  const designation = entry ? entry.designation : designationOf(neo)
  const sheet = neoScene.sheet(designation)
  const details = sheet.data
  const diameter = details?.diameter_km
    ? `${(details.diameter_km.value * 1000).toLocaleString('fr-FR', { maximumFractionDigits: 0 })} m <span class="muted">(mesuré)</span>`
    : `${neo.estimated_diameter_km.min.toFixed(3)} – ${neo.estimated_diameter_km.max.toFixed(3)} km <span class="muted">(estimé d'après sa luminosité)</span>`

  panels.openModal(
    neo.name,
    `
    <p><strong>Désignation</strong> ${escapeHtml(designation)}</p>
    <p><strong>Diamètre</strong> ${diameter}</p>
    <p><strong>Potentiellement dangereux</strong> ${neo.is_potentially_hazardous ? 'Oui' : 'Non'}</p>
    ${entry ? neoScene.describePosition(entry) : ''}
    ${
      approach
        ? `
      <p><strong>Approche la plus proche</strong> ${approach.datetime ? new Date(approach.datetime).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : approach.date}</p>
      <p><strong>Distance</strong> ${Math.round(approach.miss_distance_km).toLocaleString('fr-FR')} km</p>
      <p><strong>Vitesse relative</strong> ${Math.round(approach.relative_velocity_kmh).toLocaleString('fr-FR')} km/h</p>
    `
        : '<p class="muted">Pas de données d\'approche disponibles</p>'
    }
    ${entry ? neoScene.describeTrajectory(entry) : ''}
    ${entry ? neoScene.describeOrbit(entry) : ''}
    ${sourcesBlockHtml(neo)}
    ${detailsBlockHtml(details, {
      loading: sheet.loading,
      error: sheet.error,
    })}
    ${
      details?.orbit
        ? orbitSchematicSvg(details.orbit, {
            now: new Date(),
            approachAt: approach ? new Date(approach.datetime ?? `${approach.date}T12:00Z`) : null,
            hazardous: neo.is_potentially_hazardous,
          })
        : ''
    }
    <p class="muted credits">${NEO_CREDITS}</p>
  `,
  )
}

// --- scene labels ------------------------------------------------------------------

// The module places labels and keeps them from overlapping; what follows only
// decides which of them the scene currently deserves.
const labels = createSceneLabels({
  layer: sceneLabels,
  camera,
  canvas: renderer.domElement,
  // A label hides behind the Earth, whose radius follows the scale cursor.
  occluder: () => ({ center: globe.position, radius: earthWorldRadius() }),
})

const bodyLabels = {
  earth: labels.create('Terre'),
  moon: labels.create('Lune'),
  iss: labels.create('ISS'),
  sun: labels.create('Soleil'),
}
const moonOrbitLabel = labels.create('orbite lunaire', 'ring')
const orbitMarkerLabels = {
  perihelion: labels.create('périhélie', 'ring'),
  aphelion: labels.create('aphélie', 'ring'),
  ascending: labels.create('nœud ascendant', 'ring'),
  descending: labels.create('nœud descendant', 'ring'),
}

// Rings (and their labels) belong to the current point of view, so both are
// rebuilt on every switch — see setFocus(). Each carries its own vector: the
// entry list is built whole before it is placed, so no two entries may share
// one scratch.
/** @type {{el: HTMLElement, at: THREE.Vector3}[]} */
let ringLabels = []

function rebuildRingLabels() {
  for (const label of ringLabels) label.el.remove()
  ringLabels = distanceRings.list.map((ring) => ({ el: labels.create(ring.label, 'ring'), at: new THREE.Vector3() }))
}

distanceRings.rebuild(focusOf().rings)
rebuildRingLabels()

const issLabelPos = new THREE.Vector3()
const moonOrbitLabelPos = new THREE.Vector3()

/** Names bodies once they've shrunk to dots, and labels the rings and orbits. */
function updateSceneLabels() {
  // Named once too small to read as themselves — the Sun except when the scene
  // is centred on it, the ISS only once the scale makes it a speck.
  const bodies = [
    { el: bodyLabels.earth, worldPos: globe.position, radius: earthWorldRadius(), occludable: false, show: true },
    { el: bodyLabels.moon, worldPos: moon.position, radius: MOON_RADIUS * moon.scale.x, occludable: true, show: true },
    {
      el: bodyLabels.sun,
      worldPos: sunMarker.position,
      radius: SUN_READABLE_RADIUS * sunMarker.scale.x,
      occludable: true,
      show: focusId !== 'sun',
    },
    {
      el: bodyLabels.iss,
      worldPos: issPosition ? issMarker.getWorldPosition(issLabelPos) : null,
      radius: issRadius(scaleT),
      occludable: true,
      show: issMarker.visible && scaleT > 0.001,
    },
  ].map((body) => ({
    ...body,
    show:
      body.show &&
      body.worldPos !== null &&
      labels.projectedRadiusPx(body.worldPos, body.radius) < LABEL_WHEN_SMALLER_THAN_PX,
  }))

  const rings = ringLabels.map(({ el, at }, i) => {
    const ring = distanceRings.list[i]
    // Local +X on the unit circle stays on world +X (the ring is only rotated about X).
    at.set(ring.line.scale.x, 0, 0)
    return {
      el,
      worldPos: at,
      occludable: true,
      // Wide circles: they'd otherwise crowd out the body names they surround.
      spaced: false,
      show: distanceRings.group.visible && labels.projectedRadiusPx(at, ring.line.scale.x) > LABEL_RING_MIN_RADIUS_PX,
    }
  })

  // The lunar orbit names itself a quarter of a revolution ahead of the Moon,
  // so the two labels don't stack.
  const moonOrbitDrawn = moonOrbitTrace.line.visible && moonOrbitTrace.km
  if (moonOrbitDrawn) {
    moonOrbitLabelPos.fromArray(moonOrbitTrace.km, Math.floor(MOON_ORBIT_SAMPLES / 4) * 3)
    placeKm(moonOrbitLabelPos, moonOrbitLabelPos, scaleT)
  }

  labels.update([
    ...bodies,
    ...rings,
    { el: moonOrbitLabel, worldPos: moonOrbitLabelPos, occludable: true, show: Boolean(moonOrbitDrawn) },
    // Perihelion / aphelion / nodes of the drawn heliocentric orbit.
    ...Object.entries(neoScene.orbitMarkers).map(([key, mesh]) => ({
      el: orbitMarkerLabels[key],
      worldPos: mesh.position,
      occludable: true,
      show: neoScene.heliocentricGroup.visible,
    })),
  ])
}

// --- picking (click to inspect a NEO) -----------------------------------------

createPicking({
  canvas: renderer.domElement,
  camera,
  neoGroup: neoScene.group,
  starfield,
  panels,
  // Read fresh at each pick: both radii follow the scale cursor.
  occluders: () => [
    { center: globe.position, radius: earthWorldRadius() },
    { center: moon.position, radius: MOON_RADIUS * moon.scale.x },
  ],
  on: {
    neoClicked: (neo) => showNeoModal(neo),
    emptyClicked: () => neoScene.select(null),
  },
})

// --- data loading (cache-first — the free NASA API key is rate-limited) --------

async function refreshIss() {
  try {
    const position = await fetchIssPosition()
    saveCached('iss', position)
    applyIssPosition(position)
    panels.renderIss(position, null, Date.now())
  } catch (err) {
    panels.renderIss(null, err.message)
  }
}

async function refreshUsage() {
  try {
    const usage = await fetchUsage()
    panels.setUsage(usage.nasa_api_calls_today)
  } catch {
    panels.setUsage(null)
  }
}

function showNeoFeed(feed, fetchedAt) {
  neoScene.showFeed(feed, fetchedAt)
  renderNeoPanel(feed, null, fetchedAt)
  renderScalePanel()
  // Real positions (JPL Horizons) and per-object sheets fill in behind the
  // scene, which already shows the feed at its approximate spots meanwhile.
  neoScene.loadFeedExtras(feed)
}

async function refreshNeo() {
  try {
    const feed = await fetchNeoFeed()
    saveCached('neo', feed)
    showNeoFeed(feed, Date.now())
  } catch (err) {
    renderNeoPanel(null, err.message)
  }
}

async function refreshApod() {
  try {
    const apod = await fetchApod()
    saveCached('apod', apod)
    panels.renderApod(apod, null, Date.now())
  } catch (err) {
    panels.renderApod(null, err.message)
  }
}

refreshUsage()
renderScalePanel()
renderViewPanel()

const cachedIss = loadCached('iss')
const cachedNeo = loadCached('neo')
const cachedApod = loadCached('apod')

if (cachedIss) {
  applyIssPosition(cachedIss.data)
  panels.renderIss(cachedIss.data, null, cachedIss.fetchedAt)
}
if (cachedNeo) {
  showNeoFeed(cachedNeo.data, cachedNeo.fetchedAt)
}
if (cachedApod) {
  panels.renderApod(cachedApod.data, null, cachedApod.fetchedAt)
}
// First-ever load has nothing to show yet — fetch once. Otherwise stay on the
// cached snapshot until "Mettre à jour" is clicked, to spare the NASA quota.
if (!cachedIss || !cachedNeo || !cachedApod) {
  panels.requestUpdate()
}

// The ISS covers ~460 km a minute, visibly off at true scale — refresh it on
// its own. wheretheiss.at isn't part of the NASA quota.
setInterval(refreshIss, 60_000)

// --- render loop --------------------------------------------------------------

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
})

function animate() {
  requestAnimationFrame(animate)
  const nowMs = Date.now()
  // Recomputed fresh from wall-clock time every frame (not accumulated per
  // frame) so it's exactly right regardless of frame rate or a backgrounded
  // tab, with no drift to correct for.
  globe.rotation.y = (getGreenwichSiderealTime(new Date(nowMs)) * Math.PI) / 180

  stepScaleTransition(performance.now())
  stepRecenter(performance.now())
  updateCameraLimits()
  controls.update()
  starfield.group.position.copy(camera.position)
  globe.updateMatrixWorld()
  applyScale(nowMs / 1000)
  updateSceneLabels()

  renderer.render(scene, camera)
}
animate()
