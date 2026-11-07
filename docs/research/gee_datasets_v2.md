# SUMMARY
I checked every candidate v2 dataset against the Earth Engine catalog, gee-community-catalog, NASA/USGS pages and the public USGS and NASA archives. I also took real scene counts and overpass times for Delhi NCR from the USGS STAC and NASA CMR archives. Five findings change the v2 design.

1. **Landsat archive.** The archive is usable back to 1990, but only with multi-year windows. Nothing exists before 1989. 1990 alone covers only path 147 (62% of the ROI) and 1995 alone covers almost nothing. With 3-4 year Apr-Jun windows every epoch has at least 3 good Tier-1 scenes on every path/row, covering 100% of the ROI: 1990=1989-92, 1995=1994-96, 2000=1999-01, 2005=2004-06, 2010=2009-11, 2015=2014-16, 2020=2019-21, 2025=2024-26.
2. **Landsat 5 gap.** There are no Landsat 5 scenes in Apr-Jun 2002-2007, so the 2005 epoch can only use Landsat 7 SLC-off. Landsat 7 must be dropped from 2021 onward: its overpass moved to 09:17 IST in 2022 and 08:41 IST in 2023, against 10:37 IST in 2019.
3. **MODIS orbit drift.** The drift is real and measurable over Delhi. Terra's day pass moved from about 11:07 IST (2003-2020) to 10:07 IST in May 2025 and 09:22 IST in 2026. Aqua's day pass moved from 13:39 to 14:47 IST in 2025. This probably explains part of v1's fall in mean LST, from 42.8 °C (2010) to 36.3 °C (2025), and part of the weak temporal-CV result. VIIRS S-NPP (VNP21A1D/N, in Earth Engine since 2012) holds steady at 13:26 / 02:06 IST and is the right day/night successor.
4. **Climate scenarios.** The Earth Engine copy of NASA/GDDP-CMIP6 has only historical, ssp245 and ssp585 (34 models). The public AWS bucket s3://nex-gddp-cmip6 also has ssp126 and ssp370, at about 245 MB per global file (one per variable, model and year).
5. **Compute quota.** Since 2026-04-27, free noncommercial Earth Engine projects get 150 EECU-hours a month (Community tier) or 1,000 (Contributor tier, needs a billing account but is not charged). Past the quota, requests slow down rather than fail. v2 will probably need 30-100 EECU-hours, so moving to the Contributor tier is the clear choice.

The most consistent 1990-2050 backbone is:
- **Day target:** harmonised Landsat C2 L2 ST, clear-sky, about 10:00-10:50 IST.
- **Night target:** MODIS Aqua night plus VIIRS night for 2003-2025. Before 2000, night LST can only be modelled from ERA5-Land skin temperature and should be flagged as such.
- **Built-up and population:** GHSL P2023A, 5-yearly 1975-2030.
- **Land cover:** GLC_FCS30D for 1985-2022.
- **Night lights:** the sat-io srunet NPP-VIIRS-like series for 1992-2023.
- **Climate:** ERA5-Land from 1950.
- **Future:** GHSL 2030, Chen et al. 2020 SSP urban land for 2040/2050, WorldPop FuturePop SSP population, and GDDP-CMIP6 deltas.

# RECOMMENDATIONS
- Make harmonised Landsat C2 L2 surface temperature (Apr-Jun, QA-clean) the v2 DAY target for the whole 1990-2025 timeline, aggregated to a 250 m analysis grid. Keep MODIS/VIIRS 1 km day LST only as validation and as a second product. This is the only LST source that is consistent from 1990.
- Use these Landsat windows for the epoch composites: 1990 = 1989-1992, 1995 = 1994-1996, 2000 = 1999-2001, 2005 = 2004-2006 (Landsat 7 SLC-off only), 2010 = 2009-2011, 2015 = 2014-2016, 2020 = 2019-2021, 2025 = 2024-2026. Each gives at least 3 good Tier-1 scenes on every path/row (146/040, 146/041, 147/039, 147/040, 147/041) and 100% ROI coverage. Exclude Landsat 7 from 2021-01-01; its overpass moved to 09:17 IST in 2022 and 08:41 IST in 2023.
- Mask Landsat with: QA_PIXEL bits 0-4 all clear, QA_RADSAT == 0, ST_QA×0.01 ≤ 3 K, ST_CDIST×0.01 ≥ 1 km, reflectance between 0 and 1. Apply the Roy et al. 2016 ETM+→OLI OLS coefficients to TM/ETM+ reflectance. Use the scale factors SR ×2.75e-05 −0.2 and ST ×0.00341802 +149 K. Compute NDVI, NDBI, MNDWI and Liang-2001 albedo from the same composite, so predictors are consistent across 1990-2025.
- For NIGHT LST (and the 1 km day product), use Aqua MYD11A2 for 2003-2021 (02:12 / 13:39 IST) and VIIRS S-NPP NASA/VIIRS/002/VNP21A1D/N for 2012-2026 (stable 02:06 / 13:26 IST). Cross-calibrate them per land-cover class on the 2013-2021 overlap, and use VIIRS alone from 2022. Treat Terra after 2022 (10:07 IST day in 2025, 09:22 in 2026) and Aqua after 2022 as drifted. Use the Day_view_time and Night_view_time bands (×0.1 h) to filter observations or add them as a covariate.
- Label 1990-1999 night LST as a model hindcast in the dashboard. It should come from ERA5-Land hourly skin_temperature at 20-21 UTC, downscaled with an urban-form model (GHSL built surface and volume, Landsat NDVI/albedo, water, elevation) trained on 2003-2025 satellite night LST.
- Recompute the 2025 epoch, and re-check v1's temporal CV, with time-of-day-consistent LST (VIIRS, or Terra composites filtered by view time). v1's falling epoch means (42.8 → 36.3 °C) and its 2010-2020 → 2025 transfer error probably come partly from Terra's overpass moving about 1 h earlier.
- Use GHSL P2023A as the urban and population backbone (GHS_BUILT_S, GHS_BUILT_V, GHS_POP, GHS_SMOD_V2-0; 100 m / 1 km; every 5 years 1975-2030). Use GLC_FCS30D five-year bands (b1 = 1985, b2 = 1990, b3 = 1995) plus annual bands (b1 = 2000 … b23 = 2022), with a Dynamic World 2025 override only where change is detected. Use sat-io srunet-npp-viirs-ntl (1992-2023), extended to 2024-2025 with NOAA/VIIRS/DNB/ANNUAL_V22 and monthly composites calibrated on the 2014-2023 overlap. Use ERA5-Land MONTHLY_AGGR (1950+) for meteorology, soil water and evaporation instead of SMAP or MOD16.
- Future 2030-2050: keep the 2025 observed drivers. For 2030 add GHSL; for 2040 and 2050 add Chen et al. 2020 SSP urban increments (projects/sat-io/open-datasets/FUTURE-URBAN-LAND/CHEN_2020_2100, value 2 = urban, one band per SSP) and WorldPop FuturePop v0.2 or Wang 2022 SSP population rescaled to GHS-POP 2030. Add an Apr-Jun multi-model delta from NASA/GDDP-CMIP6 (baseline 1995-2014; windows 2021-40, 2031-50, 2041-60; 10th/50th/90th percentiles; subtract the delta already realised by 2025). Fit the Tmax → LST sensitivity empirically on 2003-2025 data. Drop night lights from the future model.
- For ssp126 and ssp370, pull a subset of 6-10 models for Apr-Jun only from the public AWS bucket s3://nex-gddp-cmip6 (no-sign-request; folders confirmed; about 245 MB per global file). The Earth Engine copy has only historical, ssp245 and ssp585. Alternatively, pattern-scale the ssp245 delta.
- To save EECU, batch-export each epoch's finished 100 m predictor and target stack to an Earth Engine asset (Export.image.toAsset on the v1 EPSG:32643 grid), then pull it at 250 m with computePixels. Stay within 48 MB per request (about 512×512 tiles for 20-40 float32 bands) and 40 concurrent requests. Also run annual 1990-2025 district series and GDDP deltas as Export.table batch tasks.
- Move the Earth Engine project to the Contributor tier (1,000 EECU-hours a month, needs a billing account, noncommercial use not charged). Run a one-epoch pilot to measure EECU before the full 8-epoch run. My estimate for the full run is 40-100 EECU-hours, against 150 EECU-hours a month on the Community tier.

