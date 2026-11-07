# SUMMARY
Literature-backed plan for the v2 Delhi NCR LST model, covering five areas. (1) Honest accuracy. v1's spatial-block R2 understates the model for three reasons. First, it is the mean of per-fold R2 over five folds built from about 66 km tiles (03_models_validation.py around lines 586 and 619), and a fold with little temperature variation gets a low R2 even when its error is small. Second, the GBMs have no neighbourhood context, while the GNN does. Third, Terra's overpass drifted from 10:30 to about 9:00 local mean time by late 2025, so the 2025 day target was measured roughly an hour earlier than 2010-2020. That likely explains much of the temporal-CV drop. Fixes: report R2 pooled over all held-out predictions; use about 20 km blocks with 10 folds plus an error-versus-distance curve; make leave-one-epoch-out the headline metric for the timeline; add multi-scale focal features, albedo, ERA5-Land and CHIRPS meteorology and soil moisture, built volume and harvest-timing features; use 3-year epoch windows; tune in nested spatial CV; stack GBM and GNN with NNLS weights; add a shrunken per-cell persistent-residual term for use across epochs; and gate every map with the Meyer and Pebesma area of applicability. (2) 1990-2025 timeline. Build a separate model restricted to inputs available for every year (Landsat indices, GLC_FCS30D, GHS-POP/BUILT, harmonised night lights, ERA5-Land). For 1990 and 1995 daytime, use Landsat 5 C2 ST anomalies calibrated to MODIS on the overlap years as an independent check. Night before 2003 is model-only, validated by predicting the earliest MODIS epochs and checked against AVHRR night LST (Ma et al. 2023). The domain mean comes from ERA5-Land skin temperature calibrated to MODIS. Every epoch gets an evidence tier label. (3) Day and night downscaling to 250 m (100 m for the core). Use a DMS/RF-style GBM trained at 1 km, apply it to fine predictors, then correct residuals so each fine block averages back to its 1 km observation. Validate by testing at 2-4 km against 1 km (leave-coarse-pixels-out), against Landsat for day and against ECOSTRESS for night. Expected RMSE is about 1.5-2.5 K by day and 0.6-1.0 K at night. (4) 2030-2050 scenario projections. Use SSP urban-fraction deltas (Gao and Pesaresi 2021) or a fractional CA checked by a 2015 to 2025 hindcast with figure of merit, SSP population (Wang 2022), and CMIP6 temperature deltas (NEX-GDDP-CMIP6 or Mishra 2020). Scale the deltas with an empirically fitted dLST/dTair for day and night, and propagate uncertainty by Monte Carlo over GCM, sensitivity coefficient, land realisation and model error. (5) Expected model behaviour. Pre-monsoon days in Delhi NCR show an urban cool island relative to dry or fallow cropland and barren land. Nights show a positive urban heat island of about 2-7 C. Several SHAP signs should therefore flip between day and night (urban, water, NDVI).

# RECOMMENDATIONS
- Replace mean-of-per-fold R2 (03_models_validation.py ~l.586/619) with pooled out-of-fold R2/RMSE; keep per-fold RMSE as the spread. v1's 66 km tiles in 5 folds make low-variance folds look bad.
- Make leave-one-epoch-out (LOEO) the headline metric for the timeline. Keep spatial-block CV (~20 km blocks, 10 folds, size at least the residual variogram range) as the transfer check, and publish an RMSE-vs-block-size curve for 1/5/10/20/40/66 km.
- Correct the Terra drift (10:30 until 2020, ~10:15 in Oct 2022, ~9:00 by Dec 2025): calibrate the 2025 day anomaly against Landsat 8/9 or use MOD11A1 view time. Use Aqua 01:30 for night 2003-2020, calibrated VIIRS for 2025, and calibrated Terra 22:30 for 2000.
- Build the target from 3-year windows per epoch, QC-good pixels only (LST error <= 1 K, at least 6 valid composites), with the domain median over a fixed mask; extend to 6 MODIS epochs (2000-2025).
- Add multi-scale Gaussian focal features (sigma 1/2.5/5/10/20 km) of land-cover fractions, NDVI, NDBI, albedo and elevation, plus cell-minus-focal contrasts and TPI. This gives the GBMs the neighbourhood context the GNN already has.
- Add albedo (MCD43A3 or Landsat broadband), CHIRPS antecedent rainfall, ERA5-Land soil moisture/VPD/wind (keep only if both spatial CV and LOEO improve), harvest timing (March NDVI, March-to-May NDVI drop), GHS-BUILT-V/H, and log distance to water and urban edge. Exclude raw coordinates and MOD11 emissivity.
- Tune with nested spatial CV (outer 10 block folds, inner 3, Optuna about 30 trials, min_child_weight 20-300). Stack XGB+LGBM+GNN+spline-ridge with NNLS weights fitted inside each outer fold. Add monotone constraints only where the sign is certain (day: water and tree fraction negative; night: built volume positive).
- Add a shrunken per-cell persistent-residual layer (lambda chosen by LOEO; optionally GPBoost) for hindcast and projection only, and report its gain separately from spatial CV.
- Compute the Meyer and Pebesma AOA (importance-weighted dissimilarity index, threshold Q75+1.5 IQR of cross-fold training DI) for every epoch and scenario. Hatch cells outside it in the UI and calibrate a DI-to-RMSE curve for the uncertainty layer.
- Train a separate harmonised long-record model (Landsat indices and albedo, GLC_FCS30D, GHS-POP/BUILT, harmonised DMSP-VIIRS night lights, terrain, ERA5-Land/CHIRPS) for 1990-2050, next to the full MODIS-era model.
- 1990/1995 day: Landsat 5 C2 ST per-scene anomalies, composited and aggregated to 1 km, cross-calibrated to MODIS on the overlap years (leave-one-year-out). Compare them with the model reconstruction as an independent out-of-period test.
- Night before 2003: model reconstruction validated by LOEO and 'train late, predict early', with a coarse check against AVHRR night LST (Ma et al. 2023, ESSD). Calibrate the domain mean by regressing MODIS on ERA5-Land skin temperature at the matching hour over 2003-2025.
- Downscale day and night LST to 250 m (100 m for the core) with a DMS/RF-style GBM, exclude the most heterogeneous 20% of 1 km training cells, and apply ATPK or iterative block-conserving residual correction. Validate with a 2-4 km to 1 km scale-invariance test (leave-coarse-pixels-out), against same-day Landsat for day and against ECOSTRESS (70 m) for night.
- Future land: apply Gao and Pesaresi 2021 SSP 1 km urban-fraction deltas to the observed 2025 state, or run a fractional CA. Validate with a 2015-to-2025 hindcast using figure of merit against a persistence null model; do not headline overall accuracy or Kappa.
- Future derived predictors: delta-preserving mapping from land-cover fractions to indices and night lights, plus Wang et al. 2022 SSP population deltas. Hold meteorology features at the 2016-2025 climatology.
- Climate: NEX-GDDP-CMIP6 (GEE) or Mishra 2020 South Asia, April-June Tmax/Tmin deltas over 20-year windows relative to 2006-2025, scaled by an empirically fitted beta_day and beta_night (Theil-Sen of domain-mean LST on Tmax/Tmin with soil-moisture and rainfall co-regressors, bootstrap CI).
- Propagate uncertainty by Monte Carlo over GCM, beta, land realisation, and conformal model error conditioned on DI. Report P5/P50/P95 per scenario (never mix SSPs) with a variance decomposition, and label every future panel 'scenario projection, not forecast'.
- Label every epoch with an evidence tier (A observed, B harmonised Landsat, C model inside AOA, D outside AOA, P projection). Use the expected day/night SHAP sign flips (urban, water, NDVI) as a validation check.

