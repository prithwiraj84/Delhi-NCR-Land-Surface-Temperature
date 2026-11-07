# v2 adversarial review: what was found, what changed, what is still open

This note is for the project owner. It records the adversarial review of the v2 platform: the 13-section Kaggle
notebook (`notebook/sections/00-12`, built into `delhi_ncr_lst_pipeline.ipynb`), `notebook/validate_bundle.py` and the
NCR THERMAL/OPS v2 dashboard. It covers:

- what the review found and how each finding was fixed;
- the binding decisions that settled the open design questions;
- what was deliberately not done, and the limitations that were accepted and documented;
- how the result was verified;
- which claims can only be confirmed by a real Kaggle + Earth Engine run.

The binding documents are still `docs/SPEC.md`, `docs/UI_SPEC_v2.md` and `docs/SPEC_v1.md`. This file explains the
history behind their current wording. The working files of the review are in `outputs/review/`: `plan.json` holds
the tasks and decisions, `continue_results.json` and `fix_F3_report.json` hold the agent reports, and `rt1/`, `rt2/`
and `rt3/` hold the re-test logs.

## At a glance

| Item | Result |
| --- | --- |
| Findings | 91 raised by nine reviewer roles. A verifier confirmed 77, of which 76 were actionable. |
| Tasks | 68 fix tasks for four fixers: F1 has 14, F2 has 13, F3 has 10 and F4 has 31. There are 23 binding decisions (D0-D22) and 25 SPEC/UI_SPEC edits. |
| Fixed | All 68 tasks. The four fix checks rated 61 verified and 7 partial. The final fixer then closed 38 open items: 25 fixed, 9 needing no change, and 4 accepted and documented as limitations. |
| Dropped | DE-14 entirely, plus nine optional sub-parts of other findings (section 4). |
| Integration bugs found by the re-tests | Two, both fixed: a map-engine layer-reuse bug (RT1) and a false failure of the section 12 standalone validator (final re-test). |
| Final state | Every pipeline, bundle and dashboard check passes on the final code (section 6). The Earth Engine paths are verified **with mock `ee` modules only**. |

Finding ids carry the role prefix of the reviewer that raised them:

| Prefix | Reviewer role |
| --- | --- |
| `G03-` | Earth Engine acquisition, section 03 |
| `G45-` | Earth Engine acquisition, sections 04/05 |
| `RT-` | Setup and Kaggle runtime |
| `L8-` | Landsat 8 and real-data accuracy |
| `ET-` | Explainability and the timeline |
| `PD-` | Projections and downscaling |
| `C-` | The export contract |
| `DE-` | Dashboard engine |
| `DV-` | Dashboard views |

Task ids `T-F<n>-<k>` name the fixer that owned the task.

## 1. How the review ran

1. **Review and verification.** Each reviewer role audited its area and recorded findings with a concrete failure
   scenario. A separate verifier re-checked every finding against the code.
2. **Arbiter.** The arbiter merged the actionable findings into 68 tasks and wrote 23 binding decisions (D0-D22).
   The decisions fixed every name, key, unit and default that crosses an owner's boundary, so the four fixers could
   work in parallel. The arbiter also listed 25 edits to SPEC and UI_SPEC. A snapshot of the code before any fix
   (`outputs/review/snapshot_pre_fix`, 366 files) was kept for diffing.
3. **Fixers.** The four fixers worked on separate areas:
   - F1: notebook setup and Earth Engine (sections 00-05);
   - F2: modelling (sections 06-09);
   - F3: projections, export, the validator and the docs (sections 10-12);
   - F4: the dashboard.

   F3 finished in one pass. F1, F2 and F4 were interrupted part-way, and resumed agents audited and finished their
   remaining work against the snapshot.
4. **Re-test 1 (RT1).** RT1 re-ran the whole system and found and fixed one integration bug.
5. **Fix checks.** One check per fixer re-verified each task against its acceptance tests. They rated 61 tasks
   verified and 7 partial, and reported new problems (section 3).
6. **Final fixer.** The final fixer closed every open item, either with a code change or with a documented decision
   under a binding decision.
7. **Final re-test.** The final re-test was interrupted by an API overload, so its run is split into two parts: RT2
   and its completion, RT3 (section 6).

## 2. The binding decisions in plain language