# RISKS
- Absolute LST trends from 1990 to 2025 are confounded by overpass-time differences. Landsat 5 passed at about 10:10 IST in the early 1990s versus 10:48 for Landsat 8/9; Terra and Aqua drifted after 2022. Year-to-year pre-monsoon weather adds more noise. Without time and weather normalisation, a 1990-2050 timeline could show spurious warming or cooling.
- 1990 and 1995 composites rest on few scenes (3-6 per path/row on path 146, using 1989-1992 and 1994-1996). Single-date anomalies such as dust, haze or recent rain can bias them. 1997 is nearly empty, and Tier-2 scenes could add more 1990s coverage at lower geometric accuracy.
- 2005 depends entirely on Landsat 7 SLC-off; there are no Landsat 5 Apr-Jun scenes over the ROI in 2002-2007. Residual stripe gaps at fine scale and a higher valid-coverage threshold may leave holes at 100 m. 250 m is safer.
- Night LST before 2000 has no satellite observation in Earth Engine; it is modelled from 11 km ERA5-Land skin temperature plus land-cover downscaling. Presenting it as observed would be misleading. The ERA5-Land irrigation warm bias over the Indo-Gangetic croplands adds uncertainty.
- Terra and Aqua are past their planned end of mission (December 2025 and August 2026). Data in Earth Engine runs to 2026-09-14 but could stop at any time. VIIRS S-NPP is the continuity product; NOAA-20 VJ121 is not in Earth Engine.
- Aqua (split-window algorithm) and VIIRS VNP21 (TES algorithm) differ systematically by up to 1-3 K over bare and arid surfaces. A poor overlap calibration would put a jump into the night (and 1 km day) time series around 2022.
- Some scale factors could not be confirmed from the catalog pages: LST_1KM in MOD21A1D/N and VNP21A1D/N, and View_Time. Check value ranges at run time; a wrong scale would silently corrupt LST by a factor of 50.
- The Earth Engine NASA/GDDP-CMIP6 copy has only ssp245 and ssp585. ssp126 and ssp370 need AWS NetCDF downloads (about 245 MB per global file), which is costly on Kaggle unless limited to a few models and Apr-Jun. GDDP is 0.25° air temperature, not LST, so the conversion to LST needs an empirically validated sensitivity.
- Future urban and population layers come from different groups and baselines: GHSL 2030 is extrapolated; Chen 2020 is binary at 1 km; FuturePop v0.2 is an early release and not in Earth Engine. Mixing them without harmonising their 2020-2030 baselines will create artificial jumps in the 2030 → 2040 drivers.
- Since 2026-04-27 the Earth Engine Community tier allows 150 EECU-hours a month. Heavy 30 m Landsat median composites over 55,000 km² for 8 epochs, plus debugging reruns, could exhaust it and drop the project into slower restricted mode in the middle of a Kaggle session. My EECU figures are estimates, not measurements.
- reduceRegions at coarse scale reads pyramid levels, so QA bit tests run on downsampled QA values and can leak cloud or shadow into annual district means. Reproject to native 30 m or accept a small bias.
- Landsat scene counts come from the USGS STAC, which is what feeds Earth Engine's C2 L2 collections. Earth Engine ingestion could differ slightly, so re-check counts server side with ee.ImageCollection(...).filter(...).size() before the full run.

# REPORT
# Earth Engine data research for Delhi NCR LST v2 (1990-2050, day and night)

**About this report.** Research only; no project files were changed. All asset IDs, bands and dates below were checked on the Earth Engine catalog or gee-community-catalog pages on 2026-10-02.

The scene counts and overpass times come from my own queries:
- **USGS LandsatLook STAC** (`https://landsatlook.usgs.gov/stac-server`, collection `landsat-c2l2-st`, no login needed). This archive feeds Earth Engine's C2 L2 collections.
- **NASA CMR granule search** (MOD11_L2, MYD11_L2, VNP21, VJ121).

The query was clipped to the v1 ROI from `dashboard/public/data/districts.geojson`: 24 districts, bbox 75.47-78.46 E, 26.71-29.99 N. The scripts and raw results are in the scratchpad: `gee_research/stac_inventory.py`, `stac_rows.json` and `pr_footprints.json`.

---

## 0. Findings that change the design

| # | Finding | Evidence | Consequence for v2 |
|---|---|---|---|
| F1 | Five WRS-2 path/rows matter: 146/040 (37% of ROI), 146/041 (27%), 147/040 (44%), 147/041 (18%), 147/039 (8%). Each covers ground no other scene does, together about 67% of the ROI. Paths 145, 148 and row 042 cover under 2% each and only where scenes already overlap. | STAC footprints intersected with the ROI | Composites need all five; a missing path/row leaves a 12-25% hole. |
| F2 | There is no Landsat over the ROI before 1989 (1984-1988: 0, 0, 0, 1, 1 scenes). Apr-Jun 1990 has only path 147 (62% of ROI), and Apr-Jun 1995 has 13 scenes (59% of ROI, 0-1 per path/row). | STAC inventory | Use multi-year windows, see section 3. |
| F3 | No Landsat 5 scenes over the ROI in Apr-Jun 2002-2007. | STAC: 2002-2007 Apr-Jun scenes are all Landsat 7 | The 2005 epoch can only use Landsat 7 SLC-off. |
| F4 | Overpass times drift. **Landsat** (IST, scenes over 146/040): Landsat 5 10:09-10:12 (1990-92), 09:55 (1995), 10:26 (1998), 10:39 (2010); Landsat 7 10:37-10:51 (2001-2019) but **09:17 in 2022 and 08:41 in 2023**; Landsat 8/9 10:48 (stable). **MODIS** (May, granule mid-time over Delhi, IST): Terra day 11:07 (2003-2020), 11:02 (2022), 10:42 (2023), 10:32 (2024), **10:07 (2025)**, **09:22 (2026)**; Terra night 22:27, falling to 21:22 (2025) and 21:02 (2026). Aqua day 13:34-13:42 (2003-2022), then 13:57 (2023), 14:07 (2024), **14:47 (2025)**, 15:27 (2026); Aqua night 02:12, then 02:52 (2024), 03:20 (2025), 04:02 (2026). **VIIRS** S-NPP VNP21: day 13:23-13:33, night 02:03-02:18 for 2013-2026; NOAA-20 VJ121 the same. | STAC datetimes; CMR granule time_start | Terra-based 2025 LST is about 1 h earlier than 2010-2020. That likely explains part of v1's falling epoch means (42.78, 39.94, 39.07, 36.26 °C in manifest.json) and part of the temporal-CV gap. Use VIIRS as the stable successor; drop Landsat 7 after 2020-12-31. |
| F5 | The Earth Engine copy of `NASA/GDDP-CMIP6` has scenarios **historical, ssp245, ssp585** only. | Catalog page "scenario" property | ssp126 and ssp370 come only from AWS `s3://nex-gddp-cmip6` (no-sign-request, us-west-2). I confirmed the `ACCESS-CM2/{historical,ssp126,ssp245,ssp370,ssp585}` folders; one file such as `tasmax_day_ACCESS-CM2_ssp370_r1i1p1f1_gn_2015.nc` is about 245 MB. The COG bucket's `monthly/CMIP6_ensemble_median` seems to hold only historical and ssp245 in its first 2,000 listing keys; ssp585 was not checked. |
| F6 | **Earth Engine noncommercial quota.** Since 2026-04-27: Community tier 150 EECU-hours a month, Contributor tier 1,000 EECU-hours a month (needs an active billing account, noncommercial use not charged), Partner tier 100,000 EECU-hours a month (by application). Over quota, requests run in "restricted mode", slower but not blocked. Quota resets on the 1st of each month (PT). Per-project limits: 40 concurrent requests, 100 requests per second. | developers.google.com/earth-engine/guides/noncommercial_tiers and /guides/usage | Budget in section 5; use the Contributor tier. |
| F7 | Terra and Aqua are past end of life. NASA (modis-land news, updated 2025-11-13) said Terra would run "until the end of the mission in December 2025" and Aqua "until ... August 2026". Earth Engine still has MOD11A2/MYD11A2 up to 2026-09-14, but from heavily drifted orbits. | modis-land.gsfc.nasa.gov/news.html; catalog pages | Do not use Terra after 2022 or Aqua after 2022 for trends without time-of-day correction. Bridge to VIIRS. |
| F8 | Only some product families are in Earth Engine. **Present:** MOD21A1D/N and MYD21A1D/N (daily 1 km, TES algorithm); MOD21C2 and MOD21C3 (0.05°); `NASA/VIIRS/002/VNP21A1D` and `VNP21A1N` (2012-01-19 to 2026-09); gap-filled MODIS LST from Malaria Atlas Project and sat-io. **Not present** (catalog URL is 404 or nothing found): MOD21A2 / MYD21A2 (8-day 1 km), VNP21A2, and NOAA-20 VJ121. | Catalog searches | Build 8-day or seasonal VIIRS composites from the daily VNP21A1D/N. |

