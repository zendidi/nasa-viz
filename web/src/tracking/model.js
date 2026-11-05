/**
 * Tracking of up to ten (five until 2026-11-05) asteroids chosen by the user (docs/suivi-asteroides.md):
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
 * each from its own cache in ~0,1 s. And since 2026-11-05 only the records the
 * user chose to keep (`saved`) are in that stored list.
 */

import { sampleCatmullRom } from '../ephemeris/interpolate.js'

/**
 * Hard ceiling on tracked objects (decided with the user, 2026-10-27; raised to
 * 10 on 2026-11-05: the five colours × {solid, dashed} line, see TRACK_SLOTS).
 */
export const MAX_TRACKED = 10

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
 * The ten slots (2026-11-05): the five palette colours in a solid line, then the
 * same five dashed. No new hue was invented — a dashed trace is told from its
 * solid twin by the pattern, and the panel's dot shows the same pattern.
 * Allocation order is this array's order.
 */
export const TRACK_SLOTS = Object.freeze([
  ...TRACK_COLORS.map((color) => Object.freeze({ color, dashed: false })),
  ...TRACK_COLORS.map((color) => Object.freeze({ color, dashed: true })),
])

/**
 * The first slot no tracked object wears. Stable: removing the second of three
 * leaves the others' slots alone, and the next arrival takes the freed one.
 *
 * @param {{color?: number, dashed?: boolean}[]} list
 * @returns {{color: number, dashed: boolean}}
 */
export function freeSlot(list) {
  const free = TRACK_SLOTS.find((slot) => !list.some((rec) => rec.color === slot.color && (rec.dashed === true) === slot.dashed))
  return free ?? TRACK_SLOTS[0]
}

/**
 * `saved` (2026-11-05): only the records marked so are written to localStorage;
 * the others live for the session. A new object is not saved.
 *
 * @typedef {{spkid: string, des: string, fullname: string, neo: boolean, color: number,
 *   dashed: boolean, saved: boolean}} TrackedRecord
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
 * slot (colour + solid/dashed) that is missing, foreign or shared is reassigned.
 *
 * Whatever comes back from storage is `saved: true` by construction — it was
 * stored. That is also what a record written before the `saved` field existed
 * (before 2026-11-05) must read as: nobody loses their list on update. A record
 * without `dashed` is a solid line, for the same reason.
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
    const dashed = item.dashed === true
    const slotOk =
      TRACK_COLORS.includes(item.color) && !list.some((rec) => rec.color === item.color && rec.dashed === dashed)
    list.push({ ...base, color: slotOk ? item.color : -1, dashed, saved: true })
  }
  // A second pass for the slots that were not usable, so the valid ones win.
  for (const rec of list) {
    if (rec.color === -1) Object.assign(rec, freeSlot(list.filter((other) => other.color !== -1)))
  }
  return list
}

/** What goes to localStorage: only the records the user chose to keep. */
export function savedList(list) {
  return list.filter((rec) => rec.saved)
}

/** The list with one record's `saved` flag set (unchanged if absent). */
export function setSaved(list, spkid, saved) {
  return list.map((rec) => (rec.spkid === spkid ? { ...rec, saved } : rec))
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
  return { list: [...list, { ...base, ...freeSlot(list), saved: false }], added: true, reason: null }
}

/** The list without that SPK-ID (unchanged if absent). */
export function removeTracked(list, spkid) {
  return list.filter((rec) => rec.spkid !== spkid)
}

/** The list with one SPK-ID replaced by another — an object got numbered, its id changed. Colour, line style and `saved` kept. */
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
 * The help line for a search typed as a bare number that SBDB read as an
 * object number ("2017" is asteroid n° 2017, not the year). null for anything
 * that is not digits only. The year hint is only given for a plausible year.
 *
 * @param {string} query
 * @returns {string | null}
 */
