# %% [markdown]
# # 5. Exports: Parquet, GeoJSON, native model, compact web model and the dashboard bundle
#
# ```
# outputs/
# ├── parquet/  features_long, predictions_shap, cv_fold_metrics, cv_summary, moran_results, shap_ci_<last>
# ├── npz/      shap_interactions_<year>.npz  (written in section 4)
# ├── geo/      ncr_districts.geojson, zones_<year>.geojson (1 km cell squares, lon/lat)
# ├── models/   xgb_final.json (native XGBoost)
# ├── figures/  *.png
# ├── web/      manifest.json, epoch_<year>.json.gz, model_web.json, shap_global.json, dependence.json.gz,
# │             zones.json, metrics.json, interactions.json, scenario_coupling.json, districts.geojson
# └── web_bundle.zip
# ```
#
# **Compression.** The two large file kinds (`epoch_<year>` and `dependence`) are written gzip-compressed (level 9,
# fixed mtime so re-runs are byte-identical) as `*.json.gz`; `manifest.files` names them. Readers detect gzip by its
# magic bytes (0x1f 0x8b), not by the file name, so a server that already sent `Content-Encoding: gzip` also works.
# This shrinks a 1 km bundle from ~71 MB to ~19 MB.
#
# **Loading into the dashboard:** copy the *contents* of `outputs/web/` (or unzip `web_bundle.zip`) into
# `dashboard/public/data/`, then `npm run dev` (or `npm run build`) inside `dashboard/`. On Kaggle download
# `web_bundle.zip` from the output panel. Alternatively host the files anywhere and set `VITE_DATA_BASE_URL`.
#
# **Web model.** The dashboard runs scenario inference in the browser with a *surrogate* XGBoost model
# (depth ≤ 6, ≤ 400 trees) serialised to a compact array format (`lst-xgb-compact-v1`). The export evaluates
# that format with an independent numpy traverser and requires agreement with XGBoost to < 10⁻³ (including
# missing values), and embeds 50 check rows so the JavaScript evaluator can prove the same.
#
# All web JSON is compact UTF-8 with NaN/Inf → `null`; rounding: lon/lat 5 dp, °C 2 dp, SHAP 3 dp,
# feature values 4 significant digits. Every file is re-read and validated against the contract at the end.

# %%
import datetime as _dt
import gzip
import json
import math
import os
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd
import xgboost as xgb

_OUT = Path(CFG.OUTPUT_DIR)
_PARQUET_DIR, _GEO_DIR, _MODEL_DIR, _WEB_DIR = (Path(CFG.PARQUET_DIR), Path(CFG.GEO_DIR),
                                                 Path(CFG.MODEL_DIR), Path(CFG.WEB_DIR))
for _d in (_PARQUET_DIR, _GEO_DIR, _MODEL_DIR, _WEB_DIR):
    _d.mkdir(parents=True, exist_ok=True)
_EXP_EPOCHS = sorted(int(y) for y in DF["year"].unique())
_EXP_LAST = _EXP_EPOCHS[-1]
_WEB_MAX_BYTES = 6 * 1024 * 1024
_TARGET_UNIT_OFFSET = {y: (float(EPOCH_MEANS[y]) if CFG.TARGET_MODE == "anomaly" else 0.0) for y in _EXP_EPOCHS}


def _round_dp(arr, dp):
    return np.round(np.asarray(arr, dtype=np.float64), dp)


def _round_sig(arr, sig=4):
    """Round to `sig` significant digits, producing the nearest double of the decimal (clean JSON)."""
    a = np.asarray(arr, dtype=np.float64)
    out = np.full(a.shape, np.nan)
    ok = np.isfinite(a) & (a != 0)
    out[np.isfinite(a) & (a == 0)] = 0.0
    if ok.any():
        k = (sig - 1 - np.floor(np.log10(np.abs(a[ok])))).astype(np.int64)
        v = a[ok]
        pos = k >= 0
        res = np.empty_like(v)
        scale_pos = 10.0 ** k[pos]
        res[pos] = np.round(v[pos] * scale_pos) / scale_pos          # integer / 10^k: correctly rounded
        scale_neg = 10.0 ** (-k[~pos])
        res[~pos] = np.round(v[~pos] / scale_neg) * scale_neg        # integer * 10^m: exact
        out[ok] = res
    return out


def _sig(v, sig=4):
    """Scalar version of _round_sig (None for missing/non-finite)."""
    if v is None:
        return None
    r = float(_round_sig(np.array([v], dtype=np.float64), sig)[0])
    return r if math.isfinite(r) else None


def _json_list(arr):
    """numpy array -> list with None for NaN/Inf."""
    a = np.asarray(arr)
    if a.dtype.kind in "iub":
        return a.tolist()
    a = a.astype(np.float64)
    out = a.tolist()
    for i in np.flatnonzero(~np.isfinite(a)):
        out[i] = None
    return out


def _clean(obj):
    """Recursively convert numpy/pandas types to JSON-safe Python (NaN/Inf -> None, keys -> str)."""
    if isinstance(obj, dict):
        return {str(k): _clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_clean(v) for v in obj]
    if isinstance(obj, np.ndarray):
        return _clean(_json_list(obj) if obj.ndim == 1 else obj.tolist())
    if isinstance(obj, (bool, np.bool_)):
        return bool(obj)
    if isinstance(obj, (int, np.integer)):
        return int(obj)
    if isinstance(obj, (float, np.floating)):
        v = float(obj)
        return v if math.isfinite(v) else None
    if isinstance(obj, Path):
        return str(obj)
    if obj is None or isinstance(obj, str):
        return obj
    if isinstance(obj, (pd.Timestamp, _dt.datetime, _dt.date)):
        return obj.isoformat()
    raise TypeError(f"Cannot serialise {type(obj).__name__} to JSON")


def _write_json(obj, path):
    """Compact UTF-8 JSON without NaN/Infinity (gzip level 9 when the name ends in .gz); returns bytes on disk."""
    data = json.dumps(_clean(obj), separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")
    path = Path(path)
    if path.suffix == ".gz":
        data = gzip.compress(data, compresslevel=9, mtime=0)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)
    return len(data)


def _read_bytes_maybe_gzip(path):
    """File bytes, gunzipped when they start with the gzip magic number (independent of the file name)."""
    raw = Path(path).read_bytes()
    return gzip.decompress(raw) if raw[:2] == b"\x1f\x8b" else raw


def _round_nested(obj, fn):
    """Apply a scalar rounding function to every float inside nested lists/dicts."""
    if isinstance(obj, dict):
        return {k: _round_nested(v, fn) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_round_nested(v, fn) for v in obj]
    if isinstance(obj, (float, np.floating)):
        v = float(obj)
        return fn(v) if math.isfinite(v) else None
    return obj


def _dp(n):
    return lambda v: round(v, n)


# %% [markdown]
# ## 5.1 Parquet, native model

# %%
_BASE_DF_COLS = ["cell_id", "row", "col", "x", "y", "lon", "lat", "district", "year", *FEATURES, "pop_density",
                 "lst", "lst_obs_count", "epoch_mean", "target", "spatial_block", "fold_spatial", "fold_random",
                 "block10_id"]


