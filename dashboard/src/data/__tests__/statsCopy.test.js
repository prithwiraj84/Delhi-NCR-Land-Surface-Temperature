import { beforeAll, describe, expect, it } from "vitest";
import { createBundleStore } from "../bundleStore.js";
import { ciExcludesZero, copyStats, copyTemplateIds, registerCopyTemplate, renderGuardedCopy, renderTemplate, signed } from "../copy.js";
import { createFixtureFetch, createSynthV2 } from "../fixtures/synthV2.js";
import { computeFrameStats, hotCoreFromValues } from "../frameStats.js";
import { deriveDtrSeries, resolveScopeId, scopeSeries, seriesValueAt, zoneShareAt } from "../series.js";

const synth = createSynthV2();
let ctx;

beforeAll(async () => {
  const store = createBundleStore({ fixtureLoader: async () => ({ synth, fetchImpl: createFixtureFetch(synth) }) });
  await store.getState().load({ source: { id: "fixture", baseUrl: null, explicit: true, reason: "test" } });
  const get = async (k) => (await store.getState().ensure(k)).data;
  ctx = {
    timeline: store.getState().timeline,
    series: await get("series"),
    cells: await get("cells"),
    metrics: await get("asset:metrics"),
    dayObs: await get("cube:day:obs"),
    day245: await get("cube:day:ssp245"),
  };
  ctx.cellAreaKm2 = (ctx.cells.grid.res / 1000) ** 2;
}, 60000);

describe("series", () => {
  it("resolves scopes, derives DTR (median only) and reads zone shares", () => {
    expect(resolveScopeId("z:3", "night")).toBe("z:night:3");
    expect(resolveScopeId("z:3", "dtr")).toBe("z:day:3");
    expect(resolveScopeId("d:4", "day")).toBe("d:4");
    const day = scopeSeries(ctx.series, "ncr", "day");
    const night = scopeSeries(ctx.series, "ncr", "night");
    const dtr = scopeSeries(ctx.series, "ncr", "dtr");
    expect(dtr).toEqual(deriveDtrSeries(day, night));
    expect(dtr.frames[7].mean).toBeCloseTo(day.frames[7].mean - night.frames[7].mean, 6);
    expect(dtr.frames[0].tier).toBe("modelled");
    expect(Number.isNaN(dtr.ssp.ssp245[0].p05)).toBe(true);
    expect(seriesValueAt(day, 2040, "ssp245")).toMatchObject({ kind: "projected", tier: "projected" });
    expect(seriesValueAt(day, 2041, "ssp245")).toBeNull();
    const share = zoneShareAt(ctx.series, "day", "obs", 2025);
    expect(share.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 3);
  });
});

describe("computeFrameStats (useFrameStats)", () => {
  const stats = (year, mode, ssp = "ssp245", cubes = {}) => computeFrameStats({ timeline: ctx.timeline, series: ctx.series, year, mode, ssp, cubes, cellAreaKm2: ctx.cellAreaKm2 });

  it("reads exact observed frames from the series (mean, CI, signed UHI, hot core, hottest district)", () => {
    const s = stats(2025, "day");
    const ncr = scopeSeries(ctx.series, "ncr", "day").frames.at(-1);
    expect(s).toMatchObject({ exact: true, interpolated: false, tier: "observed", kind: "observed", mean: ncr.mean, uhi: ncr.uhi });
    expect(s.uhi).toBeLessThan(0);
    expect(s.hotCorePct).toBeGreaterThan(0);
    expect(s.hotCorePct).toBeLessThan(100);
    expect(s.hottestDistrict.label).toBeTruthy();
    expect(stats(2025, "night").uhi).toBeGreaterThan(0);
  });

  it("uses the SSP fan for projections, counts hot core from the cube and never exports UHI", () => {
    const s = stats(2040, "day", "ssp245", { A: ctx.day245 });
    expect(s).toMatchObject({ kind: "projected", tier: "projected", uhi: null });
    expect(s.uhiReason).toMatch(/not exported for projected/);
    expect(s.p05).toBeLessThan(s.mean);
    expect(s.p95).toBeGreaterThan(s.mean);
    expect(s.hotCoreKm2).toBeGreaterThan(stats(2025, "day").hotCoreKm2 * 0.5);
    expect(stats(2040, "day", "ssp245").hotCoreKm2).toBeNull();
  });

  it("interpolates between frames, flags it and keeps the weaker tier", () => {
    const a = stats(2025, "night");
    const b = stats(2030, "night");
    const m = stats(2027, "night");
    expect(m).toMatchObject({ exact: false, interpolated: true, tier: "projected", kind: "transition" });
    expect(m.bracket).toMatchObject({ yA: 2025, yB: 2030 });
    expect(m.mean).toBeCloseTo(a.mean + 0.4 * (b.mean - a.mean), 6);
    expect(stats(1992, "night").tier).toBe("modelled");
    expect(hotCoreFromValues(Float32Array.from([1, 5, 9, NaN]), 5, 2)).toBe(4);
  });
});

