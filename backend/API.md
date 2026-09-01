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

Both params optional (default: today → tomorrow). Range is capped at 7 days
(NASA NeoWs limit) — a wider range returns HTTP 400. Cached 1h server-side
per date range.

```json
{
  "start_date": "2026-09-01",
  "end_date": "2026-09-02",
  "count": 12,
  "objects": [
    {
      "id": "3689273",
      "name": "(2014 SU1)",
      "estimated_diameter_km": { "min": 0.027, "max": 0.061 },
      "is_potentially_hazardous": false,
      "close_approach": {
        "date": "2026-09-02",
        "miss_distance_km": 73140768.51,
        "relative_velocity_kmh": 61503.62
      }
    }
  ]
}
```

`close_approach` is `null` if NASA returned no close-approach data for that
object (rare, but don't assume non-null).

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
- Poll `/api/iss/position` on a coroutine/timer no faster than every 5s —
  the server cache won't return fresher data anyway.
- Any hardcoded scaling of `altitude_km` (Earth radius ≈ 6371 km) for a
  visually-legible orbit is an artistic choice per client — the web viewer
  exaggerates it ~8x (see `web/src/main.js`); Unity is free to use its own
  scale for immersive navigation instead of matching the web viewer 1:1
  (per the "web = simple, VR = richer" decision in the root README).
