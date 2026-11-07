# %% [markdown]
# # 4. Explainability: final model, GPU TreeSHAP, interactions, bootstrap thresholds and governance zones
#
# ## 4.1 Why TreeSHAP
# For a model prediction $f(x)$ the **Shapley value** of feature $j$ is its average marginal contribution over
# all orderings in which features can be "switched on":
#
# $$\phi_j(x)=\sum_{S\subseteq F\setminus\{j\}}\frac{|S|!\,(|F|-|S|-1)!}{|F|!}\big[f_x(S\cup\{j\})-f_x(S)\big],\qquad f_x(S)=E[f(X)\mid X_S=x_S].$$
#
# It is the unique attribution satisfying *efficiency/additivity* ($f(x)=\phi_0+\sum_j\phi_j$, with the bias
# $\phi_0=E[f(X)]$), *symmetry*, *dummy* and *linearity*. **TreeSHAP** (Lundberg et al. 2020) computes the exact
# values for tree ensembles in $O(TLD^2)$ by pushing all subsets down each tree simultaneously, using the tree's
# own cover statistics as the conditional expectation ("path-dependent" TreeSHAP). XGBoost ships a CUDA
# implementation (GPUTreeShap, Mitchell et al. 2022) reached through `predict(..., pred_contribs=True)`. For the
# final model here (~900 trees of depth 8) a mid-range GPU is ~20× faster than a multi-core CPU (measured: GTX 1650
# ≈ 2,200 rows/s vs a 4-core CPU ≈ 100 rows/s; a T4 is ~2× the GTX 1650), which is what makes explaining every
# cell × epoch in every bootstrap replicate below feasible.
#
# **SHAP interaction values** split each $\phi_j$ into a main effect $\phi_{jj}$ and pairwise terms
# $\phi_{jk}=\phi_{kj}$ (each holding half of the joint interaction) such that $\sum_k\phi_{jk}=\phi_j$. We store the
# mean $|\phi_{jk}|$ matrix (diagonal = main effects) globally and per zone; the strongest off-diagonal partner of a
# feature colours its dependence plot.
#
# **Additivity is checked, not assumed:** for every row, $\phi_0+\sum_j\phi_j$ must equal the raw margin
# `predict(output_margin=True)` within $10^{-3}$ (target units), otherwise the section stops.
#
# **What SHAP is not.** $\phi_j(x)$ says how far the *current value* of feature $j$ pushes this cell's prediction away
# from the average cell's prediction (a level), not how much the prediction would change if the feature moved (a
# slope). A cell whose NDVI is already past the cooling saturation has a large negative NDVI SHAP value but responds
# no further to more greening. SHAP explains the model, not causation.
#
# ## 4.2 Why cluster in SHAP space ("supervised clustering")
# Clustering raw features groups cells that *look* alike (e.g. all bright surfaces), regardless of whether
# that matters for temperature. Clustering the SHAP matrix groups cells whose **predicted temperature anomaly is
# attributed to the same features in similar amounts**: every coordinate is already expressed in the model's °C
# attribution, so no feature scaling is required and irrelevant features contribute ~0 distance. The resulting
# K-means clusters (K = 4, pooled over epochs so zones are comparable through time) are *governance zones*: areas
# with a similar current state relative to the average cell. This is **not** a measure of how responsive the zones
# are to interventions - that is estimated separately, per zone, with model counterfactuals (4.10, 4.14).
#
# **Zone-labelling heuristic** (canonical ids are fixed; names follow the SHAP signatures):
# 1. **3 · Heat Extreme Core** = the cluster with the highest mean total SHAP $\sum_j\phi_j$ (hottest predicted anomaly);
# 2. **1 · Riparian Buffer** = among the remaining three, the one with the most negative mean
#    $(\phi_{\text{frac\_water}}+\phi_{\text{ndwi}})$; if none of the three has a negative mean, the one with the highest
#    mean water fraction;
# 3. **0 · Ecological Cool Base** = of the remaining two, the one with the lower mean total SHAP;
# 4. **2 · Transition** = the last one.
#
# The water cluster is named before the cool/transition split, so a small, strongly water-cooled cluster becomes the
# Riparian Buffer rather than the Cool Base. The run prints which cluster got which name and why (also exported as
# `zones.json → labelling`).
#
# ## 4.3 Spatial block bootstrap
# Uncertainty of explanations comes mostly from *which places* the model learned from. Cells are spatially
# autocorrelated, so resampling rows would understate variance, and so do blocks smaller than the correlation
# range. The block size is `CFG.BOOT_BLOCK_KM` or, by default, the distance at which the correlogram of the
# spatial-CV XGBoost residuals (last epoch) drops below 0.1, rounded up to 5 km (at least `INNER_BLOCK_KM`, and
# shrunk if fewer than 50 blocks would remain). Blocks are resampled with replacement; each row inherits its block's
# multiplicity as a sample weight, and a fresh XGBoost model with `FINAL_ROUNDS` trees (no early stopping, so every
# replicate has the same capacity) is trained per replicate. Replicates are spread across the GPUs (`gpu_pool_map`).
# Each replicate is explained on the full data (GPU) or on ≤ 20k rows plus the whole last epoch (CPU) and
# **immediately reduced** to: global mean |SHAP|, binned dependence curves (fixed quantile bins), threshold
# estimates, last-epoch per-cell SHAP (float16) and the zone recommendation counterfactuals - so memory stays
# bounded however many replicates are run.
#
# **Intervals.** Replicates are refits on ~63 % of the unique blocks with duplicates as weights, so their estimates
# are biased relative to the full-data model (e.g. weak features get more mean |SHAP|). Plain percentile intervals
# assume no bias and then often exclude the full-data estimate. All intervals are therefore **bias-corrected
# percentile intervals**: the 2.5/97.5 percentiles of the replicate distribution re-centred on the full-data estimate,
# $[\hat\theta + q_{2.5} - \tilde\theta^*,\ \hat\theta + q_{97.5} - \tilde\theta^*]$ ($\tilde\theta^*$ = replicate median),
# which always contain $\hat\theta$; the bootstrap bias $\tilde\theta^* - \hat\theta$ is reported next to the estimate.
# With fewer than 50 replicates the 2.5/97.5 percentiles are essentially the extreme replicates, so the interval is
# labelled "replicate range" instead of "95% CI" (`BOOTSTRAP_INFO["ci_label"]`, `replicate_range = true`; both are
# exported to the manifest). The method code is `ci_method = "recentred-percentile"`.
#
# ## 4.4 Threshold definitions (binned mean SHAP curve, quantile bins fixed on the full data)
# Bins are `CFG.DEP_BINS` equal-count quantile bins; a value that holds ≥ 1/`DEP_BINS` of all rows (e.g.
# `frac_water = 0` in most cells, `frac_cropland = 1`, CONTAG = 100) gets a bin of its own and the other bins are
# quantiles of the remaining values — otherwise such point masses collapse the quantiles and leave a curve of only
# 2–3 points exactly where the effect of a rare land cover lives.
#
# * **zero_crossing** – x where the curve changes sign (linear interpolation). Reported only when the curve has a
#   single sign change, or one crossing whose jump |Δ| is at least twice that of every other; otherwise null with
#   `zero_crossing_flag = "multiple"`. Zero means "the prediction of the average cell" (the SHAP baseline), so a
#   crossing is where the feature stops pushing the prediction above/below average - not an intrinsic physical
#   threshold. Bootstrap replicates use the crossing nearest to the full-data one.
# * **breakpoint** – best continuous two-segment (hinge) weighted least-squares fit, hinge candidates between the
#   10th and 90th percentile bins; reported with the slopes before/after. It is withheld (null) when the hinge
#   explains < 10 % of the residual variance of a straight line (no real kink), when the best hinge sits at the edge
#   of the candidate range (a range limit, not a kink), or when either side has fewer than 5 bins or < 5 % of the rows.
# * **saturation** – after the steepest part of the smoothed curve, the first x where |slope| stays below 10 % of
#   its maximum for ≥ 3 bins; refined to the local level-off knee to remove the one-bin lag of the smoother.
# * **direction** – sign of Spearman ρ(x, SHAP); |ρ| < 0.2 → "mixed".
# * `<k>_support` = share of bootstrap replicates that produced the threshold. The interval `<k>_ci` is given only
#   when the point estimate exists and support ≥ 0.5; thresholds with support < 0.8 should be read as tentative.

# %%
import json
import math
import time
import warnings
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import xgboost as xgb

_K = len(FEATURES)
_EXPL_X = DF[FEATURES].to_numpy(dtype=np.float32)          # (N, K), row-aligned with DF
_EXPL_Y = DF[TARGET_COL].to_numpy(dtype=np.float32)
_YEARS = DF["year"].to_numpy().astype(np.int64)
_EPOCH_LIST = sorted(int(y) for y in np.unique(_YEARS))
_LAST_YEAR = _EPOCH_LIST[-1]
# Offset that converts target units back to °C (anomaly mode adds the epoch spatial mean back).
_EPOCH_OFFSET = (
    np.array([float(EPOCH_MEANS[int(y)]) for y in _YEARS], dtype=np.float64)
    if CFG.TARGET_MODE == "anomaly" else np.zeros(len(DF), dtype=np.float64)
)
_PRIMARY_DEVICE = xgb_device_for(0)
_MIN_PRED_BATCH = 16
_CPU_INTERACTION_CAP = 4000        # rows per epoch when the interaction pass has to run on the CPU
# sklearn-style or deprecated keys that must not reach xgb.train.
_XGB_NON_TRAIN_KEYS = {
    "n_estimators", "num_boost_round", "early_stopping_rounds", "n_jobs", "gpu_id", "predictor",
    "device", "random_state", "verbose", "enable_categorical", "callbacks",
}
_PRED_KWARGS = {
    "margin": {"output_margin": True},
    "contribs": {"pred_contribs": True},
    "interactions": {"pred_interactions": True},
}


def _final_xgb_params(device, seed):
    """Training parameters: CFG.XGB_PARAMS minus sklearn-only keys, forced to `hist` on `device`."""
    params = {k: v for k, v in dict(CFG.XGB_PARAMS).items() if k not in _XGB_NON_TRAIN_KEYS}
    params["tree_method"] = "hist"            # the only method that runs on both CUDA and CPU
    params.setdefault("objective", "reg:squarederror")
    params.setdefault("max_bin", 256)
    params["device"] = device
    params["seed"] = int(seed)
    params["verbosity"] = 0
    return params


def _train_once(X, y, weight, rounds, device, seed):
    params = _final_xgb_params(device, seed)
    # QuantileDMatrix sketches the histogram bins once without materialising a second copy of X.
    dtrain = xgb.QuantileDMatrix(X, label=y, weight=weight, max_bin=int(params["max_bin"]),
                                 feature_names=list(FEATURES))
    try:
        return xgb.train(params, dtrain, num_boost_round=int(rounds), verbose_eval=False)
    finally:
        del dtrain


def _train_booster(X, y, *, rounds, device, seed, weight=None):
    """Train an XGBoost booster; a CUDA out-of-memory error falls back to the CPU (host MemoryError propagates)."""
    try:
        return _train_once(X, y, weight, rounds, device, seed)
    except Exception as exc:
        if device == "cpu" or not is_gpu_oom_error(exc):
            raise
        log(f"GPU OOM while training on {device} ({exc}); retrying on CPU", "WARNING")
        return _train_once(X, y, weight, rounds, "cpu", seed)


