"""Write the cross-language LSTB fixtures used by dashboard/src/data/__tests__/lstb.test.js.

Each fixture is a container written by the notebook's OWN ``lstb_write`` (its source is extracted from
notebook/sections/00_setup.py with ``ast``, so the fixtures always reflect the pipeline's encoder) plus a sibling
``<base>.json`` with the values that ``lstb_read`` decodes (null = NaN / nodata):

    {"kind": str, "n": int, "meta": {...}, "columns": {name: nested list of decoded values}, "raw": {...}}

The JavaScript test decodes the container with ``decodeLstbBytes`` and compares every value within the column's
quantisation step. ``raw`` holds the stored integers so a reader can also be checked bit-exactly.

Usage (from the repository root; numpy is the only dependency):
    python dashboard/src/data/__fixtures__/lstb/make_fixtures.py [--check]

``--check`` re-reads every fixture with the notebook's ``lstb_read`` and an independent decoder and fails on any
difference (used by the notebook test-suite); without it the fixtures are (re)written first.
"""
from __future__ import annotations

import argparse
import ast
import gzip
import io
import json
import math
import os
import struct
import sys
from dataclasses import asdict, is_dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any, Optional, Sequence

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]          # <repo>/dashboard/src/data/__fixtures__/lstb -> <repo>
SETUP = ROOT / "notebook" / "sections" / "00_setup.py"
_FUNCS = ("_json_float", "_to_jsonable", "_write_bytes_atomic", "_gzip_bytes", "_lstb_raw_range", "quant_params",
          "_lstb_kind_from_path", "_lstb_encode_column", "lstb_write", "lstb_parse", "lstb_read")
_ASSIGNS = ("LSTB_MAGIC", "LSTB_VERSION", "_LSTB_DTYPES", "_LSTB_DEFAULT_NODATA")


def load_notebook_lstb() -> dict:
    """Namespace with the notebook's LSTB encoder/decoder, compiled from the 00_setup.py source."""
    tree = ast.parse(SETUP.read_text(encoding="utf-8"))
    keep = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in _FUNCS:
            keep.append(node)
        elif isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in _ASSIGNS for t in node.targets):
            keep.append(node)
    found = {n.name for n in keep if isinstance(n, ast.FunctionDef)}
    missing = set(_FUNCS) - found
    if missing:
        raise RuntimeError(f"00_setup.py no longer defines {sorted(missing)}")
    module = ast.Module(body=keep, type_ignores=[])

    class _PandasStub:  # _to_jsonable only needs isinstance targets from pandas
        class DataFrame:  # noqa: D106
            pass

        class Series:  # noqa: D106
            pass

        class Index:  # noqa: D106
            pass

        class Timestamp:  # noqa: D106
            pass

        NaT = object()

    ns = {"np": np, "pd": _PandasStub, "io": io, "gzip": gzip, "json": json, "math": math, "os": os,
          "struct": struct, "Path": Path, "Optional": Optional, "Sequence": Sequence, "Any": Any,
          "datetime": datetime, "date": date, "is_dataclass": is_dataclass, "asdict": asdict,
          "log": lambda msg, level="INFO": None}
    exec(compile(module, str(SETUP), "exec"), ns)  # noqa: S102 - trusted repository source
    return ns


def _jsonable(values: np.ndarray):
    """float array -> nested lists with None for NaN (shortest round-trip repr of the float32 decode)."""
    arr = np.asarray(values, dtype=np.float64)
    out = arr.tolist()

    def fix(x):
        if isinstance(x, list):
            return [fix(v) for v in x]
        return None if not math.isfinite(x) else float(np.float32(x))
    return fix(out)


