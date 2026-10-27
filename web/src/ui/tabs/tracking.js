/**
 * The "Suivi" tab of the left column: the search field, its answers (one offer
 * or a list of candidates), and the tracked list with each object's actions.
 */

import { escapeHtml } from '../../neoInfo.js'
import { MAX_TRACKED } from '../../tracking.js'
import { formatSimDate } from '../format.js'

const TRACK_PLACEHOLDER = 'Apophis, 433, 2004 MN4, 20099942…'
const TRACKING_HEADING = "<h2>Suivi d'astéroïdes</h2>"

const TRACK_STATE_TEXT = {
  loading: '<span class="muted">chargement de la table (JPL Horizons)…</span>',
  ready: '<span class="muted">prêt</span>',
  missing: '<span class="error">plus reconnu par JPL</span>',
}

/** What the list says about a NEO's next close approach; a non-NEO has none to say. */
function approachHtml(item) {
  if (!item.neo || item.status !== 'ready' || !item.approach) return ''
  const { kind, timeMs, distKm } = item.approach
  const km = distKm === null || distKm === undefined ? '' : ` · ${Math.round(distKm).toLocaleString('fr-FR')} km`
  switch (kind) {
    case 'in_window':
      return `<button class="track-btn" data-approach="${item.spkid}" title="${formatSimDate(timeMs)}${km}">Aller au prochain rapprochement</button>`
    case 'after_window':
      return `<span class="muted">prochain rapprochement le ${formatSimDate(timeMs)}${km}, hors de la plage de l'horloge</span>`
    case 'unavailable':
      return `<span class="muted">rapprochements indisponibles (JPL CAD n'a pas répondu)</span>`
    default:
      return '<span class="muted">aucun rapprochement connu à moins de 0,05 ua</span>'
  }
}

/**
 * @param {HTMLElement} section  the tab's own `<section>`, filled here
 * @param {object} on  trackSearch, trackAdd, trackOpen, trackApproach, trackRemove, trackRetry, trackShowNeo
 */
