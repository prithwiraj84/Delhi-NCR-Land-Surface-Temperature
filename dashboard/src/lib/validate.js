/**
 * Web-bundle contract validation (SPEC §4). Run once after loading (and again for every epoch
 * loaded later, see `validateEpochs`); the result drives the validation indicator in the
 * header. Errors mean a SPEC invariant is broken (the dashboard may show wrong numbers);
 * warnings flag optional assets that are missing or soft anomalies, e.g. a point estimate
 * lying outside its own bootstrap interval or an interval exported without its estimate.
 *
 * Works on both raw JSON epochs and prepared (typed-array) epochs. The waterfall invariant is
 * checked on an evenly spaced sample of WATERFALL_SAMPLE rows per epoch.
 */

import { compileModel, checkModelAgainstPython, MODEL_FORMAT } from "./model.js";
import { intervalContains, normalizeInterval } from "./uncertainty.js";

export const CANONICAL_FEATURES = Object.freeze([
  "ndvi",
  "ndwi",
  "ndbi",
  "elevation",
  "slope",
  "aspect_sin",
  "aspect_cos",
  "ntl",
  "log_pop",
  "frac_impervious",
  "frac_forest",
  "frac_water",
  "frac_cropland",
  "frac_barren",
  "lm_pd",
  "lm_ed",
  "lm_contag",
]);

const WATERFALL_TOLERANCE_C = 0.05;
export const WATERFALL_SAMPLE = 500;
const MODEL_CHECK_TOLERANCE = 1e-3;
const DIRECTIONS = new Set(["cooling", "warming", "mixed"]);
const FEATURE_GROUPS = new Set(["spectral", "terrain", "socioeconomic", "landcover", "landscape"]);
const FEATURE_DISPLAYS = new Set(["index", "percent", "number"]);
const THRESHOLD_KEYS = Object.freeze(["zero_crossing", "breakpoint", "saturation"]);

const isArrayLike = (v) => Array.isArray(v) || ArrayBuffer.isView(v);
const isFiniteNum = (v) => typeof v === "number" && Number.isFinite(v);
const numOrNaN = (v) => (v === null || v === undefined ? NaN : Number(v));
const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Collector with bounded message lists (a broken bundle should not produce 50k messages). */
function createReport() {
  const errors = [];
  const warnings = [];
  const LIMIT = 200;
  return {
    errors,
    warnings,
    error: (msg) => errors.length < LIMIT && errors.push(msg),
    warn: (msg) => warnings.length < LIMIT && warnings.push(msg),
  };
}

// ---------------------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------------------

function validateManifest(manifest, r) {
  if (!manifest || typeof manifest !== "object") {
    r.error("manifest: missing or not an object");
    return [];
  }
  if (!manifest.schema_version) r.warn("manifest: schema_version missing");
  if (!["gee", "synthetic"].includes(manifest.data_mode)) {
    r.error(`manifest: data_mode must be "gee" or "synthetic" (got ${JSON.stringify(manifest.data_mode)})`);
  }
  if (!["anomaly", "absolute"].includes(manifest.target_mode)) {
    r.error(`manifest: target_mode must be "anomaly" or "absolute" (got ${JSON.stringify(manifest.target_mode)})`);
  }
  if (!Array.isArray(manifest.epochs) || !manifest.epochs.length || !manifest.epochs.every(Number.isInteger)) {
    r.error("manifest: epochs must be a non-empty array of integer years");
  }
  const bbox = manifest.study_area?.bbox;
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(isFiniteNum)) {
    r.error("manifest: study_area.bbox must be [minLon, minLat, maxLon, maxLat]");
  }
  if (!Array.isArray(manifest.study_area?.center) || manifest.study_area.center.length !== 2) {
    r.warn("manifest: study_area.center missing");
  }

  const features = Array.isArray(manifest.features) ? manifest.features : [];
  const names = features.map((f) => f?.name);
  if (!features.length) r.error("manifest: features list is empty");
  if (names.length && !sameList(names, CANONICAL_FEATURES)) {
    r.warn(`manifest: feature list differs from the SPEC order (${names.join(", ")})`);
  }
  features.forEach((f, i) => {
    if (!f?.name) r.error(`manifest: features[${i}] has no name`);
    if (!f?.label) r.warn(`manifest: feature "${f?.name}" has no label`);
    if (f?.group && !FEATURE_GROUPS.has(f.group)) r.warn(`manifest: feature "${f.name}" has unknown group "${f.group}"`);
    if (f?.display && !FEATURE_DISPLAYS.has(f.display)) r.warn(`manifest: feature "${f.name}" has unknown display "${f.display}"`);
  });

  const zones = manifest.zones;
  if (!Array.isArray(zones) || zones.length !== 4 || !zones.every((z, i) => z?.id === i)) {
    r.error("manifest: zones must list the 4 canonical zones with ids 0..3");
  }
  const districts = manifest.districts;
  if (!Array.isArray(districts) || !districts.length) r.error("manifest: districts list is empty");
  else if (districts.length !== 25) r.warn(`manifest: expected 25 canonical districts, got ${districts.length}`);

  for (const year of manifest.epochs ?? []) {
    if (!manifest.files?.epochs?.[String(year)]) r.error(`manifest: files.epochs is missing ${year}`);
  }
  for (const key of ["model", "shap_global", "dependence", "zones", "metrics", "districts"]) {
    if (!manifest.files?.[key]) r.warn(`manifest: files.${key} not declared`);
  }
  if (manifest.data_mode === "synthetic" && !manifest.synthetic_truth) {
    r.warn("manifest: synthetic bundle without synthetic_truth");
  }
  return names.filter(Boolean);
}

