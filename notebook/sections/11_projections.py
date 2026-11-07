# %% [markdown]
# # 11. Projections 2030–2050: land change, derived predictors, CMIP6 deltas and Monte-Carlo uncertainty
#
# **Scenario projections, not forecasts.** Each SSP is a coherent "what if" for land and climate; scenarios are
# never mixed. The chain (SPEC §4.9–§4.10, `methods_v2.md` §4):
#
# 1. **Land change** — a fractional cellular automaton (CA) on the 1 km built-up fraction $u$ (GHSL). District
#    demand follows the Chen et al. (2020) SSP urban-area ratios: $U_{d,s}(y) = U_d(2025)\,g_{d,s}(y)/g_{d,s}(2025)$.
#    Each 5-year step allocates the demand increment as $\Delta u_i = \min(cap_i,\; k_d\,S_i\,N_i\,\varepsilon_i)$:
#    $S_i$ = transition suitability (XGBoost classifier of $\Delta u_{2005→2015} > 0.05$ on proximity, terrain,
#    population and land-cover fractions), $N_i$ = 3 × 3 neighbourhood mean of $u$ (urban growth is contagious),
#    $\varepsilon_i \sim \mathrm{LogNormal}(0, 0.3)$ = allocation stochasticity, $cap_i = \max(0, 1 − u_i − forest_i −
#    water_i)$ (**forest and water are protected**), and $k_d$ found by bisection so that the district total meets
#    the demand exactly. New built-up land comes from cropland, barren and other vegetation in proportion to their
#    current shares. `N_LAND_REAL` seeded realisations per scenario.
#    **Validation:** a 2015 → 2025 hindcast with the *observed* district demand, scored with Pontius' figure of
#    merit on cells with $\Delta u > 0.05$ (hits / (hits + misses + false alarms + wrong hits); a single change
#    category has no wrong hits), quantity and allocation disagreement (Pontius & Millones 2011) and RMSE($\Delta u$),
#    against the **null model** $\Delta u \propto u_{2015}$ (proportional growth) meeting the same demand.
# 2. **Derived predictors** — spectral indices, built volume and landscape metrics cannot be observed in the
#    future. Delta mapping keeps every cell's observed 2025 idiosyncrasy and adds only the land-driven change:
#    $X_y = X_{2025} + h_X(LC_y) − h_X(LC_{2025})$, $h_X$ = XGBoost (depth 4, 300 rounds) of $X$ on the five fractions,
#    their 3/15-cell focal means and terrain, fitted on the 2015–2025 frames. `ndvi_drop = ndvi_spring − ndvi` is
#    recomputed from the mapped pair (identical to delta-mapping it with $h_{drop} = h_{spring} − h_{ndvi}$).
#    Population: $pop_y = pop_{2025}\,F_s(y)\,(u_y + 0.02)/(u_{2025} + 0.02)$, renormalised to the NCR total
#    $\times F_s(y)$ (IIASA SSP urban population). Focal features and distances are recomputed with
#    `FOCAL_RECOMPUTE`. ERA5 features = mean of the 2015/2020/2025 frames (climate change enters **only** through
#    the delta, never twice); the 2025 reference prediction uses the same ERA5 climatology so that
#    $\hat A_y − \hat A_{2025}$ isolates the land effect.
# 3. **Climate delta** — $\Delta T_{s,g}(y)$ = GCM $g$'s Apr–Jun 20-year-window mean (tasmax for day, tasmin for
#    night) minus its 2016–2035 window (the 2025 baseline). SSP1-2.6 is not in GEE's NEX-GDDP-CMIP6, so it is
#    **pattern-scaled** from SSP2-4.5 per GCM with the AR6 assessed GSAT increments:
#    $\Delta T_{126,g} = \Delta T_{245,g} · \Delta GSAT_{126}/\Delta GSAT_{245}$. The spatial pattern (ensemble-median
#    2050 delta / its ROI mean) distributes it over the cells.
# 4. **Baseline (weather-normalised)** — $L_{base,m} = L_m(2025) − β_m\,a$ removes the 2025 window's weather
#    anomaly from the observed level. $a = \bar T_{2024–26} − T_{trend}(2025)$, where $T_{trend}$ is the OLS line of the
#    ERA5-Land NCR annual series of the mode's temperature variable (Tmax day, Tmin night; section 09) over 2001–2025,
#    evaluated at the mean year of the window. Using the trend line rather than a flat 2016–2025 mean keeps the
#    warming that has already happened inside the baseline (a flat mean would call part of the trend a "weather
#    anomaly"). With fewer than 10 annual values the flat 2016–2025-mean rule is used (WARNING).
# 5. **Monte Carlo** (`N_MC` draws per scenario × mode): GCM $g$ (uniform), $β$ from its block-bootstrap draws
#    (section 09), land realisation $r$ (uniform), per-cell model error $e_i$ from the **projection-setting**
#    residuals of the cell's AOA-DI decile (section 07: $y − (\hat y_{LOEO} + \bar r)$, i.e. a known place at an
#    unseen time, the setting of a projection; the block20 OOF residuals are the fallback):
#    $$LST_k(i, y) = L_{base,m} + β_k\,\Delta T_{s,g}(y)\,P_m(i)
#      + [\hat A_{m,s,r}(y, i) − \overline{\hat A_m(2025)}_{FIXED}] + \bar r_m(i) + e_i .$$
#    Model errors are spatially correlated, so independent per-cell draws would average away in a district mean. They
#    are drawn through a **block20 Gaussian copula**: $u_{ki} = Φ(\sqrt{ρ}\,z_{kb(i)} + \sqrt{1−ρ}\,z_{ki})$ with
#    one $z_{kb} \sim N(0, 1)$ per draw and 20 km block (shared by all scenarios, modes and cells) and
#    $ρ$ = `AOA[m]['resid_rho_block20']` (section 07; ρ = 0 reproduces independent draws exactly).
#    The anomaly prediction is recentred **relative to the 2025 prediction mean**, so the land-driven shift of the
#    domain mean is kept. Draws use common random numbers across scenarios (the same GCM rank, β, realisation index
#    and error quantiles), so scenario differences are not blurred by sampling noise.
#
# **Outputs** (SPEC §3.8): per-cell P05/P25/P50/P75/P95, scope series quantiles from **per-draw scope means** (a
# scope mean's uncertainty is not the mean of per-cell quantiles), the decomposition {climate, land, total,
# baseline_c} with total = P50 − baseline_c relative to the scope's own weather-normalised 2025 baseline
# baseline_c = L_base + scope mean of ($\hat A_{2025} − \overline{\hat A_{2025}}_{FIXED} + \bar r$), so that
# total ≈ climate + land + mean model error for every scope (checked in 11.11), the
# uncertainty budget (main effects of GCM, sensitivity β, land realisation and model error — computed analytically
# from the additive model and normalised to 1), threshold years (+1/+2/+3 °C above the scope's weather-normalised
# baseline), AOA flags (DI of the median land realisation's features) with VSUP tiers from (P95 − P05)/2
# (< 0.5, < 1, < 2, ≥ 2 °C), and projected zones (nearest centroid of the median realisation's grouped SHAP).
#
# Omitted feedbacks (stated on every projection panel): irrigation change, aerosol trends, heat-wave frequency,
# monsoon-onset timing; the LST model is a pre-monsoon statistical model, not a land-surface model.
#
# Memory: everything is processed scenario by scenario; the Monte-Carlo field is never held for all cells at
# once (cell chunks × draws), and each scenario's land products are stage-cached. The **pilot** profile (no
# projection frames) skips this section cleanly with empty outputs.

# %%
import hashlib as _s11_hashlib
import time as _s11_time
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import xgboost as xgb
from scipy import ndimage as _s11_ndi
from scipy import special as _s11_special

# 11-v2.1: decomposition total vs the scope's own baseline (+ baseline_c), projection-setting residual samples with a
# block20 Gaussian copula, L_base anomaly against the ERA5 trend, land-model plausibility checks (D13-D15, D18).
_S11_VERSION = "11-v2.1"
_S11_FRAMES_OBS = sorted(int(y) for y in np.unique(DF["year"].to_numpy()))
_S11_NOW = int(CFG.NOW) if int(CFG.NOW) in _S11_FRAMES_OBS else _S11_FRAMES_OBS[-1]
_S11_PROJ = [int(y) for y in CFG.FRAMES_PROJ]
_S11_SCEN = [str(s) for s in CFG.SCENARIOS]
_S11_MODES = [m for m in CFG.MODES if m in FINAL_MODELS and m in LEVELS and m in AOA]
_S11_NC = int(N_CELLS)
_S11_H, _S11_W = (int(v) for v in ROI_MASK.shape)
_S11_CELL_KM2 = float(GRID.cell_area_km2)
_S11_QK = ["p05", "p25", "p50", "p75", "p95"]
_S11_Q = np.array([0.05, 0.25, 0.50, 0.75, 0.95])
_S11_DU_THR = 0.05                    # Pontius change threshold and suitability label (SPEC §4.9)
_S11_EPS_SIGMA = 0.3                  # allocation noise LogNormal(0, 0.3)
_S11_POP_EPS = 0.02
_S11_FRACS = ["frac_built", "frac_forest", "frac_water", "frac_cropland", "frac_barren"]
_S11_SUIT_FEATURES = ["frac_built", "frac_built_m3", "frac_built_m15", "dist_urban", "dist_builtup", "slope",
                      "elevation", "log_pop", "frac_forest", "frac_water", "frac_cropland", "frac_barren"]
_S11_SUIT_PARAMS = {"objective": "binary:logistic", "eval_metric": "auc", "tree_method": "hist", "max_depth": 5,
                    "learning_rate": 0.05, "subsample": 0.8, "colsample_bytree": 0.8, "min_child_weight": 5,
                    "reg_lambda": 1.0, "max_bin": 256}
_S11_SUIT_ROUNDS = 400
_S11_H_TARGETS = ["ndvi", "ndbi", "mndwi", "albedo", "ndvi_spring", "built_v", "lm_pd", "lm_ed", "lm_contag"]
_S11_H_PARAMS = {"objective": "reg:squarederror", "tree_method": "hist", "max_depth": 4, "learning_rate": 0.1,
                 "subsample": 0.8, "colsample_bytree": 0.9, "min_child_weight": 10, "reg_lambda": 1.0,
                 "max_bin": 256}
_S11_H_ROUNDS = 300
_S11_TERRAIN = ["elevation", "slope", "aspect_sin", "aspect_cos", "elev_tpi7", "elev_tpi21", "elev_std7"]
_S11_ERA5 = ["era5_t2m", "era5_vpd", "era5_swvl1", "era5_evap", "era5_ssr", "era5_wind", "era5_precip_jfm"]
_S11_BOUNDS = {"ndvi": (-1.0, 1.0), "ndbi": (-1.0, 1.0), "mndwi": (-1.0, 1.0), "albedo": (0.0, 1.0),
               "ndvi_spring": (-1.0, 1.0), "built_v": (0.0, np.inf), "lm_pd": (0.0, np.inf),
               "lm_ed": (0.0, np.inf), "lm_contag": (0.0, 100.0)}
_S11_TEMP_VAR = {"day": "tasmax", "night": "tasmin"}
_S11_VSUP_EDGES = np.array([0.5, 1.0, 2.0])
_S11_TREND_YEARS = (2001, 2025)       # ERA5 OLS trend of the weather-normalised baseline (D15)
_S11_TREND_MIN_YEARS = 10
_S11_RHO_MAX = 0.95                   # block20 copula correlation is clipped to [0, 0.95] (D13)
_S11_U_CLIP = 1e-6
_S11_DECOMP_TOL_C = 0.3               # |total - climate - land - model_error_mean| contract tolerance (D14)
_S11_CELL_CHUNK = 8192
_S11_SHAP_BATCH = 8192
_S11_ZONE_NODATA = 255
_S11_NOTE = "scenario projection, not a forecast"
_S11_OMITTED = ["irrigation change", "aerosol trends", "heat-wave frequency", "monsoon-onset timing"]
_S11_FIG_DIR = Path(CFG.FIG_DIR)
_S11_ACTIVE = bool(_S11_PROJ) and int(CFG.N_MC) > 0 and int(CFG.N_LAND_REAL) > 0 and bool(_S11_MODES)

