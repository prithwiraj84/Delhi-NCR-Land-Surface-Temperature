# %% [markdown]
# ## 3. Benchmark models and triple cross-validation
#
# **Why three validation schemes?** Land surface temperature is strongly spatially autocorrelated and every cell appears
# once per epoch. A plain random K-fold therefore tests a model on rows whose immediate neighbours — and the *same cell in
# other epochs* — were in the training set, which rewards interpolation and memorisation and is optimistic.
#
# | Scheme | Split | Question it answers |
# |---|---|---|
# | `random` | rows randomly assigned to 5 folds (`fold_random`) | optimistic upper bound (interpolation) |
# | `spatial` | 5 × 5 tiles over the grid extent, greedily size-balanced into 5 folds (`fold_spatial`); a cell keeps its fold in every epoch | transfer to unseen **places** (~50 km tiles, well beyond the LST correlation range) |
# | `temporal` | train on 2010–2020, test on 2025 (fold 0) | forward extrapolation to an unseen **epoch** |
#
# Early stopping for the gradient-boosted models and the GNN uses an *inner* validation set of whole 10 km blocks
# (`block10_id`, ~10 % of the training rows), so the outer test fold is never touched. Held-out 10 km blocks still border
# fitting blocks and the residual correlation of LST reaches ~20 km, so this split *reduces* but does not remove
# adjacency leakage: the chosen stopping round is mildly optimistic (it only sets the number of trees).
#
# In anomaly mode every epoch's target is centred on that epoch's *observed* spatial mean (one constant per epoch,
# computed from all its cells, test rows included). For spatial CV this leak is negligible; for temporal CV it means
# the 2025 mean is given, so the temporal score measures spatial-pattern transfer, not the climate offset.
#
# **Residual Moran's I** (KNN, k = `CFG.MORAN_K`, row-standardised, permutation inference) is reported per model, scheme
# and epoch: residual spatial structure left by a model signals missing spatially structured drivers and warns that
# naive standard errors would be too small. The target's own Moran's I gives the reference level of autocorrelation.
#
# | Model | Role | Hardware |
# |---|---|---|
# | `linear`, `ridge` | transparent baselines (median imputation + standardisation) | CPU |
# | `random_forest` | bagged trees | scikit-learn; cuML on GPU only with `LST_USE_RAPIDS=1` (same hyper-parameters) |
# | `lightgbm` | leaf-wise GBM | GPU (OpenCL) if the probe succeeds, else CPU |
# | `xgboost` | **the explained model** (hist, native NaN handling) | CUDA, folds spread over both T4s |
# | `gnn` | spatial GraphSAGE on a KNN graph — does explicit neighbourhood context beat per-cell trees? | `cuda:1` (or `cuda:0` / CPU) |

# %%
import os
import time
import traceback
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import sparse
from scipy.spatial import cKDTree

MODEL_NAMES = ["linear", "ridge", "random_forest", "lightgbm", "xgboost", "gnn"]
SCHEMES = ["random", "spatial", "temporal"]

_X_ALL = DF[FEATURES].to_numpy(np.float32)
_Y_ALL = DF[TARGET_COL].to_numpy(np.float32)
_N_ROWS = len(DF)
_LAST_EPOCH = int(DF["year"].max())


def iter_folds(scheme):
    """Yield ``(fold_id, train_idx, test_idx)`` (int64 row positions in DF order) for a validation scheme."""
    if scheme in ("random", "spatial"):
        fold_col = DF["fold_random" if scheme == "random" else "fold_spatial"].to_numpy()
        for fold_id in range(int(CFG.N_FOLDS)):
            test_idx = np.flatnonzero(fold_col == fold_id)
            train_idx = np.flatnonzero(fold_col != fold_id)
            if test_idx.size == 0 or train_idx.size == 0:
                log(f"{scheme} fold {fold_id} is empty - skipped", "WARNING")
                continue
            yield fold_id, train_idx, test_idx
    elif scheme == "temporal":
        years = DF["year"].to_numpy()
        train_idx, test_idx = np.flatnonzero(years < _LAST_EPOCH), np.flatnonzero(years == _LAST_EPOCH)
        if train_idx.size == 0:
            log("temporal scheme needs at least two epochs - skipped", "WARNING")
            return
        yield 0, train_idx, test_idx
    else:
        raise ValueError(f"unknown scheme {scheme!r}")


def inner_split(train_idx, val_share=0.10):
    """Split training rows into (fit_idx, val_idx) holding out whole 10 km blocks (~``val_share`` of rows).

    Blocks are drawn in a seeded random order until the share is reached; with a single block the split falls back to
    a seeded random row split. Used for early stopping only.
    """
    rng = np.random.default_rng(CFG.SEED)
    groups = DF["block10_id"].to_numpy()[train_idx]
    uniq, counts = np.unique(groups, return_counts=True)
    if uniq.size < 2:
        is_val = np.zeros(train_idx.size, dtype=bool)
        is_val[rng.permutation(train_idx.size)[: max(1, int(round(val_share * train_idx.size)))]] = True
    else:
        order = rng.permutation(uniq.size)
        cum = np.cumsum(counts[order])
        n_take = int(np.searchsorted(cum, val_share * train_idx.size) + 1)
        n_take = min(n_take, uniq.size - 1)  # always keep at least one block for fitting
        is_val = np.isin(groups, uniq[order[:n_take]])
    return train_idx[~is_val], train_idx[is_val]


def _train_medians(train_idx):
    """Column medians of the training rows (0 for all-NaN columns) used for imputation."""
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        med = np.nanmedian(_X_ALL[train_idx], axis=0)
    return np.where(np.isfinite(med), med, 0.0).astype(np.float32)


def _impute(x, medians):
    return np.where(np.isnan(x), medians, x).astype(np.float32)