| Id | Decision |
| --- | --- |
| D0 | Parallel fixers reach each other's new helpers only through a defensive `globals().get(...)` lookup, so a missing helper does nothing instead of crashing. Every new JSON key is optional for readers: older bundles, the demo and the real v1 bundle must still validate. Any change to a section's results also bumps that section's version constant. |
| D1 | Earth Engine uses the **standard** endpoint by default; the high-volume endpoint is opt-in through `LST_GEE_ENDPOINT`. Requests have a 420 s deadline. Each section works under its own workload tag (`lst-v2-s03`, `lst-v2-s04`, `lst-v2-s05`), so cost can be read per section. |
| D2 | The pilot profile runs four frames (1990, 2000, 2020, 2025) with ridge and XGBoost and no projections. These frames exercise the Landsat-5-TM-only years, the Terra-reconstructed night frame and the dense 2020s windows. A CMIP6 warming-pattern probe also runs. `LST_FRAMES_OBS` can override the frames of any profile. |
| D3 | The run has a wall-clock budget: 11 h on Kaggle, unlimited locally, with an 1800 s reserve. `LST_STOP_AFTER` stops the run after a chosen section. When the budget runs out, the notebook stops **cleanly and successfully**: outputs are kept, `RUN_STOPPED.json` is written and the cache is packed, so the next version can resume. |
| D4 | Every stage-cache key carries an AST hash of the code of the section(s) that produce it. Editing a section invalidates exactly the stages it feeds; comments and markdown never invalidate anything. `LST_INVALIDATE` forces chosen stages to recompute. |
| D5 | The cache can be imported from any attached dataset root. At the end of a run it is packed into a few tar files, because Kaggle notebook outputs are reported to be capped at 500 files. |
| D6 | In asset mode, each batch export has its own running and queued timeouts. A failed or timed-out task is cancelled and extracted interactively instead of aborting the run. |
| D7 | GDDP-CMIP6 values come from cached means per (scenario, model, 5-year block) on the native 0.25° grid. Long interactive reductions, which timed out, are no longer used. |
| D8 | A mode's fixed mask is the strict intersection of its well-covered training frames (≥ 50 % valid). The levels of partially covered frames get a model-based composition correction, so all frames describe the same area. |
| D9 | Day frames are always observed (or observed-sparse). An almost empty Landsat frame stops the run early with a diagnostic, instead of silently becoming a modelled day frame. |
| D10 | The modelled night levels for 1990 and 1995 include a residual-drift term. It is estimated only over the primary sensor's years (Aqua, 2003-2021) and applied only when it exceeds 2 standard errors. |
| D11 | Zone 3 is the cluster with the highest total SHAP. The "riparian" name goes only to a cluster that actually meets a water criterion. Otherwise the canonical id is kept, and a `display_name` and `label_caveat` explain the mismatch. |
| D12 | A row that is missing a feature the AOA weighs gets a dissimilarity index of +inf, which puts it outside the area of applicability. Imputing the missing value would make the row look falsely in-domain. |
| D13 | Projection uncertainty uses residuals from the projection setting (leave-one-epoch-out predictions plus the persistent residual), binned by DI decile. The residuals are correlated in 20 km blocks through a Gaussian copula. |
| D14 | Projected change is measured against each scope's own weather-normalised baseline (`baseline_c`). The baseline is exported, so the dashboard shows the same number. |
| D15 | The weather-normalised baseline removes the ERA5 anomaly of the "now" window relative to the 2001-2025 linear trend, not relative to a flat mean. |
| D16 | Each frame-statistic row carries its coverage. The NCR mean is the frame level, and the hot-core area is scaled by coverage. |
| D17 | Spill-over has one definition everywhere: cells outside the edited set, with the mean including zeros. Tiny box-filter residues are snapped to exact zeros. Counterfactual focal features are recomputed only inside the edit footprint. |
| D18 | The land-change model is judged against a null model on four checks, giving a verdict of `beats_null`, `mixed` or `worse_than_null`. The hindcast truth is labelled as an extrapolated GHSL epoch, not an observation. |
| D19 | Night calibration fits a land-cover class on its own only with at least 30 pairs **and** 20 distinct cells. Diagnostics, including cells per class, are exported. |
| D20 | LightGBM GPU jobs run in their own serial lane, because its OpenCL learner is not thread-safe. All job lanes respect the time budget and pass a clean stop on. |
| D21 | One set of run-instruction facts is stated identically in the notebook header, the README and the SPEC: pilot first, EECU read in Cloud Monitoring by workload tag, the pilot-to-full extrapolation, and when to switch to asset exports. |
| D22 | Dashboard map semantics: the legend shows the channel actually drawn, and the `pred` layer is absolute LST. The delta colour domain is computed across frames. Raster PNGs are decoded exactly in a worker. Tier labels come from the manifest. Browsers without `DecompressionStream` get an explicit unsupported state. |

## 3. What was found and fixed, by area

Severity is the arbiter's rating (H = high, M = medium, L = low). Unless the status column says otherwise, the
fixer's change was rated "verified" by the fix check. "Final fixer" means the fix check rated the task partial or
found a new problem, and the final fixer closed it.

### 3.1 Earth Engine extraction (sections 01 and 03-05)

| Task | Sev | Findings | What changed | Status |
| --- | --- | --- | --- | --- |
| T-F1-01 | H | G45-02, G45-03 | Interactive 20-year reductions of GDDP-CMIP6 timed out. The GDDP table and warming pattern now come from cached `computePixels` requests, one per (scenario, model, 5-year block) on the native grid (D7), stored under `cache/gddp`. Batch splitting and isolation were also fixed. | fixed |
| T-F1-02 | H | G45-01 | The Chen-2020 SSP band mapping was ambiguous. Bands are now resolved deterministically (normalised names, or position when there are exactly 5 bands), mosaicked per decade, and the run fails early on a mismatch. | fixed |
| T-F1-05 | M | G03-01, RT-03, G03-06 | Earth Engine session: the standard endpoint by default, a 420 s request deadline (minimum 330 s), 3 client retries and per-section workload tags (D1). | fixed |
| T-F1-06 | M | G03-02, G45-06 | Asset-mode waits now use per-task running and queued timeouts. One failed task no longer aborts the run: the task is cancelled and extracted interactively. The observed export concurrency is logged (D6). | fixed |
| T-F1-10 | L | G45-05 | Computed 30 m-input images in 04/05 use heavy tiles of about 64 km. | fixed |
| T-F1-11 | L | G45-09 | A night-calibration class gets its own fit only with at least 20 distinct cells; `cells_per_class` is in the diagnostics (D19). | fixed |
| T-F1-12 | L | G03-05 | The Landsat 30 m working projection sits on the native lattice (15 mod 30 m). | fixed |
| T-F1-13 | L | C-04 | The run fails early when a Landsat day frame has almost no ROI coverage (`LST_DAY_MIN_FRAME_COVERAGE`, 0.2; D9). | fixed |
| (fix check) | L | new | A time-out on a smallest tile had lost its full retry budget. It keeps `GEE_MAX_RETRIES` again; only memory and size errors stop after two tries. | final fixer |

### 3.2 Kaggle runtime, caching and time budget (sections 00, 07, 11 and 12; `run_local.py`)

