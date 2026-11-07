/**
 * Pure derivations for the Timeline route (UI_SPEC §3.5). Inputs are the normalised series
 * (data/series.js `normalizeSeries`) and timeline (data/timeline.js `buildTimeline`); nothing
 * here invents statistics the notebook did not export:
 *   - changes between frames are differences of exported frame means, with the level CIs
 *     combined in quadrature (independent frame levels) — they are NOT trend estimates;
 *   - trend sentences come only from the exported Theil–Sen + MC trend, and only when its CI
 *     excludes zero (guarded copy, UI_SPEC §9);
 *   - ranks, dumbbells and barcodes are computed on exact frames only.
 */
import { ciExcludesZero, signed } from "../../data/copy.js";
import { cubeAoaOutside, cubeFrameIndex, decodeCubeFrame } from "../../data/cubes.js";
import { scopeBaseline, scopeSeries, scopesOfKind, seriesValueAt } from "../../data/series.js";

const isNum = Number.isFinite;
const half = (ci) => (Array.isArray(ci) && ci.length === 2 && ci.every(isNum) ? (ci[1] - ci[0]) / 2 : NaN);

/** Guard text when frame levels are not harmonised (same meaning as the telemetry strip guard). */
export const LEVELS_NOT_HARMONISED = "Levels are not harmonised across sensors/overpass times in this bundle, so a frame-to-frame difference is not a change; compare anomalies instead.";

/** Tiers that are evidence for an observed change (a modelled hindcast is not). */
export const CHANGE_TIERS = Object.freeze(new Set(["observed", "observed-sparse", "reconstructed"]));

/**
 * Frames that may anchor an observed change: the exported trend's frames (`trend.obs.frames`)
 * when present, else the frames whose tier is observed, observed-sparse or reconstructed (a row
 * without a tier — old bundles — counts as observed). Finite means only, up to `now`.
 */
export function changeFrames(s, now = null) {
  const frames = (s?.frames ?? []).filter((f) => isNum(f.mean) && (now === null || f.year <= now));
  const trendYears = Array.isArray(s?.trend?.obs?.frames) && s.trend.obs.frames.length ? new Set(s.trend.obs.frames.map(Number)) : null;
  if (trendYears) return frames.filter((f) => trendYears.has(f.year));
  return frames.filter((f) => f.tier === null || f.tier === undefined || CHANGE_TIERS.has(f.tier));
}

/** First and last observed-evidence frames with a finite mean (see changeFrames). */
export function obsEnds(s, now = null) {
  const frames = changeFrames(s, now);
  return frames.length ? { first: frames[0], last: frames[frames.length - 1] } : null;
}

/**
 * Change of the frame mean between the first and last observed frames.
 * @returns {{from: number, to: number, delta: number, ci: number|NaN, tierFrom, tierTo}|null}
 */
export function firstLastChange(s, now = null) {
  const ends = obsEnds(s, now);
  if (!ends || ends.first.year === ends.last.year) return null;
  const a = half(ends.first.ci);
  const b = half(ends.last.ci);
  return {
    from: ends.first.year,
    to: ends.last.year,
    delta: ends.last.mean - ends.first.mean,
    ci: isNum(a) && isNum(b) ? Math.sqrt(a * a + b * b) : NaN,
    tierFrom: ends.first.tier,
    tierTo: ends.last.tier,
  };
}

/**
 * Projected change of the scope mean to `year` under one SSP, relative to the scope's
 * WEATHER-NORMALISED baseline (D14): base = decomposition.baseline_c, else p50 − total, else (NCR)
 * the exported baseline_level_c. delta / lo / hi = p50 / p05 / p95 − base, so `delta` equals the
 * decomposition total and is consistent with the threshold years. The observed NOW mean is a
 * separate field (`observedNow`): it includes the 2024–26 weather anomaly and is not the base.
 * @returns {{ssp, year, delta, lo, hi, p50, base, baseSource, observedNow, total}|null}
 */
