# SUMMARY
I rebuilt v1's 5x5 spatial-block CV from the real bundle and matched it exactly: grid 366x297 cells, the same per-fold row counts, and XGBoost R2 0.627 +- 0.297 against v1's 0.623 +- 0.305. Almost all of the "low accuracy" comes from one fold. Fold 0 holds the whole north-east strip (Karnal, Shamli, Muzaffarnagar, 29.4-29.9N), which is the coolest region (anomaly about -5 C). The model has no regional climate variable to extrapolate from, so it predicts that strip too warm by 1.4 C on average (2.6 C in the Shamli block), and that fold scores R2 0.11. The fix is features, not tuning. Smoothed neighbourhood values of the existing variables (3x3 and 15x15 km window means, distance to water and urban areas, elevation relative to the 10 km surroundings) raise honest spatial-CV R2 to 0.83 +- 0.06 (RMSE 1.47 -> 1.04 C, fold 0 at 0.79), matching v1's GNN (0.82) with plain XGBoost. Adding smooth coordinate trends (x, y and 6 rotated axes) gives 0.87-0.875 +- 0.045 (RMSE 0.89-0.91 C). Hyper-parameters, monotone constraints, stacking and residual smoothing each change R2 by 0.01 or less. For the time axis: temporal CV (2010-20 -> 2025) goes from 0.80 to 0.888 once each predicted anomaly map is shifted to a zero map-wide mean, which the target definition guarantees. Holding out both an unseen place and the unseen year goes from 0.51 to 0.79. The score also depends heavily on how blocks are drawn: the same base model scores 0.47 with 3x3 blocks, 0.63 with 5x5 and 0.86 with 7x7.

# RECOMMENDATIONS
- Add per-epoch neighbourhood features computed on the grid, ignoring missing cells: 3x3 and 15x15 km means of ndvi, ndbi, frac_impervious, frac_forest, frac_water, frac_barren and elevation; dist_water, dist_urban and dist_builtup; elev_rel10, elev_rel3 and elev_std7 (37 features). Measured: 5x5 spatial-CV R2 0.627+-0.297 -> 0.828+-0.065, RMSE 1.47 -> 1.04 C, fold 0 0.11 -> 0.78.
- Use two models. The prediction model (maps, timeline, future) adds smooth coordinates (centred x, y plus 6 rotated axes): spatial-CV R2 0.87-0.875+-0.045, RMSE 0.89-0.91 C. The explanation model (SHAP, zones, scenarios) leaves coordinates out and should replace them with ERA5-Land climate covariates. Do not use grid eigenvectors: they lower spatial-CV R2 (base + eigenvectors 0.72 vs 0.80 with plain x, y; with the new features 0.76 vs 0.875 with x, y + rotated axes).
- XGBoost depth 6, min_child_weight 20, learning rate 0.03, early stopping on 10 km blocks, plus monotone constraints of -1 on NDVI, NDWI, forest and water (cell and window versions). Accuracy is unchanged within +-0.006 and scenarios behave physically. Optionally average with LightGBM (+0.003). Skip heavy stacking and Optuna: the response surface is flat.
- Pool all epochs with an anomaly target plus a year feature (or absolute target + year, scored as anomaly: 0.838). Never headline R2 on the absolute target (inflated to 0.91).
- Recentre every predicted anomaly map to a zero mean over the region before adding the epoch mean, for temporal CV, the 1990-2050 timeline and future scenarios. Temporal CV goes from 0.71-0.80 to 0.883-0.89 (RMSE 0.95 C); unseen place + unseen time goes from 0.67 to 0.79. Take future epoch means from ERA5-Land and CMIP6 NEX-GDDP rather than from the model.
- Use one land-cover product for every epoch (GLC_FCS30D 1985-2022, or Dynamic World only from 2016). The 2025 Dynamic World switch causes a +1 C offset in predicted anomalies, and dropping the land-cover features improves temporal transfer.
- Add the GEE variables the residuals point to, in priority order: ERA5-Land Apr-Jun 2 m air temperature, dewpoint, topsoil water, evaporation and net solar radiation; MODIS NDVI-over-time irrigation and harvest features (Feb-Mar peak, March-to-May drop); MOD16A2 ET/PET; MCD43A3 albedo and MOD11A2 emissivity (Aravalli ridges are still predicted 0.65 C too hot); OpenLandMap soil texture; CHIRPS rainfall. Weight cells by MOD11A2 QC and valid-composite count, average Terra and Aqua, and add LST_Night_1km for the night layer.
- Report a validation protocol with: 5x5 block CV (strict, comparable to v1), 10x10 block CV (about the 20-40 km residual correlation range), leave-one-district-out, temporal (recentred) and unseen place + unseen time; pooled and per-epoch metrics; and the area-of-applicability mask (dissimilarity threshold about 0.12) shown in the dashboard.