# %% [markdown]
# ### 3.1 Model implementations
# Each `_fit_<model>(train_idx, test_idx, gpu_id)` fits on the training rows and returns predictions for the test rows
# (target units) plus an info dict (`device`, `best_iteration`). GPU paths are real (XGBoost CUDA, LightGBM OpenCL, cuML,
# PyTorch). XGBoost and the GNN retry a fold on the CPU after a GPU out-of-memory error; LightGBM and cuML fall back
# to the CPU on any GPU error. `best_iteration` is XGBoost's 0-based best round, LightGBM's 1-based
# `best_iteration_` and the GNN's best epoch.

# %%
def _fit_sklearn_linear(train_idx, test_idx, regressor):
    from sklearn.impute import SimpleImputer
    from sklearn.pipeline import Pipeline
    from sklearn.preprocessing import StandardScaler

    model = Pipeline([("impute", SimpleImputer(strategy="median")), ("scale", StandardScaler()), ("reg", regressor)])
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)  # all-NaN columns are dropped by the imputer
        model.fit(_X_ALL[train_idx], _Y_ALL[train_idx])
        pred = model.predict(_X_ALL[test_idx])
    return pred.astype(np.float32), {"device": "cpu", "best_iteration": None}


def _fit_linear(train_idx, test_idx, gpu_id):
    from sklearn.linear_model import LinearRegression

    return _fit_sklearn_linear(train_idx, test_idx, LinearRegression())


def _fit_ridge(train_idx, test_idx, gpu_id):
    from sklearn.linear_model import RidgeCV

    return _fit_sklearn_linear(train_idx, test_idx, RidgeCV(alphas=np.logspace(-3, 3, 13)))


def _fit_random_forest(train_idx, test_idx, gpu_id):
    """cuML RF on GPU when RAPIDS is enabled (LST_USE_RAPIDS), else scikit-learn (train-median-imputed float32).

    Both backends get the same hyper-parameters (300 trees, depth 16, 1/3 of the features per split, >= 2 rows per
    leaf); cuML additionally uses 128-bin histogram splits and one CUDA stream (n_streams=1) so that random_state
    makes it reproducible.
    """
    medians = _train_medians(train_idx)
    x_train, x_test = _impute(_X_ALL[train_idx], medians), _impute(_X_ALL[test_idx], medians)
    n_trees = 60 if CFG.FAST_DEV else 300
    if ENV.get("has_cuml"):
        try:
            import cupy as cp
            from cuml.ensemble import RandomForestRegressor as CuRF

            with cp.cuda.Device(gpu_id):
                model = CuRF(n_estimators=n_trees, max_depth=16, max_features=0.33, min_samples_leaf=2,
                             n_bins=128, n_streams=1, random_state=CFG.SEED)
                model.fit(x_train, _Y_ALL[train_idx])
                pred = np.asarray(model.predict(x_test), dtype=np.float32)
                del model
                cp.get_default_memory_pool().free_all_blocks()
            ENV.setdefault("rapids_used", set()).add("cuml_random_forest")
            return pred, {"device": f"cuda:{gpu_id}", "best_iteration": None}
        except Exception as exc:
            log(f"cuML random forest failed on GPU {gpu_id} ({exc!r}); falling back to scikit-learn", "WARNING")
            free_memory()
    from sklearn.ensemble import RandomForestRegressor

    # Same hyper-parameters as the cuML path; the depth cap also keeps memory bounded (unbounded trees on ~200k
    # rows would need several GB per forest).
    model = RandomForestRegressor(n_estimators=n_trees, max_depth=16, max_features=0.33, min_samples_leaf=2,
                                  n_jobs=-1, random_state=CFG.SEED)
    model.fit(x_train, _Y_ALL[train_idx])
    pred = model.predict(x_test).astype(np.float32)
    del model
    return pred, {"device": "cpu", "best_iteration": None}


def _lgbm_params(device, gpu_id):
    params = dict(n_estimators=300 if CFG.FAST_DEV else 3000, learning_rate=0.03, num_leaves=63, subsample=0.8,
                  subsample_freq=1, colsample_bytree=0.8, min_child_samples=20, reg_lambda=1.0,
                  random_state=CFG.SEED, verbose=-1)
    if device == "gpu":
        params.update(device="gpu", gpu_device_id=int(gpu_id), gpu_platform_id=0)
    return params


def _resolve_lgbm_device():
    """Probe LightGBM GPU support once per session (tiny fit) and cache the answer in ENV['lgbm_device']."""
    if globals().get("_LGBM_DEVICE_PROBED"):
        return ENV["lgbm_device"]
    device = "cpu"
    if ENV.get("n_gpus", 0) > 0:
        try:
            import lightgbm as lgb

            rng = np.random.default_rng(0)
            x_probe, y_probe = rng.normal(size=(256, 4)), rng.normal(size=256)
            lgb.LGBMRegressor(n_estimators=2, device="gpu", verbose=-1).fit(x_probe, y_probe)
            device = "gpu"
        except Exception as exc:
            log(f"LightGBM GPU probe failed ({type(exc).__name__}: {exc}); LightGBM will use the CPU")
    ENV["lgbm_device"] = device
    globals()["_LGBM_DEVICE_PROBED"] = True
    log(f"LightGBM device: {device}")
    return device


def _lgbm_eval_kwargs(x_val, y_val):
    """Validation-set keyword arguments for LGBMRegressor.fit: ``eval_X``/``eval_y`` on LightGBM >= 4.6
    (where ``eval_set`` is deprecated), ``eval_set`` on older releases such as Kaggle's."""
    import inspect

    import lightgbm as lgb

    if "eval_X" in inspect.signature(lgb.LGBMRegressor.fit).parameters:
        return {"eval_X": (x_val,), "eval_y": (y_val,)}
    return {"eval_set": [(x_val, y_val)]}


