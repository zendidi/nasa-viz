import { describe, expect, it } from 'vitest'

import {
  NEO_CREDITS,
  NEO_DEFAULT_COLOR,
  NEO_HAZARD_COLOR,
  TAXONOMY,
  cssColor,
  detailsBlockHtml,
  escapeHtml,
  neoTooltipSuffix,
  sourcesBlockHtml,
  sourcesPanelHtml,
  taxonomyKey,
} from '../src/neoInfo.js'

// neoInfo.js met en forme des donnees qui viennent de trois catalogues (JPL,
// NASA NeoWs, ESA NEOCC) et deux fiches (JPL SBDB, IMCCE ssoCard) qui ne
// remplissent pas les memes champs. Le vrai mode de defaillance d'un
// formateur est la donnee manquante : null, undefined, 0, chaine vide, champ
// absent. Les tests ci-dessous construisent donc des objets a la main, dans
// la forme documentee par backend/API.md, plutot que d'appeler l'API.

describe('NEO_DEFAULT_COLOR / NEO_HAZARD_COLOR', () => {
  it('sont deux couleurs hexadecimales distinctes', () => {
    expect(typeof NEO_DEFAULT_COLOR).toBe('number')
    expect(typeof NEO_HAZARD_COLOR).toBe('number')
    expect(NEO_DEFAULT_COLOR).not.toBe(NEO_HAZARD_COLOR)
  })
})

describe('TAXONOMY', () => {
  it('a une couleur et un libelle non vide pour chaque complexe', () => {
    for (const [key, entry] of Object.entries(TAXONOMY)) {
      expect(typeof entry.color, key).toBe('number')
      expect(entry.color, key).toBeGreaterThanOrEqual(0)
      expect(entry.color, key).toBeLessThanOrEqual(0xffffff)
      expect(typeof entry.label, key).toBe('string')
      expect(entry.label.length, key).toBeGreaterThan(0)
    }
  })

  it('contient une entree other, filet de securite pour un complexe inconnu', () => {
    expect(TAXONOMY.other).toBeDefined()
  })
})

describe('taxonomyKey', () => {
  it('rend le complexe tel quel quand il est connu de TAXONOMY', () => {
    expect(taxonomyKey('S')).toBe('S')
    expect(taxonomyKey('C')).toBe('C')
    expect(taxonomyKey('X')).toBe('X')
    expect(taxonomyKey('V')).toBe('V')
  })

  it('retombe sur other pour un complexe inconnu mais present', () => {
    expect(taxonomyKey('Q')).toBe('other')
  })

  it('rend null pour une absence de complexe (null, undefined, chaine vide)', () => {
    expect(taxonomyKey(null)).toBeNull()
    expect(taxonomyKey(undefined)).toBeNull()
    expect(taxonomyKey('')).toBeNull()
  })
})

describe('cssColor', () => {
  it('formate en #rrggbb minuscule', () => {
    expect(cssColor(0x7fe0ff)).toBe('#7fe0ff')
  })

  it('remplit de zeros a gauche (0 et une couleur courte)', () => {
    expect(cssColor(0)).toBe('#000000')
    expect(cssColor(0xff)).toBe('#0000ff')
  })
})

describe('escapeHtml', () => {
  it('echappe les cinq caracteres speciaux HTML', () => {
    expect(escapeHtml('&')).toBe('&amp;')
    expect(escapeHtml('<')).toBe('&lt;')
    expect(escapeHtml('>')).toBe('&gt;')
    expect(escapeHtml('"')).toBe('&quot;')
    expect(escapeHtml("'")).toBe('&#39;')
  })

  it('echappe une combinaison, dans une chaine qui n a rien de special par ailleurs', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;')
  })

  it('laisse une chaine sans caractere special intacte', () => {
    expect(escapeHtml('2004 MN4')).toBe('2004 MN4')
  })

  it('convertit une valeur non-chaine en chaine avant d echapper (0 -> "0")', () => {
    // Utilise par les appelants pour un champ numerique ; 0 ne doit jamais
    // disparaitre ni devenir une chaine vide.
    expect(escapeHtml(0)).toBe('0')
  })
})

