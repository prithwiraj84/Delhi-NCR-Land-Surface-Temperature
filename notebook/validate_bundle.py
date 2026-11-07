"""Validate a dashboard web bundle - schema 2.x (docs/SPEC.md section 5) or 1.x (docs/SPEC_v1.md section 4).

Usage:
    python notebook/validate_bundle.py <web_dir> [--quiet] [--max-mb MB] [--schema auto|1|2]

Standalone: needs only numpy (no pipeline globals, no Pillow), so it can be run on a bundle downloaded from Kaggle.
The schema is auto-detected from manifest.schema_version ("1.x" -> v1 contract, "2.x" -> v2 contract).
Exit status 0 = valid (warnings allowed), 1 = contract violations, 2 = bundle unreadable.

Every file may be gzip-compressed; gzip is detected by its magic bytes (0x1f 0x8b), never by the file name, so a
server that already inflated a .gz response is handled too.

v2 checks (SPEC section in brackets):
* strict JSON everywhere (UTF-8, no NaN/Infinity tokens)                                            [5]
* manifest: schema 2.x, study area + grid, modes, the 47 features in the binding order with their
  family / SHAP group / base flag / actionability, the 18 SHAP groups (ids, members, primaries,
  a partition of the features), zones per mode (canonical ids/names/colours), the 25 districts,
  timeline frames (years, kinds, windows, tier vocabulary and per-mode tier rules, levels inside
  their intervals, xai/raster flags), scenarios, fixed colour domains, cube and file names exactly as
  SPEC 5.2, the "scenario projection, not a forecast" note, synthetic_truth null iff gee            [5.3, 1.2, 4.1, 4.4]
* LSTB containers: magic, version, reserved bytes, header JSON, 8-byte alignment, zero padding,
  byte lengths = shape x itemsize, non-overlapping columns, dtype / scale / offset / nodata exactly
  as SPEC 5.2 per column, shapes [frames, n], one n for every file                                  [5.1, 5.2]
* cells: canonical order (strictly increasing cell_id = row * W + col), coordinates inside the bbox,
  district ids -1..24                                                                                [5.2, 1.1]
* cubes: frames / tiers / levels = manifest, zero uncertainty offsets for observed frames, ordered
  quantile offsets, flag bits, AOA flags 0/1, values inside the fixed domain (warn > 2 %, error > 10 %)
* zones cube: ids in {0..3, 255}, frame lists; zones.json n_cells / transition totals agree with it
* XAI files: group columns = manifest group order, the SHAP waterfall invariant
  |pred - (base_value_c + sum group SHAP)| <= 0.05 degC on EVERY row without NaN, resid = obs - oof,
  base_value_c - level constant per mode (= SHAP base), modelled frames carry no observation;
  feature files hold the 33 base features with plausible value domains                              [5.2]
* timeline_series: scopes (NCR, 25 districts, 4 zones per mode), frame years / tiers = manifest,
  CI around the mean, SSP fans ordered p05 <= ... <= p95 on the projected years, uncertainty budgets
  summing to 1, threshold years inside the projected frames and ordered, zone shares summing to 1     [5.4]
* raster_index.json + PNGs: EPSG:4326, bounds, frames = manifest raster flags, files present, PNG
  signature / IHDR size / 8-bit RGB, lo/hi = the fixed domain of the mode (warning)                 [5.2, 4.8]
* zones / shap_global / dependence / interactions (per mode, 18 groups), metrics (per mode and
  global blocks, headline, fold geometry), provenance, web models (v1 compact format on the 47
  features + focal spec, independent evaluator reproduces the embedded check rows), coupling,
  districts                                                                                          [5.5-5.8]
* bundle size ON DISK: a warning above 100 MB by default for v2 (25 MB for v1); an error only when a
  limit is given explicitly with --max-mb; unreferenced bundle files are reported as warnings

v1 checks (unchanged, SPEC_v1 section in brackets):
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
import struct
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
# Floor of corr(pred, obs) per XAI tier (default 0.5): rows in the wrong order give ~0. A reconstructed frame (sparse
# observations the model never trained on) agrees at only ~0.5 on real data; under 0.5 there is a warning, not an error.
CORR_MIN_BY_TIER = {"reconstructed": 0.25}
DEFAULT_WARN_MB = 25.0
# SPEC 4.6: recommendation levers and their per-action step caps (fractions 0.20, NDVI 0.15)
REC_LEVERS = {"frac_impervious", "frac_forest", "frac_water", "frac_cropland", "frac_barren", "ndvi",
              "lm_pd", "lm_ed", "lm_contag"}
REC_MAX_STEP = {**{f: 0.20 for f in FRACTION_FEATURES}, "ndvi": 0.15}
REC_DIRECTIONS = {"frac_impervious": {"decrease"}, "frac_barren": {"decrease"}, "frac_forest": {"increase"},
                  "frac_water": {"increase"}, "ndvi": {"increase"}}

# ---------------------------------------------------------------------------------------------------------------
# v2 contract constants (docs/SPEC.md sections 1.2, 4.1, 4.4, 5)
# ---------------------------------------------------------------------------------------------------------------
V2_BASE_FEATURES = [
    "ndvi", "ndbi", "mndwi", "albedo", "ndvi_spring", "ndvi_drop",
    "frac_built", "frac_forest", "frac_water", "frac_cropland", "frac_barren",
    "built_v", "log_pop", "dist_urban", "dist_builtup", "lm_pd", "lm_ed", "lm_contag",
    "dist_water",
    "elevation", "slope", "aspect_sin", "aspect_cos", "elev_tpi7", "elev_tpi21", "elev_std7",
    "era5_t2m", "era5_vpd", "era5_swvl1", "era5_evap", "era5_ssr", "era5_wind", "era5_precip_jfm",
]
V2_FOCAL_BASES = ["ndvi", "ndbi", "albedo", "frac_built", "frac_forest", "frac_water", "frac_barren"]
V2_FOCAL_WINDOWS = [3, 15]
V2_FEATURES = V2_BASE_FEATURES + [f"{b}_m{w}" for b in V2_FOCAL_BASES for w in V2_FOCAL_WINDOWS]
V2_FAMILIES = ("spectral", "landcover", "urban", "water", "terrain", "climate")
V2_BASE_FAMILY = {**{f: "spectral" for f in V2_BASE_FEATURES[:6]}, **{f: "landcover" for f in V2_BASE_FEATURES[6:11]},
                  **{f: "urban" for f in V2_BASE_FEATURES[11:18]}, "dist_water": "water",
                  **{f: "terrain" for f in V2_BASE_FEATURES[19:26]}, **{f: "climate" for f in V2_BASE_FEATURES[26:]}}
# (group id, members, primary) - SPEC 4.4, order binding
V2_GROUPS = [
    ("ndvi", ["ndvi", "ndvi_m3", "ndvi_m15"], "ndvi"),
    ("phenology", ["ndvi_spring", "ndvi_drop"], "ndvi_drop"),
    ("ndbi", ["ndbi", "ndbi_m3", "ndbi_m15"], "ndbi"),
    ("moisture_index", ["mndwi"], "mndwi"),
    ("albedo", ["albedo", "albedo_m3", "albedo_m15"], "albedo"),
    ("built", ["frac_built", "frac_built_m3", "frac_built_m15"], "frac_built"),
    ("built_volume", ["built_v"], "built_v"),
    ("population", ["log_pop"], "log_pop"),
    ("forest", ["frac_forest", "frac_forest_m3", "frac_forest_m15"], "frac_forest"),
    ("water", ["frac_water", "frac_water_m3", "frac_water_m15", "dist_water"], "frac_water"),
    ("cropland", ["frac_cropland"], "frac_cropland"),
    ("barren", ["frac_barren", "frac_barren_m3", "frac_barren_m15"], "frac_barren"),
    ("urban_proximity", ["dist_urban", "dist_builtup"], "dist_urban"),
    ("landscape", ["lm_pd", "lm_ed", "lm_contag"], "lm_ed"),
    ("terrain", ["elevation", "slope", "aspect_sin", "aspect_cos", "elev_tpi7", "elev_tpi21", "elev_std7"],
     "elevation"),
    ("climate_heat", ["era5_t2m", "era5_ssr"], "era5_t2m"),
    ("climate_moisture", ["era5_vpd", "era5_swvl1", "era5_evap", "era5_precip_jfm"], "era5_swvl1"),
    ("climate_wind", ["era5_wind"], "era5_wind"),
]
V2_GROUP_IDS = [g for g, _, _ in V2_GROUPS]
V2_ACTIONABLE_GROUPS = {"ndvi", "built", "forest", "water", "cropland", "barren", "landscape"}
# SPEC 3.3: actionable only for the 5 fractions, NDVI and the 3 landscape metrics
V2_ACTIONABLE_FEATURES = {"ndvi", "frac_built", "frac_forest", "frac_water", "frac_cropland", "frac_barren",
                          "lm_pd", "lm_ed", "lm_contag"}
V2_FRACTIONS = ["frac_built", "frac_forest", "frac_water", "frac_cropland", "frac_barren"]
V2_TIERS = ["observed", "observed-sparse", "reconstructed", "modelled", "projected"]
V2_MODE_TIERS = {"day": {"observed", "observed-sparse"}, "night": {"observed", "reconstructed", "modelled"}}
V2_SCENARIOS = ("ssp126", "ssp245", "ssp585")
V2_REC_LEVERS = {"ndvi", "frac_built", "frac_forest", "frac_water", "frac_cropland", "frac_barren", "lm_ed",
                 "lm_pd", "lm_contag"}
V2_REC_MAX_STEP = {**{f: 0.20 for f in V2_FRACTIONS}, "ndvi": 0.15}
V2_REC_DIRECTIONS = {"frac_built": {"decrease"}, "frac_barren": {"decrease"}, "frac_forest": {"increase"},
                     "frac_water": {"increase"}, "ndvi": {"increase"}}
V2_DEFAULT_WARN_MB = 100.0
V2_PROJ_NOTE = "scenario projection, not a forecast"
LST_SCALE = 0.01
OFF_SCALE = 0.05
SHAP_SCALE = 0.001
I16_NODATA = -32768
ZONE_NODATA = 255
DOMAIN_OUTSIDE_WARN = 0.02
DOMAIN_OUTSIDE_ERROR = 0.10
LSTB_DTYPES = {"int16": np.dtype("<i2"), "uint8": np.dtype("u1"), "int32": np.dtype("<i4"), "float32": np.dtype("<f4")}
VSUP_EDGES = (0.5, 1.0, 2.0)


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
# v1 4.1 manifest (schema 1.x, docs/SPEC_v1.md)
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
# v1 4.2 epoch files
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
# v1 4.3 compact model (shared with v2)
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
# v1 4.4 - 4.8
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


def validate_v1(web_dir, max_mb: float = None) -> Report:
    """Run every v1 (schema 1.x, SPEC_v1 section 4) check on ``web_dir``; returns the Report (errors empty = valid).

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


# ================================================================================================================
# v2 (schema 2.x, docs/SPEC.md section 5)
# ================================================================================================================
class LstbFormatError(ValueError):
    """A file that is not a well-formed LSTB container (SPEC 5.1)."""


