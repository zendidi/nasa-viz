/**
 * The "Suivi" tab's controller: the tracked list (the only thing persisted —
 * tracking/model.js says why), the user's choice to keep the week's NEO points on
 * screen while something is tracked, the "Suivre" button of a weekly NEO's
 * sheet, and which tracked object's sheet the detail panel shows. The scene
 * module (tracking/scene.js) loads the tables and draws; this one decides.
 *
 * The NEO of the week stays what it was: a tracked asteroid is a different
 * object, NEO or not. The weekly NEO's own sheet stays with main.js, which hears
 * back through `on` whenever this changes something that sheet shows.
 */

import { searchSmallBody } from '../data/api.js'
import { loadCached, saveCached } from '../data/cache.js'
import { cssColor } from '../neo/info.js'
import { createTrackedScene } from './scene.js'
import {
  MAX_TRACKED,
  TRACKED_CACHE_KEY,
  addTracked,
  interpretSearch,
  numberSearchHelp,
  isTrackedDesignation,
  nextApproach,
  readTrackedList,
  removeTracked,
} from './model.js'
import { trackButtonHtml, trackedSheetHtml } from '../ui/sheets.js'

/**
 * @param {object} options
 * @param {object} options.sceneOptions  what tracking/scene.js needs, minus `on`
 * @param {object} options.neoScene  neo/scene.js — the points it hides, the sheets it loads
 * @param {object} options.panels  ui/panels.js
 * @param {object} options.clock  clock.js
 * @param {() => number} options.simNowMs
 * @param {() => void} options.afterTimeJump  main.js's redraw after the clock jumped
 * @param {{neoSheetChanged: Function, trackedSheetOpened: Function, neoPolicyChanged: (visible: boolean) => void}} options.on
 *   - `neoSheetChanged`: the weekly NEO's sheet shows tracking state (its "Suivre"
 *     button) that just changed — redraw it if it is open;
 *   - `trackedSheetOpened`: a tracked sheet took the detail panel;
 *   - `neoPolicyChanged`: the week's points were just shown or hidden.
 */
