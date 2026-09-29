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

import { AU_KM, EARTH_CURVE, LUNAR_DISTANCE_KM, SUN_CURVE, orbitingCurve } from './scale.js'

const lunarRing = (count, label) => ({ km: count * LUNAR_DISTANCE_KM, label })
const auRing = (au) => ({ km: au * AU_KM, label: `${au.toLocaleString('fr-FR')} ua` })

/**
 * Same circle, for a distance that falls out of a computation instead of being
 * chosen: 0,19355 au reads as noise, so it is rounded to two significant
 * digits. These rings are a yardstick for the eye, not a measurement.
 */
const scaledRing = (au) => ({
  km: au * AU_KM,
  label: `${au.toLocaleString('fr-FR', { maximumSignificantDigits: 2 })} ua`,
})

/**
 * @typedef {{
 *   id: string, label: string, frame: string, curve: object,
 *   group: 'frame' | 'planet',
 *   rings: {km: number, label: string}[],
 *   reference: {label: string, km: number} | null,
 * }} Focus
 *
 * `reference` is the yardstick the scale label quotes ("Lune ÷12"): its
 * distance is only known at runtime, so `km` here is just a default.
 *
 * `group` is for the panel only: a 'frame' pivot is a frame of reference and is
 * always available; a 'planet' pivot needs a position table to have landed
 * first — main.js refuses the switch until it has.
 */

/** @type {Record<string, Focus>} */
export const FOCUSES = {
  earth: {
    id: 'earth',
    label: 'Terre',
    frame: 'géocentré',
    group: 'frame',
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
    group: 'frame',
    curve: SUN_CURVE,
    // No 1 ua circle: the Earth's own orbit is drawn there whenever a NEO is
    // selected, and two lines a percent apart just read as one fat one.
    rings: [auRing(0.5), auRing(2), auRing(5)],
    reference: { label: 'Terre', km: AU_KM },
  },
}

/**
 * Semi-major axis in au, per planet — the yardstick its readable curve and its
 * reference circles are built from (`orbitingCurve` in scale.js).
 *
 * Kept as a constant here rather than fetched, deliberately: the curve decides
 * where *every* body in the scene is drawn, so it has to exist before any
 * Horizons table lands. Deriving it from a loaded position would make the whole
 * geometry jump the moment a table arrived, and deriving it from the planet's
 * *current* distance would make it wobble with eccentricity.
 *
 * Cross-checked against the sidereal periods the backend already holds
 * (`SolarSystemClient::BODIES`) through Kepler's third law in its exact form,
 * `a³ / P² = (M☉ + m) / M☉` — worst residual 4 · 10⁻⁴ au on Uranus, i.e. two
 * parts in 100 000. The planet's own mass is not optional in that check: drop
 * it and Jupiter comes out at 5,2012 instead of 5,2028, an error 20 times the
 * residual and the largest of the seven. So the two tables cannot drift apart
 * silently — if a period ever changes, this is where to look.
 */
const PLANET_AU = {
  mercury: 0.3871,
  venus: 0.7233,
  mars: 1.5237,
  jupiter: 5.2028,
  saturn: 9.5388,
  uranus: 19.1819,
  neptune: 30.058,
}

/** French labels, in the order the backend lists them (outward from the Sun). */
const PLANET_LABELS = {
  mercury: 'Mercure',
  venus: 'Vénus',
  mars: 'Mars',
  jupiter: 'Jupiter',
  saturn: 'Saturne',
  uranus: 'Uranus',
  neptune: 'Neptune',
}

export const PLANET_FOCUS_IDS = Object.keys(PLANET_AU)

for (const id of PLANET_FOCUS_IDS) {
  const au = PLANET_AU[id]
  FOCUSES[id] = {
    id,
    label: PLANET_LABELS[id],
    frame: `centré sur ${PLANET_LABELS[id]}`,
    group: 'planet',
    curve: orbitingCurve(au * AU_KM),
    // Three circles scaled to this planet's own orbit, plus one at an absolute
    // 1 ua. The scaled ones are what makes the view readable — they land at the
    // same screen radius (9,63 / 19,49 / 26,00) whichever planet is the pivot,
    // the same invariant as the curve. But that is exactly why they cannot show
    // that Neptune's system is 78 times Mercury's: identical picture everywhere.
    //
    // The 1 ua circle is the fixed yardstick that can. Measured at slider step 1
    // (rings are hidden at step 0): 56 units around Mercury, 33 around Mars,
    // 11 around the four giants — it visibly collapses onto the planet as you
    // move outward. Known limit, accepted 2026-09-29: from Jupiter out it is
    // clamped by the curve's own floor, so the four giants look alike. That is
    // not the floor being crude — `6 + 16,37·log10(d / 0,3a)` is already
    // *negative* at 1 ua for Saturn and beyond; the curve has no room left to
    // represent it, and no floor setting would change that.
    //
    // At 100 % réel it stops being compressed at all and reads 46 962 units for
    // every pivot — which is the point of an absolute ring.
    rings: [
      { km: AU_KM, label: '1 ua (Terre)', absolute: true },
      scaledRing(0.5 * au),
      scaledRing(2 * au),
      scaledRing(5 * au),
    ],
    reference: { label: 'Soleil', km: au * AU_KM },
  }
}

/**
 * Order shown in the "Point de vue" panel: the two frames of reference first,
 * then the planets outward from the Sun.
 */
export const FOCUS_IDS = ['earth', 'sun', ...PLANET_FOCUS_IDS]
