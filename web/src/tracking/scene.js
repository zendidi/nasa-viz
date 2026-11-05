/**
 * The asteroids the user tracks (docs/suivi-asteroides.md): for each, a marker
 * in its own colour and two traces, all read from the tables the backend serves
 * (`/api/small-body/trajectory`, `/precision`, `/trajectory/sun`).
 *
 * Two instants live here since 2026-11-05: T, the scene's time (the clock, the
 * planets, the Earth that is drawn), and T′, the trajectory tool's cursor
 * (tracking/cursor.js). A tracked object is at T′. Option A, "the Earth at the
 * object's instant": the object sits at its **heliocentric** position at T′,
 * drawn around the Sun as displayed, so it lies on its own trace; when T′ ≠ T a
 * translucent "ghost Earth" marks where the Earth was at T′, and the Earth
 * pivot's view follows it (frame.setEarthOffsetKm) — a flyby is always seen from
 * the Earth that took part in it.
 *
 * - The heliocentric trace covers the whole daily range (1 Jan of last year to
 *   1 Jan five years on), `geocentric − Sun` row by row, drawn from every pivot.
 * - The flyby arcs (NEO, ±15 days around each close approach) are geocentric
 *   samples, drawn from the Earth pivot only, relative to the ghost Earth.
 *
 * It owns the loading, the tables and the drawings; it does not own the list
 * (main.js holds it and persists it) and it knows nothing of the panels: what
 * the panels must redraw it announces through `on`. The pure rules — which
 * table an instant reads, which slices to hold — live in tracking/model.js.
 */

import * as THREE from 'three'
import { fetchPrecision, fetchTrajectory, fetchTrajectorySun, searchSmallBody } from '../data/api.js'
import { escapeHtml } from '../neo/info.js'
import { EARTH_ORBIT_COLOR } from '../scene/earthSystem.js'
import { icrfToScene } from '../scene/geo.js'
import {
  activeFlybyArc,
  DASH_HELIO_SECONDS,
  dashKeepsSegment,
  densifyHeliocentric,
  flybyArcTimes,
  flybySegmentColor,
  flybyIdealSlotSeconds,
  flybySlotLevel,
  ghostEarthOffset,
  heliocentricDenseTimes,
  heliocentricPath,
  interpretSearch,
  positionAt,
  sampleTable,
  slicesToLoad,
  tableAt,
  tableEnd,
  yearOf,
} from './model.js'

// Same logic as the NEO dots: a floor in pixels, because at true scale the
// object itself is sub-pixel. The hit sphere is wider so a speck stays clickable.
const MARKER_PX = 5
const HIT_PX = 10
const GHOST_PX = 6

const TRACE_OPACITY = 0.75
// The ghost Earth: a sober blue-white, none of TRACK_COLORS (they mean objects).
const GHOST_COLOR = 0x9fd2ff
const GHOST_OPACITY = 0.4

// An hourly slice that failed is asked again after this long, if the cursor is still there.
const SLICE_RETRY_MS = 60_000

const markerGeometry = new THREE.SphereGeometry(1, 12, 12)
const hitGeometry = new THREE.SphereGeometry(1, 8, 8)
const hitMaterial = new THREE.MeshBasicMaterial({ visible: false })
const ghostGeometry = new THREE.SphereGeometry(1, 24, 16)

const dateShort = (tSeconds) =>
  new Date(tSeconds * 1000).toLocaleDateString('fr-FR', { dateStyle: 'short', timeZone: 'UTC' })

/**
 * @typedef {{status: 'loading'|'ready'|'error', error: string|null, failedAt: number,
 *   hourly: object|null, segments: object[]}} Slice
 *
 * @typedef {{
 *   rec: import('./model.js').TrackedRecord,
 *   status: 'loading'|'ready'|'error'|'missing', error: string|null, object: object|null,
 *   slices: Map<number, Slice>,
 *   group: THREE.Group, mesh: THREE.Mesh, hit: THREE.Mesh,
 *   flybyTrace: object, flybyEarthTrace: object, flybyData: object|null, flybyK: number, flybyAppliedK: number, flybyAppliedArc: number, helioTrace: object, labelEl: HTMLElement,
 *   positionKm: THREE.Vector3, shown: boolean, removed: boolean,
 * }} TrackedEntry
 */

