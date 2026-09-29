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

## `GET /api/solar-system/positions?body=mars` (ou `body=sun`)

One planet's real geocentric positions, from JPL Horizons — keyless, not on
the NASA quota. `body` is required and must be one of `mercury`, `venus`,
`mars`, `jupiter`, `saturn`, `uranus`, `neptune`; anything else is a 400
listing them. Cached server-side 40 days per planet.

```json
{
  "frame": "ICRF geocentric",
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
  `start + n * step_seconds` (Unix seconds, TDB ≈ UTC + 69 s). 366 samples: a
  daily step over a year. Interpolate linearly between the two samples around
  "now" — measured worst case on Mars is 5 645 km, 0.002 % of its distance.
- `start` is **the first of the current UTC month**, not the day of the call.
  Planets are fetched one at a time, and this is what makes their tables line
  up sample for sample anyway. A table therefore always covers "now"; it does
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


### `body=sun`

The Sun rides on this route because its table has exactly a planet's shape:
geocentric, ICRF, daily, a year long, renewed monthly. `radius_km` is 696 340.

It is served at all because the web client used to compute the Sun from a
low-precision series working in the **equinox of date**, where the scene's axes
are J2000. Measured 2026-09-29: 956 143 km apart, 0,3656° — the precession
accumulated since J2000, and growing (1 017 187 km by mid-2027). That single
error sat under the terminator on the globe, the Moon's phase, every body drawn
in the heliocentric view, and the planet orbits. One table fixes them together,
for one keyless request a month.

`?body=sun` is **not** accepted by the orbit route: the Sun has no orbit to draw
here, and `planetIds()` is what those routes validate against.

## `GET /api/solar-system/orbit?body=mars`

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
- The curve does **not** close exactly: the orbit precesses between the first
  and the last sample. That is correct, not a gap to stitch.
- `positions` is `null` when Horizons didn't answer; retried an hour later.

## `GET /api/solar-system/moons?planet=jupiter`

Every moon of one planet in a single response. `planet` takes the same values as
the two routes above; Mercury and Venus answer `{"moons": [], "missing": 0}`,
which is the truth and not an error. The Earth's Moon is **not** served here —
the web client computes it locally and it costs no request at all.

At most 9 moons per planet: all of them when the planet has 9 or fewer (Mars),
otherwise the 9 largest. 38 bodies in all.

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

- **Lazy fill, eager refresh.** The route records which planets get looked at; the
  command refreshes only those. A moon nobody has ever looked at is never fetched,
  and a planet untouched for 90 days drops off on its own. `--all-moons` forces
  all 38 (use once after a deploy, not on a cron); `--dry-run` lists and fetches
  nothing.
- **It is a CLI command on purpose.** `max_execution_time` is 0 here against 30 s
  for a web request, so the one-body-per-call rule does not apply and it can work
  through forty bodies in one process — measured, Jupiter's eight remaining moons
  in 7 s.
- Always exits 0: an upstream failure is transient, the next run picks it up, and
  the routes still fall back to fetching on demand.

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
  of objects with their approach data. `/api/solar-system/positions` has no
  such problem — `bodies` is a plain array, so `JsonUtility` handles it.
- `/api/solar-system/positions` is the one route worth calling on startup and
  then leaving alone: its tables cover a year and cost nothing in quota, so a
  VR client can fetch the seven planets once, keep them, and interpolate
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
