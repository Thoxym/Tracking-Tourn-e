"""Traitements géographiques : extraction des sources, projection, association
adresse -> bâtiment, tracés des rues, étiquettes et paths SVG."""

import csv
import gzip
import json
import math
import re
import time

import numpy as np
import shapely
from pyproj import Transformer
from scipy.sparse import csr_matrix
from scipy.sparse.csgraph import minimum_spanning_tree, shortest_path
from scipy.spatial.distance import cdist
from shapely.geometry import MultiLineString, shape
from shapely.ops import nearest_points
from shapely.strtree import STRtree

import config

# ---------------------------------------------------------------- sources

KINDS = ("addresses", "buildings", "parcels")


def _kind_of(name):
    n = name.lower()
    if n.startswith("adresses") and "csv" in n:
        return "addresses"
    if "batiments" in n and "json" in n:
        return "buildings"
    if "parcelles" in n and "json" in n:
        return "parcels"
    return None


def find_sources(src_dir=config.SOURCES_DIR, insees=tuple(config.INSEES)):
    """Repère les fichiers sources par motif. Une seule commune : préfère sa version commune (plus petite) ;
    plusieurs : version département, qui seule les contient toutes."""
    found = {k: [] for k in KINDS}
    if src_dir.is_dir():
        for p in sorted(src_dir.iterdir()):
            kind = _kind_of(p.name) if p.is_file() else None
            if kind:
                found[kind].append(p)
    missing = [k for k in KINDS if not found[k]]
    if missing:
        raise FileNotFoundError(f"sources manquantes dans {src_dir} : {', '.join(missing)}")
    if len(insees) == 1:
        return {k: sorted(v, key=lambda p: (insees[0] not in p.name, p.name))[0] for k, v in found.items()}
    out = {}
    for k, v in found.items():
        dept = [p for p in v if not re.search(r"\d{5}", p.name)]
        if not dept:
            raise FileNotFoundError(f"{k} : il faut la version département pour {len(insees)} communes")
        out[k] = sorted(dept, key=lambda p: p.name)[0]
    return out


def _open_text(path):
    if path.name.lower().endswith("gz"):
        return gzip.open(path, "rt", encoding="utf-8", newline="")
    return open(path, "r", encoding="utf-8", newline="")


def _filter_csv(src, dst, insees):
    n = 0
    needles = [f";{i};" for i in insees]
    with _open_text(src) as fin, open(dst, "w", encoding="utf-8", newline="\n") as fout:
        header = fin.readline()
        col = header.rstrip("\r\n").split(";").index("code_insee")
        fout.write(header.rstrip("\r\n") + "\n")
        for line in fin:
            if any(nd in line for nd in needles) and line.split(";")[col] in insees:
                fout.write(line.rstrip("\r\n") + "\n")
                n += 1
    return n


def _filter_features(src, dst, insees):
    n = 0
    needles = [f'"commune":"{i}"' for i in insees] + [f'"commune": "{i}"' for i in insees]
    with _open_text(src) as fin, open(dst, "w", encoding="utf-8", newline="\n") as fout:
        for line in fin:
            if any(nd in line for nd in needles):
                fout.write(line.strip().rstrip(",") + "\n")
                n += 1
    return n


def extract(sources, work_dir=config.WORK_DIR, insees=tuple(config.INSEES), force=False, log=print):
    """Filtre les sources sur les communes, avec un cache dans work/ invalidé si la source ou les communes changent."""
    work_dir.mkdir(parents=True, exist_ok=True)
    meta_path = work_dir / "extract-meta.json"
    meta = json.loads(meta_path.read_text("utf-8")) if meta_path.exists() else {}
    targets = {"addresses": "adresses.csv", "buildings": "bat.jsonl", "parcels": "par.jsonl"}
    out = {}
    for kind, fname in targets.items():
        src, dst = sources[kind], work_dir / fname
        st = src.stat()
        sig = {"source": src.name, "size": st.st_size, "mtime": int(st.st_mtime), "insee": ",".join(insees)}
        cached = meta.get(kind, {})
        if not force and dst.exists() and {k: cached.get(k) for k in sig} == sig:
            log(f"  {kind:<9} cache   {dst.name} ({cached['count']} lignes)")
        else:
            t = time.perf_counter()
            fn = _filter_csv if kind == "addresses" else _filter_features
            count = fn(src, dst, set(insees))
            meta[kind] = {**sig, "count": count}
            log(f"  {kind:<9} extrait {dst.name} ({count} lignes, {time.perf_counter() - t:.0f} s)")
        out[kind] = dst
    meta_path.write_text(json.dumps(meta, indent=1), "utf-8")
    return out


