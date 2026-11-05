import { describe, expect, it } from 'vitest'

import { sampleCatmullRom } from '../../src/ephemeris/interpolate.js'
import { tableEndSeconds, tableIndexAt } from '../../src/ephemeris/positionTable.js'
import {
  LEGACY_KEYS,
  MAX_CONSECUTIVE_FAILURES,
  assembleSlices,
  clockBounds,
  loadPlan,
  nearestYear,
  orbitFromResponse,
  orientationFromResponse,
  positionsSliceFromResponse,
  runJobs,
  staleKeys,
  validOrbit,
  validOrientation,
  validPositionsSlice,
  yearRange,
  yearStartSeconds,
  yearsByDistance,
} from '../../src/ephemeris/slices.js'
import { cursorBounds } from '../../src/tracking/model.js'
import { SPEED_KM_S, continuousTable, positionAtSeconds, servedResponse, sliceRecord, slicesMap } from './sliceFixtures.js'

// Ce qui est épinglé ici : les invariants que l'œil ne voit pas. Une ligne de
// recouvrement dupliquée ou perdue à la couture du 1er janvier décale d'un pas
// (un jour : 2,6 millions de km) tout ce qui suit, sur une scène qui a l'air
// juste ; des bornes d'horloge qui ne sont pas celles du curseur de l'outil de
// trajectoire laissent l'un aller où l'autre refuse.

const DAY = 86_400
const WALL = Date.UTC(2026, 10, 5, 12, 34) // 2026-11-05 : tranches 2025 … 2030
const RANGE = yearRange(WALL)

describe('assembleSlices — une table d’un seul tenant', () => {
  for (const [label, step] of [['pas d’un jour', DAY], ['pas de 6 h (Lune, Mercure, Vénus)', DAY / 4]]) {
    it(`les six tranches 2025-2030 égalent, ligne pour ligne, la table continue (${label})`, () => {
      const whole = continuousTable(2025, 2030, step)
      const assembled = assembleSlices(slicesMap([2025, 2026, 2027, 2028, 2029, 2030], step), 2026)
      expect(assembled.start).toBe(whole.start)
      expect(assembled.stepSeconds).toBe(step)
      expect(assembled.timeScale).toBe('UTC')
      expect(assembled.positions).toHaveLength(whole.positions.length)
      expect(assembled.positions).toEqual(whole.positions)
      expect([assembled.firstYear, assembled.lastYear]).toEqual([2025, 2030])
    })
  }

  it('une suite plus courte : la table continue de ses années, recouvrements extérieurs gardés', () => {
    const assembled = assembleSlices(slicesMap([2027, 2028, 2029], DAY), 2028)
    const whole = continuousTable(2027, 2029, DAY)
    expect(assembled.start).toBe(whole.start)
    expect(assembled.positions).toEqual(whole.positions)
    // Les deux lignes avant le 1er janvier 2027 et après le 1er janvier 2030 sont là.
    expect(assembled.start).toBe(yearStartSeconds(2027) - 2 * DAY)
    expect(tableEndSeconds(assembled)).toBe(yearStartSeconds(2030) + 2 * DAY)
  })

  it('une seule tranche : elle-même, entière', () => {
    const slice = sliceRecord(2026, DAY)
    const assembled = assembleSlices(new Map([[2026, slice]]), 2026)
    expect(assembled.positions).toEqual(slice.positions)
    expect(assembled.start).toBe(slice.start)
  })

  it('année bissextile : 366 jours, la ligne du 29 février est à sa date', () => {
    const assembled = assembleSlices(slicesMap([2027, 2028, 2029], DAY), 2028)
    const feb29 = Date.UTC(2028, 1, 29) / 1000
    const i = (feb29 - assembled.start) / DAY
    expect(Number.isInteger(i)).toBe(true)
    expect(assembled.positions[i]).toEqual(positionAtSeconds(feb29))
    expect(sliceRecord(2028, DAY).positions).toHaveLength(366 + 5)
    expect(sliceRecord(2027, DAY).positions).toHaveLength(365 + 5)
    expect(assembled.positions).toHaveLength(365 + 366 + 365 + 5)
  })

  it('un trou coupe la couverture : seule la suite contiguë qui contient l’année courante compte', () => {
    const slices = slicesMap([2025, 2026, 2028, 2029, 2030], DAY) // 2027 manque
    const low = assembleSlices(slices, 2026)
    expect([low.firstYear, low.lastYear]).toEqual([2025, 2026])
    expect(tableEndSeconds(low)).toBe(yearStartSeconds(2027) + 2 * DAY)
    const high = assembleSlices(slices, 2028)
    expect([high.firstYear, high.lastYear]).toEqual([2028, 2030])
    expect(high.start).toBe(yearStartSeconds(2028) - 2 * DAY)
    expect(assembleSlices(slices, 2027)).toBeNull()
  })

  it('une tranche à un autre pas ou une autre horloge n’est pas recollée : elle coupe comme un trou', () => {
    const slices = slicesMap([2025, 2026, 2027], DAY)
    slices.set(2027, sliceRecord(2027, DAY / 4))
    expect(assembleSlices(slices, 2026).lastYear).toBe(2026)
    slices.set(2027, sliceRecord(2027, DAY, { timeScale: 'TDB' }))
    expect(assembleSlices(slices, 2026).lastYear).toBe(2026)
  })

  it('rien en main : null', () => {
    expect(assembleSlices(new Map(), 2026)).toBeNull()
  })
})

