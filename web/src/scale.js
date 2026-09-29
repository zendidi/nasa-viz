/**
 * "Réalisme" model for the scale slider (see docs/echelle-reelle.md). The
 * scene has one knob, t ∈ [0, 1]: t = 0 is the readable layout (distances
 * compressed, small bodies inflated), t = 1 is true proportions. Every
 * distance and size is interpolated in log space between its readable and
 * real value — a linear blend would jump almost entirely in the last few
 * percent, since real values are orders of magnitude apart.
 *
 * Distances are measured from whichever body the scene is centred on (the
 * "pivot", see web/src/focus.js and docs/points-de-vue.md), so the readable
 * curve is a parameter: what reads well around the Earth (the Moon at 12
 * units) is useless around the Sun, where everything interesting sits between
 * 0,3 and 5 au. The pivot is the anchor: it keeps radius EARTH_RADIUS at t = 0
 * whichever body it is. Pure math, no Three.js.
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
export const SUN_READABLE_RADIUS = 0.6

/**
 * Readable radius of the pivot: it is the visual anchor, so it keeps the
 * Earth's old size whichever body it is. Every other body keeps its real
 * proportion to it — hence the Earth (and with it the Moon and the ISS)
 * shrinking to EARTH_MARKER_RADIUS when the Sun is the pivot.
 */
export const FOCUS_READABLE_RADIUS = EARTH_RADIUS
export const EARTH_MARKER_RADIUS = 0.35

/** Log-space blend: a at t = 0, b at t = 1. Both must be > 0. */
export function lerpLog(a, b, t) {
  return Math.pow(a, 1 - t) * Math.pow(b, t)
}

/**
 * Readable-distance curve for anything beyond low orbit (Moon, NEOs, planets):
 * `a + b·log10(d_km)`, pinned at two (km, units) anchors and floored at
 * `minUnits`. Monotone in the real distance, so ordering between bodies holds
 * at every t — unlike the old fixed NEO shell, which put a NEO closer than the
 * Moon further out than it.
 */
function makeCurve(kmNear, unitsNear, kmFar, unitsFar, minUnits) {
  const b = (unitsFar - unitsNear) / (Math.log10(kmFar) - Math.log10(kmNear))
  return { a: unitsNear - b * Math.log10(kmNear), b, minUnits }
}

/** Earth-centred: the Moon stays where it always was (12), a NEO at 0,5 au lands at 20. */
export const EARTH_CURVE = makeCurve(LUNAR_DISTANCE_KM, 12, 0.5 * AU_KM, 20, EARTH_RADIUS * 1.5)

/**
 * Readable curve for a pivot that orbits the Sun — the Sun's own view included,
 * where the yardstick is the Earth's orbit. `yardstickKm` is the distance that
 * defines the view's scale: 0,3x it lands at 6 units, 5x it at 26.
 *
 * Because those two anchors are fixed *multiples*, the slope is the same for
 * every pivot (`b = 20 / log10(5/0,3) = 16,37`) and the yardstick itself always
 * lands at **14,56 units**. That invariant is the reason to write it this way:
 * whether the scene is centred on the Sun, on Mercury or on Neptune, the body
 * that defines the view sits at the same place on screen, and the picture stays
 * comparable when you switch pivot. Pivot on Neptune and the Sun, Mercury and
 * the Earth all collapse to ~14,6 — which is true: from 30 au they really are
 * all in the same direction at nearly the same distance.
 */
export function orbitingCurve(yardstickKm) {
  return makeCurve(0.3 * yardstickKm, 6, 5 * yardstickKm, 26, FOCUS_READABLE_RADIUS * 1.6)
}

/**
 * Sun-centred: 1 au lands at 14,5 and a typical NEO orbit (0,9–2,5 au) spans
 * 13,8 → 20, so the ellipse still reads as an ellipse at the readable end.
 */
export const SUN_CURVE = orbitingCurve(AU_KM)

export function readableDistance(distanceKm, curve = EARTH_CURVE) {
  return Math.max(curve.minUnits, curve.a + curve.b * Math.log10(distanceKm))
}

/** Scene distance from the pivot, in units, for a body at distanceKm from it. */
export function sceneDistance(distanceKm, t, curve = EARTH_CURVE) {
  return lerpLog(readableDistance(distanceKm, curve), distanceKm * KM_TO_UNITS, t)
}

/**
 * Inverse of sceneDistance: which real distance a scene distance stands for.
 * No closed form (the readable end is linear in log10(d), but the log blend
 * takes the log *of* that sum), so it's a bisection on log10(d) — sceneDistance
 * is monotone, and this runs on a pivot change, not per frame. Saturates at the
 * bracket's ends, where the curve's minUnits floor makes the mapping flat.
 */
