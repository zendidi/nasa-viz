import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { fetchIssPosition, fetchNeoFeed, fetchApod, fetchUsage } from './data/api.js'
import { loadCached, saveCached } from './data/cache.js'
import { createClock } from './ephemeris/clock.js'
import { FOCUSES, neoEllipsesVisible } from './view/focus.js'
import { createPanels } from './ui/panels.js'
import { neoSheetHtml } from './ui/sheets.js'
import { createStarfield } from './scene/starfield.js'
import { createPicking } from './scene/picking.js'
import { createOrbitTraces } from './scene/orbitTrace.js'
import { createCameraRig } from './app/camera.js'
import { createSunMoon } from './app/sunMoon.js'
import { createTimeControls } from './app/time.js'
import { createViewFrame } from './scene/frame.js'
import { createEarthSystem } from './scene/earthSystem.js'
import { createSun } from './scene/sun.js'
import { createNeoScene, designationOf } from './neo/scene.js'
import { createTracking } from './tracking/controller.js'
import { createSceneLabels, LABEL_RING_MIN_RADIUS_PX } from './scene/labels.js'
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
} from './neo/info.js'
import { stepToT, sceneDistance, describeScale } from './view/scale.js'

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

// The one clock for everything placed or oriented in time (clock.js). It reads
// the wall only through the argument we hand it: the cache-validity checks and
// the interface animations (`performance.now()`) stay on the real clock.
// Declared before the Sun table, whose `changed` callback reads it.
const clock = createClock({ wallMs: Date.now() })
const simNowMs = () => clock.nowMs(Date.now())

// app/sunMoon.js: the Sun and Moon tables, their geocentric positions, and the
// 60-simulated-second cadence the lighting and the drawn orbits follow. The
// bodies that show them are built further down; these callbacks only run once
// the first frame or the first fetch does.
const sunMoon = createSunMoon({
  clock,
  on: {
    sunDirection: (dir) => {
      sun.setDirection(dir)
      earthSystem.setSunDirection(dir)
    },
    rebuildOrbits: (simMs, options) => earthSystem.rebuildOrbits(simMs, options),
    sunTableChanged: (wallMs) => time.refreshBounds(wallMs),
  },
})
const { sunTable, moonTable, sunPositionKm, moonPositionKm } = sunMoon

// --- point de vue (le corps au centre de la scène) ----------------------------
//
// scene/frame.js: the pivot, its position and radius, and the three placers
// every module draws through. setFocus() below is the only thing that moves it.
const frame = createViewFrame({ sunPositionKm })

