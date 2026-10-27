# Suivi d'astéroïdes — choix validés et plan (non implémenté)

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

`GET /api/small-body/positions?spkid=…` (1 à 5 SPK-ID) :

- table géocentrique ICRF en km, **même fenêtre que les planètes** (`SolarSystemClient::positionsStart`
  → +365 j) : la trajectoire couvre toute la plage de l'horloge — plus de « pas d'orbite au-delà de
  sa semaine » comme pour les NEO de la liste ;
- **pas selon l'objet** : horaire pour un NEO (rapide et courbé vu de la Terre), à mesurer pour un
  astéroïde non-NEO — un pas journalier en Catmull-Rom suffit pour Jupiter (36 km, 2026-10-15),
  la ceinture principale devrait être du même ordre, **à vérifier contre Horizons horaire avant de
  le décider** ;
- **pour un NEO seulement** : les rapprochements avec la Terre (SBDB `ca-data=1`) dans la fenêtre,
  plus le prochain après ;
- raffinement possible (pas plus fin autour d'un rapprochement serré) **seulement après avoir mesuré**
  l'erreur du pas horaire sur un passage proche, comme pour la Lune.

### Lot 3 — web : l'onglet « Suivi »

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

- **Pas pour les astéroïdes non-NEO** : journalier ou horaire, à trancher sur mesure (lot 2).
- **TTL du cache serveur** des tables : 1 jour comme `/api/neo/positions` par défaut ; plus long pour
  un objet numéroté à orbite bien établie, si la mesure le justifie.
