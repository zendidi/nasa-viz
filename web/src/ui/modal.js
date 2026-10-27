/** The centred modal (APOD) and the docked detail panel (a NEO's or a tracked object's sheet). */

export function createModal() {
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
  const modalTitle = modal.querySelector('#modal-title')
  const modalBody = modal.querySelector('#modal-body')

  function open(title, bodyHtml) {
    modalTitle.textContent = title
    modalBody.innerHTML = bodyHtml
    modal.classList.remove('hidden')
  }

  function close() {
    modal.classList.add('hidden')
  }

  modal.querySelector('#modal-close').addEventListener('click', close)
  modal.addEventListener('click', (event) => {
    if (event.target === modal) close()
  })

  return { open, close, isOpen: () => !modal.classList.contains('hidden') }
}

/**
 * The selected NEO's sheet. Docked bottom-left rather than a centred modal so
 * the scene stays visible around the selection; no backdrop, so the canvas
 * keeps its clicks, and it only goes away through its own close button (or
 * Escape) — clicking another NEO just replaces its content.
 *
 * @param {{detailClosed: Function, detailAction: (action: string, data: object) => void}} on
 */
export function createDetailPanel(on) {
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
  const detailTitle = detailPanel.querySelector('#detail-title')
  const detailBody = detailPanel.querySelector('#detail-body')
  const detailScroll = detailPanel.querySelector('#detail-scroll')

  /** Opens the panel, or refreshes it in place — scroll kept — when already open. */
  function open(title, bodyHtml) {
    if (detailTitle.textContent !== title) detailScroll.scrollTop = 0
    detailTitle.textContent = title
    detailBody.innerHTML = bodyHtml
    detailPanel.classList.remove('hidden')
  }

  function close() {
    detailPanel.classList.add('hidden')
    on.detailClosed()
  }

  // Buttons inside a sheet (data-action): the body's markup is replaced on every
  // render, so one listener on the container, bound once.
  detailBody.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]')
    if (button && !button.disabled) on.detailAction(button.dataset.action, { ...button.dataset })
  })

  detailPanel.querySelector('#detail-close').addEventListener('click', close)

  return { open, close, isOpen: () => !detailPanel.classList.contains('hidden') }
}
