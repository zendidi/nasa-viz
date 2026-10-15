# Crédits des textures

## Solar System Scope — CC BY 4.0

Tous les fichiers `2k_*.jpg` / `2k_*.png` viennent de **Solar System Scope**
(<https://www.solarsystemscope.com/textures/>), distribués sous
[Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/) :

> *« Distributed under Attribution 4.0 International license: You may use, adapt, and share these
> textures for any purpose, even commercially. »*

Téléchargés le 2026-09-29, toutes les cartes en équirectangulaire 2048 × 1024 (sauf l'anneau de
Saturne, bande 2048 × 125).

| fichier | corps / carte | amont | ici |
|---|---|---|---|
| `2k_mercury.jpg` | Mercure, couleur | 873 ko | 442 ko — ré-encodé q80 |
| `2k_venus_surface.jpg` | Vénus, surface (radar) — case « Voir sous les nuages » | 885 ko | 455 ko — ré-encodé q80 |
| `2k_venus_atmosphere.jpg` | Vénus, nuages — texture par défaut | 230 ko | inchangé |
| `2k_mars.jpg` | Mars, couleur | 751 ko | 385 ko — ré-encodé q80 |
| `2k_jupiter.jpg` | Jupiter, couleur | 499 ko | inchangé |
| `2k_saturn.jpg` | Saturne, couleur | 200 ko | inchangé |
| `2k_uranus.jpg` | Uranus, couleur | 78 ko | inchangé |
| `2k_neptune.jpg` | Neptune, couleur | 242 ko | inchangé |
| `2k_saturn_ring_alpha.png` | anneau de Saturne, RGBA | 12 ko | inchangé |
| `2k_sun.jpg` | Soleil | 822 ko | inchangé |
| `2k_earth_daymap.jpg` | Terre, jour | 463 ko | inchangé |
| `2k_earth_nightmap.jpg` | Terre, nuit | 255 ko | inchangé |
| `2k_earth_clouds.jpg` | Terre, nuages | 966 ko | inchangé |
| `2k_earth_normal_map.jpg` | Terre, normales | 521 ko (`.tif`) | 109 ko — converti q90 |
| `2k_earth_specular_map.jpg` | Terre, spéculaire | 339 ko (`.tif`) | 255 ko — converti q90 |
| `2k_moon.jpg` | Lune | 1 054 ko | inchangé |

Les deux cartes converties étaient servies en TIFF, que le web ne lit pas. Conversion et
ré-encodages faits à ImageMagick 7.1.2 ; écart mesuré au PSNR : 34,6 à 37,3 dB pour les trois
ré-encodages q80, 45,7 et 46,9 dB pour les deux conversions.

Le crédit à l'écran est à poser quand ces textures seront effectivement affichées (lot 5, étape 2) —
voir `docs/planetes-et-lunes.md`.

## three.js — licence non établie

`earth_atmos_2048.jpg`, `earth_lights_2048.png`, `earth_normal_2048.jpg`,
`earth_specular_2048.jpg` et `moon_1024.jpg` (retiré le 2026-10-15) venaient des exemples three.js, dont beaucoup d'assets
n'ont **pas de licence propre** — c'est un sujet ouvert chez eux. Le jeu Solar System Scope ci-dessus
couvre exactement les mêmes cartes : ces cinq fichiers sont à retirer au moment où la scène bascule.

**Bascule faite pour la Terre le 2026-10-12** (décision de l'utilisateur, en même temps que la
couche nuageuse) : le globe sert désormais `2k_earth_daymap`, `2k_earth_nightmap`,
`2k_earth_normal_map` et `2k_earth_specular_map`. Les **quatre** fichiers Terre three.js ne sont
plus référencés nulle part — ni dans `scene/bodies.js`, ni dans les préchargements de
`web/index.html` — et sont donc retirables dès que le rendu est validé à l'œil.

Ce qui a rendu la bascule possible : `earth_atmos_2048.jpg` a **les nuages peints dans la carte de
jour**, donc une couche nuageuse par-dessus les aurait dessinés deux fois. Le jeu SSS livre le jour
sans nuages et les nuages à part, seule forme où une couche indépendante a un sens.

**Bascule faite pour la Lune le 2026-10-15** : la scène sert `2k_moon.jpg`, et `moon_1024.jpg` a
été retiré du dépôt. La Lune porte une orientation calibrée au degré (le comptage vers l'est valait
12°, voir `docs/agent/decisions.md`), donc la bascule a d'abord été mesurée : les deux cartes,
confrontées aux 59 mers du gazetteer IAU/USGS par la méthode de
`tools/calibration/texture-longitude.py`, ont la même convention (bord gauche à 180°, pas de
miroir) et des décalages de −0,53° (`2k_moon`) et −1,05° (`moon_1024`) — un demi-degré d'écart,
sous la précision du gazetteer. La carte SSS est aussi nettement plus lisible : corrélation aux mers
r = −0,58 contre −0,16.

Il ne reste donc, de ce jeu three.js, que les quatre fichiers Terre en attente de comparaison.
