/**
 * Geometry shared by everything the scene places: the celestial-sphere mapping,
 * the ICRF → scene axis swap, and a ray/sphere test. Pure functions — no state,
 * no scene, no DOM.
 */

import * as THREE from 'three'
import { AU_KM } from '../scale.js'

/**
 * Where a surface point sits in a body's **own** axes — and, with it, the
 * convention every equirectangular map in this scene is read in.
 *
 * Two halves, both checked rather than assumed:
 *
 * - **The mesh.** `SphereGeometry` puts the texel of coordinate `u` at the
 *   equator in the direction `(−cos 2πu, 0, sin 2πu)` — read off the buffer of
 *   three.js 0.166, not remembered.
 * - **The maps.** Their left column is **180°**, their centre is longitude 0,
 *   east grows to the right and north is up. That is a measurement:
 *   `tools/calibration/texture-longitude.py` correlates each map against data
 *   whose convention is published — the Natural Earth coastlines, the lunar
 *   maria and the classical Martian albedo features of the IAU/USGS gazetteer —
 *   over all 2048 shifts and both mirror parities, and this alignment wins on
 *   the Earth (98,89 % against 72,90 % for the best mirror), the Moon and Mars.
 *
 * Put together: the point at **east longitude λ is at `(cos λ, 0, −sin λ)`** in
 * the body's frame, so the prime meridian is its local +X and the pole its
 * local +Y. That is the frame `setBodyOrientation` builds, and it is what this
 * function has returned since lot 1 — the ISS is placed with it, and the
 * globe's `rotation.y = GMST` says the same thing a third time, since the
 * result is RA = GMST + east longitude.
 */
export function latLngToVector3(lat, lng, radius) {
  const phi = (90 - lat) * (Math.PI / 180)
  const theta = (lng + 180) * (Math.PI / 180)
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  )
}

/** Longitude of the left edge of the Solar System Scope maps — the convention the mesh above is read in. */
export const SSS_MAP_LEFT_EDGE_LON = 180

/**
 * How far to slide a map's `u` so that it reads in the convention above, in
 * turns (0..1), for a map whose **left edge is at `leftEdgeLonDeg` east**.
 *
 * The USGS/New Horizons maps of Pluto and Charon run 0→360° E with the left
 * edge at **0°**, where the SSS maps start at 180°. Wear one unshifted and
 * Sputnik Planitia (≈175° E) lands at the sub-Charon end of Pluto instead of the
 * far side — still a perfectly good sphere, which is the whole danger.
 *
 * The mesh puts east longitude λ at `u = (λ + 180) / 360`; a map whose left edge
 * is L has longitude L + 360 u' at column u'. The column to read is therefore
 * `u' = u − (180 + L) / 360`, i.e. `shift = −(180 + L) / 360 mod 1`: 0 for L = 180,
 * 0.5 for L = 0. Added to `vUv.x` in the lit-body shader (a ShaderMaterial gets
 * no `texture.offset` for free) and relies on `RepeatWrapping` for the wrap.
 */
export function mapUShift(leftEdgeLonDeg) {
  const shift = -(180 + leftEdgeLonDeg) / 360
  return shift - Math.floor(shift)
}

const bodyNorth = new THREE.Vector3()
const bodyMeridian = new THREE.Vector3()
const bodyThird = new THREE.Vector3()
const bodyBasis = new THREE.Matrix4()

/**
 * Turns a body so its north pole points along `pole` and its prime meridian
 * along `primeMeridian` — both in scene axes, which is what
 * `/api/solar-system/orientation` serves once run through `icrfToScene`.
 *
 * The third axis has to be `X × Y` and not `Y × X`: east — the direction
 * longitude grows in — then comes out as `pole × primeMeridian`, which is the
 * standard "north × radial" and the direction the map's right-hand side is.
 * Taking the other one mirrors every map east/west while leaving the axis
 * perfectly tilted, so it would survive every check but a named feature.
 *
 * Writes into `quaternion` and returns it; allocates nothing.
 */
export function setBodyOrientation(quaternion, pole, primeMeridian) {
  bodyNorth.copy(pole).normalize()
  // Gram-Schmidt rather than trust: the route states the two vectors are
  // perpendicular to 1e-16, but `makeBasis` does not orthogonalise, and a basis
  // that is even slightly skewed shears the map instead of turning it.
  bodyMeridian.copy(primeMeridian).addScaledVector(bodyNorth, -bodyNorth.dot(primeMeridian)).normalize()
  bodyThird.crossVectors(bodyMeridian, bodyNorth)
  return quaternion.setFromRotationMatrix(bodyBasis.makeBasis(bodyMeridian, bodyNorth, bodyThird))
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
