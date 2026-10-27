import { describe, it, expect } from 'vitest'
import { subdivideTable, sampleCatmullRom, subdivideClosedLoop, polylinePointAt } from '../src/interpolate.js'

const poly = (t) => [1 + 2 * t - 3 * t ** 2 + 0.5 * t ** 3, -4 + t ** 3, 7 - 2 * t ** 2]
const table = Array.from({ length: 8 }, (_, t) => poly(t))
const sample = (f) => sampleCatmullRom(table, f, [0, 0, 0])

describe('sampleCatmullRom', () => {
  it('passes exactly through every sample at integer f', () => {
    table.forEach((p, i) => expect(sample(i)).toEqual(p))
  })

  it('reproduces any quadratic in time exactly in interior intervals', () => {
    // Catmull-Rom has quadratic precision, NOT cubic (a cubic term leaves a
    // residual): a linear lerp is already off on a quadratic, this is not.
    const quad = (t) => [3 - t + 0.7 * t ** 2, 5 * t ** 2, -2 + 4 * t]
    const q = Array.from({ length: 8 }, (_, t) => quad(t))
    for (const f of [1.25, 2.5, 3.9, 4.01, 5.5]) {
      const want = quad(f)
      sampleCatmullRom(q, f, [0, 0, 0]).forEach((v, k) => expect(v).toBeCloseTo(want[k], 9))
    }
  })

  it('beats linear interpolation on a cubic', () => {
    const f = 3.5
    const want = poly(f)
    const lin = table[3].map((v, k) => (v + table[4][k]) / 2)
    const err = (a) => Math.max(...a.map((v, k) => Math.abs(v - want[k])))
    expect(err(sample(f))).toBeLessThan(err(lin) / 4)
  })

  it('keeps quadratic precision on the two edge intervals', () => {
    // A planet table starts on the 1st of the month: a linear edge would put
    // Mercury 63 000 km off for the whole first day of every month.
    const quad = (t) => [3 - t + 0.7 * t ** 2, 5 * t ** 2, -2 + 4 * t]
    const q = Array.from({ length: 8 }, (_, t) => quad(t))
    for (const f of [0.3, 0.9, 6.1, 6.7]) {
      const want = quad(f)
      sampleCatmullRom(q, f, [0, 0, 0]).forEach((v, k) => expect(v).toBeCloseTo(want[k], 9))
    }
  })

  it('is linear on a two-sample table', () => {
    const two = [[0, 0, 0], [10, -4, 2]]
    expect(sampleCatmullRom(two, 0.25, [0, 0, 0])).toEqual([2.5, -1, 0.5])
  })

  it('clamps outside the table', () => {
    expect(sample(-5)).toEqual(table[0])
    expect(sample(99)).toEqual(table[7])
  })

  it('writes into and returns the given array', () => {
    const out = [0, 0, 0]
    expect(sampleCatmullRom(table, 3.5, out)).toBe(out)
  })
})

describe('subdivideClosedLoop', () => {
  const R = 1000
  const N = 36
  // N distinct points plus the closing sample, like an orbit table.
  const circle = Array.from({ length: N + 1 }, (_, i) => {
    const a = (2 * Math.PI * (i % N)) / N
    return [R * Math.cos(a), R * Math.sin(a), 0]
  })
  const F = 8
  const out = subdivideClosedLoop(circle, F)

  it('passes exactly through every original sample', () => {
    circle.forEach((p, i) => expect(out[i * F]).toEqual(p))
  })

  it('is closed and has n * factor + 1 points', () => {
    expect(out).toHaveLength(N * F + 1)
    expect(out[out.length - 1]).toEqual(out[0])
  })

  it('hugs the circle at least 10x closer than the straight chords', () => {
    const sagitta = R * (1 - Math.cos(Math.PI / N))
    let worst = 0
    for (const p of out) worst = Math.max(worst, Math.abs(Math.hypot(p[0], p[1]) - R))
    expect(worst).toBeLessThan(sagitta / 10)
  })

  it('factor 1 returns the original geometry', () => {
    expect(subdivideClosedLoop(circle, 1)).toEqual(circle)
  })

  it('follows a loop that does not close, at both ends', () => {
    // An outer planet's period-long table misses itself by millions of km.
    // Model: the circle drifting steadily, so the last sample lands short of
    // the first. Wrapping without the shift bent the curve's start toward the
    // far end — Uranus 63 000 km off its line (2026-10-15).
    const D = [150, 0, 0] // closure gap, under one segment (~174) so still a loop
    const truth = (u) => {
      const a = (2 * Math.PI * u) / N
      return [R * Math.cos(a) + (D[0] * u) / N, R * Math.sin(a), 0]
    }
    const drifting = Array.from({ length: N + 1 }, (_, i) => truth(i))
    const o = subdivideClosedLoop(drifting, F)
    const sagitta = R * (1 - Math.cos(Math.PI / N))
    for (const j of [...Array(F).keys(), ...Array.from({ length: F }, (_, s) => (N - 1) * F + s)]) {
      expect(Math.hypot(...o[j].map((v, k) => v - truth(j / F)[k]))).toBeLessThan(sagitta / 10)
    }
    expect(o[o.length - 1]).toEqual(drifting[N])
  })

  it('does not close a partial arc', () => {
    const arc = circle.slice(0, 10)
    const o = subdivideClosedLoop(arc, F)
    expect(o).toHaveLength(9 * F + 1)
    expect(o[o.length - 1]).toEqual(arc[9])
  })
})

