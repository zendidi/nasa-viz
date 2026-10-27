import { describe, expect, it } from 'vitest'
import * as THREE from 'three'

import {
  OBLIQUITY_RAD,
  eclipticAuToSceneKm,
  hashToDirection,
  icrfToScene,
  latLngToVector3,
  mapUShift,
  raySphereDistance,
  setBodyOrientation,
} from '../../src/scene/geo.js'
import { AU_KM } from '../../src/scale.js'

// Ce que ces tests gardent, ce sont les *conventions* que les commentaires de
// geo.js disent avoir ete mesurees plutot que devinees -- l'orientation des
// cartes equirectangulaires, le sens de l'est, l'echange d'axes ICRF -> scene.
// Aucune n'est verifiable a l'oeil : une carte miroitee est-ouest reste une
// planete parfaitement inclinee, et un pole correct ne dit rien du meridien.
// C'est exactement le genre d'erreur qui survit a une validation visuelle, donc
// c'est ici qu'elle doit etre epinglee.

const CLOSE = 1e-12

describe('latLngToVector3', () => {
  it('place la longitude est 0 sur le +X du corps', () => {
    const p = latLngToVector3(0, 0, 1)
    expect(p.x).toBeCloseTo(1, 12)
    expect(p.y).toBeCloseTo(0, 12)
    expect(p.z).toBeCloseTo(0, 12)
  })

  it('place le pole nord sur le +Y du corps', () => {
    const p = latLngToVector3(90, 0, 1)
    expect(p.y).toBeCloseTo(1, 12)
    expect(Math.hypot(p.x, p.z)).toBeLessThan(1e-12)
  })

  it('fait croitre la longitude est vers -Z, et pas vers +Z', () => {
    // L'invariant que le docblock enonce : la longitude est lambda est en
    // (cos lambda, 0, -sin lambda). Le signe de Z est tout l'enjeu -- le prendre
    // a l'envers miroite chaque carte est-ouest sans rien casser d'autre.
    const p = latLngToVector3(0, 90, 1)
    expect(p.z).toBeCloseTo(-1, 12)
    expect(p.x).toBeCloseTo(0, 12)
  })

  it('suit (cos lambda, 0, -sin lambda) sur tout le tour', () => {
    for (const lng of [-180, -135, -90, -45, 0, 45, 90, 135, 180]) {
      const lambda = (lng * Math.PI) / 180
      const p = latLngToVector3(0, lng, 1)
      expect(p.x).toBeCloseTo(Math.cos(lambda), 12)
      expect(p.z).toBeCloseTo(-Math.sin(lambda), 12)
    }
  })

  it('met le rayon a l echelle sans changer la direction', () => {
    const unit = latLngToVector3(37, -122, 1)
    const scaled = latLngToVector3(37, -122, 6371)
    expect(scaled.length()).toBeCloseTo(6371, 9)
    expect(scaled.clone().normalize().distanceTo(unit)).toBeLessThan(CLOSE)
  })
})

describe('icrfToScene', () => {
  it('echange les axes en (x, z, -y)', () => {
    const out = new THREE.Vector3()
    expect(icrfToScene(1, 2, 3, out).toArray()).toEqual([1, 3, -2])
  })

  it('envoie le pole nord celeste (+Z en ICRF) sur le +Y de la scene', () => {
    const out = new THREE.Vector3()
    // Composante par composante, et pas toEqual sur le tableau : la negation de
    // geo.js rend -0 pour y = 0, et toEqual distingue -0 de +0 la ou l arithmetique
    // les traite comme egaux. Le code est juste, c est l assertion qui doit l etre.
    icrfToScene(0, 0, 1, out)
    expect(out.x).toBeCloseTo(0, 12)
    expect(out.y).toBeCloseTo(1, 12)
    expect(out.z).toBeCloseTo(0, 12)
  })

  it('ecrit dans la cible fournie et la rend, sans rien allouer', () => {
    const out = new THREE.Vector3()
    expect(icrfToScene(4, 5, 6, out)).toBe(out)
  })

  it('accorde le placement ICRF et le placement geographique', () => {
    // Le docblock affirme que icrfToScene est « le meme mapping que
    // latLngToVector3(dec, ra, r) ». On le verifie plutot que de le croire.
    for (const [ra, dec] of [[0, 0], [90, 0], [180, 0], [270, 45], [45, -30]]) {
      const raRad = (ra * Math.PI) / 180
      const decRad = (dec * Math.PI) / 180
      const out = icrfToScene(
        Math.cos(decRad) * Math.cos(raRad),
        Math.cos(decRad) * Math.sin(raRad),
        Math.sin(decRad),
        new THREE.Vector3(),
      )
      expect(out.distanceTo(latLngToVector3(dec, ra, 1))).toBeLessThan(1e-12)
    }
  })
})

