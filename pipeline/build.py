"""Point d'entrée du pipeline.

    python pipeline/build.py                  extraction (avec cache), données, icônes manquantes, stamp
    python pipeline/build.py --stamp          recalcule seulement VERSION / PRECACHE de docs/sw.js
    python pipeline/build.py --force-extract  relit les sources même si le cache de work/ est à jour
    python pipeline/build.py --preview        écrit aussi work/preview.png (contrôle visuel)
"""

import argparse
import datetime
import hashlib
import json
import math
import re
import sys
import time

import numpy as np
import shapely

import config
import geo


class BuildError(Exception):
    pass


def log(msg=""):
    print(msg, flush=True)


def _j(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def _write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def rep_rank(rep):
    r = rep.lower()
    return (config.REP_ORDER[r], "") if r in config.REP_ORDER else (10, r)


def _num(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return math.nan


# ------------------------------------------------------------------- données


def build_data(force_extract=False, preview=False):
    t0 = time.perf_counter()
    log("Sources")
    sources = geo.find_sources()
    for k, p in sources.items():
        log(f"  {k:<9} {p.name}")
    log("Extraction 01275")
    work = geo.extract(sources, force=force_extract, log=log)

    # --- adresses de la commune et transformation affine
    rows = geo.read_addresses(work["addresses"])
    if not rows:
        raise BuildError("aucune adresse pour la commune")
    coords = np.array([[_num(r["lon"]), _num(r["lat"]), _num(r["x"]), _num(r["y"])] for r in rows])
    ok = ~np.isnan(coords).any(axis=1)
    cx, cy, res = geo.fit_affine(*coords[ok].T)
    log(f"Affine GPS -> Lambert-93 sur {ok.sum()} adresses : résidu max {res.max():.3f} m, moyen {res.mean():.3f} m")
    if res.max() > config.AFFINE_MAX_RESIDUAL_M:
        raise BuildError(f"résidu affine {res.max():.3f} m > {config.AFFINE_MAX_RESIDUAL_M} m")
    px, py = geo.lonlat_to_l93(coords[ok, 0], coords[ok, 1])
    d = np.hypot(px - coords[ok, 2], py - coords[ok, 3])
    log(f"  contrôle BAN x/y vs pyproj(lon/lat) : écart max {d.max():.3f} m")

    # --- sélection des voies
    by_name = {st["name"]: i for i, st in enumerate(config.STREETS)}
    present = {r["nom_voie"] for r in rows}
    absent = [n for n in by_name if n not in present]
    if absent:
        raise BuildError(f"voies absentes de la BAN : {', '.join(absent)}")
    tour, ctx_cand = [], []
    for r in rows:
        s = by_name.get(r["nom_voie"])
        if s is None:
            continue
        n = int(r["numero"])
        st = config.STREETS[s]
        a = {"row": r, "s": s, "n": n, "rep": r["rep"].strip().lower(),
             "X": float(r["x"]), "Y": float(r["y"])}
        (tour if st.get("min", -1) <= n <= st.get("max", 10**9) else ctx_cand).append(a)
    counts = [sum(a["s"] == i for a in tour) for i in range(len(config.STREETS))]
    log("Voies (pointables / attendus)")
    for i, st in enumerate(config.STREETS):
        flag = "" if counts[i] == config.EXPECTED_COUNTS[i] else "   <-- ÉCART"
        log(f"  {i} {st['name']:<30} {counts[i]:>4} / {config.EXPECTED_COUNTS[i]}{flag}")
    log(f"  total {sum(counts)} / {sum(config.EXPECTED_COUNTS)}")
    if counts != config.EXPECTED_COUNTS:
        raise BuildError("comptes par rue différents de EXPECTED_COUNTS (voir ci-dessus)")

    # --- cadre
    P = np.array([[a["X"], a["Y"]] for a in tour])
    m = config.FRAME_MARGIN_M
    x0 = float(np.floor(P[:, 0].min() - m))
    y0 = float(np.floor(P[:, 1].min() - m))
    x1 = float(np.ceil(P[:, 0].max() + m))
    y1 = float(np.ceil(P[:, 1].max() + m))
    W, H = x1 - x0, y1 - y0
    ctx = [a for a in ctx_cand if x0 <= a["X"] <= x1 and y0 <= a["Y"] <= y1]
    for a in tour:
        a["ctx"] = False
    for a in ctx:
        a["ctx"] = True
    addrs = tour + ctx
    log(f"Cadre {W:.0f} x {H:.0f} m (x0={x0:.0f}, y1={y1:.0f}) ; adresses de contexte : {len(ctx)} ; total {len(addrs)}")

    # --- géométries
    gbox = shapely.box(x0, y0, x1, y1).buffer(config.GEOM_MARGIN_M)
    pg, pprops = geo.read_features(work["parcels"])
    bg, bprops = geo.read_features(work["buildings"])
    pg, bg = geo.to_l93(pg), geo.to_l93(bg)
    pk = shapely.intersects(pg, gbox) & ~shapely.is_empty(pg)
    bk = shapely.intersects(bg, gbox) & ~shapely.is_empty(bg)
    parcels, pprops = pg[pk], [p for p, k in zip(pprops, pk) if k]
    blds, bprops = bg[bk], [p for p, k in zip(bprops, bk) if k]
    log(f"Géométries gardées (cadre + {config.GEOM_MARGIN_M} m) : {len(parcels)} parcelles / {len(pg)}, "
        f"{len(blds)} bâtiments / {len(bg)}")
    covered = shapely.union_all(parcels).intersection(shapely.box(x0, y0, x1, y1)).area / (W * H)
    log(f"  part du cadre couverte par les parcelles de la commune : {covered:.0%}")

    # --- association adresse -> bâtiment
    parcels_by_id = {p["id"]: g for p, g in zip(pprops, parcels) if p.get("id")}
    pts = shapely.points(np.array([[a["X"], a["Y"]] for a in addrs]))
    cads = [[c for c in a["row"]["cad_parcelles"].split("|") if c] for a in addrs]
    assoc = geo.associate(pts, cads, parcels_by_id, blds, [p.get("type") for p in bprops])
    methods = {}
    for a, (bi, meth) in zip(addrs, assoc):
        a["bi"] = bi
        methods[meth] = methods.get(meth, 0) + 1
    n_assoc = sum(a["bi"] is not None for a in addrs)
    no_cad = sum(not c for c in cads)
    log(f"Association : {n_assoc} / {len(addrs)} adresses liées à un bâtiment "
        f"({', '.join(f'{k} {v}' for k, v in sorted(methods.items()))}) ; sans cad_parcelles : {no_cad}")
    missing = [a for a in addrs if a["bi"] is None and not a["ctx"]]
    if missing:
        log("  pointables sans bâtiment : " + ", ".join(
            f"{a['n']}{a['rep']} {config.STREETS[a['s']]['name']}" for a in missing))

    # --- tracés et étiquettes
    t = time.perf_counter()
    gaps = geo.uncadastred_domain(parcels, gbox)
    log(f"Domaine non cadastré : {gaps.area / 1e4:.1f} ha ({time.perf_counter() - t:.0f} s)")
    traces, labels = {}, {}
    for i, st in enumerate(config.STREETS):
        sp = np.array([[a["X"], a["Y"]] for a in tour if a["s"] == i])
        tr, mode = geo.street_trace(sp, gaps, fallback=i in config.TRACE_FALLBACK_STREETS)
        traces[i] = tr
        labels[i] = geo.street_labels(sp, tr, x0, y1)
        log(f"  {i} {st['name']:<30} {mode:<14} {tr.area:>8.0f} m2  {len(labels[i])} étiquette(s)")

    # --- sorties
    linked = sorted({a["bi"] for a in addrs if a["bi"] is not None})
    bid = {bi: f"b{bi}" for bi in linked}
    others = np.array([g for k, g in enumerate(blds) if k not in bid], dtype=object)
    plan = {
        "parcels": "".join(geo.svg_path(g, x0, y1) for g in parcels),
        "buildingsOther": "".join(geo.svg_path(g, x0, y1) for g in others),
        "buildings": {bid[bi]: geo.svg_path(blds[bi], x0, y1) for bi in linked},
        "traces": {str(i): geo.svg_path(tr, x0, y1) for i, tr in traces.items()},
    }
    addrs.sort(key=lambda a: (a["s"], a["n"], rep_rank(a["rep"]), a["ctx"]))
    out_addrs = [{
        "id": a["row"]["id"], "s": a["s"], "n": a["n"], "rep": a["rep"],
        "side": "pair" if a["n"] % 2 == 0 else "impair",
        "x": round(a["X"] - x0, 1), "y": round(y1 - a["Y"], 1),
        "ld": a["row"]["nom_ld"], "cad": a["row"]["cad_parcelles"],
        "bat": bid.get(a["bi"]), "ctx": a["ctx"],
    } for a in addrs]
    ids = [a["id"] for a in out_addrs]
    if len(set(ids)) != len(ids):
        raise BuildError("identifiants BAN en double")
    streets = [{"i": i, "name": st["name"], "colors": list(config.COLORS[i]),
                "count": counts[i], "labels": labels[i]} for i, st in enumerate(config.STREETS)]
    meta = {
        "frame": {"x0": x0, "y1": y1, "W": W, "H": H},
        "affine": {"x": cx, "y": cy, "maxResidual_m": round(float(res.max()), 3)},
    }
    plan_text = "{" + ",\n".join(f"{_j(k)}:{_j(v)}" for k, v in plan.items()) + "}\n"
    body = _j({**meta, "streets": streets, "addresses": out_addrs})
    version = hashlib.sha256((body + plan_text).encode("utf-8")).hexdigest()[:8]
    addresses_text = (
        "{" + ",\n".join(f"{_j(k)}:{_j(v)}" for k, v in {"version": version, **meta}.items())
        + ',\n"streets":[\n' + ",\n".join(_j(s) for s in streets)
        + '],\n"addresses":[\n' + ",\n".join(_j(a) for a in out_addrs) + "]}\n"
    )
    _write(config.DATA_DIR / "addresses.json", addresses_text)
    _write(config.DATA_DIR / "plan.json", plan_text)
    log(f"Sorties : addresses.json {len(addresses_text.encode()) / 1024:.0f} Ko, "
        f"plan.json {len(plan_text.encode()) / 1024:.0f} Ko ; version des données {version}")

    if preview:
        render_preview(parcels, blds, linked, traces, addrs, x0, y1, W, H, streets)
    log(f"Données générées en {time.perf_counter() - t0:.0f} s")


# --------------------------------------------------------------------- aperçu


def render_preview(parcels, blds, linked, traces, addrs, x0, y1, W, H, streets, width=2000):
    from PIL import Image, ImageDraw

    k = width / W
    img = Image.new("RGB", (width, int(H * k)), "#ffffff")
    over = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d, do = ImageDraw.Draw(img), ImageDraw.Draw(over)

    def xy(coords):
        return [((x - x0) * k, (y1 - y) * k) for x, y in coords]

    def polys(g):
        for p in geo._parts(g):
            if p.geom_type == "Polygon":
                yield p
            elif hasattr(p, "geoms"):
                yield from polys(p)

    def rgba(hex_, alpha):
        return tuple(int(hex_[i:i + 2], 16) for i in (1, 3, 5)) + (alpha,)

    for i, tr in traces.items():
        for p in polys(tr):
            do.polygon(xy(p.exterior.coords), fill=rgba(config.COLORS[i][0], 90))
    img.paste(over, (0, 0), over)
    for g in parcels:
        for p in polys(g):
            d.line(xy(p.exterior.coords), fill="#c8c8c8", width=1)
    street_of = {a["bi"]: a["s"] for a in addrs if a["bi"] is not None and not a["ctx"]}
    for bi, g in enumerate(blds):
        col = config.COLORS[street_of[bi]][0] if bi in street_of else "#bdbdbd"
        for p in polys(g):
            d.polygon(xy(p.exterior.coords), fill=col if bi in street_of else "#dddddd", outline=col)
    for a in addrs:
        x, y = (a["X"] - x0) * k, (y1 - a["Y"]) * k
        col = "#999999" if a["ctx"] else config.COLORS[a["s"]][0]
        d.ellipse([x - 4, y - 4, x + 4, y + 4], fill=col, outline="#000000")
        d.text((x + 5, y - 6), f"{a['n']}{a['rep']}", fill="#000000")
    for st in streets:  # étiquettes : trait dans l'orientation du texte
        for lb in st["labels"]:
            x, y, a = lb["x"] * k, lb["y"] * k, math.radians(lb["a"])
            dx, dy = 40 * math.cos(a), 40 * math.sin(a)
            d.line([(x - dx, y - dy), (x + dx, y + dy)], fill="#ff0000", width=5)
            d.text((x + 6, y + 6), st["name"], fill="#ff0000")
    out = config.WORK_DIR / "preview.png"
    img.save(out)
    log(f"Aperçu : {out}")


# ---------------------------------------------------------------------- stamp

BUILD_BLOCK = re.compile(r"// @build:start.*?// @build:end", re.S)
TEXT_EXT = {".html", ".js", ".css", ".json", ".webmanifest", ".svg", ".txt", ".md"}
NOT_HASHED = {"data/version.json", ".nojekyll"}
NOT_PRECACHED = {"sw.js", ".nojekyll"}


def stamp():
    """Version de l'app = hash de docs/ (hors bloc généré de sw.js et version.json).
    Réécrit version.json et le bloc VERSION / PRECACHE de sw.js."""
    docs = config.DOCS_DIR
    files = sorted((p for p in docs.rglob("*") if p.is_file()), key=lambda p: p.relative_to(docs).as_posix())
    h = hashlib.sha256()
    rels = []
    for p in files:
        rel = p.relative_to(docs).as_posix()
        rels.append(rel)
        if rel in NOT_HASHED:
            continue
        data = p.read_bytes()
        if p.suffix in TEXT_EXT:
            data = data.replace(b"\r\n", b"\n")  # Pages sert la version LF (.gitattributes)
        if rel == "sw.js":
            data = BUILD_BLOCK.sub("// @build", data.decode("utf-8")).encode("utf-8")
        h.update(rel.encode("utf-8") + b"\0" + data + b"\0")
    app = h.hexdigest()[:8]

    addresses = config.DATA_DIR / "addresses.json"
    data_version = json.loads(addresses.read_text("utf-8"))["version"] if addresses.exists() else None
    vpath = config.DATA_DIR / "version.json"
    old = json.loads(vpath.read_text("utf-8")) if vpath.exists() else {}
    if old.get("app") != app or old.get("data") != data_version or "builtAt" not in old:
        built = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat()
        _write(vpath, _j({"app": app, "data": data_version, "builtAt": built}) + "\n")
        if "data/version.json" not in rels:
            rels.append("data/version.json")
    precache = ["./"] + ["./" + r for r in sorted(rels) if r not in NOT_PRECACHED]

    sw = docs / "sw.js"
    if not sw.exists() or not BUILD_BLOCK.search(sw.read_text("utf-8")):
        log(f"Stamp : app {app} (docs/sw.js absent ou sans marqueurs @build : bloc non écrit)")
        return app
    block = ("// @build:start (généré par pipeline/build.py --stamp, ne pas éditer)\n"
             f"const VERSION = '{app}';\n"
             "const PRECACHE = [\n" + "".join(f"  '{p}',\n" for p in precache) + "];\n"
             "// @build:end")
    src = sw.read_text("utf-8")
    new = BUILD_BLOCK.sub(lambda _: block, src, count=1)
    if new != src:
        _write(sw, new)
    log(f"Stamp : app {app}, {len(precache)} fichiers en précache")
    return app


# ----------------------------------------------------------------------- main


def main(argv=None):
    for s in (sys.stdout, sys.stderr):
        s.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description="Pipeline des données de la PWA Tournées de Neyron")
    ap.add_argument("--stamp", action="store_true", help="recalcule seulement la version et le précache")
    ap.add_argument("--force-extract", action="store_true", help="ignore le cache d'extraction de work/")
    ap.add_argument("--preview", action="store_true", help="écrit work/preview.png")
    args = ap.parse_args(argv)
    try:
        if not args.stamp:
            build_data(force_extract=args.force_extract, preview=args.preview)
            import icons
            icons.ensure()
        stamp()
    except (BuildError, FileNotFoundError) as e:
        print(f"ÉCHEC : {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
