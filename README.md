# NASA Viz — Visualiseur Spatial

## Cible
**VR (Unity/OpenXR, Quest) + Web** (visualisation 2D/3D légère dans le navigateur)

## Décisions déjà prises
- **Backend** : petit proxy Symfony (cache + évite d'exposer/répéter les appels directs à l'API NASA depuis les clients, gère le rate-limit)
- **VR** : Unity 6, OpenXR (cohérent avec ta stack DFD existante), cible Quest
- **Web** : Three.js + Vite (rendu 3D léger, pas besoin d'un moteur complet côté navigateur)
- **Données NASA utilisées pour la v1** :
  - Position ISS en temps réel (Open Notify / wheretheiss.at)
  - Near Earth Objects (astéroïdes proches — API NASA NeoWs, nécessite une clé API gratuite)
  - APOD (photo du jour) en fallback/complément visuel

## Décisions prises depuis (2026-09-01)
- **Web = vitrine simple, VR = plus loin** : le web reste une scène légère (globe + ISS + points NEO) ; la VR pourra avoir sa propre échelle/navigation immersive, pas besoin de matcher le web 1:1.
- **Clé API** : `DEMO_KEY` en attendant une vraie clé (limite basse : 30 req/h, 50 req/jour) — à remplacer dans `backend/.env` sur `api.nasa.gov`.
- **Rendu** : sphères/points simples pour le MVP web (pas de texture Terre ni de modélisation réaliste) — cohérent avec l'objectif "MVP web ASAP".
- **Unity pas commencé** : l'API backend est stable et documentée (`backend/API.md`) pour une intégration Unity future sans dépendre de son planning.

## Statut
- **Backend** : fonctionnel — `GET /api/iss/position`, `GET /api/neo`, `GET /api/apod`, cache + CORS en place. Voir `backend/API.md` pour le contrat complet (utile pour Unity plus tard).
- **Web** : fonctionnel — globe Three.js, marqueur ISS animé (poll 5s), points NEO (fetch au chargement), panneau d'info.
- **VR** : non commencé (voir `unity-vr/README.md`).

## Pour démarrer

### Backend (proxy)
```bash
cd backend
composer install
cp .env.example .env   # NASA_API_KEY=DEMO_KEY par défaut
php -S 127.0.0.1:8000 -t public
# ou, si la CLI Symfony est installée : symfony server:start
```

### Web
```bash
cd web
npm install
npm run dev
```
Le dev server Vite proxifie `/api` vers `http://localhost:8000` (voir `web/vite.config.js`) — lancer le backend avant le web.

### VR (Unity)
Ouvrir `unity-vr/` dans Unity Hub (Unity 6), installer les packages listés dans `Packages/manifest.json`
via le Package Manager (XR Interaction Toolkit, OpenXR Plugin), puis configurer le XR Plug-in Management
pour Quest dans Project Settings.

## Structure
```
backend/    → Proxy Symfony vers les API NASA (cache + clé API cachée)
web/        → Vitrine web Three.js (ISS + astéroïdes)
unity-vr/   → Projet Unity VR (Quest, OpenXR)
```

## Mise en prod
Voir `DEPLOYMENT.md` (checklist et guide, pas encore exécuté — le projet est encore en
développement).