def read_lstb(path: Path) -> tuple:
    """Parse an LSTB container (gzip or inflated) -> (header, {name: raw little-endian ndarray}).

    Independent of the notebook's reader: every structural rule of SPEC 5.1 is enforced and a violation raises
    LstbFormatError with the reason (magic, version, reserved bytes, header JSON, column keys, dtypes, 8-byte
    alignment relative to the data section, zero padding, byte lengths = shape x itemsize, no overlaps)."""
    data = read_bytes(path)
    if len(data) < 12 or data[:4] != b"LSTB":
        raise LstbFormatError("bad magic (not an LSTB container)")
    version = data[4]
    if version != 1:
        raise LstbFormatError(f"unsupported version {version}")
    if data[5:8] != b"\0\0\0":
        raise LstbFormatError("reserved bytes 5-7 are not zero")
    (header_len,) = struct.unpack_from("<I", data, 8)
    if 12 + header_len > len(data):
        raise LstbFormatError(f"header length {header_len} exceeds the file")
    try:
        header = json.loads(data[12:12 + header_len].decode("utf-8"), parse_constant=_reject_constant)
    except (UnicodeDecodeError, ValueError) as exc:
        raise LstbFormatError(f"header is not strict UTF-8 JSON: {exc}") from exc
    miss = _missing(header, ["kind", "n", "meta", "columns"])
    if miss:
        raise LstbFormatError(f"header misses {miss}")
    if not (isinstance(header["n"], int) and header["n"] > 0):
        raise LstbFormatError(f"header.n {header['n']!r} is not a positive int")
    data_start = 12 + header_len + ((-(12 + header_len)) % 8)
    if any(data[12 + header_len:data_start]):
        raise LstbFormatError("padding between header and data is not zero")
    raws, spans, names = {}, [], set()
    for col in header["columns"]:
        cmiss = _missing(col, ["name", "dtype", "shape", "scale", "offset", "nodata", "byte_offset", "byte_length"])
        if cmiss:
            raise LstbFormatError(f"column {col.get('name')!r} misses {cmiss}")
        name = col["name"]
        if name in names:
            raise LstbFormatError(f"duplicate column {name!r}")
        names.add(name)
        dt = LSTB_DTYPES.get(col["dtype"])
        if dt is None:
            raise LstbFormatError(f"column {name!r}: dtype {col['dtype']!r} not in {list(LSTB_DTYPES)}")
        shape = col["shape"]
        if not (isinstance(shape, list) and shape and all(isinstance(s, int) and s >= 0 for s in shape)):
            raise LstbFormatError(f"column {name!r}: bad shape {shape!r}")
        off, length = col["byte_offset"], col["byte_length"]
        if not (isinstance(off, int) and isinstance(length, int)) or off < 0 or off % 8:
            raise LstbFormatError(f"column {name!r}: byte_offset {off!r} is not a non-negative multiple of 8")
        count = int(np.prod(shape))
        if length != count * dt.itemsize:
            raise LstbFormatError(f"column {name!r}: byte_length {length} != {count} x {dt.itemsize}")
        if data_start + off + length > len(data):
            raise LstbFormatError(f"column {name!r} runs past the end of the file")
        if not (_is_num(col["scale"]) and col["scale"] > 0 and _is_num(col["offset"])):
            raise LstbFormatError(f"column {name!r}: scale must be finite > 0 and offset finite")
        nd = col["nodata"]
        if nd is not None:
            if col["dtype"] == "float32":
                raise LstbFormatError(f"column {name!r}: float32 columns must have nodata null")
            info = np.iinfo(dt)
            if not (isinstance(nd, int) and info.min <= nd <= info.max):
                raise LstbFormatError(f"column {name!r}: nodata {nd!r} outside the {col['dtype']} range")
        spans.append((off, off + length, name))
        raws[name] = np.frombuffer(data, dtype=dt, count=count, offset=data_start + off).reshape(shape)
    spans.sort()
    for (_, a1, an), (b0, _, bn) in zip(spans, spans[1:]):
        if b0 < a1:
            raise LstbFormatError(f"columns {an!r} and {bn!r} overlap")
    return header, raws


def decode_lstb(col: dict, raw: np.ndarray) -> np.ndarray:
    """raw * scale + offset (float64), NaN where raw == nodata."""
    v = raw.astype(np.float64) * float(col["scale"]) + float(col["offset"])
    if col.get("nodata") is not None:
        v[raw == col["nodata"]] = np.nan
    return v


def read_png_header(path: Path) -> dict:
    """Signature + IHDR of a PNG (width, height, bit depth, colour type) without any imaging library."""
    raw = Path(path).read_bytes()[:33]
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG (bad signature)")
    if raw[12:16] != b"IHDR":
        raise ValueError("PNG without a leading IHDR chunk")
    width, height, depth, ctype = struct.unpack(">IIBB", raw[16:26])
    return {"width": width, "height": height, "bit_depth": depth, "color_type": ctype}


class _V2Context:
    """Facts established by the manifest check and reused by the file checks."""

    def __init__(self) -> None:
        self.modes: list = []
        self.obs: list = []
        self.proj: list = []
        self.scen: list = []
        self.tiers: dict = {}
        self.levels: dict = {}
        self.level_ci: dict = {}
        self.available: dict = {}
        self.xai: dict = {}
        self.raster: dict = {}
        self.domains: dict = {}
        self.n = None
        self.grid: dict = {}
        self.bbox = None
        self.cell_km2 = None
        self.zones_obs: dict = {}
        self.zones_proj: dict = {}
        self.base_c_minus_level: dict = {}
        self.files: list = []
        self.cube_lst: dict = {}          # mode -> decoded obs cube lst [F, n] (cross-file checks, C-01)
        self.zone_centroids: dict = {}    # mode -> (4, 18) zone centroids from zones.json


def _tag_list(values) -> list:
    return values if isinstance(values, list) else []


def _expect_column(rep: Report, tag: str, col: dict, dtype: str, shape: list, scale=None, offset=0.0,
                   nodata="any") -> bool:
    ok = rep.require(col["dtype"] == dtype, f"{tag}: dtype {col['dtype']} != {dtype}")
    ok &= rep.require(col["shape"] == shape, f"{tag}: shape {col['shape']} != {shape}")
    if scale is not None:
        ok &= rep.require(abs(float(col["scale"]) - scale) <= 1e-12 * max(1.0, scale),
                          f"{tag}: scale {col['scale']} != {scale}")
    if offset is not None:
        ok &= rep.require(abs(float(col["offset"]) - offset) <= 1e-12, f"{tag}: offset {col['offset']} != {offset}")
    if nodata != "any":
        ok &= rep.require(col["nodata"] == nodata, f"{tag}: nodata {col['nodata']!r} != {nodata!r}")
    return bool(ok)


def _domain_coverage(rep: Report, tag: str, values: np.ndarray, dom) -> None:
    if not (isinstance(dom, list) and len(dom) == 2):
        return
    v = values[np.isfinite(values)]
    if v.size == 0:
        rep.warn(False, f"{tag}: no finite values")
        return
    frac = float(np.mean((v < dom[0] - 1e-6) | (v > dom[1] + 1e-6)))
    msg = (f"{tag}: {100 * frac:.1f} % of values outside the fixed domain {dom} "
           f"(data p0.5-p99.5 {np.percentile(v, 0.5):.1f}-{np.percentile(v, 99.5):.1f})")
    if frac > DOMAIN_OUTSIDE_ERROR:
        rep.require(False, msg)
    else:
        rep.warn(frac <= DOMAIN_OUTSIDE_WARN, msg)


def _hhmm_ok(v) -> bool:
    if v is None:
        return True
    if not (isinstance(v, str) and len(v) == 5 and v[2] == ":" and v[:2].isdigit() and v[3:].isdigit()):
        return False
    return 0 <= int(v[:2]) < 24 and 0 <= int(v[3:]) < 60


# ----------------------------------------------------------------------------------------------------------------
# v2 5.3 manifest
# ----------------------------------------------------------------------------------------------------------------
def _check_features_v2(man: dict, rep: Report) -> None:
    feats = man["features"]
    names = [f.get("name") for f in feats] if isinstance(feats, list) else []
    rep.require(names == V2_FEATURES, f"manifest.features: names/order differ from SPEC 4.1 ({len(names)} given)")
    group_of = {m: g for g, members, _ in V2_GROUPS for m in members}
    for f in feats if isinstance(feats, list) else []:
        name = f.get("name")
        miss = _missing(f, ["name", "label", "unit", "group", "family", "base", "description", "source", "actionable",
                            "display", "stats"])
        if not rep.require(not miss, f"manifest feature {name}: missing {miss}"):
            continue
        if name not in V2_FEATURES:
            continue
        is_base = name in V2_BASE_FEATURES
        rep.require(f["base"] is is_base, f"feature {name}: base must be {is_base}")
        rep.require(f["group"] == group_of[name], f"feature {name}: group {f['group']!r} != {group_of[name]!r}")
        fam = V2_BASE_FAMILY[name] if is_base else V2_BASE_FAMILY[name.rsplit("_m", 1)[0]]
        rep.require(f["family"] in V2_FAMILIES, f"feature {name}: family {f['family']!r} not in {V2_FAMILIES}")
        rep.require(f["family"] == fam, f"feature {name}: family {f['family']!r} != {fam!r} (SPEC 4.1)")
        rep.require(f["actionable"] is (name in V2_ACTIONABLE_FEATURES),
                    f"feature {name}: actionable must be {name in V2_ACTIONABLE_FEATURES} (SPEC 3.3)")
        rep.require(f["display"] in ("index", "percent", "number"), f"feature {name}: display {f['display']!r}")
        if name.startswith("frac_"):
            rep.require(f["display"] == "percent", f"feature {name}: fractions must display as percent")
        st = f["stats"]
        smiss = _missing(st, ["min", "max", "p01", "p99", "median", "mean", "std"])
        if rep.require(not smiss, f"feature {name}.stats missing {smiss}") and all(
                _is_num(st[k]) for k in ("min", "p01", "median", "p99", "max")):
            rep.require(st["min"] <= st["p01"] <= st["median"] <= st["p99"] <= st["max"],
                        f"feature {name}.stats not ordered min<=p01<=median<=p99<=max")


def _check_groups_v2(man: dict, rep: Report) -> None:
    groups = man["groups"]
    ids = [g.get("id") for g in groups] if isinstance(groups, list) else []
    rep.require(ids == V2_GROUP_IDS, f"manifest.groups: ids/order differ from SPEC 4.4: {ids}")
    spec = {g: (members, primary) for g, members, primary in V2_GROUPS}
    seen = []
    for g in groups if isinstance(groups, list) else []:
        miss = _missing(g, ["id", "label", "primary", "family", "actionable", "members"])
        if not rep.require(not miss, f"manifest group {g.get('id')}: missing {miss}"):
            continue
        if g["id"] not in spec:
            continue
        members, primary = spec[g["id"]]
        rep.require(list(g["members"]) == members, f"group {g['id']}: members {g['members']} != {members}")
        rep.require(g["primary"] == primary, f"group {g['id']}: primary {g['primary']!r} != {primary!r}")
        rep.require(g["family"] in V2_FAMILIES, f"group {g['id']}: family {g['family']!r}")
        rep.require(g["actionable"] is (g["id"] in V2_ACTIONABLE_GROUPS),
                    f"group {g['id']}: actionable must be {g['id'] in V2_ACTIONABLE_GROUPS}")
        seen += list(g["members"])
    rep.require(sorted(seen) == sorted(V2_FEATURES) and len(seen) == len(set(seen)),
                "manifest.groups: members must partition the 47 features")


def _check_mode_frame(rep: Report, ctx: _V2Context, mode: str, fr: dict, e: dict) -> None:
    y = fr["year"]
    tag = f"manifest.timeline.frames[{y}].{mode}"
    miss = _missing(e, ["tier", "sensor", "overpass_ist", "scenes", "coverage", "native_m", "available", "level",
                        "level_ci"])
    if not rep.require(not miss, f"{tag}: missing {miss}"):
        return
    tier = e["tier"]
    rep.require(tier in V2_TIERS, f"{tag}: tier {tier!r} not in the vocabulary {V2_TIERS}")
    if fr["kind"] == "projected":
        rep.require(tier == "projected", f"{tag}: projected frame must have tier 'projected'")
    else:
        rep.require(tier in V2_MODE_TIERS.get(mode, set(V2_TIERS)),
                    f"{tag}: tier {tier!r} is not allowed for observed {mode} frames (SPEC 1.2)")
    rep.require(_hhmm_ok(e["overpass_ist"]), f"{tag}: overpass_ist {e['overpass_ist']!r} is not HH:MM")
    rep.require(isinstance(e["scenes"], int) and e["scenes"] >= 0, f"{tag}: scenes must be an int >= 0")
    rep.require(e["coverage"] is None or (_is_num(e["coverage"]) and 0 <= e["coverage"] <= 1),
                f"{tag}: coverage must be in [0, 1]")
    rep.require(isinstance(e["available"], bool), f"{tag}: available must be bool")
    rep.require(e["level"] is None or _is_num(e["level"]), f"{tag}: level must be a number or null")
    rep.require(_ci_ok(e["level_ci"]), f"{tag}: level_ci must be [lo <= hi] or null")
    if _is_num(e["level"]) and e["level_ci"]:
        rep.warn(e["level_ci"][0] - 0.011 <= e["level"] <= e["level_ci"][1] + 0.011,
                 f"{tag}: level {e['level']} outside its interval {e['level_ci']}")
    if e["available"] and fr["kind"] == "observed":
        rep.require(_is_num(e["level"]), f"{tag}: an available observed frame needs a level")
    ctx.tiers.setdefault(mode, {})[y] = tier
    ctx.levels.setdefault(mode, {})[y] = e["level"]
    ctx.level_ci.setdefault(mode, {})[y] = e["level_ci"]
    ctx.available.setdefault(mode, {})[y] = e["available"]