def _to_parquet(df, name):
    path = _PARQUET_DIR / name
    df.to_parquet(path, engine="pyarrow", compression="zstd", index=False)
    log(f"  {path.name}: {len(df):,} rows, {path.stat().st_size / 1e6:.2f} MB")
    return path


def _export_parquet():
    _to_parquet(DF[[c for c in _BASE_DF_COLS if c in DF.columns]], "features_long.parquet")
    pred = DF[["cell_id", "row", "col", "lon", "lat", "district", "year", "lst", "lst_pred", "lst_pred_oof",
               "resid_oof", "zone"]].copy()
    for j, f in enumerate(FEATURES):
        pred[f"shap_{f}"] = SHAP_VALUES[:, j]
    _to_parquet(pred, "predictions_shap.parquet")
    _to_parquet(CV_FOLD_METRICS, "cv_fold_metrics.parquet")
    _to_parquet(CV_SUMMARY, "cv_summary.parquet")
    _to_parquet(MORAN_RESULTS, "moran_results.parquet")
    _to_parquet(SHAP_CI_LATEST, f"shap_ci_{_EXP_LAST}.parquet")


with timer("05_parquet_model"):
    _export_parquet()
    FINAL_MODEL.save_model(str(_MODEL_DIR / "xgb_final.json"))
    log(f"  models/xgb_final.json: {(_MODEL_DIR / 'xgb_final.json').stat().st_size / 1e6:.2f} MB")


# %% [markdown]
# ## 5.2 GeoJSON: districts and per-epoch zone cells
# Cell squares are built from the grid corners in UTM 43N and reprojected once (a (H+1)×(W+1) corner lattice)
# to lon/lat, so neighbouring polygons share vertices exactly. Rings are counter-clockwise (RFC 7946).

# %%
def _corner_lonlat():
    """(H+1, W+1) lon/lat arrays of the grid-cell corners."""
    try:
        from pyproj import Transformer
    except ImportError:
        pip_install(["pyproj"])
        from pyproj import Transformer
    xs = GRID.x0 + np.arange(GRID.width + 1) * GRID.res
    ys = GRID.y0 - np.arange(GRID.height + 1) * GRID.res
    XX, YY = np.meshgrid(xs, ys)
    lon, lat = Transformer.from_crs(GRID.crs, "EPSG:4326", always_xy=True).transform(XX, YY)
    return np.round(lon, 5), np.round(lat, 5)


def _write_zone_geojson(year, lon_c, lat_c):
    sub = DF[DF["year"] == year]
    r, c = sub["row"].to_numpy(), sub["col"].to_numpy()
    lst = _json_list(_round_dp(sub["lst"], 2))
    pred = _json_list(_round_dp(sub["lst_pred"], 2))
    path = _GEO_DIR / f"zones_{year}.geojson"
    with open(path, "w", encoding="utf-8") as fh:
        fh.write('{"type":"FeatureCollection","features":[')
        for i in range(len(sub)):
            # bottom-left -> bottom-right -> top-right -> top-left -> close (counter-clockwise; row 0 is north)
            corners = [(r[i] + 1, c[i]), (r[i] + 1, c[i] + 1), (r[i], c[i] + 1), (r[i], c[i]), (r[i] + 1, c[i])]
            ring = [[float(lon_c[a, b]), float(lat_c[a, b])] for a, b in corners]
            feature = {"type": "Feature",
                       "geometry": {"type": "Polygon", "coordinates": [ring]},
                       "properties": {"cell_id": int(sub["cell_id"].iat[i]), "zone": int(sub["zone"].iat[i]),
                                      "lst": lst[i], "lst_pred": pred[i]}}
            fh.write(("," if i else "") + json.dumps(feature, separators=(",", ":"), allow_nan=False))
        fh.write("]}")
    return path


def _districts_geojson():
    """BOUNDARY_GEOJSON with 5-dp coordinates and exactly the contract properties."""
    feats = []
    for feat in BOUNDARY_GEOJSON["features"]:
        props = feat.get("properties", {})
        feats.append({"type": "Feature",
                      "geometry": _round_nested(feat["geometry"], _dp(5)),
                      "properties": {"id": int(props["id"]), "name": str(props["name"]),
                                     "state": str(props["state"])}})
    return {"type": "FeatureCollection", "features": feats}


with timer("05_geojson"):
    _LON_C, _LAT_C = _corner_lonlat()
    _DISTRICTS_FC = _districts_geojson()
    _write_json(_DISTRICTS_FC, _GEO_DIR / "ncr_districts.geojson")
    for _y in _EXP_EPOCHS:
        _zp = _write_zone_geojson(_y, _LON_C, _LAT_C)
        log(f"  {_zp.name}: {_zp.stat().st_size / 1e6:.1f} MB")
    _rows_c, _cols_c = DF["row"].to_numpy(), DF["col"].to_numpy()
    _cell_lons = np.concatenate([_LON_C[_rows_c, _cols_c], _LON_C[_rows_c + 1, _cols_c + 1]])
    _cell_lats = np.concatenate([_LAT_C[_rows_c, _cols_c], _LAT_C[_rows_c + 1, _cols_c + 1]])
    _BBOX = [float(np.min(_cell_lons)), float(np.min(_cell_lats)), float(np.max(_cell_lons)),
             float(np.max(_cell_lats))]
    del _cell_lons, _cell_lats, _rows_c, _cols_c
free_memory()


# %% [markdown]
# ## 5.3 Compact web model (surrogate) with an independent evaluator

# %%
def _parse_base_score(raw):
    """learner_model_param.base_score is '4.1E1' (XGBoost 2.x) or '[4.1E1]' (3.x vector form)."""
    text = str(raw).strip().strip("[]").split(",")[0].strip()
    return float(text)


def _booster_to_compact(booster, fidelity, check):
    """Convert a gbtree booster's JSON dump to the lst-xgb-compact-v1 structure (SPEC 4.3)."""
    raw = json.loads(bytes(booster.save_raw(raw_format="json")).decode("utf-8"))
    learner = raw["learner"]
    gb = learner["gradient_booster"]
    if gb.get("name") != "gbtree":
        raise ValueError(f"compact export supports gbtree only, got {gb.get('name')}")
    trees = []
    for tree in gb["model"]["trees"]:
        left = [int(v) for v in tree["left_children"]]
        right = [int(v) for v in tree["right_children"]]
        leaf = [lc == -1 for lc in left]
        cond = tree["split_conditions"]
        trees.append({
            "f": [-1 if is_leaf else int(fi) for fi, is_leaf in zip(tree["split_indices"], leaf)],
            "t": [0 if is_leaf else float(np.float32(t)) for t, is_leaf in zip(cond, leaf)],
            "l": left,
            "r": right,
            "d": [0 if is_leaf else int(bool(dl)) for dl, is_leaf in zip(tree["default_left"], leaf)],
            "v": [float(f"{float(np.float32(v)):.9g}") if is_leaf else 0 for v, is_leaf in zip(cond, leaf)],
        })
    return {
        "format": "lst-xgb-compact-v1",
        "objective": str(learner.get("objective", {}).get("name", "reg:squarederror")),
        "target_mode": CFG.TARGET_MODE,
        "features": list(FEATURES),
        "base_score": _parse_base_score(learner["learner_model_param"]["base_score"]),
        "n_trees": len(trees),
        "trees": trees,
        "fidelity": fidelity,
        "check": check,
    }


