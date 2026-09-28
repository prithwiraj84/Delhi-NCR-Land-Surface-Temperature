"""Validate a dashboard web bundle (outputs/web or dashboard/public/data) against docs/SPEC.md section 4.

Usage:
    python notebook/validate_bundle.py <web_dir> [--quiet] [--max-mb MB]

Standalone: needs only numpy (no pipeline globals), so it can be run on a bundle downloaded from Kaggle.
Exit status 0 = valid (warnings allowed), 1 = contract violations, 2 = bundle unreadable.

Every file may be gzip-compressed (SPEC 4: epoch_<year>.json.gz, dependence.json.gz); gzip is detected by its magic
bytes, so plain and compressed names are both accepted.

Checks (SPEC section in brackets):
* strict JSON everywhere: UTF-8, no NaN/Infinity tokens                                     [4]
* manifest keys, epochs/files consistency, canonical zones (ids, names, colours) and the
  25 canonical districts, feature metadata keys and value domains, bbox/center sanity       [4.1, 1.1]
* every epoch file: keys, array lengths == n, feature/shap key order == manifest order,
  zone ids in 0..3, lon/lat inside the bbox, rounding (lon/lat 5 dp, degC 2 dp, SHAP 3 dp),
  base_value_c == shap_base + epoch_mean (anomaly mode), and the SHAP waterfall invariant
  |lst_pred - (base_value_c + sum shap)| <= 0.05 degC for EVERY cell                          [4.2]
* model_web.json: format, feature order, tree array shapes, child indices, depth <= 6,
  rounds <= 400, thresholds are exact float32 values, and an independent evaluator of the
  compact format reproduces the 50 embedded check rows (< 1e-3)                              [4.3]
* dependence.json: bin arrays, CI ordering, scatter <= 1500 points, threshold keys/types, intervals
  only around existing point estimates and containing them, <k>_support in [0, 1],
  zero_crossing_flag ("multiple" only with a null zero_crossing)                             [4.4]
* shap_global.json (estimate inside its interval), zones.json (profiles; recommendations: intervention
  levers only, "associated with" wording, estimate inside its interval, step caps, zone p10/p90 bounds;
  4x4 transitions of consecutive epochs whose totals match the cells present in both epochs),
  metrics.json (hardware.rapids_used), interactions.json, scenario_coupling.json, districts.geojson  [4.5-4.8]
* manifest extras when present: data_mode_reason, bootstrap.ci_label / replicate_range / ci_method   [4.1]
* bundle size ON DISK (compressed): a warning above 25 MB for the dashboard's public/data by default; an
  error only when a limit is given explicitly with --max-mb
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
import sys
from pathlib import Path

import numpy as np

ZONES_CANONICAL = [
    {"id": 0, "name": "Ecological Cool Base", "color": "#34d399"},
    {"id": 1, "name": "Riparian Buffer", "color": "#22d3ee"},
    {"id": 2, "name": "Transition", "color": "#a78bfa"},
    {"id": 3, "name": "Heat Extreme Core", "color": "#fb7185"},
]
DISTRICT_NAMES = [
    "Delhi NCT", "Gurugram", "Faridabad", "Palwal", "Nuh", "Rewari", "Jhajjar", "Rohtak", "Sonipat", "Panipat",
    "Karnal", "Jind", "Bhiwani", "Charkhi Dadri", "Mahendragarh", "Meerut", "Ghaziabad", "Gautam Buddh Nagar",
    "Bulandshahr", "Baghpat", "Hapur", "Shamli", "Muzaffarnagar", "Alwar", "Bharatpur",
]
FEATURES_CANONICAL = [
    "ndvi", "ndwi", "ndbi", "elevation", "slope", "aspect_sin", "aspect_cos", "ntl", "log_pop",
    "frac_impervious", "frac_forest", "frac_water", "frac_cropland", "frac_barren", "lm_pd", "lm_ed", "lm_contag",
]
FRACTION_FEATURES = ["frac_impervious", "frac_forest", "frac_water", "frac_cropland", "frac_barren"]
SCHEMES = ["random", "spatial", "temporal"]
MODELS = ["linear", "ridge", "random_forest", "lightgbm", "xgboost", "gnn"]
THRESHOLD_KEYS = ["zero_crossing", "zero_crossing_ci", "breakpoint", "breakpoint_ci", "slope_before", "slope_after",
                  "saturation", "saturation_ci", "effect_range", "direction"]
FILE_KEYS = ["model", "shap_global", "dependence", "zones", "metrics", "districts", "interactions", "coupling"]
WATERFALL_TOL_C = 0.05
DEFAULT_WARN_MB = 25.0
# SPEC 4.6: recommendation levers and their per-action step caps (fractions 0.20, NDVI 0.15)
REC_LEVERS = {"frac_impervious", "frac_forest", "frac_water", "frac_cropland", "frac_barren", "ndvi",
              "lm_pd", "lm_ed", "lm_contag"}
REC_MAX_STEP = {**{f: 0.20 for f in FRACTION_FEATURES}, "ndvi": 0.15}
REC_DIRECTIONS = {"frac_impervious": {"decrease"}, "frac_barren": {"decrease"}, "frac_forest": {"increase"},
                  "frac_water": {"increase"}, "ndvi": {"increase"}}


class Report:
    """Collects errors (contract violations) and warnings (suspicious but allowed)."""

    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []
        self.info: list[str] = []

    def require(self, cond, msg: str) -> bool:
        if not cond:
            self.errors.append(msg)
        return bool(cond)

    def warn(self, cond, msg: str) -> bool:
        if not cond:
            self.warnings.append(msg)
        return bool(cond)


def _reject_constant(token):
    raise ValueError(f"non-JSON constant {token!r}")


def read_bytes(path: Path) -> bytes:
    """File bytes, gunzipped when they start with the gzip magic number 0x1f 0x8b (whatever the file name)."""
    raw = Path(path).read_bytes()
    return gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw


def load_strict(path: Path):
    """Parse UTF-8 JSON (plain or gzip), rejecting NaN / Infinity tokens (JSON.parse in the browser would too)."""
    return json.loads(read_bytes(path).decode("utf-8"), parse_constant=_reject_constant)


def _inside(est, ci, tol) -> bool:
    """est within [ci0 - tol, ci1 + tol] (True when either side is missing)."""
    if est is None or ci is None or not _is_num(est):
        return True
    return ci[0] - tol <= est <= ci[1] + tol


def _missing(obj, keys) -> list:
    return [k for k in keys if not isinstance(obj, dict) or k not in obj]


def _arr(values) -> np.ndarray:
    """JSON list (numbers / null) -> float64 array with NaN for null."""
    return np.array([np.nan if v is None else v for v in values], dtype=np.float64)


def _max_decimals_excess(values: np.ndarray, dp: int) -> float:
    """Largest |v - round(v, dp)| (0 when every finite value already has <= dp decimals)."""
    v = values[np.isfinite(values)]
    if v.size == 0:
        return 0.0
    return float(np.max(np.abs(v - np.round(v, dp))))


def _is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _ci_ok(ci) -> bool:
    return ci is None or (isinstance(ci, list) and len(ci) == 2 and all(_is_num(c) for c in ci) and ci[0] <= ci[1])


# ----------------------------------------------------------------------------------------------------------------
# 4.1 manifest
# ----------------------------------------------------------------------------------------------------------------
def check_manifest(man: dict, rep: Report):
    keys = ["schema_version", "generated_at", "data_mode", "study_area", "epochs", "season", "target_mode",
            "epoch_means", "features", "zones", "districts", "files", "data_sources", "synthetic_truth", "notes"]
    miss = _missing(man, keys)
    if not rep.require(not miss, f"manifest: missing keys {miss}"):
        return None
    rep.require(man["schema_version"] == "1.0", f"manifest.schema_version {man['schema_version']!r} != '1.0'")
    rep.require(man["data_mode"] in ("gee", "synthetic"), f"manifest.data_mode {man['data_mode']!r}")
    rep.require(man["target_mode"] in ("anomaly", "absolute"), f"manifest.target_mode {man['target_mode']!r}")
    rep.require((man["synthetic_truth"] is None) == (man["data_mode"] == "gee"),
                "manifest.synthetic_truth must be null exactly in gee mode")
    sa = man["study_area"]
    sa_miss = _missing(sa, ["name", "area_km2", "crs", "grid_res_m", "bbox", "center"])
    if rep.require(not sa_miss, f"manifest.study_area: missing {sa_miss}"):
        bbox, center = sa["bbox"], sa["center"]
        if rep.require(isinstance(bbox, list) and len(bbox) == 4 and all(_is_num(v) for v in bbox),
                       "manifest.study_area.bbox must be 4 numbers"):
            rep.require(bbox[0] < bbox[2] and bbox[1] < bbox[3], "manifest.study_area.bbox is not min<max")
            rep.require(-180 <= bbox[0] <= 180 and -90 <= bbox[1] <= 90, "manifest.study_area.bbox not lon/lat")
            if isinstance(center, list) and len(center) == 2:
                rep.require(bbox[0] <= center[0] <= bbox[2] and bbox[1] <= center[1] <= bbox[3],
                            "manifest.study_area.center outside bbox")
        rep.require(sa["crs"] == "EPSG:32643", f"manifest.study_area.crs {sa['crs']!r} != EPSG:32643")
        rep.require(_is_num(sa["grid_res_m"]) and sa["grid_res_m"] > 0, "manifest.study_area.grid_res_m")
        rep.require(_is_num(sa["area_km2"]) and sa["area_km2"] > 0, "manifest.study_area.area_km2")
    epochs = man["epochs"]
    rep.require(isinstance(epochs, list) and epochs == sorted(epochs) and len(epochs) >= 1, "manifest.epochs")
    rep.require(list(man["season"]) == ["04-01", "06-30"], f"manifest.season {man['season']}")
    rep.require(set(man["epoch_means"]) == {str(y) for y in epochs}, "manifest.epoch_means keys != epochs")
    rep.require(all(_is_num(v) for v in man["epoch_means"].values()), "manifest.epoch_means values")

    names = [f.get("name") for f in man["features"]]
    rep.require(names == FEATURES_CANONICAL, f"manifest.features order {names} != SPEC FEATURES")
    for f in man["features"]:
        fmiss = _missing(f, ["name", "label", "unit", "group", "description", "source", "actionable", "display",
                             "stats"])
        if not rep.require(not fmiss, f"manifest feature {f.get('name')}: missing {fmiss}"):
            continue
        rep.require(f["group"] in ("spectral", "terrain", "socioeconomic", "landcover", "landscape"),
                    f"feature {f['name']}: group {f['group']!r}")
        rep.require(f["display"] in ("index", "percent", "number"), f"feature {f['name']}: display {f['display']!r}")
        want_actionable = f["group"] in ("landcover", "landscape") or f["name"] == "ndvi"
        rep.require(f["actionable"] == want_actionable,
                    f"feature {f['name']}: actionable must be true exactly for land-cover fractions, landscape "
                    "metrics and NDVI (NDWI/NDBI are diagnostics, SPEC 3)")
        if f["name"].startswith("frac_"):
            rep.require(f["display"] == "percent", f"feature {f['name']}: fractions must display as percent")
        st = f["stats"]
        smiss = _missing(st, ["min", "max", "p01", "p99", "median", "mean", "std"])
        if rep.require(not smiss, f"feature {f['name']}.stats missing {smiss}") and all(
                _is_num(st[k]) for k in ("min", "p01", "median", "p99", "max")):
            rep.require(st["min"] <= st["p01"] <= st["median"] <= st["p99"] <= st["max"],
                        f"feature {f['name']}.stats not ordered min<=p01<=median<=p99<=max")

    zones = man["zones"]
    rep.require([{k: z.get(k) for k in ("id", "name", "color")} for z in zones] == ZONES_CANONICAL,
                "manifest.zones must be the 4 canonical zones (ids, names, colours)")
    dists = man["districts"]
    rep.require([d.get("id") for d in dists] == list(range(25)), "manifest.districts ids must be 0..24")
    rep.require([d.get("name") for d in dists] == DISTRICT_NAMES, "manifest.districts names differ from SPEC 1.1")
    files = man["files"]
    fmiss = _missing(files, ["epochs"] + FILE_KEYS)
    rep.require(not fmiss, f"manifest.files missing {fmiss}")
    if not fmiss:
        rep.require(set(files["epochs"]) == {str(y) for y in epochs}, "manifest.files.epochs keys != epochs")
    rep.require(isinstance(man["data_sources"], dict) and all(isinstance(v, dict) for v in man["data_sources"].values()),
                "manifest.data_sources must be {variable: {year: provenance}}")
    rep.require(isinstance(man["notes"], list) and all(isinstance(n, str) for n in man["notes"]),
                "manifest.notes must be a list of strings")
    if man["data_mode"] == "synthetic":
        rep.warn(any("SYNTHETIC" in n.upper() for n in man["notes"]), "manifest.notes lack a SYNTHETIC caveat")
    rep.warn("shap_base" in man, "manifest has no shap_base (base_value_c consistency check skipped)")
    if "boundary_approximate" in sa:
        rep.require(isinstance(sa["boundary_approximate"], bool), "manifest.study_area.boundary_approximate must be bool")
        if sa["boundary_approximate"] and man["data_mode"] == "gee":
            rep.warn(any("APPROXIMATE" in n.upper() for n in man["notes"]),
                     "approximate district boundaries in gee mode without a caveat in manifest.notes")
    if "data_mode_reason" in man:
        rep.require(man["data_mode_reason"] is None or isinstance(man["data_mode_reason"], str),
                    "manifest.data_mode_reason must be a string or null")
    boot = man.get("bootstrap")
    if isinstance(boot, dict):
        if "ci_label" in boot:
            # "bootstrap range" is the pre-2026-09 spelling of "replicate range" (still accepted)
            rep.require(boot["ci_label"] in ("95% CI", "replicate range", "bootstrap range"),
                        f"manifest.bootstrap.ci_label {boot['ci_label']!r}")
        if "replicate_range" in boot:
            rep.require(isinstance(boot["replicate_range"], bool), "manifest.bootstrap.replicate_range must be bool")
            if _is_num(boot.get("n")) and isinstance(boot["replicate_range"], bool):
                rep.require(boot["replicate_range"] == (boot["n"] < 50),
                            "manifest.bootstrap.replicate_range must be true exactly when n < 50")
            if boot.get("ci_label") and isinstance(boot["replicate_range"], bool):
                rep.require((boot["ci_label"] == "95% CI") != boot["replicate_range"],
                            "manifest.bootstrap.ci_label disagrees with replicate_range")
        if "ci_method" in boot:
            rep.require(isinstance(boot["ci_method"], str) and boot["ci_method"],
                        "manifest.bootstrap.ci_method must be a non-empty string")
            rep.warn(boot.get("ci_method") in ("recentred-percentile", "basic", "percentile", "bca", "subsampling"),
                     f"manifest.bootstrap.ci_method {boot.get('ci_method')!r} is not a known method code")
    return names


# ----------------------------------------------------------------------------------------------------------------
# 4.2 epoch files
# ----------------------------------------------------------------------------------------------------------------
def check_epoch(ep: dict, year: int, man: dict, names: list, rep: Report) -> dict:
    tag = f"epoch_{year}"
    keys = ["year", "n", "cell_size_m", "epoch_mean", "base_value_c", "cell_id", "lon", "lat", "district",
            "lst_obs", "lst_pred", "lst_pred_oof", "resid_oof", "zone", "features", "shap"]
    miss = _missing(ep, keys)
    if not rep.require(not miss, f"{tag}: missing keys {miss}"):
        return {}
    n = ep["n"]
    rep.require(ep["year"] == year, f"{tag}: year {ep['year']} != {year}")
    rep.require(isinstance(n, int) and n > 0, f"{tag}: n must be a positive int")
    rep.require(ep["cell_size_m"] == man["study_area"]["grid_res_m"], f"{tag}: cell_size_m != manifest grid_res_m")
    lengths_ok = True
    for k in ("cell_id", "lon", "lat", "district", "lst_obs", "lst_pred", "lst_pred_oof", "resid_oof", "zone"):
        lengths_ok &= rep.require(len(ep[k]) == n, f"{tag}.{k}: length {len(ep[k])} != n {n}")
    for grp in ("features", "shap"):
        rep.require(list(ep[grp]) == names, f"{tag}.{grp}: keys differ from manifest feature order")
        for f, arr in ep[grp].items():
            lengths_ok &= rep.require(len(arr) == n, f"{tag}.{grp}.{f}: length {len(arr)} != n")
    if not lengths_ok:
        return {}

    cell_id = np.asarray(ep["cell_id"], dtype=np.int64)
    rep.require(np.all(np.diff(cell_id) > 0), f"{tag}.cell_id must be strictly increasing (DF row order)")
    zone = np.asarray(ep["zone"])
    rep.require(set(np.unique(zone).tolist()) <= {0, 1, 2, 3}, f"{tag}: zone ids outside 0..3")
    district = np.asarray(ep["district"])
    rep.require(np.all((district >= -1) & (district < 25)), f"{tag}: district ids outside -1..24")

    lon, lat = _arr(ep["lon"]), _arr(ep["lat"])
    rep.require(np.isfinite(lon).all() and np.isfinite(lat).all(), f"{tag}: lon/lat contain null")
    bbox = man["study_area"]["bbox"]
    rep.require(np.all((lon >= bbox[0] - 1e-5) & (lon <= bbox[2] + 1e-5) & (lat >= bbox[1] - 1e-5)
                       & (lat <= bbox[3] + 1e-5)), f"{tag}: cell centres outside manifest bbox")
    rep.require(_max_decimals_excess(lon, 5) < 1e-9 and _max_decimals_excess(lat, 5) < 1e-9,
                f"{tag}: lon/lat not rounded to 5 dp")

    lst_obs, lst_pred = _arr(ep["lst_obs"]), _arr(ep["lst_pred"])
    oof, resid = _arr(ep["lst_pred_oof"]), _arr(ep["resid_oof"])
    rep.require(np.isfinite(lst_pred).all(), f"{tag}: lst_pred contains null")
    rep.require(np.isfinite(lst_obs).all(), f"{tag}: lst_obs contains null (rows need a valid target)")
    for name, v in (("lst_obs", lst_obs), ("lst_pred", lst_pred), ("lst_pred_oof", oof), ("resid_oof", resid)):
        rep.require(_max_decimals_excess(v, 2) < 1e-9, f"{tag}.{name}: not rounded to 2 dp")
    fin = np.isfinite(lst_obs)
    rep.require(np.all((lst_obs[fin] > -10) & (lst_obs[fin] < 80)), f"{tag}.lst_obs outside plausible degC range")
    both = np.isfinite(oof) & np.isfinite(resid) & fin
    if both.any():
        rep.require(np.max(np.abs(lst_obs[both] - oof[both] - resid[both])) <= 0.011,
                    f"{tag}: resid_oof != lst_obs - lst_pred_oof")
    rep.warn(np.isfinite(oof).mean() > 0.95 if n else True, f"{tag}: lst_pred_oof is mostly null")

    epoch_mean = float(man["epoch_means"][str(year)])
    rep.require(abs(ep["epoch_mean"] - epoch_mean) <= 0.011, f"{tag}: epoch_mean differs from manifest")
    offset = epoch_mean if man["target_mode"] == "anomaly" else 0.0
    if "shap_base" in man and _is_num(man["shap_base"]):
        rep.require(abs(ep["base_value_c"] - (man["shap_base"] + offset)) <= 0.011,
                    f"{tag}: base_value_c {ep['base_value_c']} != shap_base + epoch_mean")

    shap = np.array([_arr(ep["shap"][f]) for f in names])
    rep.require(np.isfinite(shap).all(), f"{tag}: shap contains null")
    rep.require(_max_decimals_excess(shap, 3) < 1e-9, f"{tag}: shap not rounded to 3 dp")
    err = np.abs(ep["base_value_c"] + np.nansum(shap, axis=0) - lst_pred)
    rep.require(float(np.nanmax(err)) <= WATERFALL_TOL_C,
                f"{tag}: waterfall invariant violated for {int((err > WATERFALL_TOL_C).sum())} cells "
                f"(max err {float(np.nanmax(err)):.3f} degC)")
    feats = np.array([_arr(ep["features"][f]) for f in names])
    for j, f in enumerate(names):
        col = feats[j][np.isfinite(feats[j])]
        if f.startswith("frac_") and col.size:
            rep.require(col.min() >= 0 and col.max() <= 1, f"{tag}.features.{f} outside [0, 1]")
        if f in ("ndvi", "ndwi", "ndbi") and col.size:
            rep.require(col.min() >= -1 and col.max() <= 1, f"{tag}.features.{f} outside [-1, 1]")
    rep.warn(np.isfinite(feats).mean() > 0.9, f"{tag}: more than 10% of feature values are null")
    return {"cell_id": cell_id, "zone": zone, "n": n, "waterfall_max_err": float(np.nanmax(err)),
            "features": {f: feats[j] for j, f in enumerate(names)}}


# ----------------------------------------------------------------------------------------------------------------
# 4.3 compact model
# ----------------------------------------------------------------------------------------------------------------
def predict_compact(model: dict, X: np.ndarray) -> np.ndarray:
    """Reference evaluator of lst-xgb-compact-v1 (SPEC 4.3): strict '<' goes left, missing follows d."""
    X = np.asarray(X, dtype=np.float64)
    out = np.full(X.shape[0], float(model["base_score"]))
    for tree in model["trees"]:
        f = np.asarray(tree["f"], np.int64)
        t = np.asarray(tree["t"], np.float64)
        left = np.asarray(tree["l"], np.int64)
        right = np.asarray(tree["r"], np.int64)
        dflt = np.asarray(tree["d"], np.int64)
        v = np.asarray(tree["v"], np.float64)
        node = np.zeros(X.shape[0], np.int64)
        for _ in range(64):
            active = np.flatnonzero(left[node] != -1)
            if active.size == 0:
                break
            nd = node[active]
            xv = X[active, f[nd]]
            go_left = np.where(np.isnan(xv), dflt[nd] == 1, xv < t[nd])
            node[active] = np.where(go_left, left[nd], right[nd])
        out += v[node]
    return out


def _tree_depth(left: list, right: list) -> int:
    depth, frontier = 0, [0]
    while True:
        nxt = [c for n in frontier for c in (left[n], right[n]) if left[n] != -1 and c != -1]
        if not nxt:
            return depth
        depth += 1
        frontier = nxt
        if depth > 64:
            return depth


def check_model(model: dict, names: list, man: dict, rep: Report) -> None:
    keys = ["format", "objective", "target_mode", "features", "base_score", "n_trees", "trees", "fidelity", "check"]
    miss = _missing(model, keys)
    if not rep.require(not miss, f"model_web: missing keys {miss}"):
        return
    rep.require(model["format"] == "lst-xgb-compact-v1", "model_web: bad format")
    rep.require(model["target_mode"] == man["target_mode"], "model_web.target_mode != manifest.target_mode")
    rep.require(model["features"] == names, "model_web: feature order differs from manifest")
    rep.require(_is_num(model["base_score"]), "model_web.base_score must be a number")
    rep.require(model["n_trees"] == len(model["trees"]), "model_web: n_trees != len(trees)")
    rep.require(0 < len(model["trees"]) <= 400, f"model_web: {len(model['trees'])} trees (must be 1..400)")
    fid = model["fidelity"]
    rep.require(not _missing(fid, ["r2_vs_final", "rmse_vs_final", "r2_vs_obs", "max_depth", "rounds"]),
                "model_web.fidelity keys")
    rep.require(fid.get("max_depth", 99) <= 6 and fid.get("rounds", 999) <= 400, "model_web.fidelity depth/rounds")
    if _is_num(fid.get("r2_vs_final")):
        rep.warn(fid["r2_vs_final"] >= 0.95, f"model_web surrogate R2 vs final model only {fid['r2_vs_final']:.3f}")
    max_depth, bad_thr = 0, 0
    for i, t in enumerate(model["trees"]):
        lens = {k: len(t.get(k, [])) for k in ("f", "t", "l", "r", "d", "v")}
        if not rep.require(len(set(lens.values())) == 1, f"model_web tree {i}: array lengths {lens}"):
            return
        m = lens["f"]
        kids = [c for c in t["l"] + t["r"] if c != -1]
        if not rep.require(all(0 < c < m for c in kids), f"model_web tree {i}: child index out of range"):
            return
        rep.require(all((lc == -1) == (rc == -1) for lc, rc in zip(t["l"], t["r"])),
                    f"model_web tree {i}: node with exactly one child")
        rep.require(all(0 <= f < len(names) for f, lc in zip(t["f"], t["l"]) if lc != -1),
                    f"model_web tree {i}: split feature out of range")
        rep.require(all(d in (0, 1) for d in t["d"]), f"model_web tree {i}: d must be 0/1")
        bad_thr += sum(1 for thr, lc in zip(t["t"], t["l"]) if lc != -1 and float(np.float32(thr)) != float(thr))
        max_depth = max(max_depth, _tree_depth(t["l"], t["r"]))
    rep.require(max_depth <= 6, f"model_web: tree depth {max_depth} > 6")
    rep.require(bad_thr == 0, f"model_web: {bad_thr} thresholds are not exact float32 values")
    rows = model["check"].get("rows", [])
    expected = model["check"].get("expected", [])
    rep.require(len(rows) == 50 and all(len(r) == len(names) for r in rows), "model_web.check: need 50 rows of K values")
    rep.require(len(expected) == len(rows), "model_web.check: expected length != rows")
    if rows and len(expected) == len(rows):
        X = np.array([[np.nan if v is None else v for v in r] for r in rows], dtype=np.float64)
        diff = float(np.max(np.abs(predict_compact(model, X) - np.asarray(expected, np.float64))))
        rep.require(diff < 1e-3, f"model_web.check: evaluator differs from expected by {diff:.2e}")
        rep.warn(np.isnan(X).any(), "model_web.check rows contain no missing values (default directions untested)")


# ----------------------------------------------------------------------------------------------------------------
# 4.4 - 4.8
# ----------------------------------------------------------------------------------------------------------------
def check_dependence(dep: dict, names: list, rep: Report) -> None:
    feats = dep.get("features", {}) if isinstance(dep, dict) else {}
    rep.require(list(feats) == names, "dependence: features differ from manifest order")
    for f, d in feats.items():
        miss = _missing(d, ["bin_centers", "mean", "ci_lo", "ci_hi", "count", "scatter", "threshold"])
        if not rep.require(not miss, f"dependence.{f}: missing {miss}"):
            continue
        nb = len(d["bin_centers"])
        rep.require(2 <= nb <= 40, f"dependence.{f}: {nb} bins (expected 2..40)")
        if not rep.require(all(len(d[k]) == nb for k in ("mean", "ci_lo", "ci_hi", "count")),
                           f"dependence.{f}: bin array lengths differ"):
            continue
        centers = _arr(d["bin_centers"])
        rep.require(np.all(np.diff(centers[np.isfinite(centers)]) > 0), f"dependence.{f}: bin_centers not increasing")
        lo, hi, mean = _arr(d["ci_lo"]), _arr(d["ci_hi"]), _arr(d["mean"])
        ok = np.isfinite(lo) & np.isfinite(hi)
        rep.require(np.all(lo[ok] <= hi[ok] + 1e-9), f"dependence.{f}: ci_lo > ci_hi")
        inside = ok & np.isfinite(mean)
        if inside.sum() >= 5:
            share = float(np.mean((mean[inside] >= lo[inside] - 0.05) & (mean[inside] <= hi[inside] + 0.05)))
            rep.warn(share >= 0.7, f"dependence.{f}: final-model curve inside the bootstrap band in only "
                                   f"{100 * share:.0f}% of bins")
        rep.require(all(isinstance(c, int) and c >= 0 for c in d["count"]), f"dependence.{f}: counts")
        sc = d["scatter"]
        ns = len(sc.get("x", []))
        rep.require(ns <= 1500 and all(len(sc.get(k, [])) == ns for k in ("shap", "color", "zone", "year")),
                    f"dependence.{f}.scatter: lengths")
        rep.require(sc.get("color_feature") in names and sc.get("color_feature") != f,
                    f"dependence.{f}.scatter.color_feature {sc.get('color_feature')!r}")
        th = d["threshold"]
        tmiss = _missing(th, THRESHOLD_KEYS)
        if not rep.require(not tmiss, f"dependence.{f}.threshold missing {tmiss}"):
            continue
        rep.require(th["direction"] in ("cooling", "warming", "mixed"), f"dependence.{f}.threshold.direction")
        for k in ("zero_crossing", "breakpoint", "saturation", "slope_before", "slope_after", "effect_range"):
            rep.require(th[k] is None or _is_num(th[k]), f"dependence.{f}.threshold.{k} must be number|null")
        for k in ("zero_crossing", "breakpoint", "saturation"):
            rep.require(_ci_ok(th[f"{k}_ci"]), f"dependence.{f}.threshold.{k}_ci must be [lo<=hi] or null")
            rep.require(th[k] is not None or th[f"{k}_ci"] is None,
                        f"dependence.{f}.threshold.{k}_ci is given although {k} is null (SPEC 4.4)")
            rep.require(_inside(th[k], th[f"{k}_ci"], 1e-6 * max(1.0, abs(th[k] or 0.0))),
                        f"dependence.{f}.threshold.{k} {th[k]} lies outside its interval {th[f'{k}_ci']}")
            sup = th.get(f"{k}_support")
            rep.require(sup is None or (_is_num(sup) and 0 <= sup <= 1),
                        f"dependence.{f}.threshold.{k}_support must be in [0, 1] or null")
            if _is_num(sup) and th[k] is not None:
                rep.warn(sup >= 0.8, f"dependence.{f}.threshold.{k} found by only {100 * sup:.0f}% of replicates")
        if "zero_crossing_flag" in th:
            rep.require(th["zero_crossing_flag"] in (None, "multiple"),
                        f"dependence.{f}.threshold.zero_crossing_flag must be 'multiple' or null")
            rep.require(th["zero_crossing_flag"] != "multiple" or th["zero_crossing"] is None,
                        f"dependence.{f}.threshold: zero_crossing_flag 'multiple' with a zero_crossing value")
        if "zero_crossing_multiple" in th:   # older bundles
            rep.require(isinstance(th["zero_crossing_multiple"], bool),
                        f"dependence.{f}.threshold.zero_crossing_multiple must be bool")


def check_shap_global(sg: dict, names: list, epochs: list, rep: Report) -> None:
    miss = _missing(sg, ["features", "n_bootstrap", "bootstrap_mode", "global", "by_epoch", "by_zone"])
    if not rep.require(not miss, f"shap_global: missing keys {miss}"):
        return
    k = len(names)
    rep.require(sg["features"] == names, "shap_global: feature order")
    rep.require(isinstance(sg["n_bootstrap"], int) and sg["n_bootstrap"] >= 1, "shap_global.n_bootstrap")
    g = sg["global"]
    if rep.require(all(len(g.get(key, [])) == k for key in ("mean_abs", "ci_lo", "ci_hi")),
                   "shap_global.global: arrays must have K values"):
        ma, lo, hi = _arr(g["mean_abs"]), _arr(g["ci_lo"]), _arr(g["ci_hi"])
        rep.require(np.all(ma >= 0) and np.all(lo <= hi + 1e-9), "shap_global.global: negative mean_abs or lo > hi")
        ok = np.isfinite(ma) & np.isfinite(lo) & np.isfinite(hi)
        outside = [names[j] for j in np.flatnonzero(ok & ((ma < lo - 1e-9) | (ma > hi + 1e-9)))]
        rep.require(not outside, f"shap_global.global: mean_abs outside its interval for {outside}")
    rep.require(set(sg["by_epoch"]) == {str(y) for y in epochs}, "shap_global.by_epoch keys != epochs")
    rep.require(set(sg["by_zone"]) <= {"0", "1", "2", "3"}, "shap_global.by_zone keys")
    for grp in ("by_epoch", "by_zone"):
        for key, v in sg[grp].items():
            rep.require(len(v.get("mean_abs", [])) == k and len(v.get("mean", [])) == k,
                        f"shap_global.{grp}.{key}: arrays must have K values")


def _check_recommendation_bounds(z: dict, r: dict, epochs: list, epoch_info: dict, rep: Report) -> None:
    """SPEC 4.6 feasibility: step caps (error) and the zone's own p10/p90 of the last epoch (warning)."""
    f, cur, tgt = r["feature"], r["current"], r["target"]
    if not (_is_num(cur) and _is_num(tgt)):
        return
    cap = REC_MAX_STEP.get(f)
    if cap is not None:
        rep.require(abs(tgt - cur) <= cap + 2e-3 * max(1.0, abs(cur)),
                    f"zones[{z['id']}] recommendation {f}: step {tgt - cur:+.4f} exceeds the cap {cap}")
    info = epoch_info.get(int(epochs[-1]))
    if not info or "features" not in info or f not in info["features"]:
        return
    vals = info["features"][f][(info["zone"] == z["id"])]
    vals = vals[np.isfinite(vals)]
    if vals.size < 10:
        return
    p10, p90 = np.percentile(vals, [10, 90])
    tol = 2e-3 * max(1.0, float(np.max(np.abs(vals))))
    if r["action"] == "increase":
        rep.warn(tgt <= p90 + tol, f"zones[{z['id']}] recommendation {f}: target {tgt} above the zone p90 {p90:.4g}")
    else:
        rep.warn(tgt >= p10 - tol, f"zones[{z['id']}] recommendation {f}: target {tgt} below the zone p10 {p10:.4g}")