describe('neoTooltipSuffix', () => {
  it('rend une chaine vide sans comparison', () => {
    expect(neoTooltipSuffix({})).toBe('')
  })

  it('signale une seule source absente', () => {
    const neo = {
      comparison: {
        jpl_cad: { status: 'missing', reason: 'unknown' },
        nasa_neows: { status: 'found', mismatches: [] },
        esa_neocc: { status: 'found' },
      },
    }
    expect(neoTooltipSuffix(neo)).toBe(' · absent de JPL')
  })

  it('joint deux sources absentes avec "et", et utilise le nom court de l ESA', () => {
    const neo = {
      comparison: {
        jpl_cad: { status: 'missing', reason: 'unknown' },
        nasa_neows: { status: 'found', mismatches: [] },
        esa_neocc: { status: 'missing', reason: 'unknown' },
      },
    }
    expect(neoTooltipSuffix(neo)).toBe(" · absent de JPL et l'ESA")
  })

  it('signale un ecart JPL/ESA hors marge quand rien n est absent', () => {
    const neo = {
      comparison: {
        jpl_cad: { status: 'found' },
        nasa_neows: { status: 'found', mismatches: [] },
        esa_neocc: { status: 'found', within_jpl_uncertainty: false },
      },
    }
    expect(neoTooltipSuffix(neo)).toBe(' · écart JPL/ESA')
  })

  it('signale un ecart JPL/NASA quand ESA est dans la marge', () => {
    const neo = {
      comparison: {
        jpl_cad: { status: 'found' },
        nasa_neows: { status: 'found', mismatches: [{ field: 'dist_km' }] },
        esa_neocc: { status: 'found', within_jpl_uncertainty: true },
      },
    }
    expect(neoTooltipSuffix(neo)).toBe(' · écart JPL/NASA')
  })

  it('ne signale rien quand les trois sources concordent', () => {
    const neo = {
      comparison: {
        jpl_cad: { status: 'found' },
        nasa_neows: { status: 'found', mismatches: [] },
        esa_neocc: { status: 'found', within_jpl_uncertainty: true },
      },
    }
    expect(neoTooltipSuffix(neo)).toBe('')
  })

  it('priorise l absence sur un ecart : une source absente masque le reste', () => {
    const neo = {
      comparison: {
        jpl_cad: { status: 'missing', reason: 'unknown' },
        nasa_neows: { status: 'found', mismatches: [{ field: 'dist_km' }] },
        esa_neocc: { status: 'found', within_jpl_uncertainty: false },
      },
    }
    expect(neoTooltipSuffix(neo)).toBe(' · absent de JPL')
  })
})

