# %% [markdown]
# # 2. Synthetic world 1990–2025 and future inputs (synthetic mode only)
#
# When `DATA_MODE == "synthetic"` this section builds a **synthetic twin of Delhi NCR** that has the same
# globals, keys, shapes, dtypes and units as the Earth Engine acquisition layer (sections 03–05, SPEC §3.2):
# `RAW_STATIC`, `RAW_OBS`, `LC_FINE`, `FRAME_META`, `NIGHT_CALIBRATION`, `ANNUAL_SERIES`, `FUTURE_INPUTS` and
# `SYNTHETIC_TRUTH`. Sections 06–12 therefore run unchanged on it. In gee mode the section does nothing.
#
# **What is simulated and why** (every number is *planted* and recorded in `SYNTHETIC_TRUTH`):
#
# * **Geography** (v1 generator, ported): a N→SE sloping plain with the Aravalli ridge (relief growing from the
#   Delhi ridge towards Alwar), slightly incised Yamuna/Ganga floodplains, rivers, jheels and ponds, rocky foothills,
#   the arid south-west and an irrigated north-east (Karnal–Shamli–Muzaffarnagar sugarcane belt).
# * **Urban growth 1990 → 2030** from a 1990 state: Delhi first (logistic radius growth centred in the 1990s),
#   Gurugram, Noida, Ghaziabad and Faridabad accelerating after 2000, Greater Noida / Manesar after 2010.
#   Built-up land is irreversible and is taken mainly from cropland; forest and water are stable.
#   Products: GHSL-like `built_f` (fine), `built_v` and `pop` (1 km); a GLC_FCS30D-like land-cover map with its
#   own classification noise (`LC_FINE`, `glc_*`; the 2025 frame uses the 2022 map exactly like the real product).
# * **Landsat-like spectra** consistent with land cover: pre-monsoon harvested cropland has a low NDVI but a high
#   February–March NDVI (`ndvi_spring_f`), the irrigated north-east stays green, the bright barren south-west has a
#   high albedo.
# * **ERA5-Land-like climate** per frame (1 km, smooth): a south-west → north-east gradient (NE cooler, wetter),
#   warming of ~0.2 K/decade and inter-annual anomalies that are identical to the annual series (`ANNUAL_SERIES`).
#   Wind (not a planted driver) follows its own synoptic/terrain pattern more than the SW→NE gradient, so it is not
#   a near-copy of the planted soil-moisture field (|r| ≈ 0.9 before; the night model then credited wind).
# * **Identifiability by design:** albedo has a within-class brightness component and building height a typology
#   component, so every planted driver has independent variation that a model can, in principle, attribute.
# * **Planted LST physics** at the fine grid (so every 1 km aggregate is consistent):
#   *day* (~10:45 IST) — saturating NDVI cooling, park cooling via neighbourhood NDVI, harvest heating via
#   `ndvi_drop`, albedo cooling, a **negative daytime surface UHI** (built cooler than barren/fallow land),
#   barren heating, saturating water cooling, regional moisture (swvl1 / VPD), elevation and TPI;
#   *night* (~01:30 IST) — saturating built-up warming plus building volume (**positive night SUHI**), water
#   warmer than land, cold-air pooling (TPI), soil-moisture thermal inertia, weak NDVI cooling.
# * **Absolute levels** `L(t)`: day ≈ 41 °C + trend + β_day·ΔTmax(t) (β_day = 1.3), night ≈ 26 °C + trend +
#   β_night·ΔTmin(t) (β_night = 0.9), both with a soil-moisture term, so section 09 can recover β from the annual
#   satellite series.
# * **Observation artefacts** that sections 06–10 must undo: the Landsat overpass-time bias
#   (`lst_day_f` is shifted by −(10.75 − overpass_h)·heating_rate), per-path offsets removed by the same overlap
#   harmonisation as section 03, few scenes in the 1990s, Landsat 7 SLC-off stripes, gaps, MODIS Terra drift after
#   2022, Terra-22:30 and VIIRS night products that must be calibrated to Aqua (`NIGHT_CALIBRATION` is fitted on
#   simulated overlap years exactly as section 04 fits it on real ones).
# * **Future inputs** (illustrative): 34 pseudo-GCMs for ssp245/ssp585, a warming pattern, SSP urban-growth ratios
#   per district, GHSL-2030-like built-up/population, SSP urban-population factors and AR6-like GSAT increments.
#
# Everything is vectorised NumPy/SciPy, seeded and deterministic (independent random stream per purpose).

# %%
import json as _s02_json
import math as _s02_math
import time as _s02_time
from pathlib import Path

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from scipy import ndimage as _s02_ndi
from scipy import sparse as _s02_sparse

_S02_ACTIVE = globals().get("DATA_MODE") == "synthetic"
_S02_GENERATOR = "delhi-ncr-synthetic-v2"
_S02_REF_OVERPASS_IST_H = 10.75          # SPEC §4.7 reference overpass (10:45 IST)

# Harmonised land-cover classes (SPEC_v1 §1): 0 nodata, 1 built, 2 forest, 3 water, 4 cropland, 5 barren, 6 other veg
_S02_BUILT, _S02_FOREST, _S02_WATER, _S02_CROP, _S02_BARREN, _S02_OTHER = 1, 2, 3, 4, 5, 6
_S02_GLC_KEYS = ["glc_built", "glc_forest", "glc_water", "glc_cropland", "glc_barren", "glc_otherveg"]
_S02_FINE_KEYS = ["lst_day_f", "lst_day_nobs_f", "ndvi_f", "ndbi_f", "mndwi_f", "albedo_f", "ndvi_spring_f", "built_f"]
_S02_ERA5_KEYS = ["era5_t2m", "era5_rh", "era5_vpd", "era5_swvl1", "era5_evap", "era5_ssr", "era5_wind",
                  "era5_tmax", "era5_tmin", "era5_precip_jfm"]
_S02_COARSE_KEYS = ["lst_night", "lst_night_nobs", "lst_day_modis", "built_v", "pop"] + _S02_GLC_KEYS + _S02_ERA5_KEYS
_S02_PATHROWS = ["146/040", "146/041", "147/039", "147/040", "147/041"]

# Reference geography (lon, lat) - identical to the v1 generator.
_S02_YAMUNA = [(77.19, 29.95), (77.13, 29.55), (77.12, 29.20), (77.22, 28.85), (77.25, 28.62), (77.30, 28.45),
               (77.45, 28.20), (77.52, 27.90), (77.68, 27.55)]
_S02_GANGA = [(78.03, 29.75), (78.10, 29.30), (78.18, 28.95), (78.32, 28.60), (78.45, 28.30)]
_S02_ARAVALLI = [(77.17, 28.62), (77.10, 28.40), (76.85, 28.15), (76.60, 27.80), (76.40, 27.35)]

# Urban centres: name, lon, lat, amplitude, radius 1990 (km), radius 2025 (km), logistic mid-year, time scale (yr).
# r(y) follows a logistic between the two anchor radii, so 1990 and 2025 are exact and 2030 extrapolates smoothly.
# Delhi grows first (mid-point 1996); the satellite cities accelerate after 2000; Greater Noida/Manesar after 2010.
_S02_URBAN_CENTRES = [
    ("Delhi", 77.20, 28.63, 1.00, 8.5, 14.0, 1996, 8), ("Rohini", 77.09, 28.73, 0.85, 1.0, 4.6, 2000, 5),
    ("Dwarka", 77.04, 28.59, 0.80, 0.5, 4.0, 2005, 5), ("Gurugram", 77.03, 28.46, 0.92, 1.4, 7.6, 2008, 5),
    ("Noida", 77.36, 28.57, 0.92, 1.1, 6.6, 2006, 5), ("Greater Noida", 77.50, 28.47, 0.75, 0.4, 4.8, 2012, 5),
    ("Ghaziabad", 77.44, 28.67, 0.88, 2.4, 6.4, 2004, 6), ("Faridabad", 77.31, 28.40, 0.88, 2.6, 6.2, 2005, 6),
    ("Manesar", 76.93, 28.36, 0.62, 0.3, 3.2, 2011, 5), ("Bahadurgarh", 76.92, 28.69, 0.60, 0.8, 2.8, 2008, 6),
    ("Meerut", 77.71, 28.98, 0.80, 2.8, 4.4, 2002, 10), ("Sonipat", 77.02, 28.99, 0.65, 1.3, 2.9, 2008, 8),
    ("Panipat", 76.97, 29.39, 0.70, 1.8, 3.2, 2004, 10), ("Karnal", 76.99, 29.69, 0.65, 1.7, 3.0, 2004, 10),
    ("Rohtak", 76.61, 28.90, 0.70, 1.9, 3.1, 2003, 10), ("Rewari", 76.62, 28.19, 0.60, 1.2, 2.3, 2005, 10),
    ("Alwar", 76.60, 27.55, 0.70, 1.8, 3.1, 2004, 10), ("Bharatpur", 77.49, 27.22, 0.65, 1.5, 2.6, 2004, 10),
    ("Bulandshahr", 77.85, 28.40, 0.60, 1.3, 2.3, 2004, 10), ("Muzaffarnagar", 77.70, 29.47, 0.65, 1.5, 2.6, 2004, 10),
    ("Hapur", 77.78, 28.73, 0.60, 1.2, 2.3, 2005, 10), ("Bhiwani", 76.13, 28.79, 0.60, 1.5, 2.6, 2004, 10),
    ("Palwal", 77.33, 28.14, 0.55, 0.7, 1.9, 2008, 8), ("Jhajjar", 76.66, 28.61, 0.50, 0.7, 1.7, 2005, 10),
    ("Jind", 76.32, 29.32, 0.55, 1.0, 2.0, 2004, 10), ("Shamli", 77.31, 29.45, 0.50, 0.7, 1.5, 2006, 10),
    ("Baghpat", 77.22, 28.94, 0.50, 0.5, 1.4, 2006, 10), ("Nuh", 77.00, 28.10, 0.50, 0.4, 1.2, 2008, 10),
    ("Narnaul", 76.11, 28.05, 0.55, 0.9, 1.7, 2005, 10), ("Charkhi Dadri", 76.27, 28.59, 0.50, 0.6, 1.4, 2006, 10),
]

_S02_DEFAULT_WINDOWS = {1990: (1989, 1992), 1995: (1994, 1996), 2000: (1999, 2001), 2005: (2004, 2006),
                        2010: (2009, 2011), 2015: (2014, 2016), 2020: (2019, 2021), 2025: (2024, 2026)}

# Landsat acquisition per frame: real-archive sensors, scene totals and per-path/row counts (USGS STAC inventory,
# docs/research/gee_datasets_v2.md §3), mean overpass (IST hours), heating rate (ERA5-Land 09:30→11:30 IST skin
# temperature slope, K/h), the planted path-146 minus path-147 offset (°C) and the share of SLC-off scenes.
_S02_DAY_ACQ = {
    1990: {"sensors": ["Landsat 5 TM"], "scenes": 69, "per_pr": (3, 3, 8, 10, 10), "overpass": 10.18,
           "heating": 3.30, "path_delta": 0.90, "slc_share": 0.0},
    1995: {"sensors": ["Landsat 5 TM"], "scenes": 89, "per_pr": (5, 6, 4, 4, 4), "overpass": 9.92,
           "heating": 3.20, "path_delta": -0.60, "slc_share": 0.0},
    2000: {"sensors": ["Landsat 5 TM", "Landsat 7 ETM+"], "scenes": 110, "per_pr": (8, 10, 8, 6, 7),
           "overpass": 10.50, "heating": 3.15, "path_delta": 0.50, "slc_share": 0.0},
    2005: {"sensors": ["Landsat 7 ETM+ (SLC-off)"], "scenes": 155, "per_pr": (9, 12, 13, 13, 13), "overpass": 10.70,
           "heating": 3.25, "path_delta": 0.40, "slc_share": 1.0},
    2010: {"sensors": ["Landsat 5 TM", "Landsat 7 ETM+ (SLC-off)"], "scenes": 332, "per_pr": (20, 21, 26, 30, 29),
           "overpass": 10.62, "heating": 3.10, "path_delta": -0.30, "slc_share": 155 / 332},
    2015: {"sensors": ["Landsat 8 OLI/TIRS", "Landsat 7 ETM+ (SLC-off)"], "scenes": 354,
           "per_pr": (21, 26, 27, 26, 27), "overpass": 10.78, "heating": 3.35, "path_delta": 0.25,
           "slc_share": 174 / 354},
    2020: {"sensors": ["Landsat 8 OLI/TIRS", "Landsat 7 ETM+ (SLC-off)"], "scenes": 302,
           "per_pr": (20, 22, 22, 27, 26), "overpass": 10.80, "heating": 3.40, "path_delta": -0.20,
           "slc_share": 124 / 302},
    2025: {"sensors": ["Landsat 8 OLI/TIRS", "Landsat 9 OLI-2/TIRS-2"], "scenes": 367,
           "per_pr": (23, 25, 29, 29, 29), "overpass": 10.80, "heating": 3.30, "path_delta": 0.15,
           "slc_share": 0.0},
}
# WRS-2 footprints over the ROI (descending orbit: the swath edge drifts east by ~0.24° lon per degree of latitude).
_S02_WRS = {"tilt_deg_lon_per_deg_lat": 0.24, "lat_ref": 28.5, "centre": {"146": 78.07, "147": 76.52},
            "east_edge_147": 77.50, "west_edge_146": 77.12, "half_swath_km": 92.5,
            "row_split": {"147": (29.60, 28.15), "146": (None, 28.15)}}

# Night products per frame (SPEC §1.2/§2.2): source, sensor, overpass (IST h), composites in the window.
_S02_NIGHT_ACQ = {
    1990: (None, None, None, 0), 1995: (None, None, None, 0),
    2000: ("terra_cal", "MODIS Terra MOD11A2 night (22:30 IST), calibrated to Aqua", 22.45, 24),
    2005: ("aqua", "MODIS Aqua MYD11A2 night", 2.20, 36), 2010: ("aqua", "MODIS Aqua MYD11A2 night", 2.20, 36),
    2015: ("aqua", "MODIS Aqua MYD11A2 night", 2.20, 36), 2020: ("aqua", "MODIS Aqua MYD11A2 night", 2.20, 36),
    2025: ("viirs_cal", "VIIRS S-NPP VNP21A1N, calibrated to Aqua", 2.10, 273),
}

# --- Planted LST physics (anomaly terms, °C; evaluated per fine pixel) ---------------------------------------------
_S02_DAY = {
    "ndvi_cooling_c": -4.5, "ndvi_saturation": 0.30,                      # -4.5 * min(ndvi, 0.30) / 0.30
    "park_cooling_c": -1.2, "park_onset": 0.20, "park_full": 0.35, "park_window_m": 3000,
    "harvest_heating_c": 2.2, "harvest_onset": 0.12, "harvest_full": 0.40,  # ndvi_drop = spring - pre-monsoon
    "albedo_per_unit": -9.0, "albedo_ref": 0.18,
    "built_per_unit": -2.2,                                                # morning urban cool island
    "barren_per_unit": 2.8,
    "water_cooling_c": -7.0, "water_scale": 0.08, "water_window_m": 1000,  # on the 1 km neighbourhood water share
    "water_reach_c": -0.8, "water_reach_m": 600.0,
    "swvl1_per_unit": -12.0, "vpd_per_kpa": 0.6,
    "lapse_per_m": -0.0045, "elev_ref_m": 220.0, "tpi_per_m": 0.006, "tpi_window_m": 7000,
}
_S02_NIGHT = {
    "built_c": 3.2, "built_scale": 0.30,                                   # 3.2 * (1-exp(-b/0.3)) / (1-exp(-1/0.3))
    "built_v_per_log1p": 0.6,                                              # building volume (m3/m2), log1p
    "water_warming_c": 2.5, "water_scale": 0.08, "water_window_m": 1000,
    "ndvi_per_unit": -0.8, "barren_per_unit": -1.2,
    "tpi_per_m": 0.012, "tpi_window_m": 7000, "lapse_per_m": -0.003, "elev_ref_m": 220.0,
    "swvl1_per_unit": 6.0, "vpd_per_kpa": -0.4,
}
_S02_NOISE = {"day_corr_sd": 0.45, "day_corr_km": 8.0, "day_meso_sd": 0.25, "day_meso_km": 2.0, "day_white_sd": 0.30,
              "night_corr_sd": 0.35, "night_corr_km": 8.0, "night_white_sd": 0.25, "persistent_share": 0.75,
              "landsat_white_base": 0.25, "landsat_white_per_sqrt_n": 0.8, "landsat_scene_corr": 0.35,
              "modis_day_corr": 0.25, "modis_day_white": 0.35, "aqua_frame_white": 0.15,
              "terra_night_annual": 0.25, "viirs_night_annual": 0.18, "aqua_night_annual": 0.15,
              "annual_cell_sd": 0.30, "annual_scope_sd_day": 0.20, "annual_scope_sd_night": 0.15}
# Absolute levels: L(y) = base + trend*(y-2010)/10 + beta*(T(y) - T_ref) + gamma*(swvl1(y) - swvl1_ref)
_S02_LEVEL = {"day": {"base_c": 41.0, "trend_per_decade": 0.15, "beta": 1.3, "gamma_swvl1": -12.0,
                      "temperature_var": "era5_tmax"},
              "night": {"base_c": 26.0, "trend_per_decade": 0.15, "beta": 0.9, "gamma_swvl1": 6.0,
                        "temperature_var": "era5_tmin"}}
# Satellite-specific behaviour (annual series and 1 km day product).
_S02_TERRA_DAY_OFFSET_C = -0.8        # MODIS 1 km day LST minus the Landsat 10:45 IST level (algorithm + time)
_S02_TERRA_DAY_IST = {2022: 11.03, 2023: 10.70, 2024: 10.53, 2025: 10.12, 2026: 9.37}   # else 11.12 (11:07 IST)
_S02_TERRA_DAY_RATE = 3.0             # K/h around 11:00 IST
_S02_AQUA_NIGHT_IST = {2023: 2.45, 2024: 2.87, 2025: 3.33, 2026: 4.03}                # else 2.20 (02:12 IST)
_S02_NIGHT_COOLING_RATE = 0.55        # K/h after midnight
_S02_DRIFT_FROM = 2022                # Terra/Aqua flagged "drift" from this year (SPEC §2.2)
# Planted calibration maps aqua = a + b * src per dominant class (1..6).
_S02_CAL_PLANTED = {
    "terra_to_aqua": {1: (-0.5, 0.95), 2: (-0.8, 0.95), 3: (0.2, 0.96), 4: (-0.9, 0.94), 5: (-1.2, 0.93),
                      6: (-0.9, 0.94)},
    "viirs_to_aqua": {1: (-0.6, 0.99), 2: (-0.3, 1.00), 3: (0.2, 0.99), 4: (-0.7, 0.985), 5: (-1.0, 0.96),
                      6: (-0.6, 0.985)},
}
_S02_CAL_FIT_YEARS = {"terra_to_aqua": (2003, 2019), "viirs_to_aqua": (2013, 2021)}

