/**
 * Deterministic in-memory synthetic v2 bundle (UI_SPEC §8 `fixtures/synthV2.js`).
 *
 * Purpose: run and test the whole v2 UI before the notebook has written `public/demo`. The
 * fixture produces EXACTLY the SPEC §5 file set (manifest 2.0, LSTB containers, JSON/GeoJSON,
 * PNG rasters) and serves it through a fake `fetch`, so the real loaders, worker ops, adapters
 * and validators run unchanged on it.
 *
 * World (SYNTHETIC — not observations):
 * - Grid: 55 × 67 cells of ~5.4 km on a regular lon/lat lattice over the SPEC_v1 §1.2 NCR outline
 *   (≈ 1,900 ROI cells); districts = nearest of the 25 canonical HQ points (Voronoi, SPEC_v1 §1.1);
 *   Yamuna/Ganga rivers and the Aravalli ridge from the SPEC_v1 polylines.
 * - Land cover: Gaussian urban blobs (Delhi, Gurugram, Noida, …) whose radii grow 1990→2025 and
 *   further per SSP; barren land in the arid south-west, forest on the ridge, water on the rivers,
 *   cropland elsewhere.
 * - LST is an additive model over the 18 SHAP groups (so TreeSHAP additivity holds exactly):
 *   by DAY (mid-morning) bare/dry land is hottest and built-up land is cooler than the semi-arid
 *   fringe (negative surface UHI ≈ −1 to −2 °C); at NIGHT built-up land is warmest (positive UHI
 *   ≈ +2 to +3 °C). Levels: day ~43–45 °C, night ~26–29 °C, with weather noise and a weak trend.
 * - Tiers follow SPEC §1.2: day 1990/1995 observed-sparse, 2005 with SLC-off stripes; night
 *   1990/1995 modelled, 2000 reconstructed, 2005+ observed; 2030–2050 projected (3 SSPs, MC-like
 *   quantile offsets growing with horizon).
 *
 * `createSynthV2()` is pure and deterministic for a given seed; `createFixtureFetch(synth)`
 * returns a fetch implementation serving its files under `/fixture/`.
 *
 * `optionalKeys` (default true) adds the optional v2 keys of the review decisions: zone
 * display_name / label_caveat (D11; night zone 1 carries "Moderate mosaic (no riparian signal)"),
 * decomposition baseline_c and the top-level baseline_level_c (D14), series frame coverage (D16),
 * metrics land_model checks / verdict / hindcast_truth / corr_du (D18) and AOA resid_rho_block20 /
 * proj_resid_q90 (D13). With `optionalKeys: false` the bundle has none of them (older notebook
 * output), so readers are tested both ways. In both variants the weather-normalised baseline
 * L_base differs from the observed NOW mean (WEATHER_ANOMALY), as in a real run.
 */

import { encodeLstb, gzipBytes } from "../lstb.js";
import { encodePngRgb } from "./png.js";

// ---------------------------------------------------------------------------------------
// Constants (SPEC §1, §4.1, §4.4)
// ---------------------------------------------------------------------------------------

export const FRAMES_OBS = Object.freeze([1990, 1995, 2000, 2005, 2010, 2015, 2020, 2025]);
export const FRAMES_PROJ = Object.freeze([2030, 2035, 2040, 2045, 2050]);
export const SCENARIOS = Object.freeze(["ssp126", "ssp245", "ssp585"]);
const WINDOWS = { 1990: [1989, 1992], 1995: [1994, 1996], 2000: [1999, 2001], 2005: [2004, 2006], 2010: [2009, 2011], 2015: [2014, 2016], 2020: [2019, 2021], 2025: [2024, 2026] };
const NOW = 2025;
const REFERENCE_PERIOD = [2000, 2020];

export const BASE_FEATURES = Object.freeze([
  "ndvi", "ndbi", "mndwi", "albedo", "ndvi_spring", "ndvi_drop",
  "frac_built", "frac_forest", "frac_water", "frac_cropland", "frac_barren",
  "built_v", "log_pop", "dist_urban", "dist_builtup", "lm_pd", "lm_ed", "lm_contag",
  "dist_water",
  "elevation", "slope", "aspect_sin", "aspect_cos", "elev_tpi7", "elev_tpi21", "elev_std7",
  "era5_t2m", "era5_vpd", "era5_swvl1", "era5_evap", "era5_ssr", "era5_wind", "era5_precip_jfm",
]);
const FOCAL_BASES = Object.freeze(["ndvi", "ndbi", "albedo", "frac_built", "frac_forest", "frac_water", "frac_barren"]);
export const FOCAL_SPEC = Object.freeze({ bases: FOCAL_BASES, windows: [3, 15] });
export const FEATURES = Object.freeze([...BASE_FEATURES, ...FOCAL_BASES.flatMap((b) => [`${b}_m3`, `${b}_m15`])]);

/** 18 SHAP groups (order binding, SPEC §4.4). */
export const GROUPS = Object.freeze([
  { id: "ndvi", label: "Vegetation (NDVI)", primary: "ndvi", family: "spectral", actionable: true, members: ["ndvi", "ndvi_m3", "ndvi_m15"] },
  { id: "phenology", label: "Spring green-up", primary: "ndvi_drop", family: "spectral", actionable: false, members: ["ndvi_spring", "ndvi_drop"] },
  { id: "ndbi", label: "Built-up index (NDBI)", primary: "ndbi", family: "spectral", actionable: false, members: ["ndbi", "ndbi_m3", "ndbi_m15"] },
  { id: "moisture_index", label: "Surface wetness (MNDWI)", primary: "mndwi", family: "spectral", actionable: false, members: ["mndwi"] },
  { id: "albedo", label: "Albedo", primary: "albedo", family: "spectral", actionable: false, members: ["albedo", "albedo_m3", "albedo_m15"] },
  { id: "built", label: "Built-up fraction", primary: "frac_built", family: "landcover", actionable: true, members: ["frac_built", "frac_built_m3", "frac_built_m15"] },
  { id: "built_volume", label: "Built volume", primary: "built_v", family: "urban", actionable: false, members: ["built_v"] },
  { id: "population", label: "Population density", primary: "log_pop", family: "urban", actionable: false, members: ["log_pop"] },
  { id: "forest", label: "Tree cover", primary: "frac_forest", family: "landcover", actionable: true, members: ["frac_forest", "frac_forest_m3", "frac_forest_m15"] },
  { id: "water", label: "Water", primary: "frac_water", family: "water", actionable: true, members: ["frac_water", "frac_water_m3", "frac_water_m15", "dist_water"] },
  { id: "cropland", label: "Cropland", primary: "frac_cropland", family: "landcover", actionable: true, members: ["frac_cropland"] },
  { id: "barren", label: "Barren land", primary: "frac_barren", family: "landcover", actionable: true, members: ["frac_barren", "frac_barren_m3", "frac_barren_m15"] },
  { id: "urban_proximity", label: "Distance to urban core", primary: "dist_urban", family: "urban", actionable: false, members: ["dist_urban", "dist_builtup"] },
  { id: "landscape", label: "Landscape pattern", primary: "lm_ed", family: "landcover", actionable: true, members: ["lm_pd", "lm_ed", "lm_contag"] },
  { id: "terrain", label: "Terrain", primary: "elevation", family: "terrain", actionable: false, members: ["elevation", "slope", "aspect_sin", "aspect_cos", "elev_tpi7", "elev_tpi21", "elev_std7"] },
  { id: "climate_heat", label: "Air temperature & radiation", primary: "era5_t2m", family: "climate", actionable: false, members: ["era5_t2m", "era5_ssr"] },
  { id: "climate_moisture", label: "Soil & air moisture", primary: "era5_swvl1", family: "climate", actionable: false, members: ["era5_vpd", "era5_swvl1", "era5_evap", "era5_precip_jfm"] },
  { id: "climate_wind", label: "Wind", primary: "era5_wind", family: "climate", actionable: false, members: ["era5_wind"] },
]);

const FEATURE_INFO = {
  ndvi: ["NDVI", "", "index", "spectral"], ndbi: ["NDBI", "", "index", "spectral"], mndwi: ["MNDWI", "", "index", "spectral"],
  albedo: ["Albedo", "", "index", "spectral"], ndvi_spring: ["NDVI (Feb–Mar)", "", "index", "spectral"], ndvi_drop: ["NDVI drop (spring − season)", "", "index", "spectral"],
  frac_built: ["Built-up fraction", "fraction", "percent", "landcover"], frac_forest: ["Tree cover", "fraction", "percent", "landcover"],
  frac_water: ["Water", "fraction", "percent", "landcover"], frac_cropland: ["Cropland", "fraction", "percent", "landcover"],
  frac_barren: ["Barren land", "fraction", "percent", "landcover"], built_v: ["Built volume (log1p m³/m²)", "log1p(m³/m²)", "number", "urban"],
  log_pop: ["Population density (log)", "log1p(persons/km²)", "number", "urban"], dist_urban: ["Distance to urban core", "km", "number", "urban"],
  dist_builtup: ["Distance to built-up", "km", "number", "urban"], lm_pd: ["Patch density", "patches/100 ha", "number", "urban"],
  lm_ed: ["Edge density", "m/ha", "number", "urban"], lm_contag: ["Contagion", "%", "number", "urban"], dist_water: ["Distance to water", "km", "number", "water"],
  elevation: ["Elevation", "m", "number", "terrain"], slope: ["Slope", "°", "number", "terrain"], aspect_sin: ["Aspect (east-west)", "", "index", "terrain"],
  aspect_cos: ["Aspect (north-south)", "", "index", "terrain"], elev_tpi7: ["Topographic position (7 km)", "m", "number", "terrain"],
  elev_tpi21: ["Topographic position (21 km)", "m", "number", "terrain"], elev_std7: ["Relief (7 km std)", "m", "number", "terrain"],
  era5_t2m: ["Air temperature (ERA5-Land)", "°C", "number", "climate"], era5_vpd: ["Vapour-pressure deficit", "kPa", "number", "climate"],
  era5_swvl1: ["Soil moisture (0–7 cm)", "m³/m³", "number", "climate"], era5_evap: ["Evaporation", "mm/day", "number", "climate"],
  era5_ssr: ["Net solar radiation", "MJ/m²/day", "number", "climate"], era5_wind: ["Wind speed", "m/s", "number", "climate"],
  era5_precip_jfm: ["Winter precipitation (Jan–Mar)", "mm", "number", "climate"],
};
const ACTIONABLE = new Set(["frac_built", "frac_forest", "frac_water", "frac_cropland", "frac_barren", "ndvi", "lm_pd", "lm_ed", "lm_contag"]);

const OUTLINE = [
  [76.45, 29.95], [76.85, 29.95], [77.2, 29.75], [77.55, 29.75], [78.1, 29.55], [78.2, 29.2], [78.45, 28.6],
  [78.45, 28.2], [78.0, 28.05], [77.55, 27.95], [77.55, 27.5], [77.85, 27.2], [77.65, 26.75], [77.2, 26.7],
  [76.9, 27.05], [76.25, 27.05], [76.1, 27.4], [76.2, 27.9], [75.95, 28.0], [75.45, 28.4], [75.55, 28.9],
  [75.85, 29.05], [75.95, 29.55], [76.2, 29.6], [76.45, 29.95],
];
const YAMUNA = [[77.19, 29.95], [77.13, 29.55], [77.12, 29.2], [77.22, 28.85], [77.25, 28.62], [77.3, 28.45], [77.45, 28.2], [77.52, 27.9], [77.68, 27.55]];
const GANGA = [[78.03, 29.75], [78.1, 29.3], [78.18, 28.95], [78.32, 28.6], [78.45, 28.3]];
const ARAVALLI = [[77.17, 28.62], [77.1, 28.4], [76.85, 28.15], [76.6, 27.8], [76.4, 27.35]];

export const DISTRICTS = Object.freeze([
  ["Delhi NCT", "Delhi", 77.21, 28.61], ["Gurugram", "Haryana", 77.03, 28.46], ["Faridabad", "Haryana", 77.31, 28.41],
  ["Palwal", "Haryana", 77.33, 28.14], ["Nuh", "Haryana", 77.0, 28.1], ["Rewari", "Haryana", 76.62, 28.19],
  ["Jhajjar", "Haryana", 76.66, 28.61], ["Rohtak", "Haryana", 76.61, 28.9], ["Sonipat", "Haryana", 77.02, 28.99],
  ["Panipat", "Haryana", 76.97, 29.39], ["Karnal", "Haryana", 76.99, 29.69], ["Jind", "Haryana", 76.32, 29.32],
  ["Bhiwani", "Haryana", 76.13, 28.79], ["Charkhi Dadri", "Haryana", 76.27, 28.59], ["Mahendragarh", "Haryana", 76.11, 28.05],
  ["Meerut", "Uttar Pradesh", 77.71, 28.98], ["Ghaziabad", "Uttar Pradesh", 77.44, 28.67], ["Gautam Buddh Nagar", "Uttar Pradesh", 77.49, 28.47],
  ["Bulandshahr", "Uttar Pradesh", 77.85, 28.4], ["Baghpat", "Uttar Pradesh", 77.22, 28.94], ["Hapur", "Uttar Pradesh", 77.78, 28.73],
  ["Shamli", "Uttar Pradesh", 77.31, 29.45], ["Muzaffarnagar", "Uttar Pradesh", 77.7, 29.47], ["Alwar", "Rajasthan", 76.6, 27.55],
  ["Bharatpur", "Rajasthan", 77.49, 27.22],
].map(([name, state, lon, lat], id) => ({ id, name, state, lon, lat })));