def read_addresses(path):
    with open(path, "r", encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f, delimiter=";"))


def read_features(path):
    """Renvoie (géométries WGS84, propriétés) d'un fichier une-feature-par-ligne."""
    geoms, props = [], []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            feat = json.loads(line)
            p = dict(feat.get("properties") or {})
            if feat.get("id") and "id" not in p:
                p["id"] = feat["id"]
            geoms.append(shape(feat["geometry"]))
            props.append(p)
    return np.array(geoms, dtype=object), props


# ------------------------------------------------------------- projection

_T = Transformer.from_crs(4326, 2154, always_xy=True)


def to_l93(geoms):
    def proj(c):
        x, y = _T.transform(c[:, 0], c[:, 1])
        return np.column_stack([x, y])

    out = shapely.transform(geoms, proj)
    bad = ~shapely.is_valid(out)
    if bad.any():
        out[bad] = [_polygonal(g) for g in shapely.make_valid(out[bad])]
    return out


def lonlat_to_l93(lon, lat):
    return _T.transform(np.asarray(lon), np.asarray(lat))


def _polygonal(g):
    if g.geom_type in ("Polygon", "MultiPolygon"):
        return g
    parts = [p for p in getattr(g, "geoms", []) if p.geom_type in ("Polygon", "MultiPolygon")]
    return shapely.union_all(parts) if parts else shapely.Polygon()


def fit_affine(lon, lat, x, y):
    """Moindres carrés x = a·lon + b·lat + c + p·u² + q·u·v + r·v², de même pour y, avec u = lon - lon0,
    v = lat - lat0 (centre des adresses). Le terme du second degré corrige la courbure de la projection :
    sur les 7,5 km des trois communes, l'affine seule s'écarte de 1,2 m, contre 0,1 mm ainsi.

    Renvoie le dictionnaire `affine` de addresses.json ({x: [a, b, c], y: [d, e, f], o: [lon0, lat0],
    qx: [p, q, r], qy: [...]}) et les résidus, évalués sous cette forme comme en JS (gps.js)."""
    lon, lat, x, y = (np.asarray(v, dtype=float) for v in (lon, lat, x, y))
    lon0, lat0 = float(lon.mean()), float(lat.mean())
    u, v = lon - lon0, lat - lat0
    A = np.column_stack([u, v, np.ones_like(u), u * u, u * v, v * v])
    (a, b, c0, *qx), *_ = np.linalg.lstsq(A, x, rcond=None)
    (d, e, f0, *qy), *_ = np.linalg.lstsq(A, y, rcond=None)
    aff = {"x": [float(a), float(b), float(c0 - a * lon0 - b * lat0)],
           "y": [float(d), float(e), float(f0 - d * lon0 - e * lat0)],
           "o": [lon0, lat0], "qx": [float(k) for k in qx], "qy": [float(k) for k in qy]}
    px, py = apply_affine(aff, lon, lat)
    return aff, np.hypot(px - x, py - y)


def apply_affine(aff, lon, lat):
    (a, b, c), (d, e, f) = aff["x"], aff["y"]
    u, v = lon - aff["o"][0], lat - aff["o"][1]
    (p, q, r), (s, t, w) = aff["qx"], aff["qy"]
    return (a * lon + b * lat + c + p * u * u + q * u * v + r * v * v,
            d * lon + e * lat + f + s * u * u + t * u * v + w * v * v)


