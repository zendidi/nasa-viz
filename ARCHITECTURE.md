# Architecture — NASA Viz

## Vue d'ensemble

```
                                                        ┌─► NASA api.nasa.gov (NeoWs)  ← seul quota
Web (Three.js)  ─┐                                      ├─► JPL (CAD, SBDB, Sentry, Horizons) ┐
                  ├─► Backend Symfony (proxy, cache) ───┤─► science.nasa.gov (APOD)           │
Unity VR (futur) ─┘      + comparaison des sources      ├─► ESA NEOCC (approches, risque)     ├ sans clé
                                                        ├─► IMCCE SsODNet (ssoCard)           │
                                                        └─► wheretheiss.at (ISS)              ┘
```

Aucun client n'appelle NASA directement : le backend cache les réponses, cache la clé API, et
compte les appels réels pour protéger le quota gratuit. Le contrat entre le backend et n'importe
quel client (web ou Unity) est documenté dans `backend/API.md` — c'est la source de vérité sur les
formes de réponse, pas ce fichier.

## Backend (`backend/`, Symfony 7, proxy sans état)

- `src/Service/NasaApiClient.php` — NeoWs seul (une des trois sources de `/api/neo`), normalise
  les réponses NASA en JSON stable, appelle `NasaUsageTracker::recordCall()` avant chaque requête
  réelle vers `api.nasa.gov` (pas avant un hit de cache). **C'est le dernier consommateur du
  quota.**
- `src/Service/ApodClient.php` — image du jour (`/api/apod`), lue sur l'API REST WordPress de
  `science.nasa.gov` depuis le 2026-09-30 : NASA a déplacé l'APOD et laissé `apod.nasa.gov` sans
  certificat valide pour son propre nom. **Sans clé, donc hors quota.** La forme de réponse de la
  route n'a pas changé — c'est exactement le rôle du proxy. Voir la classe pour le détail, et
  `docs/agent/decisions.md` du 2026-09-30.
- `src/Service/JplCadClient.php` — approches JPL CAD (source de référence de `/api/neo`) + liste
  Sentry. `src/Service/EsaNeoccClient.php` — approches et liste de risque ESA NEOCC. Sans clé,
  hors quota.
- `src/Service/NeoFeedMerger.php` — fusionne les trois listes par objet, explique les absences
  (portée/dates de chaque source) et chiffre les écarts JPL↔ESA face à l'incertitude JPL. Pur.
- `src/Service/NeoFeedBuilder.php` — lance toutes les sources en parallèle (voir
  `HttpResponses::settle`), tolère qu'une tombe, fusionne, journalise.
- `src/Service/NeoComparisonLog.php` + `src/Command/NeoComparisonReportCommand.php` — journal
  `var/log/neo-comparison.jsonl` (une ligne par changement réel) et son rapport
  (`php bin/console app:neo:comparison-report`).
- `src/Service/NeoOrbitComparisonLog.php` — journal `var/log/neo-orbit-comparison.jsonl` : une
  ligne par **objet**, pas par plage de dates, d'où un fichier distinct du précédent — un seul
  fichier mélangeant les deux formes casserait le lecteur qui attend l'autre. Alimenté par
  `/api/neo/details` lors d'un vrai fetch seulement, jamais sur un hit de cache ; lu par la
  section « orbites » du même rapport.
