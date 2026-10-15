import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadCached, saveCached } from '../src/cache.js'

// cache.js est le chemin normal pour des données fraîches sans dépenser le
// quota NASA : il doit être best-effort -- ne jamais lever, quel que soit
// l'état du stockage (absent, plein, corrompu). Vitest tourne sous Node, donc
// localStorage est un faux Map posé sur globalThis.

function fakeStorage(overrides = {}) {
  const map = new Map()
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    ...overrides,
  }
}

beforeEach(() => {
  globalThis.localStorage = fakeStorage()
})

afterEach(() => {
  delete globalThis.localStorage
})

describe('cache', () => {
  it('rend ce qui a été sauvé, avec la date de récupération', () => {
    const before = Date.now()
    saveCached('neo', { a: [1, 2, 3] })
    const hit = loadCached('neo')
    expect(hit.data).toEqual({ a: [1, 2, 3] })
    expect(hit.fetchedAt).toBeGreaterThanOrEqual(before)
    expect(hit.fetchedAt).toBeLessThanOrEqual(Date.now())
  })

  it('préfixe la clé avec « nasa-viz: »', () => {
    saveCached('sun', 1)
    expect([...globalThis.localStorage.map.keys()]).toEqual(['nasa-viz:sun'])
  })

  it('rend null pour une clé absente', () => {
    expect(loadCached('jamais-sauvé')).toBeNull()
  })

  it('rend null pour un JSON corrompu', () => {
    globalThis.localStorage.map.set('nasa-viz:neo', '{pas du json')
    expect(loadCached('neo')).toBeNull()
  })

  it('sans localStorage : saveCached ne lève pas, loadCached rend null', () => {
    delete globalThis.localStorage
    expect(() => saveCached('neo', 1)).not.toThrow()
    expect(loadCached('neo')).toBeNull()
  })

  it('quota dépassé (setItem lève) : saveCached ne lève pas, loadCached rend null', () => {
    globalThis.localStorage = fakeStorage({
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    })
    expect(() => saveCached('neo', 1)).not.toThrow()
    expect(loadCached('neo')).toBeNull()
  })
})
