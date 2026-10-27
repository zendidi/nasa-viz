/**
 * The asteroids the user tracks (docs/suivi-asteroides.md): for each, a marker
 * in its own colour at its real position and a trace over the whole window of
 * the clock (geocentric or heliocentric depending on the pivot, see buildTrace), both read from the precise table that
 * `/api/small-body/positions` serves — one request per object, independent,
 * each object appearing as soon as its own answer lands.
 *
 * It owns the loading, the tables and the drawings; it does not own the list
 * (main.js holds it and persists it) and it knows nothing of the panels: what
 * the panels must redraw it announces through `on`. The pure rules — which
 * table an instant reads, how a search answer is read — live in tracking.js.
 */

import * as THREE from 'three'
import { fetchSmallBodyPositions, searchSmallBody } from '../api.js'
import { escapeHtml } from '../neoInfo.js'
import { icrfToScene } from '../scene/geo.js'
import { interpretSearch, positionAt, tableAt } from '../tracking.js'

// Same logic as the NEO dots: a floor in pixels, because at true scale the
// object itself is sub-pixel. The hit sphere is wider so a speck stays clickable.
const MARKER_PX = 5
const HIT_PX = 10

// The trace needs far fewer points than the table: an hourly table has ~11 000
// rows and the trace is re-projected every frame. One point per 6 h keeps a
// year at ~1 500 vertices per object; the marker itself is placed from the full
// table, so only the line is coarse.
const TRACE_STEP_SECONDS = 6 * 3600
const TRACE_OPACITY = 0.75

const markerGeometry = new THREE.SphereGeometry(1, 12, 12)
const hitGeometry = new THREE.SphereGeometry(1, 8, 8)
const hitMaterial = new THREE.MeshBasicMaterial({ visible: false })

/**
 * @typedef {{
 *   rec: import('../tracking.js').TrackedRecord,
 *   status: 'loading'|'ready'|'error'|'missing', error: string|null, object: object|null,
 *   group: THREE.Group, mesh: THREE.Mesh, hit: THREE.Mesh,
 *   trace: object, helioTrace: object, labelEl: HTMLElement,
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
 * @param {(date: Date, out: THREE.Vector3) => THREE.Vector3} options.sunPositionKmAt
 *   the Sun's geocentric position, km, scene axes, at any date of the window
 * @param {{changed: () => void, spkidChanged: (oldSpkid: string, record: object) => void}} options.on
 *   `spkidChanged`: the object was re-resolved under a new SPK-ID (it got numbered)
 */
