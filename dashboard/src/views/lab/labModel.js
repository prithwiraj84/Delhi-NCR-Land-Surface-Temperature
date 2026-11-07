/**
 * Pure derivations for Model Lab (UI_SPEC §3.8) over metrics.json (SPEC §5.6) and the
 * timeline series. v1 bundles (schema 1.x: schemes random / spatial / temporal, mean-of-folds
 * R²) are mapped explicitly and labelled as such — they are never presented as pooled
 * block20 / LOEO numbers.
 *
 * Accuracy semantics
 *   pooled R² = 1 − ΣSSE/ΣSST over ALL out-of-fold rows (SPEC §4.2): one number for the whole
 *     held-out set; the per-fold spread is shown separately.
 *   mean-of-folds R² (v1) averages per-fold R²; folds with little variance (one cool north-east
 *     block) drag it down, so it is not comparable with pooled R².
 *   block20 = 20 km spatial blocks (skill in unseen places, the honest headline);
 *   loeo = leave-one-epoch-out, recentred (skill at transferring the spatial pattern in time);
 *   random K-fold = optimistic upper bound (neighbours leak between train and test).
 */

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const num = (v) => (v === null || v === undefined || v === "" ? null : isNum(Number(v)) ? Number(v) : null);

/** Uncertainty-budget component keys (fixed order = colour order). */
export const BUDGET_KEYS = Object.freeze(["gcm", "sensitivity", "land", "model"]);

/** Normalised component shares of one budget entry (sum 1), or null. */
export function budgetShares(entry) {
  if (!entry) return null;
  const vals = BUDGET_KEYS.map((k) => Math.max(0, Number(entry[k]) || 0));
  const total = vals.reduce((a, b) => a + b, 0);
  return total > 0 ? vals.map((v) => v / total) : null;
}

/** Scheme vocabulary (v2 SPEC §4.2 + v1). */
export const SCHEMES = Object.freeze({
  block20: { label: "Spatial 20 km blocks", short: "block20", kind: "spatial", headline: true, note: "Pooled out-of-fold over 20 km blocks: skill in unseen areas." },
  block5: { label: "Spatial 5×5 blocks (v1-comparable)", short: "block5", kind: "spatial", note: "The v1 blocking, scored pooled." },
  district: { label: "Leave-one-district-out", short: "district", kind: "spatial", note: "Whole districts held out." },
  loeo: { label: "Leave-one-epoch-out (recentred)", short: "LOEO", kind: "temporal", headline: true, note: "Transfer of the spatial pattern to an unseen frame." },
  place_time: { label: "Unseen place + time", short: "place+time", kind: "temporal", note: "Train on earlier frames and other folds, test the last frame in the held-out fold." },
  spatial: { label: "Spatial 5×5 blocks (v1, mean of folds)", short: "spatial (v1)", kind: "spatial", note: "v1 metric: mean of per-fold R²." },
  temporal: { label: "Temporal hold-out (v1, last epoch)", short: "temporal (v1)", kind: "temporal", note: "v1: trained on earlier epochs, tested on the last one." },
  // Random K-fold last: it is the optimistic upper bound, never a headline.
  random: { label: "Random K-fold", short: "random", kind: "optimistic", note: "Optimistic upper bound: neighbouring cells leak between train and test." },
});

export const schemeInfo = (id) => SCHEMES[id] ?? { label: id, short: id, kind: "other", note: "" };

/** Per-mode slice of metrics.json (v2 `{modes}`; v1 bundles are wrapped as `{modes: {day}}`). */
export function metricsSlice(metrics, mode) {
  if (!metrics) return null;
  if (metrics.modes) return metrics.modes[mode] ?? null;
  return mode === "day" ? metrics : null;
}

/** True when a slice uses the v1 metric vocabulary (mean-of-folds, random/spatial/temporal). */
export function isV1Slice(slice) {
  const rows = Array.isArray(slice?.summary) ? slice.summary : [];
  if (rows.some((r) => "r2_pooled" in r)) return false;
  return rows.some((r) => "r2_mean" in r) || (slice?.schemes ?? []).includes("spatial");
}