# ------------------------------------------------- association adresse-bâtiment


def infer_parcels(points, cads, types, parcel_geoms, parcel_ids):
    """Parcelles des adresses sans `cad_parcelles` (la plupart à Beynost et Saint-Maurice-de-Beynost) : celle qui
    contient le point, sinon celles à moins de ASSOC_PARCEL_SNAP_M (point d'entrée posé au portail, juste hors de
    la parcelle ; à un angle, toutes celles à 1,5 m près de la plus proche). Pas pour les positions « segment »,
    posées sur l'axe de la rue, sans côté connu. Renvoie (listes d'ids, nombre de parcelles déduites)."""
    tree = STRtree(parcel_geoms)
    out, n = [], 0
    for pt, cad, typ in zip(points, cads, types):
        if cad or typ == "segment":
            out.append(cad)
            continue
        idx, dist = tree.query_nearest(pt, return_distance=True, max_distance=config.ASSOC_PARCEL_SNAP_M)
        if not len(idx):
            out.append([])
            continue
        near = tree.query(pt, predicate="dwithin", distance=float(dist.min()) + config.ASSOC_PARCEL_TIE_M)
        got = [parcel_ids[i] for i in (idx if dist.min() == 0 else near) if parcel_ids[i]]
        out.append(got)
        n += bool(got)
    return out, n


def associate(points, cads, parcels_by_id, bld_geoms, bld_types):
    """Pour chaque adresse : (index du bâtiment ou None, méthode)."""
    tree = STRtree(bld_geoms)
    areas = shapely.area(bld_geoms)
    out = []
    for pt, cad in zip(points, cads):
        cand, method = [], "parcelle"
        polys = [parcels_by_id[c] for c in cad if c in parcels_by_id]
        if polys:
            par = shapely.union_all(polys)
            for i in tree.query(par, predicate="intersects"):
                if areas[i] > 0 and par.intersection(bld_geoms[i]).area / areas[i] > config.ASSOC_MIN_SHARE:
                    cand.append(i)
        if not cand:
            method = "proximite"
            near = tree.query(pt, predicate="dwithin", distance=config.ASSOC_FALLBACK_SEARCH_M)
            cand = [i for i in near if bld_geoms[i].distance(pt) <= config.ASSOC_FALLBACK_MAX_M]
        if not cand:
            out.append((None, "aucun"))
            continue
        dist = {i: bld_geoms[i].distance(pt) for i in cand}
        best = min(dist.values())
        hard = [i for i in cand if bld_types[i] == config.ASSOC_HARD_TYPE
                and dist[i] <= best + config.ASSOC_HARD_TOLERANCE_M]
        out.append((min(hard or cand, key=dist.get), method))
    return out


def unaddressed_buildings(bld_geoms, bld_types, linked, parcel_geoms, parcel_ids, addressed, addr_points,
                          street_points=None):
    """Bâtiments qui pourraient porter une adresse absente de la BAN : bâti dur d'au moins
    UNADDRESSED_MIN_AREA_M2, lié à aucune adresse, sur une parcelle qu'aucune adresse ne cite
    (`addressed` : ids de parcelles de toutes les adresses de la commune) et loin de tout point d'adresse.
    `street_points` : adresses posées sur l'axe de la rue (« segment »), sans parcelle connue ; un bâtiment à moins
    de UNADDRESSED_SEGMENT_DIST_M de l'une d'elles est sans doute le sien. Renvoie les index des bâtiments retenus."""
    areas = shapely.area(bld_geoms)
    cand = [k for k in range(len(bld_geoms)) if k not in linked and bld_types[k] == config.ASSOC_HARD_TYPE
            and areas[k] >= config.UNADDRESSED_MIN_AREA_M2]
    if not cand:
        return []
    reps = shapely.point_on_surface(bld_geoms[cand])
    b_idx, p_idx = STRtree(parcel_geoms).query(reps, predicate="within")
    parcel_of = {cand[b]: parcel_ids[p] for b, p in zip(b_idx.tolist(), p_idx.tolist())}
    near = STRtree(addr_points)
    loose = STRtree(street_points) if street_points is not None and len(street_points) else None
    out = []
    for k in cand:
        pid = parcel_of.get(k)
        if pid is None or pid in addressed:  # hors parcelle de la commune, ou parcelle déjà adressée
            continue
        if len(near.query(bld_geoms[k], predicate="dwithin", distance=config.UNADDRESSED_MIN_DIST_M)):
            continue
        if loose is not None and len(loose.query(bld_geoms[k], predicate="dwithin",
                                                  distance=config.UNADDRESSED_SEGMENT_DIST_M)):
            continue
        out.append(k)
    return out


