# %% [markdown]
# # 12. Export: the v2 web bundle, Parquet / GeoJSON / NPZ / native models, read-back validation and the zip
#
# This section turns the in-memory products of sections 06–11 into files. Nothing is re-estimated here: every number
# written is a global of an earlier section (SPEC §3), only **re-shaped, quantised and rounded** to the data contract of
# SPEC §5. The section therefore has two jobs: (1) write exactly the files, names, keys, dtypes and quantisation of
# §5, and (2) prove by reading the files back from disk that they decode to what the pipeline computed.
#
# ```
# outputs/
# ├── web/                      ← copy the CONTENTS to dashboard/public/data/ (real run) or /demo/ (synthetic)
# │   ├── manifest.json                     schema 2.0 (§5.3): modes, groups, features, zones, timeline, files
# │   ├── cells.lstb.gz                     canonical cell order: cell_id, row, col, lon, lat, district
# │   ├── timeline_series.json.gz           §5.4: per scope × mode frame stats, annual series, SSP fans, trends
# │   ├── cube_obs_<mode>.lstb.gz           observed/reconstructed/modelled fields [F_obs, n] + AOA + p05/p95 offsets
# │   ├── cube_<ssp>_<mode>.lstb.gz         projected p50 + quantile offsets + flags [F_proj, n]
# │   ├── cube_zones_<mode>.lstb.gz         zone ids, observed and per scenario
# │   ├── xai_<year>_features.lstb.gz       the 33 base features of a frame
# │   ├── xai_<year>_<mode>.lstb.gz         18 group SHAP + pred / oof / obs / resid (absolute °C)
# │   ├── raster_index.json, raster/*.png   written by section 10 (EPSG:4326 PNGs), referenced here
# │   ├── zones.json, shap_global.json, dependence.json.gz, interactions.json, metrics.json, provenance.json
# │   ├── model_web_day.json, model_web_night.json, scenario_coupling.json, districts.geojson
# ├── parquet/   predictions_<mode>, projections_<mode>, levels, series_frames, annual_series, importance (+ 06/07/11)
# ├── geo/       ncr_districts.geojson, zones_<mode>.geojson (cell squares with per-frame zone / LST properties)
# ├── npz/       fine_fields_<mode>.npz (250 m fields + flags, UTM grid metadata)
# ├── models/    xgb_final_<mode>.json (native XGBoost, written by section 07; re-saved if missing)
# └── web_bundle.zip
# ```
#
# ## 12.1 Binary container and quantisation (SPEC §5.1)
# Per-cell arrays go into **LSTB** containers (`lstb_write`, section 00): a small JSON header followed by 8-byte aligned
# little-endian typed columns, gzip level 9 with a fixed header (re-runs are byte-identical). A value is stored as
# `raw = round((v − offset) / scale)` and decoded as `raw · scale + offset`, so the rounding error is ≤ scale / 2:
#
# | column | dtype | scale | worst-case error | why this resolution is enough |
# |---|---|---|---|---|
# | LST (°C, absolute) | int16 | 0.01 °C | 0.005 °C | 10× finer than the Landsat ST accuracy (~1 K) and the 2-dp JSON rounding |
# | uncertainty offsets | uint8 | 0.05 °C | 0.025 °C | intervals are ≥ 0.3 °C wide; uint8 keeps the cubes small (max 12.75 °C) |
# | group SHAP | int16 | 0.001 °C | 0.0005 °C | 18 groups sum to ≤ 0.009 °C error, inside the 0.05 °C waterfall tolerance |
# | base features | int16 | per column (p0–p100 + 2 % headroom over 65 534 steps) | span / 131 068 | far below the measurement noise of every predictor |
#
# NaN is stored as the nodata code (−32768 for int16, 255 for zone ids); offsets of cells without an interval are 0.
# Uncertainty offsets are taken relative to the **quantised** central value, so decoded quantiles stay ordered.
#
# ## 12.2 Fixed colour domains (SPEC §5.3)
# The dashboard colours every frame of a mode with one fixed domain, so a colour means the same temperature in 1990
# and in 2050. Section 10 already fixed it for the PNG rasters (p0.5–p99.5 of all observed fine fields, padded by
# 3 °C so that projections never clip; section 11 verified that). The manifest uses **that** domain for
# `timeline.domains.<mode>.abs` (the PNGs are encoded with it, SPEC §4.8) and widens it outward only if the 1 km
# p0.5–p99.5 of the observed fields and projected medians (the SPEC §5.3 definition) were to fall outside — a widening
# is logged. Anomaly, SUHI, diurnal-range (DTR) and spread domains are computed here from the same arrays.
#
# ## 12.3 What "validated" means
# After writing, every file is **re-read from disk** (gzip detected by magic bytes, JSON parsed strictly with NaN /
# Infinity rejected) and checked: LSTB headers (dtypes, scales, nodata codes, shapes = frames × n, 8-byte alignment),
# the same `n` everywhere, frame and tier lists equal to the manifest, the SHAP waterfall invariant
# `|pred − (base_value_c + Σ group SHAP)| ≤ 0.05 °C` on **every** non-NaN row of every XAI file, decoded values equal to
# the in-memory arrays within the quantisation step, zone ids in {0..3, 255}, and every referenced file present.
# **Cross-file alignment** catches row- or frame-order bugs that every single file would hide: the XAI `obs` of an
# observed / observed-sparse / reconstructed frame equals the cube field (+ the frame's composition correction of
# section 09) within 0.011 °C with the same NaN pattern, `corr(pred, obs) ≥ 0.5` (≥ 0.25 for a reconstructed frame,
# which the model never trained on; a value under 0.5 there is logged), and the nearest zone centroid of
# every complete SHAP row equals the zone cube on ≥ 99 % of rows. Zone entries carry `display_name` / `label_caveat`
# (SPEC §1.5) and series frame rows an optional `coverage` in [0, 1]. Finally the cache is packed (`pack_cache`,
# Kaggle's output-file cap) and a stale `RUN_STOPPED.json` of an earlier clean stop is removed at the start.
# When the repository's standalone checker (`notebook/validate_bundle.py`, numpy only) is reachable it is run as
# well and must report VALID; on Kaggle, attach it as a dataset or run it locally on the downloaded bundle.

# %%
import datetime as _s12_dt
import gzip as _s12_gzip
import json as _s12_json
import math as _s12_math
import os as _s12_os
import subprocess as _s12_subprocess
import sys as _s12_sys
import time as _s12_time
import zipfile as _s12_zipfile
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

# 12-v2.1: zone display_name / label_caveat, frame coverage, decomposition baseline_c, night-calibration diag,
# cross-file read-back checks, cache packing at the end (D3, D11, D14, D16, D19).
_S12_VERSION = "12-v2.1"
_S12_T0 = _s12_time.perf_counter()
_S12_OUT = Path(CFG.OUTPUT_DIR)
# A completed export supersedes an earlier clean stop in the same output directory (D3).
_s12_stopped = _S12_OUT / "RUN_STOPPED.json"
if _s12_stopped.is_file():
    try:
        _s12_stopped.unlink()
        log("12: removed a stale RUN_STOPPED.json (this export completes the run)")
    except OSError as _s12_exc:
        log(f"12: could not remove stale {_s12_stopped}: {_s12_exc}", "WARNING")
_S12_WEB = Path(CFG.WEB_DIR)
_S12_PARQUET = Path(CFG.PARQUET_DIR)
_S12_GEO = Path(CFG.GEO_DIR)
_S12_MODEL_DIR = Path(CFG.MODEL_DIR)
_S12_NPZ = Path(CFG.NPZ_DIR)
_S12_FIG_DIR = Path(CFG.FIG_DIR)
for _s12_d in (_S12_WEB, _S12_PARQUET, _S12_GEO, _S12_MODEL_DIR, _S12_NPZ, _S12_FIG_DIR):
    _s12_d.mkdir(parents=True, exist_ok=True)

_S12_NC = int(N_CELLS)
_S12_GROUPS = list(SHAP_GROUPS)
_S12_MODES = [m for m in CFG.MODES if m in FRAME_FIELDS]
if not _S12_MODES:
    raise RuntimeError("12: no mode has frame fields (section 09 did not run?) - nothing to export")
_S12_OBS = [int(y) for y in CFG.FRAMES_OBS]
_S12_NOW = int(CFG.NOW) if int(CFG.NOW) in _S12_OBS else _S12_OBS[-1]
# Projections exist only when section 11 ran (pilot profile: none). A scenario is exported only when every mode has it.
_S12_PROJ = [int(y) for y in CFG.FRAMES_PROJ] if globals().get("PROJ_QUANTILES") else []
_S12_SCEN = [s for s in CFG.SCENARIOS if _S12_PROJ and all(s in PROJ_QUANTILES.get(m, {}) for m in _S12_MODES)]
if _S12_PROJ and not _S12_SCEN:
    log("12: projection frames configured but no scenario has quantiles for every mode; exporting observed frames "
        "only", "WARNING")
    _S12_PROJ = []
_S12_ZONE_META = [
    {"id": 0, "name": "Ecological Cool Base", "color": "#34d399"},
    {"id": 1, "name": "Riparian Buffer", "color": "#22d3ee"},
    {"id": 2, "name": "Transition", "color": "#a78bfa"},
    {"id": 3, "name": "Heat Extreme Core", "color": "#fb7185"},
]
_S12_ZONE_NODATA = 255
_S12_SCEN_LABEL = {"ssp126": "SSP1-2.6", "ssp245": "SSP2-4.5", "ssp585": "SSP5-8.5"}
_S12_MODE_INFO = {
    "day": {"label": "Day · ~10:30 IST", "target": "Landsat C2 L2 ST (harmonised, 10:45 IST reference)",
            "ramp": "solar", "reference_overpass_ist": "10:45", "native_m": 30},
    "night": {"label": "Night · ~01:30 IST",
              "target": "MODIS Aqua night (Aqua-equivalent; VIIRS/Terra calibrated)", "ramp": "nocturne",
              "reference_overpass_ist": "01:30", "native_m": 1000},
}
_S12_TIERS = ["observed", "observed-sparse", "reconstructed", "modelled", "projected"]
_S12_PROJ_NOTE = "scenario projection, not a forecast"
# Quantisation constants of SPEC §5.2 (shared by the writer and the read-back check).
_S12_LST_SCALE = 0.01
_S12_OFF_SCALE = 0.05
_S12_SHAP_SCALE = 0.001
_S12_I16_NODATA = -32768
_S12_WATERFALL_TOL_C = 0.05
# Floor of the cross-file check corr(pred, obs): rows in the wrong order give ~0. Frames the model trained on agree at
# 0.95-0.99 on real data. A reconstructed frame (2000 night: sparse Terra nights, never trained on) agrees at only
# ~0.5 (0.497-0.524 in real pilot runs), so it gets a lower floor plus a logged note instead of a failed run.
_S12_CORR_MIN = {"reconstructed": 0.25}
_S12_CELL_KM2 = float(GRID.cell_area_km2)
_S12_SIZES = {}            # published path -> bytes on disk (filled by the writers)

log(f"12: exporting modes {_S12_MODES}, {len(_S12_OBS)} observed frames, "
    f"{len(_S12_PROJ)} projected frames x {_S12_SCEN or 'no scenarios'}, {_S12_NC:,} cells -> {_S12_WEB}")


# %% [markdown]
# ## 12.4 Rounding, JSON and LSTB writers

# %%
def _s12_num(v, dp=None):
    """Finite float (optionally rounded) or None; ints stay ints, bools stay bools."""
    if v is None or isinstance(v, (bool, np.bool_)):
        return None if v is None else bool(v)
    if isinstance(v, (int, np.integer)):
        return int(v)
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not _s12_math.isfinite(f):
        return None
    return round(f, dp) if dp is not None else f


def _s12_sig(v, sig=4):
    """Round to ``sig`` significant digits so that the JSON text is the shortest decimal (None for non-finite)."""
    f = _s12_num(v)
    if f is None or isinstance(f, bool):
        return f
    if f == 0:
        return 0.0
    k = sig - 1 - int(_s12_math.floor(_s12_math.log10(abs(f))))
    return round(f, k) if k >= 0 else float(round(f / 10.0 ** (-k)) * 10.0 ** (-k))


def _s12_sig_arr(arr, sig=4):
    """Vectorised significant-digit rounding (NaN stays NaN) - used for feature values and bin centres."""
    a = np.asarray(arr, dtype=np.float64)
    out = np.full(a.shape, np.nan)
    fin = np.isfinite(a)
    zero = fin & (a == 0)
    out[zero] = 0.0
    ok = fin & ~zero
    if ok.any():
        k = (sig - 1 - np.floor(np.log10(np.abs(a[ok])))).astype(np.int64)
        v = a[ok]
        res = np.empty_like(v)
        pos = k >= 0
        scale_pos = 10.0 ** k[pos]
        res[pos] = np.round(v[pos] * scale_pos) / scale_pos
        scale_neg = 10.0 ** (-k[~pos])
        res[~pos] = np.round(v[~pos] / scale_neg) * scale_neg
        out[ok] = res
    return out


def _s12_sig_increasing(arr, sig=4, max_sig=12):
    """Significant-digit rounding that keeps a strictly increasing sequence strictly increasing.

    Dependence bin centres of a feature with a small range relative to its magnitude (smooth ERA5 fields, e.g. wind
    2.3521 / 2.3524 m/s) collapse to duplicates at 4 significant digits, which breaks the bundle invariant
    "bin_centers increasing" (validate_bundle) and the dashboard's interpolation. Digits are added until the finite
    values stay strictly increasing (or ``max_sig`` is reached)."""
    a = np.asarray(arr, dtype=np.float64)
    fin = np.isfinite(a)
    increasing = bool(np.all(np.diff(a[fin]) > 0))
    for digits in range(int(sig), int(max_sig) + 1):
        out = _s12_sig_arr(a, digits)
        if not increasing or np.all(np.diff(out[fin]) > 0):
            return out
    return out


def _s12_tree(obj, dp=4):
    """Recursively convert numpy / pandas containers to JSON-able Python and round every float to ``dp`` decimals.

    dict keys become strings; DataFrames become record lists; NaN / Inf become None (strict JSON, SPEC §5)."""
    if isinstance(obj, dict):
        return {str(k): _s12_tree(v, dp) for k, v in obj.items()}
    if isinstance(obj, pd.DataFrame):
        return [_s12_tree(r, dp) for r in obj.to_dict(orient="records")]
    if isinstance(obj, (pd.Series, pd.Index)):
        return [_s12_tree(v, dp) for v in obj.tolist()]
    if isinstance(obj, np.ndarray):
        if obj.dtype.kind in "biu":
            return obj.tolist()
        return [_s12_tree(v, dp) for v in obj.tolist()]
    if isinstance(obj, (list, tuple, set, frozenset)):
        return [_s12_tree(v, dp) for v in (sorted(obj) if isinstance(obj, (set, frozenset)) else obj)]
    if isinstance(obj, (bool, np.bool_)):
        return bool(obj)
    if isinstance(obj, (int, np.integer)):
        return int(obj)
    if isinstance(obj, (float, np.floating)):
        return _s12_num(obj, dp)
    if obj is None or isinstance(obj, str):
        return obj
    if isinstance(obj, Path):
        return str(obj)
    if isinstance(obj, (pd.Timestamp, _s12_dt.datetime, _s12_dt.date)):
        return obj.isoformat()
    if hasattr(obj, "item") and callable(obj.item):
        return _s12_tree(obj.item(), dp)
    return str(obj)


