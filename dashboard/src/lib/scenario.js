/**
 * What-if scenario engine (SPEC §4.8 / §5.1).
 *
 * A scenario perturbs one feature by `delta` inside a region (all cells, some districts or
 * some governance zones) and re-predicts LST with the compiled web model.
 *
 * Land-cover fractions are compositional, so changing one must not create or destroy land:
 * adding Δ to a fraction subtracts Δ from the other land covers proportionally to their current
 * shares (sum preserved; everything clamped to [0, 1]; Δ is capped by the land available).
 * The donors are the other four model fractions PLUS the implicit "other vegetation" share
 * (grass / shrub / wetland, class 6) = 1 − Σ(five fractions), which has no model column. A
 * cell that is mostly shrubland can therefore be converted to tree cover, and the land comes
 * from shrub/grass in proportion to its share instead of only from water, crops or built-up.
 * In coupled mode the spectral indices follow the land-cover change through the partial
 * slopes exported in `scenario_coupling.json` (d index / d fraction from an OLS of each index
 * on all five fractions, other vegetation being the omitted reference class, so no slope is
 * needed for it): index += Σ_fraction slope × actual Δfraction, clamped to [-1, 1].
 * Landscape metrics and non-actionable features stay fixed.
 *
 * The requested Δ is not always what a cell receives (a cell with 0% tree cover cannot lose
 * 20 pp). The engine records the change actually applied per cell and reports the headline
 * statistics over the cells that really changed, alongside the region and applicable counts
 * and the mean applied change.
 *
 * Both the baseline and the scenario are predicted with the SAME compiled surrogate, so the
 * reported ΔLST is model-consistent (surrogate error cancels to first order). The baseline of
 * a whole epoch is computed once and cached; the scenario only re-evaluates the trees that
 * split on a changed feature when that is cheaper than a full pass.
 */

import { predictionToCelsius } from "./model.js";
import { quantileSorted } from "./data.js";

export const FRACTION_FEATURES = Object.freeze([
  "frac_impervious",
  "frac_forest",
  "frac_water",
  "frac_cropland",
  "frac_barren",
]);

const HISTOGRAM_BINS = 24;

/** Canonical districts (SPEC §1.1): id = index. Aliases are matched case/space-insensitively. */
export const CANONICAL_DISTRICTS = Object.freeze([
  { id: 0, name: "Delhi NCT", state: "Delhi", aliases: ["delhi", "nct of delhi", "new delhi", "delhi nct", "nct delhi"] },
  { id: 1, name: "Gurugram", state: "Haryana", aliases: ["gurgaon", "gurugram"] },
  { id: 2, name: "Faridabad", state: "Haryana", aliases: ["faridabad"] },
  { id: 3, name: "Palwal", state: "Haryana", aliases: ["palwal"] },
  { id: 4, name: "Nuh", state: "Haryana", aliases: ["mewat", "nuh"] },
  { id: 5, name: "Rewari", state: "Haryana", aliases: ["rewari"] },
  { id: 6, name: "Jhajjar", state: "Haryana", aliases: ["jhajjar"] },
  { id: 7, name: "Rohtak", state: "Haryana", aliases: ["rohtak"] },
  { id: 8, name: "Sonipat", state: "Haryana", aliases: ["sonipat", "sonepat"] },
  { id: 9, name: "Panipat", state: "Haryana", aliases: ["panipat"] },
  { id: 10, name: "Karnal", state: "Haryana", aliases: ["karnal"] },
  { id: 11, name: "Jind", state: "Haryana", aliases: ["jind"] },
  { id: 12, name: "Bhiwani", state: "Haryana", aliases: ["bhiwani"] },
  { id: 13, name: "Charkhi Dadri", state: "Haryana", aliases: ["charkhi dadri"] },
  { id: 14, name: "Mahendragarh", state: "Haryana", aliases: ["mahendragarh", "mahendergarh", "narnaul"] },
  { id: 15, name: "Meerut", state: "Uttar Pradesh", aliases: ["meerut"] },
  { id: 16, name: "Ghaziabad", state: "Uttar Pradesh", aliases: ["ghaziabad"] },
  {
    id: 17,
    name: "Gautam Buddh Nagar",
    state: "Uttar Pradesh",
    aliases: ["gautam buddha nagar", "gautam buddh nagar", "gautambudhnagar", "noida"],
  },
  { id: 18, name: "Bulandshahr", state: "Uttar Pradesh", aliases: ["bulandshahr", "bulandshahar"] },
  { id: 19, name: "Baghpat", state: "Uttar Pradesh", aliases: ["baghpat", "bagpat"] },
  { id: 20, name: "Hapur", state: "Uttar Pradesh", aliases: ["hapur", "panchsheel nagar"] },
  { id: 21, name: "Shamli", state: "Uttar Pradesh", aliases: ["shamli", "prabudh nagar"] },
  { id: 22, name: "Muzaffarnagar", state: "Uttar Pradesh", aliases: ["muzaffarnagar"] },
  { id: 23, name: "Alwar", state: "Rajasthan", aliases: ["alwar"] },
  { id: 24, name: "Bharatpur", state: "Rajasthan", aliases: ["bharatpur"] },
]);

