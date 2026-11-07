# %% [markdown]
# # 3. Earth Engine: Landsat C2 L2 day LST and spectral composites (gee mode only)
#
# This section builds the **day target** of v2 and the Landsat spectral predictors for every observed frame
# (SPEC §2.1). It only runs in gee mode; in synthetic mode section 02 already provides the same globals and nothing
# here runs (the functions are still defined but none of them is called).
#
# **Why Landsat?** Collection-2 Level-2 surface temperature (ST) is the only day-LST record that runs unchanged from
# 1990 to 2025 (docs/research/gee_datasets_v2.md). The overpass is ~10:10–10:50 IST, at 30 m. The 1990s archive over
# Delhi NCR is thin, so every frame is the Apr–Jun season of a **multi-year window** (`CFG.WINDOWS`, e.g.
# 1990 = 1989–1992).
#
# **Recipe** (verified against the Earth Engine catalog and the earthengine-api source):
# 1. **Collections:** `LANDSAT/LT05|LE07|LC08|LC09/C02/T1_L2`, restricted to the five WRS-2 path/rows that cover
#    the ROI (146/040, 146/041, 147/039, 147/040, 147/041). Landsat 7 is used only before **2021-01-01**: its orbit
#    drifted and by 2022 it passed at 09:17 IST.
# 2. **Masks:** QA_PIXEL bits 0–4 clear (fill, dilated cloud, cirrus, cloud, shadow); QA_RADSAT == 0;
#    ST_QA × 0.01 ≤ 3 K; ST_CDIST × 0.01 ≥ 1 km (ST errors are known to grow near clouds); scaled SR in [0, 1];
#    ST DN > 0 (ST is not retrieved where ASTER GED emissivity is missing).
# 3. **Scaling:** SR × 2.75e-05 − 0.2; ST × 0.00341802 + 149 K → °C.
# 4. **Harmonisation:** TM/ETM+ reflectance is mapped to OLI with the Roy et al. (2016) ETM+→OLI OLS coefficients.
#    These are applied unscaled, because C2 reflectance is already 0–1. TM is treated like ETM+.
# 5. **Per-path composites:** scenes of adjacent rows on one path come from the same orbit pass, so the scenes of each
#    path are first **mosaicked per acquisition date**. Overlapping rows of the same pass then count once, as one
#    observation. The per-date mosaics are reduced with one combined `median + count` reducer: one pass over the data
#    gives both the composite and the clear-observation count. NDVI, NDBI, MNDWI (green/SWIR1) and the Liang (2001)
#    broadband albedo are computed from that same median composite, at 30 m. A separate Feb–Mar composite (red/NIR
#    only) gives `ndvi_spring_f`.
# 6. **Aggregation:** each 30 m band is aggregated to the fine grid (`GRID_FINE`, 250 m at the 1 km grid) with a
#    mask-weighted, area-weighted `reduceResolution(mean)`. A fine pixel is kept only where ≥ 50 % of its area has
#    valid 30 m pixels, so a small sliver cannot stand for the whole pixel. Aggregating **per path, before the
#    mosaic**, keeps the server-side work at the 30 m composite and moves the mosaic to the cheap 250 m level.
# 7. **Path-offset harmonisation** (client side, exact SPEC semantics): δ = median(LST₁₄₆ − LST₁₄₇) over the
#    overlap of the two paths at ≥ 250 m. The offset is split symmetrically: δ/2 is removed from path 146 and
#    added to path 147. The two paths are then mosaicked (mean where both exist). Spectral bands are mosaicked
#    without an offset. `path_offsets = {"146": +δ/2, "147": −δ/2}` is the value removed from each path, the same
#    convention as section 02.
# 8. **Metadata** (`FRAME_META[y]["day"]`): the scene lists come from `aggregate_array` of WRS_PATH, WRS_ROW,
#    SCENE_CENTER_TIME, CLOUD_COVER(_LAND) and `system:time_start`. Earth Engine does not catalogue DATE_ACQUIRED,
#    so the acquisition date comes from `system:time_start`. From these lists the section derives: the sensors; the
#    number of *clear* scenes (land cloud ≤ 30 %, the definition of the USGS inventory in the research notes) per
#    path/row; the mean overpass in IST (UTC + 5.5 h); and the coverage of the ROI.
# 9. **Heating rate** for the 10:45 IST overpass correction of section 09: ERA5-Land hourly `skin_temperature`,
#    Apr–Jun of the window, ROI mean, `(T(06 UTC) − T(04 UTC)) / 2` in K h⁻¹. 04 and 06 UTC are 09:30 and
#    11:30 IST.
#
# **Extraction** (`CFG.GEE_EXPORT`):
# * `interactive`: tiled `computePixels` (section 01's `fetch_grid`: retry/backoff, quartering on memory and timeout
#   errors, an on-disk tile cache keyed by the hash of the serialised expression). Tiles cover about 64 km × 64 km
#   (256 px at 250 m), so each request's 30 m medians stay within interactive limits.
# * `asset`: one `Export.image.toAsset` batch task per frame on the exact `GRID_FINE` (crs + crsTransform +
#   dimensions, pyramiding mean). All frames are submitted at once, but **noncommercial projects run about 2 batch
#   tasks at a time**, so the 8 frame exports take about 4 rounds (about 1.5-6 h). Every task has its own limits:
#   `LST_GEE_EXPORT_TIMEOUT_S` (3 h) counted from the first poll that saw it RUNNING and `LST_GEE_EXPORT_QUEUE_S`
#   (4 h) while it waits in the queue. A FAILED, CANCELLED or timed-out frame does not stop the others: a still
#   active task is cancelled and that frame is extracted interactively. Each poll logs the number of RUNNING tasks
#   (the maximum is kept in `_S03_QA['export_concurrency']`). Completed exports are read with cheap `computePixels`.
#   The asset name contains the expression hash, so a rerun (or a new Kaggle session) reuses finished assets and
#   attaches to tasks that are still running instead of paying the EECU again.
#
# A frame whose ROI fine-pixel coverage is below `LST_DAY_MIN_FRAME_COVERAGE` (0.2) stops the section with a
# diagnosis (an acquisition fault, e.g. a QA or ST-band problem of one sensor) before it is stage-cached; its tiles
# stay cached, so a rerun is cheap. Every frame records its extraction cost (mode, wall time, tiles, splits) in
# `_S03_QA`; the table at the end of the section (and, for the pilot, a projected full-run time) calibrates the full
# run.
#
# Missing data is never silently zero. A path/row without scenes is logged as a warning and recorded in
# `DATA_CAVEATS`. Its pixels stay NaN, and its clear-scene count stays 0, which is the true count.

# %%
_S03_ACTIVE = globals().get("DATA_MODE") == "gee"
_S03_RECIPE_VERSION = "s03-landsat-v2.2"   # v2.2: 30 m working grid on the native 15 mod 30 m lattice

# Landsat Collection 2 Level-2 Tier 1 collections (Earth Engine catalog ids) and their operating periods in the
# catalog (start inclusive; end exclusive or None = still acquiring). Landsat 7 is cut at 2021-01-01 (orbit drift).
_S03_SENSORS = {
    "L5": {"asset": "LANDSAT/LT05/C02/T1_L2", "start": "1984-03-16", "end": "2012-05-06", "family": "tm",
           "label": "Landsat 5 TM"},
    "L7": {"asset": "LANDSAT/LE07/C02/T1_L2", "start": "1999-05-28", "end": "2021-01-01", "family": "tm",
           "label": "Landsat 7 ETM+"},
    "L8": {"asset": "LANDSAT/LC08/C02/T1_L2", "start": "2013-03-18", "end": None, "family": "oli",
           "label": "Landsat 8 OLI/TIRS"},
    "L9": {"asset": "LANDSAT/LC09/C02/T1_L2", "start": "2021-10-31", "end": None, "family": "oli",
           "label": "Landsat 9 OLI-2/TIRS-2"},
}
_S03_L7_SLC_OFF_DATE = "2003-05-31"            # scan-line-corrector failure (ETM+ striping afterwards)
_S03_L7_END = "2021-01-01"                     # SPEC §2.1: Landsat 7 only before this date

# Band layouts (C2 L2): TM/ETM+ SR_B1..B5,B7 = blue..SWIR2, ST_B6; OLI SR_B2..B7 = blue..SWIR2, ST_B10.
_S03_SR_NAMES = ["blue", "green", "red", "nir", "swir1", "swir2"]
_S03_SR_BANDS = {"tm": ["SR_B1", "SR_B2", "SR_B3", "SR_B4", "SR_B5", "SR_B7"],
                 "oli": ["SR_B2", "SR_B3", "SR_B4", "SR_B5", "SR_B6", "SR_B7"]}
_S03_ST_BAND = {"tm": "ST_B6", "oli": "ST_B10"}
_S03_SR_SCALE, _S03_SR_OFFSET = 2.75e-05, -0.2
_S03_ST_SCALE, _S03_ST_OFFSET_K = 0.00341802, 149.0
_S03_QA_CLEAR_BITS = 0b11111                   # QA_PIXEL bits 0-4: fill, dilated cloud, cirrus, cloud, shadow
_S03_ST_QA_MAX_K = 3.0                         # ST_QA x 0.01 (K uncertainty)
_S03_ST_CDIST_MIN_KM = 1.0                     # ST_CDIST x 0.01 (km to nearest cloud)
# Roy et al. 2016 (RSE 185, Table 2) ETM+ -> OLI OLS: OLI = intercept + slope x ETM+, blue..SWIR2 (0-1 reflectance).
_S03_ROY_SLOPES = [0.8474, 0.8483, 0.9047, 0.8462, 0.8937, 0.9071]
_S03_ROY_INTERCEPTS = [0.0003, 0.0088, 0.0061, 0.0412, 0.0254, 0.0172]
# Liang (2001) shortwave broadband albedo (TM/ETM+ bands 1,3,4,5,7 = OLI 2,4,5,6,7 after harmonisation).
_S03_LIANG = {"blue": 0.356, "red": 0.130, "nir": 0.373, "swir1": 0.085, "swir2": 0.072, "const": -0.0018}

# WRS-2 path/rows covering the ROI (gee_datasets_v2.md F1); 145, 148 and row 042 add < 2 % and are excluded.
_S03_PATHROWS = ["146/040", "146/041", "147/039", "147/040", "147/041"]
_S03_PATHS = ["146", "147"]
_S03_CLEAR_SCENE_MAX_CLOUD = 30.0              # "clear scene" = land cloud cover <= 30 % (USGS inventory definition)
_S03_SPARSE_SCENES = 6                         # SPEC §1.2 tier rule: < 6 clear scenes on any path/row
_S03_IST_OFFSET_H = 5.5
_S03_PIXEL_MIN_VALID_FRAC = 0.5                # >= 50 % valid 30 m area per fine pixel
_S03_OFFSET_MIN_RES_M = 250                    # SPEC: path offset estimated at >= 250 m
_S03_MIN_OVERLAP_PX = 200                      # minimum overlap pixels for an offset estimate
_S03_ERA5_HOURLY = "ECMWF/ERA5_LAND/HOURLY"
_S03_ERA5_SCALE_M = 11132.0                    # ERA5-Land native pixel size (catalog)
_S03_HEATING_UTC_HOURS = (4, 6)                # 09:30 and 11:30 IST
_S03_COMPOSITE_SCALE_M = 30.0
_S03_PATH_BANDS = ["lst", "nobs", "ndvi", "ndbi", "mndwi", "albedo", "ndvi_spring"]
_S03_FINE_KEYS = ["lst_day_f", "lst_day_nobs_f", "ndvi_f", "ndbi_f", "mndwi_f", "albedo_f", "ndvi_spring_f"]
_S03_BAND_TO_KEY = dict(zip(_S03_PATH_BANDS, _S03_FINE_KEYS))
_S03_DAY_META_KEYS = ("sensors", "scenes", "scenes_per_pathrow", "mean_overpass_ist_h", "coverage",
                      "heating_rate_k_per_h", "path_offsets")