---

## 1. Dataset table (verified)

### A. Landsat Collection 2 Level-2 (surface reflectance + surface temperature), 30 m

| Asset | Dates in Earth Engine | Thermal band | Optical bands | Notes |
|---|---|---|---|---|
| `LANDSAT/LT05/C02/T1_L2` | 1984-03-16 to 2012-05-05 | `ST_B6` (TM thermal is 120 m natively, resampled to 30 m) | SR_B1 blue, B2 green, B3 red, B4 NIR, B5 SWIR1, B7 SWIR2 | Landsat 5 TM stopped imaging in Nov 2011. Over this ROI there are no Apr-Jun scenes 2002-2007. |
| `LANDSAT/LE07/C02/T1_L2` | 1999-05-28 to 2024-01-19 | `ST_B6` (60 m natively) | Same as TM | SLC-off after 2003-05-31 leaves wedge-shaped gaps of about 22%. Catalog: "orbit has been drifting to an earlier acquisition time since 2017". Delhi overpass 09:17 IST in 2022, 08:41 IST in 2023. **Drop from 2021.** |
| `LANDSAT/LC08/C02/T1_L2` | 2013-03-18 to present (2026-09-24) | `ST_B10` (100 m natively) | SR_B1 coastal, B2 blue, B3 green, B4 red, B5 NIR, B6 SWIR1, B7 SWIR2 | QA_PIXEL bit 2 = cirrus (Landsat 8/9 only). |
| `LANDSAT/LC09/C02/T1_L2` | 2021-10-31 to present (2026-09-29) | `ST_B10` | As Landsat 8 | |
| Tier 2: `.../T2_L2` | Same | Same | Same | Adds 1990s scenes: 1994 +33, 1996 +55, 1997 +19. Larger geometric error, which is acceptable on a 100-250 m grid. Optional for 1995. |

**Scale and offset**
- All SR bands: reflectance = DN × 2.75e-05 − 0.2. Valid DN range is 7,273-43,636, i.e. reflectance 0-1; mask outside it.
- All ST_B6 / ST_B10: K = DN × 0.00341802 + 149.0.
- Other ST bands: ST_QA (uncertainty, K) × 0.01; ST_EMIS × 0.0001; ST_CDIST (distance to cloud, km) × 0.01; ST_ATRAN × 0.0001; ST_DRAD, ST_URAD, ST_TRAD × 0.001.

**QA_PIXEL bits:** 0 fill · 1 dilated cloud · 2 cirrus (Landsat 8/9) · 3 cloud · 4 cloud shadow · 5 snow · 6 clear · 7 water · 8-9 cloud confidence · 10-11 shadow confidence · 12-13 snow confidence · 14-15 cirrus confidence. **QA_RADSAT:** bits 0-6 = band 1-7 saturation (bit 8 = band 9, bit 11 = terrain occlusion on Landsat 8/9).

**Known issues (catalog):**
- ST retrievals have a known error near clouds and possibly cloud shadows.
- ST is missing where ASTER GED emissivity is missing.
- Night scenes are not processed to ST.

**Recommended mask:**
- Remove pixels with any of QA_PIXEL bits 0-4 set.
- Require QA_RADSAT == 0.
- Require ST_QA × 0.01 ≤ 3 K (stricter is ≤ 2 K).
- Require ST_CDIST × 0.01 ≥ 1 km, to avoid the near-cloud ST error.
- Keep water (bit 7) but flag it.

**Cross-sensor reflectance harmonisation** (Roy et al. 2016, RSE 185, Table 2; ETM+ to OLI ordinary least squares; in the Earth Engine community tutorial "Landsat ETM+ to OLI Harmonization"):
- Slopes `[0.8474, 0.8483, 0.9047, 0.8462, 0.8937, 0.9071]`, intercepts `[0.0003, 0.0088, 0.0061, 0.0412, 0.0254, 0.0172]`, for blue, green, red, NIR, SWIR1, SWIR2. The tutorial multiplies intercepts by 1e4 because it used the old C1 ×1e4 scaling. On C2 reflectance already scaled to 0-1, apply them unscaled.
- TM is usually treated like ETM+ (same coefficients).
- Thermal: no reflectance-style harmonisation is needed (ST is physically retrieved), but timing differs. Landsat 5 in the early 1990s passed about 40 min earlier (10:10 IST) than Landsat 8/9 (10:48 IST). Use the anomaly target (LST minus epoch mean) and/or ERA5-Land hourly skin-temperature ratios to normalise.

**Broadband albedo for every epoch** (Liang 2001, TM/ETM+ band numbers; for OLI use bands 2, 4, 5, 6, 7):
α = 0.356·blue + 0.130·red + 0.373·NIR + 0.085·SWIR1 + 0.072·SWIR2 − 0.0018.
Check it against `MODIS/061/MCD43A3` for 2000-2012.

**Landsat 1989-1997 archive status:**
- The Landsat 5 Ku-band TDRS relay failed in 1988 (primary) and July 1992 (backup). After that the USGS archive held only scenes received by US stations; 1990s Indian scenes reached USGS through the Landsat Global Archive Consolidation (Wulder et al. 2016, RSE 185: "inactive stations in ... India ... have transferred their Landsat data holdings").
- Result (all scenes / Apr-Jun Tier-1 with ≤30% land cloud):
  - 1989: 37 / 2
  - 1990: 64 / 16
  - 1991: 116 / 15
  - 1992: 148 / 36
  - 1993: 211 / 47
  - 1994: 238 / 39
  - 1995: 102 / 13
  - 1996: 222 / 37
  - 1997: 133 / 3
  - 1998: 246 / 60
  - 1999: 176 / 28
  - 2000: 177 / 47

  So the early 1990s are sparse but not empty, and 1995 and 1997 are weak years.

### B. MODIS / VIIRS LST, 1 km