def _fit_lightgbm(train_idx, test_idx, gpu_id):
    import lightgbm as lgb

    fit_idx, val_idx = inner_split(train_idx)
    device = ENV.get("lgbm_device") or "cpu"
    for attempt in ("primary", "cpu_fallback"):
        try:
            model = lgb.LGBMRegressor(**_lgbm_params(device, gpu_id))
            model.fit(_X_ALL[fit_idx], _Y_ALL[fit_idx], eval_metric="l2",
                      callbacks=[lgb.early_stopping(int(CFG.XGB_EARLY_STOP), verbose=False)],
                      **_lgbm_eval_kwargs(_X_ALL[val_idx], _Y_ALL[val_idx]))
            best = int(model.best_iteration_ or model.n_estimators)  # LightGBM counts iterations from 1
            pred = model.predict(_X_ALL[test_idx], num_iteration=best).astype(np.float32)
            return pred, {"device": "cpu" if device == "cpu" else f"gpu:{gpu_id}", "best_iteration": best}
        except Exception as exc:
            if device == "cpu" or attempt == "cpu_fallback":
                raise
            log(f"LightGBM on GPU {gpu_id} failed ({exc!r}); retrying this fold on CPU", "WARNING")
            free_memory()
            device = "cpu"


def _xgb_params(device):
    params = dict(CFG.XGB_PARAMS)
    params.setdefault("objective", "reg:squarederror")
    params.setdefault("eval_metric", "rmse")
    params.setdefault("tree_method", "hist")
    params.setdefault("max_bin", 256)
    params.update(device=device, seed=int(CFG.SEED))
    return params


def _xgb_on_device(device, gpu_id, fit_idx, val_idx, test_idx):
    """One XGBoost fit/predict on ``device``; data go to the GPU as CuPy arrays when possible."""
    import xgboost as xgb

    params = _xgb_params(device)
    use_cupy = device.startswith("cuda") and ENV.get("has_cupy")
    if use_cupy:
        import cupy as cp

        ctx = cp.cuda.Device(gpu_id)
        to_dev = cp.asarray
    else:
        import contextlib

        ctx = contextlib.nullcontext()
        to_dev = np.asarray
    with ctx:
        dtrain = xgb.QuantileDMatrix(to_dev(_X_ALL[fit_idx]), label=to_dev(_Y_ALL[fit_idx]),
                                     max_bin=int(params["max_bin"]))
        dval = xgb.QuantileDMatrix(to_dev(_X_ALL[val_idx]), label=to_dev(_Y_ALL[val_idx]), ref=dtrain)
        booster = xgb.train(params, dtrain, num_boost_round=int(CFG.XGB_MAX_ROUNDS), evals=[(dval, "val")],
                            early_stopping_rounds=int(CFG.XGB_EARLY_STOP), verbose_eval=False)
        best = int(getattr(booster, "best_iteration", booster.num_boosted_rounds() - 1))
        if use_cupy:
            pred = cp.asnumpy(booster.inplace_predict(cp.asarray(_X_ALL[test_idx]), iteration_range=(0, best + 1)))
        else:
            booster.set_param({"device": "cpu"})  # host data -> host prediction (no device mismatch copies)
            pred = booster.inplace_predict(_X_ALL[test_idx], iteration_range=(0, best + 1))
        del dtrain, dval, booster
        if use_cupy:
            # free this device's CuPy pool inside its own context (free_memory() on the main thread only
            # reaches the current device)
            cp.get_default_memory_pool().free_all_blocks()
    return np.asarray(pred, dtype=np.float32), best


def _fit_xgboost(train_idx, test_idx, gpu_id):
    """xgb.train with QuantileDMatrix + inner-block early stopping; CUDA OOM -> retry on CPU."""
    fit_idx, val_idx = inner_split(train_idx)
    device = xgb_device_for(gpu_id)
    try:
        pred, best = _xgb_on_device(device, gpu_id, fit_idx, val_idx, test_idx)
    except Exception as exc:
        if device == "cpu" or not is_gpu_oom_error(exc):
            raise
        log(f"XGBoost out of memory on {device}; retrying fold on CPU", "WARNING")
        free_memory()
        device = "cpu"
        pred, best = _xgb_on_device(device, gpu_id, fit_idx, val_idx, test_idx)
    return pred, {"device": device, "best_iteration": best}


# %% [markdown]
# ### 3.2 Spatial GraphSAGE (pure PyTorch)
# Nodes are all cell–epochs; edges connect each cell to its k = 8 nearest cells **within the same epoch** (block-diagonal
# adjacency across epochs, row-normalised so $A h$ is the neighbour mean). Each layer is
# $h' = \mathrm{LayerNorm}(\mathrm{GELU}(W_{self} h + W_{neigh} A h)) + h$ with dropout 0.1; three layers give a 3-hop
# (~3–5 km) receptive field. Training is transductive and full-batch: all node features are visible (they are known at
# prediction time), the loss uses only training labels, early stopping uses the inner 10 km block validation nodes, and
# test labels are never seen. On a CPU-only machine each fold gets a wall-clock budget (`_GNN_CPU_FOLD_BUDGET_S`,
# measured after two epochs); the GPU path always trains for the full `CFG.GNN_EPOCHS` (with early stopping).

# %%
_GNN_GRAPH = None


def _gnn_edges(k=8):
    """Directed KNN edges (src -> neighbour) within each epoch, as global DF row positions (cached)."""
    global _GNN_GRAPH
    if _GNN_GRAPH is not None and _GNN_GRAPH["n"] == _N_ROWS:
        return _GNN_GRAPH
    years = DF["year"].to_numpy()
    xy = DF[["x", "y"]].to_numpy(np.float64)
    src_all, dst_all = [], []
    for year in np.unique(years):
        rows = np.flatnonzero(years == year)
        neigh = _knn_indices(xy[rows], k)
        if neigh is None:
            continue
        src_all.append(np.repeat(rows, neigh.shape[1]))
        dst_all.append(rows[neigh.ravel()])
    src = np.concatenate(src_all) if src_all else np.zeros(0, np.int64)
    dst = np.concatenate(dst_all) if dst_all else np.zeros(0, np.int64)
    _GNN_GRAPH = {"n": _N_ROWS, "src": src.astype(np.int64), "dst": dst.astype(np.int64)}
    return _GNN_GRAPH


