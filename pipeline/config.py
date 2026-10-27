"""Paramètres du pipeline : communes, tournées prédéfinies, couleurs, marges, seuils."""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCES_DIR = ROOT / "sources"
WORK_DIR = ROOT / "work"
DOCS_DIR = ROOT / "docs"
DATA_DIR = DOCS_DIR / "data"
ICONS_DIR = DOCS_DIR / "icons"

# Communes couvertes (code INSEE, nom), dans l'ordre d'affichage. Chaque voie (commune + nom BAN) qui a au moins
# une adresse retenue devient une rue ; son rang dans l'ordre alphabétique (sans accents) est l'identifiant `s`.
# `expected` : (adresses, voies) attendues ; un écart fait échouer le build.
COMMUNES = [
    {"insee": "01275", "name": "Neyron", "expected": (941, 90)},  # 942 lignes, dont un doublon BAN
    {"insee": "01043", "name": "Beynost", "expected": None},
    {"insee": "01376", "name": "Saint-Maurice-de-Beynost", "expected": None},
]
INSEES = [c["insee"] for c in COMMUNES]

# Positions écartées : sous-adresses d'une adresse déjà présente (logement, cage d'escalier, bâtiment). Les positions
# « segment » (sur l'axe de la rue), « parcelle » ou sans type sont de vraies adresses, souvent récentes : gardées.
ADDRESS_EXCLUDED_TYPES = {"logement", "cage d'escalier", "cage d’escalier", "bâtiment", "service technique",
                          "délivrance postale"}

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
    {"id": "default", "name": "Neyron — 10 rues", "commune": "01275", "streets": [
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
FRAME_MARGIN_M = 110   # autour des adresses des communes
GEOM_MARGIN_M = 150    # parcelles et bâtiments gardés au-delà du cadre
TILE_M = 500           # parcelles et bâtiments sans adresse regroupés par tuile (l'app ne dessine que celles à l'écran)

# Transformation GPS -> Lambert-93
AFFINE_MAX_RESIDUAL_M = 0.5

# Association adresse -> bâtiment
ASSOC_MIN_SHARE = 0.40          # part minimale de la surface du bâtiment dans la parcelle de l'adresse
ASSOC_FALLBACK_SEARCH_M = 25    # rayon de recherche du repli
ASSOC_FALLBACK_MAX_M = 6        # distance maximale acceptée pour le repli
ASSOC_HARD_TYPE = "01"          # bâti dur, préféré au bâti léger ("02") à distance comparable
ASSOC_HARD_TOLERANCE_M = 3      # un bâti dur jusqu'à 3 m plus loin reste préféré
ASSOC_PARCEL_SNAP_M = 5         # adresse sans cad_parcelles : parcelle qui contient le point, ou à moins de 5 m
ASSOC_PARCEL_TIE_M = 1.5        # à un angle, toutes les parcelles à 1,5 m près de la plus proche

# Bâtiments sans adresse (contrôle « adresses manquantes » de l'onglet Préparer) : bâti dur, assez grand
# pour une habitation, sur une parcelle qu'aucune adresse BAN ne cite et loin de tout point d'adresse
UNADDRESSED_MIN_AREA_M2 = 50
UNADDRESSED_MIN_DIST_M = 20
UNADDRESSED_SEGMENT_DIST_M = 40  # adresse posée sur l'axe de la rue (« segment ») : sa maison peut être à 40 m

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

# Limites des communes (plan) : régions = fermeture des parcelles de chaque commune
LIMIT_MIN_AREA_M2 = 20000       # morceaux et trous plus petits ignorés
LIMIT_SIMPLIFY_M = 2
LIMIT_DEDUP_M = 40              # limite déjà tracée par la commune voisine (ou bord du cadre) : pas retracée
LIMIT_MIN_LENGTH_M = 60

# Étiquettes de rues
LABEL_SPACING_M = 450           # une étiquette tous les ~450 m le long de la rue
LABEL_DIRECTION_WINDOW_M = 40   # demi-fenêtre pour l'orientation locale
LABEL_END_MARGIN = 0.12          # part de la longueur sans étiquette à chaque extrémité (rues longues)
LABEL_SNAP_M = 40               # étiquette ramenée sur le tracé de la rue s'il est à moins de 40 m

# Réseau routier (itinéraire) : BD TOPO pour les routes, OSM pour compléter les cheminements à pied et à vélo.
# Téléchargés par pipeline/fetch_roads.py dans sources/ ; sans eux, le build ne produit pas roads.json.
ROADS_BDTOPO = "roads-bdtopo.geojson"
ROADS_OSM = "roads-osm.json"
ROADS_MARGIN_M = 300            # emprise complète du réseau au-delà du cadre
ROADS_FAR_MARGIN_M = 1500       # au-delà, jusqu'ici : routes principales seulement (boucles par les communes voisines,
                                # sans lesquelles des sens uniques coupés isoleraient le bord du Rhône)
ROADS_FAR_MAX_IMPORTANCE = 4

# Tri naturel des suffixes : "" < bis < ter < quater < quinquies < lettres a-z
REP_ORDER = {"": 0, "bis": 1, "ter": 2, "quater": 3, "quinquies": 4}
