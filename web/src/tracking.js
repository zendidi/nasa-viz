/**
 * Tracking of up to five asteroids chosen by the user (docs/suivi-asteroides.md):
 * the stored list, what a search answer means, which table an instant is read
 * from, and when the next close approach is. Pure — no DOM, no Three.js — so
 * the rules that the eye cannot check on screen are testable in Node.
 *
 * A tracked object is **not necessarily a NEO** (`neo` comes from SBDB and is
 * kept on the record): everything NEO-only here — approaches, segments — is
 * simply absent for the others, never an error.
 *
 * Only the *list* is ever stored. A NEO's hourly table is ~360 kB of JSON; five
 * of them would blow the browser's localStorage quota, and the backend serves
 * each from its own cache in ~0,1 s.
 */

import { sampleCatmullRom } from './interpolate.js'

/** Hard ceiling on tracked objects (decided with the user, 2026-10-27). */
export const MAX_TRACKED = 5

/** localStorage key (through cache.js) of the list. */
export const TRACKED_CACHE_KEY = 'tracked'

/** What the backend accepts as an SPK-ID (`/api/small-body/positions`). */
export const SPKID_PATTERN = /^\d{7,8}$/

/**
 * One colour per slot, fixed. Chosen away from the NEO cyan (0x7fe0ff), the PHA
 * red (0xff4d4d), the spectral-complex colours and the planets', so that a
 * tracked object is never mistaken for one of those.
 */
export const TRACK_COLORS = Object.freeze([0xff5ce1, 0xb6ff3b, 0xffa31a, 0x00e5a8, 0xa98bff])

/**
 * The first palette colour no tracked object wears. Stable: removing the second
 * of three leaves the others' colours alone, and the next arrival takes the
 * freed one.
 *
 * @param {{color?: number}[]} list
 */
export function freeColor(list) {
  const used = new Set(list.map((rec) => rec.color))
  return TRACK_COLORS.find((color) => !used.has(color)) ?? TRACK_COLORS[0]
}

/**
 * @typedef {{spkid: string, des: string, fullname: string, neo: boolean, color: number}} TrackedRecord
 */

/** A record built from a `/api/small-body/search` match, or null if it lacks what tracking needs. */
export function recordFromMatch(match) {
  if (!match || typeof match.spkid !== 'string' || !SPKID_PATTERN.test(match.spkid)) return null
  if (typeof match.des !== 'string' || match.des === '') return null
  const fullname = typeof match.fullname === 'string' && match.fullname !== '' ? match.fullname : match.des
  return { spkid: match.spkid, des: match.des, fullname, neo: match.neo === true }
}

/**
 * Reads the stored list back, distrustfully: it comes out of localStorage, which
 * anything may have touched or an older build written. Invalid entries are
 * dropped, repeats of a SPK-ID too, the list is cut to the ceiling, and any
 * colour that is missing, foreign or shared is reassigned.
 *
 * @param {unknown} raw  the stored `data` (what `loadCached(...)?.data` gives)
 * @returns {TrackedRecord[]}
 */
export function readTrackedList(raw) {
  if (!Array.isArray(raw)) return []
  /** @type {TrackedRecord[]} */
  const list = []
  for (const item of raw) {
    if (list.length >= MAX_TRACKED) break
    if (item === null || typeof item !== 'object') continue
    const base = recordFromMatch(item)
    if (!base || list.some((rec) => rec.spkid === base.spkid)) continue
    const colorOk = TRACK_COLORS.includes(item.color) && !list.some((rec) => rec.color === item.color)
    list.push({ ...base, color: colorOk ? item.color : -1 })
  }
  // A second pass for the colours that were not usable, so the valid ones win.
  for (const rec of list) {
    if (rec.color === -1) rec.color = freeColor(list)
  }
  return list
}

/**
 * Adds a record without mutating the list. The refusal carries its reason so
 * the panel can say it: a duplicate is a no-op (not an error), a full list is
 * explicit.
 *
 * @param {TrackedRecord[]} list
 * @param {{spkid: string, des: string, fullname?: string, neo?: boolean}} record
 * @returns {{list: TrackedRecord[], added: boolean, reason: 'duplicate'|'full'|'invalid'|null}}
 */
export function addTracked(list, record) {
  const base = recordFromMatch(record)
  if (!base) return { list, added: false, reason: 'invalid' }
  if (list.some((rec) => rec.spkid === base.spkid)) return { list, added: false, reason: 'duplicate' }
  if (list.length >= MAX_TRACKED) return { list, added: false, reason: 'full' }
  return { list: [...list, { ...base, color: freeColor(list) }], added: true, reason: null }
}

/** The list without that SPK-ID (unchanged if absent). */
export function removeTracked(list, spkid) {
  return list.filter((rec) => rec.spkid !== spkid)
}