/** Lower-case and drop everything that is not a letter or digit ("Gautam Buddh-Nagar" -> "gautambuddhnagar"). */
export function normalizeName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

const ALIAS_TO_ID = new Map(
  CANONICAL_DISTRICTS.flatMap((d) => [d.name, ...d.aliases].map((a) => [normalizeName(a), d.id])),
);

/**
 * Resolve a district display name or alias to its canonical id.
 * Matches the given `districts` list by name first, then the SPEC §1.1 alias table
 * ("Noida" -> 17, "Gurgaon"/"Gurugram" -> 1). Returns null when unknown or when the id is
 * absent from a non-empty `districts` list.
 */
export function findDistrictId(districts, aliasOrName) {
  const key = normalizeName(aliasOrName);
  if (!key) return null;
  const list = Array.isArray(districts) ? districts : [];
  const direct = list.find((d) => normalizeName(d.name) === key);
  if (direct) return direct.id;
  const id = ALIAS_TO_ID.get(key);
  if (id === undefined) return null;
  if (list.length && !list.some((d) => d.id === id)) return null;
  return id;
}

/**
 * Scenario presets. District ids are canonical (SPEC §1.1), resolved through the alias table
 * so the presets stay correct if the display names change.
 */
export const SCENARIO_PRESETS = Object.freeze([
  {
    id: "gurugram-canopy",
    label: "+20% tree canopy in Gurugram",
    description:
      "Convert 20% of each Gurugram cell to tree cover (taken proportionally from the other land covers), with NDVI/NDWI/NDBI following the land-cover change.",
    scenario: {
      feature: "frac_forest",
      delta: 0.2,
      region: { type: "district", ids: [findDistrictId(CANONICAL_DISTRICTS, "Gurugram")] },
      coupled: true,
    },
  },
  {
    id: "noida-sprawl",
    label: "+10% impervious surface in Noida",
    description:
      "Urban expansion stress test: 10% more built-up surface across Gautam Buddh Nagar (Noida), spectral indices coupled.",
    scenario: {
      feature: "frac_impervious",
      delta: 0.1,
      region: { type: "district", ids: [findDistrictId(CANONICAL_DISTRICTS, "Noida")] },
      coupled: true,
    },
  },
  {
    id: "riparian-restoration",
    label: "Wetland restoration: +5% open water",
    description:
      "Restore wetlands and water bodies: +5% water fraction in the most water-rich governance zone (picked from the zone profiles of this bundle, whatever its name).",
    scenario: {
      feature: "frac_water",
      delta: 0.05,
      // `pick` is resolved at runtime by resolvePresetScenario(); ids is the fallback.
      region: { type: "zone", ids: [1], pick: "max_water" },
      coupled: true,
    },
  },
  {
    id: "ncr-greening",
    label: "NCR-wide greening: +10% tree cover",
    description: "Region-wide afforestation programme adding 10% tree cover to every cell in the NCR.",
    scenario: {
      feature: "frac_forest",
      delta: 0.1,
      region: { type: "all", ids: [] },
      coupled: true,
    },
  },
  {
    id: "heat-core-cooling",
    label: "Cool the Heat Extreme Core: +15% trees",
    description: "Targeted urban forestry: +15% tree cover only inside Heat Extreme Core cells.",
    scenario: {
      feature: "frac_forest",
      delta: 0.15,
      region: { type: "zone", ids: [3] },
      coupled: true,
    },
  },
]);

