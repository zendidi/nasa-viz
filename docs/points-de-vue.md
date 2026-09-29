# Points de vue (centrage) et trajectoires héliocentriques

Suite de `docs/echelle-reelle.md`. Décidé avec l'utilisateur le 2026-09-18, et **supersède** la
décision du 2026-09-17 « pas d'ellipse héliocentrique 3D dans la scène » (`docs/agent/decisions.md`) :
l'ellipse devient possible parce que la scène peut désormais être centrée sur le Soleil, au lieu de
tenter de la lire depuis la Terre.

## Choix validés

| Sujet | Choix |
|---|---|
| Centrage | La scène a un **corps pivot** (« point de vue »). Livrés : **Terre** et **Soleil**. Le registre (`web/src/focus.js`) est prévu pour la Lune et les planètes ensuite |
| Échelle | **Le même slider 9 crans**, mais sa courbe « lisible » dépend du pivot (voir plus bas) |
| Trajectoire complète | **Seulement en vue héliocentrée** : orbite képlérienne entière. En vue géocentrée, on garde le segment Horizons de la semaine |
| Objets tracés | **Le NEO sélectionné** uniquement |
| Style du trait | Trait plein au-dessus de l'écliptique, **pointillé en dessous** (même convention que le schéma SVG de la modal) ; **orbite de la Terre en référence** + repères périhélie / aphélie / nœuds |
| Arc d'approche | ±30 jours autour du passage au plus près, dans la couleur du NEO (rouge PHA / taxonomie), l'ellipse complète restant en cyan neutre |
| UI | Deuxième panneau à droite du panneau d'échelle : choix du point de vue + bouton **Recentrer** (aussi touche `R`). Le libellé d'échelle rappelle le centrage courant (« géocentré » / « héliocentré ») |

## Modèle

Le pivot est **l'origine de la scène**. Chaque corps est connu par sa position **géocentrique en km**
(repère ICRF, axes scène) :

| Corps | Source |
|---|---|
| Terre | (0, 0, 0) par définition |
| Lune | `getMoonEquatorial()` (direction + distance) |
| Soleil | `getSunEquatorial()` — direction **et distance** (ajoutée pour ce chantier) |
| NEO | table horaire JPL Horizons, déjà géocentrique (`/api/neo/positions`) |
| ISS | lat/lng/altitude, dans le repère du globe |

Placement d'un corps B avec le pivot F : `rel = pos(B) − pos(F)`, puis la compression radiale
habituelle `sceneDistance(|rel|, t, courbe(F))` appliquée le long de `rel`. Tout le reste
(tailles minimales en pixels, transition animée de `t`, remap de la distance caméra) est inchangé.

### Courbes « lisible » par pivot

`readable(d) = a + b·log10(d_km)`, calée sur deux points, puis interpolée en log vers le réel :

| Pivot | Calage | Conséquence |
|---|---|---|
| Terre | Lune → 12 · 0,5 ua → 20 | inchangé (`EARTH_CURVE`, celle de `docs/echelle-reelle.md`) |
| Soleil | 0,3 ua → 6 · 5 ua → 26 | 1 ua → 14,5 ; une orbite 0,9–2,5 ua occupe 13,8 → 20 : l'ellipse reste une ellipse |
| Une planète | 0,3 a → 6 · 5 a → 26 | même forme, calée sur son **propre** demi-grand axe `a` |

La ligne « planète » est `orbitingCurve(a)` dans `scale.js`, et la ligne « Soleil » en est le cas
particulier `a = 1 ua`. Comme les deux calages sont des **multiples** de `a`, la pente est la même
pour tous les pivots (`b = 20 / log10(5/0,3) = 16,37`) et le repère lui-même tombe **toujours à
14,56 unités**. C'est la raison d'être de cette forme : quel que soit le pivot, le corps qui définit
la vue est au même endroit à l'écran, donc l'image reste comparable d'un pivot à l'autre.

Mesuré depuis Neptune (`a = 30,06 ua`) au cran lisible : le Soleil à 14,56, la Terre à 14,66,
Jupiter à 13,53. Ils se télescopent — et c'est juste : vus de 30 ua, ils sont réellement dans la
même direction à peu près à la même distance.

Conséquence assumée : à t < 1, une ellipse passée dans une compression **radiale** est déformée
(la compression n'est pas conforme), mais elle reste cohérente — le trait passe toujours sur le
point du NEO et sur le Soleil. À « 100 % réel » elle est exacte.

### Taille du corps pivot

Le corps centré est l'ancre visuelle : rayon 2 unités au cran « lisible ». Les autres gardent leurs
proportions réelles relatives, d'où un facteur d'échelle appliqué au sous-système Terre–Lune–ISS
quand le pivot n'est pas la Terre (`earthSystemScale`) : la Terre passe de 2 à 0,35 unité au cran
lisible, la Lune et l'ISS suivent, et tout revient au réel à t = 1.

### Anneaux de repère

Ils suivent le pivot : 10 et 100 distances lunaires autour de la Terre, cercles 0,5 / 2 / 5 ua autour
du Soleil, et autour d'une planète **les mêmes multiples appliqués à son orbite** (0,5 a / 2 a / 5 a,
libellés en ua arrondis à deux chiffres significatifs) — donc les anneaux tombent au même endroit à
l'écran quel que soit le pivot, exactement comme la courbe : 9,63 / 19,49 / 26,00 unités pour les
sept planètes.