def _compile_compact(model):
    return [tuple(np.asarray(t[k], dtype=dt) for k, dt in
                  (("f", np.int64), ("t", np.float64), ("l", np.int64), ("r", np.int64), ("d", np.int64),
                   ("v", np.float64))) for t in model["trees"]]


def _predict_compact(model, X):
    """Pure-numpy evaluator of lst-xgb-compact-v1 (NaN/None = missing). Returns target units."""
    X = np.array(X, dtype=np.float64)  # None -> NaN
    out = np.full(X.shape[0], float(model["base_score"]), dtype=np.float64)
    for f, t, left, right, dflt, v in _compile_compact(model):
        node = np.zeros(X.shape[0], dtype=np.int64)
        while True:
            active = np.flatnonzero(left[node] != -1)
            if active.size == 0:
                break
            nd = node[active]
            xv = X[active, f[nd]]
            go_left = np.where(np.isnan(xv), dflt[nd] == 1, xv < t[nd])
            node[active] = np.where(go_left, left[nd], right[nd])
        out += v[node]
    return out


def _train_surrogate(rounds):
    """Depth-6 XGBoost on all rows (CUDA with CPU fallback on OOM)."""
    params = {"objective": "reg:squarederror", "max_depth": 6, "learning_rate": 0.08, "subsample": 0.8,
              "colsample_bytree": 0.8, "min_child_weight": 5, "tree_method": "hist", "max_bin": 256,
              "seed": int(CFG.SEED), "verbosity": 0}
    X = DF[FEATURES].to_numpy(np.float32)
    y = DF[TARGET_COL].to_numpy(np.float32)
    for device in dict.fromkeys([xgb_device_for(0), "cpu"]):
        try:
            dtrain = xgb.QuantileDMatrix(X, label=y, max_bin=256, feature_names=list(FEATURES))
            booster = xgb.train({**params, "device": device}, dtrain, num_boost_round=int(rounds))
            del dtrain
            booster.set_param({"device": "cpu"})
            return booster
        except Exception as exc:
            if device == "cpu" or not is_gpu_oom_error(exc):
                raise
            log(f"GPU OOM training the surrogate on {device}; retrying on CPU", "WARNING")
    raise RuntimeError("unreachable: surrogate training loop exhausted")


def _r2(y_true, y_pred):
    y_true, y_pred = np.asarray(y_true, np.float64), np.asarray(y_pred, np.float64)
    ok = np.isfinite(y_true) & np.isfinite(y_pred)
    sst = np.sum((y_true[ok] - y_true[ok].mean()) ** 2)
    return float(1.0 - np.sum((y_true[ok] - y_pred[ok]) ** 2) / sst) if sst > 0 else None


def _with_injected_nans(X, rng, frac=0.1):
    Xn = X.astype(np.float32).copy()
    Xn[rng.random(Xn.shape) < frac] = np.nan
    return Xn


def _build_web_model(rounds=400):
    rng = np.random.default_rng(CFG.SEED + 404)
    X_all = DF[FEATURES].to_numpy(np.float32)
    y_all = DF[TARGET_COL].to_numpy(np.float64)
    final_margin = DF["lst_pred"].to_numpy(np.float64) - DF["year"].map(_TARGET_UNIT_OFFSET).to_numpy(np.float64)
    test_rows = rng.choice(len(DF), size=max(2000, min(5000, len(DF))), replace=len(DF) < 2000)
    X_test = _with_injected_nans(X_all[test_rows], rng)
    check_X = _with_injected_nans(X_all[rng.choice(len(DF), size=50, replace=len(DF) < 50)], rng, frac=0.15)
    full = _train_surrogate(rounds)
    n_trees = full.num_boosted_rounds()
    while True:
        booster = full[:n_trees] if n_trees < full.num_boosted_rounds() else full
        dm = lambda A: xgb.DMatrix(A, missing=np.nan, feature_names=list(FEATURES))  # noqa: E731
        surrogate_all = booster.predict(dm(X_all), output_margin=True).astype(np.float64)
        fidelity = {
            "r2_vs_final": _r2(final_margin, surrogate_all),
            "rmse_vs_final": float(np.sqrt(np.mean((final_margin - surrogate_all) ** 2))),
            "r2_vs_obs": _r2(y_all, surrogate_all),
            "max_depth": 6, "rounds": int(n_trees),
        }
        check = {"rows": [_json_list(r) for r in check_X],
                 "expected": booster.predict(dm(check_X), output_margin=True).astype(np.float64).tolist()}
        model = json.loads(json.dumps(_clean(_booster_to_compact(booster, fidelity, check)),
                                      separators=(",", ":"), allow_nan=False))
        size = len(json.dumps(model, separators=(",", ":")).encode("utf-8"))
        if size <= _WEB_MAX_BYTES or n_trees <= 20:
            break
        n_trees = max(20, int(n_trees * _WEB_MAX_BYTES / size * 0.95))
        log(f"  model_web.json would be {size / 1e6:.1f} MB; truncating surrogate to {n_trees} trees")
    # Independent verification of the serialised format against XGBoost, missing values included.
    diff = float(np.max(np.abs(_predict_compact(model, X_test)
                               - booster.predict(dm(X_test), output_margin=True).astype(np.float64))))
    if not diff < 1e-3:
        raise RuntimeError(f"compact model evaluator disagrees with XGBoost: max |diff| = {diff:.3e}")
    check_diff = float(np.max(np.abs(_predict_compact(model, np.array(check["rows"], dtype=np.float64))
                                     - np.array(check["expected"]))))
    if not check_diff < 1e-3:
        raise RuntimeError(f"compact model check rows disagree: max |diff| = {check_diff:.3e}")
    log(f"  surrogate: {n_trees} trees, {size / 1e6:.2f} MB; evaluator vs XGBoost max diff {diff:.1e} "
        f"on {len(X_test):,} rows with NaNs; R2 vs final {fidelity['r2_vs_final']:.4f}, "
        f"RMSE vs final {fidelity['rmse_vs_final']:.3f}, R2 vs obs {fidelity['r2_vs_obs']:.4f}")
    del full, booster
    return model


with timer("05_web_model"):
    _MODEL_WEB = _build_web_model()
free_memory()


# %% [markdown]
# ## 5.4 Web bundle (SPEC 4.1 – 4.8)

# %%
# Data caveats (SPEC 2); fallback used only when section 1 provided neither DATA_CAVEATS nor
# DATA_SOURCES["notes"]["caveats"].
_SOURCE_CAVEATS = [
    "Land cover combines different products per epoch (GLC_FCS30D 2010/2015, ESA WorldCover 2020, Dynamic World "
    "2025); part of the apparent land-cover change is cross-product inconsistency.",
    "2010 night-time lights are DMSP-OLS mapped to the VIIRS scale by isotonic regression; DMSP saturates in "
    "urban cores, so 2010 NTL is compressed at the high end.",
    "Terra's orbit drifted after 2022 (earlier overpass time), which lowers 2025 daytime LST relative to earlier "
    "epochs; the anomaly target removes the epoch-wide offset but not spatially varying effects.",
    "GHS-POP 2025 is a projection rescaled to WorldPop 2020 totals, not a census-based estimate.",
]
_MODEL_CAVEATS = [
    "SHAP values explain the model, not causal effects. Zone recommendations are model-based counterfactuals "
    "(the final model re-evaluated on the zone's cells after a feasible land-cover / NDVI / landscape change); the "
    "cooling they report is associated with the change in the model, not a causal effect.",
    "Zones group cells whose predicted anomaly is attributed to the same features in similar amounts (current state "
    "relative to the average cell); zone names follow a fixed labelling rule (see zones.json labelling).",
    "In-browser scenarios use a depth-6 surrogate of the final model (see model_web.json fidelity).",
    "Temporal cross-validation scores the spatial anomaly pattern of the held-out last epoch (its epoch-wide mean "
    "is removed from the target by design), so it measures pattern transfer, not prediction of the climate offset.",
]


