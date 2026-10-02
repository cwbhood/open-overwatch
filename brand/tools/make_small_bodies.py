"""Build the asteroid + comet data for the Solar System view (solar.html).

Source: NASA/JPL SBDB Query API (https://ssd-api.jpl.nasa.gov/doc/sbdb_query.html).
Raw responses are cached (gzipped) in brand/source/sbdb/ (gitignored); delete them to refetch.
Outputs (data/solar/):
  asteroids_a.bin  brightest 300,000 asteroids (by H)
  asteroids_b.bin  the rest
  small_bodies.json  epoch, file counts, class labels, named bodies, comets

Binary layout (column-major, little-endian, N records):
  Float32 a[N] (AU) | Uint16 e[N] = round(e*65535) | Uint16 i[N] = round(i/pi*65535)
  Uint16 node[N], peri[N], M[N] = round(angle/2pi*65535) mod 65536  (M at EPOCH_JD) | Uint8 cls[N]

Usage:
  python brand/tools/make_small_bodies.py             # fetch (if not cached) + build
  python brand/tools/make_small_bodies.py --validate  # also compare decoded positions with JPL Horizons
"""
import gzip
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "brand" / "source" / "sbdb"
OUT = ROOT / "data" / "solar"

API = "https://ssd-api.jpl.nasa.gov/sbdb_query.api"
HORIZONS = "https://ssd.jpl.nasa.gov/api/horizons.api"
EPOCH_JD = 2461041.5            # 2026-01-01.0 TT
K_DEG = 0.9856076686            # Gaussian mean motion, deg/day at a = 1 AU
SPLIT = 300_000
PAGE = 400_000                  # asteroid rows per request (~1.57M total -> 4 requests)

AST_FIELDS = "pdes,name,full_name,a,e,i,om,w,ma,epoch,H,diameter,class"
COM_FIELDS = "full_name,pdes,name,q,e,i,om,w,tp,epoch,class"

CLASSES = {0: "Main belt", 1: "Near-Earth", 2: "Jupiter Trojan", 3: "Centaur",
           4: "Trans-Neptunian", 5: "Mars-crosser", 6: "Other"}
CLASS_CODE = {"MBA": 0, "IMB": 0, "OMB": 0,
              "APO": 1, "ATE": 1, "AMO": 1, "IEO": 1,
              "TJN": 2, "CEN": 3, "TNO": 4, "MCA": 5}
# matched as prefixes of full_name (SBDB pdes for long-period comets has no "C/")
FAMOUS_COMETS = ("1P/", "2P/", "67P/", "C/1995 O1", "C/2020 F3", "C/2023 A3", "109P/", "55P/")


