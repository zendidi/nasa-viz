import { describe, expect, it } from 'vitest'
import { upstreamErrorMessage } from '../src/api.js'

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
