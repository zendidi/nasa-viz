import { describe, expect, it } from 'vitest'

import {
  EARTH_ORBIT,
  julianDate,
  orbitApsides,
  orbitNodes,
  orbitPosition,
  orbitSchematicSvg,
  sampleOrbit,
  sampleOrbitBetween,
} from '../src/orbit.js'

// orbit.js propage une ellipse képlérienne (fait géométrique, vérifiable
// indépendamment du code : la distance au foyer d'une ellipse d'éléments
// (a, e) vaut a(1-e) au périhélie et a(1+e) à l'aphélie, quelle que soit son
// orientation) et rend un schéma SVG en chaîne. Ces tests épinglent cette
// géométrie et la bonne formation du SVG produit -- pas la formule de
// propagation elle-même, qu'il serait vain de recalculer et comparer.

// Éléments orbitaux J2000 arbitraires mais non dégénérés, utilisés dans
// plusieurs tests pour éviter les coïncidences d'un orbit i_deg = 0 / node = 0.
const SAMPLE_ORBIT = {
  epoch_jd: 2451545.0,
  a_au: 1.5,
  e: 0.4,
  i_deg: 10,
  node_deg: 30,
  peri_deg: 50,
  mean_anomaly_deg: 20,
  period_days: 600,
}

describe('julianDate', () => {
  it('rend 2451545,0 pour l’époque J2000 (2000-01-01T12:00:00Z)', () => {
    // Fait externe : J2000.0 est défini comme JD 2451545.0 par convention astronomique.
    expect(julianDate(new Date(Date.UTC(2000, 0, 1, 12, 0, 0)))).toBeCloseTo(2451545.0, 6)
  })

  it('rend 2440587,5 pour l’époque Unix (1970-01-01T00:00:00Z)', () => {
    // Fait externe : conversion standard epoch Unix -> jour julien.
    expect(julianDate(new Date(0))).toBeCloseTo(2440587.5, 6)
  })
})

describe('orbitPosition', () => {
  it('place la Terre entre son périhélie et son aphélie réels tout au long de l’année', () => {
    // Fait externe : la distance Terre-Soleil reste entre a(1-e) et a(1+e),
    // borne géométrique de l'ellipse, indépendante de l'orientation (node/peri/i).
    const rMin = EARTH_ORBIT.a_au * (1 - EARTH_ORBIT.e)
    const rMax = EARTH_ORBIT.a_au * (1 + EARTH_ORBIT.e)
    for (let days = 0; days <= 365; days += 30) {
      const p = orbitPosition(EARTH_ORBIT, EARTH_ORBIT.epoch_jd + days)
      const r = Math.hypot(p.x, p.y, p.z)
      expect(r).toBeGreaterThanOrEqual(rMin - 1e-9)
      expect(r).toBeLessThanOrEqual(rMax + 1e-9)
    }
  })

  it('revient à la même position après une révolution complète', () => {
    // Invariant géométrique : une ellipse képlérienne est périodique par définition.
    const p0 = orbitPosition(SAMPLE_ORBIT, SAMPLE_ORBIT.epoch_jd)
    const p1 = orbitPosition(SAMPLE_ORBIT, SAMPLE_ORBIT.epoch_jd + SAMPLE_ORBIT.period_days)
    expect(p1.x).toBeCloseTo(p0.x, 6)
    expect(p1.y).toBeCloseTo(p0.y, 6)
    expect(p1.z).toBeCloseTo(p0.z, 6)
  })

  it('garde un rayon constant pour une orbite circulaire (e = 0)', () => {
    // Fait géométrique : un cercle centré sur le foyer a un rayon constant.
    const circular = { ...SAMPLE_ORBIT, e: 0 }
    for (const days of [0, 100, 250, 400, 599]) {
      const p = orbitPosition(circular, circular.epoch_jd + days)
      expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(circular.a_au, 9)
    }
  })
})

