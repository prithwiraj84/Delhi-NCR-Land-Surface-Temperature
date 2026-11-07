# %% [markdown]
# # Delhi NCR Land Surface Temperature 1990-2050: Day & Night Thermal Dynamics, Explainable AI and Scenario Projections
#
# **Abstract.** This notebook builds a reproducible, GPU-accelerated pipeline for the pre-monsoon (April-June)
# land surface temperature (LST) of the Delhi National Capital Region (~55,000 km², 25 districts) from 1990 to
# 2050, for **two thermal regimes**: the mid-morning **day** surface (~10:30 IST, harmonised Landsat C2 L2 surface
# temperature, 1990-2025, corrected to a common 10:45 IST overpass) and the **night** surface (~01:30 IST, MODIS Aqua
# in Aqua-equivalent units, bridged to VIIRS for 2025 and to Terra for 2000, hindcast for 1990/1995). Eight observed
# frames (3-year windows centred on 1990, 1995, ..., 2025) are explained by 47 drivers (spectral indices, GHSL
# built-up and population, GLC_FCS30D land-cover fractions and landscape metrics, terrain, surface water and
# ERA5-Land climate, each also as multi-scale neighbourhood means). One pooled XGBoost model per mode is validated
# with pooled 20 km-block spatial cross-validation, leave-one-epoch-out transfer, an area-of-applicability analysis
# and conformal error bands, and benchmarked against ridge, random-forest, LightGBM and graph-neural-network
# baselines. Grouped TreeSHAP attributions (18 driver groups, block-bootstrap intervals) expose non-linear
# thresholds and are clustered into four **governance zones** with quantified mitigation levers. The 1 km frames
# are brought to **250 m** (Landsat day natively, night by DMS downscaling with block-conserving residual
# correction) and **projected to 2030-2050** under SSP1-2.6, SSP2-4.5 and SSP5-8.5 by combining a validated
# cellular-automaton land-change model with CMIP6 temperature deltas scaled by empirically fitted dLST/dTair
# sensitivities, with Monte-Carlo uncertainty over GCM, sensitivity, land realisation and model error. Projections
# are **scenarios, not forecasts**, and SHAP values describe the model, **not causal effects**. Everything is
# exported as a web bundle for the companion React dashboard (NCR THERMAL/OPS v2).
#
# ## Pipeline overview
# | Stage | Section | What happens |
# |---|---|---|
# | 0 | `00_setup` (this section) | configuration (`CFG` v2, run profiles), dependency check, GPU detection, utilities, stage cache, LSTB binary container |
# | 1 | `01_study_area` | 25 districts, 1 km + 250 m UTM 43N grids, ROI masks, canonical cell order, Earth Engine login, data-mode decision |
# | 2 | `02_synthetic_world` | synthetic twin 1990-2025 + future inputs with *planted* responses (synthetic mode only) |
# | 3 | `03_gee_landsat` | Landsat 5/7/8/9 C2 L2 day LST + spectral composites, path harmonisation, overpass metadata (gee mode) |
# | 4 | `04_gee_thermal` | MODIS/VIIRS night LST, Terra/VIIRS → Aqua calibration, MODIS day validation, annual 1990-2025 series (gee mode) |
# | 5 | `05_gee_drivers` | GHSL, GLC_FCS30D, SRTM, surface water, ERA5-Land, CMIP6 / SSP urban / population future inputs (gee mode) |
# | 6 | `06_features` | 47 features (focal means, distances, landscape metrics), feature table, CV folds, fixed masks |
# | 7 | `07_models` | validation suite (block20/block5/district/LOEO/place-time/random), benchmarks, final models, persistent residual, AOA, conformal errors |
# | 8 | `08_explain` | grouped TreeSHAP, interactions, bootstrap, dependence/thresholds, governance zones, recommendations, browser models |
# | 9 | `09_timeline` | absolute levels, night hindcast, evidence tiers, frame fields, dLST/dTair sensitivities, trends, scope series |
# | 10 | `10_downscaling` | 250 m day (Landsat) and night (DMS) fields, scale-invariance validation, EPSG:4326 PNG rasters |
# | 11 | `11_projections` | land-change CA (figure-of-merit validated), derived predictors, CMIP6 deltas, Monte-Carlo projections 2030-2050 |
# | 12 | `12_export` | web bundle v2 (LSTB cubes, JSON), parquet/geo/models, bundle validation, zip |
#
# ## How to run on Kaggle
# **Kaggle refuses notebooks larger than 1 MB, and this notebook is ~1.5 MB.** On Kaggle, run the small
# `kaggle_launcher.ipynb` (~12 KB) instead: it executes exactly these sections from a code dataset that you build with
# `python notebook/make_kaggle_code_bundle.py` and upload once (**+ Create → New Dataset**; **New Version** after code
# changes). Import the launcher that script writes next to the zip (**File → Import Notebook**), attach the code
# dataset (right sidebar → **Input → + Add Input → Datasets → Your Work**), then follow the steps below; the overrides
# of steps 4-6 go into the launcher's run-settings cell. This full notebook remains the readable, self-contained
# version for local Jupyter.
# 1. **Settings → Accelerator → GPU T4 x2**, **Internet → On**.
# 2. **Add-ons → Secrets** (tick both for *this* notebook):
#    * `GEE_SERVICE_ACCOUNT_KEY` — the *entire JSON key file* of a Google Cloud service account registered for
#      Earth Engine (Earth Engine API enabled in the project; roles *Earth Engine Resource Viewer* and *Service Usage
#      Consumer*; *Earth Engine Resource Writer* in addition if you use `LST_GEE_EXPORT=asset`);
#    * `GEE_PROJECT` — the Cloud project id used for Earth Engine quota.
# 3. **Earth Engine quota: the Contributor tier is required.** Noncommercial projects get 150 EECU-hours/month
#    (Community tier) or **1,000 EECU-hours/month (Contributor tier: link a billing account; noncommercial use is not
#    charged; switching takes effect at once)**. Measured 2026-10-12: the pilot's Landsat extraction alone used up the
#    Community tier's 150 EECU-hours after about 3.5 of its 4 frames (~35-45 EECU-hours per frame); a full run needs
#    several hundred. When the quota is used up, Earth Engine puts the project into *Restricted Mode* (reduced
#    concurrency) until the 1st of the next month, and the run stops cleanly with that message (everything downloaded
#    so far stays cached for the resume). **Read the EECU in Google Cloud Monitoring →
#    Earth Engine → "Completed EECU-seconds"**, grouped by `workload_tag` (`lst-v2-s03` Landsat, `lst-v2-s04`
#    MODIS/VIIRS, `lst-v2-s05` drivers + CMIP6) and `compute_type`; the Earth Engine task list only shows batch
#    exports. Interactive requests use the **standard endpoint** (`LST_GEE_ENDPOINT=highvolume` is opt-in; both
#    have the same quota of 40 concurrent requests) with a 420 s request deadline (`LST_GEE_DEADLINE_S`).
# 4. **Run the pilot first:** `LST_PROFILE=pilot` = frames **1990, 2000, 2020, 2025** (Landsat-5-only TM, the
#    Terra-reconstructed night frame and early GHSL/GLC epochs, the dense L7/L8/L9 windows), ridge + XGBoost, no
#    projections, plus a **CMIP6 warming-pattern probe** for 2050 (`LST_PILOT_PROBES`); about 1-1.5 h, as an
#    interactive *Run All* or a commit. Read the per-frame Landsat cost table at the end of section 03 (with its
#    projected full-run time), the PILOT PROBES table of section 05, the EECU per workload tag and
#    `metrics.json → timings`. **Extrapolation:** section 03 full ≈ 2 × pilot 03 (8 vs 4 frames; 2020/2025 are the
#    densest windows), 04 ≈ 1 × (its frame-independent work runs in full in both), 05 GDDP ≈ 1.5-2 × (the probe
#    already fetched the ssp245 blocks of the 2025 and 2050 windows); modelling scales with frames and benchmarks.
# 5. **Then the full profile as *Save & Run All (Commit)*.** Attach the pilot version's output first (**Input → + Add
#    Input → Notebooks → Your Work → the notebook → (+)**; Kaggle attaches the output of the notebook's *newest*
#    version) so its Earth Engine tiles and GDDP blocks are reused. **Decision rule:** if one pilot Landsat
#    frame took more than about 45 min interactively, or many tiles split, run the full profile with
#    `LST_GEE_EXPORT=asset` (needs *Earth Engine Resource Writer*) and `LST_STOP_AFTER=06` in a first commit, then
#    attach that version's output and *Save & Run All* again. **Asset mode:** noncommercial projects run about 2
#    batch tasks at a time, so the 8 Landsat exports take about 4 rounds (about 1.5-6 h); per-task limits
#    `LST_GEE_EXPORT_TIMEOUT_S` (3 h running), `LST_GEE_EXPORT_QUEUE_S` (4 h queued),
#    `LST_GEE_EXPORT_TIMEOUT_0405_S` (1 h, sections 04/05); failed or timed-out jobs are cancelled and extracted
#    interactively; finished assets persist across sessions and are reused.
# 6. **Time budget and clean stop.** `LST_TIME_BUDGET_H` (default 11 on Kaggle) stops *starting* new work so the run
#    ends cleanly before Kaggle's 12 h limit: the cache is packed, `outputs/RUN_STOPPED.json` says why, every later
#    cell prints `skipped: run stopped (...)` (the launcher prints `STOPPED CLEANLY`) and the version completes with
#    its output. `LST_STOP_AFTER=NN` stops the same way right after section NN. A version killed at 12 h may have no
#    usable output. In interactive sessions enable **Settings → Persistence → Files** so `outputs/` survives a
#    restart.
# 7. **Resuming.** Attach the completed (or cleanly stopped) version's output (**Input → + Add Input → Notebooks →
#    Your Work → the notebook → (+)**). Kaggle attaches the output of the notebook's *newest* version, so save no
#    other version between the stopped run and the resume (otherwise: open the stopped version → Output → *New
#    Dataset* and attach that dataset); keep the code dataset attached. `LST_CACHE_IMPORT=auto` finds its `cache/`
#    under `/kaggle/input/` (the run logs which one, and the attached run's `RUN_STOPPED.json`); an explicit value
#    is a folder path copied from the Input panel, and a wrong one stops the run at once instead of silently
#    recomputing. The cache is packed into `outputs/cache/packed/*.tar` at the end (Kaggle notebook
#    outputs are reported to be capped at 500 files) and unpacked on import. Stage-cache keys = configuration + data
#    fingerprints + a **per-section code hash** from `build_notebook.py`, so **edit `notebook/sections` and rebuild the
#    notebook or code bundle (never hand-edit cells on Kaggle)**; `LST_RESUME=0` recomputes every stage (Earth Engine tiles and GDDP
#    blocks stay cached); `LST_INVALIDATE=06,07` recomputes selected stages.
#
# Kaggle has no environment-variable UI: put overrides in a first cell, e.g.
# `import os; os.environ["LST_PROFILE"] = "pilot"`, before *Run All*. Missing packages are pip-installed
# automatically on Kaggle (never on a local machine unless `LST_ALLOW_PIP=1`). The dashboard needs a browser with
# `DecompressionStream` (Chrome/Edge 80+, Firefox 113+, Safari 16.4+).
#
# ## Run profiles (`LST_PROFILE`; `LST_FAST_DEV=1` ⇒ `fast`)
# | Setting | `full` (Kaggle default) | `fast` (smoke tests) | `pilot` (GEE cost probe) |
# |---|---|---|---|
# | observed frames | 1990, 1995, …, 2025 (8) | same 8 | 1990, 2000, 2020, 2025 |
# | projected frames | 2030 … 2050 (5) × 3 SSPs | same | none (CMIP6 2050 pattern probe instead) |
# | land-cover fine grid `LC_FINE_RES_M` | 50 m (gee) / 100 m (synthetic) | 200 m | 50 m |
# | bootstrap / Monte-Carlo draws / land realisations | 50 / 500 / 20 | 6 / 120 / 4 | 10 / – / – |
# | block CV | 20 km, 10 folds | 20 km, 5 folds | 20 km, 5 folds |
# | XGBoost rounds / early stop | 4000 / 100 | 400 / 30 | 1500 / 60 |
# | GNN epochs / Moran permutations | 300 / 999 | 30 / 99 | 60 / 199 |
# | benchmarks | ridge, random_forest, lightgbm, xgboost, gnn | same | ridge, xgboost |
#
# `LST_FRAMES_OBS` (comma list, any profile) overrides the observed frames: a subset of the 8 SPEC frames with at
# least 2 frames, at least 2 night training frames (2005-2025) and 2025; with projections it must contain 2005, 2015
# and 2025.
#
# ## Environment overrides (all optional)
# | Variable | Default | Effect |
# |---|---|---|
# | `LST_PROFILE` | `full` | run profile (table above) |
# | `LST_FRAMES_OBS` | profile | observed frames, e.g. `1990,2005,2025` (validated, see above) |
# | `LST_RUN_MODE` | `auto` | `auto` tries Earth Engine and falls back to a synthetic twin with a LOUD banner; `gee` fails hard without Earth Engine; `synthetic` never touches Earth Engine |
# | `LST_GRID_RES_M` | 1000 | analysis cell size (m) |
# | `LST_FINE_FACTOR` | 4 | fine grid = cell size / factor (250 m at 1 km) |
# | `LST_LC_FINE_RES_M` (legacy `LST_FINE_RES_M`) | profile | land-cover resolution for landscape metrics; snapped to a divisor of the cell size |
# | `LST_N_BOOTSTRAP`, `LST_N_MC`, `LST_N_LAND_REAL` | profile | SHAP bootstrap replicates, Monte-Carlo draws, land-change realisations |
# | `LST_BENCHMARKS` | profile | comma list from `ridge,random_forest,lightgbm,xgboost,gnn` (xgboost is mandatory) |
# | `LST_PILOT_PROBES` | `1` for a gee pilot, else `0` | section-05 probe of the CMIP6 2050 warming pattern (results in `FUTURE_INPUTS_DIAG['probes']`) |
# | `LST_GEE_ENDPOINT` | `standard` | Earth Engine endpoint: `standard` or `highvolume` (opt-in; same 40-request quota) |
# | `LST_GEE_DEADLINE_S` | 420 | client request deadline in seconds (minimum 330) |
# | `LST_GEE_EXPORT` | `interactive` | `interactive` (tiled `computePixels`) or `asset` (batch `Export.image.toAsset`) |
# | `LST_GEE_ASSET_ROOT` | `projects/<GEE_PROJECT>/assets/ncr_lst_v2` | Earth Engine asset folder for `asset` exports |
# | `LST_GEE_EXPORT_TIMEOUT_S` | 10800 | asset mode: per Landsat task, seconds RUNNING before it is cancelled and extracted interactively |
# | `LST_GEE_EXPORT_QUEUE_S` | 14400 | asset mode: per Landsat task, seconds queued (not yet RUNNING) before the same fallback |
# | `LST_GEE_EXPORT_TIMEOUT_0405_S` | 3600 | asset mode: per running task of sections 04/05 (7200 s queued) |
# | `LST_GEE_WORKERS` | 6 | concurrent `computePixels` requests (Earth Engine allows 40 per project) |
# | `LST_TIME_BUDGET_H` | 11 on Kaggle, else unlimited | stop starting new work after this many hours (`0`/`none`/`off` = unlimited) |
# | `LST_TIME_RESERVE_S` | 1800 | seconds kept free for packing the cache and finishing the version |
# | `LST_STOP_AFTER` | – | `01`..`11`: stop cleanly after that section (e.g. `06`) |
# | `LST_RESUME` | 1 | reuse stage-cache entries whose key (configuration + data fingerprints + per-section code hash) matches |
# | `LST_INVALIDATE` | – | comma list of stage-name prefixes to recompute, e.g. `06,07` (tiles/GDDP blocks stay cached) |
# | `LST_CACHE_IMPORT` | `auto` | `auto` = shallowest `/kaggle/input/*/**/cache`; or any folder containing a previous cache (e.g. a path copied from Kaggle's Input panel; a path without a cache stops the run); packed tars are unpacked; `0` disables |
# | `LST_PACK_CACHE` | 1 on Kaggle, else 0 | pack `cache/` into `cache/packed/*.tar` at the end and at a clean stop |
# | `LST_FRAME_MIN_COVERAGE` | 0.5 | section 06: minimum valid-target share of a training frame for the fixed masks (else weight 0) |
# | `LST_DAY_MIN_FRAME_COVERAGE` | 0.2 | section 03: a Landsat day frame below this ROI coverage stops the run (acquisition fault) |
# | `LST_GEE_PROJECT` / `LST_GEE_SERVICE_ACCOUNT_KEY` / `GOOGLE_APPLICATION_CREDENTIALS` | – | Earth Engine credentials outside Kaggle (JSON text or file path) |
# | `LST_OUTPUT_DIR` | `/kaggle/working/outputs` or `./outputs` | output root |
# | `LST_USE_RAPIDS` / `LST_INSTALL_RAPIDS` / `LST_RAPIDS_VERSION` | 0 | opt-in cuDF/cuML paths (not validated; off by default) |
# | `LST_BOOT_BLOCK_KM` | auto | SHAP block-bootstrap block size (default: residual-correlogram range) |
# | `LST_ALLOW_PIP` | 0 | allow pip installs outside Kaggle |
# | `LST_GNN_CPU_BUDGET_S` | 900 | wall-clock budget per GNN fold without CUDA |
#
# ## Outputs (`outputs/`)
# `web/` (dashboard bundle v2: `manifest.json`, `cells.lstb.gz`, `cube_*.lstb.gz`, `xai_*.lstb.gz`, `raster/*.png`,
# JSON summaries), `web_bundle.zip`, `parquet/` (feature table, predictions, SHAP, CV metrics), `geo/` (districts,
# zone polygons), `models/` (native XGBoost boosters), `npz/` (interaction tensors), `figures/*.png`, `cache/`
# (stage, Earth Engine tile and GDDP block caches, packed into `cache/packed/*.tar` on Kaggle, reusable by later runs)
# and, after a clean stop, `RUN_STOPPED.json`.
#
# ## Runtime (measured locally, extrapolated to Kaggle 2× T4 — calibrate with the pilot)
# **Measured** (synthetic mode, 1 GTX 1650 + 8 CPU threads, CPU-only PyTorch, so the GNN ran on the CPU):
#
# | run | 02–06 | 07 validation | 08 XAI | 09 | 10 | 11 | 12 | total |
# |---|---|---|---|---|---|---|---|---|
# | `fast`, 2 km (16.6 k cells) | 25 s | 64 min (GNN 50 min) | 5 min | 7 s | 1.7 min | 1.7 min | 12 s | 74 min |
# | `fast`, 1 km (66.3 k cells; GNN capped at 100 s/fold) | 56 s | 79 min (GNN 61 min) | 7 min | 9 s | 2.2 min | 6 min | 38 s | 96 min |
#
# Full-profile probes at 1 km: one XGBoost fit with `XGB_MAX_ROUNDS=4000` / early stop 100 takes **42 s (day,
# 424 k rows) / 33 s (night, 264 k rows)** on the GTX 1650 and, on the synthetic data, never stops early (best
# round = 4000; real data stopped at ~2,300 rounds in v1); TreeSHAP of a 4000-tree model costs ~31 s per 60 k rows.
# Anchors from the user's real v1 Kaggle run (2× T4, 176 k rows/fold, full profile): XGBoost 13.7 s, LightGBM-GPU
# 38 s, GNN (300 epochs) 123 s and random forest (4 vCPU) 98 s per fold.
#
# **Extrapolation to the full profile on Kaggle 2× T4 (1 km, 8 frames, ~530 k / 330 k cell-frames per mode)**:
# section 07 runs three lanes side by side: XGBoost and the GNN share the GPU lanes (GNN benchmark, 43 folds × 3–5 min
# ≈ 1.5 h; XGBoost ~175 fits × 20–25 s ≈ 0.5 h), **LightGBM-GPU runs serially in its own lane on GPU 1** (≈ 0.5 h;
# its OpenCL learner is not thread safe), and random forest + ridge occupy the CPU lane (≈ 0.5–1.7 h on 4 vCPU);
# per-lane busy time is logged after 07. If the LightGBM GPU probe fails, LightGBM joins the CPU lane and adds about
# 1–2 h (about 3 h without early stopping). XAI (08, 4400-tree TreeSHAP of 8 frames, interactions, 50 bootstrap
# replicates ≈ 50 s each per GPU) ≈ 1 h; timeline + downscaling ≈ 5 min; projections (20 land realisations × 3 SSPs,
# 500 draws) ≈ 45 min; export ≈ 2 min: **modelling ≈ 4.5 h**. Earth Engine extraction ≈ 1.5–3 h on the first run
# with interactive `computePixels` (dominated by the 30 m Landsat medians; `asset` mode can add queueing, see item
# 5), minutes from the tile cache. **Expected total ≈ 6–7.5 h (an estimate; calibrate with the pilot)**, inside the
# 11 h time budget. If a session is tight: (1) `LST_STOP_AFTER=06` for the extraction in a first commit and resume the
# modelling in a second one (attach the first version's output), (2) `LST_BENCHMARKS=ridge,random_forest,lightgbm,
# xgboost` drops the GNN benchmark (≈ −1.5 h; headline metrics are XGBoost), (3) `LST_N_BOOTSTRAP=25` (≈ −30 min,
# wider CI noise). Pilot (`LST_PROFILE=pilot`, 4 frames, ridge + XGBoost, no projections): ≈ 1–1.5 h including Earth
# Engine.
#
# ## Loading the results into the dashboard
# Download `web_bundle.zip` from the Kaggle *Output* tab and unzip it into `dashboard/public/data/` (so that
# `dashboard/public/data/manifest.json` exists), then run `npm install && npm run dev` inside `dashboard/`. The
# dashboard opens `public/data` by default (`?bundle=data`), or the synthetic demo in `public/demo` (`?bundle=demo`);
# `VITE_DATA_BASE_URL` points it at a hosted bundle. Synthetic bundles always show a permanent "SIMULATED" banner.