# ERA5-Land-like Apr-Jun climatology: value at the gradient centre, change per unit of the SW->NE coordinate g
# (g = -1 south-west ... +1 north-east), amplitude of the smooth static pattern. Units as SPEC §2.3.
_S02_CLIM = {"era5_tmax": (39.6, -1.6, 0.25), "era5_tmin": (25.4, -0.5, 0.15), "era5_t2m": (32.6, -1.1, 0.20),
             "era5_rh": (31.0, 9.0, 2.0), "era5_swvl1": (0.18, 0.07, 0.010), "era5_evap": (1.6, 1.1, 0.15),
             "era5_ssr": (23.2, -0.6, 0.20), "era5_wind": (2.6, -0.2, 0.30), "era5_precip_jfm": (45.0, 25.0, 5.0),
             "era5_skin_day": (40.2, -2.0, 0.30), "era5_skin_night": (24.8, -0.4, 0.20)}
_S02_LAPSE_VARS = ("era5_tmax", "era5_tmin", "era5_t2m", "era5_skin_day", "era5_skin_night")

# Spectral class signatures (pre-monsoon Apr-Jun; spring = Feb-Mar), order built, forest, water, crop, barren, other.
_S02_SIG = {"ndvi": (0.11, 0.46, -0.08, 0.17, 0.08, 0.26),
            "ndvi_spring": (0.13, 0.50, -0.06, 0.56, 0.09, 0.32),
            "ndbi": (0.10, -0.20, -0.36, 0.03, 0.13, -0.06),
            "mndwi": (-0.22, -0.36, 0.48, -0.26, -0.30, -0.30),
            "albedo": (0.17, 0.12, 0.06, 0.19, 0.27, 0.16)}

# Future (illustrative stand-ins for GDDP-CMIP6, Chen et al. 2020, IIASA SSP v3 and AR6 WG1 Table 4.5).
_S02_CMIP6 = {"n_models": 34, "delta_2050": {"ssp245": {"tasmax": 1.1, "tasmin": 1.2},
                                              "ssp585": {"tasmax": 1.7, "tasmin": 1.85}},
              "shape_exponent": {"ssp245": 1.05, "ssp585": 1.20}, "model_sd": 0.30,
              "idio_sd": {"ssp245": 0.20, "ssp585": 0.08}, "bias_sd_k": 0.5, "window_noise_k": 0.06}
# Annual urban-land growth rate per district under SSP2 (%/yr, decaying with an e-folding time of 60 yr).
_S02_URBAN_RATE = {0: 0.9, 1: 3.2, 2: 2.2, 3: 2.4, 4: 1.8, 5: 2.2, 6: 2.4, 7: 1.8, 8: 2.8, 9: 2.0, 10: 1.8, 11: 1.5,
                   12: 1.4, 13: 1.4, 14: 1.3, 15: 2.0, 16: 2.6, 17: 3.4, 18: 1.7, 19: 2.3, 20: 2.3, 21: 1.6,
                   22: 1.6, 23: 1.6, 24: 1.4}
_S02_SSP_URBAN_MULT = {"ssp126": 0.75, "ssp245": 1.00, "ssp585": 1.35}
_S02_POP_FACTOR_2050 = {"ssp126": 1.55, "ssp245": 1.48, "ssp585": 1.62}
# AR6 WG1 Table 4.5 GSAT change vs 1995-2014 (central): near term 2021-2040, mid term 2041-2060.
_S02_AR6_GSAT = {"ssp126": (0.6, 0.9), "ssp245": (0.7, 1.1), "ssp585": (0.8, 1.5)}
_S02_POP_TOTAL = {"1990": 31.5e6, "2025": 66.0e6}

if _S02_ACTIVE:
    log(f"section 02: synthetic world generator {_S02_GENERATOR} is active")
else:
    log("section 02 skipped: data mode is not 'synthetic' (sections 03-05 provide the acquisition globals)")
    # SPEC §3.2: SYNTHETIC_TRUTH is None in gee mode; define it early so later sections can always reference it.
    if "SYNTHETIC_TRUTH" not in globals():
        SYNTHETIC_TRUTH = None

# %% [markdown]
# ## 2.1 Numerical helpers
# Random streams are derived from `(CFG.SEED, purpose tags)` with `SeedSequence`, so every field is reproducible and
# independent of call order. Spatially-correlated Gaussian fields are synthesised on a coarser lattice, smoothed and
# bilinearly upsampled (same statistics at a fraction of the cost). Resampling between the land-cover grid
# (`LC_FINE_RES_M`, e.g. 100 m) and the fine grid (250 m) uses exact **area-overlap matrices** (sparse, separable),
# because 100 m does not divide 250 m.

# %%
def _s02_cfg(name: str, default):
    """CFG attribute with a fallback (keeps the section usable with older configuration objects)."""
    value = getattr(CFG, name, None)
    return default if value is None else value


def _s02_lc_res() -> int:
    """Land-cover grid resolution (m): the resolved ``CFG.fine_res()`` (SPEC §1.1 LC_FINE_RES_M)."""
    if hasattr(CFG, "fine_res"):
        return int(CFG.fine_res())
    return int(_s02_cfg("LC_FINE_RES_M", 100))


def _s02_rng(*tags) -> np.random.Generator:
    """Independent reproducible random stream for (CFG.SEED, section 02, tags)."""
    return np.random.default_rng(np.random.SeedSequence([int(_s02_cfg("SEED", 42)), 2002, *[int(t) for t in tags]]))


def _s02_interp_axis_int(a: np.ndarray, f: int, axis: int) -> np.ndarray:
    """Linear interpolation of cell-centred samples onto an f-times finer grid along one axis (edges clamped)."""
    n = a.shape[axis]
    pos = np.clip((np.arange(n * f) + 0.5) / f - 0.5, 0.0, n - 1)
    i0 = np.floor(pos).astype(np.intp)
    i1 = np.minimum(i0 + 1, n - 1)
    shape = [1] * a.ndim
    shape[axis] = -1
    weight = (pos - i0).astype(np.float32).reshape(shape)
    lo = np.take(a, i0, axis=axis)
    return lo + (np.take(a, i1, axis=axis) - lo) * weight


def _s02_upsample_int(field: np.ndarray, f: int) -> np.ndarray:
    """Separable bilinear upsampling by an integer factor (pixel-edge aligned, float32)."""
    field = field.astype(np.float32, copy=f == 1)
    if f == 1:
        return field
    return _s02_interp_axis_int(_s02_interp_axis_int(field, f, 0), f, 1)


