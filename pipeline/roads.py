"""Réseau routier de l'itinéraire : graphe orienté par mode (voiture, vélo, pied) et rattachement des adresses.

Sources (téléchargées par fetch_roads.py) :
- BD TOPO (IGN, Licence Ouverte) : tronçons de route avec sens de circulation, accès, vitesse, et pour chaque
  côté l'identifiant BAN de la voie (`identifiant_voie_ban_gauche/droite`, même clé que le début des ids
  d'adresse : « 01275_0660 ») ;
- OSM (ODbL) : seulement les cheminements absents de la BD TOPO (sentiers, escaliers, passages, voies récentes),
  raccordés au réseau.

Rattachement d'une adresse : tronçon de sa voie le plus proche de son **point de remise** estimé (point de la
limite de sa parcelle le plus proche de la route, la façade), côté de la route, et distance route - remise.
"""

import hashlib
import json
import math
import re
import unicodedata

import numpy as np
import shapely
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import connected_components
from shapely.geometry import LineString, Point
from shapely.ops import nearest_points, substring
from shapely.strtree import STRtree

import config
import geo

# bits d'accès par mode (roads.json, edges[][3])
CAR, BIKE, FOOT, PRIVATE = 1, 2, 4, 8
CLASSES = ["route", "rond-point", "2 chaussées", "autoroute", "bretelle", "empierrée", "chemin", "sentier",
           "escalier", "piéton", "cyclable", "desserte", "route OSM"]
BDTOPO_CLASS = {"Route à 1 chaussée": 0, "Rond-point": 1, "Route à 2 chaussées": 2, "Type autoroutier": 3,
                "Bretelle": 4, "Route empierrée": 5, "Chemin": 6, "Sentier": 7, "Escalier": 8}
# OSM : cheminements ajoutés (pied et vélo) et voies ajoutées (tous modes) quand la BD TOPO ne les a pas
OSM_PATHS = {"footway": 9, "path": 9, "pedestrian": 9, "steps": 8, "cycleway": 10, "bridleway": 9,
             "track": 11, "service": 11}
OSM_ROADS = {"residential": 12, "unclassified": 12, "living_street": 12, "tertiary": 12, "secondary": 12,
             "primary": 12}
DEFAULT_KMH = {0: 30, 1: 25, 2: 50, 3: 90, 4: 40, 5: 15, 6: 10, 12: 30}
MAX_KMH = 70                    # tournée : jamais plus vite, même sur une départementale
NODE_SNAP_M = 0.2               # extrémités confondues à 20 cm près
OSM_OVERLAP_M = 6               # un cheminement OSM à moins de 6 m d'un tronçon BD TOPO le double
OSM_MIN_PIECE_M = 10
OSM_CONNECT_M = 8               # raccordement d'un bout de cheminement au tronçon le plus proche
SIMPLIFY_M = 0.5
NO_WEAVE_WIDTH_M = 9            # largeur de chaussée à partir de laquelle on ne tisse pas d'office
FRONTAGE_MAX_PARCEL_M2 = 20000  # au-delà (grande parcelle agricole) : point de remise = point d'adresse
CAR_ACCESS_MAX_M = 400          # adresse sur un sentier : point de la route carrossable le plus proche
MIN_NAME_MATCH = 0.88          # rattachées à un tronçon de leur voie (identifiant BAN, nom, impasse sans nom) ; le reste :
#                                 impasses privées absentes des deux sources, desservies depuis la route d'accès
UNNAMED_MAX_M = 40
SAME_STREET_MAX_M = 120
# noms abrégés de la BD TOPO (« CHE DU GUE ») et noms OSM, comparés aux noms BAN sans accents, articles ni « privée »
ABBR = {"che": "chemin", "imp": "impasse", "all": "allee", "r": "rue", "mte": "montee", "pl": "place",
        "prom": "promenade", "rte": "route", "av": "avenue", "res": "residence", "lot": "lotissement",
        "sq": "square", "bd": "boulevard", "pass": "passage", "sen": "sentier", "rle": "ruelle"}
STOP = {"de", "du", "des", "la", "le", "les", "l", "d", "privee", "prive"}


class RoadsError(Exception):
    pass