# ------------------------------------------------------------ tracés des rues


def _parts(g):
    if g.is_empty:
        return []
    return list(g.geoms) if hasattr(g, "geoms") else [g]


def mst_edges(pts):
    n = len(pts)
    if n < 2:
        return []
    d = cdist(pts, pts) + 1e-3  # points confondus (6 et 6 b) : une distance nulle serait une arête absente
    np.fill_diagonal(d, 0)
    m = minimum_spanning_tree(d).tocoo()
    return list(zip(m.row.tolist(), m.col.tolist()))


def mst_length(pts):
    """Longueur de l'arbre couvrant des points d'adresse (m) : approximation de la longueur de la voie."""
    return float(sum(np.hypot(*(pts[i] - pts[j])) for i, j in mst_edges(pts)))


def neighbor_colors(geoms, n_colors, dist):
    """Couleur (index de palette) par géométrie, différente de celle de ses voisines à moins de `dist`.
    Glouton du plus connecté au moins connecté ; parmi les couleurs libres, la moins utilisée."""
    tree = shapely.STRtree(geoms)
    left, right = tree.query(geoms, predicate="dwithin", distance=dist)
    nbrs = [set() for _ in geoms]
    for a, b in zip(left.tolist(), right.tolist()):
        if a != b:
            nbrs[a].add(b)
            nbrs[b].add(a)
    color = [None] * len(geoms)
    used = [0] * n_colors
    for i in sorted(range(len(geoms)), key=lambda k: (-len(nbrs[k]), k)):
        taken = {color[j] for j in nbrs[i] if color[j] is not None}
        free = [c for c in range(n_colors) if c not in taken] or list(range(n_colors))
        color[i] = min(free, key=lambda c: (used[c], c))
        used[color[i]] += 1
    conflicts = sum(color[a] == color[b] for a in range(len(geoms)) for b in nbrs[a] if a < b)
    return color, max((len(s) for s in nbrs), default=0), conflicts


def uncadastred_domain(parcels, area_box):
    """Domaine non cadastré (voirie) dans la commune : fermeture morphologique des parcelles,
    pour ne pas prendre l'extérieur de la commune (non chargé) pour de la voirie."""
    union = shapely.union_all(shapely.buffer(parcels, config.TRACE_PARCEL_BUFFER_M))
    commune = union.buffer(config.TRACE_CLOSING_M).buffer(-config.TRACE_CLOSING_M)
    return commune.intersection(area_box).difference(union)


