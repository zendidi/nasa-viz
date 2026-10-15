/**
 * The bodies the scene draws: the Earth globe and its day/night shader, the
 * ISS and Sun markers, the Moon, and the reference distance circles.
 *
 * Factories, not state: each returns its object and forgets it. Where the
 * object goes, how big it is drawn and when it moves is the scene's business
 * (main.js) — nothing here reads the scale or the point of view. The one
 * exception is the ring set, which owns its group because rebuilding it means
 * emptying and refilling that group.
 */

import * as THREE from 'three'
import { OBLIQUITY_RAD } from './geo.js'
import { EARTH_RADIUS, ISS_READABLE_RADIUS, KM_TO_UNITS, MOON_RADIUS_KM, SUN_READABLE_RADIUS } from '../scale.js'

/** The Moon's true radius in scene units — its readable size is a scale factor on top. */
export const MOON_RADIUS = MOON_RADIUS_KM * KM_TO_UNITS

/**
 * The default `uMap` of every lit body: one opaque white texel, so the shader
 * can sample unconditionally. A body with no texture multiplies its colour by
 * white and comes out exactly as before.
 *
 * This is what keeps the promise `makeLitBodyMaterial` makes below — **one
 * shader source, one compiled program**. Branching the source on "has a map"
 * would have split the program cache in two, and swapping `uMap.value` later
 * would then have meant a recompile. Swapping a sampler's value on an unchanged
 * source does not.
 */
const WHITE_PIXEL = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1)
WHITE_PIXEL.needsUpdate = true

/** @type {Map<string, Promise<THREE.Texture>>} */
const colorMaps = new Map()

/**
 * Loads a colour map, once per URL, and resolves only when the image is
 * actually decoded.
 *
 * **A promise rather than the texture**, which is the whole point:
 * `TextureLoader.load()` hands back a `Texture` whose `image` is still
 * undefined, and binding that to a sampler draws the body *black* until the
 * download lands. Handing out the texture early would trade a flat-coloured
 * planet for a black one — strictly worse, and it would read as a bug. The
 * caller swaps its `uMap` in the `.then`, so a planet goes straight from flat
 * colour to photograph.
 *
 * `SRGBColorSpace` because these are colour maps: the tag is what makes three.js
 * decode the texel to linear before the shader multiplies it, and without it
 * every textured body comes out washed out. It does **not** belong on a normal
 * or specular map, whose values aren't colours — the globe's own maps
 * deliberately don't set it.
 */
export function loadColorMap(url, { wrapS = THREE.RepeatWrapping } = {}) {
  const pending =
    colorMaps.get(url) ??
    new Promise((resolve, reject) => {
      new THREE.TextureLoader().load(
        url,
        (texture) => {
          texture.colorSpace = THREE.SRGBColorSpace
          // Equirectangular maps wrap the full 360° in u, so RepeatWrapping by
          // default: ClampToEdge would smear the last column across any seam a
          // float error puts past 1. A ring band is the opposite case — its u is
          // a *radius*, not an angle — so its caller asks for ClampToEdge, and
          // wrapping there would paint the inner edge outside the outer one.
          texture.wrapS = wrapS
          texture.anisotropy = 4
          resolve(texture)
        },
        undefined,
        reject,
      )
    })
  colorMaps.set(url, pending)
  return pending
}

/**
 * The Earth's maps, Solar System Scope's set since 2026-10-12 (CC BY 4.0,
 * `web/public/textures/CREDITS.md`) — where the globe wore the three.js example
 * textures, whose licence was never established, until the comparison the user
 * had deferred was made.
 *
 * The switch is what makes the cloud layer possible at all, and that is the
 * reason it happened now rather than on licence grounds: `earth_atmos_2048.jpg`
 * has its clouds **painted into the day map**, so a cloud sphere over it would
 * have drawn every weather system twice, a few degrees apart. SSS ships the day
 * side cloud-free and the clouds as their own map, which is the only shape in
 * which a separate, independently drifting layer means anything.
 *
 * Measured before swapping, since a drop-in replacement is a claim and not a
 * hope: the two normal maps average (128,127,254) and (127,126,252), the two
 * specular maps 172 and 173 grey — same encodings, so the shader below needed
 * no change — and the 2026-09-29 longitude calibration had already found the
 * two sets aligned to 0 px over 2048.
 */
