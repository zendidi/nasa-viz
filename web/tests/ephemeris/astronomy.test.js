import { describe, expect, it } from 'vitest'

import { getEarthPoleJ2000, getEarthRotationAngle, getGreenwichSiderealTime, getMoonEquatorial, getSunEquatorial } from '../../src/ephemeris/astronomy.js'

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

describe('getEarthRotationAngle', () => {
  // Ce qui est épinglé : l'écart ERA ↔ GMST, c'est-à-dire la raison même du
  // changement (2026-10-21). Nul à J2000 par construction des deux formules, il
  // croît avec la précession en ascension droite (~46″/an) : 0,34° en 2026. Un
  // retour au GMST, ou une ERA mal calée, le ferait sortir de ces bornes.
  const gap = (date) => {
    const d = getGreenwichSiderealTime(date) - getEarthRotationAngle(date)
    return ((d + 540) % 360) - 180
  }

  it('coïncide avec le GMST à J2000 (à 0,01° près)', () => {
    expect(Math.abs(gap(new Date(Date.UTC(2000, 0, 1, 12))))).toBeLessThan(0.01)
  })

  it('le GMST a 0,30 à 0,40° d’avance en 2026 : la précession depuis J2000', () => {
    const g = gap(new Date('2026-10-21T00:00:00Z'))
    expect(g).toBeGreaterThan(0.3)
    expect(g).toBeLessThan(0.4)
  })

  it('valeur de référence IERS : ERA(J2000,0 UT1) = 280,46061837504°', () => {
    // 2π·0,7790572732640 rad, la constante de la définition IAU 2000.
    expect(getEarthRotationAngle(new Date(Date.UTC(2000, 0, 1, 12)))).toBeCloseTo(280.4606184, 6)
  })
})

describe('getEarthPoleJ2000', () => {
  // Épinglé : l'écart au pôle J2000, qui est tout l'objet de la fonction
  // (2026-10-21) -- nul à J2000, ~20″/an ensuite : 0,149° fin 2026 -- et sa
  // direction, vers l'ascension droite 0 h (le pôle précesse vers l'équinoxe).
  const angleDeg = ([x, y, z]) => (Math.acos(Math.min(1, z / Math.hypot(x, y, z))) * 180) / Math.PI

  it('confondu avec le pôle J2000 à J2000', () => {
    expect(angleDeg(getEarthPoleJ2000(new Date(Date.UTC(2000, 0, 1, 12))))).toBeLessThan(1e-9)
  })

  it('à 0,14–0,16° du pôle J2000 en octobre 2026, vers α ≈ 0 h, vecteur unitaire', () => {
    const p = getEarthPoleJ2000(new Date('2026-10-21T00:00:00Z'))
    expect(angleDeg(p)).toBeGreaterThan(0.14)
    expect(angleDeg(p)).toBeLessThan(0.16)
    expect(p[0]).toBeGreaterThan(0)
    expect(Math.abs(p[1])).toBeLessThan(p[0] / 100)
    expect(Math.hypot(...p)).toBeCloseTo(1, 12)
  })
})