def _manifest_sources():
    """DATA_SOURCES as {variable: {year|key: provenance}}; section-1 caveats under 'notes' become notes."""
    sources, notes = {}, []
    for var, vals in DATA_SOURCES.items():
        if var == "notes" and isinstance(vals, dict):
            notes.extend(str(c) for c in vals.get("caveats", []))
        elif isinstance(vals, dict):
            sources[str(var)] = {str(k): str(v) for k, v in vals.items()}
        else:
            sources[str(var)] = {"all": str(vals)}
    return sources, notes


EPOCH_FILE = "epoch_{year}.json.gz"
DEPENDENCE_FILE = "dependence.json.gz"


def _manifest():
    sources, source_notes = _manifest_sources()
    # Section 1 publishes its caveats as DATA_CAVEATS (mode-aware: includes the SYNTHETIC notice); the static list
    # above is only a fallback when section 1 was replaced by an older version without that global.
    section1_caveats = [str(c) for c in (globals().get("DATA_CAVEATS") or [])]
    notes = (source_notes or section1_caveats or list(_SOURCE_CAVEATS)) + list(_MODEL_CAVEATS)
    if DATA_MODE == "synthetic" and not any("SYNTHETIC" in n for n in notes):
        notes.insert(0, "SYNTHETIC DEMO DATA: generated by the notebook's synthetic generator, not satellite "
                        "observations. Use for software demonstration only.")
    if CFG.TARGET_MODE == "anomaly":
        notes.append("Target is the LST anomaly from each epoch's spatial mean; predictions are converted back "
                     "to °C by adding epoch_mean.")
    if BOOTSTRAP_INFO.get("replicate_range"):
        notes.append(f"Only {BOOTSTRAP_INFO['n']} bootstrap replicates: intervals are a replicate range "
                     "(bias-corrected 2.5-97.5 percentiles of the replicates), not calibrated 95% confidence intervals.")
    features = []
    for f in FEATURES:
        meta = FEATURE_META[f]
        features.append({"name": f, "label": meta["label"], "unit": meta["unit"], "group": meta["group"],
                         "description": meta["description"], "source": meta["source"],
                         "actionable": bool(meta["actionable"]), "display": meta["display"],
                         "stats": {k: _sig(FEATURE_STATS[f][k]) for k in
                                   ("min", "max", "p01", "p99", "median", "mean", "std")}})
    center_lon, center_lat = 0.5 * (_BBOX[0] + _BBOX[2]), 0.5 * (_BBOX[1] + _BBOX[3])
    roi_prov = DATA_SOURCES.get("roi")
    roi_sources = sorted({str(v) for v in roi_prov.values()}) if isinstance(roi_prov, dict) else []
    return {
        "schema_version": "1.0",
        "generated_at": _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "data_mode": DATA_MODE,
        "data_mode_reason": str(globals().get("DATA_MODE_REASON") or "") or None,
        "study_area": {"name": "Delhi NCR", "area_km2": round(float(ROI_MASK.sum()) * (GRID.res / 1000.0) ** 2, 1),
                       "crs": CFG.CRS, "grid_res_m": int(CFG.GRID_RES_M),
                       "bbox": [round(v, 5) for v in _BBOX], "center": [round(center_lon, 5), round(center_lat, 5)],
                       "boundary_approximate": bool(globals().get("BOUNDARY_APPROXIMATE", DATA_MODE == "synthetic")),
                       "boundary_source": "; ".join(roi_sources) or None},
        "epochs": list(_EXP_EPOCHS),
        "season": list(CFG.SEASON),
        "target_mode": CFG.TARGET_MODE,
        "epoch_means": {str(y): round(float(EPOCH_MEANS[y]), 2) for y in _EXP_EPOCHS},
        "shap_base": round(float(SHAP_BASE), 4),
        "features": features,
        "zones": [{"id": p["id"], "name": p["name"], "color": p["color"]} for p in ZONE_PROFILES],
        "districts": [{"id": int(d["id"]), "name": d["name"], "state": d["state"]} for d in DISTRICTS],
        "files": {"epochs": {str(y): EPOCH_FILE.format(year=y) for y in _EXP_EPOCHS}, "model": "model_web.json",
                  "shap_global": "shap_global.json", "dependence": DEPENDENCE_FILE, "zones": "zones.json",
                  "metrics": "metrics.json", "districts": "districts.geojson", "interactions": "interactions.json",
                  "coupling": "scenario_coupling.json"},
        "data_sources": sources,
        "synthetic_truth": SYNTHETIC_TRUTH,
        "bootstrap": {k: BOOTSTRAP_INFO[k] for k in ("n", "n_requested", "mode", "block_size_km", "n_blocks",
                                                     "block_size_source", "ci_level", "ci_method",
                                                     "ci_method_description", "ci_label", "replicate_range",
                                                     "full_data") if k in BOOTSTRAP_INFO},
        "notes": notes,
    }


def _epoch_payload(year):
    """Columnar epoch file; verifies the waterfall invariant on the rounded values before returning."""
    idx = np.flatnonzero(DF["year"].to_numpy() == year)
    sub = DF.iloc[idx]
    epoch_mean = round(float(EPOCH_MEANS[year]), 2)
    base_value_c = round(float(SHAP_BASE) + _TARGET_UNIT_OFFSET[year], 2)
    lst_pred = _round_dp(sub["lst_pred"], 2)
    shap = {f: _round_dp(SHAP_VALUES[idx, j], 3) for j, f in enumerate(FEATURES)}
    recon = base_value_c + np.sum(np.vstack(list(shap.values())), axis=0)
    err = float(np.max(np.abs(recon - lst_pred))) if len(idx) else 0.0
    if not err <= 0.05:
        raise RuntimeError(f"epoch {year}: waterfall invariant violated after rounding (max err {err:.3f} °C)")
    return {
        "year": int(year), "n": int(len(idx)), "cell_size_m": int(CFG.GRID_RES_M),
        "epoch_mean": epoch_mean, "base_value_c": base_value_c,
        "cell_id": sub["cell_id"].to_numpy().astype(np.int64),
        "lon": _round_dp(sub["lon"], 5), "lat": _round_dp(sub["lat"], 5),
        "district": sub["district"].to_numpy().astype(np.int64),
        "lst_obs": _round_dp(sub["lst"], 2), "lst_pred": lst_pred,
        "lst_pred_oof": _round_dp(sub["lst_pred_oof"], 2), "resid_oof": _round_dp(sub["resid_oof"], 2),
        "zone": sub["zone"].to_numpy().astype(np.int64),
        "features": {f: _round_sig(sub[f]) for f in FEATURES},
        "shap": shap,
    }, err


