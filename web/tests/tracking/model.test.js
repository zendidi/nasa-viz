import { describe, expect, it } from 'vitest'

import {
  DASH_FLYBY_SECONDS,
  DASH_HELIO_SECONDS,
  FLYBY_HALF_SECONDS,
  MAX_TRACKED,
  TRACK_COLORS,
  TRACK_SLOTS,
  addTracked,
  cursorBounds,
  activeFlybyArc,
  cursorFromSliderDay,
  densifyHeliocentric,
  heliocentricDenseTimes,
  sampleTable,
  dashKeepsSegment,
  flybyArcTimes,
  FLYBY_MAX_SLOT_LEVEL,
  flybyIdealSlotSeconds,
  flybySlotLevel,
  flybySegmentColor,
  formatCursorOffset,
  freeSlot,
  ghostEarthOffset,
  heliocentricPath,
  interpretSearch,
  isTrackedDesignation,
  nextApproach,
  previousApproach,
  numberSearchHelp,
  positionAt,
  readTrackedList,
  removeTracked,
  replaceSpkid,
  savedList,
  setSaved,
  slicesToLoad,
  sliderDayOf,
  tableAt,
} from '../../src/tracking/model.js'

// Ce qui est épinglé : les règles que l'œil ne voit pas casser. Quelle table lit-on
// à un instant donné (une erreur de 34 000 km à 40 000 km de la Terre ne se voit
// pas, mais un segment fin ignoré fait exactement ça), ce qui reste quand le
// stockage est abîmé, et qu'un astéroïde qui n'est pas un NEO n'a ni rapprochement
// ni segment sans que ce soit une erreur.

const rec = (n, extra = {}) => ({ spkid: String(20000000 + n), des: `D${n}`, fullname: `Objet ${n}`, neo: true, ...extra })

describe('addTracked / removeTracked', () => {
  it('plafonne à 10 et refuse le onzième avec sa raison', () => {
    let list = []
    for (let i = 1; i <= MAX_TRACKED; i++) {
      const out = addTracked(list, rec(i))
      expect(out.added).toBe(true)
      list = out.list
    }
    const refused = addTracked(list, rec(MAX_TRACKED + 1))
    expect(refused.added).toBe(false)
    expect(refused.reason).toBe('full')
    expect(refused.list).toBe(list)
    expect(list).toHaveLength(10)
  })

  it('un doublon de SPK-ID est sans effet, même quand la liste est pleine', () => {
    const one = addTracked([], rec(1)).list
    const again = addTracked(one, rec(1, { fullname: 'Autre nom' }))
    expect(again).toMatchObject({ added: false, reason: 'duplicate' })
    expect(again.list).toBe(one)

    let full = []
    for (let i = 1; i <= MAX_TRACKED; i++) full = addTracked(full, rec(i)).list
    expect(addTracked(full, rec(3)).reason).toBe('duplicate') // pas « plein » : il y est déjà
  })

  it('refuse un SPK-ID qui n\'a pas la forme attendue par le backend', () => {
    for (const spkid of ['123456', '123456789', '2009904a', '', 20099942]) {
      expect(addTracked([], rec(1, { spkid })).reason).toBe('invalid')
    }
  })

  it('ne modifie jamais la liste reçue', () => {
    const list = addTracked([], rec(1)).list
    const copy = JSON.parse(JSON.stringify(list))
    addTracked(list, rec(2))
    removeTracked(list, list[0].spkid)
    expect(list).toEqual(copy)
  })

  it('retirer ne touche pas les couleurs des autres, et la suivante prend la couleur libérée', () => {
    let list = []
    for (let i = 1; i <= 3; i++) list = addTracked(list, rec(i)).list
    const [a, b, c] = list
    const without = removeTracked(list, b.spkid)
    expect(without.map((r) => r.color)).toEqual([a.color, c.color])
    const next = addTracked(without, rec(4)).list
    expect(next[next.length - 1].color).toBe(b.color)
  })

  it('dix emplacements (couleur, trait) distincts, à part des NEO (cyan 0x7fe0ff, rouge 0xff4d4d)', () => {
    expect(TRACK_SLOTS).toHaveLength(MAX_TRACKED)
    expect(new Set(TRACK_SLOTS.map((s) => `${s.color}/${s.dashed}`)).size).toBe(MAX_TRACKED)
    expect(new Set(TRACK_COLORS).size).toBe(5) // pas de nouvelle teinte : seulement le trait change
    expect(TRACK_COLORS).not.toContain(0x7fe0ff)
    expect(TRACK_COLORS).not.toContain(0xff4d4d)
    let list = []
    for (let i = 1; i <= MAX_TRACKED; i++) list = addTracked(list, rec(i)).list
    expect(new Set(list.map((r) => `${r.color}/${r.dashed}`)).size).toBe(MAX_TRACKED)
  })

  it("allocation : les cinq pleins dans l'ordre de la palette, puis les cinq pointillés", () => {
    let list = []
    for (let i = 1; i <= MAX_TRACKED; i++) list = addTracked(list, rec(i)).list
    expect(list.map((r) => r.color)).toEqual([...TRACK_COLORS, ...TRACK_COLORS])
    expect(list.map((r) => r.dashed)).toEqual([false, false, false, false, false, true, true, true, true, true])
  })

  it('retirer un plein libère son emplacement, le suivant le reprend, les autres ne bougent pas', () => {
    let list = []
    for (let i = 1; i <= 7; i++) list = addTracked(list, rec(i)).list
    const freed = list[1]
    const without = removeTracked(list, freed.spkid)
    expect(without.map((r) => [r.color, r.dashed])).toEqual(list.filter((r) => r !== freed).map((r) => [r.color, r.dashed]))
    const next = addTracked(without, rec(8)).list.at(-1)
    expect([next.color, next.dashed]).toEqual([freed.color, false])
  })

  it("un nouvel objet n'est pas gardé", () => {
    expect(addTracked([], rec(1)).list[0].saved).toBe(false)
  })

  it('un non-NEO reste un non-NEO : neo n\'est vrai que pour true', () => {
    expect(addTracked([], rec(1, { neo: false })).list[0].neo).toBe(false)
    expect(addTracked([], rec(1, { neo: 'oui' })).list[0].neo).toBe(false)
    expect(addTracked([], rec(1, { neo: null })).list[0].neo).toBe(false)
  })

  it('replaceSpkid garde la couleur, le trait et « gardé » (numérotation : 5xxxxxxx devient 2xxxxxxx)', () => {
    const list = setSaved(addTracked([], rec(1, { spkid: '50000123' })).list, '50000123', true)
    const next = replaceSpkid(list, '50000123', '20004000')
    expect(next[0]).toMatchObject({ spkid: '20004000', color: list[0].color, dashed: false, saved: true })
    expect(replaceSpkid(list, '50000123', 'zzz')).toBe(list)
  })
})