const EARTH_MAPS = {
  day: '/textures/2k_earth_daymap.jpg',
  night: '/textures/2k_earth_nightmap.jpg',
  specular: '/textures/2k_earth_specular_map.jpg',
  normal: '/textures/2k_earth_normal_map.jpg',
  clouds: '/textures/2k_earth_clouds.jpg',
}

/**
 * Cloud layer, as a share of the Earth's radius. 0,3 % is 19 km — the real
 * ceiling of weather, and the smallest offset that still keeps the layer clear
 * of the surface at every scale the slider reaches: thinner and the two spheres
 * z-fight, thicker and the clouds visibly float off the limb.
 */
const CLOUD_ALTITUDE = 1.003

/**
 * How far the cloud sphere turns per day, on top of the globe's own GMST
 * rotation. A rigid drift is a **visual convention, not weather** — real
 * systems move at different speeds in different latitude bands — so it is kept
 * slow enough to read as motion over a minute of watching without ever
 * suggesting it is a forecast. Eastward, like the mid-latitude flow.
 */
const CLOUD_DRIFT_DEG_PER_DAY = 7

/**
 * Day/night terminator: a hand-rolled shader rather than MeshPhongMaterial,
 * blending the day map against a city-lights night map by how much each
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
export function makeGlobe() {
  const group = new THREE.Group()
  const textureLoader = new THREE.TextureLoader()

  const dayMap = textureLoader.load(EARTH_MAPS.day)
  dayMap.colorSpace = THREE.SRGBColorSpace
  const nightMap = textureLoader.load(EARTH_MAPS.night)
  nightMap.colorSpace = THREE.SRGBColorSpace

  const material = new THREE.ShaderMaterial({
    uniforms: {
      dayTexture: { value: dayMap },
      nightTexture: { value: nightMap },
      specularTexture: { value: textureLoader.load(EARTH_MAPS.specular) },
      normalTexture: { value: textureLoader.load(EARTH_MAPS.normal) },
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
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(EARTH_RADIUS, 64, 64), material)
  group.add(sphere)

  /**
   * The clouds. A child of `sphere` rather than of `group`, which is what makes
   * the whole thing free of per-frame bookkeeping: the sphere is the mesh the
   * pixel floor scales, so hanging off it means the layer tracks the Earth's
   * drawn radius at every scale by inheritance, and it inherits the group's
   * GMST rotation too — leaving its own `rotation.y` free to carry nothing but
   * the drift (set in main.js's animate()). The ISS marker is the counter-case
   * and the reason this distinction exists: it must *not* follow the floor, so
   * it hangs off the group.
   *
   * The map is a JPEG, so it has no alpha channel: white cloud on black sky,
   * read as opacity through its red channel. `depthWrite: false` because it is
   * transparent; the far hemisphere's clouds are still hidden, by the opaque
   * globe's own depth, 0,3 % below.
   */
  const cloudMaterial = new THREE.ShaderMaterial({
    uniforms: {
      cloudTexture: { value: textureLoader.load(EARTH_MAPS.clouds) },
      // The same uniform object as the globe's, by reference: updateAstronomy()
      // writes the Sun direction once and both shaders read it. Copying it into
      // a second uniform would be one more thing to keep in step every minute.
      sunDirection: material.uniforms.sunDirection,
      opacity: { value: 0.85 },
    },
    transparent: true,
    depthWrite: false,
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec2 vUv;
      varying vec3 vWorldNormal;
      void main() {
        vUv = uv;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: `
      uniform sampler2D cloudTexture;
      uniform vec3 sunDirection;
      uniform float opacity;
      varying vec2 vUv;
      varying vec3 vWorldNormal;
      #include <logdepthbuf_pars_fragment>

      void main() {
        #include <logdepthbuf_fragment>
        float cloud = texture2D(cloudTexture, vUv).r;
        float sunFacing = dot(normalize(vWorldNormal), normalize(sunDirection));
        // Same terminator band as the globe below, so the cloud edge and the
        // ground's day/night edge are one line and not two.
        float dayMix = smoothstep(-0.15, 0.15, sunFacing);
        // Clouds fade out with the night rather than going grey: on the night
        // side the only thing worth seeing is the city lights, and a cloud deck
        // over them would hide the one feature that map exists for.
        gl_FragColor = vec4(vec3(0.75 + 0.25 * max(sunFacing, 0.0)), cloud * opacity * dayMix);
        #include <colorspace_fragment>
      }
    `,
  })
  const clouds = new THREE.Mesh(new THREE.SphereGeometry(EARTH_RADIUS * CLOUD_ALTITUDE, 64, 64), cloudMaterial)
  sphere.add(clouds)

  // The material carries the `sunDirection` uniform the terminator reads, the
  // sphere is the mesh the size floor scales, and the clouds carry their own
  // drift — all handed back rather than dug out of the group later.
  return { group, material, sphere, clouds }
}

