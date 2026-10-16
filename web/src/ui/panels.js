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

import { sourcesPanelHtml } from '../neoInfo.js'
import { FOCUSES, FOCUS_IDS } from '../focus.js'
import { SCALE_PRESETS, SCALE_STEPS } from '../scale.js'

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
/** Speeds of the simulated clock, in simulated seconds per real second (clock.js). */
const TIME_RATES = [
  { rate: 1, label: '×1' },
  { rate: 3600, label: '1 h/s' },
  { rate: 86_400, label: '1 j/s' },
]

// One formatter for the whole session: this is called every frame while the
// clock runs fast. UTC and said so — the scene's tables are UTC, and a local
// time would shift with the viewer's zone.
const SIM_DATE_FORMAT = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'UTC' })
const formatSimDate = (ms) => `${SIM_DATE_FORMAT.format(ms)} UTC`

const NEO_HEADING = '<h2>Astéroïdes proches (NEO)</h2>'
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
 *                                          allOrbits, points, venusSurface, rings,
 *                                          timeRate, timeReset
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
      <button id="ui-style-btn" class="header-toggle" title="Panneau encadré, ou texte brut posé sur la scène">Panneau</button>
      <button id="apod-btn" class="header-toggle" aria-pressed="true" title="Afficher ou masquer l'image du jour, pour dégager la vue">APOD</button>
      <button id="time-btn" class="header-toggle" aria-pressed="false" title="Afficher le panneau du temps simulé — le masquer remet l'heure réelle">Temps</button>
    </div>
    <div id="info-panel">
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
      <label class="rings-toggle"><input type="checkbox" id="rings-toggle" checked>Cercles</label>
    </div>
    <p id="view-label"></p>
    <p class="muted scale-hint">Touche R : recentrer</p>
  `
  bottomBar.appendChild(viewPanel)

  // The simulated clock: three speeds (no reverse) and the way back to real time.
  const timePanel = document.createElement('div')
  timePanel.id = 'time-panel'
  timePanel.classList.add('hidden') // off by default; the header's "Temps" toggle shows it
  timePanel.innerHTML = `
    <div class="scale-row">
      <label>Temps</label>
      ${TIME_RATES.map((r) => `<button class="time-rate" data-rate="${r.rate}">${r.label}</button>`).join('')}
    </div>
    <div class="scale-row">
      <button id="time-now-btn">Maintenant</button>
    </div>
    <p id="time-label"></p>
    <p id="time-limit" class="hidden"></p>
  `
  bottomBar.appendChild(timePanel)
  const timeLabel = timePanel.querySelector('#time-label')
  const timeLimit = timePanel.querySelector('#time-limit')
  const timeNowBtn = timePanel.querySelector('#time-now-btn')

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
    .header-toggle { pointer-events: auto; background: none; color: #eaf4ff; border: 1px solid #1c4d7a; border-radius: 4px;
                     padding: 3px 10px; font-size: 11px; cursor: pointer; text-shadow: none; opacity: 0.75; }
    .header-toggle:hover { opacity: 1; border-color: #4fa8ff; }
    .header-toggle[aria-pressed="true"] { background: #1c4d7a; border-color: #4fa8ff; opacity: 1; }

    /* The left column, "panneau" style (2026-10-15): the same card as the two
       bottom panels, one section per kind of object with a rule between them.
       Without the class it is the original raw text on the sky, which the
       header button brings back. Still click-through as a whole — only its
       controls opt back in, as everywhere in #ui. */
    #info-panel.card { margin-top: 12px; padding: 2px 16px 10px; max-width: 400px; box-sizing: border-box;
                       background: rgba(10,22,34,.8); border: 1px solid #1c4d7a; border-radius: 8px; text-shadow: none; }
    #info-panel.card section + section { margin-top: 10px; border-top: 1px solid rgba(79,168,255,.25); }
    #info-panel.card h2 { margin: 10px 0 6px; letter-spacing: 0.05em; color: #9fd2ff; opacity: 0.9; }
    #info-panel.card .neo-toggle { margin-top: 6px; }
    #info-panel.card #planets-panel .legend { max-width: none; }

    .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px; vertical-align: middle; }
    #iss-panel h2 .dot { margin-bottom: 2px; }
    .dot-iss { background: #ffcc33; box-shadow: 0 0 5px #ffcc33; }
    .legend { font-size: 12px; opacity: 0.8; }
    /* The one control in a side panel, so it says so by being clickable where
       everything around it is text: pointer cursor on the whole label, and the
       box aligned on the baseline of the line it reads with.

       pointer-events: auto is not cosmetic, it is what makes the box clickable
       at all: #ui above is click-through so the scene can be dragged from behind
       the panels, so every real control has to opt back in — the buttons do it
       in their own rule. On the label rather than on the paragraph, so the empty
       width to the right of the text stays click-through.

       Without it (2026-10-12) the checkbox was completely inert: no toggle, no
       change event, nothing wrong anywhere downstream to find.

       NB : no backticks anywhere in this stylesheet — it is a JS template
       literal, and one backtick in a comment ends the string. */
    .neo-toggle { font-size: 12px; }
    .neo-toggle label { cursor: pointer; pointer-events: auto; }
    .neo-toggle input { vertical-align: -1px; margin-right: 4px; accent-color: #4fa8ff; }
    .neo-toggle .muted { margin-left: 4px; }
    /* The orbits box hangs under the points box that commands it. */
    .neo-toggle.sub { margin-left: 20px; }
    .neo-toggle label:has(input:disabled) { opacity: 0.5; cursor: default; }
    /* Seven swatches on one line would push the whole left column out to ~420 px
       and under the APOD thumbnail; only this legend is capped, so the NEO one
       keeps the width it has always had. */
    #planets-panel .legend { max-width: 240px; }

    #apod-panel { position: fixed; top: 16px; right: 20px; pointer-events: auto; cursor: pointer;
                  max-width: 220px; text-align: right; }
    /* The right edge is shared (2026-10-15): APOD keeps the top half at most,
       the NEO detail panel docks in the bottom half. A tall picture shrinks to
       fit rather than running down into the detail panel — contained, so it
       keeps its proportions, and pinned right to stay flush with the title. */
    #apod-panel { display: flex; flex-direction: column; align-items: flex-end; box-sizing: border-box;
                  max-height: calc(50vh - 24px); }
    #apod-panel.hidden { display: none; }
    #apod-panel > * { flex: none; }
    #apod-panel img { display: block; flex: 0 1 auto; min-height: 0; max-width: 100%; object-fit: contain;
                      object-position: right top; border-radius: 4px; margin-top: 4px; }
    #apod-panel .apod-title { font-weight: 600; }

    #bottom-bar { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); z-index: 2;
                  display: flex; align-items: stretch; justify-content: center; flex-wrap: wrap; gap: 12px;
                  max-width: calc(100vw - 40px); }
    #scale-panel, #view-panel, #time-panel { background: rgba(10,22,34,.8); border: 1px solid #1c4d7a; border-radius: 8px;
                   padding: 10px 16px; color: #eaf4ff; font-family: system-ui, sans-serif; text-align: center; }
    #view-panel, #time-panel { display: flex; flex-direction: column; justify-content: center; }
    #time-panel.hidden { display: none; }
    .time-rate, #time-now-btn { pointer-events: auto; background: #1c4d7a; color: #eaf4ff; border: 1px solid #4fa8ff;
                  border-radius: 4px; padding: 4px 12px; font-size: 12px; cursor: pointer; text-shadow: none; }
    .time-rate:hover, #time-now-btn:hover { background: #24608f; }
    .time-rate.active { background: #4fa8ff; color: #0e2233; }
    #time-now-btn:disabled { opacity: 0.35; cursor: default; }
    #time-label { margin: 8px 0 0; font-size: 12px; font-variant-numeric: tabular-nums; max-width: 220px; }
    #time-label.muted { opacity: 0.6; }
    #time-limit { margin: 4px 0 0; font-size: 12px; color: #ffbf66; max-width: 220px; }
    #time-limit.hidden { display: none; }
    #scale-panel .scale-row, #view-panel .scale-row, #time-panel .scale-row { display: flex; align-items: center; justify-content: center; gap: 8px; }
    #scale-panel .scale-row + .scale-row, #view-panel .scale-row + .scale-row, #time-panel .scale-row + .scale-row { margin-top: 8px; }
    #scale-panel label, #view-panel label, #time-panel label { font-size: 12px; text-transform: uppercase; opacity: 0.7; margin-right: 4px; }
    #scale-panel .scale-end { font-size: 11px; opacity: 0.6; }
    #scale-slider { width: 260px; accent-color: #4fa8ff; }
    .scale-preset.active, .focus-btn.active { background: #4fa8ff; color: #0e2233; }
    /* Eight planets and Pluto don't fit one line next to the scale panel, and the row must
       not push #bottom-bar wider than the viewport. */
    #view-panel .rings-toggle { cursor: pointer; pointer-events: auto; margin: 0 0 0 4px; }
    #view-panel .rings-toggle input { vertical-align: -1px; margin-right: 4px; accent-color: #4fa8ff; }
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
    .scene-label.ring { color: #c8ccd4; opacity: 0.75; font-size: 10px; }
    .scene-label.ring.absolute { color: #ffbf66; }

    #modal-backdrop { position: fixed; inset: 0; z-index: 10; background: rgba(0,0,0,.6); display: flex;
                       align-items: center; justify-content: center; font-family: system-ui, sans-serif; }
    #modal-backdrop.hidden { display: none; }
    #modal { position: relative; background: #0e2233; color: #eaf4ff; border: 1px solid #4fa8ff;
             border-radius: 8px; padding: 20px 24px; max-width: 480px; width: 90%;
             max-height: 80vh; overflow-y: auto; }
    .sheet h2 { margin: 0 0 12px; font-size: 17px; }
    .sheet h3 { margin: 16px 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.7; }
    .sheet p { margin: 4px 0; font-size: 13px; line-height: 1.5; }
    .sheet .muted { opacity: 0.6; }
    /* Three catalogues plus a spread column, in a 480 px modal: the numbers are
       tabular-aligned so the eye can see which digit stops matching, and the
       element names stay left while the figures go right. */
    .orbit-compare { width: 100%; border-collapse: collapse; margin: 6px 0 2px;
                     font-size: 12px; font-variant-numeric: tabular-nums; }
    .orbit-compare th, .orbit-compare td { padding: 2px 4px; text-align: right; }
    .orbit-compare thead th, .orbit-compare tbody th { font-weight: 600; opacity: 0.7; }
    .orbit-compare tbody th { text-align: left; white-space: nowrap; }
    .orbit-compare thead th { border-bottom: 1px solid rgba(79,168,255,.35); }
    .orbit-compare .spread { color: #9fd2ff; border-left: 1px solid rgba(79,168,255,.25); }
    .orbit-compare sup { font-size: 9px; }
    .sheet .warn { color: #ffbf66; opacity: 1; }
    .sheet a { color: #7fe0ff; }
    .sheet .credits { margin-top: 14px; font-size: 11px; }
    .neo-sources { margin: 4px 0; padding-left: 18px; font-size: 13px; line-height: 1.5; }
    .neo-sources li { margin: 2px 0; }
    .orbit-schematic { margin: 10px 0 0; }
    .orbit-schematic svg { display: block; width: 100%; max-width: 300px; margin: 0 auto; }
    .orbit-schematic text { font: 10px system-ui, sans-serif; }
    .orbit-schematic figcaption { margin-top: 4px; font-size: 11px; line-height: 1.5; opacity: 0.75; text-align: center; }
    .sheet img, .sheet iframe { display: block; width: 100%; border-radius: 4px; margin-bottom: 10px; border: none; }
    .sheet iframe { aspect-ratio: 16 / 9; }
    .sheet-close { position: absolute; top: 8px; right: 10px; background: none; border: none;
                   color: #eaf4ff; font-size: 20px; cursor: pointer; line-height: 1; }

    /* Same look and same scroll as the modal, docked bottom-right, under APOD
       (2026-10-15 — bottom-left, it ran into the left-hand column): 480 px +
       20 px gutter stops short of #bottom-bar on a 1900 px screen, and the
       height is capped to the bottom half the right edge leaves it. z-index above
       #bottom-bar so a narrow window overlaps rather than hides it. The scroll
       lives in an inner box, not on the panel itself, so the close button —
       absolute on the panel — stays pinned top-right whatever the scroll. */
    #detail-panel { position: fixed; right: 20px; bottom: 16px; z-index: 3; box-sizing: border-box;
                    background: #0e2233; color: #eaf4ff; border: 1px solid #4fa8ff; border-radius: 8px;
                    width: 480px; max-width: calc(100vw - 40px); font-family: system-ui, sans-serif; }
    #detail-scroll { box-sizing: border-box; padding: 20px 24px; max-height: calc(50vh - 24px); overflow-y: auto; }
    /* Shifted left of the inner scrollbar, which runs along the right edge. */
    #detail-panel .sheet-close { z-index: 1; right: 22px; }
    #detail-panel.hidden { display: none; }
    #detail-panel h2 { padding-right: 20px; }

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

  // The time panel is hidden at every start (not remembered). Putting it away
  // also puts the clock back on the real time: a hidden panel must not leave a
  // simulated date running with no control in sight.
  const timeBtn = ui.querySelector('#time-btn')
  timeBtn.addEventListener('click', () => {
    const shown = timePanel.classList.toggle('hidden') === false
    timeBtn.setAttribute('aria-pressed', String(shown))
    if (!shown) on.timeReset()
  })

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
   * @param {{known: number, orbits: number, total: number, loading: boolean, loadingOrbits: boolean}} state
   * @param {{label: string, color: string}[]} legend one swatch per planet
   * @param {boolean} drawn whether the current scale and pivot put them on screen
   * @param {{planet: string, known: number, loading: boolean} | null} moons
   *   the centred planet's moons, or null when the pivot is not a planet
   */
  function renderPlanets({ known, orbits, total, loading, loadingOrbits }, legend, drawn, moons, venus = null) {
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
    for (const button of timePanel.querySelectorAll('.time-rate')) {
      button.classList.toggle('active', Number(button.dataset.rate) === rate)
    }
    timeNowBtn.disabled = realTime
    timeLabel.textContent = realTime ? 'temps réel' : `Simulé : ${stamp}`
    timeLabel.classList.toggle('muted', realTime)
    timeLimit.classList.toggle('hidden', !atLimit)
    if (atLimit) timeLimit.textContent = `Butée : fin des tables JPL (${formatSimDate(limitMs)}) — le temps s'arrête ici`
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
  for (const button of timePanel.querySelectorAll('.time-rate')) {
    button.addEventListener('click', () => on.timeRate(Number(button.dataset.rate)))
  }
  timeNowBtn.addEventListener('click', () => on.timeReset())
  viewPanel.querySelector('#recenter-btn').addEventListener('click', () => on.recenter())
  // Static markup, never re-rendered: a direct listener is enough here.
  viewPanel.querySelector('#rings-toggle').addEventListener('change', (event) => on.rings(event.target.checked))

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
    renderTime,
    setUsage,
    openModal,
    openDetail,
    closeDetail,
    requestUpdate,
  }
}
