# %% [markdown]
# # 4. Night LST, MODIS day validation, night calibrations and the annual series (gee mode only)
#
# This section runs only when `DATA_MODE == "gee"`; in synthetic mode section 02 already produced every global
# listed below and this section does nothing (SPEC §0 mode gating).
#
# **What is produced** (SPEC §2.1 last bullet, §2.2, §3.2):
#
# | Global | Content |
# |---|---|
# | `RAW_OBS[y]["lst_night"]` | Apr–Jun window median night LST at 1 km, °C in **Aqua-equivalent** units |
# | `RAW_OBS[y]["lst_night_nobs"]` | number of valid composites (Aqua/Terra 8-day) or daily observations (VIIRS) |
# | `RAW_OBS[y]["lst_day_modis"]` | MODIS Terra day LST (QC + view time 10.0–11.5 h), window median at 1 km (validation) |
# | `FRAME_META[y]["night"]` | source, sensor, overpass (IST h, measured from the view-time bands), composites, coverage |
# | `NIGHT_CALIBRATION` | Terra→Aqua and VIIRS→Aqua per-class linear maps (+ shrunk per-cell residuals) with R², RMSE, n |
# | `ANNUAL_SERIES` | 1990–2025 annual Apr–Jun series for NCR + 25 districts (ERA5-Land, MODIS, calibrated VIIRS) |
#
# **Why these products** (`docs/research/gee_datasets_v2.md` §0, §1B):
#
# * *Night ≈ 01:30–02:00 IST.* Aqua MYD11A2 (night pass 02:12 IST, stable 2003–2022) is the reference sensor. By
#   2025 Aqua drifted to ~03:20 IST, so the 2025 frame uses VIIRS S-NPP VNP21A1N (02:06 IST, stable 2013–2026).
#   For 2000 only Terra exists, whose night pass is ~22:27 IST — 3.5 h earlier, i.e. a warmer, less cooled surface.
#   Both substitutes are mapped to Aqua-equivalent values with an **overlap calibration**:
#   per dominant GLC_FCS30D class a linear map `aqua = a + b·src` fitted on annual Apr–Jun medians of every cell in
#   the overlap years (VIIRS↔Aqua 2013–2021, Terra↔Aqua 2003–2019), plus a per-cell mean residual shrunk towards 0
#   with weight `n/(n+3)` (n = overlap years of the cell). The shrinkage is a James–Stein-style compromise: a cell
#   with many overlap years keeps most of its persistent local offset (emissivity/algorithm differences between the
#   MYD11 split-window and VNP21 TES retrievals are surface-specific, 1–3 K over bare/arid land), a cell with one or
#   two years is mostly explained by its class map. The quality of the transfer is checked by leave-one-year-out.
# * *QC.* MOD11/MYD11: mandatory QA (bits 0–1) ≤ 1 and LST error (bits 6–7) ≤ 1 (≤ 2 K). VNP21: mandatory QA ≤ 1 and
#   LST accuracy (bits 14–15) ≥ 2 (≤ 1.5 K). The catalog does not state the VNP21 `LST_1KM` scale, so it is checked
#   at run time: values > 1000 are digital numbers and get × 0.02 (a wrong scale would corrupt LST by 50×).
# * *MODIS Terra day* (11:07 IST until 2020) is kept as an **independent 1 km validation** of the Landsat day level and
#   for the downscaling demonstration; composites are restricted to a view time of 10.0–11.5 h local solar time so
#   the 2022+ orbit drift (10:07 IST in 2025) cannot leak in silently — drifted years are flagged `"drift"`.
# * *Annual series 1990–2025.* ERA5-Land hourly skin temperature at 05 UTC (10:30 IST) and 20 UTC (01:30 IST),
#   daily-aggregate Tmax/Tmin and monthly soil moisture over NCR and every district (server-side `reduceRegions`, one
#   batched request per variable — never a per-district `getInfo` loop); satellite series (Terra day, Aqua night,
#   VIIRS night calibrated to Aqua) are scope means of the 1 km annual fields on the analysis grid — exactly the cells
#   of `DISTRICT_IDX`, and the only way to apply the per-cell VIIRS calibration. They feed the β (dLST/dTair)
#   regressions and the 1990/1995 night-level hindcast of section 09.
#
# Every Earth Engine expression is built lazily and pulled with v1's tiled `fetch_grid` (section 01: retry/backoff,
# quartering, on-disk tile cache keyed by the serialised expression) or, with `LST_GEE_EXPORT=asset`, batch-exported
# to an asset first (`Export.image.toAsset` on the exact grid transform) for the multi-year stacks. Small reductions
# use one batched `getInfo` per logical request with recursive halving on memory/time-out errors.

# %%
import math as _s04_math
import time as _s04_time
from dataclasses import dataclass as _s04_dataclass

import numpy as np
import pandas as pd
import matplotlib.pyplot as plt
from scipy import ndimage as _s04_ndi

_S04_ACTIVE = globals().get("DATA_MODE") == "gee"
_S04_VERSION = "s04-v2.1"   # v2.1: class calibration needs >= 20 cells; 64 km heavy tiles for GLC fractions

# Earth Engine assets (verified on the catalog pages, docs/research/gee_datasets_v2.md §1B/§1C)
_S04_TERRA = "MODIS/061/MOD11A2"           # 8-day, 2000-02-18 -> ; LST_*_1km x0.02 K, *_view_time x0.1 h
_S04_AQUA = "MODIS/061/MYD11A2"            # 8-day, 2002-07-04 -> (first full Apr-Jun season: 2003)
_S04_VIIRS_N = "NASA/VIIRS/002/VNP21A1N"   # daily S-NPP night, 2012-01-19 -> ; LST_1KM (K), QC, View_Time (h)
_S04_ERA5_HOURLY = "ECMWF/ERA5_LAND/HOURLY"
_S04_ERA5_DAILY = "ECMWF/ERA5_LAND/DAILY_AGGR"
_S04_ERA5_MONTHLY = "ECMWF/ERA5_LAND/MONTHLY_AGGR"
_S04_GLC_ANNUAL = "projects/sat-io/open-datasets/GLC-FCS30D/annual"           # b1 = 2000 ... b23 = 2022
_S04_GLC_FIVE = "projects/sat-io/open-datasets/GLC-FCS30D/five-years-map"     # b1 = 1985, b2 = 1990, b3 = 1995
_S04_GLC_FIVE_BANDS = {1985: "b1", 1990: "b2", 1995: "b3"}
_S04_GLC_LAST_YEAR = 2022

_S04_MODIS_SCALE_M = 926.625433055833      # MODIS/VIIRS 1 km sinusoidal nominal pixel
_S04_ERA5_SCALE_M = 11132.0                # ERA5-Land 0.1 deg
_S04_GLC_SCALE_M = 30.0

_S04_TERRA_FIRST, _S04_AQUA_FIRST, _S04_VIIRS_FIRST = 2000, 2003, 2012
_S04_DRIFT_FROM = 2022                     # Terra (earlier) and Aqua (later) orbits drifted from 2022 (SPEC §2.2)
_S04_DAY_VIEW_WINDOW_H = (10.0, 11.5)      # MOD11A2 Day_view_time, local solar time (SPEC §2.1)
_S04_CAL_YEARS = {"terra_to_aqua": (2003, 2019), "viirs_to_aqua": (2013, 2021)}
_S04_CAL_MIN_POINTS = 30                   # class maps with fewer (cell, year) pairs fall back to the pooled map
_S04_CAL_MIN_CELLS = 20                    # ... or with fewer distinct cells (a few cells x many years is no fit)
# Asset-mode limits of the 04/05 batch exports (D6): per running task, and while queued
_S04_EXPORT_TIMEOUT_S = int(_env_int("LST_GEE_EXPORT_TIMEOUT_0405_S", 3600))
_S04_EXPORT_QUEUE_S = 7200
_S04_EXPORT_DIAG: list = []                # per batch: {jobs, max_running, states, seconds}
_S04_CAL_SHRINK_K = 3.0                    # residual shrinkage weight n / (n + k)
# Valid composites / days for an annual Apr-Jun median. Night MODIS accepts one composite (itself a multi-night mean):
# real Aqua data (2026-11) give >= 3 on only 13-50 % of the NCR cells per year, which failed the 50 % scope gate in
# 18 of 23 years, while >= 1 covers 75-94 %. Too few years left the level regression and beta on 8 points.
_S04_ANNUAL_MIN_N = {"modis": 3, "modis_night": 1, "viirs": 10}
_S04_SCOPE_MIN_COVERAGE = 0.5              # a scope-year satellite mean needs >= 50 % of the scope's cells valid
_S04_GLC_ANCHORS = (2000, 2005, 2010, 2015, 2020, 2022)   # land-cover years used for the "dominant class"
_S04_NOMINAL_IST_H = {"aqua": 2.20, "terra": 22.45, "viirs": 2.10}   # docs §0 F4 (granule mid-times, May)
_S04_ERA5_HOURS_UTC = {"era5_skin_day": 5, "era5_skin_night": 20}   # 10:30 IST and 01:30 IST
_S04_ERA5_SERIES = ("era5_skin_day", "era5_skin_night", "era5_tmax", "era5_tmin", "era5_swvl1")
_S04_SAT_SERIES = ("modis_terra_day", "modis_aqua_night", "viirs_night_cal")
_S04_SERIES_YEARS = (1990, 2025)
_S04_GLC_KEYS = ["glc_built", "glc_forest", "glc_water", "glc_cropland", "glc_barren", "glc_otherveg"]
_S04_NIGHT_SENSOR = {
    "aqua": "MODIS Aqua MYD11A2 night (~02:12 IST)",
    "terra_cal": "MODIS Terra MOD11A2 night (~22:30 IST), calibrated to Aqua",
    "viirs_cal": "VIIRS S-NPP VNP21A1N night (~02:06 IST), calibrated to Aqua",
}

if _S04_ACTIVE:
    log(f"section 04 ({_S04_VERSION}): MODIS/VIIRS thermal products for frames {list(CFG.FRAMES_OBS)}")
else:
    log("section 04 skipped: data mode is not 'gee' (section 02 provided the synthetic thermal products)")

# %% [markdown]
# ## 4.1 Earth Engine helpers shared by sections 04 and 05
# * `_s04_season_filter` / `_s04_season_dates` — the Apr–Jun season of `CFG.SEASON` as a month filter (or a
#   day-of-year filter if the season is not month-aligned) and as explicit per-year dates.
# * `_s04_to_grid` — v1's aggregation recipe: area-weighted `reduceResolution(mean)` from the native projection,
#   then `reproject` onto the exact grid transform (nearest when the source is not coarser).
# * `_s04_getinfo` — one `getInfo` with the section-01 error classification (transient → backoff retry);
#   `_s04_batched` evaluates a request over a list of items and halves the list on memory/time-out errors, so a
#   batch degrades gracefully instead of failing or falling back to per-item loops.
# * `_s04_fetch` / `_s04_fetch_jobs` — grid extraction through section 03's public `gee_fetch_grid` (section 01's
#   `fetch_grid` if 03 is absent); with `CFG.GEE_EXPORT == "asset"` the listed heavy stacks are first exported with
#   03's `gee_export_to_asset` (all tasks started, then `gee_wait_for_exports`; identical assets reused by their
#   stored expression hash) and read back with `gee_fetch_asset`. Without section 03 a self-contained exporter
#   is used (asset names carry the expression hash). Failed exports fall back to interactive extraction.

