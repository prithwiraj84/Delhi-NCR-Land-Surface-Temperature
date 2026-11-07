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
import {
  CANONICAL_DISTRICTS,
  DEFAULT_FOCAL_SPEC,
  FRACTION_FEATURES,
  FRACTION_FEATURES_V2,
  resolveFeatureName,
} from "./scenarioPresets.js";

// Vocabulary and presets live in scenarioPresets.js (kept out of the initial bundle's engine
// code); re-exported so every existing import from "./scenario.js" keeps working.
export * from "./scenarioPresets.js";

const HISTOGRAM_BINS = 24;

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
  if (meta?.display === "percent" || featureName.startsWith("frac_") || featureName === "albedo") return [0, 1];
  if (meta?.display === "index" || ["ndvi", "ndwi", "ndbi", "mndwi", "ndvi_spring"].includes(featureName)) return [-1, 1];
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

// ---------------------------------------------------------------------------------------
// v2: 47 features with browser-side focal recompute (SPEC §4.1, §4.4)
// ---------------------------------------------------------------------------------------
//
// A v2 model (`model_web_<mode>.json`) predicts from 33 base features plus 14 focal means
// (`<base>_m3`, `<base>_m15`: NaN-aware box means over 3×3 and 15×15 grid cells). The XAI
// feature files ship only the 33 base features, so the browser derives the focal columns
// itself from the canonical cell order and the grid geometry. A what-if then:
//   1. perturbs the base features inside the region (simplex rebalancing incl. other
//      vegetation, coupled spectral shifts — exactly the v1 rules, on v2 names);
//   2. recomputes the focal means of every changed base over the WHOLE grid, so a greener
//      district also cools its neighbours through `ndvi_m15` (spill-over up to 7 cells);
//   3. holds distances (dist_urban, dist_builtup, dist_water) fixed — recomputing an
//      Euclidean distance transform for a 20 pp change would move thresholds the model never
//      saw change, and SPEC §4.4 fixes them;
//   4. re-predicts every cell whose input changed and reports the region and the spill-over.
// Box means use summed-area tables (integral images) of value·mask and mask, so each window
// is O(1) per cell regardless of its size: out = Σ(x·m)/Σ(m) over the window clipped to the
// grid — identical to scipy `uniform_filter(x·m, mode="constant") / uniform_filter(m, ...)`.

/** Derived spectral feature recomputed from its parts after a perturbation. */
const NDVI_DROP = "ndvi_drop";

/**
 * Spill-over (D17, same definition as notebook section 08): ROI cells OUTSIDE the scenario region
 * whose model-input row changed by more than INPUT_REL_TOL · max(1, |x_old|) in any feature (a
 * NaN ↔ finite change counts). Their count is n_spill and the spill mean is the mean ΔLST over
 * them, zeros included. As a secondary figure the cells that move by more than SPILL_MOVE_C.
 */
const INPUT_REL_TOL = 1e-6;
const SPILL_MOVE_C = 1e-3;
/** |box mean| below this is snapped to exactly 0 (summed-area round-off in all-zero windows). */
const BOX_ZERO_EPS = 1e-9;

/**
 * Grid index of the canonical cells: pixel (row, col) of every cell and the cell of every
 * pixel (−1 outside the ROI).
 * @param {ArrayLike<number>} cellId canonical cell ids (row * width + col), ascending
 * @param {number} width grid width W; @param {number} [height] grid height H (inferred)
 * @returns {{width:number, height:number, n:number, pixel:Int32Array, cellOfPixel:Int32Array}}
 */