| Asset | Dates | Bands, scale and QC | Overpass over Delhi (IST, May) |
|---|---|---|---|
| `MODIS/061/MOD11A2` (Terra, 8-day) | 2000-02-18 to 2026-09-14 | `LST_Day_1km`, `LST_Night_1km` × 0.02 K; `QC_Day`, `QC_Night`; `Day_view_time`, `Night_view_time` × 0.1 h (local solar time); `Day_view_angl`, `Night_view_angl` (offset −65); `Emis_31`, `Emis_32` × 0.002 + 0.49; `Clear_sky_days`, `Clear_sky_nights`. QC bits: 0-1 mandatory (0 good, 1 other quality, 2 cloud, 3 not produced); 2-3 data quality; 4-5 emissivity error (≤0.01, ≤0.02, ≤0.04, >0.04); 6-7 LST error (≤1, ≤2, ≤3, >3 K). Each 8-day value is a plain average of daily values. | Day 11:07 (2003-2020) → 10:07 (2025) → 09:22 (2026). Night 22:27 → 21:22 (2025) |
| `MODIS/061/MYD11A2` (Aqua, 8-day) | 2002-07-04 to 2026-09-14 | Same | Day 13:39 (2003-2022) → 14:47 (2025). Night 02:12 → 03:20 (2025) |
| `MODIS/061/MOD11A1`, `MYD11A1` (daily) | Terra 2000+, Aqua 2002+ | Same layout | Same |
| `MODIS/061/MOD21A1D`, `MOD21A1N`, `MYD21A1D`, `MYD21A1N` (daily, TES algorithm) | MOD21A1D 2000-02-24 to 2026-09-27 | `LST_1KM`, `QC` (bits 0-1 mandatory, 4-5 cloud, 14-15 LST accuracy), `Emis_29/31/32`, `View_Angle`, `View_Time`. The catalog says LST_1KM has "scale already applied" but also lists a range of 7,500-65,535: **check at run time** (if values > 1,000, multiply by 0.02). | Same orbits as MOD11/MYD11 |
| `NASA/VIIRS/002/VNP21A1D`, `VNP21A1N` (S-NPP, daily, TES algorithm) | 2012-01-19 to 2026-09-29 (Night to 2026-09-27) | `LST_1KM` (K), `QC` (0-1 mandatory, 2-3 L1B quality, 4-5 cloud 0..3, 6-7 iterations, 8-9 atmospheric opacity, 10-11 MMD, 12-13 emissivity accuracy, 14-15 LST accuracy 0 = >2 K … 3 = <1 K), `Emis_14/15/16`, `View_Angle`, `View_Time`. Scale is not stated on the page: check at run time. | **Day 13:26, night 02:06, stable 2013-2026** |
| sat-io `projects/sat-io/open-datasets/gap-filled-lst/gf_day_1km`, `.../gf_night_1km` | 2003-2020 daily | 0.1 °C units; all-sky gap-filled from Terra+Aqua (RMSE 1.88 K day, 1.33 K night) | 13:30 / 01:30 equivalent |
| `projects/sat-io/open-datasets/GSHTD/{CLEAR_SKY_DAY,CLEAR_SKY_NIGHT,ALL_SKY_DAY,ALL_SKY_NIGHT,TMAX,TMEAN,TMIN}` | 2001-2020 monthly, 1 km | Seamless LST and air temperature | |
| `projects/malariaatlasproject/assets/LST_Day_v061/1km/Monthly` | 2001-03 to 2024-12 | Band `Mean`, °C. License CC-BY-NC-SA-4.0; the catalog lists the pixel size as 5,000 m. | |

**Choice of successor product:**
- Aqua (13:39 / 02:12 IST) and VIIRS S-NPP (13:26 / 02:06 IST) are almost the same time of day, so the Aqua-to-VIIRS bridge is clean.
- Calibrate per pixel (or per land-cover class) on the 2013-2021 overlap. The algorithms differ: MYD11 uses split-window, VNP21 uses TES, with known differences of 1-3 K over arid and bare surfaces.
- Terra cannot be bridged as cleanly. Use `Day_view_time` and `Night_view_time` to (a) drop composites outside a time window, or (b) put the observation time in as a model covariate.

### C. Drivers

| Variable | Asset | Bands / values | Resolution | Time span |
|---|---|---|---|---|
| Built-up surface | `JRC/GHSL/P2023A/GHS_BUILT_S/<year>` (`ee.Image`) | `built_surface`, `built_surface_nres` (m² per 100 m cell) | 100 m | 1975-2030, every 5 years (2025 and 2030 extrapolated) |
| Building volume | `JRC/GHSL/P2023A/GHS_BUILT_V/<year>` | `built_volume_total`, `built_volume_nres` (m³) | 100 m | 1975-2030, every 5 years |
| Building height | `JRC/GHSL/P2023A/GHS_BUILT_H/2018` | `built_height` (m) | 100 m | 2018 only (static) |
| Population | `JRC/GHSL/P2023A/GHS_POP/<year>` | `population_count` (people per cell) | 100 m | 1975-2030, every 5 years (2025 and 2030 projected) |
| Degree of urbanisation | `JRC/GHSL/P2023A/GHS_SMOD_V2-0/<year>` (`GHS_SMOD` is deprecated) | `smod_code` (10 water; 11-13 rural; 21-23 urban clusters; 30 urban centre) | 1 km | 1975-2030, every 5 years |
| Population (alternative) | `WorldPop/GP/100m/pop` (v1 already uses it); `projects/sat-io/open-datasets/WORLDPOP/pop` (Global2 R2025A) | `population` | 100 m | 2000-2020; 2015-2030 annual |
| Land cover, 30 m | `projects/sat-io/open-datasets/GLC-FCS30D/five-years-map` (tiles: mosaic, bands b1 = 1985, b2 = 1990, b3 = 1995); `projects/sat-io/open-datasets/GLC-FCS30D/annual` (b1 = 2000 … b23 = 2022) | 36 class codes: 10/11/12/20 cropland; 51-92 forest; 120-153 shrub and grass; 181-187 wetland; 190 impervious; 200-202 bare; 210 water; 220 ice; 0 fill | 30 m | 1985, 1990, 1995, then 2000-2022 |
| Land cover, recent | `GOOGLE/DYNAMICWORLD/V1` (from mid-2015); `ESA/WorldCover/v100` (2020), `v200` (2021) | | 10 m | 2015+ |
| Night lights, consistent | `projects/sat-io/open-datasets/srunet-npp-viirs-ntl` | VIIRS-like radiance, 0 = no data | ≈500 m (15″) | **1992-2023** annual |
| Night lights, alternatives | `projects/sat-io/open-datasets/npp-viirs-ntl` (Chen et al. 2021, 2000-2023); `projects/sat-io/open-datasets/Harmonized_NTL/dmsp` (1992-2013) and `/viirs` (2014-2021) (Li et al. 2020, DN 0-63, authors advise DN > 7) | | ≈1 km | |
| Night lights, recent | `NOAA/VIIRS/DNB/ANNUAL_V22` (2012-2024; bands average, average_masked, median, median_masked, cf_cvg, cvg, minimum, maximum); `NOAA/VIIRS/DNB/MONTHLY_V1/VCMSLCFG` (v1 uses this) | nW/cm²/sr | 463 m | 2012-2025 |
| Meteorology | `ECMWF/ERA5_LAND/MONTHLY_AGGR` (1950-02 to 2026-08); `ECMWF/ERA5_LAND/DAILY_AGGR` (1950-01-02 to 2026-09-23; UTC days); `ECMWF/ERA5_LAND/HOURLY` (1950 to 2026-09-25, UTC) | `temperature_2m`, `dewpoint_temperature_2m`, `skin_temperature`, `volumetric_soil_water_layer_1`, `total_precipitation_sum`, `u_component_of_wind_10m`, `v_component_of_wind_10m`, `surface_solar_radiation_downwards_sum`, `total_evaporation_sum`, `leaf_area_index_high_vegetation`, `leaf_area_index_low_vegetation`. Daily product has `temperature_2m_max` / `_min`. Three evaporation component bands are known to be swapped. | 11.1 km | 1950 to present |
| Albedo | `MODIS/061/MCD43A3` | `Albedo_WSA_shortwave`, `Albedo_BSA_shortwave` × 0.001; QA `BRDF_Albedo_Band_Mandatory_Quality_shortwave` (0 = full inversion) | 500 m | 2000-02-24 to 2026-09 |
| Emissivity | `NASA/ASTER_GED/AG100_003` | emissivity bands 10-14 × 0.001 (sd × 0.0001), ndvi × 0.01, temperature × 0.01 K | 100 m | 2000-2008 mean (static) |
| Evapotranspiration | `MODIS/061/MOD16A2GF` | `ET`, `PET` × 0.1 kg/m²/8 days; `LE`, `PLE` | 500 m | 2000-01-01 to 2025-12-27 |
| Soil moisture | `NASA/SMAP/SPL4SMGP/008` | `sm_surface`, `sm_rootzone`, `surface_temp` | 11 km, 3-hourly | 2015-03-31+ only; use ERA5-Land swvl1 for consistency |
| Water | `JRC/GSW1_4/GlobalSurfaceWater` (occurrence, change_abs, seasonality, recurrence, transition, max_extent; 1984-2021); `JRC/GSW1_4/YearlyHistory` (per-year water, 1984-2021; not checked on its own page) | | 30 m | 1984-2021 |
| Roads | `projects/sat-io/open-datasets/GRIP4/South-East-Asia` (India; vector, GP_RTP type) | | vector | about 2018, static: temporally inconsistent, use only as a static covariate |
| Terrain | `USGS/SRTMGL1_003` (v1), or `COPERNICUS/DEM/GLO30` | | 30 m | static |

