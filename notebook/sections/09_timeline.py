# %% [markdown]
# # 9. Timeline 1990–2025: absolute levels, evidence tiers, frame fields, night hindcast, dLST/dTair and trends
#
# Sections 06–08 work in **anomalies** (each frame centred to zero over the mode's fixed mask). This section restores
# absolute °C and attaches an evidence tier and an uncertainty to every number the timeline shows.
#
# ## 9.1 Levels $L_m(t)$ (SPEC §4.7)
# * **Day.** Landsat scenes are acquired between ~09:15 and ~10:50 IST depending on sensor and orbit drift, and the
#   pre-monsoon surface warms by ~3 K h⁻¹ at that time, so a raw composite of early scenes is several tenths of a degree
#   too cold. The level is corrected to the 10:45 IST reference overpass:
#   $L_{day}(t) = \bar T^{raw}_{FIXED}(t) + (10.75 - \bar h_t)\,\dot T_t$ with $\bar h_t$ the mean scene time (IST hours)
#   and $\dot T_t$ the ERA5-Land skin-temperature heating rate between 09:30 and 11:30 IST of the frame's window
#   (`FRAME_META[t]["day"]`). Interval: $\pm(0.25\,|c_t| + 0.3)$ °C (documented heuristic: a quarter of the correction
#   for the heating-rate/overpass uncertainty plus 0.3 °C for the Landsat ST level). The day frame field is the raw
#   fine-pixel mean + the same correction (anomalies are unaffected). `DAY_LEVEL_CHECK` compares the corrected level
#   with the independent MODIS Terra fixed-mask mean (2000–2020): a constant offset (algorithm/time-of-day difference)
#   is expected, a frame-to-frame scatter is not.
# * **Night, observed/reconstructed.** $L_{night}(t)$ = the fixed-mask mean of the Aqua-equivalent target (2000 =
#   Terra 22:30 calibrated to Aqua). Interval ±0.3 °C (observed Aqua), ±(0.3 + 0.5·RMSE$_{cal}$) for calibrated sensors.
# * **Night 1990/1995 (modelled).** No night product exists. The annual NCR-mean night LST (Aqua 2003–2021, VIIRS
#   calibrated 2022–2025) is regressed on ERA5-Land's 20 UTC skin temperature (OLS, leave-one-year-out RMSE). The
#   window-mean prediction is tied to the fixed-mask level definition by a time-dependent offset
#   $o(t) = \bar\delta + \hat d\,(t_{mid} - \bar t_{mid})$: $\bar\delta$ = mean frame-level residual over the observed
#   frames and $\hat d$ = the **residual drift**, the OLS slope of the annual regression residuals over the years of
#   the *primary* sensor only (night: Aqua 2003–2021, so the VIIRS calibration step cannot pose as drift), applied
#   only when $|\hat d| > 2\,se(\hat d)$ on at least 10 primary-sensor years spanning at least 10 years — ERA5 does
#   not see the land-driven warming of the night level by
#   urbanisation, so a level extrapolated 25 years back would otherwise be too warm. The same $o(t)$ produces the
#   `regression_check` of the observed frames. 90 % prediction interval
#   $t_{0.95,n-2}\sqrt{s^2/k + s^2 x_0^\top(X^\top X)^{-1}x_0 + \mathrm{Var}(\delta)(1+1/n_f) + (\Delta t)^2 se_{drift}^2}$
#   ($k$ window years; $\Delta t$ years from the regression period's mean year,
#   $se_{drift} = s/\sqrt{\sum (t-\bar t)^2}$).
#   *Known limitation:* the primary record is short (19 Aqua years), so a real residual drift of ~0.015–0.02 °C/yr
#   can stay just below the 2-se gate and is then not applied; the 1990/1995 levels then keep a warm bias of about
#   $|\hat d|\,\Delta t$ (+0.26/+0.40 °C on the synthetic world, drift 0.0174 ± 0.0092 °C/yr = 1.9 se; both levels
#   stay inside their prediction intervals). The WARNING log and the modelled frames' `method` text report
#   $\hat d \pm se$ and the shift the drift would have made ($\hat d\,\Delta t$), and the reconstructed 2000 frame's
#   `regression_check` error shows how well the offset carries back in time.
#   The field is the recentred model hindcast + the persistent residual + the level, with per-cell p05/p95 = field ∓
#   √(q90² + level half-width²), q90 = the projection-setting conformal |residual| q90 of the cell's AOA-DI decile
#   (section 07: LOEO + persistent residual — a known place at another time; block20 q90 as fallback).
# * **Composition correction (all non-modelled frames).** A raw level is the mean over the FIXED_MASK cells valid at
#   that frame. When a frame covers < 99.9 % of the mask (`FIXED_MASK_COVERAGE`), the missing cells' anomaly is
#   taken from the model, $a$ = final-model anomaly (not recentred) + persistent residual:
#   $c_t = \overline{a}_{FIXED} - \overline{a}_{FIXED \wedge valid_t}$, level = raw (+ overpass correction) + $c_t$,
#   half-width $\sqrt{hw^2 + (c_t/2)^2}$. All levels then refer to the same cell set; the frame field itself stays the
#   observation. A day frame never becomes `modelled`: a day frame without a fixed-mask level stops the section.
#
# ## 9.2 Evidence tiers (computed from `FRAME_META`, SPEC §1.2)
# Day: `observed-sparse` when any of the five WRS-2 path/rows has < 6 clear scenes in the window, else `observed`
# (never `modelled`: a day frame without a fixed-mask level is an acquisition fault and stops the section).
# Night: `observed` for Aqua/VIIRS, `reconstructed` for calibrated Terra, `modelled` without a night product.
# Projection frames are `projected`.
#
# ## 9.3 Hindcast checks
# * **Night 2000:** the night model was trained on 2005–2025 only, so its recentred prediction of 2000 vs the
#   Terra-reconstructed observation is a genuine out-of-period test; reference = persistence (the 2005 anomaly).
# * **Day "train late, predict early":** a model with the final recipe on 2005–2025 predicts 1990/1995/2000
#   (recentred), again against persistence of 2005 — this mimics the night hindcast for a mode where the truth exists.
#
# ## 9.4 Climate sensitivity β = dLST/dT_air (SPEC §4.7)
# Year-to-year variation of the NCR-mean satellite LST against ERA5-Land air temperature (day: MODIS Terra 2003–2020
# on Tmax; night: Aqua 2003–2021 + VIIRS 2022–2025 on Tmin), with top-soil moisture as co-regressor so that dry years
# do not inflate β. OLS coefficient of temperature; uncertainty from a **moving-block bootstrap** (3-year blocks,
# 2000 draws — preserves the short-range autocorrelation of annual anomalies); Theil–Sen univariate slope alongside.
# The draws feed the Monte-Carlo projections (section 11).
#
# ## 9.5 Trends and frame statistics
# Theil–Sen slope per decade of the frame levels (observed/reconstructed tiers only) with a Monte-Carlo interval
# that propagates the level intervals; Theil–Sen (95 % CI) of the annual ERA5-Land and satellite series. Per scope
# (NCR, 25 districts, zones of the mode): mean (NCR: the frame **level** and its CI — fixed mask, composition
# consistent; districts and zones: mean of their valid cells with the level's half-widths), p90, hot-core area (LST ≥
# the mode's reference-period 2000–2020 p90, fixed; the share of valid scope cells above it × the scope's cell count,
# so a cloud gap does not shrink the area — unbiased for scattered gaps, while a spatially contiguous gap over a
# cooler or hotter part of the scope moves the area by the difference of the hidden and the visible hot share, e.g.
# +11 % to −36 % for 10 % strips in the synthetic tests; every row exports `coverage` and rows below 0.9 are logged),
# the **signed** surface UHI (mean over cells with built ≥ 0.5 minus cells
# with built ≤ 0.05 and water < 0.2), the number of valid cells, `coverage` (valid / scope cells) and the tier.

# %%
import math as _s09_math
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from scipy import stats as _s09_stats

_S09_VERSION = "09-v2.1"
_S09_FRAMES = sorted(int(y) for y in np.unique(DF["year"].to_numpy()))
_S09_NC = int(N_CELLS)
_S09_REF_H = float(CFG.DAY_REFERENCE_OVERPASS_IST_H)
_S09_TIERS = ["observed", "observed-sparse", "reconstructed", "modelled", "projected"]
_S09_MIN_SCENES = 6
_S09_Z90 = float(_s09_stats.norm.ppf(0.95))
_S09_NIGHT_OBS_HW = 0.3
_S09_CAL_HW_FACTOR = 0.5
_S09_MC_DRAWS = 2000
_S09_BETA_DRAWS = 2000
_S09_BETA_BLOCK = 3
_S09_REF_PERIOD = tuple(int(v) for v in CFG.REFERENCE_PERIOD)
_S09_TEMP_VAR = {"day": "era5_tmax", "night": "era5_tmin"}
_S09_SKIN_VAR = {"day": "era5_skin_day", "night": "era5_skin_night"}
_S09_DRIFT_MIN_YEARS = 10           # a residual drift is applied only on at least this many years / this span
# Satellite annual series per mode (variable, first year, last year) - SPEC §4.7 / §5.4.
_S09_BETA_SAT = {"day": [("modis_terra_day", 2003, 2020)],
                 "night": [("modis_aqua_night", 2003, 2021), ("viirs_night_cal", 2022, 2025)]}
_S09_LEVEL_SAT = {"day": [("modis_terra_day", 2003, 2021)],
                  "night": [("modis_aqua_night", 2003, 2021), ("viirs_night_cal", 2022, 2025)]}
_S09_SENSOR_LABEL = {"modis_terra_day": "MODIS Terra", "modis_aqua_night": "MODIS Aqua",
                     "viirs_night_cal": "VIIRS (Aqua-calibrated)"}