def fixtures(nb: dict) -> dict:
    """name -> (columns, meta, kind). Values exercise NaN/nodata, negatives, clipping, 2-D frames, all dtypes."""
    qp = nb["quant_params"]
    groups = ["ndvi", "phenology", "ndbi", "moisture_index", "albedo", "built", "built_volume", "population",
              "forest", "water", "cropland", "barren", "urban_proximity", "landscape", "terrain", "climate_heat",
              "climate_moisture", "climate_wind"]
    rng = np.random.default_rng(20261002)
    nan = np.nan
    out = {}
    # cells: int32 ids (one above 2^16), int16 row/col, float32 lon/lat, district with -1
    out["cells_small.lstb.gz"] = ([
        {"name": "cell_id", "array": np.array([3, 4, 150, 151, 300, 70000], np.int32), "dtype": "int32"},
        {"name": "row", "array": np.array([0, 0, 1, 1, 2, 466], np.int16), "dtype": "int16"},
        {"name": "col", "array": np.array([3, 4, 0, 1, 0, 100], np.int16), "dtype": "int16"},
        {"name": "lon", "array": np.array([76.91234, 76.92234, 77.0, 77.01, 77.1, 77.65432], np.float32),
         "dtype": "float32"},
        {"name": "lat", "array": np.array([29.5, 29.5, 29.49, 29.49, 29.48, nan], np.float32), "dtype": "float32"},
        {"name": "district", "array": np.array([-1, 0, 0, 7, 24, 16], np.int16), "dtype": "int16"},
    ], {"grid": {"crs": "EPSG:32643", "res": 1000, "x0": 545000.0, "y0": 3321000.0, "width": 150, "height": 467}},
        "cells")
    # observed cube: lst int16 0.01 degC with NaN and a negative value; offsets uint8 0.05 (12.75 clip)
    lst = np.array([[40.123, nan, 38.5, -1.0, 45.005],
                    [41.0, 42.006, nan, 39.995, 44.444],
                    [27.111, 26.0, 25.555, nan, 33.3]])
    out["cube_obs_small.lstb.gz"] = ([
        {"name": "lst", "array": lst, "dtype": "int16", "scale": 0.01, "offset": 0.0, "nodata": -32768},
        {"name": "aoa_out", "array": np.array([[0, 1, 0, 0, 1], [0, 0, 0, 1, 0], [1, 1, 0, 0, 0]], np.uint8),
         "dtype": "uint8"},
        {"name": "p05_off", "array": np.array([[0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0.5, 1.23, 12.75, 0, 20.0]]),
         "dtype": "uint8", "scale": 0.05},
        {"name": "p95_off", "array": np.array([[0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0.55, 1.0, 3.33, 0, 0.024]]),
         "dtype": "uint8", "scale": 0.05},
    ], {"mode": "night", "frames": [2015, 2020, 1990], "tiers": ["observed", "observed", "modelled"],
        "levels": [26.1, 26.4, 25.15]}, "cube")
    # projected cube: p50 + four non-negative offsets + flags
    p50 = np.array([[42.0, 43.25, nan, 40.004], [44.5, 45.75, 41.0, nan]])
    off = lambda a: {"array": np.asarray(a, float), "dtype": "uint8", "scale": 0.05}  # noqa: E731
    out["cube_ssp245_small.lstb.gz"] = ([
        {"name": "p50", "array": p50, "dtype": "int16", "scale": 0.01, "offset": 0.0, "nodata": -32768},
        {"name": "p05_off", **off([[1.0, 2.0, 0, 0.45], [1.5, 3.0, 0.1, 0]])},
        {"name": "p25_off", **off([[0.4, 0.8, 0, 0.2], [0.6, 1.2, 0.05, 0]])},
        {"name": "p75_off", **off([[0.5, 0.9, 0, 0.2], [0.7, 1.1, 0.05, 0]])},
        {"name": "p95_off", **off([[1.2, 2.4, 0, 0.5], [1.8, 3.6, 0.1, 0]])},
        {"name": "flags", "array": np.array([[2, 4, 0, 1], [5, 6, 0, 7]], np.uint8), "dtype": "uint8"},
    ], {"mode": "day", "scenario": "ssp245", "frames": [2030, 2050], "method": "gcm"}, "cube")
    # zones: uint8 with nodata 255 (stored from NaN)
    out["cube_zones_small.lstb.gz"] = ([
        {"name": "obs", "array": np.array([[0, 1, 2, 3, nan], [3, 3, nan, 1, 0]]), "dtype": "uint8", "nodata": 255},
        {"name": "ssp245", "array": np.array([[1, 1, 2, 3, 0], [nan, 3, 2, 1, 0], [3, 3, 3, 3, 3]]),
         "dtype": "uint8", "nodata": 255},
    ], {"mode": "day", "frames": {"obs": [2020, 2025], "ssp245": [2030, 2040, 2050]}}, "zones")
    # xai: 18 group SHAP (0.001 degC, one NaN row) + pred / oof / obs / resid (0.01 degC)
    shap = np.round(rng.normal(0, 0.8, (4, 18)), 4)
    shap[2] = nan
    base_c = 40.1234
    pred = base_c + np.nansum(shap, axis=1)
    pred[2] = 39.5
    obs = np.array([41.2, nan, 39.7, 38.05])
    oof = np.array([40.9, 41.0, nan, 38.4])
    cols = [{"name": g, "array": shap[:, i], "dtype": "int16", "scale": 0.001, "offset": 0.0, "nodata": -32768}
            for i, g in enumerate(groups)]
    for name, arr in (("pred", pred), ("oof", oof), ("obs", obs), ("resid", obs - oof)):
        cols.append({"name": name, "array": arr, "dtype": "int16", "scale": 0.01, "offset": 0.0, "nodata": -32768})
    out["xai_2025_day_small.lstb.gz"] = (cols, {"year": 2025, "mode": "day", "tier": "observed", "base_value_c": base_c,
                                                "level": 40.1, "groups": groups}, "xai")
    # features: per-column quant_params (non-trivial offset), a constant column, an all-NaN column, clipping
    ndvi = np.array([0.12, 0.33, nan, 0.61, -0.05, 0.2])
    elev = np.array([198.0, 212.5, 240.25, 305.0, 251.0, nan])
    const = np.full(6, 0.25)
    allnan = np.full(6, nan)
    cols = []
    for name, arr in (("ndvi", ndvi), ("elevation", elev), ("frac_water", const), ("era5_wind", allnan)):
        s, o = qp(arr, "int16", nodata=-32768)
        cols.append({"name": name, "array": arr, "dtype": "int16", "scale": s, "offset": o, "nodata": -32768})
    s, o = qp(np.array([0.0, 1.0]), "int16", nodata=-32768)
    cols.append({"name": "frac_built", "array": np.array([0.0, 0.5, 1.0, 2.0, -1.0, nan]), "dtype": "int16",
                 "scale": s, "offset": o, "nodata": -32768})            # 2.0 / -1.0 are clipped to the range
    out["xai_2025_features_small.lstb.gz"] = (cols, {"year": 2025}, "features")
    # plain (not gzip) container with every dtype incl. scaled float32 and int32 with scale/offset
    out["mixed_plain.lstb"] = ([
        {"name": "i16", "array": np.array([[1.5, -2.25, nan], [327.67, -327.67, 0.0]]), "dtype": "int16",
         "scale": 0.01, "offset": 0.0, "nodata": -32768},
        {"name": "u8", "array": np.array([[0, 7, 254], [255, 3, 1]], np.uint8), "dtype": "uint8"},
        {"name": "i32", "array": np.array([[-5.5, 1e6, nan], [0.0, 2.5, -1e6]]), "dtype": "int32", "scale": 0.5,
         "offset": 100.0, "nodata": -2147483648},
        {"name": "f32", "array": np.array([[28.5, nan, -0.125], [1e-3, 3.25, 7.0]], np.float32), "dtype": "float32",
         "scale": 0.5, "offset": 10.0},
    ], {"note": "uncompressed container; readers must accept inflated payloads"}, "mixed")
    return out