def commune_limits(parcels, parcel_communes, insees, frame_box):
    """Limites des communes, à partir de leurs parcelles (fermeture morphologique, comme le domaine non cadastré).
    Renvoie (lignes dans le cadre, régions dans l'ordre de `insees`). Une limite commune à deux communes n'est
    tracée qu'une fois : la seconde commune n'ajoute que ce qui est à plus de LIMIT_DEDUP_M des communes déjà
    tracées. Les bords du cadre ne sont pas des limites."""
    regions, lines = [], []
    edge = frame_box.exterior.buffer(config.LIMIT_DEDUP_M)
    for insee in insees:
        mine = [g for g, c in zip(parcels, parcel_communes) if c == insee]
        reg = shapely.Polygon()
        if mine:
            union = shapely.union_all(shapely.buffer(mine, config.TRACE_PARCEL_BUFFER_M))
            closed = union.buffer(config.TRACE_CLOSING_M).buffer(-config.TRACE_CLOSING_M).intersection(frame_box)
            big = [p for p in _parts(closed) if p.geom_type == "Polygon" and p.area >= config.LIMIT_MIN_AREA_M2]
            # trous de moins de LIMIT_MIN_AREA_M2 (étangs, voirie large) : pas des limites
            reg = shapely.union_all([shapely.Polygon(p.exterior, [h for h in p.interiors
                                                                  if shapely.Polygon(h).area >= config.LIMIT_MIN_AREA_M2])
                                     for p in big]) if big else reg
        line = reg.boundary.simplify(config.LIMIT_SIMPLIFY_M).difference(edge)
        for other in regions:
            if not other.is_empty:
                line = line.difference(other.buffer(config.LIMIT_DEDUP_M))
        regions.append(reg)
        lines.append(line)
    out = shapely.union_all([ln for ln in lines if not ln.is_empty])
    out = shapely.MultiLineString([p for p in _parts(shapely.line_merge(out) if out.geom_type == "MultiLineString" else out)
                                   if p.geom_type == "LineString" and p.length >= config.LIMIT_MIN_LENGTH_M])
    return out, regions


def commune_label(region, pts, x0, y1):
    """Position du nom de la commune : le point d'adresse le plus proche du centre des adresses."""
    if not len(pts):
        return []
    c = np.median(pts, axis=0)
    p = pts[np.argmin(np.hypot(*(pts - c).T))]
    return [{"x": round(float(p[0]) - x0, 1), "y": round(y1 - float(p[1]), 1)}]


def street_trace(pts, gaps, fallback=False):
    """Renvoie (géométrie du tracé, mode utilisé)."""
    edges = mst_edges(pts)
    lines = MultiLineString([[pts[i], pts[j]] for i, j in edges]) if edges else None
    points = shapely.multipoints(pts)

    def around(r):
        return lines.buffer(r) if lines else points.buffer(r)

    if fallback:
        return around(config.TRACE_MST_FALLBACK_M).simplify(config.TRACE_SIMPLIFY_M), "mst"
    corr = shapely.union_all(shapely.buffer(shapely.points(pts), config.TRACE_POINT_RADIUS_M))
    if lines:
        corr = corr.union(lines.buffer(config.TRACE_CORRIDOR_M))
    pieces = [g for g in _parts(gaps.intersection(corr))
              if g.area > config.TRACE_MIN_PIECE_M2 and g.distance(points) < config.TRACE_MAX_PIECE_DIST_M]
    trace = shapely.union_all(pieces) if pieces else shapely.Polygon()
    mode = "domaine"
    if trace.area < config.TRACE_MIN_AREA_M2:
        trace = trace.union(around(config.TRACE_PRIVATE_BUFFER_M))
        mode = "domaine+prive"
    return trace.simplify(config.TRACE_SIMPLIFY_M), mode


# --------------------------------------------------------------- étiquettes


def street_axis(pts):
    """Plus long chemin de l'arbre couvrant : une polyligne qui suit la rue."""
    n = len(pts)
    if n < 2:
        return None
    edges = mst_edges(pts)
    i, j = zip(*edges)
    w = [float(np.hypot(*(pts[a] - pts[b]))) + 1e-3 for a, b in edges]
    g = csr_matrix((w, (i, j)), shape=(n, n))
    d0 = shortest_path(g, directed=False, indices=0)
    u = int(np.argmax(d0))
    du, pred = shortest_path(g, directed=False, indices=u, return_predecessors=True)
    v = int(np.argmax(du))
    path = [v]
    while path[-1] != u:
        path.append(int(pred[path[-1]]))
    return shapely.LineString(pts[path])