export function numberSearchHelp(query) {
  const q = query.trim()
  if (!/^\d+$/.test(q)) return null
  const n = Number(q)
  const head = `« ${q} » = l'astéroïde n° ${n}.`
  if (q.length === 4 && n >= 1800 && n <= 2100) {
    return `${head} Pour une désignation de l'année ${q}, tapez-la en entier (« ${q} YE5 ») ou son début (« ${q} YE ») pour une liste.`
  }
  return head
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

/**
 * What the Earth's view draws of a NEO's path relative to the Earth: only its
 * flybys, ±FLYBY_HALF_SECONDS around each close approach (user's call,
 * 2026-10-27). Over the whole year that path carries the Earth's own motion and
 * loops on itself — noise for a main-belt object, and mostly noise for a NEO
 * too; the rest of the year is the heliocentric line, drawn from every pivot.
 *
 * 15 days, because CAD lists approaches closer than 0,05 au (7,5 million km):
 * at 6 km/s and up, ±15 days spans the whole passage inside that distance.
 */
export const FLYBY_HALF_SECONDS = 15 * 86_400
const FLYBY_STEP_SECONDS = 3600
// Finer around the approach itself: Apophis covers ~160 000 km in 6 h, at a
// 38 000 km perigee, so the coarse trace's chords would cut the corner.
const FLYBY_FINE_HALF_SECONDS = 86_400
const FLYBY_FINE_STEP_SECONDS = 300

/**
 * Dash patterns of a `dashed` trace (2026-11-05), in **time**, not in sample
 * index: the heliocentric line is sampled every 6 h, the flyby arcs every hour
 * (5 min at the perigee), and a pattern counted in samples would change with the
 * step. The line alternates drawn / empty slots of this length, anchored on the
 * Unix epoch so a given date is always drawn or always empty.
 *
 * Heliocentric: 4 days on / 4 off — a year is ~45 dashes, each ≥ 16 samples
 * long. Flyby (±15 d around each approach): 12 h on / 12 h off — about 60 dashes
 * per arc, still several samples per dash at the 1 h step.
 */
export const DASH_HELIO_SECONDS = 4 * 86_400
export const DASH_FLYBY_SECONDS = 12 * 3600

/**
 * Whether the segment between two samples is drawn in a dashed line: it is when
 * its midpoint falls in an even slot of `slotSeconds`. Two samples inside the
 * same empty slot therefore give a segment that is not kept.
 *
 * @param {number} fromSeconds  time of the segment's first sample
 * @param {number} toSeconds    time of its second
 * @param {number} slotSeconds  DASH_HELIO_SECONDS or DASH_FLYBY_SECONDS
 */
export function dashKeepsSegment(fromSeconds, toSeconds, slotSeconds) {
  return Math.floor((fromSeconds + toSeconds) / 2 / slotSeconds) % 2 === 0
}

/**
 * The instants to sample, as one array per arc: approaches whose windows
 * overlap share one arc, every arc is clipped to [startS, endS] (the tables'
 * span), and each approach instant is itself a sample, so the arc passes
 * through the perigee rather than beside it.
 *
 * @param {number[]} approachTimes  seconds
 * @returns {number[][]}
 */
export function flybyArcTimes(approachTimes, startS, endS) {
  const windows = approachTimes
    .map((time) => [Math.max(startS, time - FLYBY_HALF_SECONDS), Math.min(endS, time + FLYBY_HALF_SECONDS)])
    .filter(([from, to]) => from < to)
    .sort((a, b) => a[0] - b[0])
  const merged = []
  for (const window of windows) {
    const last = merged[merged.length - 1]
    if (last && window[0] <= last[1]) last[1] = Math.max(last[1], window[1])
    else merged.push([...window])
  }
  const near = (time) => approachTimes.some((a) => Math.abs(time - a) < FLYBY_FINE_HALF_SECONDS)
  return merged.map(([from, to]) => {
    const times = new Set(approachTimes.filter((a) => a >= from && a <= to))
    for (let time = from; time < to; time += near(time) ? FLYBY_FINE_STEP_SECONDS : FLYBY_STEP_SECONDS) times.add(time)
    times.add(to)
    return [...times].sort((a, b) => a - b)
  })
}
