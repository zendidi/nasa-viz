/** The "ISS" tab of the left column. */

import { formatUpdatedAt } from '../format.js'

const ISS_HEADING = '<h2><span class="dot dot-iss"></span>ISS</h2>'

/** @param {HTMLElement} section  the tab's own `<section>`, filled here */
export function createIssTab(section) {
  section.innerHTML = `
        ${ISS_HEADING}
        <p class="muted">chargement…</p>
      `

  function render(position, error, fetchedAt) {
    if (error) {
      section.innerHTML = `${ISS_HEADING}<p class="error">${error}</p>`
      return
    }
    section.innerHTML = `
      ${ISS_HEADING}
      <p>lat ${position.latitude.toFixed(2)}° · lng ${position.longitude.toFixed(2)}°</p>
      <p>altitude ${position.altitude_km.toFixed(0)} km · vitesse ${position.velocity_kmh.toFixed(0)} km/h</p>
      ${formatUpdatedAt(fetchedAt)}
    `
  }

  return { render }
}
