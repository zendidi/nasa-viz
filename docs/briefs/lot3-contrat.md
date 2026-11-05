# Lot 3 — contrat backend ↔ web (validé par l'utilisateur le 2026-11-05)

> ⚠️ **FICHIER DE TRAVAIL — À SUPPRIMER AU MERGE** avec tout `docs/briefs/`. Ce qui doit survivre
> va dans `docs/plage-cinq-ans.md`, `backend/API.md` et le journal.

Le même texte est donné à `backend-php` et à `web-scene`. **Les noms de champs ci-dessous font foi** :
ne les renomme pas d'un côté sans l'autre.

## Mesures qui fondent les choix (2026-11-05, Horizons sans clé)

- **Orientation**, construite par `PlanetOrientationClient::build` et propagée, contre `ObsSub-LON`
  corrigé du temps-lumière (méthode du test), 2025→2031 au pas de 10 j : planètes ≤ 0,016° sur 6 ans
  (Mercure), pôles ≤ 0,02°. **Lune** : pôle jusqu'à 1,98° de celui d'une époque fixe ; avec une époque
  au 1/1 de chaque année, 0,54° au plus dans l'année, saut ≈ 0,5° (pôle) / ≤ 0,56° (méridien) au 1/1.
  Planètes : saut au 1/1 ≤ 0,005°.
