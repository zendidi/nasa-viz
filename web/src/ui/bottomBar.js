/**
 * The bottom bar: the scale-and-time panel on the left, the point-of-view panel
 * on the right (docs/points-de-vue.md), their sliders and buttons, the R key
 * and Shift+wheel.
 */

import { FOCUSES, FOCUS_IDS } from '../view/focus.js'
import { SCALE_PRESETS, SCALE_STEPS } from '../view/scale.js'
import { RATE_STOPS } from '../ephemeris/clock.js'
import { formatSimDate } from './format.js'

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

/** The pivot buttons of one group, in the registry's own order. */
const focusButtons = (group) =>
  FOCUS_IDS.filter((id) => FOCUSES[id].group === group)
    .map((id) => `<button class="focus-btn" data-focus="${id}">${FOCUSES[id].label}</button>`)
    .join('')

/**
 * @param {HTMLElement} app  where the bar is appended
 * @param {HTMLElement} wheelTarget  the canvas — Shift+wheel is only a scale step over it
 * @param {object} on  scaleStep, scaleStepBy, focus, recenter, rings, ecliptic, timeRate, timeReset, timePlayPause
 */
export function createBottomBar(app, wheelTarget, on) {
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

  const scaleSlider = scalePanel.querySelector('#scale-slider')
  const scaleLabel = scalePanel.querySelector('#scale-label')
  const viewLabel = viewPanel.querySelector('#view-label')

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

  return { scalePanel, renderScale, renderView, renderTime }
}