Garder les 0,5 / 2 / 5 ua fixes du Soleil autour d'une planète ne marcherait pas : autour de Neptune
les trois tombent sur le plancher de la courbe (3,2) — **le même cercle tous les trois**, collé au
pivot qui fait 2 unités de rayon.

#### L'anneau absolu à 1 ua

Corollaire assumé du paragraphe ci-dessus : une image identique d'un pivot à l'autre ne peut pas,
par construction, faire sentir que le système de Neptune vaut 78 fois celui de Mercure. D'où un
**quatrième anneau, à distance absolue de 1 ua**, en ambre au lieu du bleu pour qu'il ne se lise pas
comme un membre de la même famille (décidé avec l'utilisateur le 2026-09-29).

Il se resserre sur la planète à mesure qu'on s'éloigne. Au cran 1 (les anneaux sont masqués au
cran 0) : 56 unités autour de Mercure, 45 autour de Vénus, 33 autour de Mars, **11 autour des quatre
géantes** — pour un rayon de pivot de 1,8 à 2,7.

Limite connue : à partir de Jupiter il sature. Ce n'est pas le plancher qui est grossier —
`6 + 16,37·log10(d / 0,3a)` vaut déjà un nombre **négatif** à 1 ua pour Saturne et au-delà : la
courbe n'a plus de place pour le représenter, aucun réglage de plancher n'y changerait rien.

À « 100 % réel » il n'est plus comprimé du tout et vaut 46 962 unités pour **tous** les pivots —
c'est là qu'il joue pleinement son rôle d'étalon fixe.

L'écart est par ailleurs déjà chiffré dans le libellé d'échelle, et exactement : au même cran il
affiche « Soleil ÷1 249 » autour de Mercure et « Soleil ÷96 958 » autour de Neptune. Le rapport des
facteurs (×77,6) est rigoureusement celui des demi-grands axes, puisque le repère tombe toujours à
14,56 unités. Toujours masqués au cran « lisible », où les distances ne sont pas proportionnelles.

Ni cercle à 1 LD, ni cercle à 1 ua : à ces deux rayons c'est la **vraie orbite** du corps qui est
tracée (voir ci-dessous), et elle joue le rôle de repère bien mieux qu'un cercle fixe.

## Une orbite se trace depuis la source qui place le corps

Règle posée le 2026-09-18 : **un trait d'orbite doit passer par son astre**. Un cercle de référence
n'y suffit pas — l'ancien anneau « orbite lunaire » à 384 400 km dans le plan de l'écliptique ratait
la Lune d'une unité de scène entière (elle oscille de 5 % entre périgée et apogée, et son orbite est
inclinée de ~5° sur l'écliptique).

D'où le principe : la courbe est **échantillonnée avec la fonction même qui positionne le corps**,
en partant de l'instant présent, si bien que l'échantillon 0 *est* le corps.

| Corps | Trait tracé | Échantillons |
|---|---|---|
| Lune (vue géocentrée) | orbite réelle sur un mois sidéral | 96 points de `getMoonEquatorial()` |
| Terre (vue héliocentrée) | orbite réelle sur un an | 180 points de `getSunEquatorial()`, niés |

Les deux sont re-échantillonnés toutes les minutes avec `updateAstronomy()`, pour que le premier
point reste la position courante. Écart maximal entre la corde tracée et le trajet réel : 0,007
unité au cran lisible, 0,07 au cran réel — sous le rayon de la Lune (0,545).

**Le NEO reste l'exception assumée** : son point vient de Horizons et son ellipse des éléments SBDB
propagés en deux corps. Mesuré le 2026-09-18 sur 2026 RB39, l'objet est à 239 000 km de la *courbe*
(75 unités au cran 100 % réel, 0,02 au cran lisible) — le reste de l'écart (~960 000 km) est **le
long** de l'ellipse, c'est-à-dire un décalage de phase, pas un trait qui rate l'objet. Pour le
supprimer il faudrait demander à Horizons ses éléments osculateurs (`EPHEM_TYPE=ELEMENTS`,
`CENTER='500@10'`) au lieu de ceux de SBDB — une requête de plus par objet, sans clé.

### Changement de pivot

Le contenu bascule d'un coup (interpoler entre deux compressions différentes n'a pas de sens
visuel), mais la caméra garde sa direction et **la même distance physique** : la distance caméra est
reconvertie en km via l'inverse de la courbe de départ, puis re-comprimée avec celle d'arrivée
(`sceneDistanceToKm`). La cible d'`OrbitControls` revient à l'origine. Le bouton « Recentrer »
(et `R`) ramène la cible à l'origine en 600 ms après un déplacement au clic droit.

## Données

Aucun appel supplémentaire, aucun quota : les éléments orbitaux viennent de `/api/neo/details`
(JPL SBDB, écliptique J2000, déjà en cache 7 jours côté client) et la propagation képlérienne
deux corps existe déjà dans `web/src/orbit.js` pour le schéma SVG. Le point du NEO, lui, reste sur
la table Horizons — d'où un très léger décalage possible entre le point et son ellipse
(perturbations planétaires ignorées par le modèle deux corps), déjà signalé dans la légende.