describe('setBodyOrientation', () => {
  const axis = (q, v) => v.clone().applyQuaternion(q)

  it('amene le +Y local sur le pole et le +X local sur le meridien', () => {
    const q = setBodyOrientation(
      new THREE.Quaternion(),
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(1, 0, 0),
    )
    expect(axis(q, new THREE.Vector3(0, 1, 0)).distanceTo(new THREE.Vector3(0, 0, 1))).toBeLessThan(1e-12)
    expect(axis(q, new THREE.Vector3(1, 0, 0)).distanceTo(new THREE.Vector3(1, 0, 0))).toBeLessThan(1e-12)
  })

  it('oriente l est en pole x meridien, et non l inverse', () => {
    // Prendre meridien x pole miroite chaque carte est-ouest en laissant l axe
    // parfaitement incline : ca passerait toute verification sauf un relief nomme.
    const pole = new THREE.Vector3(0, 0, 1)
    const meridian = new THREE.Vector3(1, 0, 0)
    const q = setBodyOrientation(new THREE.Quaternion(), pole, meridian)
    // Le -Z local est l est du corps, puisque la longitude est croit vers -Z.
    const east = axis(q, new THREE.Vector3(0, 0, -1))
    expect(east.distanceTo(pole.clone().cross(meridian))).toBeLessThan(1e-12)
  })

  it('orthogonalise un meridien oblique au lieu de cisailler la carte', () => {
    // La route promet deux vecteurs perpendiculaires a 1e-16, mais makeBasis
    // n orthogonalise pas : le Gram-Schmidt de geo.js est ce qui protege.
    const pole = new THREE.Vector3(0, 0, 1)
    const skewed = new THREE.Vector3(1, 0, 0.3)
    const q = setBodyOrientation(new THREE.Quaternion(), pole, skewed)
    const x = axis(q, new THREE.Vector3(1, 0, 0))
    const y = axis(q, new THREE.Vector3(0, 1, 0))
    const z = axis(q, new THREE.Vector3(0, 0, 1))
    expect(x.length()).toBeCloseTo(1, 12)
    expect(x.dot(y)).toBeCloseTo(0, 12)
    expect(y.dot(z)).toBeCloseTo(0, 12)
    expect(x.dot(z)).toBeCloseTo(0, 12)
    // Le pole reste exact ; c est le meridien qui est redresse.
    expect(y.distanceTo(pole)).toBeLessThan(1e-12)
  })

  it('normalise un pole non unitaire', () => {
    const q = setBodyOrientation(
      new THREE.Quaternion(),
      new THREE.Vector3(0, 0, 7),
      new THREE.Vector3(3, 0, 0),
    )
    expect(axis(q, new THREE.Vector3(0, 1, 0)).length()).toBeCloseTo(1, 12)
  })
})

describe('raySphereDistance', () => {
  const V = (x, y, z) => new THREE.Vector3(x, y, z)

  it('rend la distance a la surface proche, pas au centre', () => {
    const t = raySphereDistance(V(-10, 0, 0), V(1, 0, 0), V(0, 0, 0), 2)
    expect(t).toBeCloseTo(8, 12)
  })

  it('rend Infinity quand le rayon manque la sphere', () => {
    expect(raySphereDistance(V(-10, 5, 0), V(1, 0, 0), V(0, 0, 0), 2)).toBe(Infinity)
  })

  it('rend Infinity quand la sphere est derriere le rayon', () => {
    expect(raySphereDistance(V(10, 0, 0), V(1, 0, 0), V(0, 0, 0), 2)).toBe(Infinity)
  })

  it('rend Infinity depuis l interieur de la sphere', () => {
    // La racine proche est negative : on ne veut pas d un point derriere l oeil.
    expect(raySphereDistance(V(0, 0, 0), V(1, 0, 0), V(0, 0, 0), 2)).toBe(Infinity)
  })

  it('touche tangentiellement sans partir en NaN', () => {
    const t = raySphereDistance(V(-10, 2, 0), V(1, 0, 0), V(0, 0, 0), 2)
    expect(Number.isNaN(t)).toBe(false)
    expect(t).toBeCloseTo(10, 6)
  })
})