def street_labels(pts, trace, x0, y1):
    """Positions d'étiquettes {x, y, a} en coordonnées SVG, `a` en degrés dans (-90, 90]."""
    axis = street_axis(pts)
    if axis is None or axis.length < 1:
        c = pts.mean(axis=0)
        return [{"x": round(c[0] - x0, 1), "y": round(y1 - c[1], 1), "a": 0}]
    k = max(1, round(axis.length / config.LABEL_SPACING_M))
    # rues longues : pas d'étiquette aux extrémités (souvent un accès privé, ex. 73 bis Route de Genève)
    margin = config.LABEL_END_MARGIN if k >= 3 else 0
    out = []
    for j in range(k):
        s = axis.length * (margin + (1 - 2 * margin) * (j + 0.5) / k)
        p = axis.interpolate(s)
        a = axis.interpolate(max(0, s - config.LABEL_DIRECTION_WINDOW_M))
        b = axis.interpolate(min(axis.length, s + config.LABEL_DIRECTION_WINDOW_M))
        if not trace.is_empty and not trace.contains(p):
            q = nearest_points(trace, p)[0]
            if q.distance(p) < config.LABEL_SNAP_M:
                p = q
        ang = -math.degrees(math.atan2(b.y - a.y, b.x - a.x))  # SVG : y vers le bas
        if ang <= -90:
            ang += 180
        elif ang > 90:
            ang -= 180
        out.append({"x": round(p.x - x0, 1), "y": round(y1 - p.y, 1), "a": round(ang)})
    return out


# ------------------------------------------------------------------ paths SVG


def _fmt(v):
    s = f"{v:.1f}"
    if s.endswith(".0"):
        s = s[:-2]
    return "0" if s == "-0" else s


def _ring(coords, x0, y1):
    pts = []
    for x, y in coords[:-1]:
        p = f"{_fmt(x - x0)} {_fmt(y1 - y)}"
        if not pts or pts[-1] != p:
            pts.append(p)
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    if len(pts) < 3:
        return ""
    return "M" + pts[0] + "L" + " ".join(pts[1:]) + "Z"


def tiled_paths(geoms, x0, y1, size):
    """Paths SVG regroupés par tuile carrée de `size` m (selon le centre de chaque géométrie), pour que l'app ne
    dessine que les tuiles à l'écran. Renvoie [{b: [xmin, ymin, xmax, ymax] en coordonnées SVG, d}], `b` couvrant
    toutes les géométries de la tuile (une grande parcelle déborde de sa tuile)."""
    tiles = {}
    for g in geoms:
        if g.is_empty:
            continue
        minx, miny, maxx, maxy = g.bounds
        key = (int((minx + maxx) / 2 - x0) // size, int(y1 - (miny + maxy) / 2) // size)
        t = tiles.setdefault(key, {"b": [math.inf, math.inf, -math.inf, -math.inf], "d": []})
        t["b"] = [min(t["b"][0], minx - x0), min(t["b"][1], y1 - maxy),
                  max(t["b"][2], maxx - x0), max(t["b"][3], y1 - miny)]
        t["d"].append(svg_path(g, x0, y1))
    return [{"b": [round(v, 1) for v in t["b"]], "d": "".join(t["d"])} for _, t in sorted(tiles.items())]


def svg_lines(geom, x0, y1):
    """Path SVG ouvert (sans Z) des lignes d'une géométrie linéaire, coordonnées au décimètre."""
    out = []
    for ln in _parts(geom):
        if ln.geom_type != "LineString":
            continue
        pts = []
        for x, y in ln.coords:
            p = f"{_fmt(x - x0)} {_fmt(y1 - y)}"
            if not pts or pts[-1] != p:
                pts.append(p)
        if len(pts) > 1:
            out.append("M" + pts[0] + "L" + " ".join(pts[1:]))
    return "".join(out)


def svg_path(geom, x0, y1):
    """Path SVG (coordonnées au décimètre, nord en haut). À remplir avec fill-rule evenodd."""
    out = []
    for poly in _parts(geom):
        if poly.geom_type == "MultiPolygon" or poly.geom_type == "GeometryCollection":
            out.append(svg_path(poly, x0, y1))
            continue
        if poly.geom_type != "Polygon":
            continue
        out.append(_ring(poly.exterior.coords, x0, y1))
        out.extend(_ring(r.coords, x0, y1) for r in poly.interiors)
    return "".join(out)
