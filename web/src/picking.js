/**
 * What the cursor is on: NEOs by raycast, stars by screen-space distance. Owns
 * the canvas' pointer events and turns them into two kinds of outcome — the
 * hover feedback it applies itself (cursor shape, tooltips, star highlight,
 * constellation figure) and the two clicks it reports back through `on`.
 *
 * It knows nothing of the scale or the point of view: the scene hands it the
 * occluding spheres as they stand, and it asks the starfield and the overlay
 * for the rest.
 */

import * as THREE from 'three'
import { raySphereDistance } from './scene/geo.js'
import { neoTooltipSuffix } from './neoInfo.js'

// Star picking is done by hand in screen space rather than via
// Raycaster.intersectObject(the star points): that built-in path tests a fixed
// world-space distance from the ray to each point, which doesn't track the
// point's actual on-screen size (driven by the starfield's per-vertex shader) —
// on a shell as large as the sky's, that mismatch reads as picking the "wrong"
// star next to the one under the cursor. Projecting every star to screen space
// and comparing pixel distance instead makes the hit target match what's
// actually visible.
const STAR_PICK_RADIUS_PX = 12

// A click that moved this far is the end of an orbit drag, not a click.
const DRAG_TOLERANCE_PX = 5

/**
 * @param {object}            options
 * @param {HTMLCanvasElement} options.canvas
 * @param {THREE.Camera}      options.camera
 * @param {THREE.Group}       options.neoGroup   the NEO meshes to raycast
 * @param {object}            options.starfield  scene/starfield.js
 * @param {object}            options.panels     ui/panels.js, for the tooltips
 * @param {() => {center: THREE.Vector3, radius: number}[]} options.occluders
 *        bodies that currently hide stars, read fresh at each pick
 * @param {{neoClicked: (neo: object) => void, emptyClicked: () => void}} options.on
 */
export function createPicking({ canvas, camera, neoGroup, starfield, panels, occluders, on }) {
  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()

  function pickNeoAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect()
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1
    raycaster.setFromCamera(pointer, camera)
    // Raycaster ignores `visible`, so NEOs without any position yet are filtered out by hand.
    const hit = raycaster.intersectObjects(neoGroup.children, true).find((i) => i.object.parent.visible)
    return hit ? hit.object.userData.neo : null
  }

  const starPickWorldPos = new THREE.Vector3()
  const starPickScreenPos = new THREE.Vector3()
  const starPickRayDir = new THREE.Vector3()

  /** Index of the star nearest the cursor on screen (named or not), or null. */
  function pickStarIndexAt(clientX, clientY) {
    const positionAttr = starfield.positionAttribute
    if (!positionAttr) return null
    const rect = canvas.getBoundingClientRect()
    // Read once per pick, not once per star: nothing moves mid-pick.
    const blockers = occluders()

    let bestIndex = null
    let bestDistSq = STAR_PICK_RADIUS_PX * STAR_PICK_RADIUS_PX

    for (let i = 0; i < positionAttr.count; i++) {
      starPickWorldPos.fromBufferAttribute(positionAttr, i)
      if (isOccluded(starPickWorldPos, blockers)) continue

      // Sky group sits on the camera: world position = local + camera position.
      starPickScreenPos.copy(starPickWorldPos).add(camera.position).project(camera)
      if (starPickScreenPos.z > 1) continue // behind the camera

      const sx = (starPickScreenPos.x * 0.5 + 0.5) * rect.width + rect.left
      const sy = (starPickScreenPos.y * -0.5 + 0.5) * rect.height + rect.top
      const dx = sx - clientX
      const dy = sy - clientY
      const distSq = dx * dx + dy * dy
      if (distSq < bestDistSq) {
        bestDistSq = distSq
        bestIndex = i
      }
    }

    return bestIndex
  }

  /**
   * True if one of the bodies hides this star. Stars are at infinity (skybox),
   * so only the direction matters: `localPos` is the star's position in the sky
   * group, i.e. relative to the camera.
   */
  function isOccluded(localPos, blockers) {
    starPickRayDir.copy(localPos).normalize()
    for (const { center, radius } of blockers) {
      if (raySphereDistance(camera.position, starPickRayDir, center, radius) < Infinity) return true
    }
    return false
  }

  /**
   * Shows one constellation's figure and its name tooltip, hiding whichever was
   * shown before. `code` may be '' or null (no figure at this cursor position) —
   * clears both cleanly either way.
   */
  function showConstellation(code, clientX, clientY) {
    const name = starfield.showConstellation(code)
    if (name) panels.showConstellationTooltip(name, clientX, clientY)
    else panels.hideConstellationTooltip()
  }

  // Clicking a NEO opens its modal and selects it (its trajectory stays drawn
  // after the modal closes); clicking empty space deselects — but only on a real
  // click, not at the end of an orbit drag.
  let pointerDownAt = null

  canvas.addEventListener('pointerdown', (event) => {
    pointerDownAt = { x: event.clientX, y: event.clientY }
  })

  canvas.addEventListener('click', (event) => {
    const dragged =
      pointerDownAt && Math.hypot(event.clientX - pointerDownAt.x, event.clientY - pointerDownAt.y) > DRAG_TOLERANCE_PX
    pointerDownAt = null
    if (dragged) return

    const neo = pickNeoAt(event.clientX, event.clientY)
    if (neo) on.neoClicked(neo)
    else on.emptyClicked()
  })

  canvas.addEventListener('pointermove', (event) => {
    const neo = pickNeoAt(event.clientX, event.clientY)
    if (neo) {
      canvas.style.cursor = 'pointer'
      // Named on hover: at true scale every NEO is an anonymous dot otherwise.
      panels.showStarTooltip(neo.name + neoTooltipSuffix(neo), event.clientX, event.clientY)
      starfield.highlight(null)
      showConstellation(null)
      return
    }

    const starIndex = pickStarIndexAt(event.clientX, event.clientY)
    if (starIndex !== null) {
      canvas.style.cursor = 'pointer'
      starfield.highlight(starIndex)
      showConstellation(starfield.constellationOf(starIndex), event.clientX, event.clientY)
      const name = starfield.nameOf(starIndex)
      if (name) panels.showStarTooltip(name, event.clientX, event.clientY)
      else panels.hideStarTooltip()
    } else {
      canvas.style.cursor = 'default'
      panels.hideStarTooltip()
      starfield.highlight(null)
      showConstellation(null)
    }
  })

  canvas.addEventListener('pointerleave', () => {
    starfield.highlight(null)
    showConstellation(null)
    panels.hideStarTooltip()
  })
}
