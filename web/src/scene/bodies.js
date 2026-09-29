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
export function makeGlobe() {
  const group = new THREE.Group()
  const textureLoader = new THREE.TextureLoader()

  const dayMap = textureLoader.load('/textures/earth_atmos_2048.jpg')
  dayMap.colorSpace = THREE.SRGBColorSpace
  const nightMap = textureLoader.load('/textures/earth_lights_2048.png')
  nightMap.colorSpace = THREE.SRGBColorSpace

  const material = new THREE.ShaderMaterial({
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
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(EARTH_RADIUS, 64, 64), material)
  group.add(sphere)

  // The material carries the `sunDirection` uniform the terminator reads, and
  // the sphere is the mesh the size floor scales — both are handed back rather
  // than dug out of the group later.
  return { group, material, sphere }
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

/** The Sun itself is self-lit (MeshBasicMaterial), not shaded by sunLight. */
export function makeSunMarker() {
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