# RISKS
- The coordinate gain (+0.05 R2 under spatial CV) relies on extrapolating a smooth NE-SW gradient. It does not transfer outside Delhi NCR, could fail if the regional pattern changes in future climates, and puts SHAP attribution on 'location'. Keep coordinates out of the explanation and scenario model.
- Spatial-CV scores depend heavily on how blocks are drawn: the same model scores 0.47 / 0.63 / 0.86 / 0.86 with 3x3 / 5x5 / 7x7 / 10x10 blocks. Any claimed improvement must be compared on identical folds. v1's 5x5 score is unusually low because the greedy assignment puts the whole cool north-east strip into one fold.
- The features were rebuilt from the dashboard bundle, which is rounded (roughly 4 significant figures, LST to 0.01 C) and not the pipeline's raw arrays. Results reproduce v1 closely (0.627 vs 0.623) but may differ slightly on Kaggle.
- The neighbourhood windows include predictors from test-block cells. This is not target leakage and is how the model would be deployed, but it is a softer test than recomputing the windows with training cells only.
- Recentring assumes the predicted anomaly map should have zero mean over the region, which is true by construction of the target. The absolute level of future LST then depends entirely on the climate source for the epoch mean (ERA5-Land/CMIP6), whose uncertainty must be shown separately.
- Land-cover product changes between epochs (GLC_FCS30D, WorldCover, Dynamic World) cause about 1 C offsets in predicted anomalies. A 1990-2050 timeline built on mixed products would show artificial trends.
- Terra orbit drift biases 2025 MODIS day LST low, and 1990s data would come from Landsat 5 surface temperature, a different sensor and overpass time. Cross-calibration error enters the timeline directly.
- The nested Optuna search was not run, because a grid of six spread-out settings showed a flat response (+-0.006). Total compute was about 2.5 h wall-clock, over the 60-90 min target, mainly from nested stacking (50 min), which gave no gain.

# REPORT
# Delhi NCR LST v2: accuracy experiments on the real data (spatial-block CV)

All scripts, out-of-fold (OOF) predictions and results are in `C:/Users/PRITHW~1/AppData/Local/Temp/claude/e--LST-replication-study/94d615e4-b613-4110-9bfc-050e85f614c6/scratchpad/diag/`:
- `results_all.csv` has all 75 experiments. Each row gives R2, RMSE and MAE as mean and sd over folds, plus pooled R2 and RMSE, per-fold R2/RMSE/bias, and per-epoch R2/RMSE.
- The scripts are `load.py`, `common.py` and `e0_baseline.py` to `e10_final.py`.
- Diagnostic tables: `diag_blocks.csv`, `diag_districts.csv`, `stack_log_*.csv`.

No project files were changed.

## 0. Rebuilding v1's setup and baseline

- **Grid:** projecting lon/lat to EPSG:32643 and solving `cell_id = row*W + col` gives W = 297, origin x0 = 545000 and y_top = 3321000. With H = 366, the greedy assignment of 5x5 blocks to folds gives v1's per-fold row counts exactly (43672 / 44876 / 43592 / 45276 / 43184).
- **Folds:** 5x5 tiles of about 73 x 59 km.
- **Target:** `lst_obs` minus the epoch's spatial mean. The recomputed means equal the manifest values (42.78 / 39.94 / 39.07 / 36.26).
- **Early stopping:** on held-out 10 km blocks inside the training data, as in v1.
- **XGBoost settings:** v1 parameters (depth 8, min_child_weight 5, learning rate 0.03), run on the local GTX 1650 with CUDA.