def _s12_write_json(obj, name):
    """Strict compact UTF-8 JSON (gzip level 9 when ``name`` ends in .gz) under the web dir; records the size."""
    path = save_json(obj, _S12_WEB / name)
    _S12_SIZES[name] = path.stat().st_size
    return path


def _s12_write_lstb(name, columns, meta, kind):
    """LSTB container under the web dir (n = N_CELLS for every bundle file); records the size."""
    path = lstb_write(_S12_WEB / name, columns, meta=meta, kind=kind, n=_S12_NC)
    _S12_SIZES[name] = path.stat().st_size
    return path


def _s12_quantised(values, scale, offset=0.0, lo=None, hi=None):
    """What a decoder will see for ``values`` stored with (scale, offset): round-half-even like numpy/lstb_write."""
    q = np.rint((np.asarray(values, np.float64) - offset) / scale)
    if lo is not None:
        q = np.clip(q, lo, hi)
    return q * scale + offset


def _s12_offsets(centre_q, other, sign):
    """Non-negative uint8 offsets (scale 0.05 °C) of a quantile from the quantised centre.

    ``sign`` = −1 for quantiles below the centre (p05, p25), +1 above. NaN (no interval) → 0.
    Returns (array, n_clipped)."""
    d = sign * (np.asarray(other, np.float64) - np.asarray(centre_q, np.float64))
    d = np.where(np.isfinite(d), np.maximum(d, 0.0), 0.0)
    clipped = int(np.count_nonzero(np.rint(d / _S12_OFF_SCALE) > 255))
    return np.minimum(d, 255 * _S12_OFF_SCALE), clipped


def _s12_hhmm(hours):
    """Decimal IST hours → "HH:MM" (None when unknown)."""
    h = _s12_num(hours)
    if h is None:
        return None
    minutes = int(round(h * 60.0)) % (24 * 60)
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


def _s12_cells(grid2d):
    """(H, W) grid → canonical-order cell vector (float64)."""
    return np.asarray(grid2d, np.float64)[CELL_ROWS, CELL_COLS]


_S12_DISTRICT_OF_CELL = np.asarray(DISTRICT_IDX)[CELL_ROWS, CELL_COLS].astype(np.int16)

# %% [markdown]
# ## 12.5 Levels, frame catalogue and colour domains

# %%
def _s12_level(mode, year):
    """(level °C, [ci_lo, ci_hi]) of an observed frame from section 09's LEVELS (None when absent)."""
    rec = (LEVELS.get(mode) or {}).get(int(year))
    if not rec:
        return None, None
    lev = _s12_num(rec.get("level"))
    ci = rec.get("ci")
    ci = [_s12_num(ci[0]), _s12_num(ci[1])] if ci is not None and len(ci) == 2 else None
    return lev, ci


def _s12_tier(mode, year):
    tier = (FRAME_TIERS.get(mode) or {}).get(int(year))
    if tier is None:
        tier = "projected" if int(year) in _S12_PROJ else "modelled"
    if tier not in _S12_TIERS:
        raise ValueError(f"12: unknown evidence tier {tier!r} for {mode} {year} (vocabulary {_S12_TIERS})")
    return tier


def _s12_frame_field(mode, year):
    """Absolute °C field of an observed frame (canonical order, float64, NaN = no value)."""
    v = (FRAME_FIELDS.get(mode) or {}).get(int(year))
    return np.full(_S12_NC, np.nan) if v is None else np.asarray(v, np.float64)


def _s12_ncr_proj(mode, scen, year):
    """NCR scope quantiles {p05..p95} of a projected frame (from section 11's per-draw scope means)."""
    for row in PROJ_SERIES[mode][scen].get("ncr", []):
        if int(row["year"]) == int(year):
            return row
    return None


def _s12_round_out(lo, hi, step=1.0):
    return [float(_s12_math.floor(lo / step) * step), float(_s12_math.ceil(hi / step) * step)]


def _s12_domains():
    """timeline.domains (SPEC §5.3): abs per mode (fixed; = the raster domain of section 10, widened if needed),
    symmetric anomaly and SUHI domains, the diurnal range domain and the projection spread domain."""
    out, notes = {}, []
    raster_dom = (globals().get("RASTER_INDEX") or {}).get("domains") or {}
    spreads = []
    for m in _S12_MODES:
        abs_vals, anom_vals, suhi_vals = [], [], []
        for y in _S12_OBS:
            f = _s12_frame_field(m, y)
            ok = np.isfinite(f)
            if not ok.any():
                continue
            abs_vals.append(f[ok])
            lev, _ = _s12_level(m, y)
            if lev is not None:
                anom_vals.append(np.abs(f[ok] - lev))
            fb = _s12_cells(FEATURE_GRIDS[y]["frac_built"])
            fw = _s12_cells(FEATURE_GRIDS[y]["frac_water"])
            rural = ok & (fb <= 0.05) & (fw < 0.2)
            if rural.sum() >= 3:
                suhi_vals.append(np.abs(f[ok] - f[rural].mean()))
            unc = (globals().get("FRAME_UNC") or {}).get(m, {}).get(y)
            if unc is not None:
                sp = np.asarray(unc["p95"], np.float64) - np.asarray(unc["p05"], np.float64)
                spreads.append(sp[np.isfinite(sp)])
        for s in _S12_SCEN:
            q = PROJ_QUANTILES[m][s]
            p50 = np.asarray(q["p50"], np.float64)
            abs_vals.append(p50[np.isfinite(p50)])
            sp = np.asarray(q["p95"], np.float64) - np.asarray(q["p05"], np.float64)
            spreads.append(sp[np.isfinite(sp)])
        allv = np.concatenate(abs_vals) if abs_vals else np.zeros(0)
        if allv.size == 0:
            raise RuntimeError(f"12: mode {m} has no finite LST values to define its colour domain")
        spec_dom = _s12_round_out(*np.percentile(allv, [0.5, 99.5]))
        if m in raster_dom:
            dom = [float(raster_dom[m][0]), float(raster_dom[m][1])]
            if spec_dom[0] < dom[0] or spec_dom[1] > dom[1]:
                widened = [min(dom[0], spec_dom[0]), max(dom[1], spec_dom[1])]
                notes.append(f"{m}: raster domain {dom} widened to {widened} to cover 1 km p0.5-p99.5 {spec_dom}")
                log(f"12: {notes[-1]} (rasters keep their own lo/hi in raster_index.json)", "WARNING")
                dom = widened
        else:
            dom = spec_dom
        a = float(np.ceil(np.percentile(np.concatenate(anom_vals), 99.5))) if anom_vals else 5.0
        b = float(np.ceil(np.percentile(np.concatenate(suhi_vals), 99.5))) if suhi_vals else 5.0
        out[m] = {"abs": dom, "anom": [-max(a, 1.0), max(a, 1.0)], "suhi": [-max(b, 1.0), max(b, 1.0)],
                  "abs_spec_p005_p995": spec_dom}
    if "day" in _S12_MODES and "night" in _S12_MODES:
        dtr = []
        for y in _S12_OBS:
            d = _s12_frame_field("day", y) - _s12_frame_field("night", y)
            dtr.append(d[np.isfinite(d)])
        for s in _S12_SCEN:
            d = (np.asarray(PROJ_QUANTILES["day"][s]["p50"], np.float64)
                 - np.asarray(PROJ_QUANTILES["night"][s]["p50"], np.float64))
            dtr.append(d[np.isfinite(d)])
        dv = np.concatenate(dtr) if dtr else np.zeros(0)
        out["dtr"] = {"abs": _s12_round_out(*np.percentile(dv, [0.5, 99.5])) if dv.size else [0.0, 25.0]}
    sv = np.concatenate(spreads) if spreads else np.zeros(0)
    s_hi = float(np.ceil(np.percentile(sv, 99.5) * 2.0) / 2.0) if sv.size else 2.0
    out["spread"] = [0.0, max(s_hi, 0.5)]
    return out, notes


with timer("12_domains"):
    _S12_DOMAINS, _S12_DOMAIN_NOTES = _s12_domains()
for _s12_m in _S12_MODES:
    log(f"12: {_s12_m} domains abs {_S12_DOMAINS[_s12_m]['abs']} (SPEC p0.5-p99.5 "
        f"{_S12_DOMAINS[_s12_m]['abs_spec_p005_p995']}), anom {_S12_DOMAINS[_s12_m]['anom']}, "
        f"suhi {_S12_DOMAINS[_s12_m]['suhi']}")
log(f"12: dtr {(_S12_DOMAINS.get('dtr') or {}).get('abs')}, spread {_S12_DOMAINS['spread']}")


def _s12_level_extras(mode, year):
    """Optional level diagnostics of section 09 (D8, D10) for the manifest frame entry; {} when absent."""
    lev = LEVELS.get(mode, {}).get(int(year)) or {}
    out = {}
    for k, dp in (("raw_level", 3), ("composition_correction", 3), ("fixed_mask_coverage", 4),
                  ("drift_correction_c", 3)):
        if lev.get(k) is not None:
            out[k] = _s12_num(lev.get(k), dp)
    return out


def _s12_obs_mode_entry(mode, year):
    """manifest.timeline.frames[].<mode> for an observed frame (SPEC §5.3)."""
    fm = FRAME_META[int(year)]
    tier = _s12_tier(mode, year)
    lev, ci = _s12_level(mode, year)
    field = _s12_frame_field(mode, year)
    if mode == "day":
        d = fm.get("day") or {}
        sensors = d.get("sensors") or []
        return {**_s12_level_extras(mode, year), "tier": tier, "sensor": " + ".join(sensors) if sensors else "Landsat",
                "overpass_ist": _s12_hhmm(d.get("mean_overpass_ist_h")), "scenes": int(d.get("scenes") or 0),
                "coverage": _s12_num(d.get("coverage"), 4), "native_m": 30,
                "available": bool(np.isfinite(field).any()), "level": _s12_num(lev, 2),
                "level_ci": None if ci is None else [_s12_num(ci[0], 2), _s12_num(ci[1], 2)],
                "overpass_correction": _s12_num((LEVELS.get(mode, {}).get(int(year)) or {})
                                                .get("overpass_correction"), 3),
                "heating_rate_k_per_h": _s12_num(d.get("heating_rate_k_per_h"), 3),
                "scenes_per_pathrow": {str(k): int(v) for k, v in (d.get("scenes_per_pathrow") or {}).items()},
                "path_offsets": {str(k): _s12_num(v, 4) for k, v in (d.get("path_offsets") or {}).items()}}
    n = fm.get("night") or {}
    modelled = tier == "modelled"
    return {**_s12_level_extras(mode, year), "tier": tier,
            "sensor": "model hindcast (ERA5-Land level)" if modelled else (n.get("sensor") or n.get("source")),
            "overpass_ist": "01:30" if modelled or n.get("overpass_ist_h") is None
            else _s12_hhmm(n.get("overpass_ist_h")),
            "scenes": int(n.get("composites") or 0),
            "coverage": 1.0 if modelled else _s12_num(n.get("coverage"), 4), "native_m": 1000,
            "available": bool(np.isfinite(field).any()), "level": _s12_num(lev, 2),
            "level_ci": None if ci is None else [_s12_num(ci[0], 2), _s12_num(ci[1], 2)],
            "source": n.get("source"), "method": (LEVELS.get(mode, {}).get(int(year)) or {}).get("method")}


def _s12_proj_mode_entry(mode, year):
    """manifest.timeline.frames[].<mode> for a projected frame: headline level = SSP2-4.5 NCR median."""
    by_s = {}
    for s in _S12_SCEN:
        r = _s12_ncr_proj(mode, s, year) or {}
        by_s[s] = {k: _s12_num(r.get(k), 2) for k in ("p05", "p25", "p50", "p75", "p95")}
    head = by_s.get("ssp245") or (by_s[_S12_SCEN[0]] if _S12_SCEN else {})
    p50 = PROJ_QUANTILES[mode][_S12_SCEN[0]]["p50"][_S12_PROJ.index(int(year))] if _S12_SCEN else None
    return {"tier": "projected", "sensor": "CMIP6 delta x dLST/dTair + land-change model (Monte Carlo)",
            "overpass_ist": _S12_MODE_INFO[mode]["reference_overpass_ist"], "scenes": 0,
            "coverage": _s12_num(np.isfinite(p50).mean(), 4) if p50 is not None else 0.0,
            "native_m": int(CFG.GRID_RES_M), "available": True, "level": head.get("p50"),
            "level_ci": ([head.get("p05"), head.get("p95")] if head.get("p05") is not None else None),
            "level_scenario": "ssp245" if "ssp245" in by_s else (_S12_SCEN[0] if _S12_SCEN else None),
            "by_scenario": by_s}


def _s12_timeline_frames():
    raster_frames = ((globals().get("RASTER_INDEX") or {}).get("frames")) or {}
    frames = []
    for y in _S12_OBS:
        entry = {"year": y, "window": list(CFG.window(y)), "kind": "observed"}
        for m in CFG.MODES:
            entry[m] = (_s12_obs_mode_entry(m, y) if m in _S12_MODES
                        else {"tier": "modelled", "available": False, "level": None, "level_ci": None})
        entry["xai"] = {m: bool(m in XAI_FRAMES and y in XAI_FRAMES[m]) for m in CFG.MODES}
        entry["raster"] = {m: f"{m}_{y}" in raster_frames for m in CFG.MODES}
        frames.append(entry)
    for y in _S12_PROJ:
        entry = {"year": y, "window": list(CFG.window(y)), "kind": "projected"}
        for m in CFG.MODES:
            entry[m] = (_s12_proj_mode_entry(m, y) if m in _S12_MODES
                        else {"tier": "projected", "available": False, "level": None, "level_ci": None})
        entry["xai"] = {m: False for m in CFG.MODES}
        entry["raster"] = {m: f"{m}_{y}" in raster_frames for m in CFG.MODES}
        frames.append(entry)
    return frames


_S12_TIMELINE_FRAMES = _s12_timeline_frames()

# %% [markdown]
# ## 12.6 Per-cell binary files: cells, cubes, zones, XAI frames (SPEC §5.1–§5.2)

# %%
def _s12_write_cells():
    lon = np.asarray(CELL_LON, np.float64)
    lat = np.asarray(CELL_LAT, np.float64)
    cols = [{"name": "cell_id", "array": np.asarray(CELL_IDS, np.int32), "dtype": "int32"},
            {"name": "row", "array": np.asarray(CELL_ROWS, np.int16), "dtype": "int16"},
            {"name": "col", "array": np.asarray(CELL_COLS, np.int16), "dtype": "int16"},
            {"name": "lon", "array": lon.astype(np.float32), "dtype": "float32"},
            {"name": "lat", "array": lat.astype(np.float32), "dtype": "float32"},
            {"name": "district", "array": _S12_DISTRICT_OF_CELL, "dtype": "int16"}]
    if int(np.max(CELL_ROWS)) > 32767 or int(np.max(CELL_COLS)) > 32767:
        raise ValueError("12: grid larger than int16 row/col range")
    meta = {"grid": {"crs": GRID.crs, "res": int(GRID.res), "x0": float(GRID.x0), "y0": float(GRID.y0),
                     "width": int(GRID.width), "height": int(GRID.height)},
            "order": "ROI cells sorted by cell_id = row * width + col", "cell_area_km2": _S12_CELL_KM2}
    return _s12_write_lstb("cells.lstb.gz", cols, meta, "cells")


