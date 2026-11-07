# Delhi NCR LST × Explainable AI Platform — Architecture & Data Contract

This file is the **single source of truth** for everything shared between the Kaggle notebook
(`delhi_ncr_lst_pipeline.ipynb`, built from `notebook/sections/*.py`) and the React dashboard
(`dashboard/`). Any name, file, column, or JSON key listed here must be used exactly as written.

---

## 0. Repository layout

```
LST replication study/
├── delhi_ncr_lst_pipeline.ipynb        # BUILT artifact (python notebook/build_notebook.py)
├── notebook/
│   ├── sections/                       # jupytext "percent" format sources, executed in order
│   │   ├── 00_setup.py                 # config, env/GPU detection, utilities
│   │   ├── 01_data_acquisition.py      # ROI, grid, GEE extraction, synthetic generator
│   │   ├── 02_features.py              # land-cover fractions, landscape metrics, feature table
│   │   ├── 03_models_validation.py     # benchmarks, triple CV, Moran's I, GNN
│   │   ├── 04_shap_zoning.py           # final model, TreeSHAP, interactions, bootstrap, thresholds, K-means zones
│   │   └── 05_export.py                # parquet / GeoJSON / web bundle / compact model
│   ├── build_notebook.py               # sections -> .ipynb
│   ├── run_local.py                    # executes all sections as one script (local smoke test)
│   └── validate_bundle.py              # standalone §4 validator for a web bundle (numpy only)
├── dashboard/                          # React 18 + Vite dashboard
│   └── public/data/                    # web bundle (copied from outputs/web/); the committed demo bundle is SYNTHETIC
└── docs/SPEC.md
```

### Section file format (jupytext percent)
```python
# %% [markdown]
# ## 2.1 Heading
# Markdown text, every line prefixed with "# ".

# %%
python_code()
```
Rules for section code (it is also executed as a plain script by `run_local.py`):
* **No IPython magics / shell escapes** (`%pip`, `!pip`, `%%time` are forbidden). Install with the
  `pip_install()` helper from 00 (subprocess). Use `display()` only via `from IPython.display import display`
  inside try/except (fallback to `print`).
* All sections share ONE global namespace. Only the globals listed in §3 are the inter-section interface;
  prefix other module-level helpers/temporaries with `_` or keep them inside functions.
* Every heavy stage ends with `free_memory()`.
* Figures: matplotlib only; always `savefig` into `CFG.FIG_DIR` and then `plt.show()` + `plt.close(fig)`
  (works headless under the Agg backend).

---

## 1. Study design (decisions — do not change silently)

| Item | Decision |
|---|---|
| Study area | Delhi NCR, ~55,000 km², 25 districts (list in §1.1) |
| Grid | `CFG.CRS = "EPSG:32643"` (UTM 43N), square cells of `CFG.GRID_RES_M` (1000 m default), grid snapped to multiples of the cell size |
| Epochs | `CFG.EPOCHS = [2010, 2015, 2020, 2025]` |
| Season | Pre-monsoon summer, `CFG.SEASON = ("04-01", "06-30")` within each epoch year |
| Target | MODIS LST day (°C). `CFG.TARGET_MODE = "anomaly"` (default): target = LST − epoch spatial mean (removes inter-annual climate offset so the temporal split tests spatial-pattern transfer). `"absolute"` is supported. |
| Model | ONE pooled model over all epochs (no `year` feature: trees cannot extrapolate time) |
| Land-cover classes (harmonized) | `0` nodata, `1` built/impervious, `2` tree/forest, `3` water, `4` cropland, `5` barren/bare, `6` other vegetation (grass/shrub/wetland/snow/moss) |
| Fine land-cover resolution | `CFG.FINE_RES_M` must divide `CFG.GRID_RES_M`. GEE default 25 m (40×40 px per cell). Synthetic default 100 m. |
| Zones | K=4, fixed canonical ids: `0` Ecological Cool Base, `1` Riparian Buffer, `2` Transition, `3` Heat Extreme Core |

### 1.1 Canonical districts (display name, state, approx. HQ lon/lat, GAUL/geoBoundaries aliases)
District id = index in this list. Delhi's 9–11 sub-districts are merged into one "Delhi NCT".

| id | name | state | HQ lon, lat | aliases (case/space-insensitive) |
|---|---|---|---|---|
| 0 | Delhi NCT | Delhi | 77.21, 28.61 | any ADM2 inside ADM1 "Delhi"/"NCT of Delhi" |
| 1 | Gurugram | Haryana | 77.03, 28.46 | gurgaon, gurugram |
| 2 | Faridabad | Haryana | 77.31, 28.41 | faridabad |
| 3 | Palwal | Haryana | 77.33, 28.14 | palwal |
| 4 | Nuh | Haryana | 77.00, 28.10 | mewat, nuh |
| 5 | Rewari | Haryana | 76.62, 28.19 | rewari |
| 6 | Jhajjar | Haryana | 76.66, 28.61 | jhajjar |
| 7 | Rohtak | Haryana | 76.61, 28.90 | rohtak |
| 8 | Sonipat | Haryana | 77.02, 28.99 | sonipat, sonepat |
| 9 | Panipat | Haryana | 76.97, 29.39 | panipat |
| 10 | Karnal | Haryana | 76.99, 29.69 | karnal |
| 11 | Jind | Haryana | 76.32, 29.32 | jind |
| 12 | Bhiwani | Haryana | 76.13, 28.79 | bhiwani |
| 13 | Charkhi Dadri | Haryana | 76.27, 28.59 | charkhi dadri, dadri (Haryana only) |
| 14 | Mahendragarh | Haryana | 76.11, 28.05 | mahendragarh, mahendergarh, narnaul |
| 15 | Meerut | Uttar Pradesh | 77.71, 28.98 | meerut |
| 16 | Ghaziabad | Uttar Pradesh | 77.44, 28.67 | ghaziabad |
| 17 | Gautam Buddh Nagar | Uttar Pradesh | 77.49, 28.47 | gautam buddha nagar, gautam buddh nagar, gautambudhnagar, noida |
| 18 | Bulandshahr | Uttar Pradesh | 77.85, 28.40 | bulandshahr, bulandshahar |
| 19 | Baghpat | Uttar Pradesh | 77.22, 28.94 | baghpat, bagpat |
| 20 | Hapur | Uttar Pradesh | 77.78, 28.73 | hapur, panchsheel nagar |
| 21 | Shamli | Uttar Pradesh | 77.31, 29.45 | shamli, samli (geoBoundaries v6 spelling), prabudh nagar, prabuddh nagar |
| 22 | Muzaffarnagar | Uttar Pradesh | 77.70, 29.47 | muzaffarnagar |
| 23 | Alwar | Rajasthan | 76.60, 27.55 | alwar |
| 24 | Bharatpur | Rajasthan | 77.49, 27.22 | bharatpur |

Districts that exist only in newer boundary sets (Palwal, Charkhi Dadri, Hapur, Shamli) may be absent from
older layers (their parent district covers the area) — that is acceptable; keep their id reserved (0 cells).
"Absent" is verified, not assumed: for every canonical district left unmatched by name, the layer is queried for the
polygon containing its HQ point. An *unmatched* polygon there (unknown spelling) is matched by location with a
WARNING (add the spelling to this table); a polygon already matched to another district means "merged into that
parent" (INFO, acceptable); no polygon at all is logged as an ERROR (territory missing from the ROI).
The dashboard presets resolve "Gurugram" and "Noida" via these aliases (Noida → id 17).