/** Where the cloud layer has drifted to at `date`, in radians. See CLOUD_DRIFT_DEG_PER_DAY. */
export function cloudDriftAt(date) {
  return (((date.getTime() / 86_400_000) * CLOUD_DRIFT_DEG_PER_DAY) % 360) * (Math.PI / 180)
}

export function makeIssMarker() {
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

/**
 * The Sun itself is self-lit (MeshBasicMaterial), not shaded by sunLight — so
 * its map is the one texture in the scene that must *not* be darkened by a
 * terminator: every point of the photosphere we can see is emitting.
 *
 * 48 segments on the body, still 16 on the glow: the glow is a soft halo whose
 * silhouette nobody reads, the body's is read the moment the Sun is the pivot.
 *
 * `loadTexture()` on the returned group, rather than a map argument, because
 * the 822 ko are only worth spending once the Sun *is* the pivot — the same
 * rule the planets follow (`loadTextureFor` in planets.js). The white `color`
 * is what makes the swap a straight replace instead of a cream-coloured tint,
 * and keeping it cream until then is what keeps today's marker unchanged.
 */
export function makeSunMarker() {
  const group = new THREE.Group()
  const material = new THREE.MeshBasicMaterial({ color: 0xfff2cc })
  const body = new THREE.Mesh(new THREE.SphereGeometry(SUN_READABLE_RADIUS, 48, 48), material)
  group.add(body)

  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(SUN_READABLE_RADIUS * (5 / 3), 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xfff2cc, transparent: true, opacity: 0.25 }),
  )
  group.add(glow)

  let asked = false
  group.userData.loadTexture = () => {
    if (asked) return
    asked = true
    loadColorMap('/textures/2k_sun.jpg')
      .then((map) => {
        material.map = map
        material.color.setHex(0xffffff)
        // Required, and easy to miss: a MeshBasicMaterial that gains a map
        // after its first compile needs a recompile, because `map` is a shader
        // define and not merely a uniform. Without this the Sun stays cream and
        // nothing says why. (The lit bodies don't need it — their `uMap` is
        // always declared, which is exactly what the white texel buys.)
        material.needsUpdate = true
      })
      .catch(() => {
        asked = false
      })
  }

  return group
}

/**
 * Textured (mrdoob/three.js examples) and lit by the same sunLight as the
 * globe — its visible phase (crescent/gibbous) falls out of that real
 * directional lighting automatically, no separate phase calculation needed.
 */
export function makeMoon() {
  const textureLoader = new THREE.TextureLoader()
  const moonMap = textureLoader.load('/textures/moon_1024.jpg')
  moonMap.colorSpace = THREE.SRGBColorSpace

  return new THREE.Mesh(
    new THREE.SphereGeometry(MOON_RADIUS, 32, 32),
    new THREE.MeshPhongMaterial({ map: moonMap, shininess: 0 }),
  )
}

/**
 * Reference circles around the pivot, in the ecliptic plane (the Moon's orbit
 * is within ~5° of it): lunar distances around the Earth, astronomical units
 * around the Sun — whichever the current point of view defines (focus.js).
 * Hidden in the readable layout, where distances aren't proportional anyway;
 * each is a unit circle scaled to its scene distance per frame, so the 1 px
 * line stays crisp at any scale.
 */
const ringGeometry = (() => {
  const points = []
  for (let i = 0; i < 256; i++) {
    const a = (i / 256) * Math.PI * 2
    points.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)))
  }
  return new THREE.BufferGeometry().setFromPoints(points)
})()
const ringMaterial = new THREE.LineBasicMaterial({ color: 0x4fa8ff, transparent: true, opacity: 0.3, depthWrite: false })