def _s12_write_obs_cube(mode):
    """cube_obs_<mode>: lst int16 [F_obs, n] (0.01 °C), aoa_out uint8, p05_off / p95_off uint8 (0.05 °C)."""
    F = len(_S12_OBS)
    lst = np.full((F, _S12_NC), np.nan)
    aoa = np.zeros((F, _S12_NC), np.uint8)
    lo_off = np.zeros((F, _S12_NC))
    hi_off = np.zeros((F, _S12_NC))
    tiers, levels, level_ci, clipped = [], [], [], 0
    for j, y in enumerate(_S12_OBS):
        lst[j] = _s12_frame_field(mode, y)
        a = (globals().get("FRAME_AOA_OUT") or {}).get(mode, {}).get(y)
        if a is not None:
            aoa[j] = np.asarray(a, bool).astype(np.uint8)
        tier = _s12_tier(mode, y)
        tiers.append(tier)
        lev, ci = _s12_level(mode, y)
        levels.append(_s12_num(lev, 4))
        level_ci.append(None if ci is None else [_s12_num(ci[0], 4), _s12_num(ci[1], 4)])
        unc = (globals().get("FRAME_UNC") or {}).get(mode, {}).get(y)
        if unc is not None and tier != "observed":
            centre = _s12_quantised(lst[j], _S12_LST_SCALE)
            lo_off[j], c1 = _s12_offsets(centre, unc["p05"], -1)
            hi_off[j], c2 = _s12_offsets(centre, unc["p95"], +1)
            clipped += c1 + c2
    if clipped:
        log(f"12: cube_obs_{mode}: {clipped} uncertainty offsets clipped at 12.75 °C", "WARNING")
    cols = [{"name": "lst", "array": lst, "dtype": "int16", "scale": _S12_LST_SCALE, "offset": 0.0,
             "nodata": _S12_I16_NODATA},
            {"name": "aoa_out", "array": aoa, "dtype": "uint8"},
            {"name": "p05_off", "array": lo_off, "dtype": "uint8", "scale": _S12_OFF_SCALE},
            {"name": "p95_off", "array": hi_off, "dtype": "uint8", "scale": _S12_OFF_SCALE}]
    meta = {"mode": mode, "frames": list(_S12_OBS), "tiers": tiers, "levels": levels, "level_ci": level_ci,
            "units": "degC", "series": "obs",
            "uncertainty": "p05 = lst - p05_off, p95 = lst + p95_off (modelled / reconstructed frames; 0 = none)"}
    return _s12_write_lstb(f"cube_obs_{mode}.lstb.gz", cols, meta, "cube")


def _s12_write_ssp_cube(mode, scen):
    """cube_<ssp>_<mode>: p50 int16 [F_proj, n]; p05/p25/p75/p95 offsets uint8 (0.05 °C); flags uint8."""
    q = PROJ_QUANTILES[mode][scen]
    p50 = np.asarray(q["p50"], np.float64)
    centre = _s12_quantised(p50, _S12_LST_SCALE)
    cols = [{"name": "p50", "array": p50, "dtype": "int16", "scale": _S12_LST_SCALE, "offset": 0.0,
             "nodata": _S12_I16_NODATA}]
    clipped = 0
    for key, sign in (("p05", -1), ("p25", -1), ("p75", +1), ("p95", +1)):
        off, c = _s12_offsets(centre, q[key], sign)
        clipped += c
        cols.append({"name": f"{key}_off", "array": off, "dtype": "uint8", "scale": _S12_OFF_SCALE})
    if clipped:
        log(f"12: cube_{scen}_{mode}: {clipped} quantile offsets clipped at 12.75 °C", "WARNING")
    flags = np.asarray(PROJ_FLAGS[mode][scen], np.uint8)
    cols.append({"name": "flags", "array": flags, "dtype": "uint8"})
    pm = (globals().get("PROJ_META") or {}).get(mode, {}).get(scen, {})
    cd = CMIP6_DELTAS["scenarios"].get(scen, {})
    meta = {"mode": mode, "scenario": scen, "frames": list(_S12_PROJ), "method": cd.get("method", "gcm"),
            "units": "degC", "series": scen, "n_gcm": cd.get("n_gcm"), "n_mc": pm.get("n_mc"),
            "n_land_real": pm.get("n_land_real"), "l_base": _s12_num(pm.get("l_base"), 4),
            "flags": "bit0 outside AOA; bits1-2 VSUP tier of (p95 - p05) / 2 (<0.5, <1, <2, >=2 degC)",
            "note": _S12_PROJ_NOTE}
    return _s12_write_lstb(f"cube_{scen}_{mode}.lstb.gz", cols, meta, "cube")


def _s12_zone_float(z):
    """uint8 zone ids → float with NaN for nodata (lstb_write then stores the 255 nodata code)."""
    a = np.asarray(z).astype(np.float64)
    a[(a > 3) | ~np.isfinite(a)] = np.nan
    return a


def _s12_write_zone_cube(mode):
    obs = np.full((len(_S12_OBS), _S12_NC), np.nan)
    for j, y in enumerate(_S12_OBS):
        z = (ZONES_OBS.get(mode) or {}).get(y)
        if z is not None:
            obs[j] = _s12_zone_float(z)
    cols = [{"name": "obs", "array": obs, "dtype": "uint8", "nodata": _S12_ZONE_NODATA}]
    frames = {"obs": list(_S12_OBS)}
    for s in _S12_SCEN:
        cols.append({"name": s, "array": _s12_zone_float(PROJ_ZONES[mode][s]), "dtype": "uint8",
                     "nodata": _S12_ZONE_NODATA})
        frames[s] = list(_S12_PROJ)
    meta = {"mode": mode, "frames": frames, "frames_obs": list(_S12_OBS), "frames_proj": list(_S12_PROJ),
            "zones": _S12_ZONE_META, "nodata": _S12_ZONE_NODATA,
            "assignment": "nearest centroid in the 18-group SHAP space of the mode (section 08 ZONE_MODEL)"}
    return _s12_write_lstb(f"cube_zones_{mode}.lstb.gz", cols, meta, "zones")


_S12_XAI_YEARS = sorted({int(y) for m in _S12_MODES for y in (XAI_FRAMES.get(m) or [])})


def _s12_write_features(year):
    """xai_<year>_features: the 33 base features, int16 with per-column (scale, offset) from quant_params."""
    cols = []
    for f in BASE_FEATURES:
        v = _s12_cells(FEATURE_GRIDS[year][f])
        scale, offset = quant_params(v, "int16", nodata=_S12_I16_NODATA)
        cols.append({"name": f, "array": v, "dtype": "int16", "scale": scale, "offset": offset,
                     "nodata": _S12_I16_NODATA})
    meta = {"year": int(year), "features": list(BASE_FEATURES),
            "note": "focal (_m3/_m15) features are recomputed from these on the grid (FOCAL_SPEC)"}
    return _s12_write_lstb(f"xai_{year}_features.lstb.gz", cols, meta, "features")


_S12_XAI_STATS = {}


def _s12_comp_corr(mode, year):
    """Section 09's composition correction of a frame level (°C; 0 when absent or not finite, D8)."""
    v = (LEVELS.get(mode, {}).get(int(year)) or {}).get("composition_correction")
    try:
        v = float(v)
    except (TypeError, ValueError):
        return 0.0
    return v if np.isfinite(v) else 0.0


def _s12_write_xai(mode, year):
    """xai_<year>_<mode>: 18 group SHAP int16 (0.001 °C) + pred / oof / obs / resid int16 (0.01 °C, absolute).

    base_value_c = SHAP_BASE + level, so pred = base_value_c + Σ SHAP holds in absolute °C (verified on the
    quantised values before writing)."""
    lev, _ = _s12_level(mode, year)
    if lev is None:
        raise RuntimeError(f"12: no level for {mode} {year}; cannot express XAI predictions in °C")
    lev = round(float(lev), 4)
    base_c = round(float(SHAP_BASE[mode]) + lev, 4)
    shap = np.asarray(SHAP_GROUP_VALUES[mode][year], np.float64)
    if shap.shape != (_S12_NC, len(_S12_GROUPS)):
        raise ValueError(f"12: SHAP_GROUP_VALUES[{mode}][{year}] has shape {shap.shape}")
    pred = np.asarray(PRED_ANOM[mode][year], np.float64) + lev
    oof = np.asarray(OOF_ANOM[mode][year], np.float64) + lev
    anom = DF[f"anom_{mode}"].to_numpy(np.float64)
    j = _S12_OBS.index(year)
    obs = anom[j * _S12_NC:(j + 1) * _S12_NC] + lev
    if _s12_tier(mode, year) == "modelled":
        obs = np.full(_S12_NC, np.nan)
    resid = obs - oof
    if np.nanmax(np.abs(shap)) > 32.7:
        log(f"12: {mode} {year}: |group SHAP| up to {np.nanmax(np.abs(shap)):.1f} °C exceeds the int16 range at "
            "0.001 °C and is clipped", "WARNING")
    # Waterfall invariant on exactly what the browser will decode.
    shap_q = _s12_quantised(shap, _S12_SHAP_SCALE, lo=-32767, hi=32767)
    pred_q = _s12_quantised(pred, _S12_LST_SCALE, lo=-32767, hi=32767)
    rows = np.isfinite(shap_q).all(axis=1) & np.isfinite(pred_q)
    err = np.abs(pred_q[rows] - (base_c + shap_q[rows].sum(axis=1)))
    max_err = float(err.max()) if err.size else 0.0
    if not max_err <= _S12_WATERFALL_TOL_C:
        raise AssertionError(f"12: {mode} {year}: waterfall invariant violated after quantisation "
                             f"(max err {max_err:.4f} °C on {int((err > _S12_WATERFALL_TOL_C).sum())} rows)")
    field = _s12_frame_field(mode, year)
    # obs = anomaly + level; the level of a partially covered frame carries section 09's composition correction
    # (D8) while the frame field keeps the observed values, so obs = field + composition_correction.
    cc = _s12_comp_corr(mode, year)
    both = np.isfinite(field) & np.isfinite(obs)
    obs_vs_field = float(np.max(np.abs(field[both] + cc - obs[both]))) if both.any() else None
    _S12_XAI_STATS[(mode, year)] = {"waterfall_max_err": max_err, "n_rows": int(rows.sum()),
                                    "obs_vs_frame_field_max_diff": obs_vs_field}
    cols = [{"name": g, "array": shap[:, gi], "dtype": "int16", "scale": _S12_SHAP_SCALE, "offset": 0.0,
             "nodata": _S12_I16_NODATA} for gi, g in enumerate(_S12_GROUPS)]
    for name, arr in (("pred", pred), ("oof", oof), ("obs", obs), ("resid", resid)):
        cols.append({"name": name, "array": arr, "dtype": "int16", "scale": _S12_LST_SCALE, "offset": 0.0,
                     "nodata": _S12_I16_NODATA})
    meta = {"year": int(year), "mode": mode, "tier": _s12_tier(mode, year), "base_value_c": base_c,
            "level": lev, "shap_base": round(float(SHAP_BASE[mode]), 4), "groups": list(_S12_GROUPS),
            "units": "degC", "oof_scheme": "block20 XGBoost out-of-fold (NaN where the row was not a training row)",
            "invariant": "pred = base_value_c + sum(group SHAP) within 0.05 degC on rows without NaN",
            "composition_correction": round(cc, 4)}
    return _s12_write_lstb(f"xai_{year}_{mode}.lstb.gz", cols, meta, "xai")


with timer("12_binary"):
    _s12_write_cells()
    for _s12_m in _S12_MODES:
        _s12_write_obs_cube(_s12_m)
        for _s12_s in _S12_SCEN:
            _s12_write_ssp_cube(_s12_m, _s12_s)
        _s12_write_zone_cube(_s12_m)
    for _s12_y in _S12_XAI_YEARS:
        _s12_write_features(_s12_y)
    for _s12_m in _S12_MODES:
        for _s12_y in XAI_FRAMES.get(_s12_m, []):
            _s12_write_xai(_s12_m, int(_s12_y))
free_memory()
log("12: XAI waterfall max error after quantisation: " + ", ".join(
    f"{m}/{y}={v['waterfall_max_err']:.3f}" for (m, y), v in sorted(_S12_XAI_STATS.items())))
_s12_obs_diff = [v["obs_vs_frame_field_max_diff"] for v in _S12_XAI_STATS.values()
                 if v["obs_vs_frame_field_max_diff"] is not None]
if _s12_obs_diff:
    log(f"12: XAI 'obs' (anomaly + level) vs cube frame field: max |diff| {max(_s12_obs_diff):.2e} °C")
    # XAI obs = anomaly + level must be the same field as the cube frame (row order and level identity, C-01)
    if max(_s12_obs_diff) > 1e-3:
        raise ValueError(f"12: XAI 'obs' differs from the cube frame field by up to {max(_s12_obs_diff):.4f} °C "
                         "(row order or level mismatch between sections 06/08/09): "
                         + ", ".join(f"{m}/{y}={v['obs_vs_frame_field_max_diff']:.4f}"
                                     for (m, y), v in sorted(_S12_XAI_STATS.items())
                                     if (v["obs_vs_frame_field_max_diff"] or 0.0) > 1e-3))


# %% [markdown]
# ## 12.7 Timeline series (SPEC §5.4)
# One entry per scope (NCR, the 25 districts and the four zones of each mode) and mode: frame statistics of section
# 09 (mean, level CI, p90, hot-core area, signed SUHI, cell count, tier), the annual ERA5-Land and satellite series,
# the SSP fans of section 11 (quantiles of per-draw scope means), trends, the decomposition of the projected change
# into climate and land parts, the uncertainty budget (shares of the variance of the scope mean) and the years at
# which the median first exceeds the weather-normalised baseline by +1/+2/+3 °C. Zone shares per frame close the file.

# %%
def _s12_round_rows(rows, dp=2, keep_int=("year", "n_cells")):
    out = []
    for r in rows or []:
        rr = {}
        for k, v in r.items():
            if k in keep_int:
                rr[k] = None if v is None else int(v)
            elif k == "hot_core_km2":
                rr[k] = _s12_num(v, 1)
            elif k == "coverage":                 # finite cells / ROI cells of the scope (D16)
                rr[k] = _s12_num(v, 4)
            elif isinstance(v, (list, tuple)):
                rr[k] = [_s12_num(x, dp) for x in v]
            elif isinstance(v, str) or v is None or isinstance(v, bool):
                rr[k] = v
            else:
                rr[k] = _s12_num(v, dp)
        out.append(rr)
    return out


def _s12_trend(t):
    if not t:
        return None
    return {k: (_s12_num(v, 3) if isinstance(v, (float, np.floating)) else _s12_tree(v, 3)) for k, v in t.items()}


