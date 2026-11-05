# Plage −1 an / +4 ans pour toute la scène — ce qui coince vraiment (rapport du 2026-11-05 ; décisions puis « Lot 3 — ce qui a été construit » en fin de fichier : lot 3 construit le 2026-11-05, rendu à valider à l'œil)

Rapport demandé par l'utilisateur le 2026-11-05. Question posée : qu'est-ce qui empêche d'afficher
**toute** la scène sur une plage de −1 an à +4 ans, au lieu des ~15 mois actuels (3 mois avant le
1ᵉʳ du mois → +365 j) ? Et son intuition : « on télécharge une fois la table d'une planète, on peut
la garder 4 ans, non ? »

Réponse courte : **oui, pour les planètes, et ce n'est pas le cas aujourd'hui** ; le vrai goulot
n'est ni Horizons ni le navigateur, ce sont **les lunes des planètes**, et deux objets (ISS, NEO de
la semaine) qui ne peuvent par nature pas couvrir cinq ans.

Tous les chiffres ci-dessous ont été mesurés le 2026-11-05 (Horizons sans clé, backend local en
HTTP direct). Aucun ne touche au quota NASA.

## 1. Horizons n'est pas le goulot

Une table par corps et par appel (règle actuelle, `SolarSystemController`), mêmes paramètres que
`HorizonsClient::getVectors` :

| Table | Pas | Lignes | Temps Horizons | Taille brute (CSV dans JSON) |
|---|---|---|---|---|
| Mars, 15 mois (actuel) | 1 j | 462 | 1,2 s | 62 ko |
| Mars, 5 ans | 1 j | 1 831 | 2,2 s | 232 ko |
| Soleil, 5 ans | 1 j | 1 831 | 2,1 s | 232 ko |
| Neptune, 5 ans | 1 j | 1 831 | 2,2 s | 232 ko |
| Lune, 15 mois (actuel) | 6 h | 1 833 | 2,1 s | 232 ko |
| Lune, 5 ans | 6 h | 7 309 | **4,9 s** | 911 ko |
| Vénus / Mercure, 5 ans | 6 h | 7 309 | 3,8 / 3,9 s | 911 ko |

Le pire cas planétaire sur cinq ans est **4,9 s**, loin du délai de 20 s de `HorizonsClient` et du
mur PHP de 30 s. Allonger la plage ne demande aucun découpage côté planètes.

## 2. « Télécharger une fois, garder 4 ans » : juste, et pas ce qu'on fait

La table d'une planète pour un intervalle de dates donné **ne change pas** : l'éphéméride (DE440)
est figée, la table de Mars du 2027-01-01 au 2028-01-01 sera la même dans trois ans. On pourrait
donc la télécharger une fois pour toutes.

Ce qui l'empêche aujourd'hui : la fenêtre **glisse** avec le mois. Elle part du 1ᵉʳ du mois courant
(`SolarSystemClient::windowStart`), et cette date est dans la clé de cache
(`solar_system_<id>_<1er du mois>_…`). Chaque mois, toutes les tables sont recalculées en entier,
alors que 14 mois sur 15 sont identiques à celles du mois précédent.

Ce qu'il faudrait : **des tranches fixes par année civile** (« Mars 2027 », « Lune 2028 »),
immuables, donc :

- côté backend, un cache sans expiration (une tranche est calculée une fois, jamais plus) ;
- côté navigateur, des URL stables par tranche servies avec `Cache-Control: public, max-age=…,
  immutable` : le cache HTTP du navigateur les garde sans passer par le `localStorage`. Aujourd'hui,
  aucune route ne pose d'en-tête de cache (seul `FrontendController` pose `no-cache`) ;
- une plage −1/+4 touche **6 années civiles** au plus ; une nouvelle tranche par an, le 1ᵉʳ janvier,
  c'est tout le travail de rafraîchissement.

