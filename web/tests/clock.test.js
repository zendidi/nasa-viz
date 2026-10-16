import { describe, expect, it } from 'vitest'

import { CLOCK_RATES, createClock, defaultMaxMs } from '../src/clock.js'

// Ce qui est épinglé ici : les invariants que l'œil ne voit pas au moment où ils
// cassent. Un changement de vitesse qui fait sauter le temps, c'est une planète
// qui saute d'un degré sans que rien ne l'explique ; une butée qui boucle, c'est
// une scène qui repart au 1er du mois sans prévenir ; un « ×1 » qui dérive de
// quelques ms, c'est une horloge « temps réel » qui n'en est plus une (et l'ISS,
// qui n'est valide qu'en temps réel, resterait masquée à tort).

const T0 = Date.UTC(2026, 9, 16, 12) // 2026-10-16T12:00Z
const { HOUR_PER_SECOND, DAY_PER_SECOND } = CLOCK_RATES

describe('createClock', () => {
  it('au ×1 sans changement, rend exactement l\'heure murale', () => {
    const clock = createClock({ wallMs: T0 })
    for (const wall of [T0, T0 + 1, T0 + 16.6667, T0 + 86_400_000 * 40, T0 - 5]) {
      expect(clock.nowMs(wall)).toBe(wall)
    }
    expect(clock.isRealTime()).toBe(true)
  })

  it('changer de vitesse ne fait pas sauter le temps', () => {
    const clock = createClock({ wallMs: T0 })
    clock.setRate(DAY_PER_SECOND, T0 + 1000)
    const before = clock.nowMs(T0 + 5000)
    clock.setRate(HOUR_PER_SECOND, T0 + 5000)
    expect(clock.nowMs(T0 + 5000)).toBe(before)
    clock.setRate(CLOCK_RATES.REAL, T0 + 5000)
    expect(clock.nowMs(T0 + 5000)).toBe(before)
  })

  it('court à rate × le temps mural écoulé', () => {
    const clock = createClock({ wallMs: T0 })
    clock.setRate(DAY_PER_SECOND, T0)
    expect(clock.nowMs(T0 + 1000)).toBe(T0 + 86_400_000)
    clock.setRate(HOUR_PER_SECOND, T0 + 1000)
    expect(clock.nowMs(T0 + 3000)).toBe(T0 + 86_400_000 + 2 * 3_600_000)
  })

  it('revenir à ×1 après une accélération laisse un décalage : ce n\'est plus le temps réel', () => {
    const clock = createClock({ wallMs: T0 })
    clock.setRate(HOUR_PER_SECOND, T0)
    clock.setRate(CLOCK_RATES.REAL, T0 + 2000)
    expect(clock.isRealTime()).toBe(false)
    expect(clock.nowMs(T0 + 3000)).toBe(T0 + 2 * 3_600_000 + 1000)
  })

  it('s\'arrête à la butée haute, sans boucler, et le dit', () => {
    const maxMs = T0 + 10 * 86_400_000
    const clock = createClock({ wallMs: T0, maxMs })
    clock.setRate(DAY_PER_SECOND, T0)
    expect(clock.atLimit(T0 + 9000)).toBe(false)
    expect(clock.nowMs(T0 + 9000)).toBe(T0 + 9 * 86_400_000)
    for (const wall of [T0 + 10_000, T0 + 11_000, T0 + 1e9]) {
      expect(clock.nowMs(wall)).toBe(maxMs)
      expect(clock.atLimit(wall)).toBe(true)
    }
  })

  it('une horloge arrêtée en butée repart de la butée quand on change de vitesse', () => {
    const maxMs = T0 + 10 * 86_400_000
    const clock = createClock({ wallMs: T0, maxMs })
    clock.setRate(DAY_PER_SECOND, T0)
    clock.setRate(HOUR_PER_SECOND, T0 + 60_000) // la droite non bornée serait à +60 j
    expect(clock.nowMs(T0 + 60_000)).toBe(maxMs)
    expect(clock.nowMs(T0 + 70_000)).toBe(maxMs)
  })

  it('la borne basse tient aussi', () => {
    const clock = createClock({ wallMs: T0, minMs: T0 })
    clock.setRate(HOUR_PER_SECOND, T0)
    expect(clock.nowMs(T0 - 5000)).toBe(T0)
  })

  it('le temps réel n\'est jamais borné : les bornes ne concernent que l\'accéléré', () => {
    const clock = createClock({ wallMs: T0, maxMs: T0 + 1000 })
    expect(clock.nowMs(T0 + 5000)).toBe(T0 + 5000)
    expect(clock.atLimit(T0 + 5000)).toBe(false)
  })

  it('reset ramène à l\'heure murale, au ×1, hors butée', () => {
    const clock = createClock({ wallMs: T0, maxMs: T0 + 86_400_000 })
    clock.setRate(DAY_PER_SECOND, T0)
    expect(clock.atLimit(T0 + 5000)).toBe(true)
    clock.reset(T0 + 5000)
    expect(clock.rate).toBe(1)
    expect(clock.isRealTime()).toBe(true)
    expect(clock.atLimit(T0 + 6000)).toBe(false)
    expect(clock.nowMs(T0 + 6000)).toBe(T0 + 6000)
  })

  it('déplacer une borne ne fait pas sauter le temps', () => {
    const clock = createClock({ wallMs: T0, maxMs: T0 + 100 * 86_400_000 })
    clock.setRate(DAY_PER_SECOND, T0)
    const before = clock.nowMs(T0 + 3000)
    clock.setBounds(T0, T0 + 200 * 86_400_000, T0 + 3000)
    expect(clock.nowMs(T0 + 3000)).toBe(before)
    expect(clock.nowMs(T0 + 4000)).toBe(before + 86_400_000)
  })
})

describe('defaultMaxMs', () => {
  it('= le 1er du mois UTC + 365 jours, quel que soit le jour du mois', () => {
    const expected = Date.UTC(2026, 9, 1) + 365 * 86_400_000
    expect(defaultMaxMs(Date.UTC(2026, 9, 1))).toBe(expected)
    expect(defaultMaxMs(Date.UTC(2026, 9, 31, 23, 59))).toBe(expected)
  })
})
