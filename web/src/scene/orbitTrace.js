/**
 * Orbit traces: a polyline whose samples are stored once in km (scene axes) and
 * re-projected through the scene's compression every frame, so the line follows
 * the scale slider and keeps passing through its own body at every setting.
 *
 * Shared by the NEO's heliocentric ellipse and by the Moon's and the Earth's own
 * orbits — nothing here knows which.
 */

import * as THREE from 'three'
import { eclipticAuToSceneKm } from './geo.js'

/**
 * @typedef {'pivot' | 'geocentric' | 'heliocentric'} OrbitFrame
 *
 * What the stored samples are relative to — the one thing a trace must declare,
 * since nothing in a Float32Array says where its origin is:
 *
 * - `pivot`: already relative to the body the scene is centred on. A moon's
 *   orbit around its planet, drawn only while that planet is the pivot;
 * - `geocentric`: relative to the Earth, like every body position in this
 *   scene (the Moon's own orbit);
 * - `heliocentric`: relative to the Sun — where orbital elements and the
 *   backend's orbit tables both land.
 *
 * The third one is new (2026-10-12) and it is the whole point of naming the
 * frame. Heliocentric samples *are* pivot-relative when the pivot is the Sun,
 * which is why they were drawn as such and only from there; read from any other
 * pivot they ringed the wrong body. They now go through their own placer, so a
 * heliocentric orbit draws correctly from every pivot.
 *
 * @typedef {{
 *   line: THREE.LineSegments, km: Float32Array|null, pairs: Int32Array|null,
 *   frame: OrbitFrame, offsetKm: THREE.Vector3|null,
 * }} OrbitTrace
 */

/**
 * @param {object} placers
 * @param {(out: THREE.Vector3, geocentricKm: THREE.Vector3, t: number) => void} placers.placeKm
 * @param {(out: THREE.Vector3, relativeKm: ArrayLike<number>|THREE.Vector3, t: number) => void} placers.placeRelativeKm
 * @param {(out: THREE.Vector3, heliocentricKm: THREE.Vector3, t: number) => void} placers.placeHeliocentricKm
 */
export function createOrbitTraces({ placeKm, placeRelativeKm, placeHeliocentricKm }) {
  const scratch = new THREE.Vector3()
  /** @type {Record<OrbitFrame, Function>} */
  const placers = { pivot: placeRelativeKm, geocentric: placeKm, heliocentric: placeHeliocentricKm }

  /**
   * @param {{parent: THREE.Object3D, frame?: OrbitFrame}} options
   * @returns {OrbitTrace}
   */
  function make(color, opacity, { parent, frame = 'pivot' }) {
    const line = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
    )
    line.frustumCulled = false // vertices move every frame; the bounding sphere would be stale
    parent.add(line)
    return { line, km: null, pairs: null, frame, offsetKm: null }
  }

  /**
   * Fills a trace from samples already in km, scene axes (a body's own path).
   * `keepSegment(i)` decides whether the segment starting at sample i is drawn —
   * that's how the below-ecliptic dashes and the two halves of the ellipse are
   * cut, without ever leaving a gap: every consecutive pair belongs to exactly
   * one of the two traces.
   */
  function setKm(trace, pointsKm, keepSegment) {
    const pairs = []
    for (let i = 0; i + 1 < pointsKm.length; i++) {
      if (keepSegment(i)) pairs.push(i, i + 1)
    }
    const km = new Float32Array(pointsKm.length * 3)
    pointsKm.forEach((p, i) => km.set([p.x, p.y, p.z], i * 3))

    trace.km = km
    trace.pairs = Int32Array.from(pairs)
    trace.line.geometry.dispose()
    trace.line.geometry = new THREE.BufferGeometry()
    trace.line.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pairs.length * 3), 3))
  }

  /** Same, from samples in heliocentric ecliptic au (orbital elements). */
  function setAu(trace, pointsAu, keepSegment) {
    setKm(
      trace,
      pointsAu.map((p) => eclipticAuToSceneKm(p, new THREE.Vector3())),
      keepSegment,
    )
  }

  /**
   * `trace.offsetKm`, when set, rigidly translates the whole line in km (scene
   * axes) **before** the scene's compression is applied, so it is a real
   * displacement at every scale and costs one addition per vertex, with no
   * geometry rebuild. Set by the owner each frame (Pluto's line, planets.js).
   */
  function update(trace, t) {
    if (!trace.km || trace.pairs.length === 0) {
      trace.line.visible = false
      return
    }
    const place = placers[trace.frame]
    const positions = trace.line.geometry.getAttribute('position')
    for (let i = 0; i < trace.pairs.length; i++) {
      scratch.fromArray(trace.km, trace.pairs[i] * 3)
      if (trace.offsetKm) scratch.add(trace.offsetKm)
      place(scratch, scratch, t)
      positions.setXYZ(i, scratch.x, scratch.y, scratch.z)
    }
    positions.needsUpdate = true
    trace.line.visible = true
  }

  return { make, setKm, setAu, update }
}