describe('readTrackedList', () => {
  it('rend une liste vide pour tout ce qui n\'est pas un tableau', () => {
    for (const raw of [null, undefined, 'abc', 42, {}, { 0: rec(1) }]) expect(readTrackedList(raw)).toEqual([])
  })

  it('jette les entrées invalides et garde les bonnes', () => {
    const raw = [rec(1), null, 'x', 12, {}, { spkid: '99', des: 'a', fullname: 'b' }, { spkid: '20000002', des: '' }, rec(2)]
    expect(readTrackedList(raw).map((r) => r.spkid)).toEqual([rec(1).spkid, rec(2).spkid])
  })

  it('tronque à 10 et déduplique avant de tronquer', () => {
    const raw = [rec(1), rec(1), ...[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((i) => rec(i))]
    const list = readTrackedList(raw)
    expect(list).toHaveLength(MAX_TRACKED)
    expect(new Set(list.map((r) => r.spkid)).size).toBe(MAX_TRACKED)
    expect(list.map((r) => r.spkid)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => rec(i).spkid))
  })

  it('réattribue une couleur manquante, étrangère ou déjà prise, sans toucher aux bonnes', () => {
    const raw = [
      rec(1, { color: TRACK_COLORS[2] }),
      rec(2, { color: TRACK_COLORS[2] }), // déjà prise
      rec(3, { color: 0x123456 }), // hors palette
      rec(4), // aucune
    ]
    const list = readTrackedList(raw)
    expect(list[0].color).toBe(TRACK_COLORS[2])
    expect(new Set(list.map((r) => `${r.color}/${r.dashed}`)).size).toBe(4)
    for (const r of list) expect(TRACK_COLORS).toContain(r.color)
  })

  it("une même couleur est permise si l'un est plein et l'autre pointillé ; deux pointillés identiques, non", () => {
    const list = readTrackedList([
      rec(1, { color: TRACK_COLORS[0], dashed: false }),
      rec(2, { color: TRACK_COLORS[0], dashed: true }),
      rec(3, { color: TRACK_COLORS[0], dashed: true }), // emplacement déjà pris
    ])
    expect(list[0]).toMatchObject({ color: TRACK_COLORS[0], dashed: false })
    expect(list[1]).toMatchObject({ color: TRACK_COLORS[0], dashed: true })
    expect(new Set(list.map((r) => `${r.color}/${r.dashed}`)).size).toBe(3)
  })

  it("rétrocompat : sans « saved » c'est gardé, sans « dashed » c'est plein", () => {
    const list = readTrackedList([rec(1, { color: TRACK_COLORS[1] })])
    expect(list[0]).toMatchObject({ saved: true, dashed: false, color: TRACK_COLORS[1] })
  })

  it('tout ce qui est relu du stockage est gardé, même si le champ dit le contraire', () => {
    expect(readTrackedList([rec(1, { saved: false })])[0].saved).toBe(true)
  })

  it('un neo douteux (chaîne, nombre) est lu comme « pas un NEO »', () => {
    expect(readTrackedList([rec(1, { neo: 1 })])[0].neo).toBe(false)
  })

  it('survit à un aller-retour par JSON, comme le localStorage', () => {
    let list = []
    for (let i = 1; i <= 3; i++) list = addTracked(list, rec(i, { neo: i % 2 === 1 })).list
    // Un aller-retour ne relit que ce qui a été écrit, et ce qui est écrit est « gardé ».
    const kept = list.map((r) => ({ ...r, saved: true }))
    expect(readTrackedList(JSON.parse(JSON.stringify(savedList(kept))))).toEqual(kept)
  })
})

describe('savedList / setSaved', () => {
  it('seuls les objets gardés sont sérialisés', () => {
    let list = []
    for (let i = 1; i <= 3; i++) list = addTracked(list, rec(i)).list
    expect(savedList(list)).toEqual([])
    list = setSaved(list, rec(2).spkid, true)
    expect(savedList(list).map((r) => r.spkid)).toEqual([rec(2).spkid])
    expect(savedList(setSaved(list, rec(2).spkid, false))).toEqual([])
  })

  it('setSaved ne modifie pas la liste reçue et ignore un SPK-ID absent', () => {
    const list = addTracked([], rec(1)).list
    const copy = JSON.parse(JSON.stringify(list))
    setSaved(list, rec(1).spkid, true)
    expect(list).toEqual(copy)
    expect(setSaved(list, '29999999', true)).toEqual(copy)
  })
})

describe('freeSlot', () => {
  it("prend le premier emplacement libre : pleins d'abord, puis pointillés", () => {
    expect(freeSlot([])).toEqual({ color: TRACK_COLORS[0], dashed: false })
    expect(freeSlot([{ color: TRACK_COLORS[0] }, { color: TRACK_COLORS[2] }])).toEqual({ color: TRACK_COLORS[1], dashed: false })
    const solids = TRACK_COLORS.map((color) => ({ color, dashed: false }))
    expect(freeSlot(solids)).toEqual({ color: TRACK_COLORS[0], dashed: true })
  })
})

describe('dashKeepsSegment', () => {
  const SLOT = DASH_HELIO_SECONDS
  const base = 1_800_000_000 - (1_800_000_000 % (2 * SLOT)) // début d'une période pleine + vide

  it('deux échantillons dans le même créneau vide : segment non gardé ; dans un créneau plein : gardé', () => {
    expect(dashKeepsSegment(base + 0.1 * SLOT, base + 0.4 * SLOT, SLOT)).toBe(true)
    expect(dashKeepsSegment(base + 1.1 * SLOT, base + 1.4 * SLOT, SLOT)).toBe(false)
    expect(dashKeepsSegment(base + 2.1 * SLOT, base + 2.4 * SLOT, SLOT)).toBe(true)
  })

  it("le motif suit le temps, pas le pas d'échantillonnage : même fraction tracée à 5 min, 1 h ou 6 h", () => {
    for (const [slot, label] of [[DASH_HELIO_SECONDS, 'helio'], [DASH_FLYBY_SECONDS, 'flyby']]) {
      for (const step of [300, 3600, 6 * 3600]) {
        if (step * 2 > slot) continue // un pas plus long que le créneau ne peut pas le résoudre
        let kept = 0
        let total = 0
        for (let t = base; t < base + 10 * 2 * slot; t += step) {
          total++
          if (dashKeepsSegment(t, t + step, slot)) kept++
        }
        expect(kept / total, `${label} ${step}`).toBeCloseTo(0.5, 1)
      }
    }
  })

  it('un tiret puis un vide sur une période : ni tout, ni rien', () => {
    const kept = []
    for (let t = base; t < base + 2 * SLOT; t += 6 * 3600) kept.push(dashKeepsSegment(t, t + 6 * 3600, SLOT))
    expect(kept.filter(Boolean)).toHaveLength(kept.length / 2)
    expect(kept[0]).toBe(true)
    expect(kept[kept.length - 1]).toBe(false)
  })
})