export function sceneDistanceToKm(units, t, curve = EARTH_CURVE) {
  let lo = 0 // 1 km
  let hi = 12 // 10^12 km ≈ 6700 au
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (sceneDistance(Math.pow(10, mid), t, curve) < units) lo = mid
    else hi = mid
  }
  return Math.pow(10, (lo + hi) / 2)
}

export function issOrbitRadius(altitudeKm, t) {
  return EARTH_RADIUS + altitudeKm * KM_TO_UNITS * Math.pow(ISS_ALTITUDE_EXAGGERATION, 1 - t)
}

export function issRadius(t) {
  return lerpLog(ISS_READABLE_RADIUS, ISS_RADIUS_KM * KM_TO_UNITS, t)
}

/**
 * How much the whole Earth system (globe, Moon, ISS) shrinks so the pivot keeps
 * the anchor size: 1 when the Earth is the pivot, otherwise a EARTH_MARKER_RADIUS
 * dot at the readable end and back to real proportions at t = 1.
 */
export function earthSystemScale(t, isFocus) {
  return isFocus ? 1 : lerpLog(EARTH_MARKER_RADIUS / EARTH_RADIUS, 1, t)
}

/** Same readable sizing the NEO points always had, as the t = 0 end. */
export function neoReadableRadius(diameterKm) {
  return Math.min(Math.max(diameterKm * 0.15, 0.03), 0.2)
}

export function neoRadius(diameterKm, t) {
  return lerpLog(neoReadableRadius(diameterKm), (diameterKm / 2) * KM_TO_UNITS, t)
}

/** A marker seen from the Earth; the scene's anchor when the Sun is the pivot. */
export function sunRadius(t, isFocus = false) {
  return lerpLog(isFocus ? FOCUS_READABLE_RADIUS : SUN_READABLE_RADIUS, SUN_RADIUS_KM * KM_TO_UNITS, t)
}

/**
 * The pivot's own drawn radius, whichever body it is: the anchor size at the
 * readable end, its real radius at t = 1. One formula for all three kinds of
 * pivot — `pivotRadius(EARTH_RADIUS_KM, t)` is a constant EARTH_RADIUS (the
 * Earth *is* the anchor), and `pivotRadius(SUN_RADIUS_KM, t)` is exactly
 * `sunRadius(t, true)`. Which is the point: a planet needs no third case.
 */
export function pivotRadius(radiusKm, t) {
  return lerpLog(FOCUS_READABLE_RADIUS, radiusKm * KM_TO_UNITS, t)
}

/**
 * Readable radius of a planet. Real proportions can't be kept at the readable
 * end: with the Earth at EARTH_RADIUS, Jupiter's true radius is 21,95 units —
 * wider than the Sun–Mars distance the heliocentric view draws it at (17,5).
 * The Sun already has this answer as a flat SUN_READABLE_RADIUS; a planet
 * needs a curve instead, because seven of them have to stay distinguishable.
 *
 * So: the Earth's own marker radius, times the ratio of the radii compressed
 * by a power. The exponent is the whole choice — 1 would be true proportions,
 * 0 would make every planet the same ball. At 0,35 the set spreads 0,25
 * (Mercury) → 0,80 (Jupiter): ordering by size is still readable at a glance,
 * and the largest stays a third of the pivot's 2 units. Tuned by eye; it is a
 * legibility knob, not a measurement.
 */
export const PLANET_READABLE_EXPONENT = 0.35

export function planetReadableRadius(radiusKm) {
  return EARTH_MARKER_RADIUS * Math.pow(radiusKm / EARTH_RADIUS_KM, PLANET_READABLE_EXPONENT)
}

export function planetRadius(radiusKm, t) {
  return lerpLog(planetReadableRadius(radiusKm), radiusKm * KM_TO_UNITS, t)
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
 * `references` are the pivot's yardsticks ({ label, km } — the Moon when the
 * scene is centred on the Earth, the Earth when it is centred on the Sun);
 * `neoDistancesKm` / `neoDiametersKm` come from the loaded feed (median used).
 */
export function describeScale(t, { curve, references, neoDistancesKm, neoDiametersKm }) {
  const parts = []

  for (const reference of references) {
    const factor = (reference.km * KM_TO_UNITS) / sceneDistance(reference.km, t, curve)
    parts.push(factor < 1.05 ? `${reference.label} 1:1` : `${reference.label} ÷${formatFactor(factor)}`)
  }

  const neoMedianKm = median(neoDistancesKm)
  if (neoMedianKm !== null) {
    const f = (neoMedianKm * KM_TO_UNITS) / sceneDistance(neoMedianKm, t, curve)
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