# RISKS
- The Terra and Aqua orbit drift (Terra ~9:00 MLT by Dec 2025; Aqua heading to ~15:30-15:50 by 2026) contaminates the 2025 epoch. Without correction, temporal trends and 2025 SHAP comparisons are biased toward weaker morning contrasts.
- The MODIS target error (MOD11 C6 RMSE about 3.7 K day, 2.4 K night against in-situ; emissivity overestimated over semi-arid land) sets a floor. Claims of anomaly RMSE well below about 0.9 C under spatial CV should be treated as suspicious.
- Spatial proxies (coordinates, smooth ERA5-Land fields, distance-to-core) can inflate random-CV and LOEO skill while hurting spatial transfer and future extrapolation (Mila et al. 2024). Every addition must pass spatial CV as well as LOEO.
- The persistent-residual layer and per-cell random effects only help in time, not in space. Reporting them inside spatial-CV numbers would be leakage.
- Landsat 5 overpass drift (as early as 9:12 in 1995), path-to-path date differences and C2 ST versus MOD11 emissivity differences can create artificial 1990s patterns. Use per-scene anomalies, overlap calibration and leave-one-year-out checks.
- Night LST before 2003 is purely model-based. AVHRR (0.05 deg) can only check large-scale gradients, and DMSP night lights don't exist for 1990, so pre-2000 night maps must carry tier C/D labels and wide intervals.
- Downscaling assumes the 1 km relationship holds at 100-250 m. Urban extremes get smoothed (urban RMSE up to about 4.8 K reported), and the MODIS point-spread function and sinusoidal footprint don't match the UTM grid. Night downscaling gains are small.
- Interannual beta (dLST/dTair) mixes forced warming with soil-moisture and cloud co-variability and may not transfer to the 2050 forced response. Irrigation and aerosol trends (which can raise daytime LST) are not modelled.
- Land-change models have low change-location skill (FoM about 0.1-0.3). Future SUHI spatial detail is much less certain than the domain-mean climate signal, and the UI must not present it as a forecast.
- Future land-cover combinations (e.g. dense urban on former Aravalli scrub) may fall outside the AOA. Monotone constraints help but don't validate extrapolation.
- Several 'expected performance' numbers in the report are my estimates marked (est.), not literature values. Confirm them on the real data before quoting them to users.
- Compute and size: nested CV (about 2.5 h on one T4), Monte Carlo with about 500 draws times scenarios times years at 1 km, and 250 m day/night layers for 13 epochs all need careful budgeting within the 12 h Kaggle session and the 20 GB output limit. The dashboard bundle must be quantised and tiled.

# REPORT
# Delhi NCR LST v2: methods and literature recommendations

**Scope:** honest accuracy, a 1990–2050 timeline, day and night LST with downscaling, and future scenarios.
**Basis:** v1 results as given in the task, plus a read-only look at `notebook/sections/00_setup.py`, `02_features.py` and `03_models_validation.py`.
**Labelling:** I mark my own estimates "(est.)". Everything else is cited.

---

## 0. Diagnosis of v1: why the honest numbers look low

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| D1 | The spatial-block R² is the **mean of per-fold R²** (`03_models_validation.py` ~l.586/619). It is computed over 5 folds built from 25 tiles (`SPATIAL_BLOCKS=(5,5)`), each about 66 km across given the NCR extent. | Per-fold R² = 1 − SSE_f/SST_f uses the variance *inside the fold*. A fold made mostly of homogeneous cropland has a small SST_f, so its R² is low even when its RMSE is fine. | This inflates both the fold variance (XGB ±0.31) and the pessimism. Report **pooled out-of-fold R²** (1 − ΣSSE/ΣSST over all held-out rows) and RMSE, and show per-fold RMSE as the spread. |
| D2 | The data are wall-to-wall: every cell is observed in 2010–2025. Spatial CV measures **transfer to unseen regions**, which v2 never has to do. What v2 does need is transfer **in time** (hindcast to 1990, projection to 2050) and **across scale** (downscaling). | CV design should match the prediction task: Wadoux et al. 2021; kNNDM, Linnenbrink et al. 2024. | The headline metric for the timeline should be **leave-one-epoch-out (LOEO)**, with spatial CV kept as the transferability and attribution check. |
| D3 | **Terra drift.** Terra's last inclination manoeuvre was in February 2020. It reached 10:15 mean local time (MLT) in October 2022 and about 9:00 MLT around December 2025 ([NASA Terra drift](https://terra.nasa.gov/about/terras-orbit-changes/terra-orbital-drift-information)). Aqua drifts *later*: past 13:45 in February 2023, heading towards about 15:30–15:50 in 2026 ([Earthdata, Aqua](https://www.earthdata.nasa.gov/news/feature-articles/aqua-turns-20)). | The 2025 Terra day composite was acquired about an hour earlier than 2010–2020. Morning spatial contrasts are weaker. | This probably explains much of the temporal-CV drop (2010–2020 → 2025: XGB 0.80, GNN 0.67). It needs a drift correction (§2.3). |
| D4 | Each epoch is a single-year April–June composite. | Weather, wheat-harvest timing (April) and dust create noise in the target that no driver can explain. | Use 3-year windows (e.g. 2009–2011 for "2010"), QC-good pixels only (LST error ≤ 1 K), and require at least 6 valid 8-day composites. |
| D5 | The GNN is best under spatial CV (0.82 vs 0.62–0.68). | Message passing gives it neighbourhood context; the GBMs only see the cell. | Add multi-scale focal features to the GBMs (§1.2). This should close most of the gap (est.). |
| D6 | Several v1 features don't exist before 2000 or 2012–2015: MOD09A1 (2000+), VIIRS (2012+), WorldPop (2000+), Dynamic World (2015+). | – | A separate **harmonised long-record model** is needed for 1990–2050 (§2.1). |

---

## 1. Accuracy under honest validation

### 1.1 Realistic targets from the literature