# %% [markdown]
# ## 0.1 Environment detection and dependencies
# Installs use `subprocess` (no notebook magics, so the same code runs as a plain script). Packages are installed
# only when an import is missing **and** we are on Kaggle (or `LST_ALLOW_PIP=1`); otherwise a warning is logged
# and the dependent step falls back gracefully later.

# %%
import gc
import gzip
import hashlib
import importlib
import importlib.util
import inspect
import io
import json
import math
import os
import pickle
import platform
import queue
import random
import re
import shutil
import struct
import subprocess
import sys
import threading
import time
import warnings
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from dataclasses import asdict, dataclass, field, fields, is_dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Optional, Sequence
import ast
import tarfile

_RUN_T0 = time.time()            # wall-clock start of this run: the time budget (section 0.5.1) counts from here
LST_STOPPED = False              # True once request_stop() was called; later cells are skipped (cell guard)
LST_STOP_REASON = None           # why the run stopped (time budget, LST_STOP_AFTER, ...)
_CURRENT_SECTION = "00"          # set by _lst_enter_section('NN') at the top of every later section

_IS_KAGGLE = bool(os.environ.get("KAGGLE_KERNEL_RUN_TYPE")) or Path("/kaggle/working").exists()
_LOG_LOCK = threading.Lock()

# Legacy consoles (e.g. Windows cp1252) cannot encode symbols such as "°" or "→": replace instead of crashing.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(errors="replace")
        except (ValueError, OSError):
            pass


def log(msg: str, level: str = "INFO") -> None:
    """Print a timestamped, levelled log line (thread-safe, flushed immediately).

    Levels are free-form but conventionally DEBUG / INFO / WARNING / ERROR. Output goes to stdout so that Kaggle's
    cell output and the local runner interleave messages in order.
    """
    stamp = datetime.now().strftime("%H:%M:%S")
    with _LOG_LOCK:
        print(f"[{stamp}] {level.upper():<7} {msg}", flush=True)


def _is_interactive() -> bool:
    """True inside a live notebook kernel that can prompt the user (not a Kaggle batch commit)."""
    if os.environ.get("KAGGLE_KERNEL_RUN_TYPE", "").lower() == "batch":
        return False
    return "ipykernel" in sys.modules


# pip distribution name -> import name (for the "is it already importable?" check)
_PIP_IMPORT_NAMES = {
    "earthengine-api": "ee",
    "pylandstats": "pylandstats",
    "libpysal": "libpysal",
    "esda": "esda",
    "pyarrow": "pyarrow",
    "shapely": "shapely",
    "pyproj": "pyproj",
    "lightgbm": "lightgbm",
    "shap": "shap",
    "pillow": "PIL",
    "cudf-cu12": "cudf",
    "cuml-cu12": "cuml",
}


def _import_name(spec: str) -> str:
    """Map a pip requirement spec (e.g. ``"shap>=0.44"``) to the module name it provides."""
    base = re.split(r"[<>=!~\[;\s]", spec.strip(), maxsplit=1)[0]
    return _PIP_IMPORT_NAMES.get(base.lower(), base.replace("-", "_").lower())


def _is_importable(module: str) -> bool:
    """Check importability without importing (cheap, no side effects)."""
    try:
        return importlib.util.find_spec(module) is not None
    except (ImportError, ValueError):
        return False


def _run_pip(specs: Sequence[str], extra_args: Sequence[str], timeout: int) -> bool:
    """Run one ``pip install`` subprocess; return True on exit code 0."""
    cmd = [sys.executable, "-m", "pip", "install", "-q", *extra_args, *specs]
    log(f"pip install {' '.join(specs)} {' '.join(extra_args)}".rstrip())
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        log(f"pip install timed out after {timeout}s for {list(specs)}", "WARNING")
        return False
    except OSError as exc:
        log(f"pip could not be started: {exc}", "WARNING")
        return False
    if proc.returncode != 0:
        log(f"pip failed (exit {proc.returncode}) for {list(specs)}:\n{proc.stderr[-1500:]}", "WARNING")
        return False
    return True


def pip_install(pkgs, extra_args: Sequence[str] = (), *, timeout: int = 900) -> bool:
    """Install missing packages with ``sys.executable -m pip install -q``.

    Only packages whose import is missing are installed, and only on Kaggle or when ``LST_ALLOW_PIP=1`` (we never
    modify a user's local/global Python silently). A failed group install is retried per package so one broken wheel
    does not block the others. Returns True when every requested package is importable afterwards.
    """
    specs = [pkgs] if isinstance(pkgs, str) else list(pkgs)
    missing = [s for s in specs if not _is_importable(_import_name(s))]
    if not missing:
        return True
    if not (_IS_KAGGLE or os.environ.get("LST_ALLOW_PIP") == "1"):
        log(f"Missing optional packages {missing}; not installing outside Kaggle "
            f"(set LST_ALLOW_PIP=1 to allow). Dependent steps will use fallbacks.", "WARNING")
        return False
    if not _run_pip(missing, extra_args, timeout) and len(missing) > 1:
        for spec in missing:
            _run_pip([spec], extra_args, timeout)
    importlib.invalidate_caches()
    still_missing = [s for s in missing if not _is_importable(_import_name(s))]
    if still_missing:
        log(f"Still missing after pip: {still_missing}", "WARNING")
    return not still_missing


_REQUIRED_OPTIONAL_PKGS = ["earthengine-api", "pylandstats", "libpysal", "esda", "pyarrow",
                           "shapely", "pyproj", "lightgbm", "shap", "pillow"]
pip_install(_REQUIRED_OPTIONAL_PKGS)
log(f"Environment: {'Kaggle' if _IS_KAGGLE else 'local'} | Python {platform.python_version()} | "
    f"{platform.platform()}")

# %% [markdown]
# ### Optional RAPIDS install (`LST_INSTALL_RAPIDS=1`)
# Runs **before** numpy/pandas are imported (section 0.2): a RAPIDS wheel may pull in different numpy/pandas
# versions, and swapping them under an interpreter that has already imported the old ones leaves a mixed, broken
# environment. The install is constrained to the numpy/pandas versions already installed (pip then picks a
# compatible RAPIDS release or fails cleanly); `LST_RAPIDS_VERSION` (e.g. `25.2.*`) pins the release. Kaggle's GPU
# image already ships cuDF/cuML, so there the install is a no-op. Using RAPIDS at all is a separate opt-in
# (`LST_USE_RAPIDS=1`, section 0.4).

# %%
def _dist_version(dist: str) -> Optional[str]:
    """Installed version of a distribution without importing it (None when absent)."""
    try:
        from importlib.metadata import PackageNotFoundError, version
    except ImportError:  # pragma: no cover - Python < 3.8
        return None
    try:
        return version(dist)
    except PackageNotFoundError:
        return None


def _install_rapids() -> bool:
    """pip-install cuDF/cuML constrained to the installed numpy/pandas; returns True when a restart is needed."""
    pinned = (os.environ.get("LST_RAPIDS_VERSION") or "").strip()
    specs = [f"{name}=={pinned}" if pinned else name for name in ("cudf-cu12", "cuml-cu12")]
    before = {d: _dist_version(d) for d in ("numpy", "pandas")}
    already_imported = [d for d in before if d in sys.modules]
    constraint_path = None
    extra = ["--extra-index-url=https://pypi.nvidia.com"]
    pins = [f"{d}=={v}" for d, v in before.items() if v]
    if pins:
        import tempfile
        with tempfile.NamedTemporaryFile("w", suffix="_lst_constraints.txt", delete=False) as fh:
            fh.write("\n".join(pins) + "\n")
            constraint_path = fh.name
        extra += ["--constraint", constraint_path]
    log(f"LST_INSTALL_RAPIDS=1: installing {specs} constrained to {pins or 'nothing'} (several minutes)", "WARNING")
    try:
        pip_install(specs, extra_args=extra, timeout=2400)
    finally:
        if constraint_path:
            try:
                os.remove(constraint_path)
            except OSError:
                pass
    after = {d: _dist_version(d) for d in before}
    changed = {d: (before[d], after[d]) for d in before if before[d] != after[d]}
    if changed:
        loaded = f" ({', '.join(already_imported)} already imported in this kernel)" if already_imported else ""
        log(f"RAPIDS install changed {changed}{loaded}. RESTART THE KERNEL and run again before continuing.",
            "ERROR")
        return True
    return False


if os.environ.get("LST_INSTALL_RAPIDS", "").strip().lower() in {"1", "true", "yes", "on", "y"}:
    if _install_rapids():
        raise RuntimeError("RAPIDS installation changed numpy/pandas; restart the kernel and run the notebook "
                           "again (the install is skipped next time because cuDF/cuML are then importable).")

# %% [markdown]
# ## 0.2 Imports
# Core scientific stack first; every optional/accelerator library is imported defensively so that a missing package
# only disables the feature that needs it. Matplotlib is forced to the non-interactive `Agg` backend when no
# notebook kernel is present (headless scripts, CI).

# %%
import numpy as np
import pandas as pd
import scipy
from scipy import ndimage, sparse, stats
import matplotlib

if not os.environ.get("MPLBACKEND") and "ipykernel" not in sys.modules:
    matplotlib.use("Agg")
import matplotlib.pyplot as plt
import sklearn

# plt.show() under Agg warns "FigureCanvasAgg is non-interactive" - harmless in headless runs.
warnings.filterwarnings("ignore", message=".*non-interactive.*")
warnings.filterwarnings("ignore", message=".*FigureCanvasAgg.*")


def _optional_import(module: str):
    """Import ``module`` or return None (any exception, e.g. CUDA driver errors, counts as missing)."""
    try:
        return importlib.import_module(module)
    except Exception as exc:  # noqa: BLE001 - optional dependency, any failure means "unavailable"
        log(f"optional import '{module}' unavailable: {type(exc).__name__}: {str(exc)[:160]}", "DEBUG")
        return None


torch = _optional_import("torch")
xgb = _optional_import("xgboost")
lgb = _optional_import("lightgbm")
shap = _optional_import("shap")
ee = _optional_import("ee")
libpysal = _optional_import("libpysal")
esda = _optional_import("esda")
pylandstats = _optional_import("pylandstats")
shapely = _optional_import("shapely")
pyproj = _optional_import("pyproj")
PIL = _optional_import("PIL")
if PIL is not None:
    PIL_Image = _optional_import("PIL.Image")   # Pillow image module (PNG rasters in section 10)
else:
    PIL_Image = None

_OPTIONAL_MODULES = {
    "torch": torch, "xgboost": xgb, "lightgbm": lgb, "shap": shap, "earthengine-api": ee,
    "libpysal": libpysal, "esda": esda, "pylandstats": pylandstats, "shapely": shapely, "pyproj": pyproj,
    "pillow": PIL,
}
log("versions: " + ", ".join(
    [f"numpy {np.__version__}", f"pandas {pd.__version__}", f"scipy {scipy.__version__}",
     f"sklearn {sklearn.__version__}", f"matplotlib {matplotlib.__version__}"]
    + [f"{name} {getattr(mod, '__version__', '?')}" if mod is not None else f"{name} MISSING"
       for name, mod in _OPTIONAL_MODULES.items()]))

# %% [markdown]
# ## 0.3 Configuration (`CFG`, v2)
# One dataclass holds every tunable (SPEC §1.6). Defaults come from the **run profile** (`full`, `fast`, `pilot`);
# `LST_*` environment variables override them. Study-design constants (frames, windows, scenarios, modes) are fixed
# by the SPEC and identical in every profile except `pilot`, which probes Earth Engine cost on four frames (1990,
# 2000, 2020, 2025) and skips projections (downstream sections must therefore handle an **empty** `FRAMES_PROJ`);
# `LST_FRAMES_OBS` overrides the frames of any profile (validated: SPEC frames only, ≥ 2 frames, ≥ 2 night training
# frames, 2025, and 2005/2015/2025 when projecting). Run control (time budget, `LST_STOP_AFTER`, cache packing,
# `LST_INVALIDATE`) and the Earth Engine session settings (`LST_GEE_ENDPOINT`, `LST_GEE_DEADLINE_S`) are CFG fields
# too.
#
# The land-cover resolution for landscape metrics depends on the data mode, which section 1 decides:
# `CFG.resolve_mode(mode)` fixes `LC_FINE_RES_M` (snapped to a divisor of `GRID_RES_M`) and `CFG.fine_res()`
# returns it (v1 API). The 250 m analysis fine grid is `GRID_RES_M // FINE_FACTOR` (`CFG.grid_fine_res()`).

# %%
def _env_str(name: str, default: Optional[str] = None) -> Optional[str]:
    value = os.environ.get(name)
    return value.strip() if value is not None and value.strip() else default


def _env_int(name: str, default: Optional[int] = None) -> Optional[int]:
    value = _env_str(name)
    if value is None:
        return default
    try:
        return int(float(value))
    except ValueError as exc:
        raise ValueError(f"Environment variable {name}={value!r} is not an integer") from exc


def _env_bool(name: str, default: bool = False) -> bool:
    value = _env_str(name)
    if value is None:
        return default
    low = value.lower()
    if low in {"1", "true", "yes", "on", "y"}:
        return True
    if low in {"0", "false", "no", "off", "n"}:
        return False
    raise ValueError(f"Environment variable {name}={value!r} is not a boolean (use 1/0, true/false)")


def _kaggle_secret(name: str) -> Optional[str]:
    """Read a Kaggle notebook secret; None when not on Kaggle or the secret is not attached."""
    if not _IS_KAGGLE:
        return None
    try:
        from kaggle_secrets import UserSecretsClient  # available only inside Kaggle kernels
        value = UserSecretsClient().get_secret(name)
        return value.strip() if value else None
    except Exception:  # noqa: BLE001 - absent secret raises a generic exception
        return None


def _nearest_divisor(n: int, target: int) -> int:
    """Divisor of ``n`` closest to ``target`` (ties resolved towards the larger, cheaper divisor)."""
    divisors = [d for d in range(1, n + 1) if n % d == 0]
    return min(divisors, key=lambda d: (abs(d - target), -d))


# SPEC §1.4: the final model of each mode. ``device`` and ``seed`` are injected per call (xgb_device_for(gpu_id),
# CFG.SEED + fold offset) so that the same dict can drive parallel folds on different GPUs.
_XGB_DEFAULT_PARAMS = {
    "objective": "reg:squarederror", "tree_method": "hist", "learning_rate": 0.03, "max_depth": 6,
    "min_child_weight": 20, "subsample": 0.8, "colsample_bytree": 0.8, "reg_lambda": 1.0,
    "reg_alpha": 0.0, "max_bin": 256, "eval_metric": "rmse",
}
_VALID_RUN_MODES = ("auto", "gee", "synthetic")
_VALID_PROFILES = ("full", "fast", "pilot")
_VALID_BENCHMARKS = ("ridge", "random_forest", "lightgbm", "xgboost", "gnn")
_VALID_GEE_EXPORT = ("interactive", "asset")
_VALID_GEE_ENDPOINTS = ("standard", "highvolume")
_GEE_DEADLINE_MIN_S = 330.0              # must exceed the ~300 s interactive server limit (else retries never help)
_ALL_BENCHMARKS = ["ridge", "random_forest", "lightgbm", "xgboost", "gnn"]
# Code identity of the shared helpers of sections 00/01/02. Bump it MANUALLY when a helper defined there changes
# results (e.g. fetch_grid, block_mean, GridSpec): every stage-cache key carries it (SPEC §3.1, CFG.key).
SHARED_CODE_TAG = "v2.0"

# SPEC §1.2 - observation frames (Apr-Jun of a multi-year window), projections, scenarios
_FRAMES_OBS_ALL = [1990, 1995, 2000, 2005, 2010, 2015, 2020, 2025]
_WINDOWS_ALL = {1990: (1989, 1992), 1995: (1994, 1996), 2000: (1999, 2001), 2005: (2004, 2006),
                2010: (2009, 2011), 2015: (2014, 2016), 2020: (2019, 2021), 2025: (2024, 2026)}
_FRAMES_PROJ_ALL = [2030, 2035, 2040, 2045, 2050]
_NIGHT_TRAIN_ALL = [2005, 2010, 2015, 2020, 2025]

