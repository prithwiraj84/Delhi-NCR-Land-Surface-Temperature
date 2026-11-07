# Delhi NCR LST × Explainable AI — v2 Architecture & Data Contract (1990–2050, Day + Night)

**This file is the single source of truth for v2.** It overrides every older text (v1 contract: `docs/SPEC_v1.md`;
UI design: `docs/UI_SPEC_v2.md`; evidence: `docs/research/*.md`). Where this file and the UI spec disagree on data,
**this file wins**; the UI spec governs look, motion and interaction. Names, shapes, dtypes, file names and JSON keys
below are binding. If you believe something here is wrong, implement it as written and report the concern.

Why v2 looks the way it does (evidence, all in `docs/research/`):
* Real-data experiments on the user's v1 Kaggle bundle (`real_data_accuracy_experiments.md`): v1's weak spatial-CV
  (XGB R² 0.62 ± 0.31) came from **missing neighbourhood context** (one cool north-east fold) — 3 + 15 km focal means
  together with distance and relative-elevation features lifted 5×5 block CV R² from 0.63 to 0.83 (focal means alone
  about 0.79; pooled 0.90); in v2 the distance/TPI features are base features, so the 07 base-only ablation isolates
  the 14 focal means only; recentring predicted anomaly maps lifts temporal transfer 0.80 → 0.89;
  hyper-parameters/stacking change < 0.01; mixing land-cover products causes ~1 °C offsets.
* Dataset research (`gee_datasets_v2.md`): Landsat C2 L2 is the only consistent day-LST record from 1990 (3-year
  windows needed in the 1990s); Terra/Aqua drifted ~1 h by 2025; VIIRS VNP21 is the stable night successor; GHSL
  P2023A gives consistent built-up/population 1975–2030; GEE's GDDP-CMIP6 has ssp245/ssp585 only.
* Methods research (`methods_v2.md`): pooled OOF metrics, ~20 km blocks, leave-one-epoch-out (LOEO) as the timeline
  headline, AOA, DMS downscaling with block-conserving residual correction, CA land projections with figure-of-merit
  validation, CMIP6 deltas × empirical dLST/dTair, Monte-Carlo uncertainty.

---

## 0. Repository layout (v2)

```
LST replication study/
├── delhi_ncr_lst_pipeline.ipynb      # BUILT from notebook/sections (python notebook/build_notebook.py --check)
├── notebook/
│   ├── sections/                     # jupytext percent format, executed IN ORDER in ONE shared namespace
│   │   ├── 00_setup.py               # CFG v2, ENV, utilities, stage cache, LSTB writer/reader
│   │   ├── 01_study_area.py          # ROI, districts, 1 km + fine grids, GEE init, data-mode decision
│   │   ├── 02_synthetic_world.py     # synthetic world 1990–2025 + future inputs (synthetic mode only)
│   │   ├── 03_gee_landsat.py         # Landsat C2 L2 day LST + spectral composites (gee mode only)
│   │   ├── 04_gee_thermal.py         # MODIS/VIIRS night (+ MODIS day validation), calibrations, annual series
│   │   ├── 05_gee_drivers.py         # GHSL, GLC_FCS30D, terrain, water, ERA5-Land, future inputs (CMIP6, SSP urban)
│   │   ├── 06_features.py            # feature grids, focal/distance features, landscape metrics, DF, folds, masks
│   │   ├── 07_models.py              # validation suite, benchmarks, final models, persistent residual, AOA, conformal
│   │   ├── 08_explain.py             # SHAP (grouped), interactions, bootstrap, dependence/thresholds, zones, recs, web models
│   │   ├── 09_timeline.py            # absolute levels, night hindcast, tiers, frame fields, β (dLST/dTair), trends, series
│   │   ├── 10_downscaling.py         # 250 m day (Landsat) + night (DMS downscaling), validation, EPSG:4326 rasters
│   │   ├── 11_projections.py         # land-change CA, derived predictors, CMIP6 deltas, Monte-Carlo projections
│   │   └── 12_export.py              # web bundle v2 + parquet/geo/models + validation + zip
│   ├── build_notebook.py, run_local.py   # unchanged tooling (run_local exposes LST_* env, see §1.6)
│   ├── kaggle_runner.py              # runs the sections inside kaggle_launcher.ipynb (Jupyter cell semantics;
│   │                                 #   per-file sha1 check against BUNDLE_INFO.json, EXPECTED_BUNDLE, fail-soft)
│   ├── kaggle_launcher_src.py, build_launcher.py   # source + builder of kaggle_launcher.ipynb (~12 KB)
│   ├── make_kaggle_code_bundle.py    # -> outputs/kaggle/ncr-lst-v2-code.zip (the Kaggle code dataset, bundle id)
│   │                                 #   + the launcher stamped with EXPECTED_BUNDLE; --verify checks the zip
│   └── validate_bundle.py            # v2 + v1 bundle validator (CLI)
├── dashboard/                        # React 18 + Vite 5 + deck.gl ~9.4 + maplibre + zustand (UI_SPEC_v2)
│   ├── public/data/                  # the USER's bundle (today: real v1 GEE bundle; later: real v2 bundle)
│   └── public/demo/                  # SYNTHETIC v2 demo bundle produced by the notebook in synthetic mode
└── docs/  SPEC.md (this) · SPEC_v1.md · UI_SPEC_v2.md · research/{gee_datasets_v2,methods_v2,real_data_accuracy_experiments}.md
```

Section-file rules (unchanged from v1): no IPython magics; one shared namespace; only the globals listed in §3 are the
inter-section interface (prefix private helpers `_<section>_...` to avoid collisions — e.g. `_s06_focal`); every heavy
stage ends with `free_memory()`; figures via matplotlib → `CFG.FIG_DIR`, `plt.show()`, `plt.close()`.
**Mode gating:** sections 03–05 do nothing in synthetic mode; section 02 does nothing in gee mode. Both paths must
produce **identical globals, keys, shapes and dtypes** (§3.2).

---

## 1. Study design (decisions)

