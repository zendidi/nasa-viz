/**
 * The names floating over the scene: bodies once they've shrunk to dots, the
 * reference circles, the lunar orbit, the apsides and nodes of a drawn orbit.
 *
 * The module answers "where does this label go, and is it worth drawing" —
 * projection, occlusion behind the pivot body, and the rule that two labels
 * must not land on top of each other. It never decides *what* deserves a name:
 * the scene hands it a list each frame, in the order that settles ties.
 */

import * as THREE from 'three'
import { raySphereDistance } from './scene/geo.js'
import { worldPerPixel } from './scale.js'

/** A body wider than this reads as itself; below it, it's a dot that needs naming. */
export const LABEL_WHEN_SMALLER_THAN_PX = 6

/** A circle narrower than this on screen has no room for its name. */
export const LABEL_RING_MIN_RADIUS_PX = 40

/** Two labels closer than this overlap; the first one placed wins. */
const LABEL_MIN_SEPARATION_PX = 18

/**
 * @param {object}            options
 * @param {HTMLElement}       options.layer    the overlay div labels are added to
 * @param {THREE.Camera}      options.camera
 * @param {HTMLCanvasElement} options.canvas
 * @param {() => {center: THREE.Vector3, radius: number}} options.occluder
 *        the body a label can hide behind, as it currently stands
 */
export function createSceneLabels({ layer, camera, canvas, occluder }) {
  const screenPos = new THREE.Vector3()
  const rayDir = new THREE.Vector3()

  /** A new hidden label in the layer. `className` 'ring' for the dimmer style. */
  function create(text, className = '') {
    const el = document.createElement('span')
    el.className = `scene-label ${className}`.trim()
    el.textContent = text
    el.hidden = true
    layer.appendChild(el)
    return el
  }

  /** On-screen radius, in pixels, of something `radius` wide at `worldPos`. */
  function projectedRadiusPx(worldPos, radius) {
    return radius / worldPerPixel(camera.position.distanceTo(worldPos), camera.fov, canvas.clientHeight)
  }

  /** Screen position of a world point, or null if behind the camera or hidden behind the body. */
  function screenPositionOf(worldPos, checkOcclusion) {
    screenPos.copy(worldPos).project(camera)
    if (screenPos.z > 1) return null
    if (checkOcclusion) {
      rayDir.subVectors(worldPos, camera.position)
      const distance = rayDir.length()
      rayDir.normalize()
      const { center, radius } = occluder()
      if (raySphereDistance(camera.position, rayDir, center, radius) < distance - 1e-6) return null
    }
    const rect = canvas.getBoundingClientRect()
    return {
      x: (screenPos.x * 0.5 + 0.5) * rect.width,
      y: (-screenPos.y * 0.5 + 0.5) * rect.height,
    }
  }

  function place(el, pos) {
    if (!pos) {
      el.hidden = true
      return
    }
    el.hidden = false
    el.style.transform = `translate(${pos.x + 8}px, ${pos.y}px) translateY(-50%)`
  }

  /**
   * One placement pass. Each entry is `{ el, worldPos, show, occludable,
   * spaced }`: `show` false (or a null `worldPos`) hides it outright, and
   * `spaced` false opts out of the anti-overlap rule — the ring names do, since
   * they sit on wide circles and shouldn't push a body's name off the screen.
   *
   * Order is the tie-break: whatever comes first keeps its spot.
   *
   * @param {{el: HTMLElement, worldPos: ?THREE.Vector3, show?: boolean,
   *          occludable?: boolean, spaced?: boolean}[]} entries
   */
  function update(entries) {
    const placed = []
    for (const { el, worldPos, show = true, occludable = false, spaced = true } of entries) {
      const pos = show && worldPos ? screenPositionOf(worldPos, occludable) : null
      if (!pos) {
        place(el, null)
        continue
      }
      if (spaced) {
        if (!placed.every((p) => Math.hypot(p.x - pos.x, p.y - pos.y) > LABEL_MIN_SEPARATION_PX)) {
          place(el, null)
          continue
        }
        placed.push(pos)
      }
      place(el, pos)
    }
  }

  return { create, projectedRadiusPx, update }
}
