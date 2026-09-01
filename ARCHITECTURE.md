# Architecture — NASA Viz

## Backend (proxy léger, pas d'entités persistées pour la v1)
- `Service/NasaApiClient.php` — wrapper autour de l'API NASA (NeoWs, APOD)
- `Service/IssPositionClient.php` — wrapper autour de wheretheiss.at (ou Open Notify)
- `Controller/SpaceDataController.php` :
  - `GET /api/iss/position` — proxy + cache court (quelques secondes)
  - `GET /api/neo?start_date=&end_date=` — proxy + cache (les NEO ne bougent pas seconde par seconde)
  - `GET /api/apod` — proxy + cache 24h

## Web (src/)
- `main.js` — scène Three.js : globe terrestre simplifié + marqueur ISS animé + points pour les NEO
- `api.js` — fetch vers le backend proxy (jamais directement vers NASA, pour ne pas exposer de clé)

## Unity VR (Assets/Scripts)
- `NasaApiClient.cs` — appelle le même backend proxy (UnityWebRequest)
- `IssMarker.cs` — positionne/anime le marqueur ISS dans la scène selon lat/lng reçus
- `NeoField.cs` — instancie les astéroïdes proches autour du joueur (échelle artistique, pas réaliste au 1:1)
- Scène de départ : `Assets/Scenes/Main.unity` (à créer dans Unity — pas généré ici, fichiers binaires Unity)

## Cache/rate-limit
La clé NASA gratuite est limitée (1000 req/h). Le proxy backend doit cacher (Symfony Cache, quelques
minutes pour l'ISS, plusieurs heures pour NEO/APOD) pour que web + VR ne consomment pas le quota en double.
