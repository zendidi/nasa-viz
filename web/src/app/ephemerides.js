/**
 * The background load of the solar-system tables (lot 3, 2026-11-05): the order in
 * which the yearly slices of the Sun, the Moon and the planets are asked for.
 * The order itself is `loadPlan` (ephemeris/slices.js, tested); this walks it,
 * one request at a time, and hands over to the planets' orbits at the end.
 *
 * Slices already read from localStorage answer at once, so on a warm start the
 * whole plan is over before the first frame is drawn.
 */

import { loadPlan, runJobs, yearOfMs } from '../ephemeris/slices.js'

/**
 * @param {object} options
 * @param {{loadYear: (year: number) => Promise<boolean>}} options.sunTable
 * @param {{loadYear: (year: number) => Promise<boolean>}} options.moonTable
 * @param {{bodies: {id: string}[], loadYear: (id: string, year: number) => Promise<boolean>,
 *   setPlanRunning: (running: boolean) => void, loadOrbits: () => Promise<void>}} options.planets
 * @param {number} [options.wallMs]
 */
export async function loadEphemerides({ sunTable, moonTable, planets, wallMs = Date.now() }) {
  const jobs = loadPlan(yearOfMs(wallMs), ['moon', ...planets.bodies.map((body) => body.id)])
  const run = ({ body, year }) => {
    if (body === 'sun') return sunTable.loadYear(year)
    if (body === 'moon') return moonTable.loadYear(year)
    return planets.loadYear(body, year)
  }
  planets.setPlanRunning(true)
  try {
    await runJobs(jobs, run)
  } finally {
    planets.setPlanRunning(false)
  }
  await planets.loadOrbits()
}
