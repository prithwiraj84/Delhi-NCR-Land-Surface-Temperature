/**
 * Pure helpers of the Control view (UI_SPEC_v2 §3.2, §3.4, §9, §12): telemetry and tier-chip
 * copy, the honest skill headline, the DescribeMap sentence, the weather-context anomaly, the
 * hottest-cell probe, inspector maths (percent ranks, district ranks, cell boxes, waterfall
 * adaptation, CSV export) and compare labels.
 *
 * Copy rules (UI_SPEC §9): Surface UHI is always "Surface UHI (urban − rural)", signed and
 * mode-tagged; accuracy names its scheme ("Spatial-block CV R² … (pooled, 20 km blocks)"; v1
 * numbers are labelled "mean of folds"); projections say "Model + CMIP6 scenario, not
 * observations"; interpolated values carry "≈" and the bracket.
 */

import { normalizeTier, TIER_META } from "../../design/tiers.js";
import { fmt, fmtC, fmtPct, fmtSigned, fmtSsp, MISSING } from "../../lib/format.js";

const finite = (v) => typeof v === "number" && Number.isFinite(v);

/** "2024–26 Apr–Jun" for a frame window, or null for a single year. */
export function windowLabel(window) {
  if (!Array.isArray(window) || window.length !== 2 || window[0] === window[1]) return null;
  const [a, b] = window;
  const short = String(a).slice(0, 2) === String(b).slice(0, 2) ? String(b).slice(2) : String(b);
  return `${a}–${short} Apr–Jun`;
}

/**
 * Tier chip text (UI_SPEC §9 examples) from `frameTierInfo(...)`:
 *   "Landsat 8/9 C2 ST · 10:40 IST · 2024–26 Apr–Jun · n=11 scenes"
 *   "Modelled · model hindcast (ERA5-Land level) · no satellite night LST for this frame"
 *   "SSP2-4.5 · p50 [p5–p95] · 34 GCMs"
 * @returns {{tier: string|null, label: string, detail: string}}
 */
export function tierChipText(info, { mode, sspLabel = null, nGcm = null } = {}) {
  if (!info) return { tier: null, label: "No frame", detail: "" };
  const id = normalizeTier(info.tier);
  const label = id ? TIER_META[id].label : info.available ? "Unknown tier" : "Unavailable";
  if (!info.available) return { tier: id, label, detail: info.reason ?? "no data for this frame" };
  if (id === "projected") {
    const parts = [sspLabel ?? fmtSsp(info.ssp), "p50 [p5–p95]", finite(nGcm) ? `${nGcm} GCMs` : null, "model + CMIP6 scenario, not observations"];
    return { tier: id, label, detail: parts.filter(Boolean).join(" · ") };
  }
  const parts = [
    info.sensor,
    info.overpass ? `${info.overpass} IST` : null,
    windowLabel(info.window),
    finite(info.scenes) && info.scenes > 0 ? `n=${info.scenes} scenes` : null,
  ];
  if (id === "modelled") parts.push(mode === "night" ? "no satellite night LST for this frame" : "model output, not an observation");
  if (id === "reconstructed") parts.push("calibrated from another sensor");
  return { tier: id, label, detail: parts.filter(Boolean).join(" · ") };
}

/**
 * Honest headline skill for the telemetry strip and the AOA step (UI_SPEC §3.8, §9).
 * v2: `metrics.modes[mode].headline.spatial` (pooled 20 km-block CV). v1: the spatial-CV
 * XGBoost row, explicitly labelled as a mean of per-fold R² (not comparable to pooled).
 * @returns {{r2:number, rmse:number|null, label:string, short:string, pooled:boolean}|null}
 */