def check_manifest_v2(man: dict, rep: Report) -> _V2Context:
    ctx = _V2Context()
    keys = ["schema_version", "generated_at", "data_mode", "data_mode_reason", "study_area", "target_mode", "modes",
            "features", "groups", "zones", "districts", "timeline", "files", "data_sources", "notes", "bootstrap",
            "synthetic_truth"]
    miss = _missing(man, keys)
    if not rep.require(not miss, f"manifest: missing keys {miss}"):
        return None
    rep.require(str(man["schema_version"]).split(".")[0] == "2", f"manifest.schema_version {man['schema_version']!r}")
    rep.warn(man["schema_version"] == "2.0", f"manifest.schema_version {man['schema_version']!r} is a newer 2.x minor "
                                             "version than this validator knows (2.0)")
    rep.require(man["data_mode"] in ("gee", "synthetic"), f"manifest.data_mode {man['data_mode']!r}")
    rep.require(man["target_mode"] == "anomaly", f"manifest.target_mode {man['target_mode']!r} != 'anomaly'")
    rep.require((man["synthetic_truth"] is None) == (man["data_mode"] == "gee"),
                "manifest.synthetic_truth must be null exactly in gee mode")
    rep.require(man["data_mode_reason"] is None or isinstance(man["data_mode_reason"], str),
                "manifest.data_mode_reason must be a string or null")
    # study area + grid
    sa = man["study_area"]
    sa_miss = _missing(sa, ["name", "area_km2", "crs", "grid_res_m", "fine_res_m", "grid", "bbox", "center"])
    if rep.require(not sa_miss, f"manifest.study_area: missing {sa_miss}"):
        rep.require(sa["crs"] == "EPSG:32643", f"manifest.study_area.crs {sa['crs']!r} != EPSG:32643")
        g = sa["grid"]
        gmiss = _missing(g, ["crs", "res", "x0", "y0", "width", "height"])
        if rep.require(not gmiss, f"manifest.study_area.grid: missing {gmiss}"):
            rep.require(g["res"] == sa["grid_res_m"], "manifest.study_area.grid.res != grid_res_m")
            rep.require(isinstance(g["width"], int) and isinstance(g["height"], int) and g["width"] > 0
                        and g["height"] > 0, "manifest.study_area.grid width/height must be positive ints")
            ctx.grid = g
            ctx.cell_km2 = (float(g["res"]) / 1000.0) ** 2
        rep.require(_is_num(sa["fine_res_m"]) and _is_num(sa["grid_res_m"]) and sa["fine_res_m"] > 0
                    and sa["grid_res_m"] % sa["fine_res_m"] == 0, "manifest.study_area.fine_res_m must divide the grid")
        bbox, center = sa["bbox"], sa["center"]
        if rep.require(isinstance(bbox, list) and len(bbox) == 4 and all(_is_num(v) for v in bbox),
                       "manifest.study_area.bbox must be 4 numbers"):
            rep.require(bbox[0] < bbox[2] and bbox[1] < bbox[3], "manifest.study_area.bbox is not min<max")
            rep.require(-180 <= bbox[0] <= 180 and -90 <= bbox[1] <= 90, "manifest.study_area.bbox not lon/lat")
            ctx.bbox = bbox
            if isinstance(center, list) and len(center) == 2:
                rep.require(bbox[0] <= center[0] <= bbox[2] and bbox[1] <= center[1] <= bbox[3],
                            "manifest.study_area.center outside bbox")
        if "n_cells" in sa:
            rep.require(isinstance(sa["n_cells"], int) and sa["n_cells"] > 0, "manifest.study_area.n_cells")
            ctx.n = sa["n_cells"]
    # modes
    modes = man["modes"]
    ids = [m.get("id") for m in modes] if isinstance(modes, list) else []
    rep.require(bool(ids) and len(ids) == len(set(ids)) and set(ids) <= {"day", "night"},
                f"manifest.modes ids {ids} must be unique and in day/night")
    for m in modes if isinstance(modes, list) else []:
        rep.require(not _missing(m, ["id", "label", "target", "ramp"]), f"manifest.modes[{m.get('id')}]: keys")
    ctx.modes = [m for m in ("day", "night") if m in ids]
    _check_features_v2(man, rep)
    _check_groups_v2(man, rep)
    zones = man["zones"]
    for m in ctx.modes:
        zl = zones.get(m) if isinstance(zones, dict) else None
        rep.require(isinstance(zl, list) and [{k: z.get(k) for k in ("id", "name", "color")} for z in zl]
                    == ZONES_CANONICAL, f"manifest.zones.{m} must be the 4 canonical zones (ids, names, colours)")
        for z in zl if isinstance(zl, list) else []:
            if isinstance(z, dict):
                _check_zone_display(rep, f"manifest.zones.{m}[{z.get('id')}]", z)
    dists = man["districts"]
    rep.require([d.get("id") for d in dists] == list(range(25)), "manifest.districts ids must be 0..24")
    rep.require([d.get("name") for d in dists] == DISTRICT_NAMES, "manifest.districts names differ from SPEC_v1 1.1")
    sources = man["data_sources"]
    rep.require(isinstance(sources, dict) and all(isinstance(v, dict) for v in sources.values()),
                "manifest.data_sources must be {variable: {year: provenance}}")
    notes = man["notes"]
    rep.require(isinstance(notes, list) and all(isinstance(n, str) for n in notes), "manifest.notes must be strings")
    if man["data_mode"] == "synthetic":
        rep.warn(any("SYNTHETIC" in n.upper() for n in notes), "manifest.notes lack a SYNTHETIC caveat")
    boot = man["bootstrap"]
    if rep.require(isinstance(boot, dict), "manifest.bootstrap must be {mode: {...}}"):
        for m, b in boot.items():
            if not isinstance(b, dict):
                continue
            if "ci_label" in b:
                rep.require(b["ci_label"] in ("95% CI", "replicate range", "no bootstrap"),
                            f"manifest.bootstrap.{m}.ci_label {b['ci_label']!r}")
            if "replicate_range" in b and _is_num(b.get("n")):
                rep.require(b["replicate_range"] == (b["n"] < 50),
                            f"manifest.bootstrap.{m}.replicate_range must be true exactly when n < 50")
    # timeline
    tl = man["timeline"]
    tmiss = _missing(tl, ["now", "harmonised", "reference_period", "frames", "scenarios", "domains", "annotations",
                          "tiers", "cubes", "raster_index"])
    if not rep.require(not tmiss, f"manifest.timeline: missing {tmiss}"):
        return ctx
    rep.require(tl["tiers"] == V2_TIERS, f"manifest.timeline.tiers {tl['tiers']} != {V2_TIERS}")
    rep.require(isinstance(tl["now"], int), "manifest.timeline.now must be an int")
    rep.require(_ci_ok(tl["reference_period"]) and tl["reference_period"] is not None,
                "manifest.timeline.reference_period must be [y0, y1]")
    years = []
    for fr in _tag_list(tl["frames"]):
        fmiss = _missing(fr, ["year", "window", "kind", "xai", "raster"] + ctx.modes)
        if not rep.require(not fmiss, f"manifest.timeline.frames[{fr.get('year')}]: missing {fmiss}"):
            continue
        y = fr["year"]
        years.append(y)
        rep.require(fr["kind"] in ("observed", "projected"), f"timeline frame {y}: kind {fr['kind']!r}")
        if fr["kind"] == "observed":
            rep.require(y <= tl["now"], f"timeline frame {y}: observed after now={tl['now']}")
            ctx.obs.append(y)
        else:
            rep.require(y > tl["now"], f"timeline frame {y}: projected but not after now={tl['now']}")
            ctx.proj.append(y)
        w = fr["window"]
        rep.require(isinstance(w, list) and len(w) == 2 and w[0] <= w[1], f"timeline frame {y}: window {w}")
        if isinstance(w, list) and len(w) == 2:
            rep.warn(w[0] <= y <= w[1], f"timeline frame {y}: window {w} does not contain the year")
        for m in ctx.modes:
            _check_mode_frame(rep, ctx, m, fr, fr[m])
            ctx.xai.setdefault(m, {})[y] = bool((fr["xai"] or {}).get(m))
            ctx.raster.setdefault(m, {})[y] = bool((fr["raster"] or {}).get(m))
            if fr["kind"] == "projected":
                rep.require(not ctx.xai[m][y], f"timeline frame {y}: projected frames carry no XAI files")
    rep.require(years == sorted(years) and len(years) == len(set(years)) and years,
                "manifest.timeline.frames: years must be strictly increasing")
    rep.require(all(o < p for o in ctx.obs for p in ctx.proj), "manifest.timeline: observed frames must precede "
                                                                "projected ones")
    scen = [s.get("id") for s in _tag_list(tl["scenarios"])]
    for s in _tag_list(tl["scenarios"]):
        rep.require(not _missing(s, ["id", "label", "method", "n_gcm"]) and s.get("id") in V2_SCENARIOS,
                    f"manifest.timeline.scenarios: bad entry {s}")
    rep.require(len(scen) == len(set(scen)), "manifest.timeline.scenarios: duplicate ids")
    rep.require(bool(scen) == bool(ctx.proj), "manifest.timeline: scenarios must be declared exactly when projected "
                                              "frames exist")
    ctx.scen = [s for s in V2_SCENARIOS if s in scen]
    if ctx.proj:
        rep.require(any(V2_PROJ_NOTE in n for n in notes),
                    f'manifest.notes must state "{V2_PROJ_NOTE}" when projected frames exist (SPEC 4.10)')
    dom = tl["domains"]
    for m in ctx.modes:
        d = dom.get(m) if isinstance(dom, dict) else None
        if not rep.require(isinstance(d, dict), f"manifest.timeline.domains.{m} missing"):
            continue
        for k in ("abs", "anom", "suhi"):
            v = d.get(k)
            if rep.require(isinstance(v, list) and len(v) == 2 and all(_is_num(x) for x in v) and v[0] < v[1],
                           f"manifest.timeline.domains.{m}.{k} must be [lo < hi]") and k != "abs":
                rep.require(abs(v[0] + v[1]) <= 1e-9, f"manifest.timeline.domains.{m}.{k} must be symmetric")
        ctx.domains[m] = d.get("abs")
    if set(ctx.modes) == {"day", "night"}:
        dd = (dom.get("dtr") or {}).get("abs") if isinstance(dom, dict) else None
        rep.require(isinstance(dd, list) and len(dd) == 2 and dd[0] < dd[1], "manifest.timeline.domains.dtr.abs")
    sp = dom.get("spread") if isinstance(dom, dict) else None
    rep.require(isinstance(sp, list) and len(sp) == 2 and sp[0] == 0 and _is_num(sp[1]) and sp[1] > 0,
                "manifest.timeline.domains.spread must be [0, s > 0]")
    for a in _tag_list(tl["annotations"]):
        rep.require(not _missing(a, ["year", "label", "kind"]), f"manifest.timeline.annotations: bad entry {a}")
    cubes = tl["cubes"]
    want = {f"obs_{m}": f"cube_obs_{m}.lstb.gz" for m in ctx.modes}
    want.update({f"zones_{m}": f"cube_zones_{m}.lstb.gz" for m in ctx.modes})
    want.update({f"{s}_{m}": f"cube_{s}_{m}.lstb.gz" for m in ctx.modes for s in ctx.scen})
    rep.require(cubes == want, f"manifest.timeline.cubes {cubes} != SPEC 5.2 names {want}")
    any_raster = any(v for m in ctx.raster.values() for v in m.values())
    rep.require(tl["raster_index"] in (None, "raster_index.json"), "manifest.timeline.raster_index must be "
                                                                    "'raster_index.json' or null")
    if any_raster:
        rep.require(tl["raster_index"] == "raster_index.json", "manifest.timeline.raster_index missing although "
                                                               "frames have raster = true")
    # files
    files = man["files"]
    fmiss = _missing(files, ["cells", "series", "xai", "model", "shap_global", "dependence", "zones", "metrics",
                             "interactions", "coupling", "districts", "provenance"])
    if rep.require(not fmiss, f"manifest.files missing {fmiss}"):
        rep.require(files["cells"] == "cells.lstb.gz" and files["series"] == "timeline_series.json.gz",
                    "manifest.files.cells/series names differ from SPEC 5.2")
        rep.require(files["model"] == {m: f"model_web_{m}.json" for m in ctx.modes},
                    f"manifest.files.model {files['model']}")
        for m in ctx.modes:
            want_x = {str(y): {"features": f"xai_{y}_features.lstb.gz", "shap": f"xai_{y}_{m}.lstb.gz"}
                      for y in ctx.obs if ctx.xai.get(m, {}).get(y)}
            rep.require((files["xai"] or {}).get(m) == want_x,
                        f"manifest.files.xai.{m} must list exactly the frames with xai.{m} = true (SPEC 5.3 names)")
        ctx.files = [files[k] for k in ("cells", "series", "shap_global", "dependence", "zones", "metrics",
                                        "interactions", "coupling", "districts", "provenance")]
        ctx.files += list(files["model"].values())
        ctx.files += list(cubes.values()) if isinstance(cubes, dict) else []
        ctx.files += sorted({v for d in (files["xai"] or {}).values() for e in d.values() for v in e.values()})
        if tl["raster_index"]:
            ctx.files.append(tl["raster_index"])
    return ctx


# ----------------------------------------------------------------------------------------------------------------
# v2 5.2 binary files
# ----------------------------------------------------------------------------------------------------------------
def _open_lstb(web_dir: Path, name: str, kind: str, ctx: _V2Context, rep: Report):
    try:
        header, raws = read_lstb(web_dir / name)
    except LstbFormatError as exc:
        rep.require(False, f"{name}: malformed LSTB container ({exc})")
        return None, None
    rep.require(header["kind"] == kind, f"{name}: kind {header['kind']!r} != {kind!r}")
    if ctx.n is None:
        ctx.n = header["n"]
    rep.require(header["n"] == ctx.n, f"{name}: n={header['n']} differs from the bundle n={ctx.n}")
    for col in header["columns"]:
        rep.require(col["shape"][-1] == header["n"], f"{name}.{col['name']}: last dimension != n")
    return header, raws


