# %% [markdown]
# # 6. Features, targets, masks and cross-validation folds
#
# One row of the modelling table `DF` is one **ROI cell × observed frame** (all ROI cells, also those without a
# valid target; the target columns are NaN and the sample weight 0 there). The 47 predictors are fixed in number
# and **order** (SPEC §4.1): the order of `FEATURES` is the column order of every model, SHAP matrix and web file.
#
# | Family | Base features (33) | Physical role in pre-monsoon LST |
# |---|---|---|
# | spectral | `ndvi ndbi mndwi albedo ndvi_spring ndvi_drop` | transpiration/shading (NDVI), built/bare signal (NDBI), surface wetness (MNDWI, green/SWIR1), absorbed shortwave (albedo); `ndvi_drop = ndvi_spring − ndvi` marks rabi wheat harvested before April (bare, hot) versus irrigated/sugarcane fields that stay green |
# | landcover | `frac_built frac_forest frac_water frac_cropland frac_barren` | composition of the 1 km cell (GHSL built-up + GLC_FCS30D classes on a common simplex; *other vegetation* is the implicit reference) |
# | urban | `built_v log_pop dist_urban dist_builtup lm_pd lm_ed lm_contag` | building volume (heat storage, night UHI), population (anthropogenic heat), proximity to dense urban cores and to any built-up land, landscape configuration (fragmentation, edges, aggregation) |
# | water | `dist_water` | advective/evaporative cooling reach of rivers, canals and jheels |
# | terrain | `elevation slope aspect_sin aspect_cos elev_tpi7 elev_tpi21 elev_std7` | lapse rate, illumination, cold-air pooling (topographic position), ridge relief |
# | climate | `era5_t2m era5_vpd era5_swvl1 era5_evap era5_ssr era5_wind era5_precip_jfm` | the regional gradient (ERA5-Land, Apr–Jun of the frame window) that v1 lacked; replaces raw coordinates (SPEC §1.4) |
#
# **Focal (14):** NaN-aware box means at 3 and 15 cells of `ndvi ndbi albedo frac_built frac_forest frac_water
# frac_barren` (`<b>_m3`, `<b>_m15`). The real-data experiments (`docs/research/real_data_accuracy_experiments.md` §b)
# showed that v1's weak spatial CV came from missing neighbourhood context — a park cools its surroundings, a city
# warms its fringe: 3 and 15 km window means, together with distance and relative-elevation features, raised 5×5
# block CV R² from 0.63 → 0.83 (the windows alone ≈ 0.79). In v2 the distance and TPI features are part of the 33
# base features, so the base-only ablation of section 07 isolates the 14 focal means only. The windows are
# defined in **cells**, so at the 2 km smoke-test grid they span 6 and 30 km (documented, not rescaled).
#
# **Definitions** (all on the 1 km analysis grid `GRID`, cells outside the ROI are NaN):
# * spectral / built-up 1 km values = mean of the valid fine (250 m) pixels when ≥ 50 % of the 16 are valid;
# * `frac_built` = 1 km mean of GHSL `built_f`; the other four fractions put the GLC classes on the GHSL simplex:
#   $f_k = g_k / (1 - g_{built}) \cdot (1 - f_{built})$ (0 when $g_{built} \ge 0.999$), so
#   $f_{built} + \sum_k f_k + f_{otherveg} = 1$ and one land-cover *definition* of "built" is used everywhere;
# * `built_v` = log1p(m³ m⁻²), `log_pop` = log1p(persons km⁻²);
# * focal box mean $\bar x_w = \mathrm{U}_w(x\,m) / \mathrm{U}_w(m)$ with $\mathrm{U}_w$ the `uniform_filter` of
#   width $w$ and $m$ the valid-cell indicator (ROI ∧ finite), zero padding beyond the grid edge; |values| < 10⁻¹²
#   (running-sum residues of all-zero windows) are set to exactly 0, so "no water within 15 cells" is exactly 0;
# * `elev_tpi7 = elevation − box7(elevation)`, `elev_tpi21` likewise, `elev_std7` = NaN-aware box standard deviation;
# * distances (km) by the Euclidean distance transform × cell size: `dist_water` to cells with
#   `frac_water ≥ 0.3 or water_occ ≥ 0.5`, `dist_urban` to cells whose box7 mean `frac_built ≥ 0.3` (urban core; 0.5 matched no real cell), `dist_builtup` to
#   `frac_built ≥ 0.3` (cells outside the ROI are never targets);
# * landscape metrics PD/ED/CONTAG from `LC_FINE` exactly as v1 (vectorised, validated against `pylandstats`).
#
# **Targets** (SPEC §3.3). *Day*: the 1 km mean of the harmonised Landsat fine composite (≥ 50 % valid fine pixels)
# with a 1 km mean clear-scene count ≥ 2, weight `w_day = clip(nobs/5, 0.4, 1)`, all observed frames train.
# *Night*: Aqua-equivalent 1 km LST with ≥ 3 valid 8-day composites (`NIGHT_MIN_NOBS`; real Apr–Jun data give a
# median of ~5 per cell over a 3-year window; the calibrated Terra frame ≥ 1, it has weight 0) (VIIRS: ≥ 20 daily
# observations), weight
# `w_night = clip(nobs/12, 0.5, 1)`; only `CFG.NIGHT_TRAIN_FRAMES` (2005–2025) train — the calibrated Terra 2000 frame
# keeps its observed anomaly (weight 0) as the hindcast check, 1990/1995 have no night product.
#
# **Fixed masks and anomalies.** Per mode, the *mask frames* are the training frames whose valid-target share of the
# ROI cells is ≥ `LST_FRAME_MIN_COVERAGE` (default 0.5). `FIXED_MASK[mode]` = ROI cells with a valid target in
# **every** mask frame (strict intersection; a share < 80 % of the ROI logs a warning and a `DATA_CAVEATS` entry with
# each frame's missing share; fewer than two mask frames, or a mask keeping < 1 % of the ROI — the frames' valid sets
# barely overlap, so levels and anomalies would rest on a handful of cells — stop the run with the per-frame
# coverages). Training frames below the threshold keep
# their observations but get weight 0 (they would otherwise shrink the mask for every frame). The anomaly target
# $a(i,t) = LST(i,t) - \overline{LST}_{FIXED \wedge valid}(t)$ uses this one cell set for every frame, so a changing
# valid-cell composition (clouds, SLC-off gaps) cannot masquerade as warming; `RAW_LEVELS[mode][t]` stores the
# subtracted level (day: before the overpass-time correction of §4.7). `FIXED_MASK_COVERAGE[mode][t]` = share of
# the FIXED_MASK cells with a valid target at frame $t$ (1.0 for mask frames); section 09 corrects the level of a
# frame that does not cover the whole mask with the model-predicted anomaly of its missing cells (§4.7).
# A day frame without a single valid target is an acquisition fault and stops the section.
#
# **Cross-validation groupings** (columns of `DF`, so every later stage reuses identical folds; a cell keeps its
# fold in every frame):
# * `fold_block20` — 20 km square blocks (`block20_id`) greedily size-balanced into `CFG.N_FOLDS_BLOCK` folds
#   (largest block first → currently smallest fold), the headline spatial scheme (≈ the residual correlation range);
# * `fold_block5` — v1's 5 × 5 tiles over the grid extent, greedy into 5 folds (comparable with v1);
# * `fold_district` — the district id (leave-one-district-out in section 07);
# * `fold_random` — seeded random rows, 5 folds (the optimistic upper bound);
# * `block10_id` — 10 km blocks for the inner early-stopping split (always drawn from training rows only).
#
# **Missing predictors** stay NaN (float32): tree models route them, linear models / RF / GNN impute with the
# training-fold median inside each fold.

# %%
import hashlib as _s06_hashlib
import math as _s06_math
import os as _s06_os
import time as _s06_time
import warnings as _s06_warnings
from collections import OrderedDict
from pathlib import Path

import numpy as np
import pandas as pd
from numpy.lib.stride_tricks import sliding_window_view as _s06_sliding_window_view
from scipy import ndimage as _s06_ndi

# ---- feature list (SPEC §4.1, order binding) ---------------------------------------------------------------------
BASE_FEATURES = [
    "ndvi", "ndbi", "mndwi", "albedo", "ndvi_spring", "ndvi_drop",
    "frac_built", "frac_forest", "frac_water", "frac_cropland", "frac_barren",
    "built_v", "log_pop", "dist_urban", "dist_builtup", "lm_pd", "lm_ed", "lm_contag",
    "dist_water",
    "elevation", "slope", "aspect_sin", "aspect_cos", "elev_tpi7", "elev_tpi21", "elev_std7",
    "era5_t2m", "era5_vpd", "era5_swvl1", "era5_evap", "era5_ssr", "era5_wind", "era5_precip_jfm",
]
FOCAL_SPEC = {"bases": ["ndvi", "ndbi", "albedo", "frac_built", "frac_forest", "frac_water", "frac_barren"],
              "windows": [3, 15]}
_S06_FOCAL_FEATURES = [f"{b}_m{w}" for b in FOCAL_SPEC["bases"] for w in FOCAL_SPEC["windows"]]
FEATURES = BASE_FEATURES + _S06_FOCAL_FEATURES
if len(BASE_FEATURES) != 33 or len(FEATURES) != 47 or len(set(FEATURES)) != 47:
    raise AssertionError(f"feature list must be 33 base + 14 focal unique names, "
                         f"got {len(BASE_FEATURES)}/{len(FEATURES)}")

_S06_FAMILY = {}
for _fam, _names in (("spectral", ["ndvi", "ndbi", "mndwi", "albedo", "ndvi_spring", "ndvi_drop"]),
                     ("landcover", ["frac_built", "frac_forest", "frac_water", "frac_cropland", "frac_barren"]),
                     ("urban", ["built_v", "log_pop", "dist_urban", "dist_builtup", "lm_pd", "lm_ed", "lm_contag"]),
                     ("water", ["dist_water"]),
                     ("terrain", ["elevation", "slope", "aspect_sin", "aspect_cos", "elev_tpi7", "elev_tpi21",
                                  "elev_std7"]),
                     ("climate", ["era5_t2m", "era5_vpd", "era5_swvl1", "era5_evap", "era5_ssr", "era5_wind",
                                  "era5_precip_jfm"])):
    for _n in _names:
        _S06_FAMILY[_n] = _fam
for _b in FOCAL_SPEC["bases"]:
    for _w in FOCAL_SPEC["windows"]:
        _S06_FAMILY[f"{_b}_m{_w}"] = _S06_FAMILY[_b]       # a focal mean belongs to its base feature's family

