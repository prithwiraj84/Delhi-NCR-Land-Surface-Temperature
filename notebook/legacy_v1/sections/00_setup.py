# %% [markdown]
# # Delhi NCR Land Surface Temperature: Non-linear Drivers, TreeSHAP Attribution & Spatial Governance Zoning
#
# **Abstract.** This notebook builds a reproducible, GPU-accelerated explainable-AI pipeline for the
# pre-monsoon (April–June) daytime land surface temperature (LST) of the Delhi National Capital Region
# (~55,000 km², 25 districts) at four epochs (2010, 2015, 2020, 2025). Satellite predictors
# (MODIS spectral indices, SRTM terrain, VIIRS/DMSP night lights, WorldPop/GHS-POP population and
# 10–30 m land cover converted into 1 km composition and configuration metrics) are extracted from
# Google Earth Engine on an explicit UTM 43N grid. One pooled gradient-boosted tree model (XGBoost on
# CUDA) is benchmarked against linear, ridge, random-forest, LightGBM and graph-neural-network baselines
# under **random, spatial-block and temporal** cross-validation, with Moran's I of the residuals as a
# spatial-leakage diagnostic. Exact TreeSHAP attributions (plus interaction values and a spatial block
# bootstrap) reveal non-linear thresholds (e.g. NDVI cooling saturation, water-body cooling reach) and
# are clustered into four **SHAP governance zones** (Ecological Cool Base, Riparian Buffer, Transition,
# Heat Extreme Core) with zone-specific, quantified mitigation recommendations. All results are exported
# as a web bundle for the companion React/deck.gl dashboard (3-D digital twin, dependence viewer,
# scenario simulator, zoning and model-performance views).
#
# ## Pipeline overview
# | Stage | Section | What happens |
# |---|---|---|
# | 0 | Setup (this section) | configuration, dependency check, GPU/CUDA detection, shared utilities |
# | 1 | Data acquisition | ROI & districts, 1 km UTM grid, Earth Engine extraction (`computePixels`, tiled, cached) **or** a clearly-labelled synthetic twin |
# | 2 | Features | land-cover fractions, landscape metrics (PD, ED, CONTAG), long feature table, CV folds |
# | 3 | Models & validation | 6 models × triple cross-validation (random / spatial / temporal), Moran's I of residuals |
# | 4 | SHAP & zoning | final XGBoost, GPU TreeSHAP + interactions, block bootstrap CIs, thresholds, K-means governance zones |
# | 5 | Export | Parquet, GeoJSON, NPZ, native model, compact browser model and the dashboard web bundle |
#
# ## How to run on Kaggle
# 1. **Settings → Accelerator → GPU T4 x2**, **Internet → On**.
# 2. **Add-ons → Secrets** (attach both to this notebook):
#    * `GEE_SERVICE_ACCOUNT_KEY` — the *full JSON key* of a Google Cloud service account that is
#      registered for Earth Engine (Earth Engine API enabled on the project, service account granted
#      the *Earth Engine Resource Viewer/Writer* role or registered at code.earthengine.google.com/register);
#    * `GEE_PROJECT` — the Cloud project id used for Earth Engine billing/quota.
#
#    Without a key, an **interactive** session can authenticate with `ee.Authenticate(auth_mode="notebook")`
#    (you will be prompted); a committed (batch) run cannot, so it needs the secret.
# 3. *Run All*. Missing packages (`earthengine-api`, `pylandstats`, `libpysal`, `esda`, …) are pip-installed
#    automatically on Kaggle.
#
# ## Run modes and overrides (environment variables, all optional)
# | Variable | Values / default | Effect |
# |---|---|---|
# | `LST_RUN_MODE` | `auto` (default), `gee`, `synthetic` | `auto` tries Earth Engine and falls back to a synthetic twin with a LOUD banner; `gee` fails hard if Earth Engine is unavailable; `synthetic` never touches Earth Engine |
# | `LST_FAST_DEV` | `0` / `1` | shrinks every loop (rounds, bootstrap, permutations, GNN epochs) for smoke tests |
# | `LST_GRID_RES_M` | `1000` | analysis cell size (m) |
# | `LST_FINE_RES_M` | 25 (gee) / 100 (synthetic) | land-cover resolution (m); must divide the cell size |
# | `LST_N_BOOTSTRAP` | `100` (FAST_DEV: 8) | block-bootstrap replicates for SHAP confidence intervals |
# | `LST_GEE_PROJECT` | – | Earth Engine Cloud project (else Kaggle secret `GEE_PROJECT`) |
# | `LST_GEE_SERVICE_ACCOUNT_KEY` / `GOOGLE_APPLICATION_CREDENTIALS` | JSON text / path | service-account key outside Kaggle |
# | `LST_OUTPUT_DIR` | `/kaggle/working/outputs` or `./outputs` | output root |
# | `LST_USE_RAPIDS` | `0` | use cuDF/cuML (GPU dataframe assembly, GPU random forest, GPU K-means) when importable; off by default because these paths are not yet validated (Kaggle's GPU image ships RAPIDS, so without this switch it is ignored) |
# | `LST_INSTALL_RAPIDS` | `0` | install cuDF/cuML from pypi.nvidia.com before numpy is imported (several minutes; constrained to the installed numpy/pandas, `LST_RAPIDS_VERSION` pins the release); implies `LST_USE_RAPIDS` |
# | `LST_BOOT_BLOCK_KM` | auto | block size (km) of the SHAP block bootstrap; default = residual-correlation range of the spatial-CV XGBoost (≥ `INNER_BLOCK_KM`) |
# | `LST_LST_MIN_OBS` | `3` | minimum number of valid 8-day MODIS composites for a cell's seasonal LST (fewer → no target) |
# | `LST_ALLOW_PIP` | `0` | allow pip installs outside Kaggle |
# | `LST_GNN_CPU_BUDGET_S` | `900` | wall-clock budget (s) per GNN fold when no CUDA GPU is available (CPU fallback only) |
#
# ## Expected runtime (2× T4)
# * Earth Engine extraction: ~15–45 min on the first run (depends on your EE quota); re-runs reuse the
#   on-disk tile cache under `outputs/cache/` and take ~1 min.
# * Modelling at 1 km (~264k cell-epochs), extrapolated from a measured local run (GTX 1650 + 4-core CPU,
#   91 min with 10 bootstrap replicates and a capped CPU GNN): triple CV ~30–40 min (dominated by the CPU-only
#   random forest and LightGBM on Kaggle's 4 vCPUs; XGBoost and the GNN run on the T4s), Moran's I ~3 min,
#   TreeSHAP ~1 min, SHAP interaction values for every row ~10 min, block bootstrap ~1 min per replicate per T4
#   (≈ 50 min for the default 100 replicates on 2× T4), exports ~2 min: **≈ 1.3–2 h** in total. Deep trees make
#   TreeSHAP the dominant cost (its work grows with trees × leaves × depth²); `LST_N_BOOTSTRAP` trades CI
#   precision for time.
# * Synthetic mode end-to-end: the same as above at 1 km; FAST_DEV at `LST_GRID_RES_M=2000` takes ~5–15 min.
#
# In `auto` mode a missing/invalid Earth Engine login falls back to the synthetic twin, but once a
# **service-account key was supplied** and Earth Engine initialised, a failure during extraction stops the run
# (fix the cause and re-run: the tile cache resumes where it stopped) instead of silently producing synthetic output.
#
# ## Outputs
# `outputs/parquet/` (feature table, predictions + SHAP, CV metrics, Moran's I), `outputs/geo/` (districts,
# per-epoch zone polygons), `outputs/npz/` (SHAP interaction tensors), `outputs/models/xgb_final.json`,
# `outputs/figures/*.png`, `outputs/web/` (dashboard bundle) and `outputs/web_bundle.zip`.
#
# ## Loading the results into the dashboard
# Download `web_bundle.zip` from the Kaggle *Output* tab, unzip it into `dashboard/public/data/`
# (so that `dashboard/public/data/manifest.json` exists), then run `npm install && npm run dev` inside
# `dashboard/`. Alternatively host the files anywhere and set `VITE_DATA_BASE_URL` to their URL.
# Synthetic-mode bundles are flagged in the manifest and shown with a permanent "SYNTHETIC DEMO DATA" banner.

