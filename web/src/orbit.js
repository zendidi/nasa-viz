/**
 * Heliocentric orbits from classical elements (two-body Kepler motion) and a
 * top-down SVG schematic of a NEO's orbit against the Earth's, for the NEO
 * modal. Elements come from /api/neo/details (JPL SBDB, ecliptic J2000).
 * Two-body propagation ignores planetary perturbations: fine to show the shape
 * and where both bodies roughly are, not for precise positions — the 3D
 * trajectory in the scene uses JPL Horizons for that. Pure, no Three.js.
 */

const RAD = Math.PI / 180
const GAUSS_K = 0.01720209895 // rad/day, Sun's gravitational constant for orbits in au

/** Earth–Moon barycentre, J2000 mean elements (Standish, JPL). */
export const EARTH_ORBIT = {
  epoch_jd: 2451545.0,
  a_au: 1.00000261,
  e: 0.01671123,
  i_deg: -0.00001531,
  node_deg: 0,
  // Longitude of perihelion 102.93768°, mean longitude 100.46457°.
  peri_deg: 102.93768193,
  mean_anomaly_deg: 100.46457166 - 102.93768193,
  period_days: 365.256,
}

export function julianDate(date) {
  return date.getTime() / 86_400_000 + 2440587.5
}

function solveKepler(meanAnomaly, e) {
  let E = e < 0.8 ? meanAnomaly : Math.PI
  for (let i = 0; i < 30; i++) {
    const delta = (E - e * Math.sin(E) - meanAnomaly) / (1 - e * Math.cos(E))
    E -= delta
    if (Math.abs(delta) < 1e-12) break
  }
  return E
}

/** Position (au, heliocentric ecliptic) at eccentric anomaly E. */
function positionAtEccentricAnomaly(orbit, E) {
  const { a_au: a, e } = orbit
  const xv = a * (Math.cos(E) - e)
  const yv = a * Math.sqrt(1 - e * e) * Math.sin(E)
  const node = orbit.node_deg * RAD
  const peri = orbit.peri_deg * RAD
  const inc = orbit.i_deg * RAD
  const cosO = Math.cos(node)
  const sinO = Math.sin(node)
  const cosW = Math.cos(peri)
  const sinW = Math.sin(peri)
  const cosI = Math.cos(inc)
  const sinI = Math.sin(inc)
  return {
    x: xv * (cosO * cosW - sinO * sinW * cosI) - yv * (cosO * sinW + sinO * cosW * cosI),
    y: xv * (sinO * cosW + cosO * sinW * cosI) - yv * (sinO * sinW - cosO * cosW * cosI),
    z: xv * sinW * sinI + yv * cosW * sinI,
  }
}

