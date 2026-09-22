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
2. **L'aspect** : sphères de couleur unie comme les NEO (cohérent avec « MVP web = sphères simples »
   du README), ou textures ? Si textures, il faut une source — Solar System Scope (CC BY 4.0),
   NASA SVS, USGS Astrogeology sont les pistes habituelles, **non vérifiées** à ce stade.
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
