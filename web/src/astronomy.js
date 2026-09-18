/**
 * Low-precision solar/lunar position formulas (NOAA-style approximations —
 * no equation of time, no nutation, no orbital eccentricity). Accurate to a
 * few degrees, which is what a decorative day/night terminator + moon orbit
 * needs; not for navigation. Pure math, no Three.js dependency — main.js
 * turns the results into world-space vectors via latLngToVector3(dec, ra/lng, radius),
 * the same helper already used for star placement (RA/dec).
 */

import { AU_KM } from './scale.js'

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

/**
 * Geocentric Sun. The distance (Astronomical Almanac's low-precision series,
 * ~0.0001 au) matters as soon as the scene can be centred on the Sun: the whole
 * heliocentric layout is built from `NEO_geocentric − Sun_geocentric`.
 *
 * @returns {{ra: number, dec: number, distanceKm: number}} angles in degrees
 */
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
  const distanceAu = 1.00014 - 0.01671 * Math.cos(meanAnomaly) - 0.00014 * Math.cos(2 * meanAnomaly)

  return { ra: normalizeDeg(ra), dec, distanceKm: distanceAu * AU_KM }
}

/**
 * Geocentric Moon position: the Astronomical Almanac's low-precision series
 * (main periodic terms in ecliptic longitude, latitude and horizontal
 * parallax — ~0.3° in position, ~0.1% in distance), then ecliptic → equatorial
 * with the mean obliquity. Ecliptic of date rather than J2000 (precession
 * since 2000 is ~0.4°, below this series' own accuracy). Checked against JPL
 * Horizons for 2026-09-16 12:00 UT: see docs/agent/gotchas.md.
 *
 * @returns {{ra: number, dec: number, distanceKm: number}} ra in [0, 360), degrees
 */
export function getMoonEquatorial(date = new Date()) {
  const n = daysSinceJ2000(date)
  const T = n / 36525
  const sinD = (deg) => Math.sin(deg * RAD)
  const cosD = (deg) => Math.cos(deg * RAD)

  const lambda =
    218.32 +
    481267.881 * T +
    6.29 * sinD(135.0 + 477198.87 * T) -
    1.27 * sinD(259.3 - 413335.36 * T) +
    0.66 * sinD(235.7 + 890534.22 * T) +
    0.21 * sinD(269.9 + 954397.74 * T) -
    0.19 * sinD(357.5 + 35999.05 * T) -
    0.11 * sinD(186.5 + 966404.03 * T)
  const beta =
    5.13 * sinD(93.3 + 483202.02 * T) +
    0.28 * sinD(228.2 + 960400.89 * T) -
    0.28 * sinD(318.3 + 6003.15 * T) -
    0.17 * sinD(217.6 - 407332.21 * T)
  const parallax =
    0.9508 +
    0.0518 * cosD(135.0 + 477198.87 * T) +
    0.0095 * cosD(259.3 - 413335.36 * T) +
    0.0078 * cosD(235.7 + 890534.22 * T) +
    0.0028 * cosD(269.9 + 954397.74 * T)

  const obliquity = (23.439 - 0.0000004 * n) * RAD
  const l = lambda * RAD
  const b = beta * RAD
  const x = Math.cos(b) * Math.cos(l)
  const y = Math.cos(obliquity) * Math.cos(b) * Math.sin(l) - Math.sin(obliquity) * Math.sin(b)
  const z = Math.sin(obliquity) * Math.cos(b) * Math.sin(l) + Math.cos(obliquity) * Math.sin(b)

  return {
    ra: normalizeDeg(Math.atan2(y, x) * DEG),
    dec: Math.asin(z) * DEG,
    distanceKm: 6378.14 / Math.sin(parallax * RAD),
  }
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
