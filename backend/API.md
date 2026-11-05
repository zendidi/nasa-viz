# API — NASA Viz backend

Base URL (dev): `http://localhost:8000`. The web client hits this through Vite's
`/api` proxy (`web/vite.config.js`); a Unity client should call it directly
with the full URL (configurable, e.g. a `NasaApiBaseUrl` field on a
ScriptableObject or a build-time constant).

All responses are normalized JSON — none of NASA's or wheretheiss.at's raw
field names or nesting leak through, so this contract stays stable even if
the upstream providers change their response shape. Every route is
`GET`, cached server-side, and CORS-enabled for `http://localhost:*` (see
`CORS_ALLOW_ORIGIN` in `.env`; a deployed Unity/WebGL build or a packaged
Quest APK doesn't need CORS at all — only browser clients enforce it).

On failure, every route returns HTTP 502 with
`{"error": "<message>", "source": "JPL Horizons"}` — `source` (since
2026-10-27) names the provider that failed, in words a viewer recognises
(`JPL Horizons`, `JPL SBDB`, `JPL`, `NASA NeoWs / JPL CAD`, `wheretheiss.at`…),
so a client can say *who* is down — instead of a 200 with partial data — treat any non-2xx as "no data this
tick", not a schema change.

## `GET /api/iss/position`

Cached 5s server-side. Poll at most every 5s from clients.

```json
{
  "latitude": -51.31,
  "longitude": -69.76,
  "altitude_km": 440.79,
  "velocity_kmh": 27523.33,
  "timestamp": 1788290449,
  "track": [[1788290449, -51.31, -69.76, 440.79], [1788290509, -50.9, -64.2, 440.6], "… 10 in all"]
}
```

`timestamp` is Unix seconds (UTC) of the position reading.

Since 2026-10-21 the response also carries **`track`**: ten samples a minute
apart, from `timestamp` on, each `[unix seconds, latitude °, east longitude °,
altitude km]` (wheretheiss.at `/positions`, computed from the TLE; one upstream
request either way). Interpolate it to place the ISS at the real "now" — the
flat reading alone is up to a poll interval old (~460 km a minute) — and draw
nothing once "now" is past the last sample. The flat fields are the first sample.

## `GET /api/neo?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD`

Both params optional (default: today → tomorrow). Range is capped at 7 days —
a wider range returns HTTP 400. Cached 1h server-side per date range (10 min
when a source was unavailable).

Three sources are queried and merged (see `docs/neo-jpl-ssodnet.md`):
**JPL CAD** (reference — keyless), **NASA NeoWs** (the only one on the
`api.nasa.gov` quota) and **ESA NEOCC** (independent orbit computation).
The union is returned: an object listed by a single source is still in
`objects`, with `comparison` saying who missed it and why.

```json
{
  "start_date": "2026-09-17",
  "end_date": "2026-09-18",
  "count": 27,
  "sources": {
    "jpl_cad": "ok", "nasa_neows": "ok", "esa_neocc": "ok",
    "jpl_sentry": "ok", "esa_risk_list": "ok"
  },
  "comparison": {
    "total": 27,
    "jpl_cad": { "found": 25, "missing": 2, "not_covered": 0, "unavailable": 0 },
    "nasa_neows": { "found": 11, "missing": 16, "not_covered": 0, "unavailable": 0, "mismatched": 0 },
    "esa_neocc": { "found": 4, "missing": 0, "not_covered": 23, "unavailable": 0,
                   "outside_jpl_uncertainty": 0, "different_date": 0 },
    "impact_risk_lists_disagree": 0
  },
  "objects": [
    {
      "id": "2026 RN4",
      "name": "(2026 RN4)",
      "designation": "2026 RN4",
      "estimated_diameter_km": { "min": 0.0139, "max": 0.031 },
      "diameter_measured": false,
      "is_potentially_hazardous": false,
      "is_sentry_object": false,
      "absolute_magnitude_h": 26.338,
      "close_approach": {
        "date": "2026-09-17",
        "datetime": "2026-09-17T07:36Z",
        "miss_distance_km": 6201683.8,
        "relative_velocity_kmh": 32045.09
      },
      "sources": ["jpl_cad", "esa_neocc"],
      "comparison": {
        "jpl_cad": { "status": "found" },
        "nasa_neows": { "status": "missing", "reason": "unknown" },
        "esa_neocc": {
          "status": "found",
          "distance_km": 6200297, "distance_diff_km": -1386.8, "distance_diff_pct": -0.0224,
          "jpl_uncertainty_km": 41973, "within_jpl_uncertainty": true,
          "date_diff_days": 0, "h_diff": 0.06, "v_rel_diff_kms": 0.0,
          "mismatches": []
        },
        "impact_risk_lists": { "jpl_sentry": false, "esa_neocc": false, "agree": true }
      }
    }
  ]
}
```

- `id` is the catalogue designation (objects outside NeoWs have no NeoWs id).
- `close_approach` is `null` when no source had approach data for the object;
  `datetime` is `null` when only ESA listed it (its lists carry no time of day).
  Times are TDB (≈ UTC + 69 s).
- Per-source `status`: `found`, `missing` (with a `reason`: `date_boundary`,
  `distance_boundary`, `catalogue_cutoff` — NeoWs only, object designated after
  2019, where its catalogue stops — or `unknown`), `not_covered` (outside that source's
  distance cap — 0.5 au for JPL/NeoWs, 0.05 au for ESA — or its date range),
  `unavailable`.
- `mismatches` lists fields two sources disagree on, as
  `{field, jpl_cad, nasa_neows|esa_neocc}`; JPL's value is the one used in the
  object above.
- A source being down degrades the feed (its `sources` entry is
  `"unavailable"`); HTTP 502 only when no close-approach source answered.

## `GET /api/neo/details?designations=2004 MN4,2026 NT2`

Per-object sheet, from JPL SBDB + IMCCE SsODNet ssoCard + ESA NEOCC + JPL
Sentry — all keyless, none on the NASA quota. 1 to 10 comma-separated
designations per call (same limit and validation as `/api/neo/positions`).
Cached server-side 7 days per object (1 day when unknown; not cached while
SBDB, ssoCard or Sentry is down — ESA is excluded from that check, see below).

```json
{
  "objects": {
    "2004 MN4": {
      "designation": "2004 MN4",
      "fullname": "99942 Apophis (2004 MN4)",
      "orbit_class": { "code": "ATE", "name": "Aten" },
      "is_pha": true,
      "absolute_magnitude_h": 19.09,
      "diameter_km": { "value": 0.34, "source": "ssocard" },
      "albedo": { "value": 0.3838, "source": "ssocard" },
      "taxonomy": { "class": "S", "complex": "S", "source": "ssocard" },
      "rotation_period_h": 27.38547,
      "density_kg_m3": null,
      "mass_kg": null,
      "moid_earth_au": 0.000107917,
      "orbit": {
        "epoch_jd": 2461200.5, "a_au": 0.9223592206975018, "e": 0.1911492279663492,
        "i_deg": 3.340996879880978, "node_deg": 203.8936514240762,
        "peri_deg": 126.6795706895841, "mean_anomaly_deg": 175.3304026592739,
        "period_days": 323.5553366891694, "q_au": 0.746, "ad_au": 1.0987
      },
      "orbits": {
        "sbdb": { "epoch_jd": 2461200.5, "a_au": 0.9223592206975018, "e": 0.1911492279663492, "…": "… same 10 fields as orbit" },
        "esa": {
          "epoch_jd": 2461200.5, "a_au": 0.9223592223762012, "e": 0.19114922446996477,
          "i_deg": 3.3409970023876, "node_deg": 203.8936387948748, "peri_deg": 126.67958271092,
          "mean_anomaly_deg": 175.33040226699205, "period_days": 323.55533757247844,
          "q_au": 0.7460509723362706, "ad_au": 1.0986674724161318,
          "moid_earth_au": 0.00010792914778217588, "orbit_type": "Aten", "is_pha": true,
          "solution": "ke1"
        },
        "ssocard": { "epoch_jd": 2461200.5, "a_au": 0.92235922, "e": 0.19114923, "…": "… same 10 fields as orbit" }
      },
      "orbit_comparison": {
        "compared": ["sbdb", "esa", "ssocard"],
        "same_epoch": true,
        "spread": {
          "a_au": 2.38e-9, "e": 5.53e-9, "i_deg": 4.00e-6, "node_deg": 2.24e-5,
          "peri_deg": 3.33e-5, "period_days": 1.25e-6, "mean_anomaly_deg": 2.27e-5
        },
        "worst": { "field": "peri_deg", "relative": 9.25e-8 }
      },
      "impact_risk": null,
      "sources": { "sbdb": "ok", "ssocard": "ok", "sentry": "not_found", "esa": "ok" },
      "links": { "jpl": "https://…", "ssocard": "https://…", "esa": "https://…" }
    },
    "2099 ZZ99": null
  }
}
```

- A `null` object means neither SBDB nor ssoCard knows it. Every other field
  can be `null` too — small NEOs usually have no taxonomy, diameter or albedo.
- `orbit` holds heliocentric ecliptic J2000 elements at `epoch_jd` (full
  precision), enough to propagate the orbit (two-body) client-side. **Unchanged**
  by the two fields below: SBDB's elements, or ssoCard's as a fallback when
  SBDB doesn't know the object — exactly as before ESA existed.
- `orbits` puts all three catalogues' own elements side by side, each `null`
  when that source has none. `orbits.sbdb` and `orbits.ssocard` are the exact
  same arrays as `orbit` falls back between — same shape, 10 fields each.
  `orbits.esa` adds four fields of its own: `moid_earth_au`, `orbit_type`
  (ESA's own class — `Aten`, `Apollo`, `Amor`…), `is_pha`, and `solution`
  (`"ke1"` or `"ke0"` — which ESA file actually answered, see below).
  ESA's download only resolves a **numbered** object by its number, not by a
  provisional designation (`des=2004 MN4` finds nothing for Apophis, `des=99942`
  does) — the server retries once with SBDB's own number when the first
  attempt (whatever designation this route was called with) comes back empty
  and SBDB has one, so this mostly self-heals; a direct caller still gets a
  faster answer asking for the number up front, same as SBDB's own `sstr`.
- ESA publishes elements as two files per object: `.ke1`, propagated to a
  common epoch (MJD 61200 = JD 2461200.5), and `.ke0`, at whatever epoch ESA
  last fit the orbit. The server asks for `.ke1` first and only falls back to
  `.ke0` when `.ke1` has nothing — `.ke1` is usually at (or very near) the
  same epoch SBDB and ssoCard already sit at, which is what makes
  `orbit_comparison` meaningful; `.ke0` can be years away.
- `orbit_comparison` is `null` when fewer than two sources have elements,
  otherwise `same_epoch` (see below), `spread` (max − min across the sources
  that publish each field; `null` per field when fewer than two of the
  *present* sources have it) and `worst` (the field with the largest
  **relative** deviation — spread ÷ |mean|, spread ÷ 360 for angles, which
  have no natural zero). Angles are compared **wrapped**: two nodes at
  0.0005° and 359.9995° are 0.001° apart, not 359.999°.
- `same_epoch` is `true` only when every compared source's `epoch_jd` agrees
  to within ~86 s. `mean_anomaly_deg` — the one element that moves day by
  day — is in `spread` **only** when `same_epoch` is `true`; otherwise it's
  `null` even if every source happens to publish it, because comparing it
  across epochs doesn't measure a disagreement, it measures the orbit having
  moved. Measured on this same Apophis sheet: at the shared epoch (`.ke1`
  above) every field's spread sits at 1e-6–1e-9 relative; swap in ESA's
  `.ke0` instead (8 years earlier) and `a_au` alone jumps to a 2e-4 spread
  (~2e-4 relative) — not a bigger disagreement, just a bigger epoch gap.
- `impact_risk`, when the object is monitored by Sentry:
  `{probability, palermo_cum, palermo_max, torino_max, n_impacts, range}`.
- `sources.esa` and `links.esa` follow the same `"ok"`/`"not_found"`/`"unavailable"`
  convention as the other three, but ESA never counts toward the "don't cache
  an incomplete sheet" rule above, and never makes this route answer HTTP 502
  on its own — it's a bonus comparison point the sheet doesn't depend on.
- HTTP 502 only when both SBDB and ssoCard are unreachable.

## `GET /api/small-body/search?q=Apophis`

Resolves a name or designation to one **asteroid** (any non-comet small body,
not only NEOs — hence not under `/api/neo`) through JPL SBDB. Keyless: spends
no NASA quota. `q` accepts a name (`Apophis`), a number (`99942`), a
provisional designation (`2004 MN4`, `2004MN4`) or an SPK-ID (`20099942`).

`q` is trimmed and inner spaces collapsed; 1 to 40 characters among letters,
digits, space and `' / ( ) . -`. No `*` — the route adds it itself. Anything
else is HTTP 400 `{"error": …}`.

Three shapes, always HTTP 200:

```json
{"match": {"spkid": "20099942", "des": "99942", "fullname": "99942 Apophis (2004 MN4)",
           "shortname": "99942 Apophis", "kind": "an", "neo": true, "pha": true,
           "orbit_class": {"code": "ATE", "name": "Aten"}, "orbit_id": "220"}}

{"match": null, "candidates": [{"pdes": "1862", "name": "1862 Apollo (1932 HA)"}], "count": 7}

{"match": null}
```

- `neo` and `pha` are SBDB's own flags (`neo`: perihelion < 1.3 au); any field
  SBDB doesn't give is `null`. `spkid` is a string. It changes when an object
  gets numbered (`5xxxxxxx` → `2xxxxxxx`), so don't store it long-term.
- `orbit_id` (string, added 2026-11-05) is SBDB's id of the orbit solution the
  object's tables are computed from (`orbit.orbit_id`, else `object.orbit_id`;
  `null` if neither). A solution changes with new observations (2026 TP128:
  `orbit_id 1`, solution of 2026-10-23), so the trajectory routes key their
  cache on it. An entry cached before this field existed has `orbit_id: null`
  until its 1-day TTL runs out.
- Lookup order: `sstr=q`; if SBDB says "not found", **one** retry with `q*`
  (`Apo` → 7 candidates). A single hit on either is a `match`.
- `candidates` is capped at 20; **`count` is the total of non-comet
  candidates SBDB found**, so `count > candidates.length` means "refine your
  query". `{pdes, name}`: pass `pdes` back as `q` to get the match.
- **Comets are out of scope for now.** A query that resolves to a comet answers
  `{"match": null, "rejected": {"reason": "comet", "fullname": "1P/Halley"}}`;
  comets (`1P`, `73P-B`, `C/…`, `P/…`, `D/…`, `X/…`, `I/…`) are dropped from
  `candidates` and from `count`. A list made only of comets is `{"match": null}`.
  `A/2017 U1`-style designations are asteroids and are kept.
- Cache: match and candidates 1 day, `rejected` 1 day, nothing found 1 hour;
  keyed on the normalised query, case-insensitive.
- HTTP 502 when SBDB is unreachable, answers 5xx or sends garbage — never
  cached. (SBDB answers an ambiguous query with HTTP 300 and a body; that is
  handled, not an error.)

## `GET /api/small-body/positions?spkid=20099942`

> **Replaced (2026-11-05) by `trajectory` + `precision` below; kept as is for
> compatibility.** The web no longer calls it.

Precise geocentric position table for **one** tracked **asteroid** (any
non-comet small body; NEO-only behaviour is flagged below). Outside `/api/neo`
on purpose: Horizons, SBDB and CAD are all keyless, so this spends no NASA
quota. Get SPK-IDs from `/api/small-body/search`.

- `spkid`: exactly one, `^\d{7,8}$` (the same id repeated counts as one).
  Anything else is HTTP 400 `{"error": …}`. The web client tracks up to 5
  asteroids and asks for each in **its own call** — see the cold cost below.
- **Window = the planets' window** (`/api/solar-system/positions`): `window.start`
  is three months before the 1st of the current UTC month, `window.end` is a
  year after that 1st, so the web clock bounds line up. Tables start at
  `window.start`.
- Table step depends on the object: **1 hour for a NEO** (`neo: true`, ~11 000
  rows, ~360 kB of JSON), **1 day for any other asteroid** (~460 rows).
  Measured: an interpolated daily table is ~14 km off for any asteroid at
  180 million km or more, but 34 290 km off at 40 000 km; hourly is 61 km off
  at 40 000 km.
- **NEO only**: `segments` are 5-minute tables, approach −12 h to +12 h (start
  floored to a 5-minute boundary, stop rounded up to one), one for each
  in-window approach closer than **0.0005 au** (~75 000 km), at most 10 (the
  closest if there are more, returned in time order). The hourly table gives
  up below ~100 000 km (2 442 km off at 7 500 km); 5 minutes brings it to
  16 km. A client uses a segment when the instant falls inside it, the base
  table otherwise.
- **NEO only**: `close_approaches` (JPL CAD, closer than 0.05 au, inside the
  window, by time) and `next_close_approach_after_window` (the first one at or
  after `window.end`, or `null`). `time` is Unix **UTC**: CAD's own dates are
  TDB and 69.184 s are subtracted. `dist_*_km` use 1 au = 149 597 870.7 km;
  `t_sigma` is CAD's formatted time uncertainty.

```json
{
  "frame": "ICRF geocentric", "units": "km", "time_scale": "UTC",
  "window": {"start": 1782864000, "end": 1822348800},
  "objects": {
    "20099942": {
      "spkid": "20099942", "des": "99942", "fullname": "99942 Apophis (2004 MN4)", "neo": true,
      "table": {"start": 1782864000, "step_seconds": 3600, "positions": [[x, y, z], …]},
      "segments": [{"start": 1792031700, "step_seconds": 300, "positions": [[x, y, z], …]}],
      "close_approaches": [{"time": 1792075131, "dist_km": 7489.3, "dist_min_km": 7475.7,
                            "dist_max_km": 7502.9, "v_rel_km_s": 21.49, "t_sigma": "00:02"}],
      "next_close_approach_after_window": {"time": 1870811104, "dist_km": 38000000.0, …}
    }
  }
}
```

- Positions are integer km, ICRF, Earth-centred, like every other table here.
  `time_scale` is `"UTC"` — reject a response that says otherwise.
- A non-NEO has `segments: []`, `close_approaches: []`,
  `next_close_approach_after_window: null`.
- An object is `null` when SBDB has no match for the SPK-ID (also a comet, which
  `search` refuses) or Horizons returns no table. `objects` is keyed by SPK-ID
  as sent.
- `close_approaches: null` on a NEO means **CAD failed for that object**: the
  table is served anyway, without approaches or segments, and that object is
  **not cached**, so the next call retries it.
- Cache per object, key = SPK-ID + window start + time scale: 1 day; a `null`
  object 1 hour. The SBDB lookup reuses the search route's cache.
- HTTP 502 when Horizons or SBDB is unreachable — nothing cached.
- Cold cost (measured 2026-10-27, when the route still took up to 5 ids):
  2 objects 10 s, 3 NEOs + 2 others 18 s, **5 NEOs 26.8 s** against PHP's
  30 s wall — Horizons doesn't compute a batch in parallel. Hence one asteroid
  per call: ~7-10 s cold for a NEO, 0.1 s warm.

## Trajectory tool of the tracked objects (lot 2, 2026-11-05)

Three routes sharing one range, **6 fixed calendar years**: with Y the current
UTC year, `range.start` = 1 January Y−1 00:00 UTC, `range.end` = 1 January Y+5
00:00 UTC (always −1 / +4 years around now; moves only on 1 January). Daily rows,
both ends included: **2 192 rows** for 2025 → 2031 (2 193 when the range holds
two leap days). Tracked objects are any asteroid; a tracked object may also be a
NEO (`neo: true`) — this is not the "NEO of the week" of `/api/neo`. All keyless
(Horizons, SBDB, CAD): no NASA quota. Positions are integer km, ICRF,
Earth-centred, UTC, as everywhere; `time_scale` is `"UTC"`. No `Cache-Control`
header yet (lot 3).

**Cache** (all three): an asteroid's table is not immutable, its orbit solution
moves with the observations, so the key holds the **`orbit_id`** of
`/api/small-body/search`. Keys: trajectory = SPK-ID + Y + `orbit_id` + time
scale; precision = SPK-ID + `year` + `orbit_id` + time scale; sun = Y + time
scale. TTL 30 days (`orbit_id` null → 1 day); an object that is `null` → 1 hour;
a CAD failure → served, **not cached**. Since the search is cached 1 day, a new
orbit solution is picked up within a day.

### `GET /api/small-body/trajectory?spkid=20099942`

- `spkid`: exactly one, `^\d{7,8}$`, else HTTP 400 `{"error": …}`.
- `objects.<spkid>` is `null` when SBDB doesn't know the id (or it's a comet) or
  Horizons has no table.
