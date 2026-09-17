import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { fetchIssPosition, fetchNeoFeed, fetchNeoPositions, fetchNeoDetails, fetchApod, fetchUsage } from './api.js'
import { loadCached, saveCached } from './cache.js'
import { getSunEquatorial, getMoonEquatorial, getGreenwichSiderealTime } from './astronomy.js'
import { orbitSchematicSvg } from './orbit.js'
import {
  NEO_DEFAULT_COLOR,
  NEO_HAZARD_COLOR,
  NEO_CREDITS,
  TAXONOMY,
  taxonomyKey,
  cssColor,
  escapeHtml,
  neoTooltipSuffix,
  sourcesPanelHtml,
  sourcesBlockHtml,
  detailsBlockHtml,
} from './neoInfo.js'
import {
  EARTH_RADIUS,
  KM_TO_UNITS,
  LUNAR_DISTANCE_KM,
  MOON_RADIUS_KM,
  ISS_READABLE_RADIUS,
  SUN_READABLE_RADIUS,
  SCALE_STEPS,
  SCALE_PRESETS,
  lerpLog,
  sceneDistance,
  issOrbitRadius,
  issRadius,
  neoRadius,
  sunDistance,
  sunRadius,
  worldPerPixel,
  describeScale,
  remapCameraDistance,
} from './scale.js'

// Distances and sizes of everything but the Earth depend on the "réalisme"
// scale (scaleT, see scale.js and docs/echelle-reelle.md): readable at 0,
// true proportions at 1. The light only needs a direction.
const SUN_LIGHT_DISTANCE = 30
const MOON_RADIUS = MOON_RADIUS_KM * KM_TO_UNITS

// Floor on each body's on-screen radius, in pixels — at true scale almost
// everything is sub-pixel (the whole Earth–Moon system is ~5 px when framing a
// NEO at 0.5 au), so without these nothing would show at all.
const MIN_RADIUS_PX = { earth: 2, moon: 1.5, iss: 2.5, neo: 2.5, sun: 3 }
const NEO_HIT_MIN_RADIUS_PX = 8

// Reference circles, in lunar distances — see makeDistanceRings().
const RING_LUNAR_DISTANCES = [1, 10, 100]
const OBLIQUITY_RAD = (23.439 * Math.PI) / 180

const app = document.getElementById('app')

// --- scene setup ---------------------------------------------------------

const scene = new THREE.Scene()
// Far plane covers the Sun at true scale (~47 000 units); the logarithmic
// depth buffer keeps that range from z-fighting close to the Earth.
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.01, 1e6)
camera.position.set(0, 3, 8)

const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true })
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
app.appendChild(renderer.domElement)

const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
// min/max distance and zoom speed follow the scale — see updateCameraLimits().
controls.minDistance = 3.5
controls.maxDistance = 20

renderer.outputColorSpace = THREE.SRGBColorSpace

// Dimmed vs. the old flat-shaded globe (0.6): the day/night shader now handles
// day-side lighting explicitly and the night texture supplies its own city
// lights, so a strong ambient would wash both out.
scene.add(new THREE.AmbientLight(0xffffff, 0.15))
const sunLight = new THREE.DirectionalLight(0xffffff, 1.2)
scene.add(sunLight)

/**
 * Skybox: stars and constellation figures live in one group that follows the
 * camera's position (not its rotation) every frame, so the sky stays "at
 * infinity" however far the camera travels at true scale. Drawn first and
 * never depth-tested — see skyMaterialOptions.
 */
const skyGroup = new THREE.Group()
scene.add(skyGroup)

let globeMaterial = null
let globeSphere = null
let starPoints = null
let starNames = []
let starConstellations = []
let starBaseSizes = null
let starBaseColors = null
loadRealStarfield()
  .then(({ points, names, constellations, baseSizes, baseColors }) => {
    starPoints = points
    starNames = names
    starConstellations = constellations
    starBaseSizes = baseSizes
    starBaseColors = baseColors
    skyGroup.add(points)
  })
  .catch(() => skyGroup.add(makeFallbackStarfield()))

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
  .then(({ parent, groups }) => {
    constellationGroups = groups
    skyGroup.add(parent)
  })
  .catch(() => {})

const globe = makeGlobe()
scene.add(globe)

// Child of globe (not scene) so it turns with the real Earth rotation set in
// animate() — its position is computed in the globe's own unrotated
// lat/lng frame, same as the texture, so it always sits over the right spot.
const issMarker = makeIssMarker()
issMarker.visible = false // until a position is known
globe.add(issMarker)

const sunMarker = makeSunMarker()
scene.add(sunMarker)

const moon = makeMoon()
scene.add(moon)

const neoGroup = new THREE.Group()
scene.add(neoGroup)

const distanceRings = makeDistanceRings()
scene.add(distanceRings.group)

// --- astronomy (real Sun/Moon positions) --------------------------------------

/**
 * Real equatorial Sun direction (right ascension/declination, same convention
 * as star placement) drives the light, the visible Sun marker, and (via the
 * globe's shader uniform, in world space) the day/night terminator. This is a
 * fixed-stars-style frame, deliberately NOT tied to the globe's own real
 * rotation (set from GMST in animate(), see docs/agent/decisions.md) — the
 * shader transforms its own normal into world space via modelMatrix each
 * fragment, so the globe's spin sweeps the terminator across the texture with
 * no extra per-frame JS work needed.
 */
const sunDirWorld = new THREE.Vector3()
const moonDirWorld = new THREE.Vector3()
let moonDistanceKm = LUNAR_DISTANCE_KM

function updateAstronomy() {
  const now = new Date()

  const { ra, dec } = getSunEquatorial(now)
  sunDirWorld.copy(latLngToVector3(dec, ra, 1))
  sunLight.position.copy(sunDirWorld).multiplyScalar(SUN_LIGHT_DISTANCE)
  // The globe shader reads sunDirection in world space and does its own
  // modelMatrix transform per-fragment, so the globe's real rotation (set
  // from GMST in animate()) sweeps the terminator across the texture with
  // no extra per-frame work here.
  globeMaterial.uniforms.sunDirection.value.copy(sunDirWorld)

  // Real direction and distance only — where that lands in the scene depends
  // on the current scale, applied per frame in applyScale().
  const moonPos = getMoonEquatorial(now)
  moonDirWorld.copy(latLngToVector3(moonPos.dec, moonPos.ra, 1))
  moonDistanceKm = moonPos.distanceKm
}

updateAstronomy()
// Real drift is slow (~1°/day for the Sun, ~0.5°/h for the Moon) — no need to recompute every frame.
setInterval(updateAstronomy, 60_000)

// --- geo helpers -----------------------------------------------------------

function latLngToVector3(lat, lng, radius) {
  const phi = (90 - lat) * (Math.PI / 180)
  const theta = (lng + 180) * (Math.PI / 180)
  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  )
}

/** Deterministic pseudo-random unit vector, stable per NEO id across refreshes. */
function hashToDirection(id) {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (Math.imul(31, h) + id.charCodeAt(i)) | 0
  const rand = (seed) => {
    const x = Math.sin(seed) * 43758.5453
    return x - Math.floor(x)
  }
  const theta = rand(h) * Math.PI * 2
  const phi = Math.acos(rand(h + 1) * 2 - 1)
  return new THREE.Vector3(Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta))
}

/**
 * ICRF (x toward RA 0, z toward the celestial north pole) → scene axes, which
 * put the pole on +Y — the same mapping latLngToVector3(dec, ra, r) applies.
 */
function icrfToScene(x, y, z, out) {
  return out.set(x, z, -y)
}

/** Distance along a ray (unit dir) to a sphere's near surface, or Infinity if it misses. */
function raySphereDistance(origin, dir, center, radius) {
  const ocX = origin.x - center.x
  const ocY = origin.y - center.y
  const ocZ = origin.z - center.z
  const b = ocX * dir.x + ocY * dir.y + ocZ * dir.z
  const c = ocX * ocX + ocY * ocY + ocZ * ocZ - radius * radius
  const discriminant = b * b - c
  if (discriminant < 0) return Infinity
  const t = -b - Math.sqrt(discriminant)
  return t > 0 ? t : Infinity
}

// --- scene objects -----------------------------------------------------------

/**
 * Day/night terminator: a hand-rolled shader rather than MeshPhongMaterial,
 * blending the day map against a city-lights night map (mrdoob/three.js
 * examples, same source as the other Earth textures) by how much each
 * fragment's world-space normal faces the real Sun direction
 * (`sunDirection`, updated in updateAstronomy() from real RA/dec — see the
 * "astronomy" section above). Everything here works in world space, so the
 * globe's real rotation (animate()'s `globe.rotation.y = ...GMST...`)
 * naturally sweeps the terminator across the texture via the standard
 * `modelMatrix` transform — no extra per-frame bookkeeping needed. Normal
 * mapping (for the subtle terrain relief the old MeshPhongMaterial had) is
 * done without a
 * precomputed tangent attribute, via Schüler's screen-space-derivative method.
 */
