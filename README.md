# Delhi NCR Land Surface Temperature × Explainable AI — v2 (1990–2050, day + night)

A reproducible Earth-observation pipeline and an interactive dashboard for the **pre-monsoon (April–June) land
surface temperature (LST)** of the Delhi National Capital Region (25 districts, ≈ 55,000 km²):

- **Observed record 1990–2025** at eight frames (1990, 1995, …, 2025), each a multi-year April–June window:
  - **day**: harmonised Landsat C2 L2 surface temperature (~10:30 IST), path-offset and overpass corrected;
  - **night**: MODIS Aqua night LST (~01:30 IST), with Terra and VIIRS calibrated to Aqua, and a model hindcast
    for 1990/1995.
- **Explainable models**: one pooled XGBoost model per mode on 47 features (33 base + 14 neighbourhood/focal),
  validated with 20 km spatial-block CV and leave-one-epoch-out, explained with **grouped GPU TreeSHAP** (18 driver
  groups), interactions, block-bootstrap intervals, threshold detection, an area-of-applicability mask and four
  **governance zones** per mode.
- **250 m layer**: observed Landsat by day; by night a **DMS downscaling** with block-conserving residual
  correction, validated against bilinear interpolation.
- **Projections 2030–2050** under **SSP1-2.6 / SSP2-4.5 / SSP5-8.5**: a cellular-automaton land-change model
  (figure-of-merit validated), CMIP6 temperature deltas × empirical dLST/dTair sensitivities, and a **Monte-Carlo**
  ensemble (GCM × sensitivity × land realisation × model error) with P05–P95 fans and an uncertainty budget.
- **NCR THERMAL/OPS v2 dashboard**: a persistent 3-D deck.gl thermal stage with a 1990–2050 time ribbon,
  Day / Night / DTR, SSP fans, compare split, 250 m lens, per-cell SHAP waterfalls, an in-browser what-if
  simulator, a guided Briefing, and Timeline, Drivers, Zones, Model Lab and Sources views.

> ### Which data is real?
>
> - **`dashboard/public/demo/` is SYNTHETIC.** It is the v2 bundle written by `notebook/run_local.py` in synthetic
>   mode: a simulated Delhi NCR with a *planted, known* temperature response, on a 2 km grid with the fast
>   profile. It demonstrates the pipeline and every dashboard feature. **It is not a finding about the real region.**
>   The dashboard shows a persistent "SYNTHETIC · DEMO" badge and banner, and the manifest records
>   `data_mode: "synthetic"`.
> - **`dashboard/public/data/` holds the user's REAL bundle**: the v2 **full-profile** Earth Engine run on Kaggle
>   (2× T4, November 2026): 8 observed frames 1990–2025 (day and night), 5 projected frames 2030–2050 for
>   SSP1-2.6 / SSP2-4.5 / SSP5-8.5, 1 km grid with 250 m rasters. Validated with `notebook/validate_bundle.py`.
>   Earlier bundles (v1 Earth Engine run, v2 pilot) remain in the git history.

---

## Contents