_S03_INTERACTIVE_TILE_GROUND_M = 64_000        # ~64 km tiles: 256 px at 250 m (interactive compute limits)
_S03_EXPORT_TIMEOUT_S = int(_env_int("LST_GEE_EXPORT_TIMEOUT_S", 3 * 3600))    # per task, from first RUNNING poll
_S03_EXPORT_QUEUE_S = int(_env_int("LST_GEE_EXPORT_QUEUE_S", 4 * 3600))        # per task, waiting before RUNNING
_S03_EXPORT_POLL_S = float(_env_int("LST_GEE_EXPORT_POLL_S", 30))
_S03_EXPORT_POLL_MAX_S = 300.0
_S03_ASSET_PROPERTY = "lst_expr_sha1"          # expression hash stored on every exported asset
# D9: below this ROI fine-pixel coverage a day frame is an acquisition fault (RuntimeError before stage caching)
_S03_DAY_MIN_FRAME_COVERAGE = float(_env_str("LST_DAY_MIN_FRAME_COVERAGE") or 0.2)
_S03_FULL_FRAMES = 8                           # frames of the full profile (pilot cost extrapolation)

# Section-3 QA record (private): per-frame scene tables, all-scene counts, offset diagnostics, task records.
_S03_QA: dict = {}

if _S03_ACTIVE:
    # The acquisition layer (03-05) owns these globals in gee mode; 04 and 05 add to them.
    if not isinstance(globals().get("RAW_STATIC"), dict):
        RAW_STATIC = {}
    if not isinstance(globals().get("RAW_OBS"), dict):
        RAW_OBS = {}
    if not isinstance(globals().get("FRAME_META"), dict):
        FRAME_META = {}
    if "SYNTHETIC_TRUTH" not in globals():
        SYNTHETIC_TRUTH = None
    log(f"03: Landsat day LST for frames {CFG.FRAMES_OBS} (windows "
        f"{ {y: CFG.WINDOWS[y] for y in CFG.FRAMES_OBS} }) via GEE_EXPORT={CFG.GEE_EXPORT}")
else:
    log(f"03: DATA_MODE={globals().get('DATA_MODE')} - Earth Engine Landsat section skipped (section 02 provides "
        "the day LST)")

# %% [markdown]
# ## 3.1 Shared Earth Engine fetch / export helpers (public, reused by sections 04–05)
# * `gee_fetch_grid(image, grid, bands, name, ...)` downloads bands of an `ee.Image` onto a `GridSpec` as a
#   `(len(bands), H, W)` array. Masked pixels become NaN for float outputs. It wraps section 01's `fetch_grid`
#   (tiled, retried, split on memory or timeout errors, tile cache keyed by the expression hash) and picks a tile
#   size that respects the 48 MB request limit.
# * `gee_export_to_asset(image, asset_id, grid, ...)` runs one batch `Export.image.toAsset` on the exact grid. It
#   reuses an existing asset whose stored expression hash matches, attaches to a task with the same description
#   that is still running, and otherwise starts a new one. With `wait=True` it polls until done.
#   `gee_wait_for_exports(handles, raise_on_failure=False)` waits for several handles at once with per-task running
#   and queue limits and records each terminal state; `gee_cancel_export(handle)` cancels a still-active task whose
#   job is then extracted interactively.
# * `gee_fetch_asset(asset_id, grid, bands, name)` reads a finished asset with `computePixels`, using large tiles
#   because no computation is involved.

# %%
def _s03_call(fn, what: str, tries: Optional[int] = None):
    """Run a small Earth Engine call with backoff on transient errors (quota, 5xx, timeouts); others raise."""

    def _once():
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001 - classified into transient vs permanent
            err = _classify_gee_error(exc, allow_split=False)
            if err is exc:
                raise
            raise err from exc

    def _on_retry(attempt, exc, delay):
        log(f"{what}: transient Earth Engine error (attempt {attempt}), retrying in {delay:.0f}s: "
            f"{str(exc)[:160]}", "WARNING")

    return retry(_once, tries=int(tries or CFG.GEE_MAX_RETRIES), base_delay=3.0, max_delay=90.0,
                 retry_on=(_GEETransientError,), on_retry=_on_retry)


def _s03_getinfo(obj, what: str):
    """``obj.getInfo()`` with transient-error backoff."""
    return _s03_call(lambda: obj.getInfo(), what)


def _s03_default_tile_px(grid: GridSpec, n_bands: int, dtype=np.float32, heavy: bool = True) -> int:
    """Tile side for ``computePixels``.

    Heavy (computed) images use ~64 km tiles, so a request's 30 m medians fit interactive limits. Asset reads use
    the largest tile under the 48 MB limit, capped at ``CFG.GEE_STACK_TILE_PX``.
    """
    cap = int(CFG.GEE_STACK_TILE_PX)
    if heavy:
        cap = min(cap, max(32, int(round(_S03_INTERACTIVE_TILE_GROUND_M / grid.res / 16.0)) * 16))
    return gee_tile_px(n_bands, dtype, cap=cap)


def gee_fetch_grid(image, grid: GridSpec, bands: Sequence[str], name: str, *, tile_px: Optional[int] = None,
                   dtype=np.float32, extra: Any = None, heavy: bool = True, unmask: bool = True,
                   split: bool = True, stats: Optional[dict] = None) -> np.ndarray:
    """Download ``bands`` of ``image`` on ``grid`` as a ``(len(bands), H, W)`` array (shared by sections 03–05).

    * ``name`` is the cache-folder prefix; the folder name also hashes ``grid``, ``extra`` and the serialised
      expression, so any change of server-side parameters gets fresh tiles.
    * For float dtypes the image is ``unmask(NODATA_FLOAT, sameFootprint=False)``-ed before download, so masked
      pixels (also those outside a clip footprint) arrive as the sentinel, and ``fetch_grid`` turns them into NaN.
      Integer outputs are delivered as computed (choose an explicit nodata value server-side).
    * ``heavy=True`` (computed composites) uses ~64 km tiles; ``heavy=False`` (asset reads) uses large tiles.
    * ``split=False`` never subdivides a tile (size/time-out errors then get at most two tries); ``stats`` (dict)
      receives the fetch statistics (tiles, cached, splits, fetched, seconds).
    """
    if ee is None:
        raise RuntimeError("earthengine-api is not available")
    bands = [str(b) for b in bands]
    if not bands:
        raise ValueError("gee_fetch_grid: no bands requested")
    dtype = np.dtype(dtype)
    img = ee.Image(image).select(bands)
    if unmask and dtype.kind == "f":
        img = img.unmask(NODATA_FLOAT, False).toFloat()
    tile = int(tile_px) if tile_px else _s03_default_tile_px(grid, len(bands), dtype, heavy=heavy)
    key = gee_cache_key(name, grid, extra, image=img)
    return fetch_grid(img, grid, bands, tile, key, dtype, allow_split=split, stats=stats)


_S03_ASSET_ROOT_RE = re.compile(r"^projects/[^/]+/assets$")


def _s03_is_not_found(exc: BaseException) -> bool:
    return bool(re.search(r"not found|does not exist|\b404\b", str(exc), re.IGNORECASE))


def _s03_get_asset(asset_id: str) -> Optional[dict]:
    """Asset metadata dict, or None if the asset does not exist (other errors raise)."""
    try:
        return _s03_call(lambda: ee.data.getAsset(asset_id), f"getAsset {asset_id}", tries=3)
    except Exception as exc:  # noqa: BLE001
        if _s03_is_not_found(exc):
            return None
        raise


def _s03_ensure_folder(folder: str) -> None:
    """Create ``folder`` (and missing parents below ``projects/<p>/assets``) as Earth Engine FOLDER assets."""
    folder = folder.rstrip("/")
    if not folder or _S03_ASSET_ROOT_RE.match(folder) or "/" not in folder:
        return
    info = _s03_get_asset(folder)
    if info is not None:
        kind = str(info.get("type", "")).upper()
        if kind and kind not in ("FOLDER", "IMAGE_COLLECTION"):
            raise RuntimeError(f"asset folder path {folder} exists but is a {kind}, not a folder")
        return
    _s03_ensure_folder(folder.rsplit("/", 1)[0])
    try:
        _s03_call(lambda: ee.data.createAsset({"type": "FOLDER"}, folder), f"createAsset {folder}", tries=3)
        log(f"created Earth Engine asset folder {folder}")
    except Exception as exc:  # noqa: BLE001
        if re.search(r"already exists", str(exc), re.IGNORECASE):
            return
        raise RuntimeError(f"cannot create asset folder {folder}: {type(exc).__name__}: {str(exc)[:200]} | fix: "
                           "grant the service account 'Earth Engine Resource Writer' or set "
                           "LST_GEE_EXPORT=interactive") from exc


def _s03_task_description(text: str) -> str:
    """Batch task description: letters, digits, '_' and '-' only, at most 100 characters."""
    return re.sub(r"[^A-Za-z0-9_-]", "_", str(text))[:100]


def _s03_active_task(description: str) -> Optional[dict]:
    """A READY/RUNNING task of this project with exactly ``description`` (e.g. from an interrupted session)."""
    try:
        tasks = _s03_call(lambda: ee.data.getTaskList(), "getTaskList", tries=3) or []
    except Exception as exc:  # noqa: BLE001 - listing is an optimisation; never fatal
        log(f"could not list Earth Engine tasks ({type(exc).__name__}: {str(exc)[:120]}); starting a new task",
            "WARNING")
        return None
    for task in tasks:
        if task.get("description") == description and str(task.get("state")) in ("READY", "RUNNING"):
            return task
    return None


