import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { fetchIssPosition, fetchNeoFeed, fetchApod, fetchUsage, searchSmallBody } from './api.js'
import { loadCached, saveCached } from './cache.js'
import { createClock, defaultMaxMs, defaultMinMs } from './clock.js'
import { createMoonTable, createSunTable } from './sunTable.js'
import { FOCUSES, neoEllipsesVisible } from './focus.js'
import { createPanels } from './ui/panels.js'
import { neoSheetHtml, trackButtonHtml, trackedSheetHtml } from './ui/sheets.js'
import { createStarfield } from './scene/starfield.js'
import { createPicking } from './picking.js'
import { createOrbitTraces } from './scene/orbitTrace.js'
import { createCameraRig } from './app/camera.js'
import { createViewFrame } from './scene/frame.js'
import { createEarthSystem } from './scene/earthSystem.js'
import { createSun } from './scene/sun.js'
import { createNeoScene, designationOf } from './neo/scene.js'
import { createTrackedScene } from './tracked/scene.js'
import {
  MAX_TRACKED,
  TRACKED_CACHE_KEY,
  addTracked,
  interpretSearch,
  numberSearchHelp,
  isTrackedDesignation,
  nextApproach,
  readTrackedList,
  removeTracked,
} from './tracking.js'
import { createSceneLabels, LABEL_RING_MIN_RADIUS_PX } from './labels.js'
import { createDistanceRings, createEclipticPlane } from './scene/bodies.js'
import { createPlanets } from './scene/planets.js'
import { createMoons } from './scene/moons.js'
import { loadOrientationFor } from './scene/orientation.js'
import {
  NEO_DEFAULT_COLOR,
  NEO_HAZARD_COLOR,
  TAXONOMY,
  taxonomyKey,
  cssColor,
} from './neoInfo.js'
import {
  AU_KM,
  LUNAR_DISTANCE_KM,
  stepToT,
  sceneDistance,
  describeScale,
} from './scale.js'

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
// min/max distance and zoom speed follow the scale — see app/camera.js.
controls.minDistance = 3.5
controls.maxDistance = 20

renderer.outputColorSpace = THREE.SRGBColorSpace

// Dimmed vs. the old flat-shaded globe (0.6): the day/night shader now handles
// day-side lighting explicitly and the night texture supplies its own city
// lights, so a strong ambient would wash both out.
scene.add(new THREE.AmbientLight(0xffffff, 0.15))
// The Sun's directional light: scene/sun.js.

// The sky loads itself in the background and never blocks the scene (scene/starfield.js).
const starfield = createStarfield(scene)

// The Earth, the Moon, the ISS and the Sun are built further down, once the
// label factory exists (scene/earthSystem.js, scene/sun.js).

const distanceRings = createDistanceRings(scene)
const eclipticPlane = createEclipticPlane(scene)

// --- astronomy (real Sun/Moon positions) --------------------------------------

/**
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

// The one clock for everything placed or oriented in time (clock.js). It reads
// the wall only through the argument we hand it: the cache-validity checks and
// the interface animations (`performance.now()`) stay on the real clock.
// Declared before the Sun table, whose `changed` callback reads it.
const clock = createClock({ wallMs: Date.now() })
const simNowMs = () => clock.nowMs(Date.now())

// The Sun comes from JPL Horizons, with `astronomy.js`'s series standing in
// until the table lands. Declared here because updateAstronomy() below runs on
// the very first frame, long before any fetch returns.
const sunTable = createSunTable({
  on: {
    // Everything derived from the Sun has to be redone when the real one
    // arrives: the scene's positions, and the Earth's own drawn orbit.
    changed: () => {
      const wallMs = Date.now()
      updateAstronomy(new Date(clock.nowMs(wallMs)))
      earthSystem.rebuildOrbits(clock.nowMs(wallMs))
      refreshClockBounds(wallMs) // the table's real end replaces the 1st-of-month + 365 d guess
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
      updateAstronomy(new Date(simMs))
      earthSystem.rebuildOrbits(simMs, { earth: false })
    },
  },
})

/** Sim time of the last updateAstronomy(), to know when the next one is due (stepAstronomy). */
let astronomySimMs = NaN