export function buildGridIndex(cellId, width, height = null) {
  const W = Number(width);
  if (!Number.isInteger(W) || W <= 0) throw new Error("buildGridIndex: the grid width is unknown (scenario_coupling.json grid.width)");
  const n = cellId?.length ?? 0;
  let maxRow = 0;
  for (let i = 0; i < n; i += 1) maxRow = Math.max(maxRow, Math.floor(cellId[i] / W));
  const declared = height === null || height === undefined ? null : Number(height);
  if (declared !== null && Number.isInteger(declared) && declared <= maxRow) {
    throw new Error(`buildGridIndex: cell ids reach row ${maxRow}, outside the declared ${W}×${declared} grid`);
  }
  const H = declared !== null && Number.isInteger(declared) ? declared : maxRow + 1;
  const pixel = new Int32Array(n);
  const cellOfPixel = new Int32Array(W * H).fill(-1);
  for (let i = 0; i < n; i += 1) {
    const id = cellId[i];
    if (!(id >= 0 && id < W * H)) throw new Error(`buildGridIndex: cell id ${id} lies outside the ${W}×${H} grid`);
    pixel[i] = id;
    cellOfPixel[id] = i;
  }
  return { width: W, height: H, n, pixel, cellOfPixel };
}

/**
 * NaN-aware box mean of a per-cell column over a `window`×`window` neighbourhood on the grid
 * (window clipped at the grid edge; cells outside the ROI and NaN values do not count).
 * Uses summed-area tables, O(W·H) for any window.
 * @param {ReturnType<typeof buildGridIndex>} grid
 * @param {ArrayLike<number>} values per-cell values (canonical order)
 * @param {number} window odd window size in cells (3, 15)
 * @param {Float32Array} [out]
 * @returns {Float32Array} per-cell box means (NaN where the window holds no valid value)
 */
export function boxMeanSat(grid, values, window, out = null) {
  const { width: W, height: H, n, pixel } = grid;
  const half = Math.floor(Number(window) / 2);
  if (!(half >= 0)) throw new Error(`boxMeanSat: invalid window ${window}`);
  const stride = W + 1;
  // Integral images with a zero first row/column: S[(r+1)*stride + (c+1)] = Σ over [0..r]×[0..c].
  const sum = new Float64Array(stride * (H + 1));
  const cnt = new Float64Array(stride * (H + 1));
  const px = new Float64Array(W * H);
  const pm = new Uint8Array(W * H);
  for (let i = 0; i < n; i += 1) {
    const v = values[i];
    if (Number.isFinite(v)) {
      px[pixel[i]] = v;
      pm[pixel[i]] = 1;
    }
  }
  for (let r = 0; r < H; r += 1) {
    let rowSum = 0;
    let rowCnt = 0;
    const base = (r + 1) * stride;
    const prev = r * stride;
    for (let c = 0; c < W; c += 1) {
      rowSum += px[r * W + c];
      rowCnt += pm[r * W + c];
      sum[base + c + 1] = sum[prev + c + 1] + rowSum;
      cnt[base + c + 1] = cnt[prev + c + 1] + rowCnt;
    }
  }
  const result = out ?? new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const r = Math.floor(pixel[i] / W);
    const c = pixel[i] - r * W;
    const r0 = Math.max(0, r - half);
    const r1 = Math.min(H - 1, r + half) + 1;
    const c0 = Math.max(0, c - half);
    const c1 = Math.min(W - 1, c + half) + 1;
    const k = cnt[r1 * stride + c1] - cnt[r0 * stride + c1] - cnt[r1 * stride + c0] + cnt[r0 * stride + c0];
    if (k < 0.5) {
      result[i] = NaN;
      continue;
    }
    const s = sum[r1 * stride + c1] - sum[r0 * stride + c1] - sum[r1 * stride + c0] + sum[r0 * stride + c0];
    const mean = s / k;
    // Integral-image subtraction leaves ~1e-17 residues in all-zero windows: snap them to 0 so an
    // unchanged neighbourhood compares equal (D17; the notebook does the same after uniform_filter).
    result[i] = Math.abs(mean) < BOX_ZERO_EPS ? 0 : mean;
  }
  return result;
}

/** Focal feature name of a base and window ("ndvi", 15 -> "ndvi_m15"). */
export const focalName = (base, window) => `${base}_m${window}`;

