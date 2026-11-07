# %% [markdown]
# # 5. Drivers 1990–2025 and future inputs 2025–2050 (gee mode only)
#
# Runs only when `DATA_MODE == "gee"` (section 02 provides the same globals in synthetic mode). It completes the
# acquisition layer of SPEC §3.2:
#
# | Global | Content (SPEC §2.3) |
# |---|---|
# | `RAW_STATIC` | SRTM `elevation`, `slope`, `aspect_sin`, `aspect_cos` and JRC `water_occ` at 1 km; `elevation_f`, `water_occ_f` on the fine grid |
# | `RAW_OBS[y]` | GHSL `built_f` (fine), `built_v`, `pop`; GLC_FCS30D `glc_*` fractions; ERA5-Land `era5_*` window climatology |
# | `LC_FINE[y]` | harmonised GLC_FCS30D classes (0–6) at `CFG.LC_FINE_RES_M` for the landscape metrics |
# | `FUTURE_INPUTS` | GDDP-CMIP6 ROI-mean tasmax/tasmin per model × scenario × frame window, the ssp245 2050 warming pattern, Chen-2020 SSP urban-growth ratios per district, GHSL 2030, IIASA SSP urban-population factors, AR6 GSAT increments |
#
# **Design choices and their reasons**
#
# * **One land-cover product for all frames** (GLC_FCS30D: five-yearly maps for 1990/1995, annual maps 2000–2022,
#   2025 → the 2022 map): the real-data experiments showed ~1 °C offsets when products are mixed. Fractions use the
#   two-step `reduceResolution` (30 m indicators → 250 m → 1 km) defined in section 04 (shared tile cache).
# * **GHSL P2023A** is the only consistent 5-yearly built-up/population record 1975–2030 (2025/2030 are GHSL's own
#   extrapolations; noted in the caveats). Units: `built_f` = built-up surface fraction (m² / 10⁴ m² per 100 m cell),
#   `built_v` = building volume per ground area (m³ m⁻²), `pop` = persons km⁻² (count × 100 at 100 m), all as
#   area-weighted means.
# * **ERA5-Land** window climatologies (Apr–Jun of every window year): 2 m temperature, RH and VPD from T and Td
#   (Magnus–Tetens), soil water layer 1, evaporation (mm day⁻¹, positive = evaporation), net solar radiation
#   (MJ m⁻² day⁻¹), wind speed √(u²+v²), daily Tmax/Tmin and Jan–Mar precipitation (mm). Monthly `_sum` bands are
#   monthly totals, so a seasonal daily rate is `mean(monthly total) × months / season days` (exact for whole months).
#   Fields are bilinearly resampled from 0.1° to 1 km.
# * **Future climate** comes from NASA/GDDP-CMIP6 (Earth Engine copy: historical, ssp245, ssp585): for every model with
#   tasmax and tasmin, the Apr–Jun mean of the daily values over the 20-year window centred on each frame (2025:
#   2016–2035 … 2050: 2041–2060), ROI mean. It is built from small, cached per-(scenario, model, 5-year block)
#   requests on the native 0.25° grid (section 5.3); the warming pattern reuses the same blocks. GFDL-CM4 is published
#   on two grids (gr1/gr2); only gr1 is used so its days are not double-counted. ssp126 is pattern-scaled later
#   (section 11) with the AR6 GSAT increments defined here.
# * **Urban growth** per district from Chen et al. (2020) SSP urban land (1 km, value 2 = urban, bands `SSP1…SSP5`,
#   decadal 2020–2100), as ratios to the district's own 2020 urban area (ratios avoid the baseline mismatch with GHSL),
#   geometrically interpolated to 5-year frames. The SSP bands are resolved by name (`ssp1`/`ssp2`/`ssp5` after
#   normalisation) or, for exactly 5 unnamed bands, by position with a warning; anything else, or three identical
#   layers, stops the section before any GDDP request.
# * **Population growth** factors from the IIASA SSP Scenario Explorer (SSP v3 series): national population of model
#   "IIASA-WiC POP 2025" × urban share of "Urbanization Model (World Bank, 2022)" (SSP-extensions platform), India.
#   No NCR-specific SSP urban projection exists in that database, so the national urban-population trajectory is the
#   documented proxy (caveat recorded).

# %%
import math as _s05_math

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt

_S05_ACTIVE = globals().get("DATA_MODE") == "gee"
_S05_VERSION = "s05-v2.1"   # v2.1: GDDP blocks on the native grid, Chen band resolution, 64 km heavy tiles

_S05_GHSL = "JRC/GHSL/P2023A"                 # GHS_BUILT_S / GHS_BUILT_V / GHS_POP, images "<collection>/<epoch>"
_S05_GHSL_EPOCHS = (1975, 2030)               # every 5 years; 2025 and 2030 are GHSL extrapolations
_S05_GHSL_SCALE_M = 100.0
_S05_SRTM = "USGS/SRTMGL1_003"
_S05_SRTM_SCALE_M = 30.0
_S05_GSW = "JRC/GSW1_4/GlobalSurfaceWater"
_S05_GSW_SCALE_M = 30.0
_S05_GDDP = "NASA/GDDP-CMIP6"
_S05_GDDP_SCALE_M = 27830.0
_S05_GDDP_HIST_LAST = 2014
_S05_GDDP_BLOCK_YEARS = 5                     # one request per (scenario, model, 5-year block): <= ~460 daily images
_S05_GDDP_MEMO: dict = {}                     # (scenario, model, b0, b1, band_filter) -> block data or None (failed)
_S05_GDDP_STATS: dict = {"requests": 0, "cache_hits": 0, "seconds": 0.0, "failed_items": []}
# D2: pilot probes (CMIP6 2050 warming pattern through the block cache); default on for a gee pilot
_S05_PILOT_PROBES = _env_bool("LST_PILOT_PROBES",
                              CFG.PROFILE == "pilot" and globals().get("DATA_MODE") == "gee")
_S05_CHEN = "projects/sat-io/open-datasets/FUTURE-URBAN-LAND/CHEN_2020_2100"
_S05_CHEN_URBAN = 2
_S05_CHEN_BANDS = {"ssp126": "SSP1", "ssp245": "SSP2", "ssp585": "SSP5"}   # expected names (resolved at run time)
_S05_STATIC_KEYS = ["elevation", "slope", "aspect_sin", "aspect_cos", "water_occ"]
_S05_STATIC_FINE_KEYS = ["elevation_f", "water_occ_f"]
_S05_ERA5_KEYS = ["era5_t2m", "era5_rh", "era5_vpd", "era5_swvl1", "era5_evap", "era5_ssr", "era5_wind",
                  "era5_tmax", "era5_tmin", "era5_precip_jfm"]
_S05_GLC_KEYS = list(_S04_GLC_KEYS)
_S05_COARSE_KEYS = ["built_v", "pop"] + _S05_GLC_KEYS + _S05_ERA5_KEYS
# SPEC §3.2 RAW_OBS keys (fine keys except built_f come from section 03, night/MODIS keys from section 04)
_S05_RAW_FINE_KEYS = ["lst_day_f", "lst_day_nobs_f", "ndvi_f", "ndbi_f", "mndwi_f", "albedo_f", "ndvi_spring_f",
                      "built_f"]
_S05_RAW_COARSE_KEYS = ["lst_night", "lst_night_nobs", "lst_day_modis"] + _S05_COARSE_KEYS

# The 34 GDDP-CMIP6 models of the Earth Engine catalog (checked 2026-10-02; re-checked at run time).
_S05_GDDP_MODELS = [
    "ACCESS-CM2", "ACCESS-ESM1-5", "BCC-CSM2-MR", "CESM2", "CESM2-WACCM", "CMCC-CM2-SR5", "CMCC-ESM2", "CNRM-CM6-1",
    "CNRM-ESM2-1", "CanESM5", "EC-Earth3", "EC-Earth3-Veg-LR", "FGOALS-g3", "GFDL-CM4", "GFDL-ESM4", "GISS-E2-1-G",
    "HadGEM3-GC31-LL", "HadGEM3-GC31-MM", "IITM-ESM", "INM-CM4-8", "INM-CM5-0", "IPSL-CM6A-LR", "KACE-1-0-G",
    "KIOST-ESM", "MIROC-ES2L", "MIROC6", "MPI-ESM1-2-HR", "MPI-ESM1-2-LR", "MRI-ESM2-0", "NESM3", "NorESM2-LM",
    "NorESM2-MM", "TaiESM1", "UKESM1-0-LL",
]

# IIASA SSP Scenario Explorer, India (retrieved 2026-10-02 from the public ixmp4 API):
#   population: platform "ssp" (https://data.ece.iiasa.ac.at/ssp), model "IIASA-WiC POP 2025", variable "Population"
#   (million), run version 1 (SSP v3 series, 2025 rebase; Zenodo record "SSP Population and Human-Capital
#   Projections, 2025-Rebased", zen2025V01);
#   urban share: platform "ssp-extensions", model "Urbanization Model (World Bank, 2022)", variable
#   "Population|Urban [Share]" (%), run version 1.
# Years 2025, 2030, ..., 2050. Urban population = population x share / 100.
_S05_SSP_INDIA = {
    "SSP1": {"pop_million": (1445.483, 1492.563, 1525.461, 1545.104, 1554.934, 1554.792),
             "urban_pct": (38.830, 41.501, 44.115, 46.657, 49.218, 51.915)},
    "SSP2": {"pop_million": (1445.483, 1501.738, 1548.090, 1583.720, 1607.738, 1620.410),
             "urban_pct": (35.900, 37.649, 39.393, 41.047, 42.626, 44.212)},
    "SSP5": {"pop_million": (1445.483, 1492.043, 1524.346, 1543.366, 1552.587, 1551.873),
             "urban_pct": (41.479, 45.175, 48.880, 52.582, 56.226, 59.654)},
}
_S05_SSP_YEARS = (2025, 2030, 2035, 2040, 2045, 2050)
_S05_SSP_OF = {"ssp126": "SSP1", "ssp245": "SSP2", "ssp585": "SSP5"}
_S05_SSP_CITATION = ("IIASA SSP Scenario Explorer (SSP v3 series): India 'Population' of model 'IIASA-WiC POP 2025' "
                     "(platform ssp, run v1, 2025-rebased SSP population) x 'Population|Urban [Share]' of "
                     "'Urbanization Model (World Bank, 2022)' (platform ssp-extensions, run v1); retrieved "
                     "2026-10-02 via the public ixmp4 API (https://data.ece.iiasa.ac.at/ssp)")

# IPCC AR6 WG1 Chapter 4, Table 4.5: assessed 20-year GSAT change relative to 1995-2014 (central estimates, °C):
# near term 2021-2040, mid-term 2041-2060, long term 2081-2100 (verified against the published table).
_S05_AR6_GSAT = {"ssp126": {"2021-2040": 0.6, "2041-2060": 0.9, "2081-2100": 0.9},
                 "ssp245": {"2021-2040": 0.7, "2041-2060": 1.1, "2081-2100": 1.8},
                 "ssp585": {"2021-2040": 0.8, "2041-2060": 1.5, "2081-2100": 3.5}}
_S05_AR6_CITATION = ("IPCC AR6 WG1 Ch. 4 (Lee et al. 2021) Table 4.5, assessed GSAT change vs 1995-2014 "
                     "(central values), piecewise-linear in window centre between 1995-2014 (0), 2021-2040, "
                     "2041-2060 and 2081-2100")

if _S05_ACTIVE:
    log(f"section 05 ({_S05_VERSION}): drivers for frames {list(CFG.FRAMES_OBS)}, future inputs for "
        f"{[CFG.NOW] + list(CFG.FRAMES_PROJ)}")
