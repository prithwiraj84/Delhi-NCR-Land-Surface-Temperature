import { beforeAll, describe, expect, it } from "vitest";
import { prepareEpoch } from "../../lib/data.js";
import { validateBundle } from "../../lib/validate.js";
import { createFsFetch, fixture, PUBLIC_DATA_DIR, publicDataExists, readJson } from "../../lib/__tests__/testUtils.js";
import { createBundleStore } from "../bundleStore.js";
import { copyStats, renderGuardedCopy } from "../copy.js";
import { cellValues, decodeCubeFrame } from "../cubes.js";
import { scopeSeries } from "../series.js";
import { frameTierInfo, modeAvailable, tierOf } from "../timeline.js";
import { adaptV1Bundle, assetForMode, frameScopeStats, inferGridWidth, wrapV1Asset } from "../v1Adapter.js";
import { validateV2 } from "../validateV2.js";
import { waterfallCheck } from "../xai.js";

describe("v1 adapter on the small v1 test fixture", () => {
  const manifest = fixture("manifest.json");
  const epochs = {
    2020: prepareEpoch(fixture("epoch_2020.json"), manifest),
    2025: prepareEpoch(fixture("epoch_2025.json"), manifest),
  };
  const m = { ...manifest, epochs: [2020, 2025] };

  it("builds a day-only observed timeline with night / DTR / projections unavailable", () => {
    const a = adaptV1Bundle({ manifest: m, epochs });
    expect(a.timeline.schema).toBe("v1");
    expect(a.timeline.years).toEqual([2020, 2025]);
    expect(a.timeline.modeIds).toEqual(["day"]);
    expect(modeAvailable(a.timeline, "night")).toBe(false);
    expect(a.timeline.projYears).toEqual([]);
    expect(tierOf(a.timeline, 2020, "day")).toBe("observed");
    const info = frameTierInfo(a.timeline, 2025, "night");
    expect(info.available).toBe(false);
    expect(info.reason).toMatch(/rerun notebook v2/);
    expect(a.cubes["day:obs"].years).toEqual([2020, 2025]);
    expect(a.cubes["day:obs"].n).toBe(epochs[2025].n);
  });

  it("wraps v1 assets into the v2 per-mode shape and unwraps them for the facade", () => {
    const sg = fixture("shap_global.json");
    const wrapped = wrapV1Asset("shapGlobal", sg);
    expect(wrapped.modes.day.groups).toEqual(sg.features);
    expect(assetForMode("shapGlobal", wrapped, "day").features).toEqual(sg.features);
    expect(assetForMode("shapGlobal", wrapped, "night").features).toEqual(sg.features);
    expect(wrapV1Asset("zones", wrapped)).toBe(wrapped);
  });
});

describe("frameScopeStats", () => {
  it("computes mean, p90, hot-core area and signed UHI (urban ≥ 0.5 vs rural ≤ 0.05 & water < 0.2)", () => {
    const values = Float32Array.from([40, 41, 42, 45, 46, NaN]);
    const built = [0.6, 0.7, 0.02, 0.01, 0.0, 0.0];
    const water = [0, 0, 0, 0, 0.5, 0];
    const s = frameScopeStats(values, { fracBuilt: built, fracWater: water, hotThreshold: 44, cellAreaKm2: 2 });
    expect(s.mean).toBeCloseTo(42.8, 6);
    expect(s.hot_core_km2).toBe(4);
    expect(s.uhi).toBeCloseTo(40.5 - 43.5, 6);
    expect(s.n_cells).toBe(5);
  });
});

const realBundle = publicDataExists("manifest.json") && readJson(PUBLIC_DATA_DIR, "manifest.json").schema_version?.startsWith("1");

