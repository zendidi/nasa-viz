import { describe, expect, it } from 'vitest'

import { issAt } from '../src/iss.js'

// Ce qui est épinglé : qu'on place l'ISS à l'instant demandé et pas au dernier
// relevé (le défaut de l'audit du 2026-10-21), qu'on refuse de la placer hors
// de la trace plutôt que d'inventer, et le passage de l'antiméridien.

const T = 1_800_000_000
const track = [
  [T, 10, 170, 420],
  [T + 60, 13, 176, 421],
  [T + 120, 16, -178, 422],
]

describe('issAt', () => {
  it('rend l’échantillon exact à ses instants', () => {
    expect(issAt(track, T + 60)).toEqual({ latitude: 13, longitude: 176, altitude_km: 421 })
  })

  it('interpole entre deux échantillons, pas de saut au dernier relevé', () => {
    const p = issAt(track, T + 30)
    expect(p.latitude).toBeCloseTo(11.5, 9)
    expect(p.longitude).toBeCloseTo(173, 9)
  })

  it('passe l’antiméridien par le court chemin (176° → −178° = 6°, pas 354°)', () => {
    expect(issAt(track, T + 90).longitude).toBeCloseTo(179, 9)
    expect(issAt(track, T + 110).longitude).toBeCloseTo(-179, 9)
  })

  it('hors de la trace (relevé trop vieux, ou trace absente) : null, rien à dessiner', () => {
    expect(issAt(track, T - 1)).toBeNull()
    expect(issAt(track, T + 121)).toBeNull()
    expect(issAt(undefined, T)).toBeNull()
    expect(issAt([], T)).toBeNull()
  })
})