# %% [markdown]
# ## 0.1 Environment detection and dependencies
# Installs are done with `subprocess` (no notebook magics, so the same code runs as a plain script).
# Packages are only installed when an import is missing **and** we are on Kaggle (or `LST_ALLOW_PIP=1`);
# otherwise a warning is logged and the dependent step falls back gracefully later.

# %%
import gc
import importlib
import importlib.util
import json
import math
import os
import platform
import queue
import random
import re
import shutil
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

    Levels are free-form but conventionally DEBUG / INFO / WARNING / ERROR. Output goes to stdout so
    that Kaggle's cell output and the local runner interleave messages in order.
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
    "geemap": "geemap",
    "pylandstats": "pylandstats",
    "libpysal": "libpysal",
    "esda": "esda",
    "pyarrow": "pyarrow",
    "shapely": "shapely",
    "pyproj": "pyproj",
    "lightgbm": "lightgbm",
    "shap": "shap",
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

    Only packages whose import is missing are installed, and only on Kaggle or when ``LST_ALLOW_PIP=1``
    (we never modify a user's local/global Python silently). A failed group install is retried per
    package so one broken wheel does not block the others.

    Returns True when every requested package is importable afterwards.
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
                           "shapely", "pyproj", "lightgbm", "shap"]
pip_install(_REQUIRED_OPTIONAL_PKGS)
if _IS_KAGGLE and _is_interactive():
    # geemap is only used for the optional interactive map preview in section 1.
    pip_install(["geemap"])
