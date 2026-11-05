import { describe, expect, it } from 'vitest'
import { trackButtonHtml, trackedApproachHtml } from '../../src/ui/sheets.js'
import { MAX_TRACKED } from '../../src/tracking/model.js'

const idle = { designation: null, busy: false, message: '' }

// What is pinned: what comes from outside (a designation, a backend message)
// is escaped before it lands in an attribute or a text node, and the button is
// disabled exactly when a click could not do anything.
describe('trackButtonHtml', () => {
  it("échappe la désignation dans l'attribut data-designation", () => {
    const html = trackButtonHtml({ designation: '"><img src=x>', tracked: false, full: false, neoTrack: idle })
    expect(html).not.toContain('<img')
    expect(html).toContain('data-designation="&quot;&gt;&lt;img src=x&gt;"')
  })

  it("échappe le message d'erreur renvoyé pour cette désignation", () => {
    const neoTrack = { designation: '2024 YR4', busy: false, message: '<b>down</b>' }
    const html = trackButtonHtml({ designation: '2024 YR4', tracked: false, full: false, neoTrack })
    expect(html).not.toContain('<b>')
    expect(html).toContain('class="error"')
  })

  it.each([
    ['déjà suivi', { tracked: true, full: false, neoTrack: idle }],
    ['liste pleine', { tracked: false, full: true, neoTrack: idle }],
    ['résolution en cours', { tracked: false, full: false, neoTrack: { designation: '433', busy: true, message: '' } }],
  ])('désactivé quand %s', (_label, state) => {
    expect(trackButtonHtml({ designation: '433', ...state })).toContain(' disabled>')
  })

  it('actif sinon, et le plafond affiché est MAX_TRACKED', () => {
    expect(trackButtonHtml({ designation: '433', tracked: false, full: false, neoTrack: idle })).not.toContain('disabled')
    expect(trackButtonHtml({ designation: '433', tracked: false, full: true, neoTrack: idle })).toContain(`${MAX_TRACKED} objets au plus`)
  })
})

describe('trackedApproachHtml', () => {
  it("rien quand il n'y a rien à dire (pas un NEO, ou tables pas encore là)", () => {
    expect(trackedApproachHtml(null, '2099942')).toBe('')
  })

  it("le bouton « Y aller » seulement quand l'approche est dans la plage du curseur", () => {
    const approach = { dist_km: 38_000, v_rel_km_s: 7.4 }
    expect(trackedApproachHtml({ kind: 'in_range', time: 1_870_000_000, approach }, '2099942')).toContain('data-spkid="2099942"')
    expect(trackedApproachHtml({ kind: 'after_range', time: 1_870_000_000 }, '2099942')).not.toContain('<button')
  })

  describe('passage précédent (2026-11-05)', () => {
    const previous = { kind: 'in_range', time: 1_790_000_000, approach: { dist_km: 7490 } }

    it("sans prochain passage mais avec un précédent : ne dit pas « aucun », propose « Revoir »", () => {
      const html = trackedApproachHtml({ kind: 'none' }, '3000', previous)
      expect(html).not.toContain('Aucun rapprochement connu')
      expect(html).toContain('Pas d\'autre rapprochement')
      expect(html).toContain('data-action="approach-prev"')
      expect(html).toContain('data-spkid="3000"')
    })

    it('ni avant ni après : « aucun rapprochement connu » reste', () => {
      expect(trackedApproachHtml({ kind: 'none' }, '3000', { kind: 'none' })).toContain('Aucun rapprochement connu')
      expect(trackedApproachHtml({ kind: 'none' }, '3000')).toContain('Aucun rapprochement connu')
    })

    it('un prochain hors plage et un précédent : les deux lignes, un seul bouton', () => {
      const html = trackedApproachHtml({ kind: 'after_range', time: 1_870_000_000 }, '3000', previous)
      expect(html).toContain('Prochain rapprochement')
      expect(html.match(/<button/g)).toHaveLength(1)
    })

    it('CAD en panne : inchangé, pas de bouton', () => {
      expect(trackedApproachHtml({ kind: 'unavailable' }, '3000', previous)).not.toContain('<button')
    })
  })
})