describe('Catmull-Rom à la couture du 1er janvier', () => {
  const at = (table, seconds) => sampleCatmullRom(table.positions, tableIndexAt(table, seconds), [0, 0, 0])
  const newYear = yearStartSeconds(2027)
  const before = newYear - 60 // 31/12 23:59
  const after = newYear + 60 // 1/1 00:01

  it('pas de saut entre 23:59 et 00:01 : l’écart est le chemin de 2 minutes, pas un pas', () => {
    const table = assembleSlices(slicesMap([2026, 2027], DAY), 2026)
    const a = at(table, before)
    const b = at(table, after)
    const gap = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
    expect(gap).toBeGreaterThan(0.95 * SPEED_KM_S * 120)
    expect(gap).toBeLessThan(1.05 * SPEED_KM_S * 120)
  })

  it('l’assemblage et la tranche lue seule rendent la même position, de part et d’autre', () => {
    const assembled = assembleSlices(slicesMap([2026, 2027], DAY), 2026)
    for (const [year, seconds] of [[2026, before], [2027, after]]) {
      const alone = sliceRecord(year, DAY)
      const expected = at(alone, seconds)
      const got = at(assembled, seconds)
      for (let k = 0; k < 3; k++) expect(got[k]).toBeCloseTo(expected[k], 6)
    }
  })

  it('et reste sur la courbe : l’erreur est celle de l’interpolation, pas d’une ligne mal placée', () => {
    const assembled = assembleSlices(slicesMap([2026, 2027], DAY), 2026)
    for (const seconds of [before, after, newYear]) {
      const got = at(assembled, seconds)
      const truth = positionAtSeconds(seconds)
      expect(Math.hypot(got[0] - truth[0], got[1] - truth[1], got[2] - truth[2])).toBeLessThan(50) // km, sur 1,5e8
    }
  })
})

