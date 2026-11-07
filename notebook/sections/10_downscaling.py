# %% [markdown]
# # 10. Fine-resolution fields (250 m): day Landsat, night DMS downscaling, validation and EPSG:4326 rasters
#
# The 1 km grid is the analysis grid of sections 06–09. The dashboard additionally shows every observed frame on
# the **fine grid** `GRID_FINE` (250 m at the 1 km grid; fine pixel (r, c) lies in cell (r // 4, c // 4)).
#
# **Day** is natively fine: the harmonised Landsat C2 L2 composite `lst_day_f` exists at 250 m (mean of 30 m
# pixels), so the day fine field is *observed*: `lst_day_f` + the frame's overpass correction (SPEC §4.7, the same
# correction section 09 applies to the 1 km level), with fine pixels resting on fewer than two clear scenes masked.
#
# **Night** exists only at 1 km (MODIS Aqua / calibrated VIIRS / calibrated Terra; modelled for 1990/1995), so it is
# **downscaled** with a Data-Mining-Sharpener-style regression (Gao, Kustas & Anderson 2012; Hutengs & Vohland 2016):
#
# 1. Fine predictors $P_f$ (10): `ndvi_f, ndbi_f, mndwi_f, albedo_f, built_f, water_occ_f, elevation_f`, the fine
#    topographic position `tpi_f = elevation_f − box7(elevation_f)` (cold-air pooling) and two neighbourhood terms,
#    `box5(ndvi_f)` and `box9(built_f)` (≈ 1.25 km / 2.25 km context at 250 m). Coarse predictors $P_c$ are the
#    exact 4 × 4 block means of $P_f$, so the regression learnt at 1 km is applied to the same quantities at 250 m.
# 2. XGBoost (depth 6, 600 rounds, η 0.05) learns $T_c = g(P_c)$ on the 1 km cells with a valid night value,
#    **excluding the 20 % most heterogeneous cells** (sum of the z-scored within-cell standard deviations of NDVI and
#    built-up fraction): inside a mixed cell the 1 km mean is a poor label for the sub-pixel predictor mixture.
# 3. $\hat T_f = g(P_f)$; residual $r_c = T_c − \overline{\hat T_f}^{(4×4)}$ is interpolated **bilinearly** at the
#    fine-pixel centres (a constant per-cell redistribution would leave block artefacts) and added.
# 4. Three iterations of **block conservation** $e_c = T_c − \overline{T_f}^{(4×4)}$, $T_f \mathrel{+}= e_c$
#    (nearest-upsampled) make every 4 × 4 block average back to the 1 km value: $|e_c| < 0.01$ °C is asserted. The
#    downscaled field therefore *adds* sub-pixel structure without changing a single 1 km number.
#
# Observed night frames are downscaled where the 1 km value exists (NaN elsewhere); the modelled 1990/1995 frames
# downscale the complete modelled 1 km field of section 09.
#
# **Validation (SPEC §4.8).**
# * *Scale invariance* (Bartkowiak et al. 2019): aggregate the 1 km night anomalies and the 1 km predictors to
#   4 × 4 coarse cells (4 km at the 1 km grid), train at the coarse scale on the block20 folds ≠ k (strictly: coarse
#   cells containing any valid fold-k cell are excluded from training), downscale coarse → 1 km and score the held-out
#   fold-k 1 km cells against the true 1 km values — against the bilinear interpolation of the coarse field as the
#   baseline. The test assumes the predictor–LST relation is similar across the 4 km → 1 km and 1 km → 250 m steps.
# * *Day demonstration*: MODIS Terra day LST (1 km, 2010/2015/2020) is downscaled to the fine grid with the same
#   algorithm and compared, as anomalies (each product minus its own mean over the common pixels, which removes the
#   overpass/algorithm offset), with the Landsat fine composite — pooled and by dominant GLC class, vs bilinear.
#
# **Rasters.** Each fine field is reprojected from UTM 43N to a regular **EPSG:4326** lon/lat grid (0.0025° ≈ 250 m
# and a 0.005° "500 m" preview at the 1 km analysis grid; both scale with the fine-pixel size) by **inverse
# mapping**: every output pixel centre is transformed with pyproj (in memory-bounded row chunks) and takes the
# nearest fine pixel. Placing UTM imagery on Mercator bounds would shift pixels by up to ~4 km at the NCR's edges.
# PNG (8-bit RGB, Pillow): R = 0 nodata, else $1 + \mathrm{round}((v − lo)/(hi − lo) · 254)$ clipped to 1…255;
# G = flags (`FINE_FLAGS`: bit 0 outside the AOA, bits 1–2 tier code 0 observed / 1 observed-sparse or
# reconstructed / 2 modelled / 3 downscaled); B = 0. The value domain is **fixed per mode**: p0.5–p99.5 of all
# observed fine fields of the mode, padded by 3 °C (room for the projected warming, so a projected raster never
# clips) and rounded outward to 1 °C.
#
# Outputs (SPEC §3.7): `FINE_FIELDS[m][year]` (Hf, Wf) float32 °C, `FINE_FLAGS[m][year]` uint8,
# `DOWNSCALING_METRICS`, `RASTER_INDEX` and the PNGs under `CFG.WEB_DIR/raster/` (+ `raster_index.json`).

# %%
import hashlib as _s10_hashlib
import math as _s10_math
import time as _s10_time
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import xgboost as xgb
from scipy import ndimage as _s10_ndi

_S10_VERSION = "10-v2.0"
_S10_F = int(CFG.FINE_FACTOR)
_S10_NC = int(N_CELLS)
_S10_H, _S10_W = (int(v) for v in ROI_MASK.shape)
_S10_HF, _S10_WF = _S10_H * _S10_F, _S10_W * _S10_F
_S10_FRAMES = sorted(int(y) for y in np.unique(DF["year"].to_numpy()))
_S10_MODES = [m for m in CFG.MODES if m in FRAME_FIELDS]
_S10_FINE_RES_M = float(GRID_FINE.res)
_S10_PRED_NAMES = ["ndvi_f", "ndbi_f", "mndwi_f", "albedo_f", "built_f", "water_occ_f", "elevation_f", "tpi_f",
                   "ndvi_f_box5", "built_f_box9"]
_S10_HET_IDX = (_S10_PRED_NAMES.index("ndvi_f"), _S10_PRED_NAMES.index("built_f"))
# SPEC §4.8 regression: XGBoost depth 6, 600 rounds, eta 0.05 (remaining settings = robust defaults for ~10^4 rows)
_S10_XGB_PARAMS = {"objective": "reg:squarederror", "tree_method": "hist", "max_depth": 6, "learning_rate": 0.05,
                   "subsample": 0.8, "colsample_bytree": 0.9, "min_child_weight": 5, "reg_lambda": 1.0,
                   "max_bin": 256}
_S10_ROUNDS = 600
_S10_HET_DROP = 0.20                  # share of most heterogeneous cells excluded from training
_S10_CONSERVE_ITERS = 3
_S10_CONSERVE_TOL_C = 0.01            # asserted max |block mean - 1 km value|
_S10_MIN_TRAIN = 30                   # fewer training cells -> no regression (bilinear + conservation only)
_S10_SCALE_FACTOR = 4                 # scale-invariance test: 4 x 4 cells (4 km at the 1 km grid)
_S10_SCALE_MIN_VALID = 0.5            # a coarse test cell needs >= 50 % valid 1 km cells
_S10_DEMO_YEARS = [2010, 2015, 2020]  # MODIS Terra day demonstration (SPEC §4.8 b)
_S10_DAY_MIN_SCENES = 2.0             # fine day pixels resting on < 2 clear scenes are NaN (SPEC §4.8)
_S10_TIER_CODE = {"observed": 0, "observed-sparse": 1, "reconstructed": 1, "modelled": 2, "downscaled": 3}
_S10_RES_SCALE = _S10_FINE_RES_M / 250.0
_S10_RASTER_RES_DEG = round(0.0025 * _S10_RES_SCALE, 10)   # 0.0025 deg at the 250 m fine grid (SPEC §4.8)
_S10_PREVIEW_RES_DEG = round(0.005 * _S10_RES_SCALE, 10)   # "500 m" preview
_S10_DOMAIN_PAD_C = 3.0
_S10_DOMAIN_Q = (0.5, 99.5)
_S10_MAP_CHUNK_PX = 1 << 21           # output pixels per pyproj inverse-mapping chunk (~2 M -> ~50 MB peak)
_S10_PRED_CHUNK = 1 << 20             # fine pixels per XGBoost prediction call
_S10_RASTER_DIR = Path(CFG.WEB_DIR) / "raster"
_S10_FIG_DIR = Path(CFG.FIG_DIR)
_S10_GLC_KEYS = ["glc_built", "glc_forest", "glc_water", "glc_cropland", "glc_barren", "glc_otherveg"]
_S10_CLASS_LABEL = {k + 1: LC_CLASS_NAMES.get(k + 1, f"class {k + 1}") for k in range(6)}
if len(DF) != len(_S10_FRAMES) * _S10_NC:
    raise RuntimeError("10: DF is not the (frame x canonical cell) table of section 06")