def gee_export_to_asset(image, asset_id: str, grid: GridSpec, *, description: Optional[str] = None,
                        pyramiding: str = "mean", max_pixels: float = 1e13, wait: bool = True,
                        timeout_s: Optional[float] = None, poll_s: Optional[float] = None,
                        reuse: bool = True) -> dict:
    """Batch-export ``image`` to the Earth Engine asset ``asset_id`` on exactly ``grid`` (shared by 03–05).

    The export uses ``crs`` + ``crsTransform`` + ``dimensions="WxH"`` (no region/scale), which the API turns into
    the exact pixel rectangle of ``grid``, with pyramiding policy ``pyramiding`` for every band. The SHA-1 of the
    serialised expression is stored as the asset property ``lst_expr_sha1``:

    * an existing asset with the same hash is **reused** (no EECU spent); one with a different hash is deleted and
      re-exported;
    * a READY/RUNNING task with the same description (an interrupted session) is attached to, not duplicated;
    * the parent folder is created if missing.

    Returns a handle ``{asset_id, description, task, task_id, state, reused, digest, started, eecu_s}``. With
    ``wait=True`` this blocks until the task is done (see ``gee_wait_for_exports``) and raises on FAILED,
    CANCELLED or timeout.
    """
    if ee is None:
        raise RuntimeError("earthengine-api is not available")
    if not asset_id or "/" not in asset_id:
        raise ValueError(f"invalid asset id {asset_id!r}")
    description = _s03_task_description(description or asset_id.rsplit("/", 1)[-1])
    digest = _gee_expression_digest(image)
    handle = {"asset_id": asset_id, "description": description, "task": None, "task_id": None, "state": None,
              "reused": False, "digest": digest, "started": time.time(), "eecu_s": None}
    _s03_ensure_folder(asset_id.rsplit("/", 1)[0])
    existing = _s03_get_asset(asset_id)
    if existing is not None:
        stored = (existing.get("properties") or {}).get(_S03_ASSET_PROPERTY)
        if reuse and stored == digest:
            log(f"asset {asset_id} already exported with the same expression - reused (no EECU spent)")
            handle.update(state="COMPLETED", reused=True)
            return handle
        log(f"asset {asset_id} exists with a different expression hash ({stored}); deleting and re-exporting",
            "WARNING")
        _s03_call(lambda: ee.data.deleteAsset(asset_id), f"deleteAsset {asset_id}", tries=3)
    running = _s03_active_task(description)
    if running is not None:
        log(f"attaching to running Earth Engine task {running.get('id')} ({description}, state "
            f"{running.get('state')}) instead of starting a duplicate")
        handle.update(task_id=running.get("id"), state=str(running.get("state")))
    else:
        export_image = ee.Image(image).set(_S03_ASSET_PROPERTY, digest)
        task = ee.batch.Export.image.toAsset(
            image=export_image, description=description, assetId=asset_id,
            pyramidingPolicy={".default": str(pyramiding)}, dimensions=f"{int(grid.width)}x{int(grid.height)}",
            crs=grid.crs, crsTransform=grid.transform_list(), maxPixels=int(max_pixels))
        _s03_call(task.start, f"start export {description}", tries=4)
        handle.update(task=task, task_id=getattr(task, "id", None), state="READY")
        log(f"started Earth Engine export {description} -> {asset_id} (task {handle['task_id']}, "
            f"{grid.width}x{grid.height} px @ {grid.res} m)")
    if wait:
        gee_wait_for_exports([handle], timeout_s=timeout_s, poll_s=poll_s)
    return handle


def _s03_task_status(handle: dict) -> dict:
    """Current status dict of an export handle (own Task object or an attached task id)."""
    if handle.get("task") is not None:
        return _s03_call(handle["task"].status, f"status {handle['description']}", tries=4)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")   # getTaskStatus is deprecated but works on every API version
        statuses = _s03_call(lambda: ee.data.getTaskStatus(handle["task_id"]),
                             f"status {handle['description']}", tries=4)
    return statuses[0] if statuses else {"state": "UNKNOWN"}


def _s03_failure_hint(message: str) -> str:
    low = message.lower()
    if "permission" in low or "denied" in low or "not authorized" in low:
        return "grant the service account 'Earth Engine Resource Writer' on the project (or LST_GEE_EXPORT=interactive)"
    if "maxpixels" in low or "too many pixels" in low:
        return "the export exceeds maxPixels: raise max_pixels"
    if "memory" in low or "computation timed out" in low:
        return ("the composite exceeded batch memory/time: rerun (tasks are retried server side) or use "
                "LST_GEE_EXPORT=interactive, whose tiles split automatically")
    if "quota" in low or "eecu" in low:
        return "the project's EECU quota is exhausted: wait for the monthly reset or move to the Contributor tier"
    return "inspect the task in the Earth Engine Code Editor Tasks tab"


_S03_EXPORT_TERMINAL = ("COMPLETED", "FAILED", "CANCELLED", "TIMEOUT_RUNNING", "TIMEOUT_QUEUED")


def gee_wait_for_exports(handles: Sequence[dict], *, timeout_s: Optional[float] = None,
                         poll_s: Optional[float] = None, queue_s: Optional[float] = None,
                         raise_on_failure: bool = True, stats: Optional[dict] = None) -> list:
    """Poll export handles until every one is terminal (backoff ``poll_s`` × 1.5 up to 5 min).

    Per-task limits: a task times out ``timeout_s`` (default ``LST_GEE_EXPORT_TIMEOUT_S`` = 3 h) after the first poll
    that saw it RUNNING (``h["running_since"]``), and ``queue_s`` (default ``LST_GEE_EXPORT_QUEUE_S`` = 4 h) after
    the wait began while it is not yet RUNNING (noncommercial projects run about 2 batch tasks at a time, so queueing
    is normal).

    * ``raise_on_failure=True``: FAILED (with the server's error and a fix hint), CANCELLED/CANCEL_REQUESTED or a
      vanished task raise ``RuntimeError``; a per-task timeout raises ``TimeoutError`` (the task keeps running on the
      server; rerun to attach to it).
    * ``raise_on_failure=False``: each handle ends with ``h["state"]`` in ``COMPLETED | FAILED | CANCELLED |
      TIMEOUT_RUNNING | TIMEOUT_QUEUED`` (plus ``h["error"]``); the others keep being polled. The caller cancels
      still-active tasks (``gee_cancel_export``) and extracts those jobs interactively.

    Every poll logs the number of RUNNING tasks; the maximum observed concurrency is logged at the end and written to
    ``stats["max_running"]`` (with ``polls`` and ``seconds``). Every poll checks the run's time budget and raises
    ``LSTStop`` when it is exhausted (tasks keep running server side; a later session attaches to them by
    description). Completed handles get ``eecu_s`` (batch EECU-seconds, when the server reports it).
    """
    timeout_s = float(_S03_EXPORT_TIMEOUT_S if timeout_s is None else timeout_s)
    queue_s = float(_S03_EXPORT_QUEUE_S if queue_s is None else queue_s)
    delay = float(_S03_EXPORT_POLL_S if poll_s is None else poll_s)
    t0 = time.time()
    pending = [h for h in handles if h.get("state") not in _S03_EXPORT_TERMINAL]
    for h in pending:
        h.setdefault("running_since", None)
        h.setdefault("error", None)
    unknown_since: dict = {}
    max_running, polls = 0, 0
    _exhausted = globals().get("budget_exhausted")
    _check = globals().get("check_budget")

    def _fail(h: dict, state: str, message: str, exc_type=RuntimeError) -> None:
        if raise_on_failure:
            raise exc_type(message)
        h["state"], h["error"] = state, message
        log(f"export {h['description']} ended {state}: {message[:300]}", "WARNING")

    while pending:
        if _exhausted is not None and _exhausted():
            if _check is not None:
                _check(f"waiting for Earth Engine exports ({len(pending)} pending)")
        still, n_running = [], 0
        now = time.time()
        for h in pending:
            status = _s03_task_status(h)
            state = str(status.get("state", "UNKNOWN"))
            h["state"] = state
            if state == "COMPLETED":
                h["eecu_s"] = status.get("batch_eecu_usage_seconds")
                if _s03_get_asset(h["asset_id"]) is None:
                    _fail(h, "FAILED", f"export {h['description']} reports COMPLETED but asset {h['asset_id']} "
                                       "does not exist")
                    continue
                log(f"export {h['description']} COMPLETED in {time.time() - h['started']:.0f}s"
                    + (f" ({float(h['eecu_s']) / 3600:.2f} EECU-h)" if h["eecu_s"] else ""))
                continue
            if state == "FAILED":
                message = str(status.get("error_message") or "no error message")
                _fail(h, "FAILED", f"Earth Engine export {h['description']} FAILED: {message[:400]} | fix: "
                                   f"{_s03_failure_hint(message)}")
                continue
            if state in ("CANCELLED", "CANCEL_REQUESTED"):
                _fail(h, "CANCELLED", f"Earth Engine export {h['description']} was {state} (by a user or the "
                                      "server); rerun the section to start it again")
                continue
            if state in ("UNKNOWN", "UNSUBMITTED"):
                first = unknown_since.setdefault(h["description"], now)
                if now - first > 600:
                    _fail(h, "FAILED", f"Earth Engine export {h['description']} has state {state} for > 10 min "
                                       "(task not found)")
                    continue
            if state == "RUNNING":
                n_running += 1
                if h.get("running_since") is None:
                    h["running_since"] = now
            if h.get("running_since") is not None and now - h["running_since"] > timeout_s:
                _fail(h, "TIMEOUT_RUNNING",
                      f"Earth Engine export {h['description']} still running after "
                      f"{(now - h['running_since']) / 60:.0f} min (limit LST_GEE_EXPORT_TIMEOUT_S="
                      f"{timeout_s:.0f} s); the task keeps running on the server - rerun to attach to it",
                      TimeoutError)
                continue
            if h.get("running_since") is None and now - t0 > queue_s:
                _fail(h, "TIMEOUT_QUEUED",
                      f"Earth Engine export {h['description']} still {state} (not started) after "
                      f"{(now - t0) / 60:.0f} min (limit LST_GEE_EXPORT_QUEUE_S={queue_s:.0f} s)", TimeoutError)
                continue
            still.append(h)
        polls += 1
        max_running = max(max_running, n_running)
        pending = still
        if not pending:
            break
        elapsed = time.time() - t0
        log(f"export poll {polls}: {n_running} RUNNING, {len(pending)} not finished ("
            + ", ".join(f"{h['description'][-24:]}={h['state']}" for h in pending)
            + f"), {elapsed / 60:.1f} min elapsed")
        time.sleep(max(0.01, delay))
        delay = min(_S03_EXPORT_POLL_MAX_S, delay * 1.5)
    seconds = time.time() - t0
    if handles:
        log(f"Earth Engine exports: {sum(h.get('state') == 'COMPLETED' for h in handles)}/{len(handles)} COMPLETED "
            f"in {seconds / 60:.1f} min; maximum observed concurrency {max_running} RUNNING task(s)")
    if stats is not None:
        stats.update({"max_running": int(max_running), "polls": int(polls), "seconds": round(seconds, 1),
                      "states": {h["description"]: h.get("state") for h in handles}})
    return list(handles)


def gee_cancel_export(handle: dict) -> bool:
    """Cancel a still READY/RUNNING export task of ``handle`` (guarded, logged); True when a cancel was sent."""
    task_id = handle.get("task_id")
    if not task_id or handle.get("state") not in ("TIMEOUT_RUNNING", "TIMEOUT_QUEUED", "READY", "RUNNING"):
        return False
    cancel = getattr(getattr(ee, "data", None), "cancelTask", None)
    if not callable(cancel):
        log(f"cannot cancel export {handle.get('description')} (this earthengine-api has no ee.data.cancelTask); it "
            "keeps running on the server", "WARNING")
        return False
    try:
        _s03_call(lambda: cancel(task_id), f"cancelTask {task_id}", tries=3)
    except Exception as exc:  # noqa: BLE001 - a failed cancel only costs EECU
        log(f"could not cancel export {handle.get('description')} ({task_id}): {type(exc).__name__}: "
            f"{str(exc)[:160]}", "WARNING")
        return False
    log(f"cancelled Earth Engine export {handle.get('description')} ({task_id}, {handle.get('state')}); the job is "
        "extracted interactively instead", "WARNING")
    return True


