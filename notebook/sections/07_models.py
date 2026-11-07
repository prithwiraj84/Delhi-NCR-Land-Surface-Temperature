# %% [markdown]
# # 7. Models, validation suite, final models, persistent residual and area of applicability
#
# One pooled model per mode (day, night) predicts the **anomaly** target of section 06 from the 47 features (no year
# feature, no coordinates). This section answers four questions and leaves the objects later sections need:
#
# | Question | Answer here | Used by |
# |---|---|---|
# | How well does the model transfer to unseen **places**? | pooled out-of-fold (OOF) metrics under 20 km-block spatial CV (`block20`, headline), v1's 5 × 5 tiles (`block5`), leave-one-district-out (`district`), the block-size curve and error-vs-distance | metrics.json, Model Lab |
# | ... to unseen **times**? | leave-one-epoch-out (`loeo`, raw and **recentred**) and unseen place **and** time (`place_time`) | timeline headline, hindcast credibility |
# | What is the final model? | `FINAL_MODELS[m]` (XGBoost, monotone constraints, rounds from block20 early stopping) and `PREDICT_ANOM` | 08 SHAP, 09 hindcast, 11 projections |
# | Where can it be trusted, and how wrong is it there? | `PERSISTENT_RESID` (time transfer only), `AOA[m]` + `COMPUTE_DI` (Meyer & Pebesma 2021) and a conformal error model by DI decile | 09 intervals, 10/11 flags, 11 Monte Carlo |
#
# **Validation design (SPEC §4.2).** Every scheme scores *pooled* OOF predictions — $R^2 = 1 - \sum w(y-\hat y)^2 /
# \sum w (y - \bar y_w)^2$ over all held-out rows, with the sample weights of section 06 — and reports the per-fold
# spread separately. Pooling avoids v1's mistake of averaging per-fold $R^2$, which is dominated by a fold whose
# own variance happens to be small. Folds are spatial blocks that keep a cell (and its whole block) in one fold in
# every frame, so the same place in another year never helps predict itself.
#
# | Scheme | Split | Models | Question |
# |---|---|---|---|
# | `block20` | 20 km blocks → `N_FOLDS_BLOCK` folds | all `CFG.BENCHMARKS` | headline spatial transfer (≈ residual correlation range) |
# | `block5` | v1 5 × 5 tiles → 5 folds | xgboost, lightgbm, gnn | comparability with v1 |
# | `district` | leave one district out (< 200 rows merged into the nearest district) | xgboost | administrative transfer |
# | `loeo` | leave one training frame out; recentred over the held-out frame's fixed mask | all | temporal transfer (timeline headline) |
# | `place_time` | train frames < last & folds ≠ k → test last frame & fold k | xgboost | unseen place **and** time |
# | `random` | 5 random row folds | xgboost, random_forest, ridge | optimistic upper bound |
#
# **Recentring.** The anomaly target has zero mean over the fixed mask *by definition*, so subtracting the mean of a
# predicted anomaly map over the same cells uses predictions only and is legitimate. It removes the frame-wide offset
# that land-cover product drift or sensor changes induce in temporal transfer (real data: LOEO $R^2$ 0.80 → 0.89).
#
# **Leakage controls** (asserted at run time): test and training rows are disjoint; spatial schemes share no cell
# and no block between train and test; LOEO never trains on the held-out frame; early stopping uses whole 10 km blocks
# drawn from the *training* rows only; imputation medians and standardisation come from the training rows only.
#
# **Compute layout.** All (scheme × model × fold) fits of a mode are one job list split into lanes that run
# concurrently: the **GPU lane** spreads XGBoost-CUDA, GraphSAGE and cuML-RF jobs over the GPUs with `gpu_pool_map`
# (one job per T4 at a time); the **CPU lane** runs ridge and scikit-learn RF (and LightGBM on the CPU); when the
# LightGBM GPU probe succeeds, LightGBM gets its own serial **lgbm lane** on the last GPU (`gpu_id = n_gpus − 1`; at
# most one LightGBM booster alive at a time, its OpenCL learner is not thread safe). Identical fits requested by two
# schemes (e.g. the 20 km point of the block-size curve when `N_FOLDS_BLOCK = 5`) run once. Every job is
# stage-cached individually, so an interrupted Kaggle session resumes where it stopped; each lane stops scheduling
# new jobs when the time budget (section 00) would be exceeded and the section then stops cleanly.

# %%
import hashlib as _s07_hashlib
import math as _s07_math
import os as _s07_os
import threading as _s07_threading
import time as _s07_time
import traceback as _s07_traceback
import warnings as _s07_warnings
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import sparse as _s07_sparse
from scipy.spatial import cKDTree as _s07_cKDTree

_S07_VERSION = "07-v2.1"          # final model / AOA / residual models (07_post)
# CV fits themselves are unchanged since v2.0: their identities (job de-duplication and the 07_job cache) keep
# the job-recipe version, so a scheduling-only change reuses the cached fits.
_S07_JOB_VERSION = "07-v2.0"
_S07_SCHEMES = ["block20", "block5", "district", "loeo", "place_time", "random"]
_S07_SCHEME_MODELS = {
    "block20": list(CFG.BENCHMARKS),
    "block5": [m for m in ("xgboost", "lightgbm", "gnn") if m in CFG.BENCHMARKS],
    "district": ["xgboost"],
    "loeo": list(CFG.BENCHMARKS),
    "place_time": ["xgboost"],
    "random": [m for m in ("xgboost", "random_forest", "ridge") if m in CFG.BENCHMARKS],
}
_S07_CURVE_KM = [5, 10, 20, 40, 66]
_S07_CURVE_FOLDS = 5
_S07_DIST_BINS = [0.0, 2.0, 5.0, 10.0, 20.0, 40.0, float("inf")]
_S07_LAMBDAS = [0.5, 1.0, 2.0, 3.0, 5.0, 10.0, float("inf")]
_S07_DISTRICT_MIN_ROWS = 200
_S07_AOA_SAMPLE = 20000
_S07_CONFORMAL_ROWS = 100000
_S07_RESID_SAMPLES = 5000
_S07_RF_TREES = 60 if CFG.PROFILE == "fast" else 300
# scikit-learn RF is the slowest CPU model (~1-2 s per tree on 400k rows). Each fold's forest is fitted on at most
# this many training rows (seeded subsample; each tree then bootstraps max_samples = 50 % of them).
_S07_RF_MAX_ROWS = int(_s07_os.environ.get("LST_RF_MAX_ROWS", "120000"))
# CPU fallback only: wall-clock budget per GNN fold (the GPU path always runs CFG.GNN_EPOCHS with early stopping).
_S07_GNN_CPU_BUDGET_S = float(_s07_os.environ.get("LST_GNN_CPU_BUDGET_S", "900"))
_S07_RUN_ABLATION = _s07_os.environ.get("LST_ABLATION", "1").strip().lower() not in ("0", "false", "no", "off")
_S07_LGBM_PARAMS = {"learning_rate": 0.03, "num_leaves": 63, "subsample": 0.8, "subsample_freq": 1,
                    "colsample_bytree": 0.8, "min_child_samples": 20, "reg_lambda": 1.0, "verbose": -1}
_S07_V1_REFERENCE = {"v1_metric": "mean of per-fold R² (5×5)", "v1_xgb": [0.623, 0.305], "v1_gnn": [0.823, 0.048]}

# Monotone constraints (SPEC §4.3): physically certain signs only. Day: vegetation, tree cover and water cool the
# mid-morning surface; night: built-up fraction and building volume (heat storage) warm the night surface.
_S07_MONOTONE = {
    "day": {f: -1 for f in ("ndvi", "ndvi_m3", "ndvi_m15", "frac_forest", "frac_forest_m3", "frac_forest_m15",
                            "frac_water", "frac_water_m3", "frac_water_m15", "mndwi")},
    "night": {f: 1 for f in ("built_v", "frac_built", "frac_built_m3", "frac_built_m15")},
}

# Shared read-only design data (row positions everywhere are DF row positions).
_S07_X = np.ascontiguousarray(DF[FEATURES].to_numpy(np.float32))
_S07_N = len(DF)
_S07_YEAR = DF["year"].to_numpy(np.int64)
_S07_CELL = DF["cell_id"].to_numpy(np.int64)
_S07_ROW = DF["row"].to_numpy(np.int64)
_S07_COL = DF["col"].to_numpy(np.int64)
_S07_XY = DF[["x", "y"]].to_numpy(np.float64)
_S07_BLOCK10 = DF["block10_id"].to_numpy(np.int64)
_S07_BLOCK20 = DF["block20_id"].to_numpy(np.int64)
_S07_FOLD20 = DF["fold_block20"].to_numpy(np.int64)
_S07_FRAMES_DF = sorted(int(y) for y in np.unique(_S07_YEAR))
_S07_CELL_POS = np.searchsorted(CELL_IDS, _S07_CELL).astype(np.int64)    # canonical cell index of every row
_S07_BASE_IDX = np.array([FEATURES.index(f) for f in BASE_FEATURES], dtype=np.int64)
_S07_TORCH_LOCK = _s07_threading.Lock()
_S07_PRINT_LOCK = _s07_threading.Lock()
if not np.array_equal(CELL_IDS[_S07_CELL_POS], _S07_CELL):
    raise RuntimeError("07: DF cell ids are not in the canonical cell set")
log(f"07: design matrix {_S07_X.shape} float32 ({_S07_X.nbytes / 2**20:.0f} MiB); benchmarks {CFG.BENCHMARKS}; "
    f"XGBoost on {ENV.get('xgb_device')} ({ENV.get('n_gpus', 0)} GPU(s)); RF trees {_S07_RF_TREES} "
    f"(<= {_S07_RF_MAX_ROWS:,} rows/fold)")


def _s07_hash(*parts):
    """Short SHA-1 of arrays / JSON-able parts (used for stage-cache keys and job de-duplication)."""
    h = _s07_hashlib.sha1()
    for p in parts:
        if isinstance(p, np.ndarray):
            h.update(str(p.dtype).encode())
            h.update(np.ascontiguousarray(p).tobytes())
        else:
            h.update(repr(p).encode())
        h.update(b"|")
    return h.hexdigest()[:20]


def _s07_df_fingerprint():
    """Fingerprint of everything in DF the models see (features, targets, weights, folds)."""
    cols = ["anom_day", "anom_night", "w_day", "w_night", "fold_block5", "fold_block20", "fold_random",
            "block10_id", "block20_id", "fold_district"]
    sums = [float(np.nansum(_S07_X[:, j], dtype=np.float64)) for j in range(_S07_X.shape[1])]
    sums += [float(np.nansum(DF[c].to_numpy(np.float64))) for c in cols]
    counts = [int(np.isfinite(_S07_X).sum())] + [int(np.isfinite(DF[c].to_numpy(np.float64)).sum()) for c in cols]
    return _s07_hash(FEATURES, _S07_N, np.round(np.asarray(sums), 6), counts)


_S07_DF_FP = _s07_df_fingerprint()

# %% [markdown]
# ## 7.1 Mode context, folds and leakage checks
# A mode's training rows are the rows with weight > 0 (day: every observed frame; night: `NIGHT_TRAIN_FRAMES`).
# Fold generators return DF row positions; `_s07_check_fold` asserts the leakage rules for every fold before any fit.

# %%
def _s07_context(mode):
    """Per-mode targets, weights, training rows, fixed-mask rows and monotone constraints."""
    y = DF[f"anom_{mode}"].to_numpy(np.float32)
    w = DF[f"w_{mode}"].to_numpy(np.float32)
    train = np.flatnonzero(w > 0).astype(np.int64)
    if train.size and not np.all(np.isfinite(y[train])):
        raise RuntimeError(f"07: {mode} has training rows without a finite anomaly target")
    frames = sorted(int(v) for v in np.unique(_S07_YEAR[train]))
    fixed_row = FIXED_MASK[mode][_S07_ROW, _S07_COL]
    mono = np.array([_S07_MONOTONE.get(mode, {}).get(f, 0) for f in FEATURES], dtype=np.int64)
    return {"mode": mode, "y": y, "w": w, "train": train, "frames": frames, "fixed_row": fixed_row,
            "mono": mono, "gnn": None}


def _s07_greedy(block_ids_of_cells, n_folds):
    """Greedy size-balanced block → fold map (largest block first → smallest fold), on ROI cell counts."""
    uniq, counts = np.unique(block_ids_of_cells, return_counts=True)
    order = sorted(range(uniq.size), key=lambda i: (-counts[i], uniq[i]))
    load = np.zeros(int(n_folds), dtype=np.int64)
    fold_of = {}
    for i in order:
        k = int(np.argmin(load))
        fold_of[int(uniq[i])] = k
        load[k] += counts[i]
    return fold_of


