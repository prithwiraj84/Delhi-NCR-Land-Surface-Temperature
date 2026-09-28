# Delhi NCR Land Surface Temperature × Explainable AI

A reproducible pipeline and dashboard for the **pre-monsoon (April–June) daytime land surface
temperature (LST)** of the Delhi National Capital Region (25 districts, ~55,000 km²) at four epochs:
**2010, 2015, 2020 and 2025**.

- **Kaggle GPU notebook** (`delhi_ncr_lst_pipeline.ipynb`):
  1. extracts satellite predictors from Google Earth Engine onto a 1 km UTM grid;
  2. trains one pooled XGBoost model on CUDA and benchmarks it against linear, ridge, random-forest,
     LightGBM and graph-neural-network baselines;
  3. scores every model under **random, spatial-block and temporal** cross-validation, with Moran's I
     of the residuals;
  4. explains the model with exact GPU **TreeSHAP**, interaction values and a spatial block bootstrap,
     and detects non-linear thresholds;
  5. clusters the SHAP vectors into four **governance zones** (Ecological Cool Base, Riparian Buffer,
     Transition, Heat Extreme Core) with feasible, model-evaluated cooling recommendations;
  6. exports everything as Parquet / GeoJSON / NPZ files and a compact **web bundle**.
- **React dashboard** (`dashboard/`) reads that bundle and offers four views:
  - a 3-D deck.gl digital twin with a per-cell SHAP waterfall;
  - a Threshold Explorer with dependence curves, an interaction matrix and an in-browser what-if
    scenario simulator;
  - governance zoning and the policy engine;
  - model performance and spatial cross-validation.

> **The demo bundle shipped in `dashboard/public/data/` is SYNTHETIC.**
>
> It was produced by `notebook/run_local.py` in synthetic mode: a simulated Delhi NCR with a planted,
> known temperature response, on a 2 km grid with 20 bootstrap replicates. It shows how the pipeline and
> dashboard work. It is **not** a finding about the real region.
>
> - The dashboard says so on every page (the "SYNTHETIC DEMO DATA" badge and banner).
> - The manifest records `data_mode: "synthetic"` and a SYNTHETIC caveat in `notes`.
> - Real results need an Earth Engine run on Kaggle (below).
> - The bundle is committed with the repository (≈ 6 MB, the large files gzip-compressed), so a fresh clone
>   shows the dashboard immediately. Replace it with your own bundle for real results.

---

## Architecture

```
 ┌────────────────────────────── Kaggle notebook (GPU T4 x2) ──────────────────────────────┐
 │                                                                                          │
 │  00 setup ──► 01 data acquisition ──► 02 features ──► 03 models & CV ──► 04 SHAP & zones │
 │  CFG / ENV     GEE computePixels        LC fractions     linear/ridge/RF     final XGBoost│
 │  GPU detect    (tiled, cached,          PD / ED / CONTAG LightGBM/XGBoost    GPU TreeSHAP │
 │  utilities     retried) or synthetic    feature table    GNN; random /       interactions │
 │                twin with planted truth  CV folds         spatial / temporal  block boot-  │
 │                                                          CV; Moran's I       strap, thres-│
 │                                                                              holds, K-means│
 │                                                                              zones, recs  │
 │                                              05 export ◄──────────────────────────┘       │
 │                                                  │                                        │
 └──────────────────────────────────────────────────┼────────────────────────────────────────┘
                                                    ▼
      outputs/ ── parquet/  geo/  npz/  models/  figures/  web/  web_bundle.zip
                                                     │
                     copy outputs/web/* (or unzip)   │   or host anywhere + VITE_DATA_BASE_URL
                                                     ▼
 ┌──────────────────────── dashboard/ (React 18 + Vite 5 + deck.gl 9 + Tailwind) ───────────┐
 │  lib/data.js ── loads manifest.json → epochs, model_web.json, shap_global.json, …        │
 │  lib/validate.js ── re-checks the SPEC §4 contract in the browser ("CONTRACT OK" badge)   │
 │  lib/model.js ── compiles the compact tree ensemble → scenario inference in the browser  │
 │                                                                                           │
 │  Digital Twin (map) │ Threshold Explorer │ Governance Zones │ Model Performance           │
 └───────────────────────────────────────────────────────────────────────────────────────────┘
```