_S09_MODES = [m for m in CFG.MODES if m in FINAL_MODELS]
_S09_RES_KM2 = float(GRID.cell_area_km2)
if len(DF) != len(_S09_FRAMES) * _S09_NC:
    raise RuntimeError("09: DF is not the (frame x canonical cell) table of section 06")
log(f"09: modes {_S09_MODES}, frames {_S09_FRAMES}, reference overpass {_S09_REF_H:.2f} h IST, reference period "
    f"{_S09_REF_PERIOD}")


def _s09_slice(year):
    j = _S09_FRAMES.index(int(year))
    return slice(j * _S09_NC, (j + 1) * _S09_NC)


def _s09_col(name, year):
    """DF column ``name`` of one frame (canonical cell order) as float64."""
    return DF[name].to_numpy(np.float64)[_s09_slice(year)]


def _s09_fixed_cells(mode):
    """Bool (N_CELLS,) - canonical cells inside FIXED_MASK[mode]."""
    return np.asarray(FIXED_MASK[mode], bool)[CELL_ROWS, CELL_COLS]


def _s09_annual(variable, scope="ncr"):
    """pd.Series (year -> value) of one ANNUAL_SERIES variable and scope (empty when absent)."""
    sub = ANNUAL_SERIES[(ANNUAL_SERIES["variable"] == variable) & (ANNUAL_SERIES["scope"] == scope)]
    s = pd.Series(sub["value"].to_numpy(np.float64), index=sub["year"].to_numpy(np.int64))
    return s[~s.index.duplicated()].sort_index()


def _s09_annual_flags(variable, scope="ncr"):
    sub = ANNUAL_SERIES[(ANNUAL_SERIES["variable"] == variable) & (ANNUAL_SERIES["scope"] == scope)]
    return dict(zip(sub["year"].astype(int), sub["flag"]))


def _s09_sat_series(mode, ranges, scope="ncr", drop_drift=False):
    """Combined satellite series of a mode over ``ranges`` [(variable, y0, y1)] -> (Series, sensor per year)."""
    vals, sensor = {}, {}
    for var, y0, y1 in ranges:
        s = _s09_annual(var, scope)
        flags = _s09_annual_flags(var, scope)
        for y, v in s.items():
            if y0 <= y <= y1 and np.isfinite(v) and not (drop_drift and flags.get(int(y)) == "drift"):
                vals[int(y)] = float(v)
                sensor[int(y)] = var
    s = pd.Series(vals, dtype=np.float64).sort_index()
    return s, sensor


# %% [markdown]
# ## 9.6 Evidence tiers (`FRAME_TIERS`)

# %%
def _s09_tier(mode, year):
    meta = FRAME_META.get(int(year)) or {}
    raw_level = RAW_LEVELS.get(mode, {}).get(int(year), float("nan"))
    if mode == "day":
        if not np.isfinite(raw_level):
            # D9: an observed day frame is always observed or observed-sparse; no fixed-mask level means the
            # acquisition (section 03) or the masks (section 06) failed for this frame
            raise RuntimeError(
                f"09: day frame {int(year)} has no finite fixed-mask level (RAW_LEVELS['day'][{int(year)}] = "
                f"{raw_level}); its valid cells do not overlap FIXED_MASK['day']. Day frames are never modelled - "
                "check the section-03 coverage of this frame and the section-06 coverage table.")
        spr = (meta.get("day") or {}).get("scenes_per_pathrow") or {}
        return "observed-sparse" if spr and min(int(v) for v in spr.values()) < _S09_MIN_SCENES else "observed"
    source = (meta.get("night") or {}).get("source")
    if source is None or not np.isfinite(raw_level):
        return "modelled"
    return "reconstructed" if source == "terra_cal" else "observed"


FRAME_TIERS = {m: {int(y): _s09_tier(m, y) for y in _S09_FRAMES} for m in CFG.MODES}
for _m in CFG.MODES:
    FRAME_TIERS[_m].update({int(y): "projected" for y in CFG.FRAMES_PROJ})
log("09: tiers " + "; ".join(f"{m}: " + ", ".join(f"{y}={t}" for y, t in FRAME_TIERS[m].items()) for m in CFG.MODES))

# %% [markdown]
# ## 9.7 Levels (`LEVELS`)
# Every record keeps `raw_level` (the fixed-mask mean over the valid cells), `fixed_mask_coverage` and
# `composition_correction` (non-modelled frames; 0 when the frame covers the whole mask), and its `method` says which
# corrections were applied. Modelled frames carry `drift_correction_c` (the residual-drift part of the offset, 9.1);
# `_S09_LEVEL_REG[m]` (also `HINDCAST_METRICS[m]["level_regression"]`) records `drift_per_year`, `drift_se`,
# `drift_applied`, `drift_years` and the Theil–Sen slope of all residuals for reference.

# %%
def _s09_level_regression(mode):
    """OLS of the annual NCR satellite level on ERA5-Land skin temperature (+ LOYO RMSE); None if < 5 years."""
    y_s, sensor = _s09_sat_series(mode, _S09_LEVEL_SAT[mode])
    x_s = _s09_annual(_S09_SKIN_VAR[mode])
    years = sorted(set(y_s.index) & set(x_s.index))
    if len(years) < 5:
        log(f"09: {mode}: only {len(years)} years for the level regression", "WARNING")
        return None
    x = x_s.loc[years].to_numpy(np.float64)
    y = y_s.loc[years].to_numpy(np.float64)
    X = np.column_stack([np.ones(len(x)), x])
    coef, *_ = np.linalg.lstsq(X, y, rcond=None)
    resid = y - X @ coef
    n = len(years)
    s2 = float(resid @ resid) / max(n - 2, 1)
    xtx_inv = np.linalg.pinv(X.T @ X)            # pinv: a constant regressor must not crash the notebook
    loyo = []
    for i in range(n):
        keep = np.arange(n) != i
        c_i, *_ = np.linalg.lstsq(X[keep], y[keep], rcond=None)
        loyo.append(y[i] - X[i] @ c_i)
    sst = float(np.sum((y - y.mean()) ** 2))
    yr = np.asarray(years, np.float64)
    drift_se_pi = float(np.sqrt(s2 / np.sum((yr - yr.mean()) ** 2))) if n > 2 else 0.0
    drift_ts = float(_s09_stats.theilslopes(resid, yr)[0]) if n > 2 else 0.0
    # D10: residual drift = OLS slope (+ se) of the annual residuals over the PRIMARY sensor's years only, so a
    # calibration step between sensors (Aqua -> calibrated VIIRS) cannot pose as drift
    prim_var, p0, p1 = _S09_LEVEL_SAT[mode][0]
    prim = np.array([sensor.get(int(v)) == prim_var and p0 <= int(v) <= p1 for v in years], dtype=bool)
    drift, drift_se, drift_years = 0.0, None, [int(v) for v in yr[prim]]
    if prim.sum() >= 4:
        tp, ep = yr[prim], resid[prim]
        tc = tp - tp.mean()
        drift = float((tc @ (ep - ep.mean())) / (tc @ tc))
        e2 = ep - ep.mean() - drift * tc
        drift_se = float(np.sqrt(float(e2 @ e2) / (tp.size - 2) / float(tc @ tc)))
    # A linear drift extrapolated decades back needs a real record: with too few years a slope can pass the 2 se test
    # by chance (first real run: 5 Aqua years gave -0.24 °C/yr, a 1990 night level of 28.6 °C vs 19-21 °C observed).
    enough = bool(prim.any()) and prim.sum() >= _S09_DRIFT_MIN_YEARS and np.ptp(yr[prim]) >= _S09_DRIFT_MIN_YEARS
    if drift_se is not None and abs(drift) > 2.0 * drift_se and not enough:
        log(f"09: {mode}: residual drift {drift:+.4f} +- {drift_se:.4f} °C/yr not applied: it rests on {int(prim.sum())} "
            f"{prim_var} years (needs >= {_S09_DRIFT_MIN_YEARS} years spanning >= {_S09_DRIFT_MIN_YEARS})", "WARNING")
    applied = drift if enough and drift_se is not None and abs(drift) > 2.0 * drift_se else 0.0
    return {"a": float(coef[0]), "b": float(coef[1]), "s": float(np.sqrt(s2)), "xtx_inv": xtx_inv, "n": n,
            "year_mean": float(yr.mean()), "drift_se_per_year": drift_se_pi, "residual_drift_theil_sen": drift_ts,
            "drift_per_year": drift, "drift_se": drift_se, "drift_applied": float(applied),
            "drift_years": drift_years, "drift_sensor": prim_var,
            "years": [int(v) for v in years], "r2": 1.0 - float(resid @ resid) / sst if sst > 0 else None,
            "loyo_rmse": float(np.sqrt(np.mean(np.square(loyo)))), "t90": float(_s09_stats.t.ppf(0.95, max(n - 2, 1))),
            "x_var": _S09_SKIN_VAR[mode], "y_series": sorted(set(sensor.values()))}


def _s09_window_x(mode, year):
    """(mean ERA5 skin temperature over the frame's window years, years used)."""
    x_s = _s09_annual(_S09_SKIN_VAR[mode])
    y0, y1 = CFG.window(int(year))
    yrs = [y for y in range(int(y0), int(y1) + 1) if y in x_s.index and np.isfinite(x_s.loc[y])]
    return (float(x_s.loc[yrs].mean()) if yrs else float("nan")), yrs


