# Planètes et lunes (système solaire)

Exploration du 2026-09-21, à la demande de l'utilisateur : « afficher les planètes et leurs lunes ».
Suite de `docs/points-de-vue.md`, qui laissait explicitement la place (`web/src/focus.js` : « the Moon
and the planets are the obvious next ones — they only need a position source »).

Ce document dit ce que les sources donnent réellement (testé, avec les chiffres), ce que
l'architecture actuelle absorbe sans rien changer, les trois seuls vrais chantiers, et ce qui
restait à trancher avec l'utilisateur.

> **Mise à jour du 2026-09-22 — les lots 1 et 2 sont livrés, les 4 questions du §5 sont tranchées.**
> Les réponses et ce qui en a découlé sont dans `docs/agent/decisions.md` ; la suite des lots est
> dans `docs/agent/backlog.md`. Deux corrections à lire avant de se servir des chiffres ci-dessous :
>
> - **§1, « ~1,1 s et ~50 ko par requête » est faux.** Remesuré le 2026-09-22 : une requête
>   d'éphémérides Horizons coûte **5 à 16 s, indépendamment du nombre d'échantillons** (366 points
>   ou 60, même prix ; une requête NEO existante prend 8,6 s le même jour). Le coût est le nombre
>   de requêtes, pas le nombre de points. Détail, symptômes et conséquences dans
>   `docs/agent/gotchas.md` → « Horizons met 5 à 16 s par requête ».
> - **§4, « le cache froid ≈ 18 s » est donc sous-estimé**, et c'est ce qui a imposé un corps par
>   appel HTTP plutôt qu'un jeu servi d'un bloc.
> - **§4 lot 2, « héliocentrique » est un piège.** L'annexe propose `CENTER='500@10'` pour tracer
>   une orbite. Ne pas le faire : la scène construit sa vue héliocentrée comme
>   `géocentrique − Soleil` et son Soleil vient de `astronomy.js`, qui est dans l'équinoxe de la
>   date quand les axes sont J2000 — 951 057 km d'écart avec DE441, soit la précession depuis J2000.
>   Une ellipse DE441 raterait Mercure de 0,127 unité de scène. L'orbite se demande donc en
>   **géocentrique**, et le client retranche le même Soleil que celui qui place la planète. Détail
>   dans `docs/agent/gotchas.md` → « astronomy.js calcule le Soleil dans l'équinoxe de la date ».
>
> Ce qui reste juste et a été vérifié à l'usage : le §2 en entier (les sept planètes tombent bien
> entre 19,65 et 26,16 unités au cran lisible, mesuré sur les vraies tables), le §3a (les tailles
> sont le seul endroit où le modèle cassait), le §3c sur le **choix du pas par l'angle balayé**, et
> le tableau « placer un corps ≠ tracer son orbite ».

## 1. Les sources, testées le 2026-09-21

Toutes sans clé, aucune sur le quota `api.nasa.gov`.

| Source | Couvre | Repère | Format | Verdict |
|---|---|---|---|---|
| **JPL Horizons** `VECTORS` | planètes, satellites naturels, Soleil, barycentres | ICRF **géométrique**, km, centre au choix | texte CSV entre `$$SOE`/`$$EOE` | **retenu** — c'est déjà `HorizonsClient` |
| **IMCCE Miriade** `ephemcc` | planètes et satellites | ICRF **astrométrique** (temps-lumière corrigé), ua | JSON propre | second avis + métadonnées |
| IMCCE Miriade `ephemsys` | **systèmes d'astéroïdes seulement** (base Genoide) | — | — | écarté ici (`-name=p:jupiter` → « Asteroidal system 'jupiter' not found ») |
| IMCCE ssoCard | petits corps seulement | — | — | écarté — **404** sur `Io` comme sur `Mars` |
| JPL SBDB | petits corps seulement | — | — | sans objet |
| `api.nasa.gov` | aucune éphéméride (APOD, EPIC, rovers…) | — | — | sans objet — et c'est le seul service sous quota |
| Séries analytiques client (VSOP87, Standish) | planètes seulement, **pas les lunes** | — | 0 requête | voir le précédent défavorable plus bas |

### Horizons : le client existant suffit, seul `COMMAND` change

`HorizonsClient::getVectors()` envoie `COMMAND='DES=2026 RB39;'`. Pour un corps majeur c'est
simplement `COMMAND='499'` (Mars), `'501'` (Io), `'599'` (Jupiter) — même requête, même parseur,
même repère (`REF_PLANE='FRAME'` = ICRF équatorial, exactement les axes de la scène). Vérifié sur
Mars et Io, géocentriques.

Deux choses apprises en testant, qui changent le dimensionnement :

- **`STEP_SIZE` sans unité = un nombre d'intervalles**, pas une durée. `STEP_SIZE='180'` entre deux
  dates donne exactement 181 échantillons. Une orbite complète de Neptune (165 ans) tient donc en
  **une seule requête** — testé avec `STEP_SIZE='6'` sur 2026 → 2191, héliocentrique (`CENTER='500@10'`).
  C'est ce qui rend la règle « une orbite se trace avec la fonction qui place le corps »
  (`docs/points-de-vue.md`) applicable aux planètes sans exploser le nombre d'appels.
- **Coût mesuré** : ~1,1 s et ~50 ko par requête (Mars, Jupiter, Saturne ; 1 an au pas d'un jour,
  366 échantillons). Après parsing en triplets d'entiers, ~10 ko de JSON par corps.