def name_key(name):
    """Nom de voie comparable : « Impasse Privée des Jardins de Mahé » et « IMP JARDINS DE MAHE » -> même clé."""
    if not name:
        return None
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    words = [ABBR.get(w, w) for w in re.split(r"[^a-z0-9]+", s) if w]
    words = [w for w in words if w not in STOP]
    return " ".join(words) or None


# ------------------------------------------------------------------ lecture


def _bdtopo_edge(p):
    """(classe, accès, sens, km/h, pas de tissage d'office) d'un tronçon BD TOPO."""
    cls = BDTOPO_CLASS.get(p.get("nature"))
    if cls is None:
        return None
    acc = p.get("acces_vehicule_leger") or "Libre"
    imp = int(p.get("importance") or 5)
    if cls == 3:
        m = CAR
    elif cls == 4:
        m = CAR if imp <= 2 else CAR | BIKE
    elif cls == 8:
        m = FOOT
    elif cls == 7:
        m = FOOT | BIKE
    else:
        m = BIKE | FOOT
        if acc != "Physiquement impossible":
            m |= CAR
            if acc.startswith("Restreint"):
                m |= PRIVATE  # voie privée : carrossable pour desservir, avec une pénalité dans l'app
    ow = {"Sens direct": 1, "Sens inverse": -1}.get(p.get("sens_de_circulation"), 0)
    v = p.get("vitesse_moyenne_vl") or DEFAULT_KMH.get(cls, 20)
    v = int(max(5, min(MAX_KMH, v)))
    width = p.get("largeur_de_chaussee") or 0
    lanes = p.get("nombre_de_voies") or 0
    nw = int(cls in (1, 2, 3, 4) or imp <= 2 or width >= NO_WEAVE_WIDTH_M or lanes >= 3)
    return cls, m, ow, v, nw


def load_bdtopo(path):
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    out = []
    for feat in d["features"]:
        p = feat["properties"]
        if p.get("etat_de_l_objet") not in (None, "En service") or p.get("fictif"):
            continue
        attrs = _bdtopo_edge(p)
        g = feat["geometry"]
        if attrs is None or g["type"] != "LineString":
            continue
        coords = np.array([c[:2] for c in g["coordinates"]], dtype=float)
        if len(coords) < 2:
            continue
        cls, m, ow, v, nw = attrs
        out.append({"coords": coords, "cls": cls, "m": m, "ow": ow, "v": v, "nw": nw,
                    "kl": p.get("identifiant_voie_ban_gauche"), "kr": p.get("identifiant_voie_ban_droite"),
                    "nl": p.get("nom_voie_ban_gauche"), "nr": p.get("nom_voie_ban_droite"),
                    "ref": p.get("cpx_numero"), "src": "bdtopo", "imp": int(p.get("importance") or 5),
                    "names": {p.get("nom_collaboratif_gauche"), p.get("nom_collaboratif_droite")} - {None, ""}})
    return out, d.get("fetchedAt")


def load_osm(path):
    with open(path, encoding="utf-8") as f:
        d = json.load(f)
    ways = []
    for el in d.get("elements", []):
        if el.get("type") != "way" or "geometry" not in el:
            continue
        t = el.get("tags", {})
        hw = t.get("highway")
        if t.get("access") in ("private", "no") or t.get("foot") == "no" and hw in OSM_PATHS:
            continue
        if hw == "service" and t.get("service") in (None, "alley", "driveway"):
            # desserte (impasses privées souvent absentes de la BD TOPO) : carrossable, avec la pénalité des voies privées
            cls, m, v, nw = OSM_PATHS[hw], CAR | BIKE | FOOT | PRIVATE, 15, 0
            ow = {"yes": 1, "-1": -1}.get(t.get("oneway"), 0)
        elif hw in OSM_PATHS:
            cls = OSM_PATHS[hw]
            m = FOOT if hw == "steps" else FOOT | BIKE
            if hw == "footway" and t.get("bicycle") not in ("yes", "designated"):
                m = FOOT
            ow, v, nw = 0, 0, 0
        elif hw in OSM_ROADS:
            cls, m, v, nw = OSM_ROADS[hw], CAR | BIKE | FOOT, 30, 0
            ow = {"yes": 1, "-1": -1}.get(t.get("oneway"), 0)
        else:
            continue
        lon = [p["lon"] for p in el["geometry"]]
        lat = [p["lat"] for p in el["geometry"]]
        x, y = geo.lonlat_to_l93(lon, lat)
        ways.append({"nodes": el["nodes"], "coords": np.column_stack([x, y]), "cls": cls, "m": m, "ow": ow,
                     "v": v, "nw": nw, "name": t.get("name"), "src": "osm", "names": {t.get("name")} - {None, ""}})
    return ways, d.get("fetchedAt")


