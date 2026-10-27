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
import unicodedata

import numpy as np
import shapely

import config
import geo
import roads


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


def street_sort_key(name):
    """Ordre alphabétique sans accents ni casse (« Allée » avant « Avenue », « Écoles » parmi les E)."""
    return unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower(), name


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
    log(f"Extraction {', '.join(c['name'] + ' (' + c['insee'] + ')' for c in config.COMMUNES)}")
    work = geo.extract(sources, force=force_extract, log=log)

    # --- adresses des communes et transformation affine
    rows = geo.read_addresses(work["addresses"])
    if not rows:
        raise BuildError("aucune adresse pour les communes")
    coords = np.array([[_num(r["lon"]), _num(r["lat"]), _num(r["x"]), _num(r["y"])] for r in rows])
    ok = ~np.isnan(coords).any(axis=1)
    aff, res = geo.fit_affine(*coords[ok].T)
    log(f"Transformation GPS -> Lambert-93 (second degré) sur {ok.sum()} adresses : résidu max {res.max():.3f} m, moyen {res.mean():.3f} m")
    if res.max() > config.AFFINE_MAX_RESIDUAL_M:
        raise BuildError(f"résidu affine {res.max():.3f} m > {config.AFFINE_MAX_RESIDUAL_M} m")
    px, py = geo.lonlat_to_l93(coords[ok, 0], coords[ok, 1])
    d = np.hypot(px - coords[ok, 2], py - coords[ok, 3])
    log(f"  contrôle BAN x/y vs pyproj(lon/lat) : écart max {d.max():.3f} m")

    # --- communes entières : une rue par voie (commune + nom), dans l'ordre alphabétique
    kept = [r for r in rows if r["type_position"] not in config.ADDRESS_EXCLUDED_TYPES]
    # une adresse peut figurer deux fois (deux entrées) ; l'id BAN est la clé de progression : on garde la première
    first = {}
    for r in kept:
        first.setdefault(r["id"], r)
    dups = [r for r in kept if first[r["id"]] is not r]
    for r in dups:
        o = first[r["id"]]
        gap = math.hypot(float(r["x"]) - float(o["x"]), float(r["y"]) - float(o["y"]))
        log(f"  doublon BAN ignoré : {r['numero']}{r['rep']} {r['nom_voie']} ({r['id']}, à {gap:.0f} m de la première)")
    kept = list(first.values())
    c_of = {c["insee"]: k for k, c in enumerate(config.COMMUNES)}
    voies = sorted({(r["code_insee"], r["nom_voie"]) for r in kept},
                   key=lambda v: (street_sort_key(v[1]), c_of[v[0]]))
    s_of = {v: i for i, v in enumerate(voies)}
    names = [n for _, n in voies]
    commune_of = [c_of[c] for c, _ in voies]
    # un nom porté par plusieurs communes (Route de Genève…) : libellé suivi de la commune
    shared = {n for n in names if names.count(n) > 1}
    display = [f"{n} ({config.COMMUNES[c]['name']})" if n in shared else n for n, c in zip(names, commune_of)]
    addrs = [{"row": r, "s": s_of[(r["code_insee"], r["nom_voie"])], "n": int(r["numero"]),
              "rep": r["rep"].strip().lower(), "X": float(r["x"]), "Y": float(r["y"]), "ctx": False} for r in kept]
    counts = [0] * len(names)
    for a in addrs:
        counts[a["s"]] += 1
    log(f"Communes : {len(addrs)} adresses sur {len(names)} voies ; écartées : {len(rows) - len(kept)} "
        f"({', '.join(sorted({r['type_position'] for r in rows if r['type_position'] in config.ADDRESS_EXCLUDED_TYPES}))})")
    bad = []
    for k, c in enumerate(config.COMMUNES):
        got = (sum(1 for a in addrs if commune_of[a["s"]] == k), sum(1 for x in commune_of if x == k))
        exp = c["expected"]
        log(f"  {c['name']:<26} {got[0]:>5} adresses, {got[1]:>4} voies"
            + (f" (attendu : {exp[0]}, {exp[1]})" if exp else " (non vérifié)") + ("   <-- ÉCART" if exp and got != tuple(exp) else ""))
        if exp and got != tuple(exp):
            bad.append(c["name"])
    if bad:
        raise BuildError(f"totaux différents des attendus (config.COMMUNES) : {', '.join(bad)}")
    if shared:
        log(f"  noms portés par plusieurs communes : {', '.join(sorted(shared, key=street_sort_key))}")

    # --- tournées prédéfinies
    presets = []
    for pr in config.PRESETS:
        log(f"Tournée prédéfinie « {pr['name']} » (id {pr['id']})")
        ids, bad = set(), []
        for spec in pr["streets"]:
            key = (spec.get("commune", pr["commune"]), spec["name"])
            if key not in s_of:
                raise BuildError(f"voie absente de la BAN : {spec['name']} ({key[0]})")
            sel = [a for a in addrs if a["s"] == s_of[key]
                   and spec.get("min", -1) <= a["n"] <= spec.get("max", 10**9)]
            ids.update(a["row"]["id"] for a in sel)
            ok_count = len(sel) == spec["expected"]
            if not ok_count:
                bad.append(spec["name"])
            log(f"  {spec['name']:<30} {len(sel):>4} / {spec['expected']}{'' if ok_count else '   <-- ÉCART'}")
        if bad:
            raise BuildError(f"tournée « {pr['name']} » : comptes différents des attendus ({', '.join(bad)})")
        presets.append({"id": pr["id"], "name": pr["name"], "ids": ids})

    # --- cadre
    P = np.array([[a["X"], a["Y"]] for a in addrs])
    m = config.FRAME_MARGIN_M
    x0 = float(np.floor(P[:, 0].min() - m))
    y0 = float(np.floor(P[:, 1].min() - m))
    x1 = float(np.ceil(P[:, 0].max() + m))
    y1 = float(np.ceil(P[:, 1].max() + m))
    W, H = x1 - x0, y1 - y0
    log(f"Cadre {W:.0f} x {H:.0f} m (x0={x0:.0f}, y1={y1:.0f})")

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
    no_cad = sum(not c for c in cads)
    cads, inferred = geo.infer_parcels(pts, cads, [a["row"]["type_position"] for a in addrs],
                                       parcels, [p.get("id") for p in pprops])
    for a, c in zip(addrs, cads):
        a["cad"] = c
    assoc = geo.associate(pts, cads, parcels_by_id, blds, [p.get("type") for p in bprops])
    methods = {}
    for a, (bi, meth) in zip(addrs, assoc):
        a["bi"] = bi
        methods[meth] = methods.get(meth, 0) + 1
    n_assoc = sum(a["bi"] is not None for a in addrs)
    log(f"Association : {n_assoc} / {len(addrs)} adresses liées à un bâtiment "
        f"({', '.join(f'{k} {v}' for k, v in sorted(methods.items()))}) ; sans cad_parcelles : {no_cad}, "
        f"dont {inferred} rattachées à la parcelle qui contient le point ou la touche")
    missing = [a for a in addrs if a["bi"] is None]
    if missing:
        shown = ", ".join(f"{a['n']}{a['rep']} {names[a['s']]}" for a in missing[:12])
        log(f"  sans bâtiment : {len(missing)} ({shown}{', …' if len(missing) > 12 else ''})")

    # --- bâtiments sans adresse : parcelles citées et points de toutes les adresses de la commune (tous types)
    addressed = {c for r in rows for c in r["cad_parcelles"].split("|") if c} | {c for a in addrs for c in a["cad"]}
    orphans = geo.unaddressed_buildings(blds, [p.get("type") for p in bprops], {a["bi"] for a in addrs},
                                        parcels, [p.get("id") for p in pprops], addressed,
                                        shapely.points(coords[ok][:, 2:4]),
                                        shapely.points(np.array([[a["X"], a["Y"]] for a in addrs
                                                                 if a["row"]["type_position"] == "segment"]).reshape(-1, 2)))
    unaddressed = []
    for k in orphans:
        rp = shapely.point_on_surface(blds[k])
        x, y = round(rp.x - x0, 1), round(y1 - rp.y, 1)
        if 0 <= x <= W and 0 <= y <= H:
            unaddressed.append({"x": x, "y": y, "a": round(float(blds[k].area))})
    unaddressed.sort(key=lambda u: (u["y"], u["x"]))
    log(f"Bâtiments sans adresse : {len(unaddressed)} (bâti dur d'au moins {config.UNADDRESSED_MIN_AREA_M2} m², "
        f"parcelle sans adresse, à plus de {config.UNADDRESSED_MIN_DIST_M} m de toute adresse)")

    # --- tracés et étiquettes
    t = time.perf_counter()
    gaps = geo.uncadastred_domain(parcels, gbox)
    log(f"Domaine non cadastré : {gaps.area / 1e4:.1f} ha ({time.perf_counter() - t:.0f} s)")
    t = time.perf_counter()
    pcomm = [p.get("commune") for p in pprops]
    limits, regions = geo.commune_limits(parcels, pcomm, config.INSEES, shapely.box(x0, y0, x1, y1))
    commune_labels = []
    for c, reg in zip(config.COMMUNES, regions):
        pts = np.array([[a["X"], a["Y"]] for a in addrs if commune_of[a["s"]] == c_of[c["insee"]]])
        commune_labels.append(geo.commune_label(reg, pts, x0, y1))
    log(f"Limites des communes : {limits.length / 1000:.1f} km de trait ({time.perf_counter() - t:.0f} s)")
    t = time.perf_counter()
    traces, labels, lengths, modes = {}, {}, {}, {}
    for i, name in enumerate(names):
        sp = np.array([[a["X"], a["Y"]] for a in addrs if a["s"] == i])
        tr, mode = geo.street_trace(sp, gaps, fallback=name in config.TRACE_FALLBACK_STREETS)
        traces[i] = tr
        labels[i] = geo.street_labels(sp, tr, x0, y1)
        lengths[i] = round(geo.mst_length(sp))
        modes[mode] = modes.get(mode, 0) + 1
    log(f"Tracés de {len(names)} voies en {time.perf_counter() - t:.0f} s : "
        + ", ".join(f"{k} {v}" for k, v in sorted(modes.items()))
        + f" ; {sum(len(v) for v in labels.values())} étiquettes ; longueur cumulée {sum(lengths.values()) / 1000:.1f} km")
    color, max_deg, conflicts = geo.neighbor_colors([traces[i] for i in range(len(names))],
                                                   len(config.PALETTE), config.NEIGHBOR_DIST_M)
    log(f"Couleurs : {len(config.PALETTE)} teintes, jusqu'à {max_deg} voisines par rue, "
        f"{conflicts} paire(s) de voisines de même couleur")

    # --- sorties
    linked = sorted({a["bi"] for a in addrs if a["bi"] is not None})
    bid = {bi: f"b{bi}" for bi in linked}
    others = np.array([g for k, g in enumerate(blds) if k not in bid], dtype=object)
    plan = {
        "parcels": geo.tiled_paths(parcels, x0, y1, config.TILE_M),
        "buildingsOther": geo.tiled_paths(others, x0, y1, config.TILE_M),
        "buildings": {bid[bi]: geo.svg_path(blds[bi], x0, y1) for bi in linked},
        "traces": {str(i): geo.svg_path(tr, x0, y1) for i, tr in traces.items()},
        "limits": geo.svg_lines(limits, x0, y1),
    }
    addrs.sort(key=lambda a: (a["s"], a["n"], rep_rank(a["rep"])))
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
    streets = [{"i": i, "name": name, "c": commune_of[i], **({"label": display[i]} if display[i] != name else {}),
                "colors": list(config.PALETTE[color[i]]), "count": counts[i],
                "len": lengths[i], "labels": labels[i]} for i, name in enumerate(names)]
    presets_out = [{"id": pr["id"], "name": pr["name"], "ids": [a["id"] for a in out_addrs if a["id"] in pr["ids"]]}
                   for pr in presets]
    meta = {
        "frame": {"x0": x0, "y1": y1, "W": W, "H": H},
        "affine": {**aff, "maxResidual_m": round(float(res.max()), 4)},
        "communes": [{"insee": c["insee"], "name": c["name"], "count": sum(1 for a in addrs if commune_of[a["s"]] == k),
                      "labels": commune_labels[k]} for k, c in enumerate(config.COMMUNES)],
    }
    plan_text = "{" + ",\n".join(f"{_j(k)}:{_j(v)}" for k, v in plan.items()) + "}\n"
    body = _j({**meta, "streets": streets, "presets": presets_out, "unaddressed": unaddressed,
               "addresses": out_addrs})
    version = hashlib.sha256((body + plan_text).encode("utf-8")).hexdigest()[:8]
    addresses_text = (
        "{" + ",\n".join(f"{_j(k)}:{_j(v)}" for k, v in {"version": version, **meta}.items())
        + ',\n"streets":[\n' + ",\n".join(_j(s) for s in streets)
        + '],\n"presets":[\n' + ",\n".join(_j(pr) for pr in presets_out)
        + '],\n"unaddressed":' + _j(unaddressed)
        + ',\n"addresses":[\n' + ",\n".join(_j(a) for a in out_addrs) + "]}\n"
    )
    _write(config.DATA_DIR / "addresses.json", addresses_text)
    _write(config.DATA_DIR / "plan.json", plan_text)
    log(f"Sorties : addresses.json {len(addresses_text.encode()) / 1024:.0f} Ko, "
        f"plan.json {len(plan_text.encode()) / 1024:.0f} Ko ; version des données {version}")

    if preview:
        render_preview(parcels, blds, linked, traces, addrs, x0, y1, W, H, streets, limits)

    # --- réseau routier (itinéraire)
    if (config.SOURCES_DIR / config.ROADS_BDTOPO).exists() and (config.SOURCES_DIR / config.ROADS_OSM).exists():
        key_of = lambda a: "_".join(a["row"]["id"].split("_")[:2])  # clé de voie BAN (tourplan.streetKeyOf)
        street_of_key = {key_of(a): a["s"] for a in addrs}
        try:
            roads.build([{"id": a["row"]["id"], "key": key_of(a), "X": a["X"], "Y": a["Y"],
                          "cad": a["cad"],
                          "street": names[a["s"]], "label": f"{a['n']}{a['rep']} {names[a['s']]}"} for a in addrs],
                        parcels_by_id, x0, y1, W, H, street_of_key, names, log, preview=preview)
        except roads.RoadsError as e:
            raise BuildError(f"réseau routier : {e}") from e
    elif (config.DATA_DIR / "roads.json").exists():
        log("Réseau routier : sources absentes, roads.json existant conservé (python pipeline/fetch_roads.py)")
    else:
        log("Réseau routier : sources absentes, pas d'itinéraire (python pipeline/fetch_roads.py)")
    log(f"Données générées en {time.perf_counter() - t0:.0f} s")


