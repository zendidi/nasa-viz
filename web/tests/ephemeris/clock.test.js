import { describe, expect, it } from 'vitest'

import { CLOCK_RATES, HISTORY_MONTHS, RATE_STOPS, createClock, defaultMaxMs, defaultMinMs } from '../../src/ephemeris/clock.js'

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

describe('marche arrière et pause (2026-10-27)', () => {
  it('une vitesse négative fait reculer le temps, sans saut au changement', () => {
    const clock = createClock({ wallMs: T0 })
    clock.setRate(-DAY_PER_SECOND, T0)
    expect(clock.nowMs(T0 + 2000)).toBe(T0 - 2 * 86_400_000)
    clock.setRate(DAY_PER_SECOND, T0 + 2000)
    expect(clock.nowMs(T0 + 2000)).toBe(T0 - 2 * 86_400_000)
  })

  it('s\'arrête à la butée basse en marche arrière, et le dit', () => {
    const minMs = T0 - 3 * 86_400_000
    const clock = createClock({ wallMs: T0, minMs })
    clock.setRate(-DAY_PER_SECOND, T0)
    expect(clock.atLimit(T0 + 2000)).toBe(false)
    for (const wall of [T0 + 3000, T0 + 10_000]) {
      expect(clock.nowMs(wall)).toBe(minMs)
      expect(clock.atLimit(wall)).toBe(true)
    }
  })

  it('la pause fige le temps, sans se dire en butée', () => {
    const clock = createClock({ wallMs: T0 })
    clock.setRate(DAY_PER_SECOND, T0)
    clock.setRate(0, T0 + 1000)
    expect(clock.nowMs(T0 + 60_000)).toBe(T0 + 86_400_000)
    expect(clock.atLimit(T0 + 60_000)).toBe(false)
    expect(clock.isRealTime()).toBe(false)
  })

  // Le « Maintenant » est un reset dur : la course précédente ne doit rien
  // laisser derrière elle. Réaccélérer repart de l'heure murale, pas de la date
  // où l'on s'était arrêté.
  it('après Maintenant, réaccélérer repart de maintenant', () => {
    const clock = createClock({ wallMs: T0 })
    clock.setRate(DAY_PER_SECOND, T0)
    clock.reset(T0 + 10_000) // la course était arrivée à +10 jours
    clock.setRate(DAY_PER_SECOND, T0 + 11_000)
    expect(clock.nowMs(T0 + 12_000)).toBe(T0 + 11_000 + 86_400_000)
  })

  it('les crans du slider : symétriques autour de la pause, ×1 et les deux vitesses historiques inclus', () => {
    const pause = RATE_STOPS.indexOf(0)
    expect(pause).toBeGreaterThan(0)
    expect(RATE_STOPS[pause + 1]).toBe(CLOCK_RATES.REAL)
    expect(RATE_STOPS).toContain(HOUR_PER_SECOND)
    expect(RATE_STOPS).toContain(DAY_PER_SECOND)
    for (let i = 1; i < RATE_STOPS.length; i++) expect(RATE_STOPS[i]).toBeGreaterThan(RATE_STOPS[i - 1])
    for (const rate of RATE_STOPS) if (rate > 1) expect(RATE_STOPS).toContain(-rate)
  })
})

describe('defaultMinMs', () => {
  it('= 3 mois avant le 1er du mois UTC, là où commencent les tables de positions', () => {
    expect(HISTORY_MONTHS).toBe(3)
    expect(defaultMinMs(Date.UTC(2026, 9, 31, 23, 59))).toBe(Date.UTC(2026, 6, 1))
  })

  // Janvier − 3 mois doit tomber en octobre de l'année d'avant, pas sur un mois −2.
  it('passe correctement le changement d\'année', () => {
    expect(defaultMinMs(Date.UTC(2027, 0, 15))).toBe(Date.UTC(2026, 9, 1))
  })
})

describe('defaultMaxMs', () => {
  it('= le 1er du mois UTC + 365 jours, quel que soit le jour du mois', () => {
    const expected = Date.UTC(2026, 9, 1) + 365 * 86_400_000
    expect(defaultMaxMs(Date.UTC(2026, 9, 1))).toBe(expected)
    expect(defaultMaxMs(Date.UTC(2026, 9, 31, 23, 59))).toBe(expected)
  })
})

describe('jumpTo', () => {
  // Épinglé : « aller au prochain rapprochement » règle l'horloge sur un instant
  // sans toucher à la vitesse, et reste dans la plage des tables.
  it('rend exactement l\'instant visé, puis continue à la même vitesse', () => {
    const clock = createClock({ wallMs: T0 })
    clock.setRate(HOUR_PER_SECOND, T0)
    const target = T0 + 20 * 86_400_000
    clock.jumpTo(target, T0 + 4000)
    expect(clock.nowMs(T0 + 4000)).toBe(target)
    expect(clock.nowMs(T0 + 6000)).toBe(target + 2 * 3_600_000)
    expect(clock.rate).toBe(HOUR_PER_SECOND)
  })

  it('est borné par la plage de l\'horloge, des deux côtés', () => {
    const clock = createClock({ wallMs: T0, minMs: T0 - 1000, maxMs: T0 + 1000 })
    clock.setRate(HOUR_PER_SECOND, T0)
    clock.jumpTo(T0 + 5_000_000, T0)
    expect(clock.nowMs(T0)).toBe(T0 + 1000)
    clock.jumpTo(T0 - 5_000_000, T0)
    expect(clock.nowMs(T0)).toBe(T0 - 1000)
  })

  it('à l\'arrêt (vitesse 0), le saut tient', () => {
    const clock = createClock({ wallMs: T0 })
    clock.setRate(0, T0)
    clock.jumpTo(T0 + 123_456, T0 + 10)
    expect(clock.nowMs(T0 + 99_999)).toBe(T0 + 123_456)
  })

  it('au ×1, un saut quitte le temps réel (l\'ISS n\'est plus valide)', () => {
    const clock = createClock({ wallMs: T0 })
    clock.jumpTo(T0 + 86_400_000, T0)
    expect(clock.isRealTime()).toBe(false)
  })
})