### D. Future inputs to 2050

| Need | Asset / source | Details |
|---|---|---|
| Climate | `NASA/GDDP-CMIP6` (Earth Engine) | 1950-01-01 to 2100-12-31, daily, 0.25° (27,830 m). Bands: `tas`, `tasmax`, `tasmin` (K); `hurs` (%); `huss`; `pr` (kg/m²/s); `rsds`, `rlds` (W/m²); `sfcWind` (m/s). Image properties: model, scenario, year, month, day, grid_label, interpolated, version. **Scenarios: historical (to 2014), ssp245, ssp585.** 34 models: ACCESS-CM2, ACCESS-ESM1-5, BCC-CSM2-MR, CESM2, CESM2-WACCM, CMCC-CM2-SR5, CMCC-ESM2, CNRM-CM6-1, CNRM-ESM2-1, CanESM5, EC-Earth3, EC-Earth3-Veg-LR, FGOALS-g3, GFDL-CM4, GFDL-ESM4, GISS-E2-1-G, HadGEM3-GC31-LL, HadGEM3-GC31-MM, IITM-ESM, INM-CM4-8, INM-CM5-0, IPSL-CM6A-LR, KACE-1-0-G, KIOST-ESM, MIROC-ES2L, MIROC6, MPI-ESM1-2-HR, MPI-ESM1-2-LR, MRI-ESM2-0, NESM3, NorESM2-LM, NorESM2-MM, TaiESM1, UKESM1-0-LL. Some models lack hurs/huss; some days are interpolated or duplicated. |
| Climate, other scenarios | AWS `s3://nex-gddp-cmip6/NEX-GDDP-CMIP6/<model>/<ssp126,ssp245,ssp370,ssp585,historical>/r1i1p1f1/<var>/<var>_day_<model>_<ssp>_r1i1p1f1_gn_<year>[_v2.0].nc` | About 245 MB per global file. Prefer the `_v2.0` files where both exist. Fetch only Apr-Jun of the delta windows for about 6-10 models, or pattern-scale the ssp245 delta. |
| Urban land, SSP | `projects/sat-io/open-datasets/FUTURE-URBAN-LAND/CHEN_2020_2100` | 1 km; value 2 = urban, 1 = non-urban; 2020-2100 every 10 years; one band per SSP1-5 |
| Urban land, SSP (coarse) | `projects/sat-io/open-datasets/FUTURE-URBAN-LAND/GAO_2020_2100` | 1/8°, urban fraction (probability); 2020-2100 every 10 years; bands per SSP |
| Urban extent 1870-2100 | `projects/sat-io/open-datasets/global-urban-extents/{hindcast_urban_extent (1870-1990, 10-yr), observed_urban_extent (1992-2013), project_urban_scenarios (2020-2100, SSPs)}` | 1 km binary |
| Built-up / population to 2030 | GHSL P2023A 2025 and 2030 epochs; WorldPop Global2 to 2030 | |
| Population, SSP to 2100 | WorldPop FuturePop v0.2 (DOI 10.5258/SOTON/WP00849; 2025-2100 every 5 years; SSP1-5; 1 km; download, not in Earth Engine); Wang et al. 2022 Sci Data 9:563 (figshare; 2020-2100 every 5 years; SSP1-5; 1 km); FPOPv1 (Zenodo 10716877) | Rescale to the GHS-POP 2030 ROI total for continuity |
| LUH2 | Not in Earth Engine; 0.25° | Too coarse; skip |

---

## 2. Per-epoch source matrix (most consistent choice; ★ = primary)

| Variable | 1990 | 1995 | 2000 | 2005 | 2010 | 2015 | 2020 | 2025 | 2030 / 2040 / 2050 |
|---|---|---|---|---|---|---|---|---|---|
| **Day LST, fine (target)** | ★ Landsat 5, Apr-Jun 1989-92 (69 scenes; ≥3 per path/row) | ★ Landsat 5, 1994-96 (89) | ★ Landsat 5 + Landsat 7 (pre-SLC), 1999-01 (110) | ★ Landsat 7 SLC-off only, 2004-06 (155) | ★ Landsat 5 + 7, 2009-11 (332) | ★ Landsat 8 + 7, 2014-16 (354) | ★ Landsat 8 + Landsat 7 up to 2020-12-31, 2019-21 (302) | ★ Landsat 8 + 9, 2024-26 (367) | Model output |
| Day LST, 1 km (validation / 1 km product) | none | none | Terra MOD11A2 (Aqua starts 2002-07) | Terra + Aqua | Terra + Aqua | Terra + Aqua + VNP21A1D | Terra + Aqua + VNP21A1D | ★ VNP21A1D; Terra (10:07) and Aqua (14:47) only with time correction | Model |
| **Night LST, 1 km** | Modelled: ERA5-Land hourly skin T at 20-21 UTC (01:30-02:30 IST), downscaled with an urban-form model trained 2003-2025. Flag as modelled. | Same | Terra night 2000-02 (22:27 IST) mapped to the 02:00 equivalent via ERA5-Land diurnal ratio | ★ Aqua MYD11A2 night (02:12) | ★ Aqua night | ★ Aqua + VNP21A1N | ★ Aqua + VNP21A1N | ★ VNP21A1N (02:06); Aqua drifted to 03:20 | Model |
| Spectral (NDVI, NDBI, MNDWI, albedo) | ★ Harmonised Landsat, same composite as LST | ★ | ★ | ★ (SLC-off composite) | ★ | ★ | ★ | ★ | Scenario-adjusted from built-up change |
| Built-up fraction | ★ GHS_BUILT_S 1990 | ★ 1995 | ★ 2000 | ★ 2005 | ★ 2010 | ★ 2015 | ★ 2020 | ★ 2025 (extrapolated) | 2030: GHS_BUILT_S 2030. 2040/2050: GHSL 2030 + Chen 2020 SSP urban increment (value 2), cross-checked with Gao & O'Neill |
| Building volume | ★ GHS_BUILT_V for each epoch | ★ | ★ | ★ | ★ | ★ | ★ | ★ | 2030 GHSL; later held at 2030 or scaled with built-up |
| Population | ★ GHS_POP 1990 | ★ 1995 | ★ 2000 | ★ 2005 | ★ 2010 | ★ 2015 | ★ 2020 | ★ 2025 | 2030 GHSL; 2040/2050 FuturePop / Wang 2022 SSP rescaled to GHS-POP 2030 |
| Land-cover fractions | ★ GLC_FCS30D 1990 (b2) | ★ 1995 (b3) | ★ annual b1 (2000) | ★ b6 | ★ b11 | ★ b16 | ★ b21 | GLC_FCS30D 2022 (b23) + Dynamic World 2025 change mask | Derived from built-up scenario |
| Night lights | srunet 1992 (nearest; caveat), or hindcast from GHSL ratio | ★ srunet 1995 | ★ srunet 2000 | ★ 2005 | ★ 2010 | ★ 2015 | ★ 2020 | srunet 2023 + VIIRS ANNUAL_V22 2024 + monthly 2025, calibrated on 2014-2023 overlap | Not projectable: drop from the future model, or replace with GHS-SMOD / built volume |
| Meteorology (Apr-Jun T2m, Td, RH/VPD, skin T, swvl1, precip, wind, SSRD) | ★ ERA5-Land monthly | ★ | ★ | ★ | ★ | ★ | ★ | ★ | ERA5-Land 1995-2014 climatology + GDDP-CMIP6 multi-model delta |
| ET / soil moisture | ERA5-Land evaporation / swvl1 (★ for consistency) | ★ | + MOD16A2GF | + MOD16 | + MOD16 | + MOD16, SMAP | + SMAP | + MOD16 (to 2025-12), SMAP | GDDP pr / hurs deltas |
| Albedo | Landsat Liang 2001 ★ | ★ | ★ (check vs MCD43A3) | ★ | ★ | ★ | ★ | ★ | Scenario-adjusted |
| Water proximity | JRC GSW YearlyHistory 1989-92 | 1994-96 | 1999-01 | 2004-06 | 2009-11 | 2014-16 | 2019-21 | GSW 2021 + Dynamic World | Held at 2025 |
| Terrain, ASTER emissivity, roads, building height | Static | Static | Static | Static | Static | Static | Static | Static | Static |