describe('sampleOrbit', () => {
  it('rend 181 points par défaut (count = 180, un point de plus pour boucler)', () => {
    expect(sampleOrbit(SAMPLE_ORBIT).length).toBe(181)
  })

  it('respecte le nombre de points demandé', () => {
    expect(sampleOrbit(SAMPLE_ORBIT, 12).length).toBe(13)
  })

  it('boucle : le premier et le dernier point coïncident (E = 0 et E = 2π)', () => {
    const points = sampleOrbit(SAMPLE_ORBIT, 40)
    const first = points[0]
    const last = points[points.length - 1]
    expect(last.x).toBeCloseTo(first.x, 9)
    expect(last.y).toBeCloseTo(first.y, 9)
    expect(last.z).toBeCloseTo(first.z, 9)
  })

  it('place tous les points à la même distance du Soleil pour une orbite circulaire', () => {
    const circular = { ...SAMPLE_ORBIT, e: 0 }
    const points = sampleOrbit(circular, 24)
    for (const p of points) {
      expect(Math.hypot(p.x, p.y, p.z)).toBeCloseTo(circular.a_au, 9)
    }
  })
})

describe('sampleOrbitBetween', () => {
  it('rend 121 points par défaut (count = 120)', () => {
    expect(sampleOrbitBetween(SAMPLE_ORBIT, 2451545, 2451545 + 600).length).toBe(121)
  })

  it('démarre et termine exactement sur orbitPosition(jdFrom) et orbitPosition(jdTo)', () => {
    const jdFrom = 2451545
    const jdTo = 2451545 + 600
    const points = sampleOrbitBetween(SAMPLE_ORBIT, jdFrom, jdTo, 30)
    const expectedStart = orbitPosition(SAMPLE_ORBIT, jdFrom)
    const expectedEnd = orbitPosition(SAMPLE_ORBIT, jdTo)
    // Composante par composante (et pas toEqual) : une composante nulle
    // pourrait être -0 selon le chemin de calcul, que toEqual distinguerait de +0.
    expect(points[0].x).toBeCloseTo(expectedStart.x, 12)
    expect(points[0].y).toBeCloseTo(expectedStart.y, 12)
    expect(points[0].z).toBeCloseTo(expectedStart.z, 12)
    expect(points[points.length - 1].x).toBeCloseTo(expectedEnd.x, 12)
    expect(points[points.length - 1].y).toBeCloseTo(expectedEnd.y, 12)
    expect(points[points.length - 1].z).toBeCloseTo(expectedEnd.z, 12)
  })
})

describe('orbitApsides', () => {
  it('place le périhélie à a(1-e) et l’aphélie à a(1+e) du Soleil', () => {
    // Fait géométrique définitionnel d'une ellipse, indépendant de
    // l'orientation (node/peri/i) : ne dépend que de a et e.
    const { perihelion, aphelion } = orbitApsides(SAMPLE_ORBIT)
    expect(Math.hypot(perihelion.x, perihelion.y, perihelion.z)).toBeCloseTo(
      SAMPLE_ORBIT.a_au * (1 - SAMPLE_ORBIT.e),
      9,
    )
    expect(Math.hypot(aphelion.x, aphelion.y, aphelion.z)).toBeCloseTo(
      SAMPLE_ORBIT.a_au * (1 + SAMPLE_ORBIT.e),
      9,
    )
  })

  it('confond périhélie et aphélie pour une orbite circulaire', () => {
    const circular = { ...SAMPLE_ORBIT, e: 0 }
    const { perihelion, aphelion } = orbitApsides(circular)
    expect(Math.hypot(perihelion.x, perihelion.y, perihelion.z)).toBeCloseTo(circular.a_au, 9)
    expect(Math.hypot(aphelion.x, aphelion.y, aphelion.z)).toBeCloseTo(circular.a_au, 9)
  })

  it('place le périhélie strictement plus près du Soleil que l’aphélie dès que e > 0', () => {
    const { perihelion, aphelion } = orbitApsides(SAMPLE_ORBIT)
    expect(Math.hypot(perihelion.x, perihelion.y, perihelion.z)).toBeLessThan(
      Math.hypot(aphelion.x, aphelion.y, aphelion.z),
    )
  })
})