- One Horizons call, daily table over the whole range (measured 2026-11-05:
  1.4–1.5 s at Horizons; 2.1 s cold end to end, 0.06 s warm; ~68 kB served).
- **NEO only**: `close_approaches` = JPL CAD (< 0.05 au) with `range.start` ≤
  time < `range.end`, by time, same fields as `positions`;
  `next_close_approach_after_range` = the first one at or after `range.end`, or
  `null`. A non-NEO has `[]` and `null`. `close_approaches: null` = CAD failed:
  table served, object not cached.

```json
{"frame": "ICRF geocentric", "units": "km", "time_scale": "UTC",
 "range": {"start": 1735689600, "end": 1924992000},
 "objects": {"20099942": {
   "spkid": "20099942", "des": "99942", "fullname": "99942 Apophis (2004 MN4)",
   "neo": true, "orbit_id": "220",
   "table": {"start": 1735689600, "step_seconds": 86400, "positions": [[x, y, z], …]},
   "close_approaches": [{"time": 1870811104, "dist_km": 38000000.0, "dist_min_km": …,
                         "dist_max_km": …, "v_rel_km_s": …, "t_sigma": "00:02"}],
   "next_close_approach_after_range": null}}}
```

### `GET /api/small-body/precision?spkid=20099942&year=2029`

