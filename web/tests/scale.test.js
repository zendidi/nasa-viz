import { describe, expect, it } from 'vitest'

import {
  AU_KM,
  EARTH_CURVE,
  EARTH_MARKER_RADIUS,
  EARTH_RADIUS,
  EARTH_RADIUS_KM,
  FOCUS_READABLE_RADIUS,
  ISS_RADIUS_KM,
  ISS_READABLE_RADIUS,
  KM_TO_UNITS,
  LUNAR_DISTANCE_KM,
  PLANET_READABLE_EXPONENT,
  SCALE_PRESETS,
  SCALE_STEPS,
  SUN_CURVE,
  SUN_READABLE_RADIUS,
  SUN_RADIUS_KM,
  describeScale,
  earthSystemScale,
  issOrbitRadius,
  issRadius,
  lerpLog,
  moonRadius,
  moonSystemCurve,
  NEO_FLOOR_PX,
  NEO_FLOOR_SPREAD_PX,
  NEO_FLOOR_SIZE_SPREAD,
  neoFloorFactor,
  neoFloorPx,
  neoRadius,
  neoReadableRadius,
  orbitingCurve,
  planetRadius,
  planetReadableRadius,
  pivotRadius,
  readableDistance,
  remapCameraDistance,
  sceneDistance,
  sceneDistanceToKm,
  sunRadius,
  worldPerPixel,
} from '../src/scale.js'

// Ce fichier n'epingle pas la formule de scale.js -- il epingle ce que les
// docblocks promettent : monotonie des courbes de compression, continuite et
// coincidence entre courbes soeurs (EARTH_CURVE / moonSystemCurve / SUN_CURVE),
// ancrages nommes ("lisible", "100 % reel"), et coherence d'unites km <-> units.
// Un test qui recalcule a + b*log10(d) et compare ne protegerait rien ; celui
// qui verifie que le resultat croit, se rejoint aux jonctions et vaut la bonne
// chose aux ancrages proteges reellement les regressions silencieuses.

describe('constantes d unites', () => {
  it('EARTH_RADIUS_KM est le rayon moyen (6371), pas le rayon equatorial (6378)', () => {
    // Piege classique du projet : confondre les deux fausserait tout ce qui
    // derive de KM_TO_UNITS sans qu'aucun test de forme ne le voie.
    expect(EARTH_RADIUS_KM).toBe(6371)
  })

  it('KM_TO_UNITS ramene le rayon terrestre reel a EARTH_RADIUS tel quel', () => {
    expect(EARTH_RADIUS_KM * KM_TO_UNITS).toBeCloseTo(EARTH_RADIUS, 12)
  })

  it('km -> units -> km est l identite', () => {
    for (const km of [1, 6371, 384_400, AU_KM]) {
      const roundTrip = (km * KM_TO_UNITS) / KM_TO_UNITS
      expect(roundTrip).toBeCloseTo(km, 6)
    }
  })
})

describe('lerpLog', () => {
  it('vaut a a t = 0 et b a t = 1', () => {
    expect(lerpLog(3, 700, 0)).toBeCloseTo(3, 12)
    expect(lerpLog(3, 700, 1)).toBeCloseTo(700, 12)
  })

  it('vaut la moyenne geometrique de a et b a t = 0,5', () => {
    expect(lerpLog(4, 100, 0.5)).toBeCloseTo(Math.sqrt(4 * 100), 12)
  })

  it('est constante quand a = b, quel que soit t', () => {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      expect(lerpLog(42, 42, t)).toBeCloseTo(42, 12)
    }
  })

  it('est monotone croissante en t quand b > a', () => {
    const values = [0, 0.2, 0.4, 0.6, 0.8, 1].map((t) => lerpLog(1, 1000, t))
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1])
    }
  })
})