describe('bornes de l’horloge = bornes du curseur de l’outil de trajectoire', () => {
  const walls = {
    'un jour ordinaire': Date.UTC(2026, 10, 5, 12, 34, 56),
    'le 1er janvier à minuit': Date.UTC(2027, 0, 1, 0, 0, 0),
    'le 1er janvier à 00:00:01': Date.UTC(2027, 0, 1, 0, 0, 1),
    'le 31 décembre à 23:59:59': Date.UTC(2026, 11, 31, 23, 59, 59),
    'un 29 février': Date.UTC(2028, 1, 29, 13, 0, 0),
    'le 29 février à minuit pile': Date.UTC(2028, 1, 29),
    'le lendemain d’un 29 février': Date.UTC(2028, 2, 1, 6),
  }

  for (const [label, wallMs] of Object.entries(walls)) {
    it(`${label} : mêmes bornes que cursorBounds`, () => {
      const cursor = cursorBounds(wallMs)
      const clock = clockBounds(wallMs)
      expect(clock.minMs).toBe(cursor.minS * 1000)
      expect(clock.maxMs).toBe(cursor.maxS * 1000)
    })
  }

  it('minuit UTC, et [maintenant − 1 an, maintenant + 4 ans] à un jour près', () => {
    const { minMs, maxMs } = clockBounds(WALL)
    expect(minMs % (DAY * 1000)).toBe(0)
    expect(maxMs % (DAY * 1000)).toBe(0)
    expect(minMs).toBe(Date.UTC(2025, 10, 5))
    expect(maxMs).toBe(Date.UTC(2030, 10, 5))
  })

  it('coupées à la couverture du Soleil quand elle est plus courte — comme le curseur, sans jamais s’inverser', () => {
    for (const wallMs of Object.values(walls)) {
      for (const range of [
        { startS: Date.UTC(2027, 0, 1) / 1000, endS: Date.UTC(2029, 5, 1) / 1000 },
        { startS: Date.UTC(2000, 0, 1) / 1000, endS: Date.UTC(2100, 0, 1) / 1000 }, // plus large : sans effet
        { startS: Date.UTC(2090, 0, 1) / 1000, endS: Date.UTC(2091, 0, 1) / 1000 }, // hors plage
      ]) {
        const cursor = cursorBounds(wallMs, range)
        const clock = clockBounds(wallMs, { startMs: range.startS * 1000, endMs: range.endS * 1000 })
        expect(clock.minMs).toBe(cursor.minS * 1000)
        expect(clock.maxMs).toBe(cursor.maxS * 1000)
        expect(clock.maxMs).toBeGreaterThanOrEqual(clock.minMs)
      }
    }
  })

  it('une extrémité inconnue (pas de table) ne coupe pas', () => {
    const full = clockBounds(WALL)
    expect(clockBounds(WALL, { startMs: null, endMs: null })).toEqual(full)
    const cut = clockBounds(WALL, { startMs: null, endMs: Date.UTC(2028, 0, 1) })
    expect(cut.minMs).toBe(full.minMs)
    expect(cut.maxMs).toBe(Date.UTC(2028, 0, 1))
  })
})

describe('validPositionsSlice — une tranche relue ou servie', () => {
  const ok = (overrides = {}, year = 2026, step = DAY) => validPositionsSlice(sliceRecord(year, step, overrides), year, RANGE)

  it('accepte une tranche conforme, à 1 jour comme à 6 h', () => {
    expect(ok()).toBe(true)
    expect(ok({}, 2028, DAY / 4)).toBe(true)
  })

  it('refuse une autre échelle de temps, ou qui ne le dit pas (TDB = 69 s de retard)', () => {
    expect(ok({ timeScale: 'TDB' })).toBe(false)
    expect(ok({ timeScale: undefined })).toBe(false)
  })

  it('refuse un autre repère que celui du contrat', () => {
    expect(ok({ frame: 'ICRF heliocentric' })).toBe(false)
    expect(ok({ frame: undefined })).toBe(false)
  })

  it('refuse un pas qui ne découpe pas le jour, ou absurde', () => {
    for (const stepSeconds of [0, -DAY, 7000, 2 * DAY, 1.5, undefined]) expect(ok({ stepSeconds })).toBe(false)
  })

  it('refuse une année hors de [Y−1, Y+4], même si la tranche est cohérente', () => {
    expect(validPositionsSlice(sliceRecord(2024, DAY), 2024, RANGE)).toBe(false)
    expect(validPositionsSlice(sliceRecord(2031, DAY), 2031, RANGE)).toBe(false)
    expect(validPositionsSlice(sliceRecord(2025, DAY), 2025, RANGE)).toBe(true)
    expect(validPositionsSlice(sliceRecord(2030, DAY), 2030, RANGE)).toBe(true)
  })

  it('refuse une tranche rangée sous une autre année que la sienne', () => {
    expect(validPositionsSlice(sliceRecord(2027, DAY), 2026, RANGE)).toBe(false)
    expect(ok({ year: 2027 })).toBe(false)
  })

  it('refuse des bornes qui ne sont pas les 1er janvier, un recouvrement qui n’est pas de 2 lignes, un nombre de lignes faux', () => {
    expect(ok({ sliceStart: yearStartSeconds(2026) + DAY })).toBe(false)
    expect(ok({ sliceEnd: yearStartSeconds(2027) + DAY })).toBe(false)
    expect(ok({ start: yearStartSeconds(2026) - DAY })).toBe(false)
    const rows = sliceRecord(2026, DAY).positions
    expect(ok({ positions: rows.slice(0, -1) })).toBe(false)
    expect(ok({ positions: [...rows, rows[0]] })).toBe(false)
    expect(ok({ positions: [] })).toBe(false)
    expect(ok({ positions: undefined })).toBe(false)
  })

  it('refuse une ligne qui n’est pas [x, y, z] finis', () => {
    const rows = sliceRecord(2026, DAY).positions.map((row) => row.slice())
    rows[10] = [1, NaN, 3]
    expect(ok({ positions: rows })).toBe(false)
    rows[10] = [1, 2]
    expect(ok({ positions: rows })).toBe(false)
  })

  it('refuse null et ce qui n’est pas un objet', () => {
    for (const value of [null, undefined, 'x', 42]) expect(validPositionsSlice(value, 2026, RANGE)).toBe(false)
  })

  it('range la réponse du backend selon les noms du contrat, et une table vide (positions null) est refusée', () => {
    const record = positionsSliceFromResponse(servedResponse(2027, DAY, 'mars'), 'mars')
    expect(validPositionsSlice(record, 2027, RANGE)).toBe(true)
    expect(record).toMatchObject({ year: 2027, timeScale: 'UTC', frame: 'ICRF geocentric', stepSeconds: DAY, radiusKm: 6371 })
    const empty = servedResponse(2027, DAY)
    empty.bodies[0].positions = null
    expect(validPositionsSlice(positionsSliceFromResponse(empty, 'mars'), 2027, RANGE)).toBe(false)
  })
})