// ---------------------------------------------------------------------------------------
// Epochs
// ---------------------------------------------------------------------------------------

function checkColumn(epoch, name, n, r, label) {
  const col = epoch?.[name];
  if (!isArrayLike(col)) {
    r.error(`${label}: column "${name}" missing`);
    return false;
  }
  if (col.length !== n) {
    r.error(`${label}: column "${name}" has length ${col.length}, expected ${n}`);
    return false;
  }
  return true;
}

/** Evenly spaced sample of row indices. */
function sampleRows(n, max) {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const step = n / max;
  return Array.from({ length: max }, (_, k) => Math.floor(k * step));
}

function validateWaterfall(epoch, featureNames, r, label) {
  const base = numOrNaN(epoch.base_value_c);
  if (!Number.isFinite(base)) {
    r.error(`${label}: base_value_c missing`);
    return;
  }
  let checked = 0;
  let violations = 0;
  let worst = 0;
  for (const i of sampleRows(epoch.n, WATERFALL_SAMPLE)) {
    const pred = numOrNaN(epoch.lst_pred[i]);
    if (!Number.isFinite(pred)) continue;
    let sum = base;
    let complete = true;
    for (const f of featureNames) {
      const s = numOrNaN(epoch.shap[f][i]);
      if (!Number.isFinite(s)) {
        complete = false;
        break;
      }
      sum += s;
    }
    if (!complete) continue;
    checked += 1;
    const err = Math.abs(pred - sum);
    worst = Math.max(worst, err);
    if (err > WATERFALL_TOLERANCE_C + 1e-9) violations += 1;
  }
  if (!checked) r.warn(`${label}: no complete rows to check the SHAP waterfall invariant`);
  else if (violations > 0) {
    const msg = `${label}: lst_pred ≠ base_value_c + Σ shap on ${violations}/${checked} sampled rows (worst ${worst.toFixed(3)} °C)`;
    if (violations / checked > 0.01) r.error(msg);
    else r.warn(msg);
  }
}