def check_zones(zj: dict, names: list, epochs: list, epoch_info: dict, rep: Report, man: dict = None) -> None:
    miss = _missing(zj, ["k", "silhouette", "diagnostics", "zones", "transitions"])
    if not rep.require(not miss, f"zones: missing keys {miss}"):
        return
    rep.require(zj["k"] == 4, "zones.k must be 4")
    rep.require([{k: z.get(k) for k in ("id", "name", "color")} for z in zj["zones"]] == ZONES_CANONICAL,
                "zones.zones must be the canonical zones in id order")
    rep.require(_is_num(zj["silhouette"]) and -1 <= zj["silhouette"] <= 1, "zones.silhouette")
    dg = zj["diagnostics"]
    rep.require(len(dg.get("k", [])) == len(dg.get("inertia", [])) == len(dg.get("silhouette", [])) > 0,
                "zones.diagnostics lengths")
    zkeys = ["id", "name", "color", "description", "n_cells", "area_km2", "lst_obs_mean", "lst_pred_mean",
             "feature_means", "shap_means", "top_warming", "top_cooling", "top_interactions", "top_districts",
             "recommendations"]
    last = str(epochs[-1])
    for z in zj["zones"]:
        zmiss = _missing(z, zkeys)
        if not rep.require(not zmiss, f"zones[{z.get('id')}]: missing {zmiss}"):
            continue
        for key in ("n_cells", "area_km2", "lst_obs_mean", "lst_pred_mean"):
            rep.require(set(z[key]) == {str(y) for y in epochs}, f"zones[{z['id']}].{key} keys != epochs")
        rep.require(list(z["feature_means"]) == names and list(z["shap_means"]) == names,
                    f"zones[{z['id']}]: feature_means/shap_means order")
        for y in epochs:
            info = epoch_info.get(int(y))
            if info and "zone" in info:
                rep.require(z["n_cells"][str(y)] == int((info["zone"] == z["id"]).sum()),
                            f"zones[{z['id']}].n_cells[{y}] disagrees with epoch_{y}.json")
        rep.warn(sum(z["n_cells"].values()) > 0, f"zones[{z['id']}] is empty in every epoch")
        rep.require(all(t["shap"] > 0 for t in z["top_warming"]) and all(t["shap"] < 0 for t in z["top_cooling"]),
                    f"zones[{z['id']}]: top_warming must be > 0 and top_cooling < 0")
        recs = z["recommendations"]
        rep.require(len(recs) <= 4, f"zones[{z['id']}]: more than 4 recommendations")
        deltas = [r.get("expected_delta_c") for r in recs]
        rep.require(deltas == sorted(deltas), f"zones[{z['id']}]: recommendations not sorted by expected delta")
        for r in recs:
            rmiss = _missing(r, ["feature", "action", "current", "target", "expected_delta_c", "ci", "priority",
                                 "rationale"])
            if not rep.require(not rmiss, f"zones[{z['id']}] recommendation missing {rmiss}"):
                continue
            d = r["expected_delta_c"]
            rep.require(r["feature"] in names and r["action"] in ("increase", "decrease"),
                        f"zones[{z['id']}] recommendation feature/action {r['feature']}/{r['action']}")
            rep.require(_is_num(d) and d < -0.05 + 0.005, f"zones[{z['id']}] recommendation {r['feature']}: delta {d}")
            want = "high" if d <= -1.0 else ("medium" if d <= -0.3 else "low")
            rep.require(r["priority"] == want, f"zones[{z['id']}] recommendation {r['feature']}: priority "
                                               f"{r['priority']} but delta {d} implies {want}")
            rep.require((r["action"] == "increase") == (r["target"] > r["current"]),
                        f"zones[{z['id']}] recommendation {r['feature']}: action inconsistent with target")
            rep.require(_ci_ok(r["ci"]), f"zones[{z['id']}] recommendation {r['feature']}: ci")
            rep.require(_inside(d, r["ci"], 0.011),
                        f"zones[{z['id']}] recommendation {r['feature']}: delta {d} outside its interval {r['ci']}")
            actionable = {ft["name"] for ft in (man or {}).get("features", []) if ft.get("actionable")}
            rep.require(r["feature"] in REC_LEVERS and (not actionable or r["feature"] in actionable),
                        f"zones[{z['id']}] recommendation {r['feature']}: not an intervention lever (SPEC 4.6)")
            allowed = REC_DIRECTIONS.get(r["feature"])
            rep.require(allowed is None or r["action"] in allowed,
                        f"zones[{z['id']}] recommendation {r['feature']}: action {r['action']} is not a plausible "
                        f"intervention (allowed: {sorted(allowed or [])})")
            rep.require("associated with" in str(r["rationale"]),
                        f"zones[{z['id']}] recommendation {r['feature']}: rationale must say 'associated with' "
                        "(SHAP / model counterfactuals are not causal)")
            if r["ci"] is not None:
                rep.warn(any(tok in str(r["rationale"]) for tok in ("CI", "range")),
                         f"zones[{z['id']}] recommendation {r['feature']}: rationale does not quote the interval")
            _check_recommendation_bounds(z, r, epochs, epoch_info, rep)
    for key, mat in zj["transitions"].items():
        if not rep.require(len(mat) == 4 and all(len(row) == 4 for row in mat), f"zones.transitions[{key}]: 4x4"):
            continue
        a, _, b = key.partition("->")
        ia, ib = epoch_info.get(int(a)) if a.isdigit() else None, epoch_info.get(int(b)) if b.isdigit() else None
        if ia and ib and "cell_id" in ia and "cell_id" in ib:
            common = np.intersect1d(ia["cell_id"], ib["cell_id"]).size
            rep.require(int(np.sum(mat)) == common, f"zones.transitions[{key}] total {int(np.sum(mat))} != "
                                                    f"{common} cells present in both epochs")
    expected_keys = {f"{a}->{b}" for a, b in zip(epochs[:-1], epochs[1:])}
    rep.require(set(zj["transitions"]) == expected_keys, f"zones.transitions keys {sorted(zj['transitions'])}")
    _ = last