def _s09_regression_level(reg, mode, year, offset, offset_var):
    """Window-mean level predicted by the regression (+ mask offset) with its 90 % prediction half-width."""
    xbar, yrs = _s09_window_x(mode, year)
    if reg is None or not np.isfinite(xbar):
        return float("nan"), float("nan"), yrs
    x0 = np.array([1.0, xbar])
    k = max(len(yrs), 1)
    w0, w1 = CFG.window(int(year))
    dt = 0.5 * (int(w0) + int(w1)) - reg["year_mean"]
    se2 = (reg["s"] ** 2 / k + reg["s"] ** 2 * float(x0 @ reg["xtx_inv"] @ x0) + offset_var
           + (dt * reg["drift_se_per_year"]) ** 2)
    return reg["a"] + reg["b"] * xbar + offset, reg["t90"] * _s09_math.sqrt(se2), yrs


def _s09_night_obs_halfwidth(year):
    source = ((FRAME_META.get(int(year)) or {}).get("night") or {}).get("source")
    if source in ("terra_cal", "viirs_cal"):
        kind = "terra_to_aqua" if source == "terra_cal" else "viirs_to_aqua"
        rmse = float((NIGHT_CALIBRATION.get(kind) or {}).get("rmse") or 0.0)
        return _S09_NIGHT_OBS_HW + _S09_CAL_HW_FACTOR * rmse, kind, rmse
    return _S09_NIGHT_OBS_HW, None, None


def _s09_t_mid(year):
    w0, w1 = CFG.window(int(year))
    return 0.5 * (int(w0) + int(w1))


def _s09_composition(mode, year):
    """(composition correction °C, FIXED_MASK coverage) of a frame's raw level (D8).

    The raw level is the mean over the FIXED_MASK cells that are valid at this frame. When they are not all valid,
    the missing cells' anomaly is taken from the model: a = final-model anomaly (not recentred) + persistent residual,
    corr = mean_FIXED(a) - mean_{FIXED & valid}(a), so raw + corr estimates the mean over the whole mask.
    """
    fixed = _s09_fixed_cells(mode)
    valid = np.isfinite(_s09_col(f"lst_{mode}", year))
    both = fixed & valid
    cov = float(both.sum()) / max(int(fixed.sum()), 1)
    if cov >= 0.999 or not both.any():
        return 0.0, cov
    X = DF[FEATURES].to_numpy(np.float32)[_s09_slice(year)]
    a = PREDICT_ANOM(mode, X).astype(np.float64)
    a = a + np.nan_to_num(np.asarray(PERSISTENT_RESID[mode], np.float64)[CELL_ROWS, CELL_COLS], nan=0.0)
    return float(np.mean(a[fixed]) - np.mean(a[both])), cov


def _s09_levels(mode):
    """LEVELS[mode] for every observed frame + the regression record."""
    out = {}
    reg = _s09_level_regression(mode)
    observed = [y for y in _S09_FRAMES if FRAME_TIERS[mode][y] in ("observed", "observed-sparse")
                and np.isfinite(RAW_LEVELS[mode].get(y, np.nan))]
    # composition corrections first: the regression offset is fitted on the corrected levels (D8)
    comp = {}
    for y in _S09_FRAMES:
        if FRAME_TIERS[mode][y] != "modelled" and np.isfinite(RAW_LEVELS[mode].get(y, np.nan)):
            comp[y] = _s09_composition(mode, y)
            if abs(comp[y][0]) > 0.2:
                log(f"09: {mode} {y}: composition correction {comp[y][0]:+.2f} °C (the frame covers "
                    f"{comp[y][1]:.1%} of the fixed mask)", "WARNING")

    def obs_level(y):
        lev = RAW_LEVELS[mode][y] + comp.get(y, (0.0, 1.0))[0]
        return lev + _s09_overpass_correction(y) if mode == "day" else lev

    resid, resid_t, resid_y = [], [], []
    if reg is not None:
        for y in observed:
            pred, _, _ = _s09_regression_level(reg, mode, y, 0.0, 0.0)
            if np.isfinite(pred):
                resid.append(obs_level(y) - pred)
                resid_t.append(_s09_t_mid(y))
                resid_y.append(y)
    offset_mean = float(np.mean(resid)) if resid else 0.0
    t_bar = float(np.mean(resid_t)) if resid_t else 0.0
    drift = float(reg["drift_applied"]) if reg is not None else 0.0

    def offset(y):
        """Mask offset at frame y: mean frame residual + the applied residual drift (D10)."""
        return offset_mean + drift * (_s09_t_mid(y) - t_bar)

    drift_se_txt = f"{reg['drift_se']:.4f}" if reg is not None and reg.get("drift_se") is not None else "n/a"
    dev = [r - offset(y) for r, y in zip(resid, resid_y)]
    # a NEW frame's level residual: Var(delta) * (1 + 1/n_f) (prediction, not confidence, interval)
    offset_var = float(np.var(dev, ddof=1) * (1.0 + 1.0 / len(dev))) if len(dev) >= 2 else 0.0
    for y in _S09_FRAMES:
        tier = FRAME_TIERS[mode][y]
        raw = RAW_LEVELS[mode].get(y, float("nan"))
        corr_c, cov = comp.get(y, (None, None))
        if cov is None:
            fixed = _s09_fixed_cells(mode)
            cov = float((fixed & np.isfinite(_s09_col(f"lst_{mode}", y))).sum()) / max(int(fixed.sum()), 1)
        rec = {"tier": tier, "raw_level": None if not np.isfinite(raw) else float(raw),
               "composition_correction": None if corr_c is None else float(corr_c), "fixed_mask_coverage": float(cov)}
        comp_txt = (f"; + composition correction {corr_c:+.3f} °C for the {1.0 - cov:.1%} of the fixed mask without "
                    "a valid target (model anomaly + persistent residual)" if corr_c else "")
        if tier == "modelled":
            level, hw, yrs = _s09_regression_level(reg, mode, y, offset(y), offset_var)
            if not np.isfinite(level):
                ref = [obs_level(t) for t in observed]
                level, hw = (float(np.mean(ref)) if ref else float("nan")), 1.5
                log(f"09: {mode} {y}: level regression unavailable; mean observed level +- 1.5 °C used", "WARNING")
                method = "fallback: mean of the observed frame levels (+-1.5 °C)"
                drift_c = None
            else:
                drift_c = float(drift * (_s09_t_mid(y) - t_bar)) if drift else 0.0   # no -0.0 in the JSON
                method = (f"OLS of annual NCR {'/'.join(reg['y_series'])} on {reg['x_var']} "
                          f"({reg['years'][0]}-{reg['years'][-1]}, n={reg['n']}), window mean of {yrs}, "
                          f"+ mask offset {offset_mean:+.3f} °C"
                          + (f" + residual drift {drift:+.4f} °C/yr x {(_s09_t_mid(y) - t_bar):+.1f} yr "
                             f"= {drift_c:+.3f} °C" if drift else
                             f" (residual drift {reg['drift_per_year']:+.4f} +- {drift_se_txt} °C/yr below 2 se, "
                             f"not applied; applied, it would move this level by "
                             f"{reg['drift_per_year'] * (_s09_t_mid(y) - t_bar):+.2f} °C)")
                          + ", 90% prediction interval")
            rec.update({"level": float(level), "ci": [float(level - hw), float(level + hw)], "method": method,
                        "overpass_correction": None, "half_width": float(hw), "window_years_used": yrs,
                        "drift_correction_c": drift_c})
        elif mode == "day":
            corr = _s09_overpass_correction(y)
            level = raw + corr + (corr_c or 0.0)
            hw = float(np.hypot(0.25 * abs(corr) + 0.3, 0.5 * (corr_c or 0.0)))
            meta = (FRAME_META.get(y) or {}).get("day") or {}
            rec.update({"level": float(level), "ci": [float(level - hw), float(level + hw)],
                        "method": ("Landsat C2 L2 ST fixed-mask mean, corrected to the 10:45 IST reference overpass"
                                   + comp_txt),
                        "overpass_correction": float(corr), "half_width": float(hw),
                        "mean_overpass_ist_h": meta.get("mean_overpass_ist_h"),
                        "heating_rate_k_per_h": meta.get("heating_rate_k_per_h")})
        else:
            hw0, kind, rmse = _s09_night_obs_halfwidth(y)
            hw = float(np.hypot(hw0, 0.5 * (corr_c or 0.0)))
            level = raw + (corr_c or 0.0)
            source = ((FRAME_META.get(y) or {}).get("night") or {}).get("source")
            rec.update({"level": float(level), "ci": [float(level - hw), float(level + hw)],
                        "method": (f"fixed-mask mean of the Aqua-equivalent night LST (source {source}"
                                   + (f", calibrated {kind}, RMSE {rmse:.2f} °C" if kind else "") + ")" + comp_txt),
                        "overpass_correction": None, "half_width": float(hw), "source": source})
        if reg is not None and tier != "modelled":
            pred, phw, _ = _s09_regression_level(reg, mode, y, offset(y), offset_var)
            rec["regression_check"] = {"predicted": float(pred), "half_width": float(phw),
                                       "error": float(rec["level"] - pred) if np.isfinite(pred) else None}
        out[y] = rec
    record = None
    if reg is not None:
        record = {k: v for k, v in reg.items() if k != "xtx_inv"}
        record.update({"mask_offset": offset_mean, "mask_offset_var": offset_var, "offset_frames": observed,
                       "offset_t_mid_mean": t_bar,
                       "offset_rule": "offset(t) = mean frame residual + drift_applied x (t_mid - offset_t_mid_mean)"})
        checks = {y: r["regression_check"]["error"] for y, r in out.items()
                  if r["tier"] == "reconstructed" and r.get("regression_check")}
        se_txt = f"{reg['drift_se']:.4f}" if reg["drift_se"] is not None else "n/a"
        log(f"09: {mode} level-regression residual drift {reg['drift_per_year']:+.4f} +- {se_txt} °C/yr over "
            f"{reg['drift_sensor']} {reg['drift_years'][:1] + reg['drift_years'][-1:]} -> "
            + (f"applied ({drift:+.4f} °C/yr)" if drift else "not applied (|drift| <= 2 se)")
            + ("; reconstructed-frame regression_check error " + ", ".join(
                f"{y}: {e:+.3f} °C" for y, e in checks.items() if e is not None) if checks else ""), "WARNING")
    return out, record