# Outputs (SPEC §3.8) - defined up front so that a skipped section still publishes the complete (empty) interface.
LAND_MODEL_METRICS, CMIP6_DELTAS, PROJ_DRIVER_SUMMARY = {}, {}, {}
PROJ_QUANTILES, PROJ_FLAGS, PROJ_ZONES, PROJ_SERIES = {}, {}, {}, {}
PROJ_DECOMPOSITION, PROJ_UNCERTAINTY, PROJ_THRESHOLD_YEARS, PROJ_META = {}, {}, {}, {}
if not _S11_ACTIVE:
    _s11_reason = ("no projection frames (pilot profile)" if not _S11_PROJ else
                   "N_MC / N_LAND_REAL < 1" if (int(CFG.N_MC) < 1 or int(CFG.N_LAND_REAL) < 1) else
                   "no final model")
    LAND_MODEL_METRICS = {"available": False, "reason": _s11_reason}
    CMIP6_DELTAS = {"available": False, "reason": _s11_reason, "scenarios": {}}
    log(f"11: projections skipped - {_s11_reason}; all §3.8 outputs are empty", "WARNING")
else:
    log(f"11: projections {_S11_PROJ} x {_S11_SCEN} for modes {_S11_MODES}; baseline frame {_S11_NOW}; "
        f"{CFG.N_LAND_REAL} land realisations, {CFG.N_MC} Monte-Carlo draws per scenario and mode")

# %% [markdown]
# ## 11.1 Grid helpers, land state and the population rule
# A **land state** is a dict of canonical-cell vectors (float64): `u` (built-up), `forest`, `water`, `crop`,
# `barren` (GLC fractions rescaled to the non-built share, section 06) and `pop` (persons km⁻²). Other vegetation is
# the implicit remainder. Cells whose fractions are missing are frozen (`lc_ok = False`); `pop_ok` marks cells with
# a population value (missing ones keep a missing `log_pop`, exactly as in section 06).

# %%
def _s11_grid(values, fill=np.nan, dtype=np.float32):
    out = np.full((_S11_H, _S11_W), fill, dtype=dtype)
    out[CELL_ROWS, CELL_COLS] = np.asarray(values).astype(dtype, copy=False)
    return out


def _s11_cells(grid):
    return np.asarray(grid)[CELL_ROWS, CELL_COLS]


def _s11_box_mean(x_cells, size):
    """NaN-aware box mean of a canonical-cell vector on the 1 km grid over ROI cells (same rule as section 06)."""
    g = _s11_grid(x_cells, dtype=np.float64)
    m = ROI_MASK & np.isfinite(g)
    num = _s11_ndi.uniform_filter(np.where(m, g, 0.0), size=int(size), mode="constant", cval=0.0)
    den = _s11_ndi.uniform_filter(m.astype(np.float64), size=int(size), mode="constant", cval=0.0)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = num / den
    out[den < 0.5 / (size * size)] = np.nan
    return _s11_cells(out)


_S11_DISTRICT = np.asarray(DISTRICT_IDX)[CELL_ROWS, CELL_COLS].astype(np.int64)
_S11_DIST_IDS = sorted(int(d) for d in np.unique(_S11_DISTRICT) if d >= 0)
_S11_DIST_CELLS = {d: np.flatnonzero(_S11_DISTRICT == d) for d in _S11_DIST_IDS}
_S11_DIST_NAME = {int(d["id"]): d["name"] for d in DISTRICTS}
_S11_FIXED = {m: np.asarray(FIXED_MASK[m], bool)[CELL_ROWS, CELL_COLS] for m in CFG.MODES if m in FIXED_MASK}
_S11_FOLD20 = DF["fold_block20"].to_numpy(np.int64)[:_S11_NC]


def _s11_state(year):
    """Observed land state of a frame (canonical cells)."""
    g = FEATURE_GRIDS[int(year)]
    st = {}
    for key, feat in (("u", "frac_built"), ("forest", "frac_forest"), ("water", "frac_water"),
                      ("crop", "frac_cropland"), ("barren", "frac_barren")):
        st[key] = _s11_cells(g[feat]).astype(np.float64)
    ok = np.ones(_S11_NC, dtype=bool)
    for key in ("u", "forest", "water", "crop", "barren"):
        ok &= np.isfinite(st[key])
        st[key] = np.clip(np.nan_to_num(st[key], nan=0.0), 0.0, 1.0)
    st["lc_ok"] = ok
    pop = np.asarray(RAW_OBS[int(year)]["pop"], np.float64)[CELL_ROWS, CELL_COLS]
    st["pop_ok"] = np.isfinite(pop)
    st["pop"] = np.clip(np.nan_to_num(pop, nan=0.0), 0.0, None)
    return st


def _s11_copy_state(st):
    return {k: (v.copy() if isinstance(v, np.ndarray) else v) for k, v in st.items()}


def _s11_other(st):
    return np.clip(1.0 - st["u"] - st["forest"] - st["water"] - st["crop"] - st["barren"], 0.0, None)


def _s11_pop_rule(u_new, pop_ref, u_ref, factor):
    """pop_y = pop_ref * F * (u_y + 0.02) / (u_ref + 0.02), renormalised to the reference total x F (SPEC §4.9)."""
    raw = pop_ref * factor * (u_new + _S11_POP_EPS) / (u_ref + _S11_POP_EPS)
    total_target = float(pop_ref.sum()) * factor
    s = float(raw.sum())
    return raw * (total_target / s) if s > 0 else raw


def _s11_district_totals(u):
    """Built-up totals per district (in cell units: sum of fractions)."""
    return {d: float(u[idx].sum()) for d, idx in _S11_DIST_CELLS.items()}


# %% [markdown]
# ## 11.2 Transition suitability (XGBoost classifier)
# Label: $\Delta u > 0.05$ between the calibration frames (2005 → 2015), features at the start frame, rows = ROI
# cells that can still convert (cap > 0). Spatial skill is reported as the block20-fold out-of-fold AUC; the
# **hindcast AUC** applies the model to the 2015 state and scores the 2015 → 2025 transitions it never saw.

# %%
def _s11_pick_pair(want0, want1, latest_end):
    """Calibration frame pair: (want0, want1) if observed, else the best 10-year pair ending <= latest_end."""
    frames = _S11_FRAMES_OBS
    if want0 in frames and want1 in frames and want1 <= latest_end:
        return want0, want1, True
    pairs = [(a, b) for a in frames for b in frames if a < b <= latest_end]
    if pairs:
        a, b = min(pairs, key=lambda p: (abs((p[1] - p[0]) - 10), -p[1]))
        return a, b, True
    pairs = [(a, b) for a in frames for b in frames if a < b]
    if not pairs:
        return None, None, False
    a, b = min(pairs, key=lambda p: (abs((p[1] - p[0]) - 10), -p[1]))
    return a, b, False


def _s11_suit_matrix(st, ref_year):
    """(N_CELLS, 12) float32 suitability features of a land state (focal/distances via FOCAL_RECOMPUTE)."""
    base = FEATURE_GRIDS[int(ref_year)]
    grids = {b: base[b] for b in FOCAL_SPEC["bases"]}
    grids["frac_built"] = _s11_grid(st["u"])
    grids["frac_forest"] = _s11_grid(st["forest"])
    grids["frac_water"] = _s11_grid(st["water"])
    grids["frac_barren"] = _s11_grid(st["barren"])
    full = FOCAL_RECOMPUTE(grids, recompute_distances=True)
    cols = {"frac_built": st["u"], "frac_built_m3": _s11_cells(full["frac_built_m3"]),
            "frac_built_m15": _s11_cells(full["frac_built_m15"]), "dist_urban": _s11_cells(full["dist_urban"]),
            "dist_builtup": _s11_cells(full["dist_builtup"]), "slope": _s11_cells(base["slope"]),
            "elevation": _s11_cells(base["elevation"]), "log_pop": np.log1p(st["pop"]),
            "frac_forest": st["forest"], "frac_water": st["water"], "frac_cropland": st["crop"],
            "frac_barren": st["barren"]}
    return np.column_stack([np.asarray(cols[f], np.float32) for f in _S11_SUIT_FEATURES]).astype(np.float32)


def _s11_auc(y, p):
    from sklearn.metrics import roc_auc_score

    y = np.asarray(y)
    if y.size == 0 or y.min() == y.max():
        return None
    return float(roc_auc_score(y, p))


def _s11_xgb_train(params, X, y, rounds, seed, w=None):
    """XGBoost on GPU 0 when available (CPU retry on GPU OOM); the returned booster predicts on the CPU."""
    device = xgb_device_for(0)
    for dev in dict.fromkeys([device, "cpu"]):
        try:
            dtrain = xgb.DMatrix(X, label=y, weight=w, missing=np.nan)
            booster = xgb.train(dict(params, device=dev, seed=int(seed)), dtrain, num_boost_round=int(rounds),
                                verbose_eval=False)
            del dtrain
            booster.set_param({"device": "cpu"})
            return booster
        except Exception as exc:  # noqa: BLE001
            if dev == "cpu" or not is_gpu_oom_error(exc):
                raise
            log(f"11: GPU OOM training on {dev}; retrying on the CPU", "WARNING")
            free_memory()
    raise RuntimeError("unreachable")


def _s11_fit_suitability(y0, y1, hind0, hind1):
    st0, st1 = _s11_state(y0), _s11_state(y1)
    X = _s11_suit_matrix(st0, y0)
    du = st1["u"] - st0["u"]
    cap0 = np.clip(1.0 - st0["u"] - st0["forest"] - st0["water"], 0.0, None)
    rows = np.flatnonzero(st0["lc_ok"] & st1["lc_ok"] & (cap0 > 0.0))
    lab = (du[rows] > _S11_DU_THR).astype(np.float32)
    n_pos = int(lab.sum())
    if n_pos < 10 or n_pos > rows.size - 10:
        raise RuntimeError(f"11: suitability needs both classes ({n_pos} positives of {rows.size} rows, "
                           f"{y0}->{y1})")
    oof = np.full(rows.size, np.nan)
    folds = _S11_FOLD20[rows]
    for k in sorted(int(v) for v in np.unique(folds)):
        tr, te = folds != k, folds == k
        if lab[tr].min() == lab[tr].max() or not te.any():
            continue
        b = _s11_xgb_train(_S11_SUIT_PARAMS, X[rows[tr]], lab[tr], _S11_SUIT_ROUNDS, int(CFG.SEED) + 1100 + k)
        oof[te] = b.inplace_predict(X[rows[te]])
        del b
    ok = np.isfinite(oof)
    booster = _s11_xgb_train(_S11_SUIT_PARAMS, X[rows], lab, _S11_SUIT_ROUNDS, int(CFG.SEED) + 1100)
    info = {"calibration": [int(y0), int(y1)], "n": int(rows.size), "n_positive": n_pos,
            "label": f"du > {_S11_DU_THR}", "features": list(_S11_SUIT_FEATURES),
            "auc_train": _s11_auc(lab, booster.inplace_predict(X[rows])),
            "auc_block20_oof": _s11_auc(lab[ok], oof[ok]), "auc_hindcast": None}
    if hind0 is not None and hind1 is not None:
        sh0, sh1 = _s11_state(hind0), _s11_state(hind1)
        Xh = _s11_suit_matrix(sh0, hind0)
        caph = np.clip(1.0 - sh0["u"] - sh0["forest"] - sh0["water"], 0.0, None)
        rh = np.flatnonzero(sh0["lc_ok"] & sh1["lc_ok"] & (caph > 0.0))
        info["auc_hindcast"] = _s11_auc((sh1["u"] - sh0["u"])[rh] > _S11_DU_THR, booster.inplace_predict(Xh[rh]))
        info["hindcast_period"] = [int(hind0), int(hind1)]
    imp = booster.get_score(importance_type="gain")
    info["gain_importance"] = {_S11_SUIT_FEATURES[int(k[1:])]: float(v) for k, v in imp.items()
                               if k.startswith("f") and k[1:].isdigit()}
    return booster, info


# %% [markdown]
# ## 11.3 Allocation (bisection on $k_d$) and the CA run
# For a district with demand increment $D$, $f(k) = \sum_i \min(cap_i, k\,a_i)$ is continuous and non-decreasing in
# $k$, so bisection finds $k_d$ with $f(k_d) = D$; the last bracket is closed exactly by rescaling the uncapped
# cells. If the eligible capacity ($a_i > 0$, cap > 0) is smaller than $D$, every eligible cell is filled and the
# shortfall is recorded (it is carried into the next step's demand). Built-up land never decreases (GHSL rule).

