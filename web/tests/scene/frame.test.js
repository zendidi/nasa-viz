import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { EARTH_POSITION_KM, createViewFrame } from '../../src/scene/frame.js'
import { AU_KM } from '../../src/scale.js'

// What is pinned: the sign conventions between the three frames a sample can
// come in, and that the pivot is the origin. Each one, inverted, still draws a
// plausible scene — an orbit ringing the wrong body, the Earth one Sun-distance
// off its own line — which is why they live here and not on the screen.

const SUN_KM = new THREE.Vector3(AU_KM * 0.6, AU_KM * 0.1, -AU_KM * 0.79)
const MARS = { id: 'mars', radiusKm: 3389.5, positionKm: new THREE.Vector3(-1.2 * AU_KM, 0.3 * AU_KM, 0.5 * AU_KM) }

const frameAt = (id) => {
  const frame = createViewFrame({ sunPositionKm: SUN_KM.clone() })
  frame.set(id, id === 'mars' ? MARS : null)
  return frame
}

const close = (a, b) => expect(a.distanceTo(b)).toBeLessThan(1e-6 * Math.max(1, b.length()))

describe.each([0, 0.5, 1])('createViewFrame, t = %s', (t) => {
  it('le pivot est l’origine de la scène', () => {
    const out = new THREE.Vector3()
    expect(frameAt('earth').placeKm(out, EARTH_POSITION_KM, t).length()).toBe(0)
    const sun = frameAt('sun')
    expect(sun.placeKm(out, sun.positionKm(), t).length()).toBe(0)
    expect(frameAt('mars').placeKm(out, MARS.positionKm, t).length()).toBe(0)
  })

  it.each(['earth', 'sun', 'mars'])('héliocentrique = géocentrique + Soleil, et non − Soleil (pivot %s)', (id) => {
    const frame = frameAt(id)
    const helio = new THREE.Vector3(0.3 * AU_KM, -0.2 * AU_KM, 1.1 * AU_KM)
    const viaHelio = frame.placeHeliocentricKm(new THREE.Vector3(), helio, t)
    const viaGeo = frame.placeKm(new THREE.Vector3(), helio.clone().add(SUN_KM), t)
    close(viaHelio, viaGeo)
  })

  it('la Terre héliocentrique (−Soleil) tombe sur le pivot Terre : elle est sur sa propre orbite', () => {
    const out = frameAt('earth').placeHeliocentricKm(new THREE.Vector3(), SUN_KM.clone().negate(), t)
    expect(out.length()).toBeLessThan(1e-6)
  })

  it('la compression est radiale : la direction depuis le pivot est conservée', () => {
    const frame = frameAt('mars')
    const out = frame.placeKm(new THREE.Vector3(), SUN_KM, t)
    const dir = SUN_KM.clone().sub(MARS.positionKm).normalize()
    expect(out.clone().normalize().dot(dir)).toBeCloseTo(1, 12)
  })
})

describe('createViewFrame, état', () => {
  it('suit le Soleil par référence, sans passation par image', () => {
    const sun = SUN_KM.clone()
    const frame = createViewFrame({ sunPositionKm: sun })
    frame.set('sun', null)
    sun.multiplyScalar(1.01)
    expect(frame.positionKm()).toBe(sun)
  })

  it('géocentrique depuis la Terre seulement parmi Terre, Soleil, Mars', () => {
    expect(frameAt('earth').geocentric()).toBe(true)
    expect(frameAt('sun').geocentric()).toBe(false)
    expect(frameAt('mars').geocentric()).toBe(false)
  })

  it('part de la Terre, sans planète pivot', () => {
    const frame = createViewFrame({ sunPositionKm: SUN_KM.clone() })
    expect(frame.id).toBe('earth')
    expect(frame.planet).toBe(null)
  })
})
