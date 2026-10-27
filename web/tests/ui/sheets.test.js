import { describe, expect, it } from 'vitest'
import { trackButtonHtml, trackedApproachHtml } from '../../src/ui/sheets.js'
import { MAX_TRACKED } from '../../src/tracking.js'

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

  it("le bouton « Y aller » seulement quand l'approche est dans la plage de l'horloge", () => {
    const approach = { dist_km: 38_000, v_rel_km_s: 7.4 }
    expect(trackedApproachHtml({ kind: 'in_window', time: 1_870_000_000, approach }, '2099942')).toContain('data-spkid="2099942"')
    expect(trackedApproachHtml({ kind: 'after_window', time: 1_870_000_000 }, '2099942')).not.toContain('<button')
  })
})