describe('flybySegmentColor', () => {
  const H = 3600
  // Un multiple de 24 h : début d'une période pleine (objet + Terre) comme de la période pointillée de 24 h.
  const base = 1_800_000_000 - (1_800_000_000 % (24 * H))
  const mid = (t, dashed) => flybySegmentColor(t - 60, t + 60, dashed)

  it('plein : objet puis Terre par créneaux de 12 h ancrés sur l\'époque, sans vide', () => {
    expect(mid(base + 6 * H, false)).toBe('object')
    expect(mid(base + 18 * H, false)).toBe('earth')
    expect(mid(base + 30 * H, false)).toBe('object')
    for (let t = base; t < base + 48 * H; t += 600) expect(mid(t, false)).not.toBeNull()
  })

  it('pointillé : objet / vide / Terre / vide par créneaux de 6 h', () => {
    expect([3, 9, 15, 21].map((h) => mid(base + h * H, true))).toEqual(['object', null, 'earth', null])
    expect(mid(base + 27 * H, true)).toBe('object')
  })

  it('un segment est attribué par son milieu, pas par ses extrémités', () => {
    // Part du créneau « objet » mais son milieu tombe dans le suivant.
    expect(flybySegmentColor(base + 11 * H, base + 14 * H, false)).toBe('earth')
    expect(flybySegmentColor(base + 10 * H, base + 13 * H, false)).toBe('object')
  })
})

describe('flybySegmentColor par k', () => {
  const H = 3600
  const base = 1_800_000_000 - (1_800_000_000 % (24 * H))
  const at = (t, dashed, k) => flybySegmentColor(t - 60, t + 60, dashed, k)

  it('k = 0 : le découpage de zoom arrière (12 h / 6 h) ; chaque k divise les créneaux par 2', () => {
    expect(at(base + 11 * H, false, 0)).toBe('object')
    expect(at(base + 13 * H, false, 0)).toBe('earth')
    expect(at(base + 2 * H, false, 2)).toBe('object')
    expect(at(base + 4 * H, false, 2)).toBe('earth')
    expect([0.75, 2.25, 3.75, 5.25].map((h) => at(base + h * H, true, 2))).toEqual(['object', null, 'earth', null])
    expect([3, 9, 15, 21].map((h) => at(base + h * H, true, 0))).toEqual(['object', null, 'earth', null])
  })

  it('emboîtement : partout où un k grossier change de couleur, le k suivant en change aussi', () => {
    // Segments de 5 min, la couleur d'un segment vient de son milieu.
    const seq = (dashed, k) => {
      const out = []
      for (let t = base; t < base + 3 * 24 * H; t += 300) out.push(flybySegmentColor(t, t + 300, dashed, k))
      return out
    }
    for (const dashed of [false, true]) {
      for (let k = 0; k < FLYBY_MAX_SLOT_LEVEL; k++) {
        const coarse = seq(dashed, k)
        const fine = seq(dashed, k + 1)
        let boundaries = 0
        for (let i = 1; i < coarse.length; i++) {
          if (coarse[i] === coarse[i - 1]) continue
          boundaries++
          expect(fine[i]).not.toBe(fine[i - 1])
        }
        expect(boundaries).toBeGreaterThan(0)
      }
    }
  })
})

describe('flybySlotLevel', () => {
  const SPEED = 1e-3 // vitesse de scène fixe, unités par seconde
  const ideal = (distance) => flybyIdealSlotSeconds(distance, SPEED)

  it('diviser la distance caméra par 2 incrémente k de 1 (tronçons 2 fois plus courts)', () => {
    const far = 400 // idéal ~14 h : k = 0, puis 1, 2, 3, 4
    for (let i = 0; i < 4; i++) {
      const d = far / 2 ** i
      expect(flybySlotLevel(ideal(d / 2))).toBe(flybySlotLevel(ideal(d)) + 1)
    }
  })

  it('zoom très arrière : k = 0 (12 h) ; zoom très avant : plafonné au plus fin', () => {
    expect(flybySlotLevel(ideal(1e12))).toBe(0)
    expect(flybySlotLevel(ideal(1e-12))).toBe(FLYBY_MAX_SLOT_LEVEL)
    expect(flybySlotLevel(Infinity)).toBe(0)
    // Le plus fin ne descend pas sous le pas d'échantillonnage de 15 min.
    expect(12 * 3600 / 2 ** FLYBY_MAX_SLOT_LEVEL).toBeGreaterThanOrEqual(900)
    expect(12 * 3600 / 2 ** (FLYBY_MAX_SLOT_LEVEL + 1)).toBeLessThan(900)
  })

  it('un objet deux fois plus rapide en scène a des tronçons deux fois plus courts à même zoom', () => {
    const d = 500
    expect(flybySlotLevel(flybyIdealSlotSeconds(d, 2 * SPEED))).toBe(flybySlotLevel(flybyIdealSlotSeconds(d, SPEED)) + 1)
  })

  it('hystérésis : à une frontière, k ne change qu’après l’avoir franchie nettement', () => {
    const H12 = 12 * 3600
    const b = H12 / 4 // 3 h : frontière entre k = 2 (idéal >= 3 h) et k = 3
    expect(flybySlotLevel(b * 1.01)).toBe(2)
    expect(flybySlotLevel(b * 0.99)).toBe(3)
    expect(flybySlotLevel(b * 0.9, 2)).toBe(2) // juste au-delà : on reste
    expect(flybySlotLevel(b * 1.1, 3)).toBe(3)
    expect(flybySlotLevel(b * 0.7, 2)).toBe(3) // franchie nettement : on change
    expect(flybySlotLevel(b * 1.4, 3)).toBe(2)
  })
})

