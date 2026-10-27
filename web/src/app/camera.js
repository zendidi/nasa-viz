/**
 * The camera and the "réalisme" scale it is framed in: the slider's step, the
 * animated `t` (scale.js, docs/echelle-reelle.md), the zoom range and far plane
 * that follow how far the scene extends, recentring, and the camera's half of a
 * change of pivot.
 *
 * It knows the pivot (`frame`) but not what the scene contains: main.js hands
 * it the pivot's yardsticks (`references`) and how far everything drawn lies
 * (`extentKm`), and is told through `on.stepChanged` when the panels must
 * follow the slider.
 */

import * as THREE from 'three'
import { SCALE_STEPS, lerpLog, remapCameraDistance, sceneDistance, sceneDistanceToKm, stepToT, worldPerPixel } from '../view/scale.js'

const SCALE_TRANSITION_MS = 1500

// Dragging with the right button wanders off the pivot; this brings it back to
// the centre of the view without touching the zoom or the viewing angle.
const RECENTER_MS = 600

function medianOf(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[sorted.length >> 1]
}

/**
 * @param {object} options
 * @param {THREE.PerspectiveCamera} options.camera
 * @param {object} options.controls  OrbitControls
 * @param {HTMLCanvasElement} options.canvas  for the pixel size of the view
 * @param {import('../scene/frame.js').ViewFrame} options.frame
 * @param {() => {label: string, km: number}[]} options.references  the pivot's
 *   yardsticks at their real current distance, the first one framing the view
 * @param {(t: number) => number[]} options.extentKm  distances from the pivot,
 *   km, of everything drawn at scale t — what the zoom must be able to reach
 * @param {() => number} options.extentUnits  anything already in scene units
 *   that must stay reachable (the drawn NEO orbit's aphelion), 0 if none
 * @param {() => number[]} options.neoDistancesKm  for the median NEO anchor
 * @param {{stepChanged: Function}} options.on  the slider moved to a new step
 */