- **Orbites dessinées** (une période sidérale depuis l'époque, courbe dense 3 600 intervalles) :
  la planète quitte son trait **hors de la période**, en particulier **avant l'époque** — Jupiter
  352 687 km, Saturne 844 874 km, Uranus ~1,2 Mkm, Neptune 744 762 km, Pluton 755 728 km, Mars
  40 600 km (déjà vrai aujourd'hui avec les 3 mois d'historique). Avec une époque au **1/1 de l'année
  affichée**, écart max dans l'année : Mercure 993 km, Vénus 1 425, Mars 103, Jupiter 311 km.
- **Tranche annuelle Horizons** (avec 2 lignes de recouvrement) : 1,0–1,2 s ; 51 ko bruts au pas de
  1 j (Mars, Soleil), 188 ko au pas de 6 h (Lune, Mercure).

## Plage et tranches

- `Y` = année UTC courante (horloge murale du serveur / du navigateur). Années servies :
  **`Y−1` à `Y+4`** (6 tranches), qui couvrent du 1/1 (Y−1) 00:00 UTC au 1/1 (Y+5) 00:00 UTC, donc
  toujours [maintenant −1 an, maintenant +4 ans].
- Une **tranche** = un corps × une année civile, **immuable**.
- **Recouvrement : 2 lignes de chaque côté** (même règle que `small-body/precision` au lot 2) :
  la table commence à `slice_start − 2·step` et finit à `slice_end + 2·step`, toutes deux incluses.
  Une tranche lue seule est donc en Catmull-Rom complet sur toute son année.

## Routes (on ajoute un paramètre, on ne casse rien)

Sans `year`, chaque route garde **exactement** son comportement actuel (fenêtre mensuelle), marquée
« remplacée » dans `backend/API.md` ; le web ne l'appelle plus.

`year` doit être un entier dans `[Y−1, Y+4]`, sinon **HTTP 400** `{"error": "year must be between
<Y−1> and <Y+4>"}`. `body` inconnu : 400 comme aujourd'hui.

### `GET /api/solar-system/positions?body=<id>&year=<YYYY>`

`id` ∈ `SolarSystemClient::ids()` (Soleil, Lune, 8 planètes). Pas = `stepSeconds($id)` (6 h pour
`moon`, `mercury`, `venus` ; 1 j sinon).

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
               "positions": [[x, y, z], ...] }]
}
```

- `slice_start` = 1/1 `year` 00:00 UTC, `slice_end` = 1/1 (`year`+1) 00:00 UTC (secondes Unix).
- `start` = `slice_start − 2 × step_seconds` = instant de `positions[0]`.
- `positions` : de `start` à `slice_end + 2 × step_seconds` inclus ; `null` si Horizons n'a rien
  donné (mis en cache 1 h).

### `GET /api/solar-system/orbit?body=<planet>&year=<YYYY>`

Même réponse qu'aujourd'hui (`frame: "ICRF heliocentric"`, `time_scale`, `units`, `body`, `start`,
`stop`, `positions`), **plus `year`**. Une période sidérale à partir du **1/1 `year` 00:00 UTC**
(`start` = cet instant), `ORBIT_INTERVALS` intervalles, `ORBIT_COMMAND` (barycentre de Pluton)
inchangé.

### `GET /api/solar-system/orientation?body=<id>&year=<YYYY>`

Même réponse qu'aujourd'hui (`frame: "ICRF"`, `epoch`, `bodies: [{…, pole, prime_meridian,
rotation_deg_per_day}]`), **plus `year`**. `epoch` = 1/1 `year` 00:00 UTC.

### Cache backend

- Une entrée par corps × année ; la clé porte tout ce qui change le contenu :
  positions `solar_system_<id>_y<year>_<step>_<TIME_SCALE>_o2`, orbite
  `solar_system_orbit_<id>_y<year>_<TIME_SCALE>_<ORBIT_INTERVALS>`, orientation
  `solar_system_orientation_<id>_y<year>`. Clés construites par des fonctions statiques partagées
  entre contrôleur et commande de préchauffage (pas deux copies de la chaîne).
- Valeur non nulle : pas d'expiration utile (immuable). Valeur nulle : 1 h. Échec de transport : non
  caché, 502 via `upstreamError` comme aujourd'hui.
- **Pas d'en-tête `Cache-Control: immutable`** (décidé : un cache HTTP immuable empêcherait le client
  de s'auto-réparer quand il refuse une tranche, leçon du 2026-09-29). Aucun en-tête de cache ajouté.

### `app:solar-system:warm`

Préchauffe, pour chaque année de `Y−1` à `Y+4` : positions des 10 corps, orbites des 8 planètes,
orientation des 9 corps de `PlanetOrientationClient::ids()` — en sautant ce qui est en cache. Ne
préchauffe plus la fenêtre mensuelle. Lunes des planètes : inchangé. À froid ≈ 160 appels ; ensuite
≈ 27 par an (la nouvelle année).

## Web

- `data/api.js` : `fetchSolarSystemBody(id, year)`, `fetchSolarSystemOrbit(id, year)`,
  `fetchSolarSystemOrientation(id, year)` — `year` ajouté à la requête.
- **Assemblage** : les tranches d'un corps sont concaténées en **une table continue**
  `{timeScale, start, stepSeconds, positions}` en retirant le recouvrement d'après `slice_start` /
  `slice_end` servis (pas recalculés) ; les lignes de recouvrement **extérieures** de la suite sont
  gardées. Seule la **suite contiguë d'années qui contient l'année courante** est utilisée (un trou
  coupe la couverture). Le résultat doit être ligne pour ligne la table qu'Horizons aurait servie
  d'un seul tenant.
- **Bornes de l'horloge** : [maintenant − 1 an, maintenant + 4 ans] arrondis au minuit UTC — mêmes
  valeurs que `cursorBounds(wallMs)` de `tracking/model.js` (non modifié ; un test épingle l'égalité) —
  coupées à la couverture assemblée du Soleil quand elle est plus courte. Le temps réel reste exempt des
  bornes. `HISTORY_MONTHS`, `defaultMinMs`, `defaultMaxMs` disparaissent du web.
- **Ordre de chargement** : les 6 tranches du Soleil, puis l'année courante de la Lune et des
  planètes, puis les autres années en s'éloignant de l'année courante.
- Une **planète hors de sa couverture chargée est masquée** (pas figée au bord). Soleil et Lune gardent
  leur série de secours (`astronomy.js`).
- **Orbite** et **orientation** : celles de l'**année de l'horloge simulée**, chargées à la demande quand
  l'horloge change d'année ; l'ancienne reste utilisée jusqu'à l'arrivée de la nouvelle (orientation :
  année chargée la plus proche).
- **`localStorage`** : une clé par corps × année (positions, orbite, orientation), validée à la relecture
  (`time_scale`, pas, `frame`, année dans la plage). Au démarrage, effacer les tranches hors plage et les
  anciennes clés `solar-system`, `solar-system-orbits`, `solar-system-orientation`, `sun`, `moon`.
- **Soleil unifié** : l'outil de trajectoire (`tracking/scene.js`) lit la table assemblée du Soleil de
  la scène, adaptée en `{start, step_seconds, positions}`, au lieu de `/api/small-body/trajectory/sun`
  (route conservée côté backend, marquée remplacée). Rien d'autre ne change dans l'outil ; en
  particulier, **seul « Maintenant » remet à zéro** horloge et décalage du curseur.
- Hors périmètre : ISS, NEO de la semaine, lunes des planètes, le reste de l'outil de trajectoire.