/**
 * Warm circle for a ring at an **absolute** distance, against the blue of the
 * ones scaled to the pivot. The two say different things and must not be read as
 * one family: a scaled ring always lands at the same place on screen whichever
 * pivot you pick (that is what makes it legible), so it cannot show you that one
 * system is bigger than another. The absolute one is the fixed yardstick that
 * can — it shrinks onto the planet as you move outward.
 */
const absoluteRingMaterial = new THREE.LineBasicMaterial({
  color: 0xffbf66,
  transparent: true,
  opacity: 0.32,
  depthWrite: false,
})

/**
 * A lit body's material - a planet or a moon. One `ShaderMaterial` per body, because the whole
 * point is a per-body sun direction: `uSunDir` is `normalize(sunKm − bodyKm)`
 * in scene axes, which is exact whatever the scale slider does to distances —
 * it is computed from the real km vectors, not from where the two ended up on
 * screen. That is what the flat discs were waiting for: a `DirectionalLight` has
 * a single direction for the whole scene (the Sun as seen from the *Earth*), so
 * lighting Mars with it drew Mars's terminator facing the Earth's way.
 *
 * One material per body, one shader program: the sources are identical, so three.js's
 * program cache hands out the same compiled program and only the uniforms
 * differ.
 *
 * `uOpacity` rather than `material.opacity`: a hand-written ShaderMaterial gets
 * no automatic opacity, the fragment has to write the alpha itself.
 */