describe('orbitNodes', () => {
  it('place les nœuds ascendant et descendant exactement sur le plan de l’écliptique (z = 0)', () => {
    // Fait géométrique définitionnel : un nœud est par définition le point où
    // l'orbite traverse le plan de référence (z = 0 en coordonnées écliptiques).
    const { ascending, descending } = orbitNodes(SAMPLE_ORBIT)
    expect(ascending.z).toBeCloseTo(0, 9)
    expect(descending.z).toBeCloseTo(0, 9)
  })

  it('place les deux nœuds à une distance du Soleil comprise entre périhélie et aphélie', () => {
    const { ascending, descending } = orbitNodes(SAMPLE_ORBIT)
    const rMin = SAMPLE_ORBIT.a_au * (1 - SAMPLE_ORBIT.e)
    const rMax = SAMPLE_ORBIT.a_au * (1 + SAMPLE_ORBIT.e)
    const rAsc = Math.hypot(ascending.x, ascending.y, ascending.z)
    const rDesc = Math.hypot(descending.x, descending.y, descending.z)
    expect(rAsc).toBeGreaterThanOrEqual(rMin - 1e-9)
    expect(rAsc).toBeLessThanOrEqual(rMax + 1e-9)
    expect(rDesc).toBeGreaterThanOrEqual(rMin - 1e-9)
    expect(rDesc).toBeLessThanOrEqual(rMax + 1e-9)
  })
})

// --- orbitSchematicSvg ------------------------------------------------------
//
// Le SVG est produit comme une chaîne : on le vérifie comme une chaîne, sans
// DOM (aucun test navigateur, refus permanent de l'utilisateur). Le mode de
// défaillance réel de ce genre de code est un "NaN" ou un "undefined" glissé
// dans un attribut numérique, ou une balise mal fermée -- c'est ce qu'on épingle.

const VOID_ELEMENTS = new Set([
  'br', 'img', 'hr', 'input', 'meta', 'link', 'area', 'base', 'col', 'embed', 'param', 'source', 'track', 'wbr',
])

/** Vérifie l'appariement des balises ouvrantes/fermantes d'un fragment HTML/SVG en chaîne. */
function tagsAreBalanced(markup) {
  const stack = []
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g
  let match
  while ((match = tagRe.exec(markup))) {
    const whole = match[0]
    const name = match[1].toLowerCase()
    if (VOID_ELEMENTS.has(name)) continue
    if (whole.startsWith('</')) {
      if (stack.pop() !== name) return false
    } else if (!whole.endsWith('/>')) {
      stack.push(name)
    }
  }
  return stack.length === 0
}

/** Extrait tous les couples de coordonnées "x,y" des attributs `d` des `<path>`. */
function pathCoordinates(svg, pathIndex) {
  const paths = [...svg.matchAll(/<path d="([^"]*)"/g)]
  return [...paths[pathIndex][1].matchAll(/(-?\d+\.\d+),(-?\d+\.\d+)/g)].map((m) => [Number(m[1]), Number(m[2])])
}

const OPTIONS = { now: new Date('2026-01-15T00:00:00Z'), approachAt: null, hazardous: false }