describe('EARTH_CURVE', () => {
  it('ancre la Lune a 12 unites', () => {
    expect(readableDistance(LUNAR_DISTANCE_KM, EARTH_CURVE)).toBeCloseTo(12, 9)
  })

  it('ancre 0,5 ua a 20 unites', () => {
    expect(readableDistance(0.5 * AU_KM, EARTH_CURVE)).toBeCloseTo(20, 9)
  })

  it('est monotone croissante avec la distance reelle', () => {
    const kms = [1e3, 1e4, LUNAR_DISTANCE_KM, 1e6, 0.5 * AU_KM, AU_KM, 10 * AU_KM]
    const values = kms.map((km) => readableDistance(km, EARTH_CURVE))
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1])
    }
  })

  it('est plafonnee a minUnits pres du corps, jamais en dessous', () => {
    // A 1 km la formule brute serait tres negative ; le floor doit la rattraper.
    expect(readableDistance(1, EARTH_CURVE)).toBeCloseTo(EARTH_CURVE.minUnits, 12)
    expect(readableDistance(1, EARTH_CURVE)).toBeGreaterThanOrEqual(EARTH_CURVE.minUnits)
  })

  it('minUnits vaut 1,5 fois le rayon terrestre', () => {
    expect(EARTH_CURVE.minUnits).toBeCloseTo(EARTH_RADIUS * 1.5, 12)
  })
})

describe('moonSystemCurve, generalisation de EARTH_CURVE', () => {
  it('reproduit EARTH_CURVE quand on lui donne les memes ancrages (Lune, 1 ua)', () => {
    // Le docblock l'affirme explicitement : moonSystemCurve(LUNAR_DISTANCE_KM, AU_KM)
    // doit reproduire EARTH_CURVE plutot que l'approcher seulement.
    const curve = moonSystemCurve(LUNAR_DISTANCE_KM, AU_KM)
    expect(curve.a).toBeCloseTo(EARTH_CURVE.a, 9)
    expect(curve.b).toBeCloseTo(EARTH_CURVE.b, 9)
    expect(curve.minUnits).toBeCloseTo(EARTH_CURVE.minUnits, 12)
  })

  it('ancre toujours la plus grande lune a 12 unites, quelle que soit la planete', () => {
    for (const [moonKm, sunKm] of [
      [421_800, 5.2 * AU_KM], // Jupiter / Amalthee-ish
      [1_221_870, 9.5 * AU_KM], // Saturne / Titan
      [117_646, 30 * AU_KM], // Neptune / Triton
    ]) {
      const curve = moonSystemCurve(moonKm, sunKm)
      expect(readableDistance(moonKm, curve)).toBeCloseTo(12, 9)
    }
  })

  it('place le Soleil au meme cran, quelle que soit la planete d ancrage', () => {
    // C'est SUN_AT_UNITS, derive de EARTH_CURVE : il ne doit pas bouger selon
    // la lune principale ou la distance heliocentrique fournies.
    const sunUnitsFromEarth = readableDistance(AU_KM, EARTH_CURVE)
    const cases = [
      [421_800, 5.2 * AU_KM],
      [1_221_870, 9.5 * AU_KM],
      [117_646, 30 * AU_KM],
    ]
    for (const [moonKm, sunKm] of cases) {
      const curve = moonSystemCurve(moonKm, sunKm)
      expect(readableDistance(sunKm, curve)).toBeCloseTo(sunUnitsFromEarth, 9)
    }
  })

  it('verrouille la valeur tatonnee a 21,052041 unites', () => {
    // Commentaire du fichier : "21,05 par tatonnement". Une constante calibree a
    // la main se verrouille serre ou ne se verrouille pas : a +/- 0,05 pres, une
    // retouche de la courbe passerait inapercue. Mesure exacte 21,052041108508934.
    // Si ce nombre bouge, c'est que la courbe a change -- ce qui est peut-etre
    // voulu, et c'est justement ce que ce test doit forcer a constater.
    expect(readableDistance(AU_KM, EARTH_CURVE)).toBeCloseTo(21.052041, 6)
  })
})