def _s09_overpass_correction(year):
    """(10.75 - mean overpass IST h) x heating rate (°C, positive for early scenes); 0 with a warning if missing."""
    meta = (FRAME_META.get(int(year)) or {}).get("day") or {}
    h, rate = meta.get("mean_overpass_ist_h"), meta.get("heating_rate_k_per_h")
    if h is None or rate is None or not (np.isfinite(h) and np.isfinite(rate)):
        log(f"09: day {year}: overpass time or heating rate missing; no overpass correction", "WARNING")
        return 0.0
    return float((_S09_REF_H - float(h)) * float(rate))


LEVELS, _S09_LEVEL_REG = {}, {}
for _m in _S09_MODES:
    LEVELS[_m], _S09_LEVEL_REG[_m] = _s09_levels(_m)
    log(f"09: {_m} levels: " + ", ".join(f"{y}={r['level']:.2f} [{r['ci'][0]:.2f}, {r['ci'][1]:.2f}]"
                                         + ("*" if r["tier"] == "modelled" else "") for y, r in LEVELS[_m].items()))
    if _S09_LEVEL_REG[_m]:
        _r = _S09_LEVEL_REG[_m]
        log(f"09: {_m} level regression: {_r['y_series']} = {_r['a']:.2f} + {_r['b']:.3f} x {_r['x_var']} "
            f"(n={_r['n']}, R2 {_r['r2']:.3f}, LOYO RMSE {_r['loyo_rmse']:.3f} °C, mask offset "
            f"{_r['mask_offset']:+.3f})")

# %% [markdown]
# ## 9.8 Frame fields, uncertainty and AOA flags
# Observed and reconstructed frames: the observed 1 km values where the target is valid (NaN elsewhere; day + the
# overpass correction). Modelled frames: the full model field. `FRAME_UNC` exists for modelled and reconstructed
# frames only (observed frames carry the observation itself).

# %%
def _s09_conformal_q90(mode, di, projection=False):
    """(|residual| q90 of each cell's AOA DI decile, error-model label) from section 07.

    ``projection=True`` (modelled frames: a known place at another time) uses the projection-setting model
    ``AOA[m]["conformal_proj"]`` (LOEO + persistent residual) when present, else the block20 conformal model.
    DI = +inf (a missing weighted feature) falls into the top decile.
    """
    proj = AOA[mode].get("conformal_proj") if projection else None
    conf = proj or AOA[mode]["conformal"]
    label = ("projection-setting (LOEO + persistent residual)" if proj else "block20 spatial-CV")
    edges = np.asarray(conf.get("edges", AOA[mode]["conformal"]["edges"]), dtype=np.float64)
    q90 = np.asarray(conf["abs_resid_quantiles"]["q90"], dtype=np.float64)
    dec = np.clip(np.searchsorted(edges, np.asarray(di, np.float64), side="right"), 0, q90.size - 1)
    return q90[dec], label


def _s09_di(mode, year):
    di = (AOA.get(mode) or {}).get("di_frames", {}).get(int(year))
    if di is None:
        di = COMPUTE_DI(mode, DF[FEATURES].to_numpy(np.float32)[_s09_slice(year)])
    return np.asarray(di, dtype=np.float64)


def _s09_modelled_field(mode, year):
    """Recentred final-model anomaly + persistent residual + level for every ROI cell (float64)."""
    X = DF[FEATURES].to_numpy(np.float32)[_s09_slice(year)]
    fixed = _s09_fixed_cells(mode)
    anom = PREDICT_ANOM(mode, X, recentre_mask=fixed).astype(np.float64)
    resid = np.nan_to_num(np.asarray(PERSISTENT_RESID[mode], np.float64)[CELL_ROWS, CELL_COLS], nan=0.0)
    return anom + resid + LEVELS[mode][year]["level"], anom, resid


def _s09_frame_fields(mode):
    fields, unc, aoa_out = {}, {}, {}
    for y in _S09_FRAMES:
        tier = FRAME_TIERS[mode][y]
        lev = LEVELS[mode][y]
        di = _s09_di(mode, y)
        aoa_out[y] = (di > float(AOA[mode]["threshold"]))         # DI = +inf (missing feature) is outside
        if tier == "modelled":
            field, _, _ = _s09_modelled_field(mode, y)
            q90, label = _s09_conformal_q90(mode, di, projection=True)
            hw = np.sqrt(q90 ** 2 + lev["half_width"] ** 2)
            unc[y] = {"p05": (field - hw).astype(np.float32), "p95": (field + hw).astype(np.float32),
                      "method": f"conformal q90 by AOA-DI decile ({label} residuals) (+) level 90% PI, in "
                                "quadrature; DI = inf (missing feature) uses the top decile"}
        else:
            obs = _s09_col(f"lst_{mode}", y)
            corr = lev["overpass_correction"] or 0.0
            field = np.where(np.isfinite(obs), obs + corr, np.nan)
            if tier == "reconstructed":
                _, kind, rmse = _s09_night_obs_halfwidth(y)
                hw = np.sqrt((_S09_Z90 * float(rmse or 0.0)) ** 2 + lev["half_width"] ** 2)
                unc[y] = {"p05": np.where(np.isfinite(field), field - hw, np.nan).astype(np.float32),
                          "p95": np.where(np.isfinite(field), field + hw, np.nan).astype(np.float32),
                          "method": (f"calibration ({kind}) RMSE x 1.645 (+) level interval, in quadrature; the "
                                     "values are calibrated observations, not model predictions")}
        fields[y] = np.asarray(field, dtype=np.float32)
    return fields, unc, aoa_out


FRAME_FIELDS, FRAME_UNC, FRAME_AOA_OUT = {}, {}, {}
with timer("09_frame_fields"):
    for _m in _S09_MODES:
        FRAME_FIELDS[_m], FRAME_UNC[_m], FRAME_AOA_OUT[_m] = _s09_frame_fields(_m)
        log(f"09: {_m} frame fields: " + ", ".join(
            f"{y}:{FRAME_TIERS[_m][y][:4]} n={int(np.isfinite(v).sum()):,} mean={np.nanmean(v):.2f}"
            for y, v in FRAME_FIELDS[_m].items()))

# %% [markdown]
# ## 9.9 Hindcast checks (`HINDCAST_METRICS`)

# %%
def _s09_metrics(obs, pred, weight=None):
    obs, pred = np.asarray(obs, np.float64), np.asarray(pred, np.float64)
    w = np.ones_like(obs) if weight is None else np.asarray(weight, np.float64)
    ok = np.isfinite(obs) & np.isfinite(pred) & (w > 0)
    if ok.sum() < 3:
        return {"r2": None, "rmse": None, "bias": None, "n": int(ok.sum())}
    o, p, w = obs[ok], pred[ok], w[ok]
    sw = w.sum()
    ob = (w * o).sum() / sw
    sse = float((w * (o - p) ** 2).sum())
    sst = float((w * (o - ob) ** 2).sum())
    return {"r2": 1.0 - sse / sst if sst > 0 else None, "rmse": float(np.sqrt(sse / sw)),
            "bias": float((w * (p - o)).sum() / sw), "n": int(ok.sum())}


def _s09_night_hindcast():
    """Night 2000 (Terra-reconstructed) vs the recentred night model trained on 2005-2025, vs persistence."""
    mode = "night"
    if mode not in _S09_MODES or 2000 not in _S09_FRAMES or FRAME_TIERS[mode].get(2000) != "reconstructed":
        return {"available": False, "reason": "no reconstructed night 2000 frame"}
    if 2000 in set(int(v) for v in np.unique(DF["year"].to_numpy()[DF["w_night"].to_numpy() > 0])):
        return {"available": False, "reason": "2000 is a night training frame (not an independent test)"}
    _, anom_pred, resid = _s09_modelled_field(mode, 2000)
    obs = _s09_col("anom_night", 2000)
    later = [y for y in _S09_FRAMES if y > 2000 and FRAME_TIERS[mode][y] == "observed"]
    persist = _s09_col("anom_night", later[0]) if later else np.full(_S09_NC, np.nan)
    both = np.isfinite(obs) & np.isfinite(persist)
    m_model = _s09_metrics(obs[both], anom_pred[both])
    m_resid = _s09_metrics(obs[both], (anom_pred + resid)[both])
    m_pers = _s09_metrics(obs[both], persist[both])
    lev = LEVELS[mode][2000].get("regression_check") or {}
    return {"available": True, "frame": 2000, "train_frames": sorted(int(v) for v in CFG.NIGHT_TRAIN_FRAMES),
            "r2": m_model["r2"], "rmse": m_model["rmse"], "bias": m_model["bias"], "n": m_model["n"],
            "r2_with_persistent_residual": m_resid["r2"], "rmse_with_persistent_residual": m_resid["rmse"],
            "persistence_frame": later[0] if later else None, "persistence_r2": m_pers["r2"],
            "persistence_rmse": m_pers["rmse"], "recentred": True,
            "level_check": {"observed_level": LEVELS[mode][2000]["level"], "regression_level": lev.get("predicted"),
                            "error": lev.get("error"), "half_width": lev.get("half_width")}}