Le même raisonnement vaut pour l'orientation des planètes (`/api/solar-system/orientation`, époque =
1ᵉʳ du mois), ~~à une réserve près, non vérifiée : sur cinq ans, une erreur sur la vitesse de rotation
s'accumule ; à mesurer avant de figer une époque.~~ **Mesuré et levé le 2026-11-05** : planètes ≤ 0,016°
sur 6 ans, la Lune seule dérive (pôle jusqu'à 1,98° d'une époque fixe), d'où une époque au 1/1 de
chaque année — voir « Lot 3 — ce qui a été construit ».

## 3. Le navigateur n'est pas le goulot non plus (pour les planètes)

Taille réelle des réponses du backend (positions en km entiers), mesurée :

| Route | Lignes | Taille servie | Octets par ligne |
|---|---|---|---|
| `positions?body=mars` (15 mois, 1 j) | 458 | 14,7 ko | ~32 |
| `positions?body=moon` (15 mois, 6 h) | 1 829 | 43,6 ko | ~24 |
| `moons?planet=jupiter` (9 lunes, 500 échantillons) | 4 500 | 79,9 ko | ~18 |

Extrapolé à cinq ans : 7 corps au pas journalier (Soleil, Mars → Pluton) ≈ 7 × 59 ko, 3 corps au
pas de 6 h (Lune, Mercure, Vénus) ≈ 3 × 175–235 ko, soit **~1 Mo** en tout, contre ~240 ko
aujourd'hui. Ça tient dans le `localStorage` (~5 Mo par site). Et même s'il débordait, ce ne serait
pas une panne : `saveCached` avale l'erreur de quota (`web/src/data/cache.js`) et la table est
simplement redemandée au backend, qui la sert depuis son cache.

La note de `HISTORY_MONTHS` (« compromis entre la portée et la taille des tables que garde le
navigateur ») surestimait donc ce coût.

## 4. Le vrai goulot : les lunes des planètes

Les 39 lunes (`MoonClient`) ne sont pas construites comme les planètes :

- **budget fixe de 500 échantillons**, pas de 1/45ᵉ de période, fenêtre plafonnée à un an. Phobos
  (période 7,65 h) n'a donc que ~3,5 jours de table ;
- fenêtre **ancrée sur l'heure réelle** (`covers()` dans `web/src/scene/moons.js` lit `Date.now()`,
  pas l'horloge de la scène) ;
- **au-delà de sa table, une lune est figée** au dernier point (`sampleCatmullRom` borne), jusqu'à la
  visite suivante.

Ce n'est pas un problème nouveau : avec l'horloge à 1 j/s (`CLOCK_RATES.DAY_PER_SECOND`), Phobos
sort de sa table en ~3,5 s **dès aujourd'hui**, sur la plage de 15 mois. La plage de cinq ans le
rend simplement impossible à ignorer.

Le couvrir avec des tables, mesuré : Io sur cinq ans au pas actuel (57 min) = **46 135 lignes,
8,4 s, 5,7 Mo bruts** chez Horizons, ~0,8 Mo servis. Pour 39 lunes, des dizaines de Mo. Possible
côté backend, déraisonnable à envoyer au navigateur.