def _s12_series_entry(mode, scope):
    frames = _s12_round_rows(SERIES_FRAMES[mode].get(scope, []))
    ann = (SERIES_ANNUAL.get(mode) or {}).get(scope) or {}
    annual = {"era5_skin": [{"year": int(r["year"]), "value": _s12_num(r["value"], 2),
                             "anomaly": _s12_num(r.get("anomaly"), 2)} for r in ann.get("era5_skin", [])],
              "satellite": [{"year": int(r["year"]), "value": _s12_num(r["value"], 2), "sensor": r.get("sensor"),
                             "variable": r.get("variable"), "flag": r.get("flag")}
                            for r in ann.get("satellite", [])]}
    tr = (TRENDS.get(mode) or {})
    if scope == "ncr":
        trend = {"obs": _s12_trend(tr.get("obs")),
                 "annual": {k: _s12_trend(v) for k, v in (tr.get("annual") or {}).items()}}
    else:
        bs = (tr.get("by_scope") or {}).get(scope) or {}
        trend = {"obs": _s12_trend(bs.get("obs")),
                 "annual": {k: _s12_trend(v) for k, v in (bs.get("annual") or {}).items()}}
    ssp, decomp, budget, thr = {}, {}, {}, {}
    for s in _S12_SCEN:
        # A scope without cells (e.g. a district merged away in the boundary layer) has no section-11 rows: export
        # every projection year with null quantiles, as its observed frames carry null means (SPEC §5.4).
        ssp[s] = _s12_round_rows(PROJ_SERIES[mode][s].get(scope)
                                 or [{"year": int(y), **{k: None for k in ("p05", "p25", "p50", "p75", "p95")}}
                                     for y in _S12_PROJ])
        decomp[s], budget[s] = {}, {}
        for y in _S12_PROJ:
            d = ((PROJ_DECOMPOSITION[mode][s].get(y) or {}).get("by_scope") or {}).get(scope)
            if d:
                # total = p50 - baseline_c (the scope's weather-normalised 2025 baseline, D14)
                decomp[s][str(y)] = {k: _s12_num(d.get(k), 2) for k in ("climate", "land", "total", "baseline_c")}
            b = ((PROJ_UNCERTAINTY[mode][s].get(y) or {}).get("by_scope") or {}).get(scope)
            if b:
                budget[s][str(y)] = {k: _s12_num(b.get(k), 4) for k in ("gcm", "sensitivity", "land", "model")}
                budget[s][str(y)]["draw_sd_c"] = _s12_num(b.get("draw_sd_c"), 3)
        t = PROJ_THRESHOLD_YEARS[mode][s].get(scope) or {}
        thr[s] = {k: (None if t.get(k) is None else int(t[k])) for k in ("+1", "+2", "+3")}
    return {"frames": frames, "annual": annual, "ssp": ssp, "trend": trend, "decomposition": decomp,
            "uncertainty_budget": budget, "threshold_years": thr}


def _s12_zone_share(z):
    z = np.asarray(z)
    ok = z < 4
    n = int(ok.sum())
    if n == 0:
        return [None] * 4
    return [round(float(np.count_nonzero(z[ok] == k)) / n, 4) for k in range(4)]


def _s12_timeline_series():
    scopes = []
    for sc in SERIES_SCOPES:
        if sc["kind"] == "zone" and sc.get("mode") not in _S12_MODES:
            continue
        scopes.append({k: sc[k] for k in ("id", "label", "kind", "mode") if k in sc})
    series = {}
    for sc in scopes:
        modes = [sc["mode"]] if sc["kind"] == "zone" else _S12_MODES
        series[sc["id"]] = {m: _s12_series_entry(m, sc["id"]) for m in modes}
    zone_share = {}
    for m in _S12_MODES:
        zone_share[m] = {"obs": {str(y): _s12_zone_share(ZONES_OBS[m][y]) for y in _S12_OBS if y in ZONES_OBS[m]}}
        for s in _S12_SCEN:
            zone_share[m][s] = {str(y): _s12_zone_share(PROJ_ZONES[m][s][j]) for j, y in enumerate(_S12_PROJ)}
    lb = (globals().get("CMIP6_DELTAS") or {}).get("l_base") or {}
    return {"reference_period": list(CFG.REFERENCE_PERIOD),
            "hot_core_threshold_c": {m: _s12_num(HOT_CORE_THRESHOLD.get(m), 2) for m in _S12_MODES},
            "hot_core_frames": {m: [int(y) for y in (globals().get("_S09_HOT_FRAMES") or {}).get(m, [])]
                                for m in _S12_MODES},
            "baseline_level_c": {m: _s12_num((lb.get(m) or {}).get("l_base"), 2) for m in _S12_MODES},
            "frames_obs": list(_S12_OBS), "frames_proj": list(_S12_PROJ), "scenarios": list(_S12_SCEN),
            "scopes": scopes, "series": series, "zone_share": zone_share,
            "notes": [_S12_PROJ_NOTE] if _S12_PROJ else []}


with timer("12_timeline_series"):
    _S12_SERIES = _s12_timeline_series()
    _s12_write_json(_S12_SERIES, "timeline_series.json.gz")
log(f"12: timeline_series.json.gz: {len(_S12_SERIES['scopes'])} scopes, "
    f"{_S12_SIZES['timeline_series.json.gz'] / 1e6:.2f} MB")

# %% [markdown]
# ## 12.8 Explanation files: shap_global, dependence, interactions, zones (SPEC §5.5)
# All are `{"modes": {"day": {...}, "night": {...}}}` with the v1 content per mode, keyed by the 18 SHAP groups.
# Zones additionally carry their projected area / LST per scenario and transition matrices from the current frame
# into the projections (`"<ssp>": {"2025->2030": 4×4, ...}`).

# %%
def _s12_threshold(th):
    s4 = lambda v: _s12_sig(v, 4)  # noqa: E731
    out = {"primary": th.get("primary")}
    for k in ("zero_crossing", "breakpoint", "saturation"):
        point = s4(th.get(k))
        ci = th.get(f"{k}_ci")
        out[k] = point
        # an interval is only meaningful around an existing point estimate (SPEC_v1 §4.4)
        out[f"{k}_ci"] = None if point is None or ci is None else [s4(ci[0]), s4(ci[1])]
        sup = th.get(f"{k}_support")
        out[f"{k}_support"] = None if point is None or sup is None else round(float(sup), 3)
    out["zero_crossing_flag"] = "multiple" if th.get("zero_crossing_flag") == "multiple" else None
    out["slope_before"] = s4(th.get("slope_before"))
    out["slope_after"] = s4(th.get("slope_after"))
    out["slope"] = s4(th.get("slope"))
    out["effect_range"] = _s12_num(th.get("effect_range"), 3)
    out["direction"] = th.get("direction")
    order = ["primary", "zero_crossing", "zero_crossing_ci", "zero_crossing_support", "zero_crossing_flag",
             "breakpoint", "breakpoint_ci", "breakpoint_support", "slope_before", "slope_after", "saturation",
             "saturation_ci", "saturation_support", "effect_range", "direction", "slope"]
    return {k: out[k] for k in order}


def _s12_r3(a):
    return [_s12_num(v, 3) for v in np.asarray(a, np.float64).tolist()]


def _s12_shap_global():
    modes = {}
    for m in _S12_MODES:
        imp = IMPORTANCE[m]
        g = imp["global"]
        info = BOOTSTRAP_INFO.get(m, {})
        modes[m] = {
            "groups": list(imp["groups"]),
            "global": {k: _s12_r3(g[k]) for k in ("mean_abs", "ci_lo", "ci_hi", "bias") if k in g},
            "by_frame": {str(y): {"mean_abs": _s12_r3(v["mean_abs"]), "mean": _s12_r3(v["mean"]),
                                  "n": int(v.get("n", 0))} for y, v in imp["by_frame"].items()},
            "by_zone": {str(z): {"mean_abs": _s12_r3(v["mean_abs"]), "mean": _s12_r3(v["mean"]),
                                 "n": int(v.get("n", 0))} for z, v in imp["by_zone"].items()},
            "order": [int(i) for i in imp.get("order", [])],
            "features": {"names": list(imp["features"]["names"]),
                         "mean_abs": _s12_r3(imp["features"]["mean_abs"])} if imp.get("features") else None,
            "fit_frames": [int(y) for y in imp.get("fit_frames", [])],
            "n_bootstrap": int(imp.get("n_bootstrap", info.get("n", 0))),
            "bootstrap_mode": info.get("mode", "block"),
            "ci_method": imp.get("ci_method", "recentred-percentile"),
            "ci_label": imp.get("ci_label", info.get("ci_label")),
        }
    return {"modes": modes}


def _s12_dependence():
    modes = {}
    for m in _S12_MODES:
        groups = {}
        for g, d in DEPENDENCE[m]["groups"].items():
            sc = d["scatter"]
            groups[g] = {
                "primary": d["primary"],
                "bin_centers": _s12_sig_increasing(d["bin_centers"]), "mean": np.round(np.asarray(d["mean"], float), 3),
                "ci_lo": np.round(np.asarray(d["ci_lo"], float), 3),
                "ci_hi": np.round(np.asarray(d["ci_hi"], float), 3),
                "count": np.asarray(d["count"], np.int64),
                "scatter": {"x": _s12_sig_arr(sc["x"]), "shap": np.round(np.asarray(sc["shap"], float), 3),
                            "color": _s12_sig_arr(sc["color"]), "color_feature": sc.get("color_feature"),
                            "color_group": sc.get("color_group"), "zone": np.asarray(sc["zone"], np.int64),
                            "year": np.asarray(sc["year"], np.int64)},
                "threshold": _s12_threshold(d["threshold"]),
            }
        modes[m] = {"groups": groups, "bins": int(CFG.DEP_BINS),
                    "x": "primary feature value", "y": "group SHAP (degC)"}
    return {"modes": modes}


def _s12_interactions():
    modes = {}
    for m in _S12_MODES:
        it = INTERACTIONS[m]
        r4 = lambda a: np.round(np.asarray(a, np.float64), 4)  # noqa: E731
        modes[m] = {"groups": list(it["groups"]), "global": r4(it["global"]),
                    "by_zone": {str(z): r4(v) for z, v in it["by_zone"].items()},
                    "n_rows": int(it.get("n_rows", 0)), "rows_per_frame": int(it.get("rows_per_frame", 0)),
                    "definition": it.get("definition")}
    return {"modes": modes}


def _s12_transition(a, b):
    a = np.asarray(a, np.int64)
    b = np.asarray(b, np.int64)
    ok = (a < 4) & (b < 4)
    return np.bincount(a[ok] * 4 + b[ok], minlength=16).reshape(4, 4).astype(int).tolist()


def _s12_recommendation(r):
    out = dict(r)
    out["current"] = _s12_sig(r.get("current"))
    out["target"] = _s12_sig(r.get("target"))
    out["step"] = _s12_sig(r.get("step"))
    out["expected_delta_c"] = _s12_num(r.get("expected_delta_c"), 2)
    out["ci"] = None if r.get("ci") is None else [_s12_num(r["ci"][0], 2), _s12_num(r["ci"][1], 2)]
    out["bias"] = _s12_num(r.get("bias"), 3)
    for k in ("mean_applied_step", "best_delta_c"):
        if k in r:
            out[k] = _s12_num(r[k], 4)
    if isinstance(r.get("bounds"), dict):
        out["bounds"] = {k: _s12_sig(v) for k, v in r["bounds"].items()}
    if isinstance(r.get("spillover"), dict):
        out["spillover"] = {"n_cells": int(r["spillover"].get("n_cells") or 0),
                            "mean_delta_c": _s12_num(r["spillover"].get("mean_delta_c"), 3)}
    return _s12_tree(out, 4)


def _s12_zones():
    modes = {}
    for m in _S12_MODES:
        zm = ZONE_MODEL[m]
        zones = []
        for p in ZONE_PROFILES[m]:
            z = int(p["id"])
            area = {"obs": {k: _s12_num(v, 1) for k, v in p["area_km2"]["obs"].items()}}
            lst_mean = {"obs": {k: _s12_num(v, 2) for k, v in p["lst_mean"]["obs"].items()}}
            lst_pred = {"obs": {k: _s12_num(v, 2) for k, v in p["lst_pred_mean"]["obs"].items()}}
            n_proj = {}
            for s in _S12_SCEN:
                zs = np.asarray(PROJ_ZONES[m][s])
                p50 = np.asarray(PROJ_QUANTILES[m][s]["p50"], np.float64)
                area[s], lst_mean[s], n_proj[s] = {}, {}, {}
                for j, y in enumerate(_S12_PROJ):
                    sel = zs[j] == z
                    n = int(sel.sum())
                    vals = p50[j][sel]
                    vals = vals[np.isfinite(vals)]
                    area[s][str(y)] = round(n * _S12_CELL_KM2, 1)
                    lst_mean[s][str(y)] = round(float(vals.mean()), 2) if vals.size else None
                    n_proj[s][str(y)] = n
            zones.append({
                "id": z, "name": p["name"], "color": p["color"], "mode": m, "description": p["description"],
                # D11: canonical name stays; display_name / label_caveat qualify a label the data do not support
                "display_name": str(p.get("display_name") or p["name"]), "label_caveat": p.get("label_caveat"),
                "n_cells": {str(k): int(v) for k, v in p["n_cells"].items()}, "n_cells_proj": n_proj,
                "area_km2": area, "lst_mean": lst_mean, "lst_pred_mean": lst_pred,
                "anom_pred_mean": _s12_tree(p.get("anom_pred_mean"), 3),
                "anom_obs_mean": _s12_tree(p.get("anom_obs_mean"), 3),
                "feature_means": {f: _s12_sig(v) for f, v in p["feature_means"].items()},
                "feature_means_frame": int(p.get("feature_means_frame", _S12_NOW)),
                "shap_means": {g: _s12_num(v, 3) for g, v in p["shap_means"].items()},
                "top_warming": _s12_tree(p["top_warming"], 3), "top_cooling": _s12_tree(p["top_cooling"], 3),
                "top_interactions": _s12_tree(p["top_interactions"], 4),
                "top_districts": _s12_tree(p["top_districts"], 4),
                "recommendations": [_s12_recommendation(r) for r in p["recommendations"]],
            })
        transitions = {"obs": ZONE_TRANSITIONS[m]["obs"]}
        for s in _S12_SCEN:
            tr, prev_y, prev = {}, _S12_NOW, ZONES_OBS[m][_S12_NOW]
            for j, y in enumerate(_S12_PROJ):
                cur = PROJ_ZONES[m][s][j]
                tr[f"{prev_y}->{y}"] = _s12_transition(prev, cur)
                prev_y, prev = y, cur
            transitions[s] = tr
        diag = zm.get("diagnostics", {})
        modes[m] = {"k": int(zm.get("k", 4)), "silhouette": _s12_num(zm.get("silhouette"), 4),
                    "diagnostics": {"k": [int(k) for k in diag.get("k", [])],
                                    "inertia": [_s12_sig(v, 6) for v in diag.get("inertia", [])],
                                    "silhouette": [_s12_num(v, 4) for v in diag.get("silhouette", [])],
                                    "n_init": int(diag.get("n_init", 10)), "n_rows": int(diag.get("n_rows", 0))},
                    "labelling": _s12_tree(zm.get("labelling"), 4), "groups": list(_S12_GROUPS),
                    "centroids": np.round(np.asarray(zm["centroids"], np.float64), 4),
                    "space": zm.get("space"), "zones": zones, "transitions": transitions}
    return {"modes": modes}


with timer("12_explain_files"):
    _s12_write_json(_s12_shap_global(), "shap_global.json")
    _s12_write_json(_s12_dependence(), "dependence.json.gz")
    _s12_write_json(_s12_interactions(), "interactions.json")
    _s12_write_json(_s12_zones(), "zones.json")
free_memory()


# %% [markdown]
# ## 12.9 Metrics, provenance, web models, coupling and districts (SPEC §5.6–§5.8)

# %%
_S12_SCHEME_ORDER = ["block20", "block5", "district", "loeo", "place_time", "random"]


