# API — NASA Viz backend

Base URL (dev): `http://localhost:8000`. The web client hits this through Vite's
`/api` proxy (`web/vite.config.js`); a Unity client should call it directly
with the full URL (configurable, e.g. a `NasaApiBaseUrl` field on a
ScriptableObject or a build-time constant).

All responses are normalized JSON — none of NASA's or wheretheiss.at's raw
field names or nesting leak through, so this contract stays stable even if
the upstream providers change their response shape. All three routes are
`GET`, cached server-side, and CORS-enabled for `http://localhost:*` (see
`CORS_ALLOW_ORIGIN` in `.env`; a deployed Unity/WebGL build or a packaged
Quest APK doesn't need CORS at all — only browser clients enforce it).

On failure, every route returns HTTP 502 with `{"error": "<message>"}`
instead of a 200 with partial data — treat any non-2xx as "no data this
tick", not a schema change.

## `GET /api/iss/position`

Cached 5s server-side. Poll at most every 5s from clients.

```json
{
  "latitude": -51.31,
  "longitude": -69.76,
  "altitude_km": 440.79,
  "velocity_kmh": 27523.33,
  "timestamp": 1788290449
}
```

`timestamp` is Unix seconds (UTC) of the position reading.

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
  `distance_boundary`, `unknown`), `not_covered` (outside that source's
  distance cap — 0.5 au for JPL/NeoWs, 0.05 au for ESA — or its date range),
  `unavailable`.
- `mismatches` lists fields two sources disagree on, as
  `{field, jpl_cad, nasa_neows|esa_neocc}`; JPL's value is the one used in the
  object above.
- A source being down degrades the feed (its `sources` entry is
  `"unavailable"`); HTTP 502 only when no close-approach source answered.

## `GET /api/neo/details?designations=2004 MN4,2026 NT2`

Per-object sheet, from JPL SBDB + IMCCE SsODNet ssoCard + JPL Sentry — all
keyless, none on the NASA quota. 1 to 10 comma-separated designations per call
(same limit and validation as `/api/neo/positions`). Cached server-side 7 days
per object (1 day when unknown; not cached while a source is down).

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
      "impact_risk": null,
      "sources": { "sbdb": "ok", "ssocard": "ok", "sentry": "not_found" },
      "links": { "jpl": "https://…", "ssocard": "https://…" }
    },
    "2099 ZZ99": null
  }
}
```

- A `null` object means neither SBDB nor ssoCard knows it. Every other field
  can be `null` too — small NEOs usually have no taxonomy, diameter or albedo.
- `orbit` holds heliocentric ecliptic J2000 elements at `epoch_jd` (full
  precision), enough to propagate the orbit (two-body) client-side.
- `impact_risk`, when the object is monitored by Sentry:
  `{probability, palermo_cum, palermo_max, torino_max, n_impacts, range}`.
- HTTP 502 only when both SBDB and ssoCard are unreachable.

## `GET /api/apod`

Cached 24h server-side (one NASA call per day regardless of client traffic).

```json
{
  "title": "A Plane Lunar Eclipse",
  "date": "2026-09-01",
  "explanation": "…",
  "media_type": "image",
  "url": "https://apod.nasa.gov/apod/image/2608/PlaneEclipse_Ferreira_1059.jpg",
  "hd_url": "https://apod.nasa.gov/apod/image/2608/PlaneEclipse_Ferreira_1059.jpg"
}
```

`media_type` can be `"image"` or `"video"` — a video APOD's `url` is a
YouTube/Vimeo embed link, not a direct media file; `hd_url` is `null` for
videos.

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
  of objects with their approach data.
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