def gee_fetch_asset(asset_id: str, grid: GridSpec, bands: Sequence[str], name: str,
                    dtype=np.float32, stats: Optional[dict] = None) -> np.ndarray:
    """Read a finished asset on ``grid`` with ``computePixels`` (large tiles, no server-side computation).

    The asset's ``updateTime`` is part of the tile-cache key, so tiles of an older asset with the same id are not
    reused.
    """
    info = _s03_get_asset(asset_id)
    if info is None:
        raise RuntimeError(f"asset {asset_id} does not exist")
    return gee_fetch_grid(ee.Image(asset_id), grid, bands, name, dtype=dtype, heavy=False,
                          extra={"asset": asset_id, "updated": info.get("updateTime")}, stats=stats)

# %% [markdown]
# ## 3.2 Server-side Landsat recipe
# Per-sensor preparation (masks, scaling, Roy harmonisation), the filters for season, window and path/row,
# per-date path mosaics, the combined median+count reduction and the aggregation to the fine grid. Everything here
# only *builds* Earth Engine expressions. Nothing is computed until a `getInfo`, `computePixels` or export.

# %%
def _s03_season_ranges(years: Sequence[int], season: Sequence[str], start: Optional[str] = None,
                       end: Optional[str] = None) -> list:
    """``[(start, end_exclusive), ...]`` ISO dates of the [MM-DD start, MM-DD end] (inclusive) season of each year,
    clipped to an optional ``[start, end)`` period (e.g. a sensor's operating period); empty ranges are dropped."""
    lo = pd.Timestamp(start) if start else None
    hi = pd.Timestamp(end) if end else None
    out = []
    for y in years:
        a = pd.Timestamp(f"{int(y)}-{season[0]}")
        b = pd.Timestamp(f"{int(y)}-{season[1]}") + pd.Timedelta(days=1)
        if lo is not None:
            a = max(a, lo)
        if hi is not None:
            b = min(b, hi)
        if a < b:
            out.append((a.strftime("%Y-%m-%d"), b.strftime("%Y-%m-%d")))
    return out


def _s03_season_collection(col, years: Sequence[int], season: Sequence[str], start: Optional[str] = None,
                           end: Optional[str] = None):
    """``col`` restricted to the season of each year (``_s03_season_ranges``): one ``filterDate`` per year, merged.

    Do not use an ``ee.Filter.Or`` of date ranges on large collections instead: on ERA5-Land hourly it made the
    first real pilot fail with "User memory limit exceeded" (reproduced locally; still failing after a ``filterDate``
    on the whole window), while the per-year ``filterDate`` merge of the same images took ~10 s. Returns an empty
    collection when no range is left.
    """
    ranges = _s03_season_ranges(years, season, start, end)
    if not ranges:
        return col.filterDate("1900-01-01", "1900-01-02")
    out = col.filterDate(*ranges[0])
    for a, b in ranges[1:]:
        out = out.merge(col.filterDate(a, b))
    return out


def _s03_season_filter(years: Sequence[int], season: Sequence[str]):
    """``ee.Filter`` passing images inside [MM-DD start, MM-DD end] (inclusive) of any of ``years``.

    For small, already filtered collections only; on a large collection use ``_s03_season_collection``.
    """
    filters = [ee.Filter.date(a, b) for a, b in _s03_season_ranges(years, season)]
    return filters[0] if len(filters) == 1 else ee.Filter.Or(*filters)


def _s03_pathrow_filter(pathrows: Sequence[str]):
    """``ee.Filter`` for an explicit list of WRS-2 path/rows ("146/040")."""
    parts = []
    for pr in pathrows:
        p, r = (int(v) for v in pr.split("/"))
        parts.append(ee.Filter.And(ee.Filter.eq("WRS_PATH", p), ee.Filter.eq("WRS_ROW", r)))
    return parts[0] if len(parts) == 1 else ee.Filter.Or(*parts)


def _s03_sensors_for(y0: int, y1: int) -> list:
    """Sensors whose catalogue period overlaps the window [y0-01-01, (y1+1)-01-01) (client-side pruning)."""
    lo, hi = pd.Timestamp(f"{y0}-01-01"), pd.Timestamp(f"{y1 + 1}-01-01")
    keep = []
    for key, s in _S03_SENSORS.items():
        start = pd.Timestamp(s["start"])
        end = pd.Timestamp(s["end"]) if s["end"] else pd.Timestamp.max
        if start < hi and lo < end:
            keep.append(key)
    return keep


def _s03_raw_collection(sensor: str, years: Sequence[int], season: Sequence[str], pathrows: Sequence[str],
                        roi_geom):
    """Filtered (unmapped) C2 L2 collection of one sensor: season of the window years (within the sensor's operating
    period), path/rows, ROI."""
    s = _S03_SENSORS[sensor]
    col = _s03_season_collection(ee.ImageCollection(s["asset"]), years, season, s["start"], s["end"] or "2100-01-01")
    return col.filterBounds(roi_geom).filter(_s03_pathrow_filter(pathrows))


def _s03_prep_fn(family: str):
    """Server-side per-scene preparation for a sensor family ("tm" = TM/ETM+, "oli" = OLI/OLI-2).

    Returns bands blue, green, red, nir, swir1, swir2 (OLI-equivalent reflectance 0-1) and lst (°C), masked by the
    SPEC §2.1 rules, plus ``s03_date`` (YYYY-MM-dd of ``system:time_start``) for the per-date path mosaics.
    """
    sr_bands, st_band = _S03_SR_BANDS[family], _S03_ST_BAND[family]

    def _prep(img):
        img = ee.Image(img)
        qa = img.select("QA_PIXEL")
        ok = (qa.bitwiseAnd(_S03_QA_CLEAR_BITS).eq(0)
              .And(img.select("QA_RADSAT").eq(0))
              .And(img.select("ST_QA").multiply(0.01).lte(_S03_ST_QA_MAX_K))
              .And(img.select("ST_CDIST").multiply(0.01).gte(_S03_ST_CDIST_MIN_KM)))
        sr = img.select(sr_bands, _S03_SR_NAMES).multiply(_S03_SR_SCALE).add(_S03_SR_OFFSET)
        in_range = sr.reduce(ee.Reducer.min()).gte(0).And(sr.reduce(ee.Reducer.max()).lte(1))
        if family == "tm":
            sr = sr.multiply(ee.Image.constant(_S03_ROY_SLOPES)).add(ee.Image.constant(_S03_ROY_INTERCEPTS))
        st_raw = img.select(st_band)
        lst = (st_raw.multiply(_S03_ST_SCALE).add(_S03_ST_OFFSET_K).subtract(273.15).rename("lst")
               .updateMask(st_raw.gt(0)))
        out = sr.rename(_S03_SR_NAMES).addBands(lst).updateMask(ok).updateMask(in_range).toFloat()
        out = ee.Image(out.copyProperties(img, ["system:time_start"]))
        return out.set("s03_date", ee.Date(img.get("system:time_start")).format("YYYY-MM-dd"))

    return _prep


def _s03_path_collection(year: int, path: str, season: Sequence[str], roi_geom, bands: Sequence[str]):
    """Prepared scenes of one WRS-2 path in the window/season, mosaicked per acquisition date (one pass = one obs)."""
    y0, y1 = CFG.WINDOWS[year]
    years = list(range(int(y0), int(y1) + 1))
    pathrows = [pr for pr in _S03_PATHROWS if pr.startswith(path + "/")]
    merged = None
    for sensor in _s03_sensors_for(y0, y1):
        col = (_s03_raw_collection(sensor, years, season, pathrows, roi_geom)
               .map(_s03_prep_fn(_S03_SENSORS[sensor]["family"])).select(list(bands)))
        merged = col if merged is None else merged.merge(col)
    if merged is None:
        return None
    dates = merged.aggregate_array("s03_date").distinct()

    def _per_date(d):
        return merged.filter(ee.Filter.eq("s03_date", d)).mosaic().set("s03_date", d)

    return ee.ImageCollection.fromImages(dates.map(_per_date))


def _s03_projection_30m():
    """30 m working projection on the native Landsat lattice of the grid CRS.

    USGS Collection-2 products in UTM have pixel corners at 15 m mod 30 m (the translations of their STAC
    ``proj:transform`` end in ...15 / ...85 m), so the composite grid uses translations of 15 m: the 30 m pixels
    then coincide with the scenes' own pixels and no half-pixel resampling happens before reduceResolution.
    """
    return ee.Projection(CFG.CRS, [_S03_COMPOSITE_SCALE_M, 0, 15, 0, -_S03_COMPOSITE_SCALE_M, 15])


def _s03_to_fine(image, fine: GridSpec):
    """Mask- and area-weighted mean of a 30 m image onto ``fine`` (exact grid transform)."""
    ratio = (fine.res / _S03_COMPOSITE_SCALE_M) ** 2
    max_pixels = int(min(65535, max(1024, math.ceil(ratio * 2.5))))
    return (image.setDefaultProjection(_s03_projection_30m())
            .reduceResolution(reducer=ee.Reducer.mean(), bestEffort=False, maxPixels=max_pixels)
            .reproject(crs=fine.crs, crsTransform=fine.transform_list()))


def _s03_valid_fraction(image, fine: GridSpec):
    """Fraction (0-1) of each fine pixel covered by valid (unmasked) 30 m pixels of a single-band image."""
    return _s03_to_fine(image.mask().gt(0).unmask(0, False).toFloat(), fine)


def _s03_masked_bands(names: Sequence[str]):
    """Fully masked float image with the given band names (stand-in for an empty composite)."""
    return ee.Image.constant([0.0] * len(names)).rename(list(names)).toFloat().updateMask(0)


def _s03_path_image(year: int, path: str, fine: GridSpec, roi_geom, has_main: bool, has_spring: bool):
    """Fine-grid bands ``<band>_<path>`` (``_S03_PATH_BANDS``) of one WRS-2 path for one frame.

    One combined median+count reduction over the per-date mosaics; indices and albedo from the same median;
    a red/NIR-only Feb-Mar median for the spring NDVI. Empty composites are replaced by fully masked bands (and
    a zero count), so the image always has the same bands. Missing data stays masked; it is never zero-filled.
    """
    proj = _s03_projection_30m()
    vmin = float(_S03_PIXEL_MIN_VALID_FRAC)
    if has_main:
        daily = _s03_path_collection(year, path, CFG.SEASON, roi_geom, _S03_SR_NAMES + ["lst"])
        red = daily.reduce(ee.Reducer.median().combine(reducer2=ee.Reducer.count(), sharedInputs=True))
        comp = red.setDefaultProjection(proj)
        med = comp.select([f"{b}_median" for b in _S03_SR_NAMES + ["lst"]], _S03_SR_NAMES + ["lst"])
        lst = med.select("lst")
        count = comp.select("lst_count").unmask(0, False).toFloat().rename("nobs")
        ndvi = med.normalizedDifference(["nir", "red"]).rename("ndvi")
        ndbi = med.normalizedDifference(["swir1", "nir"]).rename("ndbi")
        mndwi = med.normalizedDifference(["green", "swir1"]).rename("mndwi")
        albedo = med.expression(
            f"{_S03_LIANG['blue']} * b + {_S03_LIANG['red']} * r + {_S03_LIANG['nir']} * n + "
            f"{_S03_LIANG['swir1']} * s1 + {_S03_LIANG['swir2']} * s2 + ({_S03_LIANG['const']})",
            {"b": med.select("blue"), "r": med.select("red"), "n": med.select("nir"), "s1": med.select("swir1"),
             "s2": med.select("swir2")}).rename("albedo")
        vf_lst = _s03_valid_fraction(lst, fine)
        vf_sr = _s03_valid_fraction(ndvi, fine)
        lst_f = _s03_to_fine(lst, fine).updateMask(vf_lst.gte(vmin))
        spec_f = _s03_to_fine(ee.Image.cat([ndvi, ndbi, mndwi, albedo]), fine).updateMask(vf_sr.gte(vmin))
        nobs_f = _s03_to_fine(count, fine)
    else:
        lst_f = _s03_masked_bands(["lst"])
        spec_f = _s03_masked_bands(["ndvi", "ndbi", "mndwi", "albedo"])
        nobs_f = ee.Image.constant(0.0).rename("nobs").toFloat()
    if has_spring:
        spring = _s03_path_collection(year, path, CFG.SPRING_SEASON, roi_geom, ["red", "nir"]).median()
        spring = spring.setDefaultProjection(proj)
        ndvi_s = spring.normalizedDifference(["nir", "red"]).rename("ndvi_spring")
        spring_f = _s03_to_fine(ndvi_s, fine).updateMask(_s03_valid_fraction(ndvi_s, fine).gte(vmin))
    else:
        spring_f = _s03_masked_bands(["ndvi_spring"])
    stack = ee.Image.cat([lst_f, nobs_f, spec_f, spring_f]).select(_S03_PATH_BANDS)
    return stack.rename([f"{b}_{path}" for b in _S03_PATH_BANDS]).toFloat()