def _s12_metrics_mode(m):
    mr = MODEL_RESULTS[m]
    schemes_present = list(dict.fromkeys(mr["cv_summary"]["scheme"].tolist())) if len(mr["cv_summary"]) else []
    schemes = [s for s in _S12_SCHEME_ORDER if s in schemes_present] + [
        s for s in schemes_present if s not in _S12_SCHEME_ORDER]
    out = {"schemes": schemes, "models": list(CFG.BENCHMARKS),
           "summary": _s12_tree(mr["cv_summary"], 4), "folds": _s12_tree(mr["cv_fold_metrics"], 4)}
    for key in ("block_size_curve", "error_vs_distance", "loeo", "loeo_by_model", "place_time", "moran",
                "moran_target", "fold_geometry", "aoa", "persistent_residual", "v1_comparison", "headline",
                "ablation", "best_rounds", "final_rounds", "frames", "n_train", "district_merges", "monotone"):
        if key in mr:
            out[key] = _s12_tree(mr[key], 4)
    ms = mr.get("moran_scatter") or {}
    out["moran_scatter"] = _s12_tree(ms, 3)
    out["hindcast"] = _s12_tree((globals().get("HINDCAST_METRICS") or {}).get(m), 4)
    if m == "day":
        dlc = globals().get("DAY_LEVEL_CHECK") or {}
        out["cross_sensor"] = {"landsat_vs_modis_terra": _s12_tree(dlc.get("cross_sensor", []), 4)}
        out["day_level_check"] = _s12_tree({k: v for k, v in dlc.items() if k != "cross_sensor"}, 4)
    else:
        nc = globals().get("NIGHT_CALIBRATION") or {}
        out["cross_sensor"] = {k: _s12_tree({kk: vv for kk, vv in v.items() if kk != "by_class"}, 4)
                               for k, v in nc.items() if isinstance(v, dict)}
    return out


def _s12_night_calibration():
    """metrics.night_calibration: SPEC §3.2 keys per kind, plus 'diag' (section 04, gee mode) when available (D19)."""
    nc = globals().get("NIGHT_CALIBRATION")
    diag = globals().get("NIGHT_CALIBRATION_DIAG")
    if not isinstance(nc, dict) or not isinstance(diag, dict):
        return _s12_tree(nc, 4)
    out = {}
    for kind, rec in nc.items():
        if isinstance(rec, dict) and isinstance(diag.get(kind), dict):
            out[kind] = {**_s12_tree(rec, 4), "diag": _s12_tree(diag[kind], 4)}
        else:
            out[kind] = _s12_tree(rec, 4)
    return out


def _s12_metrics():
    cs = {}
    for m in _S12_MODES:
        c = CLIMATE_SENSITIVITY.get(m) or {}
        cs[m] = _s12_tree({k: v for k, v in c.items() if k != "draws"}, 4)
    cmip = globals().get("CMIP6_DELTAS") or {}
    cmip_out = None
    if cmip.get("available"):
        cmip_out = {"baseline_frame": cmip.get("baseline_frame"), "baseline_window": cmip.get("baseline_window"),
                    "observation_window": cmip.get("observation_window"), "frames": cmip.get("frames"),
                    "definition": cmip.get("definition"),
                    "l_base": _s12_tree(cmip.get("l_base"), 4), "scenarios": {}}
        for s, rec in (cmip.get("scenarios") or {}).items():
            cmip_out["scenarios"][s] = {
                "method": rec.get("method"), "n_gcm": rec.get("n_gcm"), "source_scenario": rec.get("source_scenario"),
                "gsat_ratio": _s12_tree(rec.get("gsat_ratio"), 4),
                "variables": {v: {"models": list(d.get("models", [])), "summary": _s12_tree(d.get("summary"), 4)}
                              for v, d in (rec.get("variables") or {}).items()}}
    dm = globals().get("DOWNSCALING_METRICS") or {}
    hw = {"gpus": list(ENV.get("gpu_names") or []), "n_gpus": int(ENV.get("n_gpus") or 0),
          "xgb_device": ENV.get("xgb_device"), "lgbm_device": ENV.get("lgbm_device"),
          "rapids": bool(ENV.get("rapids_used")), "rapids_used": sorted(ENV.get("rapids_used") or []),
          "xgb_version": ENV.get("xgb_version"), "torch_version": str(ENV.get("torch_version") or ""),
          "python": ENV.get("python"), "platform": ENV.get("platform"), "cpu_count": ENV.get("cpu_count"),
          "is_kaggle": bool(ENV.get("is_kaggle"))}
    return {
        "modes": {m: _s12_metrics_mode(m) for m in _S12_MODES},
        "downscaling": _s12_tree(dm, 4),
        "land_model": _s12_tree(globals().get("LAND_MODEL_METRICS"), 4),
        "climate_sensitivity": cs,
        "night_calibration": _s12_night_calibration(),
        "cmip6": cmip_out,
        "projection_meta": _s12_tree({m: {s: {k: v for k, v in pm.items() if k != "shap_group_mean"}
                                              for s, pm in (globals().get("PROJ_META") or {}).get(m, {}).items()}
                                      for m in _S12_MODES}, 4),
        "bootstrap": {m: _s12_tree({k: v for k, v in BOOTSTRAP_INFO.get(m, {}).items() if k != "failures"}, 4)
                      for m in _S12_MODES},
        "hardware": hw,
        "timings": {str(k): round(float(v), 2) for k, v in TIMINGS.items()},
        "profile": CFG.PROFILE, "grid_res_m": int(CFG.GRID_RES_M), "data_mode": DATA_MODE,
    }


def _s12_provenance():
    syn = DATA_MODE == "synthetic"
    tag = " (SYNTHETIC stand-in generated by section 02; the gee run uses this product)" if syn else ""
    src = [
        ("landsat_c2_l2", "Landsat 5/7/8/9 Collection 2 Level-2 (SR + ST)", "LANDSAT/LT05|LE07|LC08|LC09/C02/T1_L2",
         1989, 2026, 30, "day target", ["lst_day", "ndvi", "ndbi", "mndwi", "albedo", "ndvi_spring"],
         "per-path median composites, path-offset harmonised, corrected to 10:45 IST"),
        ("modis_terra_day", "MODIS Terra LST 8-day (MOD11A2 v061)", "MODIS/061/MOD11A2", 2000, 2026, 1000,
         "day validation", ["lst_day_modis", "annual satellite series", "beta (day)"],
         "QC + view-time filtered; drift flagged from 2022"),
        ("modis_aqua_night", "MODIS Aqua LST 8-day (MYD11A2 v061)", "MODIS/061/MYD11A2", 2002, 2021, 1000,
         "night target", ["lst_night 2005-2020", "beta (night)"], "QC bits 0-1 and 6-7 <= 1"),
        ("modis_terra_night", "MODIS Terra LST night (22:30, MOD11A2)", "MODIS/061/MOD11A2", 1999, 2001, 1000,
         "night reconstruction", ["lst_night 2000"], "calibrated to Aqua (NIGHT_CALIBRATION.terra_to_aqua)"),
        ("viirs_night", "VIIRS VNP21A1N daily night LST", "NASA/VIIRS/002/VNP21A1N", 2012, 2026, 1000,
         "night target", ["lst_night 2025"], "calibrated to Aqua (NIGHT_CALIBRATION.viirs_to_aqua)"),
        ("ghsl_built_s", "GHSL built-up surface P2023A", "JRC/GHSL/P2023A/GHS_BUILT_S", 1975, 2030, 100,
         "predictor", ["frac_built"], "fraction of built surface"),
        ("ghsl_built_v", "GHSL built-up volume P2023A", "JRC/GHSL/P2023A/GHS_BUILT_V", 1975, 2030, 100,
         "predictor", ["built_v"], "m3 per m2 ground"),
        ("ghsl_pop", "GHSL population P2023A", "JRC/GHSL/P2023A/GHS_POP", 1975, 2030, 100, "predictor",
         ["log_pop", "projected population"], "persons per km2"),
        ("glc_fcs30d", "GLC_FCS30D land cover", "projects/sat-io/open-datasets/GLC-FCS30D", 1985, 2022, 30,
         "predictor", ["frac_forest", "frac_water", "frac_cropland", "frac_barren", "lm_pd", "lm_ed", "lm_contag"],
         "one product for every frame; 2025 uses the 2022 map"),
        ("srtm", "SRTM 1 arc-second DEM", "USGS/SRTMGL1_003", 2000, 2000, 30, "predictor",
         ["elevation", "slope", "aspect", "elev_tpi7", "elev_tpi21", "elev_std7"], "static"),
        ("jrc_gsw", "JRC Global Surface Water occurrence", "JRC/GSW1_4/GlobalSurfaceWater", 1984, 2021, 30,
         "predictor", ["dist_water", "water_occ"], "static"),
        ("era5_land", "ERA5-Land monthly / daily / hourly", "ECMWF/ERA5_LAND/MONTHLY_AGGR|DAILY_AGGR|HOURLY",
         1989, 2026, 11132, "predictor + annual series",
         ["era5_t2m", "era5_vpd", "era5_swvl1", "era5_evap", "era5_ssr", "era5_wind", "era5_precip_jfm",
          "heating rate", "night level 1990/1995"], "bilinear to the analysis grid"),
        ("gddp_cmip6", "NASA NEX-GDDP-CMIP6", "NASA/GDDP-CMIP6", 1950, 2060, 27830, "projection climate",
         ["tasmax delta (day)", "tasmin delta (night)"], "historical + ssp245/ssp585; ssp126 pattern-scaled"),
        ("chen2020", "Chen et al. 2020 global SSP urban land", "projects/sat-io/open-datasets/FUTURE-URBAN-LAND/"
         "CHEN_2020_2100", 2020, 2100, 1000, "projection land demand", ["urban growth ratios"],
         "SSP1/2/5 mapped to ssp126/245/585"),
        ("iiasa_ssp", "IIASA SSP database v3 (India urban population)", "external table", 2020, 2050, None,
         "projection population", ["population factor"], "national urban population growth factor"),
        ("ar6_gsat", "IPCC AR6 WG1 Table 4.5 assessed GSAT", "publication", 2021, 2100, None,
         "ssp126 pattern scaling", ["gsat_increment"], "interpolated between assessed windows"),
    ]
    sources = [{"id": i, "label": lab, "asset": asset, "start": s0, "end": s1, "resolution_m": res, "role": role,
                "used_for": used, "notes": note + tag} for i, lab, asset, s0, s1, res, role, used, note in src]
    frames = []
    for fr in _S12_TIMELINE_FRAMES:
        for m in _S12_MODES:
            e = fr[m]
            frames.append({"year": fr["year"], "mode": m, "tier": e.get("tier"), "sensor": e.get("sensor"),
                           "window": fr["window"], "scenes": e.get("scenes"), "coverage": e.get("coverage"),
                           "overpass_ist": e.get("overpass_ist")})
    return {"data_mode": DATA_MODE, "sources": sources, "frames": frames, "annotations": _S12_ANNOTATIONS,
            "data_sources": _S12_DATA_SOURCES, "caveats": [str(c) for c in (globals().get("DATA_CAVEATS") or [])]}


def _s12_data_sources():
    out = {}
    for var, vals in DATA_SOURCES.items():
        if isinstance(vals, dict):
            out[str(var)] = {str(k): str(v) for k, v in vals.items()}
        else:
            out[str(var)] = {"all": str(vals)}
    return out


_S12_DATA_SOURCES = _s12_data_sources()
_S12_ANNOTATIONS = [
    {"year": 1999, "label": "Landsat 7 ETM+ joins Landsat 5", "kind": "sensor"},
    {"year": 2003, "label": "Landsat 7 SLC-off", "kind": "sensor"},
    {"year": 2013, "label": "Landsat 8 OLI/TIRS", "kind": "sensor"},
    {"year": 2022, "label": "Terra/Aqua drift; VIIRS bridge", "kind": "sensor"},
]
if _S12_PROJ:
    _S12_ANNOTATIONS.append({"year": _S12_NOW, "label": f"now ({_S12_NOW}); projections beyond are scenario "
                                                       "projections, not forecasts", "kind": "method"})


def _s12_web_model(m):
    model = dict(WEB_MODELS[m])
    if model.get("format") != "lst-xgb-compact-v1":
        raise ValueError(f"12: WEB_MODELS[{m}] has format {model.get('format')!r}")
    if list(model.get("features", [])) != list(FEATURES):
        raise ValueError(f"12: WEB_MODELS[{m}] feature order differs from FEATURES")
    model.setdefault("focal", {"bases": list(FOCAL_SPEC["bases"]), "windows": list(FOCAL_SPEC["windows"])})
    model.setdefault("mode", m)
    return model


def _s12_coupling():
    c = SCENARIO_COUPLING
    out = {k: _s12_tree(v, 6) for k, v in c.items()}
    out["coupling"] = {f: {k: _s12_sig(v, 4) for k, v in d.items()} for f, d in c["coupling"].items()}
    out["intercept"] = {k: _s12_sig(v, 4) for k, v in c.get("intercept", {}).items()}
    out["r2"] = {k: _s12_num(v, 4) for k, v in c.get("r2", {}).items()}
    out["focal"] = {"bases": list(FOCAL_SPEC["bases"]), "windows": [int(w) for w in FOCAL_SPEC["windows"]]}
    out["grid"] = {"width": int(GRID.width), "height": int(GRID.height), "res": int(GRID.res), "crs": GRID.crs,
                   "x0": float(GRID.x0), "y0": float(GRID.y0)}
    return out