describe('isTrackedDesignation', () => {
  const list = addTracked([], { spkid: '20099942', des: '99942', fullname: '99942 Apophis (2004 MN4)', neo: true }).list

  it('reconnaît la désignation provisoire d\'un objet numéroté (celle du flux NEO) et la primaire', () => {
    expect(isTrackedDesignation(list, '2004 MN4')).toBe(true)
    expect(isTrackedDesignation(list, '2004 mn4')).toBe(true)
    expect(isTrackedDesignation(list, '99942')).toBe(true)
  })

  it('ne confond pas deux objets (« 2004 MN4 » n\'est pas « 2004 MN »)', () => {
    expect(isTrackedDesignation(list, '2004 MN')).toBe(false)
    expect(isTrackedDesignation(list, '2026 RB39')).toBe(false)
  })
})

describe('interpretSearch', () => {
  it('match : un enregistrement prêt à suivre', () => {
    const out = interpretSearch({
      match: { spkid: '20099942', des: '99942', fullname: '99942 Apophis (2004 MN4)', neo: true, pha: true },
    })
    expect(out).toEqual({
      kind: 'match',
      record: { spkid: '20099942', des: '99942', fullname: '99942 Apophis (2004 MN4)', neo: true },
    })
  })

  it('match d\'un non-NEO : neo faux, pas inventé', () => {
    const out = interpretSearch({ match: { spkid: '20000001', des: '1', fullname: '1 Ceres', neo: false } })
    expect(out.record.neo).toBe(false)
  })

  it('candidats : la liste et le total, plus grand que la liste quand SBDB tronque', () => {
    const out = interpretSearch({ match: null, candidates: [{ pdes: '1862', name: '1862 Apollo' }], count: 7 })
    expect(out).toEqual({ kind: 'candidates', candidates: [{ pdes: '1862', name: '1862 Apollo' }], count: 7 })
  })

  it('comète refusée : la raison, pas « introuvable »', () => {
    expect(interpretSearch({ match: null, rejected: { reason: 'comet', fullname: '1P/Halley' } })).toEqual({
      kind: 'comet',
      fullname: '1P/Halley',
    })
  })

  it('rien trouvé, réponse vide ou illisible : none', () => {
    for (const res of [{ match: null }, { match: null, candidates: [] }, null, undefined, {}, { match: { spkid: 'x', des: 'a' } }]) {
      expect(interpretSearch(res)).toEqual({ kind: 'none' })
    }
  })
})

describe('tableAt', () => {
  // Base horaire sur 10 h (t = 1000 .. 1000 + 9·3600), un segment de 5 min de 20 min.
  const BASE = 1000
  const STEP = 3600
  const baseRows = Array.from({ length: 10 }, (_, i) => [i, 0, 0])
  const segStart = BASE + 3 * STEP + 600
  const segment = { start: segStart, step_seconds: 300, positions: [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0], [4, 0, 0]] }
  const segEnd = segStart + 4 * 300
  const object = { table: { start: BASE, step_seconds: STEP, positions: baseRows }, segments: [segment] }
  const baseEnd = BASE + 9 * STEP

  it('dans le segment : le segment, marqué fin', () => {
    const table = tableAt(object, segStart + 450)
    expect(table).toMatchObject({ start: segStart, stepSeconds: 300, fine: true })
  })

  it('bords du segment inclus des deux côtés', () => {
    expect(tableAt(object, segStart).fine).toBe(true)
    expect(tableAt(object, segEnd).fine).toBe(true)
  })

  it('juste avant et juste après le segment : la table de base', () => {
    for (const t of [segStart - 1, segEnd + 1, segStart - 0.001, segEnd + 0.001]) {
      expect(tableAt(object, t)).toMatchObject({ start: BASE, stepSeconds: STEP, fine: false })
    }
  })

  it('bords exacts de la table de base inclus ; un cheveu plus loin, rien', () => {
    expect(tableAt(object, BASE)?.fine).toBe(false)
    expect(tableAt(object, baseEnd)?.fine).toBe(false)
    expect(tableAt(object, BASE - 0.001)).toBeNull()
    expect(tableAt(object, baseEnd + 0.001)).toBeNull()
    expect(tableAt(object, 0)).toBeNull()
  })

  it('un non-NEO (segments: []) ou sans segments : toujours la base', () => {
    expect(tableAt({ table: object.table, segments: [] }, segStart + 450).fine).toBe(false)
    expect(tableAt({ table: object.table }, segStart + 450).fine).toBe(false)
  })

  it('un objet sans table (ou vide) : null', () => {
    expect(tableAt(null, 5)).toBeNull()
    expect(tableAt({}, 5)).toBeNull()
    expect(tableAt({ table: { start: 0, step_seconds: 60, positions: [] } }, 0)).toBeNull()
  })

  it('un segment qui déborde de la base ne rend pas la position valable hors de la base', () => {
    const outside = { table: object.table, segments: [{ start: baseEnd - 300, step_seconds: 300, positions: [[0, 0, 0], [1, 0, 0], [2, 0, 0]] }] }
    expect(tableAt(outside, baseEnd + 300)).toBeNull()
  })
})

describe('positionAt', () => {
  it('lit la table choisie : entre deux échantillons du segment, pas ceux de la base', () => {
    const object = {
      table: { start: 0, step_seconds: 3600, positions: [[0, 0, 0], [3600, 0, 0], [7200, 0, 0], [10800, 0, 0]] },
      segments: [{ start: 3600, step_seconds: 300, positions: [[1000, 0, 0], [1100, 0, 0], [1200, 0, 0]] }],
    }
    const out = [0, 0, 0]
    expect(positionAt(object, 3600 + 150, out)).toBe(out)
    expect(out[0]).toBeCloseTo(1050, 6) // le segment, pas les 3 750 de la base
    expect(positionAt(object, 7200 + 1800, [0, 0, 0])[0]).toBeCloseTo(7200 + 1800, 6)
  })

  it('hors table : null, et la sortie n\'est pas touchée', () => {
    const object = { table: { start: 0, step_seconds: 60, positions: [[1, 2, 3], [4, 5, 6]] } }
    const out = [7, 8, 9]
    expect(positionAt(object, 1000, out)).toBeNull()
    expect(out).toEqual([7, 8, 9])
  })
})