# SPEC §1.6 - profile-dependent defaults. LC_FINE_RES_M is a {data_mode: metres} map (resolved in section 1).
_PROFILE_DEFAULTS = {
    "full": {"N_BOOTSTRAP": 50, "N_MC": 500, "N_LAND_REAL": 20, "BLOCK_KM": 20, "N_FOLDS_BLOCK": 10,
             "XGB_MAX_ROUNDS": 4000, "XGB_EARLY_STOP": 100, "GNN_EPOCHS": 300, "MORAN_PERMS": 999,
             "BENCHMARKS": list(_ALL_BENCHMARKS), "LC_FINE_RES_M": {"gee": 50, "synthetic": 100},
             "FRAMES_OBS": list(_FRAMES_OBS_ALL), "FRAMES_PROJ": list(_FRAMES_PROJ_ALL)},
    "fast": {"N_BOOTSTRAP": 6, "N_MC": 120, "N_LAND_REAL": 4, "BLOCK_KM": 20, "N_FOLDS_BLOCK": 5,
             "XGB_MAX_ROUNDS": 400, "XGB_EARLY_STOP": 30, "GNN_EPOCHS": 30, "MORAN_PERMS": 99,
             "BENCHMARKS": list(_ALL_BENCHMARKS), "LC_FINE_RES_M": {"gee": 200, "synthetic": 200},
             "FRAMES_OBS": list(_FRAMES_OBS_ALL), "FRAMES_PROJ": list(_FRAMES_PROJ_ALL)},
    # Pilot = Earth Engine cost/runtime probe on the risky paths: TM-only Landsat 5 (1990), the Terra-reconstructed
    # night frame and the early GHSL / GLC five-years-map epochs (2000), the dense L7/L8/L9 windows (2020, 2025);
    # no projections (N_MC / N_LAND_REAL are unused -> 0); section 05 probes the CMIP6 warming pattern instead.
    "pilot": {"N_BOOTSTRAP": 10, "N_MC": 0, "N_LAND_REAL": 0, "BLOCK_KM": 20, "N_FOLDS_BLOCK": 5,
              "XGB_MAX_ROUNDS": 1500, "XGB_EARLY_STOP": 60, "GNN_EPOCHS": 60, "MORAN_PERMS": 199,
              "BENCHMARKS": ["ridge", "xgboost"], "LC_FINE_RES_M": {"gee": 50, "synthetic": 50},
              "FRAMES_OBS": [1990, 2000, 2020, 2025], "FRAMES_PROJ": []},
}


def _projection_window(frame: int) -> tuple:
    """20-year climate window centred on a projection frame (SPEC §3.2: 2025 → 2016-2035, 2050 → 2041-2060)."""
    return (int(frame) - 9, int(frame) + 10)


def _parse_benchmarks(text: str) -> list:
    """Comma/space separated model list → validated, de-duplicated list in canonical order."""
    wanted = [t.strip().lower() for t in re.split(r"[,\s]+", text) if t.strip()]
    unknown = sorted(set(wanted) - set(_VALID_BENCHMARKS))
    if unknown:
        raise ValueError(f"LST_BENCHMARKS: unknown model(s) {unknown}; choose from {list(_VALID_BENCHMARKS)}")
    return [m for m in _VALID_BENCHMARKS if m in wanted]


_CODE_SHA_WARNED = False


def _warn_no_code_sha() -> None:
    """One WARNING per session when the per-section code hashes are missing (cell run outside the built notebook)."""
    global _CODE_SHA_WARNED
    if not _CODE_SHA_WARNED:
        _CODE_SHA_WARNED = True
        log("_CODE_SHA is not defined (notebook not built by build_notebook.py, or its first code cell was not run): "
            "stage-cache keys carry no code identity, so edited code may reuse stale cached stages", "WARNING")


def section_code_hash(*ids) -> Optional[str]:
    """Combined code hash of sections ``ids`` (e.g. ``section_code_hash('07')``) for cross-section stage keys.

    sha1 of the joined ``'NN:<sha>'`` pairs, first 12 hex digits; None when ``_CODE_SHA`` is not defined.
    """
    shas = globals().get("_CODE_SHA")
    if not isinstance(shas, dict):
        _warn_no_code_sha()
        return None
    norm = [f"{int(i):02d}" if str(i).isdigit() else str(i) for i in ids]
    text = ";".join(f"{i}:{shas.get(i)}" for i in norm)
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:12]


def _parse_frames(text: str, name: str = "LST_FRAMES_OBS") -> list:
    """Comma/space separated observation frames -> sorted unique ints (validated against SPEC §1.2 in LSTConfig)."""
    out = []
    for tok in (t.strip() for t in re.split(r"[,\s]+", text) if t.strip()):
        try:
            out.append(int(tok))
        except ValueError as exc:
            raise ValueError(f"{name}: {tok!r} is not a year; choose from {_FRAMES_OBS_ALL}") from exc
    return sorted(set(out))


_OFF_WORDS = {"0", "none", "off", "no", "false", "n", "unlimited", ""}


def _env_hours(name: str, default: Optional[float]) -> Optional[float]:
    """Positive hours from ``name``; '0' / 'none' / 'off' mean unlimited (None)."""
    value = _env_str(name)
    if value is None:
        return default
    if value.lower() in _OFF_WORDS:
        return None
    try:
        hours = float(value)
    except ValueError as exc:
        raise ValueError(f"Environment variable {name}={value!r} is not a number of hours (or 0/none/off)") from exc
    if not (math.isfinite(hours) and hours > 0):
        raise ValueError(f"{name}={value!r} must be > 0 hours (or 0/none/off for no budget)")
    return hours


def _env_float(name: str, default: float) -> float:
    value = _env_str(name)
    if value is None:
        return float(default)
    try:
        return float(value)
    except ValueError as exc:
        raise ValueError(f"Environment variable {name}={value!r} is not a number") from exc


def _parse_section_id(value: Optional[str], name: str = "LST_STOP_AFTER") -> Optional[str]:
    """'6' / '06' -> '06' (sections 01..11); None / '' / 'none' / 'off' -> None."""
    if value is None or str(value).strip().lower() in _OFF_WORDS - {"0"}:
        return None
    text = str(value).strip()
    if not re.fullmatch(r"\d{1,2}", text) or not 1 <= int(text) <= 11:
        raise ValueError(f"{name}={value!r}: give a section number 01..11 (the run stops cleanly after it)")
    return f"{int(text):02d}"


def _parse_invalidate(text: Optional[str]) -> list:
    """LST_INVALIDATE comma tokens (stage-name prefixes such as 06, 07_job, s04)."""
    if not text:
        return []
    tokens = [t.strip() for t in re.split(r"[,\s]+", text) if t.strip()]
    bad = [t for t in tokens if not re.fullmatch(r"[A-Za-z0-9_.\-]+", t)]
    if bad:
        raise ValueError(f"LST_INVALIDATE: invalid token(s) {bad} (use stage-name prefixes such as 06,07_job)")
    return tokens