# %%
def _s11_allocate(st, demand_inc, attract):
    """Allocate district demand increments; returns (new state, du, shortfall dict) - donors in proportion."""
    u, forest, water = st["u"], st["forest"], st["water"]
    cap = np.where(st["lc_ok"], np.clip(1.0 - u - forest - water, 0.0, None), 0.0)
    a = np.clip(np.nan_to_num(attract, nan=0.0), 0.0, None)
    du = np.zeros(_S11_NC)
    shortfall = {}
    for d, demand in demand_inc.items():
        if demand <= 1e-12 or d not in _S11_DIST_CELLS:
            continue
        idx = _S11_DIST_CELLS[d]
        ai, ci = a[idx], cap[idx]
        elig = (ai > 0) & (ci > 0)
        total = float(ci[elig].sum())
        if total <= demand:
            du[idx[elig]] = ci[elig]
            if demand - total > 1e-9:
                shortfall[d] = float(demand - total)
            continue
        ae, ce = ai[elig], ci[elig]

        def f(k, ce=ce, ae=ae):
            return float(np.minimum(ce, k * ae).sum())

        lo, hi = 0.0, demand / float(ae.sum())
        for _ in range(200):
            if f(hi) >= demand:
                break
            lo, hi = hi, hi * 2.0
        for _ in range(100):
            mid = 0.5 * (lo + hi)
            if f(mid) < demand:
                lo = mid
            else:
                hi = mid
            if hi - lo <= 1e-12 * hi:
                break
        alloc = np.minimum(ce, hi * ae)
        unc = alloc < ce
        excess = float(alloc.sum()) - demand
        s_unc = float(alloc[unc].sum())
        if excess > 0 and s_unc > 0:
            alloc[unc] *= max(0.0, (s_unc - excess) / s_unc)
        du[idx[elig]] = alloc
    new = _s11_copy_state(st)
    other = _s11_other(st)
    donors = st["crop"] + st["barren"] + other
    with np.errstate(invalid="ignore", divide="ignore"):
        take_c = np.where(donors > 0, du * st["crop"] / donors, 0.0)
        take_b = np.where(donors > 0, du * st["barren"] / donors, 0.0)
    new["u"] = np.clip(u + du, 0.0, 1.0)
    new["crop"] = np.clip(st["crop"] - take_c, 0.0, 1.0)
    new["barren"] = np.clip(st["barren"] - take_b, 0.0, 1.0)
    donor = {"cropland": float(take_c.sum()), "barren": float(take_b.sum()),
             "other_vegetation": float(du.sum() - take_c.sum() - take_b.sum())}
    return new, du, shortfall, donor


def _s11_run_ca(st0, path, rng, suit, ref_year, pop_fn, null=False):
    """Run the CA through ``path`` = [(year, {district: target total})]; returns [(year, state, info)]."""
    st = _s11_copy_state(st0)
    out = []
    for year, targets in path:
        cur = _s11_district_totals(st["u"])
        inc = {d: max(0.0, float(targets.get(d, cur[d])) - cur[d]) for d in _S11_DIST_IDS}
        if null:
            attract = st["u"].copy()                     # proportional growth: du ~ u (Pontius null model)
        else:
            S = suit.inplace_predict(_s11_suit_matrix(st, ref_year)).astype(np.float64)
            N = np.nan_to_num(_s11_box_mean(st["u"], 3), nan=0.0)
            eps = rng.lognormal(0.0, _S11_EPS_SIGMA, _S11_NC)
            attract = S * N * eps
        st, du, short, donor = _s11_allocate(st, inc, attract)
        st["pop"] = pop_fn(st, year)
        out.append((int(year), _s11_copy_state(st), {"shortfall": short, "donor": donor,
                                                       "allocated": float(du.sum())}))
    return out


def _s11_change_metrics(du_obs, du_sim, valid):
    """Pontius change agreement on cells with du > threshold + RMSE(du)."""
    o = (du_obs > _S11_DU_THR) & valid
    s = (du_sim > _S11_DU_THR) & valid
    hits, misses, fa = int((o & s).sum()), int((o & ~s).sum()), int((~o & s).sum())
    n = int(valid.sum())
    denom = hits + misses + fa
    corr = None
    if n > 2:
        a, b = np.asarray(du_sim[valid], np.float64), np.asarray(du_obs[valid], np.float64)
        if float(a.std()) > 0 and float(b.std()) > 0:
            corr = float(np.corrcoef(a, b)[0, 1])
    return {"fom": hits / denom if denom else None, "hits": hits, "misses": misses, "false_alarms": fa,
            "corr_du": corr,
            "wrong_hits": 0, "quantity_disagreement": abs(int(s.sum()) - int(o.sum())) / n if n else None,
            "allocation_disagreement": 2.0 * min(misses, fa) / n if n else None,
            "rmse_du": float(np.sqrt(np.mean((du_sim[valid] - du_obs[valid]) ** 2))) if n else None,
            "n_obs_change": int(o.sum()), "n_sim_change": int(s.sum())}


def _s11_hindcast(suit, h0, h1, independent):
    """2015 -> 2025 hindcast with the observed district demand: CA realisations vs the proportional-growth null."""
    st0, st1 = _s11_state(h0), _s11_state(h1)
    mids = [y for y in _S11_FRAMES_OBS if h0 < y < h1]
    path = [(y, _s11_district_totals(_s11_state(y)["u"])) for y in mids] + [(h1, _s11_district_totals(st1["u"]))]
    totals = {y: float(_s11_state(y)["pop"].sum()) for y in [h0] + [p[0] for p in path]}

    def pop_fn(st, year):
        return _s11_pop_rule(st["u"], st0["pop"], st0["u"], totals[year] / max(totals[h0], 1.0))

    valid = st0["lc_ok"] & st1["lc_ok"]
    du_obs = st1["u"] - st0["u"]
    real = []
    sims = []
    for r in range(int(CFG.N_LAND_REAL)):
        rng = np.random.default_rng([int(CFG.SEED), 1150, r])
        res = _s11_run_ca(st0, path, rng, suit, h0, pop_fn)
        du_sim = res[-1][1]["u"] - st0["u"]
        sims.append(du_sim.astype(np.float32))
        real.append(_s11_change_metrics(du_obs, du_sim, valid))
    null_res = _s11_run_ca(st0, path, None, suit, h0, pop_fn, null=True)
    du_null = null_res[-1][1]["u"] - st0["u"]
    nm = _s11_change_metrics(du_obs, du_null, valid)

    def mean_of(key):
        vals = [m[key] for m in real if m[key] is not None]
        return float(np.mean(vals)) if vals else None

    # observed donor shares of the converted land (cells with du > threshold)
    sel = valid & (du_obs > _S11_DU_THR)
    d_crop = float(np.clip(st0["crop"][sel] - st1["crop"][sel], 0.0, None).sum())
    d_bar = float(np.clip(st0["barren"][sel] - st1["barren"][sel], 0.0, None).sum())
    d_oth = float(np.clip(_s11_other(st0)[sel] - _s11_other(st1)[sel], 0.0, None).sum())
    tot = d_crop + d_bar + d_oth
    fom_vals = [m["fom"] for m in real if m["fom"] is not None]
    metrics = {"fom": mean_of("fom"), "fom_sd": float(np.std(fom_vals)) if fom_vals else None,
               "fom_null": nm["fom"], "quantity_disagreement": mean_of("quantity_disagreement"),
               "allocation_disagreement": mean_of("allocation_disagreement"), "rmse_du": mean_of("rmse_du"),
               "rmse_du_null": nm["rmse_du"], "quantity_disagreement_null": nm["quantity_disagreement"],
               "allocation_disagreement_null": nm["allocation_disagreement"],
               "corr_du": mean_of("corr_du"), "corr_du_null": nm["corr_du"],
               "hits": mean_of("hits"), "misses": mean_of("misses"), "false_alarms": mean_of("false_alarms"),
               "n_obs_change": real[0]["n_obs_change"] if real else None, "n_realisations": len(real),
               "period": [int(h0), int(h1)], "steps": [int(p[0]) for p in path], "independent": bool(independent),
               "threshold_du": _S11_DU_THR, "null_model": "du proportional to u_2015 (same district demand)",
               "observed_donor_shares": ({"cropland": d_crop / tot, "barren": d_bar / tot,
                                          "other_vegetation": d_oth / tot} if tot > 0 else None)}
    maps = {"du_obs": du_obs.astype(np.float32), "du_sim": sims[0] if sims else None,
            "du_null": du_null.astype(np.float32)}
    metrics.update(_s11_plausibility(metrics))
    return metrics, maps


def _s11_plausibility(hm):
    """Multi-metric comparison of the CA hindcast with the proportional-growth null (D18).

    The CA output still drives the projections; the verdict only tells the reader how much allocation skill the
    hindcast demonstrated. A check with a missing value has ok = None and does not enter the verdict."""
    specs = (("fom > null", "fom", "fom_null", lambda v, n: v > n),
             ("rmse_du <= null", "rmse_du", "rmse_du_null", lambda v, n: v <= n),
             ("quantity_disagreement <= null", "quantity_disagreement", "quantity_disagreement_null",
              lambda v, n: v <= n),
             ("corr_du >= null", "corr_du", "corr_du_null", lambda v, n: v >= n))
    checks = []
    for name, key, key0, rule in specs:
        v, n0 = hm.get(key), hm.get(key0)
        ok = bool(rule(float(v), float(n0))) if v is not None and n0 is not None else None
        checks.append({"check": name, "value": v, "null": n0, "ok": ok})
    oks = [c["ok"] for c in checks if c["ok"] is not None]
    verdict = (None if not oks else "beats_null" if all(oks) else "worse_than_null" if not any(oks) else "mixed")
    end = int((hm.get("period") or [0, 0])[1])
    truth = f"GHSL P2023A {end} epoch" + (" (an extrapolated GHSL epoch, not an observation)" if end == 2025 else "")
    return {"checks": checks, "verdict": verdict, "hindcast_truth": truth}


# %% [markdown]
# ## 11.4 Derived predictors $h_X$ (delta mapping) and projected feature matrices

# %%
def _s11_lc_design(fr):
    """(N_CELLS, 22) design of h_X: 5 fractions, their 3/15-cell focal means, 7 terrain features."""
    cols = []
    for f in _S11_FRACS:
        cols.append(np.asarray(fr[f], np.float64))
    for f in _S11_FRACS:
        for w in FOCAL_SPEC["windows"]:
            cols.append(_s11_box_mean(fr[f], int(w)))
    for t in _S11_TERRAIN:
        cols.append(_s11_cells(FEATURE_GRIDS[_S11_NOW][t]).astype(np.float64))
    return np.column_stack(cols).astype(np.float32)


def _s11_state_fracs(st):
    return {"frac_built": st["u"], "frac_forest": st["forest"], "frac_water": st["water"],
            "frac_cropland": st["crop"], "frac_barren": st["barren"]}


def _s11_fit_h():
    frames = [y for y in (2015, 2020, 2025) if y in _S11_FRAMES_OBS] or _S11_FRAMES_OBS[-3:]
    designs = {y: _s11_lc_design({f: _s11_cells(FEATURE_GRIDS[y][f]).astype(np.float64) for f in _S11_FRACS})
               for y in frames}
    models, report = {}, {}
    for j, target in enumerate(_S11_H_TARGETS):
        Xs, ys, folds = [], [], []
        for y in frames:
            t = _s11_cells(FEATURE_GRIDS[y][target]).astype(np.float64)
            ok = np.isfinite(t)
            Xs.append(designs[y][ok])
            ys.append(t[ok])
            folds.append(_S11_FOLD20[ok])
        X, yv, fo = np.vstack(Xs), np.concatenate(ys).astype(np.float32), np.concatenate(folds)
        if yv.size < 50:
            log(f"11: h_{target}: only {yv.size} rows - delta mapping disabled (X held at 2025)", "WARNING")
            models[target], report[target] = None, {"n": int(yv.size), "r2_holdout": None}
            continue
        hold = fo == 0
        r2 = None
        if hold.any() and (~hold).sum() > 50:
            b = _s11_xgb_train(_S11_H_PARAMS, X[~hold], yv[~hold], _S11_H_ROUNDS, int(CFG.SEED) + 1200 + j)
            p = b.inplace_predict(X[hold]).astype(np.float64)
            sst = float(np.sum((yv[hold] - yv[hold].mean()) ** 2))
            r2 = 1.0 - float(np.sum((yv[hold] - p) ** 2)) / sst if sst > 0 else None
            del b
        models[target] = _s11_xgb_train(_S11_H_PARAMS, X, yv, _S11_H_ROUNDS, int(CFG.SEED) + 1200 + j)
        report[target] = {"n": int(yv.size), "r2_holdout": r2, "holdout": "block20 fold 0", "frames": frames}
    return models, report, frames


