# Comètes — choix validés et plan (non implémenté)

Décidé avec l'utilisateur le 2026-10-15. Les chiffres ci-dessous ont été mesurés le même jour sur
les sources réelles (toutes sans clé, aucune ne touche au quota NASA). Recherche de départ : un plan
en quatre sources (JPL SBDB Query, SBDB, Horizons, MPC + COBS), corrigé sur trois points plus bas.

## Choix validés

| Sujet | Choix |
|---|---|
| Périmètre | **20 comètes fixes**, pas de catalogue filtré (4 080 chez JPL, c'est trop) |
| Positions | **Tables JPL Horizons**, même modèle que les planètes : le point et le trait d'orbite viennent de Horizons, donc « un trait d'orbite passe par son astre » tient |
| Orbite tracée | Ellipse complète pour les périodiques (Halley = 76 ans, une seule requête, comme les 165 ans de Neptune). **Arc borné** (± quelques années autour du périhélie) pour e ≥ 1 ou très longue période |
| Képler | **Pas en v1.** `orbit.js` reste elliptique ; le solveur parabolique/hyperbolique n'arrivera qu'avec l'horloge simulée |
| Temps | Temps réel, comme toute la scène. Pour voir une comète active : un bouton « aller au périhélie » dans le panneau, plutôt que l'horloge simulée (`backlog.md#horloge-simulee`, toujours non décidée) |
| Rendu | Noyau = point lumineux + étiquette ; chevelure et queues seulement près du Soleil (≲ 3–5 ua), longueur fonction de r, passée par la courbe d'échelle. Niveau de réalisme des queues (deux queues courbées ou un panache anti-solaire) **pas encore tranché** |
| Panneau | Identité, type (P/ C/ I/), période, q, Q, e, i, **compte à rebours au périhélie**, r et Δ actuels, **magnitude estimée** (M1/K1) et visibilité, diamètre si connu, MOID |

## Les 20

Toutes résolues par Horizons le 2026-10-15 avec `COMMAND='DES=<désignation>;CAP;NOFRAG'`.
« Solution » = l'enregistrement Horizons retenu par `CAP` ; il change entre apparitions, donc **clé
de cache, jamais constante dans le code**. r = distance au Soleil ce jour-là.

| Groupe | Désignation | Nom | Solution | r (ua) | Intérêt |
|---|---|---|---|---|---|
| Sondes | `1P` | Halley | JPL#75 | 35,0 | rétrograde (i = 162°), 11 km |
| | `2P` | Encke | JPL#K273/23 | 2,0 | période 3,3 ans, q = 0,34 |
| | `9P` | Tempel 1 | JPL#K284/2 | 3,7 | Deep Impact, 6 km |
| | `19P` | Borrelly | JPL#K283/1 | 5,3 | Deep Space 1 |
| | `21P` | Giacobini-Zinner | JPL#K253/4 | 4,8 | ICE |
| | `67P` | Churyumov-Gerasimenko | JPL#K284/1 | 4,5 | Rosetta, 3,4 km |
| | `81P` | Wild 2 | JPL#K222/37 | 5,2 | Stardust |
| | `103P` | Hartley 2 | JPL#K233/5 | 5,9 | EPOXI, 1,6 km |
| Célèbres | `C/1995 O1` | Hale-Bopp | JPL#226 | 51,2 | 60 km, M1 = 4,8 |
| | `C/1996 B2` | Hyakutake | JPL#73 | 54,4 | q = 0,23 |
| | `109P` | Swift-Tuttle | JPL#32 | 43,0 | 26 km, Perséides (absente de `CometEls.txt`) |
| | `55P` | Tempel-Tuttle | JPL#J985/69 | 12,1 | Léonides |
| | `12P` | Pons-Brooks | JPL#K242/85 | 8,9 | retour 2024 |
| | `29P` | Schwassmann-Wachmann 1 | JPL#K192/82 | 6,3 | quasi circulaire (e = 0,045), sursauts |
| Récentes | `C/2020 F3` | NEOWISE | JPL#31 | 18,8 | |
| | `C/2023 A3` | Tsuchinshan-ATLAS | JPL#113 | 8,7 | |
| Interstellaire | `C/2025 N1` | 3I/ATLAS | JPL#54 | 12,3 | e = 6,14 ; `DES=3I` donne la même solution |
| Actives | `161P` | Hartley-IRAS | JPL#K262/1 | 1,4 | périhélie ~+45 j |
| | `C/2026 A2` | Bok | JPL#28 | 2,1 | périhélie ~+68 j |
| | `C/2025 V2` | Rankin | JPL#26 | 2,7 | périhélie ~+159 j |

Les trois « actives » sont là parce qu'en temps réel **presque toutes les célèbres sont loin du
Soleil** (Halley à 35 ua, Hale-Bopp à 51 ua) : sans elles, aucune queue à juger. Elles sont moins
documentées (pas de code de condition, pas de diamètre). Les comètes à 35–54 ua sortent au-delà
de l'orbite de Neptune (30 ua) : à vérifier dans le cadrage héliocentré.

## Mesures (2026-10-15)

- SBDB Query `sb-kind=c` : 4 080 comètes, 578 ko, 1,6 s ; 3 909 avec `sb-xfrag=1`.
  Code de condition **nul pour 2 890 / 3 909** (339 en code 0) → utilisable pour styliser un trait
  (pointillé si douteux), pas pour sélectionner. M1/K1 présents pour 1 995, diamètre pour 105.
  e ≥ 1 : 2 308 ; 0,98 < e < 1 : 641.
- **Époques anciennes dans SBDB Query** : médiane JD 2453642 (2005), Halley 1968. Ce sont les
  éléments de la solution, pas des éléments osculateurs du jour.
- MPC `CometEls.txt` : 963 comètes, 164 ko, **époque 2026-10-15** (osculateurs du jour) ; aussi en
  JSON (`Extended_Files/cometels.json.gz`, 53 ko).
- Dérive Képler vs Horizons, 12P à r = 8,9 ua : **396 000 km** avec les éléments SBDB (époque 2023),
  **96 000 km** avec ceux du MPC (époque du jour). Une seule comète, loin du Soleil — l'écart près du
  périhélie n'est pas mesuré. C'est ce qui fait choisir Horizons en v1.

## Corrections au plan de recherche initial

1. **Pas de « plan écliptique par défaut »** : la scène est en ICRF équatorial ; garder
   `REF_PLANE=FRAME` comme `HorizonsClient` le fait déjà (`HorizonsClient.php:229`). Sinon les
   comètes seraient basculées de ~23° par rapport au reste.
2. `CENTER='500@10'` n'est pas une incertitude : c'est déjà la syntaxe des orbites planétaires
   (décision du 2026-09-29).
3. Le code de condition ne peut pas filtrer (voir mesures).
4. `TLIST` inutile : `STEP_SIZE` comme pour les planètes. Le `;` de `COMMAND='DES=…;CAP;NOFRAG'`
   doit être encodé — déjà géré par le client (`HorizonsClient.php:217`), vérifié à nouveau ici
   (non encodé, curl refuse l'URL).

## Lots et estimation (~7–9 jours)

| Lot | Contenu | Effort |
|---|---|---|
| 1. Backend | Liste fixe des 20 (sur le modèle de `SolarSystemClient::BODIES`), tables Horizons positions + orbite, fiche SBDB (`phys-par`, M1/K1, non-grav), cache par comète **et** par solution, PHPUnit, `API.md` | 1,5–2 j |
| 2. Scène | Module `web/src/comets/` sur le modèle de `neo/scene.js` : points, orbites, picking, pivots, échelle | 2 j |
| 3. Chevelure et queues | Billboards additifs, direction anti-solaire, longueur selon r, fondu | 2–3 j (≈ 1 j si simple panache) |
| 4. Panneau | Fiche, magnitude estimée (Vitest), compte à rebours, « aller au périhélie » | 1–1,5 j |
| 5. Docs | Ce fichier, journal | 0,5 j |

Repère à trancher au lot 1 : les positions NEO et planètes de la scène sont **géocentriques**
(`API.md`, `/api/solar-system/positions`), les orbites planétaires **héliocentriques**. Suivre la
même répartition pour les comètes.

## Hors périmètre v1

- Solveur Képler parabolique/hyperbolique (avec l'horloge simulée).
- Comparaison JPL / MPC sur le modèle du journal NEO (`CometEls.txt`).
- COBS (magnitude observée, coma, longueur de queue) — attribution obligatoire, licence à vérifier.
- ESA NEOCC : inutile ici, ses données cométaires reprennent celles du JPL (non vérifié).
- API MPC `get-orb` pour les comètes : non testée.