def check_cells_v2(web_dir: Path, ctx: _V2Context, rep: Report) -> None:
    h, raws = _open_lstb(web_dir, "cells.lstb.gz", "cells", ctx, rep)
    if h is None:
        return
    n = h["n"]
    cols = {c["name"]: c for c in h["columns"]}
    want = {"cell_id": "int32", "row": "int16", "col": "int16", "lon": "float32", "lat": "float32",
            "district": "int16"}
    if not rep.require(set(cols) == set(want), f"cells: columns {sorted(cols)} != {sorted(want)}"):
        return
    for name, dt in want.items():
        _expect_column(rep, f"cells.{name}", cols[name], dt, [n], scale=1.0, offset=0.0)
    cid = raws["cell_id"].astype(np.int64)
    rep.require(np.all(np.diff(cid) > 0), "cells.cell_id must be strictly increasing (canonical order)")
    W, H = ctx.grid.get("width"), ctx.grid.get("height")
    if W and H:
        r, c = raws["row"].astype(np.int64), raws["col"].astype(np.int64)
        rep.require(np.all((r >= 0) & (r < H) & (c >= 0) & (c < W)), "cells: row/col outside the grid")
        rep.require(np.array_equal(r * W + c, cid), "cells: cell_id != row * width + col")
    lon, lat = raws["lon"].astype(np.float64), raws["lat"].astype(np.float64)
    rep.require(np.isfinite(lon).all() and np.isfinite(lat).all(), "cells: lon/lat contain NaN")
    if ctx.bbox:
        b = ctx.bbox
        rep.require(np.all((lon >= b[0] - 1e-3) & (lon <= b[2] + 1e-3) & (lat >= b[1] - 1e-3) & (lat <= b[3] + 1e-3)),
                    "cells: cell centres outside manifest bbox")
    d = raws["district"]
    rep.require(np.all((d >= -1) & (d < 25)), "cells: district ids outside -1..24")
    rep.warn(np.mean(d >= 0) > 0.9 if n else True, "cells: more than 10 % of cells have no district")


def check_obs_cube_v2(web_dir: Path, mode: str, ctx: _V2Context, rep: Report) -> None:
    name = f"cube_obs_{mode}.lstb.gz"
    h, raws = _open_lstb(web_dir, name, "cube", ctx, rep)
    if h is None:
        return
    n, F = h["n"], len(ctx.obs)
    cols = {c["name"]: c for c in h["columns"]}
    if not rep.require(set(cols) == {"lst", "aoa_out", "p05_off", "p95_off"}, f"{name}: columns {sorted(cols)}"):
        return
    ok = _expect_column(rep, f"{name}.lst", cols["lst"], "int16", [F, n], LST_SCALE, 0.0, I16_NODATA)
    ok &= _expect_column(rep, f"{name}.aoa_out", cols["aoa_out"], "uint8", [F, n], 1.0, 0.0)
    for q in ("p05_off", "p95_off"):
        ok &= _expect_column(rep, f"{name}.{q}", cols[q], "uint8", [F, n], OFF_SCALE, 0.0, None)
    meta = h["meta"]
    rep.require(meta.get("mode") == mode, f"{name}: meta.mode {meta.get('mode')!r}")
    rep.require(meta.get("frames") == ctx.obs, f"{name}: meta.frames {meta.get('frames')} != manifest {ctx.obs}")
    tiers = [ctx.tiers[mode][y] for y in ctx.obs]
    rep.require(meta.get("tiers") == tiers, f"{name}: meta.tiers != manifest tiers")
    lv = meta.get("levels") or []
    rep.require(len(lv) == F and all(a is None or b is None or abs(a - b) <= 0.011
                                     for a, b in zip(lv, [ctx.levels[mode][y] for y in ctx.obs])),
                f"{name}: meta.levels differ from the manifest levels")
    if not ok:
        return
    vals = decode_lstb(cols["lst"], raws["lst"])
    ctx.cube_lst[mode] = vals
    rep.require(set(np.unique(raws["aoa_out"]).tolist()) <= {0, 1}, f"{name}: aoa_out must be 0/1")
    for j, y in enumerate(ctx.obs):
        fin = np.isfinite(vals[j])
        if ctx.available[mode].get(y):
            rep.require(fin.any(), f"{name}: frame {y} is 'available' but has no values")
        if fin.any():
            v = vals[j][fin]
            rep.require(np.all((v > -10) & (v < 80)), f"{name}: frame {y} has implausible LST values")
            lev = ctx.levels[mode].get(y)
            if _is_num(lev):
                rep.warn(abs(float(v.mean()) - lev) < 3.0, f"{name}: frame {y} mean {v.mean():.2f} far from its "
                                                           f"level {lev}")
        if tiers[j] == "observed":
            rep.require(not raws["p05_off"][j].any() and not raws["p95_off"][j].any(),
                        f"{name}: observed frame {y} must carry zero uncertainty offsets")
        elif tiers[j] in ("modelled", "reconstructed"):
            rep.warn(raws["p05_off"][j][fin].any() or raws["p95_off"][j][fin].any(),
                     f"{name}: {tiers[j]} frame {y} carries no uncertainty interval")
    _domain_coverage(rep, name, vals, ctx.domains.get(mode))


def check_ssp_cube_v2(web_dir: Path, mode: str, scen: str, method: str, ctx: _V2Context, rep: Report) -> None:
    name = f"cube_{scen}_{mode}.lstb.gz"
    h, raws = _open_lstb(web_dir, name, "cube", ctx, rep)
    if h is None:
        return
    n, F = h["n"], len(ctx.proj)
    cols = {c["name"]: c for c in h["columns"]}
    want = {"p50", "p05_off", "p25_off", "p75_off", "p95_off", "flags"}
    if not rep.require(set(cols) == want, f"{name}: columns {sorted(cols)} != {sorted(want)}"):
        return
    ok = _expect_column(rep, f"{name}.p50", cols["p50"], "int16", [F, n], LST_SCALE, 0.0, I16_NODATA)
    for q in ("p05_off", "p25_off", "p75_off", "p95_off"):
        ok &= _expect_column(rep, f"{name}.{q}", cols[q], "uint8", [F, n], OFF_SCALE, 0.0, None)
    ok &= _expect_column(rep, f"{name}.flags", cols["flags"], "uint8", [F, n], 1.0, 0.0)
    meta = h["meta"]
    rep.require(meta.get("mode") == mode and meta.get("scenario") == scen, f"{name}: meta.mode/scenario")
    rep.require(meta.get("frames") == ctx.proj, f"{name}: meta.frames {meta.get('frames')} != manifest {ctx.proj}")
    rep.require(meta.get("method") == method, f"{name}: meta.method {meta.get('method')!r} != manifest {method!r}")
    if not ok:
        return
    p50 = decode_lstb(cols["p50"], raws["p50"])
    rep.require(np.all(raws["p05_off"] >= raws["p25_off"]) and np.all(raws["p95_off"] >= raws["p75_off"]),
                f"{name}: quantile offsets not ordered (p05 <= p25 <= p50 <= p75 <= p95)")
    rep.require(np.all(raws["flags"] < 8), f"{name}: flags use bits beyond 0-2")
    fin = np.isfinite(p50)
    if fin.any():
        half = 0.5 * (raws["p05_off"].astype(np.float64) + raws["p95_off"].astype(np.float64)) * OFF_SCALE
        tier = np.searchsorted(np.asarray(VSUP_EDGES), half, side="right")
        bits = (raws["flags"] >> 1) & 3
        near = np.min(np.abs(half[..., None] - np.asarray(VSUP_EDGES)), axis=-1) <= OFF_SCALE
        mism = fin & (tier != bits) & ~near & (np.maximum(raws["p05_off"], raws["p95_off"]) < 255)
        rep.warn(mism.mean() <= 0.01, f"{name}: VSUP tier bits disagree with the decoded p05-p95 spread on "
                                      f"{100 * mism.mean():.1f} % of cells")
        rep.warn(fin.mean() > 0.95, f"{name}: p50 is missing for {100 * (1 - fin.mean()):.1f} % of cells")
    _domain_coverage(rep, name, p50, ctx.domains.get(mode))


def check_zone_cube_v2(web_dir: Path, mode: str, ctx: _V2Context, rep: Report) -> None:
    name = f"cube_zones_{mode}.lstb.gz"
    h, raws = _open_lstb(web_dir, name, "zones", ctx, rep)
    if h is None:
        return
    n = h["n"]
    cols = {c["name"]: c for c in h["columns"]}
    want = {"obs", *ctx.scen}
    if not rep.require(set(cols) == want, f"{name}: columns {sorted(cols)} != {sorted(want)}"):
        return
    frames_meta = h["meta"].get("frames") or {}
    for key, col in cols.items():
        years = ctx.obs if key == "obs" else ctx.proj
        if not _expect_column(rep, f"{name}.{key}", col, "uint8", [len(years), n], 1.0, 0.0, ZONE_NODATA):
            continue
        raw = raws[key]
        bad = int(np.count_nonzero((raw > 3) & (raw != ZONE_NODATA)))
        rep.require(bad == 0, f"{name}.{key}: {bad} values outside {{0, 1, 2, 3, 255}}")
        if isinstance(frames_meta, dict) and key in frames_meta:
            rep.require(frames_meta[key] == years, f"{name}: meta.frames.{key} != manifest frames")
        store = ctx.zones_obs if key == "obs" else ctx.zones_proj.setdefault(mode, {})
        if key == "obs":
            store[mode] = raw
        else:
            store[key] = raw
        for z in range(4):
            rep.warn(bool(np.any(raw == z)), f"{name}.{key}: zone {z} is empty in every frame")


def _check_feature_values(name: str, f: str, v: np.ndarray, tol: float, rep: Report) -> None:
    v = v[np.isfinite(v)]
    if v.size == 0:
        return
    bounds = {"albedo": (-0.002, 1.02), "lm_contag": (0, 100), "lm_pd": (0, None), "lm_ed": (0, None),
              "built_v": (0, None),
              "log_pop": (0, None), "dist_urban": (0, None), "dist_builtup": (0, None), "dist_water": (0, None),
              "slope": (0, 90), "aspect_sin": (-1, 1), "aspect_cos": (-1, 1), "era5_swvl1": (0, 1)}
    if f.startswith("frac_"):
        lo, hi = 0, 1
    elif f in ("ndvi", "ndbi", "mndwi", "ndvi_spring"):
        lo, hi = -1, 1
    elif f == "ndvi_drop":
        lo, hi = -2, 2
    else:
        lo, hi = bounds.get(f, (None, None))
    if lo is not None:
        rep.require(v.min() >= lo - tol, f"{name}.{f}: minimum {v.min():.4g} below {lo}")
    if hi is not None:
        rep.require(v.max() <= hi + tol, f"{name}.{f}: maximum {v.max():.4g} above {hi}")


