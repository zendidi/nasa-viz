/**
 * Text and colours for the NEO feed's multi-source comparison and the
 * per-object sheet (/api/neo `comparison`, /api/neo/details) — see
 * backend/API.md and docs/neo-jpl-ssodnet.md. Pure: returns strings, no DOM.
 */

export const NEO_DEFAULT_COLOR = 0x7fe0ff
export const NEO_HAZARD_COLOR = 0xff4d4d

/** Broad spectral complexes, from /api/neo/details `taxonomy.complex`. */
export const TAXONOMY = {
  S: { color: 0xd9a55b, label: 'S · silicaté' },
  C: { color: 0x8fa3bf, label: 'C · carboné' },
  X: { color: 0xc9c9d6, label: 'X · métallique / autre' },
  V: { color: 0xb57edc, label: 'V · basaltique' },
  other: { color: 0x7fd49a, label: 'autre type' },
}

export function taxonomyKey(complex) {
  return complex && TAXONOMY[complex] ? complex : complex ? 'other' : null
}

export const cssColor = (hex) => `#${hex.toString(16).padStart(6, '0')}`

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

const SOURCE_NAMES = { jpl_cad: 'JPL CAD', nasa_neows: 'NASA NeoWs', esa_neocc: 'ESA NEOCC' }
const SHORT_NAMES = { jpl_cad: 'JPL', nasa_neows: 'NASA', esa_neocc: "l'ESA" }

const REASONS = {
  date_boundary: 'approche en limite de période (découpage des jours différent)',
  distance_boundary: 'à la limite de portée de la source',
  unknown: 'raison inconnue',
}

const km = (value) => Math.round(value).toLocaleString('fr-FR')

/** Probable reason for an absence, in French. */
function absenceText(source, status) {
  switch (status.status) {
    case 'missing':
      return `absent — ${REASONS[status.reason] ?? status.reason}`
    case 'not_covered':
      return source === 'esa_neocc' ? "non couvert (l'ESA ne liste que < 0,05 ua)" : 'hors portée de la source'
    case 'unavailable':
      return 'source indisponible'
    default:
      return ''
  }
}

/** Short hover suffix when sources disagree, '' otherwise. */
export function neoTooltipSuffix(neo) {
  const c = neo.comparison
  if (!c) return ''
  const missing = Object.keys(SOURCE_NAMES).filter((s) => c[s]?.status === 'missing')
  if (missing.length) return ` · absent de ${missing.map((s) => SHORT_NAMES[s]).join(' et ')}`
  if (c.esa_neocc?.within_jpl_uncertainty === false) return ' · écart JPL/ESA'
  if (c.nasa_neows?.mismatches?.length) return ' · écart JPL/NASA'
  return ''
}

/**
 * Panel summary of how the sources agree on the loaded feed, or '' for feeds
 * cached before the comparison existed.
 */
export function sourcesPanelHtml(feed) {
  const c = feed.comparison
  if (!c || !feed.sources) {
    // Snapshot saved before the feed carried a comparison (NeoWs only).
    return '<p class="muted">flux en cache d\'avant la comparaison des sources — « Mettre à jour » pour l\'obtenir</p>'
  }
  const lines = []

  const down = Object.keys(SOURCE_NAMES).filter((s) => feed.sources[s] === 'unavailable')
  if (down.length) {
    lines.push(`<p class="error">indisponible : ${down.map((s) => SOURCE_NAMES[s]).join(', ')}</p>`)
  }

  const gaps = []
  if (c.nasa_neows.missing) gaps.push(`${c.nasa_neows.missing} absent${c.nasa_neows.missing > 1 ? 's' : ''} de NASA`)
  if (c.jpl_cad.missing) gaps.push(`${c.jpl_cad.missing} absent${c.jpl_cad.missing > 1 ? 's' : ''} de JPL`)
  if (c.nasa_neows.mismatched) gaps.push(`${c.nasa_neows.mismatched} écart${c.nasa_neows.mismatched > 1 ? 's' : ''} JPL/NASA`)
  lines.push(`<p>sources JPL · NASA · ESA${gaps.length ? ` — ${gaps.join(', ')}` : ' — concordantes'}</p>`)

  const esaCovered = c.esa_neocc.found + c.esa_neocc.missing
  if (feed.sources.esa_neocc === 'ok' && esaCovered > 0) {
    const agreeing = c.esa_neocc.found - c.esa_neocc.outside_jpl_uncertainty - c.esa_neocc.different_date
    const diffs = feed.objects
      .map((o) => o.comparison?.esa_neocc?.distance_diff_km)
      .filter((d) => d !== undefined)
      .map(Math.abs)
      .sort((a, b) => a - b)
    const median = diffs.length ? diffs[diffs.length >> 1] : null
    lines.push(
      `<p>ESA (calcul indépendant) : ${agreeing}/${esaCovered} concordants${median !== null ? ` · écart médian ${km(median)} km` : ''}</p>`,
    )
  }
  if (c.impact_risk_lists_disagree) {
    lines.push(`<p>listes de risque Sentry/ESA en désaccord : ${c.impact_risk_lists_disagree}</p>`)
  }

  const flagged = feed.objects.filter((o) => neoTooltipSuffix(o)).map((o) => escapeHtml(o.designation))
  if (flagged.length) {
    lines.push(`<p class="muted">écarts : ${flagged.slice(0, 6).join(', ')}${flagged.length > 6 ? '…' : ''}</p>`)
  }

  return lines.join('')
}