if GRID_FINE.shape != (_S10_HF, _S10_WF) or ROI_MASK_FINE.shape != (_S10_HF, _S10_WF):
    raise RuntimeError(f"10: GRID_FINE {GRID_FINE.shape} is not the {_S10_F}x refinement of GRID {GRID.shape}")
log(f"10: fine grid {_S10_WF}x{_S10_HF} @ {_S10_FINE_RES_M:g} m (factor {_S10_F}); modes {_S10_MODES}; frames "
    f"{_S10_FRAMES}; rasters {_S10_RASTER_RES_DEG:g} deg (+ {_S10_PREVIEW_RES_DEG:g} deg preview)")

# %% [markdown]
# ## 10.1 Grid operators
# Block statistics reshape a fine raster to `(h, f, w, f)` and reduce over the two `f` axes, optionally over a
# validity mask — the block mean "over the pixels that carry the field" is what block conservation must preserve.
# Bilinear upsampling is separable: coarse cell centres sit at fine coordinate $(R + ½)f$, so a fine pixel centre
# $i + ½$ has coarse coordinate $u = (i + ½)/f − ½$ and weights $(1 − \{u\}, \{u\})$ on its two neighbours
# (clamped at the edges). NaN-aware box means use the ratio of filtered value·mask and filtered mask (zero padding),
# i.e. the mean of the valid pixels inside the window.

# %%
def _s10_cell_grid(values, fill=np.nan, dtype=np.float32):
    """(N_CELLS,) canonical vector -> (H, W) grid (``fill`` outside the ROI)."""
    out = np.full((_S10_H, _S10_W), fill, dtype=dtype)
    out[CELL_ROWS, CELL_COLS] = np.asarray(values).astype(dtype, copy=False)
    return out


def _s10_block_mean(fine, f, valid=None):
    """NaN-aware mean of every f x f block (optionally only over ``valid`` pixels) -> (mean float64, count int)."""
    fine = np.asarray(fine)
    h, w = fine.shape[0] // f, fine.shape[1] // f
    if fine.shape != (h * f, w * f):
        raise ValueError(f"raster {fine.shape} is not a multiple of {f}")
    blocks = fine.reshape(h, f, w, f)
    ok = np.isfinite(blocks)
    if valid is not None:
        ok &= np.asarray(valid, bool).reshape(h, f, w, f)
    n = ok.sum(axis=(1, 3))
    s = np.where(ok, blocks, 0.0).sum(axis=(1, 3), dtype=np.float64)
    with np.errstate(invalid="ignore", divide="ignore"):
        mean = s / n
    mean[n == 0] = np.nan
    return mean, n


def _s10_block_std(fine, f):
    """NaN-aware population standard deviation of every f x f block (NaN with < 2 valid pixels)."""
    fine = np.asarray(fine, np.float64)
    h, w = fine.shape[0] // f, fine.shape[1] // f
    blocks = fine.reshape(h, f, w, f)
    ok = np.isfinite(blocks)
    n = ok.sum(axis=(1, 3))
    x = np.where(ok, blocks, 0.0)
    with np.errstate(invalid="ignore", divide="ignore"):
        m1 = x.sum(axis=(1, 3)) / n
        m2 = (x * x).sum(axis=(1, 3)) / n
    sd = np.sqrt(np.maximum(m2 - m1 * m1, 0.0))
    sd[n < 2] = np.nan
    return sd


def _s10_upsample(coarse, f):
    """Nearest (block-repeat) upsampling by an integer factor."""
    return np.repeat(np.repeat(np.asarray(coarse), f, axis=0), f, axis=1)


def _s10_lin_axis(n_coarse, f):
    u = (np.arange(n_coarse * f, dtype=np.float64) + 0.5) / f - 0.5
    i0 = np.clip(np.floor(u).astype(np.int64), 0, n_coarse - 1)
    i1 = np.clip(i0 + 1, 0, n_coarse - 1)
    w = np.clip(u - i0, 0.0, 1.0)
    return i0, i1, w


def _s10_bilinear_up(coarse, f):
    """Separable bilinear interpolation of a COMPLETE (finite) coarse raster at the fine-pixel centres (float32)."""
    c = np.asarray(coarse, np.float32)
    r0, r1, wr = _s10_lin_axis(c.shape[0], f)
    c0, c1, wc = _s10_lin_axis(c.shape[1], f)
    wr, wc = wr.astype(np.float32), wc.astype(np.float32)
    tmp = c[r0] * (1.0 - wr)[:, None] + c[r1] * wr[:, None]
    out = tmp[:, c0] * (1.0 - wc)[None, :] + tmp[:, c1] * wc[None, :]
    return out.astype(np.float32, copy=False)


def _s10_fill_nearest(a):
    """Replace NaN by the nearest finite value (Euclidean); all-NaN -> zeros."""
    a = np.asarray(a, np.float64)
    ok = np.isfinite(a)
    if ok.all():
        return a.copy()
    if not ok.any():
        return np.zeros_like(a)
    idx = _s10_ndi.distance_transform_edt(~ok, return_distances=False, return_indices=True)
    return a[tuple(idx)]


def _s10_box_mean(x, size, valid):
    """NaN-aware box mean over ``valid`` pixels (float32 output, NaN where the window has no valid pixel)."""
    x = np.asarray(x, np.float64)
    m = np.asarray(valid, bool) & np.isfinite(x)
    num = _s10_ndi.uniform_filter(np.where(m, x, 0.0), size=int(size), mode="constant", cval=0.0)
    den = _s10_ndi.uniform_filter(m.astype(np.float64), size=int(size), mode="constant", cval=0.0)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = num / den
    out[den < 0.5 / (size * size)] = np.nan
    return out.astype(np.float32)


def _s10_pad_to(a, f, fill):
    """Pad a 2-D (or leading-axis-stacked 3-D) raster at the bottom/right to multiples of f."""
    a = np.asarray(a)
    h, w = a.shape[-2:]
    ph, pw = (-h) % f, (-w) % f
    if not (ph or pw):
        return a
    pad = [(0, 0)] * (a.ndim - 2) + [(0, ph), (0, pw)]
    return np.pad(a, pad, mode="constant", constant_values=fill)


def _s10_dominant_class(year):
    """(H, W) uint8 dominant GLC class (1 built … 6 other vegetation; 0 outside the ROI / no data)."""
    raw = RAW_OBS[year]
    stack = np.stack([np.nan_to_num(np.asarray(raw[k], np.float64), nan=-1.0) for k in _S10_GLC_KEYS])
    dom = (np.argmax(stack, axis=0) + 1).astype(np.uint8)
    dom[~ROI_MASK | (stack.max(axis=0) < 0)] = 0
    return dom


# %% [markdown]
# ## 10.2 Fine predictors and the generic DMS routine
# `_s10_dms` is written for *any* pair of nested grids (factor f), so the operational 1 km → 250 m step, the
# 4 km → 1 km scale-invariance test and the MODIS-day demonstration run the very same code.

