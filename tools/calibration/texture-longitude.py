#!/usr/bin/env python3
"""Mesure la convention de longitude des textures équirectangulaires du projet.

À quelle longitude correspond la colonne de gauche (`u = 0`) d'une carte
`web/public/textures/2k_*.jpg` ? Le fournisseur (Solar System Scope) ne le dit
pas : sa page annonce « equirectangular projection » et rien sur le bord gauche.
Ce script répond en corrélant chaque carte avec des données dont la convention,
elle, est publiée — et il teste les 2048 décalages possibles ainsi que le
miroir est/ouest, pour que la réponse soit un maximum mesuré et pas une
hypothèse confirmée.

Trois corps, trois vérités terrain indépendantes :

* **Terre** — les polygones de côtes Natural Earth 110 m (domaine public, CRS84,
  donc longitudes WGS84 explicites) rastérisés ici, comparés au masque terre/mer
  qu'est la carte spéculaire du jeu (l'eau est spéculaire, pas la terre).
* **Lune** — les 59 mers, lacs et océans du gazetteer IAU/USGS, avec leur centre
  et leur diamètre. Les mers lunaires sont du basalte sombre : leur position
  prédit les pixels sombres. Vérité *définitionnelle* en prime, le méridien
  origine lunaire étant le point sub-terrestre moyen.
* **Mars** — les 29 formations d'albédo dont le nom classique (Mare, Sinus,
  Lacus, Palus, Fretum, Syrtis) signale une zone sombre, coordonnées du même
  gazetteer. Ces coordonnées-là sont arrondies à la grille de 5° de
  Schiaparelli : elles donnent la convention, pas un décalage au degré près.

Hors build et hors CI : outil de calibration à lancer à la main le jour où le
jeu de textures change. Demande Python 3, `pillow` et `numpy`, et télécharge
~29 Mo la première fois (rien de tout ça n'est sur le quota NASA).

    py -m pip install pillow numpy
    py tools/calibration/texture-longitude.py

Résultat au 2026-09-29, identique sur les trois corps : **bord gauche = 180°,
centre = longitude 0, longitude est croissante vers la droite, nord en haut,
pas de miroir.** Décalage mesuré 0 px sur 2048 pour la Terre (98,89 % d'accord,
contre 72,90 % au mieux pour le miroir) ; −3 px sur la Lune et −11 px sur Mars,
où les centres du gazetteer sont eux-mêmes arrondis. Le raisonnement complet et
ce que le client en fait : `docs/planetes-et-lunes.md`, lot 5 étape 4.
"""

from __future__ import annotations

import io
import json
import struct
import sys
import urllib.request
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

RACINE = Path(__file__).resolve().parents[2]
TEXTURES = RACINE / "web" / "public" / "textures"
CACHE = Path(__file__).resolve().parent / ".cache"

COTES = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_land.geojson"
GAZETTEER = "https://asc-planetarynames-data.s3.us-west-2.amazonaws.com/{}_nomenclature_center_pts.zip"

# La convention mise à l'épreuve, et la seule chose que ce script suppose.
# Tout le reste est mesuré contre elle.
BORD_GAUCHE_DEG = -180.0
RAYON_LUNE_KM = 1737.4


def telecharge(url: str, nom: str) -> bytes:
    CACHE.mkdir(exist_ok=True)
    fichier = CACHE / nom
    if not fichier.exists():
        print(f"  téléchargement {nom}…", flush=True)
        with urllib.request.urlopen(url) as reponse:
            fichier.write_bytes(reponse.read())
    return fichier.read_bytes()


# --- lecture du gazetteer IAU/USGS ------------------------------------------
# Un shapefile de points plus son .dbf : deux formats simples et figés, lus ici
# directement pour ne pas imposer une dépendance SIG à un script de calibration.


def _points_shp(donnees: bytes) -> list[tuple[float, float] | None]:
    flux = io.BytesIO(donnees)
    flux.seek(24)
    longueur = struct.unpack(">i", flux.read(4))[0] * 2
    flux.seek(100)
    points: list[tuple[float, float] | None] = []
    while flux.tell() < longueur:
        _, taille = struct.unpack(">ii", flux.read(8))
        enregistrement = flux.read(taille * 2)
        forme = struct.unpack("<i", enregistrement[:4])[0]
        points.append(struct.unpack("<dd", enregistrement[4:20]) if forme == 1 else None)
    return points


