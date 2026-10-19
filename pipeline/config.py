"""Paramètres du pipeline : voies de la tournée, couleurs, marges, seuils."""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCES_DIR = ROOT / "sources"
WORK_DIR = ROOT / "work"
DOCS_DIR = ROOT / "docs"
DATA_DIR = DOCS_DIR / "data"
ICONS_DIR = DOCS_DIR / "icons"

INSEE = "01275"  # Neyron

# Voies de la tournée. L'index dans la liste est l'identifiant de rue (`s`) et la couleur.
# `min`/`max` : seuls ces numéros sont pointables ; les autres numéros de la voie
# qui tombent dans le cadre sont gardés comme repères (`ctx: true`).
STREETS = [
    {"name": "Montée Neuve"},
    {"name": "Chemin sous les Saules"},
    {"name": "Rue de la Gare"},
    {"name": "Avenue des Trois Glorieuses"},
    {"name": "Impasse des Pêcheurs"},
    {"name": "Chemin du Molliet"},
    {"name": "Impasse Privée B"},
    {"name": "Chemin du Barry"},
    {"name": "Route de Genève", "min": 58, "max": 193},
    {"name": "Montée des Écoles"},
]

# (clair, sombre) — toujours sur 6 chiffres.
COLORS = [
    ("#1d5fd1", "#6ea2ff"),
    ("#1f8a4c", "#5fcf8c"),
    ("#c22f25", "#ff7a6e"),
    ("#d0560a", "#ff9d55"),
    ("#0b8796", "#4fd3e0"),
    ("#9a6f00", "#e2b84a"),
    ("#c2287c", "#ff79bf"),
    ("#7a3fb0", "#bf8cf0"),
    ("#283a52", "#c9d6e8"),
    ("#5f7d0e", "#a9cc4a"),
]

# Nombre de numéros pointables attendus par rue : un écart fait échouer le build.
EXPECTED_COUNTS = [58, 18, 15, 5, 5, 4, 7, 3, 105, 9]

# Emprise
FRAME_MARGIN_M = 110   # autour des adresses de la tournée
GEOM_MARGIN_M = 150    # parcelles et bâtiments gardés au-delà du cadre

# Transformation GPS -> Lambert-93
AFFINE_MAX_RESIDUAL_M = 0.5

# Association adresse -> bâtiment
ASSOC_MIN_SHARE = 0.40          # part minimale de la surface du bâtiment dans la parcelle de l'adresse
ASSOC_FALLBACK_SEARCH_M = 25    # rayon de recherche du repli
ASSOC_FALLBACK_MAX_M = 6        # distance maximale acceptée pour le repli
ASSOC_HARD_TYPE = "01"          # bâti dur, préféré au bâti léger ("02") à distance comparable
ASSOC_HARD_TOLERANCE_M = 3      # un bâti dur jusqu'à 3 m plus loin reste préféré

# Tracés des rues (domaine non cadastré)
TRACE_PARCEL_BUFFER_M = 0.3
TRACE_CLOSING_M = 15            # fermeture morphologique : limite le domaine non cadastré à la commune
TRACE_CORRIDOR_M = 28
TRACE_POINT_RADIUS_M = 30
TRACE_MIN_PIECE_M2 = 40
TRACE_MAX_PIECE_DIST_M = 22
TRACE_MIN_AREA_M2 = 150
TRACE_PRIVATE_BUFFER_M = 3
TRACE_SIMPLIFY_M = 0.5
TRACE_MST_FALLBACK_M = 4
TRACE_FALLBACK_STREETS = set()  # index des rues tracées en repli MST.buffer(4)

# Étiquettes de rues
LABEL_SPACING_M = 450           # une étiquette tous les ~450 m le long de la rue
LABEL_DIRECTION_WINDOW_M = 40   # demi-fenêtre pour l'orientation locale
LABEL_END_MARGIN = 0.12          # part de la longueur sans étiquette à chaque extrémité (rues longues)
LABEL_SNAP_M = 40               # étiquette ramenée sur le tracé de la rue s'il est à moins de 40 m

# Tri naturel des suffixes : "" < bis < ter < quater < quinquies < lettres a-z
REP_ORDER = {"": 0, "bis": 1, "ter": 2, "quater": 3, "quinquies": 4}
