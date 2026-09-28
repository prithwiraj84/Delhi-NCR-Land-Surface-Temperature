/**
 * Pure numeric + text helpers for the Non-Linear Threshold Explorer.
 *
 * Everything here is side-effect free and independent of React so it can be unit tested
 * and memoised cheaply. Conventions:
 * - Feature values follow the manifest `display` type: "percent" (a 0..1 fraction),
 *   "index" (a normalised spectral index, -1..1) or "number" (native units, e.g. m/ha).
 * - SHAP values and dependence curves are in °C (contribution to predicted LST).
 * - Epoch columns are typed arrays with NaN for missing values, so every loop guards
 *   with `Number.isFinite` and never uses TypedArray.map to build objects.
 */
import { quantileSorted } from "../../lib/data.js";
import { fmt, fmtPct, fmtSig, fmtSigned, fmtFeatureValue, isNum } from "../../lib/format.js";

/**
 * Display metadata for the five manifest feature groups (identity colours for chips/dots).
 * The ORDER is deliberate: adjacent pairs pass the CVD (ΔE ≥ 14.5) and normal-vision
 * (ΔE ≥ 21) separation checks of the dataviz palette validator on the dark panel surface.
 * The neon hues sit above the validator's lightness band (user palette), so identity is
 * never colour-alone: every chip and legend entry carries its text label.
 */
export const FEATURE_GROUPS = [
  { id: "spectral", label: "Spectral", color: "#22d3ee" },
  { id: "socioeconomic", label: "Socio-economic", color: "#fb7185" },
  { id: "terrain", label: "Terrain", color: "#fbbf24" },
  { id: "landscape", label: "Landscape", color: "#a78bfa" },
  { id: "landcover", label: "Land cover", color: "#34d399" },
];

/** Colours with a fixed meaning across the explorer. */
export const SEMANTIC = {
  cooling: "#22d3ee",
  warming: "#fb7185",
  neutral: "#94a3b8",
  curve: "#f8fafc",
  band: "#f8fafc",
  zero: "#fbbf24",
  breakpoint: "#e879f9",
  saturation: "#34d399",
};

/** Maximum scatter points drawn in the dependence plot (matches the exported sample size). */
export const MAX_SCATTER_POINTS = 1500;

/* ------------------------------------------------------------------------------------ */
/* Generic numeric helpers                                                              */
/* ------------------------------------------------------------------------------------ */

/** Finite values of an array-like as a new ascending Float64Array. */
function sortedFinite(values) {
  const out = [];
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (Number.isFinite(v)) out.push(v);
  }
  return Float64Array.from(out).sort();
}

/**
 * Robust [lo, hi] of array-like values (quantile clipped, default 2nd..98th percentile).
 * Returns null when there are no finite values. A degenerate span is widened slightly so
 * colour scales never divide by zero.
 */
export function robustExtent(values, lowQ = 0.02, highQ = 0.98) {
  const sorted = sortedFinite(values);
  if (sorted.length === 0) return null;
  let lo = quantileSorted(sorted, lowQ);
  let hi = quantileSorted(sorted, highQ);
  if (!(hi > lo)) {
    const pad = Math.abs(lo) * 0.01 || 1e-6;
    lo -= pad;
    hi += pad;
  }
  return [lo, hi];
}

/** [min, max] padded by `frac` of the span on both sides (null-safe). */
export function paddedExtent(min, max, frac = 0.04) {
  if (!isNum(min) || !isNum(max)) return null;
  const span = max - min || Math.abs(max) * 0.1 || 1;
  return [min - span * frac, max + span * frac];
}

/** A "nice" 1/2/5 × 10^k step no larger than `approx` (used for slope units and sliders). */
export function niceStep(approx) {
  if (!(approx > 0) || !Number.isFinite(approx)) return 1;
  const exp = Math.floor(Math.log10(approx));
  const base = 10 ** exp;
  const mantissa = approx / base;
  const nice = mantissa >= 5 ? 5 : mantissa >= 2 ? 2 : 1;
  return nice * base;
}