export function createCameraRig({ camera, controls, canvas, frame, references, extentKm, extentUnits, neoDistancesKm, on }) {
  // The session opens on 100 % réel (2026-10-27), centred on the Sun — see the
  // setFocus('sun') at start-up in main.js. Set here rather than animated in:
  // there is nothing on screen yet to transition from.
  let step = SCALE_STEPS // slider position, 0..SCALE_STEPS
  let t = stepToT(SCALE_STEPS) // current value, animated toward stepToT(step)
  let transition = null // { from, to, startMs }
  let recenterTween = null

  /**
   * Camera distances that should "stay put" relative to the scene when t
   * changes: close to the surface (unchanged), the Moon, the median NEO.
   * Filtered to stay strictly increasing at both t values.
   */
  function cameraAnchors(tFrom, tTo, neoMedianKm) {
    const from = [controls.minDistance]
    const to = [controls.minDistance]
    const curve = frame.focus.curve
    const candidates = references().map((reference) => reference.km)
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

  function stepTransition(nowMs) {
    if (!transition) return
    const u = Math.min(1, (nowMs - transition.startMs) / SCALE_TRANSITION_MS)
    const eased = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2
    const next = THREE.MathUtils.lerp(transition.from, transition.to, eased)

    const { from, to } = cameraAnchors(t, next, medianOf(neoDistancesKm()))
    cameraOffset.subVectors(camera.position, controls.target)
    cameraOffset.setLength(remapCameraDistance(cameraOffset.length(), from, to))
    camera.position.copy(controls.target).add(cameraOffset)

    t = next
    if (u === 1) transition = null
  }

  /** Zoom range follows how far the scene extends at the current scale. */
  function updateLimits() {
    const curve = frame.focus.curve
    let farthest = extentUnits()
    for (const km of extentKm(t)) farthest = Math.max(farthest, sceneDistance(km, t, curve))
    // The pivot is the anchor: never let the camera dive inside it (the Sun at
    // true scale is 218 units across, where the Earth is 2).
    controls.minDistance = frame.radius(t) * lerpLog(1.75, 1.3, t)
    controls.maxDistance = Math.max(20, farthest * 2.5)
    // OrbitControls' dolly is multiplicative (×0.95 per wheel notch at speed 1):
    // spanning 2.6 → ~60 000 would take ~190 notches without this.
    controls.zoomSpeed = Math.max(1, Math.log(controls.maxDistance / controls.minDistance) / 3)

    // The far plane has to follow the scene, and it is measured *from the camera*,
    // not from the pivot. The fixed 1e6 it was built with is smaller than the
    // scene itself at 100 % réel: Neptune sits 1,41 million units out, so it was
    // clipped away outright — and pulled back far enough to frame it, every outer
    // planet went with it. That is precisely the view that now has to show them.
    // Widening it is free because of `logarithmicDepthBuffer`; `near` is what sets
    // the precision, and it is untouched. Re-derived with a factor-4 hysteresis so
    // an orbiting camera isn't rebuilding the projection matrix every frame.
    const neededFar = Math.max(1e4, (camera.position.length() + farthest) * 2)
    if (neededFar > camera.far || neededFar < camera.far / 4) {
      camera.far = neededFar
      camera.updateProjectionMatrix()
    }
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

  const focusOffset = new THREE.Vector3()

  return {
    /** The slider's step, 0..SCALE_STEPS — what the panels describe, not where a transition is. */
    get step() {
      return step
    },
    /** The current, animated scale — what every placement uses this frame. */
    get t() {
      return t
    },

    setStep(next) {
      next = THREE.MathUtils.clamp(Math.round(next), 0, SCALE_STEPS)
      if (next === step && !transition) return
      step = next
      transition = { from: t, to: stepToT(next), startMs: performance.now() }
      on.stepChanged()
    },

    recenter() {
      if (controls.target.lengthSq() > 1e-12) recenterTween = { from: controls.target.clone(), startMs: performance.now() }
    },

    /** One frame of camera work, in the order the render loop always ran it. */
    update(nowMs) {
      stepTransition(nowMs)
      stepRecenter(nowMs)
      updateLimits()
      controls.update()
    },

    /** Scene radius needed for `px` pixels at a world position, given the current camera. */
    minRadiusAt(worldPos, px) {
      const distance = camera.position.distanceTo(worldPos)
      return px * worldPerPixel(distance, camera.fov, canvas.clientHeight)
    },

    /**
     * Switching pivot re-places the whole scene at once — interpolating between two
     * different compressions would mean nothing visually — but the camera keeps its
     * direction and the same *physical* framing: its distance is read back as a real
     * distance through the old curve, then re-compressed with the new one.
     *
     * @param {() => void} apply  moves the pivot (`frame.set`) and whatever follows
     *   it; called between the read through the old curve and the new framing
     */
    switchFocus(apply) {
      focusOffset.subVectors(camera.position, controls.target)
      const framedKm = sceneDistanceToKm(focusOffset.length(), t, frame.focus.curve)

      apply()
      recenterTween = null

      controls.target.set(0, 0, 0)
      updateLimits()
      // Same physical distance — but bounded so the switch always lands on
      // something worth looking at: hugging the Earth at 130 000 km is *inside*
      // the Sun (radius 696 000 km), and framing the NEO cloud from the Earth is
      // a pinhole around the Sun.
      const reference = references()[0]
      const framed = sceneDistance(framedKm, t, frame.focus.curve)
      const closest = Math.max(controls.minDistance, frame.radius(t) * 3)
      const furthest = Math.min(controls.maxDistance, sceneDistance(reference.km, t, frame.focus.curve) * 1.8)
      camera.position.copy(focusOffset.setLength(THREE.MathUtils.clamp(framed, closest, Math.max(closest, furthest))))
    },

    /** Backs the camera off to frame the pivot's first yardstick (start-up). */
    frameFirstReference() {
      camera.position.setLength(Math.min(controls.maxDistance, sceneDistance(references()[0].km, t, frame.focus.curve) * 1.8))
    },
  }
}
