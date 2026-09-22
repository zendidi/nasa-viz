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
 * @typedef {{
 *   line: THREE.LineSegments, km: Float32Array|null, pairs: Int32Array|null,
 *   relativeToPivot: boolean,
 * }} OrbitTrace
 *
 * `relativeToPivot` says how the stored samples are expressed: heliocentric
 * traces are already relative to the Sun (the pivot that draws them), the Moon's
 * is geocentric like every body position, and goes through placeKm().
 */

/**
 * @param {object} placers
 * @param {(out: THREE.Vector3, geocentricKm: THREE.Vector3, t: number) => void} placers.placeKm
 * @param {(out: THREE.Vector3, relativeKm: ArrayLike<number>|THREE.Vector3, t: number) => void} placers.placeRelativeKm
 */
export function createOrbitTraces({ placeKm, placeRelativeKm }) {
  const scratch = new THREE.Vector3()

  /** @returns {OrbitTrace} */
  function make(color, opacity, { parent, relativeToPivot = true }) {
    const line = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
    )
    line.frustumCulled = false // vertices move every frame; the bounding sphere would be stale
    parent.add(line)
    return { line, km: null, pairs: null, relativeToPivot }
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

  function update(trace, t) {
    if (!trace.km || trace.pairs.length === 0) {
      trace.line.visible = false
      return
    }
    const place = trace.relativeToPivot ? placeRelativeKm : placeKm
    const positions = trace.line.geometry.getAttribute('position')
    for (let i = 0; i < trace.pairs.length; i++) {
      scratch.fromArray(trace.km, trace.pairs[i] * 3)
      place(scratch, scratch, t)
      positions.setXYZ(i, scratch.x, scratch.y, scratch.z)
    }
    positions.needsUpdate = true
    trace.line.visible = true
  }

  return { make, setKm, setAu, update }
}