describe('sourcesPanelHtml', () => {
  it('affiche le message de cache pre-comparaison quand comparison ou sources manque', () => {
    const html = sourcesPanelHtml({})
    expect(html).toContain('flux en cache')
    expect(html).not.toContain('undefined')
  })

  it('liste les sources indisponibles', () => {
    const feed = {
      sources: { jpl_cad: 'ok', nasa_neows: 'unavailable', esa_neocc: 'ok' },
      comparison: {
        nasa_neows: { missing: 0, mismatched: 0 },
        jpl_cad: { missing: 0 },
        esa_neocc: { found: 0, missing: 0 },
      },
      objects: [],
    }
    const html = sourcesPanelHtml(feed)
    expect(html).toContain('indisponible : NASA NeoWs')
  })

  it('n accorde pas de "s" a un seul absent, mais oui a partir de deux (seuil de pluriel)', () => {
    const base = {
      sources: { jpl_cad: 'ok', nasa_neows: 'ok', esa_neocc: 'ok' },
      objects: [],
    }
    const one = sourcesPanelHtml({
      ...base,
      comparison: { nasa_neows: { missing: 1, mismatched: 0 }, jpl_cad: { missing: 0 }, esa_neocc: { found: 0, missing: 0 } },
    })
    expect(one).toContain('1 absent de NASA')
    expect(one).not.toContain('1 absents de NASA')

    const two = sourcesPanelHtml({
      ...base,
      comparison: { nasa_neows: { missing: 2, mismatched: 0 }, jpl_cad: { missing: 0 }, esa_neocc: { found: 0, missing: 0 } },
    })
    expect(two).toContain('2 absents de NASA')
  })

  it('annonce des sources concordantes quand il n y a aucun ecart', () => {
    const feed = {
      sources: { jpl_cad: 'ok', nasa_neows: 'ok', esa_neocc: 'ok' },
      comparison: {
        nasa_neows: { missing: 0, mismatched: 0 },
        jpl_cad: { missing: 0 },
        esa_neocc: { found: 0, missing: 0 },
      },
      objects: [],
    }
    expect(sourcesPanelHtml(feed)).toContain('concordantes')
  })

  it('calcule l ecart median ESA quand il y a des objets compares, et l omet sinon', () => {
    const withDiffs = {
      sources: { jpl_cad: 'ok', nasa_neows: 'ok', esa_neocc: 'ok' },
      comparison: {
        nasa_neows: { missing: 0, mismatched: 0 },
        jpl_cad: { missing: 0 },
        esa_neocc: { found: 3, missing: 0, outside_jpl_uncertainty: 0, different_date: 0 },
      },
      objects: [
        { comparison: { esa_neocc: { distance_diff_km: -100 } } },
        { comparison: { esa_neocc: { distance_diff_km: 300 } } },
        { comparison: { esa_neocc: { distance_diff_km: 200 } } },
      ],
    }
    const html = sourcesPanelHtml(withDiffs)
    expect(html).toContain('3/3 concordants')
    expect(html).toContain('écart médian 200 km') // mediane de [100, 200, 300]

    const withoutDiffs = {
      ...withDiffs,
      comparison: {
        ...withDiffs.comparison,
        esa_neocc: { found: 0, missing: 0, outside_jpl_uncertainty: 0, different_date: 0 },
      },
      objects: [],
    }
    // esaCovered = 0 : le bloc ESA est omis entierement.
    expect(sourcesPanelHtml(withoutDiffs)).not.toContain('concordants')
  })

  it('tronque la liste des objets en ecart a 6, avec des points de suspension au-dela', () => {
    const makeFeed = (n) => ({
      sources: { jpl_cad: 'ok', nasa_neows: 'ok', esa_neocc: 'ok' },
      comparison: {
        nasa_neows: { missing: 0, mismatched: 0 },
        jpl_cad: { missing: 0 },
        esa_neocc: { found: 0, missing: 0 },
      },
      objects: Array.from({ length: n }, (_, i) => ({
        designation: `OBJ${i}`,
        comparison: {
          jpl_cad: { status: 'found' },
          nasa_neows: { status: 'found', mismatches: [{ field: 'dist_km' }] },
          esa_neocc: { status: 'found', within_jpl_uncertainty: true },
        },
      })),
    })

    const six = sourcesPanelHtml(makeFeed(6))
    expect(six).toContain('OBJ5')
    expect(six).not.toContain('…')

    const seven = sourcesPanelHtml(makeFeed(7))
    expect(seven).toContain('OBJ5')
    expect(seven).not.toContain('OBJ6')
    expect(seven).toContain('…')
  })
})

