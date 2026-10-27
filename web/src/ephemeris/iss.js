/**
 * Where the ISS is at a given instant, from the ten-minute track
 * `/api/iss/position` serves (`track`: [unix s, latitude °, east longitude °,
 * altitude km], a sample a minute). Pure, no Three.js.
 *
 * Until 2026-10-21 the marker sat on the single reading of the last poll, its
 * timestamp unread: up to a minute — ~460 km — behind, and a cached reading of
 * any age was drawn as live on the next page load. Interpolating the track puts
 * it at the real "now"; and outside the track this answers null, which is the
 * honest thing to draw: nothing.
 *
 * Linear in latitude, longitude and altitude between two samples a minute
 * apart. The orbit's one-minute chord is ~4 km from the arc, and the ground
 * track's curvature in (lat, lon) over a minute is of the same order — far
 * below the ISS's own pixel floor at every scale.
 *
 * @param {number[][] | null | undefined} track
 * @param {number} nowSeconds
 * @returns {{latitude: number, longitude: number, altitude_km: number} | null}
 */
export function issAt(track, nowSeconds) {
  if (!track?.length) return null
  const first = track[0][0]
  const last = track[track.length - 1][0]
  if (!(nowSeconds >= first && nowSeconds <= last)) return null

  let i = 0
  while (i < track.length - 2 && track[i + 1][0] <= nowSeconds) i++
  const [t0, lat0, lon0, alt0] = track[i]
  const [t1, lat1, lon1, alt1] = track[Math.min(i + 1, track.length - 1)]
  const u = t1 > t0 ? (nowSeconds - t0) / (t1 - t0) : 0

  // The short way round across the antimeridian: 179° → −179° is 2°, not 358°.
  let dLon = lon1 - lon0
  if (dLon > 180) dLon -= 360
  else if (dLon < -180) dLon += 360
  let longitude = lon0 + u * dLon
  if (longitude > 180) longitude -= 360
  else if (longitude <= -180) longitude += 360

  return { latitude: lat0 + u * (lat1 - lat0), longitude, altitude_km: alt0 + u * (alt1 - alt0) }
}