describe("guarded copy (every template on the synthetic bundle)", () => {
  it("passes the guards the planted data supports and falls back otherwise", () => {
    const stats = copyStats({ timeline: ctx.timeline, series: ctx.series, metrics: ctx.metrics, cubes: { day: ctx.dayObs }, cellAreaKm2: ctx.cellAreaKm2 });
    expect(stats.uhi_day).toBeLessThan(0);
    expect(stats.uhi_night).toBeGreaterThan(0);
    const results = Object.fromEntries(copyTemplateIds().map((id) => [id, renderGuardedCopy(id, stats)]));
    expect(results.uhi_day.guardPassed).toBe(true);
    expect(results.uhi_day.text).toMatch(/^−\d\.\d °C by day: built-up land is cooler than the bare semi-arid fringe/);
    expect(results.uhi_night.guardPassed).toBe(true);
    expect(results.uhi_night.text).toMatch(/^\+\d\.\d °C at night/);
    expect(results.trend_day.guardPassed).toBe(false); // planted day trend CI includes 0
    expect(results.trend_day.text).toBe("No clear trend: year-to-year weather dominates.");
    expect(results.trend_night.guardPassed).toBe(true);
    expect(results.trend_night.text).toMatch(/^Night LST \+0\.\d+ °C per decade \(\+0\.\d+ to \+0\.\d+\), 2000–2025\.$/);
    expect(results.area_gt40.guardPassed).toBe(true);
    expect(results.area_gt40.text).toMatch(/km² above 40 °C by day in 2025\./);
    expect(results.skill_day.text).toBe("Spatial-block CV R² 0.86 (pooled, 20 km blocks): skill in unseen areas.");
    expect(results.projection_note.text).toBe("Model + CMIP6 scenario, not observations.");
    expect(results.hot_day_district.guardPassed).toBe(true);
    for (const r of Object.values(results)) expect(r.text).not.toMatch(/undefined|NaN|\{\{/);
  });

  it("uses the alternate wording when the data contradicts the claim", () => {
    const flipped = renderGuardedCopy("uhi_day", { uhi_day: 0.8 });
    expect(flipped.guardPassed).toBe(false);
    expect(flipped.text).toMatch(/^\+0\.8 °C by day: built-up land is warmer/);
    const missing = renderGuardedCopy("uhi_day", { uhi_day: null });
    expect(missing.guardPassed).toBe(false);
    expect(missing.unavailable).toMatch(/not available/);
    expect(renderGuardedCopy("skill_night", {}).text).toMatch(/not available/);
  });

  it("supports registered templates and survives throwing guards", () => {
    registerCopyTemplate("test_step", { copy: "{{a}} wins", altCopy: "{{a}} loses", guard: (s) => s.a > 1 });
    expect(renderGuardedCopy("test_step", { a: 2 }).text).toBe("2 wins");
    registerCopyTemplate("test_throw", { copy: "yes", altCopy: "no", guard: () => {
      throw new Error("bad guard");
    } });
    expect(renderGuardedCopy("test_throw", {}).text).toBe("no");
    expect(() => renderGuardedCopy("nope", {})).toThrow(/unknown copy template/);
    expect(() => registerCopyTemplate("x", { copy: 1 })).toThrow();
    expect(renderTemplate("{{missing}} / {{ a }}", { a: 0 })).toBe("— / 0");
    expect(signed(-1.64)).toBe("−1.6");
    expect(signed(0.04)).toBe("0.0");
    expect(signed(NaN)).toBe("—");
    expect(ciExcludesZero([0.1, 0.5])).toBe(true);
    expect(ciExcludesZero([-0.1, 0.5])).toBe(false);
  });
});
