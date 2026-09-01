import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { fetchIssPosition, fetchNeoFeed, fetchUsage } from './api.js'
import { loadCached, saveCached } from './cache.js'

const EARTH_RADIUS = 2
// Real ISS altitude is ~0.06x Earth's radius (barely off the surface visually).
// Exaggerated here so the marker reads clearly against the globe.
const ISS_ALTITUDE_EXAGGERATION = 8
const EARTH_RADIUS_KM = 6371

const app = document.getElementById('app')

// --- scene setup ---------------------------------------------------------

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000)
camera.position.set(0, 3, 8)

const renderer = new THREE.WebGLRenderer({ antialias: true })
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
app.appendChild(renderer.domElement)

const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
controls.minDistance = 3.5
controls.maxDistance = 20

renderer.outputColorSpace = THREE.SRGBColorSpace

scene.add(new THREE.AmbientLight(0xffffff, 0.6))
const sunLight = new THREE.DirectionalLight(0xffffff, 1.2)
sunLight.position.set(5, 3, 5)
scene.add(sunLight)

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
    scene.add(points)
  })
  .catch(() => scene.add(makeFallbackStarfield()))

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
    scene.add(parent)
  })
  .catch(() => {})

const globe = makeGlobe()
scene.add(globe)

const issMarker = makeIssMarker()
scene.add(issMarker)

const neoGroup = new THREE.Group()
scene.add(neoGroup)

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

// --- scene objects -----------------------------------------------------------

function makeGlobe() {
  const group = new THREE.Group()
  const textureLoader = new THREE.TextureLoader()

  // Day map + clouds baked in (mrdoob/three.js examples, derived from NASA
  // Blue Marble / public domain imagery), with a specular mask so oceans
  // catch the sun and a normal map for subtle terrain relief.
  const dayMap = textureLoader.load('/textures/earth_atmos_2048.jpg')
  dayMap.colorSpace = THREE.SRGBColorSpace

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(EARTH_RADIUS, 64, 64),
    new THREE.MeshPhongMaterial({
      map: dayMap,
      specularMap: textureLoader.load('/textures/earth_specular_2048.jpg'),
      normalMap: textureLoader.load('/textures/earth_normal_2048.jpg'),
      normalScale: new THREE.Vector2(0.6, 0.6),
      specular: new THREE.Color(0x333333),
      shininess: 12,
    }),
  )
  group.add(sphere)

  return group
}

function makeIssMarker() {
  const group = new THREE.Group()
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(0.06, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xffcc33 }),
  )
  group.add(body)

  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xffcc33, transparent: true, opacity: 0.25 }),
  )
  group.add(glow)

  return group
}

const STAR_SHELL_RADIUS = 80

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
    transparent: true,
    depthWrite: false,
  })

  // Clones: the "size"/"color" BufferAttributes above wrap these same typed
  // arrays, so hover highlighting (which mutates them in place) needs an
  // untouched copy to restore from.
  return {
    points: new THREE.Points(geometry, material),
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
  const material = new THREE.LineBasicMaterial({ color: 0x6fb7ff, transparent: true, opacity: 0.55, depthWrite: false })
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
  return new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0xffffff, size: 0.08 }))
}

function addNeoPoints(objects) {
  neoGroup.clear()
  const shellRadius = EARTH_RADIUS * 3.5

  for (const neo of objects) {
    const avgDiameter = (neo.estimated_diameter_km.min + neo.estimated_diameter_km.max) / 2
    const size = THREE.MathUtils.clamp(avgDiameter * 0.15, 0.03, 0.2)
    const color = neo.is_potentially_hazardous ? 0xff4d4d : 0x7fe0ff

    // Slightly oversized invisible hit-sphere layered under the visible mesh
    // makes small NEOs easier to click without inflating what's rendered.
    const hitTarget = new THREE.Mesh(
      new THREE.SphereGeometry(Math.max(size, 0.12), 8, 8),
      new THREE.MeshBasicMaterial({ visible: false }),
    )
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(size, 10, 10),
      new THREE.MeshBasicMaterial({ color }),
    )
    const position = hashToDirection(neo.id).multiplyScalar(shellRadius)
    mesh.position.copy(position)
    hitTarget.position.copy(position)
    mesh.userData.neo = neo
    hitTarget.userData.neo = neo
    neoGroup.add(mesh)
    neoGroup.add(hitTarget)
  }
}

function applyIssPosition(position) {
  const orbitRadius = EARTH_RADIUS * (1 + (position.altitude_km / EARTH_RADIUS_KM) * ISS_ALTITUDE_EXAGGERATION)
  issMarker.position.copy(latLngToVector3(position.latitude, position.longitude, orbitRadius))
}

// --- UI overlay --------------------------------------------------------------