def _s03_frame_image(year: int, fine: GridSpec, roi_geom, clip_geom, availability: dict):
    """14-band fine-grid image of one frame (7 bands × paths 146/147), clipped to the buffered ROI.

    ``availability[path] = (has_main_scenes, has_spring_scenes)``.
    """
    parts = [_s03_path_image(year, p, fine, roi_geom, *availability[p]) for p in _S03_PATHS]
    return ee.Image.cat(parts).clip(clip_geom).toFloat()


def _s03_frame_bands() -> list:
    return [f"{b}_{p}" for p in _S03_PATHS for b in _S03_PATH_BANDS]


def _s03_roi_geometry(dilate_cells: int = 0):
    """ROI as an ``ee.Geometry`` in the grid CRS: union of the ROI cells (optionally dilated by whole cells).

    Built client-side from ``ROI_MASK``, so it is exactly the analysis-grid ROI, with a vertex count of a few
    thousand. Far cheaper per request than the detailed administrative polygons. Without shapely the grid
    rectangle is used, which is correct but computes more pixels.
    """
    mask = ROI_MASK
    if dilate_cells > 0:
        mask = ndimage.binary_dilation(mask, iterations=int(dilate_cells))
    if shapely is None:
        log("shapely unavailable: Earth Engine requests use the grid rectangle instead of the ROI polygon", "WARNING")
        return grid_ee_geom(GRID)
    from shapely.geometry import box as _box, mapping as _mapping
    from shapely.ops import unary_union as _union

    boxes = []
    res, x0, y0 = float(GRID.res), float(GRID.x0), float(GRID.y0)
    for r in range(mask.shape[0]):
        row = mask[r].astype(np.int8)
        edges = np.flatnonzero(np.diff(np.concatenate([[0], row, [0]])))
        for c0, c1 in zip(edges[::2], edges[1::2]):
            boxes.append(_box(x0 + c0 * res, y0 - (r + 1) * res, x0 + c1 * res, y0 - r * res))
    if not boxes:
        raise RuntimeError("ROI_MASK is empty; cannot build the Earth Engine ROI geometry")
    geom = _union(boxes).buffer(0)
    gj = _mapping(geom)
    gj = {"type": gj["type"], "coordinates": json.loads(json.dumps(gj["coordinates"]))}
    return ee.Geometry(gj, CFG.CRS, False)


# Public names for sections 04-05 (same behaviour as the private helpers above).
gee_call = _s03_call                    # gee_call(fn, what, tries=None): small EE call with transient backoff
gee_getinfo = _s03_getinfo              # gee_getinfo(obj, what): obj.getInfo() with transient backoff
gee_season_filter = _s03_season_filter  # gee_season_filter(years, ("04-01", "06-30")) -> ee.Filter (inclusive end)
gee_season_collection = _s03_season_collection  # (col, years, season, start=None, end=None) -> merged per-year filterDate
gee_roi_geometry = _s03_roi_geometry    # gee_roi_geometry(dilate_cells=0) -> ROI cell-union ee.Geometry (grid CRS)

# %% [markdown]
# ## 3.3 Scene metadata, overpass time and ERA5-Land heating rate
# One `getInfo` per frame returns everything client-side needs: per sensor, the scene lists (aggregate_array of path,
# row, `system:time_start`, SCENE_CENTER_TIME, CLOUD_COVER_LAND, CLOUD_COVER) for the Apr–Jun and Feb–Mar
# composites, plus the ERA5-Land mean skin temperature at 04 and 06 UTC over the ROI. `aggregate_array` skips
# null values, so a list shorter than the collection would mis-align scenes. When that happens the scenes are
# re-read as one feature per image, which keeps the nulls.

# %%
_S03_SCENE_PROPS = {"path": "WRS_PATH", "row": "WRS_ROW", "time": "system:time_start", "sct": "SCENE_CENTER_TIME",
                    "ccl": "CLOUD_COVER_LAND", "cc": "CLOUD_COVER"}
_S03_SCT_RE = re.compile(r"(\d{1,2}):(\d{2}):(\d{2}(?:\.\d+)?)")


def _s03_parse_utc_hours(sct: Any, time_ms: Any) -> Optional[float]:
    """UTC decimal hours of a scene from SCENE_CENTER_TIME ("05:18:31.447Z"), else from ``system:time_start``."""
    if isinstance(sct, str):
        m = _S03_SCT_RE.search(sct)
        if m:
            h, mi, s = int(m.group(1)), int(m.group(2)), float(m.group(3))
            if 0 <= h < 24 and 0 <= mi < 60 and 0 <= s < 61:
                return h + mi / 60.0 + s / 3600.0
    if time_ms is not None:
        try:
            t = pd.Timestamp(int(time_ms), unit="ms", tz="UTC")
            return t.hour + t.minute / 60.0 + (t.second + t.microsecond / 1e6) / 3600.0
        except (ValueError, OverflowError, TypeError):
            return None
    return None


def _s03_scene_records(sensor: str, block: dict) -> Optional[list]:
    """Scene dicts from one sensor's aggregate_array block, or None if the lists are mis-aligned."""
    n = int(block.get("n") or 0)
    lists = {k: list(block.get(k) or []) for k in _S03_SCENE_PROPS}
    if n == 0:
        return []
    if any(len(lists[k]) != n for k in lists):
        return None
    return [{"sensor": sensor, **{k: lists[k][i] for k in lists}} for i in range(n)]


def _s03_fallback_records(sensor: str, col) -> list:
    """Scene dicts via one Feature per image (keeps null properties aligned)."""
    def _feat(img):
        return ee.Feature(None, {k: ee.Image(img).get(v) for k, v in _S03_SCENE_PROPS.items()})

    info = _s03_getinfo(ee.FeatureCollection(col.map(_feat)), f"scene features {sensor}")
    return [{"sensor": sensor, **{k: (f.get("properties") or {}).get(k) for k in _S03_SCENE_PROPS}}
            for f in (info or {}).get("features", [])]


def _s03_scene_table(records: list) -> pd.DataFrame:
    """Normalise scene records: path/row strings, UTC date, IST hour, land cloud cover and the clear flag."""
    cols = ["sensor", "pathrow", "path", "date", "utc_h", "ist_h", "cloud_land", "clear"]
    rows = []
    for rec in records:
        try:
            path, row = int(rec["path"]), int(rec["row"])
        except (TypeError, ValueError, KeyError):
            continue
        utc_h = _s03_parse_utc_hours(rec.get("sct"), rec.get("time"))
        date = (pd.Timestamp(int(rec["time"]), unit="ms", tz="UTC").strftime("%Y-%m-%d")
                if rec.get("time") is not None else None)
        cloud = rec.get("ccl")
        if cloud is None or not np.isfinite(float(cloud)) or float(cloud) < 0:
            cloud = rec.get("cc")
        cloud = None if cloud is None or not np.isfinite(float(cloud)) or float(cloud) < 0 else float(cloud)
        rows.append({"sensor": rec["sensor"], "pathrow": f"{path}/{row:03d}", "path": str(path), "date": date,
                     "utc_h": utc_h, "ist_h": None if utc_h is None else (utc_h + _S03_IST_OFFSET_H) % 24.0,
                     "cloud_land": cloud, "clear": cloud is None or cloud <= _S03_CLEAR_SCENE_MAX_CLOUD})
    return pd.DataFrame(rows, columns=cols)


def _s03_sensor_labels(table: pd.DataFrame) -> list:
    """Sensor labels in canonical order; Landsat 7 marked "(SLC-off)" when any of its scenes postdates 2003-05-31."""
    labels = []
    for key in _S03_SENSORS:
        sub = table[table["sensor"] == key]
        if sub.empty:
            continue
        label = _S03_SENSORS[key]["label"]
        if key == "L7" and (sub["date"].dropna() >= _S03_L7_SLC_OFF_DATE).any():
            label += " (SLC-off)"
        labels.append(label)
    return labels


def _s03_summarise_scenes(table: pd.DataFrame) -> dict:
    """FRAME_META day scene fields from a scene table (clear scenes; all-scene counts for the QA record)."""
    clear = table[table["clear"]]
    per_pr = {pr: int((clear["pathrow"] == pr).sum()) for pr in _S03_PATHROWS}
    per_pr_all = {pr: int((table["pathrow"] == pr).sum()) for pr in _S03_PATHROWS}
    ist = clear["ist_h"].dropna()
    if ist.empty:
        ist = table["ist_h"].dropna()
    return {"sensors": _s03_sensor_labels(table), "scenes": int(sum(per_pr.values())), "scenes_per_pathrow": per_pr,
            "scenes_all": int(sum(per_pr_all.values())), "scenes_per_pathrow_all": per_pr_all,
            "mean_overpass_ist_h": float(ist.mean()) if not ist.empty else float("nan"),
            "overpass_ist_range": [float(ist.min()), float(ist.max())] if not ist.empty else None,
            "by_sensor": {k: int((table["sensor"] == k).sum()) for k in _S03_SENSORS if (table["sensor"] == k).any()}}


def _s03_heating_rate(era5: Optional[dict]) -> float:
    """``(T06 − T04) / 2`` in K h⁻¹ from the ERA5-Land ROI means (raises if ERA5 returned nothing)."""
    if not era5 or era5.get("t04") is None or era5.get("t06") is None:
        raise RuntimeError(f"ERA5-Land hourly skin temperature returned no ROI mean ({era5}); cannot derive the "
                           "overpass heating rate")
    t04, t06 = float(era5["t04"]), float(era5["t06"])
    if not (200.0 < t04 < 360.0 and 200.0 < t06 < 360.0):
        raise RuntimeError(f"ERA5-Land skin temperatures {t04:.2f} / {t06:.2f} K are implausible")
    return (t06 - t04) / float(_S03_HEATING_UTC_HOURS[1] - _S03_HEATING_UTC_HOURS[0])


