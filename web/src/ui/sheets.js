/**
 * The detail panel's two sheets — a weekly NEO's and a tracked asteroid's — as
 * HTML. Pure: main.js gathers the state (selection, tracked list, clock) and
 * hands it over as plain values, the panel draws what comes back
 * (`panels.openDetail`). The buttons carry `data-action`, wired in ui/panels.js.
 */
import { orbitSchematicSvg } from '../orbit.js'
import { MAX_TRACKED } from '../tracking.js'
import {
  NEO_CREDITS,
  trackedCredits,
  escapeHtml,
  sourcesBlockHtml,
  detailsBlockHtml,
  diameterHtml,
} from '../neoInfo.js'

const formatUtc = (seconds) =>
  `${new Date(seconds * 1000).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' })} UTC`

/**
 * The "Suivre" button and why it may be off. A button, not a link: it acts on the list.
 *
 * @param {{designation: string, tracked: boolean, full: boolean,
 *   neoTrack: {designation: string|null, busy: boolean, message: string}}} state
 */
export function trackButtonHtml({ designation, tracked, full, neoTrack }) {
  const mine = neoTrack.designation === designation
  const busy = mine && neoTrack.busy
  const note = tracked
    ? 'déjà suivi'
    : full
      ? `${MAX_TRACKED} objets au plus`
      : busy
        ? 'résolution (JPL SBDB)…'
        : mine
          ? escapeHtml(neoTrack.message)
          : ''
  return `<p><button class="sheet-action" data-action="track" data-designation="${escapeHtml(designation)}"${
    tracked || full || busy ? ' disabled' : ''
  }>Suivre</button> <span class="${mine && neoTrack.message && !busy ? 'error' : 'muted'}">${note}</span></p>`
}

/**
 * A weekly NEO's sheet. The scene-dependent blocks (position, trajectory,
 * orbit) come already rendered by neo/scene.js; the rest is the feed and the
 * object's sheet.
 */
export function neoSheetHtml({ neo, designation, sheet, trackButton, positionHtml, trajectoryHtml, orbitHtml, nowMs }) {
  const approach = neo.close_approach
  const details = sheet.data
  const diameter = diameterHtml(details?.diameter_km, neo.estimated_diameter_km)
  return `
    <p><strong>Désignation</strong> ${escapeHtml(designation)}</p>
    ${trackButton}
    <p><strong>Diamètre</strong> ${diameter}</p>
    <p><strong>Potentiellement dangereux</strong> ${neo.is_potentially_hazardous ? 'Oui' : 'Non'}</p>
    ${positionHtml}
    ${
      approach
        ? `
      <p><strong>Approche la plus proche</strong> ${approach.datetime ? new Date(approach.datetime).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : approach.date}</p>
      <p><strong>Distance</strong> ${Math.round(approach.miss_distance_km).toLocaleString('fr-FR')} km</p>
      <p><strong>Vitesse relative</strong> ${Math.round(approach.relative_velocity_kmh).toLocaleString('fr-FR')} km/h</p>
    `
        : '<p class="muted">Pas de données d\'approche disponibles</p>'
    }
    ${trajectoryHtml}
    ${orbitHtml}
    ${sourcesBlockHtml(neo)}
    ${detailsBlockHtml(details, {
      loading: sheet.loading,
      error: sheet.error,
    })}
    ${
      details?.orbit
        ? orbitSchematicSvg(details.orbit, {
            now: new Date(nowMs),
            approachAt: approach ? new Date(approach.datetime ?? `${approach.date}T12:00Z`) : null,
            hazardous: neo.is_potentially_hazardous,
          })
        : ''
    }
    <p class="muted credits">${NEO_CREDITS}</p>
  `
}

/**
 * The close-approach lines of a tracked NEO's sheet.
 *
 * @param {object|null} next  `nextApproach()` (tracking.js), null when there is
 *   nothing to say (not a NEO, or its tables not loaded yet)
 * @param {string} spkid  for the "Y aller" button
 */
export function trackedApproachHtml(next, spkid) {
  if (!next) return ''
  switch (next.kind) {
    case 'in_window': {
      const { dist_km: dist, v_rel_km_s: speed } = next.approach
      return `<p><strong>Prochain rapprochement</strong> ${formatUtc(next.time)} · ${Math.round(dist).toLocaleString('fr-FR')} km${
        typeof speed === 'number' ? ` · ${speed.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km/s` : ''
      } <button class="sheet-action" data-action="approach" data-spkid="${spkid}">Y aller</button></p>`
    }
    case 'after_window':
      return `<p><strong>Prochain rapprochement</strong> ${formatUtc(next.time)} <span class="muted">(après la plage de l'horloge : on ne peut pas s'y rendre)</span></p>`
    case 'unavailable':
      return `<p class="muted">Rapprochements indisponibles : JPL CAD n'a pas répondu pour cet objet.</p>`
    default:
      return '<p class="muted">Aucun rapprochement connu à moins de 0,05 ua.</p>'
  }
}

/** The same sheet as a weekly NEO's, in the same place — only its lines differ (NEO or not, no NeoWs). */
export function trackedSheetHtml({ rec, sheet, next, positionHtml, nowMs }) {
  const details = sheet.data
  return `
    <p><strong>Désignation</strong> ${escapeHtml(rec.des)}</p>
    <p><strong>Type</strong> ${rec.neo ? 'NEO (astéroïde proche de la Terre)' : 'astéroïde, pas un NEO'}</p>
    ${positionHtml}
    ${trackedApproachHtml(next, rec.spkid)}
    <p class="muted">Trace dans la scène : orbite autour du Soleil sur toute la plage de l'horloge, dans la couleur de l'objet${
      rec.neo ? " ; depuis la Terre s'y ajoute chaque passage près de la Terre (15 jours de part et d'autre du rapprochement)" : ''
    }.</p>
    ${detailsBlockHtml(details, { loading: sheet.loading, error: sheet.error }, { neo: rec.neo })}
    ${
      details?.orbit
        ? orbitSchematicSvg(details.orbit, {
            now: new Date(nowMs),
            approachAt: next?.kind === 'in_window' ? new Date(next.time * 1000) : null,
            hazardous: false,
          })
        : ''
    }
    <p class="muted credits">${trackedCredits(rec.neo)}</p>
  `
}