export function createTrackingTab(section, on) {
  section.innerHTML = `
        ${TRACKING_HEADING}
        <p class="muted">Jusqu'à ${MAX_TRACKED} astéroïdes, NEO ou non. Nom, numéro, désignation provisoire ou SPK-ID.</p>
        <div class="track-search">
          <input id="track-input" type="text" maxlength="40" autocomplete="off" spellcheck="false"
                 placeholder="${TRACK_PLACEHOLDER}" aria-label="Rechercher un astéroïde">
          <button id="track-search-btn" class="track-btn">Suivre</button>
        </div>
        <p id="track-message" class="muted"></p>
        <ul id="track-candidates"></ul>
        <div id="track-list"></div>
      `

  const trackInput = section.querySelector('#track-input')
  const trackSearchBtn = section.querySelector('#track-search-btn')
  const trackMessage = section.querySelector('#track-message')
  const trackCandidates = section.querySelector('#track-candidates')
  const trackList = section.querySelector('#track-list')

  // Purely of the overlay: whether a search is running and whether the list is full.
  let trackBusy = false
  let trackFull = false
  let offered = null // the single search result awaiting a click on "Suivre"

  function setTrackMessage(text, kind = 'muted') {
    trackMessage.className = kind
    trackMessage.textContent = text
  }

  function syncTrackControls() {
    trackInput.disabled = trackFull
    trackSearchBtn.disabled = trackFull || trackBusy
    trackInput.placeholder = trackFull ? `${MAX_TRACKED} objets au plus` : TRACK_PLACEHOLDER
  }

  /**
   * Runs one search through the scene (`on.trackSearch`, which also adds the
   * object when the answer is unambiguous) and says what came of it. An
   * ambiguous answer becomes a clickable list: a click is a new search on that
   * entry's own designation, which resolves to exactly one match.
   */
  async function runTrackSearch(query, opts) {
    const q = query.trim().replace(/\s+/g, ' ')
    if (q === '' || trackBusy || trackFull) return
    trackBusy = true
    offered = null
    trackCandidates.replaceChildren()
    setTrackMessage('recherche…')
    syncTrackControls()
    let result
    try {
      result = await on.trackSearch(q, opts)
    } catch (err) {
      result = { kind: 'error', message: err.message }
    }
    trackBusy = false
    syncTrackControls()
    switch (result.kind) {
      case 'added':
        trackInput.value = ''
        setTrackMessage('')
        break
      case 'duplicate':
        setTrackMessage(`${result.name} est déjà suivi.`)
        break
      case 'full':
        setTrackMessage(`${MAX_TRACKED} objets au plus : retirez-en un d'abord.`, 'error')
        break
      case 'match': {
        // Offered, not added: the user confirms with the button.
        offered = result.record
        const label = result.state === 'duplicate' ? 'déjà suivi' : result.state === 'full' ? `${MAX_TRACKED} objets au plus` : 'Suivre'
        setTrackMessage(result.help ?? '1 résultat :')
        trackCandidates.innerHTML = `<li class="track-offer"><span class="track-offer-name">${escapeHtml(result.record.fullname)}</span>
          <span class="track-kind">${result.record.neo ? 'NEO' : 'astéroïde'}</span>
          <button class="track-btn" data-offer="1"${result.state === 'ok' ? '' : ' disabled'}>${label}</button></li>`
        break
      }
      case 'candidates': {
        const more = result.count > result.candidates.length
        setTrackMessage(
          more
            ? `${result.count} résultats, affinez (les ${result.candidates.length} premiers) :`
            : `${result.count} résultat${result.count > 1 ? 's' : ''}, cliquez pour choisir :`,
        )
        trackCandidates.innerHTML = result.candidates
          .map((c) => `<li><button data-candidate="${escapeHtml(c.pdes)}">${escapeHtml(c.name || c.pdes)}</button></li>`)
          .join('')
        break
      }
      case 'comet':
        setTrackMessage(`${result.fullname ?? q} : comète, pas encore prise en charge.`)
        break
      case 'none':
        setTrackMessage(`« ${q} » : introuvable.`)
        break
      default:
        setTrackMessage(result.message, 'error')
    }
  }

  trackInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') runTrackSearch(trackInput.value)
    // Typing must not reach the global shortcuts (R recentres, Escape deselects).
    event.stopPropagation()
  })
  trackSearchBtn.addEventListener('click', () => runTrackSearch(trackInput.value))

  /**
   * The tracked list, redrawn whole on every change (the search field above it
   * is static markup and survives). `showNeo` is re-stated from the scene's own
   * state each time, never read back from the DOM.
   *
   * @param {{items: {spkid: string, name: string, neo: boolean, color: string,
   *   status: 'loading'|'ready'|'error'|'missing', error: ?string,
   *   approach: ?{kind: string, timeMs?: number, distKm?: ?number}}[],
   *   full: boolean, showNeo: boolean}} state
   */
  function render({ items, full, showNeo }) {
    trackFull = full
    syncTrackControls()
    if (items.length === 0) {
      trackList.innerHTML = '<p class="muted">Aucun objet suivi : les NEO de la semaine restent affichés.</p>'
      return
    }
    const rows = items
      .map((item) => {
        const state =
          item.status === 'error' ? `<span class="error">${escapeHtml(item.error ?? '')}</span>` : TRACK_STATE_TEXT[item.status]
        const retry =
          item.status === 'error' || item.status === 'missing'
            ? `<button class="track-btn" data-retry="${item.spkid}">Réessayer</button>`
            : ''
        return `
          <li class="track-item">
            <div class="track-head">
              <span class="dot" style="background:${item.color}"></span>
              <button class="track-name" data-open="${item.spkid}" title="Ouvrir la fiche">${escapeHtml(item.name)}</button>
              <span class="track-kind">${item.neo ? 'NEO' : 'astéroïde'}</span>
            </div>
            <p class="track-state">${state}</p>
            <div class="track-actions">
              ${approachHtml(item)}${retry}
              <button class="track-btn" data-remove="${item.spkid}">Retirer</button>
            </div>
          </li>`
      })
      .join('')
    trackList.innerHTML = `
      ${full ? `<p class="muted">${MAX_TRACKED} objets au plus.</p>` : ''}
      <ul>${rows}</ul>
      <p class="neo-toggle"><label><input type="checkbox" id="tracking-show-neo"${showNeo ? ' checked' : ''}>
        Afficher les NEO de la semaine</label></p>`
  }

  // Delegated and bound once: everything inside #track-list is rebuilt per render.
  section.addEventListener('click', (event) => {
    const button = event.target.closest('button')
    if (!button) return
    const { open, approach, remove, retry, candidate, offer } = button.dataset
    if (offer) {
      if (!offered) return
      const result = on.trackAdd(offered)
      offered = null
      trackCandidates.replaceChildren()
      if (result.kind === 'added') {
        trackInput.value = ''
        setTrackMessage('')
      } else {
        setTrackMessage(
          result.kind === 'full' ? `${MAX_TRACKED} objets au plus : retirez-en un d'abord.` : `${result.name} est déjà suivi.`,
          result.kind === 'full' ? 'error' : 'muted',
        )
      }
    } else if (open) on.trackOpen(open)
    else if (approach) on.trackApproach(approach)
    else if (remove) on.trackRemove(remove)
    else if (retry) on.trackRetry(retry)
    else if (candidate) {
      trackInput.value = candidate
      runTrackSearch(candidate, { direct: true })
    }
  })
  section.addEventListener('change', (event) => {
    if (event.target.id === 'tracking-show-neo') on.trackShowNeo(event.target.checked)
  })

  return { render }
}