def _s03_era5_stats(years: Sequence[int], roi_geom):
    """Server-side ROI means of ERA5-Land skin temperature at 04 and 06 UTC over the Apr-Jun season of ``years``.

    The hour filter is applied to each season-year ``filterDate`` part before merging (as in
    ``_s03_season_collection``): the same images selected through an ``ee.Filter.Or`` of the seasons exceeded Earth
    Engine's per-request memory.
    """
    base = ee.ImageCollection(_S03_ERA5_HOURLY).select("skin_temperature")
    h0, h1 = _S03_HEATING_UTC_HOURS

    def _hour_mean(hour: int, name: str):
        ranges = _s03_season_ranges(years, CFG.SEASON)
        parts = [base.filterDate(a, b).filter(ee.Filter.calendarRange(hour, hour, "hour")) for a, b in ranges]
        col = parts[0]
        for p in parts[1:]:
            col = col.merge(p)
        return col.mean().rename(name)

    t04 = _hour_mean(h0, "t04")
    t06 = _hour_mean(h1, "t06")
    return t04.addBands(t06).reduceRegion(reducer=ee.Reducer.mean(), geometry=roi_geom, scale=_S03_ERA5_SCALE_M,
                                          maxPixels=int(1e9), bestEffort=True)


def _s03_frame_metadata(year: int, roi_geom) -> dict:
    """Scene tables (Apr-Jun and Feb-Mar) and the ERA5-Land heating rate of one frame (one getInfo + fallbacks)."""
    y0, y1 = CFG.WINDOWS[year]
    years = list(range(int(y0), int(y1) + 1))
    sensors = _s03_sensors_for(y0, y1)
    cols = {season: {s: _s03_raw_collection(s, years, CFG.SEASON if season == "main" else CFG.SPRING_SEASON,
                                            _S03_PATHROWS, roi_geom) for s in sensors}
            for season in ("main", "spring")}
    request = {season: {s: ee.Dictionary({"n": col.size(), **{k: col.aggregate_array(v)
                                                               for k, v in _S03_SCENE_PROPS.items()}})
                        for s, col in by_sensor.items()} for season, by_sensor in cols.items()}
    request["era5"] = _s03_era5_stats(years, roi_geom)
    info = _s03_getinfo(ee.Dictionary(request), f"03 metadata {year}") or {}
    tables = {}
    for season in ("main", "spring"):
        records = []
        for s in sensors:
            block = (info.get(season) or {}).get(s) or {}
            recs = _s03_scene_records(s, block)
            if recs is None:
                log(f"03: {year} {season} {s}: aggregate_array lists are mis-aligned (null properties); re-reading "
                    "one feature per scene", "WARNING")
                recs = _s03_fallback_records(s, cols[season][s])
            records += recs
        tables[season] = _s03_scene_table(records)
    return {"main": tables["main"], "spring": tables["spring"], "era5": info.get("era5"), "sensors_queried": sensors}

# %% [markdown]
# ## 3.4 Path-offset harmonisation and mosaic (client side)
# The per-path fine composites are combined in NumPy, so the offset is computed exactly as SPEC §2.1 defines it. The
# overlap is compared at ≥ 250 m: at finer grids both paths are first block-averaged. A path without scenes, or an
# overlap smaller than 200 pixels, gives δ = 0. That case is reported and recorded, never hidden. Outside the ROI
# every band is NaN. Inside it, the clear-observation count is finite, and 0 where no scene was clear.

