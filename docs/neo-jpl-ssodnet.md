# NEO — sources multiples (JPL, NASA NeoWs, ESA), fiche SBDB/ssoCard, trajectoire — plan (non implémenté)

Planifié le 2026-09-17 sur la branche `neo-jpl-ssodnet`. Fait suite à `docs/imcce-ssodnet.md` (étude
du 2026-09-15), en l'ajustant avec les tests ci-dessous.

## D'où viennent les données (pourquoi comparer)

```
Télescopes (Catalina, Pan-STARRS, ATLAS…) → Minor Planet Center (toutes les observations)
   ├─► JPL (NASA) calcule les orbites ─► JPL CAD / SBDB / Sentry / Horizons
   │                                     └─► NASA NeoWs (copie mise en forme, clé + quota)
   └─► ESA NEOCC calcule ses propres orbites ─► listes d'approches, liste de risque
```

- **NeoWs ↔ JPL** = même calcul → contrôle de **cohérence/fraîcheur** (affichage, découpage des
  dates, portée, retard de mise à jour).
- **JPL ↔ ESA** = mêmes observations, **calculs indépendants** → comparaison **scientifique** :
  écarts de distance/date/vitesse/H, rapportés à la marge d'erreur JPL.

## Choix validés

| Sujet | Choix |
|---|---|
| Liste `/api/neo` | **Trois sources** : JPL CAD (référence) + NASA NeoWs + ESA NEOCC, fusionnées ; un objet absent d'une source qui aurait dû le voir est **signalé** dans l'UI |
| Comparaison ESA | **Journal + UI** (écart affiché dans la modal pour les objets couverts par l'ESA) |
| Journal | **Complet si changement** : toutes les valeurs brutes de chaque source par objet, une ligne seulement quand les données ont changé ; dev et prod |
| Portée JPL (`dist-max`) | **Calée sur NeoWs** via 1 vrai appel NeoWs (1 requête de quota) |
| Fiche détaillée | **JPL SBDB** (toujours) + **IMCCE ssoCard en bonus** + **JPL Sentry** (risque d'impact) |
| Chargement des fiches | En fond pour tous les NEO du feed (nécessaire à la couleur), modal immédiate si déjà chargée |
| Couleur des points | **Par taxonomie quand elle est connue** ; un **PHA reste rouge** (prioritaire), sa taxonomie est dans la modal |
| Orbite | **Trajectoire 3D géocentrique** du NEO sélectionné (Horizons) + **schéma SVG héliocentrique** dans la modal |

## Constats testés (2026-09-17)

| Test | Résultat |
|---|---|
| JPL CAD `date-min=2026-09-17T00:00:00&date-max=…T23:59:59&dist-max=0.5&fullname=true&diameter=true` | 13 approches. Champs : `des, orbit_id, jd, cd, dist, dist_min, dist_max, v_rel, v_inf, t_sigma_f, h, diameter, diameter_sigma, fullname`. `diameter` quasi toujours `null`. `cd` à la minute (TDB) |
| CAD + `pha=true` | Ne renvoie que les PHA (ici `2026 NT2`) → drapeau PHA sans autre source |
| ESA `esa_upcoming_close_app` | Texte à colonnes `|`, 25 ko, 178 lignes : approches **< 0,05 ua**, d'aujourd'hui à **+1 an**. Colonnes : désignation (`2026RB39` compacte, ou `524522 Zoozve` si numéroté), date **sans heure**, km, ua, LD, diamètre m (+ `*` = estimé), H, magnitude max, v_rel km/s, indice CAI. `Last Update:` en tête |
| ESA `esa_recent_close_app` | Même format, 20 ko, approches **passées** (~1 mois) |
| ESA `esa_risk_list` | 276 ko, liste de risque d'impact ESA (équivalent indépendant de Sentry) |
| JPL vs ESA, objets < 0,05 ua du jour | **Mêmes 4 objets**. Distances : 2026 RB39 identique ; 2026 NT2 ~150 km d'écart ; **2026 RN4 ~1 500 km** ; **2026 RD38 ~1 900 km** |
| ssoCard sur 7 objets du jour | **2 × 404** (`2026 NT2`, `2026 RB39` — snapshot ssoCard du 2026-07-13). Les 5 trouvés : **ni taxonomie, ni diamètre, ni albédo** — seulement H, classe, MOID, éléments orbitaux, Δv, Tisserand. ~0,6–1 s par fiche |
| JPL SBDB `sbdb.api?sstr=2026 NT2&phys-par=1` | OK (objet récent couvert) : `pha`, `orbit_class`, `moid`, éléments `e a q i om w ma tp per n ad`, epoch |
| SBDB sur Apophis | `phys_par` : `H, G, diameter, rot_per, albedo, spec_B` (« Sq »)… → SBDB porte aussi taxonomie/diamètre quand ils existent |
| SBDB objet inconnu | HTTP 200, `{"message":"specified object was not found","code":"200"}` (pas de clé `object`) |
| JPL Sentry liste / `?des=` | 2 205 objets en un appel / détail `summary` (`ip`, `ps_cum`, `ts_max`, `n_imp`…) ou `{"error":"specified object not found"}` |
| NASA NeoWs | **Non appelé** (quota). Format documenté : rien que JPL n'ait pas |

**Conséquence** : pour les petits NEO d'un feed typique, la couleur par taxonomie ne s'appliquera
qu'à une minorité (objets connus/gros). Accepté : couleur quand connue, défaut sinon.

## Backend

### 1. Clients de liste
- **`Service/JplCadClient.php`** : 2 appels concurrents CAD (liste + `pha=true`), plage
  `start T00:00:00 → end T23:59:59`, `dist-max` = constante calibrée, `fullname=true`,
  `diameter=true`. Colonnes lues **par nom via `fields`**. Garde **toutes** les valeurs brutes
  (dont `orbit_id`, `dist_min/max`, `v_inf`, `t_sigma_f`) pour le journal.
  Sentry liste complète (1 appel, cache 24 h) → `is_sentry_object`.
- **`NasaApiClient::getNeoFeed`** : conserve en plus les champs NeoWs aujourd'hui ignorés
  (`absolute_magnitude_h`, `is_sentry_object`, `close_approach_date_full`, distance en ua).
- **`Service/EsaNeoccClient.php`** : parse `esa_recent_close_app` + `esa_upcoming_close_app`
  (cache 6 h, `Last Update` conservé) et `esa_risk_list` (cache 24 h). Désignations
  normalisées : `2026RB39` → `2026 RB39` ; numérotés appariés par numéro (`524522` ↔ CAD fullname
  `524522 Zoozve (…)`). Parsing par colonnes `|` (en-tête à 4 lignes), tolérant aux lignes vides.
- Tous hors quota `api.nasa.gov` sauf NeoWs (seul compté par `NasaUsageTracker`).

### 2. `Service/NeoFeedMerger.php` (pur, sans HTTP)
- **JPL = référence** (portée calibrée, heure à la minute, marges d'erreur). Union par désignation.
- **Couverture attendue** par source, pour ne pas crier à l'écart à tort :
  - NeoWs : même portée que JPL (après calibrage) ;
  - ESA : seulement **< 0,05 ua** et dates couvertes par ses deux fichiers.
- Raisons probables d'absence : `distance_filter` (hors portée de la source), `date_boundary`
  (approche à < ~2 h d'une borne, ESA sans heure / découpage UTC-TDB), `not_covered` (plage hors
  fichiers ESA), `unknown` (le cas intéressant).
- **NeoWs ↔ JPL** : présence, PHA, distance (écart > 0,1 %), date, H → drapeau de cohérence.
- **JPL ↔ ESA** : écart distance en km et %, **dans / hors marge JPL** (`dist_min`–`dist_max`),
  écart de date (jour), vitesse, H, diamètre ; appartenance aux listes de risque Sentry vs ESA.
- Valeurs affichées : approche/H/PHA **JPL** ; diamètre JPL mesuré, sinon fourchette estimée
  depuis H (même méthode que NeoWs : `D = 1329/√p × 10^(−H/5)`, p = 0,25 / 0,05).
- Source en échec → les autres continuent, `sources.<nom> = "unavailable"`. JPL en échec → NeoWs
  sert de liste de repli. Toutes en échec → 502 (comportement actuel).

### 3. Journal de comparaison
- `Service/NeoComparisonLog.php` → `var/log/neo-comparison.jsonl`, **une ligne par récupération
  réelle dont le contenu a changé** (empreinte des valeurs brutes comparée à la dernière ligne de
  la même plage, gardée en cache). Pas de nouvelle dépendance (Monolog non installé).
- Contenu d'une ligne : horodatage, plage, `dist-max`, `Last Update` ESA, statut de chaque source,
  compteurs, puis **par objet** : valeurs brutes JPL / NeoWs / ESA (distance km+ua, marges JPL,
  date/heure, vitesse, H, diamètre + estimé/mesuré, PHA, Sentry / risque ESA, `orbit_id`), écarts
  calculés et raisons.
- Commande `php bin/console app:neo:comparison-report [--days=30]` : taux d'accord par paire,
  distribution des écarts JPL↔ESA (médiane, max, part hors marge JPL), absences par raison, objets
  `unknown` récurrents.
- `DEPLOYMENT.md` : `var/log/` persistant et inscriptible, estimation de taille.

### 4. `/api/neo` (contrat : ajouts uniquement)
- Même route, paramètres, cache 1 h, plage max 7 jours (message sans « NeoWs »). Quota NASA
  inchangé.
- Par objet, **en plus** : `designation`, `sources` (ex. `["jpl_cad","nasa_neows","esa_neocc"]`),
  `absolute_magnitude_h`, `is_sentry_object`, `close_approach.datetime` (ISO, TDB),
  `diameter_measured`, et `comparison` :
  `{ nasa_neows: "match"|"missing"|"mismatch", esa_neocc: { status: "match"|"missing"|"not_covered",
  distance_diff_km, within_jpl_uncertainty, reason } }`.
- `id` = désignation (l'id NeoWs n'existe pas pour un objet vu hors NeoWs). Seul changement de
  sens ; aucun client ne s'en sert hors du repli de direction web.
- Racine, **en plus** : `sources: {jpl_cad, nasa_neows, esa_neocc: "ok"|"unavailable"}`,
  `comparison: {both_jpl_neows, only_jpl, only_neows, esa_covered, esa_matched, esa_missing}`.

### 5. `Service/SmallBodyDetailsClient.php` + `GET /api/neo/details?designations=a,b`
- Max 10 désignations par appel. Par objet, en concurrence : SBDB (`phys-par=1`), ssoCard
  (espaces → `_`), Sentry `?des=` seulement si l'objet est dans la liste Sentry.
- Réponse par désignation (`null` si ni SBDB ni ssoCard ne le connaissent) : `fullname`,
  `orbit_class {code, name}`, `is_pha`, `absolute_magnitude_h`, `diameter_km {value, source}`,
  `albedo`, `taxonomy {class, complex, source}`, `rotation_period_h`, `density`, `mass_kg`,
  `moid_earth_au`, `orbit {epoch_jd, a_au, e, i_deg, node_deg, peri_deg, mean_anomaly_deg,
  period_days, q_au, ad_au}`, `impact_risk {probability, palermo_cum, torino_max, n_impacts, range}
  | null`, `sources {sbdb, ssocard, sentry}`, `links {jpl, ssocard}`.
- Priorité : taxonomie ssoCard > SBDB `spec_B` > `spec_T` ; diamètre/albédo ssoCard > SBDB.
- Cache par objet : 7 j si trouvé, 1 j si introuvable, **pas de cache** si une source est
  `unavailable`.

## Web

### 6. Sources et comparaison dans l'UI
- Panneau NEO : `23 objets · 1 absent de NASA · ESA : 4/4 concordants` (+ noms si écart), mention
  si une source est indisponible.
- Modal, bloc « Sources » : JPL (référence) ; NASA NeoWs ✓ / absent (raison) ; ESA ✓ avec
  « distance ESA 6 200 297 km · écart 1 500 km (dans la marge JPL) » / absent (raison) / non
  couvert (> 0,05 ua).
- Tooltip de survol NEO : suffixe discret en cas d'écart.
- Feeds `localStorage` d'avant le changement (sans `sources`) : affichés sans mention.

### 7. Fiches en fond + couleur
- `api.js` → `fetchNeoDetails(designations)` ; lots de 10 en fond après le feed, comme les
  positions. Cache `localStorage` `neo-details` **par désignation** (7 jours).
- Modal : fiche (classe, taxonomie, MOID Terre, orbite a/e/i/période, rotation, masse/densité,
  risque Sentry, liens JPL/SsODNet), chargée à la demande si pas encore reçue. Crédits :
  « NASA/JPL (CAD, SBDB, Sentry, Horizons) · ESA NEOCC · LTE's SsODNet VO service · NASA NeoWs ».
- Diamètre mesuré → remplace l'estimation pour la taille du point.
- Couleur par complexe taxonomique (S, C, X, V, autres) pour les non-PHA ; PHA rouge ; légende.

### 8. Trajectoire du NEO sélectionné
- Clic = sélection (persiste après fermeture de la modal ; Échap ou clic dans le vide
  désélectionne).
- `THREE.Line` depuis la table Horizons déjà chargée, chaque point passé par le **même mapping
  d'échelle** que le point NEO (suit le slider). Passé atténué / futur plus vif, repère au point
  d'approche minimale. Pas de table Horizons → pas de ligne, la modal le dit.

### 9. Schéma d'orbite (modal)
- `web/src/orbit.js` (pur) : Kepler depuis les éléments SBDB, positions héliocentriques écliptiques.
- SVG vu de dessus : Soleil, orbite terrestre, orbite du NEO (plein au-dessus de l'écliptique,
  pointillé en dessous), positions actuelles Terre/NEO, point de l'approche. Inclinaison en texte.

## Ordre d'implémentation

1. `JplCadClient` + `EsaNeoccClient` + champs NeoWs en plus, tests (fixtures réelles tronquées).
2. `NeoFeedMerger` (couverture, raisons, écarts) + tests.
3. `NeoComparisonLog` (empreinte « si changement ») + commande de rapport + tests.
4. `/api/neo` rebranché, dégradation par source ; **calibrage `dist-max` : 1 appel NeoWs**
   (après vérif `/api/usage`) ; `API.md`.
5. `SmallBodyDetailsClient` + `/api/neo/details` + tests (Apophis complet, petit NEO minimal,
   ssoCard 404, SBDB introuvable, source en panne).
6. Web : sources et comparaison (panneau, modal, tooltip).
7. Web : fiches en fond, modal détaillée, diamètre mesuré, couleur + légende.
8. Web : sélection + trajectoire 3D.
9. Web : `orbit.js` + schéma SVG.
10. Docs : `API.md`, `ARCHITECTURE.md`, `imcce-ssodnet.md` (statut + constats), `README.md`
    (crédits), `DEPLOYMENT.md` (journal), `docs/agent/decisions.md`, `gotchas.md` (SBDB 404 en
    HTTP 200, désignations compactes ESA, CAD en TDB, ESA sans heure), `backlog.md`.

## Vérification

- `php vendor/bin/phpunit`, `npm run build`.
- Appels HTTP directs : `/api/neo/details` (sans quota) ; `/api/neo` limité au calibrage + 1 contrôle
  (NeoWs mis en cache 1 h, donc 1 requête de quota au total si même plage), lecture de
  `var/log/neo-comparison.jsonl` et de la commande de rapport.
- Pas de test navigateur : checklist visuelle fournie à l'utilisateur à la fin.

## Hors périmètre (backlog)

- Ellipse héliocentrique 3D dans la scène.
- Miriade `ephemsys` (satellites d'astéroïdes), forme/rotation via `ellipsoid` + `spins`.
- Comparaison des orbites elles-mêmes (éléments JPL SBDB ↔ ESA ↔ IMCCE) au-delà des approches.