/** Deterministic, evenly strided sample of `max` indices out of `n` (stable across renders). */
export function strideSample(n, max) {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const step = n / max;
  const out = new Array(max);
  for (let k = 0; k < max; k += 1) out[k] = Math.floor(k * step);
  return out;
}

/* ------------------------------------------------------------------------------------ */
/* Dependence curve                                                                     */
/* ------------------------------------------------------------------------------------ */

/**
 * Convert a dependence.json entry into chart rows sorted by x.
 * Each row: { x, mean, lo, hi, band: [lo, hi] | null, count }. Bins with a missing centre
 * or mean are dropped (they would break interpolation); a missing CI only drops the band.
 */
export function buildCurve(dep) {
  const centers = dep?.bin_centers ?? [];
  const rows = [];
  for (let i = 0; i < centers.length; i += 1) {
    const x = centers[i];
    const mean = dep.mean?.[i];
    if (!isNum(x) || !isNum(mean)) continue;
    const lo = dep.ci_lo?.[i];
    const hi = dep.ci_hi?.[i];
    const hasBand = isNum(lo) && isNum(hi);
    rows.push({
      x,
      mean,
      lo: hasBand ? Math.min(lo, hi) : null,
      hi: hasBand ? Math.max(lo, hi) : null,
      band: hasBand ? [Math.min(lo, hi), Math.max(lo, hi)] : null,
      count: isNum(dep.count?.[i]) ? dep.count[i] : null,
    });
  }
  rows.sort((a, b) => a.x - b.x);
  return rows;
}

/**
 * Evaluate the binned mean curve at x by linear interpolation between bin centres, with
 * flat extrapolation outside the observed range (trees cannot extrapolate either, so a
 * flat tail is the faithful choice). Returns NaN for an empty curve or non-finite x.
 */
export function interpolateCurve(curve, x, key = "mean") {
  if (!curve.length || !Number.isFinite(x)) return NaN;
  if (x <= curve[0].x) return curve[0][key];
  const last = curve[curve.length - 1];
  if (x >= last.x) return last[key];
  let lo = 0;
  let hi = curve.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (curve[mid].x <= x) lo = mid;
    else hi = mid;
  }
  const a = curve[lo];
  const b = curve[hi];
  const t = b.x === a.x ? 0 : (x - a.x) / (b.x - a.x);
  return a[key] + (b[key] - a[key]) * t;
}

/** Index of the curve row whose x is nearest to `x` (-1 for an empty curve). */
export function nearestCurveIndex(curve, x) {
  if (!curve.length || !Number.isFinite(x)) return -1;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < curve.length; i += 1) {
    const d = Math.abs(curve[i].x - x);
    if (d < bestDist) {
      best = i;
      bestDist = d;
    }
  }
  return best;
}

/* ------------------------------------------------------------------------------------ */
/* Scatter samples                                                                      */
/* ------------------------------------------------------------------------------------ */

/**
 * Rows from the exported pooled scatter sample (all epochs), dropping points without x/SHAP.
 * Each row: { x, y, c, zone, year }.
 */
export function buildExportScatter(scatter) {
  const xs = scatter?.x ?? [];
  const rows = [];
  for (let i = 0; i < xs.length; i += 1) {
    const x = xs[i];
    const y = scatter.shap?.[i];
    if (!isNum(x) || !isNum(y)) continue;
    const c = scatter.color?.[i];
    const zone = scatter.zone?.[i];
    rows.push({
      x,
      y,
      c: isNum(c) ? c : null,
      zone: isNum(zone) ? zone : null,
      year: scatter.year?.[i] ?? null,
    });
  }
  return rows;
}

/**
 * Live scatter sample drawn from the current epoch's typed arrays, used when the reader picks
 * a colour feature other than the exported interaction partner. Rows as buildExportScatter.
 */