log(f"Environment: {'Kaggle' if _IS_KAGGLE else 'local'} | Python {platform.python_version()} | "
    f"{platform.platform()}")

# %% [markdown]
# ### Optional RAPIDS install (`LST_INSTALL_RAPIDS=1`)
# Runs **before** numpy/pandas are imported (section 0.2): a RAPIDS wheel may pull in different numpy/pandas
# versions, and swapping them under an interpreter that has already imported the old ones leaves a mixed,
# broken environment. The install is constrained to the numpy/pandas versions already installed (pip then picks a
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
# Core scientific stack first; every optional/accelerator library is imported defensively so that a
# missing package only disables the feature that needs it. Matplotlib is forced to the non-interactive
# `Agg` backend when no notebook kernel is present (headless scripts, CI).

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

_OPTIONAL_MODULES = {
    "torch": torch, "xgboost": xgb, "lightgbm": lgb, "shap": shap, "earthengine-api": ee,
    "libpysal": libpysal, "esda": esda, "pylandstats": pylandstats, "shapely": shapely, "pyproj": pyproj,
}
log("versions: " + ", ".join(
    [f"numpy {np.__version__}", f"pandas {pd.__version__}", f"scipy {scipy.__version__}",
     f"sklearn {sklearn.__version__}", f"matplotlib {matplotlib.__version__}"]
    + [f"{name} {getattr(mod, '__version__', '?')}" if mod is not None else f"{name} MISSING"
       for name, mod in _OPTIONAL_MODULES.items()]))

# %% [markdown]
# ## 0.3 Configuration (`CFG`)
# A single dataclass holds every tunable. Environment variables override defaults (see the table in
# the introduction). `FAST_DEV` shrinks all expensive loops. The fine land-cover resolution depends on
# the data mode, which section 1 decides: `CFG.resolve_mode(mode)` fixes it and `CFG.fine_res()` returns it.

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
    return value.lower() in {"1", "true", "yes", "on", "y"}


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


_XGB_DEFAULT_PARAMS = {
    "objective": "reg:squarederror", "tree_method": "hist", "learning_rate": 0.03, "max_depth": 8,
    "min_child_weight": 5, "subsample": 0.8, "colsample_bytree": 0.8, "reg_lambda": 1.0,
    "reg_alpha": 0.0, "max_bin": 256, "eval_metric": "rmse",
}
_VALID_RUN_MODES = ("auto", "gee", "synthetic")