export function projectedChange(s, ssp, year, now) {
  const fan = s?.ssp?.[ssp];
  const row = Array.isArray(fan) ? fan.find((r) => r.year === year) : null;
  if (!row || !isNum(row.p50)) return null;
  const b = scopeBaseline(s, ssp, year);
  if (!b) return null;
  const dec = s?.decomposition?.[ssp]?.[String(year)] ?? null;
  const obsNow = (s?.frames ?? []).find((f) => f.year === now)?.mean;
  return {
    ssp,
    year,
    delta: row.p50 - b.base,
    lo: isNum(row.p05) ? row.p05 - b.base : NaN,
    hi: isNum(row.p95) ? row.p95 - b.base : NaN,
    p50: row.p50,
    base: b.base,
    baseSource: b.source,
    observedNow: isNum(obsNow) ? obsNow : NaN,
    total: isNum(dec?.total) ? dec.total : null,
  };
}

/** First frame (observed, else projected under `ssp`) where the scope mean exceeds `threshold`. */
export function firstYearAbove(s, threshold, ssp = null) {
  for (const f of s?.frames ?? []) if (isNum(f.mean) && f.mean > threshold) return { year: f.year, kind: "observed", tier: f.tier };
  for (const r of (ssp && s?.ssp?.[ssp]) || []) if (isNum(r.p50) && r.p50 > threshold) return { year: r.year, kind: "projected", tier: "projected" };
  return null;
}

/**
 * Guarded trend sentence for a scope series (same rule as the "trend_*" copy templates):
 * the slope is stated only when the exported CI excludes zero.
 */
export function trendCopy(s, label) {
  const t = s?.trend?.obs;
  if (!t || !isNum(Number(t.slope_per_decade))) return { text: `${label}: no trend with a confidence interval is exported in this bundle — rerun notebook v2.`, guardPassed: false };
  if (!ciExcludesZero(t.ci)) return { text: "No clear trend: year-to-year weather dominates.", guardPassed: false };
  const period = Array.isArray(t.period) ? `${t.period[0]}–${t.period[1]}` : "";
  return { text: `${label} LST ${signed(Number(t.slope_per_decade), 2)} °C per decade (${signed(t.ci[0], 2)} to ${signed(t.ci[1], 2)}), ${period}.`, guardPassed: true };
}

/**
 * Area-of-applicability share of a projected frame under one SSP (UI_SPEC §9 "AOA % is always
 * shown" next to projection copy). Projected feature vectors drift away from the training space,
 * so the share falls with lead time; cells outside the AOA carry no skill guarantee. Sources, in
 * order:
 *   1. metrics.projection_meta[mode][ssp].pct_outside_aoa[year] (SPEC §5.6) → pct = 1 − value;
 *   2. the SSP cube's AOA flags at `year` (`cube`, a decoded cube of that SSP), over finite cells;
 *   3. metrics.modes[mode].aoa.pct_inside at the latest keyed year not after `year` — an OBSERVED
 *      frame's share, labelled as such (`source: "observed"`).
 * @param {object|null} metrics @param {string} mode @param {number} year @param {string|null} [ssp]
 * @param {{cube?: object|null}} [options]
 * @returns {{year:number, ssp:string|null, pct:number, source:"projection"|"cube"|"observed"}|null}
 */