# %%
def _s04_season_months() -> Optional[tuple]:
    """(first_month, last_month) if ``CFG.SEASON`` is month-aligned (e.g. 04-01 .. 06-30), else None."""
    (m0, d0), (m1, d1) = [tuple(int(v) for v in s.split("-")) for s in CFG.SEASON]
    last_day = (pd.Timestamp(2001, m1, 1) + pd.offsets.MonthEnd(0)).day
    return (m0, m1) if d0 == 1 and d1 == last_day else None


def _s04_season_filter():
    """Server-side filter selecting the pre-monsoon season of any year."""
    months = _s04_season_months()
    if months is not None:
        return ee.Filter.calendarRange(months[0], months[1], "month")
    d0 = pd.Timestamp(f"2001-{CFG.SEASON[0]}").dayofyear
    d1 = pd.Timestamp(f"2001-{CFG.SEASON[1]}").dayofyear
    return ee.Filter.dayOfYear(int(d0), int(d1))


def _s04_season_dates(year: int) -> tuple:
    """[start, end) ISO dates of the season of ``year`` (end exclusive)."""
    start = f"{int(year)}-{CFG.SEASON[0]}"
    end = (pd.Timestamp(f"{int(year)}-{CFG.SEASON[1]}") + pd.Timedelta(days=1)).strftime("%Y-%m-%d")
    return start, end


def _s04_season_days() -> int:
    """Number of days in the season (non-leap year), e.g. 91 for Apr-Jun."""
    return int((pd.Timestamp(f"2001-{CFG.SEASON[1]}") - pd.Timestamp(f"2001-{CFG.SEASON[0]}")).days + 1)


def _s04_years_dates(y0: int, y1: int) -> tuple:
    """[start, end) dates covering the calendar years y0..y1 (the season filter is applied separately)."""
    return f"{int(y0)}-01-01", f"{int(y1) + 1}-01-01"


def _s04_to_grid(image, native_scale_m: float, grid: GridSpec, reducer=None):
    """Aggregate ``image`` (with a valid default projection) onto ``grid`` (v1 recipe).

    Coarsening uses an area-weighted ``reduceResolution`` (mask-aware mean by default) with ``maxPixels`` sized to the
    scale ratio; refining or equal scales use a plain ``reproject`` (nearest neighbour).
    """
    if native_scale_m < grid.res * 0.999:
        ratio = (grid.res / native_scale_m) ** 2
        max_pixels = int(min(65535, max(1024, _s04_math.ceil(ratio * 2.5))))
        image = image.reduceResolution(reducer=reducer or ee.Reducer.mean(), bestEffort=False, maxPixels=max_pixels)
    return image.reproject(crs=grid.crs, crsTransform=grid.transform_list())


def _s04_native(collection_id: str, band: str):
    """Native projection of ``band`` in an image collection (from its first image)."""
    return ee.Image(ee.ImageCollection(collection_id).first()).select(band).projection()


def _s04_masked_dummy(band: str = "lst"):
    """A fully masked one-band image: merged into a collection it guarantees reducers return ``band`` even for an
    empty collection (median/count of an empty collection would otherwise have zero bands), without changing any
    statistic (masked pixels are ignored by every reducer)."""
    return ee.Image.constant(0).toFloat().rename(band).updateMask(ee.Image.constant(0))


def _s04_getinfo(obj, label: str, allow_split: bool = False):
    """``obj.getInfo()`` with backoff on transient errors; memory/time-out errors become ``_GEESplitError`` when
    ``allow_split`` (the caller then halves its batch)."""
    def _call():
        try:
            return obj.getInfo()
        except Exception as exc:  # noqa: BLE001 - classified below
            raise _classify_gee_error(exc, allow_split) from exc

    def _on_retry(attempt, exc, delay):
        log(f"{label}: getInfo retry {attempt} in {delay:.1f}s: {str(exc)[:160]}", "WARNING")

    return retry(_call, tries=CFG.GEE_MAX_RETRIES, base_delay=2.0, max_delay=120.0,
                 retry_on=(_GEETransientError,), on_retry=_on_retry)


def _s04_batched(items: Sequence, build: Callable, parse: Callable, label: str, isolate: bool = False) -> list:
    """Evaluate ``build(items)`` with ONE getInfo; on memory/time-out errors split ``items`` in halves recursively.

    ``parse(info, items)`` turns the getInfo payload into a list of records. Returns the concatenated records.
    With ``isolate=True`` a *permanent* error (e.g. one GCM whose images lack a band) also splits the batch, so the
    failing item is isolated, logged and skipped while every other item is still evaluated in batches; a single item
    that still fails with a transient error after its retries is skipped the same way (the caller's completeness
    filter then drops it). "Too many concurrent aggregations" that persists after the retries halves the batch like
    a memory/time-out error.
    """
    items = list(items)
    if not items:
        return []
    try:
        info = _s04_getinfo(build(items), label, allow_split=len(items) > 1)
    except _GEESplitError as exc:
        half = len(items) // 2
        log(f"{label}: request too heavy for {len(items)} items ({str(exc)[:120]}); splitting {half}+"
            f"{len(items) - half}", "WARNING")
        return (_s04_batched(items[:half], build, parse, f"{label}[a]", isolate)
                + _s04_batched(items[half:], build, parse, f"{label}[b]", isolate))
    except _GEETransientError as exc:
        if len(items) > 1 and re.search(r"too many concurrent aggregations", str(exc), re.IGNORECASE):
            half = len(items) // 2
            log(f"{label}: 'too many concurrent aggregations' for {len(items)} items after retries; splitting "
                f"{half}+{len(items) - half}", "WARNING")
            return (_s04_batched(items[:half], build, parse, f"{label}[a]", isolate)
                    + _s04_batched(items[half:], build, parse, f"{label}[b]", isolate))
        if isolate and len(items) == 1:
            log(f"{label}: item {items[0]} still fails after its retries and is skipped: {str(exc)[:200]}", "WARNING")
            return []
        if not isolate:
            raise
        half = len(items) // 2
        return (_s04_batched(items[:half], build, parse, f"{label}[a]", isolate)
                + _s04_batched(items[half:], build, parse, f"{label}[b]", isolate))
    except Exception as exc:  # noqa: BLE001 - permanent server error
        if not isolate:
            raise
        if len(items) == 1:
            log(f"{label}: item {items[0]} failed permanently and is skipped: {type(exc).__name__}: "
                f"{str(exc)[:200]}", "WARNING")
            return []
        half = len(items) // 2
        return (_s04_batched(items[:half], build, parse, f"{label}[a]", isolate)
                + _s04_batched(items[half:], build, parse, f"{label}[b]", isolate))
    return parse(info, items)


def _s04_fc_records(info: dict) -> list:
    """Property dicts of a FeatureCollection getInfo payload."""
    if not isinstance(info, dict) or "features" not in info:
        raise RuntimeError(f"unexpected FeatureCollection payload: {str(info)[:200]}")
    return [dict(f.get("properties") or {}) for f in info["features"]]


def _s04_asset_name(name: str, image, grid: GridSpec) -> str:
    """Asset id under ``CFG.GEE_ASSET_ROOT`` that encodes the request and the expression hash."""
    digest = _gee_expression_digest(image)[:12]
    safe = re.sub(r"[^A-Za-z0-9_-]", "_", name)[:60]
    return f"{CFG.GEE_ASSET_ROOT.rstrip('/')}/{safe}_{int(grid.res)}m_{digest}"


def _s04_asset_exists(asset_id: str) -> bool:
    try:
        ee.data.getAsset(asset_id)
        return True
    except Exception:  # noqa: BLE001 - "not found" and permission errors look alike: treat as absent
        return False


def _s04_cancel_task(task, name: str) -> None:
    """Cancel a still-active batch task (guarded; a failed cancel only costs EECU)."""
    try:
        if hasattr(task, "cancel"):
            task.cancel()
        elif getattr(task, "id", None) and hasattr(ee.data, "cancelTask"):
            ee.data.cancelTask(task.id)
        else:
            return
        log(f"  asset export of {name} cancelled; extracted with computePixels instead", "WARNING")
    except Exception as exc:  # noqa: BLE001
        log(f"  could not cancel the asset export of {name}: {str(exc)[:160]}", "WARNING")


def _s04_export_assets(jobs: list, timeout_s: Optional[float] = None, queue_s: Optional[float] = None,
                       poll_s: float = 30.0) -> dict:
    """Batch-export every job to an asset (submitted together, polled together; used only without section 03).

    Per-task limits: ``timeout_s`` (LST_GEE_EXPORT_TIMEOUT_0405_S, 1 h) after the first poll that saw it RUNNING and
    ``queue_s`` (2 h) while not yet RUNNING. A task that fails or times out is cancelled when still active and left
    out, so its job is extracted interactively exactly once. Returns {job name: asset id} of the ready assets.
    """
    timeout_s = float(_S04_EXPORT_TIMEOUT_S if timeout_s is None else timeout_s)
    queue_s = float(_S04_EXPORT_QUEUE_S if queue_s is None else queue_s)
    ready, pending = {}, {}
    for job in jobs:
        asset_id = _s04_asset_name(job["name"], job["image"], job["grid"])
        if _s04_asset_exists(asset_id):
            ready[job["name"]] = asset_id
            continue
        grid = job["grid"]
        policy = {".default": "mode"} if np.dtype(job["dtype"]).kind in "iu" else {".default": "mean"}
        try:
            task = ee.batch.Export.image.toAsset(
                image=job["image"], description=re.sub(r"[^A-Za-z0-9_-]", "_", f"ncr_{job['name']}")[:100],
                assetId=asset_id, crs=grid.crs, crsTransform=grid.transform_list(),
                dimensions=f"{int(grid.width)}x{int(grid.height)}", maxPixels=int(1e13), pyramidingPolicy=policy)
            task.start()
            pending[job["name"]] = {"task": task, "asset_id": asset_id, "running_since": None}
            log(f"  asset export started: {asset_id}")
        except Exception as exc:  # noqa: BLE001 - fall back to interactive extraction for this job
            log(f"asset export of {job['name']} could not start ({str(exc)[:160]}); using computePixels", "WARNING")
    t0 = _s04_time.time()
    max_running = 0
    while pending:
        _f = globals().get("check_budget")
        if _f is not None:
            _f(f"waiting for {len(pending)} section-04/05 asset export(s)")
        now = _s04_time.time()
        n_running = 0
        for name, rec in list(pending.items()):
            task = rec["task"]
            try:
                status = task.status() or {}
            except Exception as exc:  # noqa: BLE001 - transient status failure: poll again
                log(f"task status of {name} unavailable: {str(exc)[:120]}", "WARNING")
                continue
            state = status.get("state", "UNKNOWN")
            if state == "COMPLETED":
                ready[name] = rec["asset_id"]
                pending.pop(name)
                log(f"  asset export finished: {rec['asset_id']}")
                continue
            if state in ("FAILED", "CANCELLED", "CANCEL_REQUESTED"):
                log(f"asset export of {name} {state}: {str(status.get('error_message', state))[:200]}; using "
                    "computePixels", "WARNING")
                pending.pop(name)
                continue
            if state == "RUNNING":
                n_running += 1
                rec["running_since"] = rec["running_since"] or now
            too_long = rec["running_since"] is not None and now - rec["running_since"] > timeout_s
            too_queued = rec["running_since"] is None and now - t0 > queue_s
            if too_long or too_queued:
                log(f"asset export of {name} {'running' if too_long else 'queued'} beyond its limit "
                    f"({timeout_s if too_long else queue_s:.0f} s)", "WARNING")
                _s04_cancel_task(task, name)
                pending.pop(name)
        max_running = max(max_running, n_running)
        if not pending:
            break
        log(f"  section-04/05 exports: {n_running} RUNNING, {len(pending)} not finished")
        _s04_time.sleep(poll_s)
    _S04_EXPORT_DIAG.append({"jobs": [j["name"] for j in jobs], "max_running": int(max_running),
                             "ready": sorted(ready), "seconds": round(_s04_time.time() - t0, 1)})
    return ready