`OBJ_DATA=YES` donne aussi les constantes physiques (rayon moyen, aplatissement, GM, période de
rotation sidérale, obliquité, albédo géométrique, V(1,0), période orbitale) — mais en **texte libre**
non structuré. Ces valeurs sont des constantes : les coder en dur à côté de `MOON_RADIUS_KM` et
`SUN_RADIUS_KM` dans `web/src/scale.js` est plus honnête que d'écrire un parseur pour des nombres qui
ne bougent pas. Horizons reste la référence qu'on cite.

### Miriade : un vrai second avis, mais dans un autre repère

`ephemcc.php?-name=p:mars&-tcoor=2&-rplane=1&-observer=@500&-mime=json` renvoie du JSON direct :
position rectangulaire géocentrique équatoriale J2000 en ua, plus `Dobs`, `Dhelio`, `Phase`,
`Elong.`, `VMag` et le **diamètre** du corps. Théorie planétaire **INPOP19**, là où Horizons est sur
**DE441** — deux éphémérides réellement indépendantes, exactement le genre de comparaison que
`/api/neo` fait déjà entre JPL, NeoWs et l'ESA.

**Mais l'écart mesuré n'est pas un désaccord.** Mars au 2026-09-21 00:00 :

```
Horizons  -111 086 030 ; 213 172 337 ;  96 584 682  km
Miriade   -111 067 835 ; 213 166 188 ;  96 581 416  km
écart                                        19 482  km
```

19 482 km, soit ~3 diamètres de Mars. La distance est de 259 044 123 km → 864 s de temps-lumière ;
Mars se déplace d'environ 22,5 km/s par rapport à nous → 864 × 22,5 ≈ 19 400 km. **Miriade donne la
position astrométrique** (où on la *voit*, corrigée du temps-lumière), **Horizons `VECTORS` donne la
position géométrique** (où elle *est*).

Pour une scène 3D on veut la géométrique : Horizons. Miriade reste utile pour (a) contrôler qu'on
n'a pas de bug de repère, (b) les métadonnées JSON, (c) une éventuelle vue « ciel observé ». À
journaliser comme différence de convention, **pas** comme un écart de catalogue — sinon
`app:neo:comparison-report` raconterait n'importe quoi.

### Le précédent contre les séries analytiques

`web/src/astronomy.js` calcule le Soleil et la Lune sans réseau, et c'est très bien pour eux. Mais
`docs/agent/decisions.md` (2026-09-18) note que l'ellipse képlérienne de Standish **ratait le globe de
945 000 km**, d'où la règle actuelle : échantillonner l'orbite avec la fonction qui place le corps.
Une série tronquée VSOP87 poserait le même problème, ne couvrirait **aucune lune**, et ferait
cohabiter deux modèles pour un même type d'objet. À écarter, sauf pour un mode hors-ligne explicite.

## 2. Ce que l'architecture absorbe déjà, sans modification

Vérifié en rejouant les courbes de `web/src/scale.js` :

| | EARTH_CURVE (géocentré) | SUN_CURVE (héliocentré) |
|---|---|---|
| Vénus | 19,1 (au plus près) | 12,2 |
| Mars | 19,6 → 22,6 | 17,5 |
| Jupiter | 23,1 | 26,3 |
| Saturne | 24,2 | 30,6 |
| Neptune | 26,2 | 38,8 |

- `placeKm()` ne demande qu'un vecteur géocentrique en km : une planète s'y branche telle quelle.
- La courbe log **avale tout le système solaire sans être retouchée**. En géocentré les huit planètes
  tiennent entre 19 et 26,2 unités — lisibles, mais *toutes à peu près à la même distance* : c'est la
  limite honnête de la vue géocentrée, pas un bug.
- En héliocentré l'étalement est bien meilleur (7,9 pour Mercure → 38,8 pour Neptune) et reste **sous
  `STAR_SHELL_RADIUS = 80`** : la sphère d'étoiles n'a pas besoin d'être poussée.
- `controls.maxDistance = Math.max(20, farthest * 2.5)` s'adapte tout seul au corps le plus lointain.
- Le registre `FOCUSES` et `MIN_RADIUS_PX` sont déjà des tables par corps : ajouter une entrée est
  la modification prévue par le design.

## 3. Les trois vrais chantiers — et comment la donnée circule

### a. Les tailles, pas les distances

C'est le seul endroit où le modèle actuel casse. Au cran « lisible », le pivot vaut 2 unités et les
autres corps gardent leur proportion réelle relative :

| Corps | Rayon réel | Unités si la Terre vaut 2 |
|---|---|---|
| Mars | 3 390 km | 1,06 |
| Vénus | 6 052 km | 1,90 |
| Neptune | 24 622 km | 7,73 |
| **Jupiter** | **69 911 km** | **21,95** |
| Soleil | 696 340 km | 218,6 |