1. [Architecture](#architecture)
2. [Kaggle quick start (real data)](#kaggle-quick-start-real-data)
3. [Local synthetic runs](#local-synthetic-runs)
4. [Outputs](#outputs)
5. [Dashboard: dev, build, deploy](#dashboard-dev-build-deploy)
6. [Data contract and research notes](#data-contract-and-research-notes)
7. [Scientific caveats](#scientific-caveats)
8. [Validation status](#validation-status)

---

## Architecture

```
 ┌──────────────────────────── Kaggle notebook · 2× Tesla T4 · Earth Engine service account ────────────────────────────┐
 │                                                                                                                       │
 │  00 setup ─► 01 study area ─┬─► 02 synthetic world ──────────────────────────────┐   (synthetic mode only)           │
 │  CFG/profiles  ROI, 25        │                                                   │                                    │
 │  stage cache   districts,     └─► 03 Landsat day ─► 04 MODIS/VIIRS night ─► 05 drivers   (gee mode only)               │
 │  LSTB writer   1 km + 250 m       C2 L2 ST, path       Aqua + Terra/VIIRS      GHSL, GLC_FCS30D, SRTM, GSW,             │
 │  GPU detect    grids, GEE init    offsets, overpass    calibration, annual     ERA5-Land, CMIP6, SSP urban land         │
 │                                   correction           series                                                         │
 │                                         │  identical globals, keys, shapes and dtypes on both paths (SPEC §3.2)      │
 │                                         ▼                                                                             │
 │  06 features ─► 07 models ─► 08 explain ─► 09 timeline ─► 10 downscaling ─► 11 projections ─► 12 export               │
 │  47 features    block20/LOEO  grouped GPU    levels °C,      250 m day (obs)   land-change CA,     LSTB cubes, JSON,   │
 │  focal/dist.,   CV, bench-    TreeSHAP,      night hind-     + night DMS,      CMIP6 Δ × β,        rasters, parquet,   │
 │  landscape      marks, AOA,   bootstrap,     cast, tiers,    validation,       Monte-Carlo fans,   validation, zip     │
 │  metrics,       persistent    thresholds,    β = dLST/       EPSG:4326 PNG     uncertainty budget                      │
 │  folds, masks   residual      zones, recs    dTair, trends                                                             │
 └──────────────────────────────────────────────────────────────────────────────────────────────┬────────────────────────┘
                                                                                                │
       outputs/ ── web/ (bundle v2)  web_bundle.zip  parquet/  geo/  models/  npz/  figures/  cache/
                                                                                                │
                    copy outputs/web/* into dashboard/public/data/  (or host it: NEXT_PUBLIC_DATA_BASE_URL)
                                                                                                ▼
 ┌──────────── dashboard/ · Next.js 16 · React 19 · deck.gl 9.4 · MapLibre · zustand · Tailwind · Geist ────────────────┐
 │  app/       Next.js site, statically generated from public/data: / · /findings · /methodology · /learn · /data ·     │
 │             /about (SEO metadata, JSON-LD, sitemap, OG image) and /explore (the WebGL explorer, client-only)          │
 │  data/      LSTB reader (DecompressionStream, worker decode), bundle store, v1 → v2 adapter, contract validator        │
 │  engine/    MapEngine: persistent deck.gl stage, GPU thermal columns, 250 m raster + lens, compare split, H3,         │
 │             perf governor (tiers T0–T3), frame interpolation                                                          │
 │  shell/     command bar, nav rail, command palette (Ctrl K), boot sequence, keyboard map, toasts, live announcer      │
 │  time/      time ribbon 1990–2050, playback, SSP chips, tracks drawer, warming stripes                                │
 │  views/     Control (Mission Control + Briefing) · Timeline · Drivers · Zones · Model Lab · Sources                   │
 │  ?bundle=data (public/data, the user's bundle) | demo (public/demo, synthetic v2) | fixture (in-memory)               │
 └────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

The notebook is **built** from plain Python sources in `notebook/sections/*.py` (jupytext "percent" format, one shared
namespace). The same sources run as one script through `notebook/run_local.py`, so local runs exercise exactly the code
Kaggle runs.

```
LST replication study/
├── delhi_ncr_lst_pipeline.ipynb   # BUILT artefact: python notebook/build_notebook.py --check (~1.5 MB, local Jupyter)
├── kaggle_launcher.ipynb          # BUILT ~12 KB Kaggle notebook (make_kaggle_code_bundle.py rebuilds it)
├── notebook/
│   ├── sections/00_setup.py … 12_export.py
│   ├── build_notebook.py          # sections -> .ipynb (--check compiles every code cell)
│   ├── run_local.py               # run all sections as one script (synthetic smoke / demo bundle)
│   ├── kaggle_runner.py           # runs the sections inside kaggle_launcher.ipynb (finds/checks the code dataset)
│   ├── kaggle_launcher_src.py     # source of kaggle_launcher.ipynb (build_launcher.py builds it)
│   ├── make_kaggle_code_bundle.py # -> outputs/kaggle/ncr-lst-v2-code.zip, the code dataset for Kaggle
│   ├── validate_bundle.py         # v2 + v1 web-bundle validator (CLI)
│   └── legacy_v1/                 # the tested v1 sections (reference only)
├── dashboard/
│   ├── app/                       # Next.js pages (site + /explore), sitemap, robots, OG image
│   ├── lib/site/                  # build-time facts from public/data, SEO metadata, site config
│   ├── src/                       # the explorer: engine, data layer, stores, views, design tokens
│   ├── scripts/build-media.mjs    # real-data images for the site (npm run media)
│   ├── public/data/               # the user's bundle (REAL v2 full-profile GEE bundle)
│   ├── public/media/              # generated images (committed)
│   └── public/demo/               # SYNTHETIC v2 demo bundle
└── docs/  SPEC.md · SPEC_v1.md · UI_SPEC_v2.md · research/
```

---

## Kaggle quick start (real data)

The primary target is a **Kaggle notebook with 2× Tesla T4 GPUs** and an **Earth Engine service account**.

> **Kaggle's 1 MB notebook limit.** Kaggle refuses notebooks larger than 1 MB ("The kernel source must be less than
> 1 megabytes"). `delhi_ncr_lst_pipeline.ipynb` is ~1.5 MB (1.1 MB of it code), so on Kaggle you run the small
> **`kaggle_launcher.ipynb`** (~12 KB) instead. It executes exactly the same 13 sections (00–12), cell by cell, in
> its own namespace — same stage caches and code hashes, same time budget and clean stop, same outputs — from a
> **code dataset** you upload once. `delhi_ncr_lst_pipeline.ipynb` stays the readable, self-contained version for
> local Jupyter.

1. **Code dataset + launcher** (one time; after a code change see the end of this step):
   - on your PC, in the project folder: `python notebook/make_kaggle_code_bundle.py`. It writes
     `outputs/kaggle/ncr-lst-v2-code.zip` (~450 KB: the 13 sections, `kaggle_runner.py`, `build_notebook.py`,
     `validate_bundle.py`, `run_local.py` and `BUNDLE_INFO.json` with the bundle id, code hashes and file checksums)
     and `outputs/kaggle/kaggle_launcher.ipynb` (the launcher with `EXPECTED_BUNDLE` set to this bundle), and prints
     the **bundle id** (e.g. `20261005-203015-ab12cd`: UTC build time + checksum);
   - kaggle.com → **+ Create → New Dataset** → drop the zip → title `ncr-lst-v2-code` → **Create** (private by
     default). Wait until Kaggle has finished processing it; Kaggle unpacks the zip (the launcher accepts either
     form);
   - **+ Create → New Notebook → File → Import Notebook** → upload `outputs/kaggle/kaggle_launcher.ipynb`;
   - in the notebook: right sidebar → **Input → + Add Input** (older editor: *Add Data*) → **Datasets → Your Work →
     `ncr-lst-v2-code` → (+)**.

   At the start of every run the launcher checks each file against `BUNDLE_INFO.json` and the bundle id against
   `EXPECTED_BUNDLE`, prints both, and stops within seconds on a mismatch, for example when Kaggle still mounts an
   older version of the dataset. **After a code change:** run the script again; open the dataset → **New Version** →
   replace the zip → *Create*; in the launcher, update the dataset to that version in the Input panel and set
   `EXPECTED_BUNDLE = "<new id>"` in the run-settings cell. `python notebook/make_kaggle_code_bundle.py --verify`
   tells you whether the zip in `outputs/kaggle/` is still the current code.

   The launcher can also take the code from GitHub (`CODE_SOURCE = "github"`, `GITHUB_REF` = a branch, tag or, best,
   a full commit id **that contains the v2 code**; the commit is printed and recorded). Today `main` still holds v1,
   so use the dataset.
2. **Settings** (menu *Settings*, or the right sidebar's *Session options*): *Accelerator → GPU T4 x2*; *Internet →
   On* (Earth Engine and pip need it; Kaggle allows internet only for a phone-verified account).
3. **Earth Engine project and service account** (Google Cloud console):
   - enable the **Earth Engine API** on a Cloud project registered for Earth Engine (noncommercial use is fine);
   - create a service account and grant it **Earth Engine Resource Viewer** and **Service Usage Consumer**;
     add **Earth Engine Resource Writer** if you use the asset export (see *Asset mode* below);
   - create a JSON key for it.
4. **Add-ons → Secrets**, attach both to this notebook:
   - `GEE_SERVICE_ACCOUNT_KEY`: the *entire* JSON key file;
   - `GEE_PROJECT`: the Cloud project id used for Earth Engine quota.
5. **Quota: the Contributor tier is required.** Noncommercial projects get 150 EECU-hours/month on the Community
   tier, or **1,000 EECU-hours/month on the Contributor tier**. The Contributor tier needs a linked billing account,
   but noncommercial use is not charged, and switching takes effect at once:
   [Manage tier](https://console.cloud.google.com/earth-engine/configuration/manage-tier).
   - **Measured on 2026-10-12:** the pilot's Landsat extraction alone used up the Community tier's 150 EECU-hours
     after about 3.5 of its 4 frames, so about 35–45 EECU-hours per frame. A full run needs several hundred.
   - **When the quota is used up**, Earth Engine puts the project into *Restricted Mode* (reduced concurrency) until
     the 1st of the next month. The run then stops cleanly with that message and keeps everything downloaded so
     far; run again to resume once the tier is raised.
6. **Run the pilot first.** Kaggle has no environment-variable UI; the launcher's **run-settings cell** (its first
   code cell) holds the overrides. It first clears every `LST_*` value left from an earlier run in the same session
   (so a deleted line is really unset), then sets:

   ```python
   os.environ["LST_RUN_MODE"] = "gee"     # real Earth Engine data; stops with an error if EE is unavailable
   os.environ["LST_PROFILE"] = "pilot"    # frames 1990, 2000, 2020, 2025; ridge + XGBoost; no projections
   ```

   (Running the full `delhi_ncr_lst_pipeline.ipynb` in local Jupyter instead? Put the same lines in a new first cell.)

   The pilot covers frames **1990, 2000, 2020, 2025** (Landsat 5 TM only, the Terra-reconstructed night frame, the
   early GLC five-year map and GHSL epochs, and the dense Landsat 7/8/9 windows), runs ridge + XGBoost, makes no
   projections and runs the **CMIP6 pattern probe** (`LST_PILOT_PROBES`, on by default in the pilot: the SSP2-4.5
   warming pattern for 2050 through the GDDP block cache; its time, request count and result are printed in the run
   summary and stored in `FUTURE_INPUTS_DIAG["probes"]`). Expect about **3 h (1–8 h)**: most of it is the first real
   Earth Engine extraction, whose speed has never been measured for v2; even the slow case fits one session. Run it
   as **Save Version → Save & Run All (Commit)** so that its output is kept as a version you can attach in step 8
   (an interactive *Run All* also works, but its output is lost when the session ends unless you save a version).
7. **Read the pilot's cost.**
   - **EECU:** Google Cloud console → *Monitoring* → Earth Engine → **Completed EECU-seconds**, grouped by
     `workload_tag` (`lst-v2-s03` Landsat, `lst-v2-s04` night/thermal, `lst-v2-s05` drivers and CMIP6) and
     `compute_type`. The Earth Engine task list only shows batch exports, so it is not the EECU source.
   - **Wall-clock:** the log lines `<<< 03_gee_landsat.py done in …s`, `<<< 04_gee_thermal.py …` and
     `<<< 05_gee_drivers.py …` (S03, S04, S05 below, converted to hours), the per-frame Landsat cost table at the end
     of section 03, the PILOT PROBES table of section 05 and `outputs/web/metrics.json → timings`. The "projected
     full-run time" that section 03 prints assumes a fresh run; the full run reuses the pilot's tiles, so use the
     formula below instead.
   - **Predict the full run** (with the pilot's output attached): **F ≈ 0.1 + 1.05 × S03 + 0.6 × (S04 + S05) + 5.2
     h**. The full run fetches only the four frames the pilot skipped (1995, 2005, 2010, 2015) plus about 60 % of the
     pilot's 04/05 requests; 5.2 h is the estimated modelling time of sections 06–12 on 2× T4 (see *Runtime*).
   - **Decision rule:** if F ≤ about 8.5 h, run the full profile as one commit (step 8). Otherwise, or if the log shows
     many split tiles (`computation timed out`), run it as **two commits**:
     1. the first with `LST_STOP_AFTER = "06"` (Earth Engine + features; the cache is packed when it stops);
     2. then **delete that line**, attach that version's output and *Save & Run All (Commit)* again (as in step 9).

     Each half fits one session easily, and the Earth Engine work is saved before the modelling starts.
     `LST_GEE_EXPORT=asset` (batch exports; needs **Earth Engine Resource Writer**) is an option if interactive
     tiles keep timing out.
8. **Run the full profile as *Save & Run All (Commit)*.** In a new version, set `LST_PROFILE` to `"full"` in the
   run-settings cell (keep any other override you want), attach the pilot's output (right sidebar → **Input → + Add
   Input → Notebooks → Your Work → the launcher → (+)**; Kaggle attaches the output of the notebook's newest version,
   the pilot) so its Earth Engine tiles and GDDP blocks are reused (`LST_CACHE_IMPORT=auto` finds them), and commit. A commit runs to the end in the background and keeps the output; an interactive session does not survive
   closing the browser. Only the pilot's Earth Engine tiles and GDDP blocks are reused, not its model stages (the
   profile is part of every stage key). Expected runtime ≈ 7.5–9 h after the pilot (an estimate; see *Runtime*). It
   fits the 11 h time budget in roughly two runs out of three; otherwise it stops cleanly and step 9 finishes it.
9. **If the version stopped on the time budget, resume it.** A clean stop is not a failure: the version completes,
   the log shows a `RUN STOPPING CLEANLY in section NN: <reason>` banner and ends with `STOPPED CLEANLY after section
   NN`, and the output holds `RUN_STOPPED.json` (reason, section, elapsed hours) and the packed cache, but no new
   `web_bundle.zip`. To resume:
   - start a new version **with the same overrides** (profile, `LST_FRAMES_OBS`, grid: they are part of the stage
     keys) and **without `LST_STOP_AFTER`** if that was the reason;
   - in the Input panel, remove the earlier notebook-output attachment (**keep the `ncr-lst-v2-code` dataset**) and
     attach the launcher's output again (**+ Add Input → Notebooks → Your Work → the launcher → (+)**; its cache
     already holds everything it imported). Kaggle attaches the output of the notebook's **newest** version, so save
     no other version between the stopped run and the resume; if you did, open the stopped version → *Output* →
     **New Dataset** and attach that dataset instead. `auto` imports a single cache folder, the shallowest one under
     `/kaggle/input/`, and logs which one and the attached run's `RUN_STOPPED.json`. To choose one explicitly, copy
     the attachment's path from the Input panel into `os.environ["LST_CACHE_IMPORT"] = "<path>"` (a path without a
     cache stops the run at once instead of silently recomputing);
   - *Save & Run All (Commit)*. Finished stages, tiles and GDDP blocks are reused, and section 07 skips the
     validation jobs it had already finished. Repeat until a version ends with `ALL SECTIONS OK`.

   **If a commit fails** (the log shows `RUN FAILED in <section file>, code cell <n>`): in a commit the launcher still
   ends the version normally (`LST_FAIL_SOFT`, on by default in commits), so its output keeps the packed cache and
   `outputs/RUN_FAILED.json` (error and traceback). Fix the cause (a code fix means a new bundle and dataset version,
   see step 1), then resume exactly as above.

   Changing the launcher's run-settings cell is fine; the pipeline code lives in the code dataset. Uploading a new
   dataset version with changed section code changes those sections' hashes, so their stages (and the stages that
   depend on them) are recomputed — unchanged sections are still reused (see *Time budget, clean stop and resume*
   below).
10. **Download** `outputs/web_bundle.zip` from the finished version's *Output* tab and load it into the dashboard
    ([below](#dashboard-dev-build-deploy)).

**Optional: run the Earth Engine part on your PC.**

*Why.* Sections 03–05 only download data, so they can run on your own computer with `earthengine-api` installed.
There they have no Kaggle time limit and use no GPU quota. Uploaded as a second dataset, the cache they produce lets
Kaggle skip sections 03–06 (cache hits), so the Kaggle session only trains: about 0.5–1 h for the pilot and about
5 h for the full run.

*Steps* (PowerShell, in the project folder):

```powershell
$env:LST_PROFILE = "pilot"; $env:LST_STOP_AFTER = "06"; $env:LST_PACK_CACHE = "1"
$env:LST_GEE_SERVICE_ACCOUNT_KEY = "C:\path\to\your-service-account-key.json"; $env:LST_GEE_PROJECT = "your-project-id"
python notebook/run_local.py --mode gee --grid-res 1000 --no-fast-dev --out outputs/pilot_ee
python notebook/make_kaggle_cache_bundle.py --src outputs/pilot_ee      # -> outputs/kaggle/ncr-lst-v2-ee-cache.zip
```

Then, on Kaggle:
1. **+ Create → New Dataset** → drop the zip → title `ncr-lst-v2-ee-cache` → **Create**.
2. In the launcher: **Input → + Add Input → Datasets → Your Work** → attach `ncr-lst-v2-ee-cache`, next to the code
   dataset.
3. Commit. The log shows `cache import: merging …ncr-lst-v2-ee-cache/cache` and stage `HIT`s for sections 03–06.

*Rules.*
- Upload the **code bundle built from the same code** as the local run, and use the **same profile**. The stage keys
  carry the section code hashes and the profile.
- If the code changed in between, the Earth Engine tiles and GDDP blocks are still reused, because they are keyed by
  their request expressions; only the cheap assembly steps rerun.
- For the full run, repeat with `LST_PROFILE = "full"`; it reuses the pilot's tiles.
- The key file stays on your PC; never put it into the project folder or the repository.

**Earth Engine endpoint and limits.** Interactive extraction uses the **standard** Earth Engine endpoint by default;
the high-volume endpoint is opt-in (`LST_GEE_ENDPOINT=highvolume`) and has the same 40-concurrent-request quota. Each
request has a 420 s deadline (`LST_GEE_DEADLINE_S`, minimum 330) and 3 client retries; the Earth Engine work of
sections 03, 04 and 05 runs under the workload tags `lst-v2-s03`, `lst-v2-s04` and `lst-v2-s05`.

**Asset mode (`LST_GEE_EXPORT=asset`).** The heavy Landsat composites (and the 04/05 jobs) run as
`Export.image.toAsset` batch tasks under `LST_GEE_ASSET_ROOT` (default `projects/<GEE_PROJECT>/assets/ncr_lst_v2`)
and are then read from the asset. Noncommercial projects run **about 2 batch tasks at a time**, so the 8 Landsat
exports take about 4 rounds (about 1.5–6 h). Per-task limits: `LST_GEE_EXPORT_TIMEOUT_S` (3 h running, section 03),
`LST_GEE_EXPORT_QUEUE_S` (4 h queued), `LST_GEE_EXPORT_TIMEOUT_0405_S` (1 h running for sections 04/05). A failed or
timed-out job is cancelled and extracted interactively instead. Assets persist across sessions, so a later run reuses
them.

Missing packages (`earthengine-api`, `pylandstats`, `libpysal`, `esda`, …) are pip-installed automatically on Kaggle
(never on a local machine unless `LST_ALLOW_PIP=1`).

### Time budget, clean stop and resume

- **Time budget.** `LST_TIME_BUDGET_H` (default **11** on Kaggle, unlimited elsewhere; `0`/`none`/`off` = unlimited)
  stops *starting* new work once less than the reserve (`LST_TIME_RESERVE_S`, 1800 s) plus the expected duration of
  the next job is left. The run then ends cleanly before Kaggle's 12 h limit: the remaining cells print
  `skipped: run stopped (<reason>)` (the launcher's run cell ends with `STOPPED CLEANLY`), the cache is packed and
  the version completes with its output.
  `outputs/RUN_STOPPED.json` says why and where it stopped (a later complete export removes it). A version killed at
  12 h may have **no usable output**, so keep the budget below the limit.
- **Stop on purpose.** `LST_STOP_AFTER=NN` stops cleanly after section `NN` (for example `06`, the end of the Earth
  Engine extraction and feature build).
- **Interactive sessions.** Enable *Settings → Persistence → Files* so that `outputs/` survives a restart.
- **Resume.** Attach the completed (or cleanly stopped) version's output (*Input → + Add Input → Notebooks*; Kaggle
  attaches the notebook's newest version) and run again (step 9 above). `LST_CACHE_IMPORT=auto` imports one cache
  folder, the shallowest one under `/kaggle/input/`, so attach only one notebook output, or set `LST_CACHE_IMPORT`
  to a folder path copied from the Input panel (a path without a cache stops the run); `0` disables the import.
  Newer local files are never overwritten.
- **Failures in a commit.** The launcher packs the cache, writes `outputs/RUN_FAILED.json` and, in commits
  (`LST_FAIL_SOFT`, default on in commits only), ends the version normally so its output can be attached for the
  resume; interactively it raises the error.
- **What is cached.** Every heavy stage in `outputs/cache/stages/`, every Earth Engine tile in `outputs/cache/tiles/`
  and every GDDP-CMIP6 block in `outputs/cache/gddp/`. Because Kaggle notebook outputs are reported to be capped at
  500 files, the cache is **packed** into a few tar files `outputs/cache/packed/*.tar` at the end of the run and on a
  clean stop (`LST_PACK_CACHE`, default 1 on Kaggle and 0 elsewhere) and unpacked on import.
- **Stage keys.** A stage is reused only when its key matches: the configuration, the data fingerprints and the
  **per-section code hash** computed by `build_notebook.py`. So edit `notebook/sections/*.py` and rebuild the notebook;
  never hand-edit cells on Kaggle. `LST_RESUME=0` recomputes every stage (Earth Engine tiles and GDDP blocks stay
  cached); `LST_INVALIDATE=06,07` recomputes only the selected stages.

### Profiles and overrides

| Setting | `full` (Kaggle default) | `fast` (`LST_FAST_DEV=1`, smoke tests) | `pilot` (GEE cost probe) |
|---|---|---|---|
| observed frames | 1990, 1995, …, 2025 (8) | same 8 | 1990, 2000, 2020, 2025 |
| projected frames | 2030 … 2050 (5) × 3 SSPs | same | none (CMIP6 pattern probe only) |
| land-cover fine grid | 50 m (gee) / 100 m (synthetic) | 200 m | 50 m |
| bootstrap / Monte-Carlo draws / land realisations | 50 / 500 / 20 | 6 / 120 / 4 | 10 / – / – |
| block CV | 20 km, 10 folds | 20 km, 5 folds | 20 km, 5 folds |
| XGBoost rounds / early stop | 4000 / 100 | 400 / 30 | 1500 / 60 |
| GNN epochs / Moran permutations | 300 / 999 | 30 / 99 | 60 / 199 |
| benchmarks | ridge, random_forest, lightgbm, xgboost, gnn | same | ridge, xgboost |

| Variable | Default | Effect |
|---|---|---|
| `LST_PROFILE` | `full` | run profile (table above) |
| `LST_RUN_MODE` | `auto` | `auto` tries Earth Engine and falls back to a synthetic twin with a loud banner; `gee` fails hard without Earth Engine; `synthetic` never contacts Earth Engine |
| `LST_FRAMES_OBS` | profile | comma list of observed frames (any profile): a subset of the 8 SPEC frames with ≥ 2 frames, ≥ 2 night training frames and 2025, plus 2005 and 2015 when projections are on |
| `LST_GRID_RES_M` / `LST_FINE_FACTOR` | 1000 / 4 | analysis cell size; fine grid = cell / factor (250 m at 1 km) |
| `LST_N_BOOTSTRAP`, `LST_N_MC`, `LST_N_LAND_REAL` | profile | SHAP bootstrap replicates, Monte-Carlo draws, land-change realisations |
| `LST_BENCHMARKS` | profile | comma list from `ridge,random_forest,lightgbm,xgboost,gnn` (xgboost is mandatory) |
| `LST_PILOT_PROBES` | `1` in the pilot with Earth Engine, else `0` | section-05 CMIP6 pattern probe (cost report only; a failure is a warning) |
| `LST_GEE_ENDPOINT` | `standard` | `standard` or `highvolume` (opt-in; same 40-request quota) |
| `LST_GEE_DEADLINE_S` | 420 | Earth Engine request deadline (s; minimum 330) |
| `LST_GEE_EXPORT` / `LST_GEE_ASSET_ROOT` | `interactive` / `projects/<GEE_PROJECT>/assets/ncr_lst_v2` | tiled `computePixels`, or batch `Export.image.toAsset` |
| `LST_GEE_EXPORT_TIMEOUT_S` / `LST_GEE_EXPORT_QUEUE_S` | 10800 / 14400 | asset mode, section 03: per-task limit while running / while queued |
| `LST_GEE_EXPORT_TIMEOUT_0405_S` | 3600 | asset mode, sections 04/05: per-task limit while running (7200 s queued) |
| `LST_TIME_BUDGET_H` / `LST_TIME_RESERVE_S` | 11 on Kaggle (else unlimited) / 1800 | clean stop before the session limit |
| `LST_STOP_AFTER` | – | stop cleanly after section `NN` (`01` … `11`) |
| `LST_RESUME` / `LST_CACHE_IMPORT` | 1 / `auto` | stage-cache reuse / cache import (auto, or a folder path copied from the Input panel, or `0`) |
| `LST_FAIL_SOFT` | 1 in Kaggle commits, else 0 | launcher only: a failed run still ends the version normally (cache packed, `RUN_FAILED.json`) |
| `LST_INLINE_DPI` | 72 | launcher only: resolution of the figures shown in the notebook (`0` = notebook default; the PNG files keep their own) |
| `LST_INVALIDATE` | – | comma list of stage prefixes to recompute (e.g. `06,07`) |
| `LST_PACK_CACHE` | 1 on Kaggle, 0 elsewhere | pack the cache into `outputs/cache/packed/*.tar` |
| `LST_FRAME_MIN_COVERAGE` | 0.5 | valid-target share a training frame needs to define the fixed mask (below: weight 0) |
| `LST_DAY_MIN_FRAME_COVERAGE` | 0.2 | minimum ROI Landsat coverage of a day frame (below: section 03 stops with a diagnosis) |
| `LST_GEE_PROJECT`, `LST_GEE_SERVICE_ACCOUNT_KEY`, `GOOGLE_APPLICATION_CREDENTIALS` | – | Earth Engine credentials outside Kaggle |
| `LST_GEE_WORKERS` | 6 | concurrent `computePixels` requests |
| `LST_OUTPUT_DIR` | `/kaggle/working/outputs` or `./outputs` | output root |
| `LST_VALIDATOR` | – (the launcher sets it to the bundled copy) | path of `validate_bundle.py` for the standalone check at the end of section 12 (otherwise searched in `./notebook/`, `./` and up to 5 levels under `/kaggle/input/`; if absent, only the in-notebook read-back checks run) |
| `LST_GNN_CPU_BUDGET_S` | 900 | wall-clock budget per GNN fold without CUDA |
| `LST_USE_RAPIDS` / `LST_INSTALL_RAPIDS` | 0 | opt-in cuDF/cuML paths (not validated) |

The complete table, with every remaining knob, is in the markdown of section 00 and in `docs/SPEC.md` §1.6.

### Runtime

Measured locally (synthetic mode, one GTX 1650, CPU-only PyTorch so the GNN ran on the CPU):

| run | total | of which |
|---|---|---|
| `fast`, 2 km (16.6 k cells) | 74 min | section 07 validation 64 min (GNN 50 min) |
| `fast`, 1 km (66.3 k cells, GNN capped at 100 s/fold) | 96 min | section 07 79 min (GNN 61 min) |
| `pilot` (synthetic, 1 km, frames 1990/2000/2020/2025, ridge + XGBoost) | 51 min | section 07 30 min, section 08 17 min (100 min when three runs shared the machine) |
| any run re-using the stage cache | ≈ 2–5 min | |

**Estimate for the full profile on Kaggle 2× T4 at 1 km.** This comes from an assessment made on 2026-10-11 (working
files in `outputs/runtime_analysis/`). No v2 run has been timed on Kaggle yet, so calibrate it with the pilot.

The estimate is anchored on the user's real v1 Kaggle run, which measured these times per CV fold on 2× T4:

| Model | Time per fold |
|---|---|
| XGBoost | ≈ 15 s |
| LightGBM-GPU | ≈ 38 s |
| GNN | ≈ 124 s |
| Random forest (4 vCPU) | ≈ 99 s |

That run is also a warning: v1's own pre-run estimate was 2–3× too low for modelling and 3–10× too low for Earth
Engine.

- **Modelling (sections 06–12): about 5 h (2.6–8 h).**
  - Section 07 runs 365 fits: 193 XGBoost and 43 each of GNN, LightGBM, random forest and ridge. They run in three
    concurrent lanes, so that the whole section takes about 2.5–2.75 h:
    - XGBoost and the GNN share both GPUs through the GPU pool.
    - **LightGBM-GPU runs serially on GPU 1** (its OpenCL learner is not thread safe).
    - Random forest and ridge run on the CPU. This lane sets the overall time.
  - If the LightGBM GPU probe fails, LightGBM joins the CPU lane and adds about 1–2 h.
  - Section 08 (XAI) takes about 1 h, and section 11 (projections) about 1 h.
  - The per-lane busy time is logged after section 07 and stored in `metrics.json`.
- **Earth Engine (sections 03–05): never measured for v2.**
  - Pilot: about 3 h (1–8 h).
  - Full run after the pilot: about 2–3 h (1–6 h), because it reuses the pilot's tiles.
  - Fresh full run without the pilot: about 4–6 h (2–13 h).
- **Totals:**
  - Pilot: about 3 h (1–8 h). It is almost certain to fit one session.
  - Full run after the pilot: about 7.5–9 h. It fits one session in roughly two runs out of three.
  - Fresh full run: about 10–12 h. Plan for two sessions.
- **Resources (estimates, never logged):** about 4–10 of 29 GB RAM, about 6–8 GB of the ~15 GB on each T4, and about
  3–6 of 20 GB disk.
- **Kaggle GPU quota: 30 h per week**, reset Saturday 00:00 UTC.
  - Pilot plus full run take about 10–13 h, or about 14–18 h with one resume.
  - Start a long commit only with **12 h or more** of quota left. Otherwise set `LST_TIME_BUDGET_H` to the quota
    left minus 1 h.
  - Power off the interactive session after *Save Version*; otherwise both are charged.

**If a run does not fit.** The 11 h budget stops it cleanly: no new work starts after about 10.5 h, and the version
ends about 1 h before Kaggle's 12 h kill with the cache packed. The resume (step 9) typically takes 1–4 h.

**What actually helps.** The reliable lever is the `LST_STOP_AFTER=06` split (step 7). Dropping the GNN
(`LST_BENCHMARKS=ridge,random_forest,lightgbm,xgboost`) or using `LST_N_BOOTSTRAP=25` saves less than first
estimated: the GNN shares the GPUs with XGBoost, and the CPU lane is the critical path.

**What the safety net does not cover.** A crash outside the clock loses that session's unpacked work: running out
of memory, a native crash or hang, or running out of quota. The split before section 07 protects the Earth Engine
work against this.

---

## Local synthetic runs

Python 3.10+ with numpy, pandas, scipy, scikit-learn, xgboost, lightgbm, shap, torch, libpysal, esda, pylandstats,
shapely, pyproj, pyarrow and pillow (CUDA optional). No Earth Engine account is needed.

```bash
export PYTHONIOENCODING=utf-8
python notebook/build_notebook.py --check             # rebuild delhi_ncr_lst_pipeline.ipynb, compile every cell
python notebook/run_local.py --out outputs_smoke      # synthetic, fast profile, 2 km grid -> ALL SECTIONS OK
python notebook/run_local.py --grid-res 1000 --out outputs_1km    # 1 km synthetic run (fast profile)
LST_PROFILE=pilot python notebook/run_local.py --out outputs_pilot
python notebook/run_local.py --until 06 --out outputs_smoke      # stop after section 06
python notebook/validate_bundle.py outputs_smoke/web             # SPEC §5 validator (VALID / errors)
```

To refresh the dashboard demo, run the 2 km synthetic profile and replace the *contents* of
`dashboard/public/demo/` with `<out>/web/*` (validate first). In synthetic mode, sections 08, 09 and 11 print a
**planted-vs-recovered report** (thresholds, β, UHI signs, path offsets, calibration slopes, land-model skill against
its null model), which is the main correctness check of the science code.

---

## Outputs

| Path | Content |
|---|---|
| `outputs/web/` | dashboard bundle v2 (`manifest.json`, `cells.lstb.gz`, `cube_*.lstb.gz`, `xai_*.lstb.gz`, `raster/*.png`, `raster_index.json`, JSON summaries) |
| `outputs/web_bundle.zip` | the same bundle, zipped for download |
| `outputs/parquet/` | feature table, predictions, SHAP values, CV metrics |
| `outputs/geo/` | districts, zone polygons |
| `outputs/models/` | native XGBoost boosters per mode |
| `outputs/npz/` | SHAP interaction tensors |
| `outputs/figures/` | diagnostic figures |
| `outputs/cache/` | `stages/`, Earth Engine `tiles/` and GDDP-CMIP6 `gddp/` caches, packed into `packed/*.tar` on Kaggle (reusable by later runs) |
| `outputs/RUN_STOPPED.json` | only after a clean stop: reason, section, elapsed hours (removed by the next complete export) |

`outputs/` (and `outputs_*/`) is git-ignored.

---

## Dashboard: dev, build, deploy

The dashboard is a **Next.js 16** site (React 19) with two parts:

- **Content pages** (`/`, `/findings`, `/methodology`, `/learn`, `/data`, `/about`): statically generated at build
  time from the bundle in `public/data/` (`lib/site/facts.js`), so every number on them comes from the pipeline run.
  Each page has full SEO metadata (canonical, Open Graph, Twitter card) and schema.org JSON-LD (WebSite, Dataset,
  Article, FAQPage); the site has `sitemap.xml`, `robots.txt`, a web manifest and a generated 1200 × 630 social
  image. Lighthouse (mobile): 98–100 in performance and 100 in accessibility, best practices and SEO.
- **The explorer** (`/explore`): the interactive WebGL app (deck.gl + MapLibre), loaded client-only.

Requires Node 20.9+ (developed on Node 22). The explorer needs a browser with `DecompressionStream`
(Chrome/Edge 80+, Firefox 113+, Safari 16.4+); other browsers get an explicit unsupported-browser message.

```bash
cd dashboard
npm ci                         # or npm install
npm run dev                    # http://localhost:3000 (explorer: /explore)
npm run lint && npm test       # ESLint + Vitest
npm run build                  # production build (static pages + explorer)
npm start                      # serve the production build (http://localhost:3000)
npm run media                  # regenerate public/media/ after copying a new bundle into public/data/
```

**Choosing a bundle.** `/explore?bundle=data` (the user's bundle in `public/data/`), `?bundle=demo` (the synthetic
v2 demo in `public/demo/`) or `?bundle=fixture` (an in-memory synthetic fixture), also selectable in the Settings
menu. Without the parameter the explorer uses `NEXT_PUBLIC_DATA_BASE_URL` when set, else `data` when
`public/data/manifest.json` exists, else `demo`.

**Loading a new bundle.** Replace the contents of `public/data/` with `outputs/web/*` (or unzip `web_bundle.zip`
there), validate it with `python notebook/validate_bundle.py dashboard/public/data`, then run `npm run media` and
`npm run build`: the content pages pick up the new numbers automatically.

**Deploying on Vercel.** Import the GitHub repository in Vercel, set **Root Directory = `dashboard`** (the Next.js
preset is detected) and deploy. Canonical links, the sitemap and social cards use the production domain
automatically (`VERCEL_PROJECT_PRODUCTION_URL`); set `NEXT_PUBLIC_SITE_URL` once you attach a custom domain. Optional
variables are in `dashboard/.env.example` (`NEXT_PUBLIC_BASE_PATH` for a sub-path, `NEXT_PUBLIC_DATA_BASE_URL` for a
bundle hosted elsewhere with CORS). Explorer routing is hash-based (`/explore#/timeline` …) and its state (year,
mode, SSP, layer, camera) is kept in the hash, so links can be shared.

**Keyboard.** `1`–`6` views · `Space` play · `←/→` frames · `Home/End` 1990/2050 · `D`/`N`/`T`/`A` day, night,
toggle, diurnal range · `S` cycle SSP · `C` compare · `Z` lens · `G` grid/raster · `H` hottest cell · `B` Briefing ·
`Ctrl K` command palette · `?` all shortcuts.

**Bundle sizes.** Synthetic 2 km v2 demo: 24.3 MB in 80 files. Real v1 bundle: 17.1 MB in 13 files. A 1 km v2 bundle
is larger (every cube and XAI file scales with the cell count); `validate_bundle.py --max-mb` enforces a limit if you
need one.

---

## Data contract and research notes

- **`docs/SPEC.md`** is the binding v2 architecture and data contract: section interfaces, features, methods, every
  bundle file (LSTB container, cubes, manifest keys) and the definition of done. It overrides every other document.
- `docs/SPEC_v1.md`: the v1 contract (district table, v1 bundle format, still read by the dashboard).
- `docs/UI_SPEC_v2.md`: dashboard look, motion, interaction and accessibility.
- `docs/research/gee_datasets_v2.md`: verified Earth Engine recipes (bands, scale factors, QA bits).
- `docs/research/methods_v2.md`: validation, AOA, downscaling, land-change and projection methods with references.
- `docs/research/real_data_accuracy_experiments.md`: experiments on the real v1 bundle that motivated v2
  (focal features, pooled metrics, recentring).
- `docs/research/v2_review_changelog.md`: the adversarial review of v2: what it found and fixed, the binding
  decisions, the accepted limitations, the verification evidence and what still needs a real Kaggle + Earth Engine
  run.

---

## Scientific caveats

The bundle exports these in `manifest.notes` and the dashboard shows them (Caveats menu, Sources view).

**Day and night are different quantities.** Day is mid-morning (~10:30 IST) Landsat LST, not the afternoon peak;
night is ~01:30 IST MODIS Aqua-equivalent LST at 1 km. Both are **surface** (skin) temperatures, not air temperature.
By day the built-up core is often *cooler* than the bare, semi-arid fringe (negative surface UHI); at night it is
warmer.

**The record has evidence tiers.** The dashboard shows each frame's tier from the manifest:
- 1990/1995 day are *observed-sparse* (Landsat 5, fewer clear scenes; 3-year windows);
- 2005 day uses Landsat 7 SLC-off;
- 2000 night is *reconstructed* (Terra 22:30 calibrated to Aqua), 2025 night is VIIRS calibrated to Aqua, and
  1990/1995 night are *modelled* (hindcast), not observations;
- Terra and Aqua drift to earlier overpasses after ~2022; VIIRS is the stable night successor.

**One land-cover product.** GLC_FCS30D for all frames (2025 uses its 2022 map), built-up from GHSL P2023A; mixing
products caused ~1 °C offsets in v1.

**Pooled anomaly models.** The target is LST minus each frame's fixed-mask mean, with one model per mode across all
frames and no year feature or coordinates; absolute °C = anomaly + a frame level. Leave-one-epoch-out measures how
the spatial pattern transfers in time, not the regional climate offset.

**The 250 m night layer is downscaled, not observed.** It conserves every 1 km block mean; the scale-invariance test
in the Model Lab compares it honestly with bilinear interpolation (on the 2 km smoke grid it is slightly worse than
bilinear; at 1 km it is better).

**Projections are scenarios, not forecasts.** They combine CMIP6 deltas (NASA GDDP-CMIP6 has SSP2-4.5 and SSP5-8.5;
SSP1-2.6 is pattern-scaled from SSP2-4.5), an empirical dLST/dTair sensitivity, a cellular-automaton land-change model
and the model error. Weather of individual years is not predicted. Cells outside the **area of applicability** are
hatched: the model extrapolates there.

**SHAP explains the model, not causation.** A SHAP value is the push of a feature's current value relative to the
average cell. What-if scenarios and zone recommendations run on a compact browser surrogate of the final model
(R² ≈ 0.999 against it in the demo) and are model counterfactuals on the current land, not causal effects; effects of
several actions are not additive.

**Bootstrap intervals** are block-bootstrap replicate ranges re-centred on the full-data estimate; thresholds found
by few replicates are flagged as tentative.

**Synthetic results validate code, not the region.** The planted-vs-recovered reports show that the pipeline
recovers a known response; they say nothing about the real NCR.

---

## Validation status

Tested (synthetic mode, mocks for Earth Engine):
- `build_notebook.py --check`; `run_local.py` end to end at 2 km and 1 km (fast) and with the pilot profile: `ALL
  SECTIONS OK`, bundles VALID; the real v1 bundle in `public/data/` still VALID.
- The Earth Engine sections 03–05 against mock Earth Engine harnesses, and sections 06–12 on the gee-mode namespace:
  identical structure to the synthetic path and a valid bundle.
- The clean stop (`LST_STOP_AFTER`, a tiny `LST_TIME_BUDGET_H`) and the resume from a packed cache imported from
  another folder (as with an attached notebook output): the stopped runs exit successfully, and the resumed runs
  reuse the finished stages and end with a VALID bundle.
- Dashboard: lint, 574 unit/render tests in 47 files (incl. LSTB decoding of Python-written fixtures, the v1 adapter,
  accessibility checks), production build, JS budgets, and headless-browser smoke runs (Edge) on the demo and the
  real v1 bundle with zero console or page errors.
- An adversarial review of v2 (91 findings, 68 fix tasks) and its re-tests: see
  `docs/research/v2_review_changelog.md`.

Tested with real Earth Engine data (2026-10/11):
- **Pilot Earth Engine extraction (sections 01–06) on a local PC.** It took about 11–17 min per Landsat frame and
  about 13 min for section 04. It found and fixed:
  - an ERA5 query that exceeded Earth Engine's memory limit;
  - mixed band types in MODIS/VIIRS;
  - the Chen-2020 layer dates;
  - the night minimum observation count, lowered to 3;
  - the urban-core threshold, lowered to 0.3.

  It also measured the Earth Engine cost: about 35–45 EECU-hours per Landsat frame.
- **A Kaggle rehearsal** in Jupyter, using only the code zip and the cache zip: all 13 sections OK in 41 min on a
  GTX 1650, with the bundle VALID. Real-data pilot cross-validation (XGBoost, spatial blocks of 20 km):
  - day: R² 0.94, RMSE 1.15 °C;
  - night: R² 0.79, RMSE 0.75 °C.

Not yet tested:
- The full-profile Earth Engine extraction (frames 1995/2005/2010/2015 and the 3-SSP CMIP6 projections), the asset
  export, and the runtime on 2× T4.
- Resume through Kaggle's own notebook-output attachment (tested locally with an imported cache folder), and the
  launcher on Kaggle itself (tested locally in Jupyter with simulated `/kaggle/input` layouts; its code checks also
  under Python 3.12, 3.13 and 3.14).
- The GNN and RAPIDS paths on CUDA.
- A real v2 bundle in the dashboard (only the synthetic demo and the real v1 bundle exist).