# %%
_S10_STATIC = {}


def _s10_static_fine():
    """Static fine predictors (computed once): water occurrence, elevation, fine TPI (elevation - box7)."""
    if not _S10_STATIC:
        roi_f = ROI_MASK_FINE
        elev = np.where(roi_f, np.asarray(RAW_STATIC["elevation_f"], np.float64), np.nan)
        _S10_STATIC["water_occ_f"] = np.where(roi_f, RAW_STATIC["water_occ_f"], np.nan).astype(np.float32)
        _S10_STATIC["elevation_f"] = elev.astype(np.float32)
        _S10_STATIC["tpi_f"] = (elev - _s10_box_mean(elev, 7, roi_f)).astype(np.float32)
    return _S10_STATIC


def _s10_fine_predictors(year):
    """(10, Hf, Wf) float32 fine predictor stack of one frame (NaN outside the ROI / where Landsat has no data)."""
    raw = RAW_OBS[year]
    roi_f = ROI_MASK_FINE
    st = _s10_static_fine()
    out = np.empty((len(_S10_PRED_NAMES), _S10_HF, _S10_WF), dtype=np.float32)
    for k, name in enumerate(_S10_PRED_NAMES[:5]):
        out[k] = np.where(roi_f, raw[name], np.nan)
    out[5] = st["water_occ_f"]
    out[6] = st["elevation_f"]
    out[7] = st["tpi_f"]
    out[8] = _s10_box_mean(out[0], 5, roi_f)
    out[9] = _s10_box_mean(out[4], 9, roi_f)
    out[:, ~roi_f] = np.nan
    return out


def _s10_coarse_predictors(pred_f, f):
    """Block means of every fine predictor -> (k, h, w) float32."""
    return np.stack([_s10_block_mean(p, f)[0] for p in pred_f]).astype(np.float32)


def _s10_heterogeneity(pred_f, f, cand):
    """Sum of z-scored within-cell std of NDVI and built-up fraction (over candidate cells; NaN std -> 0)."""
    score = np.zeros(cand.shape, np.float64)
    for k in _S10_HET_IDX:
        sd = _s10_block_std(pred_f[k], f)
        v = sd[cand & np.isfinite(sd)]
        if v.size >= 2 and np.std(v) > 0:
            score += np.nan_to_num((sd - v.mean()) / v.std(), nan=0.0)
    return score


def _s10_xgb_fit(X, y, device, seed):
    """Train the SPEC §4.8 regressor; a CUDA OOM retries on the CPU. Returns (booster, device used)."""
    for dev in dict.fromkeys([device, "cpu"]):
        params = dict(_S10_XGB_PARAMS, device=dev, seed=int(seed))
        try:
            dtrain = xgb.DMatrix(X, label=y, missing=np.nan)
            booster = xgb.train(params, dtrain, num_boost_round=_S10_ROUNDS, verbose_eval=False)
            del dtrain
            return booster, dev
        except Exception as exc:  # noqa: BLE001
            if dev == "cpu" or not is_gpu_oom_error(exc):
                raise
            log(f"10: GPU OOM in the DMS regression on {dev}; retrying on the CPU", "WARNING")
            free_memory()
    raise RuntimeError("unreachable")


def _s10_xgb_predict(booster, X):
    """Chunked in-place prediction (float32)."""
    out = np.empty(X.shape[0], dtype=np.float32)
    for s in range(0, X.shape[0], _S10_PRED_CHUNK):
        out[s:s + _S10_PRED_CHUNK] = booster.inplace_predict(np.ascontiguousarray(X[s:s + _S10_PRED_CHUNK]))
    return out


def _s10_dms(target_c, pred_f, f, train_c, fine_valid, *, device="cpu", seed=0, label="", keep_unobserved=False):
    """Data-Mining-Sharpener downscaling of ``target_c`` (h, w) by factor ``f`` with fine predictors ``pred_f``.

    Parameters
    ----------
    target_c : (h, w) coarse field (NaN = no observation).
    pred_f : (k, h*f, w*f) float32 fine predictors (NaN allowed; XGBoost routes missing values).
    train_c : (h, w) bool, coarse cells allowed as training rows (further restricted to finite targets and to the
        80 % least heterogeneous of them).
    fine_valid : (h*f, w*f) bool, fine pixels that carry the field; block means (residuals, conservation) run over
        these pixels only.
    keep_unobserved : keep the regression value (without residual correction) in coarse cells without a target;
        otherwise those fine pixels are NaN.

    Returns ``(field (h*f, w*f) float32, model-only field float32, info dict)``.
    """
    target_c = np.asarray(target_c, np.float64)
    fine_valid = np.asarray(fine_valid, bool)
    _, n_valid_c = _s10_block_mean(np.where(fine_valid, 0.0, np.nan), f)
    obs_c = np.isfinite(target_c) & (n_valid_c > 0)
    pred_c = _s10_coarse_predictors(pred_f, f)
    cand = np.asarray(train_c, bool) & obs_c
    het = _s10_heterogeneity(pred_f, f, cand)
    n_cand = int(cand.sum())
    if n_cand >= _S10_MIN_TRAIN:
        cut = float(np.quantile(het[cand], 1.0 - _S10_HET_DROP))
        train = cand & (het <= cut)
        if train.sum() < _S10_MIN_TRAIN:
            train = cand
    else:
        train = cand
    info = {"label": label, "n_candidates": n_cand, "n_train": int(train.sum()),
            "n_excluded_heterogeneous": int(n_cand - train.sum()), "device": None, "train_r2": None,
            "train_rmse": None}
    fine_pix = np.flatnonzero(fine_valid.ravel())
    t_hat = np.full(fine_valid.size, np.nan, dtype=np.float32)
    if int(train.sum()) >= _S10_MIN_TRAIN:
        X = pred_c[:, train].T.astype(np.float32)
        y = target_c[train].astype(np.float32)
        booster, used = _s10_xgb_fit(X, y, device, seed)
        booster.set_param({"device": "cpu"})          # host arrays -> CPU prediction (no device-mismatch copy)
        fitted = _s10_xgb_predict(booster, X).astype(np.float64)
        sse = float(np.sum((y - fitted) ** 2))
        sst = float(np.sum((y - y.mean()) ** 2))
        info.update({"device": used, "train_r2": 1.0 - sse / sst if sst > 0 else None,
                     "train_rmse": float(np.sqrt(sse / y.size))})
        Xf = pred_f.reshape(pred_f.shape[0], -1)[:, fine_pix].T
        t_hat[fine_pix] = _s10_xgb_predict(booster, Xf)
        del X, Xf, booster
    else:
        # too few cells for a regression: the coarse field itself (bilinear, then conserved) is the best estimate
        log(f"10: {label}: only {int(train.sum())} training cells - no regression, bilinear + conservation only",
            "WARNING")
        t_hat[fine_pix] = 0.0
    t_hat = t_hat.reshape(fine_valid.shape)
    model_only = t_hat.copy()
    # residual correction: bilinear r_c at fine centres, then block conservation over the valid fine pixels
    bm, _ = _s10_block_mean(t_hat, f, fine_valid)
    r_c = np.where(obs_c, target_c - bm, np.nan)
    info["resid_rmse_c"] = float(np.sqrt(np.nanmean(r_c[obs_c] ** 2))) if obs_c.any() else None
    field = t_hat + _s10_bilinear_up(_s10_fill_nearest(r_c), f)
    field[~fine_valid] = np.nan
    for _ in range(_S10_CONSERVE_ITERS):
        bm, _ = _s10_block_mean(field, f, fine_valid)
        e_c = np.where(obs_c, target_c - bm, 0.0)
        field += _s10_upsample(e_c, f).astype(np.float32)
    bm, _ = _s10_block_mean(field, f, fine_valid)
    err = np.abs(target_c - bm)[obs_c]
    info["max_block_error_c"] = float(err.max()) if err.size else 0.0
    info["n_coarse_observed"] = int(obs_c.sum())
    if not keep_unobserved:
        unobs = _s10_upsample(~obs_c, f)
        field[unobs] = np.nan
        model_only[unobs] = np.nan
    field[~fine_valid] = np.nan
    return field.astype(np.float32), model_only.astype(np.float32), info