describe('nextApproach', () => {
  const approach = (time, dist_km = 100000) => ({ time, dist_km })
  const neo = (extra) => ({ neo: true, close_approaches: [], next_close_approach_after_range: null, ...extra })

  it('dans la fenêtre : le premier strictement après l\'instant, même si la liste est en désordre', () => {
    const object = neo({ close_approaches: [approach(300), approach(100), approach(200)] })
    expect(nextApproach(object, 150)).toMatchObject({ kind: 'in_range', time: 200 })
    expect(nextApproach(object, 0)).toMatchObject({ kind: 'in_range', time: 100 })
  })

  it('l\'instant exact d\'un rapprochement n\'est pas « le prochain » : on passe au suivant', () => {
    const object = neo({ close_approaches: [approach(100), approach(200)] })
    expect(nextApproach(object, 100)).toMatchObject({ kind: 'in_range', time: 200 })
  })

  it('tous passés : celui d\'après la fenêtre, marqué hors fenêtre (l\'horloge ne peut pas y aller)', () => {
    const object = neo({ close_approaches: [approach(100)], next_close_approach_after_range: approach(9000) })
    expect(nextApproach(object, 500)).toMatchObject({ kind: 'after_range', time: 9000 })
  })

  it('rien de connu : none', () => {
    expect(nextApproach(neo({}), 0)).toEqual({ kind: 'none' })
    expect(nextApproach(neo({ close_approaches: [approach(100)] }), 500)).toEqual({ kind: 'none' })
  })

  it('close_approaches null (CAD en panne) n\'est pas « aucun rapprochement »', () => {
    expect(nextApproach(neo({ close_approaches: null }), 0)).toEqual({ kind: 'unavailable' })
    // même s'il y a un « après la fenêtre » : sans la liste on ne sait rien de fiable
    expect(nextApproach(neo({ close_approaches: null, next_close_approach_after_range: approach(9000) }), 0)).toEqual({
      kind: 'unavailable',
    })
  })

  it('un non-NEO n\'a jamais de rapprochement, sans que ce soit une erreur', () => {
    const ceres = { neo: false, close_approaches: [], next_close_approach_after_range: null }
    expect(nextApproach(ceres, 0)).toEqual({ kind: 'none' })
    expect(nextApproach(null, 0)).toEqual({ kind: 'none' })
  })
})

describe('previousApproach', () => {
  const approach = (time, dist_km = 100000) => ({ time, dist_km })
  const neo = (extra) => ({ neo: true, close_approaches: [], next_close_approach_after_range: null, ...extra })

  it('le dernier passage avant l\'instant, même si la liste est en désordre', () => {
    const object = neo({ close_approaches: [approach(100), approach(300), approach(200)] })
    expect(previousApproach(object, 250)).toMatchObject({ kind: 'in_range', time: 200 })
    expect(previousApproach(object, 1000)).toMatchObject({ kind: 'in_range', time: 300 })
    expect(previousApproach(object, 50)).toEqual({ kind: 'none' })
  })

  it('un passage pile à T′ est dans « précédent » et pas dans « prochain » : jamais dans aucun des deux', () => {
    const object = neo({ close_approaches: [approach(100)] })
    expect(previousApproach(object, 100)).toMatchObject({ kind: 'in_range', time: 100 })
    expect(nextApproach(object, 100)).toEqual({ kind: 'none' })
  })

  it('avant le début du curseur : ignoré (le curseur ne peut pas y aller)', () => {
    const object = neo({ close_approaches: [approach(10), approach(100)] })
    expect(previousApproach(object, 500, 50)).toMatchObject({ time: 100 })
    expect(previousApproach(object, 500, 200)).toEqual({ kind: 'none' })
    expect(previousApproach(object, 500, 100)).toMatchObject({ time: 100 }) // borne incluse
  })

  it('CAD en panne : unavailable ; non-NEO ou rien : none', () => {
    expect(previousApproach(neo({ close_approaches: null }), 500)).toEqual({ kind: 'unavailable' })
    expect(previousApproach({ neo: false, close_approaches: [approach(1)] }, 500)).toEqual({ kind: 'none' })
    expect(previousApproach(null, 500)).toEqual({ kind: 'none' })
    expect(previousApproach(neo({}), 500)).toEqual({ kind: 'none' })
  })
})

describe('numberSearchHelp', () => {
  it('un nombre à 4 chiffres plausible comme année : numéro ET piste pour l\'année', () => {
    const help = numberSearchHelp('2017')
    expect(help).toContain('l\'astéroïde n° 2017')
    expect(help).toContain('2017 YE5')
  })

  it('un nombre qui n\'est pas une année : seulement le numéro', () => {
    expect(numberSearchHelp('433')).toBe('« 433 » = l\'astéroïde n° 433.')
    expect(numberSearchHelp('99942')).not.toContain('année')
    expect(numberSearchHelp('1799')).not.toContain('année')
    expect(numberSearchHelp('2101')).not.toContain('année')
  })

  it('tout ce qui n\'est pas des chiffres seuls : pas d\'aide', () => {
    expect(numberSearchHelp('2017 YE5')).toBeNull()
    expect(numberSearchHelp('Ceres')).toBeNull()
    expect(numberSearchHelp('')).toBeNull()
    expect(numberSearchHelp(' 433 ')).not.toBeNull()
  })
})

describe('flybyArcTimes', () => {
  const DAY = 86_400
  const start = 1_800_000_000
  const end = start + 365 * DAY

  it('aucun rapprochement, aucun arc (et toujours le cas pour un non-NEO)', () => {
    expect(flybyArcTimes([], start, end)).toEqual([])
  })

  it('un arc de ±15 jours qui passe exactement par le périgée', () => {
    const at = start + 100 * DAY + 1234
    const [arc, ...rest] = flybyArcTimes([at], start, end)
    expect(rest).toEqual([])
    expect(arc[0]).toBe(at - FLYBY_HALF_SECONDS)
    expect(arc[arc.length - 1]).toBe(at + FLYBY_HALF_SECONDS)
    expect(arc).toContain(at)
    expect([...arc].sort((a, b) => a - b)).toEqual(arc)
  })

  it('serré près du périgée (5 min), lâche ailleurs (15 min)', () => {
    const at = start + 100 * DAY
    const [arc] = flybyArcTimes([at], start, end)
    const gapAfter = (t) => arc[arc.indexOf(t) + 1] - t
    expect(gapAfter(at)).toBe(300)
    expect(gapAfter(at - 10 * DAY)).toBe(900)
  })

  it('coupé aux bornes des tables : rien hors de [start, end]', () => {
    const arcs = flybyArcTimes([start + 2 * DAY, end - DAY], start, end)
    expect(arcs).toHaveLength(2)
    expect(arcs[0][0]).toBe(start)
    expect(arcs[1][arcs[1].length - 1]).toBe(end)
  })

  it('deux rapprochements à moins de 30 jours partagent un arc, sans trou ni doublon', () => {
    const arcs = flybyArcTimes([start + 100 * DAY, start + 110 * DAY], start, end)
    expect(arcs).toHaveLength(1)
    expect(new Set(arcs[0]).size).toBe(arcs[0].length)
  })
})