@dataclass
class LSTConfig:
    """Pipeline configuration v2 (SPEC §1.6 + v1 fields). Construct with :meth:`from_env`."""

    # --- run control -------------------------------------------------------------------------------------------
    PROFILE: str = "full"
    RUN_MODE: str = "auto"
    FAST_DEV: bool = False                    # v1 flag; True iff PROFILE == "fast"
    RESUME: bool = True
    CACHE_IMPORT: str = "auto"                # "auto" | folder path | "off"
    INVALIDATE: list = field(default_factory=list)       # LST_INVALIDATE stage-name prefixes forced to recompute
    PACK_CACHE: bool = False                  # LST_PACK_CACHE: pack the cache into tar files (default on Kaggle)
    TIME_BUDGET_H: Optional[float] = None     # LST_TIME_BUDGET_H (11 on Kaggle): stop starting work after this
    TIME_RESERVE_S: float = 1800.0            # LST_TIME_RESERVE_S: seconds kept free for packing + export
    STOP_AFTER: Optional[str] = None          # LST_STOP_AFTER '01'..'11': stop cleanly after that section
    # --- study design (SPEC §1.1-§1.3) -------------------------------------------------------------------------
    FRAMES_OBS: list = field(default_factory=lambda: list(_FRAMES_OBS_ALL))
    WINDOWS: dict = field(default_factory=lambda: dict(_WINDOWS_ALL))
    FRAMES_PROJ: list = field(default_factory=lambda: list(_FRAMES_PROJ_ALL))
    PROJ_WINDOWS: dict = field(default_factory=dict)       # filled in __post_init__ (20-year GCM windows)
    SCENARIOS: list = field(default_factory=lambda: ["ssp126", "ssp245", "ssp585"])
    NOW: int = 2025
    REFERENCE_PERIOD: tuple = (2000, 2020)
    MODES: list = field(default_factory=lambda: ["day", "night"])
    NIGHT_TRAIN_FRAMES: list = field(default_factory=lambda: list(_NIGHT_TRAIN_ALL))
    SEASON: tuple = ("04-01", "06-30")
    SPRING_SEASON: tuple = ("02-01", "03-31")             # ndvi_spring_f window (SPEC §2.1)
    DAY_REFERENCE_OVERPASS_IST_H: float = 10.75           # 10:45 IST reference overpass (SPEC §4.7)
    CRS: str = "EPSG:32643"
    # --- grids -------------------------------------------------------------------------------------------------
    GRID_RES_M: int = 1000
    FINE_FACTOR: int = 4
    LC_FINE_RES_M: Optional[int] = None       # resolved by resolve_mode(); read via fine_res()
    LC_FINE_RES_DEFAULTS: dict = field(default_factory=lambda: {"gee": 50, "synthetic": 100})
    LC_FINE_RES_REQUEST: Optional[int] = None  # LST_LC_FINE_RES_M (legacy LST_FINE_RES_M); overrides the defaults
    LM_WINDOW_CELLS: int = 1
    TARGET_MODE: str = "anomaly"
    # --- target validity (SPEC §3.3; used by section 06) --------------------------------------------------------
    DAY_MIN_NOBS: float = 2.0                 # 1 km mean of fine clear-scene counts
    FINE_MIN_VALID_FRAC: float = 0.5          # >= 50 % valid fine pixels per 1 km cell
    # Aqua 8-day composites passing QC (mandatory QA <= 1, LST error <= 2 K). Real data (2026-11, Apr-Jun 2019-2021
    # over NCR): median 4.8 per 1 km cell; >= 3 in 77 % of cells, >= 6 in only 30 % (the SPEC's first value, 6).
    NIGHT_MIN_NOBS: int = 3
    # Terra-reconstructed night frame (2 seasons, sparser: >= 3 keeps 10 % of the fixed mask, >= 1 about 70 %); weight 0.
    NIGHT_MIN_NOBS_TERRA: int = 1
    NIGHT_MIN_NOBS_VIIRS: int = 20            # VIIRS daily observations
    LST_MIN_OBS: int = 3                      # v1 meaning (MODIS composites), kept for compatibility
    LST_MIN_COVERAGE: float = 0.5             # v1 meaning
    # --- validation / models -----------------------------------------------------------------------------------
    SEED: int = 42
    N_FOLDS: int = 5
    SPATIAL_BLOCKS: tuple = (5, 5)
    INNER_BLOCK_KM: int = 10
    BLOCK_KM: int = 20
    N_FOLDS_BLOCK: int = 10
    BENCHMARKS: list = field(default_factory=lambda: list(_ALL_BENCHMARKS))
    BOOT_BLOCK_KM: Optional[int] = None       # None = derived from the residual correlogram in section 08
    N_BOOTSTRAP: int = 50
    N_MC: int = 500
    N_LAND_REAL: int = 20
    K_ZONES: int = 4
    DEP_BINS: int = 40
    MORAN_K: int = 8
    MORAN_PERMS: int = 999
    XGB_PARAMS: dict = field(default_factory=lambda: dict(_XGB_DEFAULT_PARAMS))
    XGB_MAX_ROUNDS: int = 4000
    XGB_EARLY_STOP: int = 100
    GNN_EPOCHS: int = 300
    SHAP_BATCH: int = 16384
    SHAP_INTERACTION_MAX_ROWS: Optional[int] = 4000       # None on GPU (set by apply_hardware)
    SHAP_INTERACTION_ROWS_PER_FRAME: int = 5000           # SPEC §4.4 sample for grouped interactions
    # --- Earth Engine --------------------------------------------------------------------------------------------
    GEE_PROJECT: Optional[str] = None
    GEE_ENDPOINT: str = "standard"            # LST_GEE_ENDPOINT: "standard" | "highvolume" (opt-in)
    GEE_DEADLINE_S: float = 420.0             # LST_GEE_DEADLINE_S: client request deadline (>= 330 s)
    GEE_EXPORT: str = "interactive"
    GEE_ASSET_ROOT: Optional[str] = None      # default projects/<GEE_PROJECT>/assets/ncr_lst_v2 (resolved in 01)
    GEE_TILE_PX: int = 128
    GEE_FINE_TILE_PX: int = 2048              # single-band uint8 land-cover tiles
    GEE_STACK_TILE_PX: int = 512              # multi-band float32 fine stacks (48 MB request limit)
    GEE_WORKERS: int = 6
    GEE_MAX_RETRIES: int = 6
    LC_SOURCES: dict = field(default_factory=dict)        # one product for every frame (SPEC §1.4)
    # --- hardware / output ---------------------------------------------------------------------------------------
    INSTALL_RAPIDS: bool = False
    USE_RAPIDS: bool = False                  # cuDF/cuML paths are opt-in (LST_USE_RAPIDS / LST_INSTALL_RAPIDS)
    OUTPUT_DIR: Path = Path("outputs")
    CACHE_DIR: Path = field(init=False)
    STAGE_DIR: Path = field(init=False)
    FIG_DIR: Path = field(init=False)
    PARQUET_DIR: Path = field(init=False)
    GEO_DIR: Path = field(init=False)
    MODEL_DIR: Path = field(init=False)
    NPZ_DIR: Path = field(init=False)
    WEB_DIR: Path = field(init=False)
    DATA_MODE: Optional[str] = None           # "gee" | "synthetic" once resolved by section 1
    ENV_OVERRIDES: dict = field(default_factory=dict)     # LST_* variables that changed a default (for the log)

    def __post_init__(self) -> None:
        if self.PROFILE not in _VALID_PROFILES:
            raise ValueError(f"PROFILE must be one of {_VALID_PROFILES}, got {self.PROFILE!r}")
        if self.RUN_MODE not in _VALID_RUN_MODES:
            raise ValueError(f"RUN_MODE must be one of {_VALID_RUN_MODES}, got {self.RUN_MODE!r}")
        if self.TARGET_MODE not in ("anomaly", "absolute"):
            raise ValueError(f"TARGET_MODE must be 'anomaly' or 'absolute', got {self.TARGET_MODE!r}")
        if self.GEE_EXPORT not in _VALID_GEE_EXPORT:
            raise ValueError(f"GEE_EXPORT must be one of {_VALID_GEE_EXPORT}, got {self.GEE_EXPORT!r}")
        if self.GEE_ENDPOINT not in _VALID_GEE_ENDPOINTS:
            raise ValueError(f"GEE_ENDPOINT (LST_GEE_ENDPOINT) must be one of {_VALID_GEE_ENDPOINTS}, got "
                             f"{self.GEE_ENDPOINT!r}")
        if not math.isfinite(float(self.GEE_DEADLINE_S)) or self.GEE_DEADLINE_S < _GEE_DEADLINE_MIN_S:
            log(f"GEE_DEADLINE_S={self.GEE_DEADLINE_S} is below the minimum {_GEE_DEADLINE_MIN_S:.0f} s (a shorter "
                "client deadline cuts off requests the server would still finish); using "
                f"{_GEE_DEADLINE_MIN_S:.0f} s", "WARNING")
            self.GEE_DEADLINE_S = _GEE_DEADLINE_MIN_S
        if self.TIME_BUDGET_H is not None and not (math.isfinite(self.TIME_BUDGET_H) and self.TIME_BUDGET_H > 0):
            raise ValueError(f"TIME_BUDGET_H must be > 0 hours or None, got {self.TIME_BUDGET_H!r}")
        if not (math.isfinite(float(self.TIME_RESERVE_S)) and self.TIME_RESERVE_S >= 0):
            raise ValueError(f"TIME_RESERVE_S must be >= 0 seconds, got {self.TIME_RESERVE_S!r}")
        self.STOP_AFTER = _parse_section_id(self.STOP_AFTER, "STOP_AFTER")
        if self.GRID_RES_M <= 0:
            raise ValueError(f"GRID_RES_M must be positive, got {self.GRID_RES_M}")
        if self.FINE_FACTOR < 1 or self.GRID_RES_M % self.FINE_FACTOR:
            raise ValueError(f"FINE_FACTOR={self.FINE_FACTOR} must be >= 1 and divide GRID_RES_M={self.GRID_RES_M}")
        if self.LC_FINE_RES_REQUEST is not None and self.LC_FINE_RES_REQUEST <= 0:
            raise ValueError(f"LC_FINE_RES_M must be positive, got {self.LC_FINE_RES_REQUEST}")
        if self.BOOT_BLOCK_KM is not None and self.BOOT_BLOCK_KM <= 0:
            raise ValueError(f"BOOT_BLOCK_KM must be positive or None, got {self.BOOT_BLOCK_KM}")
        for name in ("N_BOOTSTRAP", "N_MC", "N_LAND_REAL"):
            if getattr(self, name) < 0:
                raise ValueError(f"{name} must be >= 0, got {getattr(self, name)}")
        if self.N_FOLDS_BLOCK < 2:
            raise ValueError(f"N_FOLDS_BLOCK must be >= 2, got {self.N_FOLDS_BLOCK}")
        if "xgboost" not in self.BENCHMARKS:
            raise ValueError("BENCHMARKS must include 'xgboost' (it is the final/headline model)")
        self.FRAMES_OBS = sorted({int(y) for y in self.FRAMES_OBS})
        self.FRAMES_PROJ = sorted({int(y) for y in self.FRAMES_PROJ})
        hint = ("set LST_FRAMES_OBS to a comma list of SPEC frames, e.g. 1990,2000,2020,2025 for a pilot or leave it "
                "unset for the profile default")
        unknown = [y for y in self.FRAMES_OBS if y not in _FRAMES_OBS_ALL]
        if unknown:
            raise ValueError(f"FRAMES_OBS {self.FRAMES_OBS}: {unknown} are not SPEC frames {_FRAMES_OBS_ALL}; {hint}")
        missing_windows = [y for y in self.FRAMES_OBS if y not in self.WINDOWS]
        if missing_windows:
            raise ValueError(f"CFG.WINDOWS has no window for observed frame(s) {missing_windows}")
        if len(self.FRAMES_OBS) < 2:
            raise ValueError(f"FRAMES_OBS {self.FRAMES_OBS}: at least 2 observed frames are needed (leave-one-epoch-"
                             f"out validation and frame weights); {hint}")
        # Night training frames are those observed frames that carry an Aqua/VIIRS target (SPEC §3.3); the pilot
        # profile therefore trains night on its subset only.
        self.NIGHT_TRAIN_FRAMES = [y for y in sorted(self.NIGHT_TRAIN_FRAMES) if y in self.FRAMES_OBS]
        if len(self.NIGHT_TRAIN_FRAMES) < 2:
            raise ValueError(f"FRAMES_OBS {self.FRAMES_OBS} leave {len(self.NIGHT_TRAIN_FRAMES)} night training "
                             f"frame(s) {self.NIGHT_TRAIN_FRAMES}; the night model needs at least 2 of "
                             f"{_NIGHT_TRAIN_ALL}; {hint}")
        if self.NOW not in self.FRAMES_OBS:
            raise ValueError(f"FRAMES_OBS {self.FRAMES_OBS} must contain NOW={self.NOW} (the baseline frame); {hint}")
        if self.FRAMES_PROJ:
            need = {2005, 2015, 2025} - set(self.FRAMES_OBS)
            if need:
                raise ValueError(f"FRAMES_OBS {self.FRAMES_OBS} lacks {sorted(need)}: projections (FRAMES_PROJ "
                                 f"{self.FRAMES_PROJ}) need 2005, 2015 and 2025 (land-change calibration and "
                                 f"hindcast); {hint}, or use LST_PROFILE=pilot (no projections)")
        if self.FRAMES_PROJ and (self.N_MC < 1 or self.N_LAND_REAL < 1):
            raise ValueError("projections requested (FRAMES_PROJ non-empty) but N_MC / N_LAND_REAL < 1")
        if self.FRAMES_PROJ and min(self.FRAMES_PROJ) <= self.NOW:
            raise ValueError(f"projection frames must lie after NOW={self.NOW}: {self.FRAMES_PROJ}")
        self.PROJ_WINDOWS = {y: _projection_window(y) for y in [self.NOW] + list(self.FRAMES_PROJ)}
        self.LC_SOURCES = {y: "glc_fcs30d" for y in self.FRAMES_OBS}
        self.OUTPUT_DIR = Path(self.OUTPUT_DIR).expanduser().resolve()
        self.CACHE_DIR = self.OUTPUT_DIR / "cache"
        self.STAGE_DIR = self.CACHE_DIR / "stages"
        self.FIG_DIR = self.OUTPUT_DIR / "figures"
        self.PARQUET_DIR = self.OUTPUT_DIR / "parquet"
        self.GEO_DIR = self.OUTPUT_DIR / "geo"
        self.MODEL_DIR = self.OUTPUT_DIR / "models"
        self.NPZ_DIR = self.OUTPUT_DIR / "npz"
        self.WEB_DIR = self.OUTPUT_DIR / "web"

    # v1 compatibility: v1 code iterates CFG.EPOCHS; in v2 the observed frames play that role.
    @property
    def EPOCHS(self) -> list:
        return self.FRAMES_OBS

    @property
    def FINE_RES_M(self) -> Optional[int]:
        """v1 name of the land-cover fine resolution (= LC_FINE_RES_M)."""
        return self.LC_FINE_RES_M

    @classmethod
    def from_env(cls) -> "LSTConfig":
        """Build the configuration from profile defaults + ``LST_*`` environment variables + Kaggle secrets."""
        overrides: dict = {}

        def _note(name: str) -> None:
            if _env_str(name) is not None:
                overrides[name] = _env_str(name)

        fast_flag = _env_bool("LST_FAST_DEV", False)
        profile_env = (_env_str("LST_PROFILE") or "").lower() or None
        if profile_env is not None and profile_env not in _VALID_PROFILES:
            raise ValueError(f"LST_PROFILE={profile_env!r}; choose from {_VALID_PROFILES}")
        if profile_env is not None:
            profile = profile_env
            if fast_flag and profile != "fast":
                log(f"LST_FAST_DEV=1 ignored because LST_PROFILE={profile} was set explicitly", "WARNING")
        else:
            profile = "fast" if fast_flag else "full"
        d = _PROFILE_DEFAULTS[profile]
        for name in ("LST_PROFILE", "LST_FAST_DEV", "LST_RUN_MODE", "LST_GRID_RES_M", "LST_FINE_FACTOR",
                     "LST_LC_FINE_RES_M", "LST_FINE_RES_M", "LST_N_BOOTSTRAP", "LST_N_MC", "LST_N_LAND_REAL",
                     "LST_BENCHMARKS", "LST_GEE_EXPORT", "LST_GEE_ASSET_ROOT", "LST_RESUME", "LST_CACHE_IMPORT",
                     "LST_OUTPUT_DIR", "LST_GEE_WORKERS", "LST_BOOT_BLOCK_KM", "LST_LST_MIN_OBS",
                     "LST_USE_RAPIDS", "LST_INSTALL_RAPIDS", "LST_TARGET_MODE",
                     # v2 run control (D21 k); some are read by their own section (03-06)
                     "LST_FRAMES_OBS", "LST_PILOT_PROBES", "LST_GEE_ENDPOINT", "LST_GEE_DEADLINE_S",
                     "LST_GEE_EXPORT_TIMEOUT_S", "LST_GEE_EXPORT_QUEUE_S", "LST_GEE_EXPORT_TIMEOUT_0405_S",
                     "LST_TIME_BUDGET_H", "LST_TIME_RESERVE_S", "LST_STOP_AFTER", "LST_INVALIDATE",
                     "LST_PACK_CACHE", "LST_FRAME_MIN_COVERAGE", "LST_DAY_MIN_FRAME_COVERAGE"):
            _note(name)
        frames_obs = (_parse_frames(_env_str("LST_FRAMES_OBS")) if _env_str("LST_FRAMES_OBS")
                      else list(d["FRAMES_OBS"]))

        cache_import = _env_str("LST_CACHE_IMPORT", "auto")
        if cache_import.lower() in {"0", "off", "false", "no", "none", "n"}:
            cache_import = "off"
        elif cache_import.lower() == "auto":
            cache_import = "auto"
        lc_request = _env_int("LST_LC_FINE_RES_M", None)
        if lc_request is None and _env_int("LST_FINE_RES_M", None) is not None:
            lc_request = _env_int("LST_FINE_RES_M", None)
            log("LST_FINE_RES_M is the v1 name of LST_LC_FINE_RES_M (applied)", "DEBUG")
        default_out = Path("/kaggle/working/outputs") if _IS_KAGGLE else Path.cwd() / "outputs"
        cfg = cls(
            PROFILE=profile,
            RUN_MODE=(_env_str("LST_RUN_MODE", "auto") or "auto").lower(),
            FAST_DEV=profile == "fast",
            RESUME=_env_bool("LST_RESUME", True),
            CACHE_IMPORT=cache_import,
            INVALIDATE=_parse_invalidate(_env_str("LST_INVALIDATE")),
            PACK_CACHE=_env_bool("LST_PACK_CACHE", _IS_KAGGLE),
            TIME_BUDGET_H=_env_hours("LST_TIME_BUDGET_H", 11.0 if _IS_KAGGLE else None),
            TIME_RESERVE_S=_env_float("LST_TIME_RESERVE_S", 1800.0),
            STOP_AFTER=_parse_section_id(_env_str("LST_STOP_AFTER"), "LST_STOP_AFTER"),
            FRAMES_OBS=frames_obs,
            FRAMES_PROJ=list(d["FRAMES_PROJ"]),
            GRID_RES_M=_env_int("LST_GRID_RES_M", 1000),
            FINE_FACTOR=_env_int("LST_FINE_FACTOR", 4),
            LC_FINE_RES_DEFAULTS=dict(d["LC_FINE_RES_M"]),
            LC_FINE_RES_REQUEST=lc_request,
            TARGET_MODE=(_env_str("LST_TARGET_MODE", "anomaly") or "anomaly").lower(),
            BLOCK_KM=d["BLOCK_KM"],
            N_FOLDS_BLOCK=d["N_FOLDS_BLOCK"],
            BENCHMARKS=(_parse_benchmarks(_env_str("LST_BENCHMARKS")) if _env_str("LST_BENCHMARKS")
                        else list(d["BENCHMARKS"])),
            N_BOOTSTRAP=_env_int("LST_N_BOOTSTRAP", d["N_BOOTSTRAP"]),
            N_MC=_env_int("LST_N_MC", d["N_MC"]),
            N_LAND_REAL=_env_int("LST_N_LAND_REAL", d["N_LAND_REAL"]),
            XGB_MAX_ROUNDS=d["XGB_MAX_ROUNDS"],
            XGB_EARLY_STOP=d["XGB_EARLY_STOP"],
            GNN_EPOCHS=d["GNN_EPOCHS"],
            MORAN_PERMS=d["MORAN_PERMS"],
            GEE_PROJECT=_env_str("LST_GEE_PROJECT") or _kaggle_secret("GEE_PROJECT"),
            GEE_ENDPOINT=(_env_str("LST_GEE_ENDPOINT", "standard") or "standard").lower(),
            GEE_DEADLINE_S=_env_float("LST_GEE_DEADLINE_S", 420.0),
            GEE_EXPORT=(_env_str("LST_GEE_EXPORT", "interactive") or "interactive").lower(),
            GEE_ASSET_ROOT=_env_str("LST_GEE_ASSET_ROOT"),
            GEE_WORKERS=max(1, min(40, _env_int("LST_GEE_WORKERS", 6))),
            INSTALL_RAPIDS=_env_bool("LST_INSTALL_RAPIDS", False),
            USE_RAPIDS=_env_bool("LST_USE_RAPIDS", False) or _env_bool("LST_INSTALL_RAPIDS", False),
            BOOT_BLOCK_KM=_env_int("LST_BOOT_BLOCK_KM", None),
            LST_MIN_OBS=_env_int("LST_LST_MIN_OBS", 3),
            OUTPUT_DIR=Path(_env_str("LST_OUTPUT_DIR") or default_out),
            ENV_OVERRIDES=overrides,
        )
        if cfg.GEE_ASSET_ROOT is None and cfg.GEE_PROJECT:
            cfg.GEE_ASSET_ROOT = f"projects/{cfg.GEE_PROJECT}/assets/ncr_lst_v2"
        cfg.make_dirs()
        return cfg

    def make_dirs(self) -> None:
        """Create the output directory tree (idempotent)."""
        for path in (self.OUTPUT_DIR, self.CACHE_DIR, self.STAGE_DIR, self.FIG_DIR, self.PARQUET_DIR,
                     self.GEO_DIR, self.MODEL_DIR, self.NPZ_DIR, self.WEB_DIR):
            path.mkdir(parents=True, exist_ok=True)

    def _lc_fine_res_for(self, mode: str) -> int:
        """Requested land-cover resolution for ``mode`` (env > profile default) snapped to a divisor of GRID_RES_M."""
        requested = self.LC_FINE_RES_REQUEST
        if requested is None:
            requested = int(self.LC_FINE_RES_DEFAULTS.get(mode, 100))
        if requested <= 0:
            raise ValueError(f"LC_FINE_RES_M must be positive, got {requested}")
        if self.GRID_RES_M % requested == 0:
            return int(requested)
        snapped = _nearest_divisor(self.GRID_RES_M, requested)
        log(f"LC_FINE_RES_M={requested} does not divide GRID_RES_M={self.GRID_RES_M}; using {snapped} m", "WARNING")
        return int(snapped)

    def resolve_mode(self, mode: str) -> int:
        """Record the data mode decided by section 1 and fix LC_FINE_RES_M accordingly; returns it."""
        if mode not in ("gee", "synthetic"):
            raise ValueError(f"data mode must be 'gee' or 'synthetic', got {mode!r}")
        self.DATA_MODE = mode
        self.LC_FINE_RES_M = self._lc_fine_res_for(mode)
        return self.LC_FINE_RES_M

    def fine_res(self) -> int:
        """Land-cover fine resolution in metres (resolved value, else the RUN_MODE default). v1 API."""
        if self.LC_FINE_RES_M is not None:
            return int(self.LC_FINE_RES_M)
        return self._lc_fine_res_for("synthetic" if self.RUN_MODE == "synthetic" else "gee")

    def grid_fine_res(self) -> int:
        """Resolution (m) of the fine analysis grid ``GRID_FINE`` (250 m at the 1 km grid)."""
        return self.GRID_RES_M // self.FINE_FACTOR

    def window(self, year: int) -> tuple:
        """(first, last) calendar year of a frame: observation window, or the 20-year GCM window of a projection."""
        year = int(year)
        if year in self.WINDOWS:
            return tuple(self.WINDOWS[year])
        if year in self.PROJ_WINDOWS:
            return tuple(self.PROJ_WINDOWS[year])
        raise KeyError(f"no window defined for frame {year}")

    def xgb_params(self, device: str = "cpu", seed: Optional[int] = None, **overrides) -> dict:
        """Copy of ``XGB_PARAMS`` with ``device`` and ``seed`` injected (plus optional overrides)."""
        params = dict(self.XGB_PARAMS)
        params.update({"device": device, "seed": int(self.SEED if seed is None else seed)})
        params.update(overrides)
        return params

    def key(self, *names: str, **extra) -> dict:
        """JSON-able configuration subset for ``stage_cache`` keys.

        Always contains the identity of the run's data (mode, profile, grid, frames, seed) and the identity of the
        code that computes the stage: ``code = {"sec": <current section>, "sha": <its AST hash>}`` (from ``_CODE_SHA``,
        injected by build_notebook.py / run_local.py), ``shared = SHARED_CODE_TAG`` (helpers of 00-02) and, for the
        Earth Engine sections 03-05, ``code01`` (the section-01 fetch helpers). ``names`` adds further CFG fields,
        ``extra`` adds stage-specific values (e.g. a feature-list hash or a cross-section ``section_code_hash``).
        """
        base = {"data_mode": self.DATA_MODE, "profile": self.PROFILE, "grid_res_m": self.GRID_RES_M,
                "fine_factor": self.FINE_FACTOR, "lc_fine_res_m": self.LC_FINE_RES_M,
                "frames_obs": list(self.FRAMES_OBS), "seed": self.SEED}
        for name in names:
            base[name] = getattr(self, name)
        sec = globals().get("_CURRENT_SECTION")
        shas = globals().get("_CODE_SHA")
        if isinstance(shas, dict):
            base["code"] = {"sec": sec, "sha": shas.get(sec)}
        else:
            _warn_no_code_sha()
            base["code"] = None
        base["shared"] = SHARED_CODE_TAG
        if sec in ("03", "04", "05"):
            base["code01"] = shas.get("01") if isinstance(shas, dict) else None
        base.update(extra)
        return base

    def apply_hardware(self, env: dict) -> None:
        """Adjust hardware-dependent settings once ``ENV`` is known."""
        self.SHAP_INTERACTION_MAX_ROWS = None if env.get("xgb_device") == "cuda" else 4000

    def as_dict(self) -> dict:
        """JSON-friendly snapshot (Paths as strings) for logging and the export manifest."""
        out = {}
        for f in fields(self):
            value = getattr(self, f.name)
            out[f.name] = str(value) if isinstance(value, Path) else value
        out["LC_FINE_RES_M"] = self.LC_FINE_RES_M
        out["GRID_FINE_RES_M"] = self.grid_fine_res()
        return out


CFG = LSTConfig.from_env()
log(f"CFG: PROFILE={CFG.PROFILE} RUN_MODE={CFG.RUN_MODE} GRID_RES_M={CFG.GRID_RES_M} "
    f"(fine {CFG.grid_fine_res()} m) FRAMES_OBS={CFG.FRAMES_OBS} FRAMES_PROJ={CFG.FRAMES_PROJ or '[] (none)'} "
    f"OUTPUT_DIR={CFG.OUTPUT_DIR}")
if CFG.ENV_OVERRIDES:
    log("environment overrides: " + ", ".join(f"{k}={v}" for k, v in sorted(CFG.ENV_OVERRIDES.items())))
log(f"run control: time budget {f'{CFG.TIME_BUDGET_H:g} h' if CFG.TIME_BUDGET_H else 'unlimited'} (reserve "
    f"{CFG.TIME_RESERVE_S:.0f} s), stop after section {CFG.STOP_AFTER or '-'}, pack cache {CFG.PACK_CACHE}, "
    f"invalidate {CFG.INVALIDATE or '-'}, Earth Engine endpoint {CFG.GEE_ENDPOINT} (deadline "
    f"{CFG.GEE_DEADLINE_S:.0f} s)")
if CFG.PROFILE == "pilot":
    log(f"PILOT profile: frames {CFG.FRAMES_OBS}, no projections, benchmarks {CFG.BENCHMARKS} (with Earth Engine "
        "plus the CMIP6 warming-pattern probe of section 05, LST_PILOT_PROBES) - an Earth Engine cost/runtime probe, "
        "not a publishable run", "WARNING")

# %% [markdown]
# ## 0.4 Hardware detection (`ENV`)
# The GPU count comes from the **CUDA runtime** (`torch.cuda.device_count()`, else CuPy), which honours
# `CUDA_VISIBLE_DEVICES`; `nvidia-smi` (NVML ignores that variable) is only the fallback when neither can be
# queried, and its rows are filtered by `CUDA_VISIBLE_DEVICES`. XGBoost trains on CUDA only if GPUs exist **and**
# the installed wheel was built with CUDA (`xgboost.build_info()["USE_CUDA"]`, with a tiny training probe as
# fallback). RAPIDS (cuDF/cuML) is used only with `LST_USE_RAPIDS=1` (or `LST_INSTALL_RAPIDS=1`).
# `ENV["rapids_used"]` records which RAPIDS backends actually ran.

# %%
cp = _optional_import("cupy")
cudf = _optional_import("cudf") if CFG.USE_RAPIDS else None
cuml = _optional_import("cuml") if CFG.USE_RAPIDS else None
if not CFG.USE_RAPIDS and (_is_importable("cudf") or _is_importable("cuml")):
    log("cuDF/cuML are installed but not used (set LST_USE_RAPIDS=1 to enable the RAPIDS paths)")


def _query_nvidia_smi() -> list:
    """Return [(index, name, total_MiB), ...] from nvidia-smi, or [] if unavailable."""
    exe = shutil.which("nvidia-smi")
    if exe is None:
        return []
    try:
        proc = subprocess.run([exe, "--query-gpu=index,name,memory.total", "--format=csv,noheader,nounits"],
                              capture_output=True, text=True, timeout=20)
    except (subprocess.TimeoutExpired, OSError) as exc:
        log(f"nvidia-smi failed: {exc}", "WARNING")
        return []
    gpus = []
    for line in proc.stdout.strip().splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 3 and parts[1]:
            try:
                index = int(parts[0])
            except ValueError:
                index = len(gpus)
            try:
                gpus.append((index, parts[1], int(float(parts[2]))))
            except ValueError:
                gpus.append((index, parts[1], None))
    return gpus


def _visible_device_filter(smi: list) -> list:
    """Restrict nvidia-smi rows to CUDA_VISIBLE_DEVICES (integer ordinals only; UUID/MIG lists are left as-is)."""
    raw = os.environ.get("CUDA_VISIBLE_DEVICES")
    if raw is None:
        return smi
    tokens = [t.strip() for t in raw.split(",") if t.strip()]
    if not tokens or raw.strip() in ("-1", "none", "NoDevFiles"):
        return []
    try:
        wanted = [int(t) for t in tokens]
    except ValueError:
        return smi
    by_index = {row[0]: row for row in smi}
    out = []
    for w in wanted:          # CUDA stops at the first invalid ordinal
        if w not in by_index:
            break
        out.append(by_index[w])
    return out


def _cupy_device_count() -> int:
    if cp is None:
        return 0
    try:
        return int(cp.cuda.runtime.getDeviceCount())
    except Exception:  # noqa: BLE001 - no driver / no device
        return 0


def _torch_device_count() -> int:
    if torch is None:
        return 0
    try:
        return int(torch.cuda.device_count()) if torch.cuda.is_available() else 0
    except Exception:  # noqa: BLE001 - broken CUDA runtime counts as "no GPU"
        return 0