def check_xai_v2(web_dir: Path, mode: str, year: int, files: dict, ctx: _V2Context, rep: Report) -> None:
    fname, sname = files["features"], files["shap"]
    hf, rf = _open_lstb(web_dir, fname, "features", ctx, rep)
    if hf is not None:
        n = hf["n"]
        names = [c["name"] for c in hf["columns"]]
        rep.require(names == V2_BASE_FEATURES, f"{fname}: columns must be the 33 base features in SPEC order")
        rep.require(hf["meta"].get("year") == year, f"{fname}: meta.year {hf['meta'].get('year')} != {year}")
        fin_share = []
        for c in hf["columns"]:
            if _expect_column(rep, f"{fname}.{c['name']}", c, "int16", [n], None, None, I16_NODATA):
                v = decode_lstb(c, rf[c["name"]])
                fin_share.append(np.isfinite(v).mean())
                _check_feature_values(fname, c["name"], v, float(c["scale"]), rep)
        rep.warn(not fin_share or float(np.mean(fin_share)) > 0.9, f"{fname}: more than 10 % of values are NaN")
    h, raws = _open_lstb(web_dir, sname, "xai", ctx, rep)
    if h is None:
        return
    n = h["n"]
    cols = {c["name"]: c for c in h["columns"]}
    want = V2_GROUP_IDS + ["pred", "oof", "obs", "resid"]
    if not rep.require([c["name"] for c in h["columns"]] == want, f"{sname}: columns must be the 18 groups (SPEC "
                                                                  "order) + pred, oof, obs, resid"):
        return
    ok = True
    for g in V2_GROUP_IDS:
        ok &= _expect_column(rep, f"{sname}.{g}", cols[g], "int16", [n], SHAP_SCALE, 0.0, I16_NODATA)
    for k in ("pred", "oof", "obs", "resid"):
        ok &= _expect_column(rep, f"{sname}.{k}", cols[k], "int16", [n], LST_SCALE, 0.0, I16_NODATA)
    meta = h["meta"]
    mmiss = _missing(meta, ["year", "mode", "tier", "base_value_c", "level", "groups"])
    if not rep.require(not mmiss, f"{sname}: meta missing {mmiss}") or not ok:
        return
    rep.require(meta["year"] == year and meta["mode"] == mode, f"{sname}: meta.year/mode")
    rep.require(meta["groups"] == V2_GROUP_IDS, f"{sname}: meta.groups != SPEC group order")
    rep.require(meta["tier"] == ctx.tiers[mode][year], f"{sname}: meta.tier {meta['tier']!r} != manifest "
                                                       f"{ctx.tiers[mode][year]!r}")
    lev = ctx.levels[mode].get(year)
    rep.require(_is_num(meta["level"]) and (not _is_num(lev) or abs(meta["level"] - lev) <= 0.011),
                f"{sname}: meta.level {meta['level']} != manifest level {lev}")
    if _is_num(meta["base_value_c"]) and _is_num(meta["level"]):
        ctx.base_c_minus_level.setdefault(mode, []).append((year, meta["base_value_c"] - meta["level"]))
    shap = np.stack([decode_lstb(cols[g], raws[g]) for g in V2_GROUP_IDS], axis=1)
    pred = decode_lstb(cols["pred"], raws["pred"])
    rows = np.isfinite(shap).all(axis=1) & np.isfinite(pred)
    if rep.require(rows.any(), f"{sname}: no row has complete SHAP values"):
        err = np.abs(pred[rows] - (float(meta["base_value_c"]) + shap[rows].sum(axis=1)))
        rep.require(float(err.max()) <= WATERFALL_TOL_C,
                    f"{sname}: waterfall invariant violated on {int((err > WATERFALL_TOL_C).sum())} rows "
                    f"(max err {float(err.max()):.3f} degC)")
        ctx.waterfall = max(getattr(ctx, "waterfall", 0.0), float(err.max()))
    rep.warn(np.isfinite(pred).mean() > 0.95, f"{sname}: pred missing for {100 * (1 - np.isfinite(pred).mean()):.1f} "
                                              "% of cells")
    rep.warn(rows.mean() > 0.8, f"{sname}: only {100 * rows.mean():.0f} % of rows have complete SHAP values")
    obs, oof, resid = (decode_lstb(cols[k], raws[k]) for k in ("obs", "oof", "resid"))
    both = np.isfinite(obs) & np.isfinite(oof) & np.isfinite(resid)
    if both.any():
        rep.require(float(np.max(np.abs(obs[both] - oof[both] - resid[both]))) <= 0.016,
                    f"{sname}: resid != obs - oof")
    rep.require(not (np.isfinite(resid) & ~(np.isfinite(obs) & np.isfinite(oof))).any(),
                f"{sname}: resid given where obs or oof is missing")
    if ctx.tiers[mode][year] == "modelled":
        rep.require(not np.isfinite(obs).any(), f"{sname}: a modelled frame must not carry observations")
    elif ctx.tiers[mode][year] in ("observed", "observed-sparse"):
        rep.warn(np.isfinite(obs).mean() > 0.5, f"{sname}: observed frame with obs for < 50 % of cells")
    _check_xai_crossfile(sname, mode, year, meta, shap, pred, obs, ctx, rep)


def _corr(a: np.ndarray, b: np.ndarray):
    a, b = np.asarray(a, np.float64), np.asarray(b, np.float64)
    if a.size < 3 or float(a.std()) == 0.0 or float(b.std()) == 0.0:
        return None
    return float(np.corrcoef(a, b)[0, 1])


def _check_xai_crossfile(sname: str, mode: str, year: int, meta: dict, shap: np.ndarray, pred: np.ndarray,
                         obs: np.ndarray, ctx: _V2Context, rep: Report) -> None:
    """XAI frame vs obs cube vs zone cube (C-01): catches row-order and frame-order misalignment between files."""
    tier = ctx.tiers[mode][year]
    cube = ctx.cube_lst.get(mode)
    if cube is not None and year in ctx.obs and cube.shape[-1] == obs.shape[0]:
        f = cube[ctx.obs.index(year)]
        if tier in ("observed", "observed-sparse", "reconstructed"):
            # (a) obs = anomaly + level is the cube field shifted by the frame's composition correction (0 unless
            # section 09 corrected a partially covered frame's level; optional meta key)
            cc = meta.get("composition_correction")
            cc = float(cc) if _is_num(cc) else 0.0
            both = np.isfinite(obs) & np.isfinite(f)
            dmax = float(np.max(np.abs(obs[both] - cc - f[both]))) if both.any() else 0.0
            same_nan = bool(np.array_equal(np.isfinite(obs), np.isfinite(f)))
            rep.require(dmax <= 0.011 + 1e-9 and same_nan,
                        f"{sname}: obs differs from cube_obs_{mode} frame {year} (max {dmax:.3f} degC after the "
                        f"composition correction {cc:+.3f}, same NaN pattern {same_nan}): row or frame misalignment")
        elif tier == "modelled":
            ok = np.isfinite(pred) & np.isfinite(f)
            rho = _corr(pred[ok], f[ok]) if ok.sum() >= 100 else None
            rep.require(rho is None or rho >= 0.5,
                        f"{sname}: corr(pred, cube_obs_{mode} frame {year}) {rho} < 0.5 for a modelled frame "
                        "(row or frame misalignment)")
    okp = np.isfinite(pred) & np.isfinite(obs)
    if okp.sum() >= 100:
        # (c) predictions must track the observations of their own rows
        rho = _corr(pred[okp], obs[okp])
        floor = CORR_MIN_BY_TIER.get(tier, 0.5)
        rep.require(rho is None or rho >= floor, f"{sname}: corr(pred, obs) {rho} < {floor} (SHAP/pred rows "
                                                 "misaligned with obs?)")
        if rho is not None and floor <= rho < 0.5:
            rep.warn(False, f"{sname}: corr(pred, obs) {rho:.3f} on a {tier} frame the model never trained on: the "
                            "prediction agrees only weakly with these observations")
    zc, cen = ctx.zones_obs.get(mode), ctx.zone_centroids.get(mode)
    if zc is not None and cen is not None and year in ctx.obs and zc.shape[-1] == shap.shape[0] \
            and cen.shape == (4, shap.shape[1]):
        # (d) the zone cube equals the nearest zones.json centroid of the row's grouped SHAP
        rows = np.isfinite(shap).all(axis=1)
        if rows.sum() >= 100:
            d2 = ((shap[rows][:, None, :] - cen[None, :, :]) ** 2).sum(axis=-1)
            nearest = np.argmin(d2, axis=1)
            agree = float(np.mean(nearest == zc[ctx.obs.index(year)][rows].astype(np.int64)))
            rep.require(agree >= 0.99, f"{sname}: nearest-centroid zone of the SHAP rows agrees with cube_zones_{mode}"
                                       f" frame {year} on only {100 * agree:.1f} % of rows (< 99 %)")


# ----------------------------------------------------------------------------------------------------------------
# v2 5.4 timeline series
# ----------------------------------------------------------------------------------------------------------------
def _check_fan(rep: Report, tag: str, fan: list, proj: list) -> None:
    rep.require([r.get("year") for r in fan] == proj, f"{tag}: years {[r.get('year') for r in fan]} != {proj}")
    for r in fan:
        q = [r.get(k) for k in ("p05", "p25", "p50", "p75", "p95")]
        if any(v is None for v in q):
            continue
        if not rep.require(all(_is_num(v) for v in q) and all(a <= b + 1e-9 for a, b in zip(q, q[1:])),
                           f"{tag} {r.get('year')}: quantiles not ordered p05 <= p25 <= p50 <= p75 <= p95"):
            return


def check_series_v2(ser: dict, man: dict, ctx: _V2Context, rep: Report) -> None:
    miss = _missing(ser, ["reference_period", "hot_core_threshold_c", "scopes", "series", "zone_share"])
    if not rep.require(not miss, f"timeline_series: missing {miss}"):
        return
    rep.require(ser["reference_period"] == man["timeline"]["reference_period"],
                "timeline_series.reference_period != manifest")
    rep.require(all(_is_num((ser["hot_core_threshold_c"] or {}).get(m)) for m in ctx.modes),
                "timeline_series.hot_core_threshold_c needs a number per mode")
    scopes = ser["scopes"]
    ids = [s.get("id") for s in scopes]
    rep.require(ids[:1] == ["ncr"], "timeline_series.scopes must start with 'ncr'")
    want = ["ncr"] + [f"d:{i}" for i in range(25)] + [f"z:{m}:{k}" for m in ctx.modes for k in range(4)]
    rep.require(set(want) <= set(ids), f"timeline_series.scopes lacks {sorted(set(want) - set(ids))}")
    rep.require(len(ids) == len(set(ids)), "timeline_series.scopes: duplicate ids")
    kinds = {s.get("id"): s for s in scopes}
    for s in scopes:
        rep.require(s.get("kind") in ("ncr", "district", "zone") and isinstance(s.get("label"), str),
                    f"timeline_series.scopes: bad entry {s}")
        if s.get("kind") == "zone":
            rep.require(s.get("mode") in ctx.modes, f"timeline_series.scopes {s.get('id')}: zone scope needs its mode")
    rep.require(set(ser["series"]) == set(ids), "timeline_series.series keys != scope ids")
    budget_bad, fan_checked = 0, 0
    for sid, by_mode in ser["series"].items():
        sc = kinds.get(sid, {})
        modes = [sc.get("mode")] if sc.get("kind") == "zone" else ctx.modes
        rep.require(set(by_mode) == set(modes), f"timeline_series.series.{sid}: modes {sorted(by_mode)} != {modes}")
        for m, e in by_mode.items():
            tag = f"timeline_series.{sid}.{m}"
            emiss = _missing(e, ["frames", "annual", "ssp", "trend", "decomposition", "uncertainty_budget",
                                 "threshold_years"])
            if not rep.require(not emiss, f"{tag}: missing {emiss}"):
                continue
            fr = e["frames"]
            rep.require([r.get("year") for r in fr] == ctx.obs, f"{tag}.frames years != manifest observed frames")
            for r in fr:
                rmiss = _missing(r, ["year", "mean", "ci", "p90", "hot_core_km2", "uhi", "n_cells", "tier"])
                if not rep.require(not rmiss, f"{tag}.frames {r.get('year')}: missing {rmiss}"):
                    break
                rep.require(r["tier"] == ctx.tiers.get(m, {}).get(r["year"]), f"{tag} {r['year']}: tier != manifest")
                rep.require(isinstance(r["n_cells"], int) and r["n_cells"] >= 0 and (ctx.n is None
                                                                                     or r["n_cells"] <= ctx.n),
                            f"{tag} {r['year']}: n_cells")
                if _is_num(r["mean"]):
                    rep.require(_ci_ok(r["ci"]) and (r["ci"] is None or _inside(r["mean"], r["ci"], 0.011)),
                                f"{tag} {r['year']}: ci must contain the mean")
                    rep.require(_max_decimals_excess(np.array([r["mean"]]), 2) < 1e-9,
                                f"{tag} {r['year']}: mean not rounded to 2 dp")
                rep.require(r["hot_core_km2"] is None or (_is_num(r["hot_core_km2"]) and r["hot_core_km2"] >= 0),
                            f"{tag} {r['year']}: hot_core_km2")
                if "coverage" in r:          # optional (D16): finite cells / ROI cells of the scope
                    rep.require(r["coverage"] is None or (_is_num(r["coverage"]) and 0 <= r["coverage"] <= 1),
                                f"{tag} {r['year']}: coverage {r['coverage']!r} must be in [0, 1]")
            ann = e["annual"]
            if isinstance(ann, dict) and ann.get("era5_skin"):
                yrs = [a.get("year") for a in ann["era5_skin"]]
                rep.require(yrs == sorted(yrs), f"{tag}.annual.era5_skin years not increasing")
            for a in (ann or {}).get("satellite", []):
                rep.require(not _missing(a, ["year", "value", "sensor", "flag"]), f"{tag}.annual.satellite keys")
                break
            rep.require(set(e["ssp"]) == set(ctx.scen), f"{tag}.ssp keys {sorted(e['ssp'])} != {ctx.scen}")
            for s, fan in e["ssp"].items():
                _check_fan(rep, f"{tag}.ssp.{s}", fan, ctx.proj)
                fan_checked += 1
            for by_y in (e["uncertainty_budget"] or {}).values():
                for b in by_y.values():
                    parts = [b.get(k) for k in ("gcm", "sensitivity", "land", "model")]
                    if all(_is_num(v) for v in parts) and sum(parts) > 0:
                        budget_bad += int(abs(sum(parts) - 1.0) > 0.01 or min(parts) < -1e-9)
            for s, d in (e["decomposition"] or {}).items():
                rep.require(set(d) <= {str(y) for y in ctx.proj}, f"{tag}.decomposition.{s}: years")
                # optional baseline_c (D14): total = p50 - baseline_c (rows without it come from older bundles)
                fan = (e["ssp"].get(s) if isinstance(e["ssp"], dict) else None) or []
                p50 = {r.get("year"): r.get("p50") for r in fan if isinstance(r, dict)}
                for y, row in d.items():
                    if isinstance(row, dict) and "baseline_c" in row:
                        # same rule as dashboard validateV2.js: an optional key, but a finite number when present
                        rep.require(_is_num(row["baseline_c"]),
                                    f"{tag}.decomposition.{s}.{y}: baseline_c must be a finite number "
                                    f"(got {row['baseline_c']!r})")
                    if not isinstance(row, dict) or not (_is_num(row.get("baseline_c")) and _is_num(row.get("total"))):
                        continue
                    p = p50.get(int(y)) if str(y).isdigit() else None
                    if _is_num(p):
                        rep.require(abs(p - row["baseline_c"] - row["total"]) <= 0.02 + 1e-9,
                                    f"{tag}.decomposition.{s}.{y}: total {row['total']} != p50 {p} - baseline_c "
                                    f"{row['baseline_c']}")
            for s, t in (e["threshold_years"] or {}).items():
                vals = [t.get(k) for k in ("+1", "+2", "+3")]
                rep.require(all(v is None or v in ctx.proj for v in vals), f"{tag}.threshold_years.{s}: years")
                got = [v for v in vals if v is not None]
                rep.require(got == sorted(got) and all(vals[i] is not None for i in range(len(got))),
                            f"{tag}.threshold_years.{s}: +1 <= +2 <= +3 violated")
    rep.require(budget_bad == 0, f"timeline_series: {budget_bad} uncertainty budgets do not sum to 1")
    if ctx.proj:
        rep.require(fan_checked > 0, "timeline_series: no SSP fan although projected frames exist")
    zs = ser["zone_share"]
    for m in ctx.modes:
        e = zs.get(m) if isinstance(zs, dict) else None
        if not rep.require(isinstance(e, dict) and "obs" in e, f"timeline_series.zone_share.{m}.obs missing"):
            continue
        for series_key, by_y in e.items():
            for y, shares in by_y.items():
                if shares and all(_is_num(v) for v in shares):
                    rep.require(len(shares) == 4 and abs(sum(shares) - 1) <= 0.01,
                                f"timeline_series.zone_share.{m}.{series_key}.{y} must be 4 shares summing to 1")