function validateEpoch(epoch, year, manifest, featureNames, r) {
  const label = `epoch ${year}`;
  if (!epoch || typeof epoch !== "object") {
    r.error(`${label}: missing`);
    return;
  }
  const n = Number(epoch.n);
  if (!Number.isInteger(n) || n <= 0) {
    r.error(`${label}: invalid n (${epoch.n})`);
    return;
  }
  if (Number(epoch.year) !== Number(year)) r.error(`${label}: year field is ${epoch.year}`);
  if (!(Number(epoch.cell_size_m) > 0)) r.error(`${label}: cell_size_m must be positive`);
  if (!Number.isFinite(numOrNaN(epoch.epoch_mean))) r.warn(`${label}: epoch_mean missing`);

  const required = ["cell_id", "lon", "lat", "district", "lst_obs", "lst_pred", "zone"];
  const okCols = required.every((c) => checkColumn(epoch, c, n, r, label));
  for (const c of ["lst_pred_oof", "resid_oof"]) {
    if (epoch[c] === undefined) r.warn(`${label}: optional column "${c}" missing`);
    else checkColumn(epoch, c, n, r, label);
  }

  const featKeys = Object.keys(epoch.features ?? {});
  const shapKeys = Object.keys(epoch.shap ?? {});
  if (!sameList(featKeys, featureNames)) r.error(`${label}: features keys do not match the manifest feature order`);
  if (!sameList(shapKeys, featureNames)) r.error(`${label}: shap keys do not match the manifest feature order`);
  const okFeat = featureNames.every(
    (f) => isArrayLike(epoch.features?.[f]) && epoch.features[f].length === n && isArrayLike(epoch.shap?.[f]) && epoch.shap[f].length === n,
  );
  if (!okFeat) r.error(`${label}: some features/shap arrays are missing or have the wrong length`);
  if (!okCols) return;

  const bbox = manifest?.study_area?.bbox;
  let outside = 0;
  let badZone = 0;
  let badDistrict = 0;
  let missingObs = 0;
  const seen = new Set();
  let duplicates = 0;
  for (let i = 0; i < n; i += 1) {
    const lon = numOrNaN(epoch.lon[i]);
    const lat = numOrNaN(epoch.lat[i]);
    if (Array.isArray(bbox) && !(lon >= bbox[0] - 0.05 && lon <= bbox[2] + 0.05 && lat >= bbox[1] - 0.05 && lat <= bbox[3] + 0.05)) outside += 1;
    const z = numOrNaN(epoch.zone[i]);
    if (!(z >= -1 && z <= 3)) badZone += 1;
    const d = numOrNaN(epoch.district[i]);
    if (!(d >= -1 && d <= 24)) badDistrict += 1;
    if (!Number.isFinite(numOrNaN(epoch.lst_obs[i]))) missingObs += 1;
    const id = epoch.cell_id[i];
    if (seen.has(id)) duplicates += 1;
    else seen.add(id);
  }
  if (outside) r.warn(`${label}: ${outside} cells fall outside study_area.bbox`);
  if (badZone) r.error(`${label}: ${badZone} cells have a zone outside 0..3`);
  if (badDistrict) r.error(`${label}: ${badDistrict} cells have a district outside 0..24`);
  if (missingObs) r.warn(`${label}: ${missingObs} cells have no observed LST`);
  if (duplicates) r.error(`${label}: ${duplicates} duplicate cell_id values`);
  if (okFeat) validateWaterfall(epoch, featureNames, r, label);
}

// ---------------------------------------------------------------------------------------
// Model and smaller assets
// ---------------------------------------------------------------------------------------

function validateModel(model, featureNames, r) {
  if (!model) {
    r.warn("model_web.json not provided: scenario simulation is disabled");
    return;
  }
  if (model.format !== MODEL_FORMAT) r.error(`model: format must be "${MODEL_FORMAT}" (got ${JSON.stringify(model.format)})`);
  if (!Array.isArray(model.features) || !sameList(model.features, featureNames)) {
    r.error("model: features must equal the manifest feature order");
  }
  if (!Array.isArray(model.trees)) {
    r.error("model: trees array missing");
    return;
  }
  if (Number.isInteger(model.n_trees) && model.n_trees !== model.trees.length) {
    r.error(`model: n_trees=${model.n_trees} but ${model.trees.length} trees present`);
  }
  let compiled;
  try {
    compiled = compileModel(model);
  } catch (e) {
    r.error(`model: cannot compile (${e.message})`);
    return;
  }
  const rows = model.check?.rows;
  if (!Array.isArray(rows) || !rows.length) {
    r.warn("model: no check rows embedded; evaluator parity with Python is unverified");
    return;
  }
  const { n, maxAbsDiff, failures } = checkModelAgainstPython(compiled, model, MODEL_CHECK_TOLERANCE);
  if (failures) r.error(`model: ${failures}/${n} check rows differ from Python (max |Δ| ${maxAbsDiff.toExponential(2)})`);
}