@dataclass
class LSTConfig:
    """Pipeline configuration (SPEC section 3). Construct with :meth:`from_env`."""

    RUN_MODE: str = "auto"
    FAST_DEV: bool = False
    EPOCHS: list = field(default_factory=lambda: [2010, 2015, 2020, 2025])
    SEASON: tuple = ("04-01", "06-30")
    CRS: str = "EPSG:32643"
    GRID_RES_M: int = 1000
    FINE_RES_M: Optional[int] = None          # resolved by resolve_mode(); read via fine_res()
    LM_WINDOW_CELLS: int = 1
    TARGET_MODE: str = "anomaly"
    SEED: int = 42
    N_FOLDS: int = 5
    SPATIAL_BLOCKS: tuple = (5, 5)
    INNER_BLOCK_KM: int = 10
    BOOT_BLOCK_KM: Optional[int] = None       # None = derived from the residual correlogram in section 4
    N_BOOTSTRAP: int = 100
    LST_MIN_OBS: int = 3                      # min valid 8-day LST composites per cell and season
    LST_MIN_COVERAGE: float = 0.5             # min valid-area fraction of a cell for its seasonal LST (GEE)
    K_ZONES: int = 4
    DEP_BINS: int = 40
    MORAN_K: int = 8
    MORAN_PERMS: int = 999
    XGB_PARAMS: dict = field(default_factory=lambda: dict(_XGB_DEFAULT_PARAMS))
    XGB_MAX_ROUNDS: int = 3000
    XGB_EARLY_STOP: int = 100
    GNN_EPOCHS: int = 300
    SHAP_BATCH: int = 16384
    SHAP_INTERACTION_MAX_ROWS: Optional[int] = 4000   # None on GPU (set by apply_hardware)
    GEE_PROJECT: Optional[str] = None
    GEE_TILE_PX: int = 128
    GEE_FINE_TILE_PX: int = 2048
    GEE_WORKERS: int = 6
    GEE_MAX_RETRIES: int = 6
    LC_SOURCES: dict = field(default_factory=lambda: {
        2010: "glc_fcs30d", 2015: "glc_fcs30d", 2020: "esa_worldcover", 2025: "dynamic_world"})
    INSTALL_RAPIDS: bool = False
    USE_RAPIDS: bool = False                  # cuDF/cuML paths are opt-in (LST_USE_RAPIDS / LST_INSTALL_RAPIDS)
    OUTPUT_DIR: Path = Path("outputs")
    CACHE_DIR: Path = field(init=False)
    FIG_DIR: Path = field(init=False)
    PARQUET_DIR: Path = field(init=False)
    GEO_DIR: Path = field(init=False)
    MODEL_DIR: Path = field(init=False)
    NPZ_DIR: Path = field(init=False)
    WEB_DIR: Path = field(init=False)
    DATA_MODE: Optional[str] = None           # "gee" | "synthetic" once resolved by section 1

    def __post_init__(self) -> None:
        if self.RUN_MODE not in _VALID_RUN_MODES:
            raise ValueError(f"RUN_MODE must be one of {_VALID_RUN_MODES}, got {self.RUN_MODE!r}")
        if self.TARGET_MODE not in ("anomaly", "absolute"):
            raise ValueError(f"TARGET_MODE must be 'anomaly' or 'absolute', got {self.TARGET_MODE!r}")
        if self.GRID_RES_M <= 0:
            raise ValueError(f"GRID_RES_M must be positive, got {self.GRID_RES_M}")
        if self.BOOT_BLOCK_KM is not None and self.BOOT_BLOCK_KM <= 0:
            raise ValueError(f"BOOT_BLOCK_KM must be positive or None, got {self.BOOT_BLOCK_KM}")
        if self.LST_MIN_OBS < 1:
            raise ValueError(f"LST_MIN_OBS must be >= 1, got {self.LST_MIN_OBS}")
        self.OUTPUT_DIR = Path(self.OUTPUT_DIR).expanduser().resolve()
        self.CACHE_DIR = self.OUTPUT_DIR / "cache"
        self.FIG_DIR = self.OUTPUT_DIR / "figures"
        self.PARQUET_DIR = self.OUTPUT_DIR / "parquet"
        self.GEO_DIR = self.OUTPUT_DIR / "geo"
        self.MODEL_DIR = self.OUTPUT_DIR / "models"
        self.NPZ_DIR = self.OUTPUT_DIR / "npz"
        self.WEB_DIR = self.OUTPUT_DIR / "web"

    @classmethod
    def from_env(cls) -> "LSTConfig":
        """Build the configuration from defaults + ``LST_*`` environment variables + Kaggle secrets."""
        fast = _env_bool("LST_FAST_DEV", False)
        default_out = Path("/kaggle/working/outputs") if _IS_KAGGLE else Path.cwd() / "outputs"
        cfg = cls(
            RUN_MODE=(_env_str("LST_RUN_MODE", "auto") or "auto").lower(),
            FAST_DEV=fast,
            GRID_RES_M=_env_int("LST_GRID_RES_M", 1000),
            TARGET_MODE=(_env_str("LST_TARGET_MODE", "anomaly") or "anomaly").lower(),
            N_BOOTSTRAP=_env_int("LST_N_BOOTSTRAP", 8 if fast else 100),
            GEE_PROJECT=_env_str("LST_GEE_PROJECT") or _kaggle_secret("GEE_PROJECT"),
            GEE_WORKERS=_env_int("LST_GEE_WORKERS", 6),
            INSTALL_RAPIDS=_env_bool("LST_INSTALL_RAPIDS", False),
            USE_RAPIDS=_env_bool("LST_USE_RAPIDS", False) or _env_bool("LST_INSTALL_RAPIDS", False),
            BOOT_BLOCK_KM=_env_int("LST_BOOT_BLOCK_KM", None),
            LST_MIN_OBS=_env_int("LST_LST_MIN_OBS", 3),
            OUTPUT_DIR=Path(_env_str("LST_OUTPUT_DIR") or default_out),
        )
        if fast:
            cfg.MORAN_PERMS = 99
            cfg.XGB_MAX_ROUNDS = 300
            cfg.XGB_EARLY_STOP = 30
            cfg.GNN_EPOCHS = 40
            cfg.XGB_PARAMS.update({"learning_rate": 0.08, "max_depth": 6})
        cfg.make_dirs()
        return cfg

    def make_dirs(self) -> None:
        """Create the output directory tree (idempotent)."""
        for path in (self.OUTPUT_DIR, self.CACHE_DIR, self.FIG_DIR, self.PARQUET_DIR, self.GEO_DIR,
                     self.MODEL_DIR, self.NPZ_DIR, self.WEB_DIR):
            path.mkdir(parents=True, exist_ok=True)

    def _fine_res_for(self, mode: str) -> int:
        """Requested fine resolution for ``mode`` snapped to a divisor of GRID_RES_M."""
        requested = _env_int("LST_FINE_RES_M", 25 if mode == "gee" else 100)
        if requested <= 0:
            raise ValueError(f"LST_FINE_RES_M must be positive, got {requested}")
        if self.GRID_RES_M % requested == 0:
            return requested
        snapped = _nearest_divisor(self.GRID_RES_M, requested)
        log(f"FINE_RES_M={requested} does not divide GRID_RES_M={self.GRID_RES_M}; using {snapped} m", "WARNING")
        return snapped

    def resolve_mode(self, mode: str) -> int:
        """Record the data mode decided by section 1 and fix FINE_RES_M accordingly; returns it."""
        if mode not in ("gee", "synthetic"):
            raise ValueError(f"data mode must be 'gee' or 'synthetic', got {mode!r}")
        self.DATA_MODE = mode
        self.FINE_RES_M = self._fine_res_for(mode)
        return self.FINE_RES_M

    def fine_res(self) -> int:
        """Fine land-cover resolution in metres (resolved value, else the RUN_MODE default)."""
        if self.FINE_RES_M is not None:
            return int(self.FINE_RES_M)
        return self._fine_res_for("synthetic" if self.RUN_MODE == "synthetic" else "gee")

    def apply_hardware(self, env: dict) -> None:
        """Adjust hardware-dependent settings once ``ENV`` is known."""
        self.SHAP_INTERACTION_MAX_ROWS = None if env.get("xgb_device") == "cuda" else 4000

    def as_dict(self) -> dict:
        """JSON-friendly snapshot (Paths as strings) for logging and the export manifest."""
        out = {}
        for f in fields(self):
            value = getattr(self, f.name)
            out[f.name] = str(value) if isinstance(value, Path) else value
        return out