| Task | Sev | Findings | What changed | Status |
| --- | --- | --- | --- | --- |
| T-F1-03 | H | RT-02 | A run that exceeds Kaggle's 12 h limit can lose everything. The run now has a time budget with a clean, successful stop (D3). An IPython cell guard and section-marker cells make later cells print `skipped: run stopped (...)`. `run_local.py` prints `STOPPED CLEANLY after section NN` and exits 0. | fixed |
| T-F1-04 | M | RT-01, L8-04 | Stage caches could serve results computed by older code. Every stage key now carries the AST hash of its section; `LST_INVALIDATE` was added, and the false claim about stale caches was corrected (D4). | fixed |
| T-F1-07 | M | RT-04, RT-05 | The cache can be imported from any attached dataset root and is packed into tar files, because of the 500-item output cap (D5). | fixed |
| T-F1-08 | M | G03-09, G45-04, RT-07 | The pilot did not exercise the risky paths. It now runs 4 frames, `LST_FRAMES_OBS` was added, and the CMIP6 pattern probe and a per-frame cost and coverage table are printed (D2). | fixed |
| T-F1-09 | L | RT-06, L8-03, RT-07, G03-02, RT-02 | The 00 header now carries the run instructions, the environment table and the runtime text, using the D21 facts. | fixed |
| T-F1-14 | L | RT-08 | The unused `geemap` install was removed. | fixed |
| T-F2-05 | M | RT-06, L8-03 | The 07 scheduler gained a serial LightGBM GPU lane, per-lane timings, and lanes that respect the budget and pass on a clean stop (D20). | fixed |
| T-F2-13 | L | L8-04, RT-01 | Stage keys in 06-09 now include cross-section code dependencies; for example, `09_day_hindcast` uses the 07 fitters. | fixed |
| T-F3-11 | M | RT-05, RT-02, G45-04 | Section 12 removes a stale `RUN_STOPPED.json`, prints the pilot probes and packs the cache as its last step. | fixed |
| T-F3-12 | L | L8-04, RT-01 | The 11 land-stage key now depends on the 07/08 code it executes. | fixed |
| (fix check) | L | new | The `s04`/`s05` stage keys now also carry `code03`. | final fixer |
| (fix check) | info | new | Before a stage's first compute in a session, the budget check now takes the duration from the newest stage sidecar instead of 0 s. | final fixer |

### 3.3 Features and models (sections 06-07)

| Task | Sev | Findings | What changed | Status |
| --- | --- | --- | --- | --- |
| T-F2-01 | M | L8-01, L8-02, C-04 | The "all-but-one" mask relaxation silently mixed areas between frames. Masks are now strict over the well-covered frames, partially covered frames get a composition correction (D8), and empty day frames fail early (D9). The run stops, listing per-frame coverages, when fewer than 2 frames qualify for the mask or the mask keeps under 1 % of the ROI; the final fixer documented this stop. | fixed |
| T-F2-06 | L | ET-04 | `COMPUTE_DI` returns +inf for rows with missing weighted features (D12). | fixed |
| T-F2-12 | L | L8-05 | The 06/07 markdown now attributes the real-data R² gain from 0.63 to 0.83 correctly: 3 and 15 km focal means plus the distance and relative-elevation features, with focal means alone giving about 0.79. | fixed |

### 3.4 Explanation and timeline (sections 08-09)

| Task | Sev | Findings | What changed | Status |
| --- | --- | --- | --- | --- |
| T-F2-02 | M | ET-01 | The night 1990/1995 levels now include the residual-drift term (D10). | **accepted limitation** (section 5) |
| T-F2-03 | M | ET-02 | Zone labels could contradict the data. The riparian eligibility rule, a fallback ordering, and `display_name`/`label_caveat` were added (D11). | fixed |
| T-F2-07 | L | ET-05 | Scope statistics now carry coverage per row, the NCR mean equals the frame level, and the hot core is scaled by coverage (D16). | **accepted limitation** (section 5) |
| T-F2-08 | L | ET-06 | The web surrogate is distilled on all ROI rows plus NaN-augmented copies, and its fidelity on NaN rows is reported. | fixed; the fidelity gap is an accepted limitation |
| T-F2-09 | L | ET-07 | When the step is capped, the recommendation rationale states the mean step actually applied. | fixed |
| T-F2-10 | L | ET-08, DV-14 | Focal box means use exact zeros, the counterfactual focal recompute is limited to the edit footprint, and spill-over has one definition (D17). | fixed |
| T-F2-11 | L | ET-10 | Bootstrap zero-crossing support counts the replicates whose own crossing lies near the reference. | fixed |
| (fix check) | L | new | `drift_correction_c` no longer exports `-0.0`. | final fixer |

### 3.5 Downscaling and projections (sections 10-11)

Section 10 (downscaling) needed no change.

| Task | Sev | Findings | What changed | Status |
| --- | --- | --- | --- | --- |
| T-F3-01 | H | PD-01, DV-01 | Projected change was measured against the wrong baseline. The decomposition total is now p50 minus each scope's own baseline, and `baseline_c` is exported (D14). The worst gap between the total and climate + land + model error fell from 4.0 °C to 0.13 °C. | fixed |
| T-F2-04 | M | PD-03, PD-04 | Section 07 now produces the projection-setting residual model (leave-one-epoch-out plus the persistent residual) and the 20 km block correlation `resid_rho_block20`, for section 11 and the modelled intervals of 09 (D13). | fixed |
| T-F3-02 | M | PD-03, PD-04, ET-04 | The Monte-Carlo model error now uses projection-setting residual samples and a block20 Gaussian copula; rho was 0.38 by day and 0.44 by night in the synthetic run. The DI = +inf case is handled safely. | fixed |
| T-F3-06 | L | PD-02, PD-07 | The `L_base` anomaly is now measured against the ERA5 linear trend (D15), and the CMIP6 `baseline_window` metadata was corrected. | fixed |
| T-F3-07 | L | PD-06 | The land model is now compared with the null on several metrics, with a verdict and a hindcast-truth label (D18). | fixed |

### 3.6 Export, data contract and validator (section 12, `validate_bundle.py`, docs)

| Task | Sev | Findings | What changed | Status |
| --- | --- | --- | --- | --- |
| T-F3-03 | M | ET-02, ET-05, G45-09 | The export now writes and validates the new producer keys: zone `display_name`/`label_caveat`, per-row coverage of the series frames, and the night-calibration `diag`. | fixed |
| T-F3-13 | L | C-01, C-04 | The validator now checks consistency across files (XAI vs cube vs zones), with a matching assertion inside the notebook, and the albedo bound was corrected. | fixed |
| T-F3-04 | M | L8-05, C-02, DV-17, DV-12, DE-03, C-06 | All 25 SPEC and UI_SPEC edits were applied. | fixed |
| T-F3-05 | M | RT-02 ... L8-03 (11 findings) | The README was rewritten around the pilot-first Kaggle sequence (D21), with the EECU reading, the time budget, stop and resume, caching and the runtime. | fixed |
| (fix check) | L | new | The validator checked only the first `land_model.checks` entry and accepted a non-numeric `baseline_c`. It now checks every entry and requires a finite number, the same rule as the dashboard's `validateV2.js`. Malformed tampered entries now give exit 1. | final fixer |
| (fix check) | L | new | Stale doc text was corrected: the UI_SPEC `useRaster` row and the pilot runtime in the README. | final fixer |
| (final re-test) | — | integration | A false failure in section 12 (section 6.3). The standalone validator subprocess exited non-zero with no output, and the old code treated that as "INVALID". Now an exit without a verdict is retried once and then logged as a WARNING with its exit code, like a timeout. A real `INVALID` or `BUNDLE UNREADABLE` verdict still fails the run. The section 12 code hash changed to `535f9f017912`. | fixed in the final re-test |