describe('orbites et orientations relues', () => {
  const orbit = (year, overrides = {}) => ({
    frame: 'ICRF heliocentric',
    timeScale: 'UTC',
    year,
    start: yearStartSeconds(year),
    stop: yearStartSeconds(year) + 687 * DAY,
    positions: Array.from({ length: 10 }, (_, i) => [i, i, i]),
    ...overrides,
  })
  const orientation = (year, overrides = {}) => ({
    frame: 'ICRF',
    year,
    epoch: yearStartSeconds(year),
    pole: [0, 0, 1],
    primeMeridian: [1, 0, 0],
    rateDegPerDay: 350.9,
    ...overrides,
  })

  it('orbite : repère héliocentrique dit par le serveur, UTC, 1er janvier de l’année, année dans la plage', () => {
    expect(validOrbit(orbit(2026), 2026, RANGE)).toBe(true)
    expect(validOrbit(orbit(2026, { frame: 'ICRF geocentric' }), 2026, RANGE)).toBe(false)
    expect(validOrbit(orbit(2026, { frame: 'heliocentric' }), 2026, RANGE)).toBe(false)
    expect(validOrbit(orbit(2026, { timeScale: 'TDB' }), 2026, RANGE)).toBe(false)
    expect(validOrbit(orbit(2026, { start: yearStartSeconds(2026) + 100 * DAY }), 2026, RANGE)).toBe(false) // l'ancienne ancre du mois
    expect(validOrbit(orbit(2031), 2031, RANGE)).toBe(false)
    expect(validOrbit(orbit(2026), 2027, RANGE)).toBe(false)
    expect(validOrbit(orbit(2026, { positions: [] }), 2026, RANGE)).toBe(false)
    expect(validOrbit(orbitFromResponse({ frame: 'ICRF heliocentric', time_scale: 'UTC', year: 2026, start: 1, stop: 2, positions: null }), 2026, RANGE)).toBe(false)
  })

  it('orientation : époque = 1er janvier de l’année, vecteurs et taux finis', () => {
    expect(validOrientation(orientation(2026), 2026, RANGE)).toBe(true)
    expect(validOrientation(orientation(2026, { epoch: Date.UTC(2026, 10, 1) / 1000 }), 2026, RANGE)).toBe(false) // l'ancienne ancre du mois
    expect(validOrientation(orientation(2026, { rateDegPerDay: null }), 2026, RANGE)).toBe(false)
    expect(validOrientation(orientation(2026, { pole: null }), 2026, RANGE)).toBe(false)
    expect(validOrientation(orientation(2026, { primeMeridian: [1, NaN, 0] }), 2026, RANGE)).toBe(false)
    expect(validOrientation(orientation(2026, { frame: 'ICRF geocentric' }), 2026, RANGE)).toBe(false)
    expect(validOrientation(orientation(2031), 2031, RANGE)).toBe(false)
    expect(validOrientation(orientation(2026), 2027, RANGE)).toBe(false)
  })

  it('une réponse sans pôle ne donne pas d’enregistrement', () => {
    const res = { frame: 'ICRF', year: 2026, epoch: 1, bodies: [{ id: 'moon', pole: null, prime_meridian: null, rotation_deg_per_day: null }] }
    expect(orientationFromResponse(res, 'moon')).toBeNull()
  })
})