def _s04_have_s03_helpers() -> bool:
    """True when section 03's public fetch/export helpers are defined (the normal gee-mode notebook)."""
    return all(callable(globals().get(n)) for n in ("gee_fetch_grid", "gee_export_to_asset", "gee_wait_for_exports",
                                                    "gee_fetch_asset"))


def _s04_fetch(image, grid: GridSpec, bands: Sequence[str], name: str, dtype=np.float32,
               tile_px: Optional[int] = None, heavy: bool = False) -> np.ndarray:
    """Interactive tiled extraction of ``bands`` on ``grid`` (cached by expression hash) -> (B, H, W).

    Uses section 03's ``gee_fetch_grid`` when available (same tiling/caching/unmask conventions as the Landsat
    stacks), else section 01's ``fetch_grid`` directly. ``heavy=True`` marks a *computed* image built from 30 m
    inputs (GLC fractions, SRTM/GSW, GHSL): without an explicit ``tile_px`` it then uses section 03's ~64 km tiles
    (64 px at 1 km, 256 px at 250 m), so each request stays within interactive compute limits; light images (MODIS,
    VIIRS, ERA5, asset reads) use large tiles.
    """
    bands = list(bands)
    if tile_px:
        tile = int(tile_px)
    elif heavy and callable(globals().get("_s03_default_tile_px")):
        tile = int(_s03_default_tile_px(grid, len(bands), dtype, heavy=True))
    else:
        tile = int(gee_tile_px(len(bands), dtype, cap=1024))
    if _s04_have_s03_helpers():
        return gee_fetch_grid(image, grid, bands, name, tile_px=tile, dtype=dtype, heavy=heavy)
    return fetch_grid(image, grid, bands, tile, gee_cache_key(name, grid, bands, image=image), dtype)


def _s04_fetch_jobs_s03(jobs: list) -> dict:
    """Asset mode through section 03's helpers: start every export (no wait), wait for all, read the assets.

    Assets get stable ids ``<GEE_ASSET_ROOT>/<job name>``; section 03 stores the expression hash on each asset, reuses
    an identical one, re-exports a changed one and attaches to a still-running task of an interrupted session. The
    wait uses per-task limits (LST_GEE_EXPORT_TIMEOUT_0405_S = 1 h running, 2 h queued) and never aborts on the first
    failure: COMPLETED jobs are read from their asset; a job that FAILED, was CANCELLED or timed out has its task
    cancelled (when still active) and is extracted interactively, once.
    """
    handles, out = {}, {}
    for job in jobs:
        asset_id = f"{CFG.GEE_ASSET_ROOT.rstrip('/')}/{re.sub(r'[^A-Za-z0-9_-]', '_', job['name'])[:90]}"
        pyramiding = "mode" if np.dtype(job["dtype"]).kind in "iu" else "mean"
        try:
            handles[job["name"]] = gee_export_to_asset(job["image"], asset_id, job["grid"],
                                                       description=f"ncr_{job['name']}", pyramiding=pyramiding,
                                                       wait=False)
        except Exception as exc:  # noqa: BLE001 - interactive extraction still works
            log(f"asset export of {job['name']} could not start ({type(exc).__name__}: {str(exc)[:160]}); "
                "using computePixels", "WARNING")
    stats: dict = {}
    if handles:
        gee_wait_for_exports(list(handles.values()), timeout_s=_S04_EXPORT_TIMEOUT_S, queue_s=_S04_EXPORT_QUEUE_S,
                             raise_on_failure=False, stats=stats)
        _cancel = globals().get("gee_cancel_export")
        for h in handles.values():
            if h.get("state") != "COMPLETED" and callable(_cancel):
                _cancel(h)
    _S04_EXPORT_DIAG.append({"jobs": [j["name"] for j in jobs], "max_running": int(stats.get("max_running", 0)),
                             "states": {n: h.get("state") for n, h in handles.items()},
                             "seconds": stats.get("seconds")})
    for job in jobs:
        h = handles.get(job["name"])
        with timer(f"04 fetch {job['name']}"):
            if h is not None and h.get("state") == "COMPLETED":
                out[job["name"]] = gee_fetch_asset(h["asset_id"], job["grid"], list(job["bands"]), job["name"],
                                                   dtype=job["dtype"])
            else:
                out[job["name"]] = _s04_fetch(job["image"], job["grid"], job["bands"], job["name"], job["dtype"],
                                              job.get("tile_px"), heavy=bool(job.get("heavy", False)))
    return out


def _s04_fetch_jobs(jobs: list, use_assets: bool = True) -> dict:
    """Fetch several grid jobs ``{name, image, grid, bands, dtype}``; with ``CFG.GEE_EXPORT == "asset"`` (and
    ``use_assets``) they are batch-exported first and read back from their assets. Returns {name: (B, H, W)}."""
    if use_assets and CFG.GEE_EXPORT == "asset" and jobs and _s04_have_s03_helpers():
        return _s04_fetch_jobs_s03(jobs)
    assets = _s04_export_assets(jobs) if (use_assets and CFG.GEE_EXPORT == "asset" and jobs) else {}
    out = {}
    for job in jobs:
        image = ee.Image(assets[job["name"]]).select(list(job["bands"])) if job["name"] in assets else job["image"]
        with timer(f"04 fetch {job['name']}"):
            out[job["name"]] = _s04_fetch(image, job["grid"], job["bands"], job["name"], job["dtype"],
                                          job.get("tile_px"), heavy=bool(job.get("heavy", False))
                                          and job["name"] not in assets)
    return out


def _s04_cells(field2d: np.ndarray) -> np.ndarray:
    """(H, W) grid -> canonical ROI cell vector (float64)."""
    return np.asarray(field2d, dtype=np.float64)[CELL_ROWS, CELL_COLS]


def _s04_grid_from_cells(values: np.ndarray, fill=np.nan, dtype=np.float32) -> np.ndarray:
    """Canonical ROI cell vector -> (H, W) grid (``fill`` outside the ROI)."""
    out = np.full(GRID.shape, fill, dtype=dtype)
    out[CELL_ROWS, CELL_COLS] = np.asarray(values).astype(dtype, copy=False)
    return out


def _s04_fill_roi_nearest(arr: np.ndarray, roi: np.ndarray, label: str) -> np.ndarray:
    """Fill non-finite ROI pixels with the nearest finite value (Euclidean, pixel units); NaN outside the ROI.

    Used for static/driver fields that must be complete inside the ROI (contract §3.2). Logs the share filled;
    raises if the field has no finite value at all.
    """
    out = np.array(arr, dtype=np.float32, copy=True)
    finite = np.isfinite(out)
    holes = roi & ~finite
    if holes.any():
        if not finite.any():
            raise RuntimeError(f"{label}: no valid pixel to fill from")
        _, (ir, ic) = _s04_ndi.distance_transform_edt(~finite, return_indices=True)
        out[holes] = out[ir[holes], ic[holes]]
        share = holes.sum() / max(1, int(roi.sum()))
        log(f"  {label}: {int(holes.sum()):,} ROI pixels ({100 * share:.2f} %) gap-filled by nearest neighbour",
            "WARNING" if share > 0.02 else "INFO")
    out[~roi] = np.nan
    return out


def _s04_roi_digest() -> str:
    """Short hash of the ROI/district rasters (part of every stage-cache key of 04/05)."""
    h = hashlib.sha1()
    h.update(np.ascontiguousarray(ROI_MASK).tobytes())
    h.update(np.ascontiguousarray(DISTRICT_IDX).tobytes())
    return h.hexdigest()[:16]

# %% [markdown]
# ## 4.2 Calibration and scope-mean mathematics (pure NumPy, unit-tested)
# **Calibration model.** For cell *i*, year *t* with dominant class *c(i,t)*:
# `aqua(i,t) = a_c + b_c · src(i,t) + r_i + ε`. The class map (a_c, b_c) is ordinary least squares over all valid
# (cell, year) pairs of the class (pooled fit when a class has < 30 pairs, fewer than 20 distinct cells or no spread).
# The persistent residual `r_i` is the cell's mean residual after the class map, shrunk with weight `n_i/(n_i + 3)`,
# where n_i is the number of overlap years of the cell — the posterior mean of a random cell effect when the residual
# variance is roughly 3× the between-cell variance, so short records are pulled towards the class map.
# `NIGHT_CALIBRATION` reports R²/RMSE of the class maps (as SPEC requires); the residual term's honest gain is measured
# by **leave-one-year-out** (fit on all other years, predict the held-out year) and logged/recorded in
# `NIGHT_CALIBRATION_DIAG`.

# %%
def _s04_ols(x: np.ndarray, y: np.ndarray) -> tuple:
    """Least squares y = a + b x -> (a, b); a degenerate x (no spread) gives slope 1 and the mean offset."""
    x, y = np.asarray(x, np.float64), np.asarray(y, np.float64)
    xm, ym = float(x.mean()), float(y.mean())
    var = float(((x - xm) ** 2).sum())
    if var <= 1e-12 * max(1.0, x.size):
        return ym - xm, 1.0
    b = float(((x - xm) * (y - ym)).sum() / var)
    return ym - b * xm, b


