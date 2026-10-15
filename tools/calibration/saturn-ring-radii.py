#!/usr/bin/env python3
"""Mesure à quels rayons correspondent les deux bords de la bande d'anneau de Saturne.

`web/public/textures/2k_saturn_ring_alpha.png` est une bande RGBA de 2048 × 125 :
2048 échantillons en travers du système d'anneaux, une ligne répétée. Pour la
poser sur un anneau il faut savoir ce que valent ses deux extrémités en km, et
le fournisseur ne le dit pas — même inconnue que la convention de longitude des
cartes, et même méthode : on la mesure.

La bande porte ses propres repères dans son canal alpha. Deux d'entre eux
tombent en **une seule colonne** — le bord externe de l'anneau B (chute dans la
division de Cassini) et le bord externe de l'anneau A (chute dans le vide). Le
tableau des rayons de la NASA (NSSDCA, *Saturnian Rings Fact Sheet*, téléchargé
ici) donne ces deux rayons, et deux points fixent la carte linéaire.

Deux autres structures, qui ne servent **pas** à l'ajustement, la contrôlent : la
frontière C/B et le bord interne de la division de Encke.

Hors build et hors CI, comme l'autre script de ce dossier. Demande Python 3,
`pillow` et `numpy` :

    py tools/calibration/saturn-ring-radii.py

Résultat au 2026-09-29 : **r(u) = 69 289 + 71 766 u km**, soit 1,150 à 2,340
rayons équatoriaux de Saturne, à 35 km par colonne. Les contrôles tombent à
41 km sur le bord franc de Encke et à 224 km sur la frontière C/B — qui est, elle,
une rampe douce dans la bande et non un bord, donc six colonnes y sont le bruit
attendu et pas un défaut de la carte. Ce que le client en fait :
`web/src/scene/planets.js`, entrée `saturn.ring`.
"""

from __future__ import annotations

import re
import sys
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

RACINE = Path(__file__).resolve().parents[2]
BANDE = RACINE / "web" / "public" / "textures" / "2k_saturn_ring_alpha.png"
CACHE = Path(__file__).resolve().parent / ".cache"
TABLE = "https://nssdc.gsfc.nasa.gov/planetary/factsheet/satringfact.html"

# Rayon équatorial de Saturne, pour exprimer le résultat dans l'unité des tables
# d'anneaux. Lu dans la même page que les rayons ci-dessous.
RAYON_EQUATORIAL_KM = 60268.0


def rayons_nasa() -> dict[str, float]:
    """Les rayons du tableau NSSDCA, par nom de bord, en km."""
    CACHE.mkdir(exist_ok=True)
    fichier = CACHE / "satringfact.html"
    if not fichier.exists():
        print("  téléchargement de la table NASA…", flush=True)
        with urllib.request.urlopen(TABLE) as reponse:
            fichier.write_bytes(reponse.read())
    texte = re.sub(r"<[^>]+>", "\n", fichier.read_text(encoding="utf-8", errors="replace"))
    lignes = [" ".join(l.split()) for l in texte.split("\n")]
    lignes = [l for l in lignes if l and l != "&nbsp;"]

    rayons = {}
    for i, ligne in enumerate(lignes[:-1]):
        suivante = lignes[i + 1].replace(",", "")
        if re.fullmatch(r"\d{4,7}", suivante):
            rayons.setdefault(ligne, float(suivante))
    return rayons


def alpha_par_colonne() -> np.ndarray:
    image = np.asarray(Image.open(BANDE)).astype(float)
    if image.shape[2] != 4:
        raise SystemExit("la bande doit être RGBA : c'est l'alpha qui porte les divisions")
    return image[:, :, 3].mean(axis=0)


