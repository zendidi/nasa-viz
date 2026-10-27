# Suivi d'astéroïdes — choix validés et plan (les trois lots sont livrés le 2026-10-27, branche `asteroid-tracking`, non fusionnée dans master)

Décidé avec l'utilisateur le 2026-10-27. Les chiffres ci-dessous ont été mesurés le même jour sur
les sources réelles (JPL SBDB, SBDB Query, Horizons — toutes sans clé, aucune ne touche au quota
NASA).

Le but : suivre et afficher **jusqu'à 5 astéroïdes au choix**, avec la meilleure précision
possible, en les retrouvant par n'importe lequel de leurs noms (nom, numéro, désignation
provisoire, identifiant JPL).

## D'abord, les mots : NEO ≠ astéroïde

Ce document emploie les deux termes, et ils ne sont **pas** interchangeables.

| Terme | Définition | Combien (SBDB Query, 2026-10-27) |
|---|---|---|
| **Astéroïde** | Tout petit corps rocheux du système solaire qui n'est pas une comète : ceinture principale, troyens, NEA, transneptuniens… | **1 577 460** (`sb-kind=a`) |
| **NEO** (*Near-Earth Object*) | Astéroïde **ou comète** dont le périhélie est < 1,3 ua — défini par son orbite, pas par sa nature | **43 018** (`sb-group=neo`) |
| **NEA** | NEO qui est un astéroïde | **42 809** (`sb-kind=a&sb-group=neo`) — les 209 autres NEO sont des comètes |
| **PHA** | NEA potentiellement dangereux : MOID Terre ≤ 0,05 ua et H ≤ 22 | **2 550** (`sb-group=pha`) |

Le chiffre de 1 577 460 se recoupe exactement avec les bornes d'enregistrement que Horizons
affiche : astéroïdes numérotés 1–895 910, non numérotés 50 000 001–50 681 550. Les « environ deux
millions » de l'ordre de grandeur courant, c'est ça.

Conséquences pour cette feature :

- Le **suivi porte sur les astéroïdes** — tous, NEO ou non. Un NEA est un astéroïde comme un autre
  ici ; un objet de la ceinture principale aussi.
- Les **comètes sont exclues en v1**, y compris les 209 comètes NEO : Horizons demande de choisir une
  apparition (`CAP`), c'est le chantier de `docs/cometes.md`.
- Ce que l'appli appelle aujourd'hui « Astéroïdes » (onglet, `/api/neo`, la liste de la semaine)
  est en réalité **les NEO** qui passent près de la Terre cette semaine — un sous-ensemble de
  ~150 objets sur 43 018. D'où le renommage de l'onglet en « NEO » (voir « Choix validés »).
