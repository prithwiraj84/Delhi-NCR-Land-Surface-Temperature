/**
 * Data preparation for FanChart (pure, unit-tested).
 *
 * Inputs are the normalised scope series of `useSeries(scope, mode)` (data/series.js):
 *   frames[]  observed-frame statistics {year, mean, ci, p90, hot_core_km2, uhi, tier}
 *   ssp{id}   projection quantiles of the scope MEAN [{year, p05, p25, p50, p75, p95}]
 *   annual    {era5_skin: [...], satellite: [{year, value, sensor, flag}]}
 * Integrity rules:
 *   - a frame whose value is missing breaks the line (never bridged);
 *   - fans exist only for the mean (and the DTR median): the notebook exports scope quantiles
 *     of the mean (per-draw scope means), so P90 / hot-core / UHI have no projection fan and
 *     the chart says so instead of inventing one;
 *   - projected strands open at NOW from the scope's weather-normalised BASELINE (D14: the
 *     first projected frame's decomposition baseline_c, else p50 − total, else the NCR
 *     baseline_level_c), drawn as a hollow "baseline" marker — never from the observed NOW
 *     frame (it carries the 2024–26 weather anomaly); without a baseline the fan starts at the
 *     first projected frame;
 *   - the annual lines are the satellite annual LST of the same mode (context, thin), ONE line
 *     per sensor (MODIS Aqua and VIIRS are never joined into a zig-zag) with drift-flagged
 *     points kept; ERA5 skin temperature is a different quantity and is not drawn on the LST
 *     axis (it is listed in the table view as an anomaly).
 */
import { scopeBaseline } from "../data/series.js";
import { metricMeta, niceDomain } from "./chartTheme.js";

const isNum = Number.isFinite;

/**
 * @param {{series: object|null, metric?: string, ssps?: string[], now?: number|null, showAnnual?: boolean}} input
 * @returns {{status: "ready"|"empty", obs: object[], fans: Record<string, object[]>, annual: object[],
 *            annualBySensor: Record<string, object[]>, baselines: Record<string, {x, y, source}>,
 *            yDomain: [number, number], years: number[], fanReason: string|null, metric: object, gaps: number[]}}
 */