def _s11_era5_climatology():
    frames = [y for y in (2015, 2020, 2025) if y in _S11_FRAMES_OBS] or _S11_FRAMES_OBS[-3:]
    clim = {}
    for f in _S11_ERA5:
        stack = np.stack([np.asarray(FEATURE_GRIDS[y][f], np.float64) for y in frames])
        ok = np.isfinite(stack)
        n = ok.sum(axis=0)
        with np.errstate(invalid="ignore", divide="ignore"):
            mean = np.where(ok, stack, 0.0).sum(axis=0) / n
        clim[f] = np.where(ROI_MASK & (n > 0), mean, np.nan).astype(np.float32)
    return clim, frames


def _s11_features(st, ctx):
    """(N_CELLS, 47) float32 projected feature matrix of a land state (delta mapping, pop, ERA5 climatology)."""
    base = FEATURE_GRIDS[_S11_NOW]
    grids = {f: base[f] for f in BASE_FEATURES}
    now_fr = ctx["now_fracs"]
    fr = _s11_state_fracs(st)
    lc_ok = st["lc_ok"]
    for f in _S11_FRACS:
        vals = np.where(lc_ok, fr[f], now_fr[f])
        grids[f] = _s11_grid(vals)
    design = _s11_lc_design(fr)
    for target in _S11_H_TARGETS:
        x_now = ctx["x_now"][target]
        model = ctx["h_models"].get(target)
        if model is None:
            x = x_now
        else:
            x = x_now + (model.inplace_predict(design).astype(np.float64) - ctx["h_now"][target])
            lo, hi = _S11_BOUNDS[target]
            x = np.where(np.isfinite(x_now), np.clip(x, lo, hi), np.nan)
        grids[target] = _s11_grid(x)
    grids["ndvi_drop"] = grids["ndvi_spring"] - grids["ndvi"]
    grids["log_pop"] = _s11_grid(np.where(st["pop_ok"], np.log1p(np.clip(st["pop"], 0.0, None)), np.nan))
    for f in _S11_ERA5:
        grids[f] = ctx["era5"][f]
    full = FOCAL_RECOMPUTE(grids, recompute_distances=True)
    return FEATURE_MATRIX(full)


def _s11_predict(m, X):
    """Raw final-model anomaly prediction (°C), GPU when available."""
    booster = FINAL_MODELS[m]
    device = xgb_device_for(0)
    try:
        if device != "cpu":
            booster.set_param({"device": device})
            try:
                return np.asarray(booster.predict(xgb.DMatrix(X, missing=np.nan)), np.float32)
            except Exception as exc:  # noqa: BLE001
                if not is_gpu_oom_error(exc):
                    raise
                log("11: GPU OOM in prediction; using the CPU", "WARNING")
                booster.set_param({"device": "cpu"})
        return np.asarray(booster.inplace_predict(np.ascontiguousarray(X, np.float32)), np.float32)
    finally:
        booster.set_param({"device": "cpu"})


_S11_MEMBER = np.zeros((len(FEATURES), len(SHAP_GROUPS)), dtype=np.float64)
for _s11_gi, _s11_g in enumerate(SHAP_GROUPS):
    for _s11_f in SHAP_GROUPS[_s11_g]:
        _S11_MEMBER[FEATURES.index(_s11_f), _s11_gi] = 1.0
_S11_BASE_IDX = np.array([FEATURES.index(f) for f in BASE_FEATURES])


def _s11_group_shap(m, X):
    """(n, 18) grouped TreeSHAP of the final model (NaN rows where a base feature is missing, as in section 08)."""
    booster = FINAL_MODELS[m]
    out = np.empty((X.shape[0], len(SHAP_GROUPS)), dtype=np.float32)
    device = xgb_device_for(0)
    batch = _S11_SHAP_BATCH
    try:
        booster.set_param({"device": device})
        s = 0
        while s < X.shape[0]:
            e = min(X.shape[0], s + batch)
            try:
                phi = booster.predict(xgb.DMatrix(X[s:e], missing=np.nan), pred_contribs=True)
            except Exception as exc:  # noqa: BLE001
                if device != "cpu" and is_gpu_oom_error(exc):
                    device = "cpu"
                    booster.set_param({"device": "cpu"})
                    log("11: GPU OOM in TreeSHAP; continuing on the CPU", "WARNING")
                    continue
                raise
            out[s:e] = (phi[:, :len(FEATURES)].astype(np.float64) @ _S11_MEMBER).astype(np.float32)
            s = e
    finally:
        booster.set_param({"device": "cpu"})
    out[~np.isfinite(X[:, _S11_BASE_IDX]).all(axis=1)] = np.nan
    return out


# %% [markdown]
# ## 11.5 Demand, climate deltas and the weather-normalised baseline

# %%
def _s11_ratio_table():
    ug = FUTURE_INPUTS["urban_growth"]
    tab = {}
    for (s, d), grp in ug.groupby(["scenario", "district"]):
        tab[(str(s), int(d))] = dict(zip(grp["frame"].astype(int), grp["ratio"].astype(float)))
    return tab


def _s11_interp_ratio(series, year):
    """Geometric interpolation of an urban-area ratio series (frame -> ratio) at ``year``."""
    if year in series:
        return float(series[year])
    xs = sorted(series)
    if not xs:
        return float("nan")
    if year <= xs[0]:
        return float(series[xs[0]])
    if year >= xs[-1]:
        return float(series[xs[-1]])
    lo = max(x for x in xs if x <= year)
    hi = min(x for x in xs if x >= year)
    w = (year - lo) / (hi - lo)
    return float(series[lo] ** (1.0 - w) * series[hi] ** w)


def _s11_demand(s, u_now):
    """Target district totals per projection frame: U_d(2025) x g_d,s(y) / g_d,s(2025)."""
    tab = _s11_ratio_table()
    base = _s11_district_totals(u_now)
    out, missing = {}, []
    for y in _S11_PROJ:
        targets = {}
        med = [(_s11_interp_ratio(v, y) / _s11_interp_ratio(v, _S11_NOW)) for (sc, _), v in tab.items() if sc == s]
        fallback = float(np.median(med)) if med else 1.0
        for d in _S11_DIST_IDS:
            series = tab.get((s, d))
            if series is None:
                g = fallback
                if y == _S11_PROJ[0]:
                    missing.append(d)
            else:
                g = _s11_interp_ratio(series, y) / _s11_interp_ratio(series, _S11_NOW)
            targets[d] = base[d] * max(float(g), 1.0)       # built-up never shrinks
        out[y] = targets
    if missing:
        log(f"11: {s}: no urban-growth ratio for districts {missing}; the scenario's median ratio is used", "WARNING")
    return out


def _s11_pop_factor(s, y):
    pg = FUTURE_INPUTS["pop_growth"]
    sub = pg[pg["scenario"] == s]
    if sub.empty:
        log(f"11: no population factor for {s}; held at 1", "WARNING")
        return 1.0
    series = dict(zip(sub["frame"].astype(int), sub["factor"].astype(float)))
    return _s11_interp_ratio(series, int(y)) / _s11_interp_ratio(series, _S11_NOW)


def _s11_cmip6_deltas():
    df = FUTURE_INPUTS["cmip6"]
    gsat = FUTURE_INPUTS.get("gsat_increment") or {}
    # baseline_window = the 20-year GCM window of the baseline frame (2016-2035); observation_window = the frame's
    # observation window (2024-2026) whose weather anomaly L_base removes (D15).
    gcm_window = CFG.PROJ_WINDOWS.get(_S11_NOW, (_S11_NOW - 9, _S11_NOW + 10))
    out = {"available": True, "baseline_frame": _S11_NOW, "baseline_window": [int(v) for v in gcm_window],
           "observation_window": [int(v) for v in CFG.window(_S11_NOW)], "frames": list(_S11_PROJ),
           "variables": {"day": "tasmax", "night": "tasmin"}, "scenarios": {},
           "definition": "delta = GCM Apr-Jun 20-year-window mean at the frame minus its 2016-2035 (2025) window"}

    def gcm_deltas(scen, var):
        sub = df[(df["scenario"] == scen) & (df["var"] == var)]
        piv = sub.pivot_table(index="model", columns="frame", values="value_k", aggfunc="mean")
        need = [_S11_NOW] + _S11_PROJ
        if any(c not in piv.columns for c in need):
            return None
        piv = piv[need].dropna()
        return {"models": [str(mm) for mm in piv.index],
                "delta": {y: (piv[y] - piv[_S11_NOW]).to_numpy(np.float64) for y in _S11_PROJ}}

    for s in _S11_SCEN:
        rec = {"variables": {}}
        direct = all(gcm_deltas(s, v) is not None for v in ("tasmax", "tasmin")) if s in set(df["scenario"]) \
            else False
        for var in ("tasmax", "tasmin"):
            if direct:
                d = gcm_deltas(s, var)
                rec["method"] = "gcm"
            else:
                d = gcm_deltas("ssp245", var)
                if d is None:
                    raise RuntimeError(f"11: no CMIP6 data for {s} and no ssp245 to pattern-scale from")
                ratios = {}
                for y in _S11_PROJ:
                    g245 = float((gsat.get("ssp245") or {}).get(y, float("nan")))
                    gs = float((gsat.get(s) or {}).get(y, float("nan")))
                    ratios[y] = gs / g245 if (np.isfinite(g245) and g245 > 0 and np.isfinite(gs)) else 1.0
                d = {"models": d["models"], "delta": {y: d["delta"][y] * ratios[y] for y in _S11_PROJ}}
                rec["method"] = "pattern-scaled"
                rec["gsat_ratio"] = ratios
                rec["source_scenario"] = "ssp245"
            summary = {}
            for y in _S11_PROJ:
                v = d["delta"][y]
                summary[y] = {"mean": float(v.mean()), "sd": float(v.std()), "p05": float(np.percentile(v, 5)),
                              "p50": float(np.median(v)), "p95": float(np.percentile(v, 95)), "n": int(v.size)}
            rec["variables"][var] = {"models": d["models"], "delta": d["delta"], "summary": summary}
        rec["n_gcm"] = min(len(rec["variables"][v]["models"]) for v in ("tasmax", "tasmin"))
        out["scenarios"][s] = rec
    pat = FUTURE_INPUTS.get("cmip6_pattern") or {}
    out["pattern"] = {}
    for var in ("tasmax", "tasmin"):
        p = np.asarray(pat.get(var, np.ones((_S11_H, _S11_W))), np.float64)[CELL_ROWS, CELL_COLS]
        p = np.where(np.isfinite(p), p, 1.0)
        out["pattern"][var] = {"cells": p.astype(np.float32), "min": float(p.min()), "max": float(p.max()),
                               "mean": float(p.mean())}
    return out


