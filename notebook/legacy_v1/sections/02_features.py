# %% [markdown]
# ## 2. Feature engineering
#
# One row of the modelling table is one 1 km grid cell in one epoch. The 17 predictors fall into five
# physically motivated groups; their **order in `FEATURES` is the model's column order and is never changed**.
#
# | Group | Features | Why they matter for daytime LST |
# |---|---|---|
# | Spectral | `ndvi`, `ndwi`, `ndbi` | Vegetation vigour drives evapotranspirative cooling (NDVI); surface wetness / open water raises latent heat flux (NDWI, McFeeters); built-up / bare signal tracks low-albedo, high-heat-capacity materials (NDBI). |
# | Terrain | `elevation`, `slope`, `aspect_sin`, `aspect_cos` | Environmental lapse rate (~6.5 °C km⁻¹) and illumination geometry (the Aravalli ridge). Aspect is circular, so it enters as its sine/cosine pair (averaged at 30 m *before* aggregation, see §2 of the SPEC). |
# | Socio-economic | `ntl`, `log_pop` | Anthropogenic heat and urban intensity. Night-time lights are already `log1p` radiance; population density is heavily right-skewed, so `log_pop = log1p(pop_density)`. |
# | Land-cover composition | `frac_impervious`, `frac_forest`, `frac_water`, `frac_cropland`, `frac_barren` | Share of each harmonised class inside the cell, from the fine land-cover raster. "Other vegetation" (class 6) is deliberately **left out**: the six shares sum to one, so including all six would make the design matrix exactly collinear. Class 6 is the implicit reference category. |
# | Landscape configuration | `lm_pd`, `lm_ed`, `lm_contag` | *How* the classes are arranged, not only how much there is: fragmentation (patch density), edge-mediated heat exchange (edge density) and aggregation (contagion). These come from FRAGSTATS (McGarigal & Marks) and are computed here with a vectorised implementation that is checked against `pylandstats`. |
#
# ### Landscape metrics (per window, valid pixels only)
# A window is the block of fine land-cover pixels under `CFG.LM_WINDOW_CELLS` × `CFG.LM_WINDOW_CELLS` grid cells centred on
# the cell (window 1 = the cell's own block; odd sizes ≥ 3 = overlapping moving window; pixels beyond the raster edge are nodata).
# Let $A$ be the valid area (m²) of the window, $N_p$ the number of patches (8-connected components of each class 1–6, summed
# over classes), $g_{ik}$ the number of 4-neighbour pixel adjacencies between classes $i$ and $k$ counted **in both directions**
# (the FRAGSTATS "double-count" method, like adjacencies included) and $m$ the number of classes present.
#
# $$\mathrm{PD} = \frac{N_p}{A}\,10^{4}\times 100 \quad [\text{patches per }100\ \text{ha}]$$
#
# $$\mathrm{ED} = \frac{E}{A}\,10^{4}, \qquad E = r\sum_{i<k} g_{ik}\quad [\text{m ha}^{-1}]$$
#
# where $r$ is the fine pixel size, i.e. $E$ is the length of every pixel side shared by two *different valid* classes.
# The landscape boundary and sides touching nodata are not edges (FRAGSTATS "no border" / pylandstats `count_boundary=False`).
#
# $$\mathrm{CONTAG} = \left[1 + \frac{\sum_{i=1}^{m}\sum_{k=1}^{m} p_{ik}\,\ln p_{ik}}{2\ln m}\right]\times 100,
#   \qquad p_{ik} = \frac{g_{ik}}{\sum_{i,k} g_{ik}}, \qquad 0\ln 0 := 0 .$$
#
# FRAGSTATS writes the joint probability as $P_i\,g_{ik}/\sum_k g_{ik}$ with $P_i$ the area share of class $i$; we use the
# adjacency-share estimator $g_{ik}/\sum g$ exactly as `pylandstats` 3.1 does (`1 − joint_entropy / (2 ln m)`). The two
# coincide except for pixels on the window/nodata border and the difference is small; matching pylandstats lets the
# validation below be an exact regression test. A single-class window has no configurational information and gets
# CONTAG = 100 (pylandstats returns NaN there).
#
# ### Missing-data policy
# * A cell–epoch enters `DF` only if it lies in the ROI **and** has a valid LST target (no target imputation).
# * Predictor NaNs are **kept** (`float32` NaN). XGBoost / LightGBM route them with learned default directions; linear
#   models, random forest and the GNN impute with the **training-fold** median inside each CV fold (no leakage).
# * Land-cover fractions and landscape metrics are NaN when fewer than 50 % of the window's fine pixels are valid.
# * Missingness per feature is reported below so gaps from cloud masking or product coverage are visible.

# %%
import math
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
from numpy.lib.stride_tricks import sliding_window_view
from scipy import ndimage

