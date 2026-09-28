/**
 * Pure derivations over `metrics.json` (SPEC §4.7) for the Model Performance view.
 *
 * Science notes that shape the KPIs and callouts:
 * - Three validation schemes answer different questions. Random K-fold puts spatially
 *   adjacent (hence nearly identical) cells in train and test, so under spatial
 *   autocorrelation it measures interpolation, not generalisation. Spatial-block CV holds
 *   out whole blocks and is the honest estimate for unseen areas. The temporal hold-out
 *   trains on earlier epochs and tests the last one (pattern transfer through time).
 * - The "optimism gap" (random R² − spatial R²) quantifies how much random CV overstates
 *   skill.
 * - Moran's I of out-of-fold residuals tests whether spatial structure is left unexplained;
 *   the target's own Moran's I is the reference ("how clustered LST itself is").
 */
import { THEME } from "../../lib/colors.js";
import { fmt, isNum, MISSING } from "../../lib/format.js";

/** Metric definitions: display, units and which direction is better. */
export const METRICS = Object.freeze([
  {
    key: "r2",
    label: "R²",
    unit: "",
    better: "higher",
    dp: 3,
    description: "Share of LST variance explained on held-out cells (1 = perfect, 0 = no better than the mean).",
  },
  {
    key: "rmse",
    label: "RMSE",
    unit: "°C",
    better: "lower",
    dp: 2,
    description: "Root-mean-square error on held-out cells; penalises large misses.",
  },
  {
    key: "mae",
    label: "MAE",
    unit: "°C",
    better: "lower",
    dp: 2,
    description: "Mean absolute error on held-out cells; the typical miss in °C.",
  },
]);

export function metricMeta(key) {
  return METRICS.find((m) => m.key === key) ?? METRICS[0];
}

/**
 * Scheme identity colours, fixed order random -> spatial -> temporal (colour follows the
 * scheme, never its rank). Validated as a categorical triple on the dark panel surface:
 * worst adjacent CVD ΔE 11.4 (deutan), normal-vision ΔE 21.2, all >= 3:1 contrast.
 */
export const SCHEME_META = Object.freeze({
  random: {
    label: "Random",
    long: "Random K-fold",
    color: THEME.violet,
    description: "Cells shuffled into 5 folds; neighbours leak between train and test.",
  },
  spatial: {
    label: "Spatial",
    long: "Spatial block",
    color: THEME.cyan,
    description: "5×5 spatial blocks held out together; tests transfer to unseen areas.",
  },
  temporal: {
    label: "Temporal",
    long: "Temporal hold-out",
    color: THEME.rose,
    description: "Train on earlier epochs, test on the last epoch; tests transfer through time.",
  },
});

export function schemeMeta(scheme) {
  return (
    SCHEME_META[scheme] ?? {
      label: scheme,
      long: scheme,
      color: THEME.inkMuted,
      description: "",
    }
  );
}

const MODEL_LABELS = Object.freeze({
  linear: { label: "Linear (OLS)", short: "Linear" },
  ridge: { label: "Ridge", short: "Ridge" },
  random_forest: { label: "Random Forest", short: "RF" },
  lightgbm: { label: "LightGBM", short: "LGBM" },
  xgboost: { label: "XGBoost", short: "XGB" },
  gnn: { label: "Graph NN", short: "GNN" },
});