/**
 * @param {object}       options
 * @param {THREE.Scene}  options.scene
 * @param {object}       options.traces  scene/orbitTrace.js
 * @param {{create: (text: string, className?: string) => HTMLElement}} options.labels  labels.js
 * @param {import('../scene/frame.js').ViewFrame} options.frame  the pivot and its placers
 * @param {(worldPos: THREE.Vector3, px: number) => number} options.minRadiusAt
 * @param {ReturnType<import('./cursor.js').createCursor>} options.cursor  the tool's T′ (owned by the controller)
 * @param {{changed: () => void, spkidChanged: (oldSpkid: string, record: object) => void}} options.on
 *   `spkidChanged`: the object was re-resolved under a new SPK-ID (it got numbered)
 */
export function createTrackedScene({ scene, traces, labels, frame, minRadiusAt, cursor, on }) {
  const { placeKm } = frame
  // Markers (what picking raycasts) and traces apart: the raycaster would hit a
  // line too, and a line has no object to report.
  const group = new THREE.Group()
  const traceGroup = new THREE.Group()
  scene.add(group, traceGroup)

  /** @type {Map<string, TrackedEntry>} */
  const entries = new Map()

  const interpIcrf = [0, 0, 0]

  // --- the ghost Earth and the cursor's instant ---------------------------------------

  /** The Sun's daily table (`/trajectory/sun`), shared by every object: loaded once, first. */
  const sun = { status: 'idle', error: null, table: null }

  const ghostMesh = new THREE.Mesh(
    ghostGeometry,
    new THREE.MeshBasicMaterial({ color: GHOST_COLOR, transparent: true, opacity: GHOST_OPACITY, depthWrite: false }),
  )
  ghostMesh.visible = false
  scene.add(ghostMesh)
  const ghostLabelEl = labels.create('Terre')
  ghostLabelEl.style.color = `#${GHOST_COLOR.toString(16).padStart(6, '0')}`
  let ghostLabelDay = null

  /** Where the Earth was at T′, geocentric km at T, scene axes — zero unless the ghost is active. Shared by reference with the flyby traces. */
  const ghostKm = new THREE.Vector3()
  const ghostIcrf = [0, 0, 0]
  let ghostActive = false
  let tPrime = null

  /** Starts tracking a record: the marker exists at once, hidden until its table lands. */
  function add(rec) {
    if (entries.has(rec.spkid)) return entries.get(rec.spkid)
    const pointGroup = new THREE.Group()
    const mesh = new THREE.Mesh(markerGeometry, new THREE.MeshBasicMaterial({ color: rec.color }))
    const hit = new THREE.Mesh(hitGeometry, hitMaterial)
    pointGroup.add(mesh, hit)
    pointGroup.visible = false
    group.add(pointGroup)

    const labelEl = labels.create(rec.fullname)
    labelEl.style.color = `#${rec.color.toString(16).padStart(6, '0')}`

    const flybyTrace = traces.make(rec.color, TRACE_OPACITY, { parent: traceGroup, frame: 'geocentric' })
    // The arcs are small geocentric samples (Float32-safe) moved as a whole onto the ghost Earth.
    flybyTrace.offsetKm = ghostKm
    // Second half of the two-coloured arc (model.js flybySegmentColor): same samples, the Earth orbit's colour.
    const flybyEarthTrace = traces.make(EARTH_ORBIT_COLOR, TRACE_OPACITY, { parent: traceGroup, frame: 'geocentric' })
    flybyEarthTrace.offsetKm = ghostKm

    /** @type {TrackedEntry} */
    const entry = {
      rec,
      status: 'loading',
      error: null,
      object: null,
      slices: new Map(),
      group: pointGroup,
      mesh,
      hit,
      flybyTrace,
      flybyEarthTrace,
      flybyData: null,
      flybyK: 0,
      flybyAppliedK: 0,
      flybyAppliedArc: -1,
      helioTrace: traces.make(rec.color, TRACE_OPACITY, { parent: traceGroup, frame: 'heliocentric' }),
      labelEl,
      positionKm: new THREE.Vector3(),
      shown: false,
      removed: false,
    }
    mesh.userData.tracked = entry
    hit.userData.tracked = entry
    entries.set(rec.spkid, entry)
    if (sun.status === 'idle') enqueue({ kind: 'sun' })
    enqueue({ kind: 'object', entry, resolved: false })
    return entry
  }

  function remove(spkid) {
    const entry = entries.get(spkid)
    if (!entry) return
    entry.removed = true
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].entry === entry) queue.splice(i, 1)
    entries.delete(spkid)
    group.remove(entry.group)
    entry.mesh.material.dispose()
    for (const trace of [entry.flybyTrace, entry.flybyEarthTrace, entry.helioTrace]) {
      traceGroup.remove(trace.line)
      trace.line.geometry.dispose()
      trace.line.material.dispose()
    }
    entry.labelEl.remove()
    on.changed()
  }

  // --- the traces --------------------------------------------------------------------

  /**
   * The heliocentric line: the whole daily table minus the Sun **at each row's own
   * date** (heliocentricPath), like the planets' orbits, drawn from every pivot.
   * Needs both the object's table and the Sun's, in whichever order they land.
   * A dashed object keeps only the segments in an "on" slot of the time pattern
   * (dashKeepsSegment): the dashes are cut the way the below-ecliptic ones are, in setKm.
   */
  function buildHelio(entry) {
    if (!entry.object || !sun.table) return
    const daily = heliocentricPath(entry.object.table, sun.table)
    // 2026-11-05: dense samples (5 min / 1 h, ±3 d) around each passage whose hourly slice is in. The
    // daily chord strayed up to 99 671 km from the true position at TP128's passage (7 490 km): the
    // marker, read from the precise table, left the line. Sun(t) from the Sun's daily table, as the
    // marker's ghost Earth; the line is placed with the clock's Sun (placeHeliocentricKm), residual of a few km.
    const years = loadedYears(entry)
    const passages = (entry.object.close_approaches ?? []).map((a) => a.time).filter((time) => years.includes(yearOf(time)))
    const dense = heliocentricDenseTimes(passages, entry.object.table.start, tableEnd(entry.object.table))
    const icrf = [0, 0, 0]
    const sunAt = [0, 0, 0]
    const { times, positions } = densifyHeliocentric(daily, dense, (time) => {
      if (!positionAt(entry.object, time, icrf) || !sampleTable(sun.table, time, sunAt)) return null
      return [icrf[0] - sunAt[0], icrf[1] - sunAt[1], icrf[2] - sunAt[2]]
    })
    const points = positions.map((p) => icrfToScene(p[0], p[1], p[2], new THREE.Vector3()))
    const dashed = entry.rec.dashed
    traces.setKm(
      entry.helioTrace,
      points,
      dashed ? (i) => dashKeepsSegment(times[i], times[i + 1], DASH_HELIO_SECONDS) : () => true,
    )
  }

  /** The years whose precision slice is in. */
  const loadedYears = (entry) => [...entry.slices].filter(([, slice]) => slice.status === 'ready').map(([year]) => year)

  /**
   * The flyby arcs (geocentric, ±15 days around each close approach), sampled
   * from `positionAt`, so the hourly slice and the 5-minute segments shape the
   * perigee. An approach gets its arc **only once its year's slice is in**: drawn
   * from the daily table the arc would be off by tens of thousands of km at the
   * perigee — wrong in a way the eye would take for right. Rebuilt whenever a
   * slice arrives or leaves.
   */
  function buildFlyby(entry) {
    const { object } = entry
    if (!object) return
    entry.flybyData = null
    const years = loadedYears(entry)
    const start = object.table.start
    const end = tableEnd(object.table)
    const times = (object.close_approaches ?? []).map((a) => a.time).filter((time) => years.includes(yearOf(time)))
    const arcs = flybyArcTimes(times, start, end)
    const samples = []
    const sampleTimes = []
    /** Index of each arc's first sample: the segment leading into it would join two flybys. */
    const arcStarts = new Set()
    /** Which arc each sample belongs to: the cursor shows one arc at a time (activeFlybyArc). */
    const arcOf = []
    const icrf = [0, 0, 0]
    for (const [index, arc] of arcs.entries()) {
      arcStarts.add(samples.length)
      for (const time of arc) {
        if (positionAt(object, time, icrf)) {
          samples.push(icrfToScene(icrf[0], icrf[1], icrf[2], new THREE.Vector3()))
          sampleTimes.push(time)
          arcOf.push(index)
        }
      }
    }
    entry.flybyData = { samples, sampleTimes, arcStarts, arcOf, arcs }
    applyFlybyColors(entry)
  }

  /**
   * Two traces on the same samples, each keeping the segments of its colour:
   * every consecutive pair belongs to at most one of them, so no gap but the dashes'.
   * Re-run only when the entry's slot level k changes (flybyK) and whenever the arc is rebuilt.
   */
  function applyFlybyColors(entry) {
    if (!entry.flybyData) return
    const { samples, sampleTimes, arcStarts, arcOf, arcs } = entry.flybyData
    const dashed = entry.rec.dashed
    // 2026-11-05: only the arc whose window holds T′ is drawn (Apophis's 2029 arc ran through the
    // Earth view of 14/10/2026, 18,4 million km from where its path really passes). Rebuilt on
    // an arc change, not per frame.
    const active = tPrime === null ? -1 : activeFlybyArc(arcs, tPrime)
    const keeps = (which) => (i) =>
      arcOf[i] === active && !arcStarts.has(i + 1) && flybySegmentColor(sampleTimes[i], sampleTimes[i + 1], dashed, entry.flybyK) === which
    traces.setKm(entry.flybyTrace, samples, keeps('object'))
    traces.setKm(entry.flybyEarthTrace, samples, keeps('earth'))
    entry.flybyAppliedK = entry.flybyK
    entry.flybyAppliedArc = active
  }

  /** The object's finer tables, from the slices that are in: what `tableAt` reads. */
  function rebuildTables(entry) {
    const ready = [...entry.slices].filter(([, slice]) => slice.status === 'ready').sort((a, b) => a[0] - b[0])
    entry.object.hourly = ready.map(([, slice]) => slice.hourly)
    entry.object.segments = ready.flatMap(([, slice]) => slice.segments)
  }

  // --- the loading queue (2026-11-05) ---------------------------------------------
  //
  // One request at a time. On Windows the `php -S` server handles a single request
  // at once (measured: `PHP_CLI_SERVER_WORKERS` answers "forking is not supported
  // on this platform"), so at startup the saved objects all left together and
  // queued up in front of the ISS, the planets and the rest. Here they go one
  // after the other; an object removed while it waits just leaves the queue.
  // The order is the job kind's: the Sun first (every trace needs it), then each
  // object's daily table, then the hourly slices — a slice is a refinement, and
  // must not hold a newly tracked object's first appearance behind it.
  // The status stays `loading` from the moment of `enqueue`.
  const PRIORITY = { sun: 0, object: 1, slice: 2 }
  /** @type {({kind: 'sun'} | {kind: 'object', entry: TrackedEntry, resolved: boolean} | {kind: 'slice', entry: TrackedEntry, year: number})[]} */
  const queue = []
  let pumping = false

  function enqueue(job) {
    if (job.kind === 'sun') {
      sun.status = 'loading'
      sun.error = null
    }
    if (job.kind === 'object') {
      job.entry.status = 'loading'
      job.entry.error = null
    }
    queue.push(job)
    on.changed()
    pump()
  }

  function takeNext() {
    let best = 0
    for (let i = 1; i < queue.length; i++) if (PRIORITY[queue[i].kind] < PRIORITY[queue[best].kind]) best = i
    return queue.splice(best, 1)[0]
  }

  async function pump() {
    if (pumping) return
    pumping = true
    try {
      while (queue.length > 0) {
        const job = takeNext()
        if (job.kind === 'sun') await loadSun()
        else if (job.entry.removed) continue
        else if (job.kind === 'object') await load(job.entry, job.resolved)
        else await loadSlice(job.entry, job.year)
      }
    } finally {
      pumping = false
    }
  }

  async function loadSun() {
    try {
      const res = await fetchTrajectorySun()
      if (!(res.table?.positions?.length > 0)) throw new Error('table du Soleil vide')
      sun.table = res.table
      sun.status = 'ready'
      for (const entry of entries.values()) buildHelio(entry)
    } catch (err) {
      sun.status = 'error'
      sun.error = err.message
    }
    on.changed()
  }

  /**
   * One request for this object (one slot of the queue). If its SPK-ID is no
   * longer known (`null` in `objects`), it is the numbering trap of the doc: an
   * object that gets a number changes SPK-ID (`5xxxxxxx` to `2xxxxxxx`). The
   * designation is looked up once more and the stored id replaced — once only, or
   * an object truly gone would loop. The second request goes back to the *end* of
   * the queue (`enqueue`) instead of holding the slot through the search.
   */
  async function load(entry, resolved) {
    try {
      const spkid = entry.rec.spkid
      const res = await fetchTrajectory(spkid)
      if (entry.removed) return
      const object = res.objects?.[spkid] ?? null
      if (object?.table?.positions?.length > 0) {
        entry.object = { ...object, hourly: [], segments: [] }
        entry.status = 'ready'
        buildHelio(entry)
        buildFlyby(entry)
        slicesDirty = true
        on.changed()
        return
      }
      if (!resolved) {
        const found = interpretSearch(await searchSmallBody(entry.rec.des))
        if (entry.removed) return
        if (found.kind === 'match' && found.record.spkid !== spkid) {
          entries.delete(spkid)
          // Colour, line style and `saved` stay with the object, not with the id.
          entry.rec = { ...entry.rec, ...found.record }
          entries.set(entry.rec.spkid, entry)
          on.spkidChanged(spkid, entry.rec)
          enqueue({ kind: 'object', entry, resolved: true })
          return
        }
      }
      entry.status = 'missing'
    } catch (err) {
      if (entry.removed) return
      entry.status = 'error'
      entry.error = err.message
    }
    on.changed()
  }

  /** One hourly slice (+ its 5-minute segments) of a NEO, for one civil year. A slice dropped while it loaded is simply discarded. */
  async function loadSlice(entry, year) {
    const slice = entry.slices.get(year)
    if (!slice) return
    try {
      const spkid = entry.rec.spkid
      const res = await fetchPrecision(spkid, year)
      const object = res.objects?.[spkid]
      if (entry.removed || entry.slices.get(year) !== slice) return
      if (!(object?.table?.positions?.length > 0)) throw new Error(`pas de table de précision pour ${year}`)
      slice.hourly = object.table
      slice.segments = Array.isArray(object.segments) ? object.segments : []
      slice.status = 'ready'
      rebuildTables(entry)
      buildHelio(entry)
      buildFlyby(entry)
    } catch (err) {
      if (entry.removed || entry.slices.get(year) !== slice) return
      slice.status = 'error'
      slice.error = err.message
      slice.failedAt = Date.now()
    }
    on.changed()
  }

  /**
   * Keeps the precision slices around the cursor (a NEO only — a non-NEO's daily
   * table is enough, ~14 km away from the Earth). The rule is model.slicesToLoad.
   */
  function ensureSlices(entry, tPrimeS, wallMs) {
    if (!entry.rec.neo || !entry.object) return
    for (const [year, slice] of entry.slices) {
      if (slice.status === 'error' && wallMs - slice.failedAt > SLICE_RETRY_MS) entry.slices.delete(year)
    }
    const wallYear = new Date(wallMs).getUTCFullYear()
    const { load: toLoad, evict } = slicesToLoad(tPrimeS, [...entry.slices.keys()], {
      minYear: wallYear - 1,
      maxYear: wallYear + 4,
    })
    if (evict.length > 0) {
      for (const year of evict) entry.slices.delete(year)
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].kind === 'slice' && queue[i].entry === entry && evict.includes(queue[i].year)) queue.splice(i, 1)
      }
      rebuildTables(entry)
      buildHelio(entry)
      buildFlyby(entry)
    }
    for (const year of toLoad) {
      entry.slices.set(year, { status: 'loading', error: null, failedAt: 0, hourly: null, segments: [] })
      enqueue({ kind: 'slice', entry, year })
    }
  }

  // --- the cursor ----------------------------------------------------------------------

  let slicesDirty = true
  let slicesKey = null

  /**
   * Reads the cursor for this frame: T′, the ghost Earth, the Earth pivot's
   * shift. Called **before** anything is placed (main.js applyScale), because the
   * pivot's origin moves with it. At offset zero T′ is T, the ghost is off and the
   * shift is `null` — the scene is exactly what it was without the tool.
   */
  function syncCursor(nowS, wallMs) {
    cursor.step(nowS, wallMs)
    tPrime = cursor.tPrimeAt(nowS, wallMs)
    ghostActive = false
    if (tPrime !== nowS && sun.table && ghostEarthOffset(sun.table, nowS, tPrime, ghostIcrf)) {
      icrfToScene(ghostIcrf[0], ghostIcrf[1], ghostIcrf[2], ghostKm)
      ghostActive = ghostKm.lengthSq() > 0
    }
    if (!ghostActive) ghostKm.set(0, 0, 0)
    frame.setEarthOffsetKm(ghostActive ? ghostKm : null)

    const day = Math.floor(tPrime / 86_400)
    if (ghostActive && day !== ghostLabelDay) {
      ghostLabelDay = day
      ghostLabelEl.textContent = `Terre au ${dateShort(tPrime)}`
    }

    // Slices follow the cursor by the hour, not by the frame.
    const key = Math.floor(tPrime / 3600)
    if (slicesDirty || key !== slicesKey) {
      slicesDirty = false
      slicesKey = key
      for (const entry of entries.values()) ensureSlices(entry, tPrime, wallMs)
    }
  }

  const scratchKm = new THREE.Vector3()
  const speedA = new THREE.Vector3()
  const speedB = new THREE.Vector3()

  /**
   * The active arc's speed near T′ in **scene units** per second: the scene distance between
   * the two placed samples that bracket T′, over their time gap. Null when T′ is not inside
   * the active arc. Follows the scale curve, so the slots stay the same length on screen.
   */
  function arcSceneSpeed(entry, active, t) {
    const { samples, sampleTimes, arcOf } = entry.flybyData
    let lo = 0
    let hi = sampleTimes.length - 1
    while (lo < hi) { // last i with sampleTimes[i] <= tPrime (arcs are sorted and disjoint)
      const mid = (lo + hi + 1) >> 1
      if (sampleTimes[mid] <= tPrime) lo = mid
      else hi = mid - 1
    }
    if (lo + 1 >= sampleTimes.length || arcOf[lo] !== active || arcOf[lo + 1] !== active) return null
    placeKm(speedA, speedA.copy(samples[lo]).add(ghostKm), t)
    placeKm(speedB, speedB.copy(samples[lo + 1]).add(ghostKm), t)
    const dt = sampleTimes[lo + 1] - sampleTimes[lo]
    return dt > 0 ? speedA.distanceTo(speedB) / dt : null
  }

  /** Places every marker and trace at the cursor's instant and the current scale. */
  function update(nowS, t, zoom = null) {
    if (tPrime === null) syncCursor(nowS, Date.now())
    ghostMesh.visible = ghostActive
    if (ghostActive) {
      placeKm(ghostMesh.position, ghostKm, t)
      // Seen from the Earth pivot the ghost IS the Earth: its true size, so the
      // perigee distance reads against it; elsewhere only a speck, like the objects.
      const speck = minRadiusAt(ghostMesh.position, GHOST_PX)
      ghostMesh.scale.setScalar(frame.id === 'earth' ? Math.max(speck, frame.radius(t)) : speck)
    }
    for (const entry of entries.values()) {
      // Geocentric at T′, then onto the ghost Earth; with the cursor at T the ghost is zero and this is the plain geocentric position.
      // Away from T it needs the Sun's table: without it the object cannot be put anywhere honest, so it waits.
      const position = entry.object ? positionAt(entry.object, tPrime, interpIcrf) : null
      entry.shown = position !== null && (ghostActive || tPrime === nowS)
      entry.group.visible = entry.shown
      if (entry.shown) {
        icrfToScene(position[0], position[1], position[2], entry.positionKm).add(ghostKm)
        placeKm(entry.group.position, entry.positionKm, t)
        entry.mesh.scale.setScalar(minRadiusAt(entry.group.position, MARKER_PX))
        entry.hit.scale.setScalar(minRadiusAt(entry.group.position, HIT_PX))
      }
      traces.update(entry.helioTrace, t)
      if (entry.flybyData) {
        const active = activeFlybyArc(entry.flybyData.arcs, tPrime)
        // Each object has its own k (its own speed); recomputed per frame, the colours only when k or the arc change.
        if (zoom && active >= 0 && frame.geocentric()) {
          const speed = arcSceneSpeed(entry, active, t)
          if (speed > 0) entry.flybyK = flybySlotLevel(flybyIdealSlotSeconds(zoom.distance, speed), entry.flybyK)
        }
        if (entry.flybyAppliedK !== entry.flybyK || entry.flybyAppliedArc !== active) applyFlybyColors(entry)
      }
      for (const trace of [entry.flybyTrace, entry.flybyEarthTrace]) {
        if (entry.object && frame.geocentric()) traces.update(trace, t)
        else trace.line.visible = false
      }
    }
  }

  /** Geocentric distance, km, at an instant — null while there is no table for it. */
  function distanceKmAt(entry, tSeconds) {
    if (!entry.object) return null
    const position = positionAt(entry.object, tSeconds, interpIcrf)
    if (!position) return null
    return icrfToScene(position[0], position[1], position[2], scratchKm).length()
  }

  /**
   * The position line of the sheet: the real Earth-object distance at the cursor's
   * instant, and which table it was read from — a 5 min segment is the one that
   * makes a close flyby trustworthy. For a NEO read from the daily table, it says
   * whether the precision slice of that year is still on its way.
   *
   * @param {number} tSeconds  the cursor's instant T′
   * @param {boolean} live     true when T′ is the real present (cursor at zero, clock at ×1)
   */
  function describePosition(entry, tSeconds, live = false) {
    switch (entry.status) {
      case 'loading':
        return '<p class="muted">Position : chargement de la table (JPL Horizons)…</p>'
      case 'error':
        return `<p class="error">${escapeHtml(entry.error ?? '')}</p>`
      case 'missing':
        return '<p class="muted">Objet plus reconnu par JPL : pas de position.</p>'
    }
    const distance = distanceKmAt(entry, tSeconds)
    if (distance === null) {
      return '<p class="muted">Hors de la plage de la trajectoire : position inconnue à cet instant.</p>'
    }
    const table = tableAt(entry.object, tSeconds)
    let step = 'table journalière'
    if (table.kind === 'segment') step = 'table de 5 min, passage rapproché'
    else if (table.kind === 'hourly') step = 'table horaire'
    else if (entry.rec.neo) {
      const slice = entry.slices.get(yearOf(tSeconds))
      step = slice?.status === 'error' ? 'table journalière — précision indisponible' : 'table journalière — précision en chargement'
    }
    const km = Math.round(distance).toLocaleString('fr-FR')
    const when = new Date(tSeconds * 1000).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' })
    return live
      ? `<p><strong>Distance actuelle</strong> ${km} km <span class="muted">(position réelle, JPL Horizons, ${step})</span></p>`
      : `<p><strong>Distance au ${when} UTC</strong> ${km} km <span class="muted">(position réelle JPL Horizons, ${step})</span></p>`
  }

  return {
    /** The group the markers live in — picking raycasts against it. */
    group,
    add,
    remove,
    /** Retries an object whose request failed (or whose id was not recognised). */
    reload(spkid) {
      const entry = entries.get(spkid)
      if (entry && (entry.status === 'error' || entry.status === 'missing')) enqueue({ kind: 'object', entry, resolved: false })
    },
    /** Retries the Sun's table, which every trace waits for. */
    reloadSun() {
      if (sun.status === 'error') enqueue({ kind: 'sun' })
    },
    /** The Sun's table: `idle` until something is tracked. */
    sunState: () => ({ status: sun.status, error: sun.error }),
    /** The span of the daily tables (the Sun's, which the objects share), or null while it is not in. */
    range: () => (sun.table ? { startS: sun.table.start, endS: tableEnd(sun.table) } : null),
    get: (spkid) => entries.get(spkid) ?? null,
    /** Geocentric positions, km, scene axes, of the objects currently placed — for the camera's reach. */
    positionsKm() {
      return [...entries.values()].filter((entry) => entry.shown).map((entry) => entry.positionKm)
    },
    syncCursor,
    update,
    describePosition,
    distanceKmAt,
    /** Same shape as the planets' and moons': the caller concatenates them. */
    labelEntries() {
      return [
        ...[...entries.values()].map((entry) => ({
          el: entry.labelEl,
          worldPos: entry.group.position,
          occludable: true,
          show: entry.shown,
        })),
        { el: ghostLabelEl, worldPos: ghostMesh.position, occludable: true, show: ghostActive },
      ]
    },
  }
}