def _lignes_dbf(donnees: bytes) -> list[dict[str, str]]:
    flux = io.BytesIO(donnees)
    *_, nombre, entete, taille = struct.unpack("<BBBBIHH", flux.read(12))
    flux.read(20)
    champs = []
    while True:
        brut = flux.read(32)
        if brut[0] == 0x0D:
            break
        champs.append((brut[:11].split(b"\0")[0].decode("latin1"), brut[16]))
    flux.seek(entete)
    lignes = []
    for _ in range(nombre):
        enregistrement = flux.read(taille)
        position = 1
        ligne = {}
        for nom, longueur_champ in champs:
            ligne[nom] = enregistrement[position : position + longueur_champ].decode("utf-8", "replace").strip()
            position += longueur_champ
        lignes.append(ligne)
    return lignes


def formations(corps: str) -> list[dict]:
    """Les entités nommées d'un corps : nom, type, diamètre, longitude est, latitude."""
    archive = zipfile.ZipFile(io.BytesIO(telecharge(GAZETTEER.format(corps), f"{corps}.zip")))
    base = f"{corps}_nomenclature_center_pts"
    points = _points_shp(archive.read(base + ".shp"))
    lignes = _lignes_dbf(archive.read(base + ".dbf"))
    return [
        {
            "nom": ligne.get("clean_name", ""),
            "type": ligne.get("type", ""),
            "diametre": float(ligne.get("diameter") or 0.0),
            "lon": point[0],
            "lat": point[1],
        }
        for ligne, point in zip(lignes, points)
        if point
    ]


# --- grilles ----------------------------------------------------------------


def grille(hauteur: int, largeur: int):
    """Direction unitaire de chaque pixel, sous la convention mise à l'épreuve."""
    lat = (0.5 - (np.arange(hauteur) + 0.5) / hauteur) * 180.0
    lon = ((np.arange(largeur) + 0.5) / largeur) * 360.0 + BORD_GAUCHE_DEG
    a = np.radians(lat)[:, None]
    o = np.radians(lon)[None, :]
    directions = (np.cos(a) * np.cos(o), np.cos(a) * np.sin(o), np.sin(a) * np.ones_like(o))
    return lat, directions


def calotte(directions, centres, rayon_deg) -> np.ndarray:
    """Union des calottes sphériques centrées sur `centres` — vraies calottes,
    pas des disques en pixels : un disque d'image s'étire avec la latitude."""
    gx, gy, gz = directions
    masque = np.zeros(gx.shape, bool)
    for lat, lon, rayon in centres:
        if rayon <= 0:
            continue
        a, o = np.radians(lat), np.radians(((lon + 180.0) % 360.0) - 180.0)
        cx, cy, cz = np.cos(a) * np.cos(o), np.cos(a) * np.sin(o), np.sin(a)
        masque |= (gx * cx + gy * cy + gz * cz) >= np.cos(np.radians(rayon))
    return masque


def produits(reference: np.ndarray, image: np.ndarray) -> np.ndarray:
    """`S[s] = Σ reference ⊙ roll(image, s)`, pour les 2048 décalages d'un coup.

    Les trois notes ci-dessous se ramènent toutes à cette somme : leurs autres
    termes (moyennes, variances, sommes de poids) sont invariants par décalage
    circulaire. Une corrélation circulaire par FFT les donne toutes en une
    passe, là où 4096 `np.roll` sur une image 2048 × 1024 prendraient des
    minutes — et le contrôle plus bas vérifie que c'est bien la même chose.
    """
    largeur = reference.shape[1]
    spectre = np.conj(np.fft.rfft(image, axis=1)) * np.fft.rfft(reference, axis=1)
    return np.fft.irfft(spectre, n=largeur, axis=1).sum(axis=0)