const ui = document.createElement('div')
ui.id = 'ui'
ui.innerHTML = `
  <div id="ui-header">
    <h1>NASA Viz</h1>
    <button id="update-btn">Mettre à jour</button>
    <span id="usage-badge" class="muted" title="Requêtes envoyées à api.nasa.gov (NEO + APOD) depuis minuit UTC — hors ISS, non limitée">…</span>
  </div>
  <section id="iss-panel">
    <h2><span class="dot dot-iss"></span>ISS</h2>
    <p class="muted">chargement…</p>
  </section>
  <section id="neo-panel">
    <h2>Astéroïdes proches (NEO)</h2>
    <p class="muted">chargement…</p>
  </section>
`
app.appendChild(ui)

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
  #update-btn { pointer-events: auto; background: #1c4d7a; color: #eaf4ff; border: 1px solid #4fa8ff;
                border-radius: 4px; padding: 4px 12px; font-size: 12px; cursor: pointer; text-shadow: none; }
  #update-btn:hover { background: #24608f; }
  #update-btn:disabled { opacity: 0.5; cursor: default; }
  #usage-badge { font-size: 12px; cursor: help; }

  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
  #iss-panel h2 .dot { margin-bottom: 2px; }
  .dot-iss { background: #ffcc33; box-shadow: 0 0 5px #ffcc33; }
  .dot-neo { background: #7fe0ff; }
  .dot-neo-hazard { background: #ff4d4d; }
  .legend { font-size: 12px; opacity: 0.8; }

  #modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: flex;
                     align-items: center; justify-content: center; font-family: system-ui, sans-serif; }
  #modal-backdrop.hidden { display: none; }
  #modal { position: relative; background: #0e2233; color: #eaf4ff; border: 1px solid #4fa8ff;
           border-radius: 8px; padding: 20px 24px; max-width: 380px; width: 90%; }
  #modal h2 { margin: 0 0 12px; font-size: 17px; }
  #modal p { margin: 4px 0; font-size: 13px; line-height: 1.5; }
  #modal .muted { opacity: 0.6; }
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
  el.innerHTML = `
    <h2>Astéroïdes proches (NEO)</h2>
    <p>${feed.count} objets (${feed.start_date} → ${feed.end_date}) · clic sur un point pour le détail</p>
    <p>${hazardous} potentiellement dangereux</p>
    <p class="legend"><span class="dot dot-neo"></span>standard &nbsp;<span class="dot dot-neo-hazard"></span>dangereux</p>
    ${formatUpdatedAt(fetchedAt)}
  `
}

function showNeoModal(neo) {
  document.getElementById('modal-title').textContent = neo.name
  const approach = neo.close_approach
  document.getElementById('modal-body').innerHTML = `
    <p><strong>ID</strong> ${neo.id}</p>
    <p><strong>Diamètre estimé</strong> ${neo.estimated_diameter_km.min.toFixed(3)} – ${neo.estimated_diameter_km.max.toFixed(3)} km</p>
    <p><strong>Potentiellement dangereux</strong> ${neo.is_potentially_hazardous ? 'Oui' : 'Non'}</p>
    ${
      approach
        ? `
      <p><strong>Approche la plus proche</strong> ${approach.date}</p>
      <p><strong>Distance</strong> ${Math.round(approach.miss_distance_km).toLocaleString('fr-FR')} km</p>
      <p><strong>Vitesse relative</strong> ${Math.round(approach.relative_velocity_kmh).toLocaleString('fr-FR')} km/h</p>
    `
        : '<p class="muted">Pas de données d\'approche disponibles</p>'
    }
  `
  modal.classList.remove('hidden')
}

function hideNeoModal() {
  modal.classList.add('hidden')
}

document.getElementById('modal-close').addEventListener('click', hideNeoModal)
modal.addEventListener('click', (event) => {
  if (event.target === modal) hideNeoModal()
})
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') hideNeoModal()
})

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
  const intersects = raycaster.intersectObjects(neoGroup.children)
  return intersects.length > 0 ? intersects[0].object.userData.neo : null
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

/** True if the globe sits between the camera and this star (so it's not actually visible). */
function isOccludedByGlobe(worldPos) {
  const camPos = camera.position
  starPickRayDir.subVectors(worldPos, camPos)
  const distToStar = starPickRayDir.length()
  starPickRayDir.normalize()

  const b = camPos.dot(starPickRayDir)
  const c = camPos.dot(camPos) - EARTH_RADIUS * EARTH_RADIUS
  const discriminant = b * b - c
  if (discriminant < 0) return false // ray misses the globe entirely

  const tHit = -b - Math.sqrt(discriminant)
  return tHit > 0 && tHit < distToStar
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
    if (isOccludedByGlobe(starPickWorldPos)) continue

    starPickScreenPos.copy(starPickWorldPos).project(camera)
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

renderer.domElement.addEventListener('click', (event) => {
  const neo = pickNeoAt(event.clientX, event.clientY)
  if (neo) showNeoModal(neo)
})

renderer.domElement.addEventListener('pointermove', (event) => {
  if (pickNeoAt(event.clientX, event.clientY)) {
    renderer.domElement.style.cursor = 'pointer'
    hideStarTooltip()
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

async function refreshNeo() {
  try {
    const feed = await fetchNeoFeed()
    saveCached('neo', feed)
    addNeoPoints(feed.objects)
    renderNeoPanel(feed, null, Date.now())
  } catch (err) {
    renderNeoPanel(null, err.message)
  }
}

const updateBtn = document.getElementById('update-btn')
updateBtn.addEventListener('click', async () => {
  updateBtn.disabled = true
  updateBtn.textContent = 'Mise à jour…'
  await Promise.all([refreshIss(), refreshNeo()])
  await refreshUsage()
  updateBtn.disabled = false
  updateBtn.textContent = 'Mettre à jour'
})

refreshUsage()

const cachedIss = loadCached('iss')
const cachedNeo = loadCached('neo')

if (cachedIss) {
  applyIssPosition(cachedIss.data)
  renderIssPanel(cachedIss.data, null, cachedIss.fetchedAt)
}
if (cachedNeo) {
  addNeoPoints(cachedNeo.data.objects)
  renderNeoPanel(cachedNeo.data, null, cachedNeo.fetchedAt)
}
// First-ever load has nothing to show yet — fetch once. Otherwise stay on the
// cached snapshot until "Mettre à jour" is clicked, to spare the NASA quota.
if (!cachedIss || !cachedNeo) {
  updateBtn.click()
}

// --- render loop --------------------------------------------------------------

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
})

function animate() {
  requestAnimationFrame(animate)
  globe.rotation.y += 0.0006
  controls.update()
  renderer.render(scene, camera)
}
animate()