def _s11_l_base(m):
    """Weather-normalised baseline level L_base,m (SPEC §4.10)."""
    cs = CLIMATE_SENSITIVITY[m]
    var = cs.get("temperature_var") or ("era5_tmax" if m == "day" else "era5_tmin")
    sub = ANNUAL_SERIES[(ANNUAL_SERIES["variable"] == var) & (ANNUAL_SERIES["scope"] == "ncr")]
    s = pd.Series(sub["value"].to_numpy(np.float64), index=sub["year"].to_numpy(np.int64)).groupby(level=0).mean()
    w0, w1 = CFG.window(_S11_NOW)
    now_years = [y for y in range(int(w0), int(w1) + 1) if y in s.index and np.isfinite(s[y])]
    t0, t1 = _S11_TREND_YEARS
    trend_years = [y for y in range(int(t0), int(t1) + 1) if y in s.index and np.isfinite(s[y])]
    ref_years = [y for y in range(_S11_NOW - 9, _S11_NOW + 1) if y in s.index and np.isfinite(s[y])]
    level = float(LEVELS[m][_S11_NOW]["level"])
    slope_dec = None
    if not now_years:
        log(f"11: {m}: {var} annual series has no value in the {_S11_NOW} window; baseline = observed level "
            "(no weather normalisation)", "WARNING")
        anomaly, method = 0.0, "none (no annual value in the observation window)"
    elif len(trend_years) >= _S11_TREND_MIN_YEARS:
        # anomaly = window mean - OLS trend line at the window's mean year (D15)
        ty = np.asarray(trend_years, np.float64)
        tv = s[trend_years].to_numpy(np.float64)
        slope, icpt = np.polyfit(ty, tv, 1)
        t_mid = float(np.mean(now_years))
        anomaly = float(s[now_years].mean() - (icpt + slope * t_mid))
        slope_dec = float(slope * 10.0)
        method = (f"window mean {now_years[0]}-{now_years[-1]} minus the {trend_years[0]}-{trend_years[-1]} OLS "
                  f"trend of the ERA5-Land NCR annual {var} at {t_mid:g}")
    elif ref_years:
        log(f"11: {m}: only {len(trend_years)} annual {var} values in {t0}-{t1} (< {_S11_TREND_MIN_YEARS}); the "
            f"weather anomaly falls back to the window mean minus the {ref_years[0]}-{ref_years[-1]} mean", "WARNING")
        anomaly = float(s[now_years].mean() - s[ref_years].mean())
        method = f"window mean minus the {ref_years[0]}-{ref_years[-1]} mean (fallback: too few years for a trend)"
    else:
        log(f"11: {m}: {var} annual series incomplete; baseline = observed level (no weather normalisation)",
            "WARNING")
        anomaly, method = 0.0, "none (annual series incomplete)"
    beta = float(cs["beta"])
    return {"l_base": level - beta * anomaly, "level_now": level, "beta": beta, "weather_anomaly_c": anomaly,
            "temperature_var": var, "window_years": now_years, "reference_years": ref_years,
            "trend_slope_per_decade": slope_dec, "trend_years": trend_years, "method": method}


# %% [markdown]
# ## 11.6 Land realisations per scenario (stage-cached)
# Each realisation is driven through 2030 … 2050; at every frame the projected feature matrix is built and the
# final models of both modes predict the raw anomaly $\hat A$. The **median realisation** (the medoid — the
# realisation closest to the per-cell median of $u$ over all frames) provides the features for the AOA flags and
# the projected zones.

# %%
def _s11_land_scenario(s, ctx):
    t0 = _s11_time.perf_counter()
    st_now = ctx["state_now"]
    demand = _s11_demand(s, st_now["u"])
    path = [(y, demand[y]) for y in _S11_PROJ]
    n_r, n_y = int(CFG.N_LAND_REAL), len(_S11_PROJ)
    A = {m: np.empty((n_r, n_y, _S11_NC), dtype=np.float32) for m in _S11_MODES}
    U = np.empty((n_r, n_y, _S11_NC), dtype=np.float32)
    states_crop = np.empty((n_r, n_y, _S11_NC), dtype=np.float32)
    states_barren = np.empty((n_r, n_y, _S11_NC), dtype=np.float32)
    pops = np.empty((n_r, n_y, _S11_NC), dtype=np.float32)
    short_tot = np.zeros((n_r, n_y))
    donors = []

    def pop_fn(st, year):
        return _s11_pop_rule(st["u"], st_now["pop"], st_now["u"], _s11_pop_factor(s, year))

    for r in range(n_r):
        rng = np.random.default_rng([int(CFG.SEED), 1160, r])     # common random numbers across scenarios
        res = _s11_run_ca(st_now, path, rng, ctx["suit"], _S11_NOW, pop_fn)
        for j, (_y, st, info) in enumerate(res):
            U[r, j], states_crop[r, j], states_barren[r, j], pops[r, j] = st["u"], st["crop"], st["barren"], st["pop"]
            short_tot[r, j] = sum(info["shortfall"].values())
            donors.append(info["donor"])
            X = _s11_features(st, ctx)
            for m in _S11_MODES:
                A[m][r, j] = _s11_predict(m, X)
            del X
    med = np.median(U, axis=0)
    medoid = int(np.argmin(((U - med[None]) ** 2).sum(axis=(1, 2))))
    di, zones, shap_mean = {m: [] for m in _S11_MODES}, {m: [] for m in _S11_MODES}, {m: [] for m in _S11_MODES}
    for j in range(n_y):
        st = {"u": U[medoid, j].astype(np.float64), "forest": st_now["forest"], "water": st_now["water"],
              "crop": states_crop[medoid, j].astype(np.float64), "barren": states_barren[medoid, j].astype(np.float64),
              "pop": pops[medoid, j].astype(np.float64), "lc_ok": st_now["lc_ok"], "pop_ok": st_now["pop_ok"]}
        X = _s11_features(st, ctx)
        for m in _S11_MODES:
            di[m].append(COMPUTE_DI(m, X).astype(np.float32))
            if m in ZONE_MODEL:
                G = _s11_group_shap(m, X)
                zones[m].append(ASSIGN_ZONES(m, G))
                shap_mean[m].append(np.nanmean(G, axis=0).astype(np.float32))
                del G
            else:
                zones[m].append(np.full(_S11_NC, _S11_ZONE_NODATA, np.uint8))
                shap_mean[m].append(np.full(len(SHAP_GROUPS), np.nan, np.float32))
        del X
    tot = {k: float(sum(dn[k] for dn in donors)) for k in ("cropland", "barren", "other_vegetation")}
    tsum = sum(tot.values())
    driver = {}
    for j, y in enumerate(_S11_PROJ):
        rows = {}
        for d, idx in _S11_DIST_CELLS.items():
            rows[d] = {"name": _S11_DIST_NAME.get(d, str(d)),
                       "built_km2": float(U[:, j, idx].sum(axis=1).mean() * _S11_CELL_KM2),
                       "built_frac": float(U[:, j, idx].mean()),
                       "pop": float(pops[:, j, idx].sum(axis=1).mean() * _S11_CELL_KM2),
                       "demand_km2": float(demand[y][d] * _S11_CELL_KM2)}
        rows["ncr"] = {"name": "Delhi NCR", "built_km2": float(U[:, j].sum(axis=1).mean() * _S11_CELL_KM2),
                       "built_frac": float(U[:, j].mean()),
                       "pop": float(pops[:, j].sum(axis=1).mean() * _S11_CELL_KM2),
                       "demand_km2": float(sum(demand[y].values()) * _S11_CELL_KM2),
                       "shortfall_km2": float(short_tot[:, j].mean() * _S11_CELL_KM2),
                       "pop_factor": _s11_pop_factor(s, y)}
        driver[y] = rows
    out = {"A": A, "U": U, "medoid": medoid, "di": {m: np.stack(v) for m, v in di.items()},
           "zones": {m: np.stack(v) for m, v in zones.items()},
           "shap_mean": {m: np.stack(v) for m, v in shap_mean.items()}, "driver": driver,
           "donor_shares": {k: v / tsum for k, v in tot.items()} if tsum > 0 else None,
           "shortfall_km2": {y: float(short_tot[:, j].mean() * _S11_CELL_KM2) for j, y in enumerate(_S11_PROJ)},
           "seconds": round(_s11_time.perf_counter() - t0, 1)}
    del states_crop, states_barren, pops
    return out


# %% [markdown]
# ## 11.7 Monte Carlo per scenario × mode
# Draw parameters (GCM rank, β index, realisation index) are shared by all scenarios and modes; the per-cell model
# error is generated chunk by chunk from a seeded uniform $U_{k,i}$ mapped through the **sorted** residual sample of
# the cell's DI decile (a quantile mapping, so a cell keeps its error rank when its DI decile changes between
# frames). The residual sample is the **projection-setting** one of section 07 (`resid_samples_proj`: signed
# $y − (\hat y_{LOEO} + \bar r)$ by DI decile) when it is complete, else the block20 OOF sample (`resid_samples`).
# Spatial correlation enters through a block20 Gaussian copula: $z_{kb} \sim N(0, 1)$ per draw $k$ and 20 km block
# $b$ (drawn once per run from `default_rng([SEED, 1181])`, shared by all scenarios, modes and chunks),
# $z_{ki} = Φ^{-1}(U_{k,i})$ and $u_{ki} = Φ(\sqrt{ρ}\,z_{kb(i)} + \sqrt{1 − ρ}\,z_{ki})$ with
# ρ = `AOA[m]['resid_rho_block20']` ∈ [0, 0.95]; ρ = 0 uses $U_{k,i}$ directly (bit-identical to independent
# draws). A DI of +inf (row with a missing weighted feature, section 07) falls into the top decile and is flagged
# outside the AOA. Scope sums of every draw are accumulated with a dense (cells × scopes) membership matrix per chunk.

# %%
def _s11_scopes(m):
    out = [("ncr", None)]
    out += [(f"d:{d}", d) for d in _S11_DIST_IDS]
    if m in ZONE_MODEL:
        out += [(f"z:{m}:{k}", ("zone", k)) for k in range(4)]
    return out


def _s11_membership(scopes, zones_y, sl):
    n = sl.stop - sl.start
    M = np.zeros((n, len(scopes)), dtype=np.float32)
    dist = _S11_DISTRICT[sl]
    for j, (_sid, key) in enumerate(scopes):
        if key is None:
            M[:, j] = 1.0
        elif isinstance(key, tuple):
            M[:, j] = (zones_y[sl] == key[1])
        else:
            M[:, j] = (dist == key)
    return M


def _s11_draws():
    rng = np.random.default_rng([int(CFG.SEED), 1170])
    n = int(CFG.N_MC)
    out = {"g_u": rng.random(n), "beta_u": rng.random(n), "r_idx": rng.integers(0, int(CFG.N_LAND_REAL), n)}
    # block20 copula factors (D13): one N(0, 1) per draw and 20 km block, shared by every scenario, mode and chunk
    blk = DF["block20_id"].to_numpy()[:_S11_NC]
    _ids, inv = np.unique(blk, return_inverse=True)
    out["block_idx"] = inv.astype(np.int64).reshape(-1)
    out["z_block"] = np.random.default_rng([int(CFG.SEED), 1181]).standard_normal((n, int(_ids.size)))
    return out


def _s11_error_model(m, n_dec):
    """(sorted residual samples per DI decile, source label, rho) of the Monte-Carlo model error (D13)."""
    proj = AOA[m].get("resid_samples_proj")
    samples, source = None, "block20"
    if proj is not None:
        if len(proj) == n_dec and all(np.asarray(v).size > 0 for v in proj):
            samples = [np.sort(np.asarray(v, np.float32)) for v in proj]
            source = "loeo+rbar"
        else:
            log(f"11: {m}: projection-setting residual samples incomplete ({len(proj)} deciles, "
                f"{sum(int(np.asarray(v).size == 0) for v in proj)} empty); using the block20 OOF samples", "WARNING")
    if samples is None:
        samples = [np.sort(np.asarray(v, np.float32)) for v in AOA[m].get("resid_samples", [])]
        if len(samples) != n_dec or any(v.size == 0 for v in samples):
            log(f"11: {m}: conformal residual samples incomplete; empty deciles contribute zero model error",
                "WARNING")
            samples = [v if v.size else np.zeros(1, np.float32) for v in samples] or [np.zeros(1, np.float32)]
            samples += [samples[-1]] * (n_dec - len(samples))
    rho = AOA[m].get("resid_rho_block20", 0.0)
    rho = float(rho) if rho is not None and np.isfinite(float(rho)) else 0.0
    return samples, source, float(np.clip(rho, 0.0, _S11_RHO_MAX))