/**
 * True when the manifest marks `feature` as a lever planners can move (SPEC §4.1
 * `features[].actionable`). NDWI / NDBI are spectral diagnostics (actionable = false): they
 * move only through land-cover change in the coupled mode. Without a manifest every model
 * feature is allowed (tests, partial bundles).
 */
export function isActionable(manifest, feature) {
  const list = manifest?.features;
  if (!Array.isArray(list) || !list.length) return true;
  return Boolean(list.find((f) => f?.name === feature)?.actionable);
}

/** Zone id with the largest mean water fraction (then most negative water SHAP), or null. */
export function mostWaterRichZone(zones) {
  const profiles = Array.isArray(zones?.zones) ? zones.zones : [];
  const byMean = profiles
    .filter((z) => Number.isInteger(z?.id) && Number.isFinite(z?.feature_means?.frac_water))
    .sort((a, b) => b.feature_means.frac_water - a.feature_means.frac_water || a.id - b.id);
  if (byMean.length) return byMean[0].id;
  const waterShap = (z) => (z?.shap_means?.frac_water ?? NaN) + (z?.shap_means?.ndwi ?? 0);
  const byShap = profiles
    .filter((z) => Number.isInteger(z?.id) && Number.isFinite(waterShap(z)))
    .sort((a, b) => waterShap(a) - waterShap(b) || a.id - b.id);
  return byShap.length ? byShap[0].id : null;
}

/**
 * The runnable scenario of a preset for this bundle: data-driven regions (`region.pick`) are
 * resolved from zones.json, and `pick` is dropped so the result is a plain scenario object.
 */
export function resolvePresetScenario(preset, { zones = null } = {}) {
  const scenario = preset?.scenario ?? preset;
  if (!scenario) return null;
  const { pick, ...region } = scenario.region ?? { type: "all", ids: [] };
  let ids = [...(region.ids ?? [])];
  if (pick === "max_water") {
    const id = mostWaterRichZone(zones);
    if (id !== null) ids = [id];
  }
  return { ...scenario, region: { ...region, ids } };
}

/**
 * Whether a "coupled indices" badge is honest for this scenario: only when the engine really
 * moved NDVI/NDWI/NDBI (`result.coupledApplied`). Without a result, only coupled scenarios on
 * a land-cover fraction qualify; a coupled flag on NDVI or a landscape metric never does.
 */
export function coupledBadgeVisible(scenario, result = null) {
  if (!scenario?.coupled) return false;
  if (typeof result?.coupledApplied === "boolean") return result.coupledApplied;
  return FRACTION_FEATURES.includes(scenario.feature);
}

/** Presets usable with this bundle: only actionable features, with resolved regions. */
export function presetsFor(manifest, zones = null) {
  return SCENARIO_PRESETS.filter((p) => isActionable(manifest, p.scenario.feature)).map((p) => ({
    ...p,
    scenario: resolvePresetScenario(p, { zones }),
  }));
}

// ---------------------------------------------------------------------------------------
// Pure per-cell transforms (exported for tests)
// ---------------------------------------------------------------------------------------

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Add `delta` to fraction `values[target]` and rebalance the others so the total is preserved.
 * `values` is mutated in place (NaN entries are treated as absent and left untouched).
 * @returns {number} the delta actually applied to the target (after capping/clamping)
 */
export function rebalanceFractions(values, target, delta) {
  const x = values[target];
  if (!Number.isFinite(x) || !Number.isFinite(delta) || delta === 0) return 0;
  let othersSum = 0;
  let othersCount = 0;
  for (let k = 0; k < values.length; k += 1) {
    if (k !== target && Number.isFinite(values[k])) {
      othersSum += values[k];
      othersCount += 1;
    }
  }
  // Positive changes are limited by free room (1 - x) and by the land the others can give up.
  const applied = delta > 0 ? Math.min(delta, 1 - x, othersSum) : Math.max(delta, -x);
  if (applied === 0 || (applied < 0 && othersCount === 0)) return 0;

  values[target] = clamp(x + applied, 0, 1);
  for (let k = 0; k < values.length; k += 1) {
    if (k === target || !Number.isFinite(values[k])) continue;
    const share = othersSum > 0 ? values[k] / othersSum : 1 / othersCount;
    values[k] = clamp(values[k] - applied * share, 0, 1);
  }
  return applied;
}

