/**
 * Sampling of a uniform-step position table (`number[][]`, one [x, y, z] per
 * step). Pure: no Three.js, no DOM.
 */

/**
 * Catmull-Rom (cubic through samples i-1, i, i+1, i+2) at fractional index `f`.
 * Writes into `out` ([x, y, z], allocation-free — called per frame per planet).
 *
 * `f` is clamped to the table. The two edge intervals (no sample before i, or
 * none after i+1) use the quadratic through the three nearest samples instead,
 * which keeps Catmull-Rom's quadratic precision there: a planet table starts on
 * the 1st of the month, so a linear edge would bring Mercury's 63 258 km error
 * back for the whole first day of every month. Two samples → linear; one →
 * that sample.
 *
 * @param {number[][]} positions
 * @param {number} f fractional index
 * @param {number[]} out
 * @returns {number[]} out
 */
export function sampleCatmullRom(positions, f, out) {
  const last = positions.length - 1
  if (last < 1) {
    const p = positions[0]
    out[0] = p[0]
    out[1] = p[1]
    out[2] = p[2]
    return out
  }
  const fc = f < 0 ? 0 : f > last ? last : f
  const i = Math.min(Math.floor(fc), last - 1)
  const t = fc - i
  const p1 = positions[i]
  const p2 = positions[i + 1]
  if (last < 2) {
    for (let k = 0; k < 3; k++) out[k] = p1[k] + (p2[k] - p1[k]) * t
    return out
  }
  if (i === 0 || i + 2 > last) {
    // Lagrange weights on three consecutive samples a, b, c at nodes 0, 1, 2,
    // evaluated at x: t on the first interval, 1 + t on the last.
    const j = i === 0 ? 0 : i - 1
    const x = i === 0 ? t : 1 + t
    const wa = ((x - 1) * (x - 2)) / 2
    const wb = -x * (x - 2)
    const wc = (x * (x - 1)) / 2
    const a = positions[j]
    const b = positions[j + 1]
    const c = positions[j + 2]
    for (let k = 0; k < 3; k++) out[k] = wa * a[k] + wb * b[k] + wc * c[k]
    return out
  }
  const p0 = positions[i - 1]
  const p3 = positions[i + 2]
  const t2 = t * t
  const t3 = t2 * t
  for (let k = 0; k < 3; k++) {
    out[k] =
      0.5 *
      (2 * p1[k] +
        (-p0[k] + p2[k]) * t +
        (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 +
        (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)
  }
  return out
}

/**
 * A closed orbit sampled as a polyline, smoothed for drawing: `factor - 1`
 * Catmull-Rom points inserted per segment. Geometry only — it breaks the
 * index <-> time correspondence, so never use it for placing a body.
 *
 * The samples span one period, so the last is (nearly) the first again. That
 * duplicate is dropped and neighbours wrap modulo n, **shifted by the closure
 * gap** (the period is rounded to the minute, and perturbations keep the orbit
 * from closing exactly — by millions of km for Uranus and Neptune). The result
 * ends on the original last sample: n * factor + 1 points, and last == first
 * only when the samples close exactly.
 *
 * If the last sample is farther from the first than the mean segment length,
 * the data is not a loop (partial arc): it is treated as open, endpoints
 * duplicated as their own neighbours, and no point is added to close it.
 *
 * @param {number[][]} positions
 * @param {number} factor integer >= 1
 * @returns {number[][]}
 */
export function subdivideClosedLoop(positions, factor) {
  if (factor <= 1 || positions.length < 4) return positions.map((p) => [p[0], p[1], p[2]])
  const first = positions[0]
  const lastP = positions[positions.length - 1]
  let path = 0
  for (let i = 1; i < positions.length; i++) {
    path += Math.hypot(
      positions[i][0] - positions[i - 1][0],
      positions[i][1] - positions[i - 1][1],
      positions[i][2] - positions[i - 1][2],
    )
  }
  const gap = Math.hypot(lastP[0] - first[0], lastP[1] - first[1], lastP[2] - first[2])
  const closed = gap <= path / (positions.length - 1)
  const pts = closed ? positions.slice(0, -1) : positions
  const n = pts.length
  // Wrapping borrows a neighbour from the other end of the period, so it is
  // shifted by the closure gap: the sample before the first is "the last but
  // one, one period earlier". Plain modulo was enough for Mercury (gap 118 km)
  // but not for the outer planets, whose loop misses itself by millions of km
  // after 84 or 165 years (Uranus 2 979 253 km, Neptune 3 782 079): the wrong
  // neighbour bent the curve's start and put Uranus 63 000 km (2,5 radii) off
  // its own line two weeks into the month, Neptune 22 700 — down to ≤ 5 700 and
  // ≤ 2 500 km with the shift (measured over 2026-10, against Horizons).
  // Fresh arrays, not a scratch buffer: the last segment asks for two wrapped
  // neighbours at once (i + 1 and i + 2). Only the two ends allocate.
  const drift = [lastP[0] - first[0], lastP[1] - first[1], lastP[2] - first[2]]
  const at = closed
    ? (i) => {
        if (i >= 0 && i < n) return pts[i]
        const p = pts[((i % n) + n) % n]
        const sign = i < 0 ? -1 : 1
        return [p[0] + sign * drift[0], p[1] + sign * drift[1], p[2] + sign * drift[2]]
      }
    : (i) => pts[i < 0 ? 0 : i > n - 1 ? n - 1 : i]
  const segments = closed ? n : n - 1
  const out = []
  const tmp = [0, 0, 0]
  for (let i = 0; i < segments; i++) {
    const p0 = at(i - 1)
    const p1 = at(i)
    const p2 = at(i + 1)
    const p3 = at(i + 2)
    for (let s = 0; s < factor; s++) {
      const t = s / factor
      const t2 = t * t
      const t3 = t2 * t
      for (let k = 0; k < 3; k++) {
        tmp[k] =
          0.5 *
          (2 * p1[k] +
            (-p0[k] + p2[k]) * t +
            (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 +
            (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)
      }
      out.push(s === 0 ? [p1[0], p1[1], p1[2]] : [tmp[0], tmp[1], tmp[2]])
    }
  }
  // A loop ends where its samples end — one period on, `drift` away from the
  // start — rather than being forced shut: closing it would draw a straight
  // segment across the gap (3 000 000 km for Uranus) right beside the planet.
  const end = closed ? lastP : at(n - 1)
  out.push([end[0], end[1], end[2]])
  return out
}

/**
 * An open table (one sample per step) redrawn as the very curve
 * `sampleCatmullRom` places a body on: `factor` points per step, at
 * f = k / factor. Use it when a body is placed from a table and its line is
 * drawn from the same table — the body then lies on its line by construction,
 * which straight chords stopped guaranteeing once placement went cubic.
 *
 * @param {number[][]} positions
 * @param {number} factor integer >= 1
 * @returns {number[][]} (n - 1) * factor + 1 points
 */
export function subdivideTable(positions, factor) {
  const n = positions.length
  if (factor <= 1 || n < 3) return positions.map((p) => [p[0], p[1], p[2]])
  const out = []
  for (let k = 0; k <= (n - 1) * factor; k++) out.push(sampleCatmullRom(positions, k / factor, [0, 0, 0]))
  return out
}

