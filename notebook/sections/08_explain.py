# %% [markdown]
# # 8. Explainability per mode: grouped GPU TreeSHAP, interactions, block bootstrap, thresholds, zones, recommendations and the web surrogate
#
# Everything in this section is done **separately for each mode** (`day`, `night`) with that mode's final model
# `FINAL_MODELS[m]` (section 07). The products are the explanation layer of the dashboard (Drivers, Zones) and the
# zone ids every timeline/projection frame is coloured with.
#
# ## 8.1 TreeSHAP and why it is reported per group
# For a prediction $f(x)$ the Shapley value of feature $j$ is its average marginal contribution over all orderings
# in which features are "switched on":
#
# $$\phi_j(x)=\sum_{S\subseteq F\setminus\{j\}}\frac{|S|!\,(|F|-|S|-1)!}{|F|!}\big[f_x(S\cup\{j\})-f_x(S)\big].$$
#
# It is the unique attribution with *efficiency* ($f(x)=\phi_0+\sum_j\phi_j$, $\phi_0=E[f(X)]$), symmetry, dummy and
# linearity. **TreeSHAP** (Lundberg et al. 2020) computes it exactly for tree ensembles in $O(TLD^2)$ using the
# trees' own cover statistics as the conditional expectation; XGBoost ships the CUDA implementation (GPUTreeShap,
# Mitchell et al. 2022) through `predict(pred_contribs=True)`, ~20× faster than the CPU, which is what makes
# explaining every cell × frame and every bootstrap replicate feasible on two T4s.
#
# **Groups (SPEC §4.4, 18).** v2 has 47 features, 14 of which are neighbourhood (focal) means of a base feature
# (`ndvi`, `ndvi_m3`, `ndvi_m15`) and some of which are near-duplicates (`dist_urban`/`dist_builtup`). Correlated
# features split SHAP credit arbitrarily between them, so per-feature SHAP is unstable and hard to read. Shapley
# values are additive, so the SHAP value of a *group* is exactly the sum of its members' values and the efficiency
# property survives: $\text{pred} = \phi_0 + \sum_{g=1}^{18}\Phi_g$. All dependence curves, thresholds, zones and the
# dashboard use the 18 group values; per-feature importance is kept only as a diagnostic.
#
# **Additivity is checked, not assumed:** for every row, $\phi_0+\sum_g\Phi_g$ must equal the raw margin
# (`output_margin=True`) within $10^{-3}$ °C, otherwise the section stops.
#
# **What SHAP is not.** $\Phi_g(x)$ says how far the *current state* of driver $g$ pushes this cell's predicted
# anomaly away from the average cell (a level), not how the prediction would respond if the driver changed (a
# slope); and it explains the model, not causation. Responses are estimated separately with model counterfactuals
# (8.7).
#
# ## 8.2 XAI frames
# Day: all eight observed frames (Landsat targets 1990–2025). Night: also all eight — the model was trained on
# 2005–2025 (Aqua/VIIRS), 2000 is the Terra-reconstructed hindcast check, and the 1990/1995 rows explain the model's
# **hindcast** of years without any night product (their tier is `modelled`, section 09). Cells whose 33 base features
# are not all available (e.g. a Landsat gap) get NaN SHAP rows (nodata in the bundle); predictions are kept for every
# ROI cell (trees route missing values).
#
# ## 8.3 Governance zones: K-means in grouped-SHAP space ("supervised clustering")
# Clustering raw features groups cells that *look* alike; clustering the SHAP matrix groups cells whose predicted
# anomaly is **attributed to the same drivers in similar amounts** — every coordinate is already in °C, so no scaling
# is needed and irrelevant drivers contribute ~0 distance. K = 4 (fixed by the governance contract) is fitted on the
# group-SHAP vectors pooled over the mode's **training frames**; every frame (observed, modelled and, in section 11,
# projected) gets zone ids by the nearest centroid (`ASSIGN_ZONES`), so zones are comparable through time.
# **Labelling rule (SPEC §1.5, both modes):** (1) **3 Heat Extreme Core** = highest mean total SHAP. (2) Among the
# other three, a cluster is *riparian-eligible* if its mean `frac_water` ≥ 0.05, or ≥ 25 % of its rows have
# `frac_water` ≥ 0.2, or the `water` group has its largest mean |SHAP| (of 18) with ≥ 0.25 °C. If any is eligible:
# **1 Riparian Buffer** = the eligible cluster with the highest mean `frac_water`, **0 Ecological Cool Base** = the
# lower mean total SHAP of the remaining two, **2 Transition** = the last one. If none is (e.g. the night zones of a
# dry plain), the three are ordered by mean total SHAP (lowest → 0, middle → 1, highest → 2); the canonical ids,
# names and colours stay, but zone 1 carries `display_name = "Moderate mosaic (no riparian signal)"` and a
# `label_caveat`, so no map calls a dry mosaic a river buffer. K = 2..8 inertia/silhouette diagnostics are reported
# for transparency, not as evidence that 4 is optimal.
#
# ## 8.4 Spatial block bootstrap
# The uncertainty of an explanation comes mostly from *which places* the model learned from, and cells are spatially
# autocorrelated, so rows are resampled in square blocks whose size is the distance at which the correlogram of the
# block20 out-of-fold residuals of the last training frame drops below 0.1 (rounded up to 5 km, ≥ the inner 10 km
# block; shrunk if < 50 blocks remain) unless `CFG.BOOT_BLOCK_KM` is set. Each replicate draws blocks with
# replacement, gives every training row its block multiplicity × its sample weight, and refits the final model's
# exact recipe (same rounds, same monotone constraints; no early stopping, so every replicate has the same capacity).
# Replicates run one per GPU (`gpu_pool_map`), are stage-cached individually (an interrupted Kaggle session resumes)
# and are **reduced immediately** (importance, binned dependence curves on a fixed evaluation sample, thresholds,
# recommendation counterfactuals), so memory stays bounded.
#
# **Intervals** are *recentred (bias-corrected) percentile intervals* $[\hat\theta + q_{2.5} - \tilde\theta^*,\
# \hat\theta + q_{97.5} - \tilde\theta^*]$ ($\tilde\theta^*$ = replicate median), which always contain the full-data
# estimate $\hat\theta$; the bootstrap bias $\tilde\theta^*-\hat\theta$ is reported. With fewer than 50 replicates the
# interval is labelled "replicate range" instead of "95% CI" (`ci_method = "recentred-percentile"`).
#
# ## 8.5 Dependence curves and thresholds (per group)
# x = the group's **primary** feature, y = the group SHAP value. Bins are `CFG.DEP_BINS` equal-count quantile bins
# fixed on the full data; a value holding ≥ 1/`DEP_BINS` of the rows (`frac_water = 0`, `frac_cropland = 1`,
# CONTAG = 100, …) gets a bin of its own ("atom-aware" binning), otherwise point masses collapse the quantiles exactly
# where a rare land cover's effect lives. Estimators (v1, unchanged): **zero_crossing** (single or dominant sign
# change; else null with `zero_crossing_flag = "multiple"`; zero = the average cell, not a physical threshold),
# **breakpoint** (best continuous hinge, count-weighted, withheld when it removes < 10 % of the straight-line SSE, sits
# at the edge of the candidate range or leaves < 5 bins / < 5 % of the weight on a side), **saturation** (first x
# after the steepest part where |smoothed slope| stays < 10 % of its maximum for ≥ 3 bins, refined to the knee),
# **direction** (sign of Spearman ρ, |ρ| < 0.2 → "mixed"). `<k>_support` = share of replicates that found the
# threshold; `<k>_ci` only when the point exists and support ≥ 0.5. A replicate supports the zero crossing only when
# its own curve has a crossing by the same rule (single or dominant sign change) within max(one median bin width,
# 10 % of the primary's p05–p95 range) of the full-data crossing — a crossing somewhere else on a wiggly curve is not
# support.
#
# ## 8.6 Interactions
# SHAP interaction values split $\phi_j$ into a main effect $\phi_{jj}$ and pair terms $\phi_{jk}=\phi_{kj}$ with
# $\sum_k\phi_{jk}=\phi_j$. Group interactions sum the member pairs: $\Phi_{gh}=\sum_{j\in g}\sum_{k\in h}\phi_{jk}$
# (rows still sum to the group SHAP — checked). Mean $|\Phi_{gh}|$ (18 × 18, diagonal = within-group effect) is
# stored globally and per zone from ≤ 5000 sampled rows per frame (GPU; fewer on the CPU); the strongest off-diagonal
# partner of a group colours its dependence scatter.
#
# ## 8.7 Zone recommendations: model counterfactuals with focal recompute
# Recommendations are *plausible interventions evaluated with the final model itself*, not read off the pooled SHAP
# curve. **Levers** = the primary features of the actionable groups (`ndvi`, `frac_built`, `frac_forest`,
# `frac_water`, `frac_cropland`, `frac_barren`, `lm_ed`); directions: built-up and barren only decrease, tree cover and
# water only increase, cropland and edge density either way, NDVI only increases and is not offered in zones whose
# median water fraction > 0.15. Every applicable cell of the zone in the current frame (`CFG.NOW`) is shifted by the
# same step. A fraction change is **compositional** (the other four fractions and the implicit *other vegetation*
# share give/receive land in proportion to their current values, capped by the land available) and the spectral
# indices follow through the coupling slopes (`SCENARIO_COUPLING`); spring NDVI follows a season-NDVI shift unless it
# has its own slope, and `ndvi_drop = ndvi_spring − ndvi` is recomputed — exactly the dashboard's what-if engine.
# **New in v2:** after the base features change, the 3- and 15-cell focal means are **recomputed on the grid**
# (distances held fixed, SPEC §4.4) inside the w × w footprint of the edited cells (old values elsewhere), so a
# greener zone also changes its neighbours' focal context. **Spill-over cells** are the ROI cells outside the zone
# whose feature row changed by more than 10⁻⁶ × max(1, |x|) in any feature (NaN ↔ finite counts); the spill-over
# mean is the mean ΔLST over all of them, zeros included (the dashboard simulator reports the same definition).
# Feasibility: target within the zone's own p10–p90 and |step| ≤ 0.20 (fractions) / 0.15 (NDVI); the
# recommended target is the smallest step achieving ≥ 90 % of the best cooling among the breakpoint, saturation and
# 25/50/75/100 % of the way to the bound. Expected Δ = mean change of the final model's prediction over the zone's
# applicable cells (a ceteris-paribus estimate **associated with** the change, not a causal effect); the interval comes
# from replaying the identical counterfactual with every bootstrap replicate. Δ > −0.05 °C is dropped; ≤ 4 per zone.
#
# ## 8.8 Web surrogate
# The dashboard runs what-ifs in the browser with a compact tree ensemble (v1 format `lst-xgb-compact-v1`, depth ≤ 6,
# ≤ 400 trees) on all 47 features plus `"focal": FOCAL_SPEC`, so the browser recomputes focal means exactly as above.
# It is **distilled** from the final model (label = the final model's margin on every ROI cell × frame, monotone
# constraints kept) plus NaN-augmented copies of complete rows (15 % with the six per-cell Landsat features missing —
# a spectral gap whose neighbourhood means survive — and 5 % with 10 % random NaNs, labelled by the final model on
# the masked rows), so the surrogate follows the final model's missing-value routes; fidelity is reported on complete
# rows, actual NaN rows and held-out gap copies. The augmentation is a deliberate trade: on the synthetic 2 km run it
# costs a little complete-row fidelity (day complete-row RMSE 0.075 → 0.092 °C against a surrogate without it; night
# complete-row R² 0.998) for a usable spectral-gap path (held-out gap RMSE about 0.09 day / 0.045 night °C), because
# a browser what-if on a cell with missing Landsat features would otherwise follow routes the final model never uses. Its serialised form is verified with an independent NumPy evaluator
# against XGBoost (max |Δ| < 10⁻³ °C, missing values included) and carries 50 check rows for the JavaScript
# evaluator.

# %%
import hashlib as _s08_hashlib
import math as _s08_math
import time as _s08_time
import warnings as _s08_warnings
from decimal import ROUND_HALF_UP as _S08_ROUND_HALF_UP
from decimal import Decimal as _S08_Decimal
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import xgboost as xgb
from scipy import ndimage as _s08_ndi

_S08_VERSION = "08-v2.1"
_S08_GROUPS = list(SHAP_GROUPS)
_S08_NG = len(_S08_GROUPS)
_S08_K = len(FEATURES)
if _S08_NG != 18 or _S08_K != 47:
    raise AssertionError(f"08 expects 47 features in 18 SHAP groups, got {_S08_K} / {_S08_NG}")
# Membership matrix M (47 x 18): group SHAP = phi @ M, group interactions = M^T Phi M.
_S08_MEMBER = np.zeros((_S08_K, _S08_NG), dtype=np.float64)
for _gi, _g in enumerate(_S08_GROUPS):
    for _f in SHAP_GROUPS[_g]:
        _S08_MEMBER[FEATURES.index(_f), _gi] = 1.0
if not np.array_equal(_S08_MEMBER.sum(axis=1), np.ones(_S08_K)):
    raise AssertionError("SHAP_GROUPS must assign every feature to exactly one group")
_S08_PRIMARY = [GROUP_META[g]["primary"] for g in _S08_GROUPS]
_S08_PRIMARY_IDX = np.array([FEATURES.index(p) for p in _S08_PRIMARY], dtype=np.int64)
_S08_BASE_IDX = np.array([FEATURES.index(f) for f in BASE_FEATURES], dtype=np.int64)

# Design matrix in DF row order. DF is sorted by (year, cell_id) over ALL ROI cells, so frame j is the contiguous
# block [j * N_CELLS, (j + 1) * N_CELLS) in canonical cell order - verified here because everything below relies on it.
_S08_X = np.ascontiguousarray(DF[FEATURES].to_numpy(np.float32))
_S08_YEAR = DF["year"].to_numpy(np.int64)
_S08_FRAMES = sorted(int(y) for y in np.unique(_S08_YEAR))
_S08_NC = int(N_CELLS)
if len(DF) != len(_S08_FRAMES) * _S08_NC:
    raise RuntimeError(f"08: DF has {len(DF)} rows, expected {len(_S08_FRAMES)} frames x {_S08_NC} cells")
_s08_cell_col = DF["cell_id"].to_numpy(np.int64)
for _j, _y in enumerate(_S08_FRAMES):
    _sl = slice(_j * _S08_NC, (_j + 1) * _S08_NC)
    if not (np.all(_S08_YEAR[_sl] == _y) and np.array_equal(_s08_cell_col[_sl], np.asarray(CELL_IDS, np.int64))):
        raise RuntimeError(f"08: DF rows of frame {_y} are not the canonical cell block")
del _s08_cell_col
_S08_FRAME_POS = {y: j for j, y in enumerate(_S08_FRAMES)}
# A SHAP row is reported only when all 33 base features exist (focal means and distances derive from them).
_S08_ROW_VALID = np.isfinite(_S08_X[:, _S08_BASE_IDX]).all(axis=1)
_S08_NOW = int(CFG.NOW) if int(CFG.NOW) in _S08_FRAMES else _S08_FRAMES[-1]
_S08_ZONE_META = [
    {"id": 0, "name": "Ecological Cool Base", "color": "#34d399"},
    {"id": 1, "name": "Riparian Buffer", "color": "#22d3ee"},
    {"id": 2, "name": "Transition", "color": "#a78bfa"},
    {"id": 3, "name": "Heat Extreme Core", "color": "#fb7185"},
]
_S08_N_ZONES = 4
_S08_ZONE_NODATA = 255
if int(CFG.K_ZONES) != _S08_N_ZONES:
    log(f"CFG.K_ZONES={CFG.K_ZONES} but the zone contract has 4 canonical zones; using K=4", "WARNING")
# Monotone constraints of the final model (SPEC §4.3) - bootstrap refits and the surrogate use the same signs.
_S08_MONOTONE = {
    "day": {f: -1 for f in ("ndvi", "ndvi_m3", "ndvi_m15", "frac_forest", "frac_forest_m3", "frac_forest_m15",
                            "frac_water", "frac_water_m3", "frac_water_m15", "mndwi")},
    "night": {f: 1 for f in ("built_v", "frac_built", "frac_built_m3", "frac_built_m15")},
}
_S08_DEVICE = xgb_device_for(0)
_S08_ON_GPU = _S08_DEVICE != "cpu"
_S08_EVAL_ROWS = 60000 if _S08_ON_GPU else 20000        # bootstrap evaluation sample (dependence / importance)
_S08_INTER_ROWS = (int(CFG.SHAP_INTERACTION_ROWS_PER_FRAME) if _S08_ON_GPU
                   else min(int(CFG.SHAP_INTERACTION_ROWS_PER_FRAME), int(CFG.SHAP_INTERACTION_MAX_ROWS or 4000), 1500))
_S08_KMEANS_FIT_ROWS = 200000     # K-means centroids from a seeded sample (all rows are then assigned)
_S08_DIAG_ROWS = 60000            # K = 2..8 diagnostics sample
_S08_SIL_ROWS = 20000             # silhouette sample
_S08_BOOT_MIN_BLOCKS = 50
_S08_MIN_PRED_BATCH = 16
_S08_PRED_KWARGS = {"margin": {"output_margin": True}, "contribs": {"pred_contribs": True},
                    "interactions": {"pred_interactions": True}}
_S08_RES_KM2 = float(GRID.cell_area_km2)
_S08_DISTRICT_NAMES = {int(d["id"]): d["name"] for d in DISTRICTS}
log(f"08: {len(_S08_FRAMES)} frames x {_S08_NC:,} cells, {_S08_NG} SHAP groups; TreeSHAP on {_S08_DEVICE}; "
    f"bootstrap {CFG.N_BOOTSTRAP} replicates, eval sample {_S08_EVAL_ROWS:,}; interactions {_S08_INTER_ROWS:,} "
    f"rows/frame; current frame {_S08_NOW}")


def _s08_frame_slice(year):
    """DF row slice of one frame (canonical cell order)."""
    j = _S08_FRAME_POS[int(year)]
    return slice(j * _S08_NC, (j + 1) * _S08_NC)


def _s08_fit_frames(mode):
    """Training frames of a mode (frames with at least one row of positive weight)."""
    w = DF[f"w_{mode}"].to_numpy(np.float64)
    return sorted(int(y) for y in np.unique(_S08_YEAR[w > 0]))


def _s08_code_hash(*sections):
    """Code hash of other sections whose functions a stage calls (D4); None without the section-00 helper."""
    fn = globals().get("section_code_hash")
    return fn(*sections) if fn is not None else None


def _s08_hash(*parts):
    """Short SHA-1 over arrays / JSON-able parts (stage-cache keys)."""
    h = _s08_hashlib.sha1()
    for p in parts:
        if isinstance(p, np.ndarray):
            h.update(str(p.dtype).encode())
            h.update(np.ascontiguousarray(p).tobytes())
        elif isinstance(p, (bytes, bytearray)):
            h.update(bytes(p))
        else:
            h.update(repr(p).encode())
        h.update(b"|")
    return h.hexdigest()[:20]


# %% [markdown]
# ## 8.9 XGBoost plumbing: training recipe, batched prediction with OOM fallback
# `_s08_train_booster` reproduces the final-model recipe of section 07 (`CFG.xgb_params` + the mode's monotone
# constraints) for bootstrap refits. Prediction streams row batches; an out-of-memory error halves the batch and, at
# the minimum batch, a *GPU* OOM moves the booster to the CPU (a host OOM propagates).

# %%
def _s08_mono_string(mode):
    return "(" + ",".join(str(int(_S08_MONOTONE.get(mode, {}).get(f, 0))) for f in FEATURES) + ")"


def _s08_train_booster(mode, X, y, w, rounds, device, seed):
    """Train one booster with the final-model recipe; a CUDA OOM retries on the CPU. Returns (booster, device)."""
    for dev in dict.fromkeys([device, "cpu"]):
        params = CFG.xgb_params(dev, seed=int(seed), monotone_constraints=_s08_mono_string(mode))
        try:
            dtrain = xgb.QuantileDMatrix(X, label=y, weight=w, max_bin=int(params.get("max_bin", 256)))
            try:
                booster = xgb.train(params, dtrain, num_boost_round=int(rounds), verbose_eval=False)
            finally:
                del dtrain
            return booster, dev
        except Exception as exc:  # noqa: BLE001
            if dev == "cpu" or not is_gpu_oom_error(exc):
                raise
            log(f"08: GPU OOM training on {dev} ({type(exc).__name__}); retrying on the CPU", "WARNING")
            free_memory()
    raise RuntimeError("unreachable: training loop exhausted")