describe('orbitingCurve et SUN_CURVE', () => {
  it('SUN_CURVE est bien le cas particulier a = 1 ua de orbitingCurve', () => {
    const derived = orbitingCurve(AU_KM)
    expect(SUN_CURVE.a).toBeCloseTo(derived.a, 12)
    expect(SUN_CURVE.b).toBeCloseTo(derived.b, 12)
    expect(SUN_CURVE.minUnits).toBeCloseTo(derived.minUnits, 12)
  })

  it('ancre 0,3x le yardstick a 6 unites et 5x a 26 unites', () => {
    const yardstickKm = 7.5 * AU_KM // pivot arbitraire, pas forcement le Soleil
    const curve = orbitingCurve(yardstickKm)
    expect(readableDistance(0.3 * yardstickKm, curve)).toBeCloseTo(6, 9)
    expect(readableDistance(5 * yardstickKm, curve)).toBeCloseTo(26, 9)
  })

  it('a une pente independante du yardstick choisi', () => {
    // b ne depend que du rapport fixe 5 / 0,3, pas des km absolus.
    const b1 = orbitingCurve(AU_KM).b
    const b2 = orbitingCurve(1000).b
    const b3 = orbitingCurve(30 * AU_KM).b
    expect(b2).toBeCloseTo(b1, 9)
    expect(b3).toBeCloseTo(b1, 9)
  })

  it('place le yardstick au MEME endroit quel que soit le pivot', () => {
    // Invariant explicite du docblock : quel que soit le pivot, le corps qui
    // definit la vue atterrit toujours au meme endroit a l'ecran. Mesure : la
    // valeur est identique a 1e-13 pres de Mercure a Neptune, donc l'invariant
    // est exact et non approximatif -- c'est cette egalite entre pivots qu'il
    // faut affirmer, et pas la proximite de chacun a un litteral arrondi.
    const places = [AU_KM, 0.39 * AU_KM, 30 * AU_KM, 5000].map((yardstickKm) =>
      readableDistance(yardstickKm, orbitingCurve(yardstickKm)),
    )
    for (const place of places) expect(place).toBeCloseTo(places[0], 10)
  })

  it('verrouille ce point commun a 14,5588129536 unites', () => {
    // Separe du test precedent a dessein : l'un dit que les pivots s'accordent,
    // l'autre sur quelle valeur. Si seule celle-ci bouge, la courbe a ete
    // retouchee sans casser l'invariant, et c'est une information differente.
    expect(readableDistance(AU_KM, orbitingCurve(AU_KM))).toBeCloseTo(14.5588129536, 9)
  })

  it('est monotone croissante avec la distance reelle', () => {
    const curve = orbitingCurve(AU_KM)
    const kms = [0.1 * AU_KM, 0.3 * AU_KM, AU_KM, 5 * AU_KM, 40 * AU_KM]
    const values = kms.map((km) => readableDistance(km, curve))
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1])
    }
  })
})

describe('sceneDistance', () => {
  it('coincide avec readableDistance a t = 0 (cran "lisible")', () => {
    expect(sceneDistance(LUNAR_DISTANCE_KM, 0, EARTH_CURVE)).toBeCloseTo(
      readableDistance(LUNAR_DISTANCE_KM, EARTH_CURVE),
      9,
    )
  })

  it('coincide avec la conversion km -> units exacte a t = 1 (cran "100 % reel")', () => {
    expect(sceneDistance(LUNAR_DISTANCE_KM, 1, EARTH_CURVE)).toBeCloseTo(LUNAR_DISTANCE_KM * KM_TO_UNITS, 6)
  })

  it('est monotone croissante avec la distance reelle, a t fixe', () => {
    for (const t of [0, 0.5, 1]) {
      const kms = [1e3, LUNAR_DISTANCE_KM, 1e6, 0.5 * AU_KM, AU_KM]
      const values = kms.map((km) => sceneDistance(km, t, EARTH_CURVE))
      for (let i = 1; i < values.length; i++) {
        expect(values[i]).toBeGreaterThan(values[i - 1])
      }
    }
  })
})

describe('sceneDistanceToKm, inverse de sceneDistance', () => {
  it('retrouve la distance reelle d origine par aller-retour', () => {
    for (const t of [0, 0.3, 0.7, 1]) {
      for (const km of [1e4, LUNAR_DISTANCE_KM, 1e6, 0.5 * AU_KM, 2 * AU_KM]) {
        const units = sceneDistance(km, t, EARTH_CURVE)
        const back = sceneDistanceToKm(units, t, EARTH_CURVE)
        expect(back / km).toBeCloseTo(1, 3)
      }
    }
  })
})