/** The FOCAL_SPEC of a bundle: model.focal -> coupling.focal -> SPEC default. */
export function focalSpecOf({ model = null, modelRaw = null, coupling = null } = {}) {
  const spec = model?.focal ?? modelRaw?.focal ?? coupling?.focal ?? null;
  const ok = spec && Array.isArray(spec.bases) && spec.bases.length && Array.isArray(spec.windows) && spec.windows.length;
  return ok ? { bases: spec.bases.map(String), windows: spec.windows.map(Number) } : DEFAULT_FOCAL_SPEC;
}

/**
 * Focal columns for the given bases (all bases of `spec` by default).
 * @returns {Record<string, Float32Array>} `<base>_m<w>` -> per-cell box means
 */
export function computeFocalColumns(grid, baseColumns, spec = DEFAULT_FOCAL_SPEC, bases = null) {
  const out = {};
  for (const base of bases ?? spec.bases) {
    const values = baseColumns[base];
    if (!values) continue;
    for (const w of spec.windows) out[focalName(base, w)] = boxMeanSat(grid, values, w);
  }
  return out;
}

/** True when the epoch carries v2 base features (facade epochs of schema 2.x bundles). */
export function isV2Epoch(epoch) {
  return Boolean(epoch?.baseFeatures && typeof epoch.baseFeatures === "object" && Object.keys(epoch.baseFeatures).length);
}

/** Grid width/height for the focal recompute: coupling.grid -> manifest grid -> epoch.grid. */
export function gridShapeOf({ coupling = null, manifest = null, epoch = null } = {}) {
  const candidates = [coupling?.grid, manifest?.grid, manifest?.study_area?.grid, epoch?.grid];
  for (const g of candidates) {
    const width = Number(g?.width);
    if (Number.isInteger(width) && width > 0) return { width, height: Number.isInteger(Number(g.height)) ? Number(g.height) : null };
  }
  return null;
}

const v2Cache = new WeakMap();

/**
 * Baseline model columns of a v2 epoch (base features + recomputed focal means), the grid
 * index and the FOCAL_SPEC — cached per epoch object and model.
 * @returns {{grid, spec, columns: Record<string, Float32Array>, modelColumns: (Float32Array|null)[]}}
 */
export function v2BaselineColumns(epoch, model, { coupling = null, manifest = null } = {}) {
  let byModel = v2Cache.get(epoch);
  if (!byModel) {
    byModel = new WeakMap();
    v2Cache.set(epoch, byModel);
  }
  const hit = byModel.get(model);
  if (hit) return hit;
  const shape = gridShapeOf({ coupling, manifest, epoch });
  if (!shape) throw new Error("runScenario: the v2 bundle declares no grid width (scenario_coupling.json grid), so focal features cannot be recomputed");
  if (!epoch.cell_id) throw new Error("runScenario: the v2 epoch has no cell ids (needed for the focal recompute)");
  const grid = buildGridIndex(epoch.cell_id, shape.width, shape.height);
  const spec = focalSpecOf({ model, coupling });
  const columns = { ...epoch.baseFeatures, ...computeFocalColumns(grid, epoch.baseFeatures, spec) };
  const modelColumns = model.features.map((name) => columns[name] ?? null);
  const entry = { grid, spec, columns, modelColumns };
  byModel.set(model, entry);
  return entry;
}

/** Baseline predictions of a v2 epoch on browser-derived focal features (cached). */
function v2BaselinePredictions(epoch, model, base) {
  if (!base.pred) {
    const all = Int32Array.from({ length: epoch.n }, (_, i) => i);
    base.pred = model.predictMany((f, i) => (base.modelColumns[f] ? base.modelColumns[f][i] : NaN), all);
  }
  return base.pred;
}

/** Fraction names of a v2 bundle (coupling list, else the v2 default) present in the columns. */
function v2FractionNames(coupling, columns) {
  const listed = Array.isArray(coupling?.fraction_features) ? coupling.fraction_features : FRACTION_FEATURES_V2;
  return listed.filter((f) => columns[f]);
}