/** Heliocentric ecliptic position (au) at Julian date `jd`. Elliptic orbits only (e < 1). */
export function orbitPosition(orbit, jd) {
  const meanMotion = orbit.period_days ? (2 * Math.PI) / orbit.period_days : GAUSS_K / Math.pow(orbit.a_au, 1.5)
  const M = orbit.mean_anomaly_deg * RAD + meanMotion * (jd - orbit.epoch_jd)
  const wrapped = ((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  return positionAtEccentricAnomaly(orbit, solveKepler(wrapped, orbit.e))
}

function sampleOrbit(orbit, count = 180) {
  return Array.from({ length: count + 1 }, (_, i) => positionAtEccentricAnomaly(orbit, (i / count) * 2 * Math.PI))
}

const fmt = (value, digits) => value.toLocaleString('fr-FR', { maximumFractionDigits: digits })

/**
 * Top-down (ecliptic north up) schematic: Sun, Earth orbit, NEO orbit — solid
 * where it runs above the ecliptic, dashed below — and both bodies now plus
 * the NEO at its close approach. Returns '' for orbits it can't draw.
 *
 * @param {{a_au:number, e:number, i_deg:number, node_deg:number, peri_deg:number, mean_anomaly_deg:number, epoch_jd:number, period_days:?number}} orbit
 * @param {{now: Date, approachAt: ?Date, hazardous: boolean}} options
 */
export function orbitSchematicSvg(orbit, { now, approachAt, hazardous }) {
  if (!orbit || !(orbit.e >= 0 && orbit.e < 1) || !(orbit.a_au > 0)) return ''

  const neoPoints = sampleOrbit(orbit)
  const extent = Math.max(1.1, ...neoPoints.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y)))) * 1.12
  const size = 260
  const scale = size / 2 / extent
  const sx = (p) => (size / 2 + p.x * scale).toFixed(1)
  const sy = (p) => (size / 2 - p.y * scale).toFixed(1)

  // Split the NEO orbit where it crosses the ecliptic; each new piece starts
  // from the previous sample so the two dash styles join without a gap.
  const paths = { above: '', below: '' }
  let previousSide = null
  neoPoints.forEach((p, i) => {
    const side = p.z >= 0 ? 'above' : 'below'
    const point = `${sx(p)},${sy(p)}`
    if (side === previousSide) {
      paths[side] += `L${point} `
    } else {
      const prev = neoPoints[i - 1]
      paths[side] += prev ? `M${sx(prev)},${sy(prev)} L${point} ` : `M${point} `
    }
    previousSide = side
  })
  const { above, below } = paths
  const earthPath = sampleOrbit(EARTH_ORBIT, 120)
    .map((p, i) => `${i ? 'L' : 'M'}${sx(p)},${sy(p)}`)
    .join(' ')

  const jdNow = julianDate(now)
  const earthNow = orbitPosition(EARTH_ORBIT, jdNow)
  const neoNow = orbitPosition(orbit, jdNow)
  const neoColor = hazardous ? '#ff4d4d' : '#7fe0ff'
  const approach = approachAt ? orbitPosition(orbit, julianDate(approachAt)) : null

  const dot = (p, r, fill, extra = '') =>
    `<circle cx="${sx(p)}" cy="${sy(p)}" r="${r}" fill="${fill}" ${extra}/>`
  const label = (p, text, fill, dx = 6, dy = -6) =>
    `<text x="${(Number(sx(p)) + dx).toFixed(1)}" y="${(Number(sy(p)) + dy).toFixed(1)}" fill="${fill}">${text}</text>`

  const period = orbit.period_days
    ? orbit.period_days > 730
      ? `${fmt(orbit.period_days / 365.25, 1)} ans`
      : `${fmt(orbit.period_days, 0)} j`
    : null

  return `
    <figure class="orbit-schematic">
      <svg viewBox="0 0 ${size} ${size}" role="img" aria-label="Orbite vue de dessus">
        <path d="${earthPath}" fill="none" stroke="#4fa8ff" stroke-opacity="0.55" stroke-width="1"/>
        <path d="${above}" fill="none" stroke="${neoColor}" stroke-width="1.4"/>
        <path d="${below}" fill="none" stroke="${neoColor}" stroke-width="1.4" stroke-dasharray="3 3" stroke-opacity="0.8"/>
        ${dot({ x: 0, y: 0 }, 5, '#ffcc33')}
        ${label({ x: 0, y: 0 }, 'Soleil', '#ffcc33', 7, 4)}
        ${approach ? dot(approach, 5, 'none', `stroke="${neoColor}" stroke-width="1.2"`) : ''}
        ${dot(earthNow, 3.5, '#4fa8ff')}
        ${label(earthNow, 'Terre', '#9fd2ff')}
        ${dot(neoNow, 3, neoColor)}
      </svg>
      <figcaption>
        Vue de dessus du plan de l'écliptique · trait plein au-dessus, pointillé en dessous ·
        point = aujourd'hui${approach ? ', cercle = approche' : ''}<br>
        a ${fmt(orbit.a_au, 3)} ua · e ${fmt(orbit.e, 3)} · i ${fmt(orbit.i_deg, 1)}°${period ? ` · période ${period}` : ''}
        <span class="muted">(képlérien, sans perturbations)</span>
      </figcaption>
    </figure>
  `
}