export function buildEpochScatter(epoch, feature, colorFeature, max = MAX_SCATTER_POINTS) {
  const xs = epoch?.features?.[feature];
  const ys = epoch?.shap?.[feature];
  if (!xs || !ys) return [];
  const cs = colorFeature ? epoch.features?.[colorFeature] : null;
  const zones = epoch.zone;
  const valid = [];
  for (let i = 0; i < xs.length; i += 1) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) valid.push(i);
  }
  const picks = strideSample(valid.length, max);
  const rows = new Array(picks.length);
  for (let k = 0; k < picks.length; k += 1) {
    const i = valid[picks[k]];
    const c = cs ? cs[i] : NaN;
    const z = zones ? zones[i] : NaN;
    rows[k] = {
      x: xs[i],
      y: ys[i],
      c: Number.isFinite(c) ? c : null,
      zone: Number.isFinite(z) && z >= 0 ? z : null,
      year: epoch.year ?? null,
    };
  }
  return rows;
}

/* ------------------------------------------------------------------------------------ */
/* Feature units, axis formatting, scenario deltas                                      */
/* ------------------------------------------------------------------------------------ */

/** Compact axis tick formatter for a feature (percent -> "40%", index -> "0.25"). */
export function axisTickFormatter(meta) {
  const display = meta?.display ?? "number";
  if (display === "percent") return (v) => (isNum(v) ? `${Math.round(v * 100)}%` : "");
  if (display === "index") return (v) => (isNum(v) ? fmt(v, 2) : "");
  return (v) => (isNum(v) ? fmtSig(v, 3) : "");
}

/** Human axis title: label plus unit (percent features say "% of cell"). */
export function axisTitle(meta) {
  if (!meta) return "";
  if (meta.display === "percent") return `${meta.label} (% of cell)`;
  return meta.unit ? `${meta.label} (${meta.unit})` : meta.label;
}

/**
 * The slope unit used to phrase breakpoint slopes: a meaningful increment of the feature
 * rather than "per 1.0", which for a 0..1 fraction would mean "per 100 percentage points".
 * Returns { step, label } where slope_per_step = slope_per_unit × step.
 */
export function slopeUnit(meta) {
  const display = meta?.display ?? "number";
  if (display === "percent") return { step: 0.1, label: "per 10 pp" };
  if (display === "index") return { step: 0.1, label: "per 0.1" };
  const stats = meta?.stats ?? {};
  const span = isNum(stats.p99) && isNum(stats.p01) ? stats.p99 - stats.p01 : NaN;
  const step = niceStep(span / 10);
  const unit = meta?.unit ? ` ${meta.unit}` : "";
  return { step, label: `per ${fmtSig(step, 2)}${unit}` };
}

/**
 * Slider specification for a scenario delta, per the explorer contract:
 * - fractions ("percent"): −50..+50 percentage points, stored as a fraction (−0.5..0.5);
 * - spectral indices ("index"): −0.3..+0.3;
 * - landscape metrics / other numbers: ±50 % of the feature median, in native units.
 * Returns { min, max, step, format(delta) -> string, describe(delta) -> string }.
 */
export function deltaSpec(meta) {
  const display = meta?.display ?? "number";
  if (display === "percent") {
    return {
      min: -0.5,
      max: 0.5,
      step: 0.01,
      format: (d) => `${fmtSigned(d * 100, 0)}%`,
      describe: (d) => `${fmtSigned(d * 100, 0)} percentage points of cell area`,
    };
  }
  if (display === "index") {
    return {
      min: -0.3,
      max: 0.3,
      step: 0.01,
      format: (d) => fmtSigned(d, 2),
      describe: (d) => `${fmtSigned(d, 2)} index units`,
    };
  }
  const stats = meta?.stats ?? {};
  const reference =
    [stats.median, stats.mean, stats.std].map((v) => (isNum(v) ? Math.abs(v) : 0)).find((v) => v > 0) ?? 1;
  const half = reference * 0.5;
  const unit = meta?.unit ? ` ${meta.unit}` : "";
  return {
    min: -half,
    max: half,
    step: niceStep(half / 50),
    format: (d) => `${d >= 0 ? "+" : ""}${fmtSig(d, 3)}${unit}`,
    describe: (d) => `${fmtSigned((d / reference) * 100, 0)}% of the NCR median (${fmtSig(reference, 3)}${unit})`,
  };
}