def check_metrics(metrics: dict, rep: Report) -> None:
    miss = _missing(metrics, ["schemes", "models", "summary", "folds", "moran", "moran_target", "moran_scatter",
                              "hardware", "timings"])
    if not rep.require(not miss, f"metrics: missing keys {miss}"):
        return
    rep.require(metrics["schemes"] == SCHEMES and metrics["models"] == MODELS, "metrics: schemes/models lists")
    for rec in metrics["summary"]:
        rep.require(not _missing(rec, ["scheme", "model", "r2_mean", "r2_std", "rmse_mean", "rmse_std", "mae_mean",
                                       "mae_std", "n_folds"]), "metrics.summary record keys")
    for rec in metrics["folds"]:
        rep.require(not _missing(rec, ["scheme", "model", "fold", "r2", "rmse", "mae", "n_train", "n_test",
                                       "fit_seconds", "device"]), "metrics.folds record keys")
    for rec in metrics["moran"]:
        rep.require(not _missing(rec, ["scheme", "model", "year", "I", "expected_I", "z", "p"]), "metrics.moran keys")
    for rec in metrics["moran_target"]:
        rep.require(not _missing(rec, ["year", "I", "expected_I", "z", "p"]), "metrics.moran_target keys")
    for m, v in metrics["moran_scatter"].items():
        ok = not _missing(v, ["year", "z", "lag", "slope"]) and len(v["z"]) == len(v["lag"]) <= 2000
        rep.require(ok, f"metrics.moran_scatter.{m}: keys / lengths")
    hw = metrics["hardware"]
    rep.require(not _missing(hw, ["gpus", "xgb_device", "lgbm_device", "rapids"]), "metrics.hardware keys")
    if "rapids_used" in hw:
        used = hw["rapids_used"]
        ok = (isinstance(used, list) and all(isinstance(u, str) for u in used)) or (
            isinstance(used, dict) and all(isinstance(v, bool) for v in used.values()))
        if rep.require(ok, "metrics.hardware.rapids_used must be a list of names or {component: bool}"):
            any_used = bool(used) if isinstance(used, list) else any(used.values())
            rep.require(hw.get("rapids") == any_used, "metrics.hardware.rapids disagrees with rapids_used")
    xgb_sp = [r for r in metrics["summary"] if r["scheme"] == "spatial" and r["model"] == "xgboost"]
    rep.warn(bool(xgb_sp), "metrics: no spatial-CV XGBoost summary")
    present = {(r["scheme"], r["model"]) for r in metrics["summary"]}
    missing_pairs = [f"{s}/{m}" for s in SCHEMES for m in MODELS if (s, m) not in present]
    rep.warn(not missing_pairs, f"metrics.summary lacks {missing_pairs}")