function updateAstronomy(now) {
  astronomySimMs = now.getTime()

  sunTable.positionKmAt(now, sunPositionKm)
  sunDistanceKm = sunPositionKm.length()
  sunDirWorld.copy(sunPositionKm).divideScalar(sunDistanceKm)
  sun.setDirection(sunDirWorld)
  earthSystem.setSunDirection(sunDirWorld)

  // Real direction and distance only — where that lands in the scene depends
  // on the current scale, applied per frame in applyScale().
  moonTable.positionKmAt(now, moonPositionKm)
  moonDistanceKm = moonPositionKm.length()
}

// --- point de vue (le corps au centre de la scène) ----------------------------
//
// scene/frame.js: the pivot, its position and radius, and the three placers
// every module draws through. setFocus() below is the only thing that moves it.
const frame = createViewFrame({ sunPositionKm })

/** Venus shows its cloud deck by default; ticked, the radar surface under it (planets panel). */
let venusSurface = false
// The distance rings, on by default; the view panel's "Cercles" box.
let ringsEnabled = true

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
let orbitsRebuiltWallMs = 0

function stepAstronomy(simMs, wallMs) {
  if (Math.abs(simMs - astronomySimMs) < ASTRONOMY_STEP_MS) return
  updateAstronomy(new Date(simMs))
  if (wallMs - orbitsRebuiltWallMs >= ORBIT_REBUILD_MIN_WALL_MS) {
    orbitsRebuiltWallMs = wallMs
    // The Earth's line comes from the Sun table and does not depend on "now";
    // only the fallback series (no table yet) samples forward from it.
    earthSystem.rebuildOrbits(simMs, { earth: !sunTable.known })
  }
}

// --- scale ("réalisme") and camera ------------------------------------------------
//
// app/camera.js owns the slider's step, the animated t, the zoom range and
// recentring. What it cannot know — what the scene contains — comes from here.

/** NEO distances from the current pivot — what the scale label and the camera anchors quote. */
function neoDistancesKm() {
  neoScene.refreshPositions(simNowMs() / 1000)
  return neoScene.entries.filter((e) => e.source).map((e) => e.positionKm.distanceTo(frame.positionKm()))
}

/** The pivot's yardsticks, at their real current distance. */
function focusReferences() {
  // Around a planet the Sun is the only yardstick the scene can quote today;
  // its moons will be the second one (lot 4).
  if (frame.planet) return [{ label: 'Soleil', km: frame.planet.positionKm.distanceTo(sunPositionKm) }]
  return frame.id === 'sun' ? [{ label: 'Terre', km: sunDistanceKm }] : [{ label: 'Lune', km: moonDistanceKm }]
}

/** Distances from the pivot, km, of everything drawn at scale t — how far the zoom must reach. */
function sceneExtentKm(t) {
  const pivot = frame.positionKm()
  const km = focusReferences().map((reference) => reference.km)
  for (const entry of neoScene.entries) {
    if (entry.source) km.push(entry.positionKm.distanceTo(pivot))
  }
  for (const position of trackedScene.positionsKm()) km.push(position.distanceTo(pivot))
  // Neptune sits further out than any NEO in both views — without this the
  // zoom would stop short of the planet it is drawing. Only while the planets
  // are actually drawn: the Earth's and the planets' views hide the others below
  // 100 % réel (the pivot itself is at distance 0), and an invisible Neptune must not be what lets the camera pull back 26 units.
  if (planets.drawnAt(t)) {
    for (const body of planets.bodies) {
      if (body.known) km.push(body.positionKm.distanceTo(pivot))
    }
  }
  // A moon can be the furthest thing in the scene at the readable end —
  // Pasiphae orbits 24 million km out, well past where Jupiter's own curve puts
  // the inner planets.
  km.push(...moons.distancesKm())
  return km
}

// Built before the NEO scene: every body module takes `minRadiusAt` at creation.
const rig = createCameraRig({
  camera,
  controls,
  canvas: renderer.domElement,
  frame,
  references: focusReferences,
  extentKm: sceneExtentKm,
  // The drawn orbit is part of the scene's extent: you must be able to pull
  // back far enough to see the whole ellipse, aphelion included.
  extentUnits: () => (neoScene.heliocentricGroup.visible ? neoScene.orbitMarkers.aphelion.position.length() : 0),
  neoDistancesKm,
  on: {
    stepChanged: () => {
      renderScalePanel()
      renderPlanetsPanel() // the cran decides whether the geocentric view shows planets
      // The ellipses (and the "all orbits" box that gates them) only exist at 100 % réel.
      if (neoScene.currentFeed) renderNeoPanel(neoScene.currentFeed, null, neoScene.currentFetchedAt)
      if (modalNeo) renderNeoModal()
    },
  },
})
const { minRadiusAt } = rig

