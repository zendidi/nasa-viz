# Brief — lot 2 : l'outil de trajectoire des objets suivis

> **Livré le 2026-11-05, voir `docs/agent/decisions.md`** (« 2026-11-05 — Lot 2 — outil de trajectoire des objets suivis »). Ce brief reste jusqu'au merge ; plusieurs de ses points (extrapolation de ~27 s, remise à zéro automatique) sont corrigés dans le journal.

> ⚠️ **FICHIER DE TRAVAIL — À SUPPRIMER AU MERGE** de la branche `suivi-plage-etendue` dans `master`
> (avec tout le dossier `docs/briefs/`). Ce qui doit survivre est déjà dans
> `docs/suivi-asteroides.md` (§ « 2026-11-05 — Révision ») et dans le journal.

Écrit le 2026-11-05 pour un agent qui démarre à froid. Tu n'as pas vu la conversation : tout ce qu'il
faut est ici ou dans les fichiers cités.

## Avant tout

1. Lis `CLAUDE.md` (racine) : contraintes, vérifications, agents.
2. Lis `docs/suivi-asteroides.md` en entier (court) : le suivi tel qu'il existe, les pas de table
   **mesurés**, et la révision du 2026-11-05 en fin de fichier.
3. Lis `backend/API.md` § `GET /api/small-body/positions` (ligne ~274).
4. **Ne code rien avant d'avoir fait valider la conception par l'utilisateur** (voir « Conception à
   faire valider »). C'est l'outil phare du projet ; l'utilisateur veut le bichonner.

## Interdits (rappel)

- Aucun test navigateur, aucun pilotage de navigateur, rien à installer pour ça, pas de serveur dev
  lancé pour regarder. Le rendu, c'est l'utilisateur qui le valide, avec ta checklist.
- Jamais d'appel à `/api/neo` (quota NASA, un hook le bloque). Horizons, SBDB, CAD sont sans clé : les
  mesurer est permis et encouragé.
- PHPStan toujours avec `--memory-limit=512M`, zéro erreur, rien de silencé.
- Commentaires datés existants : on les garde (refus explicite de l'utilisateur de les élaguer).

## Vocabulaire — à tenir partout (l'utilisateur y tient)

- **Objet suivi** : n'importe quel astéroïde choisi dans l'onglet Suivi (comètes exclues, backlog).
- Un objet suivi **peut être aussi un NEO** (`neo: true` dans SBDB) : c'est lui qui a la table horaire
  et les segments de 5 min. Un objet suivi qui n'est pas un NEO a une table journalière.
- **NEO de la semaine** : l'onglet NEO, une autre chose. **Hors périmètre, on n'y touche pas.**

## Ce qui existe (après le lot 1, même branche)

- Jusqu'à **10 objets suivis**, couleur + trait plein/pointillé, interrupteur « Garder » (persistés
  seulement si gardés), file de chargement un par un (`web/src/tracking/scene.js`).
- Backend : `GET /api/small-body/positions?spkid=…`, **un SPK-ID par appel** (5 objets froids en un
  appel = 26,8 s contre le mur PHP de 30 s). Réponse : table de base géocentrique ICRF en km
  (`start`, `step_seconds`, `positions`), segments fins de 5 min ±12 h autour des rapprochements
  < 0,0005 ua (au plus 10), rapprochements CAD (`dist-max=0.05`). Fenêtre = celle de l'horloge
  (`SolarSystemClient::positionsStart` → `windowEnd` : 3 mois avant le 1ᵉʳ du mois → +365 j). Cache
  `small_body_positions_<spkid>_<1er du mois>_…`, 24 h (`SmallBodyController`). Client :
  `SmallBodyPositionsClient` (`NEO_STEP_SECONDS = 3600`, `OTHER_STEP_SECONDS = 86400`,
  `FINE_STEP_SECONDS = 300`).