Precise table of **one NEO for one calendar year** (the client swaps it in for
the daily one when the clock enters that year).

- `spkid` as above. `year`: an integer (digits only) in **[Y−1, Y+4]**, else
  HTTP 400.
- **Non-NEO**: HTTP 200 with `table: null`, `segments: []` and no upstream call
  (the client keeps the daily table).
- **NEO**: `table` is **hourly** (`step_seconds` 3600) from 1 January `year`
  minus 2 h to 1 January `year`+1 plus 2 h: two overlap rows each side so the
  client's Catmull-Rom is continuous where two years meet; 8 765 rows in a
  normal year (8 789 in a leap one). `table.start` is the first real instant
  (31 December 22:00 UTC). Measured: 2.0–2.3 s at Horizons per year (Bennu
  3.5 s); 3.7 s end to end for Apophis 2029 (with its segment); 260 kB served.
- **NEO**: `segments` are 5-minute tables, approach ±12 h, for the CAD
  approaches closer than **0.0005 au** whose instant falls in
  [1 January `year`, 1 January `year`+1) — the same rules as `positions`
  (start floored / stop rounded up to 5 min, at most 10, closest kept, in time
  order). A segment may overflow onto the neighbouring year: intended. Measured
  2026-11-05: over six calendar years no object has more than one such pass.
  `segments: null` = CAD failed: table served, object not cached.