def _s11_monte_carlo(s, m, land, ctx):
    t0 = _s11_time.perf_counter()
    draws = ctx["draws"]
    n_mc, n_y = int(CFG.N_MC), len(_S11_PROJ)
    cm = CMIP6_DELTAS["scenarios"][s]["variables"][_S11_TEMP_VAR[m]]
    n_g = len(cm["models"])
    g_idx = np.minimum((draws["g_u"] * n_g).astype(np.int64), n_g - 1)
    beta_all = np.sort(np.asarray(CLIMATE_SENSITIVITY[m]["draws"], np.float64))
    beta_k = beta_all[np.minimum((draws["beta_u"] * beta_all.size).astype(np.int64), beta_all.size - 1)]
    r_idx = draws["r_idx"]
    lb = ctx["l_base"][m]["l_base"]
    pat = CMIP6_DELTAS["pattern"][_S11_TEMP_VAR[m]]["cells"].astype(np.float32)
    rbar = np.nan_to_num(np.asarray(PERSISTENT_RESID[m], np.float64)[CELL_ROWS, CELL_COLS], nan=0.0)
    a_base = ctx["a_base"][m]
    a_mean = float(a_base[_S11_FIXED[m]].mean())
    edges = np.asarray(AOA[m]["conformal"]["edges"], np.float64)
    samples, err_source, rho = _s11_error_model(m, edges.size + 1)
    blk_idx, z_block = draws["block_idx"], draws["z_block"]
    sq_rho, sq_1rho = np.sqrt(rho), np.sqrt(1.0 - rho)
    thr = float(AOA[m]["threshold"])
    scopes = _s11_scopes(m)
    n_sc = len(scopes)
    quant = {k: np.empty((n_y, _S11_NC), dtype=np.float32) for k in _S11_QK}
    flags = np.zeros((n_y, _S11_NC), dtype=np.uint8)
    scope_sum = np.zeros((n_y, n_mc, n_sc))
    e_sum = np.zeros((n_y, n_mc, n_sc))
    land_sc = np.zeros((n_y, int(CFG.N_LAND_REAL), n_sc))
    pat_sc = np.zeros((n_y, n_sc))
    base_sc = np.zeros((n_y, n_sc))
    count_sc = np.zeros((n_y, n_sc))
    adev_base = (a_base - a_mean).astype(np.float32)
    for j, y in enumerate(_S11_PROJ):
        clim_k = (beta_k * cm["delta"][y][g_idx]).astype(np.float32)       # (n_mc,)
        adev = land["A"][m][:, j, :] - np.float32(a_mean)                    # (R, N)
        dec = np.clip(np.searchsorted(edges, land["di"][m][j].astype(np.float64), side="right"), 0, len(samples) - 1)
        zones_y = land["zones"][m][j]
        for ci, s0 in enumerate(range(0, _S11_NC, _S11_CELL_CHUNK)):
            sl = slice(s0, min(_S11_NC, s0 + _S11_CELL_CHUNK))
            nc = sl.stop - sl.start
            uni = np.random.default_rng([int(CFG.SEED), 1180, ci]).random((n_mc, nc), dtype=np.float32)
            if rho > 0.0:
                # block20 Gaussian copula: u = Phi(sqrt(rho) z_kb + sqrt(1 - rho) z_ki), z_ki = Phi^-1(uni)
                z = _s11_special.ndtri(np.clip(uni.astype(np.float64), _S11_U_CLIP, 1.0 - _S11_U_CLIP))
                z *= sq_1rho
                z += sq_rho * z_block[:, blk_idx[sl]]
                uni = _s11_special.ndtr(z)
                del z
            e = np.empty((n_mc, nc), dtype=np.float32)
            dec_c = dec[sl]
            for d in np.unique(dec_c):
                cols = np.flatnonzero(dec_c == d)
                smp = samples[int(d)]
                e[:, cols] = smp[np.minimum((uni[:, cols] * smp.size).astype(np.int64), smp.size - 1)]
            del uni
            lst = (np.float32(lb) + clim_k[:, None] * pat[None, sl] + adev[:, sl][r_idx]
                   + rbar[sl].astype(np.float32)[None, :] + e)
            q = np.quantile(lst, _S11_Q, axis=0)
            for k, key in enumerate(_S11_QK):
                quant[key][j, sl] = q[k]
            M = _s11_membership(scopes, zones_y, sl)
            scope_sum[j] += lst.astype(np.float64) @ M
            e_sum[j] += e.astype(np.float64) @ M
            land_sc[j] += adev[:, sl].astype(np.float64) @ M - (adev_base[sl].astype(np.float64) @ M)[None, :]
            pat_sc[j] += pat[sl].astype(np.float64) @ M
            base_sc[j] += (adev_base[sl].astype(np.float64) + rbar[sl]) @ M
            count_sc[j] += M.sum(axis=0)
            del lst, e, q, M
        half = 0.5 * (quant["p95"][j] - quant["p05"][j])
        tier = np.searchsorted(_S11_VSUP_EDGES, half, side="right").astype(np.uint8)
        flags[j] = (tier << np.uint8(1)) | (land["di"][m][j] > thr).astype(np.uint8)
    # ---- scope products -------------------------------------------------------------------------------------------
    beta_bar, beta_var = float(beta_all.mean()), float(beta_all.var())
    series, decomp, budget, thresholds = {}, {y: {} for y in _S11_PROJ}, {y: {} for y in _S11_PROJ}, {}
    for c, (sid, _) in enumerate(scopes):
        rows, thr_years = [], {"+1": None, "+2": None, "+3": None}
        for j, y in enumerate(_S11_PROJ):
            n = count_sc[j, c]
            if n <= 0:
                rows.append({"year": int(y), **{k: None for k in _S11_QK}})
                continue
            means = scope_sum[j, :, c] / n
            qv = np.quantile(means, _S11_Q)
            rows.append({"year": int(y), **{k: float(v) for k, v in zip(_S11_QK, qv)}})
            dT = cm["delta"][y]
            p_sc = pat_sc[j, c] / n
            land_r = land_sc[j, :, c] / n
            # the scope's own weather-normalised 2025 baseline: every draw mean = baseline + climate + land + error,
            # so total = p50 - baseline ~ climate + land + model_error_mean for districts and zones too (D14)
            baseline = lb + base_sc[j, c] / n
            decomp[y][sid] = {"climate": beta_bar * float(dT.mean()) * p_sc, "land": float(land_r.mean()),
                              "total": float(qv[2] - baseline), "baseline_c": float(baseline),
                              "baseline_offset": float(base_sc[j, c] / n),
                              "model_error_mean": float((e_sum[j, :, c] / n).mean())}
            parts = {"gcm": (beta_bar * p_sc) ** 2 * float(dT.var()),
                     "sensitivity": beta_var * (float(dT.mean()) * p_sc) ** 2,
                     "land": float(land_r.var()), "model": float((e_sum[j, :, c] / n).var())}
            tot = sum(parts.values())
            budget[y][sid] = {**{k: (v / tot if tot > 0 else 0.0) for k, v in parts.items()},
                              "total_variance": tot, "draw_sd_c": float(means.std())}
            for key, inc in (("+1", 1.0), ("+2", 2.0), ("+3", 3.0)):
                if thr_years[key] is None and qv[2] > baseline + inc:
                    thr_years[key] = int(y)
        series[sid] = rows
        thresholds[sid] = thr_years
    ncr = {y: decomp[y].get("ncr") for y in _S11_PROJ}
    meta = {"seconds": round(_s11_time.perf_counter() - t0, 1), "n_mc": n_mc, "n_gcm": n_g,
            "n_land_real": int(CFG.N_LAND_REAL), "beta_mean": beta_bar, "beta_sd": float(np.sqrt(beta_var)),
            "l_base": lb, "a2025_fixed_mean": a_mean, "scopes": [sid for sid, _ in scopes],
            "model_error": {"samples": err_source, "rho": rho}}
    out_decomp = {y: {**(ncr[y] or {}), "by_scope": decomp[y]} for y in _S11_PROJ}
    out_budget = {y: {**{k: v for k, v in (budget[y].get("ncr") or {}).items()}, "by_scope": budget[y]}
                  for y in _S11_PROJ}
    return quant, flags, series, out_decomp, out_budget, thresholds, meta


# %% [markdown]
# ## 11.8 Run: suitability, hindcast, derived predictors, CMIP6 deltas, baseline, scenarios

# %%
def _s11_hash(*parts):
    h = _s11_hashlib.sha1()
    for p in parts:
        if isinstance(p, np.ndarray):
            h.update(str(p.dtype).encode())
            h.update(np.ascontiguousarray(p).tobytes())
        elif isinstance(p, (bytes, bytearray)):
            h.update(bytes(p))
        elif isinstance(p, pd.DataFrame):
            h.update(pd.util.hash_pandas_object(p, index=False).to_numpy().tobytes())
        else:
            h.update(repr(p).encode())
        h.update(b"|")
    return h.hexdigest()[:16]


def _s11_land_fingerprint():
    parts = [_S11_VERSION, _S11_PROJ, _S11_SCEN, _S11_NOW]
    for y in _S11_FRAMES_OBS:
        for f in _S11_FRACS + _S11_H_TARGETS + ["log_pop", "dist_urban"]:
            v = np.asarray(FEATURE_GRIDS[y][f], np.float64)
            parts.append(np.array([np.nansum(v), np.isfinite(v).sum()]))
        parts.append(np.array([np.nansum(np.asarray(RAW_OBS[y]["pop"], np.float64))]))
    for m in _S11_MODES:
        parts.append(bytes(FINAL_MODELS[m].save_raw("ubj")))
        parts += [float(AOA[m]["threshold"]), float(AOA[m]["d_bar"])]
        if m in ZONE_MODEL:
            parts.append(np.asarray(ZONE_MODEL[m]["centroids"], np.float64))
    parts += [FUTURE_INPUTS["urban_growth"], FUTURE_INPUTS["pop_growth"]]
    return _s11_hash(*parts)


