import { describe, it, expect } from 'vitest'
import { subdivideTable, sampleCatmullRom, subdivideClosedLoop } from '../src/interpolate.js'

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