/**
 * Perturb the base features of a v2 epoch (v1 rules on v2 names). After any NDVI shift the
 * spring NDVI follows by the same amount (the conversion changes the whole season's
 * greenness; no separate slope is exported) unless the coupling table carries its own
 * `ndvi_spring` slope, and the derived `ndvi_drop = ndvi_spring − ndvi` is recomputed.
 * @returns {{columns: Record<string, Float32Array>, applicable: Int32Array, applied: Float64Array, coupledApplied: boolean}}
 */
function perturbBaseV2({ base, manifest, coupling, scenario, indices }) {
  const cols = base.columns;
  const { feature, coupled } = scenario;
  const delta = Number(scenario.delta);
  const source = cols[feature];
  if (!source) throw new Error(`runScenario: feature "${feature}" is not a base feature of this bundle`);
  const fractionNames = v2FractionNames(coupling, cols);
  const isFraction = fractionNames.includes(feature);
  const applicable = [];
  for (let j = 0; j < indices.length; j += 1) if (Number.isFinite(source[indices[j]])) applicable.push(indices[j]);
  const rows = Int32Array.from(applicable);
  const applied = new Float64Array(rows.length);
  const columns = {};
  const ndviShift = new Float64Array(rows.length);
  let coupledApplied = false;

  if (!isFraction) {
    const [lo, hi] = boundsFor(feature, manifest);
    const col = Float32Array.from(source);
    for (let j = 0; j < rows.length; j += 1) {
      const next = clamp(source[rows[j]] + delta, lo, hi);
      col[rows[j]] = next;
      applied[j] = Math.fround(next) - source[rows[j]];
      if (feature === "ndvi") ndviShift[j] = applied[j];
    }
    columns[feature] = col;
  } else {
    for (const f of fractionNames) columns[f] = Float32Array.from(cols[f]);
    const featureSet = new Set(Object.keys(cols));
    const terms = coupled ? couplingTerms(coupling, featureSet) : [];
    const indexNames = [...new Set(terms.map((t) => t.index))];
    for (const f of indexNames) columns[f] = Float32Array.from(cols[f]);
    const target = fractionNames.indexOf(feature);
    const before = new Float64Array(fractionNames.length);
    const termK = terms.map((t) => fractionNames.indexOf(t.fraction));
    const shift = new Map(indexNames.map((f) => [f, 0]));
    for (let j = 0; j < rows.length; j += 1) {
      const i = rows[j];
      for (let k = 0; k < fractionNames.length; k += 1) before[k] = cols[fractionNames[k]][i];
      const change = applyCompositionalChange(before, target, delta);
      applied[j] = change.applied;
      if (change.applied === 0) continue;
      const after = change.after;
      for (let k = 0; k < fractionNames.length; k += 1) if (Number.isFinite(after[k])) columns[fractionNames[k]][i] = after[k];
      if (!terms.length) continue;
      for (const f of indexNames) shift.set(f, 0);
      for (let t = 0; t < terms.length; t += 1) {
        const k = termK[t];
        if (k < 0) continue;
        const dF = after[k] - before[k];
        if (Number.isFinite(dF) && dF !== 0) shift.set(terms[t].index, shift.get(terms[t].index) + terms[t].slope * dF);
      }
      for (const f of indexNames) {
        const old = cols[f][i];
        if (!Number.isFinite(old)) continue;
        const [lo, hi] = boundsFor(f, manifest);
        const next = clamp(old + shift.get(f), lo, hi);
        columns[f][i] = next;
        if (f === "ndvi") ndviShift[j] = Math.fround(next) - old;
        if (next !== old) coupledApplied = true;
      }
    }
  }

  // Spring NDVI follows season NDVI (unless coupled explicitly); ndvi_drop is derived.
  const springExplicit = Boolean(columns.ndvi_spring);
  const anyNdvi = ndviShift.some((v) => v !== 0);
  if (anyNdvi && cols.ndvi_spring && !springExplicit) {
    columns.ndvi_spring = Float32Array.from(cols.ndvi_spring);
    for (let j = 0; j < rows.length; j += 1) {
      const i = rows[j];
      if (ndviShift[j] !== 0 && Number.isFinite(cols.ndvi_spring[i])) columns.ndvi_spring[i] = clamp(cols.ndvi_spring[i] + ndviShift[j], -1, 1);
    }
  }
  if ((columns.ndvi || columns.ndvi_spring) && cols[NDVI_DROP]) {
    const spring = columns.ndvi_spring ?? cols.ndvi_spring;
    const ndvi = columns.ndvi ?? cols.ndvi;
    const drop = Float32Array.from(cols[NDVI_DROP]);
    for (let j = 0; j < rows.length; j += 1) {
      const i = rows[j];
      if (spring && Number.isFinite(spring[i]) && Number.isFinite(ndvi[i])) drop[i] = spring[i] - ndvi[i];
    }
    columns[NDVI_DROP] = drop;
  }
  return { columns, applicable: rows, applied, coupledApplied };
}