# ----------------------------------------------------------------------------------------------------------------
# v2 raster index + PNGs
# ----------------------------------------------------------------------------------------------------------------
def check_raster_index_v2(web_dir: Path, ri: dict, ctx: _V2Context, rep: Report) -> list:
    miss = _missing(ri, ["crs", "bounds", "width", "height", "preview", "domains", "frames"])
    if not rep.require(not miss, f"raster_index: missing {miss}"):
        return []
    rep.require(ri["crs"] == "EPSG:4326", f"raster_index.crs {ri['crs']!r} != EPSG:4326")
    b = ri["bounds"]
    rep.require(isinstance(b, list) and len(b) == 4 and b[0] < b[2] and b[1] < b[3], "raster_index.bounds [W,S,E,N]")
    rep.require(isinstance(ri["width"], int) and isinstance(ri["height"], int) and ri["width"] > 0 and ri["height"] > 0,
                "raster_index width/height")
    pv = ri["preview"]
    rep.require(not _missing(pv, ["width", "height"]), "raster_index.preview needs width/height")
    for m in ctx.modes:
        d = (ri["domains"] or {}).get(m)
        if d is not None:
            rep.warn(ctx.domains.get(m) is None or [float(d[0]), float(d[1])] == [float(v) for v in ctx.domains[m]],
                     f"raster_index.domains.{m} {d} differs from manifest timeline.domains.{m}.abs "
                     f"{ctx.domains.get(m)}")
    expected = {f"{m}_{y}" for m in ctx.modes for y, flag in ctx.raster.get(m, {}).items() if flag}
    present = set(ri["frames"])
    rep.require(expected <= present, f"raster_index: manifest raster flags without an indexed frame: "
                                     f"{sorted(expected - present)}")
    rep.warn(present <= expected, f"raster_index: indexed frames whose manifest raster flag is false: "
                                  f"{sorted(present - expected)}")
    used = []
    for key, fr in ri["frames"].items():
        fmiss = _missing(fr, ["file", "preview", "lo", "hi", "tier", "downscaled"])
        if not rep.require(not fmiss, f"raster_index.frames.{key}: missing {fmiss}"):
            continue
        mode, _, ys = key.partition("_")
        rep.require(_is_num(fr["lo"]) and _is_num(fr["hi"]) and fr["lo"] < fr["hi"], f"raster_index.{key}: lo >= hi")
        if ys.isdigit() and mode in ctx.tiers and int(ys) in ctx.tiers[mode]:
            rep.require(fr["tier"] == ctx.tiers[mode][int(ys)], f"raster_index.{key}: tier != manifest")
        rep.require(isinstance(fr["downscaled"], bool), f"raster_index.{key}: downscaled must be bool")
        for k, (w, hgt) in (("file", (ri["width"], ri["height"])), ("preview", (pv.get("width"), pv.get("height")))):
            p = web_dir / fr[k]
            used.append(fr[k])
            if not rep.require(p.is_file(), f"raster file {fr[k]} missing"):
                continue
            try:
                hd = read_png_header(p)
            except ValueError as exc:
                rep.require(False, f"{fr[k]}: {exc}")
                continue
            rep.require((hd["width"], hd["height"]) == (w, hgt), f"{fr[k]}: {hd['width']}x{hd['height']} != index "
                                                                 f"{w}x{hgt}")
            rep.require(hd["bit_depth"] == 8 and hd["color_type"] == 2, f"{fr[k]}: must be 8-bit RGB")
    return used


# ----------------------------------------------------------------------------------------------------------------
# v2 5.5 explanation files, 5.6 metrics, 5.7 provenance, models, coupling
# ----------------------------------------------------------------------------------------------------------------
def _check_threshold(th: dict, tag: str, rep: Report) -> None:
    """SPEC_v1 4.4 threshold rules (shared by v1 and v2 dependence files)."""
    tmiss = _missing(th, THRESHOLD_KEYS)
    if not rep.require(not tmiss, f"{tag}.threshold missing {tmiss}"):
        return
    rep.require(th["direction"] in ("cooling", "warming", "mixed"), f"{tag}.threshold.direction")
    for k in ("zero_crossing", "breakpoint", "saturation", "slope_before", "slope_after", "effect_range"):
        rep.require(th[k] is None or _is_num(th[k]), f"{tag}.threshold.{k} must be number|null")
    for k in ("zero_crossing", "breakpoint", "saturation"):
        rep.require(_ci_ok(th[f"{k}_ci"]), f"{tag}.threshold.{k}_ci must be [lo<=hi] or null")
        rep.require(th[k] is not None or th[f"{k}_ci"] is None,
                    f"{tag}.threshold.{k}_ci is given although {k} is null (SPEC 4.4)")
        rep.require(_inside(th[k], th[f"{k}_ci"], 1e-6 * max(1.0, abs(th[k] or 0.0))),
                    f"{tag}.threshold.{k} {th[k]} lies outside its interval {th[f'{k}_ci']}")
        sup = th.get(f"{k}_support")
        rep.require(sup is None or (_is_num(sup) and 0 <= sup <= 1), f"{tag}.threshold.{k}_support must be in [0, 1]")
    if "zero_crossing_flag" in th:
        rep.require(th["zero_crossing_flag"] in (None, "multiple"),
                    f"{tag}.threshold.zero_crossing_flag must be 'multiple' or null")
        rep.require(th["zero_crossing_flag"] != "multiple" or th["zero_crossing"] is None,
                    f"{tag}.threshold: zero_crossing_flag 'multiple' with a zero_crossing value")


def _modes_of(obj: dict, name: str, ctx: _V2Context, rep: Report) -> dict:
    modes = obj.get("modes") if isinstance(obj, dict) else None
    if not rep.require(isinstance(modes, dict), f"{name}: must be {{'modes': {{...}}}} (SPEC 5.5)"):
        return {}
    rep.require(set(modes) == set(ctx.modes), f"{name}: modes {sorted(modes)} != manifest {ctx.modes}")
    return {m: modes[m] for m in ctx.modes if m in modes}


def check_shap_global_v2(sg: dict, ctx: _V2Context, rep: Report) -> None:
    for m, e in _modes_of(sg, "shap_global", ctx, rep).items():
        tag = f"shap_global.{m}"
        miss = _missing(e, ["groups", "global", "by_frame", "by_zone", "n_bootstrap", "ci_method", "ci_label"])
        if not rep.require(not miss, f"{tag}: missing {miss}"):
            continue
        rep.require(e["groups"] == V2_GROUP_IDS, f"{tag}.groups != SPEC group order")
        g = e["global"]
        if rep.require(all(len(g.get(k, [])) == 18 for k in ("mean_abs", "ci_lo", "ci_hi")),
                       f"{tag}.global: arrays must have 18 values"):
            ma, lo, hi = _arr(g["mean_abs"]), _arr(g["ci_lo"]), _arr(g["ci_hi"])
            rep.require(np.all(ma[np.isfinite(ma)] >= 0), f"{tag}.global: negative mean_abs")
            ok = np.isfinite(ma) & np.isfinite(lo) & np.isfinite(hi)
            rep.require(np.all(lo[ok] <= hi[ok] + 1e-9), f"{tag}.global: ci_lo > ci_hi")
            outside = [V2_GROUP_IDS[j] for j in np.flatnonzero(ok & ((ma < lo - 1e-3) | (ma > hi + 1e-3)))]
            rep.require(not outside, f"{tag}.global: mean_abs outside its interval for {outside}")
        want = {str(y) for y, f in ctx.xai.get(m, {}).items() if f}
        rep.require(set(e["by_frame"]) == want, f"{tag}.by_frame keys != XAI frames")
        rep.require(set(e["by_zone"]) <= {"0", "1", "2", "3"}, f"{tag}.by_zone keys")
        for grp in ("by_frame", "by_zone"):
            for k, v in e[grp].items():
                rep.require(len(v.get("mean_abs", [])) == 18 and len(v.get("mean", [])) == 18,
                            f"{tag}.{grp}.{k}: arrays must have 18 values")
        rep.require(isinstance(e["n_bootstrap"], int) and e["n_bootstrap"] >= 0, f"{tag}.n_bootstrap")
        rep.require(e["ci_label"] in ("95% CI", "replicate range", "no bootstrap"), f"{tag}.ci_label")


def check_dependence_v2(dep: dict, ctx: _V2Context, rep: Report) -> None:
    primary = {g: p for g, _, p in V2_GROUPS}
    for m, e in _modes_of(dep, "dependence", ctx, rep).items():
        groups = e.get("groups", {}) if isinstance(e, dict) else {}
        rep.require(list(groups) == V2_GROUP_IDS, f"dependence.{m}: groups differ from SPEC order")
        for g, d in groups.items():
            tag = f"dependence.{m}.{g}"
            miss = _missing(d, ["primary", "bin_centers", "mean", "ci_lo", "ci_hi", "count", "scatter", "threshold"])
            if not rep.require(not miss, f"{tag}: missing {miss}"):
                continue
            rep.require(d["primary"] == primary.get(g), f"{tag}: primary {d['primary']!r} != {primary.get(g)!r}")
            nb = len(d["bin_centers"])
            rep.require(2 <= nb <= 64, f"{tag}: {nb} bins")
            if not rep.require(all(len(d[k]) == nb for k in ("mean", "ci_lo", "ci_hi", "count")),
                               f"{tag}: bin array lengths differ"):
                continue
            centers = _arr(d["bin_centers"])
            rep.require(np.all(np.diff(centers[np.isfinite(centers)]) > 0), f"{tag}: bin_centers not increasing")
            lo, hi = _arr(d["ci_lo"]), _arr(d["ci_hi"])
            ok = np.isfinite(lo) & np.isfinite(hi)
            rep.require(np.all(lo[ok] <= hi[ok] + 1e-9), f"{tag}: ci_lo > ci_hi")
            rep.require(all(isinstance(c, int) and c >= 0 for c in d["count"]), f"{tag}: counts")
            sc = d["scatter"]
            ns = len(sc.get("x", []))
            rep.require(ns <= 1500 and all(len(sc.get(k, [])) == ns for k in ("shap", "color", "zone", "year")),
                        f"{tag}.scatter: lengths")
            rep.require(sc.get("color_feature") in V2_FEATURES, f"{tag}.scatter.color_feature "
                                                                f"{sc.get('color_feature')!r}")
            rep.require(set(sc.get("zone", [])) <= {0, 1, 2, 3, 255}, f"{tag}.scatter.zone ids")
            _check_threshold(d["threshold"], tag, rep)
            if isinstance(d["threshold"], dict) and d["threshold"].get("primary") is not None:
                rep.require(d["threshold"]["primary"] == d["primary"], f"{tag}.threshold.primary != primary")


