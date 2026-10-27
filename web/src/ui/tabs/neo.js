/**
 * The "NEO" tab of the left column: the week's feed, its sources, the real
 * positions counter, the points and all-orbits boxes, the colour legend.
 */

import { sourcesPanelHtml } from '../../neoInfo.js'
import { formatUpdatedAt } from '../format.js'

const NEO_HEADING = '<h2>Astéroïdes proches (NEO)</h2>'

/**
 * The "toutes les orbites" box. Three things about it:
 *
 * - it is **inside** the template, like `#neo-positions-status` and for the
 *   same reason: `renderNeo` replaces the panel's whole `innerHTML`, so an
 *   element appended next to it would be wiped on the next feed or sheet
 *   (docs/agent/gotchas.md);
 * - which means its `checked` must be re-stated from the scene's own state on
 *   every render, never read back from the DOM;
 * - and its listener is delegated from the panel once (see below), because
 *   the input this markup creates is a new element each time.
 */
function allOrbitsLine({ points = true, enabled, available, total, scaleLocked } = {}) {
  if (!total) return ''
  const count = available === total ? `${total}` : `${available}/${total}`
  // Disabled, not unticked: the user's choice is kept and comes back with
  // the points, or at 100 % réel.
  const locked = !points || scaleLocked
  const hint = !points
    ? 'masquées avec les points'
    : scaleLocked
      ? 'Orbites visibles en échelle réelle (Maj + molette)'
      : 'vue héliocentrée, échelle réelle'
  return `
      <p class="neo-toggle">
        <label><input type="checkbox" id="neo-points"${points ? ' checked' : ''}>
        Points dans la scène</label>
      </p>
      <p class="neo-toggle sub">
        <label><input type="checkbox" id="neo-all-orbits"${enabled ? ' checked' : ''}${locked ? ' disabled' : ''}>
        Orbites de tous les NEO (${count})</label>
        <span class="muted">${hint}</span>
      </p>
    `
}

/**
 * @param {HTMLElement} section  the tab's own `<section>`, filled here
 * @param {{allOrbits: (enabled: boolean) => void, points: (enabled: boolean) => void}} on
 */
export function createNeoTab(section, on) {
  section.innerHTML = `
        ${NEO_HEADING}
        <p class="muted">chargement…</p>
      `

  /** @param {{color: string, label: string}[]} legend one swatch per colour in play */
  function render(feed, error, fetchedAt, legend = [], allOrbits = undefined) {
    if (error) {
      section.innerHTML = `${NEO_HEADING}<p class="error">${error}</p>`
      return
    }
    const hazardous = feed.objects.filter((o) => o.is_potentially_hazardous).length
    const swatches = legend.map((s) => `<span class="dot" style="background:${s.color}"></span>${s.label}`)
    // #neo-positions-status lives inside the template on purpose: this
    // innerHTML replace would wipe it otherwise (docs/agent/gotchas.md).
    section.innerHTML = `
      ${NEO_HEADING}
      <p>${feed.count} objets (${feed.start_date} → ${feed.end_date}) · clic sur un point pour le détail</p>
      <p>${hazardous} potentiellement dangereux</p>
      ${sourcesPanelHtml(feed)}
      <p id="neo-positions-status" class="muted"></p>
      ${allOrbitsLine(allOrbits)}
      <p class="legend">${swatches.join(' &nbsp;')}</p>
      ${formatUpdatedAt(fetchedAt, { withDate: true })}
    `
    renderPositions()
  }

  // Delegated, and bound once: the checkbox itself is recreated by every
  // renderNeo(), so a listener on the input would die with the first redraw.
  section.addEventListener('change', (event) => {
    if (event.target.id === 'neo-all-orbits') on.allOrbits(event.target.checked)
    if (event.target.id === 'neo-points') on.points(event.target.checked)
  })

  let positions = { known: 0, total: 0, loading: false }

  /** Called with a state to update it, without one to redraw it after renderNeo(). */
  function renderPositions(state) {
    if (state) positions = state
    const el = section.querySelector('#neo-positions-status')
    if (!el) return
    const { known, total, loading } = positions
    if (total === 0) {
      el.textContent = ''
    } else if (loading) {
      el.textContent = `positions réelles (JPL Horizons) : ${known}/${total}…`
    } else {
      el.textContent =
        known === total
          ? 'positions réelles (JPL Horizons)'
          : `positions réelles (JPL Horizons) : ${known}/${total} — les autres sont approximatives`
    }
  }

  return { render, renderPositions }
}