def _knn_indices(xy, k):
    """(n, k_eff) indices of the k nearest *other* points (exact cKDTree in float64).

    A GPU KNN is deliberately not used: cuML's euclidean metric expands |x|² + |y|² - 2x·y in float32, which on raw
    UTM coordinates (|x|² ~ 1e13 m²) loses more precision than the 1 km cell spacing, and cKDTree needs ~0.1 s per
    epoch anyway.
    """
    n = xy.shape[0]
    k_eff = min(int(k), n - 1)
    if k_eff < 1:
        return None
    _, idx = cKDTree(np.asarray(xy, dtype=np.float64)).query(xy, k=k_eff + 1)
    idx = np.asarray(idx, dtype=np.int64)
    self_first = idx[:, :1] == np.arange(n)[:, None]
    # drop the query point itself (normally column 0; with exact ties it may be elsewhere -> drop the last column)
    return np.where(self_first, idx[:, 1:], idx[:, :-1])


def _build_sage(n_in, hidden=128, n_layers=3, dropout=0.1):
    """Construct the GraphSAGE network (torch imported lazily so the notebook runs without it)."""
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


def _gnn_device():
    import torch

    n_dev = torch.cuda.device_count() if torch.cuda.is_available() else 0
    return "cuda:1" if n_dev >= 2 else ("cuda:0" if n_dev == 1 else "cpu")


# CPU fallback only: wall-clock budget per fold (env LST_GNN_CPU_BUDGET_S). Full-batch GraphSAGE costs ~0.2 MFLOP per
# node per forward pass, i.e. ~5 s per epoch for 265k cell-epochs on an 8-core CPU versus ~0.02 s on a T4.
_GNN_CPU_FOLD_BUDGET_S = float(os.environ.get("LST_GNN_CPU_BUDGET_S", "900"))


def _cpu_epoch_cap(max_epochs, sec_per_epoch):
    """Cap CPU training epochs to the per-fold budget (the GPU path always runs CFG.GNN_EPOCHS)."""
    affordable = max(20, int(_GNN_CPU_FOLD_BUDGET_S / max(sec_per_epoch, 1e-6)))
    if affordable < max_epochs:
        log(f"GNN on CPU: {sec_per_epoch:.2f} s/epoch -> capping this fold at {affordable} of {max_epochs} epochs "
            f"({_GNN_CPU_FOLD_BUDGET_S:.0f} s budget); use a GPU for the full schedule", "WARNING")
        return affordable
    return max_epochs


