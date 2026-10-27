/**
 * The Sun as drawn: its marker (sphere + legibility halo), the directional
 * light it casts, and its name once it shrinks to a dot. Where it is comes from
 * main.js's astronomy (`sunPositionKm`, by reference); this module only places,
 * sizes and lights from it.
 */

import * as THREE from 'three'
import { makeSunMarker } from './bodies.js'
import { LABEL_WHEN_SMALLER_THAN_PX } from '../labels.js'
import { SUN_READABLE_RADIUS, isRealScale, sunRadius } from '../scale.js'

// Distances and sizes of everything but the Earth depend on the "réalisme"
// scale (scaleT, see scale.js and docs/echelle-reelle.md): readable at 0,
// true proportions at 1. The light only needs a direction.
const SUN_LIGHT_DISTANCE = 30

// The Sun's sits above `PLANET_MIN_RADIUS_PX` (3,5, scene/planets.js) on
// purpose: past the point where every body is on its floor, these numbers are
// the only thing the scene still says about size, and the Sun must not end up
// smaller than Jupiter when it is really ten times its radius.
// (The other floors: scene/earthSystem.js, MIN_RADIUS_PX.)
const SUN_MIN_RADIUS_PX = 4.5

/**
 * @param {object} options
 * @param {THREE.Scene} options.scene
 * @param {import('./frame.js').ViewFrame} options.frame
 * @param {object} options.labels  labels.js
 * @param {(worldPos: THREE.Vector3, px: number) => number} options.minRadiusAt
 * @param {THREE.Vector3} options.sunPositionKm  live geocentric Sun, mutated in place by main.js
 */
export function createSun({ scene, frame, labels, minRadiusAt, sunPositionKm }) {
  const marker = makeSunMarker()
  scene.add(marker)

  const light = new THREE.DirectionalLight(0xffffff, 1.2)
  scene.add(light)

  const labelEl = labels.create('Soleil')

  return {
    marker,

    /** Points the light along the real Sun direction (unit vector, world space). */
    setDirection(dirWorld) {
      light.position.copy(dirWorld).multiplyScalar(SUN_LIGHT_DISTANCE)
    },

    /** The photosphere map, fetched only once the Sun is centred on (bodies.js). */
    loadTexture() {
      marker.userData.loadTexture()
    },

    update(t) {
      frame.placeKm(marker.position, sunPositionKm, t)
      // The halo is legibility, not photosphere: gone at true scale, where it made
      // the Sun 1,67 times too wide.
      marker.userData.glow.material.opacity = 0.25 * (1 - t)
      marker.userData.glow.visible = !isRealScale(t)
      marker.scale.setScalar(
        Math.max(sunRadius(t, frame.id === 'sun'), minRadiusAt(marker.position, SUN_MIN_RADIUS_PX)) / SUN_READABLE_RADIUS,
      )
    },

    /** Named once too small to read as itself — except when the scene is centred on it. */
    labelEntry() {
      return {
        el: labelEl,
        worldPos: marker.position,
        occludable: true,
        show:
          frame.id !== 'sun' &&
          labels.projectedRadiusPx(marker.position, SUN_READABLE_RADIUS * marker.scale.x) < LABEL_WHEN_SMALLER_THAN_PX,
      }
    },
  }
}