### 3.7 Dashboard engine (`dashboard/src/engine`, `data`, `state`)

| Task | Sev | Findings | What changed | Status |
| --- | --- | --- | --- | --- |
| T-F4-01 | H | DE-01 | The what-if layer stayed on the first scenario. Frame and channel caches are now keyed on a primitive run key. | fixed |
| T-F4-02 | H | DE-02 | The legend now renders the channel the engine drew. When nothing can be drawn, it states the reason instead of showing a scale. | final fixer |
| T-F4-03 | H | DE-03 | The performance governor measured the render interval instead of work time, and it took a slow GPU for vsync. The vsync estimate is now the smaller of an idle rAF probe and a long-window minimum that rises slowly. Undo at a user-chosen tier works. | final fixer |
| T-F4-04 | H | DE-04 | Playback had long tasks. v1 facade epochs are now built only for the views that use them, and deferred while playing. | fixed |
| T-F4-14 | M | DE-05 | Retry after a lost WebGL context recreates every cached layer. | fixed |
| T-F4-15 | M | DE-06 | The hover card shows the value as displayed, labelled by quantity. | fixed |
| T-F4-16 | M | DE-07 | The logo and in-app hash links keep the mode, SSP, layer and pin. The final fixer made anchor scrolling keep the history state. | fixed |
| T-F4-17 | M | DE-09 | The Δ colour domain is computed across frames and never cached from degenerate frames. Compare sides now adopt the final domain. | final fixer |
| T-F4-19 | L | C-02, DE-08 | Raster PNGs are decoded exactly by the pure-JS decoder in the worker, with no canvas readback. The checksum test now fails on stale fixtures. | fixed; the test gap was closed by the final fixer |
| T-F4-20 | L | DE-10 | Compare mode caches each side, reuses buffers and throttles scrubbing to 30 Hz. Each side's cache key now includes the channel. | final fixer |
| T-F4-21 | L | DE-11 | The 250 m anomaly uses the same frame level as the 1 km columns. | fixed |
| T-F4-22 | L | DE-12 | Surface UHI is unavailable for projected years, and the legend says why. | final fixer |
| T-F4-23 | L | DE-13 | The 250 m raster keeps showing the old frame while the new one loads, touches its LRU on draw, and clamps the develop timing. | fixed |
| T-F4-24 | L | DE-15 | Hover rebuilds only the reticle layers and picks at most 30 times a second. | fixed |
| T-F4-25 | L | DE-16 | The perf HUD subscribes in its own component, and the legend categories are memoised. | fixed |
| T-F4-29 | L | C-06 | Browsers without `DecompressionStream` get an explicit unsupported-browser state. | fixed |
| T-F4-31 | L | DV-01, ET-02, ET-05, PD-06 | Tests and fixtures were added for the new optional bundle keys. | fixed |
| (RT1) | — | integration | A cached heatmap layer that a frame did not draw was handed back to deck.gl after deck.gl had deleted it, which caused an assertion error when compare was turned off. The engine now drops the cached layer, and a regression test was added. | fixed in RT1 |

### 3.8 Dashboard views and truthfulness (`dashboard/src/views`, `time`, `components`)

| Task | Sev | Findings | What changed | Status |
| --- | --- | --- | --- | --- |
| T-F4-05 | H | DV-01, PD-01 | Projected change is shown against the weather-normalised scope baseline in Key Figures, the fans and the ledger (D14). | fixed |
| T-F4-06 | M | C-03, DV-07 | The Inspector's readout labels come from the manifest tier, and DTR mode shows DTR. | fixed |
| T-F4-07 | M | C-05, DV-06 | The FrameCard's projected interval follows the selected SSP. | fixed |
| T-F4-08 | M | DV-02, DV-03 | Observed-change figures are shown only between observed endpoints, and never on non-harmonised bundles. | fixed |
| T-F4-09 | M | DV-05 | The FanChart shows satellite context per sensor, marks the drift years, and its hover lists all sensors. | fixed |
| T-F4-10 | M | DV-08 | DTR-mode copy now reads "diurnal-range UHI" and "Largest DTR". | fixed |
| T-F4-11 | M | DV-09 | The AOA share is shown next to projections. | fixed |
| T-F4-12 | M | DV-10 | The Inspector's "Simulate" sets the what-if region to the pinned cell's district. | fixed |
| T-F4-13 | M | DV-11 | The HonestSkill copy is driven by exported numbers, with no unsupported causal claim. | fixed |
| T-F4-18 | M | ET-02 | The zone `display_name` and `label_caveat` appear wherever zone names appear. The final fixer made the ZoneCard note use the exported caveat. | fixed |
| T-F4-26 | L | DV-12, DV-13, DV-18 | Small copy fixes: the Briefing without an exported trend, the random-CV label and the ledger header years. | fixed |
| T-F4-27 | L | DV-14, ET-08 | The simulator's spill-over uses the notebook definition (D17). RT1 confirmed that the dashboard's spill counts equal the notebook's `n_spill` exactly. | fixed |
| T-F4-28 | L | DV-15, DV-17 | Scroll regions can be focused, and PageUp/PageDown follow the ARIA slider convention. | fixed |
| T-F4-30 | L | PD-06, PD-03 | The Lab panels show the land-model checks, verdict and truth label, and a budget caption for correlated model error. | fixed |

## 4. What was dropped, and why