export function createTracking({ sceneOptions, neoScene, panels, clock, simNowMs, afterTimeJump, on }) {
  /** @type {import('./model.js').TrackedRecord[]} */
  let list = []
  /** The user's choice, while something is tracked, to keep the week's NEO points on screen. */
  let showNeoWhileTracking = false
  /** The tracked object whose sheet the detail panel is showing (SPK-ID), like main.js's `modalNeo`. */
  let sheetSpkid = null
  /** The "Suivre" button of a weekly NEO's sheet: which designation is being resolved, and what it said. */
  let neoTrack = { designation: null, busy: false, message: '' }

  const trackedScene = createTrackedScene({
    ...sceneOptions,
    on: {
      changed: () => {
        refreshPanel()
        if (sheetSpkid) renderSheet()
      },
      // An object that got numbered changed SPK-ID: the stored one follows.
      spkidChanged: (oldSpkid, record) => {
        list = list.map((rec) => (rec.spkid === oldSpkid ? record : rec))
        saveCached(TRACKED_CACHE_KEY, list)
        if (sheetSpkid === oldSpkid) sheetSpkid = record.spkid
      },
    },
  })

  /** Points of the week on screen: all of them when nothing is tracked, the user's call otherwise. */
  function applyNeoPolicy() {
    const visible = list.length === 0 || showNeoWhileTracking
    neoScene.setPoints(visible)
    on.neoPolicyChanged(visible)
    refreshPanel()
  }

  function refreshPanel() {
    const nowSeconds = simNowMs() / 1000
    const items = []
    for (const rec of list) {
      const entry = trackedScene.get(rec.spkid)
      if (!entry) continue
      let approach = null
      if (rec.neo && entry.status === 'ready') {
        const next = nextApproach(entry.object, nowSeconds)
        approach = { kind: next.kind, timeMs: next.time * 1000, distKm: next.approach?.dist_km ?? null }
      }
      items.push({
        spkid: rec.spkid,
        name: rec.fullname,
        neo: rec.neo,
        color: cssColor(rec.color),
        status: entry.status,
        error: entry.error,
        approach,
      })
    }
    panels.renderTracking({
      items,
      full: list.length >= MAX_TRACKED,
      showNeo: list.length === 0 || showNeoWhileTracking,
    })
  }

  /** Adds a resolved record to the list and the scene. The refusal, if any, comes back as `reason`. */
  function trackRecord(record) {
    const outcome = addTracked(list, record)
    if (!outcome.added) return outcome
    list = outcome.list
    saveCached(TRACKED_CACHE_KEY, list)
    const added = list[list.length - 1]
    if (list.length === 1) showNeoWhileTracking = false // the first one clears the week's NEO off the scene
    trackedScene.add(added)
    applyNeoPolicy()
    return { ...outcome, record: added }
  }

  /** Adds a resolved record and says what came of it, in the panel's vocabulary. */
  function addResult(record) {
    const outcome = trackRecord(record)
    const name = record.fullname
    if (outcome.added) return { kind: 'added', name }
    return { kind: outcome.reason === 'full' ? 'full' : 'duplicate', name }
  }

  function open(spkid) {
    const entry = trackedScene.get(spkid)
    if (!entry) return
    on.trackedSheetOpened()
    neoScene.select(null)
    sheetSpkid = spkid
    renderSheet()
    neoScene.loadDetails([entry.rec.des])
  }

  /** A tracked object's sheet (ui/sheets.js), in the detail panel a weekly NEO's uses. */
  function renderSheet() {
    const entry = sheetSpkid ? trackedScene.get(sheetSpkid) : null
    if (!entry) return
    const { rec } = entry
    const nowSeconds = simNowMs() / 1000

    panels.openDetail(
      rec.fullname,
      trackedSheetHtml({
        rec,
        sheet: neoScene.sheet(rec.des),
        next: rec.neo && entry.status === 'ready' ? nextApproach(entry.object, nowSeconds) : null,
        positionHtml: trackedScene.describePosition(entry, nowSeconds, !clock.isRealTime()),
        nowMs: simNowMs(),
      }),
    )
  }

  return {
    trackedScene,

    get count() {
      return list.length
    },

    /** Reads the stored list back and starts every object's load — one request each, in parallel. */
    restore() {
      list = readTrackedList(loadCached(TRACKED_CACHE_KEY)?.data)
      for (const rec of list) trackedScene.add(rec)
      applyNeoPolicy()
    },

    refreshPanel,

    /**
     * The panel's search. A single match is *offered*, not added: SBDB reads "2017"
     * as the number 2017, which is not what the user may have meant. Only a click on
     * a candidate (`direct`, its designation is explicit) or on the result's button
     * (`trackAdd`) adds.
     */
    async search(q, { direct = false } = {}) {
      let found
      try {
        found = interpretSearch(await searchSmallBody(q))
      } catch (err) {
        return { kind: 'error', message: err.message }
      }
      if (found.kind !== 'match') return found
      if (!direct) {
        const tracked = isTrackedDesignation(list, found.record.des) || list.some((r) => r.spkid === found.record.spkid)
        return {
          kind: 'match',
          record: found.record,
          help: numberSearchHelp(q),
          state: tracked ? 'duplicate' : list.length >= MAX_TRACKED ? 'full' : 'ok',
        }
      }
      return addResult(found.record)
    },

    add: addResult,
    open,

    remove(spkid) {
      list = removeTracked(list, spkid)
      saveCached(TRACKED_CACHE_KEY, list)
      if (list.length === 0) showNeoWhileTracking = false
      const wasOpen = sheetSpkid === spkid
      trackedScene.remove(spkid)
      if (wasOpen) panels.closeDetail()
      applyNeoPolicy()
    },

    retry(spkid) {
      trackedScene.reload(spkid)
    },

    /** The "Suivi" tab's box. */
    setShowNeo(enabled) {
      showNeoWhileTracking = enabled
      applyNeoPolicy()
    },

    /**
     * The NEO panel's own points box: while something is tracked it is the same
     * choice as the "Suivi" tab's, so it is remembered here too.
     */
    pointsToggled(enabled) {
      if (list.length > 0) showNeoWhileTracking = enabled
    },

    /** Sets the clock on the next close approach of a tracked NEO — when it is inside the tables. */
    goToNextApproach(spkid) {
      const entry = trackedScene.get(spkid)
      if (!entry?.object) return
      const next = nextApproach(entry.object, simNowMs() / 1000)
      if (next.kind !== 'in_window') {
        refreshPanel() // out of the tables: the clock cannot go there, the panel says the date
        return
      }
      clock.jumpTo(next.time * 1000, Date.now())
      afterTimeJump()
    },

    /** "Suivre" in a weekly NEO's sheet: resolve its designation, then add it like a search would. */
    async trackFromNeo(designation) {
      neoTrack = { designation, busy: true, message: '' }
      on.neoSheetChanged()
      let message = ''
      try {
        const found = interpretSearch(await searchSmallBody(designation))
        if (found.kind === 'match') {
          const outcome = trackRecord(found.record)
          if (outcome.added || outcome.reason === 'duplicate') {
            neoTrack = { designation: null, busy: false, message: '' }
            panels.showTab('tracking')
            open((outcome.record ?? found.record).spkid)
            return
          }
          message = `${MAX_TRACKED} objets au plus`
        } else if (found.kind === 'candidates') {
          message = 'désignation ambiguë : utilisez la recherche de l\'onglet Suivi'
        } else if (found.kind === 'comet') {
          message = 'comète, pas encore prise en charge'
        } else {
          message = 'introuvable dans JPL SBDB'
        }
      } catch (err) {
        message = err.message
      }
      neoTrack = { designation, busy: false, message }
      on.neoSheetChanged()
    },

    /** The "Suivre" button for a weekly NEO's sheet, in its current state. */
    trackButtonFor(designation) {
      return trackButtonHtml({
        designation,
        tracked: isTrackedDesignation(list, designation),
        full: list.length >= MAX_TRACKED,
        neoTrack,
      })
    },

    /** Redraws the tracked sheet if it is the one open (a sheet or a table just landed). */
    renderSheet() {
      if (sheetSpkid) renderSheet()
    },

    /** The open tracked sheet's distance line only, at the current simulated time. */
    positionHtml() {
      const entry = sheetSpkid ? trackedScene.get(sheetSpkid) : null
      return entry ? trackedScene.describePosition(entry, simNowMs() / 1000, !clock.isRealTime()) : null
    },

    /** The detail panel was closed, or taken by a weekly NEO's sheet. */
    sheetClosed() {
      sheetSpkid = null
    },
  }
}