### 1.2 Approximate NCR outline (lon, lat) — used ONLY by synthetic mode / as fallback ROI
```
(76.45,29.95) (76.85,29.95) (77.20,29.75) (77.55,29.75) (78.10,29.55) (78.20,29.20) (78.45,28.60)
(78.45,28.20) (78.00,28.05) (77.55,27.95) (77.55,27.50) (77.85,27.20) (77.65,26.75) (77.20,26.70)
(76.90,27.05) (76.25,27.05) (76.10,27.40) (76.20,27.90) (75.95,28.00) (75.45,28.40) (75.55,28.90)
(75.85,29.05) (75.95,29.55) (76.20,29.60) (76.45,29.95)
```
Synthetic mode partitions this outline into districts by nearest HQ (Voronoi). The GEE path uses the same outline and
partition only as a last resort (both boundary layers failed); it then adds an "APPROXIMATE district boundaries"
caveat to `manifest.notes` and sets `manifest.study_area.boundary_approximate = true` (also true in synthetic mode).
Yamuna (approx polyline): (77.19,29.95) (77.13,29.55) (77.12,29.20) (77.22,28.85) (77.25,28.62) (77.30,28.45) (77.45,28.20) (77.52,27.90) (77.68,27.55).
Ganga: (78.03,29.75) (78.10,29.30) (78.18,28.95) (78.32,28.60) (78.45,28.30).
Aravalli ridge axis: (77.17,28.62) (77.10,28.40) (76.85,28.15) (76.60,27.80) (76.40,27.35).

---

## 2. Data sources (GEE mode)

| Variable(s) | GEE asset | Processing |
|---|---|---|
| `lst_day_c`, `lst_obs_count` | `MODIS/061/MOD11A2` `LST_Day_1km`, `QC_Day` | keep QC bits0-1 ∈ {0,1} AND bits6-7 (LST error) ≤ 1; ×0.02 − 273.15; seasonal **median**; count of valid composites. Native pixels need ≥ `CFG.LST_MIN_OBS` (3) valid composites and a grid cell needs ≥ `CFG.LST_MIN_COVERAGE` (0.5) valid area, else its LST is NaN (no target); section 02 also drops rows with `lst_obs_count < LST_MIN_OBS` |
| `ndvi`, `ndwi`, `ndbi` | `MODIS/061/MOD09A1` | StateQA: cloud bits0-1 == 0, shadow bit2 == 0, internal cloud bit10 == 0; ×0.0001; NDVI=(b02−b01)/(b02+b01); NDWI (McFeeters)=(b04−b02)/(b04+b02); NDBI=(b06−b02)/(b06+b02); seasonal median of each index; mean-aggregate 500 m → 1 km |
| `elevation`, `slope`, `aspect_sin`, `aspect_cos` | `USGS/SRTMGL1_003` | `ee.Terrain.products`; sin/cos of aspect computed at 30 m BEFORE averaging (circular variable); mean-aggregate to 1 km; static (copied to every epoch) |
| `ntl` | 2015/2020/2025: `NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG` `avg_rad` annual median over the months with cloud-free coverage (`cf_cvg > 0`; other months masked), clamp ≥0, `log1p`. 2010: `NOAA/DMSP-OLS/NIGHTTIME_LIGHTS` `stable_lights` F18 2010, (1) **intercalibrated to F18 2013** (DMSP has no on-board calibration) with a robust quadratic DN fit on pseudo-invariant pixels (lit and unsaturated in both years; trimmed least squares keeping the 80 % best-fitting pixels), then (2) mapped into VIIRS log1p space with **isotonic regression** fitted inside the ROI on **DMSP F18 2013 vs the first VIIRS VCMSLCFG year (2014)** — VIIRS monthly composites start in January 2014, so this is a one-year offset, not a true overlap | single harmonized scale = log1p(nW·cm⁻²·sr⁻¹) |
| `pop_density` | 2010/2015/2020: `WorldPop/GP/100m/pop` (country IND, year). 2025: `JRC/GHSL/P2023A/GHS_POP` (epoch 2025) × (ROI total WorldPop2020 / ROI total GHS-POP2020) | sum 100 m → 1 km ⇒ persons/km² |
| land cover (fine, harmonized) | `CFG.LC_SOURCES = {2010:"glc_fcs30d", 2015:"glc_fcs30d", 2020:"esa_worldcover", 2025:"dynamic_world"}`. GLC_FCS30D: `projects/sat-io/open-datasets/GLC-FCS30D/annual`; WorldCover: `ESA/WorldCover/v100`; Dynamic World: `GOOGLE/DYNAMICWORLD/V1` annual **mode** of `label` | remap to harmonized classes (§1) → mode-resample to `FINE_RES_M` |
| ROI & districts | preferred `WM/geoLab/geoBoundaries/600/ADM2` (IND), fallback `FAO/GAUL/2015/level2`, final fallback §1.2 outline | alias matching §1.1 + HQ-location check of unmatched districts; print matched names & area |

Class remaps (→ harmonized): WorldCover {10:2, 20:6, 30:6, 40:4, 50:1, 60:5, 70:6, 80:3, 90:6, 95:2, 100:6};
Dynamic World label {0:3, 1:2, 2:6, 3:6, 4:4, 5:6, 6:1, 7:5, 8:6};
GLC_FCS30D {10,11,12,20:4; 51,52,61,62,71,72,81,82,91,92:2; 120,121,122,130,140,150,152,153,181-187:6; 190:1; 200,201,202:5; 210:3; 220:6}.
Provenance of every variable/epoch goes into `DATA_SOURCES` and the manifest.
Known caveats to print & export in `manifest.notes` (section 1 publishes them as `DATA_CAVEATS`): cross-product
land-cover inconsistency, DMSP saturation in urban cores and the approximate 2010→2013→VIIRS calibration, Terra orbit
drift after 2022 (earlier overpass), GHS-POP 2025 is a projection; plus run-specific ones (approximate district
boundaries, a DMSP year that could not be intercalibrated, an epoch served by the nearest available source year).
Epoch availability is validated before extraction: MODIS needs 2000 ≤ year ≤ present, population needs WorldPop
(2000–2020) or a GHS-POP epoch (≤ 2030); a pre-2014 year outside DMSP F18's 2010–2013 uses the nearest F18 year
with a caveat.