/**
 * Rows where any of the changed columns differs from its baseline by more than
 * INPUT_REL_TOL · max(1, |old|) (a NaN ↔ finite change counts; NaN = NaN is no change), D17.
 */
function changedRows(changed, baseline, n) {
  const mark = new Uint8Array(n);
  for (const [name, col] of Object.entries(changed)) {
    const old = baseline[name];
    if (!old) continue;
    for (let i = 0; i < n; i += 1) {
      const a = col[i];
      const b = old[i];
      const na = a !== a;
      const nb = b !== b;
      if (na || nb) {
        if (na !== nb) mark[i] = 1;
      } else if (Math.abs(a - b) > INPUT_REL_TOL * Math.max(1, Math.abs(b))) mark[i] = 1;
    }
  }
  const out = [];
  for (let i = 0; i < n; i += 1) if (mark[i]) out.push(i);
  return Int32Array.from(out);
}

/** {count, mean, min, max, areaKm2} of a set of deltas. */
function simpleStats(values, cellSizeM) {
  let sum = 0;
  let min = Infinity;
  let max = -Infinity;
  let count = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    sum += v;
    count += 1;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { count, mean: count ? sum / count : NaN, min: count ? min : NaN, max: count ? max : NaN, areaKm2: count * (cellSizeM / 1000) ** 2 };
}