| Run | Spatial CV R2 (mean +- sd) | RMSE C | Pooled R2 | Fold R2 (f0..f4) |
|---|---|---|---|---|
| v1 bundle `lst_pred_oof` | 0.623 +- 0.305 | 1.47 | 0.785 | 0.09 0.66 0.83 0.75 0.78 |
| **E0 XGB, rebuilt here** | **0.627 +- 0.297** | 1.47 | 0.787 | 0.11 0.67 0.83 0.75 0.78 |
| E0 LightGBM (v1 parameters) | 0.698 +- 0.170 | 1.36 | 0.824 | 0.41 0.69 0.83 0.77 0.78 |
| E0 Ridge | 0.623 +- 0.135 | 1.54 | 0.778 | |
| E0 XGB, random CV | 0.935 +- 0.001 | 0.84 | | |

## a. Why fold 0 fails

- **Which area it is.** Fold 0 is blocks 0, 2, 3, 4, 7 and 15: the whole northern strip, about 29.0-29.9N. That is Karnal, Shamli, Muzaffarnagar, Panipat and Sonipat.
  - Its mean target is -2.81 C, while the other folds range from -2.1 to +1.9.
  - The Shamli/Muzaffarnagar block 3 has a target of -5.44 C and a bias of -2.61 C.
- **Where the error is.** Correlation between prediction and observation in fold 0 is still 0.69. The error is mostly a regional offset: removing the -1.42 C bias lifts that fold's R2 from 0.11 to 0.47. The model also compresses the extremes (sd of predictions 1.93 vs 2.37 observed).
- **Worst districts by RMSE:** Shamli 2.90 C (bias -2.27), Karnal 2.80 (-1.98), Muzaffarnagar 2.51 (-1.64). After these come Faridabad, Hapur, Meerut and Ghaziabad, all at 1.4-1.6 C with negative bias. The north-east is consistently cooler than NDVI and NDBI can explain.
- **Shift in the predictors.**
  - Fold 0 has much lower NDBI (standardised difference -0.81) and higher NDVI (+0.52) than the rest; this is the irrigated, sugarcane-dominated area.
  - Fold 1 (south-west Aravalli and Alwar) is shifted in elevation (+1.99) and slope (+1.41).
  - Fold 1 has the most cells outside the area of applicability, but fold 0 has the worst error. So the failure is not unusual predictor values; it is a regional temperature offset that none of the 17 predictors carries.
- **Area of applicability.** I used Meyer & Pebesma's dissimilarity index, weighting standardised features by mean |SHAP|; the threshold is 0.121.
  - Share of cells outside the area: 3.8%, 24.4%, 4.5%, 1.0% and 1.9% for folds 0-4.
  - RMSE rises steadily with the index, from 1.19 C (lowest decile) to about 1.75-1.80 C (top two deciles).
  - It explains part of fold 1's error but little of fold 0's.
- **Outliers and target quality.**
  - Water cells are slightly worse (RMSE 1.9-2.1 C when frac_water > 0.3) but are only 0.2% of rows.
  - Only 0.18% of cell-epochs depart from the cell's 4-epoch mean anomaly by more than 3 C, the likely cloud or composite artefacts. They have RMSE 3.8 C, are most common in 2020 (0.35%), and are not what drives the fold failure.
- **What the baseline residuals correlate with:**

| Variable | Correlation with residual |
|---|---|
| Distance to Aravalli | -0.38 |
| NDBI, 31 km mean | +0.35 |
| NDVI, 31 km mean | -0.35 |
| Latitude | -0.29 |
| Longitude | -0.28 |

  - Mean residual is -1.97 C at 29.5-30N.
  - About 67% of the residual variance is a fixed per-cell offset that persists across epochs. This points to a missing static or slowly varying driver: climate, soil moisture, irrigation or soil type.
  - Residual correlation falls from 0.69 at 0-5 km to 0.18 at 20-40 km and about 0.1 at 40-80 km.