def _gnn_train(device, train_idx, test_idx):
    """Full-batch transductive training on ``device``; returns (test predictions, best epoch)."""
    import torch

    set_seeds(int(CFG.SEED))
    fit_idx, val_idx = inner_split(train_idx)
    medians = _train_medians(train_idx)
    x = _impute(_X_ALL, medians)
    mu, sd = x[train_idx].mean(axis=0), x[train_idx].std(axis=0)
    x = (x - mu) / np.where(sd > 0, sd, 1.0)
    y_mu, y_sd = float(_Y_ALL[fit_idx].mean()), float(_Y_ALL[fit_idx].std() or 1.0)

    graph = _gnn_edges(8)
    deg = np.bincount(graph["src"], minlength=_N_ROWS).astype(np.float32)
    weights = 1.0 / deg[graph["src"]]
    dev = torch.device(device)
    adj = torch.sparse_coo_tensor(torch.from_numpy(np.vstack([graph["src"], graph["dst"]])),
                                  torch.from_numpy(weights), (_N_ROWS, _N_ROWS)).coalesce().to(dev)
    if dev.type == "cpu":  # CSR SpMM is ~2x faster than COO on CPU; CUDA keeps the long-supported COO autograd path
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", UserWarning)  # "sparse CSR support is in beta"
            adj = adj.to_sparse_csr()
    x_t = torch.from_numpy(x.astype(np.float32)).to(dev)
    y_t = torch.from_numpy(((_Y_ALL - y_mu) / y_sd).astype(np.float32)).to(dev)
    fit_t, val_t = torch.from_numpy(fit_idx).to(dev), torch.from_numpy(val_idx).to(dev)

    model = _build_sage(x.shape[1]).to(dev)
    opt = torch.optim.AdamW(model.parameters(), lr=3e-3, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.ReduceLROnPlateau(opt, mode="min", factor=0.5, patience=10, min_lr=1e-5)
    best_loss, best_epoch, best_state, stale = np.inf, 0, None, 0
    max_epochs, t_start = int(CFG.GNN_EPOCHS), time.time()
    epoch = 0
    while epoch < max_epochs:
        model.train()
        opt.zero_grad(set_to_none=True)
        loss = torch.nn.functional.mse_loss(model(x_t, adj)[fit_t], y_t[fit_t])
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        opt.step()
        model.eval()
        with torch.no_grad():
            val_loss = float(torch.nn.functional.mse_loss(model(x_t, adj)[val_t], y_t[val_t]))
        sched.step(val_loss)
        if val_loss < best_loss - 1e-6:
            best_loss, best_epoch, stale = val_loss, epoch, 0
            best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
        else:
            stale += 1
            if stale >= 30:
                break
        if epoch == 1 and dev.type == "cpu":
            max_epochs = _cpu_epoch_cap(max_epochs, (time.time() - t_start) / 2.0)
        epoch += 1
    if best_state is not None:
        model.load_state_dict(best_state)
    model.eval()
    with torch.no_grad():
        pred = model(x_t, adj)[torch.from_numpy(test_idx).to(dev)].float().cpu().numpy()
    del model, opt, adj, x_t, y_t, best_state
    return (pred * y_sd + y_mu).astype(np.float32), best_epoch


def _fit_gnn(train_idx, test_idx, gpu_id):
    """GraphSAGE fold; CUDA OOM -> retry on CPU; the CUDA cache is emptied after every fold."""
    import torch

    device = _gnn_device()
    try:
        pred, best = _gnn_train(device, train_idx, test_idx)
    except Exception as exc:
        if device == "cpu" or not is_gpu_oom_error(exc):
            raise
        log(f"GNN out of memory on {device}; retrying fold on CPU", "WARNING")
        torch.cuda.empty_cache()
        free_memory()
        device = "cpu"
        pred, best = _gnn_train(device, train_idx, test_idx)
    finally:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    return pred, {"device": device, "best_iteration": best}


_MODEL_FITTERS = {"linear": _fit_linear, "ridge": _fit_ridge, "random_forest": _fit_random_forest,
                  "lightgbm": _fit_lightgbm, "xgboost": _fit_xgboost, "gnn": _fit_gnn}


# %% [markdown]
# ### 3.3 Cross-validation driver
# XGBoost (CUDA) and (with `LST_USE_RAPIDS=1`) cuML random forest distribute their folds over the GPUs with `gpu_pool_map` (one worker per T4,
# so two folds run concurrently on `cuda:0`/`cuda:1`); LightGBM-GPU folds run one at a time (OpenCL thread safety). A failing fold or model is logged with its traceback and the run continues; the
# affected rows stay NaN in `OOF_PRED` and `n_folds` in `CV_SUMMARY` shows how many folds succeeded.

# %%
def _model_available(model):
    """Skip models whose library is missing (with a warning) instead of failing the run."""
    module = {"lightgbm": "lightgbm", "xgboost": "xgboost", "gnn": "torch"}.get(model)
    if module is None:
        return True
    try:
        __import__(module)
        return True
    except ImportError:
        log(f"{module} is not installed - model '{model}' skipped", "WARNING")
        return False


def _parallel_over_gpus(model):
    """Models whose folds are spread over the GPUs with gpu_pool_map (one fold per GPU at a time).

    LightGBM's OpenCL learner makes no thread-safety guarantee for concurrent boosters in one process (a native
    crash would kill the kernel), so its GPU folds run sequentially.
    """
    return ((model == "xgboost" and ENV.get("xgb_device") == "cuda")
            or (model == "random_forest" and bool(ENV.get("has_cuml"))))


def _regression_metrics(y_true, y_pred):
    y_true, y_pred = y_true.astype(np.float64), y_pred.astype(np.float64)
    resid = y_true - y_pred
    ss_tot = float(((y_true - y_true.mean()) ** 2).sum())
    return {"r2": 1.0 - float(resid @ resid) / ss_tot if ss_tot > 0 else np.nan,
            "rmse": float(np.sqrt(np.mean(resid ** 2))), "mae": float(np.mean(np.abs(resid)))}


def _run_fold(scheme, model, fold, gpu_id):
    """Fit one (scheme, model, fold); returns a result dict (never raises)."""
    fold_id, train_idx, test_idx = fold
    t0 = time.time()
    try:
        pred, info = _MODEL_FITTERS[model](train_idx, test_idx, gpu_id)
        if pred.shape != test_idx.shape or not np.all(np.isfinite(pred)):
            raise ValueError(f"invalid predictions (shape {pred.shape}, finite {np.isfinite(pred).mean():.3f})")
    except Exception:
        return {"fold": fold_id, "error": traceback.format_exc()}
    return {"fold": fold_id, "test_idx": test_idx, "pred": pred, "info": info, "n_train": int(train_idx.size),
            "seconds": time.time() - t0}


def run_scheme(scheme):
    """Run every model on every fold of ``scheme``.

    Returns (list of CV_FOLD_METRICS rows, {model: OOF array}, {model: [info dicts]}).
    """
    folds = list(iter_folds(scheme))
    rows, oof, infos = [], {}, {}
    for model in MODEL_NAMES:
        oof[model] = np.full(_N_ROWS, np.nan, dtype=np.float32)
        infos[model] = []
        if not folds or not _model_available(model):
            continue
        with timer(f"cv_{scheme}_{model}"):
            if _parallel_over_gpus(model):
                results = gpu_pool_map(lambda fold, gpu_id: _run_fold(scheme, model, fold, gpu_id), folds)
            else:
                results = [_run_fold(scheme, model, fold, 0) for fold in folds]
        for res in sorted(results, key=lambda r: r["fold"]):
            if "error" in res:
                log(f"{scheme}/{model} fold {res['fold']} FAILED:\n{res['error']}", "ERROR")
                continue
            oof[model][res["test_idx"]] = res["pred"]
            infos[model].append({"fold": res["fold"], **res["info"]})
            rows.append({"scheme": scheme, "model": model, "fold": int(res["fold"]),
                         **_regression_metrics(_Y_ALL[res["test_idx"]], res["pred"]),
                         "n_train": res["n_train"], "n_test": int(res["test_idx"].size),
                         "fit_seconds": float(res["seconds"]), "device": str(res["info"]["device"])})
        done = [r for r in rows if r["model"] == model]
        if done:
            log(f"{scheme:>8} | {model:<13} R2 = {np.mean([r['r2'] for r in done]):.3f}  "
                f"RMSE = {np.mean([r['rmse'] for r in done]):.3f}  ({len(done)} folds, {done[0]['device']})")
        free_memory()
    return rows, oof, infos


_resolve_lgbm_device()
_fold_rows, OOF_PRED, _FOLD_INFO = [], {}, {}
for _scheme in SCHEMES:
    with timer(f"cv_{_scheme}"):
        _rows, OOF_PRED[_scheme], _FOLD_INFO[_scheme] = run_scheme(_scheme)
    _fold_rows.extend(_rows)

_FOLD_COLUMNS = ["scheme", "model", "fold", "r2", "rmse", "mae", "n_train", "n_test", "fit_seconds", "device"]
CV_FOLD_METRICS = pd.DataFrame(_fold_rows, columns=_FOLD_COLUMNS).astype(
    {"fold": "int64", "n_train": "int64", "n_test": "int64", "r2": "float64", "rmse": "float64", "mae": "float64",
     "fit_seconds": "float64"})
del _fold_rows, _rows

# %% [markdown]
# ### 3.4 Summary and XGBoost round budget
# `std` is the across-fold sample standard deviation (0 for the single temporal fold). `XGB_BEST_ROUNDS` (number of
# boosting rounds = best iteration + 1 of each spatial fold) sets the final model's round budget in section 4.

# %%
def _cv_summary(fold_metrics):
    rows = []
    for scheme in SCHEMES:
        for model in MODEL_NAMES:
            sub = fold_metrics[(fold_metrics["scheme"] == scheme) & (fold_metrics["model"] == model)]
            if sub.empty:
                continue
            row = {"scheme": scheme, "model": model}
            for metric in ("r2", "rmse", "mae"):
                row[f"{metric}_mean"] = float(sub[metric].mean())
                row[f"{metric}_std"] = float(sub[metric].std(ddof=1)) if len(sub) > 1 else 0.0
            row["n_folds"] = int(len(sub))
            rows.append(row)
    cols = ["scheme", "model", "r2_mean", "r2_std", "rmse_mean", "rmse_std", "mae_mean", "mae_std", "n_folds"]
    return pd.DataFrame(rows, columns=cols)


def _best_rounds():
    for scheme in ("spatial", "random", "temporal"):
        rounds = [int(i["best_iteration"]) + 1 for i in _FOLD_INFO.get(scheme, {}).get("xgboost", [])
                  if i.get("best_iteration") is not None]
        if rounds:
            if scheme != "spatial":
                log(f"no spatial-CV XGBoost folds succeeded; using {scheme}-CV best rounds", "WARNING")
            return rounds
    fallback = max(1, int(CFG.XGB_MAX_ROUNDS) // 3)
    log(f"no XGBoost CV fold succeeded; XGB_BEST_ROUNDS falls back to [{fallback}]", "WARNING")
    return [fallback]


CV_SUMMARY = _cv_summary(CV_FOLD_METRICS)
XGB_BEST_ROUNDS = _best_rounds()
log(f"XGB_BEST_ROUNDS (spatial CV) = {XGB_BEST_ROUNDS}")
try:
    from IPython.display import display

    display(CV_SUMMARY.round(4))
except Exception:
    print(CV_SUMMARY.round(4).to_string())

# %% [markdown]
# ### 3.5 Spatial autocorrelation of residuals (Moran's I)
# $$I = \frac{n}{S_0}\,\frac{\sum_i\sum_j w_{ij} z_i z_j}{\sum_i z_i^2},\qquad E[I] = -\frac{1}{n-1}$$
# with $z$ the mean-centred residuals, $w_{ij}$ row-standardised KNN weights ($S_0 = n$). Inference is by random
# permutation (`CFG.MORAN_PERMS`): the pseudo p-value is the one-sided folded count $(\min(\#\{I_{sim} \ge I\}, P - \#\{\cdot\}) + 1)/(P + 1)$
# and $z = (I - \bar I_{sim})/\mathrm{sd}(I_{sim})$ — exactly PySAL's `p_sim` / `z_sim`. `esda.Moran` is used when
# installed; the vectorised NumPy/SciPy fallback computes the same statistics (checked below).

# %%
def _knn_weights(xy, k):
    """Row-standardised KNN weights (csr, n x n) over the given coordinates."""
    n = xy.shape[0]
    neigh = _knn_indices(xy, k)
    if neigh is None:
        return sparse.csr_matrix((n, n), dtype=np.float64)
    k_eff = neigh.shape[1]
    rows = np.repeat(np.arange(n), k_eff)
    return sparse.csr_matrix((np.full(rows.size, 1.0 / k_eff), (rows, neigh.ravel())), shape=(n, n))


_EPOCH_ROWS = {int(y): np.flatnonzero(DF["year"].to_numpy() == y) for y in np.unique(DF["year"].to_numpy())}
_XY_ALL = DF[["x", "y"]].to_numpy(np.float64)
SPATIAL_WEIGHTS = {year: _knn_weights(_XY_ALL[rows], int(CFG.MORAN_K)) for year, rows in _EPOCH_ROWS.items()}

_PYSAL_W_CACHE = {}


def _pysal_weights(W):
    """libpysal W for a csr matrix (cached per matrix object; the object is kept alive by the cache)."""
    key = id(W)
    if key not in _PYSAL_W_CACHE:
        from libpysal.weights import W as PysalW

        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            _PYSAL_W_CACHE[key] = (W, PysalW.from_sparse(sparse.csr_matrix(W)))
    return _PYSAL_W_CACHE[key][1]


def _moran_numpy(y, W, permutations, seed):
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


def morans_i(values, W, permutations=None, *, backend="auto"):
    """Global Moran's I of ``values`` with row-standardised weights ``W`` (csr).

    Returns ``{"I", "expected_I", "z", "p", "backend"}`` with permutation-based z and pseudo-p
    (``esda`` ``z_sim``/``p_sim``; analytic normal z/p when ``permutations == 0``).
    ``backend``: "auto" (esda if installed), "esda" or "numpy".
    """
    y = np.asarray(values, dtype=np.float64).ravel()
    if y.size != W.shape[0]:
        raise ValueError(f"values ({y.size}) and weights ({W.shape}) differ in size")
    perms = int(CFG.MORAN_PERMS if permutations is None else permutations)
    if y.size < 3 or not np.all(np.isfinite(y)):
        return {"I": np.nan, "expected_I": np.nan, "z": np.nan, "p": np.nan, "backend": "none"}
    if backend in ("auto", "esda"):
        try:
            import esda

            state = np.random.get_state()
            np.random.seed(int(CFG.SEED))  # esda permutes with the global NumPy RNG
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    mi = esda.Moran(y, _pysal_weights(W), transformation="r", permutations=perms)
            finally:
                np.random.set_state(state)
            z, p = (mi.z_sim, mi.p_sim) if perms else (mi.z_norm, mi.p_norm)
            return {"I": float(mi.I), "expected_I": float(mi.EI), "z": float(z), "p": float(p), "backend": "esda"}
        except ImportError:
            if backend == "esda":
                raise
    res = _moran_numpy(y, W, perms, int(CFG.SEED))
    if not perms:  # analytic z under normality for row-standardised W
        s0 = float(W.sum())
        s1 = 0.5 * float((W + W.T).multiply(W + W.T).sum())
        s2 = float(((np.asarray(W.sum(axis=1)).ravel() + np.asarray(W.sum(axis=0)).ravel()) ** 2).sum())
        n = y.size
        var = (n * n * s1 - n * s2 + 3 * s0 * s0) / ((n - 1) * (n + 1) * s0 * s0) - (1.0 / (n - 1)) ** 2
        from scipy.stats import norm

        res["z"] = (res["I"] - res["expected_I"]) / np.sqrt(var)
        res["p"] = float(2 * norm.sf(abs(res["z"])))
    res["backend"] = "numpy"
    return {k: (float(v) if k != "backend" else v) for k, v in res.items()}


def _check_moran_backends():
    """Runtime consistency check: esda and the NumPy fallback must give the same I on the first epoch."""
    year = min(_EPOCH_ROWS)
    y = _Y_ALL[_EPOCH_ROWS[year]]
    ref = morans_i(y, SPATIAL_WEIGHTS[year], 0, backend="numpy")
    try:
        other = morans_i(y, SPATIAL_WEIGHTS[year], 0, backend="esda")
    except ImportError:
        log("esda/libpysal not installed - Moran's I uses the NumPy/SciPy implementation")
        return
    diff = abs(ref["I"] - other["I"]) + abs(ref["z"] - other["z"])
    level = "INFO" if diff < 1e-8 else "WARNING"
    log(f"Moran backends agree: |dI| + |dz| = {diff:.2e} (esda vs numpy, year {year})", level)


def _residual_moran(scheme, model, year):
    """Moran's I of OOF residuals for one epoch; KNN rebuilt on the predicted subset when rows are missing."""
    rows = _EPOCH_ROWS[year]
    pred = OOF_PRED[scheme][model][rows]
    ok = np.isfinite(pred)
    if ok.sum() < max(10, int(CFG.MORAN_K) + 2):
        return None
    resid = _Y_ALL[rows].astype(np.float64) - pred.astype(np.float64)
    if ok.all():
        return morans_i(resid, SPATIAL_WEIGHTS[year])
    W_sub = _knn_weights(_XY_ALL[rows[ok]], int(CFG.MORAN_K))
    return morans_i(resid[ok], W_sub)


def _moran_tables():
    target_rows, result_rows = [], []
    for year, rows in _EPOCH_ROWS.items():
        res = morans_i(_Y_ALL[rows], SPATIAL_WEIGHTS[year])
        target_rows.append({"year": year, **{k: res[k] for k in ("I", "expected_I", "z", "p")}})
    for scheme in SCHEMES:
        for model in MODEL_NAMES:
            for year in _EPOCH_ROWS:
                res = _residual_moran(scheme, model, year)
                if res is not None:
                    result_rows.append({"scheme": scheme, "model": model, "year": year,
                                        **{k: res[k] for k in ("I", "expected_I", "z", "p")}})
    cols = ["scheme", "model", "year", "I", "expected_I", "z", "p"]
    return (pd.DataFrame(result_rows, columns=cols).astype({"year": "int64"}),
            pd.DataFrame(target_rows, columns=["year", "I", "expected_I", "z", "p"]).astype({"year": "int64"}))


def _moran_scatter(max_points=2000):
    """Moran scatter data per model (spatial scheme, last epoch): standardised residual z vs spatial lag W z."""
    out = {}
    rows = _EPOCH_ROWS[_LAST_EPOCH]
    W = SPATIAL_WEIGHTS[_LAST_EPOCH]
    rng = np.random.default_rng(CFG.SEED)
    for model in MODEL_NAMES:
        pred = OOF_PRED["spatial"][model][rows]
        if not np.all(np.isfinite(pred)):
            continue
        resid = _Y_ALL[rows].astype(np.float64) - pred
        sd = resid.std()
        if sd == 0:
            continue
        z = (resid - resid.mean()) / sd
        lag = W @ z
        sel = MORAN_RESULTS[(MORAN_RESULTS["scheme"] == "spatial") & (MORAN_RESULTS["model"] == model)
                            & (MORAN_RESULTS["year"] == _LAST_EPOCH)]
        slope = float(sel["I"].iloc[0]) if len(sel) else float(z @ lag / (z @ z))
        pick = np.sort(rng.choice(z.size, size=min(max_points, z.size), replace=False))
        out[model] = {"year": _LAST_EPOCH, "z": z[pick].astype(float).tolist(),
                      "lag": np.asarray(lag)[pick].astype(float).tolist(), "slope": slope}
    return out


with timer("moran"):
    _check_moran_backends()
    MORAN_RESULTS, MORAN_TARGET = _moran_tables()
    MORAN_SCATTER = _moran_scatter()
print("Moran's I of the target by epoch:")
print(MORAN_TARGET.round(4).to_string(index=False))
print("Moran's I of spatial-CV residuals (model x year):")
print(MORAN_RESULTS[MORAN_RESULTS["scheme"] == "spatial"].pivot(index="model", columns="year", values="I")
      .reindex([m for m in MODEL_NAMES if m in set(MORAN_RESULTS["model"])]).round(3).to_string())

# %% [markdown]
# ### 3.6 Figures
# Grouped bars compare models across the three schemes (error bars = across-fold s.d.); the heatmap shows residual
# Moran's I by model and epoch under spatial CV; the hexbin checks calibration of the spatial-CV XGBoost predictions.

# %%
_SCHEME_COLORS = {"random": "#2a78d6", "spatial": "#eb6834", "temporal": "#1baf7a"}


def _plot_cv_bars():
    import matplotlib.pyplot as plt

    models = [m for m in MODEL_NAMES if m in set(CV_SUMMARY["model"])]
    if not models:
        log("no CV results to plot", "WARNING")
        return
    fig, axes = plt.subplots(1, 2, figsize=(13, 4.8))
    width = 0.8 / len(SCHEMES)
    xpos = np.arange(len(models))
    for ax, metric, label in ((axes[0], "r2", "R²"), (axes[1], "rmse", "RMSE (°C)")):
        for s_i, scheme in enumerate(SCHEMES):
            sub = CV_SUMMARY[CV_SUMMARY["scheme"] == scheme].set_index("model").reindex(models)
            ax.bar(xpos + (s_i - (len(SCHEMES) - 1) / 2) * width, sub[f"{metric}_mean"], width * 0.92,
                   yerr=sub[f"{metric}_std"], capsize=3, color=_SCHEME_COLORS[scheme], label=scheme,
                   error_kw={"elinewidth": 1, "ecolor": "#52514e"})
        ax.set_xticks(xpos)
        ax.set_xticklabels(models, rotation=20)
        ax.set_ylabel(label)
        ax.grid(axis="y", color="#e0dfdb", linewidth=0.6)
        ax.set_axisbelow(True)
        for side in ("top", "right"):
            ax.spines[side].set_visible(False)
    axes[0].legend(title="CV scheme", frameon=False)
    axes[0].set_title("Out-of-fold R² by model and scheme")
    axes[1].set_title("Out-of-fold RMSE by model and scheme")
    fig.tight_layout()
    fig.savefig(Path(CFG.FIG_DIR) / "03_cv_performance.png", dpi=150)
    plt.show()
    plt.close(fig)


def _plot_moran_heatmap():
    import matplotlib.pyplot as plt
    from matplotlib.colors import LinearSegmentedColormap

    sub = MORAN_RESULTS[MORAN_RESULTS["scheme"] == "spatial"]
    if sub.empty:
        log("no spatial-CV Moran results to plot", "WARNING")
        return
    table = sub.pivot(index="model", columns="year", values="I")
    table = table.reindex([m for m in MODEL_NAMES if m in table.index])
    vmax = max(0.05, float(np.nanmax(np.abs(table.to_numpy()))))
    cmap = LinearSegmentedColormap.from_list("div", ["#2a78d6", "#f0efec", "#e34948"])
    fig, ax = plt.subplots(figsize=(1.6 * table.shape[1] + 3, 0.55 * table.shape[0] + 1.8))
    im = ax.imshow(table.to_numpy(), cmap=cmap, vmin=-vmax, vmax=vmax, aspect="auto")
    ax.set_xticks(range(table.shape[1]))
    ax.set_xticklabels(table.columns)
    ax.set_yticks(range(table.shape[0]))
    ax.set_yticklabels(table.index)
    for i in range(table.shape[0]):
        for j in range(table.shape[1]):
            if np.isfinite(table.iat[i, j]):
                ax.text(j, i, f"{table.iat[i, j]:.2f}", ha="center", va="center", fontsize=9, color="#0b0b0b")
    fig.colorbar(im, ax=ax, label="Moran's I of residuals")
    ax.set_title("Residual spatial autocorrelation (spatial CV)")
    fig.tight_layout()
    fig.savefig(Path(CFG.FIG_DIR) / "03_moran_residuals_heatmap.png", dpi=150)
    plt.show()
    plt.close(fig)


def _plot_pred_vs_obs():
    """Hexbin of spatial-CV XGBoost OOF predictions against observations.

    The axes are in °C (anomaly + observed epoch mean) for readability, but the title reports the metrics in TARGET
    units (the anomaly in the default mode) - the quantity the CV actually scores. Adding the per-epoch means back to
    both axes would credit the inter-epoch variance to the model for free and inflate R².
    """
    import matplotlib.pyplot as plt

    pred = OOF_PRED["spatial"].get("xgboost")
    ok = np.isfinite(pred) if pred is not None else None
    if pred is None or not ok.any():
        log("no spatial XGBoost OOF predictions to plot", "WARNING")
        return
    offset = DF["epoch_mean"].to_numpy(np.float64) if CFG.TARGET_MODE == "anomaly" else 0.0
    pred_c = (pred + offset)[ok]
    obs_c = DF["lst"].to_numpy(np.float64)[ok]
    metrics = _regression_metrics(_Y_ALL[ok], pred[ok])   # target units (anomaly), as in CV_SUMMARY
    lo, hi = np.percentile(np.concatenate([obs_c, pred_c]), [0.5, 99.5])
    fig, ax = plt.subplots(figsize=(6, 5.4))
    hb = ax.hexbin(obs_c, pred_c, gridsize=60, extent=(lo, hi, lo, hi), mincnt=1, cmap="Blues", bins="log")
    ax.plot([lo, hi], [lo, hi], color="#52514e", linewidth=1, linestyle="--", label="1:1")
    unit = "anomaly" if CFG.TARGET_MODE == "anomaly" else "°C"
    suffix = "; anomaly + observed epoch mean" if CFG.TARGET_MODE == "anomaly" else ""
    ax.set_xlabel(f"Observed LST (°C{suffix})")
    ax.set_ylabel(f"Predicted LST, spatial-CV OOF (°C{suffix})")
    ax.set_title(f"XGBoost spatial CV ({unit}): R² = {metrics['r2']:.3f}, RMSE = {metrics['rmse']:.2f} °C",
                 fontsize=10)
    ax.legend(frameon=False, loc="upper left")
    fig.colorbar(hb, ax=ax, label="cells (log)")
    fig.tight_layout()
    fig.savefig(Path(CFG.FIG_DIR) / "03_pred_vs_obs_hexbin.png", dpi=150)
    plt.show()
    plt.close(fig)


Path(CFG.FIG_DIR).mkdir(parents=True, exist_ok=True)
for _plot in (_plot_cv_bars, _plot_moran_heatmap, _plot_pred_vs_obs):
    try:
        _plot()
    except Exception:
        log(f"figure {_plot.__name__} failed:\n{traceback.format_exc()}", "WARNING")

# %% [markdown]
# ### 3.7 Persist validation tables

# %%
def _save_validation_tables():
    out_dir = Path(CFG.PARQUET_DIR)
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, frame in (("cv_fold_metrics", CV_FOLD_METRICS), ("cv_summary", CV_SUMMARY),
                        ("moran_results", MORAN_RESULTS)):
        path = out_dir / f"{name}.parquet"
        frame.to_parquet(path, engine="pyarrow", compression="zstd", index=False)
        log(f"saved {path} ({len(frame)} rows)")


_save_validation_tables()
_PYSAL_W_CACHE.clear()
_GNN_GRAPH = None
free_memory()
