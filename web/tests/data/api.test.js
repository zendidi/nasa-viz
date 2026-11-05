import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  REQUEST_TIMEOUT_MS,
  fetchPrecision,
  fetchTrajectory,
  fetchTrajectorySun,
  requestErrorMessage,
  searchSmallBody,
  upstreamErrorMessage,
} from '../../src/data/api.js'

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

  const withSignal = expect.objectContaining({ signal: expect.anything() })

  it('accepte une table en UTC et appelle la bonne route, un SPK-ID par appel', async () => {
    const fetch = answer({ time_scale: 'UTC', objects: { 20099942: null } })
    vi.stubGlobal('fetch', fetch)
    await expect(fetchTrajectory('20099942')).resolves.toMatchObject({ time_scale: 'UTC' })
    expect(fetch).toHaveBeenCalledWith('/api/small-body/trajectory?spkid=20099942', withSignal)
  })

  it('la tranche de précision demande son année, le Soleil sa route', async () => {
    const fetch = answer({ time_scale: 'UTC' })
    vi.stubGlobal('fetch', fetch)
    await fetchPrecision('20099942', 2029)
    await fetchTrajectorySun()
    expect(fetch).toHaveBeenNthCalledWith(1, '/api/small-body/precision?spkid=20099942&year=2029', withSignal)
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/small-body/trajectory/sun', withSignal)
  })

  it('refuse une table qui n’est pas en UTC, ou qui ne le dit pas — pour les trois routes', async () => {
    vi.stubGlobal('fetch', answer({ time_scale: 'TDB', objects: {} }))
    await expect(fetchTrajectory('20099942')).rejects.toThrow(/TDB/)
    await expect(fetchPrecision('20099942', 2029)).rejects.toThrow(/TDB/)
    await expect(fetchTrajectorySun()).rejects.toThrow(/TDB/)
    vi.stubGlobal('fetch', answer({ objects: {} }))
    await expect(fetchTrajectory('20099942')).rejects.toThrow(/absente/)
  })

  it('encode la requête de recherche', async () => {
    const fetch = answer({ match: null })
    vi.stubGlobal('fetch', fetch)
    await searchSmallBody('2004 MN4')
    expect(fetch).toHaveBeenCalledWith('/api/small-body/search?q=2004+MN4', withSignal)
  })

  it('une panne remonte avec le nom de la source', async () => {
    vi.stubGlobal('fetch', answer({ error: 'x', source: 'JPL SBDB' }, 502))
    await expect(searchSmallBody('Apophis')).rejects.toThrow('JPL SBDB est en panne')
  })
})

describe("délai d'expiration", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("45 s : 30 s de mur PHP plus la file d'un php -S mono-requête", () => {
    expect(REQUEST_TIMEOUT_MS).toBe(45_000)
  })

  it('une expiration (TimeoutError) a sa phrase, une autre erreur garde la sienne', () => {
    expect(requestErrorMessage(new DOMException('signal timed out', 'TimeoutError'))).toBe("Le serveur n'a pas répondu en 45 s.")
    expect(requestErrorMessage(new TypeError('Failed to fetch'))).toBe('Failed to fetch')
  })
  it("une requête qui expire remonte la phrase, pour que l'objet passe en erreur avec son bouton réessayer", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('signal timed out', 'TimeoutError') }))
    await expect(fetchTrajectorySun()).rejects.toThrow("Le serveur n'a pas répondu en 45 s.")
  })
})