/**
 * Implicit "other vegetation" share of a cell (class 6: grass / shrub / wetland), i.e. what the
 * five model fractions leave of the cell. Missing fractions count as 0; never negative.
 */
export function otherVegetationShare(fractions) {
  let total = 0;
  for (let k = 0; k < fractions.length; k += 1) if (Number.isFinite(fractions[k])) total += fractions[k];
  return Math.max(0, 1 - total);
}

/**
 * Compositional change of one model fraction with other vegetation as an extra donor/recipient.
 * `fractions` (the five model fractions, NaN = missing) is NOT mutated.
 * @returns {{after: Float64Array, applied: number, otherBefore: number, otherAfter: number}}
 */
export function applyCompositionalChange(fractions, target, delta) {
  const n = fractions.length;
  const work = new Float64Array(n + 1);
  for (let k = 0; k < n; k += 1) work[k] = fractions[k];
  const otherBefore = otherVegetationShare(fractions);
  work[n] = otherBefore;
  const applied = rebalanceFractions(work, target, delta);
  return { after: work.subarray(0, n), applied, otherBefore, otherAfter: work[n] };
}

/** Physical bounds for a directly shifted (non-fraction) feature. */
function boundsFor(featureName, manifest) {
  const meta = manifest?.features?.find?.((f) => f.name === featureName);
  if (meta?.display === "percent" || featureName.startsWith("frac_")) return [0, 1];
  if (meta?.display === "index" || ["ndvi", "ndwi", "ndbi"].includes(featureName)) return [-1, 1];
  if (featureName === "lm_contag") return [0, 100];
  const min = meta?.stats?.min;
  return [Number.isFinite(min) && min >= 0 ? 0 : -Infinity, Infinity];
}

// ---------------------------------------------------------------------------------------
// Region selection & baseline cache
// ---------------------------------------------------------------------------------------

/** Row indices of the epoch inside the scenario region. */
export function selectRegion(epoch, region) {
  const type = region?.type ?? "all";
  const n = epoch.n;
  if (type === "all") return Int32Array.from({ length: n }, (_, i) => i);
  const column = type === "district" ? epoch.district : type === "zone" ? epoch.zone : null;
  if (!column) throw new Error(`runScenario: unknown region type "${type}"`);
  const wanted = new Set((region.ids ?? []).filter((id) => id !== null && id !== undefined).map(Number));
  const out = [];
  for (let i = 0; i < n; i += 1) if (wanted.has(column[i])) out.push(i);
  return Int32Array.from(out);
}

const baselineCache = new WeakMap();

/** Column getter over the epoch's features in model feature order (missing -> NaN). */
function epochColumns(epoch, model) {
  return model.features.map((name) => epoch.features?.[name] ?? null);
}

/**
 * Model predictions (target units) for every cell of `epoch`, cached per (epoch, model).
 * @returns {Float64Array}
 */
export function baselinePredictions(epoch, model) {
  let byModel = baselineCache.get(epoch);
  if (!byModel) {
    byModel = new WeakMap();
    baselineCache.set(epoch, byModel);
  }
  let pred = byModel.get(model);
  if (!pred) {
    const cols = epochColumns(epoch, model);
    const all = Int32Array.from({ length: epoch.n }, (_, i) => i);
    pred = model.predictMany((f, i) => (cols[f] ? cols[f][i] : NaN), all);
    byModel.set(model, pred);
  }
  return pred;
}

// ---------------------------------------------------------------------------------------
// Feature perturbation
// ---------------------------------------------------------------------------------------

/** Coupling slopes as [{fraction, index, slope}] restricted to known features. */
function couplingTerms(coupling, featureSet) {
  const table = coupling?.coupling ?? {};
  const terms = [];
  for (const [fraction, slopes] of Object.entries(table)) {
    if (!featureSet.has(fraction) || !slopes) continue;
    for (const [index, slope] of Object.entries(slopes)) {
      if (featureSet.has(index) && Number.isFinite(slope) && slope !== 0) terms.push({ fraction, index, slope });
    }
  }
  return terms;
}

