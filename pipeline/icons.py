"""Icônes PNG de la PWA (Pillow) : un repère blanc coché sur fond bleu.

    python pipeline/icons.py    regénère toutes les icônes
build.py appelle ensure(), qui ne crée que les icônes manquantes (sortie stable d'un build à l'autre).
"""

import math
import sys

from PIL import Image, ImageDraw

import config

BG_TOP, BG_BOTTOM = (42, 111, 224), (23, 78, 168)
CHECK = (29, 95, 209)
SUPERSAMPLE = 4

# nom de fichier -> (taille, échelle du motif) ; maskable : motif réduit pour rester dans la zone sûre
ICONS = {
    "icon-180.png": (180, 1.0),
    "icon-192.png": (192, 1.0),
    "icon-512.png": (512, 1.0),
    "icon-maskable-512.png": (512, 0.82),
}


def draw_icon(size, scale=1.0):
    S = size * SUPERSAMPLE
    img = Image.new("RGB", (S, S))
    d = ImageDraw.Draw(img)
    for y in range(S):  # dégradé vertical
        t = y / (S - 1)
        d.line([(0, y), (S, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOTTOM)))

    def P(x, y):  # coordonnées relatives au centre, mises à l'échelle du motif
        return (S / 2 + (x - 0.5) * S * scale, S / 2 + (y - 0.5) * S * scale)

    cx, cy, r, apex = 0.5, 0.43, 0.215, 0.80
    dist = apex - cy
    th = math.acos(r / dist)  # points de tangence du cône de la goutte
    left = (cx - r * math.sin(th), cy + r * math.cos(th))
    right = (cx + r * math.sin(th), cy + r * math.cos(th))
    d.polygon([P(*left), P(cx, apex), P(*right)], fill="white")
    x0, y0 = P(cx - r, cy - r)
    x1, y1 = P(cx + r, cy + r)
    d.ellipse([x0, y0, x1, y1], fill="white")

    w = round(0.058 * S * scale)
    pts = [P(0.405, 0.435), P(0.475, 0.505), P(0.605, 0.365)]
    d.line(pts, fill=CHECK, width=w, joint="curve")
    for x, y in (pts[0], pts[-1]):  # extrémités arrondies
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=CHECK)
    return img.resize((size, size), Image.LANCZOS)


def generate(only_missing=False):
    config.ICONS_DIR.mkdir(parents=True, exist_ok=True)
    made = []
    for name, (size, scale) in ICONS.items():
        path = config.ICONS_DIR / name
        if only_missing and path.exists():
            continue
        draw_icon(size, scale).save(path, optimize=True)
        made.append(name)
    return made


def ensure():
    made = generate(only_missing=True)
    if made:
        print(f"Icônes créées : {', '.join(made)}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    print("Icônes : " + ", ".join(generate()))
