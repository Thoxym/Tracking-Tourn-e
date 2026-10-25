"""Télécharge le réseau routier de l'emprise de la commune dans sources/ (jamais commité).

    python pipeline/fetch_roads.py            BD TOPO (IGN, WFS de la Géoplateforme) et OSM (Overpass)
    python pipeline/fetch_roads.py --only osm

Seule l'emprise (cadre des données + ROADS_FAR_MARGIN_M) est envoyée aux deux services publics. À relancer pour
mettre le réseau à jour, puis `python pipeline/build.py`.
"""

import argparse
import datetime
import json
import sys
import time
import urllib.parse
import urllib.request

from pyproj import Transformer

import config

UA = {"User-Agent": "neyron-tournees-pipeline (usage personnel, emprise d'une commune)"}
WFS_URL = "https://data.geopf.fr/wfs/ows"
WFS_TYPE = "BDTOPO_V3:troncon_de_route"
WFS_PAGE = 1000
OVERPASS_URL = "https://overpass-api.de/api/interpreter"


def roads_bbox():
    """Emprise Lambert-93 (xmin, ymin, xmax, ymax) : cadre de addresses.json + marge."""
    path = config.DATA_DIR / "addresses.json"
    with open(path, encoding="utf-8") as f:
        f.readline()
        frame = json.loads("{" + f.readline().rstrip().rstrip(",") + "}")["frame"]
    m = config.ROADS_FAR_MARGIN_M
    return (frame["x0"] - m, frame["y1"] - frame["H"] - m, frame["x0"] + frame["W"] + m, frame["y1"] + m)


def _get(url, data=None, tries=3):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers=UA)
            with urllib.request.urlopen(req, timeout=180) as r:
                return r.read()
        except Exception as e:  # réseau ou service momentanément indisponible
            if k == tries - 1:
                raise
            print(f"  nouvel essai ({e})", flush=True)
            time.sleep(5 * (k + 1))
    return None


def fetch_bdtopo(bbox):
    features = []
    start = 0
    while True:
        q = {"SERVICE": "WFS", "VERSION": "2.0.0", "REQUEST": "GetFeature", "TYPENAMES": WFS_TYPE,
             "SRSNAME": "EPSG:2154", "BBOX": ",".join(f"{v:.0f}" for v in bbox) + ",EPSG:2154",
             "OUTPUTFORMAT": "application/json", "COUNT": str(WFS_PAGE), "STARTINDEX": str(start),
             "SORTBY": "cleabs"}
        page = json.loads(_get(f"{WFS_URL}?{urllib.parse.urlencode(q)}"))
        got = page.get("features", [])
        features += got
        print(f"  BD TOPO : {len(features)} tronçons", flush=True)
        if len(got) < WFS_PAGE:
            break
        start += WFS_PAGE
    return {"type": "FeatureCollection", "crs": "EPSG:2154", "features": features}


def fetch_osm(bbox):
    m = config.ROADS_FAR_MARGIN_M - config.ROADS_MARGIN_M  # OSM : seulement les cheminements de l'emprise proche
    bbox = (bbox[0] + m, bbox[1] + m, bbox[2] - m, bbox[3] - m)
    t = Transformer.from_crs(2154, 4326, always_xy=True)
    xs, ys = (bbox[0], bbox[2], bbox[0], bbox[2]), (bbox[1], bbox[1], bbox[3], bbox[3])
    lon, lat = t.transform(xs, ys)
    s, w, n, e = min(lat), min(lon), max(lat), max(lon)
    query = f'[out:json][timeout:120];way["highway"]({s:.6f},{w:.6f},{n:.6f},{e:.6f});out body geom;'
    data = json.loads(_get(OVERPASS_URL, data=urllib.parse.urlencode({"data": query}).encode()))
    print(f"  OSM : {sum(el['type'] == 'way' for el in data.get('elements', []))} voies", flush=True)
    return data


def _write(name, obj):
    config.SOURCES_DIR.mkdir(exist_ok=True)
    path = config.SOURCES_DIR / name
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        f.write("\n")
    print(f"  -> {path.relative_to(config.ROOT)} ({path.stat().st_size / 1024:.0f} Ko)", flush=True)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", choices=("bdtopo", "osm"))
    args = ap.parse_args(argv)
    bbox = roads_bbox()
    print(f"Emprise Lambert-93 : {', '.join(f'{v:.0f}' for v in bbox)} "
          f"({(bbox[2] - bbox[0]) / 1000:.1f} x {(bbox[3] - bbox[1]) / 1000:.1f} km)", flush=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    if args.only in (None, "bdtopo"):
        d = fetch_bdtopo(bbox)
        d["fetchedAt"] = stamp
        _write(config.ROADS_BDTOPO, d)
    if args.only in (None, "osm"):
        d = fetch_osm(bbox)
        d["fetchedAt"] = stamp
        _write(config.ROADS_OSM, d)
    return 0


if __name__ == "__main__":
    sys.exit(main())