def check_small_files(inter: dict, coupling: dict, geo: dict, names: list, rep: Report) -> None:
    k = len(names)
    rep.require(inter.get("features") == names, "interactions: feature order")
    mats = [inter.get("global", [])] + list(inter.get("by_zone", {}).values())
    rep.require(all(len(m) == k and all(len(r) == k for r in m) for m in mats), "interactions: K x K matrices")
    rep.require(set(inter.get("by_zone", {})) <= {"0", "1", "2", "3"}, "interactions.by_zone keys")
    if mats and len(mats[0]) == k:
        g = np.array([[np.nan if v is None else v for v in row] for row in mats[0]], dtype=np.float64)
        rep.require(np.allclose(g, g.T, atol=2e-4, equal_nan=True), "interactions.global must be symmetric")
    rep.require(coupling.get("fraction_features") == FRACTION_FEATURES, "scenario_coupling.fraction_features")
    rep.require(isinstance(coupling.get("description"), str), "scenario_coupling.description")
    rep.require(all(set(coupling.get("coupling", {}).get(f, {})) >= {"ndvi", "ndwi", "ndbi"}
                    and all(_is_num(v) for v in coupling["coupling"][f].values()) for f in FRACTION_FEATURES),
                "scenario_coupling.coupling must give numeric ndvi/ndwi/ndbi slopes per fraction")
    rep.require(geo.get("type") == "FeatureCollection", "districts.geojson: not a FeatureCollection")
    feats = geo.get("features", [])
    rep.require(all(set(ft.get("properties", {})) == {"id", "name", "state"} for ft in feats),
                "districts.geojson: properties must be exactly id/name/state")
    rep.require(all(ft.get("geometry", {}).get("type") in ("Polygon", "MultiPolygon") for ft in feats),
                "districts.geojson: geometries must be (Multi)Polygon")
    ids = [ft.get("properties", {}).get("id") for ft in feats]
    rep.require(len(ids) == len(set(ids)) and all(isinstance(i, int) and 0 <= i < 25 for i in ids),
                "districts.geojson: ids must be unique in 0..24")
    rep.warn(len(feats) == 25, f"districts.geojson has {len(feats)} features (25 expected unless GEE layers lack some)")