if _S11_ACTIVE:
    _S11_T0 = _s11_time.perf_counter()
    _s11_h0, _s11_h1, _s11_hind_ok = _s11_pick_pair(2015, _S11_NOW, _S11_NOW)
    _s11_c0, _s11_c1, _s11_cal_ok = _s11_pick_pair(2005, 2015, _s11_h0 if _s11_h0 is not None else _S11_NOW)
    if _s11_c0 is None:
        raise RuntimeError("11: projections need at least two observed frames for the land-change model")
    _s11_indep = bool(_s11_cal_ok and _s11_h0 is not None and _s11_c1 <= _s11_h0)
    with timer("11_suitability"):
        _S11_SUIT, _S11_SUIT_INFO = _s11_fit_suitability(_s11_c0, _s11_c1, _s11_h0, _s11_h1)
    log(f"11: suitability {_s11_c0}->{_s11_c1}: n={_S11_SUIT_INFO['n']:,} ({_S11_SUIT_INFO['n_positive']} positive), "
        f"AUC train {_S11_SUIT_INFO['auc_train']:.3f}, block20 OOF {_S11_SUIT_INFO['auc_block20_oof']}, "
        f"hindcast {_S11_SUIT_INFO['auc_hindcast']}")
    if _s11_h0 is not None and _s11_h1 is not None and _s11_h0 < _s11_h1:
        with timer("11_land_hindcast"):
            _S11_HIND, _S11_HIND_MAPS = _s11_hindcast(_S11_SUIT, _s11_h0, _s11_h1, _s11_indep)
        log(f"11: land hindcast {_s11_h0}->{_s11_h1}: FoM {_S11_HIND['fom']:.3f} (sd {_S11_HIND['fom_sd']:.3f}) vs "
            f"null {_S11_HIND['fom_null']:.3f}; quantity {_S11_HIND['quantity_disagreement']:.4f}, allocation "
            f"{_S11_HIND['allocation_disagreement']:.4f}; RMSE du {_S11_HIND['rmse_du']:.4f} vs null "
            f"{_S11_HIND['rmse_du_null']:.4f}; corr du {_S11_HIND['corr_du']} vs null {_S11_HIND['corr_du_null']}; "
            f"verdict {_S11_HIND['verdict']} (truth: {_S11_HIND['hindcast_truth']})")
    else:
        _S11_HIND, _S11_HIND_MAPS = {"available": False, "reason": "no hindcast frame pair"}, None
    with timer("11_derived_predictors"):
        _S11_H_MODELS, _S11_H_REPORT, _S11_H_FRAMES = _s11_fit_h()
    log("11: delta-mapping models h_X (R2 on block20 fold 0): "
        + ", ".join(f"{k}={v['r2_holdout']:.2f}" if v["r2_holdout"] is not None else f"{k}=n/a"
                    for k, v in _S11_H_REPORT.items()))
    CMIP6_DELTAS = _s11_cmip6_deltas()
    for _s11_s, _s11_r in CMIP6_DELTAS["scenarios"].items():
        log(f"11: CMIP6 {_s11_s} ({_s11_r['method']}, {_s11_r['n_gcm']} GCMs): delta {_S11_PROJ[-1]} tasmax "
            f"{_s11_r['variables']['tasmax']['summary'][_S11_PROJ[-1]]['mean']:+.2f} K, tasmin "
            f"{_s11_r['variables']['tasmin']['summary'][_S11_PROJ[-1]]['mean']:+.2f} K")

    # shared context of all scenarios
    _s11_state_now = _s11_state(_S11_NOW)
    _s11_era5, _s11_era5_frames = _s11_era5_climatology()
    _s11_now_fracs = {f: _s11_cells(FEATURE_GRIDS[_S11_NOW][f]).astype(np.float64) for f in _S11_FRACS}
    _s11_design_now = _s11_lc_design(_s11_state_fracs(_s11_state_now))
    _S11_CTX = {"state_now": _s11_state_now, "suit": _S11_SUIT, "era5": _s11_era5, "now_fracs": _s11_now_fracs,
                "h_models": _S11_H_MODELS,
                "h_now": {t: (_S11_H_MODELS[t].inplace_predict(_s11_design_now).astype(np.float64)
                              if _S11_H_MODELS.get(t) is not None else None) for t in _S11_H_TARGETS},
                "x_now": {t: _s11_cells(FEATURE_GRIDS[_S11_NOW][t]).astype(np.float64) for t in _S11_H_TARGETS},
                "draws": _s11_draws()}
    _s11_x_base = _s11_features(_s11_state_now, _S11_CTX)
    _S11_CTX["a_base"] = {m: _s11_predict(m, _s11_x_base) for m in _S11_MODES}
    # Consistency check: the 2025 baseline features reproduce the observed 2025 features except ERA5 (climatology).
    _s11_obs_now = FEATURE_MATRIX(FEATURE_GRIDS[_S11_NOW])
    _s11_non_era5 = [i for i, f in enumerate(FEATURES) if f not in _S11_ERA5]
    _s11_dev = np.nanmax(np.abs(_s11_x_base[:, _s11_non_era5] - _s11_obs_now[:, _s11_non_era5]))
    if not _s11_dev < 1e-3:
        raise AssertionError(f"11: the 2025 projected features differ from the observed ones by {_s11_dev:.3g}")
    del _s11_obs_now, _s11_x_base
    _S11_CTX["l_base"] = {m: _s11_l_base(m) for m in _S11_MODES}
    for _m, _b in _S11_CTX["l_base"].items():
        _s11_tr = ("" if _b["trend_slope_per_decade"] is None else
                   f"; ERA5 trend {_b['trend_slope_per_decade']:+.3f} °C/decade over {len(_b['trend_years'])} years")
        log(f"11: {_m} baseline L_base = {_b['l_base']:.2f} °C (observed {_b['level_now']:.2f}, weather anomaly "
            f"{_b['weather_anomaly_c']:+.3f} °C x beta {_b['beta']:.2f}{_s11_tr}; {_b['method']})")

    _s11_land_fp = _s11_land_fingerprint()
    # The land stage executes COMPUTE_DI (section 07) and ASSIGN_ZONES / grouped SHAP inputs (section 08), so their
    # code identity is part of its key (D4); without section_code_hash (older 00) both are None.
    _s11_sch = globals().get("section_code_hash")
    _s11_code07 = _s11_sch("07") if _s11_sch is not None else None
    _s11_code08 = _s11_sch("08") if _s11_sch is not None else None
    _S11_LAND_INFO = {}
    for _s11_s in _S11_SCEN:
        _s11_key = CFG.key("N_LAND_REAL", "SEED", "FRAMES_PROJ", version=_S11_VERSION, scenario=_s11_s,
                           land=_s11_land_fp, suit=_S11_SUIT_INFO["auc_train"], eps=_S11_EPS_SIGMA,
                           code07=_s11_code07, code08=_s11_code08)
        with timer(f"11_land_{_s11_s}"):
            _s11_land = stage_cache(f"11_land_{_s11_s}", _s11_key).get_or_compute(
                lambda s=_s11_s: _s11_land_scenario(s, _S11_CTX))
        _S11_LAND_INFO[_s11_s] = {"medoid": _s11_land["medoid"], "donor_shares": _s11_land["donor_shares"],
                                  "shortfall_km2": _s11_land["shortfall_km2"], "seconds": _s11_land["seconds"],
                                  "u_mean": {int(y): float(_s11_land["U"][:, j].mean())
                                             for j, y in enumerate(_S11_PROJ)}}
        PROJ_DRIVER_SUMMARY[_s11_s] = _s11_land["driver"]
        for _m in _S11_MODES:
            with timer(f"11_mc_{_s11_s}_{_m}"):
                _q, _fl, _ser, _dec, _bud, _thr, _meta = _s11_monte_carlo(_s11_s, _m, _s11_land, _S11_CTX)
            PROJ_QUANTILES.setdefault(_m, {})[_s11_s] = _q
            PROJ_FLAGS.setdefault(_m, {})[_s11_s] = _fl
            PROJ_ZONES.setdefault(_m, {})[_s11_s] = np.asarray(_s11_land["zones"][_m], np.uint8)
            PROJ_SERIES.setdefault(_m, {})[_s11_s] = _ser
            PROJ_DECOMPOSITION.setdefault(_m, {})[_s11_s] = _dec
            PROJ_UNCERTAINTY.setdefault(_m, {})[_s11_s] = _bud
            PROJ_THRESHOLD_YEARS.setdefault(_m, {})[_s11_s] = _thr
            PROJ_META.setdefault(_m, {})[_s11_s] = {
                **_meta, "frames": list(_S11_PROJ), "method": CMIP6_DELTAS["scenarios"][_s11_s]["method"],
                "pct_outside_aoa": {int(y): float(np.mean(_s11_land["di"][_m][j] > AOA[_m]["threshold"]))
                                    for j, y in enumerate(_S11_PROJ)},
                "shap_group_mean": {int(y): _s11_land["shap_mean"][_m][j] for j, y in enumerate(_S11_PROJ)},
                "note": _S11_NOTE, "omitted_feedbacks": list(_S11_OMITTED)}
            _ncr, _dl = _ser["ncr"][-1], _dec[_S11_PROJ[-1]]
            log(f"11: {_s11_s} {_m}: NCR {_ncr['year']} p50 {_ncr['p50']:.2f} °C [{_ncr['p05']:.2f}, {_ncr['p95']:.2f}]"
                f"; vs baseline {_dl['baseline_c']:.2f} °C: climate {_dl['climate']:+.2f}, land {_dl['land']:+.2f}, "
                f"total {_dl['total']:+.2f} °C; budget "
                + ", ".join(f"{k} {_bud[_S11_PROJ[-1]][k]:.2f}" for k in ("gcm", "sensitivity", "land", "model"))
                + f"; model error {_meta['model_error']['samples']} rho {_meta['model_error']['rho']:.2f}"
                + f"; thresholds {_thr['ncr']}")
            del _q, _fl
        del _s11_land
        free_memory()

    # GHSL-2030 demand comparison (SPEC §4.9: report the GHSL-2030 demand alongside the SSP demand)
    _s11_ghsl = (FUTURE_INPUTS.get("ghsl_2030") or {}).get("built")
    _s11_ghsl_cmp = None
    if _s11_ghsl is not None and 2030 in _S11_PROJ:
        _s11_gc = np.nan_to_num(np.asarray(_s11_ghsl, np.float64)[CELL_ROWS, CELL_COLS], nan=0.0)
        _s11_ghsl_cmp = {"ncr_ghsl_2030_km2": float(_s11_gc.sum() * _S11_CELL_KM2),
                         "ncr_2025_km2": float(_s11_state_now["u"].sum() * _S11_CELL_KM2),
                         "ncr_demand_2030_km2": {s: PROJ_DRIVER_SUMMARY[s][2030]["ncr"]["demand_km2"]
                                                 for s in _S11_SCEN}}
        for _s11_s in _S11_SCEN:
            for _d, _idx in _S11_DIST_CELLS.items():
                PROJ_DRIVER_SUMMARY[_s11_s][2030][_d]["ghsl_2030_km2"] = float(_s11_gc[_idx].sum() * _S11_CELL_KM2)
            PROJ_DRIVER_SUMMARY[_s11_s][2030]["ncr"]["ghsl_2030_km2"] = _s11_ghsl_cmp["ncr_ghsl_2030_km2"]
    for _s11_s in _S11_SCEN:
        PROJ_DRIVER_SUMMARY[_s11_s]["baseline"] = {
            **{d: {"name": _S11_DIST_NAME.get(d, str(d)),
                   "built_km2": float(_s11_state_now["u"][idx].sum() * _S11_CELL_KM2),
                   "built_frac": float(_s11_state_now["u"][idx].mean()),
                   "pop": float(_s11_state_now["pop"][idx].sum() * _S11_CELL_KM2)}
               for d, idx in _S11_DIST_CELLS.items()},
            "ncr": {"name": "Delhi NCR", "year": _S11_NOW,
                    "built_km2": float(_s11_state_now["u"].sum() * _S11_CELL_KM2),
                    "built_frac": float(_s11_state_now["u"].mean()),
                    "pop": float(_s11_state_now["pop"].sum() * _S11_CELL_KM2)}}

    LAND_MODEL_METRICS = {
        "available": True, "fom": None, "fom_null": None, "quantity_disagreement": None,
        "allocation_disagreement": None, "rmse_du": None, "rmse_du_null": None, "corr_du": None,
        "corr_du_null": None, "checks": [], "verdict": None, "hindcast_truth": None, **_S11_HIND,
        "suitability": _S11_SUIT_INFO, "derived_predictors": _S11_H_REPORT, "derived_frames": _S11_H_FRAMES,
        "era5_climatology_frames": _s11_era5_frames,
        "allocation": {"rule": "du_i = min(cap_i, k_d * S_i * N_i * eps_i), k_d by bisection; cap = 1 - u - forest "
                               "- water (forest and water protected); donors cropland, barren, other vegetation in "
                               "proportion to their current shares", "eps": f"LogNormal(0, {_S11_EPS_SIGMA})",
                       "neighbourhood": "3x3 mean of u", "n_realisations": int(CFG.N_LAND_REAL)},
        "projected_donor_shares": {s: i["donor_shares"] for s, i in _S11_LAND_INFO.items()},
        "shortfall_km2": {s: i["shortfall_km2"] for s, i in _S11_LAND_INFO.items()},
        "medoid_realisation": {s: i["medoid"] for s, i in _S11_LAND_INFO.items()},
        "ghsl_2030_comparison": _s11_ghsl_cmp, "seconds": round(_s11_time.perf_counter() - _S11_T0, 1)}
    CMIP6_DELTAS["l_base"] = _S11_CTX["l_base"]
    free_memory()

# %% [markdown]
# ## 11.9 Planted vs recovered (synthetic) and the scenario-ordering check