/** Summary row of scheme × model with normalised fields (pooled + fold mean/sd). */
export function summaryRow(slice, scheme, model) {
  const r = (slice?.summary ?? []).find((x) => x?.scheme === scheme && x?.model === model);
  if (!r) return null;
  const v1 = !("r2_pooled" in r);
  return {
    scheme,
    model,
    pooled: !v1,
    r2: num(v1 ? r.r2_mean : r.r2_pooled),
    rmse: num(v1 ? r.rmse_mean : r.rmse_pooled),
    mae: num(v1 ? r.mae_mean : r.mae_pooled),
    r2FoldMean: num(v1 ? r.r2_mean : r.r2_fold_mean),
    r2FoldSd: num(v1 ? r.r2_std : r.r2_fold_sd),
    rmseFoldMean: num(v1 ? r.rmse_mean : r.rmse_fold_mean),
    rmseFoldSd: num(v1 ? r.rmse_std : r.rmse_fold_sd),
    nFolds: num(r.n_folds),
    n: num(r.n),
  };
}

/** Best row (by R²) of a scheme. */
export function bestOfScheme(slice, scheme) {
  const models = [...new Set((slice?.summary ?? []).filter((r) => r?.scheme === scheme).map((r) => r.model))];
  return models.map((m) => summaryRow(slice, scheme, m)).filter((r) => r && isNum(r.r2)).sort((a, b) => b.r2 - a.r2)[0] ?? null;
}

/**
 * Headline skill of one mode.
 * v2: metrics.headline (block20 + LOEO, xgboost) with the fold spread from the summary, random
 * CV of the same model as the optimistic bound. v1: the spatial and temporal rows of XGBoost
 * (else the best model), explicitly labelled mean-of-folds.
 * @returns {{mode, v1: boolean, spatial, temporal, random, comparison}|null}
 */
export function honestSkill(metrics, mode) {
  const slice = metricsSlice(metrics, mode);
  if (!slice) return null;
  if (isV1Slice(slice)) {
    const pick = (scheme) => summaryRow(slice, scheme, "xgboost") ?? bestOfScheme(slice, scheme);
    return {
      mode,
      v1: true,
      spatial: pick("spatial") ? { ...pick("spatial"), label: SCHEMES.spatial.label } : null,
      temporal: pick("temporal") ? { ...pick("temporal"), label: SCHEMES.temporal.label } : null,
      random: pick("random") ? { ...pick("random"), label: SCHEMES.random.label } : null,
      comparison: null,
    };
  }
  const h = slice.headline ?? {};
  const withSpread = (entry, scheme) => {
    const model = entry?.model ?? "xgboost";
    const row = summaryRow(slice, entry?.scheme ?? scheme, model);
    const r2 = num(entry?.r2) ?? row?.r2 ?? null;
    if (r2 === null) return null;
    return { ...(row ?? {}), scheme: entry?.scheme ?? scheme, model, r2, rmse: num(entry?.rmse) ?? row?.rmse ?? null, pooled: true, label: schemeInfo(entry?.scheme ?? scheme).label };
  };
  const spatial = withSpread(h.spatial, "block20");
  const temporal = withSpread(h.temporal, "loeo");
  const randomRow = summaryRow(slice, "random", spatial?.model ?? "xgboost") ?? bestOfScheme(slice, "random");
  return { mode, v1: false, spatial, temporal, random: randomRow ? { ...randomRow, label: SCHEMES.random.label } : null, comparison: slice.v1_comparison ?? null };
}

/**
 * Scoreboard: models × schemes (rows = models, columns = schemes) with pooled R²/RMSE and the
 * per-fold R² values for the strip.
 * @returns {{schemes: string[], models: string[], cells: Record<string, {r2, rmse, folds: number[], pooled}>}}
 */