- Certaines infos n'ont de sens que **pour un NEO** : PHA, MOID Terre, risque d'impact Sentry,
  rapprochements avec la Terre, fiche ESA NEOCC (l'ESA ne catalogue que les NEO). Pour un astéroïde
  de la ceinture principale elles sont absentes, et la fiche doit le dire proprement plutôt
  qu'afficher des cases vides.

## Choix validés

| Sujet | Choix |
|---|---|
| Périmètre | **Tous les astéroïdes**, comètes exclues en v1 |
| Nombre | **Jusqu'à 5** objets suivis à la fois, liste gardée dans le navigateur |
| Saisie | **Un seul champ libre** : nom, numéro, désignation provisoire (avec ou sans espace) ou SPK-ID. JPL SBDB résout ; si c'est ambigu, liste de candidats |
| Clé interne | **SPK-ID JPL**, seule forme que Horizons accepte à coup sûr (mesures ci-dessous). La désignation principale est gardée à côté pour re-résoudre |
| UI | **4ᵉ onglet « Suivi »** à côté d'ISS / Astéroïdes / Planètes |
| Fiche | **On réutilise la fiche NEO existante** (`detailsBlockHtml`, `web/src/neoInfo.js`) plutôt que d'en construire une nouvelle. Pour l'utilisateur c'est **une seule fiche**, toujours au même endroit, même mise en page : seules les lignes changent selon que l'objet est un NEO ou non |
| Onglets | Renommés **ISS · NEO · Planètes · Suivi** (validé 2026-10-27) : « Astéroïdes » désignait en fait les NEO de la semaine |
| Scène | Activer le suivi **masque par défaut les NEO de la semaine** : la scène et la place de la fiche ne servent plus qu'aux objets suivis, rien ne se chevauche |
| Pont avec la liste de la semaine | Un bouton **« Suivre »** dans la fiche de chaque NEO de la semaine l'ajoute au suivi |

## Ce que les sources acceptent (mesuré 2026-10-27)

### SBDB résout toutes les formes

`ssd-api.jpl.nasa.gov/sbdb.api?sstr=…` :

| Saisie | Résultat |
|---|---|
| `Apophis`, `99942`, `2004 MN4`, `2004MN4`, `20099942` | toutes → `spkid 20099942`, `99942 Apophis (2004 MN4)`, Aten, PHA |
| `2024 YR4` (non numéroté) | `spkid 54509621`, `(2024 YR4)` |
| `Bennu`, `1999 RQ36` | même objet |
| `Ida` (ceinture principale) | `spkid 20000243`, `243 Ida (A884 SB)`, `neo: false` |
| `apo` (partiel, sans étoile) | `code 200` « specified object was not found » |
| `Apo*` | `code 300`, `count 7`, liste `{pdes, name}` dont Apophis |
| `2024 YR*` | `code 300`, `count 62` |

Donc la recherche : essai exact, puis **si introuvable, réessai avec `*`** pour proposer des
candidats. `alt-des=1` donne les autres désignations (`2004 MN4` pour 99942) ; `ca-data=1` les
rapprochements (81 entrées pour Apophis, dont 2029-04-13 à 0,00025 ua).

### Horizons est plus étroit

| `COMMAND` | Résultat |
|---|---|
| `DES=2004 MN4;` | ✅ |
| `DES=2004MN4;` (sans espace) | ❌ No matches found |
| `DES=99942;` (numéro) | ❌ No matches found |
| `99942;` | ✅ |
| `20099942` (SPK-ID nu) | ❌ « IOBJ out of bounds » |
| `DES=20099942;` (SPK-ID) | ✅ |
| `DES=54509621;` (SPK-ID non numéroté) | ✅ |

Passer à Horizons ce que l'utilisateur a tapé échouerait sur des cas courants. **`DES=<SPK-ID>;`
est la seule forme qui marche partout** — d'où SBDB en amont, systématiquement.

### Piège : le SPK-ID change à la numérotation

Un astéroïde non numéroté a un SPK-ID en `5xxxxxxx` ; une fois numéroté, il passe en `2xxxxxxx`
(20 000 000 + numéro). Le SPK-ID est donc sûr au moment de la résolution, pas éternel. La liste
gardée stocke `{spkid, des, fullname}` et, si Horizons ou SBDB ne reconnaît plus le SPK-ID, on
re-résout par la désignation — la provisoire reste toujours connue de SBDB.

### Coût d'une table complète

Apophis, pas horaire, sur la fenêtre de l'horloge (3 mois avant le 1ᵉʳ du mois → +365 j) :
**10 995 lignes, 6,9 s, 1,36 Mo bruts** côté Horizons. Acceptable pour un objet, à condition d'être
mis en cache côté serveur ; 5 objets à froid = une batch de 5 requêtes parallèles
(`HorizonsClient::fetch` envoie tout avant de lire).

## Plan en trois lots

### Lot 1 — backend : la recherche

`GET /api/small-body/search?q=…` — **hors de `/api/neo`** : elle ne dépense aucun quota, n'est pas
limitée aux NEO, et le hook `quota-guard.sh` bloquerait sinon tout test au curl.

- trouvé : `{match: {spkid, des, fullname, kind, neo, pha, orbit_class}}` ;
- ambigu : `{candidates: [{pdes, name}…], count}` (liste tronquée, `count` dit le total) ;
- rien : `{match: null}` ;
- une comète (`kind` commençant par `c`) : refusée explicitement en v1, avec la raison.

`neo` et `pha` viennent de SBDB tels quels : c'est ce qui permettra à la fiche et au panneau de
savoir quelles lignes « NEO seulement » afficher.

### Lot 2 — backend : la table précise

`GET /api/small-body/positions?spkid=…` — **un seul SPK-ID par appel** (décidé 2026-10-27) : 5 NEO
froids en un appel ont pris **26,8 s** pour une limite PHP de 30 s, Horizons ne calculant pas une
batch en parallèle. Le web demande chacun de ses ≤ 5 objets dans son propre appel (~7–10 s à froid
pour un NEO, 0,1 s en cache), et chaque objet apparaît dès qu'il est prêt :

- table géocentrique ICRF en km, **même fenêtre que les planètes** (`SolarSystemClient::positionsStart`
  → +365 j) : la trajectoire couvre toute la plage de l'horloge — plus de « pas d'orbite au-delà de
  sa semaine » comme pour les NEO de la liste ;
- **table de base, pas selon l'objet** : **journalier** pour un astéroïde non-NEO, **horaire** pour un
  NEO (mesures ci-dessous) ;
- **pour un NEO seulement**, des **segments fins** autour des passages très proches : pas de 5 min,
  ± 12 h autour de chaque rapprochement de la fenêtre à moins de **0,0005 ua** (~75 000 km). Chaque
  segment est une petite table uniforme ; le client l'utilise quand l'instant tombe dedans, la table
  de base sinon ;
- **pour un NEO seulement** : les rapprochements avec la Terre (API CAD, `spk=<SPK-ID>`,
  `dist-max=0.05`) dans la fenêtre, plus le prochain après elle.

#### Mesures du pas (2026-10-27)

Catmull-Rom uniforme (comme `web/src/interpolate.js`) sur la table grossière, comparé à Horizons au
pas fin, en géocentrique. Erreur = distance 3D en km.

| Objet | Distance mini à la Terre | Table → référence | Erreur max | Médiane |
|---|---|---|---|---|
| 1 Ceres, 243 Ida, 434 Hungaria, 624 Hektor, 132 Aethra (non-NEO) | 181 M à 633 M km | 1 j → 1 h, 16 mois | **13,8 à 14,7** | 8,6 |
| 433 Eros (NEO, loin de la Terre cette année) | 176 M km | 1 j → 1 h, 16 mois | 15,2 | 8,4 |
| 2026 RG15 | 95 000 km | 1 j → 1 h | **9 160** | 4,8 |
| 2026 QC3 | 40 000 km | 1 j → 1 h | **34 290** | 1 901 |
| 2026 RG15 | 95 000 km | 1 h → 2 min | 4,2 | 0 |
| 2026 QC3 | 40 000 km | 1 h → 2 min | 61 | 0 |
| 2026 TP128 | 7 500 km | 1 h → 2 min | **2 442** | 0 |
| 2026 QC3 | 40 000 km | 10 min → 1 min | 0,2 | 0 |
| 2026 TP128 | 7 500 km | 10 min → 1 min | 106 | 0 |
| 2026 TP128 | 7 500 km | 5 min → 1 min | **16,4** | 0 |

Ce qu'on en tire :

- **Loin de la Terre, le pas journalier donne ~14 km quel que soit l'astéroïde**, à 180 millions de
  km et plus. Ce plancher commun vient du mouvement de la Terre elle-même (repère géocentrique),
  pas de l'astéroïde. Un pas horaire n'apporterait rien de visible : 24 fois plus de lignes pour
  rien.
- **Près de la Terre, le journalier est inutilisable** (34 000 km d'erreur à 40 000 km de distance).
  D'où le pas horaire pour tout NEO : c'est la catégorie qui *peut* passer près, et on ne veut pas
  deviner quand.
- **L'horaire tient jusqu'à ~100 000 km et lâche en dessous** : 61 km à 40 000 km, 2 442 km (un tiers
  de la distance) pour 2026 TP128, qui a frôlé la Terre à ~1 100 km d'altitude le 2026-10-15. Le pas
  de 5 min le ramène à 16 km, d'où les segments fins sous 0,0005 ua.
- Les passages pris pour la mesure viennent de l'API CAD (69 passages à moins de 0,005 ua entre
  2026-08 et 2027-10) : ce n'est pas un cas d'école, il y en a plusieurs par mois.

### Source en panne

Décidé 2026-10-27 : quand une source ne répond pas, **les panneaux disent qui** — « JPL Horizons est
en panne : impossible d'obtenir les données pour l'instant. » Chaque 502 du backend porte
désormais `source` (`JPL Horizons`, `JPL SBDB`, `JPL`, `NASA NeoWs / JPL CAD`…) et
`upstreamErrorMessage` (`web/src/api.js`) en fait la phrase. Les panneaux ISS, NEO, APOD et la fiche
l'affichent déjà ; l'onglet « Suivi » devra faire de même (lot 3).

### Lot 3 — web : l'onglet « Suivi »

*Livré et validé à l'œil le 2026-10-27 (commits `bb6c0d4`, `0f16f20`). Le bouton « centrer » de la
liste ci-dessous **n'a pas été construit** : il est sorti au backlog (`docs/agent/backlog.md`,
`#centrer-asteroide-suivi`). Ce qui a été construit et ce qui a changé en route :
`docs/agent/decisions.md`, « 2026-10-27 — Suivi d'astéroïdes… ».*