/** |applied| below this counts as "no change" (float32 round-off of the stored columns). */
const APPLIED_EPS = 1e-6;

/**
 * Build perturbed copies of the changed feature columns.
 * @returns {{columns: Record<string, Float32Array>, applicable: Int32Array, applied: Float64Array,
 *   coupledApplied: boolean}}
 *   columns: full-length copies of every changed feature; applicable: region rows where the
 *   scenario feature is defined (rows with a missing value cannot be perturbed); applied: the
 *   change of the scenario feature actually applied to each applicable row (after capping by
 *   the land available and by the physical bounds); coupledApplied: spectral indices moved
 *   through the coupling table.
 */
function perturbFeatures({ epoch, model, manifest, coupling, scenario, indices }) {
  const featureSet = new Set(model.features);
  const { feature, coupled } = scenario;
  const delta = Number(scenario.delta);
  const source = epoch.features[feature];
  const fractionNames = (coupling?.fraction_features ?? FRACTION_FEATURES).filter(
    (f) => featureSet.has(f) && epoch.features[f],
  );
  const isFraction = fractionNames.includes(feature);

  const applicable = [];
  for (let j = 0; j < indices.length; j += 1) if (Number.isFinite(source[indices[j]])) applicable.push(indices[j]);
  const rows = Int32Array.from(applicable);
  const applied = new Float64Array(rows.length);
  const columns = {};

  if (!isFraction) {
    const [lo, hi] = boundsFor(feature, manifest);
    const col = Float32Array.from(source);
    for (let j = 0; j < rows.length; j += 1) {
      const next = clamp(source[rows[j]] + delta, lo, hi);
      col[rows[j]] = next;
      applied[j] = Math.fround(next) - source[rows[j]];
    }
    columns[feature] = col;
    return { columns, applicable: rows, applied, coupledApplied: false };
  }

  for (const f of fractionNames) columns[f] = Float32Array.from(epoch.features[f]);
  const terms = coupled ? couplingTerms(coupling, featureSet) : [];
  const indexNames = [...new Set(terms.map((t) => t.index))].filter((f) => epoch.features[f]);
  for (const f of indexNames) columns[f] = Float32Array.from(epoch.features[f]);

  const target = fractionNames.indexOf(feature);
  const before = new Float64Array(fractionNames.length);
  const shift = new Map(indexNames.map((f) => [f, 0]));
  const termK = terms.map((t) => fractionNames.indexOf(t.fraction));

  for (let j = 0; j < rows.length; j += 1) {
    const i = rows[j];
    for (let k = 0; k < fractionNames.length; k += 1) before[k] = epoch.features[fractionNames[k]][i];
    // Other vegetation (1 − Σ fractions) is a donor too; it has no column to write back.
    const change = applyCompositionalChange(before, target, delta);
    const after = change.after;
    applied[j] = change.applied;
    if (change.applied === 0) continue;
    for (let k = 0; k < fractionNames.length; k += 1) {
      if (Number.isFinite(after[k])) columns[fractionNames[k]][i] = after[k];
    }
    if (!terms.length) continue;
    for (const f of indexNames) shift.set(f, 0);
    for (let t = 0; t < terms.length; t += 1) {
      const k = termK[t];
      const dF = after[k] - before[k];
      if (Number.isFinite(dF) && dF !== 0) shift.set(terms[t].index, shift.get(terms[t].index) + terms[t].slope * dF);
    }
    for (const f of indexNames) {
      const old = epoch.features[f][i];
      if (Number.isFinite(old)) columns[f][i] = clamp(old + shift.get(f), -1, 1);
    }
  }
  return { columns, applicable: rows, applied, coupledApplied: indexNames.length > 0 };
}

// ---------------------------------------------------------------------------------------
// Summaries
// ---------------------------------------------------------------------------------------

