/**
 * Briefing steps (UI_SPEC_v2 §3.11): a guarded, templated story delivered as a stepped caption
 * card on Control. Each step has
 *   - `copy` with {{vars}} (shown when `guard(stats)` passes) and `altCopy` (shown otherwise),
 *   - optional `unavailable(stats)` → text when the data needed is not in this bundle at all,
 *   - `state(stats, passed)` → the map state the step sets: {year, mode, ssp, variable, layer,
 *     cmp, camera, play, scenario}.
 * `evaluateStep` renders one step; `applyBriefingState` pushes a step's state into the §7
 * stores (and dispatches the shell's fly-to event for the camera).
 *
 * The copy never claims what the data contradicts: on the real v1 bundle the daytime surface
 * UHI is negative, so step 2 reads "−x.x °C by day: built-up land is cooler …"; the trend step
 * only quotes a slope when the EXPORTED trend CI excludes 0 (v1 exports none).
 */

import { renderTemplate } from "../../../data/copy.js";
import { briefingVars, guards } from "./guards.js";

/** @typedef {{year?:number, mode?:string, ssp?:string, variable?:string, layer?:string,
 *             cmp?: object|null, camera?: object|null, play?: {stopAt:number}|null, scenario?: string|null}} StepState */

export const BRIEFING_STEPS = Object.freeze([
  Object.freeze({
    id: "heat-now",
    title: "Heat today",
    copy: "{{area_gt40}} km² above 40 °C by day in {{now}}.",
    altCopy: "No land above 40 °C by day in {{now}}.",
    guard: guards.areaAbove40,
    unavailable: (s) => (s.area_gt40 === null || s.area_gt40 === undefined ? "Area above 40 °C appears once the day frame of {{now}} has loaded." : null),
    state: (s) => ({ year: s.now, mode: "day", variable: "abs", layer: "lst", cmp: null, camera: { home: true } }),
  }),
  Object.freeze({
    id: "baseline",
    title: "The baseline",
    copy: "{{first_year}}: the first frame of the record — {{first_record}}.",
    altCopy: "{{first_year}}: the first frame of the record.",
    unavailable: (s) => (s.first_sensor ? null : "{{first_year}}: the first frame of the record (no sensor metadata in this bundle)."),
    guard: (s) => Boolean(s.first_sensor),
    state: (s) => ({ year: s.first_year, mode: "day", variable: "abs", layer: "lst", cmp: null }),
  }),
  Object.freeze({
    id: "day-fringe",
    title: "Day: the bare fringe is hottest",
    copy: "Day: the hottest land is the bare fringe ({{hot_day_district}}). Surface UHI (urban − rural) {{uhi_day}} °C by day: built-up land is cooler than the bare semi-arid fringe at mid-morning.",
    altCopy: "Day: the city is hottest. Surface UHI (urban − rural) {{uhi_day}} °C by day: built-up land is warmer than its rural surroundings ({{hot_day_district}} is the hottest district).",
    guard: guards.dayUhiNegative,
    unavailable: (s) => (Number.isFinite(s.uhi_day) ? null : "Surface UHI (urban − rural) is not available for {{now}} by day."),
    state: (s) => ({ year: s.now, mode: "day", variable: "suhi", layer: "lst", cmp: null }),
  }),
  Object.freeze({
    id: "night-flip",
    title: "Night: the island flips",
    copy: "Night: the island flips. Surface UHI (urban − rural) {{uhi_night}} °C at night — built-up land holds its heat after dark.",
    altCopy: "Night: no night-time surface heat island in this bundle (Surface UHI (urban − rural) {{uhi_night}} °C at night).",
    guard: guards.nightUhiPositive,
    unavailable: (s) => (s.night_available ? (Number.isFinite(s.uhi_night) ? null : "Night-time surface UHI is not exported for {{now}}.") : "Night is unavailable in this bundle — rerun notebook v2 for night LST."),
    state: (s) => (s.night_available ? { year: s.now, mode: "night", variable: "suhi", layer: "lst", cmp: null } : { year: s.now, mode: "day", variable: "suhi", layer: "lst", cmp: null }),
  }),
  Object.freeze({
    id: "playback",
    title: "{{first_year}} → {{now}}",
    copy: "{{first_year}} → {{now}}: day LST {{trend_slope}} °C per decade ({{trend_ci}}, exported trend with CI).",
    altCopy: "{{first_year}} → {{now}}: no clear trend — year-to-year weather dominates.",
    guard: guards.dayTrendSignificant,
    // "No clear trend" only when an exported CI includes 0; a bundle without a trend says so.
    unavailable: (s) => (s.trend_day && Number.isFinite(Number(s.trend_day.slope_per_decade)) ? null : "{{first_year}} → {{now}}: no trend with a confidence interval is exported in this bundle — rerun notebook v2."),
    state: (s) => ({ year: s.first_year, mode: "day", variable: "abs", layer: "lst", cmp: null, play: { stopAt: s.now } }),
  }),
  Object.freeze({
    id: "cross-now",
    title: "Crossing NOW",
    copy: "Crossing NOW into {{ssp_label}}: model + CMIP6 scenario, not observations.",
    altCopy: "No projections in this bundle — rerun notebook v2 for 2030–2050.",
    guard: guards.projectionsExist,
    state: (s, passed) => (passed ? { year: s.now, mode: "day", ssp: briefingVars(s).ssp_selected, variable: "abs", layer: "lst", cmp: null, play: { stopAt: s.first_proj } } : { year: s.now, mode: "day", variable: "abs", layer: "lst", cmp: null }),
  }),
  Object.freeze({
    id: "scenarios-2050",
    title: "{{last_year}}: low vs high emissions",
    copy: "{{last_year}}: {{ssp_a_label}} vs {{ssp_b_label}} — NCR day mean {{p50_a}} vs {{p50_b}} °C (p50; model + CMIP6 scenario, not observations).",
    altCopy: "Scenario comparison needs SSP1-2.6 and SSP5-8.5 projections — not in this bundle.",
    guard: guards.scenarioPairExists,
    state: (s, passed) => {
      const v = briefingVars(s);
      return passed ? { year: s.last_proj, mode: "day", variable: "abs", layer: "lst", cmp: { kind: "s", a: v.ssp_a, b: v.ssp_b } } : { year: s.now, mode: "day", variable: "abs", layer: "lst", cmp: null };
    },
  }),
  Object.freeze({
    id: "whatif",
    title: "What-if: tree canopy",
    copy: "What-if: +20 % tree canopy in {{whatif_district}} — a model counterfactual on the current land, not a forecast.",
    altCopy: "The what-if simulator is not ready for this bundle (it needs a frame with drivers and the web model).",
    guard: guards.whatifReady,
    state: (s, passed) =>
      passed
        ? { year: s.whatif_year, mode: "day", variable: "abs", layer: "whatif", cmp: null, scenario: s.whatif_preset?.id ?? null, camera: s.whatif_district_id !== null ? { districtId: s.whatif_district_id } : null }
        : { year: s.now, mode: "day", variable: "abs", layer: "lst", cmp: null },
  }),
  Object.freeze({
    id: "how-sure",
    title: "How sure are we?",
    copy: "{{skill_label}}. {{aoa_text}}",
    altCopy: "Skill metrics are not in this bundle. {{aoa_text}}",
    guard: guards.skillExists,
    state: (s) => ({ year: s.now, mode: "day", variable: "abs", layer: s.schema === "v1" ? "lst" : "aoa", cmp: null, camera: { home: true } }),
  }),
]);