// --- Lot 2 : l'outil de trajectoire (2026-11-05) --------------------------------------
//
// Ce qui est épinglé : l'ordre des tables (segment 5 min > tranche horaire > journalière),
// la continuité de la position au 1er janvier entre deux tranches (invisible à l'œil :
// un raccord raté est un saut de quelques km), le signe de « héliocentrique = géocentrique
// − Soleil », et les règles de chargement des tranches.

describe('tableAt, trois niveaux', () => {
  const daily = { start: 0, step_seconds: 86_400, positions: Array.from({ length: 40 }, (_, i) => [i, 0, 0]) }
  const hourly = { start: 10 * 86_400, step_seconds: 3600, positions: Array.from({ length: 49 }, (_, i) => [i, 0, 0]) } // 2 jours
  const segment = { start: 10 * 86_400 + 5 * 3600, step_seconds: 300, positions: Array.from({ length: 13 }, (_, i) => [i, 0, 0]) } // 1 h
  const object = { table: daily, hourly: [hourly], segments: [segment] }

  it('segment 5 min > horaire > journalière, aux bornes incluses', () => {
    expect(tableAt(object, segment.start + 600).kind).toBe('segment')
    expect(tableAt(object, segment.start).kind).toBe('segment')
    expect(tableAt(object, segment.start + 12 * 300).kind).toBe('segment')
    expect(tableAt(object, segment.start + 12 * 300 + 1).kind).toBe('hourly')
    expect(tableAt(object, hourly.start).kind).toBe('hourly')
    expect(tableAt(object, hourly.start + 48 * 3600).kind).toBe('hourly')
    expect(tableAt(object, hourly.start + 48 * 3600 + 1).kind).toBe('daily')
    expect(tableAt(object, 5 * 86_400).kind).toBe('daily')
  })

  it('hors de la journalière : rien (« hors plage »), même sous une tranche fine chargée', () => {
    expect(tableAt(object, -1)).toBeNull()
    expect(tableAt(object, 39 * 86_400 + 1)).toBeNull()
    const outside = { table: { ...daily, positions: daily.positions.slice(0, 5) }, hourly: [hourly] }
    expect(tableAt(outside, hourly.start + 3600)).toBeNull()
  })
})

describe('jonction de deux années : deux lignes de recouvrement', () => {
  // Une trajectoire courbe (pas un polynôme de degré 2, que Catmull-Rom reproduirait
  // exactement avec ou sans recouvrement) lue de trois façons : une table continue
  // (la vérité), et deux tranches horaires qui se recouvrent de 2 lignes de chaque côté
  // du 1er janvier, comme le backend les sert.
  const JAN1 = Date.UTC(2028, 0, 1) / 1000
  const path = (t) => [4e5 * Math.sin(t / 20_000), 4e5 * Math.cos(t / 20_000), 1e3 * t * 1e-3]
  const slice = (firstS, lastS) => {
    const positions = []
    for (let t = firstS; t <= lastS; t += 3600) positions.push(path(t))
    return { start: firstS, step_seconds: 3600, positions }
  }
  const baseStart = JAN1 - 400 * 86_400
  const base = { start: baseStart, step_seconds: 86_400, positions: Array.from({ length: 800 }, (_, i) => path(baseStart + i * 86_400)) }
  const before = slice(JAN1 - 30 * 86_400 - 7200, JAN1 + 7200) // tranche de 2027 : finit 2 h après le 1er janvier
  const after = slice(JAN1 - 7200, JAN1 + 30 * 86_400 + 7200) // tranche de 2028 : commence 2 h avant
  const continuous = slice(JAN1 - 30 * 86_400 - 7200, JAN1 + 30 * 86_400 + 7200)
  const read = (hourly, t) => positionAt({ table: base, hourly }, t, [0, 0, 0])

  it('lue dans l\'une ou l\'autre tranche, la position autour du 1er janvier est celle de la table continue', () => {
    for (let t = JAN1 - 7200; t <= JAN1 + 7200; t += 600) {
      const truth = read([continuous], t)
      for (const both of [[before, after], [after, before]]) {
        const got = read(both, t)
        for (let k = 0; k < 3; k++) expect(got[k]).toBeCloseTo(truth[k], 6)
      }
    }
  })

  it('une tranche seule ne suffit pas à la jonction : sans recouvrement la lecture dévie, d\'où les deux lignes', () => {
    // Même tranche 2028 mais coupée net au 1er janvier : son premier intervalle retombe sur le quadratique.
    const cut = slice(JAN1, JAN1 + 30 * 86_400)
    const truth = read([continuous], JAN1 + 1800)
    const got = read([cut], JAN1 + 1800)
    expect(Math.abs(got[0] - truth[0])).toBeGreaterThan(1e-6)
  })

  it('à l\'instant exact du 1er janvier, les deux tranches donnent la même position', () => {
    const a = read([before], JAN1)
    const b = read([after], JAN1)
    for (let k = 0; k < 3; k++) expect(a[k]).toBeCloseTo(b[k], 9)
  })
})

describe('heliocentricPath / ghostEarthOffset : le signe', () => {
  const sun = { start: 0, step_seconds: 86_400, positions: [[10, 0, 0], [20, 0, 0], [30, 0, 0], [40, 0, 0], [50, 0, 0]] }

  it('un objet qui est exactement au Soleil est à l\'origine héliocentrique (géocentrique − Soleil, pas +)', () => {
    const { times, positions } = heliocentricPath({ start: 0, step_seconds: 86_400, positions: sun.positions }, sun)
    expect(times).toEqual([0, 86_400, 2 * 86_400, 3 * 86_400, 4 * 86_400])
    for (const p of positions) expect(p).toEqual([0, 0, 0])
  })

  it('la Terre (géocentrique 0) est à −Soleil vue du Soleil', () => {
    const { positions } = heliocentricPath({ start: 0, step_seconds: 86_400, positions: sun.positions.map(() => [0, 0, 0]) }, sun)
    expect(positions[2]).toEqual([-30, 0, 0])
  })

  it('une grille différente de celle du Soleil : le Soleil est échantillonné à la date de la ligne', () => {
    const shifted = { start: 43_200, step_seconds: 86_400, positions: [[0, 0, 0], [0, 0, 0]] }
    const { times, positions } = heliocentricPath(shifted, sun)
    expect(times).toEqual([43_200, 43_200 + 86_400])
    expect(positions[0][0]).toBeCloseTo(-15, 9) // le Soleil à mi-chemin entre 10 et 20
  })

  it('les lignes hors du Soleil sont omises, pas inventées', () => {
    const wide = { start: 0, step_seconds: 86_400, positions: Array.from({ length: 8 }, () => [0, 0, 0]) }
    expect(heliocentricPath(wide, { ...sun, start: 86_400 }).times).toEqual([86_400, 2 * 86_400, 3 * 86_400, 4 * 86_400, 5 * 86_400])
  })

  it('Terre fantôme : nulle quand T′ = T, Soleil(T) − Soleil(T′) sinon', () => {
    const out = [9, 9, 9]
    expect(ghostEarthOffset(sun, 2 * 86_400, 2 * 86_400, out)).toEqual([0, 0, 0])
    // La Terre à T′ = −Soleil(T′) ; affichée autour du Soleil de T : Soleil(T) − Soleil(T′).
    expect(ghostEarthOffset(sun, 1 * 86_400, 3 * 86_400, [0, 0, 0])).toEqual([-20, 0, 0])
    expect(ghostEarthOffset(sun, 3 * 86_400, 1 * 86_400, [0, 0, 0])).toEqual([20, 0, 0])
    expect(ghostEarthOffset(sun, 0, 99 * 86_400, [0, 0, 0])).toBeNull()
  })
})