Jupiter à 21,95 unités de rayon serait **plus gros que la distance Soleil–Mars** (17,5). Le Soleil a
déjà sa réponse dans le code : `SUN_READABLE_RADIUS = 0.6`, un rayon lisible propre, rejoint par
`lerpLog` sur le rayon réel à t = 1. Il faut la même chose par planète — soit une table de rayons
lisibles, soit une compression log des rayons (les deux se valent ; une table se règle à l'œil).

### b. Une courbe par pivot — et elle se calibre toute seule

`makeCurve(proche, 12, lointain, 20, plancher)` généralise sans rien inventer. Calibrée sur les
galiléennes, la vue jovienne reproduit exactement la sensation Terre–Lune :

| | distance | unités |
|---|---|---|
| Io | 421 700 km | 12,0 |
| Europe | 671 100 km | 14,5 |
| Ganymède | 1 070 400 km | 17,0 |
| Callisto | 1 882 700 km | 20,0 |
| Himalia | 11 460 000 km | 29,7 |

Même recette pour Mars (Phobos → 12, Deimos → 20), Saturne (Mimas → Japet), etc. Chaque pivot
planétaire = une ligne dans `FOCUSES` : libellé, courbe, anneaux de repère, référence d'échelle.

À noter : `SUN_CURVE` a été calibrée pour des orbites de NEO (0,3–5 ua). Elle tient jusqu'à Neptune,
mais si le système solaire externe devient le sujet principal il faudra sans doute la recalibrer —
décision à prendre **après** avoir vu le résultat, pas avant.

### c. La cadence d'échantillonnage, par classe de corps

**Trois horloges à ne pas confondre** — la première version de ce document les avait tassées en une
seule ligne, ce qui a (légitimement) fait lire « position mise à jour tous les deux jours » :

1. **La table d'éphémérides** : ce qu'on demande à Horizons et qu'on met en cache. Une liste de
   positions déjà calculées (`t₀`, pas, triplets). Elle se retélécharge **rarement** — les positions
   de Mars pour 2027 sont connues aujourd'hui, elles ne périment pas.
2. **La lecture de cette table** : interpolation linéaire entre les deux échantillons encadrant
   « maintenant », dans le navigateur, sans réseau. Le code existe déjà — `updateNeoPositionKm()`,
   `web/src/main.js` — et tourne au rythme d'`updateAstronomy()`, soit **toutes les 60 s**. La
   position affichée est donc fraîche à la minute même si la table date d'une semaine.
3. **Le tracé d'orbite** : un dessin, pas une position. C'est là qu'intervient `STEP_SIZE='180'`,
   qui est un *nombre d'intervalles* et non une durée (voir §1).

#### Le pas est temporel, mais la règle qui le fixe est angulaire

Un `STEP_SIZE` est une durée (`'1h'`, `'1d'`). Mais ce qui décide si elle est assez fine, c'est
l'angle balayé pendant ce pas : remplacer un arc par un segment coûte la **flèche** de la corde,

```
e = R · (1 − cos(θ/2))  ≈  R · θ²/8
   R = rayon de courbure LOCAL de la trajectoire (pas la distance au corps !)
   θ = angle balayé pendant un pas
```

Vérifié le 2026-09-21 contre les mesures ci-dessous : Mars au pas d'un jour tourne de **0,85°/j**
autour d'un rayon de courbure de 193 884 778 km → flèche prédite 5 332 km, mesurée 5 645. Io au pas
d'une heure tourne de **8,48°/h** → prédite 1 159 km, mesurée 1 164 (0,4 % d'écart).

Deux conséquences : l'erreur est **quadratique** (pas divisé par 2 → erreur divisée par 4), et la
règle se formule une fois pour toutes : **viser θ ≈ 5–10° par pas**, soit
`pas = période × θ_cible/360°`. Pour Mars géocentrique, noter que R = 194 millions de km alors que
Mars est à 259 millions : la trajectoire apparente est dominée par le mouvement de *la Terre*.

Mesuré le 2026-09-21 en comparant l'interpolation d'une table grossière aux échantillons fins de
Horizons :

| Corps | Pas | Erreur max d'interpolation | En relatif |
|---|---|---|---|
| Mars, géocentrique | 1 jour | **5 645 km** | 0,002 % de 259 058 202 km — 0,83 diamètre de Mars |
| Io, autour de Jupiter (période 1,77 j) | 1 jour | **509 065 km** | **120 % du rayon orbital** — la lune passe de l'autre côté de la planète |
| Io, autour de Jupiter | 1 heure | 1 164 km | 0,275 % du rayon orbital (423 525 km) |

D'où :

| Classe | Pas | Fenêtre | Requêtes |
|---|---|---|---|
| Planètes (position) | 1 jour (≈ 1/365 de période) | ~1 an, soit 366 points ≈ 10 ko | 1 par planète, rafraîchie au mois |
| Planètes (orbite tracée) | `STEP_SIZE='180'` sur une période sidérale | 181 points | 1 par planète, héliocentrique |
| Lunes (Io 1,77 j, Phobos 7,65 h) | 1 h à 10 min (≈ 1/45 de période) | quelques jours — Phobos à 10 min sur 7 j = 1 008 points | 1 par lune, à la demande |

Réserve assumée sur les planètes : 5 645 km, c'est invisible au cran lisible mais ~1 diamètre de
Mars si l'on se pose à côté d'elle au cran « 100 % réel ». Le jour où ça gêne, la planète *centrée*
passe au pas horaire — même logique que les lunes chargées à la demande (lot 4).

#### Placer un corps et tracer son orbite sont deux requêtes sans rapport

À ne pas confondre : la période complète ne sert **jamais** à positionner la planète.

