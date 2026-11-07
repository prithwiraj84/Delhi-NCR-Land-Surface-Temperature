import { beforeAll, describe, expect, it } from "vitest";
import { createBundleStore } from "../bundleStore.js";
import { decodeCubeFrame } from "../cubes.js";
import { createFixtureFetch, createSynthV2, FEATURES, GROUPS } from "../fixtures/synthV2.js";
import { scopeSeries, seriesValueAt } from "../series.js";
import { validateV2 } from "../validateV2.js";
import { waterfallCheck } from "../xai.js";

const synth = createSynthV2();

/** Boot a store on the in-memory fixture and load every resource of the bundle. */
async function loadEverything() {
  const store = createBundleStore({ fixtureLoader: async () => ({ synth, fetchImpl: createFixtureFetch(synth) }) });
  await store.getState().load({ source: { id: "fixture", baseUrl: null, explicit: true, reason: "test" } });
  const s = store.getState();
  const tl = s.timeline;
  const keys = ["cells", "series", "districts", "rasterIndex", "asset:shapGlobal", "asset:dependence", "asset:zones", "asset:metrics", "asset:interactions", "asset:coupling", "asset:provenance", "model:day", "model:night"];
  for (const mode of tl.modeIds) {
    keys.push(`cube:${mode}:obs`, `zones:${mode}`);
    for (const ssp of tl.scenarioIds) keys.push(`cube:${mode}:${ssp}`);
    for (const y of tl.obsYears) keys.push(`xai:${y}:${mode}`);
  }
  const entries = Object.fromEntries(await Promise.all(keys.map(async (k) => [k, await store.getState().ensure(k)])));
  return { store, entries };
}

let loaded;
beforeAll(async () => {
  loaded = await loadEverything();
}, 60000);

