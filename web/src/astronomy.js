/**
 * Low-precision solar/lunar position formulas (NOAA-style approximations —
 * no equation of time, no nutation, no orbital eccentricity). Accurate to a
 * few degrees, which is what a decorative day/night terminator + moon orbit
 * needs; not for navigation. Pure math, no Three.js dependency — main.js
 * turns the results into world-space vectors via latLngToVector3(dec, ra/lng, radius),
 * the same helper already used for star placement (RA/dec).
 */

const J2000 = Date.UTC(2000, 0, 1, 12, 0, 0) // 2000-01-01T12:00:00Z
const DAY_MS = 86400000
const DEG = 180 / Math.PI
const RAD = Math.PI / 180

function daysSinceJ2000(date) {
  return (date.getTime() - J2000) / DAY_MS
}

function normalizeDeg(deg) {
  return ((deg % 360) + 360) % 360
}

/** @returns {{ra: number, dec: number}} in degrees */
export function getSunEquatorial(date = new Date()) {
  const n = daysSinceJ2000(date)

  const meanLongitude = normalizeDeg(280.46 + 0.9856474 * n)
  const meanAnomaly = normalizeDeg(357.528 + 0.9856003 * n) * RAD
  const eclipticLongitude =
    (meanLongitude + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) * RAD
  const obliquity = (23.439 - 0.0000004 * n) * RAD

  const dec = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude)) * DEG
  const ra =
    Math.atan2(Math.cos(obliquity) * Math.sin(eclipticLongitude), Math.cos(eclipticLongitude)) * DEG

  return { ra: normalizeDeg(ra), dec }
}

/** Mean lunar ecliptic longitude in degrees (ecliptic latitude ignored, ~0-5.1° in reality). */
export function getMoonEclipticLongitude(date = new Date()) {
  const n = daysSinceJ2000(date)
  return normalizeDeg(218.316 + 13.176396 * n)
}

/**
 * Greenwich Mean Sidereal Time, in degrees [0, 360) — Earth's rotation angle
 * relative to the fixed-stars (RA/dec) frame used everywhere else in this
 * file. Low-precision (drops the T² and T³ terms of the full IAU formula,
 * worth a fraction of a second even decades from J2000 — irrelevant next to
 * the few-degrees accuracy of the Sun/Moon formulas above). main.js sets the
 * globe's rotation.y directly to this (in radians): rotating the geographic
 * (lat/lng) frame by this angle around Y lines it up with the RA/dec frame,
 * which is exactly what GMST measures by definition (the RA currently over
 * Greenwich).
 */
export function getGreenwichSiderealTime(date = new Date()) {
  const n = daysSinceJ2000(date)
  return normalizeDeg(280.46061837 + 360.98564736629 * n)
}