/** The list with one SPK-ID replaced by another — an object got numbered, its id changed. Colour kept. */
export function replaceSpkid(list, oldSpkid, newSpkid) {
  if (!SPKID_PATTERN.test(newSpkid)) return list
  return list.map((rec) => (rec.spkid === oldSpkid ? { ...rec, spkid: newSpkid } : rec))
}

/**
 * Whether a designation from the weekly NEO feed is already tracked. The feed
 * gives the provisional one ("2004 MN4"), the record `des` is SBDB's primary
 * (for a numbered object, "99942"), so the full name is searched too.
 */
export function isTrackedDesignation(list, designation) {
  const wanted = designation.trim().toLowerCase()
  return list.some(
    (rec) => rec.des.toLowerCase() === wanted || rec.fullname.toLowerCase().includes(`(${wanted})`),
  )
}

/**
 * What a `/api/small-body/search` answer means for the panel.
 *
 * @returns {{kind: 'match', record: object}
 *   | {kind: 'candidates', candidates: {pdes: string, name: string}[], count: number}
 *   | {kind: 'comet', fullname: string | null}
 *   | {kind: 'none'}}
 */
export function interpretSearch(res) {
  if (res && res.match) {
    const record = recordFromMatch(res.match)
    return record ? { kind: 'match', record } : { kind: 'none' }
  }
  if (res && res.rejected && res.rejected.reason === 'comet') {
    return { kind: 'comet', fullname: typeof res.rejected.fullname === 'string' ? res.rejected.fullname : null }
  }
  if (res && Array.isArray(res.candidates) && res.candidates.length > 0) {
    const candidates = res.candidates.filter((c) => c && typeof c.pdes === 'string' && c.pdes !== '')
    if (candidates.length > 0) {
      return { kind: 'candidates', candidates, count: Number.isFinite(res.count) ? res.count : candidates.length }
    }
  }
  return { kind: 'none' }
}

/**
 * The table an instant is read from, or null when no table covers it.
 *
 * A fine segment (5 min, NEO close approaches) wins over the base table where
 * both cover the instant — that is what segments are for — and both ends of a
 * table are inclusive: its last sample is a real position. Outside the **base
 * table** (the clock's whole window) there is nothing to say, segment or not.
 *
 * @param {{table?: {start:number, step_seconds:number, positions:number[][]},
 *          segments?: {start:number, step_seconds:number, positions:number[][]}[]}|null|undefined} object
 * @param {number} tSeconds Unix seconds, UTC
 * @returns {{start:number, stepSeconds:number, positions:number[][], fine:boolean}|null}
 */
export function tableAt(object, tSeconds) {
  const base = object?.table
  if (!base || !Array.isArray(base.positions) || base.positions.length === 0) return null
  const covers = (table) => tSeconds >= table.start && tSeconds <= table.start + (table.positions.length - 1) * table.step_seconds
  if (!covers(base)) return null
  for (const segment of object.segments ?? []) {
    if (Array.isArray(segment.positions) && segment.positions.length > 1 && covers(segment)) {
      return { start: segment.start, stepSeconds: segment.step_seconds, positions: segment.positions, fine: true }
    }
  }
  return { start: base.start, stepSeconds: base.step_seconds, positions: base.positions, fine: false }
}

/**
 * Geocentric ICRF position (km) at an instant, by Catmull-Rom in the table
 * `tableAt` picks. Writes into `out`; returns null (and leaves `out` alone)
 * when the instant is outside the table.
 *
 * @param {number[]} out  [x, y, z]
 */
export function positionAt(object, tSeconds, out) {
  const table = tableAt(object, tSeconds)
  if (!table) return null
  sampleCatmullRom(table.positions, (tSeconds - table.start) / table.stepSeconds, out)
  return out
}

/**
 * The next close approach after an instant.
 *
 * - `in_window`: inside the tables, so the clock can go there;
 * - `after_window`: the one after the window — its date is all that can be said,
 *   the clock stops at the end of the tables;
 * - `none`: nothing known closer than 0,05 ua (and always the answer for a
 *   non-NEO, which has no approaches by construction);
 * - `unavailable`: `close_approaches` is null — JPL CAD failed for this object,
 *   which is not the same as "no approach".
 *
 * @returns {{kind: 'in_window'|'after_window', time: number, approach: object}
 *   | {kind: 'none'} | {kind: 'unavailable'}}
 */
export function nextApproach(object, tSeconds) {
  if (!object || !object.neo) return { kind: 'none' }
  if (object.close_approaches === null) return { kind: 'unavailable' }
  let best = null
  for (const approach of object.close_approaches ?? []) {
    if (approach.time > tSeconds && (best === null || approach.time < best.time)) best = approach
  }
  if (best) return { kind: 'in_window', time: best.time, approach: best }
  const after = object.next_close_approach_after_window
  if (after && after.time > tSeconds) return { kind: 'after_window', time: after.time, approach: after }
  return { kind: 'none' }
}