GEE extraction MUST use `ee.data.computePixels` with `fileFormat="NUMPY_NDARRAY"` on an explicit grid
(`crsCode` + `affineTransform` + `dimensions`), tiled (`CFG.GEE_TILE_PX` for 1 km stacks, `CFG.GEE_FINE_TILE_PX`
for fine land cover), in a thread pool (`CFG.GEE_WORKERS`), with exponential-backoff retry and recursive
tile subdivision on "memory"/"timed out"/"too large" errors, and on-disk tile caching for resumability.
Masked pixels are made explicit via `.unmask(NODATA)`. Error classes: load-related errors (HTTP 429/5xx, "Too many
concurrent aggregations", "Earth Engine (memory) capacity exceeded", timeouts, connection resets) are transient
(retried); size/memory errors split the tile and are permanent once it cannot be split further (timeouts stay
retryable); everything else is permanent. The first permanent failure cancels the queued tiles and stops in-flight
retries. The tile-cache folder name hashes the grid, the band list and the **serialised Earth Engine expression**
(`image.serialize()`), so any change of dates/season, QA rules, scale factors or the district mapping invalidates
the cache (`_GEE_CACHE_VERSION = "v2"`). In `auto` mode an extraction failure falls back to synthetic data only
when no service-account key was supplied; with a key the error is raised.

---

## 3. Inter-section global interface (Python)

Row order convention: `DF` is sorted by (`year`, `cell_id`) with a RangeIndex 0..N−1. **Every per-row array
(`SHAP_VALUES`, `ZONES`, `OOF_PRED[...]`) is aligned to this order.**

### 00_setup.py produces
* `CFG` — dataclass instance. Fields (env override in brackets):
  `RUN_MODE` ["LST_RUN_MODE"; "auto"|"gee"|"synthetic"; default "auto" — auto tries GEE, falls back to synthetic with a LOUD banner],
  `FAST_DEV` ["LST_FAST_DEV"; bool; shrinks all loops for smoke tests],
  `EPOCHS`, `SEASON`, `CRS`, `GRID_RES_M` ["LST_GRID_RES_M"], `FINE_RES_M` ["LST_FINE_RES_M"; default 25 in gee mode, 100 in synthetic — resolve after mode is known via `CFG.fine_res()`],
  `LM_WINDOW_CELLS` (1), `TARGET_MODE`, `SEED` (42), `N_FOLDS` (5), `SPATIAL_BLOCKS` ((5,5)),
  `INNER_BLOCK_KM` (10), `BOOT_BLOCK_KM` ["LST_BOOT_BLOCK_KM"; None = derived from the residual correlogram in 04],
  `N_BOOTSTRAP` ["LST_N_BOOTSTRAP"; 100; FAST_DEV → 8], `K_ZONES` (4),
  `LST_MIN_OBS` ["LST_LST_MIN_OBS"; 3], `LST_MIN_COVERAGE` (0.5),
  `DEP_BINS` (40), `MORAN_K` (8), `MORAN_PERMS` (999; FAST_DEV 99), `XGB_PARAMS` (dict, see 03), `XGB_MAX_ROUNDS` (3000; FAST_DEV 300),
  `XGB_EARLY_STOP` (100; FAST_DEV 30), `GNN_EPOCHS` (300; FAST_DEV 40), `SHAP_BATCH` (16384),
  `SHAP_INTERACTION_MAX_ROWS` (None on GPU / 4000 on CPU), `GEE_PROJECT` ["LST_GEE_PROJECT" or Kaggle secret `GEE_PROJECT`],
  `GEE_TILE_PX` (128), `GEE_FINE_TILE_PX` (2048), `GEE_WORKERS` (6), `GEE_MAX_RETRIES` (6),
  `LC_SOURCES`, `INSTALL_RAPIDS` ["LST_INSTALL_RAPIDS"; False; installs cuDF/cuML in section 0.1 **before numpy is
  imported**, constrained to the installed numpy/pandas, `LST_RAPIDS_VERSION` pins the release], `USE_RAPIDS`
  ["LST_USE_RAPIDS"; False; True when INSTALL_RAPIDS — the cuDF/cuML paths are opt-in even where RAPIDS is
  preinstalled, as on Kaggle], `OUTPUT_DIR` ["LST_OUTPUT_DIR"; `/kaggle/working/outputs` on Kaggle else `./outputs`],
  derived dirs `CACHE_DIR`, `FIG_DIR`, `PARQUET_DIR`, `GEO_DIR`, `MODEL_DIR`, `NPZ_DIR`, `WEB_DIR`.
* `ENV` — dict: `is_kaggle`, `n_gpus`, `gpu_names`, `gpu_mem_mib`, `has_cuda`, `torch_device_count`, `has_cudf`, `has_cuml`
  (both False unless `CFG.USE_RAPIDS`), `has_cupy`, `rapids_used` (set of RAPIDS backends that actually ran:
  "cudf", "cuml_random_forest", "cuml_kmeans"), `xgb_version`, `xgb_device` ("cuda"|"cpu"), `lgbm_device`
  (resolved later, "gpu"|"cpu"), `python`, `platform`. `n_gpus` is the **CUDA runtime** count (torch, else CuPy),
  which honours `CUDA_VISIBLE_DEVICES`; nvidia-smi (filtered by `CUDA_VISIBLE_DEVICES`) is only the fallback.
* Utilities: `log(msg, level="INFO")`, `timer(name)` (context manager, records into `TIMINGS` dict), `free_memory()`,
  `retry(fn, *, tries, base_delay, max_delay, retry_on=(Exception,), on_retry=None)`, `set_seeds(seed)`,
  `save_json(obj, path, *, round_floats=None)` (handles numpy/pandas types, NaN→null), `gpu_mem_report()`,
  `xgb_device_for(gpu_id)` → "cuda:{i}" or "cpu", `gpu_pool_map(fn, items)` (thread pool with one worker per GPU;
  calls `fn(item, gpu_id)`; sequential with gpu_id=0 when ≤1 GPU), `is_oom_error(exc)` (host or GPU OOM),
  `is_gpu_oom_error(exc)` (GPU only — used for every GPU→CPU retry; a host `MemoryError` propagates),
  `pip_install(pkgs, extra_args=())`. `free_memory()` frees the CuPy pool of **every** device.
* `TIMINGS` dict.

### 01_data_acquisition.py produces
* `DATA_MODE` ("gee"|"synthetic"), `DATA_MODE_REASON` (str: why this mode was used, e.g. "LST_RUN_MODE=synthetic",
  "Earth Engine unavailable (…)", "Earth Engine extraction failed: …", "Earth Engine initialised via …"; exported as
  `manifest.data_mode_reason`), `DATA_SOURCES` (dict variable → {year: provenance str}).
* `GRID` — `GridSpec` dataclass: `crs`, `res` (m), `x0` (left edge, m), `y0` (top edge, m), `width`, `height`;
  methods `cell_centers_xy()` → (X, Y) 2-D arrays, `lonlat()` → (LON, LAT) 2-D arrays (pyproj; fallback formula),
  `affine()` → dict for computePixels, `fine(res)` → GridSpec at fine resolution sharing the origin.
* `ROI_MASK` (H,W) bool, `DISTRICT_IDX` (H,W) int16 (−1 outside), `DISTRICTS` list of dicts
  `{"id","name","state"}` exactly as §1.1 (all 25), `BOUNDARY_GEOJSON` (FeatureCollection, one Feature per district
  with properties `id,name,state`, EPSG:4326, simplified to ≤ ~200 m).
* `RAW_STACKS` — `{year: {band: (H,W) float32}}` with bands
  `lst_day_c, lst_obs_count, ndvi, ndwi, ndbi, elevation, slope, aspect_sin, aspect_cos, ntl, pop_density` (NaN = nodata).
* `LC_FINE` — `{year: (H*f, W*f) uint8}` harmonized classes, `f = GRID_RES_M // FINE_RES_M`, 0 outside ROI.
* `SYNTHETIC_TRUTH` — None in gee mode; in synthetic mode a dict describing the planted response
  (e.g. `{"ndvi_saturation": 0.45, "water_cooling_scale": 0.08, ...}`) so section 04 can report recovery.
* `DATA_CAVEATS` — list of caveat strings (static + run-specific, §2) → `manifest.notes`.
* `BOUNDARY_APPROXIMATE` — bool: districts are the §1.2 outline + nearest-HQ partition (synthetic, or GEE fallback).

### 02_features.py produces
* `FEATURES` (ordered list, the model's column order — never reorder):
  `["ndvi","ndwi","ndbi","elevation","slope","aspect_sin","aspect_cos","ntl","log_pop",
    "frac_impervious","frac_forest","frac_water","frac_cropland","frac_barren","lm_pd","lm_ed","lm_contag"]`
* `FEATURE_META` — `{name: {"label","unit","group","description","source","actionable","display"}}`;
  `group ∈ {"spectral","terrain","socioeconomic","landcover","landscape"}`,
  `display ∈ {"index","percent","number"}` (fractions → "percent"). **actionable = the 5 land-cover fractions, the 3
  landscape metrics and NDVI.** NDWI and NDBI are spectral diagnostics (`actionable = false`): they change only through
  land-cover change (coupled scenarios, §4.8), so neither the recommendations nor the dashboard simulator offer them
  as levers. Terrain and socio-economic features are not actionable.
* `DF` — pandas DataFrame, one row per ROI cell × epoch with valid target (`lst_obs_count ≥ CFG.LST_MIN_OBS`). Columns:
  `cell_id` int32 (= row*W+col), `row`, `col` int32, `x`, `y` float64 (UTM m), `lon`, `lat` float64,
  `district` int16 (id, −1 unknown), `year` int16, all `FEATURES` float32 (NaN allowed),
  `pop_density` float32, `lst` float32 (°C), `lst_obs_count` float32, `epoch_mean` float32, `target` float32,
  `spatial_block` int16 (0..24, 5×5 over grid extent), `fold_spatial` int8 (0..4, greedy size-balanced assignment of blocks),
  `fold_random` int8 (0..4), `block10_id` int32 (id of 10×10 km block; used only for the inner early-stopping splits —
  the SHAP block bootstrap derives its own, larger blocks in 04).
* `EPOCH_MEANS` `{year: float}`, `TARGET_COL = "target"`, `FEATURE_STATS` `{name: {min,max,p01,p99,median,mean,std}}` over DF.
* `LM_VALIDATION` dict (pylandstats vs vectorized metrics on a random window sample: max/mean abs diff per metric, n).
Landscape metrics definitions (per window of `LM_WINDOW_CELLS` cells, valid pixels only, ≥50% valid else NaN):
PD = patches / area_ha × 100 (8-connectivity patches, per class, all classes 1–6);
ED = total edge length (m) between different valid classes (4-neighbour, interior only, landscape boundary
not counted) / area_ha  [m/ha];
CONTAG (FRAGSTATS, 4-neighbour double-count adjacency incl. like adjacencies) in %; single-class window → 100.

### 03_models_validation.py produces
* `MODEL_NAMES = ["linear","ridge","random_forest","lightgbm","xgboost","gnn"]`, `SCHEMES = ["random","spatial","temporal"]`.
* `CV_FOLD_METRICS` DataFrame `[scheme, model, fold, r2, rmse, mae, n_train, n_test, fit_seconds, device]`.
* `CV_SUMMARY` DataFrame `[scheme, model, r2_mean, r2_std, rmse_mean, rmse_std, mae_mean, mae_std, n_folds]`.
* `OOF_PRED` `{scheme: {model: np.ndarray(N) float32}}` in target units; NaN where not predicted
  (temporal: only last-epoch rows).
* `MORAN_RESULTS` DataFrame `[scheme, model, year, I, expected_I, z, p]` (residuals of OOF predictions; KNN k=`CFG.MORAN_K`, row-standardized; PySAL `esda.Moran` with permutations, numpy fallback).
* `MORAN_TARGET` DataFrame `[year, I, expected_I, z, p]`.
* `MORAN_SCATTER` `{model: {"year": int, "z": [...], "lag": [...], "slope": float}}` (spatial scheme, last epoch, ≤2000 sampled points).
* `XGB_BEST_ROUNDS` list[int] (spatial-CV folds), `SPATIAL_WEIGHTS` `{year: scipy.sparse.csr_matrix}` (row-standardized KNN).
* Temporal scheme: train on all epochs except the last, test on the last (fold id 0).

### 04_shap_zoning.py produces
* `FINAL_MODEL` (xgboost.Booster, all rows, `FINAL_ROUNDS` = round(1.1 × median(XGB_BEST_ROUNDS))).
* DF new columns: `lst_pred` (°C, final model), `lst_pred_oof` (°C, spatial-CV XGBoost OOF), `resid_oof` (= lst − lst_pred_oof), `zone` int8.
* `SHAP_VALUES` (N,K) float32 (XGBoost native GPU TreeSHAP `pred_contribs`, additivity-checked), `SHAP_BASE` float (target units).
* `SHAP_IMPORTANCE` `{"global": {"mean_abs":[K], "ci_lo":[K], "ci_hi":[K], "bias":[K]}, "by_epoch": {year: {"mean_abs":[K], "mean":[K]}}, "by_zone": {zone: {"mean_abs":[K], "mean":[K]}}}`
  (interval = recentred (bias-corrected) bootstrap percentile interval, §4.4; `bias` = replicate median − full-data
  estimate).
* `INTERACTION_GLOBAL` (K,K) mean |interaction| (diagonal = main effect), `INTERACTION_BY_ZONE` `{zone: (K,K)}`.
* `DEPENDENCE` `{feature: {...}}` exactly as the `dependence.json.gz` entry (§4.4).
* `THRESHOLDS` `{feature: {...}}` exactly as the `threshold` object (§4.4).
* `ZONES` np.int8(N) canonical ids; `ZONE_PROFILES` list (as `zones.json["zones"]`), `ZONE_TRANSITIONS`, `ZONE_DIAGNOSTICS`
  (`k`, `inertia`, `silhouette`, `n_init` — every K incl. 4 fitted with the same `n_init` = 10), `ZONE_SILHOUETTE`
  (the zone fit itself uses 20 initialisations), `ZONE_LABELLING` (`{"rule", "clusters": [{zone, name, raw_cluster, n,
  mean_total_shap, mean_water_shap, mean_frac_water, reason}]}`).
* `RECOMMENDATIONS` `{zone_id: [...]}` (also embedded in ZONE_PROFILES; rule §4.6).
* `SHAP_CI_LATEST` DataFrame (last epoch: `cell_id` + `<f>_lo`, `<f>_hi` per feature) from the block bootstrap
  (bias-corrected percentile intervals re-centred on the final model's per-cell SHAP value).
* `SCENARIO_COUPLING` dict (§4.8), `BOOTSTRAP_INFO` dict (`n`, `n_requested`, `mode`, `block_size_km`, `n_blocks`,
  `block_size_source`, optional `residual_corr_range_km`/`correlogram`, `ci_level` 0.95, `ci_method`
  (`"recentred-percentile"`, §4.4), `ci_method_description`, `ci_label` ("95% CI" when n ≥ 50, else
  "replicate range"), `replicate_range` (bool, n < 50), `rounds`, `eval_rows`, `full_data`, `rows_sampled` (CPU
  path: replicate spreads come from a ≤ 20k-row sample + the last epoch), `devices`, `mean_seconds`, `failures`).
* **Bootstrap blocks**: square blocks of `CFG.BOOT_BLOCK_KM`, or by default the distance at which the pair correlogram
  of the last-epoch spatial-CV XGBoost residuals drops below 0.1, rounded up to 5 km and ≥ `INNER_BLOCK_KM` (shrunk
  in 5 km steps if fewer than 50 blocks would remain). `block10_id` is only used for inner early stopping.

**Zone labelling heuristic** (documented in the notebook, 4.2; canonical ids unchanged):
1. **3 Heat Extreme Core** = the cluster with the highest mean total SHAP (Σ over features);
2. **1 Riparian Buffer** = among the remaining three, the one with the most negative mean
   (SHAP[frac_water] + SHAP[ndwi]); if none of the three has a negative mean, the one with the highest mean frac_water;
3. **0 Ecological Cool Base** = of the remaining two, the one with the lower mean total SHAP;
4. **2 Transition** = the last one.

### 05_export.py produces files (§4) and `EXPORT_MANIFEST` (the manifest dict).

---

## 4. Output files

```
outputs/
├── parquet/features_long.parquet          (DF features, zstd)
├── parquet/predictions_shap.parquet       (ids, year, lst, lst_pred, lst_pred_oof, resid_oof, zone, shap_<f>…)
├── parquet/cv_fold_metrics.parquet, cv_summary.parquet, moran_results.parquet
├── parquet/shap_ci_<lastyear>.parquet
├── npz/shap_interactions_<year>.npz       (float16 N_e×(K+1)×(K+1) + cell_id)
├── geo/ncr_districts.geojson, geo/zones_<year>.geojson (cell squares, props: cell_id, zone, lst, lst_pred)
├── models/xgb_final.json                  (native XGBoost save_model)
├── figures/*.png
├── web/  ← copy to dashboard/public/data/
└── web_bundle.zip                         (.gz members stored, the rest deflated)
```

All web JSON: UTF-8, no NaN/Infinity (→ null), floats rounded (lon/lat 5 dp, °C 2 dp, SHAP 3 dp, features 4 sig. digits).

**Compression (bundle size).** The large files are written **gzip-compressed** (level 9, mtime 0):
`epoch_<year>.json.gz` and `dependence.json.gz`; all other files stay plain JSON. `manifest.files` always names the
files actually written. **Every reader must accept both `.gz` and plain names and decide by content, not by name**:
if the first two bytes are `0x1f 0x8b` the body is gunzipped, otherwise it is read as UTF-8 text. This covers servers
that already sent `Content-Encoding: gzip` (the browser then hands over inflated JSON under a `.gz` name).
Python: `gzip` module (`notebook/validate_bundle.py`, section 5.5); dashboard loader: `fetch` → `ArrayBuffer` →
magic-byte check → `DecompressionStream('gzip')` or `TextDecoder`; dashboard tests: node `zlib`. A 1 km bundle is
≈ 19 MB on disk (≈ 71 MB uncompressed). Size checks use the **on-disk (compressed)** size: the validator warns above
25 MB by default and fails only when a limit is given explicitly (`--max-mb`). The export removes stale bundle files
from earlier exports (e.g. plain `epoch_*.json` next to the new `.json.gz`).

### 4.1 `web/manifest.json`
```json
{
  "schema_version": "1.0",
  "generated_at": "2026-09-27T10:00:00Z",
  "data_mode": "gee | synthetic",
  "data_mode_reason": "LST_RUN_MODE=synthetic",
  "study_area": {"name": "Delhi NCR", "area_km2": 55083.0, "crs": "EPSG:32643", "grid_res_m": 1000,
                 "bbox": [minLon, minLat, maxLon, maxLat], "center": [lon, lat],
                 "boundary_approximate": false, "boundary_source": "WM/geoLab/geoBoundaries/600/ADM2"},
  "epochs": [2010, 2015, 2020, 2025],
  "season": ["04-01", "06-30"],
  "target_mode": "anomaly",
  "epoch_means": {"2010": 39.1, "2015": 38.4, "2020": 37.6, "2025": 39.9},
  "shap_base": 0.0123,
  "features": [{"name": "ndvi", "label": "NDVI", "unit": "", "group": "spectral", "description": "…",
                "source": "…", "actionable": true, "display": "index",
                "stats": {"min": 0, "max": 0, "p01": 0, "p99": 0, "median": 0, "mean": 0, "std": 0}}],
  "zones": [{"id": 0, "name": "Ecological Cool Base", "color": "#34d399"},
            {"id": 1, "name": "Riparian Buffer", "color": "#22d3ee"},
            {"id": 2, "name": "Transition", "color": "#a78bfa"},
            {"id": 3, "name": "Heat Extreme Core", "color": "#fb7185"}],
  "districts": [{"id": 0, "name": "Delhi NCT", "state": "Delhi"}],
  "files": {"epochs": {"2010": "epoch_2010.json.gz"}, "model": "model_web.json", "shap_global": "shap_global.json",
            "dependence": "dependence.json.gz", "zones": "zones.json", "metrics": "metrics.json",
            "districts": "districts.geojson", "interactions": "interactions.json", "coupling": "scenario_coupling.json"},
  "data_sources": {"lst_day_c": {"2010": "MODIS/061/MOD11A2 …"}},
  "synthetic_truth": null,
  "bootstrap": {"n": 100, "n_requested": 100, "mode": "block", "block_size_km": 25.0, "n_blocks": 96,
                "block_size_source": "…", "ci_level": 0.95, "ci_method": "recentred-percentile",
                "ci_method_description": "…", "ci_label": "95% CI", "replicate_range": false, "full_data": true},
  "notes": ["…caveats…"]
}
```
`data_mode_reason` (str|null, from `DATA_MODE_REASON`; the dashboard's synthetic banner explains it),
`study_area.boundary_approximate` (bool) and `boundary_source` (str|null), `shap_base` (SHAP baseline in target units)
and `bootstrap` are part of the contract; readers must tolerate their absence in older bundles and extra keys.
`bootstrap.ci_label` is "95% CI" (≥ 50 replicates) or "replicate range" (fewer; `replicate_range: true`); older
bundles may say "bootstrap range" (same meaning). `bootstrap.ci_method` is a method code: `"recentred-percentile"`
is what the notebook writes (§4.4); readers also know `"basic"`, `"percentile"`, `"bca"`, `"subsampling"` and show an
unknown code verbatim. The dashboard labels every interval accordingly (§4.5).
A demo bundle (`data_mode: "synthetic"`) is committed under `dashboard/public/data/`; it must be labelled SYNTHETIC in
the manifest notes, the UI and the README.

### 4.2 `web/epoch_<year>.json.gz` (gzip; columnar; all arrays length `n`, same order)
```json
{
  "year": 2025, "n": 55012, "cell_size_m": 1000,
  "epoch_mean": 39.9,
  "base_value_c": 39.95,
  "cell_id": [..], "lon": [..], "lat": [..], "district": [..],
  "lst_obs": [..], "lst_pred": [..], "lst_pred_oof": [..], "resid_oof": [..], "zone": [..],
  "features": {"ndvi": [..], "...": [..]},
  "shap": {"ndvi": [..], "...": [..]}
}
```
Invariant: `lst_pred[i] ≈ base_value_c + Σ_f shap[f][i]` (|err| ≤ 0.05 °C after rounding).
`base_value_c = SHAP_BASE + (epoch_mean if target_mode=="anomaly" else 0)`. `features`/`shap` keys = manifest feature order. `lst_pred_oof`/`resid_oof` may contain null.

### 4.3 `web/model_web.json` — compact tree ensemble for in-browser scenario inference
```json
{
  "format": "lst-xgb-compact-v1",
  "objective": "reg:squarederror",
  "target_mode": "anomaly",
  "features": ["ndvi", "..."],
  "base_score": 0.0123,
  "n_trees": 400,
  "trees": [{"f": [0, -1, -1], "t": [0.31, 0, 0], "l": [1, -1, -1], "r": [2, -1, -1], "d": [1, 0, 0], "v": [0, -0.2, 0.3]}],
  "fidelity": {"r2_vs_final": 0.99, "rmse_vs_final": 0.1, "r2_vs_obs": 0.9, "max_depth": 6, "rounds": 400},
  "check": {"rows": [[..K values or null..]], "expected": [..]}
}
```
Semantics: node 0 is the root; node `i` is a leaf iff `l[i] == -1` (then `v[i]` is the leaf value); otherwise go
to `l[i]` if `x[f[i]] < t[i]` (strict), to `r[i]` if `x[f[i]] >= t[i]`, and to `l[i]` if `d[i]==1` else `r[i]` when
`x[f[i]]` is missing (null/NaN). Prediction (target units) = `base_score + Σ_trees leaf`. °C = prediction +
`epoch_mean` in anomaly mode. It is a *surrogate* (max_depth ≤ 6, ≤ 400 rounds) of the final model trained on the
same data; the Python export must verify its own evaluator against `booster.predict(output_margin=True)`
(max abs diff < 1e-3) and embed 50 check rows so the JS evaluator is tested against Python.
Thresholds must be emitted as the exact float32 value (`float(np.float32(t))`, repr precision).

### 4.4 `web/dependence.json.gz` (gzip)
```json
{"features": {"ndvi": {
   "bin_centers": [..40], "mean": [..], "ci_lo": [..], "ci_hi": [..], "count": [..],
   "scatter": {"x": [..≤1500], "shap": [..], "color": [..], "color_feature": "frac_impervious", "zone": [..], "year": [..]},
   "threshold": {"zero_crossing": 0.31, "zero_crossing_ci": [0.29, 0.33], "zero_crossing_support": 0.97,
                 "zero_crossing_flag": null,
                 "breakpoint": 0.42, "breakpoint_ci": [0.40, 0.45], "breakpoint_support": 0.91,
                 "slope_before": -8.1, "slope_after": -1.2,
                 "saturation": 0.55, "saturation_ci": [0.52, 0.58], "saturation_support": 0.88,
                 "effect_range": 4.2, "direction": "cooling | warming | mixed"}
}}}
```
Bins = quantile bins fixed on the full data; `mean` from the final model. `color_feature` = strongest SHAP-interaction
partner. Any threshold may be null.

**Bootstrap intervals (all of §4, and `SHAP_CI_LATEST`)** are *recentred (bias-corrected) percentile intervals*
(`ci_method = "recentred-percentile"`): with θ̂ the full-data (final-model) estimate and θ* the replicate estimates,
`[θ̂ + q2.5(θ*) − median(θ*), θ̂ + q97.5(θ*) − median(θ*)]`. They always contain θ̂. Block-bootstrap refits (≈ 63 % of
the blocks, duplicates as weights) are biased relative to the full-data model, so plain percentile intervals often
excluded θ̂, and so would the basic/pivot interval `[2θ̂ − q97.5, 2θ̂ − q2.5]` (it contains θ̂ exactly when the
percentile interval does). The shift median(θ*) − θ̂ is reported as `bias` where the file has that key. `ci_lo/ci_hi`
are this interval per bin around `mean`. With fewer than 50 replicates the intervals are labelled "replicate range"
(`manifest.bootstrap.ci_label`, `replicate_range`).

Threshold definitions:
* zero_crossing = x where the binned mean curve changes sign (linear interpolation), reported only when there is a
  single sign change or one crossing whose jump |Δ| is ≥ 2× every other one; otherwise null with
  `zero_crossing_flag = "multiple"` (null otherwise; UIs show "multiple crossings" with no value and no interval). Zero means the prediction of the *average cell* (SHAP baseline), not a physical
  threshold — UIs must not narrate it as "flips from heating to cooling" without that qualifier. Replicates use the
  crossing nearest to the full-data one.
* breakpoint = best continuous 2-segment (hinge) least-squares fit over bin centres between the 10th and 90th
  percentile bins (count-weighted); null when it removes < 10 % of the straight-line SSE, when the best hinge is at
  the edge of the candidate range, or when either side has < 5 bins or < 5 % of the row weight.
* saturation = first x after the steepest section where |smoothed slope| drops below 10% of its max and stays below
  for ≥3 bins (refined to the local knee).
* direction from the sign of Spearman ρ(x, SHAP) (|ρ|<0.2 → "mixed").
* `<k>_support` = share of successful replicates that produced the threshold (null when the point is null).
  `<k>_ci` is **null whenever `<k>` is null** and when support < 0.5; thresholds with support < 0.8 are tentative
  and should be flagged in the UI.

### 4.5 `web/shap_global.json`
```json
{"features": [..K], "n_bootstrap": 100, "bootstrap_mode": "block", "ci_label": "95% CI",
 "ci_method": "recentred-percentile",
 "global": {"mean_abs": [..K], "ci_lo": [..K], "ci_hi": [..K], "bias": [..K]},
 "by_epoch": {"2010": {"mean_abs": [..K], "mean": [..K]}},
 "by_zone": {"0": {"mean_abs": [..K], "mean": [..K]}}}
```
**Interval display rules (all views).** An interval is shown only next to an existing point estimate: when the
estimate is null (e.g. a threshold that was not found) its interval is hidden, even if an older bundle carries one,
and `<k>_support` is shown as "found in X % of bootstrap replicates" (flagged as tentative below 0.8). Intervals are
called a **"replicate range"** instead of "95% CI" when fewer than 50 replicates were run (`n_bootstrap` /
`manifest.bootstrap.n` < 50, or `manifest.bootstrap.replicate_range = true`). An estimate lying outside its own
interval (possible only in bundles made with plain percentile intervals) is flagged, not hidden.

### 4.6 `web/zones.json`
```json
{"k": 4, "silhouette": 0.41,
 "diagnostics": {"k": [2,3,4,5,6,7,8], "inertia": [..], "silhouette": [..], "n_init": 10},
 "labelling": {"rule": "…", "clusters": [{"zone": 0, "name": "Ecological Cool Base", "raw_cluster": 2, "n": 1234,
               "mean_total_shap": -0.8, "mean_water_shap": -0.1, "mean_frac_water": 0.01, "reason": "…"}]},
 "zones": [{"id": 0, "name": "Ecological Cool Base", "color": "#34d399", "description": "…",
            "n_cells": {"2010": 0}, "area_km2": {"2010": 0.0}, "lst_obs_mean": {"2010": 0.0}, "lst_pred_mean": {"2010": 0.0},
            "feature_means": {"ndvi": 0.0}, "shap_means": {"ndvi": 0.0},
            "top_warming": [{"feature": "ndbi", "shap": 1.2}], "top_cooling": [{"feature": "ndvi", "shap": -1.1}],
            "top_interactions": [{"a": "ndvi", "b": "frac_impervious", "value": 0.3}],
            "top_districts": [{"district": 1, "name": "Gurugram", "share": 0.21}],
            "recommendations": [{"feature": "frac_forest", "action": "increase", "current": 0.02, "target": 0.22,
                                 "expected_delta_c": -0.43, "ci": [-0.51, -0.37], "priority": "medium",
                                 "rationale": "In the final model, raising tree cover by 20 percentage points … is associated with a mean LST change of -0.43 °C … (95% CI -0.51 to -0.37 °C) …",
                                 "kind": "bound", "step": 0.2, "n_cells": 5123, "coupled": true, "bias": 0.012}]}],
 "transitions": {"2010->2015": [[4×4 counts, rows=from zone, cols=to zone]]}}
```
`transitions` has one matrix per **consecutive** epoch pair (`"<y_i>-><y_i+1>"`), counting the cells present in both
epochs; `labelling` documents the zone-name heuristic (§3).

**Recommendation rule (plausible interventions, model counterfactuals):**
* **Levers** = the 5 land-cover fractions, NDVI and the 3 landscape metrics (never NDWI/NDBI). Allowed directions:
  `frac_impervious`, `frac_barren` decrease only; `frac_forest`, `frac_water` increase only; `frac_cropland` and the
  landscape metrics either way; NDVI increase only, and not in zones whose median `frac_water` > 0.15.
* **Current** = the zone's median of the feature over its last-epoch cells (all epochs if < 10 cells).
* **Feasibility**: the target may not go beyond the zone's own **90th percentile** (increase) / **10th percentile**
  (decrease) of that feature, and |target − current| ≤ **0.20** for fractions and ≤ **0.15** for NDVI (physical
  ranges also apply: fractions [0, 1], NDVI [−1, 1], CONTAG [0, 100], PD/ED ≥ 0).
* **Counterfactual**: every cell of the zone is shifted by `step = target − current`. Fraction changes are
  compositional exactly as in the dashboard (§4.8, other vegetation included as donor/recipient, coupled indices
  shifted by the coupling slopes); NDVI and landscape metrics are shifted directly. Expected Δ = mean over the zone's
  applicable cells of (final-model prediction after − before), in °C — a model-based ceteris-paribus (ICE) estimate.
* **Target choice**: candidates = the breakpoint and saturation (when strictly inside the feasible range) and 25/50/
  75/100 % of the way to the feasibility bound; the recommended target is the **smallest step achieving ≥ 90 % of the
  best Δ** among the candidates (`kind` = "saturation" | "breakpoint" | "partial" | "bound").
* **Interval**: the identical counterfactual is re-evaluated with every bootstrap replicate model; `ci` is the
  bias-corrected percentile interval (always contains `expected_delta_c`), `bias` = replicate median − estimate.
* Keep Δ < −0.05 °C, one action per feature (best direction), sort by Δ, top 4 per zone; priority high (≤ −1 °C),
  medium (≤ −0.3), low otherwise.
* **Rationale** must say the change "is associated with" the cooling (SHAP and model counterfactuals are not causal)
  and quote the interval with its label ("95% CI" / "replicate range"). Numbers in the sentence are formatted from
  the exported (4 significant digit) `current`/`target`/`step` with round-half-up, like the dashboard, so the text and
  the table never disagree on a tie (0.0275 → "2.8%").
* Extra keys: `kind`, `step`, `n_cells`, `coupled` (fractions: indices follow the coupling), `bias`.

### 4.7 `web/metrics.json`
```json
{"schemes": ["random","spatial","temporal"], "models": ["linear","ridge","random_forest","lightgbm","xgboost","gnn"],
 "summary": [{"scheme": "spatial", "model": "xgboost", "r2_mean": 0, "r2_std": 0, "rmse_mean": 0, "rmse_std": 0, "mae_mean": 0, "mae_std": 0, "n_folds": 5}],
 "folds": [{"scheme": "spatial", "model": "xgboost", "fold": 0, "r2": 0, "rmse": 0, "mae": 0, "n_train": 0, "n_test": 0, "fit_seconds": 0, "device": "cuda:0"}],
 "moran": [{"scheme": "spatial", "model": "xgboost", "year": 2025, "I": 0, "expected_I": 0, "z": 0, "p": 0}],
 "moran_target": [{"year": 2025, "I": 0, "expected_I": 0, "z": 0, "p": 0}],
 "moran_scatter": {"xgboost": {"year": 2025, "z": [..], "lag": [..], "slope": 0}},
 "hardware": {"gpus": ["Tesla T4","Tesla T4"], "xgb_device": "cuda", "lgbm_device": "gpu", "rapids": false,
              "rapids_used": [], "n_gpus": 2, "xgb_version": "3.0.2", "python": "3.11.13", "platform": "Linux-…"},
 "timings": {"stage": 12.3},
 "bootstrap": {"n": 100, "n_requested": 100, "mode": "block", "block_size_km": 25.0, "n_blocks": 96, "rounds": 900,
               "ci_level": 0.95, "ci_method": "recentred-percentile", "ci_label": "95% CI", "replicate_range": false,
               "eval_rows": 264000, "full_data": true, "rows_sampled": false, "devices": ["cuda:0","cuda:1"],
               "mean_seconds": 58.1}}
```
`hardware.rapids` is true only when a RAPIDS backend actually ran; `rapids_used` names them ("cudf",
"cuml_random_forest", "cuml_kmeans"; the notebook writes a list, readers also accept `{component: bool}`). `hardware.n_gpus`,
`xgb_version`, `python`, `platform` and the `bootstrap` object (BOOTSTRAP_INFO without `failures`) are part of the
contract; readers must tolerate extra keys.

### 4.8 other web files
* `interactions.json`: `{"features": [..K], "global": [[K×K]], "by_zone": {"0": [[K×K]]}}`.
* `scenario_coupling.json`: `{"description": "…", "fraction_features": ["frac_impervious","frac_forest","frac_water","frac_cropland","frac_barren"],
  "coupling": {"frac_forest": {"ndvi": 0.45, "ndwi": -0.1, "ndbi": -0.2}, …}}` — partial slopes (d index / d fraction) from an
  OLS of each spectral index on all 5 fractions (other vegetation = omitted reference class). Scenario rule: the
  donors/recipients of a fraction change are the other four fractions **and the implicit other-vegetation share
  `1 − Σ fractions`** (class 6: grass/shrub/wetland). Adding Δ is capped by the land they can give up and subtracts
  it from them proportionally to their current values; removing Δ (capped at the current value) gives the freed land
  to them in the same proportions (equally when all are 0); sum preserved, clamp [0,1]; other vegetation has no model
  column. In coupled mode each spectral index shifts by Σ slope×(actual Δ of each of the five fractions), clamped to
  [−1, 1] (the slopes are relative to other vegetation, so no slope for it is needed). The simulator offers only
  actionable features (NDWI/NDBI change only through this coupling); landscape metrics and non-actionable features
  stay fixed in a fraction scenario. The notebook's recommendation counterfactuals (§4.6) use exactly this rule.
  Because the change actually applied can be smaller than requested (a cell with 0 % tree cover cannot lose 20 pp;
  a cell with no land to give cannot gain), the scenario engine records the applied change per cell and its
  headline **statistics cover only the cells that actually changed**; it also reports the region, applicable and
  changed cell counts, the requested and mean applied change, and the region mean with unchanged cells counted as 0.
* `districts.geojson`: FeatureCollection, properties `{id, name, state}`.

---

## 5. Dashboard architecture (React 18 + Vite 5, JavaScript/JSX, Tailwind 3.4)

Data base URL: `import.meta.env.VITE_DATA_BASE_URL ?? \`${import.meta.env.BASE_URL}data\``. If `manifest.json`
is missing → an instructive empty state (how to run the notebook and copy `outputs/web/*` to `dashboard/public/data/`).
If `manifest.data_mode === "synthetic"` → persistent, clearly visible "SYNTHETIC DEMO DATA" badge/banner.

### 5.1 Shared modules (owned by the scaffold builder; other builders import, never redefine)
* `src/lib/cn.js` — `cn(...classes)` (clsx + tailwind-merge).
* `src/lib/data.js` — `getDataBaseUrl()`, `loadManifest()`, `loadAsset(manifest, key)`, `loadEpoch(manifest, year)` (cached).
  Every file is fetched as an `ArrayBuffer`; bodies starting with the gzip magic bytes `0x1f 0x8b` are inflated with
  `DecompressionStream('gzip')`, anything else is decoded as UTF-8 (§4 compression).
* `src/lib/model.js` — `compileModel(modelJson)` → `{features, baseScore, nTrees, predictRow(values: ArrayLike<number|null>) → number, predictMany(getValue: (featureIdx, i) => number|null, indices: Int32Array|number[]) → Float64Array}`.
* `src/lib/scenario.js` — `runScenario({epoch, model, coupling, manifest, scenario})` where
  `scenario = {feature, delta, region: {type: "all"|"district"|"zone", ids: number[]}, coupled: boolean}` →
  `{indices, baseline, scenario, delta, applied` (changed cells only; baseline/scenario in °C), `applicableIndices, stats: {count, areaKm2, mean, min, max, p10, p50, p90, baselineMeanC, scenarioMeanC, changedCount, applicableCount, regionCount, requested, meanApplied, regionMean, regionAreaKm2}` (headline values over the changed cells, §4.8), `byDistrict: [{id, name, count, mean}], histogram: [{x0, x1, count}], deltaByCell: Float32Array(n)` (ΔLST for applicable region cells, 0 where nothing could change, NaN elsewhere), `changedFeatures, regionCount, coupledApplied, epochYear}`;
  also `findDistrictId(districts, aliasOrName)` and `SCENARIO_PRESETS` (≥3 presets incl. "+20% tree canopy in Gurugram" = frac_forest +0.20 district Gurugram, "+10% impervious surface in Noida" = frac_impervious +0.10 district 17, and a wetland/water preset whose zone is resolved at runtime as the most water-rich zone of the bundle, never a hard-coded zone id). Only actionable features are offered.
* `src/lib/colors.js` — `THEME` tokens, `ZONE_COLORS` (fallback), `sequentialScale(domain)` (LST, thermal ramp) and `divergingScale(maxAbs)` (cool cyan ↔ warm rose; neutral midpoint) returning `(v) => [r,g,b,a]`, `hexToRgb`, `categoricalPalette` (≥17 colours for dominant-driver map), `rgbToCss`.
* `src/lib/format.js` — `fmt(n, dp)`, `fmtC(n)`, `fmtSigned(n, dp)`, `fmtPct(frac)`, `fmtFeatureValue(meta, v)`, `featureLabel(manifest, name)`.
* `src/lib/validate.js` — `validateBundle({manifest, epochs, model, dependence, zones, metrics, shapGlobal})` → `{ok, errors[], warnings[]}` enforcing §4 (incl. waterfall invariant on a sample).
* `src/state/DataContext.jsx` — `<DataProvider>` + `useData()` returning
  `{status: "loading"|"ready"|"empty"|"error", error, manifest, features (manifest.features), featureIndex (name→idx), districts, zonesMeta,
    year, setYear, epoch (current epoch object | null), epochLoading, getEpoch(year) (Promise),
    shapGlobal, dependence, zones, metrics, districtsGeo, interactions, coupling, model (compiled), modelRaw,
    view, setView ("twin"|"thresholds"|"zones"|"performance"),
    mapLayer, setMapLayer ("lst_obs"|"lst_pred"|"resid_oof"|"shap"|"driver"|"zones"|"scenario"),
    shapFeature, setShapFeature, selectedCell, setSelectedCell (index into epoch arrays | null),
    scenario, setScenario, scenarioResult (memoized/debounced runScenario on the current epoch), validation}`.
* `src/components/ui/*.jsx` — shadcn-style primitives (JSX): `GlassPanel`, `Button`, `Badge`, `Slider` (Radix), `Tabs` (Radix), `Switch` (Radix), `Select` (styled native), `StatTile`, `SectionHeader`, `Skeleton`, `InfoTip`.

### 5.2 Views (each a default-exported component with NO required props; reads `useData()`)
* `src/components/MapContainer.jsx` — deck.gl 9 + react-map-gl/maplibre (CARTO dark-matter basemap, no token).
  3-D extruded square cells (`ColumnLayer`, `diskResolution: 4`, `angle: 45`, radius = `cell_size_m/√2·coverage`),
  layer switcher (Raw LST, Predicted LST, Residuals (OOF), SHAP [feature], Dominant driver, Governance zones, Scenario Δ),
  H3 hexagon aggregation toggle (`H3HexagonLayer` + h3-js), district outlines (`GeoJsonLayer`), legend, hover tooltip with
  per-cell SHAP waterfall (base → top drivers → others → prediction), click to pin a cell.
* `src/components/ShapDependenceViewer.jsx` — feature picker, global importance with CIs (click selects), dependence scatter
  + binned mean + 95% CI band + threshold reference lines, threshold cards, **scenario simulator** (feature, Δ slider, region
  district/zone/all, coupled toggle, presets) using `scenarioResult`; "Show on map" → `setMapLayer("scenario")`, `setView("twin")`.
* `src/components/GovernanceZoning.jsx` — four side-by-side zone cards (area/share, LST, trend across epochs, SHAP signature,
  drivers, interactions, districts, recommendations with expected Δ and CI), transition matrix between epochs, K diagnostics.
* `src/components/ModelPerformance.jsx` — KPI tiles, R²/RMSE/MAE by model×scheme (error bars), TanStack sortable table,
  per-fold dots, Moran's I of residuals by model/year, Moran scatter (z vs spatial lag + slope line), hardware/timings.
* `src/App.jsx` — shell: animated grid-glow background, glass header (title, epoch selector, data-mode badge, validation
  status), nav rail/tabs for the 4 views, Framer Motion transitions, loading/empty/error states.
* `src/index.css` — Tailwind layers + theme: background `#090d16`, glass panels `#1e293b` @ ~55–70% + backdrop blur,
  accents cyan `#22d3ee`, violet `#a78bfa`, emerald `#34d399`, warm rose `#fb7185`; grid-glow overlay; focus rings.