describe('issOrbitRadius', () => {
  it('vaut le rayon terrestre plus l altitude reelle a t = 1', () => {
    expect(issOrbitRadius(400, 1)).toBeCloseTo(EARTH_RADIUS + 400 * KM_TO_UNITS, 9)
  })

  it('exagere l altitude par un facteur 8 a t = 0, par rapport a t = 1', () => {
    const altitudeUnitsReadable = issOrbitRadius(400, 0) - EARTH_RADIUS
    const altitudeUnitsReal = issOrbitRadius(400, 1) - EARTH_RADIUS
    expect(altitudeUnitsReadable / altitudeUnitsReal).toBeCloseTo(8, 9)
  })
})

describe('issRadius', () => {
  it('vaut ISS_READABLE_RADIUS a t = 0 et la taille reelle a t = 1', () => {
    expect(issRadius(0)).toBeCloseTo(ISS_READABLE_RADIUS, 12)
    expect(issRadius(1)).toBeCloseTo(ISS_RADIUS_KM * KM_TO_UNITS, 12)
  })
})

describe('earthSystemScale', () => {
  it('vaut 1 a tout t quand la Terre est le pivot', () => {
    for (const t of [0, 0.5, 1]) {
      expect(earthSystemScale(t, true)).toBe(1)
    }
  })

  it('retrecit a EARTH_MARKER_RADIUS / EARTH_RADIUS a t = 0 hors pivot', () => {
    expect(earthSystemScale(0, false)).toBeCloseTo(EARTH_MARKER_RADIUS / EARTH_RADIUS, 12)
  })

  it('revient aux proportions reelles (1) a t = 1 hors pivot', () => {
    expect(earthSystemScale(1, false)).toBeCloseTo(1, 12)
  })
})

describe('neoReadableRadius', () => {
  it('plafonne a 0,03 pour un diametre nul ou tres petit', () => {
    expect(neoReadableRadius(0)).toBeCloseTo(0.03, 12)
  })

  it('plafonne a 0,2 pour un diametre tres grand', () => {
    expect(neoReadableRadius(1000)).toBeCloseTo(0.2, 12)
  })
})

describe('neoRadius', () => {
  it('coincide avec neoReadableRadius a t = 0', () => {
    expect(neoRadius(0.5, 0)).toBeCloseTo(neoReadableRadius(0.5), 12)
  })

  it('coincide avec le rayon reel (diametre / 2 converti) a t = 1', () => {
    expect(neoRadius(0.5, 1)).toBeCloseTo((0.5 / 2) * KM_TO_UNITS, 12)
  })
})

describe('neoFloorPx', () => {
  it('garde le plancher plein tant que le nuage est large a l ecran', () => {
    expect(neoFloorPx(NEO_FLOOR_SPREAD_PX.wide)).toBeCloseTo(NEO_FLOOR_PX.max, 12)
    expect(neoFloorPx(5000)).toBeCloseTo(NEO_FLOOR_PX.max, 12)
  })

  it('descend a un point de 1 px de diametre, jamais en dessous, une fois le nuage serre', () => {
    expect(NEO_FLOOR_PX.min * 2).toBe(1)
    expect(neoFloorPx(NEO_FLOOR_SPREAD_PX.tight)).toBeCloseTo(NEO_FLOOR_PX.min, 12)
    expect(neoFloorPx(1)).toBeCloseTo(NEO_FLOOR_PX.min, 12)
    expect(neoFloorPx(0)).toBeCloseTo(NEO_FLOOR_PX.min, 12)
  })

  it('decroit quand on dezoome', () => {
    const spreads = [400, 200, 100, 50, 20]
    const floors = spreads.map(neoFloorPx)
    for (let i = 1; i < floors.length; i++) expect(floors[i]).toBeLessThanOrEqual(floors[i - 1])
    expect(floors[2]).toBeLessThan(NEO_FLOOR_PX.max)
    expect(floors[2]).toBeGreaterThan(NEO_FLOOR_PX.min)
  })
})

