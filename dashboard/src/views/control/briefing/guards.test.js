/**
 * Every Briefing guard on the synthetic v2 fixture AND on the user's REAL v1 bundle
 * (public/data, read-only) — UI_SPEC §3.11 / §15 acceptance: "Every Briefing guard is tested
 * on the real and synthetic bundles. The daytime UHI copy reads as negative on the real bundle."
 * Also checks that applying a step's state drives the §7 stores as specified.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { create } from "zustand";
import { createBundleStore } from "../../../data/bundleStore.js";
import { createFixtureFetch, createSynthV2 } from "../../../data/fixtures/synthV2.js";
import { scopeSeries } from "../../../data/series.js";
import { groupFeatureMetas } from "../../../data/xai.js";
import { presetsFor } from "../../../lib/scenario.js";
import { createFsFetch, PUBLIC_DATA_DIR, publicDataExists, readJson } from "../../../lib/__tests__/testUtils.js";
import { v1ManifestView } from "../../../state/contextLogic.js";
import { timeStoreInitializer } from "../../../state/stores/timeStore.js";
import { viewStoreInitializer } from "../../../state/stores/viewStore.js";
import { briefingStats, briefingVars, guards, WHATIF_PRESET_ID } from "./guards.js";
import { applyBriefingState, BRIEFING_STEPS, evaluateBriefing, evaluateStep } from "./steps.js";

/** Load a bundle through the real BundleStore and gather what the Briefing reads. */
async function loadContext(store, { source }) {
  await store.getState().load({ source });
  const s = store.getState();
  expect(s.status).toBe("ready");
  const get = async (key) => {
    const r = await s.ensure(key);
    return r.status === "ready" ? r.data : null;
  };
  const timeline = s.timeline;
  const manifest = s.manifest;
  const cells = await get("cells");
  const series = await get("series");
  const metrics = await get("asset:metrics");
  const dayCube = await get("cube:day:obs");
  const model = await get("model:day");
  const facade = s.schema === "v2" ? v1ManifestView(manifest, { schema: "v2", mode: "day", timeline, groupFeatures: groupFeatureMetas(manifest) }) : manifest;
  const zones = await get("asset:zones");
  const presets = presetsFor(facade, zones?.modes?.day ?? zones ?? null);
  const cellAreaKm2 = ((cells?.grid?.res ?? 1000) / 1000) ** 2;
  const stats = briefingStats({ timeline, series, metrics, dayCube, cellAreaKm2, presets, modelReady: Boolean(model), districts: manifest.districts ?? [] });
  return { timeline, series, metrics, dayCube, stats, presets, model, schema: s.schema };
}

const stepById = (id) => BRIEFING_STEPS.find((s) => s.id === id);

function storesFor(timeline) {
  const time = create(timeStoreInitializer);
  time.getState().configure(timeline);
  const view = create(viewStoreInitializer);
  const playback = create((set) => ({ stopAt: null, setStopAt: (y) => set({ stopAt: y }) }));
  return { time, view, playback };
}

// ---------------------------------------------------------------------------------------
// Synthetic v2 fixture
// ---------------------------------------------------------------------------------------