export function createTrackedScene({ scene, traces, labels, frame, minRadiusAt, sunPositionKmAt, on }) {
  const { placeKm } = frame
  // Markers (what picking raycasts) and traces apart: the raycaster would hit a
  // line too, and a line has no object to report.
  const group = new THREE.Group()
  const traceGroup = new THREE.Group()
  scene.add(group, traceGroup)

  /** @type {Map<string, TrackedEntry>} */
  const entries = new Map()

  const interpIcrf = [0, 0, 0]

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

    /** @type {TrackedEntry} */
    const entry = {
      rec,
      status: 'loading',
      error: null,
      object: null,
      group: pointGroup,
      mesh,
      hit,
      trace: traces.make(rec.color, TRACE_OPACITY, { parent: traceGroup, frame: 'geocentric' }),
      helioTrace: traces.make(rec.color, TRACE_OPACITY, { parent: traceGroup, frame: 'heliocentric' }),
      labelEl,
      positionKm: new THREE.Vector3(),
      shown: false,
      removed: false,
    }
    mesh.userData.tracked = entry
    hit.userData.tracked = entry
    entries.set(rec.spkid, entry)
    load(entry)
    return entry
  }

  function remove(spkid) {
    const entry = entries.get(spkid)
    if (!entry) return
    entry.removed = true
    entries.delete(spkid)
    group.remove(entry.group)
    entry.mesh.material.dispose()
    for (const trace of [entry.trace, entry.helioTrace]) {
      traceGroup.remove(trace.line)
      trace.line.geometry.dispose()
      trace.line.material.dispose()
    }
    entry.labelEl.remove()
    on.changed()
  }

  /**
   * The trace over the whole base table, thinned to TRACE_STEP_SECONDS, in two
   * frames. The table is geocentric, so drawn as such it carries the Earth's own
   * yearly motion: seen from the Sun, every asteroid looped around a copy of the
   * Earth's orbit (user report, 2026-10-27). The heliocentric copy subtracts the
   * Sun **at each sample's own date** — like the planets' orbits — and is the one
   * drawn from every pivot but the Earth and the Moon, where the geocentric path
   * is the meaningful one (a NEO's flyby).
   */
  function buildTrace(entry, object) {
    const { positions, start, step_seconds: step } = object.table
    const stride = Math.max(1, Math.round(TRACE_STEP_SECONDS / step))
    const indices = []
    for (let i = 0; i < positions.length; i += stride) indices.push(i)
    if (indices[indices.length - 1] !== positions.length - 1) indices.push(positions.length - 1)
    const samples = indices.map((i) => icrfToScene(positions[i][0], positions[i][1], positions[i][2], new THREE.Vector3()))
    traces.setKm(entry.trace, samples, () => true)
    const sunKm = new THREE.Vector3()
    const helio = samples.map((p, k) => p.clone().sub(sunPositionKmAt(new Date((start + indices[k] * step) * 1000), sunKm)))
    traces.setKm(entry.helioTrace, helio, () => true)
  }

  /**
   * One request for this object. If its SPK-ID is no longer known (`null` in
   * `objects`), it is the numbering trap of the doc: an object that gets a
   * number changes SPK-ID (`5xxxxxxx` to `2xxxxxxx`). The designation is looked
   * up once more and the stored id replaced — once only, or an object truly
   * gone would loop.
   */
  async function load(entry, { resolved = false } = {}) {
    entry.status = 'loading'
    entry.error = null
    on.changed()
    try {
      const spkid = entry.rec.spkid
      const res = await fetchSmallBodyPositions(spkid)
      if (entry.removed) return
      const object = res.objects?.[spkid] ?? null
      if (object?.table?.positions?.length > 0) {
        entry.object = object
        entry.status = 'ready'
        buildTrace(entry, object)
        on.changed()
        return
      }
      if (!resolved) {
        const found = interpretSearch(await searchSmallBody(entry.rec.des))
        if (entry.removed) return
        if (found.kind === 'match' && found.record.spkid !== spkid) {
          entries.delete(spkid)
          entry.rec = { ...found.record, color: entry.rec.color }
          entries.set(entry.rec.spkid, entry)
          on.spkidChanged(spkid, entry.rec)
          await load(entry, { resolved: true })
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

  const scratchKm = new THREE.Vector3()

  /** Places every marker and trace at the current instant and scale. */
  function update(nowSeconds, t) {
    for (const entry of entries.values()) {
      const position = entry.object ? positionAt(entry.object, nowSeconds, interpIcrf) : null
      entry.shown = position !== null
      entry.group.visible = entry.shown
      if (position) {
        icrfToScene(position[0], position[1], position[2], entry.positionKm)
        placeKm(entry.group.position, entry.positionKm, t)
        entry.mesh.scale.setScalar(minRadiusAt(entry.group.position, MARKER_PX))
        entry.hit.scale.setScalar(minRadiusAt(entry.group.position, HIT_PX))
      }
      const geocentric = frame.geocentric()
      const [drawn, hidden] = geocentric ? [entry.trace, entry.helioTrace] : [entry.helioTrace, entry.trace]
      hidden.line.visible = false
      if (entry.object) traces.update(drawn, t)
      else drawn.line.visible = false
    }
  }

  /** Geocentric distance, km, at an instant — null while there is no table for it. */
  function distanceKmAt(entry, nowSeconds) {
    if (!entry.object) return null
    const position = positionAt(entry.object, nowSeconds, interpIcrf)
    if (!position) return null
    return icrfToScene(position[0], position[1], position[2], scratchKm).length()
  }

  /**
   * The position line of the sheet. Says which table it was read from: a 5 min
   * segment is the one that makes a close flyby trustworthy.
   *
   * @param {number} nowSeconds  the simulated clock's time
   * @param {boolean} simulated  true when that is not the real time
   */
  function describePosition(entry, nowSeconds, simulated = false) {
    switch (entry.status) {
      case 'loading':
        return '<p class="muted">Position : chargement de la table (JPL Horizons)…</p>'
      case 'error':
        return `<p class="error">${escapeHtml(entry.error ?? '')}</p>`
      case 'missing':
        return '<p class="muted">Objet plus reconnu par JPL : pas de position.</p>'
    }
    const distance = distanceKmAt(entry, nowSeconds)
    if (distance === null) {
      return '<p class="muted">Hors de la plage des tables JPL : position inconnue à cet instant.</p>'
    }
    const table = tableAt(entry.object, nowSeconds)
    const step = table.fine ? 'table de 5 min, passage rapproché' : table.stepSeconds === 3600 ? 'table horaire' : 'table journalière'
    const km = Math.round(distance).toLocaleString('fr-FR')
    const when = new Date(nowSeconds * 1000).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
    return simulated
      ? `<p><strong>Distance au ${when}</strong> ${km} km <span class="muted">(temps simulé, position réelle JPL Horizons, ${step})</span></p>`
      : `<p><strong>Distance actuelle</strong> ${km} km <span class="muted">(position réelle, JPL Horizons, ${step})</span></p>`
  }

  return {
    /** The group the markers live in — picking raycasts against it. */
    group,
    add,
    remove,
    /** Retries an object whose request failed (or whose id was not recognised). */
    reload(spkid) {
      const entry = entries.get(spkid)
      if (entry && (entry.status === 'error' || entry.status === 'missing')) load(entry)
    },
    get: (spkid) => entries.get(spkid) ?? null,
    /** Geocentric positions, km, scene axes, of the objects currently placed — for the camera's reach. */
    positionsKm() {
      return [...entries.values()].filter((entry) => entry.shown).map((entry) => entry.positionKm)
    },
    update,
    describePosition,
    distanceKmAt,
    /** Same shape as the planets' and moons': the caller concatenates them. */
    labelEntries() {
      return [...entries.values()].map((entry) => ({
        el: entry.labelEl,
        worldPos: entry.group.position,
        occludable: true,
        show: entry.shown,
      }))
    },
  }
}