def _s04_fit_calibration(src: np.ndarray, aqua: np.ndarray, cls: np.ndarray, *,
                         min_points: int = _S04_CAL_MIN_POINTS, shrink_k: float = _S04_CAL_SHRINK_K,
                         min_cells: int = _S04_CAL_MIN_CELLS) -> tuple:
    """Fit per-class linear maps ``aqua = a + b·src`` and shrunk per-cell residuals.

    ``src``, ``aqua``: (years, cells) float arrays (NaN = missing); ``cls``: (years, cells) dominant class 1..6 (0 =
    unknown, handled by the pooled map). Returns ``(summary, coef, shrunk, info)``:

    * ``summary`` = ``{"r2", "rmse", "n", "by_class": [{"class", "a", "b", "n"}]}`` (SPEC §3.2; class-map fit);
    * ``coef`` = {class: (a, b)} including key 0 = pooled map (used for unknown classes);
    * ``shrunk`` = (cells,) float32 shrunk mean residual (0 where a cell has no overlap year);
    * ``info`` = {"pooled_classes": [...], "cells_per_class": {class: int}, "n_years_per_cell": (cells,) int,
      "r2_with_residual": float}.

    A class gets its own map only with >= ``min_points`` valid (cell, year) pairs AND >= ``min_cells`` distinct cells
    (a handful of cells observed in many years would otherwise give an unstable slope) and a non-degenerate spread.
    """
    src = np.asarray(src, np.float64)
    aqua = np.asarray(aqua, np.float64)
    cls = np.asarray(cls)
    if not (src.shape == aqua.shape == cls.shape) or src.ndim != 2:
        raise ValueError(f"calibration inputs must share a (years, cells) shape: {src.shape} {aqua.shape} {cls.shape}")
    ok = np.isfinite(src) & np.isfinite(aqua)
    n_ok = int(ok.sum())
    if n_ok < max(10, min_points):
        raise RuntimeError(f"night calibration has only {n_ok} valid (cell, year) pairs")
    pooled = _s04_ols(src[ok], aqua[ok])
    coef, by_class, pooled_classes, cells_per_class = {0: pooled}, [], [], {}
    pred = np.full(src.shape, np.nan)
    unknown = ok & ((cls < 1) | (cls > 6))
    pred[unknown] = pooled[0] + pooled[1] * src[unknown]
    for c in range(1, 7):
        sel = ok & (cls == c)
        n_c = int(sel.sum())
        cells_c = int(sel.any(axis=0).sum())
        cells_per_class[int(c)] = cells_c
        spread = float(np.ptp(src[sel])) if n_c else 0.0
        if n_c >= min_points and cells_c >= int(min_cells) and spread > 1e-6:
            a, b = _s04_ols(src[sel], aqua[sel])
        else:
            a, b = pooled
            pooled_classes.append(c)
        coef[c] = (float(a), float(b))
        by_class.append({"class": int(c), "a": round(float(a), 4), "b": round(float(b), 4), "n": n_c})
        pred[sel] = a + b * src[sel]
    resid = np.where(ok, aqua - pred, np.nan)
    sse = float(np.nansum(resid ** 2))
    sst = float(((aqua[ok] - aqua[ok].mean()) ** 2).sum())
    n_years = ok.sum(axis=0)
    mean_resid = np.where(n_years > 0, np.nansum(resid, axis=0) / np.maximum(n_years, 1), 0.0)
    shrunk = (mean_resid * n_years / (n_years + float(shrink_k))).astype(np.float32)
    resid2 = np.where(ok, resid - shrunk[None, :], np.nan)
    summary = {"r2": round(1.0 - sse / sst, 4) if sst > 0 else None,
               "rmse": round(float(np.sqrt(sse / n_ok)), 4), "n": n_ok, "by_class": by_class}
    info = {"pooled_classes": pooled_classes, "cells_per_class": cells_per_class,
            "n_years_per_cell": n_years.astype(np.int32),
            "r2_with_residual": round(1.0 - float(np.nansum(resid2 ** 2)) / sst, 4) if sst > 0 else None}
    return summary, coef, shrunk, info


def _s04_apply_calibration(src: np.ndarray, cls: np.ndarray, coef: dict, shrunk: Optional[np.ndarray]) -> np.ndarray:
    """Aqua-equivalent values ``a_c + b_c·src (+ shrunk residual)``; classes without a map use the pooled map."""
    src = np.asarray(src, np.float64)
    cls = np.asarray(cls)
    a0, b0 = coef[0]
    a = np.full(src.shape, a0, np.float64)
    b = np.full(src.shape, b0, np.float64)
    for c, (ac, bc) in coef.items():
        if c == 0:
            continue
        a = np.where(cls == c, ac, a)
        b = np.where(cls == c, bc, b)
    out = a + b * src
    if shrunk is not None:
        out = out + np.asarray(shrunk, np.float64)
    return out.astype(np.float32)


def _s04_loyo_rmse(src: np.ndarray, aqua: np.ndarray, cls: np.ndarray) -> dict:
    """Leave-one-year-out transfer error of the calibration (class map only, and class map + shrunk residual)."""
    years = src.shape[0]
    err_cls, err_full = [], []
    for t in range(years):
        keep = np.arange(years) != t
        ok_t = np.isfinite(src[t]) & np.isfinite(aqua[t])
        if ok_t.sum() < 10 or keep.sum() < 2:
            continue
        try:
            _, coef, shrunk, _ = _s04_fit_calibration(src[keep], aqua[keep], cls[keep])
        except RuntimeError:
            continue
        p_cls = _s04_apply_calibration(src[t], cls[t], coef, None)
        p_full = _s04_apply_calibration(src[t], cls[t], coef, shrunk)
        err_cls.append((p_cls - aqua[t])[ok_t])
        err_full.append((p_full - aqua[t])[ok_t])
    if not err_cls:
        return {"loyo_rmse_class_map": None, "loyo_rmse_with_residual": None, "loyo_years": 0}
    e1, e2 = np.concatenate(err_cls), np.concatenate(err_full)
    return {"loyo_rmse_class_map": round(float(np.sqrt(np.mean(e1 ** 2))), 4),
            "loyo_rmse_with_residual": round(float(np.sqrt(np.mean(e2 ** 2))), 4),
            "loyo_bias_with_residual": round(float(np.mean(e2)), 4), "loyo_years": len(err_cls)}


def _s04_scope_means(values: np.ndarray, district: np.ndarray, n_districts: int,
                     min_coverage: float = _S04_SCOPE_MIN_COVERAGE) -> dict:
    """{"ncr": mean, "d:<id>": mean} of a canonical cell vector.

    A scope is reported only if at least ``min_coverage`` of its cells are finite (a heavily clouded year would
    otherwise give a biased mean of the remaining cells). Districts without cells are omitted.
    """
    values = np.asarray(values, np.float64)
    district = np.asarray(district, np.int64)
    ok = np.isfinite(values)
    out = {}
    if ok.mean() >= min_coverage:
        out["ncr"] = float(values[ok].mean())
    sums = np.bincount(district[ok], weights=values[ok], minlength=n_districts)
    counts = np.bincount(district[ok], minlength=n_districts)
    totals = np.bincount(district, minlength=n_districts)
    for d in range(n_districts):
        if totals[d] > 0 and counts[d] >= min_coverage * totals[d] and counts[d] > 0:
            out[f"d:{d}"] = float(sums[d] / counts[d])
    return out


def _s04_nearest_anchor(year: int, anchors: Sequence[int]) -> int:
    """Nearest land-cover anchor year (ties -> the later anchor); years after the last map use the last map."""
    year = min(int(year), max(anchors))
    return min(anchors, key=lambda a: (abs(a - year), -a))


def _s04_view_time_to_ist(t_h: Optional[float], expected: str, lon_c: float) -> tuple:
    """Interpret a mean view time (h) and convert it to IST hours.

    MODIS ``*_view_time`` is local solar time; for VIIRS the catalog only says "h", so both interpretations (local
    solar time, UTC) are tried and the one inside the plausible window of the pass is kept:
    night passes after midnight (Aqua/VIIRS) 0-6 h IST, Terra's evening pass 19-24 h IST. Returns
    ``(ist_hours or None, how)``.
    """
    if t_h is None or not np.isfinite(t_h):
        return None, "no view time"
    windows = {"after_midnight": (0.0, 6.0), "evening": (19.0, 24.0)}
    lo, hi = windows[expected]
    candidates = [("local solar time", (t_h + 5.5 - lon_c / 15.0) % 24.0), ("UTC", (t_h + 5.5) % 24.0)]
    for how, ist in candidates:
        if lo <= ist <= hi:
            return round(float(ist), 3), how
    return None, f"implausible view time {t_h:.2f} h"

# %% [markdown]
# ## 4.3 Server-side product builders (MODIS 8-day, VIIRS daily, ERA5-Land, GLC_FCS30D)
# Each builder returns a lazy `ee.Image`/`ee.ImageCollection`; nothing is computed until a fetch or a batched
# `getInfo`. MODIS/VIIRS images are masked with QC (and the view-time window for the Terra day product), composited
# per pixel (median, plus the valid count) in their native sinusoidal projection and aggregated to the 1 km grid with
# the mask-aware mean. The GLC_FCS30D class fractions use the **two-step** `reduceResolution` of SPEC §2.3:
# 30 m class indicators → fine grid (250 m) → analysis grid (1 km); each step stays far below the `maxPixels` limit
# and keeps the area weighting exact on the nested grids.

# %%
def _s04_modis_col(collection_id: str, which: str, y0: int, y1: int, view_window: Optional[tuple] = None):
    """QC-masked MOD11A2/MYD11A2 8-day LST (°C, band ``lst``) and view time (h local solar, band ``vtime``)."""
    lst_band, qc_band, vt_band = f"LST_{which}_1km", f"QC_{which}", f"{which}_view_time"

    def _prep(img):
        qc = img.select(qc_band)
        good = qc.bitwiseAnd(3).lte(1).And(qc.rightShift(6).bitwiseAnd(3).lte(1))   # mandatory QA <= 1, err <= 2 K
        vtime = img.select(vt_band).multiply(0.1)
        if view_window is not None:
            good = good.And(vtime.gte(float(view_window[0]))).And(vtime.lte(float(view_window[1])))
        lst = img.select(lst_band).multiply(0.02).subtract(273.15)
        # Plain float32 bands: the scaled integer bands carry a bounded type (Float<-273.15, 1037.55>), and Earth
        # Engine refuses to reduce a collection mixing them with the plain-float masked dummy of _s04_composite.
        return (lst.rename("lst").addBands(vtime.rename("vtime")).toFloat().updateMask(good)
                .set("system:time_start", img.get("system:time_start")))

    start, end = _s04_years_dates(y0, y1)
    return ee.ImageCollection(collection_id).filterDate(start, end).filter(_s04_season_filter()).map(_prep)


def _s04_viirs_col(y0: int, y1: int, lst_scale: float, vt_scale: float):
    """QC-masked VNP21A1N daily night LST (°C, ``lst``) and view time (h, ``vtime``) with run-time scales."""
    def _prep(img):
        qc = img.select("QC")
        good = qc.bitwiseAnd(3).lte(1).And(qc.rightShift(14).bitwiseAnd(3).gte(2))   # LST accuracy <= 1.5 K
        lst = img.select("LST_1KM").multiply(float(lst_scale)).subtract(273.15)
        vtime = img.select("View_Time").multiply(float(vt_scale))
        return (lst.rename("lst").addBands(vtime.rename("vtime")).toFloat().updateMask(good)
                .set("system:time_start", img.get("system:time_start")))

    start, end = _s04_years_dates(y0, y1)
    return ee.ImageCollection(_S04_VIIRS_N).filterDate(start, end).filter(_s04_season_filter()).map(_prep)


def _s04_composite(col, native, grid: GridSpec, min_n: int = 1) -> tuple:
    """Per-pixel median (masked where fewer than ``min_n`` valid values) and valid count, both on ``grid``."""
    # Every image float32 (as the dummy): a collection mixing band types cannot be reduced.
    lst = (col.select("lst").map(lambda im: ee.Image(im).toFloat())
           .merge(ee.ImageCollection([_s04_masked_dummy("lst")])))
    count = lst.count()
    median = lst.median().updateMask(count.gte(int(min_n))).setDefaultProjection(native)
    count = count.unmask(0).toFloat().setDefaultProjection(native)
    return (_s04_to_grid(median, _S04_MODIS_SCALE_M, grid), _s04_to_grid(count, _S04_MODIS_SCALE_M, grid))