def _xgb_has_cuda_build() -> bool:
    """Was the installed XGBoost built with CUDA? (build_info, else a 1-round GPU training probe)."""
    if xgb is None:
        return False
    try:
        return bool(xgb.build_info().get("USE_CUDA", False))
    except Exception:  # noqa: BLE001 - very old versions have no build_info
        pass
    try:
        probe = xgb.DMatrix(np.random.default_rng(0).random((64, 3)), label=np.arange(64, dtype=float))
        xgb.train({"device": "cuda", "tree_method": "hist", "verbosity": 0}, probe, num_boost_round=1)
        return True
    except Exception:  # noqa: BLE001
        return False


def _detect_env() -> dict:
    """Collect hardware/software facts into the SPEC ``ENV`` dict."""
    smi_all = _query_nvidia_smi()
    smi = _visible_device_filter(smi_all)
    torch_count = _torch_device_count()
    cuda_count = torch_count or _cupy_device_count()
    n_gpus = cuda_count if cuda_count > 0 else len(smi)
    if cuda_count > 0 and len(smi_all) and len(smi_all) != cuda_count:
        log(f"nvidia-smi lists {len(smi_all)} GPU(s) but the CUDA runtime exposes {cuda_count} "
            f"(CUDA_VISIBLE_DEVICES={os.environ.get('CUDA_VISIBLE_DEVICES')!r}); using {cuda_count}", "WARNING")
    gpu_names = [name for _, name, _ in smi][:n_gpus]
    gpu_mem = [mem for _, _, mem in smi][:n_gpus]
    if len(gpu_names) < n_gpus and torch_count:
        gpu_names = [torch.cuda.get_device_name(i) for i in range(torch_count)]
    has_cuda = n_gpus > 0
    xgb_cuda = has_cuda and _xgb_has_cuda_build()
    return {
        "is_kaggle": _IS_KAGGLE,
        "n_gpus": int(n_gpus),
        "gpu_names": gpu_names,
        "gpu_mem_mib": gpu_mem,
        "has_cuda": bool(has_cuda),
        "torch_device_count": int(torch_count),
        "has_cudf": cudf is not None,
        "has_cuml": cuml is not None,
        "has_cupy": cp is not None and has_cuda,
        "rapids_used": set(),   # filled by the stages that actually ran a cuDF/cuML backend
        "xgb_version": getattr(xgb, "__version__", None),
        "xgb_device": "cuda" if xgb_cuda else "cpu",
        "lgbm_device": "cpu",   # resolved by section 07 after a GPU probe
        "torch_version": getattr(torch, "__version__", None),
        "python": platform.python_version(),
        "platform": platform.platform(),
        "cpu_count": os.cpu_count() or 1,
    }


ENV = _detect_env()
CFG.apply_hardware(ENV)
log(f"ENV: {ENV['n_gpus']} GPU(s) {ENV['gpu_names']} | xgb {ENV['xgb_version']} on {ENV['xgb_device']} | "
    f"cupy={ENV['has_cupy']} cudf={ENV['has_cudf']} cuml={ENV['has_cuml']} | {ENV['cpu_count']} CPU threads")
if ENV["has_cuda"] and ENV["xgb_device"] == "cpu":
    log("GPUs found but this XGBoost build has no CUDA support - XGBoost will run on CPU.", "WARNING")

# %% [markdown]
# ## 0.5 Shared utilities
# Timing, memory hygiene (host + CUDA + CuPy pools), retry with exponential backoff and jitter, deterministic
# seeding, strict JSON writing (NaN → `null`, numpy/pandas aware, optional gzip), GPU memory reporting and a
# multi-GPU work scheduler that pins one task per GPU at a time.

# %%
TIMINGS: dict = {}
_RETRY_RNG = random.Random()   # private RNG so backoff jitter never perturbs seeded global streams


@contextmanager
def timer(name: str):
    """Context manager that logs and accumulates wall-clock seconds for ``name`` into ``TIMINGS``."""
    start = time.perf_counter()
    log(f">> {name}")
    try:
        yield
    finally:
        elapsed = time.perf_counter() - start
        TIMINGS[name] = round(TIMINGS.get(name, 0.0) + elapsed, 3)
        log(f"<< {name}: {elapsed:.1f}s")


def free_memory() -> None:
    """Release host and GPU memory: Python GC, PyTorch CUDA cache/IPC handles, CuPy memory pools."""
    gc.collect()
    if torch is not None:
        try:
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
                torch.cuda.ipc_collect()
        except Exception as exc:  # noqa: BLE001 - never fail a pipeline on cleanup
            log(f"torch cache cleanup failed: {exc}", "DEBUG")
    if cp is not None and ENV.get("has_cupy"):
        try:
            # get_default_memory_pool() frees only the CURRENT device's pool; blocks cached on the other GPUs
            # (e.g. CV folds run on cuda:1 by a worker thread) need their own device context.
            for device_id in range(int(cp.cuda.runtime.getDeviceCount())):
                with cp.cuda.Device(device_id):
                    cp.get_default_memory_pool().free_all_blocks()
            cp.get_default_pinned_memory_pool().free_all_blocks()
        except Exception as exc:  # noqa: BLE001
            log(f"cupy pool cleanup failed: {exc}", "DEBUG")


def retry(fn: Callable[[], Any], *, tries: int = 3, base_delay: float = 1.0, max_delay: float = 60.0,
          retry_on: tuple = (Exception,), on_retry: Optional[Callable[[int, BaseException, float], None]] = None):
    """Call ``fn()`` up to ``tries`` times with exponential backoff and jitter.

    Delay before attempt k+1 = min(max_delay, base_delay·2^(k-1)) scaled by a uniform jitter in [0.5, 1.0]
    (decorrelates parallel workers hitting the same quota). Only exceptions in ``retry_on`` are retried;
    ``on_retry(attempt, exc, delay)`` is called before sleeping. The last exception is re-raised.
    """
    if tries < 1:
        raise ValueError("tries must be >= 1")
    for attempt in range(1, tries + 1):
        try:
            return fn()
        except retry_on as exc:
            if attempt == tries:
                raise
            delay = min(max_delay, base_delay * 2 ** (attempt - 1)) * _RETRY_RNG.uniform(0.5, 1.0)
            if on_retry is not None:
                on_retry(attempt, exc, delay)
            time.sleep(delay)
    raise RuntimeError("unreachable")


def set_seeds(seed: int) -> int:
    """Seed Python, NumPy, PyTorch (CPU + all CUDA devices) and CuPy; export PYTHONHASHSEED.

    PYTHONHASHSEED only affects subprocesses (the running interpreter's hash seed is fixed at start-up).
    """
    random.seed(seed)
    np.random.seed(seed)
    os.environ["PYTHONHASHSEED"] = str(seed)
    if torch is not None:
        torch.manual_seed(seed)
        try:
            if torch.cuda.is_available():
                torch.cuda.manual_seed_all(seed)
        except Exception:  # noqa: BLE001
            pass
    if cp is not None and ENV.get("has_cupy"):
        try:
            cp.random.seed(seed)
        except Exception:  # noqa: BLE001
            pass
    return seed


def _json_float(value: float, ndigits: Optional[int]):
    if not math.isfinite(value):
        return None
    return round(value, ndigits) if ndigits is not None else value


def _to_jsonable(obj: Any, ndigits: Optional[int]):
    """Recursively convert numpy/pandas/pathlib/dataclass objects into strict-JSON-compatible values."""
    if obj is None or isinstance(obj, (bool, str)):
        return obj
    if isinstance(obj, (np.bool_,)):
        return bool(obj)
    if isinstance(obj, (int, np.integer)):
        return int(obj)
    if isinstance(obj, (float, np.floating)):
        return _json_float(float(obj), ndigits)
    if isinstance(obj, dict):
        return {str(_to_jsonable(k, None)) if not isinstance(k, str) else k: _to_jsonable(v, ndigits)
                for k, v in obj.items()}
    if isinstance(obj, (list, tuple, set, frozenset)):
        return [_to_jsonable(v, ndigits) for v in obj]
    if isinstance(obj, np.ndarray):
        if obj.dtype.kind in "fc":
            arr = np.asarray(obj.real if obj.dtype.kind == "c" else obj, dtype=np.float64)
            if ndigits is not None:
                arr = np.round(arr, ndigits)
            return _to_jsonable(arr.tolist(), None)
        return _to_jsonable(obj.tolist(), ndigits)
    if isinstance(obj, pd.DataFrame):
        return _to_jsonable(obj.to_dict(orient="records"), ndigits)
    if isinstance(obj, (pd.Series, pd.Index)):
        return _to_jsonable(obj.tolist(), ndigits)
    if obj is pd.NaT:
        return None
    if isinstance(obj, (pd.Timestamp, datetime, date)):
        return obj.isoformat()
    if isinstance(obj, Path):
        return str(obj)
    if is_dataclass(obj) and not isinstance(obj, type):
        return _to_jsonable(asdict(obj), ndigits)
    if hasattr(obj, "item") and callable(obj.item):     # 0-d arrays, cupy/torch scalars
        return _to_jsonable(obj.item(), ndigits)
    raise TypeError(f"save_json: cannot serialise object of type {type(obj).__name__}")


def _write_bytes_atomic(path: Path, data: bytes) -> Path:
    """Write ``data`` to ``path`` via a temporary sibling + rename (never leaves a truncated file behind)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    try:
        with open(tmp, "wb") as fh:
            fh.write(data)
        os.replace(tmp, path)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise
    return path


def _gzip_bytes(data: bytes, level: int = 9) -> bytes:
    """Deterministic gzip (mtime 0, no file name) so identical content gives identical bytes."""
    buf = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", compresslevel=level, fileobj=buf, mtime=0) as gz:
        gz.write(data)
    return buf.getvalue()


def save_json(obj: Any, path, *, round_floats: Optional[int] = None) -> Path:
    """Write ``obj`` as strict UTF-8 JSON (NaN/Inf → null, numpy/pandas aware, compact separators).

    ``round_floats`` rounds every float to that many decimals. A path ending in ``.gz`` is gzip-compressed (level 9,
    deterministic header) - the web bundle's ``*.json.gz`` files. The file is written atomically.
    """
    path = Path(path)
    text = json.dumps(_to_jsonable(obj, round_floats), ensure_ascii=False, separators=(",", ":"),
                      allow_nan=False)
    data = text.encode("utf-8")
    if path.suffix == ".gz":
        data = _gzip_bytes(data, 9)
    return _write_bytes_atomic(path, data)


def gpu_mem_report(log_it: bool = True) -> list:
    """Per-GPU memory usage [{gpu, name, used_mib, total_mib, torch_allocated_mib}] (empty without GPUs)."""
    report = []
    if torch is not None and ENV.get("torch_device_count", 0) > 0:
        for i in range(ENV["torch_device_count"]):
            try:
                free_b, total_b = torch.cuda.mem_get_info(i)
                report.append({"gpu": i, "name": torch.cuda.get_device_name(i),
                               "used_mib": round((total_b - free_b) / 2**20),
                               "total_mib": round(total_b / 2**20),
                               "torch_allocated_mib": round(torch.cuda.memory_allocated(i) / 2**20)})
            except Exception as exc:  # noqa: BLE001
                log(f"mem_get_info failed on GPU {i}: {exc}", "DEBUG")
    elif ENV.get("n_gpus", 0) > 0 and shutil.which("nvidia-smi"):
        try:
            proc = subprocess.run(["nvidia-smi", "--query-gpu=index,name,memory.used,memory.total",
                                   "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=20)
            for line in proc.stdout.strip().splitlines():
                idx, name, used, total = [p.strip() for p in line.split(",")]
                report.append({"gpu": int(idx), "name": name, "used_mib": int(float(used)),
                               "total_mib": int(float(total)), "torch_allocated_mib": None})
        except (subprocess.TimeoutExpired, OSError, ValueError) as exc:
            log(f"nvidia-smi memory query failed: {exc}", "DEBUG")
    if log_it:
        if report:
            log("GPU memory: " + " | ".join(f"GPU{r['gpu']} {r['used_mib']}/{r['total_mib']} MiB" for r in report))
        else:
            log("GPU memory: no CUDA devices")
    return report


def xgb_device_for(gpu_id: int) -> str:
    """XGBoost ``device`` string for a worker: ``"cuda:{gpu_id}"`` when XGBoost can use CUDA, else ``"cpu"``."""
    if ENV.get("xgb_device") != "cuda":
        return "cpu"
    gpu_id = int(gpu_id)
    if not 0 <= gpu_id < max(1, ENV.get("n_gpus", 0)):
        raise ValueError(f"gpu_id {gpu_id} out of range for {ENV.get('n_gpus')} GPU(s)")
    return f"cuda:{gpu_id}"


def _annotate_task_error(exc: BaseException, index: int, item: Any, gpu_id: int) -> None:
    context = f"gpu_pool_map task #{index} (item={str(item)[:120]}) failed on gpu_id={gpu_id}"
    log(f"{context}: {type(exc).__name__}: {str(exc)[:300]}", "ERROR")
    if hasattr(exc, "add_note"):   # Python >= 3.11: context shows up in the traceback
        exc.add_note(context)


def gpu_pool_map(fn: Callable[[Any, int], Any], items: Iterable) -> list:
    """Run ``fn(item, gpu_id)`` for every item, one concurrent task per GPU; results keep input order.

    With ≥2 CUDA GPUs usable by XGBoost, a thread pool with one worker per GPU pulls free GPU ids from a queue, so
    each GPU runs exactly one task at a time (XGBoost/PyTorch release the GIL inside CUDA work, so threads give real
    parallelism). Otherwise tasks run sequentially with ``gpu_id=0`` (``xgb_device_for(0)`` then yields "cpu" on
    CPU-only machines). The first failure cancels pending tasks and is re-raised with its original type, annotated
    with the failing item and GPU.

    **Time budget** (section 0.5.1): before starting every item the run budget is checked with an expected duration
    of 1.25 × the longest item finished so far in this call. When it is exhausted no further item is started, the
    items already running finish (their own stage caches are saved), and ``LSTStop`` is raised in the caller; this
    is a clean stop, not a task failure, so it is not logged as an error.
    """
    items = list(items)
    n_workers = ENV.get("n_gpus", 0) if ENV.get("xgb_device") == "cuda" else 0
    if n_workers <= 1 or len(items) <= 1:
        results = []
        longest = 0.0
        for i, item in enumerate(items):
            check_budget(f"gpu_pool_map item {i + 1}/{len(items)}", 1.25 * longest)
            t0 = time.perf_counter()
            try:
                results.append(fn(item, 0))
            except LSTStop:
                raise
            except BaseException as exc:
                _annotate_task_error(exc, i, item, 0)
                raise
            longest = max(longest, time.perf_counter() - t0)
        return results

    free_gpus: "queue.Queue[int]" = queue.Queue()
    for gpu_id in range(n_workers):
        free_gpus.put(gpu_id)
    stop = threading.Event()
    longest = [0.0]
    longest_lock = threading.Lock()

    def _task(index: int, item: Any):
        gpu_id = free_gpus.get()
        try:
            if stop.is_set():
                raise LSTStop(LST_STOP_REASON or "time budget: gpu_pool_map")
            try:
                check_budget(f"gpu_pool_map item {index + 1}/{len(items)}", 1.25 * longest[0])
            except LSTStop:
                stop.set()
                raise
            t0 = time.perf_counter()
            out = fn(item, gpu_id)
            with longest_lock:
                longest[0] = max(longest[0], time.perf_counter() - t0)
            return out
        except LSTStop:
            stop.set()
            raise
        except BaseException as exc:
            _annotate_task_error(exc, index, item, gpu_id)
            raise
        finally:
            free_gpus.put(gpu_id)

    results: list = [None] * len(items)
    with ThreadPoolExecutor(max_workers=n_workers, thread_name_prefix="gpu") as pool:
        futures = {pool.submit(_task, i, item): i for i, item in enumerate(items)}
        try:
            for future in as_completed(futures):
                results[futures[future]] = future.result()
        except BaseException:
            # Clean stop or failure: nothing new starts; leaving the with-block waits for the running items.
            stop.set()
            for future in futures:
                future.cancel()
            raise
    return results


_OOM_MARKERS = ("out of memory", "cudaerrormemoryallocation", "bad_alloc", "cuda_error_out_of_memory",
                "memoryerror", "failed to allocate", "cusparse_status_alloc_failed",
                "cusparse_status_insufficient_resources", "cublas_status_alloc_failed",
                "cudnn_status_alloc_failed", "cufft_alloc_failed")


def _oom_in_chain(exc: BaseException, *, count_host_memory_error: bool) -> bool:
    torch_oom = getattr(getattr(torch, "cuda", None), "OutOfMemoryError", None) if torch is not None else None
    cupy_oom = None
    if cp is not None:
        cupy_oom = getattr(getattr(getattr(cp, "cuda", None), "memory", None), "OutOfMemoryError", None)
    seen, current = set(), exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if torch_oom is not None and isinstance(current, torch_oom):
            return True
        if cupy_oom is not None and isinstance(current, cupy_oom):
            return True
        if type(current) is MemoryError:
            # a bare MemoryError is the host running out of RAM
            if count_host_memory_error:
                return True
        else:
            message = f"{type(current).__name__}: {current}".lower()
            if any(marker in message for marker in _OOM_MARKERS):
                return True
        current = current.__cause__ or current.__context__
    return False


def is_oom_error(exc: BaseException) -> bool:
    """True if ``exc`` (or its cause/context chain) is a host OR GPU out-of-memory condition.

    Recognises MemoryError, torch.cuda.OutOfMemoryError, cupy OutOfMemoryError and XGBoost/CUDA/RMM/cuSPARSE/cuBLAS
    messages ("out of memory", "cudaErrorMemoryAllocation", "bad_alloc", "CUSPARSE_STATUS_ALLOC_FAILED", ...).
    """
    return _oom_in_chain(exc, count_host_memory_error=True)


def is_gpu_oom_error(exc: BaseException) -> bool:
    """True only for a GPU out-of-memory condition (a bare host ``MemoryError`` is excluded).

    Used to decide GPU -> CPU retries: moving work to the CPU after the *host* ran out of RAM needs more host memory,
    not less, so that case must propagate instead.
    """
    return _oom_in_chain(exc, count_host_memory_error=False)


set_seeds(CFG.SEED)
log("utilities ready")

# %% [markdown]
# ### 0.5.1 Time budget and clean stop (`LSTStop`)
# A Kaggle session is killed at 12 h, and a killed commit may leave **no usable output**. The run therefore watches
# its own wall clock (counted from the first code cell, `_RUN_T0`): with `LST_TIME_BUDGET_H` (default 11 h on
# Kaggle, unlimited elsewhere) it stops *starting* new work once less than `LST_TIME_RESERVE_S` (default 1800 s) plus
# the expected duration of the next unit is left. The checks sit where long work starts: every `gpu_pool_map` item,
# every stage-cache MISS (expected = 1.25 × the last compute time of that stage name), every Earth Engine tile, every
# Landsat frame, every export poll and every GDDP block. A stop raises `LSTStop` (a `BaseException`, so ordinary
# `except Exception` handlers never swallow it), the cell that was running ends normally, `RUN_STOPPED.json` records
# why, the cache is packed (section 0.6) and every later cell prints one `skipped: run stopped (...)` line - the
# notebook finishes successfully and the Kaggle version keeps its output for a resume.
# `LST_STOP_AFTER=NN` stops the same way right after section NN (e.g. `06`: Earth Engine extraction + features in a
# first commit, modelling in a second one). API: `time_left_s()`, `budget_exhausted(expected_s)`,
# `check_budget(where, expected_s)`, `request_stop(reason)`, `finalize_stop()`.

# %%
class LSTStop(BaseException):
    """Clean stop of the run (time budget or LST_STOP_AFTER); not an error. Handled at cell/section boundaries."""


_LST_STOP_LOCK = threading.RLock()
_LST_FINALIZED = False
_LST_STOP_SECTION = None


def time_left_s() -> float:
    """Seconds left in the run's time budget (``math.inf`` without a budget)."""
    if CFG.TIME_BUDGET_H is None:
        return math.inf
    return float(_RUN_T0 + float(CFG.TIME_BUDGET_H) * 3600.0 - time.time())