describe("synthetic v2 fixture (in-memory bundle)", () => {
  it("is deterministic and has the SPEC shape (frames 1990–2050, day/night, 3 SSPs, 18 groups, 47 features)", () => {
    const again = createSynthV2();
    expect(again.manifest).toEqual(synth.manifest);
    expect(synth.manifest.schema_version).toBe("2.0");
    expect(synth.manifest.data_mode).toBe("synthetic");
    expect(synth.manifest.features.map((f) => f.name)).toEqual(FEATURES);
    expect(synth.manifest.groups.map((g) => g.id)).toEqual(GROUPS.map((g) => g.id));
    expect(synth.world.grid.n).toBeGreaterThan(1500);
    expect(synth.world.grid.width * synth.world.grid.height).toBeLessThan(5000);
  });

  it("boots through the real loaders and every resource is ready", () => {
    const { store, entries } = loaded;
    expect(store.getState().status).toBe("ready");
    expect(store.getState().schema).toBe("v2");
    const notReady = Object.entries(entries).filter(([, e]) => e.status !== "ready").map(([k, e]) => `${k}: ${e.status} ${e.reason}`);
    expect(notReady).toEqual([]);
    const progressIds = store.getState().progress.map((p) => p.id);
    expect(progressIds).toEqual(expect.arrayContaining(["manifest", "cells", "series", "cube:day:obs"]));
    expect(store.getState().progress.every((p) => ["ok", "loading"].includes(p.status))).toBe(true);
  });

  it("passes validateV2 with zero errors (all cubes, zones, 16 XAI frames, series, rasters, assets)", () => {
    const { store, entries } = loaded;
    const s = store.getState();
    const pick = (prefix) => Object.fromEntries(Object.entries(entries).filter(([k]) => k.startsWith(prefix)).map(([k, e]) => [k.slice(prefix.length), e.data]));
    const result = validateV2({
      manifest: s.manifest,
      timeline: s.timeline,
      cells: entries.cells.data,
      cubes: pick("cube:"),
      zones: pick("zones:"),
      xai: pick("xai:"),
      series: entries.series.data,
      rasterIndex: entries.rasterIndex.data,
      assets: Object.fromEntries(Object.entries(pick("asset:"))),
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.checked).toEqual(expect.arrayContaining(["manifest", "timeline", "cells", "series", "raster_index", "cube day:obs", "cube night:ssp585", "zones day", "xai 1990:night"]));
    expect(result.checked.filter((c) => c.startsWith("xai ")).length).toBe(16);
  });

  it("holds SHAP additivity within 0.05 °C on every XAI frame", () => {
    for (const [key, e] of Object.entries(loaded.entries)) {
      if (!key.startsWith("xai:")) continue;
      const wf = waterfallCheck(e.data, { sample: 5000 });
      expect(wf.checked, key).toBeGreaterThan(100);
      expect(wf.violations, key).toBe(0);
      expect(wf.worst, key).toBeLessThan(0.02);
    }
  });

  it("plants realistic ranges: negative day surface UHI, positive night UHI, day hotter than night", () => {
    const series = loaded.entries.series.data;
    const day = scopeSeries(series, "ncr", "day");
    const night = scopeSeries(series, "ncr", "night");
    for (const f of day.frames) {
      expect(f.uhi).toBeLessThan(-0.5);
      expect(f.mean).toBeGreaterThan(38);
      expect(f.mean).toBeLessThan(48);
    }
    for (const f of night.frames) {
      expect(f.uhi).toBeGreaterThan(1);
      expect(f.mean).toBeGreaterThan(22);
      expect(f.mean).toBeLessThan(32);
    }
    // Projections warm with the forcing: ssp585 > ssp245 > ssp126 by 2050, fans ordered.
    const p = (ssp) => seriesValueAt(day, 2050, ssp).p50;
    expect(p("ssp585")).toBeGreaterThan(p("ssp245"));
    expect(p("ssp245")).toBeGreaterThan(p("ssp126"));
    expect(p("ssp126")).toBeGreaterThan(seriesValueAt(day, 2025, null).mean);
    // The night trend is clearly positive, the day trend CI includes 0 (guards get both branches).
    expect(night.trend.obs.ci[0]).toBeGreaterThan(0);
    expect(day.trend.obs.ci[0]).toBeLessThan(0);
    expect(day.trend.obs.ci[1]).toBeGreaterThan(0);
  });

  it("encodes coverage gaps and modelled frames as the SPEC requires", () => {
    const dayObs = loaded.entries["cube:day:obs"].data;
    const nightObs = loaded.entries["cube:night:obs"].data;
    const nanCount = (cube, year) => decodeCubeFrame(cube, cube.years.indexOf(year)).filter(Number.isNaN).length;
    expect(nanCount(dayObs, 2005)).toBeGreaterThan(50); // SLC-off stripes
    expect(nanCount(dayObs, 2010)).toBe(0);
    expect(nanCount(nightObs, 1990)).toBe(0); // modelled frames are full model fields
    const spread = decodeCubeFrame(nightObs, 0, { q: "spread" });
    expect(Math.min(...spread)).toBeGreaterThan(1.5);
    const spreadObserved = decodeCubeFrame(nightObs, nightObs.years.indexOf(2010), { q: "spread" });
    expect(Math.max(...spreadObserved)).toBe(0);
    const xai1990 = loaded.entries["xai:1990:night"].data;
    expect(xai1990.obs.every(Number.isNaN)).toBe(true);
    expect(xai1990.pred.some(Number.isFinite)).toBe(true);
  });

  it("serves 250 m rasters that decode to the fixed per-mode domain", () => {
    const index = loaded.entries.rasterIndex.data;
    expect(index.crs).toBe("EPSG:4326");
    expect(Object.keys(index.frames)).toHaveLength(16);
    expect(index.frames.day_2025.lo).toBe(synth.manifest.timeline.domains.day.abs[0]);
    expect(index.frames.night_2025.downscaled).toBe(true);
  });
});

describe("validateV2 detects contract violations", () => {
  const base = () => {
    const { store, entries } = loaded;
    const s = store.getState();
    return { manifest: s.manifest, timeline: s.timeline, cells: entries.cells.data, series: entries.series.data };
  };

  it("flags a broken SHAP waterfall", () => {
    const xai = loaded.entries["xai:2025:day"].data;
    const broken = { ...xai, pred: xai.pred.map((v) => v + 0.3) };
    const r = validateV2({ ...base(), xai: { "2025:day": broken } });
    expect(r.errors.join("\n")).toMatch(/pred ≠ base_value_c \+ Σ group SHAP/);
  });

  it("flags cube tier and frame-list mismatches and values outside the fixed domain", () => {
    const cube = loaded.entries["cube:day:obs"].data;
    const badTiers = { ...cube, tiers: cube.tiers.map((t, i) => (i === 3 ? "modelled" : t)) };
    expect(validateV2({ ...base(), cubes: { "day:obs": badTiers } }).errors.join("\n")).toMatch(/tier "modelled" != manifest/);
    const badYears = { ...cube, years: cube.years.map((y, i) => (i === 0 ? 1991 : y)) };
    expect(validateV2({ ...base(), cubes: { "day:obs": badYears } }).errors.join("\n")).toMatch(/frames .* != manifest/);
    const tl = base().timeline;
    const narrow = { ...tl, domains: { ...tl.domains, day: { ...tl.domains.day, abs: [43, 44] } } };
    expect(validateV2({ ...base(), timeline: narrow, cubes: { "day:obs": cube } }).errors.join("\n")).toMatch(/outside the fixed domain/);
  });

  it("flags bad zone ids, unordered fans, non-canonical cells and an unknown tier", () => {
    const z = loaded.entries["zones:day"].data;
    const values = z.series.obs.values.slice();
    values[0] = 7;
    const badZones = { ...z, series: { ...z.series, obs: { ...z.series.obs, values } } };
    expect(validateV2({ ...base(), zones: { day: badZones } }).errors.join("\n")).toMatch(/outside \{0,1,2,3,255\}/);

    const series = base().series;
    const raw = JSON.parse(JSON.stringify(series.raw));
    raw.ncr.day.ssp.ssp245[0].p05 = 99;
    expect(validateV2({ ...base(), series: { ...series, raw } }).errors.join("\n")).toMatch(/quantiles not ordered/);

    const cells = base().cells;
    const ids = Int32Array.from(cells.cell_id);
    [ids[1], ids[2]] = [ids[2], ids[1]];
    expect(validateV2({ ...base(), cells: { ...cells, cell_id: ids } }).errors.join("\n")).toMatch(/not strictly increasing/);

    const m = JSON.parse(JSON.stringify(base().manifest));
    m.timeline.frames[3].day.tier = "kinda-observed";
    const tl = { ...base().timeline, frames: base().timeline.frames.map((f, i) => (i === 3 ? { ...f, day: { ...f.day, tier: "kinda-observed" } } : f)) };
    expect(validateV2({ ...base(), manifest: m, timeline: tl }).errors.join("\n")).toMatch(/unknown tier "kinda-observed"/);
  });
});