FEATURES = [
    "ndvi", "ndwi", "ndbi", "elevation", "slope", "aspect_sin", "aspect_cos", "ntl", "log_pop",
    "frac_impervious", "frac_forest", "frac_water", "frac_cropland", "frac_barren", "lm_pd", "lm_ed", "lm_contag",
]
TARGET_COL = "target"

# Harmonised land-cover classes (SPEC §1): 0 = nodata, 1..6 = valid classes.
_N_LC_CLASSES = 6
_FRACTION_FEATURES = {  # feature name -> harmonised class id (class 6 "other vegetation" is the reference)
    "frac_impervious": 1, "frac_forest": 2, "frac_water": 3, "frac_cropland": 4, "frac_barren": 5,
}
_MIN_VALID_SHARE = 0.5          # window needs >= 50 % valid fine pixels
_LM_CHUNK_PIXELS = 1 << 23      # ~8.4 M fine pixels per chunk -> peak RAM well below 1 GB
# 8-connectivity inside each window and NO connectivity along the stacked-window axis (axis 0).
_LM_STRUCTURE = np.zeros((3, 3, 3), dtype=bool)
_LM_STRUCTURE[1] = True

# %% [markdown]
# ### 2.1 Land-cover composition
# `lc_fractions` reshapes the fine raster to `(H, f, W, f)` blocks and counts every class per block, processing row chunks
# so a 25 m raster of the whole NCR (~130 M pixels) never needs more than a few hundred MB.

