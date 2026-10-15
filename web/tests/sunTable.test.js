import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'

import { createSunTable } from '../src/sunTable.js'

// Ce qui est épinglé ici : les conventions que l'œil ne voit pas. Une table
// ICRF [x, y, z] devient des axes de scène (x, z, -y) -- un signe ou un axe
// permuté donnerait un Soleil au mauvais endroit mais plausible. Le repli sur
// la série basse précision doit rester ~1 UA, pas l'origine.

const NOW = Date.UTC(2026, 9, 15, 12) // 2026-10-15T12:00Z
const STEP = 86_400
const DAYS = 60

/** Table de 60 jours démarrant 10 jours avant NOW ; valeurs distinctes sur chaque axe. */
function makeRecord(overrides = {}) {
  return {
    start: NOW / 1000 - 10 * STEP,
    stepSeconds: STEP,
    positions: Array.from({ length: DAYS }, (_, i) => [1.0e8 + 1.0e5 * i, 2.0e7 + 3.0e4 * i, 5.0e6 - 1.0e4 * i]),
    ...overrides,
  }
}

function stubStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  globalThis.localStorage = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, String(v)) }
  return map
}

function seed(record) {
  return { 'nasa-viz:sun': JSON.stringify({ data: record, fetchedAt: NOW }) }
}

const make = (on = { changed: vi.fn() }) => createSunTable({ on })

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  delete globalThis.localStorage
})

describe('createSunTable — table en cache', () => {
  it('known est vrai quand le cache couvre « maintenant »', () => {
    stubStorage(seed(makeRecord()))
    expect(make().known).toBe(true)
  })

  it('aux instants d’échantillon, rend l’échantillon exact en axes de scène (x, z, -y)', () => {
    const record = makeRecord()
    stubStorage(seed(record))
    const sun = make()
    for (const i of [0, 10, 30, DAYS - 1]) {
      const [x, y, z] = record.positions[i]
      const p = sun.positionKmAt(new Date((record.start + i * STEP) * 1000), new THREE.Vector3())
      expect(p.x).toBeCloseTo(x, 3)
      expect(p.y).toBeCloseTo(z, 3) // pôle céleste nord -> +Y
      expect(p.z).toBeCloseTo(-y, 3) // ICRF +Y -> scène -Z
    }
  })

  it('entre deux échantillons, reste entre eux sur une série monotone', () => {
    const record = makeRecord()
    stubStorage(seed(record))
    const p = make().positionKmAt(new Date((record.start + 20.5 * STEP) * 1000), new THREE.Vector3())
    expect(p.x).toBeGreaterThan(record.positions[20][0])
    expect(p.x).toBeLessThan(record.positions[21][0])
  })

  it('hors fenêtre de la table, retombe sur la série (~1 UA), pas sur l’origine ni sur la table', () => {
    stubStorage(seed(makeRecord()))
    const sun = make()
    const before = sun.positionKmAt(new Date(NOW - 30 * 86_400_000), new THREE.Vector3())
    const after = sun.positionKmAt(new Date(NOW + 200 * 86_400_000), new THREE.Vector3())
    for (const p of [before, after]) {
      expect(p.length()).toBeGreaterThan(1.46e8)
      expect(p.length()).toBeLessThan(1.53e8)
    }
  })

  it('earthOrbitSamplesKm : Soleil nié, (n-1)*8+1 points, passe par chaque échantillon nié', () => {
    const record = makeRecord()
    stubStorage(seed(record))
    const orbit = make().earthOrbitSamplesKm()
    expect(orbit).toHaveLength((DAYS - 1) * 8 + 1)
    for (const i of [0, 10]) {
      const [x, y, z] = record.positions[i]
      const p = orbit[i * 8]
      expect(p.x).toBeCloseTo(-x, 3)
      expect(p.y).toBeCloseTo(-z, 3)
      expect(p.z).toBeCloseTo(y, 3)
    }
  })
})

describe('createSunTable — sans table utilisable', () => {
  it('cache vide : known faux, earthOrbitSamplesKm null, position = série (~1 UA)', () => {
    stubStorage()
    const sun = make()
    expect(sun.known).toBe(false)
    expect(sun.earthOrbitSamplesKm()).toBeNull()
    const len = sun.positionKmAt(new Date(NOW), new THREE.Vector3()).length()
    expect(len).toBeGreaterThan(1.46e8)
    expect(len).toBeLessThan(1.53e8)
  })

  it('cache expiré, trop proche de sa fin (marge 30 j) ou pas commencé : ignoré', () => {
    stubStorage(seed(makeRecord({ start: NOW / 1000 - 100 * STEP }))) // finie depuis 41 j
    expect(make().known).toBe(false)
    stubStorage(seed(makeRecord({ start: NOW / 1000 - 40 * STEP }))) // fin dans 19 j < 30 j
    expect(make().known).toBe(false)
    stubStorage(seed(makeRecord({ start: NOW / 1000 + STEP }))) // commence demain
    expect(make().known).toBe(false)
  })

  it('cache sans positions : ignoré', () => {
    stubStorage(seed(makeRecord({ positions: [] })))
    expect(make().known).toBe(false)
  })
})

describe('createSunTable — load', () => {
  const served = (record) => ({
    ok: true,
    json: async () => ({ start: record.start, step_seconds: STEP, bodies: [{ positions: record.positions }] }),
  })

  it('récupère la table, la met en cache et prévient on.changed', async () => {
    const map = stubStorage()
    vi.stubGlobal('fetch', async () => served(makeRecord()))
    const on = { changed: vi.fn() }
    const sun = make(on)
    await sun.load()
    expect(sun.known).toBe(true)
    expect(on.changed).toHaveBeenCalledTimes(1)
    expect(JSON.parse(map.get('nasa-viz:sun')).data.stepSeconds).toBe(STEP)
  })

  it('échec réseau : silencieux, known reste faux, on.changed non appelé', async () => {
    stubStorage()
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline')
    })
    const on = { changed: vi.fn() }
    const sun = make(on)
    await expect(sun.load()).resolves.toBeUndefined()
    expect(sun.known).toBe(false)
    expect(on.changed).not.toHaveBeenCalled()
  })

  it('réponse qui ne couvre pas « maintenant » : rejetée, rien en cache', async () => {
    const map = stubStorage()
    vi.stubGlobal('fetch', async () => served(makeRecord({ start: NOW / 1000 - 200 * STEP })))
    const sun = make()
    await sun.load()
    expect(sun.known).toBe(false)
    expect(map.has('nasa-viz:sun')).toBe(false)
  })
})