/** "Sources" block of the NEO modal. */
export function sourcesBlockHtml(neo) {
  const c = neo.comparison
  if (!c) return ''
  const rows = []
  // JPL is the reference every other source is compared against — without it
  // there is nothing to compare, so the other rows must not claim agreement.
  const hasJpl = c.jpl_cad.status === 'found'

  rows.push(
    hasJpl
      ? '<li><strong>JPL CAD</strong> ✓ <span class="muted">référence</span></li>'
      : `<li><strong>JPL CAD</strong> ${escapeHtml(absenceText('jpl_cad', c.jpl_cad))}</li>`,
  )

  if (c.nasa_neows.status === 'found') {
    const mismatches = c.nasa_neows.mismatches ?? []
    const comment = !hasJpl
      ? ' <span class="muted">seule source à lister cet objet ici</span>'
      : mismatches.length
        ? ` — écart sur ${mismatches.map((m) => escapeHtml(m.field)).join(', ')}`
        : ' <span class="muted">identique à JPL</span>'
    rows.push(`<li><strong>NASA NeoWs</strong> ✓${comment}</li>`)
  } else {
    rows.push(`<li><strong>NASA NeoWs</strong> ${escapeHtml(absenceText('nasa_neows', c.nasa_neows))}</li>`)
  }

  const esa = c.esa_neocc
  if (esa.status === 'found' && esa.distance_km !== undefined) {
    const sign = esa.distance_diff_km > 0 ? '+' : esa.distance_diff_km < 0 ? '−' : ''
    rows.push(`<li><strong>ESA NEOCC</strong> ✓ ${km(esa.distance_km)} km ·
      écart ${sign}${km(Math.abs(esa.distance_diff_km))} km
      <span class="${esa.within_jpl_uncertainty ? 'muted' : 'warn'}">(${esa.within_jpl_uncertainty ? 'dans' : 'hors de'} la marge JPL ± ${km(esa.jpl_uncertainty_km)} km)</span>
      ${esa.date_diff_days ? `<span class="warn">· date décalée de ${esa.date_diff_days} j</span>` : ''}</li>`)
  } else if (esa.status === 'found') {
    rows.push(
      `<li><strong>ESA NEOCC</strong> ✓${hasJpl ? '' : ' <span class="muted">(pas de valeur JPL à comparer)</span>'}</li>`,
    )
  } else {
    rows.push(`<li><strong>ESA NEOCC</strong> ${escapeHtml(absenceText('esa_neocc', esa))}</li>`)
  }

  if (c.impact_risk_lists) {
    const { jpl_sentry: sentry, esa_neocc: esaRisk, agree } = c.impact_risk_lists
    if (sentry || esaRisk) {
      rows.push(
        `<li><strong>Risque d'impact surveillé</strong> Sentry ${sentry ? 'oui' : 'non'} · ESA ${esaRisk ? 'oui' : 'non'}${agree ? '' : ' <span class="warn">(désaccord)</span>'}</li>`,
      )
    }
  }

  const note = hasJpl
    ? ''
    : '<p class="muted">JPL est la source de référence : sans elle, les écarts ne sont pas calculés pour cet objet.</p>'

  return `<h3>Sources</h3><ul class="neo-sources">${rows.join('')}</ul>${note}`
}

const fmt = (value, digits = 2) => value.toLocaleString('fr-FR', { maximumFractionDigits: digits })