def _s09_day_hindcast():
    """Day 'train late, predict early': final recipe on frames >= 2005, scored (recentred) on the earlier frames."""
    mode = "day"
    early = [y for y in _S09_FRAMES if y < 2005]
    if mode not in _S09_MODES or not early:
        return {"available": False, "reason": "no day frames before 2005"}
    w = DF["w_day"].to_numpy(np.float32)
    years = DF["year"].to_numpy(np.int64)
    train = np.flatnonzero((w > 0) & (years >= 2005))
    if train.size < 100:
        return {"available": False, "reason": "too few late training rows"}
    rounds = int(FINAL_MODELS[mode].num_boosted_rounds())
    X = DF[FEATURES].to_numpy(np.float32)
    y = DF["anom_day"].to_numpy(np.float32)
    # cross-section code (D4): the refit uses the final-model recipe of section 07 through _s08_train_booster (08)
    _h = globals().get("section_code_hash")
    key = CFG.key("XGB_PARAMS", version=_S09_VERSION, rounds=rounds, df=_S08_DF_FP, early=early,
                  code07=_h("07") if _h else None, code08=_h("08") if _h else None)

    def compute():
        booster, used = _s08_train_booster(mode, X[train], y[train], w[train], rounds, xgb_device_for(0), CFG.SEED)
        booster.set_param({"device": "cpu"})
        preds = {int(t): np.asarray(booster.inplace_predict(X[_s09_slice(t)]), np.float32) for t in early}
        del booster
        return {"preds": preds, "device": used}

    with timer("09_day_hindcast"):
        res = stage_cache("09_day_hindcast", key).get_or_compute(compute)
    fixed = _s09_fixed_cells(mode)
    later = [t for t in _S09_FRAMES if t >= 2005]
    persist = _s09_col("anom_day", later[0])
    by_frame, pool_o, pool_p, pool_q, pool_w = [], [], [], [], []
    for t in early:
        pred = res["preds"][t].astype(np.float64)
        pred = pred - np.mean(pred[fixed])
        obs = _s09_col("anom_day", t)
        wt = _s09_col("w_day", t)
        if not np.any(wt > 0):          # a frame left out of training (D8): score its valid cells unweighted
            wt = np.where(np.isfinite(obs), 1.0, 0.0)
        ok = np.isfinite(obs) & np.isfinite(persist) & (wt > 0)
        mm = _s09_metrics(obs[ok], pred[ok], wt[ok])
        mp = _s09_metrics(obs[ok], persist[ok], wt[ok])
        by_frame.append({"frame": int(t), "r2": mm["r2"], "rmse": mm["rmse"], "bias": mm["bias"], "n": mm["n"],
                         "persistence_r2": mp["r2"], "persistence_rmse": mp["rmse"],
                         "years_from_training": int(later[0] - t)})
        pool_o.append(obs[ok]), pool_p.append(pred[ok]), pool_q.append(persist[ok]), pool_w.append(wt[ok])
    po, pp, pq, pw = (np.concatenate(v) for v in (pool_o, pool_p, pool_q, pool_w))
    mm, mp = _s09_metrics(po, pp, pw), _s09_metrics(po, pq, pw)
    return {"available": True, "frames": early, "train_frames": later, "r2": mm["r2"], "rmse": mm["rmse"],
            "bias": mm["bias"], "n": mm["n"], "persistence_r2": mp["r2"], "persistence_rmse": mp["rmse"],
            "persistence_frame": later[0], "by_frame": by_frame, "recentred": True, "rounds": rounds,
            "device": res["device"]}


HINDCAST_METRICS = {}
if "night" in _S09_MODES:
    HINDCAST_METRICS["night"] = _s09_night_hindcast()
    HINDCAST_METRICS["night"]["level_regression"] = _S09_LEVEL_REG.get("night")
if "day" in _S09_MODES:
    HINDCAST_METRICS["day"] = _s09_day_hindcast()
    HINDCAST_METRICS["day"]["level_regression"] = _S09_LEVEL_REG.get("day")
for _m, _h in HINDCAST_METRICS.items():
    if _h.get("available"):
        log(f"09: {_m} hindcast: R2 {_h['r2']:.3f}, RMSE {_h['rmse']:.3f} °C (persistence R2 "
            f"{_h['persistence_r2']:.3f}, RMSE {_h['persistence_rmse']:.3f})")
    else:
        log(f"09: {_m} hindcast not available: {_h.get('reason')}")

# %% [markdown]
# ## 9.10 Climate sensitivity β (`CLIMATE_SENSITIVITY`)

# %%
def _s09_ols(X, y):
    coef, _, rank, _ = np.linalg.lstsq(X, y, rcond=None)
    return coef if rank == X.shape[1] else None


def _s09_moving_block_indices(n, block, rng):
    n_blocks = int(_s09_math.ceil(n / block))
    starts = rng.integers(0, n - block + 1, size=n_blocks)
    return (starts[:, None] + np.arange(block)[None, :]).ravel()[:n]


def _s09_beta(mode):
    """OLS dLST/dT (+ swvl1 co-regressor), moving-block bootstrap draws and Theil-Sen (SPEC §4.7)."""
    y_s, sensor = _s09_sat_series(mode, _S09_BETA_SAT[mode], drop_drift=(mode == "day"))
    t_s, sw_s = _s09_annual(_S09_TEMP_VAR[mode]), _s09_annual("era5_swvl1")
    years = sorted(set(y_s.index) & set(t_s.index) & set(sw_s.index))
    n = len(years)
    base = {"temperature_var": _S09_TEMP_VAR[mode], "regressors": [_S09_TEMP_VAR[mode], "era5_swvl1"],
            "years": [int(v) for v in years], "n_years": n, "series": sorted(set(sensor.values())),
            "method": (f"OLS of the annual NCR satellite LST on {_S09_TEMP_VAR[mode]} + era5_swvl1; moving-block "
                       f"bootstrap ({_S09_BETA_BLOCK}-year blocks, {_S09_BETA_DRAWS} draws, percentile CI); "
                       "Theil-Sen univariate slope alongside")}
    y = y_s.loc[years].to_numpy(np.float64) if n else np.zeros(0)
    T = t_s.loc[years].to_numpy(np.float64) if n else np.zeros(0)
    if n < 6 or not np.ptp(T) > 0:
        why = f"only {n} years" if n < 6 else f"{_S09_TEMP_VAR[mode]} is constant over the fit years"
        log(f"09: {mode}: {why} for beta; falling back to beta = 1 +- 0.5", "WARNING")
        draws = np.random.default_rng(CFG.SEED).normal(1.0, 0.25, _S09_BETA_DRAWS).astype(np.float32)
        return {**base, "beta": 1.0, "ci": [0.5, 1.5], "draws": draws, "r2": None, "theil_sen": None,
                "theil_sen_ci": None, "coef_swvl1": None, "fallback": True}
    S = sw_s.loc[years].to_numpy(np.float64)
    X = np.column_stack([np.ones(n), T, S])
    coef = _s09_ols(X, y)
    if coef is None:
        X = X[:, :2]
        coef = _s09_ols(X, y)
        base["regressors"] = [_S09_TEMP_VAR[mode]]
    resid = y - X @ coef
    sst = float(np.sum((y - y.mean()) ** 2))
    r2 = 1.0 - float(resid @ resid) / sst if sst > 0 else None
    sigma2 = float(resid @ resid) / max(n - X.shape[1], 1)
    se = float(np.sqrt(max(sigma2 * float(np.linalg.pinv(X.T @ X)[1, 1]), 0.0)))
    rng = np.random.default_rng(CFG.SEED + 909 + (0 if mode == "day" else 1))
    draws = []
    attempts = 0
    while len(draws) < _S09_BETA_DRAWS and attempts < 5 * _S09_BETA_DRAWS:
        attempts += 1
        idx = _s09_moving_block_indices(n, min(_S09_BETA_BLOCK, n), rng)
        c = _s09_ols(X[idx], y[idx])
        if c is not None and np.isfinite(c[1]):
            draws.append(c[1])
    draws = np.asarray(draws, dtype=np.float32)
    ts = _s09_stats.theilslopes(y, T, alpha=0.95)
    return {**base, "beta": float(coef[1]), "ci": [float(np.percentile(draws, 2.5)), float(np.percentile(draws, 97.5))],
            "draws": draws, "r2": r2, "se_ols": se, "coef_swvl1": float(coef[2]) if X.shape[1] == 3 else None,
            "intercept": float(coef[0]), "theil_sen": float(ts[0]), "theil_sen_ci": [float(ts[2]), float(ts[3])],
            "bootstrap_median": float(np.median(draws)), "fallback": False}


CLIMATE_SENSITIVITY = {m: _s09_beta(m) for m in CFG.MODES}
for _m, _b in CLIMATE_SENSITIVITY.items():
    log(f"09: beta {_m} = {_b['beta']:.3f} [{_b['ci'][0]:.3f}, {_b['ci'][1]:.3f}] (R2 {_b['r2']}, n {_b['n_years']}, "
        f"Theil-Sen {_b['theil_sen']}, {len(_b['draws'])} block-bootstrap draws)")

# %% [markdown]
# ## 9.11 Frame statistics per scope (`SERIES_FRAMES`) and the hot-core threshold

# %%
def _s09_scopes():
    scopes = [{"id": "ncr", "label": "Delhi NCR", "kind": "ncr"}]
    scopes += [{"id": f"d:{int(d['id'])}", "label": d["name"], "kind": "district"} for d in DISTRICTS]
    for m in _S09_MODES:
        if m in ZONE_PROFILES:
            scopes += [{"id": f"z:{m}:{p['id']}", "label": p.get("display_name") or p["name"], "kind": "zone",
                        "mode": m} for p in ZONE_PROFILES[m]]
    return scopes


SERIES_SCOPES = _s09_scopes()
_S09_DISTRICT_OF_CELL = np.asarray(DISTRICT_IDX)[CELL_ROWS, CELL_COLS].astype(np.int64)


def _s09_hot_threshold(mode):
    ref = [y for y in _S09_FRAMES if _S09_REF_PERIOD[0] <= y <= _S09_REF_PERIOD[1]] or list(_S09_FRAMES)
    vals = np.concatenate([FRAME_FIELDS[mode][y][np.isfinite(FRAME_FIELDS[mode][y])] for y in ref])
    return float(np.percentile(vals, 90)) if vals.size else float("nan"), ref