else:
    log("section 05 skipped: data mode is not 'gee' (section 02 provided the synthetic drivers and future inputs)")

# %% [markdown]
# ## 5.1 Static terrain and surface water (`RAW_STATIC`)
# SRTM 30 m elevation and `ee.Terrain.products` slope/aspect; aspect enters as sin/cos **at 30 m before averaging**
# (averaging angles directly is meaningless across north). JRC GSW 1.4 `occurrence` (% of valid observations with
# water 1984–2021) is unmasked to 0 where water was never seen and scaled to 0–1. Area-weighted means to 1 km and to
# the fine grid; isolated gaps inside the ROI (SRTM voids) are filled from the nearest valid pixel.

# %%
def _s05_static_images() -> tuple:
    """(1 km image, fine image) of the static terrain/water bands."""
    dem = ee.Image(_S05_SRTM).select("elevation")
    proj = dem.projection()
    terrain = ee.Terrain.products(dem)
    aspect = terrain.select("aspect").multiply(_s05_math.pi / 180.0)
    gsw = ee.Image(_S05_GSW).select("occurrence")
    water = gsw.unmask(0).divide(100.0).toFloat().rename("water_occ").setDefaultProjection(gsw.projection())
    stack = ee.Image.cat([dem.toFloat().rename("elevation"), terrain.select("slope").toFloat().rename("slope"),
                          aspect.sin().toFloat().rename("aspect_sin"),
                          aspect.cos().toFloat().rename("aspect_cos")]).setDefaultProjection(proj)
    coarse = ee.Image.cat([_s04_to_grid(stack, _S05_SRTM_SCALE_M, GRID),
                           _s04_to_grid(water, _S05_GSW_SCALE_M, GRID)]).unmask(NODATA_FLOAT).toFloat()
    fine = ee.Image.cat([_s04_to_grid(dem.toFloat().rename("elevation_f").setDefaultProjection(proj),
                                      _S05_SRTM_SCALE_M, GRID_FINE),
                         _s04_to_grid(water.rename("water_occ_f"), _S05_GSW_SCALE_M, GRID_FINE)]
                        ).unmask(NODATA_FLOAT).toFloat()
    return coarse, fine


def _s05_build_static() -> tuple:
    """RAW_STATIC dict and provenance."""
    coarse_img, fine_img = _s05_static_images()
    with timer("05 static terrain/water"):
        coarse = _s04_fetch(coarse_img, GRID, _S05_STATIC_KEYS, "s05_static", heavy=True)
        fine = _s04_fetch(fine_img, GRID_FINE, _S05_STATIC_FINE_KEYS, "s05_static_fine", heavy=True)
    static = {}
    for i, key in enumerate(_S05_STATIC_KEYS):
        static[key] = _s04_fill_roi_nearest(coarse[i], ROI_MASK, f"RAW_STATIC[{key}]")
    for i, key in enumerate(_S05_STATIC_FINE_KEYS):
        static[key] = _s04_fill_roi_nearest(fine[i], ROI_MASK_FINE, f"RAW_STATIC[{key}]")
    for key in ("water_occ", "water_occ_f"):
        static[key] = np.where(np.isfinite(static[key]), np.clip(static[key], 0.0, 1.0), np.nan).astype(np.float32)
    terr = (f"{_S05_SRTM} elevation, ee.Terrain.products slope/aspect (aspect sin/cos at 30 m before averaging), "
            f"area-weighted mean to {GRID.res} m")
    sources = {k: terr for k in ("elevation", "slope", "aspect_sin", "aspect_cos")}
    sources["elevation_f"] = terr.replace(f"to {GRID.res} m", f"to {GRID_FINE.res} m")
    sources["water_occ"] = f"{_S05_GSW} occurrence/100 (unmasked 0), area-weighted mean to {GRID.res} m"
    sources["water_occ_f"] = f"{_S05_GSW} occurrence/100 (unmasked 0), area-weighted mean to {GRID_FINE.res} m"
    del coarse, fine
    return static, sources

# %% [markdown]
# ## 5.2 Per-frame drivers: GHSL, GLC_FCS30D, ERA5-Land, `LC_FINE`
# * GHSL epoch = the frame year (5-yearly 1975–2030; clamped to the record).
# * ERA5-Land: `MONTHLY_AGGR` months of the season in every window year (mean of monthly means / totals) and
#   `DAILY_AGGR` daily Tmax/Tmin; Jan–Mar precipitation = mean monthly total × 3 months (mm per JFM season, averaged
#   over the window years). Magnus–Tetens: `e_s(T) = 0.6108·exp(17.27·T/(T+237.3))` kPa, RH = 100·e_s(Td)/e_s(T),
#   VPD = e_s(T) − e_s(Td) — computed from monthly mean T and Td (a mild underestimate of the mean of hourly VPD,
#   consistent across frames). Wind = |mean vector| of monthly u/v (also slightly below the mean speed).
# * `LC_FINE`: the same GLC band, majority (`mode`) aggregation 30 m → `LC_FINE_RES_M`, nodata 0, masked outside the
#   ROI; asset-exported first in `asset` mode (largest raster of the section).

# %%
def _s05_ghsl_epoch(year: int) -> int:
    lo, hi = _S05_GHSL_EPOCHS
    return int(min(hi, max(lo, 5 * round(int(year) / 5))))


def _s05_ghsl(kind: str, epoch: int, band: str):
    image = ee.Image(f"{_S05_GHSL}/{kind}/{int(epoch)}").select(band)
    return image, image.projection()


def _s05_ghsl_fine_built(epoch: int):
    built, proj = _s05_ghsl("GHS_BUILT_S", epoch, "built_surface")
    frac = built.toFloat().divide(10000.0).rename("built_f").setDefaultProjection(proj)
    return _s04_to_grid(frac, _S05_GHSL_SCALE_M, GRID_FINE).unmask(NODATA_FLOAT).toFloat()


def _s05_ghsl_coarse(epoch: int, built_band: str = "built_v"):
    """1 km built volume (m³ m⁻²) and population density (persons km⁻²)."""
    vol, vproj = _s05_ghsl("GHS_BUILT_V", epoch, "built_volume_total")
    pop, pproj = _s05_ghsl("GHS_POP", epoch, "population_count")
    vol = vol.toFloat().divide(10000.0).rename(built_band).setDefaultProjection(vproj)
    pop = pop.toFloat().multiply(100.0).rename("pop").setDefaultProjection(pproj)
    return [_s04_to_grid(vol, _S05_GHSL_SCALE_M, GRID), _s04_to_grid(pop, _S05_GHSL_SCALE_M, GRID)]


def _s05_magnus_es(t_c):
    """Saturation vapour pressure (kPa) of an ee.Image of temperature in °C (Magnus-Tetens)."""
    return t_c.multiply(17.27).divide(t_c.add(237.3)).exp().multiply(0.6108)


def _s05_era5_frame_image(year: int):
    """The ten ERA5-Land window-climatology bands of SPEC §2.3 (bilinear, on GRID)."""
    months = _s04_season_months()
    if months is None:
        raise ValueError(f"ERA5-Land monthly climatology needs a month-aligned season, got {CFG.SEASON}")
    n_months = months[1] - months[0] + 1
    days = _s04_season_days()
    y0, y1 = (int(v) for v in CFG.window(year))
    start, end = _s04_years_dates(y0, y1)
    native = _s04_native(_S04_ERA5_MONTHLY, "temperature_2m")
    mon = ee.ImageCollection(_S04_ERA5_MONTHLY).filterDate(start, end).filter(_s04_season_filter())
    m = mon.mean()
    t = m.select("temperature_2m").subtract(273.15)
    td = m.select("dewpoint_temperature_2m").subtract(273.15)
    es, ea = _s05_magnus_es(t), _s05_magnus_es(td)
    rh = ea.divide(es).multiply(100.0).min(100.0)
    vpd = es.subtract(ea).max(0.0)
    rate = float(n_months) / float(days)          # monthly totals -> per-day rate over the season
    evap = m.select("total_evaporation_sum").multiply(-1000.0 * rate)        # m (negative = evaporation) -> mm/day
    ssr = m.select("surface_net_solar_radiation_sum").multiply(rate / 1e6)    # J m-2 -> MJ m-2 day-1
    u, v = m.select("u_component_of_wind_10m"), m.select("v_component_of_wind_10m")
    wind = u.pow(2).add(v.pow(2)).sqrt()
    daily = (ee.ImageCollection(_S04_ERA5_DAILY).filterDate(start, end).filter(_s04_season_filter())
             .select(["temperature_2m_max", "temperature_2m_min"]).mean().subtract(273.15))
    jfm = (ee.ImageCollection(_S04_ERA5_MONTHLY).filterDate(start, end)
           .filter(ee.Filter.calendarRange(1, 3, "month")).select("total_precipitation_sum").mean()
           .multiply(3.0 * 1000.0))                                            # mm per Jan-Mar season
    stack = ee.Image.cat([
        t.rename("era5_t2m"), rh.rename("era5_rh"), vpd.rename("era5_vpd"),
        m.select("volumetric_soil_water_layer_1").rename("era5_swvl1"), evap.rename("era5_evap"),
        ssr.rename("era5_ssr"), wind.rename("era5_wind"), daily.select("temperature_2m_max").rename("era5_tmax"),
        daily.select("temperature_2m_min").rename("era5_tmin"), jfm.rename("era5_precip_jfm"),
    ]).toFloat()
    return stack.setDefaultProjection(native).resample("bilinear").reproject(crs=GRID.crs,
                                                                            crsTransform=GRID.transform_list())


def _s05_frame_coarse_image(year: int):
    """built_v, pop and the ERA5 bands of one frame as one 1 km image."""
    epoch = _s05_ghsl_epoch(year)
    bands = _s05_ghsl_coarse(epoch) + [_s05_era5_frame_image(year)]
    return ee.Image.cat(bands).unmask(NODATA_FLOAT).toFloat(), ["built_v", "pop"] + _S05_ERA5_KEYS


def _s05_lc_fine_image(year: int, lc_grid: GridSpec):
    """Harmonised GLC classes on the land-cover grid (uint8, 0 = nodata)."""
    coll, band, map_year = _s04_glc_band(year)
    classes, _ = _s04_glc_classes(coll, band)
    if _S04_GLC_SCALE_M < lc_grid.res * 0.999:
        ratio = (lc_grid.res / _S04_GLC_SCALE_M) ** 2
        classes = classes.reduceResolution(reducer=ee.Reducer.mode(), bestEffort=False,
                                           maxPixels=int(max(1024, _s05_math.ceil(ratio * 2.5))))
    image = classes.reproject(crs=lc_grid.crs, crsTransform=lc_grid.transform_list()).unmask(0).toUint8()
    return image.rename("lc"), coll, band, map_year