function summarize(delta, baselineC, scenarioC, count, cellSizeM) {
  const areaKm2 = count * (cellSizeM / 1000) ** 2;
  if (count === 0) {
    return { count, areaKm2, mean: NaN, min: NaN, max: NaN, p10: NaN, p50: NaN, p90: NaN, baselineMeanC: NaN, scenarioMeanC: NaN };
  }
  let sum = 0;
  let sumBase = 0;
  let sumScen = 0;
  for (let j = 0; j < count; j += 1) {
    sum += delta[j];
    sumBase += baselineC[j];
    sumScen += scenarioC[j];
  }
  const sorted = Float64Array.from(delta).sort();
  return {
    count,
    areaKm2,
    mean: sum / count,
    min: sorted[0],
    max: sorted[count - 1],
    p10: quantileSorted(sorted, 0.1),
    p50: quantileSorted(sorted, 0.5),
    p90: quantileSorted(sorted, 0.9),
    baselineMeanC: sumBase / count,
    scenarioMeanC: sumScen / count,
  };
}

function histogram(delta, min, max, bins = HISTOGRAM_BINS) {
  if (!delta.length || !Number.isFinite(min) || !Number.isFinite(max)) return [];
  let lo = min;
  let hi = max;
  if (hi - lo < 1e-6) {
    lo -= 0.05;
    hi += 0.05;
  }
  const width = (hi - lo) / bins;
  const counts = new Int32Array(bins);
  for (let j = 0; j < delta.length; j += 1) {
    const b = Math.min(bins - 1, Math.max(0, Math.floor((delta[j] - lo) / width)));
    counts[b] += 1;
  }
  return Array.from(counts, (count, b) => ({ x0: lo + b * width, x1: lo + (b + 1) * width, count }));
}

function districtName(manifest, id) {
  return (
    manifest?.districts?.find?.((d) => d.id === id)?.name ?? CANONICAL_DISTRICTS[id]?.name ?? `District ${id}`
  );
}

/** Mean Δ per district, most cooling first. */
function aggregateByDistrict(epoch, indices, delta, manifest) {
  const sums = new Map();
  for (let j = 0; j < indices.length; j += 1) {
    const id = epoch.district[indices[j]];
    if (id < 0) continue;
    const entry = sums.get(id) ?? { sum: 0, count: 0 };
    entry.sum += delta[j];
    entry.count += 1;
    sums.set(id, entry);
  }
  return [...sums.entries()]
    .map(([id, { sum, count }]) => ({ id, name: districtName(manifest, id), count, mean: sum / count }))
    .sort((a, b) => a.mean - b.mean || a.id - b.id);
}

// ---------------------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------------------

/** Validate the scenario object; throws Error with a user-readable message. */
function checkScenario(scenario, model) {
  if (!scenario || typeof scenario !== "object") throw new Error("runScenario: scenario is missing");
  if (!model.features.includes(scenario.feature)) {
    throw new Error(`runScenario: feature "${scenario.feature}" is not a model feature`);
  }
  if (!Number.isFinite(Number(scenario.delta))) throw new Error(`runScenario: delta must be a finite number`);
}

/**
 * Run a what-if scenario on one epoch.
 * @param {{epoch: object, model: object, coupling: object|null, manifest: object|null,
 *          scenario: {feature: string, delta: number, region: {type: "all"|"district"|"zone", ids: number[]}, coupled: boolean}}} args
 * @returns {null | {indices: Int32Array, baseline: Float64Array, scenario: Float64Array, delta: Float64Array,
 *   applied: Float64Array, applicableIndices: Int32Array, stats: object, byDistrict: object[],
 *   histogram: object[], deltaByCell: Float32Array, changedFeatures: string[], regionCount: number,
 *   coupledApplied: boolean, epochYear: number}}
 *   `indices` / `baseline` / `scenario` / `delta` / `applied` cover the CHANGED cells (the
 *   requested change was at least partly applied); `baseline`/`scenario` are in °C.
 *   `deltaByCell` holds ΔLST for every applicable region cell (0 where nothing could change) and
 *   NaN elsewhere. `stats` summarises the changed cells and adds `changedCount`,
 *   `applicableCount`, `regionCount`, `requested`, `meanApplied`, `regionMean` (mean over all
 *   applicable cells, unchanged ones counted as 0) and `regionAreaKm2`.
 *   Null when the epoch or model is not available yet.
 */
