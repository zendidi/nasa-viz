import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchSmallBodyPositions, searchSmallBody, upstreamErrorMessage } from '../src/api.js'

describe('upstreamErrorMessage', () => {
  it('names the provider the backend says is down', () => {
    expect(upstreamErrorMessage({ error: 'upstream data source unavailable, please retry shortly', source: 'JPL Horizons' }, 502))
      .toBe("JPL Horizons est en panne : impossible d'obtenir les données pour l'instant.")
  })

  it('falls back to the raw error when no source is given (a 400, an older backend)', () => {
    expect(upstreamErrorMessage({ error: 'spkid must be exactly one SPK-ID' }, 400)).toBe('spkid must be exactly one SPK-ID')
  })

  it('falls back to the status when the body is not JSON', () => {
    expect(upstreamErrorMessage({}, 504)).toBe('request failed: 504')
  })
})

describe('small-body routes', () => {
  // Épinglé : une table sur une autre horloge que l'UTC décalerait l'objet de 69 s
  // (~2 000 km sur la table d'un NEO) sans que rien ne le dise à l'écran.
  afterEach(() => vi.unstubAllGlobals())

  const answer = (body, status = 200) => vi.fn(async () => ({ ok: status < 400, status, json: async () => body }))

  it('accepte une table en UTC et appelle la bonne route, un SPK-ID par appel', async () => {
    const fetch = answer({ time_scale: 'UTC', objects: { 20099942: null } })
    vi.stubGlobal('fetch', fetch)
    await expect(fetchSmallBodyPositions('20099942')).resolves.toMatchObject({ time_scale: 'UTC' })
    expect(fetch).toHaveBeenCalledWith('/api/small-body/positions?spkid=20099942')
  })

  it('refuse une table qui n’est pas en UTC, ou qui ne le dit pas', async () => {
    vi.stubGlobal('fetch', answer({ time_scale: 'TDB', objects: {} }))
    await expect(fetchSmallBodyPositions('20099942')).rejects.toThrow(/TDB/)
    vi.stubGlobal('fetch', answer({ objects: {} }))
    await expect(fetchSmallBodyPositions('20099942')).rejects.toThrow(/absente/)
  })

  it('encode la requête de recherche', async () => {
    const fetch = answer({ match: null })
    vi.stubGlobal('fetch', fetch)
    await searchSmallBody('2004 MN4')
    expect(fetch).toHaveBeenCalledWith('/api/small-body/search?q=2004+MN4')
  })

  it('une panne remonte avec le nom de la source', async () => {
    vi.stubGlobal('fetch', answer({ error: 'x', source: 'JPL SBDB' }, 502))
    await expect(searchSmallBody('Apophis')).rejects.toThrow('JPL SBDB est en panne')
  })
})