**Harmonisation and gap-filling rules**
1. **Landsat composites.** Per epoch window, take the Apr-Jun median of QA-clean ST and harmonised SR at 30 m. Then mean-aggregate to the analysis grid, requiring at least 50% valid area per cell (as v1 does). Store the per-pixel valid count and mean acquisition DOY/time as quality bands.
2. **Landsat 7 SLC-off (2004-2006).** Median over at least 9 scenes per path/row (available: 9-13) fills most stripes. Remaining gaps at 30 m disappear after mean-aggregation to 100-250 m at ≥50% coverage. For 2010-2020, Landsat 7 is optional, since Landsat 5 or 8 alone gives at least 3 scenes everywhere.
3. **Time of day.** Model the epoch anomaly (LST minus the ROI median), as v1 does. Also add a per-epoch scalar correction using ERA5-Land hourly `skin_temperature` at the scene time vs at a 10:45 IST reference.
4. **Day LST across sensors.** Report absolute-LST trends only from time-normalised data. For MODIS, calibrate Aqua against VIIRS on 2013-2021 per land-cover class (linear) and switch to VIIRS from 2022.
5. **Night LST before 2000.** A model hindcast, not an observation. The dashboard should label it "modelled".
6. **Night lights in 1990.** No DMSP data before 1992. Use 1992 with a caveat, or set NTL(1990) = NTL(1992) × (BUILT_S 1990 / BUILT_S 1992 interpolated).
7. **Land cover in 2025.** GLC_FCS30D ends in 2022. Map Dynamic World 2025 modal classes to the same six classes, and only override GLC 2022 where Dynamic World shows built or water change.
8. **Population scale continuity.** Rescale every population source to the GHS-POP ROI total of its overlap year (v1 already does WorldPop ↔ GHS 2020).

---

## 3. Landsat scene inventory (USGS C2 L2 ST; Tier-1; Apr-Jun; land cloud ≤30%)

Per-path/row counts are for 146/040, 146/041, 147/039, 147/040, 147/041.

| Epoch | Window | Scenes | Per path/row | Sensors | ROI with ≥3 scenes |
|---|---|---|---|---|---|
| 1990 | 1989-1992 | 69 | 3, 3, 8, 10, 10 | Landsat 5 | 100% (1990 alone: 62%, path 147 only) |
| 1995 | 1994-1996 | 89 | 5, 6, 4, 4, 4 | Landsat 5 | 100% (1995 alone: 59% with ≥1 scene) |
| 2000 | 1999-2001 | 110 | 8, 10, 8, 6, 7 | Landsat 5: 52; Landsat 7: 58 | 100% |
| 2005 | 2004-2006 | 155 | 9, 12, 13, 13, 13 | Landsat 7 only (SLC-off) | 100% (no Landsat 5 in Apr-Jun 2002-07) |
| 2010 | 2009-2011 | 332 | 20, 21, 26, 30, 29 | Landsat 5: 177; Landsat 7: 155 | 100% |
| 2015 | 2014-2016 | 354 | 21, 26, 27, 26, 27 | Landsat 8: 180; Landsat 7: 174 | 100% |
| 2020 | 2019-2021 (Landsat 7 up to 2020-12-31) | 302 | 20, 22, 22, 27, 26 | Landsat 8: 178; Landsat 7: 124 | 100% |
| 2025 | 2024-2026 | 367 | 23, 25, 29, 29, 29 | Landsat 8: 182; Landsat 9: 185 | 100% |

Cloud is not the limit in the pre-monsoon season: 80-95% of Apr-Jun scenes have ≤30% land cloud. Dust and haze are not flagged by QA_PIXEL, so the ST_QA ≤ 3 K filter and median compositing are what protect against them. A symmetric ±2-year window is also fine for every epoch; the windows above are the narrowest that give ≥3 scenes everywhere.

---

## 4. Recommended GEE recipes (Python API, server side)

```python
# --- Landsat C2 L2: merged, scaled, masked, harmonised (pre-monsoon) ---
def prep_l57(img):
    qa = img.select('QA_PIXEL')
    clear = qa.bitwiseAnd(0b11111).eq(0)              # bits 0-4: fill, dilated cloud, (cirrus), cloud, shadow
    ok = clear.And(img.select('QA_RADSAT').eq(0))
    ok = ok.And(img.select('ST_QA').multiply(0.01).lte(3)).And(img.select('ST_CDIST').multiply(0.01).gte(1))
    sr = img.select(['SR_B1','SR_B2','SR_B3','SR_B4','SR_B5','SR_B7'],
                    ['blue','green','red','nir','swir1','swir2']).multiply(2.75e-05).add(-0.2)
    slopes = ee.Image.constant([0.8474,0.8483,0.9047,0.8462,0.8937,0.9071])
    itcps  = ee.Image.constant([0.0003,0.0088,0.0061,0.0412,0.0254,0.0172])
    sr = sr.multiply(slopes).add(itcps)                   # ETM+/TM -> OLI (Roy et al. 2016, OLS)
    st = img.select('ST_B6').multiply(0.00341802).add(149.0).subtract(273.15).rename('lst')
    return sr.addBands(st).updateMask(ok).updateMask(sr.reduce('min').gte(0)).updateMask(sr.reduce('max').lte(1))

def prep_l89(img):
    qa = img.select('QA_PIXEL')
    ok = qa.bitwiseAnd(0b11111).eq(0).And(img.select('QA_RADSAT').eq(0))
    ok = ok.And(img.select('ST_QA').multiply(0.01).lte(3)).And(img.select('ST_CDIST').multiply(0.01).gte(1))
    sr = img.select(['SR_B2','SR_B3','SR_B4','SR_B5','SR_B6','SR_B7'],
                    ['blue','green','red','nir','swir1','swir2']).multiply(2.75e-05).add(-0.2)
    st = img.select('ST_B10').multiply(0.00341802).add(149.0).subtract(273.15).rename('lst')
    return sr.addBands(st).updateMask(ok)

def landsat_epoch(y0, y1, roi):
    f = (ee.Filter.calendarRange(4, 6, 'month'))
    d = ee.Filter.date(f'{y0}-01-01', f'{y1+1}-01-01')
    l5 = ee.ImageCollection('LANDSAT/LT05/C02/T1_L2').filter(d).filter(f).filterBounds(roi).map(prep_l57)
    l7 = (ee.ImageCollection('LANDSAT/LE07/C02/T1_L2').filter(d).filter(f).filterBounds(roi)
          .filterDate('1999-01-01', '2021-01-01').map(prep_l57))      # drop drifted Landsat 7
    l8 = ee.ImageCollection('LANDSAT/LC08/C02/T1_L2').filter(d).filter(f).filterBounds(roi).map(prep_l89)
    l9 = ee.ImageCollection('LANDSAT/LC09/C02/T1_L2').filter(d).filter(f).filterBounds(roi).map(prep_l89)
    col = l5.merge(l7).merge(l8).merge(l9)
    med = col.median()
    ndvi = med.normalizedDifference(['nir','red']).rename('ndvi')
    ndbi = med.normalizedDifference(['swir1','nir']).rename('ndbi')
    mndwi = med.normalizedDifference(['green','swir1']).rename('mndwi')
    alb = med.expression('0.356*b+0.130*r+0.373*n+0.085*s1+0.072*s2-0.0018',
        {'b':med.select('blue'),'r':med.select('red'),'n':med.select('nir'),
         's1':med.select('swir1'),'s2':med.select('swir2')}).rename('albedo')
    return ee.Image.cat([med.select('lst'), ndvi, ndbi, mndwi, alb, col.select('lst').count().rename('n_obs')])

# --- MODIS 8-day day/night with QC and view time ---
def modis_dn(coll, which, y0, y1):   # coll 'MODIS/061/MOD11A2' | 'MODIS/061/MYD11A2'; which 'Day' | 'Night'
    def f(img):
        qc = img.select(f'QC_{which}')
        good = qc.bitwiseAnd(3).lte(1).And(qc.rightShift(6).bitwiseAnd(3).lte(1))   # LST err <= 2 K
        lst = img.select(f'LST_{which}_1km').multiply(0.02).subtract(273.15)
        t = img.select(f'{which}_view_time').multiply(0.1)                          # local solar hours
        return lst.rename('lst').addBands(t.rename('vtime')).updateMask(good)
    return (ee.ImageCollection(coll).filterDate(f'{y0}-01-01', f'{y1+1}-01-01')
            .filter(ee.Filter.calendarRange(4, 6, 'month')).map(f))

# --- VIIRS S-NPP daily -> seasonal ---
def viirs(which, y0, y1):            # which 'D' | 'N'
    col = ee.ImageCollection(f'NASA/VIIRS/002/VNP21A1{which}').filterDate(f'{y0}-01-01', f'{y1+1}-01-01') \
            .filter(ee.Filter.calendarRange(4, 6, 'month'))
    def f(img):
        qc = img.select('QC')
        ok = qc.bitwiseAnd(3).lte(1).And(qc.rightShift(14).bitwiseAnd(3).gte(2))  # LST accuracy <= 1.5 K
        return img.select('LST_1KM').updateMask(ok)   # check at run time: K, or DN x 0.02
    return col.map(f).median()

# --- GDDP-CMIP6 pre-monsoon multi-model delta (tasmax) ---
def gddp_delta(scen, c0, c1, var='tasmax'):
    base = ee.ImageCollection('NASA/GDDP-CMIP6').filter(ee.Filter.eq('scenario', 'historical')) \
             .filterDate('1995-01-01', '2015-01-01').filter(ee.Filter.calendarRange(4, 6, 'month')).select(var)
    fut = ee.ImageCollection('NASA/GDDP-CMIP6').filter(ee.Filter.eq('scenario', scen)) \
             .filterDate(f'{c0}-01-01', f'{c1+1}-01-01').filter(ee.Filter.calendarRange(4, 6, 'month')).select(var)
    models = fut.aggregate_array('model').distinct()
    def per_model(m):
        return fut.filter(ee.Filter.eq('model', m)).mean().subtract(base.filter(ee.Filter.eq('model', m)).mean()) \
                  .set('model', m)
    deltas = ee.ImageCollection(models.map(per_model))
    return deltas.reduce(ee.Reducer.percentile([10, 50, 90]))   # K; per 0.25 deg cell
# windows: 2030 -> 2021-2040, 2040 -> 2031-2050, 2050 -> 2041-2060; baseline 1995-2014 (AR6).
# Remove what has already happened: future delta = delta(t) - delta(2025, ssp245 2015-2034).
```