def _shap_global_payload():
    r3 = lambda v: _round_dp(v, 3)  # noqa: E731
    imp = SHAP_IMPORTANCE
    return {
        "features": list(FEATURES), "n_bootstrap": int(BOOTSTRAP_INFO["n"]), "bootstrap_mode": BOOTSTRAP_INFO["mode"],
        "global": {k: r3(imp["global"][k]) for k in ("mean_abs", "ci_lo", "ci_hi", "bias") if k in imp["global"]},
        "ci_label": BOOTSTRAP_INFO["ci_label"], "ci_method": BOOTSTRAP_INFO.get("ci_method"),
        "by_epoch": {str(y): {k: r3(v[k]) for k in ("mean_abs", "mean")} for y, v in imp["by_epoch"].items()},
        "by_zone": {str(z): {k: r3(v[k]) for k in ("mean_abs", "mean")} for z, v in imp["by_zone"].items()},
    }


def _threshold_payload(th):
    s4 = lambda v: _sig(v, 4)  # noqa: E731
    ci = lambda c: None if c is None else [s4(c[0]), s4(c[1])]  # noqa: E731
    sup = lambda v: None if v is None else round(float(v), 3)  # noqa: E731
    out = {}
    for k in ("zero_crossing", "breakpoint", "saturation"):
        point = s4(th[k])
        out[k] = point
        # an interval is only meaningful around an existing point estimate (SPEC 4.4)
        out[f"{k}_ci"] = None if point is None else ci(th[f"{k}_ci"])
        out[f"{k}_support"] = None if point is None else sup(th.get(f"{k}_support"))
    return {
        "zero_crossing": out["zero_crossing"], "zero_crossing_ci": out["zero_crossing_ci"],
        "zero_crossing_support": out["zero_crossing_support"],
        "zero_crossing_flag": "multiple" if th.get("zero_crossing_flag") == "multiple" else None,
        "breakpoint": out["breakpoint"], "breakpoint_ci": out["breakpoint_ci"],
        "breakpoint_support": out["breakpoint_support"],
        "slope_before": s4(th["slope_before"]), "slope_after": s4(th["slope_after"]),
        "saturation": out["saturation"], "saturation_ci": out["saturation_ci"],
        "saturation_support": out["saturation_support"],
        "effect_range": None if th["effect_range"] is None else round(float(th["effect_range"]), 3),
        "direction": th["direction"],
    }


def _dependence_payload():
    out = {}
    for f in FEATURES:
        d = DEPENDENCE[f]
        sc = d["scatter"]
        out[f] = {
            "bin_centers": _round_sig(d["bin_centers"]), "mean": _round_dp(d["mean"], 3),
            "ci_lo": _round_dp(d["ci_lo"], 3), "ci_hi": _round_dp(d["ci_hi"], 3),
            "count": np.asarray(d["count"], dtype=np.int64),
            "scatter": {"x": _round_sig(sc["x"]), "shap": _round_dp(sc["shap"], 3), "color": _round_sig(sc["color"]),
                        "color_feature": sc["color_feature"], "zone": np.asarray(sc["zone"], dtype=np.int64),
                        "year": np.asarray(sc["year"], dtype=np.int64)},
            "threshold": _threshold_payload(d["threshold"]),
        }
    return {"features": out}


def _zones_payload():
    zones = []
    for p in ZONE_PROFILES:
        z = dict(p)
        for key in ("area_km2", "lst_obs_mean", "lst_pred_mean"):
            z[key] = _round_nested(p[key], _dp(2))
        z["feature_means"] = {f: _sig(v) for f, v in p["feature_means"].items()}
        z["shap_means"] = _round_nested(p["shap_means"], _dp(3))
        z["top_warming"] = _round_nested(p["top_warming"], _dp(3))
        z["top_cooling"] = _round_nested(p["top_cooling"], _dp(3))
        z["top_interactions"] = _round_nested(p["top_interactions"], _dp(4))
        z["top_districts"] = _round_nested(p["top_districts"], _dp(4))
        z["recommendations"] = [
            {**r, "current": _sig(r["current"]), "target": _sig(r["target"]), "step": _sig(r.get("step")),
             "expected_delta_c": round(float(r["expected_delta_c"]), 2),
             "ci": None if r["ci"] is None else [round(float(r["ci"][0]), 2), round(float(r["ci"][1]), 2)],
             "bias": None if r.get("bias") is None else round(float(r["bias"]), 3)}
            for r in p["recommendations"]]
        zones.append(z)
    labelling = globals().get("ZONE_LABELLING")
    if labelling:
        labelling = {"rule": labelling["rule"],
                     "clusters": [{k: (round(v, 4) if isinstance(v, float) else v) for k, v in c.items()}
                                  for c in labelling["clusters"]]}
    return {"k": len(ZONE_PROFILES), "silhouette": round(float(ZONE_SILHOUETTE), 4),
            "diagnostics": {"k": [int(k) for k in ZONE_DIAGNOSTICS["k"]],
                            "inertia": _round_sig(ZONE_DIAGNOSTICS["inertia"], 6),
                            "silhouette": _round_dp(ZONE_DIAGNOSTICS["silhouette"], 4),
                            "n_init": int(ZONE_DIAGNOSTICS.get("n_init", 10))},
            "labelling": labelling,
            "zones": zones, "transitions": ZONE_TRANSITIONS}


def _records(df, dp=4):
    return _round_nested(_clean(df.to_dict(orient="records")), _dp(dp))


def _metrics_payload():
    scatter = {m: {"year": int(v["year"]), "z": _round_dp(v["z"], 3), "lag": _round_dp(v["lag"], 3),
                   "slope": round(float(v["slope"]), 4)} for m, v in MORAN_SCATTER.items()}
    return {
        "schemes": list(SCHEMES), "models": list(MODEL_NAMES),
        "summary": _records(CV_SUMMARY), "folds": _records(CV_FOLD_METRICS),
        "moran": _records(MORAN_RESULTS), "moran_target": _records(MORAN_TARGET),
        "moran_scatter": scatter,
        "hardware": {"gpus": list(ENV.get("gpu_names") or []), "xgb_device": ENV.get("xgb_device"),
                     "lgbm_device": ENV.get("lgbm_device"),
                     "rapids": bool(ENV.get("rapids_used")),
                     "rapids_used": sorted(ENV.get("rapids_used") or []),
                     "n_gpus": int(ENV.get("n_gpus") or 0), "xgb_version": ENV.get("xgb_version"),
                     "python": ENV.get("python"), "platform": ENV.get("platform")},
        "timings": {str(k): round(float(v), 2) for k, v in TIMINGS.items()},
        "bootstrap": {k: v for k, v in BOOTSTRAP_INFO.items() if k != "failures"},
    }


def _interactions_payload():
    r4 = lambda m: _round_dp(m, 4).tolist()  # noqa: E731
    return {"features": list(FEATURES), "global": r4(INTERACTION_GLOBAL),
            "by_zone": {str(z): r4(m) for z, m in INTERACTION_BY_ZONE.items()}}


def _coupling_payload():
    c = SCENARIO_COUPLING
    return {"description": c["description"], "fraction_features": list(c["fraction_features"]),
            "coupling": _round_nested(c["coupling"], lambda v: _sig(v, 4)),
            "r2": _round_nested(c["r2"], _dp(4)), "intercept": _round_nested(c["intercept"], lambda v: _sig(v, 4)),
            "n": c["n"]}