def _s04_viirs_scales() -> dict:
    """Run-time check of the VNP21A1N ``LST_1KM`` and ``View_Time`` scales (SPEC §2.2; catalog leaves them open).

    One batched request: the ROI median of the Apr-Jun 2020 per-pixel median of the raw bands. LST values > 1000 are
    digital numbers (× 0.02 K); View_Time > 24 is in 0.1 h. The scaled LST must be a plausible night temperature.
    """
    start, end = _s04_season_dates(2020)
    raw = (ee.ImageCollection(_S04_VIIRS_N).filterDate(start, end).select(["LST_1KM", "View_Time"]).median())
    probe = raw.reduceRegion(reducer=ee.Reducer.median(), geometry=grid_ee_geom(GRID), scale=5000,
                             bestEffort=True, maxPixels=int(1e9))
    info = _s04_getinfo(probe, "VIIRS scale probe") or {}
    lst_raw, vt_raw = info.get("LST_1KM"), info.get("View_Time")
    if lst_raw is None:
        raise RuntimeError("VIIRS VNP21A1N scale probe returned no LST over the ROI (Apr-Jun 2020)")
    lst_scale = 0.02 if float(lst_raw) > 1000 else 1.0
    kelvin = float(lst_raw) * lst_scale
    if not 250.0 <= kelvin <= 340.0:
        raise RuntimeError(f"VIIRS LST_1KM scale check failed: raw {lst_raw} x {lst_scale} = {kelvin:.1f} K")
    vt_scale = 0.1 if (vt_raw is not None and float(vt_raw) > 24.0) else 1.0
    log(f"VIIRS VNP21A1N run-time scales: LST_1KM raw median {float(lst_raw):.2f} -> x{lst_scale} "
        f"({kelvin - 273.15:.1f} °C); View_Time raw {vt_raw} -> x{vt_scale}")
    return {"lst_scale": lst_scale, "vt_scale": vt_scale, "lst_raw_median": float(lst_raw),
            "vt_raw_median": None if vt_raw is None else float(vt_raw)}


@_s04_dataclass(frozen=True)
class _S04NightPlan:
    """Night product chosen for one observation frame."""

    year: int
    source: Optional[str]       # "aqua" | "terra_cal" | "viirs_cal" | None
    y0: int
    y1: int


def _s04_night_plan(year: int) -> _S04NightPlan:
    """Choose the night product of a frame from its window (SPEC §1.2/§2.2).

    * windows reaching the drift years (≥ 2022) use VIIRS (calibrated); Aqua drifted to ~03:20 IST by 2025;
    * windows inside 2003–2021 use Aqua (years before 2003 dropped: first full Aqua season is 2003);
    * windows ending 2000–2002 use Terra night (calibrated) from 2000;
    * earlier windows have no night product (modelled by section 09).
    """
    y0, y1 = (int(v) for v in CFG.window(year))
    if y1 >= _S04_DRIFT_FROM:
        return _S04NightPlan(int(year), "viirs_cal", max(y0, _S04_VIIRS_FIRST), y1)
    if y1 >= _S04_AQUA_FIRST:
        return _S04NightPlan(int(year), "aqua", max(y0, _S04_AQUA_FIRST), y1)
    if y1 >= _S04_TERRA_FIRST:
        return _S04NightPlan(int(year), "terra_cal", max(y0, _S04_TERRA_FIRST), y1)
    return _S04NightPlan(int(year), None, y0, y1)


def _s04_night_col(plan: _S04NightPlan, viirs: dict):
    """Masked night collection of a plan (``None`` source -> None)."""
    if plan.source == "aqua":
        return _s04_modis_col(_S04_AQUA, "Night", plan.y0, plan.y1)
    if plan.source == "terra_cal":
        return _s04_modis_col(_S04_TERRA, "Night", plan.y0, plan.y1)
    if plan.source == "viirs_cal":
        return _s04_viirs_col(plan.y0, plan.y1, viirs["lst_scale"], viirs["vt_scale"])
    return None


def _s04_native_of(source: str):
    return {"aqua": lambda: _s04_native(_S04_AQUA, "LST_Night_1km"),
            "terra_cal": lambda: _s04_native(_S04_TERRA, "LST_Night_1km"),
            "terra": lambda: _s04_native(_S04_TERRA, "LST_Night_1km"),
            "terra_day": lambda: _s04_native(_S04_TERRA, "LST_Day_1km"),
            "viirs_cal": lambda: _s04_native(_S04_VIIRS_N, "LST_1KM"),
            "viirs": lambda: _s04_native(_S04_VIIRS_N, "LST_1KM")}[source]()


def _s04_annual_stack(kind: str, years: Sequence[int], viirs: dict):
    """One band per year (``y<year>``): Apr-Jun per-pixel median of a product at 1 km on GRID.

    ``kind``: "aqua_night" | "terra_night" | "viirs_night" | "terra_day" (QC + view-time window).
    """
    bands = []
    for y in years:
        if kind == "aqua_night":
            col = _s04_modis_col(_S04_AQUA, "Night", y, y)
            native, min_n = _s04_native_of("aqua"), _S04_ANNUAL_MIN_N["modis_night"]
        elif kind == "terra_night":
            col = _s04_modis_col(_S04_TERRA, "Night", y, y)
            native, min_n = _s04_native_of("terra"), _S04_ANNUAL_MIN_N["modis_night"]
        elif kind == "terra_day":
            col = _s04_modis_col(_S04_TERRA, "Day", y, y, _S04_DAY_VIEW_WINDOW_H)
            native, min_n = _s04_native_of("terra_day"), _S04_ANNUAL_MIN_N["modis"]
        elif kind == "viirs_night":
            col = _s04_viirs_col(y, y, viirs["lst_scale"], viirs["vt_scale"])
            native, min_n = _s04_native_of("viirs"), _S04_ANNUAL_MIN_N["viirs"]
        else:
            raise ValueError(f"unknown annual stack kind {kind!r}")
        median, _ = _s04_composite(col, native, GRID, min_n=min_n)
        bands.append(median.rename(f"y{int(y)}"))
    names = [f"y{int(y)}" for y in years]
    return ee.Image.cat(bands).unmask(NODATA_FLOAT).toFloat(), names


def _s04_era5_annual_image(variable: str, years: Sequence[int]):
    """ERA5-Land annual Apr-Jun means (one band ``y<year>`` per year), bilinear at the reduction scale.

    * ``era5_skin_day`` / ``era5_skin_night``: HOURLY ``skin_temperature`` at 05 / 20 UTC (10:30 / 01:30 IST), °C;
    * ``era5_tmax`` / ``era5_tmin``: DAILY_AGGR ``temperature_2m_max`` / ``_min``, mean of the daily values, °C;
    * ``era5_swvl1``: MONTHLY_AGGR ``volumetric_soil_water_layer_1`` (m³ m⁻³), mean of the Apr-Jun months.
    """
    if variable in _S04_ERA5_HOURS_UTC:
        coll_id, band, offset = _S04_ERA5_HOURLY, "skin_temperature", -273.15
        hour = _S04_ERA5_HOURS_UTC[variable]
    elif variable in ("era5_tmax", "era5_tmin"):
        coll_id, band, offset, hour = _S04_ERA5_DAILY, f"temperature_2m_{variable[-3:]}", -273.15, None
    elif variable == "era5_swvl1":
        coll_id, band, offset, hour = _S04_ERA5_MONTHLY, "volumetric_soil_water_layer_1", 0.0, None
    else:
        raise ValueError(f"unknown ERA5 annual variable {variable!r}")
    native = _s04_native(coll_id, band)
    bands = []
    for y in years:
        start, end = _s04_season_dates(y)
        col = ee.ImageCollection(coll_id).filterDate(start, end).select(band)
        if hour is not None:
            col = col.filter(ee.Filter.calendarRange(int(hour), int(hour), "hour"))
        img = col.mean().add(float(offset)).setDefaultProjection(native).resample("bilinear")
        bands.append(img.rename(f"y{int(y)}"))
    return ee.Image.cat(bands)


def _s04_scopes_fc():
    """NCR (did = -1) + one dissolved feature per district (``did``) as an ee.FeatureCollection.

    The NCR feature is the union of the ROI cells (``gee_roi_geometry``), not ``EE_ROI``: that one evaluates to an empty
    geometry on real data, so its reduction returned null and the annual series had no NCR row for any ERA5 variable.
    """
    ncr = ee.FeatureCollection([ee.Feature(gee_roi_geometry(0), {"did": -1})])
    return ee.FeatureCollection(EE_DISTRICTS).merge(ncr)


def _s04_glc_band_lists() -> dict:
    """Band names of the GLC_FCS30D collections (one batched request, memoised)."""
    memo = globals().get("_S04_GLC_BANDLISTS")
    if memo:
        return memo
    geom = grid_ee_geom(GRID)
    req = ee.Dictionary({
        "annual": ee.Image(ee.ImageCollection(_S04_GLC_ANNUAL).filterBounds(geom).first()).bandNames(),
        "five": ee.Image(ee.ImageCollection(_S04_GLC_FIVE).filterBounds(geom).first()).bandNames(),
    })
    info = _s04_getinfo(req, "GLC_FCS30D band lists") or {}
    out = {"annual": list(info.get("annual") or []), "five": list(info.get("five") or [])}
    if not out["annual"]:
        raise RuntimeError(f"GLC_FCS30D annual collection has no tiles over the ROI ({_S04_GLC_ANNUAL})")
    if len(out["annual"]) != 23:
        log(f"GLC_FCS30D annual tiles expose {len(out['annual'])} bands (expected 23 for 2000-2022)", "WARNING")
    globals()["_S04_GLC_BANDLISTS"] = out
    return out


def _s04_glc_band(year: int) -> tuple:
    """(collection id, band, map year) of GLC_FCS30D for a frame/anchor year (SPEC §2.3).

    1990 -> five-years-map b2, 1995 -> b3 (1985 b1); 2000..2022 -> annual b<year-1999>; later years -> the 2022 map
    (b23). Years before 2000 that are not 1985/1990/1995 use the nearest five-year map.
    """
    lists = _s04_glc_band_lists()
    year = int(year)
    if year < 2000:
        map_year = min(_S04_GLC_FIVE_BANDS, key=lambda y: (abs(y - year), -y))
        band = _S04_GLC_FIVE_BANDS[map_year]
        if band not in lists["five"]:
            raise RuntimeError(f"GLC_FCS30D five-years-map lacks band {band} (has {lists['five']})")
        return _S04_GLC_FIVE, band, map_year
    map_year = min(year, _S04_GLC_LAST_YEAR, 1999 + len(lists["annual"]))
    band = f"b{map_year - 1999}"
    if band not in lists["annual"]:
        band = lists["annual"][min(map_year - 2000, len(lists["annual"]) - 1)]
    return _S04_GLC_ANNUAL, band, map_year


def _s04_glc_classes(collection_id: str, band: str):
    """Harmonised classes (0 nodata, 1..6) of one GLC_FCS30D band, in the tiles' native 30 m projection."""
    geom = grid_ee_geom(GRID)
    col = ee.ImageCollection(collection_id).filterBounds(geom)
    native = ee.Image(col.first()).select(band).projection()
    table = LC_REMAPS["glc_fcs30d"]
    classes = (col.select(band).mosaic().remap(list(table.keys()), list(table.values()), 0)
               .rename("lc").setDefaultProjection(native))
    return classes, native


def _s04_glc_fraction_image(collection_id: str, band: str):
    """Six class fractions + valid share on GRID via the two-step reduceResolution (30 m -> fine -> 1 km)."""
    classes, native = _s04_glc_classes(collection_id, band)
    valid = classes.gt(0)
    indicators = (ee.Image.cat([classes.eq(c).rename(k) for c, k in zip(range(1, 7), _S04_GLC_KEYS)])
                  .toFloat().updateMask(valid).setDefaultProjection(native))
    valid_f = valid.unmask(0).toFloat().rename("glc_valid").setDefaultProjection(native)
    stack = ee.Image.cat([indicators, valid_f])
    step1 = _s04_to_grid(stack, _S04_GLC_SCALE_M, GRID_FINE)          # 30 m -> 250 m (fine grid)
    step2 = _s04_to_grid(step1, float(GRID_FINE.res), GRID)            # 250 m -> 1 km
    return step2.unmask(NODATA_FLOAT).toFloat()