/** Urban centres: [lon, lat, weight, radius 1990 km, radius 2025 km]. */
const CITIES = [
  [77.21, 28.63, 1.0, 9, 21], [77.03, 28.46, 0.8, 2.5, 11], [77.39, 28.55, 0.75, 2, 10], [77.44, 28.67, 0.7, 3, 8],
  [77.31, 28.41, 0.65, 3, 7], [77.71, 28.98, 0.55, 3, 6], [76.97, 29.39, 0.45, 2, 4.5], [76.61, 28.9, 0.45, 2, 4.5],
  [77.02, 28.99, 0.4, 1.5, 4], [76.99, 29.69, 0.4, 2, 4], [76.6, 27.55, 0.4, 2, 4], [77.49, 27.22, 0.35, 1.5, 3.2],
  [77.85, 28.4, 0.35, 1.5, 3.2], [76.62, 28.19, 0.35, 1.2, 3.2], [77.78, 28.73, 0.35, 1.2, 2.8], [77.7, 29.47, 0.4, 1.5, 3.5],
];
const SSP_GROWTH = { ssp126: 0.22, ssp245: 0.34, ssp585: 0.5 };
/** Regional tasmax/tasmin warming by 2050 vs 2025 (°C) per scenario (ensemble-median-like). */
const SSP_WARMING_2050 = { day: { ssp126: 0.55, ssp245: 0.95, ssp585: 1.45 }, night: { ssp126: 0.6, ssp245: 1.05, ssp585: 1.6 } };
const SSP_SPREAD = { ssp126: 0.85, ssp245: 1.0, ssp585: 1.3 };
/** NOW-window weather anomaly (°C): the observed 2025 level minus the weather-normalised L_base. */
const WEATHER_ANOMALY = { day: 0.45, night: 0.3 };
/** Night zone 1 has no riparian signature in the fixture (D11 fallback label). */
const NIGHT_ZONE1_DISPLAY = "Moderate mosaic (no riparian signal)";
const NIGHT_ZONE1_CAVEAT = "Named Riparian Buffer by the SPEC zone rule, but no cluster shows a riparian signature (mean water 1.2 %); this is the middle-heat cluster of the three non-core zones.";
const BETA = { day: 0.95, night: 1.1 };

const LEVELS = {
  day: { 1990: 43.05, 1995: 43.3, 2000: 43.55, 2005: 44.15, 2010: 44.3, 2015: 43.85, 2020: 43.25, 2025: 44.55 },
  night: { 1990: 26.35, 1995: 26.6, 2000: 26.95, 2005: 27.35, 2010: 27.75, 2015: 27.95, 2020: 28.05, 2025: 28.55 },
};
const TIERS_DAY = { 1990: "observed-sparse", 1995: "observed-sparse" };
const TIERS_NIGHT = { 1990: "modelled", 1995: "modelled", 2000: "reconstructed" };
const DAY_SENSORS = { 1990: "Landsat 5 TM", 1995: "Landsat 5 TM", 2000: "Landsat 5 TM + 7 ETM+", 2005: "Landsat 5 TM + 7 ETM+ (SLC-off)", 2010: "Landsat 5 TM + 7 ETM+", 2015: "Landsat 7 ETM+ + 8 OLI/TIRS", 2020: "Landsat 7 + 8 C2 ST", 2025: "Landsat 8/9 C2 ST" };
const DAY_OVERPASS = { 1990: "10:11", 1995: "10:14", 2000: "10:22", 2005: "10:25", 2010: "10:24", 2015: "10:33", 2020: "10:38", 2025: "10:40" };
const DAY_SCENES = { 1990: 22, 1995: 26, 2000: 48, 2005: 51, 2010: 55, 2015: 63, 2020: 69, 2025: 74 };
const NIGHT_INFO = {
  1990: ["model hindcast (ERA5-Land level)", "01:30", 0], 1995: ["model hindcast (ERA5-Land level)", "01:30", 0],
  2000: ["MODIS Terra 22:30 (Aqua-calibrated)", "22:30", 23], 2005: ["MODIS Aqua", "01:30", 33], 2010: ["MODIS Aqua", "01:32", 34],
  2015: ["MODIS Aqua", "01:35", 34], 2020: ["MODIS Aqua", "01:38", 33], 2025: ["VIIRS VNP21 (Aqua-calibrated)", "02:06", 61],
};

// ---------------------------------------------------------------------------------------
// Small numerics
// ---------------------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic standard-normal draws (Box–Muller). */
function gaussian(rand) {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const round = (x, dp = 2) => (Number.isFinite(x) ? Number(x.toFixed(dp)) : null);
const KM_PER_DEG_LAT = 111.0;

function pointInPolygon(lon, lat, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance (km) from a point to a polyline (local equirectangular metric). */
function distToPolyline(lon, lat, line) {
  const kx = KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  for (let i = 1; i < line.length; i += 1) {
    const ax = line[i - 1][0] * kx;
    const ay = line[i - 1][1] * KM_PER_DEG_LAT;
    const bx = line[i][0] * kx;
    const by = line[i][1] * KM_PER_DEG_LAT;
    const px = lon * kx;
    const py = lat * KM_PER_DEG_LAT;
    const dx = bx - ax;
    const dy = by - ay;
    const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1), 0, 1);
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return best;
}

function distKm(lon1, lat1, lon2, lat2) {
  const kx = KM_PER_DEG_LAT * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  return Math.hypot((lon1 - lon2) * kx, (lat1 - lat2) * KM_PER_DEG_LAT);
}

function sortedFinite(arr) {
  const out = [];
  for (let i = 0; i < arr.length; i += 1) if (Number.isFinite(arr[i])) out.push(arr[i]);
  return out.sort((a, b) => a - b);
}

function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const meanOf = (arr, mask = null) => {
  let s = 0;
  let c = 0;
  for (let i = 0; i < arr.length; i += 1) {
    if (mask && !mask[i]) continue;
    if (Number.isFinite(arr[i])) (s += arr[i]), (c += 1);
  }
  return c ? s / c : NaN;
};

/** Notebook `quant_params`: (scale, offset) covering min..max of finite values with headroom. */
function quantParams(values) {
  const s = sortedFinite(values);
  if (!s.length) return { scale: 1, offset: 0 };
  const lo = s[0];
  const hi = s[s.length - 1];
  const span = Math.max(hi - lo, 1e-6);
  return { scale: (span * 1.1) / 65000, offset: (lo + hi) / 2 };
}

// ---------------------------------------------------------------------------------------
// World generation
// ---------------------------------------------------------------------------------------

function buildGrid({ width, height }) {
  const west = 75.45;
  const north = 29.95;
  const dLon = (78.45 - west) / width;
  const dLat = (north - 26.7) / height;
  const rows = [];
  const cols = [];
  const lons = [];
  const lats = [];
  const ids = [];
  for (let r = 0; r < height; r += 1) {
    for (let c = 0; c < width; c += 1) {
      const lon = west + (c + 0.5) * dLon;
      const lat = north - (r + 0.5) * dLat;
      if (!pointInPolygon(lon, lat, OUTLINE)) continue;
      rows.push(r);
      cols.push(c);
      lons.push(lon);
      lats.push(lat);
      ids.push(r * width + c);
    }
  }
  const n = ids.length;
  const district = new Int16Array(n);
  for (let i = 0; i < n; i += 1) {
    let best = 0;
    let bestD = Infinity;
    for (const d of DISTRICTS) {
      const dist = distKm(lons[i], lats[i], d.lon, d.lat);
      if (dist < bestD) (bestD = dist), (best = d.id);
    }
    district[i] = best;
  }
  const resM = Math.round(dLat * KM_PER_DEG_LAT * 1000);
  return {
    width,
    height,
    west,
    north,
    dLon,
    dLat,
    resM,
    cellAreaKm2: dLon * KM_PER_DEG_LAT * Math.cos((28.3 * Math.PI) / 180) * dLat * KM_PER_DEG_LAT,
    n,
    cell_id: Int32Array.from(ids),
    row: Int16Array.from(rows),
    col: Int16Array.from(cols),
    lon: Float32Array.from(lons),
    lat: Float32Array.from(lats),
    lon64: Float64Array.from(lons),
    lat64: Float64Array.from(lats),
    kmX: Float64Array.from(lons, (lon) => lon * KM_PER_DEG_LAT * Math.cos((28.3 * Math.PI) / 180)),
    kmY: Float64Array.from(lats, (lat) => lat * KM_PER_DEG_LAT),
    district,
    indexOf: new Map(ids.map((id, i) => [id, i])),
  };
}

/** Smooth deterministic spatial noise in [-1, 1] (sum of random plane waves). */
function makeNoise(rand, waves = 6, scaleKm = 60) {
  const comps = Array.from({ length: waves }, () => ({
    kx: (gaussian(rand) * 2 * Math.PI) / scaleKm,
    ky: (gaussian(rand) * 2 * Math.PI) / scaleKm,
    phase: rand() * 2 * Math.PI,
  }));
  return (lon, lat) => {
    const x = lon * 97.6;
    const y = lat * KM_PER_DEG_LAT;
    let s = 0;
    for (const c of comps) s += Math.sin(c.kx * x + c.ky * y + c.phase);
    return s / Math.sqrt(waves * 0.5) / 2;
  };
}

/** Box mean over a (2h+1)² window of grid cells (NaN-aware, ROI only). */
function boxMean(grid, values, half) {
  const out = new Float32Array(grid.n);
  for (let i = 0; i < grid.n; i += 1) {
    let s = 0;
    let c = 0;
    for (let dr = -half; dr <= half; dr += 1) {
      for (let dc = -half; dc <= half; dc += 1) {
        const j = grid.indexOf.get((grid.row[i] + dr) * grid.width + (grid.col[i] + dc));
        if (j === undefined || grid.col[i] + dc < 0 || grid.col[i] + dc >= grid.width) continue;
        const v = values[j];
        if (Number.isFinite(v)) (s += v), (c += 1);
      }
    }
    out[i] = c ? s / c : NaN;
  }
  return out;
}

function boxStd(grid, values, half) {
  const m = boxMean(grid, values, half);
  const sq = boxMean(grid, values.map((v) => v * v), half);
  return m.map((mu, i) => Math.sqrt(Math.max(0, sq[i] - mu * mu)));
}

/**
 * Distance (km) from each cell to the nearest cell where `target[i]` is true (ROI only); brute
 * force over precomputed local-metric km coordinates (n ≈ 2k cells, so O(n·k) is milliseconds).
 */
function distanceTo(grid, target) {
  const px = [];
  const py = [];
  for (let i = 0; i < grid.n; i += 1) if (target[i]) (px.push(grid.kmX[i]), py.push(grid.kmY[i]));
  const out = new Float32Array(grid.n);
  for (let i = 0; i < grid.n; i += 1) {
    if (target[i]) continue;
    let best = Infinity;
    const x = grid.kmX[i];
    const y = grid.kmY[i];
    for (let j = 0; j < px.length; j += 1) {
      const d = (px[j] - x) ** 2 + (py[j] - y) ** 2;
      if (d < best) best = d;
    }
    out[i] = Number.isFinite(best) ? Math.sqrt(best) : 200;
  }
  return out;
}

function staticFields(grid, rand) {
  const n = grid.n;
  const noiseElev = makeNoise(rand, 7, 80);
  const noiseLocal = makeNoise(rand, 9, 25);
  const elevation = new Float32Array(n);
  const water = new Float32Array(n);
  const waterOcc = new Float32Array(n);
  const ridge = new Float32Array(n);
  const arid = new Float32Array(n);
  const aspectSin = new Float32Array(n);
  const aspectCos = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const lon = grid.lon[i];
    const lat = grid.lat[i];
    const dRidge = distToPolyline(lon, lat, ARAVALLI);
    const dYam = distToPolyline(lon, lat, YAMUNA);
    const dGan = distToPolyline(lon, lat, GANGA);
    ridge[i] = Math.exp(-((dRidge / 9) ** 2));
    arid[i] = 1 / (1 + Math.exp(-((76.95 - lon) * 2.2 + (28.25 - lat) * 1.6)));
    elevation[i] = 205 + 18 * (29.9 - lat) * 0.6 + 230 * ridge[i] * (0.7 + 0.3 * noiseLocal(lon, lat)) + 25 * noiseElev(lon, lat) - 12 * Math.exp(-((Math.min(dYam, dGan) / 6) ** 2));
    water[i] = clamp(0.5 * Math.exp(-((dYam / 2.6) ** 2)) + 0.42 * Math.exp(-((dGan / 3.0) ** 2)) + 0.02 + 0.015 * noiseLocal(lon, lat), 0, 0.85);
    waterOcc[i] = clamp(water[i] * 1.15 + 0.03 * noiseLocal(lat, lon), 0, 1);
    const a = Math.atan2(noiseElev(lon + 0.05, lat) - noiseElev(lon - 0.05, lat), noiseElev(lon, lat + 0.05) - noiseElev(lon, lat - 0.05));
    aspectSin[i] = Math.sin(a);
    aspectCos[i] = Math.cos(a);
  }
  const slope = elevation.map((_, i) => clamp(0.4 + 6.5 * ridge[i] + 0.6 * Math.abs(noiseLocal(grid.lon[i] * 1.7, grid.lat[i] * 1.3)), 0.1, 14));
  const box3 = boxMean(grid, elevation, 1);
  const box10 = boxMean(grid, elevation, 3);
  return {
    elevation,
    slope,
    aspect_sin: aspectSin,
    aspect_cos: aspectCos,
    elev_tpi7: elevation.map((v, i) => v - box3[i]),
    elev_tpi21: elevation.map((v, i) => v - box10[i]),
    elev_std7: boxStd(grid, elevation, 1),
    water,
    waterOcc,
    ridge,
    arid,
  };
}