export function projectionAoa(metrics, mode, year, ssp = null, { cube = null } = {}) {
  const raw = ssp ? metrics?.projection_meta?.[mode]?.[ssp]?.pct_outside_aoa?.[String(year)] : undefined;
  const out = raw === null || raw === undefined ? NaN : Number(raw);
  if (isNum(out)) return { year, ssp, pct: 1 - out, source: "projection" };
  const f = cube ? cubeFrameIndex(cube, year) : -1;
  if (f >= 0) {
    const flags = cubeAoaOutside(cube, f);
    const values = flags ? decodeCubeFrame(cube, f) : null;
    if (flags && values) {
      let n = 0;
      let outside = 0;
      for (let i = 0; i < values.length; i += 1) {
        if (!isNum(values[i])) continue;
        n += 1;
        if (flags[i]) outside += 1;
      }
      if (n) return { year, ssp, pct: 1 - outside / n, source: "cube" };
    }
  }
  const pct = metrics?.modes?.[mode]?.aoa?.pct_inside;
  if (!pct || typeof pct !== "object") return null;
  const keyed = Object.entries(pct)
    .map(([y, v]) => ({ year: Number(y), pct: Number(v) }))
    .filter((r) => Number.isInteger(r.year) && isNum(r.pct) && (!isNum(year) || r.year <= year))
    .sort((a, b) => a.year - b.year);
  const last = keyed.at(-1);
  return last ? { year: last.year, ssp: null, pct: last.pct, source: "observed" } : null;
}

/** District scopes with their numeric id. */
export function districtList(series) {
  return scopesOfKind(series, "district").map((s) => ({ ...s, did: Number(String(s.id).slice(2)) }));
}

/** Exact observed year at or before `year` that has data in the series (for snapshots). */
export function snapshotYear(timeline, year) {
  const obs = timeline?.obsYears ?? [];
  if (!obs.length) return null;
  const y = Number(year);
  const at = [...obs].reverse().find((o) => o <= y + 1e-9);
  return at ?? obs[0];
}

/**
 * District ledger rows.
 * @returns {Array<{id, did, label, state, dayDelta, dayCi, nightDelta, nightCi, uhiDay, uhiNight,
 *                  dayNow, nightNow, p2050, p2050Night, spark: {obs, fan}, rank}>}
 */
export function ledgerRows(series, { now, ssp, lastYear = 2050, nightAvailable = true, harmonised = true } = {}) {
  const rows = districtList(series).map((d) => {
    const day = scopeSeries(series, d.id, "day");
    const night = nightAvailable ? scopeSeries(series, d.id, "night") : null;
    // Frame-to-frame differences only on harmonised levels (else sensor drift reads as change).
    const cd = harmonised ? firstLastChange(day, now) : null;
    const cn = harmonised ? firstLastChange(night, now) : null;
    const vd = seriesValueAt(day, now, null);
    const vn = seriesValueAt(night, now, null);
    const pd = projectedChange(day, ssp, lastYear, now);
    const pn = projectedChange(night, ssp, lastYear, now);
    return {
      id: d.id,
      did: d.did,
      label: d.label,
      state: d.state ?? "",
      dayDelta: cd?.delta ?? NaN,
      dayCi: cd?.ci ?? NaN,
      dayFrom: cd?.from ?? null,
      nightDelta: cn?.delta ?? NaN,
      nightCi: cn?.ci ?? NaN,
      nightFrom: cn?.from ?? null,
      uhiDay: vd?.uhi ?? NaN,
      uhiNight: vn?.uhi ?? NaN,
      dayNow: vd?.mean ?? NaN,
      nightNow: vn?.mean ?? NaN,
      p2050: pd?.p50 ?? NaN,
      p2050Delta: pd?.delta ?? NaN,
      p2050Night: pn?.p50 ?? NaN,
      p2050NightDelta: pn?.delta ?? NaN,
      spark: { obs: (day?.frames ?? []).map((f) => ({ year: f.year, mean: f.mean })), fan: day?.ssp?.[ssp] ?? [], baseline: ssp && day ? scopeBaseline(day, ssp)?.base ?? null : null },
    };
  });
  const ranked = [...rows].filter((r) => isNum(r.dayNow)).sort((a, b) => b.dayNow - a.dayNow);
  ranked.forEach((r, k) => (r.rank = k + 1));
  for (const r of rows) if (!r.rank) r.rank = null;
  return rows;
}