def _s04_glc_normalise(raw: np.ndarray, label: str) -> dict:
    """(7, H, W) fetched fractions + valid share -> {glc_key: (H, W) float32}, summing to 1 in the ROI.

    Fractions are renormalised over the six classes (the mean over valid 30 m pixels already excludes nodata);
    ROI cells without any classified pixel take the fractions of the nearest classified cell.
    """
    fr = np.asarray(raw[:6], np.float64)
    total = np.nansum(np.where(np.isfinite(fr), np.clip(fr, 0.0, None), 0.0), axis=0)
    good = (total > 1e-6) & ROI_MASK
    fr = np.where(good[None], np.clip(np.nan_to_num(fr, nan=0.0), 0.0, None) / np.where(good, total, 1.0)[None],
                  np.nan)
    out = {}
    if (ROI_MASK & ~good).any():
        if not good.any():
            raise RuntimeError(f"{label}: no classified GLC_FCS30D pixel inside the ROI")
        _, (ir, ic) = _s04_ndi.distance_transform_edt(~good, return_indices=True)
        holes = ROI_MASK & ~good
        fr[:, holes] = fr[:, ir[holes], ic[holes]]
        log(f"  {label}: {int(holes.sum()):,} ROI cells without GLC classes filled from the nearest cell", "WARNING")
    for i, key in enumerate(_S04_GLC_KEYS):
        arr = fr[i].astype(np.float32)
        arr[~ROI_MASK] = np.nan
        out[key] = arr
    return out


def _s04_glc_fractions(year: int) -> dict:
    """Normalised GLC_FCS30D fractions on GRID for a frame/anchor year (memoised; tile cache shared with 05).

    Returns ``{"fractions": {glc_key: (H,W)}, "dominant": (H,W) uint8, "band": str, "collection": str,
    "map_year": int}``.
    """
    coll, band, map_year = _s04_glc_band(year)
    memo = globals().setdefault("_S04_GLC_MEMO", {})
    key = (coll, band, GRID.res, _s04_roi_digest())
    if key not in memo:
        image = _s04_glc_fraction_image(coll, band)
        names = _S04_GLC_KEYS + ["glc_valid"]
        with timer(f"04/05 GLC fractions {band} ({map_year})"):
            raw = _s04_fetch(image, GRID, names, f"glc_frac_{coll.rsplit('/', 1)[-1]}_{band}", heavy=True)
        fractions = _s04_glc_normalise(raw, f"GLC {map_year}")
        stack = np.stack([np.nan_to_num(fractions[k], nan=-1.0) for k in _S04_GLC_KEYS])
        dominant = (np.argmax(stack, axis=0) + 1).astype(np.uint8)
        dominant[~ROI_MASK] = 0
        memo[key] = {"fractions": fractions, "dominant": dominant, "band": band, "collection": coll,
                     "map_year": int(map_year)}
        del raw, stack
    return memo[key]

# %% [markdown]
# ## 4.4 Night frames, MODIS day validation and the overlap calibrations
# Order of work (all requests batched):
# 1. VIIRS scale probe (one request) → VIIRS collections with the right scale.
# 2. Frame composites: one 1 km fetch per frame with `night_raw`, `night_nobs`, `day_modis`; frame metadata
#    (composite counts, ROI mean view time per frame) in **one** `getInfo`.
# 3. Annual Apr–Jun medians at 1 km (Aqua night 2003–2025, Terra night 2003–2019, VIIRS night 2012–2025, Terra day
#    2000–2025 with the view-time filter) — four multi-band fetches (asset-exported in `asset` mode).
# 4. Dominant GLC class at the anchor years 2000/2005/2010/2015/2020/2022; each overlap year uses its nearest anchor.
# 5. Fit Terra→Aqua and VIIRS→Aqua, apply them to the 2000/2025 frame composites and the VIIRS annual fields.

# %%
def _s04_frame_requests(plans: dict, viirs: Optional[dict]) -> tuple:
    """Per-frame fetch jobs and the batched metadata request."""
    jobs, meta_req = [], {}
    for year, plan in plans.items():
        bands, names = [], []
        y0, y1 = (int(v) for v in CFG.window(year))
        col = _s04_night_col(plan, viirs) if plan.source else None
        if col is not None:
            median, count = _s04_composite(col, _s04_native_of(plan.source), GRID, min_n=1)
            bands += [median.rename("night_raw"), count.rename("night_nobs")]
            names += ["night_raw", "night_nobs"]
            vt = col.select("vtime").mean().reduceRegion(
                reducer=ee.Reducer.mean(), geometry=grid_ee_geom(GRID), scale=5000, bestEffort=True,
                maxPixels=int(1e9)).get("vtime")
            meta_req[str(year)] = ee.Dictionary({"n": col.size(), "vtime": vt})
        if y1 >= _S04_TERRA_FIRST:
            day = _s04_modis_col(_S04_TERRA, "Day", max(y0, _S04_TERRA_FIRST), y1, _S04_DAY_VIEW_WINDOW_H)
            median, _ = _s04_composite(day, _s04_native_of("terra_day"), GRID, min_n=1)
            bands.append(median.rename("day_modis"))
            names.append("day_modis")
        if bands:
            jobs.append({"name": f"s04_frame{year}", "image": ee.Image.cat(bands).unmask(NODATA_FLOAT).toFloat(),
                         "grid": GRID, "bands": names, "dtype": np.float32, "year": year})
    return jobs, meta_req


def _s04_annual_requests(viirs: dict) -> tuple:
    """Fetch jobs of the four annual stacks and their year lists."""
    last = int(_S04_SERIES_YEARS[1])
    years = {
        "aqua_night": list(range(_S04_AQUA_FIRST, last + 1)),
        "terra_night": list(range(_S04_CAL_YEARS["terra_to_aqua"][0], _S04_CAL_YEARS["terra_to_aqua"][1] + 1)),
        "viirs_night": list(range(_S04_VIIRS_FIRST, last + 1)),
        "terra_day": list(range(_S04_TERRA_FIRST, last + 1)),
    }
    jobs = []
    for kind, ys in years.items():
        image, names = _s04_annual_stack(kind, ys, viirs)
        jobs.append({"name": f"s04_annual_{kind}", "image": image, "grid": GRID, "bands": names,
                     "dtype": np.float32})
    return jobs, years


def _s04_class_matrix(years: Sequence[int], dominant: dict) -> np.ndarray:
    """(years, cells) dominant class using the nearest land-cover anchor of each year."""
    anchors = sorted(dominant)
    return np.stack([dominant[_s04_nearest_anchor(y, anchors)][CELL_ROWS, CELL_COLS] for y in years])


def _s04_calibrate(kind: str, src_ann: dict, aqua_ann: dict, dominant: dict) -> dict:
    """Fit one calibration on the overlap years present in both annual stacks."""
    y0, y1 = _S04_CAL_YEARS[kind]
    years = [y for y in range(y0, y1 + 1) if y in src_ann and y in aqua_ann]
    if len(years) < 3:
        raise RuntimeError(f"{kind}: only {len(years)} overlap years available ({years})")
    src = np.stack([_s04_cells(src_ann[y]) for y in years])
    aqua = np.stack([_s04_cells(aqua_ann[y]) for y in years])
    cls = _s04_class_matrix(years, dominant)
    summary, coef, shrunk, info = _s04_fit_calibration(src, aqua, cls)
    loyo = _s04_loyo_rmse(src, aqua, cls)
    diag = {"years": [int(years[0]), int(years[-1])], "n_years": len(years),
            "pooled_classes": info["pooled_classes"], "cells_per_class": dict(info["cells_per_class"]),
            "min_cells_per_class": int(_S04_CAL_MIN_CELLS), "r2_with_residual": info["r2_with_residual"],
            "cells_with_residual": int((info["n_years_per_cell"] > 0).sum()),
            "mean_abs_shrunk_residual": round(float(np.mean(np.abs(shrunk))), 4), **loyo}
    log(f"{kind}: R2 {summary['r2']} RMSE {summary['rmse']} °C n {summary['n']:,} (years {years[0]}-{years[-1]}); "
        f"LOYO RMSE class map {loyo['loyo_rmse_class_map']} -> with shrunk residual "
        f"{loyo['loyo_rmse_with_residual']} °C; pooled classes {info['pooled_classes'] or 'none'}")
    for row in summary["by_class"]:
        log(f"    class {row['class']} ({LC_CLASS_NAMES[row['class']]}): aqua = {row['a']:+.3f} + "
            f"{row['b']:.4f} x src  (n {row['n']:,}, {info['cells_per_class'].get(row['class'], 0):,} cells"
            f"{', pooled map' if row['class'] in info['pooled_classes'] else ''})")
    return {"summary": summary, "coef": coef, "shrunk": shrunk, "diag": diag}


def _s04_overpass(plan: _S04NightPlan, meta: dict, lon_c: float) -> tuple:
    """Measured mean overpass (IST h) of a frame's night product, nominal value as fallback."""
    entry = meta.get(str(plan.year)) or {}
    expected = "evening" if plan.source == "terra_cal" else "after_midnight"
    ist, how = _s04_view_time_to_ist(entry.get("vtime"), expected, lon_c)
    nominal = _S04_NOMINAL_IST_H["terra" if plan.source == "terra_cal" else
                                 "viirs" if plan.source == "viirs_cal" else "aqua"]
    if ist is None:
        log(f"night {plan.year}: overpass from view time unavailable ({how}); using nominal {nominal:.2f} h IST",
            "WARNING")
        return nominal, f"nominal ({how})"
    return ist, f"ROI mean view time ({how})"


