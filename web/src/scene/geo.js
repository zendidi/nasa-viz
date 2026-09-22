/**
 * Geometry shared by everything the scene places: the celestial-sphere mapping,
 * the ICRF → scene axis swap, and a ray/sphere test. Pure functions — no state,
 * no scene, no DOM.
 */

import * as THREE from 'three'
import { AU_KM } from '../scale.js'

export function latLngToVector3(lat, lng, radius) {
  const phi = (90 - lat) * (Math.PI / 180)
  const theta = (lng + 180) * (Math.PI / 180)
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  )
}

/** Deterministic pseudo-random unit vector, stable per NEO id across refreshes. */
export function hashToDirection(id) {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (Math.imul(31, h) + id.charCodeAt(i)) | 0
  const rand = (seed) => {
    const x = Math.sin(seed) * 43758.5453
    return x - Math.floor(x)
  }
  const theta = rand(h) * Math.PI * 2
  const phi = Math.acos(rand(h + 1) * 2 - 1)
  return new THREE.Vector3(Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta))
}

/**
 * ICRF (x toward RA 0, z toward the celestial north pole) → scene axes, which
 * put the pole on +Y — the same mapping latLngToVector3(dec, ra, r) applies.
 */
export function icrfToScene(x, y, z, out) {
  return out.set(x, z, -y)
}

/** Distance along a ray (unit dir) to a sphere's near surface, or Infinity if it misses. */
export function raySphereDistance(origin, dir, center, radius) {
  const ocX = origin.x - center.x
  const ocY = origin.y - center.y
  const ocZ = origin.z - center.z
  const b = ocX * dir.x + ocY * dir.y + ocZ * dir.z
  const c = ocX * ocX + ocY * ocY + ocZ * ocZ - radius * radius
  const discriminant = b * b - c
  if (discriminant < 0) return Infinity
  const t = -b - Math.sqrt(discriminant)
  return t > 0 ? t : Infinity
}

/** Obliquity of the ecliptic — the tilt between the equatorial scene axes and the ecliptic plane. */
export const OBLIQUITY_RAD = (23.439 * Math.PI) / 180

/**
 * Heliocentric ecliptic au → km in scene axes: rotate about X by the obliquity
 * (ecliptic → equatorial), then the usual ICRF → scene mapping.
 */
export function eclipticAuToSceneKm(p, out) {
  const yEq = p.y * Math.cos(OBLIQUITY_RAD) - p.z * Math.sin(OBLIQUITY_RAD)
  const zEq = p.y * Math.sin(OBLIQUITY_RAD) + p.z * Math.cos(OBLIQUITY_RAD)
  return icrfToScene(p.x * AU_KM, yEq * AU_KM, zEq * AU_KM, out)
}
