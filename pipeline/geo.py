"""Traitements géographiques : extraction des sources, projection, association
adresse -> bâtiment, tracés des rues, étiquettes et paths SVG."""

import csv
import gzip
import json
import math
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


def find_sources(src_dir=config.SOURCES_DIR, insee=config.INSEE):
    """Repère les fichiers sources par motif ; préfère la version commune (plus petite)."""
    found = {k: [] for k in KINDS}
    if src_dir.is_dir():
        for p in sorted(src_dir.iterdir()):
            kind = _kind_of(p.name) if p.is_file() else None
            if kind:
                found[kind].append(p)
    missing = [k for k in KINDS if not found[k]]
    if missing:
        raise FileNotFoundError(f"sources manquantes dans {src_dir} : {', '.join(missing)}")
    return {k: sorted(v, key=lambda p: (insee not in p.name, p.name))[0] for k, v in found.items()}


def _open_text(path):
    if path.name.lower().endswith("gz"):
        return gzip.open(path, "rt", encoding="utf-8", newline="")
    return open(path, "r", encoding="utf-8", newline="")


def _filter_csv(src, dst, insee):
    n = 0
    needle = f";{insee};"
    with _open_text(src) as fin, open(dst, "w", encoding="utf-8", newline="\n") as fout:
        header = fin.readline()
        col = header.rstrip("\r\n").split(";").index("code_insee")
        fout.write(header.rstrip("\r\n") + "\n")
        for line in fin:
            if needle in line and line.split(";")[col] == insee:
                fout.write(line.rstrip("\r\n") + "\n")
                n += 1
    return n


def _filter_features(src, dst, insee):
    n = 0
    needles = (f'"commune":"{insee}"', f'"commune": "{insee}"')
    with _open_text(src) as fin, open(dst, "w", encoding="utf-8", newline="\n") as fout:
        for line in fin:
            if needles[0] in line or needles[1] in line:
                fout.write(line.strip().rstrip(",") + "\n")
                n += 1
    return n


def extract(sources, work_dir=config.WORK_DIR, insee=config.INSEE, force=False, log=print):
    """Filtre les sources sur la commune, avec un cache dans work/ invalidé si la source change."""
    work_dir.mkdir(parents=True, exist_ok=True)
    meta_path = work_dir / "extract-meta.json"
    meta = json.loads(meta_path.read_text("utf-8")) if meta_path.exists() else {}
    targets = {"addresses": "neyron.csv", "buildings": "bat.jsonl", "parcels": "par.jsonl"}
    out = {}
    for kind, fname in targets.items():
        src, dst = sources[kind], work_dir / fname
        st = src.stat()
        sig = {"source": src.name, "size": st.st_size, "mtime": int(st.st_mtime), "insee": insee}
        cached = meta.get(kind, {})
        if not force and dst.exists() and {k: cached.get(k) for k in sig} == sig:
            log(f"  {kind:<9} cache   {dst.name} ({cached['count']} lignes)")
        else:
            t = time.perf_counter()
            fn = _filter_csv if kind == "addresses" else _filter_features
            count = fn(src, dst, insee)
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
    """Moindres carrés x = a·lon + b·lat + c, y = d·lon + e·lat + f.

    Ajusté sur des coordonnées centrées (meilleur conditionnement), puis ramené à la forme
    non centrée utilisée par l'app ; les résidus sont évalués sous cette forme, comme en JS."""
    lon, lat, x, y = (np.asarray(v, dtype=float) for v in (lon, lat, x, y))
    lon0, lat0 = lon.mean(), lat.mean()
    A = np.column_stack([lon - lon0, lat - lat0, np.ones_like(lon)])
    (a, b, c0), *_ = np.linalg.lstsq(A, x, rcond=None)
    (d, e, f0), *_ = np.linalg.lstsq(A, y, rcond=None)
    cx = [float(a), float(b), float(c0 - a * lon0 - b * lat0)]
    cy = [float(d), float(e), float(f0 - d * lon0 - e * lat0)]
    res = np.hypot(cx[0] * lon + cx[1] * lat + cx[2] - x, cy[0] * lon + cy[1] * lat + cy[2] - y)
    return cx, cy, res


# ------------------------------------------------- association adresse-bâtiment


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


def uncadastred_domain(parcels, area_box):
    """Domaine non cadastré (voirie) dans la commune : fermeture morphologique des parcelles,
    pour ne pas prendre l'extérieur de la commune (non chargé) pour de la voirie."""
    union = shapely.union_all(shapely.buffer(parcels, config.TRACE_PARCEL_BUFFER_M))
    commune = union.buffer(config.TRACE_CLOSING_M).buffer(-config.TRACE_CLOSING_M)
    return commune.intersection(area_box).difference(union)


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