def budget_exhausted(expected_s: float = 0.0) -> bool:
    """True when the run was stopped, or less than ``expected_s + CFG.TIME_RESERVE_S`` seconds are left."""
    if LST_STOPPED:
        return True
    left = time_left_s()
    if not math.isfinite(left):
        return False
    return left < max(0.0, float(expected_s or 0.0)) + float(CFG.TIME_RESERVE_S)


def request_stop(reason: str) -> None:
    """Mark the run as stopped (thread-safe, idempotent: the first reason wins). Never packs; see finalize_stop."""
    global LST_STOPPED, LST_STOP_REASON, _LST_STOP_SECTION
    with _LST_STOP_LOCK:
        if LST_STOPPED:
            return
        LST_STOPPED = True
        LST_STOP_REASON = str(reason)
        _LST_STOP_SECTION = _CURRENT_SECTION
    left = time_left_s()
    bar = "#" * 96
    log(f"\n{bar}\n#  RUN STOPPING CLEANLY in section {_CURRENT_SECTION}: {reason}\n#  elapsed "
        f"{(time.time() - _RUN_T0) / 3600:.2f} h, budget "
        f"{f'{CFG.TIME_BUDGET_H:g} h' if CFG.TIME_BUDGET_H else 'unlimited'}"
        f"{f', {left / 60:.0f} min left' if math.isfinite(left) else ''}. Running work finishes; nothing new starts."
        f"\n{bar}", "WARNING")


def check_budget(where: str, expected_s: float = 0.0) -> None:
    """Raise ``LSTStop`` (after ``request_stop``) when ``budget_exhausted(expected_s)``; otherwise do nothing."""
    if budget_exhausted(expected_s):
        request_stop(f"time budget: {where}")
        raise LSTStop(LST_STOP_REASON or f"time budget: {where}")


def finalize_stop() -> None:
    """Write ``RUN_STOPPED.json``, pack the cache and log how to resume (idempotent; cell/section boundaries only)."""
    global _LST_FINALIZED
    with _LST_STOP_LOCK:
        if _LST_FINALIZED:
            return
        _LST_FINALIZED = True
    if not LST_STOPPED:
        request_stop("finalize_stop() called")
    info = {"reason": LST_STOP_REASON, "section": _LST_STOP_SECTION or _CURRENT_SECTION,
            "elapsed_h": round((time.time() - _RUN_T0) / 3600.0, 3), "time_budget_h": CFG.TIME_BUDGET_H,
            "stop_after": CFG.STOP_AFTER, "profile": CFG.PROFILE, "utc": datetime.now(timezone.utc)}
    try:
        save_json(info, CFG.OUTPUT_DIR / "RUN_STOPPED.json")
    except Exception as exc:  # noqa: BLE001 - the stop itself must succeed
        log(f"could not write RUN_STOPPED.json: {type(exc).__name__}: {exc}", "WARNING")
    try:
        pack_cache()
    except Exception as exc:  # noqa: BLE001
        log(f"pack_cache failed during the clean stop: {type(exc).__name__}: {str(exc)[:300]}", "WARNING")
    log(f"run stopped cleanly ({LST_STOP_REASON}); {CFG.OUTPUT_DIR / 'RUN_STOPPED.json'} written. To resume: let "
        "this version finish (Save & Run All / Commit keeps outputs/), then attach its output (Input -> + Add Input "
        "-> Notebooks -> Your Work -> this notebook; that is the newest version's output, so save no other version "
        "in between) and run again: LST_CACHE_IMPORT=auto restores the stage, tile and GDDP caches, so finished "
        "stages are not recomputed.", "WARNING")


def _lst_on_stop(exc: BaseException) -> None:
    """Cell-level handler of ``LSTStop`` (used by the cell guard and run_local.py)."""
    request_stop(str(exc) or "LSTStop")
    finalize_stop()


def _lst_skip_cell() -> None:
    print(f"skipped: run stopped ({LST_STOP_REASON})", flush=True)


def _lst_show_last(value: Any) -> None:
    """Display the value of a guarded cell's last expression as Jupyter would (the guard nests it in a block)."""
    if value is not None:
        sys.displayhook(value)


def _lst_enter_section(nn) -> None:
    """Section marker (first code cell of sections 01-12, generated by build_notebook.py).

    Sets ``_CURRENT_SECTION`` (code identity of stage keys), logs elapsed/remaining time and stops the run cleanly
    before section ``nn`` when ``nn > CFG.STOP_AFTER`` or the time budget is exhausted.
    """
    global _CURRENT_SECTION
    nn = f"{int(nn):02d}"
    _CURRENT_SECTION = nn
    if LST_STOPPED:
        print(f"section {nn} skipped: run stopped ({LST_STOP_REASON})", flush=True)
        finalize_stop()
        return
    left = time_left_s()
    log(f"=== section {nn} | elapsed {(time.time() - _RUN_T0) / 3600:.2f} h | "
        + (f"{left / 3600:.2f} h left of the {CFG.TIME_BUDGET_H:g} h budget" if math.isfinite(left)
           else "no time budget") + " ===")
    if CFG.STOP_AFTER is not None and int(nn) > int(CFG.STOP_AFTER):
        request_stop(f"LST_STOP_AFTER={CFG.STOP_AFTER}: stopping before section {nn}")
        finalize_stop()
    elif budget_exhausted():
        request_stop(f"time budget: less than LST_TIME_RESERVE_S={CFG.TIME_RESERVE_S:.0f} s left before section {nn}")
        finalize_stop()


class _LSTCellGuard(ast.NodeTransformer):
    """IPython AST transformer: every later cell runs as
    ``if not LST_STOPPED: try: <cell> except LSTStop as e: _lst_on_stop(e)  else: _lst_skip_cell()``.

    The last expression of a cell is still displayed. Exempt: the first cell of section 00 (it resets the stop state,
    so a rerun from the top works) and the generated ``_CODE_SHA`` / ``_lst_enter_section`` cells. Never raises (on
    any problem the cell runs unchanged).
    """

    @staticmethod
    def _exempt(body: list) -> bool:
        for node in body:
            if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "_RUN_T0"
                                                    for t in node.targets):
                return True
        generated = True
        for node in body:
            is_marker = (isinstance(node, ast.Expr) and isinstance(node.value, ast.Call)
                         and isinstance(node.value.func, ast.Name) and node.value.func.id == "_lst_enter_section")
            is_sha = (isinstance(node, ast.Assign) and len(node.targets) == 1
                      and isinstance(node.targets[0], ast.Name) and node.targets[0].id == "_CODE_SHA")
            generated = generated and (is_marker or is_sha)
        return generated

    def visit_Module(self, node):  # noqa: N802 - ast API name
        try:
            body = list(node.body)
            if not body or self._exempt(body):
                return node
            if isinstance(body[-1], ast.Expr):
                last = body[-1]
                body[-1] = ast.copy_location(ast.Expr(value=ast.Call(
                    func=ast.Name(id="_lst_show_last", ctx=ast.Load()), args=[last.value], keywords=[])), last)
            handler = ast.ExceptHandler(
                type=ast.Name(id="LSTStop", ctx=ast.Load()), name="_lst_e",
                body=[ast.Expr(value=ast.Call(func=ast.Name(id="_lst_on_stop", ctx=ast.Load()),
                                              args=[ast.Name(id="_lst_e", ctx=ast.Load())], keywords=[]))])
            guarded = ast.Try(body=body, handlers=[handler], orelse=[], finalbody=[])
            skip = ast.Expr(value=ast.Call(func=ast.Name(id="_lst_skip_cell", ctx=ast.Load()), args=[], keywords=[]))
            wrapper = ast.If(test=ast.UnaryOp(op=ast.Not(), operand=ast.Name(id="LST_STOPPED", ctx=ast.Load())),
                             body=[guarded], orelse=[skip])
            new = ast.Module(body=[wrapper], type_ignores=list(getattr(node, "type_ignores", [])))
            ast.copy_location(wrapper, body[0])
            return ast.fix_missing_locations(new)
        except Exception:  # noqa: BLE001 - the guard must never break a cell
            return node


def _lst_install_cell_guard() -> bool:
    """Register the cell guard in the running IPython shell (idempotent); False outside IPython (run_local.py)."""
    try:
        from IPython import get_ipython
        shell = get_ipython()
    except Exception:  # noqa: BLE001 - no IPython
        return False
    if shell is None or not hasattr(shell, "ast_transformers"):
        return False
    try:
        shell.ast_transformers[:] = [t for t in shell.ast_transformers if type(t).__name__ != "_LSTCellGuard"]
        shell.ast_transformers.append(_LSTCellGuard())
    except Exception as exc:  # noqa: BLE001
        log(f"cell guard not installed ({type(exc).__name__}: {exc}); a time-budget stop then ends the run with an "
            "LSTStop error instead of skipping the remaining cells", "WARNING")
        return False
    log("cell guard installed: after a clean stop every later cell is skipped")
    return True


_LST_CELL_GUARD = _lst_install_cell_guard()
if CFG.TIME_BUDGET_H is not None:
    log(f"time budget {CFG.TIME_BUDGET_H:g} h from {datetime.fromtimestamp(_RUN_T0).strftime('%H:%M:%S')}: new work "
        f"stops when less than {CFG.TIME_RESERVE_S:.0f} s + the expected duration of the next unit is left")

# %% [markdown]
# ## 0.6 Stage cache, cache import and cache packing (resumable runs)
# A Kaggle GPU session stops after 12 h, and Earth Engine extraction or a full validation suite can take hours. Every
# heavy stage therefore follows the same pattern:
#
# ```python
# _sc = stage_cache("07_models_day", CFG.key("BENCHMARKS", "N_FOLDS_BLOCK", features=FEATURES))
# RESULT = _sc.load() if _sc.hit else _sc.save(compute())       # or: RESULT = _sc.get_or_compute(compute)
# ```
#
# The cache file is `CFG.CACHE_DIR/stages/<name>-<sha1(key)[:12]>.pkl`, where the key is the canonical JSON of
# **configuration + data fingerprints + code identity**: `CFG.key()` always adds `code = {sec, sha}` (the AST hash of
# the current section's code cells, computed by `build_notebook.py` and injected as `_CODE_SHA` in the notebook's first
# code cell; comments, docstrings and markdown do not change it), `shared = SHARED_CODE_TAG` (helpers of 00-02) and,
# for the Earth Engine sections 03-05, the section-01 hash. Editing a section's code therefore recomputes its stages
# on the next run - **edit `notebook/sections` and rebuild the notebook; never hand-edit cells on Kaggle** (a
# hand-edited cell keeps the hash it was built with). Cross-section dependencies are added by the owning stage with
# `section_code_hash('07', ...)`.
#
# * `LST_RESUME=0` recomputes (and overwrites) every stage; Earth Engine tiles and GDDP blocks stay cached.
# * `LST_INVALIDATE=06,07` recomputes only the stages whose name starts with one of the tokens (or with `s` + token,
#   e.g. `s04_thermal`); tiles and GDDP blocks are never invalidated by it.
# * Before a MISS is computed by `get_or_compute`, the time budget (0.5.1) is checked with 1.25 × the last compute time
#   of that stage name (trailing `_YYYY`, `_sspNNN`, `_day`, `_night` stripped); before its first compute in a session
#   the `compute_s` of the newest sidecar of that name in `stages/` (an earlier or imported run) is used.
# * Writes are atomic, a sidecar `.json` records the full key (checked on load), a corrupt entry is reported and
#   recomputed by `get_or_compute`. Classes and functions defined in the notebook itself (e.g. `GridSpec`) are pickled
#   **by name** and resolved from the notebook namespace on load (Jupyter and `run_local.py`).
#
# **Cache import** (`CFG.CACHE_IMPORT`): `auto` merges the shallowest `cache` folder found under `/kaggle/input/`
# (a previous version's output attached with *Input → + Add Input → Notebooks*); an explicit value may be **any
# ancestor folder**, e.g. the attachment's path copied from Kaggle's Input panel (its shallowest `**/cache` holding
# `stages/`, `tiles/`, `gddp/` or `packed/` is used); an explicit value that is not a folder or holds no cache stops
# the run at once (rather than silently recomputing hours of work); `0` disables. The source and the attached run's
# `RUN_STOPPED.json` / `RUN_FAILED.json` are logged. Only `stages/`, `tiles/` and `gddp/` are imported; a file is
# copied only when it is missing locally or the imported copy is newer, and packed tar files are unpacked (member
# names are checked: no absolute paths, no `..`). Packed tars of this run's own output folder are unpacked at setup
# too (resume in place), and a stage/tile that is only packed is restored on demand.
#
# **Packing** (`pack_cache()`, `LST_PACK_CACHE`, default on Kaggle): Kaggle notebook outputs are reported to be capped
# at about 500 files, while a full run caches thousands of tiles. At the end of the run (and at a clean stop) the cache
# is packed into a few dozen plain tar files `CFG.CACHE_DIR/packed/{stages_<group>,tiles_<group>,gddp}.tar` (atomic,
# member counts verified, loose files removed group by group); `web/` and `web_bundle.zip` are never touched.

# %%
_NB_GLOBALS = globals()          # the shared notebook namespace (Jupyter __main__ or run_local's exec dict)
_STAGE_PERSIST_TAG = "lst-notebook-global"
_CACHE_SUBDIRS = ("stages", "tiles", "gddp")          # imported / packed cache content (plus packed/)
_STAGE_COMPUTE_S: dict = {}      # normalised stage name -> seconds of its last compute in this session
_STAGE_REFRESHED: set = set()    # stage files written in this session (always HIT, even with LST_RESUME=0)
_STAGE_NORM_RE = re.compile(r"_(?:\d{4}|ssp\d{3}|day|night)$")


class StageCacheError(RuntimeError):
    """A stage-cache entry exists but cannot be used (corrupt pickle, key mismatch, missing global)."""


class _NotebookPickler(pickle.Pickler):
    """Pickler that stores classes/functions defined in the notebook namespace by name.

    Under ``run_local.py`` the sections run in an ``exec`` namespace whose ``__name__`` is ``"__main__"`` but which is
    *not* ``sys.modules["__main__"]``; plain pickle would fail to find e.g. ``__main__.GridSpec``. Persistent ids make
    the reference explicit and the unpickler resolves it from the namespace.
    """

    def persistent_id(self, obj):
        if isinstance(obj, type) or inspect.isfunction(obj):
            name = getattr(obj, "__qualname__", None)
            if (getattr(obj, "__module__", None) == _NB_GLOBALS.get("__name__", "__main__") and name
                    and "." not in name and _NB_GLOBALS.get(name) is obj):
                return (_STAGE_PERSIST_TAG, name)
        return None


class _NotebookUnpickler(pickle.Unpickler):
    def persistent_load(self, pid):
        if isinstance(pid, tuple) and len(pid) == 2 and pid[0] == _STAGE_PERSIST_TAG:
            obj = _NB_GLOBALS.get(pid[1])
            if obj is None:
                raise pickle.UnpicklingError(f"notebook global {pid[1]!r} is not defined (run earlier sections)")
            return obj
        raise pickle.UnpicklingError(f"unsupported persistent id {pid!r}")


def _canonical_key_json(key_obj: Any) -> str:
    """Canonical JSON text of a cache key (sorted keys, numpy-aware, NaN → null)."""
    return json.dumps(_to_jsonable(key_obj, None), sort_keys=True, separators=(",", ":"), ensure_ascii=True,
                      allow_nan=False)


def _stage_norm_name(name: str) -> str:
    """Stage name without trailing ``_YYYY`` / ``_sspNNN`` / ``_day`` / ``_night`` tokens (budget estimates)."""
    prev = None
    while prev != name:
        prev, name = name, _STAGE_NORM_RE.sub("", name)
    return name


def _stage_compute_estimate(norm: str) -> float:
    """Seconds the stage ``norm`` (normalised name) is expected to compute, for the budget check of a MISS.

    The last compute of this session wins; before the first one, the ``compute_s`` of the most recent stage sidecar
    of the same normalised name in ``CFG.STAGE_DIR`` (an earlier or imported run, possibly with another key) seeds
    the estimate, so a long single-unit stage is not started with only the reserve left. 0.0 when nothing is known.
    """
    if norm in _STAGE_COMPUTE_S:
        return float(_STAGE_COMPUTE_S[norm])
    best_t, best_s = -1.0, 0.0
    try:
        sidecars = list(CFG.STAGE_DIR.glob(f"{norm}*.json"))
    except OSError:
        sidecars = []
    for meta_path in sidecars:
        stem = meta_path.stem.rsplit("-", 1)[0]
        if _stage_norm_name(stem) != norm:
            continue
        try:
            mtime = meta_path.stat().st_mtime
            compute_s = json.loads(meta_path.read_text(encoding="utf-8")).get("compute_s")
        except (OSError, ValueError, AttributeError):
            continue
        if isinstance(compute_s, (int, float)) and math.isfinite(compute_s) and mtime > best_t:
            best_t, best_s = mtime, float(compute_s)
    _STAGE_COMPUTE_S[norm] = best_s
    return best_s


def _stage_invalidated(name: str) -> Optional[str]:
    """The LST_INVALIDATE token that forces ``name`` to recompute, else None."""
    for token in CFG.INVALIDATE:
        if name.startswith(token) or name.startswith("s" + token):
            return token
    return None


# ---- packed-cache index (on-demand restore of entries that only exist inside packed/*.tar) ------------------------
_PACKED_LOCK = threading.RLock()
_PACKED_INDEX: dict = {"sig": None, "members": {}}


def _safe_member_name(name: str) -> bool:
    """A tar member name that stays inside the cache: relative, no '..', no drive letters/backslashes."""
    if not name or name.startswith(("/", "\\")) or re.match(r"^[A-Za-z]:", name) or "\\" in name:
        return False
    parts = name.split("/")
    return ".." not in parts and all(p not in ("",) for p in parts[:-1])


def _packed_members(packed_dir: Optional[Path] = None) -> dict:
    """{member name: (tar path, data offset, size, mtime)} of the regular files in ``packed/*.tar`` (memoised)."""
    packed_dir = Path(packed_dir) if packed_dir is not None else CFG.CACHE_DIR / "packed"
    with _PACKED_LOCK:
        tars = sorted(packed_dir.glob("*.tar")) if packed_dir.is_dir() else []
        try:
            sig = (str(packed_dir), tuple((t.name, t.stat().st_mtime_ns, t.stat().st_size) for t in tars))
        except OSError:
            sig = None
        if sig is not None and sig == _PACKED_INDEX["sig"]:
            return _PACKED_INDEX["members"]
        members = {}
        for tar_path in tars:
            try:
                with tarfile.open(tar_path, "r:") as tf:
                    for m in tf.getmembers():
                        if m.isfile() and _safe_member_name(m.name):
                            members[m.name] = (tar_path, int(m.offset_data), int(m.size), float(m.mtime))
            except (OSError, tarfile.TarError) as exc:
                log(f"packed cache {tar_path.name} is unreadable ({type(exc).__name__}: {exc}); ignored", "WARNING")
        _PACKED_INDEX.update(sig=sig, members=members)
        return members