function sameLengths(obj, keys) {
  const lengths = keys.map((k) => (isArrayLike(obj?.[k]) ? obj[k].length : -1));
  return lengths.every((l) => l >= 0 && l === lengths[0]);
}

function validateDependence(dependence, featureNames, r) {
  if (!dependence) {
    r.warn("dependence.json not provided");
    return;
  }
  const entries = Object.entries(dependence.features ?? {});
  if (!entries.length) r.error("dependence: no features");
  for (const [name, dep] of entries) {
    const label = `dependence.${name}`;
    if (!featureNames.includes(name)) r.error(`${label}: unknown feature`);
    if (!sameLengths(dep, ["bin_centers", "mean", "ci_lo", "ci_hi", "count"])) {
      r.error(`${label}: bin_centers/mean/ci_lo/ci_hi/count must be arrays of equal length`);
    }
    const sc = dep?.scatter;
    if (sc) {
      const keys = ["x", "shap", "color", "zone", "year"].filter((k) => sc[k] !== undefined);
      if (!sameLengths(sc, keys)) r.error(`${label}: scatter arrays differ in length`);
      if (sc.color_feature && !featureNames.includes(sc.color_feature)) r.warn(`${label}: unknown color_feature "${sc.color_feature}"`);
    } else r.warn(`${label}: no scatter sample`);
    const dir = dep?.threshold?.direction;
    if (dir !== undefined && dir !== null && !DIRECTIONS.has(dir)) r.error(`${label}: invalid threshold.direction "${dir}"`);
    validateThresholdIntervals(dep?.threshold, label, r);
  }
}

/** Soft checks of the threshold point estimates against their bootstrap intervals. */
function validateThresholdIntervals(threshold, label, r) {
  if (!threshold || typeof threshold !== "object") return;
  for (const key of THRESHOLD_KEYS) {
    const value = threshold[key];
    const ci = normalizeInterval(threshold[`${key}_ci`]);
    const hasValue = isFiniteNum(value);
    if (!hasValue && ci) r.warn(`${label}: ${key}_ci exported without a ${key} estimate (the UI hides it)`);
    if (hasValue && ci && intervalContains(value, ci) === false) {
      r.warn(`${label}: ${key} ${value} lies outside its interval [${ci[0]}, ${ci[1]}]`);
    }
    const support = threshold[`${key}_support`];
    if (support !== undefined && support !== null && !(isFiniteNum(support) && support >= 0 && support <= 1)) {
      r.warn(`${label}: ${key}_support must be a fraction in [0, 1] (got ${JSON.stringify(support)})`);
    }
  }
}

function validateZones(zones, r, manifest = null) {
  if (!zones) {
    r.warn("zones.json not provided");
    return;
  }
  const k = Number(zones.k);
  const metaByName = new Map((manifest?.features ?? []).map((f) => [f?.name, f]));
  if (!Array.isArray(zones.zones) || zones.zones.length !== k) r.error(`zones: expected ${zones.k} zone profiles`);
  (zones.zones ?? []).forEach((z, i) => {
    if (z?.id !== i) r.error(`zones: zones[${i}].id should be ${i}`);
    if (!Array.isArray(z?.recommendations)) {
      r.warn(`zones: zone ${i} has no recommendations array`);
      return;
    }
    z.recommendations.forEach((rec, j) => {
      const where = `zones: zone ${i} recommendation ${j} (${rec?.feature})`;
      const meta = metaByName.get(rec?.feature);
      if (metaByName.size && !meta) r.warn(`${where}: unknown feature`);
      else if (meta && meta.actionable === false) r.warn(`${where}: feature is not actionable`);
      const ci = normalizeInterval(rec?.ci);
      if (ci && intervalContains(rec?.expected_delta_c, ci) === false) {
        r.warn(`${where}: expected_delta_c ${rec.expected_delta_c} lies outside its interval [${ci[0]}, ${ci[1]}]`);
      }
    });
  });
  for (const [key, matrix] of Object.entries(zones.transitions ?? {})) {
    const square = Array.isArray(matrix) && matrix.length === k && matrix.every((row) => Array.isArray(row) && row.length === k);
    if (!square) r.error(`zones: transitions["${key}"] must be a ${k}x${k} matrix`);
  }
}