def _s05_build_drivers() -> dict:
    """Per-frame driver fields, LC_FINE and provenance (the stage-cached unit)."""
    frames = [int(y) for y in CFG.FRAMES_OBS]
    lc_res = int(CFG.fine_res())
    lc_grid = GRID.fine(lc_res)
    f_lc = GRID.res // lc_res
    static, sources = _s05_build_static()
    sources = {k: {y: v for y in frames} for k, v in sources.items()}
    for key in ["built_f", "land_cover"] + _S05_COARSE_KEYS:
        sources.setdefault(key, {})
    obs, lc_fine, caveats = {}, {}, []

    # GHSL fine built-up and the 1 km stack per frame (interactive: light requests)
    for year in frames:
        epoch = _s05_ghsl_epoch(year)
        with timer(f"05 drivers {year}"):
            built_f = _s04_fetch(_s05_ghsl_fine_built(epoch), GRID_FINE, ["built_f"], f"s05_built_f_{epoch}",
                                 tile_px=gee_tile_px(1, np.float32, cap=1024))[0]
            image, names = _s05_frame_coarse_image(year)
            coarse = _s04_fetch(image, GRID, names, f"s05_coarse_{year}", heavy=True)
            glc = _s04_glc_fractions(year)
        rec = {"built_f": np.clip(_s04_fill_roi_nearest(built_f, ROI_MASK_FINE, f"built_f {year}"), 0.0, 1.0)}
        rec["built_f"][~ROI_MASK_FINE] = np.nan
        for i, key in enumerate(names):
            rec[key] = _s04_fill_roi_nearest(coarse[i], ROI_MASK, f"{key} {year}")
        rec["built_v"] = np.where(ROI_MASK, np.clip(rec["built_v"], 0.0, None), np.nan).astype(np.float32)
        rec["pop"] = np.where(ROI_MASK, np.clip(rec["pop"], 0.0, None), np.nan).astype(np.float32)
        rec.update({k: glc["fractions"][k].astype(np.float32) for k in _S05_GLC_KEYS})
        obs[year] = {k: np.ascontiguousarray(v, dtype=np.float32) for k, v in rec.items()}
        del built_f, coarse
        tag = " (GHSL extrapolation)" if epoch >= 2025 else ""
        sources["built_f"][year] = (f"{_S05_GHSL}/GHS_BUILT_S/{epoch} built_surface/1e4 (fraction) at 100 m, "
                                    f"area-weighted mean to {GRID_FINE.res} m{tag}")
        sources["built_v"][year] = (f"{_S05_GHSL}/GHS_BUILT_V/{epoch} built_volume_total/1e4 (m3 per m2 ground), "
                                    f"area-weighted mean to {GRID.res} m{tag}")
        sources["pop"][year] = (f"{_S05_GHSL}/GHS_POP/{epoch} population_count x100 (persons/km2 at 100 m), "
                                f"area-weighted mean to {GRID.res} m{tag}")
        glc_txt = (f"{glc['collection']} band {glc['band']} (= {glc['map_year']}), v1 class remap, class-indicator "
                   f"means 30 m -> {GRID_FINE.res} m -> {GRID.res} m (two-step reduceResolution), renormalised")
        if glc["map_year"] != year:
            glc_txt += f" [{glc['map_year']} map used for the {year} frame]"
        for k in _S05_GLC_KEYS:
            sources[k][year] = glc_txt
        y0, y1 = (int(v) for v in CFG.window(year))
        era = (f"{_S04_ERA5_MONTHLY} {y0}-{y1} {CFG.SEASON[0]}..{CFG.SEASON[1]} monthly mean, bilinear to "
               f"{GRID.res} m")
        sources["era5_t2m"][year] = f"{era}: temperature_2m - 273.15 (°C)"
        sources["era5_rh"][year] = f"{era}: Magnus RH from temperature_2m and dewpoint_temperature_2m (%)"
        sources["era5_vpd"][year] = f"{era}: Magnus es(T) - es(Td) (kPa)"
        sources["era5_swvl1"][year] = f"{era}: volumetric_soil_water_layer_1 (m3 m-3)"
        sources["era5_evap"][year] = (f"{era}: -total_evaporation_sum x1000 x months/season days (mm/day, positive "
                                      "= evaporation)")
        sources["era5_ssr"][year] = f"{era}: surface_net_solar_radiation_sum / 1e6 x months/season days (MJ m-2 d-1)"
        sources["era5_wind"][year] = f"{era}: sqrt(u10^2 + v10^2) of the monthly mean components (m/s)"
        sources["era5_tmax"][year] = (f"{_S04_ERA5_DAILY} {y0}-{y1} Apr-Jun mean of temperature_2m_max - 273.15 "
                                      f"(°C), bilinear to {GRID.res} m")
        sources["era5_tmin"][year] = sources["era5_tmax"][year].replace("temperature_2m_max", "temperature_2m_min")
        sources["era5_precip_jfm"][year] = (f"{_S04_ERA5_MONTHLY} {y0}-{y1} Jan-Mar total_precipitation_sum: mean "
                                            f"monthly total x 3 x 1000 (mm per JFM season), bilinear to {GRID.res} m")
        log(f"frame {year}: built_f {np.nanmean(obs[year]['built_f']):.3f}, built_v "
            f"{np.nanmean(obs[year]['built_v']):.2f} m3/m2, pop {np.nanmean(obs[year]['pop']):,.0f}/km2, glc_built "
            f"{np.nanmean(obs[year]['glc_built']):.3f}, era5_tmax {np.nanmean(obs[year]['era5_tmax']):.2f} °C, "
            f"swvl1 {np.nanmean(obs[year]['era5_swvl1']):.3f}")

    # LC_FINE (largest rasters: asset-exported first in asset mode)
    lc_jobs = []
    for year in frames:
        image, coll, band, map_year = _s05_lc_fine_image(year, lc_grid)
        lc_jobs.append({"name": f"s05_lc_{band}_{lc_res}m", "image": image, "grid": lc_grid, "bands": ["lc"],
                        "dtype": np.uint8, "tile_px": int(CFG.GEE_FINE_TILE_PX), "year": year,
                        "src": (coll, band, map_year)})
    # identical bands (e.g. a frame reusing the 2022 map) are fetched once
    unique = {}
    for job in lc_jobs:
        unique.setdefault(job["name"], job)
    fetched = _s04_fetch_jobs(list(unique.values()), use_assets=True)
    for job in lc_jobs:
        lc = np.ascontiguousarray(fetched[job["name"]][0], dtype=np.uint8).copy()
        lc[lc > 6] = 0
        _mask_fine_inplace(lc, ROI_MASK, f_lc)
        lc_fine[job["year"]] = lc
        coll, band, map_year = job["src"]
        sources["land_cover"][job["year"]] = (f"{coll} band {band} (= {map_year}), v1 class remap, mode-aggregated "
                                              f"to {lc_res} m")
        shares = np.bincount(lc.ravel(), minlength=7)[1:] / max(1, int((lc > 0).sum()))
        log(f"  LC_FINE {job['year']} ({band}, {lc_res} m): " + ", ".join(
            f"{LC_CLASS_NAMES[c].split('/')[0]} {100 * s:.1f}%" for c, s in zip(range(1, 7), shares)))
    del fetched
    if any(_s05_ghsl_epoch(y) >= 2025 for y in frames):
        caveats.append("GHSL built-up, volume and population of the 2025 frame are GHSL P2023A extrapolations.")
    if any(_s04_glc_band(y)[2] != y for y in frames):
        caveats.append("Land cover of the 2025 frame (and of any frame after 2022) is the GLC_FCS30D 2022 map.")
    free_memory()
    return {"static": static, "obs": obs, "lc_fine": lc_fine, "sources": sources, "caveats": caveats}

# %% [markdown]
# ## 5.3 Future inputs (`FUTURE_INPUTS`, SPEC §3.2 / §4.9–4.10)
# **GDDP-CMIP6 blocks (D7).** There are no 20-year interactive reductions. Every value comes from per-(scenario,
# model, 5-year block) means: blocks 2016–2020, 2021–2025, …, 2056–2060 (a window starting in 2014 or earlier joins the
# `historical` scenario). Each block is **one** `ee.data.computePixels` call of `[mean(tasmax, tasmin), count]` over
# the Apr–Jun days of that model and block (≤ ~460 daily images) on a small EPSG:4326 grid aligned to the native
# 0.25° GDDP lattice (grid bounds + 1 cell, ~16 × 18 px). Transient errors are retried, a failing item is isolated
# (the model is dropped by the completeness filter), nothing is split. Results are cached as
# `CACHE_DIR/gddp/<scenario>_<model>_<b0>_<b1>_<expression digest>.npz`, so a failure later in the section (or a
# new session with an imported cache) costs no further GDDP request. Blocks run in a thread pool of
# `CFG.GEE_WORKERS`, with the time budget checked before every request.
#
# **CMIP6 table.** For each frame F (2025 baseline + projections) the window W(F) = `CFG.PROJ_WINDOWS[F]` (20 years
# centred on F) is covered by 4 blocks; its field is the per-pixel day-count-weighted mean of the blocks, bilinearly
# interpolated to the 1 km cell centres, and `value_k` is the mean of that field over the ROI cells, per scenario
# s ∈ {ssp245, ssp585}, model and variable. Day counts (at the ROI-centre pixel) are checked against the season length,
# models incomplete in any frame are dropped and values must lie in 270–330 K.
#
# **Warming pattern.** Median over the complete ssp245 models of (field W(2050) − field W(2025)) on the grid, divided
# by its ROI mean (≈ 1 everywhere; > 1 where the GCMs warm faster than the NCR average) — from the same cached blocks.
# The pilot (no projection frames) keeps a uniform pattern but **probes** this computation for 2050
# (`LST_PILOT_PROBES`, default on for a gee pilot): its time, requests and ROI-mean warming are recorded in
# `FUTURE_INPUTS_DIAG['probes']` and printed as the PILOT PROBES table; a probe failure is a loud warning, not an
# error.
#
# **AR6 GSAT increments.** `G_s(c)` = assessed GSAT change vs 1995–2014 at window centre c, piecewise linear through
# (2004.5, 0), (2030.5, near term), (2050.5, mid-term), (2090.5, long term); `gsat_increment[s][F] = G_s(c(W(F))) −
# G_s(c(W(2025)))`. Section 11 pattern-scales ssp126 as `ΔT_245 × inc_126 / inc_245`.

# %%
def _s05_gcm_window(frame: int) -> tuple:
    """20-year GCM window of a projection frame or of NOW (``CFG.PROJ_WINDOWS``: 2025 -> 2016-2035, ...).

    Not ``CFG.window``: for NOW that returns the 2024-2026 *observation* window of the 2025 frame.
    """
    frame = int(frame)
    if frame not in CFG.PROJ_WINDOWS:
        raise KeyError(f"no GCM window for frame {frame} (CFG.PROJ_WINDOWS has {sorted(CFG.PROJ_WINDOWS)})")
    y0, y1 = CFG.PROJ_WINDOWS[frame]
    return int(y0), int(y1)


def _s05_window_centre(frame: int) -> float:
    y0, y1 = _s05_gcm_window(frame)
    return 0.5 * (y0 + y1)


def _s05_ar6_gsat_at(scenario: str, centre: float) -> float:
    """AR6 assessed GSAT change (vs 1995-2014) at a 20-year window centre, piecewise linear (extrapolated flat
    beyond the last assessed window)."""
    table = _S05_AR6_GSAT[scenario]
    xs = [2004.5, 2030.5, 2050.5, 2090.5]
    ys = [0.0, table["2021-2040"], table["2041-2060"], table["2081-2100"]]
    return float(np.interp(float(centre), xs, ys))


def _s05_gsat_increment(frames: Sequence[int]) -> dict:
    """{scenario: {frame: K}} GSAT increment of each frame window over the NOW window (SPEC §3.2)."""
    base_centre = _s05_window_centre(CFG.NOW)
    return {s: {int(f): round(_s05_ar6_gsat_at(s, _s05_window_centre(f)) - _s05_ar6_gsat_at(s, base_centre), 4)
                for f in frames} for s in _S05_AR6_GSAT}


