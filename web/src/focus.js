/**
 * Which body the scene is centred on — the "pivot". It is the scene's origin:
 * every body is placed at `position(body) − position(pivot)`, compressed by the
 * pivot's own readable curve (see scale.js and docs/points-de-vue.md).
 *
 * Adding a body here is meant to be cheap: give it a label, a readable curve,
 * the reference circles that make sense around it, and teach main.js where it
 * is (geocentric km, scene axes). The Moon and the planets are the obvious
 * next ones — they only need a position source.
 *
 * Pure data + math, no Three.js.
 */

import { AU_KM, EARTH_CURVE, LUNAR_DISTANCE_KM, SUN_CURVE } from './scale.js'

const lunarRing = (count, label) => ({ km: count * LUNAR_DISTANCE_KM, label })
const auRing = (au) => ({ km: au * AU_KM, label: `${au.toLocaleString('fr-FR')} ua` })

/**
 * @typedef {{
 *   id: string, label: string, frame: string, curve: object,
 *   rings: {km: number, label: string}[],
 *   reference: {label: string, km: number} | null,
 * }} Focus
 *
 * `reference` is the yardstick the scale label quotes ("Lune ÷12"): its
 * distance is only known at runtime, so `km` here is just a default.
 */

/** @type {Record<string, Focus>} */
export const FOCUSES = {
  earth: {
    id: 'earth',
    label: 'Terre',
    frame: 'géocentré',
    curve: EARTH_CURVE,
    // No 1 LD circle: the Moon's real orbit is drawn there instead, and unlike
    // a fixed circle it actually passes through the Moon (it swings 5 % between
    // perigee and apogee and rides 5° off the ecliptic).
    rings: [lunarRing(10, '10 distances lunaires'), lunarRing(100, '100 distances lunaires')],
    reference: { label: 'Lune', km: LUNAR_DISTANCE_KM },
  },
  sun: {
    id: 'sun',
    label: 'Soleil',
    frame: 'héliocentré',
    curve: SUN_CURVE,
    // No 1 ua circle: the Earth's own orbit is drawn there whenever a NEO is
    // selected, and two lines a percent apart just read as one fat one.
    rings: [auRing(0.5), auRing(2), auRing(5)],
    reference: { label: 'Terre', km: AU_KM },
  },
}

/** Order shown in the "Point de vue" panel. */
export const FOCUS_IDS = ['earth', 'sun']