The notebook is **built** from plain Python sources in `notebook/sections/*.py` (jupytext "percent"
format). The same sources run as one script through `notebook/run_local.py`, so local smoke tests
exercise exactly the code Kaggle runs.

```
LST replication study/
├── delhi_ncr_lst_pipeline.ipynb   # BUILT artefact: python notebook/build_notebook.py
├── notebook/
│   ├── sections/00_setup.py … 05_export.py
│   ├── build_notebook.py          # sections -> .ipynb (--check compiles every code cell)
│   ├── run_local.py               # run all sections as one script (local smoke test)
│   └── validate_bundle.py         # SPEC §4 validator for a web bundle
├── dashboard/                     # React dashboard; public/data/ = web bundle (committed SYNTHETIC demo)
└── docs/SPEC.md                   # binding architecture & data contract
```

---

## Kaggle quick start (real data)

1. Create a Kaggle notebook from `delhi_ncr_lst_pipeline.ipynb` (*File → Import notebook*).
2. **Settings:**
   - **Accelerator → GPU T4 x2**
   - **Internet → On**
3. **Add-ons → Secrets.** Attach both of these to the notebook:
   - `GEE_SERVICE_ACCOUNT_KEY`: the *full JSON key* of a Google Cloud service account registered for
     Earth Engine. The Earth Engine API must be enabled on the project, and the account needs Earth
     Engine access.
   - `GEE_PROJECT`: the Cloud project id used for Earth Engine quota.

   Without a key, an *interactive* session can authenticate with the `ee.Authenticate` prompt instead.
   A committed (batch) run needs the secret.
4. **Run All.** Missing packages (`earthengine-api`, `pylandstats`, `libpysal`, `esda`, …) are
   pip-installed automatically on Kaggle.
