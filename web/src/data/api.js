const BASE = '/api'

/**
 * The clock every Horizons table is on, in the backend's own words
 * (`time_scale` on each response). A table stored without it, or with another
 * value, dates from before 2026-10-21, when the backend still served TDB that
 * every client read as UTC — 69 s late, ~2 000 km on every planet. Rejecting it
 * costs one refetch and self-heals, like the orbit route's `frame` guard.
 */
export const TIME_SCALE = 'UTC'

/**
 * What a panel shows when a route fails. The backend names the provider that
 * failed (`source`, on its 502s), so the viewer reads who is down — "JPL
 * Horizons est en panne" — instead of a generic failure.
 */
export function upstreamErrorMessage(body, status) {
  if (body && typeof body.source === 'string' && body.source !== '') {
    return `${body.source} est en panne : impossible d'obtenir les données pour l'instant.`
  }
  return (body && body.error) || `request failed: ${status}`
}

/**
 * How long a request may take before the viewer gives up (2026-11-05): the PHP
 * wall is 30 s per request, and `php -S` on Windows serves one request at a
 * time, so a request can also wait behind the one in front of it. Without a
 * limit an object whose answer never came stayed "loading" forever and held the
 * tracking queue with it.
 */
export const REQUEST_TIMEOUT_MS = 45_000

/**
 * What the panels say when a request failed on the client side. A timeout (the
 * signal's `TimeoutError`) gets a sentence of its own; anything else keeps the
 * message it carries.
 */
export function requestErrorMessage(err) {
  if (err && err.name === 'TimeoutError') return `Le serveur n'a pas répondu en ${REQUEST_TIMEOUT_MS / 1000} s.`
  return err && err.message ? err.message : String(err)
}

async function getJson(path) {
  try {
    const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(upstreamErrorMessage(body, res.status))
    }
    return await res.json()
  } catch (err) {
    throw new Error(requestErrorMessage(err))
  }
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
 * Since 2026-11-05 (lot 3) the table is **one civil year** of one body, immutable:
 * `year` ∈ [Y−1, Y+4] (HTTP 400 otherwise), with two rows of overlap on each side
 * (`slice_start` / `slice_end` say where the year proper begins and ends; `start`
 * is the first row). `ephemeris/slices.js` assembles them.
 *
 * @param {string} id sun · moon · mercury · venus · mars · jupiter · saturn · uranus · neptune · pluto
 * @param {number} year
 * @returns {Promise<{frame:string, time_scale:string, year:number, slice_start:number, slice_end:number,
 *   start:number, step_seconds:number, bodies:{id:string, name:string, radius_km:number, positions:number[][]|null}[]}>}
 */
export function fetchSolarSystemBody(id, year) {
  return getJson(`/solar-system/positions?${new URLSearchParams({ body: id, year: String(year) })}`)
}

/**
 * One planet's whole orbit as a polyline: 181 samples over one sidereal
 * period, **geocentric** like the positions above. The caller turns them
 * heliocentric by subtracting the same Sun it places the planet with — see
 * backend/API.md, and `scene/planets.js` for why it matters.
 *
 * Since 2026-11-05 (lot 3) the period starts at 1 January 00:00 UTC of `year`.
 *
 * @param {string} id
 * @param {number} year
 * @returns {Promise<{frame:string, time_scale:string, year:number, start:number, stop:number, body:{id:string, period_days:number}, positions:number[][]|null}>}
 */
export function fetchSolarSystemOrbit(id, year) {
  return getJson(`/solar-system/orbit?${new URLSearchParams({ body: id, year: String(year) })}`)
}