- `objects.<spkid>` is `null` when SBDB doesn't know the id or Horizons has no
  table.

```json
{"frame": "ICRF geocentric", "units": "km", "time_scale": "UTC", "year": 2029,
 "objects": {"20099942": {
   "spkid": "20099942", "des": "99942", "fullname": "99942 Apophis (2004 MN4)",
   "neo": true, "orbit_id": "220", "year": 2029,
   "table": {"start": 1861912800, "step_seconds": 3600, "positions": [[x, y, z], …]},
   "segments": [{"start": 1870000000, "step_seconds": 300, "positions": [[x, y, z], …]}]}}}
```

### `GET /api/small-body/trajectory/sun`

> **Remplacée (2026-11-05, lot 3).** Le web ne l'appelle plus : l'outil de trajectoire lit
> la table assemblée du Soleil de la scène (tranches `year=` de `/api/solar-system/positions?body=sun`).
> La route reste servie, inchangée.

The Sun's daily **geocentric** table (Horizons body `10`, centre `500@399`, UT /
ICRF like the planets') on the same 6-year range: lets the web go heliocentric
and place "the Earth at the object's instant".

```json
{"frame": "ICRF geocentric", "units": "km", "time_scale": "UTC",
 "range": {"start": 1735689600, "end": 1924992000},
 "table": {"start": 1735689600, "step_seconds": 86400, "positions": [[x, y, z], …]}}
```

HTTP 502 `{"error", "source": "JPL Horizons"}` when Horizons is down or has no
table; not cached. Cache 30 days (key: Y + time scale). 1.5 s cold, 69 kB.
`/trajectory/sun` and `/trajectory` are distinct literal paths.

## `GET /api/neo/positions?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD&designations=2026 RB39,2021 LC`

Real geocentric positions of NEOs over the feed's date range, from JPL
Horizons — keyless, **not on the NASA quota** (the path starts with `/api/neo`,
so `.claude/hooks/quota-guard.sh` still blocks it from the shell; that is the
guard being broad, not this route spending quota). The web scene uses it to
place each NEO of the feed on its real path rather than on a schematic one.

- `start_date`, `end_date`: required, `YYYY-MM-DD`, `end_date` within 7 days
  after `start_date` — the same window as `/api/neo`. Otherwise a 400.
- `designations`: 1 to 10 comma-separated catalogue designations, each
  `[A-Za-z0-9 /-]{1,40}`, deduplicated. Otherwise a 400. Passed to Horizons as
  `COMMAND='DES=…;'`.

```json
{
  "frame": "ICRF geocentric",
  "units": "km",
  "step_seconds": 3600,
  "objects": {
    "2026 RB39": {
      "start": 1789171200,
      "positions": [[-1234567, 2345678, -345678], [-1230000, 2350000, -346000]]
    },
    "2021 LC": null
  }
}
```