## b. Neighbourhood context features (biggest gain)

How they are computed:
- Window means are computed per epoch on the 366 x 297 grid and ignore missing cells.
- Each window averages 7 variables (NDVI, NDBI, impervious, forest, water and barren fractions, elevation) at 3, 7, 15 or 31 cells (km).
- `dist` family: distance (km) to water (frac_water >= 0.3 or NDWI > -0.2), to dense urban (7x7 mean impervious >= 0.5) and to built-up cells (impervious >= 0.3).
- `relelev` family: elevation minus its 21x21 km mean, elevation minus its 7x7 mean, and the 7x7 standard deviation of elevation.
- These use predictors only, never the target, so they leak nothing.

| Experiment (XGB v1 parameters, same folds) | R2 | RMSE | Pooled R2 | Fold R2 |
|---|---|---|---|---|
| base 17 features | 0.627 +- 0.297 | 1.47 | 0.787 | 0.11 0.67 0.83 0.75 0.78 |
| + 3 km means | 0.758 +- 0.117 | 1.22 | 0.860 | 0.58 0.70 0.86 0.83 0.82 |
| + 7 km means | 0.783 +- 0.089 | 1.17 | 0.873 | |
| + 15 km means | 0.788 +- 0.090 | 1.15 | 0.877 | |
| + 31 km means | 0.794 +- 0.095 | 1.13 | 0.881 | |
| + dist only | 0.589 +- 0.348 | 1.54 | 0.765 | -0.03 ... (worse on its own) |
| + relelev only | 0.713 +- 0.173 | 1.31 | 0.834 | |
| + 3, 7, 15 km, dist, relelev | 0.826 +- 0.066 | 1.04 | 0.898 | 0.78 0.73 0.90 0.85 0.86 |
| same + 31 km | 0.826 +- 0.070 | 1.04 | 0.898 | |
| without 3 km | 0.822 | 1.05 | | |
| **without 7 km (= chosen set: 3 km, 15 km, dist, relelev; 37 features)** | **0.828 +- 0.065** | **1.04** | **0.899** | 0.78 0.74 0.90 0.85 0.86 |
| without 15 km | 0.815 | 1.08 | | |
| without dist | 0.823 | 1.05 | | |
| without relelev | 0.791 | 1.14 | | |

What this shows:
- Neighbourhood means matter most, especially at 15-31 km.
- `relelev` adds about 0.035 once the means are present.
- `dist` only helps alongside the other families; on its own it acts like a noisy location proxy.
- The 7 km and 31 km means are redundant with the 3 km and 15 km ones.
- After this step, residual correlation with latitude drops from -0.29 to -0.14 and the per-cell persistent share falls from 67% to 48%.

## c. Coordinates and spatial eigenvectors

| Experiment | Spatial CV R2 | Random CV R2 |
|---|---|---|
| base + x, y | 0.799 +- 0.081 | 0.967 |
| base + 80 low-frequency grid eigenvectors (cosine basis, up to frequency 8) | 0.721 +- 0.114 | 0.976 |
| chosen set + 80 eigenvectors | 0.764 +- 0.116 | |
| **chosen set + x, y + 6 rotated axes (0-150 degrees)** | **0.875 +- 0.044** (RMSE 0.89, pooled 0.926) | 0.985 |
| chosen set, no coordinates | 0.828 | 0.982 |

The risk, in figures:
- Under random CV every coordinate variant scores about 0.97-0.985. That is memorisation, not skill.
- Eigenvectors over-fit and **hurt** under spatial CV.
- Smooth linear and rotated coordinates **help** under spatial CV (+0.05). They extrapolate the smooth regional gradient: cooler and wetter to the north-east, hot and arid to the south-west. After adding them, residual correlation with latitude is 0.01 and the fold-0 bias is -0.16 C.
- Coordinates do not transfer outside the NCR. They would also absorb SHAP attribution that belongs to physical drivers ("location explains it"), which undermines the zoning and scenario layer.