# %% [markdown]
# ## 10.3 Fine fields per mode and frame (`FINE_FIELDS`, `FINE_FLAGS`)
# Day: observed Landsat + overpass correction. Night: one DMS regression per frame (DMS is calibrated per scene /
# epoch because the predictor–LST relation changes with season, moisture and sensor), spread over the GPUs with
# `gpu_pool_map`.

# %%
def _s10_day_fine(year):
    """Observed day fine field (°C, 10:45 IST reference) + info."""
    raw = RAW_OBS[year]
    lev = LEVELS["day"][year]
    corr = float(lev.get("overpass_correction") or 0.0)
    nobs = np.nan_to_num(np.asarray(raw["lst_day_nobs_f"], np.float64), nan=0.0)
    lst = np.asarray(raw["lst_day_f"], np.float64)
    ok = ROI_MASK_FINE & np.isfinite(lst) & (nobs >= _S10_DAY_MIN_SCENES)
    field = np.where(ok, lst + corr, np.nan).astype(np.float32)
    return field, {"overpass_correction_c": corr, "coverage": float(ok[ROI_MASK_FINE].mean()),
                   "n_valid": int(ok.sum()), "tier": FRAME_TIERS["day"][year]}


def _s10_night_job(year, gpu_id):
    """Downscale the night 1 km frame field of ``year`` (DMS) -> dict(field, info)."""
    t0 = _s10_time.perf_counter()
    tier = FRAME_TIERS["night"][year]
    coarse = _s10_cell_grid(FRAME_FIELDS["night"][year], dtype=np.float64)
    pred_f = _s10_fine_predictors(year)
    field, _, info = _s10_dms(coarse, pred_f, _S10_F, ROI_MASK, ROI_MASK_FINE, device=xgb_device_for(gpu_id),
                              seed=int(CFG.SEED) + 1000 + int(year), label=f"night {year}")
    del pred_f
    info.update({"tier": tier, "coverage": float(np.isfinite(field[ROI_MASK_FINE]).mean()),
                 "seconds": round(_s10_time.perf_counter() - t0, 2)})
    return {"field": field, "info": info}


def _s10_flags(mode, year, field):
    """FINE_FLAGS of one frame: bit 0 outside AOA (parent 1 km cell), bits 1-2 tier code; 0 on nodata pixels."""
    tier = FRAME_TIERS[mode][year]
    code = _S10_TIER_CODE["downscaled"] if (mode == "night" and tier != "modelled") else _S10_TIER_CODE.get(tier, 2)
    aoa = _s10_cell_grid(np.asarray(FRAME_AOA_OUT[mode][year], bool), fill=False, dtype=bool)
    flags = (np.uint8(code) << np.uint8(1)) | _s10_upsample(aoa, _S10_F).astype(np.uint8)
    flags = flags.astype(np.uint8)
    flags[~np.isfinite(field)] = 0
    return flags, code


# %% [markdown]
# ## 10.4 Validation: scale invariance (night) and the MODIS-day demonstration

# %%
def _s10_fold_grid():
    """(H, W) int block20 fold of every ROI cell (-1 outside), from DF (folds are constant across frames)."""
    sl = slice(0, _S10_NC)
    return _s10_cell_grid(DF["fold_block20"].to_numpy(np.int64)[sl], fill=-1, dtype=np.int64)


def _s10_scale_job(year, gpu_id):
    """Scale-invariance test of one night frame: coarse (4x) -> 1 km on every held-out block20 fold."""
    sl = slice(_S10_FRAMES.index(year) * _S10_NC, (_S10_FRAMES.index(year) + 1) * _S10_NC)
    anom = _s10_cell_grid(DF["anom_night"].to_numpy(np.float64)[sl], dtype=np.float64)
    pred_f = _s10_fine_predictors(year)
    pred_1km = _s10_coarse_predictors(pred_f, _S10_F)           # the "fine" level of the test = 1 km
    del pred_f
    k = _S10_SCALE_FACTOR
    folds = _s10_pad_to(_s10_fold_grid(), k, -1)
    a1 = _s10_pad_to(anom, k, np.nan)
    p1 = _s10_pad_to(pred_1km, k, np.nan).astype(np.float32)
    dom = _s10_pad_to(_s10_dominant_class(year), k, 0)
    valid1 = np.isfinite(a1)
    a4, n4 = _s10_block_mean(a1, k)
    a4[n4 < _S10_SCALE_MIN_VALID * k * k] = np.nan
    bil = _s10_bilinear_up(_s10_fill_nearest(a4), k)
    rows = []
    for fold in sorted(int(v) for v in np.unique(folds[folds >= 0])):
        in_fold = valid1 & (folds == fold)
        _, n_fold4 = _s10_block_mean(np.where(in_fold, 1.0, np.nan), k)
        train4 = np.isfinite(a4) & (n_fold4 == 0)
        field, model_only, info = _s10_dms(a4, p1, k, train4, valid1, device=xgb_device_for(gpu_id),
                                           seed=int(CFG.SEED) + 2000 + int(year) * 16 + fold,
                                           label=f"scale-invariance night {year} fold {fold}")
        test = in_fold & np.isfinite(field) & np.isfinite(bil)
        if test.sum() == 0:
            continue
        rows.append({"year": int(year), "fold": fold, "obs": a1[test].astype(np.float32),
                     "pred": field[test], "bil": bil[test], "model": model_only[test],
                     "cls": dom[test], "max_block_error_c": info["max_block_error_c"], "n_train": info["n_train"]})
    return rows


def _s10_metric(obs, pred):
    obs, pred = np.asarray(obs, np.float64), np.asarray(pred, np.float64)
    ok = np.isfinite(obs) & np.isfinite(pred)
    if ok.sum() < 3:
        return {"r2": None, "rmse": None, "bias": None, "n": int(ok.sum())}
    o, p = obs[ok], pred[ok]
    sst = float(np.sum((o - o.mean()) ** 2))
    sse = float(np.sum((o - p) ** 2))
    return {"r2": 1.0 - sse / sst if sst > 0 else None, "rmse": float(np.sqrt(sse / o.size)),
            "bias": float(np.mean(p - o)), "n": int(o.size)}


def _s10_by_class(obs, pred, base, cls):
    out = []
    for c in sorted(int(v) for v in np.unique(cls) if v > 0):
        sel = cls == c
        if sel.sum() < 20:
            continue
        m, b = _s10_metric(obs[sel], pred[sel]), _s10_metric(obs[sel], base[sel])
        out.append({"class": c, "label": _S10_CLASS_LABEL.get(c, str(c)), "n": m["n"], "r2": m["r2"],
                    "rmse": m["rmse"], "bias": m["bias"], "bilinear_r2": b["r2"], "bilinear_rmse": b["rmse"]})
    return out