# ------------------------------------------------------------------- graphe


class Graph:
    def __init__(self):
        self.xy = []
        self.grid = {}
        self.edges = []

    def node(self, x, y):
        gx, gy = round(x / NODE_SNAP_M), round(y / NODE_SNAP_M)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for i in self.grid.get((gx + dx, gy + dy), ()):
                    if math.hypot(self.xy[i][0] - x, self.xy[i][1] - y) <= NODE_SNAP_M:
                        return i
        self.xy.append((x, y))
        self.grid.setdefault((gx, gy), []).append(len(self.xy) - 1)
        return len(self.xy) - 1

    def add(self, coords, attrs):
        coords = np.asarray(coords, dtype=float)
        a = self.node(*coords[0])
        b = self.node(*coords[-1])
        if a == b and len(coords) < 3:
            return None
        coords = coords.copy()
        coords[0], coords[-1] = self.xy[a], self.xy[b]
        self.edges.append({**attrs, "a": a, "b": b, "coords": coords})
        return len(self.edges) - 1


def _split_osm_ways(ways):
    """Coupe les voies OSM à leurs nœuds partagés (carrefours entre cheminements)."""
    use = {}
    for w in ways:
        for n in set(w["nodes"] or ()):
            use[n] = use.get(n, 0) + 1
    out = []
    for w in ways:
        if w["nodes"] is None or len(w["nodes"]) != len(w["coords"]):
            out.append(w)  # voie coupée par l'emprise : gardée d'un seul tenant
            continue
        start = 0
        for k in range(1, len(w["nodes"])):
            if k == len(w["nodes"]) - 1 or use[w["nodes"][k]] > 1:
                out.append({**w, "coords": w["coords"][start:k + 1]})
                start = k
    return out


def _split_edge(g, ei, cuts):
    """Coupe le tronçon ei aux abscisses `cuts` (m) ; renvoie {abscisse: nœud}."""
    e = g.edges[ei]
    line = LineString(e["coords"])
    length = line.length
    nodes, inner = {}, []
    for t in sorted(set(cuts)):
        if t <= 1.0:
            nodes[t] = e["a"]
        elif t >= length - 1.0:
            nodes[t] = e["b"]
        else:
            p = line.interpolate(t)
            nodes[t] = g.node(p.x, p.y)
            inner.append((t, nodes[t]))
    if not inner:
        return nodes
    bounds = [(0.0, e["a"])] + inner + [(length, e["b"])]
    for k in range(len(bounds) - 1):
        (t0, a), (t1, b) = bounds[k], bounds[k + 1]
        if t1 - t0 < 0.05:
            continue
        coords = np.array(substring(line, t0, t1).coords)
        coords[0], coords[-1] = g.xy[a], g.xy[b]
        piece = {**e, "a": a, "b": b, "coords": coords}
        if k == 0:
            g.edges[ei] = piece
        else:
            g.edges.append(piece)
    return nodes


def _clip(items, box):
    """Découpe les lignes à l'emprise (Overpass renvoie les voies entières qui la traversent)."""
    out = []
    for it in items:
        ln = LineString(it["coords"])
        if box.contains(ln):
            out.append(it)
            continue
        for part in geo._parts(ln.intersection(box)):
            for piece in (part.geoms if hasattr(part, "geoms") else [part]):
                if piece.geom_type == "LineString" and piece.length >= 1:
                    # nœuds OSM conservés aux extrémités seulement : la coupe crée des bouts libres
                    out.append({**it, "coords": np.array(piece.coords), "nodes": None})
    return out


