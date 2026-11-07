/**
 * Chart theme and pure chart helpers shared by every v2 analysis chart (UI_SPEC §4.6).
 *
 * Rules encoded here (dataviz method + UI_SPEC):
 *   - horizontal gridlines only, rgba(160,185,225,.08), solid hairlines (never dashed);
 *   - one y-axis per chart (no dual axes) — Day and Night are separate panels;
 *   - evidence tier = line dash + marker shape + text (never hue alone):
 *       observed        solid 1.5 px, filled circle
 *       observed-sparse solid 1.5 px, hollow circle
 *       reconstructed   2-4 dash, half-filled circle, hatched CI
 *       modelled        dotted, diamond (◇), hatched CI
 *       projected       selected SSP solid; others 25 % alpha in their own dash;
 *                       fans p5–p95 @ 18 %, p25–p75 @ 32 %
 *   - SSP identity = label + dash + colour (tokens.ssp), always with an end label;
 *   - text wears ink tokens, never series colours.
 * Everything here is plain data / pure functions (no React) so it is unit-testable.
 */
import { color, modes, ramps, ssp as SSP_TOKENS } from "../design/tokens.js";
import { normalizeTier } from "../design/tiers.js";

export const CHART = Object.freeze({
  grid: "rgba(160, 185, 225, 0.08)",
  axis: color.inkFaint,
  axisLine: "rgba(160, 185, 225, 0.22)",
  ink: color.ink,
  inkMuted: color.inkMuted,
  inkFaint: color.inkFaint,
  surface: color.surface2,
  now: "rgba(223, 231, 242, 0.55)",
  cursor: color.signal,
  hover: "rgba(244, 247, 251, 0.6)",
  fog: "rgba(140, 160, 200, 0.10)",
  hatch: color.hatch,
  font: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace',
  fontSize: 11,
  fanOuter: 0.18,
  fanInner: 0.32,
  otherSspAlpha: 0.25,
});

/** Mode accents (Day solar / Night lunar / DTR). */
export const MODE_STYLE = Object.freeze({
  day: Object.freeze({ id: "day", label: "Day", accent: modes.day.accent, ramp: "solar" }),
  night: Object.freeze({ id: "night", label: "Night", accent: modes.night.accent, ramp: "nocturne" }),
  dtr: Object.freeze({ id: "dtr", label: "DTR", accent: modes.dtr.accent, ramp: "amplitude" }),
});

/** Warm / cool arms of the Polar ramp for signed marks (arrows, bars). */
export const POLAR = Object.freeze({ warm: ramps.polar[5], cool: ramps.polar[1], warmDeep: ramps.polar[4], coolDeep: ramps.polar[2], mid: ramps.polar[3] });

/** SSP style (colour, dash, width, label); unknown ids fall back to ink with a dash. */
export function sspStyle(id) {
  return SSP_TOKENS[id] ?? { id, label: String(id ?? "").toUpperCase(), short: String(id ?? ""), color: color.inkMuted, dash: "2 2", width: 1.5 };
}

/**
 * Line/marker encoding of an evidence tier.
 * @returns {{tier: string|null, dash: string|null, marker: "filled"|"hollow"|"half"|"diamond"|"ring", hatchCi: boolean, label: string}}
 */
export function tierStyle(tier) {
  const id = normalizeTier(tier);
  switch (id) {
    case "observed":
      return { tier: id, dash: null, marker: "filled", hatchCi: false, label: "Observed" };
    case "observed-sparse":
      return { tier: id, dash: null, marker: "hollow", hatchCi: false, label: "Observed (sparse)" };
    case "reconstructed":
      return { tier: id, dash: "2 4", marker: "half", hatchCi: true, label: "Reconstructed" };
    case "modelled":
      return { tier: id, dash: "1 3", marker: "diamond", hatchCi: true, label: "Modelled" };
    case "projected":
      return { tier: id, dash: null, marker: "ring", hatchCi: false, label: "Projected" };
    default:
      return { tier: id, dash: "1 2", marker: "hollow", hatchCi: true, label: tier ? String(tier) : "Unknown tier" };
  }
}

/** Unique SVG id prefix safe for url(#…) references (React's useId contains colons). */
export const svgId = (reactId, suffix) => `${String(reactId).replace(/[^a-zA-Z0-9_-]/g, "")}-${suffix}`;

/** url(#…) reference for a hatch pattern rendered by <HatchDefs prefix=…>. */
export const hatchUrl = (prefix, kind = "recon") => `url(#${prefix}-hatch-${kind})`;

/**
 * Nice linear domain covering values (with padding), at least `minSpan` wide.
 * @param {number[]} values finite numbers (others ignored)
 */
export function niceDomain(values, { pad = 0.06, minSpan = 1, includeZero = false } = {}) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) return [0, 1];
  if (includeZero) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  let span = hi - lo;
  if (span < minSpan) {
    const mid = (lo + hi) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
    span = minSpan;
  }
  const step = niceStep(span / 5);
  return [Math.floor((lo - span * pad) / step) * step, Math.ceil((hi + span * pad) / step) * step];
}