def _s02_corr_noise(shape, sigma_px: float, rng: np.random.Generator) -> np.ndarray:
    """Zero-mean, unit-variance Gaussian random field with correlation length ~``sigma_px`` pixels (float32)."""
    h, w = int(shape[0]), int(shape[1])
    if sigma_px < 0.5:
        return rng.standard_normal((h, w), dtype=np.float32)
    k = max(1, int(sigma_px // 3))
    small = rng.standard_normal((-(-h // k) + 1, -(-w // k) + 1), dtype=np.float32)
    small = _s02_ndi.gaussian_filter(small, sigma_px / k, mode="reflect")
    field = _s02_upsample_int(small, k)[:h, :w]
    field -= field.mean()
    field /= field.std() + 1e-12
    return np.ascontiguousarray(field, dtype=np.float32)


def _s02_noise_m(shape, res_m: float, corr_m: float, *tags) -> np.ndarray:
    """Correlated unit noise with a correlation length given in metres on a grid of ``res_m`` metres."""
    return _s02_corr_noise(shape, corr_m / float(res_m), _s02_rng(*tags))


def _s02_interp_axis_ratio(a: np.ndarray, src_res: int, dst_res: int, axis: int) -> np.ndarray:
    """Linear interpolation of cell-centred samples from ``src_res`` to ``dst_res`` cells along one axis."""
    n = a.shape[axis]
    extent = n * int(src_res)
    if extent % int(dst_res):
        raise ValueError(f"extent {extent} m is not a multiple of {dst_res} m")
    n_dst = extent // int(dst_res)
    pos = np.clip((np.arange(n_dst) + 0.5) * (dst_res / src_res) - 0.5, 0.0, n - 1)
    i0 = np.floor(pos).astype(np.intp)
    i1 = np.minimum(i0 + 1, n - 1)
    shape = [1] * a.ndim
    shape[axis] = -1
    weight = (pos - i0).astype(np.float32).reshape(shape)
    lo = np.take(a, i0, axis=axis)
    return lo + (np.take(a, i1, axis=axis) - lo) * weight


def _s02_bilinear(field: np.ndarray, src_res: int, dst_res: int) -> np.ndarray:
    """Bilinear resampling of a smooth field between two nested grids sharing the origin (any resolution ratio)."""
    field = np.asarray(field, dtype=np.float32)
    if int(src_res) == int(dst_res):
        return field.copy()
    out = _s02_interp_axis_ratio(_s02_interp_axis_ratio(field, src_res, dst_res, 0), src_res, dst_res, 1)
    return np.ascontiguousarray(out, dtype=np.float32)


def _s02_area_matrix(n_src: int, src_res: int, n_dst: int, dst_res: int):
    """Sparse (n_dst x n_src) matrix of 1-D area-overlap weights (rows sum to 1) between aligned grids."""
    src_res, dst_res = int(src_res), int(dst_res)
    if n_src * src_res != n_dst * dst_res:
        raise ValueError(f"grids do not share an extent: {n_src}x{src_res} m vs {n_dst}x{dst_res} m")
    max_span = -(-dst_res // src_res) + 1
    j = np.repeat(np.arange(n_dst), max_span)
    lo = j * dst_res
    first = lo // src_res
    i = first + np.tile(np.arange(max_span), n_dst)
    overlap = (np.minimum((i + 1) * src_res, lo + dst_res) - np.maximum(i * src_res, lo)).astype(np.float64)
    keep = (i < n_src) & (overlap > 0)
    mat = _s02_sparse.csr_matrix((overlap[keep] / dst_res, (j[keep], i[keep])), shape=(n_dst, n_src))
    return mat.astype(np.float32)


def _s02_area_resample(a: np.ndarray, mat_r, mat_c) -> np.ndarray:
    """Area-weighted resampling ``mat_r @ a @ mat_c.T`` of a 2-D float array (exact for indicator fractions)."""
    tmp = mat_r @ np.asarray(a, dtype=np.float32)
    return np.ascontiguousarray((mat_c @ tmp.T).T, dtype=np.float32)


def _s02_block_mean(fine: np.ndarray, f: int, valid: np.ndarray = None):
    """f x f block means of the finite (and ``valid``) fine pixels -> (mean float32 with NaN, count int)."""
    h, w = fine.shape[0] // f, fine.shape[1] // f
    ok = np.isfinite(fine) if valid is None else (valid & np.isfinite(fine))
    total = np.where(ok, fine, 0.0).reshape(h, f, w, f).sum(axis=(1, 3), dtype=np.float64)
    count = ok.reshape(h, f, w, f).sum(axis=(1, 3))
    out = np.full((h, w), np.nan, np.float32)
    np.divide(total, count, out=out, where=count > 0, casting="unsafe")
    return out, count


def _s02_box_mean(x: np.ndarray, size: int, valid: np.ndarray = None) -> np.ndarray:
    """NaN-aware moving-window mean ``uniform(x*m)/uniform(m)`` with a square window of ``size`` pixels."""
    size = max(1, int(size))
    ok = np.isfinite(x) if valid is None else (valid & np.isfinite(x))
    num = _s02_ndi.uniform_filter(np.where(ok, x, 0.0).astype(np.float32), size, mode="nearest")
    den = _s02_ndi.uniform_filter(ok.astype(np.float32), size, mode="nearest")
    out = np.full(x.shape, np.nan, np.float32)
    np.divide(num, den, out=out, where=den > 1e-6)
    return out


def _s02_px(metres: float, res_m: int) -> int:
    """Window size in pixels for a physical length (at least one pixel)."""
    return max(1, int(round(float(metres) / float(res_m))))


def _s02_lonlat_to_xy(points) -> np.ndarray:
    """(lon, lat) pairs -> projected metres in the grid CRS (pyproj, falling back to section 01's converter)."""
    pts = np.asarray(points, dtype=np.float64)
    try:
        import pyproj as _s02_pyproj
        transformer = _s02_pyproj.Transformer.from_crs("EPSG:4326", GRID.crs, always_xy=True)
        x, y = transformer.transform(pts[:, 0], pts[:, 1])
    except ImportError:
        converter = globals().get("_grid_lonlat_to_xy")
        if converter is None:
            raise RuntimeError("neither pyproj nor section 01's _grid_lonlat_to_xy is available") from None
        x, y = converter(pts[:, 0], pts[:, 1], GRID.crs)
    return np.column_stack([np.asarray(x, np.float64), np.asarray(y, np.float64)])


def _s02_polyline_distance_position(xs: np.ndarray, ys: np.ndarray, line_xy: np.ndarray, chunk_rows: int = 256):
    """Distance (m) from every grid point (xs[j], ys[i]) to a polyline and the along-line position (0..1)."""
    ox, oy = float(xs[0]), float(ys[0])
    xr = (xs - ox).astype(np.float32)[None, :]
    a = (line_xy[:-1] - (ox, oy)).astype(np.float32)
    b = (line_xy[1:] - (ox, oy)).astype(np.float32)
    seg_len = np.hypot(*(b - a).T)
    cum = np.concatenate([[0.0], np.cumsum(seg_len)]) / max(float(seg_len.sum()), 1e-9)
    dist = np.empty((len(ys), len(xs)), np.float32)
    pos = np.empty_like(dist)
    for r0 in range(0, len(ys), chunk_rows):
        yr = (ys[r0:r0 + chunk_rows] - oy).astype(np.float32)[:, None]
        best = np.full((len(yr), len(xs)), np.inf, np.float32)
        best_pos = np.zeros_like(best)
        for i in range(len(a)):
            (ax, ay), (dx, dy) = a[i], b[i] - a[i]
            t = np.clip(((xr - ax) * dx + (yr - ay) * dy) / max(float(dx * dx + dy * dy), 1e-9), 0.0, 1.0)
            d2 = (xr - ax - t * dx) ** 2 + (yr - ay - t * dy) ** 2
            closer = d2 < best
            best = np.where(closer, d2, best)
            best_pos = np.where(closer, cum[i] + t * (cum[i + 1] - cum[i]), best_pos)
        dist[r0:r0 + chunk_rows] = np.sqrt(best)
        pos[r0:r0 + chunk_rows] = best_pos
    return dist, pos


def _s02_polyline_distance_capped(xs: np.ndarray, ys: np.ndarray, line_xy: np.ndarray, cap_m: float) -> np.ndarray:
    """Distance (m) to a polyline, exact up to ``cap_m`` (windowed per segment; xs increasing, ys decreasing)."""
    dist = np.full((len(ys), len(xs)), cap_m, np.float32)
    neg_ys = -ys
    for (ax, ay), (bx, by) in zip(line_xy[:-1], line_xy[1:]):
        c0 = int(np.searchsorted(xs, min(ax, bx) - cap_m))
        c1 = int(np.searchsorted(xs, max(ax, bx) + cap_m, side="right"))
        r0 = int(np.searchsorted(neg_ys, -(max(ay, by) + cap_m)))
        r1 = int(np.searchsorted(neg_ys, -(min(ay, by) - cap_m), side="right"))
        if c0 >= c1 or r0 >= r1:
            continue
        xw = (xs[c0:c1] - ax).astype(np.float32)[None, :]
        yw = (ys[r0:r1] - ay).astype(np.float32)[:, None]
        dx, dy = float(bx - ax), float(by - ay)
        t = np.clip((xw * dx + yw * dy) / max(dx * dx + dy * dy, 1e-9), 0.0, 1.0)
        window = dist[r0:r1, c0:c1]
        np.minimum(window, np.sqrt((xw - t * dx) ** 2 + (yw - t * dy) ** 2), out=window)
    return dist


def _s02_logistic(x):
    return 1.0 / (1.0 + np.exp(-x))


def _s02_magnus_vpd(t_c: np.ndarray, rh_pct: np.ndarray) -> np.ndarray:
    """Vapour-pressure deficit (kPa) from air temperature (°C) and relative humidity (%), Magnus-Tetens."""
    es = 0.6108 * np.exp(17.27 * t_c / (t_c + 237.3))
    return (es * (1.0 - np.clip(rh_pct, 0.0, 100.0) / 100.0)).astype(np.float32)


def _s02_py(obj):
    """Recursively convert numpy scalars/arrays and tuples to plain JSON-able Python objects."""
    if isinstance(obj, dict):
        return {(int(k) if isinstance(k, (np.integer,)) else k): _s02_py(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_s02_py(v) for v in obj]
    if isinstance(obj, np.ndarray):
        return [_s02_py(v) for v in obj.tolist()]
    if isinstance(obj, (np.floating, float)):
        value = float(obj)
        return None if not np.isfinite(value) else round(value, 6)
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, np.bool_):
        return bool(obj)
    return obj

# %% [markdown]
# ## 2.2 Static world: grids, geography, water, Landsat footprints, climatology
# * Elevation is built at the fine grid (250 m): plain + Aravalli ridge (Gaussian cross-section, relief and width
#   growing along the ridge) + floodplain incision + hillocks; slope/aspect are computed at the fine grid and
#   averaged to 1 km (aspect as sin/cos *before* averaging, as the GEE recipe does).
# * The rural land-cover template (cropland, other vegetation, barren, forest, water) is built at the land-cover
#   resolution with the v1 rules; rivers are narrow channels with sand bars, jheels are random ellipses whose
#   occurrence (JRC-like `water_occ`) is drawn per lake (seasonal ones are dry, i.e. not water, in Apr–Jun).
# * WRS-2 path 146 (east) and 147 (west) overlap in a ~35 km strip; rows 039/040/041 split by latitude.

# %%
def _s02_context() -> dict:
    """Grid geometry shared by every generator step (fine grid, land-cover grid, masks, coordinates)."""
    res = int(GRID.res)
    res_f = int(GRID_FINE.res)
    if res % res_f:
        raise ValueError(f"fine grid {res_f} m must divide the analysis grid {res} m")
    f = res // res_f
    r_lc = _s02_lc_res()
    if r_lc <= 0 or res % r_lc:
        raise ValueError(f"CFG.LC_FINE_RES_M={r_lc} must be a positive divisor of GRID_RES_M={res}")
    h, w = GRID.shape
    hf, wf = GRID_FINE.shape
    if (hf, wf) != (h * f, w * f):
        raise ValueError(f"GRID_FINE shape {(hf, wf)} is not {f} x GRID shape {(h, w)}")
    roi = np.asarray(ROI_MASK, bool)
    roi_f = globals().get("ROI_MASK_FINE")
    roi_f = np.repeat(np.repeat(roi, f, 0), f, 1) if roi_f is None else np.asarray(roi_f, bool)
    if roi_f.shape != (hf, wf):
        raise ValueError(f"ROI_MASK_FINE shape {roi_f.shape} != fine grid {(hf, wf)}")
    f_lc = res // r_lc
    lc_grid = GRID.fine(r_lc)
    lon, lat = GRID.lonlat()
    lon_f, lat_f = GRID_FINE.lonlat()
    cells = np.flatnonzero(roi.ravel())
    district = np.asarray(DISTRICT_IDX).ravel()[cells].astype(np.int64)
    ctx = {
        "res": res, "res_f": res_f, "f": f, "r_lc": r_lc, "f_lc": f_lc, "H": h, "W": w, "Hf": hf, "Wf": wf,
        "Hl": h * f_lc, "Wl": w * f_lc, "roi": roi, "roi_f": roi_f, "lc_grid": lc_grid,
        "lon": np.asarray(lon, np.float64), "lat": np.asarray(lat, np.float64),
        "lon_f": np.asarray(lon_f, np.float32), "lat_f": np.asarray(lat_f, np.float32),
        "xs_f": GRID_FINE.x_centers(), "ys_f": GRID_FINE.y_centers(),
        "cells": cells, "cell_district": district, "n_districts": len(DISTRICTS),
        "mat_r": _s02_area_matrix(h * f_lc, r_lc, hf, res_f), "mat_c": _s02_area_matrix(w * f_lc, r_lc, wf, res_f),
    }
    # SW -> NE climate coordinate g in (-1, 1) at 1 km and at the fine grid (NE positive).
    ctx["g"] = np.tanh(((ctx["lon"] - 77.0) * 0.7 + (ctx["lat"] - 28.4) * 0.7) / 0.8).astype(np.float32)
    # Irrigated north-east (Karnal/Panipat belt + western-UP sugarcane belt) and the arid south-west.
    lon_f, lat_f = ctx["lon_f"], ctx["lat_f"]
    haryana_ne = _s02_logistic((lat_f - 29.05) / 0.12) * _s02_logistic((lon_f - 76.75) / 0.15)
    west_up = _s02_logistic((lon_f - 77.25) / 0.12) * _s02_logistic((lat_f - 28.75) / 0.12)
    ctx["irrig_f"] = np.maximum(haryana_ne, west_up).astype(np.float32)
    ctx["arid_f"] = _s02_logistic(((76.5 - lon_f) + (28.3 - lat_f)) / 0.35).astype(np.float32)
    return ctx


def _s02_geography(ctx: dict) -> dict:
    """Fine elevation (m), slope (deg), aspect sin/cos, 7 km TPI and ridge proximity (fine float32 fields)."""
    res_f, shape_f = ctx["res_f"], (ctx["Hf"], ctx["Wf"])
    xs, ys = ctx["xs_f"], ctx["ys_f"]
    ridge_d, ridge_t = _s02_polyline_distance_position(xs, ys, _s02_lonlat_to_xy(_S02_ARAVALLI))
    relief = 80.0 + 470.0 * ridge_t ** 1.3                    # ~300 m a.s.l. at the Delhi ridge, ~650 m near Alwar
    width = 3000.0 + 7000.0 * ridge_t
    undulation = 0.75 + 0.25 * np.tanh(_s02_noise_m(shape_f, res_f, 6000.0, 1))
    ridge = relief * undulation * np.exp(-0.5 * (ridge_d / width) ** 2)
    lon_f, lat_f = ctx["lon_f"], ctx["lat_f"]
    plain = np.clip(205.0 + 22.0 * (lat_f - 28.3) - 12.0 * (lon_f - 77.2), 180.0, 260.0)
    d_river = np.minimum(_s02_polyline_distance_capped(xs, ys, _s02_lonlat_to_xy(_S02_YAMUNA), 12000.0),
                         _s02_polyline_distance_capped(xs, ys, _s02_lonlat_to_xy(_S02_GANGA), 12000.0))
    incision = 7.0 * np.exp(-d_river / 2500.0)                 # floodplains a few metres below the plain
    hillocks = 4.0 * _s02_noise_m(shape_f, res_f, 1500.0, 2) + 1.2 * _s02_noise_m(shape_f, res_f, 500.0, 3)
    elevation = (plain + ridge - incision + hillocks).astype(np.float32)
    dz_row, dz_col = np.gradient(elevation, float(res_f))
    gx, gy_north = dz_col, -dz_row                            # rows run southwards
    slope = np.degrees(np.arctan(np.hypot(gx, gy_north))).astype(np.float32)
    aspect = np.arctan2(-gx, -gy_north)                        # direction the slope faces, clockwise from north
    ridge_prox = (np.exp(-0.5 * (ridge_d / (1.3 * width)) ** 2) * np.clip(relief / 300.0, 0.3, 1.0)).astype(np.float32)
    tpi = elevation - _s02_box_mean(elevation, _s02_px(_S02_DAY["tpi_window_m"], res_f))
    return {"elevation_f": elevation, "slope_f": slope, "aspect_sin_f": np.sin(aspect).astype(np.float32),
            "aspect_cos_f": np.cos(aspect).astype(np.float32), "tpi_f": tpi.astype(np.float32),
            "ridge_prox_f": ridge_prox}


def _s02_lakes(ctx: dict, rng: np.random.Generator):
    """Elliptical ponds/jheels (~1 per 150 km² of ROI, 150-700 m semi-axes) on the land-cover grid.

    Returns the lake mask and the per-pixel JRC-like occurrence (0..1) drawn per lake: perennial lakes have an
    occurrence above 0.5, seasonal jheels below (they are dry - not water - in the pre-monsoon land cover).
    """
    f, r_lc = ctx["f_lc"], ctx["r_lc"]
    hl, wl = ctx["Hl"], ctx["Wl"]
    lakes = np.zeros((hl, wl), bool)
    occ = np.zeros((hl, wl), np.float32)
    roi_cells = np.flatnonzero(ctx["roi"])
    cell_km2 = (ctx["res"] / 1000.0) ** 2
    n_lakes = max(8, int(roi_cells.size * cell_km2 / 150.0))
    for cell in rng.choice(roi_cells, size=min(n_lakes, roi_cells.size), replace=False):
        r, c = divmod(int(cell), ctx["W"])
        cy, cx = (r + rng.random()) * f, (c + rng.random()) * f
        ry, rx = rng.uniform(150, 700) / r_lc, rng.uniform(150, 700) / r_lc
        lake_occ = float(rng.uniform(0.25, 0.98))
        r0, r1 = max(0, int(cy - ry) - 1), min(hl, int(cy + ry) + 2)
        c0, c1 = max(0, int(cx - rx) - 1), min(wl, int(cx + rx) + 2)
        yy, xx = np.mgrid[r0:r1, c0:c1]
        inside = ((yy + 0.5 - cy) / max(ry, 0.5)) ** 2 + ((xx + 0.5 - cx) / max(rx, 0.5)) ** 2 <= 1.0
        lakes[r0:r1, c0:c1] |= inside
        occ[r0:r1, c0:c1] = np.where(inside, np.maximum(occ[r0:r1, c0:c1], lake_occ), occ[r0:r1, c0:c1])
    return lakes, occ


def _s02_static_landcover(ctx: dict, geo: dict) -> dict:
    """Epoch-independent land-cover-grid layers (shared noise => temporally coherent land cover; v1 rules)."""
    r = ctx["r_lc"]
    shape = (ctx["Hl"], ctx["Wl"])
    lc_grid = ctx["lc_grid"]
    xs, ys = lc_grid.x_centers(), lc_grid.y_centers()
    cap = 4000.0
    meander = 120.0 * _s02_noise_m(shape, r, 800.0, 10)
    d_yam = _s02_polyline_distance_capped(xs, ys, _s02_lonlat_to_xy(_S02_YAMUNA), cap)
    d_gan = _s02_polyline_distance_capped(xs, ys, _s02_lonlat_to_xy(_S02_GANGA), cap)
    river_rel = np.minimum((d_yam + meander) / 170.0, (d_gan + meander) / 320.0)   # in channel half-widths
    river_m = np.minimum(d_yam, d_gan)
    del d_yam, d_gan, meander

    tex = _s02_noise_m(shape, r, 250.0, 12)        # field-scale texture
    patch = _s02_noise_m(shape, r, 1500.0, 13)     # landscape-scale patches
    ridge = _s02_bilinear(geo["ridge_prox_f"], ctx["res_f"], r)
    arid = _s02_bilinear(ctx["arid_f"], ctx["res_f"], r)
    base = np.full(shape, _S02_CROP, np.uint8)
    base[0.6 * patch + 0.4 * tex > 0.72] = _S02_OTHER                                   # grass / fallow / shrub
    base[(river_m < 3000) & (0.5 * patch + 0.5 * tex > 0.6)] = _S02_OTHER              # floodplain grassland
    base[arid + 0.45 * patch + 0.2 * tex > 1.25] = _S02_BARREN                         # SW Haryana / Rajasthan
    base[(ridge > 0.25) & (ridge + 0.35 * patch > 0.85)] = _S02_BARREN                 # rocky foothills
    base[(river_rel > 1.0) & (river_rel < 1.0 + 700.0 / 170.0) & (tex > 0.3)] = _S02_BARREN   # sand bars
    base[ridge + 0.3 * tex > 0.75] = _S02_FOREST                                         # Aravalli scrub forest
    base[(river_m < 1500) & (tex > 1.0)] = _S02_FOREST                                   # riparian trees
    base[tex > 2.1] = _S02_FOREST                                                         # groves / farm forestry
    del ridge, arid

    lakes, lake_occ = _s02_lakes(ctx, _s02_rng(11))
    channel = river_rel < 1.0
    occurrence = np.zeros(shape, np.float32)
    occurrence[channel] = np.clip(1.02 - 0.55 * river_rel[channel], 0.45, 1.0)
    margin = (river_rel >= 1.0) & (river_rel < 2.0)
    occurrence[margin] = 0.12 * (2.0 - river_rel[margin])                               # seasonally flooded margins
    occurrence = np.maximum(occurrence, lake_occ)
    water = channel | (lakes & (lake_occ >= 0.5))
    base[lakes & ~water] = _S02_OTHER                                                   # dry seasonal jheel beds
    park = _s02_noise_m(shape, r, 150.0, 14)
    static = {
        "base": base,
        "built_noise": (0.22 * tex + 0.10 * patch).astype(np.float32),
        "village": _s02_noise_m(shape, r, 120.0, 15),
        "park": park > 1.9,
        "lawn": (park > 1.5) & (park <= 1.9),
        "water": water,
        "occurrence": occurrence,
        "ghsl_noise": _s02_noise_m(shape, r, 300.0, 16),
        "glc_confusion": _s02_noise_m(shape, r, 300.0, 17),
    }
    del tex, patch, park, river_rel, river_m, lakes, lake_occ
    return static


def _s02_landsat_geometry(ctx: dict) -> dict:
    """WRS-2 path coverage masks, row splits and the SLC-off gap pattern on the fine grid."""
    lon, lat = ctx["lon_f"], ctx["lat_f"]
    tilt = _S02_WRS["tilt_deg_lon_per_deg_lat"] * (lat - _S02_WRS["lat_ref"])
    cover = {"147": lon <= _S02_WRS["east_edge_147"] + tilt, "146": lon >= _S02_WRS["west_edge_146"] + tilt}
    split = _S02_WRS["row_split"]
    rows = {"147": np.where(lat > split["147"][0], 39, np.where(lat > split["147"][1], 40, 41)).astype(np.int8),
            "146": np.where(lat > split["146"][1], 40, 41).astype(np.int8)}
    slc_gap = {}
    km_per_deg_lon = 111.32 * np.cos(np.radians(lat))
    for path in ("146", "147"):
        across_km = (lon - (_S02_WRS["centre"][path] + tilt)) * km_per_deg_lon
        along_km = lat * 110.6
        phase = 0.7 if path == "146" else 0.0
        stripes = 0.5 + 0.5 * np.sin(2.0 * np.pi * (along_km / 1.0) + phase)
        # Gaps widen from zero at the scene centre to ~25 % of the area at the swath edge (Landsat 7 SLC-off).
        slc_gap[path] = (0.25 * np.clip(np.abs(across_km) / _S02_WRS["half_swath_km"], 0.0, 1.0) * stripes
                         ).astype(np.float32)
    return {"cover": cover, "rows": rows, "slc_gap": slc_gap}

# %% [markdown]
# ## 2.3 Climate: ERA5-Land-like annual anomalies, frame fields and planted levels
# NCR-mean Apr–Jun anomalies are generated for 1985–2030 from AR(1) innovations with a common hot-dry mode (hot
# years have lower soil moisture and humidity), warming of 0.20 K/decade (Tmax) and 0.25 K/decade (Tmin) and a
# slow solar dimming. A frame field is the static climatology + the **mean anomaly over the frame window** + a tiny
# frame pattern, so the ROI mean of every frame field equals the mean of the NCR annual series over that window.
# Levels: `L(y) = base + trend·(y−2010)/10 + β·(T(y) − T_ref) + γ·(swvl1(y) − swvl1_ref)` with reference period
# 2000–2020; a frame level is the mean of `L(y)` over its window.

# %%
def _s02_annual_climate(years: np.ndarray) -> dict:
    """NCR-mean annual anomalies (Apr-Jun; precipitation Jan-Mar as a multiplicative factor) for ``years``."""
    rng = _s02_rng(40)
    n = len(years)
    z = np.zeros((8, n))
    innov = rng.standard_normal((8, n))
    for t in range(n):
        z[:, t] = (0.25 * z[:, t - 1] if t else 0.0) + np.sqrt(1 - 0.25 ** 2) * innov[:, t]
    dy = years - 2005.0
    d = {}
    d["era5_tmax"] = 0.020 * dy + 0.70 * z[0]
    d["era5_tmin"] = 0.025 * dy + 0.55 * (0.75 * z[0] + 0.66 * z[1])
    d["era5_t2m"] = 0.5 * (d["era5_tmax"] + d["era5_tmin"]) + 0.05 * z[7]
    d["era5_swvl1"] = -0.010 * z[0] + 0.014 * z[2] + 0.0002 * dy
    d["era5_rh"] = -2.5 * z[0] + 3.0 * z[2]
    d["era5_evap"] = 25.0 * d["era5_swvl1"] + 0.05 * z[3]
    d["era5_ssr"] = 0.35 * z[0] - 0.2 * z[2] - 0.025 * dy
    d["era5_wind"] = 0.12 * z[3]
    d["era5_precip_jfm"] = np.exp(0.35 * z[4] - 0.06)          # multiplicative factor
    d["era5_skin_day"] = 1.25 * d["era5_tmax"] - 15.0 * d["era5_swvl1"] + 0.12 * z[5]
    d["era5_skin_night"] = 1.0 * d["era5_tmin"] + 6.0 * d["era5_swvl1"] + 0.10 * z[6]
    return {k: v.astype(np.float64) for k, v in d.items()}


def _s02_levels(years: np.ndarray, anom: dict, ref_period) -> dict:
    """Planted annual absolute levels (°C) for day (10:45 IST, Landsat units) and night (Aqua-equivalent)."""
    ref = (years >= ref_period[0]) & (years <= ref_period[1])
    out = {}
    for mode, p in _S02_LEVEL.items():
        temp = anom[p["temperature_var"]]
        sw = anom["era5_swvl1"]
        out[mode] = (p["base_c"] + p["trend_per_decade"] * (years - 2010.0) / 10.0
                     + p["beta"] * (temp - temp[ref].mean()) + p["gamma_swvl1"] * (sw - sw[ref].mean()))
    return out


def _s02_climatology(ctx: dict, geo: dict) -> dict:
    """Static 1 km climatology fields (unmasked) incl. ERA5-scale elevation lapse for temperatures."""
    shape, res = (ctx["H"], ctx["W"]), ctx["res"]
    g = ctx["g"]
    elev_1km, _ = _s02_block_mean(geo["elevation_f"], ctx["f"])
    elev_smooth = _s02_ndi.gaussian_filter(np.nan_to_num(elev_1km, nan=220.0), 9000.0 / res, mode="nearest")
    clim = {}
    for i, (var, (centre, slope, amp)) in enumerate(_S02_CLIM.items()):
        pattern = _s02_noise_m(shape, res, 40000.0, 50, i)
        field = centre + slope * g + amp * pattern
        if var in _S02_LAPSE_VARS:
            field = field - 0.0065 * (elev_smooth - 220.0)
        clim[var] = field.astype(np.float32)
    clim["era5_swvl1"] = np.clip(clim["era5_swvl1"], 0.05, 0.45)
    clim["era5_precip_jfm"] = np.maximum(clim["era5_precip_jfm"], 5.0)
    return clim


def _s02_frame_climate(ctx: dict, clim: dict, anom: dict, years: np.ndarray, year: int, window) -> dict:
    """ERA5-like 1 km fields of one frame (unmasked, float32); VPD from the frame t2m and RH (Magnus)."""
    sel = (years >= window[0]) & (years <= window[1])
    shape, res = (ctx["H"], ctx["W"]), ctx["res"]
    out = {}
    for i, var in enumerate(_S02_ERA5_KEYS):
        if var == "era5_vpd":
            continue
        frame_pattern = 0.08 * _S02_CLIM[var][2] * _s02_noise_m(shape, res, 60000.0, 51, year, i)
        if var == "era5_precip_jfm":
            field = clim[var] * float(anom[var][sel].mean()) + frame_pattern
            field = np.maximum(field, 1.0)
        else:
            field = clim[var] + float(anom[var][sel].mean()) + frame_pattern
        out[var] = field.astype(np.float32)
    out["era5_rh"] = np.clip(out["era5_rh"], 5.0, 95.0).astype(np.float32)
    out["era5_swvl1"] = np.clip(out["era5_swvl1"], 0.04, 0.45).astype(np.float32)
    out["era5_evap"] = np.maximum(out["era5_evap"], 0.05).astype(np.float32)
    out["era5_wind"] = np.maximum(out["era5_wind"], 0.3).astype(np.float32)
    out["era5_vpd"] = _s02_magnus_vpd(out["era5_t2m"], out["era5_rh"])
    return {k: out[k] for k in _S02_ERA5_KEYS}

# %% [markdown]
# ## 2.4 Urban growth and land cover (true surface, GHSL-like and GLC-like products)
# Urban intensity is a probabilistic union of Gaussian kernels whose radii follow the per-centre logistic
# trajectories. Land cover per year follows the v1 rules (urban core + noise + villages ⇒ built; parks/lawns inside
# new urban cores; water last) with **irreversible** built-up. The GLC-like product adds a static class confusion
# (cropland ↔ other vegetation, barren → other vegetation) and a small year-specific confusion, so `glc_*` agree
# with GHSL `built_f` without being identical — exactly the cross-product situation of the real data.

# %%
def _s02_centre_radius_km(r1990: float, r2025: float, mid: float, tau: float, year: float) -> float:
    """Logistic radius trajectory passing exactly through r1990 (1990) and r2025 (2025)."""
    s = lambda y: 1.0 / (1.0 + _s02_math.exp(-(y - mid) / tau))  # noqa: E731
    return r1990 + (r2025 - r1990) * (s(year) - s(1990)) / (s(2025) - s(1990))


def _s02_urban_intensity(ctx: dict, year: float, centres_xy: np.ndarray) -> np.ndarray:
    """Fine-grid urban intensity (0..1): windowed probabilistic union of Gaussian urban kernels."""
    xs, ys = ctx["xs_f"], ctx["ys_f"]
    neg_ys = -ys
    not_urban = np.ones((ctx["Hf"], ctx["Wf"]), np.float32)
    for (_name, _, _, amp, r90, r25, mid, tau), (cx, cy) in zip(_S02_URBAN_CENTRES, centres_xy):
        r_m = 1000.0 * _s02_centre_radius_km(r90, r25, mid, tau, year)
        reach = 4.5 * r_m
        c0, c1 = int(np.searchsorted(xs, cx - reach)), int(np.searchsorted(xs, cx + reach, side="right"))
        r0, r1 = int(np.searchsorted(neg_ys, -(cy + reach))), int(np.searchsorted(neg_ys, -(cy - reach), side="right"))
        if c0 >= c1 or r0 >= r1:
            continue
        dx = (xs[c0:c1] - cx).astype(np.float32)[None, :]
        dy = (ys[r0:r1] - cy).astype(np.float32)[:, None]
        kernel = amp * np.exp(-0.5 * (dx * dx + dy * dy) / (r_m * r_m))
        not_urban[r0:r1, c0:c1] *= 1.0 - kernel
    return 1.0 - not_urban


def _s02_mask_lc_inplace(lc: np.ndarray, roi: np.ndarray, f: int) -> None:
    """Zero land-cover pixels whose parent 1 km cell is outside the ROI (no fine mask materialised)."""
    h, w = roi.shape
    view = lc.reshape(h, f, w, f)
    view *= roi[:, None, :, None].astype(lc.dtype)


def _s02_true_landcover(static: dict, urban_lc: np.ndarray, ctx: dict, previous_built, year: float) -> np.ndarray:
    """True land cover of one year (uint8 1..6, 0 outside the ROI): rural base + irreversible urbanisation."""
    step = (year - 2010.0) / 5.0
    urban_core = urban_lc > 0.35
    if previous_built is not None:
        urban_core &= ~previous_built
    parks = urban_core & static["park"]
    lawns = urban_core & static["lawn"]
    built = (urban_lc + static["built_noise"] > 0.45) | (static["village"] > 2.10 - 0.06 * step)
    built &= ~(parks | lawns)
    built &= ~static["water"]
    if previous_built is not None:
        built |= previous_built
    lc = static["base"].copy()
    lc[built] = _S02_BUILT
    lc[lawns & ~built] = _S02_OTHER
    lc[parks & ~built] = _S02_FOREST
    lc[static["water"]] = _S02_WATER
    _s02_mask_lc_inplace(lc, ctx["roi"], ctx["f_lc"])
    return lc


def _s02_glc_product(lc_true: np.ndarray, static: dict, ctx: dict, year: int) -> np.ndarray:
    """GLC_FCS30D-like classification of the true land cover (static + year-specific confusion; uint8)."""
    lc = lc_true.copy()
    conf = static["glc_confusion"] > 1.88                                       # ~3 % persistent confusion
    lc[conf & (lc_true == _S02_CROP)] = _S02_OTHER
    lc[conf & (lc_true == _S02_OTHER)] = _S02_CROP
    lc[conf & (lc_true == _S02_BARREN)] = _S02_OTHER
    yearly = _s02_noise_m(lc.shape, ctx["r_lc"], 200.0, 60, year) > 2.33        # ~1 % year-specific confusion
    swap = yearly & ((lc == _S02_CROP) | (lc == _S02_OTHER))
    lc[swap] = np.where(lc[swap] == _S02_CROP, _S02_OTHER, _S02_CROP).astype(np.uint8)
    _s02_mask_lc_inplace(lc, ctx["roi"], ctx["f_lc"])
    return lc


def _s02_lc_block_fractions(lc: np.ndarray, f: int) -> np.ndarray:
    """(H, W, 6) fractions of classes 1..6 inside each f x f land-cover block (bincount, no one-hot copy)."""
    h, w = lc.shape[0] // f, lc.shape[1] // f
    block_of_row = (np.arange(lc.shape[0]) // f) * w
    block_of_col = np.arange(lc.shape[1]) // f
    key = (block_of_row[:, None] + block_of_col[None, :]) * 7 + lc
    counts = np.bincount(key.ravel(), minlength=h * w * 7).reshape(h, w, 7)
    return (counts[..., 1:] / float(f * f)).astype(np.float32)


def _s02_fine_fractions(lc: np.ndarray, ctx: dict) -> np.ndarray:
    """(6, Hf, Wf) area fractions of classes 1..6 on the fine grid (exact area overlap from the LC grid)."""
    out = np.empty((6, ctx["Hf"], ctx["Wf"]), np.float32)
    for k in range(6):
        out[k] = _s02_area_resample((lc == k + 1).astype(np.float32), ctx["mat_r"], ctx["mat_c"])
    np.clip(out, 0.0, 1.0, out=out)
    return out


def _s02_ghsl_built(lc_true: np.ndarray, urban_lc: np.ndarray, static: dict, ctx: dict) -> np.ndarray:
    """GHSL-like built-up surface fraction at the fine grid (from a 100 m-like built density)."""
    noise = static["ghsl_noise"]
    is_built = lc_true == _S02_BUILT
    dens = np.where(is_built, np.clip(0.42 + 0.45 * urban_lc + 0.10 * noise, 0.15, 0.95),
                    np.clip(0.03 * urban_lc + 0.015 * np.maximum(noise, 0.0), 0.0, 0.08)).astype(np.float32)
    dens[lc_true == 0] = 0.0
    dens[lc_true == _S02_WATER] = 0.0
    return np.clip(_s02_area_resample(dens, ctx["mat_r"], ctx["mat_c"]), 0.0, 1.0)


def _s02_population(ctx: dict, urban_1km: np.ndarray, built_1km: np.ndarray, water_1km: np.ndarray,
                    year: float) -> np.ndarray:
    """GHSL-POP-like density (persons/km², 1 km) renormalised to a geometric NCR total trajectory."""
    total = _S02_POP_TOTAL["1990"] * (_S02_POP_TOTAL["2025"] / _S02_POP_TOTAL["1990"]) ** ((year - 1990.0) / 35.0)
    shape, res = (ctx["H"], ctx["W"]), ctx["res"]
    rural = 420.0 * np.exp(0.3 * _s02_noise_m(shape, res, 12000.0, 70))
    raw = (rural * (1.0 + 0.2 * ctx["g"]) + 30000.0 * np.clip(urban_1km, 0, 1) ** 2.2 + 2500.0 * built_1km)
    raw = raw * (1.0 - np.clip(water_1km, 0.0, 1.0))
    roi = ctx["roi"]
    area_km2 = (res / 1000.0) ** 2
    scale = total / max(float(raw[roi].sum() * area_km2), 1.0)
    return np.maximum(raw * scale, 0.0).astype(np.float32)

# %% [markdown]
# ## 2.5 Spectral fields and planted LST
# Spectral indices are class-signature mixtures of the fine land-cover fractions with irrigation / aridity
# modifiers, field-scale texture and sensor noise. The planted anomaly terms are evaluated on the fine grid; the
# 1 km truth is their block mean, and the frame anomaly is centred to zero mean over the ROI at 1 km.

# %%
def _s02_spectral(fr: np.ndarray, built_f: np.ndarray, ctx: dict, clim_f: dict, year: int) -> dict:
    """True (surface) Landsat-like indices at the fine grid from land-cover fractions (6, Hf, Wf)."""
    shape, res_f = (ctx["Hf"], ctx["Wf"]), ctx["res_f"]
    irrig, arid = ctx["irrig_f"], ctx["arid_f"]
    crop, barren, other = fr[3], fr[4], fr[5]
    rng = _s02_rng(80, year)
    mix = {k: np.tensordot(np.asarray(v, np.float32), fr, axes=([0], [0])) for k, v in _S02_SIG.items()}
    crop_shift = float(rng.normal(0.0, 0.008))          # year-specific harvest timing
    spring_shift = float(rng.normal(0.0, 0.02))
    greening = 0.010 * (year - 2007.5) / 10.0           # slow irrigation intensification
    tex_static = _s02_noise_m(shape, res_f, 1000.0, 81)
    tex_frame = _s02_noise_m(shape, res_f, 5000.0, 82, year)
    white = lambda sd, tag: sd * _s02_rng(83, year, tag).standard_normal(shape, dtype=np.float32)  # noqa: E731

    ndvi = (mix["ndvi"] + crop * (0.20 * irrig - 0.04 * arid + crop_shift + greening * irrig) + other * 0.06 * irrig
            - 0.03 * barren * arid + 0.03 * tex_static + 0.012 * tex_frame + white(0.012, 1))
    spring = (mix["ndvi_spring"] + crop * (-0.06 * irrig - 0.15 * arid + spring_shift) + other * 0.04 * irrig
              + 0.03 * tex_static + 0.02 * _s02_noise_m(shape, res_f, 5000.0, 84, year) + white(0.012, 2))
    green_dev = ndvi - mix["ndvi"]
    ndbi = mix["ndbi"] - 0.25 * green_dev + 0.03 * built_f + 0.02 * _s02_noise_m(shape, res_f, 2000.0, 85, year) \
        + white(0.010, 3)
    mndwi = mix["mndwi"] + 0.25 * (clim_f["era5_swvl1"] - 0.18) + 0.025 * _s02_noise_m(shape, res_f, 2000.0, 86, year) \
        + white(0.010, 4)
    # Within-class surface brightness (soil colour / roof material, static, ~2.5 km patches, sd 0.018): real
    # albedo varies strongly inside every land-cover class. Without it albedo would be an almost exact linear
    # mixture of the class fractions, so the planted albedo cooling could not be separated from the barren /
    # cropland terms by any model (integrator finding: the recovered albedo effect then had the wrong sign).
    albedo = (mix["albedo"] + barren * 0.05 * arid + crop * (0.02 * (1.0 - irrig) - 0.03 * irrig)
              + 0.018 * _s02_noise_m(shape, res_f, 2500.0, 19) + 0.008 * tex_static + 0.004 * tex_frame
              + white(0.005, 5))
    return {"ndvi": np.clip(ndvi, -0.3, 0.9).astype(np.float32),
            "ndvi_spring": np.clip(spring, -0.3, 0.9).astype(np.float32),
            "ndbi": np.clip(ndbi, -0.8, 0.8).astype(np.float32),
            "mndwi": np.clip(mndwi, -0.8, 0.9).astype(np.float32),
            "albedo": np.clip(albedo, 0.03, 0.45).astype(np.float32)}


def _s02_planted_terms(mode: str, spec: dict, fr: np.ndarray, built_f: np.ndarray, bv_f: np.ndarray, geo: dict,
                       clim_f: dict, dist_water_m: np.ndarray, ctx: dict) -> dict:
    """Planted anomaly terms (°C, fine float32) keyed by SHAP group (SPEC §4.4 names)."""
    roi_f, res_f = ctx["roi_f"], ctx["res_f"]
    ndvi = spec["ndvi"]
    water_local = _s02_box_mean(fr[2], _s02_px(1000.0, res_f), valid=roi_f)
    sw = clim_f["era5_swvl1"] - float(np.nanmean(clim_f["era5_swvl1"][roi_f]))
    vpd = clim_f["era5_vpd"] - float(np.nanmean(clim_f["era5_vpd"][roi_f]))
    terms = {}
    if mode == "day":
        p = _S02_DAY
        ndvi_focal = _s02_box_mean(ndvi, _s02_px(p["park_window_m"], res_f), valid=roi_f)
        drop = spec["ndvi_spring"] - ndvi
        terms["ndvi"] = (p["ndvi_cooling_c"] * np.clip(ndvi, 0.0, p["ndvi_saturation"]) / p["ndvi_saturation"]
                         + p["park_cooling_c"] * np.clip((ndvi_focal - p["park_onset"])
                                                         / (p["park_full"] - p["park_onset"]), 0.0, 1.0))
        terms["phenology"] = p["harvest_heating_c"] * np.clip((drop - p["harvest_onset"])
                                                              / (p["harvest_full"] - p["harvest_onset"]), 0.0, 1.0)
        terms["albedo"] = p["albedo_per_unit"] * (spec["albedo"] - p["albedo_ref"])
        terms["built"] = p["built_per_unit"] * built_f
        terms["barren"] = p["barren_per_unit"] * fr[4]
        terms["water"] = (p["water_cooling_c"] * (1.0 - np.exp(-water_local / p["water_scale"]))
                          + p["water_reach_c"] * np.exp(-dist_water_m / p["water_reach_m"]))
        terms["climate_moisture"] = p["swvl1_per_unit"] * sw + p["vpd_per_kpa"] * vpd
        terms["terrain"] = p["lapse_per_m"] * (geo["elevation_f"] - p["elev_ref_m"]) + p["tpi_per_m"] * geo["tpi_f"]
    else:
        p = _S02_NIGHT
        norm = 1.0 - _s02_math.exp(-1.0 / p["built_scale"])
        terms["built"] = p["built_c"] * (1.0 - np.exp(-built_f / p["built_scale"])) / norm
        terms["built_volume"] = p["built_v_per_log1p"] * np.log1p(np.maximum(bv_f, 0.0))
        terms["water"] = p["water_warming_c"] * (1.0 - np.exp(-water_local / p["water_scale"]))
        terms["ndvi"] = p["ndvi_per_unit"] * ndvi
        terms["barren"] = p["barren_per_unit"] * fr[4]
        terms["terrain"] = p["lapse_per_m"] * (geo["elevation_f"] - p["elev_ref_m"]) + p["tpi_per_m"] * geo["tpi_f"]
        terms["climate_moisture"] = p["swvl1_per_unit"] * sw + p["vpd_per_kpa"] * vpd
    return {k: np.nan_to_num(v.astype(np.float32), nan=0.0) for k, v in terms.items()}


def _s02_planted_noise(mode: str, ctx: dict, year: int, persistent: np.ndarray) -> np.ndarray:
    """Spatially-correlated (persistent + frame) and white noise of the planted surface field (fine)."""
    shape, res_f = (ctx["Hf"], ctx["Wf"]), ctx["res_f"]
    n = _S02_NOISE
    share = n["persistent_share"]
    tag = 90 if mode == "day" else 91
    corr_sd = n["day_corr_sd"] if mode == "day" else n["night_corr_sd"]
    corr_km = n["day_corr_km"] if mode == "day" else n["night_corr_km"]
    frame = _s02_noise_m(shape, res_f, corr_km * 1000.0, tag, year)
    out = corr_sd * (np.sqrt(share) * persistent + np.sqrt(1.0 - share) * frame)
    if mode == "day":
        out += n["day_meso_sd"] * _s02_noise_m(shape, res_f, n["day_meso_km"] * 1000.0, 92, year)
    white_sd = n["day_white_sd"] if mode == "day" else n["night_white_sd"]
    out += white_sd * _s02_rng(93 if mode == "day" else 94, year).standard_normal(shape, dtype=np.float32)
    return out.astype(np.float32)

# %% [markdown]
# ## 2.6 Observation simulation (Landsat day composites, MODIS day, night products)
# **Landsat:** per WRS-2 path, the clear-scene count of a fine pixel is Binomial(scenes of its path/row, clear
# probability), reduced by SLC-off gaps for the Landsat 7 share; the per-path median composite is the raw surface
# temperature (truth shifted by the overpass bias) + the planted path offset + composite noise that shrinks with
# the number of scenes. Then the **section-03 harmonisation** runs: the path offset is estimated as the median
# 146 − 147 difference over the overlap, split ±δ/2, removed, and the paths are mosaicked (mean where both).

# %%
def _s02_landsat_day(year: int, raw_surface: np.ndarray, ctx: dict, wrs: dict) -> dict:
    """Simulated harmonised Landsat day composite (°C), clear-scene count and the estimated path offsets."""
    acq = _S02_DAY_ACQ[year]
    shape, res_f, roi_f = (ctx["Hf"], ctx["Wf"]), ctx["res_f"], ctx["roi_f"]
    counts = dict(zip(_S02_PATHROWS, acq["per_pr"]))
    rng = _s02_rng(100, year)
    clear = np.clip(0.86 + 0.05 * _s02_noise_m(shape, res_f, 15000.0, 101, year), 0.5, 0.97)
    blocked = _s02_noise_m(shape, res_f, 1500.0, 102, year) > 2.9            # persistent haze / QA holes (~0.2 %)
    planted = {"146": 0.5 * acq["path_delta"], "147": -0.5 * acq["path_delta"]}
    n = _S02_NOISE
    comps, nobs = {}, {}
    for path in ("146", "147"):
        rows = wrs["rows"][path]
        n_scenes = np.zeros(shape, np.int32)
        for row in (39, 40, 41):
            key = f"{path}/{row:03d}"
            if key in counts:
                n_scenes[rows == row] = counts[key]
        p_clear = clear * (1.0 - acq["slc_share"] * wrs["slc_gap"][path])
        covered = wrs["cover"][path] & roi_f & ~blocked
        n_obs = np.where(covered, rng.binomial(n_scenes, p_clear), 0).astype(np.int32)
        sd = n["landsat_white_base"] + n["landsat_white_per_sqrt_n"] / np.sqrt(np.maximum(n_obs, 1))
        scene_corr = n["landsat_scene_corr"] / np.sqrt(np.maximum(n_scenes, 1))
        err = (sd * _s02_rng(103, year, int(path)).standard_normal(shape, dtype=np.float32)
               + scene_corr * _s02_noise_m(shape, res_f, 6000.0, 104, year, int(path)))
        comps[path] = np.where(n_obs > 0, raw_surface + planted[path] + err, np.nan).astype(np.float32)
        nobs[path] = n_obs
    both = np.isfinite(comps["146"]) & np.isfinite(comps["147"])
    if both.sum() >= 50:
        delta = float(np.median((comps["146"] - comps["147"])[both]))
    else:
        log(f"02: frame {year}: path overlap has only {int(both.sum())} pixels; path offset set to 0", "WARNING")
        delta = 0.0
    h146, h147 = comps["146"] - 0.5 * delta, comps["147"] + 0.5 * delta
    mosaic = np.where(both, 0.5 * (h146 + h147), np.where(np.isfinite(h146), h146, h147)).astype(np.float32)
    count = (nobs["146"] + nobs["147"]).astype(np.float32)
    mosaic[count <= 0] = np.nan
    return {"lst": mosaic, "nobs": count, "path_offsets": {"146": round(0.5 * delta, 4), "147": round(-0.5 * delta, 4)},
            "planted_offsets": planted, "overlap_pixels": int(both.sum())}


def _s02_terra_drift(year: int) -> float:
    """MODIS Terra day bias (°C) from the earlier drifted overpass (0 before 2022)."""
    h = _S02_TERRA_DAY_IST.get(int(year), 11.12)
    return -(11.12 - h) * _S02_TERRA_DAY_RATE


def _s02_aqua_drift(year: int) -> float:
    """MODIS Aqua night bias (°C) from the later drifted overpass (0 up to 2022)."""
    h = _S02_AQUA_NIGHT_IST.get(int(year), 2.20)
    return -(h - 2.20) * _S02_NIGHT_COOLING_RATE


def _s02_ols(x: np.ndarray, y: np.ndarray):
    """Simple least squares y = a + b x -> (a, b)."""
    xm, ym = float(x.mean()), float(y.mean())
    var = float(((x - xm) ** 2).sum())
    b = float(((x - xm) * (y - ym)).sum() / var) if var > 0 else 1.0
    return ym - b * xm, b


def _s02_fit_calibration(src: np.ndarray, aqua: np.ndarray, cls: np.ndarray):
    """Per-class linear maps aqua = a + b*src, overall fit statistics and shrunk per-cell mean residuals.

    ``src``/``aqua``/``cls`` are (years, cells). Classes with < 30 points use the pooled map (recorded as such).
    """
    ok = np.isfinite(src) & np.isfinite(aqua)
    pooled = _s02_ols(src[ok], aqua[ok])
    by_class, pred = [], np.full(src.shape, np.nan)
    for c in range(1, 7):
        sel = ok & (cls == c)
        n_c = int(sel.sum())
        a, b = _s02_ols(src[sel], aqua[sel]) if n_c >= 30 else pooled
        by_class.append({"class": c, "a": round(float(a), 4), "b": round(float(b), 4), "n": n_c})
        pred[sel] = a + b * src[sel]
    resid = np.where(ok, aqua - pred, np.nan)
    sse = float(np.nansum(resid ** 2))
    sst = float(((aqua[ok] - aqua[ok].mean()) ** 2).sum())
    n_years = np.isfinite(resid).sum(axis=0)
    mean_resid = np.where(n_years > 0, np.nansum(resid, axis=0) / np.maximum(n_years, 1), 0.0)
    shrunk = mean_resid * n_years / (n_years + 3.0)
    summary = {"r2": round(1.0 - sse / sst, 4) if sst > 0 else None, "rmse": round(float(np.sqrt(sse / ok.sum())), 4),
               "n": int(ok.sum()), "by_class": by_class}
    coef = {d["class"]: (d["a"], d["b"]) for d in by_class}
    return summary, coef, shrunk.astype(np.float32)


def _s02_apply_calibration(src: np.ndarray, cls: np.ndarray, coef: dict, shrunk: np.ndarray) -> np.ndarray:
    """Aqua-equivalent values from source values with the fitted class maps + shrunk cell residuals."""
    a = np.zeros(src.shape, np.float64)
    b = np.ones(src.shape, np.float64)
    for c, (ac, bc) in coef.items():
        a = np.where(cls == c, ac, a)
        b = np.where(cls == c, bc, b)
    return (a + b * src + shrunk).astype(np.float32)


def _s02_planted_src(true_aqua: np.ndarray, cls: np.ndarray, kind: str) -> np.ndarray:
    """Invert the planted map aqua = a + b*src to obtain the source sensor's value (noise-free)."""
    out = np.array(true_aqua, np.float64, copy=True)
    for c, (a, b) in _S02_CAL_PLANTED[kind].items():
        sel = cls == c
        out[sel] = (true_aqua[sel] - a) / b
    return out

# %% [markdown]
# ## 2.7 Future inputs (illustrative in synthetic mode)
# * `cmip6`: 34 pseudo-GCMs (`pGCM-01…34`, deliberately not real model names) with an ROI-mean Apr–Jun tasmax /
#   tasmin for the 2025 baseline window and 2030–2050; deltas follow `k_g · Δ̄_s(y)` with a model sensitivity
#   `k_g ~ N(1, 0.3)` shared across scenarios plus scenario-specific spread (2050 vs 2025: ssp245 ≈ 1.1 ± 0.4 K,
#   ssp585 ≈ 1.7 ± 0.5 K; tasmin slightly larger).
# * `urban_growth`: Chen-2020-like decadal urban-area ratios vs 2020 per district (peri-urban districts fastest,
#   SSP1 slower, SSP5 faster), geometrically interpolated to 5-year frames.
# * `ghsl_2030`: the generator's own 2030 extrapolation; `pop_growth`: SSP urban-population factors vs 2025;
#   `gsat_increment`: AR6 WG1 Table 4.5 central values (vs 1995–2014) interpolated to the frame windows and
#   expressed relative to the 2016–2035 window.

# %%
def _s02_future_cmip6(clim_tmax_mean: float, clim_tmin_mean: float, anom: dict, years: np.ndarray) -> pd.DataFrame:
    """Pseudo-GCM ROI-mean Apr-Jun tasmax/tasmin (K) for the 2025 baseline and the projection frames."""
    rng = _s02_rng(120)
    p = _S02_CMIP6
    frames = [int(_s02_cfg("NOW", 2025))] + [int(y) for y in _s02_cfg("FRAMES_PROJ", [2030, 2035, 2040, 2045, 2050])]
    base_year = frames[0]
    k = rng.normal(1.0, p["model_sd"], p["n_models"])
    k = 1.0 + (k - k.mean()) / max(k.std(), 1e-9) * p["model_sd"]
    sel = (years >= base_year - 9) & (years <= base_year + 10)
    base = {"tasmax": clim_tmax_mean + float(anom["era5_tmax"][sel].mean()) + 273.15,
            "tasmin": clim_tmin_mean + float(anom["era5_tmin"][sel].mean()) + 273.15}
    rows = []
    for m in range(p["n_models"]):
        model = f"pGCM-{m + 1:02d}"
        bias = {v: float(rng.normal(0.0, p["bias_sd_k"])) for v in ("tasmax", "tasmin")}
        for scenario in ("ssp245", "ssp585"):
            k_s = k[m] + float(rng.normal(0.0, p["idio_sd"][scenario]))
            for var in ("tasmax", "tasmin"):
                for frame in frames:
                    frac = max(0.0, (frame - base_year) / 25.0) ** p["shape_exponent"][scenario]
                    delta = k_s * p["delta_2050"][scenario][var] * frac
                    noise = float(rng.normal(0.0, p["window_noise_k"])) if frame != base_year else 0.0
                    scen_offset = 0.03 if (scenario == "ssp585" and frame == base_year) else 0.0
                    rows.append((scenario, model, int(frame), var,
                                 round(base[var] + bias[var] + scen_offset + delta + noise, 4)))
    return pd.DataFrame(rows, columns=["scenario", "model", "frame", "var", "value_k"])


def _s02_future_pattern(ctx: dict) -> dict:
    """Smooth ensemble-median 2050 warming pattern / ROI mean (≈ 1 ± 0.05), NaN outside the ROI."""
    shape, res, roi, g = (ctx["H"], ctx["W"]), ctx["res"], ctx["roi"], ctx["g"]
    out = {}
    for i, (var, slope) in enumerate((("tasmax", -0.04), ("tasmin", 0.03))):
        field = 1.0 + slope * g + 0.015 * _s02_noise_m(shape, res, 50000.0, 121, i)
        field = field / float(field[roi].mean())
        out[var] = np.where(roi, field, np.nan).astype(np.float32)
    return out


def _s02_future_urban(ctx: dict) -> pd.DataFrame:
    """Chen-2020-like urban-area ratio vs 2020 per (scenario, district, frame), decades interpolated geometrically."""
    frames = sorted({2020, int(_s02_cfg("NOW", 2025))} | {int(y) for y in _s02_cfg("FRAMES_PROJ", [2030, 2035, 2040,
                                                                                                    2045, 2050])})
    decades = list(range(2020, max(frames) + 10, 10))
    rows = []
    present = set(np.unique(ctx["cell_district"]).tolist())
    for scenario, mult in _S02_SSP_URBAN_MULT.items():
        for d in DISTRICTS:
            did = int(d["id"])
            if did not in present:
                continue
            r0 = _S02_URBAN_RATE.get(did, 1.5) / 100.0 * mult
            # ratio(t) = exp(∫ r0 exp(-(s-2020)/60) ds) - saturating growth
            dec = {t: _s02_math.exp(r0 * 60.0 * (1.0 - _s02_math.exp(-(t - 2020) / 60.0))) for t in decades}
            for frame in frames:
                if frame in dec:
                    ratio = dec[frame]
                else:
                    lo = max(t for t in decades if t <= frame)
                    hi = min(t for t in decades if t >= frame)
                    w = (frame - lo) / (hi - lo)
                    ratio = dec[lo] ** (1.0 - w) * dec[hi] ** w
                rows.append((scenario, did, int(frame), round(float(ratio), 5)))
    return pd.DataFrame(rows, columns=["scenario", "district", "frame", "ratio"])


def _s02_future_pop_growth() -> pd.DataFrame:
    """NCR urban-population factor vs 2025 per SSP (compound growth reaching the 2050 factor)."""
    now = int(_s02_cfg("NOW", 2025))
    frames = [now] + [int(y) for y in _s02_cfg("FRAMES_PROJ", [2030, 2035, 2040, 2045, 2050])]
    rows = []
    for scenario, f2050 in _S02_POP_FACTOR_2050.items():
        rate = _s02_math.log(f2050) / 25.0
        for frame in frames:
            rows.append((scenario, int(frame), round(_s02_math.exp(rate * (frame - now)), 5)))
    return pd.DataFrame(rows, columns=["scenario", "frame", "factor"])


def _s02_future_gsat() -> dict:
    """GSAT increment (K) of each frame window over the 2016-2035 window, from AR6 Table 4.5 central values."""
    now = int(_s02_cfg("NOW", 2025))
    frames = [now] + [int(y) for y in _s02_cfg("FRAMES_PROJ", [2030, 2035, 2040, 2045, 2050])]

    def vs_1995_2014(near: float, mid: float, centre: float) -> float:
        # piecewise-linear in window centre: 0 at 2004.5 (1995-2014), near at 2030.5, mid at 2050.5
        if centre <= 2030.5:
            return near * (centre - 2004.5) / 26.0
        return near + (mid - near) * (centre - 2030.5) / 20.0

    out = {}
    for scenario, (near, mid) in _S02_AR6_GSAT.items():
        base = vs_1995_2014(near, mid, now + 0.5)
        out[scenario] = {int(fr): round(vs_1995_2014(near, mid, fr + 0.5) - base, 4) for fr in frames}
    return out

# %% [markdown]
# ## 2.8 Generator orchestration
# One chronological pass over the land-cover years (1990 … 2025, plus 2022 for the GLC 2025 band and 2030 for the
# GHSL-2030 extrapolation). Each observation frame is processed completely inside the pass and only its RAW
# arrays are kept. Night calibration and annual series follow, as they need every frame's anomaly maps.

# %%
def _s02_generate() -> dict:
    """Build the synthetic world; returns every SPEC §3.2 global plus QA payloads (private)."""
    t_start = _s02_time.perf_counter()
    ctx = _s02_context()
    frames = sorted(int(y) for y in _s02_cfg("FRAMES_OBS", list(_S02_DEFAULT_WINDOWS)))
    unknown = [y for y in frames if y not in _S02_DAY_ACQ]
    if unknown:
        raise ValueError(f"section 02 has no synthetic acquisition table for frames {unknown}")
    windows = {int(k): tuple(int(v) for v in vals)
               for k, vals in dict(_s02_cfg("WINDOWS", _S02_DEFAULT_WINDOWS)).items()}
    for y in frames:
        windows.setdefault(y, _S02_DEFAULT_WINDOWS[y])
    ref_period = tuple(int(v) for v in _s02_cfg("REFERENCE_PERIOD", (2000, 2020)))
    roi, roi_f, f = ctx["roi"], ctx["roi_f"], ctx["f"]
    h, w, hf, wf = ctx["H"], ctx["W"], ctx["Hf"], ctx["Wf"]
    log(f"02: grid {w}x{h} @ {ctx['res']} m | fine {wf}x{hf} @ {ctx['res_f']} m | land cover "
        f"{ctx['Wl']}x{ctx['Hl']} @ {ctx['r_lc']} m | ROI {int(roi.sum()):,} cells | frames {frames}")

    # ---- static world ---------------------------------------------------------------------------------------------
    geo = _s02_geography(ctx)
    static = _s02_static_landcover(ctx, geo)
    wrs = _s02_landsat_geometry(ctx)
    occ_f = np.clip(_s02_area_resample(static["occurrence"], ctx["mat_r"], ctx["mat_c"]), 0.0, 1.0)
    clim = _s02_climatology(ctx, geo)
    centres_xy = _s02_lonlat_to_xy([(c[1], c[2]) for c in _S02_URBAN_CENTRES])
    persistent = {m: _s02_noise_m((hf, wf), ctx["res_f"], 1000.0 * _S02_NOISE[f"{m}_corr_km"], 95, i)
                  for i, m in enumerate(("day", "night"))}
    # Building typology (static, ~2.5 km patches, log-sd 0.45): towers vs dense low-rise at equal built-up share,
    # as in GHSL built_volume vs built_surface. Without it built_v was a monotone function of built_f (Spearman
    # 1.00 at 1 km), so the planted built / built_volume night terms were not separately identifiable.
    height_typology = np.exp(0.45 * _s02_noise_m((hf, wf), ctx["res_f"], 2500.0, 18)).astype(np.float32)
    log(f"02: static world ready in {_s02_time.perf_counter() - t_start:.1f}s")

    def fine_out(a):
        return np.where(roi_f, a, np.nan).astype(np.float32)

    def coarse_out(a):
        return np.where(roi, a, np.nan).astype(np.float32)

    raw_static = {}
    for key in ("elevation", "slope", "aspect_sin", "aspect_cos"):
        raw_static[key] = coarse_out(_s02_block_mean(geo[f"{key}_f"], f)[0])
    raw_static["water_occ"] = coarse_out(_s02_block_mean(occ_f, f)[0])
    raw_static["elevation_f"] = fine_out(geo["elevation_f"])
    raw_static["water_occ_f"] = fine_out(occ_f)

    # ---- climate and levels ---------------------------------------------------------------------------------------
    years = np.arange(1985, 2031)
    anom = _s02_annual_climate(years)
    lev_ann = _s02_levels(years, anom, ref_period)

    def window_mean(series, window):
        sel = (years >= window[0]) & (years <= window[1])
        return float(series[sel].mean())

    levels = {m: {y: window_mean(lev_ann[m], windows[y]) for y in frames} for m in ("day", "night")}

    # ---- chronological land-cover pass ----------------------------------------------------------------------------
    lc_years = sorted(set(range(1990, 2026, 5)) | {2022, 2030} | set(frames))
    lc_years = [y for y in lc_years if y <= max(max(frames), 2030)]
    raw_obs, lc_fine, frame_meta = {}, {}, {}
    day_anom, night_anom, dominant = {}, {}, {}
    planted_effects = {"day": {}, "night": {}}
    qa = {"night_truth_fine": {}, "built_share": {}, "uhi": {"day": {}, "night": {}}, "ndvi_support": {}}
    previous_built, previous_ghsl, glc_by_year = None, None, {}
    ghsl_2030 = None
    dist_water_m = None
    for year in lc_years:
        t0 = _s02_time.perf_counter()
        urban_f = _s02_urban_intensity(ctx, float(year), centres_xy)
        urban_lc = _s02_bilinear(urban_f, ctx["res_f"], ctx["r_lc"])
        lc_true = _s02_true_landcover(static, urban_lc, ctx, previous_built, float(year))
        previous_built = lc_true == _S02_BUILT
        glc_by_year[year] = _s02_glc_product(lc_true, static, ctx, year)
        built_f = _s02_ghsl_built(lc_true, urban_lc, static, ctx)
        if previous_ghsl is not None:
            np.maximum(built_f, previous_ghsl, out=built_f)        # GHSL built-up surface never decreases
        previous_ghsl = built_f
        vert = 1.0 / (1.0 + _s02_math.exp(-(year - 2008.0) / 5.0))
        height_f = (3.0 + 4.5 * np.clip(urban_f, 0.0, 1.0) ** 1.6 * (1.0 + 0.6 * vert)) * height_typology
        bv_f = (built_f * height_f).astype(np.float32)               # m3 of building per m2 of ground
        del urban_lc
        if year == 2030:
            urban_1km = _s02_block_mean(urban_f, f)[0]
            built_1km = _s02_block_mean(built_f, f)[0]
            water_1km = _s02_lc_block_fractions(glc_by_year[2022 if 2022 in glc_by_year else year], ctx["f_lc"])[..., 2]
            ghsl_2030 = {"built": coarse_out(built_1km),
                         "pop": coarse_out(_s02_population(ctx, urban_1km, built_1km, water_1km, 2030.0))}
            del lc_true, urban_f, built_f, bv_f, height_f
            continue
        if year not in frames:
            del lc_true, urban_f, bv_f, height_f
            continue

        # ---- one observation frame --------------------------------------------------------------------------------
        glc_year = 2022 if (year == 2025 and 2022 in glc_by_year) else year
        glc_map = glc_by_year[glc_year]
        lc_fine[year] = glc_map
        glc_frac = _s02_lc_block_fractions(glc_map, ctx["f_lc"])
        fr = _s02_fine_fractions(lc_true, ctx)
        if dist_water_m is None:                                     # water is static: compute once
            water_mask = (fr[2] >= 0.3) | (occ_f >= 0.5)
            dist_water_m = (_s02_ndi.distance_transform_edt(~water_mask) * ctx["res_f"]).astype(np.float32) \
                if water_mask.any() else np.full((hf, wf), 1e6, np.float32)
        clim_1km = _s02_frame_climate(ctx, clim, anom, years, year, windows[year])
        clim_f = {k: _s02_bilinear(clim_1km[k], ctx["res"], ctx["res_f"]) for k in ("era5_swvl1", "era5_vpd")}
        spec = _s02_spectral(fr, built_f, ctx, clim_f, year)

        for mode in ("day", "night"):
            terms = _s02_planted_terms(mode, spec, fr, built_f, bv_f, geo, clim_f, dist_water_m, ctx)
            total = sum(terms.values()) + _s02_planted_noise(mode, ctx, year, persistent[mode])
            block, _ = _s02_block_mean(total, f, valid=roi_f)
            mu = float(np.nanmean(block[roi]))
            anom_1km = (block - mu).astype(np.float32)
            (day_anom if mode == "day" else night_anom)[year] = np.where(roi, anom_1km, np.nan).astype(np.float32)
            planted_effects[mode][year] = {}
            for name, term in terms.items():
                tb = _s02_block_mean(term, f, valid=roi_f)[0][roi]
                planted_effects[mode][year][name] = float(np.nanmean(np.abs(tb - np.nanmean(tb))))
            if mode == "day":
                truth_day_f = (levels["day"][year] + total - mu).astype(np.float32)
            elif year in (frames[0], frames[-1]):
                qa["night_truth_fine"][year] = fine_out(levels["night"][year] + total - mu)
            del terms, total, block

        # Landsat composite: the truth seen at the scene overpass instead of 10:45 IST (cooler for early scenes).
        acq = _S02_DAY_ACQ[year]
        overpass_bias = -(_S02_REF_OVERPASS_IST_H - acq["overpass"]) * acq["heating"]
        ls = _s02_landsat_day(year, truth_day_f + overpass_bias, ctx, wrs)
        del truth_day_f
        valid_f = np.isfinite(ls["lst"])

        def sensor(a, sd, tag, _year=year):
            """Field + white sensor noise of a fixed stream (110, year, tag)."""
            return a + sd * _s02_rng(110, _year, tag).standard_normal(a.shape, dtype=np.float32)

        obs = {"lst_day_f": fine_out(ls["lst"]), "lst_day_nobs_f": fine_out(ls["nobs"])}
        for tag, (key, src, sd) in enumerate((("ndvi_f", "ndvi", 0.006), ("ndbi_f", "ndbi", 0.006),
                                              ("mndwi_f", "mndwi", 0.006), ("albedo_f", "albedo", 0.003))):
            obs[key] = fine_out(np.where(valid_f, sensor(spec[src], sd, tag), np.nan))
        # Feb-Mar composite: its own small gaps, and half of the pixels without any clear Apr-Jun scene.
        spring_gap = ((_s02_noise_m((hf, wf), ctx["res_f"], 1000.0, 111, year) > 3.0)
                      | ((ls["nobs"] <= 0) & (_s02_rng(112, year).random((hf, wf)) < 0.5)))
        obs["ndvi_spring_f"] = fine_out(np.where(spring_gap, np.nan, sensor(spec["ndvi_spring"], 0.006, 9)))
        obs["built_f"] = fine_out(built_f)

        # 1 km products
        built_1km = _s02_block_mean(built_f, f)[0]
        urban_1km = _s02_block_mean(urban_f, f)[0]
        bv_1km = _s02_block_mean(bv_f, f)[0]
        pop = _s02_population(ctx, urban_1km, built_1km, glc_frac[..., 2], float(year))
        coarse = {"lst_night": np.full((h, w), np.nan, np.float32), "lst_night_nobs": coarse_out(np.zeros((h, w))),
                  "built_v": coarse_out(bv_1km), "pop": coarse_out(pop)}
        if year >= 2000:
            drift_years = [y for y in range(windows[year][0], windows[year][1] + 1) if y >= 2000]
            drift = float(np.mean([_s02_terra_drift(y) for y in drift_years]))
            modis = (levels["day"][year] + _S02_TERRA_DAY_OFFSET_C + drift + 0.9 * np.nan_to_num(day_anom[year])
                     + _S02_NOISE["modis_day_corr"] * _s02_noise_m((h, w), ctx["res"], 3000.0, 113, year)
                     + _S02_NOISE["modis_day_white"] * _s02_rng(114, year).standard_normal((h, w)))
            modis[_s02_rng(115, year).random((h, w)) < 0.002] = np.nan
            coarse["lst_day_modis"] = coarse_out(modis)
        else:
            coarse["lst_day_modis"] = np.full((h, w), np.nan, np.float32)
        for k, key in enumerate(_S02_GLC_KEYS):
            coarse[key] = coarse_out(glc_frac[..., k])
        for key in _S02_ERA5_KEYS:
            coarse[key] = coarse_out(clim_1km[key])
        raw_obs[year] = {**obs, **coarse}
        dominant[year] = (np.argmax(glc_frac, axis=-1) + 1).astype(np.uint8)

        # Section-06-style 1 km fractions (for the realised UHI and records).
        glc_b = glc_frac[..., 0]
        denom = np.where(glc_b >= 0.999, np.inf, 1.0 - glc_b)
        frac_water = glc_frac[..., 2] / denom * (1.0 - built_1km)
        urban_cells = roi & (built_1km >= 0.5)
        rural_cells = roi & (built_1km <= 0.05) & (frac_water < 0.2)
        for mode, amap in (("day", day_anom[year]), ("night", night_anom[year])):
            qa["uhi"][mode][year] = (round(float(np.nanmean(amap[urban_cells]) - np.nanmean(amap[rural_cells])), 3)
                                     if urban_cells.sum() >= 3 and rural_cells.sum() >= 3 else None)
        ndvi_1km = _s02_block_mean(obs["ndvi_f"], f)[0][roi]
        qa["ndvi_support"][year] = [float(v) for v in np.nanpercentile(ndvi_1km, [5, 25, 50, 75, 95])]
        qa["built_share"][year] = float(np.nanmean(built_1km[roi]))
        frame_meta[year] = {
            "window": tuple(windows[year]),
            "day": {"sensors": list(acq["sensors"]), "scenes": int(acq["scenes"]),
                    "scenes_per_pathrow": {pr: int(n) for pr, n in zip(_S02_PATHROWS, acq["per_pr"])},
                    "mean_overpass_ist_h": float(acq["overpass"]),
                    "coverage": round(float(np.isfinite(obs["lst_day_f"][roi_f]).mean()), 4),
                    "heating_rate_k_per_h": float(acq["heating"]), "path_offsets": dict(ls["path_offsets"])},
            "night": None,                                            # filled after the calibration step
        }
        qa.setdefault("path_offsets", {})[year] = {"planted": ls["planted_offsets"], "estimated": ls["path_offsets"],
                                                   "overlap_pixels": ls["overlap_pixels"]}
        log(f"02: frame {year} done in {_s02_time.perf_counter() - t0:.1f}s (built share "
            f"{qa['built_share'][year]:.3f}, day UHI {qa['uhi']['day'][year]}, night UHI {qa['uhi']['night'][year]})")
        del lc_true, fr, spec, ls, obs, coarse, urban_f, built_f, bv_f, height_f, clim_f, valid_f, spring_gap
    del static, previous_built, previous_ghsl, glc_by_year, persistent, dist_water_m, height_typology
    free_memory()

    # ---- night products, calibration and annual series ------------------------------------------------------------
    night = _s02_night_products(ctx, frames, levels, lev_ann, years, night_anom, day_anom, dominant, anom, clim)
    for year in frames:
        raw_obs[year]["lst_night"] = night["fields"][year]
        raw_obs[year]["lst_night_nobs"] = night["nobs"][year]
        source, sensor_name, overpass, composites = _S02_NIGHT_ACQ[year]
        frame_meta[year]["night"] = {
            "source": source, "sensor": sensor_name, "overpass_ist_h": overpass, "composites": int(composites),
            "coverage": round(float(np.isfinite(night["fields"][year][roi]).mean()), 4)}

    future = {"cmip6": _s02_future_cmip6(float(np.mean(clim["era5_tmax"][roi])), float(np.mean(clim["era5_tmin"][roi])),
                                         anom, years),
              "cmip6_pattern": _s02_future_pattern(ctx), "urban_growth": _s02_future_urban(ctx),
              "ghsl_2030": ghsl_2030, "pop_growth": _s02_future_pop_growth(), "gsat_increment": _s02_future_gsat()}

    truth = _s02_truth(frames, windows, levels, lev_ann, years, anom, ref_period, qa, planted_effects, night, future)
    qa["levels"] = levels
    qa["lev_ann"] = {m: dict(zip(years.tolist(), v.tolist())) for m, v in lev_ann.items()}
    log(f"02: synthetic world generated in {_s02_time.perf_counter() - t_start:.1f}s")
    return {"RAW_STATIC": raw_static, "RAW_OBS": raw_obs, "LC_FINE": lc_fine, "FRAME_META": frame_meta,
            "NIGHT_CALIBRATION": night["calibration"], "ANNUAL_SERIES": night["annual"], "FUTURE_INPUTS": future,
            "SYNTHETIC_TRUTH": truth, "_qa": qa}

# %% [markdown]
# ## 2.9 Night products and the annual series
# Per 1 km cell and year (2000–2025) the true Aqua-equivalent night LST is the annual level + the time-interpolated
# frame anomaly + annual noise. Aqua is observed with noise; Terra (22:30) and VIIRS values are generated by
# inverting the planted class maps (+ sensor noise) and **calibrated back** with maps fitted on the overlap years
# (Terra↔Aqua 2003–2019, VIIRS↔Aqua 2013–2021), per dominant GLC class, plus the per-cell mean residual shrunk
# with n/(n+3) — exactly the section-04 procedure. Frames: 2000 = calibrated Terra, 2005–2020 = Aqua,
# 2025 = calibrated VIIRS, 1990/1995 = no product.

# %%
def _s02_interp_anomaly(frame_maps: dict, frames: list, year: int) -> np.ndarray:
    """Linear interpolation in time between frame anomaly maps (clamped outside the frame range)."""
    if year <= frames[0]:
        return frame_maps[frames[0]]
    if year >= frames[-1]:
        return frame_maps[frames[-1]]
    hi = min(y for y in frames if y >= year)
    lo = max(y for y in frames if y <= year)
    if hi == lo:
        return frame_maps[lo]
    wgt = (year - lo) / (hi - lo)
    return (1.0 - wgt) * frame_maps[lo] + wgt * frame_maps[hi]


def _s02_scope_means(values: np.ndarray, district: np.ndarray, n_districts: int) -> dict:
    """{"ncr": mean, "d:<id>": mean} of a per-cell vector (NaN-aware; districts without cells omitted)."""
    ok = np.isfinite(values)
    out = {"ncr": float(values[ok].mean()) if ok.any() else np.nan}
    sums = np.bincount(district[ok], weights=values[ok], minlength=n_districts)
    counts = np.bincount(district[ok], minlength=n_districts)
    for d in range(n_districts):
        if counts[d] > 0:
            out[f"d:{d}"] = float(sums[d] / counts[d])
    return out


def _s02_night_products(ctx, frames, levels, lev_ann, years, night_anom, day_anom, dominant, anom, clim) -> dict:
    """Night frame fields/counts, fitted NIGHT_CALIBRATION and the ANNUAL_SERIES DataFrame."""
    roi, cells, district = ctx["roi"], ctx["cells"], ctx["cell_district"]
    n_d = ctx["n_districts"]
    h, w = ctx["H"], ctx["W"]
    nc = cells.size
    noise = _S02_NOISE
    rng = _s02_rng(130)
    ann_years = np.arange(2000, 2026)
    yidx = {int(y): i for i, y in enumerate(years)}
    night_maps = {y: night_anom[y].ravel()[cells] for y in frames}
    day_maps = {y: day_anom[y].ravel()[cells] for y in frames}
    dom_maps = {y: dominant[y].ravel()[cells] for y in frames}

    def nearest_frame(y):
        return min(frames, key=lambda fy: (abs(fy - y), -fy))

    true_n = np.empty((ann_years.size, nc))
    cls = np.empty((ann_years.size, nc), np.uint8)
    for i, y in enumerate(ann_years):
        true_n[i] = (lev_ann["night"][yidx[int(y)]] + _s02_interp_anomaly(night_maps, frames, int(y))
                     + noise["annual_cell_sd"] * rng.standard_normal(nc))
        cls[i] = dom_maps[nearest_frame(int(y))]
    aqua_obs = true_n + noise["aqua_night_annual"] * rng.standard_normal(true_n.shape)
    calibration, applied = {}, {}
    expected = {"terra_to_aqua": {}, "viirs_to_aqua": {}}
    for kind, sd in (("terra_to_aqua", noise["terra_night_annual"]), ("viirs_to_aqua", noise["viirs_night_annual"])):
        src = _s02_planted_src(true_n, cls, kind) + sd * rng.standard_normal(true_n.shape)
        y0, y1 = _S02_CAL_FIT_YEARS[kind]
        fit = (ann_years >= y0) & (ann_years <= y1)
        summary, coef, shrunk = _s02_fit_calibration(src[fit], aqua_obs[fit], cls[fit])
        calibration[kind] = summary
        # Errors-in-variables: OLS slopes are attenuated by the reliability var(true src)/var(observed src).
        src_true = _s02_planted_src(true_n[fit], cls[fit], kind)
        for c, (_, b_planted) in _S02_CAL_PLANTED[kind].items():
            sel = cls[fit] == c
            if sel.sum() >= 30:
                var_true = float(np.var(src_true[sel]))
                expected[kind][c] = round(b_planted * var_true / (var_true + sd * sd), 4)
        applied[kind] = {"coef": coef, "shrunk": shrunk, "src": src}

    fields, nobs = {}, {}
    for year in frames:
        source = _S02_NIGHT_ACQ[year][0]
        field = np.full(h * w, np.nan, np.float32)
        count = np.zeros(h * w, np.float32)
        truth = levels["night"][year] + night_maps[year]
        frng = _s02_rng(131, year)
        if source == "aqua":
            vals = truth + noise["aqua_frame_white"] * frng.standard_normal(nc)
            n = frng.binomial(36, np.clip(0.9 + 0.04 * frng.standard_normal(nc), 0.5, 1.0))
        elif source in ("terra_cal", "viirs_cal"):
            kind = "terra_to_aqua" if source == "terra_cal" else "viirs_to_aqua"
            n_years = 2 if source == "terra_cal" else 3
            sd = noise["terra_night_annual" if source == "terra_cal" else "viirs_night_annual"] / np.sqrt(n_years)
            src = _s02_planted_src(truth, dom_maps[year], kind) + sd * frng.standard_normal(nc)
            vals = _s02_apply_calibration(src, dom_maps[year], applied[kind]["coef"], applied[kind]["shrunk"])
            n = (frng.binomial(24, 0.88, nc) if source == "terra_cal"
                 else frng.binomial(273, np.clip(0.55 + 0.05 * frng.standard_normal(nc), 0.2, 0.9)))
        else:
            vals, n = None, np.zeros(nc)
        if vals is not None:
            gap = frng.random(nc) < 0.002                       # persistent cloud / QA-masked cells
            low = frng.random(nc) < 0.003                       # cells with too few valid composites
            n = np.where(low, np.minimum(n, 4 if source != "viirs_cal" else 12), n)
            n = np.where(gap, 0, n)
            vals = np.where(n > 0, vals, np.nan)
            field[cells] = vals
        count[cells] = n
        fields[year] = np.where(roi.ravel(), field, np.nan).reshape(h, w).astype(np.float32)
        nobs[year] = np.where(roi.ravel(), count, np.nan).reshape(h, w).astype(np.float32)

    # ---- annual series (SPEC §2.2) -------------------------------------------------------------------------------
    rows = []
    clim_cells = {v: clim[v].ravel()[cells].astype(np.float64) for v in
                  ("era5_skin_day", "era5_skin_night", "era5_tmax", "era5_tmin", "era5_swvl1")}
    clim_scope = {v: _s02_scope_means(vals, district, n_d) for v, vals in clim_cells.items()}
    scopes = list(clim_scope["era5_tmax"].keys())
    drng = _s02_rng(132)
    scope_sd = {"era5_skin_day": 0.12, "era5_skin_night": 0.08, "era5_tmax": 0.10, "era5_tmin": 0.08,
                "era5_swvl1": 0.004}
    for y in range(1990, 2026):
        i = yidx[y]
        for v in clim_cells:
            for s in scopes:
                dev = 0.0 if s == "ncr" else float(drng.normal(0.0, scope_sd[v]))
                rows.append((y, s, v, clim_scope[v][s] + float(anom[v][i]) + dev, None))
    sat_rng = _s02_rng(133)
    for i, y in enumerate(ann_years):
        y = int(y)
        flag_drift = "drift" if y >= _S02_DRIFT_FROM else None
        # MODIS Terra day (QC + view-time filtered): Landsat-like level + MODIS offset + drift, anomaly x 0.9.
        day_cells = (lev_ann["day"][yidx[y]] + _S02_TERRA_DAY_OFFSET_C + _s02_terra_drift(y)
                     + 0.9 * _s02_interp_anomaly(day_maps, frames, y))
        for s, val in _s02_scope_means(day_cells, district, n_d).items():
            rows.append((y, s, "modis_terra_day", val + float(sat_rng.normal(0.0, noise["annual_scope_sd_day"])),
                         flag_drift))
        if y >= 2003:
            aqua_cells = aqua_obs[i] + _s02_aqua_drift(y)
            for s, val in _s02_scope_means(aqua_cells, district, n_d).items():
                rows.append((y, s, "modis_aqua_night",
                             val + float(sat_rng.normal(0.0, noise["annual_scope_sd_night"])), flag_drift))
        if y >= 2012:
            ap = applied["viirs_to_aqua"]
            viirs_cells = _s02_apply_calibration(ap["src"][i], cls[i], ap["coef"], ap["shrunk"]).astype(np.float64)
            for s, val in _s02_scope_means(viirs_cells, district, n_d).items():
                rows.append((y, s, "viirs_night_cal",
                             val + float(sat_rng.normal(0.0, noise["annual_scope_sd_night"])), None))
    annual = pd.DataFrame({
        "year": pd.Series([r[0] for r in rows], dtype="int64"),
        "scope": pd.Series([r[1] for r in rows], dtype=object),
        "variable": pd.Series([r[2] for r in rows], dtype=object),
        "value": pd.Series([r[3] for r in rows], dtype="float64"),
        "flag": pd.Series([r[4] for r in rows], dtype=object),
    })
    annual = annual.sort_values(["variable", "scope", "year"], kind="stable").reset_index(drop=True)
    return {"fields": fields, "nobs": nobs, "calibration": calibration, "annual": annual,
            "expected_ols_b": expected}

# %% [markdown]
# ## 2.10 `SYNTHETIC_TRUTH` — every planted fact, JSON-ready
# Thresholds are given per SHAP group in the definitions used by section 08 (primary feature, kind, value,
# direction); "saturation" for an exponential term is where the slope falls below 10 % of its maximum
# (`scale · ln 10`). `planted_mean_abs_effect_c` (1 km mean |term − mean|) is the expected importance ranking.

# %%
def _s02_truth(frames, windows, levels, lev_ann, years, anom, ref_period, qa, planted_effects, night, future) -> dict:
    d, n = _S02_DAY, _S02_NIGHT
    ln10 = _s02_math.log(10.0)
    thresholds = {
        "day": {
            "ndvi": {"primary": "ndvi", "kind": "saturation", "value": d["ndvi_saturation"], "direction": "cooling",
                     "effect_c": d["ndvi_cooling_c"],
                     "focal": {"feature": "ndvi_m3", "onset": d["park_onset"], "full": d["park_full"],
                               "effect_c": d["park_cooling_c"], "window_m": d["park_window_m"]}},
            "phenology": {"primary": "ndvi_drop", "kind": "onset", "value": d["harvest_onset"],
                          "saturation": d["harvest_full"], "direction": "warming", "effect_c": d["harvest_heating_c"]},
            "albedo": {"primary": "albedo", "kind": "linear", "slope_c_per_unit": d["albedo_per_unit"],
                       "direction": "cooling"},
            "built": {"primary": "frac_built", "kind": "linear", "slope_c_per_unit": d["built_per_unit"],
                      "direction": "cooling"},
            "barren": {"primary": "frac_barren", "kind": "linear", "slope_c_per_unit": d["barren_per_unit"],
                       "direction": "warming"},
            "water": {"primary": "frac_water", "kind": "saturation", "value": round(d["water_scale"] * ln10, 4),
                      "e_folding": d["water_scale"], "direction": "cooling", "effect_c": d["water_cooling_c"],
                      "reach": {"feature": "dist_water", "effect_c": d["water_reach_c"],
                                "e_folding_km": d["water_reach_m"] / 1000.0}},
            "climate_moisture": {"primary": "era5_swvl1", "kind": "linear", "slope_c_per_unit": d["swvl1_per_unit"],
                                 "direction": "cooling", "vpd_slope_c_per_kpa": d["vpd_per_kpa"]},
            "terrain": {"primary": "elevation", "kind": "linear", "slope_c_per_m": d["lapse_per_m"],
                        "direction": "cooling", "tpi_slope_c_per_m": d["tpi_per_m"],
                        "tpi_window_km": d["tpi_window_m"] / 1000.0},
        },
        "night": {
            "built": {"primary": "frac_built", "kind": "saturation", "value": round(n["built_scale"] * ln10, 4),
                      "e_folding": n["built_scale"], "direction": "warming", "effect_c": n["built_c"]},
            "built_volume": {"primary": "built_v", "kind": "linear-in-log1p",
                             "slope_c_per_log1p": n["built_v_per_log1p"], "direction": "warming"},
            "water": {"primary": "frac_water", "kind": "saturation", "value": round(n["water_scale"] * ln10, 4),
                      "e_folding": n["water_scale"], "direction": "warming", "effect_c": n["water_warming_c"]},
            "ndvi": {"primary": "ndvi", "kind": "linear", "slope_c_per_unit": n["ndvi_per_unit"],
                     "direction": "cooling"},
            "barren": {"primary": "frac_barren", "kind": "linear", "slope_c_per_unit": n["barren_per_unit"],
                       "direction": "cooling"},
            "terrain": {"primary": "elevation", "kind": "linear", "slope_c_per_m": n["lapse_per_m"],
                        "direction": "cooling", "tpi_slope_c_per_m": n["tpi_per_m"],
                        "tpi_window_km": n["tpi_window_m"] / 1000.0, "note": "cold-air pooling in hollows"},
            "climate_moisture": {"primary": "era5_swvl1", "kind": "linear", "slope_c_per_unit": n["swvl1_per_unit"],
                                 "direction": "warming", "vpd_slope_c_per_kpa": n["vpd_per_kpa"],
                                 "note": "soil-moisture thermal inertia"},
        },
    }
    all_groups = ["ndvi", "phenology", "ndbi", "moisture_index", "albedo", "built", "built_volume", "population",
                  "forest", "water", "cropland", "barren", "urban_proximity", "landscape", "terrain", "climate_heat",
                  "climate_moisture", "climate_wind"]
    mean_effects = {m: {g: round(float(np.mean([planted_effects[m][y][g] for y in frames])), 4)
                        for g in planted_effects[m][frames[0]]} for m in ("day", "night")}
    ref_sel = (years >= ref_period[0]) & (years <= ref_period[1])
    acq = {y: _S02_DAY_ACQ[y] for y in frames}
    # Noise-free expectation of the SPEC §4.7 β regression: OLS of the planted annual level on the ERA5 temperature
    # (+ swvl1) over the regression years. It differs slightly from the planted β because the land-driven level
    # trend is partly collinear with the warming trend of the regressor (a real-world confound, kept on purpose).
    expected_beta = {}
    for mode, (y0, y1) in (("day", (2003, 2020)), ("night", (2003, 2025))):
        sel = (years >= y0) & (years <= y1)
        temp = anom[_S02_LEVEL[mode]["temperature_var"]][sel]
        design = np.column_stack([np.ones(sel.sum()), temp, anom["era5_swvl1"][sel]])
        coef, *_ = np.linalg.lstsq(design, lev_ann[mode][sel], rcond=None)
        expected_beta[mode] = {"years": [y0, y1], "beta": round(float(coef[1]), 4),
                               "gamma_swvl1": round(float(coef[2]), 3)}
    truth = {
        "generator": _S02_GENERATOR, "seed": int(_s02_cfg("SEED", 42)), "data_mode": "synthetic",
        "grid_res_m": int(GRID.res), "fine_res_m": int(GRID_FINE.res), "lc_fine_res_m": _s02_lc_res(),
        "frames": list(frames), "windows": {y: list(windows[y]) for y in frames},
        "formula": {
            "day": ("anom_day = -4.5*min(ndvi,0.30)/0.30 - 1.2*clip((box3km(ndvi)-0.20)/0.15,0,1) "
                    "+ 2.2*clip((ndvi_drop-0.12)/0.28,0,1) - 9.0*(albedo-0.18) - 2.2*built_f + 2.8*frac_barren "
                    "- 7.0*(1-exp(-box1km(frac_water)/0.08)) - 0.8*exp(-dist_water/0.6km) "
                    "- 12*(swvl1-mean) + 0.6*(vpd-mean) - 0.0045*(elev-220) + 0.006*tpi7km + noise; "
                    "centred to 0 over the ROI at 1 km"),
            "night": ("anom_night = 3.2*(1-exp(-built_f/0.30))/(1-exp(-1/0.30)) + 0.6*log1p(built_v) "
                      "+ 2.5*(1-exp(-box1km(frac_water)/0.08)) - 0.8*ndvi - 1.2*frac_barren + 0.012*tpi7km "
                      "- 0.003*(elev-220) + 6*(swvl1-mean) - 0.4*(vpd-mean) + noise; centred to 0 over the ROI"),
            "level": "L(y) = base + trend*(y-2010)/10 + beta*(T(y)-T_ref) + gamma*(swvl1(y)-swvl1_ref); "
                     "frame level = mean of L(y) over the frame window; T = era5_tmax (day) / era5_tmin (night)",
        },
        "level_definition": "ROI mean (1 km cells) of the true absolute field; day at the 10:45 IST reference "
                            "overpass in Landsat units, night in Aqua-equivalent units",
        "levels": {m: {y: round(levels[m][y], 4) for y in frames} for m in ("day", "night")},
        "levels_annual": {m: {int(y): round(float(v), 4) for y, v in zip(years, lev_ann[m]) if 1990 <= y <= 2025}
                          for m in ("day", "night")},
        "level_model": {m: {**p, "ref_period": list(ref_period),
                            "temperature_ref": round(float(anom[p["temperature_var"]][ref_sel].mean()), 4)}
                        for m, p in _S02_LEVEL.items()},
        "beta_day": _S02_LEVEL["day"]["beta"], "beta_night": _S02_LEVEL["night"]["beta"],
        "beta": {"day": {"value": _S02_LEVEL["day"]["beta"], "temperature_var": "era5_tmax",
                         "co_regressor": {"era5_swvl1": _S02_LEVEL["day"]["gamma_swvl1"]},
                         "expected_ols_noise_free": expected_beta["day"]},
                 "night": {"value": _S02_LEVEL["night"]["beta"], "temperature_var": "era5_tmin",
                           "co_regressor": {"era5_swvl1": _S02_LEVEL["night"]["gamma_swvl1"]},
                           "expected_ols_noise_free": expected_beta["night"]}},
        "planted_thresholds": thresholds,
        "planted_parameters": {"day": dict(_S02_DAY), "night": dict(_S02_NIGHT)},
        "planted_mean_abs_effect_c": mean_effects,
        "irrelevant_by_construction": {m: [g for g in all_groups if g not in thresholds[m]] for m in ("day", "night")},
        "monotone_expectations": {"day": {"ndvi": -1, "forest": -1, "water": -1, "moisture_index": -1},
                                  "night": {"built": 1, "built_volume": 1}},
        "uhi": {"definition": "mean anomaly over cells with frac_built >= 0.5 minus cells with frac_built <= 0.05 "
                              "and frac_water < 0.2 (SPEC §4.7)",
                "day": {"sign": "negative", "target_range_c": [-2.5, -1.5], "realised": qa["uhi"]["day"]},
                "night": {"sign": "positive", "target_range_c": [2.0, 5.0], "realised": qa["uhi"]["night"]}},
        "overpass": {"reference_ist_h": _S02_REF_OVERPASS_IST_H,
                     "mean_overpass_ist_h": {y: acq[y]["overpass"] for y in frames},
                     "heating_rate_k_per_h": {y: acq[y]["heating"] for y in frames},
                     "raw_day_level_bias_c": {
                         y: round(-(_S02_REF_OVERPASS_IST_H - acq[y]["overpass"]) * acq[y]["heating"], 4)
                         for y in frames},
                     "note": "RAW lst_day_f = truth - (10.75 - overpass_h) * heating_rate; SPEC §4.7 correction "
                             "recovers the 10:45 IST truth"},
        "heating_rate_k_per_h": {y: acq[y]["heating"] for y in frames},
        "path_offsets": {"convention": "per-path bias relative to the harmonised mosaic (value removed from that "
                                       "path's composite); planted symmetric +-delta/2 with delta = 146 - 147",
                         "planted": {y: qa["path_offsets"][y]["planted"] for y in frames},
                         "estimated": {y: qa["path_offsets"][y]["estimated"] for y in frames},
                         "overlap_pixels": {y: qa["path_offsets"][y]["overlap_pixels"] for y in frames}},
        "calibration": {k: {"planted_by_class": [{"class": c, "a": a, "b": b,
                                                  "expected_ols_b": night["expected_ols_b"][k].get(c)}
                                                 for c, (a, b) in v.items()],
                            "note": "OLS on noisy source values attenuates b by var(true)/var(observed); "
                                    "expected_ols_b is the planted slope times that reliability",
                            "fit_years": list(_S02_CAL_FIT_YEARS[k]),
                            "source_noise_sd_c": _S02_NOISE["terra_night_annual" if k.startswith("terra")
                                                            else "viirs_night_annual"],
                            "recovered": night["calibration"][k]}
                        for k, v in _S02_CAL_PLANTED.items()},
        "night_availability": {y: _S02_NIGHT_ACQ[y][0] for y in frames},
        "satellites": {"terra_day_minus_landsat_level_c": _S02_TERRA_DAY_OFFSET_C,
                       "terra_day_anomaly_factor": 0.9,
                       "terra_day_drift_c": {y: round(_s02_terra_drift(y), 3) for y in range(2022, 2027)},
                       "aqua_night_drift_c": {y: round(_s02_aqua_drift(y), 3) for y in range(2022, 2027)},
                       "drift_flag_from": _S02_DRIFT_FROM},
        "climate": {"warming_per_decade_k": {"era5_tmax": 0.20, "era5_tmin": 0.25},
                    "gradient": "SW -> NE: NE cooler by day, wetter (swvl1 0.11 -> 0.25), smaller diurnal range",
                    "climatology": {k: {"centre": c, "per_unit_g": s} for k, (c, s, _) in _S02_CLIM.items()}},
        "urban_growth": {"centres": [{"name": c[0], "lon": c[1], "lat": c[2], "amplitude": c[3], "r1990_km": c[4],
                                      "r2025_km": c[5], "mid_year": c[6], "tau_years": c[7]}
                                     for c in _S02_URBAN_CENTRES],
                         "built_share": {y: round(v, 4) for y, v in qa["built_share"].items()},
                         "irreversible": True, "glc_year_for_frame": {y: (2022 if y == 2025 else y) for y in frames},
                         "pop_total_persons": {"1990": _S02_POP_TOTAL["1990"], "2025": _S02_POP_TOTAL["2025"]}},
        "ndvi_support_1km_p05_p25_p50_p75_p95": qa["ndvi_support"],
        "noise": dict(_S02_NOISE),
        "future": {"illustrative": True,
                   "note": "synthetic stand-ins: pseudo-GCMs (not real CMIP6 output), Chen-2020-like urban ratios, "
                           "IIASA-SSP-like population factors, AR6 Table 4.5 central GSAT values",
                   "cmip6_delta_2050": _s02_cmip6_summary(future["cmip6"]),
                   "urban_rate_pct_per_year_ssp2": dict(_S02_URBAN_RATE),
                   "ssp_urban_multiplier": dict(_S02_SSP_URBAN_MULT),
                   "pop_factor_2050": dict(_S02_POP_FACTOR_2050),
                   "ar6_gsat_vs_1995_2014": {k: {"2021-2040": v[0], "2041-2060": v[1]}
                                             for k, v in _S02_AR6_GSAT.items()}},
    }
    truth = _s02_py(truth)
    _s02_json.dumps(truth)                       # fail fast if anything is not JSON-serialisable
    return truth


def _s02_cmip6_summary(cmip6: pd.DataFrame) -> dict:
    """Ensemble mean/sd of the 2050-minus-2025 delta per scenario and variable."""
    out = {}
    now = int(_s02_cfg("NOW", 2025))
    last = int(max(cmip6["frame"]))
    for (scenario, var), grp in cmip6.groupby(["scenario", "var"]):
        piv = grp.pivot_table(index="model", columns="frame", values="value_k")
        delta = piv[last] - piv[now]
        out.setdefault(scenario, {})[var] = {"mean": round(float(delta.mean()), 3), "sd": round(float(delta.std()), 3)}
    return out

# %% [markdown]
# ## 2.11 Run the generator and publish the acquisition globals

# %%
if _S02_ACTIVE:
    with timer("02 synthetic world"):
        _S02_OUT = _s02_generate()
    RAW_STATIC = _S02_OUT["RAW_STATIC"]
    RAW_OBS = _S02_OUT["RAW_OBS"]
    LC_FINE = _S02_OUT["LC_FINE"]
    FRAME_META = _S02_OUT["FRAME_META"]
    NIGHT_CALIBRATION = _S02_OUT["NIGHT_CALIBRATION"]
    ANNUAL_SERIES = _S02_OUT["ANNUAL_SERIES"]
    FUTURE_INPUTS = _S02_OUT["FUTURE_INPUTS"]
    SYNTHETIC_TRUTH = _S02_OUT["SYNTHETIC_TRUTH"]
    _S02_QA = _S02_OUT["_qa"]
    del _S02_OUT

    # Provenance (DATA_SOURCES[var][year]) and caveats, mirroring what sections 03-05 record in gee mode.
    if not isinstance(globals().get("DATA_SOURCES"), dict):
        DATA_SOURCES = {}
    if not isinstance(globals().get("DATA_CAVEATS"), list):
        DATA_CAVEATS = []
    _s02_desc = f"SYNTHETIC ({_S02_GENERATOR}, seed {int(_s02_cfg('SEED', 42))})"
    _s02_src_text = {
        "lst_day_f": "planted day LST at the scene overpass (overpass bias + path offsets + composite noise), "
                     "harmonised like Landsat C2 L2 ST",
        "lst_day_nobs_f": "simulated clear-scene count per WRS-2 path/row (Binomial, SLC-off gaps)",
        "ndvi_f": "class-signature mixture (Landsat-like, Apr-Jun)", "ndbi_f": "class-signature mixture",
        "mndwi_f": "class-signature mixture", "albedo_f": "class-signature mixture (Liang-like)",
        "ndvi_spring_f": "class-signature mixture (Feb-Mar)", "built_f": "GHSL-like built-up surface fraction",
        "lst_night": "planted night LST (Aqua-equivalent; Terra/VIIRS calibrated)",
        "lst_night_nobs": "simulated valid composites / daily observations",
        "lst_day_modis": "MODIS-Terra-like 1 km day LST (offset, drift, noise)",
        "built_v": "GHSL-like building volume (m3/m2)", "pop": "GHSL-like population density (persons/km2)",
        "land_cover": "GLC_FCS30D-like classification (2025 frame uses the 2022 map)",
    }
    for _s02_var in _S02_FINE_KEYS + _S02_COARSE_KEYS + ["land_cover"]:
        _s02_text = _s02_src_text.get(_s02_var, "ERA5-Land-like Apr-Jun field" if _s02_var.startswith("era5")
                                      else "GLC_FCS30D-like class fraction")
        DATA_SOURCES.setdefault(_s02_var, {}).update({int(y): f"{_s02_desc}: {_s02_text}" for y in RAW_OBS})
    for _s02_var in ("elevation", "slope", "aspect_sin", "aspect_cos", "water_occ", "elevation_f", "water_occ_f"):
        DATA_SOURCES.setdefault(_s02_var, {}).update({int(y): f"{_s02_desc}: static {_s02_var}" for y in RAW_OBS})
    DATA_SOURCES.setdefault("heating_rate", {}).update(
        {int(y): f"{_s02_desc}: planted 09:30-11:30 IST skin-temperature heating rate" for y in RAW_OBS})
    DATA_SOURCES.setdefault("annual_series", {}).update(
        {"1990-2025": f"{_s02_desc}: ERA5-like and satellite-like annual Apr-Jun means (NCR + districts)"})
    DATA_SOURCES.setdefault("night_calibration", {}).update(
        {"2000-2025": f"{_s02_desc}: planted Terra/VIIRS -> Aqua per-class offsets, recovered like section 04"})
    # the same keys as section 05 records in gee mode: future_inputs plus one future_<input> entry per input
    _s02_now = int(_s02_cfg("NOW", 2025))
    _s02_span = f"{_s02_now}-{max([_s02_now] + [int(y) for y in (_s02_cfg('FRAMES_PROJ', []) or [])])}"
    DATA_SOURCES.setdefault("future_inputs", {}).update(
        {_s02_span: f"{_s02_desc}: illustrative pseudo-GCM / SSP stand-ins (not NASA GDDP-CMIP6, Chen 2020, "
                    "IIASA SSP v3 or AR6 data)"})
    for _s02_var in sorted(FUTURE_INPUTS):
        DATA_SOURCES.setdefault(f"future_{_s02_var}", {}).update(
            {_s02_span: f"{_s02_desc}: synthetic stand-in for {_s02_var}"})
    for _s02_caveat in (
            "SYNTHETIC DATA: every variable is simulated from a planted response; see SYNTHETIC_TRUTH.",
            "SYNTHETIC future inputs (34 pseudo-GCMs, SSP urban growth, population factors, GSAT increments) are "
            "illustrative stand-ins, not real scenario data."):
        # Section 01 already states the general synthetic caveat; never add a second wording of it.
        if _s02_caveat.startswith("SYNTHETIC DATA") and any(str(c).startswith("SYNTHETIC DATA") for c in DATA_CAVEATS):
            continue
        if _s02_caveat not in DATA_CAVEATS:
            DATA_CAVEATS.append(_s02_caveat)
    del _s02_desc, _s02_src_text, _s02_var, _s02_text, _s02_caveat, _s02_now, _s02_span
    free_memory()

# %% [markdown]
# ## 2.12 Contract check (SPEC §3.2)
# The same assertions guard the GEE path in section 05; here they prove the synthetic twin is interchangeable.

# %%
def _s02_validate() -> None:
    """Raise AssertionError with a precise message if a §3.2 global violates the contract."""
    h, w = GRID.shape
    hf, wf = GRID_FINE.shape
    roi = np.asarray(ROI_MASK, bool)
    roi_f = np.asarray(globals().get("ROI_MASK_FINE", np.repeat(np.repeat(roi, hf // h, 0), wf // w, 1)), bool)
    assert set(RAW_STATIC) == {"elevation", "slope", "aspect_sin", "aspect_cos", "water_occ", "elevation_f",
                               "water_occ_f"}, sorted(RAW_STATIC)
    for key, arr in RAW_STATIC.items():
        shape = (hf, wf) if key.endswith("_f") else (h, w)
        mask = roi_f if key.endswith("_f") else roi
        assert arr.shape == shape and arr.dtype == np.float32, (key, arr.shape, arr.dtype)
        assert np.isnan(arr[~mask]).all() and np.isfinite(arr[mask]).all(), f"RAW_STATIC[{key}] NaN pattern"
    frames = [int(y) for y in _s02_cfg("FRAMES_OBS", list(_S02_DEFAULT_WINDOWS))]
    assert sorted(RAW_OBS) == sorted(frames), sorted(RAW_OBS)
    r_lc = _s02_lc_res()
    lc_shape = (h * GRID.res // r_lc, w * GRID.res // r_lc)
    for year in frames:
        obs = RAW_OBS[year]
        expected_keys = set(_S02_FINE_KEYS) | set(_S02_COARSE_KEYS)
        assert set(obs) == expected_keys, (year, sorted(set(obs) ^ expected_keys))
        for key, arr in obs.items():
            fine = key in _S02_FINE_KEYS
            assert arr.shape == ((hf, wf) if fine else (h, w)) and arr.dtype == np.float32, (
                year, key, arr.shape, arr.dtype)
            assert np.isnan(arr[~(roi_f if fine else roi)]).all(), f"RAW_OBS[{year}][{key}] must be NaN outside the ROI"
        glc = np.stack([obs[k][roi] for k in _S02_GLC_KEYS])
        assert np.allclose(glc.sum(0), 1.0, atol=1e-4), f"glc fractions of {year} do not sum to 1"
        assert np.nanmin(obs["built_f"]) >= 0 and np.nanmax(obs["built_f"]) <= 1
        assert LC_FINE[year].shape == lc_shape and LC_FINE[year].dtype == np.uint8, (year, LC_FINE[year].shape)
        assert int(LC_FINE[year].max()) <= 6
        meta = FRAME_META[year]
        assert set(meta) == {"window", "day", "night"}
        assert set(meta["day"]) == {"sensors", "scenes", "scenes_per_pathrow", "mean_overpass_ist_h", "coverage",
                                    "heating_rate_k_per_h", "path_offsets"}, sorted(meta["day"])
        assert set(meta["day"]["scenes_per_pathrow"]) == set(_S02_PATHROWS)
        assert set(meta["night"]) == {"source", "sensor", "overpass_ist_h", "composites", "coverage"}
        assert meta["night"]["source"] in ("aqua", "terra_cal", "viirs_cal", None)
        has_night = np.isfinite(obs["lst_night"][roi]).any()
        assert has_night == (meta["night"]["source"] is not None), f"night availability of {year}"
    for kind in ("terra_to_aqua", "viirs_to_aqua"):
        cal = NIGHT_CALIBRATION[kind]
        assert set(cal) == {"r2", "rmse", "n", "by_class"} and all(set(c) == {"class", "a", "b", "n"}
                                                                   for c in cal["by_class"]), cal
    assert list(ANNUAL_SERIES.columns) == ["year", "scope", "variable", "value", "flag"], list(ANNUAL_SERIES.columns)
    assert set(ANNUAL_SERIES["variable"]) == {"era5_skin_day", "era5_skin_night", "era5_tmax", "era5_tmin",
                                              "era5_swvl1", "modis_terra_day", "modis_aqua_night", "viirs_night_cal"}
    assert ANNUAL_SERIES["year"].between(1990, 2025).all() and "ncr" in set(ANNUAL_SERIES["scope"])
    assert set(FUTURE_INPUTS) == {"cmip6", "cmip6_pattern", "urban_growth", "ghsl_2030", "pop_growth",
                                  "gsat_increment"}, sorted(FUTURE_INPUTS)
    assert list(FUTURE_INPUTS["cmip6"].columns) == ["scenario", "model", "frame", "var", "value_k"]
    assert FUTURE_INPUTS["cmip6"]["model"].nunique() == _S02_CMIP6["n_models"]
    for var in ("tasmax", "tasmin"):
        assert FUTURE_INPUTS["cmip6_pattern"][var].shape == (h, w)
    assert list(FUTURE_INPUTS["urban_growth"].columns) == ["scenario", "district", "frame", "ratio"]
    assert list(FUTURE_INPUTS["pop_growth"].columns) == ["scenario", "frame", "factor"]
    for var in ("built", "pop"):
        assert FUTURE_INPUTS["ghsl_2030"][var].shape == (h, w) and FUTURE_INPUTS["ghsl_2030"][var].dtype == np.float32
    assert set(FUTURE_INPUTS["gsat_increment"]) == {"ssp126", "ssp245", "ssp585"}
    assert isinstance(SYNTHETIC_TRUTH, dict) and SYNTHETIC_TRUTH["generator"] == _S02_GENERATOR
    _s02_json.dumps(SYNTHETIC_TRUTH)


if _S02_ACTIVE:
    _s02_validate()
    log("section-02 contract check passed (SPEC §3.2 keys, shapes, dtypes, NaN outside the ROI)")

# %% [markdown]
# ## 2.13 Quality-assurance figures and the planted-world summary
# Fine day LST (raw composite + the SPEC §4.7 overpass correction) and the planted fine night field for the first
# and last frame, built-up growth, and the annual series with the planted levels.

# %%
def _s02_save_show(fig, name: str) -> None:
    try:
        fig.savefig(Path(CFG.FIG_DIR) / name, dpi=110, bbox_inches="tight")
    except Exception as exc:  # noqa: BLE001 - a figure must never stop the pipeline
        log(f"02: could not save figure {name}: {exc}", "WARNING")
    plt.show()
    plt.close(fig)


if _S02_ACTIVE:
    _s02_frames = sorted(RAW_OBS)
    _s02_first, _s02_last = _s02_frames[0], _s02_frames[-1]
    _s02_stride = max(1, max(GRID_FINE.shape) // 900)
    _s02_ext = [0, GRID.width * GRID.res / 1000, 0, GRID.height * GRID.res / 1000]

    def _s02_day_fine(year):
        meta = FRAME_META[year]["day"]
        corr = (_S02_REF_OVERPASS_IST_H - meta["mean_overpass_ist_h"]) * meta["heating_rate_k_per_h"]
        return RAW_OBS[year]["lst_day_f"] + corr

    fig, axes = plt.subplots(2, 2, figsize=(11, 11), constrained_layout=True)
    _s02_day = [_s02_day_fine(y) for y in (_s02_first, _s02_last)]
    _s02_vmin, _s02_vmax = np.nanpercentile(np.concatenate([a[::7, ::7].ravel() for a in _s02_day]), [2, 98])
    for ax, year, arr in zip(axes[0], (_s02_first, _s02_last), _s02_day):
        im = ax.imshow(arr[::_s02_stride, ::_s02_stride], cmap="inferno", vmin=_s02_vmin, vmax=_s02_vmax,
                       extent=_s02_ext, interpolation="nearest")
        ax.set_title(f"Day LST {year} (fine, overpass-corrected) [SYNTHETIC]", fontsize=9)
    fig.colorbar(im, ax=axes[0], shrink=0.7, label="°C")
    _s02_night = [_S02_QA["night_truth_fine"].get(y) for y in (_s02_first, _s02_last)]
    _s02_night = [a if a is not None else np.full(GRID_FINE.shape, np.nan, np.float32) for a in _s02_night]
    _s02_nmin, _s02_nmax = np.nanpercentile(np.concatenate([a[::7, ::7].ravel() for a in _s02_night]), [2, 98])
    for ax, year, arr in zip(axes[1], (_s02_first, _s02_last), _s02_night):
        im = ax.imshow(arr[::_s02_stride, ::_s02_stride], cmap="magma", vmin=_s02_nmin, vmax=_s02_nmax,
                       extent=_s02_ext, interpolation="nearest")
        ax.set_title(f"Night LST {year} (planted fine truth; source {FRAME_META[year]['night']['source']}) "
                     "[SYNTHETIC]", fontsize=9)
    fig.colorbar(im, ax=axes[1], shrink=0.7, label="°C")
    _s02_save_show(fig, "02_synthetic_lst_fine.png")

    fig, axes = plt.subplots(1, 3, figsize=(16, 5.2), constrained_layout=True)
    for ax, year in zip(axes[:2], (_s02_first, _s02_last)):
        im = ax.imshow(RAW_OBS[year]["built_f"][::_s02_stride, ::_s02_stride], cmap="viridis", vmin=0, vmax=1,
                       extent=_s02_ext, interpolation="nearest")
        ax.set_title(f"GHSL-like built_f {year} [SYNTHETIC]", fontsize=9)
    fig.colorbar(im, ax=axes[:2], shrink=0.8, label="built-up fraction")
    _s02_share = [float(np.nanmean(RAW_OBS[y]["built_f"])) for y in _s02_frames]
    _s02_glcb = [float(np.nanmean(RAW_OBS[y]["glc_built"])) for y in _s02_frames]
    axes[2].plot(_s02_frames, _s02_share, "o-", label="GHSL-like built_f (ROI mean)")
    axes[2].plot(_s02_frames, _s02_glcb, "s--", label="GLC-like glc_built (ROI mean)")
    _s02_d = np.asarray(DISTRICT_IDX)
    for did, name in ((0, "Delhi NCT"), (1, "Gurugram"), (17, "Gautam Buddh Nagar"), (16, "Ghaziabad")):
        sel = _s02_d == did
        if sel.any():
            axes[2].plot(_s02_frames, [float(np.nanmean(_s02_block_mean(RAW_OBS[y]["built_f"],
                                                                         GRID_FINE.shape[0] // GRID.shape[0])[0][sel]))
                                       for y in _s02_frames], ".:", label=name)
    axes[2].set_ylabel("built-up fraction")
    axes[2].set_title("Urban growth [SYNTHETIC]", fontsize=9)
    axes[2].legend(fontsize=7)
    _s02_save_show(fig, "02_synthetic_built_growth.png")

    fig, axes = plt.subplots(1, 2, figsize=(15, 4.8), constrained_layout=True)
    _s02_ncr = ANNUAL_SERIES[ANNUAL_SERIES["scope"] == "ncr"]
    for ax, mode, variables in ((axes[0], "day", ["era5_tmax", "era5_skin_day", "modis_terra_day"]),
                                (axes[1], "night", ["era5_tmin", "era5_skin_night", "modis_aqua_night",
                                                    "viirs_night_cal"])):
        for var in variables:
            sub = _s02_ncr[_s02_ncr["variable"] == var]
            ax.plot(sub["year"], sub["value"], ".-", label=var)
            drift = sub[sub["flag"] == "drift"]
            if len(drift):
                ax.scatter(drift["year"], drift["value"], marker="x", color="k", zorder=5)
        lv = _S02_QA["lev_ann"][mode]
        ax.plot(list(range(1990, 2026)), [lv[y] for y in range(1990, 2026)], "k--", lw=1, label=f"planted {mode} level")
        ax.plot(_s02_frames, [SYNTHETIC_TRUTH["levels"][mode][y] for y in _s02_frames], "ko", ms=4,
                label="frame level (truth)")
        ax.set_title(f"NCR annual series, {mode} (x = drift flag) [SYNTHETIC]", fontsize=9)
        ax.legend(fontsize=7)
        ax.set_ylabel("°C")
    _s02_save_show(fig, "02_synthetic_annual_series.png")

    _s02_rows = []
    for y in _s02_frames:
        obs = RAW_OBS[y]
        _s02_rows.append({
            "year": y, "day_tier_scenes_min": min(FRAME_META[y]["day"]["scenes_per_pathrow"].values()),
            "day_cov": FRAME_META[y]["day"]["coverage"], "raw_day_mean": round(float(np.nanmean(obs["lst_day_f"])), 2),
            "true_day_level": SYNTHETIC_TRUTH["levels"]["day"][y],
            "overpass_bias": SYNTHETIC_TRUTH["overpass"]["raw_day_level_bias_c"][y],
            "night_src": FRAME_META[y]["night"]["source"],
            "night_mean": (round(float(np.nanmean(obs["lst_night"])), 2) if np.isfinite(obs["lst_night"]).any()
                           else None),
            "true_night_level": SYNTHETIC_TRUTH["levels"]["night"][y],
            "uhi_day": SYNTHETIC_TRUTH["uhi"]["day"]["realised"][y],
            "uhi_night": SYNTHETIC_TRUTH["uhi"]["night"]["realised"][y],
            "built": round(float(np.nanmean(obs["built_f"])), 4),
            "path_off_est": FRAME_META[y]["day"]["path_offsets"]["146"],
            "path_off_true": SYNTHETIC_TRUTH["path_offsets"]["planted"][y]["146"],
        })
    print("Synthetic world per frame [SYNTHETIC]")
    print(pd.DataFrame(_s02_rows).set_index("year").to_string())
    print("Night calibration (recovered vs planted):")
    for _s02_kind in ("terra_to_aqua", "viirs_to_aqua"):
        _s02_cal = NIGHT_CALIBRATION[_s02_kind]
        print(f"  {_s02_kind}: r2={_s02_cal['r2']} rmse={_s02_cal['rmse']} n={_s02_cal['n']} | " + ", ".join(
            f"c{c['class']}: b={c['b']:.3f} (planted {_S02_CAL_PLANTED[_s02_kind][c['class']][1]:.3f})"
            for c in _s02_cal["by_class"]))
    print("Planted mean |effect| per group (°C, 1 km):", _s02_json.dumps(SYNTHETIC_TRUTH["planted_mean_abs_effect_c"]))
    del (_s02_frames, _s02_first, _s02_last, _s02_stride, _s02_ext, _s02_day, _s02_night, _s02_vmin, _s02_vmax,
         _s02_nmin, _s02_nmax, _s02_share, _s02_glcb, _s02_ncr, _s02_rows, _s02_d, _s02_kind, _s02_cal, fig, axes, im)
    _S02_QA = {k: v for k, v in _S02_QA.items() if k != "night_truth_fine"}   # drop the large QA rasters
    free_memory()