- `objects` is a dictionary keyed by the designation **as sent**, one entry
  per requested designation.
- `positions` is a table of `[x, y, z]` in km, ICRF equatorial, Earth-centred
  — the same frame as `/api/solar-system/positions`. Sample *n* is at
  `start + n * step_seconds` (Unix seconds, **UTC**). Hourly step, from
  `start_date` 00:00 to the day **after** `end_date`, so the last day of the
  feed is fully covered. Interpolate linearly between the two samples around
  the moment shown.
- An entry is `null` when Horizons returned no vector table for that
  designation — no match (typically an object too recent for JPL's database)
  or several. Cached server-side 1 day per
  object and date range; a `null` only 1 hour, in case JPL catches up.
- HTTP 502 when Horizons itself can't be reached — nothing is known about any
  object then.

## `GET /api/solar-system/positions?body=mars&year=2027` (ou `body=sun`, `body=moon`)

### Avec `year=` (lot 3, 2026-11-05) : la tranche annuelle

`year` est un entier dans `[Y−1, Y+4]` (`Y` = année UTC courante), sinon **HTTP 400**
`{"error": "year must be between <Y−1> and <Y+4>"}` (non entier, vide, négatif : idem). Une
**tranche** = un corps × une année civile UTC, immuable ; les six années couvrent du 1/1 (Y−1) au
1/1 (Y+5) 00:00 UTC, donc toujours [maintenant −1 an, maintenant +4 ans].

```json
{
  "frame": "ICRF geocentric",
  "time_scale": "UTC",
  "units": "km",
  "year": 2027,
  "slice_start": 1798761600,
  "slice_end": 1830297600,
  "start": 1798588800,
  "step_seconds": 86400,
  "bodies": [{ "id": "mars", "name": "Mars", "radius_km": 3389.5,
               "equatorial_radius_km": 3396.19, "polar_radius_km": 3376.2,
               "positions": [[-129867207, 42071540, 26713933], "…"] }]
}
```

- `slice_start` = 1/1 `year` 00:00 UTC, `slice_end` = 1/1 `year`+1 00:00 UTC (secondes Unix).
- **Recouvrement : 2 lignes de chaque côté.** `start` = `slice_start − 2 × step_seconds` = instant de
  `positions[0]` ; la dernière ligne est à `slice_end + 2 × step_seconds`, bornes incluses. Une tranche
  lue seule est donc en Catmull-Rom complet sur toute son année. Mars 2027 : 370 lignes (365 + 4 + 1).
- Pas = 1 j, sauf `moon`, `mercury`, `venus` à 6 h (21 600 s ; Lune 2028, bissextile : 1 469 lignes).
- `positions` : `null` si Horizons n'a rien donné (gardé 1 h).
- Cache serveur : une entrée par corps × année, clé `solar_system_<id>_y<year>_<step>_UTC_o2`, valeur
  non nulle gardée 3 ans (immuable), nulle 1 h, échec de transport jamais gardé (502). **Aucun
  en-tête `Cache-Control`** : un cache HTTP immuable empêcherait le client de se réparer après avoir
  refusé une tranche (leçon du 2026-09-29). Une tranche coûte 1,0 à 1,2 s à Horizons ; 51 ko bruts au
  pas de 1 j, 188 ko à 6 h (mesuré 2026-11-05).
- `app:solar-system:warm` préchauffe ces tranches (voir plus bas).

### Sans `year=` : **remplacée** (lot 3)

> Le web ne l'appelle plus ; la fenêtre mensuelle ci-dessous reste servie à l'identique.

One planet's real geocentric positions, from JPL Horizons — keyless, not on
the NASA quota. `body` is required and must be one of `mercury`, `venus`,
`mars`, `jupiter`, `saturn`, `uranus`, `neptune`, `pluto`, `sun`, `moon`; anything else is a 400
listing them. Cached server-side 40 days per planet.

```json
{
  "frame": "ICRF geocentric",
  "time_scale": "UTC",
  "units": "km",
  "start": 1788220800,
  "step_seconds": 86400,
  "bodies": [
    {
      "id": "mars",
      "name": "Mars",
      "radius_km": 3389.5,
      "positions": [[-62375421, 246373087, 109612684], [-63000000, 246100000, 109500000]]
    }
  ]
}
```

- `positions` is a table of `[x, y, z]` in km, ICRF equatorial, Earth-centred
  — the same frame as `/api/neo/positions`. Sample *n* is at
  `start + n * step_seconds` (Unix seconds, **UTC**). About 458 samples: a
  daily step from three months back to a year ahead (the Moon, Mercury and Venus
  every 6 h, about 1 830 samples — see `body=moon`). Interpolate linearly between the two samples around
  "now" — measured worst case on Mars is 5 645 km, 0.002 % of its distance.
- `start` is **the first of the UTC month three months back** (since 2026-10-27,
  `SolarSystemClient::HISTORY_MONTHS`, so a client clock can run backwards), and
  the table ends a year after the first of the *current* month. Never the day of
  the call: planets are fetched one at a time, and this is what makes their
  tables line up sample for sample anyway. A table therefore always covers "now"; it does
  not need refetching until it nears its end, roughly eleven months later.
- **One body per call**, on purpose: a Horizons ephemeris request costs 5 to
  16 s whatever its size (measured 2026-09-22), so asking for several at once
  overruns PHP's execution limit. Fetch them in sequence and draw each as it
  lands rather than waiting for the set.
- `positions` is `null` when Horizons didn't answer for that planet — served
  as-is, and retried an hour later rather than cached for the month.
- The **Earth is deliberately absent**: it is this frame's origin, so its table
  would be 366 zeroes. A client centred on something else places it from the
  Sun's position it already computes.
- `radius_km` is the IAU 2015 mean radius, carried so every client sizes a
  planet from one table instead of each keeping its own. It is a constant —
  cache it with the positions rather than refetching for it.


### `time_scale` (every Horizons-backed route, since 2026-10-21)

`/api/solar-system/positions`, `/orbit`, `/moons` and `/api/neo/positions` all
carry `"time_scale": "UTC"`, and their tables are asked of Horizons with
`TIME_TYPE='UT'`. Until 2026-10-21 they were TDB — Horizons' default for vector
tables — while every client read `start` as Unix seconds: the whole scene ran
**69,184 s late**, ~2 000 km on every planet, 10 to 200 times the interpolation
error (measured against Horizons on 49 bodies). A client that caches tables
should reject any stored without `time_scale: "UTC"`; the server's own cache keys
carry the scale, so it never serves an old TDB table.

### `body=moon`

Same shape as the Sun's, on a **6-hour step** (`step_seconds: 21600`, 1 461
samples): the Moon turns 13° a day, and Catmull-Rom on a daily table cost 320 km
at worst (3′ from the Earth). At 6 h: 1,9 km at worst, 0,9 km median, ~1″
(50 instants over the year, 2026-10-21). `radius_km` is 1 737,4. It replaces the
web client's low-precision series, which was 0,38° (2 500 km) off on median —
three quarters of it the precession since J2000, as for the Sun below. Not
accepted by the orbit or moons routes.