- champ de recherche (Entrée), liste de candidats si ambigu, liste des ≤ 5 objets suivis ;
- le suivi actif **masque les NEO de la semaine** (réversible) ; chaque objet suivi a un repère et un
  tracé de couleur propre sur toute la fenêtre ;
- cliquer un objet suivi affiche **la fiche existante** à sa place habituelle, alimentée par
  `/api/neo/details` — qui passe déjà par SBDB et répond pour n'importe quel astéroïde, malgré son
  nom (on ne renomme pas la route : c'est un contrat publié) ;
- la fiche distingue NEO / non-NEO : pour un astéroïde qui n'est pas un NEO, pas de lignes PHA,
  MOID Terre, Sentry ni ESA, mais une mention « pas un NEO » ; le texte « fréquent pour les petits
  NEO » devient neutre ;
- boutons : centrer, **aller au prochain rapprochement** (NEO seulement, règle l'horloge), retirer ;
- bouton **« Suivre »** dans la fiche des NEO de la semaine.

### Tests

- PHPUnit : résolveur avec SBDB simulé (trouvé, `code 300`, introuvable puis réessai `*`, comète
  refusée) ; commande `DES=<spkid>;` envoyée à Horizons ;
- Vitest : lecture des réponses, plafond de 5, choix des lignes NEO / non-NEO de la fiche ;
- rendu : checklist pour l'utilisateur, pas de test navigateur.

## Points encore ouverts

- **TTL du cache serveur** des tables : 1 jour comme `/api/neo/positions` par défaut ; plus long pour
  un objet numéroté à orbite bien établie, si la mesure le justifie.
