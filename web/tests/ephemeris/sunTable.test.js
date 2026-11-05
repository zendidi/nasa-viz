import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'

import { createMoonTable, createSunTable, orbitWindowIndices } from '../../src/ephemeris/sunTable.js'
import { yearStartSeconds } from '../../src/ephemeris/slices.js'
import { positionAtSeconds, servedResponse, sliceRecord } from './sliceFixtures.js'

// Ce qui est épinglé ici : les conventions que l'œil ne voit pas. Une table
// ICRF [x, y, z] devient des axes de scène (x, z, -y) -- un signe ou un axe
// permuté donnerait un Soleil au mauvais endroit mais plausible. Le repli sur
// la série basse précision doit rester ~1 UA, pas l'origine. Depuis le 2026-11-05
// (lot 3) la table est assemblée de tranches annuelles : une tranche refusée ou
// absente ne doit jamais laisser passer une table trouée.

const NOW = Date.UTC(2026, 9, 15, 12) // 2026-10-15T12:00Z : tranches 2025 … 2030
const STEP = 86_400

function stubStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  globalThis.localStorage = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, String(v)) }
  return map
}

/** Les tranches `years` d'un corps, sous les clés que le viewer écrit. */
function seed(id, years, overrides = {}) {
  return Object.fromEntries(
    years.map((year) => [`nasa-viz:positions-${id}-${year}`, JSON.stringify({ data: sliceRecord(year, STEP, overrides), fetchedAt: NOW })]),
  )
}

const YEARS = [2025, 2026, 2027, 2028, 2029, 2030]
const make = (on = { changed: vi.fn() }) => createSunTable({ on })

/** Un fetch qui sert la tranche demandée par `?year=` ; garde les URL appelées. */
function stubServer(urls = [], { fail = () => false, tweak = (res) => res } = {}) {
  vi.stubGlobal('fetch', async (url) => {
    urls.push(url)
    const params = new URLSearchParams(url.split('?')[1])
    const year = Number(params.get('year'))
    if (fail(year)) throw new Error('offline')
    return { ok: true, json: async () => tweak(servedResponse(year, STEP, params.get('body'))) }
  })
  return urls
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  delete globalThis.localStorage
})

describe('createSunTable — tranches en cache', () => {
  it('known est vrai dès que la tranche de l’année courante est là', () => {
    stubStorage(seed('sun', [2026]))
    expect(make().known).toBe(true)
  })

  it('aux instants d’échantillon, rend l’échantillon exact en axes de scène (x, z, -y), couture du 1er janvier comprise', () => {
    stubStorage(seed('sun', YEARS))
    const sun = make()
    for (const seconds of [yearStartSeconds(2026), yearStartSeconds(2027) - STEP, yearStartSeconds(2027), yearStartSeconds(2027) + STEP, yearStartSeconds(2028)]) {
      const [x, y, z] = positionAtSeconds(seconds)
      const p = sun.positionKmAt(new Date(seconds * 1000), new THREE.Vector3())
      expect(p.x).toBeCloseTo(x, 3)
      expect(p.y).toBeCloseTo(z, 3) // pôle céleste nord -> +Y
      expect(p.z).toBeCloseTo(-y, 3) // ICRF +Y -> scène -Z
    }
  })

  it('startMs / endMs = la table assemblée, recouvrements extérieurs compris (les bornes de l’horloge)', () => {
    stubStorage(seed('sun', YEARS))
    const sun = make()
    expect(sun.startMs).toBe((yearStartSeconds(2025) - 2 * STEP) * 1000)
    expect(sun.endMs).toBe((yearStartSeconds(2031) + 2 * STEP) * 1000)
  })

  it('une seule année chargée : la couverture n’est que celle-là ; hors d’elle, retombe sur la série (~1 UA)', () => {
    stubStorage(seed('sun', [2026]))
    const sun = make()
    expect(sun.startMs).toBe((yearStartSeconds(2026) - 2 * STEP) * 1000)
    const next = sun.positionKmAt(new Date(Date.UTC(2027, 5, 1)), new THREE.Vector3())
    expect(next.length()).toBeGreaterThan(1.46e8)
    expect(next.length()).toBeLessThan(1.53e8)
  })

  it('un trou coupe : sans 2027, l’année 2028 chargée ne prolonge pas la table', () => {
    stubStorage(seed('sun', [2025, 2026, 2028, 2029]))
    const sun = make()
    expect(sun.endMs).toBe((yearStartSeconds(2027) + 2 * STEP) * 1000)
  })

  it('la table est le même objet tant qu’aucune tranche n’arrive', () => {
    stubStorage(seed('sun', YEARS))
    const sun = make()
    expect(sun.assembled).toBe(sun.assembled)
  })

  it('earthOrbitSamplesKm : Soleil nié, une année sidérale à (n-1)*8+1 points, passe par chaque échantillon nié', () => {
    stubStorage(seed('sun', YEARS))
    const sun = make()
    const orbit = sun.earthOrbitSamplesKm()
    const table = sun.assembled
    const { from, to } = orbitWindowIndices(table.start, table.stepSeconds, table.positions.length, NOW)
    expect(orbit).toHaveLength((to - from) * 8 + 1)
    for (const i of [0, 10]) {
      const [x, y, z] = table.positions[from + i]
      const p = orbit[i * 8]
      expect(p.x).toBeCloseTo(-x, 3)
      expect(p.y).toBeCloseTo(-z, 3)
      expect(p.z).toBeCloseTo(y, 3)
    }
  })
})

