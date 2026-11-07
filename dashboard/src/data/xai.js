/**
 * Explainability frames (SPEC §5.2): `xai_<year>_features.lstb.gz` (33 base features, int16 with
 * per-column scale/offset) and `xai_<year>_<mode>.lstb.gz` (18 grouped TreeSHAP columns at
 * 0.001 °C, pred/oof/obs at 0.01 °C absolute, resid = obs − oof; meta {year, mode, tier,
 * base_value_c, level, groups}).
 *
 * Additivity (validated): pred ≈ base_value_c + Σ group SHAP within 0.05 °C on non-NaN rows.
 *
 * The v1 facade needs the old epoch shape (`features[f]` and `shap[f]` keyed by the SAME names).
 * For v2, `v1EpochFromXai` keys both by SHAP GROUP id: `shap[g]` is the group SHAP and
 * `features[g]` the group's PRIMARY feature (e.g. built -> frac_built), which is exactly what the
 * v1 dependence / waterfall / SHAP-layer components plot. The full 33 base features stay
 * available on `epoch.baseFeatures`.
 */

import { decodeColumn, LstbError, requireColumn } from "./lstb.js";

export const WATERFALL_TOLERANCE_C = 0.05;
export const WATERFALL_SAMPLE = 500;

const isNum = Number.isFinite;

/** Evenly spaced sample of row indices. */
export function sampleRows(n, max = WATERFALL_SAMPLE) {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const step = n / max;
  return Array.from({ length: max }, (_, k) => Math.floor(k * step));
}

/**
 * Decode an XAI frame from its LSTB files.
 * @param {{shapFile: object, featuresFile?: object|null, groups?: string[]|null, year?: number, mode?: string}} input
 * @returns {Xai} {year, mode, n, tier, level, baseValueC, groups, shap{}, pred, oof, obs, resid,
 *                 features{}, featureNames, source: "v2"}
 */
export function xaiFromLstb({ shapFile, featuresFile = null, groups = null, year = null, mode = null }) {
  if (shapFile?.kind !== "xai") throw new LstbError(`expected an LSTB "xai" file, got kind ${JSON.stringify(shapFile?.kind)}`, "kind");
  const meta = shapFile.meta ?? {};
  const groupIds = (Array.isArray(meta.groups) && meta.groups.length ? meta.groups : groups ?? []).filter((g) => shapFile.columns[g]);
  if (!groupIds.length) throw new LstbError("xai file lists no SHAP group columns", "column");
  const n = Number(shapFile.n);
  const shap = {};
  for (const g of groupIds) shap[g] = decodeColumn(shapFile.columns[g]);
  const take = (name) => decodeColumn(requireColumn(shapFile, name));
  const xai = {
    source: "v2",
    year: Number(meta.year ?? year),
    mode: meta.mode ?? mode,
    n,
    tier: meta.tier ?? null,
    level: isNum(Number(meta.level)) ? Number(meta.level) : NaN,
    baseValueC: Number(meta.base_value_c),
    groups: groupIds,
    shap,
    pred: take("pred"),
    oof: shapFile.columns.oof ? take("oof") : new Float32Array(n).fill(NaN),
    obs: shapFile.columns.obs ? take("obs") : new Float32Array(n).fill(NaN),
    resid: shapFile.columns.resid ? take("resid") : new Float32Array(n).fill(NaN),
    features: {},
    featureNames: [],
  };
  if (featuresFile) {
    if (featuresFile.kind !== "features") throw new LstbError(`expected an LSTB "features" file, got kind ${JSON.stringify(featuresFile.kind)}`, "kind");
    if (Number(featuresFile.n) !== n) throw new LstbError(`features n=${featuresFile.n} != xai n=${n}`, "shape");
    for (const name of featuresFile.order) xai.features[name] = decodeColumn(featuresFile.columns[name]);
    xai.featureNames = featuresFile.order.slice();
  }
  return xai;
}

