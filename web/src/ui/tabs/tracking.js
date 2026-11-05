/**
 * The "Suivi" tab of the left column: the search field, its answers (one offer
 * or a list of candidates), and the tracked list with each object's actions.
 */

import { escapeHtml } from '../../neo/info.js'
import { MAX_TRACKED } from '../../tracking/model.js'
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
  const { kind, timeMs, distKm, previous } = item.approach
  const km = distKm === null || distKm === undefined ? '' : ` · ${Math.round(distKm).toLocaleString('fr-FR')} km`
  // 2026-11-05: the flyby may be behind the cursor (a recent one that bent the orbit); then
  // the button goes back to it. Nothing to say about it when CAD did not answer.
  let back = ''
  if (previous && kind !== 'unavailable') {
    const day = new Date(previous.timeMs).toLocaleDateString('fr-FR', { timeZone: 'UTC' })
    const prevKm =
      previous.distKm === null || previous.distKm === undefined ? '' : ` · ${Math.round(previous.distKm).toLocaleString('fr-FR')} km`
    back = `<button class="track-btn" data-approach-prev="${item.spkid}" title="Règle le curseur de la trajectoire sur le ${formatSimDate(previous.timeMs)}${prevKm}">Revoir le passage du ${day}</button>`
  }
  switch (kind) {
    case 'in_range':
      return `<button class="track-btn" data-approach="${item.spkid}" title="Règle le curseur de la trajectoire sur le ${formatSimDate(timeMs)}${km}">Aller au prochain rapprochement</button>${back}`
    case 'after_range':
      return `<span class="muted">prochain rapprochement le ${formatSimDate(timeMs)}${km}, hors de la plage de la trajectoire</span>${back}`
    case 'unavailable':
      return `<span class="muted">rapprochements indisponibles (JPL CAD n'a pas répondu)</span>`
    default:
      return back
        ? `<span class="muted">pas d'autre rapprochement prévu à moins de 0,05 ua</span>${back}`
        : '<span class="muted">aucun rapprochement connu à moins de 0,05 ua</span>'
  }
}

/**
 * The object's dot: plain in its colour, or striped for a dashed trace (2026-11-05)
 * — the pattern is in panels.css, the colour reaches it through `--dot`.
 */
function dotHtml(item) {
  return item.dashed
    ? `<span class="dot dashed" style="--dot:${item.color}" title="trait pointillé"></span>`
    : `<span class="dot" style="background:${item.color}" title="trait plein"></span>`
}

/** The playback speeds of the trajectory cursor, in T′-seconds per real second (user's call, 2026-11-05). */
const PLAY_RATES = [
  { rate: 3600, label: '1 h/s' },
  { rate: 86_400, label: '1 j/s' },
  { rate: 604_800, label: '1 sem/s' },
]
// Buttons: label, seconds.
const SHIFT_BUTTONS = [
  { seconds: -86_400, label: '−1 j' },
  { seconds: -3600, label: '−1 h' },
  { seconds: 3600, label: '+1 h' },
  { seconds: 86_400, label: '+1 j' },
]

/**
 * @param {HTMLElement} section  the tab's own `<section>`, filled here
 * @param {object} on  trackSearch, trackAdd, trackOpen, trackApproach, trackPrevApproach, trackRemove, trackRetry, trackKeep, trackShowNeo,
 *   trajDay, trajShift, trajReset, trajPlay, trajSunRetry
 */
