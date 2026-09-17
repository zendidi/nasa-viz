# Architecture — NASA Viz

## Vue d'ensemble

```
Web (Three.js)  ─┐
                  ├─► Backend Symfony (proxy, cache, compteur d'usage) ─► NASA API (NeoWs, APOD)
Unity VR (futur) ─┘                                                   └─► wheretheiss.at (ISS)
```

Aucun client n'appelle NASA directement : le backend cache les réponses, cache la clé API, et
compte les appels réels pour protéger le quota gratuit. Le contrat entre le backend et n'importe
quel client (web ou Unity) est documenté dans `backend/API.md` — c'est la source de vérité sur les
formes de réponse, pas ce fichier.

## Backend (`backend/`, Symfony 7, proxy sans état)

- `src/Service/NasaApiClient.php` — NeoWs (`/api/neo`) + APOD (`/api/apod`), normalise les réponses
  NASA en JSON stable, appelle `NasaUsageTracker::recordCall()` avant chaque requête réelle vers
  `api.nasa.gov` (pas avant un hit de cache).
- `src/Service/IssPositionClient.php` — position ISS via wheretheiss.at (pas de quota, pas suivi
  par le usage tracker).
- `src/Service/NasaUsageTracker.php` — compteur d'appels réels à `api.nasa.gov` du jour (clé de
  cache `nasa_api_calls_<date UTC>`, expire à minuit UTC). Exposé via `GET /api/usage`.
- `src/Controller/SpaceDataController.php` — routes HTTP, toutes `GET`, toutes cachées
  (`cache.app`) :
  - `/api/iss/position` — TTL 5s
  - `/api/neo?start_date=&end_date=` — TTL 1h, par plage de dates, plage max 7 jours (borne NeoWs)
  - `/api/apod` — TTL 24h
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
  - Globe texturé (`public/textures/earth_atmos_2048.jpg` + specular + normal map, three.js
    examples/mrdoob, imagerie NASA/domaine public)
  - Ciel réel (`public/stars.json`, catalogue Hipparcos tronqué à mag ≤ 5 via d3-celestial ;
    couleur dérivée de l'indice B-V, taille dérivée de la magnitude — voir
    `docs/agent/gotchas.md` pour regénérer ce fichier)
  - Marqueur ISS animé (poll seulement sur "Mettre à jour", pas de polling automatique)
  - Points NEO cliquables (raycasting → modal détail ; couleur = dangerosité, taille = diamètre)
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
   réelle de la donnée.
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
- Piste pour sortir du quota NEO (non intégrée) : JPL `cad.api` + IMCCE SsODNet (sans clé) — voir
  `docs/imcce-ssodnet.md`.
- TTLs actuels : ISS 5s · NEO 1h par plage de dates · APOD 24h.
- Le badge web (`GET /api/usage`) montre les appels réels du jour — c'est la donnée de vérité, pas
  le nombre de clics sur "Mettre à jour" (le cache backend absorbe une partie des clics).