def _clear_web_dir(keep):
    """Remove bundle files from a previous export that this export does not write (e.g. plain epoch_*.json next
    to the new .json.gz), so the web folder never carries stale data."""
    for p in _WEB_DIR.iterdir():
        if p.is_file() and p.name not in keep and p.name.endswith((".json", ".json.gz", ".geojson", ".tmp")):
            p.unlink()
            log(f"  removed stale bundle file {p.name}")


def _write_web_bundle():
    sizes = {}
    EXPORT_MANIFEST = _manifest()
    files = EXPORT_MANIFEST["files"]
    _clear_web_dir({"manifest.json", *files["epochs"].values(), *(v for k, v in files.items() if k != "epochs")})
    sizes["manifest.json"] = _write_json(EXPORT_MANIFEST, _WEB_DIR / "manifest.json")
    for year in _EXP_EPOCHS:
        payload, err = _epoch_payload(year)
        name = files["epochs"][str(year)]
        sizes[name] = _write_json(payload, _WEB_DIR / name)
        log(f"  {name}: n={payload['n']:,}, waterfall max err {err:.3f} °C")
        del payload
    sizes["model_web.json"] = _write_json(_MODEL_WEB, _WEB_DIR / "model_web.json")
    sizes["shap_global.json"] = _write_json(_shap_global_payload(), _WEB_DIR / "shap_global.json")
    sizes[files["dependence"]] = _write_json(_dependence_payload(), _WEB_DIR / files["dependence"])
    sizes["zones.json"] = _write_json(_zones_payload(), _WEB_DIR / "zones.json")
    sizes["interactions.json"] = _write_json(_interactions_payload(), _WEB_DIR / "interactions.json")
    sizes["scenario_coupling.json"] = _write_json(_coupling_payload(), _WEB_DIR / "scenario_coupling.json")
    sizes["districts.geojson"] = _write_json(_DISTRICTS_FC, _WEB_DIR / "districts.geojson")
    sizes["metrics.json"] = _write_json(_metrics_payload(), _WEB_DIR / "metrics.json")  # last: includes timings
    return EXPORT_MANIFEST, sizes


with timer("05_web_bundle"):
    EXPORT_MANIFEST, _WEB_SIZES = _write_web_bundle()
for _name, _size in _WEB_SIZES.items():
    log(f"  web/{_name}: {_size / 1e6:.2f} MB")
free_memory()


# %% [markdown]
# ## 5.5 Contract validation of the written bundle
# Every file is re-read from disk (rejecting NaN/Infinity tokens) and checked against SPEC §4: keys, array
# lengths, feature order, zone ids, the SHAP waterfall invariant for every cell, and the compact model's check rows.
# A stricter standalone checker (numpy only; e.g. for a bundle downloaded from Kaggle) lives in the repository:
# `python notebook/validate_bundle.py outputs/web` (also checks canonical zones/districts, rounding, tree depth,
# float32 thresholds, recommendation priorities, transition totals and the bundle size).

# %%
def _reject_constant(token):
    raise ValueError(f"non-JSON constant {token!r}")


def _load_strict(path):
    """Parse UTF-8 JSON (gzip detected by magic bytes), rejecting NaN / Infinity tokens."""
    return json.loads(_read_bytes_maybe_gzip(path).decode("utf-8"), parse_constant=_reject_constant)


def _require(cond, errors, msg):
    if not cond:
        errors.append(msg)
    return bool(cond)


def _missing_keys(obj, keys):
    return [k for k in keys if not isinstance(obj, dict) or k not in obj]


_ZONE_IDS = {0, 1, 2, 3}
_THRESHOLD_KEYS = ["zero_crossing", "zero_crossing_ci", "breakpoint", "breakpoint_ci", "slope_before",
                   "slope_after", "saturation", "saturation_ci", "effect_range", "direction"]
_REC_LEVER_NAMES = {"frac_impervious", "frac_forest", "frac_water", "frac_cropland", "frac_barren", "ndvi",
                    "lm_pd", "lm_ed", "lm_contag"}


def _check_manifest(man, errors):
    keys = ["schema_version", "generated_at", "data_mode", "study_area", "epochs", "season", "target_mode",
            "epoch_means", "features", "zones", "districts", "files", "data_sources", "synthetic_truth", "notes"]
    miss = _missing_keys(man, keys)
    if not _require(not miss, errors, f"manifest: missing keys {miss}"):
        return None
    _require(man["data_mode"] in ("gee", "synthetic"), errors, "manifest: bad data_mode")
    _require(not _missing_keys(man["study_area"], ["name", "area_km2", "crs", "grid_res_m", "bbox", "center"]),
             errors, "manifest.study_area: missing keys")
    _require(len(man["study_area"].get("bbox", [])) == 4, errors, "manifest.study_area.bbox must have 4 values")
    names = [f.get("name") for f in man["features"]]
    for f in man["features"]:
        _require(not _missing_keys(f, ["name", "label", "unit", "group", "description", "source", "actionable",
                                       "display", "stats"]), errors, f"manifest feature {f.get('name')}: keys")
        _require(f.get("display") in ("index", "percent", "number"), errors, f"feature {f.get('name')}: display")
    _require([z["id"] for z in man["zones"]] == [0, 1, 2, 3], errors, "manifest.zones must be ids 0..3")
    _require(set(man["files"]["epochs"]) == {str(y) for y in man["epochs"]}, errors, "manifest.files.epochs")
    _require(set(man["epoch_means"]) == {str(y) for y in man["epochs"]}, errors, "manifest.epoch_means")
    return names


def _check_epoch(ep, year, names, target_mode, epoch_mean, errors):
    tag = f"epoch_{year}"
    keys = ["year", "n", "cell_size_m", "epoch_mean", "base_value_c", "cell_id", "lon", "lat", "district",
            "lst_obs", "lst_pred", "lst_pred_oof", "resid_oof", "zone", "features", "shap"]
    miss = _missing_keys(ep, keys)
    if not _require(not miss, errors, f"{tag}: missing keys {miss}"):
        return
    n = ep["n"]
    _require(ep["year"] == year, errors, f"{tag}: year mismatch")
    for k in ("cell_id", "lon", "lat", "district", "lst_obs", "lst_pred", "lst_pred_oof", "resid_oof", "zone"):
        _require(len(ep[k]) == n, errors, f"{tag}.{k}: length {len(ep[k])} != n {n}")
    for grp in ("features", "shap"):
        _require(list(ep[grp]) == names, errors, f"{tag}.{grp}: keys differ from manifest feature order")
        for f, arr in ep[grp].items():
            _require(len(arr) == n, errors, f"{tag}.{grp}.{f}: length != n")
    _require(set(ep["zone"]) <= _ZONE_IDS, errors, f"{tag}: zone ids outside 0..3")
    _require(None not in ep["lst_pred"], errors, f"{tag}: lst_pred contains null")
    offset = epoch_mean if target_mode == "anomaly" else 0.0
    _require(abs(ep["epoch_mean"] - epoch_mean) < 0.011, errors, f"{tag}: epoch_mean differs from manifest")
    if n and list(ep["shap"]) == names and None not in ep["lst_pred"]:
        shap = np.array([ep["shap"][f] for f in names], dtype=np.float64)
        _require(np.isfinite(shap).all(), errors, f"{tag}: shap contains null")
        err = np.max(np.abs(ep["base_value_c"] + np.nansum(shap, axis=0) - np.array(ep["lst_pred"])))
        _require(err <= 0.05, errors, f"{tag}: waterfall invariant violated (max err {err:.3f})")
        _require(abs(ep["base_value_c"] - (float(SHAP_BASE) + offset)) < 0.011, errors,
                 f"{tag}: base_value_c != SHAP_BASE + offset")