describe('neoFloorFactor', () => {
  it('va de -25 % pour le plus petit du flux a +25 % pour le plus gros', () => {
    expect(neoFloorFactor(0.01, 0.01, 1)).toBeCloseTo(1 - NEO_FLOOR_SIZE_SPREAD, 12)
    expect(neoFloorFactor(1, 0.01, 1)).toBeCloseTo(1 + NEO_FLOOR_SIZE_SPREAD, 12)
  })

  it('se place en log du diametre : la moyenne geometrique tombe sur la taille actuelle', () => {
    expect(neoFloorFactor(0.1, 0.01, 1)).toBeCloseTo(1, 12)
  })

  it('vaut 1 quand le flux n a qu une taille', () => {
    expect(neoFloorFactor(0.2, 0.2, 0.2)).toBe(1)
  })
})

describe('sunRadius', () => {
  it('vaut FOCUS_READABLE_RADIUS a t = 0 quand le Soleil est le pivot', () => {
    expect(sunRadius(0, true)).toBeCloseTo(FOCUS_READABLE_RADIUS, 12)
  })

  it('vaut SUN_READABLE_RADIUS a t = 0 quand le Soleil n est pas le pivot', () => {
    expect(sunRadius(0, false)).toBeCloseTo(SUN_READABLE_RADIUS, 12)
  })

  it('converge vers la meme taille reelle a t = 1, pivot ou non', () => {
    expect(sunRadius(1, true)).toBeCloseTo(sunRadius(1, false), 9)
    expect(sunRadius(1, true)).toBeCloseTo(SUN_RADIUS_KM * KM_TO_UNITS, 9)
  })
})

describe('pivotRadius', () => {
  it('reste constant a EARTH_RADIUS quand le pivot est la Terre, quel que soit t', () => {
    // Cas particulier annonce par le docblock : la Terre EST l'ancre, donc
    // lerpLog(FOCUS_READABLE_RADIUS, EARTH_RADIUS_KM * KM_TO_UNITS, t) ne bouge pas.
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      expect(pivotRadius(EARTH_RADIUS_KM, t)).toBeCloseTo(EARTH_RADIUS, 12)
    }
  })

  it('coincide exactement avec sunRadius(t, true) quand le pivot est le Soleil', () => {
    for (const t of [0, 0.3, 0.6, 1]) {
      expect(pivotRadius(SUN_RADIUS_KM, t)).toBeCloseTo(sunRadius(t, true), 12)
    }
  })
})

describe('planetReadableRadius', () => {
  it('rend EARTH_MARKER_RADIUS quand on lui passe le rayon terrestre (ratio 1)', () => {
    expect(planetReadableRadius(EARTH_RADIUS_KM)).toBeCloseTo(EARTH_MARKER_RADIUS, 12)
  })

  it('est monotone croissante avec le rayon reel (exposant positif)', () => {
    const radii = [1000, 3000, EARTH_RADIUS_KM, 25_000, 70_000]
    const values = radii.map(planetReadableRadius)
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1])
    }
  })

  it('comprime davantage que les vraies proportions (exposant < 1)', () => {
    // Doubler le rayon reel ne doit pas doubler le rayon lisible.
    const ratio = planetReadableRadius(2 * EARTH_RADIUS_KM) / planetReadableRadius(EARTH_RADIUS_KM)
    expect(ratio).toBeLessThan(2)
    expect(ratio).toBeCloseTo(Math.pow(2, PLANET_READABLE_EXPONENT), 9)
  })
})

describe('planetRadius et moonRadius', () => {
  it('moonRadius est un alias strict de planetRadius, pas une copie', () => {
    // Le docblock insiste : "aliase plutot que duplique" pour que les deux ne
    // puissent pas diverger par accident. On verifie l'identite de fonction.
    expect(moonRadius).toBe(planetRadius)
  })

  it('coincide avec planetReadableRadius a t = 0 et le rayon reel a t = 1', () => {
    expect(planetRadius(71_492, 0)).toBeCloseTo(planetReadableRadius(71_492), 12)
    expect(planetRadius(71_492, 1)).toBeCloseTo(71_492 * KM_TO_UNITS, 9)
  })
})

