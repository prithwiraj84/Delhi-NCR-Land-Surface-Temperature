/**
 * Guarded copy (UI_SPEC §1 principle 6, §3.11, §9): every headline is a template over bundle
 * numbers with a guard predicate and an alternate wording, so the UI never claims something the
 * data contradicts (e.g. a daytime heat island that is actually negative, or a trend whose CI
 * includes zero).
 *
 * `copyStats(input)` gathers the numbers once per bundle (NCR UHI by mode at NOW, exported
 * trends, area above 40 °C by day at NOW, headline skill, projection availability).
 * `renderGuardedCopy(templateId, stats)` evaluates a template → {text, guardPassed, vars}.
 * Templates can be extended at run time with `registerCopyTemplate` (Briefing steps, E4).
 */

import { cubeFrameIndex, decodeCubeFrame } from "./cubes.js";
import { hottestDistrictAt } from "./frameStats.js";
import { scopeSeries, seriesValueAt } from "./series.js";

const MINUS = "−";

/** Signed number with a true minus sign: −1.6 / +0.4. */
export function signed(v, dp = 1) {
  if (!Number.isFinite(v)) return "—";
  const s = Math.abs(v).toFixed(dp);
  if (Number(s) === 0) return (0).toFixed(dp);
  return `${v < 0 ? MINUS : "+"}${s}`;
}

const fixed = (v, dp = 1) => (Number.isFinite(v) ? v.toFixed(dp).replace("-", MINUS) : "—");
const grouped = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString("en-US") : "—");

/** Replace {{name}} placeholders; unknown names render as an em dash (never "undefined"). */
export function renderTemplate(template, vars = {}) {
  return String(template).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key) => {
    const v = vars[key];
    return v === null || v === undefined || v === "" ? "—" : String(v);
  });
}

/** True when a [lo, hi] interval excludes zero. */
export const ciExcludesZero = (ci) => Array.isArray(ci) && ci.length === 2 && ci.every(Number.isFinite) && (ci[0] > 0 || ci[1] < 0);

/**
 * Gather the statistics the built-in templates use.
 * @param {{timeline, series, metrics?, cubes?: {day?: Cube}, cellAreaKm2?: number}} input
 */
export function copyStats({ timeline, series, metrics = null, cubes = {}, cellAreaKm2 = 1 }) {
  const now = timeline?.now ?? null;
  const first = timeline?.obsYears?.[0] ?? timeline?.first ?? null;
  const at = (mode, year) => seriesValueAt(scopeSeries(series, "ncr", mode), year, null);
  const trend = (mode) => scopeSeries(series, "ncr", mode)?.trend?.obs ?? null;
  let areaGt40 = null;
  const dayCube = cubes.day ?? null;
  const f = dayCube ? cubeFrameIndex(dayCube, now) : -1;
  if (f >= 0) {
    const values = decodeCubeFrame(dayCube, f);
    let count = 0;
    for (let i = 0; i < values.length; i += 1) if (values[i] > 40) count += 1;
    areaGt40 = count * cellAreaKm2;
  }
  const headline = (mode) => metrics?.modes?.[mode]?.headline?.spatial ?? null;
  return {
    now,
    first_year: first,
    last_year: timeline?.last ?? null,
    uhi_day: at("day", now)?.uhi ?? null,
    uhi_night: at("night", now)?.uhi ?? null,
    mean_day: at("day", now)?.mean ?? null,
    mean_night: at("night", now)?.mean ?? null,
    trend_day: trend("day"),
    trend_night: trend("night"),
    area_gt40: areaGt40,
    hot_day_district: hottestDistrictAt(series, "day", now, null)?.label ?? null,
    skill_day: headline("day"),
    skill_night: headline("night"),
    projections: Boolean(timeline?.projYears?.length && timeline?.scenarios?.length),
    schema: timeline?.schema ?? null,
  };
}

const trendTemplate = (mode, label) => ({
  copy: `${label} LST {{slope}} °C per decade ({{ci_lo}} to {{ci_hi}}), {{period}}.`,
  // Only an exported CI that includes 0 means "no clear trend"; no exported trend is its own case.
  altCopy: "No clear trend: year-to-year weather dominates.",
  unavailable: (s) => {
    const t = s[`trend_${mode}`];
    return t && Number.isFinite(Number(t.slope_per_decade)) ? null : `${label}: no trend with a confidence interval is exported in this bundle — rerun notebook v2.`;
  },
  guard: (s) => {
    const t = s[`trend_${mode}`];
    return Boolean(t) && Number.isFinite(Number(t.slope_per_decade)) && ciExcludesZero(t.ci);
  },
  vars: (s) => {
    const t = s[`trend_${mode}`] ?? {};
    return {
      slope: signed(Number(t.slope_per_decade), 2),
      ci_lo: signed(Number(t.ci?.[0]), 2),
      ci_hi: signed(Number(t.ci?.[1]), 2),
      period: Array.isArray(t.period) ? `${t.period[0]}–${t.period[1]}` : null,
    };
  },
});

