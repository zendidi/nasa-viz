/** The "Planètes" tab of the left column: tables, orbits, legend, the pivot's moons, Venus's surface box. */

import { FOCUSES } from '../../view/focus.js'
import { escapeHtml } from '../../neo/info.js'

const PLANETS_HEADING = '<h2>Planètes</h2>'

/**
 * What the panel calls the full set: the eight planets, the Earth included
 * (always known - it is the geocentric origin, so it has no table to wait for
 * and is not in the `known/total` counters), plus Pluto, which the app treats as
 * a planet although it is a dwarf one ("on l'affiche parce qu'on l'aime bien",
 * user, 2026-10-16). Written out rather than derived from `total`: the counters
 * are 7 + Pluto = 8 bodies with a table, and that this equals "8 planets" is a
 * coincidence of the Earth being missing from them, not a relation to lean on.
 */
const PLANET_COUNT_LABEL = '8 planètes + Pluton'

/**
 * The moons line of the planets panel. Only ever shown while a planet is the
 * pivot — that is the only time any moon is fetched or drawn — and it says so
 * plainly, because a planet with none (Mercury, Venus) must not look like one
 * whose load failed.
 */
function moonsLine(moons) {
  if (!moons) return ''
  const name = FOCUSES[moons.planet].label
  if (moons.loading) return `<p class="muted">lunes de ${name}…</p>`
  // Said before "no moon": a failed load must not read as a planet that has none.
  if (moons.error) return `<p class="error">lunes de ${name} : ${escapeHtml(moons.error)}</p>`
  if (moons.known === 0) return `<p class="muted">${name} n'a pas de lune</p>`
  const plural = moons.known > 1 ? 's' : ''
  return `<p class="muted">${moons.known} lune${plural} de ${name} · positions réelles (JPL Horizons)</p>`
}

/**
 * @param {HTMLElement} section  the tab's own `<section>`, filled here
 * @param {{venusSurface: (enabled: boolean) => void}} on
 */
export function createPlanetsTab(section, on) {
  section.innerHTML = `
        ${PLANETS_HEADING}
        <p class="muted">chargement…</p>
      `

  // Same delegation for the Venus box, which lives inside renderPlanets' template.
  section.addEventListener('change', (event) => {
    if (event.target.id === 'venus-surface') on.venusSurface(event.target.checked)
  })

  /**
   * The planets are neither a feed nor a snapshot: their tables cover a year
   * and are refetched when they near their end, so there is no "maj" stamp to
   * show — only how many of the bodies with a table (seven planets and Pluto) are actually placed.
   *
   * `drawn` is false when the scene is deliberately not showing them (the
   * Earth's or a planet's view below 100 % réel; with a planet as pivot, only the others). Two words are enough: the panel must not
   * claim placed planets over an empty sky, but *why* they are hidden is
   * not news the user needs every time they move the slider — the reasoning
   * lives in docs/echelle-reelle.md.
   *
   * @param {{known: number, orbits: number, total: number, loading: boolean, loadingOrbits: boolean, error?: ?string}} state
   * @param {{label: string, color: string}[]} legend one swatch per planet
   * @param {boolean} drawn whether the current scale and pivot put them on screen
   * @param {{planet: string, known: number, loading: boolean, error?: ?string} | null} moons
   *   the centred planet's moons, or null when the pivot is not a planet
   */
  function render({ known, orbits, total, loading, loadingOrbits, error = null }, legend, drawn, moons, venus = null) {
    const swatches = legend.map((p) => `<span class="dot" style="background:${p.color}"></span>${p.label}`)
    section.innerHTML = `
      ${PLANETS_HEADING}
      <p>${
        loading
          ? `positions réelles (JPL Horizons) : ${known}/${total}…`
          : known === total
            ? `${PLANET_COUNT_LABEL} · positions réelles (JPL Horizons)`
            : `${known}/${total} placées — les autres n'ont pas répondu`
      }</p>
      ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
      ${drawn ? '' : `<p class="muted">${moons ? 'autres planètes masquées' : 'planètes masquées'}</p>`}
      <p class="muted">${
        orbits === total && !loadingOrbits
          ? 'orbites tracées (vue Soleil)'
          : `orbites : ${orbits}/${total}${loadingOrbits ? '…' : ''} (vue Soleil)`
      }</p>
      <p class="legend">${swatches.join(' &nbsp;')}</p>
      ${moonsLine(moons)}
      ${
        venus
          ? `<p class="neo-toggle"><label><input type="checkbox" id="venus-surface"${venus.surface ? ' checked' : ''}>
        Voir sous les nuages (surface radar)</label></p>`
          : ''
      }
    `
  }

  return { render }
}