Notes:
- `ERA5_LAND/MONTHLY_AGGR`: filter months 4-6 of the epoch window, then `mean()`. Get RH from T2m and Td (Magnus formula) and wind speed from √(u² + v²).
- GLC_FCS30D: `ee.ImageCollection(path).filterBounds(roi).mosaic().select('b2')` gives 1990. The five-year bands are b1 = 1985, b2 = 1990, b3 = 1995; the annual bands are b1 = 2000 … b23 = 2022.

---

## 5. computePixels practicalities and time / EECU budget

**Hard limits (REST computePixels / getPixels):**
- 48 MB uncompressed per request (50,331,648 bytes = width × height × bands × bytes per pixel).
- At most 32,768 px per side and 1,024 bands per request.
- Per project: 40 concurrent requests, 100 requests per second.
- Throughput reference (Earth Engine blog "Pixels to the people"): one 4096² request ≈ 7.8 Mpx/s; 4 concurrent ≈ 13.1 Mpx/s; 8 concurrent ≈ 17.4 Mpx/s.

**ROI size in EPSG:32643:** about 300 km × 365 km (bbox).

| Grid | Pixels in bbox | Valid ROI cells | 20-band float32 per epoch | Max square tile, 20 bands | Comment |
|---|---|---|---|---|---|
| 1 km | 0.11 M | 55 k | 8.8 MB | 1,120² (one request) | MODIS-native day/night product |
| 250 m | 1.75 M | 0.88 M | 140 MB | about 780² (use 512²: about 28 tiles) | **Recommended ML grid**: 8 epochs ≈ 7 M rows × about 40 features ≈ 1.1 GB float32; fits the T4s and 29 GB RAM, and a GraphSAGE with 0.9 M nodes per epoch is feasible |
| 100 m | 11 M | 5.5 M | 876 MB | about 780² (use 512²: about 168 tiles) | Display tiles for the Delhi core only; 8 epochs = 44 M rows, too heavy for the GNN |
| 30 m | 122 M | 61 M | — | — | Do not pull; aggregate server side |

**Pattern that saves EECU.** The heavy part is the server-side 30 m median over 70-370 scenes, not the transfer.
1. For each epoch, export the finished predictor stack once with `Export.image.toAsset` (batch: no interactive deadline, retried server side) at 100 m, in EPSG:32643 on the v1 grid transform.
2. Then `computePixels` the assets at 250 m or 100 m. Each pass costs only seconds of EECU, and reruns and debugging are almost free.

The Kaggle service account can start batch tasks into `projects/ncr-lst-510004/assets/...`.

**EECU and wall-clock estimates.** These are my own estimates, not measured. Calibrate with a one-epoch pilot and read the EECU used from the task list or Cloud Monitoring.

| Job | Volume | EECU-hours (rough) | Wall-clock on Kaggle |
|---|---|---|---|
| Landsat epoch composite (30 m → 100 m asset) | 70-370 scenes; 61 Mpx per scene-equivalent | 1-3 per epoch (1990-2005), 3-8 per epoch (2010-2025) → **about 20-45 total** | Batch 20-90 min per epoch, run in parallel (several tasks at once) |
| MODIS Terra + Aqua day/night, 8-day, 2000-2025, Apr-Jun | about 12 composites × 2 sensors × 2 per year | < 0.5 per epoch → about 3 | Minutes |
| VIIRS VNP21A1D/N daily, 2012-2026, Apr-Jun | about 91 images × 2 per year | < 0.5 per epoch → about 2 | Minutes |
| Drivers (GHSL, GLC_FCS30D, NTL, ERA5-Land, MCD43A3, GSW) | Static or 5-yearly | about 2-5 total | < 30 min |
| GDDP-CMIP6 deltas (34 models × 3 scenarios × 4 windows, Apr-Jun daily) | about 250 k daily images, but a tiny ROI (about 15 × 15 cells at 0.25°) | about 1-5 | 10-40 min; batch Export.table per scenario is recommended |
| Annual ROI/district series 1990-2025 via reduceRegions (Landsat Apr-Jun single-year composites at scale 120 m, tileScale 4-8; MODIS/VIIRS at 1 km) | 37 Landsat years + 26 MODIS + 15 VIIRS years, day and night | Landsat 0.3-1 per year → about 10-35; MODIS/VIIRS about 2 | 1-3 h if serialised; run as an Export.table batch |
| **Total** | | **about 40-100 EECU-hours**, plus retries and debugging | Fits easily in one Kaggle session if heavy steps are batch-exported to assets |

Interpretation:
- **Community tier (150 EECU-hours a month):** one clean run fits, but debugging reruns could push the project into restricted mode for the rest of the month.
- **Contributor tier (1,000 EECU-hours a month):** generous headroom. Strongly recommended.
- **Pyramid caveat:** reduceRegions at coarse `scale` reads pyramid levels, so the QA bit tests run on downsampled QA values. For annual district means, set the composite to its native projection, or `reproject` to 30 m before `reduceRegions` with `tileScale`. Alternatively accept the sampling bias as a small error in district means.

---

## 6. Caveats