describe('subdivideTable', () => {
  // The Earth is placed with sampleCatmullRom and drawn from the same table:
  // every placed position must be a vertex of the drawn line, or the globe
  // drifts off its orbit (~5 700 km with straight chords, 2026-10-15).
  const quad = (t) => [3 - t + 0.7 * t ** 2, 5 * t ** 2, -2 + 4 * t]
  const q = Array.from({ length: 6 }, (_, t) => quad(t))

  it('has (n - 1) * factor + 1 points and passes through every sample', () => {
    const line = subdivideTable(q, 8)
    expect(line).toHaveLength(5 * 8 + 1)
    q.forEach((p, i) => line[i * 8].forEach((v, k) => expect(v).toBeCloseTo(p[k], 9)))
  })

  it('puts every vertex on the true quadratic, edges included', () => {
    subdivideTable(q, 8).forEach((p, j) => {
      const want = quad(j / 8)
      p.forEach((v, k) => expect(v).toBeCloseTo(want[k], 9))
    })
  })
})


describe('sampleCatmullRom on Io\'s orbit at the hourly step', () => {
  // Measured invariant (2026-10-16): circle r = 421 700 km, period 1,769 d, one
  // sample per 3 600 s. A lerp between samples is off by 1 154 km (sagitta);
  // the cubic by 22 km interior, 88 km on the edge intervals. Bounds below sit
  // above the measured values with margin, and well under the lerp's error.
  const R = 421_700
  const w = (2 * Math.PI) / (1.769 * 86_400)
  const at = (s) => [R * Math.cos(w * s), R * Math.sin(w * s), 0]
  const n = 120
  const io = Array.from({ length: n }, (_, i) => at(i * 3600))
  const worst = (from, to) => {
    let max = 0
    const out = [0, 0, 0]
    for (let f = from; f <= to; f += 0.05) {
      sampleCatmullRom(io, f, out)
      const want = at(f * 3600)
      max = Math.max(max, Math.hypot(out[0] - want[0], out[1] - want[1]))
    }
    return max
  }

  it('stays under 40 km in the interior, where a lerp is off by over 1 000', () => {
    expect(worst(2, n - 3)).toBeLessThan(40)
    const f = 10.5
    const a = io[10]
    const b = io[11]
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    const want = at(f * 3600)
    expect(Math.hypot(mid[0] - want[0], mid[1] - want[1])).toBeGreaterThan(1000)
  })

  it('stays under 120 km on the first and last intervals (quadratic edge)', () => {
    expect(worst(0, 1)).toBeLessThan(120)
    expect(worst(n - 2, n - 1)).toBeLessThan(120)
  })
})

describe('polylinePointAt', () => {
  // Cercle ferme : le sommet f * facteur de subdivideClosedLoop EST l'echantillon
  // f, c'est ce qui permet a planets.js de retrouver "ou est la ligne a l'instant t".
  const R = 1e6
  const samples = Array.from({ length: 13 }, (_, i) => [R * Math.cos((i / 12) * 2 * Math.PI), R * Math.sin((i / 12) * 2 * Math.PI), 0])
  const flat = Float64Array.from(subdivideClosedLoop(samples, 8).flat())
  const out = { x: 0, y: 0, z: 0 }

  it('retombe sur l\'echantillon f au sommet f * facteur', () => {
    for (const f of [0, 3, 7, 12]) {
      polylinePointAt(flat, f * 8, out)
      expect(out.x).toBeCloseTo(samples[f][0], 4)
      expect(out.y).toBeCloseTo(samples[f][1], 4)
    }
  })

  it('suit la corde entre deux sommets et borne aux extremites', () => {
    polylinePointAt([0, 0, 0, 10, 20, 30, 20, 40, 60], 1.5, out)
    expect([out.x, out.y, out.z]).toEqual([15, 30, 45])
    polylinePointAt([0, 0, 0, 10, 20, 30], 9, out)
    expect([out.x, out.y, out.z]).toEqual([10, 20, 30])
  })

  it('le corps est sur la ligne translatee de (corps - point de ligne)', () => {
    const body = { x: R * Math.cos(1.0), y: R * Math.sin(1.0), z: 0 } // entre deux echantillons
    const g = (1.0 / ((2 * Math.PI) / 12)) * 8
    polylinePointAt(flat, g, out)
    const offset = { x: body.x - out.x, y: body.y - out.y, z: body.z - out.z }
    polylinePointAt(flat, g, out)
    expect(Math.hypot(out.x + offset.x - body.x, out.y + offset.y - body.y)).toBeLessThan(1e-6)
    expect(Math.hypot(offset.x, offset.y)).toBeLessThan(R * 5e-3) // un petit decalage, pas un saut
  })
})
