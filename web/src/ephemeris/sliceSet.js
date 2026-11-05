/**
 * The loaded yearly slices of one body's positions (lot 3, 2026-11-05): read back
 * from localStorage at creation, fetched one year at a time, validated, stored
 * under one key per body × year, and assembled on demand into the continuous
 * table `positionTable.js` reads. The rules themselves are in `slices.js` (pure,
 * tested); this is the part that touches the network and the storage.
 *
 * Nothing here is on the NASA quota: Horizons is keyless, and a slice is immutable
 * — once stored there is nothing to refresh until its year leaves the range.
 */

import { fetchSolarSystemBody } from '../data/api.js'
import { cachedKeys, loadCached, removeCached, saveCached } from '../data/cache.js'
import {
  assembleSlices,
  positionsKey,
  positionsSliceFromResponse,
  staleKeys,
  validPositionsSlice,
  yearOfMs,
  yearRange,
} from './slices.js'

/**
 * Start-up housekeeping (once, before anything reads the cache): forgets the
 * slices whose year left the range, and the single-record keys of before the
 * slices. localStorage has ~5 MB and a Moon year at 6 h is ~80 kB of JSON.
 */
export function purgeStaleCache(wallMs = Date.now()) {
  for (const key of staleKeys(cachedKeys(), wallMs)) removeCached(key)
}

/**
 * @param {string} id  sun · moon · a planet
 */
export function createSliceSet(id) {
  /** @type {Map<number, object>} valid slice records by year */
  const slices = new Map()
  /** @type {Map<number, Promise<boolean>>} */
  const inflight = new Map()
  /** Moves when a slice is added (the table must be re-assembled); `revision` moves on anything a panel shows. */
  let sliceCount = 0
  let revision = 0
  let lastError = null
  let memo = null

  const range = yearRange(Date.now())
  for (let year = range.minYear; year <= range.maxYear; year++) {
    const stored = loadCached(positionsKey(id, year))?.data
    if (validPositionsSlice(stored, year, range)) {
      slices.set(year, stored)
      sliceCount++
    }
  }

  /**
   * One year's slice: resolves true when it is held (already, or just fetched),
   * false when the request failed or the answer was refused — the reason is in
   * `error`. Concurrent calls for the same year share one request.
   */
  function load(year) {
    if (slices.has(year)) return Promise.resolve(true)
    const pending = inflight.get(year)
    if (pending) return pending
    const promise = (async () => {
      try {
        const res = await fetchSolarSystemBody(id, year)
        const record = positionsSliceFromResponse(res, id)
        // Held to the same test as a slice read back from localStorage.
        if (!validPositionsSlice(record, year, yearRange(Date.now()))) {
          throw new Error(record.positions.length === 0 ? `pas de table pour ${id} en ${year}` : `tranche ${id} ${year} refusée`)
        }
        slices.set(year, record)
        saveCached(positionsKey(id, year), record)
        sliceCount++
        lastError = null
        return true
      } catch (err) {
        lastError = err.message
        return false
      } finally {
        inflight.delete(year)
        revision++
      }
    })()
    inflight.set(year, promise)
    revision++
    return promise
  }

  return {
    load,
    has: (year) => slices.has(year),
    /** The years of the current range this body does not hold yet. */
    missingYears() {
      const { minYear, maxYear } = yearRange(Date.now())
      const missing = []
      for (let year = minYear; year <= maxYear; year++) if (!slices.has(year)) missing.push(year)
      return missing
    },
    /**
     * The continuous table around the wall-clock year (null without that year's
     * slice). Memoised: rebuilt only when a slice arrives or the wall year turns,
     * and the same object comes back otherwise, so callers can compare identity.
     */
    table() {
      const year = yearOfMs(Date.now())
      if (!memo || memo.sliceCount !== sliceCount || memo.year !== year) memo = { sliceCount, year, table: assembleSlices(slices, year) }
      return memo.table
    },
    /** Mean / equatorial / polar radius the backend stated, from any slice held; null before the first. */
    shape() {
      for (const record of slices.values()) {
        if (record.radiusKm) return { radiusKm: record.radiusKm, equatorialKm: record.equatorialKm, polarKm: record.polarKm }
      }
      return null
    },
    /** Changes whenever something the callers show changed: a request started, ended, a slice landed. */
    get revision() {
      return revision
    },
    get loading() {
      return inflight.size > 0
    },
    /** Why the last request failed, in the backend's words; null after a success. */
    get error() {
      return lastError
    },
  }
}