- **Absolute LST trends** across 1990-2025 mix three things: sensor overpass times (Landsat 5 at 10:10 vs Landsat 8/9 at 10:48 IST; Terra and Aqua drift), year-to-year pre-monsoon weather, and real urban warming. Use anomaly targets for the spatial model; derive trends from time-corrected, weather-normalised series (covariates: ERA5-Land T2m and swvl1).
- **v1's 2025 MODIS epoch** was observed around 10:07 IST instead of 11:07 IST. This is probably a cause of the 2010-2020 → 2025 temporal-transfer drop (R² 0.80 / 1.28 °C RMSE for XGBoost). Rerun 2025 with VIIRS, or with Terra composites filtered by Day_view_time.
- **GHSL 2025/2030 and GHS-POP 2025/2030** are extrapolations, and GHSL multitemporal accuracy before 2000 is lower (Landsat-based backcasting).
- **GLC_FCS30D 1985-1995** is a five-year product with about 80.9% overall accuracy globally. Expect cropland/fallow confusion in Haryana/UP pre-monsoon (bare fields in April-June).
- **Night lights 1992-2013** are DMSP-based. The srunet super-resolved series is learned, not observed; saturation in the urban core is reduced but not physical.
- **ERA5-Land** (11 km) has known warm/dry biases over irrigated Indo-Gangetic croplands, because irrigation is not modelled.
- **GDDP-CMIP6** is bias-corrected (BCSD) against GMFD at 0.25°. It captures air temperature, not LST. Converting it to LST needs an empirical sensitivity (∂LST/∂Tmax) fitted on 2003-2025 observations; do not add ΔTmax to LST one-to-one without testing.
- **Chen et al. 2020** is binary urban at 1 km. Convert it to a fractional increment relative to its own 2020 layer before adding it to GHSL 2030, otherwise the baselines will not match.

---

## Sources

- Earth Engine catalog:
  - Landsat 5 C2 L2: https://developers.google.com/earth-engine/datasets/catalog/LANDSAT_LT05_C02_T1_L2
  - Landsat 7 C2 L2: https://developers.google.com/earth-engine/datasets/catalog/LANDSAT_LE07_C02_T1_L2
  - Landsat 8 C2 L2: https://developers.google.com/earth-engine/datasets/catalog/LANDSAT_LC08_C02_T1_L2
  - Landsat 9 C2 L2: https://developers.google.com/earth-engine/datasets/catalog/LANDSAT_LC09_C02_T1_L2
  - MOD11A2: https://developers.google.com/earth-engine/datasets/catalog/MODIS_061_MOD11A2
  - MYD11A2: https://developers.google.com/earth-engine/datasets/catalog/MODIS_061_MYD11A2
  - MOD21A1D: https://developers.google.com/earth-engine/datasets/catalog/MODIS_061_MOD21A1D
  - VNP21A1D: https://developers.google.com/earth-engine/datasets/catalog/NASA_VIIRS_002_VNP21A1D
  - VNP21A1N: https://developers.google.com/earth-engine/datasets/catalog/NASA_VIIRS_002_VNP21A1N
  - Surface-temperature tag list: https://developers.google.com/earth-engine/datasets/tags/surface-temperature
  - GHS_BUILT_S: https://developers.google.com/earth-engine/datasets/catalog/JRC_GHSL_P2023A_GHS_BUILT_S
  - GHS_BUILT_V: https://developers.google.com/earth-engine/datasets/catalog/JRC_GHSL_P2023A_GHS_BUILT_V
  - GHS_BUILT_H: https://developers.google.com/earth-engine/datasets/catalog/JRC_GHSL_P2023A_GHS_BUILT_H
  - GHS_POP: https://developers.google.com/earth-engine/datasets/catalog/JRC_GHSL_P2023A_GHS_POP
  - GHS_SMOD: https://developers.google.com/earth-engine/datasets/catalog/JRC_GHSL_P2023A_GHS_SMOD
  - ERA5-Land monthly: https://developers.google.com/earth-engine/datasets/catalog/ECMWF_ERA5_LAND_MONTHLY_AGGR
  - ERA5-Land daily: https://developers.google.com/earth-engine/datasets/catalog/ECMWF_ERA5_LAND_DAILY_AGGR
  - ERA5-Land hourly: https://developers.google.com/earth-engine/datasets/catalog/ECMWF_ERA5_LAND_HOURLY
  - NEX-GDDP-CMIP6: https://developers.google.com/earth-engine/datasets/catalog/NASA_GDDP-CMIP6
  - MCD43A3: https://developers.google.com/earth-engine/datasets/catalog/MODIS_061_MCD43A3
  - ASTER GED: https://developers.google.com/earth-engine/datasets/catalog/NASA_ASTER_GED_AG100_003
  - MOD16A2GF: https://developers.google.com/earth-engine/datasets/catalog/MODIS_061_MOD16A2GF
  - SMAP L4: https://developers.google.com/earth-engine/datasets/catalog/NASA_SMAP_SPL4SMGP_008
  - JRC Global Surface Water: https://developers.google.com/earth-engine/datasets/catalog/JRC_GSW1_4_GlobalSurfaceWater
  - VIIRS annual night lights V2.2: https://developers.google.com/earth-engine/datasets/catalog/NOAA_VIIRS_DNB_ANNUAL_V22
  - Malaria Atlas Project LST Day: https://developers.google.com/earth-engine/datasets/catalog/projects_malariaatlasproject_assets_LST_Day_v061_1km_Monthly
- Earth Engine quotas and tiers: https://developers.google.com/earth-engine/guides/usage ; https://developers.google.com/earth-engine/guides/noncommercial_tiers ; https://spatialthoughts.com/2026/02/09/gee-quota-monitoring/
- computePixels limits and throughput: https://developers.google.com/earth-engine/reference/rest/v1/projects.image/computePixels ; https://medium.com/google-earth/pixels-to-the-people-2d3c14a46da6
- Roy et al. 2016 coefficients: https://developers.google.com/earth-engine/tutorials/community/landsat-etm-to-oli-harmonization
- Landsat archive history: Wulder et al. 2016, https://landsat.usgs.gov/documents/1-s2.0-S0034425715302194-main.pdf
- MODIS orbit drift and end of mission: https://modis-land.gsfc.nasa.gov/news.html ; https://nsidc.org/data/user-resources/data-announcements/ongoing-changes-terra-and-aqua-orbits-impacting-modis-snow-and-sea-ice-products ; https://www.earthdata.nasa.gov/data/alerts-outages/terra-modis-acquisition-plan-through-december-2025 ; https://science.nasa.gov/mission/aqua
- gee-community-catalog:
  - GLC_FCS30D: https://gee-community-catalog.org/projects/glc_fcs/ and https://gee-community-catalog.org/tutorials/examples/glc_fcs30d_lulc/
  - Harmonised NTL: https://gee-community-catalog.org/projects/hntl/
  - srunet NPP-VIIRS-like NTL: https://gee-community-catalog.org/projects/srunet_npp_viirs_ntl/
  - NPP-VIIRS-like NTL: https://gee-community-catalog.org/projects/npp_viirs_ntl/
  - Future urban land: https://gee-community-catalog.org/projects/urban_projection/
  - Global urban extents: https://gee-community-catalog.org/projects/gue/
  - Gap-filled daily LST: https://gee-community-catalog.org/projects/daily_lst/
  - GSHTD: https://gee-community-catalog.org/projects/gshtd/
  - GRIP4: https://gee-community-catalog.org/projects/grip/
  - WorldPop Global2: https://gee-community-catalog.org/projects/worldpop/
- NEX-GDDP-CMIP6 on AWS: https://registry.opendata.aws/nex-gddp-cmip6/ (bucket listing checked directly)
- Population projections: WorldPop FuturePop v0.2, https://www.worldpop.org/blog/new-global-1-km-population-projections-released-to-advance-climate-and-health-research-version-0-2/ ; Wang et al. 2022, https://www.nature.com/articles/s41597-022-01675-x ; Chen et al. 2020, https://www.nature.com/articles/s41467-020-14386-x
- Archive queries run for this report: USGS LandsatLook STAC https://landsatlook.usgs.gov/stac-server/search ; NASA CMR https://cmr.earthdata.nasa.gov/search/granules.json