# ---- SHAP groups (SPEC §4.4, order binding): id -> (members, primary, label, family, actionable) ---------------------
_S06_GROUP_ROWS = [
    ("ndvi", ["ndvi", "ndvi_m3", "ndvi_m15"], "ndvi", "Vegetation (NDVI)", "spectral", True),
    ("phenology", ["ndvi_spring", "ndvi_drop"], "ndvi_drop", "Spring green-up", "spectral", False),
    ("ndbi", ["ndbi", "ndbi_m3", "ndbi_m15"], "ndbi", "Built-up index (NDBI)", "spectral", False),
    ("moisture_index", ["mndwi"], "mndwi", "Surface wetness (MNDWI)", "spectral", False),
    ("albedo", ["albedo", "albedo_m3", "albedo_m15"], "albedo", "Albedo", "spectral", False),
    ("built", ["frac_built", "frac_built_m3", "frac_built_m15"], "frac_built", "Built-up fraction", "landcover", True),
    ("built_volume", ["built_v"], "built_v", "Built volume", "urban", False),
    ("population", ["log_pop"], "log_pop", "Population density", "urban", False),
    ("forest", ["frac_forest", "frac_forest_m3", "frac_forest_m15"], "frac_forest", "Tree cover", "landcover", True),
    ("water", ["frac_water", "frac_water_m3", "frac_water_m15", "dist_water"], "frac_water", "Water", "water", True),
    ("cropland", ["frac_cropland"], "frac_cropland", "Cropland", "landcover", True),
    ("barren", ["frac_barren", "frac_barren_m3", "frac_barren_m15"], "frac_barren", "Barren land", "landcover", True),
    ("urban_proximity", ["dist_urban", "dist_builtup"], "dist_urban", "Distance to urban core", "urban", False),
    ("landscape", ["lm_pd", "lm_ed", "lm_contag"], "lm_ed", "Landscape pattern", "landcover", True),
    ("terrain", ["elevation", "slope", "aspect_sin", "aspect_cos", "elev_tpi7", "elev_tpi21", "elev_std7"],
     "elevation", "Terrain", "terrain", False),
    ("climate_heat", ["era5_t2m", "era5_ssr"], "era5_t2m", "Air temperature & radiation", "climate", False),
    ("climate_moisture", ["era5_vpd", "era5_swvl1", "era5_evap", "era5_precip_jfm"], "era5_swvl1",
     "Soil & air moisture", "climate", False),
    ("climate_wind", ["era5_wind"], "era5_wind", "Wind", "climate", False),
]
SHAP_GROUPS = OrderedDict((gid, list(members)) for gid, members, *_ in _S06_GROUP_ROWS)
GROUP_META = OrderedDict(
    (gid, {"label": label, "primary": primary, "family": family, "actionable": bool(actionable),
           "members": list(members)})
    for gid, members, primary, label, family, actionable in _S06_GROUP_ROWS)
_S06_GROUP_OF = {f: gid for gid, members in SHAP_GROUPS.items() for f in members}
if len(SHAP_GROUPS) != 18 or sorted(_S06_GROUP_OF) != sorted(FEATURES) \
        or sum(len(m) for m in SHAP_GROUPS.values()) != len(FEATURES):
    raise AssertionError("SHAP_GROUPS must partition the 47 FEATURES into 18 groups")
for _gid, _meta in GROUP_META.items():
    if _meta["primary"] not in SHAP_GROUPS[_gid]:
        raise AssertionError(f"primary feature of group {_gid} is not a member")

# Monotone-constraint and target-validity constants used by sections 06/07
_S06_MIN_VALID_SHARE = 0.5      # landscape-metric windows need >= 50 % valid fine land-cover pixels
_S06_N_LC_CLASSES = 6
_S06_LM_CHUNK_PIXELS = 1 << 23  # ~8.4 M fine pixels per landscape-metric chunk -> peak RAM well below 1 GB
_S06_LM_STRUCTURE = np.zeros((3, 3, 3), dtype=bool)   # 8-connectivity in a window, none along the stack axis
_S06_LM_STRUCTURE[1] = True
# Training frames whose valid-target share of the ROI is below this value are left out of the fixed mask and get
# weight 0 (D8; part of the stage key).
_S06_FRAME_MIN_COVERAGE = float(_s06_os.environ.get("LST_FRAME_MIN_COVERAGE", "0.5"))
if not 0.0 < _S06_FRAME_MIN_COVERAGE <= 1.0:
    raise ValueError(f"LST_FRAME_MIN_COVERAGE must be in (0, 1], got {_S06_FRAME_MIN_COVERAGE}")
_S06_FIXED_MASK_WARN_SHARE = 0.8
_S06_VERSION = "06-v2.1"
log(f"06: {len(FEATURES)} features ({len(BASE_FEATURES)} base + {len(_S06_FOCAL_FEATURES)} focal), "
    f"{len(SHAP_GROUPS)} SHAP groups")

# %% [markdown]
# ## 6.1 Grid operators: NaN-aware box statistics and distances
# `uniform_filter` computes running window sums in O(n) per axis, independent of the window size, so the 15-cell
# windows cost the same as the 3-cell ones. Means are formed as the ratio of filtered value·mask and filtered mask
# (zero padding), which is exactly the mean of the valid cells inside the window — at the ROI edge the window
# shrinks to the cells that exist instead of mixing in fake zeros. The box standard deviation is evaluated on values
# centred on the ROI mean to avoid cancellation in $E[x^2] - E[x]^2$.

# %%
def _s06_box_mean(x, size, valid=None):
    """NaN-aware box mean of a (H, W) grid over valid cells (float64 in, float64 out; NaN where no valid cell)."""
    x = np.asarray(x, dtype=np.float64)
    m = np.isfinite(x) if valid is None else (np.asarray(valid, bool) & np.isfinite(x))
    size = int(size)
    num = _s06_ndi.uniform_filter(np.where(m, x, 0.0), size=size, mode="constant", cval=0.0)
    den = _s06_ndi.uniform_filter(m.astype(np.float64), size=size, mode="constant", cval=0.0)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = num / den
    out[den < 0.5 / (size * size)] = np.nan          # no valid cell in the window (den is k / size^2, k >= 1)
    # uniform_filter's running sums leave residues of ~1e-17 in windows whose values are all exactly 0 (e.g. no
    # water within 15 cells); they would let trees split on "0 vs 1e-17" and make untouched cells look changed in
    # counterfactuals. NaN is untouched (abs(NaN) < tol is False).
    out[np.abs(out) < 1e-12] = 0.0
    return out


def _s06_box_std(x, size, valid=None):
    """NaN-aware box standard deviation (population form) over valid cells (exactly 0 in constant windows)."""
    x = np.asarray(x, dtype=np.float64)
    m = np.isfinite(x) if valid is None else (np.asarray(valid, bool) & np.isfinite(x))
    if not m.any():
        return np.full(x.shape, np.nan)
    centre = float(x[m].mean())
    xc = np.where(m, x - centre, np.nan)
    mean = _s06_box_mean(xc, size, m)
    mean_sq = _s06_box_mean(xc * xc, size, m)
    var = mean_sq - mean * mean
    # E[x^2] - E[x]^2 of a constant window is a cancellation residue of the order eps * E[x^2]: snap it to 0
    var[var <= 1e-12 * np.abs(mean_sq)] = 0.0
    return np.sqrt(np.maximum(var, 0.0))


def _s06_tpi(elev, size, roi):
    """Topographic position elevation − box mean (m); |TPI| < 1e-9 m (filter residue on flat ground) set to 0."""
    tpi = elev - _s06_box_mean(elev, size, roi)
    tpi[np.abs(tpi) < 1e-9] = 0.0
    return tpi


# Urban core = cells whose 7 x 7 km mean built fraction reaches this value. Real data (2026-11): the 1 km built
# fraction saturates near 0.69 and its 7 km mean peaks at 0.45-0.49 over NCR, so the first value (0.5, tuned on the
# synthetic world) selected no cell; 0.3 gives cores of ~240 (1990) to ~560 km2 (2025).
_S06_URBAN_CORE_BUILT = 0.3
_S06_URBAN_CORE_TOP_SHARE = 0.005       # fallback when no cell reaches it: the top 0.5 % of the ROI by 7 km mean


def _s06_urban_core(box7_built, roi):
    """Cells of the urban core (box-7 mean built fraction >= ``_S06_URBAN_CORE_BUILT``); when none reaches it, the
    top ``_S06_URBAN_CORE_TOP_SHARE`` of the ROI by that mean (with a warning), so ``dist_urban`` never collapses to
    an uninformative constant."""
    core = roi & (box7_built >= _S06_URBAN_CORE_BUILT)
    vals = box7_built[roi]
    if core.any() or not vals.size or float(vals.max()) <= 0.0:
        return core
    thr = float(np.quantile(vals, 1.0 - _S06_URBAN_CORE_TOP_SHARE))
    log(f"06: no cell has a 7 km mean built fraction >= {_S06_URBAN_CORE_BUILT} (max {float(vals.max()):.3f}); the "
        f"urban core is the top {_S06_URBAN_CORE_TOP_SHARE:.1%} of the ROI (>= {thr:.3f})", "WARNING")
    return roi & (box7_built >= thr) & (box7_built > 0.0)


def _s06_distance_km(target, res_m, label=""):
    """Euclidean distance (km) from every cell to the nearest ``target`` cell (0 on targets).

    With no target at all the distance is undefined; the grid diagonal (the largest distance the grid can express)
    is used and a warning is logged, so the feature stays finite and constant (uninformative) instead of NaN.
    """
    target = np.asarray(target, bool)
    if not target.any():
        log(f"06: no target cells for {label or 'distance'}; using the grid diagonal as a constant", "WARNING")
        return np.full(target.shape, _s06_math.hypot(*target.shape) * res_m / 1000.0, dtype=np.float64)
    return _s06_ndi.distance_transform_edt(~target) * (float(res_m) / 1000.0)


def _s06_fine_to_cell(fine, min_valid_frac):
    """1 km mean of the fine (250 m) pixels of each cell; NaN when < ``min_valid_frac`` of them are valid."""
    return block_mean(np.asarray(fine, np.float32), int(CFG.FINE_FACTOR), float(min_valid_frac)).astype(np.float64)


# %% [markdown]
# ## 6.2 Vectorised landscape metrics (ported unchanged from v1)
# A window is the block of fine land-cover pixels under `CFG.LM_WINDOW_CELLS` × `CFG.LM_WINDOW_CELLS` grid cells
# centred on the cell. With $A$ the valid area, $N_p$ the number of 8-connected patches (summed over classes 1–6),
# $g_{ik}$ the 4-neighbour adjacencies counted in both directions and $m$ the number of classes present:
#
# $$\mathrm{PD} = \frac{N_p}{A}\,10^{4}\times 100,\qquad \mathrm{ED} = \frac{r\sum_{i<k} g_{ik}}{A}\,10^{4},\qquad
#   \mathrm{CONTAG} = \Big[1 + \frac{\sum_{i,k} p_{ik}\ln p_{ik}}{2\ln m}\Big]\times 100,\quad p_{ik} = g_{ik}/\textstyle\sum g .$$
#
# Sides on the landscape border or touching nodata are not edges (pylandstats `count_boundary=False`); a single-class
# window gets CONTAG = 100. All windows of a chunk are stacked into one `(n, b, b)` array: patches come from one 3-D
# `ndimage.label` per class (no connectivity along the stack axis) and adjacencies from one `bincount`. With
# `ENV["has_cupy"]` the same array code runs on the GPU (`cupyx.scipy.ndimage.label`), falling back to NumPy.

# %%
def _s06_lm_backend():
    """Return (array module, label function, backend name) for landscape metrics."""
    if ENV.get("has_cupy"):
        try:
            import cupy as _cp
            import cupyx.scipy.ndimage as _cndi

            return _cp, _cndi.label, "cupy"
        except Exception as exc:  # noqa: BLE001 - broken CUDA install -> CPU
            log(f"cupy unavailable for landscape metrics ({exc!r}); using NumPy", "WARNING")
    return np, _s06_ndi.label, "numpy"


