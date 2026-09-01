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

/** @returns {Promise<{title:string, date:string, explanation:string, media_type:string, url:string, hd_url:?string}>} */
export function fetchApod() {
  return getJson('/apod')
}

/** @returns {Promise<{date:string, nasa_api_calls_today:number}>} */
export function fetchUsage() {
  return getJson('/usage')
}