export function skillHeadline(metrics, mode) {
  const m = mode === "dtr" ? "day" : mode;
  const block = metrics?.modes?.[m] ?? null;
  const h = block?.headline?.spatial;
  if (h && finite(Number(h.r2))) {
    return {
      r2: Number(h.r2),
      rmse: finite(Number(h.rmse)) ? Number(h.rmse) : null,
      label: `Spatial-block CV R² ${fmt(Number(h.r2), 2)} (pooled, ${block?.fold_geometry?.block20?.block_km ?? 20} km blocks): skill in unseen areas`,
      short: "sp-CV R²",
      pooled: true,
    };
  }
  const summary = block?.summary ?? metrics?.summary;
  const row = Array.isArray(summary) ? summary.find((r) => r.scheme === "spatial" && r.model === "xgboost") ?? summary.find((r) => r.scheme === "spatial") : null;
  if (row && finite(Number(row.r2_mean))) {
    return {
      r2: Number(row.r2_mean),
      rmse: finite(Number(row.rmse_mean)) ? Number(row.rmse_mean) : null,
      label: `Spatial CV R² ${fmt(Number(row.r2_mean), 2)} ± ${fmt(Number(row.r2_std), 2)} (v1: mean of per-fold R², ${row.model}) — not the pooled v2 metric`,
      short: "sp-CV R² (v1)",
      pooled: false,
    };
  }
  return null;
}

/**
 * Weather context (UI_SPEC §3.2 CONTEXT chip): mean ERA5-Land skin-temperature anomaly of the
 * annual series over the frame window. Null unless the bundle exports `annual.era5_skin` with
 * anomalies covering the window.
 * @returns {{anomaly:number, years:number[], window:[number,number]}|null}
 */
export function contextAnomaly(ncrSeries, frame) {
  const rows = ncrSeries?.annual?.era5_skin;
  if (!Array.isArray(rows) || !frame?.window) return null;
  const [a, b] = frame.window;
  const inWin = rows.filter((r) => r && r.year >= a && r.year <= b && finite(Number(r.anomaly)));
  if (!inWin.length) return null;
  const anomaly = inWin.reduce((s, r) => s + Number(r.anomaly), 0) / inWin.length;
  return { anomaly, years: inWin.map((r) => r.year), window: [a, b] };
}

/** Index of the hottest finite cell (optionally inside one district), or −1. */
export function hottestCellIndex(values, { district = null, districtOf = null } = {}) {
  if (!values?.length) return -1;
  let best = -1;
  let bestV = -Infinity;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (!Number.isFinite(v) || v <= bestV) continue;
    if (district !== null && districtOf && districtOf[i] !== district) continue;
    best = i;
    bestV = v;
  }
  return best;
}

/** Percent rank (0..100) of v among the finite entries of `values` (sampled for speed). */
export function percentRank(values, v, { maxSample = 20000 } = {}) {
  if (!values?.length || !Number.isFinite(v)) return null;
  const step = Math.max(1, Math.floor(values.length / maxSample));
  let below = 0;
  let equal = 0;
  let n = 0;
  for (let i = 0; i < values.length; i += step) {
    const x = values[i];
    if (!Number.isFinite(x)) continue;
    n += 1;
    if (x < v) below += 1;
    else if (x === v) equal += 1;
  }
  return n ? (100 * (below + 0.5 * equal)) / n : null;
}

/**
 * Rank (1 = highest) of a district by a key ("uhi" | "mean") at an exact year among all
 * district scopes that have a finite value.
 */
export function districtRank(entries, districtId) {
  const valid = entries.filter((e) => finite(e.value));
  valid.sort((a, b) => b.value - a.value);
  const i = valid.findIndex((e) => e.id === districtId);
  return i < 0 ? null : { rank: i + 1, of: valid.length };
}

