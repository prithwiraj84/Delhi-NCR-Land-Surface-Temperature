/**
 * Frame statistics for telemetry, the inspector and guarded copy (UI_SPEC §7 `useFrameStats`).
 *
 * Exact frames read the notebook's numbers from `timeline_series` (NCR mean + CI, p90, signed
 * surface UHI = mean(frac_built ≥ 0.5) − mean(frac_built ≤ 0.05 and frac_water < 0.2), hot-core
 * area, n_cells). Projected frames use the SSP fan (p50 with p05–p95); their hot-core area is
 * counted from the cube's p50 against the mode's fixed reference-period threshold when the cube
 * is loaded, and UHI is not exported for projections (null, with a reason).
 *
 * A fractional year is never presented as data: values are linearly mixed between the bracketing
 * frames, flagged `interpolated`, and carry the bracket so readouts can show "≈" and "2035 ↔ 2040".
 */

import { cubeFrameIndex, decodeCubeFrame } from "./cubes.js";
import { scopeSeries, scopesOfKind, seriesValueAt } from "./series.js";
import { bracketAt, clampYear, isExactBracket, normalizeSspId, tierOf, weakerTier } from "./timeline.js";

const lerp = (a, b, t) => (Number.isFinite(a) && Number.isFinite(b) ? a + (b - a) * t : NaN);
const finiteOrNull = (v) => (Number.isFinite(v) ? v : null);

/** Hot-core km² from a decoded frame and a threshold (cells ≥ threshold × cell area). */
export function hotCoreFromValues(values, threshold, cellAreaKm2) {
  if (!values || !Number.isFinite(threshold)) return NaN;
  let count = 0;
  for (let i = 0; i < values.length; i += 1) if (values[i] >= threshold) count += 1;
  return count * cellAreaKm2;
}

/** Hottest district at an exact year (argmax of the district scope means). */
export function hottestDistrictAt(series, mode, year, ssp) {
  let best = null;
  for (const scope of scopesOfKind(series, "district")) {
    const v = seriesValueAt(scopeSeries(series, scope.id, mode), year, ssp);
    if (v && Number.isFinite(v.mean) && (!best || v.mean > best.value)) {
      best = { scope: scope.id, id: Number(String(scope.id).slice(2)), label: scope.label, value: v.mean };
    }
  }
  return best;
}

function exactStats({ timeline, series, year, mode, ssp, cube, cellAreaKm2, totalAreaKm2 }) {
  const ncr = scopeSeries(series, "ncr", mode);
  const v = seriesValueAt(ncr, year, ssp);
  const tier = tierOf(timeline, year, mode) ?? v?.tier ?? null;
  if (!v) return { year, mode, ssp, tier, mean: null, ci: null, p90: null, uhi: null, hotCoreKm2: null, hotCorePct: null, hottestDistrict: null, nCells: null, kind: null, reason: "no NCR statistics for this frame" };
  let hotCoreKm2 = v.hot_core_km2;
  let nCells = v.n_cells;
  if (v.kind === "projected" && cube) {
    const f = cubeFrameIndex(cube, year);
    const threshold = Number(series?.hotCoreThreshold?.[mode === "dtr" ? "day" : mode]);
    if (f >= 0 && Number.isFinite(threshold)) {
      const values = decodeCubeFrame(cube, f, { q: "p50" });
      hotCoreKm2 = hotCoreFromValues(values, threshold, cellAreaKm2);
      nCells = values.reduce((c, x) => c + (Number.isNaN(x) ? 0 : 1), 0);
    }
  }
  const area = Number.isFinite(nCells) && nCells > 0 ? nCells * cellAreaKm2 : totalAreaKm2;
  return {
    year,
    mode,
    ssp,
    tier,
    kind: v.kind,
    mean: finiteOrNull(v.mean),
    ci: v.ci && v.ci.every(Number.isFinite) ? v.ci : null,
    p05: finiteOrNull(v.p05),
    p95: finiteOrNull(v.p95),
    p90: finiteOrNull(v.p90),
    uhi: v.kind === "projected" ? null : finiteOrNull(v.uhi),
    uhiReason: v.kind === "projected" ? "surface UHI is not exported for projected frames" : Number.isFinite(v.uhi) ? null : "surface UHI not exported",
    hotCoreKm2: finiteOrNull(hotCoreKm2),
    hotCorePct: Number.isFinite(hotCoreKm2) && area > 0 ? (100 * hotCoreKm2) / area : null,
    hottestDistrict: hottestDistrictAt(series, mode, year, ssp),
    nCells: finiteOrNull(nCells),
    reason: null,
  };
}

/**
 * Statistics of a (possibly fractional) year for a display mode and scenario.
 * @param {{timeline, series, year:number, mode:string, ssp?:string, cubes?: {A?:Cube, B?:Cube},
 *          cellAreaKm2?:number, totalAreaKm2?:number}} input
 * @returns {object} {year, mode, ssp, exact, interpolated, bracket, tier, kind, mean, ci, p05, p95,
 *                    p90, uhi, uhiReason, hotCoreKm2, hotCorePct, hottestDistrict, nCells, reason}
 */
export function computeFrameStats({ timeline, series, year, mode, ssp = null, cubes = {}, cellAreaKm2 = 1, totalAreaKm2 = NaN }) {
  if (!timeline || !series) return null;
  const sspId = normalizeSspId(ssp) ?? timeline.scenarioIds?.[0] ?? null;
  const t = clampYear(timeline, year);
  const bracket = bracketAt(timeline.years, t);
  const common = { timeline, series, mode, ssp: sspId, cellAreaKm2, totalAreaKm2 };
  if (isExactBracket(bracket)) {
    return { ...exactStats({ ...common, year: bracket.yA, cube: cubes.A ?? null }), exact: true, interpolated: false, bracket };
  }
  const a = exactStats({ ...common, year: bracket.yA, cube: cubes.A ?? null });
  const b = exactStats({ ...common, year: bracket.yB, cube: cubes.B ?? null });
  const m = bracket.mix;
  const mixNullable = (x, y) => finiteOrNull(lerp(x ?? NaN, y ?? NaN, m));
  return {
    year: t,
    mode,
    ssp: sspId,
    exact: false,
    interpolated: true,
    bracket,
    tier: weakerTier(a.tier, b.tier),
    kind: a.kind === b.kind ? a.kind : "transition",
    mean: mixNullable(a.mean, b.mean),
    ci: a.ci && b.ci ? [lerp(a.ci[0], b.ci[0], m), lerp(a.ci[1], b.ci[1], m)] : null,
    p05: mixNullable(a.p05, b.p05),
    p95: mixNullable(a.p95, b.p95),
    p90: mixNullable(a.p90, b.p90),
    uhi: mixNullable(a.uhi, b.uhi),
    uhiReason: a.uhiReason ?? b.uhiReason ?? null,
    hotCoreKm2: mixNullable(a.hotCoreKm2, b.hotCoreKm2),
    hotCorePct: mixNullable(a.hotCorePct, b.hotCorePct),
    hottestDistrict: m <= 0.5 ? a.hottestDistrict : b.hottestDistrict,
    nCells: m <= 0.5 ? a.nCells : b.nCells,
    reason: a.reason ?? b.reason ?? null,
  };
}
