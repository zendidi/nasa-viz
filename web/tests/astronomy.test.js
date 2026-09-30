import { describe, expect, it } from 'vitest'

import { getGreenwichSiderealTime, getMoonEquatorial, getSunEquatorial } from '../src/astronomy.js'

// astronomy.js est une série analytique basse précision (docblock : "accurate
// to a few degrees"). Ces tests n'épinglent donc pas ses formules internes --
// les recalculer et comparer ne protégerait rien -- mais des faits
// astronomiques vérifiables de l'extérieur (almanach) : position du Soleil aux
// équinoxes/solstices, vitesse angulaire du Soleil et de la Lune, avance du
// temps sidéral. Tolérances volontairement larges pour rester du côté de
// l'approximation que le docblock revendique.
//
// Piège documenté (docs/agent/gotchas.md, "astronomy.js calcule le Soleil
// dans l'équinoxe de la date, la scène est en J2000") : la fonction mesure la
// longitude solaire depuis l'équinoxe *de la date*, pas J2000, et le résultat
// est utilisé tel quel. C'est un choix assumé (cohérent avec lui-même tant que
// rien n'est mélangé avec une donnée JPL/J2000 dans le même dessin), pas un
// bug -- on ne le "corrige" pas ici, on ne fait que constater qu'il n'y a pas
// de retrait de précession appliqué.

// Instants d'équinoxe/solstice 2026 (UTC), source USNO/almanach -- faits
// externes, indépendants de ce code.
const MARCH_EQUINOX_2026 = new Date('2026-03-20T14:46:00Z')
const JUNE_SOLSTICE_2026 = new Date('2026-06-21T08:25:00Z')
const SEPTEMBER_EQUINOX_2026 = new Date('2026-09-23T00:05:00Z')
const DECEMBER_SOLSTICE_2026 = new Date('2026-12-21T20:50:00Z')

describe('getSunEquatorial', () => {
  it('fonctionne sans date explicite (défaut = maintenant)', () => {
    const s = getSunEquatorial()
    expect(Number.isFinite(s.ra)).toBe(true)
    expect(Number.isFinite(s.dec)).toBe(true)
    expect(Number.isFinite(s.distanceKm)).toBe(true)
  })

  it('donne une déclinaison nulle aux équinoxes de mars et septembre 2026', () => {
    // Fait externe : à l'équinoxe, le Soleil traverse l'équateur céleste (dec = 0).
    // Tolérance large (l'almanach bas niveau n'a pas la seconde d'arc).
    expect(Math.abs(getSunEquatorial(MARCH_EQUINOX_2026).dec)).toBeLessThan(0.5)
    expect(Math.abs(getSunEquatorial(SEPTEMBER_EQUINOX_2026).dec)).toBeLessThan(0.5)
  })

  it('atteint environ ±23,44° de déclinaison aux solstices de juin et décembre 2026', () => {
    // Fait externe : l'obliquité de l'écliptique borne la déclinaison solaire au solstice.
    expect(getSunEquatorial(JUNE_SOLSTICE_2026).dec).toBeGreaterThan(23)
    expect(getSunEquatorial(JUNE_SOLSTICE_2026).dec).toBeLessThan(23.44 + 0.5)
    expect(getSunEquatorial(DECEMBER_SOLSTICE_2026).dec).toBeLessThan(-23)
    expect(getSunEquatorial(DECEMBER_SOLSTICE_2026).dec).toBeGreaterThan(-23.44 - 0.5)
  })

  it("fait avancer l'ascension droite d'environ 1° par jour", () => {
    // Fait externe : le Soleil parcourt 360° en ~365,25 jours, donc ~0,98°/jour
    // en moyenne (plus vite près du périhélie de janvier, plus lentement en
    // juillet -- deuxième loi de Kepler), d'où une tolérance large.
    const d0 = new Date('2026-01-15T00:00:00Z')
    const d1 = new Date('2026-01-16T00:00:00Z')
    const delta = getSunEquatorial(d1).ra - getSunEquatorial(d0).ra
    expect(delta).toBeGreaterThan(0.5)
    expect(delta).toBeLessThan(1.5)
  })

  it("boucle sur elle-même en un an d'ascension droite", () => {
    // Fait externe : la période orbitale terrestre est d'environ 365,25 jours,
    // donc l'ascension droite du Soleil revient à sa valeur de départ.
    const d0 = new Date('2026-01-15T00:00:00Z')
    const d1 = new Date(d0.getTime() + 365.25 * 86400000)
    const ra0 = getSunEquatorial(d0).ra
    const ra1 = getSunEquatorial(d1).ra
    expect(Math.abs(ra1 - ra0)).toBeLessThan(0.1)
  })

  it('place la distance Terre-Soleil entre périhélie et aphélie réels', () => {
    // Fait externe : la Terre est entre 0,983 ua (périhélie, début janvier) et
    // 1,017 ua (aphélie, début juillet) du Soleil toute l'année.
    const AU_KM = 149_597_870.7
    for (const date of [MARCH_EQUINOX_2026, JUNE_SOLSTICE_2026, SEPTEMBER_EQUINOX_2026, DECEMBER_SOLSTICE_2026]) {
      const auDistance = getSunEquatorial(date).distanceKm / AU_KM
      expect(auDistance).toBeGreaterThan(0.98)
      expect(auDistance).toBeLessThan(1.02)
    }
  })

  it('rend une ascension droite dans [0, 360)', () => {
    for (const date of [MARCH_EQUINOX_2026, JUNE_SOLSTICE_2026, SEPTEMBER_EQUINOX_2026, DECEMBER_SOLSTICE_2026]) {
      const ra = getSunEquatorial(date).ra
      expect(ra).toBeGreaterThanOrEqual(0)
      expect(ra).toBeLessThan(360)
    }
  })
})