Les pistes, à arbitrer (aucune n'est décidée) :

1. **Tranches autour de l'horloge** : le navigateur demande la tranche de la lune là où est
   l'horloge, plus la suivante. Juste en précision, mais à 1 j/s une lune rapide change de tranche
   toutes les quelques secondes : il faut précharger devant le curseur, et la latence se verra.
2. **Orbite moyenne analytique quand l'horloge accélère ou sort de la table** : ellipse képlérienne
   (avec précession du nœud et du périapse pour les lunes proches) à partir des éléments moyens.
   À 1 j/s Phobos fait trois tours par seconde : la précision du point n'est plus visible, le
   mouvement l'est. Tables précises en temps réel, modèle moyen ailleurs.
3. **Hybride** : 1 en temps réel ou lent, 2 au-delà d'un seuil de vitesse ou hors tranche.

La piste 3 paraît la plus saine, mais elle demande une décision (le projet a écarté Képler pour les
comètes en v1, `docs/cometes.md`, pour une raison de dérive : à mesurer aussi pour les lunes).

## 5. Ce qui ne peut pas couvrir cinq ans, par nature

- **L'ISS** : une trace de ~10 min autour de maintenant (`ephemeris/iss.js`), rien ailleurs. Prévoir
  sa position à des mois n'a pas de sens (manœuvres, freinage atmosphérique). Comportement actuel,
  honnête : hors trace, l'ISS n'est pas dessinée. Sur une plage de cinq ans, elle sera absente
  presque tout le temps.
- **Les NEO de la semaine** : un flux par semaine, et NeoWs est la seule source qui dépense le quota
  NASA (50 req/jour). Les étendre à cinq ans est exclu. Même comportement : absents hors de leur
  semaine. (Les **objets suivis** ne sont pas concernés : ils ont leur propre outil, avec son
  curseur −1/+4, décidé le 2026-11-05.)

## 6. Les autres changements, mécaniques

- **Les bornes de l'horloge** viennent de la table du Soleil (`app/time.js`, `refreshBounds`) : à
  dériver de la plage décidée (−1/+4) plutôt que de la table.
- **`app:solar-system:warm`** : avec des tranches immuables, il n'a plus à tout recalculer chaque
  mois, seulement à créer la tranche d'une nouvelle année.
- **Premier visiteur à froid** : 10 corps × 2–5 s par tranche, une fois par an. Sous Windows, `php -S`
  ne traite qu'une requête à la fois (mesuré le 2026-11-05 : `PHP_CLI_SERVER_WORKERS` → « forking is
  not supported on this platform »), d'où l'intérêt du préchauffage.
- **Précession, astronomie Terre/Soleil/Lune calculée** (`ephemeris/astronomy.js`) : du calcul pur,
  sans table ; a priori indifférent à la plage, non vérifié.

## Bilan

| Poste | Difficulté | Nature |
|---|---|---|
| Planètes, Soleil, Lune : temps Horizons | aucune | mesuré, ≤ 4,9 s par corps sur 5 ans |
| Planètes : poids dans le navigateur | faible | ~1 Mo, tient dans le `localStorage` |
| Planètes : fenêtre glissante → tranches annuelles immuables | moyenne | refonte des clés de cache et des routes, gain net (plus de recalcul mensuel) |
| Orientation des planètes sur 5 ans | à mesurer | dérive de la rotation |
| **Lunes des planètes** | **forte** | vraie reconception : tranches suivant l'horloge et/ou orbite moyenne |
| ISS, NEO de la semaine | impossible | absents hors de leur plage, comme aujourd'hui |

## Décisions de l'utilisateur (2026-11-05)

- **ISS et NEO de la semaine : hors périmètre.** Ils restent sur leur plage propre (trace de ~10 min,
  semaine du flux) et sont absents ailleurs, comme aujourd'hui.