/**
 * SHAP additivity check on a sample: |pred − (base + Σ shap)| ≤ tol.
 * @returns {{checked:number, violations:number, worst:number, fraction:number}}
 */
export function waterfallCheck(xai, { sample = WATERFALL_SAMPLE, tol = WATERFALL_TOLERANCE_C } = {}) {
  let checked = 0;
  let violations = 0;
  let worst = 0;
  const base = Number(xai.baseValueC);
  if (!isNum(base)) return { checked: 0, violations: 0, worst: NaN, fraction: 0 };
  for (const i of sampleRows(xai.n, sample)) {
    const pred = xai.pred[i];
    if (!isNum(pred)) continue;
    let sum = base;
    let complete = true;
    for (const g of xai.groups) {
      const s = xai.shap[g][i];
      if (!isNum(s)) {
        complete = false;
        break;
      }
      sum += s;
    }
    if (!complete) continue;
    checked += 1;
    const err = Math.abs(pred - sum);
    worst = Math.max(worst, err);
    if (err > tol + 1e-9) violations += 1;
  }
  return { checked, violations, worst, fraction: checked ? violations / checked : 0 };
}

/** Per-cell waterfall (base → each group → prediction) for the inspector. */
export function cellWaterfall(xai, index) {
  if (!xai || index === null || index === undefined || index < 0 || index >= xai.n) return null;
  const contributions = xai.groups.map((g) => ({ group: g, value: xai.shap[g][index] }));
  return {
    base: xai.baseValueC,
    contributions,
    pred: xai.pred[index],
    obs: xai.obs[index],
    oof: xai.oof[index],
    resid: xai.resid[index],
  };
}

/**
 * v1 epoch (SPEC_v1 §4.2, already prepared by lib/data.prepareEpoch) -> Xai shape, each v1
 * feature being its own "group" (v1 had no grouping).
 */
export function xaiFromV1Epoch(epoch, manifest) {
  const names = (manifest?.features ?? []).map((f) => f.name).filter((f) => epoch.shap?.[f]);
  return {
    source: "v1",
    year: epoch.year,
    mode: "day",
    n: epoch.n,
    tier: "observed",
    level: epoch.epoch_mean,
    baseValueC: epoch.base_value_c,
    groups: names,
    shap: Object.fromEntries(names.map((f) => [f, epoch.shap[f]])),
    pred: epoch.lst_pred,
    oof: epoch.lst_pred_oof,
    obs: epoch.lst_obs,
    resid: epoch.resid_oof,
    features: Object.fromEntries(names.map((f) => [f, epoch.features[f]])),
    featureNames: names,
  };
}

/** Finite values of a column, sorted (typed-array sort: no boxed JS array of 55k numbers). */
function sortedFinite(arr, abs = false) {
  const out = new Float64Array(arr?.length ?? 0);
  let k = 0;
  for (let i = 0; i < out.length; i += 1) {
    const v = arr[i];
    if (isNum(v)) {
      out[k] = abs ? Math.abs(v) : v;
      k += 1;
    }
  }
  return out.subarray(0, k).sort();
}

export function finiteStats(arr) {
  const vals = sortedFinite(arr);
  const n = vals.length;
  const q = (p) => (n ? vals[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))] : NaN);
  let sum = 0;
  for (let i = 0; i < n; i += 1) sum += vals[i];
  return { min: n ? vals[0] : NaN, max: n ? vals[n - 1] : NaN, mean: n ? sum / n : NaN, p02: q(0.02), p98: q(0.98), count: n };
}

export function robustMaxAbs(arr) {
  const abs = sortedFinite(arr, true);
  if (!abs.length) return 1e-3;
  const p98 = abs[Math.min(abs.length - 1, Math.round(0.98 * (abs.length - 1)))];
  if (p98 > 0) return p98;
  return abs[abs.length - 1] > 0 ? abs[abs.length - 1] : 1e-3;
}