def _s04_build_thermal() -> dict:
    """Compute every product of section 04 (the stage-cached unit)."""
    frames = [int(y) for y in CFG.FRAMES_OBS]
    plans = {y: _s04_night_plan(y) for y in frames}
    bounds = GRID.bounds_lonlat()
    lon_c = 0.5 * (bounds[0] + bounds[2])
    caveats, sources = [], {"lst_night": {}, "lst_night_nobs": {}, "lst_day_modis": {}}
    log("night plan: " + ", ".join(f"{y}: {p.source or 'none'} {p.y0}-{p.y1}" if p.source else f"{y}: none"
                                   for y, p in plans.items()))

    with timer("04 VIIRS scale probe"):
        viirs = _s04_viirs_scales()

    # ---- frame composites + metadata ------------------------------------------------------------------------
    jobs, meta_req = _s04_frame_requests(plans, viirs)
    meta = _s04_getinfo(ee.Dictionary(meta_req), "night frame metadata") if meta_req else {}
    fetched = _s04_fetch_jobs(jobs, use_assets=False)
    raw = {job["year"]: {b: fetched[job["name"]][i] for i, b in enumerate(job["bands"])} for job in jobs}
    del fetched

    # ---- annual stacks for calibration and series -------------------------------------------------------------
    ann_jobs, ann_years = _s04_annual_requests(viirs)
    ann_fetched = _s04_fetch_jobs(ann_jobs, use_assets=True)
    annual = {}
    for job in ann_jobs:
        kind = job["name"].replace("s04_annual_", "")
        stack = ann_fetched.pop(job["name"])
        annual[kind] = {int(b[1:]): np.where(ROI_MASK, stack[i], np.nan).astype(np.float32)
                        for i, b in enumerate(job["bands"])}
        del stack
    free_memory()

    # ---- dominant land-cover class at the anchor years ----------------------------------------------------------
    dominant = {}
    for anchor in _S04_GLC_ANCHORS:
        glc = _s04_glc_fractions(anchor)
        dominant[int(anchor)] = glc["dominant"]
    log("dominant GLC class shares at the anchors: " + "; ".join(
        f"{a}: " + "/".join(f"{100 * np.mean(dominant[a][ROI_MASK] == c):.0f}" for c in range(1, 7))
        for a in sorted(dominant)) + " (% built/forest/water/crop/barren/otherveg)")

    # ---- calibrations ----------------------------------------------------------------------------------------
    calib = {"terra_to_aqua": _s04_calibrate("terra_to_aqua", annual["terra_night"], annual["aqua_night"], dominant),
             "viirs_to_aqua": _s04_calibrate("viirs_to_aqua", annual["viirs_night"], annual["aqua_night"], dominant)}

    # ---- frame products ------------------------------------------------------------------------------------
    out_frames, night_meta = {}, {}
    roi_n = int(ROI_MASK.sum())
    for year in frames:
        plan = plans[year]
        r = raw.get(year, {})
        night = np.full(GRID.shape, np.nan, np.float32)
        nobs = np.where(ROI_MASK, 0.0, np.nan).astype(np.float32)
        if plan.source is not None and "night_raw" in r:
            src = np.where(ROI_MASK, r["night_raw"], np.nan)
            nobs = np.where(ROI_MASK, np.nan_to_num(r["night_nobs"], nan=0.0), np.nan).astype(np.float32)
            if plan.source == "aqua":
                night = src.astype(np.float32)
            else:
                kind = "terra_to_aqua" if plan.source == "terra_cal" else "viirs_to_aqua"
                cls = dominant[_s04_nearest_anchor(year, sorted(dominant))][CELL_ROWS, CELL_COLS]
                c = calib[kind]
                vals = _s04_apply_calibration(_s04_cells(src), cls, c["coef"], c["shrunk"])
                night = _s04_grid_from_cells(vals)
                night[~np.isfinite(src)] = np.nan
            night[~ROI_MASK] = np.nan
        day_modis = (np.where(ROI_MASK, r["day_modis"], np.nan).astype(np.float32) if "day_modis" in r
                     else np.full(GRID.shape, np.nan, np.float32))
        coverage = float(np.isfinite(night[ROI_MASK]).sum() / max(1, roi_n))
        if plan.source is not None and coverage == 0.0:
            log(f"night {year}: {plan.source} composite is empty over the ROI - treated as no product", "WARNING")
            caveats.append(f"The {year} night frame has no valid {plan.source} composite; it is modelled instead.")
            plan = _S04NightPlan(year, None, plan.y0, plan.y1)
            plans[year] = plan
            nobs = np.where(ROI_MASK, 0.0, np.nan).astype(np.float32)
        if plan.source is not None:
            ist, how = _s04_overpass(plan, meta, lon_c)
            n_comp = int((meta.get(str(year)) or {}).get("n") or 0)
            night_meta[year] = {"source": plan.source, "sensor": _S04_NIGHT_SENSOR[plan.source],
                                "overpass_ist_h": float(ist), "composites": n_comp, "coverage": round(coverage, 4)}
            unit = "daily observations" if plan.source == "viirs_cal" else "8-day composites"
            cal_txt = ""
            if plan.source != "aqua":
                kind = "terra_to_aqua" if plan.source == "terra_cal" else "viirs_to_aqua"
                cal_txt = (f"; calibrated to Aqua ({kind}: per-class OLS on annual Apr-Jun medians "
                           f"{_S04_CAL_YEARS[kind][0]}-{_S04_CAL_YEARS[kind][1]} + per-cell residual x n/(n+3); "
                           f"LOYO RMSE {calib[kind]['diag']['loyo_rmse_with_residual']} °C)")
            coll = {"aqua": _S04_AQUA, "terra_cal": _S04_TERRA, "viirs_cal": _S04_VIIRS_N}[plan.source]
            qc = ("QC mandatory<=1 & LST accuracy>=2 (<=1.5 K), LST_1KM x" + str(viirs["lst_scale"])
                  if plan.source == "viirs_cal" else "QC_Night bits0-1<=1 & bits6-7<=1, x0.02 K")
            sources["lst_night"][year] = (f"{coll} {plan.y0}-{plan.y1} {CFG.SEASON[0]}..{CFG.SEASON[1]}, {qc}, "
                                          f"per-pixel median, mean-aggregated to {GRID.res} m{cal_txt}; overpass "
                                          f"{ist:.2f} h IST ({how})")
            sources["lst_night_nobs"][year] = f"{coll} count of QC-valid {unit} per pixel, mean to {GRID.res} m"
            if n_comp < 1:
                log(f"night {year}: composite count unavailable from the metadata request", "WARNING")
        else:
            night_meta[year] = {"source": None, "sensor": None, "overpass_ist_h": None, "composites": 0,
                                "coverage": 0.0}
            sources["lst_night"][year] = "no night satellite product for this window (modelled by section 09)"
            sources["lst_night_nobs"][year] = "0 (no night product)"
        y0, y1 = (int(v) for v in CFG.window(year))
        if "day_modis" in r:
            drift = " [drift years included: flagged]" if y1 >= _S04_DRIFT_FROM else ""
            sources["lst_day_modis"][year] = (f"{_S04_TERRA} LST_Day_1km {max(y0, _S04_TERRA_FIRST)}-{y1} Apr-Jun, "
                                              f"QC_Day bits0-1<=1 & bits6-7<=1, Day_view_time x0.1 in "
                                              f"{_S04_DAY_VIEW_WINDOW_H[0]}-{_S04_DAY_VIEW_WINDOW_H[1]} h local "
                                              f"solar time, per-pixel median, mean to {GRID.res} m{drift}")
            if y1 >= _S04_DRIFT_FROM:
                cov_day = float(np.isfinite(day_modis[ROI_MASK]).mean())
                caveats.append(f"MODIS Terra day LST of the {year} frame comes from drifted orbits (~10:07 IST in "
                               f"2025); after the 10.0-11.5 h view-time filter {100 * cov_day:.0f} % of the ROI "
                               "keeps a value. It is a validation layer only.")
        else:
            sources["lst_day_modis"][year] = "no MODIS Terra day product before 2000 (NaN)"
        out_frames[year] = {"lst_night": night.astype(np.float32), "lst_night_nobs": nobs.astype(np.float32),
                            "lst_day_modis": day_modis}
        log(f"frame {year}: night {night_meta[year]['source'] or '-'} coverage {coverage:.3f}"
            + (f", mean {np.nanmean(night):.2f} °C, overpass {night_meta[year]['overpass_ist_h']:.2f} h IST"
               if plan.source else "")
            + (f"; MODIS day mean {np.nanmean(day_modis):.2f} °C" if np.isfinite(day_modis).any() else ""))
    del raw

    # ---- annual series ---------------------------------------------------------------------------------------
    annual_df, series_caveats = _s04_annual_series(annual, calib, dominant)
    caveats += series_caveats
    calibration = {k: calib[k]["summary"] for k in ("terra_to_aqua", "viirs_to_aqua")}
    diag = {k: calib[k]["diag"] for k in calib}
    diag["viirs_scales"] = viirs
    if _S04_EXPORT_DIAG:
        diag["exports"] = list(_S04_EXPORT_DIAG)
    cal_state = {k: {"coef": {int(c): tuple(v) for c, v in calib[k]["coef"].items()},
                     "shrunk": calib[k]["shrunk"]} for k in calib}
    del annual
    free_memory()
    return {"frames": out_frames, "night_meta": night_meta, "calibration": calibration, "diag": diag,
            "cal_state": cal_state, "annual": annual_df, "sources": sources, "caveats": caveats,
            "dominant_anchors": dominant}

# %% [markdown]
# ## 4.5 Annual series 1990–2025 (`ANNUAL_SERIES`)
# * **ERA5-Land** (`era5_skin_day`, `era5_skin_night`, `era5_tmax`, `era5_tmin`, `era5_swvl1`): one image per variable
#   with one band per year, reduced with `reduceRegions(mean)` over the 25 district features + the NCR feature at
#   1 km in `EPSG:32643` (bilinear input — area-weighted, no empty small districts); one batched `getInfo` per
#   variable, halved automatically if Earth Engine reports memory/time-outs.
# * **Satellites** (`modis_terra_day` 2000–, `modis_aqua_night` 2003–, `viirs_night_cal` 2012–): scope means of the
#   annual 1 km fields (≥ 50 % of the scope's cells valid); VIIRS uses the VIIRS→Aqua calibration per cell.
#   `flag = "drift"` for Terra and Aqua from 2022 (their orbits drifted ~1 h); else None.

# %%
def _s04_era5_series(years: Sequence[int]) -> list:
    """Rows (year, scope, variable, value, flag) of the ERA5-Land annual series via batched reduceRegions."""
    rows = []
    scopes = _s04_scopes_fc()

    def _parse(info, ys):
        recs = []
        for props in _s04_fc_records(info):
            did = props.get("did")
            if did is None:
                continue
            scope = "ncr" if int(did) < 0 else f"d:{int(did)}"
            for y in ys:
                value = props.get(f"y{int(y)}")
                if value is not None and np.isfinite(float(value)):
                    recs.append((int(y), scope, float(value)))
        return recs

    for variable in _S04_ERA5_SERIES:
        def _build(ys, variable=variable):
            image = _s04_era5_annual_image(variable, ys)
            names = [f"y{int(y)}" for y in ys]
            # forEach names the outputs: with one band (a batch split down to one year) they would be called "mean"
            fc = image.reduceRegions(collection=scopes, reducer=ee.Reducer.mean().forEach(names), scale=1000,
                                     crs=CFG.CRS, tileScale=4)
            return fc.select(["did"] + names, None, False)

        with timer(f"04 annual series {variable}"):
            recs = _s04_batched(list(years), _build, _parse, f"ERA5 {variable}")
        rows += [(y, s, variable, v, None) for (y, s, v) in recs]
        n_scopes = len({s for _, s, _ in recs})
        log(f"  {variable}: {len(recs)} values over {n_scopes} scopes")
    return rows