# --------------------------------------------------------------------- aperçu


def render_preview(parcels, blds, linked, traces, addrs, x0, y1, W, H, streets, limits=None, width=3000):
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
            do.polygon(xy(p.exterior.coords), fill=rgba(streets[i]["colors"][0], 90))
    img.paste(over, (0, 0), over)
    for g in parcels:
        for p in polys(g):
            d.line(xy(p.exterior.coords), fill="#c8c8c8", width=1)
    street_of = {a["bi"]: a["s"] for a in addrs if a["bi"] is not None}
    for bi, g in enumerate(blds):
        col = streets[street_of[bi]]["colors"][0] if bi in street_of else "#bdbdbd"
        for p in polys(g):
            d.polygon(xy(p.exterior.coords), fill=col if bi in street_of else "#dddddd", outline=col)
    for a in addrs:
        x, y = (a["X"] - x0) * k, (y1 - a["Y"]) * k
        col = streets[a["s"]]["colors"][0]
        d.ellipse([x - 4, y - 4, x + 4, y + 4], fill=col, outline="#000000")
        d.text((x + 5, y - 6), f"{a['n']}{a['rep']}", fill="#000000")
    for ln in geo._parts(limits) if limits is not None else []:
        d.line(xy(ln.coords), fill="#8000ff", width=4)
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