describe('nextApproach, limite du curseur', () => {
  const neo = { neo: true, close_approaches: [{ time: 100 }, { time: 500 }], next_close_approach_after_range: { time: 9000 } }

  it('un rapprochement au-delà de la limite du curseur est « après la plage », avec sa date', () => {
    expect(nextApproach(neo, 0, 1000)).toMatchObject({ kind: 'in_range', time: 100 })
    expect(nextApproach(neo, 100, 400)).toMatchObject({ kind: 'after_range', time: 500 })
    expect(nextApproach(neo, 100, 500)).toMatchObject({ kind: 'in_range', time: 500 }) // borne incluse
  })

  it('tous passés : celui que le backend donne après la plage', () => {
    expect(nextApproach(neo, 600, 1000)).toMatchObject({ kind: 'after_range', time: 9000 })
    expect(nextApproach({ ...neo, next_close_approach_after_range: null }, 600, 1000)).toEqual({ kind: 'none' })
  })
})

describe('slicesToLoad', () => {
  const bounds = { minYear: 2025, maxYear: 2030 }
  const at = (y, m, d) => Date.UTC(y, m - 1, d) / 1000

  it('en milieu d\'année : l\'année du curseur seulement', () => {
    expect(slicesToLoad(at(2027, 7, 1), [], bounds)).toEqual({ load: [2027], evict: [] })
  })

  it('à moins de 30 jours d\'un 1er janvier : l\'année voisine aussi, du bon côté', () => {
    expect(slicesToLoad(at(2027, 12, 10), [], bounds).load.sort()).toEqual([2027, 2028])
    expect(slicesToLoad(at(2028, 1, 20), [], bounds).load.sort()).toEqual([2027, 2028])
    expect(slicesToLoad(at(2027, 12, 1), [], bounds).load).toEqual([2027]) // 31 jours : pas encore
    expect(slicesToLoad(at(2028, 2, 5), [], bounds).load).toEqual([2028])
  })

  it('ne redemande pas ce qui est déjà chargé ou en route', () => {
    expect(slicesToLoad(at(2027, 12, 20), [2027], bounds).load).toEqual([2028])
    expect(slicesToLoad(at(2027, 12, 20), [2027, 2028], bounds).load).toEqual([])
  })

  it('jamais hors des années que le backend accepte', () => {
    expect(slicesToLoad(at(2025, 1, 5), [], bounds).load).toEqual([2025])
    expect(slicesToLoad(at(2030, 12, 25), [], bounds).load).toEqual([2030])
  })

  it('au plus 3 tranches : la plus éloignée du curseur part, jamais une tranche voulue', () => {
    const out = slicesToLoad(at(2029, 12, 20), [2026, 2027, 2028], bounds)
    expect(out.load.sort()).toEqual([2029, 2030])
    expect(out.evict).toEqual([2026, 2027]) // 5 tenues + voulues, on garde 3 : 2028, 2029, 2030
    const kept = [2026, 2027, 2028, ...out.load].filter((y) => !out.evict.includes(y))
    expect(kept.sort()).toEqual([2028, 2029, 2030])
  })

  it('un curseur qui revient en arrière évince la tranche qui est maintenant la plus loin', () => {
    const out = slicesToLoad(at(2026, 6, 1), [2027, 2028, 2029], bounds)
    expect(out.load).toEqual([2026])
    expect(out.evict).toEqual([2029])
  })
})

describe('bornes et lecture du curseur', () => {
  const wall = Date.UTC(2026, 10, 5, 13, 42, 11)

  it('de 1 an avant à 4 ans après maintenant, sur des minuits UTC', () => {
    const { minS, maxS } = cursorBounds(wall)
    expect(minS).toBe(Date.UTC(2025, 10, 5) / 1000)
    expect(maxS).toBe(Date.UTC(2030, 10, 5) / 1000)
  })

  it('coupées à la journalière quand elle est connue, jamais inversées', () => {
    const range = { startS: Date.UTC(2026, 0, 1) / 1000, endS: Date.UTC(2031, 0, 1) / 1000 }
    expect(cursorBounds(wall, range).minS).toBe(range.startS)
    expect(cursorBounds(wall, range).maxS).toBe(Date.UTC(2030, 10, 5) / 1000)
    const tiny = { startS: Date.UTC(2040, 0, 1) / 1000, endS: Date.UTC(2041, 0, 1) / 1000 }
    const bounds = cursorBounds(wall, tiny)
    expect(bounds.maxS).toBeGreaterThanOrEqual(bounds.minS)
  })

  it('le curseur sur la glissière garde l\'heure du jour de T′ (on ne tombe pas sur minuit)', () => {
    const bounds = cursorBounds(wall)
    const current = Date.UTC(2027, 2, 14, 7, 30) / 1000
    const next = cursorFromSliderDay(sliderDayOf(Date.UTC(2028, 5, 1) / 1000, bounds), current, bounds)
    expect(next).toBe(Date.UTC(2028, 5, 1, 7, 30) / 1000)
    expect(cursorFromSliderDay(10_000, current, bounds)).toBe(bounds.maxS)
    expect(cursorFromSliderDay(-5, current, bounds)).toBeGreaterThanOrEqual(bounds.minS)
  })
})

