/**
 * "Réalisme" model for the scale slider (see docs/echelle-reelle.md). The
 * scene has one knob, t ∈ [0, 1]: t = 0 is the readable layout (distances
 * compressed, small bodies inflated), t = 1 is true proportions. Every
 * distance and size is interpolated in log space between its readable and
 * real value — a linear blend would jump almost entirely in the last few
 * percent, since real values are orders of magnitude apart.
 *
 * Earth is the anchor: radius EARTH_RADIUS at every t. Pure math, no Three.js.
 */

export const EARTH_RADIUS = 2
export const EARTH_RADIUS_KM = 6371
export const KM_TO_UNITS = EARTH_RADIUS / EARTH_RADIUS_KM
export const AU_KM = 149_597_870.7
export const LUNAR_DISTANCE_KM = 384_400

export const SCALE_STEPS = 8 // slider positions 0..8 → t = k / 8
export const SCALE_PRESETS = [
  { label: 'Lisible', step: 0 },
  { label: 'Intermédiaire', step: 4 },
  { label: '100 % réel', step: 8 },
]

export const MOON_RADIUS_KM = 1737.4
export const SUN_RADIUS_KM = 696_340
export const ISS_RADIUS_KM = 0.0545 // ~109 m truss span

const ISS_ALTITUDE_EXAGGERATION = 8
export const ISS_READABLE_RADIUS = 0.06
export const SUN_READABLE_DISTANCE = 30
export const SUN_READABLE_RADIUS = 0.6

/** Log-space blend: a at t = 0, b at t = 1. Both must be > 0. */
export function lerpLog(a, b, t) {
  return Math.pow(a, 1 - t) * Math.pow(b, t)
}

// Readable distance for anything beyond low orbit (Moon, NEOs): a log curve
// pinned so the Moon stays where it always was (12 units) and an object at
// 0.5 au lands at 20. Monotone in the real distance, so ordering between
// bodies holds at every t — unlike the old fixed NEO shell, which put a NEO
// closer than the Moon further out than it.
const READABLE_B = 8 / (Math.log10(0.5 * AU_KM) - Math.log10(LUNAR_DISTANCE_KM))
const READABLE_A = 12 - READABLE_B * Math.log10(LUNAR_DISTANCE_KM)
const READABLE_MIN = EARTH_RADIUS * 1.5

export function readableDistance(distanceKm) {
  return Math.max(READABLE_MIN, READABLE_A + READABLE_B * Math.log10(distanceKm))
}

/** Scene distance from Earth's centre, in units, for a body at distanceKm. */
export function sceneDistance(distanceKm, t) {
  return lerpLog(readableDistance(distanceKm), distanceKm * KM_TO_UNITS, t)
}

export function issOrbitRadius(altitudeKm, t) {
  return EARTH_RADIUS + altitudeKm * KM_TO_UNITS * Math.pow(ISS_ALTITUDE_EXAGGERATION, 1 - t)
}

export function issRadius(t) {
  return lerpLog(ISS_READABLE_RADIUS, ISS_RADIUS_KM * KM_TO_UNITS, t)
}

/** Same readable sizing the NEO points always had, as the t = 0 end. */
export function neoReadableRadius(diameterKm) {
  return Math.min(Math.max(diameterKm * 0.15, 0.03), 0.2)
}

export function neoRadius(diameterKm, t) {
  return lerpLog(neoReadableRadius(diameterKm), (diameterKm / 2) * KM_TO_UNITS, t)
}

export function sunDistance(t) {
  return lerpLog(SUN_READABLE_DISTANCE, AU_KM * KM_TO_UNITS, t)
}

export function sunRadius(t) {
  return lerpLog(SUN_READABLE_RADIUS, SUN_RADIUS_KM * KM_TO_UNITS, t)
}

/** World units covered by one screen pixel at `distance` from a perspective camera. */
export function worldPerPixel(distance, fovDeg, viewportHeightPx) {
  return (2 * distance * Math.tan((fovDeg * Math.PI) / 360)) / viewportHeightPx
}

function median(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function formatFactor(x) {
  if (x < 1.05) return '1:1'
  const digits = x < 10 ? 1 : 0
  return x.toLocaleString('fr-FR', { maximumFractionDigits: digits })
}

/**
 * Human label for the current t: how far each thing is from real proportions.
 * `neoDistancesKm` / `neoDiametersKm` come from the loaded feed (median used).
 */
export function describeScale(t, moonDistanceKm, neoDistancesKm, neoDiametersKm) {
  const parts = []

  const moonReal = moonDistanceKm * KM_TO_UNITS
  const moonFactor = moonReal / sceneDistance(moonDistanceKm, t)
  parts.push(moonFactor < 1.05 ? 'Lune 1:1' : `Lune ÷${formatFactor(moonFactor)}`)

  const neoMedianKm = median(neoDistancesKm)
  if (neoMedianKm !== null) {
    const f = (neoMedianKm * KM_TO_UNITS) / sceneDistance(neoMedianKm, t)
    parts.push(f < 1.05 ? 'NEO 1:1' : `NEO ÷${formatFactor(f)}`)
  }

  const diameterKm = median(neoDiametersKm)
  const sizeFactor =
    diameterKm !== null
      ? neoRadius(diameterKm, t) / ((diameterKm / 2) * KM_TO_UNITS)
      : issRadius(t) / (ISS_RADIUS_KM * KM_TO_UNITS)
  parts.push(sizeFactor < 1.05 ? 'tailles 1:1' : `tailles ×${formatFactor(sizeFactor)}`)

  return parts.join(' · ')
}

/**
 * Remaps a camera distance from one t to another so the view keeps framing
 * "the same thing": piecewise log-linear between anchors that exist at both
 * t values (near-surface distance fixed, Moon distance, median NEO distance),
 * constant ratio past the last anchor. A camera hugging the Earth to look at
 * the ISS stays close; one framing the NEO cloud follows it outward.
 *
 * @param {number} distance
 * @param {number[]} fromAnchors increasing, same length as toAnchors
 * @param {number[]} toAnchors increasing
 */
export function remapCameraDistance(distance, fromAnchors, toAnchors) {
  const n = fromAnchors.length
  if (distance <= fromAnchors[0]) return distance * (toAnchors[0] / fromAnchors[0])
  for (let i = 1; i < n; i++) {
    if (distance <= fromAnchors[i]) {
      const u = Math.log(distance / fromAnchors[i - 1]) / Math.log(fromAnchors[i] / fromAnchors[i - 1])
      return lerpLog(toAnchors[i - 1], toAnchors[i], u)
    }
  }
  return distance * (toAnchors[n - 1] / fromAnchors[n - 1])
}
