/**
 * The HTML overlay: the side panels (ISS, NEO, APOD), the bottom bar (scale and
 * point of view), the NEO detail panel, the modal and the two tooltips. Markup, wording and DOM
 * events — **no Three.js, no scene state**.
 *
 * Everything shown arrives as an argument, everything the user does leaves
 * through `on`: the scene's own state (scaleStep, focusId, neoEntries…) stays
 * in main.js. The one exception is state that is purely of the overlay — the
 * APOD currently on show, the NEO-positions counter — which lives here.
 */

import { escapeHtml, sourcesPanelHtml } from '../neoInfo.js'
import { MAX_TRACKED } from '../tracking.js'
import { FOCUSES, FOCUS_IDS } from '../focus.js'
import { SCALE_PRESETS, SCALE_STEPS } from '../scale.js'
import { RATE_STOPS } from '../clock.js'
import './panels.css'

/**
 * Wording of the "point de vue" panel. The two frames of reference get a line
 * each because each one changes what the scene *draws* of a NEO; a planet gets a
 * generated line, since from a planet the NEO drawings are still not available
 * — the week-long trajectory is geocentric and the full ellipse heliocentric, so
 * neo/scene.js draws neither (it tests for 'earth' and 'sun' by name).
 *
 * What a planet's line *can* now promise, since 2026-10-12, is the orbits: the
 * planetary orbits are drawn from every pivot, the centred planet's own
 * included, so that is what its line says instead of nothing.
 */
const VIEW_DESCRIPTIONS = {
  earth: 'Scène centrée sur la Terre · trajectoire de la semaine du NEO sélectionné',
  sun: 'Scène centrée sur le Soleil · orbite complète du NEO sélectionné',
}

const viewDescription = (id) =>
  VIEW_DESCRIPTIONS[id] ??
  `Scène centrée sur ${FOCUSES[id].label} · autres planètes et orbites planétaires à l’échelle réelle`
/** How a speed of the simulated clock reads, in simulated time per real second (clock.js). */
const RATE_UNITS = [
  { seconds: 604_800, label: 'sem' },
  { seconds: 86_400, label: 'j' },
  { seconds: 3600, label: 'h' },
  { seconds: 60, label: 'min' },
]
function rateLabel(rate) {
  if (rate === 0) return 'pause'
  if (rate === 1) return 'temps réel (×1)'
  const unit = RATE_UNITS.find((u) => Math.abs(rate) >= u.seconds) ?? { seconds: 1, label: 's' }
  const amount = Math.abs(rate) / unit.seconds
  return `${rate < 0 ? '−' : ''}${amount.toLocaleString('fr-FR')} ${unit.label}/s${rate < 0 ? ' (arrière)' : ''}`
}
/** The slider position of a rate: its stop, or the nearest one for a rate set from elsewhere. */
function rateIndex(rate) {
  let best = 0
  for (let i = 1; i < RATE_STOPS.length; i++) {
    if (Math.abs(RATE_STOPS[i] - rate) < Math.abs(RATE_STOPS[best] - rate)) best = i
  }
  return best
}

/** The left column's four tabs, one section each (2026-10-27; "Suivi" added the same day). */
const INFO_TABS = [
  { id: 'iss', label: 'ISS' },
  { id: 'neo', label: 'NEO' },
  { id: 'planets', label: 'Planètes' },
  { id: 'tracking', label: 'Suivi' },
]

// One formatter for the whole session: this is called every frame while the
// clock runs fast. UTC and said so — the scene's tables are UTC, and a local
// time would shift with the viewer's zone.
const SIM_DATE_FORMAT = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'UTC' })
const formatSimDate = (ms) => `${SIM_DATE_FORMAT.format(ms)} UTC`

const NEO_HEADING = '<h2>Astéroïdes proches (NEO)</h2>'
const PLANETS_HEADING = '<h2>Planètes</h2>'
const TRACK_PLACEHOLDER = 'Apophis, 433, 2004 MN4, 20099942…'
const TRACKING_HEADING = "<h2>Suivi d'astéroïdes</h2>"

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
const ISS_HEADING = '<h2><span class="dot dot-iss"></span>ISS</h2>'
const APOD_HEADING = '<h2>Image du jour (APOD)</h2>'

/**
 * `withDate` for data that can sit in the cache for days (NEO feed, APOD) —
 * the ISS is refreshed every minute, its date would just be noise.
 */
