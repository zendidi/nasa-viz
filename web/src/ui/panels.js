/**
 * The HTML overlay: the side panels (ISS, NEO, APOD), the bottom bar (scale and
 * point of view), the NEO detail panel, the modal and the two tooltips. Markup, wording and DOM
 * events — **no Three.js, no scene state**.
 *
 * Everything shown arrives as an argument, everything the user does leaves
 * through `on`: the scene's own state (scaleStep, focusId, neoEntries…) stays
 * in main.js. The one exception is state that is purely of the overlay — the
 * APOD currently on show, the NEO-positions counter — which lives here.
 *
 * This file is the assembly: the header, the left column and its tabs, and the
 * Escape key that arbitrates between the modal, the detail panel and the scene.
 * Each part lives in its own module (ui/tabs/*, ui/apod.js, ui/bottomBar.js,
 * ui/modal.js, ui/tooltips.js); what they return is handed back unchanged.
 */

import { createApodPanel } from './apod.js'
import { createBottomBar } from './bottomBar.js'
import { createDetailPanel, createModal } from './modal.js'
import { createIssTab } from './tabs/iss.js'
import { createNeoTab } from './tabs/neo.js'
import { createPlanetsTab } from './tabs/planets.js'
import { createTrackingTab } from './tabs/tracking.js'
import { createTooltips } from './tooltips.js'
import './panels.css'

/** The left column's four tabs, one section each (2026-10-27; "Suivi" added the same day). */
const INFO_TABS = [
  { id: 'iss', label: 'ISS' },
  { id: 'neo', label: 'NEO' },
  { id: 'planets', label: 'Planètes' },
  { id: 'tracking', label: 'Suivi' },
]

/**
 * Builds the overlay, wires its events, and returns what the scene needs back:
 * the render entry points, the modal, and the three containers later modules
 * draw into (scene labels, star and constellation tooltips).
 *
 * @param {object}      options
 * @param {HTMLElement} options.app         where the overlay is appended
 * @param {HTMLElement} options.wheelTarget the canvas — Shift+wheel is only a
 *                                          scale step when it happens over it
 * @param {object}      options.on          update, scaleStep, scaleStepBy,
 *                                          focus, recenter, deselect, modalClosed,
 *                                          allOrbits, points, venusSurface, moonsShown, rings, ecliptic,
 *                                          timeRate, timeReset, trackSearch, trackOpen,
 *                                          trackApproach, trackPrevApproach, trackRemove, trackRetry,
 *                                          trackKeep, trackShowNeo, trajDay, trajShift, trajReset, trajPlay,
 *                                          trajSunRetry, detailAction
 */