describe('sourcesBlockHtml', () => {
  it('rend une chaine vide sans comparison', () => {
    expect(sourcesBlockHtml({})).toBe('')
  })

  it('marque JPL comme reference quand il est trouve', () => {
    const neo = {
      comparison: {
        jpl_cad: { status: 'found' },
        nasa_neows: { status: 'found', mismatches: [] },
        esa_neocc: { status: 'found', distance_km: 100, distance_diff_km: 0, within_jpl_uncertainty: true, jpl_uncertainty_km: 10 },
      },
    }
    const html = sourcesBlockHtml(neo)
    expect(html).toContain('<strong>JPL CAD</strong> ✓')
    expect(html).toContain('référence')
  })

  it('explique l absence de JPL avec la raison', () => {
    const neo = {
      comparison: {
        jpl_cad: { status: 'missing', reason: 'date_boundary' },
        nasa_neows: { status: 'found', mismatches: [] },
        esa_neocc: { status: 'missing', reason: 'unknown' },
      },
    }
    const html = sourcesBlockHtml(neo)
    expect(html).toContain('approche en limite de période')
  })

  it('signale NASA comme seule source quand JPL est absent', () => {
    const neo = {
      comparison: {
        jpl_cad: { status: 'missing', reason: 'unknown' },
        nasa_neows: { status: 'found', mismatches: [] },
        esa_neocc: { status: 'missing', reason: 'unknown' },
      },
    }
    expect(sourcesBlockHtml(neo)).toContain('seule source à lister cet objet ici')
  })

  it('liste les champs en ecart NASA/JPL quand mismatches n est pas vide, sinon "identique"', () => {
    const withMismatch = sourcesBlockHtml({
      comparison: {
        jpl_cad: { status: 'found' },
        nasa_neows: { status: 'found', mismatches: [{ field: 'dist_km' }, { field: 'date' }] },
        esa_neocc: { status: 'missing', reason: 'unknown' },
      },
    })
    expect(withMismatch).toContain('écart sur dist_km, date')

    const noMismatch = sourcesBlockHtml({
      comparison: {
        jpl_cad: { status: 'found' },
        nasa_neows: { status: 'found', mismatches: [] },
        esa_neocc: { status: 'missing', reason: 'unknown' },
      },
    })
    expect(noMismatch).toContain('identique à JPL')
  })

  it('signe l ecart ESA avec + / − / rien selon le signe exact, y compris a zero', () => {
    const build = (distance_diff_km) =>
      sourcesBlockHtml({
        comparison: {
          jpl_cad: { status: 'found' },
          nasa_neows: { status: 'found', mismatches: [] },
          esa_neocc: {
            status: 'found',
            distance_km: 6_200_297,
            distance_diff_km,
            jpl_uncertainty_km: 41_973,
            within_jpl_uncertainty: true,
          },
        },
      })

    expect(build(1386.8)).toContain('écart +1 387 km')
    expect(build(-1386.8)).toContain('écart −1 387 km') // U+2212, pas un trait d'union
    expect(build(0)).toContain('écart 0 km')
    expect(build(0)).not.toContain('écart +0')
    expect(build(0)).not.toContain('écart −0')
  })

  it('bascule dans/hors la marge JPL selon within_jpl_uncertainty', () => {
    const within = sourcesBlockHtml({
      comparison: {
        jpl_cad: { status: 'found' },
        nasa_neows: { status: 'found', mismatches: [] },
        esa_neocc: { status: 'found', distance_km: 1, distance_diff_km: 0, jpl_uncertainty_km: 1, within_jpl_uncertainty: true },
      },
    })
    expect(within).toContain('(dans la marge JPL')
    expect(within).toContain('class="muted"')

    const outside = sourcesBlockHtml({
      comparison: {
        jpl_cad: { status: 'found' },
        nasa_neows: { status: 'found', mismatches: [] },
        esa_neocc: { status: 'found', distance_km: 1, distance_diff_km: 0, jpl_uncertainty_km: 1, within_jpl_uncertainty: false },
      },
    })
    expect(outside).toContain('(hors de la marge JPL')
    expect(outside).toContain('class="warn"')
  })

  it('n affiche le decalage de date que lorsqu il est different de zero', () => {
    const zero = sourcesBlockHtml({
      comparison: {
        jpl_cad: { status: 'found' },
        nasa_neows: { status: 'found', mismatches: [] },
        esa_neocc: {
          status: 'found', distance_km: 1, distance_diff_km: 0,
          jpl_uncertainty_km: 1, within_jpl_uncertainty: true, date_diff_days: 0,
        },
      },
    })
    expect(zero).not.toContain('date décalée')

    const one = sourcesBlockHtml({
      comparison: {
        jpl_cad: { status: 'found' },
        nasa_neows: { status: 'found', mismatches: [] },
        esa_neocc: {
          status: 'found', distance_km: 1, distance_diff_km: 0,
          jpl_uncertainty_km: 1, within_jpl_uncertainty: true, date_diff_days: 1,
        },
      },
    })
    expect(one).toContain('date décalée de 1 j')
  })

  it('explique l absence de l ESA de facon specifique (portee < 0,05 ua)', () => {
    const html = sourcesBlockHtml({
      comparison: {
        jpl_cad: { status: 'found' },
        nasa_neows: { status: 'found', mismatches: [] },
        esa_neocc: { status: 'not_covered' },
      },
    })
    // Passe par escapeHtml : l'apostrophe et le "<" sortent entites.
    expect(html).toContain("non couvert (l&#39;ESA ne liste que &lt; 0,05 ua)")
  })

  it('affiche le risque d impact seulement quand Sentry ou l ESA le surveille', () => {
    const none = sourcesBlockHtml({
      comparison: {
        jpl_cad: { status: 'found' },
        nasa_neows: { status: 'found', mismatches: [] },
        esa_neocc: { status: 'missing', reason: 'unknown' },
        impact_risk_lists: { jpl_sentry: false, esa_neocc: false, agree: true },
      },
    })
    expect(none).not.toContain("Risque d'impact")

    const monitored = sourcesBlockHtml({
      comparison: {
        jpl_cad: { status: 'found' },
        nasa_neows: { status: 'found', mismatches: [] },
        esa_neocc: { status: 'missing', reason: 'unknown' },
        impact_risk_lists: { jpl_sentry: true, esa_neocc: false, agree: false },
      },
    })
    expect(monitored).toContain("Risque d'impact")
    expect(monitored).toContain('Sentry oui')
    expect(monitored).toContain('ESA non')
    expect(monitored).toContain('désaccord')
  })

  it('ajoute la note "JPL est la source de reference" seulement quand JPL est absent', () => {
    const missingJpl = sourcesBlockHtml({
      comparison: {
        jpl_cad: { status: 'unavailable' },
        nasa_neows: { status: 'found', mismatches: [] },
        esa_neocc: { status: 'missing', reason: 'unknown' },
      },
    })
    expect(missingJpl).toContain('JPL est la source de référence')

    const withJpl = sourcesBlockHtml({
      comparison: {
        jpl_cad: { status: 'found' },
        nasa_neows: { status: 'found', mismatches: [] },
        esa_neocc: { status: 'missing', reason: 'unknown' },
      },
    })
    expect(withJpl).not.toContain('JPL est la source de référence')
  })
})