def _write_member(entry: tuple, dest: Path) -> None:
    """Copy one tar member (by offset) to ``dest`` atomically and restore its mtime."""
    tar_path, offset, size, mtime = entry
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".tmp")
    try:
        with open(tar_path, "rb") as src, open(tmp, "wb") as out:
            src.seek(offset)
            left = size
            while left > 0:
                chunk = src.read(min(left, 1 << 22))
                if not chunk:
                    raise OSError(f"{tar_path.name}: truncated member for {dest.name}")
                out.write(chunk)
                left -= len(chunk)
        os.replace(tmp, dest)
        os.utime(dest, (mtime, mtime))
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise


def cache_restore(*paths) -> int:
    """Restore cache files that exist only inside this run's ``packed/*.tar``; returns the number restored."""
    if not (CFG.CACHE_DIR / "packed").is_dir():
        return 0
    restored = 0
    with _PACKED_LOCK:
        members = _packed_members()
        for path in paths:
            path = Path(path)
            if path.is_file():
                continue
            try:
                rel = path.resolve().relative_to(CFG.CACHE_DIR.resolve()).as_posix()
            except ValueError:
                continue
            entry = members.get(rel)
            if entry is None:
                continue
            try:
                _write_member(entry, path)
                restored += 1
            except OSError as exc:
                log(f"could not restore {rel} from {entry[0].name}: {exc}", "WARNING")
    return restored


class _StageCache:
    """Handle on one stage-cache entry: ``.hit``, ``.load()``, ``.save(obj)``, ``.get_or_compute(fn)``."""

    def __init__(self, name: str, key_obj: Any):
        if not re.fullmatch(r"[A-Za-z0-9_.\-]+", name):
            raise ValueError(f"stage name {name!r} may contain only letters, digits, '_', '-' and '.'")
        self.name = name
        self.key_json = _canonical_key_json(key_obj)
        self.digest = hashlib.sha1(self.key_json.encode("utf-8")).hexdigest()[:12]
        CFG.STAGE_DIR.mkdir(parents=True, exist_ok=True)
        self.path = CFG.STAGE_DIR / f"{name}-{self.digest}.pkl"
        self.meta_path = self.path.with_suffix(".json")
        if not self.path.is_file():
            cache_restore(self.path, self.meta_path)          # entry packed at the end of an earlier run
        exists = self.path.is_file()
        refreshed = str(self.path) in _STAGE_REFRESHED
        token = _stage_invalidated(name)
        self.forced = bool(exists and token is not None and not refreshed)
        self.hit = exists and (refreshed or (bool(CFG.RESUME) and not self.forced))
        if self.hit:
            log(f"stage cache HIT  {self.path.name} ({self.path.stat().st_size / 2**20:.1f} MiB)")
        elif self.forced:
            log(f"stage cache MISS {self.path.name} (LST_INVALIDATE={token}: recomputing)")
        else:
            reason = "LST_RESUME=0" if (not CFG.RESUME and exists) else "no entry"
            log(f"stage cache MISS {self.path.name} ({reason})", "DEBUG")

    def _check_key(self) -> None:
        if not self.meta_path.is_file():
            return   # imported caches may come without sidecars; the digest in the file name still matches
        try:
            stored = json.loads(self.meta_path.read_text(encoding="utf-8")).get("key")
        except (OSError, json.JSONDecodeError) as exc:
            log(f"stage cache sidecar {self.meta_path.name} unreadable ({exc}); trusting the file-name digest",
                "WARNING")
            return
        if stored is not None and _canonical_key_json(stored) != self.key_json:
            raise StageCacheError(f"{self.path.name}: stored key differs from the requested key (hash collision "
                                  f"or a copied file)")

    def load(self) -> Any:
        """Unpickle the entry; raises ``StageCacheError`` when it is missing or unusable."""
        if not self.path.is_file():
            cache_restore(self.path, self.meta_path)
        if not self.path.is_file():
            raise StageCacheError(f"stage cache entry {self.path} does not exist")
        self._check_key()
        t0 = time.perf_counter()
        try:
            with open(self.path, "rb") as fh:
                obj = _NotebookUnpickler(fh).load()
        except Exception as exc:  # noqa: BLE001 - any unpickling failure makes the entry unusable
            raise StageCacheError(f"stage cache entry {self.path.name} is unreadable: {type(exc).__name__}: "
                                  f"{str(exc)[:200]}") from exc
        log(f"stage cache loaded {self.path.name} in {time.perf_counter() - t0:.1f}s")
        return obj

    def save(self, obj: Any, compute_s: Optional[float] = None) -> Any:
        """Pickle ``obj`` atomically (+ key sidecar) and return it unchanged (so ``X = sc.save(compute())``)."""
        tmp = self.path.with_name(self.path.name + ".tmp")
        t0 = time.perf_counter()
        try:
            with open(tmp, "wb") as fh:
                _NotebookPickler(fh, protocol=pickle.HIGHEST_PROTOCOL).dump(obj)
            os.replace(tmp, self.path)
        except Exception as exc:  # noqa: BLE001 - caching must never break the computation it caches
            try:
                tmp.unlink()
            except OSError:
                pass
            log(f"stage cache could not save {self.path.name}: {type(exc).__name__}: {str(exc)[:200]} "
                "(continuing without cache)", "WARNING")
            return obj
        meta = {"name": self.name, "key": json.loads(self.key_json), "created": datetime.now(timezone.utc),
                "bytes": self.path.stat().st_size,
                "compute_s": None if compute_s is None else round(float(compute_s), 1)}
        try:
            save_json(meta, self.meta_path)
        except Exception as exc:  # noqa: BLE001
            log(f"stage cache sidecar not written ({exc})", "WARNING")
        self.hit = True
        _STAGE_REFRESHED.add(str(self.path))
        log(f"stage cache saved {self.path.name} ({meta['bytes'] / 2**20:.1f} MiB, "
            f"{time.perf_counter() - t0:.1f}s)")
        return obj

    def get_or_compute(self, fn: Callable[[], Any]) -> Any:
        """Load the entry when it is a usable hit, otherwise compute ``fn()``, save and return it.

        Before computing, the time budget is checked (``LSTStop`` when 1.25 × the last compute time of this stage
        name, or of its newest sidecar before the first compute of the session, plus the reserve no longer fits).
        """
        if self.hit:
            try:
                return self.load()
            except StageCacheError as exc:
                log(f"{exc}; recomputing", "WARNING")
                self.hit = False
        norm = _stage_norm_name(self.name)
        check_budget(f"stage {self.name}", 1.25 * _stage_compute_estimate(norm))
        t0 = time.perf_counter()
        obj = fn()
        elapsed = time.perf_counter() - t0
        _STAGE_COMPUTE_S[norm] = elapsed
        return self.save(obj, compute_s=elapsed)

    def __repr__(self) -> str:
        return f"<stage_cache {self.path.name} hit={self.hit}>"


def stage_cache(name: str, key_obj: Any) -> _StageCache:
    """Return the cache handle for stage ``name`` keyed by the JSON-able ``key_obj`` (SPEC §3.1)."""
    return _StageCache(name, key_obj)


# ---- cache import ---------------------------------------------------------------------------------------------------
def _cache_has_content(path: Path) -> bool:
    return any((path / sub).is_dir() for sub in _CACHE_SUBDIRS + ("packed",))


def _search_cache_dir(root: Path) -> Optional[Path]:
    """Shallowest ``root/**/cache`` (excluding this run's own cache) that holds cache content, else None."""
    own = CFG.CACHE_DIR.resolve()
    try:
        candidates = sorted((p for p in root.glob("**/cache") if p.is_dir()), key=lambda p: (len(p.parts), str(p)))
    except OSError as exc:
        log(f"cache import: scanning {root} failed ({exc})", "WARNING")
        return None
    for path in candidates:
        try:
            if path.resolve() == own:
                continue
        except OSError:
            continue
        if _cache_has_content(path):
            return path
    return None


def _import_candidates_hint() -> str:
    """The cache folders found under /kaggle/input, for the error message of a wrong explicit LST_CACHE_IMPORT."""
    root = Path("/kaggle/input")
    if not root.is_dir():
        return ""
    try:
        found = sorted((str(p) for p in root.glob("**/cache") if p.is_dir() and _cache_has_content(p)),
                       key=lambda s: (s.count("/"), s))[:10]
    except OSError:
        found = []
    return ("; cache folders attached now: " + ", ".join(found) if found
            else "; no cache folder is attached under /kaggle/input")


def _find_import_cache() -> Optional[Path]:
    """Source folder for CACHE_IMPORT: explicit folder (itself, or its shallowest ``**/cache`` with content), or the
    shallowest ``/kaggle/input/*/**/cache`` with content. An explicit folder that does not exist or holds no cache
    raises at once: the user asked for a resume, and silently starting fresh would recompute hours of work."""
    setting = CFG.CACHE_IMPORT
    if setting == "off":
        return None
    if setting != "auto":
        path = Path(setting).expanduser()
        if not path.is_dir():
            raise FileNotFoundError(f"LST_CACHE_IMPORT={setting!r} is not a folder. Copy the path of the attached "
                                    "output from Kaggle's Input panel, use 'auto', or remove the setting"
                                    f"{_import_candidates_hint()}")
        try:
            if path.resolve() == CFG.CACHE_DIR.resolve():
                log(f"LST_CACHE_IMPORT={setting!r} is this run's own cache folder; nothing imported", "WARNING")
                return None
        except OSError:
            pass
        if _cache_has_content(path):
            return path
        found = _search_cache_dir(path)
        if found is None:
            raise FileNotFoundError(f"LST_CACHE_IMPORT={setting!r}: no cache folder (with stages/, tiles/, gddp/ or "
                                    f"packed/) inside it{_import_candidates_hint()}")
        return found
    root = Path("/kaggle/input")
    if not root.is_dir():
        return None
    return _search_cache_dir(root)


def _log_attached_run(src: Path) -> None:
    """Log how the run that produced an imported cache ended (its RUN_STOPPED.json / RUN_FAILED.json /
    LAUNCHER_RUN.json next to ``cache/``); warn when it used another profile."""
    for name in ("RUN_STOPPED.json", "RUN_FAILED.json", "LAUNCHER_RUN.json"):
        path = src.parent / name
        if not path.is_file():
            continue
        try:
            info = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            log(f"cache import: {path} is unreadable ({exc})", "WARNING")
            continue
        if not isinstance(info, dict):
            continue
        keys = ("status", "reason", "section", "cell", "error", "profile", "bundle_id", "utc")
        log(f"cache import: the attached run's {name}: "
            + ", ".join(f"{k}={str(info[k])[:160]}" for k in keys if info.get(k) is not None))
        if info.get("profile") and info["profile"] != CFG.PROFILE:
            log(f"cache import: the attached run used profile {info['profile']!r}, this run uses {CFG.PROFILE!r}; "
                "only stages with identical keys are reused (Earth Engine tiles and GDDP blocks of shared frames "
                "are)", "WARNING")


def _extract_packed(packed_dir: Path, dst_root: Path, stats_out: dict, label: str) -> None:
    """Unpack ``packed_dir/*.tar`` members under stages/, tiles/, gddp/ into ``dst_root`` (newer-than rule)."""
    margin = 1 << 30
    for tar_path in sorted(packed_dir.glob("*.tar")):
        try:
            with tarfile.open(tar_path, "r:") as tf:
                members = tf.getmembers()
        except (OSError, tarfile.TarError) as exc:
            log(f"cache import: {label} {tar_path.name} is unreadable ({type(exc).__name__}: {exc}); skipped",
                "WARNING")
            continue
        for m in members:
            if not m.isfile():
                if not m.isdir():
                    log(f"cache import: {tar_path.name}: non-file member {m.name!r} rejected", "WARNING")
                continue
            if not _safe_member_name(m.name):
                log(f"cache import: {tar_path.name}: unsafe member name {m.name!r} rejected", "WARNING")
                stats_out["rejected"] += 1
                continue
            top = m.name.split("/", 1)[0]
            if top not in _CACHE_SUBDIRS or m.name.endswith(".tmp"):
                continue
            if top in ("stages", "tiles"):
                stats_out["stage_tile_files"] += 1
            dest = dst_root / m.name
            try:
                if dest.exists() and dest.stat().st_mtime >= m.mtime:
                    stats_out["skipped"] += 1
                    continue
                dest.parent.mkdir(parents=True, exist_ok=True)
                if shutil.disk_usage(dest.parent).free < m.size + margin:
                    log("cache import stopped: free disk space would fall below 1 GiB", "WARNING")
                    stats_out["stopped_low_disk"] = True
                    return
                _write_member((tar_path, int(m.offset_data), int(m.size), float(m.mtime)), dest)
                stats_out["extracted"] += 1
                stats_out["bytes"] += int(m.size)
            except OSError as exc:
                log(f"cache import: could not extract {m.name} from {tar_path.name}: {exc}", "WARNING")


def import_cache() -> dict:
    """Merge a previous run's cache into ``CFG.CACHE_DIR`` without overwriting newer local files.

    Only ``stages/``, ``tiles/`` and ``gddp/`` are imported (loose files copied, ``packed/*.tar`` unpacked with
    member-name checks). A file is taken when it is absent locally or the imported copy has a newer modification
    time; ``*.tmp`` leftovers are skipped. Copying stops (with a warning) when the free disk space would drop below
    1 GiB (Kaggle's /kaggle/working is limited to ~20 GB). This run's own ``packed/*.tar`` (an in-place resume) are
    unpacked first. Returns copy statistics.
    """
    stats_out = {"source": None, "copied": 0, "skipped": 0, "extracted": 0, "rejected": 0, "bytes": 0,
                 "stage_tile_files": 0, "stopped_low_disk": False, "own_packed_extracted": 0}
    own_packed = CFG.CACHE_DIR / "packed"
    if own_packed.is_dir() and any(own_packed.glob("*.tar")):
        own = dict(stats_out)
        _extract_packed(own_packed, CFG.CACHE_DIR, own, "own packed cache")
        stats_out["own_packed_extracted"] = own["extracted"]
        log(f"cache: unpacked {own['extracted']} file(s) from this run's own {own_packed} "
            f"({own['skipped']} already present)")
    src = _find_import_cache()
    if src is None:
        if CFG.CACHE_IMPORT not in ("off",) and _IS_KAGGLE:
            log("cache import: no previous-run cache found under /kaggle/input (fresh run)")
        return stats_out
    stats_out["source"] = str(src)
    dst_root = CFG.CACHE_DIR
    log(f"cache import: merging {src} -> {dst_root}")
    _log_attached_run(src)
    margin = 1 << 30
    for sub in _CACHE_SUBDIRS:
        base = src / sub
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*")):
            if not path.is_file() or path.name.endswith(".tmp"):
                continue
            rel = path.relative_to(src)
            dest = dst_root / rel
            if sub in ("stages", "tiles"):
                stats_out["stage_tile_files"] += 1
            try:
                st = path.stat()
                if dest.exists() and dest.stat().st_mtime >= st.st_mtime:
                    stats_out["skipped"] += 1
                    continue
                dest.parent.mkdir(parents=True, exist_ok=True)
                if shutil.disk_usage(dest.parent).free < st.st_size + margin:
                    log("cache import stopped: free disk space would fall below 1 GiB", "WARNING")
                    stats_out["stopped_low_disk"] = True
                    break
                tmp = dest.with_name(dest.name + ".tmp")
                shutil.copy2(path, tmp)
                os.replace(tmp, dest)
                stats_out["copied"] += 1
                stats_out["bytes"] += st.st_size
            except OSError as exc:
                log(f"cache import: could not copy {rel}: {exc}", "WARNING")
        if stats_out["stopped_low_disk"]:
            break
    if (src / "packed").is_dir() and not stats_out["stopped_low_disk"]:
        _extract_packed(src / "packed", dst_root, stats_out, "imported packed cache")
    log(f"cache import: {stats_out['copied']} files copied, {stats_out['extracted']} unpacked "
        f"({stats_out['bytes'] / 2**20:,.1f} MiB), {stats_out['skipped']} kept (local copy newer or equal)"
        + (f", {stats_out['rejected']} unsafe tar member(s) rejected" if stats_out["rejected"] else ""))
    if stats_out["stage_tile_files"] == 0:
        log(f"cache import: {src} contains no stage or tile files (stages/, tiles/ or packed/*.tar) - nothing "
            "will be reused; check LST_CACHE_IMPORT and that the attached version's outputs/cache exists",
            "WARNING")
    return stats_out


# ---- cache packing (Kaggle output file cap) ------------------------------------------------------------------------
def _stage_group(stem: str) -> str:
    """Pack group of a stage name: its first two tokens (03_landsat, s04_thermal, 07_job, 08_boot, 11_land, ...);
    three when the second is day/night (09_day_hindcast)."""
    tokens = stem.split("_")
    n = 3 if len(tokens) > 2 and tokens[1] in ("day", "night") else 2
    return re.sub(r"[^A-Za-z0-9_.-]", "_", "_".join(tokens[:n])) or "misc"


def _pack_groups() -> dict:
    """{tar file name: [(arcname, path), ...]} of the loose cache files (``*.tmp`` excluded)."""
    root = CFG.CACHE_DIR
    groups: dict = {}
    stages = root / "stages"
    if stages.is_dir():
        for path in sorted(stages.iterdir()):
            if path.is_file() and not path.name.endswith(".tmp"):
                stem = path.name.rsplit("-", 1)[0] if "-" in path.name else path.stem
                groups.setdefault(f"stages_{_stage_group(stem)}.tar", []).append((f"stages/{path.name}", path))
    tiles = root / "tiles"
    if tiles.is_dir():
        for folder in sorted(tiles.iterdir()):
            if not folder.is_dir():
                continue
            group = re.sub(r"[^A-Za-z0-9_.-]", "_", folder.name.split("_", 1)[0]) or "misc"
            for path in sorted(folder.rglob("*")):
                if path.is_file() and not path.name.endswith(".tmp"):
                    groups.setdefault(f"tiles_{group}.tar", []).append(
                        (f"tiles/{path.relative_to(tiles).as_posix()}", path))
    gddp = root / "gddp"
    if gddp.is_dir():
        for path in sorted(gddp.rglob("*")):
            if path.is_file() and not path.name.endswith(".tmp"):
                groups.setdefault("gddp.tar", []).append((f"gddp/{path.relative_to(gddp).as_posix()}", path))
    return groups


def _pack_one(tar_path: Path, loose: list) -> int:
    """(Re)write ``tar_path`` = its previous members not superseded by ``loose`` + the loose files; verify; atomic."""
    tmp = tar_path.with_name(tar_path.name + ".tmp")
    names_new = {arc for arc, _ in loose}
    expected = []
    try:
        with tarfile.open(tmp, "w", format=tarfile.PAX_FORMAT) as out:
            if tar_path.is_file():
                with tarfile.open(tar_path, "r:") as old:
                    for m in old.getmembers():
                        if m.isfile() and m.name not in names_new and _safe_member_name(m.name):
                            out.addfile(m, old.extractfile(m))
                            expected.append(m.name)
            for arc, path in loose:
                out.add(str(path), arcname=arc, recursive=False)
                expected.append(arc)
        with tarfile.open(tmp, "r:") as check:
            got = [m.name for m in check.getmembers() if m.isfile()]
        if len(got) != len(expected) or set(got) != set(expected):
            raise RuntimeError(f"{tmp.name}: {len(got)} members written, {len(expected)} expected")
        os.replace(tmp, tar_path)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise
    return len(expected)