def _iter_predict(booster, X, *, device, batch, kind, state=None):
    """Yield (start, stop, output) over row batches of X.

    kind: "margin" | "contribs" | "interactions". On an out-of-memory error the batch is halved and retried; once
    the batch is at its minimum a *GPU* OOM moves the booster to the CPU (recorded in ``state["cpu_fallback"]`` when a
    dict is passed, so callers can shrink the remaining work) and a host OOM propagates.
    """
    booster.set_param({"device": device})
    batch = max(_MIN_PRED_BATCH, int(batch))
    start, n = 0, len(X)
    while start < n:
        stop = min(n, start + batch)
        try:
            dmat = xgb.DMatrix(X[start:stop], missing=np.nan, feature_names=list(FEATURES))
            out = booster.predict(dmat, **_PRED_KWARGS[kind])
            del dmat
        except Exception as exc:
            gpu_oom = device != "cpu" and is_gpu_oom_error(exc)
            if not (gpu_oom or is_oom_error(exc)):
                raise
            if batch > _MIN_PRED_BATCH:
                batch = max(_MIN_PRED_BATCH, batch // 2)
                log(f"OOM in {kind} prediction; batch halved to {batch}", "WARNING")
            elif gpu_oom:
                device = "cpu"
                booster.set_param({"device": "cpu"})
                if state is not None:
                    state["cpu_fallback"] = True
                log(f"GPU OOM in {kind} prediction at minimum batch; falling back to CPU", "WARNING")
            else:
                raise
            continue
        yield start, stop, out
        start = stop


def _predict_all(booster, X, *, device, batch, kind):
    """Concatenate `_iter_predict` output into one float32 array."""
    parts = [out.astype(np.float32, copy=False) for _, _, out in
             _iter_predict(booster, X, device=device, batch=batch, kind=kind)]
    return np.concatenate(parts, axis=0)


# %% [markdown]
# ## 4.5 Final model (all rows)
# One pooled XGBoost model on every cell × epoch. The number of trees is 1.1 × the median early-stopping round
# of the spatial-CV folds (more data than any CV fold → slightly more trees), falling back to 800.

# %%
_final_best_rounds = [int(r) for r in (XGB_BEST_ROUNDS or []) if r is not None and int(r) > 0]
FINAL_ROUNDS = int(round(1.1 * float(np.median(_final_best_rounds)))) if _final_best_rounds else 800
log(f"Final model: {FINAL_ROUNDS} rounds (spatial-CV best rounds {_final_best_rounds or 'n/a'}), "
    f"{len(DF):,} rows x {_K} features on {_PRIMARY_DEVICE}")
with timer("04_final_model"):
    FINAL_MODEL = _train_booster(_EXPL_X, _EXPL_Y, rounds=FINAL_ROUNDS, device=_PRIMARY_DEVICE, seed=CFG.SEED)
    _FINAL_MARGIN = _predict_all(FINAL_MODEL, _EXPL_X, device=_PRIMARY_DEVICE,
                                 batch=CFG.SHAP_BATCH, kind="margin").astype(np.float64)

DF["lst_pred"] = (_FINAL_MARGIN + _EPOCH_OFFSET).astype(np.float32)
_oof = OOF_PRED.get("spatial", {}).get("xgboost")
if _oof is None or len(_oof) != len(DF):
    log("Spatial-CV XGBoost OOF predictions missing; lst_pred_oof is NaN", "WARNING")
    DF["lst_pred_oof"] = np.full(len(DF), np.nan, dtype=np.float32)
else:
    DF["lst_pred_oof"] = (np.asarray(_oof, dtype=np.float64) + _EPOCH_OFFSET).astype(np.float32)
DF["resid_oof"] = (DF["lst"].astype(np.float64) - DF["lst_pred_oof"].astype(np.float64)).astype(np.float32)
_train_rmse = float(np.sqrt(np.mean((DF["lst_pred"].to_numpy(np.float64) - DF["lst"].to_numpy(np.float64)) ** 2)))
_oof_rmse = float(np.sqrt(np.nanmean(DF["resid_oof"].to_numpy(np.float64) ** 2)))
log(f"Final model in-sample RMSE {_train_rmse:.3f} °C; spatial-CV OOF RMSE {_oof_rmse:.3f} °C")
free_memory()

# %% [markdown]
# ## 4.6 GPU TreeSHAP for every cell × epoch (additivity-checked)

# %%
with timer("04_treeshap"):
    _contribs = _predict_all(FINAL_MODEL, _EXPL_X, device=_PRIMARY_DEVICE, batch=CFG.SHAP_BATCH, kind="contribs")
    SHAP_VALUES = np.ascontiguousarray(_contribs[:, :_K], dtype=np.float32)
    _bias = _contribs[:, _K].astype(np.float64)
    SHAP_BASE = float(np.median(_bias))
    if float(np.ptp(_bias)) > 1e-4:
        log(f"SHAP bias column varies by {np.ptp(_bias):.2e} across rows (expected constant)", "WARNING")
    _additivity_err = float(np.max(np.abs(SHAP_VALUES.sum(axis=1, dtype=np.float64) + _bias - _FINAL_MARGIN)))
    del _contribs
    if not _additivity_err < 1e-3:
        raise RuntimeError(f"TreeSHAP additivity violated: max |phi0 + sum(phi) - margin| = {_additivity_err:.3e}")
    log(f"SHAP_VALUES {SHAP_VALUES.shape}, base {SHAP_BASE:.4f} (target units), "
        f"additivity max error {_additivity_err:.2e}")


def _crosscheck_with_shap_package(n_rows=300):
    """Compare XGBoost's native TreeSHAP with shap.TreeExplainer on a few rows (warn-only)."""
    try:
        import shap
    except ImportError:
        log("shap package not installed; skipping TreeExplainer cross-check")
        return None
    rows = np.random.default_rng(CFG.SEED).choice(len(DF), size=min(n_rows, len(DF)), replace=False)
    try:
        FINAL_MODEL.set_param({"device": "cpu"})
        explainer = shap.TreeExplainer(FINAL_MODEL)
        ref = np.asarray(explainer.shap_values(pd.DataFrame(_EXPL_X[rows], columns=FEATURES)), dtype=np.float64)
    except Exception as exc:  # shap/xgboost version skew must not break the pipeline
        log(f"shap.TreeExplainer cross-check skipped: {type(exc).__name__}: {exc}", "WARNING")
        return None
    finally:
        FINAL_MODEL.set_param({"device": _PRIMARY_DEVICE})
    diff = float(np.max(np.abs(ref - SHAP_VALUES[rows])))
    if diff > 1e-3:
        log(f"shap.TreeExplainer differs from XGBoost TreeSHAP by {diff:.2e} (> 1e-3)", "WARNING")
    else:
        log(f"shap.TreeExplainer cross-check OK on {len(rows)} rows (max diff {diff:.2e})")
    return diff


_SHAP_CROSSCHECK_DIFF = _crosscheck_with_shap_package()
free_memory()

# %% [markdown]
# ## 4.7 Governance zones: K-means in SHAP space
# K-means (K = 4, 20 initialisations) on the SHAP matrix pooled over all epochs — cuML on the GPU when RAPIDS
# is enabled (`LST_USE_RAPIDS=1`), otherwise scikit-learn. **K = 4 is fixed by the governance contract**; the
# diagnostics for K = 2..8 (inertia, silhouette on a fixed 20k-row sample; every K, including 4, fitted with the
# same 10 initialisations so the curves are comparable) are reported for transparency, not as evidence that 4 is
# optimal - the silhouette may well peak at another K.

# %%
_ZONE_META = [
    {"id": 0, "name": "Ecological Cool Base", "color": "#34d399"},
    {"id": 1, "name": "Riparian Buffer", "color": "#22d3ee"},
    {"id": 2, "name": "Transition", "color": "#a78bfa"},
    {"id": 3, "name": "Heat Extreme Core", "color": "#fb7185"},
]
_N_ZONES = 4
_DIAG_N_INIT = 10
if int(CFG.K_ZONES) != _N_ZONES:
    log(f"CFG.K_ZONES={CFG.K_ZONES} but the zone contract has 4 canonical zones; using K=4", "WARNING")


def _to_numpy(arr):
    """Host numpy array from numpy / cupy / cudf outputs."""
    if hasattr(arr, "to_numpy"):
        arr = arr.to_numpy()
    if hasattr(arr, "get"):
        arr = arr.get()
    return np.asarray(arr)


def _kmeans_fit(X, k, n_init, seed):
    """Return (labels int32, inertia) from cuML KMeans when enabled, else scikit-learn."""
    if ENV.get("has_cuml"):
        try:
            from cuml.cluster import KMeans as _CuKMeans
            model = _CuKMeans(n_clusters=k, n_init=n_init, random_state=seed, max_iter=300)
            model.fit(X)
            labels, inertia = _to_numpy(model.labels_).astype(np.int32), float(model.inertia_)
            ENV.setdefault("rapids_used", set()).add("cuml_kmeans")
            return labels, inertia
        except Exception as exc:
            log(f"cuML KMeans failed ({type(exc).__name__}: {exc}); using scikit-learn", "WARNING")
    from sklearn.cluster import KMeans
    model = KMeans(n_clusters=k, n_init=n_init, random_state=seed).fit(X)
    return model.labels_.astype(np.int32), float(model.inertia_)


def _relabel_zones(labels, shap_values, features, x_values):
    """Map raw cluster labels to canonical zone ids with the documented heuristic (4.2).

    Returns (zones int8, lut, info) where lut[raw_label] = canonical id and info documents, per cluster, the
    statistics the names were derived from.
    """
    raw_ids = np.unique(labels)
    if len(raw_ids) != _N_ZONES:
        raise ValueError(f"expected {_N_ZONES} non-empty clusters, got {len(raw_ids)}")
    jw, jn = features.index("frac_water"), features.index("ndwi")
    total = shap_values.sum(axis=1, dtype=np.float64)
    water = shap_values[:, jw].astype(np.float64) + shap_values[:, jn].astype(np.float64)
    frac_water = x_values[:, jw].astype(np.float64)
    stats = []
    for c in range(_N_ZONES):
        sel = labels == c
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            fw = float(np.nanmean(frac_water[sel])) if np.isfinite(frac_water[sel]).any() else float("nan")
        stats.append({"raw_cluster": c, "n": int(sel.sum()), "mean_total_shap": float(total[sel].mean()),
                      "mean_water_shap": float(water[sel].mean()), "mean_frac_water": fw})
    hot = int(np.argmax([s["mean_total_shap"] for s in stats]))
    rest = [c for c in range(_N_ZONES) if c != hot]
    negative = [c for c in rest if stats[c]["mean_water_shap"] < 0]
    if negative:
        riparian = min(negative, key=lambda c: stats[c]["mean_water_shap"])
        riparian_reason = "most negative mean SHAP(frac_water) + SHAP(ndwi) among the non-hottest clusters"
    else:
        riparian = max(rest, key=lambda c: (stats[c]["mean_frac_water"]
                                             if np.isfinite(stats[c]["mean_frac_water"]) else -np.inf))
        riparian_reason = ("no non-hottest cluster has a negative mean water SHAP: fallback to the highest mean "
                           "water fraction")
    rest2 = [c for c in rest if c != riparian]
    cool = min(rest2, key=lambda c: stats[c]["mean_total_shap"])
    transition = [c for c in rest2 if c != cool][0]
    lut = np.empty(_N_ZONES, dtype=np.int8)
    lut[cool], lut[riparian], lut[transition], lut[hot] = 0, 1, 2, 3
    reasons = {hot: "highest mean total SHAP", riparian: riparian_reason,
               cool: "lower mean total SHAP of the last two clusters", transition: "remaining cluster"}
    clusters = sorted(({**stats[c], "zone": int(lut[c]), "name": _ZONE_META[int(lut[c])]["name"],
                        "reason": reasons[c]} for c in range(_N_ZONES)), key=lambda d: d["zone"])
    info = {"rule": ("3 Heat Extreme Core = highest mean total SHAP; 1 Riparian Buffer = most negative mean "
                     "SHAP(frac_water)+SHAP(ndwi) among the other three (fallback: highest mean frac_water); "
                     "0 Ecological Cool Base = lower mean total SHAP of the last two; 2 Transition = the last one"),
            "clusters": clusters}
    return lut[labels].astype(np.int8), lut, info


def _silhouette(X, labels, sample_idx):
    from sklearn.metrics import silhouette_score
    return float(silhouette_score(X[sample_idx], labels[sample_idx]))


with timer("04_zoning"):
    _sil_idx = np.sort(np.random.default_rng(CFG.SEED).choice(len(DF), size=min(20000, len(DF)), replace=False))
    _raw_labels, _zone_inertia = _kmeans_fit(SHAP_VALUES, _N_ZONES, n_init=20, seed=CFG.SEED)
    ZONE_SILHOUETTE = _silhouette(SHAP_VALUES, _raw_labels, _sil_idx)
    ZONE_DIAGNOSTICS = {"k": [], "inertia": [], "silhouette": [], "n_init": _DIAG_N_INIT}
    for _k in range(2, 9):
        _lab_k, _in_k = _kmeans_fit(SHAP_VALUES, _k, n_init=_DIAG_N_INIT, seed=CFG.SEED)
        _sil_k = _silhouette(SHAP_VALUES, _lab_k, _sil_idx)
        ZONE_DIAGNOSTICS["k"].append(_k)
        ZONE_DIAGNOSTICS["inertia"].append(_in_k)
        ZONE_DIAGNOSTICS["silhouette"].append(_sil_k)
        log(f"  K={_k}: inertia {_in_k:,.1f}, silhouette {_sil_k:.3f}")
    _best_k = int(ZONE_DIAGNOSTICS["k"][int(np.argmax(ZONE_DIAGNOSTICS["silhouette"]))])
    log(f"Silhouette peaks at K={_best_k}; the zones use K=4 (governance contract), "
        f"zone fit with 20 initialisations: silhouette {ZONE_SILHOUETTE:.3f}")
    ZONES, _zone_lut, ZONE_LABELLING = _relabel_zones(_raw_labels, SHAP_VALUES, FEATURES, _EXPL_X)
    DF["zone"] = ZONES
    del _raw_labels, _lab_k
log(f"Zones (K=4, silhouette {ZONE_SILHOUETTE:.3f}): " + ", ".join(
    f"{m['name']}={int((ZONES == m['id']).sum()):,}" for m in _ZONE_META))
print("Zone labelling (" + ZONE_LABELLING["rule"] + "):")
for _c in ZONE_LABELLING["clusters"]:
    print(f"  {_c['zone']} {_c['name']:<22s} <- cluster {_c['raw_cluster']}: n={_c['n']:,}, "
          f"mean total SHAP {_c['mean_total_shap']:+.3f}, mean water+NDWI SHAP {_c['mean_water_shap']:+.3f}, "
          f"mean frac_water {_c['mean_frac_water']:.3f} [{_c['reason']}]")
free_memory()

# %% [markdown]
# ## 4.8 SHAP interaction values (streamed per epoch)
# `pred_interactions=True` returns an (n, K+1, K+1) tensor per batch. Each epoch is streamed batch by batch into
# float16 chunks written to `npz/shap_interactions_<year>.npz`, while |φ_jk| sums are accumulated globally and per
# zone in the same pass (zones are already known), so RAM stays bounded. On CPU the pass is limited to
# `CFG.SHAP_INTERACTION_MAX_ROWS` random rows per epoch; if a GPU pass has to fall back to the CPU part-way (GPU
# out of memory at the minimum batch), the rest of that epoch is subsampled to the same CPU cap and the event is
# recorded (`cpu_fallback_epochs`), so a fallback can never turn into hours of CPU work.

# %%
def _interaction_rows_for_epoch(year, rng):
    rows = np.flatnonzero(_YEARS == year)
    cap = CFG.SHAP_INTERACTION_MAX_ROWS
    if cap is not None and len(rows) > int(cap):
        rows = np.sort(rng.choice(rows, size=int(cap), replace=False))
    return rows


def _interaction_pass():
    """Stream interaction values for every epoch; return (global mean |phi|, per-zone mean |phi|, info)."""
    npz_dir = Path(CFG.NPZ_DIR)
    npz_dir.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(CFG.SEED + 7)
    batch = max(64, CFG.SHAP_BATCH // 16) if _PRIMARY_DEVICE != "cpu" else 256
    sum_all = np.zeros((_K, _K), dtype=np.float64)
    sum_zone = np.zeros((_N_ZONES, _K, _K), dtype=np.float64)
    n_zone = np.zeros(_N_ZONES, dtype=np.int64)
    acc = {"n_total": 0, "worst": 0.0}
    cpu_fallback_epochs = []

    def _consume(row_idx, inter, chunks):
        chunks.append((row_idx, inter.astype(np.float16)))
        # Interaction rows must sum back to the SHAP values (consistency of the decomposition).
        recon = inter[:, :_K, :].sum(axis=2, dtype=np.float64)
        acc["worst"] = max(acc["worst"], float(np.max(np.abs(recon - SHAP_VALUES[row_idx]))))
        mag = np.abs(inter[:, :_K, :_K]).astype(np.float64)
        sum_all[:] += mag.sum(axis=0)
        zb = ZONES[row_idx]
        for z in range(_N_ZONES):
            sel = zb == z
            if sel.any():
                sum_zone[z] += mag[sel].sum(axis=0)
                n_zone[z] += int(sel.sum())

    for year in _EPOCH_LIST:
        rows = _interaction_rows_for_epoch(year, rng)
        chunks = []
        state = {"cpu_fallback": False}
        gen = _iter_predict(FINAL_MODEL, _EXPL_X[rows], device=_PRIMARY_DEVICE, batch=batch,
                            kind="interactions", state=state)
        for start, stop, inter in gen:
            _consume(rows[start:stop], inter, chunks)
            del inter
            remaining = rows[stop:]
            if state["cpu_fallback"] and remaining.size > _CPU_INTERACTION_CAP:
                gen.close()
                keep = np.sort(rng.choice(remaining, size=_CPU_INTERACTION_CAP, replace=False))
                log(f"  interactions {year}: GPU fallback to CPU - subsampling the remaining {remaining.size:,} "
                    f"rows to {keep.size:,}", "WARNING")
                for s2, e2, inter2 in _iter_predict(FINAL_MODEL, _EXPL_X[keep], device="cpu", batch=256,
                                                    kind="interactions"):
                    _consume(keep[s2:e2], inter2, chunks)
                cpu_fallback_epochs.append(int(year))
                break
        FINAL_MODEL.set_param({"device": _PRIMARY_DEVICE})
        rows_used = np.concatenate([c[0] for c in chunks])
        store = np.concatenate([c[1] for c in chunks], axis=0)
        del chunks
        path = npz_dir / f"shap_interactions_{year}.npz"
        np.savez_compressed(path, interactions=store,
                            cell_id=DF["cell_id"].to_numpy()[rows_used].astype(np.int32),
                            features=np.array(list(FEATURES) + ["bias"]))
        acc["n_total"] += len(rows_used)
        log(f"  interactions {year}: {len(rows_used):,} rows -> {path.name} ({path.stat().st_size / 1e6:.1f} MB)")
        del store
        free_memory()
    if acc["worst"] > 1e-2:
        log(f"Interaction rows deviate from SHAP values by up to {acc['worst']:.3e}", "WARNING")
    glob = sum_all / max(acc["n_total"], 1)
    by_zone = {z: (sum_zone[z] / n_zone[z] if n_zone[z] else np.zeros((_K, _K))) for z in range(_N_ZONES)}
    return glob, by_zone, {"rows": acc["n_total"], "max_consistency_error": acc["worst"],
                           "cpu_fallback_epochs": cpu_fallback_epochs}


with timer("04_interactions"):
    INTERACTION_GLOBAL, INTERACTION_BY_ZONE, _INTERACTION_INFO = _interaction_pass()
    FINAL_MODEL.set_param({"device": _PRIMARY_DEVICE})
_offdiag = INTERACTION_GLOBAL.copy()
np.fill_diagonal(_offdiag, -np.inf)
_i, _j = np.unravel_index(np.argmax(_offdiag), _offdiag.shape)
log(f"Interactions on {_INTERACTION_INFO['rows']:,} rows; strongest pair {FEATURES[_i]} x {FEATURES[_j]} "
    f"(mean |phi| {INTERACTION_GLOBAL[_i, _j]:.4f})")
free_memory()


# %% [markdown]
# ## 4.9 Dependence curves and threshold estimators
# Pure functions shared by the final-model analysis and every bootstrap replicate. The final-model point
# estimates are computed here, before the bootstrap, because the recommendation planning (4.10) needs them.

# %%
def _quantile_edges(x, n_bins):
    """Quantile bin edges fixed on the full data, robust to point masses ("atoms"); ≥ 2 edges, no empty bin.

    Plain quantiles collapse when one value holds a large share of the data: `frac_water` is exactly 0 in ~95 %
    of cells, so 40 quantile edges reduce to 3 distinct values and the dependence curve (and every threshold)
    loses all resolution precisely where the water effect lives. Here every value holding ≥ 1/n_bins of the
    data (0 or 1 for land-cover fractions, 100 for single-class CONTAG, k/f² fractions at coarse grids) gets a bin
    of its own, and the remaining bins are equal-count quantiles of the other values. Continuous features have
    no atoms and get the ordinary quantile bins. Bins are [e_i, e_{i+1}) with the last one closed (`_bin_index`).
    """
    xf = np.asarray(x, dtype=np.float64)
    xf = xf[np.isfinite(xf)]
    if xf.size == 0:
        return np.array([0.0, 0.0])
    n_bins = max(1, int(n_bins))
    values, counts = np.unique(xf, return_counts=True)
    atoms = values[counts * n_bins >= xf.size]
    rest = xf[~np.isin(xf, atoms)] if atoms.size else xf
    parts = [values[[0, -1]], atoms, np.nextafter(atoms, np.inf)]      # [a, a⁺) isolates atom a
    if rest.size:
        n_rest = max(1, n_bins - atoms.size)
        parts.append(np.quantile(rest, np.linspace(0.0, 1.0, n_rest + 1)))
    edges = np.unique(np.concatenate(parts))
    if edges.size < 2:
        return np.array([edges[0], edges[0]])
    # Merge empty bins (e.g. the gap between an isolated atom and the first quantile of the rest) into their
    # lower neighbour so every bin has data and bootstrap curves stay aligned with the final-model curve.
    while edges.size > 2:
        occupied = np.bincount(_bin_index(xf, edges), minlength=edges.size - 1)
        empty = np.flatnonzero(occupied == 0)
        if empty.size == 0:
            break
        i = int(empty[0])
        edges = np.delete(edges, i if i > 0 else 1)
    # An atom inside the range splits a quantile bin in two and an atom at the maximum leaves a sliver bin just
    # below it, so the count can exceed n_bins: merge the smallest non-atom bin into its smaller non-atom
    # neighbour until at most n_bins remain (atom bins are never merged, so they stay pure).
    atom_set = set(atoms.tolist())
    while edges.size - 1 > n_bins:
        occupied = np.bincount(_bin_index(xf, edges), minlength=edges.size - 1)
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
            edges = np.delete(edges, max(b, n))          # the edge shared by bins b and n
            merged = True
            break
        if not merged:
            break
    return edges


def _bin_index(x, edges):
    """Bin id of each value (0..nb-1, the last bin is closed), -1 for NaN."""
    x = np.asarray(x, dtype=np.float64)
    nb = len(edges) - 1
    idx = np.clip(np.searchsorted(edges, x, side="right") - 1, 0, nb - 1)
    idx[~np.isfinite(x)] = -1
    return idx


def binned_curve(x, s, edges):
    """Binned mean of SHAP values s against feature x.

    Returns (centers, mean, counts): centers are the mean x inside each bin (edge midpoint if empty),
    mean is NaN for empty bins.
    """
    x = np.asarray(x, dtype=np.float64)
    s = np.asarray(s, dtype=np.float64)
    nb = len(edges) - 1
    idx = _bin_index(x, edges)
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


def _finite_curve(centers, mean, counts=None):
    c = np.asarray(centers, dtype=np.float64)
    m = np.asarray(mean, dtype=np.float64)
    ok = np.isfinite(c) & np.isfinite(m)
    if counts is not None:
        w = np.asarray(counts, dtype=np.float64)
        ok &= w > 0
        return c[ok], m[ok], w[ok]
    return c[ok], m[ok], np.ones(int(ok.sum()))


def _crossings(centers, mean):
    """All sign changes of the curve: (x of each crossing by linear interpolation, |jump| across it)."""
    c, m, _ = _finite_curve(centers, mean)
    if c.size < 2:
        return np.zeros(0), np.zeros(0)
    m0, m1 = m[:-1], m[1:]
    cross = np.flatnonzero(((m0 < 0) & (m1 >= 0)) | ((m0 > 0) & (m1 <= 0)))
    if cross.size == 0:
        return np.zeros(0), np.zeros(0)
    x = c[cross] - m[cross] * (c[cross + 1] - c[cross]) / (m[cross + 1] - m[cross])
    return x.astype(np.float64), np.abs(m1[cross] - m0[cross]).astype(np.float64)


def zero_crossing(centers, mean, ref=None, dominance=2.0):
    """x where the curve changes sign.

    Without ``ref``: the single crossing, or the crossing whose |jump| is ≥ ``dominance`` × every other one; None
    when there is no crossing or several comparable ones. With ``ref`` (bootstrap replicates): the crossing nearest
    to the full-data crossing ``ref``, so replicates never mix different crossings.
    """
    x, jump = _crossings(centers, mean)
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


def zero_crossing_is_multiple(centers, mean, dominance=2.0):
    """True when the curve has several sign changes and none of them dominates (zero_crossing -> None)."""
    x, jump = _crossings(centers, mean)
    if x.size < 2:
        return False
    top2 = np.sort(jump)[::-1][:2]
    return bool(top2[0] < dominance * top2[1])


def _hinge_fit(c, m, w, candidates):
    """Weighted continuous two-segment fit y = b0 + b1 x + b2 max(0, x - h) for each hinge h.

    Solved in closed form (batched 3x3 normal equations). Returns (sse per candidate, coefficients).
    """
    h = np.asarray(candidates, dtype=np.float64)[:, None]
    A = np.stack([np.ones((h.shape[0], c.size)), np.broadcast_to(c, (h.shape[0], c.size)),
                  np.maximum(0.0, c[None, :] - h)], axis=2)                  # (C, n, 3)
    Aw = A * w[None, :, None]
    ata = np.einsum("cni,cnj->cij", Aw, A) + 1e-12 * np.eye(3)[None]
    aty = np.einsum("cni,n->ci", Aw, m)
    beta = np.linalg.solve(ata, aty[..., None])[..., 0]                    # (C, 3)
    resid = m[None, :] - np.einsum("cni,ci->cn", A, beta)
    return (w[None, :] * resid ** 2).sum(axis=1), beta


_HINGE_MIN_SIDE_BINS = 5
_HINGE_MIN_SIDE_WEIGHT = 0.05


def hinge_breakpoint(centers, mean, counts):
    """Best continuous hinge (count-weighted least squares) with the hinge between the 10th-90th pct bins.

    Returns (breakpoint, slope_before, slope_after) or (None, None, None) when there are < 5 bins, the hinge removes
    < 10 % of the straight-line residual sum of squares (no real change of slope), the best hinge lies at the edge of
    the candidate range (a range limit, not a kink), or either side of it has < 5 bins or < 5 % of the row weight.
    """
    c, m, w = _finite_curve(centers, mean, counts)
    n = c.size
    if n < 5:
        return None, None, None
    lo, hi = max(1, int(np.floor(0.1 * (n - 1)))), min(n - 2, int(np.ceil(0.9 * (n - 1))))
    if hi <= lo:
        return None, None, None
    candidates = np.unique(np.concatenate([c[lo:hi + 1], np.linspace(c[lo], c[hi], 121)]))
    sse, beta = _hinge_fit(c, m, w, candidates)
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
    if (left.sum() < _HINGE_MIN_SIDE_BINS or right.sum() < _HINGE_MIN_SIDE_BINS
            or w[left].sum() < _HINGE_MIN_SIDE_WEIGHT * total_w or w[right].sum() < _HINGE_MIN_SIDE_WEIGHT * total_w):
        return None, None, None
    b1, b2 = float(beta[best, 1]), float(beta[best, 2])
    return h, b1, b1 + b2


def _smooth3(m):
    """Centered 3-bin running mean (edges use the available neighbours)."""
    num = np.convolve(m, np.ones(3), mode="same")
    den = np.convolve(np.ones_like(m), np.ones(3), mode="same")
    return num / den


def saturation_point(centers, mean):
    """First x after the steepest section where |smoothed slope| < 10% of its max for ≥ 3 consecutive bins.

    The detected flat-onset bin is refined to the level-off knee by a local hinge fit on the raw curve over
    the steep→flat transition (removes the ~1-bin lag introduced by the smoother).
    """
    c, m, _ = _finite_curve(centers, mean)
    if c.size < 5 or np.any(np.diff(c) <= 0):
        return None
    slope = np.abs(np.gradient(_smooth3(m), c))
    smax = float(np.max(slope))
    if not np.isfinite(smax) or smax <= 0:
        return None
    steep = int(np.argmax(slope))
    flat = slope < 0.1 * smax
    onset = next((j for j in range(steep + 1, c.size - 2) if flat[j:j + 3].all()), None)
    if onset is None:
        return None
    lo, hi = max(steep, onset - 4), min(c.size - 1, onset + 2)
    seg_c, seg_m = c[lo:hi + 1], m[lo:hi + 1]
    if seg_c.size < 4:
        return float(c[onset])
    candidates = np.linspace(c[lo], c[onset], 81)
    sse, _ = _hinge_fit(seg_c, seg_m, np.ones(seg_c.size), candidates)
    return float(candidates[int(np.argmin(sse))])


def effect_direction(x, s):
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


def _curve_thresholds(centers, mean, counts, zc_ref=None):
    """(zero_crossing, breakpoint, saturation) as floats with NaN for 'not found' (replicates pass zc_ref)."""
    zc = zero_crossing(centers, mean, ref=zc_ref)
    bp, _, _ = hinge_breakpoint(centers, mean, counts)
    sat = saturation_point(centers, mean)
    return [np.nan if v is None else v for v in (zc, bp, sat)]


# Fixed quantile bins on the full data (shared by the final model and all replicates).
_DEP_EDGES = [_quantile_edges(_EXPL_X[:, j], CFG.DEP_BINS) for j in range(_K)]
_DEP_BIN_IDX = [_bin_index(_EXPL_X[:, j], _DEP_EDGES[j]) for j in range(_K)]
_DEP_CURVES = [binned_curve(_EXPL_X[:, j], SHAP_VALUES[:, j], _DEP_EDGES[j]) for j in range(_K)]
_MAX_BINS = max(len(e) - 1 for e in _DEP_EDGES)


def _point_thresholds(j):
    centers, mean, counts = _DEP_CURVES[j]
    bp, slope_before, slope_after = hinge_breakpoint(centers, mean, counts)
    return {"zero_crossing": zero_crossing(centers, mean),
            "zero_crossing_multiple": zero_crossing_is_multiple(centers, mean),
            "breakpoint": bp, "slope_before": slope_before, "slope_after": slope_after,
            "saturation": saturation_point(centers, mean),
            "direction": effect_direction(_EXPL_X[:, j], SHAP_VALUES[:, j])}


_POINT_THRESHOLDS = [_point_thresholds(j) for j in range(_K)]
_ZC_REF = [np.nan if t["zero_crossing"] is None else float(t["zero_crossing"]) for t in _POINT_THRESHOLDS]

# %% [markdown]
# ## 4.10 Scenario coupling and zone recommendation planning (model counterfactuals)
# **Coupling.** The dashboard's scenario simulator can move a land-cover fraction and (in coupled mode) shift NDVI /
# NDWI / NDBI consistently. The coupling is the partial slope of each index on the five fractions (OLS with
# intercept, all cells × epochs), i.e. d index / d fraction holding the other fractions fixed; "other vegetation"
# (class 6, grass/shrub/wetland) is the omitted reference class.
#
# **Recommendations** are *plausible interventions* evaluated with the final model itself, not read off the pooled
# marginal SHAP curve (which ignores interactions and is not zone-specific):
# * **Levers**: the five land-cover fractions, NDVI (greening within the existing covers) and the three landscape
#   metrics. NDWI and NDBI are spectral diagnostics (`actionable = false`); they move only through land-cover change.
#   Allowed directions: impervious and barren only *decrease*, tree cover and water only *increase*, cropland, and the
#   landscape metrics either way; NDVI only increases and is not offered in water-dominated zones (median water
#   fraction > 0.15), where low NDVI is caused by the water itself.
# * **Counterfactual**: every cell of the zone (last epoch) is shifted by the same step (target − current). A fraction
#   change is compositional, exactly as in the dashboard: an increase takes land from the other four fractions and the
#   implicit other-vegetation share in proportion to their current values (capped by the land available), a decrease
#   gives the freed land to them in the same proportions; NDVI/NDWI/NDBI then follow through the coupling slopes
#   (clamped to [−1, 1]). NDVI and landscape metrics are shifted directly (clamped to their physical ranges).
# * **Feasibility**: the target may not go beyond the zone's own 90th percentile (increase) / 10th percentile
#   (decrease) of that feature, and the step is capped at 0.20 for fractions and 0.15 for NDVI.
# * **Target choice**: candidate targets are the feature's breakpoint and saturation (when inside the feasible range)
#   and a grid up to the feasibility bound; the recommended target is the *smallest* step that achieves ≥ 90 % of
#   the best cooling available within the bounds (so a saturating response stops at its saturation, and a
#   flat-then-steep response goes past its breakpoint).
# * **Effect**: expected Δ = mean over the zone's applicable cells of the change in the final model's prediction
#   (a model-based ceteris-paribus/ICE estimate, **associated with** the change, not a causal effect). Actions with
#   Δ > −0.05 °C are dropped; the best four (most negative Δ) are kept per zone. The interval comes from applying the
#   identical counterfactual to every bootstrap replicate (bias-corrected percentile interval, 4.3).

# %%
_COUPLING_FRACTIONS = ["frac_impervious", "frac_forest", "frac_water", "frac_cropland", "frac_barren"]
_COUPLED_INDICES = ["ndvi", "ndwi", "ndbi"]


def _scenario_coupling():
    cols = [FEATURES.index(f) for f in _COUPLING_FRACTIONS]
    coupling = {f: {} for f in _COUPLING_FRACTIONS}
    r2, intercept, n_used = {}, {}, {}
    for index in _COUPLED_INDICES:
        y = _EXPL_X[:, FEATURES.index(index)].astype(np.float64)
        A = _EXPL_X[:, cols].astype(np.float64)
        ok = np.isfinite(y) & np.isfinite(A).all(axis=1)
        design = np.column_stack([np.ones(int(ok.sum())), A[ok]])
        beta, *_ = np.linalg.lstsq(design, y[ok], rcond=None)
        resid = y[ok] - design @ beta
        sst = float(np.sum((y[ok] - y[ok].mean()) ** 2))
        r2[index] = 1.0 - float(np.sum(resid ** 2)) / sst if sst > 0 else None
        intercept[index] = float(beta[0])
        n_used[index] = int(ok.sum())
        for k, f in enumerate(_COUPLING_FRACTIONS):
            coupling[f][index] = float(beta[k + 1])
    return {
        "description": ("Partial OLS slopes (d index / d fraction) of NDVI, NDWI and NDBI on the five land-cover "
                        "fractions (with intercept; other vegetation is the omitted reference class), fitted on "
                        "all cells and epochs. Used by the coupled scenario mode: when a fraction changes, the land "
                        "is exchanged with the other fractions and the implicit other-vegetation share in "
                        "proportion to their current values, and each index shifts by the sum of slope x actual "
                        "fraction change."),
        "fraction_features": list(_COUPLING_FRACTIONS),
        "coupling": coupling, "r2": r2, "intercept": intercept, "n": n_used,
    }


SCENARIO_COUPLING = _scenario_coupling()
print(pd.DataFrame(SCENARIO_COUPLING["coupling"]).T.round(3).to_string())
print("R2:", {k: (round(v, 3) if v is not None else None) for k, v in SCENARIO_COUPLING["r2"].items()})


def rebalance_fractions(F, k, delta):
    """Compositional change of fraction column ``k`` by ``delta`` for every row of ``F`` (n, 5).

    Mirrors the dashboard's `rebalanceFractions` (SPEC 4.8) with the implicit other-vegetation share
    ``1 - sum(F)`` as a sixth donor/recipient: an increase is capped by the land the others can give up and taken
    from them in proportion to their current values; a decrease (capped at the current value) gives the freed land to
    them in the same proportions (equally when they are all 0). Returns (F_after, other_after, applied).
    """
    F = np.asarray(F, dtype=np.float64)
    x = F[:, k]
    other = np.clip(1.0 - F.sum(axis=1), 0.0, None)
    donors = np.column_stack([np.delete(F, k, axis=1), other])              # (n, 5): 4 fractions + other veg
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


_FRAC_COLS = [FEATURES.index(f) for f in _COUPLING_FRACTIONS]
_FEATURE_BOUNDS = {"ndvi": (-1.0, 1.0), "ndwi": (-1.0, 1.0), "ndbi": (-1.0, 1.0), "lm_contag": (0.0, 100.0),
                   "lm_pd": (0.0, np.inf), "lm_ed": (0.0, np.inf),
                   **{f: (0.0, 1.0) for f in _COUPLING_FRACTIONS}}


def counterfactual(X, feature, step, coupled=True):
    """Shift ``feature`` by ``step`` in every row of X (n, K) -> (X_cf float32, applicable bool mask, donor info).

    Fractions: compositional (``rebalance_fractions``) and, when ``coupled``, NDVI/NDWI/NDBI shift by the coupling
    slopes × the actual fraction changes. Other levers: direct shift clamped to their physical range. Rows where the
    feature (or, for fractions, any fraction) is missing are left unchanged and flagged not applicable.
    """
    X = np.asarray(X, dtype=np.float32)
    j = FEATURES.index(feature)
    Xcf = X.astype(np.float64, copy=True)
    ok = np.isfinite(Xcf[:, j])
    donors = {}
    if feature in _COUPLING_FRACTIONS:
        ok &= np.isfinite(Xcf[:, _FRAC_COLS]).all(axis=1)
        F = Xcf[np.ix_(ok, _FRAC_COLS)]
        other_before = np.clip(1.0 - F.sum(axis=1), 0.0, None)
        F_after, other_after, _ = rebalance_fractions(F, _COUPLING_FRACTIONS.index(feature), float(step))
        Xcf[np.ix_(ok, _FRAC_COLS)] = F_after
        d_frac = F_after - F
        donors = {f: float(d_frac[:, i].mean()) for i, f in enumerate(_COUPLING_FRACTIONS)
                  if f != feature and d_frac.size}
        donors["other_vegetation"] = float((other_after - other_before).mean()) if d_frac.size else 0.0
        if coupled:
            for index in _COUPLED_INDICES:
                ji = FEATURES.index(index)
                slopes = np.array([SCENARIO_COUPLING["coupling"][f][index] for f in _COUPLING_FRACTIONS])
                shift = d_frac @ slopes
                old = Xcf[ok, ji]
                Xcf[ok, ji] = np.where(np.isfinite(old), np.clip(old + shift, -1.0, 1.0), old)
    else:
        lo, hi = _FEATURE_BOUNDS.get(feature, (-np.inf, np.inf))
        Xcf[ok, j] = np.clip(Xcf[ok, j] + float(step), lo, hi)
    return Xcf.astype(np.float32), ok, donors


_REC_DIRECTIONS = {"frac_impervious": ("decrease",), "frac_barren": ("decrease",), "frac_forest": ("increase",),
                   "frac_water": ("increase",), "frac_cropland": ("increase", "decrease"), "ndvi": ("increase",),
                   "lm_pd": ("increase", "decrease"), "lm_ed": ("increase", "decrease"),
                   "lm_contag": ("increase", "decrease")}
_REC_MAX_STEP = {**{f: 0.20 for f in _COUPLING_FRACTIONS}, "ndvi": 0.15}
_REC_MIN_COOLING_C = 0.05          # drop actions whose expected Δ is > -0.05 °C
_REC_EFFICIENCY = 0.90             # smallest step achieving >= 90 % of the best cooling within the bounds
_REC_WATER_ZONE = 0.15             # zone median water fraction above which NDVI greening is not offered
_REC_MAX_PER_ZONE = 4
_REC_LEVERS = [f for f in FEATURES if FEATURE_META.get(f, {}).get("actionable")]
_unknown_levers = [f for f in _REC_LEVERS if f not in _REC_DIRECTIONS]
if _unknown_levers:
    log(f"actionable features without an intervention rule are not recommended: {_unknown_levers}", "WARNING")


def _zone_rows(zone):
    rows = np.flatnonzero((ZONES == zone) & (_YEARS == _LAST_YEAR))
    return rows if rows.size >= 10 else np.flatnonzero(ZONES == zone)


def _margin(booster, X, device):
    return _predict_all(booster, X, device=device, batch=CFG.SHAP_BATCH, kind="margin").astype(np.float64)


def _plan_zone(zone):
    """Candidate actions for one zone evaluated with the final model; returns plans sorted by Δ (best first)."""
    rows = _zone_rows(zone)
    X = _EXPL_X[rows]
    base = _FINAL_MARGIN[rows]
    jw = FEATURES.index("frac_water")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        water_median = float(np.nanmedian(X[:, jw])) if np.isfinite(X[:, jw]).any() else 0.0
    plans = []
    for feature in _REC_LEVERS:
        if feature not in _REC_DIRECTIONS:
            continue
        if feature == "ndvi" and water_median > _REC_WATER_ZONE:
            continue
        j = FEATURES.index(feature)
        vals = X[:, j][np.isfinite(X[:, j])].astype(np.float64)
        if vals.size < 10:
            continue
        current = float(np.median(vals))
        p10, p90 = (float(v) for v in np.percentile(vals, [10, 90]))
        stats = FEATURE_STATS[feature]
        min_step = max(1e-6, 0.01 * (float(stats["p99"]) - float(stats["p01"])))
        lo_phys, hi_phys = _FEATURE_BOUNDS.get(feature, (-np.inf, np.inf))
        cap = _REC_MAX_STEP.get(feature, np.inf)
        th = _POINT_THRESHOLDS[j]
        best_plan = None
        for direction in _REC_DIRECTIONS[feature]:
            if direction == "increase":
                bound = min(p90, current + cap, hi_phys)
                if bound - current < min_step:
                    continue
                inside = lambda t: current + min_step <= t <= bound  # noqa: E731
            else:
                bound = max(p10, current - cap, lo_phys)
                if current - bound < min_step:
                    continue
                inside = lambda t: bound <= t <= current - min_step  # noqa: E731
            cands = [(current + (bound - current) * q, "partial") for q in (0.25, 0.5, 0.75)] + [(bound, "bound")]
            cands += [(float(th[k]), k) for k in ("breakpoint", "saturation")
                      if th[k] is not None and inside(float(th[k]))]
            results = []
            for target, kind in cands:
                Xcf, ok, donors = counterfactual(X, feature, target - current)
                if not ok.any():
                    continue
                pred = _margin(FINAL_MODEL, Xcf[ok], _PRIMARY_DEVICE)
                results.append({"target": float(target), "kind": kind, "delta": float(np.mean(pred - base[ok])),
                                "n_cells": int(ok.sum()), "donors": donors})
            if not results:
                continue
            best = min(r["delta"] for r in results)
            if not best < -_REC_MIN_COOLING_C:
                continue
            good = [r for r in results if r["delta"] <= _REC_EFFICIENCY * best]
            # smallest step first; on ties prefer a named threshold over a grid point
            chosen = min(good, key=lambda r: (abs(r["target"] - current), r["kind"] not in ("saturation", "breakpoint")))
            plan = {"zone": int(zone), "feature": feature, "j": j, "action": direction, "current": current,
                    "target": chosen["target"], "step": chosen["target"] - current, "kind": chosen["kind"],
                    "expected_delta_c": chosen["delta"], "best_delta_c": best, "n_cells": chosen["n_cells"],
                    "donors": chosen["donors"], "p10": p10, "p90": p90, "bound": bound, "rows": rows}
            if best_plan is None or plan["expected_delta_c"] < best_plan["expected_delta_c"]:
                best_plan = plan
        if best_plan is not None:
            plans.append(best_plan)
    plans.sort(key=lambda p: p["expected_delta_c"])
    return plans[:_REC_MAX_PER_ZONE]


with timer("04_recommendation_planning"):
    _REC_PLAN = [p for m in _ZONE_META for p in _plan_zone(m["id"])]
    FINAL_MODEL.set_param({"device": _PRIMARY_DEVICE})
# Pre-built counterfactual matrices (identical for the final model and every bootstrap replicate).
_REC_BASE_ROWS = np.unique(np.concatenate([p["rows"] for p in _REC_PLAN])) if _REC_PLAN else np.zeros(0, np.int64)
_REC_XCF, _REC_SLICES = [], []
for _p in _REC_PLAN:
    _xcf, _ok, _ = counterfactual(_EXPL_X[_p["rows"]], _p["feature"], _p["step"])
    _p["applicable"] = _ok
    _p["base_pos"] = np.searchsorted(_REC_BASE_ROWS, _p["rows"][_ok])
    _start = sum(len(x) for x in _REC_XCF)
    _REC_XCF.append(_xcf[_ok])
    _REC_SLICES.append(slice(_start, _start + int(_ok.sum())))
_REC_XCF = np.concatenate(_REC_XCF, axis=0) if _REC_XCF else np.zeros((0, _K), np.float32)
del _p


def _plan_deltas(booster, device):
    """Mean prediction change of every planned action under ``booster`` (same counterfactuals for all models)."""
    if not _REC_PLAN:
        return np.zeros(0)
    base = _margin(booster, _EXPL_X[_REC_BASE_ROWS], device)
    cf = _margin(booster, _REC_XCF, device)
    return np.array([float(np.mean(cf[sl] - base[p["base_pos"]])) for p, sl in zip(_REC_PLAN, _REC_SLICES)])


_REC_FINAL_DELTAS = _plan_deltas(FINAL_MODEL, _PRIMARY_DEVICE)
FINAL_MODEL.set_param({"device": _PRIMARY_DEVICE})
for _p, _d in zip(_REC_PLAN, _REC_FINAL_DELTAS):
    if abs(_d - _p["expected_delta_c"]) > 1e-4:
        log(f"recommendation {_p['zone']}/{_p['feature']}: replayed delta {_d:.5f} != planned "
            f"{_p['expected_delta_c']:.5f}", "WARNING")
    _p["expected_delta_c"] = float(_d)
log(f"Recommendation plan: {len(_REC_PLAN)} action(s) over {_N_ZONES} zones, "
    f"{len(_REC_XCF):,} counterfactual rows per model")

# %% [markdown]
# ## 4.11 Spatial block bootstrap (multi-GPU)
# The block size comes from the residual correlogram (4.3) unless `CFG.BOOT_BLOCK_KM` is set.

# %%
_BOOT_ON_GPU = _PRIMARY_DEVICE != "cpu"
_boot_rng = np.random.default_rng(CFG.SEED + 1000)
_rows_last = np.flatnonzero(_YEARS == _LAST_YEAR)
if _BOOT_ON_GPU:
    _rows_sample = np.arange(len(DF))
else:  # CPU: explain a fixed ≤20k-row sample plus the complete last epoch
    _rows_sample = np.sort(_boot_rng.choice(len(DF), size=min(20000, len(DF)), replace=False))
_BOOT_EVAL_IDX = np.union1d(_rows_sample, _rows_last)
_BOOT_POS_S = np.searchsorted(_BOOT_EVAL_IDX, _rows_sample)
_BOOT_POS_L = np.searchsorted(_BOOT_EVAL_IDX, _rows_last)
_BOOT_BIN_IDX_S = [idx[_rows_sample] for idx in _DEP_BIN_IDX]
_BOOT_COUNTS_S = [np.bincount(idx[idx >= 0], minlength=len(_DEP_EDGES[j]) - 1)
                  for j, idx in enumerate(_BOOT_BIN_IDX_S)]
_BOOT_MIN_BLOCKS = 50


def _residual_correlogram(max_points=3000, bin_km=5.0, max_km=100.0):
    """Pair correlogram of the standardised last-epoch spatial-CV residuals (target anomaly if OOF is missing).

    Returns (bin upper edges in km, correlation per bin, variable name).
    """
    rows = _rows_last
    values = DF["resid_oof"].to_numpy(np.float64)[rows]
    name = "spatial-CV XGBoost residual"
    if np.isfinite(values).sum() < 100:
        values, name = _EXPL_Y[rows].astype(np.float64), "target"
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


def _block_ids(block_km):
    b = max(1, int(round(float(block_km) * 1000.0 / float(GRID.res))))
    n_cols = int(math.ceil(GRID.width / b))
    rows, cols = DF["row"].to_numpy(np.int64), DF["col"].to_numpy(np.int64)
    return (rows // b) * n_cols + cols // b


def _choose_bootstrap_blocks():
    """(block codes per row, block ids, block size km, info) following 4.3."""
    info = {}
    if CFG.BOOT_BLOCK_KM:
        block_km, source = float(CFG.BOOT_BLOCK_KM), "CFG.BOOT_BLOCK_KM"
    else:
        upper, corr, name = _residual_correlogram()
        below = np.flatnonzero(np.isfinite(corr) & (corr < 0.1))
        range_km = float(upper[below[0]] - 2.5) if below.size else float(upper[-1])
        info = {"residual_corr_range_km": range_km, "correlogram_variable": name,
                "correlogram": {f"{u - 5:.0f}-{u:.0f}": (None if not np.isfinite(c) else round(float(c), 3))
                                for u, c in zip(upper[:12], corr[:12])}}
        block_km = max(float(CFG.INNER_BLOCK_KM), 5.0 * math.ceil(range_km / 5.0))
        source = f"{name} correlogram (< 0.1 beyond ~{range_km:.0f} km)"
        log(f"Residual correlogram ({name}): " + ", ".join(f"{k} km {v}" for k, v in info["correlogram"].items()))
    codes, ids = pd.factorize(_block_ids(block_km), sort=True)
    while len(ids) < _BOOT_MIN_BLOCKS and block_km - 5.0 >= float(CFG.INNER_BLOCK_KM) and not CFG.BOOT_BLOCK_KM:
        block_km -= 5.0
        codes, ids = pd.factorize(_block_ids(block_km), sort=True)
        source += f"; shrunk to keep >= {_BOOT_MIN_BLOCKS} blocks"
    if len(ids) < _BOOT_MIN_BLOCKS:
        log(f"Only {len(ids)} bootstrap blocks of {block_km:.0f} km (< {_BOOT_MIN_BLOCKS}); intervals will be "
            "coarse", "WARNING")
    return codes, len(ids), block_km, {**info, "block_size_source": source}


_block_codes, _N_BLOCKS, _BOOT_BLOCK_KM, _BOOT_BLOCK_INFO = _choose_bootstrap_blocks()
log(f"Bootstrap blocks: {_N_BLOCKS} blocks of {_BOOT_BLOCK_KM:.0f} km ({_BOOT_BLOCK_INFO['block_size_source']})")


def _replicate_curves(shap_sample):
    """Binned mean curves (K, _MAX_BINS) and thresholds (K, 3) for one replicate's SHAP sample."""
    curves = np.full((_K, _MAX_BINS), np.nan)
    thresholds = np.full((_K, 3), np.nan)
    for j in range(_K):
        idx = _BOOT_BIN_IDX_S[j]
        ok = idx >= 0
        nb = len(_DEP_EDGES[j]) - 1
        counts = _BOOT_COUNTS_S[j]
        sums = np.bincount(idx[ok], weights=shap_sample[ok, j].astype(np.float64), minlength=nb)
        with np.errstate(invalid="ignore", divide="ignore"):
            mean = np.where(counts > 0, sums / np.maximum(counts, 1), np.nan)
        curves[j, :nb] = mean
        thresholds[j] = _curve_thresholds(_DEP_CURVES[j][0], mean, counts, zc_ref=_ZC_REF[j])
    return curves, thresholds


def _bootstrap_replicate(b, gpu_id):
    """Train one block-bootstrap replicate on `gpu_id` and reduce its SHAP values immediately."""
    t0 = time.time()
    device = xgb_device_for(gpu_id) if _BOOT_ON_GPU else "cpu"
    try:
        rng = np.random.default_rng(CFG.SEED + b)
        multiplicity = np.bincount(rng.integers(0, _N_BLOCKS, _N_BLOCKS), minlength=_N_BLOCKS)[_block_codes]
        rows = np.flatnonzero(multiplicity)
        booster = _train_booster(_EXPL_X[rows], _EXPL_Y[rows], weight=multiplicity[rows].astype(np.float32),
                                 rounds=FINAL_ROUNDS, device=device, seed=CFG.SEED + b)
        contribs = _predict_all(booster, _EXPL_X[_BOOT_EVAL_IDX], device=device,
                                batch=CFG.SHAP_BATCH, kind="contribs")
        rec_deltas = _plan_deltas(booster, device)
        del booster
        shap_eval = contribs[:, :_K]
        shap_sample = shap_eval[_BOOT_POS_S]
        curves, thresholds = _replicate_curves(shap_sample)
        result = {
            "ok": True, "b": b, "device": device,
            "mean_abs": np.abs(shap_sample).mean(axis=0, dtype=np.float64),
            "curves": curves, "thresholds": thresholds, "rec_deltas": rec_deltas,
            "last": shap_eval[_BOOT_POS_L].astype(np.float16),
            "seconds": time.time() - t0,
        }
        del contribs, shap_eval, shap_sample
        log(f"  bootstrap {b + 1}/{CFG.N_BOOTSTRAP} on {device}: {len(rows):,} rows, {result['seconds']:.1f}s")
        return result
    except Exception as exc:
        log(f"  bootstrap replicate {b} failed on {device}: {type(exc).__name__}: {exc}", "WARNING")
        return {"ok": False, "b": b, "device": device, "error": f"{type(exc).__name__}: {exc}"}


def _recentred_interval(theta_hat, boot, lower=None):
    """Bias-corrected percentile interval (4.3), elementwise over the leading replicate axis of ``boot``.

    Returns (lo, hi, bias) with lo/hi = theta_hat + q2.5/q97.5 - median and bias = median - theta_hat; NaN where
    fewer than 2 finite replicates exist. ``lower`` clips the interval (e.g. 0 for mean |SHAP|).
    """
    boot = np.asarray(boot, dtype=np.float64)
    theta_hat = np.asarray(theta_hat, dtype=np.float64)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        n_ok = np.isfinite(boot).sum(axis=0)
        q_lo, q_med, q_hi = np.nanpercentile(boot, [2.5, 50.0, 97.5], axis=0)
    lo, hi = theta_hat + (q_lo - q_med), theta_hat + (q_hi - q_med)
    bad = n_ok < 2
    lo, hi = np.where(bad, np.nan, lo), np.where(bad, np.nan, hi)
    if lower is not None:
        lo = np.maximum(lo, lower)
    return lo, hi, np.where(bad, np.nan, q_med - theta_hat)


with timer("04_bootstrap"):
    log(f"Block bootstrap: {CFG.N_BOOTSTRAP} replicates x {FINAL_ROUNDS} rounds, {_N_BLOCKS} blocks of "
        f"{_BOOT_BLOCK_KM:.0f} km, explaining {len(_BOOT_EVAL_IDX):,} rows per replicate "
        f"({'GPU, full data' if _BOOT_ON_GPU else 'CPU, sampled'}; {max(1, ENV.get('n_gpus', 0))} worker(s))")
    _boot_results = gpu_pool_map(_bootstrap_replicate, list(range(int(CFG.N_BOOTSTRAP))))
    _boot_ok = [r for r in _boot_results if r is not None and r.get("ok")]
    _boot_failed = [r for r in _boot_results if r is None or not r.get("ok")]
    if not _boot_ok:
        raise RuntimeError(f"All {CFG.N_BOOTSTRAP} bootstrap replicates failed: "
                           f"{[r.get('error') for r in _boot_failed if r]}")
    _BOOT_MEAN_ABS = np.stack([r["mean_abs"] for r in _boot_ok])            # (B, K)
    _BOOT_CURVES = np.stack([r["curves"] for r in _boot_ok])                # (B, K, bins)
    _BOOT_THRESHOLDS = np.stack([r["thresholds"] for r in _boot_ok])        # (B, K, 3)
    _BOOT_REC_DELTAS = np.stack([r["rec_deltas"] for r in _boot_ok])        # (B, n_plan)
    _boot_last = np.stack([r["last"] for r in _boot_ok])                    # (B, n_last, K) float16
    del _boot_results
    free_memory()

    _ci_cols = {"cell_id": DF["cell_id"].to_numpy()[_rows_last].astype(np.int32)}
    for _jj, _f in enumerate(FEATURES):
        _lo, _hi, _ = _recentred_interval(SHAP_VALUES[_rows_last, _jj], _boot_last[:, :, _jj].astype(np.float32))
        _ci_cols[f"{_f}_lo"] = _lo.astype(np.float32)
        _ci_cols[f"{_f}_hi"] = _hi.astype(np.float32)
    SHAP_CI_LATEST = pd.DataFrame(_ci_cols)
    del _boot_last, _ci_cols
    _n_boot = len(_boot_ok)
    BOOTSTRAP_INFO = {
        "n": _n_boot, "n_requested": int(CFG.N_BOOTSTRAP), "mode": "block",
        "block_size_km": float(_BOOT_BLOCK_KM), "n_blocks": int(_N_BLOCKS), "rounds": int(FINAL_ROUNDS),
        **_BOOT_BLOCK_INFO,
        "ci_level": 0.95,
        "ci_method": "recentred-percentile",
        "ci_method_description": ("bias-corrected percentile interval: the 2.5/97.5 replicate percentiles shifted by "
                                  "(full-data estimate - replicate median); always contains the estimate"),
        "ci_label": "95% CI" if _n_boot >= 50 else "replicate range",
        "replicate_range": bool(_n_boot < 50),
        "eval_rows": int(len(_BOOT_EVAL_IDX)), "full_data": bool(_BOOT_ON_GPU),
        "rows_sampled": not bool(_BOOT_ON_GPU),
        "devices": sorted({r["device"] for r in _boot_ok}),
        "mean_seconds": float(np.mean([r["seconds"] for r in _boot_ok])),
        "failures": [{"b": r.get("b"), "error": r.get("error")} for r in _boot_failed if r],
    }
    del _boot_ok, _boot_failed
log(f"Bootstrap done: {BOOTSTRAP_INFO['n']}/{BOOTSTRAP_INFO['n_requested']} replicates OK "
    f"({BOOTSTRAP_INFO['mean_seconds']:.1f}s each, devices {BOOTSTRAP_INFO['devices']}); intervals labelled "
    f"'{BOOTSTRAP_INFO['ci_label']}'" + ("" if _BOOT_ON_GPU else "; CPU: interval spreads come from a 20k-row sample"))
if BOOTSTRAP_INFO["n"] < 50:
    log(f"Only {BOOTSTRAP_INFO['n']} bootstrap replicates: the 2.5/97.5 percentiles are close to the extreme "
        "replicates, so intervals are reported as a 'replicate range', not a 95% CI", "WARNING")
free_memory()

# %% [markdown]
# ## 4.12 SHAP importance (global with bootstrap interval, by epoch, by zone)

# %%
def _importance_block(mask):
    sv = SHAP_VALUES[mask].astype(np.float64)
    return {"mean_abs": np.abs(sv).mean(axis=0).tolist(), "mean": sv.mean(axis=0).tolist()}


_imp_full = np.abs(SHAP_VALUES).mean(axis=0, dtype=np.float64)
# Bias reference: the final model on the same rows the replicates were explained on (all rows on GPU).
_imp_ref = np.abs(SHAP_VALUES[_rows_sample]).mean(axis=0, dtype=np.float64)
_imp_lo, _imp_hi, _ = _recentred_interval(_imp_full, _BOOT_MEAN_ABS, lower=0.0)
with warnings.catch_warnings():
    warnings.simplefilter("ignore", RuntimeWarning)
    _imp_bias = np.nanmedian(_BOOT_MEAN_ABS, axis=0) - _imp_ref
SHAP_IMPORTANCE = {
    "global": {"mean_abs": _imp_full.tolist(), "ci_lo": _imp_lo.tolist(), "ci_hi": _imp_hi.tolist(),
               "bias": _imp_bias.tolist()},
    "by_epoch": {y: _importance_block(_YEARS == y) for y in _EPOCH_LIST},
    "by_zone": {z: _importance_block(ZONES == z) for z in range(_N_ZONES) if (ZONES == z).any()},
}
_IMPORTANCE_ORDER = list(np.argsort(SHAP_IMPORTANCE["global"]["mean_abs"])[::-1])
for _r, _jj in enumerate(_IMPORTANCE_ORDER[:10], start=1):
    print(f"{_r:2d}. {FEATURES[_jj]:<16s} mean|SHAP| {SHAP_IMPORTANCE['global']['mean_abs'][_jj]:.3f} °C "
          f"({BOOTSTRAP_INFO['ci_label']} {SHAP_IMPORTANCE['global']['ci_lo'][_jj]:.3f}-"
          f"{SHAP_IMPORTANCE['global']['ci_hi'][_jj]:.3f}; bootstrap bias {SHAP_IMPORTANCE['global']['bias'][_jj]:+.3f})")

# %% [markdown]
# ## 4.13 Dependence curves, thresholds with bootstrap intervals, and planted-vs-recovered validation

# %%
def _boot_ci(values, point):
    """(interval, support) for one threshold: support = share of replicates with a finite value; the interval
    (bias-corrected percentile, re-centred on ``point``) only when the point exists and support >= 0.5."""
    v = np.asarray(values, dtype=np.float64)
    support = float(np.isfinite(v).mean()) if v.size else 0.0
    if point is None or support < 0.5 or np.isfinite(v).sum() < 2:
        return None, (None if point is None else support)
    lo, hi, _ = _recentred_interval(np.array([float(point)]), v[:, None])
    return [float(lo[0]), float(hi[0])], support


def _none_if_nan(v):
    return None if v is None or not np.isfinite(v) else float(v)


def _scatter_sample(j, partner, rng, max_points=1500):
    """≤ max_points rows with finite x, stratified equally across epochs."""
    per_epoch = max_points // len(_EPOCH_LIST)
    picks = []
    for year in _EPOCH_LIST:
        rows = np.flatnonzero((_YEARS == year) & np.isfinite(_EXPL_X[:, j]))
        if rows.size:
            picks.append(rng.choice(rows, size=min(per_epoch, rows.size), replace=False))
    rows = np.sort(np.concatenate(picks)) if picks else np.array([], dtype=np.int64)
    return {
        "x": _EXPL_X[rows, j].astype(np.float64).tolist(),
        "shap": SHAP_VALUES[rows, j].astype(np.float64).tolist(),
        "color": _EXPL_X[rows, partner].astype(np.float64).tolist(),
        "color_feature": FEATURES[partner],
        "zone": ZONES[rows].astype(int).tolist(),
        "year": _YEARS[rows].astype(int).tolist(),
    }


def _build_threshold(j):
    centers, mean, counts = _DEP_CURVES[j]
    pt = _POINT_THRESHOLDS[j]
    finite_mean = mean[np.isfinite(mean)]
    out = {}
    for col, key in enumerate(("zero_crossing", "breakpoint", "saturation")):
        ci, support = _boot_ci(_BOOT_THRESHOLDS[:, j, col], pt[key])
        out[key] = pt[key]
        out[f"{key}_ci"] = ci
        out[f"{key}_support"] = support
    return {
        "zero_crossing": out["zero_crossing"], "zero_crossing_ci": out["zero_crossing_ci"],
        "zero_crossing_support": out["zero_crossing_support"],
        # several comparable sign changes: no single crossing is reported (SPEC 4.4)
        "zero_crossing_flag": "multiple" if pt["zero_crossing_multiple"] and pt["zero_crossing"] is None else None,
        "breakpoint": out["breakpoint"], "breakpoint_ci": out["breakpoint_ci"],
        "breakpoint_support": out["breakpoint_support"],
        "slope_before": pt["slope_before"], "slope_after": pt["slope_after"],
        "saturation": out["saturation"], "saturation_ci": out["saturation_ci"],
        "saturation_support": out["saturation_support"],
        "effect_range": float(np.ptp(finite_mean)) if finite_mean.size else None,
        "direction": pt["direction"],
    }


with timer("04_dependence"):
    _partner_matrix = INTERACTION_GLOBAL.copy()
    np.fill_diagonal(_partner_matrix, -np.inf)
    _dep_rng = np.random.default_rng(CFG.SEED + 11)
    THRESHOLDS, DEPENDENCE = {}, {}
    for _jj, _f in enumerate(FEATURES):
        _centers, _mean, _counts = _DEP_CURVES[_jj]
        _nb = len(_centers)
        _lo, _hi, _ = _recentred_interval(_mean, _BOOT_CURVES[:, _jj, :_nb])
        THRESHOLDS[_f] = _build_threshold(_jj)
        DEPENDENCE[_f] = {
            "bin_centers": _centers.tolist(), "mean": _mean.tolist(),
            "ci_lo": _lo.tolist(), "ci_hi": _hi.tolist(), "count": _counts.astype(int).tolist(),
            "scatter": _scatter_sample(_jj, int(np.argmax(_partner_matrix[_jj])), _dep_rng),
            "threshold": THRESHOLDS[_f],
        }
_bad_thr = [f for f, t in THRESHOLDS.items() for k in ("zero_crossing", "breakpoint", "saturation")
            if t[k] is None and t[f"{k}_ci"] is not None]
if _bad_thr:
    raise AssertionError(f"threshold interval without a point estimate: {_bad_thr}")


def _fmt_opt(v, ci=None, support=None):
    if v is None:
        return "—"
    text = f"{v:.3f}" + (f" [{ci[0]:.3f}, {ci[1]:.3f}]" if ci else "")
    return text + (f" (support {support:.0%})" if support is not None and support < 0.8 else "")


_thr_table = pd.DataFrame([
    {"feature": f, "direction": t["direction"], "effect_range_C": round(t["effect_range"] or 0.0, 3),
     "zero_crossing": ("multiple" if t["zero_crossing_flag"] == "multiple"
                       else _fmt_opt(t["zero_crossing"], t["zero_crossing_ci"], t["zero_crossing_support"])),
     "breakpoint": _fmt_opt(t["breakpoint"], t["breakpoint_ci"], t["breakpoint_support"]),
     "saturation": _fmt_opt(t["saturation"], t["saturation_ci"], t["saturation_support"])}
    for f, t in THRESHOLDS.items()
])
print(f"Thresholds ({BOOTSTRAP_INFO['ci_label']} in brackets):")
print(_thr_table.to_string(index=False))

_THRESHOLD_KINDS = {"saturation": "saturation", "breakpoint": "breakpoint", "knee": "breakpoint",
                    "threshold": "breakpoint", "zero": "zero_crossing", "crossing": "zero_crossing"}


def _planted_rows(feature, kind, planted):
    """Compare one planted property of `feature` with what the SHAP pipeline recovered."""
    th = THRESHOLDS[feature]
    target = next((v for k, v in _THRESHOLD_KINDS.items() if k in kind), None)
    if kind == "direction":
        return {"feature": feature, "planted": kind, "value": planted, "recovered": th["direction"],
                "abs_error": None, "match": th["direction"] == planted}
    if target is not None and isinstance(planted, (int, float, np.integer, np.floating)):
        rec = th[target]
        return {"feature": feature, "planted": kind, "value": float(planted),
                "recovered": f"{target} {_fmt_opt(rec, th[f'{target}_ci'])}",
                "abs_error": None if rec is None else round(abs(rec - float(planted)), 3), "match": None}
    return {"feature": feature, "planted": kind, "value": planted,
            "recovered": f"direction {th['direction']}, effect range {th['effect_range'] or 0:.2f} °C",
            "abs_error": None, "match": None}


def _planted_vs_recovered(truth):
    """Planted-vs-recovered table from SYNTHETIC_TRUTH.

    Uses the structured `planted_thresholds` {feature: {kind: value}} when present, otherwise flat
    '<feature>_<kind>' keys (e.g. 'ndvi_saturation').
    """
    rows = []
    structured = truth.get("planted_thresholds")
    if isinstance(structured, dict):
        for feature, props in structured.items():
            if feature in THRESHOLDS and isinstance(props, dict):
                rows.extend(_planted_rows(feature, str(kind), value) for kind, value in props.items())
    else:
        for key, planted in truth.items():
            feat = max((f for f in FEATURES if key.startswith(f + "_")), key=len, default=None)
            if feat is not None:
                rows.append(_planted_rows(feat, key[len(feat) + 1:], planted))
    return pd.DataFrame(rows)


def _irrelevant_feature_ranks(truth):
    """Importance rank of features that act on LST only through correlation (should rank low)."""
    names = [f for f in truth.get("irrelevant_by_construction", []) if f in FEATURES]
    ranks = {FEATURES[j]: r for r, j in enumerate(_IMPORTANCE_ORDER, start=1)}
    return pd.DataFrame([{"feature": f, "importance_rank": ranks[f],
                          "mean_abs_shap_C": round(SHAP_IMPORTANCE["global"]["mean_abs"][FEATURES.index(f)], 4)}
                         for f in names])


if SYNTHETIC_TRUTH:
    _pvr = _planted_vs_recovered(SYNTHETIC_TRUTH)
    print("\nPlanted (synthetic generator) vs recovered (SHAP pipeline):")
    print(_pvr.to_string(index=False) if len(_pvr) else "  no feature-level entries in SYNTHETIC_TRUTH")
    _irr = _irrelevant_feature_ranks(SYNTHETIC_TRUTH)
    if len(_irr):
        print(f"\nFeatures irrelevant by construction (importance rank of {_K}; should be low):")
        print(_irr.to_string(index=False))
free_memory()

# %% [markdown]
# ## 4.14 Zone profiles, transitions and recommendations
# The planned actions (4.10) get their bootstrap intervals here. `transitions` count, for each pair of
# **consecutive** epochs, the cells present in both epochs by (zone in the earlier epoch, zone in the later epoch).

# %%
_RES_KM2 = (float(CFG.GRID_RES_M) / 1000.0) ** 2
_MIN_DRIVER_C = 0.01   # |mean SHAP| below this is not reported as a zone driver
_DISTRICT_NAMES = {int(d["id"]): d["name"] for d in DISTRICTS}
_DONOR_LABELS = {"other_vegetation": "other vegetation"}


def _as_exported(value, scale=1):
    """`value` rounded to the 4 significant digits written to zones.json (05), times `scale`, as an exact Decimal.

    The rationale text is formatted from this with round-half-up, like the dashboard's Intl formatting of the
    exported number, so the sentence and the table never disagree on a tie (e.g. 0.0275 -> 2.8%, not 2.7%).
    """
    from decimal import Decimal
    return Decimal(repr(float(f"{float(value):.4g}"))) * scale


def _fmt_dp(value, dp, scale=1):
    from decimal import ROUND_HALF_UP, Decimal
    q = _as_exported(value, scale).quantize(Decimal(1).scaleb(-dp), rounding=ROUND_HALF_UP)
    return f"{abs(q) if q == 0 else q:f}"  # never "-0.0"


def _fmt_sig(value, sig=3):
    from decimal import ROUND_HALF_UP, Decimal
    d = _as_exported(value)
    if d == 0:
        return "0"
    q = d.quantize(Decimal(1).scaleb(d.adjusted() - (sig - 1)), rounding=ROUND_HALF_UP)
    text = f"{q:,f}"
    return text.rstrip("0").rstrip(".") if "." in text else text


def _fmt_feature_value(feature, value):
    display = FEATURE_META.get(feature, {}).get("display", "number")
    if display == "percent":
        pct = float(_as_exported(value, 100))
        return f"{_fmt_dp(value, 1, 100)}%" if 0 < abs(pct) < 9.95 else f"{_fmt_dp(value, 0, 100)}%"
    if display == "index":
        return _fmt_dp(value, 2)
    return _fmt_sig(value, 3)


def _pp(frac):
    """Percentage points with one decimal below 10 pp (so a 2.4 pp step is not shown as '2')."""
    v = float(_as_exported(frac, 100))
    return _fmt_dp(frac, 1, 100) if abs(v) < 9.95 else _fmt_dp(frac, 0, 100)


def _donor_text(plan):
    """' The land is taken from ... mostly cropland (-12 pp) and other vegetation (-5 pp); ...' (fraction actions)."""
    moves = sorted(((k, v) for k, v in plan["donors"].items() if abs(v) >= 0.005),
                   key=lambda kv: -abs(kv[1]))[:2]
    verb = "taken from" if plan["step"] > 0 else "given to"
    lead = f" The land is {verb} the other land covers (including other vegetation) in proportion to their shares"
    if moves:
        names = [f"{_DONOR_LABELS.get(k, FEATURE_META.get(k, {}).get('label', k)).lower()} "
                 f"({'+' if v > 0 else '-'}{_pp(abs(v))} pp)" for k, v in moves]
        lead += f", mostly {' and '.join(names)}"
    return lead + "; NDVI, NDWI and NDBI follow through the land-cover coupling."


def _rationale(plan, ci):
    feature = plan["feature"]
    label = FEATURE_META.get(feature, {}).get("label", feature)
    fv = lambda v: _fmt_feature_value(feature, v)  # noqa: E731
    verb = "raising" if plan["step"] > 0 else "lowering"
    if feature in _COUPLING_FRACTIONS:
        change = (f"{verb} {label.lower()} by {_pp(abs(plan['step']))} percentage points in every cell "
                  f"(zone median {fv(plan['current'])} → {fv(plan['target'])})")
    elif feature == "ndvi":
        change = (f"{verb} NDVI by {_fmt_dp(abs(plan['step']), 2)} in every cell (zone median {fv(plan['current'])} → "
                  f"{fv(plan['target'])}), i.e. greening within the existing land covers")
    else:
        change = (f"{verb} {label.lower()} by {_fmt_sig(abs(plan['step']), 3)} in every cell (zone median "
                  f"{fv(plan['current'])} → {fv(plan['target'])})")
    donors = _donor_text(plan) if feature in _COUPLING_FRACTIONS else ""
    label_ci = BOOTSTRAP_INFO["ci_label"]
    ci_text = f"{label_ci} {ci[0]:+.2f} to {ci[1]:+.2f} °C" if ci else "no bootstrap interval"
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
    return (f"In the final model, {change} is associated with a mean LST change of {plan['expected_delta_c']:+.2f} °C "
            f"over the zone's {plan['n_cells']:,} cells ({ci_text}).{donors} This is a model-based "
            f"ceteris-paribus estimate, not a causal effect.{why}")


def _build_recommendations():
    by_zone = {m["id"]: [] for m in _ZONE_META}
    for i, plan in enumerate(_REC_PLAN):
        delta = float(_REC_FINAL_DELTAS[i])
        plan["expected_delta_c"] = delta
        if not delta < -_REC_MIN_COOLING_C:
            continue
        boot = _BOOT_REC_DELTAS[:, i] if _BOOT_REC_DELTAS.size else np.zeros(0)
        ci, bias = None, None
        if np.isfinite(boot).sum() >= 2:
            lo, hi, b = _recentred_interval(np.array([delta]), boot[:, None])
            ci, bias = [float(lo[0]), float(hi[0])], float(b[0])
        by_zone[plan["zone"]].append({
            "feature": plan["feature"], "action": plan["action"],
            "current": plan["current"], "target": plan["target"], "expected_delta_c": delta, "ci": ci,
            # priority from the exported (2 dp) value so the bundle is self-consistent (SPEC 4.6)
            "priority": "high" if round(delta, 2) <= -1.0 else ("medium" if round(delta, 2) <= -0.3 else "low"),
            "rationale": _rationale(plan, ci),
            "kind": plan["kind"], "step": plan["step"], "n_cells": plan["n_cells"], "coupled": True,
            "bias": bias,
        })
    return {z: sorted(v, key=lambda r: r["expected_delta_c"])[:_REC_MAX_PER_ZONE] for z, v in by_zone.items()}


def _top_pairs(matrix, n=3):
    iu = np.triu_indices(_K, k=1)
    vals = matrix[iu]
    order = np.argsort(vals)[::-1][:n]
    return [{"a": FEATURES[iu[0][o]], "b": FEATURES[iu[1][o]], "value": float(vals[o])} for o in order]


def _top_districts(mask, n=5):
    d = DF["district"].to_numpy()[mask].astype(np.int64)
    total = max(int(mask.sum()), 1)
    ids, counts = np.unique(d[d >= 0], return_counts=True)
    order = np.argsort(counts)[::-1][:n]
    return [{"district": int(ids[o]), "name": _DISTRICT_NAMES.get(int(ids[o]), str(ids[o])),
             "share": float(counts[o] / total)} for o in order]


def _zone_description(meta, profile):
    last = str(_LAST_YEAR)
    share = profile["n_cells"][last] / max(int((_YEARS == _LAST_YEAR).sum()), 1)
    label = lambda f: FEATURE_META.get(f, {}).get("label", f)  # noqa: E731
    warm = ", ".join(f"{label(t['feature'])} ({t['shap']:+.2f} °C)" for t in profile["top_warming"]) or "none"
    cool = ", ".join(f"{label(t['feature'])} ({t['shap']:+.2f} °C)" for t in profile["top_cooling"]) or "none"
    dist = ", ".join(f"{t['name']} ({100 * t['share']:.0f}%)" for t in profile["top_districts"][:3]) or "n/a"
    lst = profile["lst_obs_mean"][last]
    lst_txt = f"mean observed LST {lst:.1f} °C" if lst is not None else "no cells observed"
    return (f"{meta['name']}: {profile['area_km2'][last]:,.0f} km² in {last} ({100 * share:.0f}% of the study "
            f"area), {lst_txt}. Main warming drivers: {warm}. Main cooling drivers: {cool}. "
            f"Largest shares in {dist}.")


def _zone_profile(meta):
    z = meta["id"]
    mask = ZONES == z
    n_cells, area, lst_obs, lst_pred = {}, {}, {}, {}
    for year in _EPOCH_LIST:
        m = mask & (_YEARS == year)
        n = int(m.sum())
        n_cells[str(year)] = n
        area[str(year)] = n * _RES_KM2
        lst_obs[str(year)] = float(DF["lst"].to_numpy()[m].mean()) if n else None
        lst_pred[str(year)] = float(DF["lst_pred"].to_numpy()[m].mean()) if n else None
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        feature_means = np.nanmean(_EXPL_X[mask].astype(np.float64), axis=0)
    shap_means = SHAP_VALUES[mask].mean(axis=0, dtype=np.float64)
    order = np.argsort(shap_means)
    profile = {
        "id": z, "name": meta["name"], "color": meta["color"], "description": "",
        "n_cells": n_cells, "area_km2": area, "lst_obs_mean": lst_obs, "lst_pred_mean": lst_pred,
        "feature_means": {f: float(feature_means[j]) for j, f in enumerate(FEATURES)},
        "shap_means": {f: float(shap_means[j]) for j, f in enumerate(FEATURES)},
        "top_warming": [{"feature": FEATURES[j], "shap": float(shap_means[j])}
                        for j in order[::-1][:3] if shap_means[j] >= _MIN_DRIVER_C],
        "top_cooling": [{"feature": FEATURES[j], "shap": float(shap_means[j])}
                        for j in order[:3] if shap_means[j] <= -_MIN_DRIVER_C],
        "top_interactions": _top_pairs(INTERACTION_BY_ZONE[z]),
        "top_districts": _top_districts(mask),
        "recommendations": RECOMMENDATIONS[z],
    }
    profile["description"] = _zone_description(meta, profile)
    return profile


def _zone_transitions():
    """{"<y0>-><y1>": 4x4 counts} for consecutive epoch pairs; rows = zone in y0, cols = zone in y1."""
    out = {}
    frame = pd.DataFrame({"cell_id": DF["cell_id"].to_numpy(), "year": _YEARS, "zone": ZONES.astype(np.int64)})
    for y0, y1 in zip(_EPOCH_LIST[:-1], _EPOCH_LIST[1:]):
        pair = frame[frame.year == y0].merge(frame[frame.year == y1], on="cell_id", suffixes=("_a", "_b"))
        counts = np.bincount(pair["zone_a"].to_numpy() * _N_ZONES + pair["zone_b"].to_numpy(),
                             minlength=_N_ZONES * _N_ZONES).reshape(_N_ZONES, _N_ZONES)
        out[f"{y0}->{y1}"] = counts.astype(int).tolist()
    return out


with timer("04_zone_profiles"):
    RECOMMENDATIONS = _build_recommendations()
    ZONE_PROFILES = [_zone_profile(m) for m in _ZONE_META]
    ZONE_TRANSITIONS = _zone_transitions()
for _p in ZONE_PROFILES:
    print(f"\n[{_p['id']}] {_p['description']}")
    for _rec in _p["recommendations"]:
        print(f"    - {_rec['priority'].upper():6s} {_rec['rationale']}")
    if not _p["recommendations"]:
        print("    - no feasible action with an expected cooling > 0.05 °C")

# %% [markdown]
# ## 4.15 Figures

# %%
_FIG_DIR = Path(CFG.FIG_DIR)
_FIG_DIR.mkdir(parents=True, exist_ok=True)


def _save_fig(fig, name):
    fig.savefig(_FIG_DIR / name, dpi=150, bbox_inches="tight")
    plt.show()
    plt.close(fig)


def _label(f):
    return FEATURE_META.get(f, {}).get("label", f)


def _fig_beeswarm(n_top=12, n_rows=4000):
    """Beeswarm-style summary: SHAP per row, coloured by the within-sample rank of the feature value."""
    rng = np.random.default_rng(CFG.SEED)
    rows = rng.choice(len(DF), size=min(n_rows, len(DF)), replace=False)
    top = _IMPORTANCE_ORDER[:n_top]
    cmap = plt.get_cmap("Blues")
    fig, ax = plt.subplots(figsize=(9, 0.45 * len(top) + 1.5))
    for pos, j in enumerate(reversed(top)):
        s = SHAP_VALUES[rows, j]
        x = _EXPL_X[rows, j]
        rank = pd.Series(x).rank(pct=True).to_numpy()
        colors = np.where(np.isfinite(rank)[:, None], cmap(0.25 + 0.75 * np.nan_to_num(rank)),
                          np.array([[0.6, 0.6, 0.6, 1.0]]))
        # Jitter proportional to local density gives the beeswarm silhouette without an O(n^2) layout.
        hist, edges = np.histogram(s, bins=60)
        dens = hist[np.clip(np.searchsorted(edges, s) - 1, 0, 59)] / max(hist.max(), 1)
        ax.scatter(s, pos + rng.uniform(-0.4, 0.4, s.size) * dens, s=3, c=colors, linewidths=0)
    ax.axvline(0, color="#475569", lw=0.8)
    ax.set_yticks(range(len(top)))
    ax.set_yticklabels([_label(FEATURES[j]) for j in reversed(top)])
    ax.set_xlabel("SHAP value (°C contribution to LST, relative to the average cell)")
    ax.set_title("SHAP summary (colour: feature value rank, light = low, dark = high)")
    _save_fig(fig, "shap_summary_beeswarm.png")


def _fig_importance():
    imp = SHAP_IMPORTANCE["global"]
    order = _IMPORTANCE_ORDER[::-1]
    vals = np.array(imp["mean_abs"])[order]
    lo = vals - np.array(imp["ci_lo"])[order]
    hi = np.array(imp["ci_hi"])[order] - vals
    fig, ax = plt.subplots(figsize=(8, 0.35 * _K + 1.5))
    ax.barh(range(_K), vals, color="#22d3ee", height=0.6,
            xerr=np.vstack([np.clip(np.nan_to_num(lo), 0, None), np.clip(np.nan_to_num(hi), 0, None)]),
            ecolor="#334155", capsize=2)
    ax.set_yticks(range(_K))
    ax.set_yticklabels([_label(FEATURES[j]) for j in order])
    ax.set_xlabel(f"mean |SHAP| (°C), whiskers = {BOOTSTRAP_INFO['ci_label']} (block bootstrap, bias-corrected)")
    ax.set_title(f"Global feature importance ({BOOTSTRAP_INFO['n']} bootstrap replicates)")
    _save_fig(fig, "shap_importance_ci.png")


def _fig_dependence_grid():
    top = _IMPORTANCE_ORDER[:6]
    fig, axes = plt.subplots(2, 3, figsize=(15, 8.5))
    styles = {"zero_crossing": (":", "zero crossing"), "breakpoint": ("--", "breakpoint"),
              "saturation": ("-.", "saturation")}
    for ax, j in zip(axes.ravel(), top):
        f = FEATURES[j]
        dep = DEPENDENCE[f]
        sc = dep["scatter"]
        ax.scatter(sc["x"], sc["shap"], s=4, color="#94a3b8", alpha=0.5, linewidths=0, label="cells (sample)")
        ax.fill_between(dep["bin_centers"], dep["ci_lo"], dep["ci_hi"], color="#a78bfa", alpha=0.3,
                        label=f"{BOOTSTRAP_INFO['ci_label']} (bootstrap)")
        ax.plot(dep["bin_centers"], dep["mean"], color="#6d28d9", lw=2, label="binned mean")
        for key, (ls, name) in styles.items():
            if THRESHOLDS[f][key] is not None:
                ax.axvline(THRESHOLDS[f][key], color="#0f172a", ls=ls, lw=1, label=name)
        ax.axhline(0, color="#475569", lw=0.6)
        ax.set_title(f"{_label(f)} ({THRESHOLDS[f]['direction']})")
        ax.set_xlabel(_label(f))
        ax.set_ylabel("SHAP (°C vs average cell)")
    for ax in axes.ravel()[len(top):]:
        ax.set_visible(False)
    handles, labels = axes.ravel()[0].get_legend_handles_labels()
    for ax in axes.ravel()[1:len(top)]:
        for h, lab in zip(*ax.get_legend_handles_labels()):
            if lab not in labels:
                handles.append(h)
                labels.append(lab)
    fig.legend(handles, labels, loc="lower center", ncol=6, frameon=False)
    fig.tight_layout(rect=(0, 0.05, 1, 1))
    _save_fig(fig, "shap_dependence_top6.png")


def _fig_zone_map():
    from matplotlib.colors import ListedColormap
    from matplotlib.patches import Patch
    last = _YEARS == _LAST_YEAR
    raster = np.full((GRID.height, GRID.width), np.nan)
    raster[DF["row"].to_numpy()[last], DF["col"].to_numpy()[last]] = ZONES[last]
    cmap = ListedColormap([m["color"] for m in _ZONE_META])
    fig, ax = plt.subplots(figsize=(8, 8 * GRID.height / max(GRID.width, 1) + 0.5))
    ax.imshow(raster, cmap=cmap, vmin=-0.5, vmax=_N_ZONES - 0.5, interpolation="nearest")
    ax.set_axis_off()
    ax.legend(handles=[Patch(color=m["color"], label=f"{m['id']} {m['name']}") for m in _ZONE_META],
              loc="lower left", frameon=True, fontsize=8)
    ax.set_title(f"SHAP governance zones, {_LAST_YEAR}")
    _save_fig(fig, f"zones_map_{_LAST_YEAR}.png")


def _fig_zone_signature():
    mat = np.array([[p["shap_means"][f] for f in FEATURES] for p in ZONE_PROFILES])
    vmax = float(np.max(np.abs(mat))) or 1.0
    fig, ax = plt.subplots(figsize=(0.6 * _K + 2, 3.2))
    im = ax.imshow(mat, cmap="RdBu_r", vmin=-vmax, vmax=vmax, aspect="auto")
    for (r, c), v in np.ndenumerate(mat):
        ax.text(c, r, f"{v:.2f}", ha="center", va="center", fontsize=6,
                color="white" if abs(v) > 0.6 * vmax else "#0f172a")
    ax.set_xticks(range(_K))
    ax.set_xticklabels([_label(f) for f in FEATURES], rotation=60, ha="right", fontsize=8)
    ax.set_yticks(range(len(ZONE_PROFILES)))
    ax.set_yticklabels([p["name"] for p in ZONE_PROFILES])
    fig.colorbar(im, ax=ax, label="mean SHAP (°C)")
    ax.set_title("Zone SHAP signatures")
    _save_fig(fig, "zones_shap_signature.png")


def _fig_k_diagnostics():
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(10, 3.6))
    ks = ZONE_DIAGNOSTICS["k"]
    ax1.plot(ks, ZONE_DIAGNOSTICS["inertia"], marker="o", color="#22d3ee", lw=2)
    ax1.set_title("K-means inertia (SHAP space)")
    ax2.plot(ks, ZONE_DIAGNOSTICS["silhouette"], marker="o", color="#a78bfa", lw=2)
    ax2.set_title("Silhouette (20k-row sample)")
    for ax in (ax1, ax2):
        ax.axvline(_N_ZONES, color="#fb7185", ls="--", lw=1, label="K = 4 (governance contract)")
        ax.set_xlabel(f"K ({ZONE_DIAGNOSTICS['n_init']} initialisations each)")
    ax2.legend(frameon=False, fontsize=8)
    _save_fig(fig, "zones_k_diagnostics.png")


with timer("04_figures"):
    for _fig_fn in (_fig_beeswarm, _fig_importance, _fig_dependence_grid, _fig_zone_map,
                    _fig_zone_signature, _fig_k_diagnostics):
        try:
            _fig_fn()
        except Exception as _exc:  # a broken figure must never lose the computed results
            log(f"Figure {_fig_fn.__name__} failed: {type(_exc).__name__}: {_exc}", "WARNING")
            plt.close("all")
free_memory()
log("Section 04 complete: FINAL_MODEL, SHAP_VALUES, INTERACTION_*, THRESHOLDS, ZONES, RECOMMENDATIONS ready")