describe('formatCursorOffset', () => {
  const ms = (...a) => Date.UTC(...a)

  it('« 0 » quand c\'est le même instant', () => {
    expect(formatCursorOffset(ms(2026, 10, 5), ms(2026, 10, 5))).toBe('0')
  })

  it('années, mois, jours en calendrier : +2 a 5 m 12 j', () => {
    expect(formatCursorOffset(ms(2026, 10, 5, 12), ms(2029, 3, 17, 12))).toBe('+2 a 5 m 12 j')
  })

  it('le signe suit le sens, la grandeur est la même', () => {
    expect(formatCursorOffset(ms(2029, 3, 17, 12), ms(2026, 10, 5, 12))).toBe('−2 a 5 m 12 j')
  })

  it('les heures, puis les minutes seulement quand il ne reste rien de plus grand', () => {
    expect(formatCursorOffset(ms(2026, 10, 5, 12), ms(2026, 10, 5, 15))).toBe('+3 h')
    expect(formatCursorOffset(ms(2026, 10, 5, 12), ms(2026, 10, 6, 11))).toBe('+23 h')
    expect(formatCursorOffset(ms(2026, 10, 5, 12), ms(2026, 10, 5, 12, 20))).toBe('+20 min')
    expect(formatCursorOffset(ms(2026, 10, 5, 12), ms(2026, 10, 6, 12, 20))).toBe('+1 j')
  })

  it('un 31 qui n\'a pas de pareil le mois suivant ne casse pas le compte', () => {
    expect(formatCursorOffset(ms(2026, 0, 31), ms(2026, 2, 1))).toBe('+1 m 1 j')
  })
})

describe('activeFlybyArc : un arc n existe qu autour de son passage (2026-11-05)', () => {
  const DAY = 86_400
  const start = 1_800_000_000
  const end = start + 2000 * DAY
  const a = start + 100 * DAY
  const b = start + 900 * DAY
  const arcs = flybyArcTimes([a, b], start, end)

  it('dedans : l arc dont la fenêtre tient T′', () => {
    expect(activeFlybyArc(arcs, a)).toBe(0)
    expect(activeFlybyArc(arcs, b + DAY)).toBe(1)
  })

  it('les bornes de la fenêtre sont incluses', () => {
    expect(activeFlybyArc(arcs, a - FLYBY_HALF_SECONDS)).toBe(0)
    expect(activeFlybyArc(arcs, a + FLYBY_HALF_SECONDS)).toBe(0)
  })

  it('dehors : aucun arc, même loin d un décalage nul (le cas Apophis 2029 vu depuis 2026)', () => {
    expect(activeFlybyArc(arcs, a + FLYBY_HALF_SECONDS + 1)).toBe(-1)
    expect(activeFlybyArc(arcs, a - FLYBY_HALF_SECONDS - 1)).toBe(-1)
    expect(activeFlybyArc(arcs, start + 500 * DAY)).toBe(-1)
    expect(activeFlybyArc([], a)).toBe(-1)
  })

  it('deux passages à moins de 30 jours : un seul arc fusionné, actif sur toute l union', () => {
    const merged = flybyArcTimes([a, a + 20 * DAY], start, end)
    expect(merged).toHaveLength(1)
    expect(activeFlybyArc(merged, a - 14 * DAY)).toBe(0)
    expect(activeFlybyArc(merged, a + 34 * DAY)).toBe(0)
    expect(activeFlybyArc(merged, a + 36 * DAY)).toBe(-1)
  })
})

describe('densifyHeliocentric : la trace passe par le point de passage (2026-11-05)', () => {
  const DAY = 86_400
  const t0 = 10.5 * DAY // le passage tombe à midi, entre deux lignes journalières
  // Vraie course : droite, avec un coude brutal au passage (x suit le temps, y = |t − t0|).
  const truth = (t) => [(t - t0) * 20, Math.abs(t - t0) * 20 + 7, 0]
  const rows = (start, step, count) => Array.from({ length: count }, (_, i) => truth(start + i * step))
  const daily = { start: 0, step_seconds: DAY, positions: rows(0, DAY, 22) }
  const object = {
    table: daily,
    segments: [{ start: t0 - 2 * DAY, step_seconds: 300, positions: rows(t0 - 2 * DAY, 300, (4 * DAY) / 300 + 1) }],
  }
  const sun = { start: 0, step_seconds: DAY, positions: Array.from({ length: 22 }, (_, i) => [1000 * i, -500 * i, 3 * i]) }
  const sunAt = (t) => sampleTable(sun, t, [0, 0, 0])
  const helioTruth = (t) => {
    const p = positionAt(object, t, [0, 0, 0])
    const s = sunAt(t)
    return [p[0] - s[0], p[1] - s[1], p[2] - s[2]]
  }
  const sampleAt = (t) => helioTruth(t)
  const path = heliocentricPath(daily, sun)
  const dense = heliocentricDenseTimes([t0], 0, 21 * DAY)
  const merged = densifyHeliocentric(path, dense, sampleAt)

  // La corde journalière de la trace, évaluée à t0.
  const chordAt = (p, t) => {
    const i = p.times.findIndex((time, k) => time <= t && p.times[k + 1] > t)
    const f = (t - p.times[i]) / (p.times[i + 1] - p.times[i])
    return p.positions[i].map((v, k) => v + f * (p.positions[i + 1][k] - v))
  }

  it('à l instant du passage, la trace densifiée passe par positionAt − Soleil ; la corde journalière s en écarte', () => {
    const k = merged.times.indexOf(t0)
    expect(k).toBeGreaterThanOrEqual(0)
    const want = helioTruth(t0)
    for (let c = 0; c < 3; c++) expect(merged.positions[k][c]).toBeCloseTo(want[c], 6)
    const chord = chordAt(path, t0)
    expect(Math.abs(chord[1] - want[1])).toBeGreaterThan(100_000)
  })

  it('hors de ±3 jours rien ne change ; dedans les lignes journalières sont remplacées, sans doublon de date', () => {
    expect(merged.times.filter((t) => t < t0 - 3 * DAY)).toEqual(path.times.filter((t) => t < t0 - 3 * DAY))
    expect(new Set(merged.times).size).toBe(merged.times.length)
    expect(merged.times).toEqual([...merged.times].sort((x, y) => x - y))
    expect(merged.times.filter((t) => Math.abs(t - t0) < DAY).length).toBeGreaterThan(500)
  })

  it('sans passage chargé : la ligne journalière telle quelle', () => {
    expect(densifyHeliocentric(path, heliocentricDenseTimes([], 0, 21 * DAY), sampleAt)).toEqual(path)
  })
})