function makeGlobe() {
  const group = new THREE.Group()
  const textureLoader = new THREE.TextureLoader()

  const dayMap = textureLoader.load('/textures/earth_atmos_2048.jpg')
  dayMap.colorSpace = THREE.SRGBColorSpace
  const nightMap = textureLoader.load('/textures/earth_lights_2048.png')
  nightMap.colorSpace = THREE.SRGBColorSpace

  globeMaterial = new THREE.ShaderMaterial({
    uniforms: {
      dayTexture: { value: dayMap },
      nightTexture: { value: nightMap },
      specularTexture: { value: textureLoader.load('/textures/earth_specular_2048.jpg') },
      normalTexture: { value: textureLoader.load('/textures/earth_normal_2048.jpg') },
      normalScale: { value: 0.6 },
      sunDirection: { value: new THREE.Vector3(1, 0, 0) },
      shininess: { value: 35.0 },
    },
    // The logdepthbuf chunks are required by the renderer's
    // logarithmicDepthBuffer: a hand-written ShaderMaterial doesn't get them
    // automatically, and without them the globe's depth wouldn't match the
    // built-in materials' (Moon, markers) — see docs/agent/gotchas.md.
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec2 vUv;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPosition;
      void main() {
        vUv = uv;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: `
      uniform sampler2D dayTexture;
      uniform sampler2D nightTexture;
      uniform sampler2D specularTexture;
      uniform sampler2D normalTexture;
      uniform float normalScale;
      uniform vec3 sunDirection;
      uniform float shininess;
      varying vec2 vUv;
      varying vec3 vWorldNormal;
      varying vec3 vWorldPosition;
      #include <logdepthbuf_pars_fragment>

      // Normal mapping without precomputed tangents (Schüler's screen-space
      // derivative method) — avoids reconstructing Three's full TBN pipeline
      // for a single hand-rolled material.
      vec3 perturbNormal(vec3 worldPos, vec3 worldNormal, vec2 uv, vec3 mapN) {
        vec3 q0 = dFdx(worldPos);
        vec3 q1 = dFdy(worldPos);
        vec2 st0 = dFdx(uv);
        vec2 st1 = dFdy(uv);
        vec3 N = normalize(worldNormal);
        vec3 T = normalize(q0 * st1.t - q1 * st0.t);
        vec3 B = normalize(cross(N, T));
        mat3 tsn = mat3(T, B, N);
        return normalize(tsn * mapN);
      }

      void main() {
        #include <logdepthbuf_fragment>
        vec3 dayColor = texture2D(dayTexture, vUv).rgb;
        vec3 nightColor = texture2D(nightTexture, vUv).rgb;
        float specMask = texture2D(specularTexture, vUv).r;

        vec3 mapN = texture2D(normalTexture, vUv).xyz * 2.0 - 1.0;
        mapN.xy *= normalScale;
        vec3 normal = perturbNormal(vWorldPosition, vWorldNormal, vUv, mapN);

        vec3 sunDir = normalize(sunDirection);
        float sunFacing = dot(normal, sunDir);
        // Soft terminator band rather than a hard day/night edge.
        float dayMix = smoothstep(-0.15, 0.15, sunFacing);

        vec3 viewDir = normalize(cameraPosition - vWorldPosition);
        vec3 reflectDir = reflect(-sunDir, normal);
        float spec = pow(max(dot(viewDir, reflectDir), 0.0), shininess) * specMask * dayMix * 0.4;

        vec3 litDay = dayColor * (0.5 + 0.5 * max(sunFacing, 0.0)) + vec3(spec);
        vec3 color = mix(nightColor, litDay, dayMix);

        gl_FragColor = vec4(color, 1.0);
        // Custom ShaderMaterial fragment shaders don't get the automatic
        // linear->output colorspace encode that built-in materials do —
        // without it, colors are displayed as if already sRGB, which
        // oversaturates warm tones (desert looked lava-orange) and crushes
        // shadows (ground looked too dark).
        #include <colorspace_fragment>
      }
    `,
  })

  // Only this mesh is enlarged by the on-screen size floor, not the group —
  // the ISS marker is a child of the group and must keep its own orbit radius.
  globeSphere = new THREE.Mesh(new THREE.SphereGeometry(EARTH_RADIUS, 64, 64), globeMaterial)
  group.add(globeSphere)

  return group
}

function makeIssMarker() {
  const group = new THREE.Group()
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(ISS_READABLE_RADIUS, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xffcc33 }),
  )
  group.add(body)

  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(ISS_READABLE_RADIUS * 2, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xffcc33, transparent: true, opacity: 0.25 }),
  )
  group.add(glow)

  return group
}

/** The Sun itself is self-lit (MeshBasicMaterial), not shaded by sunLight. */
function makeSunMarker() {
  const group = new THREE.Group()
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(SUN_READABLE_RADIUS, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xfff2cc }),
  )
  group.add(body)

  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(SUN_READABLE_RADIUS * (5 / 3), 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xfff2cc, transparent: true, opacity: 0.25 }),
  )
  group.add(glow)

  return group
}

/**
 * Textured (mrdoob/three.js examples) and lit by the same sunLight as the
 * globe — its visible phase (crescent/gibbous) falls out of that real
 * directional lighting automatically, no separate phase calculation needed.
 */
function makeMoon() {
  const textureLoader = new THREE.TextureLoader()
  const moonMap = textureLoader.load('/textures/moon_1024.jpg')
  moonMap.colorSpace = THREE.SRGBColorSpace

  return new THREE.Mesh(
    new THREE.SphereGeometry(MOON_RADIUS, 32, 32),
    new THREE.MeshPhongMaterial({ map: moonMap, shininess: 0 }),
  )
}

/**
 * Reference circles at 1, 10 and 100 lunar distances, in the ecliptic plane
 * (the Moon's orbit is within ~5° of it). Hidden in the readable layout, where
 * distances aren't proportional anyway; each is a unit circle scaled to its
 * scene distance per frame, so the 1 px line stays crisp at any scale.
 */
function makeDistanceRings() {
  const group = new THREE.Group()
  // Unit circle is drawn in XZ (normal +Y); rotating it by the obliquity about
  // X turns that normal into the ecliptic pole in scene axes, (0, cos ε, sin ε).
  group.rotation.x = OBLIQUITY_RAD

  const points = []
  for (let i = 0; i < 256; i++) {
    const a = (i / 256) * Math.PI * 2
    points.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)))
  }
  const geometry = new THREE.BufferGeometry().setFromPoints(points)
  const material = new THREE.LineBasicMaterial({ color: 0x4fa8ff, transparent: true, opacity: 0.3, depthWrite: false })

  const rings = RING_LUNAR_DISTANCES.map((lunarDistances) => {
    const line = new THREE.LineLoop(geometry, material)
    group.add(line)
    return { line, distanceKm: lunarDistances * LUNAR_DISTANCE_KM, lunarDistances }
  })

  return { group, rings }
}

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

// --- NEOs ----------------------------------------------------------------------

// Unit spheres shared by every NEO, scaled per frame in applyScale().
const neoGeometry = new THREE.SphereGeometry(1, 10, 10)
const neoHitGeometry = new THREE.SphereGeometry(1, 8, 8)
const neoMaterials = {
  default: new THREE.MeshBasicMaterial({ color: NEO_DEFAULT_COLOR }),
  hazard: new THREE.MeshBasicMaterial({ color: NEO_HAZARD_COLOR }),
  ...Object.fromEntries(Object.entries(TAXONOMY).map(([key, { color }]) => [key, new THREE.MeshBasicMaterial({ color })])),
}
const neoHitMaterial = new THREE.MeshBasicMaterial({ visible: false })

/**
 * @typedef {{
 *   neo: object, designation: string, diameterKm: number,
 *   fallbackDir: THREE.Vector3, group: THREE.Group, mesh: THREE.Mesh, hit: THREE.Mesh,
 *   positionKm: THREE.Vector3, source: 'horizons'|'horizons-clamped'|'approx'|null,
 * }} NeoEntry
 */
/** @type {NeoEntry[]} */
let neoEntries = []

// Real positions for the loaded feed, keyed by designation (JPL Horizons via
// /api/neo/positions). null = Horizons couldn't resolve that object.
let neoPositions = { range: null, stepSeconds: 3600, objects: {} }

const DESIGNATION_PATTERN = /^[A-Za-z0-9 /-]{1,40}$/

/** `neo.designation` from the backend; parsed from the name for feeds cached before that field existed. */
function designationOf(neo) {
  if (neo.designation) return neo.designation
  const match = /\(([^()]+)\)\s*$/.exec(neo.name)
  return (match ? match[1] : neo.name).trim()
}

