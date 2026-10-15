# IMCCE SsODNet / Miriade — source de données alternative (non intégrée)

Référence de l'étude initiale (2026-09-15). **Intégré depuis le 2026-09-17** : ssoCard alimente
`/api/neo/details` (en complément de JPL SBDB, qui couvre les objets récents que ssoCard ignore) et
JPL CAD est devenu la source de référence de `/api/neo`. Plan, constats à jour et décisions :
`docs/neo-jpl-ssodnet.md`.

Deux constats de l'intégration corrigent ce qui suit : pour les petits NEO d'un flux typique,
ssoCard n'a **ni taxonomie, ni diamètre, ni albédo** (seulement H, classe, MOID, orbite), et les
objets découverts dans l'année en sont absents — d'où SBDB en source principale de la fiche.

- Formulaire web : https://ssp.imcce.fr/forms/ssocard
- Doc API ssoCard : https://ssp.imcce.fr/webservices/ssodnet/api/ssocard/
- Vue d'ensemble SsODNet : https://ssp.imcce.fr/webservices/ssodnet/
- Éphémérides Miriade : https://ssp.imcce.fr/webservices/miriade/
- Schéma des champs (label, description, unité) : https://ssp.imcce.fr/data/metadata_asteroid.json

Opérés par l'IMCCE / LTE (Observatoire de Paris). Pas de clé API, pas de rate limit documenté.
**Citation demandée** : mentionner « LTE's SsODNet VO service » ou citer Berthier et al. 2023 — à
prévoir dans les crédits du site si on l'utilise. Client officiel conseillé : package Python
`rocks` (on appellera plutôt l'API HTTP directement depuis Symfony).

## Constats testés (2026-09-15)

| Test | Résultat |
|---|---|
| `ssocard.php?q=Apophis` | OK, ~22 ko. Classe `NEA>Aten>PHA`, diamètre 0,34 km, albédo 0,38, MOID Terre 0,0326 ua |
| `ssocard.php?q=2014_SU1` (petit NEO typique de NeoWs) | OK, ~12 ko, mais **ni diamètre ni albédo** (seulement magnitude absolue, taxonomie, couleurs) |
| `ssocard.php?q=2026_RG15` (NEO découvert récemment, approche le 2026-09-15 à 0,0006 ua) | **HTTP 404** `No SSO named '2026_RG15' found in SsODNet.quaero index` |
| `ssocard.php?q=67P` | OK — les comètes sont couvertes (le fichier de métadonnées dit à tort « asteroid, dwarf planet ») |
| `ssocard.php?q=Kalliope` (astéroïde avec satellite) | Fiche la plus complète : masse, densité, ellipsoïde, spins, satellites… (voir liste ci-dessous) |
| Miriade `ephemcc.php?...&-mime=json` sur Apophis | OK, JSON : position géocentrique RA/DEC, distance, magnitude par pas de temps |
| JPL `ssd-api.jpl.nasa.gov/cad.api?date-min=…&date-max=…&dist-max=0.2` | OK **sans clé**, 39 approches sur 7 jours (hors quota `api.nasa.gov`) |

Snapshot ssoCard testé : `ssocard.datetime = 2026-07-13` → les objets découverts depuis n'y sont
pas. Miriade annonce une mise à jour hebdomadaire (astéroïdes) et 3×/semaine (comètes).

## Ce que ssoCard ne fait PAS

- **Pas de liste par date** : c'est une fiche par objet (nom/numéro/désignation), pas un « quels
  objets passent près de la Terre entre X et Y » comme NeoWs `feed`.
- **Pas de données d'approche** (date, distance, vitesse relative) — il faut une autre source.
- Objets très récents absents (voir 404 ci-dessus), diamètre souvent absent pour les petits NEO.
- « Only non-null values are provided » : un champ absent = inconnu, ne jamais supposer sa présence.

## Informations disponibles dans une ssoCard

Chaque valeur numérique est un objet `{ value, error: {min, max} }` accompagné de `bibref`
(publication source), `method` et `links.datacloud` (toutes les mesures brutes).

**Identité** — `id`, `name`, `number`, `title`, `type` (Asteroid, Comet, Dwarf Planet…), `class`
(population dynamique hiérarchique : `NEA>Aten>PHA`, `MB>Outer`, `Short-period>Halley-type`…),
`aliases`, `system`, `parent`, `children` (satellites), `siblings`, `ephemeris` /
`physical-ephemeris` (booléens : Miriade sait-il calculer), `physical-models`.

**Dynamique** (`parameters.dynamical`)
- `orbital_elements` : demi-grand axe, excentricité, inclinaison, longitude du nœud, argument du
  périhélie, anomalie moyenne, mouvement moyen, période, périhélie/aphélie, date de passage au
  périhélie, époque, incertitude orbitale (`ceu`), nb d'observations, arc observé.
- `proper_elements` : éléments propres (stables sur le long terme, servent à définir les familles).
- `moid` : distance minimale entre orbites, **par planète** (Mercure → Neptune), en ua.
- `tisserand_parameters` : par planète géante.
- `delta_v` : Δv et temps de transfert pour une mission vers l'objet.
- `source_regions` : région d'origine probable (pour les NEA).
- `yarkovsky` : dérive orbitale due au rayonnement thermique.
- Selon l'objet : `family`, `pair` (appartenance à une famille / paire d'astéroïdes).