function validateMetrics(metrics, r) {
  if (!metrics) {
    r.warn("metrics.json not provided");
    return;
  }
  if (!Array.isArray(metrics.schemes) || !Array.isArray(metrics.models)) r.error("metrics: schemes/models arrays missing");
  if (!Array.isArray(metrics.summary) || !metrics.summary.length) r.error("metrics: summary is empty");
  const needed = ["scheme", "model", "r2_mean", "rmse_mean", "mae_mean"];
  (metrics.summary ?? []).forEach((row, i) => {
    const missing = needed.filter((key) => row?.[key] === undefined);
    if (missing.length) r.error(`metrics: summary[${i}] missing ${missing.join(", ")}`);
  });
  if (!Array.isArray(metrics.folds)) r.warn("metrics: folds missing");
  if (!Array.isArray(metrics.moran)) r.warn("metrics: moran missing");
}

function validateShapGlobal(shapGlobal, featureNames, r) {
  if (!shapGlobal) {
    r.warn("shap_global.json not provided");
    return;
  }
  if (!Array.isArray(shapGlobal.features) || !sameList(shapGlobal.features, featureNames)) {
    r.error("shap_global: features must equal the manifest feature order");
  }
  const K = featureNames.length;
  let shapeOk = true;
  for (const key of ["mean_abs", "ci_lo", "ci_hi"]) {
    if (!isArrayLike(shapGlobal.global?.[key]) || shapGlobal.global[key].length !== K) {
      r.error(`shap_global: global.${key} must have ${K} values`);
      shapeOk = false;
    }
  }
  if (!shapeOk) return;
  const { mean_abs: est, ci_lo: lo, ci_hi: hi } = shapGlobal.global;
  const outside = [];
  for (let i = 0; i < K; i += 1) {
    if (intervalContains(est[i], [lo[i], hi[i]]) === false) outside.push(featureNames[i] ?? `#${i}`);
  }
  if (outside.length) {
    r.warn(
      `shap_global: mean |SHAP| lies outside its bootstrap interval for ${outside.length} feature(s): ${outside.join(", ")}`,
    );
  }
}

function sameSquare(matrix, k) {
  return Array.isArray(matrix) && matrix.length === k && matrix.every((row) => isArrayLike(row) && row.length === k);
}

function validateInteractions(interactions, featureNames, r) {
  if (!interactions) {
    r.warn("interactions.json not provided");
    return;
  }
  const K = featureNames.length;
  if (!Array.isArray(interactions.features) || !sameList(interactions.features, featureNames)) {
    r.error("interactions: features must equal the manifest feature order");
  }
  if (!sameSquare(interactions.global, K)) r.error(`interactions: global must be a ${K}x${K} matrix`);
  for (const [zone, matrix] of Object.entries(interactions.by_zone ?? {})) {
    if (!sameSquare(matrix, K)) r.error(`interactions: by_zone["${zone}"] must be a ${K}x${K} matrix`);
  }
}

function validateCoupling(coupling, featureNames, r) {
  if (!coupling) {
    r.warn("scenario_coupling.json not provided: coupled scenarios keep spectral indices fixed");
    return;
  }
  const known = new Set(featureNames);
  const fractions = coupling.fraction_features;
  if (!Array.isArray(fractions) || !fractions.length) r.error("coupling: fraction_features missing");
  else {
    const unknown = fractions.filter((f) => !known.has(f));
    if (unknown.length) r.error(`coupling: unknown fraction feature(s) ${unknown.join(", ")}`);
  }
  const table = coupling.coupling;
  if (!table || typeof table !== "object") {
    r.error("coupling: coupling table missing");
    return;
  }
  for (const [fraction, slopes] of Object.entries(table)) {
    if (!known.has(fraction)) r.error(`coupling: unknown fraction "${fraction}"`);
    for (const [index, slope] of Object.entries(slopes ?? {})) {
      if (!known.has(index)) r.error(`coupling: ${fraction} -> unknown index "${index}"`);
      if (!isFiniteNum(slope)) r.error(`coupling: ${fraction} -> ${index} slope is not a finite number`);
    }
  }
}