function formatUpdatedAt(fetchedAt, { withDate = false } = {}) {
  if (!fetchedAt) return ''
  const at = new Date(fetchedAt)
  const stamp = withDate
    ? at.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
    : at.toLocaleTimeString('fr-FR')
  return `<p class="muted">maj ${stamp}</p>`
}

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
 *                                          allOrbits, points, venusSurface, rings, ecliptic,
 *                                          timeRate, timeReset, trackSearch, trackOpen,
 *                                          trackApproach, trackRemove, trackRetry,
 *                                          trackShowNeo, detailAction
 */
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

/** The pivot buttons of one group, in the registry's own order. */
const focusButtons = (group) =>
  FOCUS_IDS.filter((id) => FOCUSES[id].group === group)
    .map((id) => `<button class="focus-btn" data-focus="${id}">${FOCUSES[id].label}</button>`)
    .join('')

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
      <section id="iss-panel">
        ${ISS_HEADING}
        <p class="muted">chargement…</p>
      </section>
      <section id="neo-panel">
        ${NEO_HEADING}
        <p class="muted">chargement…</p>
      </section>
      <section id="planets-panel">
        ${PLANETS_HEADING}
        <p class="muted">chargement…</p>
      </section>
      <section id="tracking-panel">
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
      </section>
    </div>
    <section id="apod-panel">
      ${APOD_HEADING}
      <p class="muted">chargement…</p>
    </section>
  `
  app.appendChild(ui)

  // Both bottom panels sit in one centred row: scale on the left, point of view
  // on the right (docs/points-de-vue.md).
  const bottomBar = document.createElement('div')
  bottomBar.id = 'bottom-bar'
  app.appendChild(bottomBar)

  const scalePanel = document.createElement('div')
  scalePanel.id = 'scale-panel'
  scalePanel.innerHTML = `
    <div class="scale-row">
      <label for="scale-slider">Échelle</label>
      <span class="scale-end">lisible</span>
      <input id="scale-slider" type="range" min="0" max="${SCALE_STEPS}" step="1" value="0" list="scale-ticks">
      <span class="scale-end">réelle</span>
      <datalist id="scale-ticks">
        ${Array.from({ length: SCALE_STEPS + 1 }, (_, i) => `<option value="${i}"></option>`).join('')}
      </datalist>
    </div>
    <div class="scale-row">
      ${SCALE_PRESETS.map((p) => `<button class="scale-preset" data-step="${p.step}">${p.label}</button>`).join('')}
    </div>
    <p id="scale-label"></p>
    <p class="muted scale-hint">Shift + molette : un cran d'échelle</p>
    <div class="time-section">
      <div class="scale-row">
        <label for="time-slider">Temps</label>
        <span class="scale-end">◀ passé</span>
        <input id="time-slider" type="range" min="0" max="${RATE_STOPS.length - 1}" step="1"
               value="${RATE_STOPS.indexOf(1)}" list="time-ticks">
        <span class="scale-end">futur ▶</span>
        <datalist id="time-ticks">
          ${RATE_STOPS.map((_, i) => `<option value="${i}"></option>`).join('')}
        </datalist>
      </div>
      <div class="scale-row">
        <span id="time-rate-label"></span>
        <button id="time-play-btn" title="Pause / reprise, à la vitesse d'avant la pause">⏸ Pause</button>
        <button id="time-now-btn">Maintenant</button>
      </div>
      <p id="time-label"></p>
      <p id="time-limit" class="hidden"></p>
    </div>
  `
  bottomBar.appendChild(scalePanel)
  const timeSlider = scalePanel.querySelector('#time-slider')
  const timeRateLabel = scalePanel.querySelector('#time-rate-label')
  const timeLabel = scalePanel.querySelector('#time-label')
  const timeLimit = scalePanel.querySelector('#time-limit')
  const timeNowBtn = scalePanel.querySelector('#time-now-btn')
  const timePlayBtn = scalePanel.querySelector('#time-play-btn')

  const viewPanel = document.createElement('div')
  viewPanel.id = 'view-panel'
  viewPanel.innerHTML = `
    <div class="scale-row">
      <label>Point de vue</label>
      ${focusButtons('frame')}
    </div>
    <div class="scale-row focus-planets">
      ${focusButtons('planet')}
    </div>
    <div class="scale-row view-options">
      <button id="recenter-btn">Recentrer</button>
      <div class="view-toggles">
        <label class="rings-toggle"><input type="checkbox" id="rings-toggle" checked>Cercles</label>
        <label class="rings-toggle"><input type="checkbox" id="ecliptic-toggle">Plan de l'écliptique</label>
      </div>
    </div>
    <p id="view-label"></p>
    <p class="muted scale-hint">Touche R : recentrer</p>
  `
  bottomBar.appendChild(viewPanel)


  const sceneLabels = document.createElement('div')
  sceneLabels.id = 'scene-labels'
  app.appendChild(sceneLabels)

  const modal = document.createElement('div')
  modal.id = 'modal-backdrop'
  modal.className = 'hidden'
  modal.innerHTML = `
    <div id="modal" class="sheet" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <button id="modal-close" class="sheet-close" aria-label="Fermer">×</button>
      <h2 id="modal-title"></h2>
      <div id="modal-body"></div>
    </div>
  `
  document.body.appendChild(modal)

  // The selected NEO's sheet. Docked bottom-left rather than a centred modal so
  // the scene stays visible around the selection; no backdrop, so the canvas
  // keeps its clicks, and it only goes away through its own close button (or
  // Escape) — clicking another NEO just replaces its content.
  const detailPanel = document.createElement('div')
  detailPanel.id = 'detail-panel'
  detailPanel.className = 'sheet hidden'
  detailPanel.setAttribute('role', 'region')
  detailPanel.setAttribute('aria-labelledby', 'detail-title')
  detailPanel.innerHTML = `
    <button id="detail-close" class="sheet-close" aria-label="Fermer">×</button>
    <div id="detail-scroll">
      <h2 id="detail-title"></h2>
      <div id="detail-body"></div>
    </div>
  `
  document.body.appendChild(detailPanel)

  const starTooltip = document.createElement('div')
  starTooltip.id = 'star-tooltip'
  starTooltip.className = 'hidden'
  document.body.appendChild(starTooltip)

  const constellationTooltip = document.createElement('div')
  constellationTooltip.id = 'constellation-tooltip'
  constellationTooltip.className = 'hidden'
  document.body.appendChild(constellationTooltip)

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
    const shown = scalePanel.classList.toggle('hidden') === false
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

  const issPanel = ui.querySelector('#iss-panel')
  const neoPanel = ui.querySelector('#neo-panel')
  const planetsPanel = ui.querySelector('#planets-panel')
  const trackingPanel = ui.querySelector('#tracking-panel')
  const apodPanel = ui.querySelector('#apod-panel')
  const usageBadge = ui.querySelector('#usage-badge')
  const updateBtn = ui.querySelector('#update-btn')
  const scaleSlider = scalePanel.querySelector('#scale-slider')
  const scaleLabel = scalePanel.querySelector('#scale-label')
  const viewLabel = viewPanel.querySelector('#view-label')
  const modalTitle = modal.querySelector('#modal-title')
  const modalBody = modal.querySelector('#modal-body')
  const detailTitle = detailPanel.querySelector('#detail-title')
  const detailBody = detailPanel.querySelector('#detail-body')
  const detailScroll = detailPanel.querySelector('#detail-scroll')

  // --- panels ------------------------------------------------------------

  function renderIss(position, error, fetchedAt) {
    if (error) {
      issPanel.innerHTML = `${ISS_HEADING}<p class="error">${error}</p>`
      return
    }
    issPanel.innerHTML = `
      ${ISS_HEADING}
      <p>lat ${position.latitude.toFixed(2)}° · lng ${position.longitude.toFixed(2)}°</p>
      <p>altitude ${position.altitude_km.toFixed(0)} km · vitesse ${position.velocity_kmh.toFixed(0)} km/h</p>
      ${formatUpdatedAt(fetchedAt)}
    `
  }

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

  /** @param {{color: string, label: string}[]} legend one swatch per colour in play */
  function renderNeo(feed, error, fetchedAt, legend = [], allOrbits = undefined) {
    if (error) {
      neoPanel.innerHTML = `${NEO_HEADING}<p class="error">${error}</p>`
      return
    }
    const hazardous = feed.objects.filter((o) => o.is_potentially_hazardous).length
    const swatches = legend.map((s) => `<span class="dot" style="background:${s.color}"></span>${s.label}`)
    // #neo-positions-status lives inside the template on purpose: this
    // innerHTML replace would wipe it otherwise (docs/agent/gotchas.md).
    neoPanel.innerHTML = `
      ${NEO_HEADING}
      <p>${feed.count} objets (${feed.start_date} → ${feed.end_date}) · clic sur un point pour le détail</p>
      <p>${hazardous} potentiellement dangereux</p>
      ${sourcesPanelHtml(feed)}
      <p id="neo-positions-status" class="muted"></p>
      ${allOrbitsLine(allOrbits)}
      <p class="legend">${swatches.join(' &nbsp;')}</p>
      ${formatUpdatedAt(fetchedAt, { withDate: true })}
    `
    renderNeoPositions()
  }

  // Delegated, and bound once: the checkbox itself is recreated by every
  // renderNeo(), so a listener on the input would die with the first redraw.
  neoPanel.addEventListener('change', (event) => {
    if (event.target.id === 'neo-all-orbits') on.allOrbits(event.target.checked)
    if (event.target.id === 'neo-points') on.points(event.target.checked)
  })

  // Same delegation for the Venus box, which lives inside renderPlanets' template.
  planetsPanel.addEventListener('change', (event) => {
    if (event.target.id === 'venus-surface') on.venusSurface(event.target.checked)
  })

  let neoPositions = { known: 0, total: 0, loading: false }

  /** Called with a state to update it, without one to redraw it after renderNeo(). */
  function renderNeoPositions(state) {
    if (state) neoPositions = state
    const el = neoPanel.querySelector('#neo-positions-status')
    if (!el) return
    const { known, total, loading } = neoPositions
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
  function renderPlanets({ known, orbits, total, loading, loadingOrbits, error = null }, legend, drawn, moons, venus = null) {
    const swatches = legend.map((p) => `<span class="dot" style="background:${p.color}"></span>${p.label}`)
    planetsPanel.innerHTML = `
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

  // --- "Suivi" tab ----------------------------------------------------------

  const trackInput = trackingPanel.querySelector('#track-input')
  const trackSearchBtn = trackingPanel.querySelector('#track-search-btn')
  const trackMessage = trackingPanel.querySelector('#track-message')
  const trackCandidates = trackingPanel.querySelector('#track-candidates')
  const trackList = trackingPanel.querySelector('#track-list')

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

  const TRACK_STATE_TEXT = {
    loading: '<span class="muted">chargement de la table (JPL Horizons)…</span>',
    ready: '<span class="muted">prêt</span>',
    missing: '<span class="error">plus reconnu par JPL</span>',
  }

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
  function renderTracking({ items, full, showNeo }) {
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
  trackingPanel.addEventListener('click', (event) => {
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
  trackingPanel.addEventListener('change', (event) => {
    if (event.target.id === 'tracking-show-neo') on.trackShowNeo(event.target.checked)
  })

  let currentApod = null

  function renderApod(apod, error, fetchedAt) {
    currentApod = error ? null : apod
    if (error) {
      apodPanel.innerHTML = `${APOD_HEADING}<p class="error">${error}</p>`
      return
    }
    const preview =
      apod.media_type === 'video'
        ? '<p>🎥 Vidéo du jour</p>'
        : `<img src="${apod.url}" alt="${apod.title}">`
    apodPanel.innerHTML = `
      ${APOD_HEADING}
      <p class="apod-title">${apod.title}</p>
      ${preview}
      ${formatUpdatedAt(fetchedAt, { withDate: true })}
    `
  }

  function setUsage(callsToday) {
    usageBadge.textContent =
      callsToday === null ? '' : `${callsToday} requête${callsToday === 1 ? '' : 's'} NASA aujourd'hui`
  }

  /**
   * @param {object} state
   * @param {number} state.step        slider position, 0..SCALE_STEPS
   * @param {string} state.frame       the pivot's frame ("géocentré")
   * @param {string} state.description what describeScale() made of it
   */
  function renderScale({ step, frame, description }) {
    scaleSlider.value = String(step)
    for (const button of scalePanel.querySelectorAll('.scale-preset')) {
      button.classList.toggle('active', Number(button.dataset.step) === step)
    }
    const label = step === SCALE_STEPS ? `100 % réel · ${description} · taille min. à l'écran` : description
    // The scale only means something next to the body it is measured from.
    scaleLabel.textContent = `${frame} · ${label}`
  }

  /**
   * @param {string} focusId the current pivot
   * @param {string[]} focusableIds planets whose position table has landed
   */
  function renderView(focusId, focusableIds) {
    for (const button of viewPanel.querySelectorAll('.focus-btn')) {
      const id = button.dataset.focus
      button.classList.toggle('active', id === focusId)
      // Greyed rather than hidden while a planet has no position table: main.js
      // refuses the switch anyway, and a button that appears out of nowhere a
      // minute into the session is worse than one that is visibly not ready.
      button.disabled = FOCUSES[id].group === 'planet' && !focusableIds.includes(id)
    }
    viewLabel.textContent = viewDescription(focusId)
  }

  /**
   * @param {object} state
   * @param {number} state.rate      simulated seconds per real second
   * @param {boolean} state.realTime the scene shows the real time right now
   * @param {number} state.simMs     the simulated time
   * @param {boolean} state.atLimit  the clock has run into its upper bound
   * @param {number|null} state.limitMs that bound
   */
  let lastTimeKey = null
  function renderTime({ rate, realTime, simMs, atLimit, limitMs }) {
    // Called every frame while the clock runs: only touch the DOM when the
    // displayed text would actually change (it ticks once a second at most).
    const stamp = realTime ? '' : formatSimDate(simMs)
    const key = `${rate}|${realTime}|${stamp}|${atLimit}`
    if (key === lastTimeKey) return
    lastTimeKey = key
    timeSlider.value = String(rateIndex(rate))
    timeRateLabel.textContent = rateLabel(rate)
    timeNowBtn.disabled = realTime
    timePlayBtn.textContent = rate === 0 ? '▶ Lecture' : '⏸ Pause'
    timePlayBtn.classList.toggle('paused', rate === 0)
    timeLabel.textContent = realTime ? 'temps réel' : `Simulé : ${stamp}`
    timeLabel.classList.toggle('muted', realTime)
    timeLimit.classList.toggle('hidden', !atLimit)
    if (atLimit) {
      const end = rate < 0 ? 'début' : 'fin'
      timeLimit.textContent = `Butée : ${end} des tables JPL (${formatSimDate(limitMs)}) — le temps s'arrête ici`
    }
  }

  // --- modal -------------------------------------------------------------

  function openModal(title, bodyHtml) {
    modalTitle.textContent = title
    modalBody.innerHTML = bodyHtml
    modal.classList.remove('hidden')
  }

  function closeModal() {
    modal.classList.add('hidden')
  }

  // --- NEO detail panel --------------------------------------------------

  /** Opens the panel, or refreshes it in place — scroll kept — when already open. */
  function openDetail(title, bodyHtml) {
    if (detailTitle.textContent !== title) detailScroll.scrollTop = 0
    detailTitle.textContent = title
    detailBody.innerHTML = bodyHtml
    detailPanel.classList.remove('hidden')
  }

  function closeDetail() {
    detailPanel.classList.add('hidden')
    on.detailClosed()
  }

  function showApodModal(apod) {
    const media =
      apod.media_type === 'video'
        ? `<iframe src="${apod.url}" allowfullscreen></iframe>`
        : `<img src="${apod.url}" alt="${apod.title}">`
    openModal(
      apod.title,
      `
      ${media}
      <p class="muted">${apod.date}</p>
      <p>${apod.explanation}</p>
      ${apod.hd_url ? `<p><a href="${apod.hd_url}" target="_blank" rel="noopener" style="color:#7fe0ff">Voir en haute résolution</a></p>` : ''}
    `,
    )
  }

  // Buttons inside a sheet (data-action): the body's markup is replaced on every
  // render, so one listener on the container, bound once.
  detailBody.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]')
    if (button && !button.disabled) on.detailAction(button.dataset.action, { ...button.dataset })
  })

  modal.querySelector('#modal-close').addEventListener('click', closeModal)
  detailPanel.querySelector('#detail-close').addEventListener('click', closeDetail)
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeModal()
  })
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    // Innermost first: the modal, then the NEO panel, then the selected NEO's trajectory.
    if (!modal.classList.contains('hidden')) closeModal()
    else if (!detailPanel.classList.contains('hidden')) closeDetail()
    else on.deselect()
  })

  apodPanel.addEventListener('click', () => {
    if (currentApod) showApodModal(currentApod)
  })

  // --- tooltips ----------------------------------------------------------

  function showStarTooltip(text, clientX, clientY) {
    starTooltip.textContent = text
    starTooltip.style.left = `${clientX}px`
    starTooltip.style.top = `${clientY}px`
    starTooltip.classList.remove('hidden')
  }

  function hideStarTooltip() {
    starTooltip.classList.add('hidden')
  }

  function showConstellationTooltip(name, clientX, clientY) {
    constellationTooltip.textContent = name
    constellationTooltip.style.left = `${clientX}px`
    // Offset below the star tooltip's row so the two don't overlap when both show at once.
    constellationTooltip.style.top = `${clientY + 22}px`
    constellationTooltip.classList.remove('hidden')
  }

  function hideConstellationTooltip() {
    constellationTooltip.classList.add('hidden')
  }

  // --- controls ----------------------------------------------------------

  async function requestUpdate() {
    updateBtn.disabled = true
    updateBtn.textContent = 'Mise à jour…'
    await on.update()
    updateBtn.disabled = false
    updateBtn.textContent = 'Mettre à jour'
  }

  updateBtn.addEventListener('click', requestUpdate)

  scaleSlider.addEventListener('input', (event) => {
    on.scaleStep(Number(event.target.value))
  })
  for (const button of scalePanel.querySelectorAll('.scale-preset')) {
    button.addEventListener('click', () => on.scaleStep(Number(button.dataset.step)))
  }

  for (const button of viewPanel.querySelectorAll('.focus-btn')) {
    button.addEventListener('click', () => on.focus(button.dataset.focus))
  }
  timeSlider.addEventListener('input', (event) => on.timeRate(RATE_STOPS[Number(event.target.value)]))
  timeNowBtn.addEventListener('click', () => on.timeReset())
  timePlayBtn.addEventListener('click', () => on.timePlayPause())
  viewPanel.querySelector('#recenter-btn').addEventListener('click', () => on.recenter())
  // Static markup, never re-rendered: a direct listener is enough here.
  viewPanel.querySelector('#rings-toggle').addEventListener('change', (event) => on.rings(event.target.checked))
  viewPanel.querySelector('#ecliptic-toggle').addEventListener('change', (event) => on.ecliptic(event.target.checked))

  window.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLElement && event.target.closest('input, textarea')) return
    if (event.key === 'r' || event.key === 'R') on.recenter()
  })

  /**
   * Shift+wheel = one scale step; plain wheel stays camera zoom. Listening on
   * window in the capture phase runs before OrbitControls' own wheel listener on
   * the canvas, so stopping propagation keeps it from zooming too.
   */
  const SCALE_WHEEL_THRESHOLD = 100 // ≈ one mouse-wheel notch
  const SCALE_WHEEL_COOLDOWN_MS = 250
  let scaleWheelAccum = 0
  let scaleWheelLastEventMs = 0
  let scaleWheelLastStepMs = 0

  window.addEventListener(
    'wheel',
    (event) => {
      if (!event.shiftKey || event.target !== wheelTarget) return
      event.preventDefault()
      event.stopPropagation()

      // Chrome/Edge on Windows (and macOS) turn Shift+wheel into horizontal
      // scrolling: deltaY is 0 and the notch arrives in deltaX instead.
      let delta = event.deltaY || event.deltaX
      if (event.deltaMode === 1) delta *= 33 // lines → ~pixels
      const now = performance.now()
      if (now - scaleWheelLastEventMs > 400) scaleWheelAccum = 0 // new gesture
      scaleWheelLastEventMs = now
      scaleWheelAccum += delta

      // Trackpads send many small deltas: accumulate, then step at most once per cooldown.
      if (Math.abs(scaleWheelAccum) >= SCALE_WHEEL_THRESHOLD && now - scaleWheelLastStepMs > SCALE_WHEEL_COOLDOWN_MS) {
        on.scaleStepBy(Math.sign(scaleWheelAccum)) // wheel toward you = zoom out = more real
        scaleWheelAccum = 0
        scaleWheelLastStepMs = now
      }
    },
    { capture: true, passive: false },
  )

  return {
    // The scene-label layer; labels.js will take it later.
    sceneLabels,
    showStarTooltip,
    hideStarTooltip,
    showConstellationTooltip,
    hideConstellationTooltip,
    renderIss,
    renderNeo,
    renderNeoPositions,
    renderPlanets,
    renderTracking,
    /** Opens a tab of the left column (and remembers it, like a click). */
    showTab: (id) => setInfoTab(id),
    renderApod,
    renderScale,
    renderView,
    renderTime,
    setUsage,
    openModal,
    openDetail,
    closeDetail,
    requestUpdate,
  }
}