def _s12_round_coords(obj):
    if isinstance(obj, dict):
        return {k: _s12_round_coords(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_s12_round_coords(v) for v in obj]
    if isinstance(obj, (float, np.floating)):
        return round(float(obj), 5)
    return obj


def _s12_districts_geojson():
    """BOUNDARY_GEOJSON with 5-dp coordinates and exactly the contract properties (SPEC_v1 §4.8)."""
    feats = []
    for feat in BOUNDARY_GEOJSON["features"]:
        props = feat.get("properties", {})
        feats.append({"type": "Feature", "geometry": _s12_round_coords(feat["geometry"]),
                      "properties": {"id": int(props["id"]), "name": str(props["name"]),
                                     "state": str(props["state"])}})
    return {"type": "FeatureCollection", "features": feats}


with timer("12_small_files"):
    _S12_METRICS = _s12_metrics()
    for _s12_m in _S12_MODES:
        _s12_write_json(_s12_web_model(_s12_m), f"model_web_{_s12_m}.json")
    _s12_write_json(_s12_coupling(), "scenario_coupling.json")
    _S12_DISTRICTS_FC = _s12_districts_geojson()
    _s12_write_json(_S12_DISTRICTS_FC, "districts.geojson")
    _s12_write_json(_s12_provenance(), "provenance.json")


# %% [markdown]
# ## 12.10 Manifest (SPEC §5.3)
# The manifest is the dashboard's table of contents: it declares the study area and grid, both modes, the 47 features
# (with statistics, family, SHAP group and base flag), the 18 groups, the zones of each mode, the districts, every file,
# and the **timeline**: one record per frame (1990–2050) and mode with tier, sensor, overpass, scene count, coverage,
# native resolution, level and level interval, the scenarios, the fixed colour domains, the annotations and the cube
# file names. `files.xai` lists one features file and one SHAP file per mode and frame.

# %%
def _s12_bbox():
    """Lon/lat bounds of the ROI cell squares (corner lattice transformed once; 5 dp)."""
    try:
        from pyproj import Transformer
    except ImportError:
        pip_install(["pyproj"])
        from pyproj import Transformer
    tr = Transformer.from_crs(GRID.crs, "EPSG:4326", always_xy=True)
    r = np.asarray(CELL_ROWS, np.float64)
    c = np.asarray(CELL_COLS, np.float64)
    xs = np.concatenate([GRID.x0 + c * GRID.res, GRID.x0 + (c + 1) * GRID.res] * 2)
    ys = np.concatenate([GRID.y0 - r * GRID.res, GRID.y0 - r * GRID.res, GRID.y0 - (r + 1) * GRID.res,
                         GRID.y0 - (r + 1) * GRID.res])
    lon, lat = tr.transform(xs, ys)
    return [round(float(np.min(lon)), 5), round(float(np.min(lat)), 5), round(float(np.max(lon)), 5),
            round(float(np.max(lat)), 5)]


_S12_BBOX = _s12_bbox()
_S12_MODEL_NOTES = [
    "SHAP values explain the model, not causal effects. Zone recommendations are model-based counterfactuals (the "
    "final model re-evaluated on the zone's cells after a feasible land-cover / NDVI / landscape change, with the "
    "neighbourhood (focal) features recomputed); the cooling they report is associated with the change in the "
    "model, not a causal effect.",
    "Targets are per-frame anomalies (fixed-mask mean removed); absolute degC = anomaly + the frame level of section "
    "09. Day levels are corrected to a 10:45 IST reference overpass; night is in Aqua-equivalent units.",
    "Headline accuracy is pooled out-of-fold R2/RMSE under 20 km block cross-validation (spatial) and leave-one-"
    "epoch-out with recentred predictions (temporal); random CV is an optimistic upper bound.",
    "Night 1990 and 1995 are model hindcasts (tier 'modelled', no satellite product exists); night 2000 is Terra "
    "22:30 calibrated to Aqua (tier 'reconstructed'). Their intervals combine conformal model error and the level "
    "uncertainty.",
    "In-browser scenarios use depth-6 surrogates of the final models (model_web_<mode>.json fidelity) and recompute "
    "the focal features on the grid (FOCAL_SPEC).",
]


def _s12_notes():
    notes = [str(c) for c in (globals().get("DATA_CAVEATS") or [])]
    if DATA_MODE == "synthetic" and not any("SYNTHETIC" in n.upper() for n in notes):
        notes.insert(0, "SYNTHETIC DEMO DATA: generated by the notebook's synthetic world (section 02), not satellite "
                        "observations. Use for software demonstration only.")
    if BOUNDARY_APPROXIMATE and DATA_MODE == "gee":
        notes.append("District boundaries are APPROXIMATE (fallback outline / HQ-point Voronoi); areas per district "
                     "are indicative.")
    notes += _S12_MODEL_NOTES
    for m in _S12_MODES:
        info = BOOTSTRAP_INFO.get(m, {})
        if info.get("replicate_range"):
            notes.append(f"{m}: only {info.get('n')} bootstrap replicates - intervals are a replicate range "
                         "(bias-corrected 2.5-97.5 percentiles), not calibrated 95% confidence intervals.")
    if _S12_PROJ:
        notes.append(f"Frames {_S12_PROJ[0]}-{_S12_PROJ[-1]} are a {_S12_PROJ_NOTE}: CMIP6 temperature deltas x an "
                     "empirical dLST/dTair sensitivity + simulated land change, Monte-Carlo quantiles (GCM, "
                     "sensitivity, land realisation, model error). SSP1-2.6 climate is pattern-scaled from SSP2-4.5.")
    notes += [f"Colour domain: {n}" for n in _S12_DOMAIN_NOTES]
    return notes


def _s12_features_meta():
    out = []
    for f in FEATURES:
        meta = FEATURE_META[f]
        st = FEATURE_STATS.get(f, {})
        out.append({"name": f, "label": meta["label"], "unit": meta["unit"], "group": meta["group"],
                    "family": meta["family"], "base": bool(meta["base"]), "description": meta["description"],
                    "source": meta["source"], "actionable": bool(meta["actionable"]), "display": meta["display"],
                    "stats": {k: _s12_sig(st.get(k)) for k in ("min", "max", "p01", "p99", "median", "mean", "std")}
                    | {"missing": _s12_num(st.get("missing"), 5)}})
    return out


def _s12_manifest_zones(m):
    """manifest.zones[m]: the canonical zones (_S12_ZONE_META order, ids/names/colours) + the D11 display fields."""
    prof = {int(p["id"]): p for p in (globals().get("ZONE_PROFILES") or {}).get(m, [])}
    out = []
    for z in _S12_ZONE_META:
        p = prof.get(int(z["id"])) or {}
        out.append({**z, "display_name": str(p.get("display_name") or z["name"]),
                    "label_caveat": p.get("label_caveat")})
    return out


def _s12_manifest():
    files_xai = {m: {str(y): {"features": f"xai_{y}_features.lstb.gz", "shap": f"xai_{y}_{m}.lstb.gz"}
                     for y in XAI_FRAMES.get(m, [])} for m in _S12_MODES}
    cubes = {f"obs_{m}": f"cube_obs_{m}.lstb.gz" for m in _S12_MODES}
    for m in _S12_MODES:
        for s in _S12_SCEN:
            cubes[f"{s}_{m}"] = f"cube_{s}_{m}.lstb.gz"
        cubes[f"zones_{m}"] = f"cube_zones_{m}.lstb.gz"
    has_raster = ((_S12_WEB / "raster_index.json").is_file()
                  and bool((globals().get("RASTER_INDEX") or {}).get("frames")))
    scenarios = []
    for s in _S12_SCEN:
        rec = CMIP6_DELTAS["scenarios"].get(s, {})
        scenarios.append({"id": s, "label": _S12_SCEN_LABEL.get(s, s), "method": rec.get("method", "gcm"),
                          "n_gcm": int(rec.get("n_gcm") or 0),
                          "source_scenario": rec.get("source_scenario")})
    roi_prov = DATA_SOURCES.get("roi")
    roi_sources = sorted({str(v) for v in roi_prov.values()}) if isinstance(roi_prov, dict) else []
    shap_base = {m: round(float(SHAP_BASE[m]), 4) for m in _S12_MODES}
    return {
        "schema_version": "2.0",
        "generated_at": _s12_dt.datetime.now(_s12_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "generator": {"notebook": "delhi_ncr_lst_pipeline", "export": _S12_VERSION, "profile": CFG.PROFILE},
        "data_mode": DATA_MODE,
        "data_mode_reason": str(globals().get("DATA_MODE_REASON") or "") or None,
        "study_area": {"name": "Delhi NCR", "area_km2": round(_S12_NC * _S12_CELL_KM2, 1), "crs": CFG.CRS,
                       "grid_res_m": int(CFG.GRID_RES_M), "fine_res_m": int(CFG.grid_fine_res()),
                       "grid": {"crs": GRID.crs, "res": int(GRID.res), "x0": float(GRID.x0), "y0": float(GRID.y0),
                                "width": int(GRID.width), "height": int(GRID.height)},
                       "n_cells": _S12_NC, "bbox": _S12_BBOX,
                       "center": [round(0.5 * (_S12_BBOX[0] + _S12_BBOX[2]), 5),
                                  round(0.5 * (_S12_BBOX[1] + _S12_BBOX[3]), 5)],
                       "boundary_approximate": bool(BOUNDARY_APPROXIMATE),
                       "boundary_source": "; ".join(roi_sources) or None},
        "season": list(CFG.SEASON),
        "target_mode": "anomaly",
        "modes": [{"id": m, **{k: _S12_MODE_INFO[m][k] for k in ("label", "target", "ramp")},
                   "reference_overpass_ist": _S12_MODE_INFO[m]["reference_overpass_ist"]} for m in _S12_MODES],
        "features": _s12_features_meta(),
        "focal": {"bases": list(FOCAL_SPEC["bases"]), "windows": [int(w) for w in FOCAL_SPEC["windows"]]},
        "groups": [{"id": g, "label": GROUP_META[g]["label"], "primary": GROUP_META[g]["primary"],
                    "family": GROUP_META[g]["family"], "actionable": bool(GROUP_META[g]["actionable"]),
                    "members": list(SHAP_GROUPS[g])} for g in _S12_GROUPS],
        "zones": {m: _s12_manifest_zones(m) for m in _S12_MODES},
        "districts": [{"id": int(d["id"]), "name": d["name"], "state": d["state"]} for d in DISTRICTS],
        "shap_base": shap_base,
        "timeline": {
            "now": int(CFG.NOW), "harmonised": True, "reference_period": list(CFG.REFERENCE_PERIOD),
            "frames": _S12_TIMELINE_FRAMES, "scenarios": scenarios,
            "domains": {**{m: {k: _S12_DOMAINS[m][k] for k in ("abs", "anom", "suhi")} for m in _S12_MODES},
                        **({"dtr": _S12_DOMAINS["dtr"]} if "dtr" in _S12_DOMAINS else {}),
                        "spread": _S12_DOMAINS["spread"]},
            "annotations": _S12_ANNOTATIONS, "tiers": list(_S12_TIERS), "cubes": cubes,
            "raster_index": "raster_index.json" if has_raster else None,
        },
        "files": {"cells": "cells.lstb.gz", "series": "timeline_series.json.gz", "xai": files_xai,
                  "model": {m: f"model_web_{m}.json" for m in _S12_MODES}, "shap_global": "shap_global.json",
                  "dependence": "dependence.json.gz", "zones": "zones.json", "metrics": "metrics.json",
                  "interactions": "interactions.json", "coupling": "scenario_coupling.json",
                  "districts": "districts.geojson", "provenance": "provenance.json",
                  **({"raster_index": "raster_index.json"} if has_raster else {})},
        "data_sources": _S12_DATA_SOURCES,
        "notes": _s12_notes(),
        "bootstrap": {m: _s12_tree({k: v for k, v in BOOTSTRAP_INFO.get(m, {}).items()
                                    if k in ("n", "n_requested", "mode", "block_size_km", "n_blocks",
                                             "block_size_source", "ci_level", "ci_method", "ci_method_description",
                                             "ci_label", "replicate_range", "full_data", "rounds")}, 4)
                      for m in _S12_MODES},
        "synthetic_truth": _s12_tree(SYNTHETIC_TRUTH, 6) if DATA_MODE == "synthetic" else None,
    }


with timer("12_manifest"):
    EXPORT_MANIFEST = _s12_manifest()
    _s12_write_json(_S12_METRICS, "metrics.json")
    _s12_write_json(EXPORT_MANIFEST, "manifest.json")
    if EXPORT_MANIFEST["timeline"]["raster_index"]:
        _S12_SIZES["raster_index.json"] = (_S12_WEB / "raster_index.json").stat().st_size
        for _s12_fr in RASTER_INDEX["frames"].values():
            for _s12_k in ("file", "preview"):
                _s12_p = _S12_WEB / _s12_fr[_s12_k]
                if not _s12_p.is_file():
                    raise FileNotFoundError(f"12: raster {_s12_p} referenced by raster_index.json is missing")
                _S12_SIZES[_s12_fr[_s12_k]] = _s12_p.stat().st_size


def _s12_clear_stale():
    """Remove bundle files of earlier exports that this export did not write (never touches the cache)."""
    keep = set(_S12_SIZES)
    removed = []
    for p in sorted(_S12_WEB.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(_S12_WEB).as_posix()
        if rel in keep:
            continue
        if rel.endswith((".json", ".json.gz", ".lstb.gz", ".lstb", ".geojson", ".png", ".tmp")):
            p.unlink()
            removed.append(rel)
    if removed:
        log(f"12: removed {len(removed)} stale bundle file(s): {removed[:8]}{' ...' if len(removed) > 8 else ''}")
    return removed


_s12_clear_stale()
_S12_BUNDLE_BYTES = sum(_S12_SIZES.values())
log(f"12: web bundle written: {len(_S12_SIZES)} files, {_S12_BUNDLE_BYTES / 1e6:.2f} MB on disk")

# %% [markdown]
# ## 12.11 Read-back validation of the written bundle
# Everything below re-reads the files from disk (no in-memory shortcut) and fails the section on any contract
# violation. `lstb_parse` gives the raw integers so dtypes, nodata codes and scales are checked exactly.

# %%
def _s12_reject_constant(token):
    raise ValueError(f"non-JSON constant {token!r}")


def _s12_load(name):
    raw = (_S12_WEB / name).read_bytes()
    if raw[:2] == b"\x1f\x8b":
        raw = _s12_gzip.decompress(raw)
    return _s12_json.loads(raw.decode("utf-8"), parse_constant=_s12_reject_constant)


def _s12_decode(col, raw):
    v = raw.astype(np.float64) * float(col["scale"]) + float(col["offset"])
    if col.get("nodata") is not None:
        v[raw == col["nodata"]] = np.nan
    return v


def _s12_check_bundle():
    errors = []

    def req(cond, msg):
        if not cond:
            errors.append(msg)
        return bool(cond)

    man = _s12_load("manifest.json")
    req(man["schema_version"] == "2.0", "manifest.schema_version != 2.0")
    tl = man["timeline"]
    obs_years = [f["year"] for f in tl["frames"] if f["kind"] == "observed"]
    proj_years = [f["year"] for f in tl["frames"] if f["kind"] == "projected"]
    req(obs_years == _S12_OBS and proj_years == _S12_PROJ, "manifest frame lists differ from the pipeline frames")
    tiers = {m: [f[m]["tier"] for f in tl["frames"] if f["kind"] == "observed"] for m in _S12_MODES}
    levels = {m: [f[m]["level"] for f in tl["frames"] if f["kind"] == "observed"] for m in _S12_MODES}
    # every referenced file exists
    names = [man["files"][k] for k in ("cells", "series", "shap_global", "dependence", "zones", "metrics",
                                       "interactions", "coupling", "districts", "provenance")]
    names += list(man["files"]["model"].values()) + list(tl["cubes"].values())
    names += [v for m in man["files"]["xai"].values() for d in m.values() for v in d.values()]
    for nm in names:
        req((_S12_WEB / nm).is_file(), f"missing file {nm}")
    if errors:
        return errors
    for nm in names:
        if nm.endswith((".json", ".json.gz", ".geojson")):
            try:
                _s12_load(nm)
            except ValueError as exc:
                errors.append(f"{nm}: not strict JSON ({exc})")
    # cells
    h, raws = lstb_parse((_S12_WEB / "cells.lstb.gz").read_bytes())
    req(h["kind"] == "cells" and h["n"] == _S12_NC, "cells: kind/n")
    dt = {c["name"]: c["dtype"] for c in h["columns"]}
    req(dt == {"cell_id": "int32", "row": "int16", "col": "int16", "lon": "float32", "lat": "float32",
               "district": "int16"}, f"cells: dtypes {dt}")
    req(np.array_equal(raws["cell_id"], np.asarray(CELL_IDS, np.int32)), "cells: cell_id differs from CELL_IDS")
    W = man["study_area"]["grid"]["width"]
    req(np.array_equal(raws["row"].astype(np.int64) * W + raws["col"], raws["cell_id"].astype(np.int64)),
        "cells: cell_id != row * W + col")
    # cubes
    cube_lst, cube_zones = {}, {}
    for key, nm in tl["cubes"].items():
        h, raws = lstb_parse((_S12_WEB / nm).read_bytes())
        req(h["n"] == _S12_NC, f"{nm}: n {h['n']} != {_S12_NC}")
        cols = {c["name"]: c for c in h["columns"]}
        if key.startswith("zones_"):
            req(h["kind"] == "zones", f"{nm}: kind")
            cube_zones[h["meta"]["mode"]] = raws["obs"]
            req([{k: z.get(k) for k in ("id", "name", "color")} for z in h["meta"]["zones"]] == _S12_ZONE_META,
                f"{nm}: meta.zones must be the canonical zones")
            for name, c in cols.items():
                F = len(_S12_OBS) if name == "obs" else len(_S12_PROJ)
                req(c["dtype"] == "uint8" and c["shape"] == [F, _S12_NC] and c["nodata"] == 255,
                    f"{nm}.{name}: dtype/shape/nodata")
                bad = ~np.isin(raws[name], [0, 1, 2, 3, 255])
                req(not bad.any(), f"{nm}.{name}: {int(bad.sum())} values outside {{0..3, 255}}")
            continue
        req(h["kind"] == "cube", f"{nm}: kind")
        mode = h["meta"]["mode"]
        main = "lst" if key.startswith("obs_") else "p50"
        F = len(_S12_OBS) if main == "lst" else len(_S12_PROJ)
        req(h["meta"]["frames"] == (_S12_OBS if main == "lst" else _S12_PROJ), f"{nm}: meta.frames")
        c = cols[main]
        req(c["dtype"] == "int16" and abs(c["scale"] - _S12_LST_SCALE) < 1e-12 and c["nodata"] == _S12_I16_NODATA
            and c["shape"] == [F, _S12_NC], f"{nm}.{main}: dtype/scale/nodata/shape")
        for name, cc in cols.items():
            if name.endswith("_off"):
                req(cc["dtype"] == "uint8" and abs(cc["scale"] - _S12_OFF_SCALE) < 1e-12
                    and cc["shape"] == [F, _S12_NC], f"{nm}.{name}: dtype/scale/shape")
        vals = _s12_decode(c, raws[main])
        if main == "lst":
            cube_lst[mode] = vals
            req(h["meta"]["tiers"] == tiers[mode], f"{nm}: meta.tiers != manifest")
            req(all(a is None or b is None or abs(a - b) <= 0.011
                    for a, b in zip(h["meta"]["levels"], levels[mode])), f"{nm}: meta.levels != manifest")
            for j, y in enumerate(_S12_OBS):
                ref = _s12_frame_field(mode, y)
                same_nan = np.array_equal(np.isnan(vals[j]), ~np.isfinite(ref))
                fin = np.isfinite(ref)
                diff = float(np.max(np.abs(vals[j][fin] - ref[fin]))) if fin.any() else 0.0
                req(same_nan and diff <= _S12_LST_SCALE / 2 + 1e-6, f"{nm} frame {y}: decoded field differs "
                                                                    f"(max {diff:.4f} °C, NaN pattern {same_nan})")
                if tiers[mode][j] == "observed":
                    req(not raws["p05_off"][j].any() and not raws["p95_off"][j].any(),
                        f"{nm} frame {y}: observed frame with non-zero uncertainty offsets")
            req(set(np.unique(raws["aoa_out"]).tolist()) <= {0, 1}, f"{nm}: aoa_out not 0/1")
        else:
            scen = h["meta"]["scenario"]
            ref = np.asarray(PROJ_QUANTILES[mode][scen]["p50"], np.float64)
            fin = np.isfinite(ref)
            req(float(np.max(np.abs(vals[fin] - ref[fin]))) <= _S12_LST_SCALE / 2 + 1e-6, f"{nm}: p50 differs")
            req(np.array_equal(raws["flags"], np.asarray(PROJ_FLAGS[mode][scen], np.uint8)), f"{nm}: flags differ")
            for qk in ("p05", "p95"):
                sign = -1 if qk == "p05" else 1
                q = vals + sign * raws[f"{qk}_off"].astype(np.float64) * _S12_OFF_SCALE
                refq = np.asarray(PROJ_QUANTILES[mode][scen][qk], np.float64)
                ok = fin & np.isfinite(refq) & (np.abs(refq - ref) < 12.7)
                d = float(np.max(np.abs(q[ok] - refq[ok]))) if ok.any() else 0.0
                req(d <= _S12_OFF_SCALE / 2 + _S12_LST_SCALE / 2 + 1e-6, f"{nm}: {qk} decodes {d:.3f} °C off")
    # XAI frames: waterfall invariant on every row
    for m, by_year in man["files"]["xai"].items():
        for y, fn in by_year.items():
            h, raws = lstb_parse((_S12_WEB / fn["shap"]).read_bytes())
            cols = {c["name"]: c for c in h["columns"]}
            req(h["kind"] == "xai" and h["n"] == _S12_NC and h["meta"]["groups"] == _S12_GROUPS,
                f"{fn['shap']}: kind/n/groups")
            shap = np.stack([_s12_decode(cols[g], raws[g]) for g in _S12_GROUPS], axis=1)
            pred = _s12_decode(cols["pred"], raws["pred"])
            ok = np.isfinite(shap).all(axis=1) & np.isfinite(pred)
            err = np.abs(pred[ok] - (h["meta"]["base_value_c"] + shap[ok].sum(axis=1)))
            req(ok.any() and float(err.max()) <= _S12_WATERFALL_TOL_C,
                f"{fn['shap']}: waterfall invariant violated (max {float(err.max()) if err.size else -1:.3f})")
            req(h["meta"]["tier"] == tiers[m][_S12_OBS.index(int(y))], f"{fn['shap']}: meta.tier != manifest")
            # cross-file alignment (C-01): XAI obs vs cube field, pred vs obs, zone cube vs nearest centroid
            j = _S12_OBS.index(int(y))
            obs = _s12_decode(cols["obs"], raws["obs"])
            if m in cube_lst and tiers[m][j] in ("observed", "observed-sparse", "reconstructed"):
                f = cube_lst[m][j]
                cc = float(h["meta"].get("composition_correction") or 0.0)
                both = np.isfinite(obs) & np.isfinite(f)
                dmax = float(np.max(np.abs(obs[both] - cc - f[both]))) if both.any() else 0.0
                same_nan = bool(np.array_equal(np.isfinite(obs), np.isfinite(f)))
                req(dmax <= 0.011 and same_nan, f"{fn['shap']}: obs vs cube_obs_{m} frame {y}: max {dmax:.3f} °C "
                                                f"(composition correction {cc:+.3f}), same NaN {same_nan}")
            okp = np.isfinite(pred) & np.isfinite(obs)
            if okp.sum() >= 100 and pred[okp].std() > 0 and obs[okp].std() > 0:
                rho = float(np.corrcoef(pred[okp], obs[okp])[0, 1])
                floor = _S12_CORR_MIN.get(tiers[m][j], 0.5)
                req(rho >= floor, f"{fn['shap']}: corr(pred, obs) {rho:.3f} < {floor} (row misalignment?)")
                if floor <= rho < 0.5:
                    log(f"12: note: {m} {y} is a {tiers[m][j]} frame the model never trained on; its prediction "
                        f"agrees only weakly with those observations (corr {rho:.3f})")
            if m in cube_zones and m in ZONE_MODEL:
                rows = np.isfinite(shap).all(axis=1)
                if rows.sum() >= 100:
                    cen = np.round(np.asarray(ZONE_MODEL[m]["centroids"], np.float64), 4)
                    near = np.argmin(((shap[rows][:, None, :] - cen[None]) ** 2).sum(axis=-1), axis=1)
                    agree = float(np.mean(near == cube_zones[m][j][rows].astype(np.int64)))
                    req(agree >= 0.99, f"{fn['shap']}: nearest-centroid zones agree with cube_zones_{m} frame {y} "
                                       f"on {100 * agree:.1f} % of rows (< 99 %)")
            hf, _ = lstb_parse((_S12_WEB / fn["features"]).read_bytes())
            req(hf["kind"] == "features" and [c["name"] for c in hf["columns"]] == list(BASE_FEATURES)
                and all(c["dtype"] == "int16" for c in hf["columns"]), f"{fn['features']}: columns")
    # series
    ser = _s12_load(man["files"]["series"])
    req("ncr" in ser["series"] and all(m in ser["series"]["ncr"] for m in _S12_MODES), "series: ncr scope")
    for m in _S12_MODES:
        fr = ser["series"]["ncr"][m]["frames"]
        req([r["year"] for r in fr] == _S12_OBS and [r["tier"] for r in fr] == tiers[m],
            f"series ncr.{m}: frame years/tiers differ from the manifest")
    bad_cov = [(sid, m, r["year"]) for sid, by_m in ser["series"].items() for m, e in by_m.items()
               for r in e["frames"] if r.get("coverage") is not None and not 0.0 <= r["coverage"] <= 1.0]
    req(not bad_cov, f"series: frame coverage outside [0, 1] for {bad_cov[:5]}")
    # zones: canonical id/name/colour + D11 display fields, in zones.json and in the manifest
    zj = _s12_load(man["files"]["zones"])
    for m in _S12_MODES:
        for where, zl in (("zones.json", zj["modes"][m]["zones"]), ("manifest", man["zones"][m])):
            req([{k: z.get(k) for k in ("id", "name", "color")} for z in zl] == _S12_ZONE_META,
                f"{where} {m}: zones must be the canonical ids/names/colours")
            req(all(isinstance(z.get("display_name"), str) and z["display_name"].strip() for z in zl)
                and all(z.get("label_caveat") is None or isinstance(z["label_caveat"], str) for z in zl),
                f"{where} {m}: display_name must be a non-empty string and label_caveat a string or null")
    # raster index
    if tl.get("raster_index"):
        ri = _s12_load(tl["raster_index"])
        expected = {f"{m}_{f['year']}" for f in tl["frames"] for m in _S12_MODES if f["raster"][m]}
        req(set(ri["frames"]) == expected, "raster_index frames != manifest raster flags")
        for fr in ri["frames"].values():
            for k in ("file", "preview"):
                req((_S12_WEB / fr[k]).is_file(), f"raster file {fr[k]} missing")
    return errors


def _s12_find_validator():
    """Locate the repository's standalone validate_bundle.py (local checkout or an attached Kaggle dataset)."""
    cands = []
    env = _s12_os.environ.get("LST_VALIDATOR")
    if env:
        cands.append(Path(env))
    cwd = Path.cwd()
    cands += [cwd / "notebook" / "validate_bundle.py", cwd / "validate_bundle.py",
              cwd.parent / "notebook" / "validate_bundle.py"]
    kin = Path("/kaggle/input")
    if kin.is_dir():               # /kaggle/input/<slug>/... or /kaggle/input/datasets/<owner>/<slug>/lst_code/...
        for depth in range(1, 6):
            cands += sorted(kin.glob("*/" * depth + "validate_bundle.py"))
    for c in cands:
        if c.is_file():
            return c
    return None


with timer("12_validate"):
    _S12_ERRORS = _s12_check_bundle()
    if _S12_ERRORS:
        raise ValueError(f"12: web bundle invalid ({len(_S12_ERRORS)} problems):\n  - " + "\n  - ".join(_S12_ERRORS))
    log(f"12: read-back validation OK ({len(_S12_SIZES)} files)")
    _S12_VALIDATOR = _s12_find_validator()
    _S12_VALIDATOR_RESULT = None
    if _S12_VALIDATOR is not None:
        try:
            # The validator always ends with a verdict line ("VALID: ...", "INVALID (n errors): ..." or "BUNDLE
            # UNREADABLE: ..."). A non-zero exit WITHOUT one means the child process never got to judge the bundle
            # (e.g. it could not start under memory pressure at the end of a long run): retry once, then warn as for
            # a timeout - the bundle already passed the in-notebook checks. Only a real verdict can fail the run.
            for _s12_attempt in (1, 2):
                _s12_proc = _s12_subprocess.run([_s12_sys.executable, str(_S12_VALIDATOR), str(_S12_WEB), "--quiet"],
                                                capture_output=True, text=True, timeout=1800,
                                                env={**_s12_os.environ, "PYTHONIOENCODING": "utf-8"})
                _s12_out, _s12_err = _s12_proc.stdout or "", _s12_proc.stderr or ""
                _s12_verdict = any(ln.startswith(("VALID:", "INVALID (", "BUNDLE UNREADABLE:"))
                                   for ln in _s12_out.splitlines())
                if _s12_proc.returncode == 0 or _s12_verdict:
                    break
                log(f"12: standalone validator exited {_s12_proc.returncode} ({_s12_proc.returncode & 0xFFFFFFFF:#x}) "
                    f"without a verdict (attempt {_s12_attempt}/2); stderr: {_s12_err[-1000:].strip() or '-'}",
                    "WARNING")
            _S12_VALIDATOR_RESULT = {"path": str(_S12_VALIDATOR), "returncode": _s12_proc.returncode,
                                     "verdict": _s12_verdict, "output": _s12_out[-4000:]}
            print(_s12_out[-4000:])
            if _s12_proc.returncode != 0 and _s12_verdict:
                raise ValueError(f"12: standalone validator reported the bundle INVALID (exit {_s12_proc.returncode}):"
                                 f"\n{_s12_out[-4000:]}\n{_s12_err[-2000:]}")
            if _s12_proc.returncode != 0:
                log(f"12: standalone validator could not run (exit {_s12_proc.returncode}, no verdict twice); the "
                    "bundle passed the in-notebook checks - run notebook/validate_bundle.py on it", "WARNING")
            else:
                log(f"12: standalone validator {_S12_VALIDATOR.name}: VALID")
        except _s12_subprocess.TimeoutExpired:
            log("12: standalone validator timed out (bundle already passed the in-notebook checks)", "WARNING")
    else:
        log("12: standalone validate_bundle.py not found (attach it or run it on the downloaded bundle); the "
            "in-notebook read-back checks passed")

# %% [markdown]
# ## 12.12 Parquet tables, GeoJSON cells, fine-field NPZ and native models
# Analysis-ready copies of the per-cell products (zstd Parquet, one row per cell × frame), polygons of the analysis
# cells with their zone and LST per observed frame (RFC 7946, counter-clockwise rings, shared vertices from one
# transformed corner lattice), the 250 m fields as compressed NPZ with their UTM grid, and the native final boosters.

# %%
def _s12_to_parquet(df, name):
    path = _S12_PARQUET / name
    df.to_parquet(path, engine="pyarrow", compression="zstd", index=False)
    log(f"  parquet/{name}: {len(df):,} rows, {path.stat().st_size / 1e6:.2f} MB")
    return path


def _s12_parquet():
    if not (_S12_PARQUET / "features_long.parquet").is_file():
        _s12_to_parquet(DF, "features_long.parquet")
    base = pd.DataFrame({"cell_id": np.asarray(CELL_IDS, np.int32), "row": np.asarray(CELL_ROWS, np.int32),
                         "col": np.asarray(CELL_COLS, np.int32), "lon": np.asarray(CELL_LON, np.float64),
                         "lat": np.asarray(CELL_LAT, np.float64), "district": _S12_DISTRICT_OF_CELL})
    for m in _S12_MODES:
        parts = []
        for y in _S12_OBS:
            lev, _ = _s12_level(m, y)
            lev = float(lev) if lev is not None else np.nan
            d = base.copy()
            d["year"] = np.int16(y)
            d["tier"] = _s12_tier(m, y)
            d["lst"] = _s12_frame_field(m, y).astype(np.float32)
            unc = (globals().get("FRAME_UNC") or {}).get(m, {}).get(y)
            for qk in ("p05", "p95"):
                d[f"lst_{qk}"] = (np.asarray(unc[qk], np.float32) if unc is not None
                                  else np.full(_S12_NC, np.nan, np.float32))
            a = (globals().get("FRAME_AOA_OUT") or {}).get(m, {}).get(y)
            d["aoa_out"] = np.asarray(a, bool) if a is not None else False
            if y in (PRED_ANOM.get(m) or {}):
                d["lst_pred"] = (np.asarray(PRED_ANOM[m][y], np.float64) + lev).astype(np.float32)
                d["lst_pred_oof"] = (np.asarray(OOF_ANOM[m][y], np.float64) + lev).astype(np.float32)
                d["zone"] = np.asarray(ZONES_OBS[m][y], np.uint8)
                g = np.asarray(SHAP_GROUP_VALUES[m][y], np.float32)
                for gi, gname in enumerate(_S12_GROUPS):
                    d[f"shap_{gname}"] = g[:, gi]
            parts.append(d)
        _s12_to_parquet(pd.concat(parts, ignore_index=True), f"predictions_{m}.parquet")
        del parts
        if _S12_SCEN:
            pparts = []
            for s in _S12_SCEN:
                q = PROJ_QUANTILES[m][s]
                for j, y in enumerate(_S12_PROJ):
                    d = base[["cell_id", "district"]].copy()
                    d["scenario"] = s
                    d["year"] = np.int16(y)
                    for k in ("p05", "p25", "p50", "p75", "p95"):
                        d[k] = np.asarray(q[k][j], np.float32)
                    d["flags"] = np.asarray(PROJ_FLAGS[m][s][j], np.uint8)
                    d["zone"] = np.asarray(PROJ_ZONES[m][s][j], np.uint8)
                    pparts.append(d)
            _s12_to_parquet(pd.concat(pparts, ignore_index=True), f"projections_{m}.parquet")
            del pparts
    lev_rows = []
    for m in _S12_MODES:
        for y in _S12_OBS:
            rec = LEVELS[m].get(y) or {}
            ci = rec.get("ci") or [None, None]
            lev_rows.append({"mode": m, "year": y, "tier": _s12_tier(m, y), "level": rec.get("level"),
                             "ci_lo": ci[0], "ci_hi": ci[1], "raw_level": rec.get("raw_level"),
                             "overpass_correction": rec.get("overpass_correction"), "method": rec.get("method")})
    _s12_to_parquet(pd.DataFrame(lev_rows), "levels.parquet")
    sf_rows = []
    for m in _S12_MODES:
        for scope, rows in SERIES_FRAMES[m].items():
            for r in rows:
                ci = r.get("ci") or [None, None]
                sf_rows.append({"mode": m, "scope": scope, "year": r["year"], "mean": r.get("mean"),
                                "ci_lo": ci[0], "ci_hi": ci[1], "p90": r.get("p90"),
                                "hot_core_km2": r.get("hot_core_km2"), "uhi": r.get("uhi"),
                                "n_cells": r.get("n_cells"), "tier": r.get("tier")})
    _s12_to_parquet(pd.DataFrame(sf_rows), "series_frames.parquet")
    _s12_to_parquet(ANNUAL_SERIES.astype({"flag": "object"}), "annual_series.parquet")
    imp_rows = []
    for m in _S12_MODES:
        g = IMPORTANCE[m]["global"]
        for gi, gname in enumerate(IMPORTANCE[m]["groups"]):
            imp_rows.append({"mode": m, "group": gname, "mean_abs": float(g["mean_abs"][gi]),
                             "ci_lo": float(g["ci_lo"][gi]), "ci_hi": float(g["ci_hi"][gi]),
                             "bias": float(g["bias"][gi])})
    _s12_to_parquet(pd.DataFrame(imp_rows), "importance.parquet")


def _s12_corner_lonlat():
    from pyproj import Transformer
    xs = GRID.x0 + np.arange(GRID.width + 1) * GRID.res
    ys = GRID.y0 - np.arange(GRID.height + 1) * GRID.res
    XX, YY = np.meshgrid(xs, ys)
    lon, lat = Transformer.from_crs(GRID.crs, "EPSG:4326", always_xy=True).transform(XX, YY)
    return np.round(lon, 5), np.round(lat, 5)


def _s12_zone_geojson(mode, lon_c, lat_c):
    """One FeatureCollection of all ROI cell squares with zone_<year> / lst_<year> properties of the mode."""
    r = np.asarray(CELL_ROWS, np.int64)
    c = np.asarray(CELL_COLS, np.int64)
    zones = {y: np.asarray(ZONES_OBS[mode][y]) for y in _S12_OBS if y in ZONES_OBS.get(mode, {})}
    lst = {y: np.round(_s12_frame_field(mode, y), 2) for y in _S12_OBS}
    path = _S12_GEO / f"zones_{mode}.geojson"
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write('{"type":"FeatureCollection","features":[')
        for i in range(_S12_NC):
            # bottom-left -> bottom-right -> top-right -> top-left -> close (counter-clockwise; row 0 is north)
            corners = [(r[i] + 1, c[i]), (r[i] + 1, c[i] + 1), (r[i], c[i] + 1), (r[i], c[i]), (r[i] + 1, c[i])]
            ring = [[float(lon_c[a, b]), float(lat_c[a, b])] for a, b in corners]
            props = {"cell_id": int(CELL_IDS[i]), "district": int(_S12_DISTRICT_OF_CELL[i])}
            for y in _S12_OBS:
                if y in zones:
                    props[f"zone_{y}"] = None if zones[y][i] > 3 else int(zones[y][i])
                v = lst[y][i]
                props[f"lst_{y}"] = float(v) if np.isfinite(v) else None
            feat = {"type": "Feature", "geometry": {"type": "Polygon", "coordinates": [ring]}, "properties": props}
            fh.write(("," if i else "") + _s12_json.dumps(feat, separators=(",", ":"), allow_nan=False))
        fh.write("]}")
    _s12_os.replace(tmp, path)
    log(f"  geo/{path.name}: {_S12_NC:,} cells, {path.stat().st_size / 1e6:.1f} MB")
    return path


def _s12_npz():
    for m in _S12_MODES:
        ff = (globals().get("FINE_FIELDS") or {}).get(m) or {}
        if not ff:
            continue
        years = sorted(int(y) for y in ff)
        arrays = {f"lst_{y}": np.asarray(ff[y], np.float32) for y in years}
        arrays.update({f"flags_{y}": np.asarray(FINE_FLAGS[m][y], np.uint8) for y in years
                       if y in (globals().get("FINE_FLAGS") or {}).get(m, {})})
        arrays["grid"] = np.array([GRID_FINE.x0, GRID_FINE.y0, GRID_FINE.res, GRID_FINE.width, GRID_FINE.height],
                                  np.float64)
        arrays["years"] = np.asarray(years, np.int32)
        path = _S12_NPZ / f"fine_fields_{m}.npz"
        np.savez_compressed(path, **arrays)
        log(f"  npz/{path.name}: {len(years)} frames {GRID_FINE.height}x{GRID_FINE.width} "
            f"({GRID_FINE.res} m, {GRID_FINE.crs}; grid = [x0, y0, res, width, height]), "
            f"{path.stat().st_size / 1e6:.1f} MB")


def _s12_models():
    for m in _S12_MODES:
        path = _S12_MODEL_DIR / f"xgb_final_{m}.json"
        if not path.is_file() and m in FINAL_MODELS:
            FINAL_MODELS[m].save_model(str(path))
        if path.is_file():
            log(f"  models/{path.name}: {path.stat().st_size / 1e6:.2f} MB")


with timer("12_parquet"):
    _s12_parquet()
free_memory()
with timer("12_geojson"):
    save_json(_S12_DISTRICTS_FC, _S12_GEO / "ncr_districts.geojson")
    _S12_LON_C, _S12_LAT_C = _s12_corner_lonlat()
    for _s12_m in _S12_MODES:
        _s12_zone_geojson(_s12_m, _S12_LON_C, _S12_LAT_C)
    del _S12_LON_C, _S12_LAT_C
with timer("12_npz_models"):
    _s12_npz()
    _s12_models()
free_memory()

# %% [markdown]
# ## 12.13 Overview figure (decoded from the written files), zip, output tree and run summary
# The figure is drawn from the **files on disk** (cube and series decoded again), so it doubles as a visual check that
# the dashboard will see what the pipeline computed: the current-frame day and night maps and the NCR timeline with
# the observed levels and the SSP fans.

# %%
def _s12_fig_overview():
    man = EXPORT_MANIFEST
    ser = _s12_load(man["files"]["series"])
    fig, axes = plt.subplots(1, len(_S12_MODES) + 1, figsize=(6 * (len(_S12_MODES) + 1), 5))
    for k, m in enumerate(_S12_MODES):
        h, raws = lstb_parse((_S12_WEB / man["timeline"]["cubes"][f"obs_{m}"]).read_bytes())
        col = next(c for c in h["columns"] if c["name"] == "lst")
        v = _s12_decode(col, raws["lst"])[_S12_OBS.index(_S12_NOW)]
        img = np.full((GRID.height, GRID.width), np.nan)
        img[CELL_ROWS, CELL_COLS] = v
        lo, hi = man["timeline"]["domains"][m]["abs"]
        im = axes[k].imshow(img, cmap="inferno" if m == "day" else "magma", vmin=lo, vmax=hi)
        axes[k].set_title(f"{m} {_S12_NOW} (decoded cube, fixed domain {lo:g}-{hi:g} °C)")
        axes[k].axis("off")
        fig.colorbar(im, ax=axes[k], shrink=0.75, label="LST °C")
    ax = axes[-1]
    for m, color in zip(_S12_MODES, ("#f97316", "#6366f1")):
        e = ser["series"]["ncr"][m]
        yrs = [r["year"] for r in e["frames"] if r["mean"] is not None]
        ax.plot(yrs, [r["mean"] for r in e["frames"] if r["mean"] is not None], "o-", color=color, label=f"{m} obs")
        for s, ls in zip(_S12_SCEN, (":", "--", "-.")):
            fan = e["ssp"].get(s, [])
            if not fan:
                continue
            fy = [r["year"] for r in fan]
            ax.fill_between(fy, [r["p05"] for r in fan], [r["p95"] for r in fan], color=color, alpha=0.08)
            ax.plot(fy, [r["p50"] for r in fan], ls, color=color, label=f"{m} {s} p50")
    ax.set_title("NCR mean LST (timeline_series.json.gz)")
    ax.set_xlabel("year")
    ax.set_ylabel("°C")
    ax.legend(fontsize=7, ncol=2)
    if DATA_MODE == "synthetic":
        fig.suptitle("SYNTHETIC DEMO DATA", color="crimson")
    fig.tight_layout()
    fig.savefig(_S12_FIG_DIR / "12_export_overview.png", dpi=120, bbox_inches="tight")
    plt.show()
    plt.close(fig)


def _s12_zip(zip_path):
    with _s12_zipfile.ZipFile(zip_path, "w", compression=_s12_zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for p in sorted(_S12_WEB.rglob("*")):
            if p.is_file():
                rel = p.relative_to(_S12_WEB).as_posix()
                # gzip / PNG members are already compressed: store them as they are
                stored = rel.endswith((".gz", ".png"))
                zf.write(p, arcname=rel, compress_type=_s12_zipfile.ZIP_STORED if stored else _s12_zipfile.ZIP_DEFLATED)
    return zip_path


def _s12_print_tree(root, max_files=30):
    """Outputs tree with sizes; directories with many files (caches, rasters) are summarised."""
    root = Path(root)
    print(f"{root}/")
    for d in sorted([root] + [p for p in root.rglob("*") if p.is_dir()]):
        files = sorted(p for p in d.iterdir() if p.is_file())
        depth = len(d.relative_to(root).parts)
        if d != root:
            print(f"{'  ' * depth}{d.name}/")
        if len(files) > max_files or "cache" in d.relative_to(root).parts:
            total = sum(p.stat().st_size for p in files)
            if files:
                print(f"{'  ' * (depth + 1)}[{len(files)} files, {total / 1e6:.1f} MB]")
            continue
        for p in files:
            print(f"{'  ' * (depth + 1)}{p.name:<44s} {p.stat().st_size / 1e6:9.2f} MB")


try:
    _s12_fig_overview()
except Exception as _s12_exc:  # noqa: BLE001 - the figure is a convenience, never a reason to lose the export
    log(f"12: overview figure failed: {type(_s12_exc).__name__}: {_s12_exc}", "WARNING")
_S12_ZIP = _s12_zip(_S12_OUT / "web_bundle.zip")
log(f"12: web bundle zipped: {_S12_ZIP} ({_S12_ZIP.stat().st_size / 1e6:.1f} MB)")
_s12_print_tree(_S12_OUT)

print("\n" + "=" * 96)
print(f"RUN SUMMARY  (data mode: {DATA_MODE.upper()}{' - SYNTHETIC DEMO DATA' if DATA_MODE == 'synthetic' else ''}"
      f", profile {CFG.PROFILE}, grid {CFG.GRID_RES_M} m, {_S12_NC:,} cells)")
print("=" * 96)
for _s12_m in _S12_MODES:
    _s12_h = (MODEL_RESULTS.get(_s12_m) or {}).get("headline") or {}
    _s12_sp, _s12_tp = _s12_h.get("spatial") or {}, _s12_h.get("temporal") or {}
    _s12_lv = [f"{y}:{_s12_level(_s12_m, y)[0]:.1f}" for y in _S12_OBS if _s12_level(_s12_m, y)[0] is not None]
    print(f"{_s12_m.upper():>5}: spatial {_s12_sp.get('scheme')} R2 {_s12_num(_s12_sp.get('r2'), 3)} RMSE "
          f"{_s12_num(_s12_sp.get('rmse'), 3)} °C | temporal {_s12_tp.get('scheme')} R2 "
          f"{_s12_num(_s12_tp.get('r2'), 3)}"
          f" RMSE {_s12_num(_s12_tp.get('rmse'), 3)} °C | beta {_s12_num(CLIMATE_SENSITIVITY[_s12_m].get('beta'), 2)}")
    print(f"       levels {' '.join(_s12_lv)}")
    for _s12_s in _S12_SCEN:
        _s12_r = _s12_ncr_proj(_s12_m, _s12_s, _S12_PROJ[-1]) or {}
        print(f"       {_s12_s} {_S12_PROJ[-1]}: NCR p50 {_s12_num(_s12_r.get('p50'), 2)} °C "
              f"[{_s12_num(_s12_r.get('p05'), 2)}, {_s12_num(_s12_r.get('p95'), 2)}]")
_s12_probes = (globals().get("FUTURE_INPUTS_DIAG") or {}).get("probes") if isinstance(
    globals().get("FUTURE_INPUTS_DIAG"), dict) else None
if _s12_probes:
    # pilot probes of section 05 (D2): Earth Engine cost of the CMIP6 pattern, for extrapolating the full run
    print("Pilot probes (section 05):")
    _s12_rows = [{"probe": k, **{c: (v or {}).get(c) for c in ("seconds", "requests", "cache_hits",
                                                               "roi_mean_delta_k", "error")}}
                 for k, v in _s12_probes.items()]
    print(pd.DataFrame(_s12_rows).to_string(index=False))
print(f"Web bundle: {len(_S12_SIZES)} files, {_S12_BUNDLE_BYTES / 1e6:.1f} MB on disk -> {_S12_WEB}")
print(f"Zip: {_S12_ZIP} ({_S12_ZIP.stat().st_size / 1e6:.1f} MB)")
_s12_target = "dashboard/public/demo/" if DATA_MODE == "synthetic" else "dashboard/public/data/"
print(f"\nNEXT STEP: copy the contents of {_S12_WEB}/ (or unzip {_S12_ZIP.name}) into {_s12_target}, then run "
      "`npm run dev` in dashboard/ (optionally `python notebook/validate_bundle.py <dir>` first).")
TIMINGS["12_export_total"] = round(_s12_time.perf_counter() - _S12_T0, 2)
free_memory()
log(f"Section 12 complete in {TIMINGS['12_export_total']:.1f}s: EXPORT_MANIFEST ready")
# Last statement of the run: pack the cache into a few tar files (Kaggle output file cap; pack_cache honours
# LST_PACK_CACHE and never touches web/ or web_bundle.zip). Without the helper (older 00) only report the count.
_s12_pk = globals().get("pack_cache")
if _s12_pk is not None:
    _s12_pk()
else:
    _s12_nfiles = sum(1 for _p in _S12_OUT.rglob("*") if _p.is_file())
    log(f"12: {_s12_nfiles} files under {_S12_OUT} (pack_cache unavailable; Kaggle keeps about 500 output files)",
        "WARNING" if _s12_nfiles > 450 else "INFO")