/**
 * The catalogues' orbital elements, side by side (`/api/neo/details`
 * `orbits` + `orbit_comparison`).
 *
 * Transposed on purpose — elements down, catalogues across. One row per source
 * is the natural layout, but it needs eight columns in a 480 px modal; this way
 * five suffice, and the comparison the block exists for reads along a row.
 *
 * Two things the numbers won't say on their own, so the block says them:
 *
 * - **the spread column is the point.** The three catalogues fit their orbits to
 *   the same Minor Planet Center observations, so the elements agree to several
 *   decimals and the table reads as identical rows; the spread is the only
 *   column that moves;
 * - **whether the epochs coincide decides what the spread even means**, which is
 *   why `same_epoch` drives the wording and not just a footnote. Measured on
 *   Apophis: at a common epoch the catalogues disagree by about 1·10⁻⁷ on a,
 *   while ESA's own-epoch solution (eight years back) differs by 2·10⁻⁴ — three
 *   orders of magnitude, nearly all of it the orbit's own secular drift between
 *   the two dates rather than any disagreement. So when the epochs differ, this
 *   block says the spread is contaminated instead of presenting it as a
 *   disagreement, and drops the mean anomaly — the element that drift moves
 *   most, and the one that becomes worth reading the moment the epochs agree.
 */
const ORBIT_SOURCE_LABELS = { sbdb: 'JPL SBDB', esa: 'ESA NEOCC', ssocard: 'IMCCE' }

/** Element rows: key, heading, and how many decimals the value is worth. */
const ORBIT_FIELDS = [
  ['a_au', 'a (ua)', 6],
  ['e', 'e', 6],
  ['i_deg', 'i (°)', 4],
  ['node_deg', 'Ω (°)', 4],
  ['peri_deg', 'ω (°)', 4],
  ['period_days', 'période (j)', 3],
]

/** JD → calendar date: an epoch written 2 461 200,5 tells a reader nothing. */
function julianDateLabel(jd) {
  if (typeof jd !== 'number' || !Number.isFinite(jd)) return '—'
  return new Date((jd - 2440587.5) * 86_400_000).toISOString().slice(0, 10)
}

/** A spread, which is always small: 1,2·10⁻⁷ rather than 0,000000. */
function spreadLabel(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
  if (value === 0) return '0'
  const [mantissa, exponent] = value.toExponential(1).split('e')
  return `${mantissa.replace('.', ',')}·10<sup>${Number(exponent)}</sup>`
}

/** What the spread is worth, in words — see the block comment above. */
function comparisonNote(sources, comparison) {
  // One catalogue alone is not a comparison. The table is still worth drawing —
  // it is the only place the elements are written out — but the promise has to
  // shrink with it.
  if (sources.length < 2) {
    return '<p class="muted">Un seul catalogue a publié des éléments pour cet objet : rien à comparer.</p>'
  }
  const base = `Éléments héliocentriques, écliptique J2000 — les mêmes observations (Minor Planet
    Center), ajustées par des équipes différentes.`
  if (comparison?.same_epoch) {
    return `<p class="muted">${base} Les époques coïncident, donc la colonne d'écart est bien ce que
      leurs orbites ont de différent, anomalie moyenne comprise.</p>`
  }
  return `<p class="muted">${base} Mais les époques ne coïncident pas (dernière ligne), et un écart
    de dates fait dériver tous les éléments : la colonne d'écart mêle donc le désaccord des
    catalogues et l'évolution de l'orbite entre ces deux dates. L'anomalie moyenne est omise — elle
    ne mesurerait plus que l'écart de dates.</p>`
}

export function orbitComparisonHtml(details) {
  const orbits = details.orbits
  if (!orbits) return ''
  const sources = Object.keys(ORBIT_SOURCE_LABELS).filter((key) => orbits[key])
  if (sources.length === 0) return ''

  const comparison = details.orbit_comparison
  const spread = comparison?.spread ?? {}
  // The mean anomaly earns a row only at a common epoch, where it stops
  // measuring the dates and starts measuring the orbits — the same condition
  // under which the backend fills its spread.
  const fields = comparison?.same_epoch ? [...ORBIT_FIELDS, ['mean_anomaly_deg', 'M (°)', 4]] : ORBIT_FIELDS

  const head = sources.map((key) => `<th>${ORBIT_SOURCE_LABELS[key]}</th>`).join('')
  const body = fields
    .map(([field, label, digits]) => {
      const cells = sources.map((key) => {
        const value = orbits[key][field]
        return `<td>${typeof value === 'number' ? fmt(value, digits) : '—'}</td>`
      })
      return `<tr><th>${label}</th>${cells.join('')}<td class="spread">${spreadLabel(spread[field])}</td></tr>`
    })
    .join('')
  const epochs = sources.map((key) => `<td>${julianDateLabel(orbits[key].epoch_jd)}</td>`).join('')
  const note = comparisonNote(sources, comparison)

  return `
    <h3>Orbite selon les catalogues</h3>
    <table class="orbit-compare">
      <thead><tr><th></th>${head}<th class="spread">écart</th></tr></thead>
      <tbody>
        ${body}
        <tr><th>époque</th>${epochs}<td class="spread">—</td></tr>
      </tbody>
    </table>
    ${note}
  `
}