def front_descendant(alpha: np.ndarray, depart: int, fin: int) -> float:
    """La colonne où l'alpha s'effondre, repérée par la pente la plus raide.

    Un simple seuil ne marche pas ici et c'est instructif : la division de
    Cassini n'est pas vide, son alpha remonte au-dessus de la mi-hauteur
    quelques colonnes après le bord de B, et un seuil renvoie alors la
    *deuxième* chute, 15 colonnes trop loin. La pente, elle, ne s'y trompe pas.

    Le bord est rendu à `i + 0.5`, entre la dernière colonne pleine et la
    première colonne vide : le bord physique est quelque part entre les deux,
    et un demi-pixel vaut 18 km ici.
    """
    pente = np.diff(alpha[depart:fin])
    return depart + int(pente.argmin()) + 0.5


def main() -> int:
    if not BANDE.exists():
        print(f"bande introuvable : {BANDE}", file=sys.stderr)
        return 1

    alpha = alpha_par_colonne()
    largeur = len(alpha)
    nasa = rayons_nasa()
    print(f"table NASA lue : {len(nasa)} rayons, dont {', '.join(list(nasa)[:4])}…")

    # --- les deux ancres : les seuls fronts francs de la bande ---------------
    col_b = front_descendant(alpha, 1300, 1420)   # B -> division de Cassini
    col_a = front_descendant(alpha, 1880, 1960)   # A -> vide
    r_b, r_a = nasa["B outer edge"], nasa["A outer edge"]

    u_b, u_a = (col_b + 0.5) / largeur, (col_a + 0.5) / largeur
    pente = (r_a - r_b) / (u_a - u_b)
    origine = r_b - pente * u_b
    par_colonne = pente / largeur

    print(f"\nancres : bord externe de B colonne {col_b:.1f} = {r_b:.0f} km")
    print(f"         bord externe de A colonne {col_a:.1f} = {r_a:.0f} km")
    print(f"\n  r(u) = {origine:.0f} + {pente:.0f} × u   ({par_colonne:.1f} km par colonne)")
    print(f"  bande : {origine:.0f} km à {origine + pente:.0f} km")
    print(
        f"  soit {origine / RAYON_EQUATORIAL_KM:.3f} à "
        f"{(origine + pente) / RAYON_EQUATORIAL_KM:.3f} rayons équatoriaux"
    )

    # --- contrôles : deux structures qui n'ont pas servi à l'ajustement ------
    # La frontière C/B est l'abscisse où l'alpha franchit la moitié entre le
    # plateau C et le plateau B ; le bord interne de Encke est la chute qui ouvre
    # la division (la table NASA repère les divisions de moins de 1000 km par
    # leur bord interne).
    plateau_c = np.median(alpha[400:600])
    plateau_b = np.median(alpha[700:1300])
    mi = 0.5 * (plateau_c + plateau_b)
    lisse = np.convolve(alpha, np.ones(9) / 9, "same")
    col_cb = next(i for i in range(560, 800) if lisse[i] > mi) - 0.5
    col_encke = front_descendant(alpha, 1800, 1845)

    print("\ncontrôles, aucun n'a servi à l'ajustement :")
    for nom, colonne, attendu in (
        ("frontière C / B", col_cb, nasa["B inner edge"]),
        ("bord interne de Encke", col_encke, nasa["Encke gap"]),
    ):
        mesure = origine + pente * (colonne + 0.5) / largeur
        ecart = mesure - attendu
        print(
            f"  {nom:<24} colonne {colonne:6.1f} → {mesure:7.0f} km   table {attendu:7.0f}"
            f"   écart {ecart:+5.0f} km ({ecart / par_colonne:+.1f} colonne)"
        )

    # --- ce que la bande ne montre pas --------------------------------------
    vides = int((alpha[: largeur // 4] < 1).sum())
    print(
        f"\nles {vides} premières colonnes sont à alpha zéro : la bande commence à"
        f" {origine:.0f} km, dans l'anneau D, trop ténu ({nasa.get('D inner edge', 0):.0f} km,"
        " profondeur optique 1e-5) pour avoir été dessiné."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