def _check_model(model, names, errors):
    keys = ["format", "objective", "target_mode", "features", "base_score", "n_trees", "trees", "fidelity", "check"]
    miss = _missing_keys(model, keys)
    if not _require(not miss, errors, f"model_web: missing keys {miss}"):
        return
    _require(model["format"] == "lst-xgb-compact-v1", errors, "model_web: bad format")
    _require(model["features"] == names, errors, "model_web: feature order differs from manifest")
    _require(model["n_trees"] == len(model["trees"]), errors, "model_web: n_trees != len(trees)")
    _require(model["fidelity"].get("max_depth", 99) <= 6 and model["fidelity"].get("rounds", 999) <= 400, errors,
             "model_web: surrogate exceeds depth 6 / 400 rounds")
    for i, t in enumerate(model["trees"]):
        lens = {k: len(t.get(k, [])) for k in ("f", "t", "l", "r", "d", "v")}
        if not _require(len(set(lens.values())) == 1, errors, f"model_web tree {i}: array lengths {lens}"):
            return
        m = lens["f"]
        kids = [c for c in t["l"] + t["r"] if c != -1]
        _require(all(0 < c < m for c in kids), errors, f"model_web tree {i}: child index out of range")
        _require(all(0 <= f < len(names) for f, lc in zip(t["f"], t["l"]) if lc != -1), errors,
                 f"model_web tree {i}: split feature out of range")
    rows = model["check"]["rows"]
    _require(len(rows) == 50 and all(len(r) == len(names) for r in rows), errors,
             "model_web.check: need 50 rows of K values")
    _require(len(model["check"]["expected"]) == len(rows), errors, "model_web.check: expected length")
    if rows and not errors:
        pred = _predict_compact(model, np.array([[np.nan if v is None else v for v in r] for r in rows]))
        diff = float(np.max(np.abs(pred - np.array(model["check"]["expected"]))))
        _require(diff < 1e-3, errors, f"model_web.check: evaluator differs from expected by {diff:.2e}")


def _check_shap_global(sg, names, epochs, errors):
    miss = _missing_keys(sg, ["features", "n_bootstrap", "bootstrap_mode", "global", "by_epoch", "by_zone"])
    if not _require(not miss, errors, f"shap_global: missing keys {miss}"):
        return
    k = len(names)
    _require(sg["features"] == names, errors, "shap_global: feature order")
    _require(all(len(sg["global"].get(key, [])) == k for key in ("mean_abs", "ci_lo", "ci_hi")), errors,
             "shap_global.global: arrays must have K values")
    _require(set(sg["by_epoch"]) == {str(y) for y in epochs}, errors, "shap_global.by_epoch keys")
    _require(set(sg["by_zone"]) <= {str(z) for z in _ZONE_IDS}, errors, "shap_global.by_zone keys")
    for grp in ("by_epoch", "by_zone"):
        for key, v in sg[grp].items():
            _require(len(v.get("mean_abs", [])) == k and len(v.get("mean", [])) == k, errors,
                     f"shap_global.{grp}.{key}: arrays must have K values")


def _check_dependence(dep, names, errors):
    feats = dep.get("features", {}) if isinstance(dep, dict) else {}
    _require(list(feats) == names, errors, "dependence: features differ from manifest order")
    for f, d in feats.items():
        miss = _missing_keys(d, ["bin_centers", "mean", "ci_lo", "ci_hi", "count", "scatter", "threshold"])
        if not _require(not miss, errors, f"dependence.{f}: missing {miss}"):
            continue
        nb = len(d["bin_centers"])
        _require(all(len(d[k]) == nb for k in ("mean", "ci_lo", "ci_hi", "count")), errors,
                 f"dependence.{f}: bin array lengths differ")
        sc = d["scatter"]
        ns = len(sc.get("x", []))
        _require(ns <= 1500 and all(len(sc.get(k, [])) == ns for k in ("shap", "color", "zone", "year")), errors,
                 f"dependence.{f}.scatter: lengths")
        _require(sc.get("color_feature") in names, errors, f"dependence.{f}.scatter.color_feature")
        _require(not _missing_keys(d["threshold"], _THRESHOLD_KEYS), errors, f"dependence.{f}.threshold keys")
        _require(d["threshold"].get("direction") in ("cooling", "warming", "mixed"), errors,
                 f"dependence.{f}.threshold.direction")
        for k in ("zero_crossing", "breakpoint", "saturation"):
            _require(d["threshold"].get(k) is not None or d["threshold"].get(f"{k}_ci") is None, errors,
                     f"dependence.{f}.threshold.{k}_ci given without a point estimate")
        _require(d["threshold"].get("zero_crossing_flag") in (None, "multiple"), errors,
                 f"dependence.{f}.threshold.zero_crossing_flag must be 'multiple' or null")


def _check_zones(zj, names, epochs, errors):
    miss = _missing_keys(zj, ["k", "silhouette", "diagnostics", "zones", "transitions"])
    if not _require(not miss, errors, f"zones: missing keys {miss}"):
        return
    _require(zj["k"] == 4 and [z.get("id") for z in zj["zones"]] == [0, 1, 2, 3], errors, "zones: need ids 0..3")
    dg = zj["diagnostics"]
    _require(len(dg["k"]) == len(dg["inertia"]) == len(dg["silhouette"]), errors, "zones.diagnostics lengths")
    zkeys = ["id", "name", "color", "description", "n_cells", "area_km2", "lst_obs_mean", "lst_pred_mean",
             "feature_means", "shap_means", "top_warming", "top_cooling", "top_interactions", "top_districts",
             "recommendations"]
    for z in zj["zones"]:
        zmiss = _missing_keys(z, zkeys)
        if not _require(not zmiss, errors, f"zones[{z.get('id')}]: missing {zmiss}"):
            continue
        _require(set(z["n_cells"]) == {str(y) for y in epochs}, errors, f"zones[{z['id']}].n_cells epochs")
        _require(list(z["feature_means"]) == names and list(z["shap_means"]) == names, errors,
                 f"zones[{z['id']}]: feature order")
        for r in z["recommendations"]:
            _require(r.get("priority") in ("high", "medium", "low") and r.get("expected_delta_c", 0) < 0, errors,
                     f"zones[{z['id']}]: invalid recommendation {r.get('feature')}")
            _require(r.get("feature") in _REC_LEVER_NAMES, errors,
                     f"zones[{z['id']}]: {r.get('feature')} is not an intervention lever (SPEC 4.6)")
            _require("associated with" in str(r.get("rationale", "")), errors,
                     f"zones[{z['id']}] recommendation {r.get('feature')}: rationale must say 'associated with'")
            if r.get("ci") is not None:
                _require(r["ci"][0] - 0.011 <= r["expected_delta_c"] <= r["ci"][1] + 0.011, errors,
                         f"zones[{z['id']}] recommendation {r.get('feature')}: estimate outside its interval")
    for key, mat in zj["transitions"].items():
        _require(len(mat) == 4 and all(len(row) == 4 for row in mat), errors, f"zones.transitions[{key}]: 4x4")