5. Download `outputs/web_bundle.zip` from the notebook's **Output** tab (see
   [Dashboard](#dashboard-dev-build-deploy)).

### Run modes and overrides

Everything is optional. Set these as environment variables, e.g. in a first cell with
`os.environ[...] = ...` before section 00 runs, or on the command line for local runs.

| Variable | Values / default | Effect |
|---|---|---|
| `LST_RUN_MODE` | `auto` (default) · `gee` · `synthetic` | See the three modes below |
| `LST_FAST_DEV` | `0` / `1` | Shrinks every loop (boosting rounds, bootstrap, permutations, GNN epochs) for smoke tests |
| `LST_GRID_RES_M` | `1000` | Analysis cell size (m) |
| `LST_FINE_RES_M` | 25 (gee) / 100 (synthetic) | Land-cover resolution (m); must divide the cell size |
| `LST_N_BOOTSTRAP` | `100` (FAST_DEV: 8) | Block-bootstrap replicates for SHAP / threshold confidence intervals |
| `LST_TARGET_MODE` | `anomaly` (default) · `absolute` | Target = LST minus the epoch's spatial mean, or raw °C |
| `LST_GEE_PROJECT` | – | Earth Engine Cloud project (otherwise the Kaggle secret `GEE_PROJECT`) |
| `LST_GEE_SERVICE_ACCOUNT_KEY` / `GOOGLE_APPLICATION_CREDENTIALS` | JSON text / path | Service-account key outside Kaggle |
| `LST_GEE_WORKERS` | `6` | Parallel `computePixels` requests |
| `LST_OUTPUT_DIR` | `/kaggle/working/outputs` or `./outputs` | Output root |
| `LST_USE_RAPIDS` | `0` | Use cuDF/cuML (GPU dataframe assembly, cuML random forest and K-means) when importable. Off by default: these paths are not yet validated, and Kaggle's GPU image ships RAPIDS preinstalled, so without this switch they are ignored |
| `LST_INSTALL_RAPIDS` | `0` | Install cuDF/cuML from pypi.nvidia.com (several minutes) in section 0.1, **before** numpy is imported, constrained to the installed numpy/pandas; implies `LST_USE_RAPIDS`. If the install changes numpy/pandas the notebook stops and asks for a kernel restart |
| `LST_RAPIDS_VERSION` | – | Pin the RAPIDS release for `LST_INSTALL_RAPIDS`, e.g. `25.2.*` |
| `LST_BOOT_BLOCK_KM` | auto | Block size of the SHAP block bootstrap; default = where the residual correlogram of the spatial-CV XGBoost drops below 0.1 (≥ 10 km, ≥ 50 blocks) |
| `LST_LST_MIN_OBS` | `3` | Minimum valid 8-day MODIS composites for a cell's seasonal LST; fewer → no target |
| `LST_ALLOW_PIP` | `0` | Allow automatic pip installs outside Kaggle |
| `LST_GNN_CPU_BUDGET_S` | `900` | Wall-clock budget (s) per GNN fold when no CUDA GPU exists (CPU fallback only) |

`LST_RUN_MODE` values:

- **`auto`** (default): tries Earth Engine and falls back to the synthetic twin with a loud banner when Earth
  Engine cannot be initialised. If a service-account key *was* supplied and Earth Engine initialised, a failure
  during extraction stops the run instead (re-running resumes from the tile cache).
- **`gee`**: stops with an error if Earth Engine is unavailable.
- **`synthetic`**: never contacts Earth Engine.

The reason for the mode actually used (for example `LST_RUN_MODE=synthetic`, or the Earth Engine error that
triggered the fallback) is exported as `manifest.data_mode_reason` and shown in the dashboard's synthetic banner.

### Expected runtime on 2× T4 (1 km grid)

These figures are extrapolated from a measured local run: 91 min on a GTX 1650 with a 4-core CPU, using
10 bootstrap replicates and a capped CPU GNN.

| Stage | Expected time |
|---|---|
| Earth Engine extraction | 15–45 min on the first run; re-runs reuse the tile cache under `outputs/cache/` |
| Triple CV | ~30–40 min, dominated by the CPU random forest and LightGBM on Kaggle's 4 vCPUs (`LST_USE_RAPIDS=1` moves the forest to cuML, not yet validated) |
| Interaction values | ~10 min |
| Default 100-replicate bootstrap | ~50 min |
| **Total** | **≈ 1.3–2 h** |

`LST_N_BOOTSTRAP` trades confidence-interval precision for time.

---

## Local synthetic smoke run

No Earth Engine account or GPU is needed. With XGBoost on CPU the pipeline is slower but complete.

```bash
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install numpy pandas scipy scikit-learn xgboost lightgbm shap torch libpysal esda \
            pylandstats shapely pyproj pyarrow matplotlib nbformat
export PYTHONIOENCODING=utf-8                          # Windows consoles default to cp1252

# 2 km grid, FAST_DEV: every section in ~15 min on a laptop (923 s measured)
python notebook/run_local.py --out outputs

# the dashboard demo bundle: 2 km, 20 bootstrap replicates (784 s measured)
python notebook/run_local.py --grid-res 2000 --bootstrap 20 --out outputs_demo

# full-size synthetic run: 1 km, non-FAST (91 min measured with 10 replicates and GNN capped at 120 s/fold)
LST_GNN_CPU_BUDGET_S=120 python notebook/run_local.py --grid-res 1000 --no-fast-dev --bootstrap 10 --out outputs_full

# stop early, e.g. after the feature table
python notebook/run_local.py --until 02
```

`run_local.py` options:

| Option | Default | Meaning |
|---|---|---|
| `--mode` | `synthetic` | `synthetic`, `gee` or `auto` |
| `--grid-res` | `2000` | Cell size in metres |
| `--fine-res` | – | Land-cover resolution in metres |
| `--no-fast-dev` | off | Turn FAST_DEV off |
| `--bootstrap N` | – | Number of bootstrap replicates |
| `--out DIR` | – | Output directory |
| `--until NN` | – | Last section prefix to run |

The script prints `ALL SECTIONS OK` and exits 0 on success.

The synthetic generator plants a known response, for example an NDVI cooling saturation at 0.28. Section
04 reports how well the model recovers it (`manifest.synthetic_truth`).

Checks worth running after editing anything:

```bash
python notebook/validate_bundle.py outputs/web            # SPEC §4 contract (warns above 25 MB on disk; --max-mb N = hard limit)
python notebook/build_notebook.py --check                 # rebuild the .ipynb, compile every code cell
cd dashboard && npm run lint && npm test                  # includes real-bundle tests on public/data
LST_BUNDLE_DIR=../outputs/web npm test                    # same tests against another bundle
```

---

## Outputs

```
outputs/
├── parquet/features_long.parquet        feature table (one row per cell × epoch, zstd)
├── parquet/predictions_shap.parquet     lst, lst_pred, lst_pred_oof, resid_oof, zone, shap_<feature>…
├── parquet/cv_fold_metrics.parquet, cv_summary.parquet, moran_results.parquet
├── parquet/shap_ci_<lastyear>.parquet   per-cell bootstrap SHAP intervals, last epoch
├── npz/shap_interactions_<year>.npz     float16 interaction tensors + cell_id
├── geo/ncr_districts.geojson, geo/zones_<year>.geojson
├── models/xgb_final.json                native XGBoost model
├── figures/*.png                        every figure shown in the notebook
├── cache/                               Earth Engine tile cache (makes re-runs resumable)
├── web/                                 dashboard bundle  → copy to dashboard/public/data/
└── web_bundle.zip                       the same bundle zipped for download
```

The web bundle contains the following files. Their schemas are in `docs/SPEC.md` §4. The two large kinds are
gzip-compressed on disk; every reader (validator, dashboard, tests) detects gzip by its magic bytes, so plain and
`.gz` names both work, including servers that already send `Content-Encoding: gzip`.

- `manifest.json`
- `epoch_<year>.json.gz`
- `model_web.json`
- `shap_global.json`
- `dependence.json.gz`
- `zones.json`
- `metrics.json`
- `interactions.json`
- `scenario_coupling.json`
- `districts.geojson`

---

## Dashboard: dev, build, deploy

Requires Node 18+ (developed on Node 22).

```bash
cd dashboard
npm ci                      # or npm install
npm run dev                 # http://localhost:5173
npm run lint && npm test    # ESLint + Vitest (117 tests)
npm run build               # static site in dashboard/dist/
npx vite preview            # serve the production build locally (http://localhost:4173)
```

**Loading a bundle.** Copy the *contents* of `outputs/web/` into `dashboard/public/data/`, or unzip
`web_bundle.zip` there, so that `dashboard/public/data/manifest.json` exists. Keep `.gitkeep`. Delete the old files
first (`rm dashboard/public/data/*.json*`) so no stale file from an older bundle remains.

```bash
cp outputs/web/* dashboard/public/data/
```

Without a bundle, every view shows an empty state that explains these steps.

**Hosting the bundle elsewhere.** Put the bundle on any static host or bucket. It must send CORS headers
if it is on another origin. Then build with its URL:

```bash
VITE_DATA_BASE_URL=https://example.org/lst-bundle npm run build
```

The default base URL is `${BASE_URL}data`, i.e. `public/data` next to the app. `dashboard/.env.example`
lists the variable.

**Deploying.** `dist/` is a plain static site and works on any static host (GitHub Pages, Netlify,
S3, nginx). Two things to know:

- For a sub-path deployment, build with `npx vite build --base /my/sub/path/`.
- The dashboard uses hash routing (`#twin`, `#thresholds`, `#zones`, `#performance`), so no server
  rewrites are needed.

**Bundle size.**

| Bundle | Cells | On disk (gzip) | Uncompressed |
|---|---|---|---|
| 2 km demo | 16.5k per epoch | ~6 MB | ~20 MB |
| 1 km | ~55k per epoch | ~19 MB | ~71 MB |

`validate_bundle.py` checks the on-disk (compressed) size: it warns above 25 MB by default and fails only
when you pass an explicit `--max-mb`. A 1 km bundle works from a normal static host.

---

## Data contract

`docs/SPEC.md` is the single source of truth for everything the notebook and the dashboard share:

- study design;
- data sources and processing;
- the inter-section Python globals;
- every output file, JSON key and column;
- the dashboard module API.

Change the SPEC first, then both sides.

Two tools check a bundle against it:

- `notebook/validate_bundle.py` (Python);
- `dashboard/src/lib/validate.js`, which runs in the browser and drives the "CONTRACT OK" badge.

The compact web model embeds 50 check rows. The JavaScript tree evaluator is tested against them to
within 1e-4 of the Python predictions.

---

## Scientific caveats

These are exported in `manifest.notes` and shown in the dashboard.

**Land cover comes from different products per epoch.**
- 2010 and 2015: GLC_FCS30D.
- 2020: ESA WorldCover.
- 2025: Dynamic World (annual mode).
- Classes are harmonised to 6 classes, but definitions and accuracies differ. Part of any apparent
  land-cover change is product inconsistency, not change on the ground.

**Night-time lights.**
- DMSP-OLS (2010) saturates in urban cores and has no on-board calibration: the gain of the same satellite
  drifts between years.
- 2010 DN are therefore first **intercalibrated to F18 2013** with a robust quadratic fit on pseudo-invariant
  pixels (lit and unsaturated in both years; the 20 % worst-fitting pixels, i.e. real change, are trimmed).
- F18 2013 DN are then mapped into VIIRS log-radiance space with an isotonic regression fitted inside the ROI
  on **DMSP F18 2013 vs VIIRS 2014** (VCMSLCFG monthly composites start in January 2014, so this is a
  one-year offset, not a true overlap; real lighting change in that year leaks into the mapping).
- VIIRS annual medians use only months with cloud-free coverage (`cf_cvg > 0`).
- Both steps are approximate: differences between 2010 and later epochs in bright cores should not be
  over-read. `manifest.data_sources` records the years and fit quality actually used.

**MODIS LST quality.** A cell's seasonal LST needs ≥ 3 valid 8-day composites and ≥ 50 % valid area;
otherwise it has no target.

**District boundaries.** geoBoundaries (fallback FAO GAUL) ADM2 polygons are matched by name; a district
left unmatched is then located by its HQ point (e.g. geoBoundaries spells Shamli "Samli"). If both layers
fail, districts fall back to an approximate outline with nearest-HQ districts, a caveat is added and
`manifest.study_area.boundary_approximate` is true.

**Terra orbit drift after 2022.** MODIS Terra's overpass drifts earlier after 2022. This biases 2025 day
LST slightly low relative to earlier epochs. The anomaly target removes the epoch-wide offset, but not
any spatially varying part.

**GHS-POP 2025 is a model projection.** It is rescaled to the WorldPop 2020 ROI total. It is not a
census estimate.

**One pooled model and an anomaly target.**
- The target is LST minus each epoch's spatial mean, and one model is fitted across all epochs, with no
  `year` feature.
- Temporal CV therefore measures how well the *spatial pattern* transfers to an unseen year. It does not
  measure prediction of the climate offset.
- Because of this design, a region that warms over time can be learned through predictors that drift
  over time, such as night lights. This can flip the apparent direction of weak drivers.

**SHAP explains the model, not causation.**
- A SHAP value says how far a feature's *current value* pushes the prediction above or below the average
  cell's (a level), not how much the prediction would change if the feature moved. Thresholds are read off
  the marginal SHAP dependence curves; a zero crossing is relative to the average cell.
- **Recommendations are plausible interventions evaluated with the final model**, per zone: the five
  land-cover fractions, NDVI and the three landscape metrics are the only levers (NDWI and NDBI are spectral
  diagnostics that move only through land-cover change). Each cell of the zone is shifted by the same
  feasible step (at most to the zone's own 90th/10th percentile; ≤ 20 percentage points for a fraction,
  ≤ 0.15 NDVI), land-cover changes are compositional (the land comes from, or goes to, the other covers
  including grass/shrub, and NDVI/NDWI/NDBI follow through the fitted coupling), and the expected ΔLST is the
  mean change of the model's prediction. The rationale says the change "is associated with" the cooling and
  quotes the interval. It is a model-based ceteris-paribus estimate, not a causal effect.
- The effects of several actions are not additive.

**Bootstrap intervals.** Block-bootstrap refits (blocks sized from the residual correlogram) are biased
relative to the full-data model, so every interval is a bias-corrected percentile interval re-centred on
the full-data estimate (`ci_method: "recentred-percentile"`; it always contains the estimate, and the bias is
exported next to it). With fewer than 50 replicates the interval is labelled "replicate range", not "95% CI".
An interval is only shown next to an existing estimate; a threshold found by fewer than 80 % of the replicates
is flagged as tentative, and a curve with several comparable zero crossings reports "multiple crossings"
instead of a value.

**The web model is a surrogate.**
- In-browser scenarios run on a depth-≤6, ≤400-round XGBoost surrogate of the final model, not the
  final model itself. `model_web.json → fidelity` records the agreement: R² 0.999 against the final
  model in the demo bundle.
- Baseline and scenario use the same surrogate, so most of its error cancels in Δ.
- A land-cover scenario takes land from, or gives it to, the other covers including the implicit "other
  vegetation" share (grass/shrub). A cell can receive less than the requested change (it cannot lose tree cover
  it does not have), so the scenario statistics cover only the cells that actually changed, and the requested
  and mean applied changes are shown side by side.