def _s07_block_fold_rows(block_cells, n_folds):
    """(N_DF,) fold of every DF row for square blocks of ``block_cells`` cells (greedy on ROI cells)."""
    b = max(1, int(block_cells))
    ncb = _s07_math.ceil(GRID.width / b)
    cell_block = (CELL_ROWS.astype(np.int64) // b) * ncb + CELL_COLS.astype(np.int64) // b
    fold_of = _s07_greedy(cell_block, n_folds)
    lut = np.vectorize(fold_of.get, otypes=[np.int64])(cell_block)
    return lut[_S07_CELL_POS], (_S07_ROW // b) * ncb + _S07_COL // b


def _s07_district_fold(ctx):
    """Leave-one-district-out folds; districts with < 200 training rows join the nearest district's fold."""
    tr = ctx["train"]
    d_rows = DF["fold_district"].to_numpy(np.int64)[tr]
    n_d = len(DISTRICTS)
    counts = np.bincount(d_rows, minlength=n_d)
    cell_d = DISTRICT_IDX[CELL_ROWS, CELL_COLS].astype(np.int64)
    X, Y = GRID.cell_centers_xy()
    cx = np.bincount(cell_d, weights=np.asarray(X)[CELL_ROWS, CELL_COLS], minlength=n_d)
    cy = np.bincount(cell_d, weights=np.asarray(Y)[CELL_ROWS, CELL_COLS], minlength=n_d)
    nc = np.maximum(np.bincount(cell_d, minlength=n_d), 1)
    cx, cy = cx / nc, cy / nc
    big = [i for i in range(n_d) if counts[i] >= _S07_DISTRICT_MIN_ROWS]
    if len(big) < 2:
        log(f"07: {ctx['mode']}: fewer than 2 districts with >= {_S07_DISTRICT_MIN_ROWS} rows - district CV skipped",
            "WARNING")
        return None, []
    lut = np.arange(n_d, dtype=np.int64)
    merges = []
    for i in range(n_d):
        if 0 < counts[i] < _S07_DISTRICT_MIN_ROWS:
            j = min(big, key=lambda b: (cx[b] - cx[i]) ** 2 + (cy[b] - cy[i]) ** 2)
            lut[i] = j
            merges.append({"district": int(i), "into": int(j), "rows": int(counts[i])})
    if merges:
        log(f"07: {ctx['mode']}: districts merged into their nearest neighbour fold: {merges}")
    return lut[d_rows], merges


def _s07_folds(ctx, scheme):
    """List of ``{"fold", "train", "test"}`` (DF row positions) for one scheme of a mode."""
    tr = ctx["train"]
    out = []
    if tr.size == 0:
        return out
    yr = _S07_YEAR[tr]
    if scheme in ("block20", "block5", "random"):
        col = {"block20": "fold_block20", "block5": "fold_block5", "random": "fold_random"}[scheme]
        f = DF[col].to_numpy(np.int64)[tr]
        for k in np.unique(f):
            out.append({"fold": int(k), "train": tr[f != k], "test": tr[f == k]})
    elif scheme == "district":
        f, merges = _s07_district_fold(ctx)
        ctx["district_merges"] = merges
        if f is not None:
            for k in np.unique(f):
                out.append({"fold": int(k), "train": tr[f != k], "test": tr[f == k]})
    elif scheme == "loeo":
        if len(ctx["frames"]) >= 2:
            for t in ctx["frames"]:
                out.append({"fold": int(t), "train": tr[yr != t], "test": tr[yr == t]})
    elif scheme == "place_time":
        if len(ctx["frames"]) >= 2:
            last = ctx["frames"][-1]
            f = _S07_FOLD20[tr]
            for k in np.unique(f[yr == last]):
                out.append({"fold": int(k), "train": tr[(yr < last) & (f != k)], "test": tr[(yr == last) & (f == k)]})
    else:
        raise ValueError(f"unknown scheme {scheme!r}")
    return [fd for fd in out if fd["train"].size > 0 and fd["test"].size > 0]


def _s07_check_fold(ctx, scheme, fold):
    """Assert the leakage rules of one fold (raises AssertionError)."""
    tr, te = fold["train"], fold["test"]
    mark = np.zeros(_S07_N, dtype=bool)
    mark[tr] = True
    assert not mark[te].any(), f"{scheme} fold {fold['fold']}: train and test rows overlap"
    assert np.all(ctx["w"][tr] > 0) and np.all(ctx["w"][te] > 0), f"{scheme}: non-training rows in a fold"
    if scheme in ("block20", "block5", "district", "place_time") or scheme.startswith("curve_"):
        shared = np.intersect1d(np.unique(_S07_CELL[tr]), np.unique(_S07_CELL[te]), assume_unique=True)
        assert shared.size == 0, f"{scheme} fold {fold['fold']}: {shared.size} cells in both train and test"
    if scheme in ("block20", "place_time"):
        assert np.intersect1d(_S07_BLOCK20[tr], _S07_BLOCK20[te]).size == 0, f"{scheme}: a 20 km block is split"
    if scheme == "loeo":
        test_years = np.unique(_S07_YEAR[te])
        assert test_years.size == 1 and test_years[0] not in set(_S07_YEAR[tr].tolist()), \
            f"loeo fold {fold['fold']} trains on the held-out frame"
    if scheme == "place_time":
        last = ctx["frames"][-1]
        assert np.all(_S07_YEAR[te] == last) and np.all(_S07_YEAR[tr] < last), "place_time frame rule violated"


def _s07_inner_split(train_idx, val_share=0.10):
    """(fit_idx, val_idx) holding out whole 10 km blocks (~``val_share`` of the TRAINING rows) for early stopping.

    Blocks are drawn in a seeded random order until the share is reached (always keeping one block for fitting);
    with a single block the split falls back to a seeded random row split. Only training rows are ever used.
    """
    rng = np.random.default_rng(CFG.SEED)
    groups = _S07_BLOCK10[train_idx]
    uniq, counts = np.unique(groups, return_counts=True)
    if uniq.size < 2:
        is_val = np.zeros(train_idx.size, dtype=bool)
        is_val[rng.permutation(train_idx.size)[: max(1, int(round(val_share * train_idx.size)))]] = True
    else:
        order = rng.permutation(uniq.size)
        cum = np.cumsum(counts[order])
        n_take = min(int(np.searchsorted(cum, val_share * train_idx.size) + 1), uniq.size - 1)
        is_val = np.isin(groups, uniq[order[:n_take]])
    fit_idx, val_idx = train_idx[~is_val], train_idx[is_val]
    assert fit_idx.size and val_idx.size and np.intersect1d(_S07_BLOCK10[fit_idx], _S07_BLOCK10[val_idx]).size == 0 \
        or uniq.size < 2, "inner split must hold out whole 10 km blocks"
    return fit_idx, val_idx


def _s07_wmetrics(y, p, w):
    """Weighted pooled R², RMSE, MAE and bias (mean of prediction − observation)."""
    y, p, w = (np.asarray(a, np.float64) for a in (y, p, w))
    ok = np.isfinite(y) & np.isfinite(p) & np.isfinite(w) & (w > 0)
    if ok.sum() < 2:
        return {"r2": np.nan, "rmse": np.nan, "mae": np.nan, "bias": np.nan, "n": int(ok.sum())}
    y, p, w = y[ok], p[ok], w[ok]
    sw = w.sum()
    r = y - p
    ybar = float((w * y).sum() / sw)
    sse = float((w * r * r).sum())
    sst = float((w * (y - ybar) ** 2).sum())
    return {"r2": 1.0 - sse / sst if sst > 0 else np.nan, "rmse": float(np.sqrt(sse / sw)),
            "mae": float((w * np.abs(r)).sum() / sw), "bias": float((w * (p - y)).sum() / sw), "n": int(ok.sum())}


# %% [markdown]
# ## 7.2 Model implementations
# Each fitter receives the job (mode context, training/test rows, optional feature subset) and a GPU id and returns
# test predictions (anomaly °C) plus an info dict (`device`, `best_iteration` = boosting rounds or GNN epoch).
# Sample weights enter every loss. XGBoost and the GNN retry a fold on the CPU after a **GPU** out-of-memory error;
# LightGBM and cuML fall back to the CPU on any GPU error.
#
# | Model | Details |
# |---|---|
# | ridge | median imputation + standardisation + `RidgeCV` (α ∈ 10⁻³…10³, efficient GCV) |
# | random_forest | scikit-learn, 300 trees (60 in the fast profile), `max_features=0.33`, `min_samples_leaf=5`, `max_samples=0.5`; cuML only with `USE_RAPIDS` |
# | lightgbm | v1 parameters (63 leaves, η 0.03), monotone constraints, inner-block early stopping; GPU only if the probe succeeds |
# | xgboost | SPEC §1.4 (depth 6, min_child_weight 20, η 0.03, subsample/colsample 0.8, λ 1), `hist` on `cuda:k`, monotone constraints, inner 10 km early stopping |
# | gnn | v1 pure-PyTorch GraphSAGE (3 layers, 128 hidden) on all 47 features, k = 8 neighbours within the same frame, weighted MSE, early stopping on inner blocks |

# %%
def _s07_take(idx, feat_idx=None):
    """Rows (and optionally a column subset) of the design matrix as a C-contiguous float32 copy."""
    x = _S07_X[idx]
    return np.ascontiguousarray(x if feat_idx is None else x[:, feat_idx])


def _s07_train_medians(idx, feat_idx=None):
    """Training-row medians (0 for all-NaN columns) used for imputation."""
    with _s07_warnings.catch_warnings():
        _s07_warnings.simplefilter("ignore", RuntimeWarning)
        med = np.nanmedian(_s07_take(idx, feat_idx), axis=0)
    return np.where(np.isfinite(med), med, 0.0).astype(np.float32)


def _s07_impute(x, medians):
    return np.where(np.isnan(x), medians, x).astype(np.float32)


def _s07_fit_ridge(ctx, job, gpu_id):
    from sklearn.impute import SimpleImputer
    from sklearn.linear_model import RidgeCV
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import StandardScaler

    tr, te = job["train"], job["test"]
    model = Pipeline([("impute", SimpleImputer(strategy="median", keep_empty_features=True)),
                      ("scale", StandardScaler()), ("reg", RidgeCV(alphas=np.logspace(-3, 3, 13)))])
    with _s07_warnings.catch_warnings():
        _s07_warnings.simplefilter("ignore", UserWarning)
        model.fit(_s07_take(tr, job["feat_idx"]), ctx["y"][tr], reg__sample_weight=ctx["w"][tr])
        pred = model.predict(_s07_take(te, job["feat_idx"]))
    return pred.astype(np.float32), {"device": "cpu", "best_iteration": None,
                                     "alpha": float(model.named_steps["reg"].alpha_)}


def _s07_fit_random_forest(ctx, job, gpu_id):
    """scikit-learn RF (cuML on the GPU only with RAPIDS) on train-median-imputed features."""
    tr, te = job["train"], job["test"]
    capped = tr
    if tr.size > _S07_RF_MAX_ROWS:
        capped = np.sort(np.random.default_rng(CFG.SEED).choice(tr, size=_S07_RF_MAX_ROWS, replace=False))
    medians = _s07_train_medians(capped, job["feat_idx"])
    x_train = _s07_impute(_s07_take(capped, job["feat_idx"]), medians)
    x_test = _s07_impute(_s07_take(te, job["feat_idx"]), medians)
    info = {"best_iteration": None, "rows_used": int(capped.size)}
    if ENV.get("has_cuml"):
        try:
            import cupy as _cp
            from cuml.ensemble import RandomForestRegressor as _CuRF

            with _cp.cuda.Device(gpu_id):
                model = _CuRF(n_estimators=_S07_RF_TREES, max_features=0.33, min_samples_leaf=5, max_samples=0.5,
                              max_depth=32, n_bins=128, n_streams=1, random_state=CFG.SEED)
                model.fit(x_train, ctx["y"][capped])            # cuML RF has no sample weights
                pred = np.asarray(model.predict(x_test), dtype=np.float32)
                del model
                _cp.get_default_memory_pool().free_all_blocks()
            ENV.setdefault("rapids_used", set()).add("cuml_random_forest")
            return pred, {**info, "device": f"cuda:{gpu_id}", "weights": "unweighted (cuML)"}
        except Exception as exc:  # noqa: BLE001 - any cuML failure -> scikit-learn
            log(f"cuML random forest failed on GPU {gpu_id} ({exc!r}); falling back to scikit-learn", "WARNING")
            free_memory()
    from sklearn.ensemble import RandomForestRegressor

    model = RandomForestRegressor(n_estimators=_S07_RF_TREES, max_features=0.33, min_samples_leaf=5, max_samples=0.5,
                                  n_jobs=int(ENV.get("cpu_count") or -1), random_state=CFG.SEED)
    model.fit(x_train, ctx["y"][capped], sample_weight=ctx["w"][capped])
    pred = model.predict(x_test).astype(np.float32)
    del model
    return pred, {**info, "device": "cpu"}


def _s07_resolve_lgbm_device():
    """Probe LightGBM GPU support once per session (tiny fit) and cache the answer in ENV['lgbm_device']."""
    if globals().get("_S07_LGBM_PROBED"):
        return ENV["lgbm_device"]
    device = "cpu"
    if ENV.get("n_gpus", 0) > 0 and "lightgbm" in CFG.BENCHMARKS:
        try:
            import lightgbm as lgb

            rng = np.random.default_rng(0)
            lgb.LGBMRegressor(n_estimators=2, device="gpu", verbose=-1).fit(rng.normal(size=(256, 4)),
                                                                            rng.normal(size=256))
            device = "gpu"
        except Exception as exc:  # noqa: BLE001
            log(f"LightGBM GPU probe failed ({type(exc).__name__}: {str(exc)[:120]}); LightGBM uses the CPU")
    ENV["lgbm_device"] = device
    globals()["_S07_LGBM_PROBED"] = True
    return device


def _s07_lgbm_eval_kwargs(x_val, y_val, w_val):
    """Validation-set keyword arguments: ``eval_X``/``eval_y`` on LightGBM >= 4.6, ``eval_set`` before."""
    import inspect

    import lightgbm as lgb

    params = inspect.signature(lgb.LGBMRegressor.fit).parameters
    if "eval_X" in params:
        return {"eval_X": (x_val,), "eval_y": (y_val,), "eval_sample_weight": [w_val]}
    return {"eval_set": [(x_val, y_val)], "eval_sample_weight": [w_val]}


def _s07_fit_lightgbm(ctx, job, gpu_id):
    import lightgbm as lgb

    fit_idx, val_idx = _s07_inner_split(job["train"])
    feat = job["feat_idx"]
    mono = ctx["mono"] if feat is None else ctx["mono"][feat]
    device = ENV.get("lgbm_device") or "cpu"
    for attempt in ("primary", "cpu_fallback"):
        try:
            params = dict(_S07_LGBM_PARAMS, n_estimators=int(CFG.XGB_MAX_ROUNDS), random_state=int(CFG.SEED),
                          monotone_constraints=[int(v) for v in mono], n_jobs=int(ENV.get("cpu_count") or -1))
            if device == "gpu":
                params.update(device="gpu", gpu_device_id=int(gpu_id), gpu_platform_id=0)
            model = lgb.LGBMRegressor(**params)
            model.fit(_s07_take(fit_idx, feat), ctx["y"][fit_idx], sample_weight=ctx["w"][fit_idx], eval_metric="l2",
                      callbacks=[lgb.early_stopping(int(CFG.XGB_EARLY_STOP), verbose=False)],
                      **_s07_lgbm_eval_kwargs(_s07_take(val_idx, feat), ctx["y"][val_idx], ctx["w"][val_idx]))
            best = int(model.best_iteration_ or model.n_estimators)          # LightGBM counts from 1
            pred = model.predict(_s07_take(job["test"], feat), num_iteration=best).astype(np.float32)
            return pred, {"device": "cpu" if device == "cpu" else f"gpu:{gpu_id}", "best_iteration": best}
        except Exception as exc:  # noqa: BLE001
            if device == "cpu" or attempt == "cpu_fallback":
                raise
            log(f"LightGBM on GPU {gpu_id} failed ({exc!r}); this and all later LightGBM folds use the CPU",
                "WARNING")
            ENV["lgbm_device"] = "cpu"
            free_memory()
            device = "cpu"


def _s07_xgb_train(ctx, fit_idx, val_idx, device, gpu_id, feat_idx=None, rounds=None):
    """Train one XGBoost booster on ``fit_idx`` (early stopping on ``val_idx`` unless ``rounds`` is fixed).

    Data go to the GPU as CuPy arrays when available; returns (booster, best_iteration 0-based).
    """
    import contextlib

    import xgboost as xgb

    mono = ctx["mono"] if feat_idx is None else ctx["mono"][feat_idx]
    params = CFG.xgb_params(device, seed=int(CFG.SEED),
                            monotone_constraints="(" + ",".join(str(int(v)) for v in mono) + ")")
    use_cupy = device.startswith("cuda") and ENV.get("has_cupy")
    if use_cupy:
        import cupy as _cp

        dev_ctx, to_dev = _cp.cuda.Device(gpu_id), _cp.asarray
    else:
        dev_ctx, to_dev = contextlib.nullcontext(), np.asarray
    with dev_ctx:
        dtrain = xgb.QuantileDMatrix(to_dev(_s07_take(fit_idx, feat_idx)), label=to_dev(ctx["y"][fit_idx]),
                                     weight=to_dev(ctx["w"][fit_idx]), max_bin=int(params.get("max_bin", 256)))
        if rounds is None:
            dval = xgb.QuantileDMatrix(to_dev(_s07_take(val_idx, feat_idx)), label=to_dev(ctx["y"][val_idx]),
                                       weight=to_dev(ctx["w"][val_idx]), ref=dtrain)
            booster = xgb.train(params, dtrain, num_boost_round=int(CFG.XGB_MAX_ROUNDS), evals=[(dval, "val")],
                                early_stopping_rounds=int(CFG.XGB_EARLY_STOP), verbose_eval=False)
            best = int(getattr(booster, "best_iteration", booster.num_boosted_rounds() - 1))
            del dval
        else:
            booster = xgb.train(params, dtrain, num_boost_round=int(rounds), verbose_eval=False)
            best = int(rounds) - 1
        del dtrain
    return booster, best


def _s07_xgb_predict(booster, x, best, device, gpu_id):
    """Predict with the first ``best + 1`` rounds; on the GPU through CuPy when available, else on the host."""
    if device.startswith("cuda") and ENV.get("has_cupy"):
        import cupy as _cp

        with _cp.cuda.Device(gpu_id):
            pred = _cp.asnumpy(booster.inplace_predict(_cp.asarray(x), iteration_range=(0, best + 1)))
            _cp.get_default_memory_pool().free_all_blocks()
        return np.asarray(pred, np.float32)
    booster.set_param({"device": "cpu"})          # host data -> host prediction (no device-mismatch copies)
    return np.asarray(booster.inplace_predict(x, iteration_range=(0, best + 1)), np.float32)


def _s07_fit_xgboost(ctx, job, gpu_id):
    """Inner-block early stopping (or fixed rounds); CUDA out-of-memory -> retry the fold on the CPU."""
    feat = job["feat_idx"]
    fit_idx, val_idx = (job["train"], None) if job.get("rounds") else _s07_inner_split(job["train"])
    device = xgb_device_for(gpu_id)
    for attempt in ("primary", "cpu_fallback"):
        try:
            booster, best = _s07_xgb_train(ctx, fit_idx, val_idx, device, gpu_id, feat, job.get("rounds"))
            pred = _s07_xgb_predict(booster, _s07_take(job["test"], feat), best, device, gpu_id)
            del booster
            return pred, {"device": device, "best_iteration": best}
        except Exception as exc:  # noqa: BLE001
            if device == "cpu" or attempt == "cpu_fallback" or not is_gpu_oom_error(exc):
                raise
            log(f"XGBoost out of GPU memory on {device}; retrying fold on CPU", "WARNING")
            free_memory()
            device = "cpu"


# %% [markdown]
# ### 7.2.1 Spatial GraphSAGE (pure PyTorch, ported from v1)
# Nodes are **all ROI cells of the mode's training frames** (features are known everywhere); edges connect each
# cell to its k = 8 nearest cells within the same frame (block-diagonal across frames, row-normalised so $A h$ is
# the neighbour mean). Each layer is $h' = \mathrm{LayerNorm}(\mathrm{GELU}(W_s h + W_n A h)) + h$ with dropout 0.1;
# three layers reach 3 cells. Training is transductive and full batch: the loss uses only the fitting rows' labels
# (weighted MSE), early stopping the inner 10 km validation blocks, and test labels are never touched.

# %%
def _s07_knn_indices(xy, k):
    """(n, k_eff) indices of the k nearest *other* points (exact cKDTree in float64)."""
    n = xy.shape[0]
    k_eff = min(int(k), n - 1)
    if k_eff < 1:
        return None
    _, idx = _s07_cKDTree(np.asarray(xy, dtype=np.float64)).query(xy, k=k_eff + 1)
    idx = np.asarray(idx, dtype=np.int64)
    self_first = idx[:, :1] == np.arange(n)[:, None]
    return np.where(self_first, idx[:, 1:], idx[:, :-1])


def _s07_gnn_graph(ctx, k=8):
    """Node set (DF rows of the mode's training frames), DF→node map and directed kNN edges (cached in ctx)."""
    if ctx.get("gnn") is not None:
        return ctx["gnn"]
    X, Y = GRID.cell_centers_xy()
    cell_xy = np.column_stack([np.asarray(X)[CELL_ROWS, CELL_COLS], np.asarray(Y)[CELL_ROWS, CELL_COLS]])
    neigh = _s07_knn_indices(cell_xy, k)
    n_cells = int(N_CELLS)
    nodes, src, dst = [], [], []
    for i, year in enumerate(ctx["frames"]):
        j = _S07_FRAMES_DF.index(year)
        nodes.append(np.arange(j * n_cells, (j + 1) * n_cells, dtype=np.int64))
        if neigh is not None:
            src.append(i * n_cells + np.repeat(np.arange(n_cells, dtype=np.int64), neigh.shape[1]))
            dst.append(i * n_cells + neigh.ravel())
    nodes = np.concatenate(nodes)
    assert np.all(_S07_YEAR[nodes] == np.repeat(ctx["frames"], n_cells)), "DF frame blocks out of order"
    df_to_node = np.full(_S07_N, -1, dtype=np.int64)
    df_to_node[nodes] = np.arange(nodes.size)
    ctx["gnn"] = {"nodes": nodes, "df_to_node": df_to_node,
                  "src": np.concatenate(src) if src else np.zeros(0, np.int64),
                  "dst": np.concatenate(dst) if dst else np.zeros(0, np.int64)}
    return ctx["gnn"]


def _s07_build_sage(n_in, hidden=128, n_layers=3, dropout=0.1):
    """GraphSAGE network (torch imported lazily so the notebook runs without it)."""
    import torch
    from torch import nn

    class _SageLayer(nn.Module):
        def __init__(self):
            super().__init__()
            self.w_self = nn.Linear(hidden, hidden)
            self.w_neigh = nn.Linear(hidden, hidden, bias=False)
            self.norm = nn.LayerNorm(hidden)
            self.drop = nn.Dropout(dropout)

        def forward(self, h, adj):
            agg = torch.sparse.mm(adj, h)
            return self.drop(self.norm(nn.functional.gelu(self.w_self(h) + self.w_neigh(agg)))) + h

    class SpatialSAGE(nn.Module):
        def __init__(self):
            super().__init__()
            self.inp = nn.Linear(n_in, hidden)
            self.layers = nn.ModuleList([_SageLayer() for _ in range(n_layers)])
            self.head = nn.Sequential(nn.Linear(hidden, hidden // 2), nn.GELU(), nn.Linear(hidden // 2, 1))

        def forward(self, x, adj):
            h = self.inp(x)
            for layer in self.layers:
                h = layer(h, adj)
            return self.head(h).squeeze(-1)

    return SpatialSAGE()


def _s07_torch_cuda_count():
    try:
        import torch

        return torch.cuda.device_count() if torch.cuda.is_available() else 0
    except Exception:  # noqa: BLE001
        return 0


def _s07_gnn_train(ctx, job, device):
    """Full-batch transductive GraphSAGE fit on ``device``; returns (test predictions, best epoch)."""
    import torch

    graph = _s07_gnn_graph(ctx)
    nodes, d2n = graph["nodes"], graph["df_to_node"]
    tr, te = job["train"], job["test"]
    fit_idx, val_idx = _s07_inner_split(tr)
    fit_n, val_n, test_n = d2n[fit_idx], d2n[val_idx], d2n[te]
    if min(fit_n.min(), val_n.min(), test_n.min()) < 0:
        raise RuntimeError("GNN: a fold row is not a graph node")
    medians = _s07_train_medians(tr)
    x = _s07_impute(_S07_X[nodes], medians)
    tr_n = d2n[tr]
    mu, sd = x[tr_n].mean(axis=0), x[tr_n].std(axis=0)
    x = ((x - mu) / np.where(sd > 0, sd, 1.0)).astype(np.float32)
    y_fit = ctx["y"][fit_idx].astype(np.float64)
    y_mu, y_sd = float(y_fit.mean()), float(y_fit.std() or 1.0)
    y_nodes = np.nan_to_num((ctx["y"][nodes] - y_mu) / y_sd, nan=0.0).astype(np.float32)
    w_nodes = ctx["w"][nodes].astype(np.float32)

    n_nodes = nodes.size
    deg = np.bincount(graph["src"], minlength=n_nodes).astype(np.float32)
    weights = 1.0 / np.maximum(deg[graph["src"]], 1.0)
    dev = torch.device(device)
    adj = torch.sparse_coo_tensor(torch.from_numpy(np.vstack([graph["src"], graph["dst"]])),
                                  torch.from_numpy(weights.astype(np.float32)), (n_nodes, n_nodes)).coalesce().to(dev)
    if dev.type == "cpu":  # CSR SpMM is ~2x faster than COO on the CPU
        with _s07_warnings.catch_warnings():
            _s07_warnings.simplefilter("ignore", UserWarning)
            adj = adj.to_sparse_csr()
    x_t = torch.from_numpy(x).to(dev)
    y_t = torch.from_numpy(y_nodes).to(dev)
    w_t = torch.from_numpy(w_nodes).to(dev)
    fit_t, val_t = torch.from_numpy(fit_n).to(dev), torch.from_numpy(val_n).to(dev)
    with _S07_TORCH_LOCK:   # deterministic initialisation even when two folds start concurrently
        torch.manual_seed(int(CFG.SEED))
        if dev.type == "cuda":
            with torch.cuda.device(dev):
                torch.cuda.manual_seed(int(CFG.SEED))
        model = _s07_build_sage(x.shape[1]).to(dev)

    def wmse(pred, idx, target=y_t, weight=w_t):
        ww = weight[idx]
        return (ww * (pred[idx] - target[idx]) ** 2).sum() / ww.sum()

    opt = torch.optim.AdamW(model.parameters(), lr=3e-3, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.ReduceLROnPlateau(opt, mode="min", factor=0.5, patience=10, min_lr=1e-5)
    best_loss, best_epoch, best_state, stale = np.inf, 0, None, 0
    max_epochs, t_start, epoch = int(CFG.GNN_EPOCHS), _s07_time.time(), 0
    while epoch < max_epochs:
        model.train()
        opt.zero_grad(set_to_none=True)
        loss = wmse(model(x_t, adj), fit_t)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        model.eval()
        with torch.no_grad():
            val_loss = float(wmse(model(x_t, adj), val_t))
        sched.step(val_loss)
        if val_loss < best_loss - 1e-6:
            best_loss, best_epoch, stale = val_loss, epoch, 0
            best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
        else:
            stale += 1
            if stale >= 30:
                break
        if epoch == 1 and dev.type == "cpu":
            per_epoch = (_s07_time.time() - t_start) / 2.0
            affordable = max(10, int(_s07_gnn_cpu_budget() / max(per_epoch, 1e-6)))
            if affordable < max_epochs:
                log(f"GNN on CPU: {per_epoch:.2f} s/epoch -> this fold capped at {affordable} of {max_epochs} epochs "
                    f"({_s07_gnn_cpu_budget():.0f} s budget, LST_GNN_CPU_BUDGET_S)", "WARNING")
                max_epochs = affordable
        epoch += 1
    if best_state is not None:
        model.load_state_dict(best_state)
    model.eval()
    with torch.no_grad():
        pred = model(x_t, adj)[torch.from_numpy(test_n).to(dev)].float().cpu().numpy()
    del model, opt, adj, x_t, y_t, w_t, best_state
    return (pred * y_sd + y_mu).astype(np.float32), int(best_epoch)


def _s07_gnn_cpu_budget():
    """Per-fold CPU budget in seconds (read at call time so it can be changed between runs)."""
    return float(_s07_os.environ.get("LST_GNN_CPU_BUDGET_S", _S07_GNN_CPU_BUDGET_S))


def _s07_fit_gnn(ctx, job, gpu_id):
    """GraphSAGE fold on ``cuda:<gpu_id>`` (or the CPU); CUDA OOM -> CPU retry; CUDA cache emptied afterwards."""
    import torch

    n_cuda = _s07_torch_cuda_count()
    device = f"cuda:{min(int(gpu_id), n_cuda - 1)}" if n_cuda else "cpu"
    try:
        pred, best = _s07_gnn_train(ctx, job, device)
    except Exception as exc:  # noqa: BLE001
        if device == "cpu" or not is_gpu_oom_error(exc):
            raise
        log(f"GNN out of memory on {device}; retrying fold on CPU", "WARNING")
        torch.cuda.empty_cache()
        free_memory()
        device = "cpu"
        pred, best = _s07_gnn_train(ctx, job, device)
    finally:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    return pred, {"device": device, "best_iteration": best}


_S07_FITTERS = {"ridge": _s07_fit_ridge, "random_forest": _s07_fit_random_forest, "lightgbm": _s07_fit_lightgbm,
                "xgboost": _s07_fit_xgboost, "gnn": _s07_fit_gnn}


def _s07_model_available(model):
    """Skip models whose library is missing or broken (with a warning) instead of failing the run.

    Uses section 00's optional imports (``torch``, ``xgb``, ``lgb``), where ANY import failure counts as missing -
    e.g. a PyTorch DLL / CUDA initialisation error (``OSError``), not only ``ImportError`` - so a broken optional
    library never stops the pipeline: the GNN is a benchmark only.
    """
    preloaded = {"gnn": ("torch", globals().get("torch")), "xgboost": ("xgboost", globals().get("xgb")),
                 "lightgbm": ("lightgbm", globals().get("lgb"))}
    if model in preloaded:
        name, mod = preloaded[model]
        if mod is None:
            log(f"{name} is not available (missing or failed to import, see section 0.2) - model '{model}' "
                "skipped", "WARNING")
            return False
        return True
    try:
        __import__("sklearn")
        return True
    except Exception as exc:  # noqa: BLE001 - optional dependency, any failure means "unavailable"
        log(f"scikit-learn is not available ({type(exc).__name__}: {str(exc)[:160]}) - model '{model}' skipped",
            "WARNING")
        return False


# %% [markdown]
# ## 7.3 Job scheduler (GPU lane, CPU lane, LightGBM-GPU lane; per-job stage cache)
# A job is one (model, training rows, test rows, feature subset) fit. Its identity is a hash of exactly these inputs
# plus the model configuration, so two schemes asking for the same fit share one job and its cache entry.
#
# | Lane | Jobs | Runs on |
# |---|---|---|
# | `gpu` | XGBoost (CUDA), GraphSAGE, cuML RF | `gpu_pool_map`: one worker per GPU, each GPU one job at a time |
# | `cpu` | ridge, scikit-learn RF, LightGBM when its GPU probe failed | thread `s07-cpu-lane`, serial |
# | `lgbm` | LightGBM when `ENV["lgbm_device"] == "gpu"` | thread `s07-lgbm-lane`, serial, on GPU `n_gpus − 1` |
#
# The LightGBM lane is serial because LightGBM's OpenCL learner is not thread safe (never two boosters at once).
# XGBoost, LightGBM, scikit-learn trees and PyTorch release the GIL inside their native code, so the lanes overlap
# for real; all lanes join at the mode barrier. A failing job is logged with its traceback and leaves NaN
# predictions; it never stops the suite. **Time budget:** before every job a lane asks `budget_exhausted(1.25 ×
# the longest job seen in that lane)` (section 00); on exhaustion it stops scheduling and sets a shared stop event,
# the other lanes stop too, and after the barrier `check_budget("07 jobs")` raises `LSTStop` — a mode is never
# published with partial CV results (the finished jobs are cached and a resumed run continues from them). The busy
# seconds and job counts per lane are logged after each mode (`MODEL_RESULTS[m]["lane_busy_seconds"]`).

# %%
_S07_MODEL_CFG = {
    "xgboost": lambda: {"params": CFG.XGB_PARAMS, "max_rounds": CFG.XGB_MAX_ROUNDS, "es": CFG.XGB_EARLY_STOP},
    "lightgbm": lambda: {"params": _S07_LGBM_PARAMS, "max_rounds": CFG.XGB_MAX_ROUNDS, "es": CFG.XGB_EARLY_STOP},
    "random_forest": lambda: {"trees": _S07_RF_TREES, "max_rows": _S07_RF_MAX_ROWS},
    "ridge": lambda: {"alphas": [-3, 3, 13]},
    "gnn": lambda: {"epochs": CFG.GNN_EPOCHS, "hidden": 128, "layers": 3, "k": 8},
}
_S07_COST = {"ridge": 0.05, "random_forest": 1.5, "lightgbm": 1.0, "xgboost": 1.0, "gnn": 2.5}


def _s07_lane(model):
    """'gpu' (gpu_pool_map), 'lgbm' (serial LightGBM-GPU lane) or 'cpu' for a model in this session."""
    if model == "xgboost":
        return "gpu" if ENV.get("xgb_device") == "cuda" else "cpu"
    if model == "gnn":
        return "gpu" if _s07_torch_cuda_count() > 0 else "cpu"
    if model == "random_forest":
        return "gpu" if ENV.get("has_cuml") else "cpu"
    if model == "lightgbm":
        return "lgbm" if ENV.get("lgbm_device") == "gpu" and int(ENV.get("n_gpus", 0) or 0) >= 1 else "cpu"
    return "cpu"


def _s07_budget_exhausted(expected_s):
    """Section-00 time-budget check (D3) through a defensive lookup; False when the helper is absent."""
    fn = globals().get("budget_exhausted")
    return bool(fn is not None and fn(float(expected_s)))


def _s07_make_job(ctx, label, model, fold, feat="all", rounds=None):
    """Job dict for one fit; ``ident`` de-duplicates identical fits across schemes."""
    feat_idx = None if feat == "all" else _S07_BASE_IDX
    ident = _s07_hash(_S07_JOB_VERSION, ctx["mode"], model, feat, rounds, _S07_MODEL_CFG[model](), fold["train"],
                      fold["test"])
    return {"ident": ident, "mode": ctx["mode"], "model": model, "label": label, "fold": int(fold["fold"]),
            "train": fold["train"], "test": fold["test"], "feat": feat, "feat_idx": feat_idx, "rounds": rounds,
            "cost": float(fold["train"].size) * _S07_COST[model]}


def _s07_execute(job, gpu_id):
    """Run (or load from the stage cache) one job; never raises - failures are returned as ``{"error": ...}``."""
    ctx = _S07_CTX[job["mode"]]
    sc = stage_cache(f"07_job_{job['mode']}_{job['model']}",
                     CFG.key(version=_S07_JOB_VERSION, ident=job["ident"], df=_S07_DF_FP))
    if sc.hit:
        try:
            res = sc.load()
            res["cached"] = True
            return res
        except StageCacheError as exc:
            log(f"{exc}; refitting", "WARNING")
    t0 = _s07_time.perf_counter()
    try:
        pred, info = _S07_FITTERS[job["model"]](ctx, job, gpu_id)
        pred = np.asarray(pred, np.float32).ravel()
        if pred.shape != job["test"].shape or not np.all(np.isfinite(pred)):
            raise ValueError(f"invalid predictions (shape {pred.shape}, finite {np.isfinite(pred).mean():.3f})")
    except Exception:  # noqa: BLE001 - one failing fold must not stop the suite
        return {"error": _s07_traceback.format_exc()}
    res = {"pred": pred, "info": info, "seconds": round(_s07_time.perf_counter() - t0, 2),
           "n_train": int(job["train"].size), "n_test": int(job["test"].size)}
    met = _s07_wmetrics(ctx["y"][job["test"]], pred, ctx["w"][job["test"]])
    with _S07_PRINT_LOCK:
        log(f"07 {job['mode']:<5} {job['label']:<14} {job['model']:<13} fold {job['fold']:>4}: R2 {met['r2']:.3f} "
            f"RMSE {met['rmse']:.3f} | {res['seconds']:.1f}s on {info.get('device')} (n_train {res['n_train']:,})")
    sc.save(res)
    res["cached"] = False
    return res


def _s07_run_jobs(jobs, mode=""):
    """Run unique jobs on the GPU lane, the CPU lane and the LightGBM-GPU lane concurrently (D20).

    Returns ({ident: result}, busy seconds per lane, job counts per lane). Raises ``LSTStop`` (via
    ``check_budget``) when a lane stopped on the time budget, and re-raises any BaseException of a lane after all
    lane threads have joined - never a partial result set.
    """
    unique = {}
    for job in jobs:
        unique.setdefault(job["ident"], job)
    lanes = {name: sorted((j for j in unique.values() if _s07_lane(j["model"]) == name), key=lambda j: -j["cost"])
             for name in ("gpu", "cpu", "lgbm")}
    results = {}
    busy = {"gpu": 0.0, "cpu": 0.0, "lgbm": 0.0}
    counts = {"gpu": 0, "cpu": 0, "lgbm": 0}
    longest = {"gpu": 0.0, "cpu": 0.0, "lgbm": 0.0}
    lock = _s07_threading.Lock()
    stop = _s07_threading.Event()
    stop_info = {"reason": None, "expected_s": 0.0, "errors": []}
    lgbm_gpu = max(int(ENV.get("n_gpus", 0) or 0) - 1, 0)
    log(f"07: {len(jobs)} fits requested -> {len(unique)} unique jobs ({len(lanes['gpu'])} GPU lane, "
        f"{len(lanes['cpu'])} CPU lane, {len(lanes['lgbm'])} LightGBM-GPU lane"
        + (f" on GPU {lgbm_gpu}" if lanes["lgbm"] else "") + ")")

    def record(lane, job, res):
        with lock:
            results[job["ident"]] = res
            counts[lane] += 1
            if not res.get("cached") and "seconds" in res:
                busy[lane] += float(res["seconds"])
                longest[lane] = max(longest[lane], float(res["seconds"]))

    def may_start(lane):
        """False once the run is stopping or the next job would not fit into the time budget."""
        if stop.is_set():
            return False
        with lock:
            expected = 1.25 * longest[lane]
        if _s07_budget_exhausted(expected):
            with lock:
                if stop_info["reason"] is None:
                    stop_info["reason"] = f"time budget reached in the 07 {lane} lane ({mode})"
                stop_info["expected_s"] = max(stop_info["expected_s"], expected)
            stop.set()
            return False
        return True

    def serial_lane(lane, gpu_id):
        try:
            for job in lanes[lane]:
                if not may_start(lane):
                    break
                record(lane, job, _s07_execute(job, gpu_id))
        except BaseException as exc:  # noqa: BLE001 - recorded and re-raised by the main thread after the barrier
            with lock:
                stop_info["errors"].append(exc)
            stop.set()

    def gpu_item(job, gpu_id):
        if not may_start("gpu"):
            return {"error": "not run: the 07 lanes are stopping", "skipped": True}
        return _s07_execute(job, gpu_id)

    threads = []
    for lane, gpu_id in (("cpu", 0), ("lgbm", lgbm_gpu)):
        if lanes[lane]:
            t = _s07_threading.Thread(target=serial_lane, args=(lane, gpu_id), name=f"s07-{lane}-lane", daemon=True)
            t.start()
            threads.append(t)
    try:
        if lanes["gpu"]:
            for job, res in zip(lanes["gpu"], gpu_pool_map(gpu_item, lanes["gpu"])):
                if not res.get("skipped"):
                    record("gpu", job, res)
    except BaseException:
        stop.set()                      # the serial lanes finish their current job and stop
        for t in threads:
            t.join()
        raise
    for t in threads:
        t.join()                        # mode barrier
    if stop.is_set():
        if stop_info["errors"]:
            raise stop_info["errors"][0]
        check = globals().get("check_budget")
        if check is not None:
            check(f"07 jobs ({mode})", stop_info["expected_s"])
        raise RuntimeError(f"07: job lanes stopped ({stop_info['reason']}) - no partial results are published")
    for ident in unique:
        results.setdefault(ident, {"error": "job did not run (lane thread terminated)"})
    log(f"07: {mode} lane busy seconds (GPU summed over devices) "
        + ", ".join(f"{k} {busy[k]:.1f}s / {counts[k]} jobs" for k in ("gpu", "cpu", "lgbm")))
    return results, busy, counts


# %% [markdown]
# ## 7.4 Collecting a scheme: OOF arrays, recentring, pooled and per-fold metrics
# * **LOEO** — the predicted anomaly map of the held-out frame is recentred to zero mean over that frame's fixed-mask
#   rows; raw and recentred metrics are both kept (`oof["loeo_raw"]`, `oof["loeo"]`).
# * **place_time** — every fold predicts one block group of the last frame; the pooled OOF map of the last frame is
#   complete, and it is recentred once over its fixed-mask rows (predictions only).

# %%
def _s07_collect(ctx, scheme, models, folds, jobs_by_key, results):
    """OOF arrays {model: float32[N_DF]}, fold-metric rows and info lists for one scheme."""
    oof, raw_oof, rows, infos = {}, {}, [], {}
    for model in models:
        oof[model] = np.full(_S07_N, np.nan, dtype=np.float32)
        raw = np.full(_S07_N, np.nan, dtype=np.float32)
        infos[model] = []
        per_fold = []
        for fold in folds:
            job = jobs_by_key[(scheme, model, fold["fold"])]
            res = results[job["ident"]]
            if "error" in res:
                log(f"07 {ctx['mode']} {scheme}/{model} fold {fold['fold']} FAILED:\n{res['error']}", "ERROR")
                continue
            te = fold["test"]
            raw[te] = res["pred"]
            infos[model].append({"fold": fold["fold"], **res["info"]})
            per_fold.append((fold, res))
        if scheme == "loeo":
            for fold, _ in per_fold:
                te = fold["test"]
                sel = te[ctx["fixed_row"][te]]
                offset = float(np.mean(raw[sel])) if sel.size else float(np.mean(raw[te]))
                oof[model][te] = raw[te] - offset
        elif scheme == "place_time":
            done = np.flatnonzero(np.isfinite(raw))
            sel = done[ctx["fixed_row"][done]]
            offset = float(np.mean(raw[sel])) if sel.size else (float(np.mean(raw[done])) if done.size else 0.0)
            oof[model] = np.where(np.isfinite(raw), raw - offset, np.nan).astype(np.float32)
        else:
            oof[model] = raw
        raw_oof[model] = raw
        for fold, res in per_fold:
            te = fold["test"]
            met = _s07_wmetrics(ctx["y"][te], oof[model][te], ctx["w"][te])
            rows.append({"scheme": scheme, "model": model, "fold": int(fold["fold"]), "r2": met["r2"],
                         "rmse": met["rmse"], "mae": met["mae"], "bias": met["bias"],
                         "n_train": int(fold["train"].size),
                         "n_test": int(te.size), "fit_seconds": float(res["seconds"]),
                         "device": str(res["info"].get("device"))})
    return oof, raw_oof, rows, infos


def _s07_summary_row(ctx, scheme, model, pred, fold_rows):
    """One cv_summary row: pooled weighted metrics over all OOF rows + per-fold spread."""
    ok = np.flatnonzero(np.isfinite(pred))
    met = _s07_wmetrics(ctx["y"][ok], pred[ok], ctx["w"][ok])
    sub = [r for r in fold_rows if r["scheme"] == scheme and r["model"] == model]
    r2s = np.array([r["r2"] for r in sub], float)
    rmses = np.array([r["rmse"] for r in sub], float)
    sd = lambda a: float(np.nanstd(a, ddof=1)) if np.isfinite(a).sum() > 1 else 0.0  # noqa: E731
    return {"scheme": scheme, "model": model, "r2_pooled": met["r2"], "rmse_pooled": met["rmse"],
            "mae_pooled": met["mae"], "r2_fold_mean": float(np.nanmean(r2s)) if r2s.size else np.nan,
            "r2_fold_sd": sd(r2s), "rmse_fold_mean": float(np.nanmean(rmses)) if rmses.size else np.nan,
            "rmse_fold_sd": sd(rmses), "n_folds": int(len(sub)), "n": int(met["n"])}


# %% [markdown]
# ## 7.5 Spatial diagnostics: error vs distance, Moran's I, fold geometry
# * **Error vs distance** — for every block20 OOF row, the distance (km) to the nearest *training* cell of the same
#   frame in its fold's training set; pooled weighted RMSE in distance bins shows how skill decays with distance
#   from the data (the honest replacement for a single "map accuracy" number, Wadoux et al. 2021).
# * **Moran's I** of block20 OOF residuals per frame (KNN, k = `CFG.MORAN_K`, row-standardised, permutation
#   inference: PySAL's `p_sim`/`z_sim`; `esda` when installed, else the vectorised NumPy fallback of v1).
#   $I = \frac{n}{S_0}\frac{\sum_{ij} w_{ij} z_i z_j}{\sum_i z_i^2}$; residual structure means spatially structured
#   drivers are still missing and naive standard errors would be too small.

# %%
def _s07_error_vs_distance(ctx, folds, oof):
    """[{lo, hi, rmse, n}] of block20 OOF residuals by distance to the nearest same-frame training cell."""
    dist = np.full(_S07_N, np.nan)
    for fold in folds:
        te, tr = fold["test"], fold["train"]
        for year in np.unique(_S07_YEAR[te]):
            te_y, tr_y = te[_S07_YEAR[te] == year], tr[_S07_YEAR[tr] == year]
            if tr_y.size == 0:
                continue
            d, _ = _s07_cKDTree(_S07_XY[tr_y]).query(_S07_XY[te_y], k=1)
            dist[te_y] = d / 1000.0
    out = []
    ok = np.isfinite(oof) & np.isfinite(dist)
    for lo, hi in zip(_S07_DIST_BINS[:-1], _S07_DIST_BINS[1:]):
        sel = ok & (dist >= lo) & (dist < hi)
        met = _s07_wmetrics(ctx["y"][sel], oof[sel], ctx["w"][sel]) if sel.sum() >= 2 else {"rmse": np.nan}
        out.append({"lo": lo, "hi": None if not np.isfinite(hi) else hi, "rmse": met["rmse"], "n": int(sel.sum())})
    return out, dist


def _s07_knn_weights(xy, k):
    """Row-standardised KNN weights (csr, n x n) over the given coordinates."""
    n = xy.shape[0]
    neigh = _s07_knn_indices(xy, k)
    if neigh is None:
        return _s07_sparse.csr_matrix((n, n), dtype=np.float64)
    k_eff = neigh.shape[1]
    rows = np.repeat(np.arange(n), k_eff)
    return _s07_sparse.csr_matrix((np.full(rows.size, 1.0 / k_eff), (rows, neigh.ravel())), shape=(n, n))


def _s07_moran_numpy(y, W, permutations, seed):
    """Moran's I with permutation inference, vectorised in batches of permutations (NumPy/SciPy)."""
    n = y.size
    z = y - y.mean()
    z2 = float(z @ z)
    s0 = float(W.sum())
    if z2 == 0 or s0 == 0:
        return {"I": np.nan, "expected_I": -1.0 / (n - 1), "z": np.nan, "p": np.nan}
    scale = n / s0 / z2
    moran = scale * float(z @ (W @ z))
    out = {"I": moran, "expected_I": -1.0 / (n - 1), "z": np.nan, "p": np.nan}
    if permutations:
        rng = np.random.default_rng(seed)
        batch = max(1, min(int(permutations), 4_000_000 // max(n, 1)))
        sims = []
        for start in range(0, int(permutations), batch):
            perm = np.tile(z, (min(batch, int(permutations) - start), 1))
            rng.permuted(perm, axis=1, out=perm)
            lag = (W @ perm.T).T
            sims.append(scale * np.einsum("bi,bi->b", perm, lag))
        sims = np.concatenate(sims)
        larger = int((sims >= moran).sum())
        larger = min(larger, int(permutations) - larger)
        sd = sims.std()
        out["p"] = (larger + 1.0) / (permutations + 1.0)
        out["z"] = (moran - sims.mean()) / sd if sd > 0 else np.nan
    return out


def _s07_morans_i(values, W, permutations=None):
    """Global Moran's I (``{"I", "expected_I", "z", "p", "backend"}``), esda when installed, else NumPy."""
    y = np.asarray(values, dtype=np.float64).ravel()
    perms = int(CFG.MORAN_PERMS if permutations is None else permutations)
    if y.size < 3 or not np.all(np.isfinite(y)):
        return {"I": np.nan, "expected_I": np.nan, "z": np.nan, "p": np.nan, "backend": "none"}
    try:
        import esda
        from libpysal.weights import W as _PysalW

        state = np.random.get_state()
        np.random.seed(int(CFG.SEED))   # esda permutes with the global NumPy RNG
        try:
            with _s07_warnings.catch_warnings():
                _s07_warnings.simplefilter("ignore")
                mi = esda.Moran(y, _PysalW.from_sparse(_s07_sparse.csr_matrix(W)), transformation="r",
                                permutations=perms)
        finally:
            np.random.set_state(state)
        z, p = (mi.z_sim, mi.p_sim) if perms else (mi.z_norm, mi.p_norm)
        return {"I": float(mi.I), "expected_I": float(mi.EI), "z": float(z), "p": float(p), "backend": "esda"}
    except ImportError:
        res = _s07_moran_numpy(y, W, perms, int(CFG.SEED))
        res["backend"] = "numpy"
        return {k: (float(v) if k != "backend" else v) for k, v in res.items()}


def _s07_moran_tables(ctx, oof_block20):
    """Moran's I of the target and of block20 OOF residuals (xgboost, gnn, ridge) per frame + scatter data."""
    models = [m for m in ("xgboost", "gnn", "ridge") if m in oof_block20]
    res_rows, tgt_rows, scatter = [], [], {}
    tr = ctx["train"]
    rng = np.random.default_rng(CFG.SEED)
    last = ctx["frames"][-1] if ctx["frames"] else None
    for year in ctx["frames"]:
        rows = tr[_S07_YEAR[tr] == year]
        if rows.size < max(10, int(CFG.MORAN_K) + 2):
            continue
        W = _s07_knn_weights(_S07_XY[rows], int(CFG.MORAN_K))
        r = _s07_morans_i(ctx["y"][rows], W)
        tgt_rows.append({"year": int(year), **{k: r[k] for k in ("I", "expected_I", "z", "p")}})
        for model in models:
            pred = oof_block20[model][rows]
            ok = np.isfinite(pred)
            if ok.sum() < max(10, int(CFG.MORAN_K) + 2):
                continue
            resid = ctx["y"][rows].astype(np.float64) - pred.astype(np.float64)
            Wm = W if ok.all() else _s07_knn_weights(_S07_XY[rows[ok]], int(CFG.MORAN_K))
            m_res = _s07_morans_i(resid[ok], Wm)
            res_rows.append({"scheme": "block20", "model": model, "year": int(year),
                             **{k: m_res[k] for k in ("I", "expected_I", "z", "p")}})
            if year == last and ok.all():
                sd = resid.std()
                if sd > 0:
                    zz = (resid - resid.mean()) / sd
                    lag = np.asarray(W @ zz)
                    pick = np.sort(rng.choice(zz.size, size=min(2000, zz.size), replace=False))
                    scatter[model] = {"year": int(year), "z": zz[pick].round(4).tolist(),
                                      "lag": lag[pick].round(4).tolist(), "slope": float(m_res["I"])}
    moran = pd.DataFrame(res_rows, columns=["scheme", "model", "year", "I", "expected_I", "z", "p"])
    moran_target = pd.DataFrame(tgt_rows, columns=["year", "I", "expected_I", "z", "p"])
    head = scatter.get("xgboost") or (next(iter(scatter.values())) if scatter else {})
    moran_scatter = {"model": "xgboost" if "xgboost" in scatter else (next(iter(scatter)) if scatter else None),
                     **head, "by_model": scatter}
    return moran, moran_target, moran_scatter


def _s07_fold_geometry(ctx, oof):
    """Fold map payload: block → fold and pooled block RMSE (row-major blocks from the grid's top-left)."""
    out = {}
    h, w = GRID.height, GRID.width
    cell_rows, cell_cols = _S07_ROW, _S07_COL
    for scheme in ("block20", "block5"):
        if scheme == "block20":
            b = max(1, int(round(float(CFG.BLOCK_KM) * 1000.0 / float(GRID.res))))
            n_r, n_c = _s07_math.ceil(h / b), _s07_math.ceil(w / b)
            block = (cell_rows // b) * n_c + cell_cols // b
            fold_col = DF["fold_block20"].to_numpy(np.int64)
            meta = {"block_km": float(CFG.BLOCK_KM), "block_cells": b, "kind": "square"}
        else:
            nby, nbx = (int(v) for v in CFG.SPATIAL_BLOCKS)
            n_r, n_c = nby, nbx
            block = (cell_rows * nby // h) * nbx + cell_cols * nbx // w
            fold_col = DF["fold_block5"].to_numpy(np.int64)
            meta = {"block_km": round(float(np.sqrt((h / nby) * (w / nbx))) * GRID.res / 1000.0, 1),
                    "tile_km": [round(h / nby * GRID.res / 1000.0, 1), round(w / nbx * GRID.res / 1000.0, 1)],
                    "kind": "tiles", "rule": "tile = (row*5//H)*5 + col*5//W"}
        n_blocks = n_r * n_c
        fold_of_block = np.full(n_blocks, -1, dtype=np.int64)
        fold_of_block[block] = fold_col                       # one fold per block (asserted in section 06)
        rmse = [None] * n_blocks
        pred = oof.get(scheme, {}).get("xgboost")
        if pred is not None:
            ok = np.isfinite(pred) & (ctx["w"] > 0)
            r2w = np.bincount(block[ok], weights=ctx["w"][ok] * (ctx["y"][ok] - pred[ok]) ** 2, minlength=n_blocks)
            sw = np.bincount(block[ok], weights=ctx["w"][ok], minlength=n_blocks)
            rmse = [float(np.sqrt(a / s)) if s > 0 else None for a, s in zip(r2w, sw)]
        out[scheme] = {**meta, "n_rows": int(n_r), "n_cols": int(n_c), "fold_of_block": fold_of_block.tolist(),
                       "rmse_of_block": rmse}
    return out


# %% [markdown]
# ## 7.6 Final model, persistent residual and area of applicability
# **Final model.** XGBoost on *all* training rows of the mode, `round(1.1 × median best rounds of block20)` rounds
# (the 10 % accounts for the larger training set; no early stopping, no hold-out). It is stored with
# `device="cpu"` so `PREDICT_ANOM` works anywhere; section 08 may switch it to `cuda` for TreeSHAP.
#
# **Persistent residual (SPEC §4.5, time transfer only).** About half of the remaining error is a per-cell offset
# that repeats every frame (soil, irrigation practice, emissivity — drivers the features miss). With the recentred
# LOEO residuals $\rho(i,s)$, the shrunken mean residual of the *other* frames
# $\bar r_i^{(-t)} = \sum_{s\ne t} w_{is}\rho(i,s) / (\sum_{s\ne t} w_{is} + \lambda)$ is added to the LOEO
# prediction of frame $t$; $\lambda$ (a pseudo-count of zero-residual frames) is chosen on the LOEO RMSE. The
# final `PERSISTENT_RESID` uses all frames. It is never part of a spatial-CV number (an unseen place has no
# residual history).
#
# **Area of applicability (Meyer & Pebesma 2021).** Features are standardised with the training mean/std and
# weighted by the final model's mean |SHAP|; with a training sample of ≤ 20 000 **complete** training rows (every
# weighted feature finite), $DI = d_{min}(x, \text{train}) / \bar d$ where $\bar d$ is the mean pairwise distance of
# the sample. For training rows the nearest row must come from a **different block20 fold** (the distance a CV fold
# actually had to bridge). Threshold $= Q_{75} + 1.5\,IQR$ of the training DI. A row with a missing weighted feature
# (e.g. a Landsat gap in an early frame) has an unknown distance to the training data: `COMPUTE_DI` returns
# $DI = +\infty$ for it (outside the AOA, top decile) instead of imputing the training mean, which would make it look
# typical. The **conformal error model** stores block20 OOF |residual| quantiles (q50/q90/q95) per DI decile (edges
# from the training DI) and signed residual samples per decile.
#
# **Projection-setting error model.** A modelled or projected frame is predicted at a *known* place for *another*
# time with the final model plus the cell's persistent residual. The matching residual is
# $\rho_{proj}(i,t) = y(i,t) - (\hat a^{LOEO}(i,t) + \bar r_i^{(-t)})$ (recentred LOEO prediction + the shrunken
# residual of the other frames with the chosen λ). It is binned by the same different-fold DI deciles:
# `AOA[m]["resid_samples_proj"]` (signed samples, the Monte-Carlo model error of section 11) and
# `AOA[m]["conformal_proj"]` (|residual| quantiles, the modelled-frame intervals of section 09). Residuals of nearby
# cells are correlated: `AOA[m]["resid_rho_block20"]` is the share of the residual variance shared within a 20 km
# block, $\rho_t = (\mathrm{Var}(\bar\rho_b) - \overline{s^2_b / n_b}) / \mathrm{Var}(\rho)$ over blocks with ≥ 5 rows,
# row-weighted over frames and clipped to [0, 0.95] — section 11 uses it as the block correlation of its draws.

# %%
def _s07_final_rounds(infos_block20, infos_fallback):
    """Median best rounds (best_iteration + 1) of the block20 XGBoost folds (fallback: other schemes)."""
    for source, infos in (("block20", infos_block20), ("fallback", infos_fallback)):
        rounds = [int(i["best_iteration"]) + 1 for i in infos if i.get("best_iteration") is not None]
        if rounds:
            if source != "block20":
                log("07: no block20 XGBoost fold succeeded; final rounds from other schemes", "WARNING")
            return rounds
    fallback = max(1, int(CFG.XGB_MAX_ROUNDS) // 3)
    log(f"07: no XGBoost CV fold succeeded; best_rounds falls back to [{fallback}]", "WARNING")
    return [fallback]


def _s07_train_final(ctx, rounds):
    """Final XGBoost booster on all training rows (GPU 0 when available; CPU retry on GPU OOM)."""
    device = xgb_device_for(0)
    try:
        booster, _ = _s07_xgb_train(ctx, ctx["train"], None, device, 0, None, rounds)
    except Exception as exc:  # noqa: BLE001
        if device == "cpu" or not is_gpu_oom_error(exc):
            raise
        log("07: final XGBoost out of GPU memory; training on the CPU", "WARNING")
        free_memory()
        booster, _ = _s07_xgb_train(ctx, ctx["train"], None, "cpu", 0, None, rounds)
    booster.set_param({"device": "cpu"})
    return booster


def _s07_as_matrix(X):
    """(n, 47) float32 C-contiguous matrix in FEATURES order from a DataFrame or an array."""
    if isinstance(X, pd.DataFrame):
        missing = [f for f in FEATURES if f not in X.columns]
        if missing:
            raise KeyError(f"feature columns missing: {missing}")
        X = X[FEATURES].to_numpy(np.float32)
    X = np.ascontiguousarray(np.asarray(X, dtype=np.float32))
    if X.ndim != 2 or X.shape[1] != len(FEATURES):
        raise ValueError(f"expected an (n, {len(FEATURES)}) feature matrix, got {X.shape}")
    return X


def PREDICT_ANOM(m, X, recentre_mask=None):
    """Final-model anomaly prediction (°C) for mode ``m``; optional recentring over ``recentre_mask`` rows.

    ``X``: DataFrame with the ``FEATURES`` columns or an (n, 47) array in ``FEATURES`` order (NaN allowed).
    ``recentre_mask``: bool array over the rows of ONE frame (typically its fixed-mask cells); when given, the mean
    prediction over those rows is subtracted (SPEC §1.4 recentring).
    """
    if m not in FINAL_MODELS:
        raise KeyError(f"no final model for mode {m!r} (available: {sorted(FINAL_MODELS)})")
    Xa = _s07_as_matrix(X)
    pred = np.asarray(FINAL_MODELS[m].inplace_predict(Xa), dtype=np.float32)
    if recentre_mask is not None:
        mask = np.asarray(recentre_mask, dtype=bool)
        if mask.shape != pred.shape:
            raise ValueError(f"recentre_mask shape {mask.shape} != predictions {pred.shape}")
        if not mask.any():
            raise ValueError("recentre_mask selects no rows")
        pred = pred - np.float32(np.mean(pred[mask], dtype=np.float64))
    return pred


def _s07_persistent_residual(ctx, loeo_pred):
    """λ selection on LOEO (SPEC §4.5) → (H, W) residual grid, λ and the report dict."""
    tr = ctx["train"]
    tr = tr[np.isfinite(loeo_pred[tr])]
    empty_grid = np.where(ROI_MASK, 0.0, np.nan).astype(np.float32)
    rbar_rows = np.full(_S07_N, np.nan, dtype=np.float64)     # rbar^(-t) of every training row with a LOEO prediction
    if tr.size == 0 or len(np.unique(_S07_YEAR[tr])) < 2:
        log(f"07: {ctx['mode']}: no LOEO predictions - persistent residual disabled (lambda = inf)", "WARNING")
        return empty_grid, float("inf"), {"lambda": None, "lambda_is_inf": True, "loeo_rmse_without": None,
                                          "loeo_rmse_with": None, "by_lambda": []}, rbar_rows
    w = ctx["w"][tr].astype(np.float64)
    rho = ctx["y"][tr].astype(np.float64) - loeo_pred[tr].astype(np.float64)
    cell = _S07_CELL_POS[tr]
    s_all = np.bincount(cell, weights=w * rho, minlength=int(N_CELLS))
    w_all = np.bincount(cell, weights=w, minlength=int(N_CELLS))
    s_other = s_all[cell] - w * rho            # sums over the OTHER frames s != t of the row's frame t
    w_other = w_all[cell] - w
    by_lambda = []
    for lam in _S07_LAMBDAS:
        rbar = np.zeros_like(rho) if not np.isfinite(lam) else s_other / (w_other + lam)
        met = _s07_wmetrics(ctx["y"][tr], loeo_pred[tr] + rbar, w)
        by_lambda.append({"lambda": None if not np.isfinite(lam) else lam, "rmse": met["rmse"], "r2": met["r2"]})
    best = min(range(len(_S07_LAMBDAS)), key=lambda i: (by_lambda[i]["rmse"], -i))
    lam = _S07_LAMBDAS[best]
    grid = np.full(ROI_MASK.shape, np.nan, dtype=np.float32)
    rbar_cells = np.zeros(int(N_CELLS)) if not np.isfinite(lam) else s_all / (w_all + lam)
    grid[CELL_ROWS, CELL_COLS] = rbar_cells.astype(np.float32)
    report = {"lambda": None if not np.isfinite(lam) else lam, "lambda_is_inf": not np.isfinite(lam),
              "loeo_rmse_without": by_lambda[-1]["rmse"], "loeo_rmse_with": by_lambda[best]["rmse"],
              "loeo_r2_without": by_lambda[-1]["r2"], "loeo_r2_with": by_lambda[best]["r2"],
              "gain_rmse": by_lambda[-1]["rmse"] - by_lambda[best]["rmse"], "by_lambda": by_lambda,
              "resid_sd": float(np.nanstd(rbar_cells)), "model": "xgboost"}
    rbar_rows[tr] = 0.0 if not np.isfinite(lam) else s_other / (w_other + lam)
    return grid, lam, report, rbar_rows


def _s07_sq_norms(a):
    return np.einsum("ij,ij->i", a, a, dtype=np.float64)


def _s07_nearest_cuda(query, ref, chunk=4096):
    """Plain nearest distances on a CUDA GPU via PyTorch (the COMPUTE_DI hot path); None when unavailable."""
    if _s07_torch_cuda_count() == 0:
        return None
    try:
        import torch

        dev = torch.device("cuda:0")
        with _S07_TORCH_LOCK, torch.no_grad():
            r = torch.from_numpy(ref).to(dev)
            rn = (r * r).sum(dim=1)
            out = np.empty(query.shape[0], dtype=np.float64)
            for s in range(0, query.shape[0], chunk):
                q = torch.from_numpy(query[s:s + chunk]).to(dev)
                j = torch.addmm(rn[None, :], q, r.T, alpha=-2.0).argmin(dim=1)
                # exact distance to the selected neighbour (no |q|^2 + |r|^2 - 2qr cancellation near zero)
                out[s:s + q.shape[0]] = torch.linalg.vector_norm(q.double() - r[j].double(), dim=1).cpu().numpy()
            del r, rn
            torch.cuda.empty_cache()
        return out
    except Exception as exc:  # noqa: BLE001 - any GPU problem -> NumPy path
        log(f"07: CUDA nearest-neighbour search failed ({exc!r}); using NumPy", "WARNING")
        return None


def _s07_nearest(query, ref, ref_groups=None, query_groups=None, chunk=2048, want_mean=False, self_ref=False):
    """Brute-force nearest Euclidean distances from ``query`` rows to ``ref`` rows (float32 BLAS, chunked).

    Uses d² = |q|² + |r|² − 2 q·r: one matrix product per chunk, then a row minimum; only the
    minimum is square-rooted. With groups, reference rows of the query row's own group are excluded (the
    different-fold nearest neighbour of the AOA); the reference rows are sorted by group once so the exclusion is a
    contiguous column slice. ``self_ref`` declares that ``query`` and ``ref`` are the same rows (each row's zero
    distance to itself is excluded). With ``want_mean`` the mean of all pairwise distances (self pairs excluded)
    is also returned - the AOA mean pairwise distance.
    """
    query = np.ascontiguousarray(query, np.float32)
    ref = np.ascontiguousarray(ref, np.float32)
    n_q, n_r = query.shape[0], ref.shape[0]
    if ref_groups is None and not want_mean and not self_ref and n_q * n_r >= 2e8:
        fast = _s07_nearest_cuda(query, ref)
        if fast is not None:
            return fast
    order = np.arange(n_r)
    spans = None
    if ref_groups is not None:
        order = np.argsort(np.asarray(ref_groups), kind="stable")
        g_sorted = np.asarray(ref_groups)[order]
        uniq, first = np.unique(g_sorted, return_index=True)
        last = np.append(first[1:], n_r)
        spans = {int(g): (int(a), int(b)) for g, a, b in zip(uniq, first, last)}
        ref = ref[order]
    rn = _s07_sq_norms(ref).astype(np.float32)
    qn = _s07_sq_norms(query)
    self_pos = np.empty(n_r, dtype=np.int64)
    self_pos[order] = np.arange(n_r)              # column of every original reference row after sorting
    out = np.empty(n_q, dtype=np.float64)
    total, count = 0.0, 0
    for s in range(0, n_q, chunk):
        e = min(n_q, s + chunk)
        g = (query[s:e] * np.float32(-2.0)) @ ref.T   # (c, n_r) float32 = -2 q.r
        g += rn[None, :]
        rows = np.arange(e - s)
        if want_mean:
            d = np.sqrt(np.maximum(g + qn[s:e, None].astype(np.float32), 0.0))
            if self_ref:
                d[rows, self_pos[s:e]] = 0.0
            total += float(d.sum(dtype=np.float64))
            count += d.size - (e - s if self_ref else 0)
            del d
        if self_ref:
            g[rows, self_pos[s:e]] = np.inf
        if spans is not None:
            qg = np.asarray(query_groups[s:e])
            for grp in np.unique(qg):
                if int(grp) in spans:
                    a, b = spans[int(grp)]
                    g[np.flatnonzero(qg == grp), a:b] = np.inf
        j = g.argmin(axis=1)
        best = g[rows, j]
        # exact distance to the selected neighbour (avoids |q|^2 + |r|^2 - 2qr cancellation near zero)
        exact = np.sqrt(((query[s:e].astype(np.float64) - ref[j].astype(np.float64)) ** 2).sum(axis=1))
        out[s:e] = np.where(np.isfinite(best), exact, np.inf)
        del g
    return (out, total / max(count, 1)) if want_mean else out


def _s07_decile_error_model(resid, weight, dec, rng, edges):
    """Per-DI-decile error model of signed residuals: rows, |resid| q50/q90/q95, weighted RMSE, signed samples.

    Deciles with < 5 rows borrow the quantiles and samples of the nearest populated decile (monotone use downstream);
    their ``rmse`` stays NaN and ``n`` is their own count.
    """
    by_decile, q50, q90, q95, samples = [], [], [], [], []
    bounds = [0.0] + list(edges) + [None]
    for k in range(10):
        sel = dec == k
        n_k = int(sel.sum())
        if n_k >= 5:
            a = np.abs(resid[sel])
            rm = float(np.sqrt(np.sum(weight[sel] * resid[sel] ** 2) / np.sum(weight[sel])))
            qq = np.quantile(a, [0.5, 0.9, 0.95])
            pick = rng.choice(np.flatnonzero(sel), size=min(_S07_RESID_SAMPLES, n_k), replace=False)
            smp = resid[pick].astype(np.float32)
        else:
            rm, qq, smp = np.nan, [np.nan] * 3, np.zeros(0, np.float32)
        by_decile.append({"decile": k, "di_lo": bounds[k], "di_hi": bounds[k + 1], "rmse": rm, "n": n_k})
        q50.append(float(qq[0]))
        q90.append(float(qq[1]))
        q95.append(float(qq[2]))
        samples.append(smp)
    filled = [k for k in range(10) if np.isfinite(q90[k])]
    for k in range(10):
        if not np.isfinite(q90[k]) and filled:
            j = min(filled, key=lambda f: abs(f - k))
            q50[k], q90[k], q95[k], samples[k] = q50[j], q90[j], q95[j], samples[j]
    return by_decile, q50, q90, q95, samples


def _s07_block_resid_rho(rows, resid):
    """Pooled intra-block20 correlation of residuals (D13).

    Per frame, over the block20 blocks with >= 5 rows: rho_t = (var(block means) - mean(within-block var / n_b)) /
    var(residuals of the frame) - the between-block variance share (ANOVA estimator). Pooled as the row-weighted mean
    over frames and clipped to [0, 0.95]. Returns (rho, per-frame rows).
    """
    years, blocks = _S07_YEAR[rows], _S07_BLOCK20[rows]
    per_frame, num, den = [], 0.0, 0.0
    for t in np.unique(years):
        sel = years == t
        r_t = resid[sel].astype(np.float64)
        if r_t.size < 10:
            continue
        v_tot = float(np.var(r_t, ddof=1))
        uniq, inv, cnt = np.unique(blocks[sel], return_inverse=True, return_counts=True)
        s1 = np.bincount(inv, weights=r_t, minlength=uniq.size)
        s2 = np.bincount(inv, weights=r_t * r_t, minlength=uniq.size)
        keep = cnt >= 5
        if keep.sum() < 2 or not v_tot > 0:
            continue
        n_b = cnt[keep].astype(np.float64)
        means = s1[keep] / n_b
        wvar = np.maximum(s2[keep] - n_b * means * means, 0.0) / (n_b - 1.0)
        rho_t = (float(np.var(means, ddof=1)) - float(np.mean(wvar / n_b))) / v_tot
        n_t = float(n_b.sum())
        per_frame.append({"year": int(t), "rho": rho_t, "n_rows": int(n_t), "n_blocks": int(keep.sum())})
        num += rho_t * n_t
        den += n_t
    rho = float(np.clip(num / den, 0.0, 0.95)) if den > 0 else 0.0
    return rho, per_frame


def _s07_aoa(ctx, booster, oof_block20, loeo_pred=None, rbar_rows=None):
    """AOA dict (SPEC §3.4 + extras) for one mode.

    DI model (complete training rows only, D12), the conformal block20 error model by DI decile and, given the
    recentred LOEO predictions and the per-row persistent residual of the other frames, the projection-setting error
    model (D13): ``resid_samples_proj``, ``conformal_proj`` and ``resid_rho_block20``.
    """
    import xgboost as xgb

    tr = ctx["train"]
    rng = np.random.default_rng(CFG.SEED)
    shap_rows = np.sort(rng.choice(tr, size=min(_S07_AOA_SAMPLE, tr.size), replace=False))
    # mean |SHAP| of the final model on the sample (TreeSHAP; on the GPU when XGBoost has CUDA)
    xs = _s07_take(shap_rows)
    try:
        if ENV.get("xgb_device") == "cuda":
            booster.set_param({"device": xgb_device_for(0)})
        contrib = booster.predict(xgb.DMatrix(xs), pred_contribs=True)
    finally:
        booster.set_param({"device": "cpu"})
    weights = np.abs(contrib[:, :len(FEATURES)]).mean(axis=0).astype(np.float64)
    with _s07_warnings.catch_warnings():
        _s07_warnings.simplefilter("ignore", RuntimeWarning)
        mean = np.nanmean(_S07_X[tr], axis=0).astype(np.float64)
        std = np.nanstd(_S07_X[tr], axis=0).astype(np.float64)
    mean = np.where(np.isfinite(mean), mean, 0.0)
    std = np.where(np.isfinite(std) & (std > 0), std, 1.0)
    used = weights > 0

    def complete(rows):
        """Rows with every AOA-weighted feature finite (D12: the others get DI = +inf)."""
        return np.isfinite(_S07_X[rows][:, used]).all(axis=1)

    def transform(x):
        z = (np.asarray(x, np.float64) - mean) / std
        return (np.nan_to_num(z, nan=0.0) * weights).astype(np.float32)   # NaN only in weight-0 features here

    # The AOA training sample is drawn from COMPLETE training rows only, so d_bar, the threshold and di_train stay
    # finite and describe real feature vectors (D12).
    tr_complete = tr[complete(tr)]
    if tr_complete.size < 10:
        raise RuntimeError(f"AOA: only {tr_complete.size} training rows have every weighted feature")
    sample = np.sort(np.random.default_rng([int(CFG.SEED), 707]).choice(
        tr_complete, size=min(_S07_AOA_SAMPLE, tr_complete.size), replace=False))
    S = transform(_S07_X[sample])
    folds = _S07_FOLD20[sample]
    di_train, d_bar = _s07_nearest(S, S, folds, folds, want_mean=True, self_ref=True)
    if not np.isfinite(d_bar) or d_bar <= 0:
        raise RuntimeError("AOA: mean pairwise distance of the training sample is not positive")
    di_train = di_train / d_bar
    finite_train = di_train[np.isfinite(di_train)]
    q25, q75 = np.percentile(finite_train, [25, 75])
    threshold = float(q75 + 1.5 * (q75 - q25))

    def di_other_fold(rows):
        """DI with the nearest training-sample row from a DIFFERENT block20 fold; +inf for incomplete rows."""
        out = np.full(rows.size, np.inf)
        ok = complete(rows)
        if ok.any():
            out[ok] = _s07_nearest(transform(_S07_X[rows[ok]]), S, folds, _S07_FOLD20[rows[ok]]) / d_bar
        return out

    # Conformal error model on block20 OOF residuals of up to 100k training rows (DI: different-fold neighbour;
    # rows with a missing weighted feature have DI = inf and land in the top decile).
    cand = tr[np.isfinite(oof_block20[tr])]
    rows = np.sort(rng.choice(cand, size=min(_S07_CONFORMAL_ROWS, cand.size), replace=False)) if cand.size else cand
    edges = np.quantile(finite_train, np.linspace(0.1, 0.9, 9)).tolist()
    by_decile, q50, q90, q95, samples = [], [], [], [], []
    di_cv = np.zeros(0)
    if rows.size:
        di_cv = di_other_fold(rows)
        resid = ctx["y"][rows].astype(np.float64) - oof_block20[rows].astype(np.float64)
        wr = ctx["w"][rows].astype(np.float64)
        dec = np.searchsorted(np.asarray(edges), di_cv, side="right")
        by_decile, q50, q90, q95, samples = _s07_decile_error_model(resid, wr, dec, rng, edges)
    out = {"weights": weights.astype(np.float32), "mean": mean.astype(np.float32), "std": std.astype(np.float32),
           "train_sample": S, "train_rows": sample, "d_bar": float(d_bar), "threshold": threshold,
           "di_train": di_train.astype(np.float32), "rmse_by_di_decile": by_decile,
           "conformal": {"edges": edges, "abs_resid_quantiles": {"q50": q50, "q90": q90, "q95": q95}},
           "resid_samples": samples, "feature_order": list(FEATURES), "n_conformal_rows": int(rows.size),
           "n_conformal_rows_incomplete": int(np.sum(~np.isfinite(di_cv))),
           "resid_rho_block20": 0.0, "resid_rho_by_frame": [],
           "projection_error_model": "unavailable (no LOEO predictions)"}

    # ---- projection-setting error model (D13): a known place at another time --------------------------------
    # rho_proj = y - (recentred LOEO prediction + rbar^(-t)) is the residual of exactly the predictor used for
    # modelled and projected frames (final model + persistent residual of the cell's other frames).
    if loeo_pred is None or rbar_rows is None:
        return out
    lp = np.asarray(loeo_pred, np.float64)
    rb = np.asarray(rbar_rows, np.float64)
    all_p = tr[np.isfinite(lp[tr]) & np.isfinite(rb[tr])]
    if all_p.size < 50:
        log(f"07: {ctx['mode']}: only {all_p.size} rows with LOEO predictions - projection error model unavailable",
            "WARNING")
        return out
    rho_all = ctx["y"][all_p].astype(np.float64) - (lp[all_p] + rb[all_p])
    rho_b20, per_frame = _s07_block_resid_rho(all_p, rho_all)
    out["resid_rho_block20"] = rho_b20
    out["resid_rho_by_frame"] = per_frame
    out["projection_error_model"] = ("recentred LOEO prediction + persistent residual of the other frames; deciles of "
                                     "the different-fold DI with the conformal edges")
    in_p = (np.isfinite(lp[rows]) & np.isfinite(rb[rows])) if rows.size else np.zeros(0, bool)
    if in_p.sum() >= 50:
        rows_p = rows[in_p]
        resid_p = ctx["y"][rows_p].astype(np.float64) - (lp[rows_p] + rb[rows_p])
        dec_p = np.searchsorted(np.asarray(edges), di_cv[in_p], side="right")
        bd_p, p50, p90, p95, smp_p = _s07_decile_error_model(resid_p, ctx["w"][rows_p].astype(np.float64), dec_p,
                                                             rng, edges)
        if all(np.isfinite(p90)):
            out["conformal_proj"] = {"edges": edges, "abs_resid_quantiles": {"q50": p50, "q90": p90, "q95": p95}}
            out["resid_samples_proj"] = smp_p
            out["rmse_by_di_decile_proj"] = bd_p
            out["n_proj_rows"] = int(rows_p.size)
    return out


def COMPUTE_DI(m, X):
    """Dissimilarity index (Meyer & Pebesma 2021) of feature rows for mode ``m`` → float32 array.

    ``X``: DataFrame with the ``FEATURES`` columns or an (n, 47) array. A row with a NaN in any feature of positive
    AOA weight gets DI = +inf (outside the AOA and in the top DI decile, D12): its distance to the training data is
    unknown, and imputing the training mean would make it look typical. DI > ``AOA[m]["threshold"]`` means outside
    the area of applicability.
    """
    a = AOA[m]
    Xa = _s07_as_matrix(X)
    w = a["weights"].astype(np.float64)
    out = np.full(Xa.shape[0], np.inf, dtype=np.float32)
    ok = np.isfinite(Xa[:, w > 0]).all(axis=1)
    if ok.any():
        z = (Xa[ok].astype(np.float64) - a["mean"].astype(np.float64)) / a["std"].astype(np.float64)
        q = (np.nan_to_num(z, nan=0.0) * w).astype(np.float32)
        out[ok] = (_s07_nearest(q, a["train_sample"]) / a["d_bar"]).astype(np.float32)
    return out


# %% [markdown]
# ## 7.7 Run the suite per mode
# Order per mode: (1) all CV jobs in one scheduled pass (six schemes, block-size curve, base-only ablation);
# (2) collection, summaries, error-vs-distance, Moran, fold geometry; (3) final model, AOA, persistent residual
# (stage-cached together, keyed by the CV results). The block-size curve uses 5 greedy folds per block size
# (5/10/20/40/66 km) plus the random folds; the **ablation** refits block20 XGBoost on the 33 base features only, so
# the gain from neighbourhood context is measured on identical folds. It isolates the **14 focal means only**: the
# distances, TPI and ERA5 features are in both runs, so its gain should be well below the +0.2 R² of the real-data
# experiments (0.63 → 0.83), which added focal means together with distance and relative-elevation features.

# %%
MODEL_RESULTS, FINAL_MODELS, PERSISTENT_RESID, PERSISTENT_LAMBDA, AOA = {}, {}, {}, {}, {}
_S07_CTX = {}
_S07_TIMES = {}
_s07_resolve_lgbm_device()


def _s07_run_mode(mode):
    """Full validation suite + final products of one mode → MODEL_RESULTS[mode] etc."""
    t_mode = _s07_time.perf_counter()
    ctx = _s07_context(mode)
    _S07_CTX[mode] = ctx
    if ctx["train"].size == 0:
        log(f"07: mode {mode} has no training rows - skipped", "WARNING")
        return
    log(f"07: === mode {mode}: {ctx['train'].size:,} training rows, frames {ctx['frames']} ===")

    # ---- (1) job list --------------------------------------------------------------------------------------------
    groups, jobs, jobs_by_key = {}, [], {}
    for scheme in _S07_SCHEMES:
        folds = _s07_folds(ctx, scheme)
        models = [m for m in _S07_SCHEME_MODELS[scheme] if _s07_model_available(m)]
        if not folds:
            log(f"07: {mode}: scheme {scheme} has no usable folds - skipped", "WARNING")
            continue
        for fold in folds:
            _s07_check_fold(ctx, scheme, fold)
        groups[scheme] = {"folds": folds, "models": models}
    curve_info = {}
    for km in _S07_CURVE_KM:
        b = max(1, int(round(km * 1000.0 / float(GRID.res))))
        fold_rows, _ = _s07_block_fold_rows(b, _S07_CURVE_FOLDS)
        f = fold_rows[ctx["train"]]
        folds = [{"fold": int(k), "train": ctx["train"][f != k], "test": ctx["train"][f == k]} for k in np.unique(f)]
        folds = [fd for fd in folds if fd["train"].size and fd["test"].size]
        for fold in folds:
            _s07_check_fold(ctx, f"curve_{km}", fold)
        groups[f"curve_{km}"] = {"folds": folds, "models": ["xgboost"]}
        curve_info[km] = {"block_cells": b, "block_km_actual": b * float(GRID.res) / 1000.0}
    if _S07_RUN_ABLATION and "block20" in groups:
        groups["ablation_base"] = {"folds": groups["block20"]["folds"], "models": ["xgboost"], "feat": "base"}
    for label, g in groups.items():
        for model in g["models"]:
            for fold in g["folds"]:
                job = _s07_make_job(ctx, label, model, fold, feat=g.get("feat", "all"))
                jobs.append(job)
                jobs_by_key[(label, model, fold["fold"])] = job
    if "gnn" in {j["model"] for j in jobs}:
        _s07_gnn_graph(ctx)                                    # build once, before the lanes start

    with timer(f"07_{mode}_cv_jobs"):
        results, busy, lane_counts = _s07_run_jobs(jobs, mode)

    # ---- (2) collection ------------------------------------------------------------------------------------------
    oof_all, fold_rows, infos_all, summary_rows = {}, [], {}, []
    for scheme in _S07_SCHEMES:
        if scheme not in groups:
            continue
        g = groups[scheme]
        oof, raw, rows, infos = _s07_collect(ctx, scheme, g["models"], g["folds"], jobs_by_key, results)
        oof_all[scheme] = oof
        if scheme in ("loeo", "place_time"):
            oof_all[f"{scheme}_raw"] = raw
        fold_rows.extend(rows)
        infos_all[scheme] = infos
        for model in g["models"]:
            summary_rows.append(_s07_summary_row(ctx, scheme, model, oof[model], rows))
    cv_fold_metrics = pd.DataFrame(fold_rows, columns=["scheme", "model", "fold", "r2", "rmse", "mae", "bias",
                                                       "n_train", "n_test", "fit_seconds", "device"])
    cv_summary = pd.DataFrame(summary_rows, columns=["scheme", "model", "r2_pooled", "rmse_pooled", "mae_pooled",
                                                     "r2_fold_mean", "r2_fold_sd", "rmse_fold_mean", "rmse_fold_sd",
                                                     "n_folds", "n"])

    def summary_of(scheme, model="xgboost"):
        sub = cv_summary[(cv_summary["scheme"] == scheme) & (cv_summary["model"] == model)]
        return sub.iloc[0].to_dict() if len(sub) else {}

    # block-size curve (5 greedy folds per size + the random folds of the random scheme)
    curve = []
    for km in _S07_CURVE_KM:
        g = groups[f"curve_{km}"]
        oof, _, rows, _ = _s07_collect(ctx, f"curve_{km}", ["xgboost"], g["folds"], jobs_by_key, results)
        row = _s07_summary_row(ctx, f"curve_{km}", "xgboost", oof["xgboost"], rows)
        curve.append({"block_km": float(km), "label": f"{km} km", "block_km_actual": curve_info[km]["block_km_actual"],
                      "r2_pooled": row["r2_pooled"], "rmse_pooled": row["rmse_pooled"],
                      "r2_fold_mean": row["r2_fold_mean"], "n_folds": row["n_folds"]})
    rnd = summary_of("random")
    if rnd:
        curve.append({"block_km": None, "label": "random", "block_km_actual": None, "r2_pooled": rnd["r2_pooled"],
                      "rmse_pooled": rnd["rmse_pooled"], "r2_fold_mean": rnd["r2_fold_mean"],
                      "n_folds": rnd["n_folds"]})

    ablation = None
    if "ablation_base" in groups:
        oof_b, _, rows_b, _ = _s07_collect(ctx, "ablation_base", ["xgboost"], groups["ablation_base"]["folds"],
                                           jobs_by_key, results)
        base_row = _s07_summary_row(ctx, "ablation_base", "xgboost", oof_b["xgboost"], rows_b)
        full_row = summary_of("block20")
        ablation = {"scheme": "block20", "model": "xgboost",
                    "base_only": {k: base_row[k] for k in ("r2_pooled", "rmse_pooled", "r2_fold_mean", "r2_fold_sd")},
                    "all_features": {k: full_row.get(k) for k in ("r2_pooled", "rmse_pooled", "r2_fold_mean",
                                                                  "r2_fold_sd")},
                    "n_features": {"base_only": len(BASE_FEATURES), "all_features": len(FEATURES)}}
        ablation["gain_r2_pooled"] = (ablation["all_features"]["r2_pooled"] or np.nan) - base_row["r2_pooled"]

    # LOEO table (xgboost headline + every model)
    loeo_by_model = {}
    if "loeo" in groups:
        for model in groups["loeo"]["models"]:
            entries = []
            for fold in groups["loeo"]["folds"]:
                te = fold["test"]
                raw_p, rec_p = oof_all["loeo_raw"][model][te], oof_all["loeo"][model][te]
                if not np.isfinite(raw_p).any():
                    continue
                mr = _s07_wmetrics(ctx["y"][te], raw_p, ctx["w"][te])
                mc = _s07_wmetrics(ctx["y"][te], rec_p, ctx["w"][te])
                entries.append({"held_out": int(fold["fold"]), "r2_raw": mr["r2"], "rmse_raw": mr["rmse"],
                                "bias_raw": mr["bias"], "r2_recentred": mc["r2"], "rmse_recentred": mc["rmse"],
                                "bias_recentred": mc["bias"], "n": int(te.size), "model": model})
            loeo_by_model[model] = entries
    place_time = {}
    if "place_time" in groups:
        pr, pc = oof_all["place_time_raw"]["xgboost"], oof_all["place_time"]["xgboost"]
        ok = np.flatnonzero(np.isfinite(pr))
        mr = _s07_wmetrics(ctx["y"][ok], pr[ok], ctx["w"][ok])
        mc = _s07_wmetrics(ctx["y"][ok], pc[ok], ctx["w"][ok])
        place_time = {"model": "xgboost", "test_frame": ctx["frames"][-1], "train_frames": ctx["frames"][:-1],
                      "r2": mc["r2"], "rmse": mc["rmse"], "recentred": True, "r2_raw": mr["r2"],
                      "rmse_raw": mr["rmse"], "bias_raw": mr["bias"], "r2_recentred": mc["r2"],
                      "rmse_recentred": mc["rmse"], "n": int(ok.size),
                      "fold_r2_mean": summary_of("place_time").get("r2_fold_mean"),
                      "fold_r2_sd": summary_of("place_time").get("r2_fold_sd")}

    with timer(f"07_{mode}_diagnostics"):
        evd, _ = (_s07_error_vs_distance(ctx, groups["block20"]["folds"], oof_all["block20"]["xgboost"])
                  if "block20" in groups else ([], None))
        moran, moran_target, moran_scatter = _s07_moran_tables(ctx, oof_all.get("block20", {}))
        geometry = _s07_fold_geometry(ctx, oof_all)

    # ---- (3) final model, AOA, persistent residual (stage-cached on the CV results) ------------------------------
    best_rounds = _s07_final_rounds(infos_all.get("block20", {}).get("xgboost", []),
                                    infos_all.get("random", {}).get("xgboost", [])
                                    + infos_all.get("loeo", {}).get("xgboost", []))
    final_rounds = max(1, int(round(1.1 * float(np.median(best_rounds)))))
    loeo_x = oof_all.get("loeo", {}).get("xgboost", np.full(_S07_N, np.nan, np.float32))
    oof_b20 = oof_all.get("block20", {}).get("xgboost", np.full(_S07_N, np.nan, np.float32))
    post_key = CFG.key("XGB_PARAMS", version=_S07_VERSION, mode=mode, df=_S07_DF_FP, rounds=final_rounds,
                       loeo=_s07_hash(np.nan_to_num(loeo_x, nan=-999.0)),
                       oof=_s07_hash(np.nan_to_num(oof_b20, nan=-999.0)), aoa_sample=_S07_AOA_SAMPLE,
                       aoa_impl=4)

    def compute_post():
        import xgboost as xgb  # noqa: F401 - imported for the booster type

        with timer(f"07_{mode}_final_model"):
            booster = _s07_train_final(ctx, final_rounds)
        with timer(f"07_{mode}_persistent_residual"):
            grid, lam, report, rbar_rows = _s07_persistent_residual(ctx, loeo_x)
        with timer(f"07_{mode}_aoa"):
            aoa = _s07_aoa(ctx, booster, oof_b20, loeo_x, rbar_rows)
        return {"booster_raw": bytes(booster.save_raw("ubj")), "aoa": aoa, "resid": grid, "lambda": lam,
                "resid_report": report}

    post = stage_cache(f"07_post_{mode}", post_key).get_or_compute(compute_post)
    import xgboost as xgb

    booster = xgb.Booster()
    booster.load_model(bytearray(post["booster_raw"]))
    booster.set_param({"device": "cpu"})
    FINAL_MODELS[mode] = booster
    AOA[mode] = post["aoa"]
    PERSISTENT_RESID[mode] = post["resid"]
    PERSISTENT_LAMBDA[mode] = float(post["lambda"])
    try:
        booster.save_model(str(Path(CFG.MODEL_DIR) / f"xgb_final_{mode}.json"))
    except Exception as exc:  # noqa: BLE001
        log(f"07: could not save the final {mode} model: {exc!r}", "WARNING")

    # AOA share inside per observed frame (all ROI cells of the frame)
    with timer(f"07_{mode}_aoa_frames"):
        di_frames, pct_inside = {}, {}
        for j, year in enumerate(_S07_FRAMES_DF):
            di = COMPUTE_DI(mode, _S07_X[j * int(N_CELLS):(j + 1) * int(N_CELLS)])
            di_frames[year] = di                                 # +inf for rows with a missing weighted feature
            pct_inside[year] = float(np.mean(di <= AOA[mode]["threshold"]))
        AOA[mode]["di_frames"] = di_frames
        AOA[mode]["pct_inside"] = pct_inside

    b20, b5, lo = summary_of("block20"), summary_of("block5"), summary_of("loeo")
    MODEL_RESULTS[mode] = {
        "cv_fold_metrics": cv_fold_metrics, "cv_summary": cv_summary, "oof": oof_all,
        "block_size_curve": curve, "error_vs_distance": evd,
        "loeo": loeo_by_model.get("xgboost", []), "loeo_by_model": loeo_by_model, "place_time": place_time,
        "moran": moran, "moran_target": moran_target, "moran_scatter": moran_scatter, "fold_geometry": geometry,
        "best_rounds": [int(r) for r in best_rounds], "final_rounds": final_rounds,
        "ablation": ablation, "persistent_residual": post["resid_report"],
        "aoa": {"di_threshold": AOA[mode]["threshold"], "pct_inside": pct_inside,
                "rmse_by_di_decile": AOA[mode]["rmse_by_di_decile"], "d_bar": AOA[mode]["d_bar"],
                "resid_rho_block20": float(AOA[mode].get("resid_rho_block20", 0.0)),
                **({"proj_resid_q90": [float(v) for v in AOA[mode]["conformal_proj"]["abs_resid_quantiles"]["q90"]]}
                   if AOA[mode].get("conformal_proj") else {})},
        "v1_comparison": {**_S07_V1_REFERENCE, "v2_block5_pooled": b5.get("r2_pooled"),
                          "v2_block5_fold_mean": b5.get("r2_fold_mean"), "v2_block20_pooled": b20.get("r2_pooled"),
                          "label": ("reference values from the real v1 run" if DATA_MODE == "synthetic"
                                    else "v1 real-data run (MODIS Terra day, 17 features)")},
        "headline": {"spatial": {"scheme": "block20", "model": "xgboost", "r2": b20.get("r2_pooled"),
                                 "rmse": b20.get("rmse_pooled")},
                     "temporal": {"scheme": "loeo", "model": "xgboost", "r2": lo.get("r2_pooled"),
                                  "rmse": lo.get("rmse_pooled"), "recentred": True}},
        "district_merges": ctx.get("district_merges", []),
        "frames": ctx["frames"], "n_train": int(ctx["train"].size),
        "monotone": {f: int(v) for f, v in zip(FEATURES, ctx["mono"]) if v},
        "lane_busy_seconds": {k: round(v, 1) for k, v in busy.items()},
        "lane_job_counts": {k: int(v) for k, v in lane_counts.items()},
        "seconds": round(_s07_time.perf_counter() - t_mode, 1),
    }
    _S07_TIMES[mode] = MODEL_RESULTS[mode]["seconds"]
    ctx["gnn"] = None
    free_memory()


for _s07_mode in CFG.MODES:
    with timer(f"07_{_s07_mode}"):
        _s07_run_mode(_s07_mode)

# %% [markdown]
# ## 7.8 Results
# Tables: pooled skill per scheme and model, LOEO raw vs recentred, the base-only ablation, the persistent-residual
# λ scan and the AOA summary. Figure per mode: (a) pooled R² by scheme/model with fold spread, (b) block-size
# curve, (c) error vs distance, (d) block20 fold map coloured by block RMSE, (e) predicted vs observed anomaly,
# (f) RMSE by DI decile with the AOA threshold.

# %%
def _s07_show(obj):
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


def _s07_print_results(mode):
    res = MODEL_RESULTS[mode]
    print(f"\n=== {mode.upper()} === training rows {res['n_train']:,}, frames {res['frames']}, "
          f"final XGBoost rounds {res['final_rounds']} (median best {int(np.median(res['best_rounds']))})")
    print("Pooled OOF skill (weighted; anomaly °C):")
    _s07_show(res["cv_summary"].round(4))
    if res["loeo"]:
        print("Leave-one-epoch-out (xgboost): raw vs recentred over the held-out frame's fixed mask")
        _s07_show(pd.DataFrame(res["loeo"]).drop(columns=["model"]).round(4))
    if res["place_time"]:
        pt = res["place_time"]
        print(f"Unseen place + time (train < {pt['test_frame']}, block20 folds): R2 raw {pt['r2_raw']:.3f} -> "
              f"recentred {pt['r2_recentred']:.3f} (RMSE {pt['rmse_recentred']:.3f})")
    if res["ablation"]:
        ab = res["ablation"]
        print(f"Ablation (block20 xgboost, pooled R2): base-only {ab['base_only']['r2_pooled']:.4f} "
              f"(33 features) vs all {ab['all_features']['r2_pooled']:.4f} (47) -> gain {ab['gain_r2_pooled']:+.4f}")
    print("Block-size curve:", ", ".join(f"{c['label']}: {c['r2_pooled']:.3f}" for c in res["block_size_curve"]))
    print("Error vs distance:", ", ".join(f"[{e['lo']:g},{e['hi'] if e['hi'] is not None else 'inf'}) "
                                          f"{e['rmse']:.3f} (n={e['n']})" for e in res["error_vs_distance"]))
    pr = res["persistent_residual"]
    if pr.get("by_lambda"):
        print(f"Persistent residual: lambda = {pr['lambda'] if pr['lambda'] is not None else 'inf'}; LOEO RMSE "
              f"{pr['loeo_rmse_without']:.4f} -> {pr['loeo_rmse_with']:.4f} (R2 {pr['loeo_r2_without']:.4f} -> "
              f"{pr['loeo_r2_with']:.4f}); scan: "
              + ", ".join(f"{b['lambda'] if b['lambda'] is not None else 'inf'}:{b['rmse']:.4f}"
                          for b in pr["by_lambda"]))
    a = AOA[mode]
    print(f"AOA: d_bar {a['d_bar']:.4f}, DI threshold {a['threshold']:.4f}, inside share by frame "
          + ", ".join(f"{y}:{v:.3f}" for y, v in MODEL_RESULTS[mode]["aoa"]["pct_inside"].items()))
    print("Conformal |resid| q90 by DI decile:", np.round(a["conformal"]["abs_resid_quantiles"]["q90"], 3).tolist())
    if a.get("conformal_proj"):
        print("Projection-setting (LOEO + persistent residual) |resid| q90 by DI decile:",
              np.round(a["conformal_proj"]["abs_resid_quantiles"]["q90"], 3).tolist(),
              f"| sd per decile {[round(float(np.std(v)), 3) for v in a['resid_samples_proj']]}")
    print(f"block20 residual correlation rho = {a.get('resid_rho_block20', 0.0):.3f} (per frame "
          + ", ".join(f"{r['year']}:{r['rho']:.2f}" for r in a.get("resid_rho_by_frame", [])) + ")")
    n_inf = {y: int(np.sum(~np.isfinite(v))) for y, v in a.get("di_frames", {}).items()}
    if any(n_inf.values()):
        print("Rows with DI = inf (a weighted feature missing; outside the AOA):", n_inf)
    if len(res["moran"]):
        print("Moran's I of block20 residuals (model x year):")
        _s07_show(res["moran"].pivot(index="model", columns="year", values="I").round(3))
    print(f"lane busy seconds {res['lane_busy_seconds']} (jobs {res.get('lane_job_counts')}), mode wall time "
          f"{res['seconds']:.0f}s")


def _s07_plot_mode(mode):
    import matplotlib.pyplot as plt

    res = MODEL_RESULTS[mode]
    ctx = _S07_CTX[mode]
    fig, axes = plt.subplots(2, 3, figsize=(19, 10.5))
    summ = res["cv_summary"]
    schemes = [s for s in _S07_SCHEMES if s in set(summ["scheme"])]
    models = [m for m in ["ridge", "random_forest", "lightgbm", "xgboost", "gnn"] if m in set(summ["model"])]
    colors = {"ridge": "#a8a29e", "random_forest": "#16a34a", "lightgbm": "#7c3aed", "xgboost": "#eb6834",
              "gnn": "#2a78d6"}
    ax = axes[0, 0]
    width = 0.8 / max(len(models), 1)
    for i, model in enumerate(models):
        sub = summ[summ["model"] == model].set_index("scheme").reindex(schemes)
        ax.bar(np.arange(len(schemes)) + (i - (len(models) - 1) / 2) * width, sub["r2_pooled"], width * 0.92,
               yerr=sub["r2_fold_sd"], capsize=2, color=colors[model], label=model,
               error_kw={"elinewidth": 0.8, "ecolor": "#52514e"})
    ax.set_xticks(range(len(schemes)))
    ax.set_xticklabels(schemes)
    ax.set_ylabel("pooled OOF R² (anomaly)")
    lo_r2 = float(np.nanmin(summ["r2_pooled"])) if len(summ) else 0.0
    ax.set_ylim(max(-0.5, min(lo_r2 - 0.15, 0.95)), 1.0)
    ax.legend(frameon=False, fontsize=8, ncol=len(models), loc="lower center")
    ax.set_title(f"{mode}: skill by scheme (bars pooled, whiskers fold s.d.)")
    ax = axes[0, 1]
    pts = [c for c in res["block_size_curve"] if c["block_km"] is not None]
    ax.plot([c["block_km_actual"] for c in pts], [c["r2_pooled"] for c in pts], "o-", color="#eb6834", label="blocks")
    rnd = [c for c in res["block_size_curve"] if c["block_km"] is None]
    if rnd:
        ax.axhline(rnd[0]["r2_pooled"], color="#2a78d6", linestyle="--", label="random rows")
    ax.set_xscale("log")
    ax.set_xlabel("block size (km)")
    ax.set_ylabel("pooled R²")
    ax.set_title("Block-size curve (xgboost, 5 folds)")
    ax.legend(frameon=False)
    ax = axes[0, 2]
    evd = [e for e in res["error_vs_distance"] if e["n"] > 0]
    ax.bar(range(len(evd)), [e["rmse"] for e in evd], color="#eb6834")
    ax.set_xticks(range(len(evd)))
    ax.set_xticklabels([f"{e['lo']:g}-{e['hi'] if e['hi'] is not None else '∞'}" for e in evd])
    ax.set_xlabel("distance to nearest training cell (km)")
    ax.set_ylabel("RMSE (°C)")
    ax.set_title("Error vs distance (block20 xgboost)")
    ax = axes[1, 0]
    geo = res["fold_geometry"]["block20"]
    b = geo["block_cells"]
    rm = np.array([np.nan if v is None else v for v in geo["rmse_of_block"]], float).reshape(geo["n_rows"],
                                                                                           geo["n_cols"])
    grid_rmse = np.kron(rm, np.ones((b, b)))[:GRID.height, :GRID.width]
    im = ax.imshow(np.where(ROI_MASK, grid_rmse, np.nan), cmap="magma")
    fig.colorbar(im, ax=ax, fraction=0.046, pad=0.02, label="block RMSE (°C)")
    ax.set_axis_off()
    ax.set_title("block20 fold map: pooled RMSE per 20 km block")
    ax = axes[1, 1]
    pred = res["oof"].get("block20", {}).get("xgboost")
    if pred is not None:
        ok = np.isfinite(pred)
        yv = ctx["y"][ok]
        lo_, hi_ = np.percentile(np.concatenate([yv, pred[ok]]), [0.5, 99.5])
        hb = ax.hexbin(yv, pred[ok], gridsize=60, extent=(lo_, hi_, lo_, hi_), mincnt=1, cmap="Blues", bins="log")
        ax.plot([lo_, hi_], [lo_, hi_], "--", color="#52514e", linewidth=1)
        fig.colorbar(hb, ax=ax, label="rows (log)")
        hl = res["headline"]["spatial"]
        ax.set_title(f"block20 xgboost OOF: R² {hl['r2']:.3f}, RMSE {hl['rmse']:.2f} °C")
        ax.set_xlabel("observed anomaly (°C)")
        ax.set_ylabel("predicted anomaly (°C)")
    ax = axes[1, 2]
    dec = AOA[mode]["rmse_by_di_decile"]
    ax.bar([d["decile"] for d in dec], [d["rmse"] for d in dec], color="#7c3aed")
    ax.set_xlabel("DI decile (training DI edges)")
    ax.set_ylabel("block20 OOF RMSE (°C)")
    ax.set_title(f"Error by dissimilarity; AOA threshold DI = {AOA[mode]['threshold']:.3f}")
    fig.suptitle(f"Model validation — {mode} ({DATA_MODE} data, {GRID.res} m grid)", fontsize=12)
    fig.tight_layout()
    fig.savefig(Path(CFG.FIG_DIR) / f"07_validation_{mode}.png", dpi=130)
    plt.show()
    plt.close(fig)


def _s07_save_tables(mode):
    out_dir = Path(CFG.PARQUET_DIR)
    out_dir.mkdir(parents=True, exist_ok=True)
    for name in ("cv_fold_metrics", "cv_summary", "moran"):
        path = out_dir / f"{name}_{mode}.parquet"
        try:
            MODEL_RESULTS[mode][name].to_parquet(path, engine="pyarrow", compression="zstd", index=False)
        except Exception as exc:  # noqa: BLE001
            log(f"07: could not write {path}: {exc!r}", "WARNING")


Path(CFG.FIG_DIR).mkdir(parents=True, exist_ok=True)
for _s07_mode in MODEL_RESULTS:
    _s07_print_results(_s07_mode)
    _s07_save_tables(_s07_mode)
    try:
        _s07_plot_mode(_s07_mode)
    except Exception:  # noqa: BLE001 - a figure must never stop the pipeline
        log(f"07: validation figure for {_s07_mode} failed:\n{_s07_traceback.format_exc()}", "WARNING")

# %% [markdown]
# ## 7.9 Contract check (SPEC §3.4) and runtime report
# The check asserts the interface later sections rely on and re-verifies the leakage-relevant invariants on the
# stored results (LOEO predictions of a frame come from a model that did not see it; OOF arrays cover only training
# rows). The runtime table lists the wall-clock time of every 06/07 stage (`TIMINGS`), the basis for the Kaggle
# budget (target ≤ 60–90 min for the whole suite on 2 × T4 at full resolution).

# %%
def _s07_contract_check():
    for mode in MODEL_RESULTS:
        res = MODEL_RESULTS[mode]
        ctx = _S07_CTX[mode]
        for key in ("cv_fold_metrics", "cv_summary", "oof", "block_size_curve", "error_vs_distance", "loeo",
                    "place_time", "moran", "moran_target", "moran_scatter", "fold_geometry", "best_rounds"):
            assert key in res, f"MODEL_RESULTS[{mode}] lacks {key}"
        assert list(res["cv_fold_metrics"].columns) == ["scheme", "model", "fold", "r2", "rmse", "mae", "bias",
                                                         "n_train", "n_test", "fit_seconds", "device"]
        assert list(res["cv_summary"].columns)[:3] == ["scheme", "model", "r2_pooled"]
        not_train = np.ones(_S07_N, bool)
        not_train[ctx["train"]] = False
        for scheme, by_model in res["oof"].items():
            for model, arr in by_model.items():
                assert arr.dtype == np.float32 and arr.shape == (_S07_N,), (scheme, model)
                assert not np.isfinite(arr[not_train]).any(), f"{scheme}/{model} predicts non-training rows"
        assert isinstance(FINAL_MODELS[mode].num_boosted_rounds(), int)
        assert FINAL_MODELS[mode].num_boosted_rounds() == res["final_rounds"]
        assert PERSISTENT_RESID[mode].shape == ROI_MASK.shape and PERSISTENT_RESID[mode].dtype == np.float32
        assert np.isfinite(PERSISTENT_RESID[mode][ROI_MASK]).all() and not np.isfinite(
            PERSISTENT_RESID[mode][~ROI_MASK]).any()
        a = AOA[mode]
        for key in ("weights", "mean", "std", "train_sample", "d_bar", "threshold", "di_train", "rmse_by_di_decile",
                    "conformal"):
            assert key in a, f"AOA[{mode}] lacks {key}"
        assert np.isfinite(a["threshold"]) and a["threshold"] > 0 and len(a["conformal"]["edges"]) == 9
        assert all(len(a["conformal"]["abs_resid_quantiles"][q]) == 10 for q in ("q50", "q90", "q95"))
        j = len(_S07_FRAMES_DF) - 1
        rows = slice(j * int(N_CELLS), (j + 1) * int(N_CELLS))
        p = PREDICT_ANOM(mode, DF.iloc[rows][FEATURES])
        assert p.dtype == np.float32 and p.shape == (int(N_CELLS),)
        fixed = ctx["fixed_row"][rows]
        if fixed.any():
            assert abs(float(PREDICT_ANOM(mode, _S07_X[rows], fixed)[fixed].mean())) < 1e-3
        xr = _S07_X[rows]
        incomplete = ~np.isfinite(xr[:, a["weights"] > 0]).all(axis=1)
        pick = np.concatenate([np.flatnonzero(~incomplete)[:100], np.flatnonzero(incomplete)[:20]])
        di = COMPUTE_DI(mode, xr[pick])
        assert di.dtype == np.float32 and np.all(di >= 0)
        assert np.array_equal(np.isinf(di), incomplete[pick]) and np.all(np.isfinite(di[~incomplete[pick]]))
        assert np.all(np.isfinite(a["di_train"])) or np.isfinite(a["di_train"]).mean() > 0.99
        rho = a.get("resid_rho_block20")
        assert rho is not None and np.isfinite(rho) and 0.0 <= rho <= 0.95, rho
        if a.get("conformal_proj"):
            assert all(len(a["conformal_proj"]["abs_resid_quantiles"][q]) == 10 for q in ("q50", "q90", "q95"))
            assert all(np.isfinite(a["conformal_proj"]["abs_resid_quantiles"]["q90"]))
            assert len(a["resid_samples_proj"]) == 10 and all(len(v) > 0 for v in a["resid_samples_proj"])
            assert len(res["aoa"]["proj_resid_q90"]) == 10
        assert set(res["lane_busy_seconds"]) == {"gpu", "cpu", "lgbm"}
        if mode == "night":
            assert all(y in set(CFG.NIGHT_TRAIN_FRAMES) for y in res["frames"]), "night trained outside its frames"
    log("07: contract check passed (SPEC §3.4)")


_s07_contract_check()


def _s07_runtime_report():
    rows = [(k, v) for k, v in TIMINGS.items() if k.startswith(("06", "07"))]
    total_07 = sum(v for k, v in rows if k in {f"07_{m}" for m in CFG.MODES})
    print("Runtime of sections 06-07 (wall-clock seconds):")
    for k, v in rows:
        print(f"  {k:<40} {v:9.1f}")
    n_rows = {m: MODEL_RESULTS[m]["n_train"] for m in MODEL_RESULTS}
    print(f"  {'07 total (both modes)':<40} {total_07:9.1f}  ({total_07 / 60:.1f} min; training rows {n_rows}; "
          f"{ENV.get('n_gpus', 0)} GPU(s) {ENV.get('gpu_names')}, {ENV.get('cpu_count')} CPU threads)")
    return total_07


_S07_TOTAL_SECONDS = _s07_runtime_report()
free_memory()