CFG = LSTConfig.from_env()
log(f"CFG: RUN_MODE={CFG.RUN_MODE} FAST_DEV={CFG.FAST_DEV} GRID_RES_M={CFG.GRID_RES_M} "
    f"OUTPUT_DIR={CFG.OUTPUT_DIR}")

# %% [markdown]
# ## 0.4 Hardware detection (`ENV`)
# The GPU count comes from the **CUDA runtime** (`torch.cuda.device_count()`, else CuPy), which honours
# `CUDA_VISIBLE_DEVICES`; `nvidia-smi` (NVML ignores that variable) is only the fallback when neither can be queried,
# and its rows are filtered by `CUDA_VISIBLE_DEVICES`. XGBoost trains on CUDA only if GPUs exist **and** the
# installed wheel was built with CUDA (`xgboost.build_info()["USE_CUDA"]`, with a tiny training probe as
# fallback). RAPIDS (cuDF/cuML) is used only with `LST_USE_RAPIDS=1` (or `LST_INSTALL_RAPIDS=1`): Kaggle's GPU image
# ships it preinstalled, but its paths (GPU dataframe assembly, cuML random forest and K-means) are not yet validated,
# so by default the pipeline runs the pandas / scikit-learn paths everywhere. `ENV["rapids_used"]` records which
# RAPIDS backends actually ran (the manifest's `hardware.rapids` is derived from it).

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
        "lgbm_device": "cpu",   # resolved by section 3 after a GPU probe
        "torch_version": getattr(torch, "__version__", None),
        "python": platform.python_version(),
        "platform": platform.platform(),
    }