export function createTrackingTab(section, on) {
  section.innerHTML = `
        ${TRACKING_HEADING}
        <p class="muted">Jusqu'à ${MAX_TRACKED} astéroïdes, NEO ou non. Nom, numéro, désignation provisoire ou SPK-ID.</p>
        <div id="traj-tool" class="traj-tool hidden">
          <h3>Trajectoire</h3>
          <p id="traj-sun" class="muted"></p>
          <input id="traj-slider" type="range" min="0" max="1" step="1" value="0"
                 aria-label="Date des objets suivis (de 1 an avant à 4 ans après maintenant)">
          <p class="traj-readout"><strong id="traj-offset">0</strong> <span id="traj-date" class="muted"></span></p>
          <div class="traj-buttons">
            ${SHIFT_BUTTONS.map((b) => `<button class="track-btn" data-traj-shift="${b.seconds}">${b.label}</button>`).join('')}
            <button class="track-btn" data-traj-reset="1" title="Remet les objets à l'heure de la scène">0</button>
          </div>
          <div class="traj-buttons">
            ${PLAY_RATES.map((p) => `<button class="track-btn" data-traj-play="${p.rate}" aria-pressed="false">▶ ${p.label}</button>`).join('')}
            <button class="track-btn" data-traj-play="0" title="Pause">❚❚</button>
          </div>
        </div>
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
  const tool = section.querySelector('#traj-tool')
  const toolSlider = section.querySelector('#traj-slider')
  const toolSun = section.querySelector('#traj-sun')
  const toolOffset = section.querySelector('#traj-offset')
  const toolDate = section.querySelector('#traj-date')
  const playButtons = [...section.querySelectorAll('[data-traj-play]')]
  // While the slider is held, the readout's refresh must not fight the hand.
  let sliderHeld = false
  toolSlider.addEventListener('pointerdown', () => {
    sliderHeld = true
  })
  window.addEventListener('pointerup', () => {
    sliderHeld = false
  })
  toolSlider.addEventListener('input', () => on.trajDay(Number(toolSlider.value)))
  // Arrow keys on the slider are the slider's; the global shortcuts must not see them.
  toolSlider.addEventListener('keydown', (event) => event.stopPropagation())

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
   * @param {{items: {spkid: string, name: string, neo: boolean, color: string, dashed: boolean, saved: boolean,
   *   status: 'loading'|'ready'|'error'|'missing', error: ?string,
   *   approach: ?{kind: string, timeMs?: number, distKm?: ?number, previous?: ?{timeMs: number, distKm: ?number}}}[],
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
              ${dotHtml(item)}
              <button class="track-name" data-open="${item.spkid}" title="Ouvrir la fiche">${escapeHtml(item.name)}</button>
              <span class="track-kind">${item.neo ? 'NEO' : 'astéroïde'}</span>
            </div>
            <p class="track-state">${state}</p>
            <div class="track-actions">
              ${approachHtml(item)}${retry}
              <button class="track-btn track-keep" data-keep="${item.spkid}" aria-pressed="${item.saved}"
                      title="Garder cet objet d'une session à l'autre (dans ce navigateur)">Garder</button>
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

  /**
   * The "Trajectoire" block (static markup, written to in place: the slider must
   * survive a redraw while it is being dragged). Text is only rewritten when it
   * changed — this runs four times a second.
   *
   * @param {{visible: boolean, sun: {status: string, error: ?string}, maxDay: number, day: number,
   *   offsetText: string, dateText: string, playRate: number}} state
   */
  function renderTool({ visible, sun, maxDay, day, offsetText, dateText, playRate }) {
    tool.classList.toggle('hidden', !visible)
    if (!visible) return
    const sunHtml =
      sun.status === 'error'
        ? `<span class="error">Soleil : ${escapeHtml(sun.error ?? '')}</span> <button class="track-btn" data-traj-sun-retry="1">Réessayer</button>`
        : sun.status === 'ready'
          ? ''
          : '<span class="muted">chargement de la trajectoire du Soleil (JPL Horizons)…</span>'
    if (toolSun.dataset.html !== sunHtml) {
      toolSun.dataset.html = sunHtml
      toolSun.innerHTML = sunHtml
    }
    toolSlider.disabled = sun.status !== 'ready'
    if (toolSlider.max !== String(maxDay)) toolSlider.max = String(maxDay)
    if (!sliderHeld && toolSlider.value !== String(day)) toolSlider.value = String(day)
    if (toolOffset.textContent !== offsetText) toolOffset.textContent = offsetText
    if (toolDate.textContent !== dateText) toolDate.textContent = dateText
    for (const button of playButtons) {
      const pressed = Number(button.dataset.trajPlay) === playRate && playRate !== 0
      if (button.getAttribute('aria-pressed') !== String(pressed)) button.setAttribute('aria-pressed', String(pressed))
    }
  }

  // Delegated and bound once: everything inside #track-list is rebuilt per render.
  section.addEventListener('click', (event) => {
    const button = event.target.closest('button')
    if (!button) return
    const { open, approach, approachPrev, remove, retry, candidate, offer, keep, trajShift, trajReset, trajPlay, trajSunRetry } = button.dataset
    if (trajShift) on.trajShift(Number(trajShift))
    else if (trajReset) on.trajReset()
    else if (trajPlay !== undefined) on.trajPlay(Number(trajPlay))
    else if (trajSunRetry) on.trajSunRetry()
    else if (offer) {
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
    else if (approachPrev) on.trackPrevApproach(approachPrev)
    else if (keep) on.trackKeep(keep, button.getAttribute('aria-pressed') !== 'true')
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

  return { render, renderTool }
}
