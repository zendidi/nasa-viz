/** Formatting shared by several panels of the overlay. */

// One formatter for the whole session: this is called every frame while the
// clock runs fast. UTC and said so — the scene's tables are UTC, and a local
// time would shift with the viewer's zone.
const SIM_DATE_FORMAT = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'UTC' })
export const formatSimDate = (ms) => `${SIM_DATE_FORMAT.format(ms)} UTC`

/**
 * `withDate` for data that can sit in the cache for days (NEO feed, APOD) —
 * the ISS is refreshed every minute, its date would just be noise.
 */
export function formatUpdatedAt(fetchedAt, { withDate = false } = {}) {
  if (!fetchedAt) return ''
  const at = new Date(fetchedAt)
  const stamp = withDate
    ? at.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })
    : at.toLocaleTimeString('fr-FR')
  return `<p class="muted">maj ${stamp}</p>`
}
