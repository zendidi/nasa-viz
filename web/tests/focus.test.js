import { describe, expect, it } from 'vitest'

import { FOCUSES, FOCUS_IDS, PLANET_FOCUS_IDS, neoEllipsesVisible } from '../src/focus.js'
import { AU_KM, readableDistance } from '../src/scale.js'

// FOCUSES est une table de config, pas un algorithme : son vrai mode de
// defaillance est une entree ajoutee a laquelle il manque un champ, ou dont la
// courbe n'est pas monotone. Les tests ci-dessous verifient donc la
// *completude* et la *coherence* de la table plutot que de redire ce que
// chaque champ vaut -- ils doivent attraper une dixieme entree mal formee
// sans avoir besoin d'etre mis a jour pour elle.

/** Cherche recursivement une valeur undefined dans un objet/tableau. */
function findUndefined(value, path = '') {
  if (value === undefined) return path || '(racine)'
  if (value === null || typeof value !== 'object') return null
  for (const key of Object.keys(value)) {
    const found = findUndefined(value[key], path ? `${path}.${key}` : key)
    if (found) return found
  }
  return null
}

describe('FOCUSES', () => {
  it('a une entree par frame de reference et par planete, et rien d autre', () => {
    // 2 frames (Terre, Soleil) + 7 planetes = 9, comme le documente CLAUDE.md.
    expect(Object.keys(FOCUSES).length).toBe(2 + PLANET_FOCUS_IDS.length)
    expect(Object.keys(FOCUSES).sort()).toEqual([...FOCUS_IDS].sort())
  })

  it('n a aucun champ undefined, dans aucune entree, a aucune profondeur', () => {
    for (const [key, focus] of Object.entries(FOCUSES)) {
      expect(findUndefined(focus), `FOCUSES.${key}`).toBeNull()
    }
  })

  it('chaque entree a la meme forme : les memes champs, du bon type', () => {
    for (const [key, focus] of Object.entries(FOCUSES)) {
      expect(focus.id, key).toBe(key)
      expect(typeof focus.label, key).toBe('string')
      expect(focus.label.length, key).toBeGreaterThan(0)
      expect(typeof focus.frame, key).toBe('string')
      expect(focus.frame.length, key).toBeGreaterThan(0)
      expect(['frame', 'planet'], key).toContain(focus.group)

      expect(typeof focus.curve, key).toBe('object')
      expect(Number.isFinite(focus.curve.a), key).toBe(true)
      expect(Number.isFinite(focus.curve.b), key).toBe(true)
      expect(Number.isFinite(focus.curve.minUnits), key).toBe(true)
      expect(focus.curve.minUnits, key).toBeGreaterThan(0)

      expect(Array.isArray(focus.rings), key).toBe(true)
      expect(focus.rings.length, key).toBeGreaterThan(0)
      for (const ring of focus.rings) {
        expect(typeof ring.km, key).toBe('number')
        expect(ring.km, key).toBeGreaterThan(0)
        expect(typeof ring.label, key).toBe('string')
        expect(ring.label.length, key).toBeGreaterThan(0)
      }

      expect(focus.reference, key).not.toBeNull()
      expect(typeof focus.reference.label, key).toBe('string')
      expect(focus.reference.label.length, key).toBeGreaterThan(0)
      expect(typeof focus.reference.km, key).toBe('number')
      expect(focus.reference.km, key).toBeGreaterThan(0)
    }
  })

  it('la cle de la table et le champ id de l entree concordent toujours', () => {
    for (const [key, focus] of Object.entries(FOCUSES)) {
      expect(focus.id).toBe(key)
    }
  })

  it('classe earth et sun en frame, et exactement les pivots planetaires en planet', () => {
    expect(FOCUSES.earth.group).toBe('frame')
    expect(FOCUSES.sun.group).toBe('frame')
    for (const id of PLANET_FOCUS_IDS) {
      expect(FOCUSES[id].group, id).toBe('planet')
    }
  })

  // Invariant documente dans docs/agent/decisions.md ("Une courbe par pivot,
  // avec un invariant", lot 3, 2026-09-29) : chaque pivot a sa propre courbe
  // lisible, et elle doit etre monotone croissante -- une courbe decroissante
  // dessinerait un corps lointain plus proche a l'ecran qu'un corps proche.
  it('chaque courbe de pivot a une pente positive (monotone croissante)', () => {
    for (const [key, focus] of Object.entries(FOCUSES)) {
      expect(focus.curve.b, key).toBeGreaterThan(0)
    }
  })

  it('readableDistance croit avec la distance reelle, pour chaque courbe de pivot', () => {
    // Verification comportementale de la meme invariant, via la fonction reelle
    // de scale.js plutot que via le seul signe de b : tolere le plateau du
    // plancher minUnits (non-decroissant), mais exige une croissance nette sur
    // l'ensemble de la plage.
    const samplesKm = [1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12]
    for (const [key, focus] of Object.entries(FOCUSES)) {
      const values = samplesKm.map((km) => readableDistance(km, focus.curve))
      for (let i = 1; i < values.length; i++) {
        expect(values[i], `${key} @ ${samplesKm[i]} km`).toBeGreaterThanOrEqual(values[i - 1])
      }
      expect(values[values.length - 1], key).toBeGreaterThan(values[0])
    }
  })

  it('les anneaux non absolus de chaque pivot sont dans l ordre croissant de km', () => {
    // Meme invariant de monotonie, cote presentation : les rayons de reference
    // sont ecrits dans focus.js dans l'ordre croissant (0,3x avant 3x, 0,5 ua
    // avant 2 ua avant 5 ua...) ; un anneau absolu (le 1 ua "Terre") n'est pas
    // concerne, puisqu'il n'est pas a l'echelle des autres.
    for (const [key, focus] of Object.entries(FOCUSES)) {
      const relative = focus.rings.filter((ring) => !ring.absolute)
      for (let i = 1; i < relative.length; i++) {
        expect(relative[i].km, key).toBeGreaterThan(relative[i - 1].km)
      }
    }
  })

  it('un anneau marque absolute vaut exactement 1 ua', () => {
    for (const [key, focus] of Object.entries(FOCUSES)) {
      for (const ring of focus.rings.filter((r) => r.absolute)) {
        expect(ring.km, key).toBeCloseTo(AU_KM, 6)
      }
    }
  })

  it('les distances au Soleil des pivots planetaires croissent de Mercure a Neptune', () => {
    // PLANET_FOCUS_IDS liste les planetes dans l'ordre du backend, c-a-d en
    // s'eloignant du Soleil (cf. commentaire de PLANET_LABELS dans focus.js).
    // reference.km, pour un pivot planetaire, est justement sa distance au
    // Soleil : Mercure doit etre plus proche que Neptune, et tout l'ordre doit
    // tenir, sans avoir a enumerer les planetes ici.
    const distances = PLANET_FOCUS_IDS.map((id) => FOCUSES[id].reference.km)
    for (let i = 1; i < distances.length; i++) {
      expect(distances[i], PLANET_FOCUS_IDS[i]).toBeGreaterThan(distances[i - 1])
    }
  })

  it('le pivot Terre reprend la Lune comme reference, a la bonne distance', () => {
    expect(FOCUSES.earth.reference.label).toBe('Lune')
    expect(FOCUSES.earth.reference.km).toBeCloseTo(384_400, 6)
  })

  it('le pivot Soleil reprend la Terre comme reference, a 1 ua', () => {
    expect(FOCUSES.sun.reference.label).toBe('Terre')
    expect(FOCUSES.sun.reference.km).toBeCloseTo(AU_KM, 6)
  })

  it('chaque pivot planetaire reprend le Soleil comme reference', () => {
    for (const id of PLANET_FOCUS_IDS) {
      expect(FOCUSES[id].reference.label, id).toBe('Soleil')
    }
  })

  it('formate les nombres a la francaise dans les libelles d anneau (virgule, pas point)', () => {
    // Contrat de mise en forme pin sur une entree ecrite a la main (pas
    // generee en boucle) : 0,5 ua et pas "0.5 ua".
    const ring = FOCUSES.sun.rings.find((r) => r.label.includes('0,5'))
    expect(ring).toBeDefined()
    expect(ring.label).toBe('0,5 ua')
    expect(ring.label).not.toMatch(/\./)
  })
})