def _s09_uhi(field, fb, fw, sel):
    urban = sel & (fb >= 0.5) & np.isfinite(field)
    rural = sel & (fb <= 0.05) & (fw < 0.2) & np.isfinite(field)
    if urban.sum() < 3 or rural.sum() < 3:
        return None
    return float(field[urban].mean() - field[rural].mean())


def _s09_scope_mask(scope_id, mode, year):
    if scope_id == "ncr":
        return np.ones(_S09_NC, dtype=bool)
    if scope_id.startswith("d:"):
        return _S09_DISTRICT_OF_CELL == int(scope_id[2:])
    _, zm, zk = scope_id.split(":")
    if zm != mode:
        return None
    return np.asarray(ZONES_OBS[mode][year]) == int(zk)


def _s09_series_frames(mode):
    thr = HOT_CORE_THRESHOLD[mode]
    out, low = {}, []
    for sc in SERIES_SCOPES:
        if sc["kind"] == "zone" and sc.get("mode") != mode:
            continue
        rows = []
        for y in _S09_FRAMES:
            field = FRAME_FIELDS[mode][y].astype(np.float64)
            sel = _s09_scope_mask(sc["id"], mode, y)
            fb = np.asarray(FEATURE_GRIDS[y]["frac_built"], np.float64)[CELL_ROWS, CELL_COLS]
            fw = np.asarray(FEATURE_GRIDS[y]["frac_water"], np.float64)[CELL_ROWS, CELL_COLS]
            lev = LEVELS[mode][y]
            n_scope = int(sel.sum())                     # ROI cells of the scope at this frame (zones: assigned)
            vals = field[sel & np.isfinite(field)]
            coverage = round(vals.size / n_scope, 4) if n_scope else 0.0
            if vals.size == 0:
                rows.append({"year": y, "mean": None, "ci": None, "p90": None, "hot_core_km2": 0.0, "uhi": None,
                             "n_cells": 0, "tier": FRAME_TIERS[mode][y], "coverage": coverage})
                continue
            if sc["id"] == "ncr":
                # the NCR value is the frame LEVEL (fixed mask, composition-consistent) and its CI (D16)
                mean, ci = float(lev["level"]), [float(lev["ci"][0]), float(lev["ci"][1])]
            else:
                mean = float(vals.mean())
                ci = [mean - (lev["level"] - lev["ci"][0]), mean + (lev["ci"][1] - lev["level"])]
            hot = (float((vals >= thr).sum()) / vals.size * n_scope * _S09_RES_KM2) if np.isfinite(thr) else None
            rows.append({"year": y, "mean": mean, "ci": ci, "p90": float(np.percentile(vals, 90)),
                         "hot_core_km2": hot, "uhi": _s09_uhi(field, fb, fw, sel), "n_cells": int(vals.size),
                         "tier": FRAME_TIERS[mode][y], "coverage": coverage})
            if coverage < 0.9:
                low.append(f"{sc['id']} {y} ({coverage:.0%})")
        out[sc["id"]] = rows
    if low:
        log(f"09: {mode}: {len(low)} scope-frame rows cover < 90 % of their cells (hot-core area scaled to the "
            f"scope): " + ", ".join(low[:12]) + (" ..." if len(low) > 12 else ""))
    return out


HOT_CORE_THRESHOLD, _S09_HOT_FRAMES, SERIES_FRAMES = {}, {}, {}
with timer("09_series_frames"):
    for _m in _S09_MODES:
        HOT_CORE_THRESHOLD[_m], _S09_HOT_FRAMES[_m] = _s09_hot_threshold(_m)
        SERIES_FRAMES[_m] = _s09_series_frames(_m)
        log(f"09: {_m} hot-core threshold {HOT_CORE_THRESHOLD[_m]:.2f} °C (p90 of {_S09_HOT_FRAMES[_m]}); NCR UHI "
            + ", ".join(f"{r['year']}={r['uhi']:+.2f}" if r["uhi"] is not None else f"{r['year']}=n/a"
                        for r in SERIES_FRAMES[_m]["ncr"]))


def _s09_series_annual(mode):
    """Annual series per scope (ncr + districts): ERA5 skin temperature with anomaly, satellite values."""
    out = {}
    for sc in SERIES_SCOPES:
        if sc["kind"] == "zone":
            continue
        skin = _s09_annual(_S09_SKIN_VAR[mode], sc["id"])
        ref = skin[(skin.index >= _S09_REF_PERIOD[0]) & (skin.index <= _S09_REF_PERIOD[1])]
        ref_mean = float(ref.mean()) if len(ref) else (float(skin.mean()) if len(skin) else float("nan"))
        sat_rows = []
        for var, _, _ in _S09_LEVEL_SAT[mode]:
            s = _s09_annual(var, sc["id"])
            flags = _s09_annual_flags(var, sc["id"])
            sat_rows += [{"year": int(y), "value": float(v), "sensor": _S09_SENSOR_LABEL.get(var, var),
                          "variable": var, "flag": flags.get(int(y))} for y, v in s.items() if np.isfinite(v)]
        out[sc["id"]] = {"era5_skin": [{"year": int(y), "value": float(v), "anomaly": float(v - ref_mean)}
                                       for y, v in skin.items() if np.isfinite(v)],
                         "satellite": sorted(sat_rows, key=lambda r: (r["year"], r["variable"]))}
    return out


SERIES_ANNUAL = {m: _s09_series_annual(m) for m in _S09_MODES}

# %% [markdown]
# ## 9.12 Trends (`TRENDS`)

# %%
def _s09_theil_sen_many(x, Y):
    """Theil-Sen slopes of each row of Y (D, k) against x (k,) - median of all pairwise slopes, vectorised."""
    x = np.asarray(x, np.float64)
    i, j = np.triu_indices(x.size, k=1)
    dx = x[j] - x[i]
    keep = dx != 0
    slopes = (Y[:, j[keep]] - Y[:, i[keep]]) / dx[keep][None, :]
    return np.median(slopes, axis=1)


def _s09_level_trend(years, levels, cis, rng):
    years = np.asarray(years, np.float64)
    lev = np.asarray(levels, np.float64)
    if years.size < 3:
        return None
    sd = np.array([(c[1] - c[0]) / (2.0 * _S09_Z90) for c in cis])
    draws = lev[None, :] + rng.standard_normal((_S09_MC_DRAWS, years.size)) * sd[None, :]
    slope = float(_s09_theil_sen_many(years / 10.0, lev[None, :])[0])
    mc = _s09_theil_sen_many(years / 10.0, draws)
    return {"slope_per_decade": slope, "ci": [float(np.percentile(mc, 2.5)), float(np.percentile(mc, 97.5))],
            "period": [int(years[0]), int(years[-1])], "method": "Theil-Sen + MC", "n_frames": int(years.size),
            "frames": [int(v) for v in years]}


def _s09_annual_trend(series, y0=None, y1=None):
    s = series.dropna()
    if y0 is not None:
        s = s[(s.index >= y0) & (s.index <= y1)]
    if len(s) < 5:
        return None
    ts = _s09_stats.theilslopes(s.to_numpy(np.float64), s.index.to_numpy(np.float64), alpha=0.95)
    return {"slope_per_decade": float(ts[0] * 10.0), "ci": [float(ts[2] * 10.0), float(ts[3] * 10.0)],
            "period": [int(s.index[0]), int(s.index[-1])], "method": "Theil-Sen (95% CI)", "n_years": int(len(s))}


def _s09_trends(mode):
    rng = np.random.default_rng(CFG.SEED + 77 + (0 if mode == "day" else 1))
    obs_frames = [y for y in _S09_FRAMES if FRAME_TIERS[mode][y] in ("observed", "observed-sparse", "reconstructed")]
    obs = _s09_level_trend(obs_frames, [LEVELS[mode][y]["level"] for y in obs_frames],
                           [LEVELS[mode][y]["ci"] for y in obs_frames], rng)
    sat, _ = _s09_sat_series(mode, _S09_LEVEL_SAT[mode], drop_drift=(mode == "day"))
    annual = {"era5_skin": _s09_annual_trend(_s09_annual(_S09_SKIN_VAR[mode])),
              _S09_TEMP_VAR[mode]: _s09_annual_trend(_s09_annual(_S09_TEMP_VAR[mode])),
              "satellite": _s09_annual_trend(sat)}
    by_scope = {}
    for scope, rows in SERIES_FRAMES[mode].items():
        rr = [r for r in rows if r["year"] in obs_frames and r["mean"] is not None]
        tr = _s09_level_trend([r["year"] for r in rr], [r["mean"] for r in rr], [r["ci"] for r in rr], rng)
        entry = {"obs": tr}
        if not scope.startswith("z:"):
            sat_s, _ = _s09_sat_series(mode, _S09_LEVEL_SAT[mode], scope=scope, drop_drift=(mode == "day"))
            entry["annual"] = {"era5_skin": _s09_annual_trend(_s09_annual(_S09_SKIN_VAR[mode], scope)),
                               "satellite": _s09_annual_trend(sat_s)}
        by_scope[scope] = entry
    return {"obs": obs, "annual": annual, "by_scope": by_scope, "frames": obs_frames}


TRENDS = {}
with timer("09_trends"):
    for _m in _S09_MODES:
        TRENDS[_m] = _s09_trends(_m)
        _t = TRENDS[_m]["obs"]
        if _t:
            log(f"09: {_m} level trend {_t['slope_per_decade']:+.3f} °C/decade [{_t['ci'][0]:+.3f}, "
                f"{_t['ci'][1]:+.3f}] over {_t['frames']}")

# %% [markdown]
# ## 9.13 Day level check (Landsat vs MODIS Terra) and zone LST means

