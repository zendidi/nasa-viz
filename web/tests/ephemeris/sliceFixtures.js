// Fixtures des tests des tranches annuelles (lot 3, 2026-11-05) : une table
// continue « telle qu'Horizons l'aurait servie d'un seul tenant », dont on découpe
// les tranches comme le fait le backend (2 lignes de recouvrement de chaque côté).
// Les valeurs sont une fonction lisse du temps, pas de l'indice : une ligne
// décalée ou dupliquée change la valeur, et l'interpolation reste testable.

import { OVERLAP_ROWS, yearStartSeconds } from '../../src/ephemeris/slices.js'

const OMEGA = (2 * Math.PI) / (365.25 * 86_400) // un tour par an
const RADIUS_KM = 1.5e8

/** Position (ICRF km) à l'instant `t` (secondes) : une orbite circulaire, ~30 km/s. */
export const positionAtSeconds = (t) => [RADIUS_KM * Math.cos(OMEGA * t), RADIUS_KM * Math.sin(OMEGA * t), 2e6 * Math.sin(2 * OMEGA * t)]

/** Vitesse de cette orbite en km/s. */
export const SPEED_KM_S = RADIUS_KM * OMEGA

/** La table continue des années [first, last] : de first − 2 pas à last + 1 janvier + 2 pas. */
export function continuousTable(first, last, step) {
  const start = yearStartSeconds(first) - OVERLAP_ROWS * step
  const end = yearStartSeconds(last + 1) + OVERLAP_ROWS * step
  const positions = []
  for (let t = start; t <= end; t += step) positions.push(positionAtSeconds(t))
  return { timeScale: 'UTC', start, stepSeconds: step, positions }
}

/** L'enregistrement qu'une réponse `?year=` donne, tel que `positionsSliceFromResponse` le range. */
export function sliceRecord(year, step, overrides = {}) {
  const sliceStart = yearStartSeconds(year)
  const sliceEnd = yearStartSeconds(year + 1)
  const start = sliceStart - OVERLAP_ROWS * step
  const positions = []
  for (let t = start; t <= sliceEnd + OVERLAP_ROWS * step; t += step) positions.push(positionAtSeconds(t))
  return {
    frame: 'ICRF geocentric',
    timeScale: 'UTC',
    year,
    sliceStart,
    sliceEnd,
    start,
    stepSeconds: step,
    radiusKm: 6371,
    equatorialKm: 6378,
    polarKm: 6357,
    positions,
    ...overrides,
  }
}

/** La réponse JSON du backend pour cette tranche (noms de champs du contrat). */
export function servedResponse(year, step, id = 'mars') {
  const r = sliceRecord(year, step)
  return {
    frame: r.frame,
    time_scale: r.timeScale,
    units: 'km',
    year,
    slice_start: r.sliceStart,
    slice_end: r.sliceEnd,
    start: r.start,
    step_seconds: step,
    bodies: [{ id, name: id, radius_km: 6371, equatorial_radius_km: 6378, polar_radius_km: 6357, positions: r.positions }],
  }
}

/** Une table de slices (Map) pour les années demandées. */
export const slicesMap = (years, step) => new Map(years.map((year) => [year, sliceRecord(year, step)]))