## d. Regularisation and hyper-parameters (chosen 37-feature set)

| Configuration | R2 | RMSE |
|---|---|---|
| v1 (depth 8, min_child_weight 5) | 0.828 +- 0.065 | 1.04 |
| depth 6, min_child_weight 20 | **0.830 +- 0.061** | 1.04 |
| depth 4, min_child_weight 50 | 0.824 +- 0.053 | 1.06 |
| depth 6, mcw 100, colsample 0.5, lambda 10 | 0.827 +- 0.059 | 1.05 |
| depth 6, mcw 300, subsample 0.5, colsample 0.5, lambda 30 | 0.821 +- 0.065 | 1.06 |
| Pseudo-Huber loss | 0.802 +- 0.103 | 1.10 |
| v1 + monotone constraints (minus sign on NDVI, NDWI, forest and water, both cell and window versions) | 0.829 +- 0.063 | 1.04 |
| depth 6 / mcw 100 + monotone constraints | 0.827 +- 0.061 | 1.05 |

- Every setting falls within +-0.006 of the others, so tuning is not where the accuracy is.
- Monotone constraints cost nothing in accuracy and make the scenario layer behave physically, so keep them.
- I did not run the nested Optuna search. Six spread-out settings all scored within that band, which already shows the surface is flat. `e4_hparams.py optuna` is ready if wanted (about 20 min on a T4).

## e. Stacking and residual smoothing (nested, no leakage)

How it was done:
- Inside each outer fold, the base models were scored on the other 4 folds held out one at a time. A non-negative linear combiner was fitted on those inner out-of-fold predictions.
- Residual smoothing: inner out-of-fold residuals from training cells, same epoch, Gaussian kernel. Kernel width and shrinkage were tuned on the inner folds only.
- The outer test fold is never touched in any of these steps.

| Model (learning rate 0.05) | R2 | RMSE |
|---|---|---|
| XGB | 0.826 +- 0.065 | 1.05 |
| LGB | 0.829 +- 0.065 | 1.04 |
| Ridge | 0.654 +- 0.213 | 1.44 |
| Mean of XGB and LGB | **0.831 +- 0.063** | 1.03 |
| Stack (weights: LGB 0.04-0.75, XGB 0-0.93, ridge 0.07-0.41) | 0.830 +- 0.075 | 1.03 |
| Stack + residual smoothing | 0.831 +- 0.071 | 1.03 |

- The smoother's inner gain was only 0.07-0.8%.
- Error grows with distance from the nearest training cell: 0.71 C within 2 km, 0.87 at 2-5 km, 0.96 at 5-10 km, 1.10 at 10-20 km and 1.17 C beyond 20 km (28% of test cells).
- Smoothing helps a little at 2-10 km and hurts within 2 km.
- In deployment LST is observed everywhere, so residual smoothing is useful only for gap-filling or downscaling (correcting residuals at fine resolution), not as a skill gain.

## f. Per-epoch vs pooled models; anomaly vs absolute target; temporal transfer

| Experiment | R2 | RMSE |
|---|---|---|
| Pooled, anomaly target | 0.828 | 1.04 |
| Separate model per epoch | 0.820 +- 0.086 | 1.05 |
| Absolute target + year feature, scored as anomaly | **0.838 +- 0.067** | 1.00 |
| Same, scored on absolute LST (inflated by the between-epoch spread) | 0.913 | 1.00 |

Pooling helps. The small gain from an absolute target with a year feature comes from epoch-specific interactions, so either an anomaly target with a year feature or an absolute target scored as anomaly is fine. **Never report R2 on the absolute target as the headline number.**

Temporal transfer (training years -> test year):