# %%
def lc_fractions(lc_fine, f):
    """Per-cell class shares of valid fine pixels.

    Parameters
    ----------
    lc_fine : (H*f, W*f) uint8 array of harmonised classes (0 = nodata).
    f : int, fine pixels per grid cell along one axis.

    Returns
    -------
    (H, W, 6) float32 array; ``[..., c-1]`` is the share of class ``c`` among the cell's valid pixels,
    NaN where fewer than 50 % of the ``f*f`` pixels are valid.
    """
    f = int(f)
    if lc_fine.ndim != 2 or lc_fine.shape[0] % f or lc_fine.shape[1] % f:
        raise ValueError(f"lc_fine shape {lc_fine.shape} is not a multiple of the block size f={f}")
    n_rows, n_cols = lc_fine.shape[0] // f, lc_fine.shape[1] // f
    out = np.full((n_rows, n_cols, _N_LC_CLASSES), np.nan, dtype=np.float32)
    rows_per_chunk = max(1, _LM_CHUNK_PIXELS // (f * f * max(n_cols, 1)))
    for r0 in range(0, n_rows, rows_per_chunk):
        r1 = min(n_rows, r0 + rows_per_chunk)
        blocks = lc_fine[r0 * f:r1 * f].reshape(r1 - r0, f, n_cols, f)
        counts = np.stack([(blocks == c).sum(axis=(1, 3)) for c in range(1, _N_LC_CLASSES + 1)], axis=-1)
        valid = counts.sum(axis=-1, keepdims=True)
        with np.errstate(invalid="ignore", divide="ignore"):
            frac = counts / np.maximum(valid, 1)
        frac[np.broadcast_to(valid < _MIN_VALID_SHARE * f * f, frac.shape)] = np.nan
        out[r0:r1] = frac
    return out


# %% [markdown]
# ### 2.2 Vectorised landscape metrics
# All windows of a chunk are stacked into one `(n_windows, b, b)` array:
# * **patches** – `ndimage.label` per class with a 3-D structuring element that is 8-connected inside a window and has
#   no connectivity along the stack axis; each label's owning window is found from any of its pixels and a `bincount`
#   gives patches per window;
# * **adjacency** – every horizontal and vertical pixel pair with two valid classes contributes
#   `window·C² + c_i·C + c_j` **and** its transpose to one `bincount`, giving the `(n, C, C)` double-count adjacency
#   matrices from which ED (off-diagonal) and CONTAG (joint entropy) follow.
#
# With `ENV["has_cupy"]` the same array code runs on the GPU (`cupyx.scipy.ndimage.label`); any GPU failure falls back to
# NumPy for the remaining chunks.

# %%
def _lm_backend():
    """Return (array module, label function, backend name) for landscape metrics."""
    if ENV.get("has_cupy"):
        try:
            import cupy as cp
            import cupyx.scipy.ndimage as cndi

            return cp, cndi.label, "cupy"
        except Exception as exc:  # broken CUDA install -> CPU
            log(f"cupy unavailable for landscape metrics ({exc!r}); using NumPy", "WARNING")
    return np, ndimage.label, "numpy"


def _window_stack_view(lc_fine, f, window_cells):
    """Strided view (H, W, b, b) of the fine pixels under each cell's window (no copy)."""
    if window_cells < 1 or (window_cells > 1 and window_cells % 2 == 0):
        raise ValueError(f"LM_WINDOW_CELLS must be 1 or an odd number >= 3, got {window_cells}")
    half_px = (window_cells - 1) // 2 * f
    padded = np.pad(lc_fine, half_px, mode="constant", constant_values=0) if half_px else lc_fine
    size = window_cells * f
    return sliding_window_view(padded, (size, size))[::f, ::f]


def _stack_metrics(stack, fine_res, xp=np, label_fn=ndimage.label):
    """Class counts, PD, ED and CONTAG for a stack of windows.

    Parameters
    ----------
    stack : (n, b, b) uint8 array (NumPy or CuPy) of harmonised classes, 0 = nodata.
    fine_res : fine pixel size in metres.

    Returns
    -------
    dict of NumPy arrays: ``counts`` (n, 7) pixel counts per class 0..6, ``pd``, ``ed``, ``contag`` (n,) float64,
    NaN where the window has < 50 % valid pixels.
    """
    n_win, size, _ = stack.shape
    n_cls = _N_LC_CLASSES
    stack = xp.asarray(stack)
    win_id = xp.arange(n_win, dtype=xp.int64)[:, None, None]

    counts = xp.bincount((win_id * (n_cls + 1) + stack).ravel(), minlength=n_win * (n_cls + 1))
    counts = counts.reshape(n_win, n_cls + 1)
    valid = counts[:, 1:].sum(axis=1)

    # --- patches: one 3-D labelling per class present in the chunk --------------------------------------------
    n_patches = xp.zeros(n_win, dtype=xp.int64)
    px_per_win = size * size
    for cls in range(1, n_cls + 1):
        if int(counts[:, cls].sum()) == 0:
            continue
        labels, n_labels = label_fn(stack == cls, structure=xp.asarray(_LM_STRUCTURE))
        n_labels = int(n_labels)
        if n_labels == 0:
            continue
        flat = labels.ravel()
        pix = xp.flatnonzero(flat)
        owner = xp.zeros(n_labels + 1, dtype=xp.int64)
        owner[flat[pix]] = pix // px_per_win  # every pixel of a label lies in the same window
        n_patches += xp.bincount(owner[1:], minlength=n_win)
        del labels, flat, pix, owner

    # --- 4-neighbour adjacency, double counted -------------------------------------------------------------------
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
    return _metrics_from_counts(counts, valid, n_patches, adjacency, fine_res, px_per_win)


def _metrics_from_counts(counts, valid, n_patches, adjacency, fine_res, px_per_win):
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

    insufficient = valid < _MIN_VALID_SHARE * px_per_win
    for arr in (pd_, ed, contag):
        arr[insufficient] = np.nan
    return {"counts": counts, "pd": pd_, "ed": ed, "contag": contag}


def _landscape_metrics(lc_fine, f, fine_res, window_cells, cell_mask):
    """PD / ED / CONTAG rasters (H, W) float32 for the cells in ``cell_mask`` (others NaN).

    Windows are processed in row-major chunks of ~``_LM_CHUNK_PIXELS`` fine pixels.
    """
    n_rows, n_cols = cell_mask.shape
    view = _window_stack_view(lc_fine, f, window_cells)
    size = view.shape[-1]
    rows, cols = np.nonzero(cell_mask)
    out = {k: np.full((n_rows, n_cols), np.nan, dtype=np.float32) for k in ("lm_pd", "lm_ed", "lm_contag")}
    xp, label_fn, backend = _lm_backend()
    per_chunk = max(1, _LM_CHUNK_PIXELS // (size * size))
    for start in range(0, rows.size, per_chunk):
        r_idx, c_idx = rows[start:start + per_chunk], cols[start:start + per_chunk]
        stack = np.ascontiguousarray(view[r_idx, c_idx])
        try:
            res = _stack_metrics(stack, fine_res, xp, label_fn)
        except Exception as exc:
            if xp is np:
                raise
            log(f"GPU landscape metrics failed ({exc!r}); continuing on CPU", "WARNING")
            xp, label_fn, backend = np, ndimage.label, "numpy"
            free_memory()
            res = _stack_metrics(stack, fine_res, xp, label_fn)
        out["lm_pd"][r_idx, c_idx] = res["pd"]
        out["lm_ed"][r_idx, c_idx] = res["ed"]
        out["lm_contag"][r_idx, c_idx] = res["contag"]
        del stack, res
    out["backend"] = backend
    return out


# %% [markdown]
# ### 2.3 Validation against pylandstats
# 120 random windows are re-computed with `pylandstats.Landscape(array, res=(r, r), nodata=0, neighborhood_rule="8")`
# (`patch_density()`, `edge_density(count_boundary=False)`, `contagion()`). pylandstats 3.1 uses exactly the definitions
# above: PD per 100 ha of **valid** area, ED from the unique unlike 4-neighbour adjacencies (nodata excluded), CONTAG from
# the joint entropy of the double-counted adjacency matrix with $m$ = classes present. Its only divergence is CONTAG for a
# single-class window (NaN vs our 100), so those windows are excluded from the CONTAG comparison. Mismatches warn but
# never stop the pipeline.

# %%
def validate_landscape_metrics(n=120, tol=1e-6):
    """Compare the vectorised metrics with pylandstats on ``n`` random valid windows (all epochs pooled).

    Returns the ``LM_VALIDATION`` dict: ``n``, per-metric ``*_max_abs_diff`` / ``*_mean_abs_diff``, ``status``
    ("ok" | "warn" | "skipped" | "error") and a ``reason``/``note``.
    """
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
            lc = LC_FINE[year]
            f = lc.shape[0] // ROI_MASK.shape[0]
            fine_res = float(GRID.res) / f
            view = _window_stack_view(lc, f, CFG.LM_WINDOW_CELLS)
            size = view.shape[-1]
            cand_r, cand_c = np.nonzero(ROI_MASK)
            pick = rng.choice(cand_r.size, size=min(int(n_year) * 3, cand_r.size), replace=False)
            stack = np.ascontiguousarray(view[cand_r[pick], cand_c[pick]])
            res = _stack_metrics(stack, fine_res)
            keep = np.flatnonzero(np.isfinite(res["pd"]))[: int(n_year)]
            for i in keep:
                window = stack[i]
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    ls = pls.Landscape(window, res=(fine_res, fine_res), nodata=0, neighborhood_rule="8")
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
    except Exception as exc:
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
    out["status"] = "ok" if worst <= tol else "warn"
    out["note"] = ("CONTAG compared only on windows with >= 2 classes (pylandstats returns NaN otherwise; "
                   "this pipeline uses 100). Relative tolerance %.0e." % tol)
    if out["status"] != "ok":
        log(f"landscape metrics differ from pylandstats (max rel diff {worst:.3g}): {out}", "WARNING")
    else:
        log(f"landscape metrics match pylandstats on {out['n']} windows (max rel diff {worst:.2e})")
    return out


# %% [markdown]
# ### 2.4 Long-format feature table
# Cells are enumerated in row-major order per epoch, so `cell_id = row·W + col` is already ascending; the table is still
# sorted explicitly by (`year`, `cell_id`) — the row-order contract every downstream per-row array relies on.
#
# **Cross-validation groupings** (stored as columns so every later stage reuses identical folds):
# * `spatial_block` – 5 × 5 tiles over the grid extent (`row·5 // H`, `col·5 // W`);
# * `fold_spatial` – non-empty tiles sorted by size (largest first) and greedily given to the currently smallest fold,
#   which balances fold sizes deterministically; a cell keeps its fold in every epoch;
# * `fold_random` – a seeded random permutation of rows (the optimistic baseline);
# * `block10_id` – 10 km blocks (≥ 1 cell each) for inner early-stopping splits and the block bootstrap.
#
# When RAPIDS cuDF is present the assembly and group-bys run on the GPU and are converted back with `.to_pandas()`;
# the pandas path gives identical results.

# %%
_DF_DTYPES = {
    "cell_id": "int32", "row": "int32", "col": "int32", "x": "float64", "y": "float64",
    "lon": "float64", "lat": "float64", "district": "int16", "year": "int16",
    **{name: "float32" for name in FEATURES},
    "pop_density": "float32", "lst": "float32", "lst_obs_count": "float32", "epoch_mean": "float32",
    "target": "float32", "spatial_block": "int16", "fold_spatial": "int8", "fold_random": "int8",
    "block10_id": "int32",
}
_SPECTRAL_BANDS = ["ndvi", "ndwi", "ndbi", "elevation", "slope", "aspect_sin", "aspect_cos", "ntl"]


def _fine_factor(year):
    """Fine pixels per cell (f) and fine resolution (m) for an epoch's land-cover raster."""
    lc = LC_FINE[year]
    n_rows, n_cols = ROI_MASK.shape
    f = lc.shape[0] // n_rows
    if f < 1 or lc.shape != (n_rows * f, n_cols * f):
        raise ValueError(f"LC_FINE[{year}] shape {lc.shape} incompatible with grid {ROI_MASK.shape}")
    return f, float(GRID.res) / f


def _epoch_columns(year, cell_mask_lm, geo):
    """Numpy column dict for one epoch (ROI cells with a valid LST only)."""
    stack = RAW_STACKS[year]
    lst = stack["lst_day_c"]
    obs = stack["lst_obs_count"]
    valid = ROI_MASK & np.isfinite(lst)
    # A seasonal median from fewer than CFG.LST_MIN_OBS valid 8-day composites is too noisy to be a target (the
    # Earth Engine path already masks such cells server-side; this guard also covers cached or external stacks).
    few = valid & np.isfinite(obs) & (obs < int(CFG.LST_MIN_OBS))
    if few.any():
        log(f"{year}: {int(few.sum()):,} cells dropped (< {CFG.LST_MIN_OBS} valid LST composites)", "WARNING")
    rows, cols = np.nonzero(valid & ~few)
    n_cols_grid = ROI_MASK.shape[1]
    columns = {
        "cell_id": (rows * n_cols_grid + cols).astype(np.int32),
        "row": rows.astype(np.int32), "col": cols.astype(np.int32),
        "x": geo["x"][rows, cols], "y": geo["y"][rows, cols],
        "lon": geo["lon"][rows, cols], "lat": geo["lat"][rows, cols],
        "district": DISTRICT_IDX[rows, cols].astype(np.int16),
        "year": np.full(rows.size, year, dtype=np.int16),
    }
    for band in _SPECTRAL_BANDS:
        columns[band] = stack[band][rows, cols].astype(np.float32)
    pop = stack["pop_density"][rows, cols].astype(np.float32)
    columns["log_pop"] = np.log1p(np.clip(pop, 0.0, None)).astype(np.float32)

    if year in LC_FINE:
        f, fine_res = _fine_factor(year)
        with timer(f"lc_fractions_{year}"):
            fractions = lc_fractions(LC_FINE[year], f)
        for name, cls in _FRACTION_FEATURES.items():
            columns[name] = fractions[rows, cols, cls - 1]
        with timer(f"landscape_metrics_{year}"):
            lm = _landscape_metrics(LC_FINE[year], f, fine_res, int(CFG.LM_WINDOW_CELLS), cell_mask_lm)
        log(f"{year}: landscape metrics on {int(cell_mask_lm.sum()):,} windows "
            f"({CFG.LM_WINDOW_CELLS}x{CFG.LM_WINDOW_CELLS} cells, f={f}, backend={lm['backend']})")
        for name in ("lm_pd", "lm_ed", "lm_contag"):
            columns[name] = lm[name][rows, cols]
        del fractions, lm
    else:
        log(f"LC_FINE has no {year} raster: land-cover features set to NaN", "WARNING")
        for name in (*_FRACTION_FEATURES, "lm_pd", "lm_ed", "lm_contag"):
            columns[name] = np.full(rows.size, np.nan, dtype=np.float32)

    columns["pop_density"] = pop
    columns["lst"] = lst[rows, cols].astype(np.float32)
    columns["lst_obs_count"] = stack["lst_obs_count"][rows, cols].astype(np.float32)
    return columns


def _frame_backend():
    """cuDF when available (GPU group-bys), else pandas."""
    if ENV.get("has_cudf"):
        try:
            import cudf

            return cudf, "cudf"
        except Exception as exc:
            log(f"cuDF import failed ({exc!r}); using pandas", "WARNING")
    return pd, "pandas"


def _assemble_long(per_epoch):
    """Concatenate epochs, sort by (year, cell_id) and compute the group-by statistics.

    Returns (pandas DataFrame, epoch means {year: float}, row counts per spatial_block {block: int}).
    """
    lib, name = _frame_backend()
    try:
        frame = lib.concat([lib.DataFrame(cols) for cols in per_epoch], ignore_index=True)
        frame = frame.sort_values(["year", "cell_id"]).reset_index(drop=True)
        frame["_lst64"] = frame["lst"].astype("float64")
        means = frame.groupby("year")["_lst64"].mean()
        blocks = frame.groupby("spatial_block")["cell_id"].count()
        means = means.to_pandas() if name == "cudf" else means
        blocks = blocks.to_pandas() if name == "cudf" else blocks
        frame = frame.drop(columns=["_lst64"])
        frame = frame.to_pandas() if name == "cudf" else frame
        if name == "cudf":
            ENV.setdefault("rapids_used", set()).add("cudf")
    except Exception as exc:
        if lib is pd:
            raise
        log(f"cuDF assembly failed ({exc!r}); redoing with pandas", "WARNING")
        ENV["has_cudf"] = False
        return _assemble_long(per_epoch)
    log(f"long-format table assembled with {name}")
    epoch_means = {int(k): float(v) for k, v in means.items()}
    block_counts = {int(k): int(v) for k, v in blocks.items()}
    return frame, epoch_means, block_counts


def _greedy_block_folds(block_counts, n_folds):
    """Deterministic size-balanced assignment: largest block first -> currently smallest fold (ties: lowest id)."""
    order = sorted((b for b, c in block_counts.items() if c > 0), key=lambda b: (-block_counts[b], b))
    if len(order) < n_folds:
        log(f"only {len(order)} non-empty spatial blocks for {n_folds} folds - some folds will be empty", "WARNING")
    load = np.zeros(n_folds, dtype=np.int64)
    assignment = {}
    for block in order:
        fold = int(np.argmin(load))
        assignment[block] = fold
        load[fold] += block_counts[block]
    return assignment, load


def _build_feature_table():
    """Build DF, EPOCH_MEANS and the fold columns from RAW_STACKS / LC_FINE (SPEC §3)."""
    n_rows, n_cols = ROI_MASK.shape
    X, Y = GRID.cell_centers_xy()
    LON, LAT = GRID.lonlat()
    geo = {"x": np.asarray(X, np.float64), "y": np.asarray(Y, np.float64),
           "lon": np.asarray(LON, np.float64), "lat": np.asarray(LAT, np.float64)}
    years = [y for y in CFG.EPOCHS if y in RAW_STACKS] or sorted(RAW_STACKS)
    missing = sorted(set(CFG.EPOCHS) - set(RAW_STACKS))
    if missing:
        log(f"RAW_STACKS lacks epochs {missing}; continuing with {years}", "WARNING")

    # spatial CV block ids are needed before assembly (group-by on blocks)
    nby, nbx = CFG.SPATIAL_BLOCKS
    grid_rows, grid_cols = np.indices((n_rows, n_cols))
    block_grid = ((grid_rows * nby // n_rows) * nbx + grid_cols * nbx // n_cols).astype(np.int16)
    b10 = max(1, int(round(CFG.INNER_BLOCK_KM * 1000.0 / float(GRID.res))))
    block10_grid = ((grid_rows // b10) * math.ceil(n_cols / b10) + grid_cols // b10).astype(np.int32)

    per_epoch = []
    for year in years:
        cols = _epoch_columns(year, ROI_MASK, geo)
        cols["spatial_block"] = block_grid[cols["row"], cols["col"]]
        cols["block10_id"] = block10_grid[cols["row"], cols["col"]]
        per_epoch.append(cols)
        log(f"{year}: {cols['cell_id'].size:,} cells with valid LST")
    frame, epoch_means, block_counts = _assemble_long(per_epoch)
    del per_epoch

    if frame.empty:
        raise RuntimeError("feature table is empty - no ROI cell has a valid LST target")

    epoch_mean = frame["year"].map(epoch_means).to_numpy(np.float64)
    frame["epoch_mean"] = epoch_mean.astype(np.float32)
    lst64 = frame["lst"].to_numpy(np.float64)
    if CFG.TARGET_MODE == "anomaly":
        frame["target"] = (lst64 - epoch_mean).astype(np.float32)
    elif CFG.TARGET_MODE == "absolute":
        frame["target"] = lst64.astype(np.float32)
    else:
        raise ValueError(f"unknown CFG.TARGET_MODE {CFG.TARGET_MODE!r}")

    assignment, load = _greedy_block_folds(block_counts, int(CFG.N_FOLDS))
    frame["fold_spatial"] = frame["spatial_block"].map(assignment).to_numpy(np.int8)
    perm = np.random.default_rng(CFG.SEED).permutation(len(frame))
    fold_random = np.empty(len(frame), dtype=np.int8)
    fold_random[perm] = np.arange(len(frame)) % int(CFG.N_FOLDS)
    frame["fold_random"] = fold_random

    frame = frame[list(_DF_DTYPES)].astype(_DF_DTYPES)
    frame.index = pd.RangeIndex(len(frame))
    log(f"spatial folds (rows): {load.tolist()} from {len(assignment)} non-empty 5x5 blocks; "
        f"10 km blocks = {b10}x{b10} cells, {frame['block10_id'].nunique()} used")
    return frame, epoch_means


with timer("features"):
    DF, EPOCH_MEANS = _build_feature_table()
LM_VALIDATION = validate_landscape_metrics(n=120)
log(f"DF: {len(DF):,} rows x {DF.shape[1]} columns; epochs {sorted(EPOCH_MEANS)}; "
    f"epoch means (degC) {({k: round(v, 2) for k, v in EPOCH_MEANS.items()})}")

# %% [markdown]
# ### 2.5 Feature metadata and statistics
# `FEATURE_META` drives every label in the dashboard; `actionable` marks the levers planners can move: the five
# land-cover fractions, NDVI (greening within the existing covers) and the three landscape-configuration metrics.
# NDWI and NDBI are spectral *diagnostics*, not interventions: nobody "lowers NDBI" directly, it changes only when the
# land cover changes. They are therefore `actionable = False`; in coupled scenarios they follow land-cover changes
# through the fitted coupling slopes (4.10). Terrain and socio-economic context are held fixed.

# %%
_ACTIONABLE_GROUPS = {"landcover", "landscape"}
_ACTIONABLE_EXTRA = {"ndvi"}          # the one directly actionable spectral index (greening)
_META_ROWS = [
    # name, label, unit, group, display, source, description
    ("ndvi", "NDVI", "", "spectral", "index", "MODIS MOD09A1 (500 m), seasonal median",
     "Normalised Difference Vegetation Index; greener, denser vegetation cools the surface by transpiration and shading."),
    ("ndwi", "NDWI", "", "spectral", "index", "MODIS MOD09A1 (500 m), seasonal median",
     "McFeeters Normalised Difference Water Index (green vs NIR); high values mark open water and wet surfaces."),
    ("ndbi", "NDBI", "", "spectral", "index", "MODIS MOD09A1 (500 m), seasonal median",
     "Normalised Difference Built-up Index (SWIR vs NIR); high values mark built-up and bare, dry surfaces."),
    ("elevation", "Elevation", "m", "terrain", "number", "SRTM GL1 (30 m), cell mean",
     "Mean terrain height above sea level; air and surface temperature fall with altitude."),
    ("slope", "Slope", "°", "terrain", "number", "SRTM GL1 (30 m), cell mean",
     "Mean terrain slope; steep ridges (Aravalli) change solar exposure and land use."),
    ("aspect_sin", "Aspect (east-west)", "", "terrain", "index", "SRTM GL1 (30 m), sin(aspect) averaged at 30 m",
     "Sine of terrain aspect: +1 east-facing, -1 west-facing slopes."),
    ("aspect_cos", "Aspect (north-south)", "", "terrain", "index", "SRTM GL1 (30 m), cos(aspect) averaged at 30 m",
     "Cosine of terrain aspect: +1 north-facing, -1 south-facing (sun-exposed) slopes."),
    ("ntl", "Night-time lights", "log1p(nW/cm²/sr)", "socioeconomic", "number",
     "VIIRS DNB monthly (2015+) / DMSP-OLS harmonised by isotonic regression (2010)",
     "Log night-time radiance; proxy for urban intensity and anthropogenic heat release."),
    ("log_pop", "Population density (log)", "log1p(persons/km²)", "socioeconomic", "number",
     "WorldPop 100 m (2010-2020) / GHS-POP rescaled (2025)",
     "Log of residents per km²; proxy for building density and human heat emission."),
    ("frac_impervious", "Impervious cover", "fraction", "landcover", "percent", "Harmonised fine land cover (class 1)",
     "Share of the cell covered by built-up / impervious surfaces."),
    ("frac_forest", "Tree cover", "fraction", "landcover", "percent", "Harmonised fine land cover (class 2)",
     "Share of the cell covered by trees / forest."),
    ("frac_water", "Water", "fraction", "landcover", "percent", "Harmonised fine land cover (class 3)",
     "Share of the cell covered by open water (rivers, canals, lakes)."),
    ("frac_cropland", "Cropland", "fraction", "landcover", "percent", "Harmonised fine land cover (class 4)",
     "Share of the cell under cultivation."),
    ("frac_barren", "Barren land", "fraction", "landcover", "percent", "Harmonised fine land cover (class 5)",
     "Share of the cell that is bare soil, sand or rock."),
    ("lm_pd", "Patch density", "patches/100 ha", "landscape", "number", "FRAGSTATS PD on fine land cover",
     "Number of land-cover patches (8-connected) per 100 ha; higher = more fragmented mosaic."),
    ("lm_ed", "Edge density", "m/ha", "landscape", "number", "FRAGSTATS ED on fine land cover",
     "Length of boundaries between different land-cover classes per hectare."),
    ("lm_contag", "Contagion", "%", "landscape", "number", "FRAGSTATS CONTAG on fine land cover",
     "Aggregation of land-cover classes (0 = maximally interspersed, 100 = single contiguous class)."),
]
FEATURE_META = {
    name: {"label": label, "unit": unit, "group": group, "description": desc, "source": source,
           "actionable": group in _ACTIONABLE_GROUPS or name in _ACTIONABLE_EXTRA, "display": display}
    for name, label, unit, group, display, source, desc in _META_ROWS
}
if list(FEATURE_META) != FEATURES:
    raise AssertionError("FEATURE_META order must match FEATURES")


def _feature_stats(frame):
    """Robust summary per feature over all DF rows (NaN-aware; NaN when a feature is entirely missing)."""
    stats = {}
    for name in FEATURES:
        v = frame[name].to_numpy(np.float64)
        v = v[np.isfinite(v)]
        if v.size == 0:
            stats[name] = {k: float("nan") for k in ("min", "max", "p01", "p99", "median", "mean", "std")}
            continue
        p01, p99, med = np.percentile(v, [1, 99, 50])
        stats[name] = {"min": float(v.min()), "max": float(v.max()), "p01": float(p01), "p99": float(p99),
                       "median": float(med), "mean": float(v.mean()), "std": float(v.std(ddof=1)) if v.size > 1 else 0.0}
    return stats


FEATURE_STATS = _feature_stats(DF)

# %% [markdown]
# ### 2.6 Diagnostics
# * per-epoch descriptive statistics (shifts in the land-surface mix and in LST),
# * Spearman rank correlations (robust to the skewed socio-economic variables); pairs with |ρ| > 0.85 are flagged because
#   they split SHAP credit arbitrarily between them,
# * variance inflation factors $\mathrm{VIF}_j = 1/(1-R_j^2)$ from least-squares regressions of each standardised
#   feature on all others (complete cases),
# * missingness per feature and epoch.

# %%
def _show_table(obj):
    """display() inside a notebook kernel, full-width print() in plain scripts (named apart from 00's `_show`:
    all sections share one namespace)."""
    import sys

    if "ipykernel" in sys.modules:
        try:
            from IPython.display import display

            display(obj)
            return
        except Exception:
            pass
    print(obj.to_string() if isinstance(obj, pd.DataFrame) else obj)


def _vif(frame):
    """VIF per feature via numpy least squares on standardised complete cases (NaN if undefined)."""
    data = frame[FEATURES].to_numpy(np.float64)
    data = data[np.isfinite(data).all(axis=1)]
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


def _plot_spearman(corr):
    """Annotated Spearman heatmap (diverging blue-grey-red, fixed [-1, 1])."""
    import matplotlib.pyplot as plt
    from matplotlib.colors import LinearSegmentedColormap

    cmap = LinearSegmentedColormap.from_list("div", ["#2a78d6", "#f0efec", "#e34948"])
    labels = [FEATURE_META[f]["label"] for f in corr.columns]
    fig, ax = plt.subplots(figsize=(11, 9))
    im = ax.imshow(corr.to_numpy(), cmap=cmap, vmin=-1, vmax=1)
    ax.set_xticks(range(len(labels)))
    ax.set_xticklabels(labels, rotation=60, ha="right", fontsize=8)
    ax.set_yticks(range(len(labels)))
    ax.set_yticklabels(labels, fontsize=8)
    for i in range(len(labels)):
        for j in range(len(labels)):
            val = corr.iat[i, j]
            if np.isfinite(val):
                flag = abs(val) > 0.85 and i != j
                ax.text(j, i, f"{val:.2f}", ha="center", va="center", fontsize=6,
                        fontweight="bold" if flag else "normal", color="#0b0b0b")
    fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04, label="Spearman ρ")
    ax.set_title("Spearman rank correlation of predictors (bold: |ρ| > 0.85)")
    fig.tight_layout()
    fig.savefig(Path(CFG.FIG_DIR) / "02_spearman_correlation.png", dpi=150)
    plt.show()
    plt.close(fig)


def _run_feature_diagnostics(frame):
    """Print/plot descriptive tables, correlation, VIF and missingness; returns a dict of the tables."""
    Path(CFG.FIG_DIR).mkdir(parents=True, exist_ok=True)
    by_epoch = frame.groupby("year")[["lst", "target"] + FEATURES].agg(["mean", "std"]).T
    print("Per-epoch mean / std (rows = variable, statistic):")
    _show_table(by_epoch.round(3))
    print("Rows per epoch:", frame.groupby("year").size().to_dict())

    corr = frame[FEATURES].corr(method="spearman")
    high = [(a, b, float(corr.at[a, b])) for i, a in enumerate(FEATURES) for b in FEATURES[i + 1:]
            if np.isfinite(corr.at[a, b]) and abs(corr.at[a, b]) > 0.85]
    for a, b, rho in high:
        log(f"highly correlated pair: {a} ~ {b} (Spearman rho = {rho:+.2f})", "WARNING")
    if not high:
        log("no predictor pair exceeds |Spearman rho| = 0.85")
    _plot_spearman(corr)

    vif = _vif(frame)
    missing = frame.groupby("year")[FEATURES].apply(lambda g: g.isna().mean()).T
    missing["overall"] = frame[FEATURES].isna().mean()
    summary = pd.DataFrame({"VIF": vif, "missing_overall": missing["overall"]})
    print("VIF (complete cases) and missing share per feature:")
    _show_table(summary.round(3))
    print("Missing share by epoch:")
    _show_table(missing.round(4))
    for name, value in vif.items():
        if np.isfinite(value) and value > 10:
            log(f"VIF({name}) = {value:.1f} > 10 - strong multicollinearity", "WARNING")
    return {"by_epoch": by_epoch, "spearman": corr, "high_corr_pairs": high, "vif": vif, "missing": missing}


_FEATURE_DIAGNOSTICS = _run_feature_diagnostics(DF)

# %% [markdown]
# ### 2.7 Persist the feature table
# `features_long.parquet` (pyarrow, zstd) is the reproducible hand-off of the modelling table.

# %%
def _save_features(frame):
    out_dir = Path(CFG.PARQUET_DIR)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "features_long.parquet"
    frame.to_parquet(path, engine="pyarrow", compression="zstd", index=False)
    log(f"saved {path} ({path.stat().st_size / 1e6:.1f} MB)")
    return path


_save_features(DF)
free_memory()