describe('orbitSchematicSvg', () => {
  it('produit un SVG bien formé pour une orbite valide', () => {
    const svg = orbitSchematicSvg(SAMPLE_ORBIT, OPTIONS)
    expect(svg).toContain('<svg')
    expect(svg).toContain('viewBox="0 0 260 260"')
    expect(tagsAreBalanced(svg)).toBe(true)
    expect(svg).not.toContain('NaN')
    expect(svg).not.toContain('undefined')
  })

  it('reste bien formé avec une approche renseignée et un objet hasardeux', () => {
    const svg = orbitSchematicSvg(SAMPLE_ORBIT, {
      now: new Date('2026-01-15T00:00:00Z'),
      approachAt: new Date('2026-06-01T00:00:00Z'),
      hazardous: true,
    })
    expect(tagsAreBalanced(svg)).toBe(true)
    expect(svg).not.toContain('NaN')
    expect(svg).not.toContain('undefined')
    expect(svg).toContain('#ff4d4d') // couleur "hasardeux"
  })

  it.each([
    ['orbite absente', null],
    ['excentricité négative', { ...SAMPLE_ORBIT, e: -0.1 }],
    ['excentricité = 1 (parabolique, hors du domaine promis)', { ...SAMPLE_ORBIT, e: 1 }],
    ['excentricité > 1 (hyperbolique)', { ...SAMPLE_ORBIT, e: 1.5 }],
    ['demi-grand axe nul', { ...SAMPLE_ORBIT, a_au: 0 }],
    ['demi-grand axe négatif', { ...SAMPLE_ORBIT, a_au: -1 }],
    ['demi-grand axe absent', (() => { const { a_au, ...rest } = SAMPLE_ORBIT; return rest })()],
  ])("rend '' pour une orbite qu'il ne peut pas dessiner : %s", (_label, orbit) => {
    expect(orbitSchematicSvg(orbit, OPTIONS)).toBe('')
  })

  it('dessine sans NaN une orbite quasi circulaire (e = 0)', () => {
    const circular = { ...SAMPLE_ORBIT, e: 0 }
    const svg = orbitSchematicSvg(circular, OPTIONS)
    expect(tagsAreBalanced(svg)).toBe(true)
    expect(svg).not.toContain('NaN')
  })

  it('dessine sans NaN une orbite quasi parabolique (e = 0,999, juste sous la limite promise)', () => {
    const nearParabolic = { ...SAMPLE_ORBIT, e: 0.999 }
    const svg = orbitSchematicSvg(nearParabolic, OPTIONS)
    expect(tagsAreBalanced(svg)).toBe(true)
    expect(svg).not.toContain('NaN')
  })

  it('se passe de period_days (champ optionnel, calcule le mouvement moyen par la constante de Gauss)', () => {
    const { period_days, ...withoutPeriod } = SAMPLE_ORBIT
    const svg = orbitSchematicSvg(withoutPeriod, OPTIONS)
    expect(tagsAreBalanced(svg)).toBe(true)
    expect(svg).not.toContain('NaN')
    expect(svg).not.toContain('période') // rien à afficher sans période connue
  })

  it('dessine une figure symétrique pour une orbite circulaire', () => {
    // e = 0 : le Soleil est au centre du cercle, donc l'étendue en x doit
    // égaler l'étendue en y de la trajectoire dessinée.
    const circular = { epoch_jd: 2451545.0, a_au: 1, e: 0, i_deg: 0, node_deg: 0, peri_deg: 0, mean_anomaly_deg: 0, period_days: 365.25 }
    const svg = orbitSchematicSvg(circular, OPTIONS)
    const coords = pathCoordinates(svg, 1) // path[0] = orbite terrestre, path[1] = NEO "au-dessus"
    const xs = coords.map((c) => c[0])
    const ys = coords.map((c) => c[1])
    const xExtent = Math.max(...xs) - Math.min(...xs)
    const yExtent = Math.max(...ys) - Math.min(...ys)
    expect(xExtent).toBeCloseTo(yExtent, 1)
  })

  it('dessine une figure allongée pour une orbite très excentrique', () => {
    // peri_deg = node_deg = i_deg = 0 aligne le grand axe sur x : l'étendue en
    // x (proche de a(1+e)) doit nettement dépasser l'étendue en y (proche de
    // b = a*sqrt(1-e²)).
    const eccentric = { epoch_jd: 2451545.0, a_au: 1, e: 0.7, i_deg: 0, node_deg: 0, peri_deg: 0, mean_anomaly_deg: 0, period_days: 365.25 }
    const svg = orbitSchematicSvg(eccentric, OPTIONS)
    const coords = pathCoordinates(svg, 1)
    const xs = coords.map((c) => c[0])
    const ys = coords.map((c) => c[1])
    const xExtent = Math.max(...xs) - Math.min(...xs)
    const yExtent = Math.max(...ys) - Math.min(...ys)
    expect(xExtent).toBeGreaterThan(yExtent * 1.3)
  })

  it('garde toutes les coordonnées dans le viewBox, même pour une orbite très étirée', () => {
    const stretched = { epoch_jd: 2451545.0, a_au: 3, e: 0.95, i_deg: 15, node_deg: 40, peri_deg: 60, mean_anomaly_deg: 0, period_days: 2000 }
    const svg = orbitSchematicSvg(stretched, OPTIONS)
    const allCoords = [0, 1, 2].flatMap((i) => pathCoordinates(svg, i))
    for (const [x, y] of allCoords) {
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(260)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(260)
    }
  })
})