def _s10_scale_summary(rows):
    if not rows:
        return {"available": False, "reason": "no night frame with valid anomalies"}, []
    obs = np.concatenate([r["obs"] for r in rows])
    pred = np.concatenate([r["pred"] for r in rows])
    bil = np.concatenate([r["bil"] for r in rows])
    mod = np.concatenate([r["model"] for r in rows])
    cls = np.concatenate([r["cls"] for r in rows])
    m, b, mo = _s10_metric(obs, pred), _s10_metric(obs, bil), _s10_metric(obs, mod)
    by_frame = []
    for y in sorted({r["year"] for r in rows}):
        sel = [r for r in rows if r["year"] == y]
        o = np.concatenate([r["obs"] for r in sel])
        mm = _s10_metric(o, np.concatenate([r["pred"] for r in sel]))
        bb = _s10_metric(o, np.concatenate([r["bil"] for r in sel]))
        by_frame.append({"year": int(y), "r2": mm["r2"], "rmse": mm["rmse"], "bias": mm["bias"], "n": mm["n"],
                         "bilinear_r2": bb["r2"], "bilinear_rmse": bb["rmse"], "n_folds": len(sel)})
    gain = (1.0 - m["rmse"] / b["rmse"]) if (m["rmse"] is not None and b["rmse"]) else None
    summary = {"available": True, "r2": m["r2"], "rmse": m["rmse"], "bias": m["bias"], "n": m["n"],
               "bilinear_r2": b["r2"], "bilinear_rmse": b["rmse"], "bilinear_bias": b["bias"],
               "model_only_r2": mo["r2"], "model_only_rmse": mo["rmse"], "rmse_gain_vs_bilinear": gain,
               "factor": _S10_SCALE_FACTOR, "coarse_res_m": int(GRID.res) * _S10_SCALE_FACTOR,
               "fine_res_m": int(GRID.res), "folds": "block20 (coarse training cells strictly outside the held-out "
                                                    "fold)", "target": "night anomaly (fixed-mask centred)",
               "frames": sorted({r["year"] for r in rows}), "n_fits": len(rows),
               "max_block_error_c": float(max(r["max_block_error_c"] for r in rows)), "by_frame": by_frame}
    return summary, _s10_by_class(obs, pred, bil, cls)


def _s10_day_demo_job(year, gpu_id):
    """Downscale MODIS Terra day (1 km) -> fine and compare anomalies with the Landsat fine composite."""
    raw = RAW_OBS[year]
    modis = np.where(ROI_MASK, np.asarray(raw["lst_day_modis"], np.float64), np.nan)
    if np.isfinite(modis).sum() < 100:
        return None
    pred_f = _s10_fine_predictors(year)
    field, _, info = _s10_dms(modis, pred_f, _S10_F, ROI_MASK, ROI_MASK_FINE, device=xgb_device_for(gpu_id),
                              seed=int(CFG.SEED) + 3000 + int(year), label=f"MODIS day {year}")
    del pred_f
    bil = _s10_bilinear_up(_s10_fill_nearest(modis), _S10_F)
    blk = _s10_upsample(modis, _S10_F).astype(np.float32)
    nobs = np.nan_to_num(np.asarray(raw["lst_day_nobs_f"], np.float64), nan=0.0)
    landsat = np.where(nobs >= _S10_DAY_MIN_SCENES, np.asarray(raw["lst_day_f"], np.float64), np.nan)
    ok = ROI_MASK_FINE & np.isfinite(landsat) & np.isfinite(field) & np.isfinite(blk)
    if ok.sum() < 100:
        return None
    dom = _s10_upsample(_s10_dominant_class(year), _S10_F)[ok]

    def anom(a):
        v = np.asarray(a, np.float64)[ok]
        return v - v.mean()

    return {"year": int(year), "obs": anom(landsat).astype(np.float32), "pred": anom(field).astype(np.float32),
            "bil": anom(bil).astype(np.float32), "blk": anom(blk).astype(np.float32), "cls": dom,
            "max_block_error_c": info["max_block_error_c"], "n_train": info["n_train"]}


def _s10_day_demo_summary(results):
    results = [r for r in results if r is not None]
    if not results:
        return {"available": False, "reason": "no frame of 2010/2015/2020 with MODIS Terra day data",
                "years": [], "r2": None, "rmse": None, "bilinear_rmse": None}
    obs = np.concatenate([r["obs"] for r in results])
    pred = np.concatenate([r["pred"] for r in results])
    bil = np.concatenate([r["bil"] for r in results])
    blk = np.concatenate([r["blk"] for r in results])
    cls = np.concatenate([r["cls"] for r in results])
    m, b, u = _s10_metric(obs, pred), _s10_metric(obs, bil), _s10_metric(obs, blk)
    by_year = []
    for r in results:
        mm, bb = _s10_metric(r["obs"], r["pred"]), _s10_metric(r["obs"], r["bil"])
        by_year.append({"year": r["year"], "r2": mm["r2"], "rmse": mm["rmse"], "bilinear_r2": bb["r2"],
                        "bilinear_rmse": bb["rmse"], "n": mm["n"], "max_block_error_c": r["max_block_error_c"]})
    return {"available": True, "r2": m["r2"], "rmse": m["rmse"], "n": m["n"], "bilinear_r2": b["r2"],
            "bilinear_rmse": b["rmse"], "uniform_r2": u["r2"], "uniform_rmse": u["rmse"],
            "years": [r["year"] for r in results], "by_year": by_year, "by_lc": _s10_by_class(obs, pred, bil, cls),
            "comparison": "anomalies (each product minus its mean over the common fine pixels) vs the Landsat C2 L2 "
                          "fine composite (>= 2 clear scenes)",
            "note": "MODIS Terra (~10:30 local solar time) and Landsat (~10:30 IST) differ in overpass and algorithm; "
                    "anomalies remove the frame-wide offset"}


# %% [markdown]
# ## 10.5 Run (stage-cached)
# The cache key holds the version, the grid/profile, and fingerprints of every input (1 km frame fields, levels,
# AOA flags, fine Landsat/GHSL layers), so a changed upstream result can never reuse stale downscaled fields.

# %%
def _s10_fingerprint():
    h = _s10_hashlib.sha1()
    for m in _S10_MODES:
        for y in _S10_FRAMES:
            v = np.asarray(FRAME_FIELDS[m][y], np.float64)
            h.update(np.array([np.nansum(v), np.isfinite(v).sum(), LEVELS[m][y]["level"],
                               float(np.sum(FRAME_AOA_OUT[m][y]))], np.float64).tobytes())
            h.update(FRAME_TIERS[m][y].encode())
    for y in _S10_FRAMES:
        for key in _S10_PRED_NAMES[:5] + ["lst_day_f", "lst_day_nobs_f", "lst_day_modis"]:
            v = np.asarray(RAW_OBS[y][key], np.float64)
            h.update(np.array([np.nansum(v), np.isfinite(v).sum()], np.float64).tobytes())
    for key in ("elevation_f", "water_occ_f"):
        v = np.asarray(RAW_STATIC[key], np.float64)
        h.update(np.array([np.nansum(v), np.isfinite(v).sum()], np.float64).tobytes())
    h.update(np.asarray(DF["anom_night"].to_numpy(np.float64)[np.isfinite(DF["anom_night"].to_numpy())]
                        .sum()).tobytes())
    return h.hexdigest()[:16]


def _s10_compute():
    t0 = _s10_time.perf_counter()
    fields, infos = {m: {} for m in _S10_MODES}, {m: {} for m in _S10_MODES}
    if "day" in _S10_MODES:
        for y in _S10_FRAMES:
            fields["day"][y], infos["day"][y] = _s10_day_fine(y)
    if "night" in _S10_MODES:
        with timer("10_night_dms"):
            res = gpu_pool_map(_s10_night_job, _S10_FRAMES)
        for y, r in zip(_S10_FRAMES, res):
            fields["night"][y], infos["night"][y] = r["field"], r["info"]
        del res
        free_memory()
    scale_rows = []
    scale_frames = [y for y in _S10_FRAMES if "night" in _S10_MODES
                    and FRAME_TIERS["night"][y] in ("observed", "reconstructed")
                    and np.isfinite(DF["anom_night"].to_numpy()[_S10_FRAMES.index(y) * _S10_NC:
                                                                (_S10_FRAMES.index(y) + 1) * _S10_NC]).sum() > 100]
    with timer("10_scale_invariance"):
        for rows in gpu_pool_map(_s10_scale_job, scale_frames):
            scale_rows.extend(rows)
    scale, by_lc = _s10_scale_summary(scale_rows)
    del scale_rows
    demo_years = [y for y in _S10_DEMO_YEARS if y in _S10_FRAMES]
    with timer("10_day_demo"):
        demo = _s10_day_demo_summary(gpu_pool_map(_s10_day_demo_job, demo_years))
    free_memory()
    return {"fields": fields, "infos": infos, "scale": scale, "scale_by_lc": by_lc, "day_demo": demo,
            "seconds": round(_s10_time.perf_counter() - t0, 1)}


