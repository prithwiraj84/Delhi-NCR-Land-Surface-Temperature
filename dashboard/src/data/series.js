/**
 * Scope time series (SPEC §5.4 `timeline_series.json.gz`).
 *
 * Scopes: "ncr", "d:<district id>", "z:<mode>:<zone id>" (zone scopes exist only for their own
 * mode). Per scope × mode the file carries observed-frame statistics (`frames`), the annual
 * weather/satellite context (`annual`), SSP quantile fans (`ssp`), trends, the future
 * decomposition, the uncertainty budget and threshold-crossing years — all computed by the
 * notebook; this module only normalises and indexes them (no statistics are invented here).
 *
 * DTR series are derived as day − night for the mean / p50 only (differences of other quantiles
 * are not quantiles) and keep the weaker tier of the two modes.
 */

import { weakerTier } from "./timeline.js";

const toNum = (v) => (v === null || v === undefined ? NaN : Number(v));

/** Resolve a scope id for a mode: "z:3" -> "z:<mode>:3"; others unchanged. */
export function resolveScopeId(scope, mode) {
  const s = String(scope ?? "ncr");
  const m = /^z:(\d+)$/.exec(s);
  if (m) return `z:${mode === "dtr" ? "day" : mode}:${m[1]}`;
  return s;
}

/**
 * Normalise the parsed series JSON.
 * @returns {{referencePeriod, hotCoreThreshold, scopes, scopeById: Map, raw, zoneShare}}
 */
export function normalizeSeries(raw) {
  if (!raw || typeof raw !== "object" || !raw.series || typeof raw.series !== "object") {
    throw new Error('timeline_series: expected an object with a "series" map');
  }
  const scopes = Array.isArray(raw.scopes) && raw.scopes.length
    ? raw.scopes.filter((s) => s && s.id)
    : Object.keys(raw.series).map((id) => ({ id, label: id, kind: id === "ncr" ? "ncr" : id.startsWith("d:") ? "district" : "zone" }));
  return {
    referencePeriod: Array.isArray(raw.reference_period) ? raw.reference_period.map(Number) : null,
    hotCoreThreshold: raw.hot_core_threshold_c ?? {},
    scopes,
    scopeById: new Map(scopes.map((s) => [s.id, s])),
    raw: raw.series,
    zoneShare: raw.zone_share ?? {},
    /** Weather-normalised NOW baseline per mode (SPEC §4.10 L_base; NCR scope), e.g. {day: 41.5}. */
    baselineLevel: normalizeBaseline(raw.baseline_level_c),
  };
}

function normalizeBaseline(raw) {
  const out = {};
  if (raw && typeof raw === "object") for (const [m, v] of Object.entries(raw)) if (Number.isFinite(toNum(v))) out[m] = toNum(v);
  return out;
}

function normalizeFrames(frames) {
  return (Array.isArray(frames) ? frames : [])
    .map((f) => ({
      year: Number(f.year),
      mean: toNum(f.mean),
      ci: Array.isArray(f.ci) ? f.ci.map(toNum) : null,
      p90: toNum(f.p90),
      hot_core_km2: toNum(f.hot_core_km2),
      uhi: toNum(f.uhi),
      n_cells: toNum(f.n_cells),
      // Share of the scope's ROI cells with a finite value (D16; optional, NaN when absent).
      coverage: toNum(f.coverage),
      tier: f.tier ?? null,
    }))
    .filter((f) => Number.isInteger(f.year))
    .sort((a, b) => a.year - b.year);
}

function normalizeFan(list) {
  return (Array.isArray(list) ? list : [])
    .map((r) => ({ year: Number(r.year), p05: toNum(r.p05), p25: toNum(r.p25), p50: toNum(r.p50), p75: toNum(r.p75), p95: toNum(r.p95) }))
    .filter((r) => Number.isInteger(r.year))
    .sort((a, b) => a.year - b.year);
}

/** One scope × physical mode, normalised; null when absent. */
function physicalSeries(series, scopeId, mode) {
  const entry = series?.raw?.[scopeId]?.[mode];
  if (!entry) return null;
  const ssp = {};
  for (const [id, list] of Object.entries(entry.ssp ?? {})) ssp[id] = normalizeFan(list);
  return {
    scope: scopeId,
    mode,
    label: series.scopeById.get(scopeId)?.label ?? scopeId,
    frames: normalizeFrames(entry.frames),
    annual: entry.annual ?? {},
    ssp,
    trend: entry.trend ?? null,
    decomposition: entry.decomposition ?? {},
    uncertaintyBudget: entry.uncertainty_budget ?? {},
    thresholdYears: entry.threshold_years ?? {},
    // The exported top-level baseline_level_c applies to the NCR scope only.
    baselineLevel: scopeId === "ncr" && Number.isFinite(series.baselineLevel?.[mode]) ? series.baselineLevel[mode] : null,
  };
}

