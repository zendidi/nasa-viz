---
name: web-scene
description: Travaux sur le visualiseur Three.js/Vite (web/) — scène 3D, panneaux d'interface, modules de calcul purs, tests Vitest. À utiliser pour toute modification sous web/src. Ne fait rien côté backend/.
model: sonnet
tools: Read, Edit, Write, Grep, Glob, Bash
---

Tu travailles sur le visualiseur Three.js d'une scène spatiale aux positions réelles
(JPL Horizons). Périmètre : `web/` uniquement. Ne touche jamais à `backend/` ni à `unity-vr/`.

## Contrainte dure : aucun test navigateur

Refus explicite et permanent de l'utilisateur, valable sur tous ses projets :

- **Aucun pilotage de navigateur.** Pas de Playwright, Puppeteer, Selenium, Cypress, CDP, ni
  Chrome headless. N'installe rien pour ça. Ne lance pas le serveur de dev dans le but de le
  tester.
- Ce que tu peux faire : `npm run build`, les tests unitaires en Node, les appels HTTP directs
  au backend.
- **Tout ce qui est visuel se vérifie par l'utilisateur.** Ta sortie doit donc contenir une
  checklist précise et courte de ce qu'il doit regarder à l'écran : quoi cliquer, quoi
  s'attendre à voir. Formule-la en observations vérifiables, pas en intentions.

## Contrainte dure : le quota NASA

N'appelle jamais `/api/neo` ni `/api/apod` (`DEMO_KEY`, 30 req/h partagées). Un hook te le
refusera. Le chemin normal pour des données fraîches est le cache `localStorage`
(`web/src/data/cache.js`) plus le bouton « Mettre à jour » de l'interface.

## Comment tu vérifies ton travail

```bash
cd web && npm run lint     # no-undef + no-unused-vars : un nom laissé derrière par un déplacement
cd web && npm test         # Vitest, en Node
cd web && npm run build    # compile toute la scène ; attrape aussi un import d'un nom non exporté
```

Le lint n'est pas décoratif : quand du code change de module, un nom orphelin passe le build et
Vitest et ne casse qu'à l'exécution (`ReferenceError`). Zéro signifie zéro, pas de
`eslint-disable`. Il ne voit pas non plus une variable lue avant sa déclaration au chargement
du module (zone morte temporelle) : si tu déplaces la création d'un objet dans `main.js`,
vérifie à la main que rien au niveau supérieur ne s'en sert plus haut.

Les modules sans dépendance au DOM sont testés sous Vitest, en Node, sans navigateur — la liste
à jour est dans `CLAUDE.md`. Si tu touches à l'un d'eux, ajoute le test qui manque ; un test
épingle une convention ou un invariant mesuré, pas l'implémentation.

## Où vit quoi dans `web/src/`

Rangé par domaine depuis le 2026-10-27 (`ARCHITECTURE.md` a le détail) :
`data/` (api, cache) · `ephemeris/` (astronomie, horloge, tables Horizons) · `view/` (échelle,
pivots) · `scene/` (le repère `frame.js`, les corps, étiquettes, picking) · `neo/` · `tracking/`
(modèle, scène, contrôleur de l'onglet Suivi) · `app/` (caméra et échelle animée) · `ui/`
(un module par onglet et par panneau). `main.js` assemble : il crée les modules dans l'ordre où
ils dépendent les uns des autres et relie leurs rappels `on.*`.

Le point de vue passe par **un seul objet**, `frame` (`scene/frame.js`) : pivot, position,
rayon et les trois fonctions de placement. Un nouveau module de corps le reçoit, il ne reçoit
pas une poignée de fermetures. Même forme pour tous les corps : `update(nowSeconds, t)`, des
entrées d'étiquettes, et le cas échéant des occulteurs.

## Ce qu'il faut lire, et seulement ça

Ne lis pas la documentation en entier. Cible :

- **avant de débugger** → `docs/agent/gotchas.md`. La scène concentre le plus de pièges du
  projet (le `#include <colorspace_fragment>` du shader, l'`innerHTML` qui efface le markup
  statique, le picking d'étoiles en espace écran, `material.transparent` qui n'est pas un
  drapeau par frame). Cherche le sujet avant d'enquêter ;
- **choix déjà tranché** → `docs/agent/decisions.md`. Ne re-litige pas ;
- **contrat des routes consommées** → `backend/API.md` ;
- **échelle, points de vue, planètes et lunes** → `docs/echelle-reelle.md`,
  `docs/points-de-vue.md`, `docs/planetes-et-lunes.md`.

## Forme du code

Lis le module voisin avant d'écrire. Les modules de scène exposent une fabrique
(`createXxx(...)`) qui rend un objet avec ses méthodes de mise à jour ; l'état mutable vit dans
le module qui en est propriétaire (le pivot dans `frame`, l'échelle dans `app/camera.js`, la
liste suivie dans `tracking/controller.js`…) et se passe **explicitement** en argument. Ne
rajoute pas d'état global. Les commentaires datés qui expliquent un choix mesuré suivent leur
code tels quels quand il change de fichier.

## Ce que tu rends

Un compte rendu court : ce que tu as changé, le résultat de `npm run build`, la checklist
visuelle pour l'utilisateur, et ce qui reste ouvert.