_s10_key = CFG.key("SEED", "FINE_FACTOR", version=_S10_VERSION, inputs=_s10_fingerprint(),
                   params=_S10_XGB_PARAMS, rounds=_S10_ROUNDS, het=_S10_HET_DROP, scale_factor=_S10_SCALE_FACTOR,
                   demo=_S10_DEMO_YEARS)
with timer("10_downscaling"):
    _S10_OUT = stage_cache("10_downscaling", _s10_key).get_or_compute(_s10_compute)

FINE_FIELDS = {m: {int(y): np.asarray(v, np.float32) for y, v in _S10_OUT["fields"][m].items()} for m in _S10_MODES}
FINE_FLAGS, _S10_TIER_CODES = {m: {} for m in _S10_MODES}, {m: {} for m in _S10_MODES}
for _m in _S10_MODES:
    for _y, _v in FINE_FIELDS[_m].items():
        FINE_FLAGS[_m][_y], _S10_TIER_CODES[_m][_y] = _s10_flags(_m, _y, _v)

# Block conservation (SPEC §4.8): every downscaled night 4 x 4 block must average back to its 1 km value.
_S10_CONSERVATION = {}
for _y, _v in FINE_FIELDS.get("night", {}).items():
    _c = _s10_cell_grid(FRAME_FIELDS["night"][_y], dtype=np.float64)
    _bm, _ = _s10_block_mean(_v, _S10_F, ROI_MASK_FINE)
    _ok = np.isfinite(_c) & ROI_MASK
    _err = float(np.nanmax(np.abs(_bm[_ok] - _c[_ok]))) if _ok.any() else 0.0
    _S10_CONSERVATION[_y] = _err
    if not _err < _S10_CONSERVE_TOL_C:
        raise AssertionError(f"10: night {_y}: block conservation violated (max |e_c| = {_err:.4f} °C)")
    if not np.array_equal(np.isfinite(_v), _s10_upsample(_ok, _S10_F)):
        raise AssertionError(f"10: night {_y}: fine NaN pattern differs from the 1 km field")
log("10: night block conservation max |e_c| per frame: "
    + ", ".join(f"{y}={e:.1e}" for y, e in _S10_CONSERVATION.items()))

DOWNSCALING_METRICS = {
    "night": {"scale_invariance": _S10_OUT["scale"], "by_lc": _S10_OUT["scale_by_lc"],
              "conservation": {"max_abs_block_error_c": max(_S10_CONSERVATION.values()) if _S10_CONSERVATION
                               else None, "tolerance_c": _S10_CONSERVE_TOL_C,
                               "by_frame": {str(y): e for y, e in _S10_CONSERVATION.items()}},
              "frames": {str(y): dict(i) for y, i in _S10_OUT["infos"].get("night", {}).items()},
              "method": ("DMS: XGBoost (depth 6, 600 rounds, eta 0.05) on 10 fine predictors aggregated to 1 km, "
                         "20 % most heterogeneous cells excluded; bilinear residual correction + 3 iterations of "
                         "block conservation (|e_c| < 0.01 °C)"),
              "predictors": list(_S10_PRED_NAMES)},
    "day_demo": _S10_OUT["day_demo"],
    "day": {"method": "Landsat C2 L2 ST fine composite (observed) + overpass correction to 10:45 IST; pixels with "
                      "< 2 clear scenes masked (not downscaled)",
            "frames": {str(y): i for y, i in _S10_OUT["infos"].get("day", {}).items()}},
    "fine_res_m": _S10_FINE_RES_M, "seconds": _S10_OUT["seconds"],
}
_s10_si = DOWNSCALING_METRICS["night"]["scale_invariance"]
if _s10_si.get("available"):
    log(f"10: scale invariance ({_s10_si['coarse_res_m'] / 1000:g} km -> {_s10_si['fine_res_m'] / 1000:g} km, "
        f"{_s10_si['n_fits']} fits, n={_s10_si['n']:,}): DMS R2 {_s10_si['r2']:.3f} RMSE {_s10_si['rmse']:.3f} °C "
        f"bias {_s10_si['bias']:+.3f} | bilinear R2 {_s10_si['bilinear_r2']:.3f} RMSE {_s10_si['bilinear_rmse']:.3f} "
        f"| regression only RMSE {_s10_si['model_only_rmse']:.3f}")
_s10_dd = DOWNSCALING_METRICS["day_demo"]
if _s10_dd.get("available"):
    log(f"10: day demonstration (MODIS Terra {_s10_dd['years']} -> {_S10_FINE_RES_M:g} m vs Landsat): DMS R2 "
        f"{_s10_dd['r2']:.3f} RMSE {_s10_dd['rmse']:.3f} °C | bilinear R2 {_s10_dd['bilinear_r2']:.3f} RMSE "
        f"{_s10_dd['bilinear_rmse']:.3f} | block-constant RMSE {_s10_dd['uniform_rmse']:.3f}")
else:
    log(f"10: day demonstration not available: {_s10_dd.get('reason')}")

# %% [markdown]
# ## 10.6 EPSG:4326 rasters (`RASTER_INDEX`, PNGs)
# The lon/lat raster covers the bounding box of the ROI (its UTM rectangle densified along the edges before
# transforming, because straight UTM edges are curved in lon/lat), snapped outward to multiples of the preview
# resolution so the full-resolution and preview rasters share identical bounds (preview = exactly half the size).
# The inverse map (output pixel → flat fine-pixel index, −1 outside the ROI) is computed **once** per resolution in
# row chunks and reused for every frame; then each PNG is a gather. An alignment self-test transforms random output
# pixel centres again and asserts that the selected fine pixel's centre lies within half a fine pixel (in metres) of
# the output pixel centre on both axes.

# %%
def _s10_lonlat_to_xy(lon, lat):
    if pyproj is not None:
        tr = pyproj.Transformer.from_crs("EPSG:4326", CFG.CRS, always_xy=True)
        return tr.transform(lon, lat)
    return _grid_lonlat_to_xy(lon, lat, CFG.CRS)


def _s10_xy_to_lonlat(x, y):
    if pyproj is not None:
        tr = pyproj.Transformer.from_crs(CFG.CRS, "EPSG:4326", always_xy=True)
        return tr.transform(x, y)
    return _grid_xy_to_lonlat(x, y, CFG.CRS)


def _s10_raster_bounds():
    """[W, S, E, N] of the ROI's fine-pixel bounding box in lon/lat, snapped outward to the preview resolution."""
    rows, cols = np.nonzero(ROI_MASK)
    res = float(GRID.res)
    xl, xr = GRID.x0 + cols.min() * res, GRID.x0 + (cols.max() + 1) * res
    yt, yb = GRID.y0 - rows.min() * res, GRID.y0 - (rows.max() + 1) * res
    t = np.linspace(0.0, 1.0, 200)
    ring_x = np.concatenate([xl + (xr - xl) * t, np.full_like(t, xr), xr - (xr - xl) * t, np.full_like(t, xl)])
    ring_y = np.concatenate([np.full_like(t, yt), yt - (yt - yb) * t, np.full_like(t, yb), yb + (yt - yb) * t])
    lon, lat = _s10_xy_to_lonlat(ring_x, ring_y)
    p = _S10_PREVIEW_RES_DEG
    w_i = _s10_math.floor(float(np.min(lon)) / p - 1e-9)
    e_i = _s10_math.ceil(float(np.max(lon)) / p + 1e-9)
    s_i = _s10_math.floor(float(np.min(lat)) / p - 1e-9)
    n_i = _s10_math.ceil(float(np.max(lat)) / p + 1e-9)
    return [w_i * p, s_i * p, e_i * p, n_i * p], (e_i - w_i, n_i - s_i)