**Zone labels follow a fixed heuristic** (SPEC §3), applied in this order:
1. Heat Extreme Core: the highest mean total SHAP.
2. Riparian Buffer: among the other three, the most negative mean water + NDWI SHAP (if none is negative,
   the highest mean water fraction).
3. Ecological Cool Base: the lower mean total SHAP of the last two.
4. Transition: the remaining one.

The water cluster is named before the cool/transition split, so it becomes the Riparian Buffer. Zones
group cells with a similar attributed state, not a similar response to interventions; read labels
together with each zone's SHAP signature and `zones.json → labelling`, which records why each cluster got
its name.

---

## Validation status

Tested:
- The full pipeline in synthetic mode, at 2 km and 1 km, on CPU and on a single CUDA GPU (GTX 1650).
- The dashboard: lint, tests, build, and headless-browser runs at 1440×900, 1024×768 and 390×844
  against the demo bundle, with no console or page errors.

Not yet tested:
- The Earth Engine extraction path (its helpers are unit-tested offline: district matching on the real
  geoBoundaries layer, error classification, cache keys, DMSP intercalibration, epoch validation).
- Multi-GPU scheduling on 2× T4.
- RAPIDS (cuML/cuDF); therefore opt-in via `LST_USE_RAPIDS=1`.
- The GNN on CUDA.

Run the notebook on Kaggle as described above, and read the `manifest.notes` and data-source provenance
before interpreting real results.
#