export function scoreboard(slice) {
  const summary = Array.isArray(slice?.summary) ? slice.summary : [];
  const order = Object.keys(SCHEMES);
  const schemes = [...new Set([...(slice?.schemes ?? []), ...summary.map((r) => r.scheme)])].filter(Boolean).sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
  const models = [...new Set([...(slice?.models ?? []), ...summary.map((r) => r.model)])].filter(Boolean);
  const cells = {};
  for (const s of schemes) {
    for (const m of models) {
      const row = summaryRow(slice, s, m);
      if (!row) continue;
      const folds = (slice?.folds ?? []).filter((f) => f.scheme === s && f.model === m && isNum(Number(f.r2))).map((f) => Number(f.r2));
      cells[`${s}|${m}`] = { r2: row.r2, rmse: row.rmse, folds, pooled: row.pooled, sd: row.r2FoldSd };
    }
  }
  return { schemes, models, cells };
}

/** Error vs distance-to-training bins (block20 xgboost OOF). */
export function errorDistanceRows(slice) {
  return (Array.isArray(slice?.error_vs_distance) ? slice.error_vs_distance : [])
    .map((b) => ({ lo: num(b.lo), hi: num(b.hi), rmse: num(b.rmse), n: num(b.n) }))
    .filter((b) => b.lo !== null && b.rmse !== null)
    .map((b) => ({ ...b, id: `${b.lo}`, label: b.hi === null ? `≥ ${b.lo} km` : `${b.lo}–${b.hi} km` }));
}

/** Block-size curve rows ({block_km|"random", r2, rmse}). */
export function blockSizeRows(slice) {
  // A "random" row (no block_km, label "random") is the optimistic upper bound, kept and labelled.
  return (Array.isArray(slice?.block_size_curve) ? slice.block_size_curve : []).map((r) => ({
    id: String(r.block_km ?? r.label),
    block: r.block_km ?? (r.label === "random" ? "random" : null),
    random: r.block_km === undefined || r.block_km === null ? r.label === "random" : false,
    r2: num(r.r2_pooled),
    rmse: num(r.rmse_pooled),
  }));
}

/**
 * Fold map grid of one scheme: blocks in row-major order from the grid's top-left.
 * @returns {{rows: number, cols: number, blockKm: number|null, cells: {r, c, fold: number|null, rmse: number|null}[], worst: object|null}|null}
 */
export function foldMap(slice, scheme = "block20") {
  const g = slice?.fold_geometry?.[scheme];
  const R = num(g?.n_rows);
  const C = num(g?.n_cols);
  if (!R || !C || !Array.isArray(g.fold_of_block)) return null;
  const cells = [];
  for (let r = 0; r < R; r += 1) {
    for (let c = 0; c < C; c += 1) {
      const k = r * C + c;
      const fold = num(g.fold_of_block[k]);
      cells.push({ r, c, fold: fold !== null && fold >= 0 ? fold : null, rmse: num(g.rmse_of_block?.[k]) });
    }
  }
  const scored = cells.filter((x) => x.rmse !== null);
  const worst = scored.sort((a, b) => b.rmse - a.rmse)[0] ?? null;
  return { rows: R, cols: C, blockKm: num(g.block_km), cells: cells.sort((a, b) => a.r - b.r || a.c - b.c), worst };
}

/** LOEO rows (raw vs recentred). */
export function loeoRows(slice) {
  return (Array.isArray(slice?.loeo) ? slice.loeo : []).map((r) => ({ id: String(r.held_out), year: num(r.held_out), r2Raw: num(r.r2_raw), r2: num(r.r2_recentred), rmse: num(r.rmse_recentred), biasRaw: num(r.bias_raw) }));
}