**Physique** (`parameters.physical`)
- `absolute_magnitude` (H, G), `diameter` (km), `albedo`, `ellipsoid` (rapports a/b, a/c, b/c).
- `mass` (kg), `density` (kg/m³), `hill_sphere_radius`.
- `taxonomy` (classe spectrale — utile pour colorer un astéroïde), `colors` (indices de couleur).
- `thermal_inertia`, `spins` (période de rotation, orientation du pôle), `phase_functions`.

**Vecteur d'état** (`parameters.eq_state_vector`) — position et vitesse cartésiennes à une époque
de référence.

**Observations** — liens vers données astrométriques / polarimétriques.

## Autres services IMCCE utiles

**SsODNet**
- `quaero` : résolution de noms (désignation ↔ id), recherche d'objets.
- `datacloud` : toutes les mesures publiées d'une propriété (pas seulement la « meilleure »).
- `ssoBFT` : table plate unique avec les meilleures estimations de *tous* les objets — téléchargeable
  en un fichier (pertinent pour un cache local / pré-calcul plutôt que N appels).

**Miriade** (éphémérides)
- `ephemcc` : position d'un corps (planètes, Lune, satellites, astéroïdes, comètes) à une date,
  vue depuis la Terre ou un autre point (L2, Gaia…). Testé en JSON.
- `ephemsys` : positions des satellites d'astéroïdes.
- `ephemph` / `psv` : aspect physique apparent (orientation, éclairage).
- `rts` : heures de lever / transit / coucher (Soleil, Lune, planètes).
- `vision` : visibilité d'une cible pour une nuit d'observation.

## Plan d'optimisation envisagé

1. **Liste** des approches via JPL CAD (`cad.api`, sans clé, hors quota `api.nasa.gov`) au lieu de
   NeoWs `feed`.
2. **Enrichissement** au clic d'un NEO via ssoCard (cache serveur long, les fiches bougent peu).
   Fallback silencieux sur les données JPL si 404.
3. **Contrat `backend/API.md` inchangé** — seule la source derrière `/api/neo` change, le web et le
   futur client Unity n'y voient rien. `NasaUsageTracker` / `GET /api/usage` à adapter (ne compte
   que `api.nasa.gov`).

Correspondance des champs actuels de `/api/neo` :

| Champ `/api/neo` | Source possible |
|---|---|
| `name` | JPL CAD `des` / ssoCard `name` |
| `estimated_diameter_km.min/max` | ssoCard `diameter` si présent ; sinon depuis H (JPL CAD `h`) : `D = 1329 / √albedo × 10^(−H/5)` avec albédo 0,25 → min et 0,05 → max (même méthode que NeoWs) |
| `is_potentially_hazardous` | ssoCard `class` contient `PHA` |
| `close_approach.date` | JPL CAD `cd` |
| `close_approach.miss_distance_km` | JPL CAD `dist` (ua) × 149 597 870,7 |
| `close_approach.relative_velocity_kmh` | JPL CAD `v_rel` (km/s) × 3600 |

Pistes au-delà du remplacement (surtout VR, cf. décision « VR = plus loin ») : tracer les orbites
depuis `orbital_elements`, afficher les satellites (`children` + `ephemsys`), couleur par
`taxonomy`, forme/rotation via `ellipsoid` + `spins`, positions réelles via `ephemcc`.