| Experiment | Raw R2 / RMSE / bias | Recentred R2 / RMSE |
|---|---|---|
| base, 2010-20 -> 2025 | 0.797 / 1.28 / +0.62 | 0.844 / 1.12 |
| chosen set, 2010-20 -> 2025 | 0.712 / 1.53 / +1.18 | **0.883 / 0.97** |
| chosen set without land-cover fractions and landscape metrics | 0.753 / 1.41 / +1.05 | **0.890 / 0.94** |
| chosen set + coordinates (E10) | 0.774 / 1.35 / +0.96 | **0.888 / 0.95** |
| chosen set + previous-epoch anomaly, 2015-20 -> 2025 | 0.806 / 1.25 | 0.874 / 1.01 |
| Persistence (2020 anomaly used as the 2025 prediction) | 0.748 / 1.43 | |
| Unseen block AND 2025, chosen set | 0.507 +- 0.238 | |
| Unseen block AND 2025, + coordinates | 0.672 +- 0.134 | **0.791 +- 0.082** |
| Unseen block AND 2025, + coordinates + previous-epoch anomaly | 0.744 +- 0.136 | 0.779 +- 0.114 |

"Recentred" means subtracting the mean of the predicted anomaly map over the whole region. This is legitimate: the target has zero mean per epoch by definition, and only predictions are used.

What this shows:
- Temporal error is dominated by a mean offset of about 1 C in predicted 2025 anomalies.
- The offset is largely the land-cover product switch (Dynamic World in 2025 vs GLC_FCS30D and WorldCover before): dropping the land-cover features shrinks it.
- Recentring the predicted map removes the offset. Absolute future LST is then the epoch mean (from a climate source) plus the recentred anomaly.

## g. Block-size sensitivity (same greedy assignment into 5 folds)

| Blocks | Base features | Chosen features |
|---|---|---|
| 3x3 (about 122 x 99 km) | 0.465 +- 0.211 | 0.664 +- 0.108 |
| 5x5 (about 73 x 59 km, v1) | 0.627 +- 0.297 | 0.828 +- 0.065 |
| 7x7 (about 52 x 42 km) | 0.861 +- 0.058 | 0.909 +- 0.031 |
| 10x10 (about 37 x 30 km) | 0.859 +- 0.034 | 0.916 +- 0.011 |

- v1's 5x5 score is unusually low because the greedy assignment puts the whole north-east strip into a single fold. 7x7 blocks have similar size but score 0.86.
- Block size should be justified by the residual correlation range, which is 20-40 km after the new features (beyond about 40 km the correlation is near 0).
- Report 5x5 (strict, comparable to v1) and 10x10 (about the correlation range) side by side, and add leave-one-district-out CV.

## Best honest configuration and expected gain

| Protocol | v1 | v2 recipe |
|---|---|---|
| 5x5 spatial-block CV | 0.627 +- 0.297, RMSE 1.47 | 0.870-0.875 +- 0.045, RMSE 0.89-0.91 (pooled 0.924-0.926), fold 0 = 0.84-0.86 |
| Same, without coordinates (model used for explanations) | | 0.83 +- 0.06, RMSE 1.04 |
| Temporal CV, 2010-20 -> 2025 | 0.80 | 0.888 recentred, RMSE 0.95 |
| Unseen place + unseen time | | 0.79 |
| Per epoch, 5x5 CV | | 0.92-0.93 |

The v2 numbers are expected gains measured on v1 data. Adding the GEE variables below should push the explanation model toward the version with coordinates, and that is the goal.

## Exact v2 recipe

1. **Keep the 17 base features.**
2. **Neighbourhood features**, computed per epoch on the grid, ignoring missing cells, after the land-cover fractions:
   - square window means at 3 and 15 cells (km) of `ndvi, ndbi, frac_impervious, frac_forest, frac_water, frac_barren, elevation`
   - `dist_water` (frac_water >= 0.3 or NDWI > -0.2)
   - `dist_urban` (7x7 mean impervious >= 0.5)
   - `dist_builtup` (impervious >= 0.3)
   - `elev_rel10 = elevation - 21x21 mean`, `elev_rel3 = elevation - 7x7 mean`, `elev_std7`
   - Window means are computed with `scipy.ndimage.uniform_filter`, or on the GPU with cupyx. Total: 37 features.