/** Shared y-domain of the ledger sparkfans (so rows compare honestly). */
export function sparkDomain(rows) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const r of rows) {
    for (const p of r.spark.obs) if (isNum(p.mean)) (lo = Math.min(lo, p.mean)), (hi = Math.max(hi, p.mean));
    for (const p of r.spark.fan) {
      if (isNum(p.p05)) lo = Math.min(lo, p.p05);
      if (isNum(p.p95)) hi = Math.max(hi, p.p95);
    }
  }
  return isNum(lo) ? [Math.floor(lo), Math.ceil(hi)] : [0, 1];
}

/**
 * Value of a metric for a scope at an exact year (observed frame or the selected SSP's p50).
 * Projected values exist for the mean only.
 */
export function metricAt(series, scopeId, mode, year, metric, ssp) {
  const s = scopeSeries(series, scopeId, mode);
  const v = seriesValueAt(s, year, ssp);
  if (!v) return NaN;
  if (v.kind === "projected") return metric === "mean" ? v.p50 : NaN;
  const out = v[metric === "dtr" ? "mean" : metric];
  return isNum(out) ? out : NaN;
}

/**
 * Rank bump data: districts ranked (1 = highest) by the metric at each year.
 * @returns {{years: number[], lines: Array<{id, label, ranks: (number|null)[], values: number[]}>}}
 */
export function rankBump(series, { mode, years, metric = "mean", ssp = null }) {
  const ds = districtList(series);
  const values = ds.map((d) => years.map((y) => metricAt(series, d.id, mode, y, metric, ssp)));
  const ranks = ds.map(() => years.map(() => null));
  years.forEach((_, k) => {
    const order = ds.map((_, i) => i).filter((i) => isNum(values[i][k])).sort((a, b) => values[b][k] - values[a][k]);
    order.forEach((i, r) => (ranks[i][k] = r + 1));
  });
  return { years, lines: ds.map((d, i) => ({ id: d.id, label: d.label, ranks: ranks[i], values: values[i] })) };
}

/** Day vs night means per district at an exact year, sorted by DTR (largest first). */
export function dumbbellRows(series, year) {
  return districtList(series)
    .map((d) => {
      const day = seriesValueAt(scopeSeries(series, d.id, "day"), year, null)?.mean;
      const night = seriesValueAt(scopeSeries(series, d.id, "night"), year, null)?.mean;
      return { id: d.id, label: d.label, day: isNum(day) ? day : NaN, night: isNum(night) ? night : NaN, dtr: isNum(day) && isNum(night) ? day - night : NaN };
    })
    .filter((r) => isNum(r.day) || isNum(r.night))
    .sort((a, b) => (isNum(b.dtr) ? b.dtr : -Infinity) - (isNum(a.dtr) ? a.dtr : -Infinity) || a.label.localeCompare(b.label));
}

/** Reference-period mean of a scope's observed frames (barcode anomaly baseline). */
export function referenceMean(s, period) {
  const [a, b] = Array.isArray(period) && period.length === 2 ? period : [-Infinity, Infinity];
  const vals = (s?.frames ?? []).filter((f) => f.year >= a && f.year <= b && isNum(f.mean)).map((f) => f.mean);
  return vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : NaN;
}

/**
 * Barcode rows: per district, each frame's value (observed mean, else the SSP p50) as an
 * anomaly against the district's own reference-period mean (or absolute).
 * Sort keys: name | delta (first→last observed-evidence frame) | 2050 (projected p50) | dtr (at NOW).
 * `harmonised: false` (levels not comparable across sensors / overpass times): the cells show
 * the WITHIN-FRAME anomaly (district − NCR mean of the same frame) and the Δ sort is disabled
 * (falls back to name), so no frame-to-frame level difference is ever shown.
 */