def _s04_annual_series(annual: dict, calib: dict, dominant: dict) -> tuple:
    """Assemble ANNUAL_SERIES (ERA5 + satellite) as the SPEC §3.2 DataFrame."""
    caveats = []
    y_first, y_last = _S04_SERIES_YEARS
    rows = _s04_era5_series(range(y_first, y_last + 1))
    district = DISTRICT_IDX[CELL_ROWS, CELL_COLS].astype(np.int64)
    n_d = len(DISTRICTS)
    vc = calib["viirs_to_aqua"]
    sat_inputs = (("modis_terra_day", annual["terra_day"], None, True),
                  ("modis_aqua_night", annual["aqua_night"], None, True),
                  ("viirs_night_cal", annual["viirs_night"], vc, False))
    for variable, fields, cal, drifts in sat_inputs:
        n_rows, skipped = 0, []
        for year in sorted(fields):
            vals = _s04_cells(fields[year])
            if cal is not None:
                cls = dominant[_s04_nearest_anchor(year, sorted(dominant))][CELL_ROWS, CELL_COLS]
                finite = np.isfinite(vals)
                vals = np.where(finite, _s04_apply_calibration(np.nan_to_num(vals), cls, cal["coef"], cal["shrunk"]),
                                np.nan)
            means = _s04_scope_means(vals, district, n_d)
            if "ncr" not in means:
                skipped.append(year)
            flag = "drift" if (drifts and year >= _S04_DRIFT_FROM) else None
            for scope, value in means.items():
                rows.append((int(year), scope, variable, float(value), flag))
                n_rows += 1
        log(f"  {variable}: {n_rows} values" + (f"; NCR mean skipped (coverage < 50 %) in {skipped}" if skipped
                                                else ""))
        if skipped and variable == "modis_terra_day":
            caveats.append("MODIS Terra day annual means are missing where fewer than 50 % of the cells keep a "
                           f"value after the QC and 10.0-11.5 h view-time filters (years {skipped}).")
    rows = [r for r in rows if y_first <= r[0] <= y_last]
    df = pd.DataFrame({
        "year": pd.Series([r[0] for r in rows], dtype="int64"),
        "scope": pd.Series([r[1] for r in rows], dtype=object),
        "variable": pd.Series([r[2] for r in rows], dtype=object),
        "value": pd.Series([r[3] for r in rows], dtype="float64"),
        "flag": pd.Series([r[4] for r in rows], dtype=object),
    })
    df = df.sort_values(["variable", "scope", "year"], kind="stable").reset_index(drop=True)
    missing = sorted(set(_S04_ERA5_SERIES + _S04_SAT_SERIES) - set(df["variable"]))
    if missing:
        raise RuntimeError(f"ANNUAL_SERIES lacks variables {missing}")
    return df, caveats

# %% [markdown]
# ## 4.6 Run (gee mode) and publish the section-04 globals
# The whole section is one stage-cache unit keyed by the grid, ROI, frames, windows, season and code version, so a
# resumed Kaggle session (or an imported cache) skips every Earth Engine call. `RAW_OBS` / `FRAME_META` are merged
# into (section 03 created them with the day products); `NIGHT_CALIBRATION_DIAG` keeps the leave-one-year-out
# transfer errors, the VIIRS run-time scales and the per-class fallbacks for the export's `metrics.night_calibration`.

# %%
def _s04_publish(result: dict) -> None:
    """Merge the section-04 products into the shared acquisition globals."""
    global RAW_OBS, FRAME_META, NIGHT_CALIBRATION, NIGHT_CALIBRATION_DIAG, ANNUAL_SERIES, DATA_SOURCES, DATA_CAVEATS
    if not isinstance(globals().get("RAW_OBS"), dict):
        RAW_OBS = {}
    if not isinstance(globals().get("FRAME_META"), dict):
        FRAME_META = {}
    for year, fields in result["frames"].items():
        RAW_OBS.setdefault(int(year), {}).update(fields)
        entry = FRAME_META.setdefault(int(year), {"window": tuple(int(v) for v in CFG.window(year))})
        entry.setdefault("window", tuple(int(v) for v in CFG.window(year)))
        entry["night"] = dict(result["night_meta"][year])
    NIGHT_CALIBRATION = result["calibration"]
    NIGHT_CALIBRATION_DIAG = result["diag"]
    ANNUAL_SERIES = result["annual"]
    if not isinstance(globals().get("DATA_SOURCES"), dict):
        DATA_SOURCES = {}
    for var, by_year in result["sources"].items():
        DATA_SOURCES.setdefault(var, {}).update({int(y): t for y, t in by_year.items()})
    DATA_SOURCES.setdefault("annual_series", {})["1990-2025"] = (
        f"ERA5-Land ({_S04_ERA5_HOURLY} skin_temperature 05/20 UTC; {_S04_ERA5_DAILY} temperature_2m_max/min; "
        f"{_S04_ERA5_MONTHLY} volumetric_soil_water_layer_1) Apr-Jun means, reduceRegions(mean) at 1 km EPSG:32643 "
        "over NCR + districts; "
        f"{_S04_TERRA} day (QC, view time 10.0-11.5 h), {_S04_AQUA} night (QC), {_S04_VIIRS_N} night calibrated to "
        "Aqua: annual Apr-Jun per-pixel medians at 1 km, scope means of cells (>= 50 % valid); Terra/Aqua >= 2022 "
        "flagged 'drift'")
    DATA_SOURCES.setdefault("night_calibration", {})["2000-2025"] = (
        "per dominant GLC_FCS30D class OLS aqua = a + b*src on annual Apr-Jun medians (Terra night 2003-2019, VIIRS "
        "night 2013-2021) + per-cell mean residual shrunk n/(n+3); dominant class from the nearest of the "
        f"{list(_S04_GLC_ANCHORS)} GLC maps")
    if not isinstance(globals().get("DATA_CAVEATS"), list):
        DATA_CAVEATS = []
    for text in result["caveats"] + [
            "Night LST of the 2025 frame is VIIRS S-NPP (TES algorithm) and of the 2000 frame MODIS Terra (22:30 IST); "
            "both are mapped to Aqua (split-window, ~02:12 IST) by per-class overlap calibrations whose "
            "leave-one-year-out errors are reported in metrics.night_calibration."]:
        if text not in DATA_CAVEATS:
            DATA_CAVEATS.append(text)


if _S04_ACTIVE:
    if ee is None or EE_DISTRICTS is None:
        raise RuntimeError("section 04 needs an initialised Earth Engine session and EE_DISTRICTS (section 01)")
    # code03: section 04 fetches through section-03 helpers (gee_fetch_grid unmask/NaN conventions,
    # gee_fetch_asset, the asset-export helpers), so a change there must invalidate this stage (D4)
    _s04_key = CFG.key("WINDOWS", "SEASON", version=_S04_VERSION, grid=GRID.to_dict(), roi=_s04_roi_digest(),
                       code03=section_code_hash("03"), cal_years={k: list(v) for k, v in _S04_CAL_YEARS.items()},
                       anchors=list(_S04_GLC_ANCHORS), series=list(_S04_SERIES_YEARS))
    _s04_sc = stage_cache("s04_thermal", _s04_key)
    _S04_EXPORT_DIAG.clear()
    with gee_workload_tag("lst-v2-s04"), timer("04 MODIS/VIIRS thermal products"):
        _S04_RESULT = _s04_sc.get_or_compute(_s04_build_thermal)
    _s04_publish(_S04_RESULT)
    # kept for diagnostics: dominant GLC classes at the anchors and the per-cell calibration state
    _S04_DOMINANT = _S04_RESULT["dominant_anchors"]
    _S04_CAL_STATE = _S04_RESULT["cal_state"]
    for _s04_k, _s04_v in NIGHT_CALIBRATION.items():
        log(f"NIGHT_CALIBRATION[{_s04_k}]: R2 {_s04_v['r2']} RMSE {_s04_v['rmse']} n {_s04_v['n']:,}; LOYO "
            f"{NIGHT_CALIBRATION_DIAG[_s04_k]['loyo_rmse_with_residual']} °C")
    log(f"ANNUAL_SERIES: {len(ANNUAL_SERIES):,} rows, variables {sorted(ANNUAL_SERIES['variable'].unique())}")
    del _S04_RESULT, _s04_key, _s04_sc
    free_memory()

# %% [markdown]
# ## 4.7 Quality-assurance figure
# (a) Night frames (Aqua-equivalent) side by side; (b) the NCR annual series — ERA5-Land skin temperature at the two
# overpass hours against the satellite series (drift years hollow); (c) the two night calibrations: in-sample R² and
# RMSE of the class maps and the leave-one-year-out RMSE with the shrunk residual (°C).

# %%
def _s04_save_show(fig, name: str) -> None:
    path = CFG.FIG_DIR / name
    try:
        fig.savefig(path, dpi=110, bbox_inches="tight")
        log(f"figure -> {path}")
    except OSError as exc:
        log(f"could not save {path}: {exc}", "WARNING")
    plt.show()
    plt.close(fig)


def _s04_qa_figure() -> None:
    frames = [y for y in CFG.FRAMES_OBS if FRAME_META[y]["night"]["source"]]
    n = max(1, len(frames))
    fig = plt.figure(figsize=(3.2 * max(n, 3), 7.2))
    gs = fig.add_gridspec(2, max(n, 3))
    vals = np.concatenate([RAW_OBS[y]["lst_night"][ROI_MASK] for y in frames]) if frames else np.array([np.nan])
    lo, hi = (np.nanpercentile(vals, [2, 98]) if np.isfinite(vals).any() else (0, 1))
    for i, year in enumerate(frames):
        ax = fig.add_subplot(gs[0, i])
        im = ax.imshow(RAW_OBS[year]["lst_night"], cmap="magma", vmin=lo, vmax=hi)
        ax.set_title(f"night {year} ({FRAME_META[year]['night']['source']})", fontsize=9)
        ax.set_axis_off()
    if frames:
        fig.colorbar(im, ax=fig.axes[: len(frames)], shrink=0.6, label="°C (Aqua-equivalent)")
    ax = fig.add_subplot(gs[1, : max(1, max(n, 3) - 1)])
    ncr = ANNUAL_SERIES[ANNUAL_SERIES["scope"] == "ncr"]
    styles = {"era5_skin_day": ("tab:orange", "-"), "era5_skin_night": ("tab:blue", "-"),
              "modis_terra_day": ("tab:red", "o"), "modis_aqua_night": ("navy", "s"),
              "viirs_night_cal": ("tab:purple", "^")}
    for var, (color, marker) in styles.items():
        sub = ncr[ncr["variable"] == var].sort_values("year")
        if sub.empty:
            continue
        if marker == "-":
            ax.plot(sub["year"], sub["value"], color=color, label=var)
        else:
            ok = sub["flag"].isna()
            ax.plot(sub["year"][ok], sub["value"][ok], marker, color=color, label=var, ms=4)
            ax.plot(sub["year"][~ok], sub["value"][~ok], marker, mfc="none", color=color, ms=4)
    ax.set_xlabel("year")
    ax.set_ylabel("°C (NCR Apr-Jun mean)")
    ax.legend(fontsize=7, ncol=3)
    ax.set_title("annual series (hollow = drifted orbit)", fontsize=9)
    ax = fig.add_subplot(gs[1, -1])
    diag = NIGHT_CALIBRATION_DIAG
    rows = [(k, NIGHT_CALIBRATION[k]["r2"], NIGHT_CALIBRATION[k]["rmse"], diag[k]["loyo_rmse_with_residual"])
            for k in ("terra_to_aqua", "viirs_to_aqua")]
    ax.axis("off")
    table = ax.table(cellText=[[k.replace("_to_", "->"), f"{r2}", f"{rmse}", f"{loyo}"]
                               for k, r2, rmse, loyo in rows],
                     colLabels=["map", "R2", "RMSE", "LOYO"], loc="center")
    table.auto_set_font_size(False)
    table.set_fontsize(9)
    table.scale(1.0, 1.6)
    ax.set_title("night calibrations (°C)", fontsize=9)
    _s04_save_show(fig, "04_night_thermal_qa.png")


if _S04_ACTIVE:
    try:
        _s04_qa_figure()
    except Exception as exc:  # noqa: BLE001 - a QA figure must never abort the pipeline
        log(f"section-04 QA figure failed: {type(exc).__name__}: {exc}", "WARNING")