### `body=sun`

The Sun rides on this route because its table has exactly a planet's shape:
geocentric, ICRF, daily, a year long, renewed monthly. `radius_km` is 695 700 (IAU 2015 nominal; 696 340 until 2026-10-21). Every body also carries `equatorial_radius_km` and `polar_radius_km` (IAU 2015) — equal to `radius_km` for a body drawn as a sphere.

It is served at all because the web client used to compute the Sun from a
low-precision series working in the **equinox of date**, where the scene's axes
are J2000. Measured 2026-09-29: 956 143 km apart, 0,3656° — the precession
accumulated since J2000, and growing (1 017 187 km by mid-2027). That single
error sat under the terminator on the globe, the Moon's phase, every body drawn
in the heliocentric view, and the planet orbits. One table fixes them together,
for one keyless request a month.

`?body=sun` is **not** accepted by the orbit route: the Sun has no orbit to draw
here, and `planetIds()` is what those routes validate against.

## `GET /api/solar-system/orbit?body=mars&year=2027`

**Avec `year=` (lot 3, 2026-11-05)** : même réponse que ci-dessous plus `"year": 2027`, mais la
période sidérale part du **1/1 `year` 00:00 UTC** (`start` = cet instant). Mêmes règles de `year` que
les positions (400 hors [Y−1, Y+4]). Mesuré : avec une époque au 1/1 de l'année affichée, la planète
s'écarte de son trait de 993 km au plus dans l'année (Mercure ; Vénus 1 425, Mars 103, Jupiter 311) ;
hors de la période, notamment avant l'époque, Jupiter quitte son trait de 352 687 km, Saturne
844 874, Uranus ~1,2 Mkm. Cache : clé `solar_system_orbit_<id>_y<year>_UTC_360`, même politique que
les positions. **Sans `year` : remplacée**, le web ne l'appelle plus ; la fenêtre mensuelle
ci-dessous reste servie à l'identique.

One planet's whole orbit as a polyline — 361 samples over one sidereal period.
**Planets only**: the Sun is served by the positions route but has no orbit to
draw here. Same one-per-call rule as the route above. Cached server-side 40 days
per planet.

```json
{
  "frame": "ICRF heliocentric",
  "units": "km",
  "body": { "id": "mars", "name": "Mars", "radius_km": 3389.5, "period_days": 686.98 },
  "start": 1788220800,
  "stop": 1847583060,
  "positions": [[-62375421, 246373087, 109612684], "… 361 in all"]
}
```

- Sample *k* is at `start + k/360 × (stop − start)`. `stop` is exactly the
  value sent to Horizons (truncated to the minute, which is all it reads), so
  a client can date every sample without re-deriving the period.
- **The samples are heliocentric since 2026-09-29.** They used to be geocentric
  on purpose, so a client could subtract *its own* Sun and have the line pass
  through its own planet by cancellation even though that Sun was 951 057 km off.
  Now that `?body=sun` serves the Sun from the same DE441 tables, there is
  nothing left to cancel — and the subtraction was never possible here anyway,
  these samples spanning a whole sidereal period (165 years for Neptune) where a
  Sun table covers one. The curve is DE441's true ellipse and passes through the
  planet by construction. A client must **not** subtract anything from it.