def _check_small_files(web_dir, names, errors):
    metrics = _load_strict(web_dir / "metrics.json")
    miss = _missing_keys(metrics, ["schemes", "models", "summary", "folds", "moran", "moran_target",
                                   "moran_scatter", "hardware", "timings"])
    _require(not miss, errors, f"metrics: missing keys {miss}")
    for rec in metrics.get("summary", []):
        _require(not _missing_keys(rec, ["scheme", "model", "r2_mean", "r2_std", "rmse_mean", "rmse_std",
                                         "mae_mean", "mae_std", "n_folds"]), errors, "metrics.summary record keys")
    inter = _load_strict(web_dir / "interactions.json")
    k = len(names)
    _require(inter.get("features") == names, errors, "interactions: feature order")
    mats = [inter.get("global", [])] + list(inter.get("by_zone", {}).values())
    _require(all(len(m) == k and all(len(r) == k for r in m) for m in mats), errors, "interactions: K x K")
    cp = _load_strict(web_dir / "scenario_coupling.json")
    fr = ["frac_impervious", "frac_forest", "frac_water", "frac_cropland", "frac_barren"]
    _require(cp.get("fraction_features") == fr, errors, "scenario_coupling: fraction_features")
    _require(all(set(cp.get("coupling", {}).get(f, {})) >= {"ndvi", "ndwi", "ndbi"} for f in fr), errors,
             "scenario_coupling: coupling must give ndvi/ndwi/ndbi slopes per fraction")
    geo = _load_strict(web_dir / "districts.geojson")
    _require(geo.get("type") == "FeatureCollection", errors, "districts.geojson: not a FeatureCollection")
    _require(all(not _missing_keys(ft.get("properties", {}), ["id", "name", "state"])
                 for ft in geo.get("features", [])), errors, "districts.geojson: properties id/name/state")


def validate_web_bundle(web_dir):
    """Re-read the web bundle and check it against the SPEC §4 contract. Raises ValueError listing all problems."""
    web_dir = Path(web_dir)
    errors = []
    man = _load_strict(web_dir / "manifest.json")
    names = _check_manifest(man, errors)
    if names is None:
        raise ValueError("Web bundle invalid:\n  - " + "\n  - ".join(errors))
    for fname in list(man["files"]["epochs"].values()) + [v for k, v in man["files"].items() if k != "epochs"]:
        _require((web_dir / fname).is_file(), errors, f"missing file {fname}")
    if errors:
        raise ValueError("Web bundle invalid:\n  - " + "\n  - ".join(errors))
    for y in man["epochs"]:
        ep = _load_strict(web_dir / man["files"]["epochs"][str(y)])
        _check_epoch(ep, int(y), names, man["target_mode"], man["epoch_means"][str(y)], errors)
        del ep
    _check_model(_load_strict(web_dir / man["files"]["model"]), names, errors)
    _check_shap_global(_load_strict(web_dir / man["files"]["shap_global"]), names, man["epochs"], errors)
    _check_dependence(_load_strict(web_dir / man["files"]["dependence"]), names, errors)
    _check_zones(_load_strict(web_dir / man["files"]["zones"]), names, man["epochs"], errors)
    _check_small_files(web_dir, names, errors)
    if errors:
        raise ValueError(f"Web bundle invalid ({len(errors)} problems):\n  - " + "\n  - ".join(errors))
    log(f"Web bundle valid: {len(man['epochs'])} epochs, {len(names)} features, "
        f"{sum(p.stat().st_size for p in web_dir.iterdir() if p.is_file()) / 1e6:.1f} MB on disk")
    return True


with timer("05_validate"):
    validate_web_bundle(_WEB_DIR)


# %% [markdown]
# ## 5.6 Bundle zip, output inventory and run summary

# %%
def _zip_web(web_dir, zip_path):
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for p in sorted(Path(web_dir).iterdir()):
            if p.is_file():
                # already-gzipped files are stored as they are (deflating them again gains nothing)
                zf.write(p, arcname=p.name,
                         compress_type=zipfile.ZIP_STORED if p.name.endswith(".gz") else zipfile.ZIP_DEFLATED)
    return zip_path


def _print_tree(root, max_files=25):
    """Print the outputs tree with sizes; directories with many files (e.g. caches) are summarised."""
    root = Path(root)
    print(f"{root}/")
    for d in sorted([root] + [p for p in root.rglob("*") if p.is_dir()]):
        files = sorted(p for p in d.iterdir() if p.is_file())
        depth = len(d.relative_to(root).parts)
        if d != root:
            print(f"{'  ' * depth}{d.name}/")
        if len(files) > max_files:
            total = sum(p.stat().st_size for p in files)
            print(f"{'  ' * (depth + 1)}[{len(files)} files, {total / 1e6:.1f} MB]")
            continue
        for p in files:
            print(f"{'  ' * (depth + 1)}{p.name:<40s} {p.stat().st_size / 1e6:9.2f} MB")


_ZIP_PATH = _zip_web(_WEB_DIR, _OUT / "web_bundle.zip")
log(f"Web bundle zipped: {_ZIP_PATH} ({_ZIP_PATH.stat().st_size / 1e6:.1f} MB)")
_print_tree(_OUT)

_xgb_spatial = CV_SUMMARY[(CV_SUMMARY["scheme"] == "spatial") & (CV_SUMMARY["model"] == "xgboost")]
print("\n" + "=" * 78)
print(f"RUN SUMMARY  (data mode: {DATA_MODE.upper()}{' - SYNTHETIC DEMO DATA' if DATA_MODE == 'synthetic' else ''})")
print("=" * 78)
print(f"Cells x epochs: {len(DF):,}  |  epochs {_EXP_EPOCHS}  |  features {len(FEATURES)}  |  target {CFG.TARGET_MODE}")
if len(_xgb_spatial):
    _row = _xgb_spatial.iloc[0]
    print(f"XGBoost spatial-CV: R2 {_row['r2_mean']:.3f} ± {_row['r2_std']:.3f}, RMSE {_row['rmse_mean']:.3f} °C")
print(f"Final model: {FINAL_ROUNDS} rounds; SHAP base {SHAP_BASE:.3f}; bootstrap {BOOTSTRAP_INFO['n']} replicates")
print(f"Web surrogate: {_MODEL_WEB['n_trees']} trees, R2 vs final {_MODEL_WEB['fidelity']['r2_vs_final']:.4f}")
print(f"Zones (silhouette {ZONE_SILHOUETTE:.3f}), {_EXP_LAST}:")
for _zp in ZONE_PROFILES:
    print(f"  {_zp['id']} {_zp['name']:<22s} {_zp['area_km2'][str(_EXP_LAST)]:>9,.0f} km²  "
          f"LST {(_zp['lst_obs_mean'][str(_EXP_LAST)] or float('nan')):.2f} °C  "
          f"{len(_zp['recommendations'])} recommendation(s)")
print(f"\nNEXT STEP: copy {_WEB_DIR}/* to dashboard/public/data/  (or unzip {_ZIP_PATH.name} there), "
      "then run `npm run dev` in dashboard/.")
free_memory()