def build_graph(bd, osm, box, far_box, log):
    near = _clip(bd, box)
    rest = []
    for e in bd:  # au-delà de l'emprise proche : routes principales carrossables seulement
        if e["imp"] <= config.ROADS_FAR_MAX_IMPORTANCE and e["m"] & CAR:
            ln = LineString(e["coords"]).difference(box)
            for part in geo._parts(ln):
                for piece in (part.geoms if hasattr(part, "geoms") else [part]):
                    if piece.geom_type == "LineString" and piece.length >= 1:
                        rest.append({**e, "coords": np.array(piece.coords)})
    bd = near + _clip(rest, far_box)
    osm = _clip(osm, box)
    g = Graph()
    for e in bd:
        g.add(e["coords"], {k: v for k, v in e.items() if k != "coords"})
    n_bd = len(g.edges)
    bd_lines = np.array([LineString(e["coords"]) for e in g.edges], dtype=object)
    cover = shapely.union_all(shapely.buffer(bd_lines, OSM_OVERLAP_M))
    tree = STRtree(bd_lines)

    pieces = []
    for w in _split_osm_ways(osm):
        if len(w["coords"]) < 2:
            continue
        rest = LineString(w["coords"]).difference(cover)
        for part in geo._parts(rest):
            for ln in (part.geoms if hasattr(part, "geoms") else [part]):
                if ln.geom_type == "LineString" and ln.length >= OSM_MIN_PIECE_M:
                    pieces.append((np.array(ln.coords), w))
    # raccordements : bout d'un cheminement près d'un tronçon BD TOPO -> coupe du tronçon au point le plus proche
    cuts = {}
    links = []
    for k, (coords, w) in enumerate(pieces):
        for end in (0, -1):
            pt = Point(coords[end])
            near = tree.query(pt, predicate="dwithin", distance=OSM_CONNECT_M)
            if not len(near):
                continue
            ei = min(near, key=lambda i: bd_lines[i].distance(pt))
            if bd_lines[ei].distance(pt) < 0.05:
                continue
            t = round(bd_lines[ei].project(pt), 2)
            cuts.setdefault(int(ei), []).append(t)
            links.append((k, end, int(ei), t))
    at = {ei: _split_edge(g, ei, ts) for ei, ts in cuts.items()}
    n_osm = 0
    for coords, w in pieces:
        if g.add(coords, {k: v for k, v in w.items() if k not in ("coords", "nodes")}) is not None:
            n_osm += 1
    for k, end, ei, t in links:
        n = at[ei][t]
        p = pieces[k][0][end]
        if math.hypot(g.xy[n][0] - p[0], g.xy[n][1] - p[1]) > NODE_SNAP_M:
            w = pieces[k][1]
            g.add([g.xy[n], p], {"cls": w["cls"], "m": w["m"], "ow": 0, "v": w["v"], "nw": 0,
                                 "name": None, "src": "osm"})
    for e in g.edges:
        ln = LineString(e["coords"]).simplify(SIMPLIFY_M)
        e["coords"] = np.array(ln.coords)
        e["coords"][0], e["coords"][-1] = g.xy[e["a"]], g.xy[e["b"]]
        e["len"] = float(LineString(e["coords"]).length)
    g.edges = [e for e in g.edges if e["len"] > 0.05]
    log(f"Réseau : {len(g.xy)} nœuds, {len(g.edges)} tronçons ({n_bd} BD TOPO avant coupes, {n_osm} cheminements OSM, "
        f"{len(links)} raccordements) ; {sum(e['len'] for e in g.edges) / 1000:.1f} km")
    return g


def car_components(g):
    """Composante fortement connexe de chaque nœud pour la voiture (sens uniques respectés)."""
    rows, cols = [], []
    for e in g.edges:
        if not e["m"] & CAR:
            continue
        if e["ow"] >= 0:
            rows.append(e["a"]); cols.append(e["b"])
        if e["ow"] <= 0:
            rows.append(e["b"]); cols.append(e["a"])
    n = len(g.xy)
    mat = csr_matrix((np.ones(len(rows)), (rows, cols)), shape=(n, n))
    _, labels = connected_components(mat, directed=True, connection="strong")
    sizes = np.bincount(labels)
    return labels, int(np.argmax(sizes))


# ------------------------------------------------------------- rattachement


def _side(line, t, p):
    """+1 si p est à droite du sens de saisie du tronçon au point d'abscisse t, -1 à gauche (y vers le nord)."""
    a = line.interpolate(max(0.0, t - 0.5))
    b = line.interpolate(min(line.length, t + 0.5))
    q = line.interpolate(t)
    cross = (b.x - a.x) * (p.y - q.y) - (b.y - a.y) * (p.x - q.x)
    return 1 if cross < 0 else -1