// Per-object sheets from /api/neo/details, keyed by designation: object, or
// null when neither JPL SBDB nor IMCCE knows it. Kept in localStorage across
// feeds (catalogues change weekly at most) — see loadNeoDetails().
const NEO_DETAILS_MAX_AGE_MS = 7 * 86_400_000
/** @type {Record<string, {data: object|null, fetchedAt: number}>} */
let neoDetails = {}
{
  const cached = loadCached('neo-details')
  const now = Date.now()
  for (const [designation, record] of Object.entries(cached?.data ?? {})) {
    if (now - record.fetchedAt < NEO_DETAILS_MAX_AGE_MS) neoDetails[designation] = record
  }
}
const neoDetailsLoading = new Set()
const neoDetailsErrors = new Map()

/** Hazard wins (safety first); otherwise the spectral complex when a catalogue knows it. */
function neoMaterialFor(neo, designation) {
  if (neo.is_potentially_hazardous) return neoMaterials.hazard
  const key = taxonomyKey(neoDetails[designation]?.data?.taxonomy?.complex)
  return key ? neoMaterials[key] : neoMaterials.default
}

/** A measured diameter (IMCCE / JPL SBDB) beats the H-based estimate range. */
function neoDiameterKm(neo, designation) {
  const measured = neoDetails[designation]?.data?.diameter_km?.value
  return measured ?? (neo.estimated_diameter_km.min + neo.estimated_diameter_km.max) / 2
}

function addNeoPoints(objects) {
  neoGroup.clear()
  neoEntries = objects.map((neo) => {
    const group = new THREE.Group()
    const designation = designationOf(neo)
    const mesh = new THREE.Mesh(neoGeometry, neoMaterialFor(neo, designation))
    // Oversized invisible hit-sphere under the visible mesh makes small NEOs
    // easier to click without inflating what's rendered.
    const hit = new THREE.Mesh(neoHitGeometry, neoHitMaterial)
    mesh.userData.neo = neo
    hit.userData.neo = neo
    group.add(mesh, hit)
    neoGroup.add(group)

    return {
      neo,
      designation,
      diameterKm: neoDiameterKm(neo, designation),
      fallbackDir: hashToDirection(neo.id),
      group,
      mesh,
      hit,
      positionKm: new THREE.Vector3(),
      source: null,
    }
  })
}

/**
 * Current position of a NEO, in km, scene axes. Linear interpolation in the
 * hourly Horizons table (a NEO's path is nearly straight over an hour); clamped
 * to the table's ends if "now" is outside the feed's date range (old cached
 * feed). Without a table: arbitrary but stable direction at the close-approach
 * distance — flagged 'approx' and said so in the modal.
 */
const neoInterpA = new THREE.Vector3()
const neoInterpB = new THREE.Vector3()

function updateNeoPositionKm(entry, nowSeconds) {
  const table = neoPositions.objects[entry.designation]
  if (table && table.positions.length > 0) {
    const rows = table.positions
    const f = (nowSeconds - table.start) / neoPositions.stepSeconds
    const clamped = THREE.MathUtils.clamp(f, 0, rows.length - 1)
    const i = Math.min(Math.floor(clamped), Math.max(rows.length - 2, 0))
    const a = rows[i]
    const b = rows[Math.min(i + 1, rows.length - 1)]
    icrfToScene(a[0], a[1], a[2], neoInterpA)
    icrfToScene(b[0], b[1], b[2], neoInterpB)
    entry.positionKm.lerpVectors(neoInterpA, neoInterpB, clamped - i)
    entry.source = clamped === f ? 'horizons' : 'horizons-clamped'
    return
  }
  if (entry.neo.close_approach) {
    entry.positionKm.copy(entry.fallbackDir).multiplyScalar(entry.neo.close_approach.miss_distance_km)
    entry.source = 'approx'
    return
  }
  entry.source = null
}

function describeNeoPosition(entry) {
  updateNeoPositionKm(entry, Date.now() / 1000)
  const km = Math.round(entry.positionKm.length()).toLocaleString('fr-FR')
  switch (entry.source) {
    case 'horizons':
      return `<p><strong>Distance actuelle</strong> ${km} km <span class="muted">(position réelle, JPL Horizons)</span></p>`
    case 'horizons-clamped': {
      const table = neoPositions.objects[entry.designation]
      const f = (Date.now() / 1000 - table.start) / neoPositions.stepSeconds
      const edge = f < 0 ? table.start : table.start + (table.positions.length - 1) * neoPositions.stepSeconds
      const when = new Date(edge * 1000).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
      return `<p><strong>Distance au ${when}</strong> ${km} km <span class="muted">(hors de la période du flux — clic sur « Mettre à jour »)</span></p>`
    }
    case 'approx':
      return '<p class="muted">Position approximative : direction arbitraire, placée à sa distance d\'approche la plus proche.</p>'
    default:
      return '<p class="muted">Position inconnue.</p>'
  }
}

// --- selected NEO: its real path around the Earth over the feed's range --------
//
// Same Horizons table the point itself is placed from, so the line and the NEO
// always agree; each sample goes through the very same scale mapping, so the
// path follows the slider. Past samples are dimmed, the closest approach is
// ringed.

const TRAJECTORY_PAST_DIM = 0.3
const APPROACH_MARKER_MIN_PX = 6

const trajectoryLine = new THREE.Line(
  new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 }),
)
trajectoryLine.frustumCulled = false // its vertices move every frame; the bounding sphere would be stale
trajectoryLine.visible = false
scene.add(trajectoryLine)

const approachMarker = new THREE.Mesh(neoGeometry, new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true }))
approachMarker.visible = false
scene.add(approachMarker)

/** @type {NeoEntry|null} */
let selectedEntry = null
let trajectoryTable = null // the Horizons table the geometry was built from
let trajectoryKm = null // samples in km, scene axes
let trajectoryClosestIndex = 0

function selectNeo(entry) {
  if (selectedEntry === entry) return
  selectedEntry = entry
  trajectoryTable = null
}

function entryOf(neo) {
  return neoEntries.find((e) => e.neo === neo) ?? null
}

function buildTrajectory(table) {
  const rows = table.positions
  trajectoryKm = new Float32Array(rows.length * 3)
  let closest = Infinity
  const sample = new THREE.Vector3()
  rows.forEach((row, i) => {
    icrfToScene(row[0], row[1], row[2], sample)
    trajectoryKm.set([sample.x, sample.y, sample.z], i * 3)
    const distance = sample.length()
    if (distance < closest) {
      closest = distance
      trajectoryClosestIndex = i
    }
  })
  trajectoryLine.geometry.dispose()
  trajectoryLine.geometry = new THREE.BufferGeometry()
  trajectoryLine.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(rows.length * 3), 3))
  trajectoryLine.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(rows.length * 3), 3))
  trajectoryTable = table
}

const trajectorySample = new THREE.Vector3()

function updateTrajectory(nowSeconds, t) {
  const table = selectedEntry ? neoPositions.objects[selectedEntry.designation] : null
  if (!table || table.positions.length < 2) {
    trajectoryLine.visible = false
    approachMarker.visible = false
    return
  }
  if (table !== trajectoryTable) buildTrajectory(table)

  const positions = trajectoryLine.geometry.getAttribute('position')
  const colors = trajectoryLine.geometry.getAttribute('color')
  const { r, g, b } = selectedEntry.mesh.material.color
  const nowIndex = (nowSeconds - table.start) / neoPositions.stepSeconds

  for (let i = 0; i < positions.count; i++) {
    trajectorySample.fromArray(trajectoryKm, i * 3)
    const distanceKm = trajectorySample.length()
    trajectorySample.multiplyScalar(sceneDistance(distanceKm, t) / distanceKm)
    positions.setXYZ(i, trajectorySample.x, trajectorySample.y, trajectorySample.z)
    const dim = i < nowIndex ? TRAJECTORY_PAST_DIM : 1
    colors.setXYZ(i, r * dim, g * dim, b * dim)
    if (i === trajectoryClosestIndex) approachMarker.position.copy(trajectorySample)
  }
  positions.needsUpdate = true
  colors.needsUpdate = true
  trajectoryLine.visible = true

  approachMarker.visible = true
  approachMarker.scale.setScalar(
    Math.max(selectedEntry.mesh.scale.x * 2, minRadiusAt(approachMarker.position, APPROACH_MARKER_MIN_PX)),
  )
}

/** Human summary of the drawn path, for the modal. */
function describeTrajectory(entry) {
  const table = neoPositions.objects[entry.designation]
  if (!table || table.positions.length < 2) return ''
  const closestAt = new Date((table.start + trajectoryClosestIndex * neoPositions.stepSeconds) * 1000)
  return `<p class="muted">Trajectoire réelle tracée dans la scène (JPL Horizons) — passé atténué, cercle = passage au plus près${
    entry === selectedEntry ? ` le ${closestAt.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}` : ''
  }.</p>`
}

// --- ISS -------------------------------------------------------------------------

let issPosition = null

function applyIssPosition(position) {
  issPosition = position
  issMarker.visible = true
}

// --- scale ("réalisme") ------------------------------------------------------------

