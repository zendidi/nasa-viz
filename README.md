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
- ~~**Rendu** : sphères/points simples pour le MVP web (pas de texture Terre ni de modélisation réaliste)~~ — **dépassé.** La Terre est texturée depuis le lot 1, et le lot 5 (2026-09-29) a texturé les sept planètes et le Soleil, posé l'anneau de Saturne, et donné aux planètes **et à la Lune** leur vraie inclinaison d'axe et leur vraie rotation propre (la Lune était texturée mais ne tournait pas du tout, alors qu'elle est en rotation synchrone). Les cartes ne sont chargées **qu'au moment où l'on centre sur un corps** : de loin une planète fait quelques pixels, où le détail ne se voit pas et coûterait 6,8 Mo à tout le monde.
- **Unity pas commencé** : l'API backend est stable et documentée (`backend/API.md`) pour une intégration Unity future sans dépendre de son planning.

## Statut
- **Backend** : fonctionnel — `GET /api/iss/position`, `GET /api/neo`, `GET /api/neo/positions`, `GET /api/neo/details`, `GET /api/apod`, plus les routes système solaire `GET /api/solar-system/positions`, `/orbit`, `/moons` et `/orientation`. Cache + CORS en place. Voir `backend/API.md` pour le contrat complet (utile pour Unity plus tard).
- **Système solaire** : positions, orbites, lunes et orientations viennent de **JPL Horizons**, qui est **sans clé et hors quota NASA**. Une requête par corps et par mois pour l'orientation, une par an pour les positions.
- **Sources NEO** : `/api/neo` interroge **JPL CAD** (référence), **NASA NeoWs** et **ESA NEOCC** en parallèle, les fusionne et signale les écarts ; le détail est journalisé dans `var/log/neo-comparison.jsonl` (`php bin/console app:neo:comparison-report`). Seul NeoWs consomme le quota NASA.
- **Web** : fonctionnel — globe Three.js texturé jour/nuit, marqueur ISS animé (poll 5s), points NEO cliquables avec orbite tracée, ciel réel, Lune, Soleil, les sept planètes et leurs lunes, anneau de Saturne, curseur d'échelle « lisible → réel » et choix du corps au centre de la scène.
- **VR** : non commencé (voir `unity-vr/README.md`).

## Pour démarrer

### En un clic (Windows, sans outils de dev)

Copier le dossier du projet sur la machine, puis :

1. **`Installer-PHP.bat`** — ne fait rien si PHP 8.3+ est déjà présent, sinon télécharge le zip
   officiel dans `tools/php/` (aucun droit admin, PATH inchangé, désinstaller = supprimer le dossier).
2. **`Lancer-NASA-Viz.bat`** — lance le serveur, affiche l'URL `http://127.0.0.1:<port>/`, la copie
   dans le presse-papiers et ouvre le navigateur. Un seul processus PHP sert la page *et* l'API.

Arguments : `Lancer-NASA-Viz.bat 8010 --no-open`, ou `--dev` pour lancer aussi le serveur Vite
(demande Node). Détails et limites : `DEPLOYMENT.md`.

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

## Crédits données
NASA/JPL (Close Approach Data, Small-Body Database, Sentry, Horizons) · ESA NEO Coordination Centre ·
LTE's SsODNet VO service, IMCCE / Observatoire de Paris (Berthier et al. 2023) · NASA NeoWs et APOD ·
wheretheiss.at (ISS) · catalogue d'étoiles Hipparcos via d3-celestial (BSD-3).

## Structure
```
backend/    → Proxy Symfony vers les API NASA (cache + clé API cachée)
web/        → Vitrine web Three.js (ISS + astéroïdes)
unity-vr/   → Projet Unity VR (Quest, OpenXR)
```

## Mise en prod
Voir `DEPLOYMENT.md` (checklist et guide, pas encore exécuté — le projet est encore en
développement).