- **Spatial vs random CV.** Random CV is routinely and substantially optimistic. In Ploton et al. 2020 (Nat. Commun. 11:4540, [doi:10.1038/s41467-020-18321-y](https://www.nature.com/articles/s41467-020-18321-y)), strong random-CV scores largely vanished under spatial CV. Roberts et al. 2017 (Ecography 40:913, [doi:10.1111/ecog.02881](https://doi.org/10.1111/ecog.02881)) recommend blocks at least as large as the residual autocorrelation range. Schratz et al. 2019 (Ecol. Model. 406:109) found random CV 24–30% more optimistic, and that tuning must also use spatial partitions ([arXiv:1803.11266](https://arxiv.org/pdf/1803.11266)).
- **Urban-LST ML studies.** Most report *random* CV with R² ≈ 0.85–0.92 and RMSE ≈ 0.7–1.5 °C. Example: CatBoost R² 0.89, RMSE 0.73 °C with random splits; compactness features raised R² from 0.85 to 0.88 (Hoang 2025, Sensors 25:5380, [doi:10.3390/s25175380](https://doi.org/10.3390/s25175380)). Where block CV is reported it is typically 0.05–0.10 lower ([e.g.](https://link.springer.com/article/10.1007/s12145-026-02215-6): 0.834 random vs 0.786 ± 0.055 block).
- **The MODIS target's own error.** MOD11 C6 against 67 in-situ stations: RMSE 3.70 K by day and 2.44 K at night (Duan et al. 2019, RSE 225:16, [link](https://www.researchgate.net/publication/331771696)). Classification-based MOD11 emissivity is overestimated over semi-arid and arid surfaces ([MOD21 ATBD](https://modis-land.gsfc.nasa.gov/pdf/MOD21_ATBD_Hulley_v2.4.pdf)). Part of the 1 km "residual" is therefore product noise. An anomaly RMSE of about 1.0 °C is close to the floor.
- **Realistic v2 targets (est.):**
  - Day anomaly, pooled spatial CV with ~20 km blocks: R² 0.78–0.86, RMSE 0.95–1.2 °C.
  - Day LOEO: R² 0.82–0.90.
  - Night anomaly (smoother field): R² 0.85–0.92, RMSE 0.5–0.8 °C.
  - Random CV is not a target; label it "interpolation skill" only.

### 1.2 Feature additions, ranked by expected gain

Compute everything on the 1 km UTM grid with numpy/scipy. Use `scipy.ndimage.gaussian_filter` as a *normalised convolution* so NaNs are handled: `F = G(x·m)/G(m)`, where m is the valid mask.

1. **Multi-scale focal context** (largest expected gain for GBMs, est. +0.05–0.12 spatial R²):
   - Gaussian-weighted means at σ = 1, 2.5, 5, 10, 20 km of: built-up fraction, cropland, bare, tree and water fractions, NDVI, NDBI, albedo and elevation.
   - Cell-minus-focal contrasts (e.g. `ndvi − ndvi_σ5`).
   - Topographic position index (TPI) = elevation − focal elevation at 2/5/10 km. This matters for night cold-air pooling on the Aravalli fringe.
   - Justification: SUHI footprints extend 2.3× (day) and 3.9× (night) the urban area and decay exponentially (Zhou et al. 2015, Sci. Rep. 5:11160, [doi:10.1038/srep11160](https://www.nature.com/articles/srep11160)).
2. **Physically meaningful distances, not raw coordinates:**
   - log distance to permanent water (JRC GSW occurrence ≥ 50%) and to the Yamuna.
   - log distance to the edge of a large contiguous urban patch.
   - An urban "gravity" term Σ A_j/d_ij² over patches.
   - Raw lon/lat, eigenvector maps and per-point distance fields are spatial proxies. They help only with residual autocorrelation *and* regular or random sampling. Otherwise they are neutral or harmful and cause feature extrapolation, and random CV wrongly favours them (Milà et al. 2024, GMD 17:6007, [link](https://gmd.copernicus.org/articles/17/6007/2024/); RFsp buffers, Hengl et al. 2018, PeerJ 6:e5518, [doi:10.7717/peerj.5518](https://pubmed.ncbi.nlm.nih.gov/30186691)). **Recommendation:** exclude raw coordinates from the driver model. Proxies are allowed only in a separate residual layer (§1.3).
3. **Albedo.**
   - MCD43A3 white-sky shortwave albedo (500 m, 2000+).
   - For the long-record model, Landsat broadband albedo (Liang 2001 narrow-to-broadband coefficients) for every epoch, for consistency.
   - Strong for daytime LST over bright quartzite and dark soils.
4. **Antecedent moisture and meteorology** (epoch-specific; mainly helps LOEO):
   - CHIRPS precipitation for Jan–Mar and Apr–Jun (0.05°, 1981+).
   - ERA5-Land (`ECMWF/ERA5_LAND`, 1950+): swvl1 soil moisture, t2m, d2m (giving RH and VPD), 10 m wind speed.
   - Optionally SMAP (2015+) in the MODIS-era model only.
   - Caveat: ERA5-Land's ~9 km smooth fields behave partly like coordinates. Keep them only if they improve **both** spatial CV and LOEO.
5. **Harvest and phenology timing.** In Delhi NCR the rabi wheat harvest (April) turns fields into bare, very hot surfaces. Add:
   - March NDVI.
   - Max NDVI from February to March.
   - NDVI drop from March to May.
   - Fraction of April–June composites with NDVI < 0.2.
6. **Built form:**
   - GHS-BUILT-V volume and GHS-BUILT-S surface (R2023A, 1975–2030 at 5-year steps, so usable in the long record).
   - GHS-BUILT-H (2018).
   - Google Open Buildings 2.5D Temporal (2016–2023, `GOOGLE/Research/open-buildings-temporal/v1`, [catalog](https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_Research_open-buildings-temporal_v1)) in the MODIS-era model only.
   - These matter most at night.
7. **Emissivity.** Do **not** use MOD11 Emis_31/32 as a predictor: it is classification-derived inside the same retrieval, so it is circular. ASTER GED v3 static emissivity is acceptable but probably redundant with NDVI and the land-cover fractions.
8. **Drop or test:** the landscape metrics PD, ED and CONTAG often add noise at 1 km. Use spatial forward feature selection (Meyer et al. 2019, Ecol. Model. 411:108815, [doi:10.1016/j.ecolmodel.2019.108815](https://www.sciencedirect.com/science/article/abs/pii/S0304380019303230)) or at least drop any feature whose removal improves pooled spatial-CV RMSE.

### 1.3 Model stack

1. **Base learners, all trained on identical spatial folds:**
   - XGBoost GPU and LightGBM, with focal features.
   - The GraphSAGE GNN. Neighbour *features* are allowed across the fold boundary; neighbour *targets* never are.
   - A ridge model on natural-spline bases as a stable extrapolator.
2. **Stacking.** Non-negative least squares on out-of-fold predictions, with weights summing to 1. Fit the weights *inside* each outer training fold (nested) so the outer score stays honest. A Super Learner performs at least as well as its best base learner in spatial prediction (Davies & van der Laan 2016, Int. J. Biostat. 12:179, [doi:10.1515/ijb-2014-0060](https://www.degruyterbrill.com/document/doi/10.1515/ijb-2014-0060/html)). Expected gain +0.01–0.04 R² (est.).
3. **Persistent-residual (random-effect) layer, for LOEO, hindcast and projection only.** Many unmodelled static drivers (soil, irrigation infrastructure, specific industrial roofs) persist over time.
   - For cell i with residuals from the other epochs: `r̄_i = n_i·mean(r_i,−e) / (n_i + λ)`.
   - Choose λ by LOEO (typically 1–3).
   - Optionally smooth with a Gaussian process. GPBoost (Sigrist 2022, JMLR 23:1, [pdf](http://jmlr.org/papers/volume23/20-322/20-322.pdf)) does tree boosting plus GP or grouped random effects jointly, with a Vecchia approximation.
   - **Validation:** compute r̄ only from epochs other than the held-out one.
   - This gives **zero** benefit under spatial CV, so report it separately.
4. **Residual kriging / regression kriging** for the *observed* epochs is pointless: they are observed. It is only useful as (a) the persistent layer above, or (b) ATPK residual downscaling (§3).
5. **Monotone constraints** (XGBoost `monotone_constraints`) for features whose sign is physically certain:
   - Day: water fraction (−) and tree fraction (−).
   - Night: built volume (+).
   - Do **not** constrain urban fraction by day (it is negative in Delhi, §5).
   - This improves extrapolation for 2050 scenarios.

### 1.4 Hyperparameter tuning without leakage (nested spatial CV)

- **Outer loop:** 10 folds from roughly 20 km blocks, with all epochs of a cell in the same fold.
- **Inner loop:** 3 block folds inside the outer training set; Optuna TPE with about 30 trials; objective = pooled inner RMSE; early stopping on an inner block fold, never on the outer test fold (Schratz et al. 2019).
- **Search ranges:** `max_depth` 4–9, `min_child_weight` 20–300 (a large value suits heavily autocorrelated 1 km data), `subsample` 0.6–0.9, `colsample_bytree` 0.5–0.9, `eta` 0.02–0.08, `lambda` 1–50.
- **Cost:** 10 × 30 × 3 fits at about 10 s each on a T4 is roughly 2.5 h on one GPU, about 75 min across two. Feasible.
- **Cheaper fallback:** nest only 3 outer folds to *estimate* the tuning optimism, and say so.

### 1.5 Block size and the spatial-CV design

- Fit an empirical variogram of the out-of-fold residuals from a random-CV XGBoost. Set the block size to at least the residual range; expected 10–25 km at 1 km resolution (est.).
- Use roughly 20 km blocks, assigned to 10 folds with v1's size-balanced greedy assignment.
- Also publish an **error-vs-distance curve**: pooled RMSE for blocks of 1, 5, 10, 20, 40 and 66 km. This is more honest and more informative than any single number.
- kNNDM (Linnenbrink et al. 2024, GMD 17:5897, [link](https://gmd.copernicus.org/articles/17/5897/2024/)) builds folds whose nearest-neighbour distance distribution matches the prediction task. For the wall-to-wall in-sample map that distribution is roughly 0, so kNNDM degenerates to random CV. That is exactly why spatial CV here is a *transfer* test, not a map-accuracy test (Wadoux et al. 2021, Ecol. Model. 457:109692, [link](https://research.wur.nl/en/publications/spatial-cross-validation-is-not-the-right-way-to-evaluate-map-acc/)).

### 1.6 Area of applicability (Meyer & Pebesma 2021)

Source: Methods Ecol. Evol. 12:1620, [doi:10.1111/2041-210X.13650](https://besjournals.onlinelibrary.wiley.com/doi/full/10.1111/2041-210X.13650).

**Computation** (numpy, or cuML NearestNeighbors on GPU):

1. Standardise features and weight them by mean |SHAP| importance.
2. Let d̄ = mean pairwise distance between training rows (subsample about 20k).
3. DI_new = (distance to nearest training row) / d̄.
4. For training rows, DI_train uses the nearest training row **in a different CV fold**.
5. Threshold = Q75 + 1.5·IQR of DI_train. Cells above it are outside the AOA.

**Uses:**

- Hatch or mask outside-AOA cells for every epoch (1990, 1995 and 2030–2050 especially) and every scenario.
- Calibrate a DI→expected-RMSE curve from CV folds (DI deciles), as in CAST errorProfiles.
- Feed that curve into the uncertainty layer.
- A local point density refinement exists ([Schumacher et al. 2025, GMD 18:10185](https://gmd.copernicus.org/articles/18/10185/2025/)).

### 1.7 Target choice

- **Keep the anomaly target** (LST − epoch domain mean) for pooled training. It removes inter-epoch meteorology and sensor offsets.
- Compute the domain mean as the **median over a fixed mask of cells valid in every epoch**. A changing mask changes the composition of the mean.
- Absolute LST = anomaly + domain mean(t). The domain mean comes from MODIS (2000–2025), calibrated ERA5-Land (1990s, §2.4) or CMIP6 deltas (future, §4.5).
- **Subtlety:** a mean-zero anomaly hides the effect of land change on the domain mean. In projections, the mean of predicted anomalies under future land cover minus the mean under 2025 land cover *is* the land-driven domain shift. Keep it; do not re-centre.
- **Per-epoch models:** use these only as a diagnostic of how driver effects drift between epochs. The pooled model with epoch-specific meteorology is preferred.
- **Day and night:** separate models with the same feature pipeline.

---

## 2. Long timeline 1990–2025 (day and night)

### 2.1 Two-model architecture

- **MODIS-era full model** (2000–2025: 6 epochs, 2000/2005/…/2025, as 3-year windows) for best accuracy and for SHAP.
- **Harmonised long-record model** (1990–2050), restricted to features available every year with consistent sensors:
  - Landsat C2 L2 surface-reflectance indices and albedo aggregated to 1 km (L5 1990–2011, L7 gap-filled by compositing, L8/9 2013+).
  - GLC_FCS30D fractions: 1985–2022, five-yearly before 2000 and annual after (Zhang et al. 2024, ESSD 16:1353, [link](https://essd.copernicus.org/articles/16/1353/2024/)). Use 2022 for 2025, or bridge with Dynamic World.
  - GHS-POP, GHS-BUILT-S and GHS-BUILT-V (5-yearly from 1975).
  - Harmonised DMSP–VIIRS night lights, 1992–2018+ (Li et al. 2020, Sci. Data 7:168, [doi:10.1038/s41597-020-0510-y](https://www.nature.com/articles/s41597-020-0510-y)). For 1990, use 1992 with a flag, or omit night lights from this model.
  - Terrain, water, ERA5-Land and CHIRPS.
  - Focal versions of all of the above.
- Report LOEO and spatial-CV scores for **both** models in the dashboard.

### 2.2 Day LST 1990–1999 from Landsat 5 (independent check)

- **Data:** `LANDSAT/LT05/C02/T1_L2`, band `ST_B6` (scale 0.00341802, offset 149 K), April–June, QA_PIXEL clear, ST_QA ≤ 2 K. The C2 ST product validates at about 2.0–2.1 K RMSE against in-situ ([Validation, IJDE 2021](https://www.tandfonline.com/doi/full/10.1080/17538947.2020.1862319)). Ermida et al. 2020 provide a GEE alternative (statistical mono-window, Remote Sens. 12:1471, [doi:10.3390/rs12091471](https://www.mdpi.com/2072-4292/12/9/1471)).
- **Overpass caveat:** Landsat 5's overpass drifted by up to about 1 h, as early as 9:12 in 1995 (Zhang & Roy 2016, RSE 186:217, [link](https://www.sciencedirect.com/science/article/pii/S003442571630325X)). Landsat LST trends are biased by acquisition-time drift ([TC 2024](https://tc.copernicus.org/articles/18/5259/2024/)).
- **Procedure:**
  1. For each scene, take ST minus the scene mean over the common mask (the anomaly cancels most overpass and atmospheric offsets).
  2. Median-composite per WRS-2 path.
  3. Mosaic with overlap feathering.
  4. Aggregate to 1 km (mean; mean-of-T⁴ differs by about 0.1 K and is negligible).
- **Cross-calibration on the overlap years** (2000–2011 L5 vs Terra; 2013–2020 L8 vs Terra; never 2025 Terra uncorrected):
  - Fit a transfer `A_MODIS = a + b·A_Landsat + f(LC fractions, water, elevation)` as linear or a small GBM.
  - This absorbs emissivity differences (MOD11 classification vs ASTER-GED-based) and differences in contrast due to time of day.
  - Validate leave-one-year-out on the overlap. Expected anomaly R² 0.8–0.9 (est.).
- **Time-of-day contrast scaling** for drifted scenes: fit b against the solar zenith angle at acquisition (from the scene metadata) on the overlap years, then apply it to the 1990s scenes.
- **Use:** the harmonised Landsat day anomaly for 1990 and 1995 is an *observation-based* product. Comparing it with the long-record model's *prediction* for 1990 and 1995 is a genuinely independent out-of-period test. Report it.

### 2.3 Fixing the 2020–2025 drift

- **Day (morning, the Terra line):**
  - Calibrate Terra 2025 to a 10:30-equivalent with Landsat 8/9 as the stable morning reference (about 10:00–10:15 local solar time).
  - Fit `A_Terra,y = a_y + b_y·A_L89,y` for the stable years 2015–2020 and for 2025.
  - Rescale: `A_corr,2025 = a̅ + b̅·(A_Terra,2025 − a_2025)/b_2025`.
  - Alternatively use MOD11A1 daily `Day_view_time` to fit, per cell class, the slope of anomaly against view time.
- **Optional afternoon "peak-heat" day layer:** Aqua 13:30 (2003–2020) bridged to VIIRS (S-NPP or NOAA-20, about 13:30, stable) for 2021–2025. Calibrate on the 2013–2020 overlap by per-cell linear or CDF matching of anomalies. VIIRS v001 (`NOAA/VIIRS/001/VNP21A1D/N`) is deprecated; check the GEE catalog for the v002 VNP21 / VJ121 IDs.
- **Night:**
  - Primary: Aqua MYD11A2 `LST_Night_1km` (about 01:30, available from July 2002).
  - 2000: Terra night (22:30) calibrated to Aqua on 2003–2019.
  - 2025: VIIRS night calibrated, because Aqua drifts towards about 02:30–03:00.

### 2.4 Night LST before 2003 (hindcast) and the domain mean

- **Anomaly field:** the harmonised long-record night model applied to the 1990, 1995 and 2000 features.
- **Validation, mimicking extrapolation back in time:**
  - (a) LOEO.
  - (b) "Train late, predict early": train 2010–2025, predict 2003/2005, and report how skill degrades with temporal distance.
  - (c) AOA DI for 1990 against the training set.
  - (d) Coarse check against AVHRR night LST at 0.05°, a twice-daily product for 1981–2021 (Ma et al. 2023, ESSD 15:2189, [link](https://essd.copernicus.org/articles/15/2189/2023/); 1981–2000 drift-corrected version: Ma et al. 2020, ESSD 12:3247, [doi:10.5194/essd-12-3247-2020](https://essd.copernicus.org/articles/12/3247/2020/essd-12-3247-2020.pdf)). Aggregate the model output to 5 km and compare large-scale gradients and the 1990→2005 change, not the absolute level.
- **Domain mean for 1990–1999 (day and night):**
  - Regress the MODIS fixed-mask domain mean on the ERA5-Land skin-temperature domain mean at the matching hour over 2003–2025 (n ≈ 23, leave-one-year-out CV). Use `ECMWF/ERA5_LAND/HOURLY`: about 05 UTC for Terra 10:30 LST (≈10:51 IST) and about 20 UTC for Aqua 01:30.
  - Apply the regression back to 1990. Propagate the regression prediction interval.
  - ERA5 tends to underestimate daytime LST, and MODIS night has a widespread cold bias ([egusphere-2026-400](https://egusphere.copernicus.org/preprints/2026/egusphere-2026-400/egusphere-2026-400.pdf)). That is why the regression calibration is needed rather than using ERA5 directly.

### 2.5 Evidence tiers (show in the UI)

| Tier | Meaning |
|---|---|
| A | Observed MODIS/VIIRS, QC-good |
| B | Harmonised observation (Landsat-derived day, 1990s) |
| C | Model reconstruction inside the AOA |
| D | Model reconstruction outside the AOA (hatched) |
| P | Scenario projection |

Every map and timeline point should carry its tier and a ±1σ or 90% interval.

---

## 3. Downscaling MODIS day and night LST to 250 m (100 m for the core)

### 3.1 Method: DMS / RF-style GBM with residual correction

**Background:** TsHARP (Kustas 2003; Agam 2007) regresses LST on NDVI or vegetation cover. It is weak in urban, water and night settings and produces box artefacts. The Data Mining Sharpener (Gao, Kustas & Anderson 2012, Remote Sens. 4:3287, [doi:10.3390/rs4113287](https://doi.org/10.3390/rs4113287)) uses regression trees on all reflectance bands, combines local and global models, and applies residual correction. RF downscaling (Hutengs & Vohland 2016, RSE 178:127, [link](https://www.sciencedirect.com/science/article/abs/pii/S0034425716300992)) gave RMSE 1.41–1.92 K and beat TsHARP.

**Steps** (per epoch, separately for day and night):

1. **Fine predictors** at 250 m (or 100 m):
   - Landsat/Sentinel-2 NDVI, NDBI, MNDWI, NMDI, albedo.
   - Impervious fraction (GHS-BUILT-S 10 m aggregated; GISA/GAIA for earlier years).
   - Built height and volume.
   - SRTM elevation, slope, TPI at 300 m and 1 km.
   - JRC water occurrence and distance to water.
   - VIIRS night lights (night model only).
   - Focal means at 500 m and 2 km.
2. **Aggregate each predictor** to the exact 1 km cells (mean).
3. **Train a GBM** `LST_1km ~ g(aggregated predictors)` on QC-good cells, excluding the most heterogeneous ~20% of cells (highest within-cell std of NDVI or impervious fraction), as in DMS.
4. **Predict at fine scale:** `T̂_f = g(fine predictors)`.
5. **Residual correction** (coherence / mass conservation):
   - `r_c = LST_1km,c − mean(T̂_f ∈ c)`.
   - Distribute r_c smoothly with area-to-point kriging (ATPK/ATPRK, Wang, Shi, Atkinson & Zhao 2015/2016, [link](https://www.researchgate.net/publication/305541292_Downscaling_MODIS_images_with_area-to-point_regression_kriging)), which preserves block means exactly.
   - Cheaper option: bilinear or Gaussian (σ ≈ 0.5 coarse pixel) interpolation of r, then 2–3 iterations of re-computing and subtracting the block-mean error until |error| < 0.05 K.
   - Constant redistribution of r leaves blockiness and should be avoided ([Remote Sens. 12:3507](https://doi.org/10.3390/rs12213507)).
6. **Gap handling:** cells with no valid 1 km LST get no residual correction. Flag them as Tier C.

**Kaggle size:** 55,150 km² at 250 m is about 0.88 M cells per epoch per day/night; 100 m over a roughly 5,000 km² core is about 0.5 M. Both are trivial for a GPU GBM. Export to the web as uint8- or uint16-quantised tiles.

### 3.2 Validation

1. **Scale-invariance / leave-coarse-pixels-out test:**
   - Aggregate MODIS to 2 km and 4 km, downscale back to 1 km, and compare with the real 1 km data (RMSE, bias, R; also against bicubic resampling of the 4 km field).
   - Hold out 20% of the coarse pixels in spatial blocks from step 3 so the test pixels' own residual is not used.
2. **Day, against Landsat ST:**
   - Same-day Terra and Landsat pairs (Δt ≈ 15–45 min; larger after 2020).
   - Aggregate Landsat to 250 m.
   - Compare *anomalies* (subtract the scene mean) to remove the overpass offset; also report absolute bias.
3. **Night, against ECOSTRESS** (70 m, variable overpass, 2018+; RMSE 1.07 K against ground):
   - Product: ECO_L2G_LSTE v002 via AppEEARS, [catalog](https://www.earthdata.nasa.gov/data/catalog/lpcloud-eco-l2g-lste-002).
   - Use scenes within ±1.5 h of 01:30, aggregated to 250 m, compared as anomalies.
4. **Report the improvement over a uniform or bicubic baseline.** Bartkowiak et al. 2019 got 22% lower RMSE and 18% lower MAE than the original MODIS (Remote Sens. 11:1319, [doi:10.3390/rs11111319](https://doi.org/10.3390/rs11111319)).

### 3.3 Expected accuracy (literature)

- **Day:** 1.4–2.3 K RMSE (Hutengs & Vohland 2016; Bartkowiak 2019). Urban cells are worse: up to about 4.8 K at 30 m in a two-step RF ([Atmosphere 16:424](https://doi.org/10.3390/atmos16040424)).
- **Night:**
  - 0.64 K with a local linear forest trained on ASTER ([JAG 2022](https://www.sciencedirect.com/science/article/pii/S1569843222000292)).
  - 0.89 K with GNNWR-kriging ([Remote Sens. 16:2542](https://www.mdpi.com/2072-4292/16/14/2542)).
  - Night fields are smoother and more predictable, but the *gain* over coarse data is smaller ([review, GIScience & RS 2025](https://www.tandfonline.com/doi/full/10.1080/15481603.2025.2527990)).

### 3.4 Night-specific choices

- NDVI is weak at night. Impervious fraction, built volume and height, night lights (as an anthropogenic heat proxy), water (**warmer** than land at night, the reverse of day), TPI and elevation (cold-air drainage) and soil moisture (thermal inertia) dominate.
- NDBI and road density help represent impervious surfaces ([Remote Sens. 16:2542](https://www.mdpi.com/2072-4292/16/14/2542)).
- Do not reuse the day model's feature set unchanged.

### 3.5 Pitfalls

- **Scale dependence:** relationships learned at 1 km over-smooth extremes at 100 m. Check with the scale-invariance test and do not go finer than about 100 m from 1 km.
- **Point-spread function:** MODIS's PSF and sinusoidal footprint (about 926 m) do not equal the UTM 1 km cell. This creates residual edge effects; ATPK can include the PSF.
- **Landsat-derived predictors are themselves ~10:00 snapshots.** Use composites matching the LST window.

---

## 4. Future projections 2030–2050 (scenario projections, not forecasts)

### 4.1 Framework

The chain is: land-change scenario → derived predictors → projection-ready LST model → climate delta → Monte Carlo uncertainty.

Published examples couple PLUS or FLUS land simulation with XGBoost LST models under SSP-RCP scenarios ([SD-PLUS + ML, SCS 2025](https://www.sciencedirect.com/science/article/abs/pii/S2210670725007875); [Changsha, Sci. Rep. 2025](https://www.nature.com/articles/s41598-025-30976-5)). Delhi-specific CA-Markov, RF and LSTM work projects a mean LST of about 41–42 °C by 2045 ([GitHub example](https://github.com/abhinav-spacedata/-spatiotemporal-uhi-delhi-ncr); [Env. Monit. Assess. 2025](https://link.springer.com/article/10.1007/s10661-025-14390-y)). These usually skip land-model validation and uncertainty propagation; v2 should not.

### 4.2 Land change: two options

**(a) Recommended, low-risk: external SSP urban-fraction deltas.**

- Use Gao & O'Neill 2020 (Nat. Commun. 11:2302, [doi:10.1038/s41467-020-15788-7](https://www.nature.com/articles/s41467-020-15788-7)), downscaled to 1 km for 2000–2100 by Gao & Pesaresi 2021 (Sci. Data 8:281, [link](https://www.nature.com/articles/s41597-021-01052-0); on the [GEE community catalog](https://gee-community-catalog.org/projects/urban_projection/)).
- Apply the **delta** `u_2025,obs + (u_y,SSP − u_2020,SSP)`, clipped to [0, 1], so that differences between products don't leak in.
- Alternative: FLUS-based 1 km land use for 2015–2100 under SSP-RCP (Chen, Li & Liu 2022, Sci. Data 9:125, [link](https://pubmed.ncbi.nlm.nih.gov/35354830); global FoM 0.102, Kappa 0.864).

**(b) Own fractional CA**, calibrated 2005→2015 and validated 2015→2025:

- Suitability S_i: GBM for P(Δu > 0.05) from distance to urban edge, roads (OSM), slope, population, focal urban fraction, and exclusions (water, Aravalli forest and protected land).
- Neighbourhood term N_i: focal urban fraction at σ = 2 km.
- Demand: district-level urban area as a logistic extrapolation of 2000–2025, scaled by the SSP ratios from (a).
- Allocation: iterate `Δu_i = min(1 − u_i, k·S_i·N_i·ε_i)` until district demand is met, with ε a stochastic perturbation; draw 20 realisations.

**Validation for either option:**

- Hindcast 2015→2025.
- Pontius figure of merit, `FoM = hits / (hits + misses + wrong hits + false alarms)`, on cells with Δu > 0.05.
- Compare against a **null persistence model** (Pontius & Malanson 2005; [Pontius 2023 four questions](https://www.tandfonline.com/doi/full/10.1080/24694452.2023.2232435)).
- Also report quantity vs allocation disagreement and the RMSE of Δu.
- Realistic FoM is 0.10–0.30 (global FLUS 0.10; est. for city scale). Don't headline OA or Kappa: they are dominated by persistence.

**Other land-cover fractions:** remove the new urban fraction from cropland, bare and grass in proportion to the observed 2005–2025 per-district transition shares. SSP1 variants can add a tree-cover policy.

### 4.3 Derived predictors for future years

- **Spectral indices and albedo** cannot be observed in the future, so use a delta-preserving mapping: `X_y = X_2025 + [h(LC_y) − h(LC_2025)]`, where h is a GBM X ~ LC fractions + focal LC + terrain fitted on 2020–2025. Night lights and built volume follow the same pattern.
- **Population:** SSP 1 km population grids for 2020–2100 (Wang, Meng & Long 2022, Sci. Data 9:563, [doi:10.1038/s41597-022-01675-x](https://www.nature.com/articles/s41597-022-01675-x)), applied as deltas onto GHS-POP 2025.
- **Meteorology features:** set to the 2016–2025 climatology. Climate change enters through the delta (§4.5) to avoid double counting.

### 4.4 Projection-ready LST model

- Use the harmonised long-record model (or a reduced version): land-cover fractions, built-up surface and volume, population, terrain, water, focal context, and climatological meteorology.
- Add monotone constraints (§1.3).
- Run the AOA check for each scenario and year. Novel combinations such as 90% urban in former Aravalli scrub get hatched.

### 4.5 Climate delta and dLST/dTair

- **Data:**
  - NEX-GDDP-CMIP6 (`NASA/GDDP-CMIP6` on GEE; daily BCSD at 0.25°, 1950–2100, SSP1-2.6/2-4.5/3-7.0/5-8.5; Thrasher et al. 2022, Sci. Data 9:262, [doi:10.1038/s41597-022-01393-4](https://www.nature.com/articles/s41597-022-01393-4)).
  - Or the South Asia–specific EQM bias-corrected set (13 GCMs, Tmax, Tmin and precipitation at 0.25°; Mishra, Bhatia & Tiwari 2020, Sci. Data 7:338, [doi:10.1038/s41597-020-00681-1](https://www.nature.com/articles/s41597-020-00681-1)).
- **Deltas:**
  - ΔTmax and ΔTmin for April–June, per GCM.
  - 20-year windows centred on 2030, 2040 and 2050, **relative to a 2006–2025 window** (historical + SSP), so that warming already in the 2025 baseline isn't counted twice.
  - Interpolate bilinearly to 1 km; the deltas are smooth across NCR.
- **Sensitivity coefficients:**
  - `ΔLST_day = β_d·ΔTmax`, `ΔLST_night = β_n·ΔTmin`.
  - Estimate β from interannual variation, 2003–2025: Theil–Sen regression of the MODIS fixed-mask domain-mean April–June LST (day and night) on ERA5-Land or IMD gridded Tmax and Tmin, with block-bootstrap CI.
  - Add antecedent rainfall and soil moisture as co-regressors so that β is not inflated by dry years.
  - Expected β_d ≈ 1.0–1.6 and β_n ≈ 0.8–1.1 (est.). This is consistent with daytime LST being more sensitive under dry soils and night LST tracking Tmin with little dependence on surface conditions ([Egypt MODIS–Tair study](https://doi.org/10.3390/rs11202369); [soil-heat extremes, Nat. Clim. Change 2023](https://www.nature.com/articles/s41558-023-01812-3)). India shows divergent day and night trends (day −0.62 K/decade, night +0.44 K/decade in Aqua LST: [IJRS 2023](https://www.tandfonline.com/doi/full/10.1080/01431161.2023.2240522)), so β must be estimated, not assumed to be 1.
  - Optional: β per land-cover class from cell-level regressions, with strong shrinkage.
- **Final field:**
  - `LST_y,s(i) = DM_base + β·ΔT_y,s,gcm + Â_y,s(i) + r̄_i`
  - DM_base = the 2016–2025 domain-mean climatology.
  - Â = the anomaly predicted under scenario land cover, *not* re-centred.
  - r̄_i = the persistent residual.

### 4.6 Uncertainty propagation

- **Never mix SSPs.** Report each scenario separately.
- **Within a scenario,** about 500 Monte Carlo draws per cell, each sampling:
  - (i) a GCM (equal weights, ≥ 10 models);
  - (ii) β from its bootstrap distribution;
  - (iii) one land realisation of the 20;
  - (iv) model error from split-conformal residual quantiles, computed from spatial-block out-of-fold residuals conditional on the AOA DI decile ([Angelopoulos & Bates, arXiv:2107.07511](https://arxiv.org/abs/2107.07511)).
- **Output per cell and year:** P5, P50, P95, plus a variance decomposition (GCM vs land vs model vs β) in the style of Hawkins & Sutton 2009 (BAMS, [doi:10.1175/2009BAMS2607.1](https://doi.org/10.1175/2009BAMS2607.1)) for the dashboard.
- **Wording** on every future panel: "Scenario projection under SSPx land and climate pathways; not a forecast. Outside the AOA, extrapolation is hatched."
- **State the omitted feedbacks explicitly:** irrigation change, aerosol trends (falling aerosols can raise daytime LST), heat-wave frequency, and changes in the timing of the monsoon onset.

---

## 5. Expected day vs night drivers in Delhi NCR (to sanity-check SHAP)

- **Pre-monsoon day: an urban cool island.**
  - Most Indian urban areas show negative daytime surface UHI intensity in March–May, because dry, sparsely vegetated rural land has low evapotranspiration (Shastri et al. 2017, Sci. Rep. 7:40178, [doi:10.1038/srep40178](https://www.nature.com/articles/srep40178)).
  - More than 60% of Indian urban areas show daytime cooling; agriculture and irrigation control the urban–rural contrast (Kumar et al. 2017, Sci. Rep. 7:14054, [doi:10.1038/s41598-017-14213-2](https://www.nature.com/articles/s41598-017-14213-2)).
  - In Delhi, central areas were up to 4–6 °C cooler by day and 4–7 °C warmer at night than rural surroundings, partly linked to aerosols (winter MODIS; Pandey et al. 2012, Sci. Total Environ. 414, [doi:10.1016/j.scitotenv.2011.10.043](https://www.osti.gov/etdeweb/biblio/22161587)).
  - MODIS overestimates in-situ skin temperature by day and underestimates it at night in Delhi (Mohan et al. 2013, Theor. Appl. Climatol. 112:647, [doi:10.1007/s00704-012-0758-z](https://link.springer.com/article/10.1007/s00704-012-0758-z)).
  - **Expected day SHAP:** bare and fallow fraction, harvested-cropland signal and albedo-dependent effects (+); built-up fraction ≈ 0 or slightly negative; NDVI, water and tree fractions (−); southwest Thar-fringe and Aravalli bare rock hot.
- **Night: a positive SUHI.**
  - A nocturnal heat island exists almost all year, with a maximum in March of about 4–6 K ([Urban Climate 2014](https://www.sciencedirect.com/science/article/abs/pii/S2212095514000777)).
  - Delhi's annual night SUHI is about 1.67 °C, and its night LST rose about 2.02 °C over 2000–2023, the fastest of the cities studied (Appl. Sci. 13:13323, [doi:10.3390/app132413323](https://doi.org/10.3390/app132413323)).
  - **Expected night SHAP:** built volume, impervious fraction, night lights and population (+, strong); water (+); TPI and valley position (− in cold-air pools); NDVI weak; soil moisture (+, thermal inertia).
- **SHAP sign flips** between the day and night models for urban, water and NDVI are a *validation check*. If they don't appear, suspect leakage or a target problem.

---

## 6. Suggested implementation order (Kaggle)

1. Fix the metric: pooled out-of-fold R² and RMSE, ~20 km blocks with 10 folds, an error-vs-block-size curve, and LOEO.
2. Retarget: 3-year windows, QC filter, fixed-mask domain median; Terra-2025 drift calibration; Aqua (and VIIRS 2025) night target.
3. Add focal, distance, albedo, harvest, ERA5-Land/CHIRPS and GHS-BUILT-V features; spatial forward feature selection.
4. Nested spatial tuning; stacking (GBMs + GNN + spline ridge); persistent-residual layer (LOEO only); AOA.
5. Harmonised long-record model; Landsat 5 1990s day anomalies with overlap calibration; night hindcast with AVHRR check; ERA5-Land domain-mean calibration; evidence tiers.
6. Downscaling to 250 m (day and night) with ATPK or iterative residual correction; scale-invariance, Landsat and ECOSTRESS validation.
7. Scenarios: SSP urban deltas (or CA with a 2015→2025 FoM hindcast), population deltas, CMIP6 deltas × β, Monte Carlo P5/P50/P95 and variance decomposition.

## Key references

- Meyer & Pebesma 2021, [doi:10.1111/2041-210X.13650](https://besjournals.onlinelibrary.wiley.com/doi/full/10.1111/2041-210X.13650)
- Linnenbrink et al. 2024, [GMD 17:5897](https://gmd.copernicus.org/articles/17/5897/2024/)
- Milà et al. 2024, [GMD 17:6007](https://gmd.copernicus.org/articles/17/6007/2024/)
- Ploton et al. 2020, [Nat. Commun.](https://www.nature.com/articles/s41467-020-18321-y)
- Wadoux et al. 2021, [Ecol. Model.](https://research.wur.nl/en/publications/spatial-cross-validation-is-not-the-right-way-to-evaluate-map-acc/)
- Roberts et al. 2017, [Ecography](https://doi.org/10.1111/ecog.02881)
- Schratz et al. 2019, [arXiv:1803.11266](https://arxiv.org/pdf/1803.11266)
- Meyer et al. 2019, [Ecol. Model.](https://www.sciencedirect.com/science/article/abs/pii/S0304380019303230)
- Hengl et al. 2018, [PeerJ](https://pubmed.ncbi.nlm.nih.gov/30186691)
- Sigrist 2022, [JMLR](http://jmlr.org/papers/volume23/20-322/20-322.pdf)
- Davies & van der Laan 2016, [IJB](https://www.degruyterbrill.com/document/doi/10.1515/ijb-2014-0060/html)
- Gao et al. 2012, [Remote Sens.](https://doi.org/10.3390/rs4113287)
- Hutengs & Vohland 2016, [RSE](https://www.sciencedirect.com/science/article/abs/pii/S0034425716300992)
- Bartkowiak et al. 2019, [Remote Sens.](https://doi.org/10.3390/rs11111319)
- Wang et al. 2015/2016, ATPRK ([link](https://www.researchgate.net/publication/305541292_Downscaling_MODIS_images_with_area-to-point_regression_kriging))
- Duan et al. 2019, [RSE](https://www.researchgate.net/publication/331771696)
- Ermida et al. 2020, [Remote Sens.](https://www.mdpi.com/2072-4292/12/9/1471)
- Zhang & Roy 2016, [RSE](https://www.sciencedirect.com/science/article/pii/S003442571630325X)
- Ma et al. 2020, [ESSD](https://essd.copernicus.org/articles/12/3247/2020/essd-12-3247-2020.pdf)
- Ma et al. 2023, [ESSD](https://essd.copernicus.org/articles/15/2189/2023/)
- Zhang et al. 2024, GLC_FCS30D ([ESSD](https://essd.copernicus.org/articles/16/1353/2024/))
- Li et al. 2020, NTL ([Sci. Data](https://www.nature.com/articles/s41597-020-0510-y))
- Gao & O'Neill 2020, [Nat. Commun.](https://www.nature.com/articles/s41467-020-15788-7)
- Gao & Pesaresi 2021, [Sci. Data](https://www.nature.com/articles/s41597-021-01052-0)
- Chen et al. 2022, [Sci. Data](https://pubmed.ncbi.nlm.nih.gov/35354830)
- Wang et al. 2022, population ([Sci. Data](https://www.nature.com/articles/s41597-022-01675-x))
- Thrasher et al. 2022, [Sci. Data](https://www.nature.com/articles/s41597-022-01393-4)
- Mishra et al. 2020, [Sci. Data](https://www.nature.com/articles/s41597-020-00681-1)
- Shastri et al. 2017, [Sci. Rep.](https://www.nature.com/articles/srep40178)
- Kumar et al. 2017, [Sci. Rep.](https://www.nature.com/articles/s41598-017-14213-2)
- Zhou et al. 2015, [Sci. Rep.](https://www.nature.com/articles/srep11160)
- Pandey et al. 2012, [STOTEN](https://www.osti.gov/etdeweb/biblio/22161587)
- Mohan et al. 2013, [TAC](https://link.springer.com/article/10.1007/s00704-012-0758-z)
- NASA Terra orbital drift ([page](https://terra.nasa.gov/about/terras-orbit-changes/terra-orbital-drift-information))
- Google Open Buildings Temporal ([catalog](https://developers.google.com/earth-engine/datasets/catalog/GOOGLE_Research_open-buildings-temporal_v1))