# %%
def _s11_report():
    rows = []
    last = _S11_PROJ[-1]
    for m in _S11_MODES:
        vals = {s: PROJ_SERIES[m][s]["ncr"][-1]["p50"] for s in _S11_SCEN if s in PROJ_SERIES.get(m, {})}
        ordered = all(vals[a] < vals[b] for a, b in zip(_S11_SCEN, _S11_SCEN[1:]) if a in vals and b in vals)
        rows.append({"check": f"{m}: NCR p50 {last} ordered {' < '.join(_S11_SCEN)}",
                     "value": ", ".join(f"{s} {v:.2f}" for s, v in vals.items()), "ok": ordered})
        if not ordered:
            log(f"11: {m}: NCR p50 {last} is not ordered by scenario forcing: {vals}", "WARNING")
    # land-model plausibility vs the proportional-growth null, one row per metric (D18)
    for c in LAND_MODEL_METRICS.get("checks") or []:
        v, n0 = c.get("value"), c.get("null")
        rows.append({"check": f"land hindcast {c['check']} (proportional growth)",
                     "value": (f"{v:.4f} vs {n0:.4f}" if v is not None and n0 is not None else "n/a"),
                     "ok": c.get("ok")})
    if LAND_MODEL_METRICS.get("verdict") is not None:
        rows.append({"check": "land hindcast verdict", "value": f"{LAND_MODEL_METRICS['verdict']} (truth: "
                                                                f"{LAND_MODEL_METRICS.get('hindcast_truth')})",
                     "ok": LAND_MODEL_METRICS["verdict"] == "beats_null"})
    truth = SYNTHETIC_TRUTH if DATA_MODE == "synthetic" and isinstance(SYNTHETIC_TRUTH, dict) else None
    if truth:
        planted = ((truth.get("future") or {}).get("cmip6_delta_2050") or {})
        for s, by_var in planted.items():
            rec = CMIP6_DELTAS["scenarios"].get(s)
            if rec is None:
                continue
            for var, st in by_var.items():
                got = rec["variables"][var]["summary"][last]["mean"]
                # the planted summary is rounded to 3 dp (section 02), so agreement means |diff| <= 0.0005 K
                rows.append({"check": f"CMIP6 {s} {var} delta {last} (planted ensemble mean)",
                             "value": f"{got:+.3f} vs planted {st['mean']:+.3f}",
                             "ok": bool(abs(got - float(st["mean"])) <= 5e-4 + 1e-9)})
        for m in _S11_MODES:
            b = (truth.get("beta") or {}).get(m, {}).get("value")
            if b is not None:
                rows.append({"check": f"beta {m} used (planted {b})",
                             "value": f"{CLIMATE_SENSITIVITY[m]['beta']:.3f}", "ok": None})
    print("Section 11 checks (planted vs recovered / plausibility):")
    print(pd.DataFrame(rows).to_string(index=False))
    return rows


if _S11_ACTIVE:
    _S11_REPORT = _s11_report()

# %% [markdown]
# ## 11.10 Figures: land hindcast, NCR fan charts, uncertainty budget

# %%
def _s11_save_fig(fig, name):
    fig.savefig(_S11_FIG_DIR / name, dpi=140, bbox_inches="tight")
    plt.show()
    plt.close(fig)


def _s11_fig_hindcast():
    if not _S11_HIND_MAPS:
        return
    fig, axes = plt.subplots(1, 3, figsize=(15, 5))
    titles = (f"observed du {LAND_MODEL_METRICS['period'][0]}-{LAND_MODEL_METRICS['period'][1]}",
              f"CA realisation 0 (FoM {LAND_MODEL_METRICS['fom']:.2f})",
              f"null: du ~ u (FoM {LAND_MODEL_METRICS['fom_null']:.2f})")
    vmax = max(0.1, float(np.nanpercentile(_S11_HIND_MAPS["du_obs"], 99.5)))
    for ax, key, title in zip(axes, ("du_obs", "du_sim", "du_null"), titles):
        im = ax.imshow(_s11_grid(_S11_HIND_MAPS[key]), cmap="magma", vmin=0, vmax=vmax)
        ax.set_title(title)
        ax.set_xticks([])
        ax.set_yticks([])
    fig.colorbar(im, ax=axes, shrink=0.8, label="built-up fraction change")
    _s11_save_fig(fig, "11_land_hindcast.png")


def _s11_fig_fans():
    colors = {"ssp126": "#22c55e", "ssp245": "#f59e0b", "ssp585": "#ef4444"}
    fig, axes = plt.subplots(1, len(_S11_MODES), figsize=(7 * len(_S11_MODES), 4.5), squeeze=False)
    for ax, m in zip(axes[0], _S11_MODES):
        obs_y = sorted(LEVELS[m])
        ax.plot(obs_y, [LEVELS[m][y]["level"] for y in obs_y], "ko-", ms=4, label="observed level")
        lb = _S11_CTX["l_base"][m]["l_base"]
        ax.axhline(lb, color="0.5", lw=0.8, ls=":")
        for s in _S11_SCEN:
            rows = PROJ_SERIES[m][s]["ncr"]
            yrs = [_S11_NOW] + [r["year"] for r in rows]
            get = {k: [lb] + [r[k] for r in rows] for k in _S11_QK}
            c = colors.get(s, None)
            ax.fill_between(yrs, get["p05"], get["p95"], color=c, alpha=0.15)
            ax.fill_between(yrs, get["p25"], get["p75"], color=c, alpha=0.3)
            ax.plot(yrs, get["p50"], color=c, lw=2, label=s)
        ax.set_title(f"{m}: NCR mean LST ({_S11_NOTE})")
        ax.set_ylabel("°C")
        ax.legend(fontsize=8)
    _s11_save_fig(fig, "11_projection_fans.png")


def _s11_fig_budget():
    last = _S11_PROJ[-1]
    keys = ["gcm", "sensitivity", "land", "model"]
    colors = ["#60a5fa", "#f472b6", "#a3e635", "#94a3b8"]
    labels = [f"{m}\n{s}" for m in _S11_MODES for s in _S11_SCEN]
    vals = np.array([[PROJ_UNCERTAINTY[m][s][last][k] for k in keys] for m in _S11_MODES for s in _S11_SCEN])
    fig, ax = plt.subplots(figsize=(1.4 * len(labels) + 2, 4))
    bottom = np.zeros(len(labels))
    for i, k in enumerate(keys):
        ax.bar(labels, vals[:, i], bottom=bottom, color=colors[i], label=k)
        bottom += vals[:, i]
    ax.set_ylabel(f"share of variance of the NCR mean ({last})")
    ax.legend(ncol=4, fontsize=8)
    _s11_save_fig(fig, "11_uncertainty_budget.png")


if _S11_ACTIVE:
    for _s11_fn in (_s11_fig_hindcast, _s11_fig_fans, _s11_fig_budget):
        try:
            _s11_fn()
        except Exception as _s11_exc:  # noqa: BLE001 - a broken figure must never lose the computed results
            log(f"11: figure {_s11_fn.__name__} failed: {type(_s11_exc).__name__}: {_s11_exc}", "WARNING")
            plt.close("all")

# %% [markdown]
# ## 11.11 Tables and contract check (SPEC §3.8)

# %%
def _s11_save_tables():
    rows = []
    for m, by_s in PROJ_SERIES.items():
        for s, by_scope in by_s.items():
            for sid, recs in by_scope.items():
                for r in recs:
                    rows.append({"mode": m, "scenario": s, "scope": sid, **r})
    if not rows:
        return
    out = Path(CFG.PARQUET_DIR)
    out.mkdir(parents=True, exist_ok=True)
    try:
        pd.DataFrame(rows).to_parquet(out / "projection_series.parquet", index=False)
    except Exception as exc:  # noqa: BLE001 - parquet engine missing -> CSV
        log(f"11: parquet unavailable ({exc!r}); writing CSV", "WARNING")
        pd.DataFrame(rows).to_csv(out / "projection_series.csv", index=False)


def _s11_contract_check():
    n_y = len(_S11_PROJ)
    for m in _S11_MODES:
        assert set(PROJ_QUANTILES[m]) == set(_S11_SCEN), (m, sorted(PROJ_QUANTILES[m]))
        for s in _S11_SCEN:
            q = PROJ_QUANTILES[m][s]
            assert list(q) == _S11_QK
            for k in _S11_QK:
                assert q[k].shape == (n_y, _S11_NC) and q[k].dtype == np.float32, (m, s, k, q[k].shape)
                assert np.isfinite(q[k]).all(), f"{m} {s} {k}: non-finite projected quantiles"
            for a, b in zip(_S11_QK, _S11_QK[1:]):
                assert np.all(q[a] <= q[b] + 1e-5), f"{m} {s}: quantiles not monotone ({a} > {b})"
            fl, zn = PROJ_FLAGS[m][s], PROJ_ZONES[m][s]
            assert fl.shape == (n_y, _S11_NC) and fl.dtype == np.uint8 and int(fl.max()) <= 7
            assert zn.shape == (n_y, _S11_NC) and zn.dtype == np.uint8
            assert set(np.unique(zn).tolist()) <= {0, 1, 2, 3, _S11_ZONE_NODATA}
            for sid, recs in PROJ_SERIES[m][s].items():
                assert [r["year"] for r in recs] == _S11_PROJ, (m, s, sid)
                for r in recs:
                    if r["p50"] is not None:
                        assert r["p05"] <= r["p25"] <= r["p50"] <= r["p75"] <= r["p95"], (m, s, sid, r)
                assert set(PROJ_THRESHOLD_YEARS[m][s][sid]) == {"+1", "+2", "+3"}
            for y in _S11_PROJ:
                dec, bud = PROJ_DECOMPOSITION[m][s][y], PROJ_UNCERTAINTY[m][s][y]
                assert {"climate", "land", "total", "baseline_c"} <= set(dec), (m, s, y)
                parts = [bud[k] for k in ("gcm", "sensitivity", "land", "model")]
                assert abs(sum(parts) - 1.0) < 1e-6 or sum(parts) == 0.0, (m, s, y, parts)
    # Decomposition identity (D14): every draw's scope mean = baseline_c + climate + land + error, so the median's
    # distance from the scope's own baseline must be close to the sum of the parts for EVERY scope.
    gaps = []
    for m in _S11_MODES:
        for s in _S11_SCEN:
            for y in _S11_PROJ:
                for sid, d in (PROJ_DECOMPOSITION[m][s][y].get("by_scope") or {}).items():
                    assert "baseline_c" in d, (m, s, y, sid)
                    gap = abs(d["total"] - d["climate"] - d["land"] - d["model_error_mean"])
                    gaps.append((gap, m, s, y, sid))
    gaps.sort(reverse=True)
    bad = [g for g in gaps if not g[0] < _S11_DECOMP_TOL_C]
    if bad:
        msg = (f"11: decomposition total deviates from climate + land + model error by >= {_S11_DECOMP_TOL_C} °C "
               f"for {len(bad)} scope-frames; worst: "
               + "; ".join(f"{m} {s} {y} {sid} {g:.3f}" for g, m, s, y, sid in bad[:8]))
        if DATA_MODE == "synthetic":
            raise AssertionError(msg)
        log(msg, "WARNING")
    elif gaps:
        log(f"11: decomposition identity OK: max |total - climate - land - model error| {gaps[0][0]:.3f} °C "
            f"({gaps[0][1]} {gaps[0][2]} {gaps[0][3]} {gaps[0][4]})")
    for s in _S11_SCEN:
        assert CMIP6_DELTAS["scenarios"][s]["method"] in ("gcm", "pattern-scaled")
        assert set(PROJ_DRIVER_SUMMARY[s]) >= set(_S11_PROJ)
    assert "fom" in LAND_MODEL_METRICS and "fom_null" in LAND_MODEL_METRICS
    # Section 10 fixed the per-mode raster/colour domain from the observed fields padded by 3 °C, precisely so that
    # projected fields never clip; verify that promise on the projected medians (p0.5-p99.5, as for the domain).
    domains = (RASTER_INDEX or {}).get("domains") or {}
    for m in _S11_MODES:
        if m not in domains:
            continue
        vals = np.concatenate([PROJ_QUANTILES[m][s]["p50"].ravel() for s in _S11_SCEN]).astype(np.float64)
        lo, hi = (float(v) for v in np.percentile(vals, [0.5, 99.5]))
        d_lo, d_hi = (float(v) for v in domains[m])
        inside = d_lo <= lo and hi <= d_hi
        log(f"11: {m}: projected p50 p0.5-p99.5 [{lo:.2f}, {hi:.2f}] °C vs raster domain [{d_lo:g}, {d_hi:g}] "
            + ("(inside)" if inside else "- OUTSIDE: projected rasters would clip"), "INFO" if inside else "WARNING")
    log("11: contract check OK (PROJ_QUANTILES, PROJ_FLAGS, PROJ_ZONES, PROJ_SERIES, decomposition, budget, "
        "thresholds, CMIP6_DELTAS, LAND_MODEL_METRICS, PROJ_DRIVER_SUMMARY)")


if _S11_ACTIVE:
    _s11_save_tables()
    _s11_contract_check()
    del _S11_CTX["era5"]
    free_memory()
log("Section 11 complete: LAND_MODEL_METRICS, PROJ_QUANTILES, PROJ_FLAGS, PROJ_ZONES, PROJ_SERIES, "
    "PROJ_DECOMPOSITION, PROJ_UNCERTAINTY, PROJ_THRESHOLD_YEARS, CMIP6_DELTAS, PROJ_DRIVER_SUMMARY, PROJ_META ready"
    + ("" if _S11_ACTIVE else " (empty: projections skipped)"))
