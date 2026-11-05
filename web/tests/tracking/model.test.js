import { describe, expect, it } from 'vitest'

import {
  DASH_FLYBY_SECONDS,
  DASH_HELIO_SECONDS,
  FLYBY_HALF_SECONDS,
  MAX_TRACKED,
  TRACK_COLORS,
  TRACK_SLOTS,
  addTracked,
  dashKeepsSegment,
  flybyArcTimes,
  freeSlot,
  interpretSearch,
  isTrackedDesignation,
  nextApproach,
  numberSearchHelp,
  positionAt,
  readTrackedList,
  removeTracked,
  replaceSpkid,
  savedList,
  setSaved,
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
  const neo = (extra) => ({ neo: true, close_approaches: [], next_close_approach_after_window: null, ...extra })

  it('dans la fenêtre : le premier strictement après l\'instant, même si la liste est en désordre', () => {
    const object = neo({ close_approaches: [approach(300), approach(100), approach(200)] })
    expect(nextApproach(object, 150)).toMatchObject({ kind: 'in_window', time: 200 })
    expect(nextApproach(object, 0)).toMatchObject({ kind: 'in_window', time: 100 })
  })

  it('l\'instant exact d\'un rapprochement n\'est pas « le prochain » : on passe au suivant', () => {
    const object = neo({ close_approaches: [approach(100), approach(200)] })
    expect(nextApproach(object, 100)).toMatchObject({ kind: 'in_window', time: 200 })
  })

  it('tous passés : celui d\'après la fenêtre, marqué hors fenêtre (l\'horloge ne peut pas y aller)', () => {
    const object = neo({ close_approaches: [approach(100)], next_close_approach_after_window: approach(9000) })
    expect(nextApproach(object, 500)).toMatchObject({ kind: 'after_window', time: 9000 })
  })

  it('rien de connu : none', () => {
    expect(nextApproach(neo({}), 0)).toEqual({ kind: 'none' })
    expect(nextApproach(neo({ close_approaches: [approach(100)] }), 500)).toEqual({ kind: 'none' })
  })

  it('close_approaches null (CAD en panne) n\'est pas « aucun rapprochement »', () => {
    expect(nextApproach(neo({ close_approaches: null }), 0)).toEqual({ kind: 'unavailable' })
    // même s'il y a un « après la fenêtre » : sans la liste on ne sait rien de fiable
    expect(nextApproach(neo({ close_approaches: null, next_close_approach_after_window: approach(9000) }), 0)).toEqual({
      kind: 'unavailable',
    })
  })

  it('un non-NEO n\'a jamais de rapprochement, sans que ce soit une erreur', () => {
    const ceres = { neo: false, close_approaches: [], next_close_approach_after_window: null }
    expect(nextApproach(ceres, 0)).toEqual({ kind: 'none' })
    expect(nextApproach(null, 0)).toEqual({ kind: 'none' })
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

  it('serré près du périgée (5 min), lâche ailleurs (1 h)', () => {
    const at = start + 100 * DAY
    const [arc] = flybyArcTimes([at], start, end)
    const gapAfter = (t) => arc[arc.indexOf(t) + 1] - t
    expect(gapAfter(at)).toBe(300)
    expect(gapAfter(at - 10 * DAY)).toBe(3600)
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
