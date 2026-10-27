import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { TIME_SCALE } from '../../src/data/api.js'
import { defaultMinMs } from '../../src/ephemeris/clock.js'
import { TABLE_MARGIN_MS, sampleKm, tableCovers, tableEndSeconds, tablePositionKm } from '../../src/ephemeris/positionTable.js'
import { icrfToScene } from '../../src/scene/geo.js'

// What is pinned: the rules every Horizons table in the scene shares. None shows
// on screen when it breaks — a table kept one day too long draws a planet a day
// off, one kept without history stops the clock at the 1st of the month, a
// sample left in ICRF puts a body in the wrong place by an axis swap.

const DAY = 86_400
const NOW_MS = Date.UTC(2026, 9, 27, 12)

/** A daily table of `days` rows from `startMs`, rows (i, 2i, 3i) km. */
const table = (startMs, days, extra = {}) => ({
  timeScale: TIME_SCALE,
  start: startMs / 1000,
  stepSeconds: DAY,
  positions: Array.from({ length: days }, (_, i) => [i, 2 * i, 3 * i]),
  ...extra,
})

describe('tableEndSeconds', () => {
  it("n lignes, n − 1 pas : la dernière ligne, pas une au-delà", () => {
    expect(tableEndSeconds(table(0, 10))).toBe(9 * DAY)
  })
})

describe('tableCovers', () => {
  const yearFromHistory = () => table(defaultMinMs(NOW_MS), 500)

  it('vide, absente ou dans une autre échelle de temps : refusée', () => {
    expect(tableCovers(null, NOW_MS)).toBe(false)
    expect(tableCovers(table(NOW_MS - DAY * 1000, 0), NOW_MS)).toBe(false)
    expect(tableCovers(table(NOW_MS - DAY * 1000, 10, { timeScale: 'TDB' }), NOW_MS)).toBe(false)
  })

  it('sans historique : il suffit que « maintenant » soit dedans', () => {
    expect(tableCovers(table(NOW_MS - DAY * 1000, 10), NOW_MS)).toBe(true)
    expect(tableCovers(table(NOW_MS + 1000, 10), NOW_MS)).toBe(false)
    expect(tableCovers(table(NOW_MS - 10 * DAY * 1000, 10), NOW_MS)).toBe(false) // finie hier
  })

  it("avec historique : doit remonter jusqu'à la borne basse de l'horloge", () => {
    expect(tableCovers(yearFromHistory(), NOW_MS, { history: true })).toBe(true)
    const tooLate = table(defaultMinMs(NOW_MS) + DAY * 1000, 500)
    expect(tableCovers(tooLate, NOW_MS, { history: true })).toBe(false)
    expect(tableCovers(tooLate, NOW_MS)).toBe(true) // sans la règle, elle passerait
  })

  it('avec marge : abandonnée 30 jours avant sa fin, pas à sa fin', () => {
    const endsIn20Days = table(NOW_MS - 100 * DAY * 1000, 121)
    expect(tableCovers(endsIn20Days, NOW_MS)).toBe(true)
    expect(tableCovers(endsIn20Days, NOW_MS, { marginMs: TABLE_MARGIN_MS })).toBe(false)
  })
})

describe('sampleKm / tablePositionKm', () => {
  it("sur une ligne, rend cette ligne convertie en axes de scène — pas l'ICRF brut", () => {
    const rows = [[1e6, 2e6, 3e6], [4e6, 5e6, 7e6], [9e6, 1e6, 2e6], [3e6, 3e6, 3e6]]
    const out = sampleKm(rows, 1, new THREE.Vector3())
    const expected = icrfToScene(4e6, 5e6, 7e6, new THREE.Vector3())
    expect(out.distanceTo(expected)).toBeLessThan(1e-6)
    expect(out.toArray()).not.toEqual([4e6, 5e6, 7e6])
  })

  it("à l'instant d'une ligne, et bloquée à la dernière au-delà de la fin", () => {
    const t = table(0, 5)
    const at2 = tablePositionKm(t, 2 * DAY, new THREE.Vector3())
    expect(at2.distanceTo(icrfToScene(2, 4, 6, new THREE.Vector3()))).toBeLessThan(1e-9)
    const past = tablePositionKm(t, 50 * DAY, new THREE.Vector3())
    expect(past.distanceTo(icrfToScene(4, 8, 12, new THREE.Vector3()))).toBeLessThan(1e-9)
  })
})