let scaleStep = 0 // slider position, 0..SCALE_STEPS
let scaleT = 0 // current value, animated toward scaleStep / SCALE_STEPS
let scaleTransition = null // { from, to, startMs }
const SCALE_TRANSITION_MS = 1500

function setScaleStep(step) {
  const next = THREE.MathUtils.clamp(Math.round(step), 0, SCALE_STEPS)
  if (next === scaleStep && !scaleTransition) return
  scaleStep = next
  scaleTransition = { from: scaleT, to: next / SCALE_STEPS, startMs: performance.now() }
  renderScalePanel()
}

function neoDistancesKm() {
  const nowSeconds = Date.now() / 1000
  const distances = []
  for (const entry of neoEntries) {
    updateNeoPositionKm(entry, nowSeconds)
    if (entry.source) distances.push(entry.positionKm.length())
  }
  return distances
}

function medianOf(values) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[sorted.length >> 1]
}

/**
 * Camera distances that should "stay put" relative to the scene when t
 * changes: close to the surface (unchanged), the Moon, the median NEO.
 * Filtered to stay strictly increasing at both t values.
 */
function cameraAnchors(tFrom, tTo, neoMedianKm) {
  const from = [controls.minDistance]
  const to = [controls.minDistance]
  const candidates = [moonDistanceKm]
  if (neoMedianKm !== null) candidates.push(neoMedianKm)
  for (const km of candidates) {
    const a = sceneDistance(km, tFrom)
    const b = sceneDistance(km, tTo)
    if (a > from[from.length - 1] && b > to[to.length - 1]) {
      from.push(a)
      to.push(b)
    }
  }
  return { from, to }
}

const cameraOffset = new THREE.Vector3()

function stepScaleTransition(nowMs) {
  if (!scaleTransition) return
  const u = Math.min(1, (nowMs - scaleTransition.startMs) / SCALE_TRANSITION_MS)
  const eased = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2
  const next = THREE.MathUtils.lerp(scaleTransition.from, scaleTransition.to, eased)

  const { from, to } = cameraAnchors(scaleT, next, medianOf(neoDistancesKm()))
  cameraOffset.subVectors(camera.position, controls.target)
  cameraOffset.setLength(remapCameraDistance(cameraOffset.length(), from, to))
  camera.position.copy(controls.target).add(cameraOffset)

  scaleT = next
  if (u === 1) scaleTransition = null
}

/** Zoom range follows how far the scene extends at the current scale. */
function updateCameraLimits() {
  let farthest = sceneDistance(moonDistanceKm, scaleT)
  for (const entry of neoEntries) {
    if (entry.source) farthest = Math.max(farthest, sceneDistance(entry.positionKm.length(), scaleT))
  }
  controls.minDistance = lerpLog(3.5, 2.6, scaleT)
  controls.maxDistance = Math.max(20, farthest * 2.5)
  // OrbitControls' dolly is multiplicative (×0.95 per wheel notch at speed 1):
  // spanning 2.6 → ~60 000 would take ~190 notches without this.
  controls.zoomSpeed = Math.max(1, Math.log(controls.maxDistance / controls.minDistance) / 3)
}

const tmpWorldPos = new THREE.Vector3()

/** Scene radius needed for `px` pixels at a world position, given the current camera. */
function minRadiusAt(worldPos, px) {
  const distance = camera.position.distanceTo(worldPos)
  return px * worldPerPixel(distance, camera.fov, renderer.domElement.clientHeight)
}

/** Places and sizes every scale-dependent object for scaleT and the current camera. */
function applyScale(nowSeconds) {
  const t = scaleT

  const earthRadius = Math.max(EARTH_RADIUS, minRadiusAt(globe.position, MIN_RADIUS_PX.earth))
  globeSphere.scale.setScalar(earthRadius / EARTH_RADIUS)

  moon.position.copy(moonDirWorld).multiplyScalar(sceneDistance(moonDistanceKm, t))
  moon.scale.setScalar(Math.max(MOON_RADIUS, minRadiusAt(moon.position, MIN_RADIUS_PX.moon)) / MOON_RADIUS)

  sunMarker.position.copy(sunDirWorld).multiplyScalar(sunDistance(t))
  sunMarker.scale.setScalar(
    Math.max(sunRadius(t), minRadiusAt(sunMarker.position, MIN_RADIUS_PX.sun)) / SUN_READABLE_RADIUS,
  )

  if (issPosition) {
    issMarker.position.copy(
      latLngToVector3(issPosition.latitude, issPosition.longitude, issOrbitRadius(issPosition.altitude_km, t)),
    )
    issMarker.getWorldPosition(tmpWorldPos)
    issMarker.scale.setScalar(
      Math.max(issRadius(t), minRadiusAt(tmpWorldPos, MIN_RADIUS_PX.iss)) / ISS_READABLE_RADIUS,
    )
  }

  for (const entry of neoEntries) {
    updateNeoPositionKm(entry, nowSeconds)
    entry.group.visible = entry.source !== null
    if (!entry.source) continue
    const distanceKm = entry.positionKm.length()
    entry.group.position.copy(entry.positionKm).multiplyScalar(sceneDistance(distanceKm, t) / distanceKm)
    const radius = Math.max(neoRadius(entry.diameterKm, t), minRadiusAt(entry.group.position, MIN_RADIUS_PX.neo))
    entry.mesh.scale.setScalar(radius)
    entry.hit.scale.setScalar(Math.max(radius, minRadiusAt(entry.group.position, NEO_HIT_MIN_RADIUS_PX)))
  }

  distanceRings.group.visible = t > 0.001
  for (const ring of distanceRings.rings) {
    ring.line.scale.setScalar(sceneDistance(ring.distanceKm, t))
  }

  updateTrajectory(nowSeconds, t)
}

// --- UI overlay --------------------------------------------------------------

const ui = document.createElement('div')
ui.id = 'ui'
ui.innerHTML = `
  <div id="ui-header">
    <h1>NASA Viz</h1>
    <button id="update-btn">Mettre à jour</button>
    <span id="usage-badge" class="muted" title="Requêtes envoyées à api.nasa.gov (NeoWs + APOD) depuis minuit UTC — les autres sources (JPL, ESA, IMCCE, ISS) sont sans quota">…</span>
  </div>
  <section id="iss-panel">
    <h2><span class="dot dot-iss"></span>ISS</h2>
    <p class="muted">chargement…</p>
  </section>
  <section id="neo-panel">
    <h2>Astéroïdes proches (NEO)</h2>
    <p class="muted">chargement…</p>
  </section>
  <section id="apod-panel">
    <h2>Image du jour (APOD)</h2>
    <p class="muted">chargement…</p>
  </section>
`
app.appendChild(ui)

const scalePanel = document.createElement('div')
scalePanel.id = 'scale-panel'
scalePanel.innerHTML = `
  <div class="scale-row">
    <label for="scale-slider">Échelle</label>
    <span class="scale-end">lisible</span>
    <input id="scale-slider" type="range" min="0" max="${SCALE_STEPS}" step="1" value="0" list="scale-ticks">
    <span class="scale-end">réelle</span>
    <datalist id="scale-ticks">
      ${Array.from({ length: SCALE_STEPS + 1 }, (_, i) => `<option value="${i}"></option>`).join('')}
    </datalist>
  </div>
  <div class="scale-row">
    ${SCALE_PRESETS.map((p) => `<button class="scale-preset" data-step="${p.step}">${p.label}</button>`).join('')}
  </div>
  <p id="scale-label"></p>
  <p class="muted scale-hint">Shift + molette : un cran d'échelle</p>
`
app.appendChild(scalePanel)

const sceneLabels = document.createElement('div')
sceneLabels.id = 'scene-labels'
app.appendChild(sceneLabels)

const modal = document.createElement('div')
modal.id = 'modal-backdrop'
modal.className = 'hidden'
modal.innerHTML = `
  <div id="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
    <button id="modal-close" aria-label="Fermer">×</button>
    <h2 id="modal-title"></h2>
    <div id="modal-body"></div>
  </div>
`
document.body.appendChild(modal)

const starTooltip = document.createElement('div')
starTooltip.id = 'star-tooltip'
starTooltip.className = 'hidden'
document.body.appendChild(starTooltip)

const constellationTooltip = document.createElement('div')
constellationTooltip.id = 'constellation-tooltip'
constellationTooltip.className = 'hidden'
document.body.appendChild(constellationTooltip)