/** Lon/lat box of a square cell of `resM` metres centred on (lon, lat). */
export function cellBox(lon, lat, resM = 1000) {
  const dLat = resM / 2 / 111320;
  const dLon = resM / 2 / (111320 * Math.cos((lat * Math.PI) / 180));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

/**
 * Adapt data/xai.js `cellWaterfall(xai, i)` ({base, contributions:[{group, value}], pred}) to
 * the v1 CellWaterfall shape ({base, contributions:[{name, shap, value}] sorted by |SHAP|,
 * sum, reconstructed, prediction, additivityError}). `featureValueOf(group)` supplies the
 * primary feature value shown next to each bar.
 */
export function waterfallForCell(wf, featureValueOf = () => undefined) {
  if (!wf || !finite(wf.base)) return null;
  let sum = 0;
  const contributions = wf.contributions.map((c) => {
    const shap = finite(c.value) ? c.value : 0;
    sum += shap;
    return { name: c.group, shap, value: featureValueOf(c.group) };
  });
  contributions.sort((a, b) => Math.abs(b.shap) - Math.abs(a.shap));
  const reconstructed = wf.base + sum;
  const pred = wf.pred;
  return {
    base: wf.base,
    contributions,
    sum,
    reconstructed,
    prediction: finite(pred) ? pred : reconstructed,
    additivityError: finite(pred) ? reconstructed - pred : NaN,
  };
}

/** CSV of a cell timeline (obs + every SSP fan), RFC 4180 quoting. */
export function cellTimelineCsv({ cellId, mode, lon, lat, district, obs = [], ssp = {} }) {
  const q = (v) => {
    const s = v === null || v === undefined || (typeof v === "number" && !Number.isFinite(v)) ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const num = (v) => (finite(v) ? v.toFixed(2) : "");
  const lines = [["cell_id", "lon", "lat", "district", "mode", "series", "year", "tier", "p05", "p25", "p50", "p75", "p95", "outside_aoa"].join(",")];
  for (const r of obs) lines.push([cellId, num(lon), num(lat), q(district), mode, "obs", r.year, q(r.tier), num(r.p05), num(r.p25), num(r.p50), num(r.p75), num(r.p95), r.outsideAoa === null ? "" : r.outsideAoa ? 1 : 0].join(","));
  for (const [id, rows] of Object.entries(ssp)) for (const r of rows) lines.push([cellId, num(lon), num(lat), q(district), mode, id, r.year, q(r.tier ?? "projected"), num(r.p05), num(r.p25), num(r.p50), num(r.p75), num(r.p95), r.outsideAoa === null || r.outsideAoa === undefined ? "" : r.outsideAoa ? 1 : 0].join(","));
  return `${lines.join("\n")}\n`;
}

/**
 * "Surface UHI (urban − rural) −1.6 °C by day" style copy, signed and mode-tagged. In DTR mode the
 * urban − rural difference is a difference of diurnal ranges, so the copy says how much more or
 * less built-up land swings between day and night (never "cooler / warmer").
 */
export function uhiCopy(uhi, mode) {
  if (!finite(uhi)) return null;
  if (mode === "dtr") {
    const swing = uhi < 0 ? "built-up land swings less between day and night" : uhi > 0 ? "built-up land swings more between day and night" : "no urban–rural difference in the day–night swing";
    return `Urban − rural diurnal range ${fmtSigned(uhi, 1)} °C: ${swing}`;
  }
  const tag = mode === "night" ? "at night" : mode === "dtr" ? "day − night" : "by day";
  const meaning = uhi < 0 ? "built-up land is cooler than rural land" : uhi > 0 ? "built-up land is warmer than rural land" : "no urban–rural difference";
  return `Surface UHI (urban − rural) ${fmtSigned(uhi, 1)} °C ${tag}: ${meaning}`;
}

/**
 * DescribeMap sentence (UI_SPEC §12 map alternative), e.g.
 * "Day 2025, observed (Landsat 8/9 C2 ST). NCR mean 41.2 °C [40.6–41.8]. Hottest district
 *  Bharatpur at 44.0 °C. Surface UHI (urban − rural) −1.6 °C by day: built-up land is cooler
 *  than rural land. Hot core 27 % of the area. Layer: LST, fixed scale 38–48 °C."
 */
export function describeMapSentence({ stats, info, mode, layerLabel = "LST", legend = null, sspLabel = null }) {
  if (!stats || !info) return "The map is loading.";
  const modeWord = mode === "night" ? "Night" : mode === "dtr" ? "Diurnal range" : "Day";
  const id = normalizeTier(info.tier);
  const tierWord = id ? TIER_META[id].label.toLowerCase() : "unavailable";
  const yearText = stats.interpolated && stats.bracket ? `about ${Math.round(stats.year)} (interpolated between ${stats.bracket.yA} and ${stats.bracket.yB})` : String(stats.year);
  const parts = [];
  parts.push(`${modeWord} ${yearText}, ${tierWord}${id === "projected" && sspLabel ? ` under ${sspLabel}, model + CMIP6 scenario, not observations` : info.sensor ? ` (${info.sensor})` : ""}.`);
  if (finite(stats.mean)) {
    const lo = stats.ci?.[0] ?? stats.p05;
    const hi = stats.ci?.[1] ?? stats.p95;
    parts.push(`NCR mean ${stats.interpolated ? "≈" : ""}${fmtC(stats.mean)}${finite(lo) && finite(hi) ? ` [${fmt(lo, 1)}–${fmt(hi, 1)}]` : ""}.`);
  }
  if (stats.hottestDistrict) parts.push(mode === "dtr" ? `Largest diurnal range: ${stats.hottestDistrict.label} at ${fmtC(stats.hottestDistrict.value)}.` : `Hottest district ${stats.hottestDistrict.label} at ${fmtC(stats.hottestDistrict.value)}.`);
  const uhi = uhiCopy(stats.uhi, mode);
  if (uhi) parts.push(`${uhi}.`);
  else if (stats.uhiReason) parts.push(`${stats.uhiReason[0].toUpperCase()}${stats.uhiReason.slice(1)}.`);
  if (finite(stats.hotCorePct)) parts.push(`Hot core ${fmtPct(stats.hotCorePct / 100)} of the area.`);
  if (legend?.domain) parts.push(`Layer: ${layerLabel}, ${legend.stretched ? "contrast-stretched" : "fixed"} scale ${fmt(legend.domain[0], 1)} to ${fmt(legend.domain[1], 1)} ${legend.unit}.`.replace(" .", "."));
  else parts.push(`Layer: ${layerLabel}.`);
  return parts.join(" ");
}

/** Compare side label: "1990 · Day", "2050 · SSP2-4.5 p50 · Day", "2025 · Night". */
export function compareSideLabel(kind, value, { year, mode, scenarios = [] }) {
  const modeWord = (m) => (m === "night" ? "Night" : m === "dtr" ? "DTR" : "Day");
  if (kind === "y") return `${value ?? MISSING} · ${modeWord(mode)}`;
  if (kind === "s") return `${year ?? MISSING} · ${scenarios.find((s) => s.id === value)?.label ?? fmtSsp(value)} p50 · ${modeWord(mode)}`;
  if (kind === "m") return `${year ?? MISSING} · ${modeWord(value)}`;
  return MISSING;
}

/**
 * The (year, mode, ssp) frame each compare side shows.
 * kind "y": years a/b at the current mode & SSP; "s": SSPs a/b at the compare year (the current
 * year if projected, else the last frame); "m": modes a/b at the current year.
 */
export function compareSides(compare, { year, mode, ssp, timeline }) {
  if (!compare?.kind) return null;
  const lastProj = timeline?.projYears?.length ? timeline.projYears[timeline.projYears.length - 1] : timeline?.last ?? year;
  const projYear = Number.isFinite(year) && year > (timeline?.now ?? -Infinity) ? year : lastProj;
  if (compare.kind === "y") return { A: { year: compare.a, mode, ssp }, B: { year: compare.b, mode, ssp } };
  if (compare.kind === "s") return { A: { year: projYear, mode, ssp: compare.a }, B: { year: projYear, mode, ssp: compare.b } };
  if (compare.kind === "m") return { A: { year, mode: compare.a ?? "day", ssp }, B: { year, mode: compare.b ?? "night", ssp } };
  return null;
}

/** Tiers whose levels count as evidence for an observed change (not a modelled hindcast). */
export const OBSERVED_CHANGE_TIERS = Object.freeze(new Set(["observed", "observed-sparse", "reconstructed"]));

/**
 * First frame of a series row list with a finite mean and an evidence tier (observed,
 * observed-sparse or reconstructed); modelled and projected frames never anchor an observed change.
 * A row without a tier (old bundles) counts as observed.
 */
export function firstComparableFrame(frames) {
  if (!Array.isArray(frames)) return null;
  return frames.find((f) => finite(f?.mean) && (f.tier === null || f.tier === undefined || OBSERVED_CHANGE_TIERS.has(normalizeTier(f.tier)))) ?? null;
}

/**
 * Headline of the inspector cell readout, from the MANIFEST tier (D22 e):
 *   observed / observed-sparse with a finite observation → "Obs" ●
 *   reconstructed → "Reconstructed" ◐ (the cube value)
 *   modelled → "Map (modelled)" ◇ (the cube value); Pred is "Pred (model)" with a note
 *   projected → "<SSP> p50" ○
 *   DTR → "DTR" (the DTR value); Pred / OOF become "Day pred" / "Day resid"
 * @returns {{label, tier, value, predLabel, residLabel, note, showPred}}
 */
export function cellHeadline({ frameKind = "observed", tier = null, mode = "day", sspLabel = null, obs = NaN, map = NaN, pred = NaN }) {
  const t = normalizeTier(tier);
  const base = { tier: t, predLabel: "Pred", residLabel: "OOF resid", note: null, showPred: true };
  if (mode === "dtr") return { ...base, label: "DTR", value: map, predLabel: "Day pred", residLabel: "Day resid", note: "Pred and resid are the day model's; the DTR value is day − night." };
  if (frameKind === "projected" || t === "projected") return { ...base, tier: "projected", label: `${sspLabel ?? "Scenario"} p50`, value: map };
  if (t === "observed" || t === "observed-sparse") {
    if (finite(obs)) return { ...base, label: "Obs", value: obs };
    return { ...base, label: "Map", value: map, note: finite(map) ? "No observation in this cell; the map value is shown." : null };
  }
  if (t === "reconstructed") return { ...base, label: "Reconstructed", value: map };
  if (t === "modelled") {
    const close = finite(pred) && finite(map) && Math.abs(pred - map) < 0.05;
    return { ...base, label: "Map (modelled)", value: map, predLabel: "Pred (model)", showPred: !close, note: "The map adds the frame recentring and the persistent residual to the model prediction; the waterfall explains Pred." };
  }
  return { ...base, label: "Map", value: finite(obs) ? obs : map };
}

/**
 * Hover-card quantity of an engine readout (MapEngine.readCell / readRaster): what the displayed
 * number IS, e.g. "p95", "anomaly", "spread", "Δ vs 1990", "what-if Δ".
 * @returns {{prefix: string, signed: boolean}}
 */
export function hoverQuantity(r, { featureLabel = null, firstYear = null } = {}) {
  if (!r) return { prefix: "", signed: false };
  const layer = r.layer ?? "lst";
  if (layer === "unc") return { prefix: "spread", signed: false };
  if (layer === "pred") return { prefix: "predicted", signed: false };
  if (layer === "resid") return { prefix: "residual (OOF)", signed: true };
  if (layer === "shap") return { prefix: `SHAP ${featureLabel ?? r.shapFeature ?? ""}`.trim(), signed: true };
  if (layer === "whatif") return { prefix: "what-if Δ", signed: true };
  if (r.q === "spread") return { prefix: "spread", signed: false };
  const q = r.q && r.q !== "p50" ? `${r.q} ` : "";
  if (r.variable === "anom") return { prefix: `${q}anomaly`, signed: true };
  if (r.variable === "suhi") return { prefix: `${q}surface UHI`, signed: true };
  if (r.variable === "delta") return { prefix: `${q}Δ vs ${r.deltaRef ?? firstYear ?? "first frame"}`, signed: true };
  if (r.mode === "dtr") return { prefix: "DTR", signed: false };
  return { prefix: q.trim(), signed: false };
}

/**
 * Keyboard cell walking (UI_SPEC §12): index of the grid neighbour (dRow, dCol) of a cell, via
 * the canonical `cell_id = row · W + col`; −1 when the neighbour is outside the grid or the ROI.
 * @param {{n:number, cell_id: ArrayLike<number>, grid: {width:number|null}}} cells
 */
export function neighbourIndex(cells, index, dRow, dCol) {
  const W = Number(cells?.grid?.width);
  if (!cells?.cell_id || !Number.isInteger(index) || index < 0 || index >= cells.n || !(W > 0)) return -1;
  const id = cells.cell_id[index];
  const row = Math.floor(id / W) + dRow;
  const col = (id % W) + dCol;
  if (row < 0 || col < 0 || col >= W) return -1;
  const target = row * W + col;
  let lo = 0;
  let hi = cells.n - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = cells.cell_id[mid];
    if (v === target) return mid;
    if (v < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}