/** 1, 2, 2.5, 5 × 10^k step closest to `raw`. */
export function niceStep(raw) {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

/** Ticks of a linear domain at a nice step (≈ `count` ticks). */
export function linearTicks([lo, hi], count = 5) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return [];
  const step = niceStep((hi - lo) / count);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

/** Decade ticks between two years (inclusive of the decades inside the span). */
export function yearTicks(first, last, every = 10) {
  const out = [];
  for (let y = Math.ceil(first / every) * every; y <= last; y += every) out.push(y);
  return out;
}

/** Linear scale function with `.invert` (tiny, allocation-free; avoids d3 in hot paths). */
export function linearScale([d0, d1], [r0, r1]) {
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  const f = (v) => r0 + (v - d0) * k;
  f.invert = (px) => (k === 0 ? d0 : d0 + (px - r0) / k);
  f.domain = [d0, d1];
  f.range = [r0, r1];
  return f;
}

/** SVG path through points, breaking at non-finite y (gaps are never bridged). */
export function linePath(points, x, y) {
  let d = "";
  let pen = false;
  for (const p of points) {
    if (!Number.isFinite(p?.y) || !Number.isFinite(p?.x)) {
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"}${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`;
    pen = true;
  }
  return d;
}

/** Closed band path between lo and hi (points with any non-finite bound split the band). */
export function bandPath(points, x, y) {
  const runs = [];
  let run = [];
  for (const p of points) {
    if (Number.isFinite(p?.lo) && Number.isFinite(p?.hi) && Number.isFinite(p?.x)) run.push(p);
    else if (run.length) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length) runs.push(run);
  return runs
    .filter((r) => r.length >= 2)
    .map((r) => {
      const top = r.map((p, i) => `${i ? "L" : "M"}${x(p.x).toFixed(1)},${y(p.hi).toFixed(1)}`).join("");
      const bottom = [...r].reverse().map((p) => `L${x(p.x).toFixed(1)},${y(p.lo).toFixed(1)}`).join("");
      return `${top}${bottom}Z`;
    })
    .join("");
}

/**
 * Nearest data year to an x position within `radius` years, else null (the tooltip then says
 * "between A and B: no data at this x").
 */
export function nearestYear(years, t, radius = 1.25) {
  let best = null;
  let bestD = Infinity;
  for (const y of years) {
    const d = Math.abs(y - t);
    if (d < bestD) {
      bestD = d;
      best = y;
    }
  }
  return best !== null && bestD <= radius ? best : null;
}

/** Bracketing years of t among sorted years (for the "between" tooltip). */
export function bracketYears(years, t) {
  let a = null;
  let b = null;
  for (const y of years) {
    if (y <= t) a = y;
    if (y >= t && b === null) b = y;
  }
  return [a, b];
}

/** Values of a metric key from series frame records (mean | p90 | hot_core_km2 | uhi). */
export const METRIC_META = Object.freeze({
  mean: Object.freeze({ key: "mean", label: "Mean", unit: "°C", dp: 1, signed: false, fan: true, description: "Area-mean LST of the scope (absolute °C)." }),
  p90: Object.freeze({ key: "p90", label: "P90", unit: "°C", dp: 1, signed: false, fan: false, description: "90th percentile of the scope's cells." }),
  hot_core_km2: Object.freeze({ key: "hot_core_km2", label: "Hot-core km²", unit: "km²", dp: 0, signed: false, fan: false, description: "Area at or above the reference-period p90 of the mode (fixed threshold)." }),
  uhi: Object.freeze({ key: "uhi", label: "UHI", unit: "°C", dp: 2, signed: true, fan: false, description: "Surface UHI (urban − rural): mean over frac_built ≥ 0.5 minus mean over frac_built ≤ 0.05 (water < 0.2). Signed." }),
  dtr: Object.freeze({ key: "dtr", label: "DTR", unit: "°C", dp: 1, signed: false, fan: true, description: "Diurnal temperature range = day − night mean (median only for projections)." }),
});

export const metricMeta = (key) => METRIC_META[key] ?? METRIC_META.mean;

/** Paint span [x0, x1) of each frame year: halfway to the neighbouring frames (step). */
export function frameSpans(years, xDomain) {
  const sorted = [...years].sort((a, b) => a - b);
  return sorted.map((y, k) => {
    const prev = sorted[k - 1];
    const next = sorted[k + 1];
    const x0 = prev === undefined ? Math.max(xDomain[0] - 0.5, y - (next - y) / 2 || y - 2.5) : (prev + y) / 2;
    const x1 = next === undefined ? Math.min(xDomain[1] + 0.5, y + (y - prev) / 2 || y + 2.5) : (y + next) / 2;
    return { year: y, x0, x1 };
  });
}

/**
 * Fixed categorical order for projection-uncertainty components and the future
 * decomposition (dataviz reference dark slots, validated with validate_palette.js on
 * --surface-2 #111A2B: lightness band 0.48–0.67, chroma ≥ 0.1, worst adjacent CVD ΔE 9.4,
 * normal-vision ΔE ≥ 24.6, all ≥ 3:1). Order is the safety mechanism — never reorder.
 * Every use also carries a text label (legend + table).
 */
export const COMPONENT_COLORS = Object.freeze({
  gcm: "#3987e5",
  sensitivity: "#d95926",
  land: "#199e70",
  model: "#9085e9",
  climate: "#d95926",
});

export const COMPONENT_LABELS = Object.freeze({
  gcm: "GCM spread",
  sensitivity: "Climate sensitivity β",
  land: "Land-use realisation",
  model: "Model error",
  climate: "Climate (CMIP6 ΔT × β)",
});