/** v2 what-if (see the section note above); same result shape as v1 plus `spillover`/`focalRecomputed`. */
function runScenarioV2({ epoch, model, coupling, manifest, scenario }) {
  const base = v2BaselineColumns(epoch, model, { coupling, manifest });
  const regionRows = selectRegion(epoch, scenario.region);
  const { columns: changedBase, applicable: indices, applied: appliedAll, coupledApplied } = perturbBaseV2({
    base,
    manifest,
    coupling,
    scenario,
    indices: regionRows,
  });

  // Focal recompute for every changed base (whole grid: neighbours outside the region change too).
  const focalBases = base.spec.bases.filter((b) => changedBase[b]);
  const changedFocal = computeFocalColumns(base.grid, { ...base.columns, ...changedBase }, base.spec, focalBases);
  const changed = { ...changedBase, ...changedFocal };
  const modelChanged = Object.fromEntries(Object.entries(changed).filter(([name]) => model.features.includes(name)));
  const affected = changedRows(modelChanged, base.columns, epoch.n);

  const original = base.modelColumns;
  const modified = model.features.map((name, f) => modelChanged[name] ?? original[f]);
  const getOriginal = (f, i) => (original[f] ? original[f][i] : NaN);
  const getModified = (f, i) => (modified[f] ? modified[f][i] : NaN);
  const basePred = v2BaselinePredictions(epoch, model, base);
  const m = affected.length;
  const scenPred = new Float64Array(m);
  const changedIdx = Object.keys(modelChanged).map((name) => model.features.indexOf(name));
  const affectedTrees = model.treesUsingFeatures(changedIdx);
  if (m && affectedTrees.length * 2 < model.nTrees) {
    const oldPart = model.predictTrees(getOriginal, affected, affectedTrees);
    const newPart = model.predictTrees(getModified, affected, affectedTrees);
    for (let j = 0; j < m; j += 1) scenPred[j] = basePred[affected[j]] - oldPart[j] + newPart[j];
  } else if (m) {
    scenPred.set(model.predictMany(getModified, affected));
  }

  const targetMode = model.targetMode ?? manifest?.target_mode ?? "anomaly";
  const level = epoch.epoch_mean;
  const deltaOf = new Map();
  // Cells whose inputs did not change have ΔLST = 0 exactly (NaN only without a baseline prediction).
  const deltaByCell = new Float32Array(epoch.n);
  for (let i = 0; i < epoch.n; i += 1) deltaByCell[i] = Number.isFinite(basePred[i]) ? 0 : NaN;
  for (let j = 0; j < m; j += 1) {
    const i = affected[j];
    const d = predictionToCelsius(scenPred[j], targetMode, level) - predictionToCelsius(basePred[i], targetMode, level);
    deltaOf.set(i, d);
    deltaByCell[i] = d;
  }

  // Changed cells: region cells where the requested change (partly) applied.
  const keep = [];
  let regionSum = 0;
  for (let j = 0; j < indices.length; j += 1) {
    const i = indices[j];
    const d = deltaOf.get(i) ?? 0;
    if (!deltaOf.has(i)) deltaByCell[i] = 0;
    regionSum += d;
    if (Math.abs(appliedAll[j]) > APPLIED_EPS) keep.push(j);
  }
  const k = keep.length;
  const changedIndices = new Int32Array(k);
  const cBase = new Float64Array(k);
  const cScen = new Float64Array(k);
  const cDelta = new Float64Array(k);
  const cApplied = new Float64Array(k);
  const inChanged = new Uint8Array(epoch.n);
  let appliedSum = 0;
  for (let q = 0; q < k; q += 1) {
    const j = keep[q];
    const i = indices[j];
    const d = deltaOf.get(i) ?? 0;
    changedIndices[q] = i;
    cBase[q] = predictionToCelsius(basePred[i], targetMode, level);
    cScen[q] = cBase[q] + d;
    cDelta[q] = d;
    cApplied[q] = appliedAll[j];
    appliedSum += appliedAll[j];
    inChanged[i] = 1;
  }

  // Spill-over (D17): cells OUTSIDE the scenario region whose model inputs changed (through the
  // recomputed focal means); the mean includes the cells whose prediction did not move (zeros).
  const inRegion = new Uint8Array(epoch.n);
  for (let j = 0; j < regionRows.length; j += 1) inRegion[regionRows[j]] = 1;
  const spillValues = [];
  const spillIndices = [];
  let moved = 0;
  let inputsOnly = 0;
  let otherSum = 0;
  for (let j = 0; j < m; j += 1) {
    const i = affected[j];
    if (inChanged[i]) continue;
    const d = deltaOf.get(i) ?? 0;
    otherSum += Number.isFinite(d) ? d : 0;
    if (inRegion[i]) continue;
    spillIndices.push(i);
    spillValues.push(Number.isFinite(d) ? d : 0);
    if (Math.abs(d) > SPILL_MOVE_C) moved += 1;
    else inputsOnly += 1;
  }
  const cellSizeM = epoch.cell_size_m || 1000;
  const spill = { ...simpleStats(spillValues, cellSizeM), movedCount: moved, moveThresholdC: SPILL_MOVE_C, definition: "cells outside the region whose neighbourhood inputs changed" };
  const totalSum = cDelta.reduce((a, b) => a + b, 0) + otherSum;
  const stats = {
    ...summarize(cDelta, cBase, cScen, k, cellSizeM),
    changedCount: k,
    applicableCount: indices.length,
    regionCount: regionRows.length,
    requested: Number(scenario.delta),
    meanApplied: k ? appliedSum / k : NaN,
    regionMean: indices.length ? regionSum / indices.length : NaN,
    regionAreaKm2: indices.length * (cellSizeM / 1000) ** 2,
    /** Cells whose model inputs changed (region + focal neighbourhood). */
    affectedCount: m,
    /** Spill-over cells (outside the region, inputs changed) that move by ≤ 0.001 °C. */
    inputsOnlyCount: inputsOnly,
    /** Spill-over cells that move by more than 0.001 °C. */
    spillMovedCount: moved,
    /** Σ ΔLST × cell area over every affected cell (°C·km²): the area-integrated effect. */
    integratedCKm2: totalSum * (cellSizeM / 1000) ** 2,
  };
  const allIdx = Int32Array.from([...changedIndices, ...spillIndices]);
  const allDelta = Float64Array.from([...cDelta, ...spillValues]);
  return {
    indices: changedIndices,
    baseline: cBase,
    scenario: cScen,
    delta: cDelta,
    applied: cApplied,
    applicableIndices: indices,
    stats,
    byDistrict: aggregateByDistrict(epoch, allIdx, allDelta, manifest),
    histogram: histogram(cDelta, stats.min, stats.max),
    deltaByCell,
    changedFeatures: Object.keys(changed),
    focalRecomputed: Object.keys(changedFocal),
    spillover: { ...spill, indices: Int32Array.from(spillIndices) },
    regionCount: regionRows.length,
    coupledApplied: coupledApplied && k > 0,
    epochYear: Number(epoch.year),
    engine: "v2-focal",
  };
}