const style = document.createElement('style')
style.textContent = `
  #ui { position: fixed; top: 0; left: 0; padding: 16px 20px; color: #eaf4ff;
        font-family: system-ui, sans-serif; pointer-events: none; text-shadow: 0 1px 3px rgba(0,0,0,.8); }
  #ui-header { display: flex; align-items: center; gap: 12px; pointer-events: auto; }
  #ui h1 { margin: 0; font-size: 20px; letter-spacing: 0.04em; }
  #ui h2 { margin: 12px 0 4px; font-size: 13px; text-transform: uppercase; opacity: 0.7; }
  #ui p { margin: 2px 0; font-size: 13px; }
  #ui .muted { opacity: 0.6; }
  #ui .error { color: #ff8080; }
  #update-btn, .scale-preset { pointer-events: auto; background: #1c4d7a; color: #eaf4ff; border: 1px solid #4fa8ff;
                border-radius: 4px; padding: 4px 12px; font-size: 12px; cursor: pointer; text-shadow: none; }
  #update-btn:hover, .scale-preset:hover { background: #24608f; }
  #update-btn:disabled { opacity: 0.5; cursor: default; }
  #usage-badge { font-size: 12px; cursor: help; }

  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
  #iss-panel h2 .dot { margin-bottom: 2px; }
  .dot-iss { background: #ffcc33; box-shadow: 0 0 5px #ffcc33; }
  .legend { font-size: 12px; opacity: 0.8; }

  #apod-panel { position: fixed; top: 16px; right: 20px; pointer-events: auto; cursor: pointer;
                max-width: 220px; text-align: right; }
  #apod-panel img { display: block; width: 100%; border-radius: 4px; margin-top: 4px; }
  #apod-panel .apod-title { font-weight: 600; }

  #scale-panel { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); z-index: 2;
                 background: rgba(10,22,34,.8); border: 1px solid #1c4d7a; border-radius: 8px; padding: 10px 16px;
                 color: #eaf4ff; font-family: system-ui, sans-serif; text-align: center; max-width: calc(100vw - 40px); }
  #scale-panel .scale-row { display: flex; align-items: center; justify-content: center; gap: 8px; }
  #scale-panel .scale-row + .scale-row { margin-top: 8px; }
  #scale-panel label { font-size: 12px; text-transform: uppercase; opacity: 0.7; margin-right: 4px; }
  #scale-panel .scale-end { font-size: 11px; opacity: 0.6; }
  #scale-slider { width: 260px; accent-color: #4fa8ff; }
  .scale-preset.active { background: #4fa8ff; color: #0e2233; }
  #scale-label { margin: 8px 0 0; font-size: 13px; font-variant-numeric: tabular-nums; }
  #scale-panel .scale-hint { margin: 2px 0 0; font-size: 11px; opacity: 0.55; }

  #scene-labels { position: fixed; inset: 0; pointer-events: none; overflow: hidden; z-index: 1;
                  font-family: system-ui, sans-serif; }
  .scene-label { position: absolute; left: 0; top: 0; font-size: 11px; color: #cfe6ff; white-space: nowrap;
                 text-shadow: 0 1px 3px rgba(0,0,0,.9); }
  .scene-label.ring { color: #4fa8ff; opacity: 0.75; font-size: 10px; }

  #modal-backdrop { position: fixed; inset: 0; z-index: 10; background: rgba(0,0,0,.6); display: flex;
                     align-items: center; justify-content: center; font-family: system-ui, sans-serif; }
  #modal-backdrop.hidden { display: none; }
  #modal { position: relative; background: #0e2233; color: #eaf4ff; border: 1px solid #4fa8ff;
           border-radius: 8px; padding: 20px 24px; max-width: 480px; width: 90%;
           max-height: 80vh; overflow-y: auto; }
  #modal h2 { margin: 0 0 12px; font-size: 17px; }
  #modal h3 { margin: 16px 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.7; }
  #modal p { margin: 4px 0; font-size: 13px; line-height: 1.5; }
  #modal .muted { opacity: 0.6; }
  #modal .warn { color: #ffbf66; opacity: 1; }
  #modal a { color: #7fe0ff; }
  #modal .credits { margin-top: 14px; font-size: 11px; }
  .neo-sources { margin: 4px 0; padding-left: 18px; font-size: 13px; line-height: 1.5; }
  .neo-sources li { margin: 2px 0; }
  .orbit-schematic { margin: 10px 0 0; }
  .orbit-schematic svg { display: block; width: 100%; max-width: 300px; margin: 0 auto; }
  .orbit-schematic text { font: 10px system-ui, sans-serif; }
  .orbit-schematic figcaption { margin-top: 4px; font-size: 11px; line-height: 1.5; opacity: 0.75; text-align: center; }
  #modal img, #modal iframe { display: block; width: 100%; border-radius: 4px; margin-bottom: 10px; border: none; }
  #modal iframe { aspect-ratio: 16 / 9; }
  #modal-close { position: absolute; top: 8px; right: 10px; background: none; border: none;
                 color: #eaf4ff; font-size: 20px; cursor: pointer; line-height: 1; }

  #star-tooltip { position: fixed; pointer-events: none; z-index: 5; background: rgba(10,22,34,.92);
                  color: #eaf4ff; border: 1px solid #4fa8ff; border-radius: 4px; padding: 3px 9px;
                  font-family: system-ui, sans-serif; font-size: 12px; white-space: nowrap;
                  transform: translate(14px, -50%); }
  #star-tooltip.hidden { display: none; }

  #constellation-tooltip { position: fixed; pointer-events: none; z-index: 4; background: rgba(10,22,34,.85);
                  color: #9fd2ff; border: 1px solid #6fb7ff; border-radius: 4px; padding: 2px 9px;
                  font-family: system-ui, sans-serif; font-size: 11px; letter-spacing: 0.03em;
                  text-transform: uppercase; white-space: nowrap; transform: translate(14px, -50%); }
  #constellation-tooltip.hidden { display: none; }
`
document.head.appendChild(style)

function formatUpdatedAt(fetchedAt) {
  if (!fetchedAt) return ''
  return `<p class="muted">maj ${new Date(fetchedAt).toLocaleTimeString('fr-FR')}</p>`
}

function renderIssPanel(position, error, fetchedAt) {
  const el = document.querySelector('#iss-panel')
  const heading = '<h2><span class="dot dot-iss"></span>ISS</h2>'
  if (error) {
    el.innerHTML = `${heading}<p class="error">${error}</p>`
    return
  }
  el.innerHTML = `
    ${heading}
    <p>lat ${position.latitude.toFixed(2)}° · lng ${position.longitude.toFixed(2)}°</p>
    <p>altitude ${position.altitude_km.toFixed(0)} km · vitesse ${position.velocity_kmh.toFixed(0)} km/h</p>
    ${formatUpdatedAt(fetchedAt)}
  `
}

function renderNeoPanel(feed, error, fetchedAt) {
  const el = document.querySelector('#neo-panel')
  if (error) {
    el.innerHTML = `<h2>Astéroïdes proches (NEO)</h2><p class="error">${error}</p>`
    return
  }
  const hazardous = feed.objects.filter((o) => o.is_potentially_hazardous).length
  // #neo-positions-status lives inside the template on purpose: this
  // innerHTML replace would wipe it otherwise (docs/agent/gotchas.md).
  el.innerHTML = `
    <h2>Astéroïdes proches (NEO)</h2>
    <p>${feed.count} objets (${feed.start_date} → ${feed.end_date}) · clic sur un point pour le détail</p>
    <p>${hazardous} potentiellement dangereux</p>
    ${sourcesPanelHtml(feed)}
    <p id="neo-positions-status" class="muted"></p>
    ${neoLegendHtml()}
    ${formatUpdatedAt(fetchedAt)}
  `
  renderNeoPositionsStatus()
}

/** Legend: the two constant colours, plus every spectral complex actually loaded. */
function neoLegendHtml() {
  const present = new Set()
  for (const entry of neoEntries) {
    if (entry.neo.is_potentially_hazardous) continue
    const key = taxonomyKey(neoDetails[entry.designation]?.data?.taxonomy?.complex)
    if (key) present.add(key)
  }
  const swatches = [
    `<span class="dot" style="background:${cssColor(NEO_DEFAULT_COLOR)}"></span>standard`,
    `<span class="dot" style="background:${cssColor(NEO_HAZARD_COLOR)}"></span>dangereux`,
    ...[...present].map((key) => `<span class="dot" style="background:${cssColor(TAXONOMY[key].color)}"></span>${TAXONOMY[key].label}`),
  ]
  return `<p class="legend">${swatches.join(' &nbsp;')}</p>`
}

let neoPositionsLoading = false

function renderNeoPositionsStatus() {
  const el = document.getElementById('neo-positions-status')
  if (!el) return
  const total = neoEntries.length
  const known = neoEntries.filter((e) => neoPositions.objects[e.designation]).length
  if (total === 0) {
    el.textContent = ''
  } else if (neoPositionsLoading) {
    el.textContent = `positions réelles (JPL Horizons) : ${known}/${total}…`
  } else {
    el.textContent =
      known === total
        ? 'positions réelles (JPL Horizons)'
        : `positions réelles (JPL Horizons) : ${known}/${total} — les autres sont approximatives`
  }
}