ENV = _detect_env()
CFG.apply_hardware(ENV)
log(f"ENV: {ENV['n_gpus']} GPU(s) {ENV['gpu_names']} | xgb {ENV['xgb_version']} on {ENV['xgb_device']} | "
    f"cupy={ENV['has_cupy']} cudf={ENV['has_cudf']} cuml={ENV['has_cuml']}")
if ENV["has_cuda"] and ENV["xgb_device"] == "cpu":
    log("GPUs found but this XGBoost build has no CUDA support - XGBoost will run on CPU.", "WARNING")

# %% [markdown]
# ## 0.5 Shared utilities
# Timing, memory hygiene (host + CUDA + CuPy pools), retry with exponential backoff and jitter,
# deterministic seeding, strict JSON writing (NaN → `null`, numpy/pandas aware), GPU memory reporting and a
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


def save_json(obj: Any, path, *, round_floats: Optional[int] = None) -> Path:
    """Write ``obj`` as strict UTF-8 JSON (NaN/Inf → null, numpy/pandas aware, compact separators).

    ``round_floats`` rounds every float to that many decimals. The file is written atomically
    (temporary file + rename) so an interrupted run never leaves truncated JSON behind.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(_to_jsonable(obj, round_floats), ensure_ascii=False, separators=(",", ":"),
                      allow_nan=False)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)
    return path


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

    With ≥2 CUDA GPUs usable by XGBoost, a thread pool with one worker per GPU pulls free GPU ids from a
    queue, so each GPU runs exactly one task at a time (XGBoost/PyTorch release the GIL inside CUDA work,
    so threads give real parallelism). Otherwise tasks run sequentially with ``gpu_id=0``
    (``xgb_device_for(0)`` then yields "cpu" on CPU-only machines). The first failure cancels pending tasks
    and is re-raised with its original type, annotated with the failing item and GPU.
    """
    items = list(items)
    n_workers = ENV.get("n_gpus", 0) if ENV.get("xgb_device") == "cuda" else 0
    if n_workers <= 1 or len(items) <= 1:
        results = []
        for i, item in enumerate(items):
            try:
                results.append(fn(item, 0))
            except BaseException as exc:
                _annotate_task_error(exc, i, item, 0)
                raise
        return results

    free_gpus: "queue.Queue[int]" = queue.Queue()
    for gpu_id in range(n_workers):
        free_gpus.put(gpu_id)

    def _task(index: int, item: Any):
        gpu_id = free_gpus.get()
        try:
            return fn(item, gpu_id)
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

    Recognises MemoryError, torch.cuda.OutOfMemoryError, cupy OutOfMemoryError and XGBoost/CUDA/RMM/cuSPARSE/
    cuBLAS messages ("out of memory", "cudaErrorMemoryAllocation", "bad_alloc", "CUSPARSE_STATUS_ALLOC_FAILED", ...).
    """
    return _oom_in_chain(exc, count_host_memory_error=True)


def is_gpu_oom_error(exc: BaseException) -> bool:
    """True only for a GPU out-of-memory condition (a bare host ``MemoryError`` is excluded).

    Used to decide GPU -> CPU retries: moving work to the CPU after the *host* ran out of RAM needs more host
    memory, not less, so that case must propagate instead.
    """
    return _oom_in_chain(exc, count_host_memory_error=False)


set_seeds(CFG.SEED)
log("utilities ready")

# %% [markdown]
# ## 0.6 Configuration and hardware summary

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
] + [(f"lib: {name}", "ok" if mod is not None else "MISSING") for name, mod in _OPTIONAL_MODULES.items()]
_print_table("Configuration", _cfg_rows)
_print_table("Hardware / software", _hw_rows)
gpu_mem_report()
del _cfg_rows, _hw_rows