def check_interactions_v2(it: dict, ctx: _V2Context, rep: Report) -> None:
    for m, e in _modes_of(it, "interactions", ctx, rep).items():
        tag = f"interactions.{m}"
        rep.require(e.get("groups") == V2_GROUP_IDS, f"{tag}.groups != SPEC order")
        mats = [e.get("global", [])] + list((e.get("by_zone") or {}).values())
        if not rep.require(all(len(x) == 18 and all(len(r) == 18 for r in x) for x in mats), f"{tag}: 18 x 18"):
            continue
        rep.require(set(e.get("by_zone") or {}) <= {"0", "1", "2", "3"}, f"{tag}.by_zone keys")
        gm = np.array([[np.nan if v is None else v for v in r] for r in mats[0]], dtype=np.float64)
        rep.require(np.allclose(gm, gm.T, atol=2e-4, equal_nan=True), f"{tag}.global must be symmetric")
        rep.require(np.all(gm[np.isfinite(gm)] >= 0), f"{tag}.global: mean |interaction| must be >= 0")


def _check_recommendation_v2(rep: Report, tag: str, r: dict) -> None:
    rmiss = _missing(r, ["feature", "action", "current", "target", "expected_delta_c", "ci", "priority", "rationale"])
    if not rep.require(not rmiss, f"{tag}: missing {rmiss}"):
        return
    f, d = r["feature"], r["expected_delta_c"]
    rep.require(f in V2_REC_LEVERS, f"{tag}: {f} is not an intervention lever (actionable group primaries)")
    rep.require(r["action"] in ("increase", "decrease"), f"{tag}: action {r['action']!r}")
    allowed = V2_REC_DIRECTIONS.get(f)
    rep.require(allowed is None or r["action"] in allowed, f"{tag}: {r['action']} {f} is not a plausible intervention")
    rep.require(_is_num(d) and d < -0.045, f"{tag}: expected_delta_c {d} must be a cooling < -0.05 degC")
    if _is_num(d):
        want = "high" if d <= -1.0 else ("medium" if d <= -0.3 else "low")
        rep.require(r["priority"] == want, f"{tag}: priority {r['priority']} but delta {d} implies {want}")
    if _is_num(r["current"]) and _is_num(r["target"]):
        rep.require((r["action"] == "increase") == (r["target"] > r["current"]), f"{tag}: action vs target")
        cap = V2_REC_MAX_STEP.get(f)
        if cap is not None:
            rep.require(abs(r["target"] - r["current"]) <= cap + 2e-3 * max(1.0, abs(r["current"])),
                        f"{tag}: step {r['target'] - r['current']:+.4f} exceeds the cap {cap}")
    rep.require(_ci_ok(r["ci"]), f"{tag}: ci")
    rep.require(_inside(d, r["ci"], 0.011), f"{tag}: delta {d} outside its interval {r['ci']}")
    rep.require("associated with" in str(r["rationale"]), f"{tag}: rationale must say 'associated with'")
    if r["ci"] is not None:
        rep.warn(any(tok in str(r["rationale"]) for tok in ("CI", "range")), f"{tag}: rationale does not quote the "
                                                                            "interval")


def _check_zone_display(rep: Report, tag: str, z: dict) -> None:
    """Optional D11 keys: display_name (non-empty string) and label_caveat (string or null)."""
    if "display_name" in z:
        rep.require(isinstance(z["display_name"], str) and z["display_name"].strip() != "",
                    f"{tag}.display_name must be a non-empty string")
    if "label_caveat" in z:
        rep.require(z["label_caveat"] is None or isinstance(z["label_caveat"], str),
                    f"{tag}.label_caveat must be a string or null")


def check_zones_v2(zj: dict, ctx: _V2Context, rep: Report) -> None:
    for m, e in _modes_of(zj, "zones", ctx, rep).items():
        tag = f"zones.{m}"
        miss = _missing(e, ["k", "silhouette", "diagnostics", "zones", "transitions", "labelling"])
        if not rep.require(not miss, f"{tag}: missing {miss}"):
            continue
        rep.require(e["k"] == 4, f"{tag}.k must be 4")
        rep.require(_is_num(e["silhouette"]) and -1 <= e["silhouette"] <= 1, f"{tag}.silhouette")
        dg = e["diagnostics"]
        rep.require(len(dg.get("k", [])) == len(dg.get("inertia", [])) == len(dg.get("silhouette", [])) > 0,
                    f"{tag}.diagnostics lengths")
        rep.require([{k: z.get(k) for k in ("id", "name", "color")} for z in e["zones"]] == ZONES_CANONICAL,
                    f"{tag}.zones must be the canonical zones in id order")
        zc = ctx.zones_obs.get(m)
        zp = ctx.zones_proj.get(m, {})
        for z in e["zones"]:
            ztag = f"{tag}[{z.get('id')}]"
            zmiss = _missing(z, ["id", "name", "color", "description", "n_cells", "area_km2", "lst_mean",
                                 "feature_means", "shap_means", "top_warming", "top_cooling", "top_interactions",
                                 "top_districts", "recommendations"])
            if not rep.require(not zmiss, f"{ztag}: missing {zmiss}"):
                continue
            _check_zone_display(rep, ztag, z)
            rep.require(set(z["n_cells"]) == {str(y) for y in ctx.obs}, f"{ztag}.n_cells keys != observed frames")
            rep.require(set(z["area_km2"]) == {"obs", *ctx.scen} and set(z["lst_mean"]) == {"obs", *ctx.scen},
                        f"{ztag}: area_km2 / lst_mean must be keyed obs + scenarios")
            if zc is not None:
                for j, y in enumerate(ctx.obs):
                    rep.require(z["n_cells"].get(str(y)) == int(np.count_nonzero(zc[j] == z["id"])),
                                f"{ztag}.n_cells[{y}] disagrees with cube_zones_{m}")
            if ctx.cell_km2:
                for y, a in (z["area_km2"].get("obs") or {}).items():
                    if _is_num(a) and str(y) in z["n_cells"]:
                        rep.require(abs(a - z["n_cells"][str(y)] * ctx.cell_km2) <= 0.11 + 1e-6 * a,
                                    f"{ztag}.area_km2.obs[{y}] != n_cells x cell area")
                for s in ctx.scen:
                    raw = zp.get(s)
                    for j, y in enumerate(ctx.proj):
                        a = (z["area_km2"].get(s) or {}).get(str(y))
                        if raw is not None and _is_num(a):
                            n_z = int(np.count_nonzero(raw[j] == z["id"]))
                            rep.require(abs(a - n_z * ctx.cell_km2) <= 0.11 + 1e-6 * a,
                                        f"{ztag}.area_km2.{s}[{y}] disagrees with cube_zones_{m}")
            rep.require(list(z["shap_means"]) == V2_GROUP_IDS, f"{ztag}.shap_means keys != groups")
            rep.require(set(z["feature_means"]) <= set(V2_FEATURES), f"{ztag}.feature_means keys")
            rep.require(all(_is_num(t.get("shap")) and t["shap"] > 0 for t in z["top_warming"])
                        and all(_is_num(t.get("shap")) and t["shap"] < 0 for t in z["top_cooling"]),
                        f"{ztag}: top_warming must be > 0 and top_cooling < 0")
            recs = z["recommendations"]
            rep.require(len(recs) <= 4, f"{ztag}: more than 4 recommendations")
            deltas = [r.get("expected_delta_c") for r in recs]
            rep.require(all(_is_num(v) for v in deltas) and deltas == sorted(deltas),
                        f"{ztag}: recommendations not sorted by expected delta")
            rep.require(len({r.get("feature") for r in recs}) == len(recs), f"{ztag}: one action per feature")
            for r in recs:
                _check_recommendation_v2(rep, f"{ztag} recommendation {r.get('feature')}", r)
        tr = e["transitions"]
        rep.require(set(tr) == {"obs", *ctx.scen}, f"{tag}.transitions keys {sorted(tr)}")
        want = {f"{a}->{b}" for a, b in zip(ctx.obs[:-1], ctx.obs[1:])}
        rep.require(set(tr.get("obs") or {}) == want, f"{tag}.transitions.obs keys {sorted(tr.get('obs') or {})}")
        for key, mat in (tr.get("obs") or {}).items():
            if not rep.require(len(mat) == 4 and all(len(r) == 4 for r in mat), f"{tag}.transitions.obs[{key}]: 4x4"):
                continue
            a, _, b = key.partition("->")
            if zc is not None and a.isdigit() and b.isdigit() and int(a) in ctx.obs and int(b) in ctx.obs:
                za, zb = zc[ctx.obs.index(int(a))], zc[ctx.obs.index(int(b))]
                common = int(np.count_nonzero((za < 4) & (zb < 4)))
                rep.require(int(np.sum(mat)) == common, f"{tag}.transitions.obs[{key}] total {int(np.sum(mat))} != "
                                                        f"{common} cells zoned in both frames")
        for s in ctx.scen:
            seq = [ctx.obs[-1]] + ctx.proj if ctx.obs else ctx.proj
            want_s = {f"{a}->{b}" for a, b in zip(seq[:-1], seq[1:])}
            got = tr.get(s) or {}
            rep.require(set(got) == want_s or (set(got) and all(k.split("->")[1].isdigit() for k in got)),
                        f"{tag}.transitions.{s} keys {sorted(got)}")
            for key, mat in got.items():
                rep.require(len(mat) == 4 and all(len(r) == 4 for r in mat), f"{tag}.transitions.{s}[{key}]: 4x4")


def check_metrics_v2(mt: dict, ctx: _V2Context, rep: Report) -> None:
    miss = _missing(mt, ["modes", "downscaling", "land_model", "climate_sensitivity", "night_calibration", "hardware",
                         "timings"])
    if not rep.require(not miss, f"metrics: missing keys {miss}"):
        return
    for m, e in _modes_of(mt, "metrics", ctx, rep).items():
        tag = f"metrics.{m}"
        emiss = _missing(e, ["schemes", "summary", "folds", "block_size_curve", "error_vs_distance", "loeo",
                             "place_time", "moran", "moran_target", "moran_scatter", "fold_geometry", "aoa",
                             "persistent_residual", "hindcast", "cross_sensor", "v1_comparison", "headline"])
        if not rep.require(not emiss, f"{tag}: missing {emiss}"):
            continue
        for rec in e["summary"]:
            if not rep.require(not _missing(rec, ["scheme", "model", "r2_pooled", "rmse_pooled", "mae_pooled",
                                                  "r2_fold_mean", "r2_fold_sd", "n_folds", "n"]),
                               f"{tag}.summary record keys"):
                break
        for rec in e["folds"]:
            if not rep.require(not _missing(rec, ["scheme", "model", "fold", "r2", "rmse", "mae", "n_train", "n_test",
                                                  "fit_seconds", "device"]), f"{tag}.folds record keys"):
                break
        pairs = {(r.get("scheme"), r.get("model")) for r in e["summary"]}
        rep.require(("block20", "xgboost") in pairs, f"{tag}: no block20/xgboost summary (the spatial headline)")
        rep.warn(("loeo", "xgboost") in pairs, f"{tag}: no loeo/xgboost summary")
        hl = e["headline"]
        sp, tp = (hl or {}).get("spatial") or {}, (hl or {}).get("temporal") or {}
        rep.require(sp.get("scheme") == "block20" and sp.get("model") == "xgboost" and _is_num(sp.get("r2"))
                    and _is_num(sp.get("rmse")), f"{tag}.headline.spatial must be block20/xgboost with r2/rmse")
        rep.require(tp.get("scheme") == "loeo" and _is_num(tp.get("r2")) and _is_num(tp.get("rmse")),
                    f"{tag}.headline.temporal must be loeo with r2/rmse")
        for rec in e["loeo"]:
            rep.require(not _missing(rec, ["held_out", "r2_raw", "r2_recentred", "rmse_recentred", "bias_raw"]),
                        f"{tag}.loeo record keys")
            break
        for rec in e["block_size_curve"]:
            rep.require(not _missing(rec, ["block_km", "r2_pooled", "rmse_pooled"]), f"{tag}.block_size_curve keys")
        for rec in e["error_vs_distance"]:
            rep.require(not _missing(rec, ["lo", "hi", "rmse", "n"]), f"{tag}.error_vs_distance keys")
        for key in ("block20", "block5"):
            fg = (e["fold_geometry"] or {}).get(key)
            if rep.require(isinstance(fg, dict) and not _missing(fg, ["block_km", "n_rows", "n_cols", "fold_of_block",
                                                                      "rmse_of_block"]),
                           f"{tag}.fold_geometry.{key} keys"):
                nb = fg["n_rows"] * fg["n_cols"]
                rep.require(len(fg["fold_of_block"]) == nb == len(fg["rmse_of_block"]),
                            f"{tag}.fold_geometry.{key}: arrays must have n_rows x n_cols entries")
        aoa = e["aoa"]
        rep.require(not _missing(aoa, ["di_threshold", "pct_inside", "rmse_by_di_decile"]), f"{tag}.aoa keys")
        pr = e["persistent_residual"]
        rep.require(not _missing(pr, ["lambda", "loeo_rmse_without", "loeo_rmse_with"]),
                    f"{tag}.persistent_residual keys")
        for rec in e["moran"]:
            rep.require(not _missing(rec, ["scheme", "model", "year", "I", "expected_I", "z", "p"]),
                        f"{tag}.moran keys")
            break
        ms = e["moran_scatter"]
        if ms:
            rep.require(not _missing(ms, ["year", "z", "lag", "slope"]) and len(ms["z"]) == len(ms["lag"]) <= 2000,
                        f"{tag}.moran_scatter keys / lengths")
        rep.require(isinstance(e["cross_sensor"], dict), f"{tag}.cross_sensor must be an object")
    ds = mt["downscaling"]
    si = ((ds or {}).get("night") or {}).get("scale_invariance") if "night" in ctx.modes else None
    if "night" in ctx.modes:
        rep.require(isinstance(si, dict) and (not si.get("available", True)
                                               or not _missing(si, ["r2", "rmse", "bias", "bilinear_rmse"])),
                    "metrics.downscaling.night.scale_invariance keys")
    dd = (ds or {}).get("day_demo")
    rep.require(dd is None or not dd.get("available", True) or not _missing(dd, ["r2", "rmse", "bilinear_rmse",
                                                                                 "years"]),
                "metrics.downscaling.day_demo keys")
    lm = mt["land_model"]
    if ctx.proj:
        rep.require(isinstance(lm, dict) and (not lm.get("available", True) or not _missing(
            lm, ["fom", "fom_null", "quantity_disagreement", "allocation_disagreement", "rmse_du", "rmse_du_null"])),
            "metrics.land_model keys")
    if isinstance(lm, dict) and "verdict" in lm:      # optional (D18)
        rep.require(lm["verdict"] in (None, "beats_null", "mixed", "worse_than_null"),
                    f"metrics.land_model.verdict {lm['verdict']!r}")
        checks = lm.get("checks")
        if rep.require(checks is None or isinstance(checks, list), "metrics.land_model.checks must be a list"):
            bad = [i for i, c in enumerate(checks or [])
                   if not (isinstance(c, dict) and not _missing(c, ["check", "value", "null", "ok"]))]
            rep.require(not bad, f"metrics.land_model.checks entries {bad[:5]} need check/value/null/ok")
    for m in ctx.modes:
        cs = (mt["climate_sensitivity"] or {}).get(m)
        rep.require(isinstance(cs, dict) and not _missing(cs, ["beta", "ci", "r2", "n_years", "theil_sen"]),
                    f"metrics.climate_sensitivity.{m} keys")
        if isinstance(cs, dict) and _is_num(cs.get("beta")) and _ci_ok(cs.get("ci")) and cs.get("ci"):
            rep.require(_inside(cs["beta"], cs["ci"], 1e-3), f"metrics.climate_sensitivity.{m}: beta outside its CI")
    hw = mt["hardware"]
    rep.require(not _missing(hw, ["gpus", "xgb_device", "lgbm_device", "rapids"]), "metrics.hardware keys")
    if "rapids_used" in hw:
        used = hw["rapids_used"]
        ok = (isinstance(used, list) and all(isinstance(u, str) for u in used)) or (
            isinstance(used, dict) and all(isinstance(v, bool) for v in used.values()))
        if rep.require(ok, "metrics.hardware.rapids_used must be a list of names or {component: bool}"):
            any_used = bool(used) if isinstance(used, list) else any(used.values())
            rep.require(hw.get("rapids") == any_used, "metrics.hardware.rapids disagrees with rapids_used")