# %%
def _s09_day_level_check():
    if "day" not in _S09_MODES:
        return {"available": False}
    fixed = _s09_fixed_cells("day")
    frames, cross = [], []
    for y in _S09_FRAMES:
        if y < 2000:
            continue
        modis = np.asarray(RAW_OBS[y]["lst_day_modis"], np.float64)[CELL_ROWS, CELL_COLS]
        sel = fixed & np.isfinite(modis)
        if sel.sum() < 10:
            continue
        m_level = float(modis[sel].mean())
        lev = LEVELS["day"][y]
        drift = y >= 2022 or CFG.window(y)[1] >= 2022
        frames.append({"year": y, "landsat_level": lev["level"], "landsat_raw_level": lev["raw_level"],
                       "modis_terra_level": m_level, "diff_corrected": lev["level"] - m_level,
                       "diff_raw": lev["raw_level"] - m_level, "overpass_correction": lev["overpass_correction"],
                       "n_cells": int(sel.sum()), "flag": "drift" if drift else None})
        field = FRAME_FIELDS["day"][y].astype(np.float64)
        both = np.isfinite(field) & np.isfinite(modis)
        if both.sum() >= 10:
            a = field[both] - field[both].mean()
            b = modis[both] - modis[both].mean()
            r = float(np.corrcoef(a, b)[0, 1])
            cross.append({"year": y, "r2": r * r, "rmse": float(np.sqrt(np.mean((a - b) ** 2))), "n": int(both.sum()),
                          "flag": "drift" if drift else None})
    good = [f for f in frames if f["flag"] is None and f["year"] <= _S09_REF_PERIOD[1]]
    summ = {}
    if len(good) >= 2:
        dc = np.array([f["diff_corrected"] for f in good])
        dr = np.array([f["diff_raw"] for f in good])
        summ = {"frames": [f["year"] for f in good], "mean_offset_corrected": float(dc.mean()),
                "sd_corrected": float(dc.std(ddof=1)), "mean_offset_raw": float(dr.mean()),
                "sd_raw": float(dr.std(ddof=1)),
                "note": "Landsat (10:45 IST, corrected) minus MODIS Terra (~10:30-11:30 local solar time) fixed-mask "
                        "means; a constant offset is expected, the frame-to-frame spread measures the residual "
                        "inconsistency"}
    return {"available": bool(frames), "frames": frames, "summary": summ, "cross_sensor": cross}


DAY_LEVEL_CHECK = _s09_day_level_check()
if DAY_LEVEL_CHECK.get("summary"):
    _s = DAY_LEVEL_CHECK["summary"]
    log(f"09: DAY_LEVEL_CHECK Landsat - MODIS Terra: corrected {_s['mean_offset_corrected']:+.2f} +- "
        f"{_s['sd_corrected']:.2f} °C vs raw {_s['mean_offset_raw']:+.2f} +- {_s['sd_raw']:.2f} °C over {_s['frames']}")

# zone profiles of section 08 get their absolute means here (observed field and model prediction + level)
for _m in _S09_MODES:
    for _p in ZONE_PROFILES.get(_m, []):
        for _y in _S09_FRAMES:
            _sel = np.asarray(ZONES_OBS[_m][_y]) == _p["id"]
            _f = FRAME_FIELDS[_m][_y].astype(np.float64)[_sel]
            _p["lst_mean"]["obs"][str(_y)] = float(np.nanmean(_f)) if np.isfinite(_f).any() else None
            _pr = PRED_ANOM[_m][_y].astype(np.float64)[_sel]
            _p["lst_pred_mean"]["obs"][str(_y)] = (float(_pr.mean() + LEVELS[_m][_y]["level"]) if _pr.size
                                                   else None)

# %% [markdown]
# ## 9.14 Synthetic mode: planted vs recovered (overpass correction, levels, night calibration, β, UHI signs)

# %%
def _s09_planted_report(truth):
    report = {}
    lv = truth.get("levels") or {}
    if "day" in LEVELS:
        bias = (truth.get("overpass") or {}).get("raw_day_level_bias_c") or {}
        rows = []
        for y in _S09_FRAMES:
            planted_corr = -float(bias[y]) if y in bias else None
            rec = LEVELS["day"][y]
            rows.append({"year": y, "tier": rec["tier"], "planted_correction": planted_corr,
                         "recovered_correction": rec["overpass_correction"],
                         "true_level": lv.get("day", {}).get(y), "level": rec["level"],
                         "level_error": (rec["level"] - lv["day"][y]) if y in lv.get("day", {}) else None,
                         "in_ci": (rec["ci"][0] <= lv["day"][y] <= rec["ci"][1]) if y in lv.get("day", {}) else None})
        report["day_levels"] = rows
        print("Day overpass correction and level (planted vs recovered):")
        print(pd.DataFrame(rows).round(3).to_string(index=False))
    if "night" in LEVELS:
        rows = []
        for y in _S09_FRAMES:
            rec = LEVELS["night"][y]
            t = lv.get("night", {}).get(y)
            rows.append({"year": y, "tier": rec["tier"], "true_level": t, "level": rec["level"],
                         "ci": [round(rec["ci"][0], 2), round(rec["ci"][1], 2)],
                         "level_error": None if t is None else rec["level"] - t,
                         "in_ci": None if t is None else bool(rec["ci"][0] <= t <= rec["ci"][1])})
        report["night_levels"] = rows
        print("Night levels (planted vs recovered; modelled 1990/1995 from the ERA5 regression):")
        print(pd.DataFrame(rows).round(3).to_string(index=False))
    cal_rows = []
    for kind, spec in (truth.get("calibration") or {}).items():
        rec = {int(c["class"]): c for c in (NIGHT_CALIBRATION.get(kind) or {}).get("by_class", [])}
        for p in spec.get("planted_by_class", []):
            r = rec.get(int(p["class"]))
            cal_rows.append({"kind": kind, "class": p["class"], "planted_b": p["b"],
                             "expected_ols_b": p.get("expected_ols_b"), "recovered_b": None if r is None else r["b"],
                             "planted_a": p["a"], "recovered_a": None if r is None else r["a"],
                             "n": None if r is None else r.get("n")})
    if cal_rows:
        report["night_calibration"] = cal_rows
        print("Night calibration slopes (planted, expected OLS after attenuation, recovered):")
        print(pd.DataFrame(cal_rows).round(3).to_string(index=False))
    beta_rows = []
    for m, b in CLIMATE_SENSITIVITY.items():
        spec = (truth.get("beta") or {}).get(m) or {}
        planted = spec.get("value")
        exp = (spec.get("expected_ols_noise_free") or {}).get("beta")
        beta_rows.append({"mode": m, "planted": planted, "expected_ols_noise_free": exp, "recovered": b["beta"],
                          "ci": [round(b["ci"][0], 3), round(b["ci"][1], 3)],
                          "planted_in_ci": None if planted is None else bool(b["ci"][0] <= planted <= b["ci"][1]),
                          "expected_in_ci": None if exp is None else bool(b["ci"][0] <= exp <= b["ci"][1]),
                          "theil_sen": b["theil_sen"], "n_years": b["n_years"]})
    report["beta"] = beta_rows
    print("Climate sensitivity beta (planted vs recovered):")
    print(pd.DataFrame(beta_rows).to_string(index=False))
    uhi_rows = []
    realised = truth.get("uhi") or {}
    for m in _S09_MODES:
        for r in SERIES_FRAMES[m]["ncr"]:
            t = (realised.get(m) or {}).get("realised", {}).get(r["year"])
            uhi_rows.append({"mode": m, "year": r["year"], "tier": r["tier"], "uhi": r["uhi"], "planted_realised": t,
                             "sign": (realised.get(m) or {}).get("sign")})
    report["uhi"] = uhi_rows
    tab = pd.DataFrame(uhi_rows)
    print("Surface UHI (urban - rural, signed) by frame:")
    print(tab.round(3).to_string(index=False))
    ok_day = all(r["uhi"] is not None and r["uhi"] < 0 for r in uhi_rows if r["mode"] == "day")
    ok_night = all(r["uhi"] is not None and r["uhi"] > 0 for r in uhi_rows if r["mode"] == "night")
    print(f"UHI signs: day < 0 in every frame: {ok_day}; night > 0 in every frame: {ok_night}")
    report["uhi_signs_ok"] = {"day": ok_day, "night": ok_night}
    return report


PLANTED_VS_RECOVERED_09 = (_s09_planted_report(SYNTHETIC_TRUTH)
                           if isinstance(globals().get("SYNTHETIC_TRUTH"), dict) and SYNTHETIC_TRUTH else {})

# %% [markdown]
# ## 9.15 Figures

# %%
_S09_FIG_DIR = Path(CFG.FIG_DIR)
_S09_FIG_DIR.mkdir(parents=True, exist_ok=True)
_S09_TIER_MARKER = {"observed": "o", "observed-sparse": "s", "reconstructed": "D", "modelled": "^"}


def _s09_save_fig(fig, name):
    fig.savefig(_S09_FIG_DIR / name, dpi=140, bbox_inches="tight")
    plt.show()
    plt.close(fig)