describe('detailsBlockHtml', () => {
  it('affiche un message de chargement quand details est undefined', () => {
    const html = detailsBlockHtml(undefined, { loading: true, error: null })
    expect(html).toContain('chargement')
    expect(html).not.toContain('undefined')
  })

  it('affiche le message "non chargee" quand details est undefined et rien ne charge', () => {
    const html = detailsBlockHtml(undefined, { loading: false, error: null })
    expect(html).toContain('non chargée')
  })

  it('affiche l erreur plutot que le message de chargement si les deux sont presents', () => {
    const html = detailsBlockHtml(undefined, { loading: true, error: 'panne réseau' })
    expect(html).toContain('panne réseau')
    expect(html).not.toContain('chargement')
  })

  it('affiche "objet inconnu" quand details est null (connu d aucun catalogue)', () => {
    const html = detailsBlockHtml(null, { loading: false, error: null })
    expect(html).toContain('inconnu')
  })

  it('n affiche aucun champ physique absent (tous a null), sans jamais de NaN ni undefined', () => {
    const details = {
      orbit_class: null,
      taxonomy: null,
      diameter_km: null,
      albedo: null,
      absolute_magnitude_h: null,
      moid_earth_au: null,
      rotation_period_h: null,
      mass_kg: null,
      density_kg_m3: null,
      impact_risk: null,
      links: { jpl: 'https://example.test/jpl', ssocard: null },
    }
    const html = detailsBlockHtml(details, { loading: false, error: null })
    expect(html).not.toMatch(/NaN/)
    expect(html).not.toContain('undefined')
    // Ni taxonomie ni diametre : le message d'aide dedie doit apparaitre.
    expect(html).toContain('Ni taxonomie ni diamètre mesuré')
    expect(html).toContain('href="https://example.test/jpl"')
  })

  it('affiche une magnitude absolue et un MOID egaux a zero (0 n est pas une absence)', () => {
    // absolute_magnitude_h et moid_earth_au sont testes contre `!== null`,
    // donc 0 est une valeur legitime qui doit s afficher, pas etre traitee
    // comme manquante.
    const details = {
      orbit_class: null, taxonomy: null, diameter_km: null, albedo: null,
      absolute_magnitude_h: 0, moid_earth_au: 0, rotation_period_h: null,
      mass_kg: null, density_kg_m3: null, impact_risk: null,
      links: { jpl: 'https://example.test/jpl', ssocard: null },
    }
    const html = detailsBlockHtml(details, { loading: false, error: null })
    expect(html).toContain('Magnitude absolue H</strong> 0<')
    expect(html).toContain('MOID Terre</strong> 0 ua')
  })

  it('formate le diametre en metres, arrondi, avec sa source', () => {
    const details = {
      orbit_class: null, taxonomy: null,
      diameter_km: { value: 0.34, source: 'ssocard' },
      albedo: null, absolute_magnitude_h: null, moid_earth_au: null,
      rotation_period_h: null, mass_kg: null, density_kg_m3: null,
      impact_risk: null, links: { jpl: 'https://example.test/jpl', ssocard: null },
    }
    const html = detailsBlockHtml(details, { loading: false, error: null })
    expect(html).toContain('340 m')
    expect(html).toContain('(IMCCE)')
  })

  it('credite JPL plutot qu IMCCE quand la source du diametre n est pas ssocard', () => {
    const details = {
      orbit_class: null, taxonomy: null,
      diameter_km: { value: 1, source: 'sbdb' },
      albedo: null, absolute_magnitude_h: null, moid_earth_au: null,
      rotation_period_h: null, mass_kg: null, density_kg_m3: null,
      impact_risk: null, links: { jpl: 'https://example.test/jpl', ssocard: null },
    }
    expect(detailsBlockHtml(details, { loading: false, error: null })).toContain('(JPL)')
  })

  it('formate l albedo a 3 decimales, a la francaise', () => {
    const details = {
      orbit_class: null, taxonomy: null, diameter_km: null,
      albedo: { value: 0.3838 },
      absolute_magnitude_h: null, moid_earth_au: null, rotation_period_h: null,
      mass_kg: null, density_kg_m3: null, impact_risk: null,
      links: { jpl: 'https://example.test/jpl', ssocard: null },
    }
    expect(detailsBlockHtml(details, { loading: false, error: null })).toContain('Albédo</strong> 0,384<')
  })

  it('formate le MOID en ua a 5 decimales et rappelle la distance en km', () => {
    const details = {
      orbit_class: null, taxonomy: null, diameter_km: null, albedo: null,
      absolute_magnitude_h: null, moid_earth_au: 0.000107917, rotation_period_h: null,
      mass_kg: null, density_kg_m3: null, impact_risk: null,
      links: { jpl: 'https://example.test/jpl', ssocard: null },
    }
    const html = detailsBlockHtml(details, { loading: false, error: null })
    expect(html).toContain('0,00011 ua')
    expect(html).toContain(`16${' '}144 km`) // 0,000107917 ua * 149 597 870,7 km/ua, arrondi
  })

  it('formate la masse en notation exponentielle avec virgule decimale', () => {
    const details = {
      orbit_class: null, taxonomy: null, diameter_km: null, albedo: null,
      absolute_magnitude_h: null, moid_earth_au: null, rotation_period_h: null,
      mass_kg: 6.1e10, density_kg_m3: null, impact_risk: null,
      links: { jpl: 'https://example.test/jpl', ssocard: null },
    }
    const html = detailsBlockHtml(details, { loading: false, error: null })
    expect(html).toContain('Masse</strong> 6,10e+10 kg')
  })

  it('affiche le type spectral avec sa pastille de couleur et son libelle', () => {
    const details = {
      orbit_class: null,
      taxonomy: { class: 'Sq', complex: 'S' },
      diameter_km: null, albedo: null, absolute_magnitude_h: null, moid_earth_au: null,
      rotation_period_h: null, mass_kg: null, density_kg_m3: null, impact_risk: null,
      links: { jpl: 'https://example.test/jpl', ssocard: null },
    }
    const html = detailsBlockHtml(details, { loading: false, error: null })
    expect(html).toContain('Sq')
    expect(html).toContain('S · silicaté')
    expect(html).toContain(cssColor(TAXONOMY.S.color))
    // Une taxonomie presente : le message "ni taxonomie ni diametre" ne doit pas apparaitre.
    expect(html).not.toContain('Ni taxonomie ni diamètre')
  })

  it('retombe sur le libelle "other" pour un complexe non catalogue', () => {
    const details = {
      orbit_class: null,
      taxonomy: { class: 'Z', complex: 'Z' },
      diameter_km: null, albedo: null, absolute_magnitude_h: null, moid_earth_au: null,
      rotation_period_h: null, mass_kg: null, density_kg_m3: null, impact_risk: null,
      links: { jpl: 'https://example.test/jpl', ssocard: null },
    }
    expect(detailsBlockHtml(details, { loading: false, error: null })).toContain('autre type')
  })

  it('echappe le nom de la classe orbitale (donnee externe non fiable)', () => {
    const details = {
      orbit_class: { code: 'ATE', name: 'Aten <script>' },
      taxonomy: null, diameter_km: null, albedo: null, absolute_magnitude_h: null,
      moid_earth_au: null, rotation_period_h: null, mass_kg: null, density_kg_m3: null,
      impact_risk: null, links: { jpl: 'https://example.test/jpl', ssocard: null },
    }
    const html = detailsBlockHtml(details, { loading: false, error: null })
    expect(html).toContain('Aten &lt;script&gt;')
    expect(html).not.toContain('<script>')
  })

  it('ajoute le lien SsODNet seulement quand il existe', () => {
    const withLink = detailsBlockHtml(
      {
        orbit_class: null, taxonomy: null, diameter_km: null, albedo: null,
        absolute_magnitude_h: null, moid_earth_au: null, rotation_period_h: null,
        mass_kg: null, density_kg_m3: null, impact_risk: null,
        links: { jpl: 'https://example.test/jpl', ssocard: 'https://example.test/ssocard' },
      },
      { loading: false, error: null },
    )
    expect(withLink).toContain('SsODNet')

    const withoutLink = detailsBlockHtml(
      {
        orbit_class: null, taxonomy: null, diameter_km: null, albedo: null,
        absolute_magnitude_h: null, moid_earth_au: null, rotation_period_h: null,
        mass_kg: null, density_kg_m3: null, impact_risk: null,
        links: { jpl: 'https://example.test/jpl', ssocard: null },
      },
      { loading: false, error: null },
    )
    expect(withoutLink).not.toContain('SsODNet')
  })

  it('affiche le risque d impact avec ses trois indicateurs, et l intervalle quand il existe', () => {
    const details = {
      orbit_class: null, taxonomy: null, diameter_km: null, albedo: null,
      absolute_magnitude_h: null, moid_earth_au: null, rotation_period_h: null,
      mass_kg: null, density_kg_m3: null,
      impact_risk: { probability: 3.2e-5, palermo_cum: -2.15, torino_max: 1, range: '2029–2060' },
      links: { jpl: 'https://example.test/jpl', ssocard: null },
    }
    const html = detailsBlockHtml(details, { loading: false, error: null })
    expect(html).toContain('probabilité 3,2e-5')
    // fmt() passe par toLocaleString, qui rend un trait d'union simple ici --
    // pas le U+2212 que sourcesBlockHtml choisit a la main pour l'ecart ESA.
    expect(html).toContain('Palerme -2,15')
    expect(html).toContain('Turin 1')
    expect(html).toContain('2029–2060')
  })
})

describe('NEO_CREDITS', () => {
  it('n est pas vide', () => {
    expect(typeof NEO_CREDITS).toBe('string')
    expect(NEO_CREDITS.length).toBeGreaterThan(0)
  })

  // Obligation d'attribution (docs/agent/backlog.md), pas un detail
  // cosmetique : les quatre sources doivent etre citees nommement.
  it('cite les quatre sources : NASA/JPL, ESA NEOCC, IMCCE, NASA NeoWs', () => {
    expect(NEO_CREDITS).toMatch(/NASA\/JPL/)
    expect(NEO_CREDITS).toMatch(/ESA NEOCC/)
    expect(NEO_CREDITS).toMatch(/IMCCE/)
    expect(NEO_CREDITS).toMatch(/NASA NeoWs/)
  })
})
