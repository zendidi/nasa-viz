/**
 * The sky: real stars, their hover highlight, and the constellation stick
 * figures. It owns everything about the celestial shell — the loaders, the
 * buffers, the French constellation names — and hands out only what the rest
 * of the scene needs: the group to follow the camera with, the star positions
 * to pick against, and two commands (highlight a star, show a figure).
 *
 * Picking itself stays outside: deciding *which* star is under the cursor
 * needs the camera, the canvas and the bodies that occlude it.
 */

import * as THREE from 'three'
import { latLngToVector3 } from './geo.js'

const STAR_SHELL_RADIUS = 80

/**
 * Sky materials render in the *opaque* pass (transparent: false) with a low
 * renderOrder, so they're drawn before every body and never depth-tested. A
 * transparent sky would be drawn after the opaque Moon/NEOs and — at true
 * scale, where those sit well beyond STAR_SHELL_RADIUS — paint stars over
 * them. Additive blending still gives soft point edges (three.js forces normal
 * blending off for non-transparent materials) and looks identical on black.
 */
const skyMaterialOptions = {
  transparent: false,
  blending: THREE.AdditiveBlending,
  depthTest: false,
  depthWrite: false,
}
const SKY_RENDER_ORDER = -10

/**
 * Real star positions (right ascension/declination) and colors from a
 * Hipparcos-derived catalog (d3-celestial, BSD-3), trimmed to naked-eye
 * stars (mag <= 5, ~1600 stars) and bundled at web/public/stars.json.
 * Point size and color follow physically-motivated formulas from magnitude
 * and B-V color index — this is a real sky, not decoration. A 5th element
 * per star carries its traditional/IAU proper name where one exists
 * (~450 of ~1600 — most naked-eye stars have no common name), empty string
 * otherwise, used to power the hover tooltip. A 6th carries its IAU
 * constellation code (e.g. "Ori"), used to draw that constellation's lines
 * on hover — see loadConstellationLines().
 */
async function loadRealStarfield() {
  const res = await fetch('/stars.json')
  if (!res.ok) throw new Error(`stars.json: ${res.status}`)
  /** @type {Array<[number, number, number, number, string, string]>} */
  const stars = await res.json()

  const positions = new Float32Array(stars.length * 3)
  const colors = new Float32Array(stars.length * 3)
  const sizes = new Float32Array(stars.length)
  const names = new Array(stars.length)
  const constellations = new Array(stars.length)

  stars.forEach(([ra, dec, mag, bv, name, con], i) => {
    const p = latLngToVector3(dec, ra, STAR_SHELL_RADIUS)
    positions[i * 3] = p.x
    positions[i * 3 + 1] = p.y
    positions[i * 3 + 2] = p.z

    const color = bvToColor(bv)
    colors[i * 3] = color.r
    colors[i * 3 + 1] = color.g
    colors[i * 3 + 2] = color.b

    // Flux ~ 10^(-0.4*mag), apparent radius ~ sqrt(flux) ~ 10^(-0.2*mag).
    sizes[i] = THREE.MathUtils.clamp(3 * Math.pow(10, -0.2 * mag), 0.6, 5)
    names[i] = name || ''
    constellations[i] = con || ''
  })

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geometry.setAttribute('size', new THREE.BufferAttribute(sizes, 1))

  const material = new THREE.ShaderMaterial({
    uniforms: {},
    vertexShader: `
      attribute float size;
      attribute vec3 color;
      varying vec3 vColor;
      void main() {
        vColor = color;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = size * (300.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      varying vec3 vColor;
      void main() {
        float d = length(gl_PointCoord - vec2(0.5));
        float alpha = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(vColor, alpha);
      }
    `,
    ...skyMaterialOptions,
  })
  const points = new THREE.Points(geometry, material)
  points.renderOrder = SKY_RENDER_ORDER

  // Clones: the "size"/"color" BufferAttributes above wrap these same typed
  // arrays, so hover highlighting (which mutates them in place) needs an
  // untouched copy to restore from.
  return {
    points,
    names,
    constellations,
    baseSizes: sizes.slice(),
    baseColors: colors.slice(),
  }
}

