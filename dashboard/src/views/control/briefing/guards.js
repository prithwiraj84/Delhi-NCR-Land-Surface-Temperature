/**
 * Briefing guards (UI_SPEC_v2 §1 principle 6, §3.11, §9): the numbers the guarded story is
 * allowed to claim, and the predicates that decide between a step's copy and its alternate.
 *
 * `briefingStats` extends data/copy.js `copyStats` (signed NCR surface UHI by mode at NOW,
 * exported trends, area above 40 °C by day at NOW, headline skill, projection availability)
 * with what the Briefing steps need: first-frame provenance, night availability, scenario ids
 * and 2050 medians, what-if readiness and AOA coverage. Every guard is a pure function of these
 * stats and is unit-tested on the synthetic v2 fixture AND the user's real v1 bundle (whose
 * daytime surface UHI is negative — the copy must read negative).
 */

import { ciExcludesZero, copyStats, signed } from "../../../data/copy.js";
import { hottestDistrictAt } from "../../../data/frameStats.js";
import { scopeSeries, seriesValueAt } from "../../../data/series.js";
import { frameAt, modeAvailable } from "../../../data/timeline.js";
import { fmt, fmtSsp } from "../../../lib/format.js";
import { skillHeadline, windowLabel } from "../controlModel.js";

const finite = (v) => typeof v === "number" && Number.isFinite(v);

/** Preset id of the canonical what-if step ("+20 % tree canopy in Gurugram", lib/scenario.js). */
export const WHATIF_PRESET_ID = "gurugram-canopy";

/**
 * @param {{timeline: object, series: object, metrics?: object|null, dayCube?: object|null,
 *          cellAreaKm2?: number, presets?: Array<{id:string, scenario:object}>, modelReady?: boolean,
 *          districts?: Array<{id:number, name:string}>}} input
 */
export function briefingStats({ timeline, series, metrics = null, dayCube = null, cellAreaKm2 = 1, presets = [], modelReady = false, districts = [] }) {
  const base = copyStats({ timeline, series, metrics, cubes: { day: dayCube }, cellAreaKm2 });
  const now = timeline?.now ?? null;
  const first = base.first_year;
  const firstFrame = first !== null ? frameAt(timeline, first) : null;
  const ids = timeline?.scenarioIds ?? [];
  const last = timeline?.projYears?.length ? timeline.projYears[timeline.projYears.length - 1] : null;
  const dayNcr = scopeSeries(series, "ncr", "day");
  const p50At = (id) => (last !== null ? seriesValueAt(dayNcr, last, id)?.mean ?? null : null);
  const preset = presets.find((p) => p.id === WHATIF_PRESET_ID) ?? null;
  const regionId = preset?.scenario?.region?.ids?.[0];
  const whatifDistrict = districts.find((d) => d.id === regionId)?.name ?? (regionId !== undefined ? `district ${regionId}` : null);
  const xaiDayYears = (timeline?.frames ?? []).filter((f) => f.xai?.day).map((f) => f.year);
  const whatifYear = xaiDayYears.length ? xaiDayYears.reduce((best, y) => (Math.abs(y - now) < Math.abs(best - now) ? y : best), xaiDayYears[0]) : null;
  const pctInside = metrics?.modes?.day?.aoa?.pct_inside;
  const aoaPct = pctInside ? Number(pctInside[String(now)] ?? NaN) : NaN;
  const skill = skillHeadline(metrics, "day");
  return {
    ...base,
    night_available: modeAvailable(timeline, "night"),
    hot_night_district: modeAvailable(timeline, "night") ? hottestDistrictAt(series, "night", now, null)?.label ?? null : null,
    first_sensor: firstFrame?.day?.sensor ?? null,
    first_tier: firstFrame?.day?.tier ?? null,
    first_window: windowLabel(firstFrame?.window),
    scenario_ids: ids,
    has_ssp126: ids.includes("ssp126"),
    has_ssp245: ids.includes("ssp245"),
    has_ssp585: ids.includes("ssp585"),
    first_proj: timeline?.projYears?.[0] ?? null,
    last_proj: last,
    p50_last: Object.fromEntries(ids.map((id) => [id, p50At(id)])),
    scenario_labels: Object.fromEntries((timeline?.scenarios ?? []).map((s) => [s.id, s.label ?? fmtSsp(s.id)])),
    whatif_ready: Boolean(modelReady && preset && whatifYear !== null),
    whatif_preset: preset,
    whatif_district: whatifDistrict,
    whatif_district_id: Number.isInteger(regionId) ? regionId : null,
    whatif_year: whatifYear,
    aoa_pct_inside: finite(aoaPct) ? aoaPct : null,
    skill,
  };
}

