import { describe, expect, it } from 'vitest'

import { createCursor } from '../../src/tracking/cursor.js'

// Ce qui est épinglé : le décalage appartient au curseur et à lui seul. Changer la
// vitesse de l'horloge globale, ou la faire sauter, ne le touche pas (décision
// explicite de l'utilisateur, 2026-11-05 : le curseur ne lit même pas l'horloge, il reçoit T en argument) ; seul reset() le remet à zéro. Et à
// décalage nul T′ est T au bit près, c'est ce qui rend l'outil invisible tant qu'on
// n'y touche pas.

const DAY = 86_400
const BOUNDS = { minS: 1_000 * DAY, maxS: 3_000 * DAY }
const make = () => createCursor({ bounds: () => BOUNDS })
const NOW = 2_000 * DAY + 0.123456 // une heure de scène qui n'est pas ronde

describe('createCursor', () => {
  it('à décalage nul, T′ est T exactement — même hors des bornes de l\'outil', () => {
    const cursor = make()
    expect(cursor.tPrimeAt(NOW, 0)).toBe(NOW)
    expect(cursor.tPrimeAt(10, 0)).toBe(10)
    expect(cursor.offsetSeconds).toBe(0)
  })

  it('T′ = T + décalage, et le décalage survit à un changement de T', () => {
    const cursor = make()
    cursor.setTPrime(NOW + 100 * DAY, NOW, 0)
    expect(cursor.offsetSeconds).toBeCloseTo(100 * DAY, 6)
    // T avance (l'horloge tourne, ou saute) : le décalage ne bouge pas, T′ suit T.
    expect(cursor.tPrimeAt(NOW + 5 * DAY, 0)).toBeCloseTo(NOW + 105 * DAY, 6)
  })

  it('+1 h puis −1 h revient à zéro exactement, pas à 2e-7 s près', () => {
    const cursor = make()
    cursor.shift(3600, NOW, 0)
    expect(cursor.offsetSeconds).toBeCloseTo(3600, 6)
    cursor.shift(-3600, NOW, 0)
    expect(cursor.offsetSeconds).toBe(0)
    expect(cursor.tPrimeAt(NOW, 0)).toBe(NOW)
  })

  it('reset() remet le décalage à zéro et arrête la lecture', () => {
    const cursor = make()
    cursor.setTPrime(NOW + 30 * DAY, NOW, 0)
    cursor.play(86_400)
    cursor.reset()
    expect(cursor.offsetSeconds).toBe(0)
    expect(cursor.playRate).toBe(0)
  })

  it('borné aux deux bouts', () => {
    const cursor = make()
    cursor.setTPrime(BOUNDS.maxS + 999 * DAY, NOW, 0)
    expect(cursor.tPrimeAt(NOW, 0)).toBe(BOUNDS.maxS)
    cursor.setTPrime(BOUNDS.minS - 999 * DAY, NOW, 0)
    expect(cursor.tPrimeAt(NOW, 0)).toBe(BOUNDS.minS)
  })

  it('la lecture avance d\'une vitesse × le temps réel écoulé, et s\'arrête au bout', () => {
    const cursor = make()
    cursor.play(DAY) // 1 j/s
    expect(cursor.step(NOW, 10_000)).toBe(false) // première image : pas de dt connu
    expect(cursor.step(NOW, 10_100)).toBe(true)
    expect(cursor.offsetSeconds).toBeCloseTo(0.1 * DAY, 3)
    cursor.setTPrime(BOUNDS.maxS - 1000, NOW, 0)
    cursor.step(NOW, 10_200)
    expect(cursor.tPrimeAt(NOW, 0)).toBe(BOUNDS.maxS)
    expect(cursor.playRate).toBe(0)
  })

  it('un onglet resté en arrière-plan ne fait pas sauter la lecture (dt plafonné)', () => {
    const cursor = make()
    cursor.play(DAY)
    cursor.step(NOW, 0)
    cursor.step(NOW, 600_000) // dix minutes plus tard
    expect(cursor.offsetSeconds).toBeLessThanOrEqual(0.25 * DAY + 1e-6)
  })
})