/**
 * Constellation stick-figure lines (d3-celestial, BSD-3, same source as the
 * star catalog — ra/dec already share its -180..180 convention, so no
 * reprojection needed). web/public/constellations.json maps each IAU code to
 * its polylines: `{ code: [[[ra, dec], [ra, dec], ...], ...] }`. Built as one
 * hidden THREE.LineSegments per constellation so hovering a star can toggle
 * just that constellation's figure on.
 */
async function loadConstellationLines() {
  const res = await fetch('/constellations.json')
  if (!res.ok) throw new Error(`constellations.json: ${res.status}`)
  /** @type {Record<string, Array<Array<[number, number]>>>} */
  const lines = await res.json()

  const parent = new THREE.Group()
  const material = new THREE.LineBasicMaterial({ color: 0x6fb7ff, opacity: 0.55, ...skyMaterialOptions })
  const groups = new Map()

  for (const [code, polylines] of Object.entries(lines)) {
    const segmentPoints = []
    for (const polyline of polylines) {
      for (let i = 0; i < polyline.length - 1; i++) {
        const [ra1, dec1] = polyline[i]
        const [ra2, dec2] = polyline[i + 1]
        segmentPoints.push(latLngToVector3(dec1, ra1, STAR_SHELL_RADIUS))
        segmentPoints.push(latLngToVector3(dec2, ra2, STAR_SHELL_RADIUS))
      }
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(segmentPoints)
    const segments = new THREE.LineSegments(geometry, material)
    segments.renderOrder = SKY_RENDER_ORDER + 1
    segments.visible = false
    groups.set(code, segments)
    parent.add(segments)
  }

  return { parent, groups }
}

/** Ballesteros' B-V → Kelvin, then the Tanner Helland blackbody → RGB approximation. */
function bvToColor(bv) {
  const kelvin = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62))
  const t = kelvin / 100
  const clamp01 = (x) => THREE.MathUtils.clamp(x, 0, 255) / 255

  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592)
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492)
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307

  return new THREE.Color(clamp01(r), clamp01(g), clamp01(b))
}

/** Used only if stars.json fails to load — a placeholder, not a real sky. */
function makeFallbackStarfield() {
  const count = 2000
  const positions = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const theta = Math.random() * Math.PI * 2
    const phi = Math.acos(Math.random() * 2 - 1)
    positions[i * 3] = STAR_SHELL_RADIUS * Math.sin(phi) * Math.cos(theta)
    positions[i * 3 + 1] = STAR_SHELL_RADIUS * Math.cos(phi)
    positions[i * 3 + 2] = STAR_SHELL_RADIUS * Math.sin(phi) * Math.sin(theta)
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  const points = new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0xffffff, size: 0.08, ...skyMaterialOptions }))
  points.renderOrder = SKY_RENDER_ORDER
  return points
}

// The pick target is a coarse screen-space radius, so several neighbouring
// points are plausible hits at once — magnifying and brightening whichever one
// actually won tells the user exactly which star the tooltip is talking about.
const STAR_HIGHLIGHT_SIZE_FACTOR = 1
const STAR_HIGHLIGHT_MIN_SIZE = 4
const STAR_HIGHLIGHT_WHITEN = 0.6 // 0 = original color, 1 = full white

/**
 * Builds the sky, starts loading it, and adds it to `scene`. The three fetches
 * are fire-and-forget: the scene renders without a sky until they land, and a
 * failed star catalog falls back to a placeholder field rather than nothing.
 *
 * @param {THREE.Scene} scene
 */
