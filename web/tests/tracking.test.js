import { describe, expect, it } from 'vitest'

import {
  FLYBY_HALF_SECONDS,
  MAX_TRACKED,
  TRACK_COLORS,
  addTracked,
  flybyArcTimes,
  freeColor,
  interpretSearch,
  isTrackedDesignation,
  nextApproach,
  numberSearchHelp,
  positionAt,
  readTrackedList,
  removeTracked,
  replaceSpkid,
  tableAt,
} from '../src/tracking.js'

// Ce qui est épinglé : les règles que l'œil ne voit pas casser. Quelle table lit-on
// à un instant donné (une erreur de 34 000 km à 40 000 km de la Terre ne se voit
// pas, mais un segment fin ignoré fait exactement ça), ce qui reste quand le
// stockage est abîmé, et qu'un astéroïde qui n'est pas un NEO n'a ni rapprochement
// ni segment sans que ce soit une erreur.

const rec = (n, extra = {}) => ({ spkid: String(20000000 + n), des: `D${n}`, fullname: `Objet ${n}`, neo: true, ...extra })

describe('addTracked / removeTracked', () => {
  it('plafonne à 5 et refuse le sixième avec sa raison', () => {
    let list = []
    for (let i = 1; i <= MAX_TRACKED; i++) {
      const out = addTracked(list, rec(i))
      expect(out.added).toBe(true)
      list = out.list
    }
    const refused = addTracked(list, rec(6))
    expect(refused.added).toBe(false)
    expect(refused.reason).toBe('full')
    expect(refused.list).toBe(list)
    expect(list).toHaveLength(5)
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

  it('les cinq couleurs sont distinctes et à part des NEO (cyan 0x7fe0ff, rouge 0xff4d4d)', () => {
    expect(new Set(TRACK_COLORS).size).toBe(MAX_TRACKED)
    expect(TRACK_COLORS).not.toContain(0x7fe0ff)
    expect(TRACK_COLORS).not.toContain(0xff4d4d)
    let list = []
    for (let i = 1; i <= MAX_TRACKED; i++) list = addTracked(list, rec(i)).list
    expect(new Set(list.map((r) => r.color)).size).toBe(MAX_TRACKED)
  })

  it('un non-NEO reste un non-NEO : neo n\'est vrai que pour true', () => {
    expect(addTracked([], rec(1, { neo: false })).list[0].neo).toBe(false)
    expect(addTracked([], rec(1, { neo: 'oui' })).list[0].neo).toBe(false)
    expect(addTracked([], rec(1, { neo: null })).list[0].neo).toBe(false)
  })

  it('replaceSpkid garde la couleur (numérotation : 5xxxxxxx devient 2xxxxxxx)', () => {
    const list = addTracked([], rec(1, { spkid: '50000123' })).list
    const next = replaceSpkid(list, '50000123', '20004000')
    expect(next[0]).toMatchObject({ spkid: '20004000', color: list[0].color })
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

  it('tronque à 5 et déduplique avant de tronquer', () => {
    const raw = [rec(1), rec(1), ...[2, 3, 4, 5, 6, 7].map((i) => rec(i))]
    const list = readTrackedList(raw)
    expect(list).toHaveLength(MAX_TRACKED)
    expect(new Set(list.map((r) => r.spkid)).size).toBe(MAX_TRACKED)
    expect(list.map((r) => r.spkid)).toEqual([1, 2, 3, 4, 5].map((i) => rec(i).spkid))
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
    expect(new Set(list.map((r) => r.color)).size).toBe(4)
    for (const r of list) expect(TRACK_COLORS).toContain(r.color)
  })

  it('un neo douteux (chaîne, nombre) est lu comme « pas un NEO »', () => {
    expect(readTrackedList([rec(1, { neo: 1 })])[0].neo).toBe(false)
  })

  it('survit à un aller-retour par JSON, comme le localStorage', () => {
    let list = []
    for (let i = 1; i <= 3; i++) list = addTracked(list, rec(i, { neo: i % 2 === 1 })).list
    expect(readTrackedList(JSON.parse(JSON.stringify(list)))).toEqual(list)
  })
})

describe('freeColor', () => {
  it('prend la première couleur libre de la palette', () => {
    expect(freeColor([])).toBe(TRACK_COLORS[0])
    expect(freeColor([{ color: TRACK_COLORS[0] }, { color: TRACK_COLORS[2] }])).toBe(TRACK_COLORS[1])
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