def snap_addresses(g, addrs, parcels_by_id, log):
    """addrs : [{id, key, X, Y, cad: [ids]}] -> {id: snap}, statistiques."""
    lines = [LineString(e["coords"]) for e in g.edges]
    tree = STRtree(lines)
    by_key, by_name = {}, {}
    for i, e in enumerate(g.edges):
        for k in {e.get("kl"), e.get("kr")} - {None}:
            by_key.setdefault(k, []).append(i)
        for nm in e.get("names") or ():
            by_name.setdefault(name_key(nm), []).append(i)
    car_lines = [i for i, e in enumerate(g.edges) if e["m"] & CAR]
    car_tree = STRtree([lines[i] for i in car_lines])
    labels, main = car_components(g)

    out, stats = {}, {"cle": 0, "nom": 0, "sansnom": 0, "repli": 0, "facade": 0, "sentier": 0, "hors": {}}
    votes = {}
    for a in addrs:
        pt = Point(a["X"], a["Y"])
        # tronçon de la voie trop loin (résidence numérotée sur une voie dont l'accès manque) : pas retenu
        cand = [i for i in by_key.get(a["key"], []) if lines[i].distance(pt) < SAME_STREET_MAX_M]
        level = "cle"
        if not cand:
            # voie sans identifiant BAN dans la BD TOPO : par le nom, à moins de 150 m
            cand = [i for i in by_name.get(name_key(a["street"]), []) if lines[i].distance(pt) < SAME_STREET_MAX_M]
            level = "nom"
        # point de remise : limite de la parcelle la plus proche de la voie
        polys = [parcels_by_id[c] for c in a["cad"] if c in parcels_by_id]
        par = shapely.union_all(polys) if polys else None
        if par is not None and par.area > FRONTAGE_MAX_PARCEL_M2:
            par = None

        def nearest(p, among):
            return min(among, key=lambda i: lines[i].distance(p))

        if cand:
            ei = nearest(pt, cand)
            stats[level] += 1
        else:
            near = tree.query(pt, predicate="dwithin", distance=80)
            road = [i for i in near if g.edges[i]["m"] & CAR]
            # impasse privée sans nom dans les sources : tronçon carrossable sans nom le plus proche
            unnamed = [i for i in road if lines[i].distance(pt) < UNNAMED_MAX_M and not g.edges[i].get("kl")
                       and not g.edges[i].get("kr") and not g.edges[i].get("names")]
            if unnamed:
                ei = nearest(pt, unnamed)
                stats["sansnom"] += 1
                votes.setdefault(ei, []).append(a)
            else:
                ei = nearest(pt, road or near.tolist() or range(len(lines)))
                stats["repli"] += 1
                stats["hors"][a["street"]] = stats["hors"].get(a["street"], 0) + 1
        dp = pt
        if par is not None:
            # au droit de l'adresse : la limite de parcelle la plus proche de sa projection sur la voie (et non du
            # tronçon entier, qui peut longer une grande parcelle de copropriété loin de l'entrée)
            q0 = lines[ei].interpolate(lines[ei].project(pt))
            dp = nearest_points(par.boundary, q0)[0]
            stats["facade"] += 1
            if cand:
                ei = nearest(dp, cand)
        line = lines[ei]
        t = line.project(dp)
        q = line.interpolate(t)
        off = q.distance(dp)
        e = g.edges[ei]
        sd = _side(line, t, dp if off > 0.5 else pt)
        # voie bordée par deux rues différentes : le côté de la bonne rue l'emporte
        if cand and e.get("kl") != e.get("kr"):
            sd = -1 if e.get("kl") == a["key"] else 1
        snap = [ei, round(t, 1), sd, round(off, 1), dp.x, dp.y]
        # adresse sur un tronçon non carrossable ou hors de la composante principale : accès voiture le plus proche
        if not (e["m"] & CAR) or labels[e["a"]] != main or labels[e["b"]] != main:
            near = car_tree.query(dp, predicate="dwithin", distance=CAR_ACCESS_MAX_M)
            ok = [car_lines[i] for i in near
                  if labels[g.edges[car_lines[i]]["a"]] == main and labels[g.edges[car_lines[i]]["b"]] == main]
            if not ok:
                raise RoadsError(f"{a['label']} : aucune route carrossable à moins de {CAR_ACCESS_MAX_M} m")
            ci = nearest(dp, ok)
            ct = lines[ci].project(dp)
            snap += [ci, round(ct, 1), round(lines[ci].interpolate(ct).distance(dp), 1)]
            stats["sentier"] += 1
        out[a["id"]] = snap
    # un tronçon sans nom qui dessert les adresses d'une voie prend son identifiant (consignes, tissage par rue)
    for ei, voters in votes.items():
        keys = [v["key"] for v in voters]
        k = max(set(keys), key=keys.count)
        g.edges[ei]["kl"] = g.edges[ei]["kr"] = k
    return out, stats


