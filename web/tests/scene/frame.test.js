import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { EARTH_POSITION_KM, createViewFrame } from '../../src/scene/frame.js'
import { AU_KM } from '../../src/view/scale.js'

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

// 2026-11-05 : le pivot Terre peut suivre la « Terre fantôme » de l'outil de
// trajectoire. Épinglé : un décalage nul ne change RIEN (c'est le cas de toutes les
// sessions qui n'y touchent pas), et un décalage non nul déplace l'origine du seul
// pivot Terre — le Soleil et une planète restent où ils sont.
describe('createViewFrame, décalage du pivot Terre', () => {
  const GHOST = new THREE.Vector3(2e7, -5e6, 1e7)

  it.each([0, 0.5, 1])('décalage nul ou absent : identique au comportement sans décalage, au bit près (t = %s)', (t) => {
    const reference = frameAt('earth')
    const zeroed = frameAt('earth')
    zeroed.setEarthOffsetKm(new THREE.Vector3(0, 0, 0))
    const afterReset = frameAt('earth')
    afterReset.setEarthOffsetKm(GHOST)
    afterReset.setEarthOffsetKm(null)
    const point = new THREE.Vector3(3e5, -2e5, 1e5)
    for (const frame of [zeroed, afterReset]) {
      expect(frame.positionKm()).toBe(EARTH_POSITION_KM)
      expect(frame.placeKm(new THREE.Vector3(), point, t).toArray()).toEqual(reference.placeKm(new THREE.Vector3(), point, t).toArray())
      expect(frame.placeHeliocentricKm(new THREE.Vector3(), point, t).toArray()).toEqual(
        reference.placeHeliocentricKm(new THREE.Vector3(), point, t).toArray(),
      )
    }
  })

  it.each([0, 0.5, 1])("décalé : le point décalé tombe sur le pivot, la vraie Terre s'en écarte (t = %s)", (t) => {
    const frame = frameAt('earth')
    frame.setEarthOffsetKm(GHOST)
    expect(frame.placeKm(new THREE.Vector3(), GHOST, t).length()).toBe(0)
    expect(frame.placeKm(new THREE.Vector3(), EARTH_POSITION_KM, t).length()).toBeGreaterThan(0)
  })

  it('le décalage est copié (le propriétaire peut réutiliser son vecteur) et ne touche pas les autres pivots', () => {
    const shared = GHOST.clone()
    const earth = frameAt('earth')
    earth.setEarthOffsetKm(shared)
    shared.set(0, 0, 0)
    expect(earth.positionKm().equals(GHOST)).toBe(true)

    const sun = frameAt('sun')
    sun.setEarthOffsetKm(GHOST)
    expect(sun.positionKm().equals(SUN_KM)).toBe(true)
    const mars = frameAt('mars')
    mars.setEarthOffsetKm(GHOST)
    expect(mars.positionKm()).toBe(MARS.positionKm)
  })
})