def _s06_window_stack_view(lc_fine, f, window_cells):
    """Strided view (H, W, b, b) of the fine pixels under each cell's window (no copy)."""
    if window_cells < 1 or (window_cells > 1 and window_cells % 2 == 0):
        raise ValueError(f"LM_WINDOW_CELLS must be 1 or an odd number >= 3, got {window_cells}")
    half_px = (window_cells - 1) // 2 * f
    padded = np.pad(lc_fine, half_px, mode="constant", constant_values=0) if half_px else lc_fine
    size = window_cells * f
    return _s06_sliding_window_view(padded, (size, size))[::f, ::f]


def _s06_metrics_from_counts(counts, valid, n_patches, adjacency, fine_res, px_per_win):
    """Turn per-window counts into PD, ED and CONTAG (NumPy, float64)."""
    area_ha = valid * fine_res * fine_res / 1e4
    total_adj = adjacency.sum(axis=(1, 2)).astype(np.float64)
    like_adj = np.einsum("nii->n", adjacency).astype(np.float64)
    edge_len_m = (total_adj - like_adj) / 2.0 * fine_res  # each unlike pair is counted twice
    n_present = (counts[:, 1:] > 0).sum(axis=1)
    with np.errstate(divide="ignore", invalid="ignore"):
        pd_ = n_patches / area_ha * 100.0
        ed = edge_len_m / area_ha
        prob = adjacency / total_adj[:, None, None]
        plogp = np.where(prob > 0, prob * np.log(np.where(prob > 0, prob, 1.0)), 0.0)
        joint_entropy = -plogp.sum(axis=(1, 2))
        contag = (1.0 - joint_entropy / (2.0 * np.log(np.maximum(n_present, 2)))) * 100.0
    contag = np.where(n_present == 1, 100.0, contag)
    contag = np.where((n_present >= 2) & (total_adj == 0), np.nan, contag)
    insufficient = valid < _S06_MIN_VALID_SHARE * px_per_win
    for arr in (pd_, ed, contag):
        arr[insufficient] = np.nan
    return {"counts": counts, "pd": pd_, "ed": ed, "contag": contag}


def _s06_stack_metrics(stack, fine_res, xp=np, label_fn=_s06_ndi.label):
    """Class counts, PD, ED and CONTAG for a stack of windows ``(n, b, b)`` uint8 (0 = nodata)."""
    n_win, size, _ = stack.shape
    n_cls = _S06_N_LC_CLASSES
    stack = xp.asarray(stack)
    win_id = xp.arange(n_win, dtype=xp.int64)[:, None, None]
    counts = xp.bincount((win_id * (n_cls + 1) + stack).ravel(), minlength=n_win * (n_cls + 1))
    counts = counts.reshape(n_win, n_cls + 1)
    valid = counts[:, 1:].sum(axis=1)

    n_patches = xp.zeros(n_win, dtype=xp.int64)
    px_per_win = size * size
    for cls in range(1, n_cls + 1):
        if int(counts[:, cls].sum()) == 0:
            continue
        labels, n_labels = label_fn(stack == cls, structure=xp.asarray(_S06_LM_STRUCTURE))
        n_labels = int(n_labels)
        if n_labels == 0:
            continue
        flat = labels.ravel()
        pix = xp.flatnonzero(flat)
        owner = xp.zeros(n_labels + 1, dtype=xp.int64)
        owner[flat[pix]] = pix // px_per_win  # every pixel of a label lies in the same window
        n_patches += xp.bincount(owner[1:], minlength=n_win)
        del labels, flat, pix, owner

    adjacency = xp.zeros(n_win * n_cls * n_cls, dtype=xp.int64)
    for a, b in ((stack[:, :, :-1], stack[:, :, 1:]), (stack[:, :-1, :], stack[:, 1:, :])):
        ok = (a > 0) & (b > 0)
        wid = xp.broadcast_to(win_id, a.shape)[ok]
        ca = a[ok].astype(xp.int64) - 1
        cb = b[ok].astype(xp.int64) - 1
        base = wid * (n_cls * n_cls)
        adjacency += xp.bincount(base + ca * n_cls + cb, minlength=n_win * n_cls * n_cls)
        adjacency += xp.bincount(base + cb * n_cls + ca, minlength=n_win * n_cls * n_cls)
        del ok, wid, ca, cb, base
    adjacency = adjacency.reshape(n_win, n_cls, n_cls)

    to_np = (lambda arr: arr) if xp is np else xp.asnumpy
    counts, valid, n_patches, adjacency = map(to_np, (counts, valid, n_patches, adjacency))
    return _s06_metrics_from_counts(counts, valid, n_patches, adjacency, fine_res, px_per_win)