describe("Briefing guards on the synthetic v2 fixture", () => {
  let ctx;
  beforeAll(async () => {
    const synth = createSynthV2();
    const store = createBundleStore({ fixtureLoader: async () => ({ synth, fetchImpl: createFixtureFetch(synth) }) });
    ctx = await loadContext(store, { source: { id: "fixture", baseUrl: null, explicit: true, reason: "test" } });
  }, 120000);

  it("evaluates all nine steps with no unresolved template variables", () => {
    const out = evaluateBriefing(ctx.stats);
    expect(out).toHaveLength(9);
    for (const step of out) {
      expect(step.text).not.toMatch(/\{\{|undefined|NaN|null/);
      expect(step.title).not.toMatch(/\{\{/);
      expect(step.state).toBeTruthy();
    }
  });

  it("day UHI is negative and night UHI positive in the planted synthetic world", () => {
    expect(ctx.stats.uhi_day).toBeLessThan(0);
    expect(guards.dayUhiNegative(ctx.stats)).toBe(true);
    const day = evaluateStep(stepById("day-fringe"), ctx.stats);
    expect(day.guardPassed).toBe(true);
    expect(day.text).toMatch(/Surface UHI \(urban − rural\) −\d+\.\d °C by day: built-up land is cooler/);
    expect(guards.nightUhiPositive(ctx.stats)).toBe(true);
    const night = evaluateStep(stepById("night-flip"), ctx.stats);
    expect(night.text).toMatch(/\+\d+\.\d °C at night/);
    expect(night.state).toMatchObject({ mode: "night", variable: "suhi" });
  });

  it("area above 40 °C, trend, projections and the scenario pair follow the bundle", () => {
    expect(guards.areaAbove40(ctx.stats)).toBe(ctx.stats.area_gt40 > 0);
    const trend = scopeSeries(ctx.series, "ncr", "day").trend?.obs;
    const significant = Boolean(trend) && (trend.ci[0] > 0 || trend.ci[1] < 0);
    expect(guards.dayTrendSignificant(ctx.stats)).toBe(significant);
    const play = evaluateStep(stepById("playback"), ctx.stats);
    expect(play.text).toMatch(significant ? /°C per decade/ : /no clear trend/);
    expect(play.state.play.stopAt).toBe(ctx.timeline.now);
    expect(guards.projectionsExist(ctx.stats)).toBe(true);
    const cross = evaluateStep(stepById("cross-now"), ctx.stats);
    expect(cross.text).toMatch(/model \+ CMIP6 scenario, not observations/);
    expect(cross.state.play.stopAt).toBe(ctx.timeline.projYears[0]);
    expect(guards.scenarioPairExists(ctx.stats)).toBe(true);
    const pair = evaluateStep(stepById("scenarios-2050"), ctx.stats);
    expect(pair.state.cmp).toEqual({ kind: "s", a: "ssp126", b: "ssp585" });
    expect(Number(briefingVars(ctx.stats).p50_b)).toBeGreaterThan(Number(briefingVars(ctx.stats).p50_a));
  });

  it("what-if readiness requires the canonical preset and the web model", () => {
    const hasPreset = ctx.presets.some((p) => p.id === WHATIF_PRESET_ID);
    expect(guards.whatifReady(ctx.stats)).toBe(Boolean(hasPreset && ctx.model));
    expect(guards.whatifReady({ ...ctx.stats, whatif_ready: false })).toBe(false);
    const step = evaluateStep(stepById("whatif"), ctx.stats);
    expect(step.state.layer).toBe(step.guardPassed ? "whatif" : "lst");
  });

  it("how-sure quotes the pooled spatial-block headline and the AOA", () => {
    const step = evaluateStep(stepById("how-sure"), ctx.stats);
    expect(guards.skillExists(ctx.stats)).toBe(true);
    expect(ctx.stats.skill.pooled).toBe(true);
    expect(step.text).toMatch(/Spatial-block CV R² \d\.\d\d \(pooled, 20 km blocks\)/);
    expect(step.state.layer).toBe("aoa");
  });

  it("applying steps drives the stores (year snapped, mode, variable, compare, bounded playback)", () => {
    const { time, view, playback } = storesFor(ctx.timeline);
    const out = evaluateBriefing(ctx.stats);
    applyBriefingState(out[3].state, { time, view, playback, win: null });
    expect(time.getState()).toMatchObject({ year: ctx.timeline.now, mode: "night" });
    expect(view.getState().variable).toBe("suhi");
    applyBriefingState(out[6].state, { time, view, playback, win: null });
    expect(time.getState().compare).toMatchObject({ kind: "s", a: "ssp126", b: "ssp585" });
    expect(time.getState().year).toBe(ctx.timeline.last);
    applyBriefingState(out[4].state, { time, view, playback, win: null });
    expect(time.getState().compare.kind).toBeNull();
    expect(time.getState().year).toBe(ctx.timeline.first);
    expect(time.getState().playing).toBe(true);
    expect(playback.getState().stopAt).toBe(ctx.timeline.now);
    applyBriefingState(out[0].state, { time, view, playback, win: null, play: false });
    expect(time.getState().playing).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// The user's REAL v1 bundle (read-only)
// ---------------------------------------------------------------------------------------

const realV1 = publicDataExists("manifest.json") && String(readJson(PUBLIC_DATA_DIR, "manifest.json").schema_version ?? "").startsWith("1");

describe.skipIf(!realV1)("Briefing guards on the REAL v1 bundle", () => {
  let ctx;
  beforeAll(async () => {
    const store = createBundleStore({ fetchImpl: createFsFetch(PUBLIC_DATA_DIR) });
    ctx = await loadContext(store, { source: { id: "data", baseUrl: "/data", explicit: true, reason: "test" } });
  }, 180000);

  it("reads the daytime surface UHI as NEGATIVE (built-up land cooler by day)", () => {
    expect(ctx.stats.uhi_day).toBeLessThan(0);
    expect(guards.dayUhiNegative(ctx.stats)).toBe(true);
    const step = evaluateStep(stepById("day-fringe"), ctx.stats);
    expect(step.guardPassed).toBe(true);
    expect(step.text).toMatch(/Surface UHI \(urban − rural\) −\d+\.\d °C by day: built-up land is cooler than the bare semi-arid fringe/);
    expect(step.text).not.toMatch(/\+\d+\.\d °C by day/);
  });

  it("has no night, no exported trend and no projections — every claim falls back honestly", () => {
    expect(guards.nightUhiPositive(ctx.stats)).toBe(false);
    const night = evaluateStep(stepById("night-flip"), ctx.stats);
    expect(night.unavailable).toBe(true);
    expect(night.text).toMatch(/Night is unavailable in this bundle — rerun notebook v2/);
    expect(night.state.mode).toBe("day");

    expect(guards.dayTrendSignificant(ctx.stats)).toBe(false);
    // v1 exports no trend: the step says so instead of "no clear trend" (which needs a CI with 0).
    expect(evaluateStep(stepById("playback"), ctx.stats).text).toMatch(/no trend with a confidence interval is exported in this bundle — rerun notebook v2/);
    expect(evaluateStep(stepById("playback"), ctx.stats).text).not.toMatch(/no clear trend/);
    expect(evaluateStep(stepById("playback"), { ...ctx.stats, trend_day: { slope_per_decade: 0.2, ci: [-0.1, 0.5] } }).text).toMatch(/no clear trend — year-to-year weather dominates/);

    expect(guards.projectionsExist(ctx.stats)).toBe(false);
    const cross = evaluateStep(stepById("cross-now"), ctx.stats);
    expect(cross.text).toMatch(/No projections in this bundle/);
    expect(cross.state.play).toBeUndefined();

    expect(guards.scenarioPairExists(ctx.stats)).toBe(false);
    expect(evaluateStep(stepById("scenarios-2050"), ctx.stats).state.cmp).toBeNull();
  });

  it("area above 40 °C is computed from the real day cube and the skill is labelled as v1 mean-of-folds", () => {
    expect(Number.isFinite(ctx.stats.area_gt40)).toBe(true);
    expect(guards.areaAbove40(ctx.stats)).toBe(ctx.stats.area_gt40 > 0);
    const heat = evaluateStep(stepById("heat-now"), ctx.stats);
    expect(heat.text).toMatch(ctx.stats.area_gt40 > 0 ? /km² above 40 °C by day in 2025/ : /No land above 40 °C/);
    const sure = evaluateStep(stepById("how-sure"), ctx.stats);
    expect(guards.skillExists(ctx.stats)).toBe(true);
    expect(ctx.stats.skill.pooled).toBe(false);
    expect(sure.text).toMatch(/v1: mean of per-fold R²/);
    expect(sure.state.layer).toBe("lst");
  });

  it("the what-if step runs the Gurugram canopy preset on the real web model", () => {
    expect(ctx.presets.some((p) => p.id === WHATIF_PRESET_ID)).toBe(true);
    expect(guards.whatifReady(ctx.stats)).toBe(true);
    const step = evaluateStep(stepById("whatif"), ctx.stats);
    expect(step.text).toMatch(/\+20 % tree canopy in Gurugram/);
    expect(step.state).toMatchObject({ layer: "whatif", scenario: WHATIF_PRESET_ID, camera: { districtId: 1 } });
  });

  it("every step renders without unresolved variables or empty-placeholder dashes", () => {
    for (const step of evaluateBriefing(ctx.stats)) expect(step.text).not.toMatch(/\{\{|undefined|NaN|null|\)—|—\./);
    expect(evaluateStep(stepById("baseline"), ctx.stats).text).toMatch(/^2010: the first frame of the record — MODIS Terra/);
  });
});