3. **Coordinates** (prediction model only): centred x and y divided by 1e5, plus 6 rotated axes `x cos(a) + y sin(a)` with a = 0, 30, ..., 150 degrees.
4. **XGBoost:** depth 6, min_child_weight 20, subsample 0.8, colsample 0.8, lambda 1, learning rate 0.03, early stopping on 10 km blocks. Monotone constraints of -1 on NDVI, NDWI, forest and water, cell and window versions. Optionally average with LightGBM using the same features (+0.003; nothing more is gained from a full stack).
5. **Pooled anomaly target with a year feature** (or absolute target + year, scored as anomaly).
6. **Recentre every predicted anomaly map** to a zero mean over the region before adding an epoch mean. This applies to temporal CV, the timeline and future runs. For 2030-2050, take the epoch mean from ERA5-Land and CMIP6 rather than from the model.
7. **Report:**
   - 5x5 and 10x10 block CV, leave-one-district-out CV, temporal CV (recentred) and unseen place + unseen time
   - pooled and per-epoch R2
   - the area-of-applicability mask in the dashboard
   - a validation-protocol note with this block-size table

## Which GEE variables would add most

Ranked by what the residual diagnostics point to.

1. **ERA5-Land monthly (`ECMWF/ERA5_LAND/MONTHLY_AGGR`), Apr-Jun means.** 2 m air temperature, dewpoint, topsoil water content (`volumetric_soil_water_layer_1`), total evaporation and surface net solar radiation, bilinear-resampled to 1 km.
   - It carries the regional gradient that coordinates and fold-0 bias currently stand in for, and should replace coordinates in the explanation model.
   - It covers 1950 onwards, which the 1990-2050 timeline needs.
2. **Irrigation and crop phenology from MODIS NDVI over time (MOD13Q1).** February-March NDVI peak, the drop from March to May, and the number of green months. These separate wheat harvested by April (bare and hot) from sugarcane and irrigated fields (green and cool) in Shamli, Muzaffarnagar and Meerut.
3. **Evapotranspiration and soil moisture:** MOD16A2 ET/PET, plus SMAP L4 for 2015 onwards or ERA5-Land soil moisture for consistency.
4. **Albedo (MCD43A3 white-sky shortwave) and MOD11A2 Emis_31/32.**
   - Residuals on Aravalli ridges stay at -0.65 C even with coordinates, where the model predicts ridges too hot. That points to emissivity, albedo and rock/scrub effects.
   - Albedo also separates bright sand from dark soil in the south-west.
5. **Static soil properties (OpenLandMap sand/clay content, `OpenLandMap/SOL/*`).** About 45% of the remaining residual variance is a fixed per-cell offset.
6. **CHIRPS rainfall** for Jan-Mar (antecedent) and Apr-Jun.
7. **Consistent land cover across epochs.** Use GLC_FCS30D (1985-2022) for every epoch, or Dynamic World only from 2016. Product switching causes the 2025 offset and is a must-fix for a 1990-2050 timeline.
8. **Target quality.**
   - Apply the MOD11A2 QC filter (LST error at most 1 K), keep a count of valid composites, and use it as a sample weight.
   - Average Terra and Aqua (MYD11A2) for day LST; adding Aqua (13:30) would also reduce Terra orbit-drift bias in 2025.
   - Night LST comes from the same products' `LST_Night_1km`.
   - For 1990-1999 use Landsat 5 Collection 2 Level-2 surface temperature (`ST_B6`), cross-calibrated to MODIS in the 2000-2011 overlap.

## Runtime

About 3.4 GPU/CPU-hours of compute (about 2.5 h wall-clock with queues running in parallel) on the GTX 1650 and 8-core CPU. This is above the 60-90 min target. The nested stacking alone took 50 min, because the inner CV needs 25 XGB and 25 LGB fits. On Kaggle with two T4s the full v2 CV suite is roughly 15-25 min.