def check_provenance_v2(pv: dict, ctx: _V2Context, rep: Report) -> None:
    miss = _missing(pv, ["sources", "frames", "annotations"])
    if not rep.require(not miss, f"provenance: missing {miss}"):
        return
    for s in pv["sources"]:
        if not rep.require(not _missing(s, ["id", "label", "asset", "start", "end", "resolution_m", "role", "used_for",
                                            "notes"]), f"provenance.sources: bad entry {s.get('id')}"):
            break
    ids = [s.get("id") for s in pv["sources"]]
    rep.require(len(ids) == len(set(ids)) and ids, "provenance.sources: ids must be unique and non-empty")
    have = set()
    for f in pv["frames"]:
        if not rep.require(not _missing(f, ["year", "mode", "tier", "sensor", "window", "scenes", "coverage",
                                            "overpass_ist"]), f"provenance.frames: bad entry {f}"):
            break
        have.add((f["year"], f["mode"]))
        if f["mode"] in ctx.tiers and f["year"] in ctx.tiers[f["mode"]]:
            rep.require(f["tier"] == ctx.tiers[f["mode"]][f["year"]], f"provenance.frames {f['mode']} {f['year']}: "
                                                                      "tier != manifest")
    want = {(y, m) for m in ctx.modes for y in ctx.obs + ctx.proj}
    rep.require(want <= have, f"provenance.frames lacks {sorted(want - have)[:6]}")


def check_models_v2(web_dir: Path, man: dict, ctx: _V2Context, rep: Report) -> None:
    for m in ctx.modes:
        name = man["files"]["model"][m]
        model = load_strict(web_dir / name)
        before = len(rep.errors)
        check_model(model, V2_FEATURES, man, rep)
        for i in range(before, len(rep.errors)):
            rep.errors[i] = f"{name}: {rep.errors[i]}"
        focal = model.get("focal")
        rep.require(isinstance(focal, dict) and focal.get("bases") == V2_FOCAL_BASES
                    and focal.get("windows") == V2_FOCAL_WINDOWS,
                    f"{name}: focal must be FOCAL_SPEC {{bases, windows}}")
        rep.warn(model.get("mode", m) == m, f"{name}: mode {model.get('mode')!r} != {m!r}")


def check_coupling_v2(cp: dict, man: dict, rep: Report) -> None:
    rep.require(cp.get("fraction_features") == V2_FRACTIONS, f"scenario_coupling.fraction_features "
                                                             f"{cp.get('fraction_features')} != {V2_FRACTIONS}")
    rep.require(isinstance(cp.get("description"), str), "scenario_coupling.description")
    coup = cp.get("coupling") or {}
    rep.require(all(set(coup.get(f, {})) >= {"ndvi", "ndbi", "mndwi"} and all(_is_num(v) for v in coup[f].values())
                    for f in V2_FRACTIONS), "scenario_coupling.coupling must give numeric ndvi/ndbi/mndwi slopes per "
                                            "fraction")
    focal = cp.get("focal")
    rep.require(isinstance(focal, dict) and focal.get("bases") == V2_FOCAL_BASES
                and focal.get("windows") == V2_FOCAL_WINDOWS, "scenario_coupling.focal must be FOCAL_SPEC")
    g = cp.get("grid") or {}
    mg = man["study_area"].get("grid") or {}
    rep.require(g.get("width") == mg.get("width") and g.get("height") == mg.get("height"),
                "scenario_coupling.grid width/height != manifest grid")


def check_districts_geojson(geo: dict, rep: Report) -> None:
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


def validate_v2(web_dir, max_mb: float = None) -> Report:
    """Every v2 check on ``web_dir`` (manifest schema 2.x); returns the Report (errors empty = valid)."""
    web_dir = Path(web_dir)
    rep = Report()
    man = load_strict(web_dir / "manifest.json")
    ctx = check_manifest_v2(man, rep)
    if ctx is None:
        return rep
    for name in ctx.files:
        rep.require((web_dir / name).is_file(), f"missing file {name}")
    if rep.errors:
        return rep
    check_cells_v2(web_dir, ctx, rep)
    zones_json = load_strict(web_dir / man["files"]["zones"])
    for m in ctx.modes:
        cen = (((zones_json.get("modes") or {}).get(m) or {}).get("centroids")
               if isinstance(zones_json, dict) else None)
        try:
            cen = np.asarray(cen, np.float64) if cen is not None else None
        except (TypeError, ValueError):
            cen = None
        if cen is not None and cen.shape == (4, len(V2_GROUP_IDS)) and np.isfinite(cen).all():
            ctx.zone_centroids[m] = cen
    methods = {s["id"]: s["method"] for s in man["timeline"]["scenarios"]}
    for m in ctx.modes:
        check_obs_cube_v2(web_dir, m, ctx, rep)
        for s in ctx.scen:
            check_ssp_cube_v2(web_dir, m, s, methods.get(s), ctx, rep)
        check_zone_cube_v2(web_dir, m, ctx, rep)
        for y, files in sorted((man["files"]["xai"].get(m) or {}).items()):
            check_xai_v2(web_dir, m, int(y), files, ctx, rep)
        offs = [v for _, v in ctx.base_c_minus_level.get(m, [])]
        if offs:
            rep.require(max(offs) - min(offs) <= 2e-3, f"xai {m}: base_value_c - level varies across frames "
                                                       f"({min(offs):.4f}..{max(offs):.4f}); it must be the SHAP base")
            sb = (man.get("shap_base") or {}).get(m) if isinstance(man.get("shap_base"), dict) else None
            if _is_num(sb):
                rep.require(abs(offs[0] - sb) <= 2e-3, f"xai {m}: base_value_c - level != manifest.shap_base.{m}")
    check_series_v2(load_strict(web_dir / man["files"]["series"]), man, ctx, rep)
    raster_files = []
    if man["timeline"]["raster_index"]:
        raster_files = check_raster_index_v2(web_dir, load_strict(web_dir / man["timeline"]["raster_index"]), ctx, rep)
    check_shap_global_v2(load_strict(web_dir / man["files"]["shap_global"]), ctx, rep)
    check_dependence_v2(load_strict(web_dir / man["files"]["dependence"]), ctx, rep)
    check_interactions_v2(load_strict(web_dir / man["files"]["interactions"]), ctx, rep)
    check_zones_v2(zones_json, ctx, rep)
    check_metrics_v2(load_strict(web_dir / man["files"]["metrics"]), ctx, rep)
    check_provenance_v2(load_strict(web_dir / man["files"]["provenance"]), ctx, rep)
    check_models_v2(web_dir, man, ctx, rep)
    check_coupling_v2(load_strict(web_dir / man["files"]["coupling"]), man, rep)
    check_districts_geojson(load_strict(web_dir / man["files"]["districts"]), rep)
    referenced = {"manifest.json", *ctx.files, *raster_files}
    total = sum((web_dir / p).stat().st_size for p in referenced if (web_dir / p).is_file())
    rep.info.append(f"schema {man['schema_version']} ({man['data_mode']}): {len(ctx.modes)} modes, {len(ctx.obs)} "
                    f"observed + {len(ctx.proj)} projected frames, scenarios {ctx.scen}, n = {ctx.n:,} cells")
    if hasattr(ctx, "waterfall"):
        rep.info.append(f"SHAP waterfall max error over all XAI files: {ctx.waterfall:.4f} degC")
    rep.info.append(f"bundle size on disk {total / 1e6:.2f} MB in {len(referenced)} files")
    if max_mb is None:
        rep.warn(total <= V2_DEFAULT_WARN_MB * 1e6, f"bundle is {total / 1e6:.1f} MB on disk > "
                                                    f"{V2_DEFAULT_WARN_MB:g} MB (slow to load over mobile connections)")
    else:
        rep.require(total <= max_mb * 1e6, f"bundle is {total / 1e6:.1f} MB on disk > {max_mb:g} MB limit")
    stray = sorted(p.relative_to(web_dir).as_posix() for p in web_dir.rglob("*") if p.is_file()
                   and p.name.endswith((".json", ".json.gz", ".lstb.gz", ".lstb", ".png", ".geojson"))
                   and p.relative_to(web_dir).as_posix() not in referenced)
    rep.warn(not stray, f"files not referenced by the manifest (stale export?): {stray[:10]}")
    return rep


def detect_schema(web_dir) -> str:
    """'1' or '2' from manifest.schema_version (ValueError when it is neither)."""
    man = load_strict(Path(web_dir) / "manifest.json")
    version = str(man.get("schema_version", ""))
    major = version.split(".")[0]
    if major not in ("1", "2"):
        raise ValueError(f"unsupported manifest.schema_version {version!r} (expected 1.x or 2.x)")
    return major


def validate_bundle(web_dir, max_mb: float = None, schema: str = "auto") -> Report:
    """Validate ``web_dir`` against the contract of its schema version (auto-detected unless ``schema`` is 1/2)."""
    web_dir = Path(web_dir)
    if not (web_dir / "manifest.json").is_file():
        rep = Report()
        rep.errors.append(f"{web_dir / 'manifest.json'} not found")
        return rep
    major = detect_schema(web_dir) if schema == "auto" else str(schema)
    rep = validate_v2(web_dir, max_mb) if major == "2" else validate_v1(web_dir, max_mb)
    spec = "docs/SPEC.md section 5" if major == "2" else "docs/SPEC_v1.md section 4"
    rep.info.insert(0, f"contract: schema {major}.x ({spec})")
    return rep


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("web_dir", type=Path)
    ap.add_argument("--max-mb", type=float, default=None,
                    help="hard limit for the on-disk bundle size in MB (default: only warn above 25 MB for v1, "
                         "100 MB for v2)")
    ap.add_argument("--schema", choices=["auto", "1", "2"], default="auto",
                    help="contract to validate against (default: from manifest.schema_version)")
    ap.add_argument("--quiet", action="store_true", help="print only the verdict and errors")
    args = ap.parse_args(argv)
    try:
        rep = validate_bundle(args.web_dir, args.max_mb, args.schema)
    except (OSError, ValueError, KeyError, TypeError, IndexError, AttributeError) as exc:
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
