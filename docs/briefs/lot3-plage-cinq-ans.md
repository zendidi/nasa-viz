# Brief — lot 3 : plage −1 an / +4 ans pour la scène

> ⚠️ **FICHIER DE TRAVAIL — À SUPPRIMER AU MERGE** de la branche `suivi-plage-etendue` dans `master`
> (avec tout le dossier `docs/briefs/`). Ce qui doit survivre est dans `docs/plage-cinq-ans.md` et
> dans le journal.

Écrit le 2026-11-05 pour un agent qui démarre à froid. Tu n'as pas vu la conversation : tout ce qu'il
faut est ici ou dans les fichiers cités.

## Avant tout

1. Lis `CLAUDE.md` (racine) : contraintes, vérifications, agents.
2. Lis **`docs/plage-cinq-ans.md` en entier** : c'est le rapport mesuré de ce lot, avec les
   décisions de l'utilisateur en fin de fichier.
3. `grep '^### ' docs/agent/decisions.md`, puis le thème « Positions, orbites et repères » et
   « Cache et quota » : les choix déjà faits sur les fenêtres, les pas et les clés de cache.
4. **Fais valider la conception à l'utilisateur avant de coder** (voir plus bas).

## Interdits (rappel)

- Aucun test navigateur, aucun pilotage de navigateur, rien à installer pour ça, pas de serveur dev
  lancé pour regarder. Rendu validé par l'utilisateur, avec ta checklist.
- Jamais d'appel à `/api/neo` (quota NASA). Horizons est sans clé : mesurer est permis.
- PHPStan avec `--memory-limit=512M`, zéro erreur, rien de silencé.
- Commentaires datés existants : on les garde.

## Périmètre décidé (2026-11-05)

**Dedans** : Soleil, Mercure → Neptune, Pluton, la Lune — leurs tables de positions (et leurs orbites
dessinées si elles dépendent de la fenêtre), l'orientation des planètes, les bornes de l'horloge
globale : passer de ~15 mois (3 mois avant le 1ᵉʳ du mois → +365 j) à **−1 an / +4 ans**.

**Dehors** :
- **ISS et NEO de la semaine** : hors périmètre, restent sur leur plage propre et absents ailleurs.
- **Lunes des planètes** : pas de reconception. Le lot 1 (même branche) leur a donné une case
  « Afficher les lunes » et les **masque hors de la plage de leur table**. Ne pas y toucher.
- **Objets suivis** : ils ont leur propre outil et leur propre curseur (lot 2). Indépendant.

## Ce que le rapport a établi (mesuré le 2026-11-05)

- **Horizons n'est pas le goulot** : sur 5 ans, 1 831 lignes au pas journalier en ~2,2 s par corps ;
  le pire cas (Lune, Mercure, Vénus au pas de 6 h) 7 309 lignes en 3,8–4,9 s. Une table par corps et
  par appel tient largement sous le délai de 20 s de `HorizonsClient` et le mur PHP de 30 s.
- **Le navigateur n'est pas le goulot** : ~1 Mo servi pour toutes les planètes sur 5 ans (contre
  ~240 ko) ; ça tient dans le `localStorage`, et un dépassement n'est pas une panne (`saveCached`
  avale l'erreur, la table est redemandée au backend).
- **Le vrai gâchis aujourd'hui** : la fenêtre glisse avec le mois, et le 1ᵉʳ du mois est dans la clé
  de cache (`solar_system_<id>_<1er du mois>_<pas>_<échelle>_h<HISTORY_MONTHS>`,
  `SolarSystemController`). Chaque mois, tout est recalculé alors que 14 mois sur 15 sont identiques.
  Direction recommandée par le rapport : **tranches par année civile, immuables** (cache sans
  expiration côté backend, `Cache-Control: public, immutable` côté HTTP — aucune route n'en pose
  aujourd'hui), une nouvelle tranche par an.
- **Orientation** (`/api/solar-system/orientation`, époque = 1ᵉʳ du mois) : la dérive de la rotation
  sur 5 ans n'est **pas mesurée**. À mesurer avant de figer une époque.

## Où ça vit dans le code

- Backend : `SolarSystemClient` (`windowStart`, `positionsStart`, `windowEnd`, `HISTORY_MONTHS = 3`,
  `WINDOW_DAYS = 365`, `STEP_SECONDS`, `FINE_STEP_BODIES = moon/mercury/venus` à 6 h, `getOrbit`
  sur une période), `SolarSystemController` (routes `positions`, `orbit`, `orientation`, helper
  `monthly`), `PlanetOrientationClient`, `HorizonsClient`, commande `app:solar-system:warm`.
- Web : `web/src/ephemeris/clock.js` (`HISTORY_MONTHS`, `defaultMinMs`, `defaultMaxMs`, bornes),
  `web/src/app/time.js` (`refreshBounds` tire les bornes de la table du Soleil),
  `web/src/ephemeris/sunTable.js`, `web/src/ephemeris/positionTable.js` (`tableCovers`),
  `web/src/scene/planets.js` (cache `solar-system`), `web/src/scene/orientation.js`.
- Contrat : `backend/API.md` — routes publiées, on ajoute plutôt que casser.

## Conception à faire valider par l'utilisateur avant de coder

Avec ta recommandation pour chaque point :

- Forme des tranches (année civile ?), et la plage −1/+4 : relative à maintenant (bornes qui glissent,
  tranches fixes en dessous) — à confirmer.
- Contrat : nouveau paramètre `year=` sur les routes existantes, ou nouvelles routes ; compatibilité
  avec le web actuel pendant la transition.
- Cache navigateur : `localStorage` par tranche, ou cache HTTP `immutable`, ou les deux.
- L'horloge globale : comment le web assemble les tranches (une table continue reconstituée, ou une
  lecture par tranche dans `positionTable.js`), et la jonction entre deux années (le Catmull-Rom a
  besoin de voisins de part et d'autre).
- `app:solar-system:warm` : ce qu'il préchauffe désormais.

## Découpage suggéré une fois validé

- `backend-php` : tranches, clés de cache, en-têtes HTTP, warm, PHPUnit, `backend/API.md`.
- `web-scene` : lecture des tranches, jonctions, bornes de l'horloge, Vitest (épingler la continuité
  à la jonction de deux années : c'est un invariant invisible à l'œil, exactement ce que les tests du
  projet servent à tenir).
- `docs-journal` : entrée datée, mise à jour de `docs/plage-cinq-ans.md` et `ARCHITECTURE.md`.

## Vérifier

Les cinq contrôles de `CLAUDE.md` (`/verif`), avec les vrais chiffres, puis une **checklist visuelle**
pour l'utilisateur (horloge aux deux bornes, passage du 31 décembre au 1ᵉʳ janvier en accéléré,
planètes continues, lunes masquées hors de leur plage).