| | Placer Jupiter | Tracer son orbite |
|---|---|---|
| Question | où est-elle *maintenant* ? | à quoi ressemble le *chemin* ? |
| Fenêtre | quelques jours autour d'aujourd'hui | une période sidérale (11,86 ans) |
| Pas | 1 jour | période/180 ≈ 24 jours, soit 2° d'arc |
| Points | ~10 | 181 |
| Centre | géocentrique | héliocentrique |
| Usage | ré-interpolé toutes les 60 s | figé, c'est du décor |
| Obligatoire | oui | non — confort visuel |

Un tracé tolère un pas grossier, un corps placé non : à 2° d'arc la flèche vaut ~118 000 km sur
l'orbite de Jupiter, soit 0,015 % du rayon orbital — 0,004 unité de scène. Le cycle *complet* n'est
là que pour que le trait forme une boucle : un échantillonnage partiel donnerait un arc.

`180` n'est d'ailleurs ni magique ni imposé par Horizons — c'est déjà `EARTH_ORBIT_SAMPLES` dans
`main.js`. `STEP_SIZE='180'` permet seulement de le demander en une requête au lieu de 181.

Deux conséquences du cycle complet : pour Neptune il faut des positions **jusqu'en 2191** (testé,
Horizons répond — les noyaux DE441 couvrent des millénaires), et l'orbite **ne se referme pas
exactement** sur elle-même, l'orbite ayant précessé entre le point 0 et le point 180. C'est juste,
pas un bug, et la règle du projet tient : l'échantillon 0 *est* la planète.

### d. Qui calcule quoi

Horizons ne fait pas de mécanique képlérienne : JPL intègre numériquement le système solaire et
publie des noyaux, que Horizons se contente d'évaluer aux dates demandées. Il le dit dans sa
réponse — `Target body name: Mars (499) {source: mar099}`, `Center body name: Earth (399)
{source: DE441}`. La chaîne complète :

```
intégration numérique JPL (DE441 planètes, mar099 / jup365 satellites)
  └─ Horizons évalue aux dates demandées          ~1,1 s par requête
       └─ backend : parse $$SOE/$$EOE + cache long   rien ne bouge pendant des jours
            └─ navigateur : interpole à « maintenant »   toutes les 60 s, hors ligne
```

Le Soleil et la Lune resteraient **en dehors** de cette chaîne : `web/src/astronomy.js` les calcule
par séries analytiques dans le navigateur, sans requête. Les deux régimes cohabitent sans heurt —
l'erreur de la Lune analytique (~0,3°, soit ~2 000 km) est du même ordre que l'interpolation d'Io au
pas horaire. Il n'existe en revanche pas de série simple équivalente pour Io ou Titan, d'où les
tables.

## 4. Découpage proposé

Le lot 1 se suffit à lui-même et se voit tout de suite ; les suivants sont facultatifs.

1. **Les huit planètes comme corps** — nouveau `/api/solar-system/positions` (jeu de corps fixe,
   tables géocentriques, cache long), points/sphères de couleur unie, libellés, visibles en vue
   géocentrée et héliocentrée. Rayons lisibles par corps (chantier *a*). Aucune lune, aucune texture.
2. **Les orbites planétaires** — une requête Horizons par planète (chantier *c*, ligne 2), tracées en
   vue héliocentrée, dans la continuité directe de l'orbite terrestre déjà dessinée.
3. **Les planètes comme pivots** — une entrée `FOCUSES` par planète avec sa courbe (chantier *b*),
   plus l'éclairage : la direction du Soleil devient `sunPos − planetPos` et non plus `sunDirWorld`.
4. **Les lunes du pivot courant seulement** — chargées quand on centre sur la planète, pas avant.
   C'est ce qui garde le coût raisonnable : 4 lunes de Jupiter à la demande, pas 20 lunes au
   démarrage.
5. **Habillage** (facultatif) — textures, anneaux de Saturne, inclinaison et rotation propre.

## 4 bis. Lot 4 — plan d'exécution arrêté le 2026-09-29

Les lots 1, 2 et 3 sont livrés. Ce qui suit remplace la ligne 4 du découpage ci-dessus, qui
sous-estimait le sujet (« 4 lunes de Jupiter à la demande »).

### Le périmètre, tranché par l'utilisateur

**Au plus 9 lunes par planète : toutes si elle en a 9 ou moins, sinon les 9 plus grosses.**
Identifiants vérifiés un par un contre `horizons_lookup.api` le 2026-09-29, les 38 répondent.

| planète | lunes | ids Horizons |
|---|---|---|
| Mercure | aucune | — |
| Vénus | aucune | — |
| Terre | la Lune | **aucun appel** — `astronomy.js` la calcule déjà localement |
| Mars | les 2 | Phobos 401, Deimos 402 |
| Jupiter | 9 sur ~95 | Ganymède 503, Callisto 504, Io 501, Europe 502, Himalia 506, Amalthée 505, Thébé 514, Elara 507, Pasiphaé 508 |
| Saturne | 9 sur ~274 | Titan 606, Rhéa 605, Japet 608, Dioné 604, Téthys 603, Encelade 602, Mimas 601, Hypérion 607, Phœbé 609 |
| Uranus | 9 sur ~28 | Titania 703, Obéron 704, Umbriel 702, Ariel 701, Miranda 705, Puck 715, Sycorax 717, Portia 712, Juliette 711 |
| Neptune | 9 sur ~16 | Triton 801, Protée 808, Néréide 802, Larissa 807, Galatée 806, Despina 805, Thalassa 804, Naïade 803, Halimède 809 |