# ------------------------------------------------------------------ sortie


def _fmt(v):
    s = f"{v:.1f}"
    s = s[:-2] if s.endswith(".0") else s
    return "0" if s == "-0" else s


def build(addrs, parcels_by_id, x0, y1, W, H, street_of_key, names, log, preview=False):
    """Construit docs/data/roads.json. `addrs` : [{id, key, X, Y, cad, label}]."""
    bd_path = config.SOURCES_DIR / config.ROADS_BDTOPO
    osm_path = config.SOURCES_DIR / config.ROADS_OSM
    bd, bd_at = load_bdtopo(bd_path)
    osm, osm_at = load_osm(osm_path)
    log(f"Réseau routier : {len(bd)} tronçons BD TOPO ({bd_at}), {len(osm)} voies OSM ({osm_at})")
    m, fm = config.ROADS_MARGIN_M, config.ROADS_FAR_MARGIN_M
    g = build_graph(bd, osm, shapely.box(x0 - m, y1 - H - m, x0 + W + m, y1 + m),
                    shapely.box(x0 - fm, y1 - H - fm, x0 + W + fm, y1 + fm), log)
    labels, main = car_components(g)
    in_main = sum(labels[e["a"]] == main and labels[e["b"]] == main for e in g.edges if e["m"] & CAR)
    log(f"  voiture : {in_main} / {sum(1 for e in g.edges if e['m'] & CAR)} tronçons dans la composante principale ; "
        f"sens uniques : {sum(1 for e in g.edges if e['ow'])} ; voies privées : {sum(1 for e in g.edges if e['m'] & PRIVATE)} ; "
        f"tissage déconseillé : {sum(e['nw'] for e in g.edges)}")

    snap, st = snap_addresses(g, addrs, parcels_by_id, log)
    n = len(addrs)
    offs = np.array([s[3] for s in snap.values()])
    named = st["cle"] + st["nom"] + st["sansnom"]
    log(f"Rattachement : {n} adresses ; par l'identifiant BAN {st['cle']}, par le nom {st['nom']}, "
        f"à une voie sans nom {st['sansnom']} ({named / n:.1%}), à une autre voie {st['repli']} ; "
        f"point de remise sur la façade {st['facade']} ; sur un chemin non carrossable {st['sentier']}")
    log(f"  distance route - point de remise : médiane {np.median(offs):.1f} m, > 30 m : {int((offs > 30).sum())}, "
        f"max {offs.max():.0f} m")
    if st["hors"]:
        log(f"  voies absentes du réseau (rattachées au tronçon carrossable le plus proche) : "
            + ", ".join(f"{k} ({v})" for k, v in sorted(st["hors"].items(), key=lambda kv: -kv[1])))
    if len(snap) != n:
        raise RoadsError("adresses non rattachées")
    if named / n < MIN_NAME_MATCH:
        raise RoadsError(f"seulement {named / n:.1%} des adresses rattachées à un tronçon de leur voie "
                         f"(minimum {MIN_NAME_MATCH:.0%})")

    # noms affichés dans les consignes : la voie BAN de la commune, sinon le nom BAN ou le numéro de route
    name_ix = {}

    def name_of(e):
        for k in (e.get("kr"), e.get("kl")):
            if k in street_of_key:
                return names[street_of_key[k]]
        nm = e.get("nr") or e.get("nl") or e.get("name") or e.get("ref") or ""
        return nm

    def nid(nm):
        if not nm:
            return -1
        return name_ix.setdefault(nm, len(name_ix))

    def street(e):
        for k in (e.get("kr"), e.get("kl")):
            if k in street_of_key:
                return street_of_key[k]
        return -1

    nodes = []
    for x, y in g.xy:
        nodes += [_fmt(x - x0), _fmt(y1 - y)]
    edges = []
    for e in g.edges:
        mid = [_fmt(v) for x, y in e["coords"][1:-1] for v in (x - x0, y1 - y)]
        edges.append("[" + ",".join([str(e["a"]), str(e["b"]), _fmt(e["len"]), str(e["m"]), str(e["ow"]),
                                     str(e["v"]), str(street(e)), str(nid(name_of(e))), str(e["nw"]), str(e["cls"]),
                                     "[" + ",".join(mid) + "]"]) + "]")
    snap_out = {}
    for a in addrs:
        s = snap[a["id"]]
        row = [int(s[0]), float(s[1]), int(s[2]), float(s[3]), float(_fmt(s[4] - x0)), float(_fmt(y1 - s[5]))]
        if len(s) > 6:
            row += [int(s[6]), float(s[7]), float(s[8])]
        snap_out[a["id"]] = row
    # sens de saisie : y vers le nord en Lambert-93, vers le bas dans l'app ; le côté (droite/gauche dans le
    # sens a -> b) ne dépend pas du repère, il est calculé en Lambert-93
    meta = {
        "attribution": "Réseau routier : IGN BD TOPO (Licence Ouverte) ; © contributeurs OpenStreetMap (ODbL)",
        "fetched": {"bdtopo": bd_at, "osm": osm_at},
        "classes": CLASSES,
        "names": list(name_ix),
    }
    j = lambda o: json.dumps(o, ensure_ascii=False, separators=(",", ":"))
    body = (j(meta)[1:-1] + ',\n"nodes":[' + ",".join(nodes) + '],\n"edges":[\n' + ",\n".join(edges)
            + '],\n"snap":{\n' + ",\n".join(f"{j(k)}:{j(v)}" for k, v in snap_out.items()) + "}}\n")
    version = hashlib.sha256(body.encode("utf-8")).hexdigest()[:8]
    text = '{"version":' + j(version) + ",\n" + body
    path = config.DATA_DIR / "roads.json"
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    log(f"Sortie : roads.json {len(text.encode()) / 1024:.0f} Ko ; version du réseau {version}")
    if len(text.encode()) > 1_500_000:
        raise RoadsError("roads.json dépasse 1,5 Mo")
    if preview:
        render_preview(g, snap, addrs, (x0, y1, W, H), log)
    return version