export function createStarfield(scene) {
  /**
   * Stars and constellation figures live in one group that follows the
   * camera's position (not its rotation) every frame, so the sky stays "at
   * infinity" however far the camera travels at true scale. Drawn first and
   * never depth-tested — see skyMaterialOptions.
   */
  const group = new THREE.Group()
  scene.add(group)

  let points = null
  let names = []
  let constellations = []
  let baseSizes = null
  let baseColors = null
  loadRealStarfield()
    .then((loaded) => {
      points = loaded.points
      names = loaded.names
      constellations = loaded.constellations
      baseSizes = loaded.baseSizes
      baseColors = loaded.baseColors
      group.add(loaded.points)
    })
    .catch(() => group.add(makeFallbackStarfield()))

  // { code: "Orion" } (French common names — falls back to the international/Latin
  // name in the source data where no French one exists). Fetched separately from
  // the line geometry since it's tiny and only needed for the hover tooltip.
  let constellationNames = {}
  fetch('/constellation-names.json')
    .then((res) => (res.ok ? res.json() : {}))
    .then((data) => {
      constellationNames = data
    })
    .catch(() => {})

  let constellationGroups = new Map()
  loadConstellationLines()
    .then((loaded) => {
      constellationGroups = loaded.groups
      group.add(loaded.parent)
    })
    .catch(() => {})

  let hoveredIndex = null

  /** Magnifies and whitens one star, restoring the previous one. `null` clears. */
  function highlight(index) {
    if (!points || hoveredIndex === index) return
    const sizeAttr = points.geometry.getAttribute('size')
    const colorAttr = points.geometry.getAttribute('color')

    if (hoveredIndex !== null) {
      sizeAttr.array[hoveredIndex] = baseSizes[hoveredIndex]
      colorAttr.setXYZ(
        hoveredIndex,
        baseColors[hoveredIndex * 3],
        baseColors[hoveredIndex * 3 + 1],
        baseColors[hoveredIndex * 3 + 2],
      )
    }

    hoveredIndex = index

    if (index !== null) {
      sizeAttr.array[index] = Math.max(baseSizes[index] * STAR_HIGHLIGHT_SIZE_FACTOR, STAR_HIGHLIGHT_MIN_SIZE)
      colorAttr.setXYZ(
        index,
        THREE.MathUtils.lerp(baseColors[index * 3], 1, STAR_HIGHLIGHT_WHITEN),
        THREE.MathUtils.lerp(baseColors[index * 3 + 1], 1, STAR_HIGHLIGHT_WHITEN),
        THREE.MathUtils.lerp(baseColors[index * 3 + 2], 1, STAR_HIGHLIGHT_WHITEN),
      )
    }

    sizeAttr.needsUpdate = true
    colorAttr.needsUpdate = true
  }

  let shownConstellationCode = null

  /**
   * Shows one constellation's line figure (by IAU code), hiding whichever was
   * shown before. `code` may be '' or null (no figure under the cursor) —
   * clears cleanly either way.
   *
   * @returns {string|null} its French name, for the caller's tooltip
   */
  function showConstellation(code) {
    if (code !== shownConstellationCode) {
      const prev = constellationGroups.get(shownConstellationCode)
      if (prev) prev.visible = false
      shownConstellationCode = code
      const next = constellationGroups.get(code)
      if (next) next.visible = true
    }

    return (code && constellationNames[code]) || null
  }

  return {
    /** The sky group — animate() parks it on the camera every frame. */
    group,
    /** Star positions in the sky group, for screen-space picking; null until loaded. */
    get positionAttribute() {
      return points ? points.geometry.getAttribute('position') : null
    },
    /** Proper name of star `index`, '' for the ~70 % that have none. */
    nameOf: (index) => names[index] ?? '',
    /** IAU constellation code of star `index` (e.g. "Ori"), '' if unknown. */
    constellationOf: (index) => constellations[index] ?? '',
    highlight,
    showConstellation,
  }
}