# %%
def _s03_coarsen_pair(a: np.ndarray, b: np.ndarray, k: int):
    """Block means (factor ``k``) of two fine rasters, trimming any remainder rows/cols."""
    if k <= 1:
        return a, b
    h, w = (a.shape[0] // k) * k, (a.shape[1] // k) * k
    return block_mean(a[:h, :w], k), block_mean(b[:h, :w], k)


def _s03_harmonise_paths(paths: dict, roi_fine: np.ndarray, res_m: int) -> tuple:
    """Harmonise and mosaic per-path fine composites.

    ``paths[p][band]`` (p in "146", "147"; band in ``_S03_PATH_BANDS``) are float arrays with NaN = nodata.
    Returns ``(fine, info)``: ``fine`` maps the RAW_OBS keys to float32 arrays; ``info`` has ``delta`` (median
    146 − 147 over the overlap, °C), ``path_offsets`` ``{"146": +δ/2, "147": −δ/2}`` (value removed from each
    path), ``overlap_px`` and ``method``.
    """
    lst = {p: np.asarray(paths[p]["lst"], dtype=np.float32) for p in _S03_PATHS}
    k = max(1, int(math.ceil(_S03_OFFSET_MIN_RES_M / float(res_m))))
    a, b = _s03_coarsen_pair(lst["146"], lst["147"], k)
    both = np.isfinite(a) & np.isfinite(b)
    n_overlap = int(both.sum())
    has = {p: bool(np.isfinite(lst[p]).any()) for p in _S03_PATHS}
    if n_overlap >= _S03_MIN_OVERLAP_PX:
        delta, method = float(np.median((a - b)[both])), "overlap-median"
    else:
        delta = 0.0
        method = "single-path" if not all(has.values()) else "insufficient-overlap"
    harmonised = {"146": lst["146"] - 0.5 * delta, "147": lst["147"] + 0.5 * delta}

    def _mean_where_both(x, y):
        fx, fy = np.isfinite(x), np.isfinite(y)
        out = np.where(fx & fy, 0.5 * (x + y), np.where(fx, x, y))
        return out.astype(np.float32)

    fine = {"lst_day_f": _mean_where_both(harmonised["146"], harmonised["147"])}
    nobs = np.zeros(roi_fine.shape, dtype=np.float32)
    for p in _S03_PATHS:
        n = np.asarray(paths[p]["nobs"], dtype=np.float32)
        nobs += np.where(np.isfinite(n) & (n > 0), n, 0.0).astype(np.float32)
    fine["lst_day_nobs_f"] = nobs
    for band in ("ndvi", "ndbi", "mndwi", "albedo", "ndvi_spring"):
        fine[_S03_BAND_TO_KEY[band]] = _mean_where_both(np.asarray(paths["146"][band], dtype=np.float32),
                                                        np.asarray(paths["147"][band], dtype=np.float32))
    # Physical plausibility (guards against a wrong scale factor or fill values leaking through).
    bounds = {"lst_day_f": (-20.0, 85.0), "ndvi_f": (-1.0, 1.0), "ndbi_f": (-1.0, 1.0), "mndwi_f": (-1.0, 1.0),
              "albedo_f": (-0.05, 1.05), "ndvi_spring_f": (-1.0, 1.0)}
    rejected = {}
    for key, (lo, hi) in bounds.items():
        bad = np.isfinite(fine[key]) & ((fine[key] < lo) | (fine[key] > hi))
        if bad.any():
            rejected[key] = int(bad.sum())
            fine[key][bad] = np.nan
    for key in fine:
        fine[key][~roi_fine] = np.nan
    info = {"delta": round(delta, 4), "path_offsets": {"146": round(0.5 * delta, 4), "147": round(-0.5 * delta, 4)},
            "overlap_px": n_overlap, "overlap_res_m": int(res_m * k), "method": method, "paths_with_data": has,
            "rejected_implausible": rejected}
    return fine, info

# %% [markdown]
# ## 3.5 Run: metadata, extraction (interactive or asset), harmonisation, provenance
# Each finished frame is stored in the stage cache (`03_landsat_<year>`). The key holds the run identity, the
# window, the seasons, the fine grid, the ROI and the recipe version, so a resumed run (or one with an imported
# cache) skips the frame without contacting Earth Engine. In asset mode, all missing frames are exported in
# parallel first and fetched afterwards.

# %%
def _s03_stage_key(year: int) -> dict:
    roi_digest = hashlib.sha1(np.packbits(ROI_MASK).tobytes()).hexdigest()[:16]
    return CFG.key(year=int(year), window=list(CFG.WINDOWS[year]), season=list(CFG.SEASON),
                   spring=list(CFG.SPRING_SEASON), fine_grid=asdict(GRID_FINE), roi=roi_digest,
                   recipe=_S03_RECIPE_VERSION)


def _s03_availability(main: pd.DataFrame, spring: pd.DataFrame) -> dict:
    """{path: (has Apr-Jun scenes, has Feb-Mar scenes)} from the scene tables (all scenes, clear or not)."""
    return {p: (bool((main["path"] == p).any()), bool((spring["path"] == p).any())) for p in _S03_PATHS}


def _s03_split_paths(stack: np.ndarray) -> dict:
    """(14, Hf, Wf) frame stack -> {path: {band: array}} in ``_s03_frame_bands()`` order."""
    out, i = {}, 0
    for p in _S03_PATHS:
        out[p] = {}
        for b in _S03_PATH_BANDS:
            out[p][b] = stack[i]
            i += 1
    return out


def _s03_check_frame_coverage(year: int, coverage: float, summary: dict, min_coverage: float) -> None:
    """D9: a day frame below ``min_coverage`` of the ROI fine pixels is an acquisition fault -> RuntimeError.

    Raised before the frame is stage-cached (its Earth Engine tiles stay cached, so a rerun after a fix is cheap).
    """
    if coverage >= float(min_coverage):
        return
    y0, y1 = CFG.WINDOWS[year]
    per_pr = ", ".join(f"{pr}: {summary['scenes_per_pathrow'].get(pr, 0)} clear / "
                       f"{summary.get('scenes_per_pathrow_all', {}).get(pr, 0)} all" for pr in _S03_PATHROWS)
    raise RuntimeError(
        f"03: day frame {year} ({y0}-{y1}) has Landsat LST on only {100 * coverage:.1f} % of the ROI fine pixels "
        f"(minimum {100 * float(min_coverage):.0f} %, LST_DAY_MIN_FRAME_COVERAGE). Scenes per path/row: {per_pr}; "
        f"sensors: {', '.join(summary.get('sensors') or []) or 'none'}. Hint: check the QA_PIXEL / ST-band handling "
        "for this sensor (ST_QA, ST_CDIST and the ST DN > 0 mask remove pixels where the ST product is missing); the "
        "Earth Engine tiles are cached, so a rerun is cheap; lower LST_DAY_MIN_FRAME_COVERAGE only if the gap is "
        "real (day frames are always observed or observed-sparse, never modelled).")


def _s03_finalise_frame(year: int, meta: dict, stack: np.ndarray, extraction: str,
                        cost: Optional[dict] = None) -> dict:
    """Harmonise a fetched frame stack and assemble the stage-cache record (fine arrays, day meta, QA, notes).

    Raises RuntimeError when the frame's ROI coverage is below ``_S03_DAY_MIN_FRAME_COVERAGE`` (D9).
    """
    fine, harm = _s03_harmonise_paths(_s03_split_paths(stack), ROI_MASK_FINE, GRID_FINE.res)
    summary = _s03_summarise_scenes(meta["main"])
    spring_summary = _s03_summarise_scenes(meta["spring"])
    roi_f = ROI_MASK_FINE
    coverage = float(np.isfinite(fine["lst_day_f"][roi_f]).mean()) if roi_f.any() else 0.0
    _s03_check_frame_coverage(year, coverage, summary, _S03_DAY_MIN_FRAME_COVERAGE)
    heating = _s03_heating_rate(meta["era5"])
    day = {"sensors": summary["sensors"], "scenes": summary["scenes"],
           "scenes_per_pathrow": dict(summary["scenes_per_pathrow"]),
           "mean_overpass_ist_h": round(float(summary["mean_overpass_ist_h"]), 4),
           "coverage": round(coverage, 4), "heating_rate_k_per_h": round(float(heating), 4),
           "path_offsets": dict(harm["path_offsets"])}
    notes, warnings_ = [], []
    window = CFG.WINDOWS[year]
    missing = [pr for pr, n in summary["scenes_per_pathrow_all"].items() if n == 0]
    if missing:
        warnings_.append(f"day frame {year} ({window[0]}-{window[1]}): NO Landsat scenes on WRS-2 path/row(s) "
                         f"{', '.join(missing)} - their footprint is NaN unless another path covers it")
    sparse_prs = {pr: n for pr, n in summary["scenes_per_pathrow"].items() if n < _S03_SPARSE_SCENES}
    if sparse_prs:
        notes.append(f"Day frame {year} ({window[0]}-{window[1]}): fewer than {_S03_SPARSE_SCENES} clear Landsat "
                     f"scenes on path/row(s) " + ", ".join(f"{pr} ({n})" for pr, n in sparse_prs.items())
                     + " - tiered observed-sparse.")
    if harm["method"] != "overlap-median":
        warnings_.append(f"day frame {year}: path offset not estimated ({harm['method']}, {harm['overlap_px']} "
                         "overlap pixels) - paths mosaicked without offset correction")
    elif abs(harm["delta"]) > 2.0:
        warnings_.append(f"day frame {year}: large path 146-147 offset {harm['delta']:+.2f} °C (different dates or "
                         "weather on the two paths) - removed symmetrically")
    if coverage < 0.95:
        warnings_.append(f"day frame {year}: Landsat LST covers only {100 * coverage:.1f} % of the ROI fine pixels")
    if not 0.5 <= heating <= 6.0:
        warnings_.append(f"day frame {year}: ERA5-Land heating rate {heating:.2f} K/h is outside the expected "
                         "0.5-6 K/h range")
    ist = day["mean_overpass_ist_h"]
    if not np.isfinite(ist) or not 8.5 <= ist <= 11.5:
        warnings_.append(f"day frame {year}: mean overpass {ist} IST h is outside 08:30-11:30")
    if harm["rejected_implausible"]:
        warnings_.append(f"day frame {year}: implausible values set to NaN {harm['rejected_implausible']}")
    sensors_txt = " + ".join(summary["sensors"]) or "none"
    assets = ", ".join(_S03_SENSORS[s]["asset"] for s in meta["sensors_queried"])
    y0, y1 = window
    base = (f"Landsat C2 L2 T1 ({assets}; {sensors_txt}; Landsat 7 only < {_S03_L7_END}), WRS-2 "
            f"{'/'.join(_S03_PATHROWS)}")
    mask_txt = (f"QA_PIXEL bits0-4 clear, QA_RADSAT=0, ST_QA<={_S03_ST_QA_MAX_K:g} K, "
                f"ST_CDIST>={_S03_ST_CDIST_MIN_KM:g} km, SR in [0,1]")
    agg_txt = (f"per-date path mosaics, per-path median, 30 m -> {GRID_FINE.res} m mean (>= "
               f"{100 * _S03_PIXEL_MIN_VALID_FRAC:.0f} % valid area), mosaic of paths 146/147; extraction {extraction}")
    season_txt = f"{CFG.SEASON[0]}..{CFG.SEASON[1]} of {y0}-{y1}"
    sources = {
        "lst_day_f": (f"{base}: ST {_S03_ST_SCALE}*DN+{_S03_ST_OFFSET_K:g} K -> °C, {season_txt}, {mask_txt}, "
                      f"{agg_txt}; path offsets 146 {harm['path_offsets']['146']:+.3f} / 147 "
                      f"{harm['path_offsets']['147']:+.3f} °C removed ({harm['method']}); {summary['scenes']} clear "
                      f"scenes (land cloud <= {_S03_CLEAR_SCENE_MAX_CLOUD:g} %), mean overpass {ist:.2f} h IST; "
                      "not overpass-corrected"),
        "lst_day_nobs_f": (f"{base}: number of clear acquisition dates per pixel (per-path count of per-date mosaics, "
                           f"summed over paths), {season_txt}, {mask_txt}, mean to {GRID_FINE.res} m"),
    }
    spec = (f"{base}: SR*{_S03_SR_SCALE:g}{_S03_SR_OFFSET:+g}, TM/ETM+ -> OLI Roy et al. 2016 OLS, {season_txt}, "
            f"{mask_txt}, from the same per-path median composite as lst_day_f, {agg_txt}")
    sources["ndvi_f"] = f"{spec}; NDVI (nir-red)/(nir+red)"
    sources["ndbi_f"] = f"{spec}; NDBI (swir1-nir)/(swir1+nir)"
    sources["mndwi_f"] = f"{spec}; MNDWI (green-swir1)/(green+swir1)"
    sources["albedo_f"] = (f"{spec}; Liang 2001 albedo 0.356 blue + 0.130 red + 0.373 nir + 0.085 swir1 + "
                           "0.072 swir2 - 0.0018")
    sources["ndvi_spring_f"] = (f"{base}: NDVI of the red/NIR median composite, {CFG.SPRING_SEASON[0]}.."
                                f"{CFG.SPRING_SEASON[1]} of {y0}-{y1} ({spring_summary['scenes_all']} scenes), "
                                f"{mask_txt}, {agg_txt}")
    sources["heating_rate"] = (f"{_S03_ERA5_HOURLY} skin_temperature, {season_txt}, ROI mean at "
                               f"{_S03_HEATING_UTC_HOURS[0]:02d} and {_S03_HEATING_UTC_HOURS[1]:02d} UTC "
                               f"(09:30 / 11:30 IST): (T06 - T04)/2 = {heating:.3f} K/h")
    nobs_roi = fine["lst_day_nobs_f"][roi_f]
    cost = dict(cost or {})
    cost.update({"coverage": round(coverage, 4), "scenes": int(summary["scenes"]),
                 "scenes_all": int(summary["scenes_all"]),
                 "median_nobs": round(float(np.median(nobs_roi)), 2) if nobs_roi.size else None})
    qa = {"summary": summary, "spring": spring_summary, "harmonisation": harm, "era5_k": meta["era5"],
          "scene_table": meta["main"], "extraction": extraction, "cost": cost}
    return {"fine": fine, "day": day, "sources": sources, "notes": notes, "warnings": warnings_, "qa": qa}


def _s03_asset_id(year: int, digest: str) -> str:
    root = (CFG.GEE_ASSET_ROOT or "").rstrip("/")
    if not root:
        raise RuntimeError("GEE_EXPORT=asset needs CFG.GEE_ASSET_ROOT (LST_GEE_ASSET_ROOT or GEE_PROJECT)")
    return f"{root}/landsat_day_{int(year)}_{int(GRID_FINE.res)}m_{digest[:12]}"


def _s03_export_frames(prepared: dict) -> dict:
    """Asset mode: start every frame export, wait with per-task limits, return {year: handle} (terminal states).

    A frame whose export does not end COMPLETED has its task cancelled when still active and is extracted
    interactively by the caller. The maximum observed task concurrency goes to ``_S03_QA['export_concurrency']``.
    """
    handles = {}
    for year, item in prepared.items():
        digest = _gee_expression_digest(item["image"])
        asset_id = _s03_asset_id(year, digest)
        try:
            handles[year] = gee_export_to_asset(item["image"], asset_id, GRID_FINE,
                                                description=f"ncr_lst_v2_landsat_day_{year}_{digest[:10]}",
                                                wait=False)
        except Exception as exc:  # noqa: BLE001 - this frame is extracted interactively instead
            log(f"03: asset export of frame {year} could not start ({type(exc).__name__}: {str(exc)[:200]}); the "
                "frame is extracted interactively", "WARNING")
            handles[year] = {"asset_id": asset_id, "description": f"landsat_day_{year}", "task_id": None,
                             "state": "FAILED", "error": f"export not started: {type(exc).__name__}: {exc}",
                             "reused": False, "eecu_s": None, "started": time.time()}
    stats: dict = {}
    with timer("03 asset exports"):
        gee_wait_for_exports(list(handles.values()), raise_on_failure=False, stats=stats)
    _S03_QA["export_concurrency"] = int(stats.get("max_running", 0))
    for year, h in handles.items():
        cancelled = h.get("state") != "COMPLETED" and gee_cancel_export(h)
        _S03_QA.setdefault(year, {})["export"] = {
            **{k: h.get(k) for k in ("asset_id", "task_id", "state", "error", "reused", "eecu_s", "description")},
            "cancelled": bool(cancelled), "fallback_interactive": h.get("state") != "COMPLETED"}
    return handles


def _s03_run() -> dict:
    """Acquire every observed frame; returns {year: stage record}."""
    roi_geom = _s03_roi_geometry(0)
    clip_geom = _s03_roi_geometry(1)
    bands = _s03_frame_bands()
    records, todo = {}, []
    caches = {y: stage_cache(f"03_landsat_{y}", _s03_stage_key(y)) for y in CFG.FRAMES_OBS}
    for year in CFG.FRAMES_OBS:
        sc = caches[year]
        if sc.hit:
            try:
                records[year] = sc.load()
                _S03_QA.setdefault(year, {})["from_stage_cache"] = True
                continue
            except StageCacheError as exc:
                log(f"{exc}; re-acquiring frame {year}", "WARNING")
        todo.append(year)
    prepared = {}
    for year in todo:
        with timer(f"03 metadata {year}"):
            meta = _s03_frame_metadata(year, roi_geom)
        if meta["main"].empty:
            y0, y1 = CFG.WINDOWS[year]
            raise RuntimeError(f"03: no Landsat C2 L2 T1 scenes found for frame {year} (Apr-Jun {y0}-{y1}, path/rows "
                               f"{_S03_PATHROWS}); check the collections/filters or the Earth Engine catalogue")
        avail = _s03_availability(meta["main"], meta["spring"])
        for p, (has_main, has_spring) in avail.items():
            if not has_main:
                log(f"03: frame {year}: WRS-2 path {p} has NO Apr-Jun scenes - its bands stay masked", "WARNING")
            if not has_spring:
                log(f"03: frame {year}: WRS-2 path {p} has NO Feb-Mar scenes - ndvi_spring stays masked there",
                    "WARNING")
        image = _s03_frame_image(year, GRID_FINE, roi_geom, clip_geom, avail)
        prepared[year] = {"meta": meta, "image": image}
        s = _s03_summarise_scenes(meta["main"])
        log(f"03: frame {year}: {s['scenes']} clear / {s['scenes_all']} scenes {s['scenes_per_pathrow']}, sensors "
            f"{s['sensors']}, mean overpass {s['mean_overpass_ist_h']:.2f} h IST")
    handles = _s03_export_frames(prepared) if (CFG.GEE_EXPORT == "asset" and prepared) else {}
    longest = 0.0
    for year, item in prepared.items():
        # D3: do not start a frame that would not finish inside the time budget (1.25 x the slowest frame so far)
        check_budget(f"03 frame {year}", 1.25 * longest)
        t0 = time.perf_counter()
        fetch_stats: dict = {}
        with timer(f"03 extract {year}"):
            h = handles.get(year)
            if h is not None and h.get("state") == "COMPLETED":
                stack = gee_fetch_asset(h["asset_id"], GRID_FINE, bands, f"s03_asset_{year}", stats=fetch_stats)
                extraction, mode = f"batch asset {h['asset_id']}", "asset"
            else:
                stack = gee_fetch_grid(item["image"], GRID_FINE, bands, f"s03_landsat_{year}", heavy=True,
                                       stats=fetch_stats)
                mode = "interactive" if h is None else f"interactive (asset export {h.get('state')})"
                extraction = f"{mode} computePixels"
            wall = time.perf_counter() - t0
            cost = {"mode": mode, "seconds": round(wall, 1), "tiles": int(fetch_stats.get("tiles", 0)),
                    "tiles_cached": int(fetch_stats.get("cached", 0)), "splits": int(fetch_stats.get("splits", 0)),
                    "tile_px": fetch_stats.get("tile_px")}
            record = _s03_finalise_frame(year, item["meta"], stack, extraction, cost=cost)
            del stack
        longest = max(longest, time.perf_counter() - t0)
        records[year] = caches[year].save(record)
        free_memory()
    return records


def _s03_cost_table() -> pd.DataFrame:
    """Per-frame extraction cost (D2/T-F1-08): mode, wall seconds, tiles, splits, coverage, median nobs, scenes."""
    rows = []
    for year in CFG.FRAMES_OBS:
        cost = (_S03_QA.get(year) or {}).get("cost") or {}
        rows.append({"year": year, "mode": cost.get("mode", "?"), "seconds": cost.get("seconds"),
                     "tiles": cost.get("tiles"), "cached_tiles": cost.get("tiles_cached"),
                     "splits": cost.get("splits"), "coverage": cost.get("coverage"),
                     "median_nobs": cost.get("median_nobs"), "scenes": cost.get("scenes"),
                     "from_stage_cache": bool((_S03_QA.get(year) or {}).get("from_stage_cache"))})
    return pd.DataFrame(rows).set_index("year")


if _S03_ACTIVE:
    with gee_workload_tag("lst-v2-s03"), timer("03 Landsat day LST"):
        _S03_RECORDS = _s03_run()
    for _s03_year in CFG.FRAMES_OBS:
        _s03_rec = _S03_RECORDS[_s03_year]
        RAW_OBS.setdefault(int(_s03_year), {}).update({k: np.ascontiguousarray(v, dtype=np.float32)
                                                       for k, v in _s03_rec["fine"].items()})
        _s03_fm = FRAME_META.setdefault(int(_s03_year), {})
        _s03_fm["window"] = tuple(int(v) for v in CFG.WINDOWS[_s03_year])
        _s03_fm["day"] = dict(_s03_rec["day"])
        for _s03_var, _s03_text in _s03_rec["sources"].items():
            DATA_SOURCES.setdefault(_s03_var, {})[int(_s03_year)] = _s03_text
        for _s03_w in _s03_rec["warnings"]:
            log(f"03: {_s03_w}", "WARNING")
        for _s03_c in _s03_rec["notes"] + [f"Landsat {w}." for w in _s03_rec["warnings"]]:
            if _s03_c not in DATA_CAVEATS:
                DATA_CAVEATS.append(_s03_c)
        _S03_QA.setdefault(int(_s03_year), {}).update(_s03_rec["qa"])
    del _S03_RECORDS, _s03_rec, _s03_fm, _s03_year, _s03_var, _s03_text
    free_memory()

# %% [markdown]
# ## 3.6 Contract check and quality report
# These checks verify the section-3 part of the SPEC §3.2 interface: the fine arrays have shape `(Hf, Wf)`, are
# float32 and are NaN outside the ROI, and `FRAME_META[y]["day"]` has exactly the SPEC keys and the five path/rows.
# The table and figure show, per frame, the evidence behind the day tier (scenes per path/row), the overpass, the
# heating rate, the path offset and the coverage.

# %%
def _s03_validate() -> None:
    hf, wf = GRID_FINE.height, GRID_FINE.width
    for year in CFG.FRAMES_OBS:
        obs = RAW_OBS[year]
        for key in _S03_FINE_KEYS:
            arr = obs[key]
            assert arr.shape == (hf, wf) and arr.dtype == np.float32, (year, key, arr.shape, arr.dtype)
            assert np.isnan(arr[~ROI_MASK_FINE]).all(), f"RAW_OBS[{year}][{key}] must be NaN outside the ROI"
        assert np.isfinite(obs["lst_day_nobs_f"][ROI_MASK_FINE]).all(), "lst_day_nobs_f must be finite in the ROI"
        assert (obs["lst_day_nobs_f"][ROI_MASK_FINE] >= 0).all()
        day = FRAME_META[year]["day"]
        assert set(day) == set(_S03_DAY_META_KEYS), sorted(day)
        assert set(day["scenes_per_pathrow"]) == set(_S03_PATHROWS), day["scenes_per_pathrow"]
        assert day["scenes"] == sum(day["scenes_per_pathrow"].values())
        assert set(day["path_offsets"]) == set(_S03_PATHS)
        assert abs(day["path_offsets"]["146"] + day["path_offsets"]["147"]) < 1e-3, "offsets must be symmetric"
        assert 0.0 <= day["coverage"] <= 1.0 and isinstance(day["sensors"], list) and day["sensors"]
        assert np.isfinite(day["mean_overpass_ist_h"]) and np.isfinite(day["heating_rate_k_per_h"])
        assert tuple(FRAME_META[year]["window"]) == tuple(CFG.WINDOWS[year])
        for key in _S03_FINE_KEYS:
            assert year in DATA_SOURCES.get(key, {}), (key, year)


if _S03_ACTIVE:
    _s03_validate()
    log("section-3 contract check passed")
    _s03_rows = []
    for _s03_y in CFG.FRAMES_OBS:
        _s03_d = FRAME_META[_s03_y]["day"]
        _s03_lst = RAW_OBS[_s03_y]["lst_day_f"]
        _s03_rows.append({
            "year": _s03_y, "window": "-".join(map(str, CFG.WINDOWS[_s03_y])), "sensors": ", ".join(_s03_d["sensors"]),
            "clear_scenes": _s03_d["scenes"], "min_per_pathrow": min(_s03_d["scenes_per_pathrow"].values()),
            "overpass_ist": "{:d}:{:02d}".format(*divmod(int(round(60 * _s03_d["mean_overpass_ist_h"])), 60)),
            "heating_K_h": _s03_d["heating_rate_k_per_h"], "offset_146": _s03_d["path_offsets"]["146"],
            "coverage": _s03_d["coverage"], "lst_mean_c": round(float(np.nanmean(_s03_lst)), 2),
            "corr_to_10:45_c": round((CFG.DAY_REFERENCE_OVERPASS_IST_H - _s03_d["mean_overpass_ist_h"])
                                     * _s03_d["heating_rate_k_per_h"], 2)})
    print("Landsat day frames (raw, harmonised; corr_to_10:45 is applied in section 09)")
    _show(pd.DataFrame(_s03_rows).set_index("year"))
    _s03_cost = _s03_cost_table()
    print("Landsat extraction cost per frame (seconds/tiles of the run that extracted the frame; from_stage_cache = "
          "reused now)" + (f"; max export concurrency {_S03_QA['export_concurrency']}"
                           if "export_concurrency" in _S03_QA else ""))
    _show(_s03_cost)
    # Full-frame equivalent seconds of the frames whose tiles were downloaded (not all read from the tile cache):
    # seconds / fetched tiles x tiles; frames rebuilt from cached tiles say nothing about Earth Engine speed.
    _s03_num = _s03_cost[["seconds", "tiles", "cached_tiles"]].apply(pd.to_numeric, errors="coerce")
    _s03_fetched = _s03_num["tiles"] - _s03_num["cached_tiles"].fillna(0)
    _s03_ok = (_s03_fetched > 0) & _s03_num["seconds"].notna() & _s03_cost["mode"].astype(str).ne("asset")
    _s03_secs = (_s03_num["seconds"] / _s03_fetched * _s03_num["tiles"])[_s03_ok]
    if CFG.PROFILE == "pilot" and len(_s03_secs):
        log(f"03 PILOT: ~{_s03_secs.mean() / 60:.1f} min per frame of downloads ({len(_s03_secs)} frame(s) with "
            f"downloaded tiles) -> projected full-run section 03: ~{_s03_secs.mean() * _S03_FULL_FRAMES / 3600:.1f} h "
            f"fresh ({_S03_FULL_FRAMES} frames), or ~{_s03_secs.mean() * 4 / 3600:.1f} h with this pilot's output "
            "attached (its tiles are reused; 4 new frames). Rough: the 1990-2005 windows are lighter than the dense "
            "2010-2025 ones. Decide one commit vs the LST_STOP_AFTER=06 split with README step 7.", "WARNING")
    elif CFG.PROFILE == "pilot":
        log("03 PILOT: no Landsat tiles were downloaded in this session (all read from the cache), so there is no "
            "Earth Engine speed to project from; see the run that downloaded them.")
    del _s03_cost, _s03_secs, _s03_num, _s03_fetched, _s03_ok
    _s03_n = len(CFG.FRAMES_OBS)
    _s03_ncol = min(4, _s03_n)
    _s03_nrow = int(math.ceil(_s03_n / _s03_ncol))
    _s03_stride = max(1, GRID_FINE.width // 600)
    _s03_all = np.concatenate([RAW_OBS[y]["lst_day_f"][::_s03_stride, ::_s03_stride].ravel() for y in CFG.FRAMES_OBS])
    _s03_lo, _s03_hi = (np.nanpercentile(_s03_all, [1, 99]) if np.isfinite(_s03_all).any() else (20.0, 50.0))
    fig, axes = plt.subplots(_s03_nrow, _s03_ncol, figsize=(4.2 * _s03_ncol, 4.6 * _s03_nrow), squeeze=False,
                             constrained_layout=True)
    for _s03_i, _s03_y in enumerate(CFG.FRAMES_OBS):
        _s03_ax = axes[_s03_i // _s03_ncol][_s03_i % _s03_ncol]
        _s03_im = _s03_ax.imshow(RAW_OBS[_s03_y]["lst_day_f"][::_s03_stride, ::_s03_stride], cmap="inferno",
                                 vmin=_s03_lo, vmax=_s03_hi, interpolation="nearest")
        _s03_ax.set_title(f"{_s03_y} ({FRAME_META[_s03_y]['day']['scenes']} scenes, "
                          f"cov {FRAME_META[_s03_y]['day']['coverage']:.2f})", fontsize=9)
        _s03_ax.set_axis_off()
    for _s03_j in range(_s03_n, _s03_nrow * _s03_ncol):
        axes[_s03_j // _s03_ncol][_s03_j % _s03_ncol].set_axis_off()
    fig.colorbar(_s03_im, ax=axes, shrink=0.6, label="Landsat LST (°C, harmonised, raw overpass)")
    fig.suptitle(f"Landsat C2 L2 day LST on the {GRID_FINE.res} m grid", fontsize=11)
    fig.savefig(CFG.FIG_DIR / "03_landsat_day_lst.png", dpi=110, bbox_inches="tight")
    plt.show()
    plt.close(fig)
    del _s03_rows, _s03_y, _s03_d, _s03_lst, _s03_all, _s03_lo, _s03_hi, _s03_im, _s03_ax, _s03_i, _s03_n
    del _s03_ncol, _s03_nrow, _s03_stride
    free_memory()