function renderScalePanel() {
  document.getElementById('scale-slider').value = String(scaleStep)
  for (const button of scalePanel.querySelectorAll('.scale-preset')) {
    button.classList.toggle('active', Number(button.dataset.step) === scaleStep)
  }
  const t = scaleStep / SCALE_STEPS
  const distances = neoDistancesKm()
  const diameters = neoEntries.filter((e) => e.source).map((e) => e.diameterKm)
  let label = describeScale(t, moonDistanceKm, distances, diameters)
  if (scaleStep === SCALE_STEPS) label = `100 % réel · ${label} · taille min. à l'écran`
  document.getElementById('scale-label').textContent = label
}

function openModal(title, bodyHtml) {
  document.getElementById('modal-title').textContent = title
  document.getElementById('modal-body').innerHTML = bodyHtml
  modal.classList.remove('hidden')
}

function hideModal() {
  modal.classList.add('hidden')
  modalNeo = null
}

let currentApod = null

function renderApodPanel(apod, error, fetchedAt) {
  const el = document.querySelector('#apod-panel')
  currentApod = error ? null : apod
  if (error) {
    el.innerHTML = `<h2>Image du jour (APOD)</h2><p class="error">${error}</p>`
    return
  }
  const preview =
    apod.media_type === 'video'
      ? '<p>🎥 Vidéo du jour</p>'
      : `<img src="${apod.url}" alt="${apod.title}">`
  el.innerHTML = `
    <h2>Image du jour (APOD)</h2>
    <p class="apod-title">${apod.title}</p>
    ${preview}
    ${formatUpdatedAt(fetchedAt)}
  `
}

/** The NEO the modal is showing, so it can be re-rendered when its sheet arrives. */
let modalNeo = null

function showNeoModal(neo) {
  modalNeo = neo
  const entry = entryOf(neo)
  if (entry) selectNeo(entry)
  renderNeoModal()
  loadNeoDetails([entry ? entry.designation : designationOf(neo)])
}

function renderNeoModal() {
  const neo = modalNeo
  if (!neo) return
  const approach = neo.close_approach
  const entry = entryOf(neo)
  const designation = entry ? entry.designation : designationOf(neo)
  const record = neoDetails[designation]
  const details = record ? record.data : undefined
  const diameter = details?.diameter_km
    ? `${(details.diameter_km.value * 1000).toLocaleString('fr-FR', { maximumFractionDigits: 0 })} m <span class="muted">(mesuré)</span>`
    : `${neo.estimated_diameter_km.min.toFixed(3)} – ${neo.estimated_diameter_km.max.toFixed(3)} km <span class="muted">(estimé d'après sa luminosité)</span>`

  openModal(
    neo.name,
    `
    <p><strong>Désignation</strong> ${escapeHtml(designation)}</p>
    <p><strong>Diamètre</strong> ${diameter}</p>
    <p><strong>Potentiellement dangereux</strong> ${neo.is_potentially_hazardous ? 'Oui' : 'Non'}</p>
    ${entry ? describeNeoPosition(entry) : ''}
    ${
      approach
        ? `
      <p><strong>Approche la plus proche</strong> ${approach.datetime ? new Date(approach.datetime).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : approach.date}</p>
      <p><strong>Distance</strong> ${Math.round(approach.miss_distance_km).toLocaleString('fr-FR')} km</p>
      <p><strong>Vitesse relative</strong> ${Math.round(approach.relative_velocity_kmh).toLocaleString('fr-FR')} km/h</p>
    `
        : '<p class="muted">Pas de données d\'approche disponibles</p>'
    }
    ${entry ? describeTrajectory(entry) : ''}
    ${sourcesBlockHtml(neo)}
    ${detailsBlockHtml(details, {
      loading: neoDetailsLoading.has(designation),
      error: neoDetailsErrors.get(designation) ?? null,
    })}
    ${
      details?.orbit
        ? orbitSchematicSvg(details.orbit, {
            now: new Date(),
            approachAt: approach ? new Date(approach.datetime ?? `${approach.date}T12:00Z`) : null,
            hazardous: neo.is_potentially_hazardous,
          })
        : ''
    }
    <p class="muted credits">${NEO_CREDITS}</p>
  `,
  )
}

function showApodModal(apod) {
  const media =
    apod.media_type === 'video'
      ? `<iframe src="${apod.url}" allowfullscreen></iframe>`
      : `<img src="${apod.url}" alt="${apod.title}">`
  openModal(
    apod.title,
    `
    ${media}
    <p class="muted">${apod.date}</p>
    <p>${apod.explanation}</p>
    ${apod.hd_url ? `<p><a href="${apod.hd_url}" target="_blank" rel="noopener" style="color:#7fe0ff">Voir en haute résolution</a></p>` : ''}
  `,
  )
}

document.getElementById('modal-close').addEventListener('click', hideModal)
modal.addEventListener('click', (event) => {
  if (event.target === modal) hideModal()
})
window.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  // First Escape closes the modal, a second one drops the selected NEO's trajectory.
  if (!modal.classList.contains('hidden')) hideModal()
  else selectNeo(null)
})

// --- scale controls -------------------------------------------------------------

document.getElementById('scale-slider').addEventListener('input', (event) => {
  setScaleStep(Number(event.target.value))
})
for (const button of scalePanel.querySelectorAll('.scale-preset')) {
  button.addEventListener('click', () => setScaleStep(Number(button.dataset.step)))
}

/**
 * Shift+wheel = one scale step; plain wheel stays camera zoom. Listening on
 * window in the capture phase runs before OrbitControls' own wheel listener on
 * the canvas, so stopping propagation keeps it from zooming too.
 */
const SCALE_WHEEL_THRESHOLD = 100 // ≈ one mouse-wheel notch
const SCALE_WHEEL_COOLDOWN_MS = 250
let scaleWheelAccum = 0
let scaleWheelLastEventMs = 0
let scaleWheelLastStepMs = 0

window.addEventListener(
  'wheel',
  (event) => {
    if (!event.shiftKey || event.target !== renderer.domElement) return
    event.preventDefault()
    event.stopPropagation()

    // Chrome/Edge on Windows (and macOS) turn Shift+wheel into horizontal
    // scrolling: deltaY is 0 and the notch arrives in deltaX instead.
    let delta = event.deltaY || event.deltaX
    if (event.deltaMode === 1) delta *= 33 // lines → ~pixels
    const now = performance.now()
    if (now - scaleWheelLastEventMs > 400) scaleWheelAccum = 0 // new gesture
    scaleWheelLastEventMs = now
    scaleWheelAccum += delta

    // Trackpads send many small deltas: accumulate, then step at most once per cooldown.
    if (Math.abs(scaleWheelAccum) >= SCALE_WHEEL_THRESHOLD && now - scaleWheelLastStepMs > SCALE_WHEEL_COOLDOWN_MS) {
      setScaleStep(scaleStep + Math.sign(scaleWheelAccum)) // wheel toward you = zoom out = more real
      scaleWheelAccum = 0
      scaleWheelLastStepMs = now
    }
  },
  { capture: true, passive: false },
)

// --- scene labels ------------------------------------------------------------------

function makeSceneLabel(text, className = '') {
  const el = document.createElement('span')
  el.className = `scene-label ${className}`.trim()
  el.textContent = text
  el.hidden = true
  sceneLabels.appendChild(el)
  return el
}

const bodyLabels = {
  earth: makeSceneLabel('Terre'),
  moon: makeSceneLabel('Lune'),
  iss: makeSceneLabel('ISS'),
}
const ringLabels = distanceRings.rings.map((ring) =>
  makeSceneLabel(ring.lunarDistances === 1 ? 'orbite lunaire' : `${ring.lunarDistances} distances lunaires`, 'ring'),
)

const LABEL_WHEN_SMALLER_THAN_PX = 6
const LABEL_MIN_SEPARATION_PX = 18
const labelScreenPos = new THREE.Vector3()
const labelRayDir = new THREE.Vector3()

/** Screen position of a world point, or null if behind the camera or hidden behind the Earth. */
function screenPositionOf(worldPos, checkEarthOcclusion) {
  labelScreenPos.copy(worldPos).project(camera)
  if (labelScreenPos.z > 1) return null
  if (checkEarthOcclusion) {
    labelRayDir.subVectors(worldPos, camera.position)
    const distance = labelRayDir.length()
    labelRayDir.normalize()
    const earthRadius = EARTH_RADIUS * globeSphere.scale.x
    if (raySphereDistance(camera.position, labelRayDir, globe.position, earthRadius) < distance - 1e-6) return null
  }
  const rect = renderer.domElement.getBoundingClientRect()
  return {
    x: (labelScreenPos.x * 0.5 + 0.5) * rect.width,
    y: (-labelScreenPos.y * 0.5 + 0.5) * rect.height,
  }
}

function placeLabel(el, pos) {
  if (!pos) {
    el.hidden = true
    return
  }
  el.hidden = false
  el.style.transform = `translate(${pos.x + 8}px, ${pos.y}px) translateY(-50%)`
}