def _count_output_files() -> int:
    try:
        return sum(1 for p in CFG.OUTPUT_DIR.rglob("*") if p.is_file())
    except OSError:
        return -1


def pack_cache(force: bool = False) -> dict:
    """Pack ``CFG.CACHE_DIR/{stages,tiles,gddp}`` into ``CFG.CACHE_DIR/packed/*.tar`` (D5).

    Active when ``CFG.PACK_CACHE`` (``LST_PACK_CACHE``, default on Kaggle) or ``force``. One plain tar per group
    (``stages_<stage prefix>.tar``, ``tiles_<tile-folder prefix>.tar``, ``gddp.tar``), merged with an existing tar of
    the same group, written atomically and verified; the loose files of a group are deleted right after its tar is
    verified (bounded peak disk). ``*.tmp`` files, ``web/`` and ``web_bundle.zip`` are never touched. Entries remain
    usable: stage caches and tiles are restored from the tars on demand. Returns {tar name: member count}.
    """
    if not (force or CFG.PACK_CACHE):
        log("pack_cache: skipped (LST_PACK_CACHE=0)", "DEBUG")
        return {}
    t0 = time.perf_counter()
    packed = CFG.CACHE_DIR / "packed"
    packed.mkdir(parents=True, exist_ok=True)
    out = {}
    with _PACKED_LOCK:
        for tar_name, loose in sorted(_pack_groups().items()):
            if not loose:
                continue
            try:
                out[tar_name] = _pack_one(packed / tar_name, loose)
            except Exception as exc:  # noqa: BLE001 - the loose files stay; packing is an optimisation
                log(f"pack_cache: {tar_name} not written ({type(exc).__name__}: {str(exc)[:200]}); its "
                    f"{len(loose)} loose file(s) are kept", "WARNING")
                continue
            for _, path in loose:
                try:
                    path.unlink()
                except OSError as exc:
                    log(f"pack_cache: could not remove {path.name} ({exc})", "WARNING")
        tiles = CFG.CACHE_DIR / "tiles"
        if tiles.is_dir():
            for folder in sorted(tiles.iterdir(), reverse=True):
                if folder.is_dir():
                    for sub in sorted((p for p in folder.rglob("*") if p.is_dir()), key=lambda p: -len(p.parts)):
                        try:
                            sub.rmdir()
                        except OSError:
                            pass
                    try:
                        folder.rmdir()
                    except OSError:
                        pass
        _PACKED_INDEX.update(sig=None, members={})
    n_files = _count_output_files()
    log(f"pack_cache: {len(out)} tar file(s) updated ({sum(out.values())} members) in "
        f"{time.perf_counter() - t0:.1f}s; {n_files} files under {CFG.OUTPUT_DIR}")
    if n_files > 450:
        log(f"{n_files} files under {CFG.OUTPUT_DIR}: Kaggle notebook outputs are reported to be capped at about 500 "
            "files - files beyond the cap may be missing from the saved version", "WARNING")
    return out


CACHE_IMPORT_STATS = import_cache()

# %% [markdown]
# ## 0.7 LSTB binary container (SPEC §5.1)
# Large per-cell arrays (cells, frame cubes, SHAP matrices) are exported as **LSTB** files: a small JSON header
# followed by typed little-endian column blocks, the whole file gzip-compressed. Layout (byte-exact):
#
# ```
# gzip( "LSTB" | u8 version=1 | u8[3] reserved=0 | u32le header_len | header (UTF-8 JSON, header_len bytes)
#       | zero padding to an 8-byte boundary (relative to file start) | data section )
# header = {"kind", "n", "meta", "columns": [{"name", "dtype", "shape", "scale", "offset", "nodata",
#                                             "byte_offset" (from data start, multiple of 8), "byte_length"}]}
# value = raw * scale + offset; raw == nodata → NaN; multi-dimensional shapes are row-major ([frames, n]).
# ```
#
# Quantisation `raw = round((value − offset) / scale)`; NaN/±Inf → `nodata`; values are clipped to the dtype range
# with the nodata code excluded (e.g. int16 with nodata −32768 stores −32767…32767). 8-byte alignment lets the
# browser wrap each column as a typed array view without copying. `quant_params` chooses `(scale, offset)` so that the
# finite range of a column (plus headroom) spans the integer range, which bounds the rounding error by `scale / 2`.

# %%
LSTB_MAGIC = b"LSTB"
LSTB_VERSION = 1
_LSTB_DTYPES = {"int16": np.dtype("<i2"), "uint8": np.dtype("u1"), "int32": np.dtype("<i4"),
                "float32": np.dtype("<f4")}
_LSTB_DEFAULT_NODATA = {"int16": -32768, "uint8": 255, "int32": -2147483648}


def _lstb_raw_range(dtype: str, nodata: Optional[int]) -> tuple:
    """Integer range available for valid values (the nodata code is excluded when it is an endpoint)."""
    info = np.iinfo(_LSTB_DTYPES[dtype])
    lo, hi = int(info.min), int(info.max)
    if nodata is not None:
        if nodata == lo:
            lo += 1
        elif nodata == hi:
            hi -= 1
    return lo, hi


def quant_params(values, dtype: str = "int16", *, headroom: float = 0.02, nodata: Optional[int] = None) -> tuple:
    """``(scale, offset)`` mapping the finite range of ``values`` (p0-p100, widened by ``headroom`` × span on both
    sides) onto the usable integer range of ``dtype`` (nodata code excluded; default nodata of the dtype).

    float32 returns ``(1.0, 0.0)`` (stored unquantised). A constant or empty column gets a tiny positive scale so
    that its value is still represented exactly at raw 0 (empty → ``(1.0, 0.0)``).
    """
    if dtype not in _LSTB_DTYPES:
        raise ValueError(f"unsupported LSTB dtype {dtype!r}; use one of {list(_LSTB_DTYPES)}")
    if dtype == "float32":
        return 1.0, 0.0
    arr = np.asarray(values, dtype=np.float64).ravel()
    arr = arr[np.isfinite(arr)]
    if arr.size == 0:
        return 1.0, 0.0
    vmin, vmax = float(arr.min()), float(arr.max())
    nodata = _LSTB_DEFAULT_NODATA[dtype] if nodata is None else int(nodata)
    rmin, rmax = _lstb_raw_range(dtype, nodata)
    span = vmax - vmin
    if span <= 0.0:
        # Constant column: raw 0 must decode to the constant exactly (offset = constant). For uint8, raw 0 is the
        # range minimum, which is fine; the scale only has to be positive.
        scale = max(abs(vmin), 1.0) * 1e-6
        offset = vmin if rmin <= 0 <= rmax else vmin - rmin * scale
        return float(scale), float(offset)
    lo = vmin - headroom * span
    hi = vmax + headroom * span
    scale = (hi - lo) / float(rmax - rmin)
    offset = lo - rmin * scale
    return float(scale), float(offset)


def _lstb_kind_from_path(path: Path) -> str:
    """Default ``kind`` from the SPEC §5.2 file names (cells, cube, zones, features, xai)."""
    stem = path.name.split(".")[0]
    if stem == "cells":
        return "cells"
    if stem.startswith("cube_zones"):
        return "zones"
    if stem.startswith("cube_"):
        return "cube"
    if stem.startswith("xai_") and stem.endswith("_features"):
        return "features"
    if stem.startswith("xai_"):
        return "xai"
    return stem


def _lstb_encode_column(col: dict) -> tuple:
    """Validate and quantise one column dict → (header entry without offsets, raw little-endian bytes)."""
    if not isinstance(col, dict) or "name" not in col or "array" not in col:
        raise ValueError(f"LSTB column must be a dict with 'name' and 'array', got {type(col).__name__}")
    name = str(col["name"])
    dtype = str(col.get("dtype", "float32"))
    if dtype not in _LSTB_DTYPES:
        raise ValueError(f"LSTB column {name!r}: unsupported dtype {dtype!r} (use {list(_LSTB_DTYPES)})")
    scale = float(col.get("scale", 1.0) if col.get("scale") is not None else 1.0)
    offset = float(col.get("offset", 0.0) if col.get("offset") is not None else 0.0)
    if not (math.isfinite(scale) and scale > 0.0 and math.isfinite(offset)):
        raise ValueError(f"LSTB column {name!r}: scale must be finite and > 0 and offset finite "
                         f"(got scale={scale}, offset={offset})")
    src = np.asarray(col["array"])
    if src.dtype.kind not in "biuf":
        raise ValueError(f"LSTB column {name!r}: array dtype {src.dtype} is not numeric")
    nodata = col.get("nodata")
    target = _LSTB_DTYPES[dtype]
    if dtype == "float32":
        if nodata is not None:
            raise ValueError(f"LSTB column {name!r}: float32 columns store NaN natively; nodata must be None")
        values = src.astype(np.float64)
        raw = ((values - offset) / scale) if (scale != 1.0 or offset != 0.0) else values
        raw = raw.astype(target)
    else:
        invalid = ~np.isfinite(src) if src.dtype.kind == "f" else np.zeros(src.shape, dtype=bool)
        if nodata is None and invalid.any():
            nodata = _LSTB_DEFAULT_NODATA[dtype]
            log(f"LSTB column {name!r}: {int(invalid.sum())} NaN values and no nodata given; using {nodata}",
                "DEBUG")
        if nodata is not None:
            nodata = int(nodata)
            info = np.iinfo(target)
            if not info.min <= nodata <= info.max:
                raise ValueError(f"LSTB column {name!r}: nodata {nodata} outside the {dtype} range")
        rmin, rmax = _lstb_raw_range(dtype, nodata)
        if src.dtype.kind in "biu" and scale == 1.0 and offset == 0.0:
            exact = src.astype(np.int64)                       # integers pass through exactly
        else:
            with np.errstate(invalid="ignore"):
                exact = np.rint((src.astype(np.float64) - offset) / scale)
        with np.errstate(invalid="ignore"):
            n_clip = int(np.count_nonzero(((exact < rmin) | (exact > rmax)) & ~invalid))
        if n_clip:
            log(f"LSTB column {name!r}: {n_clip} value(s) clipped to the {dtype} range [{rmin}, {rmax}]", "DEBUG")
        exact = np.clip(np.where(invalid, 0, exact), rmin, rmax)
        raw = exact.astype(target)
        if nodata is not None:
            if rmin <= nodata <= rmax:
                collide = int(np.count_nonzero((raw == nodata) & ~invalid))
                if collide:
                    log(f"LSTB column {name!r}: {collide} valid value(s) equal the nodata code {nodata} and will "
                        "decode as NaN (choose an endpoint nodata)", "WARNING")
            raw[invalid] = nodata
    raw = np.ascontiguousarray(raw)
    entry = {"name": name, "dtype": dtype, "shape": [int(s) for s in raw.shape], "scale": scale, "offset": offset,
             "nodata": None if nodata is None else int(nodata)}
    return entry, raw.tobytes(order="C")


def lstb_write(path, columns: Sequence[dict], meta: Optional[dict] = None, *, kind: Optional[str] = None,
               n: Optional[int] = None, compresslevel: int = 9) -> Path:
    """Write an LSTB container (SPEC §5.1); gzip-compressed when ``path`` ends in ``.gz``.

    ``columns``: list of ``{name, array, dtype ("int16"|"uint8"|"int32"|"float32"), scale=1.0, offset=0.0,
    nodata=None}``; shapes ``[n]`` or ``[frames, n]`` (last axis = cells). ``kind`` defaults to ``meta["kind"]`` (removed
    from meta) or is inferred from the SPEC file name; ``n`` defaults to the last dimension of the columns, which must
    agree. The file is written atomically with a deterministic gzip header. Returns the path.
    """
    path = Path(path)
    meta = dict(meta or {})
    if kind is None:
        kind = meta.pop("kind", None) or _lstb_kind_from_path(path)
    if not columns:
        raise ValueError("lstb_write: at least one column is required")
    names = [str(c.get("name")) for c in columns]
    if len(set(names)) != len(names):
        raise ValueError(f"lstb_write: duplicate column names {names}")
    encoded = [_lstb_encode_column(c) for c in columns]
    last_dims = {e["shape"][-1] if e["shape"] else 1 for e, _ in encoded}
    if n is None:
        if len(last_dims) != 1:
            raise ValueError(f"lstb_write: columns disagree on n (last dimension): {sorted(last_dims)}")
        n = last_dims.pop()
    elif any(d != int(n) for d in last_dims):
        raise ValueError(f"lstb_write: n={n} but column last dimensions are {sorted(last_dims)}")
    entries, blobs, cursor = [], [], 0
    for entry, blob in encoded:
        entry["byte_offset"] = cursor
        entry["byte_length"] = len(blob)
        entries.append(entry)
        pad = (-len(blob)) % 8
        blobs.append(blob + b"\0" * pad)
        cursor += len(blob) + pad
    header = {"kind": str(kind), "n": int(n), "meta": _to_jsonable(meta, None), "columns": entries}
    header_bytes = json.dumps(header, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    prefix = LSTB_MAGIC + struct.pack("<B3xI", LSTB_VERSION, len(header_bytes)) + header_bytes
    prefix += b"\0" * ((-len(prefix)) % 8)
    payload = prefix + b"".join(blobs)
    if path.name.endswith(".gz"):
        payload = _gzip_bytes(payload, compresslevel)
    return _write_bytes_atomic(path, payload)


def lstb_parse(data: bytes) -> tuple:
    """Parse LSTB bytes (gzip or inflated) → ``(header, {name: raw typed ndarray})`` without decoding."""
    if data[:2] == b"\x1f\x8b":
        data = gzip.decompress(data)
    if len(data) < 12 or data[:4] != LSTB_MAGIC:
        raise ValueError("not an LSTB container (bad magic)")
    version, header_len = struct.unpack_from("<B3xI", data, 4)
    if version != LSTB_VERSION:
        raise ValueError(f"unsupported LSTB version {version}")
    if 12 + header_len > len(data):
        raise ValueError("truncated LSTB header")
    header = json.loads(data[12:12 + header_len].decode("utf-8"))
    data_start = 12 + header_len + ((-(12 + header_len)) % 8)
    raws = {}
    for col in header["columns"]:
        dt = _LSTB_DTYPES.get(col["dtype"])
        if dt is None:
            raise ValueError(f"LSTB column {col['name']!r}: unknown dtype {col['dtype']!r}")
        off, length = int(col["byte_offset"]), int(col["byte_length"])
        if off % 8:
            raise ValueError(f"LSTB column {col['name']!r}: byte_offset {off} is not 8-byte aligned")
        shape = tuple(int(s) for s in col["shape"])
        count = int(np.prod(shape)) if shape else 1
        if length != count * dt.itemsize or data_start + off + length > len(data):
            raise ValueError(f"LSTB column {col['name']!r}: byte_length {length} inconsistent with shape {shape}")
        raws[col["name"]] = np.frombuffer(data, dtype=dt, count=count, offset=data_start + off).reshape(shape)
    return header, raws


def lstb_read(path) -> dict:
    """Read an LSTB container → ``{"header": {...}, "columns": {name: float32 decoded array}}`` (NaN for nodata).

    Decoding is ``raw * scale + offset`` in float64, then cast to float32 (int32 identifiers above 2^24 lose exact
    integer precision in float32 - use :func:`lstb_parse` for raw integers).
    """
    header, raws = lstb_parse(Path(path).read_bytes())
    cols = {}
    for col in header["columns"]:
        raw = raws[col["name"]]
        values = raw.astype(np.float64) * float(col["scale"]) + float(col["offset"])
        if col.get("nodata") is not None:
            values[raw == col["nodata"]] = np.nan
        cols[col["name"]] = values.astype(np.float32)
    return {"header": header, "columns": cols}


def _lstb_selftest() -> None:
    """Tiny in-memory round trip so a broken container never reaches the export stage unnoticed."""
    import tempfile
    rng = np.random.default_rng(0)
    vals = rng.normal(40, 5, (3, 17)).astype(np.float32)
    vals[1, 4] = np.nan
    scale, offset = quant_params(vals, "int16")
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "selftest.lstb.gz"
        lstb_write(path, [{"name": "v", "array": vals, "dtype": "int16", "scale": scale, "offset": offset,
                           "nodata": -32768},
                          {"name": "id", "array": np.arange(17, dtype=np.int32), "dtype": "int32"}],
                   meta={"kind": "selftest"})
        back = lstb_read(path)
    got = back["columns"]["v"]
    assert back["header"]["kind"] == "selftest" and back["header"]["n"] == 17
    assert np.isnan(got[1, 4]) and np.nanmax(np.abs(got - vals)) <= scale / 2 + 1e-4
    assert np.array_equal(back["columns"]["id"], np.arange(17, dtype=np.float32))


_lstb_selftest()
log("LSTB container self-test passed")

# %% [markdown]
# ## 0.8 Configuration and hardware summary

# %%
def _show(obj) -> None:
    """Rich display inside notebooks, plain print in scripts."""
    try:
        from IPython.display import display
        if "ipykernel" in sys.modules:
            display(obj)
            return
    except ImportError:
        pass
    print(obj.to_string() if isinstance(obj, pd.DataFrame) else obj)


def _print_table(title: str, rows: Sequence[tuple], width: int = 110) -> None:
    """Two-column key/value table that reads well both in notebooks and in plain logs."""
    key_w = max(len(str(k)) for k, _ in rows) + 2
    print()
    print(title)
    print("-" * min(width, key_w + 60))
    for key, value in rows:
        text = str(value)
        print(f"{str(key):<{key_w}}{text if len(text) <= width - key_w else text[:width - key_w - 3] + '...'}")


_cfg_rows = [(k, json.dumps(v, default=str) if isinstance(v, (dict, list, tuple)) else v)
             for k, v in CFG.as_dict().items()]
_hw_rows = [
    ("Platform", ENV["platform"]), ("Python", ENV["python"]), ("Kaggle", ENV["is_kaggle"]),
    ("GPUs", f"{ENV['n_gpus']} x {', '.join(ENV['gpu_names']) or '-'}"),
    ("GPU memory (MiB)", ", ".join(str(m) for m in ENV["gpu_mem_mib"]) or "-"),
    ("torch CUDA devices", ENV["torch_device_count"]), ("torch", ENV["torch_version"] or "missing"),
    ("XGBoost", f"{ENV['xgb_version'] or 'missing'} (device={ENV['xgb_device']})"),
    ("CuPy / cuDF / cuML", f"{ENV['has_cupy']} / {ENV['has_cudf']} / {ENV['has_cuml']}"),
    ("Cache import", CACHE_IMPORT_STATS.get("source") or "-"),
] + [(f"lib: {name}", "ok" if mod is not None else "MISSING") for name, mod in _OPTIONAL_MODULES.items()]
_print_table("Configuration", _cfg_rows)
_print_table("Hardware / software", _hw_rows)
gpu_mem_report()
del _cfg_rows, _hw_rows