/** AOA summary: threshold, % inside per frame, RMSE by DI decile. */
export function aoaSummary(slice) {
  const a = slice?.aoa;
  if (!a) return null;
  const pct = Object.entries(a.pct_inside ?? {})
    .map(([y, v]) => ({ id: y, year: Number(y), pct: num(v) }))
    .filter((r) => Number.isInteger(r.year) && r.pct !== null)
    .sort((x, y) => x.year - y.year);
  const deciles = (Array.isArray(a.rmse_by_di_decile) ? a.rmse_by_di_decile : []).map((v, i) => ({ id: String(i + 1), decile: i + 1, rmse: num(v) }));
  return { threshold: num(a.di_threshold), pct, deciles };
}

/** Downscaling metrics (SPEC §5.6 `downscaling`). */
export function downscalingSummary(metrics) {
  const d = metrics?.downscaling;
  if (!d) return null;
  const si = d.night?.scale_invariance ?? null;
  const demo = d.day_demo ?? null;
  return {
    // Fine-grid resolution of the "250 m" layer (500 m on the 2 km smoke grid): labels follow the bundle.
    fineResM: num(d.fine_res_m),
    night: si ? { r2: num(si.r2), rmse: num(si.rmse), bias: num(si.bias), bilinear: num(si.bilinear_rmse), coarseM: num(si.coarse_res_m), fineM: num(si.fine_res_m) } : null,
    byLc: (Array.isArray(d.night?.by_lc) ? d.night.by_lc : []).map((r) => ({ id: String(r.class), cls: r.class, r2: num(r.r2), rmse: num(r.rmse), n: num(r.n) })),
    day: demo ? { r2: num(demo.r2), rmse: num(demo.rmse), bilinear: num(demo.bilinear_rmse), years: Array.isArray(demo.years) ? demo.years : [] } : null,
  };
}

/** Skill gain over a baseline RMSE (1 − rmse / baseline), e.g. vs bilinear or persistence. */
export function skillGain(rmse, baseline) {
  return isNum(rmse) && isNum(baseline) && baseline > 0 ? 1 - rmse / baseline : null;
}

/** v1 → v2 comparison rows (constants from the real v1 run, SPEC §4.2). */
export function v1Comparison(comparison) {
  if (!comparison) return null;
  const pair = (v) => (Array.isArray(v) && v.length === 2 && v.every((x) => isNum(Number(x))) ? [Number(v[0]), Number(v[1])] : null);
  return {
    metric: comparison.v1_metric ?? "mean of per-fold R² (5×5)",
    xgb: pair(comparison.v1_xgb),
    gnn: pair(comparison.v1_gnn),
    block5Pooled: num(comparison.v2_block5_pooled),
    block5FoldMean: num(comparison.v2_block5_fold_mean),
    block20Pooled: num(comparison.v2_block20_pooled),
    label: comparison.label ?? null,
  };
}

/** Panel metrics in the v1 shape the reused performance components read (MoranPanel, HardwareCard). */
export function v1PanelMetrics(slice, metrics) {
  if (!slice) return null;
  if (isV1Slice(slice)) return slice;
  const summary = (slice.summary ?? []).map((r) => ({
    ...r,
    r2_mean: r.r2_fold_mean ?? r.r2_pooled,
    r2_std: r.r2_fold_sd ?? null,
    rmse_mean: r.rmse_fold_mean ?? r.rmse_pooled,
    rmse_std: r.rmse_fold_sd ?? null,
    mae_mean: r.mae_pooled ?? null,
    mae_std: null,
  }));
  const moran = (slice.moran ?? []).map((r) => ({ ...r, scheme: r.scheme ?? "block20" }));
  let scatter = slice.moran_scatter ?? {};
  if (Array.isArray(scatter.z)) scatter = scatter.z.length ? { xgboost: scatter } : {};
  return { ...slice, summary, moran, moran_scatter: scatter, hardware: slice.hardware ?? metrics?.hardware ?? null, timings: slice.timings ?? metrics?.timings ?? null };
}