/** Human label for a model id; `short` for tight axes. Unknown ids are title-cased. */
export function modelLabel(name, short = false) {
  const known = MODEL_LABELS[name];
  if (known) return short ? known.short : known.label;
  return String(name ?? "")
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

/** Finite number or null (treats null/undefined/NaN/strings as missing; Number(null) is 0!). */
export function num(v) {
  return isNum(v) ? v : null;
}

/** Ordered unique list of models: metrics.models first, then any extra seen in rows. */
export function listModels(metrics) {
  const out = [...(Array.isArray(metrics?.models) ? metrics.models : [])];
  for (const row of metrics?.summary ?? []) if (row?.model && !out.includes(row.model)) out.push(row.model);
  return out;
}

/** Ordered unique list of schemes: metrics.schemes first, then any extra seen in rows. */
export function listSchemes(metrics) {
  const out = [...(Array.isArray(metrics?.schemes) ? metrics.schemes : [])];
  for (const row of metrics?.summary ?? []) if (row?.scheme && !out.includes(row.scheme)) out.push(row.scheme);
  return out;
}

const key = (scheme, model) => `${scheme}|${model}`;

/** Map "scheme|model" -> summary row. */
export function indexSummary(summary) {
  const map = new Map();
  for (const row of Array.isArray(summary) ? summary : []) {
    if (row?.scheme && row?.model) map.set(key(row.scheme, row.model), row);
  }
  return map;
}

/** Summary lookup helper. */
export function summaryRow(index, scheme, model) {
  return index.get(key(scheme, model)) ?? null;
}

/** {mean, sd} of a metric in a summary row (nulls when missing). */
export function metricStats(row, metricKey) {
  return { mean: num(row?.[`${metricKey}_mean`]), sd: num(row?.[`${metricKey}_std`]) };
}

/** True when `a` is a better value than `b` for the metric. */
export function isBetter(metricKey, a, b) {
  if (!isNum(a)) return false;
  if (!isNum(b)) return true;
  return metricMeta(metricKey).better === "higher" ? a > b : a < b;
}

/** Best summary row of a scheme for a metric (null if the scheme has no finite values). */
export function bestRow(summary, scheme, metricKey) {
  let best = null;
  for (const row of Array.isArray(summary) ? summary : []) {
    if (row?.scheme !== scheme) continue;
    const v = num(row[`${metricKey}_mean`]);
    if (v !== null && isBetter(metricKey, v, best ? best[`${metricKey}_mean`] : null)) best = row;
  }
  return best;
}

/** Map scheme -> best model id for a metric (for "best per scheme" highlighting). */
export function bestModelsByScheme(summary, schemes, metricKey) {
  const out = {};
  for (const scheme of schemes) out[scheme] = bestRow(summary, scheme, metricKey)?.model ?? null;
  return out;
}

/** Rows for the grouped bar chart: one per model with {scheme: {mean, sd}}. */
export function groupedMetricData(metrics, metricKey) {
  const index = indexSummary(metrics?.summary);
  const schemes = listSchemes(metrics);
  return listModels(metrics).map((model) => ({
    model,
    values: Object.fromEntries(schemes.map((s) => [s, metricStats(summaryRow(index, s, model), metricKey)])),
  }));
}

/** Per-fold points for the strip plot (finite values only). */
export function foldPoints(metrics, metricKey) {
  const out = [];
  for (const f of Array.isArray(metrics?.folds) ? metrics.folds : []) {
    const value = num(f?.[metricKey]);
    if (value === null || !f.model || !f.scheme) continue;
    out.push({
      model: f.model,
      scheme: f.scheme,
      fold: f.fold,
      value,
      nTest: num(f.n_test),
      nTrain: num(f.n_train),
      fitSeconds: num(f.fit_seconds),
      device: f.device ?? null,
    });
  }
  return out;
}

/** Map "scheme|model" -> {meanFitSeconds, totalFitSeconds, devices[]} from the fold table. */
export function fitStatsIndex(folds) {
  const acc = new Map();
  for (const f of Array.isArray(folds) ? folds : []) {
    if (!f?.scheme || !f?.model) continue;
    const k = key(f.scheme, f.model);
    const entry = acc.get(k) ?? { total: 0, n: 0, devices: new Set() };
    if (isNum(f.fit_seconds)) {
      entry.total += f.fit_seconds;
      entry.n += 1;
    }
    if (f.device) entry.devices.add(String(f.device));
    acc.set(k, entry);
  }
  const out = new Map();
  for (const [k, e] of acc) {
    out.set(k, {
      meanFitSeconds: e.n ? e.total / e.n : null,
      totalFitSeconds: e.n ? e.total : null,
      devices: [...e.devices].sort(),
    });
  }
  return out;
}

export function fitStatsFor(index, scheme, model) {
  return index.get(key(scheme, model)) ?? null;
}

/** Sorted years that have Moran rows for a scheme. */
export function moranYears(moran, scheme = "spatial") {
  const years = new Set();
  for (const r of Array.isArray(moran) ? moran : []) {
    if (r?.scheme === scheme && isNum(Number(r.year))) years.add(Number(r.year));
  }
  return [...years].sort((a, b) => a - b);
}

/** Residual Moran rows of one scheme/year, ordered like `models`. */
export function moranRows(moran, scheme, year, models) {
  const rows = (Array.isArray(moran) ? moran : []).filter(
    (r) => r?.scheme === scheme && Number(r.year) === Number(year),
  );
  const order = (m) => {
    const i = models.indexOf(m);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return rows
    .map((r) => ({ model: r.model, I: num(r.I), expectedI: num(r.expected_I), z: num(r.z), p: num(r.p) }))
    .sort((a, b) => order(a.model) - order(b.model));
}

/** The target's Moran row for a year (null if absent). */
export function moranTargetFor(moranTarget, year) {
  const row = (Array.isArray(moranTarget) ? moranTarget : []).find((r) => Number(r?.year) === Number(year));
  return row ? { I: num(row.I), expectedI: num(row.expected_I), z: num(row.z), p: num(row.p) } : null;
}

/** "p < 0.001" / "p = 0.031" / "p —". */
export function formatP(p) {
  if (!isNum(p)) return `p ${MISSING}`;
  if (p < 0.001) return "p < 0.001";
  return `p = ${fmt(p, 3)}`;
}

export const ALPHA = 0.05;

/** Seconds -> "0.8 s" / "12.3 s" / "4 m 05 s" / "1 h 02 m". */
export function formatDuration(seconds) {
  if (!isNum(seconds)) return MISSING;
  if (seconds < 60) return `${fmt(seconds, seconds < 10 ? 1 : 0)} s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds - m * 60);
    return `${m} m ${String(s).padStart(2, "0")} s`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds - h * 3600) / 60);
  return `${h} h ${String(m).padStart(2, "0")} m`;
}

/**
 * Headline numbers for the KPI strip.
 * - best: best spatial-CV R² row (falls back to the first scheme with data).
 * - temporal: temporal-scheme row of the SAME model (plus the best temporal row).
 * - moran: XGBoost spatial-scheme residual Moran's I in the last epoch available.
 * - gap: random − spatial R² for the best model, and the mean gap across models.
 */
export function deriveKpis(metrics) {
  const summary = metrics?.summary ?? [];
  const schemes = listSchemes(metrics);
  const bestScheme = bestRow(summary, "spatial", "r2") ? "spatial" : schemes.find((s) => bestRow(summary, s, "r2"));
  const best = bestScheme ? bestRow(summary, bestScheme, "r2") : null;
  const index = indexSummary(summary);

  const temporal = best ? summaryRow(index, "temporal", best.model) : null;
  const bestTemporal = bestRow(summary, "temporal", "r2");

  const years = moranYears(metrics?.moran, "spatial");
  const moranYear = years.length ? years[years.length - 1] : null;
  const moranModel =
    moranYear !== null && moranRows(metrics?.moran, "spatial", moranYear, []).some((r) => r.model === "xgboost")
      ? "xgboost"
      : best?.model ?? null;
  const moran =
    moranYear !== null
      ? moranRows(metrics?.moran, "spatial", moranYear, []).find((r) => r.model === moranModel) ?? null
      : null;
  const moranTarget = moranYear !== null ? moranTargetFor(metrics?.moran_target, moranYear) : null;

  const gapFor = (model) => {
    const r = num(summaryRow(index, "random", model)?.r2_mean);
    const s = num(summaryRow(index, "spatial", model)?.r2_mean);
    return r !== null && s !== null ? r - s : null;
  };
  const gaps = listModels(metrics).map(gapFor).filter((g) => g !== null);

  return {
    bestScheme: bestScheme ?? null,
    best,
    temporal,
    bestTemporal,
    moran,
    moranModel,
    moranYear,
    moranTarget,
    gap: best ? gapFor(best.model) : null,
    meanGap: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null,
  };
}

/**
 * Plain-language interpretation callouts derived from the KPIs.
 * @returns {{id: string, tone: "warning"|"good"|"info", title: string, body: string}[]}
 */
export function buildInterpretations(metrics, kpis, lastEpoch) {
  const out = [];
  const bestModel = kpis.best?.model;
  const name = bestModel ? modelLabel(bestModel) : "the best model";
  const index = indexSummary(metrics?.summary);

  if (isNum(kpis.gap)) {
    const r = summaryRow(index, "random", bestModel)?.r2_mean;
    const s = summaryRow(index, "spatial", bestModel)?.r2_mean;
    if (kpis.gap > 0.02) {
      out.push({
        id: "optimism",
        tone: "warning",
        title: "Random CV is optimistic",
        body:
          `Spatial-block CV R² is ${fmt(kpis.gap, 3)} lower than random CV for ${name} ` +
          `(${fmt(r, 3)} → ${fmt(s, 3)}). Random folds put near-identical neighbouring cells in both train and test, ` +
          "so under spatial autocorrelation they overstate skill; the spatial-block score is the honest estimate for unseen areas.",
      });
    } else if (kpis.gap >= -0.02) {
      out.push({
        id: "optimism",
        tone: "good",
        title: "Skill transfers to unseen areas",
        body:
          `Spatial-block and random CV R² differ by only ${fmt(Math.abs(kpis.gap), 3)} for ${name}, ` +
          "so the model is not leaning on leakage between neighbouring cells.",
      });
    } else {
      out.push({
        id: "optimism",
        tone: "info",
        title: "Spatial CV scored above random CV",
        body:
          `Spatial-block R² exceeds random-CV R² by ${fmt(-kpis.gap, 3)} for ${name}. This is unusual and ` +
          "typically reflects fold-to-fold variance (a few easy blocks); read it together with the per-fold spread.",
      });
    }
  }

  const t = num(kpis.temporal?.r2_mean);
  const s = num(kpis.best?.r2_mean);
  if (t !== null) {
    const heldOut = lastEpoch ? `tested on ${lastEpoch}` : "tested on the last epoch";
    const drift = s !== null && t < s - 0.05;
    out.push({
      id: "temporal",
      tone: drift ? "warning" : "good",
      title: drift ? "Weaker transfer through time" : "Drivers transfer through time",
      body:
        `Trained on the earlier epochs and ${heldOut}, ${name} reaches R² ${fmt(t, 3)}` +
        (s !== null ? ` versus ${fmt(s, 3)} under spatial CV. ` : ". ") +
        (drift
          ? "Changing land-cover products, sensor drift and inter-annual weather alter the pattern between epochs, so treat forward projections with caution."
          : "The learned drivers of the spatial LST pattern hold for an unseen year."),
    });
  }

  const m = kpis.moran;
  const target = kpis.moranTarget;
  if (m && isNum(m.I)) {
    const significant = isNum(m.p) && m.p < ALPHA && m.I > 0;
    const removed = target && isNum(target.I) && target.I > 0 ? 1 - m.I / target.I : null;
    const removedText =
      removed !== null ? ` It still removes ${fmt(Math.max(0, Math.min(1, removed)) * 100, 0)}% of the target's own autocorrelation (I = ${fmt(target.I, 2)}).` : "";
    out.push({
      id: "moran",
      tone: significant ? "warning" : "good",
      title: significant ? "Residuals still cluster in space" : "No significant residual clustering",
      body: significant
        ? `${modelLabel(kpis.moranModel)} residuals in ${kpis.moranYear} have Moran's I = ${fmt(m.I, 3)} (${formatP(m.p)}): ` +
          "neighbouring cells are mis-predicted together, so some spatially structured process (fine urban form, irrigation, local climate) is not captured." +
          removedText
        : `${modelLabel(kpis.moranModel)} residuals in ${kpis.moranYear} have Moran's I = ${fmt(m.I, 3)} (${formatP(m.p)}), ` +
          "so the model has absorbed the spatial structure of LST and its errors behave like noise." +
          removedText,
    });
  }

  const linear = num(summaryRow(index, kpis.bestScheme ?? "spatial", "linear")?.r2_mean);
  if (s !== null && linear !== null && bestModel && bestModel !== "linear") {
    const lift = s - linear;
    out.push({
      id: "benchmark",
      tone: "info",
      title: lift > 0.05 ? "Non-linear effects matter" : "Linear baseline is competitive",
      body:
        lift > 0.05
          ? `${name} beats the linear baseline by ${fmt(lift, 3)} R² under spatial CV: thresholds and saturation in the land-cover and spectral drivers are real, which is what the SHAP dependence curves expose.`
          : `${name} improves on the linear baseline by only ${fmt(lift, 3)} R² under spatial CV; the drivers act mostly additively and linearly in this run.`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Summary table, Moran scatter and hardware / timing derivations
// ---------------------------------------------------------------------------------------

/**
 * Flat rows for the sortable summary table: one per (scheme, model) summary row, enriched
 * with fold timing / device information and a per-metric "best in its scheme" flag.
 * Missing metrics are `undefined` (not null) so TanStack's `sortUndefined: "last"` keeps
 * them at the bottom in both sort directions.
 */
export function summaryTableRows(metrics) {
  const summary = Array.isArray(metrics?.summary) ? metrics.summary : [];
  const schemes = listSchemes(metrics);
  const models = listModels(metrics);
  const fit = fitStatsIndex(metrics?.folds);
  const best = Object.fromEntries(METRICS.map((m) => [m.key, bestModelsByScheme(summary, schemes, m.key)]));
  const orderOf = (list, v) => {
    const i = list.indexOf(v);
    return i === -1 ? list.length : i;
  };
  return summary
    .filter((r) => r?.scheme && r?.model)
    .map((r) => {
      const fs = fitStatsFor(fit, r.scheme, r.model);
      const row = {
        id: key(r.scheme, r.model),
        scheme: r.scheme,
        model: r.model,
        schemeOrder: orderOf(schemes, r.scheme),
        modelOrder: orderOf(models, r.model),
        nFolds: num(r.n_folds) ?? undefined,
        meanFitSeconds: fs?.meanFitSeconds ?? undefined,
        devices: fs?.devices ?? [],
        best: {},
      };
      for (const m of METRICS) {
        row[`${m.key}_mean`] = num(r[`${m.key}_mean`]) ?? undefined;
        row[`${m.key}_std`] = num(r[`${m.key}_std`]) ?? undefined;
        row.best[m.key] = best[m.key][r.scheme] === r.model;
      }
      return row;
    })
    .sort((a, b) => a.schemeOrder - b.schemeOrder || a.modelOrder - b.modelOrder);
}

/** Map "scheme|model" -> mean of a metric (for the strip plot's mean ticks). */
export function summaryMeans(metrics, metricKey) {
  const out = {};
  for (const r of Array.isArray(metrics?.summary) ? metrics.summary : []) {
    if (r?.scheme && r?.model) out[key(r.scheme, r.model)] = num(r[`${metricKey}_mean`]);
  }
  return out;
}

/** Models that have a Moran scatter, in the canonical model order. */
export function scatterModels(metrics) {
  const available = Object.keys(metrics?.moran_scatter ?? {});
  const ordered = listModels(metrics).filter((m) => available.includes(m));
  return [...ordered, ...available.filter((m) => !ordered.includes(m))];
}

/**
 * Validated Moran scatter points for one model plus quadrant counts.
 * Quadrants follow LISA naming on the standardised residual z and its spatial lag Wz:
 *   HH: under-prediction surrounded by under-prediction (hot error cluster),
 *   LL: over-prediction surrounded by over-prediction (cool error cluster),
 *   HL / LH: spatial outliers (a cell disagreeing with its neighbours).
 * @returns {{points: {z: number, lag: number, q: "HH"|"LL"|"HL"|"LH"}[], slope: number|null,
 *            year: number|null, counts: Record<string, number>, maxAbs: number} | null}
 */
export function moranScatterData(metrics, model) {
  const s = metrics?.moran_scatter?.[model];
  if (!s || !Array.isArray(s.z) || !Array.isArray(s.lag)) return null;
  const n = Math.min(s.z.length, s.lag.length);
  const points = [];
  const counts = { HH: 0, LL: 0, HL: 0, LH: 0 };
  let maxAbs = 0;
  for (let i = 0; i < n; i += 1) {
    const z = s.z[i];
    const lag = s.lag[i];
    if (!isNum(z) || !isNum(lag)) continue;
    const q = z >= 0 ? (lag >= 0 ? "HH" : "HL") : lag >= 0 ? "LH" : "LL";
    counts[q] += 1;
    points.push({ z, lag, q });
    maxAbs = Math.max(maxAbs, Math.abs(z), Math.abs(lag));
  }
  if (!points.length) return null;
  return { points, slope: num(s.slope), year: isNum(Number(s.year)) ? Number(s.year) : null, counts, maxAbs };
}

/**
 * RAPIDS components that actually ran (`hardware.rapids_used`: a list of names or an object
 * {component: boolean}); [] when absent. `hardware.rapids` alone only says RAPIDS was importable
 * in older bundles, so the card prefers this list when present.
 */
export function rapidsBackends(used) {
  if (Array.isArray(used)) return used.filter((v) => typeof v === "string" && v).map(String);
  if (used && typeof used === "object") {
    return Object.entries(used)
      .filter(([, v]) => v === true)
      .map(([k]) => k);
  }
  return [];
}

/** Normalised hardware block (every field optional in the export). */
export function hardwareInfo(metrics) {
  const hw = metrics?.hardware ?? {};
  const gpus = Array.isArray(hw.gpus) ? hw.gpus.filter(Boolean).map(String) : [];
  const devices = new Set();
  for (const f of Array.isArray(metrics?.folds) ? metrics.folds : []) if (f?.device) devices.add(String(f.device));
  return {
    gpus,
    nGpus: isNum(hw.n_gpus) ? hw.n_gpus : gpus.length,
    xgbDevice: hw.xgb_device ?? null,
    lgbmDevice: hw.lgbm_device ?? null,
    rapids: hw.rapids === true,
    rapidsUsed: rapidsBackends(hw.rapids_used),
    xgbVersion: hw.xgb_version ?? null,
    python: hw.python ?? null,
    platform: hw.platform ?? null,
    foldDevices: [...devices].sort(),
    bootstrap: metrics?.bootstrap && typeof metrics.bootstrap === "object" ? metrics.bootstrap : null,
  };
}

/**
 * Stage timings sorted longest first; stages beyond `maxRows` fold into one "other stages"
 * row so the chart never grows unbounded. Returns {rows, total}.
 */
export function timingRows(timings, maxRows = 10) {
  const entries = Object.entries(timings && typeof timings === "object" ? timings : {})
    .map(([stage, seconds]) => ({ stage, seconds: num(seconds) }))
    .filter((r) => r.seconds !== null && r.seconds >= 0)
    .sort((a, b) => b.seconds - a.seconds);
  const total = entries.reduce((acc, r) => acc + r.seconds, 0);
  if (entries.length <= maxRows) return { rows: entries, total };
  const head = entries.slice(0, maxRows - 1);
  const rest = entries.slice(maxRows - 1);
  head.push({ stage: `${rest.length} other stages`, seconds: rest.reduce((a, r) => a + r.seconds, 0), folded: true });
  return { rows: head, total };
}

/** "04_zone_profiles" -> "04 zone profiles"; keeps numeric prefixes readable. */
export function stageLabel(stage) {
  return String(stage ?? "").replace(/[_]+/g, " ").trim();
}
