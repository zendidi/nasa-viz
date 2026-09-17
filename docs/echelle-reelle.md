# Mode « échelle réelle » — plan (non implémenté)

Objectif : pouvoir passer progressivement de la scène lisible actuelle (distances compressées, corps
grossis) à des proportions réelles de distances et de tailles, pour la Terre, la Lune, l'ISS et les
NEO détectés. Planifié le 2026-09-16, choix utilisateur ci-dessous.

## Choix validés

| Sujet | Choix |
|---|---|
| Molette | **Découplée** : molette = zoom caméra seulement ; **Shift+molette = un cran d'échelle** |
| Crans | **9 crans** (`t = k/8`, k = 0…8) sur un slider + 3 presets : « Lisible » (k=0), « Intermédiaire » (k=4), « 100 % réel » (k=8) |
| Périmètre | **Tout d'un coup** : échelle + vraies positions 3D des NEO (JPL Horizons) dans la même livraison |
| ISS | Polling **1 min** (wheretheiss.at, hors quota) |
| Ciel | Étoiles + constellations en **skybox** ; survol étoile + tracé/nom de constellation **conservés** |

## Ordres de grandeur (Terre = 2 unités, 1 unité ≈ 3 186 km)

| Objet | Lisible (actuel) | Réel |
|---|---|---|
| Distance Terre–Lune | 12 | ~121 |
| Rayon Lune | 0,54 | 0,54 (déjà réel) |
| Altitude ISS | ~1,05 (×8) | ~0,13 |
| Taille ISS | 0,06 (≈190 km) | ~0,00002 |
| NEO (feed typique : 1 à 50 LD, jusqu'à ~0,5 ua) | sphère fixe de rayon 7 | ~120 à ~23 000 |
| Taille NEO (~10–300 m) | 0,03–0,2 | ~0,000002–0,0001 |
| Soleil | 30 | ~47 000 |

Cadrer un NEO à 0,5 ua réel → le système Terre–Lune fait ~5 px à l'écran. D'où les tailles minimales.

## Modèle d'échelle

Nouveau module `web/src/scale.js` (pur, sans état Three.js autant que possible).

- Paramètre `t ∈ [0, 1]`, crans `k/8`. Chaque grandeur interpolée **en log** :
  `v(t) = v_lisible^(1-t) · v_réel^t` (sinon toute la transition a lieu dans les derniers %).
- La Terre est l'ancre : rayon 2 à tous les crans.
- **Distances Lune/NEO lisibles = fonction monotone de la distance réelle** (plutôt que la sphère fixe
  de rayon 7 actuelle, qui inverse l'ordre Lune/NEO pendant la transition) :
  `f(d_km) = a + b·log10(d_km)` calée sur Lune → 12 (inchangé) et 0,5 ua → 20 :
  b ≈ 3,49, a ≈ −7,5 (un NEO à 20 000 km → ~7,5). Conséquence visible au cran 0 : les NEO ne sont
  plus sur une coquille unique mais étalés entre ~7 et ~20, dans leur vraie direction.
- Altitude ISS : `×8^(1-t)`. Tailles ISS/NEO : taille lisible actuelle → taille réelle, même interpolation.
- **Taille minimale à l'écran** par objet, recalculée chaque frame :
  `wpp = 2·dist_caméra·tan(fov/2) / hauteur_px` ; `rayon = max(rayon(t), minPx · wpp)`.
  Valeurs de départ : Terre 3 px, Lune 2 px, ISS 4 px, NEO 4 px, Soleil 4 px. Les hit-targets NEO
  suivent la même règle (min ~10 px) pour rester cliquables.
- Libellé du cran, calculé en direct : « Lune ÷x · NEO ÷y (médiane du feed) · tailles ×z ».

## Rendu

- `WebGLRenderer({ logarithmicDepthBuffer: true })`, caméra `near 0.01`, `far 1e6`.
  **Piège** : un `ShaderMaterial` écrit à la main (globe, étoiles) ne reçoit pas le log depth
  automatiquement — ajouter `#include <common>`, `<logdepthbuf_pars_vertex>`, `<logdepthbuf_vertex>`,
  `<logdepthbuf_pars_fragment>`, `<logdepthbuf_fragment>`. À noter dans `docs/agent/gotchas.md`.
- `controls.maxDistance` dépend du cran (≈ 3 × l'objet le plus lointain à ce cran, min 20) ;
  `zoomSpeed` augmenté quand la plage est grande (le dolly OrbitControls est multiplicatif :
  3,5 → 50 000 ≈ 190 crans de molette à `zoomSpeed = 1`).
- Changement de cran (slider / preset / Shift+molette) : transition animée ~1,5 s sur `t`, distance
  caméra ajustée en log du même rapport que l'étendue de la scène (bornée par min/maxDistance).
- Soleil : marqueur à sa vraie distance au cran 8 (interpolé), taille min ; la `DirectionalLight` ne
  change pas (seule la direction compte).
- **Repères** (à partir de t > 0, discrets) : cercles « orbite lunaire », « 10 LD », « 100 LD » dans
  le plan de l'orbite lunaire / équatorial, avec petits libellés. Libellés HTML « Terre / Lune / ISS »
  positionnés par projection quand les corps deviennent des points.

## Skybox (en conservant le survol)

- Nouveau `skyGroup` contenant `starPoints` + le groupe des constellations ; chaque frame
  `skyGroup.position.copy(camera.position)` (position seulement, pas la rotation → ciel fixe).
  `renderOrder` négatif, `depthTest: false`, `depthWrite: false` → dessiné derrière tout.
- `gl_PointSize` dépend de la distance caméra–étoile, constante en skybox → rendu inchangé.
- `pickStarIndexAt` : projeter `camera.position + positionLocale` (ou `localToWorld`) au lieu de la
  position brute.
- `isOccludedByGlobe` → occultation vers l'infini (rayon caméra→direction, pas de borne de distance),
  étendue à la Lune (position/rayon courants au cran t).

## Données

### Lune (client, sans API)
`astronomy.js` : remplacer la longitude moyenne par une formule de Meeus tronquée (principaux termes
en longitude, latitude écliptique, distance), puis conversion écliptique → équatoriale (obliquité).
Aujourd'hui la longitude écliptique est utilisée comme ascension droite, à latitude 0 et distance fixe.
Précision visée ≲ 0,5°, distance ± ~1 500 km.

### ISS
`setInterval(refreshIss, 60_000)` en plus du bouton. Position réelle déjà fournie (lat/lng/alt).

### NEO — positions 3D réelles (JPL Horizons)

Testé le 2026-09-16, sans clé, hors quota `api.nasa.gov` (non compté par `NasaUsageTracker`) :

```
https://ssd.jpl.nasa.gov/api/horizons.api?format=json
  &COMMAND='DES=2014 SU1;'  &EPHEM_TYPE=VECTORS  &CENTER='500@399'
  &START_TIME='2026-09-16'  &STOP_TIME='2026-09-18'  &STEP_SIZE='1h'
  &VEC_TABLE=1  &REF_PLANE=FRAME  &OUT_UNITS='KM-S'  &CSV_FORMAT=YES  &OBJ_DATA=NO
```

- Réponse : texte dans `result`, lignes CSV entre `$$SOE` et `$$EOE` : `JDTDB, date, X, Y, Z` (km),
  repère **ICRF géocentrique** = même repère que les étoiles de la scène.
  Conversion vers la scène (cf. `latLngToVector3`) : `scène = (X, Z, −Y)`.
- **Piège** : l'`id` NeoWs (ex. `3689273`) n'est **pas** un identifiant Horizons (« out of bounds »).
  Utiliser la désignation entre parenthèses du `name` NeoWs : `"(2014 SU1)"` ou
  `"495615 (2015 PQ291)"` → `DES=2014 SU1;` / `DES=2015 PQ291;` (testés OK). Un numéro seul
  (`495615;`) marche aussi.
- Objets récents couverts (`2026 RG15` OK, alors que ssoCard IMCCE renvoie 404).

Backend :
- `Service/HorizonsClient.php` : désignation → table de vecteurs horaires sur `[start_date, end_date + 1 j]`.
  Requêtes en parallèle via Symfony HttpClient avec une concurrence bornée (~4, ne pas marteler JPL).
- Route **séparée** `GET /api/neo/positions?start_date=&end_date=` (pour ne pas ralentir `/api/neo`),
  cache 24 h par objet + plage. Forme proposée :
  ```json
  {
    "frame": "ICRF geocentric", "units": "km", "step_seconds": 3600,
    "objects": {
      "3689273": { "start": 1789516800, "positions": [[-8076182, 69001597, 25287919], ...] },
      "54321":   null
    }
  }
  ```
  `null` = Horizons n'a pas résolu l'objet. Documenter dans `backend/API.md`, mettre à jour `ARCHITECTURE.md`.

Web :
- `api.js` → `fetchNeoPositions`, mis en cache via `cache.js` (clé liée à la plage du feed).
- Interpolation linéaire à `Date.now()` entre deux points horaires ; si « maintenant » sort de la
  plage (feed en cache ancien), borner et afficher « position au <date> ».
- Repli si `null` ou échec : direction `hashToDirection` + vraie `miss_distance_km`, mention
  « position approximative » dans la modal.

## Ordre d'implémentation

1. Fondations rendu : log depth (+ includes shaders), near/far, skybox + survol étoiles/constellations
   adapté. Vérifier : aucun changement visuel, survol OK.
2. `scale.js` + tailles minimales + état `t` (sans UI, cran forcé en dev).
3. Lune précise (`astronomy.js`) + polling ISS 1 min.
4. Backend Horizons (service, route, cache, `API.md`, `ARCHITECTURE.md`).
5. NEO : positions réelles interpolées + repli.
6. UI : slider 9 crans + libellé, presets, Shift+molette, transitions, maxDistance/zoomSpeed adaptatifs.
7. Repères (cercles LD) + libellés Terre/Lune/ISS.
8. Docs : `decisions.md`, `gotchas.md` (log depth + ShaderMaterial, id NeoWs ≠ Horizons, Shift+molette
   → `deltaX` sous Chrome/Windows), `README.md`.

**Piège Shift+molette** : sur Chrome/Edge Windows, Shift+molette est converti en défilement horizontal
(`deltaY = 0`, `deltaX ≠ 0`). Lire `deltaY || deltaX`. Écouteur `wheel` en phase capture sur le canvas,
`preventDefault()` + `stopImmediatePropagation()` quand `shiftKey`, pour qu'OrbitControls ne zoome pas.

## Hors périmètre (backlog)

- Enrichissement ssoCard IMCCE (couleur par taxonomie, vrai diamètre) — voir `docs/imcce-ssodnet.md`.
- ESA NEOCC `https://neo.ssa.esa.int/PSDB-portlet/download?file=esa_upcoming_close_app` : liste
  texte des approches à venir (distance, diamètre en m, indice CAI), sans clé, testée le 2026-09-16 —
  alternative/complément à NeoWs pour la liste.
- Focus caméra sur un corps (orbiter autour de la Lune ou d'un NEO), utile en échelle réelle.
- Trajectoires des NEO sur la semaine (la table Horizons le permet déjà).