/** Snap a delta onto a spec's slider grid and range. */
export function clampDelta(spec, delta) {
  if (!isNum(delta)) return 0;
  const clamped = Math.min(Math.max(delta, spec.min), spec.max);
  const snapped = Math.round(clamped / spec.step) * spec.step;
  return Number(snapped.toFixed(10));
}

/**
 * Physical bounds of a feature after a perturbation: fractions stay in [0, 1], normalised
 * indices in [−1, 1], CONTAG in [0, 100] and other non-negative metrics stay ≥ 0 (the same
 * bounds the scenario engine in lib/scenario.js applies).
 */
export function clampFeatureValue(meta, v) {
  const display = meta?.display ?? "number";
  if (display === "percent") return Math.min(Math.max(v, 0), 1);
  if (display === "index") return Math.min(Math.max(v, -1), 1);
  if (meta?.name === "lm_contag") return Math.min(Math.max(v, 0), 100);
  const min = meta?.stats?.min;
  return isNum(min) && min >= 0 ? Math.max(v, 0) : v;
}

/* ------------------------------------------------------------------------------------ */
/* Scenario support                                                                     */
/* ------------------------------------------------------------------------------------ */

/**
 * Additive (main-effect only) estimate of a scenario from the dependence curve:
 * mean over the given (changed) cells of curve(clamp(x + δ)) − curve(x).
 * It ignores interactions, the fraction rebalancing and the spectral coupling that the tree
 * model sees, so model − additive isolates non-additive behaviour.
 * Returns { mean, count } (mean NaN when nothing could be evaluated).
 */
export function additiveEstimate({ curve, values, indices, delta, meta }) {
  if (!curve?.length || !values || !indices || !isNum(delta)) return { mean: NaN, count: 0 };
  let sum = 0;
  let count = 0;
  for (let k = 0; k < indices.length; k += 1) {
    const x = values[indices[k]];
    if (!Number.isFinite(x)) continue;
    const shifted = clampFeatureValue(meta, x + delta);
    const d = interpolateCurve(curve, shifted) - interpolateCurve(curve, x);
    if (!Number.isFinite(d)) continue;
    sum += d;
    count += 1;
  }
  return { mean: count ? sum / count : NaN, count };
}

/**
 * Why a scenario result has nothing to show, or null when it has changed cells:
 * an empty region (e.g. a district with no cells in this epoch), cells without a value for the
 * feature, or cells where the requested change cannot apply (e.g. removing trees where there
 * are none).
 */
export function emptyScenarioMessage({ result, featureLabel, regionKind = "all", year = null }) {
  const stats = result?.stats;
  if (!result || !stats || stats.count > 0) return null;
  const where = regionKind === "district" ? "This district" : regionKind === "zone" ? "This zone" : "The study area";
  const epochText = year ? `the ${year} epoch` : "the current epoch";
  const regionCount = result.regionCount ?? stats.regionCount;
  if (regionCount === 0) return `${where} has no cells in ${epochText} – choose another region.`;
  const applicable = stats.applicableCount ?? 0;
  if (!applicable) return `No cells in this region have a value for ${featureLabel} in ${epochText} – choose another region.`;
  return `The requested change cannot be applied to any of the ${applicable} cells in this region (for example there is no ${featureLabel} left to remove) – try a different change or region.`;
}

/**
 * "requested −20 pp · mean applied −13 pp" when the applied change differs from the request by
 * more than 2 % of it (or 1e-4 absolute), else null. `format` renders one change value.
 */
export function appliedChangeText(stats, format) {
  const requested = stats?.requested;
  const applied = stats?.meanApplied;
  if (!isNum(requested) || !isNum(applied) || typeof format !== "function") return null;
  if (Math.abs(applied - requested) <= Math.max(1e-4, Math.abs(requested) * 0.02)) return null;
  return `requested ${format(requested)} · mean applied ${format(applied)}`;
}