// --- NEOs ----------------------------------------------------------------------

// Orbit traces are shared: the NEO's ellipse and the Moon's and Earth's own
// orbits are the same kind of line, re-projected every frame.
const traces = createOrbitTraces({ frame })

// The NEO points, the sheets that colour them, their real positions, and the
// two drawings of the selected one all live together (neo/scene.js) — they
// share a selection, a colour and an approach ring.
const neoScene = createNeoScene({
  scene,
  camera,
  traces,
  frame,
  minRadiusAt,
  sunPositionKmAt: (date, out) => sunTable.positionKmAt(date, out),
  on: {
    // A sheet arriving changes what the modal can show, then what the legend
    // and the scale label know about diameters.
    detailsProgress: () => {
      if (modalNeo) renderNeoModal()
      if (modalTracked) renderTrackedModal()
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

// --- changer de point de vue ------------------------------------------------------

function setFocus(nextId) {
  const next = FOCUSES[nextId]
  if (nextId === frame.id || !next) return

  // A planet only becomes the pivot once its Horizons table has landed. Without
  // a position there is no origin to subtract, so every body in the scene would
  // silently be placed relative to (0,0,0) — that is, relative to the Earth,
  // while the panel claimed another pivot. The button is disabled meanwhile
  // (panels.renderView), this is the guard behind it.
  const nextPlanet = next.group === 'planet' ? planets.focusBody(nextId, simNowMs() / 1000) : null
  if (next.group === 'planet' && !nextPlanet) return

  // The camera keeps its physical framing across the switch (app/camera.js).
  rig.switchFocus(() => {
    frame.set(nextId, nextPlanet)
    distanceRings.rebuild(frame.focus.rings)
    rebuildRingLabels()
    neoScene.invalidateOrbit()
  })

  renderScalePanel()
  renderViewPanel()
  // Venus's radar surface is an option of the view from Venus; leaving resets it.
  if (venusSurface && nextId !== 'venus') {
    venusSurface = false
    planets.setVenusSurface(false)
  }
  renderPlanetsPanel() // so does the pivot
  if (neoScene.currentFeed) renderNeoPanel(neoScene.currentFeed, null, neoScene.currentFetchedAt)
  if (modalNeo) renderNeoModal()

  // The one place moons are ever fetched, and the one place a planet's colour
  // map and its orientation are: centring on a planet is the whole trigger.
  // Nothing is loaded for a planet nobody looks at — the moons and the
  // orientation cost Horizons requests, the map costs bandwidth, and none of it
  // buys anything at the few pixels a planet occupies from anywhere else.
  if (frame.planet) {
    moons.loadFor(frame.planet.id)
    planets.loadTextureFor(frame.planet.id)
    loadOrientationFor(frame.planet.id)
  }
  if (frame.id === 'sun') sun.loadTexture()
}

/** Places and sizes every scale-dependent object for rig.t and the current camera. */
function applyScale(nowSeconds) {
  const t = rig.t
  // The Sun's *position* is refreshed every frame, not with updateAstronomy()'s
  // 60 simulated seconds (a minute at ×1): every heliocentric orbit line hangs off it (placeHeliocentricKm)
  // while the planets move every frame, and the geocentric Sun runs at ~30 km/s
  // — a minute-old Sun put Mercury up to ~1 800 km (0,7 of its radius) off its
  // own line at true scale, snapping back each minute (seen 2026-10-15). The
  // lighting derived from it stays on the minute: 0,0007° of drift.
  sunTable.positionKmAt(new Date(nowSeconds * 1000), sunPositionKm)

  earthSystem.update(nowSeconds, t, { realTime: clock.isRealTime(), earthOrbitDrawn: planets.drawnAt(t) })
  sun.update(t)

  distanceRings.group.visible = ringsEnabled && t > 0.001
  for (const ring of distanceRings.list) {
    ring.line.scale.setScalar(sceneDistance(ring.distanceKm, t, frame.focus.curve))
  }

  // Twice as far as the camera may pull back, so its edge never comes into view.
  if (eclipticPlane.group.visible) eclipticPlane.update(sun.marker.position, controls.maxDistance * 2)

  planets.update(nowSeconds, t)
  moons.update(nowSeconds, t)
  neoScene.update(nowSeconds, t)
  trackedScene.update(nowSeconds, t)
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
    timeRate: (rate) => setTimeRate(rate),
    timeReset: () => resetTime(),
    timePlayPause: () => togglePause(),
    scaleStep: (step) => rig.setStep(step),
    scaleStepBy: (direction) => rig.setStep(rig.step + direction),
    focus: (id) => setFocus(id),
    recenter: () => rig.recenter(),
    deselect: () => neoScene.select(null),
    detailClosed: () => {
      modalNeo = null
      modalTracked = null
    },
    trackSearch: (q, opts) => searchAndTrack(q, opts),
    trackAdd: (record) => addResult(record),
    trackOpen: (spkid) => showTrackedModal(spkid),
    trackApproach: (spkid) => goToNextApproach(spkid),
    trackRemove: (spkid) => untrack(spkid),
    trackRetry: (spkid) => trackedScene.reload(spkid),
    trackShowNeo: (enabled) => {
      showNeoWhileTracking = enabled
      applyNeoPolicy()
    },
    detailAction: (action, data) => {
      if (action === 'track') trackFromNeo(data.designation)
      else if (action === 'approach') goToNextApproach(data.spkid)
    },
    rings: (enabled) => {
      ringsEnabled = enabled
    },
    ecliptic: (enabled) => {
      eclipticPlane.group.visible = enabled
    },
    venusSurface: (enabled) => {
      venusSurface = enabled
      planets.setVenusSurface(enabled)
      renderPlanetsPanel()
    },
    points: (enabled) => {
      // The same choice as the "Suivi" tab's box: while something is tracked, the
      // NEO panel's own box is what decides whether the week's points come back.
      if (trackedList.length > 0) showNeoWhileTracking = enabled
      neoScene.setPoints(enabled)
      // The sheet describes a point that is no longer on screen.
      if (!enabled && modalNeo) panels.closeDetail()
      if (neoScene.currentFeed) renderNeoPanel(neoScene.currentFeed, null, neoScene.currentFetchedAt)
      refreshTrackingPanel()
    },
    allOrbits: (enabled) => {
      neoScene.setAllOrbits(enabled)
      // Redrawn so the box keeps the state the scene actually holds, rather
      // than whatever the DOM was left in — same rule as every other panel.
      if (neoScene.currentFeed) renderNeoPanel(neoScene.currentFeed, null, neoScene.currentFetchedAt)
    },
  },
})
const { sceneLabels } = panels

// --- simulated clock (UI side) -------------------------------------------------------

/**
 * The bounds are the Sun table's window (the planets' tables share it,
 * `SolarSystemClient::windowStart` + 365 d), or the same dates computed by hand
 * while none is loaded. Both ends matter since time can run backwards
 * (2026-10-27): reversed, it stops at the 1st of the month, where the tables start.
 */
function refreshClockBounds(wallMs) {
  clock.setBounds(sunTable.startMs ?? defaultMinMs(wallMs), sunTable.endMs ?? defaultMaxMs(wallMs), wallMs)
}

function renderTimePanel(simMs, wallMs) {
  panels.renderTime({
    rate: clock.rate,
    realTime: clock.isRealTime(),
    simMs,
    atLimit: clock.atLimit(wallMs),
    limitMs: clock.rate < 0 ? clock.minMs : clock.maxMs,
  })
}

/** Everything that was computed "once a minute" from the old time has to be redone now, not 60 s later. */
function afterTimeJump() {
  const wallMs = Date.now()
  const simMs = clock.nowMs(wallMs)
  updateAstronomy(new Date(simMs))
  orbitsRebuiltWallMs = wallMs
  earthSystem.rebuildOrbits(simMs, { earth: !sunTable.known })
  renderTimePanel(simMs, wallMs)
  renderScalePanel() // its NEO distances are the simulated ones
  // The sheet quotes a distance at the simulated date, written once: redo it.
  if (modalNeo) renderNeoModal()
  if (modalTracked) renderTrackedModal()
  refreshTrackingPanel() // "next close approach" is relative to the simulated time
}

/**
 * The speed "Lecture" goes back to: the last non-zero one, ×1 until another is
 * picked. Pausing from the slider's own pause stop counts too, so the button
 * always resumes whatever was running before — without the hard reset of
 * "Maintenant", the simulated date stays where it was paused.
 */
let resumeRate = 1

function togglePause() {
  setTimeRate(clock.rate === 0 ? resumeRate : 0)
}

function setTimeRate(rate) {
  if (clock.rate !== 0 && rate === 0) resumeRate = clock.rate
  const wallMs = Date.now()
  clock.setRate(rate, wallMs)
  refreshClockBounds(wallMs)
  afterTimeJump()
}

function resetTime() {
  resumeRate = 1
  clock.reset(Date.now())
  afterTimeJump()
  refreshIss() // keyless; the marker reappears at once, on a fresh position rather than one up to 60 s old
}

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
  panels.renderNeo(feed, error, fetchedAt, error ? [] : neoLegend(), {
    ...neoScene.allOrbitsStatus(),
    // Ticked or not, the box can do nothing from the Sun below 100 % réel.
    scaleLocked: frame.id === 'sun' && !neoEllipsesVisible(frame.id, stepToT(rig.step)),
  })
}

function renderNeoPositionsStatus() {
  panels.renderNeoPositions(neoScene.positionsStatus())
}

function renderPlanetsPanel() {
  // `rig.step`, not `rig.t`: the panel describes the cran the slider is on,
  // not where a running transition happens to be — same choice as the scale label.
  panels.renderPlanets(
    planets.status(),
    planets.legend(),
    planets.drawnAt(stepToT(rig.step)),
    moons.status(),
    frame.id === 'venus' ? { surface: venusSurface } : null,
  )
}

function renderScalePanel() {
  const focus = frame.focus
  panels.renderScale({
    step: rig.step,
    frame: focus.frame,
    description: describeScale(stepToT(rig.step), {
      curve: focus.curve,
      references: focusReferences(),
      neoDistancesKm: neoDistancesKm(),
      neoDiametersKm: neoScene.entries.filter((e) => e.source).map((e) => e.diameterKm),
    }),
  })
}

function renderViewPanel() {
  panels.renderView(frame.id, planets.focusableIds())
}

/** The NEO the detail panel is showing, so it can be re-rendered when its sheet arrives. */
let modalNeo = null

function showNeoModal(neo) {
  modalNeo = neo
  modalTracked = null
  const entry = neoScene.entryOf(neo)
  if (entry) neoScene.select(entry)
  renderNeoModal()
  neoScene.loadDetails([entry ? entry.designation : designationOf(neo)])
}

function renderNeoModal() {
  const neo = modalNeo
  if (!neo) return
  const entry = neoScene.entryOf(neo)
  const designation = entry ? entry.designation : designationOf(neo)

  panels.openDetail(
    neo.name,
    neoSheetHtml({
      neo,
      designation,
      sheet: neoScene.sheet(designation),
      trackButton: trackButtonHtml({
        designation,
        tracked: isTrackedDesignation(trackedList, designation),
        full: trackedList.length >= MAX_TRACKED,
        neoTrack,
      }),
      positionHtml: entry ? neoScene.describePosition(entry, simNowMs() / 1000, !clock.isRealTime()) : '',
      trajectoryHtml: entry ? neoScene.describeTrajectory(entry) : '',
      orbitHtml: entry ? neoScene.describeOrbit(entry, stepToT(rig.step)) : '',
      nowMs: simNowMs(),
    }),
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
  occluder: () => earthSystem.earthOccluder(),
})

// --- the Earth, the Moon, the ISS and the Sun -----------------------------------
//
// Built here, after the label factory, because each names its own bodies — the
// same reason as the planets below. The first astronomy pass and the first
// orbit sampling wait for them; nothing before this point reads either.

const earthSystem = createEarthSystem({ scene, frame, traces, labels, minRadiusAt, sunTable, moonTable, moonPositionKm })
const sun = createSun({ scene, frame, labels, minRadiusAt, sunPositionKm })

updateAstronomy(new Date(simNowMs()))
earthSystem.rebuildOrbits(simNowMs())

const orbitMarkerLabels = {
  perihelion: labels.create('périhélie', 'ring'),
  aphelion: labels.create('aphélie', 'ring'),
  ascending: labels.create('nœud ascendant', 'ring'),
  descending: labels.create('nœud descendant', 'ring'),
}

// --- suivi d'astéroïdes (onglet « Suivi ») ------------------------------------------
//
// The list lives here and is the only thing persisted (tracking.js says why);
// the scene module loads the tables and draws. The NEO of the week stays what it
// was: a tracked asteroid is a different object, NEO or not.

/** @type {import('./tracking.js').TrackedRecord[]} */
let trackedList = []
/** The user's choice, while something is tracked, to keep the week's NEO points on screen. */
let showNeoWhileTracking = false
/** The tracked object whose sheet the detail panel is showing (SPK-ID), like `modalNeo`. */
let modalTracked = null
/** The "Suivre" button of a weekly NEO's sheet: which designation is being resolved, and what it said. */
let neoTrack = { designation: null, busy: false, message: '' }

const trackedScene = createTrackedScene({
  scene,
  traces,
  labels,
  frame,
  minRadiusAt,
  sunPositionKmAt: (date, out) => sunTable.positionKmAt(date, out),
  on: {
    changed: () => {
      refreshTrackingPanel()
      if (modalTracked) renderTrackedModal()
    },
    // An object that got numbered changed SPK-ID: the stored one follows.
    spkidChanged: (oldSpkid, record) => {
      trackedList = trackedList.map((rec) => (rec.spkid === oldSpkid ? record : rec))
      saveCached(TRACKED_CACHE_KEY, trackedList)
      if (modalTracked === oldSpkid) modalTracked = record.spkid
    },
  },
})

/** Points of the week on screen: all of them when nothing is tracked, the user's call otherwise. */
function applyNeoPolicy() {
  const visible = trackedList.length === 0 || showNeoWhileTracking
  neoScene.setPoints(visible)
  if (!visible && modalNeo) panels.closeDetail()
  if (neoScene.currentFeed) renderNeoPanel(neoScene.currentFeed, null, neoScene.currentFetchedAt)
  refreshTrackingPanel()
}

function refreshTrackingPanel() {
  const nowSeconds = simNowMs() / 1000
  const items = []
  for (const rec of trackedList) {
    const entry = trackedScene.get(rec.spkid)
    if (!entry) continue
    let approach = null
    if (rec.neo && entry.status === 'ready') {
      const next = nextApproach(entry.object, nowSeconds)
      approach = { kind: next.kind, timeMs: next.time * 1000, distKm: next.approach?.dist_km ?? null }
    }
    items.push({
      spkid: rec.spkid,
      name: rec.fullname,
      neo: rec.neo,
      color: cssColor(rec.color),
      status: entry.status,
      error: entry.error,
      approach,
    })
  }
  panels.renderTracking({
    items,
    full: trackedList.length >= MAX_TRACKED,
    showNeo: trackedList.length === 0 || showNeoWhileTracking,
  })
}

/** Adds a resolved record to the list and the scene. The refusal, if any, comes back as `reason`. */
function trackRecord(record) {
  const outcome = addTracked(trackedList, record)
  if (!outcome.added) return outcome
  trackedList = outcome.list
  saveCached(TRACKED_CACHE_KEY, trackedList)
  const added = trackedList[trackedList.length - 1]
  if (trackedList.length === 1) showNeoWhileTracking = false // the first one clears the week's NEO off the scene
  trackedScene.add(added)
  applyNeoPolicy()
  return { ...outcome, record: added }
}

function untrack(spkid) {
  trackedList = removeTracked(trackedList, spkid)
  saveCached(TRACKED_CACHE_KEY, trackedList)
  if (trackedList.length === 0) showNeoWhileTracking = false
  const wasOpen = modalTracked === spkid
  trackedScene.remove(spkid)
  if (wasOpen) panels.closeDetail()
  applyNeoPolicy()
}

/**
 * The panel's search. A single match is *offered*, not added: SBDB reads "2017"
 * as the number 2017, which is not what the user may have meant. Only a click on
 * a candidate (`direct`, its designation is explicit) or on the result's button
 * (`trackAdd`) adds.
 */
async function searchAndTrack(q, { direct = false } = {}) {
  let found
  try {
    found = interpretSearch(await searchSmallBody(q))
  } catch (err) {
    return { kind: 'error', message: err.message }
  }
  if (found.kind !== 'match') return found
  if (!direct) {
    const tracked = isTrackedDesignation(trackedList, found.record.des) || trackedList.some((r) => r.spkid === found.record.spkid)
    return {
      kind: 'match',
      record: found.record,
      help: numberSearchHelp(q),
      state: tracked ? 'duplicate' : trackedList.length >= MAX_TRACKED ? 'full' : 'ok',
    }
  }
  return addResult(found.record)
}

/** Adds a resolved record and says what came of it, in the panel's vocabulary. */
function addResult(record) {
  const outcome = trackRecord(record)
  const name = record.fullname
  if (outcome.added) return { kind: 'added', name }
  return { kind: outcome.reason === 'full' ? 'full' : 'duplicate', name }
}

function showTrackedModal(spkid) {
  const entry = trackedScene.get(spkid)
  if (!entry) return
  modalNeo = null
  neoScene.select(null)
  modalTracked = spkid
  renderTrackedModal()
  neoScene.loadDetails([entry.rec.des])
}

/** "Suivre" in a weekly NEO's sheet: resolve its designation, then add it like a search would. */
async function trackFromNeo(designation) {
  neoTrack = { designation, busy: true, message: '' }
  renderNeoModal()
  let message = ''
  try {
    const found = interpretSearch(await searchSmallBody(designation))
    if (found.kind === 'match') {
      const outcome = trackRecord(found.record)
      if (outcome.added || outcome.reason === 'duplicate') {
        neoTrack = { designation: null, busy: false, message: '' }
        panels.showTab('tracking')
        showTrackedModal((outcome.record ?? found.record).spkid)
        return
      }
      message = `${MAX_TRACKED} objets au plus`
    } else if (found.kind === 'candidates') {
      message = 'désignation ambiguë : utilisez la recherche de l\'onglet Suivi'
    } else if (found.kind === 'comet') {
      message = 'comète, pas encore prise en charge'
    } else {
      message = 'introuvable dans JPL SBDB'
    }
  } catch (err) {
    message = err.message
  }
  neoTrack = { designation, busy: false, message }
  if (modalNeo) renderNeoModal()
}

/** Sets the clock on the next close approach of a tracked NEO — when it is inside the tables. */
function goToNextApproach(spkid) {
  const entry = trackedScene.get(spkid)
  if (!entry?.object) return
  const next = nextApproach(entry.object, simNowMs() / 1000)
  if (next.kind !== 'in_window') {
    refreshTrackingPanel() // out of the tables: the clock cannot go there, the panel says the date
    return
  }
  clock.jumpTo(next.time * 1000, Date.now())
  afterTimeJump()
}

/** A tracked object's sheet (ui/sheets.js), in the detail panel a weekly NEO's uses. */
function renderTrackedModal() {
  const entry = modalTracked ? trackedScene.get(modalTracked) : null
  if (!entry) return
  const { rec } = entry
  const nowSeconds = simNowMs() / 1000

  panels.openDetail(
    rec.fullname,
    trackedSheetHtml({
      rec,
      sheet: neoScene.sheet(rec.des),
      next: rec.neo && entry.status === 'ready' ? nextApproach(entry.object, nowSeconds) : null,
      positionHtml: trackedScene.describePosition(entry, nowSeconds, !clock.isRealTime()),
      nowMs: simNowMs(),
    }),
  )
}

// --- planets -------------------------------------------------------------------
//
// Geocentric km like every other body, so the same placeKm() puts them in both
// views — no second data source for the heliocentric one. In the Earth-centred
// view they do bunch up (19 to 26 units for Venus through Neptune): the readable
// curve being honest about a scene centred on the Earth, not a bug.
//
// Built here, after the label factory, because the module names its own planets:
// a parallel array of labels indexed against `bodies` is a coupling worth not
// having. Where those names *rank* against the other labels stays below.

const planets = createPlanets({
  scene,
  labels,
  traces,
  frame,
  minRadiusAt,
  // Passed by reference, not by value: `updateAstronomy()` copies into this same
  // vector every minute, so the planets' lighting follows the Sun on its own.
  sunPositionKm,
  on: { changed: () => { renderPlanetsPanel(); renderViewPanel() } },
})

// The moons of the centred planet only — created after the planets because the
// pivot they hang off is resolved there. Their samples are already relative to
// that planet, so they never touch placeKm.
const moons = createMoons({
  scene,
  labels,
  traces,
  frame,
  minRadiusAt,
  sunPositionKm,
  on: { changed: () => renderPlanetsPanel() },
})

// Rings (and their labels) belong to the current point of view, so both are
// rebuilt on every switch — see setFocus(). Each carries its own vector: the
// entry list is built whole before it is placed, so no two entries may share
// one scratch.
/** @type {{el: HTMLElement, at: THREE.Vector3}[]} */
let ringLabels = []

function rebuildRingLabels() {
  for (const label of ringLabels) label.el.remove()
  ringLabels = distanceRings.list.map((ring) => ({ el: labels.create(ring.label, ring.absolute ? 'ring absolute' : 'ring'), at: new THREE.Vector3() }))
}

distanceRings.rebuild(frame.focus.rings)
rebuildRingLabels()

/** Names bodies once they've shrunk to dots, and labels the rings and orbits. */
function updateSceneLabels() {
  // Named once too small to read as themselves — each module decides its own.
  const earthLabels = earthSystem.labelEntries(rig.t)

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

  labels.update([
    earthLabels.earth,
    earthLabels.moon,
    sun.labelEntry(),
    earthLabels.iss,
    // After the four above, so a planet's name never pushes the Earth's or the
    // Moon's aside — the list order is the spacing arbitration.
    ...planets.labelEntries(),
    ...moons.labelEntries(),
    ...trackedScene.labelEntries(),
    ...rings,
    earthLabels.moonOrbit,
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
  trackedGroup: trackedScene.group,
  starfield,
  panels,
  // Read fresh at each pick: both radii follow the scale cursor.
  occluders: () => earthSystem.occluders(),
  on: {
    neoClicked: (neo) => showNeoModal(neo),
    trackedClicked: (entry) => showTrackedModal(entry.rec.spkid),
    emptyClicked: () => neoScene.select(null),
  },
})

// --- data loading (cache-first — the free NASA API key is rate-limited) --------

async function refreshIss() {
  try {
    const position = await fetchIssPosition()
    saveCached('iss', position)
    earthSystem.setIssPosition(position)
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

// The session opens centred on the Sun at 100 % réel (2026-10-27, user's
// call). Through setFocus, so the Sun's texture, the rings and every panel
// follow as on a click; then the camera is backed off to frame the Earth's
// orbit, the yardstick of that view — setFocus alone would keep the start-up
// distance, which at this scale is a close-up of the photosphere.
setFocus('sun')
rig.frameFirstReference()

refreshUsage()
renderScalePanel()
renderViewPanel()
renderTimePanel(simNowMs(), Date.now())

// Not wired to "Mettre à jour": the planet tables are keyless (JPL Horizons,
// no NASA quota) and cover a year, so there is nothing for that button to
// refresh. They load themselves once, then come back from localStorage.
sunTable.load()
moonTable.load()
planets.load()
// Unlike a planet's, this one is not waited for: the Moon is drawn from the
// first frame in every view, so there is no "centre on it" moment to hang the
// fetch on. One keyless Horizons request a month, cached like the rest.
loadOrientationFor('moon')

const cachedIss = loadCached('iss')
const cachedNeo = loadCached('neo')
const cachedApod = loadCached('apod')

if (cachedIss) {
  earthSystem.setIssPosition(cachedIss.data)
  panels.renderIss(cachedIss.data, null, cachedIss.fetchedAt)
}
if (cachedNeo) {
  showNeoFeed(cachedNeo.data, cachedNeo.fetchedAt)
}
if (cachedApod) {
  panels.renderApod(cachedApod.data, null, cachedApod.fetchedAt)
}
// The tracked list is all that is stored (never the tables): one positions call per
// object, in parallel, each object appearing as its own answer lands.
trackedList = readTrackedList(loadCached(TRACKED_CACHE_KEY)?.data)
for (const rec of trackedList) trackedScene.add(rec)
applyNeoPolicy()

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
  const wallMs = Date.now()
  // The simulated clock, read once: every placement of the frame shares it.
  const nowMs = clock.nowMs(wallMs)
  const now = new Date(nowMs)
  earthSystem.orient(now)

  stepAstronomy(nowMs, wallMs)
  // Real time is rendered on events only; a running fast clock changes its
  // text every frame (renderTime skips the DOM when nothing differs).
  if (!clock.isRealTime()) renderTimePanel(nowMs, wallMs)

  rig.update(performance.now()) // scale transition, recentring, zoom limits, controls
  starfield.group.position.copy(camera.position)
  earthSystem.globe.updateMatrixWorld()
  applyScale(nowMs / 1000)
  updateSceneLabels()

  renderer.render(scene, camera)
}
animate()