export function makeLitBodyMaterial(color, map = null) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uOpacity: { value: 1 },
      // Swappable at any time — see `WHITE_PIXEL`. A body gets its map when it
      // arrives, not when the mesh is built.
      uMap: { value: map ?? WHITE_PIXEL },
    },
    // Required by the renderer's logarithmicDepthBuffer — a hand-written
    // ShaderMaterial doesn't get these chunks automatically, and without them a
    // planet's depth wouldn't match the Moon's or the NEO points'. Same trap the
    // globe documents; see docs/agent/gotchas.md.
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vWorldNormal;
      varying vec2 vUv;
      void main() {
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        // uv needs no declaration: three.js prepends it for a ShaderMaterial,
        // and SphereGeometry already carries the attribute.
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform vec3 uSunDir;
      uniform float uOpacity;
      uniform sampler2D uMap;
      varying vec3 vWorldNormal;
      varying vec2 vUv;
      #include <logdepthbuf_pars_fragment>
      void main() {
        #include <logdepthbuf_fragment>
        float sunFacing = dot(normalize(vWorldNormal), normalize(uSunDir));
        // Soft terminator, same band as the globe's, and a floor of 0,12 so the
        // night side stays a dark disc instead of a hole in the starfield — a
        // planet is never truly unlit here, and at a few pixels across a hard
        // black half would just read as the wrong shape.
        float lit = 0.12 + 0.88 * smoothstep(-0.15, 0.6, sunFacing);
        // A plain multiply, and the caller decides what it means: an untextured
        // body samples white and keeps its flat uColor; a textured one is given
        // uColor white (TEXTURED_TINT in planets.js) so the multiply becomes a
        // straight replace and the map is shown as photographed. Tinting a
        // photograph by a legend hue was the other option and it saturates
        // twice - Mars is already rust.
        // (No backticks in here: this is inside a template literal.)
        vec3 albedo = uColor * texture2D(uMap, vUv).rgb;
        gl_FragColor = vec4(albedo * lit, uOpacity);
        // Custom fragment shaders don't get the automatic linear->output
        // colorspace encode that built-in materials do.
        #include <colorspace_fragment>
      }
    `,
  })
}

/**
 * A planet's ring system, as a flat annulus meant to be **parented to the body's
 * mesh**: it then inherits the orientation solved at step 4, so it lies in the
 * equatorial plane for free, and it inherits the scale, so `innerRadius` and
 * `outerRadius` are given in units of the drawn body radius.
 *
 * Two things the default `RingGeometry` does not do, and both would be silently
 * wrong rather than obviously broken:
 *
 * - **It lies in XY, normal +Z.** Baked round to XZ with normal +Y here, which
 *   is where the body's own pole is (`geo.js`).
 * - **Its UVs map the bounding square**, so the band would be sampled as if it
 *   were a picture pinned behind the ring. Rewritten so `u` follows the
 *   *radius* — 0 at the inner edge, 1 at the outer — which is how a 2048 × 125
 *   ring band is drawn: 2048 samples across the rings, one repeated row.
 *
 * `phiSegments = 1` is deliberate: with u linear in radius and vertices only at
 * the two edges, the interpolator does exactly the right thing across the whole
 * width, and a subdivided annulus would only add vertices that change nothing.
 */
export function makeRing({ innerRadius, outerRadius, segments = 180 }) {
  const geometry = new THREE.RingGeometry(innerRadius, outerRadius, segments, 1)
  geometry.rotateX(-Math.PI / 2)

  const position = geometry.attributes.position
  const uv = geometry.attributes.uv
  for (let i = 0; i < position.count; i++) {
    const radius = Math.hypot(position.getX(i), position.getZ(i))
    uv.setXY(i, (radius - innerRadius) / (outerRadius - innerRadius), 0.5)
  }
  uv.needsUpdate = true

  return new THREE.Mesh(geometry, makeRingMaterial())
}

/**
 * The ring's own material. Close to `makeLitBodyMaterial`, and different in the
 * two ways a sheet differs from a ball.
 *
 * **Both faces are lit alike** — hence `abs()`. A ring is a sheet a few tens of
 * metres thick: what sets its brightness is how high the Sun stands above its
 * plane, not which side you are looking from. Real rings are translucent, so the
 * unlit face is not a copy of the lit one (on the unlit side the dense B ring
 * goes dark and the Cassini division brightens); modelling that transmission is
 * out of scope here, and this is the honest simple stand-in.
 *
 * **The floor is 0,30 and it is readability, not physics.** Measured for this
 * scene on 2026-09-29: the Sun stands **7,2° below** Saturn's ring plane and is
 * opening by about a degree a year, so an opaque-sheet model would draw the
 * rings at sin(7,2°) = **12,5 %** of full brightness — nearly black, right when
 * the user goes to look at what was just built. Same trade, and the same kind of
 * number, as the 0,12 floor on a planet's night side.
 */
function makeRingMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: WHITE_PIXEL },
      uSunDir: { value: new THREE.Vector3(1, 0, 0) },
      uOpacity: { value: 1 },
    },
    transparent: true,
    side: THREE.DoubleSide,
    // The ring is a transparent surface: writing depth would make the half of
    // it behind the planet occlude nothing while hiding whatever the sorted
    // pass draws after it.
    depthWrite: false,
    // Required by the renderer's logarithmicDepthBuffer, like every other
    // hand-written material here — see docs/agent/gotchas.md.
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vWorldNormal;
      varying vec2 vUv;
      void main() {
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: `
      uniform sampler2D uMap;
      uniform vec3 uSunDir;
      uniform float uOpacity;
      varying vec3 vWorldNormal;
      varying vec2 vUv;
      #include <logdepthbuf_pars_fragment>
      void main() {
        #include <logdepthbuf_fragment>
        vec4 texel = texture2D(uMap, vUv);
        float facing = abs(dot(normalize(vWorldNormal), normalize(uSunDir)));
        float lit = 0.30 + 0.70 * facing;
        gl_FragColor = vec4(texel.rgb * lit, texel.a * uOpacity);
        // The alpha channel is what carries the gaps. Discarding the empty
        // texels rather than blending them keeps the Cassini division from
        // writing a faint film over the stars behind it.
        if (gl_FragColor.a < 0.01) discard;
        #include <colorspace_fragment>
      }
    `,
  })
}

export function createDistanceRings(scene) {
  // Unit circles are drawn in XZ (normal +Y); rotating the group by the obliquity
  // about X turns that normal into the ecliptic pole in scene axes, (0, cos ε, sin ε).
  const group = new THREE.Group()
  group.rotation.x = OBLIQUITY_RAD
  scene.add(group)

  /** @type {{line: THREE.LineLoop, distanceKm: number, label: string}[]} */
  let list = []

  return {
    group,
    /** The rings currently in the group, in the order they were given. */
    get list() {
      return list
    },
    /**
     * Replaces the whole set — the point of view decides which circles apply.
     * A spec marked `absolute` gets the warm material: it is a fixed distance,
     * not one scaled to the pivot.
     */
    rebuild(specs) {
      group.clear()
      list = specs.map(({ km, label, absolute = false }) => {
        const line = new THREE.LineLoop(ringGeometry, absolute ? absoluteRingMaterial : ringMaterial)
        group.add(line)
        return { line, distanceKm: km, label }
      })
    },
  }
}