/** Names bodies once they've shrunk to dots, and labels the distance rings. */
function updateSceneLabels() {
  const vpH = renderer.domElement.clientHeight
  const projectedRadiusPx = (worldPos, radius) =>
    radius / worldPerPixel(camera.position.distanceTo(worldPos), camera.fov, vpH)
  const placed = []
  const farFromPlaced = (pos) => placed.every((p) => Math.hypot(p.x - pos.x, p.y - pos.y) > LABEL_MIN_SEPARATION_PX)

  const bodies = [
    { el: bodyLabels.earth, worldPos: globe.position, radius: EARTH_RADIUS, occludable: false, show: true },
    { el: bodyLabels.moon, worldPos: moon.position, radius: MOON_RADIUS, occludable: true, show: true },
    {
      el: bodyLabels.iss,
      worldPos: issPosition ? issMarker.getWorldPosition(tmpWorldPos) : null,
      radius: issRadius(scaleT),
      occludable: true,
      show: issPosition !== null && scaleT > 0.001,
    },
  ]
  for (const body of bodies) {
    const small = body.show && body.worldPos && projectedRadiusPx(body.worldPos, body.radius) < LABEL_WHEN_SMALLER_THAN_PX
    const pos = small ? screenPositionOf(body.worldPos, body.occludable) : null
    if (pos && farFromPlaced(pos)) {
      placed.push(pos)
      placeLabel(body.el, pos)
    } else {
      placeLabel(body.el, null)
    }
  }

  distanceRings.rings.forEach((ring, i) => {
    if (!distanceRings.group.visible) return placeLabel(ringLabels[i], null)
    // Local +X on the unit circle stays on world +X (the ring is only rotated about X).
    tmpWorldPos.set(ring.line.scale.x, 0, 0)
    const radiusPx = projectedRadiusPx(globe.position, ring.line.scale.x)
    placeLabel(ringLabels[i], radiusPx > 40 ? screenPositionOf(tmpWorldPos, true) : null)
  })
}

// --- picking (click to inspect a NEO) -----------------------------------------

const raycaster = new THREE.Raycaster()
const pointer = new THREE.Vector2()

function setPointerFromEvent(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect()
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1
  raycaster.setFromCamera(pointer, camera)
}

function pickNeoAt(clientX, clientY) {
  setPointerFromEvent(clientX, clientY)
  // Raycaster ignores `visible`, so NEOs without any position yet are filtered out by hand.
  const hit = raycaster.intersectObjects(neoGroup.children, true).find((i) => i.object.parent.visible)
  return hit ? hit.object.userData.neo : null
}

// Star picking is done by hand in screen space rather than via
// Raycaster.intersectObject(starPoints): that built-in path tests a fixed
// world-space distance from the ray to each point, which doesn't track the
// point's actual on-screen size (driven by our custom per-vertex shader) —
// on a shell as large as STAR_SHELL_RADIUS, that mismatch reads as picking
// the "wrong" star next to the one under the cursor. Projecting every star
// to screen space and comparing pixel distance instead makes the hit target
// match what's actually visible.
const STAR_PICK_RADIUS_PX = 12
const starPickWorldPos = new THREE.Vector3()
const starPickScreenPos = new THREE.Vector3()
const starPickRayDir = new THREE.Vector3()

/**
 * True if the Earth or the Moon hides this star. Stars are at infinity
 * (skybox), so only the direction matters: `localPos` is the star's position
 * in the sky group, i.e. relative to the camera.
 */
function isStarOccluded(localPos) {
  starPickRayDir.copy(localPos).normalize()
  const camPos = camera.position
  if (raySphereDistance(camPos, starPickRayDir, globe.position, EARTH_RADIUS * globeSphere.scale.x) < Infinity) {
    return true
  }
  return raySphereDistance(camPos, starPickRayDir, moon.position, MOON_RADIUS * moon.scale.x) < Infinity
}

/** Index of the star nearest the cursor on screen (named or not), or null. */
function pickStarIndexAt(clientX, clientY) {
  if (!starPoints) return null
  const rect = renderer.domElement.getBoundingClientRect()
  const positionAttr = starPoints.geometry.getAttribute('position')

  let bestIndex = null
  let bestDistSq = STAR_PICK_RADIUS_PX * STAR_PICK_RADIUS_PX

  for (let i = 0; i < positionAttr.count; i++) {
    starPickWorldPos.fromBufferAttribute(positionAttr, i)
    if (isStarOccluded(starPickWorldPos)) continue

    // Sky group sits on the camera: world position = local + camera position.
    starPickScreenPos.copy(starPickWorldPos).add(camera.position).project(camera)
    if (starPickScreenPos.z > 1) continue // behind the camera

    const sx = (starPickScreenPos.x * 0.5 + 0.5) * rect.width + rect.left
    const sy = (starPickScreenPos.y * -0.5 + 0.5) * rect.height + rect.top
    const dx = sx - clientX
    const dy = sy - clientY
    const distSq = dx * dx + dy * dy
    if (distSq < bestDistSq) {
      bestDistSq = distSq
      bestIndex = i
    }
  }

  return bestIndex
}

function showStarTooltip(name, clientX, clientY) {
  starTooltip.textContent = name
  starTooltip.style.left = `${clientX}px`
  starTooltip.style.top = `${clientY}px`
  starTooltip.classList.remove('hidden')
}

function hideStarTooltip() {
  starTooltip.classList.add('hidden')
}

// The raycaster threshold makes several neighbouring points plausible hits at
// once (it's a coarse click target, not a per-pixel test) — magnifying and
// brightening whichever one actually won the pick tells the user exactly
// which star the tooltip is talking about.
const STAR_HIGHLIGHT_SIZE_FACTOR = 1
const STAR_HIGHLIGHT_MIN_SIZE = 4
const STAR_HIGHLIGHT_WHITEN = 0.6 // 0 = original color, 1 = full white
let hoveredStarIndex = null

function setStarHighlight(index) {
  if (hoveredStarIndex === index) return
  const sizeAttr = starPoints.geometry.getAttribute('size')
  const colorAttr = starPoints.geometry.getAttribute('color')

  if (hoveredStarIndex !== null) {
    sizeAttr.array[hoveredStarIndex] = starBaseSizes[hoveredStarIndex]
    colorAttr.setXYZ(
      hoveredStarIndex,
      starBaseColors[hoveredStarIndex * 3],
      starBaseColors[hoveredStarIndex * 3 + 1],
      starBaseColors[hoveredStarIndex * 3 + 2],
    )
  }

  hoveredStarIndex = index

  if (index !== null) {
    sizeAttr.array[index] = Math.max(starBaseSizes[index] * STAR_HIGHLIGHT_SIZE_FACTOR, STAR_HIGHLIGHT_MIN_SIZE)
    colorAttr.setXYZ(
      index,
      THREE.MathUtils.lerp(starBaseColors[index * 3], 1, STAR_HIGHLIGHT_WHITEN),
      THREE.MathUtils.lerp(starBaseColors[index * 3 + 1], 1, STAR_HIGHLIGHT_WHITEN),
      THREE.MathUtils.lerp(starBaseColors[index * 3 + 2], 1, STAR_HIGHLIGHT_WHITEN),
    )
  }

  sizeAttr.needsUpdate = true
  colorAttr.needsUpdate = true
}

function showConstellationTooltip(name, clientX, clientY) {
  constellationTooltip.textContent = name
  constellationTooltip.style.left = `${clientX}px`
  // Offset below the star tooltip's row so the two don't overlap when both show at once.
  constellationTooltip.style.top = `${clientY + 22}px`
  constellationTooltip.classList.remove('hidden')
}

function hideConstellationTooltip() {
  constellationTooltip.classList.add('hidden')
}

/**
 * Shows one constellation's line figure (by IAU code) and its name tooltip,
 * hiding whichever was shown before. `code` may be '' or null (no figure at
 * this cursor position) — clears both cleanly either way.
 */
let shownConstellationCode = null
function showConstellation(code, clientX, clientY) {
  if (code !== shownConstellationCode) {
    const prev = constellationGroups.get(shownConstellationCode)
    if (prev) prev.visible = false
    shownConstellationCode = code
    const next = constellationGroups.get(code)
    if (next) next.visible = true
  }

  const name = code && constellationNames[code]
  if (name) showConstellationTooltip(name, clientX, clientY)
  else hideConstellationTooltip()
}

// Clicking a NEO opens its modal and selects it (its trajectory stays drawn
// after the modal closes); clicking empty space deselects — but only on a real
// click, not at the end of an orbit drag.
const DRAG_TOLERANCE_PX = 5
let pointerDownAt = null

renderer.domElement.addEventListener('pointerdown', (event) => {
  pointerDownAt = { x: event.clientX, y: event.clientY }
})

renderer.domElement.addEventListener('click', (event) => {
  const dragged =
    pointerDownAt && Math.hypot(event.clientX - pointerDownAt.x, event.clientY - pointerDownAt.y) > DRAG_TOLERANCE_PX
  pointerDownAt = null
  if (dragged) return

  const neo = pickNeoAt(event.clientX, event.clientY)
  if (neo) showNeoModal(neo)
  else selectNeo(null)
})

