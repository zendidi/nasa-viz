/**
 * The HTML overlay: the side panels (ISS, NEO, APOD), the bottom bar (scale and
 * point of view), the modal and the two tooltips. Markup, wording and DOM
 * events — **no Three.js, no scene state**.
 *
 * Everything shown arrives as an argument, everything the user does leaves
 * through `on`: the scene's own state (scaleStep, focusId, neoEntries…) stays
 * in main.js. The one exception is state that is purely of the overlay — the
 * APOD currently on show, the NEO-positions counter — which lives here.
 */

import { sourcesPanelHtml } from '../neoInfo.js'
import { FOCUSES, FOCUS_IDS } from '../focus.js'
import { SCALE_PRESETS, SCALE_STEPS } from '../scale.js'

/**
 * Wording of the "point de vue" panel. The two frames of reference get a line
 * each because each one changes what the scene *draws* of a NEO; a planet gets a
 * generated line, since from a planet the NEO drawings are simply not available
 * — the week-long trajectory is geocentric and the full ellipse heliocentric, so
 * neo/scene.js draws neither (it tests for 'earth' and 'sun' by name).
 */
const VIEW_DESCRIPTIONS = {
  earth: 'Scène centrée sur la Terre · trajectoire de la semaine du NEO sélectionné',
  sun: 'Scène centrée sur le Soleil · orbite complète du NEO sélectionné',
}

const viewDescription = (id) =>
  VIEW_DESCRIPTIONS[id] ?? `Scène centrée sur ${FOCUSES[id].label} · distances à l'échelle de son orbite`