export function runScenario({ epoch, model, coupling = null, manifest = null, scenario }) {
  if (!epoch || !model) return null;
  checkScenario(scenario, model);

  const regionRows = selectRegion(epoch, scenario.region);
  const {
    columns,
    applicable: indices,
    applied: appliedAll,
    coupledApplied,
  } = perturbFeatures({
    epoch,
    model,
    manifest,
    coupling,
    scenario,
    indices: regionRows,
  });
  const changedFeatures = Object.keys(columns);

  const original = epochColumns(epoch, model);
  const modified = model.features.map((name, f) => columns[name] ?? original[f]);
  const getOriginal = (f, i) => (original[f] ? original[f][i] : NaN);
  const getModified = (f, i) => (modified[f] ? modified[f][i] : NaN);

  const basePred = baselinePredictions(epoch, model);
  const count = indices.length;
  const scenPred = new Float64Array(count);

  // Differential evaluation: only trees splitting on a changed feature can change output.
  const changedIdx = changedFeatures.map((name) => model.features.indexOf(name));
  const affectedTrees = model.treesUsingFeatures(changedIdx);
  if (affectedTrees.length * 2 < model.nTrees) {
    const oldPart = model.predictTrees(getOriginal, indices, affectedTrees);
    const newPart = model.predictTrees(getModified, indices, affectedTrees);
    for (let j = 0; j < count; j += 1) scenPred[j] = basePred[indices[j]] - oldPart[j] + newPart[j];
  } else {
    scenPred.set(model.predictMany(getModified, indices));
  }

  const targetMode = model.targetMode ?? manifest?.target_mode ?? "anomaly";
  const baseline = new Float64Array(count);
  const scenarioC = new Float64Array(count);
  const delta = new Float64Array(count);
  const deltaByCell = new Float32Array(epoch.n).fill(NaN);
  for (let j = 0; j < count; j += 1) {
    baseline[j] = predictionToCelsius(basePred[indices[j]], targetMode, epoch.epoch_mean);
    scenarioC[j] = predictionToCelsius(scenPred[j], targetMode, epoch.epoch_mean);
    delta[j] = scenarioC[j] - baseline[j];
    deltaByCell[indices[j]] = delta[j];
  }

  // Headline statistics over the cells that actually changed (a −20 pp tree scenario cannot
  // touch a cell without trees; counting it would dilute the mean and inflate the area).
  const keep = [];
  let regionSum = 0;
  for (let j = 0; j < count; j += 1) {
    regionSum += delta[j];
    if (Math.abs(appliedAll[j]) > APPLIED_EPS) keep.push(j);
  }
  const m = keep.length;
  const changedIndices = new Int32Array(m);
  const cBase = new Float64Array(m);
  const cScen = new Float64Array(m);
  const cDelta = new Float64Array(m);
  const cApplied = new Float64Array(m);
  let appliedSum = 0;
  for (let k = 0; k < m; k += 1) {
    const j = keep[k];
    changedIndices[k] = indices[j];
    cBase[k] = baseline[j];
    cScen[k] = scenarioC[j];
    cDelta[k] = delta[j];
    cApplied[k] = appliedAll[j];
    appliedSum += appliedAll[j];
  }

  const cellSizeM = epoch.cell_size_m || 1000;
  const stats = {
    ...summarize(cDelta, cBase, cScen, m, cellSizeM),
    changedCount: m,
    applicableCount: count,
    regionCount: regionRows.length,
    requested: Number(scenario.delta),
    meanApplied: m ? appliedSum / m : NaN,
    regionMean: count ? regionSum / count : NaN,
    regionAreaKm2: count * (cellSizeM / 1000) ** 2,
  };
  return {
    indices: changedIndices,
    baseline: cBase,
    scenario: cScen,
    delta: cDelta,
    applied: cApplied,
    applicableIndices: indices,
    stats,
    byDistrict: aggregateByDistrict(epoch, changedIndices, cDelta, manifest),
    histogram: histogram(cDelta, stats.min, stats.max),
    deltaByCell,
    changedFeatures,
    regionCount: regionRows.length,
    coupledApplied: coupledApplied && m > 0,
    epochYear: Number(epoch.year),
  };
}