function cityRadius(c, year, ssp) {
  const [, , , r0, r1] = c;
  if (year <= NOW) return r0 + (r1 - r0) * ((year - 1990) / (NOW - 1990)) ** 1.2;
  return r1 * (1 + SSP_GROWTH[ssp] * ((year - NOW) / 25));
}

function builtField(grid, year, ssp, villageNoise) {
  const out = new Float32Array(grid.n);
  for (let i = 0; i < grid.n; i += 1) {
    let s = 0;
    for (const c of CITIES) {
      const d = distKm(grid.lon[i], grid.lat[i], c[0], c[1]);
      const r = cityRadius(c, year, ssp);
      s += c[2] * Math.exp(-((d / r) ** 2));
    }
    const villages = 0.03 + 0.02 * villageNoise[i] + 0.0006 * (Math.min(year, 2050) - 1990);
    out[i] = clamp(1.05 * s + villages, 0, 0.93);
  }
  return out;
}

/** One frame's 33 base features (and the land-cover fractions) for a year (and SSP if projected). */
function featuresFor(grid, stat, year, ssp, ctx) {
  const n = grid.n;
  const { villageNoise, weather } = ctx;
  const built = builtField(grid, year, ssp, villageNoise);
  const w = weather(year);
  const f = Object.fromEntries(BASE_FEATURES.map((name) => [name, new Float32Array(n)]));
  const irrigation = 0.85 + 0.15 * clamp((year - 1990) / 35, 0, 1);
  for (let i = 0; i < n; i += 1) {
    const b = built[i];
    const wat = stat.water[i] * (1 - 0.4 * b);
    const forest = clamp((0.28 * stat.ridge[i] + 0.03 + 0.015 * villageNoise[(i * 7) % n]) * (1 - b) * (1 - 0.15 * (year - 1990) / 60), 0, 0.6);
    const barren = clamp((0.05 + 0.42 * stat.arid[i] + 0.12 * stat.ridge[i]) * (1 - b) * (1 - wat), 0, 0.8);
    const other = 0.05 * (1 - b);
    let crop = 1 - b - wat - forest - barren - other;
    if (crop < 0) crop = 0;
    const total = b + wat + forest + barren + crop + other;
    const fb = b / total;
    const fw = wat / total;
    const ff = forest / total;
    const fr = barren / total;
    const fc = crop / total;
    const ndvi = clamp(0.16 + 0.24 * fc * irrigation + 0.42 * ff - 0.07 * fb - 0.06 * fr + 0.05 * fw + 0.012 * w.ndvi * villageNoise[i], 0.03, 0.75);
    const ndviSpring = clamp(ndvi + 0.2 * fc * irrigation + 0.02 * ff, 0.03, 0.85);
    const ndbi = clamp(-0.12 + 0.3 * fb + 0.24 * fr - 0.28 * ndvi - 0.2 * fw, -0.6, 0.5);
    const mndwi = clamp(-0.38 + 1.05 * fw - 0.18 * ndvi + 0.05 * fc, -0.8, 0.7);
    const albedo = clamp(0.155 + 0.085 * fr + 0.015 * fb - 0.05 * ndvi - 0.06 * fw, 0.06, 0.32);
    const entropy = -[fb, fw, ff, fr, fc].reduce((s, p) => s + (p > 1e-6 ? p * Math.log(p) : 0), 0) / Math.log(5);
    const lon = grid.lon[i];
    const lat = grid.lat[i];
    f.ndvi[i] = ndvi;
    f.ndbi[i] = ndbi;
    f.mndwi[i] = mndwi;
    f.albedo[i] = albedo;
    f.ndvi_spring[i] = ndviSpring;
    f.ndvi_drop[i] = ndviSpring - ndvi;
    f.frac_built[i] = fb;
    f.frac_forest[i] = ff;
    f.frac_water[i] = fw;
    f.frac_cropland[i] = fc;
    f.frac_barren[i] = fr;
    f.built_v[i] = Math.log1p(fb * (3.5 + 11 * fb));
    f.log_pop[i] = Math.log1p((260 + 21000 * fb ** 1.25) * (1 + 0.018 * (Math.min(year, 2050) - 1990)));
    f.lm_pd[i] = 1.5 + 7.5 * entropy;
    f.lm_ed[i] = 18 + 62 * entropy;
    f.lm_contag[i] = 82 - 44 * entropy;
    for (const k of ["elevation", "slope", "aspect_sin", "aspect_cos", "elev_tpi7", "elev_tpi21", "elev_std7"]) f[k][i] = stat[k][i];
    f.era5_t2m[i] = 33.6 + 0.85 * (28.4 - lat) + 0.25 * (lon - 77) + w.t2m - 0.004 * (stat.elevation[i] - 230);
    f.era5_vpd[i] = 3.1 + 0.45 * stat.arid[i] + 0.12 * w.t2m;
    f.era5_swvl1[i] = clamp(0.19 - 0.06 * stat.arid[i] + 0.04 * fc * irrigation + 0.01 * w.moist, 0.05, 0.4);
    f.era5_evap[i] = 1.1 + 1.6 * fc * irrigation + 0.8 * fw - 0.6 * fr;
    f.era5_ssr[i] = 23.6 + 0.4 * (28.4 - lat) + 0.2 * w.t2m;
    f.era5_wind[i] = 2.7 + 0.35 * (lat - 28.3) + 0.2 * stat.ridge[i];
    f.era5_precip_jfm[i] = 42 + 14 * (lat - 28) + 6 * w.moist;
  }
  const urbanCore = boxMean(grid, f.frac_built, 3).map((v) => v >= 0.5);
  f.dist_urban.set(distanceTo(grid, urbanCore));
  f.dist_builtup.set(distanceTo(grid, f.frac_built.map((v) => v >= 0.3)));
  f.dist_water.set(distanceTo(grid, f.frac_water.map((v, i) => v >= 0.3 || stat.waterOcc[i] >= 0.5)));
  return f;
}

/** Additive group contributions (°C, before centring) for a mode. */
function groupContributions(f, i, mode) {
  const t2m = f.era5_t2m[i] - 33.6;
  const moist = f.era5_swvl1[i] - 0.18;
  if (mode === "day") {
    return {
      ndvi: -5.0 * f.ndvi[i],
      phenology: -1.1 * f.ndvi_drop[i],
      ndbi: 1.4 * f.ndbi[i],
      moisture_index: -1.6 * f.mndwi[i],
      albedo: 1.5 * f.albedo[i],
      built: -1.1 * f.frac_built[i],
      built_volume: -0.15 * f.built_v[i],
      population: 0.04 * f.log_pop[i],
      forest: -3.2 * f.frac_forest[i],
      water: -9.0 * f.frac_water[i] + 0.01 * Math.min(f.dist_water[i], 30),
      cropland: 0.9 * f.frac_cropland[i],
      barren: 3.2 * f.frac_barren[i],
      urban_proximity: 0.02 * Math.min(f.dist_urban[i], 40),
      landscape: -0.008 * f.lm_ed[i],
      terrain: -0.0045 * f.elevation[i] + 0.03 * f.slope[i],
      climate_heat: 0.9 * t2m,
      climate_moisture: -7.5 * moist + 0.25 * (f.era5_vpd[i] - 3.1),
      climate_wind: -0.22 * (f.era5_wind[i] - 2.7),
    };
  }
  return {
    ndvi: -1.1 * f.ndvi[i],
    phenology: -0.25 * f.ndvi_drop[i],
    ndbi: 0.6 * f.ndbi[i],
    moisture_index: 0.45 * f.mndwi[i],
    albedo: -1.2 * f.albedo[i],
    built: 2.3 * f.frac_built[i],
    built_volume: 0.3 * f.built_v[i],
    population: 0.07 * f.log_pop[i],
    forest: 0.35 * f.frac_forest[i],
    water: 2.1 * f.frac_water[i],
    cropland: -0.45 * f.frac_cropland[i],
    barren: -1.6 * f.frac_barren[i],
    urban_proximity: -0.03 * Math.min(f.dist_urban[i], 40),
    landscape: 0.005 * f.lm_ed[i],
    terrain: -0.0032 * f.elevation[i],
    climate_heat: 0.6 * t2m,
    climate_moisture: 4.2 * moist,
    climate_wind: -0.3 * (f.era5_wind[i] - 2.7),
  };
}

/** SHAP matrix (centred contributions), prediction anomaly. */
function explain(grid, f, mode, centres = null) {
  const n = grid.n;
  const shap = Object.fromEntries(GROUPS.map((g) => [g.id, new Float32Array(n)]));
  for (let i = 0; i < n; i += 1) {
    const c = groupContributions(f, i, mode);
    for (const g of GROUPS) shap[g.id][i] = c[g.id];
  }
  const means = centres ?? Object.fromEntries(GROUPS.map((g) => [g.id, meanOf(shap[g.id])]));
  for (const g of GROUPS) for (let i = 0; i < n; i += 1) shap[g.id][i] -= means[g.id];
  const anom = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    let s = 0;
    for (const g of GROUPS) s += shap[g.id][i];
    anom[i] = s;
  }
  return { shap, anom, centres: means };
}

function tierCode(tier) {
  if (tier === "observed") return 0;
  if (tier === "observed-sparse" || tier === "reconstructed") return 1;
  if (tier === "modelled") return 2;
  return 0;
}

// ---------------------------------------------------------------------------------------
// Bundle assembly
// ---------------------------------------------------------------------------------------

function frameStats(values, { mask = null, built, water, threshold, cellAreaKm2, tier }) {
  let s = 0;
  let c = 0;
  let hot = 0;
  let us = 0;
  let un = 0;
  let rs = 0;
  let rn = 0;
  const vals = [];
  for (let i = 0; i < values.length; i += 1) {
    if (mask && !mask[i]) continue;
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    s += v;
    c += 1;
    vals.push(v);
    if (v >= threshold) hot += 1;
    if (built) {
      if (built[i] >= 0.5) (us += v), (un += 1);
      else if (built[i] <= 0.05 && water[i] < 0.2) (rs += v), (rn += 1);
    }
  }
  vals.sort((a, b) => a - b);
  return {
    mean: round(c ? s / c : NaN),
    p90: round(quantile(vals, 0.9)),
    hot_core_km2: round(hot * cellAreaKm2, 1),
    uhi: built && un >= 3 && rn >= 3 ? round(us / un - rs / rn) : null,
    n_cells: c,
    tier,
  };
}

function theilSen(xs, ys) {
  const slopes = [];
  for (let i = 0; i < xs.length; i += 1) for (let j = i + 1; j < xs.length; j += 1) slopes.push((ys[j] - ys[i]) / (xs[j] - xs[i]));
  slopes.sort((a, b) => a - b);
  return quantile(slopes, 0.5);
}

function olsSe(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) (sxx += (xs[i] - mx) ** 2), (sxy += (xs[i] - mx) * (ys[i] - my));
  const b = sxy / sxx;
  let sse = 0;
  for (let i = 0; i < n; i += 1) sse += (ys[i] - (my + b * (xs[i] - mx))) ** 2;
  return Math.sqrt(sse / Math.max(1, n - 2) / sxx);
}