function validateDistricts(districtsGeo, manifest, r) {
  if (!districtsGeo) {
    r.warn("districts.geojson not provided: district boundaries are not drawn");
    return;
  }
  if (districtsGeo.type !== "FeatureCollection" || !Array.isArray(districtsGeo.features)) {
    r.error("districts: must be a GeoJSON FeatureCollection");
    return;
  }
  const ids = new Set((manifest?.districts ?? []).map((d) => d?.id));
  let noGeometry = 0;
  let unknownIds = 0;
  for (const f of districtsGeo.features) {
    if (!f?.geometry || !["Polygon", "MultiPolygon"].includes(f.geometry.type)) noGeometry += 1;
    if (ids.size && !ids.has(f?.properties?.id)) unknownIds += 1;
  }
  if (noGeometry) r.error(`districts: ${noGeometry} feature(s) without a Polygon/MultiPolygon geometry`);
  if (unknownIds) r.warn(`districts: ${unknownIds} feature(s) with an id not listed in manifest.districts`);
}

/** Accept `epochs` as {year: epoch}, Map, or array of epochs. */
function epochEntries(epochs) {
  if (!epochs) return [];
  if (epochs instanceof Map) return [...epochs.entries()];
  if (Array.isArray(epochs)) return epochs.filter(Boolean).map((e) => [e.year, e]);
  return Object.entries(epochs).filter(([, e]) => e);
}

function checkEpochEntries(entries, manifest, featureNames, r) {
  const checked = [];
  for (const [year, epoch] of entries) {
    if (manifest?.epochs && !manifest.epochs.map(String).includes(String(year))) {
      r.error(`epoch ${year} is not listed in manifest.epochs`);
    }
    validateEpoch(epoch, year, manifest, featureNames, r);
    checked.push(Number(year));
  }
  return checked.sort((a, b) => a - b);
}

/**
 * Validate a web bundle against SPEC §4.
 * @param {{manifest: object, epochs?: object|Map|object[], model?: object|null, dependence?: object|null,
 *          zones?: object|null, metrics?: object|null, shapGlobal?: object|null, interactions?: object|null,
 *          coupling?: object|null, districts?: object|null}} bundle
 *   `model` is the RAW model_web.json; `districts` the districts GeoJSON. Only the epochs passed
 *   are checked (e.g. the loaded one); `interactions` / `coupling` / `districts` are checked
 *   only when the key is present in the argument (older callers omit them).
 * @returns {{ok: boolean, errors: string[], warnings: string[], epochsChecked: number[],
 *   waterfallSample: number}}
 */
export function validateBundle(bundle = {}) {
  const { manifest, epochs, model, dependence, zones, metrics, shapGlobal } = bundle;
  const r = createReport();
  const featureNames = validateManifest(manifest, r);
  const entries = epochEntries(epochs);
  if (!entries.length) r.warn("no epochs supplied for validation");
  const epochsChecked = checkEpochEntries(entries, manifest, featureNames, r);
  validateModel(model, featureNames, r);
  validateDependence(dependence, featureNames, r);
  validateZones(zones, r, manifest);
  validateMetrics(metrics, r);
  validateShapGlobal(shapGlobal, featureNames, r);
  if ("interactions" in bundle) validateInteractions(bundle.interactions, featureNames, r);
  if ("coupling" in bundle) validateCoupling(bundle.coupling, featureNames, r);
  if ("districts" in bundle) validateDistricts(bundle.districts, manifest, r);
  return {
    ok: r.errors.length === 0,
    errors: r.errors,
    warnings: r.warnings,
    epochsChecked,
    waterfallSample: WATERFALL_SAMPLE,
  };
}

/**
 * Validate only the given epochs (used for epochs loaded after the initial check); manifest
 * problems are not repeated.
 * @returns {{ok: boolean, errors: string[], warnings: string[], epochsChecked: number[]}}
 */
export function validateEpochs({ manifest, epochs } = {}) {
  const featureNames = validateManifest(manifest, createReport());
  const r = createReport();
  const epochsChecked = checkEpochEntries(epochEntries(epochs), manifest, featureNames, r);
  return { ok: r.errors.length === 0, errors: r.errors, warnings: r.warnings, epochsChecked };
}