def _s05_pop_growth(frames: Sequence[int]) -> tuple:
    """DataFrame [scenario, frame, factor]: India urban population vs NOW per SSP (geometric between 5-year values,
    last 5-year growth rate extrapolated beyond 2050), plus caveats."""
    caveats, rows = [], []
    years = np.asarray(_S05_SSP_YEARS, np.float64)
    for scenario, ssp in _S05_SSP_OF.items():
        t = _S05_SSP_INDIA[ssp]
        urban = np.asarray(t["pop_million"]) * np.asarray(t["urban_pct"]) / 100.0
        log_u = np.log(urban)

        def at(year: float, log_u=log_u) -> float:
            if year <= years[-1]:
                return float(np.exp(np.interp(year, years, log_u)))
            rate = (log_u[-1] - log_u[-2]) / (years[-1] - years[-2])
            return float(np.exp(log_u[-1] + rate * (year - years[-1])))

        base = at(float(CFG.NOW))
        for frame in frames:
            rows.append((scenario, int(frame), round(at(float(frame)) / base, 5)))
    if max(frames) > _S05_SSP_YEARS[-1]:
        caveats.append(f"SSP urban-population factors beyond {_S05_SSP_YEARS[-1]} extrapolate the last 5-year "
                       "growth rate.")
    return pd.DataFrame(rows, columns=["scenario", "frame", "factor"]), caveats


def _s05_gddp_models() -> list:
    """Models present in the Earth Engine GDDP-CMIP6 copy (one cheap batched request), else the documented 34."""
    def _day(scenario, day):
        return (ee.ImageCollection(_S05_GDDP).filterDate(day, (pd.Timestamp(day) + pd.Timedelta(days=1))
                                                         .strftime("%Y-%m-%d"))
                .filter(ee.Filter.eq("scenario", scenario)).aggregate_array("model").distinct())
    try:
        info = _s04_getinfo(ee.Dictionary({"historical": _day("historical", "2010-05-01"),
                                           "ssp245": _day("ssp245", "2050-05-01"),
                                           "ssp585": _day("ssp585", "2050-05-01")}), "GDDP-CMIP6 model list")
        found = sorted(set(info.get("ssp245") or []) | set(info.get("ssp585") or []))
    except Exception as exc:  # noqa: BLE001 - the documented list is a safe fallback
        log(f"GDDP-CMIP6 model discovery failed ({str(exc)[:160]}); using the documented 34 models", "WARNING")
        return list(_S05_GDDP_MODELS)
    if not found:
        log("GDDP-CMIP6 model discovery returned nothing; using the documented 34 models", "WARNING")
        return list(_S05_GDDP_MODELS)
    extra, missing = sorted(set(found) - set(_S05_GDDP_MODELS)), sorted(set(_S05_GDDP_MODELS) - set(found))
    if extra or missing:
        log(f"GDDP-CMIP6 models differ from the documented list: +{extra} -{missing}", "WARNING")
    return found


def _s05_gddp_window(scenario: str, y0: int, y1: int, band_filter: bool = True):
    """Daily Apr-Jun GDDP images of a window (historical <= 2014 joined with the scenario), tasmax+tasmin only.

    ``band_filter`` keeps only images whose ``system:band_names`` list both variables (models without them drop
    out cleanly); without it a model lacking a band fails on ``select`` and is isolated by the batched request.
    """
    def _base(start, end):
        col = ee.ImageCollection(_S05_GDDP).filterDate(start, end).filter(_s04_season_filter())
        if band_filter:
            col = (col.filter(ee.Filter.listContains("system:band_names", "tasmax"))
                   .filter(ee.Filter.listContains("system:band_names", "tasmin")))
        return col.filter(ee.Filter.Or(ee.Filter.neq("model", "GFDL-CM4"), ee.Filter.eq("grid_label", "gr1")))

    parts = []
    if y0 <= _S05_GDDP_HIST_LAST:
        start, end = _s04_years_dates(y0, min(y1, _S05_GDDP_HIST_LAST))
        parts.append(_base(start, end).filter(ee.Filter.eq("scenario", "historical")))
    if y1 > _S05_GDDP_HIST_LAST:
        start, end = _s04_years_dates(max(y0, _S05_GDDP_HIST_LAST + 1), y1)
        parts.append(_base(start, end).filter(ee.Filter.eq("scenario", scenario)))
    col = parts[0]
    for extra in parts[1:]:
        col = col.merge(extra)
    return col.select(["tasmax", "tasmin"])


def _s05_window_for(frame: int) -> tuple:
    """GCM window of a frame: ``CFG.PROJ_WINDOWS`` when defined, else the SPEC rule ``_projection_window`` (the
    pilot probe needs the 2050 window although the pilot has no projection frames)."""
    frame = int(frame)
    if frame in CFG.PROJ_WINDOWS:
        return _s05_gcm_window(frame)
    y0, y1 = _projection_window(frame)
    return int(y0), int(y1)


def _s05_blocks(y0: int, y1: int) -> list:
    """5-year blocks covering [y0, y1]: (y0, y0+4), (y0+5, y0+9), ... (2016-2020, ..., 2056-2060 for the SPEC
    windows); a window starting <= 2014 gets blocks that join the historical scenario via _s05_gddp_window."""
    return [(int(b0), int(min(b0 + _S05_GDDP_BLOCK_YEARS - 1, y1)))
            for b0 in range(int(y0), int(y1) + 1, _S05_GDDP_BLOCK_YEARS)]


def _s05_gddp_lattice() -> dict:
    """EPSG:4326 request grid aligned to the native 0.25° GDDP lattice, covering the grid bounds + 1 cell (memoised).

    The native transform is read once from the catalog (``projection().getInfo()``); if it cannot be parsed, a 0.25°
    lattice anchored at lon 0 / lat 90 is used (the GDDP grid has its pixel edges on multiples of 0.25°).
    """
    memo = globals().get("_S05_GDDP_LATTICE")
    if memo:
        return memo
    sx, ox, sy, oy = 0.25, 0.0, -0.25, 90.0
    how = "fallback 0.25 deg lattice anchored at lon 0 / lat 90"
    try:
        info = _s04_getinfo(_s04_native(_S05_GDDP, "tasmax"), "GDDP-CMIP6 native projection") or {}
        tr, crs = info.get("transform"), info.get("crs")
        if (isinstance(tr, (list, tuple)) and len(tr) == 6 and crs in (None, "EPSG:4326")
                and abs(float(tr[1])) < 1e-12 and abs(float(tr[3])) < 1e-12
                and 0.01 < float(tr[0]) < 2.0 and -2.0 < float(tr[4]) < -0.01):
            sx, ox, sy, oy = float(tr[0]), float(tr[2]), float(tr[4]), float(tr[5])
            how = f"native {crs or 'EPSG:4326'} transform {list(tr)}"
        else:
            log(f"GDDP-CMIP6 native projection not usable ({str(info)[:160]}); using the {how}", "WARNING")
    except Exception as exc:  # noqa: BLE001 - the fallback lattice is the documented 0.25 deg grid
        log(f"GDDP-CMIP6 native projection unavailable ({type(exc).__name__}: {str(exc)[:160]}); using the {how}",
            "WARNING")
    lon0, lat0, lon1, lat1 = GRID.bounds_lonlat()
    i0 = int(math.floor((lon0 - ox) / sx)) - 1
    i1 = int(math.ceil((lon1 - ox) / sx)) + 1
    j0 = int(math.floor((lat1 - oy) / sy)) - 1          # sy < 0: row index grows southwards
    j1 = int(math.ceil((lat0 - oy) / sy)) + 1
    x0, y0 = ox + i0 * sx, oy + j0 * sy
    width, height = i1 - i0, j1 - j0
    lattice = {"transform": [sx, 0.0, x0, 0.0, sy, y0], "width": int(width), "height": int(height), "how": how,
               "affine": {"scaleX": sx, "shearX": 0.0, "translateX": x0, "shearY": 0.0, "scaleY": sy,
                          "translateY": y0}}
    log(f"GDDP-CMIP6 request grid: {width}x{height} px of {sx:g} deg from ({x0:g}, {y0:g}) [{how}]")
    globals()["_S05_GDDP_LATTICE"] = lattice
    return lattice