describe('getMoonEquatorial', () => {
  it('fonctionne sans date explicite (défaut = maintenant)', () => {
    const m = getMoonEquatorial()
    expect(Number.isFinite(m.ra)).toBe(true)
    expect(Number.isFinite(m.dec)).toBe(true)
    expect(Number.isFinite(m.distanceKm)).toBe(true)
  })

  it('parcourt le ciel bien plus vite que le Soleil (environ 13°/jour)', () => {
    // Fait externe : la Lune boucle l'écliptique en ~27,3 jours (mois
    // sidéral) contre ~365,25 jours pour le Soleil, soit environ 13x plus
    // vite. On compare directement les deux vitesses plutôt que de figer un
    // chiffre précis, pour rester insensible aux termes périodiques de la série.
    const d0 = new Date('2026-01-15T00:00:00Z')
    const d1 = new Date('2026-01-16T00:00:00Z')
    const sunDelta = getSunEquatorial(d1).ra - getSunEquatorial(d0).ra
    let moonDelta = getMoonEquatorial(d1).ra - getMoonEquatorial(d0).ra
    if (moonDelta < 0) moonDelta += 360 // passage 360 -> 0 possible en un jour
    expect(moonDelta).toBeGreaterThan(9)
    expect(moonDelta).toBeLessThan(16)
    expect(moonDelta).toBeGreaterThan(sunDelta * 5)
  })

  it('reste dans les bornes réelles de distance Terre-Lune (périgée/apogée)', () => {
    // Fait externe : la distance Terre-Lune varie entre environ 356 500 km
    // (périgée) et 406 700 km (apogée). Marge ajoutée de part et d'autre.
    const d0 = new Date('2026-01-15T00:00:00Z')
    for (let i = 0; i < 30; i++) {
      const date = new Date(d0.getTime() + i * 86400000)
      const distanceKm = getMoonEquatorial(date).distanceKm
      expect(distanceKm).toBeGreaterThan(350_000)
      expect(distanceKm).toBeLessThan(410_000)
    }
  })

  it('rend une ascension droite dans [0, 360) et une déclinaison dans [-90, 90]', () => {
    for (const date of [MARCH_EQUINOX_2026, JUNE_SOLSTICE_2026, SEPTEMBER_EQUINOX_2026, DECEMBER_SOLSTICE_2026]) {
      const m = getMoonEquatorial(date)
      expect(m.ra).toBeGreaterThanOrEqual(0)
      expect(m.ra).toBeLessThan(360)
      expect(m.dec).toBeGreaterThanOrEqual(-90)
      expect(m.dec).toBeLessThanOrEqual(90)
    }
  })
})

describe('getGreenwichSiderealTime', () => {
  it('fonctionne sans date explicite (défaut = maintenant)', () => {
    expect(Number.isFinite(getGreenwichSiderealTime())).toBe(true)
  })

  it('rend une valeur dans [0, 360)', () => {
    for (const date of [MARCH_EQUINOX_2026, JUNE_SOLSTICE_2026, SEPTEMBER_EQUINOX_2026, DECEMBER_SOLSTICE_2026]) {
      const gmst = getGreenwichSiderealTime(date)
      expect(gmst).toBeGreaterThanOrEqual(0)
      expect(gmst).toBeLessThan(360)
    }
  })

  it("avance d'environ 360,9856° par jour solaire (un peu plus d'un tour, pas 360°)", () => {
    // Fait externe : le jour sidéral (~23h56m4s) est plus court que le jour
    // solaire de 24h parce que la Terre doit tourner un peu plus d'un tour
    // complet pour ramener le Soleil au méridien -- exactement la constante
    // qu'une refonte de la formule pourrait casser en silence en la
    // confondant avec un simple 360°/jour.
    const d0 = new Date('2026-01-15T00:00:00Z')
    const d1 = new Date(d0.getTime() + 86400000)
    const gmst0 = getGreenwichSiderealTime(d0)
    const gmst1 = getGreenwichSiderealTime(d1)
    // gmst1 a fait un tour complet plus ~0,9856° ; la fonction ramène le
    // résultat dans [0, 360), donc l'écart brut observé est ce reliquat.
    const advance = ((gmst1 - gmst0 + 360) % 360)
    expect(advance).toBeGreaterThan(0.9)
    expect(advance).toBeLessThan(1.05)
    expect(advance).not.toBeCloseTo(0, 1) // ce ne serait pas "un peu plus d'un tour" mais 360° pile
  })

  it('avance de proche de 361° (et non 360°) sur 366 jours (un an + un jour bissextile)', () => {
    // Sur une plus longue base de temps, l'écart cumulé entre jour sidéral et
    // jour solaire doit rester net : ~366 jours * 0,9856°/jour ≈ 360,7° de
    // "tours en trop", soit un déphasage total loin d'être négligeable.
    const d0 = new Date('2026-01-15T00:00:00Z')
    const d1 = new Date(d0.getTime() + 366 * 86400000)
    const gmst0 = getGreenwichSiderealTime(d0)
    const gmst1 = getGreenwichSiderealTime(d1)
    const advance = ((gmst1 - gmst0 + 360 * 400) % 360)
    // 366 * 0.9856736629 mod 360 ≈ 0.7565
    expect(advance).toBeGreaterThan(0.5)
    expect(advance).toBeLessThan(1.0)
  })
})
