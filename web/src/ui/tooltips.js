/** The star and constellation tooltips the sky's hover shows (picking.js drives them). */

function createTooltip(id) {
  const el = document.createElement('div')
  el.id = id
  el.className = 'hidden'
  document.body.appendChild(el)
  return el
}

export function createTooltips() {
  const starTooltip = createTooltip('star-tooltip')
  const constellationTooltip = createTooltip('constellation-tooltip')

  return {
    showStarTooltip(text, clientX, clientY) {
      starTooltip.textContent = text
      starTooltip.style.left = `${clientX}px`
      starTooltip.style.top = `${clientY}px`
      starTooltip.classList.remove('hidden')
    },
    hideStarTooltip() {
      starTooltip.classList.add('hidden')
    },
    showConstellationTooltip(name, clientX, clientY) {
      constellationTooltip.textContent = name
      constellationTooltip.style.left = `${clientX}px`
      // Offset below the star tooltip's row so the two don't overlap when both show at once.
      constellationTooltip.style.top = `${clientY + 22}px`
      constellationTooltip.classList.remove('hidden')
    },
    hideConstellationTooltip() {
      constellationTooltip.classList.add('hidden')
    },
  }
}
