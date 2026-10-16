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

import { AU_KM, EARTH_CURVE, LUNAR_DISTANCE_KM, SUN_CURVE, isRealScale, moonSystemCurve, orbitingCurve } from './scale.js'

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
    // No 1 ua circle: the Earth's own orbit is drawn here, and two lines a
    // percent apart just read as one fat one.
    //
    // The planets keep theirs even though that orbit now draws from their
    // pivots too (2026-10-12), because the two don't collide there: a planet's
    // ring is centred on the planet, the Earth's orbit on the Sun, so from
    // Jupiter they are two plainly different circles. Only here do they
    // coincide, and only here is the ring therefore dropped.
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
  // Dwarf planet shown as a planet (user's call, 2026-10-16). Mean a, not the
  // current distance (29,7 to 49,3 au, e = 0,25) - see the note above.
  pluto: 39.48,
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
  pluto: 'Pluton',
}

/**
 * Orbital radius, in km, of each planet's **largest** moon — the anchor its
 * readable curve is pinned to (`moonSystemCurve`, scale.js), which lands it at
 * 12 units exactly as the Earth's own Moon has always been.
 *
 * The largest and not the innermost: it is the moon the view is really about,
 * and the choice sets the slope for the whole system. Mercury and Venus are
 * absent because they have none — they keep `orbitingCurve`, which is honest:
 * with no inner scale to span, there is nothing for a two-anchor curve to do.
 *
 * Here rather than fetched, for the same reason as `PLANET_AU`: the curve
 * decides where everything in the scene is drawn, so it must exist before any
 * Horizons table lands. Mean orbital radii, cross-checked against the backend's
 * own moon catalogue (`MoonClient::MOONS`) which carries the same figures.
 */
const PLANET_MOON_ANCHOR = {
  mars: 9376, // Phobos
  jupiter: 1_070_400, // Ganymède
  saturn: 1_221_870, // Titan
  uranus: 436_300, // Titania
  neptune: 354_759, // Triton
  pluto: 19_591, // Charon
}

/**
 * Reference circles around a planet that has moons. The heliocentric set the
 * lot 3 used (0,5 a / 2 a / 5 a) no longer works here and the measurement says
 * why: under `moonSystemCurve` those three land at 20,1 / 22,0 / 23,3 around
 * Jupiter — bunched in two units just outside the Sun, and overlapping the 1 ua
 * circle. The curve now spends most of its range on the moon system, so the
 * rings have to follow it there.
 *
 * Two circles bracketing the anchor moon (0,3x and 3x its distance, so never on
 * top of a moon), measured at 10,3–10,9 and 13,0–13,5 across the five planets,
 * against moons spread over 9,6 to 16,2. Plus the absolute 1 ua kept from
 * lot 3 — and it works better here than it did there: 20,67 around Mars, 18,79
 * around Jupiter, 17,79 around Neptune. Monotone, and **no floor saturation at
 * all**, which is exactly the limit that was documented as accepted on
 * 2026-09-29. The new curve lifted it.
 */
const moonRing = (km) => ({
  km: Math.round(km),
  label: `${Math.round(km).toLocaleString('fr-FR', { maximumSignificantDigits: 2 })} km`,
})

export const PLANET_FOCUS_IDS = Object.keys(PLANET_AU)

for (const id of PLANET_FOCUS_IDS) {
  const au = PLANET_AU[id]
  const anchorKm = PLANET_MOON_ANCHOR[id]
  FOCUSES[id] = {
    id,
    label: PLANET_LABELS[id],
    frame: `centré sur ${PLANET_LABELS[id]}`,
    group: 'planet',
    // A planet with moons has to show two worlds four to five decades apart;
    // one without has only the solar system to show.
    curve: anchorKm ? moonSystemCurve(anchorKm, au * AU_KM) : orbitingCurve(au * AU_KM),
    // With moons, the rings follow the curve into the moon system (see
    // `moonRing`); without, the heliocentric set of lot 3 still applies. The
    // absolute 1 ua circle is in both: it is the only thing on screen that says
    // one system is bigger than another, all the scaled ones being pinned to
    // land in the same place whichever pivot you choose.
    rings: anchorKm
      ? [{ km: AU_KM, label: '1 ua (Terre)', absolute: true }, moonRing(0.3 * anchorKm), moonRing(3 * anchorKm)]
      : [
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

/**
 * Whether this point of view hides the planets (and every planetary orbit line)
 * below 100 % réel. Every pivot but the Sun: the Earth since 2026-09-29, and the
 * planets themselves since 2026-10-16 (user's call, replacing "centred on Mars
 * the scene draws the planets at every scale") — the compressed curves of a
 * pivot-centred view interleave the planets with the NEOs. The Sun's view keeps
 * them at every scale (`SUN_CURVE` is built for that range). The pivot planet
 * itself is never hidden: planets.js exempts it, this only says "the others".
 *
 * @param {string} focusId
 */
export function hidesPlanets(focusId) {
  return focusId !== 'sun'
}

/**
 * Whether the NEO ellipses (the selected one's and the opt-in bundle) are drawn.
 * Sun pivot at 100 % réel only: the scale curve compresses distance from the
 * pivot non-linearly, so below 1 it bends an ellipse's shape and a hundred and
 * fifty of them pile up, which is not reliable to read. The week trajectory is
 * not subject to this: it goes through the same mapping as the NEO's own dot.
 */
export function neoEllipsesVisible(focusId, t) {
  return focusId === 'sun' && isRealScale(t)
}