describe('worldPerPixel', () => {
  it('est proportionnelle a la distance', () => {
    const near = worldPerPixel(100, 50, 900)
    const far = worldPerPixel(300, 50, 900)
    expect(far / near).toBeCloseTo(3, 9)
  })

  it('diminue quand la hauteur de viewport augmente (memes pixels, plus de details)', () => {
    const small = worldPerPixel(100, 50, 900)
    const large = worldPerPixel(100, 50, 1800)
    expect(large).toBeCloseTo(small / 2, 9)
  })

  it('augmente avec le champ de vision', () => {
    const narrow = worldPerPixel(100, 30, 900)
    const wide = worldPerPixel(100, 90, 900)
    expect(wide).toBeGreaterThan(narrow)
  })
})

describe('remapCameraDistance', () => {
  const fromAnchors = [1, 10, 100]
  const toAnchors = [2, 40, 60]

  it('rend exactement les ancres cibles aux distances d ancrage', () => {
    for (let i = 0; i < fromAnchors.length; i++) {
      expect(remapCameraDistance(fromAnchors[i], fromAnchors, toAnchors)).toBeCloseTo(toAnchors[i], 9)
    }
  })

  it('reste en deca de la premiere ancre a un ratio constant', () => {
    expect(remapCameraDistance(0.5, fromAnchors, toAnchors)).toBeCloseTo(0.5 * (toAnchors[0] / fromAnchors[0]), 9)
  })

  it('continue au-dela de la derniere ancre a un ratio constant', () => {
    const n = fromAnchors.length
    expect(remapCameraDistance(1000, fromAnchors, toAnchors)).toBeCloseTo(
      1000 * (toAnchors[n - 1] / fromAnchors[n - 1]),
      9,
    )
  })

  it('est continue aux jonctions : une valeur juste avant et juste apres une ancre ne saute pas', () => {
    const anchor = fromAnchors[1]
    const before = remapCameraDistance(anchor - 1e-6, fromAnchors, toAnchors)
    const after = remapCameraDistance(anchor + 1e-6, fromAnchors, toAnchors)
    expect(after - before).toBeCloseTo(0, 3)
  })

  it('est monotone croissante avec la distance', () => {
    const distances = [0.1, 0.5, 1, 5, 10, 50, 100, 500]
    const values = distances.map((d) => remapCameraDistance(d, fromAnchors, toAnchors))
    for (let i = 1; i < values.length; i++) {
      expect(values[i]).toBeGreaterThan(values[i - 1])
    }
  })
})

describe('SCALE_STEPS et SCALE_PRESETS', () => {
  it('a 8 crans, et le dernier preset est le cran 8 (t = 1, "100 % reel")', () => {
    expect(SCALE_STEPS).toBe(8)
    const last = SCALE_PRESETS[SCALE_PRESETS.length - 1]
    expect(last.step / SCALE_STEPS).toBe(1)
    expect(last.label).toBe('100 % réel')
  })

  it('le premier preset est le cran 0 (t = 0, "Lisible")', () => {
    const first = SCALE_PRESETS[0]
    expect(first.step).toBe(0)
    expect(first.label).toBe('Lisible')
  })
})

describe('describeScale', () => {
  it('affiche 1:1 partout a t = 1, references et tailles comprises', () => {
    // Le cran "100 % reel" doit se lire comme "plus aucune compression".
    const label = describeScale(1, {
      curve: EARTH_CURVE,
      references: [{ label: 'Lune', km: LUNAR_DISTANCE_KM }],
      neoDistancesKm: [1_200_000],
      neoDiametersKm: [0.5],
    })
    expect(label).toContain('Lune 1:1')
    expect(label).toContain('NEO 1:1')
    expect(label).toContain('tailles 1:1')
  })

  it('affiche un facteur de compression a t = 0, pas 1:1', () => {
    const label = describeScale(0, {
      curve: EARTH_CURVE,
      references: [{ label: 'Lune', km: LUNAR_DISTANCE_KM }],
      neoDistancesKm: [],
      neoDiametersKm: [],
    })
    expect(label).toContain('Lune ÷')
    expect(label).not.toContain('Lune 1:1')
  })

  it('retombe sur la taille de l ISS quand aucun diametre de NEO n est fourni', () => {
    const label = describeScale(1, {
      curve: EARTH_CURVE,
      references: [],
      neoDistancesKm: [],
      neoDiametersKm: [],
    })
    expect(label).toContain('tailles 1:1')
  })
})