function trendOf(years, means) {
  const xs = [];
  const ys = [];
  years.forEach((y, k) => {
    if (Number.isFinite(means[k])) (xs.push(y), ys.push(means[k]));
  });
  if (xs.length < 3) return null;
  const slope = theilSen(xs, ys) * 10;
  const se = olsSe(xs, ys) * 10;
  return { slope_per_decade: round(slope, 3), ci: [round(slope - 1.96 * se - 0.05, 3), round(slope + 1.96 * se + 0.05, 3)], period: [xs[0], xs[xs.length - 1]], method: "Theil-Sen + MC (fixture)" };
}

/**
 * Build the synthetic v2 bundle.
 * @param {{seed?: number, width?: number, height?: number}} [options]
 * @returns {{manifest: object, files: Map<string, () => (Uint8Array|object)>, truth: object,
 *            world: object, fileNames: string[]}}
 */
export function createSynthV2({ seed = 20250, width = 55, height = 67, optionalKeys = true } = {}) {
  const rand = mulberry32(seed);
  const grid = buildGrid({ width, height });
  const n = grid.n;
  const stat = staticFields(grid, rand);
  const villageNoiseFn = makeNoise(rand, 11, 18);
  const villageNoise = Float32Array.from({ length: n }, (_, i) => villageNoiseFn(grid.lon[i], grid.lat[i]));
  const weatherDraws = new Map();
  const weather = (year) => {
    if (!weatherDraws.has(year)) {
      if (year > NOW) {
        // Climate change enters projections only through the CMIP6 delta, never through weather
        // noise. (The pipeline uses the 2015/2020/2025 ERA5 mean with a weather-normalised
        // baseline, SPEC §4.9–4.10; the fixture keeps the NOW weather so that its "land" term is
        // purely land-use change.)
        weatherDraws.set(year, weather(NOW));
      } else {
        const r = mulberry32(seed + year * 7919);
        weatherDraws.set(year, { t2m: 0.35 * gaussian(r), moist: gaussian(r), ndvi: gaussian(r) });
      }
    }
    return weatherDraws.get(year);
  };
  const ctx = { villageNoise, weather };
  const residNoise = makeNoise(rand, 12, 22);

  // ---- observed frames -----------------------------------------------------------------
  const obs = { day: {}, night: {} };
  const featuresByYear = {};
  const centres = {};
  for (const year of FRAMES_OBS) {
    const f = featuresFor(grid, stat, year, null, ctx);
    featuresByYear[year] = f;
    for (const mode of ["day", "night"]) {
      const { shap, anom, centres: c } = explain(grid, f, mode);
      if (year === NOW) centres[mode] = c;
      const level = LEVELS[mode][year];
      const tier = mode === "day" ? TIERS_DAY[year] ?? "observed" : TIERS_NIGHT[year] ?? "observed";
      const baseShap = mode === "day" ? 0.012 : -0.008;
      const r = mulberry32(seed + year * 31 + (mode === "day" ? 1 : 2));
      const pred = new Float32Array(n);
      const obsVals = new Float32Array(n);
      const oof = new Float32Array(n);
      for (let i = 0; i < n; i += 1) {
        pred[i] = level + baseShap + anom[i];
        const noise = 0.55 * residNoise(grid.lon[i] + year * 0.01, grid.lat[i]) + 0.35 * gaussian(r);
        obsVals[i] = pred[i] + noise;
        oof[i] = pred[i] + 0.3 * noise + 0.3 * gaussian(r);
      }
      // Coverage gaps (frame-specific): 1990 cloud patch, 2005 SLC-off stripes (day only).
      if (mode === "day") {
        for (let i = 0; i < n; i += 1) {
          const gap1990 = year === 1990 && grid.lon[i] > 77.9 && grid.lat[i] > 28.9;
          const slcOff = year === 2005 && (grid.col[i] + 2 * grid.row[i]) % 11 === 0;
          const sparse1995 = year === 1995 && grid.lon[i] < 75.8;
          if (gap1990 || slcOff || sparse1995) (obsVals[i] = NaN), (oof[i] = NaN);
        }
      }
      const modelled = tier === "modelled";
      if (modelled) for (let i = 0; i < n; i += 1) (obsVals[i] = NaN), (oof[i] = NaN);
      const field = modelled ? Float32Array.from(pred) : obsVals;
      const unc = modelled ? 1.05 : tier === "reconstructed" ? 0.5 : 0;
      obs[mode][year] = { level, tier, baseValueC: level + baseShap, shap, pred, obs: obsVals, oof, field, unc };
    }
  }

  // ---- projections ----------------------------------------------------------------------
  const proj = { day: {}, night: {} };
  const projFeatures = {};
  for (const ssp of SCENARIOS) {
    projFeatures[ssp] = {};
    for (const year of FRAMES_PROJ) projFeatures[ssp][year] = featuresFor(grid, stat, year, ssp, ctx);
  }
  for (const mode of ["day", "night"]) {
    const base2025 = obs[mode][NOW].pred;
    const anom2025 = explain(grid, featuresByYear[NOW], mode, centres[mode]).anom;
    const meanAnom2025 = meanOf(anom2025);
    const lBase = meanOf(base2025);
    for (const ssp of SCENARIOS) {
      proj[mode][ssp] = {};
      for (const year of FRAMES_PROJ) {
        const k = (year - NOW) / 25;
        const dT = SSP_WARMING_2050[mode][ssp] * k;
        const fy = projFeatures[ssp][year];
        const { anom: anomY, shap: shapY } = explain(grid, fy, mode, centres[mode]);
        const p50 = new Float32Array(n);
        const sigma = new Float32Array(n);
        const flags = new Uint8Array(n);
        for (let i = 0; i < n; i += 1) {
          const pattern = 1 + 0.06 * (grid.lat[i] - 28.3) + 0.04 * (stat.arid[i] - 0.5);
          const land = anomY[i] - anom2025[i];
          p50[i] = base2025[i] + BETA[mode] * dT * pattern + land;
          const outside = fy.frac_built[i] > 0.88 || fy.frac_built[i] - featuresByYear[NOW].frac_built[i] > 0.3;
          sigma[i] = (0.28 + 0.13 * ((year - NOW) / 5) * SSP_SPREAD[ssp]) * (outside ? 1.35 : 1);
          const half = 1.645 * sigma[i] * 1.05;
          const vsup = half < 0.5 ? 0 : half < 1 ? 1 : half < 2 ? 2 : 3;
          flags[i] = (outside ? 1 : 0) | (vsup << 1);
        }
        proj[mode][ssp][year] = { p50, sigma, flags, dT, landMean: meanOf(anomY) - meanAnom2025, lBase, shap: shapY, features: fy };
      }
    }
  }

  // ---- zones (nearest-centroid-like rule on SHAP) ----------------------------------------
  const zoneIds = (shap, f) => {
    const total = new Float32Array(n);
    for (let i = 0; i < n; i += 1) for (const g of GROUPS) total[i] += shap[g.id][i];
    const sorted = sortedFinite(total);
    const hi = quantile(sorted, 0.75);
    const lo = quantile(sorted, 0.35);
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i += 1) out[i] = total[i] >= hi ? 3 : f.frac_water[i] >= 0.12 ? 1 : total[i] <= lo ? 0 : 2;
    return out;
  };
  const zones = { day: { obs: {}, proj: {} }, night: { obs: {}, proj: {} } };
  for (const mode of ["day", "night"]) {
    for (const year of FRAMES_OBS) zones[mode].obs[year] = zoneIds(obs[mode][year].shap, featuresByYear[year]);
    for (const ssp of SCENARIOS) {
      zones[mode].proj[ssp] = {};
      for (const year of FRAMES_PROJ) zones[mode].proj[ssp][year] = zoneIds(proj[mode][ssp][year].shap, proj[mode][ssp][year].features);
    }
  }

  // ---- domains (SPEC §5.3: p0.5–p99.5 over observed + projected p50, outward to 1 °C) ----
  const domains = {};
  for (const mode of ["day", "night"]) {
    const all = [];
    const anomAbs = [];
    const suhiAbs = [];
    for (const year of FRAMES_OBS) {
      const v = obs[mode][year].field;
      const m = meanOf(v);
      const f = featuresByYear[year];
      const rural = meanOf(v, f.frac_built.map((b, i) => b <= 0.05 && f.frac_water[i] < 0.2));
      for (let i = 0; i < n; i += 1) if (Number.isFinite(v[i])) (all.push(v[i]), anomAbs.push(Math.abs(v[i] - m)), suhiAbs.push(Math.abs(v[i] - rural)));
    }
    for (const ssp of SCENARIOS) for (const year of FRAMES_PROJ) all.push(...proj[mode][ssp][year].p50);
    const s = all.sort((a, b) => a - b);
    const sym = (arr) => {
      const a = Math.ceil(quantile(arr.sort((x, y) => x - y), 0.995) * 2) / 2;
      return [-a, a];
    };
    domains[mode] = { abs: [Math.floor(quantile(s, 0.005)), Math.ceil(quantile(s, 0.995))], anom: sym(anomAbs), suhi: sym(suhiAbs) };
  }
  {
    const dtr = [];
    for (const year of FRAMES_OBS) {
      const a = obs.day[year].field;
      const b = obs.night[year].field;
      for (let i = 0; i < n; i += 1) if (Number.isFinite(a[i]) && Number.isFinite(b[i])) dtr.push(a[i] - b[i]);
    }
    dtr.sort((x, y) => x - y);
    domains.dtr = { abs: [Math.floor(quantile(dtr, 0.005)), Math.ceil(quantile(dtr, 0.995))] };
    let maxSpread = 0;
    for (const mode of ["day", "night"]) for (const ssp of SCENARIOS) for (const year of FRAMES_PROJ) for (const s of proj[mode][ssp][year].sigma) maxSpread = Math.max(maxSpread, 1.645 * s * 2.05);
    domains.spread = [0, Math.ceil(maxSpread)];
  }

  // ---- quantised cube helpers --------------------------------------------------------------
  const offsetRaw = (sigma, z) => Math.min(255, Math.max(0, Math.round((z * sigma) / 0.05)));

  const files = new Map();
  const fileNames = [];
  const put = (name, factory) => {
    files.set(name, factory);
    fileNames.push(name);
  };

  put("cells.lstb.gz", () =>
    encodeLstb({
      kind: "cells",
      n,
      meta: { grid: { width, height } },
      columns: [
        { name: "cell_id", dtype: "int32", raw: grid.cell_id },
        { name: "row", dtype: "int16", raw: grid.row },
        { name: "col", dtype: "int16", raw: grid.col },
        { name: "lon", dtype: "float32", raw: grid.lon },
        { name: "lat", dtype: "float32", raw: grid.lat },
        { name: "district", dtype: "int16", raw: grid.district },
      ],
    }),
  );

  for (const mode of ["day", "night"]) {
    put(`cube_obs_${mode}.lstb.gz`, () => {
      const F = FRAMES_OBS.length;
      const lst = new Float32Array(F * n);
      const aoa = new Uint8Array(F * n);
      const lo = new Uint8Array(F * n);
      const hi = new Uint8Array(F * n);
      FRAMES_OBS.forEach((year, f) => {
        const o = obs[mode][year];
        lst.set(o.field, f * n);
        if (o.unc > 0) {
          for (let i = 0; i < n; i += 1) {
            const out = featuresByYear[year].frac_built[i] > 0.85 && o.tier === "modelled";
            aoa[f * n + i] = out ? 1 : 0;
            lo[f * n + i] = offsetRaw(o.unc * (out ? 1.4 : 1), 1.0);
            hi[f * n + i] = offsetRaw(o.unc * (out ? 1.4 : 1), 1.1);
          }
        }
      });
      return encodeLstb({
        kind: "cube",
        n,
        meta: { mode, frames: FRAMES_OBS.slice(), tiers: FRAMES_OBS.map((y) => obs[mode][y].tier), levels: FRAMES_OBS.map((y) => obs[mode][y].level) },
        columns: [
          { name: "lst", dtype: "int16", shape: [F, n], scale: 0.01, offset: 0, nodata: -32768, values: lst },
          { name: "aoa_out", dtype: "uint8", shape: [F, n], raw: aoa },
          { name: "p05_off", dtype: "uint8", shape: [F, n], scale: 0.05, raw: lo },
          { name: "p95_off", dtype: "uint8", shape: [F, n], scale: 0.05, raw: hi },
        ],
      });
    });
    for (const ssp of SCENARIOS) {
      put(`cube_${ssp}_${mode}.lstb.gz`, () => {
        const F = FRAMES_PROJ.length;
        const p50 = new Float32Array(F * n);
        const cols = { p05_off: new Uint8Array(F * n), p25_off: new Uint8Array(F * n), p75_off: new Uint8Array(F * n), p95_off: new Uint8Array(F * n) };
        const flags = new Uint8Array(F * n);
        FRAMES_PROJ.forEach((year, f) => {
          const p = proj[mode][ssp][year];
          p50.set(p.p50, f * n);
          flags.set(p.flags, f * n);
          for (let i = 0; i < n; i += 1) {
            cols.p05_off[f * n + i] = offsetRaw(p.sigma[i], 1.645);
            cols.p25_off[f * n + i] = offsetRaw(p.sigma[i], 0.674);
            cols.p75_off[f * n + i] = offsetRaw(p.sigma[i], 0.674 * 1.05);
            cols.p95_off[f * n + i] = offsetRaw(p.sigma[i], 1.645 * 1.05);
          }
        });
        return encodeLstb({
          kind: "cube",
          n,
          meta: { mode, scenario: ssp, frames: FRAMES_PROJ.slice(), tiers: FRAMES_PROJ.map(() => "projected"), method: ssp === "ssp126" ? "pattern-scaled" : "cmip6-delta-mc" },
          columns: [
            { name: "p50", dtype: "int16", shape: [F, n], scale: 0.01, offset: 0, nodata: -32768, values: p50 },
            ...Object.entries(cols).map(([name, raw]) => ({ name, dtype: "uint8", shape: [F, n], scale: 0.05, raw })),
            { name: "flags", dtype: "uint8", shape: [F, n], raw: flags },
          ],
        });
      });
    }
    put(`cube_zones_${mode}.lstb.gz`, () => {
      const columns = [];
      const obsRaw = new Uint8Array(FRAMES_OBS.length * n);
      FRAMES_OBS.forEach((y, f) => obsRaw.set(zones[mode].obs[y], f * n));
      columns.push({ name: "obs", dtype: "uint8", shape: [FRAMES_OBS.length, n], raw: obsRaw });
      for (const ssp of SCENARIOS) {
        const raw = new Uint8Array(FRAMES_PROJ.length * n);
        FRAMES_PROJ.forEach((y, f) => raw.set(zones[mode].proj[ssp][y], f * n));
        columns.push({ name: ssp, dtype: "uint8", shape: [FRAMES_PROJ.length, n], raw });
      }
      return encodeLstb({ kind: "zones", n, meta: { mode, frames: { obs: FRAMES_OBS.slice(), ...Object.fromEntries(SCENARIOS.map((s) => [s, FRAMES_PROJ.slice()])) } }, columns });
    });
  }

  for (const year of FRAMES_OBS) {
    put(`xai_${year}_features.lstb.gz`, () =>
      encodeLstb({
        kind: "features",
        n,
        meta: { year },
        columns: BASE_FEATURES.map((name) => ({ name, dtype: "int16", ...quantParams(featuresByYear[year][name]), nodata: -32768, values: featuresByYear[year][name] })),
      }),
    );
    for (const mode of ["day", "night"]) {
      put(`xai_${year}_${mode}.lstb.gz`, () => {
        const o = obs[mode][year];
        const resid = o.obs.map((v, i) => v - o.oof[i]);
        return encodeLstb({
          kind: "xai",
          n,
          meta: { year, mode, tier: o.tier, base_value_c: round(o.baseValueC, 4), level: o.level, groups: GROUPS.map((g) => g.id) },
          columns: [
            ...GROUPS.map((g) => ({ name: g.id, dtype: "int16", scale: 0.001, offset: 0, nodata: -32768, values: o.shap[g.id] })),
            { name: "pred", dtype: "int16", scale: 0.01, offset: 0, nodata: -32768, values: o.pred },
            { name: "oof", dtype: "int16", scale: 0.01, offset: 0, nodata: -32768, values: o.oof },
            { name: "obs", dtype: "int16", scale: 0.01, offset: 0, nodata: -32768, values: o.obs },
            { name: "resid", dtype: "int16", scale: 0.01, offset: 0, nodata: -32768, values: resid },
          ],
        });
      });
    }
  }

  // ---- rasters (EPSG:4326, 3 px per cell; 500 m-style preview at half size) -----------------
  const rasterW = width * 3;
  const rasterH = height * 3;
  const bounds = [grid.west, 26.7, grid.west + width * grid.dLon, grid.north];
  const rasterFrames = {};
  const rasterBytes = (mode, year, scaleDown) => {
    const w = Math.floor(rasterW / scaleDown);
    const h = Math.floor(rasterH / scaleDown);
    const [lo, hi] = domains[mode].abs;
    const o = obs[mode][year];
    const texture = makeNoise(mulberry32(seed + year), 5, 6);
    const rgb = new Uint8Array(w * h * 3);
    const code = mode === "night" && o.tier === "observed" ? 3 : tierCode(o.tier);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const lon = bounds[0] + ((x + 0.5) / w) * (bounds[2] - bounds[0]);
        const lat = bounds[3] - ((y + 0.5) / h) * (bounds[3] - bounds[1]);
        const c = Math.floor((lon - grid.west) / grid.dLon);
        const r = Math.floor((grid.north - lat) / grid.dLat);
        const i = grid.indexOf.get(r * width + c);
        const v = i === undefined ? NaN : o.field[i] + 0.6 * texture(lon, lat);
        const j = (y * w + x) * 3;
        if (!Number.isFinite(v)) continue;
        rgb[j] = clamp(1 + Math.round(((v - lo) / (hi - lo)) * 254), 1, 255);
        rgb[j + 1] = (code << 1) | (o.tier === "modelled" && featuresByYear[year].frac_built[i] > 0.85 ? 1 : 0);
      }
    }
    return encodePngRgb(w, h, rgb);
  };
  for (const mode of ["day", "night"]) {
    for (const year of FRAMES_OBS) {
      const key = `${mode}_${year}`;
      rasterFrames[key] = {
        file: `raster/${key}.png`,
        preview: `raster/${key}_500m.png`,
        lo: domains[mode].abs[0],
        hi: domains[mode].abs[1],
        tier: obs[mode][year].tier,
        downscaled: mode === "night",
      };
      put(`raster/${key}.png`, () => rasterBytes(mode, year, 1));
      put(`raster/${key}_500m.png`, () => rasterBytes(mode, year, 2));
    }
  }
  put("raster_index.json", () => ({
    crs: "EPSG:4326",
    bounds,
    width: rasterW,
    height: rasterH,
    preview: { width: Math.floor(rasterW / 2), height: Math.floor(rasterH / 2) },
    domains: { day: domains.day.abs, night: domains.night.abs },
    frames: rasterFrames,
  }));

  // ---- timeline series ------------------------------------------------------------------
  const zonesMetaFor = (mode) =>
    [
      { id: 0, name: "Ecological Cool Base", color: "#34d399" },
      { id: 1, name: "Riparian Buffer", color: "#22d3ee" },
      { id: 2, name: "Transition", color: "#a78bfa" },
      { id: 3, name: "Heat Extreme Core", color: "#fb7185" },
    ].map((z) => {
      if (!optionalKeys) return { ...z, mode };
      const fallback = mode === "night" && z.id === 1;
      return { ...z, display_name: fallback ? NIGHT_ZONE1_DISPLAY : z.name, label_caveat: fallback ? NIGHT_ZONE1_CAVEAT : null, mode };
    });
  const scopes = [
    { id: "ncr", label: "Delhi NCR", kind: "ncr" },
    ...DISTRICTS.map((d) => ({ id: `d:${d.id}`, label: d.name, kind: "district", state: d.state })),
    ...["day", "night"].flatMap((mode) => zonesMetaFor(mode).map((z) => ({ id: `z:${mode}:${z.id}`, label: z.display_name ?? z.name, kind: "zone", mode }))),
  ];
  const baselineLevel = {};
  const hotThreshold = {};
  for (const mode of ["day", "night"]) {
    const ref = [];
    for (const y of FRAMES_OBS) if (y >= REFERENCE_PERIOD[0] && y <= REFERENCE_PERIOD[1]) for (const v of obs[mode][y].field) if (Number.isFinite(v)) ref.push(v);
    hotThreshold[mode] = round(quantile(ref.sort((a, b) => a - b), 0.9));
  }
  const masks = new Map([["ncr", null]]);
  for (const d of DISTRICTS) masks.set(`d:${d.id}`, Uint8Array.from(grid.district, (x) => (x === d.id ? 1 : 0)));
  const annualYears = Array.from({ length: 36 }, (_, k) => 1990 + k);
  const levelAt = (mode, y) => {
    const ys = FRAMES_OBS;
    if (y <= ys[0]) return LEVELS[mode][ys[0]];
    for (let k = 1; k < ys.length; k += 1) {
      if (y <= ys[k]) return LEVELS[mode][ys[k - 1]] + ((LEVELS[mode][ys[k]] - LEVELS[mode][ys[k - 1]]) * (y - ys[k - 1])) / (ys[k] - ys[k - 1]);
    }
    return LEVELS[mode][ys[ys.length - 1]];
  };
  const seriesOut = {};
  const zoneShare = { day: { obs: {} }, night: { obs: {} } };
  for (const scope of scopes) {
    seriesOut[scope.id] = {};
    for (const mode of ["day", "night"]) {
      if (scope.kind === "zone" && scope.mode !== mode) continue;
      const maskFor = (series, year, ssp = null) => {
        if (scope.kind !== "zone") return masks.get(scope.id);
        const zid = Number(scope.id.split(":")[2]);
        const z = series === "obs" ? zones[mode].obs[year] : zones[mode].proj[ssp][year];
        return Uint8Array.from(z, (x) => (x === zid ? 1 : 0));
      };
      const frames = FRAMES_OBS.map((year) => {
        const o = obs[mode][year];
        const mask = maskFor("obs", year);
        const st = frameStats(o.field, { mask, built: featuresByYear[year].frac_built, water: featuresByYear[year].frac_water, threshold: hotThreshold[mode], cellAreaKm2: grid.cellAreaKm2, tier: o.tier });
        const ciHalf = o.tier === "modelled" ? 0.8 : o.tier === "reconstructed" ? 0.4 : mode === "day" ? 0.35 : 0.25;
        const roi = mask ? mask.reduce((a, v) => a + v, 0) : n;
        return { year, ...st, ci: st.mean === null ? null : [round(st.mean - ciHalf), round(st.mean + ciHalf)], ...(optionalKeys ? { coverage: round(roi ? st.n_cells / roi : 0, 4) } : {}) };
      });
      const offset = (frames[frames.length - 1].mean ?? LEVELS[mode][NOW]) - LEVELS[mode][NOW];
      const refMean = annualYears.filter((y) => y >= REFERENCE_PERIOD[0] && y <= REFERENCE_PERIOD[1]).reduce((s, y) => s + levelAt(mode, y), 0) / 21;
      const annualRand = mulberry32(seed + (mode === "day" ? 11 : 13));
      const era5 = annualYears.map((y) => {
        const v = (mode === "day" ? 37.2 : 24.1) + (levelAt(mode, y) - refMean) * 0.8 + 0.3 * gaussian(annualRand) + 0.2 * offset;
        return { year: y, value: round(v), anomaly: round(v - (mode === "day" ? 37.2 : 24.1) - 0.2 * offset) };
      });
      const satellite = [];
      if (mode === "day") {
        for (let y = 2000; y <= 2025; y += 1) satellite.push({ year: y, value: round(levelAt("day", y) - 1.2 + offset + 0.35 * gaussian(annualRand)), sensor: "MODIS Terra", flag: y >= 2022 ? "drift" : null });
      } else {
        for (let y = 2003; y <= 2025; y += 1) satellite.push({ year: y, value: round(levelAt("night", y) + offset + 0.25 * gaussian(annualRand)), sensor: "MODIS Aqua", flag: y >= 2022 ? "drift" : null });
        for (let y = 2012; y <= 2025; y += 1) satellite.push({ year: y, value: round(levelAt("night", y) + offset + 0.1 + 0.25 * gaussian(annualRand)), sensor: "VIIRS (Aqua-calibrated)", flag: null });
      }
      const ssp = {};
      const decomposition = {};
      const budget = {};
      const thresholdYears = {};
      // Weather-normalised baseline (D14/D15): the observed NOW mean minus the NOW-window weather
      // anomaly, so projected changes (p50 − baseline) differ from p50 − observed NOW.
      const lBase = round(frames[frames.length - 1].mean - WEATHER_ANOMALY[mode]);
      if (scope.id === "ncr") baselineLevel[mode] = lBase;
      for (const s of SCENARIOS) {
        ssp[s] = FRAMES_PROJ.map((year) => {
          const p = proj[mode][s][year];
          const mask = maskFor("proj", year, s);
          const m = meanOf(p.p50, mask);
          const sg = meanOf(p.sigma, mask) * 0.75;
          return { year, p05: round(m - 1.645 * sg), p25: round(m - 0.674 * sg), p50: round(m), p75: round(m + 0.674 * sg * 1.05), p95: round(m + 1.645 * sg * 1.05) };
        });
        decomposition[s] = Object.fromEntries(
          FRAMES_PROJ.map((year, k) => {
            const p = proj[mode][s][year];
            const climate = BETA[mode] * p.dT;
            const total = ssp[s][k].p50 - lBase;
            return [String(year), { climate: round(climate), land: round(total - climate), total: round(total), ...(optionalKeys ? { baseline_c: lBase } : {}) }];
          }),
        );
        budget[s] = Object.fromEntries(
          FRAMES_PROJ.map((year) => {
            const k = (year - NOW) / 25;
            const raw = { gcm: 0.15 + 0.4 * k, sensitivity: 0.1 + 0.15 * k, land: 0.1 + 0.1 * k * SSP_SPREAD[s], model: 0.65 - 0.3 * k };
            const sum = Object.values(raw).reduce((a, b) => a + b, 0);
            return [String(year), Object.fromEntries(Object.entries(raw).map(([key, v]) => [key, round(v / sum, 3)]))];
          }),
        );
        const crossing = (d) => ssp[s].find((r) => r.p50 - lBase >= d)?.year ?? null;
        thresholdYears[s] = { "+1": crossing(1), "+2": crossing(2), "+3": crossing(3) };
      }
      const obsTrendFrames = frames.filter((f) => mode === "day" || f.tier !== "modelled");
      seriesOut[scope.id][mode] = {
        frames,
        annual: { era5_skin: era5, satellite },
        ssp,
        trend: { obs: trendOf(obsTrendFrames.map((f) => f.year), obsTrendFrames.map((f) => f.mean)), annual: { era5_skin: trendOf(era5.map((r) => r.year), era5.map((r) => r.value)) } },
        decomposition,
        uncertainty_budget: budget,
        threshold_years: thresholdYears,
      };
    }
  }
  for (const mode of ["day", "night"]) {
    const share = (z) => {
      const c = [0, 0, 0, 0];
      for (const v of z) if (v <= 3) c[v] += 1;
      const t = c.reduce((a, b) => a + b, 0) || 1;
      return c.map((x) => round(x / t, 4));
    };
    for (const y of FRAMES_OBS) zoneShare[mode].obs[String(y)] = share(zones[mode].obs[y]);
    for (const s of SCENARIOS) zoneShare[mode][s] = Object.fromEntries(FRAMES_PROJ.map((y) => [String(y), share(zones[mode].proj[s][y])]));
  }
  put("timeline_series.json.gz", () => ({ reference_period: REFERENCE_PERIOD, hot_core_threshold_c: hotThreshold, ...(optionalKeys ? { baseline_level_c: baselineLevel } : {}), scopes, series: seriesOut, zone_share: zoneShare }));

  // ---- small JSON assets ------------------------------------------------------------------
  const groupIds = GROUPS.map((g) => g.id);
  const shapGlobalMode = (mode) => {
    const meanAbs = (shap) => groupIds.map((g) => round(meanOf(shap[g].map(Math.abs)), 3));
    const all = meanAbs(obs[mode][NOW].shap);
    return {
      groups: groupIds,
      global: { mean_abs: all, ci_lo: all.map((v) => round(v * 0.9, 3)), ci_hi: all.map((v) => round(v * 1.1 + 0.001, 3)), bias: groupIds.map(() => 0) },
      by_frame: Object.fromEntries(FRAMES_OBS.map((y) => [String(y), { mean_abs: meanAbs(obs[mode][y].shap), mean: groupIds.map((g) => round(meanOf(obs[mode][y].shap[g]), 3)) }])),
      // Same slice shape as by_frame (and as the notebook writes it): {mean_abs, mean, n} per zone.
      by_zone: Object.fromEntries(
        [0, 1, 2, 3].map((z) => {
          const inZone = zones[mode].obs[NOW].map((x) => x === z);
          const n = inZone.filter(Boolean).length;
          return [
            String(z),
            {
              mean_abs: groupIds.map((g) => round(meanOf(obs[mode][NOW].shap[g].map(Math.abs), inZone), 3)),
              mean: groupIds.map((g) => round(meanOf(obs[mode][NOW].shap[g], inZone), 3)),
              n,
            },
          ];
        }),
      ),
      n_bootstrap: 6,
      ci_method: "recentred-percentile",
      ci_label: "replicate range",
    };
  };
  put("shap_global.json", () => ({ modes: { day: shapGlobalMode("day"), night: shapGlobalMode("night") } }));

  const dependenceMode = (mode) => {
    const groups = {};
    const f = featuresByYear[NOW];
    const shapNow = obs[mode][NOW].shap;
    for (const g of GROUPS) {
      const x = f[g.primary] ?? f.ndvi;
      const s = sortedFinite(x);
      const lo = quantile(s, 0.02);
      const hi = quantile(s, 0.98);
      const bins = 12;
      const centers = [];
      const mean = [];
      const count = [];
      for (let b = 0; b < bins; b += 1) {
        const a = lo + ((hi - lo) * b) / bins;
        const z = lo + ((hi - lo) * (b + 1)) / bins;
        let sum = 0;
        let c = 0;
        for (let i = 0; i < n; i += 1) if (x[i] >= a && (x[i] < z || b === bins - 1)) (sum += shapNow[g.id][i]), (c += 1);
        centers.push(round((a + z) / 2, 4));
        mean.push(c ? round(sum / c, 3) : null);
        count.push(c);
      }
      const step = Math.max(1, Math.floor(n / 400));
      const idx = Array.from({ length: Math.floor(n / step) }, (_, k) => k * step);
      const crossing = centers.find((cx, k) => k > 0 && mean[k] !== null && mean[k - 1] !== null && Math.sign(mean[k]) !== Math.sign(mean[k - 1])) ?? null;
      groups[g.id] = {
        primary: g.primary,
        bin_centers: centers,
        mean,
        ci_lo: mean.map((v) => (v === null ? null : round(v - 0.05, 3))),
        ci_hi: mean.map((v) => (v === null ? null : round(v + 0.05, 3))),
        count,
        scatter: { x: idx.map((i) => round(x[i], 4)), shap: idx.map((i) => round(shapNow[g.id][i], 3)), color: idx.map((i) => round(f.frac_built[i], 3)), color_feature: "frac_built", zone: idx.map((i) => zones[mode].obs[NOW][i]), year: idx.map(() => NOW) },
        threshold: { direction: (mean[mean.length - 1] ?? 0) >= (mean[0] ?? 0) ? "warming" : "cooling", zero_crossing: crossing, zero_crossing_ci: crossing === null ? null : [round(crossing * 0.95, 4), round(crossing * 1.05, 4)], zero_crossing_support: crossing === null ? null : 0.83, zero_crossing_flag: crossing !== null },
      };
    }
    return { groups };
  };
  put("dependence.json.gz", () => ({ modes: { day: dependenceMode("day"), night: dependenceMode("night") } }));

  const interactionsMode = () => {
    const K = groupIds.length;
    const m = Array.from({ length: K }, (_, a) => Array.from({ length: K }, (_, b) => (a === b ? 0 : round(0.02 + 0.08 * Math.abs(Math.sin(a * 1.7 + b * 0.9)), 3))));
    for (let a = 0; a < K; a += 1) for (let b = 0; b < a; b += 1) m[a][b] = m[b][a];
    return { groups: groupIds, global: m, by_zone: { 0: m, 1: m, 2: m, 3: m } };
  };
  put("interactions.json", () => ({ modes: { day: interactionsMode(), night: interactionsMode() } }));

  const zonesMode = (mode) => ({
    k: 4,
    silhouette: mode === "day" ? 0.41 : 0.38,
    diagnostics: { k_range: [2, 3, 4, 5, 6], silhouette: [0.36, 0.39, mode === "day" ? 0.41 : 0.38, 0.37, 0.33], inertia: [1.0, 0.71, 0.55, 0.47, 0.41] },
    labelling: {
      method: "SPEC §1.5 rule",
      order: ["heat_core", "riparian", "cool_base", "transition"],
      ...(optionalKeys
        ? {
            riparian_criterion_met: mode === "day",
            riparian_criterion: mode === "day" ? "mean frac_water >= 0.05" : "none: no cluster has mean frac_water >= 0.05, >= 25 % rows with frac_water >= 0.2, or water as the top |SHAP| group >= 0.25 C",
          }
        : {}),
    },
    zones: zonesMetaFor(mode).map((z) => {
      const area = { obs: {} };
      const lst = { obs: {} };
      for (const y of FRAMES_OBS) {
        const m = zones[mode].obs[y].map((x) => x === z.id);
        area.obs[String(y)] = round(m.reduce((s, v) => s + v, 0) * grid.cellAreaKm2, 1);
        lst.obs[String(y)] = round(meanOf(obs[mode][y].field, m));
      }
      for (const s of SCENARIOS) {
        area[s] = {};
        lst[s] = {};
        for (const y of FRAMES_PROJ) {
          const m = zones[mode].proj[s][y].map((x) => x === z.id);
          area[s][String(y)] = round(m.reduce((a, v) => a + v, 0) * grid.cellAreaKm2, 1);
          lst[s][String(y)] = round(meanOf(proj[mode][s][y].p50, m));
        }
      }
      const zm = zones[mode].obs[NOW].map((x) => x === z.id);
      return {
        id: z.id,
        name: z.name,
        ...(optionalKeys ? { display_name: z.display_name, label_caveat: z.label_caveat } : {}),
        color: z.color,
        description: z.label_caveat ? `${z.display_name}. ${z.label_caveat}` : `${z.name} (${mode}, synthetic fixture)`,
        n_cells: zm.reduce((s, v) => s + v, 0),
        area_km2: area,
        lst_mean: lst,
        shap_means: Object.fromEntries(groupIds.map((g) => [g, round(meanOf(obs[mode][NOW].shap[g], zm), 3)])),
        feature_means: Object.fromEntries(BASE_FEATURES.map((name) => [name, round(meanOf(featuresByYear[NOW][name], zm), 4)])),
        recommendations: [
          { feature: "frac_forest", group: "forest", label: "+10 pp tree cover", delta: 0.1, expected_delta_c: round(mode === "day" ? -0.28 : 0.03, 2), ci: [round(mode === "day" ? -0.36 : -0.01, 2), round(mode === "day" ? -0.2 : 0.07, 2)], feasible_share: 0.62 },
          { feature: "frac_water", group: "water", label: "+5 pp water / wetland", delta: 0.05, expected_delta_c: round(mode === "day" ? -0.41 : 0.1, 2), ci: [round(mode === "day" ? -0.5 : 0.05, 2), round(mode === "day" ? -0.33 : 0.15, 2)], feasible_share: 0.4 },
        ],
      };
    }),
    transitions: {
      obs: Object.fromEntries(FRAMES_OBS.slice(1).map((y, k) => [`${FRAMES_OBS[k]}->${y}`, transitionMatrix(zones[mode].obs[FRAMES_OBS[k]], zones[mode].obs[y])])),
      ...Object.fromEntries(SCENARIOS.map((s) => [s, Object.fromEntries([NOW, ...FRAMES_PROJ].slice(1).map((y, k) => {
        const from = k === 0 ? zones[mode].obs[NOW] : zones[mode].proj[s][FRAMES_PROJ[k - 1]];
        return [`${k === 0 ? NOW : FRAMES_PROJ[k - 1]}->${y}`, transitionMatrix(from, zones[mode].proj[s][y])];
      }))])),
    },
  });
  put("zones.json", () => ({ modes: { day: zonesMode("day"), night: zonesMode("night") } }));

  const metricsMode = (mode) => {
    const r2 = mode === "day" ? 0.86 : 0.83;
    const rmse = mode === "day" ? 0.94 : 0.71;
    const models = ["ridge", "random_forest", "lightgbm", "xgboost", "gnn"];
    const summary = [];
    for (const scheme of ["block20", "block5", "district", "loeo", "place_time", "random"]) {
      for (const [k, model] of models.entries()) {
        const penalty = { block20: 0, block5: -0.02, district: 0.03, loeo: -0.03, place_time: 0.05, random: -0.09 }[scheme] + (4 - k) * 0.015 * (model === "gnn" ? 0.3 : 1);
        summary.push({ scheme, model, r2_pooled: round(r2 - penalty, 3), rmse_pooled: round(rmse + penalty * 2, 3), mae_pooled: round((rmse + penalty * 2) * 0.78, 3), r2_fold_mean: round(r2 - penalty - 0.04, 3), r2_fold_sd: 0.08, rmse_fold_mean: round(rmse + penalty * 2 + 0.03, 3), rmse_fold_sd: 0.12, n_folds: scheme === "random" ? 5 : 5, n: n * FRAMES_OBS.length });
      }
    }
    const folds = [];
    for (let fold = 0; fold < 5; fold += 1) folds.push({ scheme: "block20", model: "xgboost", fold, r2: round(r2 - 0.1 + 0.05 * fold * 0.8, 3), rmse: round(rmse + 0.05 * (2 - fold), 3), mae: round(rmse * 0.78, 3), bias: round(0.04 * (fold - 2), 3), n_train: Math.round(n * 6.4), n_test: Math.round(n * 1.6) });
    return {
      schemes: ["block20", "block5", "district", "loeo", "place_time", "random"],
      models,
      summary,
      folds,
      block_size_curve: [5, 10, 20, 40, 66].map((b, k) => ({ block_km: b, r2_pooled: round(r2 + 0.06 - 0.03 * k, 3), rmse_pooled: round(rmse - 0.1 + 0.06 * k, 3) })),
      error_vs_distance: [[0, 2], [2, 5], [5, 10], [10, 20], [20, 40], [40, null]].map(([lo, hi], k) => ({ lo, hi, rmse: round(rmse * (0.75 + 0.1 * k), 3), n: Math.round(n * (1.2 - 0.15 * k)) })),
      loeo: FRAMES_OBS.filter((y) => mode === "day" || y >= 2005).map((y) => ({ held_out: y, r2_raw: round(r2 - 0.25, 3), r2_recentred: round(r2 - 0.02, 3), rmse_recentred: round(rmse + 0.05, 3), bias_raw: round(LEVELS[mode][y] - LEVELS[mode][NOW], 2) })),
      place_time: { r2: round(r2 - 0.05, 3), rmse: round(rmse + 0.1, 3), recentred: true },
      moran: FRAMES_OBS.slice(-4).flatMap((y) => ["xgboost", "gnn", "ridge"].map((model, k) => ({ year: y, model, I: round(0.18 + 0.1 * k, 3), p: 0.001 }))),
      moran_target: FRAMES_OBS.slice(-4).map((y) => ({ year: y, I: 0.72, p: 0.001 })),
      moran_scatter: { year: NOW, z: [], lag: [], slope: 0.21 },
      fold_geometry: { block20: { block_km: 20, n_rows: 4, n_cols: 4, fold_of_block: Array.from({ length: 16 }, (_, k) => k % 5), rmse_of_block: Array.from({ length: 16 }, (_, k) => round(rmse + 0.1 * Math.sin(k), 3)) } },
      aoa: {
        di_threshold: 0.47,
        pct_inside: Object.fromEntries([...FRAMES_OBS, ...FRAMES_PROJ].map((y) => [String(y), y > NOW ? round(0.97 - 0.006 * ((y - NOW) / 5), 3) : 0.99])),
        rmse_by_di_decile: Array.from({ length: 10 }, (_, k) => round(rmse * (0.8 + 0.05 * k), 3)),
        ...(optionalKeys ? { resid_rho_block20: mode === "day" ? 0.36 : 0.42, proj_resid_q90: Array.from({ length: 10 }, (_, k) => round(rmse * (1.3 + 0.08 * k), 3)) } : {}),
      },
      persistent_residual: { lambda: 3, loeo_rmse_without: round(rmse + 0.08, 3), loeo_rmse_with: round(rmse - 0.04, 3) },
      hindcast: mode === "night" ? { frame: 2000, r2: 0.78, rmse: 0.62, persistence_rmse: 0.81 } : { frames: [1990, 1995, 2000], r2: 0.8, rmse: 1.02 },
      cross_sensor: { landsat_vs_modis_terra: [2010, 2015, 2020].map((y) => ({ year: y, r2: 0.74, rmse: 1.3 })) },
      v1_comparison: { v1_metric: "mean of per-fold R² (5×5)", v1_xgb: [0.623, 0.305], v1_gnn: [0.823, 0.048], v2_block5_pooled: round(r2 + 0.02, 3), v2_block5_fold_mean: round(r2 - 0.03, 3), v2_block20_pooled: r2, label: "reference values from the real v1 run" },
      headline: { spatial: { scheme: "block20", model: "xgboost", r2, rmse }, temporal: { scheme: "loeo", model: "xgboost", r2: round(r2 - 0.02, 3), rmse: round(rmse + 0.05, 3) } },
    };
  };
  put("metrics.json", () => ({
    modes: { day: metricsMode("day"), night: metricsMode("night") },
    downscaling: { night: { scale_invariance: { r2: 0.81, rmse: 0.48, bias: 0.02, bilinear_rmse: 0.71 }, by_lc: [{ class: "built", r2: 0.77, rmse: 0.55 }, { class: "cropland", r2: 0.83, rmse: 0.44 }] }, day_demo: { r2: 0.72, rmse: 1.21, bilinear_rmse: 1.64, years: [2010, 2015, 2020] } },
    land_model: {
      fom: 0.31,
      fom_null: 0.18,
      quantity_disagreement: 0.04,
      allocation_disagreement: 0.09,
      quantity_disagreement_null: 0.03,
      allocation_disagreement_null: 0.11,
      rmse_du: 0.051,
      rmse_du_null: 0.067,
      ...(optionalKeys
        ? {
            corr_du: 0.42,
            corr_du_null: 0.35,
            checks: [
              { check: "fom > null", value: 0.31, null: 0.18, ok: true },
              { check: "rmse_du <= null", value: 0.051, null: 0.067, ok: true },
              { check: "quantity_disagreement <= null", value: 0.04, null: 0.03, ok: false },
              { check: "corr_du >= null", value: 0.42, null: 0.35, ok: true },
            ],
            verdict: "mixed",
            hindcast_truth: "GHSL P2023A 2025 epoch (an extrapolated GHSL epoch, not an observation)",
          }
        : {}),
    },
    climate_sensitivity: { day: { beta: BETA.day, ci: [0.7, 1.2], r2: 0.61, n_years: 18, theil_sen: 0.93 }, night: { beta: BETA.night, ci: [0.85, 1.35], r2: 0.68, n_years: 23, theil_sen: 1.08 } },
    night_calibration: { terra_to_aqua: { r2: 0.91, rmse: 0.42, n: 17 }, viirs_to_aqua: { r2: 0.94, rmse: 0.35, n: 9 } },
    // Per mode × SSP projection metadata (SPEC §5.6): AOA share outside per projected frame.
    projection_meta: Object.fromEntries(
      ["day", "night"].map((mode) => [
        mode,
        Object.fromEntries(
          SCENARIOS.map((s, k) => [
            s,
            {
              n_mc: 120,
              method: s === "ssp126" ? "pattern-scaled" : "cmip6-delta-mc",
              pct_outside_aoa: Object.fromEntries(FRAMES_PROJ.map((y) => [String(y), round(0.02 + 0.006 * ((y - NOW) / 5) + (mode === "night" ? 0.01 : 0) + 0.01 * k, 4)])),
              note: "scenario projection, not a forecast",
            },
          ]),
        ),
      ]),
    ),
    hardware: { device: "synthetic fixture (no model was trained)" },
    timings: {},
  }));

  put("provenance.json", () => ({
    sources: [
      { id: "landsat_c2_l2", label: "Landsat Collection 2 Level-2 ST", asset: "LANDSAT/*/C02/T1_L2", start: 1989, end: 2026, resolution_m: 30, role: "day LST + spectral", used_for: ["day"], notes: "fixture" },
      { id: "modis_aqua", label: "MODIS Aqua MYD11A2", asset: "MODIS/061/MYD11A2", start: 2003, end: 2021, resolution_m: 1000, role: "night LST", used_for: ["night"], notes: "fixture" },
      { id: "viirs", label: "VIIRS VNP21A1N", asset: "NASA/VIIRS/002/VNP21A1N", start: 2012, end: 2026, resolution_m: 1000, role: "night LST (Aqua-calibrated)", used_for: ["night"], notes: "fixture" },
      { id: "cmip6", label: "NASA GDDP-CMIP6", asset: "NASA/GDDP-CMIP6", start: 1950, end: 2060, resolution_m: 27830, role: "climate deltas", used_for: ["projections"], notes: "ssp126 pattern-scaled" },
    ],
    frames: FRAMES_OBS.flatMap((y) => ["day", "night"].map((mode) => ({ year: y, mode, tier: obs[mode][y].tier, sensor: mode === "day" ? DAY_SENSORS[y] : NIGHT_INFO[y][0], window: WINDOWS[y], scenes: mode === "day" ? DAY_SCENES[y] : NIGHT_INFO[y][2], coverage: mode === "day" ? round(meanOf(obs.day[y].field.map((v) => (Number.isFinite(v) ? 1 : 0))), 3) : 1, overpass_ist: mode === "day" ? DAY_OVERPASS[y] : NIGHT_INFO[y][1] }))),
    annotations: [{ year: 2003, label: "Landsat 7 SLC-off", kind: "sensor" }, { year: 2022, label: "Terra/Aqua drift; VIIRS bridge", kind: "sensor" }],
  }));

  const modelWeb = (mode) => buildModelWeb(mode, featuresByYear[NOW], obs[mode][NOW], seed);
  put("model_web_day.json", () => modelWeb("day"));
  put("model_web_night.json", () => modelWeb("night"));
  put("scenario_coupling.json", () => ({
    description: "Partial slopes (d index / d fraction) — synthetic fixture.",
    fraction_features: ["frac_built", "frac_forest", "frac_water", "frac_cropland", "frac_barren"],
    coupling: {
      frac_built: { ndvi: -0.07, ndbi: 0.3, mndwi: 0, albedo: 0.015 },
      frac_forest: { ndvi: 0.42, ndbi: -0.12, mndwi: -0.08, albedo: -0.02 },
      frac_water: { ndvi: 0.05, ndbi: -0.2, mndwi: 1.05, albedo: -0.06 },
      frac_cropland: { ndvi: 0.24, ndbi: -0.07, mndwi: 0.05, albedo: -0.012 },
      frac_barren: { ndvi: -0.06, ndbi: 0.24, mndwi: -0.01, albedo: 0.085 },
    },
    focal: FOCAL_SPEC,
    grid: { width, height },
  }));
  put("districts.geojson", () => districtGeoJson(grid));

  // ---- manifest ---------------------------------------------------------------------------
  const featureStats = (values) => {
    const s = sortedFinite(values);
    const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
    const std = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / (s.length || 1));
    return { min: round(s[0], 4), max: round(s[s.length - 1], 4), p01: round(quantile(s, 0.01), 4), p99: round(quantile(s, 0.99), 4), median: round(quantile(s, 0.5), 4), mean: round(mean, 4), std: round(std, 4) };
  };
  const focal2025 = {};
  for (const b of FOCAL_BASES) {
    focal2025[`${b}_m3`] = boxMean(grid, featuresByYear[NOW][b], 1);
    focal2025[`${b}_m15`] = boxMean(grid, featuresByYear[NOW][b], 7);
  }
  const groupOf = (name) => GROUPS.find((g) => g.members.includes(name))?.id ?? null;
  const features = FEATURES.map((name) => {
    const baseName = name.replace(/_m(3|15)$/, "");
    const info = FEATURE_INFO[baseName] ?? [name, "", "number", "spectral"];
    const isFocal = name !== baseName;
    return {
      name,
      label: isFocal ? `${info[0]} (${name.endsWith("_m3") ? "3-cell" : "15-cell"} mean)` : info[0],
      unit: info[1],
      display: info[2],
      family: info[3],
      group: groupOf(name),
      base: !isFocal,
      actionable: !isFocal && ACTIONABLE.has(name),
      description: `${info[0]} — synthetic fixture value`,
      source: "synthetic fixture",
      stats: featureStats(isFocal ? focal2025[name] : featuresByYear[NOW][name]),
    };
  });
  // NCR quantiles of a projected frame per SSP (manifest `by_scenario`, same formula as the NCR
  // fan of timeline_series); `level` / `level_ci` repeat the ssp245 entry (`level_scenario`).
  const projQuantiles = (mode, year) =>
    Object.fromEntries(
      SCENARIOS.map((s) => {
        const p = proj[mode][s][year];
        const m = meanOf(p.p50);
        const sg = meanOf(p.sigma) * 0.75;
        return [s, { p05: round(m - 1.645 * sg), p25: round(m - 0.674 * sg), p50: round(m), p75: round(m + 0.674 * sg * 1.05), p95: round(m + 1.645 * sg * 1.05) }];
      }),
    );
  const projEntry = (mode, year, overpass) => {
    const q = projQuantiles(mode, year);
    return { tier: "projected", sensor: "XGBoost + CMIP6 delta (MC)", overpass_ist: overpass, scenes: 0, coverage: 1, native_m: grid.resM, available: true, level: q.ssp245.p50, level_ci: [q.ssp245.p05, q.ssp245.p95], level_scenario: "ssp245", by_scenario: q };
  };
  const frameEntry = (year) => {
    const proj = year > NOW;
    const day = proj
      ? projEntry("day", year, "10:45")
      : {
          tier: obs.day[year].tier,
          sensor: DAY_SENSORS[year],
          overpass_ist: DAY_OVERPASS[year],
          scenes: DAY_SCENES[year],
          coverage: round(meanOf(obs.day[year].field.map((v) => (Number.isFinite(v) ? 1 : 0))), 3),
          native_m: 30,
          available: true,
          level: LEVELS.day[year],
          level_ci: [round(LEVELS.day[year] - 0.35), round(LEVELS.day[year] + 0.35)],
        };
    const night = proj
      ? projEntry("night", year, "01:30")
      : {
          tier: obs.night[year].tier,
          sensor: NIGHT_INFO[year][0],
          overpass_ist: NIGHT_INFO[year][1],
          scenes: NIGHT_INFO[year][2],
          coverage: 1,
          native_m: 1000,
          available: true,
          level: LEVELS.night[year],
          level_ci: obs.night[year].tier === "modelled" ? [round(LEVELS.night[year] - 0.8), round(LEVELS.night[year] + 0.8)] : [round(LEVELS.night[year] - 0.25), round(LEVELS.night[year] + 0.25)],
        };
    return {
      year,
      window: proj ? [year - 9, year + 10] : WINDOWS[year],
      kind: proj ? "projected" : "observed",
      day,
      night,
      xai: { day: !proj, night: !proj },
      raster: { day: !proj, night: !proj },
    };
  };
  const cubes = {};
  for (const mode of ["day", "night"]) {
    cubes[`obs_${mode}`] = `cube_obs_${mode}.lstb.gz`;
    cubes[`zones_${mode}`] = `cube_zones_${mode}.lstb.gz`;
    for (const s of SCENARIOS) cubes[`${s}_${mode}`] = `cube_${s}_${mode}.lstb.gz`;
  }
  const manifest = {
    schema_version: "2.0",
    generated_at: "2026-10-01T00:00:00Z",
    data_mode: "synthetic",
    data_mode_reason: "in-memory dashboard fixture (src/data/fixtures/synthV2.js) — not observations",
    study_area: {
      name: "Delhi NCR",
      area_km2: round(n * grid.cellAreaKm2, 0),
      crs: "EPSG:32643",
      grid_res_m: grid.resM,
      bbox: [round(Math.min(...grid.lon) - grid.dLon / 2, 5), round(Math.min(...grid.lat) - grid.dLat / 2, 5), round(Math.max(...grid.lon) + grid.dLon / 2, 5), round(Math.max(...grid.lat) + grid.dLat / 2, 5)],
      center: [77.0, 28.35],
      boundary_approximate: true,
      boundary_source: "SPEC_v1 §1.2 outline, Voronoi districts (fixture)",
      grid: { crs: "EPSG:4326 (fixture lattice)", res: grid.resM, x0: grid.west, y0: grid.north, width, height },
      fine_res_m: Math.round(grid.resM / 3),
    },
    target_mode: "anomaly",
    features,
    modes: [
      { id: "day", label: "Day · ~10:30 IST", target: "Landsat C2 L2 ST (harmonised, 10:45 IST reference)", ramp: "solar" },
      { id: "night", label: "Night · ~01:30 IST", target: "MODIS Aqua night (Aqua-equivalent; VIIRS/Terra calibrated)", ramp: "nocturne" },
    ],
    groups: GROUPS.map((g) => ({ ...g, members: g.members.slice() })),
    zones: { day: zonesMetaFor("day").map(({ mode: _m, ...z }) => z), night: zonesMetaFor("night").map(({ mode: _m, ...z }) => z) },
    districts: DISTRICTS.map(({ id, name, state }) => ({ id, name, state })),
    timeline: {
      now: NOW,
      harmonised: true,
      reference_period: REFERENCE_PERIOD,
      frames: [...FRAMES_OBS, ...FRAMES_PROJ].map(frameEntry),
      scenarios: [
        { id: "ssp126", label: "SSP1-2.6", method: "pattern-scaled", n_gcm: 34 },
        { id: "ssp245", label: "SSP2-4.5", method: "cmip6-delta-mc", n_gcm: 34 },
        { id: "ssp585", label: "SSP5-8.5", method: "cmip6-delta-mc", n_gcm: 34 },
      ],
      domains,
      annotations: [{ year: 2003, label: "Landsat 7 SLC-off", kind: "sensor" }, { year: 2022, label: "Terra/Aqua drift; VIIRS bridge", kind: "sensor" }],
      tiers: ["observed", "observed-sparse", "reconstructed", "modelled", "projected"],
      cubes,
      raster_index: "raster_index.json",
    },
    files: {
      cells: "cells.lstb.gz",
      series: "timeline_series.json.gz",
      xai: Object.fromEntries(["day", "night"].map((mode) => [mode, Object.fromEntries(FRAMES_OBS.map((y) => [String(y), { features: `xai_${y}_features.lstb.gz`, shap: `xai_${y}_${mode}.lstb.gz` }]))])),
      model: { day: "model_web_day.json", night: "model_web_night.json" },
      shap_global: "shap_global.json",
      dependence: "dependence.json.gz",
      zones: "zones.json",
      metrics: "metrics.json",
      interactions: "interactions.json",
      coupling: "scenario_coupling.json",
      districts: "districts.geojson",
      provenance: "provenance.json",
    },
    data_sources: { lst_day: Object.fromEntries(FRAMES_OBS.map((y) => [String(y), `synthetic ${DAY_SENSORS[y]} composite ${WINDOWS[y][0]}–${WINDOWS[y][1]} Apr–Jun`])) },
    notes: [
      "SYNTHETIC FIXTURE: generated in the browser by src/data/fixtures/synthV2.js for UI development — not observations.",
      "scenario projection, not a forecast",
    ],
    bootstrap: { day: { n: 6, ci_label: "replicate range", ci_method: "recentred-percentile", replicate_range: true }, night: { n: 6, ci_label: "replicate range", ci_method: "recentred-percentile", replicate_range: true } },
    synthetic_truth: { uhi_sign: { day: -1, night: 1 }, beta: BETA, levels: LEVELS },
  };
  files.set("manifest.json", () => manifest);
  fileNames.unshift("manifest.json");

  return {
    manifest,
    files,
    fileNames,
    truth: { hotThreshold, domains, levels: LEVELS, beta: BETA },
    world: { grid, featuresByYear, obs, proj, zones },
  };
}