/**
 * Run a what-if scenario on one epoch.
 * v1 epochs (17 features, no focal terms) run the original engine; v2 epochs (`baseFeatures`)
 * run the focal-recompute engine above. The scenario's feature may use either generation's
 * name (frac_impervious / frac_built); it is resolved against the model's features.
 * @param {{epoch: object, model: object, coupling: object|null, manifest: object|null,
 *          scenario: {feature: string, delta: number, region: {type: "all"|"district"|"zone", ids: number[]}, coupled: boolean}}} args
 * @returns {null | {indices: Int32Array, baseline: Float64Array, scenario: Float64Array, delta: Float64Array,
 *   applied: Float64Array, applicableIndices: Int32Array, stats: object, byDistrict: object[],
 *   histogram: object[], deltaByCell: Float32Array, changedFeatures: string[], regionCount: number,
 *   coupledApplied: boolean, epochYear: number}}
 *   `indices` / `baseline` / `scenario` / `delta` / `applied` cover the CHANGED cells (the
 *   requested change was at least partly applied); `baseline`/`scenario` are in °C.
 *   `deltaByCell` holds ΔLST for every applicable region cell (0 where nothing could change); v1
 *   bundles leave every other cell NaN, while v2 bundles (focal recompute) also give the spill-over
 *   cells their Δ and every other ROI cell with a baseline prediction an exact 0 (its inputs did
 *   not change, so its prediction cannot), NaN only without a baseline prediction — the what-if
 *   map shows the whole ROI, neutral where the scenario does not reach. `stats` summarises the changed cells and adds `changedCount`,
 *   `applicableCount`, `regionCount`, `requested`, `meanApplied`, `regionMean` (mean over all
 *   applicable cells, unchanged ones counted as 0) and `regionAreaKm2`.
 *   Null when the epoch or model is not available yet.
 */
export function runScenario({ epoch, model, coupling = null, manifest = null, scenario }) {
  if (!epoch || !model) return null;
  if (scenario && typeof scenario === "object" && scenario.feature) {
    const feature = resolveFeatureName(scenario.feature, { modelFeatures: model.features });
    if (feature !== scenario.feature) scenario = { ...scenario, feature };
  }
  checkScenario(scenario, model);
  if (isV2Epoch(epoch)) return runScenarioV2({ epoch, model, coupling, manifest, scenario });

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