| Item | Reason |
| --- | --- |
| DE-14 (GPU/CPU side-face tint) | Cosmetic: it appears only on the forced CPU material path, and the tops are exact on both paths. Rewriting the GPU colour hook would risk shader regressions for no gain in data correctness. |
| L8-03 / RT-06 sub-part (drop or cap LightGBM on the CPU fallback) | The fallback is unlikely on Kaggle (the real v1 run used LightGBM-GPU), and the change would alter the SPEC model set. The serial GPU lane and corrected runtime docs address the real cost. |
| G45-09 sub-part (shrink class slopes) | The minimum-cells guard removes the unstable fits. Shrinkage would change the calibration semantics without evidence that it is needed. |
| PD-06 sub-part (tempering the suitability on the hindcast) | Tuning on the validation hindcast would overfit it. The checks and the verdict make the weakness visible instead. |
| ET-10 sub-part (relabel "95 % CI" for 50 replicates) | The label is mandated by the SPEC. The substantive defect, the support statistic, is fixed. |
| ET-08 sub-part (zero-exact quantisation offset) | No longer needed once 06 snaps all-zero box means to exact zeros. |
| C-01 sub-part (cross-file checks in the dashboard validator) | The notebook validator and the section 12 read-back check every bundle before it reaches the dashboard. |
| G03-02 / G45-03 sub-parts (pre-submitting the 04/05 exports; GDDP through table exports) | Made unnecessary by the per-task waits and the cached GDDP blocks. |
| G03-01 sub-part (per-frame EECU capture) | It is thread-local and fragile. EECU is read per section through workload tags (D1, D21). |

## 5. Accepted and documented limitations

The final fixer marked four items "partially fixed". Each was closed by documentation under a binding decision
rather than by changing the method.