def validate_bundle(web_dir, max_mb: float = None) -> Report:
    """Run every check on ``web_dir``; returns the Report (errors empty = valid).

    ``max_mb`` None: warn when the on-disk (compressed) bundle exceeds 25 MB; a number: that limit is an error.
    """
    web_dir = Path(web_dir)
    rep = Report()
    man_path = web_dir / "manifest.json"
    if not man_path.is_file():
        rep.errors.append(f"{man_path} not found")
        return rep
    man = load_strict(man_path)
    names = check_manifest(man, rep)
    if names is None:
        return rep
    files = man["files"]
    needed = list(files["epochs"].values()) + [files[k] for k in FILE_KEYS if k in files]
    for fname in needed:
        rep.require((web_dir / fname).is_file(), f"missing file {fname}")
    if rep.errors:
        return rep
    epochs = [int(y) for y in man["epochs"]]
    epoch_info = {}
    for y in epochs:
        epoch_info[y] = check_epoch(load_strict(web_dir / files["epochs"][str(y)]), y, man, names, rep)
    if epoch_info:
        rep.info.append("waterfall max err per epoch: " + ", ".join(
            f"{y}: {v.get('waterfall_max_err', float('nan')):.3f}" for y, v in epoch_info.items()))
        rep.info.append("cells per epoch: " + ", ".join(f"{y}: {v.get('n')}" for y, v in epoch_info.items()))
    check_model(load_strict(web_dir / files["model"]), names, man, rep)
    check_shap_global(load_strict(web_dir / files["shap_global"]), names, epochs, rep)
    check_dependence(load_strict(web_dir / files["dependence"]), names, rep)
    check_zones(load_strict(web_dir / files["zones"]), names, epochs, epoch_info, rep, man)
    check_metrics(load_strict(web_dir / files["metrics"]), rep)
    check_small_files(load_strict(web_dir / files["interactions"]), load_strict(web_dir / files["coupling"]),
                      load_strict(web_dir / files["districts"]), names, rep)
    bundle_files = [web_dir / "manifest.json"] + [web_dir / fname for fname in needed]
    total = sum(p.stat().st_size for p in bundle_files if p.is_file())
    compressed = [p.name for p in bundle_files if p.is_file() and p.read_bytes()[:2] == b"\x1f\x8b"]
    rep.info.append(f"bundle size on disk {total / 1e6:.2f} MB in {len(bundle_files)} files "
                    f"({len(compressed)} gzip-compressed)")
    if max_mb is None:
        rep.warn(total <= DEFAULT_WARN_MB * 1e6, f"bundle is {total / 1e6:.1f} MB on disk > {DEFAULT_WARN_MB:g} MB "
                                                 "(slow to load over mobile connections)")
    else:
        rep.require(total <= max_mb * 1e6, f"bundle is {total / 1e6:.1f} MB on disk > {max_mb:g} MB limit")
    stray = sorted(p.name for p in web_dir.iterdir() if p.is_file() and p.name.endswith((".json", ".json.gz"))
                   and p not in bundle_files)
    rep.warn(not stray, f"files not referenced by the manifest (stale export?): {stray}")
    return rep


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("web_dir", type=Path)
    ap.add_argument("--max-mb", type=float, default=None,
                    help="hard limit for the on-disk bundle size in MB (default: only warn above 25 MB)")
    ap.add_argument("--quiet", action="store_true", help="print only the verdict and errors")
    args = ap.parse_args(argv)
    try:
        rep = validate_bundle(args.web_dir, args.max_mb)
    except (OSError, ValueError, KeyError, TypeError) as exc:
        print(f"BUNDLE UNREADABLE: {type(exc).__name__}: {exc}")
        return 2
    if not args.quiet:
        for line in rep.info:
            print(f"info: {line}")
        for line in rep.warnings:
            print(f"WARNING: {line}")
    for line in rep.errors:
        print(f"ERROR: {line}")
    verdict = "VALID" if not rep.errors else f"INVALID ({len(rep.errors)} errors)"
    print(f"{verdict}: {args.web_dir} ({len(rep.warnings)} warnings)")
    return 0 if not rep.errors else 1


if __name__ == "__main__":
    sys.exit(main())