- `src/Service/SmallBodyDetailsClient.php` — fiche par objet pour `/api/neo/details` : JPL SBDB
  (toujours) + IMCCE ssoCard (bonus) + Sentry (risque d'impact).
- `src/Service/NeoDesignation.php` — appariement des objets entre catalogues (numéro ou
  désignation, chaque source ayant sa propre orthographe).
- `src/Service/HorizonsClient.php` — tables de positions géocentriques JPL Horizons (ICRF, km),
  sans clé, hors quota. Une seule forme de requête pour deux familles de corps : petits corps par
  désignation (`DES=2014 SU1;`, pas horaire) et corps majeurs par identifiant Horizons (`'499'` =
  Mars, pas journalier).
- `src/Service/SolarSystemClient.php` — les huit planètes autres que la Terre (Pluton compris, orbite tirée du barycentre `9`) : identifiants
  Horizons, noms UAI, rayons moyens, périodes sidérales, et la fenêtre commune (à partir du 1er du
  mois UTC) qui fait que des tables téléchargées à des jours différents restent sur la même
  horloge. Sert deux choses sans rapport (voir le tableau de `docs/planetes-et-lunes.md` §3c) :
  `getPositions()` = où est la planète (un an au pas d'un jour, `/api/solar-system/positions`), et
  `getOrbit()` = à quoi ressemble son chemin (une période sidérale en 180 intervalles,
  `/api/solar-system/orbit`). Les deux sont **géocentriques**, y compris l'orbite : c'est le client
  qui la rend héliocentrique en retranchant son propre Soleil, faute de quoi le trait raterait sa
  planète.
- `src/Service/IssPositionClient.php` — position ISS via wheretheiss.at (pas de quota, pas suivi
  par le usage tracker).
- `src/Service/NasaUsageTracker.php` — compteur d'appels réels à `api.nasa.gov` du jour (clé de
  cache `nasa_api_calls_<date UTC>`, expire à minuit UTC). Exposé via `GET /api/usage`.
- `src/Controller/SpaceDataController.php` — routes HTTP, toutes `GET`, toutes cachées
  (`cache.app`) :
  - `/api/iss/position` — TTL 5s
  - `/api/neo?start_date=&end_date=` — TTL 1h (10 min si une source est tombée), par plage de
    dates, plage max 7 jours
  - `/api/neo/details?designations=` — TTL 7 jours par objet (1 jour si inconnu)
  - `/api/solar-system/positions?body=` — TTL 40 jours par planète (1 h si Horizons n'a pas
    répondu). **Un corps par appel** : une requête d'éphémérides Horizons coûte 5 à 16 s quelle que
    soit sa taille, plusieurs d'un coup dépassent la limite d'exécution de PHP (`gotchas.md`)
  - `/api/solar-system/orbit?body=` — même règle, même TTL : l'orbite complète d'une planète en 361
    points sur une période sidérale (Neptune va jusqu'en 2191), **héliocentrique**
  - `/api/solar-system/moons?planet=` — au plus 9 lunes par planète, positions relatives à la
    planète ; la route ne va chercher qu'une lune absente par appel, donc un cache froid converge
    en autant d'appels qu'il y a de lunes
  - `/api/solar-system/orientation?body=` — TTL 40 jours : le pôle et le méridien origine en
    vecteurs unitaires ICRF plus le taux de rotation signé. Accepte les neuf planètes (Pluton compris) **et `moon`**.
    Une table `OBSERVER` de deux lignes, donc ~1 s là où une table de vecteurs coûte 5 à 16 s
  - `/api/apod` — TTL 24h, désormais sur `science.nasa.gov` et sans clé
  - `/api/usage` — pas de cache, lecture directe du compteur
- CORS via `nelmio/cors-bundle` (`config/packages/nelmio_cors.yaml`), restreint à
  `localhost`/`127.0.0.1` en dev (`CORS_ALLOW_ORIGIN` dans `.env`).

## Web (`web/`, Vite + Three.js, vitrine simple)

- `src/api.js` — fetch vers `/api/*` uniquement (jamais NASA directement).
- `src/cache.js` — cache `localStorage` (clés `nasa-viz:iss`, `nasa-viz:neo`). Au chargement, la
  scène utilise le dernier instantané sauvegardé ; le seul déclencheur d'un vrai appel réseau est
  le bouton "Mettre à jour" (ou l'absence totale de cache, au tout premier lancement). C'est ce qui
  protège le quota NASA pendant qu'on développe/teste.
- `src/main.js` — scène :
  - Globe texturé jour/nuit (`public/textures/2k_earth_daymap.jpg` + night, specular, normal maps
    et une couche de nuages séparée, jeu Solar System Scope CC BY 4.0, basculé le 2026-10-12 — les
    quatre cartes three.js correspondantes ne sont plus référencées, voir
    `public/textures/CREDITS.md`). Nuages enfants de `globeSphere` (dérive vers l'est,
    `7°/jour`, convention visuelle assumée) et uniforme `sunDirection` partagé par référence avec le
    shader du globe. Rotation réelle par le GMST, et son axe *est* le +Y de la scène puisque
    celle-ci est équatoriale
  - Ciel réel (`public/stars.json`, catalogue Hipparcos tronqué à mag ≤ 5 via d3-celestial ;
    couleur dérivée de l'indice B-V, taille dérivée de la magnitude — voir
    `docs/agent/gotchas.md` pour regénérer ce fichier)
  - Marqueur ISS animé (poll seulement sur "Mettre à jour", pas de polling automatique)
  - Points NEO cliquables (raycasting → modal détail ; couleur = dangerosité, sinon type spectral
    quand il est connu ; taille = diamètre mesuré si disponible). Le NEO sélectionné affiche sa
    trajectoire réelle (Horizons) et un schéma d'orbite SVG (`src/orbit.js`) dans la modal. Case
    « orbites de tous les NEO » (éteinte par défaut, vue héliocentrée seulement — la vue
    géocentrée tasse tout le système solaire dans 7 unités où 150 ellipses se superposeraient) :
    `bundleOrbitSamples` (`src/orbit.js`) empile les échantillons de toutes les orbites dans deux
    `LineSegments` (les PHA à part, plus vifs) au lieu d'une polyligne par objet.
  - `src/scale.js` — modèle d'échelle « lisible → réel » (slider 9 crans), une courbe de
    compression par corps pivot (`docs/echelle-reelle.md`)
  - `src/scene/planets.js` — les huit planètes autres que la Terre (Pluton compris) : tables Horizons (`/api/solar-system/positions`,
    chargées une par une en arrière-plan, cache `localStorage`), interpolation à la minute, sphères
    texturées et leurs libellés. Placées par le même `placeKm()` que la Lune, donc visibles dans les
    deux vues sans seconde source (`docs/planetes-et-lunes.md`). Le module charge ensuite
    **l'orbite** de chaque planète (`/api/solar-system/orbit`), servie héliocentrique depuis le
    2026-09-29 : plus rien à soustraire côté client. Orbites tracées **depuis n'importe quel
    pivot** (`OrbitFrame`, 2026-10-12), Terre comprise ; en vue géocentrée elles suivent le fondu
    des planètes (`planetFade`) et n'apparaissent qu'à 100 % réel. La carte de couleur et l'anneau
    de Saturne ne sont construits **qu'à la prise de pivot** — de loin une planète fait 3,5 px, où
    le détail ne se voit pas
  - `src/scene/orientation.js` — comment chaque corps est tourné : `/api/solar-system/orientation`,
    son cache (validé sur l'`epoch`, pas sur un âge) et l'application au quaternion du maillage.
    Un cache de module plutôt qu'une fabrique, parce que deux propriétaires sans lien s'en servent :
    les planètes (`scene/planets.js`) et la Lune (`main.js`)
  - `src/scene/geo.js` — la géométrie partagée, et **la convention de longitude des cartes** : bord
    gauche à 180°, centre à 0, est vers la droite. Mesurée, pas supposée — voir
    `tools/calibration/`
  - `src/focus.js` — point de vue : quel corps est au centre de la scène (les huit planètes autres que la Terre, la
    Terre, le Soleil — dix pivots, `FOCUSES` ; le pivot est l'origine, tout le reste est placé
    relativement). Les orbites planétaires et l'orbite terrestre se tracent depuis n'importe lequel
    de ces pivots (`placeHeliocentricKm`, 2026-10-12). En vue héliocentrée, le NEO sélectionné voit
    son **orbite complète** tracée en 3D depuis les éléments SBDB (`docs/points-de-vue.md`)
  - `src/clock.js` — horloge simulée unique (module pur, testé par `tests/clock.test.js`) : `createClock`, vitesses ×1 / 1 h/s / 1 j/s, `setRate` sans saut, `reset`, bornes (fin de la table Soleil ou 1er du mois UTC + 365 j), `atLimit` ; le temps réel n'est jamais borné. Les caches restent sur l'horloge murale.
  - `src/neoInfo.js` — textes de comparaison des sources et de la fiche, couleurs par taxonomie
  - Badge de quota (`GET /api/usage`)

## Unity VR (`unity-vr/`, pas commencé)

Projet non initialisé (voir `unity-vr/README.md`). Décision actée : le web reste une vitrine
simple, la VR peut avoir sa propre échelle/navigation immersive — elle n'a pas à reproduire la
scène web à l'identique. Elle consommera le même contrat backend (`backend/API.md`), pas une copie.

## Comment ajouter une nouvelle donnée NASA (pattern à suivre)

1. **Backend** : méthode dans un `Service/` (nouveau ou existant), qui retourne une forme
   normalisée — jamais le JSON brut de NASA. Si ça touche `api.nasa.gov`, appeler
   `NasaUsageTracker::recordCall()` avant l'appel HTTP réel.
2. **Route** dans `SpaceDataController` avec un TTL de cache adapté à la fréquence de mise à jour
   réelle de la donnée. Si un cron doit pouvoir préchauffer
   la donnée (cas du flux NEO et de l'APOD), la logique cache + recalcul vit dans
   `src/Service/CachedFeeds.php`, partagée par la route et par `app:cache:warm`, plutôt que dans le
   contrôleur.
3. **Documenter** la route dans `backend/API.md` (contrat stable pour tous les clients, y compris
   Unity plus tard).
4. **Frontend web** : fonction dans `api.js` ; passer par `cache.js` si la donnée doit survivre à
   un rechargement de page sans consommer le quota.
5. **Noter le choix** dans `docs/agent/decisions.md` si c'est un choix notable (échelle, format,
   compromis), et mettre à jour ce fichier si un nouveau service/fichier apparaît.

## Cache / rate-limit

- `DEMO_KEY` (clé par défaut) : 30 req/h, 50 req/jour.
- Vraie clé `api.nasa.gov` (à générer, gratuite) : 1000 req/h, pas de plafond journalier connu.
- `wheretheiss.at` (ISS) : pas de quota documenté, non suivi par le compteur.
- JPL Horizons : sans clé, hors quota — mais **lent et irrégulier** (5 à 16 s par requête,
  indépendamment du nombre d'échantillons, mesuré le 2026-09-22). C'est ce qui dicte la taille des
  lots côté `/api/neo/positions` et `/api/solar-system/positions`, pas un souci de volume.
- JPL (CAD, SBDB, Sentry, Horizons), ESA NEOCC, IMCCE SsODNet **et science.nasa.gov (APOD)** :
  sans clé, hors quota, non comptés par `NasaUsageTracker`. NeoWs reste interrogé pour la
  comparaison, et depuis le 2026-09-30 **c'est le seul consommateur du quota** — l'APOD en est
  sorti avec son changement de source. Voir `docs/neo-jpl-ssodnet.md`.
- TTLs actuels : ISS 5s · NEO 1h par plage de dates · APOD 24h.
- Le badge web (`GET /api/usage`) montre les appels réels du jour — c'est la donnée de vérité, pas
  le nombre de clics sur "Mettre à jour" (le cache backend absorbe une partie des clics).