def render_preview(g, snap, addrs, frame, log, width=3000):
    """work/roads-preview.png sur le cadre des données : voiture en gris (rouge = sens unique, violet = voie privée,
    trait épais = tissage déconseillé), pied et vélo en vert (bleu = OSM) ; adresse -> point de remise -> route,
    en orange côté droit du sens de saisie, en vert côté gauche."""
    from PIL import Image, ImageDraw

    minx, maxy, W, H = frame
    k = width / W
    img = Image.new("RGB", (width, int(H * k)), "#ffffff")
    d = ImageDraw.Draw(img)
    P = lambda x, y: ((x - minx) * k, (maxy - y) * k)
    for e in g.edges:
        if e["m"] & CAR:
            col = "#c0392b" if e["ow"] else ("#8e44ad" if e["m"] & PRIVATE else "#333333")
            wdt = 3 if e["nw"] else 2
        else:
            col, wdt = ("#2e86de" if e.get("src") == "osm" else "#27ae60"), 1
        d.line([P(x, y) for x, y in e["coords"]], fill=col, width=wdt)
    lines = [LineString(e["coords"]) for e in g.edges]
    for a in addrs:
        s = snap[a["id"]]
        q = lines[s[0]].interpolate(s[1])
        col = "#e67e22" if s[2] > 0 else "#16a085"
        d.line([P(a["X"], a["Y"]), P(s[4], s[5]), P(q.x, q.y)], fill=col, width=1)
        x, y = P(s[4], s[5])
        d.ellipse([x - 2, y - 2, x + 2, y + 2], fill=col)
    out = config.WORK_DIR / "roads-preview.png"
    img.save(out)
    log(f"Aperçu du réseau : {out}")