/** cell_id → row index, built once per cells object (shared by every epoch of a bundle). */
const cellIndexCache = new WeakMap();
function cellIndexOf(cells) {
  let index = cellIndexCache.get(cells);
  if (!index) {
    index = new Map();
    for (let i = 0; i < cells.n; i += 1) index.set(cells.cell_id[i], i);
    cellIndexCache.set(cells, index);
  }
  return index;
}

/** Object whose properties are computed on first read and then cached (enumerable getters). */
function lazyProps(spec) {
  const out = {};
  for (const [key, compute] of Object.entries(spec)) {
    let done = false;
    let value;
    Object.defineProperty(out, key, {
      enumerable: true,
      get() {
        if (!done) {
          value = compute();
          done = true;
        }
        return value;
      },
    });
  }
  return out;
}

/**
 * Build a v1-shaped epoch (lib/data.prepareEpoch output) from a v2 XAI frame, the canonical cells
 * and the zone ids, keyed by SHAP group (see the module note).
 * @param {Xai} xai
 * @param {{cells: Cells, groupsMeta: object[], zone?: Int8Array|null, cellSizeM?: number}} ctx
 */
export function v1EpochFromXai(xai, { cells, groupsMeta, zone = null, cellSizeM = 1000 }) {
  if (cells.n !== xai.n) throw new LstbError(`cells n=${cells.n} != xai n=${xai.n}`, "shape");
  const n = xai.n;
  const features = {};
  const shap = {};
  for (const g of xai.groups) {
    // Accept manifest groups ({id, primary}) and facade feature metas ({name, primary}).
    const meta = groupsMeta.find((m) => (m.id ?? m.name) === g);
    const primary = meta?.primary ?? meta?.members?.[0] ?? g;
    features[g] = xai.features[primary] ?? new Float32Array(n).fill(NaN);
    shap[g] = xai.shap[g];
  }
  // Built once per bundle; the statistics are LAZY (computed on first read): synthesising an
  // epoch during playback must not sort 55k-value columns on the main thread.
  const index = cellIndexOf(cells);
  const shapMaxAbs = lazyProps(Object.fromEntries(xai.groups.map((g) => [g, () => robustMaxAbs(shap[g])])));
  return {
    year: xai.year,
    mode: xai.mode,
    n,
    cell_size_m: cellSizeM,
    epoch_mean: xai.level,
    base_value_c: xai.baseValueC,
    cell_id: cells.cell_id,
    lon: cells.lon64,
    lat: cells.lat64,
    district: cells.district,
    zone: zone ?? new Int8Array(n).fill(-1),
    lst_obs: xai.obs,
    lst_pred: xai.pred,
    lst_pred_oof: xai.oof,
    resid_oof: xai.resid,
    features,
    shap,
    baseFeatures: xai.features,
    groups: xai.groups,
    tier: xai.tier,
    index,
    stats: lazyProps({
      lst_obs: () => finiteStats(xai.obs),
      lst_pred: () => finiteStats(xai.pred),
      resid_oof: () => finiteStats(xai.resid),
      shapMaxAbs: () => shapMaxAbs,
    }),
  };
}

/**
 * Feature-meta list the v1 components iterate (`manifest.features` in v1) for a v2 bundle: one
 * entry per SHAP group, described by its primary feature (unit, display, stats).
 */
export function groupFeatureMetas(manifest) {
  const byName = new Map((manifest?.features ?? []).map((f) => [f.name, f]));
  return (manifest?.groups ?? []).map((g) => {
    const primary = byName.get(g.primary) ?? {};
    return {
      ...primary,
      name: g.id,
      label: g.label ?? primary.label ?? g.id,
      group: g.family ?? primary.family ?? primary.group ?? null,
      family: g.family ?? primary.family ?? null,
      actionable: Boolean(g.actionable),
      primary: g.primary,
      members: Array.isArray(g.members) ? g.members.slice() : [g.primary],
      description: primary.description ?? g.label ?? g.id,
    };
  });
}