/**
 * "Fiche" block from /api/neo/details.
 *
 * @param {object|null|undefined} details undefined = not loaded yet, null = unknown to the catalogues
 * @param {{loading: boolean, error: ?string}} state
 */
export function detailsBlockHtml(details, { loading, error }) {
  if (details === undefined) {
    if (error) return `<h3>Fiche</h3><p class="error">${escapeHtml(error)}</p>`
    return `<h3>Fiche</h3><p class="muted">${loading ? 'chargement (JPL SBDB, IMCCE SsODNet, Sentry)…' : 'non chargée'}</p>`
  }
  if (details === null) {
    return '<h3>Fiche</h3><p class="muted">Objet inconnu de JPL SBDB et d\'IMCCE SsODNet.</p>'
  }

  const rows = []
  const row = (label, value) => rows.push(`<p><strong>${label}</strong> ${value}</p>`)

  if (details.orbit_class) row('Classe orbitale', escapeHtml(details.orbit_class.name))
  if (details.taxonomy) {
    const key = taxonomyKey(details.taxonomy.complex)
    row(
      'Type spectral',
      `<span class="dot" style="background:${cssColor(TAXONOMY[key].color)}"></span>${escapeHtml(details.taxonomy.class)} <span class="muted">(${TAXONOMY[key].label})</span>`,
    )
  }
  if (details.diameter_km) {
    row('Diamètre mesuré', `${fmt(details.diameter_km.value * 1000, 0)} m <span class="muted">(${details.diameter_km.source === 'ssocard' ? 'IMCCE' : 'JPL'})</span>`)
  }
  if (details.albedo) row('Albédo', fmt(details.albedo.value, 3))
  if (details.absolute_magnitude_h !== null) row('Magnitude absolue H', fmt(details.absolute_magnitude_h, 2))
  if (details.moid_earth_au !== null) {
    row('MOID Terre', `${fmt(details.moid_earth_au, 5)} ua <span class="muted">(${km(details.moid_earth_au * 149_597_870.7)} km, distance minimale entre les orbites)</span>`)
  }
  if (details.rotation_period_h !== null) row('Rotation', `${fmt(details.rotation_period_h, 2)} h`)
  if (details.mass_kg !== null) row('Masse', `${details.mass_kg.toExponential(2).replace('.', ',')} kg`)
  if (details.density_kg_m3 !== null) row('Densité', `${fmt(details.density_kg_m3, 0)} kg/m³`)

  const risk = details.impact_risk
  if (risk) {
    row(
      "Risque d'impact (Sentry)",
      `probabilité ${risk.probability.toExponential(1).replace('.', ',')} · Palerme ${fmt(risk.palermo_cum, 2)} · Turin ${risk.torino_max}${risk.range ? ` · ${escapeHtml(risk.range)}` : ''}`,
    )
  }

  const unknownPhysics = !details.diameter_km && !details.taxonomy
  const links = [
    `<a href="${escapeHtml(details.links.jpl)}" target="_blank" rel="noopener">JPL</a>`,
    details.links.ssocard ? `<a href="${escapeHtml(details.links.ssocard)}" target="_blank" rel="noopener">SsODNet</a>` : null,
    details.links.esa ? `<a href="${escapeHtml(details.links.esa)}" target="_blank" rel="noopener">ESA NEOCC</a>` : null,
  ].filter(Boolean)

  return `
    <h3>Fiche</h3>
    ${rows.join('')}
    ${unknownPhysics ? '<p class="muted">Ni taxonomie ni diamètre mesuré : fréquent pour les petits NEO.</p>' : ''}
    <p class="muted">${links.join(' · ')}</p>
    ${orbitComparisonHtml(details)}
  `
}

export const NEO_CREDITS =
  'Données : NASA/JPL (CAD, SBDB, Sentry, Horizons) · ESA NEOCC · LTE\'s SsODNet VO service (IMCCE) · NASA NeoWs'