def _s06_landscape_metrics(lc_fine, f, fine_res, window_cells, cell_mask):
    """PD / ED / CONTAG rasters (H, W) float32 for the cells in ``cell_mask`` (others NaN) + the backend used."""
    n_rows, n_cols = cell_mask.shape
    view = _s06_window_stack_view(lc_fine, f, window_cells)
    size = view.shape[-1]
    rows, cols = np.nonzero(cell_mask)
    out = {k: np.full((n_rows, n_cols), np.nan, dtype=np.float32) for k in ("lm_pd", "lm_ed", "lm_contag")}
    xp, label_fn, backend = _s06_lm_backend()
    per_chunk = max(1, _S06_LM_CHUNK_PIXELS // (size * size))
    for start in range(0, rows.size, per_chunk):
        r_idx, c_idx = rows[start:start + per_chunk], cols[start:start + per_chunk]
        stack = np.ascontiguousarray(view[r_idx, c_idx])
        try:
            res = _s06_stack_metrics(stack, fine_res, xp, label_fn)
        except Exception as exc:  # noqa: BLE001 - GPU failure -> CPU for the remaining chunks
            if xp is np:
                raise
            log(f"GPU landscape metrics failed ({exc!r}); continuing on CPU", "WARNING")
            xp, label_fn, backend = np, _s06_ndi.label, "numpy"
            free_memory()
            res = _s06_stack_metrics(stack, fine_res, xp, label_fn)
        out["lm_pd"][r_idx, c_idx] = res["pd"]
        out["lm_ed"][r_idx, c_idx] = res["ed"]
        out["lm_contag"][r_idx, c_idx] = res["contag"]
        del stack, res
    out["backend"] = backend
    return out


def _s06_lc_factor(year):
    """Fine land-cover pixels per grid cell (f) and their size (m) for a frame's ``LC_FINE`` raster."""
    lc = LC_FINE[year]
    n_rows, n_cols = ROI_MASK.shape
    f = lc.shape[0] // n_rows
    if f < 1 or lc.shape != (n_rows * f, n_cols * f):
        raise ValueError(f"LC_FINE[{year}] shape {lc.shape} incompatible with grid {ROI_MASK.shape}")
    return f, float(GRID.res) / f


# %% [markdown]
# ### 6.2.1 Validation against pylandstats
# 120 random windows (pooled over frames) are re-computed with `pylandstats.Landscape(array, res=(r, r), nodata=0,
# neighborhood_rule="8")`; pylandstats 3.x uses the same definitions (PD per 100 ha of valid area, ED without the
# boundary, CONTAG from the double-counted adjacency matrix), except that it returns NaN for a single-class window,
# which is excluded from the CONTAG comparison. A mismatch warns but never stops the pipeline.

# %%
def _s06_validate_landscape_metrics(n=120, tol=1e-6):
    """Compare the vectorised metrics with pylandstats on ``n`` random valid windows → ``LM_VALIDATION`` dict."""
    try:
        import pylandstats as pls
    except ImportError:
        log("pylandstats not installed - landscape metric validation skipped", "WARNING")
        return {"n": 0, "status": "skipped", "reason": "pylandstats not installed"}
    try:
        rng = np.random.default_rng(CFG.SEED)
        years = sorted(LC_FINE)
        per_year = np.bincount(rng.integers(0, len(years), size=n), minlength=len(years))
        ours, ref = {"pd": [], "ed": [], "contag": []}, {"pd": [], "ed": [], "contag": []}
        n_single_class = 0
        for year, n_year in zip(years, per_year):
            if n_year == 0:
                continue
            f, fine_res = _s06_lc_factor(year)
            view = _s06_window_stack_view(LC_FINE[year], f, int(CFG.LM_WINDOW_CELLS))
            cand_r, cand_c = np.nonzero(ROI_MASK)
            pick = rng.choice(cand_r.size, size=min(int(n_year) * 3, cand_r.size), replace=False)
            stack = np.ascontiguousarray(view[cand_r[pick], cand_c[pick]])
            res = _s06_stack_metrics(stack, fine_res)
            keep = np.flatnonzero(np.isfinite(res["pd"]))[: int(n_year)]
            for i in keep:
                with _s06_warnings.catch_warnings():
                    _s06_warnings.simplefilter("ignore")
                    ls = pls.Landscape(stack[i], res=(fine_res, fine_res), nodata=0, neighborhood_rule="8")
                    ref_vals = (ls.patch_density(), ls.edge_density(count_boundary=False), ls.contagion())
                ours["pd"].append(res["pd"][i])
                ref["pd"].append(ref_vals[0])
                ours["ed"].append(res["ed"][i])
                ref["ed"].append(ref_vals[1])
                if np.isfinite(ref_vals[2]):
                    ours["contag"].append(res["contag"][i])
                    ref["contag"].append(ref_vals[2])
                else:
                    n_single_class += 1
            del view, stack, res
    except Exception as exc:  # noqa: BLE001 - validation must never stop the pipeline
        log(f"landscape metric validation failed: {exc!r}", "WARNING")
        return {"n": 0, "status": "error", "reason": repr(exc)}

    out = {"n": len(ours["pd"]), "window_cells": int(CFG.LM_WINDOW_CELLS), "n_single_class": n_single_class,
           "pylandstats_version": getattr(pls, "__version__", "unknown")}
    worst = 0.0
    for metric in ("pd", "ed", "contag"):
        a, b = np.asarray(ours[metric], float), np.asarray(ref[metric], float)
        diff = np.abs(a - b) if a.size else np.array([np.nan])
        out[f"{metric}_max_abs_diff"] = float(np.nanmax(diff)) if a.size else None
        out[f"{metric}_mean_abs_diff"] = float(np.nanmean(diff)) if a.size else None
        out[f"{metric}_n"] = int(a.size)
        if a.size:
            worst = max(worst, float(np.nanmax(diff / np.maximum(np.abs(b), 1.0))))
    out["max_rel_diff"] = worst
    out["status"] = "ok" if worst <= tol else "warn"
    out["note"] = ("CONTAG compared only on windows with >= 2 classes (pylandstats returns NaN otherwise; "
                   "this pipeline uses 100). Relative tolerance %.0e." % tol)
    if out["status"] != "ok":
        log(f"landscape metrics differ from pylandstats (max rel diff {worst:.3g}): {out}", "WARNING")
    else:
        log(f"landscape metrics match pylandstats on {out['n']} windows (max rel diff {worst:.2e})")
    return out


# %% [markdown]
# ## 6.3 Feature grids per frame
# `_s06_base_grids` turns the acquisition globals of one frame into the 33 base grids except the focal-dependent
# ones; `FOCAL_RECOMPUTE` then adds `dist_*` and the 14 focal means. The split is deliberate: section 08
# (recommendations: change base features → recompute focal features, distances held fixed) and section 11
# (projected land cover → recompute focal features **and** distances) call `FOCAL_RECOMPUTE` on modified grids, so
# observed and counterfactual/projected feature fields come from one implementation.

# %%
def FOCAL_RECOMPUTE(grids, recompute_distances=True, roi_mask=None, water_occ=None):
    """Return a copy of ``grids`` with the 14 focal features (and, optionally, the 3 distances) recomputed.

    Parameters
    ----------
    grids : dict feature -> (H, W) array. Must contain the focal bases (``FOCAL_SPEC["bases"]``) and, when
        ``recompute_distances``, ``frac_built`` and ``frac_water``.
    recompute_distances : recompute ``dist_water``, ``dist_urban`` and ``dist_builtup`` (True for new land cover,
        False for small counterfactual edits where distances are held fixed, SPEC §4.4).
    roi_mask : (H, W) bool, default ``ROI_MASK``; cells outside are NaN and never act as targets or neighbours.
    water_occ : (H, W) JRC water occurrence, default ``RAW_STATIC["water_occ"]`` (static).

    Every output grid is float32 with NaN outside the ROI.
    """
    roi = ROI_MASK if roi_mask is None else np.asarray(roi_mask, bool)
    out = dict(grids)
    for base in FOCAL_SPEC["bases"]:
        if base not in grids:
            raise KeyError(f"FOCAL_RECOMPUTE needs the base grid {base!r}")
        for w in FOCAL_SPEC["windows"]:
            out[f"{base}_m{w}"] = np.where(roi, _s06_box_mean(grids[base], w, roi), np.nan).astype(np.float32)
    if recompute_distances:
        res_m = float(GRID.res)
        occ = RAW_STATIC["water_occ"] if water_occ is None else water_occ
        fw = np.nan_to_num(np.asarray(grids["frac_water"], np.float64), nan=0.0)
        fb = np.nan_to_num(np.asarray(grids["frac_built"], np.float64), nan=0.0)
        water_t = roi & ((fw >= 0.3) | (np.nan_to_num(np.asarray(occ, np.float64), nan=0.0) >= 0.5))
        box7_built = np.nan_to_num(_s06_box_mean(np.where(roi, grids["frac_built"], np.nan), 7, roi), nan=0.0)
        out["dist_water"] = np.where(roi, _s06_distance_km(water_t, res_m, "dist_water"), np.nan).astype(np.float32)
        out["dist_urban"] = np.where(roi, _s06_distance_km(_s06_urban_core(box7_built, roi), res_m, "dist_urban"),
                                     np.nan).astype(np.float32)
        out["dist_builtup"] = np.where(roi, _s06_distance_km(roi & (fb >= 0.3), res_m, "dist_builtup"),
                                       np.nan).astype(np.float32)
    return out


def _s06_static_grids():
    """Static terrain grids (1 km): elevation, slope, aspect, topographic position and relief."""
    roi = ROI_MASK
    elev = np.where(roi, RAW_STATIC["elevation"], np.nan).astype(np.float64)
    out = {"elevation": elev, "slope": RAW_STATIC["slope"], "aspect_sin": RAW_STATIC["aspect_sin"],
           "aspect_cos": RAW_STATIC["aspect_cos"],
           "elev_tpi7": _s06_tpi(elev, 7, roi),
           "elev_tpi21": _s06_tpi(elev, 21, roi),
           "elev_std7": _s06_box_std(elev, 7, roi)}
    return {k: np.where(roi, v, np.nan).astype(np.float32) for k, v in out.items()}


def _s06_base_grids(year, static):
    """Base feature grids of one frame (everything except focal means and distances) + LM backend name."""
    raw = RAW_OBS[year]
    roi = ROI_MASK
    min_frac = float(CFG.FINE_MIN_VALID_FRAC)
    g = {}
    for name, key in (("ndvi", "ndvi_f"), ("ndbi", "ndbi_f"), ("mndwi", "mndwi_f"), ("albedo", "albedo_f"),
                      ("ndvi_spring", "ndvi_spring_f")):
        g[name] = _s06_fine_to_cell(raw[key], min_frac)
    g["ndvi_drop"] = g["ndvi_spring"] - g["ndvi"]

    # Land-cover simplex: GHSL built-up fraction + GLC classes rescaled to the non-built share (SPEC §4.1).
    frac_built = np.clip(_s06_fine_to_cell(raw["built_f"], min_frac), 0.0, 1.0)
    glc_b = np.asarray(raw["glc_built"], np.float64)
    with np.errstate(invalid="ignore", divide="ignore"):
        scale = np.where(glc_b >= 0.999, 0.0, (1.0 - frac_built) / (1.0 - glc_b))
    g["frac_built"] = frac_built
    for name, key in (("frac_forest", "glc_forest"), ("frac_water", "glc_water"),
                      ("frac_cropland", "glc_cropland"), ("frac_barren", "glc_barren")):
        g[name] = np.clip(np.asarray(raw[key], np.float64) * scale, 0.0, 1.0)

    g["built_v"] = np.log1p(np.clip(np.asarray(raw["built_v"], np.float64), 0.0, None))
    g["log_pop"] = np.log1p(np.clip(np.asarray(raw["pop"], np.float64), 0.0, None))
    for name in ("era5_t2m", "era5_vpd", "era5_swvl1", "era5_evap", "era5_ssr", "era5_wind", "era5_precip_jfm"):
        g[name] = np.asarray(raw[name], np.float64)
    g.update(static)

    backend = "none"
    if year in LC_FINE:
        f, fine_res = _s06_lc_factor(year)
        lm = _s06_landscape_metrics(LC_FINE[year], f, fine_res, int(CFG.LM_WINDOW_CELLS), roi)
        backend = lm.pop("backend")
        g.update(lm)
    else:
        log(f"06: LC_FINE has no {year} raster - landscape metrics set to NaN", "WARNING")
        for name in ("lm_pd", "lm_ed", "lm_contag"):
            g[name] = np.full(roi.shape, np.nan)
    return {k: np.where(roi, v, np.nan).astype(np.float32) for k, v in g.items()}, backend


def _s06_frame_grids(year, static):
    """All 47 feature grids (H, W) float32 of one observed frame, in ``FEATURES`` order."""
    base, backend = _s06_base_grids(year, static)
    full = FOCAL_RECOMPUTE(base, recompute_distances=True)
    missing = [f for f in FEATURES if f not in full]
    if missing:
        raise RuntimeError(f"06: frame {year} lacks feature grids {missing}")
    return {f: np.ascontiguousarray(full[f], dtype=np.float32) for f in FEATURES}, backend


# %% [markdown]
# ## 6.4 Targets, fixed masks and raw levels
# The day target is aggregated from the fine Landsat composite here (not taken from a 1 km product) so the 1 km
# value is the plain mean of the same 250 m pixels the dashboard shows. Validity rules and weights follow SPEC §3.3;
# the weight down-weights cells whose composite rests on few clear scenes (day) or few composites (night) in both
# fitting and the weighted CV metrics.

# %%
def _s06_targets(year):
    """{mode: {"lst", "nobs", "valid", "weight"}} (H, W) grids of one frame (weights 0 outside training frames)."""
    raw = RAW_OBS[year]
    roi = ROI_MASK
    out = {}
    # ---- day: harmonised Landsat (before the overpass correction) ------------------------------------------------
    lst_day = _s06_fine_to_cell(raw["lst_day_f"], float(CFG.FINE_MIN_VALID_FRAC))
    nobs_f = np.where(ROI_MASK_FINE, np.nan_to_num(np.asarray(raw["lst_day_nobs_f"], np.float32), nan=0.0), np.nan)
    nobs_day = _s06_fine_to_cell(nobs_f, 0.0)
    valid_day = roi & np.isfinite(lst_day) & (np.nan_to_num(nobs_day, nan=0.0) >= float(CFG.DAY_MIN_NOBS))
    w_day = np.where(valid_day, np.clip(np.nan_to_num(nobs_day) / 5.0, 0.4, 1.0), 0.0)
    out["day"] = {"lst": np.where(valid_day, lst_day, np.nan), "nobs": nobs_day, "valid": valid_day,
                  "weight": w_day}
    # ---- night: Aqua-equivalent 1 km (VIIRS counts daily observations) -------------------------------------------
    meta = (FRAME_META.get(year) or {}).get("night") or {}
    source = meta.get("source")
    min_n = float({"viirs_cal": CFG.NIGHT_MIN_NOBS_VIIRS, "terra_cal": CFG.NIGHT_MIN_NOBS_TERRA}.get(
        source, CFG.NIGHT_MIN_NOBS))
    lst_n = np.asarray(raw["lst_night"], np.float64)
    nobs_n = np.nan_to_num(np.asarray(raw["lst_night_nobs"], np.float64), nan=0.0)
    valid_n = roi & np.isfinite(lst_n) & (nobs_n >= min_n)
    train_n = year in set(CFG.NIGHT_TRAIN_FRAMES)
    w_n = np.where(valid_n & train_n, np.clip(nobs_n / 12.0, 0.5, 1.0), 0.0)
    out["night"] = {"lst": np.where(valid_n, lst_n, np.nan), "nobs": nobs_n, "valid": valid_n, "weight": w_n,
                    "source": source, "min_nobs": min_n}
    return out


def _s06_target_coverage(targets, mode):
    """{year: share of the ROI cells with a valid ``mode`` target} for every frame of ``targets``."""
    n_roi = max(int(ROI_MASK.sum()), 1)
    return {int(y): float((targets[y][mode]["valid"] & ROI_MASK).sum()) / n_roi for y in sorted(targets)}


def _s06_check_day_frames(targets):
    """Stop when a day frame has no valid target at all (acquisition fault, SPEC §1.2 / D9)."""
    if "day" not in CFG.MODES:
        return
    cov = _s06_target_coverage(targets, "day")
    empty = [y for y, c in cov.items() if c <= 0.0]
    if empty:
        raise RuntimeError(
            f"06: day frame(s) {empty} have no valid Landsat target in any ROI cell (an acquisition fault: every "
            f"observed day frame must be observed or observed-sparse). Valid-target share of the ROI per frame: "
            + ", ".join(f"{y}: {c:.1%}" for y, c in cov.items())
            + ". Check section 03 for that frame (scenes per path/row, QA / ST band filtering).")


def _s06_fixed_masks(targets, train_frames):
    """FIXED_MASK per mode (strict intersection over the well-covered training frames, D8) + info, caveats.

    Returns (masks, info, coverage, caveats): ``coverage[mode][year]`` = share of the FIXED_MASK cells with a valid
    target at that frame (every frame; 1.0 for the mask frames); ``info[mode]`` holds the rule, the mask frames,
    each frame's valid share of the ROI (``coverage``), the training frames left out (``excluded_frames``, weight 0),
    the cell count and share of the ROI.
    """
    masks, info, coverage, caveats = {}, {}, {}, []
    n_roi = int(ROI_MASK.sum())
    thr = float(_S06_FRAME_MIN_COVERAGE)
    for mode in CFG.MODES:
        cov = _s06_target_coverage(targets, mode)
        frames = [y for y in train_frames[mode] if y in targets]
        mask_frames = [y for y in frames if cov[y] >= thr]
        excluded = [y for y in frames if cov[y] < thr]
        if len(mask_frames) < 2:
            raise RuntimeError(
                f"06: mode {mode} has only {len(mask_frames)} training frame(s) with a valid-target share of the ROI "
                f">= {thr:.0%} (LST_FRAME_MIN_COVERAGE); at least 2 are needed for a fixed mask. Coverage of the "
                f"training frames: " + ", ".join(f"{y}: {cov[y]:.1%}" for y in frames))
        mask = ROI_MASK.copy()
        for y in mask_frames:
            mask &= targets[y][mode]["valid"]
        share = float(mask.sum()) / max(n_roi, 1)
        if share < 0.01:
            raise RuntimeError(
                f"06: FIXED_MASK[{mode}] (cells valid in every mask frame {mask_frames}) keeps only {int(mask.sum())} "
                f"cells ({share:.2%} of the ROI); the valid-target sets of the frames barely overlap. Coverage: "
                + ", ".join(f"{y}: {cov[y]:.1%}" for y in frames))
        if share < _S06_FIXED_MASK_WARN_SHARE:
            text = (f"The {mode} fixed mask (cells with a valid target in every training frame with >= {thr:.0%} "
                    f"coverage) keeps only {share:.1%} of the ROI cells; missing share of the ROI per frame: "
                    + ", ".join(f"{y} {1.0 - cov[y]:.1%}" for y in mask_frames)
                    + ". Frame levels and anomalies refer to this cell set.")
            log("06: " + text, "WARNING")
            caveats.append(text)
        if excluded:
            text = (f"{mode} training frame(s) " + ", ".join(f"{y} ({cov[y]:.1%} of the ROI valid)" for y in excluded)
                    + f" are below the {thr:.0%} coverage threshold (LST_FRAME_MIN_COVERAGE): they keep their "
                    "observations but are left out of the fixed mask and of model training (weight 0); their "
                    "level gets a model-based composition correction (section 09).")
            log("06: " + text, "WARNING")
            caveats.append(text)
        n_fixed = max(int(mask.sum()), 1)
        coverage[mode] = {int(y): (1.0 if y in mask_frames
                                   else float((mask & targets[y][mode]["valid"]).sum()) / n_fixed)
                          for y in sorted(targets)}
        masks[mode] = mask
        info[mode] = {"rule": f"valid in every training frame with >= {thr:g} valid-target coverage of the ROI",
                      "frames": list(mask_frames), "training_frames": list(frames), "excluded_frames": list(excluded),
                      "coverage": {int(y): round(cov[y], 4) for y in cov}, "min_coverage": thr,
                      "n_cells": int(mask.sum()), "share": round(share, 4)}
        log(f"06: FIXED_MASK[{mode}]: {int(mask.sum()):,} cells ({share:.1%} of the ROI; strict intersection of mask "
            f"frames {mask_frames}" + (f"; excluded {excluded}" if excluded else "") + ")")
    return masks, info, coverage, caveats


# %% [markdown]
# ## 6.5 Cross-validation blocks and greedy fold assignment
# Blocks are numbered in grid row-major order from the grid's top-left corner (`block_id = (row // b) ·
# ceil(W / b) + col // b`), the convention of the dashboard fold map. Fold sizes are balanced on **ROI cell
# counts**, which are identical in every frame, so a cell (and its whole block) belongs to one fold in every frame
# and mode — the condition that keeps a cell's own past and future out of its training set.

# %%
def _s06_block_grid(block_cells):
    """(H, W) int32 block ids of square blocks of ``block_cells`` cells (row-major from the top-left)."""
    h, w = ROI_MASK.shape
    b = max(1, int(block_cells))
    rows, cols = np.indices((h, w))
    return ((rows // b) * _s06_math.ceil(w / b) + cols // b).astype(np.int32)


def _s06_greedy_block_folds(block_counts, n_folds):
    """Deterministic size-balanced assignment: largest block first → currently smallest fold (ties: lowest id)."""
    order = sorted((b for b, c in block_counts.items() if c > 0), key=lambda b: (-block_counts[b], b))
    if len(order) < n_folds:
        log(f"only {len(order)} non-empty blocks for {n_folds} folds - some folds will be empty", "WARNING")
    load = np.zeros(n_folds, dtype=np.int64)
    assignment = {}
    for block in order:
        fold = int(np.argmin(load))
        assignment[block] = fold
        load[fold] += block_counts[block]
    return assignment, load


def _s06_fold_grid(block_grid, n_folds):
    """(H, W) int16 fold of every ROI cell (−1 outside) from greedy size balancing of ``block_grid`` blocks."""
    ids = block_grid[ROI_MASK]
    uniq, counts = np.unique(ids, return_counts=True)
    assignment, load = _s06_greedy_block_folds(dict(zip(uniq.tolist(), counts.tolist())), int(n_folds))
    lut = np.full(int(block_grid.max()) + 1, -1, dtype=np.int16)
    for block, fold in assignment.items():
        lut[block] = fold
    fold = np.where(ROI_MASK, lut[block_grid], -1).astype(np.int16)
    return fold, load


def _s06_cv_grids():
    """Block-id and fold grids for all schemes + a summary dict."""
    h, w = ROI_MASK.shape
    res = float(GRID.res)
    b20 = max(1, int(round(float(CFG.BLOCK_KM) * 1000.0 / res)))
    b10 = max(1, int(round(float(CFG.INNER_BLOCK_KM) * 1000.0 / res)))
    block20 = _s06_block_grid(b20)
    block10 = _s06_block_grid(b10)
    nby, nbx = (int(v) for v in CFG.SPATIAL_BLOCKS)
    rows, cols = np.indices((h, w))
    tiles5 = ((rows * nby // h) * nbx + cols * nbx // w).astype(np.int32)
    fold20, load20 = _s06_fold_grid(block20, int(CFG.N_FOLDS_BLOCK))
    fold5, load5 = _s06_fold_grid(tiles5, int(CFG.N_FOLDS))
    info = {"block20_cells": b20, "block20_km_actual": b20 * res / 1000.0, "block10_cells": b10,
            "n_block20": int(np.unique(block20[ROI_MASK]).size), "n_block10": int(np.unique(block10[ROI_MASK]).size),
            "fold_block20_cells": load20.tolist(), "fold_block5_cells": load5.tolist(),
            "block5_tiles": [nby, nbx]}
    log(f"06: blocks20 = {b20}x{b20} cells ({info['block20_km_actual']:g} km; {info['n_block20']} non-empty) -> "
        f"{CFG.N_FOLDS_BLOCK} folds of {load20.tolist()} cells; v1 5x5 tiles -> folds {load5.tolist()}; "
        f"inner blocks {b10}x{b10} cells")
    return {"block20": block20, "block10": block10, "tiles5": tiles5, "fold20": fold20, "fold5": fold5}, info


# %% [markdown]
# ## 6.6 Assemble `DF`, `FEATURE_GRIDS`, `FIXED_MASK`, `RAW_LEVELS` (stage-cached)
# Frames are stacked in `CFG.FRAMES_OBS` order, cells in canonical order inside every frame, so `DF` is sorted by
# (`year`, `cell_id`) by construction and frame `j` occupies rows `[j·N_CELLS, (j+1)·N_CELLS)` — later sections can
# slice frames without a search. The stage-cache key contains a fingerprint of the acquisition globals (sums and
# valid counts of every raster), so a changed input layer can never reuse stale features.

# %%
_S06_DF_DTYPES = {
    "cell_id": "int32", "row": "int32", "col": "int32", "x": "float64", "y": "float64",
    "lon": "float64", "lat": "float64", "district": "int16", "year": "int16",
    **{name: "float32" for name in FEATURES},
    "lst_day": "float32", "lst_night": "float32", "w_day": "float32", "w_night": "float32",
    "anom_day": "float32", "anom_night": "float32",
    "fold_block5": "int8", "fold_block20": "int8", "fold_random": "int8",
    "block10_id": "int32", "block20_id": "int32", "fold_district": "int16",
}


def _s06_fingerprint():
    """SHA-1 over cheap summaries (nansum, finite count) of every acquisition raster used by this section."""
    h = _s06_hashlib.sha1()

    def add(tag, arr):
        a = np.asarray(arr)
        if a.dtype.kind in "fc":
            fin = np.isfinite(a)
            h.update(f"{tag}:{a.shape}:{float(np.sum(a, where=fin, dtype=np.float64)):.9e}:{int(fin.sum())};"
                     .encode())
        else:
            h.update(f"{tag}:{a.shape}:{int(a.astype(np.int64).sum())}:{int(np.count_nonzero(a))};".encode())

    for key in sorted(RAW_STATIC):
        add(f"static/{key}", RAW_STATIC[key])
    for year in sorted(RAW_OBS):
        for key in sorted(RAW_OBS[year]):
            add(f"{year}/{key}", RAW_OBS[year][key])
    for year in sorted(LC_FINE):
        add(f"lc/{year}", np.bincount(np.asarray(LC_FINE[year]).ravel(), minlength=8))
    add("roi", ROI_MASK)
    add("district", DISTRICT_IDX)
    h.update(repr(sorted((int(y), (((m or {}).get("night")) or {}).get("source"))
                         for y, m in FRAME_META.items())).encode())
    return h.hexdigest()[:16]


def _s06_build():
    """Compute every product of section 06; returns a dict (the stage-cache payload)."""
    t_start = _s06_time.perf_counter()
    frames = [int(y) for y in CFG.FRAMES_OBS if int(y) in RAW_OBS]
    missing = sorted(set(int(y) for y in CFG.FRAMES_OBS) - set(frames))
    if missing:
        raise RuntimeError(f"06: RAW_OBS lacks observed frames {missing}")
    if GRID_FINE.shape != (GRID.height * CFG.FINE_FACTOR, GRID.width * CFG.FINE_FACTOR):
        raise RuntimeError(f"06: GRID_FINE {GRID_FINE.shape} is not GRID x FINE_FACTOR")

    with timer("06_static_grids"):
        static = _s06_static_grids()
    grids, targets, backends = {}, {}, {}
    for year in frames:
        t0 = _s06_time.perf_counter()
        with timer(f"06_feature_grids_{year}"):
            grids[year], backends[year] = _s06_frame_grids(year, static)
            targets[year] = _s06_targets(year)
        log(f"06: frame {year}: features ready in {_s06_time.perf_counter() - t0:.1f}s (landscape metrics on "
            f"{backends[year]}); day targets {int(targets[year]['day']['valid'].sum()):,}, night targets "
            f"{int(targets[year]['night']['valid'].sum()):,} "
            f"(night source {targets[year]['night']['source']}, min nobs {targets[year]['night']['min_nobs']:g})")
    _s06_check_day_frames(targets)
    train_frames = {"day": list(frames), "night": [y for y in CFG.NIGHT_TRAIN_FRAMES if y in frames]}
    fixed, fixed_info, fixed_cov, caveats = _s06_fixed_masks(targets, train_frames)
    # under-covered training frames keep their observations (anomalies, levels) but do not train (D8)
    for mode in CFG.MODES:
        for y in fixed_info[mode]["excluded_frames"]:
            targets[y][mode]["weight"] = np.zeros_like(targets[y][mode]["weight"])
        train_frames[mode] = [y for y in train_frames[mode] if y not in fixed_info[mode]["excluded_frames"]]

    # ---- anomalies over the fixed mask + raw levels ---------------------------------------------------------------
    raw_levels = {m: {} for m in CFG.MODES}
    anoms = {m: {} for m in CFG.MODES}
    for year in frames:
        for mode in CFG.MODES:
            t = targets[year][mode]
            sel = fixed[mode] & t["valid"]
            level = float(np.mean(t["lst"][sel])) if sel.any() else float("nan")
            raw_levels[mode][year] = level
            anoms[mode][year] = (t["lst"] - level) if np.isfinite(level) else np.full(ROI_MASK.shape, np.nan)
            if t["valid"].any() and not sel.any():
                log(f"06: {mode} {year}: valid targets but no fixed-mask cell - anomaly undefined", "WARNING")

    # ---- CV grids and the long table ----------------------------------------------------------------------------
    cv, cv_info = _s06_cv_grids()
    r, c = CELL_ROWS, CELL_COLS
    n_cells, n_frames = int(N_CELLS), len(frames)
    X, Y = GRID.cell_centers_xy()
    tile = lambda a: np.tile(np.asarray(a), n_frames)  # noqa: E731 - canonical cell order repeated per frame
    cols = {
        "cell_id": tile(CELL_IDS), "row": tile(r), "col": tile(c),
        "x": tile(np.asarray(X, np.float64)[r, c]), "y": tile(np.asarray(Y, np.float64)[r, c]),
        "lon": tile(CELL_LON), "lat": tile(CELL_LAT), "district": tile(DISTRICT_IDX[r, c]),
        "year": np.repeat(np.asarray(frames, np.int16), n_cells),
    }
    for name in FEATURES:
        cols[name] = np.concatenate([grids[y][name][r, c] for y in frames])
    for mode in CFG.MODES:
        cols[f"lst_{mode}"] = np.concatenate([targets[y][mode]["lst"][r, c] for y in frames])
        cols[f"w_{mode}"] = np.concatenate([targets[y][mode]["weight"][r, c] for y in frames])
        cols[f"anom_{mode}"] = np.concatenate([anoms[mode][y][r, c] for y in frames])
    cols["fold_block5"] = tile(cv["fold5"][r, c])
    cols["fold_block20"] = tile(cv["fold20"][r, c])
    n_rows = n_cells * n_frames
    perm = np.random.default_rng(CFG.SEED).permutation(n_rows)
    fold_random = np.empty(n_rows, dtype=np.int8)
    fold_random[perm] = np.arange(n_rows) % int(CFG.N_FOLDS)
    cols["fold_random"] = fold_random
    cols["block10_id"] = tile(cv["block10"][r, c])
    cols["block20_id"] = tile(cv["block20"][r, c])
    cols["fold_district"] = tile(DISTRICT_IDX[r, c])
    frame = pd.DataFrame({k: cols[k] for k in _S06_DF_DTYPES}).astype(_S06_DF_DTYPES)
    frame.index = pd.RangeIndex(len(frame))
    del cols

    frame_info = {
        "frames": frames, "train_frames": train_frames, "fixed_mask": fixed_info, "cv": cv_info,
        "lm_backend": backends, "caveats": caveats,
        "targets": {int(y): {m: {"n_valid": int(targets[y][m]["valid"].sum()),
                                 "n_train": int((targets[y][m]["weight"] > 0).sum()),
                                 "mean_weight": (float(targets[y][m]["weight"][targets[y][m]["weight"] > 0].mean())
                                                 if (targets[y][m]["weight"] > 0).any() else None)}
                         for m in CFG.MODES} for y in frames},
        "seconds": round(_s06_time.perf_counter() - t_start, 1),
    }
    with timer("06_lm_validation"):
        lm_validation = _s06_validate_landscape_metrics(n=120)
    return {"FEATURE_GRIDS": grids, "DF": frame, "FIXED_MASK": fixed, "FIXED_MASK_COVERAGE": fixed_cov,
            "RAW_LEVELS": raw_levels, "LM_VALIDATION": lm_validation, "info": frame_info}


# Cross-section code: _s06_fine_to_cell uses block_mean of section 01, a shared helper covered by SHARED_CODE_TAG.
_s06_key = CFG.key("LM_WINDOW_CELLS", "BLOCK_KM", "N_FOLDS_BLOCK", "INNER_BLOCK_KM", "N_FOLDS", "SPATIAL_BLOCKS",
                   "DAY_MIN_NOBS", "FINE_MIN_VALID_FRAC", "NIGHT_MIN_NOBS", "NIGHT_MIN_NOBS_VIIRS", "NIGHT_MIN_NOBS_TERRA",
                   "NIGHT_TRAIN_FRAMES", "MODES", features=FEATURES, version=_S06_VERSION,
                   frame_min_coverage=_S06_FRAME_MIN_COVERAGE, fingerprint=_s06_fingerprint())
with timer("06_features"):
    _s06_payload = stage_cache("06_features", _s06_key).get_or_compute(_s06_build)
FEATURE_GRIDS = _s06_payload["FEATURE_GRIDS"]
DF = _s06_payload["DF"]
FIXED_MASK = _s06_payload["FIXED_MASK"]
FIXED_MASK_COVERAGE = {m: {int(y): float(v) for y, v in c.items()}
                       for m, c in _s06_payload["FIXED_MASK_COVERAGE"].items()}
RAW_LEVELS = _s06_payload["RAW_LEVELS"]
LM_VALIDATION = _s06_payload["LM_VALIDATION"]
_S06_INFO = _s06_payload["info"]
del _s06_payload
free_memory()
# caveats are part of the cached payload, so a resumed run reports them too
if not isinstance(globals().get("DATA_CAVEATS"), list):
    DATA_CAVEATS = []
for _s06_c in _S06_INFO.get("caveats", []):
    if _s06_c not in DATA_CAVEATS:
        DATA_CAVEATS.append(_s06_c)
        log("06 caveat: " + _s06_c, "WARNING")
log(f"06: DF {len(DF):,} rows x {DF.shape[1]} columns ({DF.memory_usage(deep=False).sum() / 2**20:.0f} MiB); "
    f"frames {_S06_INFO['frames']}; training rows day {int((DF['w_day'] > 0).sum()):,}, night "
    f"{int((DF['w_night'] > 0).sum()):,}")
log("06: RAW_LEVELS (°C, fixed-mask mean, day before overpass correction): "
    + "; ".join(f"{m}: " + ", ".join(f"{y}={v:.2f}" for y, v in RAW_LEVELS[m].items() if np.isfinite(v))
                for m in CFG.MODES))


def _s06_coverage_table():
    """Per frame and mode: valid share of the ROI, share of FIXED_MASK valid, training rows, mask frame or not."""
    years = DF["year"].to_numpy()
    rows = []
    for y in _S06_INFO["frames"]:
        row = {"year": int(y)}
        for m in CFG.MODES:
            fm = _S06_INFO["fixed_mask"][m]
            row[f"{m}_valid_share_roi"] = fm["coverage"].get(int(y))
            row[f"{m}_fixed_mask_valid"] = FIXED_MASK_COVERAGE[m].get(int(y))
            row[f"{m}_train_rows"] = int(((years == y) & (DF[f"w_{m}"].to_numpy() > 0)).sum())
            row[f"{m}_role"] = ("mask" if int(y) in fm["frames"] else
                                ("excluded" if int(y) in fm["excluded_frames"] else "-"))
        rows.append(row)
    return pd.DataFrame(rows)


print(f"Target coverage per frame (mask frames need >= {_S06_FRAME_MIN_COVERAGE:.0%} of the ROI valid; "
      "FIXED_MASK = cells valid in every mask frame):")
print(_s06_coverage_table().round(4).to_string(index=False))

# %% [markdown]
# ## 6.7 Feature metadata (`FEATURE_META`) and statistics (`FEATURE_STATS`)
# `FEATURE_META` drives every label in the dashboard. Keys: v1's `label, unit, group, description, source,
# actionable, display` plus `family` (dominant-driver colouring) and `base` (False for the 14 focal means);
# `group` is the SHAP group (§4.4). `actionable` marks the levers a planner can move directly: the five land-cover
# fractions, NDVI (greening within existing covers) and the three landscape-configuration metrics. Focal means,
# distances, NDBI/MNDWI/albedo, terrain, population and climate respond to those levers or are context.

# %%
_S06_SRC_LANDSAT = "Landsat C2 L2 SR (30 m, TM/ETM+ → OLI harmonised), Apr–Jun median, 1 km mean of fine pixels"
_S06_SRC_ERA5 = "ERA5-Land monthly (Apr–Jun of the frame window), bilinear to 1 km"
_S06_META_ROWS = [
    # name, label, unit, display, source, description
    ("ndvi", "NDVI", "", "index", _S06_SRC_LANDSAT,
     "Normalised Difference Vegetation Index; denser, greener vegetation cools the surface by transpiration and "
     "shading."),
    ("ndbi", "NDBI", "", "index", _S06_SRC_LANDSAT,
     "Normalised Difference Built-up Index (SWIR1 vs NIR); high for built-up and bare, dry surfaces."),
    ("mndwi", "MNDWI", "", "index", _S06_SRC_LANDSAT,
     "Modified Normalised Difference Water Index (green vs SWIR1); high for open water and wet surfaces."),
    ("albedo", "Albedo", "", "index", _S06_SRC_LANDSAT + " (Liang 2001 shortwave albedo)",
     "Broadband shortwave albedo; bright surfaces absorb less solar radiation."),
    ("ndvi_spring", "NDVI (Feb–Mar)", "", "index", "Landsat C2 L2 SR, Feb–Mar median of the frame window",
     "Late-winter NDVI, when the rabi crop (wheat, mustard) is green."),
    ("ndvi_drop", "NDVI drop (spring − season)", "", "index", "ndvi_spring − ndvi",
     "Loss of greenness from Feb–Mar to Apr–Jun; large where crops were harvested and fields lie bare and hot."),
    ("frac_built", "Built-up fraction", "fraction", "percent", "JRC GHSL P2023A GHS_BUILT_S, 1 km mean",
     "Share of the cell covered by buildings and other built-up surfaces."),
    ("frac_forest", "Tree cover", "fraction", "percent", "GLC_FCS30D forest classes on the GHSL simplex",
     "Share of the cell under trees / forest."),
    ("frac_water", "Water", "fraction", "percent", "GLC_FCS30D water on the GHSL simplex",
     "Share of the cell covered by open water (rivers, canals, lakes, jheels)."),
    ("frac_cropland", "Cropland", "fraction", "percent", "GLC_FCS30D cropland on the GHSL simplex",
     "Share of the cell under cultivation."),
    ("frac_barren", "Barren land", "fraction", "percent", "GLC_FCS30D bare areas on the GHSL simplex",
     "Share of the cell that is bare soil, sand or rock."),
    ("built_v", "Built volume (log1p m³/m²)", "log1p(m³/m²)", "number", "JRC GHSL P2023A GHS_BUILT_V, 1 km mean",
     "Building volume per unit ground area (log); stores daytime heat and releases it at night."),
    ("log_pop", "Population density (log)", "log1p(persons/km²)", "number", "JRC GHSL P2023A GHS_POP, 1 km mean",
     "Residents per km² (log); proxy for anthropogenic heat and building density."),
    ("dist_urban", "Distance to urban core", "km", "number", "derived: distance to cells with 7-cell mean built ≥ 0.3",
     "Euclidean distance to the nearest dense urban core."),
    ("dist_builtup", "Distance to built-up", "km", "number", "derived: distance to cells with built fraction ≥ 0.3",
     "Euclidean distance to the nearest substantially built-up cell."),
    ("lm_pd", "Patch density", "patches/100 ha", "number", "FRAGSTATS PD on GLC_FCS30D fine land cover",
     "Number of land-cover patches (8-connected) per 100 ha; higher = more fragmented mosaic."),
    ("lm_ed", "Edge density", "m/ha", "number", "FRAGSTATS ED on GLC_FCS30D fine land cover",
     "Length of boundaries between different land-cover classes per hectare."),
    ("lm_contag", "Contagion", "%", "number", "FRAGSTATS CONTAG on GLC_FCS30D fine land cover",
     "Aggregation of land-cover classes (0 = maximally interspersed, 100 = one contiguous class)."),
    ("dist_water", "Distance to water", "km", "number",
     "derived: distance to cells with water fraction ≥ 0.3 or JRC water occurrence ≥ 50 %",
     "Euclidean distance to the nearest river, canal or lake cell."),
    ("elevation", "Elevation", "m", "number", "SRTM GL1 (30 m), cell mean",
     "Mean terrain height; air and surface temperature fall with altitude."),
    ("slope", "Slope", "°", "number", "SRTM GL1 (30 m), cell mean",
     "Mean terrain slope; steep Aravalli ridges change solar exposure and land use."),
    ("aspect_sin", "Aspect (east-west)", "", "index", "SRTM GL1, sin(aspect) averaged at 30 m",
     "Sine of terrain aspect: +1 east-facing, −1 west-facing slopes."),
    ("aspect_cos", "Aspect (north-south)", "", "index", "SRTM GL1, cos(aspect) averaged at 30 m",
     "Cosine of terrain aspect: +1 north-facing, −1 south-facing (sun-exposed) slopes."),
    ("elev_tpi7", "Topographic position (7 km)", "m", "number", "derived: elevation − 7-cell mean",
     "Height above (+) or below (−) the surrounding 7 × 7 cells; valleys collect cold air at night."),
    ("elev_tpi21", "Topographic position (21 km)", "m", "number", "derived: elevation − 21-cell mean",
     "Height relative to the wider 21 × 21-cell landscape (ridges vs basins)."),
    ("elev_std7", "Relief (7 km std)", "m", "number", "derived: 7-cell standard deviation of elevation",
     "Local relief; high on the Aravalli ridges, ~0 on the Indo-Gangetic plain."),
    ("era5_t2m", "Air temperature (ERA5-Land)", "°C", "number", _S06_SRC_ERA5,
     "Mean 2 m air temperature; carries the regional climate gradient."),
    ("era5_vpd", "Vapour-pressure deficit", "kPa", "number", _S06_SRC_ERA5 + " (Magnus formula)",
     "Atmospheric drying power; high VPD favours dry, hot surfaces."),
    ("era5_swvl1", "Soil moisture (0–7 cm)", "m³/m³", "number", _S06_SRC_ERA5,
     "Top-soil volumetric water content; wet soils evaporate and warm slowly."),
    ("era5_evap", "Evaporation", "mm/day", "number", _S06_SRC_ERA5 + " (positive = evaporation)",
     "Total evaporation; latent heat flux that cools the surface."),
    ("era5_ssr", "Net solar radiation", "MJ/m²/day", "number", _S06_SRC_ERA5,
     "Surface net shortwave radiation; the energy that heats the surface by day."),
    ("era5_wind", "Wind speed", "m/s", "number", _S06_SRC_ERA5 + " (√(u² + v²) at 10 m)",
     "10 m wind speed; mixing reduces surface–air temperature contrasts."),
    ("era5_precip_jfm", "Winter precipitation (Jan–Mar)", "mm", "number",
     "ERA5-Land monthly total precipitation, Jan–Mar of the window years",
     "Antecedent winter rain; recharges soil moisture before the pre-monsoon heat."),
]
_S06_ACTIONABLE = {"frac_built", "frac_forest", "frac_water", "frac_cropland", "frac_barren", "ndvi",
                   "lm_pd", "lm_ed", "lm_contag"}


def _s06_feature_meta():
    """FEATURE_META in FEATURES order (base rows + focal rows derived from their base)."""
    rows = {name: (label, unit, display, source, desc) for name, label, unit, display, source, desc in _S06_META_ROWS}
    if list(rows) != BASE_FEATURES:
        raise AssertionError("FEATURE_META base rows must follow BASE_FEATURES order")
    meta = OrderedDict()
    for name in FEATURES:
        if name in rows:
            label, unit, display, source, desc = rows[name]
            base = True
        else:
            base_name, w = name.rsplit("_m", 1)
            b_label, unit, display, b_source, b_desc = rows[base_name]
            label = f"{b_label} ({w}-cell mean)"
            source = f"derived: NaN-aware {w} × {w}-cell box mean of {base_name}"
            desc = (f"Neighbourhood mean of {b_label} over {w} × {w} cells ({int(w) * GRID.res / 1000:g} km); "
                    f"captures the cooling or warming reach of the surrounding land.")
            base = False
        meta[name] = {"label": label, "unit": unit, "group": _S06_GROUP_OF[name], "description": desc,
                      "source": source, "actionable": name in _S06_ACTIONABLE, "display": display,
                      "family": _S06_FAMILY[name], "base": base}
    return meta


FEATURE_META = _s06_feature_meta()
if list(FEATURE_META) != FEATURES:
    raise AssertionError("FEATURE_META order must match FEATURES")


def _s06_feature_stats(frame):
    """Robust summary per feature over all DF rows (NaN-aware; NaN when a feature is entirely missing)."""
    summary = {}
    for name in FEATURES:
        v = frame[name].to_numpy(np.float64)
        v = v[np.isfinite(v)]
        if v.size == 0:
            summary[name] = {k: float("nan") for k in ("min", "max", "p01", "p99", "median", "mean", "std")}
            summary[name]["missing"] = 1.0
            continue
        p01, p99, med = np.percentile(v, [1, 99, 50])
        summary[name] = {"min": float(v.min()), "max": float(v.max()), "p01": float(p01), "p99": float(p99),
                         "median": float(med), "mean": float(v.mean()),
                         "std": float(v.std(ddof=1)) if v.size > 1 else 0.0,
                         "missing": round(1.0 - v.size / max(len(frame), 1), 5)}
    return summary


FEATURE_STATS = _s06_feature_stats(DF)

# %% [markdown]
# ## 6.8 Diagnostics
# * rows, targets and weights per frame; feature means per frame (shifts in the land-surface mix);
# * Spearman rank correlations on a seeded sample of rows (pairs with |ρ| > 0.9 are flagged: they split SHAP credit
#   arbitrarily, which is why SHAP is reported per **group** — focal means and their base share a group);
# * variance inflation factors $\mathrm{VIF}_j = 1/(1-R_j^2)$ on standardised complete cases (sample);
# * missingness per feature and frame.

# %%
def _s06_show(obj):
    """display() inside a notebook kernel, full-width print() in plain scripts."""
    import sys

    if "ipykernel" in sys.modules:
        try:
            from IPython.display import display

            display(obj)
            return
        except Exception:  # noqa: BLE001
            pass
    print(obj.to_string() if isinstance(obj, pd.DataFrame) else obj)


def _s06_vif(data):
    """VIF per column of a complete-case float64 matrix via least squares on standardised data."""
    out = pd.Series(np.nan, index=FEATURES, name="VIF")
    if data.shape[0] < len(FEATURES) + 2:
        log(f"VIF skipped: only {data.shape[0]} complete rows", "WARNING")
        return out
    std = data.std(axis=0)
    usable = std > 0
    z = (data[:, usable] - data[:, usable].mean(axis=0)) / std[usable]
    names = [n for n, u in zip(FEATURES, usable) if u]
    for j, name in enumerate(names):
        others = np.delete(z, j, axis=1)
        design = np.column_stack([np.ones(len(z)), others])
        coef, *_ = np.linalg.lstsq(design, z[:, j], rcond=None)
        resid = z[:, j] - design @ coef
        r2 = 1.0 - resid @ resid / (z[:, j] @ z[:, j])
        out[name] = np.inf if r2 >= 1.0 - 1e-12 else 1.0 / (1.0 - r2)
    return out


def _s06_plot_spearman(corr):
    """Spearman heatmap of the 47 predictors (diverging, fixed [-1, 1]; family-coloured tick labels)."""
    import matplotlib.pyplot as plt
    from matplotlib.colors import LinearSegmentedColormap

    cmap = LinearSegmentedColormap.from_list("div", ["#2a78d6", "#f0efec", "#e34948"])
    fam_colors = {"spectral": "#15803d", "landcover": "#b45309", "urban": "#be123c", "water": "#0369a1",
                  "terrain": "#57534e", "climate": "#7c3aed"}
    fig, ax = plt.subplots(figsize=(13, 11.5))
    im = ax.imshow(corr.to_numpy(), cmap=cmap, vmin=-1, vmax=1)
    ax.set_xticks(range(len(FEATURES)))
    ax.set_xticklabels(FEATURES, rotation=90, fontsize=6.5)
    ax.set_yticks(range(len(FEATURES)))
    ax.set_yticklabels(FEATURES, fontsize=6.5)
    for lbl in list(ax.get_xticklabels()) + list(ax.get_yticklabels()):
        lbl.set_color(fam_colors.get(_S06_FAMILY.get(lbl.get_text()), "#000000"))
    fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04, label="Spearman ρ")
    ax.set_title("Spearman rank correlation of the 47 predictors (tick colour = family)")
    fig.tight_layout()
    fig.savefig(Path(CFG.FIG_DIR) / "06_spearman_correlation.png", dpi=140)
    plt.show()
    plt.close(fig)


def _s06_plot_maps():
    """Selected feature grids and the fixed masks of the last observed frame."""
    import matplotlib.pyplot as plt

    year = _S06_INFO["frames"][-1]
    g = FEATURE_GRIDS[year]
    panels = [("ndvi", "viridis"), ("ndvi_m15", "viridis"), ("frac_built", "magma"), ("frac_built_m15", "magma"),
              ("dist_water", "cividis"), ("elev_tpi21", "BrBG"), ("lm_ed", "plasma"), ("era5_t2m", "inferno")]
    fig, axes = plt.subplots(2, 5, figsize=(19, 7.6))
    for ax, (name, cmap) in zip(axes.ravel(), panels):
        arr = g[name]
        lo, hi = np.nanpercentile(arr, [1, 99]) if np.isfinite(arr).any() else (0, 1)
        im = ax.imshow(arr, cmap=cmap, vmin=lo, vmax=hi)
        ax.set_title(f"{name} {year}", fontsize=9)
        ax.set_axis_off()
        fig.colorbar(im, ax=ax, fraction=0.046, pad=0.02)
    for ax, mode in zip(axes.ravel()[len(panels):], CFG.MODES):
        show = np.where(ROI_MASK, FIXED_MASK[mode].astype(float), np.nan)
        ax.imshow(show, cmap="Greys", vmin=-0.3, vmax=1.0)
        ax.set_title(f"FIXED_MASK[{mode}] ({_S06_INFO['fixed_mask'][mode]['share']:.1%} of ROI)", fontsize=9)
        ax.set_axis_off()
    fig.suptitle(f"Feature grids ({GRID.res} m grid; focal windows in cells)", fontsize=11)
    fig.tight_layout()
    fig.savefig(Path(CFG.FIG_DIR) / "06_feature_maps.png", dpi=120)
    plt.show()
    plt.close(fig)


def _s06_run_diagnostics(frame, max_rows=60000):
    """Print per-frame tables, correlations, VIF and missingness; returns the tables."""
    Path(CFG.FIG_DIR).mkdir(parents=True, exist_ok=True)
    per_frame = pd.DataFrame([
        {"year": y, **{f"{m}_{k}": v for m in CFG.MODES for k, v in _S06_INFO["targets"][y][m].items()},
         "level_day_raw": RAW_LEVELS["day"].get(y), "level_night_raw": RAW_LEVELS["night"].get(y)}
        for y in _S06_INFO["frames"]])
    print("Targets per frame (valid / training cells, mean weight, raw fixed-mask level °C):")
    _s06_show(per_frame.round(3))
    means = frame.groupby("year")[BASE_FEATURES].mean().T
    print("Base-feature means per frame:")
    _s06_show(means.round(3))

    rng = np.random.default_rng(CFG.SEED)
    sample = frame.iloc[np.sort(rng.choice(len(frame), size=min(max_rows, len(frame)), replace=False))]
    corr = sample[FEATURES].corr(method="spearman")
    high = [(a, b, float(corr.at[a, b])) for i, a in enumerate(FEATURES) for b in FEATURES[i + 1:]
            if np.isfinite(corr.at[a, b]) and abs(corr.at[a, b]) > 0.9]
    for a, b, rho in high:
        same = _S06_GROUP_OF[a] == _S06_GROUP_OF[b]
        log(f"06: highly correlated pair {a} ~ {b} (Spearman rho = {rho:+.2f}; "
            f"{'same SHAP group' if same else 'DIFFERENT SHAP groups'})", "INFO" if same else "WARNING")
    if not high:
        log("06: no predictor pair exceeds |Spearman rho| = 0.9")
    _s06_plot_spearman(corr)

    data = sample[FEATURES].to_numpy(np.float64)
    data = data[np.isfinite(data).all(axis=1)][:30000]
    vif = _s06_vif(data)
    missing = frame.groupby("year")[FEATURES].apply(lambda g: g.isna().mean()).T
    missing["overall"] = frame[FEATURES].isna().mean()
    summary = pd.DataFrame({"family": [_S06_FAMILY[f] for f in FEATURES], "group": [_S06_GROUP_OF[f] for f in FEATURES],
                            "VIF": vif, "missing_overall": missing["overall"]}, index=FEATURES)
    print("VIF (complete-case sample) and missing share per feature:")
    _s06_show(summary.round(3))
    high_vif = [n for n, v in vif.items() if np.isfinite(v) and v > 10]
    if high_vif:
        log(f"06: VIF > 10 for {high_vif} (expected for focal means of smooth fields; SHAP is grouped)")
    try:
        _s06_plot_maps()
    except Exception as exc:  # noqa: BLE001 - a figure must never stop the pipeline
        log(f"06: feature-map figure failed: {exc!r}", "WARNING")
    return {"per_frame": per_frame, "spearman": corr, "high_corr_pairs": high, "vif": vif, "missing": missing}


with timer("06_diagnostics"):
    _S06_DIAGNOSTICS = _s06_run_diagnostics(DF)

# %% [markdown]
# ## 6.9 Contract check (SPEC §3.3) and hand-off
# The check enforces what later sections rely on: exact feature order, dtypes, canonical row order, one fold per
# cell in every frame, weights > 0 only on valid targets of training frames, zero-mean anomalies over the fixed mask
# of every training frame, and focal/distance grids consistent with `FOCAL_RECOMPUTE`. The table is also written to
# `features_long.parquet` (zstd) as the reproducible hand-off.

# %%
def _s06_contract_check():
    """Assert the SPEC §3.3 contract of the section-06 globals (raises AssertionError on a violation)."""
    frames = [int(y) for y in CFG.FRAMES_OBS]
    assert FEATURES == BASE_FEATURES + _S06_FOCAL_FEATURES and len(FEATURES) == 47
    assert list(FEATURE_META) == FEATURES and all({"family", "group", "base", "actionable"} <= set(v)
                                                  for v in FEATURE_META.values())
    assert sum(v["actionable"] for v in FEATURE_META.values()) == 9
    assert list(SHAP_GROUPS) == [g[0] for g in _S06_GROUP_ROWS] and list(GROUP_META) == list(SHAP_GROUPS)
    assert sorted(FEATURE_GRIDS) == frames
    for y in frames:
        assert list(FEATURE_GRIDS[y]) == FEATURES
        for name, arr in FEATURE_GRIDS[y].items():
            assert arr.shape == ROI_MASK.shape and arr.dtype == np.float32, (y, name, arr.shape, arr.dtype)
            assert not np.isfinite(arr[~ROI_MASK]).any(), f"{name} {y} finite outside the ROI"
    expected_cols = list(_S06_DF_DTYPES)
    assert list(DF.columns) == expected_cols, "DF columns differ from the contract"
    assert isinstance(DF.index, pd.RangeIndex) and DF.index.start == 0
    assert len(DF) == N_CELLS * len(frames)
    for col, dt in _S06_DF_DTYPES.items():
        assert str(DF[col].dtype) == dt, (col, DF[col].dtype, dt)
    year = DF["year"].to_numpy()
    cell = DF["cell_id"].to_numpy()
    assert np.all(np.diff(year) >= 0) and np.array_equal(year, np.repeat(frames, N_CELLS))
    assert np.array_equal(cell, np.tile(CELL_IDS, len(frames))), "cells must follow the canonical order per frame"
    by_cell = DF.groupby("cell_id")[["fold_block5", "fold_block20", "block10_id", "block20_id", "fold_district"]]
    assert int(by_cell.nunique().max().max()) == 1, "a cell must keep its folds/blocks in every frame"
    assert DF["fold_block20"].between(0, CFG.N_FOLDS_BLOCK - 1).all() and DF["fold_block5"].between(0, 4).all()
    assert DF["fold_random"].between(0, CFG.N_FOLDS - 1).all()
    b20 = DF.groupby("block20_id")["fold_block20"].nunique()
    assert int(b20.max()) == 1, "every 20 km block must map to exactly one fold"
    night_train = set(CFG.NIGHT_TRAIN_FRAMES)
    for mode in CFG.MODES:
        w = DF[f"w_{mode}"].to_numpy()
        a = DF[f"anom_{mode}"].to_numpy()
        lst = DF[f"lst_{mode}"].to_numpy()
        assert np.all(w >= 0) and np.all(np.isfinite(lst[w > 0])) and np.all(np.isfinite(a[w > 0]))
        assert np.array_equal(np.isfinite(a), np.isfinite(lst) & np.isin(year, [y for y in frames
                                                                               if np.isfinite(RAW_LEVELS[mode][y])]))
        if mode == "night":
            assert not np.any(w[~np.isin(year, list(night_train))] > 0), "night weights outside NIGHT_TRAIN_FRAMES"
        fixed_row = FIXED_MASK[mode][DF["row"].to_numpy(), DF["col"].to_numpy()]
        for y in frames:
            sel = (year == y) & fixed_row & np.isfinite(a)
            if sel.any():
                assert abs(float(np.mean(a[sel].astype(np.float64)))) < 1e-3, f"{mode} {y} anomaly mean != 0"
        assert FIXED_MASK[mode].dtype == bool and not FIXED_MASK[mode][~ROI_MASK].any()
        assert sorted(RAW_LEVELS[mode]) == frames
        # D8: strict intersection over >= 2 mask frames; excluded training frames carry no weight
        fm = _S06_INFO["fixed_mask"][mode]
        assert len(fm["frames"]) >= 2 and FIXED_MASK[mode].any(), (mode, fm["frames"])
        assert all(fm["coverage"][y] >= fm["min_coverage"] for y in fm["frames"])
        valid_grid = np.zeros(ROI_MASK.shape, bool)
        inter = ROI_MASK.copy()
        for y in fm["frames"]:
            valid_grid[:] = False
            sel = (year == y) & np.isfinite(lst)
            valid_grid[DF["row"].to_numpy()[sel], DF["col"].to_numpy()[sel]] = True
            inter &= valid_grid
        assert np.array_equal(inter, FIXED_MASK[mode]), f"FIXED_MASK[{mode}] is not the strict intersection"
        for y in fm["excluded_frames"]:
            assert not np.any(w[year == y] > 0), f"{mode} {y}: excluded training frame has weight"
        cov = FIXED_MASK_COVERAGE[mode]
        assert sorted(cov) == frames and all(0.0 <= cov[y] <= 1.0 for y in frames)
        assert all(cov[y] == 1.0 for y in fm["frames"]), (mode, cov)
        n_fixed = int(FIXED_MASK[mode].sum())
        for y in frames:
            sel = (year == y) & fixed_row & np.isfinite(lst)
            assert abs(cov[y] - int(sel.sum()) / n_fixed) < 1e-9, (mode, y, cov[y])
    if "day" in CFG.MODES:
        n_day = [int(np.isfinite(DF["lst_day"].to_numpy()[year == y]).sum()) for y in frames]
        assert min(n_day) > 0, f"a day frame has no valid target ({dict(zip(frames, n_day))})"
    y_last = frames[-1]
    check = FOCAL_RECOMPUTE({k: FEATURE_GRIDS[y_last][k] for k in BASE_FEATURES})
    for name in _S06_FOCAL_FEATURES + ["dist_water", "dist_urban", "dist_builtup"]:
        assert np.allclose(check[name], FEATURE_GRIDS[y_last][name], equal_nan=True, atol=1e-5), name
    log("06: contract check passed (SPEC §3.3)")


_s06_contract_check()


def FEATURE_MATRIX(grids, rows=None, cols=None):
    """(n, 47) float32 design matrix in ``FEATURES`` order sampled from a dict of (H, W) feature grids.

    ``rows``/``cols`` default to the canonical cell order (``CELL_ROWS``/``CELL_COLS``), so
    ``FEATURE_MATRIX(FEATURE_GRIDS[y])`` equals ``DF.loc[DF.year == y, FEATURES]``.
    """
    r = CELL_ROWS if rows is None else np.asarray(rows)
    c = CELL_COLS if cols is None else np.asarray(cols)
    return np.ascontiguousarray(np.column_stack([np.asarray(grids[f], np.float32)[r, c] for f in FEATURES]),
                                dtype=np.float32)


def _s06_save_features(frame):
    out_dir = Path(CFG.PARQUET_DIR)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "features_long.parquet"
    try:
        frame.to_parquet(path, engine="pyarrow", compression="zstd", index=False)
        log(f"06: saved {path} ({path.stat().st_size / 1e6:.1f} MB)")
    except Exception as exc:  # noqa: BLE001 - the hand-off file is a convenience, not a dependency
        log(f"06: could not write {path}: {exc!r}", "WARNING")
    return path


with timer("06_save_parquet"):
    _s06_save_features(DF)
print(f"LM_VALIDATION: status={LM_VALIDATION.get('status')} n={LM_VALIDATION.get('n')} "
      f"max_rel_diff={LM_VALIDATION.get('max_rel_diff')}")
free_memory()