document.querySelector('#apod-panel').addEventListener('click', () => {
  if (currentApod) showApodModal(currentApod)
})

renderer.domElement.addEventListener('pointermove', (event) => {
  const neo = pickNeoAt(event.clientX, event.clientY)
  if (neo) {
    renderer.domElement.style.cursor = 'pointer'
    // Named on hover: at true scale every NEO is an anonymous dot otherwise.
    showStarTooltip(neo.name + neoTooltipSuffix(neo), event.clientX, event.clientY)
    if (starPoints) setStarHighlight(null)
    showConstellation(null)
    return
  }

  const starIndex = pickStarIndexAt(event.clientX, event.clientY)
  if (starIndex !== null) {
    renderer.domElement.style.cursor = 'pointer'
    setStarHighlight(starIndex)
    showConstellation(starConstellations[starIndex], event.clientX, event.clientY)
    const name = starNames[starIndex]
    if (name) showStarTooltip(name, event.clientX, event.clientY)
    else hideStarTooltip()
  } else {
    renderer.domElement.style.cursor = 'default'
    hideStarTooltip()
    if (starPoints) setStarHighlight(null)
    showConstellation(null)
  }
})

renderer.domElement.addEventListener('pointerleave', () => {
  if (starPoints) setStarHighlight(null)
  showConstellation(null)
  hideStarTooltip()
})

// --- data loading (cache-first — the free NASA API key is rate-limited) --------

async function refreshIss() {
  try {
    const position = await fetchIssPosition()
    saveCached('iss', position)
    applyIssPosition(position)
    renderIssPanel(position, null, Date.now())
  } catch (err) {
    renderIssPanel(null, err.message)
  }
}

async function refreshUsage() {
  const badge = document.getElementById('usage-badge')
  try {
    const usage = await fetchUsage()
    badge.textContent = `${usage.nasa_api_calls_today} requête${usage.nasa_api_calls_today === 1 ? '' : 's'} NASA aujourd'hui`
  } catch {
    badge.textContent = ''
  }
}

let currentNeoFeed = null
let currentNeoFetchedAt = null

function showNeoFeed(feed, fetchedAt) {
  currentNeoFeed = feed
  currentNeoFetchedAt = fetchedAt
  selectNeo(null)
  addNeoPoints(feed.objects)
  renderNeoPanel(feed, null, fetchedAt)
  renderScalePanel()
  loadNeoPositions(feed)
  loadNeoDetails(neoEntries.map((entry) => entry.designation))
}

const NEO_DETAILS_BATCH = 10 // backend maximum per call

/**
 * Sheets from JPL SBDB / IMCCE ssoCard / Sentry for the given designations,
 * in background batches: they colour the points by spectral type, give the
 * measured diameter when one exists, and fill the modal. Cached in
 * localStorage per designation (not per feed) — these catalogues barely move.
 */
async function loadNeoDetails(designations) {
  const missing = [...new Set(designations)].filter(
    (d) => !(d in neoDetails) && !neoDetailsLoading.has(d) && DESIGNATION_PATTERN.test(d),
  )
  if (missing.length === 0) return
  for (const designation of missing) neoDetailsLoading.add(designation)
  if (modalNeo) renderNeoModal()

  for (let i = 0; i < missing.length; i += NEO_DETAILS_BATCH) {
    const batch = missing.slice(i, i + NEO_DETAILS_BATCH)
    try {
      const { objects } = await fetchNeoDetails(batch)
      const now = Date.now()
      for (const [designation, data] of Object.entries(objects)) {
        neoDetails[designation] = { data, fetchedAt: now }
        neoDetailsErrors.delete(designation)
      }
      saveCached('neo-details', neoDetails)
      applyNeoDetails()
    } catch (err) {
      for (const designation of batch) neoDetailsErrors.set(designation, err.message)
    } finally {
      for (const designation of batch) neoDetailsLoading.delete(designation)
    }
    if (modalNeo) renderNeoModal()
  }
}

/** Re-colours and re-sizes the points once their sheets are known. */
function applyNeoDetails() {
  for (const entry of neoEntries) {
    entry.mesh.material = neoMaterialFor(entry.neo, entry.designation)
    entry.diameterKm = neoDiameterKm(entry.neo, entry.designation)
  }
  if (currentNeoFeed) renderNeoPanel(currentNeoFeed, null, currentNeoFetchedAt)
  renderScalePanel()
}

const NEO_POSITIONS_BATCH = 10 // backend maximum per call

/**
 * Real NEO positions from JPL Horizons (keyless, not part of the NASA quota).
 * Cached in localStorage per feed date range; only designations not cached yet
 * are fetched, in small batches so the scene fills in progressively. NEOs
 * without a position meanwhile show at their approximate (fallback) spot.
 */
async function loadNeoPositions(feed) {
  const range = `${feed.start_date}_${feed.end_date}`
  const cached = loadCached('neo-positions')
  neoPositions =
    cached && cached.data.range === range ? cached.data : { range, stepSeconds: 3600, objects: {} }

  const missing = [...new Set(neoEntries.map((e) => e.designation))].filter((d) => !(d in neoPositions.objects))
  // The backend rejects anything outside this pattern for the whole batch.
  for (const designation of missing.filter((d) => !DESIGNATION_PATTERN.test(d))) {
    neoPositions.objects[designation] = null
  }
  const fetchable = missing.filter((d) => DESIGNATION_PATTERN.test(d))

  neoPositionsLoading = fetchable.length > 0
  renderNeoPositionsStatus()

  for (let i = 0; i < fetchable.length; i += NEO_POSITIONS_BATCH) {
    let res
    try {
      res = await fetchNeoPositions(feed.start_date, feed.end_date, fetchable.slice(i, i + NEO_POSITIONS_BATCH))
    } catch {
      break // leave the rest approximate; retried on next load
    }
    if (feed !== currentNeoFeed) return // superseded by a newer feed meanwhile
    neoPositions.stepSeconds = res.step_seconds
    Object.assign(neoPositions.objects, res.objects)
    saveCached('neo-positions', neoPositions)
    renderNeoPositionsStatus()
  }

  if (feed !== currentNeoFeed) return
  neoPositionsLoading = false
  renderNeoPositionsStatus()
  renderScalePanel()
}

async function refreshNeo() {
  try {
    const feed = await fetchNeoFeed()
    saveCached('neo', feed)
    showNeoFeed(feed, Date.now())
  } catch (err) {
    renderNeoPanel(null, err.message)
  }
}

async function refreshApod() {
  try {
    const apod = await fetchApod()
    saveCached('apod', apod)
    renderApodPanel(apod, null, Date.now())
  } catch (err) {
    renderApodPanel(null, err.message)
  }
}

const updateBtn = document.getElementById('update-btn')
updateBtn.addEventListener('click', async () => {
  updateBtn.disabled = true
  updateBtn.textContent = 'Mise à jour…'
  await Promise.all([refreshIss(), refreshNeo(), refreshApod()])
  await refreshUsage()
  updateBtn.disabled = false
  updateBtn.textContent = 'Mettre à jour'
})

refreshUsage()
renderScalePanel()

const cachedIss = loadCached('iss')
const cachedNeo = loadCached('neo')
const cachedApod = loadCached('apod')

if (cachedIss) {
  applyIssPosition(cachedIss.data)
  renderIssPanel(cachedIss.data, null, cachedIss.fetchedAt)
}
if (cachedNeo) {
  showNeoFeed(cachedNeo.data, cachedNeo.fetchedAt)
}
if (cachedApod) {
  renderApodPanel(cachedApod.data, null, cachedApod.fetchedAt)
}
// First-ever load has nothing to show yet — fetch once. Otherwise stay on the
// cached snapshot until "Mettre à jour" is clicked, to spare the NASA quota.
if (!cachedIss || !cachedNeo || !cachedApod) {
  updateBtn.click()
}

// The ISS covers ~460 km a minute, visibly off at true scale — refresh it on
// its own. wheretheiss.at isn't part of the NASA quota.
setInterval(refreshIss, 60_000)

// --- render loop --------------------------------------------------------------

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
})

function animate() {
  requestAnimationFrame(animate)
  const nowMs = Date.now()
  // Recomputed fresh from wall-clock time every frame (not accumulated per
  // frame) so it's exactly right regardless of frame rate or a backgrounded
  // tab, with no drift to correct for.
  globe.rotation.y = (getGreenwichSiderealTime(new Date(nowMs)) * Math.PI) / 180

  stepScaleTransition(performance.now())
  updateCameraLimits()
  controls.update()
  skyGroup.position.copy(camera.position)
  globe.updateMatrixWorld()
  applyScale(nowMs / 1000)
  updateSceneLabels()

  renderer.render(scene, camera)
}
animate()