def write_all(nb: dict) -> list:
    written = []
    for name, (cols, meta, kind) in fixtures(nb).items():
        path = HERE / name
        nb["lstb_write"](path, cols, meta=meta, kind=kind)
        back = nb["lstb_read"](path)
        header, raws = nb["lstb_parse"](path.read_bytes())
        expected = {"kind": back["header"]["kind"], "n": back["header"]["n"], "meta": back["header"]["meta"],
                    "columns": {k: _jsonable(v) for k, v in back["columns"].items()},
                    "raw": {k: (_jsonable(v) if np.asarray(v).dtype.kind == "f" else np.asarray(v).tolist())
                            for k, v in raws.items()},
                    "dtypes": {c["name"]: c["dtype"] for c in header["columns"]},
                    "generator": "notebook/sections/00_setup.py lstb_write via make_fixtures.py"}
        base = name[:-len(".lstb.gz")] if name.endswith(".lstb.gz") else name[:-len(".lstb")]
        (HERE / f"{base}.json").write_text(json.dumps(expected, separators=(",", ":"), allow_nan=False) + "\n",
                                           encoding="utf-8")
        written.append(name)
    return written


def _independent_decode(path: Path) -> dict:
    """Decoder written from the SPEC 5.1 text only (no notebook code)."""
    data = path.read_bytes()
    if data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
    assert data[:4] == b"LSTB" and data[4] == 1 and data[5:8] == b"\0\0\0"
    (hl,) = struct.unpack_from("<I", data, 8)
    header = json.loads(data[12:12 + hl])
    start = 12 + hl + ((-(12 + hl)) % 8)
    dts = {"int16": "<i2", "uint8": "u1", "int32": "<i4", "float32": "<f4"}
    out = {}
    for c in header["columns"]:
        assert (start + c["byte_offset"]) % 8 == 0
        raw = np.frombuffer(data, dtype=dts[c["dtype"]], count=int(np.prod(c["shape"])),
                            offset=start + c["byte_offset"]).reshape(c["shape"])
        v = raw.astype(np.float64) * c["scale"] + c["offset"]
        if c["nodata"] is not None:
            v[raw == c["nodata"]] = np.nan
        out[c["name"]] = v
    return out


