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

/** What the backend accepts as an SPK-ID (`/api/small-body/*`). */
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
 * Since 2026-11-05 an object carries up to three kinds of table, and the order
 * of preference is the whole rule: a 5-minute **segment** (NEO close approaches)
 * wins over a loaded **hourly** slice (`object.hourly`, a NEO's civil year),
 * which wins over the **daily** base table (`object.table`, the whole range, every
 * object). Both ends of every table are inclusive: its last sample is a real
 * position. Outside the **daily table** there is nothing to say, whatever finer
 * table is loaded.
 *
 * `fine` is kept for "is it a segment"; `kind` says which of the three it is.
 *
 * @param {{table?: {start:number, step_seconds:number, positions:number[][]},
 *          hourly?: {start:number, step_seconds:number, positions:number[][]}[],
 *          segments?: {start:number, step_seconds:number, positions:number[][]}[]}|null|undefined} object
 * @param {number} tSeconds Unix seconds, UTC
 * @returns {{start:number, stepSeconds:number, positions:number[][], fine:boolean, kind:'segment'|'hourly'|'daily'}|null}
 */
export function tableAt(object, tSeconds) {
  const base = object?.table
  if (!base || !Array.isArray(base.positions) || base.positions.length === 0) return null
  const covers = (table) => tSeconds >= table.start && tSeconds <= table.start + (table.positions.length - 1) * table.step_seconds
  if (!covers(base)) return null
  const usable = (table) => Array.isArray(table.positions) && table.positions.length > 1 && covers(table)
  for (const segment of object.segments ?? []) {
    if (usable(segment)) return { start: segment.start, stepSeconds: segment.step_seconds, positions: segment.positions, fine: true, kind: 'segment' }
  }
  // Two hourly slices overlap by two rows at a 1 January. Catmull-Rom needs a
  // sample on each side of the interval: a slice's first and last intervals fall
  // back to a quadratic, so the slice that has the instant *inside* (one row in
  // from both ends) is preferred, and only then any slice that covers it.
  const inside = (table) => usable(table) && tSeconds >= table.start + table.step_seconds && tSeconds <= table.start + (table.positions.length - 2) * table.step_seconds
  const hourly = (object.hourly ?? []).find(inside) ?? (object.hourly ?? []).find(usable)
  if (hourly) return { start: hourly.start, stepSeconds: hourly.step_seconds, positions: hourly.positions, fine: false, kind: 'hourly' }
  return { start: base.start, stepSeconds: base.step_seconds, positions: base.positions, fine: false, kind: 'daily' }
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

/** The last instant a uniform-step table covers. */
export const tableEnd = (table) => table.start + (table.positions.length - 1) * table.step_seconds

/**
 * One table sampled at an instant (Catmull-Rom), null outside it — the Sun's
 * daily table of `/api/small-body/trajectory/sun`, which has no finer tier.
 */
export function sampleTable(table, tSeconds, out) {
  if (!table || !Array.isArray(table.positions) || table.positions.length === 0) return null
  if (tSeconds < table.start || tSeconds > tableEnd(table)) return null
  return sampleCatmullRom(table.positions, (tSeconds - table.start) / table.step_seconds, out)
}

/**
 * An object's path **relative to the Sun** (2026-11-05): its geocentric daily
 * row minus the Sun's geocentric position at that row's own date. The two daily
 * tables share a grid (same start, same step), so it is a row-by-row
 * subtraction; if they ever do not, the Sun is sampled at the row's date.
 * Rows the Sun table does not cover are left out.
 *
 * @returns {{times: number[], positions: number[][]}}  Unix seconds, ICRF km
 */
export function heliocentricPath(table, sunTable) {
  const times = []
  const positions = []
  const aligned = sunTable.start === table.start && sunTable.step_seconds === table.step_seconds
  const sun = [0, 0, 0]
  for (let i = 0; i < table.positions.length; i++) {
    const time = table.start + i * table.step_seconds
    const s = aligned && sunTable.positions[i] ? sunTable.positions[i] : sampleTable(sunTable, time, sun)
    if (!s) continue
    const p = table.positions[i]
    times.push(time)
    positions.push([p[0] - s[0], p[1] - s[1], p[2] - s[2]])
  }
  return { times, positions }
}

/**
 * Where the Earth was at the cursor's instant T′, in the geocentric frame of the
 * scene's own instant T: `Sun(T) − Sun(T′)` (the Earth is at `−Sun` seen from the
 * Sun, and the Sun is drawn at `Sun(T)`). Zero when T′ = T. null if either
 * instant is outside the Sun's table. This is the "ghost Earth" the cursor's
 * flybys are seen from.
 *
 * @param {number[]} out  [x, y, z]
 */
export function ghostEarthOffset(sunTable, tSeconds, tPrimeSeconds, out) {
  const now = sampleTable(sunTable, tSeconds, [0, 0, 0])
  const then = sampleTable(sunTable, tPrimeSeconds, [0, 0, 0])
  if (!now || !then) return null
  out[0] = now[0] - then[0]
  out[1] = now[1] - then[1]
  out[2] = now[2] - then[2]
  return out
}

/**
 * The next close approach after an instant.
 *
 * - `in_range`: no later than `limitSeconds` (the cursor's last instant), so the
 *   cursor can go there;
 * - `after_range`: the one after the cursor's range — its date is all that can be
 *   said. That is the next listed approach beyond `limitSeconds`, or else the one
 *   the backend reports past the table (`next_close_approach_after_range`);
 * - `none`: nothing known closer than 0,05 ua (and always the answer for a
 *   non-NEO, which has no approaches by construction);
 * - `unavailable`: `close_approaches` is null — JPL CAD failed for this object,
 *   which is not the same as "no approach".
 *
 * (Until 2026-11-05 these were `in_window` / `after_window`, the clock's window.)
 *
 * @param {number} [limitSeconds]  the last instant the cursor reaches (default: no limit)
 * @returns {{kind: 'in_range'|'after_range', time: number, approach: object}
 *   | {kind: 'none'} | {kind: 'unavailable'}}
 */
export function nextApproach(object, tSeconds, limitSeconds = Infinity) {
  if (!object || !object.neo) return { kind: 'none' }
  if (object.close_approaches === null) return { kind: 'unavailable' }
  let best = null
  for (const approach of object.close_approaches ?? []) {
    if (approach.time > tSeconds && (best === null || approach.time < best.time)) best = approach
  }
  if (best) return { kind: best.time <= limitSeconds ? 'in_range' : 'after_range', time: best.time, approach: best }
  const after = object.next_close_approach_after_range
  if (after && after.time > tSeconds) return { kind: 'after_range', time: after.time, approach: after }
  return { kind: 'none' }
}

/**
 * The last close approach at or before an instant, within the cursor's reach.
 *
 * 2026-11-05: a recent flyby that bent the orbit is the tool's showcase case (2026 TP128:
 * period 575 → 451 d, inclination 14,25° → 5,91°), and an object found at its flyby often
 * has no future one at all — `nextApproach` alone then said "aucun rapprochement connu".
 *
 * The boundary: `nextApproach` excludes an approach exactly at T′, so this one
 * includes it (`<=`) — an approach at T′ shows in one of the two, never in neither.
 *
 * @param {number} [minSeconds]  the first instant the cursor reaches (default: no limit)
 * @returns {{kind: 'in_range', time: number, approach: object} | {kind: 'none'} | {kind: 'unavailable'}}
 */
export function previousApproach(object, tSeconds, minSeconds = -Infinity) {
  if (!object || !object.neo) return { kind: 'none' }
  if (object.close_approaches === null) return { kind: 'unavailable' }
  let best = null
  for (const approach of object.close_approaches ?? []) {
    if (approach.time <= tSeconds && approach.time >= minSeconds && (best === null || approach.time > best.time)) best = approach
  }
  return best ? { kind: 'in_range', time: best.time, approach: best } : { kind: 'none' }
}

// --- the trajectory tool's cursor (2026-11-05) ------------------------------------

const DAY_S = 86_400

/** The cursor reaches from one year before now to four years after (user's call, 2026-11-05). */
export const CURSOR_BACK_YEARS = 1
export const CURSOR_FORWARD_YEARS = 4

const floorDayMs = (ms) => Math.floor(ms / (DAY_S * 1000)) * DAY_S * 1000

/**
 * The instants the cursor may reach, Unix seconds: [now − 1 year, now + 4 years]
 * on the wall clock, floored to a UTC midnight so the slider's day notches stay
 * on the same dates for a whole day, then cut to the daily table when it is known.
 *
 * @param {number} wallMs
 * @param {{startS: number, endS: number}|null} [range]  the daily table's span
 * @returns {{minS: number, maxS: number}}
 */
export function cursorBounds(wallMs, range = null) {
  const at = (years) => {
    const d = new Date(wallMs)
    d.setUTCFullYear(d.getUTCFullYear() + years)
    return floorDayMs(d.getTime()) / 1000
  }
  let minS = at(-CURSOR_BACK_YEARS)
  let maxS = at(CURSOR_FORWARD_YEARS)
  if (range) {
    minS = Math.max(minS, range.startS)
    maxS = Math.min(maxS, range.endS)
  }
  return { minS, maxS: Math.max(minS, maxS) }
}

/**
 * The cursor's instant after the slider moved to day notch `day` (0 = `minS`).
 * The slider only knows days: the time of day the cursor had is kept, so that
 * dragging across a flyby does not snap it to midnight.
 */
export function cursorFromSliderDay(day, currentS, bounds) {
  const timeOfDay = (((currentS - bounds.minS) % DAY_S) + DAY_S) % DAY_S
  return Math.min(bounds.maxS, Math.max(bounds.minS, bounds.minS + day * DAY_S + timeOfDay))
}

/** The slider notch (whole days from `minS`) of an instant. */
export function sliderDayOf(tS, bounds) {
  return Math.round((Math.min(bounds.maxS, Math.max(bounds.minS, tS)) - bounds.minS) / DAY_S)
}

const addMonthsUtc = (ms, months) => {
  const d = new Date(ms)
  const day = d.getUTCDate()
  d.setUTCDate(1)
  d.setUTCMonth(d.getUTCMonth() + months)
  const monthEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  d.setUTCDate(Math.min(day, monthEnd))
  return d.getTime()
}

/**
 * The cursor's offset from the scene's time as the panel writes it, in
 * calendar units between the two dates: « +2 a 5 m 12 j », « −3 h », and « 0 »
 * when they are the same instant. Years, months, days, hours; minutes only
 * when nothing larger is left.
 *
 * @param {number} fromMs  the scene's instant T
 * @param {number} toMs    the cursor's instant T′
 */
export function formatCursorOffset(fromMs, toMs) {
  if (fromMs === toMs) return '0'
  const [a, b] = fromMs < toMs ? [fromMs, toMs] : [toMs, fromMs]
  let years = 0
  while (addMonthsUtc(a, 12 * (years + 1)) <= b) years++
  let months = 0
  while (months < 11 && addMonthsUtc(a, 12 * years + months + 1) <= b) months++
  const rest = b - addMonthsUtc(a, 12 * years + months)
  const days = Math.floor(rest / (DAY_S * 1000))
  const hours = Math.floor((rest % (DAY_S * 1000)) / 3_600_000)
  const minutes = Math.floor((rest % 3_600_000) / 60_000)
  const parts = []
  if (years) parts.push(`${years} a`)
  if (months) parts.push(`${months} m`)
  if (days) parts.push(`${days} j`)
  if (hours) parts.push(`${hours} h`)
  if (parts.length === 0) parts.push(`${minutes} min`)
  return `${fromMs < toMs ? '+' : '−'}${parts.join(' ')}`
}

// --- precision slices (2026-11-05) -------------------------------------------------

/** Hourly slices (and their 5-minute segments) kept per NEO. */
export const MAX_SLICES = 3
/** Within this distance of a 1 January the neighbouring year is loaded too. */
export const SLICE_PRELOAD_SECONDS = 30 * DAY_S

/** The UTC year of an instant. */
export const yearOf = (tSeconds) => new Date(tSeconds * 1000).getUTCFullYear()
/** 1 January 00:00 UTC of a year, Unix seconds. */
export const yearStartSeconds = (year) => Date.UTC(year, 0, 1) / 1000

/**
 * Which hourly slices to ask for, and which to drop, for a cursor at `tSeconds`.
 *
 * Wanted: the cursor's own year, plus the neighbouring year when the cursor is
 * within 30 days of the 1 January that separates them (the slices overlap by two
 * rows, but the flyby arcs reach ±15 days, so the neighbour has to be there before
 * the cursor crosses). At most MAX_SLICES are kept: past that, the one farthest
 * from the cursor goes — never one that is wanted.
 *
 * @param {number}   tSeconds
 * @param {number[]} held   years already loaded or on their way
 * @param {{minYear: number, maxYear: number}} bounds  the years the backend accepts
 * @returns {{load: number[], evict: number[]}}
 */
export function slicesToLoad(tSeconds, held, { minYear, maxYear }) {
  const year = yearOf(tSeconds)
  const wanted = [year]
  if (tSeconds - yearStartSeconds(year) < SLICE_PRELOAD_SECONDS) wanted.push(year - 1)
  if (yearStartSeconds(year + 1) - tSeconds < SLICE_PRELOAD_SECONDS) wanted.push(year + 1)
  const inBounds = wanted.filter((y) => y >= minYear && y <= maxYear)
  const load = inBounds.filter((y) => !held.includes(y))
  const all = [...held, ...load]
  const distance = (y) => {
    const from = yearStartSeconds(y)
    const to = yearStartSeconds(y + 1)
    return tSeconds < from ? from - tSeconds : tSeconds > to ? tSeconds - to : 0
  }
  const evict = []
  while (all.length - evict.length > MAX_SLICES) {
    const candidates = all.filter((y) => !evict.includes(y) && !inBounds.includes(y))
    if (candidates.length === 0) break
    evict.push(candidates.reduce((far, y) => (distance(y) > distance(far) ? y : far)))
  }
  return { load, evict }
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
// 2026-11-05: 15 min (was 1 h) so the finest zoom level (1,5 h slots for a dashed
// object) still has 6 samples per slot; ~3 300 points per ±15 d arc, 576 of them in
// the 5 min stretch around the perigee.
const FLYBY_STEP_SECONDS = 900
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
 * The flyby arc is two-coloured (2026-11-05, user's feedback). Drawn around the
 * Earth at T′, the path is the object's motion *relative to the Earth*, which
 * itself runs at ~30 km/s: only the relative velocity is left, hence an almost
 * straight line with an elbow at the perigee. In the object's colour, like the
 * heliocentric line, it read as "a pink stroke cutting through the orbit,
 * inconsistent" — nothing said it was another frame. So the arc alternates the
 * object's colour and the colour of the Earth's orbit: "path relative to the Earth".
 * Cut in time like the dashes, anchored on the Unix epoch (a date always has the
 * same colour):
 * - solid object: slots of DASH_FLYBY_SECONDS (12 h), object / Earth, no gap;
 * - dashed object: slots of FLYBY_DASHED_SLOT_SECONDS (6 h), object / empty /
 *   Earth / empty, so the dashes stay legible next to their solid twin.
 */
export const FLYBY_DASHED_SLOT_SECONDS = 6 * 3600

/**
 * Slot size of the flyby arc's colours (2026-11-05), second version. The first one had 3
 * levels (12 h -> 6 h -> 3 h, dashed 6 -> 3 -> 1,5 h) spread in log between the controls'
 * minDistance and maxDistance. Those span the Earth's radius to the solar system, so the
 * finest level was reached long before the real close-up: Earth view, 100 % real scale,
 * Apophis on 13/04/2029 21:45, ghost Earth ~115 px across, and a single 3 h slot (~80 000 km
 * at the 7,4 km/s of the perigee, ~6 Earth diameters) filled the screen.
 *
 * The rule is now: a slot covers about a fixed share of the camera's distance on screen.
 * Slot = 12 h / 2^k (dashed 6 h / 2^k, same object / empty / Earth / empty pattern), k a
 * whole number from 0 up to FLYBY_MAX_SLOT_LEVEL. Powers of 2 anchored on the Unix epoch:
 * every boundary of a coarse k stays a boundary of the finer ones, the slots split in two
 * without sliding while zooming. The ideal duration is share x distance / the arc's speed
 * **in scene units** (so it follows the scale curve and each object's own speed, no km
 * needed); the scene computes that speed, flybyIdealSlotSeconds turns it into seconds.
 */
export const FLYBY_SLOT_FRACTION = 1 / 8 // ~8 slots over the height seen from the camera
// Finest k: 12 h / 2^5 = 22,5 min (dashed 11,25 min). Below, a slot would hold less than a
// sample of the 15 min step used beyond +-1 day of the passage (5 min near the perigee).
export const FLYBY_MAX_SLOT_LEVEL = Math.floor(Math.log2(DASH_FLYBY_SECONDS / FLYBY_STEP_SECONDS))
// Margin (log2 units, ~ +-25 %) the ideal duration must pass beyond a boundary before k changes.
const FLYBY_SLOT_HYSTERESIS = Math.log2(1.25)

/**
 * The slot duration, in seconds, that would span FLYBY_SLOT_FRACTION of the camera's distance.
 *
 * @param {number} cameraDistance  camera -> target, scene units
 * @param {number} sceneSpeed      the arc's speed near T′, scene units per second
 */
export function flybyIdealSlotSeconds(cameraDistance, sceneSpeed) {
  return (FLYBY_SLOT_FRACTION * cameraDistance) / sceneSpeed
}

/**
 * The k for an ideal duration: the smallest whole k whose slot (12 h / 2^k) is no longer
 * than the ideal, bounded to [0, FLYBY_MAX_SLOT_LEVEL]. `previousK` adds a hysteresis so
 * the colours do not flicker at a boundary.
 *
 * @param {number} idealSeconds  flybyIdealSlotSeconds
 * @param {number|null} [previousK]
 * @returns {number}
 */
export function flybySlotLevel(idealSeconds, previousK = null) {
  if (Number.isNaN(idealSeconds)) return previousK ?? 0
  const x = Math.log2(DASH_FLYBY_SECONDS / idealSeconds) // fractional k; k = ceil(x) is the smallest slot <= ideal
  const clamp = (k) => Math.min(FLYBY_MAX_SLOT_LEVEL, Math.max(0, k))
  const raw = clamp(Math.ceil(x))
  if (previousK === null || previousK === raw) return raw
  // previousK keeps its seat while x stays within one margin of its own interval (k - 1, k].
  if (x > previousK - 1 - FLYBY_SLOT_HYSTERESIS && x <= previousK + FLYBY_SLOT_HYSTERESIS) return previousK
  return raw
}

/**
 * What a flyby-arc segment is drawn with: `'object'`, `'earth'` or `null` (not
 * drawn). Attributed by the segment's midpoint, like dashKeepsSegment.
 *
 * @param {number}  fromSeconds  time of the segment's first sample
 * @param {number}  toSeconds    time of its second
 * @param {boolean} dashed       the object's dashed variant
 * @param {number}  [k]          flybySlotLevel: slots divided by 2 ** k
 * @returns {'object' | 'earth' | null}
 */
export function flybySegmentColor(fromSeconds, toSeconds, dashed, k = 0) {
  const mid = (fromSeconds + toSeconds) / 2
  const divisor = 2 ** k
  if (!dashed) return Math.floor(mid / (DASH_FLYBY_SECONDS / divisor)) % 2 === 0 ? 'object' : 'earth'
  return [ 'object', null, 'earth', null ][Math.floor(mid / (FLYBY_DASHED_SLOT_SECONDS / divisor)) % 4]
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
  return denseArcTimes(approachTimes, startS, endS, FLYBY_HALF_SECONDS, FLYBY_STEP_SECONDS)
}

/**
 * The step logic shared by the flyby arcs and the densified heliocentric line:
 * ±`halfSeconds` windows around each approach (merged when they overlap, clipped
 * to [startS, endS]), 5 min within a day of an approach and `coarseStep` beyond.
 */
function denseArcTimes(approachTimes, startS, endS, halfSeconds, coarseStep) {
  const windows = approachTimes
    .map((time) => [Math.max(startS, time - halfSeconds), Math.min(endS, time + halfSeconds)])
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
    for (let time = from; time < to; time += near(time) ? FLYBY_FINE_STEP_SECONDS : coarseStep) times.add(time)
    times.add(to)
    return [...times].sort((a, b) => a - b)
  })
}

/**
 * Which flyby arc is on show for the cursor's instant T′ (2026-11-05): the index of
 * the arc whose window — first to last instant of `flybyArcTimes`' array, bounds
 * included — holds T′, or -1. An arc is the path relative to the Earth **around its
 * passage**; drawn at another date it is nonsense. Measured: Apophis's 2029 arc, still
 * loaded with the cursor at 14/10/2026, ran as a long stroke through the Earth view
 * while its heliocentric path never comes within 18,4 million km of the Earth of that day.
 *
 * @param {number[][]} arcs  flybyArcTimes' output
 * @returns {number}
 */
export function activeFlybyArc(arcs, tPrime) {
  return arcs.findIndex((arc) => arc.length > 0 && tPrime >= arc[0] && tPrime <= arc[arc.length - 1])
}

/** ±3 days around each passage: the stretch of the heliocentric line that gets dense samples. */
export const HELIO_DENSE_HALF_SECONDS = 3 * 86_400
const HELIO_DENSE_STEP_SECONDS = 3600

/**
 * The instants of the dense samples of the heliocentric line, one array per merged
 * window (5 min within a day of the passage, 1 h beyond, up to ±3 days).
 *
 * @param {number[]} approachTimes  passages whose hourly slice is loaded
 * @returns {number[][]}
 */
export function heliocentricDenseTimes(approachTimes, startS, endS) {
  return denseArcTimes(approachTimes, startS, endS, HELIO_DENSE_HALF_SECONDS, HELIO_DENSE_STEP_SECONDS)
}

/**
 * The daily heliocentric line with dense samples around the passages (2026-11-05).
 * The daily chord strays from the true course at a close passage, which bends the
 * heliocentric path in a few hours: measured on 2026 TP128 (2026-10-15 14:38 TDB,
 * 7 490 km, 21,5 km/s), up to 99 671 km at the passage, so the marker (read from the
 * precise table) left the line and rejoined it. Inside each dense window the daily
 * rows are replaced by `sampleAt` rows; outside it, nothing changes.
 *
 * @param {{times: number[], positions: number[][]}} path  heliocentricPath's output
 * @param {number[][]} denseArcs  heliocentricDenseTimes' output
 * @param {(time: number) => number[] | null} sampleAt  heliocentric position, or null if unknown there
 * @returns {{times: number[], positions: number[][]}}
 */
export function densifyHeliocentric(path, denseArcs, sampleAt) {
  const rows = []
  const inside = (time) => denseArcs.some((arc) => arc.length > 0 && time >= arc[0] && time <= arc[arc.length - 1])
  path.times.forEach((time, i) => {
    if (!inside(time)) rows.push([time, path.positions[i]])
  })
  for (const arc of denseArcs) {
    for (const time of arc) {
      const p = sampleAt(time)
      if (p) rows.push([time, [p[0], p[1], p[2]]])
    }
  }
  rows.sort((a, b) => a[0] - b[0])
  return { times: rows.map((r) => r[0]), positions: rows.map((r) => r[1]) }
}
