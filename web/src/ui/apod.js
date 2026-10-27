/** The APOD panel (under the left column) and its full-size modal. */

import { formatUpdatedAt } from './format.js'

const APOD_HEADING = '<h2>Image du jour (APOD)</h2>'

/**
 * @param {HTMLElement} section  the panel's own `<section>`, filled here
 * @param {{open: (title: string, bodyHtml: string) => void}} modal  ui/modal.js
 */
export function createApodPanel(section, modal) {
  section.innerHTML = `
      ${APOD_HEADING}
      <p class="muted">chargement…</p>
    `

  let currentApod = null

  function render(apod, error, fetchedAt) {
    currentApod = error ? null : apod
    if (error) {
      section.innerHTML = `${APOD_HEADING}<p class="error">${error}</p>`
      return
    }
    const preview =
      apod.media_type === 'video'
        ? '<p>🎥 Vidéo du jour</p>'
        : `<img src="${apod.url}" alt="${apod.title}">`
    section.innerHTML = `
      ${APOD_HEADING}
      <p class="apod-title">${apod.title}</p>
      ${preview}
      ${formatUpdatedAt(fetchedAt, { withDate: true })}
    `
  }

  function showModal(apod) {
    const media =
      apod.media_type === 'video'
        ? `<iframe src="${apod.url}" allowfullscreen></iframe>`
        : `<img src="${apod.url}" alt="${apod.title}">`
    modal.open(
      apod.title,
      `
      ${media}
      <p class="muted">${apod.date}</p>
      <p>${apod.explanation}</p>
      ${apod.hd_url ? `<p><a href="${apod.hd_url}" target="_blank" rel="noopener" style="color:#7fe0ff">Voir en haute résolution</a></p>` : ''}
    `,
    )
  }

  section.addEventListener('click', () => {
    if (currentApod) showModal(currentApod)
  })

  return { render }
}