export function barcodeRows(series, { mode, ssp, years, referencePeriod, variable = "anom", now, sort = "name", harmonised = true }) {
  const ncr = harmonised ? null : scopeSeries(series, "ncr", mode);
  const rows = districtList(series).map((d) => {
    const s = scopeSeries(series, d.id, mode);
    const ref = referenceMean(s, referencePeriod);
    const cells = years.map((y) => {
      const v = seriesValueAt(s, y, ssp);
      const raw = v ? (v.kind === "projected" ? v.p50 : v.mean) : NaN;
      let value = variable === "anom" ? raw - ref : raw;
      if (!harmonised) {
        const n = seriesValueAt(ncr, y, ssp);
        const nRaw = n ? (n.kind === "projected" ? n.p50 : n.mean) : NaN;
        value = raw - nRaw;
      }
      return { year: y, value, raw, tier: v?.tier ?? null, projected: v?.kind === "projected" };
    });
    const change = harmonised ? firstLastChange(s, now) : null;
    const last = cells.filter((c) => c.projected && isNum(c.raw)).at(-1);
    const dayNow = seriesValueAt(scopeSeries(series, d.id, "day"), now, null)?.mean;
    const nightNow = seriesValueAt(scopeSeries(series, d.id, "night"), now, null)?.mean;
    return { id: d.id, label: d.label, cells, ref, delta: change?.delta ?? NaN, end: last?.raw ?? NaN, dtr: isNum(dayNow) && isNum(nightNow) ? dayNow - nightNow : NaN };
  });
  const key = { delta: harmonised ? "delta" : null, 2050: "end", end: "end", dtr: "dtr" }[sort];
  if (key) rows.sort((a, b) => (isNum(b[key]) ? b[key] : -Infinity) - (isNum(a[key]) ? a[key] : -Infinity) || a.label.localeCompare(b.label));
  else rows.sort((a, b) => a.label.localeCompare(b.label));
  return rows;
}

/** Symmetric domain covering the barcode values (p99 of |v|, rounded up to 0.5 °C). */
export function barcodeDomain(rows, variable = "anom") {
  const vals = rows.flatMap((r) => r.cells.map((c) => c.value)).filter(isNum);
  if (!vals.length) return variable === "anom" ? [-1, 1] : [0, 1];
  if (variable !== "anom") return [Math.floor(Math.min(...vals)), Math.ceil(Math.max(...vals))];
  const abs = vals.map(Math.abs).sort((a, b) => a - b);
  const a = Math.ceil(abs[Math.min(abs.length - 1, Math.floor(0.99 * (abs.length - 1)))] * 2) / 2 || 0.5;
  return [-a, a];
}

/**
 * Zone share series for the stacked area: observed frames then the SSP's projected frames.
 * @returns {Array<{year: number, shares: number[], projected: boolean}>}
 */
export function zoneShareSeries(series, mode, ssp) {
  const m = mode === "dtr" ? "day" : mode;
  const zs = series?.zoneShare?.[m];
  if (!zs) return [];
  const out = [];
  for (const [y, shares] of Object.entries(zs.obs ?? {})) out.push({ year: Number(y), shares: shares.map(Number), projected: false });
  for (const [y, shares] of Object.entries((ssp && zs[ssp]) || {})) out.push({ year: Number(y), shares: shares.map(Number), projected: true });
  return out.filter((r) => Number.isInteger(r.year) && r.shares.length).sort((a, b) => a.year - b.year);
}

/** Threshold-crossing rows: district (and NCR first) × SSP × {+1, +2, +3}. */
export function thresholdRows(series, mode, ssps) {
  const scopes = [{ id: "ncr", label: series?.scopeById?.get("ncr")?.label ?? "Delhi NCR" }, ...districtList(series)];
  return scopes.map((sc) => {
    const s = scopeSeries(series, sc.id, mode);
    const row = { id: sc.id, label: sc.label };
    for (const id of ssps) for (const k of ["+1", "+2", "+3"]) row[`${id}${k}`] = s?.thresholdYears?.[id]?.[k] ?? null;
    return row;
  });
}