describe('PLANET_FOCUS_IDS', () => {
  it('ne contient ni earth ni sun', () => {
    expect(PLANET_FOCUS_IDS).not.toContain('earth')
    expect(PLANET_FOCUS_IDS).not.toContain('sun')
  })

  it('contient exactement les entrees de FOCUSES dont le groupe est planet', () => {
    const planetKeys = Object.entries(FOCUSES)
      .filter(([, f]) => f.group === 'planet')
      .map(([key]) => key)
    expect([...PLANET_FOCUS_IDS].sort()).toEqual([...planetKeys].sort())
  })

  it('ne contient aucun doublon', () => {
    expect(new Set(PLANET_FOCUS_IDS).size).toBe(PLANET_FOCUS_IDS.length)
  })
})

describe('FOCUS_IDS', () => {
  it('liste earth puis sun, puis les planetes dans l ordre de PLANET_FOCUS_IDS', () => {
    expect(FOCUS_IDS).toEqual(['earth', 'sun', ...PLANET_FOCUS_IDS])
  })

  it('couvre exactement les cles de FOCUSES, sans doublon', () => {
    expect(new Set(FOCUS_IDS).size).toBe(FOCUS_IDS.length)
    expect([...FOCUS_IDS].sort()).toEqual(Object.keys(FOCUSES).sort())
  })
})

describe('neoEllipsesVisible', () => {
  // La regle de visibilite des ellipses NEO : Soleil ET 100 % reel, rien d'autre.
  // Le piege est le « t » anime : il arrive a 1 par un flottant, pas par egalite.
  it('ne montre les ellipses que depuis le Soleil, a l\'echelle reelle', () => {
    expect(neoEllipsesVisible('sun', 1)).toBe(true)
    expect(neoEllipsesVisible('sun', 1 - 1e-9)).toBe(true)
    expect(neoEllipsesVisible('sun', 7 / 8)).toBe(false)
    expect(neoEllipsesVisible('sun', 0)).toBe(false)
  })

  it('ne les montre depuis aucun autre pivot, meme a l\'echelle reelle', () => {
    for (const id of FOCUS_IDS.filter((id) => id !== 'sun')) {
      expect(neoEllipsesVisible(id, 1)).toBe(false)
    }
  })
})