# ---------------------------------------------------------------- fetch (cached)
def fetch_json(url, cache_file, timeout=900):
    if cache_file.exists():
        with gzip.open(cache_file, "rt", encoding="utf-8") as f:
            return json.load(f)
    print("GET", url, flush=True)
    req = urllib.request.Request(url, headers={"Accept-Encoding": "gzip",
                                               "User-Agent": "open-overwatch make_small_bodies.py"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        if r.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
    print(f"  {len(raw) / 1e6:.1f} MB in {time.time() - t0:.0f} s", flush=True)
    data = json.loads(raw)
    if "data" not in data and "result" not in data:
        raise RuntimeError(f"unexpected response: {str(data)[:300]}")
    CACHE.mkdir(parents=True, exist_ok=True)
    with gzip.open(cache_file, "wb", compresslevel=6) as f:
        f.write(raw)
    return data


def sbdb(params, cache_name):
    q = urllib.parse.urlencode({**params, "full-prec": "true"}, safe=",")
    return fetch_json(f"{API}?{q}", CACHE / cache_name)


def fetch_asteroids():
    rows, fields, total, start = [], None, None, 0
    while total is None or start < total:
        d = sbdb({"fields": AST_FIELDS, "sb-kind": "a", "limit": PAGE, "limit-from": start},
                 f"asteroids_{start:07d}.json.gz")
        fields = d["fields"]
        total = int(d["count"])
        rows.extend(d.get("data") or [])
        start += PAGE
    return fields, rows, total


def fetch_comets():
    d = sbdb({"fields": COM_FIELDS, "sb-kind": "c"}, "comets.json.gz")
    return d["fields"], d["data"]


# ---------------------------------------------------------------- build
def fnum(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return math.nan


def enc_angle(deg):
    """degrees -> Uint16, full turn = 65535 (decode: v / 65535 * 2pi)."""
    return (np.round(np.mod(deg, 360.0) / 360.0 * 65535).astype(np.int64) % 65536).astype("<u2")


def class_code(cls, a):
    c = CLASS_CODE.get(cls)
    if c is not None:
        return c
    return 0 if 2.0 < a < 3.6 else 6


def build_asteroids(fields, rows):
    ix = {f: k for k, f in enumerate(fields)}
    n = len(rows)
    col = lambda f: np.array([fnum(r[ix[f]]) for r in rows], dtype=np.float64)
    a, e, inc, om, w, ma, ep, H, diam = (col(f) for f in ("a", "e", "i", "om", "w", "ma", "epoch", "H", "diameter"))
    ok = np.isfinite(a) & np.isfinite(e) & np.isfinite(inc) & np.isfinite(om) & np.isfinite(w) \
        & np.isfinite(ma) & np.isfinite(ep) & (a > 0) & (e >= 0) & (e < 1)
    # dedupe by designation (paging safety)
    seen, dup = set(), 0
    for k, r in enumerate(rows):
        if ok[k]:
            if r[ix["pdes"]] in seen:
                ok[k] = False
                dup += 1
            else:
                seen.add(r[ix["pdes"]])
    print(f"asteroids: {n} rows, {int(ok.sum())} kept ({n - int(ok.sum()) - dup} bad elements, {dup} duplicates)")

    keep = np.nonzero(ok)[0]
    Hs = np.where(np.isfinite(H[keep]), H[keep], np.inf)
    keep = keep[np.argsort(Hs, kind="stable")]

    nmot = K_DEG / a[keep] ** 1.5
    M = ma[keep] + nmot * (EPOCH_JD - ep[keep])
    cls = np.array([class_code(rows[k][ix["class"]], a[k]) for k in keep], dtype=np.uint8)

    cols = {
        "a": a[keep].astype("<f4"),
        "e": np.round(e[keep] * 65535).astype("<u2"),
        "i": np.round(np.radians(inc[keep]) / math.pi * 65535).astype("<u2"),
        "node": enc_angle(om[keep]),
        "peri": enc_angle(w[keep]),
        "M": enc_angle(M),
        "cls": cls,
    }
    files = []
    OUT.mkdir(parents=True, exist_ok=True)
    for name, lo, hi in (("asteroids_a.bin", 0, SPLIT), ("asteroids_b.bin", SPLIT, len(keep))):
        with open(OUT / name, "wb") as f:
            for c in ("a", "e", "i", "node", "peri", "M", "cls"):
                f.write(cols[c][lo:hi].tobytes())
        files.append({"name": name, "count": int(max(0, hi - lo))})

    named = []
    for pos, k in enumerate(keep):
        r = rows[k]
        nm = r[ix["name"]]
        d = diam[k]
        if not nm and not (np.isfinite(d) and d > 100):
            continue
        pdes = r[ix["pdes"]]
        if nm:
            label = f"{pdes} {nm}" if pdes.isdigit() else nm
        else:
            label = (r[ix["full_name"]] or f"({pdes})").strip()
        f, idx = ("a", pos) if pos < SPLIT else ("b", pos - SPLIT)
        named.append([f, idx, label, round(float(H[k]), 2) if np.isfinite(H[k]) else None,
                      (round(float(d)) if d >= 100 else round(float(d), 1)) if np.isfinite(d) else None,
                      int(cls[pos])])
    counts = {CLASSES[c]: int((cls == c).sum()) for c in CLASSES}
    return files, named, counts


def build_comets(fields, rows):
    ix = {f: k for k, f in enumerate(fields)}
    out, famous_found = [], set()
    for r in rows:
        q, e, inc, om, w, tp = (fnum(r[ix[f]]) for f in ("q", "e", "i", "om", "w", "tp"))
        if not all(math.isfinite(v) for v in (q, e, inc, om, w, tp)) or q <= 0:
            continue
        name = r[ix["full_name"]].strip()
        fam = next((f for f in FAMOUS_COMETS if name.startswith(f)), None)
        if e >= 1 and not fam:
            continue
        if fam:
            famous_found.add(fam)
        out.append([name, round(q, 6), round(e, 7), round(inc, 4),
                    round(om % 360, 4), round(w % 360, 4), round(tp, 4)])
    missing = set(FAMOUS_COMETS) - famous_found
    if missing:
        print("WARNING famous comets not found:", sorted(missing))
    return out


def build():
    af, arows, total = fetch_asteroids()
    print(f"SBDB asteroid count {total}, fetched {len(arows)}")
    cf, crows = fetch_comets()
    files, named, counts = build_asteroids(af, arows)
    del arows
    comets = build_comets(cf, crows)
    meta = {"epoch_jd": EPOCH_JD, "files": files,
            "classes": {str(k): v for k, v in CLASSES.items()},
            "named": named, "comets": comets}
    with open(OUT / "small_bodies.json", "w", encoding="utf-8") as f:
        json.dump(meta, f, separators=(",", ":"), ensure_ascii=False)
    print("files:", files)
    print("per class:", counts)
    print(f"named: {len(named)}  comets: {len(comets)}")
    for p in sorted(OUT.iterdir()):
        print(f"  {p.name}: {p.stat().st_size / 1e6:.2f} MB")


# ---------------------------------------------------------------- decode (mirror of the JS viewer)
def kepler_xyz(a, e, i, node, peri, M):
    """radians in; heliocentric ecliptic J2000 x,y,z (AU). Elliptic only."""
    E = M + e * math.sin(M) if e < 0.8 else math.pi
    for _ in range(50):
        dE = (E - e * math.sin(E) - M) / (1 - e * math.cos(E))
        E -= dE
        if abs(dE) < 1e-12:
            break
    xp, yp = a * (math.cos(E) - e), a * math.sqrt(1 - e * e) * math.sin(E)
    cO, sO, cw, sw, ci, si = math.cos(node), math.sin(node), math.cos(peri), math.sin(peri), math.cos(i), math.sin(i)
    x = (cO * cw - sO * sw * ci) * xp + (-cO * sw - sO * cw * ci) * yp
    y = (sO * cw + cO * sw * ci) * xp + (-sO * sw + cO * cw * ci) * yp
    z = (sw * si) * xp + (cw * si) * yp
    return x, y, z


def read_bin(path):
    raw = path.read_bytes()
    n = len(raw) // 15
    o = 0
    def take(dt, size):
        nonlocal o
        arr = np.frombuffer(raw, dtype=dt, count=n, offset=o)
        o += n * size
        return arr
    return {"a": take("<f4", 4), "e": take("<u2", 2), "i": take("<u2", 2), "node": take("<u2", 2),
            "peri": take("<u2", 2), "M": take("<u2", 2), "cls": take("u1", 1)}


def decode_asteroid(bins, f, idx, jd):
    b = bins[f]
    a = float(b["a"][idx])
    e = b["e"][idx] / 65535
    i = b["i"][idx] / 65535 * math.pi
    node = b["node"][idx] / 65535 * 2 * math.pi
    peri = b["peri"][idx] / 65535 * 2 * math.pi
    M0 = b["M"][idx] / 65535 * 2 * math.pi
    n = math.radians(K_DEG / a ** 1.5)
    M = math.remainder(M0 + n * (jd - EPOCH_JD), 2 * math.pi)
    return kepler_xyz(a, e, i, node, peri, M)


def decode_comet(c, jd):
    _, q, e, i, node, peri, tp = c
    a = q / (1 - e)
    n = math.radians(K_DEG / a ** 1.5)
    M = math.remainder(n * (jd - tp), 2 * math.pi)
    return kepler_xyz(a, e, math.radians(i), math.radians(node), math.radians(peri), M)


def horizons_vec(command, jd, tag):
    params = {"format": "json", "COMMAND": f"'{command}'", "OBJ_DATA": "'NO'", "MAKE_EPHEM": "'YES'",
              "EPHEM_TYPE": "'VECTORS'", "CENTER": "'500@10'", "REF_PLANE": "'ECLIPTIC'",
              "REF_SYSTEM": "'J2000'", "VEC_TABLE": "'1'", "OUT_UNITS": "'AU-D'", "TLIST": f"'{jd}'",
              "TIME_TYPE": "'TT'", "CSV_FORMAT": "'YES'"}
    d = fetch_json(f"{HORIZONS}?{urllib.parse.urlencode(params)}", CACHE / f"horizons_{tag}_{jd}.json.gz", 120)
    res = d["result"]
    body = res[res.index("$$SOE") + 5:res.index("$$EOE")].strip()
    parts = [p.strip() for p in body.split(",")]
    return float(parts[2]), float(parts[3]), float(parts[4])


def validate(jd=2461315.5):  # 2026-10-02 00:00 TT
    meta = json.loads((OUT / "small_bodies.json").read_text(encoding="utf-8"))
    bins = {"a": read_bin(OUT / "asteroids_a.bin"), "b": read_bin(OUT / "asteroids_b.bin")}
    byname = {n[2]: n for n in meta["named"]}
    rows = []
    for label, cmd, tag in (("1 Ceres", "1;", "ceres"), ("4 Vesta", "4;", "vesta"),
                            ("101955 Bennu", "101955;", "bennu"), ("433 Eros", "433;", "eros")):
        nm = byname[label]
        rows.append((label, decode_asteroid(bins, nm[0], nm[1], jd), horizons_vec(cmd, jd, tag)))
    halley = next(c for c in meta["comets"] if c[0].startswith("1P/"))
    rows.append((halley[0], decode_comet(halley, jd), horizons_vec("DES=1P;CAP;NOFRAG", jd, "halley")))
    print(f"\nValidation at JD {jd} (TT), heliocentric ecliptic J2000, AU")
    print(f"{'body':14s} {'ours x,y,z':>32s} {'Horizons x,y,z':>32s} {'|d| AU':>9s} {'r AU':>6s}")
    for label, p, h in rows:
        d = math.dist(p, h)
        r = math.hypot(*h)
        print(f"{label:14s} {p[0]:10.5f}{p[1]:11.5f}{p[2]:11.5f} {h[0]:10.5f}{h[1]:11.5f}{h[2]:11.5f} {d:9.5f} {r:6.2f}")


if __name__ == "__main__":
    build()
    if "--validate" in sys.argv:
        validate()