describe('ordre de chargement', () => {
  it('Y−1 … Y+4, l’année courante d’abord puis en s’éloignant (le futur d’abord à distance égale)', () => {
    expect(RANGE).toEqual({ minYear: 2025, maxYear: 2030 })
    expect(yearsByDistance(2026, RANGE)).toEqual([2026, 2027, 2025, 2028, 2029, 2030])
  })

  it('le Soleil (6 tranches) d’abord, puis l’année courante de la Lune et des planètes, puis les autres', () => {
    const jobs = loadPlan(2026, ['moon', 'mercury', 'venus'])
    expect(jobs).toHaveLength(6 + 6 * 3)
    expect(jobs.slice(0, 6).map((j) => j.body)).toEqual(Array(6).fill('sun'))
    expect(jobs.slice(0, 6).map((j) => j.year)).toEqual([2026, 2027, 2025, 2028, 2029, 2030])
    expect(jobs.slice(6, 9)).toEqual([
      { body: 'moon', year: 2026 },
      { body: 'mercury', year: 2026 },
      { body: 'venus', year: 2026 },
    ])
    expect(jobs.slice(9, 12).map((j) => j.year)).toEqual([2027, 2027, 2027])
    // Aucune tranche demandée deux fois.
    expect(new Set(jobs.map((j) => `${j.body}:${j.year}`)).size).toBe(jobs.length)
  })

  it('runJobs : un échec isolé n’arrête rien, trois de suite arrêtent', async () => {
    const seen = []
    const failing = new Set(['b', 'd', 'e', 'f'])
    const finished = await runJobs(['a', 'b', 'c', 'd', 'e', 'f', 'g'], async (job) => {
      seen.push(job)
      return !failing.has(job)
    })
    expect(MAX_CONSECUTIVE_FAILURES).toBe(3)
    expect(finished).toBe(false)
    expect(seen).toEqual(['a', 'b', 'c', 'd', 'e', 'f']) // g n'est pas demandé
    expect(await runJobs(['a', 'b'], async () => true)).toBe(true)
  })

  it('année chargée la plus proche (l’antérieure à égalité) — l’orientation', () => {
    expect(nearestYear([2025, 2028], 2027)).toBe(2028)
    expect(nearestYear([2026, 2028], 2027)).toBe(2026)
    expect(nearestYear([2026], 2030)).toBe(2026)
    expect(nearestYear([], 2026)).toBeNull()
    expect(nearestYear(new Map([[2029, 1]]).keys(), 2026)).toBe(2029)
  })
})

describe('nettoyage du localStorage au démarrage', () => {
  it('efface les tranches hors plage (de toute sorte) et les anciennes clés, rien d’autre', () => {
    const keys = [
      'positions-sun-2024', 'positions-sun-2025', 'positions-mars-2030', 'positions-mars-2031',
      'orbit-venus-2024', 'orbit-venus-2026', 'orientation-moon-2031', 'orientation-moon-2027',
      ...LEGACY_KEYS,
      'tracked', 'iss', 'neo', 'apod', 'neo-details', 'neo-positions', 'moons', 'moons-shown',
    ]
    expect(staleKeys(keys, WALL).sort()).toEqual(
      ['positions-sun-2024', 'positions-mars-2031', 'orbit-venus-2024', 'orientation-moon-2031', ...LEGACY_KEYS].sort(),
    )
  })

  it('les anciennes clés sont exactement celles du contrat', () => {
    expect([...LEGACY_KEYS]).toEqual(['solar-system', 'solar-system-orbits', 'solar-system-orientation', 'sun', 'moon'])
  })

  it('la plage suit l’horloge murale : au 1er janvier, l’année d’avant-hier sort', () => {
    expect(staleKeys(['positions-sun-2025'], Date.UTC(2026, 11, 31, 23, 59))).toEqual([])
    expect(staleKeys(['positions-sun-2025'], Date.UTC(2027, 0, 1))).toEqual(['positions-sun-2025'])
  })
})