/** DTR = day − night per common year (mean / p50 only). */
export function deriveDtrSeries(day, night) {
  if (!day || !night) return null;
  const nightByYear = new Map(night.frames.map((f) => [f.year, f]));
  const frames = day.frames
    .filter((f) => nightByYear.has(f.year))
    .map((f) => {
      const g = nightByYear.get(f.year);
      return {
        year: f.year,
        mean: f.mean - g.mean,
        ci: null,
        p90: NaN,
        hot_core_km2: NaN,
        uhi: f.uhi - g.uhi,
        n_cells: Math.min(f.n_cells, g.n_cells),
        coverage: Number.isFinite(f.coverage) && Number.isFinite(g.coverage) ? Math.min(f.coverage, g.coverage) : NaN,
        tier: weakerTier(f.tier, g.tier),
      };
    });
  const ssp = {};
  for (const [id, fan] of Object.entries(day.ssp)) {
    const other = new Map((night.ssp[id] ?? []).map((r) => [r.year, r]));
    ssp[id] = fan
      .filter((r) => other.has(r.year))
      .map((r) => ({ year: r.year, p05: NaN, p25: NaN, p50: r.p50 - other.get(r.year).p50, p75: NaN, p95: NaN }));
  }
  return {
    scope: day.scope,
    mode: "dtr",
    label: day.label,
    frames,
    annual: {},
    ssp,
    trend: null,
    decomposition: {},
    uncertaintyBudget: {},
    thresholdYears: {},
    baselineLevel: Number.isFinite(day.baselineLevel) && Number.isFinite(night.baselineLevel) ? day.baselineLevel - night.baselineLevel : null,
  };
}

/**
 * Series of a scope for a display mode ("day" | "night" | "dtr").
 * @returns {object|null} {scope, mode, label, frames[], annual{}, ssp{id: fan[]}, trend,
 *                         decomposition, uncertaintyBudget, thresholdYears}
 */
export function scopeSeries(series, scope, mode) {
  if (!series) return null;
  const id = resolveScopeId(scope, mode);
  if (mode === "dtr") return deriveDtrSeries(physicalSeries(series, id, "day"), physicalSeries(series, id, "night"));
  return physicalSeries(series, id, mode);
}

/**
 * Weather-normalised baseline of a scope's projections (D14) for one SSP and projected year:
 *   decomposition.baseline_c → p50 − decomposition.total → the NCR `baseline_level_c` (NCR only).
 * Projected changes are p50 − baseline; fans and strands are anchored at the baseline (never at
 * the observed NOW frame, which carries the 2024–26 weather anomaly).
 * @param {object} s scope series (scopeSeries) @param {string} ssp
 * @param {number|null} [year] projected year; default = the first projected frame of that SSP
 * @returns {{base: number, source: "baseline_c"|"p50-total"|"baseline_level_c", year: number|null}|null}
 */
export function scopeBaseline(s, ssp, year = null) {
  const fan = s?.ssp?.[ssp];
  const rows = Array.isArray(fan) ? fan.filter((r) => Number.isFinite(r.p50)) : [];
  const y = year ?? rows[0]?.year ?? null;
  const row = y !== null ? rows.find((r) => r.year === y) : null;
  const dec = y !== null ? s?.decomposition?.[ssp]?.[String(y)] : null;
  const baseC = toNum(dec?.baseline_c);
  if (Number.isFinite(baseC)) return { base: baseC, source: "baseline_c", year: y };
  const total = toNum(dec?.total);
  if (Number.isFinite(total) && row) return { base: row.p50 - total, source: "p50-total", year: y };
  if (Number.isFinite(s?.baselineLevel)) return { base: s.baselineLevel, source: "baseline_level_c", year: y };
  return null;
}

/** Scope ids of one kind ("district" | "zone" | "ncr"), optionally for one mode. */
export function scopesOfKind(series, kind, mode = null) {
  return (series?.scopes ?? []).filter((s) => s.kind === kind && (!mode || kind !== "zone" || s.mode === mode));
}

/**
 * Value of a scope series at an exact year for the given SSP: the observed frame record, or the
 * projected fan entry (`{year, mean: p50, p05…p95}`); null when the year is not in either.
 */
export function seriesValueAt(s, year, ssp = null) {
  if (!s) return null;
  const y = Number(year);
  const obs = s.frames.find((f) => f.year === y);
  if (obs) return { ...obs, kind: "observed" };
  const fan = ssp ? s.ssp?.[ssp] : null;
  const p = fan?.find((r) => r.year === y);
  if (p) return { year: y, mean: p.p50, ci: [p.p05, p.p95], p05: p.p05, p25: p.p25, p50: p.p50, p75: p.p75, p95: p.p95, tier: "projected", kind: "projected" };
  return null;
}

/** Zone shares (4 fractions) at a year for a mode/series key ("obs" | ssp id); null if absent. */
export function zoneShareAt(series, mode, seriesKey, year) {
  const m = mode === "dtr" ? "day" : mode;
  const list = series?.zoneShare?.[m]?.[seriesKey]?.[String(year)];
  return Array.isArray(list) ? list.map(Number) : null;
}