export function buildFanModel({ series, metric = "mean", ssps = [], now = null, showAnnual = true }) {
  const meta = metricMeta(metric);
  const key = metric === "dtr" ? "mean" : metric;
  const frames = Array.isArray(series?.frames) ? series.frames : [];
  const obs = frames.map((f) => {
    const y = Number(f[key]);
    const ci = key === "mean" && Array.isArray(f.ci) && f.ci.every(isNum) ? f.ci : null;
    return { x: f.year, y: isNum(y) ? y : NaN, lo: ci ? ci[0] : NaN, hi: ci ? ci[1] : NaN, tier: f.tier ?? null, n: f.n_cells ?? null };
  });
  const gaps = obs.filter((p) => !isNum(p.y)).map((p) => p.x);
  const lastObs = obs.filter((p) => isNum(p.y) && (now === null || p.x <= now)).at(-1) ?? null;
  const anchorX = isNum(now) ? now : lastObs?.x ?? null;

  const fans = {};
  const baselines = {};
  let fanReason = null;
  if (!meta.fan) fanReason = `Projections are exported for the scope mean only (no ${meta.label} fan).`;
  else if (!ssps.length) fanReason = null;
  else {
    for (const id of ssps) {
      const list = series?.ssp?.[id];
      if (!Array.isArray(list) || !list.length) continue;
      const rows = list
        .map((r) => ({ x: r.year, p05: r.p05, p25: r.p25, p50: r.p50, p75: r.p75, p95: r.p95 }))
        .filter((r) => isNum(r.p50));
      // The fan opens at NOW from the weather-normalised baseline (a hollow marker), never from
      // a zero-width observed point.
      const b = key === "mean" ? scopeBaseline(series, id) : null;
      if (b && anchorX !== null && rows.length && rows[0].x > anchorX) {
        rows.unshift({ x: anchorX, p05: b.base, p25: b.base, p50: b.base, p75: b.base, p95: b.base, anchor: true, baseline: true });
        baselines[id] = { x: anchorX, y: b.base, source: b.source };
      }
      if (rows.length) fans[id] = rows;
    }
    if (!Object.keys(fans).length) fanReason = series ? "No scenario projections in this bundle for this scope." : null;
  }

  let annual = [];
  const annualBySensor = {};
  if (showAnnual && key === "mean") {
    const sat = Array.isArray(series?.annual?.satellite) ? series.annual.satellite : [];
    annual = sat
      .filter((r) => isNum(Number(r.value)))
      .map((r) => ({ x: Number(r.year), y: Number(r.value), sensor: r.sensor ?? null, flag: r.flag ?? null, drift: r.flag === "drift" }))
      .sort((a, b) => a.x - b.x);
    for (const a of annual) (annualBySensor[a.sensor ?? "satellite"] ??= []).push(a);
  }

  const values = [];
  for (const p of obs) values.push(p.y, p.lo, p.hi);
  for (const rows of Object.values(fans)) for (const r of rows) values.push(r.p05, r.p95, r.p50);
  for (const a of annual) values.push(a.y);
  const yDomain = niceDomain(values, { minSpan: meta.unit === "km²" ? 10 : 1, includeZero: meta.signed || meta.unit === "km²" });
  const years = [...new Set([...obs.map((p) => p.x), ...Object.values(fans).flatMap((r) => r.filter((q) => !q.anchor).map((q) => q.x))])].sort((a, b) => a - b);
  const hasAny = obs.some((p) => isNum(p.y)) || Object.keys(fans).length > 0;
  return { status: hasAny ? "ready" : "empty", obs, fans, baselines, annual, annualBySensor, yDomain, years, fanReason, metric: meta, gaps };
}

/** Dash pattern of the k-th annual sensor line (solid, dashed, dotted, dash-dot). */
export const SENSOR_DASH = Object.freeze([null, "5 3", "1.5 2", "6 2 1.5 2"]);

/**
 * Split one sensor's annual points (sorted by year, each with `drift`) into runs of equal drift
 * state for drawing. A segment that touches a drift-flagged point belongs to the drift run, so the
 * boundary point is shared by both runs (no gap, no bridging between sensors).
 * @param {Array<{drift?: boolean}>} pts
 * @returns {Array<{drift: boolean, pts: object[]}>}
 */
export function annualRuns(pts) {
  const runs = [];
  for (let i = 0; i < pts.length; i += 1) {
    const p = pts[i];
    if (i === 0) {
      runs.push({ drift: Boolean(p.drift), pts: [p] });
      continue;
    }
    const prev = pts[i - 1];
    const segDrift = Boolean(prev.drift || p.drift);
    const cur = runs[runs.length - 1];
    if (cur.drift === segDrift || cur.pts.length === 1) {
      cur.drift = cur.pts.length === 1 ? segDrift : cur.drift;
      cur.pts.push(p);
    } else runs.push({ drift: segDrift, pts: [prev, p] });
  }
  return runs;
}

/** Table rows for the FanChart table view (one row per year with every series). */
export function fanTableRows(model, ssps = []) {
  const byYear = new Map();
  for (const p of model.obs) byYear.set(p.x, { id: p.x, year: p.x, value: p.y, ci: isNum(p.lo) ? [p.lo, p.hi] : null, tier: p.tier });
  for (const id of ssps) {
    for (const r of model.fans[id] ?? []) {
      if (r.anchor) continue;
      const row = byYear.get(r.x) ?? { id: r.x, year: r.x, tier: "projected" };
      row[`${id}_p50`] = r.p50;
      row[`${id}_range`] = isNum(r.p05) && isNum(r.p95) ? [r.p05, r.p95] : null;
      byYear.set(r.x, row);
    }
  }
  return [...byYear.values()].sort((a, b) => a.year - b.year);
}