describe('createSunTable — sans tranche utilisable', () => {
  it('cache vide : known faux, earthOrbitSamplesKm null, position = série (~1 UA), état « loading »', () => {
    stubStorage()
    const sun = make()
    expect(sun.known).toBe(false)
    expect(sun.assembled).toBeNull()
    expect(sun.startMs).toBeNull()
    expect(sun.endMs).toBeNull()
    expect(sun.earthOrbitSamplesKm()).toBeNull()
    expect(sun.state).toEqual({ status: 'loading', error: null })
    const len = sun.positionKmAt(new Date(NOW), new THREE.Vector3()).length()
    expect(len).toBeGreaterThan(1.46e8)
    expect(len).toBeLessThan(1.53e8)
  })

  it('tranches sans l’année courante : pas de table (on ne devine pas à travers un trou)', () => {
    stubStorage(seed('sun', [2025, 2027, 2028]))
    expect(make().known).toBe(false)
  })

  it('tranche hors de [Y−1, Y+4] : ignorée', () => {
    stubStorage({ ...seed('sun', [2024, 2031]), ...seed('sun', [2026]) })
    const sun = make()
    expect(sun.startMs).toBe((yearStartSeconds(2026) - 2 * STEP) * 1000)
    expect(sun.endMs).toBe((yearStartSeconds(2027) + 2 * STEP) * 1000)
  })

  // Avant le 2026-10-21 le backend servait du TDB, lu comme de l'UTC : 69 s de
  // retard, ~2 000 km. Une tranche stockée dans une autre échelle doit être refusée.
  it('tranche sans timeScale UTC, ou d’un autre repère, ou tronquée : ignorée', () => {
    stubStorage(seed('sun', [2026], { timeScale: 'TDB' }))
    expect(make().known).toBe(false)
    stubStorage(seed('sun', [2026], { timeScale: undefined }))
    expect(make().known).toBe(false)
    stubStorage(seed('sun', [2026], { frame: 'ICRF heliocentric' }))
    expect(make().known).toBe(false)
    stubStorage(seed('sun', [2026], { positions: sliceRecord(2026, STEP).positions.slice(0, 100) }))
    expect(make().known).toBe(false)
    stubStorage(seed('sun', [2026], { positions: [] }))
    expect(make().known).toBe(false)
  })

  it('l’ancienne clé « sun » d’une seule table n’est plus lue', () => {
    stubStorage({ 'nasa-viz:sun': JSON.stringify({ data: sliceRecord(2026, STEP), fetchedAt: NOW }) })
    expect(make().known).toBe(false)
  })
})