function transitionMatrix(from, to) {
  const m = [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
  for (let i = 0; i < from.length; i += 1) if (from[i] <= 3 && to[i] <= 3) m[from[i]][to[i]] += 1;
  return m;
}

/** Tiny deterministic compact tree ensemble (SPEC_v1 §4.3 format) on the 47 features. */
function buildModelWeb(mode, f2025, o2025, seed) {
  const rand = mulberry32(seed + (mode === "day" ? 101 : 202));
  const importantNames = mode === "day" ? ["frac_barren", "ndvi", "frac_water", "frac_built", "era5_t2m"] : ["frac_built", "built_v", "frac_water", "frac_barren", "era5_swvl1"];
  const pool = importantNames.map((name) => FEATURES.indexOf(name));
  const stats = pool.map((k) => {
    const s = sortedFinite(f2025[FEATURES[k]] ?? new Float32Array(0));
    return s.length ? [quantile(s, 0.2), quantile(s, 0.5), quantile(s, 0.8)] : [0, 0.5, 1];
  });
  const trees = [];
  for (let t = 0; t < 24; t += 1) {
    const tree = { f: [], t: [], l: [], r: [], d: [], v: [] };
    const grow = (depth) => {
      const id = tree.f.length;
      const leaf = depth === 3;
      const p = Math.floor(rand() * pool.length);
      tree.f.push(leaf ? -1 : pool[p]);
      tree.t.push(leaf ? 0 : Math.fround(stats[p][Math.floor(rand() * 3)]));
      tree.l.push(-1);
      tree.r.push(-1);
      tree.d.push(leaf ? 0 : rand() < 0.5 ? 1 : 0);
      tree.v.push(leaf ? Math.round((rand() - 0.5) * 600) / 10000 : 0);
      if (!leaf) {
        tree.l[id] = grow(depth + 1);
        tree.r[id] = grow(depth + 1);
      }
      return id;
    };
    grow(0);
    trees.push(tree);
  }
  const predict = (row) => {
    let s = 0;
    for (const tree of trees) {
      let node = 0;
      while (tree.l[node] !== -1) {
        const x = row[tree.f[node]];
        const missing = x === null || x === undefined || Number.isNaN(x);
        node = missing ? (tree.d[node] === 1 ? tree.l[node] : tree.r[node]) : Math.fround(x) < tree.t[node] ? tree.l[node] : tree.r[node];
      }
      s += tree.v[node];
    }
    return s;
  };
  const rows = [];
  const n = o2025.pred.length;
  for (let k = 0; k < 20; k += 1) {
    const i = Math.floor((k * n) / 20);
    rows.push(FEATURES.map((name) => (f2025[name] ? round(f2025[name][i], 5) : 0.5)));
  }
  return {
    format: "lst-xgb-compact-v1",
    objective: "reg:squarederror",
    target_mode: "anomaly",
    mode,
    features: FEATURES.slice(),
    focal: FOCAL_SPEC,
    base_score: 0,
    n_trees: trees.length,
    trees,
    fidelity: { note: "synthetic fixture surrogate (random trees)", max_depth: 3, rounds: trees.length },
    check: { rows, expected: rows.map((r) => predict(r)) },
  };
}

/** District outlines traced from the union of their cells (edge cancellation + ring chaining). */
function districtGeoJson(grid) {
  const features = DISTRICTS.map((d) => {
    const edges = new Map();
    const key = (a, b) => `${a[0]},${a[1]}|${b[0]},${b[1]}`;
    for (let i = 0; i < grid.n; i += 1) {
      if (grid.district[i] !== d.id) continue;
      const r = grid.row[i];
      const c = grid.col[i];
      const corners = [[c, r], [c + 1, r], [c + 1, r + 1], [c, r + 1]];
      for (let k = 0; k < 4; k += 1) {
        const a = corners[k];
        const b = corners[(k + 1) % 4];
        const rev = key(b, a);
        if (edges.has(rev)) edges.delete(rev);
        else edges.set(key(a, b), [a, b]);
      }
    }
    const next = new Map();
    for (const [a, b] of edges.values()) {
      const k = `${a[0]},${a[1]}`;
      if (!next.has(k)) next.set(k, []);
      next.get(k).push(b);
    }
    const rings = [];
    const used = new Set();
    for (const [a, b] of edges.values()) {
      const startKey = key(a, b);
      if (used.has(startKey)) continue;
      const ring = [a];
      let nxt = b;
      used.add(startKey);
      let guard = 0;
      while (guard < 100000) {
        guard += 1;
        ring.push(nxt);
        if (nxt[0] === a[0] && nxt[1] === a[1]) break;
        const options = next.get(`${nxt[0]},${nxt[1]}`) ?? [];
        const choice = options.find((p) => !used.has(key(nxt, p)));
        if (!choice) break;
        used.add(key(nxt, choice));
        nxt = choice;
      }
      if (ring.length >= 4) rings.push(ring.map(([c, r]) => [round(grid.west + c * grid.dLon, 5), round(grid.north - r * grid.dLat, 5)]));
    }
    return {
      type: "Feature",
      properties: { id: d.id, name: d.name, state: d.state },
      geometry: rings.length ? { type: "MultiPolygon", coordinates: rings.map((ring) => [ring]) } : null,
    };
  }).filter((f) => f.geometry);
  return { type: "FeatureCollection", features };
}

/**
 * fetch() implementation serving a synthetic bundle under any URL ending in `/fixture/<name>`.
 * JSON files are serialised lazily (and cached); `.gz` files are gzip-compressed when
 * `CompressionStream` exists (exercising the real inflate path), else served inflated (readers
 * accept both, SPEC §5).
 * @param {ReturnType<typeof createSynthV2>} synth
 * @param {{compress?: boolean, latencyMs?: number}} [options]
 */
export function createFixtureFetch(synth, { compress = typeof CompressionStream === "function", latencyMs = 0 } = {}) {
  const cache = new Map();
  const bytesOf = async (name) => {
    if (cache.has(name)) return cache.get(name);
    const factory = synth.files.get(name);
    if (!factory) return null;
    const promise = (async () => {
      const value = factory();
      let bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(JSON.stringify(value));
      if (compress && name.endsWith(".gz")) bytes = await gzipBytes(bytes);
      return bytes;
    })();
    cache.set(name, promise);
    return promise;
  };
  const fetchImpl = async (url) => {
    const m = /\/fixture\/(.+)$/.exec(String(url).split("?")[0]);
    const name = m ? decodeURIComponent(m[1]) : null;
    if (latencyMs) await new Promise((resolve) => setTimeout(resolve, latencyMs));
    const bytes = name ? await bytesOf(name) : null;
    if (!bytes) return new Response("Not Found", { status: 404, headers: { "content-type": "text/plain" } });
    const type = name.endsWith(".png") ? "image/png" : name.endsWith(".gz") ? "application/gzip" : "application/json";
    return new Response(bytes, { status: 200, headers: { "content-type": type, "content-length": String(bytes.byteLength) } });
  };
  return fetchImpl;
}