- `start` is the first of the current UTC month, and the window is exactly one
  sidereal period — so "now" is always inside it (at most 31 days past the
  start, against Mercury's 88-day period). That is what makes the line pass
  through the planet.
- 360 intervals is 1° of arc per segment. Raised from 180 on 2026-09-29, for one
  request either way (the Horizons cost is per request, not per point) and about
  12 ko more. Measured worst miss between a planet and its own line, over 200
  instants: Mars 32 127 → 7 781 km, Jupiter 113 844 → 28 443, Neptune 529 228 →
  170 850 — the factor of 4 the 1/N² chord law predicts.
  **Mercury does not improve** (53 230 → 55 722 km): its miss is not the chord
  but its own daily *position* table, since near inferior conjunction it is
  0,55 au away and sweeps ~4° a day. Only a finer positions step would help it.
- Neptune's 165-year orbit fits in one request because Horizons reads a
  *unitless* `STEP_SIZE` as a number of intervals, not a duration.
- **Pluto (248 years, step 251,6 days)** goes through the same path — 361 samples,
  90 560 d, `stop` in 2274 for a 2026 start — but is drawn from the **Pluto-system
  barycentre** (Horizons id `9`, DE441) and not from the body (`999`): the body's
  ephemeris (plu060) ends on 2199-12-29 and Horizons answers *"No ephemeris for
  target Pluto after A.D. 2199"* for a full period. The two differ by Pluto's
  wobble around the Pluto-Charon barycentre, ~2 100 km, against a chord error
  of the order of 10^5 km: invisible. Positions stay on `999`.
- The curve does **not** close exactly: the orbit precesses between the first
  and the last sample. That is correct, not a gap to stitch.
- `positions` is `null` when Horizons didn't answer; retried an hour later.

## `GET /api/solar-system/orientation?body=mars&year=2027`

**Avec `year=` (lot 3, 2026-11-05)** : même réponse que ci-dessous plus `"year": 2027`, `epoch` = 1/1
`year` 00:00 UTC. Mêmes règles de `year` (400 hors [Y−1, Y+4]). Mesuré : planètes ≤ 0,016° sur 6 ans,
saut au 1/1 ≤ 0,005° ; Lune, pôle jusqu'à 1,98° d'une époque fixe contre 0,54° dans l'année avec
une époque au 1/1 (saut ≈ 0,5° pôle, ≤ 0,56° méridien). Cache : clé
`solar_system_orientation_<id>_y<year>`. **Sans `year` : remplacée**, le web ne l'appelle plus ; le
comportement mensuel ci-dessous reste servi à l'identique.

How one body is turned in space. `body` takes the nine planets (Pluto included) **and `moon`** —
not `sun`, which is not a rigid body and whose surface rotates differentially.

The Moon is here rather than in the moons route because what it needs is exactly
this: the moons route serves positions. It is not in `/api/solar-system/positions`
either — `?body=moon` still answers 400 — so that nothing fetches a monthly
position table no client reads.

```json
{
  "frame": "ICRF",
  "epoch": 1788220800,
  "bodies": [
    {
      "id": "mars",
      "name": "Mars",
      "radius_km": 3389.5,
      "pole": [0.4461232671746381, -0.4066230851490753, 0.7972651360176702],
      "prime_meridian": [-0.29797746863881497, -0.90748764180815, -0.29610067232123427],
      "rotation_deg_per_day": 350.891982443297
    }
  ]
}
```

- `pole` — the north pole, an **ICRF unit vector**, so already in the scene's
  axes: nothing to convert.
- `prime_meridian` — where the body's zero of longitude pointed at `epoch`, also
  an ICRF unit vector, and perpendicular to `pole` to 1e-16.
- `rotation_deg_per_day` — **signed**. Negative for Venus (−1,48) and Uranus
  (−501,16), which turn backwards. **Pluto is +56,3625** although it also turns
  backwards against its orbit: the IAU pole it is given (RA 132,993°, Dec −6,163°)
  is the one it rotates prograde about, so that is already in `pole`. Rotate
  `prime_meridian` about `pole` by the signed rate, as for any body.
- `epoch` — first of the current UTC month, the same anchor as the positions and
  orbit routes.

**To orient a body at time t**, point its north at `pole` and rotate
`prime_meridian` about `pole` by `rotation_deg_per_day × (t − epoch, in days)`.
That is all; the propagation is exact rather than approximate, because a rigid
body turns at a constant rate about a fixed axis.

### Why vectors and not the angles Horizons publishes

Horizons gives a pole as RA/Dec and a phase as `ObsSub-LON`, and turning those
into an orientation has two traps that every client would otherwise have to fall
into separately:

- **The sign of the longitude.** IAU planetographic longitude is counted
  *opposite* to the rotation, so the sub-Earth longitude grows at |rate|
  whichever way the body turns — but the direction it must be applied in flips
  with the sign of the rate. **And the Moon breaks even that rule**: it turns
  prograde and its longitudes are still counted *east*, the exception the IAU
  grants the Earth, the Moon and the Sun — which is why its gazetteer runs
  0–360° E and Mare Crisium sits at 59° E. Reading it as an ordinary prograde
  body put the reconstruction **12°** out.
- **The light-time correction.** `ObsSub-LON` describes the body at the instant
  the light *left* it, while the positions route serves geometric positions
  (Horizons `VECTORS` is uncorrected). Ignoring that draws Jupiter's surface as
  it stood 49 minutes ago — **29,8°** of rotation — and Uranus's **54,7°** off.

Both are handled server-side once. `PlanetOrientationClient` documents them, and
its test replays real Horizons ephemerides for Mars, Jupiter, Venus, Uranus and
the Moon and checks the reconstruction reproduces `ObsSub-LON` over 40 days to
**1e-3 degree** — **1e-2 for the Moon**, the only body here whose IAU rotation is
not a straight line (thirteen periodic terms in `W`, and a pole that moves 0,26°
in R.A. over those forty days where Mars's moves 5e-5). The four bodies are chosen so that no single sign error passes: Uranus
is the only one both retrograde *and* far enough for the light-time term to
matter, and it is the only row that caught applying that term with the signed
rate instead of its absolute value — a live bug worth 2,34° of drift that Mars,
Jupiter and Venus all failed to notice.

### Cost

**One Horizons request per planet per month**, and a cheap one: a two-row
`EPHEM_TYPE=OBSERVER` table answers in well under a second, where the 366-row
vector tables of the positions route take 5 to 16 s. The pole is treated as
fixed over the month — Mars's moved five units in the fifth decimal over 40 days
— and the phase is propagated rather than sampled, which no table could do
anyway: Jupiter turns 2,4 times between two daily samples.

Cached on the same shape as the other solar-system routes: the key carries the
window, the TTL only has to outlive the month, and a body Horizons didn't answer
for comes back as `null` vectors and is retried within the hour.

## `GET /api/solar-system/moons?planet=jupiter`

Every moon of one planet in a single response. `planet` takes the same values as
the two routes above; Mercury and Venus answer `{"moons": [], "missing": 0}`,
which is the truth and not an error. The Earth's Moon is **not** served here —
the web client computes it locally and it costs no request at all.

At most 9 moons per planet: all of them when the planet has 9 or fewer (Mars),
otherwise the 9 largest. Pluto has Charon alone (the four small ones are 5 to 20 km). 39 bodies in all.

```json
{
  "frame": "ICRF, centred on the planet",
  "units": "km",
  "planet": "jupiter",
  "missing": 0,
  "moons": [
    {
      "id": "ganymede",
      "planet": "jupiter",
      "name": "Ganymede",
      "radius_km": 2634.1,
      "orbit_km": 1070400,
      "start": 1789483860,
      "step_seconds": 13740,
      "covers_full_orbit": true,
      "orbit_samples": 46,
      "positions": [[-1064661, 45253, 16880], "… up to 500 in all"]
    }
  ]
}
```

- **Positions are relative to the planet, not to the Earth.** Every other route
  here is geocentric; this one is not, because a client draws a moon while
  centred on its planet and would otherwise have to subtract a number it already
  has. Same ICRF axes as everything else, so no frame conversion either way.
- **`missing` is the contract.** Non-zero means "call me again": the route
  fetches **at most one** absent moon per call and serves the rest from cache.
  That keeps the worst case to a single Horizons request inside PHP's 30 s limit
  — the same wall that forced one-body-per-call on the planet routes, where two
  bodies at once measured 31.6 s and returned an 80 kB HTML error page. A cold
  cache therefore converges in as many calls as the planet has moons; a warm one
  answers everything at once, in ~85 ms for Jupiter's nine (77 kB).
- `missing` also counts a moon Horizons had nothing for, so a client must cap its
  retries rather than loop on it.
- **Sampling is per moon, and the window follows from it.** The step is about a
  45th of the orbital period, rounded to whole minutes — a coarser one is not a
  matter of taste: sampled daily, Io lands 509 065 km out, 120 % of its orbital
  radius, i.e. on the wrong side of Jupiter. The window is then 500 samples' worth
  or one year, whichever is shorter. Fast moons hit the budget (Phobos: 10-minute
  step, 3.5-day window); slow ones hit the year cap and carry far fewer samples
  (Halimede: 41.8-day step, 9 samples). Sample *k* is at
  `start + k × step_seconds`.
- Since the Horizons cost is per *request* and not per point, a fine step is free
  in latency and costs only bytes — which is why the budget is on points rather
  than on the window.
- **`covers_full_orbit` and `orbit_samples` hand the drawn orbit over for free.**
  An uncapped table spans about eleven orbits, so its first `orbit_samples`
  points are exactly one loop and no second request is needed. It is `false` for
  the four whose period outruns the one-year cap — Pasiphae, Phoebe, Sycorax,
  Halimede — where `orbit_samples` is `null` and no closed loop can be drawn.
  Their positions are still correct; only the décor is missing.
- `start` is bucketed on **half** the window, so a table handed out always has at
  least half its window of validity left, and every visitor of the same bucket
  shares one cached table. Cached server-side for the window plus a day.
- Keyless (JPL Horizons), so no NASA quota is spent. Pre-fill the cache with
  `php bin/console app:solar-system:warm` — see below.

### `php bin/console app:solar-system:warm`

Cron companion to the three solar-system routes. Fetches the planet tables and
the moons of planets a visitor has actually centred on, before anyone asks.

- **Since lot 3 (2026-11-05)** it warms the yearly `year=` slices for every year `Y−1` to `Y+4`:
  positions of the 10 bodies, orbits of the 8 planets, orientation of the 9 bodies of
  `PlanetOrientationClient::ids()` — skipping what is cached (cold ≈ 162 calls, then ≈ 27 on
  1 January). It no longer warms the monthly window. Moons: unchanged.

- **Lazy fill, eager refresh.** The route records which planets get looked at; the
  command refreshes only those. A moon nobody has ever looked at is never fetched,
  and a planet untouched for 90 days drops off on its own. `--all-moons` forces
  all 39 (use once after a deploy, not on a cron); `--dry-run` lists and fetches
  nothing.
- **It is a CLI command on purpose.** `max_execution_time` is 0 here against 30 s
  for a web request, so the one-body-per-call rule does not apply and it can work
  through forty bodies in one process — measured, Jupiter's eight remaining moons
  in 7 s.
- Always exits 0: an upstream failure is transient, the next run picks it up, and
  the routes still fall back to fetching on demand.

### `php bin/console app:cache:warm`

Cron companion to `/api/apod` and, optionally, `/api/neo`. Recomputes the cached
feed *before* it expires (shared `App\Service\CachedFeeds`, same keys and TTLs as
the routes), so no visitor pays the post-expiry latency.

- APOD is refreshed on every run (keyless, no NASA quota spent).
- `--neo` also refreshes the NEO feed for the default range. **Spends one NeoWs call
  per run** — 24 of `DEMO_KEY`'s 50/day on an hourly cron — so use it only with a
  real `NASA_API_KEY`.
- `--dry-run` lists what would be refreshed and calls nothing.
- A failed recompute keeps the previous cache entry. Always exits 0.

## `GET /api/apod`

Cached 24h server-side (one upstream call per day regardless of client traffic).

**Source changed on 2026-09-30, response shape did not.** NASA moved APOD from
`apod.nasa.gov` to `science.nasa.gov/apod` and left the old hostname serving a
certificate valid only for `*.go-vip.co`, so every URL the legacy API returned is
refused by any client that validates certificates. This route now reads
science.nasa.gov's WordPress REST API through `ApodClient`. Two consequences worth
knowing:

- **It costs no API key.** APOD no longer spends the shared `DEMO_KEY` budget;
  NeoWs, inside `/api/neo`, is the only route that still does.
- **The image host is `assets.science.nasa.gov`**, which resizes on demand — so
  `url` and `hd_url` are the same photograph at two widths rather than two
  separate files.

```json
{
  "title": "Arp 78: Peculiar Galaxy in Aries",
  "date": "2026-09-30",
  "explanation": "Peculiar spiral galaxy Arp 78 is found within the boundaries …",
  "media_type": "image",
  "url": "https://assets.science.nasa.gov/dynamicimage/assets/science/cds/apod/apod/2026/october/NGC772_Robert_Eder.jpg?w=960&fit=clip",
  "hd_url": "https://assets.science.nasa.gov/dynamicimage/assets/science/cds/apod/apod/2026/october/NGC772_Robert_Eder.jpg?w=2400&fit=clip"
}
```

- `url` is the panel-sized image (960 px wide, ~59 kB) and `hd_url` the same frame
  at 2400 px (~242 kB). Both carry `?w=&fit=clip`; ask for another width by
  changing `w` if a client needs one.
- `media_type` is **always `"image"`** since 2026-09-30. The new source carries no
  reliable media type, so on a day whose APOD is a video the `url` is the poster
  frame rather than an embed link. `hd_url` is therefore never `null`. The legacy
  API did distinguish videos; that is the one capability lost in the move, and it
  is in `docs/agent/backlog.md`.
- `explanation` is the astronomer's text only. The legacy field also carried the
  site's own banners (912 characters against 762 for 2026-09-29, the difference
  being submission and migration notices); those are stripped here.
- HTTP 502 when the upstream is unreachable, its answer is not JSON, or no APOD
  entry appears among the newest articles.

## Notes for the Unity client (not built yet)

- Use `UnityWebRequest.Get(url)` + `JsonUtility.FromJson<T>(...)`.
  `JsonUtility` can't parse a top-level JSON array, but every route here
  returns a top-level object, so that's not an issue. It also can't parse
  nullable value types or arbitrary dictionaries — model `close_approach` and
  `hd_url` as a reference type (e.g. a class, not a struct) so a missing/null
  value just leaves the field `null` instead of throwing.
- `objects` in `/api/neo` is a JSON array nested in a field — wrap it in a
  `[System.Serializable] class NeoFeed { public List<Neo> objects; ... }`
  rather than trying to deserialize the array directly.
- `objects` in `/api/neo/details` and `/api/neo/positions` is a *dictionary*
  keyed by designation, which `JsonUtility` can't parse — either use another
  parser (Newtonsoft JSON, bundled with Unity as `com.unity.nuget.newtonsoft-json`)
  for those two routes, or ignore them: `/api/neo` alone is enough for a list
  of objects with their approach data. `/api/solar-system/positions` has no
  such problem — `bodies` is a plain array, so `JsonUtility` handles it.
- `/api/solar-system/positions` is the one route worth calling on startup and
  then leaving alone: its tables cover a year and cost nothing in quota, so a
  VR client can fetch the nine planets once, keep them, and interpolate
  locally rather than polling.
- A VR client can ignore `comparison` entirely; it only says how the three
  sources agree. `sources` on an object is the cheap version: an object with a
  single entry was seen by a single catalogue.
- Poll `/api/iss/position` on a coroutine/timer no faster than every 5s —
  the server cache won't return fresher data anyway.
- Any hardcoded scaling of `altitude_km` (Earth radius ≈ 6371 km) for a
  visually-legible orbit is an artistic choice per client — the web viewer
  exaggerates it ~8x (see `web/src/main.js`); Unity is free to use its own
  scale for immersive navigation instead of matching the web viewer 1:1
  (per the "web = simple, VR = richer" decision in the root README).