describe.skipIf(!realBundle)("v1 adapter on the REAL bundle in public/data (read-only)", () => {
  let manifest;
  let epochs;
  let adapted;
  beforeAll(() => {
    manifest = readJson(PUBLIC_DATA_DIR, "manifest.json");
    epochs = {};
    for (const y of manifest.epochs) epochs[y] = prepareEpoch(readJson(PUBLIC_DATA_DIR, manifest.files.epochs[String(y)]), manifest);
    adapted = adaptV1Bundle({ manifest, epochs });
  }, 120000);

  it("infers the grid (W = 297 on the real 1 km grid) and keeps the canonical cell order", () => {
    const e = epochs[manifest.epochs[0]];
    expect(inferGridWidth(e.cell_id, e.lon, e.lat)).toBe(297);
    const { cells } = adapted;
    expect(cells.n).toBe(e.n);
    expect(cells.grid.width).toBe(297);
    for (let i = 0; i < cells.n; i += 997) expect(cells.row[i] * 297 + cells.col[i]).toBe(cells.cell_id[i]);
  });

  it("builds the day observation cube from lst_obs with a fixed domain that covers p0.5–p99.5", () => {
    const cube = adapted.cubes["day:obs"];
    expect(cube.years).toEqual(manifest.epochs);
    expect(cube.values).toBeInstanceOf(Int16Array);
    const f = cube.years.indexOf(2025);
    const decoded = decodeCubeFrame(cube, f);
    for (let i = 0; i < cube.n; i += 1013) expect(decoded[i]).toBeCloseTo(epochs[2025].lst_obs[i], 2);
    const [lo, hi] = adapted.timeline.domains.day.abs;
    expect(lo).toBeLessThan(hi);
    expect(Number.isInteger(lo) && Number.isInteger(hi)).toBe(true);
    expect(cellValues(cube, 0, "p50")).toHaveLength(cube.years.length);
  });

  it("passes validateV2 (adapted) and the v1 contract still holds", () => {
    const result = validateV2({
      manifest: adapted.manifestV2,
      timeline: adapted.timeline,
      cells: adapted.cells,
      cubes: adapted.cubes,
      zones: adapted.zones,
      xai: { "2025:day": adapted.xai(2025) },
      series: adapted.series,
      adapted: true,
    });
    expect(result.errors).toEqual([]);
    const v1 = validateBundle({ manifest, epochs: { 2025: epochs[2025] } });
    expect(v1.errors).toEqual([]);
    const wf = waterfallCheck(adapted.xai(2025));
    expect(wf.violations / wf.checked).toBeLessThan(0.01);
  });

  it("derives scope series from the epochs without inventing trends or CIs", () => {
    const ncr = scopeSeries(adapted.series, "ncr", "day");
    expect(ncr.frames.map((f) => f.year)).toEqual(manifest.epochs);
    for (const f of ncr.frames) {
      expect(f.mean).toBeCloseTo(manifest.epoch_means[String(f.year)], 1);
      expect(f.ci).toBeNull();
      expect(f.tier).toBe("observed");
    }
    expect(ncr.trend).toBeNull();
    expect(scopeSeries(adapted.series, "d:1", "day").label).toBe("Gurugram");
    expect(scopeSeries(adapted.series, "z:3", "day")).not.toBeNull();
    expect(scopeSeries(adapted.series, "ncr", "night")).toBeNull();
  });

  it("guarded copy reads the daytime surface UHI as negative and refuses an unexported trend", () => {
    const stats = copyStats({ timeline: adapted.timeline, series: adapted.series, cubes: { day: adapted.cubes["day:obs"] } });
    expect(stats.uhi_day).toBeLessThan(0);
    const uhi = renderGuardedCopy("uhi_day", stats);
    expect(uhi.guardPassed).toBe(true);
    expect(uhi.text).toMatch(/^−\d+\.\d °C by day: built-up land is cooler/);
    const trend = renderGuardedCopy("trend_day", stats);
    expect(trend.guardPassed).toBe(false);
    // v1 exports no trend: say so (UI_SPEC §9), never "no clear trend" (that needs a CI with 0).
    expect(trend.text).toBe("Day: no trend with a confidence interval is exported in this bundle — rerun notebook v2.");
    const night = renderGuardedCopy("uhi_night", stats);
    expect(night.guardPassed).toBe(false);
    expect(night.text).toMatch(/no night LST/);
    expect(renderGuardedCopy("projection_note", stats).text).toMatch(/rerun notebook v2/);
  });

  it("boots through the BundleStore (fs fetch) and serves the v2 resources", async () => {
    const store = createBundleStore({ fetchImpl: createFsFetch(PUBLIC_DATA_DIR) });
    await store.getState().load({ source: { id: "data", baseUrl: "/data", explicit: true, reason: "test" } });
    const s = store.getState();
    expect(s.status).toBe("ready");
    expect(s.schema).toBe("v1");
    expect(s.timeline.years).toEqual(manifest.epochs);
    expect(s.progress.filter((p) => p.id.startsWith("epoch:")).every((p) => p.status === "ok")).toBe(true);
    expect((await store.getState().ensure("cube:day:obs")).status).toBe("ready");
    const night = await store.getState().ensure("cube:night:obs");
    expect(night.status).toBe("unavailable");
    expect(night.reason).toMatch(/rerun notebook v2/);
    expect((await store.getState().ensure("cube:day:ssp245")).status).toBe("unavailable");
    expect((await store.getState().ensure("rasterIndex")).reason).toMatch(/rerun notebook v2/);
    const xai = await store.getState().ensure("xai:2025:day");
    expect(xai.status).toBe("ready");
    expect(xai.data.groups).toEqual(manifest.features.map((f) => f.name));
    const sg = await store.getState().ensure("asset:shapGlobal");
    expect(sg.data.modes.day.groups).toEqual(manifest.features.map((f) => f.name));
    expect((await store.getState().ensure("model:day")).status).toBe("ready");
    expect((await store.getState().ensure("model:night")).status).toBe("unavailable");
    expect((await store.getState().ensure("districts")).data.type).toBe("FeatureCollection");
  }, 120000);
});