def _s08_iter_predict(booster, X, *, device, batch, kind, state=None):
    """Yield (start, stop, output) over row batches of X ("margin" | "contribs" | "interactions")."""
    booster.set_param({"device": device})
    batch = max(_S08_MIN_PRED_BATCH, int(batch))
    start, n = 0, len(X)
    while start < n:
        stop = min(n, start + batch)
        try:
            dmat = xgb.DMatrix(X[start:stop], missing=np.nan)
            out = booster.predict(dmat, **_S08_PRED_KWARGS[kind])
            del dmat
        except Exception as exc:  # noqa: BLE001
            gpu_oom = device != "cpu" and is_gpu_oom_error(exc)
            if not (gpu_oom or is_oom_error(exc)):
                raise
            if batch > _S08_MIN_PRED_BATCH:
                batch = max(_S08_MIN_PRED_BATCH, batch // 2)
                log(f"08: OOM in {kind} prediction; batch halved to {batch}", "WARNING")
            elif gpu_oom:
                device = "cpu"
                booster.set_param({"device": "cpu"})
                if state is not None:
                    state["cpu_fallback"] = True
                log(f"08: GPU OOM in {kind} prediction at the minimum batch; falling back to the CPU", "WARNING")
            else:
                raise
            continue
        yield start, stop, out
        start = stop


def _s08_predict_all(booster, X, *, device, kind, batch=None):
    """Concatenated float32 output of `_s08_iter_predict` (empty input -> empty array)."""
    if len(X) == 0:
        width = {"margin": (), "contribs": (_S08_K + 1,), "interactions": (_S08_K + 1, _S08_K + 1)}[kind]
        return np.zeros((0,) + width, dtype=np.float32)
    batch = int(batch or CFG.SHAP_BATCH)
    parts = [out.astype(np.float32, copy=False)
             for _, _, out in _s08_iter_predict(booster, X, device=device, batch=batch, kind=kind)]
    return np.concatenate(parts, axis=0)


def _s08_margin(booster, X, device):
    return _s08_predict_all(booster, X, device=device, kind="margin").astype(np.float64)


# %% [markdown]
# ## 8.10 Dependence curves and threshold estimators (ported unchanged from v1)
# Pure functions shared by the final model and every bootstrap replicate.

# %%
def _s08_bin_index(x, edges):
    """Bin id of each value (0..nb-1, the last bin is closed), -1 for NaN."""
    x = np.asarray(x, dtype=np.float64)
    nb = len(edges) - 1
    idx = np.clip(np.searchsorted(edges, x, side="right") - 1, 0, max(nb - 1, 0))
    idx[~np.isfinite(x)] = -1
    return idx


def _s08_quantile_edges(x, n_bins):
    """Atom-aware quantile bin edges fixed on the full data (≥ 2 edges, no empty bin).

    Every value holding ≥ 1/n_bins of the data gets a bin of its own ([a, nextafter(a)) isolates atom a); the other
    bins are equal-count quantiles of the remaining values. Empty bins are merged into a neighbour and, when atoms
    split quantile bins, the smallest non-atom bins are merged until at most ``n_bins`` remain.
    """
    xf = np.asarray(x, dtype=np.float64)
    xf = xf[np.isfinite(xf)]
    if xf.size == 0:
        return np.array([0.0, 0.0])
    n_bins = max(1, int(n_bins))
    values, counts = np.unique(xf, return_counts=True)
    atoms = values[counts * n_bins >= xf.size]
    rest = xf[~np.isin(xf, atoms)] if atoms.size else xf
    parts = [values[[0, -1]], atoms, np.nextafter(atoms, np.inf)]
    if rest.size:
        n_rest = max(1, n_bins - atoms.size)
        parts.append(np.quantile(rest, np.linspace(0.0, 1.0, n_rest + 1)))
    edges = np.unique(np.concatenate(parts))
    if edges.size < 2:
        return np.array([edges[0], edges[0]])
    while edges.size > 2:
        occupied = np.bincount(_s08_bin_index(xf, edges), minlength=edges.size - 1)
        empty = np.flatnonzero(occupied == 0)
        if empty.size == 0:
            break
        i = int(empty[0])
        edges = np.delete(edges, i if i > 0 else 1)
    atom_set = set(atoms.tolist())
    while edges.size - 1 > n_bins:
        occupied = np.bincount(_s08_bin_index(xf, edges), minlength=edges.size - 1)
        is_atom = np.array([float(edges[b]) in atom_set and edges[b + 1] == np.nextafter(edges[b], np.inf)
                            for b in range(edges.size - 1)])
        merged = False
        for b in np.argsort(occupied, kind="stable"):
            if is_atom[b]:
                continue
            nbrs = [n for n in (b - 1, b + 1) if 0 <= n < edges.size - 1 and not is_atom[n]]
            if not nbrs:
                continue
            n = min(nbrs, key=lambda k: occupied[k])
            edges = np.delete(edges, max(b, n))
            merged = True
            break
        if not merged:
            break
    return edges


def _s08_binned_curve(x, s, edges):
    """(centers, mean, counts): mean SHAP per bin (NaN if empty); centers = mean x in the bin (midpoint if empty)."""
    x = np.asarray(x, dtype=np.float64)
    s = np.asarray(s, dtype=np.float64)
    nb = len(edges) - 1
    idx = _s08_bin_index(x, edges)
    ok = (idx >= 0) & np.isfinite(s)
    counts = np.bincount(idx[ok], minlength=nb)
    sum_s = np.bincount(idx[ok], weights=s[ok], minlength=nb)
    sum_x = np.bincount(idx[ok], weights=x[ok], minlength=nb)
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = sum_s / counts
        centers = sum_x / counts
    mids = 0.5 * (np.asarray(edges[:-1], dtype=np.float64) + np.asarray(edges[1:], dtype=np.float64))
    centers = np.where(counts > 0, centers, mids)
    return centers, np.where(counts > 0, mean, np.nan), counts.astype(np.int64)


def _s08_finite_curve(centers, mean, counts=None):
    c = np.asarray(centers, dtype=np.float64)
    m = np.asarray(mean, dtype=np.float64)
    ok = np.isfinite(c) & np.isfinite(m)
    if counts is not None:
        w = np.asarray(counts, dtype=np.float64)
        ok &= w > 0
        return c[ok], m[ok], w[ok]
    return c[ok], m[ok], np.ones(int(ok.sum()))


def _s08_crossings(centers, mean):
    """All sign changes of the curve: (x by linear interpolation, |jump| across each)."""
    c, m, _ = _s08_finite_curve(centers, mean)
    if c.size < 2:
        return np.zeros(0), np.zeros(0)
    m0, m1 = m[:-1], m[1:]
    cross = np.flatnonzero(((m0 < 0) & (m1 >= 0)) | ((m0 > 0) & (m1 <= 0)))
    if cross.size == 0:
        return np.zeros(0), np.zeros(0)
    x = c[cross] - m[cross] * (c[cross + 1] - c[cross]) / (m[cross + 1] - m[cross])
    return x.astype(np.float64), np.abs(m1[cross] - m0[cross]).astype(np.float64)


def _s08_zero_crossing(centers, mean, ref=None, dominance=2.0):
    """Single / dominant sign change (None otherwise); with ``ref`` the crossing nearest to the full-data one."""
    x, jump = _s08_crossings(centers, mean)
    if x.size == 0:
        return None
    if ref is not None and np.isfinite(ref):
        return float(x[int(np.argmin(np.abs(x - float(ref))))])
    if x.size == 1:
        return float(x[0])
    order = np.argsort(jump)[::-1]
    if jump[order[0]] >= dominance * jump[order[1]]:
        return float(x[order[0]])
    return None


def _s08_zero_crossing_is_multiple(centers, mean, dominance=2.0):
    x, jump = _s08_crossings(centers, mean)
    if x.size < 2:
        return False
    top2 = np.sort(jump)[::-1][:2]
    return bool(top2[0] < dominance * top2[1])


def _s08_hinge_fit(c, m, w, candidates):
    """Weighted continuous hinge y = b0 + b1 x + b2 max(0, x - h) for every candidate h (batched 3x3 solves)."""
    h = np.asarray(candidates, dtype=np.float64)[:, None]
    A = np.stack([np.ones((h.shape[0], c.size)), np.broadcast_to(c, (h.shape[0], c.size)),
                  np.maximum(0.0, c[None, :] - h)], axis=2)
    Aw = A * w[None, :, None]
    ata = np.einsum("cni,cnj->cij", Aw, A) + 1e-12 * np.eye(3)[None]
    aty = np.einsum("cni,n->ci", Aw, m)
    try:
        beta = np.linalg.solve(ata, aty[..., None])[..., 0]
    except np.linalg.LinAlgError:
        # Degenerate curves (few distinct bin centres, e.g. a near-constant primary feature, or a candidate whose
        # hinge column is collinear with [1, x]) make some 3x3 systems exactly singular; the minimum-norm
        # least-squares solution is then the right fit (integrator finding on the gee-mock path).
        beta = np.einsum("cij,cj->ci", np.linalg.pinv(ata), aty)
    resid = m[None, :] - np.einsum("cni,ci->cn", A, beta)
    return (w[None, :] * resid ** 2).sum(axis=1), beta


_S08_HINGE_MIN_SIDE_BINS = 5
_S08_HINGE_MIN_SIDE_WEIGHT = 0.05


def _s08_hinge_breakpoint(centers, mean, counts):
    """(breakpoint, slope_before, slope_after) of the best count-weighted hinge, or (None, None, None)."""
    c, m, w = _s08_finite_curve(centers, mean, counts)
    n = c.size
    if n < 5:
        return None, None, None
    lo, hi = max(1, int(np.floor(0.1 * (n - 1)))), min(n - 2, int(np.ceil(0.9 * (n - 1))))
    if hi <= lo:
        return None, None, None
    candidates = np.unique(np.concatenate([c[lo:hi + 1], np.linspace(c[lo], c[hi], 121)]))
    sse, beta = _s08_hinge_fit(c, m, w, candidates)
    lin = np.polyfit(c, m, 1, w=np.sqrt(w))
    sse_lin = float(np.sum(w * (m - np.polyval(lin, c)) ** 2))
    best = int(np.argmin(sse))
    if sse_lin <= 1e-12 or sse[best] > 0.9 * sse_lin:
        return None, None, None
    h = float(candidates[best])
    eps = 1e-9 * max(1.0, float(np.max(np.abs(c))))
    if h <= c[lo] + eps or h >= c[hi] - eps:
        return None, None, None
    left, right = c <= h, c > h
    total_w = float(w.sum())
    if (left.sum() < _S08_HINGE_MIN_SIDE_BINS or right.sum() < _S08_HINGE_MIN_SIDE_BINS
            or w[left].sum() < _S08_HINGE_MIN_SIDE_WEIGHT * total_w
            or w[right].sum() < _S08_HINGE_MIN_SIDE_WEIGHT * total_w):
        return None, None, None
    b1, b2 = float(beta[best, 1]), float(beta[best, 2])
    return h, b1, b1 + b2


def _s08_smooth3(m):
    num = np.convolve(m, np.ones(3), mode="same")
    den = np.convolve(np.ones_like(m), np.ones(3), mode="same")
    return num / den


_S08_SAT_MAX_TAIL_SHARE = 0.25


def _s08_saturation_point(centers, mean):
    """First x after the steepest section where |smoothed slope| < 10 % of its max for ≥ 3 bins (knee-refined).

    A saturation must also be *final*: the smoothed curve may change by at most ``_S08_SAT_MAX_TAIL_SHARE`` of its
    total range between the candidate and the last bin. Without this guard a zero-inflated predictor (e.g.
    ``frac_water``: most cells exactly 0, so the first bin-to-bin step is by far the steepest) reported a
    "saturation" on the first short noisy plateau although the curve kept falling for another 80 % of its range.
    """
    c, m, _ = _s08_finite_curve(centers, mean)
    if c.size < 5 or np.any(np.diff(c) <= 0):
        return None
    ms = _s08_smooth3(m)
    slope = np.abs(np.gradient(ms, c))
    smax = float(np.max(slope))
    if not np.isfinite(smax) or smax <= 0:
        return None
    steep = int(np.argmax(slope))
    flat = slope < 0.1 * smax
    span = float(np.ptp(ms))
    onset = next((j for j in range(steep + 1, c.size - 2)
                  if flat[j:j + 3].all() and abs(float(ms[-1] - ms[j])) <= _S08_SAT_MAX_TAIL_SHARE * span), None)
    if onset is None:
        return None
    lo, hi = max(steep, onset - 4), min(c.size - 1, onset + 2)
    seg_c, seg_m = c[lo:hi + 1], m[lo:hi + 1]
    if seg_c.size < 4:
        return float(c[onset])
    candidates = np.linspace(c[lo], c[onset], 81)
    sse, _ = _s08_hinge_fit(seg_c, seg_m, np.ones(seg_c.size), candidates)
    return float(candidates[int(np.argmin(sse))])


def _s08_effect_direction(x, s):
    """'warming' / 'cooling' from the sign of Spearman rho(x, SHAP); |rho| < 0.2 -> 'mixed'."""
    x = np.asarray(x, dtype=np.float64)
    s = np.asarray(s, dtype=np.float64)
    ok = np.isfinite(x) & np.isfinite(s)
    if ok.sum() < 10 or np.ptp(x[ok]) == 0 or np.ptp(s[ok]) == 0:
        return "mixed"
    try:
        from scipy.stats import spearmanr

        rho = float(spearmanr(x[ok], s[ok]).correlation)
    except ImportError:
        rx = pd.Series(x[ok]).rank().to_numpy()
        rs = pd.Series(s[ok]).rank().to_numpy()
        rho = float(np.corrcoef(rx, rs)[0, 1])
    if not np.isfinite(rho) or abs(rho) < 0.2:
        return "mixed"
    return "warming" if rho > 0 else "cooling"


def _s08_curve_thresholds(centers, mean, counts, zc_ref=None, zc_tol=None):
    """(zero_crossing, breakpoint, saturation) as floats, NaN for 'not found'.

    The zero crossing uses the full-data rule (a single or dominant sign change). Replicates pass the full-data
    crossing ``zc_ref`` and a tolerance ``zc_tol``: a replicate's own crossing counts only when it exists and lies
    within ``zc_tol`` of ``zc_ref`` (a crossing elsewhere on a wiggly curve is not support for the reported one).
    """
    zc = _s08_zero_crossing(centers, mean)
    if zc is not None and zc_ref is not None:
        if not np.isfinite(zc_ref) or zc_tol is None or not abs(zc - float(zc_ref)) <= float(zc_tol):
            zc = None
    bp, _, _ = _s08_hinge_breakpoint(centers, mean, counts)
    sat = _s08_saturation_point(centers, mean)
    return [np.nan if v is None else v for v in (zc, bp, sat)]


def _s08_zc_tolerance(x, edges):
    """Replicate zero-crossing tolerance: max(one median bin width, 10 % of the primary's p05-p95 range)."""
    x = np.asarray(x, np.float64)
    x = x[np.isfinite(x)]
    width = np.diff(np.asarray(edges, np.float64))
    scale = max(1.0, float(np.max(np.abs(edges)))) if len(edges) else 1.0
    width = width[width > 1e-9 * scale]                 # atom bins [a, nextafter(a)) have no width
    med = float(np.median(width)) if width.size else 0.0
    spread = float(np.subtract(*np.percentile(x, [95, 5]))) if x.size else 0.0
    return max(med, 0.1 * spread)


def _s08_recentred_interval(theta_hat, boot, lower=None):
    """Recentred percentile interval elementwise over the leading replicate axis -> (lo, hi, bias)."""
    boot = np.asarray(boot, dtype=np.float64)
    theta_hat = np.asarray(theta_hat, dtype=np.float64)
    if boot.ndim == 0 or boot.shape[0] == 0:
        nan = np.full(theta_hat.shape, np.nan)
        return nan, nan.copy(), nan.copy()
    with _s08_warnings.catch_warnings():
        _s08_warnings.simplefilter("ignore", RuntimeWarning)
        n_ok = np.isfinite(boot).sum(axis=0)
        q_lo, q_med, q_hi = np.nanpercentile(boot, [2.5, 50.0, 97.5], axis=0)
    lo, hi = theta_hat + (q_lo - q_med), theta_hat + (q_hi - q_med)
    bad = n_ok < 2
    lo, hi = np.where(bad, np.nan, lo), np.where(bad, np.nan, hi)
    if lower is not None:
        lo = np.maximum(lo, lower)
    return lo, hi, np.where(bad, np.nan, q_med - theta_hat)


def _s08_boot_ci(values, point):
    """(interval, support) of one threshold; the interval only when the point exists and support ≥ 0.5."""
    v = np.asarray(values, dtype=np.float64)
    support = float(np.isfinite(v).mean()) if v.size else 0.0
    if point is None or support < 0.5 or np.isfinite(v).sum() < 2:
        return None, (None if point is None else support)
    lo, hi, _ = _s08_recentred_interval(np.array([float(point)]), v[:, None])
    return [float(lo[0]), float(hi[0])], support


def _s08_curve_slope(centers, mean, counts):
    """Count-weighted least-squares slope of the binned curve (°C per unit of x) or None."""
    c, m, w = _s08_finite_curve(centers, mean, counts)
    if c.size < 3 or np.ptp(c) <= 0:
        return None
    return float(np.polyfit(c, m, 1, w=np.sqrt(w))[0])


# %% [markdown]
# ## 8.11 Scenario coupling and the counterfactual engine (focal recompute, distances fixed)
# **Coupling** = partial OLS slopes (d index / d fraction, with intercept, all cells × frames) of `ndvi`, `ndvi_spring`,
# `ndbi`, `mndwi` and `albedo` on the five fractions; *other vegetation* is the omitted reference class, so no slope is
# needed for it. The engine below is the Python twin of the dashboard's `perturbBaseV2` + focal recompute.

# %%
_S08_FRACTIONS = ["frac_built", "frac_forest", "frac_water", "frac_cropland", "frac_barren"]
_S08_COUPLED = ["ndvi", "ndvi_spring", "ndbi", "mndwi", "albedo"]
_S08_FRAC_IDX = [FEATURES.index(f) for f in _S08_FRACTIONS]
_S08_BOUNDS = {"ndvi": (-1.0, 1.0), "ndvi_spring": (-1.0, 1.0), "ndbi": (-1.0, 1.0), "mndwi": (-1.0, 1.0),
               "albedo": (0.0, 1.0), "lm_contag": (0.0, 100.0), "lm_pd": (0.0, np.inf), "lm_ed": (0.0, np.inf),
               **{f: (0.0, 1.0) for f in _S08_FRACTIONS}}


def _s08_scenario_coupling():
    """SCENARIO_COUPLING (mode-independent; v1 format + focal spec, grid shape and the derived-feature rules)."""
    A_all = _S08_X[:, _S08_FRAC_IDX].astype(np.float64)
    coupling = {f: {} for f in _S08_FRACTIONS}
    r2, intercept, n_used = {}, {}, {}
    for index in _S08_COUPLED:
        y = _S08_X[:, FEATURES.index(index)].astype(np.float64)
        ok = np.isfinite(y) & np.isfinite(A_all).all(axis=1)
        if ok.sum() < 10:
            log(f"08: coupling of {index} has only {int(ok.sum())} complete rows; slopes set to 0", "WARNING")
            for f in _S08_FRACTIONS:
                coupling[f][index] = 0.0
            r2[index], intercept[index], n_used[index] = None, None, int(ok.sum())
            continue
        design = np.column_stack([np.ones(int(ok.sum())), A_all[ok]])
        beta, *_ = np.linalg.lstsq(design, y[ok], rcond=None)
        resid = y[ok] - design @ beta
        sst = float(np.sum((y[ok] - y[ok].mean()) ** 2))
        r2[index] = 1.0 - float(np.sum(resid ** 2)) / sst if sst > 0 else None
        intercept[index] = float(beta[0])
        n_used[index] = int(ok.sum())
        for k, f in enumerate(_S08_FRACTIONS):
            coupling[f][index] = float(beta[k + 1])
    return {
        "description": ("Partial OLS slopes (d index / d fraction) of NDVI, spring NDVI, NDBI, MNDWI and albedo on "
                        "the five land-cover fractions (with intercept; other vegetation is the omitted reference "
                        "class), fitted on all cells and frames. A fraction change exchanges land with the other "
                        "fractions and the implicit other-vegetation share in proportion to their current values; "
                        "each index shifts by the sum of slope x actual fraction change (clamped to its range); "
                        "ndvi_drop = ndvi_spring - ndvi is recomputed; the 3- and 15-cell focal means are recomputed "
                        "on the grid and distances are held fixed."),
        "fraction_features": list(_S08_FRACTIONS),
        "coupled_indices": list(_S08_COUPLED),
        "coupling": coupling, "r2": r2, "intercept": intercept, "n": n_used,
        "derived": {"ndvi_drop": "ndvi_spring - ndvi (recomputed after any change)",
                    "ndvi_spring": "follows a direct NDVI shift by the same amount; coupled explicitly for "
                                   "fraction changes"},
        "bounds": {k: [float(v[0]), (None if not np.isfinite(v[1]) else float(v[1]))] for k, v in _S08_BOUNDS.items()},
        "distances": "held fixed (dist_water, dist_urban, dist_builtup)",
        "focal": {"bases": list(FOCAL_SPEC["bases"]), "windows": [int(w) for w in FOCAL_SPEC["windows"]]},
        "grid": {"width": int(GRID.width), "height": int(GRID.height)},
    }


def _s08_rebalance(F, k, delta):
    """Compositional change of fraction column ``k`` by ``delta`` for every row of F (n, 5).

    The implicit other-vegetation share ``1 - sum(F)`` is a sixth donor/recipient: an increase is capped by the land
    the others can give up and taken from them in proportion to their current values; a decrease (capped at the
    current value) gives the freed land to them in the same proportions (equally when they are all 0).
    Returns (F_after, other_after, applied).
    """
    F = np.asarray(F, dtype=np.float64)
    x = F[:, k]
    other = np.clip(1.0 - F.sum(axis=1), 0.0, None)
    donors = np.column_stack([np.delete(F, k, axis=1), other])
    dsum = donors.sum(axis=1)
    if delta > 0:
        applied = np.clip(np.minimum(np.minimum(delta, 1.0 - x), dsum), 0.0, None)
    else:
        applied = np.maximum(delta, -x)
    with np.errstate(invalid="ignore", divide="ignore"):
        share = np.where(dsum[:, None] > 0, donors / dsum[:, None], 1.0 / donors.shape[1])
    donors_after = np.clip(donors - applied[:, None] * share, 0.0, 1.0)
    F_after = F.copy()
    F_after[:, k] = np.clip(x + applied, 0.0, 1.0)
    others = [i for i in range(F.shape[1]) if i != k]
    F_after[:, others] = donors_after[:, :-1]
    return F_after, donors_after[:, -1], applied


def _s08_perturb(vals, feature, step, coupled=True):
    """Shift ``feature`` by ``step`` in the base-feature vectors ``vals`` (dict name -> (n,) float64).

    Returns (changed: dict name -> new (n,) values, applicable bool (n,), applied change (n,), donors dict of mean
    fraction changes). Fractions: compositional + coupled indices; other levers: direct shift clamped to their range.
    Spring NDVI follows a season-NDVI shift unless it was coupled explicitly; ndvi_drop is recomputed.
    """
    n = len(vals[feature])
    changed, donors = {}, {}
    applied = np.zeros(n)
    ndvi_shift = np.zeros(n)
    if feature in _S08_FRACTIONS:
        F = np.column_stack([vals[f] for f in _S08_FRACTIONS])
        ok = np.isfinite(F).all(axis=1)
        F_ok = F[ok]
        other_before = np.clip(1.0 - F_ok.sum(axis=1), 0.0, None)
        F_after, other_after, app = _s08_rebalance(F_ok, _S08_FRACTIONS.index(feature), float(step))
        applied[ok] = app
        d_frac = F_after - F_ok
        for i, f in enumerate(_S08_FRACTIONS):
            col = vals[f].copy()
            col[ok] = F_after[:, i]
            changed[f] = col
            if f != feature:
                donors[f] = float(d_frac[:, i].mean()) if d_frac.size else 0.0
        donors["other_vegetation"] = float((other_after - other_before).mean()) if d_frac.size else 0.0
        if coupled:
            for index in _S08_COUPLED:
                slopes = np.array([SCENARIO_COUPLING["coupling"][f].get(index, 0.0) for f in _S08_FRACTIONS])
                shift = d_frac @ slopes
                lo, hi = _S08_BOUNDS.get(index, (-np.inf, np.inf))
                col = vals[index].copy()
                old = col[ok]
                new = np.where(np.isfinite(old), np.clip(old + shift, lo, hi), old)
                col[ok] = new
                changed[index] = col
                if index == "ndvi":
                    ndvi_shift[ok] = np.where(np.isfinite(old), new - old, 0.0)
    else:
        ok = np.isfinite(vals[feature])
        lo, hi = _S08_BOUNDS.get(feature, (-np.inf, np.inf))
        col = vals[feature].copy()
        col[ok] = np.clip(col[ok] + float(step), lo, hi)
        applied[ok] = col[ok] - vals[feature][ok]
        changed[feature] = col
        if feature == "ndvi":
            ndvi_shift[ok] = applied[ok]
    if "ndvi_spring" not in changed and np.any(ndvi_shift != 0):
        lo, hi = _S08_BOUNDS["ndvi_spring"]
        spring = vals["ndvi_spring"].copy()
        move = np.isfinite(spring) & (ndvi_shift != 0)
        spring[move] = np.clip(spring[move] + ndvi_shift[move], lo, hi)
        changed["ndvi_spring"] = spring
    if "ndvi" in changed or "ndvi_spring" in changed:
        spring = changed.get("ndvi_spring", vals["ndvi_spring"])
        ndvi = changed.get("ndvi", vals["ndvi"])
        drop = vals["ndvi_drop"].copy()
        both = np.isfinite(spring) & np.isfinite(ndvi)
        drop[both] = spring[both] - ndvi[both]
        changed["ndvi_drop"] = drop
    return changed, ok, applied, donors


_S08_PERTURB_INPUTS = sorted(set(_S08_FRACTIONS) | set(_S08_COUPLED) | {"ndvi_drop", "lm_ed", "lm_pd", "lm_contag"})


def _s08_counterfactual(year, cells, feature, step, coupled=True):
    """Counterfactual feature rows of frame ``year`` after shifting ``feature`` by ``step`` in the cells ``cells``.

    The base features are perturbed (`_s08_perturb`), written back into copies of the frame's feature grids, and the
    focal means of every changed focal base are recomputed with ``FOCAL_RECOMPUTE`` (distances held fixed) and kept
    only inside the w x w dilation footprint of the edited cells, so neighbouring cells change too and nothing else
    does. Returns {"pos": canonical positions of the cells evaluated by the model (material changes plus every
    changed cell of the edited region), "X": their counterfactual rows (float32), "zone_ok": applicable zone cells,
    "zone_cells", "applied", "donors", "n_spill" and "spill_pos" (indices into ``pos`` of the spill-over cells)}.
    """
    grids = FEATURE_GRIDS[int(year)]
    cells = np.asarray(cells, dtype=np.int64)
    r, c = CELL_ROWS[cells], CELL_COLS[cells]
    needed = set(_S08_PERTURB_INPUTS) | {feature}
    vals = {f: np.asarray(grids[f], np.float64)[r, c] for f in needed}
    changed, ok, applied, donors = _s08_perturb(vals, feature, step, coupled=coupled)
    new_grids = {}
    for f, v in changed.items():
        if np.array_equal(v, vals[f], equal_nan=True):
            continue
        g = np.array(grids[f], dtype=np.float32, copy=True)
        g[r, c] = v.astype(np.float32)
        new_grids[f] = g
    changed_bases = [b for b in FOCAL_SPEC["bases"] if b in new_grids]
    if changed_bases:
        focal_in = {b: new_grids.get(b, grids[b]) for b in FOCAL_SPEC["bases"]}
        focal = FOCAL_RECOMPUTE(focal_in, recompute_distances=False)
        for b in changed_bases:
            # Only cells whose w x w window contains an edited cell can change; everywhere else the old focal
            # value is kept, so a full-grid recompute cannot leak float residues into untouched cells (D17).
            old_b = np.asarray(grids[b], np.float32)
            new_b = np.asarray(new_grids[b], np.float32)
            edited = ~((old_b == new_b) | (np.isnan(old_b) & np.isnan(new_b)))
            for w in FOCAL_SPEC["windows"]:
                name = f"{b}_m{w}"
                footprint = _s08_ndi.binary_dilation(edited, structure=np.ones((int(w), int(w)), bool))
                new_grids[name] = np.where(footprint, focal[name], np.asarray(grids[name], np.float32)).astype(
                    np.float32)
    X_frame = _S08_X[_s08_frame_slice(year)]
    in_zone = np.zeros(_S08_NC, dtype=bool)
    in_zone[cells] = True
    if not new_grids:
        return {"pos": np.zeros(0, np.int64), "X": np.zeros((0, _S08_K), np.float32), "zone_ok": cells[ok],
                "zone_cells": cells, "applied": applied[ok], "donors": donors, "n_spill": 0,
                "spill_pos": np.zeros(0, np.int64)}
    cols = [FEATURES.index(f) for f in new_grids]
    new_cols = np.column_stack([np.asarray(new_grids[f], np.float32)[CELL_ROWS, CELL_COLS] for f in new_grids])
    old_cols = X_frame[:, cols]
    exact_same = (new_cols == old_cols) | (np.isnan(new_cols) & np.isnan(old_cols))
    # a material change: > 1e-6 x max(1, |x_old|) in any feature, or NaN <-> finite (D17 spill-over definition)
    with np.errstate(invalid="ignore"):
        tol = 1e-6 * np.maximum(1.0, np.abs(old_cols.astype(np.float64)))
        material = (np.abs(new_cols.astype(np.float64) - old_cols.astype(np.float64)) > tol) | (
            np.isnan(new_cols) != np.isnan(old_cols))
    row_material = material.any(axis=1)
    # rows evaluated by the model: every material change plus any exact change inside the edited region
    pos = np.flatnonzero(row_material | (in_zone & ~exact_same.all(axis=1)))
    Xcf = X_frame[pos].copy()
    Xcf[:, cols] = new_cols[pos]
    spill_pos = np.flatnonzero(~in_zone[pos])            # canonical cells are ROI cells by construction
    return {"pos": pos, "X": np.ascontiguousarray(Xcf, dtype=np.float32), "zone_ok": cells[ok],
            "zone_cells": cells, "applied": applied[ok], "donors": donors, "n_spill": int(spill_pos.size),
            "spill_pos": spill_pos}


def _s08_cf_effect(booster, device, year, cf, base_margin=None):
    """(zone mean Δ, spill-over mean Δ, n spill-over cells) of one counterfactual under ``booster``.

    Δ is the change of the prediction (°C) per cell; cells whose feature row did not change have Δ = 0. The zone
    effect averages over the applicable zone cells. Spill-over cells (D17) are the ROI cells outside the edited
    region whose feature row changed materially (> 1e-6 relative in any feature, or NaN <-> finite); the spill-over
    mean is the mean Δ over all of them, zeros included.
    """
    if cf["zone_ok"].size == 0:
        return np.nan, np.nan, 0
    d = np.zeros(_S08_NC)
    if cf["pos"].size:
        pred_cf = _s08_margin(booster, cf["X"], device)
        if base_margin is None:
            pred_base = _s08_margin(booster, _S08_X[_s08_frame_slice(year)][cf["pos"]], device)
        else:
            pred_base = base_margin[cf["pos"]]
        d[cf["pos"]] = pred_cf - pred_base
    spill = cf["pos"][cf["spill_pos"]] if cf["pos"].size else np.zeros(0, np.int64)
    zone_delta = float(np.mean(d[cf["zone_ok"]]))
    spill_delta = float(np.mean(d[spill])) if spill.size else 0.0
    return zone_delta, spill_delta, int(spill.size)


SCENARIO_COUPLING = _s08_scenario_coupling()
print("SCENARIO_COUPLING slopes (d index / d fraction):")
print(pd.DataFrame(SCENARIO_COUPLING["coupling"]).T.round(3).to_string())
print("R2:", {k: (round(v, 3) if v is not None else None) for k, v in SCENARIO_COUPLING["r2"].items()})


# %% [markdown]
# ## 8.12 Zoning helpers: K-means, the v2 labelling rule and `ASSIGN_ZONES`

# %%
def _s08_to_numpy(arr):
    if hasattr(arr, "to_numpy"):
        arr = arr.to_numpy()
    if hasattr(arr, "get"):
        arr = arr.get()
    return np.asarray(arr)


def _s08_kmeans(X, k, n_init, seed):
    """(labels int32, inertia, centers (k, d)) - cuML on the GPU with USE_RAPIDS, else scikit-learn."""
    if ENV.get("has_cuml") and CFG.USE_RAPIDS:
        try:
            from cuml.cluster import KMeans as _CuKMeans

            model = _CuKMeans(n_clusters=k, n_init=n_init, random_state=seed, max_iter=300)
            model.fit(X)
            ENV.setdefault("rapids_used", set()).add("cuml_kmeans")
            return (_s08_to_numpy(model.labels_).astype(np.int32), float(model.inertia_),
                    _s08_to_numpy(model.cluster_centers_).astype(np.float64))
        except Exception as exc:  # noqa: BLE001
            log(f"08: cuML KMeans failed ({type(exc).__name__}: {exc}); using scikit-learn", "WARNING")
    from sklearn.cluster import KMeans

    model = KMeans(n_clusters=k, n_init=n_init, random_state=seed).fit(X)
    return model.labels_.astype(np.int32), float(model.inertia_), np.asarray(model.cluster_centers_, np.float64)


def _s08_nearest_centroid(M, centroids, chunk=262144):
    """Index of the nearest centroid (squared Euclidean) per row; -1 for rows with NaN."""
    M = np.asarray(M, dtype=np.float64)
    C = np.asarray(centroids, dtype=np.float64)
    out = np.full(len(M), -1, dtype=np.int64)
    ok = np.isfinite(M).all(axis=1)
    idx = np.flatnonzero(ok)
    c2 = (C * C).sum(axis=1)
    for s in range(0, idx.size, chunk):
        part = M[idx[s:s + chunk]]
        d2 = (part * part).sum(axis=1)[:, None] - 2.0 * part @ C.T + c2[None, :]
        out[idx[s:s + chunk]] = np.argmin(d2, axis=1)
    return out


def ASSIGN_ZONES(m, shap_group_matrix):
    """Zone ids (uint8) by nearest centroid of ``ZONE_MODEL[m]`` in the 18-group SHAP space (255 for NaN rows).

    ``shap_group_matrix``: (n, 18) group SHAP values in ``SHAP_GROUPS`` order (°C). Used for observed frames here and
    for projected frames in section 11, so every frame is zoned in the same space.
    """
    if m not in ZONE_MODEL:
        raise KeyError(f"no zone model for mode {m!r} (available: {sorted(ZONE_MODEL)})")
    M = np.asarray(shap_group_matrix, dtype=np.float64)
    if M.ndim != 2 or M.shape[1] != _S08_NG:
        raise ValueError(f"expected an (n, {_S08_NG}) group-SHAP matrix, got {M.shape}")
    nearest = _s08_nearest_centroid(M, ZONE_MODEL[m]["centroids"])
    out = np.full(len(M), _S08_ZONE_NODATA, dtype=np.uint8)
    out[nearest >= 0] = nearest[nearest >= 0].astype(np.uint8)
    return out


# Riparian eligibility (D11, SPEC §1.5): a non-core cluster shows a riparian signature if ANY of these holds.
_S08_RIPARIAN_MEAN_WATER = 0.05          # mean frac_water >= 5 %
_S08_RIPARIAN_WET_FRAC = 0.2             # ... or >= 25 % of its rows have frac_water >= 0.2
_S08_RIPARIAN_WET_SHARE = 0.25
_S08_RIPARIAN_WATER_SHAP_C = 0.25        # ... or 'water' is its top mean-|SHAP| group with >= 0.25 °C
_S08_RIPARIAN_CRITERION = (f"mean frac_water >= {_S08_RIPARIAN_MEAN_WATER:g}, or >= {_S08_RIPARIAN_WET_SHARE:.0%} "
                           f"of the cluster's rows with frac_water >= {_S08_RIPARIAN_WET_FRAC:g}, or the 'water' group "
                           f"has the largest mean |SHAP| of the 18 groups with >= {_S08_RIPARIAN_WATER_SHAP_C:g} °C")
_S08_NO_RIPARIAN_NAME = "Moderate mosaic (no riparian signal)"


def _s08_riparian_reasons(stats):
    """List of the riparian-eligibility conditions a cluster meets (empty = not eligible)."""
    out = []
    fw = stats["mean_frac_water"]
    if np.isfinite(fw) and fw >= _S08_RIPARIAN_MEAN_WATER:
        out.append(f"mean frac_water {fw:.3f} >= {_S08_RIPARIAN_MEAN_WATER:g}")
    if stats["share_water_ge_0_2"] >= _S08_RIPARIAN_WET_SHARE:
        out.append(f"{stats['share_water_ge_0_2']:.0%} of rows with frac_water >= {_S08_RIPARIAN_WET_FRAC:g}")
    if stats["water_group_rank"] == 1 and stats["water_mean_abs_shap"] >= _S08_RIPARIAN_WATER_SHAP_C:
        out.append(f"water is the top mean-|SHAP| group ({stats['water_mean_abs_shap']:.2f} °C)")
    return out


def _s08_label_clusters(raw, group_shap, frac_water):
    """Canonical zone ids from raw cluster labels with the v2 rule (SPEC §1.5, D11). Returns (lut, record).

    3 Heat Extreme Core = highest mean total SHAP. Among the other three a cluster is riparian-eligible by
    ``_S08_RIPARIAN_CRITERION``. If any is eligible: 1 = the eligible cluster with the highest mean frac_water, 0 =
    the lower mean total SHAP of the remaining two, 2 = the last one. If none is: the three are ordered by mean total
    SHAP (lowest -> 0, middle -> 1, highest -> 2) and zone 1 is displayed as a moderate mosaic.
    """
    total = group_shap.sum(axis=1, dtype=np.float64)
    gi_water = _S08_GROUPS.index("water")
    water_g = group_shap[:, gi_water].astype(np.float64)
    cstats = []
    for c in range(_S08_N_ZONES):
        sel = raw == c
        if not sel.any():
            raise RuntimeError(f"08: K-means cluster {c} is empty after assignment")
        fw_c = frac_water[sel]
        fin = np.isfinite(fw_c)
        with _s08_warnings.catch_warnings():
            _s08_warnings.simplefilter("ignore", RuntimeWarning)
            fw = float(np.nanmean(fw_c)) if fin.any() else float("nan")
        mean_abs = np.abs(group_shap[sel].astype(np.float64)).mean(axis=0)
        rank = 1 + int(np.sum(mean_abs > mean_abs[gi_water]))
        cstats.append({"raw_cluster": c, "n": int(sel.sum()), "mean_total_shap": float(total[sel].mean()),
                       "mean_water_shap": float(water_g[sel].mean()), "mean_frac_water": fw,
                       "share_water_ge_0_2": float(np.mean(fw_c[fin] >= _S08_RIPARIAN_WET_FRAC)) if fin.any() else 0.0,
                       "water_mean_abs_shap": float(mean_abs[gi_water]), "water_group_rank": rank})
    hot = int(np.argmax([s["mean_total_shap"] for s in cstats]))
    rest = [c for c in range(_S08_N_ZONES) if c != hot]
    eligible = {c: _s08_riparian_reasons(cstats[c]) for c in rest}
    eligible = {c: r for c, r in eligible.items() if r}
    met = bool(eligible)
    lut = np.empty(_S08_N_ZONES, dtype=np.int64)
    if met:
        riparian = max(eligible, key=lambda c: (cstats[c]["mean_frac_water"]
                                                if np.isfinite(cstats[c]["mean_frac_water"]) else -np.inf))
        rest2 = [c for c in rest if c != riparian]
        cool = min(rest2, key=lambda c: cstats[c]["mean_total_shap"])
        transition = [c for c in rest2 if c != cool][0]
        reasons = {hot: "highest mean total SHAP",
                   riparian: ("riparian-eligible (" + "; ".join(eligible[riparian]) + ") with the highest mean "
                              "frac_water among the eligible non-core clusters"),
                   cool: "lower mean total SHAP of the last two clusters", transition: "remaining cluster"}
    else:
        cool, riparian, transition = sorted(rest, key=lambda c: cstats[c]["mean_total_shap"])
        reasons = {hot: "highest mean total SHAP",
                   cool: "lowest mean total SHAP of the three non-core clusters (no cluster meets the riparian "
                         "criterion)",
                   riparian: "middle mean total SHAP of the three non-core clusters (no riparian signal; named "
                             "Riparian Buffer only by the zone contract)",
                   transition: "highest mean total SHAP of the three non-core clusters"}
    lut[cool], lut[riparian], lut[transition], lut[hot] = 0, 1, 2, 3
    clusters = sorted(({**cstats[c], "zone": int(lut[c]), "name": _S08_ZONE_META[int(lut[c])]["name"],
                        "riparian_eligible": c in eligible, "reason": reasons[c]} for c in range(_S08_N_ZONES)),
                      key=lambda d: d["zone"])
    record = {"rule": ("3 Heat Extreme Core = highest mean total SHAP; among the other three a cluster is "
                       f"riparian-eligible if {_S08_RIPARIAN_CRITERION}; if any is eligible: 1 Riparian Buffer = the "
                       "eligible cluster with the highest mean frac_water, 0 Ecological Cool Base = lower mean total "
                       "SHAP of the remaining two, 2 Transition = the last one; if none is: the three ordered by mean "
                       "total SHAP (lowest 0, middle 1, highest 2) (SPEC §1.5)"),
              "space": "18 grouped SHAP values (°C)", "clusters": clusters,
              "riparian_criterion_met": met, "riparian_criterion": _S08_RIPARIAN_CRITERION}
    return lut, record


def _s08_silhouette(X, labels):
    from sklearn.metrics import silhouette_score

    if len(np.unique(labels)) < 2:
        return float("nan")
    return float(silhouette_score(X, labels))


# %% [markdown]
# ## 8.13 Spatial block bootstrap helpers (block size from the residual correlogram)

# %%
def _s08_residual_correlogram(mode, max_points=3000, bin_km=5.0, max_km=100.0):
    """Pair correlogram of the standardised block20 OOF residuals of the last training frame.

    Falls back to the anomaly target when fewer than 100 OOF residuals exist. Returns (bin upper edges km,
    correlation per bin, variable name).
    """
    w = DF[f"w_{mode}"].to_numpy(np.float64)
    y = DF[f"anom_{mode}"].to_numpy(np.float64)
    frames = _s08_fit_frames(mode)
    rows = np.flatnonzero((_S08_YEAR == frames[-1]) & (w > 0))
    oof = MODEL_RESULTS.get(mode, {}).get("oof", {}).get("block20", {}).get("xgboost")
    values = (y - np.asarray(oof, np.float64))[rows] if oof is not None and len(oof) == len(DF) else np.full(rows.size,
                                                                                                           np.nan)
    name = "block20 XGBoost OOF residual"
    if np.isfinite(values).sum() < 100:
        values, name = y[rows], "anomaly target"
    ok = np.isfinite(values)
    rows, values = rows[ok], values[ok]
    rng = np.random.default_rng(CFG.SEED + 55)
    if rows.size > max_points:
        pick = np.sort(rng.choice(rows.size, size=max_points, replace=False))
        rows, values = rows[pick], values[pick]
    z = (values - values.mean()) / (values.std() or 1.0)
    xy = DF[["x", "y"]].to_numpy(np.float64)[rows] / 1000.0
    edges = np.arange(0.0, max_km + bin_km, bin_km)
    sums = np.zeros(edges.size - 1)
    counts = np.zeros(edges.size - 1)
    for start in range(0, len(z), 500):
        d = np.sqrt(((xy[start:start + 500, None, :] - xy[None, :, :]) ** 2).sum(axis=2))
        prod = z[start:start + 500, None] * z[None, :]
        valid = (d > 0) & (d < max_km)
        b = np.clip((d[valid] // bin_km).astype(np.int64), 0, edges.size - 2)
        sums += np.bincount(b, weights=prod[valid], minlength=edges.size - 1)
        counts += np.bincount(b, minlength=edges.size - 1)
    with np.errstate(invalid="ignore", divide="ignore"):
        corr = sums / counts
    return edges[1:], corr, name


def _s08_block_ids(block_km, rows):
    """Square-block id (row-major from the grid's top-left) of DF ``rows`` for blocks of ``block_km``."""
    b = max(1, int(round(float(block_km) * 1000.0 / float(GRID.res))))
    n_cols = int(_s08_math.ceil(GRID.width / b))
    r = DF["row"].to_numpy(np.int64)[rows]
    c = DF["col"].to_numpy(np.int64)[rows]
    return (r // b) * n_cols + c // b


def _s08_choose_blocks(mode, train_rows):
    """(block code per training row, n blocks, block size km, info) following 8.4."""
    info = {}
    if CFG.BOOT_BLOCK_KM:
        block_km, source = float(CFG.BOOT_BLOCK_KM), "CFG.BOOT_BLOCK_KM"
    else:
        upper, corr, name = _s08_residual_correlogram(mode)
        below = np.flatnonzero(np.isfinite(corr) & (corr < 0.1))
        range_km = float(upper[below[0]] - 2.5) if below.size else float(upper[-1])
        info = {"residual_corr_range_km": range_km, "correlogram_variable": name,
                "correlogram": {f"{u - 5:.0f}-{u:.0f}": (None if not np.isfinite(c) else round(float(c), 3))
                                for u, c in zip(upper[:12], corr[:12])}}
        block_km = max(float(CFG.INNER_BLOCK_KM), 5.0 * _s08_math.ceil(range_km / 5.0))
        source = f"{name} correlogram (< 0.1 beyond ~{range_km:.0f} km)"
    codes, ids = pd.factorize(_s08_block_ids(block_km, train_rows), sort=True)
    while len(ids) < _S08_BOOT_MIN_BLOCKS and block_km - 5.0 >= float(CFG.INNER_BLOCK_KM) and not CFG.BOOT_BLOCK_KM:
        block_km -= 5.0
        codes, ids = pd.factorize(_s08_block_ids(block_km, train_rows), sort=True)
        if "shrunk" not in source:
            source += f"; shrunk to keep >= {_S08_BOOT_MIN_BLOCKS} blocks"
    if len(ids) < _S08_BOOT_MIN_BLOCKS:
        log(f"08 {mode}: only {len(ids)} bootstrap blocks of {block_km:.0f} km (< {_S08_BOOT_MIN_BLOCKS}); "
            "intervals will be coarse", "WARNING")
    return codes.astype(np.int64), len(ids), block_km, {**info, "block_size_source": source}


# %% [markdown]
# ## 8.14 Text helpers for the recommendation rationale (v1 formatting rules)
# Numbers in the sentence are formatted from the exported 4-significant-digit values with round-half-up, like the
# dashboard's Intl formatting, so text and table never disagree on a tie.

# %%
_S08_DONOR_LABELS = {"other_vegetation": "other vegetation"}


def _s08_as_exported(value, scale=1):
    return _S08_Decimal(repr(float(f"{float(value):.4g}"))) * scale


def _s08_fmt_dp(value, dp, scale=1):
    q = _s08_as_exported(value, scale).quantize(_S08_Decimal(1).scaleb(-dp), rounding=_S08_ROUND_HALF_UP)
    return f"{abs(q) if q == 0 else q:f}"


def _s08_fmt_sig(value, sig=3):
    d = _s08_as_exported(value)
    if d == 0:
        return "0"
    q = d.quantize(_S08_Decimal(1).scaleb(d.adjusted() - (sig - 1)), rounding=_S08_ROUND_HALF_UP)
    text = f"{q:,f}"
    return text.rstrip("0").rstrip(".") if "." in text else text


def _s08_fmt_feature_value(feature, value):
    display = FEATURE_META.get(feature, {}).get("display", "number")
    if display == "percent":
        pct = float(_s08_as_exported(value, 100))
        return f"{_s08_fmt_dp(value, 1, 100)}%" if 0 < abs(pct) < 9.95 else f"{_s08_fmt_dp(value, 0, 100)}%"
    if display == "index":
        return _s08_fmt_dp(value, 2)
    return _s08_fmt_sig(value, 3)


def _s08_pp(frac):
    v = float(_s08_as_exported(frac, 100))
    return _s08_fmt_dp(frac, 1, 100) if abs(v) < 9.95 else _s08_fmt_dp(frac, 0, 100)


def _s08_donor_text(plan):
    moves = sorted(((k, v) for k, v in plan["donors"].items() if abs(v) >= 0.005), key=lambda kv: -abs(kv[1]))[:2]
    verb = "taken from" if plan["step"] > 0 else "given to"
    lead = f" The land is {verb} the other land covers (including other vegetation) in proportion to their shares"
    if moves:
        names = [f"{_S08_DONOR_LABELS.get(k, FEATURE_META.get(k, {}).get('label', k)).lower()} "
                 f"({'+' if v > 0 else '-'}{_s08_pp(abs(v))} pp)" for k, v in moves]
        lead += f", mostly {' and '.join(names)}"
    return lead + "; NDVI, spring NDVI, NDBI, MNDWI and albedo follow through the land-cover coupling."


def _s08_rationale(plan, ci, ci_label):
    feature = plan["feature"]
    label = FEATURE_META.get(feature, {}).get("label", feature)

    def fv(v):
        return _s08_fmt_feature_value(feature, v)

    verb = "raising" if plan["step"] > 0 else "lowering"
    step, applied = abs(float(plan["step"])), abs(float(plan.get("mean_applied", plan["step"]) or 0.0))
    capped = applied < 0.95 * step          # many cells hit a bound or have little land to convert
    median = f"(zone median {fv(plan['current'])} → {fv(plan['target'])})"
    if feature in _S08_FRACTIONS:
        if capped:
            change = (f"{verb} {label.lower()} by up to {_s08_pp(step)} percentage points per cell "
                      f"({_s08_pp(applied)} pp on average: cells near the bound or with little land to convert "
                      f"change less) {median}")
        else:
            change = f"{verb} {label.lower()} by {_s08_pp(step)} percentage points in every cell {median}"
    elif feature == "ndvi":
        if capped:
            change = (f"{verb} NDVI by up to {_s08_fmt_dp(step, 2)} per cell ({_s08_fmt_dp(applied, 2)} on average: "
                      f"cells near the bound change less) {median}, i.e. greening within the existing land covers")
        else:
            change = (f"{verb} NDVI by {_s08_fmt_dp(step, 2)} in every cell {median}, i.e. greening within the "
                      "existing land covers")
    else:
        if capped:
            change = (f"{verb} {label.lower()} by up to {_s08_fmt_sig(step, 3)} per cell "
                      f"({_s08_fmt_sig(applied, 3)} on average: cells near the bound change less) {median}")
        else:
            change = f"{verb} {label.lower()} by {_s08_fmt_sig(step, 3)} in every cell {median}"
    donors = _s08_donor_text(plan) if feature in _S08_FRACTIONS else ""
    ci_text = f"{ci_label} {ci[0]:+.2f} to {ci[1]:+.2f} °C" if ci else "no bootstrap interval"
    kind = plan["kind"]
    if kind == "saturation":
        why = (f" The target is where the {label} effect saturates ({fv(plan['target'])} on the pooled dependence "
               "curve); it already achieves ≥ 90% of the cooling available within the bounds.")
    elif kind == "breakpoint":
        why = (f" The target is where the {label} response changes slope ({fv(plan['target'])}); it already "
               "achieves ≥ 90% of the cooling available within the bounds.")
    elif kind == "bound":
        why = " The target is the feasibility bound (the zone's own 90th/10th percentile, or the maximum step)."
    else:
        why = (" The target is the smallest step that achieves ≥ 90% of the cooling available within the "
               "feasibility bounds.")
    spill = ""
    if plan.get("spill_n_cells", 0) > 0:
        spill = (f" The 3- and 15-cell neighbourhood means are recomputed (distances held fixed): "
                 f"{plan['spill_n_cells']:,} cells outside the zone have changed neighbourhood inputs (mean LST "
                 f"change {plan['spill_delta_c']:+.2f} °C over them, cells whose prediction does not move included).")
    return (f"In the final {plan['mode']} model, {change} is associated with a mean LST change of "
            f"{plan['expected_delta_c']:+.2f} °C over the zone's {plan['n_cells']:,} cells ({ci_text}).{donors}"
            f"{spill} This is a model-based ceteris-paribus estimate, not a causal effect.{why}")


# %% [markdown]
# ## 8.15 Per-mode pipeline
# Order per mode: (1) TreeSHAP on every cell × frame (additivity-checked), group sums; (2) K-means zones and
# `ASSIGN_ZONES`; (3) grouped interactions; (4) dependence curves and point thresholds; (5) recommendation planning
# with the final model; (6) block bootstrap (replicates cached individually); (7) intervals, importance, profiles,
# transitions and recommendations. The whole mode payload is stage-cached on the final booster, `DF` and the bootstrap
# settings.

# %%
_S08_LEVERS_RULES = {"frac_built": ("decrease",), "frac_barren": ("decrease",), "frac_forest": ("increase",),
                     "frac_water": ("increase",), "frac_cropland": ("increase", "decrease"), "ndvi": ("increase",),
                     "lm_ed": ("increase", "decrease"), "lm_pd": ("increase", "decrease"),
                     "lm_contag": ("increase", "decrease")}
_S08_REC_MAX_STEP = {**{f: 0.20 for f in _S08_FRACTIONS}, "ndvi": 0.15}
_S08_REC_MIN_COOLING_C = 0.05
_S08_REC_EFFICIENCY = 0.90
_S08_REC_WATER_ZONE = 0.15
_S08_REC_MAX_PER_ZONE = 4
_S08_MIN_DRIVER_C = 0.01
# Levers = primary features of the actionable groups (SPEC §4.4).
_S08_LEVERS = [(g, GROUP_META[g]["primary"]) for g in _S08_GROUPS if GROUP_META[g]["actionable"]]
_s08_unknown = [f for _, f in _S08_LEVERS if f not in _S08_LEVERS_RULES]
if _s08_unknown:
    log(f"08: actionable primaries without an intervention rule are not recommended: {_s08_unknown}", "WARNING")
log("08: recommendation levers: " + ", ".join(f"{g}->{f}" for g, f in _S08_LEVERS))


def _s08_shap_pass(mode, booster):
    """Margins for every DF row, TreeSHAP for valid rows -> group SHAP; additivity checked (raises)."""
    rows = np.flatnonzero(_S08_ROW_VALID)
    try:
        margin = _s08_predict_all(booster, _S08_X, device=_S08_DEVICE, kind="margin").astype(np.float64)
        contribs = _s08_predict_all(booster, _S08_X[rows], device=_S08_DEVICE, kind="contribs")
    finally:
        booster.set_param({"device": "cpu"})
    phi = contribs[:, :_S08_K].astype(np.float64)
    bias = contribs[:, _S08_K].astype(np.float64)
    del contribs
    base = float(np.median(bias)) if bias.size else 0.0
    if bias.size and float(np.ptp(bias)) > 1e-4:
        log(f"08 {mode}: SHAP bias column varies by {np.ptp(bias):.2e} across rows (expected constant)", "WARNING")
    feat_err = float(np.max(np.abs(phi.sum(axis=1) + bias - margin[rows]))) if rows.size else 0.0
    group = phi @ _S08_MEMBER
    group_err = float(np.max(np.abs(group.sum(axis=1) + base - margin[rows]))) if rows.size else 0.0
    if not (feat_err < 1e-3 and group_err < 1e-3):
        raise RuntimeError(f"08 {mode}: TreeSHAP additivity violated (feature {feat_err:.2e}, group {group_err:.2e})")
    full = np.full((len(DF), _S08_NG), np.nan, dtype=np.float32)
    full[rows] = group.astype(np.float32)
    feat_mean_abs = {}
    for y in _S08_FRAMES:
        sel = _S08_YEAR[rows] == y
        feat_mean_abs[y] = np.abs(phi[sel]).mean(axis=0) if sel.any() else np.full(_S08_K, np.nan)
    fit = np.isin(_S08_YEAR[rows], _s08_fit_frames(mode))
    feat_global = np.abs(phi[fit]).mean(axis=0) if fit.any() else np.full(_S08_K, np.nan)
    crosscheck = _s08_crosscheck_shap_package(booster, rows, phi)
    del phi, group
    return {"margin": margin.astype(np.float32), "group": full, "base": base, "additivity_feature": feat_err,
            "additivity_group": group_err, "feature_mean_abs": feat_global, "feature_mean_abs_by_frame": feat_mean_abs,
            "crosscheck_max_diff": crosscheck, "n_rows": int(rows.size)}


def _s08_crosscheck_shap_package(booster, rows, phi, n_rows=300):
    """Compare XGBoost's native TreeSHAP with shap.TreeExplainer on a few rows (warn-only; None if unavailable)."""
    try:
        import shap
    except ImportError:
        log("08: shap package not installed; skipping the TreeExplainer cross-check")
        return None
    if rows.size == 0:
        return None
    pick = np.random.default_rng(CFG.SEED).choice(rows.size, size=min(n_rows, rows.size), replace=False)
    try:
        booster.set_param({"device": "cpu"})
        with _s08_warnings.catch_warnings():
            _s08_warnings.simplefilter("ignore")
            explainer = shap.TreeExplainer(booster)
            ref = np.asarray(explainer.shap_values(_S08_X[rows[pick]]), dtype=np.float64)
    except Exception as exc:  # noqa: BLE001 - shap/xgboost version skew must not break the pipeline
        log(f"08: shap.TreeExplainer cross-check skipped: {type(exc).__name__}: {str(exc)[:160]}", "WARNING")
        return None
    diff = float(np.max(np.abs(ref - phi[pick])))
    level = "WARNING" if diff > 1e-3 else "INFO"
    log(f"08: shap.TreeExplainer vs XGBoost TreeSHAP on {pick.size} rows: max |diff| {diff:.2e}", level)
    return diff


def _s08_zone_fit(mode, group_full, fit_rows):
    """K-means (K = 4, 20 inits) on a seeded sample of the fit rows, v2 labelling, diagnostics K = 2..8."""
    rng = np.random.default_rng(CFG.SEED + 31)
    Xg = group_full[fit_rows].astype(np.float64)
    fit_pick = (np.sort(rng.choice(fit_rows.size, size=_S08_KMEANS_FIT_ROWS, replace=False))
                if fit_rows.size > _S08_KMEANS_FIT_ROWS else np.arange(fit_rows.size))
    _, inertia, centers = _s08_kmeans(Xg[fit_pick], _S08_N_ZONES, n_init=20, seed=CFG.SEED)
    raw = _s08_nearest_centroid(Xg, centers)
    frac_water = _S08_X[fit_rows, FEATURES.index("frac_water")].astype(np.float64)
    lut, labelling = _s08_label_clusters(raw, Xg, frac_water)
    order = np.argsort(lut)                       # raw cluster of canonical zone 0..3
    centroids = centers[order]
    zones_fit = lut[raw]
    sil_pick = (np.sort(rng.choice(fit_rows.size, size=_S08_SIL_ROWS, replace=False))
                if fit_rows.size > _S08_SIL_ROWS else np.arange(fit_rows.size))
    silhouette = _s08_silhouette(Xg[sil_pick], zones_fit[sil_pick])
    diag_pick = (np.sort(rng.choice(fit_rows.size, size=_S08_DIAG_ROWS, replace=False))
                 if fit_rows.size > _S08_DIAG_ROWS else np.arange(fit_rows.size))
    diag_sil = diag_pick[:min(diag_pick.size, _S08_SIL_ROWS)]
    diagnostics = {"k": [], "inertia": [], "silhouette": [], "n_init": 10, "n_rows": int(diag_pick.size)}
    Xd = Xg[diag_pick]
    sil_pos = np.searchsorted(diag_pick, diag_sil)
    for k in range(2, 9):
        lab_k, in_k, _ = _s08_kmeans(Xd, k, n_init=10, seed=CFG.SEED)
        diagnostics["k"].append(k)
        diagnostics["inertia"].append(in_k)
        diagnostics["silhouette"].append(_s08_silhouette(Xd[sil_pos], lab_k[sil_pos]))
    best_k = int(diagnostics["k"][int(np.nanargmax(diagnostics["silhouette"]))])
    log(f"08 {mode}: zones fitted on {fit_pick.size:,} of {fit_rows.size:,} rows (inertia {inertia:,.1f}, "
        f"silhouette {silhouette:.3f}); diagnostics silhouette peaks at K={best_k} (K = 4 is the contract)")
    return {"centroids": centroids.astype(np.float32), "labelling": labelling, "k": _S08_N_ZONES,
            "silhouette": silhouette, "inertia": inertia, "diagnostics": diagnostics,
            "groups": list(_S08_GROUPS), "n_fit_rows": int(fit_pick.size), "n_rows": int(fit_rows.size),
            "space": "grouped SHAP (°C), 18 groups in SHAP_GROUPS order", "centroid_order": "canonical zone id",
            "nodata": _S08_ZONE_NODATA}


def _s08_interaction_pass(mode, booster, zones_full):
    """Grouped SHAP interactions (18 x 18 mean |Phi_gh|) globally and per zone from sampled rows of every frame."""
    rng = np.random.default_rng(CFG.SEED + 7)
    batch = max(64, int(CFG.SHAP_BATCH) // 16) if _S08_ON_GPU else 256
    sum_all = np.zeros((_S08_NG, _S08_NG))
    sum_zone = np.zeros((_S08_N_ZONES, _S08_NG, _S08_NG))
    n_zone = np.zeros(_S08_N_ZONES, dtype=np.int64)
    n_total, worst = 0, 0.0
    M = _S08_MEMBER
    group_ref = _S08_STATE[mode]["group"]
    fallback_frames = []
    try:
        for year in _S08_FRAMES:
            rows = np.flatnonzero((_S08_YEAR == year) & _S08_ROW_VALID)
            if rows.size > _S08_INTER_ROWS:
                rows = np.sort(rng.choice(rows, size=_S08_INTER_ROWS, replace=False))
            state = {"cpu_fallback": False}
            for start, stop, inter in _s08_iter_predict(booster, _S08_X[rows], device=_S08_DEVICE, batch=batch,
                                                         kind="interactions", state=state):
                r = rows[start:stop]
                phi = inter[:, :_S08_K, :_S08_K].astype(np.float64)
                # rows of the full matrix (incl. the bias column) sum back to the SHAP values
                recon = inter[:, :_S08_K, :].sum(axis=2, dtype=np.float64) @ M
                worst = max(worst, float(np.nanmax(np.abs(recon - group_ref[r]))))
                G = np.matmul(M.T[None, :, :], np.matmul(phi, M))            # (b, 18, 18)
                mag = np.abs(G)
                sum_all += mag.sum(axis=0)
                zb = zones_full[r]
                for z in range(_S08_N_ZONES):
                    sel = zb == z
                    if sel.any():
                        sum_zone[z] += mag[sel].sum(axis=0)
                        n_zone[z] += int(sel.sum())
                n_total += r.size
                del inter, phi, G, mag
                if state["cpu_fallback"] and stop < rows.size:
                    fallback_frames.append(int(year))
                    log(f"08 {mode}: interactions {year} fell back to the CPU; remaining rows of the frame skipped",
                        "WARNING")
                    break
            booster.set_param({"device": _S08_DEVICE})
    finally:
        booster.set_param({"device": "cpu"})
    if worst > 1e-2:
        log(f"08 {mode}: group interaction rows deviate from group SHAP by up to {worst:.3e}", "WARNING")
    glob = sum_all / max(n_total, 1)
    by_zone = {z: (sum_zone[z] / n_zone[z] if n_zone[z] else np.zeros((_S08_NG, _S08_NG))) for z in range(4)}
    return {"groups": list(_S08_GROUPS), "global": glob, "by_zone": by_zone, "n_rows": int(n_total),
            "rows_per_frame": int(_S08_INTER_ROWS), "max_consistency_error": worst,
            "cpu_fallback_frames": fallback_frames,
            "definition": "mean |sum of member-pair SHAP interaction values| (diagonal = within-group effect)"}


def _s08_point_thresholds(x, s, edges):
    centers, mean, counts = _s08_binned_curve(x, s, edges)
    bp, slope_before, slope_after = _s08_hinge_breakpoint(centers, mean, counts)
    return {"zero_crossing": _s08_zero_crossing(centers, mean),
            "zero_crossing_multiple": _s08_zero_crossing_is_multiple(centers, mean),
            "breakpoint": bp, "slope_before": slope_before, "slope_after": slope_after,
            "saturation": _s08_saturation_point(centers, mean),
            "direction": _s08_effect_direction(x, s), "slope": _s08_curve_slope(centers, mean, counts),
            "curve": (centers, mean, counts)}


def _s08_plan_zone(mode, zone, booster, base_margin_now, thresholds):
    """Candidate actions of one zone evaluated with the final model (focal recompute); best first, ≤ 4."""
    zones_now = _S08_STATE[mode]["zones_obs"][_S08_NOW]
    cells = np.flatnonzero(zones_now == zone)
    if cells.size < 10:
        log(f"08 {mode}: zone {zone} has {cells.size} cells in {_S08_NOW}; no recommendations", "WARNING")
        return []
    Xz = _S08_X[_s08_frame_slice(_S08_NOW)][cells]
    jw = FEATURES.index("frac_water")
    with _s08_warnings.catch_warnings():
        _s08_warnings.simplefilter("ignore", RuntimeWarning)
        water_median = float(np.nanmedian(Xz[:, jw])) if np.isfinite(Xz[:, jw]).any() else 0.0
    plans = []
    for group, feature in _S08_LEVERS:
        if feature not in _S08_LEVERS_RULES:
            continue
        if feature == "ndvi" and water_median > _S08_REC_WATER_ZONE:
            continue
        j = FEATURES.index(feature)
        vals = Xz[:, j][np.isfinite(Xz[:, j])].astype(np.float64)
        if vals.size < 10:
            continue
        current = float(np.median(vals))
        p10, p90 = (float(v) for v in np.percentile(vals, [10, 90]))
        fstat = FEATURE_STATS[feature]
        spread = float(fstat["p99"]) - float(fstat["p01"])
        min_step = max(1e-6, 0.01 * spread) if np.isfinite(spread) and spread > 0 else 1e-3
        lo_phys, hi_phys = _S08_BOUNDS.get(feature, (-np.inf, np.inf))
        cap = _S08_REC_MAX_STEP.get(feature, np.inf)
        th = thresholds[group]
        best_plan = None
        for direction in _S08_LEVERS_RULES[feature]:
            if direction == "increase":
                bound = min(p90, current + cap, hi_phys)
                if bound - current < min_step:
                    continue
                lo_t, hi_t = current + min_step, bound
            else:
                bound = max(p10, current - cap, lo_phys)
                if current - bound < min_step:
                    continue
                lo_t, hi_t = bound, current - min_step
            cands = [(current + (bound - current) * q, "partial") for q in (0.25, 0.5, 0.75)] + [(bound, "bound")]
            cands += [(float(th[k]), k) for k in ("breakpoint", "saturation")
                      if th[k] is not None and lo_t <= float(th[k]) <= hi_t]
            results = []
            for target, kind in cands:
                cf = _s08_counterfactual(_S08_NOW, cells, feature, target - current)
                if cf["zone_ok"].size == 0:
                    continue
                zd, sd, ns = _s08_cf_effect(booster, "cpu", _S08_NOW, cf, base_margin=base_margin_now)
                results.append({"target": float(target), "kind": kind, "delta": zd, "spill_delta": sd,
                                "spill_n": ns, "n_cells": int(cf["zone_ok"].size), "donors": cf["donors"],
                                "mean_applied": float(np.mean(cf["applied"])) if cf["applied"].size else 0.0})
            if not results:
                continue
            best = min(r["delta"] for r in results)
            if not best < -_S08_REC_MIN_COOLING_C:
                continue
            good = [r for r in results if r["delta"] <= _S08_REC_EFFICIENCY * best]
            chosen = min(good, key=lambda r: (abs(r["target"] - current),
                                              r["kind"] not in ("saturation", "breakpoint")))
            plan = {"mode": mode, "zone": int(zone), "group": group, "feature": feature, "action": direction,
                    "current": current, "target": chosen["target"], "step": chosen["target"] - current,
                    "kind": chosen["kind"], "expected_delta_c": chosen["delta"], "best_delta_c": best,
                    "n_cells": chosen["n_cells"], "donors": chosen["donors"], "p10": p10, "p90": p90,
                    "bound": bound, "cap": (None if not np.isfinite(cap) else cap),
                    "spill_delta_c": chosen["spill_delta"], "spill_n_cells": chosen["spill_n"],
                    "mean_applied": chosen["mean_applied"], "cells": cells, "year": _S08_NOW}
            if best_plan is None or plan["expected_delta_c"] < best_plan["expected_delta_c"]:
                best_plan = plan
        if best_plan is not None:
            plans.append(best_plan)
    plans.sort(key=lambda p: p["expected_delta_c"])
    return plans[:_S08_REC_MAX_PER_ZONE]


def _s08_bootstrap_replicate(job, gpu_id):
    """Train one block-bootstrap replicate and reduce it immediately (cached per replicate)."""
    mode, b = job
    st = _S08_STATE[mode]
    sc = stage_cache(f"08_boot_{mode}", {**st["boot_key"], "b": int(b)})
    if sc.hit:
        try:
            return sc.load()
        except StageCacheError as exc:
            log(f"{exc}; recomputing replicate {b}", "WARNING")
    t0 = _s08_time.time()
    device = xgb_device_for(gpu_id) if _S08_ON_GPU else "cpu"
    try:
        rng = np.random.default_rng(CFG.SEED + 1000 + 7919 * int(b) + (0 if mode == "day" else 104729))
        nb = st["n_blocks"]
        mult = np.bincount(rng.integers(0, nb, nb), minlength=nb)[st["block_codes"]].astype(np.float64)
        keep = mult > 0
        rows = st["train_rows"][keep]
        weight = (st["w"][rows].astype(np.float64) * mult[keep]).astype(np.float32)
        booster, used = _s08_train_booster(mode, _S08_X[rows], st["y"][rows], weight, st["rounds"], device,
                                           CFG.SEED + int(b) + 1)
        contribs = _s08_predict_all(booster, _S08_X[st["eval_rows"]], device=used, kind="contribs")
        group = contribs[:, :_S08_K].astype(np.float64) @ _S08_MEMBER
        del contribs
        curves = np.full((_S08_NG, st["max_bins"]), np.nan)
        thresholds = np.full((_S08_NG, 3), np.nan)
        for gi in range(_S08_NG):
            idx = st["eval_bin_idx"][gi]
            ok = idx >= 0
            nbins = len(st["edges"][gi]) - 1
            counts = st["eval_counts"][gi]
            sums = np.bincount(idx[ok], weights=group[ok, gi], minlength=nbins)
            with np.errstate(invalid="ignore", divide="ignore"):
                mean = np.where(counts > 0, sums / np.maximum(counts, 1), np.nan)
            curves[gi, :nbins] = mean
            thresholds[gi] = _s08_curve_thresholds(st["curves"][gi][0], mean, counts, zc_ref=st["zc_ref"][gi],
                                                   zc_tol=st["zc_tol"][gi])
        rec = np.array([_s08_cf_effect(booster, used, p["year"], cf)[0]
                        for p, cf in zip(st["plans"], st["plan_cf"])], dtype=np.float64)
        booster.set_param({"device": "cpu"})
        del booster
        result = {"ok": True, "b": int(b), "device": used, "mean_abs": np.abs(group).mean(axis=0),
                  "curves": curves, "thresholds": thresholds, "rec_deltas": rec,
                  "seconds": _s08_time.time() - t0, "n_rows": int(rows.size)}
        del group
        log(f"  08 {mode} bootstrap {b + 1}/{CFG.N_BOOTSTRAP} on {used}: {rows.size:,} rows, "
            f"{result['seconds']:.1f}s")
        return sc.save(result)
    except Exception as exc:  # noqa: BLE001 - one failed replicate must not lose the others
        log(f"  08 {mode} bootstrap replicate {b} failed on {device}: {type(exc).__name__}: {exc}", "WARNING")
        return {"ok": False, "b": int(b), "device": device, "error": f"{type(exc).__name__}: {exc}"}


def _s08_scatter(mode, gi, partner_gi, rng, fit_rows, max_points=1500):
    """≤ max_points fit rows with finite x, stratified across frames; colour = partner group's primary feature."""
    j = _S08_PRIMARY_IDX[gi]
    jc = _S08_PRIMARY_IDX[partner_gi]
    frames = sorted(set(_S08_YEAR[fit_rows].tolist()))
    per = max(1, max_points // max(len(frames), 1))
    picks = []
    for year in frames:
        rows = fit_rows[(_S08_YEAR[fit_rows] == year) & np.isfinite(_S08_X[fit_rows, j])]
        if rows.size:
            picks.append(rng.choice(rows, size=min(per, rows.size), replace=False))
    rows = np.sort(np.concatenate(picks)) if picks else np.zeros(0, np.int64)
    st = _S08_STATE[mode]
    return {"x": _S08_X[rows, j].astype(np.float64), "shap": st["group"][rows, gi].astype(np.float64),
            "color": _S08_X[rows, jc].astype(np.float64), "color_feature": FEATURES[jc],
            "color_group": _S08_GROUPS[partner_gi], "zone": st["zones_full"][rows].astype(np.int64),
            "year": _S08_YEAR[rows].astype(np.int64)}


def _s08_build_threshold(gi, pt, boot_thr):
    out = {"primary": _S08_PRIMARY[gi]}
    centers, mean, counts = pt["curve"]
    finite_mean = mean[np.isfinite(mean)]
    for col, key in enumerate(("zero_crossing", "breakpoint", "saturation")):
        values = boot_thr[:, gi, col] if boot_thr.size else np.zeros(0)
        ci, support = _s08_boot_ci(values, pt[key])
        out[key] = pt[key]
        out[f"{key}_ci"] = ci
        out[f"{key}_support"] = support
    out["zero_crossing_flag"] = ("multiple" if pt["zero_crossing_multiple"] and pt["zero_crossing"] is None
                                 else None)
    out["slope_before"] = pt["slope_before"]
    out["slope_after"] = pt["slope_after"]
    out["slope"] = pt["slope"]
    out["effect_range"] = float(np.ptp(finite_mean)) if finite_mean.size else None
    out["direction"] = pt["direction"]
    order = ["primary", "zero_crossing", "zero_crossing_ci", "zero_crossing_support", "zero_crossing_flag",
             "breakpoint", "breakpoint_ci", "breakpoint_support", "slope_before", "slope_after", "saturation",
             "saturation_ci", "saturation_support", "effect_range", "direction", "slope"]
    return {k: out[k] for k in order}


def _s08_top_pairs(matrix, n=3):
    iu = np.triu_indices(_S08_NG, k=1)
    vals = np.asarray(matrix)[iu]
    order = np.argsort(vals)[::-1][:n]
    return [{"a": _S08_GROUPS[iu[0][o]], "b": _S08_GROUPS[iu[1][o]], "value": float(vals[o])} for o in order]


def _s08_top_districts(cells, n=5):
    d = np.asarray(DISTRICT_IDX)[CELL_ROWS[cells], CELL_COLS[cells]].astype(np.int64)
    total = max(int(cells.size), 1)
    ids, counts = np.unique(d[d >= 0], return_counts=True)
    order = np.argsort(counts)[::-1][:n]
    return [{"district": int(ids[o]), "name": _S08_DISTRICT_NAMES.get(int(ids[o]), str(ids[o])),
             "share": float(counts[o] / total)} for o in order]


def _s08_zone_profiles(mode, recs):
    """ZONE_PROFILES[m] (v1 keys; area/lst keyed {"obs": {year: v}}; lst_mean filled by section 09)."""
    st = _S08_STATE[mode]
    zones_full = st["zones_full"]
    fit_rows = st["fit_rows"]
    anom = DF[f"anom_{mode}"].to_numpy(np.float64)
    margin = st["margin"].astype(np.float64)
    profiles = []
    now_sl = _s08_frame_slice(_S08_NOW)
    labelling = (ZONE_MODEL.get(mode) or {}).get("labelling") or {}
    met = bool(labelling.get("riparian_criterion_met", True))
    for meta in _S08_ZONE_META:
        z = meta["id"]
        display, caveat = meta["name"], None
        if z == 1 and not met:
            fw1 = next((c["mean_frac_water"] for c in labelling.get("clusters", []) if c["zone"] == 1), float("nan"))
            display = _S08_NO_RIPARIAN_NAME
            caveat = ("Named Riparian Buffer by the SPEC zone rule, but no cluster shows a riparian signature (mean "
                      f"water {100 * fw1:.1f} %); this is the middle-heat cluster of the three non-core zones.")
        n_cells, area, pred_mean, obs_mean = {}, {}, {}, {}
        for year in _S08_FRAMES:
            sl = _s08_frame_slice(year)
            mz = zones_full[sl] == z
            n = int(mz.sum())
            n_cells[str(year)] = n
            area[str(year)] = n * _S08_RES_KM2
            pred_mean[str(year)] = float(margin[sl][mz].mean()) if n else None
            ov = anom[sl][mz]
            obs_mean[str(year)] = float(np.nanmean(ov)) if n and np.isfinite(ov).any() else None
        mask_fit = zones_full[fit_rows] == z
        shap_means = (st["group"][fit_rows[mask_fit]].astype(np.float64).mean(axis=0) if mask_fit.any()
                      else np.zeros(_S08_NG))
        now_cells = np.flatnonzero(zones_full[now_sl] == z)
        with _s08_warnings.catch_warnings():
            _s08_warnings.simplefilter("ignore", RuntimeWarning)
            fmeans = (np.nanmean(_S08_X[now_sl][now_cells].astype(np.float64), axis=0) if now_cells.size
                      else np.full(_S08_K, np.nan))
        order = np.argsort(shap_means)
        profile = {
            "id": z, "name": meta["name"], "display_name": display, "label_caveat": caveat,
            "color": meta["color"], "mode": mode, "description": "",
            "n_cells": n_cells, "area_km2": {"obs": area}, "lst_mean": {"obs": {}}, "lst_pred_mean": {"obs": {}},
            "anom_pred_mean": {"obs": pred_mean}, "anom_obs_mean": {"obs": obs_mean},
            "feature_means": {f: float(fmeans[FEATURES.index(f)]) for f in BASE_FEATURES},
            "feature_means_frame": _S08_NOW,
            "shap_means": {g: float(shap_means[i]) for i, g in enumerate(_S08_GROUPS)},
            "top_warming": [{"group": _S08_GROUPS[i], "feature": _S08_PRIMARY[i], "shap": float(shap_means[i])}
                            for i in order[::-1][:3] if shap_means[i] >= _S08_MIN_DRIVER_C],
            "top_cooling": [{"group": _S08_GROUPS[i], "feature": _S08_PRIMARY[i], "shap": float(shap_means[i])}
                            for i in order[:3] if shap_means[i] <= -_S08_MIN_DRIVER_C],
            "top_interactions": _s08_top_pairs(st["interactions"]["by_zone"][z]),
            "top_districts": _s08_top_districts(now_cells),
            "recommendations": recs.get(z, []),
        }
        share = n_cells[str(_S08_NOW)] / max(_S08_NC, 1)
        lab = lambda g: GROUP_META[g]["label"]  # noqa: E731
        warm = ", ".join(f"{lab(t['group'])} ({t['shap']:+.2f} °C)" for t in profile["top_warming"]) or "none"
        cool = ", ".join(f"{lab(t['group'])} ({t['shap']:+.2f} °C)" for t in profile["top_cooling"]) or "none"
        dist = ", ".join(f"{t['name']} ({100 * t['share']:.0f}%)" for t in profile["top_districts"][:3]) or "n/a"
        am = obs_mean[str(_S08_NOW)]
        anom_txt = f"mean observed {mode} anomaly {am:+.2f} °C" if am is not None else f"no observed {mode} target"
        lead = f"{display} ({mode}): " + (f"{caveat} " if caveat else "")
        profile["description"] = (f"{lead}{area[str(_S08_NOW)]:,.0f} km² in {_S08_NOW} "
                                  f"({100 * share:.0f}% of the study area), {anom_txt}. Main warming drivers: {warm}. "
                                  f"Main cooling drivers: {cool}. Largest shares in {dist}.")
        profiles.append(profile)
    return profiles


def _s08_transitions(mode):
    """{"obs": {"y0->y1": 4x4}} between consecutive XAI frames (cells zoned in both; rows = earlier zone)."""
    zones_full = _S08_STATE[mode]["zones_full"]
    out = {}
    for y0, y1 in zip(_S08_FRAMES[:-1], _S08_FRAMES[1:]):
        a = zones_full[_s08_frame_slice(y0)].astype(np.int64)
        b = zones_full[_s08_frame_slice(y1)].astype(np.int64)
        ok = (a < _S08_N_ZONES) & (b < _S08_N_ZONES)
        counts = np.bincount(a[ok] * _S08_N_ZONES + b[ok], minlength=_S08_N_ZONES ** 2)
        out[f"{y0}->{y1}"] = counts.reshape(_S08_N_ZONES, _S08_N_ZONES).astype(int).tolist()
    return {"obs": out}


_S08_STATE = {}


def _s08_run_mode(mode, booster_hash):
    """Full explanation pipeline of one mode -> payload dict (stage-cacheable: numpy / plain Python only)."""
    booster = FINAL_MODELS[mode]
    st = {"mode": mode, "booster_hash": booster_hash}
    _S08_STATE[mode] = st
    fit_frames = _s08_fit_frames(mode)
    w = DF[f"w_{mode}"].to_numpy(np.float32)
    y = DF[f"anom_{mode}"].to_numpy(np.float32)
    st.update({"w": w, "y": y, "fit_frames": fit_frames})
    rounds = int(booster.num_boosted_rounds())

    # ---- (1) TreeSHAP ----------------------------------------------------------------------------------------
    with timer(f"08_{mode}_treeshap"):
        shp = _s08_shap_pass(mode, booster)
    st.update({"margin": shp["margin"], "group": shp["group"]})
    log(f"08 {mode}: TreeSHAP on {shp['n_rows']:,} rows, base {shp['base']:+.4f} °C, additivity max error "
        f"feature {shp['additivity_feature']:.2e} / group {shp['additivity_group']:.2e}")
    fit_rows = np.flatnonzero(np.isin(_S08_YEAR, fit_frames) & _S08_ROW_VALID)
    st["fit_rows"] = fit_rows

    # ---- (2) zones ----------------------------------------------------------------------------------------------
    with timer(f"08_{mode}_zones"):
        zm = _s08_zone_fit(mode, shp["group"], fit_rows)
        ZONE_MODEL[mode] = zm
        zones_full = ASSIGN_ZONES(mode, shp["group"])
    st["zones_full"] = zones_full
    st["zones_obs"] = {yr: zones_full[_s08_frame_slice(yr)] for yr in _S08_FRAMES}

    # ---- (3) interactions ---------------------------------------------------------------------------------------
    with timer(f"08_{mode}_interactions"):
        inter = _s08_interaction_pass(mode, booster, zones_full)
    st["interactions"] = inter
    partner = inter["global"].copy()
    np.fill_diagonal(partner, -np.inf)

    # ---- (4) dependence curves and point thresholds --------------------------------------------------------------
    edges, curves, points = [], [], []
    for gi in range(_S08_NG):
        x = _S08_X[fit_rows, _S08_PRIMARY_IDX[gi]]
        s = shp["group"][fit_rows, gi]
        e = _s08_quantile_edges(x, CFG.DEP_BINS)
        pt = _s08_point_thresholds(x, s, e)
        edges.append(e)
        curves.append(pt["curve"])
        points.append(pt)
    thresholds_point = {g: points[gi] for gi, g in enumerate(_S08_GROUPS)}
    st.update({"edges": edges, "curves": curves, "max_bins": max(len(e) - 1 for e in edges),
               "zc_ref": [np.nan if p["zero_crossing"] is None else float(p["zero_crossing"]) for p in points],
               "zc_tol": [_s08_zc_tolerance(_S08_X[fit_rows, _S08_PRIMARY_IDX[gi]], edges[gi])
                          for gi in range(_S08_NG)]})

    # ---- (5) recommendation planning with the final model --------------------------------------------------------
    with timer(f"08_{mode}_recommendation_planning"):
        base_now = st["margin"][_s08_frame_slice(_S08_NOW)].astype(np.float64)
        booster.set_param({"device": "cpu"})
        plans = [p for meta in _S08_ZONE_META for p in _s08_plan_zone(mode, meta["id"], booster, base_now,
                                                                      thresholds_point)]
        plan_cf = [_s08_counterfactual(p["year"], p["cells"], p["feature"], p["step"]) for p in plans]
        for p, cf in zip(plans, plan_cf):
            zd, sd, ns = _s08_cf_effect(booster, "cpu", p["year"], cf)
            if abs(zd - p["expected_delta_c"]) > 1e-4:
                log(f"08 {mode}: replayed delta of {p['zone']}/{p['feature']} {zd:.5f} != planned "
                    f"{p['expected_delta_c']:.5f}", "WARNING")
            p["expected_delta_c"], p["spill_delta_c"], p["spill_n_cells"] = zd, sd, ns
    st.update({"plans": plans, "plan_cf": plan_cf})
    log(f"08 {mode}: {len(plans)} planned action(s) over {_S08_N_ZONES} zones, "
        f"{sum(cf['pos'].size for cf in plan_cf):,} counterfactual rows per model")

    # ---- (6) block bootstrap ------------------------------------------------------------------------------------
    train_rows = np.flatnonzero(w > 0)
    codes, n_blocks, block_km, block_info = _s08_choose_blocks(mode, train_rows)
    rng = np.random.default_rng(CFG.SEED + 2024)
    eval_rows = (np.sort(rng.choice(fit_rows, size=_S08_EVAL_ROWS, replace=False))
                 if fit_rows.size > _S08_EVAL_ROWS else fit_rows.copy())
    eval_bin_idx = [_s08_bin_index(_S08_X[eval_rows, _S08_PRIMARY_IDX[gi]], edges[gi]) for gi in range(_S08_NG)]
    eval_counts = [np.bincount(ix[ix >= 0], minlength=len(edges[gi]) - 1) for gi, ix in enumerate(eval_bin_idx)]
    st.update({"train_rows": train_rows, "block_codes": codes, "n_blocks": n_blocks, "rounds": rounds,
               "eval_rows": eval_rows, "eval_bin_idx": eval_bin_idx, "eval_counts": eval_counts})
    # replicates replay the counterfactuals, which call FOCAL_RECOMPUTE of section 06 (cross-section code, D4)
    st["boot_key"] = CFG.key("XGB_PARAMS", version=_S08_VERSION, mode=mode, booster=st["booster_hash"],
                             code06=_s08_code_hash("06"),
                             df=_S08_DF_FP, rounds=rounds, blocks=_s08_hash(codes, train_rows),
                             eval=_s08_hash(eval_rows), edges=_s08_hash(*edges),
                             plans=_s08_hash([(p["zone"], p["feature"], round(p["step"], 9)) for p in plans]))
    n_boot = int(CFG.N_BOOTSTRAP)
    with timer(f"08_{mode}_bootstrap"):
        log(f"08 {mode}: block bootstrap {n_boot} replicates x {rounds} rounds, {n_blocks} blocks of "
            f"{block_km:.0f} km ({block_info['block_size_source']}), eval sample {eval_rows.size:,} rows")
        results = gpu_pool_map(_s08_bootstrap_replicate, [(mode, b) for b in range(n_boot)]) if n_boot else []
    ok = [r for r in results if r is not None and r.get("ok")]
    failed = [r for r in results if r is None or not r.get("ok")]
    if n_boot and not ok:
        raise RuntimeError(f"08 {mode}: all {n_boot} bootstrap replicates failed: "
                           f"{[r.get('error') for r in failed if r]}")
    boot_mean_abs = np.stack([r["mean_abs"] for r in ok]) if ok else np.zeros((0, _S08_NG))
    boot_curves = np.stack([r["curves"] for r in ok]) if ok else np.zeros((0, _S08_NG, st["max_bins"]))
    boot_thr = np.stack([r["thresholds"] for r in ok]) if ok else np.zeros((0, _S08_NG, 3))
    boot_rec = np.stack([r["rec_deltas"] for r in ok]) if ok else np.zeros((0, len(plans)))
    n_ok = len(ok)
    ci_label = "95% CI" if n_ok >= 50 else ("replicate range" if n_ok else "no bootstrap")
    boot_info = {
        "n": n_ok, "n_requested": n_boot, "mode": "block", "model_mode": mode, "block_size_km": float(block_km),
        "n_blocks": int(n_blocks), "rounds": rounds, **block_info, "ci_level": 0.95,
        "ci_method": "recentred-percentile",
        "ci_method_description": ("bias-corrected percentile interval: the 2.5/97.5 replicate percentiles shifted by "
                                  "(full-data estimate - replicate median); always contains the estimate"),
        "ci_label": ci_label, "replicate_range": bool(n_ok < 50), "eval_rows": int(eval_rows.size),
        "full_data": False, "rows_sampled": True, "devices": sorted({r["device"] for r in ok}),
        "mean_seconds": float(np.mean([r["seconds"] for r in ok])) if ok else None,
        "failures": [{"b": r.get("b"), "error": r.get("error")} for r in failed if r],
    }

    # ---- (7) importance, dependence, thresholds -----------------------------------------------------------------
    group = shp["group"]
    imp_full = np.abs(group[fit_rows].astype(np.float64)).mean(axis=0)
    imp_ref = np.abs(group[eval_rows].astype(np.float64)).mean(axis=0)
    imp_lo, imp_hi, _ = _s08_recentred_interval(imp_full, boot_mean_abs, lower=0.0)
    with _s08_warnings.catch_warnings():
        _s08_warnings.simplefilter("ignore", RuntimeWarning)
        imp_bias = (np.nanmedian(boot_mean_abs, axis=0) - imp_ref) if n_ok else np.full(_S08_NG, np.nan)
    by_frame = {}
    for yr in _S08_FRAMES:
        sl = _s08_frame_slice(yr)
        gv = group[sl].astype(np.float64)
        okr = np.isfinite(gv).all(axis=1)
        by_frame[yr] = {"mean_abs": np.abs(gv[okr]).mean(axis=0) if okr.any() else np.full(_S08_NG, np.nan),
                        "mean": gv[okr].mean(axis=0) if okr.any() else np.full(_S08_NG, np.nan),
                        "n": int(okr.sum())}
    by_zone = {}
    for z in range(_S08_N_ZONES):
        sel = fit_rows[zones_full[fit_rows] == z]
        gv = group[sel].astype(np.float64)
        by_zone[z] = {"mean_abs": np.abs(gv).mean(axis=0) if sel.size else np.full(_S08_NG, np.nan),
                      "mean": gv.mean(axis=0) if sel.size else np.full(_S08_NG, np.nan), "n": int(sel.size)}
    importance = {"groups": list(_S08_GROUPS),
                  "global": {"mean_abs": imp_full, "ci_lo": imp_lo, "ci_hi": imp_hi, "bias": imp_bias},
                  "by_frame": by_frame, "by_zone": by_zone, "order": [int(i) for i in np.argsort(imp_full)[::-1]],
                  "features": {"names": list(FEATURES), "mean_abs": shp["feature_mean_abs"],
                               "by_frame": shp["feature_mean_abs_by_frame"]},
                  "fit_frames": list(fit_frames), "n_bootstrap": n_ok, "ci_method": "recentred-percentile",
                  "ci_label": ci_label}
    dep_rng = np.random.default_rng(CFG.SEED + 11)
    dependence, thresholds = {}, {}
    for gi, g in enumerate(_S08_GROUPS):
        centers, mean, counts = curves[gi]
        nbins = len(centers)
        lo, hi, _ = _s08_recentred_interval(mean, boot_curves[:, gi, :nbins] if n_ok else np.zeros((0, nbins)))
        thresholds[g] = _s08_build_threshold(gi, points[gi], boot_thr)
        dependence[g] = {"primary": _S08_PRIMARY[gi], "bin_centers": centers, "mean": mean, "ci_lo": lo,
                         "ci_hi": hi, "count": counts.astype(np.int64),
                         "scatter": _s08_scatter(mode, gi, int(np.argmax(partner[gi])), dep_rng, fit_rows),
                         "threshold": thresholds[g]}
    bad = [g for g, t in thresholds.items() for k in ("zero_crossing", "breakpoint", "saturation")
           if t[k] is None and t[f"{k}_ci"] is not None]
    if bad:
        raise AssertionError(f"08 {mode}: threshold interval without a point estimate: {bad}")

    # ---- recommendations with bootstrap intervals --------------------------------------------------------------
    recs = {m_["id"]: [] for m_ in _S08_ZONE_META}
    for i, plan in enumerate(plans):
        delta = float(plan["expected_delta_c"])
        if not delta < -_S08_REC_MIN_COOLING_C:
            continue
        boot = boot_rec[:, i] if boot_rec.size else np.zeros(0)
        ci, bias = None, None
        if np.isfinite(boot).sum() >= 2:
            lo, hi, bb = _s08_recentred_interval(np.array([delta]), boot[:, None])
            ci, bias = [float(lo[0]), float(hi[0])], float(bb[0])
        recs[plan["zone"]].append({
            "feature": plan["feature"], "group": plan["group"], "action": plan["action"],
            "current": plan["current"], "target": plan["target"], "expected_delta_c": delta, "ci": ci,
            "priority": "high" if round(delta, 2) <= -1.0 else ("medium" if round(delta, 2) <= -0.3 else "low"),
            "rationale": _s08_rationale(plan, ci, ci_label),
            "kind": plan["kind"], "step": plan["step"], "n_cells": plan["n_cells"], "coupled": True,
            "bias": bias, "focal_recomputed": True, "distances_fixed": True, "frame": plan["year"],
            "bounds": {"p10": plan["p10"], "p90": plan["p90"], "bound": plan["bound"], "max_step": plan["cap"]},
            "spillover": {"n_cells": plan["spill_n_cells"], "mean_delta_c": plan["spill_delta_c"]},
            "mean_applied_step": plan["mean_applied"], "best_delta_c": plan["best_delta_c"],
        })
    recs = {z: sorted(v, key=lambda r: r["expected_delta_c"])[:_S08_REC_MAX_PER_ZONE] for z, v in recs.items()}

    profiles = _s08_zone_profiles(mode, recs)
    transitions = _s08_transitions(mode)
    nan_rows = ~np.isfinite(group).all(axis=1)
    payload = {
        "shap_base": shp["base"],
        "shap_group_values": {yr: group[_s08_frame_slice(yr)].copy() for yr in _S08_FRAMES},
        "pred_anom": {yr: shp["margin"][_s08_frame_slice(yr)].copy() for yr in _S08_FRAMES},
        "importance": importance, "interactions": inter, "dependence": {"groups": dependence},
        "thresholds": thresholds, "bootstrap_info": boot_info, "zone_model": zm,
        "zones_obs": {yr: zones_full[_s08_frame_slice(yr)].copy() for yr in _S08_FRAMES},
        "zone_profiles": profiles, "zone_transitions": transitions, "recommendations": recs,
        "diagnostics": {"additivity_feature": shp["additivity_feature"], "additivity_group": shp["additivity_group"],
                        "crosscheck_max_diff": shp["crosscheck_max_diff"], "n_nan_rows": int(nan_rows.sum()),
                        "fit_frames": list(fit_frames), "n_fit_rows": int(fit_rows.size),
                        "n_plans": len(plans)},
    }
    return payload


# %% [markdown]
# ## 8.16 Run both modes
# The per-mode payload is stage-cached: its key holds the final booster's bytes, a fingerprint of `DF` and the
# block20 OOF predictions, and every setting that changes the result.

# %%
def _s08_df_fingerprint():
    cols = ["anom_day", "anom_night", "w_day", "w_night", "row", "col"]
    parts = [np.round(np.nansum(_S08_X, axis=0, dtype=np.float64), 6), int(np.isfinite(_S08_X).sum())]
    parts += [float(np.nansum(DF[c].to_numpy(np.float64))) for c in cols]
    for m in CFG.MODES:
        oof = MODEL_RESULTS.get(m, {}).get("oof", {}).get("block20", {}).get("xgboost")
        parts.append(None if oof is None else float(np.nansum(np.asarray(oof, np.float64))))
    return _s08_hash(FEATURES, len(DF), *parts)


_S08_DF_FP = _s08_df_fingerprint()
XAI_FRAMES, SHAP_BASE, SHAP_GROUP_VALUES, PRED_ANOM, OOF_ANOM = {}, {}, {}, {}, {}
IMPORTANCE, INTERACTIONS, DEPENDENCE, THRESHOLDS, BOOTSTRAP_INFO = {}, {}, {}, {}, {}
ZONE_MODEL, ZONES_OBS, ZONE_PROFILES, ZONE_TRANSITIONS, RECOMMENDATIONS = {}, {}, {}, {}, {}
WEB_MODELS = {}
_S08_PAYLOADS = {}

for _s08_mode in CFG.MODES:
    if _s08_mode not in FINAL_MODELS:
        log(f"08: no final model for mode {_s08_mode}; its explanation layer is skipped", "WARNING")
        continue
    _s08_booster_hash = _s08_hash(bytes(FINAL_MODELS[_s08_mode].save_raw("ubj")))
    _s08_key = CFG.key("N_BOOTSTRAP", "DEP_BINS", "K_ZONES", "BOOT_BLOCK_KM", "INNER_BLOCK_KM", "SEED",
                       "SHAP_INTERACTION_ROWS_PER_FRAME", "NOW", version=_S08_VERSION, mode=_s08_mode,
                       booster=_s08_booster_hash, df=_S08_DF_FP, on_gpu=_S08_ON_GPU,
                       coupling=_s08_hash(repr(SCENARIO_COUPLING["coupling"])),
                       code06=_s08_code_hash("06"))       # counterfactuals call FOCAL_RECOMPUTE (section 06)
    _s08_sc = stage_cache(f"08_explain_{_s08_mode}", _s08_key)
    with timer(f"08_{_s08_mode}"):
        _S08_PAYLOADS[_s08_mode] = _s08_sc.get_or_compute(
            lambda mode=_s08_mode, booster_hash=_s08_booster_hash: _s08_run_mode(mode, booster_hash))
    _S08_STATE.pop(_s08_mode, None)         # per-mode working arrays (SHAP matrices, plan matrices) are released
    FINAL_MODELS[_s08_mode].set_param({"device": "cpu"})
    free_memory()

# %% [markdown]
# ## 8.17 Publish the §3.5 globals
# `SHAP_GROUP_VALUES[m][year]` and `PRED_ANOM[m][year]` are (N_CELLS × 18) / (N_CELLS) float32 in canonical cell
# order; `OOF_ANOM[m][year]` is the block20 XGBoost out-of-fold anomaly (NaN where the row was not a training row of
# the mode, e.g. night 1990–2000).

# %%
for _s08_mode, _s08_p in _S08_PAYLOADS.items():
    XAI_FRAMES[_s08_mode] = list(_S08_FRAMES)
    SHAP_BASE[_s08_mode] = float(_s08_p["shap_base"])
    SHAP_GROUP_VALUES[_s08_mode] = {int(y): np.asarray(v, np.float32) for y, v in _s08_p["shap_group_values"].items()}
    PRED_ANOM[_s08_mode] = {int(y): np.asarray(v, np.float32) for y, v in _s08_p["pred_anom"].items()}
    _s08_oof = MODEL_RESULTS.get(_s08_mode, {}).get("oof", {}).get("block20", {}).get("xgboost")
    _s08_w = DF[f"w_{_s08_mode}"].to_numpy(np.float64)
    OOF_ANOM[_s08_mode] = {}
    for _y in _S08_FRAMES:
        _sl = _s08_frame_slice(_y)
        if _s08_oof is None or len(_s08_oof) != len(DF):
            OOF_ANOM[_s08_mode][_y] = np.full(_S08_NC, np.nan, np.float32)
        else:
            OOF_ANOM[_s08_mode][_y] = np.where(_s08_w[_sl] > 0, np.asarray(_s08_oof, np.float32)[_sl],
                                               np.nan).astype(np.float32)
    IMPORTANCE[_s08_mode] = _s08_p["importance"]
    INTERACTIONS[_s08_mode] = _s08_p["interactions"]
    DEPENDENCE[_s08_mode] = _s08_p["dependence"]
    THRESHOLDS[_s08_mode] = _s08_p["thresholds"]
    BOOTSTRAP_INFO[_s08_mode] = _s08_p["bootstrap_info"]
    ZONE_MODEL[_s08_mode] = _s08_p["zone_model"]
    ZONES_OBS[_s08_mode] = {int(y): np.asarray(v, np.uint8) for y, v in _s08_p["zones_obs"].items()}
    ZONE_PROFILES[_s08_mode] = _s08_p["zone_profiles"]
    ZONE_TRANSITIONS[_s08_mode] = _s08_p["zone_transitions"]
    RECOMMENDATIONS[_s08_mode] = _s08_p["recommendations"]
# Zone ids must be reproducible from the published SHAP values with the published centroids.
for _s08_mode in ZONES_OBS:
    for _y in _S08_FRAMES:
        if not np.array_equal(ASSIGN_ZONES(_s08_mode, SHAP_GROUP_VALUES[_s08_mode][_y]), ZONES_OBS[_s08_mode][_y]):
            raise AssertionError(f"08: ZONES_OBS[{_s08_mode}][{_y}] differs from ASSIGN_ZONES of its SHAP values")
for _s08_mode in IMPORTANCE:
    _imp = IMPORTANCE[_s08_mode]["global"]
    _info = BOOTSTRAP_INFO[_s08_mode]
    print(f"\n=== {_s08_mode.upper()} === SHAP base {SHAP_BASE[_s08_mode]:+.3f} °C; bootstrap {_info['n']}/"
          f"{_info['n_requested']} replicates ({_info['ci_label']}), {_info['n_blocks']} blocks of "
          f"{_info['block_size_km']:.0f} km")
    for _r, _gi in enumerate(IMPORTANCE[_s08_mode]["order"][:10], start=1):
        print(f"  {_r:2d}. {_S08_GROUPS[_gi]:<17s} mean|SHAP| {_imp['mean_abs'][_gi]:.3f} °C "
              f"[{_imp['ci_lo'][_gi]:.3f}, {_imp['ci_hi'][_gi]:.3f}] bias {_imp['bias'][_gi]:+.3f}")
    print("  zone labelling: " + ZONE_MODEL[_s08_mode]["labelling"]["rule"])
    for _c in ZONE_MODEL[_s08_mode]["labelling"]["clusters"]:
        print(f"    {_c['zone']} {_c['name']:<22s} <- cluster {_c['raw_cluster']}: n={_c['n']:,}, mean total SHAP "
              f"{_c['mean_total_shap']:+.3f}, mean frac_water {_c['mean_frac_water']:.3f}, rows with water >= 0.2 "
              f"{_c['share_water_ge_0_2']:.1%}, water |SHAP| rank {_c['water_group_rank']} [{_c['reason']}]")
    _lab = ZONE_MODEL[_s08_mode]["labelling"]
    if not _lab["riparian_criterion_met"]:
        log(f"08 {_s08_mode}: no cluster meets the riparian criterion ({_lab['riparian_criterion']}); zone 1 is shown "
            f"as '{_S08_NO_RIPARIAN_NAME}'", "WARNING")
    for _p in ZONE_PROFILES[_s08_mode]:
        print(f"  [{_p['id']}] {_p['description']}")
        for _rec in _p["recommendations"]:
            print(f"      - {_rec['priority'].upper():6s} {_rec['rationale']}")
        if not _p["recommendations"]:
            print("      - no feasible action with an expected cooling > 0.05 °C")

# %% [markdown]
# ## 8.18 Web surrogates (`WEB_MODELS[m]`, v1 compact format + focal spec)
# Format `lst-xgb-compact-v1` (SPEC_v1 §4.3): node 0 is the root; node `i` is a leaf iff `l[i] == -1` (value `v[i]`);
# otherwise go to `l[i]` if `x[f[i]] < t[i]`, to `r[i]` if `x[f[i]] >= t[i]`, and to `l[i]` if `d[i] == 1` else `r[i]`
# when the value is missing. Prediction (anomaly °C) = `base_score + Σ leaves`; absolute °C = prediction + the frame
# level (section 09). Thresholds are exact, finite float32 values (`_s08_threshold`). The surrogate is distilled
# from the final model on every valid ROI cell × frame with the same monotone constraints, then shrunk (fewer
# trees) only if the JSON exceeds 6 MB.

# %%
_S08_WEB_MAX_BYTES = 6 * 1024 * 1024
_S08_WEB_ROUNDS = 400
_S08_WEB_DEPTH = 6


def _s08_parse_base_score(raw):
    """learner_model_param.base_score is '4.1E1' (XGBoost 2.x) or '[4.1E1]' (3.x vector form)."""
    return float(str(raw).strip().strip("[]").split(",")[0].strip())


def _s08_json_list(arr):
    a = np.asarray(arr, dtype=np.float64)
    out = a.tolist()
    for i in np.flatnonzero(~np.isfinite(a)):
        out[i] = None
    return out


def _s08_json_dumps(obj):
    import json as _json

    return _json.dumps(obj, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _s08_threshold(t):
    """A split threshold as a finite float32 value (exact, as the format requires).

    XGBoost 3.4 writes -inf for a split that only separates missing values: every present value goes right (nothing
    is below -inf), missing values take the default side (3.2 used the feature's minimum there). JSON has no infinity,
    and +-FLT_MAX routes every finite float32 feature value identically.
    """
    limit = np.finfo(np.float32).max
    return float(np.clip(np.float32(t), -limit, limit))


def _s08_booster_to_compact(booster, mode, fidelity, check):
    """Convert a gbtree booster's JSON dump into the lst-xgb-compact-v1 dict (+ v2 keys mode/focal/base_features)."""
    import json as _json

    raw = _json.loads(bytes(booster.save_raw(raw_format="json")).decode("utf-8"))
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
            "t": [0 if is_leaf else _s08_threshold(t) for t, is_leaf in zip(cond, leaf)],
            "l": left, "r": right,
            "d": [0 if is_leaf else int(bool(dl)) for dl, is_leaf in zip(tree["default_left"], leaf)],
            "v": [float(f"{float(np.float32(v)):.9g}") if is_leaf else 0 for v, is_leaf in zip(cond, leaf)],
        })
    return {
        "format": "lst-xgb-compact-v1",
        "objective": str(learner.get("objective", {}).get("name", "reg:squarederror")),
        "target_mode": "anomaly", "mode": mode,
        "features": list(FEATURES), "base_features": list(BASE_FEATURES),
        "focal": {"bases": list(FOCAL_SPEC["bases"]), "windows": [int(w) for w in FOCAL_SPEC["windows"]]},
        "base_score": _s08_parse_base_score(learner["learner_model_param"]["base_score"]),
        "n_trees": len(trees), "trees": trees, "fidelity": fidelity, "check": check,
    }


def _s08_compile_compact(model):
    return [tuple(np.asarray(t[k], dtype=dt) for k, dt in
                  (("f", np.int64), ("t", np.float64), ("l", np.int64), ("r", np.int64), ("d", np.int64),
                   ("v", np.float64))) for t in model["trees"]]


def _s08_predict_compact(model, X):
    """Pure-NumPy evaluator of lst-xgb-compact-v1 (NaN/None = missing), independent of XGBoost."""
    X = np.array(X, dtype=np.float64)
    Xf = X.astype(np.float32).astype(np.float64)        # XGBoost compares float32 features with float32 thresholds
    out = np.full(X.shape[0], float(model["base_score"]), dtype=np.float64)
    for f, t, left, right, dflt, v in _s08_compile_compact(model):
        node = np.zeros(X.shape[0], dtype=np.int64)
        while True:
            active = np.flatnonzero(left[node] != -1)
            if active.size == 0:
                break
            nd = node[active]
            xv = Xf[active, f[nd]]
            go_left = np.where(np.isnan(xv), dflt[nd] == 1, xv < t[nd])
            node[active] = np.where(go_left, left[nd], right[nd])
        out += v[node]
    return out


def _s08_compact_depth(model):
    """Maximum depth (edges from the root) over the compact trees."""
    worst = 0
    for t in model["trees"]:
        depth = {0: 0}
        for i, (lc, rc) in enumerate(zip(t["l"], t["r"])):
            if lc != -1:
                depth[lc] = depth[i] + 1
                depth[rc] = depth[i] + 1
        worst = max(worst, max(depth.values()))
    return worst


def _s08_r2(y_true, y_pred):
    y_true, y_pred = np.asarray(y_true, np.float64), np.asarray(y_pred, np.float64)
    ok = np.isfinite(y_true) & np.isfinite(y_pred)
    sst = np.sum((y_true[ok] - y_true[ok].mean()) ** 2)
    return float(1.0 - np.sum((y_true[ok] - y_pred[ok]) ** 2) / sst) if sst > 0 else None


def _s08_with_nans(X, rng, frac=0.1):
    Xn = np.array(X, dtype=np.float32, copy=True)
    Xn[rng.random(Xn.shape) < frac] = np.nan
    return Xn


_S08_SPECTRAL_GAP = ["ndvi", "ndbi", "mndwi", "albedo", "ndvi_spring", "ndvi_drop"]   # a Landsat gap of the cell
_S08_WEB_GAP_SHARE = 0.15          # spectral-gap copies, share of the complete rows
_S08_WEB_RANDNAN_SHARE = 0.05      # copies with 10 % random NaNs, share of the complete rows
_S08_WEB_EVAL_ROWS = 5000          # held-out complete rows for the gap / random-NaN fidelity (never copied)


def _s08_final_margin(mode, X):
    """Final-model anomaly prediction (the distillation label) of arbitrary rows, on the CPU."""
    booster = FINAL_MODELS[mode]
    booster.set_param({"device": "cpu"})
    return np.asarray(booster.inplace_predict(np.ascontiguousarray(X, dtype=np.float32)), dtype=np.float64)


def _s08_rmse(a, b):
    a, b = np.asarray(a, np.float64), np.asarray(b, np.float64)
    ok = np.isfinite(a) & np.isfinite(b)
    return float(np.sqrt(np.mean((a[ok] - b[ok]) ** 2))) if ok.any() else None


def _s08_build_web_model(mode):
    """Distilled depth-6 surrogate of FINAL_MODELS[mode] in compact form, verified against XGBoost.

    Training rows: every ROI cell x frame (the final model predicts every row, missing values included) plus
    NaN-augmented copies of complete rows - the six per-cell Landsat features set to NaN (a spectral gap whose
    neighbourhood means survive) and 10 % random NaNs - all labelled by the final model on the masked rows, so the
    surrogate learns the final model's missing-value routes. Fidelity is reported on complete rows, actual NaN rows
    and held-out spectral-gap / random-NaN copies.
    """
    rng = np.random.default_rng(CFG.SEED + 404 + (0 if mode == "day" else 1))
    X_all = _S08_X
    final_all = np.concatenate([PRED_ANOM[mode][y] for y in _S08_FRAMES]).astype(np.float64)
    w = DF[f"w_{mode}"].to_numpy(np.float64)
    y_obs = DF[f"anom_{mode}"].to_numpy(np.float64)
    complete = np.isfinite(X_all).all(axis=1)
    comp_idx = rng.permutation(np.flatnonzero(complete))
    n_eval = min(_S08_WEB_EVAL_ROWS, comp_idx.size // 5)
    eval_idx, pool = np.sort(comp_idx[:n_eval]), comp_idx[n_eval:]
    n_gap = int(round(_S08_WEB_GAP_SHARE * comp_idx.size))
    n_rnd = int(round(_S08_WEB_RANDNAN_SHARE * comp_idx.size))
    gap_cols = [FEATURES.index(f) for f in _S08_SPECTRAL_GAP]

    def spectral_gap(rows):
        Xg = np.array(X_all[rows], dtype=np.float32, copy=True)
        Xg[:, gap_cols] = np.nan
        return Xg

    X_gap = spectral_gap(np.sort(pool[:n_gap]))
    X_rnd = _s08_with_nans(X_all[np.sort(pool[n_gap:n_gap + n_rnd])], rng)
    X_train = np.ascontiguousarray(np.concatenate([X_all, X_gap, X_rnd]), dtype=np.float32)
    y_train = np.concatenate([final_all] + [_s08_final_margin(mode, Xa) for Xa in (X_gap, X_rnd) if len(Xa)])
    del X_gap, X_rnd
    # learning rate 0.2: the label is a noise-free function of the features, and with the NaN-augmented copies the
    # 400-tree budget needs the larger step (synthetic 2 km: complete-row R2 vs final 0.998 in both modes)
    params = {"objective": "reg:squarederror", "max_depth": _S08_WEB_DEPTH, "learning_rate": 0.2,
              "subsample": 0.8, "colsample_bytree": 0.8, "min_child_weight": 5, "tree_method": "hist",
              "max_bin": 256, "seed": int(CFG.SEED), "verbosity": 0,
              "monotone_constraints": _s08_mono_string(mode)}
    full = None
    for device in dict.fromkeys([xgb_device_for(0), "cpu"]):
        try:
            dtrain = xgb.QuantileDMatrix(X_train, label=y_train.astype(np.float32), max_bin=256)
            full = xgb.train({**params, "device": device}, dtrain, num_boost_round=_S08_WEB_ROUNDS)
            del dtrain
            break
        except Exception as exc:  # noqa: BLE001
            if device == "cpu" or not is_gpu_oom_error(exc):
                raise
            log(f"08: GPU OOM training the {mode} surrogate; retrying on the CPU", "WARNING")
            free_memory()
    n_train_rows = int(X_train.shape[0])
    del X_train, y_train
    full.set_param({"device": "cpu"})
    if eval_idx.size == 0:                 # no complete row to hold out: fidelity on the gap copies is undefined
        eval_idx = np.flatnonzero(complete)[:0]
    X_eval_gap = spectral_gap(eval_idx)
    X_eval_rnd = _s08_with_nans(X_all[eval_idx], rng)
    final_gap = _s08_final_margin(mode, X_eval_gap) if eval_idx.size else np.zeros(0)
    final_rnd = _s08_final_margin(mode, X_eval_rnd) if eval_idx.size else np.zeros(0)
    test_rows = rng.choice(X_all.shape[0], size=min(max(2000, min(5000, X_all.shape[0])), X_all.shape[0]),
                           replace=False)
    X_test = _s08_with_nans(X_all[test_rows], rng)
    check_X = _s08_with_nans(X_all[rng.choice(X_all.shape[0], size=min(50, X_all.shape[0]), replace=False)], rng,
                             frac=0.15)
    n_trees = full.num_boosted_rounds()
    trn = w > 0
    nan_rows = ~complete
    while True:
        booster = full[:n_trees] if n_trees < full.num_boosted_rounds() else full
        sur_all = booster.inplace_predict(X_all).astype(np.float64)
        sur_gap = booster.inplace_predict(X_eval_gap).astype(np.float64) if eval_idx.size else np.zeros(0)
        sur_rnd = booster.inplace_predict(X_eval_rnd).astype(np.float64) if eval_idx.size else np.zeros(0)
        fidelity = {"r2_vs_final": _s08_r2(final_all, sur_all),
                    "rmse_vs_final": _s08_rmse(final_all, sur_all),
                    "r2_vs_obs": _s08_r2(y_obs[trn], sur_all[trn]) if trn.any() else None,
                    "max_depth": _S08_WEB_DEPTH, "rounds": int(n_trees), "n_rows": int(X_all.shape[0]),
                    "n_train_rows": n_train_rows,
                    "r2_vs_final_complete": _s08_r2(final_all[complete], sur_all[complete]),
                    "rmse_vs_final_complete": _s08_rmse(final_all[complete], sur_all[complete]),
                    "rmse_vs_final_nan_rows": _s08_rmse(final_all[nan_rows], sur_all[nan_rows]) if nan_rows.any()
                    else None,
                    "n_nan_rows": int(nan_rows.sum()),
                    "rmse_vs_final_spectral_gap": _s08_rmse(final_gap, sur_gap),
                    "rmse_vs_final_random_nan": _s08_rmse(final_rnd, sur_rnd),
                    "n_eval_rows": int(eval_idx.size),
                    "augmentation": {"spectral_gap_features": list(_S08_SPECTRAL_GAP), "spectral_gap_rows": n_gap,
                                     "random_nan_rows": n_rnd, "random_nan_frac": 0.1},
                    "label": ("final-model anomaly prediction (distillation on all ROI cells x frames plus "
                              "NaN-augmented copies of complete rows)"),
                    "monotone": {f: int(v) for f, v in _S08_MONOTONE.get(mode, {}).items()}}
        check = {"rows": [_s08_json_list(r) for r in check_X],
                 "expected": booster.predict(xgb.DMatrix(check_X, missing=np.nan),
                                             output_margin=True).astype(np.float64).tolist()}
        model = _s08_booster_to_compact(booster, mode, fidelity, check)
        size = len(_s08_json_dumps(model))
        if size <= _S08_WEB_MAX_BYTES or n_trees <= 20:
            break
        n_trees = max(20, int(n_trees * _S08_WEB_MAX_BYTES / size * 0.95))
        log(f"08: model_web_{mode}.json would be {size / 1e6:.1f} MB; truncating the surrogate to {n_trees} trees")
    ref = booster.predict(xgb.DMatrix(X_test, missing=np.nan), output_margin=True).astype(np.float64)
    diff = float(np.max(np.abs(_s08_predict_compact(model, X_test) - ref)))
    if not diff < 1e-3:
        raise RuntimeError(f"08: compact {mode} model evaluator disagrees with XGBoost: max |diff| = {diff:.3e}")
    check_rows = np.array([[np.nan if v is None else v for v in r] for r in check["rows"]], dtype=np.float64)
    check_diff = float(np.max(np.abs(_s08_predict_compact(model, check_rows) - np.array(check["expected"]))))
    if not check_diff < 1e-3:
        raise RuntimeError(f"08: compact {mode} model check rows disagree: max |diff| = {check_diff:.3e}")
    depth = _s08_compact_depth(model)
    if depth > _S08_WEB_DEPTH or model["n_trees"] > _S08_WEB_ROUNDS:
        raise RuntimeError(f"08: surrogate exceeds depth {_S08_WEB_DEPTH} / {_S08_WEB_ROUNDS} trees")
    model["fidelity"]["evaluator_max_abs_diff"] = diff
    model["fidelity"]["check_max_abs_diff"] = check_diff
    model["fidelity"]["bytes"] = int(size)
    fd = model["fidelity"]
    f3 = lambda v: "n/a" if v is None else f"{v:.3f}"  # noqa: E731
    log(f"08 {mode}: surrogate {model['n_trees']} trees (depth {depth}), {size / 1e6:.2f} MB; evaluator vs XGBoost "
        f"max diff {diff:.1e} on {len(X_test):,} rows with NaNs; R2 vs final {f3(fd['r2_vs_final'])} (complete "
        f"rows {f3(fd['r2_vs_final_complete'])}); RMSE vs final: all {f3(fd['rmse_vs_final'])}, NaN rows "
        f"{f3(fd['rmse_vs_final_nan_rows'])} (n={fd['n_nan_rows']:,}), spectral gap "
        f"{f3(fd['rmse_vs_final_spectral_gap'])}, 10% random NaN {f3(fd['rmse_vs_final_random_nan'])} °C; R2 vs obs "
        f"{fd['r2_vs_obs']}")
    del full, booster
    return model


for _s08_mode in _S08_PAYLOADS:
    _s08_wkey = CFG.key(version=_S08_VERSION, mode=_s08_mode, df=_S08_DF_FP, rounds=_S08_WEB_ROUNDS,
                        booster=_s08_hash(bytes(FINAL_MODELS[_s08_mode].save_raw("ubj"))))
    with timer(f"08_{_s08_mode}_web_model"):
        WEB_MODELS[_s08_mode] = stage_cache(f"08_web_{_s08_mode}", _s08_wkey).get_or_compute(
            lambda mode=_s08_mode: _s08_build_web_model(mode))
    free_memory()

# %% [markdown]
# ## 8.19 Synthetic mode: planted vs recovered
# The synthetic generator (section 02) plants every driver response in `SYNTHETIC_TRUTH["planted_thresholds"]`
# (per mode and group: kind, value, direction). The table compares them with what the grouped SHAP pipeline recovered
# from the final model: saturation points, onsets (hinge breakpoints), linear slopes of the binned group curve and the
# effect direction. Groups the generator never used should rank low, and the expected day/night sign flips (built-up,
# water) should appear (`docs/research/methods_v2.md` §5).
#
# Reading the table:
# * **`linear (local contrast)`** rows: the slope of the group SHAP on `x − x_m15` with `x_m15` as a co-regressor.
#   The 15-cell neighbourhood member of a group carries *regional context* (the model has no coordinates, so a smooth
#   focal mean also absorbs the regional gradients of other drivers); the whole-curve slope can therefore differ in
#   sign from the planted *local* per-pixel response, while the local-contrast slope isolates it. Magnitudes are
#   attenuated (shared variance with correlated groups goes to whichever group the trees split on).
# * **`kind (hinge)`**: a planted saturation that appears as a kink of the group curve because another member keeps
#   acting beyond it (day NDVI: per-pixel saturation plus park cooling via the neighbourhood NDVI).
# * **`share_above_planted`**: fraction of rows whose primary value lies above the planted threshold. A threshold
#   cannot be recovered from quantile-binned curves when few rows lie beyond it (night built-up saturation at 0.69:
#   ~0 % of cells), so `NaN` there is a support limit, not a failure.

# %%
def _s08_local_slope(mode, group, primary):
    """Local-contrast slope of a group's SHAP (°C per unit of the primary) or None.

    OLS of group SHAP on ``[1, x - x_m15, x_m15]`` pooled over the XAI frames. The 15-cell neighbourhood mean is a
    member of most groups and acts as *regional context* (with no coordinates in the model it absorbs the regional
    gradients of other drivers, e.g. the bright, dry, hot south-west for ``albedo_m15``), so the slope of the whole
    group curve can have the opposite sign of the planted *local* response. The coefficient of ``x - x_m15`` isolates
    the local response and is what the planted per-pixel slope should be compared with.
    """
    m15 = f"{primary}_m15"
    if m15 not in FEATURES or primary not in FEATURES:
        return None
    gi = _S08_GROUPS.index(group)
    years = DF["year"].to_numpy()
    xs, xm, sv = [], [], []
    for y in XAI_FRAMES.get(mode, []):
        sel = years == int(y)
        xs.append(DF.loc[sel, primary].to_numpy(np.float64))
        xm.append(DF.loc[sel, m15].to_numpy(np.float64))
        sv.append(np.asarray(SHAP_GROUP_VALUES[mode][int(y)][:, gi], np.float64))
    if not xs:
        return None
    x, m, sh = np.concatenate(xs), np.concatenate(xm), np.concatenate(sv)
    ok = np.isfinite(x) & np.isfinite(m) & np.isfinite(sh)
    if ok.sum() < 100 or np.ptp(x[ok] - m[ok]) <= 0:
        return None
    A = np.column_stack([np.ones(int(ok.sum())), x[ok] - m[ok], m[ok]])
    coef, *_ = np.linalg.lstsq(A, sh[ok], rcond=None)
    return float(coef[1])


def _s08_support_above(mode, group, value):
    """Share of dependence-curve rows with a primary value above ``value`` (support of a planted threshold)."""
    dep = globals().get("DEPENDENCE")
    d = ((dep.get(mode) or {}).get("groups") or {}).get(group) if isinstance(dep, dict) else None
    if not d or value is None:
        return None
    c = np.asarray(d["bin_centers"], np.float64)
    n = np.asarray(d["count"], np.float64)
    tot = float(n[np.isfinite(c)].sum())
    return float(n[np.isfinite(c) & (c > float(value))].sum() / tot) if tot > 0 else None


def _s08_planted_rows(mode, truth):
    rows = []
    planted = (truth.get("planted_thresholds") or {}).get(mode) or {}
    for group, spec in planted.items():
        if group not in THRESHOLDS.get(mode, {}):
            continue
        th = THRESHOLDS[mode][group]
        kind = str(spec.get("kind"))
        base = {"mode": mode, "group": group, "primary": spec.get("primary"), "kind": kind,
                "planted_direction": spec.get("direction"), "recovered_direction": th["direction"],
                "direction_match": th["direction"] == spec.get("direction")}
        if kind == "saturation":
            rec, ci, sup, est = th["saturation"], th["saturation_ci"], th["saturation_support"], "saturation"
            # A planted saturation of one member can appear as a *kink* of the group curve when another member keeps
            # acting beyond it (day NDVI: per-pixel saturation at 0.30 plus park cooling via the neighbourhood NDVI).
            # Fall back to the hinge breakpoint when the slope after it keeps the sign but at most halves.
            sb, sa = th.get("slope_before"), th.get("slope_after")
            if (rec is None and th["breakpoint"] is not None and sb is not None and sa is not None
                    and sb * sa >= 0 and abs(sa) <= 0.5 * abs(sb)):
                rec, ci, sup, est = th["breakpoint"], th["breakpoint_ci"], th["breakpoint_support"], "kink (hinge)"
            rows.append({**base, "planted": spec.get("value"), "recovered": rec, "ci": ci,
                         "support": sup, "estimator": est,
                         "abs_error": None if rec is None else abs(rec - float(spec["value"])),
                         "share_above_planted": _s08_support_above(mode, group, spec.get("value"))})
        elif kind == "onset":
            rec = th["breakpoint"]
            rows.append({**base, "planted": spec.get("value"), "recovered": rec, "ci": th["breakpoint_ci"],
                         "support": th["breakpoint_support"], "estimator": "breakpoint",
                         "abs_error": None if rec is None else abs(rec - float(spec["value"]))})
            if spec.get("saturation") is not None:
                rec2 = th["saturation"]
                rows.append({**base, "kind": "onset/saturation", "planted": spec["saturation"], "recovered": rec2,
                             "ci": th["saturation_ci"], "support": th["saturation_support"],
                             "estimator": "saturation",
                             "abs_error": None if rec2 is None else abs(rec2 - float(spec["saturation"]))})
        else:
            slope_key = next((k for k in ("slope_c_per_unit", "slope_c_per_m", "slope_c_per_log1p") if k in spec),
                             None)
            rec = th.get("slope")
            planted_v = spec.get(slope_key) if slope_key else None
            rows.append({**base, "planted": planted_v, "recovered": rec, "ci": None, "support": None,
                         "estimator": "binned-curve slope",
                         "abs_error": None if (rec is None or planted_v is None) else abs(rec - float(planted_v))})
            local = _s08_local_slope(mode, group, spec.get("primary")) if kind == "linear" else None
            if local is not None:
                rows.append({**base, "kind": "linear (local contrast)", "planted": planted_v, "recovered": local,
                             "recovered_direction": "warming" if local > 0 else "cooling",
                             "direction_match": (local > 0) == (spec.get("direction") == "warming"),
                             "ci": None, "support": None, "estimator": "SHAP ~ (x - x_m15) + x_m15",
                             "abs_error": None if planted_v is None else abs(local - float(planted_v))})
    return rows


def _s08_planted_report(truth):
    """Print the planted-vs-recovered tables; returns the row list (also stored in PLANTED_VS_RECOVERED_08)."""
    rows = [r for m in IMPORTANCE for r in _s08_planted_rows(m, truth)]
    if rows:
        tab = pd.DataFrame(rows)
        for col in ("planted", "recovered", "abs_error", "share_above_planted"):
            if col not in tab:
                tab[col] = None
            tab[col] = tab[col].map(lambda v: None if v is None else round(float(v), 4))
        tab["ci"] = tab["ci"].map(lambda v: None if v is None else [round(float(v[0]), 3), round(float(v[1]), 3)])
        print("Planted (synthetic generator) vs recovered (grouped SHAP thresholds):")
        print(tab.to_string(index=False))
        print(f"direction matches: {int(tab['direction_match'].sum())}/{len(tab)}")
    irrelevant = truth.get("irrelevant_by_construction") or {}
    effects = truth.get("planted_mean_abs_effect_c") or {}
    for mode in IMPORTANCE:
        order = IMPORTANCE[mode]["order"]
        ranks = {_S08_GROUPS[gi]: r for r, gi in enumerate(order, start=1)}
        irr = [g for g in irrelevant.get(mode, []) if g in ranks]
        if irr:
            print(f"{mode}: rank (of 18) of groups irrelevant by construction: "
                  + ", ".join(f"{g}={ranks[g]}" for g in sorted(irr, key=ranks.get)))
        eff = {g: v for g, v in (effects.get(mode) or {}).items() if g in ranks}
        if len(eff) >= 3:
            from scipy.stats import spearmanr

            gs = sorted(eff)
            mean_abs = IMPORTANCE[mode]["global"]["mean_abs"]
            rho = spearmanr([eff[g] for g in gs], [mean_abs[_S08_GROUPS.index(g)] for g in gs]).correlation
            print(f"{mode}: Spearman rho(planted mean |effect|, recovered mean |SHAP|) over {len(gs)} planted groups "
                  f"= {rho:.2f}")
    expect = truth.get("monotone_expectations") or {}
    for mode, groups in expect.items():
        if mode not in THRESHOLDS:
            continue
        for g, sign in groups.items():
            d = THRESHOLDS[mode][g]["direction"]
            want = "warming" if sign > 0 else "cooling"
            print(f"{mode}: expected {g} {want}, recovered {d} -> {'OK' if d == want else 'MISMATCH'}")
    if "day" in THRESHOLDS and "night" in THRESHOLDS:
        for g in ("built", "water"):
            print(f"sign flip {g}: day {THRESHOLDS['day'][g]['direction']}, night {THRESHOLDS['night'][g]['direction']}")
    return rows


PLANTED_VS_RECOVERED_08 = (_s08_planted_report(SYNTHETIC_TRUTH)
                           if isinstance(globals().get("SYNTHETIC_TRUTH"), dict) and SYNTHETIC_TRUTH else [])

# %% [markdown]
# ## 8.20 Figures

# %%
_S08_FIG_DIR = Path(CFG.FIG_DIR)
_S08_FIG_DIR.mkdir(parents=True, exist_ok=True)


def _s08_save_fig(fig, name):
    fig.savefig(_S08_FIG_DIR / name, dpi=140, bbox_inches="tight")
    plt.show()
    plt.close(fig)


def _s08_raster(values):
    grid = np.full(GRID.shape, np.nan)
    grid[CELL_ROWS, CELL_COLS] = np.asarray(values, dtype=np.float64)
    return grid


def _s08_fig_importance():
    modes = list(IMPORTANCE)
    fig, axes = plt.subplots(1, len(modes), figsize=(7 * len(modes), 6.5), squeeze=False)
    for ax, mode in zip(axes[0], modes):
        imp = IMPORTANCE[mode]["global"]
        order = IMPORTANCE[mode]["order"][::-1]
        vals = np.asarray(imp["mean_abs"])[order]
        lo = np.clip(np.nan_to_num(vals - np.asarray(imp["ci_lo"])[order]), 0, None)
        hi = np.clip(np.nan_to_num(np.asarray(imp["ci_hi"])[order] - vals), 0, None)
        ax.barh(range(_S08_NG), vals, color="#f59e0b" if mode == "day" else "#6366f1", height=0.6,
                xerr=np.vstack([lo, hi]), ecolor="#334155", capsize=2)
        ax.set_yticks(range(_S08_NG))
        ax.set_yticklabels([GROUP_META[_S08_GROUPS[i]]["label"] for i in order], fontsize=8)
        ax.set_xlabel(f"mean |group SHAP| (°C); whiskers {BOOTSTRAP_INFO[mode]['ci_label']}")
        ax.set_title(f"{mode}: grouped SHAP importance ({BOOTSTRAP_INFO[mode]['n']} replicates)")
    _s08_save_fig(fig, "08_importance_groups.png")


def _s08_fig_dependence(mode):
    dep = DEPENDENCE[mode]["groups"]
    top = IMPORTANCE[mode]["order"][:6]
    fig, axes = plt.subplots(2, 3, figsize=(15, 8.5))
    styles = {"zero_crossing": (":", "zero crossing"), "breakpoint": ("--", "breakpoint"),
              "saturation": ("-.", "saturation")}
    for ax, gi in zip(axes.ravel(), top):
        g = _S08_GROUPS[gi]
        d = dep[g]
        sc = d["scatter"]
        ax.scatter(sc["x"], sc["shap"], s=4, c=sc["color"], cmap="viridis", alpha=0.5, linewidths=0)
        ax.fill_between(d["bin_centers"], d["ci_lo"], d["ci_hi"], color="#a78bfa", alpha=0.3)
        ax.plot(d["bin_centers"], d["mean"], color="#6d28d9", lw=2)
        for key, (ls, name) in styles.items():
            if d["threshold"][key] is not None:
                ax.axvline(d["threshold"][key], color="#0f172a", ls=ls, lw=1, label=name)
        ax.axhline(0, color="#475569", lw=0.6)
        ax.set_title(f"{GROUP_META[g]['label']} ({d['threshold']['direction']})", fontsize=10)
        ax.set_xlabel(f"{d['primary']} (colour: {sc['color_feature']})", fontsize=8)
        ax.set_ylabel("group SHAP (°C)")
        if any(d["threshold"][k] is not None for k in styles):
            ax.legend(fontsize=7, frameon=False)
    fig.suptitle(f"{mode}: dependence of the six most important groups (band = {BOOTSTRAP_INFO[mode]['ci_label']})")
    fig.tight_layout()
    _s08_save_fig(fig, f"08_dependence_{mode}.png")


def _s08_fig_zones():
    from matplotlib.colors import ListedColormap
    from matplotlib.patches import Patch

    modes = list(ZONES_OBS)
    cmap = ListedColormap([m["color"] for m in _S08_ZONE_META])
    fig, axes = plt.subplots(1, len(modes), figsize=(6.5 * len(modes), 7), squeeze=False)
    for ax, mode in zip(axes[0], modes):
        z = ZONES_OBS[mode][_S08_NOW].astype(np.float64)
        z[z >= _S08_N_ZONES] = np.nan
        ax.imshow(_s08_raster(z), cmap=cmap, vmin=-0.5, vmax=3.5, interpolation="nearest")
        ax.set_axis_off()
        ax.set_title(f"{mode} zones {_S08_NOW} (silhouette {ZONE_MODEL[mode]['silhouette']:.2f})")
    axes[0][0].legend(handles=[Patch(color=m["color"], label=f"{m['id']} {m['name']}") for m in _S08_ZONE_META],
                      loc="lower left", fontsize=8)
    _s08_save_fig(fig, "08_zones_map.png")


def _s08_fig_signatures():
    modes = list(ZONE_PROFILES)
    fig, axes = plt.subplots(len(modes), 1, figsize=(13, 2.6 * len(modes) + 1), squeeze=False)
    for ax, mode in zip(axes[:, 0], modes):
        mat = np.array([[p["shap_means"][g] for g in _S08_GROUPS] for p in ZONE_PROFILES[mode]])
        vmax = float(np.nanmax(np.abs(mat))) or 1.0
        im = ax.imshow(mat, cmap="RdBu_r", vmin=-vmax, vmax=vmax, aspect="auto")
        for (r, c), v in np.ndenumerate(mat):
            ax.text(c, r, f"{v:.2f}", ha="center", va="center", fontsize=6,
                    color="white" if abs(v) > 0.6 * vmax else "#0f172a")
        ax.set_xticks(range(_S08_NG))
        ax.set_xticklabels(_S08_GROUPS, rotation=60, ha="right", fontsize=7)
        ax.set_yticks(range(_S08_N_ZONES))
        ax.set_yticklabels([p["name"] for p in ZONE_PROFILES[mode]], fontsize=8)
        ax.set_title(f"{mode}: zone SHAP signatures (mean group SHAP, °C)")
        fig.colorbar(im, ax=ax)
    fig.tight_layout()
    _s08_save_fig(fig, "08_zone_signatures.png")


def _s08_fig_diagnostics():
    fig, axes = plt.subplots(1, 2, figsize=(11, 3.6))
    for mode in ZONE_MODEL:
        dg = ZONE_MODEL[mode]["diagnostics"]
        axes[0].plot(dg["k"], dg["inertia"], marker="o", lw=2, label=mode)
        axes[1].plot(dg["k"], dg["silhouette"], marker="o", lw=2, label=mode)
    axes[0].set_title("K-means inertia (group-SHAP space)")
    axes[1].set_title("silhouette (sample)")
    for ax in axes:
        ax.axvline(_S08_N_ZONES, color="#fb7185", ls="--", lw=1)
        ax.set_xlabel("K")
        ax.legend(frameon=False)
    _s08_save_fig(fig, "08_zone_k_diagnostics.png")


def _s08_fig_interactions():
    modes = list(INTERACTIONS)
    fig, axes = plt.subplots(1, len(modes), figsize=(7.5 * len(modes), 6.5), squeeze=False)
    for ax, mode in zip(axes[0], modes):
        off = np.asarray(INTERACTIONS[mode]["global"], dtype=np.float64).copy()
        np.fill_diagonal(off, np.nan)
        im = ax.imshow(off, cmap="magma_r")
        ax.set_xticks(range(_S08_NG))
        ax.set_yticks(range(_S08_NG))
        ax.set_xticklabels(_S08_GROUPS, rotation=70, ha="right", fontsize=7)
        ax.set_yticklabels(_S08_GROUPS, fontsize=7)
        ax.set_title(f"{mode}: mean |group interaction| (off-diagonal, °C)")
        fig.colorbar(im, ax=ax, shrink=0.8)
    fig.tight_layout()
    _s08_save_fig(fig, "08_interactions.png")


with timer("08_figures"):
    _s08_figs = [_s08_fig_importance, _s08_fig_zones, _s08_fig_signatures, _s08_fig_diagnostics,
                 _s08_fig_interactions] + [(lambda m=m: _s08_fig_dependence(m)) for m in DEPENDENCE]
    for _s08_fig_fn in _s08_figs:
        try:
            if IMPORTANCE:
                _s08_fig_fn()
        except Exception as _s08_exc:  # noqa: BLE001 - a broken figure must never lose the computed results
            log(f"08: figure {getattr(_s08_fig_fn, '__name__', 'dependence')} failed: "
                f"{type(_s08_exc).__name__}: {_s08_exc}", "WARNING")
            plt.close("all")

# %% [markdown]
# ## 8.21 Contract check (SPEC §3.5)

# %%
def _s08_contract_check():
    """Raise AssertionError if a §3.5 global violates the contract."""
    n = _S08_NC
    for mode in _S08_PAYLOADS:
        assert XAI_FRAMES[mode] == list(_S08_FRAMES), (mode, XAI_FRAMES[mode])
        assert isinstance(SHAP_BASE[mode], float) and np.isfinite(SHAP_BASE[mode])
        for y in XAI_FRAMES[mode]:
            sv, pa, oo = SHAP_GROUP_VALUES[mode][y], PRED_ANOM[mode][y], OOF_ANOM[mode][y]
            assert sv.shape == (n, _S08_NG) and sv.dtype == np.float32, (mode, y, sv.shape, sv.dtype)
            assert pa.shape == (n,) and pa.dtype == np.float32 and np.isfinite(pa).all(), (mode, y)
            assert oo.shape == (n,) and oo.dtype == np.float32, (mode, y)
            valid = np.isfinite(sv).all(axis=1)
            assert np.array_equal(valid, _S08_ROW_VALID[_s08_frame_slice(y)]), f"{mode} {y}: NaN-row pattern"
            assert np.isnan(sv[~valid]).all()
            err = np.abs(pa[valid].astype(np.float64) - (SHAP_BASE[mode] + sv[valid].sum(axis=1, dtype=np.float64)))
            assert err.size == 0 or float(err.max()) < 1e-3, f"{mode} {y}: additivity {float(err.max()):.2e}"
            w = DF[f"w_{mode}"].to_numpy()[_s08_frame_slice(y)]
            assert np.isnan(oo[w <= 0]).all(), f"{mode} {y}: OOF defined on non-training rows"
            z = ZONES_OBS[mode][y]
            assert z.shape == (n,) and z.dtype == np.uint8 and set(np.unique(z).tolist()) <= {0, 1, 2, 3, 255}
            assert np.array_equal(z == 255, ~valid), f"{mode} {y}: zone nodata pattern"
        zm = ZONE_MODEL[mode]
        assert np.asarray(zm["centroids"]).shape == (4, _S08_NG)
        # the labelling rule re-derived from the published zones over the fit frames
        fit = _s08_fit_frames(mode)
        G = np.concatenate([SHAP_GROUP_VALUES[mode][y] for y in fit]).astype(np.float64)
        Z = np.concatenate([ZONES_OBS[mode][y] for y in fit])
        FW = np.concatenate([_S08_X[_s08_frame_slice(y), FEATURES.index("frac_water")] for y in fit])
        ok = Z < 4
        tot = np.array([G[ok & (Z == k)].sum(axis=1).mean() for k in range(4)])
        fw = np.array([np.nanmean(FW[ok & (Z == k)]) for k in range(4)])
        assert int(np.argmax(tot)) == 3, f"{mode}: zone 3 is not the highest mean total SHAP ({tot})"
        lab = zm["labelling"]
        assert isinstance(lab.get("riparian_criterion_met"), bool) and isinstance(lab.get("riparian_criterion"), str)
        for c in lab["clusters"]:
            assert isinstance(c["share_water_ge_0_2"], float) and 0.0 <= c["share_water_ge_0_2"] <= 1.0, c
            assert isinstance(c["water_group_rank"], int) and 1 <= c["water_group_rank"] <= _S08_NG, c
        stats_z = []
        for k in range(3):
            sel = ok & (Z == k)
            fwk = FW[sel][np.isfinite(FW[sel])]
            mabs = np.abs(G[sel]).mean(axis=0)
            stats_z.append({"mean_frac_water": float(fw[k]),
                            "share_water_ge_0_2": float(np.mean(fwk >= _S08_RIPARIAN_WET_FRAC)) if fwk.size else 0.0,
                            "water_mean_abs_shap": float(mabs[_S08_GROUPS.index("water")]),
                            "water_group_rank": 1 + int(np.sum(mabs > mabs[_S08_GROUPS.index("water")]))})
        elig = [bool(_s08_riparian_reasons(s_)) for s_ in stats_z]
        assert any(elig) == lab["riparian_criterion_met"], f"{mode}: riparian criterion re-derivation ({elig})"
        if lab["riparian_criterion_met"]:
            assert elig[1] and all(fw[1] >= fw[k] - 1e-12 for k in (0, 2) if elig[k]), \
                f"{mode}: zone 1 is not the wettest riparian-eligible cluster ({fw}, {elig})"
            assert tot[0] <= tot[2] + 1e-12, f"{mode}: zone 0 must have the lower mean total SHAP of zones 0/2 ({tot})"
        else:
            assert tot[0] <= tot[1] + 1e-12 and tot[1] <= tot[2] + 1e-12, \
                f"{mode}: without a riparian signal zones 0/1/2 must be ordered by mean total SHAP ({tot})"
        for p in ZONE_PROFILES[mode]:
            assert isinstance(p["display_name"], str) and p["display_name"], p["id"]
            assert p["label_caveat"] is None or isinstance(p["label_caveat"], str), p["id"]
            assert p["name"] == _S08_ZONE_META[p["id"]]["name"]                   # canonical names unchanged
            if p["id"] != 1 or lab["riparian_criterion_met"]:
                assert p["display_name"] == p["name"] and p["label_caveat"] is None, p["id"]
            else:
                assert p["display_name"] == _S08_NO_RIPARIAN_NAME and p["label_caveat"]
                assert p["description"].startswith(f"{p['display_name']} ({mode}): {p['label_caveat']}")
        it = INTERACTIONS[mode]
        assert np.asarray(it["global"]).shape == (_S08_NG, _S08_NG) and set(it["by_zone"]) == {0, 1, 2, 3}
        assert list(IMPORTANCE[mode]["groups"]) == _S08_GROUPS and len(IMPORTANCE[mode]["global"]["mean_abs"]) == 18
        assert set(DEPENDENCE[mode]["groups"]) == set(_S08_GROUPS) and set(THRESHOLDS[mode]) == set(_S08_GROUPS)
        for g, t in THRESHOLDS[mode].items():
            for k in ("zero_crossing", "breakpoint", "saturation"):
                assert t[k] is not None or t[f"{k}_ci"] is None, (mode, g, k)
                if t[f"{k}_ci"] is not None:
                    assert t[f"{k}_ci"][0] - 1e-9 <= t[k] <= t[f"{k}_ci"][1] + 1e-9, (mode, g, k)
        assert len(ZONE_PROFILES[mode]) == 4 and [p["id"] for p in ZONE_PROFILES[mode]] == [0, 1, 2, 3]
        assert "obs" in ZONE_TRANSITIONS[mode]
        for recs in RECOMMENDATIONS[mode].values():
            assert len(recs) <= _S08_REC_MAX_PER_ZONE
            for r in recs:
                b = r["bounds"]
                assert r["expected_delta_c"] < -_S08_REC_MIN_COOLING_C, r
                assert b["p10"] - 1e-9 <= r["target"] <= b["p90"] + 1e-9, r
                if b["max_step"] is not None:
                    assert abs(r["step"]) <= b["max_step"] + 1e-9, r
                lo, hi = _S08_BOUNDS.get(r["feature"], (-np.inf, np.inf))
                assert lo - 1e-9 <= r["target"] <= hi + 1e-9, r
                assert r["action"] in _S08_LEVERS_RULES[r["feature"]], r
                assert (r["step"] > 0) == (r["action"] == "increase"), r
                if r["ci"] is not None:
                    assert r["ci"][0] - 1e-9 <= r["expected_delta_c"] <= r["ci"][1] + 1e-9, r
        wm = WEB_MODELS[mode]
        assert wm["format"] == "lst-xgb-compact-v1" and wm["features"] == list(FEATURES)
        assert wm["focal"] == {"bases": list(FOCAL_SPEC["bases"]), "windows": list(FOCAL_SPEC["windows"])}
        assert wm["n_trees"] <= _S08_WEB_ROUNDS and _s08_compact_depth(wm) <= _S08_WEB_DEPTH
        assert len(wm["check"]["rows"]) == len(wm["check"]["expected"]) > 0
        bi = BOOTSTRAP_INFO[mode]
        assert bi["ci_method"] == "recentred-percentile"
        assert bi["ci_label"] in ("95% CI", "replicate range", "no bootstrap")
    assert set(SCENARIO_COUPLING["fraction_features"]) == set(_S08_FRACTIONS)
    assert SCENARIO_COUPLING["focal"]["windows"] == list(FOCAL_SPEC["windows"])


_s08_contract_check()
log("08: contract check passed (SPEC §3.5: shapes, dtypes, additivity, zones/labelling, bounds, web models)")
log("Section 08 complete: XAI_FRAMES, SHAP_BASE, SHAP_GROUP_VALUES, PRED_ANOM, OOF_ANOM, IMPORTANCE, INTERACTIONS, "
    "DEPENDENCE, THRESHOLDS, BOOTSTRAP_INFO, ZONE_MODEL, ASSIGN_ZONES, ZONES_OBS, ZONE_PROFILES, ZONE_TRANSITIONS, "
    "RECOMMENDATIONS, SCENARIO_COUPLING, WEB_MODELS ready")
free_memory()