### 1.1 Space
| Item | Decision |
|---|---|
| Study area | Delhi NCR, 25 canonical districts — table, aliases and synthetic outline unchanged: **`SPEC_v1.md` §1.1–§1.2** (incl. `samli`) |
| CRS | `EPSG:32643` (UTM 43N) for all analysis grids |
| Analysis grid | `GRID`: square cells of `CFG.GRID_RES_M` (1000 m; the same snapped grid as v1 — real data: W 297, H 366, x0 545000, y_top 3321000) |
| Fine grid | `GRID_FINE = GRID.fine(CFG.GRID_RES_M // CFG.FINE_FACTOR)`; `FINE_FACTOR = 4` → 250 m at 1 km (500 m at the 2 km smoke grid). Fine pixel (r, c) belongs to coarse cell (r // 4, c // 4). |
| Land-cover fine grid | `LC_FINE` at `CFG.LC_FINE_RES_M` (gee 50 m, synthetic 100 m; must divide GRID_RES_M) — only for landscape metrics |
| Canonical cell order | all ROI cells (`ROI_MASK`) sorted by `cell_id = row * W + col`; `N_CELLS` = their count. Every exported per-cell array uses this order and length (missing values = nodata), **including frames with partial coverage** |
| Fixed masks | **Mask frames** = training frames of the mode whose valid-target share of ROI cells ≥ `LST_FRAME_MIN_COVERAGE` (0.5). `FIXED_MASK[mode]` (H,W) bool = ROI cells with a valid target in **every** mask frame (strict intersection); if it keeps < 80 % of ROI cells → warning + `DATA_CAVEATS` entry (each frame's missing share); fewer than 2 mask frames, or a mask keeping < 1 % of the ROI cells (valid sets that barely overlap), → error listing each frame's coverage. Training frames below the threshold get weight 0. Frame levels and anomalies use this mask; frames that do not fully cover it get a model-based composition correction of their level in section 09 (§4.7). |

### 1.2 Time: frames, windows, tiers
* `CFG.FRAMES_OBS = [1990, 1995, 2000, 2005, 2010, 2015, 2020, 2025]` (observation frames, each an Apr–Jun
  multi-year window): `CFG.WINDOWS = {1990:(1989,1992), 1995:(1994,1996), 2000:(1999,2001), 2005:(2004,2006),
  2010:(2009,2011), 2015:(2014,2016), 2020:(2019,2021), 2025:(2024,2026)}`. Season `CFG.SEASON = ("04-01","06-30")`.
* `CFG.FRAMES_PROJ = [2030, 2035, 2040, 2045, 2050]`; `CFG.SCENARIOS = ["ssp126","ssp245","ssp585"]`
  (ssp126 climate is pattern-scaled from ssp245, §4.10). `CFG.NOW = 2025`. `CFG.REFERENCE_PERIOD = (2000, 2020)`.
* `CFG.MODES = ["day","night"]`.
* **Evidence tiers** (vocabulary, exact strings): `observed`, `observed-sparse`, `reconstructed`, `modelled`,
  `projected`. They are computed by section 09 from `FRAME_META` (never hard-coded in the UI):

| mode | 1990 | 1995 | 2000 | 2005 | 2010–2025 | 2030–2050 |
|---|---|---|---|---|---|---|
| day | observed-sparse (Landsat 5, < 6 scenes on some path/row) | observed-sparse | observed | observed (L7 SLC-off) | observed | projected |
| night | modelled (hindcast) | modelled | reconstructed (Terra 22:30 → Aqua-equivalent) | observed (Aqua) | observed (Aqua; 2025 VIIRS calibrated) | projected |

  Rule: day = `observed-sparse` if any of the 5 WRS-2 path/rows has < 6 clear scenes in the window, else `observed`.
  Night = `observed` for Aqua/VIIRS sources, `reconstructed` for calibrated Terra, `modelled` when no night product
  exists. In synthetic mode the same rules run on synthetic `FRAME_META` (the dashboard adds the SIMULATED overlay
  from `manifest.data_mode`).
  Day frames are always observed or observed-sparse: section 03 stops when a frame's ROI fine-pixel Landsat coverage
  is below `LST_DAY_MIN_FRAME_COVERAGE` (0.2) and section 06 refuses a day frame without any valid target
  (acquisition fault).

### 1.3 Modes (what "day" and "night" mean)
* **day** = pre-monsoon **mid-morning (~10:30 IST)** land surface temperature: harmonised **Landsat C2 L2 ST**
  composites (30 m → fine grid → 1 km), path-offset harmonised and corrected to a 10:45 IST reference overpass
  (§2.1). Consistent 1990–2025 and natively fine, so the day 250 m layer is observed (not downscaled).
  MODIS Terra day (QC, view-time filtered) is kept as an **independent validation** product (2000–2025) and for the
  downscaling demonstration.
* **night** = pre-monsoon **~01:30–02:00 IST** LST on the 1 km grid in **Aqua-equivalent** units: Aqua MYD11A2
  (2003–2021), VIIRS VNP21A1N calibrated to Aqua (2025 frame), Terra MOD11A2 22:30 calibrated to Aqua (2000 frame);
  1990/1995 hindcast by the night model. The night 250 m layer is **downscaled** (§4.8).
* Targets are **anomalies** per frame: `anom(i,t) = LST(i,t) − mean_{FIXED_MASK}(LST(·,t))` (mean over the fixed mask
  is exactly 0). Absolute °C = anomaly + frame level `L(t)` (§4.7). One **pooled** model per mode (no year feature).

### 1.4 Modelling decisions (from the real-data experiments)
* Feature set = 33 base + 14 focal features (§4.1). **No raw coordinates / eigenvectors** in any model (they help
  unseen-place CV by +0.05 but contaminate SHAP and future extrapolation; ERA5-Land climate covariates carry the
  regional gradient instead).
* Final model per mode: XGBoost (depth 6, min_child_weight 20, eta 0.03, subsample 0.8, colsample 0.8, lambda 1,
  early stopping on inner 10 km blocks), with **monotone constraints** (§4.3).
* **Recentring:** every predicted anomaly map is recentred to zero mean over the fixed mask before use (LOEO metrics,
  hindcast); projections recentre relative to the 2025 prediction mean so the land-driven mean shift is kept (§4.10).
* Headline accuracy = **pooled** out-of-fold R²/RMSE under 20 km-block spatial CV (10 folds) and LOEO (recentred);
  v1-comparable 5×5 blocks, leave-one-district-out, unseen place+time and random CV are also reported (§4.2).
* One land-cover product for all frames (GLC_FCS30D; 2025 uses its 2022 map), built-up from GHSL (§2.3).

### 1.5 Zones & governance (per mode)
K = 4 K-means on grouped-SHAP vectors (18 groups, §4.4) pooled over the observed frames. Labelling (both modes):
(1) **3 Heat Extreme Core** = highest mean total SHAP. (2) Among the other three a cluster is **riparian-eligible** if
its mean `frac_water` ≥ 0.05, **or** ≥ 25 % of its rows have `frac_water` ≥ 0.2, **or** the `water` group has the
largest mean |SHAP| of its 18 groups and that value is ≥ 0.25 °C. If any cluster is eligible: **1 Riparian Buffer** =
the eligible cluster with the highest mean `frac_water`, **0 Ecological Cool Base** = lower mean total SHAP of the
remaining two, **2 Transition** = last. If none is eligible, the three are ordered by mean total SHAP: lowest → 0,
middle → 1, highest → 2. Canonical ids, names and colours are unchanged (v1: `#34d399 #22d3ee #a78bfa #fb7185`).
`ZONE_PROFILES[m][k]` adds `display_name` (equal to the name, except zone 1 when no cluster meets the criterion:
`"Moderate mosaic (no riparian signal)"`) and `label_caveat` (null, or when the criterion is not met: *"Named Riparian
Buffer by the SPEC zone rule, but no cluster shows a riparian signature (mean water x.x %); this is the middle-heat
cluster of the three non-core zones."*); the zone-1 description starts with the display name and the caveat. Every
place that shows a zone name (09 scope labels, the dashboard) uses `display_name` (falling back to `name`) and shows
`label_caveat` when present. Every frame (observed and projected) gets zone ids by nearest centroid in the same SHAP
space.

### 1.6 Configuration (`CFG`, env overrides)
| Field | Env | full (Kaggle default) | fast (`LST_FAST_DEV=1`) | pilot |
|---|---|---|---|---|
| `PROFILE` | `LST_PROFILE` | `full` | `fast` | `pilot` (frames `[1990, 2000, 2020, 2025]`, no projections, ridge + XGBoost, CMIP6 pattern probe — GEE cost/runtime probe) |
| `FRAMES_OBS` | `LST_FRAMES_OBS` (comma list, any profile) | the 8 frames | the 8 frames | `[1990, 2000, 2020, 2025]` (subset of the 8 SPEC frames, ≥ 2 frames, ≥ 2 night training frames, always 2025 (`NOW`), and also 2005 and 2015 when projections are on; else error) |
| `RUN_MODE` | `LST_RUN_MODE` | `auto` | | |
| `GRID_RES_M` | `LST_GRID_RES_M` | 1000 | (run_local passes 2000) | 1000 |
| `FINE_FACTOR` | `LST_FINE_FACTOR` | 4 | 4 | 4 |
| `LC_FINE_RES_M` | `LST_LC_FINE_RES_M` | 50 (gee) / 100 (synthetic) | 200 | 50 |
| `N_BOOTSTRAP` | `LST_N_BOOTSTRAP` | 50 | 6 | 10 |
| `N_MC` | `LST_N_MC` | 500 | 120 | — |
| `N_LAND_REAL` | `LST_N_LAND_REAL` | 20 | 4 | — |
| `BLOCK_KM` / `N_FOLDS_BLOCK` | | 20 / 10 | 20 / 5 | 20 / 5 |
| `XGB_MAX_ROUNDS` / `XGB_EARLY_STOP` | | 4000 / 100 | 400 / 30 | 1500 / 60 |
| `GNN_EPOCHS` | | 300 | 30 | 60 |
| `MORAN_PERMS` | | 999 | 99 | 199 |
| `BENCHMARKS` | `LST_BENCHMARKS` | `ridge,random_forest,lightgbm,xgboost,gnn` | same | `ridge,xgboost` |
| `GEE_EXPORT` | `LST_GEE_EXPORT` | `interactive` (tiled computePixels) or `asset` (batch `Export.image.toAsset`, needs *Earth Engine Resource Writer*) | | |
| `GEE_ASSET_ROOT` | `LST_GEE_ASSET_ROOT` | `projects/<GEE_PROJECT>/assets/ncr_lst_v2` | | |
| `GEE_ENDPOINT` | `LST_GEE_ENDPOINT` | `standard` (`highvolume` is opt-in; both have the same 40-concurrent-request quota; any other value is an error) | | |
| `GEE_DEADLINE_S` | `LST_GEE_DEADLINE_S` | 420 (Earth Engine request deadline; minimum 330) | | |
| — | `LST_GEE_EXPORT_TIMEOUT_S` | 10800 (asset mode, section 03: per **running** batch task) | | |
| — | `LST_GEE_EXPORT_QUEUE_S` | 14400 (asset mode, section 03: per task not yet running) | | |
| — | `LST_GEE_EXPORT_TIMEOUT_0405_S` | 3600 (asset mode, sections 04/05 running tasks; 7200 s queued) | | |
| — | `LST_PILOT_PROBES` | `1` when profile pilot and gee mode, else `0` (section 05 CMIP6 pattern probe → `FUTURE_INPUTS_DIAG["probes"]`) | | `1` |
| `TIME_BUDGET_H` | `LST_TIME_BUDGET_H` | 11 on Kaggle, unlimited elsewhere (`0`/`none`/`off` = unlimited): no new work starts after it; the run stops cleanly, packs the cache and writes `RUN_STOPPED.json` | | |
| `TIME_RESERVE_S` | `LST_TIME_RESERVE_S` | 1800 (time kept free before the budget for the clean stop) | | |
| `STOP_AFTER` | `LST_STOP_AFTER` | none (`01`…`11`: stop cleanly after that section) | | |
| — | `LST_INVALIDATE` | none (comma tokens; stages whose name starts with a token or with `s` + token are recomputed; Earth Engine tiles and GDDP blocks never) | | |
| — | `LST_PACK_CACHE` | `1` on Kaggle, `0` elsewhere (pack the cache into `CACHE_DIR/packed/*.tar` at the end and on a clean stop) | | |
| — | `LST_FRAME_MIN_COVERAGE` | 0.5 (valid-target share a training frame needs to define the fixed mask; below → weight 0) | | |
| — | `LST_DAY_MIN_FRAME_COVERAGE` | 0.2 (minimum ROI fine-pixel Landsat coverage of a day frame; below → section 03 stops) | | |
| `RESUME` | `LST_RESUME` | 1 (reuse a stage-cache entry whose key matches; key = configuration + data fingerprints + per-section code hash; `0` recomputes every stage, Earth Engine tiles and GDDP blocks stay cached) | | |
| `CACHE_IMPORT` | `LST_CACHE_IMPORT` | `auto` (the shallowest `/kaggle/input/*/**/cache` with content; only one folder is imported), or any folder containing a previous cache (e.g. a path copied from Kaggle's Input panel; an explicit path that is not a folder or holds no cache raises at once); packed tars are unpacked; `0` disables | | |
| — | `LST_VALIDATOR` | none (path of `validate_bundle.py` for the standalone check of section 12; otherwise `./notebook/`, `./`, `../notebook/` and `/kaggle/input/*/` are searched) | | |

v1 fields that remain (SEED, GEE_*, OUTPUT_DIR/derived dirs, USE_RAPIDS, MORAN_K, DEP_BINS, K_ZONES=4, SHAP_BATCH, …)
keep their v1 meaning. `LST_FAST_DEV=1` ⇒ profile `fast`. `run_local.py` keeps working unchanged.

---

## 2. Data sources and processing (gee mode)

All recipes below were verified against the Earth Engine catalog (see `docs/research/gee_datasets_v2.md`, which has
the exact band lists, scale factors, QA bits and code snippets — **read it before implementing 03–05**). Extraction
uses v1's `fetch_grid` (tiled `ee.data.computePixels`, retry/backoff, quartering, on-disk tile cache keyed by a hash
of the serialized expression) or, with `GEE_EXPORT=asset`, `Export.image.toAsset` per frame (poll tasks; then
computePixels from the asset — saves EECU and avoids interactive timeouts). Every variable/frame writes a provenance
string into `DATA_SOURCES[var][year]`, and caveats go to `DATA_CAVEATS`.

**Earth Engine session.** Interactive extraction runs on the **standard** Earth Engine endpoint (the
high-volume endpoint is opt-in via `LST_GEE_ENDPOINT=highvolume`; both share the 40-concurrent-request quota) with a
420 s request deadline (`LST_GEE_DEADLINE_S`, `ee.data.setDeadline`) and 3 client retries. The Earth Engine work of
sections 03, 04 and 05 runs under the workload tags `lst-v2-s03`, `lst-v2-s04`, `lst-v2-s05`, so Google Cloud
Monitoring (Earth Engine → *Completed EECU-seconds*, grouped by `workload_tag` and `compute_type`) splits the EECU per
section; the Earth Engine task list only shows batch exports. **Asset mode:** noncommercial projects run about 2 batch
tasks at a time. Each task has a running timeout (`LST_GEE_EXPORT_TIMEOUT_S`, 3 h, section 03; 1 h for 04/05 via
`LST_GEE_EXPORT_TIMEOUT_0405_S`) counted from the first poll that sees it RUNNING, and a queued timeout
(`LST_GEE_EXPORT_QUEUE_S`, 4 h; 2 h for 04/05) counted from the start of the wait; a failed, cancelled or timed-out
job is cancelled (when still READY/RUNNING) and extracted interactively instead, while the other tasks keep being
polled. Assets persist across sessions, and a later session attaches to still-running tasks by description. The
maximum observed export concurrency is logged and stored (`_S03_QA["export_concurrency"]`, the 04/05 diagnostics).

### 2.1 Day LST + spectral (Landsat C2 L2), section 03
* Collections `LANDSAT/LT05|LE07|LC08|LC09/C02/T1_L2`; Landsat 7 only `< 2021-01-01`; Apr–Jun of the frame window.
  Mask: QA_PIXEL bits 0–4 clear, QA_RADSAT == 0, ST_QA×0.01 ≤ 3 K, ST_CDIST×0.01 ≥ 1 km, SR in [0,1].
  Scale: SR ×2.75e-05 − 0.2; ST ×0.00341802 + 149 K → °C. TM/ETM+ SR → OLI with Roy et al. 2016 OLS coefficients.
* **Per-path composites + offset harmonisation:** median composite per WRS-2 path (146, 147; rows within a path share
  dates). Estimate the path offset from the overlap zone (median of the 146 − 147 difference over the overlap at
  ≥ 250 m), split it symmetrically (+δ/2, −δ/2), apply, and mosaic (mean where both exist). Record `path_offsets`.
* Bands at the fine grid (mean-aggregated from 30 m with `reduceResolution`): `lst_day_f` (°C, harmonised, not yet
  overpass-corrected), `lst_day_nobs_f` (clear-scene count), `ndvi_f`, `ndbi_f`, `mndwi_f` (green/SWIR1),
  `albedo_f` (Liang 2001), and `ndvi_spring_f` (same sensors/masks, **Feb–Mar** of the window).
* Overpass metadata: scene list with `SCENE_CENTER_TIME`, path/row, date → `FRAME_META[y]["day"]`: `sensors`,
  `scenes`, `scenes_per_pathrow`, `mean_overpass_ist_h` (mean of scene local IST hours), `coverage` (fraction of ROI
  fine pixels valid), `path_offsets`.
* **Heating rate** for the overpass correction: from `ECMWF/ERA5_LAND/HOURLY` `skin_temperature` over the ROI,
  Apr–Jun of the window, mean at 04 and 06 UTC (09:30 / 11:30 IST): `heating_rate_k_per_h = (T06 − T04)/2` →
  `FRAME_META[y]["day"]["heating_rate_k_per_h"]`.
* MODIS Terra day validation (section 04): `MODIS/061/MOD11A2` `LST_Day_1km` QC bits0–1 ≤ 1 and 6–7 ≤ 1,
  `Day_view_time`×0.1 within 10.0–11.5 h local solar time, Apr–Jun window median at 1 km → `lst_day_modis` (NaN where
  absent; frames 2000–2020 meaningful, 2025 kept but flagged drifted).

### 2.2 Night LST, section 04
* Aqua `MODIS/061/MYD11A2` `LST_Night_1km` (QC bits0–1 ≤ 1, 6–7 ≤ 1) Apr–Jun window median → frames 2005–2020;
  count of valid composites → `lst_night_nobs`.
* **2025:** VIIRS `NASA/VIIRS/002/VNP21A1N` `LST_1KM` (QC mandatory ≤ 1 and LST-accuracy bits 14–15 ≥ 2; **check the
  scale at run time**: if values > 1000 multiply by 0.02) Apr–Jun 2024–2026 median, calibrated to Aqua.
* **2000:** Terra `MOD11A2` night (22:30) Apr–Jun 2000–2001 median, calibrated to Aqua.
* **Calibration** (`NIGHT_CALIBRATION`): fit on annual Apr–Jun medians in the overlap (VIIRS↔Aqua 2013–2021,
  Terra↔Aqua 2003–2019): per dominant GLC class a linear map `aqua = a + b·src`, plus a per-cell mean residual shrunk
  with weight `n/(n+3)`; report R², RMSE, n. Applied to produce Aqua-equivalent values.
* Annual series 1990–2025 (`ANNUAL_SERIES`, via `reduceRegions` at 1 km / native ERA5 scale over NCR + 25 districts):
  `era5_skin_day` (05 UTC Apr–Jun mean), `era5_skin_night` (20 UTC), `era5_tmax`, `era5_tmin` (daily aggregates, Apr–Jun
  mean of daily max/min 2 m temperature), `era5_swvl1`; satellites: `modis_terra_day` (QC + view-time filter, 2000–),
  `modis_aqua_night` (2002–; an annual night median needs ≥ 1 valid 8-day composite, because real data give ≥ 3 on only
  13–50 % of the NCR cells per year), `viirs_night_cal` (2012–, Aqua-calibrated), with `flag = "drift"` for Terra ≥ 2022 and
  Aqua ≥ 2022.

### 2.3 Drivers, section 05
| Variable (RAW key) | Source | Processing |
|---|---|---|
| `built_f` (fine), → `frac_built` | `JRC/GHSL/P2023A/GHS_BUILT_S/<frame>` `built_surface` | /10000 at 100 m → mean to fine grid (fraction) |
| `built_v` (1 km) | `GHS_BUILT_V/<frame>` `built_volume_total` | m³ per m² ground: /10000 at 100 m → mean to 1 km |
| `pop` (1 km) | `GHS_POP/<frame>` `population_count` | ×100 → persons/km² at 100 m → mean to 1 km |
| `glc_built, glc_forest, glc_water, glc_cropland, glc_barren, glc_otherveg` (1 km, sum = 1) | `projects/sat-io/open-datasets/GLC-FCS30D/five-years-map` (b1=1985, b2=1990, b3=1995) and `/annual` (b1=2000 … b23=2022; 2025 → b23) | v1 class remap (SPEC_v1 §2) → class-indicator means (30 m → 1 km, two-step reduceResolution) |
| `LC_FINE[y]` | GLC_FCS30D same bands | harmonised classes, mode-resampled to `LC_FINE_RES_M` (landscape metrics) |
| `elevation, slope, aspect_sin, aspect_cos` (1 km static), `elevation_f` (fine) | `USGS/SRTMGL1_003` | v1 recipe (sin/cos at 30 m before averaging) |
| `water_occ` (1 km), `water_occ_f` (fine) | `JRC/GSW1_4/GlobalSurfaceWater` `occurrence` | /100, mean |
| `era5_t2m, era5_rh, era5_vpd, era5_swvl1, era5_evap, era5_ssr, era5_wind, era5_tmax, era5_tmin` (1 km) | `ECMWF/ERA5_LAND/MONTHLY_AGGR` (+ `DAILY_AGGR` for tmax/tmin) Apr–Jun of the window | bilinear-resampled to 1 km; °C, %, kPa (Magnus), m³ m⁻³, mm day⁻¹ (positive = evaporation), MJ m⁻² day⁻¹ (`surface_net_solar_radiation_sum`), m s⁻¹ (√(u²+v²)) |
| `era5_precip_jfm` (1 km) | ERA5-Land monthly `total_precipitation_sum` Jan–Mar of the window | mm (sum per year, mean over window years) |
| Future (`FUTURE_INPUTS`, §3.2) | `NASA/GDDP-CMIP6` (historical+ssp245+ssp585, 34 models), `projects/sat-io/open-datasets/FUTURE-URBAN-LAND/CHEN_2020_2100` (SSP1/2/5), GHSL 2030, IIASA SSP v3 India urban population | §4.10. GDDP-CMIP6 values are built from per-(scenario, model, 5-year block) Apr–Jun means (blocks 2016–2020 … 2056–2060; windows starting ≤ 2014 join the historical scenario), each one `computePixels` of `[mean(tasmax, tasmin), count]` requested on a small EPSG:4326 grid aligned to the native 0.25° lattice and cached under `CACHE_DIR/gddp/`; a window field is the n-weighted mean of its 4 blocks, bilinear to the 1 km cell centres; the `cmip6` table is the ROI mean of that field and `cmip6_pattern` is computed from the same fields (median over complete ssp245 models of W(target) − W(NOW), divided by its ROI mean) |

---

## 3. Python inter-section interface

### 3.1 Produced by 00/01 (extends v1)
* 00: `CFG` (v2 fields §1.6 + v1 fields), `ENV`, `TIMINGS`, v1 utilities (`log, timer, free_memory, retry, set_seeds,
  save_json, gpu_mem_report, xgb_device_for, gpu_pool_map, is_oom_error, is_gpu_oom_error, pip_install`) plus:
  * `stage_cache(name, key_obj)` → context object with `.hit` (bool), `.load()`, `.save(obj)`: pickles under
    `CFG.CACHE_DIR/stages/<name>-<sha1(key_obj)[:12]>.pkl` (key_obj = JSON-able config subset); honours `CFG.RESUME`.
    **Key semantics:** `CFG.key()` always adds the code identity `code = {"sec": _CURRENT_SECTION, "sha":
    _CODE_SHA[_CURRENT_SECTION]}` and `shared = SHARED_CODE_TAG` (bumped by hand when a 00/01/02 helper changes
    results), plus `code01` for sections 03–05. `_CODE_SHA` (`{"00".."12": sha12}`) is injected by
    `build_notebook.py` as the notebook's first code cell (by `run_local.py`, and by `kaggle_runner.py` from the
    bundle's `BUNDLE_INFO.json`): per section, the sha1 of a version-independent AST dump (`_stable_dump`: no
    empty or None fields, so Python 3.11-3.14 give the same hash) of its code cells without docstrings, so comments
    and markdown never change it; a missing `_CODE_SHA` gives
    `code = None` and one warning. Cross-section compute dependencies are added explicitly by their owners
    (`09_day_hindcast` adds `code07`; `11_land_<ssp>` adds `code07` and `code08`; `s04_thermal` adds `code03`;
    `s05_drivers` and `s05_future` add `code03` and `code04`, because 04/05 fetch through the section-03 helpers). `LST_INVALIDATE` (comma tokens)
    forces a MISS for every stage whose name starts with a token or with `s` + token (Earth Engine tiles and GDDP
    blocks are never invalidated). Before computing a MISS, `get_or_compute` checks the time budget (expected =
    1.25 × the last compute time of the normalised stage name; before its first compute in a session, the
    `compute_s` of the newest sidecar of that name in `stages/`, else 0).
  * Run control (time budget, clean stop, resume): `LSTStop` (BaseException), `time_left_s()` (inf without a
    budget), `budget_exhausted(expected_s=0.0)` (True when stopped or `time_left_s() < expected_s +
    CFG.TIME_RESERVE_S`), `check_budget(where, expected_s=0.0)` (raises `LSTStop` on exhaustion), `request_stop(reason)`
    (thread-safe, idempotent; never packs), `finalize_stop()` (writes `OUTPUT_DIR/RUN_STOPPED.json` {reason, section,
    elapsed_h, time_budget_h, stop_after, profile, utc}, calls `pack_cache()`, logs resume instructions), `section_code_hash(*ids)` (sha1
    of the joined `id:sha` pairs [:12], None without `_CODE_SHA`), `pack_cache(force=False)` (when `LST_PACK_CACHE`
    is on: `CACHE_DIR/packed/stages_<group>.tar`, `tiles_<group>.tar`, `gddp.tar`, written atomically and verified,
    loose files of a group deleted after its tar; never touches `web/` or `web_bundle.zip`) and `import_cache`
    (copies `stages/`, `tiles/`, `gddp/` from `LST_CACHE_IMPORT` — any ancestor folder is searched for a `cache`
    folder — and extracts `packed/*.tar` members restricted to those prefixes; the output dir's own `packed/*.tar`
    are extracted at setup). In Jupyter every cell after 00 is wrapped so that an `LSTStop` ends the run cleanly
    (later cells print `skipped: run stopped (<reason>)`); `run_local.py` does the same per cell. Section 12 deletes
    a stale `RUN_STOPPED.json` at its start and calls `pack_cache()` as its last statement.
  * `lstb_write(path, columns, meta=None)` / `lstb_read(path)` — the LSTB container (§5.1). `columns` is a list of
    dicts `{name, array (numpy), dtype ("int16"|"uint8"|"int32"|"float32"), scale=1.0, offset=0.0, nodata=None}`;
    quantisation `raw = round((value − offset)/scale)`, NaN → nodata, clipped to the dtype range. `lstb_read` returns
    `{"header": {...}, "columns": {name: float32 array (decoded, NaN for nodata)}}`.
  * `quant_params(values, dtype="int16")` → `(scale, offset)` covering p0–p100 of finite values with headroom.
* 01: `DATA_MODE`, `DATA_MODE_REASON`, `DATA_SOURCES`, `DATA_CAVEATS`, `BOUNDARY_APPROXIMATE`, `GRID`, `GRID_FINE`,
  `ROI_MASK`, `ROI_MASK_FINE`, `DISTRICT_IDX` (H,W int16, −1 outside), `DISTRICTS` (25), `BOUNDARY_GEOJSON`,
  `N_CELLS`, `CELL_ROWS`, `CELL_COLS`, `CELL_IDS` (int32 arrays in canonical order), `CELL_LON`, `CELL_LAT`
  (float64), `EE_DISTRICTS` (ee.FeatureCollection with `did`, gee mode; None in synthetic). v1's GEE init, district
  matching (incl. HQ-point fallback) and grid code move here unchanged.

### 3.2 Produced by the acquisition layer (02 synthetic **or** 03–05 gee) — identical structure
* `RAW_STATIC` = `{elevation, slope, aspect_sin, aspect_cos, water_occ}` (H,W) float32 and
  `{elevation_f, water_occ_f}` (Hf,Wf) float32.
* `RAW_OBS[year]` for every year in `CFG.FRAMES_OBS`:
  * fine (Hf,Wf) float32: `lst_day_f, lst_day_nobs_f, ndvi_f, ndbi_f, mndwi_f, albedo_f, ndvi_spring_f, built_f`
  * 1 km (H,W) float32: `lst_night` (°C Aqua-equivalent, NaN if no product), `lst_night_nobs`, `lst_day_modis`,
    `built_v`, `pop`, `glc_built, glc_forest, glc_water, glc_cropland, glc_barren, glc_otherveg`,
    `era5_t2m, era5_rh, era5_vpd, era5_swvl1, era5_evap, era5_ssr, era5_wind, era5_tmax, era5_tmin, era5_precip_jfm`
  * NaN = nodata; everything outside the ROI is NaN.
* `LC_FINE[year]` uint8 (harmonised classes 0–6; 0 outside ROI).
* `FRAME_META[year]` = `{"window": (y0, y1), "day": {"sensors": [str], "scenes": int, "scenes_per_pathrow":
  {"146/040": int, …}, "mean_overpass_ist_h": float, "coverage": float, "heating_rate_k_per_h": float,
  "path_offsets": {"146": float, "147": float}}, "night": {"source": "aqua"|"terra_cal"|"viirs_cal"|None,
  "sensor": str|None, "overpass_ist_h": float|None, "composites": int, "coverage": float}}`.
* `NIGHT_CALIBRATION` = `{"terra_to_aqua": {"r2", "rmse", "n", "by_class": [{class, a, b, n}]}, "viirs_to_aqua": {...}}`.
* `ANNUAL_SERIES`: DataFrame `[year:int, scope:str ("ncr"|"d:<id>"), variable:str, value:float, flag:str|None]`
  (variables §2.2; years 1990–2025 where available).
* `FUTURE_INPUTS` = {
  `"cmip6"`: DataFrame `[scenario ("ssp245"|"ssp585"), model, frame (2025 baseline + FRAMES_PROJ), var ("tasmax"|"tasmin"),
  value_k]` = Apr–Jun mean of the GCM's daily values over the 20-year window centred on the frame
  (2025: 2016–2035, 2030: 2021–2040, …, 2050: 2041–2060; historical 1950–2014 + scenario 2015–2060 joined), ROI mean;
  `"cmip6_pattern"`: `{"tasmax": (H,W), "tasmin": (H,W)}` float32 = ensemble-median 2050 ssp245 delta field divided by
  its ROI mean (bilinear to 1 km; ≈ 1 everywhere);
  `"urban_growth"`: DataFrame `[scenario ("ssp126"|"ssp245"|"ssp585"), district, frame, ratio]` = urban area (Chen et
  al. 2020, value 2) in the district at the frame divided by 2020 (decades interpolated geometrically to 5-year frames;
  SSP1→ssp126, SSP2→ssp245, SSP5→ssp585);
  `"ghsl_2030"`: `{"built": (H,W), "pop": (H,W)}`;
  `"pop_growth"`: DataFrame `[scenario, frame, factor]` NCR urban-population factor vs 2025 (IIASA SSP v3 India urban
  population, cite the version in `DATA_SOURCES`);
  `"gsat_increment"`: `{scenario: {frame: K}}` AR6 WG1 assessed GSAT increment of the frame window over the 2016–2035
  window (used for the ssp126 pattern scaling; cite AR6 Table 4.5 and interpolate between assessed windows) }.
* `SYNTHETIC_TRUTH` — None (gee) or dict of planted facts (thresholds, β_day/β_night, UHI signs, path offsets,
  calibration slopes, heating rate) used by later sections for "planted vs recovered" reports.

### 3.3 Produced by 06_features
* `FEATURES` (47, fixed order §4.1), `BASE_FEATURES` (33), `FOCAL_SPEC = {"bases": [...7], "windows": [3, 15]}`,
  `FEATURE_META` (v1 keys + `family`, `group`, `base` bool; `actionable` true only for the 5 fractions, NDVI and the
  3 landscape metrics), `SHAP_GROUPS` (ordered dict group → member features, §4.4), `GROUP_META` (`label`, `primary`,
  `family`, `actionable`), `FEATURE_STATS`, `LM_VALIDATION`.
* `FEATURE_GRIDS[year][feature]` (H,W) float32 for every observed frame (focal/distances computed here; reused by 11).
* `DF`: one row per ROI cell × observed frame (ALL ROI cells, sorted by (year, cell_id), RangeIndex). Columns:
  `cell_id, row, col, x, y, lon, lat, district, year`, all `FEATURES` (float32), `lst_day`, `lst_night` (°C, NaN if
  missing), `w_day`, `w_night` (sample weights; 0 = not a training target), `anom_day`, `anom_night`,
  `fold_block5` (v1 5×5 greedy, 5 folds), `fold_block20` (20 km blocks, greedy size-balanced into `N_FOLDS_BLOCK`),
  `fold_random` (5), `block10_id`, `block20_id`, `fold_district` (= district id).
  Day target valid: `lst_day_nobs ≥ 2` (1 km mean of fine counts) and ≥ 50 % valid fine pixels; `w_day = clip(nobs/5,
  0.4, 1)`. Night target valid: `lst_night_nobs ≥ 3` (Aqua composites passing QC; lowered from 6 after the first real run, where a
  3-year Apr–Jun window gave a median of 4.8 per cell and ≥ 6 in only 30 % of the ROI; the Terra-reconstructed frame:
  ≥ 1, its weight is 0; VIIRS: ≥ 20 daily obs), `w_night =
  clip(nobs/12, 0.5, 1)`. **Night training frames = 2005–2025** (`CFG.NIGHT_TRAIN_FRAMES`); 2000 night (Terra
  reconstructed) is held out as the hindcast check; 1990/1995 have no night target.
* `FIXED_MASK[mode]`, `RAW_LEVELS[mode][year]` (mean over the fixed mask of the raw absolute target — day before the
  overpass correction; mean over `FIXED_MASK & valid`). `FIXED_MASK[mode]` = ROI cells valid in **every** mask frame
  (strict intersection; mask frames = training frames whose valid-target share of ROI cells ≥ `LST_FRAME_MIN_COVERAGE`,
  0.5, a part of the 06 stage key); training frames below that threshold get `w_<mode> = 0` (warning + caveat).
  Fewer than 2 mask frames or a `FIXED_MASK` with < 1 % of the ROI cells is a `RuntimeError` (per-frame coverages).
  `FIXED_MASK_COVERAGE[mode][year]` (float) = share of `FIXED_MASK` cells with a valid target at that frame, for every
  frame (1.0 for mask frames). A day frame without any valid target is an error.

### 3.4 Produced by 07_models (per mode m)
* `MODEL_RESULTS[m]` = `{"cv_fold_metrics": DataFrame[scheme, model, fold, r2, rmse, mae, bias, n_train, n_test,
  fit_seconds, device], "cv_summary": DataFrame[scheme, model, r2_pooled, rmse_pooled, mae_pooled, r2_fold_mean,
  r2_fold_sd, rmse_fold_mean, rmse_fold_sd, n_folds, n], "oof": {scheme: {model: float32[N_DF] (NaN where not predicted)}},
  "block_size_curve": [...], "error_vs_distance": [...], "loeo": [...], "place_time": {...}, "moran": DataFrame,
  "moran_target": DataFrame, "moran_scatter": {...}, "fold_geometry": {...}, "best_rounds": [int]}` (contents §4.2, §5.7).
* `FINAL_MODELS[m]` (xgboost.Booster on all training rows of m; rounds = round(1.1 × median best_rounds of block20)).
* `PREDICT_ANOM(m, X, recentre_mask=None)` → float32 predictions (anomaly units); if `recentre_mask` (bool over rows of
  one frame) is given, subtracts the mean over those rows.
* `PERSISTENT_RESID[m]` (H,W) float32 r̄ and `PERSISTENT_LAMBDA[m]` (§4.5).
* `AOA[m]` = `{"weights", "mean", "std", "train_sample", "d_bar", "threshold", "di_train", "rmse_by_di_decile",
  "conformal": {"edges": [...], "abs_resid_quantiles": {"q50","q90","q95"}: [...]}, "resid_samples": [10 arrays],
  "resid_samples_proj": [10 float32 arrays], "conformal_proj": {"abs_resid_quantiles": {"q50","q90","q95"}: [10]},
  "resid_rho_block20": float in [0, 0.95]}` and `COMPUTE_DI(m, X)` → DI. `resid_samples_proj` holds the signed
  projection-setting residuals `y − (PRED_LOEO + r̄^(−t))` by DI decile (≤ `_S07_RESID_SAMPLES` each; empty deciles
  borrow the nearest populated one); `resid_rho_block20` is their pooled within-frame block20 correlation (§4.6).
  `COMPUTE_DI` returns **+inf** for rows with a NaN in any feature with AOA weight > 0 (outside the AOA, top DI
  decile in every consumer). `MODEL_RESULTS[m]["aoa"]` adds `resid_rho_block20` and `proj_resid_q90` (10 floats);
  `MODEL_RESULTS[m]["lane_busy_seconds"]` = `{"gpu", "cpu", "lgbm"}`.

### 3.5 Produced by 08_explain (per mode m)
* `XAI_FRAMES[m]` = observed frames with SHAP (day: all 8; night: all 8 — 1990/1995 modelled rows explain the model's
  hindcast). `SHAP_BASE[m]`, `SHAP_GROUP_VALUES[m][year]` (N_CELLS × 18 float32, canonical order; NaN rows where
  features are missing), `PRED_ANOM[m][year]` (N_CELLS float32, raw model output), `OOF_ANOM[m][year]` (block20 OOF,
  NaN when not a training row).
* `IMPORTANCE[m]`, `INTERACTIONS[m]` (18×18 global + by zone), `DEPENDENCE[m]`, `THRESHOLDS[m]` (per group, v1
  machinery incl. recentred-percentile intervals and support), `BOOTSTRAP_INFO[m]`.
* `ZONE_MODEL[m]` (centroids 4×18, labelling record), `ASSIGN_ZONES(m, shap_group_matrix)` → uint8 ids,
  `ZONES_OBS[m][year]` (N_CELLS uint8, 255 = nodata), `ZONE_PROFILES[m]`, `ZONE_TRANSITIONS[m]`, `RECOMMENDATIONS[m]`.
  `ZONE_PROFILES[m][k]` carries `display_name` (str) and `label_caveat` (str | None) (§1.5);
  `ZONE_MODEL[m]["labelling"]` adds `riparian_criterion_met` (bool), `riparian_criterion` (str) and, per cluster,
  `share_water_ge_0_2` and `water_group_rank`.
* `SCENARIO_COUPLING` (mode-independent), `WEB_MODELS[m]` (compact surrogate dict, v1 format).

### 3.6 Produced by 09_timeline
* `LEVELS[m][year]` = `{"level": °C, "ci": [lo, hi], "method": str, "overpass_correction": °C|None}` for all observed
  frames (night 1990/1995 included, from ERA5 regression).
* `FRAME_TIERS[m][year]` (tier strings), `FRAME_FIELDS[m][year]` (N_CELLS float32 absolute °C; observed values where
  valid, NaN elsewhere — **except** modelled frames, which are full model fields), `FRAME_UNC[m][year]` = `{"p05",
  "p95"}` (N_CELLS float32) for `modelled`/`reconstructed` frames (conformal by DI decile), `FRAME_AOA_OUT[m][year]`
  (N_CELLS bool).
* `CLIMATE_SENSITIVITY[m]` = `{"beta", "ci", "draws" (bootstrap array ≥ 1000), "r2", "n_years", "regressors",
  "method", "temperature_var" ("era5_tmax"|"era5_tmin")}`, `TRENDS[m]`, `SERIES_FRAMES[m][scope]` (frame stats),
  `HINDCAST_METRICS[m]`, `DAY_LEVEL_CHECK` (Landsat level vs MODIS Terra level by frame).

### 3.7 Produced by 10_downscaling
* `FINE_FIELDS[m][year]` (Hf,Wf) float32 absolute °C (day: Landsat observed + overpass correction; night:
  downscaled), `FINE_FLAGS[m][year]` uint8 (bit0 outside AOA, bits1–2 tier code: 0 observed, 1 observed-sparse /
  reconstructed, 2 modelled, 3 downscaled), `DOWNSCALING_METRICS`, `RASTER_INDEX` (dict for `raster_index.json`) and
  the written PNGs (written here, under `CFG.WEB_DIR/raster/`).

### 3.8 Produced by 11_projections
* `LAND_MODEL_METRICS`, `PROJ_QUANTILES[m][s]` = `{"p05","p25","p50","p75","p95"}` each (Y × N_CELLS) float32 °C,
  `PROJ_FLAGS[m][s]` (Y × N_CELLS uint8: bit0 outside AOA, bits1–2 VSUP tier), `PROJ_ZONES[m][s]` (Y × N_CELLS uint8),
  `PROJ_SERIES[m][s][scope]` = list of `{year, p05, p25, p50, p75, p95}`, `PROJ_DECOMPOSITION[m][s][year]`,
  `PROJ_UNCERTAINTY[m][s][year]`, `PROJ_THRESHOLD_YEARS[m][s][scope]`, `CMIP6_DELTAS` (incl. pattern-scaled ssp126),
  `PROJ_DRIVER_SUMMARY` (district built-up/pop per scenario × frame).

### 3.9 Produced by 12_export: the files of §5 and `EXPORT_MANIFEST`.
Before it finishes, 12 validates the bundle twice. (1) In-notebook read-back checks (`_s12_check_bundle`, including
the cross-file XAI/cube/zones checks); any problem raises `ValueError`. (2) The standalone `validate_bundle.py`
(found through `LST_VALIDATOR`, the repository's `notebook/` folder or an attached `/kaggle/input/*/`) runs as a
subprocess with a 1800 s timeout. A verdict of `INVALID` or `BUNDLE UNREADABLE` fails the run. A non-zero exit
without a verdict line means the child never judged the bundle, so it is retried once and then logged as a WARNING
with its exit code, like a timeout. A missing validator is only logged.

---

## 4. Methods (normative)

### 4.1 Features (47; order is binding)
```
BASE (33):
 spectral   ndvi ndbi mndwi albedo ndvi_spring ndvi_drop(=ndvi_spring-ndvi)
 landcover  frac_built frac_forest frac_water frac_cropland frac_barren
 urban      built_v(log1p of m3/m2) log_pop(log1p persons/km2) dist_urban dist_builtup lm_pd lm_ed lm_contag
 water      dist_water
 terrain    elevation slope aspect_sin aspect_cos elev_tpi7 elev_tpi21 elev_std7
 climate    era5_t2m era5_vpd era5_swvl1 era5_evap era5_ssr era5_wind era5_precip_jfm
FOCAL (14):  <b>_m3 <b>_m15 for b in ndvi ndbi albedo frac_built frac_forest frac_water frac_barren
```
* 1 km spectral/built features = mean of valid fine pixels (≥ 50 % valid else NaN). `frac_built` = 1 km mean of
  `built_f`; other fractions = `glc_k / (1 − glc_built) × (1 − frac_built)` (simplex with implicit
  `frac_otherveg = 1 − Σ`; if `glc_built ≥ 0.999` use equal split of nothing → 0).
* Focal: NaN-aware box means `uniform_filter(x·m)/uniform_filter(m)` with windows 3 and 15 cells (1 km grid; at the
  2 km smoke grid the windows stay 3/15 *cells* — documented). `elev_tpi7 = elevation − box7(elevation)`,
  `elev_tpi21` likewise, `elev_std7` = box standard deviation. Distances (km, Euclidean `distance_transform_edt` ×
  cell size): `dist_water` to cells with `frac_water ≥ 0.3 or water_occ ≥ 0.5`; `dist_urban` to cells whose box7
  mean `frac_built ≥ 0.3` (lowered from 0.5 after the first real run: the 7 km mean peaks at 0.45-0.49 over NCR; if
  no cell reaches it, the top 0.5 % of the ROI); `dist_builtup` to `frac_built ≥ 0.3` (cells outside the ROI count as
  non-targets).
* Landscape metrics PD/ED/CONTAG exactly as v1 (vectorised, pylandstats-validated) from `LC_FINE`.
* Families (dominant-driver colouring): `spectral`, `landcover`, `urban`, `water`, `terrain`, `climate`.

### 4.2 Validation suite (per mode; all metrics pooled unless stated)
* Pooled R² = 1 − ΣSSE/ΣSST over all OOF rows (SST about the pooled mean); RMSE, MAE pooled; per-fold r2/rmse/mae/bias
  as the spread. Weights `w_mode` used in fitting **and** weighted metrics.
* Schemes: `block20` (headline spatial; 20 km blocks, `N_FOLDS_BLOCK` folds), `block5` (v1-comparable 5×5), `district`
  (leave-one-district-out; districts with < 200 rows merged into their nearest neighbour fold), `loeo` (leave one
  training frame out; report raw and **recentred** metrics, recentring over the fixed mask of the held-out frame),
  `place_time` (train frames < last & folds ≠ k → test last frame & fold k, block20 folds; recentred), `random` (5-fold,
  "optimistic upper bound").
* Models per scheme: `block20` & `loeo`: all `CFG.BENCHMARKS`; `block5`: xgboost, lightgbm, gnn; `district`,
  `place_time`: xgboost; `random`: xgboost, random_forest, ridge. Inner early stopping on 10 km blocks inside the
  training rows only (v1). GPU folds via `gpu_pool_map` (XGBoost, GNN); random forest and ridge run in a CPU lane;
  with a working LightGBM-GPU probe, LightGBM jobs run **serially in their own lane** (`s07-lgbm-lane`, at most one
  booster alive; its OpenCL learner is not thread safe) on the last GPU (`gpu_id = n_gpus − 1`), otherwise in the CPU
  lane. All lanes join at the mode barrier; each lane checks the time budget before every job; per-lane busy seconds
  go to `MODEL_RESULTS[m]["lane_busy_seconds"]`.
* `block_size_curve`: xgboost, 5 folds, blocks of 5/10/20/40/66 km (+ "random") → `[{block_km, r2_pooled,
  rmse_pooled}]`. `error_vs_distance`: block20 xgboost OOF; distance (km) from each test cell to the nearest training
  cell of the same frame; bins [0,2,5,10,20,40,∞) → `[{lo, hi, rmse, n}]`.
* Moran's I of block20 OOF residuals per frame for xgboost, gnn, ridge (v1 implementation); `moran_target`;
  `moran_scatter` (last frame, ≤ 2000 points).
* `fold_geometry` for the fold map: `{"block20": {"block_km": 20, "n_rows": R, "n_cols": C, "fold_of_block":
  [R*C ints, −1 empty], "rmse_of_block": [R*C floats|null]}, "block5": {...}}` (blocks in grid row-major order from the
  grid's top-left).
* v1 comparison block: `{"v1_metric": "mean of per-fold R² (5×5)", "v1_xgb": [0.623, 0.305], "v1_gnn": [0.823, 0.048],
  "v2_block5_pooled": …, "v2_block5_fold_mean": …, "v2_block20_pooled": …}` (v1 numbers are constants from the real
  v1 bundle; in synthetic mode label them "reference values from the real v1 run").

### 4.3 Models
* Ridge (standardised, median-imputed), random_forest (sklearn; 300 trees, max_features 0.33, min_samples_leaf 5,
  max_samples 0.5; cuML only with `USE_RAPIDS`), lightgbm (v1, GPU probe; GPU jobs serial on the last GPU, §4.2),
  xgboost (§1.4 params, `tree_method=hist`,
  `device=cuda:k`), gnn (v1 pure-PyTorch GraphSAGE on the full feature set, kNN k=8 per frame).
* Monotone constraints (xgboost & lightgbm): day −1 on `ndvi, ndvi_m3, ndvi_m15, frac_forest(+_m3,_m15),
  frac_water(+_m3,_m15), mndwi`; night +1 on `built_v, frac_built, frac_built_m3, frac_built_m15`. Other features 0.

### 4.4 SHAP groups (18; order binding) and XAI
```
ndvi            ndvi ndvi_m3 ndvi_m15                      (primary ndvi)
phenology       ndvi_spring ndvi_drop                      (primary ndvi_drop)
ndbi            ndbi ndbi_m3 ndbi_m15                      (primary ndbi)
moisture_index  mndwi
albedo          albedo albedo_m3 albedo_m15
built           frac_built frac_built_m3 frac_built_m15    (primary frac_built, actionable)
built_volume    built_v
population      log_pop
forest          frac_forest frac_forest_m3 frac_forest_m15 (actionable)
water           frac_water frac_water_m3 frac_water_m15 dist_water (primary frac_water, actionable)
cropland        frac_cropland                              (actionable)
barren          frac_barren frac_barren_m3 frac_barren_m15 (actionable)
urban_proximity dist_urban dist_builtup                    (primary dist_urban)
landscape       lm_pd lm_ed lm_contag                      (primary lm_ed, actionable)
terrain         elevation slope aspect_sin aspect_cos elev_tpi7 elev_tpi21 elev_std7 (primary elevation)
climate_heat    era5_t2m era5_ssr                          (primary era5_t2m)
climate_moisture era5_vpd era5_swvl1 era5_evap era5_precip_jfm (primary era5_swvl1)
climate_wind    era5_wind
```
* Group SHAP = sum of member SHAP (TreeSHAP additivity preserved: `pred = base + Σ_groups`). Interactions summed over
  member pairs (18×18), sampled ≤ 5000 rows per frame. Dependence/thresholds: x = primary feature value, y = group
  SHAP (v1 binning, thresholds, recentred-percentile bootstrap intervals with `support`, `zero_crossing_flag`).
* Bootstrap: block bootstrap (v1 correlogram-derived block size), `N_BOOTSTRAP` replicates, GPUs in parallel.
* Recommendations (per mode, per zone): v1 rule (feasibility bounds, model counterfactual with the final model, simplex
  rebalancing incl. other-vegetation, coupled spectral shifts) **plus**: after modifying base features, recompute the
  focal features on the grid (distances held fixed); levers = actionable groups' primary features.
* Web surrogate per mode (v1 compact format, depth ≤ 6, ≤ 400 trees) on all 47 features + `"focal": FOCAL_SPEC`.

### 4.5 Persistent residual (time transfer only)
LOEO residuals `ρ(i,s) = anom(i,s) − PRED_LOEO(i,s)` (recentred). For a target frame t:
`r̄_i^(−t) = Σ_{s≠t} w_is ρ(i,s) / (Σ_{s≠t} w_is + λ)`. Choose λ ∈ {0.5,1,2,3,5,10,∞} minimising LOEO RMSE of
`PRED_LOEO + r̄^(−t)`; report the gain (`metrics.persistent_residual`). Final `PERSISTENT_RESID[m]` uses all frames.
It is **never** included in spatial-CV numbers.

### 4.6 Area of applicability (Meyer & Pebesma 2021)
Standardise features (training mean/std), weight by mean |SHAP| per feature (final model), training sample ≤ 20 000
rows, `d_bar` = mean pairwise distance in the sample, DI = nearest-training-row distance / d_bar; training DI uses the
nearest row from a **different block20 fold**; threshold = Q75 + 1.5·IQR of training DI. Rows with a NaN in any
feature with AOA weight > 0 get **DI = +inf** (outside the AOA and the top DI decile in every consumer; summaries,
histograms and plots of DI use finite values only); the AOA training sample is drawn from complete training rows only.
Conformal error model: block20 OOF |residual| quantiles (q50, q90, q95) by DI decile (edges from training DI).
**Projection-setting error model:** after choosing λ (§4.5), `ρ_proj = y − (PRED_LOEO + r̄^(−t))` for training rows
with a finite LOEO prediction (r̄ = 0 when λ = ∞), binned by the different-fold DI of the conformal model (incomplete
rows +inf) with the same edges → `resid_samples_proj` (signed, per decile) and `conformal_proj` (|ρ_proj| q50/q90/q95
per decile). Their spatial correlation `resid_rho_block20` ∈ [0, 0.95]: per frame, over block20 blocks with ≥ 5 rows,
`ρ_t = (var(block means) − mean(within-block var / n_b)) / var(ρ_proj of the frame)`, pooled as the row-weighted mean
over frames, then clipped. They describe a known place at an unseen time — the setting of the modelled hindcast
frames (§4.7) and of the projections (§4.10).

### 4.7 Levels (absolute °C) and frame fields (section 09)
* **Day:** `L_day(t) = RAW_LEVELS.day[t] + overpass_correction(t)`, `overpass_correction = (10.75 − mean_overpass_ist_h)
  × heating_rate_k_per_h` (°C; positive for early scenes). Day frame field = raw anomaly + L_day(t). Interval: ±(0.25 ×
  |correction| + 0.3) °C (documented heuristic). `DAY_LEVEL_CHECK`: compare with MODIS Terra fixed-mask means 2000–2020.
* **Night observed/reconstructed:** `L_night(t) = RAW_LEVELS.night[t]` (2000 = calibrated Terra).
* **Composition correction (partially covered frames):** every non-modelled frame with `FIXED_MASK_COVERAGE < 0.999`
  and a finite raw level gets `a = PREDICT_ANOM(mode, X_t)` (not recentred) `+ PERSISTENT_RESID[mode]` at the frame's
  cells, `corr = mean_{FIXED_MASK}(a) − mean_{FIXED_MASK & valid_t}(a)`, `level = raw (+ overpass correction for day)
  + corr`, `half_width = √(hw² + (0.5·corr)²)`; `LEVELS[m][y]` records `raw_level`, `composition_correction`,
  `fixed_mask_coverage` (and says so in `method`); a warning when |corr| > 0.2 °C. The level-regression offset below
  uses the corrected levels. Frame fields are unchanged (observed values + overpass correction).
* **Night 1990/1995 (modelled):** regress annual NCR-mean `modis_aqua_night` (2003–2021) and `viirs_night_cal`
  (2022–2025) on `era5_skin_night` (OLS + leave-one-year-out RMSE) → predict the window-mean level with a 90 %
  prediction interval. The level offset of the frame regression includes a **residual drift** term: drift = OLS
  slope (± se) of the annual level-regression residuals over the years of the **primary** sensor only (night: Aqua
  2003–2021, so the VIIRS calibration step cannot pose as drift), applied only when |drift| > 2·se on at least 10
  primary-sensor years spanning at least 10 years;
  `offset(t) = mean(frame residuals) + drift_applied × (t_mid − mean t_mid of the offset frames)` for the modelled
  levels and the `regression_check` of the other frames; the prediction interval keeps the (Δt·se)² term.
  `_S09_LEVEL_REG[m]` records `drift_per_year`, `drift_se`, `drift_applied`, `drift_years`, each modelled frame
  `LEVELS[m][y]["drift_correction_c"]` (0.0 when not applied). **Known limitation (accepted):** with 19 primary
  years a real drift near the gate can stay unapplied (synthetic world: 0.0174 ± 0.0092 °C/yr = 1.9 se), leaving the
  1990/1995 levels warm by about |drift|·Δt (+0.26/+0.40 °C there, both inside their prediction intervals); the
  WARNING and the modelled frames' `method` text report drift ± se and the shift drift·Δt it would have made. No estimator that respects the primary-sensor rule brings the
  reconstructed-2000 `regression_check` below 0.08 °C on the synthetic world, so that is not an acceptance criterion.
  Field = `PREDICT_ANOM(night, X_t, recentre)` + `PERSISTENT_RESID.night` +
  `L_night(t)`, with per-cell p05/p95 = field ± the **projection-setting** conformal q90 of the cell's DI decile
  (`AOA.conformal_proj`, known place at another time; block20 q90 when absent) combined in quadrature with the level
  interval. Day frames are never modelled (§1.2).
* **Hindcast checks:** night 2000 (train 2005–2025 → predict 2000 vs Terra-reconstructed obs, recentred: r2/rmse vs
  persistence of 2005); day "train late, predict early" (train 2005–2025 → 1990/1995/2000, recentred).
* **β (dLST/dTair):** day: annual NCR `modis_terra_day` (2003–2020, non-drift) on `era5_tmax` with `era5_swvl1`
  co-regressor; night: `modis_aqua_night` 2003–2021 + `viirs_night_cal` 2022–2025 on `era5_tmin` (+ swvl1). OLS
  coefficient of temperature; moving-block bootstrap (block 3 years, 2000 draws) → CI and `draws`; Theil–Sen univariate
  slope reported alongside. Synthetic mode reports recovery of the planted β.
* **Trends:** Theil–Sen slope per decade of frame levels (observed/reconstructed frames only; day 1990–2025, night
  2000–2025) with Monte-Carlo CI from level intervals; annual-series trends for ERA5 1990–2025 and satellites.
* Frame statistics per scope (NCR, 25 districts, zones of the same mode): `mean`, `ci` (level CI), `p90`,
  `hot_core_km2` (area with LST ≥ the reference-period p90 of that mode, fixed per mode), `uhi` (mean over cells with
  `frac_built ≥ 0.5` minus mean over `frac_built ≤ 0.05 and frac_water < 0.2`; signed), `n_cells`, `tier`, and
  `coverage` (finite cells / ROI cells of the scope at that frame, 4 dp). Scope `ncr`: `mean` and `ci` are the frame
  **level** and its CI (`LEVELS[m][y]`; fixed mask, composition-consistent); districts and zones: mean over their
  finite cells. `hot_core_km2` = share of finite scope cells ≥ threshold × scope ROI cell count × cell area
  (coverage-corrected); `p90`, `uhi` and `n_cells` use the finite cells. Rows with coverage < 0.9 are logged.
  The scaling assumes the hidden cells share the visible cells' hot fraction: unbiased for scattered gaps, but a
  spatially contiguous gap over a cooler or hotter part of the scope biases the area (+11 % to −36 % for 10 % strips
  on the synthetic world, where the unscaled count can be exact); consumers can judge a row by its `coverage`.

### 4.8 Downscaling (section 10)
* **Day fine field** = `lst_day_f` (observed) + overpass correction; fine pixels with < 2 scenes are NaN.
* **Night fine field (DMS):** fine predictors `P_f` = [ndvi_f, ndbi_f, mndwi_f, albedo_f, built_f, water_occ_f,
  elevation_f, tpi_f (elevation_f − box7), ndvi_f box5 mean, built_f box9 mean]; coarse `P_c` = 4×4 block means.
  Train XGBoost (depth 6, 600 rounds, eta 0.05) on 1 km cells with a valid night anomaly, excluding the 20 % most
  heterogeneous cells (z-scored within-cell std of ndvi_f + built_f). Predict `T̂_f`; residual `r_c = T_c −
  block4(T̂_f)`; add bilinearly interpolated `r_c` at fine-pixel centres, then 3 iterations of block conservation
  (`e_c = T_c − block4(T_f)`, add `e_c` nearest-upsampled) → |e_c| < 0.01 °C. Modelled frames (1990/1995) downscale the
  modelled 1 km field.
* **Validation:** (a) scale invariance: aggregate 1 km night anomalies and predictors to 4 km, train at 4 km on
  block20 folds ≠ k, downscale 4 km → 1 km, score held-out folds vs true 1 km (r2, rmse, bias) and vs bilinear
  interpolation of the 4 km field; (b) day demonstration: downscale MODIS Terra day (2010, 2015, 2020) 1 km → fine with
  the same algorithm and compare anomalies with Landsat `lst_day_f` anomalies (r2, rmse; bilinear baseline; by dominant
  GLC class). Results → `DOWNSCALING_METRICS` / `metrics.json`.
* **Rasters:** reproject each fine field to EPSG:4326 on a regular lon/lat grid covering the ROI bounds at
  0.0025° (and a 0.005° "500 m" preview) by inverse mapping (pyproj, nearest fine pixel); PNG 8-bit RGB: R = 0 nodata,
  else `1 + round((v − lo) / (hi − lo) × 254)` clipped to 1..255 with **fixed per-mode lo/hi** (`timeline.domains`
  abs); G = flags; B = 0. Written with Pillow.

### 4.9 Land-change model (section 11)
* State `u = frac_built` (1 km). Demand per district d, scenario s, frame y: `U_d,s(y) = U_d(2025) × g_d,s(y)/g_d,s(2025)`
  where g = Chen-2020 urban ratio (vs 2020); for 2030 also report the GHSL-2030 demand for comparison.
* Suitability: XGBoost classifier for `Δu(2005→2015) > 0.05` on [u, frac_built_m3, frac_built_m15, dist_urban,
  dist_builtup, slope, elevation, log_pop, frac_forest, frac_water, frac_cropland, frac_barren] (2005 features).
* Allocation per district and 5-year step: `Δu_i = min(cap_i, k_d · S_i · N_i · ε_i)`, `N_i` = box3 mean of u,
  `cap_i = max(0, 1 − u_i − frac_forest_i − frac_water_i)`, `ε ~ LogNormal(0, 0.3)` per realisation; `k_d` by bisection
  so Σ Δu_i = demand increment. Converted land comes from cropland, barren and other vegetation in proportion to their
  current shares. `N_LAND_REAL` realisations (seeded).
* Validation: hindcast 2015 → 2025 with the observed district demand; Pontius figure of merit on cells with Δu > 0.05
  (hits/(hits+misses+false alarms+wrong hits)), quantity & allocation disagreement, RMSE(Δu) and `corr_du` (Pearson
  Δu_sim vs Δu_obs over valid cells, mean over realisations), each also for the null model `Δu ∝ u_2015`
  (proportional growth: `fom_null`, `quantity_disagreement_null`, `allocation_disagreement_null`, `rmse_du_null`,
  `corr_du_null`) → `metrics.land_model`. Plausibility: `checks` = `[{check, value, null, ok}]` for `fom > null`,
  `rmse_du <= null`, `quantity_disagreement <= null`, `corr_du >= null`; `verdict` = `beats_null` (all ok) | `mixed`
  | `worse_than_null` (none ok); `hindcast_truth` = `"GHSL P2023A <end year> epoch"`, suffixed `" (an extrapolated
  GHSL epoch, not an observation)"` when the end year is 2025 — the 2015 → 2025 hindcast truth is the extrapolated
  GHSL 2025 epoch. The CA output drives the projections whatever the verdict (no gating).
* Derived future predictors: spectral (ndvi, ndbi, mndwi, albedo, ndvi_spring, ndvi_drop), `built_v`, `lm_*`:
  delta mapping `X_y = X_2025 + h_X(LC_y) − h_X(LC_2025)` with `h_X` = XGBoost (depth 4, 300 rounds) of X on the 5
  fractions + their focal means + terrain, fitted on 2015–2025 frames. Population:
  `pop_y(i) = pop_2025(i) × F_s(y) × (u_y(i)+0.02)/(u_2025(i)+0.02)`, renormalised so the NCR total = total_2025 ×
  F_s(y). Focal features and distances recomputed from projected grids. ERA5 features = mean of the 2015/2020/2025
  frames (climate change enters only through the delta).

### 4.10 Climate delta and Monte-Carlo projections (section 11)
* `ΔT_s,g(y) = value(y) − value(2025)` per GCM (tasmax for day, tasmin for night). ssp126:
  `ΔT_126,g(y) = ΔT_245,g(y) × gsat_increment[ssp126][y] / gsat_increment[ssp245][y]` (flag `method="pattern-scaled"`).
* Baseline level (weather-normalised): `L_base,m = L_m(2025) − β_m × anomaly`, `anomaly = mean(T over the NOW
  window years 2024–26) − T_trend(mean of those years)`, where `T_trend` is the OLS line of the ERA5-Land NCR annual
  series of the mode's temperature variable (ANNUAL_SERIES; `era5_tmax` day, `era5_tmin` night) over 2001–2025 (all
  available years). With fewer than 10 years the anomaly falls back to the window mean minus the 2016–2025 mean (with
  a warning). `CMIP6_DELTAS["l_base"][m]` records `l_base, level_now, beta, weather_anomaly_c, temperature_var,
  window_years, reference_years, trend_slope_per_decade, trend_years, method`.
* For each draw k (N_MC): pick GCM g (uniform), β from its bootstrap draws, land realisation r (uniform), and per-cell
  model error e_i from the **projection-setting** residual samples of the cell's DI decile (`AOA.resid_samples_proj`
  when complete, else the block20 OOF `resid_samples`):
  `LST_k(i,y) = L_base,m + β_k · ΔT_s,g(y) · pattern_m(i) + [Â_m,s,r(y,i) − mean_FIXED(Â_m(2025))] + r̄_m(i) + e_i`,
  where `Â` = raw final-model anomaly prediction on the projected features (recentred **relative to the 2025
  prediction mean**, so the land-driven domain shift is kept). The model error is drawn through a **block20
  Gaussian copula**: `z_kb ~ N(0,1)` per draw k and block20 block b (`default_rng([SEED, 1181])`, drawn once per run,
  shared by all scenarios, modes and cell chunks; blocks of the canonical cells = `DF["block20_id"][:N_CELLS]`),
  `z_ki = Φ⁻¹(clip(u_ki, 1e−6, 1 − 1e−6))` from the per-chunk `[SEED, 1180, chunk]` uniforms, `u = Φ(√ρ·z_kb +
  √(1−ρ)·z_ki)`, e = sorted decile sample at u, with ρ = `AOA.resid_rho_block20` (ρ = 0 reproduces independent draws
  exactly). `PROJ_META[m][s]["model_error"] = {"samples": "loeo+rbar" | "block20", "rho": ρ}`.
* Outputs: per-cell P05/P25/P50/P75/P95; scope series quantiles from **per-draw scope means**; decomposition at each
  frame `{climate: β̄·mean ΔT, land: mean(Â_y − Â_2025), total: p50 − baseline_c, baseline_c, baseline_offset,
  model_error_mean}` with the scope's weather-normalised 2025 baseline `baseline_c = L_base + scope mean of
  (Â_2025 − mean_FIXED(Â_2025) + r̄)`, so that `total ≈ climate + land + model_error_mean` for every scope (contract:
  < 0.3 °C; asserted in synthetic mode, a warning in gee mode); uncertainty budget = variance of the scope mean
  explained by each factor (main effects: variance of conditional means over g, β, r, and the model-error variance),
  normalised to sum 1; threshold years = first projected frame where the scope p50 exceeds `baseline_c + {1,2,3}` °C
  (keys "+1", "+2", "+3"). AOA DI for projected features (flags bit0); VSUP tier from (p95 − p05)/2 (<0.5, <1, <2,
  ≥2 °C). Projected zones: zone ids from SHAP of the median land realisation's features.
* Every projection output carries `"scenario projection, not a forecast"` in `manifest.notes` and the timeline.

---

## 5. Web bundle v2 (`CFG.WEB_DIR` → `dashboard/public/data/` or `/demo/`)

All JSON: UTF-8, compact, NaN/Inf → null, numbers rounded (°C 2 dp, SHAP 3 dp). Large JSON files are gzip
(`.json.gz`, level 9). Binary files use the **LSTB** container (`.lstb.gz`). Readers detect gzip by magic bytes
(0x1f 0x8b) and accept already-inflated responses.

### 5.1 LSTB container
```
gzip( "LSTB" | u8 version=1 | u8[3] reserved=0 | u32le header_len | header (UTF-8 JSON, header_len bytes)
      | zero padding to an 8-byte boundary (relative to file start) | data section )
header = {"kind": str, "n": int, "meta": {...},
          "columns": [{"name": str, "dtype": "int16"|"uint8"|"int32"|"float32", "shape": [int, ...],
                       "scale": float, "offset": float, "nodata": int|null,
                       "byte_offset": int (from data-section start, multiple of 8), "byte_length": int}]}
value = raw * scale + offset; raw == nodata → NaN. Little-endian. Multi-dim shapes are row-major ([frames, n]).
```

### 5.2 Files
```
manifest.json                         schema_version "2.0" (§5.3)
cells.lstb.gz                         kind "cells": cell_id int32, row int16, col int16, lon float32, lat float32, district int16 [n]
timeline_series.json.gz               §5.4
cube_obs_<mode>.lstb.gz               kind "cube": lst int16 [F_obs, n] (°C, scale 0.01, nodata −32768);
                                      aoa_out uint8 [F_obs, n]; p05_off, p95_off uint8 [F_obs, n] (scale 0.05 °C; 0 for observed frames)
                                      meta: {mode, frames, tiers, levels}
cube_<ssp>_<mode>.lstb.gz             kind "cube": p50 int16 [F_proj, n]; p05_off, p25_off, p75_off, p95_off uint8 [F_proj, n]
                                      (non-negative offsets from p50, scale 0.05 °C, clipped); flags uint8 [F_proj, n]
                                      meta: {mode, scenario, frames, method}
cube_zones_<mode>.lstb.gz             kind "zones": obs uint8 [F_obs, n]; ssp126/ssp245/ssp585 uint8 [F_proj, n] (255 = nodata)
xai_<year>_features.lstb.gz           kind "features": the 33 BASE_FEATURES as int16 [n] (per-column scale/offset); meta {year}
xai_<year>_<mode>.lstb.gz             kind "xai": 18 group SHAP int16 [n] (scale 0.001 °C); pred, oof, obs int16 [n]
                                      (absolute °C, scale 0.01); resid int16 (obs − oof); meta {year, mode, tier,
                                      base_value_c (= SHAP_BASE + level), level, groups, optional
                                      composition_correction (°C; obs = cube lst + composition_correction)}
raster_index.json                     {crs: "EPSG:4326", bounds: [W,S,E,N], width, height, preview: {width, height},
                                       domains: {day: [lo,hi], night: [lo,hi]},
                                       frames: {"<mode>_<year>": {file, preview, lo, hi, tier, downscaled}}}
raster/<mode>_<year>.png, raster/<mode>_<year>_500m.png
zones.json, shap_global.json, dependence.json.gz, interactions.json, metrics.json, provenance.json   §5.5–5.8
model_web_day.json, model_web_night.json   v1 compact format (SPEC_v1 §4.3) on the 47 FEATURES + "focal": FOCAL_SPEC
scenario_coupling.json                v1 format + {"focal": FOCAL_SPEC, "grid": {"width","height"}}
districts.geojson                     v1
```
Invariant (validated): for every XAI frame and mode, `|pred − (base_value_c + Σ group SHAP)| ≤ 0.05 °C` on non-NaN
rows; cube sizes = frames × n; frame lists = manifest; `n` identical across files. Cross-file alignment (validated):
for observed / observed-sparse / reconstructed XAI frames `|obs − composition_correction − cube lst| ≤ 0.011 °C`
with identical NaN patterns; for modelled frames `corr(pred, cube lst) ≥ 0.5`; `corr(pred, obs) ≥ 0.5` where obs is
finite on ≥ 100 rows (≥ 0.25 for a reconstructed frame, which the model never trained on; 0.25–0.5 there is a
warning); the nearest `zones.json` centroid of each complete SHAP row equals `cube_zones` obs on ≥ 99 %
of the rows.

### 5.3 `manifest.json` (v2)
v1 keys kept: `schema_version` ("2.0"), `generated_at`, `data_mode`, `data_mode_reason`, `study_area` (+ `grid`:
{crs, res, x0, y0, width, height}, `fine_res_m`), `target_mode` ("anomaly"), `features` (47 × FEATURE_META incl. stats,
`base`, `family`, `group`), `zones` (per mode: `zones: {day: [...4], night: [...4]}` with id/name/color), `districts`,
`data_sources`, `notes`, `bootstrap` (per mode), `synthetic_truth`. The per-mode `zones` entries are built from
`ZONE_PROFILES[m]` in canonical order and may carry `display_name` (non-empty string) and `label_caveat` (string or
null) next to the canonical id/name/color (§1.5). Observed frame entries may carry the optional level diagnostics
`raw_level`, `composition_correction`, `fixed_mask_coverage` and `drift_correction_c` (§4.7). New:
```json
"modes": [{"id": "day", "label": "Day · ~10:30 IST", "target": "Landsat C2 L2 ST (harmonised, 10:45 IST reference)", "ramp": "solar"},
          {"id": "night", "label": "Night · ~01:30 IST", "target": "MODIS Aqua night (Aqua-equivalent; VIIRS/Terra calibrated)", "ramp": "nocturne"}],
"groups": [{"id": "ndvi", "label": "Vegetation (NDVI)", "primary": "ndvi", "family": "spectral", "actionable": true, "members": [...]}],
"timeline": {
  "now": 2025, "harmonised": true, "reference_period": [2000, 2020],
  "frames": [{"year": 1990, "window": [1989, 1992], "kind": "observed",
              "day":   {"tier": "observed-sparse", "sensor": "Landsat 5 TM", "overpass_ist": "10:11", "scenes": 69, "coverage": 0.99, "native_m": 30, "available": true, "level": 41.2, "level_ci": [40.6, 41.8]},
              "night": {"tier": "modelled", "sensor": "model hindcast (ERA5-Land level)", "overpass_ist": "01:30", "scenes": 0, "coverage": 1.0, "native_m": 1000, "available": true, "level": 27.9, "level_ci": [27.1, 28.7]},
              "xai": {"day": true, "night": true}, "raster": {"day": true, "night": true}},
             {"year": 2030, "window": [2021, 2040], "kind": "projected", "day": {"tier": "projected", "available": true, ...}, "night": {...},
              "xai": {"day": false, "night": false}, "raster": {"day": false, "night": false}}],
  "scenarios": [{"id": "ssp126", "label": "SSP1-2.6", "method": "pattern-scaled", "n_gcm": 34}, {"id": "ssp245", ...}, {"id": "ssp585", ...}],
  "domains": {"day": {"abs": [lo, hi], "anom": [-a, a], "suhi": [-b, b]}, "night": {...}, "dtr": {"abs": [lo, hi]}, "spread": [0, s]},
  "annotations": [{"year": 2003, "label": "Landsat 7 SLC-off", "kind": "sensor"}, {"year": 2022, "label": "Terra/Aqua drift; VIIRS bridge", "kind": "sensor"}],
  "tiers": ["observed", "observed-sparse", "reconstructed", "modelled", "projected"],
  "cubes": {"obs_day": "cube_obs_day.lstb.gz", "ssp245_night": "cube_ssp245_night.lstb.gz", "zones_day": "cube_zones_day.lstb.gz", ...},
  "raster_index": "raster_index.json"
},
"files": {"cells": "cells.lstb.gz", "series": "timeline_series.json.gz", "xai": {"day": {"1990": {"features": "xai_1990_features.lstb.gz", "shap": "xai_1990_day.lstb.gz"}}, "night": {...}},
          "model": {"day": "model_web_day.json", "night": "model_web_night.json"}, "shap_global": "shap_global.json",
          "dependence": "dependence.json.gz", "zones": "zones.json", "metrics": "metrics.json", "interactions": "interactions.json",
          "coupling": "scenario_coupling.json", "districts": "districts.geojson", "provenance": "provenance.json"}
```
`domains.*.abs` = p0.5–p99.5 over all frames (observed + projected p50) of that mode, rounded outward to 1 °C.

### 5.4 `timeline_series.json.gz`
```json
{"reference_period": [2000, 2020], "hot_core_threshold_c": {"day": 46.1, "night": 31.4},
 "scopes": [{"id": "ncr", "label": "Delhi NCR", "kind": "ncr"}, {"id": "d:1", "label": "Gurugram", "kind": "district"},
            {"id": "z:day:3", "label": "Heat Extreme Core", "kind": "zone", "mode": "day"}],
 "series": {"<scope>": {"<mode>": {
    "frames": [{"year": 1990, "mean": 41.2, "ci": [40.6, 41.8], "p90": 44.0, "hot_core_km2": 0, "uhi": -1.7, "n_cells": 55150, "tier": "observed-sparse", "coverage": 0.9972}],
    "annual": {"era5_skin": [{"year": 1990, "value": 37.1, "anomaly": -0.3}], "satellite": [{"year": 2003, "value": 28.4, "sensor": "MODIS Aqua", "flag": null}]},
    "ssp": {"ssp245": [{"year": 2030, "p05": 0, "p25": 0, "p50": 0, "p75": 0, "p95": 0}]},
    "trend": {"obs": {"slope_per_decade": 0.0, "ci": [0, 0], "period": [1990, 2025], "method": "Theil-Sen + MC"}, "annual": {"era5_skin": {...}}},
    "decomposition": {"ssp245": {"2050": {"climate": 0, "land": 0, "total": 0, "baseline_c": 0}}},
    "uncertainty_budget": {"ssp245": {"2050": {"gcm": 0, "sensitivity": 0, "land": 0, "model": 0}}},
    "threshold_years": {"ssp245": {"+1": 2041, "+2": null, "+3": null}}}}},
 "zone_share": {"day": {"obs": {"1990": [0.2, 0.1, 0.4, 0.3]}, "ssp245": {"2030": [...]}}, "night": {...}}}
```
Satellite annual series per mode: day → `modis_terra_day` (sensor "MODIS Terra", drift flags); night →
`modis_aqua_night` + `viirs_night_cal`. Zone scopes exist only for their own mode. Frame rows carry an optional
`coverage` (finite cells / ROI cells of the scope, 0–1, 4 dp; §4.7). Decomposition rows are `{climate, land, total,
baseline_c}` at 2 dp with `total = p50 − baseline_c` (the scope's weather-normalised 2025 baseline, §4.10); readers
must accept rows without `baseline_c` (older bundles: then `total` was relative to `L_base`). The top level also
carries `baseline_level_c` = `{mode: L_base}` (NCR weather-normalised baseline, §4.10).

### 5.5 `zones.json`, `shap_global.json`, `dependence.json.gz`, `interactions.json`
All are `{"modes": {"day": {...}, "night": {...}}}` with the v1 per-mode content, adapted:
* zones: v1 keys per zone, with `area_km2` / `lst_mean` keyed `{"obs": {year: v}, "<ssp>": {year: v}}`, `shap_means`
  per group, recommendations per v1/D2 + focal recompute; `transitions: {"obs": {"1990->1995": 4×4}, "<ssp>":
  {"2025->2030": 4×4, ...}}`, `labelling`, `k`, `silhouette`, `diagnostics`. Every zone entry may carry
  `display_name` (non-empty string; default = `name`) and `label_caveat` (string or null) (§1.5); `labelling` carries
  the §3.5 record (`riparian_criterion_met`, `riparian_criterion`, per-cluster `share_water_ge_0_2` and
  `water_group_rank`). Canonical `id`/`name`/`color` are unchanged.
* shap_global: `groups`, `global {mean_abs, ci_lo, ci_hi, bias}`, `by_frame {year: {mean_abs, mean}}`, `by_zone`,
  `n_bootstrap`, `ci_method`, `ci_label`.
* dependence: `groups: {<group>: {primary, bin_centers, mean, ci_lo, ci_hi, count, scatter{...}, threshold{...}}}`
  (v1 fields; scatter colour = strongest interaction-partner group's primary feature).
* interactions: `groups`, `global` (18×18), `by_zone`.

### 5.6 `metrics.json`
```json
{"modes": {"day": {"schemes": [...], "summary": [...], "folds": [...], "block_size_curve": [...], "error_vs_distance": [...],
                   "loeo": [{"held_out": 2015, "r2_raw": 0, "r2_recentred": 0, "rmse_recentred": 0, "bias_raw": 0}],
                   "place_time": {...}, "moran": [...], "moran_target": [...], "moran_scatter": {...}, "fold_geometry": {...},
                   "aoa": {"di_threshold": 0, "pct_inside": {"1990": 0}, "rmse_by_di_decile": [...]},
                   "persistent_residual": {"lambda": 0, "loeo_rmse_without": 0, "loeo_rmse_with": 0},
                   "hindcast": {...}, "cross_sensor": {"landsat_vs_modis_terra": [{"year": 2010, "r2": 0, "rmse": 0}]},
                   "v1_comparison": {...}, "headline": {"spatial": {"scheme": "block20", "model": "xgboost", "r2": 0, "rmse": 0},
                                                        "temporal": {"scheme": "loeo", "model": "xgboost", "r2": 0, "rmse": 0}}},
           "night": {...}},
 "downscaling": {"night": {"scale_invariance": {"r2": 0, "rmse": 0, "bias": 0, "bilinear_rmse": 0}, "by_lc": [...]},
                 "day_demo": {"r2": 0, "rmse": 0, "bilinear_rmse": 0, "years": [2010, 2015, 2020]}},
 "land_model": {"fom": 0, "fom_null": 0, "quantity_disagreement": 0, "allocation_disagreement": 0, "rmse_du": 0, "rmse_du_null": 0,
                "corr_du": 0, "corr_du_null": 0, "checks": [{"check": "fom > null", "value": 0, "null": 0, "ok": true}],
                "verdict": "mixed", "hindcast_truth": "GHSL P2023A 2025 epoch (an extrapolated GHSL epoch, not an observation)"},
 "climate_sensitivity": {"day": {"beta": 0, "ci": [0, 0], "r2": 0, "n_years": 0, "theil_sen": 0}, "night": {...}},
 "night_calibration": {"terra_to_aqua": {"r2": 0, "rmse": 0, "n": 0, "by_class": [...], "diag": {...}}, "viirs_to_aqua": {...}},
 "cmip6": {"baseline_frame": 2025, "baseline_window": [2016, 2035], "observation_window": [2024, 2026], "l_base": {...}, ...},
 "projection_meta": {"day": {"ssp245": {"pct_outside_aoa": {"2030": 0.0}, "model_error": {"samples": "loeo+rbar", "rho": 0.3}, ...}}},
 "hardware": {...}, "timings": {...}}
```
* `night_calibration[kind]` keeps the §3.2 keys; gee runs add `diag` (section 04 `NIGHT_CALIBRATION_DIAG[kind]`:
  overlap years, pooled classes, leave-one-year-out RMSE, `cells_per_class` {class: int}; a class gets its own fit
  only with ≥ 30 (cell, year) pairs and ≥ 20 distinct cells, else the pooled map). Synthetic bundles keep the plain
  shape.
* `land_model` adds `corr_du`, `corr_du_null`, the null's quantity/allocation disagreement, `checks`, `verdict`
  (`beats_null` | `mixed` | `worse_than_null`) and `hindcast_truth` (§4.9).
* `modes[m].aoa` adds `resid_rho_block20` and `proj_resid_q90` (10 floats, §4.6).
* `projection_meta[mode][ssp]` = `{seconds, n_mc, n_gcm, n_land_real, beta_mean, beta_sd, l_base, a2025_fixed_mean,
  scopes, model_error: {samples, rho}, frames, method, pct_outside_aoa: {year: fraction}, note, omitted_feedbacks}`.
* `cmip6.baseline_window` = the 20-year GCM window of the baseline frame (`[2016, 2035]`) and `cmip6.observation_window`
  = its observation window (`[2024, 2026]`) whose weather anomaly `L_base` removes (§4.10).

### 5.7 `provenance.json`
`{"sources": [{"id","label","asset","start","end","resolution_m","role","used_for":[...],"notes"}],
  "frames": [{"year","mode","tier","sensor","window","scenes","coverage","overpass_ist"}], "annotations": [...]}`.

### 5.8 v1 compatibility
The dashboard must load **both** schema 1.x bundles (`SPEC_v1.md` §4; the user's real bundle in `public/data/` today)
and 2.0 bundles. v1 → v2 adapter: single mode "day", frames = v1 epochs (tier "observed", sensor "MODIS Terra"), no
night/projections/rasters (UI shows "unavailable — rerun notebook v2"), XAI from `epoch_<year>.json.gz`.

---

## 6. Dashboard v2 (summary — details in `docs/UI_SPEC_v2.md`)
* Design: "NCR THERMAL/OPS v2" — Mission-Control shell, persistent deck.gl stage, time ribbon 1990–2050, Day/Night/DTR,
  SSP fans, evidence-tier glyphs from the manifest, fixed colour domains, 6 routes (Control, Timeline, Drivers,
  Zones, Model Lab, Sources), Briefing overlay with guarded copy, compare split, lens, perf governor, WCAG 2.2 AA,
  reduced-motion matrix.
* Data layer reads §5 exactly (LSTB reader with DecompressionStream; worker decode). **This SPEC overrides UI_SPEC
  §10 file names** (`*.lstb.gz` containers instead of `.i16.gz/.u8.gz`). The data layer requires DecompressionStream;
  without it the app shows an explicit unsupported-browser state (Chrome/Edge 80+, Firefox 113+, Safari 16.4+).
* Zone names: the dashboard shows `display_name ?? name` wherever a zone name appears and shows `label_caveat` when
  present. Projected change: `base = dec.baseline_c ?? (finite dec.total ? p50 − dec.total : (scope ncr ?
  baseline_level_c[mode] : null))`; Δ / lo / hi = p50 / p05 / p95 − base, labelled "Δ vs weather-normalised 2025
  baseline (p50)"; fans, strands and sparkfans anchor at the scope baseline (the first projected frame's
  `baseline_c`) with a hollow baseline marker.
* Bundle source: `?bundle=data|demo` (+ Settings menu); default `data` when `public/data/manifest.json` exists, else
  `demo`. `VITE_DATA_BASE_URL` still overrides.
* Dependencies allowed to add: `zustand`, `@fontsource-variable/{inter,space-grotesk,jetbrains-mono}`, dev `jsdom`,
  `vitest-axe`. Pin `@deck.gl/*` and `deck.gl` to `~9.4`. No three.js/GSAP/Lottie/bloom.
* The synthetic banner stays persistent for `data_mode == "synthetic"`; v1 tests keep passing or are migrated.

## 7. Testing (definition of done)
* `python notebook/build_notebook.py --check`; `python notebook/run_local.py --out <dir>` (synthetic, fast, 2 km) ends
  `ALL SECTIONS OK` exit 0; a 1 km synthetic run (fast profile) also passes; `python notebook/validate_bundle.py <web>`
  VALID for v2 output and still VALID for the v1 bundle in `dashboard/public/data`.
* Synthetic "planted vs recovered" report printed by 08/09/11 (thresholds, β, UHI signs day < 0 < night, path
  offsets, calibration slopes, land-model FoM > null).
* Dashboard: `npm run lint`, `npm test` (incl. LSTB decode of Python-written fixtures, v1-compat adapter, guards),
  `npm run build`; headless-browser smoke on `public/demo` (v2) **and** `public/data` (v1) with zero console errors.