/**
 * How one planet is turned in space: `pole` and `prime_meridian` as ICRF unit
 * vectors at `epoch` (since 2026-11-05: 1 January 00:00 UTC of `year`; it was
 * the first of the current UTC month), plus the **signed** sidereal rotation
 * rate in degrees per day.
 *
 * Vectors rather than the angles Horizons publishes, so that the sign of the
 * longitude and the light-time correction — 29,8° on Jupiter — are settled once
 * server-side instead of in every client (backend/API.md).
 *
 * @param {string} id one of the seven planets (Earth excluded), `pluto` or `moon`; not `sun`, which has no rigid surface
 * @param {number} year
 * @returns {Promise<{frame:string, year:number, epoch:number, bodies:{id:string, name:string,
 *   radius_km:number, pole:?number[], prime_meridian:?number[],
 *   rotation_deg_per_day:?number}[]}>}
 */
export function fetchSolarSystemOrientation(id, year) {
  return getJson(`/solar-system/orientation?${new URLSearchParams({ body: id, year: String(year) })}`)
}

/**
 * Every moon of one planet in a single call, positions **relative to that
 * planet** (not geocentric like the routes above), so the scene places them with
 * `placeRelativeKm` while the planet is the pivot.
 *
 * `missing` is the contract: non-zero means the server has not got every table
 * yet and the caller should come back. The route fetches at most one absent moon
 * per call, so a cold cache converges in as many calls as there are moons, and a
 * warm one answers everything at once (backend/API.md).
 *
 * @param {string} planetId
 */
export function fetchMoons(planetId) {
  return getJson(`/solar-system/moons?${new URLSearchParams({ planet: planetId })}`)
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

/**
 * Resolves a name, number, provisional designation or SPK-ID to one asteroid
 * (JPL SBDB, keyless — nothing here touches the NASA quota). Three shapes, all
 * HTTP 200: `{match}`, `{match: null, candidates, count}` and `{match: null}`,
 * the last possibly with `rejected: {reason: 'comet'}` (backend/API.md).
 *
 * @param {string} q
 */
export function searchSmallBody(q) {
  return getJson(`/small-body/search?${new URLSearchParams({ q })}`)
}

/** A response on any clock but UTC is refused, like the other tables: it would place the object 69 s off (~2 000 km on a NEO's table). */
function assertUtc(res) {
  if (res.time_scale !== TIME_SCALE) {
    throw new Error(`échelle de temps inattendue (${res.time_scale ?? 'absente'}, ${TIME_SCALE} attendu)`)
  }
  return res
}

/**
 * The daily geocentric table of **one** tracked asteroid over the fixed range
 * (1 Jan of last year to 1 Jan five years on), with its close approaches when it
 * is a NEO (backend/API.md, `/api/small-body/trajectory`; 2026-11-05, replacing
 * `/positions`). `objects[spkid]` is null when SBDB or Horizons don't know that
 * SPK-ID any more. One id per call on purpose.
 *
 * @param {string} spkid
 */
export async function fetchTrajectory(spkid) {
  return assertUtc(await getJson(`/small-body/trajectory?${new URLSearchParams({ spkid })}`))
}

/**
 * The hourly table (and the 5-minute segments around close flybys) of one
 * tracked **NEO** for one civil year — the placement precision the daily table
 * cannot give near the Earth. The table overlaps its neighbours by two rows on
 * each side (`positions` from 1 Jan − 2 h to 1 Jan next year + 2 h).
 *
 * @param {string} spkid
 * @param {number} year
 */
export async function fetchPrecision(spkid, year) {
  return assertUtc(await getJson(`/small-body/precision?${new URLSearchParams({ spkid, year: String(year) })}`))
}

/**
 * The Sun's daily geocentric table over the same range, shared by every tracked
 * object (heliocentric = geocentric object − Sun, row by row).
 *
 * Replaced on 2026-11-05 (lot 3): the viewer no longer calls it, the tracking tool
 * reads the scene's own assembled Sun table. The route is kept (backend/API.md).
 */
export async function fetchTrajectorySun() {
  return assertUtc(await getJson('/small-body/trajectory/sun'))
}

/** @returns {Promise<{title:string, date:string, explanation:string, media_type:string, url:string, hd_url:?string}>} */
export function fetchApod() {
  return getJson('/apod')
}

/** @returns {Promise<{date:string, nasa_api_calls_today:number}>} */
export function fetchUsage() {
  return getJson('/usage')
}