def _s05_gddp_cache_path(scen_eff: str, model: str, b0: int, b1: int, digest: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", f"{scen_eff}_{model}_{int(b0)}_{int(b1)}_{digest[:10]}")
    return CFG.CACHE_DIR / "gddp" / f"{safe}.npz"


def _s05_gddp_block_image(scenario: str, model: str, b0: int, b1: int, band_filter: bool):
    """Mean daily tasmax/tasmin and the day count ``n`` of one model over the Apr-Jun days of one 5-year block."""
    col = _s05_gddp_window(scenario, b0, b1, band_filter).filter(ee.Filter.eq("model", model))
    img = ee.Image.cat([col.mean(), col.select("tasmax").count().rename("n")]).toFloat()
    return img.unmask(NODATA_FLOAT, False)


def _s05_gddp_block(scenario: str, model: str, b0: int, b1: int, band_filter: bool, lattice: dict,
                    slowest: list) -> tuple:
    """One block: ``(data or None, from_cache, error)``; data = {tasmax, tasmin (K), n} on the request grid.

    One ``ee.data.computePixels`` call (NUMPY_NDARRAY) on the aligned EPSG:4326 grid, never split; transient errors
    are retried by ``_s03_call``, a permanent error isolates the item (returned as an error, the completeness filter
    then drops the model). The result is cached atomically under ``CACHE_DIR/gddp`` (expression digest in the name;
    the grid transform is checked on load).
    """
    scen_eff = "historical" if int(b1) <= _S05_GDDP_HIST_LAST else scenario
    img = _s05_gddp_block_image(scenario, model, b0, b1, band_filter)
    digest = _gee_expression_digest(img)
    path = _s05_gddp_cache_path(scen_eff, model, b0, b1, digest)
    shape = (int(lattice["height"]), int(lattice["width"]))
    if not path.exists():
        cache_restore(path)
    if path.exists():
        try:
            with np.load(path) as z:
                if (tuple(z["tasmax"].shape) == shape
                        and np.allclose(np.asarray(z["transform"], np.float64), lattice["transform"], atol=1e-9)):
                    return {k: np.asarray(z[k], np.float32) for k in ("tasmax", "tasmin", "n")}, True, None
            log(f"GDDP block cache {path.name} was made on another request grid; refetching", "WARNING")
        except (OSError, ValueError, KeyError) as exc:
            log(f"ignoring unreadable GDDP block cache {path.name}: {exc}", "WARNING")
    check_budget(f"GDDP block {scen_eff} {model} {b0}-{b1}", 1.25 * slowest[0])
    request = {"expression": img, "fileFormat": "NUMPY_NDARRAY", "bandIds": ["tasmax", "tasmin", "n"],
               "grid": {"dimensions": {"width": shape[1], "height": shape[0]}, "affineTransform": lattice["affine"],
                        "crsCode": "EPSG:4326"}}
    t0 = time.perf_counter()
    try:
        raw = _s03_call(lambda: ee.data.computePixels(request), f"GDDP {scen_eff} {model} {b0}-{b1}")
        raw = np.asarray(raw)
        if raw.dtype.names:
            stack = np.stack([np.asarray(raw[b], np.float32) for b in ("tasmax", "tasmin", "n")])
        else:
            stack = np.moveaxis(np.asarray(raw, np.float32), -1, 0)
        if stack.shape != (3,) + shape:
            raise RuntimeError(f"computePixels returned shape {stack.shape}, expected {(3,) + shape}")
    except Exception as exc:  # noqa: BLE001 - permanent error: isolate this item
        return None, False, f"{type(exc).__name__}: {str(exc)[:240]}"
    slowest[0] = max(slowest[0], time.perf_counter() - t0)
    stack = stack.astype(np.float32)
    stack[stack == NODATA_FLOAT] = np.nan
    n = np.nan_to_num(stack[2], nan=0.0)
    data = {"tasmax": np.where(n > 0, stack[0], np.nan).astype(np.float32),
            "tasmin": np.where(n > 0, stack[1], np.nan).astype(np.float32), "n": n.astype(np.float32)}
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    try:
        with open(tmp, "wb") as fh:
            np.savez(fh, **data, transform=np.asarray(lattice["transform"], np.float64))
        os.replace(tmp, path)
    except OSError as exc:
        log(f"GDDP block cache {path.name} not written ({exc})", "WARNING")
    return data, False, None


def _s05_gddp_key(scenario: str, model: str, b0: int, b1: int, band_filter: bool) -> tuple:
    scen_eff = "historical" if int(b1) <= _S05_GDDP_HIST_LAST else scenario
    return scen_eff, str(model), int(b0), int(b1), bool(band_filter)


def _s05_gddp_fetch_blocks(items: Sequence[tuple], band_filter: bool, label: str) -> dict:
    """Fetch (scenario, model, b0, b1) blocks in a thread pool of ``CFG.GEE_WORKERS`` (memo + disk cache).

    Updates ``_S05_GDDP_MEMO`` ({key: data or None}) and ``_S05_GDDP_STATS`` (requests, cache_hits, failed_items,
    seconds); returns the statistics of this call. The time budget is checked before every request.
    """
    lattice = _s05_gddp_lattice()
    memo = _S05_GDDP_MEMO
    todo, seen = [], set()
    for s, m, b0, b1 in items:
        key = _s05_gddp_key(s, m, b0, b1, band_filter)
        if key not in memo and key not in seen:
            seen.add(key)
            todo.append((s, m, b0, b1, key))
    call = {"items": len(todo), "requests": 0, "cache_hits": 0, "failed_items": [], "seconds": 0.0}
    if not todo:
        return call
    t0 = time.perf_counter()
    slowest = [0.0]
    step = max(1, len(todo) // 10)

    def _job(spec):
        s, m, b0, b1, key = spec
        return key, _s05_gddp_block(s, m, b0, b1, band_filter, lattice, slowest)

    pool = ThreadPoolExecutor(max_workers=max(1, min(CFG.GEE_WORKERS, len(todo))), thread_name_prefix="gddp")
    futures = [pool.submit(_job, spec) for spec in todo]
    done = 0
    try:
        for fut in as_completed(futures):
            key, (data, cached, error) = fut.result()
            memo[key] = data
            done += 1
            if cached:
                call["cache_hits"] += 1
            else:
                call["requests"] += 1
            if error is not None:
                call["failed_items"].append({"item": list(key[:4]), "error": error})
                log(f"GDDP block {key[0]} {key[1]} {key[2]}-{key[3]} failed and is skipped (the model is dropped "
                    f"if incomplete): {error}", "WARNING")
            if done % step == 0 or done == len(todo):
                log(f"  {label}: {done}/{len(todo)} GDDP blocks ({call['cache_hits']} from cache, "
                    f"{len(call['failed_items'])} failed, {time.perf_counter() - t0:.0f}s)")
    except LSTStop:
        pool.shutdown(wait=True, cancel_futures=True)     # in-flight blocks finish and are cached
        raise
    except BaseException:
        pool.shutdown(wait=False, cancel_futures=True)
        raise
    pool.shutdown(wait=True)
    call["seconds"] = round(time.perf_counter() - t0, 1)
    st = _S05_GDDP_STATS
    st["requests"] += call["requests"]
    st["cache_hits"] += call["cache_hits"]
    st["seconds"] = round(st["seconds"] + call["seconds"], 1)
    st["failed_items"] += call["failed_items"]
    return call


def _s05_window_native(scenario: str, model: str, window: tuple, band_filter: bool) -> Optional[dict]:
    """Per-pixel n-weighted mean of the blocks of ``window`` on the request grid ({tasmax, tasmin, n}); None when a
    block is missing (failed item)."""
    datas = []
    for b0, b1 in _s05_blocks(*window):
        data = _S05_GDDP_MEMO.get(_s05_gddp_key(scenario, model, b0, b1, band_filter))
        if data is None:
            return None
        datas.append(data)
    n_tot = np.zeros_like(datas[0]["n"], dtype=np.float64)
    out = {}
    for var in ("tasmax", "tasmin"):
        num = np.zeros_like(n_tot)
        den = np.zeros_like(n_tot)
        for d in datas:
            v = np.asarray(d[var], np.float64)
            w = np.where(np.isfinite(v), np.asarray(d["n"], np.float64), 0.0)
            num += w * np.nan_to_num(v, nan=0.0)
            den += w
        with np.errstate(invalid="ignore", divide="ignore"):
            out[var] = np.where(den > 0, num / np.where(den > 0, den, 1.0), np.nan)
    for d in datas:
        n_tot += np.asarray(d["n"], np.float64)
    out["n"] = n_tot
    return out


def _s05_grid_points() -> tuple:
    """(lat, lon) of the GRID cell centres, flattened (memoised)."""
    memo = globals().get("_S05_GRID_LATLON")
    if memo is None:
        lon, lat = GRID.lonlat()
        memo = (np.asarray(lat, np.float64).ravel(), np.asarray(lon, np.float64).ravel())
        globals()["_S05_GRID_LATLON"] = memo
    return memo


def _s05_to_grid(field: np.ndarray, lattice: dict) -> np.ndarray:
    """Bilinear interpolation of a request-grid field to the GRID cell centres (NaN-safe normalised weights)."""
    from scipy.interpolate import RegularGridInterpolator

    sx, _, x0, _, sy, y0 = lattice["transform"]
    h, w = field.shape
    lons = x0 + (np.arange(w) + 0.5) * sx
    lats = y0 + (np.arange(h) + 0.5) * sy
    order = np.argsort(lats)                     # ascending axes for the interpolator
    lats, vals = lats[order], np.asarray(field, np.float64)[order]
    valid = np.isfinite(vals)
    pts = np.column_stack(_s05_grid_points())
    num = RegularGridInterpolator((lats, lons), np.where(valid, vals, 0.0), method="linear", bounds_error=False,
                                  fill_value=np.nan)(pts)
    den = RegularGridInterpolator((lats, lons), valid.astype(np.float64), method="linear", bounds_error=False,
                                  fill_value=np.nan)(pts)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = np.where(den > 1e-9, num / np.where(den > 1e-9, den, 1.0), np.nan)
    return out.reshape(GRID.shape)


def _s05_centre_index(lattice: dict) -> tuple:
    """(row, col) of the request-grid pixel containing the ROI centre."""
    sx, _, x0, _, sy, y0 = lattice["transform"]
    lon_c, lat_c = float(np.mean(CELL_LON)), float(np.mean(CELL_LAT))
    col = int(np.clip(math.floor((lon_c - x0) / sx), 0, lattice["width"] - 1))
    row = int(np.clip(math.floor((lat_c - y0) / sy), 0, lattice["height"] - 1))
    return row, col


def _s05_cmip6_table(frames: Sequence[int], models: Sequence[str], band_filter: bool = True) -> tuple:
    """GDDP-CMIP6 ROI-mean Apr-Jun tasmax/tasmin per (scenario, model, frame) -> DataFrame, diagnostics (D7).

    Every value comes from cached per-(scenario, model, 5-year block) means: the window field is the per-pixel
    n-weighted mean of its blocks, bilinear to the grid cell centres, and ``value_k`` its mean over ``ROI_MASK``.
    """
    scenarios = ("ssp245", "ssp585")
    windows = {int(f): _s05_window_for(f) for f in frames}
    items = [(s, m, b0, b1) for f in frames for s in scenarios for m in models for b0, b1 in _s05_blocks(*windows[f])]
    with timer(f"05 GDDP-CMIP6 blocks for windows {sorted(set(windows.values()))} ({len(models)} models)"):
        call = _s05_gddp_fetch_blocks(items, band_filter, "GDDP table")
    lattice = _s05_gddp_lattice()
    rc = _s05_centre_index(lattice)
    roi = np.asarray(ROI_MASK, bool)
    season_days = _s04_season_days()
    rows, counts = [], []
    for frame in frames:
        y0, y1 = windows[int(frame)]
        expected = season_days * (y1 - y0 + 1)
        for s in scenarios:
            for m in models:
                nat = _s05_window_native(s, m, (y0, y1), band_filter)
                n = int(round(float(nat["n"][rc]))) if nat is not None else 0
                counts.append({"scenario": s, "model": m, "frame": int(frame), "n": n})
                if nat is None or n == 0:
                    continue
                if not 0.9 * expected <= n <= 1.05 * expected:
                    log(f"GDDP {m} {s} {y0}-{y1}: {n} daily values at the ROI centre (expected ~{expected}); "
                        "possible duplicated/missing days", "WARNING")
                vals = {}
                for var in ("tasmax", "tasmin"):
                    field = _s05_to_grid(nat[var], lattice)
                    vals[var] = float(np.nanmean(field[roi])) if np.isfinite(field[roi]).any() else float("nan")
                if not all(np.isfinite(v) for v in vals.values()):
                    continue
                for var in ("tasmax", "tasmin"):
                    rows.append((s, m, int(frame), var, vals[var]))
    df = pd.DataFrame(rows, columns=["scenario", "model", "frame", "var", "value_k"])
    # keep only models complete in every frame and both variables of a scenario (deltas must be defined)
    need = len(frames) * 2
    complete = df.groupby(["scenario", "model"])["value_k"].transform("size") == need
    dropped = sorted(set(map(tuple, df.loc[~complete, ["scenario", "model"]].drop_duplicates().values)))
    missing = sorted({(s, m) for s in scenarios for m in models}
                     - set(map(tuple, df[["scenario", "model"]].drop_duplicates().values)))
    if dropped or missing:
        log(f"GDDP-CMIP6: dropping incomplete model-scenarios {dropped}; without data: {missing}", "WARNING")
    df = df[complete].sort_values(["scenario", "model", "var", "frame"], kind="stable").reset_index(drop=True)
    diag = {"image_counts": counts, "dropped": [list(d) for d in dropped], "no_data": [list(d) for d in missing],
            "band_filter": bool(band_filter), "requests": call["requests"], "cache_hits": call["cache_hits"],
            "seconds": call["seconds"], "failed_items": call["failed_items"], "blocks": call["items"],
            "request_grid": {k: lattice[k] for k in ("transform", "width", "height", "how")}}
    if df.empty:
        raise RuntimeError("GDDP-CMIP6 returned no complete model over the ROI")
    plausible = df["value_k"].between(270.0, 330.0)
    if not plausible.all():
        raise RuntimeError(f"GDDP-CMIP6 ROI means outside 270-330 K: {df[~plausible].head().to_dict('records')}")
    return df, diag


def _s05_cmip6_pattern(models: Sequence[str], target: int, band_filter: bool = True) -> tuple:
    """Ensemble-median ssp245 delta field (W(target) - W(NOW)) on GRID, divided by its ROI mean, for tasmax/tasmin.

    Uses only the cached blocks of the two windows (shared with the CMIP6 table; no other request). Returns
    ``(pattern {var: (H, W) float32}, info {var: {roi_mean_delta_k, min, max}, n_models, requests, cache_hits})``.
    """
    w_now, w_tgt = _s05_window_for(CFG.NOW), _s05_window_for(target)
    items = [("ssp245", m, b0, b1) for m in models for w in (w_now, w_tgt) for b0, b1 in _s05_blocks(*w)]
    with timer(f"05 GDDP-CMIP6 ssp245 pattern {w_tgt[0]}-{w_tgt[1]} minus {w_now[0]}-{w_now[1]}"):
        call = _s05_gddp_fetch_blocks(items, band_filter, f"GDDP pattern {target}")
    lattice = _s05_gddp_lattice()
    deltas = {"tasmax": [], "tasmin": []}
    used = []
    for m in models:
        a = _s05_window_native("ssp245", m, w_now, band_filter)
        b = _s05_window_native("ssp245", m, w_tgt, band_filter)
        if a is None or b is None:
            continue
        used.append(m)
        for var in deltas:
            deltas[var].append(_s05_to_grid(b[var] - a[var], lattice))
    if not used:
        raise RuntimeError(f"no ssp245 model has the blocks of both windows {w_now} and {w_tgt}")
    out, info = {}, {"n_models": len(used), "models": used, "requests": call["requests"],
                     "cache_hits": call["cache_hits"], "seconds": call["seconds"],
                     "windows": [list(w_now), list(w_tgt)]}
    for var in ("tasmax", "tasmin"):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)          # all-NaN cells outside the ROI
            median = np.nanmedian(np.stack(deltas[var]), axis=0).astype(np.float32)
        field = _s04_fill_roi_nearest(median, ROI_MASK, f"cmip6_pattern {var}")
        mean = float(np.nanmean(field[ROI_MASK]))
        if not np.isfinite(mean) or mean <= 0.05:
            log(f"cmip6_pattern {var}: ROI-mean delta {mean:.3f} K is too small to normalise; using 1", "WARNING")
            field = np.where(ROI_MASK, 1.0, np.nan).astype(np.float32)
        else:
            field = (field / mean).astype(np.float32)
        out[var] = field
        info[var] = {"roi_mean_delta_k": round(mean, 4), "min": round(float(np.nanmin(field)), 4),
                     "max": round(float(np.nanmax(field)), 4)}
        log(f"  cmip6_pattern {var}: ensemble-median ({len(used)} models) ROI-mean delta {mean:.2f} K, normalised "
            f"range {info[var]['min']:.3f}-{info[var]['max']:.3f}")
    return out, info


def _s05_chen_resolve(bands: Sequence[str]) -> dict:
    """{scenario: band} of the Chen-2020 SSP urban layers (deterministic; raises when ambiguous).

    A band name normalised to lower-case alphanumerics that equals ``ssp1`` / ``ssp2`` / ``ssp5`` maps to ssp126 /
    ssp245 / ssp585. Otherwise, only for exactly 5 bands, the bands are taken positionally as SSP1..SSP5 (1st, 2nd,
    5th) with a WARNING. Any other layout, or three resolved bands that are not distinct, raises RuntimeError.
    """
    bands = [str(b) for b in bands]
    norm = {b: re.sub(r"[^a-z0-9]", "", b.lower()) for b in bands}
    resolved = {}
    for scenario, want in (("ssp126", "ssp1"), ("ssp245", "ssp2"), ("ssp585", "ssp5")):
        match = [b for b in bands if norm[b] == want]
        if len(match) == 1:
            resolved[scenario] = match[0]
    if len(resolved) < 3:
        if len(bands) != 5:
            raise RuntimeError(f"Chen-2020 band layout {bands} cannot be mapped to SSP1/SSP2/SSP5 (no ssp1/ssp2/ssp5 "
                               "names and not exactly 5 bands)")
        log(f"Chen-2020 bands {bands} carry no SSP names: assuming SSP1..SSP5 band order (ssp126 = {bands[0]}, "
            f"ssp245 = {bands[1]}, ssp585 = {bands[4]})", "WARNING")
        resolved = {"ssp126": bands[0], "ssp245": bands[1], "ssp585": bands[4]}
    if len(set(resolved.values())) != 3:
        raise RuntimeError(f"Chen-2020 bands resolve to non-distinct layers {resolved} (bands {bands})")
    return resolved


def _s05_chen_decade(index: str, t0: Any, t1: Any) -> Optional[int]:
    """Nominal year of a Chen-2020 layer: the 4-digit year ending its ``system:index`` ("global_SSP_2020"), else the
    midpoint of its [time_start, time_end] window rounded to a decade. Never time_start alone: the 2020 layer is
    stamped 2015-01-01 (start of its 2015-2024 window)."""
    m = re.search(r"(\d{4})\D*$", str(index))
    if m:
        return int(m.group(1))
    try:
        a, b = pd.Timestamp(int(t0), unit="ms"), pd.Timestamp(int(t1), unit="ms")
        mid = a + (b - a) / 2
        return int(10 * round(mid.year / 10))
    except (TypeError, ValueError):
        return None


def _s05_chen_bands() -> tuple:
    """Resolve the Chen-2020 band per scenario and the layers of each decade (one batched request).

    Returns ``(resolved, decades, layers)`` with ``layers = {decade: [system:index, ...]}``.
    """
    col = ee.ImageCollection(_S05_CHEN)
    info = _s04_getinfo(ee.Dictionary({"bands": ee.Image(col.first()).bandNames(),
                                       "ids": col.aggregate_array("system:index"),
                                       "t0": col.aggregate_array("system:time_start"),
                                       "t1": col.aggregate_array("system:time_end")}), "Chen-2020 layout")
    bands = list(info.get("bands") or [])
    ids = [str(i) for i in (info.get("ids") or [])]
    t0, t1 = list(info.get("t0") or []), list(info.get("t1") or [])
    aligned = len(t0) == len(ids) and len(t1) == len(ids)       # aggregate_array skips missing values
    layers: dict = {}
    for k, idx in enumerate(ids):
        decade = _s05_chen_decade(idx, t0[k] if aligned else None, t1[k] if aligned else None)
        if decade is not None:
            layers.setdefault(decade, []).append(idx)
    years = sorted(layers)
    resolved = _s05_chen_resolve(bands)
    if 2020 not in years:
        raise RuntimeError(f"Chen-2020 collection lacks the 2020 layer (decades {years}, layers {layers})")
    log(f"Chen-2020 layout: bands {bands}, decades {years}; using {resolved}")
    return resolved, years, layers


def _s05_geo_interp(dec: dict, need_decades: Sequence[int], f: int) -> float:
    """Geometric interpolation of decadal ratios at frame ``f``."""
    if f in dec:
        return float(dec[f])
    lo = max(d for d in need_decades if d <= f)
    hi = min(d for d in need_decades if d >= f)
    w = (f - lo) / (hi - lo)
    return float(dec[lo] ** (1.0 - w) * dec[hi] ** w)


def _s05_urban_growth(frames: Sequence[int], chen: Optional[tuple] = None) -> tuple:
    """DataFrame [scenario, district, frame, ratio] of Chen-2020 urban area vs 2020 per district."""
    bands, years, layers = chen if chen is not None else _s05_chen_bands()
    need_decades = sorted({2020} | {int(10 * _s05_math.floor(f / 10)) for f in frames}
                          | {int(10 * _s05_math.ceil(f / 10)) for f in frames})
    missing = [d for d in need_decades if d not in years]
    if missing:
        raise RuntimeError(f"Chen-2020 lacks decades {missing} needed for frames {list(frames)}")
    col = ee.ImageCollection(_S05_CHEN)
    items = [(s, d) for s in bands for d in need_decades]

    def _build(sub):
        imgs = []
        for s, d in sub:
            # the decade's layers by name, mosaicked (one global image per decade, so no filterBounds is needed;
            # filterBounds(EE_ROI) selected nothing because EE_ROI evaluates to an empty geometry)
            layer = ee.Image(col.filter(ee.Filter.inList("system:index", layers[d])).mosaic()).select(bands[s])
            imgs.append(layer.eq(_S05_CHEN_URBAN).multiply(ee.Image.pixelArea()).divide(1e6).rename(f"{s}_{d}"))
        names = [f"{s}_{d}" for s, d in sub]    # forEach names the outputs: one band would be called "sum"
        fc = ee.Image.cat(imgs).reduceRegions(collection=EE_DISTRICTS, reducer=ee.Reducer.sum().forEach(names),
                                              scale=1000, crs=CFG.CRS, tileScale=4)
        return fc.select(["did"] + names, None, False)

    def _parse(info, sub):
        out = []
        for props in _s04_fc_records(info):
            for s, d in sub:
                value = props.get(f"{s}_{d}")
                if props.get("did") is not None and value is not None:
                    out.append((s, int(props["did"]), int(d), float(value)))
        return out

    with timer("05 Chen-2020 urban area per district"):
        recs = _s04_batched(items, _build, _parse, "Chen-2020 urban area")
    area = {(s, did, d): v for s, did, d, v in recs}
    dids = sorted({did for _, did, _ in area})
    rows, caveats, zero, last_ratio = [], [], [], {}
    last = int(max(frames))
    for s in bands:
        ncr = {d: sum(area.get((s, did, d), 0.0) for did in dids) for d in need_decades}
        if not ncr[2020] > 0:
            raise RuntimeError(f"Chen-2020 band {bands[s]} ({s}) has no urban land (value {_S05_CHEN_URBAN}) in the "
                               "NCR in 2020; the band layout or the urban code is wrong")
        ncr_dec = {d: max(ncr[d], 1e-9) / ncr[2020] for d in need_decades}
        last_ratio[s] = _s05_geo_interp(ncr_dec, need_decades, last)
        for did in dids:
            base = area.get((s, did, 2020), 0.0)
            if base > 0.5:            # km2: at least ~half a 1 km cell of urban land in 2020
                dec = {d: max(area.get((s, did, d), base), 1e-9) / base for d in need_decades}
            else:
                zero.append(did)
                dec = ncr_dec
            for f in frames:
                rows.append((s, int(did), int(f), round(_s05_geo_interp(dec, need_decades, int(f)), 5)))
    if len(last_ratio) > 1 and max(last_ratio.values()) - min(last_ratio.values()) <= 1e-6:
        raise RuntimeError(f"Chen-2020 bands resolve to identical layers: the NCR urban ratio at {last} is "
                           f"{last_ratio} for every scenario (bands {bands})")
    zero = sorted(set(zero))
    if zero:
        names = [DISTRICTS[d]["name"] for d in zero if 0 <= d < len(DISTRICTS)]
        caveats.append(f"Chen-2020 shows (almost) no 2020 urban land in {names}; their urban-growth ratios use the "
                       "NCR-wide ratio.")
    df = pd.DataFrame(rows, columns=["scenario", "district", "frame", "ratio"])
    df = df.sort_values(["scenario", "district", "frame"], kind="stable").reset_index(drop=True)
    return df, caveats


def _s05_ghsl_2030() -> dict:
    """GHSL 2030 built-up fraction and population density on GRID."""
    built, proj = _s05_ghsl("GHS_BUILT_S", 2030, "built_surface")
    frac = built.toFloat().divide(10000.0).rename("built").setDefaultProjection(proj)
    pop = _s05_ghsl_coarse(2030)[1]
    image = ee.Image.cat([_s04_to_grid(frac, _S05_GHSL_SCALE_M, GRID), pop]).unmask(NODATA_FLOAT).toFloat()
    raw = _s04_fetch(image, GRID, ["built", "pop"], "s05_ghsl_2030", heavy=True)
    return {"built": np.clip(_s04_fill_roi_nearest(raw[0], ROI_MASK, "ghsl_2030 built"), 0.0, 1.0),
            "pop": np.clip(_s04_fill_roi_nearest(raw[1], ROI_MASK, "ghsl_2030 pop"), 0.0, None)}


def _s05_run_probes(pattern_models: Sequence[str], band_filter: bool, caveats: list) -> dict:
    """Pilot probes (D2): the ssp245 CMIP6 warming pattern for 2050 through the block cache; never raises."""
    t0 = time.perf_counter()
    before = (int(_S05_GDDP_STATS["requests"]), int(_S05_GDDP_STATS["cache_hits"]))
    rec = {"seconds": None, "requests": 0, "cache_hits": 0, "roi_mean_delta_k": None, "error": None,
           "window": list(_projection_window(2050)), "n_models": 0}
    try:
        _, info = _s05_cmip6_pattern(pattern_models, 2050, band_filter=band_filter)
        rec["roi_mean_delta_k"] = {v: info[v]["roi_mean_delta_k"] for v in ("tasmax", "tasmin")}
        rec["n_models"] = int(info["n_models"])
    except Exception as exc:  # noqa: BLE001 - a probe failure is reported, never fatal (LSTStop still propagates)
        rec["error"] = f"{type(exc).__name__}: {str(exc)[:300]}"
        log(f"PILOT PROBE cmip6_pattern_2050 FAILED: {rec['error']} - the full run would fail the same way in "
            "section 05; fix this before the full run", "WARNING")
        caveats.append(f"Pilot probe of the CMIP6 2050 warming pattern failed ({rec['error'][:160]}).")
    rec["seconds"] = round(time.perf_counter() - t0, 1)
    rec["requests"] = int(_S05_GDDP_STATS["requests"]) - before[0]
    rec["cache_hits"] = int(_S05_GDDP_STATS["cache_hits"]) - before[1]
    return {"cmip6_pattern_2050": rec}


def _s05_build_future() -> dict:
    """FUTURE_INPUTS (the second stage-cached unit of section 05)."""
    frames = [int(CFG.NOW)] + [int(y) for y in CFG.FRAMES_PROJ]
    caveats, diag = [], {}
    _S05_GDDP_MEMO.clear()
    _S05_GDDP_STATS.update(requests=0, cache_hits=0, seconds=0.0, failed_items=[])
    # cheap, fail-fast inputs first: a wrong Chen layout or a GHSL problem must not cost the GDDP requests
    chen = _s05_chen_bands()
    ghsl_2030 = _s05_ghsl_2030()
    models = _s05_gddp_models()
    try:
        cmip6, diag["cmip6"] = _s05_cmip6_table(frames, models)
    except RuntimeError as exc:
        if "no complete model" not in str(exc):
            raise
        # 'system:band_names' filtering removed every image: retry without it (failing models are isolated)
        log(f"GDDP-CMIP6 with the band-name filter returned nothing ({exc}); retrying without it", "WARNING")
        cmip6, diag["cmip6"] = _s05_cmip6_table(frames, models, band_filter=False)
    band_filter = diag["cmip6"]["band_filter"]
    for s, grp in cmip6.groupby("scenario"):
        if len(frames) > 1:
            d = grp.pivot_table(index="model", columns=["var", "frame"], values="value_k")
            last = frames[-1]
            dt = (d[("tasmax", last)] - d[("tasmax", frames[0])])
            log(f"  CMIP6 {s}: {grp['model'].nunique()} models, tasmax delta {frames[0]}->{last} median "
                f"{dt.median():.2f} K (P10 {dt.quantile(0.1):.2f}, P90 {dt.quantile(0.9):.2f})")
    pattern_models = sorted(cmip6.loc[cmip6["scenario"] == "ssp245", "model"].unique())
    if CFG.FRAMES_PROJ:
        target = 2050 if 2050 in CFG.FRAMES_PROJ else int(max(CFG.FRAMES_PROJ))
        pattern, diag["cmip6_pattern"] = _s05_cmip6_pattern(pattern_models, target, band_filter=band_filter)
        if target != 2050:
            caveats.append(f"The CMIP6 warming pattern uses the {target} window (2050 is not a projection frame).")
    else:
        pattern = {v: np.where(ROI_MASK, 1.0, np.nan).astype(np.float32) for v in ("tasmax", "tasmin")}
        diag["cmip6_pattern"] = "uniform (no projection frames in this profile)"
        log("no projection frames: cmip6_pattern set to 1 inside the ROI")
        if _S05_PILOT_PROBES:
            diag["probes"] = _s05_run_probes(pattern_models, band_filter, caveats)
    diag["gddp"] = {k: (list(v) if isinstance(v, list) else v) for k, v in _S05_GDDP_STATS.items()}
    urban, urban_cav = _s05_urban_growth(sorted({2020} | set(frames)), chen=chen)
    caveats += urban_cav
    pop_growth, pop_cav = _s05_pop_growth(frames)
    caveats += pop_cav
    gsat = _s05_gsat_increment(frames)
    log("  pop_growth factors at " + str(frames[-1]) + ": " + ", ".join(
        f"{s} {pop_growth[(pop_growth.scenario == s) & (pop_growth.frame == frames[-1])].factor.iloc[0]:.3f}"
        for s in _S05_SSP_OF))
    log("  gsat_increment at " + str(frames[-1]) + ": " + ", ".join(f"{s} {gsat[s][frames[-1]]:.3f} K" for s in gsat))
    caveats.append("SSP population growth is the IIASA SSP v3 national urban-population trajectory of India (no "
                   "NCR-specific SSP projection exists in the SSP database); it scales the NCR population total.")
    caveats.append("Chen et al. (2020) SSP urban land is binary at 1 km; it enters only as district growth ratios "
                   "relative to its own 2020 layer.")
    future = {"cmip6": cmip6, "cmip6_pattern": pattern, "urban_growth": urban, "ghsl_2030": ghsl_2030,
              "pop_growth": pop_growth, "gsat_increment": gsat}
    w = {f: tuple(int(v) for v in _s05_gcm_window(f)) for f in frames}
    lattice = _s05_gddp_lattice()
    grid_txt = (f"requested per (scenario, model, {_S05_GDDP_BLOCK_YEARS}-year block) on the native "
                f"{lattice['transform'][0]:g} deg grid ({lattice['width']}x{lattice['height']} px over the ROI) and "
                "cached; window field = day-count-weighted mean of its blocks, bilinear to the "
                f"{GRID.res} m cell centres")
    sources = {
        "cmip6": (f"{_S05_GDDP} (Earth Engine; historical <= 2014 + ssp245/ssp585), {cmip6['model'].nunique()} of "
                  f"{len(models)} models complete with tasmax/tasmin (GFDL-CM4 grid gr1 only), Apr-Jun mean of daily "
                  f"values over the 20-year windows {w}, {grid_txt}; value = ROI mean of the window field"),
        "cmip6_pattern": (f"{_S05_GDDP} ssp245 ensemble-median delta field of the 2050 window minus the {CFG.NOW} "
                          f"window from the same cached blocks ({grid_txt}), divided by its ROI mean"
                          if CFG.FRAMES_PROJ else "uniform 1 (no projection frames in this profile)"),
        "urban_growth": (f"{_S05_CHEN} (Chen et al. 2020, value {_S05_CHEN_URBAN} = urban; bands "
                         f"{dict(chen[0])}, decadal tiles mosaicked over the ROI) urban area per district / 2020, "
                         "decades interpolated geometrically"),
        "ghsl_2030": f"{_S05_GHSL}/GHS_BUILT_S/2030 built_surface/1e4 and GHS_POP/2030 x100, mean to {GRID.res} m",
        "pop_growth": _S05_SSP_CITATION + "; factor = urban population(frame) / urban population(2025)",
        "gsat_increment": _S05_AR6_CITATION,
    }
    return {"future": future, "sources": sources, "caveats": caveats, "diag": diag}

# %% [markdown]
# ## 5.4 Run (gee mode), publish and check the acquisition contract (SPEC §3.2)
# Two stage-cache units (drivers; future inputs) so a failure in one does not recompute the other. The contract
# check is the gee-mode twin of section 02's: every `RAW_OBS` key of every frame (including the Landsat products of
# section 03 and the thermal products of section 04), shapes, dtypes, NaN outside the ROI, glc fractions summing to
# 1, `LC_FINE` shapes, `FRAME_META` structure, `NIGHT_CALIBRATION`, `ANNUAL_SERIES` and `FUTURE_INPUTS` columns.

# %%
def _s05_publish(drivers: dict, future: dict) -> None:
    global RAW_STATIC, RAW_OBS, LC_FINE, FUTURE_INPUTS, FUTURE_INPUTS_DIAG, DATA_SOURCES, DATA_CAVEATS
    if not isinstance(globals().get("RAW_OBS"), dict):
        RAW_OBS = {}
    if not isinstance(globals().get("RAW_STATIC"), dict):
        RAW_STATIC = {}
    RAW_STATIC.update(drivers["static"])     # section 03 created the (empty) dict; 05 owns its keys
    for year, fields in drivers["obs"].items():
        RAW_OBS.setdefault(int(year), {}).update(fields)
    LC_FINE = {int(y): v for y, v in drivers["lc_fine"].items()}
    FUTURE_INPUTS = future["future"]
    FUTURE_INPUTS_DIAG = future["diag"]
    if not isinstance(globals().get("DATA_SOURCES"), dict):
        DATA_SOURCES = {}
    for var, by_year in drivers["sources"].items():
        DATA_SOURCES.setdefault(var, {}).update({int(y): t for y, t in by_year.items()})
    span = f"{CFG.NOW}-{max([CFG.NOW] + list(CFG.FRAMES_PROJ))}"
    DATA_SOURCES.setdefault("future_inputs", {})[span] = "; ".join(f"{k}: {v}" for k, v in future["sources"].items())
    for key, text in future["sources"].items():
        DATA_SOURCES.setdefault(f"future_{key}", {})[span] = text
    if not isinstance(globals().get("DATA_CAVEATS"), list):
        DATA_CAVEATS = []
    for text in drivers["caveats"] + future["caveats"]:
        if text not in DATA_CAVEATS:
            DATA_CAVEATS.append(text)


def _s05_validate() -> None:
    """Raise AssertionError with a precise message if a §3.2 global violates the contract (gee mode)."""
    h, w = GRID.shape
    hf, wf = GRID_FINE.shape
    roi, roi_f = np.asarray(ROI_MASK, bool), np.asarray(ROI_MASK_FINE, bool)
    assert set(RAW_STATIC) == set(_S05_STATIC_KEYS) | set(_S05_STATIC_FINE_KEYS), sorted(RAW_STATIC)
    for key, arr in RAW_STATIC.items():
        fine = key.endswith("_f")
        mask = roi_f if fine else roi
        assert arr.shape == ((hf, wf) if fine else (h, w)) and arr.dtype == np.float32, (key, arr.shape, arr.dtype)
        assert np.isnan(arr[~mask]).all() and np.isfinite(arr[mask]).all(), f"RAW_STATIC[{key}] NaN pattern"
    frames = [int(y) for y in CFG.FRAMES_OBS]
    assert sorted(RAW_OBS) == sorted(frames), f"RAW_OBS frames {sorted(RAW_OBS)} != {sorted(frames)}"
    lc_res = int(CFG.fine_res())
    lc_shape = (h * GRID.res // lc_res, w * GRID.res // lc_res)
    expected = set(_S05_RAW_FINE_KEYS) | set(_S05_RAW_COARSE_KEYS)
    for year in frames:
        obs = RAW_OBS[year]
        missing, extra = sorted(expected - set(obs)), sorted(set(obs) - expected)
        assert not missing, f"RAW_OBS[{year}] lacks {missing} (section 03 day/spectral keys or section 04/05 keys)"
        assert not extra, f"RAW_OBS[{year}] has unexpected keys {extra}"
        for key, arr in obs.items():
            fine = key in _S05_RAW_FINE_KEYS
            assert arr.shape == ((hf, wf) if fine else (h, w)) and arr.dtype == np.float32, (
                year, key, arr.shape, arr.dtype)
            assert np.isnan(arr[~(roi_f if fine else roi)]).all(), f"RAW_OBS[{year}][{key}] must be NaN outside ROI"
        glc = np.stack([obs[k][roi] for k in _S05_GLC_KEYS])
        assert np.allclose(glc.sum(0), 1.0, atol=1e-4), f"glc fractions of {year} do not sum to 1"
        assert np.nanmin(obs["built_f"]) >= 0 and np.nanmax(obs["built_f"]) <= 1, f"built_f range {year}"
        for key in _S05_COARSE_KEYS:
            assert np.isfinite(obs[key][roi]).all(), f"RAW_OBS[{year}][{key}] has gaps inside the ROI"
        assert LC_FINE[year].shape == lc_shape and LC_FINE[year].dtype == np.uint8, (year, LC_FINE[year].shape)
        assert int(LC_FINE[year].max()) <= 6
        meta = FRAME_META[year]
        assert {"window", "day", "night"} <= set(meta), f"FRAME_META[{year}] keys {sorted(meta)}"
        assert set(meta["night"]) == {"source", "sensor", "overpass_ist_h", "composites", "coverage"}
        assert meta["night"]["source"] in ("aqua", "terra_cal", "viirs_cal", None)
        has_night = bool(np.isfinite(obs["lst_night"][roi]).any())
        assert has_night == (meta["night"]["source"] is not None), f"night availability of {year}"
    for kind in ("terra_to_aqua", "viirs_to_aqua"):
        cal = NIGHT_CALIBRATION[kind]
        assert set(cal) == {"r2", "rmse", "n", "by_class"} and all(set(c) == {"class", "a", "b", "n"}
                                                                   for c in cal["by_class"]), cal
    assert list(ANNUAL_SERIES.columns) == ["year", "scope", "variable", "value", "flag"], list(ANNUAL_SERIES.columns)
    assert set(ANNUAL_SERIES["variable"]) == set(_S04_ERA5_SERIES + _S04_SAT_SERIES), sorted(
        set(ANNUAL_SERIES["variable"]))
    assert ANNUAL_SERIES["year"].between(1990, 2025).all() and "ncr" in set(ANNUAL_SERIES["scope"])
    assert set(FUTURE_INPUTS) == {"cmip6", "cmip6_pattern", "urban_growth", "ghsl_2030", "pop_growth",
                                  "gsat_increment"}, sorted(FUTURE_INPUTS)
    cm = FUTURE_INPUTS["cmip6"]
    assert list(cm.columns) == ["scenario", "model", "frame", "var", "value_k"], list(cm.columns)
    assert set(cm["scenario"]) <= {"ssp245", "ssp585"} and set(cm["var"]) == {"tasmax", "tasmin"}
    assert set(cm["frame"]) == {int(CFG.NOW)} | {int(y) for y in CFG.FRAMES_PROJ}, sorted(set(cm["frame"]))
    for var in ("tasmax", "tasmin"):
        pat = FUTURE_INPUTS["cmip6_pattern"][var]
        assert pat.shape == (h, w) and pat.dtype == np.float32 and np.isfinite(pat[roi]).all()
        assert abs(float(np.mean(pat[roi])) - 1.0) < 1e-3, f"cmip6_pattern {var} ROI mean != 1"
    ug = FUTURE_INPUTS["urban_growth"]
    assert list(ug.columns) == ["scenario", "district", "frame", "ratio"]
    assert set(ug["scenario"]) == {"ssp126", "ssp245", "ssp585"} and (ug["ratio"] > 0).all()
    assert list(FUTURE_INPUTS["pop_growth"].columns) == ["scenario", "frame", "factor"]
    for var in ("built", "pop"):
        g = FUTURE_INPUTS["ghsl_2030"][var]
        assert g.shape == (h, w) and g.dtype == np.float32 and np.isfinite(g[roi]).all()
    assert set(FUTURE_INPUTS["gsat_increment"]) == {"ssp126", "ssp245", "ssp585"}
    assert all(abs(v[int(CFG.NOW)]) < 1e-9 for v in FUTURE_INPUTS["gsat_increment"].values())


if _S05_ACTIVE:
    if ee is None or EE_DISTRICTS is None:
        raise RuntimeError("section 05 needs an initialised Earth Engine session and EE_DISTRICTS (section 01)")
    # code04: section 05 computes with section-04 helpers (GLC fractions, ROI fill, regridding, fetch); code03: and
    # fetches through section-03 helpers (gee_fetch_grid, gee_fetch_asset, asset exports), D4
    _s05_base_key = dict(version=_S05_VERSION, grid=GRID.to_dict(), roi=_s04_roi_digest(),
                         code03=section_code_hash("03"), code04=section_code_hash("04"))
    _S04_EXPORT_DIAG.clear()
    _s05_sc_drv = stage_cache("s05_drivers", CFG.key("WINDOWS", "SEASON", **_s05_base_key,
                                                     lc_fine_res=int(CFG.fine_res())))
    with gee_workload_tag("lst-v2-s05"), timer("05 drivers"):
        _S05_DRIVERS = _s05_sc_drv.get_or_compute(_s05_build_drivers)
    _s05_sc_fut = stage_cache("s05_future", CFG.key("SEASON", "NOW", "FRAMES_PROJ", **_s05_base_key,
                                                    proj_windows={str(k): list(v) for k, v in
                                                                  CFG.PROJ_WINDOWS.items()},
                                                    probes=bool(_S05_PILOT_PROBES and not CFG.FRAMES_PROJ)))
    with gee_workload_tag("lst-v2-s05"), timer("05 future inputs"):
        _S05_FUTURE = _s05_sc_fut.get_or_compute(_s05_build_future)
    _s05_publish(_S05_DRIVERS, _S05_FUTURE)
    del _S05_DRIVERS, _S05_FUTURE, _s05_sc_drv, _s05_sc_fut, _s05_base_key
    globals().pop("_S04_GLC_MEMO", None)     # GLC fraction cache shared by 04/05 is no longer needed
    free_memory()
    _s05_validate()
    log("section-05 contract check passed (SPEC §3.2: RAW_STATIC, RAW_OBS, LC_FINE, FRAME_META, NIGHT_CALIBRATION, "
        "ANNUAL_SERIES, FUTURE_INPUTS)")
    if _S04_EXPORT_DIAG:
        FUTURE_INPUTS_DIAG["exports"] = list(_S04_EXPORT_DIAG)
    _s05_g = FUTURE_INPUTS_DIAG.get("gddp") or {}
    log(f"GDDP-CMIP6 blocks: {_s05_g.get('requests', 0)} requests, {_s05_g.get('cache_hits', 0)} from cache, "
        f"{len(_s05_g.get('failed_items') or [])} failed, {_s05_g.get('seconds', 0)}s")
    del _s05_g

# %% [markdown]
# ## 5.5 Quality-assurance figure
# Built-up fraction (latest frame, fine grid), dominant GLC class, ERA5-Land Tmax climatology, and the CMIP6 ROI-mean
# tasmax change per model (frame vs 2025) for both scenarios.

# %%
def _s05_qa_figure() -> None:
    last = int(max(CFG.FRAMES_OBS))
    obs = RAW_OBS[last]
    fig, axes = plt.subplots(1, 4, figsize=(17, 4.2))
    im = axes[0].imshow(obs["built_f"], cmap="inferno", vmin=0, vmax=1)
    axes[0].set_title(f"built_f {last} ({GRID_FINE.res} m)", fontsize=9)
    fig.colorbar(im, ax=axes[0], shrink=0.7)
    stack = np.stack([np.nan_to_num(obs[k], nan=-1) for k in _S05_GLC_KEYS])
    dom = np.where(ROI_MASK, np.argmax(stack, 0) + 1, 0)
    from matplotlib.colors import ListedColormap
    cmap = ListedColormap([LC_CLASS_COLORS[c] for c in range(7)])
    axes[1].imshow(dom, cmap=cmap, vmin=0, vmax=6, interpolation="nearest")
    axes[1].set_title(f"dominant GLC class {last}", fontsize=9)
    im = axes[2].imshow(obs["era5_tmax"], cmap="coolwarm")
    axes[2].set_title(f"ERA5-Land Apr-Jun Tmax {last} (°C)", fontsize=9)
    fig.colorbar(im, ax=axes[2], shrink=0.7)
    for ax in axes[:3]:
        ax.set_axis_off()
    cm = FUTURE_INPUTS["cmip6"]
    frames = sorted(cm["frame"].unique())
    if len(frames) > 1:
        tx = cm[cm["var"] == "tasmax"].pivot_table(index=["scenario", "model"], columns="frame", values="value_k")
        for s, color in (("ssp245", "tab:blue"), ("ssp585", "tab:red")):
            if s not in tx.index.get_level_values(0):
                continue
            d = tx.loc[s].sub(tx.loc[s][frames[0]], axis=0)
            axes[3].plot(frames, d.T.values, color=color, alpha=0.15, lw=0.8)
            axes[3].plot(frames, d.median().values, color=color, lw=2.2, label=f"{s} median")
        axes[3].set_xlabel("frame (20-year window centre)")
        axes[3].set_ylabel(f"Apr-Jun tasmax change vs {frames[0]} (K)")
        axes[3].legend(fontsize=8)
    axes[3].set_title("GDDP-CMIP6 ROI-mean (one line per model)", fontsize=9)
    fig.tight_layout()
    path = CFG.FIG_DIR / "05_drivers_future_qa.png"
    try:
        fig.savefig(path, dpi=110, bbox_inches="tight")
        log(f"figure -> {path}")
    except OSError as exc:
        log(f"could not save {path}: {exc}", "WARNING")
    plt.show()
    plt.close(fig)


if _S05_ACTIVE:
    try:
        _s05_qa_figure()
    except Exception as exc:  # noqa: BLE001 - a QA figure must never abort the pipeline
        log(f"section-05 QA figure failed: {type(exc).__name__}: {exc}", "WARNING")

# %% [markdown]
# ## 5.6 Pilot probes
# With `LST_PILOT_PROBES` (default on for a gee pilot) the CMIP6 2050 warming pattern was computed through the block
# cache although the pilot has no projection frames; the full run reuses the fetched blocks.

# %%
if _S05_ACTIVE and isinstance(globals().get("FUTURE_INPUTS_DIAG"), dict) and FUTURE_INPUTS_DIAG.get("probes"):
    _s05_rows = []
    for _s05_name, _s05_p in FUTURE_INPUTS_DIAG["probes"].items():
        _s05_d = _s05_p.get("roi_mean_delta_k") or {}
        _s05_rows.append({"probe": _s05_name, "ok": _s05_p.get("error") is None, "seconds": _s05_p.get("seconds"),
                          "requests": _s05_p.get("requests"), "cache_hits": _s05_p.get("cache_hits"),
                          "models": _s05_p.get("n_models"), "tasmax_delta_k": _s05_d.get("tasmax"),
                          "tasmin_delta_k": _s05_d.get("tasmin"), "error": (_s05_p.get("error") or "")[:80]})
    print("PILOT PROBES (ssp245 ensemble-median ROI warming of the 2050 window vs the 2025 window)")
    _show(pd.DataFrame(_s05_rows).set_index("probe"))
    del _s05_rows, _s05_name, _s05_p, _s05_d