const NEO_HEADING = '<h2>Astéroïdes proches (NEO)</h2>'
const PLANETS_HEADING = '<h2>Planètes</h2>'
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
 *                                          focus, recenter, deselect, modalClosed
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
  `
  bottomBar.appendChild(scalePanel)

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
    <div class="scale-row">
      <button id="recenter-btn">Recentrer</button>
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
    <div id="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <button id="modal-close" aria-label="Fermer">×</button>
      <h2 id="modal-title"></h2>
      <div id="modal-body"></div>
    </div>
  `
  document.body.appendChild(modal)

  const starTooltip = document.createElement('div')
  starTooltip.id = 'star-tooltip'
  starTooltip.className = 'hidden'
  document.body.appendChild(starTooltip)

  const constellationTooltip = document.createElement('div')
  constellationTooltip.id = 'constellation-tooltip'
  constellationTooltip.className = 'hidden'
  document.body.appendChild(constellationTooltip)

  // The whole overlay's stylesheet, including the rules for the scene labels
  // and the two tooltips other modules will own later — they still belong to
  // one visual system, so it stays whole here until those modules exist.
  const style = document.createElement('style')
  style.textContent = `
    #ui { position: fixed; top: 0; left: 0; padding: 16px 20px; color: #eaf4ff;
          font-family: system-ui, sans-serif; pointer-events: none; text-shadow: 0 1px 3px rgba(0,0,0,.8); }
    #ui-header { display: flex; align-items: center; gap: 12px; pointer-events: auto; }
    #ui h1 { margin: 0; font-size: 20px; letter-spacing: 0.04em; }
    #ui h2 { margin: 12px 0 4px; font-size: 13px; text-transform: uppercase; opacity: 0.7; }
    #ui p { margin: 2px 0; font-size: 13px; }
    #ui .muted { opacity: 0.6; }
    #ui .error { color: #ff8080; }
    #update-btn, .scale-preset, .focus-btn, #recenter-btn { pointer-events: auto; background: #1c4d7a; color: #eaf4ff;
                  border: 1px solid #4fa8ff; border-radius: 4px; padding: 4px 12px; font-size: 12px; cursor: pointer;
                  text-shadow: none; }
    #update-btn:hover, .scale-preset:hover, .focus-btn:hover, #recenter-btn:hover { background: #24608f; }
    #update-btn:disabled { opacity: 0.5; cursor: default; }
    #usage-badge { font-size: 12px; cursor: help; }

    .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
    #iss-panel h2 .dot { margin-bottom: 2px; }
    .dot-iss { background: #ffcc33; box-shadow: 0 0 5px #ffcc33; }
    .legend { font-size: 12px; opacity: 0.8; }
    /* Seven swatches on one line would push the whole left column out to ~420 px
       and under the APOD thumbnail; only this legend is capped, so the NEO one
       keeps the width it has always had. */
    #planets-panel .legend { max-width: 240px; }

    #apod-panel { position: fixed; top: 16px; right: 20px; pointer-events: auto; cursor: pointer;
                  max-width: 220px; text-align: right; }
    #apod-panel img { display: block; width: 100%; border-radius: 4px; margin-top: 4px; }
    #apod-panel .apod-title { font-weight: 600; }

    #bottom-bar { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); z-index: 2;
                  display: flex; align-items: stretch; justify-content: center; flex-wrap: wrap; gap: 12px;
                  max-width: calc(100vw - 40px); }
    #scale-panel, #view-panel { background: rgba(10,22,34,.8); border: 1px solid #1c4d7a; border-radius: 8px;
                   padding: 10px 16px; color: #eaf4ff; font-family: system-ui, sans-serif; text-align: center; }
    #view-panel { display: flex; flex-direction: column; justify-content: center; }
    #scale-panel .scale-row, #view-panel .scale-row { display: flex; align-items: center; justify-content: center; gap: 8px; }
    #scale-panel .scale-row + .scale-row, #view-panel .scale-row + .scale-row { margin-top: 8px; }
    #scale-panel label, #view-panel label { font-size: 12px; text-transform: uppercase; opacity: 0.7; margin-right: 4px; }
    #scale-panel .scale-end { font-size: 11px; opacity: 0.6; }
    #scale-slider { width: 260px; accent-color: #4fa8ff; }
    .scale-preset.active, .focus-btn.active { background: #4fa8ff; color: #0e2233; }
    /* Seven planets don't fit one line next to the scale panel, and the row must
       not push #bottom-bar wider than the viewport. */
    #view-panel .focus-planets { flex-wrap: wrap; max-width: 260px; }
    #view-panel .focus-planets .focus-btn { font-size: 11px; padding: 2px 6px; }
    .focus-btn:disabled { opacity: 0.35; cursor: default; }
    #scale-label { margin: 8px 0 0; font-size: 13px; font-variant-numeric: tabular-nums; }
    #view-label { margin: 8px 0 0; font-size: 12px; opacity: 0.75; max-width: 220px; }
    #scale-panel .scale-hint, #view-panel .scale-hint { margin: 2px 0 0; font-size: 11px; opacity: 0.55; }

    #scene-labels { position: fixed; inset: 0; pointer-events: none; overflow: hidden; z-index: 1;
                    font-family: system-ui, sans-serif; }
    .scene-label { position: absolute; left: 0; top: 0; font-size: 11px; color: #cfe6ff; white-space: nowrap;
                   text-shadow: 0 1px 3px rgba(0,0,0,.9); }
    .scene-label.ring { color: #4fa8ff; opacity: 0.75; font-size: 10px; }

    #modal-backdrop { position: fixed; inset: 0; z-index: 10; background: rgba(0,0,0,.6); display: flex;
                       align-items: center; justify-content: center; font-family: system-ui, sans-serif; }
    #modal-backdrop.hidden { display: none; }
    #modal { position: relative; background: #0e2233; color: #eaf4ff; border: 1px solid #4fa8ff;
             border-radius: 8px; padding: 20px 24px; max-width: 480px; width: 90%;
             max-height: 80vh; overflow-y: auto; }
    #modal h2 { margin: 0 0 12px; font-size: 17px; }
    #modal h3 { margin: 16px 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.7; }
    #modal p { margin: 4px 0; font-size: 13px; line-height: 1.5; }
    #modal .muted { opacity: 0.6; }
    #modal .warn { color: #ffbf66; opacity: 1; }
    #modal a { color: #7fe0ff; }
    #modal .credits { margin-top: 14px; font-size: 11px; }
    .neo-sources { margin: 4px 0; padding-left: 18px; font-size: 13px; line-height: 1.5; }
    .neo-sources li { margin: 2px 0; }
    .orbit-schematic { margin: 10px 0 0; }
    .orbit-schematic svg { display: block; width: 100%; max-width: 300px; margin: 0 auto; }
    .orbit-schematic text { font: 10px system-ui, sans-serif; }
    .orbit-schematic figcaption { margin-top: 4px; font-size: 11px; line-height: 1.5; opacity: 0.75; text-align: center; }
    #modal img, #modal iframe { display: block; width: 100%; border-radius: 4px; margin-bottom: 10px; border: none; }
    #modal iframe { aspect-ratio: 16 / 9; }
    #modal-close { position: absolute; top: 8px; right: 10px; background: none; border: none;
                   color: #eaf4ff; font-size: 20px; cursor: pointer; line-height: 1; }

    #star-tooltip { position: fixed; pointer-events: none; z-index: 5; background: rgba(10,22,34,.92);
                    color: #eaf4ff; border: 1px solid #4fa8ff; border-radius: 4px; padding: 3px 9px;
                    font-family: system-ui, sans-serif; font-size: 12px; white-space: nowrap;
                    transform: translate(14px, -50%); }
    #star-tooltip.hidden { display: none; }

    #constellation-tooltip { position: fixed; pointer-events: none; z-index: 4; background: rgba(10,22,34,.85);
                    color: #9fd2ff; border: 1px solid #6fb7ff; border-radius: 4px; padding: 2px 9px;
                    font-family: system-ui, sans-serif; font-size: 11px; letter-spacing: 0.03em;
                    text-transform: uppercase; white-space: nowrap; transform: translate(14px, -50%); }
    #constellation-tooltip.hidden { display: none; }
  `
  document.head.appendChild(style)


  const issPanel = ui.querySelector('#iss-panel')
  const neoPanel = ui.querySelector('#neo-panel')
  const planetsPanel = ui.querySelector('#planets-panel')
  const apodPanel = ui.querySelector('#apod-panel')
  const usageBadge = ui.querySelector('#usage-badge')
  const updateBtn = ui.querySelector('#update-btn')
  const scaleSlider = scalePanel.querySelector('#scale-slider')
  const scaleLabel = scalePanel.querySelector('#scale-label')
  const viewLabel = viewPanel.querySelector('#view-label')
  const modalTitle = modal.querySelector('#modal-title')
  const modalBody = modal.querySelector('#modal-body')

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

  /** @param {{color: string, label: string}[]} legend one swatch per colour in play */
  function renderNeo(feed, error, fetchedAt, legend = []) {
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
      <p class="legend">${swatches.join(' &nbsp;')}</p>
      ${formatUpdatedAt(fetchedAt, { withDate: true })}
    `
    renderNeoPositions()
  }

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
   * show — only how many of the seven are actually placed.
   *
   * `drawn` is false when the scene is deliberately not showing them (the
   * geocentric view below 100 % réel). Two words are enough: the panel must not
   * claim seven placed planets over an empty sky, but *why* they are hidden is
   * not news the user needs every time they move the slider — the reasoning
   * lives in docs/echelle-reelle.md.
   *
   * @param {{known: number, orbits: number, total: number, loading: boolean, loadingOrbits: boolean}} state
   * @param {{label: string, color: string}[]} legend one swatch per planet
   * @param {boolean} drawn whether the current scale and pivot put them on screen
   * @param {{planet: string, known: number, loading: boolean} | null} moons
   *   the centred planet's moons, or null when the pivot is not a planet
   */
  function renderPlanets({ known, orbits, total, loading, loadingOrbits }, legend, drawn, moons) {
    const swatches = legend.map((p) => `<span class="dot" style="background:${p.color}"></span>${p.label}`)
    planetsPanel.innerHTML = `
      ${PLANETS_HEADING}
      <p>${
        loading
          ? `positions réelles (JPL Horizons) : ${known}/${total}…`
          : known === total
            ? `${total} planètes · positions réelles (JPL Horizons)`
            : `${known}/${total} placées — les autres n'ont pas répondu`
      }</p>
      ${drawn ? '' : '<p class="muted">planètes masquées</p>'}
      <p class="muted">${
        orbits === total && !loadingOrbits
          ? 'orbites tracées (vue Soleil)'
          : `orbites : ${orbits}/${total}${loadingOrbits ? '…' : ''} (vue Soleil)`
      }</p>
      <p class="legend">${swatches.join(' &nbsp;')}</p>
      ${moonsLine(moons)}
    `
  }

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

  // --- modal -------------------------------------------------------------

  function openModal(title, bodyHtml) {
    modalTitle.textContent = title
    modalBody.innerHTML = bodyHtml
    modal.classList.remove('hidden')
  }

  function closeModal() {
    modal.classList.add('hidden')
    on.modalClosed()
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

  modal.querySelector('#modal-close').addEventListener('click', closeModal)
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeModal()
  })
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    // First Escape closes the modal, a second one drops the selected NEO's trajectory.
    if (!modal.classList.contains('hidden')) closeModal()
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
  viewPanel.querySelector('#recenter-btn').addEventListener('click', () => on.recenter())

  window.addEventListener('keydown', (event) => {
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
    renderApod,
    renderScale,
    renderView,
    setUsage,
    openModal,
    requestUpdate,
  }
}