const skillTemplate = (mode) => ({
  copy: "Spatial-block CV R² {{r2}} (pooled, 20 km blocks): skill in unseen areas.",
  altCopy: "Spatial-block CV skill is not available in this bundle.",
  guard: (s) => Number.isFinite(Number(s[`skill_${mode}`]?.r2)),
  vars: (s) => ({ r2: fixed(Number(s[`skill_${mode}`]?.r2), 2), rmse: fixed(Number(s[`skill_${mode}`]?.rmse), 2) }),
});

const BUILTIN = {
  uhi_day: {
    copy: "{{uhi}} °C by day: built-up land is cooler than the bare semi-arid fringe at mid-morning.",
    altCopy: "{{uhi}} °C by day: built-up land is warmer than its rural surroundings at mid-morning.",
    guard: (s) => Number.isFinite(s.uhi_day) && s.uhi_day < 0,
    vars: (s) => ({ uhi: signed(s.uhi_day) }),
    unavailable: (s) => (Number.isFinite(s.uhi_day) ? null : "Surface UHI (urban − rural) is not available for this frame."),
  },
  uhi_night: {
    copy: "{{uhi}} °C at night: built-up land holds its heat after dark — the island flips.",
    altCopy: "{{uhi}} °C at night: no night-time surface heat island in this bundle.",
    guard: (s) => Number.isFinite(s.uhi_night) && s.uhi_night > 0,
    vars: (s) => ({ uhi: signed(s.uhi_night) }),
    unavailable: (s) => (Number.isFinite(s.uhi_night) ? null : "Night-time surface UHI is unavailable — this bundle has no night LST."),
  },
  trend_day: trendTemplate("day", "Day"),
  trend_night: trendTemplate("night", "Night"),
  area_gt40: {
    copy: "{{area}} km² above 40 °C by day in {{now}}.",
    altCopy: "No land above 40 °C by day in {{now}}.",
    guard: (s) => Number.isFinite(s.area_gt40) && s.area_gt40 > 0,
    vars: (s) => ({ area: grouped(s.area_gt40), now: s.now }),
    unavailable: (s) => (s.area_gt40 === null ? "Day frame for NOW is not loaded yet." : null),
  },
  hot_day_district: {
    copy: "Day: the hottest land is the bare fringe ({{district}}).",
    altCopy: "Day: the hottest district is {{district}}.",
    guard: (s) => Number.isFinite(s.uhi_day) && s.uhi_day < 0 && Boolean(s.hot_day_district),
    vars: (s) => ({ district: s.hot_day_district }),
  },
  skill_day: skillTemplate("day"),
  skill_night: skillTemplate("night"),
  projection_note: {
    copy: "Model + CMIP6 scenario, not observations.",
    altCopy: "No projections in this bundle — rerun notebook v2.",
    guard: (s) => s.projections === true,
    vars: () => ({}),
  },
};

const registry = new Map(Object.entries(BUILTIN));

/**
 * Register (or replace) a template.
 * @param {string} id
 * @param {{copy: string, altCopy: string, guard: (stats) => boolean, vars?: (stats) => object,
 *          unavailable?: (stats) => string|null}} template
 */
export function registerCopyTemplate(id, template) {
  if (!id || typeof template?.copy !== "string" || typeof template?.guard !== "function") {
    throw new Error("registerCopyTemplate(id, {copy, altCopy, guard, vars?}) needs a copy string and a guard function");
  }
  registry.set(id, template);
}

export const copyTemplateIds = () => [...registry.keys()];

/**
 * Evaluate a template against stats.
 * @returns {{text: string, guardPassed: boolean, vars: object, templateId: string, unavailable: string|null}}
 * @throws {Error} for an unknown template id
 */
export function renderGuardedCopy(templateId, stats) {
  const t = registry.get(templateId);
  if (!t) throw new Error(`unknown copy template "${templateId}"`);
  let guardPassed = false;
  try {
    guardPassed = Boolean(t.guard(stats ?? {}));
  } catch (error) {
    console.warn(`[copy] guard of "${templateId}" threw; using the alternate copy`, error);
  }
  const vars = { ...(stats ?? {}), ...(t.vars?.(stats ?? {}) ?? {}) };
  const unavailable = t.unavailable?.(stats ?? {}) ?? null;
  const text = unavailable ?? renderTemplate(guardPassed ? t.copy : t.altCopy ?? t.copy, vars);
  return { text, guardPassed: guardPassed && !unavailable, vars, templateId, unavailable };
}