/**
 * Render one step against the briefing stats.
 * @returns {{id, index, title, text, guardPassed, unavailable: boolean, state: StepState}}
 */
export function evaluateStep(step, stats, index = 0) {
  const vars = briefingVars(stats ?? {});
  let passed = false;
  try {
    passed = Boolean(step.guard(stats ?? {}));
  } catch (error) {
    console.warn(`[briefing] guard of "${step.id}" threw; using the alternate copy`, error);
  }
  const unavailableText = step.unavailable?.(stats ?? {}) ?? null;
  const template = unavailableText ?? (passed ? step.copy : step.altCopy);
  return {
    id: step.id,
    index,
    title: renderTemplate(step.title, vars),
    text: renderTemplate(template, vars),
    guardPassed: passed && !unavailableText,
    unavailable: Boolean(unavailableText),
    state: step.state(stats ?? {}, passed && !unavailableText),
  };
}

/** Evaluate every step. */
export function evaluateBriefing(stats, steps = BRIEFING_STEPS) {
  return steps.map((s, i) => evaluateStep(s, stats, i));
}

/**
 * Apply a step's state to the stores.
 * @param {StepState} state
 * @param {{time: object, view: object, playback?: object, setScenario?: (scenario:object)=>void,
 *          presets?: Array, win?: Window, play?: boolean}} ctx
 *   `play` = honour `state.play` (false when the user is stepping back through the card).
 */
export function applyBriefingState(state, { time, view, playback = null, setScenario = null, presets = [], win = typeof window !== "undefined" ? window : null, play = true }) {
  if (!state) return;
  const t = time.getState();
  if (t.playing) t.pause();
  if (state.mode) t.setMode(state.mode);
  if (state.ssp) t.setSsp(state.ssp);
  if (state.cmp === null) t.setCompare(null);
  else if (state.cmp) t.setCompare(state.cmp);
  if (Number.isFinite(state.year)) t.setYear(state.year, { snap: true });
  const v = view.getState();
  if (state.variable && v.variable !== state.variable) v.setVariable(state.variable);
  if (state.layer) v.setLayer(state.layer);
  if (state.scenario && setScenario) {
    const preset = presets.find((p) => p.id === state.scenario);
    if (preset) setScenario(preset.scenario);
  }
  if (state.camera && win?.dispatchEvent && typeof win.CustomEvent === "function") {
    win.dispatchEvent(new win.CustomEvent("ncr:fly-to", { detail: { ...state.camera, source: "briefing" } }));
  }
  if (play && state.play && Number.isFinite(state.play.stopAt)) {
    playback?.getState?.().setStopAt?.(state.play.stopAt);
    time.getState().play();
  }
}