describe('createSunTable — loadYear', () => {
  it('récupère la tranche demandée (?body=sun&year=), la met en cache sous sa clé et prévient on.changed', async () => {
    const map = stubStorage()
    const urls = stubServer()
    const on = { changed: vi.fn() }
    const sun = make(on)
    await expect(sun.loadYear(2026)).resolves.toBe(true)
    expect(sun.known).toBe(true)
    expect(sun.state).toEqual({ status: 'ready', error: null })
    expect(on.changed).toHaveBeenCalledTimes(1)
    expect(urls).toEqual(['/api/solar-system/positions?body=sun&year=2026'])
    expect(JSON.parse(map.get('nasa-viz:positions-sun-2026')).data).toMatchObject({ year: 2026, stepSeconds: STEP, timeScale: 'UTC' })
    expect(map.size).toBe(1)
  })

  it('une année déjà en main n’est pas redemandée', async () => {
    stubStorage(seed('sun', [2026]))
    const urls = stubServer()
    const on = { changed: vi.fn() }
    await expect(make(on).loadYear(2026)).resolves.toBe(true)
    expect(urls).toEqual([])
    expect(on.changed).not.toHaveBeenCalled()
  })

  it('deux demandes de la même année partagent une requête', async () => {
    stubStorage()
    const urls = stubServer()
    const sun = make()
    await Promise.all([sun.loadYear(2027), sun.loadYear(2027)])
    expect(urls).toHaveLength(1)
  })

  it('échec réseau : silencieux, known reste faux, on.changed non appelé, l’état dit pourquoi', async () => {
    const map = stubStorage()
    stubServer([], { fail: () => true })
    const on = { changed: vi.fn() }
    const sun = make(on)
    await expect(sun.loadYear(2026)).resolves.toBe(false)
    expect(sun.known).toBe(false)
    expect(on.changed).not.toHaveBeenCalled()
    expect(sun.state.status).toBe('error')
    expect(sun.state.error).toContain('offline')
    expect(map.size).toBe(0)
  })

  it('réponse refusée (TDB, mauvaise année servie, table vide) : rien en cache, pas de table', async () => {
    const map = stubStorage()
    const sun = make()
    stubServer([], { tweak: (res) => ({ ...res, time_scale: 'TDB' }) })
    await expect(sun.loadYear(2026)).resolves.toBe(false)
    stubServer([], { tweak: (res) => ({ ...res, year: 2027 }) })
    await expect(sun.loadYear(2026)).resolves.toBe(false)
    stubServer([], { tweak: (res) => ({ ...res, bodies: [{ ...res.bodies[0], positions: null }] }) })
    await expect(sun.loadYear(2026)).resolves.toBe(false)
    expect(sun.known).toBe(false)
    expect(map.size).toBe(0)
  })

  it('une année qui arrive prolonge la table (le même instant, le même résultat) et change son identité', async () => {
    stubStorage(seed('sun', [2026]))
    stubServer()
    const sun = make()
    const before = sun.assembled
    const at = new Date(Date.UTC(2026, 5, 1))
    const p1 = sun.positionKmAt(at, new THREE.Vector3())
    await sun.loadYear(2027)
    expect(sun.assembled).not.toBe(before)
    expect(sun.endMs).toBe((yearStartSeconds(2028) + 2 * STEP) * 1000)
    expect(sun.positionKmAt(at, new THREE.Vector3()).distanceTo(p1)).toBeLessThan(1e-6)
  })

  it('retry : les années manquantes, la courante d’abord puis en s’éloignant', async () => {
    stubStorage(seed('sun', [2027]))
    const urls = stubServer()
    const sun = make()
    await sun.retry()
    expect(urls.map((u) => Number(new URLSearchParams(u.split('?')[1]).get('year')))).toEqual([2026, 2025, 2028, 2029, 2030])
    expect(sun.missingYears()).toEqual([])
  })

  it('retry s’arrête quand le serveur est tombé (3 échecs de suite)', async () => {
    stubStorage()
    const urls = stubServer([], { fail: () => true })
    await make().retry()
    expect(urls).toHaveLength(3)
  })
})

describe('createMoonTable', () => {
  it('ses propres clés de cache, et un repli sur la série lunaire (~384 000 km), pas solaire', () => {
    stubStorage(seed('sun', YEARS)) // des tranches *Soleil* en cache ne doivent pas servir la Lune
    const moon = createMoonTable({ on: { changed: vi.fn() } })
    expect(moon.known).toBe(false)
    const len = moon.positionKmAt(new Date(NOW), new THREE.Vector3()).length()
    expect(len).toBeGreaterThan(356_000)
    expect(len).toBeLessThan(407_000)
  })

  it('demande ?body=moon et range sous nasa-viz:positions-moon-<année>', async () => {
    const map = stubStorage()
    const urls = stubServer()
    const moon = createMoonTable({ on: { changed: vi.fn() } })
    await moon.loadYear(2026)
    expect(moon.known).toBe(true)
    expect(urls[0]).toContain('body=moon')
    expect(map.has('nasa-viz:positions-moon-2026')).toBe(true)
  })
})

describe('orbitWindowIndices — une année sidérale centrée, dans la table', () => {
  const COUNT = 460 // ~15 mois de pas quotidiens
  const start = Date.UTC(2026, 6, 1) / 1000
  const win = (centerDays) => orbitWindowIndices(start, STEP, COUNT, start * 1000 + centerDays * 86_400_000)

  it('au plus une année sidérale, contient l’instant, reste dans la table', () => {
    for (const d of [-50, 0, 100, 230, 300, 459, 600]) {
      const { from, to } = win(d)
      expect(to - from).toBeLessThanOrEqual(365.256)
      expect(to - from).toBe(365)
      expect(from).toBeGreaterThanOrEqual(0)
      expect(to).toBeLessThanOrEqual(COUNT - 1)
      if (d >= 0 && d <= COUNT - 1) {
        expect(from).toBeLessThanOrEqual(d)
        expect(to).toBeGreaterThanOrEqual(d)
      }
    }
  })

  it('centrée quand la table le permet, décalée (pas rognée) quand elle déborde', () => {
    const mid = win(230)
    expect(Math.abs(mid.from + mid.to - 460)).toBeLessThanOrEqual(1)
    expect(win(10)).toEqual({ from: 0, to: 365 })
    expect(win(455)).toEqual({ from: COUNT - 1 - 365, to: COUNT - 1 })
  })

  it('table plus courte qu’une année : toute la table', () => {
    expect(orbitWindowIndices(start, STEP, 160, start * 1000)).toEqual({ from: 0, to: 159 })
  })
})