- Web : `web/src/tracking/model.js` (règles pures : `tableAt`, `positionAt`, `nextApproach`,
  `flybyArcTimes`…), `tracking/scene.js` (chargement, marqueurs, deux traces : héliocentrique sur
  toute la table éclaircie à 6 h, et arcs de survol géocentriques ±15 j vus de la Terre),
  `tracking/controller.js` (onglet), `ui/tabs/tracking.js` (HTML de l'onglet).
- Horloge globale : `web/src/ephemeris/clock.js` (`CLOCK_RATES` jusqu'à 1 j/s, bornes),
  `web/src/app/time.js` (bornes tirées de la table du Soleil, `refreshBounds`).

## Ce qui a été décidé (2026-11-05, avec l'utilisateur)

1. L'outil a **son propre curseur de temps**, indépendant de l'horloge globale.
2. Ce curseur est en **temps relatif** sur **−1 an / +4 ans** (relatif à maintenant).
3. **Remise à zéro automatique** du curseur quand l'horloge globale est altérée (accélérée ou
   reculée).
4. Deux besoins, deux tables :
   - **dessiner** toute la trajectoire sur 5 ans : table **journalière pour tout objet suivi**
     (~1 800 lignes, ~60 ko servis) ;
   - **placer** l'objet avec précision : pour un objet suivi qui est un NEO, table horaire + segments
     de 5 min, **découpés par année** et chargés autour de l'instant du curseur ; pour un objet suivi
     qui n'est pas un NEO, la journalière suffit.
5. Les rapprochements (CAD) sur toute la plage −1/+4, et les arcs de survol suivent.

## Chiffres mesurés qui contraignent la conception

| Mesure | Valeur | Source |
|---|---|---|
| Erreur du pas journalier loin de la Terre (≥ 176 M km) | ~14 km, plancher dû au mouvement de la Terre | 2026-10-27 |
| Erreur du pas journalier près de la Terre | 34 290 km à 40 000 km : inutilisable | 2026-10-27 |
| Erreur du pas horaire | 61 km à 40 000 km ; 2 442 km à 7 500 km (d'où les 5 min) | 2026-10-27 |
| Table horaire 15 mois (Apophis) | 10 995 lignes, 6,9 s Horizons, 1,36 Mo bruts, ~360 ko servis | 2026-10-27 |
| Table horaire 5 ans d'une traite | ~44 000 lignes, **~27 s extrapolées** : ne tient pas (délai `HorizonsClient` 20 s, mur PHP 30 s) | extrapolé |
| Table journalière 5 ans (planète, même ordre pour un astéroïde) | 1 831 lignes, ~2,2 s Horizons | 2026-11-05 |
| `php -S` sous Windows | une requête à la fois, `PHP_CLI_SERVER_WORKERS` inopérant | 2026-11-05 |

**À mesurer avant de figer** (Horizons et CAD sont sans clé) : le temps réel d'une table horaire d'un
an pour un NEO ; le nombre de rapprochements < 0,0005 ua sur 5 ans pour quelques NEO réels (le plafond
« au plus 10 » par réponse a été pensé pour 15 mois) ; le temps d'une table journalière 5 ans d'un
astéroïde.

## Conception à faire valider par l'utilisateur avant de coder

Présente-lui des propositions, chacune avec ta recommandation :

- **Contrat backend** : une route « trajectoire » (journalière, plage −1/+4) et une route « précision »
  par (SPK-ID, année) ? Ou un paramètre sur la route existante ? La route existante est un **contrat
  publié** (`backend/API.md`) : on ne la casse pas, on ajoute. Ancrage des plages : relatif à
  « maintenant » (glisse chaque mois → re-calcul) ou tranches civiles immuables (cache sans
  expiration, cf. `docs/plage-cinq-ans.md` §2 — c'est la direction du lot 3, cohérence souhaitable).
- **Le curseur** : où il vit dans l'UI (onglet Suivi ? barre dédiée ?), sa granularité, ce qu'il
  pilote exactement (tous les objets suivis à la fois — probable — ou un seul), ce qu'affiche la scène
  pendant ce temps (les planètes restent à l'heure globale ? alors la position d'un objet suivi par
  rapport à la Terre n'a de sens qu'avec une Terre au même instant — **point à trancher**, c'est le
  piège principal de « temps relatif » : un tracé géocentrique ou un survol vu de la Terre suppose une
  Terre au même instant que l'objet).
- **« Horloge globale altérée »** : définir précisément l'événement qui remet le curseur à zéro
  (changement de vitesse ≠ temps réel, saut, recul) à partir de `app/time.js`.
- **Préchargement** : quelles tranches de précision charger autour du curseur, et quand.
- **Ce qui disparaît** : la trace actuelle sur la fenêtre de l'horloge est remplacée par la trajectoire
  −1/+4 ; « Aller au prochain rapprochement » règle-t-il désormais le curseur de l'outil plutôt que
  l'horloge globale ?

## Découpage suggéré une fois validé

- `backend-php` : routes, client, cache, PHPUnit, `backend/API.md`.
- `web-scene` : curseur, chargement par tranches, traces, règles pures + Vitest.
- `docs-journal` : entrée datée dans `docs/agent/decisions.md`, mise à jour de
  `docs/suivi-asteroides.md`.

## Vérifier

Les cinq contrôles de `CLAUDE.md` (`/verif`), avec les vrais chiffres, puis une **checklist visuelle**
précise pour l'utilisateur.