export function createPanels({ app, wheelTarget, on }) {
  const ui = document.createElement('div')
  ui.id = 'ui'
  ui.innerHTML = `
    <div id="ui-header">
      <h1>NASA Viz</h1>
      <button id="update-btn">Mettre à jour</button>
      <span id="usage-badge" class="muted" title="Requêtes envoyées à api.nasa.gov (NeoWs + APOD) depuis minuit UTC — les autres sources (JPL, ESA, IMCCE, ISS) sont sans quota">…</span>
      <button id="ui-style-btn" class="header-toggle" title="Panneau encadré, ou texte brut posé sur la scène">Panneau</button>
      <button id="apod-btn" class="header-toggle" aria-pressed="true" title="Afficher ou masquer l'image du jour, pour dégager la vue">APOD</button>
      <button id="scale-btn" class="header-toggle" aria-pressed="true" title="Afficher ou masquer le panneau échelle et temps — le masquer remet l'heure réelle">Échelle et temps</button>
    </div>
    <div id="info-panel">
      <div id="info-tabs" role="tablist">
        ${INFO_TABS.map((tab) => `<button class="info-tab" role="tab" data-tab="${tab.id}">${tab.label}</button>`).join('')}
      </div>
      <section id="iss-panel"></section>
      <section id="neo-panel"></section>
      <section id="planets-panel"></section>
      <section id="tracking-panel"></section>
    </div>
    <section id="apod-panel"></section>
  `
  app.appendChild(ui)

  // Each tab fills its own section (initial markup included) and wires its own
  // delegated listeners.
  const issTab = createIssTab(ui.querySelector('#iss-panel'))
  const neoTab = createNeoTab(ui.querySelector('#neo-panel'), on)
  const planetsTab = createPlanetsTab(ui.querySelector('#planets-panel'), on)
  const trackingTab = createTrackingTab(ui.querySelector('#tracking-panel'), on)

  const bottomBar = createBottomBar(app, wheelTarget, on)

  const sceneLabels = document.createElement('div')
  sceneLabels.id = 'scene-labels'
  app.appendChild(sceneLabels)

  const modal = createModal()
  const detail = createDetailPanel(on)
  const apod = createApodPanel(ui.querySelector('#apod-panel'), modal)
  const tooltips = createTooltips()

  // Card or raw text: a per-viewer preference, so localStorage — read and
  // written under try/catch, since private windows can refuse it outright.
  const infoPanel = ui.querySelector('#info-panel')
  const styleBtn = ui.querySelector('#ui-style-btn')
  function setInfoStyle(card) {
    infoPanel.classList.toggle('card', card)
    styleBtn.setAttribute('aria-pressed', String(card))
    try {
      localStorage.setItem('ui-style', card ? 'card' : 'raw')
    } catch {
      // not remembered, still applied
    }
  }
  let savedStyle = null
  try {
    savedStyle = localStorage.getItem('ui-style')
  } catch {
    // default below
  }
  setInfoStyle(savedStyle !== 'raw')
  styleBtn.addEventListener('click', () => setInfoStyle(!infoPanel.classList.contains('card')))

  // APOD is shown at every start — not remembered — and can be put away for a
  // wider view of the scene.
  const apodBtn = ui.querySelector('#apod-btn')
  apodBtn.addEventListener('click', () => {
    const shown = ui.querySelector('#apod-panel').classList.toggle('hidden') === false
    apodBtn.setAttribute('aria-pressed', String(shown))
  })

  // The scale-and-time panel is shown at every start (not remembered). Putting
  // it away also puts the clock back on the real time: a hidden panel must not
  // leave a simulated date running with no control in sight.
  const scaleBtn = ui.querySelector('#scale-btn')
  scaleBtn.addEventListener('click', () => {
    const shown = bottomBar.scalePanel.classList.toggle('hidden') === false
    scaleBtn.setAttribute('aria-pressed', String(shown))
    if (!shown) on.timeReset()
  })

  // Left column tabs: which one is open is a per-viewer preference, remembered
  // like the card style, and read under try/catch for the same reason.
  const tabSections = {
    iss: ui.querySelector('#iss-panel'),
    neo: ui.querySelector('#neo-panel'),
    planets: ui.querySelector('#planets-panel'),
    tracking: ui.querySelector('#tracking-panel'),
  }
  function setInfoTab(id) {
    for (const [tabId, section] of Object.entries(tabSections)) section.classList.toggle('hidden', tabId !== id)
    for (const button of ui.querySelectorAll('.info-tab')) {
      button.setAttribute('aria-selected', String(button.dataset.tab === id))
    }
    try {
      localStorage.setItem('ui-tab', id)
    } catch {
      // not remembered, still applied
    }
  }
  let savedTab = null
  try {
    savedTab = localStorage.getItem('ui-tab')
  } catch {
    // default below
  }
  setInfoTab(tabSections[savedTab] ? savedTab : 'neo')
  for (const button of ui.querySelectorAll('.info-tab')) {
    button.addEventListener('click', () => setInfoTab(button.dataset.tab))
  }

  const usageBadge = ui.querySelector('#usage-badge')
  const updateBtn = ui.querySelector('#update-btn')

  function setUsage(callsToday) {
    usageBadge.textContent =
      callsToday === null ? '' : `${callsToday} requête${callsToday === 1 ? '' : 's'} NASA aujourd'hui`
  }

  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    // Innermost first: the modal, then the NEO panel, then the selected NEO's trajectory.
    if (modal.isOpen()) modal.close()
    else if (detail.isOpen()) detail.close()
    else on.deselect()
  })

  async function requestUpdate() {
    updateBtn.disabled = true
    updateBtn.textContent = 'Mise à jour…'
    await on.update()
    updateBtn.disabled = false
    updateBtn.textContent = 'Mettre à jour'
  }

  updateBtn.addEventListener('click', requestUpdate)

  return {
    // The scene-label layer; labels.js will take it later.
    sceneLabels,
    ...tooltips,
    renderIss: issTab.render,
    renderNeo: neoTab.render,
    renderNeoPositions: neoTab.renderPositions,
    renderPlanets: planetsTab.render,
    renderTracking: trackingTab.render,
    renderTrajectory: trackingTab.renderTool,
    /** Opens a tab of the left column (and remembers it, like a click). */
    showTab: (id) => setInfoTab(id),
    renderApod: apod.render,
    renderScale: bottomBar.renderScale,
    renderView: bottomBar.renderView,
    renderTime: bottomBar.renderTime,
    setUsage,
    openModal: modal.open,
    openDetail: detail.open,
    setDetailLive: detail.setLive,
    closeDetail: detail.close,
    requestUpdate,
  }
}