38 corps via Horizons. Réserve assumée : au-delà des 4 ou 5 premières de chaque géante, ce sont des
cailloux de 30 à 100 km à des millions de km (Pasiphaé, Sycorax, Halimède) qui resteront des points
au plancher de pixels. Plusieurs sont des **irrégulières rétrogrades** très inclinées — leurs orbites
de travers sont une information juste, pas un artefact.

### L'obstacle à lever en premier : la courbe ne sait pas représenter une lune

Mesuré le 2026-09-29 sur les courbes du lot 3 : **les 38 lunes tombent sur le plancher (3,2 unités)**,
collées à leur planète. Les valeurs brutes de `a + b·log10(d)` vont de **−28 à −57** — le système de
lunes est 3 à 5 ordres de grandeur sous la plage d'une courbe calée sur l'orbite héliocentrique.

| lune | distance | brut | dessinée à |
|---|---|---|---|
| Phobos / Mars | 9 376 km | −57,2 | 3,20 (plancher) |
| Io / Jupiter | 421 700 km | −38,9 | 3,20 (plancher) |
| Titan / Saturne | 1 221 870 km | −35,7 | 3,20 (plancher) |
| Néréide / Neptune | 5 513 800 km | −33,1 | 3,20 (plancher) |

La solution est déjà dans le code : `EARTH_CURVE` est calée sur **deux** échelles (Lune → 12 unités,
0,5 ua → 20), donc elle enjambe le système lunaire *et* l'interplanétaire. Il faut généraliser.

Vérifié numériquement : une courbe calée **(lune principale → 12 ; Soleil → 21,05)** redonne
`EARTH_CURVE` exactement — même pente, 3,494. Donc la courbe actuelle de la Terre devient le cas
particulier de la règle générale, exactement comme `SUN_CURVE` est devenue `orbitingCurve(1 ua)`.
Mercure et Vénus, sans lune, gardent `orbitingCurve`.