describe('eclipticAuToSceneKm', () => {
  it('convertit les au en km', () => {
    const out = eclipticAuToSceneKm(new THREE.Vector3(1, 0, 0), new THREE.Vector3())
    expect(out.x).toBeCloseTo(AU_KM, 6)
  })

  it('laisse le +X ecliptique intact, l axe etant celui de la rotation', () => {
    const out = eclipticAuToSceneKm(new THREE.Vector3(1, 0, 0), new THREE.Vector3())
    expect(out.y).toBeCloseTo(0, 6)
    expect(out.z).toBeCloseTo(0, 6)
  })

  it('incline le +Y ecliptique de l obliquite', () => {
    const out = eclipticAuToSceneKm(new THREE.Vector3(0, 1, 0), new THREE.Vector3())
    // y ecliptique -> (0, cos eps, sin eps) en equatorial, puis (x, z, -y).
    expect(out.x).toBeCloseTo(0, 6)
    expect(out.y).toBeCloseTo(AU_KM * Math.sin(OBLIQUITY_RAD), 6)
    expect(out.z).toBeCloseTo(-AU_KM * Math.cos(OBLIQUITY_RAD), 6)
  })

  it('conserve les longueurs : une rotation plus un changement d unite', () => {
    const p = new THREE.Vector3(0.3, -0.7, 0.2)
    const out = eclipticAuToSceneKm(p, new THREE.Vector3())
    expect(out.length()).toBeCloseTo(p.length() * AU_KM, 3)
  })

  it('ecrit dans la cible fournie et la rend', () => {
    const out = new THREE.Vector3()
    expect(eclipticAuToSceneKm(new THREE.Vector3(1, 1, 1), out)).toBe(out)
  })
})

describe('OBLIQUITY_RAD', () => {
  it('vaut 23,439 degres', () => {
    expect((OBLIQUITY_RAD * 180) / Math.PI).toBeCloseTo(23.439, 10)
  })
})

describe('hashToDirection', () => {
  it('rend un vecteur unitaire', () => {
    for (const id of ['2018 PL23', 'Apophis', '', '1979 XB']) {
      expect(hashToDirection(id).length()).toBeCloseTo(1, 12)
    }
  })

  it('est stable pour un meme identifiant, ce qui est tout son role', () => {
    // Elle existe pour qu un NEO ne saute pas d une direction a une autre entre
    // deux rafraichissements du feed.
    expect(hashToDirection('2018 PL23').equals(hashToDirection('2018 PL23'))).toBe(true)
  })

  it('separe des identifiants differents', () => {
    const a = hashToDirection('2015 BK509')
    const b = hashToDirection('2017 RP15')
    expect(a.distanceTo(b)).toBeGreaterThan(1e-6)
  })
})

describe('mapUShift', () => {
  // Lit le vrai buffer de SphereGeometry (pas la formule du commentaire) : pour
  // chaque sommet, la longitude est celle du point (est = vers -Z, cf. latLngToVector3)
  // et la colonne lue est celle de `u` decale. Une carte dont le bord gauche est a L
  // porte la longitude L + 360 u' en u' : le sommet doit y retrouver SA longitude.
  const geometry = new THREE.SphereGeometry(1, 72, 36)
  const position = geometry.attributes.position
  const uv = geometry.attributes.uv

  function readLongitudeError(leftEdgeLon, shift) {
    let worst = 0
    for (let i = 0; i < position.count; i++) {
      const lat = Math.asin(Math.min(1, Math.max(-1, position.getY(i))))
      if (Math.abs(lat) > 1.4) continue // pres des poles la longitude n'est plus definie
      const lon = (Math.atan2(-position.getZ(i), position.getX(i)) * 180) / Math.PI
      const read = leftEdgeLon + 360 * ((((uv.getX(i) + shift) % 1) + 1) % 1)
      const diff = Math.abs((((read - lon + 540) % 360) + 360) % 360 - 180)
      worst = Math.max(worst, diff)
    }
    return worst
  }

  it('vaut 0 pour une carte Solar System Scope (bord gauche a 180 deg) : rien a decaler', () => {
    expect(mapUShift(180)).toBeCloseTo(0, 12)
    expect(readLongitudeError(180, mapUShift(180))).toBeLessThan(1e-3) // buffers float32
  })

  it('vaut un demi-tour pour une carte USGS (bord gauche a 0 deg E), la convention Pluton/Charon', () => {
    expect(mapUShift(0)).toBeCloseTo(0.5, 12)
    expect(readLongitudeError(0, mapUShift(0))).toBeLessThan(1e-3) // buffers float32
  })

  it('sans decalage une carte USGS serait fausse de 180 deg : le cas que ce test garde', () => {
    expect(readLongitudeError(0, 0)).toBeGreaterThan(179)
  })
})