/** Base-only ablation (SPEC §4.2): block-20 pooled R² with and without the 14 focal features. */
export function ablationSummary(slice) {
  const a = slice?.ablation;
  if (!a || typeof a !== "object") return null;
  const baseOnly = num(a.base_only?.r2_pooled);
  const all = num(a.all_features?.r2_pooled);
  const gain = num(a.gain_r2_pooled) ?? (baseOnly !== null && all !== null ? all - baseOnly : null);
  if (gain === null) return null;
  return { scheme: a.scheme ?? "block20", model: a.model ?? null, baseOnly, all, gain, nBase: num(a.n_features?.base_only), nAll: num(a.n_features?.all_features) };
}

/**
 * Data-driven v1 → v2 copy (no causal attribution the bundle cannot support): the same-metric
 * comparison (5×5 blocks, mean of folds), what pooled scoring adds, the focal-feature ablation when
 * exported, and the synthetic-data caveat.
 * @returns {string[]|null} sentences, or null without a v1 comparison block
 */
export function v1v2Story(metrics, mode = "day", { dataMode = null } = {}) {
  const slice = metricsSlice(metrics, mode);
  const cmp = v1Comparison(slice?.v1_comparison);
  if (!cmp) return null;
  const f2 = (v) => (isNum(v) ? v.toFixed(2) : "—");
  const signed = (v, dp) => (isNum(v) ? `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(dp)}` : "—");
  const out = [];
  const v1 = cmp.xgb?.[0] ?? null;
  out.push(`Same metric (5×5 blocks, mean of folds): ${f2(v1)} → ${f2(cmp.block5FoldMean)}.`);
  if (isNum(cmp.block5Pooled) && isNum(cmp.block5FoldMean)) out.push(`Pooled scoring adds ${signed(cmp.block5Pooled - cmp.block5FoldMean, 2)} (${f2(cmp.block5Pooled)} pooled on the same blocks).`);
  out.push("The rest reflects several v2 changes at once (Landsat target, sensors, frames, features, constraints).");
  const ab = ablationSummary(slice);
  if (ab) out.push(`Base-only ablation: the 14 focal features change block-20 pooled R² by ${signed(ab.gain, 3)}.`);
  if ((dataMode ?? metrics?.data_mode) === "synthetic") out.push("These are synthetic scores and are not comparable with the real v1 run.");
  return out;
}

/** Land-model checks vs the null model (D18): verdict + one row per check; FoM fallback for old bundles. */
export function landModelSummary(metrics) {
  const lm = metrics?.land_model;
  if (!lm || typeof lm !== "object") return null;
  const checks = Array.isArray(lm.checks)
    ? lm.checks.filter((c) => c && typeof c.check === "string").map((c) => ({ id: c.check, check: c.check, value: num(c.value), null: num(c.null), ok: Boolean(c.ok) }))
    : [];
  const verdict = ["beats_null", "mixed", "worse_than_null"].includes(lm.verdict) ? lm.verdict : null;
  const fom = num(lm.fom);
  const fomNull = num(lm.fom_null);
  return {
    verdict,
    checks,
    truth: typeof lm.hindcast_truth === "string" && lm.hindcast_truth ? lm.hindcast_truth : null,
    fom,
    fomNull,
    fomBeats: fom !== null && fomNull !== null ? fom > fomNull : null,
    quantity: num(lm.quantity_disagreement),
    quantityNull: num(lm.quantity_disagreement_null),
    allocation: num(lm.allocation_disagreement),
    allocationNull: num(lm.allocation_disagreement_null),
    rmseDu: num(lm.rmse_du),
    rmseDuNull: num(lm.rmse_du_null),
    corrDu: num(lm.corr_du),
    corrDuNull: num(lm.corr_du_null),
    period: Array.isArray(lm.period) ? lm.period : null,
  };
}

/** Verdict wording of the land-model hindcast. */
export const LAND_VERDICT_TEXT = Object.freeze({
  beats_null: "beats the null model on every check",
  mixed: "mixed: beats the null model on some checks only",
  worse_than_null: "worse than the null model on every check",
});