/** Venus shows its cloud deck by default; ticked, the radar surface under it (planets panel). */
let venusSurface = false
// The distance rings, on by default; the view panel's "Cercles" box.
let ringsEnabled = true

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
  return frame.id === 'sun' ? [{ label: 'Terre', km: sunMoon.sunDistanceKm }] : [{ label: 'Lune', km: sunMoon.moonDistanceKm }]
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
      tracking.renderSheet()
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
function applyScale(nowSeconds, wallMs) {
  const t = rig.t
  // The trajectory cursor first (2026-11-05): while it is away from the scene's
  // time the Earth pivot's origin is the Earth at the cursor's instant, and
  // everything below is placed from that origin.
  trackedScene.syncCursor(nowSeconds, wallMs)
  // The Sun's *position* is refreshed every frame, not with sunMoon.update()'s
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
  trackedScene.update(nowSeconds, t, {
    distance: camera.position.distanceTo(controls.target),
  })
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
    timeRate: (rate) => time.setRate(rate),
    timeReset: () => time.reset(),
    timePlayPause: () => time.togglePause(),
    scaleStep: (step) => rig.setStep(step),
    scaleStepBy: (direction) => rig.setStep(rig.step + direction),
    focus: (id) => setFocus(id),
    recenter: () => rig.recenter(),
    deselect: () => neoScene.select(null),
    detailClosed: () => {
      modalNeo = null
      tracking.sheetClosed()
    },
    trackSearch: (q, opts) => tracking.search(q, opts),
    trackAdd: (record) => tracking.add(record),
    trackOpen: (spkid) => tracking.open(spkid),
    trackApproach: (spkid) => tracking.goToNextApproach(spkid),
    trackPrevApproach: (spkid) => tracking.goToPreviousApproach(spkid),
    trackRemove: (spkid) => tracking.remove(spkid),
    trackRetry: (spkid) => tracking.retry(spkid),
    trackKeep: (spkid, saved) => tracking.setSaved(spkid, saved),
    trackShowNeo: (enabled) => tracking.setShowNeo(enabled),
    trajDay: (day) => tracking.cursorSetDay(day),
    trajShift: (seconds) => tracking.cursorShift(seconds),
    trajReset: () => tracking.cursorReset(),
    trajPlay: (rate) => tracking.cursorPlay(rate),
    trajSunRetry: () => tracking.retrySun(),
    detailAction: (action, data) => {
      if (action === 'track') tracking.trackFromNeo(data.designation)
      else if (action === 'approach') tracking.goToNextApproach(data.spkid)
      else if (action === 'approach-prev') tracking.goToPreviousApproach(data.spkid)
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
    moonsShown: (enabled) => {
      moons.setEnabled(enabled)
      saveCached('moons-shown', enabled)
      // Ticked while a planet is centred: the moons were not fetched while hidden.
      if (enabled && frame.planet) moons.loadFor(frame.planet.id)
      renderPlanetsPanel()
    },
    points: (enabled) => {
      // The same choice as the "Suivi" tab's box: while something is tracked, the
      // NEO panel's own box is what decides whether the week's points come back.
      tracking.pointsToggled(enabled)
      neoScene.setPoints(enabled)
      // The sheet describes a point that is no longer on screen.
      if (!enabled && modalNeo) panels.closeDetail()
      if (neoScene.currentFeed) renderNeoPanel(neoScene.currentFeed, null, neoScene.currentFetchedAt)
      tracking.refreshPanel()
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

// --- time panel ---------------------------------------------------------------
//
// app/time.js: speed, pause, "Maintenant" and the clock's bounds. A jump of the
// simulated date redraws what was computed from the old one, here.

const time = createTimeControls({
  clock,
  sunTable,
  render: (state) => panels.renderTime(state),
  on: {
    jumped: (simMs, wallMs) => {
      sunMoon.jump(simMs, wallMs)
      renderScalePanel() // its NEO distances are the simulated ones
      // The sheet quotes a distance at the simulated date, written once: redo it.
      if (modalNeo) renderNeoModal()
      tracking.renderSheet()
      tracking.refreshPanel() // "next close approach" is relative to the simulated time
    },
    reset: () => {
      refreshIss() // keyless; the marker reappears at once, on a fresh position rather than one up to 60 s old
      // "Maintenant" resets everything (2026-11-05): the clock AND the trajectory
      // cursor. Changing the clock's speed, or jumping it, leaves the cursor's offset alone.
      tracking.cursorReset()
    },
  },
})

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
    moons.enabled,
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
  tracking.sheetClosed()
  const entry = neoScene.entryOf(neo)
  if (entry) neoScene.select(entry)
  renderNeoModal()
  neoScene.loadDetails([entry ? entry.designation : designationOf(neo)])
}

/**
 * The open sheet's "Distance au …" line follows the running clock (2026-10-27):
 * it used to be written once, on opening or on a jump, so at 1 h/s it lagged
 * the simulated date by hours. Only that block is rewritten, 4 times a second —
 * the rest of the sheet is fixed facts (the approach itself) and stays put.
 */
const SHEET_POSITION_REFRESH_MS = 250
let sheetPositionRefreshedMs = 0

function refreshSheetPosition(wallMs) {
  if (wallMs - sheetPositionRefreshedMs < SHEET_POSITION_REFRESH_MS) return
  sheetPositionRefreshedMs = wallMs
  const entry = modalNeo ? neoScene.entryOf(modalNeo) : null
  const html = entry ? neoScene.describePosition(entry, simNowMs() / 1000, !clock.isRealTime()) : tracking.positionHtml()
  if (html !== null) panels.setDetailLive('position', html)
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
      trackButton: tracking.trackButtonFor(designation),
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

sunMoon.update(new Date(simNowMs()))
earthSystem.rebuildOrbits(simNowMs())

const orbitMarkerLabels = {
  perihelion: labels.create('périhélie', 'ring'),
  aphelion: labels.create('aphélie', 'ring'),
  ascending: labels.create('nœud ascendant', 'ring'),
  descending: labels.create('nœud descendant', 'ring'),
}

// --- suivi d'astéroïdes (onglet « Suivi ») ------------------------------------------
//
// tracking/controller.js: the list, its policy towards the week's NEO points, the
// "Suivre" button and the tracked sheet. The weekly NEO's own sheet stays here.

const tracking = createTracking({
  sceneOptions: {
    scene,
    traces,
    labels,
    frame,
    minRadiusAt,
  },
  neoScene,
  panels,
  clock,
  simNowMs,
  on: {
    neoSheetChanged: () => {
      if (modalNeo) renderNeoModal()
    },
    trackedSheetOpened: () => {
      modalNeo = null
    },
    neoPolicyChanged: (visible) => {
      if (!visible && modalNeo) panels.closeDetail()
      if (neoScene.currentFeed) renderNeoPanel(neoScene.currentFeed, null, neoScene.currentFetchedAt)
    },
  },
})
const { trackedScene } = tracking

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
  // Passed by reference, not by value: `sunMoon.update()` copies into this same
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
// The "Afficher les lunes" preference (2026-11-05), per browser. Unreadable or never
// set means shown; only an explicit false hides them.
moons.setEnabled(loadCached('moons-shown')?.data !== false)

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
    trackedClicked: (entry) => tracking.open(entry.rec.spkid),
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
time.renderPanel(simNowMs(), Date.now())

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
// The tracked list is all that is stored (never the tables): the Sun's table first,
// then one trajectory call per object, one at a time, each object appearing as its
// own answer lands.
tracking.restore()

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

  sunMoon.step(nowMs, wallMs)
  // Real time is rendered on events only; a running fast clock changes its
  // text every frame (renderTime skips the DOM when nothing differs).
  if (!clock.isRealTime()) time.renderPanel(nowMs, wallMs)

  refreshSheetPosition(wallMs)
  tracking.tick(wallMs)

  rig.update(performance.now()) // scale transition, recentring, zoom limits, controls
  starfield.group.position.copy(camera.position)
  earthSystem.globe.updateMatrixWorld()
  applyScale(nowMs / 1000, wallMs)
  updateSceneLabels()

  renderer.render(scene, camera)
}
animate()