À revérifier une fois la courbe changée, puisqu'elle bouge sous eux : les anneaux mis à l'échelle
(9,63 / 19,49 / 26,00 aujourd'hui) et l'anneau absolu à 1 ua.

### Le budget de points : un quota « on tient X jours »

Une lune va vite : au pas d'un jour, Io se retrouve **de l'autre côté de Jupiter** (erreur
d'interpolation 509 065 km, 120 % du rayon orbital). Il faut ~1/45 de période. Mais le coût Horizons
est **par requête, pas par point** — donc le pas fin est gratuit en latence, et c'est le volume qui
paie.

D'où la règle : **budget fixe de points par lune, fenêtre déduite**. Propriété clé, le poids devient
constant — **~64 ko par lune à 500 points, quelle que soit la lune**. Seule la validité varie :

| lune | pas | validité | refetch/an |
|---|---|---|---|
| Phobos | 10 min | 3,5 j | 103 |
| Io | 57 min | 19,7 j | 19 |
| Ganymède | 3,8 h | 79,5 j | 5 |
| Callisto | 8,9 h | 185 j | 2 |
| Titan | 8,5 h | 177 j | 2 |
| | | **total** | **171/an, soit 0,5 requête/jour** |

Même rythme que les 7 planètes aujourd'hui (14 requêtes/mois). Les lunes n'alourdissent pas, elles
égalent. Volumes : 2,4 Mo de cache serveur pour les 38 (contre `backend/var` déjà à 6,2 Mo), et côté
client seules les lunes des pivots réellement visités sont stockées — 0,56 Mo pour Jupiter + Saturne
au complet, très en dessous des ~5 Mo de `localStorage`.

### Pourquoi le calcul reste côté client

Question posée par l'utilisateur (« alléger les clients qui tourneront peut-être sur du
grille-pain »). Mesuré : interpolation + placement de **79 corps** (7 planètes, 38 lunes, 30 NEO,
Terre/Lune/Soleil/ISS) coûte **0,0042 ms par frame**, soit **0,03 %** du budget d'une frame à 60 fps
— 0,5 % sur une machine 20 fois plus lente. Ce n'est pas le calcul qui coûte, c'est le GPU (textures
2048² du globe, shaders, 1 600 étoiles).

Déporter l'interpolation ne gagnerait rien de mesurable et coûterait beaucoup : Phobos boucle en
7 h 39, sa position change à la minute — il faudrait redemander en permanence, ce qui casse le
cache-first et le hors-ligne.

Les vrais gains backend, eux, sont retenus : **une requête par planète au lieu de neuf**, positions
**déjà relatives à la planète** (`CENTER='500@599'`, aucune soustraction côté client), et tout le
travail lourd dans la commande console — où `max_execution_time` vaut **0** (vérifié) contre 30 s en
web, donc le mur des 30 s ne s'applique pas. Le quatrième gain classique, arrondir les nombres, est
**déjà fait** : le backend renvoie des entiers en km.

### Les cinq étapes

0. **La courbe** (bloquant). `moonSystemCurve(luneKm, helioKm)` dans `scale.js`, `EARTH_CURVE` en
   cas particulier. Vérification numérique sur les 5 planètes à lunes avant d'écrire quoi que ce soit
   d'autre : les lunes doivent s'étaler lisiblement, le Soleil rester où il est, les anneaux garder
   un sens.
1. **Backend.** Catalogue des lunes (id Horizons, planète, nom, rayon), route
   `/api/solar-system/moons?planet=jupiter` servant depuis le cache et ne complétant **qu'un** corps
   manquant par appel — sûr à froid (jamais plus d'une requête Horizons dans les 30 s), un seul appel
   à chaud. Fenêtre déduite du budget de points. `backend/API.md` à jour.
2. **Commande console** `app:solar-system:warm` : renouvelle ce qui est **déjà en cache et proche de
   l'expiration**, pas le catalogue entier. Peuplement paresseux par les visites, rafraîchissement
   anticipé par le cron — personne n'attend Horizons sauf le tout premier visiteur d'une lune donnée.
3. **Client.** Chargement à la demande au changement de pivot, affichage progressif, cache
   `localStorage` par planète.
4. **Scène.** Meshes, éclairage (elles héritent du `uSunDir` par corps écrit au lot 3), libellés, et
   les lunes entrent dans la portée de la caméra.
5. **Docs** et checklist de validation visuelle.

## 4 ter. Lot 5 — recherche préalable, menée le 2026-09-29

Le § 5 posait la question 2 (« sphères de couleur unie ou textures ? Si textures, il faut une
source — Solar System Scope, NASA SVS, USGS Astrogeology, **aucune testée** »). Elles sont testées.

### Les textures : Solar System Scope, CC BY 4.0, vérifié

Licence citée mot pour mot sur la page : *« Distributed under Attribution 4.0 International license:
You may use, adapt, and share these textures for any purpose, even commercially. »* Attribution
obligatoire — le projet a déjà un emplacement pour ça (`NEO_CREDITS`, classe CSS `.credits`).

URLs sondées une par une le 2026-09-29, toutes valides. Format vérifié : **équirectangulaire
2048 × 1024**.

| fichier | poids |
|---|---|
| `2k_mercury.jpg` | 873 ko |
| `2k_venus_surface.jpg` | 885 ko |
| `2k_mars.jpg` | 751 ko |
| `2k_jupiter.jpg` | 499 ko |
| `2k_saturn.jpg` | 200 ko |
| `2k_uranus.jpg` | 78 ko |
| `2k_neptune.jpg` | 242 ko |
| `2k_saturn_ring_alpha.png` | 12 ko |
| `2k_earth_daymap.jpg` | 463 ko |
| `2k_earth_nightmap.jpg` | 255 ko |
| `2k_earth_normal_map.tif` | 521 ko |
| `2k_earth_specular_map.tif` | 339 ko |
| `2k_earth_clouds.jpg` | 966 ko |
| `2k_moon.jpg` | 1 054 ko |

**L'anneau de Saturne est résolu** : `2k_saturn_ring_alpha.png` est un **PNG RGBA 8 bits,
2048 × 125**, en-tête vérifié. L'alpha est intégré, pas de second fichier à gérer — c'est une bande
échantillonnée radialement, exactement ce qu'un anneau demande.

**Deux fichiers sont en TIFF** (normal map et specular map de la Terre) et devront être convertis.
Une extension fausse répond **404 avec un corps HTML** : un téléchargement qui ne regarde pas le code
de statut écrit du HTML dans un `.jpg` sans rien dire. (C'est l'erreur que j'ai faite en sondant, et
elle a produit des tailles fausses avant correction.)

### Bénéfice inattendu : ça règle un problème existant

Les textures Terre et Lune actuellement embarquées viennent des **exemples three.js**
(`bodies.js` le dit). Or beaucoup d'assets du dépôt three.js **n'ont pas de licence propre** — c'est
un sujet ouvert et suivi chez eux. Solar System Scope sert exactement le même jeu (day, night,
normal, specular, clouds, Moon) sous une licence explicite. Basculer ne fait donc pas qu'ajouter les
planètes : ça met aussi ce qui existe déjà sur une base saine.

### Le trou : les lunes

Solar System Scope ne couvre **aucune lune** hors la nôtre. Pas d'Io, Europe, Ganymède, Callisto,
Titan, Triton, Phobos, Déimos.

USGS Astrogeology a des mosaïques globales pour Io, Europe, Ganymède, Callisto et Titan (domaine
public, produits Voyager/Galileo/Cassini). Mais ce sont des **produits scientifiques** : GeoTIFF ou
JPEG2000, souvent multi-gigaoctets, en projection cylindrique simple. Les utiliser demande une
conversion (GDAL ou équivalent), donc une étape de build et une chaîne d'attribution à tenir.

Recommandation : **pas de textures de lunes au lot 5.** Sur 38 lunes, 4 ou 5 seulement sont assez
grosses pour montrer du relief quand on est centré sur leur planète, et elles restent des sphères
grises éclairées — ce qui est honnête. À rouvrir séparément si le besoin se confirme.

### Le budget, et ce qu'il impose

| | poids |
|---|---|
| système Terre (day, night, normal, specular, Lune) | 2,51 Mo |
| 7 planètes + anneau de Saturne | 3,37 Mo |
| nuages de la Terre (entrée séparée du backlog) | 0,92 Mo |
| **total jeu complet 2K** | **6,81 Mo** |
| embarqué aujourd'hui | 2,00 Mo |

Trop lourd pour tout précharger, surtout que `web/index.html` précharge déjà les textures de la Terre
pour passer devant les appels `/api/*` sur le serveur mono-requête du mode « poste isolé ».

D'où la même stratégie qu'au lot 4 : **le système Terre reste préchargé** (c'est la vue par défaut),
**les planètes se chargent à la demande** quand on centre sur elles ou quand elles deviennent assez
grosses à l'écran. Le lot 4 a déjà tout le mécanisme.

### L'orientation : aucune table IAU à coder en dur

C'était la question ouverte — et la réponse est meilleure que prévu. Horizons sert tout en CSV, dans
la forme de requête que le projet utilise déjà.

`QUANTITIES='14,32'` en `EPHEM_TYPE=OBSERVER` rend, en un seul appel :

```
Date__(UT)__HR:MN, , , ObsSub-LON, ObsSub-LAT,  N.Pole-RA, N.Pole-DC,
 2026-Sep-29 00:00, , ,  55.527147,   0.148527,  268.05765,  64.49667,
 2026-Sep-29 01:00, , ,  91.794294,   0.148088,  268.05765,  64.49667,
```

- **`N.Pole-RA` / `N.Pole-DC` est la direction du pôle en ICRF** — c'est-à-dire *directement dans les
  axes de la scène*, aucune conversion. Vérifié contre l'IAU : Jupiter 268,058° / 64,497°, Mars
  317,652° / 52,870°. Orienter une planète, c'est pointer son +Y là.
- **`ObsSub-LON` donne la phase de rotation** : la longitude qui fait face à la Terre à cet instant.
  Deux lignes suffisent à en tirer le taux par différence finie (Jupiter : 36,27°/h, soit 9,92 h —
  ses 9 h 55 ; Mars : 14,597°/h, soit 24,66 h).
- Le pôle est constant à l'échelle du mois (valeurs identiques à 5 décimales sur deux jours). Donc
  **une requête sans clé par planète et par mois**, et la rotation se propage localement — exactement
  ce que la Terre fait déjà avec le temps sidéral de Greenwich.

À noter pour ne pas s'y perdre : le bloc `OBJ_DATA=YES` donne la période de rotation et
l'« obliquity to orbit », mais **pas** le pôle en ICRF. L'obliquité à l'orbite ne suffit pas à
orienter un corps (il manque la direction du nœud). C'est la quantité 32 qu'il faut, pas le texte
libre — ce qui écarte au passage le coût de parseur signalé au § 1.

### Décisions prises avec l'utilisateur le 2026-09-29

1. **Les lunes restent des sphères grises éclairées.** Pas de chantier USGS. Les 38 lunes gardent
   `MOON_COLOR` et `makeLitBodyMaterial`, ce qui est honnête : seules 4 ou 5 sont assez grosses pour
   montrer du relief, et aucune source web-ready ne les couvre.
2. **Résolution : 2K partout**, parce que le détail ne sert qu'au moment où l'on centre sur un corps
   — c'est-à-dire exactement là où il est visible. Mais Mercure, Vénus et Mars sont anormalement
   lourdes pour du 2048 × 1024 (873, 885 et 751 ko, les trois quarts du lot planètes) : à
   **ré-encoder en JPEG qualité ~80**, ce qui divise typiquement par deux sans perte visible. La
   résolution ne bouge pas, seul le taux de compression.
3. **Le Soleil est texturé** (`2k_sun.jpg`, 822 ko). Il remplace la sphère unie du marqueur.

### Plan d'exécution du lot 5

**Étape 0 — outillage (à vérifier en premier, ça conditionne l'étape 1).** Y a-t-il de quoi
convertir un TIFF et ré-encoder un JPEG sur cette machine ? Les deux cartes de la Terre (normal,
specular) ne sont servies qu'en `.tif`, et l'étape 1 veut ré-encoder trois JPEG. Si rien n'est
disponible : embarquer les JPEG tels quels, et garder les normal/specular actuelles (exemples
three.js) en notant que la question de licence reste ouverte pour ces deux fichiers-là seulement.

**Étape 1 — les fichiers.** Télécharger les 14 textures dans `web/public/textures/`. **Vérifier le
code HTTP de chaque téléchargement** : une extension fausse répond 404 avec un corps HTML, qui
s'écrit silencieusement dans le `.jpg`. Convertir les deux TIFF, ré-encoder les trois lourdes.
Ajouter le crédit CC BY 4.0 dans l'UI (il y a déjà `NEO_CREDITS` et la classe `.credits`).

**Étape 2 — les planètes texturées.** `makeLitBodyMaterial` prend une texture optionnelle : le
fragment multiplie `uColor` par `texture2D(uMap, vUv)`. Le vertex shader doit sortir `vUv`, que
`SphereGeometry` fournit déjà. Chargement **à la demande** au changement de pivot, comme les lunes du
lot 4 — le mécanisme existe, `moons.js` en est le modèle. Le système Terre reste préchargé.

**Étape 3 — l'anneau de Saturne.** `RingGeometry` avec des UV refaits : par défaut three.js mappe un
anneau en coordonnées polaires, il faut remapper pour que `u` suive le **rayon** et échantillonne la
bande de 2048 × 125. Matériau `transparent: true`, `side: DoubleSide`, `depthWrite: false`.
L'anneau se couche dans le plan équatorial de Saturne, donc il dépend de l'étape 4.

**Étape 4 — l'orientation (pôle + rotation propre).** Nouvelle route backend, une requête sans clé
par planète et par mois, `EPHEM_TYPE=OBSERVER` et `QUANTITIES='14,32'`, **deux lignes à une heure
d'écart** :
- `N.Pole-RA` / `N.Pole-DC` → direction du pôle, déjà en ICRF donc directement dans les axes de la
  scène. Orienter = pointer le +Y du mesh là (`Object3D.lookAt` sur l'axe, ou un quaternion depuis
  `(0,1,0)` vers le vecteur du pôle) ;
- `ObsSub-LON` sur les deux lignes → le taux de rotation par différence finie, et la phase à
  l'époque. Propager ensuite localement, comme `globe.rotation.y` le fait déjà avec le temps sidéral
  de Greenwich.

Attention au sens : `ObsSub-LON` est la longitude **face à la Terre**, pas une phase absolue. La
poser correctement demande de composer avec la direction Terre → planète du moment.

**Étape 5 — la Lune enfin orientée.** Défaut repéré le 2026-09-29 : aucune rotation ne lui est
appliquée alors qu'elle est en rotation synchrone, donc sa face visible pointe une direction fixe de
l'espace et la face cachée tourne vers nous au fil du mois. Même mécanisme que l'étape 4. La Terre,
elle, est déjà correcte sur les deux plans (rotation GMST, et son axe *est* +Y puisque la scène est
équatoriale) — ne pas y toucher.

**Étape 6 — docs et checklist de validation visuelle.**

### Pièges connus avant de commencer

- **Le `#include <colorspace_fragment>`** est obligatoire dans tout fragment shader écrit à la main,
  sinon les couleurs sont sur-saturées (`gotchas.md`). Les textures rendront ça très visible.
- **`texture.colorSpace = THREE.SRGBColorSpace`** sur les cartes de couleur, pas sur les normal/
  specular maps. `bodies.js` le fait déjà pour la Terre, suivre le même motif.
- **Ne pas précharger les 6,81 Mo.** `web/index.html` précharge déjà les textures de la Terre pour
  passer devant les appels `/api/*` du serveur mono-requête ; y ajouter les planètes annulerait le
  bénéfice.
- **Après un déplacement de bloc entre fichiers, lire le log client de Vite, pas le succès du
  build** : rolldown ne résout pas les identifiants inter-modules à la compilation (vécu deux fois
  le 2026-09-29).

### Le piège à ne pas manquer : le cache froid

`docs/agent/gotchas.md` note que sur cette machine Symfony retombe sur `NativeHttpClient`, qui
parallélise mal. À ~1,1 s par requête, remplir un cache vide pour 8 planètes + leurs orbites =
**~18 s de latence sur la première visite**, et bien plus si les lunes sont préchargées. D'où le lot 4
à la demande, et sans doute une commande de préchauffage (`app:solar-system:warm`, dans l'esprit de
l'entrée « pré-chauffage de cache » du backlog) plutôt qu'un remplissage déclenché par le premier
visiteur.

## 5. À trancher avec l'utilisateur

1. **Le périmètre des lunes** : seulement les grosses (Lune, Phobos/Deimos, 4 galiléennes, Titan,
   Triton ≈ 9 corps), ou tout le système de la planète centrée ? Pluton dans le lot 1 ou pas ?
2. ~~**L'aspect** : sphères de couleur unie ou textures ? Source à trouver.~~ **Recherche faite le
   2026-09-29, voir § 4 ter.** Solar System Scope retenu (CC BY 4.0, URLs et formats vérifiés un par
   un) ; il ne couvre aucune lune, d'où la recommandation de les laisser en sphères grises.
3. **Miriade en second avis** : on branche la comparaison INPOP19 / DE441 comme pour les NEO, ou on
   se contente de Horizons pour l'instant ?
4. **La vue géocentrée** : accepte-t-on que les huit planètes s'y tassent entre 19 et 26 unités, ou
   les planètes n'apparaissent-elles qu'en vue héliocentrée et planétaire ?

## Annexe — requêtes de référence

```
# Planète, géocentrique, 1 an au pas d'un jour
https://ssd.jpl.nasa.gov/api/horizons.api?format=json&COMMAND='499'&OBJ_DATA=NO&MAKE_EPHEM=YES
  &EPHEM_TYPE=VECTORS&CENTER='500@399'&START_TIME='2026-09-21'&STOP_TIME='2027-09-21'
  &STEP_SIZE='1d'&VEC_TABLE='1'&REF_PLANE='FRAME'&OUT_UNITS='KM-S'&CSV_FORMAT='YES'

# Orbite complète en une requête : héliocentrique, N intervalles sur une période sidérale
  ...&CENTER='500@10'&START_TIME='2026-09-21'&STOP_TIME='2191-09-21'&STEP_SIZE='180'...

# Satellite : COMMAND='501' (Io). Autour de sa planète : CENTER='500@599'
# Identifiants : https://ssd.jpl.nasa.gov/api/horizons_lookup.api?sstr=phobos&format=json → spkid 401

# Second avis IMCCE (astrométrique, ua)
https://ssp.imcce.fr/webservices/miriade/api/ephemcc.php?-name=p:mars&-ep=2026-09-21T00:00:00
  &-nbd=2&-step=1d&-observer=@500&-tcoor=2&-rplane=1&-mime=json
```
