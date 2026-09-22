const BASE = '/api'

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`)
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `request failed: ${res.status}`)
  }
  return res.json()
}

/** @returns {Promise<{latitude:number, longitude:number, altitude_km:number, velocity_kmh:number, timestamp:number}>} */
export function fetchIssPosition() {
  return getJson('/iss/position')
}

/** @returns {Promise<{start_date:string, end_date:string, count:number, objects:Array}>} */
export function fetchNeoFeed(startDate, endDate) {
  const params = new URLSearchParams()
  if (startDate) params.set('start_date', startDate)
  if (endDate) params.set('end_date', endDate)
  const qs = params.toString()
  return getJson(`/neo${qs ? `?${qs}` : ''}`)
}

/**
 * Real geocentric positions (JPL Horizons, ICRF, km) as hourly tables, keyed
 * by designation. The backend accepts at most 10 designations per call.
 *
 * @param {string} startDate YYYY-MM-DD
 * @param {string} endDate YYYY-MM-DD
 * @param {string[]} designations
 * @returns {Promise<{step_seconds:number, objects:Record<string, {start:number, positions:number[][]}|null>}>}
 */
export function fetchNeoPositions(startDate, endDate, designations) {
  const params = new URLSearchParams({
    start_date: startDate,
    end_date: endDate,
    designations: designations.join(','),
  })
  return getJson(`/neo/positions?${params}`)
}

/**
 * One planet's real geocentric positions (JPL Horizons, ICRF, km) as a daily
 * table covering a year. One body per call on purpose — a Horizons request
 * costs 5–16 s whatever its size, and asking for several at once overruns the
 * backend's execution limit (see backend/API.md).
 *
 * @param {string} id mercury · venus · mars · jupiter · saturn · uranus · neptune
 * @returns {Promise<{start:number, step_seconds:number, bodies:{id:string, name:string, radius_km:number, positions:number[][]|null}[]}>}
 */
export function fetchSolarSystemBody(id) {
  return getJson(`/solar-system/positions?${new URLSearchParams({ body: id })}`)
}

/**
 * One planet's whole orbit as a polyline: 181 samples over one sidereal
 * period, **geocentric** like the positions above. The caller turns them
 * heliocentric by subtracting the same Sun it places the planet with — see
 * backend/API.md, and `scene/planets.js` for why it matters.
 *
 * @param {string} id
 * @returns {Promise<{start:number, stop:number, body:{id:string, period_days:number}, positions:number[][]|null}>}
 */
export function fetchSolarSystemOrbit(id) {
  return getJson(`/solar-system/orbit?${new URLSearchParams({ body: id })}`)
}

/**
 * Per-object sheets (JPL SBDB + IMCCE ssoCard + JPL Sentry), keyed by
 * designation; null = unknown to both catalogues. At most 10 per call.
 *
 * @param {string[]} designations
 * @returns {Promise<{objects: Record<string, object|null>}>}
 */
export function fetchNeoDetails(designations) {
  return getJson(`/neo/details?${new URLSearchParams({ designations: designations.join(',') })}`)
}

/** @returns {Promise<{title:string, date:string, explanation:string, media_type:string, url:string, hd_url:?string}>} */
export function fetchApod() {
  return getJson('/apod')
}

/** @returns {Promise<{date:string, nasa_api_calls_today:number}>} */
export function fetchUsage() {
  return getJson('/usage')
}