- **Lunes des planètes : on s'en passe sur la plage étendue.** Pas de reconception (pistes 1–3 du §4
  abandonnées). À la place, livré dans le lot 1 :
  - une case **« Afficher les lunes »** dans l'onglet Planètes ;
  - hors de la plage de sa table, une lune est **masquée** au lieu d'être figée au dernier point
    (même logique que l'ISS hors de sa trace) ; revenue au présent, sa table est rechargée.
- **Lot 3 = la plage −1 an / +4 ans pour le reste de la scène** : tranches annuelles immuables pour
  Soleil, planètes, Lune, Pluton (§2), bornes de l'horloge dérivées de la plage (§6), orientation à
  mesurer avant de figer son époque (§2, mesurée depuis). Ce qui a été construit, le contrat et les
  mesures : section suivante. (Les fichiers de travail `docs/briefs/lot3-*.md` qui servaient de
  contexte aux agents sont supprimés au merge de la branche ; tout ce qui devait leur survivre est
  ci-dessous.)

## Lot 3 — ce qui a été construit (2026-11-05)

Code et vérifications automatiques faits le 2026-11-05 sur `suivi-plage-etendue` (PHPUnit 232 tests /
2 303 assertions, Vitest 554 tests sur 18 modules) ; **rendu pas encore validé à l'œil par
l'utilisateur**. Le raisonnement et les choix d'agents sont dans `docs/agent/decisions.md`, §
« 2026-11-05 — Lot 3 — plage −1 an / +4 ans pour la scène » ; le contrat des routes est dans
`backend/API.md`. Cette section garde ce qui doit survivre aux fichiers de travail supprimés au merge.

### Mesures qui fondent les choix (Horizons sans clé, 2026-11-05)

- **Orientation** (§2 : la réserve est levée). Construite par `PlanetOrientationClient::build` puis
  propagée, comparée à `ObsSub-LON` corrigé du temps-lumière, 2025→2031 au pas de 10 j : planètes
  ≤ 0,016° sur 6 ans (Mercure), pôles ≤ 0,02°, saut au 1/1 ≤ 0,005°. **Lune** : pôle jusqu'à 1,98° de
  celui d'une époque fixe ; avec une époque au 1/1 de chaque année, 0,54° au plus dans l'année, saut
  ≈ 0,5° (pôle) et ≤ 0,56° (méridien) au 1/1. D'où : une orientation par année, époque 1/1.
- **Orbites dessinées** (une période sidérale depuis l'époque, 3 600 intervalles) : la planète quitte
  son trait hors de la période, surtout **avant l'époque** — Jupiter 352 687 km, Saturne 844 874 km,
  Uranus ~1,2 Mkm, Neptune 744 762 km, Pluton 755 728 km, Mars 40 600 km. **Déjà vrai avant le lot 3**,
  avec les 3 mois d'historique de la fenêtre mensuelle. Avec une époque au 1/1 de l'année affichée,
  écart max dans l'année : Mercure 993 km, Vénus 1 425 km, Mars 103 km, Jupiter 311 km.
- **Tranche annuelle Horizons** (avec 2 lignes de recouvrement) : 1,0 à 1,2 s ; 51 ko bruts au pas de
  1 j (Mars, Soleil), 188 ko au pas de 6 h (Lune, Mercure).

### Conception

- **Tranche** = un corps × une année civile UTC, immuable. Années servies **Y−1 à Y+4** (Y = année UTC
  murale), six tranches du 1/1 (Y−1) 00:00 UTC au 1/1 (Y+5) 00:00 UTC : toujours [maintenant −1 an,
  maintenant +4 ans], ne glisse qu'au 1er janvier.
- **Recouvrement de 2 lignes de chaque côté** : `start = slice_start − 2 × step_seconds`, la table finit
  à `slice_end + 2 × step_seconds`, bornes incluses ; une tranche lue seule est en Catmull-Rom complet
  sur toute son année. Mars 2027 : 370 lignes ; Lune 2028 (bissextile) : 1 469 lignes.
- **Un paramètre `year=`** sur `/api/solar-system/positions`, `/orbit` et `/orientation`, entier dans
  [Y−1, Y+4], sinon 400 `{"error": "year must be between <Y−1> and <Y+4>"}`. Sans `year`, chaque
  route est servie à l'identique (fenêtre mensuelle), marquée « remplacée » ; le web ne l'appelle plus.
  Positions : réponse avec `year`, `slice_start`, `slice_end`, `start`, `step_seconds` (6 h pour `moon`,
  `mercury`, `venus`, 1 j sinon). Orbite : une période sidérale depuis le 1/1 `year` 00:00 UTC.
  Orientation : `epoch` = 1/1 `year` 00:00 UTC.
- **Cache backend** : clés `solar_system_<id>_y<year>_<step>_UTC_o2`,
  `solar_system_orbit_<id>_y<year>_UTC_360`, `solar_system_orientation_<id>_y<year>`, construites par
  des fonctions statiques partagées entre contrôleur et commande de préchauffage. TTL 3 ans pour une
  valeur non nulle (une tranche Y+4 expire avant de sortir de la plage et est redemandée une fois,
  ~1 s, accepté), 1 h pour une valeur nulle, échec de transport non caché (502). **Pas de
  `Cache-Control: immutable`** : un cache HTTP immuable empêche le client de s'auto-réparer quand il
  refuse une tranche (leçon du 2026-09-29) ; variante « immutable + version dans l'URL » au backlog.
- **`app:solar-system:warm`** : 162 tranches à froid (6 années × (10 positions + 8 orbites + 9
  orientations)), ~27 appels par an ensuite ; ne préchauffe plus la fenêtre mensuelle.
- **Web, assemblage** (`web/src/ephemeris/slices.js`, pur et testé ; `ephemeris/sliceSet.js` pour
  réseau et stockage ; `app/ephemerides.js` pour l'ordre) : les tranches d'un corps deviennent **une
  table continue** `{timeScale, start, stepSeconds, positions}`, recouvrement retiré d'après les
  `slice_start` / `slice_end` servis, lignes extérieures gardées ; seule la suite contiguë d'années qui
  contient l'année courante est utilisée. Le résultat est ligne pour ligne la table qu'Horizons aurait
  servie d'un seul tenant.
- **Bornes de l'horloge** : [mur −1 an, +4 ans] au minuit UTC, égales à `cursorBounds` de
  `tracking/model.js` (un test l'épingle), coupées à la couverture du Soleil quand elle est plus
  courte ; le temps réel reste exempt. Supprimés : `HISTORY_MONTHS`, `defaultMinMs`, `defaultMaxMs`,
  `TABLE_MARGIN_MS`, option `history` de `tableCovers`.
- **Ordre de chargement** : 6 tranches du Soleil, puis l'année courante de la Lune et des planètes,
  puis les autres années en s'éloignant (futur d'abord à égalité) ; 3 échecs de suite arrêtent le plan.
- **Planète hors couverture : masquée** (label et trait aussi). Soleil et Lune gardent leur série de
  secours (`astronomy.js`). Un pivot sur une planète sans tranche garde sa dernière position (cas rare).
- **Orbite et orientation** : celles de l'année de l'horloge simulée, chargées au changement d'année,
  l'ancienne gardée jusqu'à l'arrivée de la nouvelle (orientation : année chargée la plus proche,
  antérieure à égalité) ; orbites échouées retentées après 5 min.
- **`localStorage`** : `nasa-viz:positions-<id>-<année>`, `orbit-…`, `orientation-…`, validés à la
  relecture (`time_scale`, pas, `frame`, année dans la plage) ; au démarrage, purge des années hors plage
  et des anciennes clés `solar-system`, `solar-system-orbits`, `solar-system-orientation`, `sun`, `moon`.
- **Soleil unifié** : l'outil de trajectoire (`tracking/scene.js`) lit la table assemblée du Soleil de la
  scène au lieu de `/api/small-body/trajectory/sun` (route conservée, marquée remplacée) ;
  `heliocentricPath` prend son chemin non aligné (la table commence 2 j avant le 1/1), résultat
  identique. Seul « Maintenant » remet à zéro horloge et décalage du curseur, inchangé.
- **Hors périmètre, inchangé** : ISS, NEO de la semaine, lunes des planètes, reste de l'outil de
  trajectoire.

### Reste à valider à l'œil (par l'utilisateur)

Horloge aux deux bornes ; passage du 31 décembre au 1er janvier en accéléré (planètes et Lune
continues, orientation sans à-coup visible, orbites qui passent par leur planète) ; planète masquée hors
couverture ; compteur « n/8 » du panneau (ne compte que l'année courante) ; lunes toujours masquées hors
de leur plage.