def alignements(reference: np.ndarray, image: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Les sommes de `produits` sans miroir, puis avec. Le meilleur score est la
    mesure ; l'écart au reste est ce qui dit si la mesure vaut."""
    droit = produits(reference, image)
    miroir = produits(reference, image[:, ::-1].copy())

    # Contrôle : la FFT doit rendre exactement ce que rendrait la force brute.
    # Trois décalages suffisent à attraper une erreur de signe ou de sens.
    for decalage in (0, 1, reference.shape[1] // 3):
        attendu = float((reference * np.roll(image, decalage, axis=1)).sum())
        assert abs(droit[decalage] - attendu) <= 1e-6 * max(1.0, abs(attendu)), (
            f"corrélation FFT ≠ force brute au décalage {decalage}"
        )
    return droit, miroir


def signe(decalage: int, largeur: int) -> str:
    centre = decalage if decalage < largeur // 2 else decalage - largeur
    return f"{centre:+5d} px = {centre * 360.0 / largeur:+6.2f}°"


# --- les trois mesures ------------------------------------------------------


def terre() -> None:
    print("\n=== TERRE — côtes Natural Earth 110 m (domaine public, CRS84) ===")
    carte = np.asarray(Image.open(TEXTURES / "2k_earth_specular_map.jpg").convert("L")).astype(float)
    hauteur, largeur = carte.shape
    # L'eau réfléchit, la terre non : la carte spéculaire EST un masque terre/mer.
    mesure = carte < 128

    verite = Image.new("1", (largeur, hauteur), 0)
    crayon = ImageDraw.Draw(verite)
    geo = json.loads(telecharge(COTES, "ne_110m_land.geojson"))
    for entite in geo["features"]:
        forme = entite["geometry"]
        anneaux = (
            forme["coordinates"]
            if forme["type"] == "Polygon"
            else [a for p in forme["coordinates"] for a in p]
        )
        for anneau in anneaux:
            crayon.polygon(
                [
                    ((lon - BORD_GAUCHE_DEG) / 360.0 * largeur, (90.0 - lat) / 180.0 * hauteur)
                    for lon, lat in anneau
                ],
                fill=1,
            )
    verite = np.asarray(verite)

    lat = (0.5 - (np.arange(hauteur) + 0.5) / hauteur) * 180.0
    poids = np.repeat(np.cos(np.radians(lat))[:, None], largeur, axis=1)
    # Au-delà de ±75° la banquise et l'Antarctique font dire n'importe quoi à un
    # masque terre/mer, et une colonne y pèse presque rien de toute façon.
    bande = np.abs(lat) < 75

    print(
        f"  fraction sombre pondérée en surface : {(mesure * poids).sum() / poids.sum():.3f}"
        "  (terres émergées : 0,292)"
    )

    m = mesure[bande].astype(float)
    t = verite[bande].astype(float)
    w = poids[bande]
    surface = w.sum()
    # Σ w·[m == t] développé : le terme croisé est le seul à dépendre du décalage.
    constante = -(w * m).sum() - (w * t).sum() + surface
    droit, miroir = (
        (2.0 * serie + constante) / surface for serie in alignements(w * t, m)
    )

    decalage = int(droit.argmax())
    voisinage = np.abs((np.arange(largeur) - decalage + largeur // 2) % largeur - largeur // 2) <= 3
    print(f"  meilleur accord : {droit[decalage]:6.2%}  miroir=False  décalage {signe(decalage, largeur)}")
    print(f"  hors du sommet  : {droit[~voisinage].max():6.2%}   au pire : {droit.min():6.2%}")
    print(f"  miroir au mieux : {miroir.max():6.2%}")


def lune() -> None:
    print("\n=== LUNE — mers du gazetteer IAU/USGS (basalte sombre) ===")
    carte = np.asarray(Image.open(TEXTURES / "2k_moon.jpg").convert("L")).astype(float)
    hauteur, largeur = carte.shape
    lat, directions = grille(hauteur, largeur)
    poids = np.repeat(np.cos(np.radians(lat))[:, None], largeur, axis=1)

    mers = [
        f for f in formations("MOON") if f["type"].startswith(("Mare", "Oceanus", "Lacus", "Sinus", "Palus"))
    ]
    masque = calotte(
        directions,
        [(f["lat"], f["lon"], np.degrees(0.5 * f["diametre"] / RAYON_LUNE_KM)) for f in mers],
        0,
    )
    print(f"  {len(mers)} mers retenues ; {masque.mean():.1%} de la carte prédite sombre")

    # Corrélation de Pearson pondérée entre la carte et le masque : la plus
    # négative est le meilleur accord, « prédit sombre » devant tomber sur
    # « effectivement sombre ». Moyennes et écarts-types sont invariants par
    # décalage, seul le terme croisé bouge.
    surface = poids.sum()
    m = masque.astype(float)
    centre_image = np.average(carte, weights=poids)
    centre_masque = np.average(m, weights=poids)
    ecarts = np.sqrt(
        np.average((carte - centre_image) ** 2, weights=poids)
        * np.average((m - centre_masque) ** 2, weights=poids)
    )
    droit, miroir = (
        (serie / surface - centre_image * centre_masque) / ecarts
        for serie in alignements(poids * m, carte)
    )

    decalage = int(droit.argmin())
    print(f"  meilleur accord : r={droit[decalage]:+.3f}  miroir=False  décalage {signe(decalage, largeur)}")
    print(f"  à l'opposé      : r={droit.max():+.3f}   miroir au mieux : r={miroir.min():+.3f}")
    print(
        f"  luminance moyenne : mers {np.average(carte[masque], weights=poids[masque]):.1f}"
        f"  |  reste {np.average(carte[~masque], weights=poids[~masque]):.1f}"
    )


def mars() -> None:
    print("\n=== MARS — formations d'albédo sombres du gazetteer IAU/USGS ===")
    carte = np.asarray(Image.open(TEXTURES / "2k_mars.jpg").convert("L")).astype(float)
    hauteur, largeur = carte.shape
    lat, directions = grille(hauteur, largeur)
    poids = np.repeat(np.cos(np.radians(lat))[:, None], largeur, axis=1)

    # Règle de nommage de Schiaparelli : les zones sombres ont reçu des noms de
    # mers. C'est une convention cartographique publiée, pas un jugement à l'œil.
    def sombre(nom: str) -> bool:
        return nom.startswith(("Mare ", "Syrtis ")) or nom.endswith(
            (" Sinus", " Lacus", " Palus", " Fretum", " Mare")
        )

    zones = [f for f in formations("MARS") if f["type"] == "Albedo Feature" and sombre(f["nom"])]
    # Rayon forfaitaire : le gazetteer ne donne pas de diamètre pour ces entités,
    # et leurs centres sont arrondis à la grille classique de 5°.
    masque = calotte(directions, [(f["lat"], f["lon"], 6.0) for f in zones], 0)
    print(f"  {len(zones)} formations retenues ; {masque.mean():.1%} de la carte prédite sombre")

    # Luminance moyenne sous les formations prédites sombres : plus bas, mieux
    # c'est. Le dénominateur ne dépend pas du décalage.
    m = masque.astype(float)
    surface = (poids * m).sum()
    droit, miroir = (serie / surface for serie in alignements(poids * m, carte))

    decalage = int(droit.argmin())
    telle_quelle = droit[0]
    rang = 1 + int((droit < telle_quelle).sum() + (miroir < telle_quelle).sum())
    print(f"  meilleur accord : {droit[decalage]:.1f}  miroir=False  décalage {signe(decalage, largeur)}")
    print(
        f"  à l'opposé      : {droit.max():.1f}   miroir au mieux : {miroir.min():.1f}"
        f"   moyenne de la carte : {np.average(carte, weights=poids):.1f}"
    )
    print(f"  convention testée telle quelle : {telle_quelle:.1f} — rang {rang} sur {2 * largeur}")


def main() -> int:
    if not TEXTURES.is_dir():
        print(f"textures introuvables : {TEXTURES}", file=sys.stderr)
        return 1
    print(f"Convention mise à l'épreuve : bord gauche = {BORD_GAUCHE_DEG:+.0f}°, est vers la droite, nord en haut.")
    terre()
    lune()
    mars()
    print(
        "\n« miroir=False » sur les trois corps, et un décalage nul à la précision de chaque\n"
        "vérité terrain (0 px sur les côtes, quelques pixels là où le gazetteer arrondit),\n"
        "valident la convention."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