/** Count of cells per district id in an epoch (Map id -> count), ignoring unknown (−1). */
export function districtCellCounts(epoch) {
  const counts = new Map();
  const col = epoch?.district;
  if (!col) return counts;
  for (let i = 0; i < col.length; i += 1) {
    const d = col[i];
    if (d >= 0) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  return counts;
}

/* ------------------------------------------------------------------------------------ */
/* Threshold interpretation                                                             */
/* ------------------------------------------------------------------------------------ */

/** The land-management action a feature increase stands for, used in plain-language text. */
function actionNoun(name) {
  if (name === "ndvi" || name === "frac_forest") return "greening";
  if (name === "ndwi" || name === "frac_water") return "surface water and moisture";
  if (name === "ndbi" || name === "frac_impervious") return "surface sealing";
  if (name === "frac_cropland") return "cropland expansion";
  if (name === "frac_barren") return "bare-soil exposure";
  if (name?.startsWith?.("lm_")) return "landscape change";
  return "increase";
}

/** A [lo, hi] CI pair or null when either end is missing. */
function ciPair(ci) {
  return Array.isArray(ci) && isNum(ci[0]) && isNum(ci[1]) ? [Math.min(ci[0], ci[1]), Math.max(ci[0], ci[1])] : null;
}

/** Bins whose 95 % band excludes zero (evidence that the effect is non-null there). */
function binsExcludingZero(curve) {
  let withBand = 0;
  let excluding = 0;
  for (const row of curve) {
    if (!row.band) continue;
    withBand += 1;
    if (row.lo > 0 || row.hi < 0) excluding += 1;
  }
  return { withBand, excluding };
}

/** Conservative envelope of the effect range implied by the 95 % band. */
function effectRangeEnvelope(curve) {
  const banded = curve.filter((r) => r.band);
  if (!banded.length) return null;
  const maxLo = Math.max(...banded.map((r) => r.lo));
  const minHi = Math.min(...banded.map((r) => r.hi));
  const maxHi = Math.max(...banded.map((r) => r.hi));
  const minLo = Math.min(...banded.map((r) => r.lo));
  return [Math.max(0, maxLo - minHi), maxHi - minLo];
}

function breakpointNarrative({ label, value, before, after, unit }) {
  const fb = `${fmtSigned(before * unit.step, 2)} °C`;
  const fa = `${fmtSigned(after * unit.step, 2)} °C`;
  const pair = `${fb} → ${fa} ${unit.label}`;
  const tiny = 1e-9;
  if (Math.abs(before) > tiny && Math.abs(after) > tiny && Math.sign(before) !== Math.sign(after)) {
    return `The ${label} effect reverses direction at ${value} (${pair}).`;
  }
  if (Math.abs(after) < 0.5 * Math.abs(before)) {
    const drop = Math.round((1 - Math.abs(after) / Math.abs(before)) * 100);
    return `Sensitivity falls ${drop}% beyond ${value} (${pair}) – interventions below this level buy the most change.`;
  }
  if (Math.abs(after) > 2 * Math.abs(before)) {
    return `The response accelerates beyond ${value} (${pair}) – a tipping point worth avoiding or exploiting.`;
  }
  return `The slope shifts only modestly at ${value} (${pair}).`;
}

/** Bootstrap support below which a detected threshold is flagged as fragile. */
export const LOW_SUPPORT = 0.8;

/**
 * Build the five threshold cards for one feature. Every field is null-safe: a missing
 * threshold value yields a card with `value: null` and an explanatory `interpretation`
 * (a null `threshold` object is reported as "not exported" rather than "not detected").
 * An interval is shown only next to an existing estimate (an interval exported for a
 * threshold the final curve does not have is dropped). Optional export fields:
 * `<key>_support` (share of bootstrap replicates that found the threshold) and
 * `zero_crossing_flag: "multiple"` (the final curve crosses zero more than once).
 * Card: { key, title, value (string|null), missingText, ci (string|null), support (string|null),
 *         lowSupport (boolean), detail (string|null), interpretation,
 *         tone: "cooling"|"warming"|"neutral", accent }.
 * @param {{meta: object, threshold: object|null, curve: Array, ciLabel?: string}} args
 *   `ciLabel` is "95% CI" or "replicate range" (see lib/uncertainty.js).
 */
export function buildThresholdCards({ meta, threshold, curve, ciLabel = "95% CI" }) {
  const name = meta?.name ?? "";
  const label = meta?.label ?? name;
  const t = threshold ?? {};
  const direction = t.direction ?? null;
  const fv = (v) => fmtFeatureValue(meta, v);
  const fci = (value, ci) => {
    const pair = isNum(value) ? ciPair(ci) : null;
    return pair ? `${ciLabel} ${fv(pair[0])} – ${fv(pair[1])}` : null;
  };
  const supportOf = (key) => {
    const s = t[`${key}_support`];
    if (!isNum(t[key]) || !isNum(s)) return { support: null, lowSupport: false };
    return { support: `found in ${fmtPct(s, 0)} of bootstrap replicates`, lowSupport: s < LOW_SUPPORT };
  };
  const fragile = (key, text) =>
    supportOf(key).lowSupport
      ? `${text} Found in fewer than ${fmtPct(LOW_SUPPORT, 0)} of bootstrap replicates – treat as tentative.`
      : text;
  const noun = actionNoun(name);
  const tone = direction === "cooling" ? "cooling" : direction === "warming" ? "warming" : "neutral";
  const cards = [];

  // Zero crossing: where the average contribution changes sign. SHAP is measured against the
  // model's average prediction, so "zero" means "same as the average cell", not "no heat".
  const multiple = t.zero_crossing_flag === "multiple";
  let zeroText = multiple
    ? `The binned mean effect of ${label} crosses zero more than once, so no single crossing is reported.`
    : `The binned mean effect of ${label} never changes sign – relative to the average cell it either always warms or always cools.`;
  if (isNum(t.zero_crossing)) {
    const z = fv(t.zero_crossing);
    zeroText =
      direction === "cooling"
        ? `Above ${z}, the contribution of ${label} turns from warming to cooling relative to the average cell.`
        : direction === "warming"
          ? `Above ${z}, the contribution of ${label} turns from cooling to warming relative to the average cell.`
          : `The ${label} contribution changes sign near ${z}; the response is non-monotonic.`;
    zeroText = fragile("zero_crossing", zeroText);
  }
  cards.push({
    key: "zero",
    title: "Zero crossing",
    value: isNum(t.zero_crossing) ? fv(t.zero_crossing) : null,
    missingOverride: multiple && !isNum(t.zero_crossing) ? "multiple crossings" : null,
    ci: fci(t.zero_crossing, t.zero_crossing_ci),
    ...supportOf("zero_crossing"),
    detail: "Where the mean SHAP curve crosses 0 °C (0 = the average cell's prediction)",
    interpretation: zeroText,
    tone,
    accent: SEMANTIC.zero,
  });

  // Breakpoint: hinge of the best two-segment fit, phrased with meaningful slope units.
  const unit = slopeUnit(meta);
  const hasSlopes = isNum(t.slope_before) && isNum(t.slope_after);
  cards.push({
    key: "breakpoint",
    title: "Breakpoint",
    value: isNum(t.breakpoint) ? fv(t.breakpoint) : null,
    ci: fci(t.breakpoint, t.breakpoint_ci),
    ...supportOf("breakpoint"),
    detail: hasSlopes
      ? `Slope ${fmtSigned(t.slope_before * unit.step, 2)} → ${fmtSigned(t.slope_after * unit.step, 2)} °C ${unit.label}`
      : null,
    interpretation:
      isNum(t.breakpoint) && hasSlopes
        ? fragile(
            "breakpoint",
            breakpointNarrative({ label, value: fv(t.breakpoint), before: t.slope_before, after: t.slope_after, unit }),
          )
        : `No reliable hinge was found for ${label}; a single slope describes the response.`,
    tone,
    accent: SEMANTIC.breakpoint,
  });

  // Saturation: where the marginal effect fades out.
  let satText = `The ${label} response does not saturate within the observed range.`;
  if (isNum(t.saturation)) {
    const s = fv(t.saturation);
    satText =
      direction === "cooling"
        ? `Cooling from ${label} saturates beyond ${s} – additional ${noun} yields diminishing returns.`
        : direction === "warming"
          ? `Warming from ${label} plateaus beyond ${s} – the first increments of ${noun} do most of the damage.`
          : `The ${label} response flattens beyond ${s}; changes above this level barely move LST.`;
    satText = fragile("saturation", satText);
  }
  cards.push({
    key: "saturation",
    title: "Saturation",
    value: isNum(t.saturation) ? fv(t.saturation) : null,
    ci: fci(t.saturation, t.saturation_ci),
    ...supportOf("saturation"),
    detail: "|slope| < 10% of its peak for ≥ 3 bins",
    interpretation: satText,
    tone,
    accent: SEMANTIC.saturation,
  });

  // Effect range: span of the binned mean curve, with a band-implied envelope.
  const envelope = effectRangeEnvelope(curve);
  cards.push({
    key: "range",
    title: "Effect range",
    value: isNum(t.effect_range) ? `${fmt(t.effect_range, 2)} °C` : null,
    ci: envelope ? `band envelope ${fmt(envelope[0], 2)} – ${fmt(envelope[1], 2)} °C` : null,
    detail: "max − min of the binned mean curve",
    interpretation: isNum(t.effect_range)
      ? `Moving ${label} across its observed range shifts predicted LST by up to ${fmt(t.effect_range, 1)} °C.`
      : `The effect range of ${label} is unavailable.`,
    tone: "neutral",
    accent: SEMANTIC.neutral,
  });

  // Direction: sign of Spearman ρ(x, SHAP); support = bins whose band excludes zero.
  const support = binsExcludingZero(curve);
  const bandLabel = ciLabel === "95% CI" ? "95% band" : `bootstrap ${ciLabel}`;
  const supportText = support.withBand
    ? `The ${bandLabel} excludes 0 °C in ${support.excluding} of ${support.withBand} bins.`
    : "No bootstrap band available.";
  const directionText =
    direction === "cooling"
      ? `Higher ${label} means cooler surfaces. ${supportText}`
      : direction === "warming"
        ? `Higher ${label} means hotter surfaces. ${supportText}`
        : direction === "mixed"
          ? `No monotone trend (|ρ| < 0.2): the effect depends on the level of ${label} and on interacting features. ${supportText}`
          : "Direction unavailable.";
  cards.push({
    key: "direction",
    title: "Direction",
    value: direction,
    ci: support.withBand ? `${support.excluding}/${support.withBand} bins ≠ 0` : null,
    detail: "sign of Spearman ρ(x, SHAP)",
    interpretation: directionText,
    tone,
    accent: tone === "cooling" ? SEMANTIC.cooling : tone === "warming" ? SEMANTIC.warming : SEMANTIC.neutral,
  });
  // No threshold object at all means "not analysed", not "no threshold found".
  if (!threshold) {
    return cards.map(({ missingOverride: _unused, ...card }) => ({
      ...card,
      support: null,
      lowSupport: false,
      missingText: "not exported",
      interpretation: `Threshold analysis was not exported for ${label}.`,
    }));
  }
  return cards.map(({ missingOverride, ...card }) => ({
    ...card,
    support: card.support ?? null,
    lowSupport: Boolean(card.lowSupport),
    missingText: missingOverride ?? "not detected",
  }));
}

/** Percent of a total ("12%"), null-safe. */
export function fmtShare(part, total) {
  return isNum(part) && isNum(total) && total > 0 ? fmtPct(part / total, 0) : "—";
}