def check_all() -> int:
    bad = 0
    names = sorted(p.name for p in HERE.iterdir() if p.name.endswith((".lstb", ".lstb.gz")))
    if not names:
        print("no fixtures found")
        return 1
    for name in names:
        base = name[:-len(".lstb.gz")] if name.endswith(".lstb.gz") else name[:-len(".lstb")]
        exp = json.loads((HERE / f"{base}.json").read_text(encoding="utf-8"))
        dec = _independent_decode(HERE / name)
        for col, vals in exp["columns"].items():
            want = np.array([np.nan if v is None else v for v in np.asarray(vals, dtype=object).ravel()], float)
            got = dec[col].ravel()
            same_nan = np.array_equal(np.isnan(want), np.isnan(got))
            diff = float(np.nanmax(np.abs(want - got))) if np.isfinite(want).any() else 0.0
            tol = 1e-6 * max(1.0, float(np.nanmax(np.abs(want))) if np.isfinite(want).any() else 1.0)
            if not (same_nan and diff <= tol):
                bad += 1
                print(f"MISMATCH {name}.{col}: NaN pattern {same_nan}, max diff {diff:.3g}")
        print(f"ok {name}: kind={exp['kind']} n={exp['n']} columns={list(exp['columns'])}")
    print("ALL FIXTURES DECODE" if not bad else f"{bad} MISMATCHES")
    return 1 if bad else 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="only verify the existing fixtures")
    args = ap.parse_args(argv)
    if not args.check:
        written = write_all(load_notebook_lstb())
        print(f"wrote {len(written)} fixtures to {HERE}")
    return check_all()


if __name__ == "__main__":
    sys.exit(main())