// ---------------------------------------------------------------------------------------
// Guard predicates (pure; each returns a boolean, never throws on missing data)
// ---------------------------------------------------------------------------------------

export const guards = Object.freeze({
  /** Step 0: there is land above 40 °C by day at NOW. */
  areaAbove40: (s) => finite(s?.area_gt40) && s.area_gt40 > 0,
  /** Step 2: the DAYTIME surface UHI is negative (built-up cooler than the bare fringe). */
  dayUhiNegative: (s) => finite(s?.uhi_day) && s.uhi_day < 0,
  /** Step 3: the night-time surface UHI is positive (the island flips). */
  nightUhiPositive: (s) => Boolean(s?.night_available) && finite(s?.uhi_night) && s.uhi_night > 0,
  /** Step 4: the exported day trend's CI excludes 0 (never inferred from frame means). */
  dayTrendSignificant: (s) => Boolean(s?.trend_day) && finite(Number(s.trend_day.slope_per_decade)) && ciExcludesZero(s.trend_day.ci),
  /** Step 5: projections exist (frames after NOW and at least one scenario). */
  projectionsExist: (s) => s?.projections === true && finite(s?.first_proj),
  /** Step 6: both ends of the scenario range exist (SSP1-2.6 and SSP5-8.5). */
  scenarioPairExists: (s) => Boolean(s?.has_ssp126 && s?.has_ssp585 && finite(s?.last_proj)),
  /** Step 7: the what-if engine can run the canonical preset. */
  whatifReady: (s) => s?.whatif_ready === true,
  /** Step 8: a headline skill number exists. */
  skillExists: (s) => finite(s?.skill?.r2),
});

/** Formatted variables used by the step templates. */
export function briefingVars(s) {
  const trend = s?.trend_day ?? null;
  const ids = s?.scenario_ids ?? [];
  const a = s?.has_ssp126 ? "ssp126" : ids[0] ?? null;
  const b = s?.has_ssp585 ? "ssp585" : ids[ids.length - 1] ?? null;
  const label = (id) => (id ? s?.scenario_labels?.[id] ?? fmtSsp(id) : null);
  const selected = s?.has_ssp245 ? "ssp245" : ids[0] ?? null;
  return {
    now: s?.now,
    first_year: s?.first_year,
    last_year: s?.last_proj ?? s?.last_year,
    area_gt40: finite(s?.area_gt40) ? Math.round(s.area_gt40).toLocaleString("en-US") : null,
    uhi_day: finite(s?.uhi_day) ? signed(s.uhi_day) : null,
    uhi_night: finite(s?.uhi_night) ? signed(s.uhi_night) : null,
    hot_day_district: s?.hot_day_district,
    hot_night_district: s?.hot_night_district,
    first_sensor: s?.first_sensor,
    first_tier: s?.first_tier,
    first_window: s?.first_window,
    first_record: s?.first_sensor ? `${s.first_sensor}${s.first_window ? `, ${s.first_window}` : ""}` : null,
    trend_slope: trend ? signed(Number(trend.slope_per_decade), 2) : null,
    trend_ci: trend?.ci ? `${signed(Number(trend.ci[0]), 2)} to ${signed(Number(trend.ci[1]), 2)}` : null,
    ssp_selected: selected,
    ssp_label: label(selected),
    ssp_a: a,
    ssp_b: b,
    ssp_a_label: label(a),
    ssp_b_label: label(b),
    p50_a: finite(s?.p50_last?.[a]) ? fmt(s.p50_last[a], 1) : null,
    p50_b: finite(s?.p50_last?.[b]) ? fmt(s.p50_last[b], 1) : null,
    whatif_district: s?.whatif_district,
    skill_label: s?.skill?.label ?? null,
    aoa_text: finite(s?.aoa_pct_inside) ? `${fmt(s.aoa_pct_inside <= 1 ? s.aoa_pct_inside * 100 : s.aoa_pct_inside, 0)} % of cells lie inside the area of applicability in ${s.now}.` : "Hatched cells lie outside the model's area of applicability.",
  };
}