def _s10_inverse_map(bounds, width, height):
    """(height, width) int32 flat fine-pixel index of every output pixel centre (nearest), -1 outside the ROI."""
    west, _, east, north = bounds
    res_lon = (east - west) / width
    res_lat = (north - bounds[1]) / height
    lon_c = west + (np.arange(width, dtype=np.float64) + 0.5) * res_lon
    out = np.full((height, width), -1, dtype=np.int32)
    roi_flat = ROI_MASK_FINE.ravel()
    fres = float(GRID_FINE.res)
    rows_per_chunk = max(1, _S10_MAP_CHUNK_PX // max(width, 1))
    for r0 in range(0, height, rows_per_chunk):
        r1 = min(height, r0 + rows_per_chunk)
        lat_c = north - (np.arange(r0, r1, dtype=np.float64) + 0.5) * res_lat
        lon_g, lat_g = np.meshgrid(lon_c, lat_c)
        x, y = _s10_lonlat_to_xy(lon_g.ravel(), lat_g.ravel())
        col = np.floor((np.asarray(x) - GRID_FINE.x0) / fres).astype(np.int64)
        row = np.floor((GRID_FINE.y0 - np.asarray(y)) / fres).astype(np.int64)
        inside = (col >= 0) & (col < _S10_WF) & (row >= 0) & (row < _S10_HF)
        flat = np.where(inside, row * _S10_WF + col, 0)
        keep = inside & roi_flat[flat]
        out[r0:r1] = np.where(keep, flat, -1).reshape(r1 - r0, width).astype(np.int32)
        del lon_g, lat_g, x, y, col, row, inside, flat, keep
    return out


def _s10_alignment_check(mapping, bounds, n=4000, seed=0):
    """Max |dx|, |dy| (m) between output pixel centres and their fine pixel centres (must be <= fres/2)."""
    height, width = mapping.shape
    valid = np.flatnonzero(mapping.ravel() >= 0)
    if valid.size == 0:
        raise AssertionError("10: the raster inverse map selects no ROI pixel")
    pick = np.random.default_rng(seed).choice(valid, size=min(n, valid.size), replace=False)
    i, j = pick // width, pick % width
    res_lon = (bounds[2] - bounds[0]) / width
    res_lat = (bounds[3] - bounds[1]) / height
    lon = bounds[0] + (j + 0.5) * res_lon
    lat = bounds[3] - (i + 0.5) * res_lat
    x, y = _s10_lonlat_to_xy(lon, lat)
    flat = mapping.ravel()[pick].astype(np.int64)
    fres = float(GRID_FINE.res)
    xc = GRID_FINE.x0 + (flat % _S10_WF + 0.5) * fres
    yc = GRID_FINE.y0 - (flat // _S10_WF + 0.5) * fres
    dx, dy = float(np.max(np.abs(np.asarray(x) - xc))), float(np.max(np.abs(np.asarray(y) - yc)))
    if not (dx <= fres / 2 + 1e-6 and dy <= fres / 2 + 1e-6):
        raise AssertionError(f"10: raster alignment off: max |dx| {dx:.2f} m, |dy| {dy:.2f} m > {fres / 2} m")
    return {"n": int(pick.size), "max_dx_m": dx, "max_dy_m": dy, "limit_m": fres / 2}


def _s10_domain(mode):
    """Fixed raster domain of a mode: p0.5-p99.5 of all observed fine fields, padded by 3 °C, rounded outward."""
    vals = np.concatenate([v[np.isfinite(v)] for v in FINE_FIELDS[mode].values()])
    if vals.size == 0:
        raise RuntimeError(f"10: {mode}: no finite fine values for the raster domain")
    lo, hi = np.percentile(vals.astype(np.float64), _S10_DOMAIN_Q)
    return [float(_s10_math.floor(lo - _S10_DOMAIN_PAD_C)), float(_s10_math.ceil(hi + _S10_DOMAIN_PAD_C))]


def _s10_encode(values, lo, hi):
    """R channel: 0 nodata, else 1 + round((v - lo) / (hi - lo) * 254) clipped to 1..255."""
    v = np.asarray(values, np.float64)
    ok = np.isfinite(v)
    code = np.zeros(v.shape, dtype=np.uint8)
    code[ok] = np.clip(1.0 + np.rint((v[ok] - lo) / (hi - lo) * 254.0), 1, 255).astype(np.uint8)
    return code


def _s10_decode(code, lo, hi):
    c = np.asarray(code, np.float64)
    return np.where(c > 0, lo + (c - 1.0) * (hi - lo) / 254.0, np.nan)


def _s10_write_png(path, field, flags, mapping, lo, hi):
    """Gather the fine field through the inverse map and write an 8-bit RGB PNG (Pillow); returns pixel count."""
    from PIL import Image

    flat = mapping.ravel()
    ok = flat >= 0
    vals = np.full(flat.size, np.nan, dtype=np.float32)
    vals[ok] = field.ravel()[flat[ok]]
    rgb = np.zeros((flat.size, 3), dtype=np.uint8)
    rgb[:, 0] = _s10_encode(vals, lo, hi)
    g = np.zeros(flat.size, dtype=np.uint8)
    g[ok] = flags.ravel()[flat[ok]]
    rgb[:, 1] = np.where(rgb[:, 0] > 0, g, 0)
    img = Image.fromarray(rgb.reshape(mapping.shape + (3,)), mode="RGB")
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    img.save(tmp, format="PNG", optimize=True)
    tmp.replace(path)
    n = int((rgb[:, 0] > 0).sum())
    del vals, rgb, g, img
    return n


def _s10_build_rasters():
    try:
        import PIL  # noqa: F401  (Pillow is the PNG writer)
    except ImportError:
        log("10: Pillow is not installed - rasters are NOT written (pip install pillow)", "ERROR")
        return {"crs": "EPSG:4326", "available": False, "reason": "Pillow missing", "frames": {}}, None
    bounds, (pw, ph) = _s10_raster_bounds()
    width, height = 2 * pw, 2 * ph
    with timer("10_raster_inverse_map"):
        full_map = _s10_inverse_map(bounds, width, height)
        prev_map = _s10_inverse_map(bounds, pw, ph)
    align = {"full": _s10_alignment_check(full_map, bounds, seed=int(CFG.SEED)),
             "preview": _s10_alignment_check(prev_map, bounds, seed=int(CFG.SEED) + 1)}
    log(f"10: raster grid {width}x{height} @ {_S10_RASTER_RES_DEG:g} deg (+ {pw}x{ph} preview), bounds "
        f"{np.round(bounds, 4).tolist()}; alignment max |dx| {align['full']['max_dx_m']:.1f} m, |dy| "
        f"{align['full']['max_dy_m']:.1f} m (limit {align['full']['limit_m']:.0f} m)")
    domains = {m: _s10_domain(m) for m in _S10_MODES}
    frames = {}
    with timer("10_raster_png"):
        for m in _S10_MODES:
            lo, hi = domains[m]
            for y in sorted(FINE_FIELDS[m]):
                key = f"{m}_{y}"
                rel, rel_prev = f"raster/{key}.png", f"raster/{key}_500m.png"
                n_full = _s10_write_png(Path(CFG.WEB_DIR) / rel, FINE_FIELDS[m][y], FINE_FLAGS[m][y], full_map,
                                        lo, hi)
                n_prev = _s10_write_png(Path(CFG.WEB_DIR) / rel_prev, FINE_FIELDS[m][y], FINE_FLAGS[m][y],
                                        prev_map, lo, hi)
                tier = FRAME_TIERS[m][y]
                frames[key] = {"file": rel, "preview": rel_prev, "lo": lo, "hi": hi, "tier": tier,
                               "downscaled": bool(m == "night"), "mode": m, "year": int(y),
                               "tier_code": int(_S10_TIER_CODES[m][y]), "valid_pixels": n_full,
                               "valid_pixels_preview": n_prev}
    index = {"crs": "EPSG:4326", "bounds": [round(float(b), 6) for b in bounds], "width": int(width),
             "height": int(height), "res_deg": _S10_RASTER_RES_DEG,
             "preview": {"width": int(pw), "height": int(ph), "res_deg": _S10_PREVIEW_RES_DEG},
             "domains": domains, "fine_res_m": _S10_FINE_RES_M, "source_crs": CFG.CRS,
             "encoding": {"R": "0 = nodata, else value = lo + (R - 1) * (hi - lo) / 254 (°C)",
                          "G": "flags: bit 0 outside AOA; bits 1-2 tier code (0 observed, 1 observed-sparse or "
                               "reconstructed, 2 modelled, 3 downscaled)", "B": "0"},
             "resampling": "inverse mapping to the nearest fine pixel (pyproj)", "alignment": align,
             "frames": frames}
    return index, (full_map, prev_map)


RASTER_INDEX, _S10_MAPS = _s10_build_rasters()
if RASTER_INDEX.get("frames"):
    save_json(RASTER_INDEX, Path(CFG.WEB_DIR) / "raster_index.json")
    log(f"10: wrote {2 * len(RASTER_INDEX['frames'])} PNGs to {_S10_RASTER_DIR} and raster_index.json; domains "
        + ", ".join(f"{m} {d}" for m, d in RASTER_INDEX["domains"].items()))
    DOWNSCALING_METRICS["rasters"] = {"width": RASTER_INDEX["width"], "height": RASTER_INDEX["height"],
                                      "res_deg": RASTER_INDEX["res_deg"], "domains": RASTER_INDEX["domains"],
                                      "alignment": RASTER_INDEX["alignment"]}

# %% [markdown]
# ## 10.7 Figures
# (1) Night frame at 1 km vs downscaled vs bilinear (zoom on the urban core); (2) scale-invariance error by
# dominant land cover, DMS vs bilinear; (3) the day demonstration by land cover.

# %%
def _s10_save_fig(fig, name):
    fig.savefig(_S10_FIG_DIR / name, dpi=140, bbox_inches="tight")
    plt.show()
    plt.close(fig)


def _s10_fig_night():
    if "night" not in FINE_FIELDS:
        return
    obs_frames = [y for y in _S10_FRAMES if FRAME_TIERS["night"][y] == "observed"] or _S10_FRAMES
    y = obs_frames[-1]
    fine = FINE_FIELDS["night"][y]
    coarse = _s10_cell_grid(FRAME_FIELDS["night"][y], dtype=np.float64)
    bil = np.where(np.isfinite(fine), _s10_bilinear_up(_s10_fill_nearest(coarse), _S10_F), np.nan)
    blk = _s10_upsample(coarse, _S10_F)
    built = np.asarray(RAW_OBS[y]["built_f"], np.float64)
    # zoom window centred on the most built-up 1 km cell
    r, c = np.unravel_index(np.nanargmax(np.where(ROI_MASK, _s10_block_mean(built, _S10_F)[0], -1)),
                            (_S10_H, _S10_W))
    half = max(8, min(_S10_H, _S10_W) // 6) * _S10_F
    r0, c0 = max(0, r * _S10_F - half), max(0, c * _S10_F - half)
    win = (slice(r0, r0 + 2 * half), slice(c0, c0 + 2 * half))
    vals = fine[win][np.isfinite(fine[win])]
    if vals.size == 0:
        return
    vmin, vmax = np.percentile(vals, [2, 98])
    fig, axes = plt.subplots(1, 3, figsize=(15, 5))
    for ax, arr, title in zip(axes, (blk, bil, fine), (f"1 km observed ({y})", "bilinear 1 km -> fine",
                                                         f"DMS downscaled ({_S10_FINE_RES_M:g} m)")):
        im = ax.imshow(arr[win], cmap="inferno", vmin=vmin, vmax=vmax)
        ax.set_title(title)
        ax.set_xticks([])
        ax.set_yticks([])
    fig.colorbar(im, ax=axes, shrink=0.8, label="night LST (°C)")
    fig.suptitle("Night LST downscaling around the most built-up cell (block-conserving)")
    _s10_save_fig(fig, "10_night_downscaling.png")


def _s10_fig_validation():
    si_lc = DOWNSCALING_METRICS["night"]["by_lc"]
    dd = DOWNSCALING_METRICS["day_demo"]
    panels = [(si_lc, "Night scale invariance (coarse -> 1 km)")]
    if dd.get("available"):
        panels.append((dd["by_lc"], "Day demonstration (MODIS -> fine vs Landsat)"))
    panels = [(rows, t) for rows, t in panels if rows]
    if not panels:
        return
    fig, axes = plt.subplots(1, len(panels), figsize=(7 * len(panels), 4.5), squeeze=False)
    for ax, (rows, title) in zip(axes[0], panels):
        labels = [r["label"] for r in rows]
        x = np.arange(len(rows))
        ax.bar(x - 0.2, [r["rmse"] or 0 for r in rows], 0.4, label="DMS", color="#f97316")
        ax.bar(x + 0.2, [r["bilinear_rmse"] or 0 for r in rows], 0.4, label="bilinear", color="#64748b")
        ax.set_xticks(x)
        ax.set_xticklabels(labels, rotation=30, ha="right")
        ax.set_ylabel("RMSE (°C)")
        ax.set_title(title)
        ax.legend()
    _s10_save_fig(fig, "10_downscaling_validation.png")


for _s10_fn in (_s10_fig_night, _s10_fig_validation):
    try:
        _s10_fn()
    except Exception as _s10_exc:  # noqa: BLE001 - a broken figure must never lose the computed results
        log(f"10: figure {_s10_fn.__name__} failed: {type(_s10_exc).__name__}: {_s10_exc}", "WARNING")
        plt.close("all")

# %% [markdown]
# ## 10.8 Contract check (SPEC §3.7)

# %%
def _s10_contract_check():
    for m in _S10_MODES:
        assert sorted(FINE_FIELDS[m]) == _S10_FRAMES, (m, sorted(FINE_FIELDS[m]))
        for y in _S10_FRAMES:
            f, g = FINE_FIELDS[m][y], FINE_FLAGS[m][y]
            assert f.shape == (_S10_HF, _S10_WF) and f.dtype == np.float32, (m, y, f.shape, f.dtype)
            assert g.shape == f.shape and g.dtype == np.uint8, (m, y, g.shape, g.dtype)
            assert not np.isfinite(f[~ROI_MASK_FINE]).any(), f"{m} {y}: values outside the ROI"
            assert np.all(g[~np.isfinite(f)] == 0), f"{m} {y}: flags on nodata pixels"
            assert np.all((g >> 1) <= 3)
            if m == "night" and FRAME_TIERS[m][y] == "modelled":
                assert np.isfinite(f[ROI_MASK_FINE]).all(), f"night {y}: modelled field must be complete"
    if RASTER_INDEX.get("frames"):
        for fr in RASTER_INDEX["frames"].values():
            for rel in (fr["file"], fr["preview"]):
                assert (Path(CFG.WEB_DIR) / rel).is_file(), rel
            assert fr["lo"] < fr["hi"] and [fr["lo"], fr["hi"]] == RASTER_INDEX["domains"][fr["mode"]]
        assert RASTER_INDEX["width"] == 2 * RASTER_INDEX["preview"]["width"]
        assert RASTER_INDEX["height"] == 2 * RASTER_INDEX["preview"]["height"]
        # quantisation round trip
        lo, hi = RASTER_INDEX["domains"][_S10_MODES[0]]
        probe = np.linspace(lo, hi, 1001)
        err = np.abs(_s10_decode(_s10_encode(probe, lo, hi), lo, hi) - probe)
        assert float(err.max()) <= (hi - lo) / 254.0 / 2.0 + 1e-9, float(err.max())
    for y, e in DOWNSCALING_METRICS["night"]["conservation"]["by_frame"].items():
        assert e < _S10_CONSERVE_TOL_C, (y, e)
    log("10: contract check OK (FINE_FIELDS, FINE_FLAGS, DOWNSCALING_METRICS, RASTER_INDEX)")


_s10_contract_check()
del _S10_MAPS
free_memory()
log("Section 10 complete: FINE_FIELDS, FINE_FLAGS, DOWNSCALING_METRICS, RASTER_INDEX ready")