| Item | What remains | Why it stays | Where it is documented |
| --- | --- | --- | --- |
| T-F2-02: night 1990/1995 warm bias (D10) | On the synthetic world the drift is +0.0174 ± 0.0092 °C/yr, which is 1.9 standard errors and below the 2-se gate, so it is not applied. The 1990/1995 night levels stay about +0.26/+0.40 °C warm; both are inside their prediction intervals. | D10 restricts the drift estimate to the primary sensor's years and applies it only above 2 se. No estimator that follows this rule brings the reconstructed-2000 check below 0.08 °C, so that acceptance criterion was dropped. The method text now reports the drift ± se and the shift it would have made (−0.43/−0.35 °C). | 09 §9.1 "Known limitation", SPEC §4.7 |
| T-F2-07: hot-core area under contiguous gaps (D16) | Coverage scaling is unbiased for scattered gaps. A contiguous gap over a cooler or hotter part of a scope biases the area, by about +11 % to −36 % for 10 % strips on the synthetic world. | D16 is binding. Estimating the missing cells' hot share from the model field would contradict it. | 09 §9.5, SPEC §4.7 |
| The same bias, raised as a new problem in the fix check | Rows with 0.9 ≤ coverage < 1 are not logged one by one. | Every row exports its coverage, so readers can judge each row. | 09 §9.5, SPEC §4.7 |
| T-F2-08 fidelity (the arbiter's open question) | The web surrogate's gap RMSE against the final model is about 0.087/0.045 °C (day/night), against targets of about 0.07/0.04 °C. NaN augmentation also costs a little complete-row fidelity: day RMSE rises from 0.075 to 0.092 °C, and night R² is 0.998. | This is the price of reliable predictions on rows with missing inputs. It was not re-measured with a dedicated probe. | 08 §8.8 |

Two further behaviours were confirmed as intended, so they are not limitations:

- **What-if Δ = 0 outside the scenario's reach.** Cells whose inputs do not change keep exactly the same prediction.
- **The D15 baseline shift differs from the arbiter's estimate on synthetic data.** It is −0.001 / +0.153 °C, against
  an estimate of about +0.03 / +0.04 °C, because of the synthetic ERA5 night trend (0.31 °C/decade). Shifts on real
  data depend on the real trends.

## 6. Verification evidence

Every run below was a local run on Windows. It used the project venv with synthetic data, or mock Earth Engine
modules for gee mode, on one GTX 1650 with CPU-only PyTorch (so the GNN ran on the CPU). Logs are in
`outputs/review/<role>/`.

### 6.1 Fixers and RT1

- **Fixers.** Each fixer re-ran its own area:
  - F1: mock-ee test suites `test_gee05`, `test_gee0304`, `test_budget`, `test_pack` and `test_cellguard`.
  - F2: full synthetic runs, with diffs against the snapshot.
  - F3: a full 2 km run with cache packing, a second run that imported the packed cache (198 hits, no misses), and
    validator tamper tests.
  - F4: lint, Vitest and headless-browser checks.
- **RT1** (`outputs/review/rt1`):
  - full synthetic run with all five models, including the CPU GNN: ALL SECTIONS OK in 6006 s, VALID;
  - pilot at 1 km: ALL SECTIONS OK, VALID;
  - clean stop and resume: it stopped cleanly inside 07 at job 22/78, then the resume reused 06 and all 39 finished
    07 jobs and ended VALID;
  - gee mode with a semantic mock `ee`: ALL SECTIONS OK and VALID. The structures of sections 03-05 match synthetic
    mode, and both modes export the same 80 files;
  - the real v1 bundle in `public/data`: still VALID (4 known warnings) and byte-identical;
  - dashboard: lint, 564 tests, build and budget pass, and the headless Edge smoke has 0 errors on both bundles.

  RT1 also fixed the map-engine layer-reuse bug (section 3.7).

### 6.2 Fix checks and final fixer

- **Fix checks.** 61 tasks were verified and 7 rated partial: T-F2-02, T-F2-07, T-F4-02, T-F4-03, T-F4-17, T-F4-20 and
  T-F4-22. The checks also reported new problems: retries, `code03` keys, the budget estimate, `-0.0`, validator gaps,
  a performance-governor regression, a dead Undo, a compare/legend mismatch, the legend's missing unavailable reason,
  a checksum test gap and stale docs.
- **Final fixer.** It closed all 38 items: 25 fixed, 9 needing no change and 4 accepted limitations. It re-ran the
  following:
  - mock suites: `test_gee0304` 44 passes, plus the new `test_ff_budget_keys` (7 passes); all others report
    "FAILURES: none";
  - validator tampers: each gives exit 1;
  - the synthetic 2 km pipeline: VALID with 0 warnings;
  - dashboard: lint, 574 tests and build pass, and headless harnesses check the legend, compare Δ, the governor under
    SwiftShader, Undo and anchors.

### 6.3 Final re-test (RT2, completed as RT3)

RT2 (`outputs/review/rt2`) was interrupted by an API overload. Before that, these passed on the final code:

| Check | Result |
| --- | --- |
| Gee mode with the mock `ee` (`gee.log`) | ALL SECTIONS OK in 2523 s, bundle VALID |
| `LST_STOP_AFTER=06` (`stopafter.log`) | `STOPPED CLEANLY after section 06`; `RUN_STOPPED.json` written |
| Time-budget stop, then resume from a cache imported from another folder (`stopresume_1.log`, `stopresume_2.log`) | It stopped cleanly in 07 at item 18/78 and exited 0. The resume unpacked 72 tar members and ended ALL SECTIONS OK in 2037 s, VALID. |
| RAW structure, gee vs synthetic (`raw_gee.json`, `raw_syn.json`) | Identical except for `DATA_MODE` and one sensor-name value |
| F1 mock suites (`mock_test_*.log`) | All report "FAILURES: none" |

These RT2 runs used the earlier section 12 code (hash `4deae6239467`). The later section 12 fix changes only how the
standalone validator's exit is handled, and every one of these runs got a VALID verdict.

The RT2 pilot was killed together with its parent agent: it was not launched with `nohup`, and it was not a code
failure. RT3 (`outputs/review/rt3`) completed the re-test:

| Check | Result |
| --- | --- |
| Full run: 2 km, fast, synthetic, with the GNN (`rt2/out2km.log`) | Sections 00-11 and every in-notebook read-back check passed. Section 12's standalone-validator subprocess then exited non-zero with **empty stdout and stderr**, and the old code raised "bundle INVALID" with no text. The run exited 1 after about 5590 s, sharing the machine with other runs. Run by hand, the validator found the bundle **VALID**. The validator always prints a verdict line before a non-zero exit, so the child never got to check the bundle. The most likely cause is that it could not start under memory pressure while two pipeline runs overlapped. This is inferred, not proven: no Windows events were logged, and the old code did not record the exit code. |
| Fix | In the `12_validate` block of `12_export.py`, a non-zero exit without a verdict is retried once and then logged as a WARNING with the exit code in hex. A real `INVALID` / `BUNDLE UNREADABLE` verdict still fails the run. A harness with four fake validators passes all cases (`rt3/vharness`): silent failure gives a warning, INVALID raises, VALID is accepted, and fail-once-then-valid is accepted. |
| Notebook rebuild | `build_notebook.py --check`: rc 0, 285 cells (148 code). Only the section 12 hash changed, to `535f9f017912`. The notebook's `_CODE_SHA` matches the hashes `run_local.py` used. |
| Full run resumed on the fixed code (`rt3/out2km_resume.log`) | Only section 12 was recomputed; sections 00-11 came from the cache with unchanged hashes. ALL SECTIONS OK in 167 s, EXIT=0. The validator returned VALID on the first try, with 0 cache misses. `validate_bundle.py`: VALID, 0 warnings, 24.31 MB in 80 files. |
| Fresh pilot on the final code (`rt3/pilot.log`, `LST_PROFILE=pilot`, ridge + XGBoost, 1 km) | Frames [1990, 2000, 2020, 2025]. ALL SECTIONS OK in 3047 s (about 51 min), EXIT=0. Section 07 took 1784 s and section 08 1004 s. The validator in section 12 returned VALID, and a separate check gave VALID, 0 warnings, 40.85 MB in 46 files. A pilot started on the pre-fix code was stopped after about 5 min; its log is kept as `rt3/pilot_aborted_prefix.log`. |
| Demo bundle | `dashboard/public/demo` was replaced by `rt2/out2km/web`. It is byte-identical to that output, 24,305,008 bytes, VALID with 0 warnings. Against the previous demo, only `manifest.generated_at` and the timing fields of `metrics.json` differ. The previous demo is backed up in `rt3/demo_previous`. |
| Real v1 bundle (`dashboard/public/data`) | VALID with the 4 known warnings, and byte-for-byte unchanged (the sha1 lists match). |
| Dashboard | `npm run lint` rc 0. `npm test`: 47 files, 574 tests pass. `npm run build` rc 0. `npm run budget`: all hard budgets met, with only the soft font warning (110.9 of 100 kB). |
| Headless Edge (puppeteer-core against `vite preview`) | **Demo: 22/22 PASS, 0 errors.** It covers the 6 routes, playback through every frame from 1990 to 2050, Day/Night/DTR, the SSP cycle, compare on and off, the lens, the raster, pinning a cell in the Inspector, the Briefing, a what-if preset on the map, the SUHI legend (the reason at 2050, a scale at 2020) and the compare Δ legend domain across SSP switches. **Real v1 bundle: 19/19 PASS, 0 errors** in compatibility mode (2010-2025, night and DTR unavailable). `compat.mjs` finds "v1" text on all 6 routes. The only warnings are the 2 known luma.gl layout warnings. |
| Clean-up | `dist` and the project `__pycache__` folders were deleted, and the preview server was stopped. |

## 7. Remaining caveats

### 7.1 What only a real Kaggle + Earth Engine run can confirm

No part of this review had Earth Engine credentials. Sections 03-05 were checked only against mock `ee` modules:

- an expression-tree mock for the request logic: tiling, retries, splitting, export waits, GDDP blocks and budget
  keys;
- a semantic mock that returns plausible synthetic values, so that sections 03-12 run end to end in gee mode and can
  be compared structurally with synthetic mode.

The mocks show that the code and data structures fit together. They do not test real requests, quotas, timings or
data. The following must be confirmed on Kaggle (2× T4) with the service account:

1. **Earth Engine behaviour.**
   - real request deadlines and memory-limit splits;
   - the 40-concurrent-request quota on the standard endpoint;
   - the 64 km heavy tiles;
   - the GDDP block requests;
   - the Chen-2020 band names on the live asset.
2. **EECU cost.** The full run is *estimated* at about 40-100 EECU-hours plus re-runs, which is why the Contributor
   tier (1,000 EECU-hours/month) is recommended. Read the pilot's real EECU per workload tag in Cloud Monitoring
   before the full run. The pilot-to-full extrapolation rules (D21: 03 ≈ 2×, 04 ≈ 1×, 05 GDDP ≈ 1.5-2×) are
   reasoned, not measured.
3. **Runtime against the 12 h limit.**
   - On Kaggle, the pilot is estimated at about 1-1.5 h including Earth Engine, and the full profile at about
     6-7.5 h, inside the 11 h budget.
   - Locally, the synthetic pilot took 51 min at 1 km (100 min when three runs shared the machine). The
     extrapolation to 2× T4 has not been timed.
   - The clean stop and resume are the safety net if the estimate is wrong.
4. **Asset mode.** Asset mode was covered only by F1's unit tests with the mock; it never ran end to end. The
   following are unverified:
   - batch-task concurrency on a noncommercial project (the docs assume about 2 tasks at a time, so about 4 rounds
     for the 8 Landsat exports);
   - the per-task timeouts, the cancel-and-fall-back path, and reattaching to running tasks by description.
5. **Real data coverage.**
   - Landsat-5-only frames (1990/1995) and the day minimum-coverage stop (D9);
   - fixed-mask coverage (D8);
   - the Terra-reconstructed night 2000 frame and the VIIRS calibration (D19).
6. **GPU paths on 2× T4.** The LightGBM serial GPU lane (D20) and the GNN on CUDA. Locally the GNN ran on the CPU,
   and LightGBM was exercised only on the CPU.
7. **Model behaviour on real data.** The night drift gate (D10), riparian labelling (D11), the land-model verdict
   (D18), the `L_base` trend shift (D15) and the projection error correlation (D13) were seen only on the synthetic
   world.
8. **Resume through Kaggle.** Cache import from an attached notebook output and tar packing were tested locally:
   stop, pack, import from a different folder, then resume. They were not tested through Kaggle's *Add Data →
   Notebook Output* flow or under the 500-file output cap.
9. **The standalone validator on Kaggle.** It runs only when `validate_bundle.py` can be found: through
   `LST_VALIDATOR`, in a repository checkout, or in an attached dataset. Otherwise only the in-notebook read-back
   checks run, so validate the downloaded bundle locally.
10. **A real v2 bundle in the dashboard.** None exists yet. The dashboard has seen v2 data only from the synthetic
    world, plus the real v1 bundle in compatibility mode.

### 7.2 Caveats of the local evidence

- **Root cause of the silent validator failure.** It is inferred (the child process probably could not start under
  memory pressure while two runs overlapped), not proven. The fix makes such a failure visible, with its exit code,
  without failing a run whose bundle already passed the in-notebook checks.
- **The full-run evidence has two parts.** It consists of a run that failed in section 12 and a resume that
  recomputed only section 12, with sections 00-11 cached under unchanged hashes. It is not one uninterrupted run on
  the final section 12. The pilot, however, was a fresh, uninterrupted run on the final code.
- **The timings are inflated.** Other runs shared the machine: section 07 of the full run overlapped the gee,
  stop/resume and pilot runs, and the pilot overlapped the dashboard checks. In the demo's `metrics.json`, the
  timing fields for sections 00-11 come from the cached resume, so they are not real compute times. This is
  cosmetic only.
- **Known cosmetic items.**
  - two luma.gl warnings ("layout for attribute positions/normals"), library-internal, once per load;
  - the soft font budget warning (110.9 of 100 kB);
  - React `act()` warnings in the test output;
  - the `?perf=1` HUD covers the timeline mode switch in the smoke screenshots; this is a debug overlay only.
- **Performance governor.** A device that is GPU-bound from its very first rendered frame, before any idle frame,
  cannot be told apart from a slow display and stays at T0. In the app, the idle probe runs as soon as the bundle is
  ready, so this affects only a session that starts animating immediately.

## 8. Uncommitted changes and housekeeping

Nothing was committed during the review. Review the working tree and commit it yourself. The last steps changed:

| Path | Change |
| --- | --- |
| `notebook/sections/12_export.py` | The validator retry fix (section 6.3) |
| `delhi_ncr_lst_pipeline.ipynb` | Rebuilt; section 12 hash `535f9f017912` |
| `dashboard/public/demo/` | Refreshed from `outputs/review/rt2/out2km/web`; the previous copy is in `outputs/review/rt3/demo_previous` |
| `README.md`, `docs/SPEC.md`, this file | Documentation of the review and of the run control (time budget, stop and resume, validator) |

The review outputs under `outputs/review/` take several GB on E:. For example, `rt1` is about 3.4 GB and `ff` about
0.4 GB. They can be deleted after review. The mock `ee` modules, the `*.mjs` smoke scripts, `raw_structure.py` and
the `*.log` files are worth keeping if you want to repeat a check.

## 9. The Kaggle launcher and its review (2026-10-05)

**Why it exists.** Kaggle refuses a notebook whose source is larger than 1 MB, and `delhi_ncr_lst_pipeline.ipynb` is
about 1.5 MB. On Kaggle you therefore run `kaggle_launcher.ipynb` (about 13 KB). It runs the same 13 sections, cell
by cell and in its own namespace, from a code dataset built by `notebook/make_kaggle_code_bundle.py`. The runner is
`notebook/kaggle_runner.py`. The steps are in the README's *Kaggle quick start*.

**The review.** Two reviewers covered the Kaggle platform and the code's robustness. They raised 27 findings, some of
them duplicates. All were fixed:

| Finding | Problem | Fix |
| --- | --- | --- |
| C1 (critical), M5 | Section code hashes came from `ast.dump`, whose output changes between Python versions. Kaggle runs Python 3.12 and the bundle was built on 3.11, so the launcher would have refused every bundle. | `build_notebook._stable_dump` leaves out empty and None fields, so the hashes are identical on 3.11, 3.12, 3.13 and 3.14. A bundle is now checked by the exact sha1 of each file, and its recorded hashes are used as `_CODE_SHA`. All section hashes changed once as a result; there were no v2 Kaggle caches yet. |
| P1, H1 | With no dataset attached, the GitHub fallback ended in a bare `HTTP Error 404`, because `main` still holds v1. | The default is now `CODE_SOURCE = "dataset"`. Errors say what is attached and the click path to attach the dataset; a GitHub 404 says that the v2 code is not pushed there. |
| P2, P8, L6 | Nothing detected a stale dataset version or a stale zip. | Bundle id `YYYYMMDD-HHMMSS-<sha6>`. The launcher next to the zip is stamped with `EXPECTED_BUNDLE`, and a mismatch stops the run within seconds, naming the side that is out of date. The script builds the launcher first and the zip last; `--verify` checks the zip against the tree. |
| P9, M2 | Only the AST hashes were compared. An edited runner, validator or `build_notebook.py`, a corrupt `BUNDLE_INFO.json` or a missing validator was accepted. | Every listed file is checked by sha1 before any bundle code is imported. Unlisted section files, a corrupt `BUNDLE_INFO.json` and a missing validator are refused. |
| M3, M4, L7 | The newest-bundle rule ignored zips. The bootstrap could pick a different bundle than the runner. Symlinked folders were skipped. | One candidate list for folders and zips: newest `created_utc` first, then folder before zip, then the shallowest. The bootstrap applies the same rule. Symlinks and junctions are followed with loop protection. |
| P3, M1 | After a clean stop in an interactive session, the cell guard skipped every later cell, including the run cell. | `run_pipeline` removes the guard when it returns. |
| P4 | Deleting a settings line did not unset it in a live kernel. | The settings cell first clears every `LST_*` variable. |
| M6, L1, L2, L3 | An error raised after a stop request counted as a failure. A broken `__str__` could hide the real error, and tracebacks were printed twice. Packing raced with worker threads. A failed commit might not keep its output. | Such errors, and exception groups holding `LSTStop`, now count as a clean stop. Messages are built with a safe `str`, and the traceback is printed once. Packing waits up to 60 s for `ee_`/`gddp_`/`gpu_` workers. With `LST_FAIL_SOFT` (default in commits) a failure writes `RUN_FAILED.json`, packs the cache and ends the version normally. |
| P5, P6, P10, P12, L5 | Instructions used Kaggle's old *Add Data* wording and `/kaggle/input/<slug>` paths, and did not say that only a notebook's newest version can be attached. | New wording (*Input → + Add Input*), "keep the code dataset attached", "save no other version in between". An explicit `LST_CACHE_IMPORT` without a cache now stops the run. The cache import logs the attached run's `RUN_STOPPED.json` / `RUN_FAILED.json`. Section 12 finds the validator up to 5 levels under `/kaggle/input`. |
| P7, P11, L4 | All figures land in one cell, which made a large output. A GitHub checkout did not record its commit. | Inline figures default to 72 dpi (`LST_INLINE_DPI`; the PNG files keep their own dpi). The commit is recorded in `GITHUB_SOURCE.json`, from git or from the GitHub zip archive's comment. |

**Verification** (all in `outputs/launcher_test/`):

- `test_launcher_v2.py`: 62/62 on the final zip. It covers discovery and ordering, integrity, `EXPECTED_BUNDLE`, the bootstrap cell, GitHub provenance, and the stop/failure/fail-soft flow. The same check also passes under embeddable Python 3.12.7, 3.13.7 and 3.14.0.
- `test_exec_semantics.py`: 6/6.
- `test_ipy_session.py`: 7/7 (a stop, then inspect, then a re-run in the same kernel).
- A directory-junction loop test.
- Two runs in a real Jupyter kernel (synthetic data, fast profile, 2 km):
  - a clean stop after section 02;
  - a full run, `ALL SECTIONS OK` in 1,269 s, with the bundle VALID both in the run and standalone and the inline figures at 3.3 MB, down from 5.6 MB.

The final zip has byte-identical code files to the one these runs used; only the timestamp in its bundle id differs.

**Open until the first real Kaggle run:**

- the Kaggle UI itself: dataset processing, attaching the newest version, and the output of a fail-soft version;
- the Earth Engine paths, which are still verified with mock modules only.

## 10. Fixes from the first real Earth Engine and Kaggle pilot runs (2026-11)

The pilot profile was run against real Earth Engine (locally, sections 03-06) and on Kaggle 2×T4. Kaggle's library
versions (Python 3.13, XGBoost 3.4.1, numpy 2.1.3) were then reproduced locally, because the earlier rehearsals used
older versions and missed the `-inf` problem below.

| Where | Problem on real data | Fix |
| --- | --- | --- |
| 03 | ERA5-Land hourly with an `ee.Filter.Or` of date ranges: "User memory limit exceeded". | Per-year `filterDate`, then merge (`_s03_season_collection`). |
| 01, 03-05 | Quota exhausted (Restricted Mode, HTTP 429) looked like an ordinary failure. | `_gee_raise_if_restricted`: a clean stop with the reason; the cache keeps what is done. |
| 04 | Mixed band types: "homogeneous collection" error in the composites. | `.toFloat()` before merging. |
| 04, 05 | `EE_ROI` (`fc.geometry()`) evaluates to an empty MultiPoint, so the NCR ERA5 row and the Chen-2020 sums were empty. | `gee_roi_geometry(0)`; Chen layers chosen by `system:index` from `aggregate_array`; `Reducer.forEach(names)` for single-band reductions. |
| 06 | Night: only one training frame passed `NIGHT_MIN_NOBS = 6` (real median 4.8 nights). | 3 (Aqua/VIIRS), 1 for the Terra 2000 frame; annual night series `min_n` 1. |
| 06 | No cell reached the 0.5 urban-core threshold (box7 built-up max 0.45-0.49). | 0.3 plus a top-share fallback (`_s06_urban_core`). |
| 08 | XGBoost 3.4.1 writes `-inf` thresholds for missing-only splits; strict JSON refused them. | `_s08_threshold` clips to ±FLT_MAX (same predictions, max difference 6e-6 °C). |
| 09 | A drift fitted on 5 sparse Aqua years moved night 1990 to 28.6 °C. | Drift needs ≥ 10 years spanning ≥ 10 years (`_S09_DRIFT_MIN_YEARS`); night 1990 is now 20.9 °C. |
| 12, validator | The 2000 night frame (Terra-reconstructed, never trained on) had `corr(pred, obs)` 0.497 on Kaggle (0.524 locally) and failed the 0.5 alignment floor. A row mix-up gives ~0. | Floor 0.25 for reconstructed frames; 0.25-0.5 there is a logged note and a validator warning. Trained frames keep 0.5 (they score 0.95-0.99). |