def stamp(check=False):
    """Version de l'app = hash de docs/ (hors bloc généré de sw.js et version.json).
    Réécrit version.json et le bloc VERSION / PRECACHE de sw.js. Avec check=True, n'écrit rien
    et échoue si l'un des deux est périmé (docs/ modifié sans relancer le stamp)."""
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
    stale = []
    if old.get("app") != app or old.get("data") != data_version or "builtAt" not in old:
        stale.append("data/version.json")
        if not check:
            built = datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0).isoformat()
            _write(vpath, _j({"app": app, "data": data_version, "builtAt": built}) + "\n")
        if "data/version.json" not in rels:
            rels.append("data/version.json")
    precache = ["./"] + ["./" + r for r in sorted(rels) if r not in NOT_PRECACHED]

    sw = docs / "sw.js"
    if not sw.exists() or not BUILD_BLOCK.search(sw.read_text("utf-8")):
        if check:
            raise BuildError("docs/sw.js absent ou sans marqueurs @build")
        log(f"Stamp : app {app} (docs/sw.js absent ou sans marqueurs @build : bloc non écrit)")
        return app
    block = ("// @build:start (généré par pipeline/build.py --stamp, ne pas éditer)\n"
             f"const VERSION = '{app}';\n"
             "const PRECACHE = [\n" + "".join(f"  '{p}',\n" for p in precache) + "];\n"
             "// @build:end")
    src = sw.read_text("utf-8")
    new = BUILD_BLOCK.sub(lambda _: block, src, count=1)
    if new != src:
        stale.append("sw.js")
        if not check:
            _write(sw, new)
    if check:
        if stale:
            raise BuildError(f"stamp périmé ({', '.join(stale)}) : lancer python pipeline/build.py --stamp")
        log(f"Stamp à jour : app {app}, {len(precache)} fichiers en précache")
        return app
    log(f"Stamp : app {app}, {len(precache)} fichiers en précache")
    return app


# ----------------------------------------------------------------------- main


def main(argv=None):
    for s in (sys.stdout, sys.stderr):
        s.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description="Pipeline des données de la PWA Tournées de Neyron")
    ap.add_argument("--stamp", action="store_true", help="recalcule seulement la version et le précache")
    ap.add_argument("--check", action="store_true", help="vérifie que le stamp est à jour, sans rien écrire")
    ap.add_argument("--force-extract", action="store_true", help="ignore le cache d'extraction de work/")
    ap.add_argument("--preview", action="store_true", help="écrit work/preview.png")
    args = ap.parse_args(argv)
    try:
        if args.check:
            stamp(check=True)
            return 0
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