def _s09_fig_levels():
    fig, axes = plt.subplots(1, len(_S09_MODES), figsize=(7 * len(_S09_MODES), 4.2), squeeze=False)
    for ax, m in zip(axes[0], _S09_MODES):
        for tier, mk in _S09_TIER_MARKER.items():
            ys = [y for y in _S09_FRAMES if LEVELS[m][y]["tier"] == tier]
            if not ys:
                continue
            lv = np.array([LEVELS[m][y]["level"] for y in ys])
            lo = lv - np.array([LEVELS[m][y]["ci"][0] for y in ys])
            hi = np.array([LEVELS[m][y]["ci"][1] for y in ys]) - lv
            ax.errorbar(ys, lv, yerr=np.vstack([lo, hi]), fmt=mk, ms=6, capsize=3, label=f"frame level ({tier})")
        sat, _ = _s09_sat_series(m, _S09_LEVEL_SAT[m])
        if len(sat):
            ax.plot(sat.index, sat.values, color="#64748b", lw=1, label="annual satellite (NCR)")
        skin = _s09_annual(_S09_SKIN_VAR[m])
        if len(skin):
            ax.plot(skin.index, skin.values, color="#f59e0b", lw=1, ls="--", label=f"{_S09_SKIN_VAR[m]} (NCR)")
        if TRENDS.get(m, {}).get("obs"):
            t = TRENDS[m]["obs"]
            ax.set_title(f"{m}: levels; trend {t['slope_per_decade']:+.2f} °C/decade [{t['ci'][0]:+.2f}, "
                         f"{t['ci'][1]:+.2f}]", fontsize=10)
        ax.set_ylabel("°C")
        ax.legend(fontsize=7, frameon=False)
    _s09_save_fig(fig, "09_levels.png")


def _s09_fig_beta():
    fig, axes = plt.subplots(1, len(CLIMATE_SENSITIVITY), figsize=(6 * len(CLIMATE_SENSITIVITY), 3.8), squeeze=False)
    for ax, (m, b) in zip(axes[0], CLIMATE_SENSITIVITY.items()):
        ax.hist(b["draws"], bins=40, color="#22d3ee", alpha=0.8)
        ax.axvline(b["beta"], color="#0f172a", lw=2, label=f"OLS {b['beta']:.2f}")
        ax.axvspan(b["ci"][0], b["ci"][1], color="#a78bfa", alpha=0.2, label="95% block-bootstrap CI")
        if b.get("theil_sen") is not None:
            ax.axvline(b["theil_sen"], color="#fb7185", ls="--", label=f"Theil-Sen {b['theil_sen']:.2f}")
        planted = ((SYNTHETIC_TRUTH or {}).get("beta") or {}).get(m, {}).get("value") if isinstance(
            globals().get("SYNTHETIC_TRUTH"), dict) else None
        if planted is not None:
            ax.axvline(planted, color="#16a34a", ls=":", lw=2, label=f"planted {planted:.2f}")
        ax.set_title(f"{m}: dLST/d{b['temperature_var']} (n={b['n_years']})")
        ax.legend(fontsize=7, frameon=False)
    _s09_save_fig(fig, "09_beta.png")


def _s09_fig_modelled():
    m = "night"
    frames = [y for y in _S09_FRAMES if m in FRAME_TIERS and FRAME_TIERS[m].get(y) == "modelled"]
    if m not in FRAME_FIELDS or not frames:
        return
    y = frames[0]
    fig, axes = plt.subplots(1, 3, figsize=(16, 5.5))
    for ax, (title, vals) in zip(axes, [(f"night {y} modelled field (°C)", FRAME_FIELDS[m][y]),
                                        ("p95 - p05 (°C)", FRAME_UNC[m][y]["p95"] - FRAME_UNC[m][y]["p05"]),
                                        ("outside AOA", FRAME_AOA_OUT[m][y].astype(np.float64))]):
        grid = np.full(GRID.shape, np.nan)
        grid[CELL_ROWS, CELL_COLS] = vals
        im = ax.imshow(grid, cmap="inferno" if "field" in title else "viridis")
        ax.set_axis_off()
        ax.set_title(title)
        fig.colorbar(im, ax=ax, shrink=0.7)
    _s09_save_fig(fig, f"09_night_{y}_modelled.png")


def _s09_fig_uhi():
    fig, ax = plt.subplots(figsize=(7, 3.6))
    for m in _S09_MODES:
        rows = [r for r in SERIES_FRAMES[m]["ncr"] if r["uhi"] is not None]
        ax.plot([r["year"] for r in rows], [r["uhi"] for r in rows], marker="o", lw=2, label=m)
    ax.axhline(0, color="#475569", lw=0.8)
    ax.set_ylabel("surface UHI, urban - rural (°C)")
    ax.set_title("Signed surface UHI by frame (NCR)")
    ax.legend(frameon=False)
    _s09_save_fig(fig, "09_uhi.png")


def _s09_fig_day_check():
    if not DAY_LEVEL_CHECK.get("frames"):
        return
    fr = DAY_LEVEL_CHECK["frames"]
    fig, ax = plt.subplots(figsize=(7, 3.6))
    ax.plot([f["year"] for f in fr], [f["diff_raw"] for f in fr], marker="s", label="raw Landsat - MODIS Terra")
    ax.plot([f["year"] for f in fr], [f["diff_corrected"] for f in fr], marker="o",
            label="overpass-corrected Landsat - MODIS Terra")
    ax.set_ylabel("°C")
    ax.set_title("Day level check (fixed-mask means)")
    ax.legend(frameon=False, fontsize=8)
    _s09_save_fig(fig, "09_day_level_check.png")


with timer("09_figures"):
    for _s09_fn in (_s09_fig_levels, _s09_fig_beta, _s09_fig_modelled, _s09_fig_uhi, _s09_fig_day_check):
        try:
            _s09_fn()
        except Exception as _s09_exc:  # noqa: BLE001 - a broken figure must never lose the computed results
            log(f"09: figure {_s09_fn.__name__} failed: {type(_s09_exc).__name__}: {_s09_exc}", "WARNING")
            plt.close("all")

# %% [markdown]
# ## 9.16 Contract check (SPEC §3.6)

# %%
def _s09_contract_check():
    n = _S09_NC
    for m in _S09_MODES:
        assert set(LEVELS[m]) == set(_S09_FRAMES), (m, sorted(LEVELS[m]))
        for y, rec in LEVELS[m].items():
            assert {"level", "ci", "method", "overpass_correction"} <= set(rec), (m, y)
            assert np.isfinite(rec["level"]) and rec["ci"][0] <= rec["level"] <= rec["ci"][1], (m, y, rec)
            assert (rec["overpass_correction"] is None) == (m != "day" or rec["tier"] == "modelled"), (m, y)
        for y in _S09_FRAMES:
            tier = FRAME_TIERS[m][y]
            assert tier in _S09_TIERS, (m, y, tier)
            f = FRAME_FIELDS[m][y]
            assert f.shape == (n,) and f.dtype == np.float32, (m, y, f.shape, f.dtype)
            if tier == "modelled":
                assert np.isfinite(f).all(), f"{m} {y}: modelled field must be complete"
            else:
                obs = _s09_col(f"lst_{m}", y)
                assert np.array_equal(np.isfinite(f), np.isfinite(obs)), f"{m} {y}: observed NaN pattern"
            a = FRAME_AOA_OUT[m][y]
            assert a.shape == (n,) and a.dtype == bool
            if tier in ("modelled", "reconstructed"):
                u = FRAME_UNC[m][y]
                assert u["p05"].shape == (n,) and u["p95"].shape == (n,) and u["p05"].dtype == np.float32
                okc = np.isfinite(f)
                assert np.all(u["p05"][okc] <= f[okc] + 1e-4) and np.all(f[okc] <= u["p95"][okc] + 1e-4)
            else:
                assert y not in FRAME_UNC[m], (m, y)
        if m == "day" and LEVELS[m]:
            tiers = {FRAME_TIERS[m][y] for y in _S09_FRAMES}
            assert tiers <= {"observed", "observed-sparse"}, f"day tiers must be observed(-sparse): {tiers}"
        for y, rec in LEVELS[m].items():
            assert 0.0 <= rec["fixed_mask_coverage"] <= 1.0, (m, y)
            if rec["tier"] != "modelled":
                cc = rec["composition_correction"]
                assert cc is not None and np.isfinite(cc), (m, y)
                assert cc == 0.0 or rec["fixed_mask_coverage"] < 0.999, (m, y, cc)
            else:
                assert "drift_correction_c" in rec, (m, y)
        for y in CFG.FRAMES_PROJ:
            assert FRAME_TIERS[m][int(y)] == "projected"
        for scope, rows in SERIES_FRAMES[m].items():
            assert [r["year"] for r in rows] == list(_S09_FRAMES), (m, scope)
            for r in rows:
                assert set(r) == {"year", "mean", "ci", "p90", "hot_core_km2", "uhi", "n_cells", "tier", "coverage"}
                assert 0.0 <= r["coverage"] <= 1.0, (m, scope, r)
            for r in (rows if scope == "ncr" else []):
                lev = LEVELS[m][r["year"]]
                assert r["mean"] is None or (abs(r["mean"] - lev["level"]) < 1e-9 and r["ci"] == lev["ci"]), r
        assert np.isfinite(HOT_CORE_THRESHOLD[m])
        assert "ncr" in SERIES_FRAMES[m] and all(f"d:{d['id']}" in SERIES_FRAMES[m] for d in DISTRICTS)
    for m, b in CLIMATE_SENSITIVITY.items():
        assert {"beta", "ci", "draws", "r2", "n_years", "regressors", "method", "temperature_var"} <= set(b)
        assert len(b["draws"]) >= 1000 and b["temperature_var"] == _S09_TEMP_VAR[m]
        assert b["ci"][0] <= b["ci"][1]
    assert isinstance(HINDCAST_METRICS, dict) and isinstance(DAY_LEVEL_CHECK, dict)


_s09_contract_check()
log("09: contract check passed (SPEC §3.6: levels, tiers, frame fields, uncertainty, AOA flags, beta, series)")
log("Section 09 complete: LEVELS, FRAME_TIERS, FRAME_FIELDS, FRAME_UNC, FRAME_AOA_OUT, CLIMATE_SENSITIVITY, TRENDS, "
    "SERIES_FRAMES, SERIES_SCOPES, SERIES_ANNUAL, HOT_CORE_THRESHOLD, HINDCAST_METRICS, DAY_LEVEL_CHECK ready")
free_memory()
