"""Paramètres du pipeline : commune, tournées prédéfinies, couleurs, marges, seuils."""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCES_DIR = ROOT / "sources"
WORK_DIR = ROOT / "work"
DOCS_DIR = ROOT / "docs"
DATA_DIR = DOCS_DIR / "data"
ICONS_DIR = DOCS_DIR / "icons"

INSEE = "01275"  # Neyron

# Toute la commune : chaque voie qui a au moins une adresse retenue devient une rue ; son rang dans
# l'ordre alphabétique (sans accents) est l'identifiant `s`. Un écart des totaux fait échouer le build.
ADDRESS_TYPES = {"entrée"}  # logements, cages d'escalier et bâtiments : hors distribution
EXPECTED_ADDRESSES = 941  # 942 lignes « entrée », dont un doublon BAN (2 Impasse Privée des Capucins)
EXPECTED_STREETS = 90

# Palette des rues (clair, sombre), toujours sur 6 chiffres. Ni vert ni orange : réservés aux statuts
# « fait » et « à repasser ». Deux rues voisines (tracés à moins de NEIGHBOR_DIST_M) ont des couleurs
# différentes, pour savoir à quelle rue appartient un numéro près d'un carrefour.
PALETTE = [
    ("#1d5fd1", "#6ea2ff"),
    ("#c22f25", "#ff7a6e"),
    ("#0b8796", "#4fd3e0"),
    ("#9a6f00", "#e2b84a"),
    ("#c2287c", "#ff79bf"),
    ("#7a3fb0", "#bf8cf0"),
    ("#283a52", "#c9d6e8"),
    ("#5f7d0e", "#a9cc4a"),
]
NEIGHBOR_DIST_M = 30

# Tournées prédéfinies, exportées dans addresses.json (`presets`). `min`/`max` : numéros retenus ;
# `expected` : nombre attendu, un écart fait échouer le build. L'id `default` est celui de la tournée
# par défaut de l'app (store.js) : la progression déjà saisie s'y rattache.
PRESETS = [
    {"id": "default", "name": "Neyron — 10 rues", "streets": [
        {"name": "Montée Neuve", "expected": 58},
        {"name": "Chemin sous les Saules", "expected": 18},
        {"name": "Rue de la Gare", "expected": 15},
        {"name": "Avenue des Trois Glorieuses", "expected": 5},
        {"name": "Impasse des Pêcheurs", "expected": 5},
        {"name": "Chemin du Molliet", "expected": 4},
        {"name": "Impasse Privée B", "expected": 7},
        {"name": "Chemin du Barry", "expected": 3},
        {"name": "Route de Genève", "min": 58, "max": 193, "expected": 105},
        {"name": "Montée des Écoles", "expected": 9},
    ]},
]

# Emprise
FRAME_MARGIN_M = 110   # autour des adresses de la commune
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
TRACE_FALLBACK_STREETS = set()  # noms des voies tracées en repli MST.buffer(4)

# Étiquettes de rues
LABEL_SPACING_M = 450           # une étiquette tous les ~450 m le long de la rue
LABEL_DIRECTION_WINDOW_M = 40   # demi-fenêtre pour l'orientation locale
LABEL_END_MARGIN = 0.12          # part de la longueur sans étiquette à chaque extrémité (rues longues)
LABEL_SNAP_M = 40               # étiquette ramenée sur le tracé de la rue s'il est à moins de 40 m

# Tri naturel des suffixes : "" < bis < ter < quater < quinquies < lettres a-z
REP_ORDER = {"": 0, "bis": 1, "ter": 2, "quater": 3, "quinquies": 4}
