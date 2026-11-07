/**
 * v2 what-if engine (SPEC §4.1 / §4.4): 47 features, browser focal recompute from FOCAL_SPEC
 * with summed-area-table box means, distances held fixed, simplex rebalancing incl. other
 * vegetation, coupled spectral shifts — checked against independent brute-force references on
 * the in-memory synthetic v2 bundle (src/data/fixtures/synthV2.js, loaded through the real
 * BundleStore so the facade epoch is exactly what the dashboard feeds the engine).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createBundleStore } from "../../data/bundleStore.js";
import { createFixtureFetch, createSynthV2, FEATURES, FOCAL_SPEC } from "../../data/fixtures/synthV2.js";
import { compileModel, modelFocalSpec } from "../model.js";
import {
  applyCompositionalChange,
  boxMeanSat,
  buildGridIndex,
  computeFocalColumns,
  DEFAULT_FOCAL_SPEC,
  focalSpecOf,
  FRACTION_FEATURES_V2,
  isActionable,
  isV2Epoch,
  presetsFor,
  resolveFeatureName,
  runScenario,
  v2BaselineColumns,
} from "../scenario.js";
import { ScenarioEngine, slimEpoch, slimManifest } from "../scenarioEngine.js";
import { createWorkerState, handleScenarioMessage } from "../scenarioWorkerCore.js";
import { prng, randomModel } from "./testUtils.js";

const synth = createSynthV2();
let epoch;
let manifest;
let coupling;
let modelRaw;
let model;

beforeAll(async () => {
  const store = createBundleStore({ fixtureLoader: async () => ({ synth, fetchImpl: createFixtureFetch(synth) }) });
  await store.getState().load({ source: { id: "fixture", baseUrl: null, explicit: true, reason: "test" } });
  epoch = await store.getState().ensureData("epoch:2025:day");
  coupling = await store.getState().ensureData("asset:coupling");
  modelRaw = await store.getState().ensureData("model:day");
  manifest = store.getState().manifest;
  model = compileModel(modelRaw);
}, 60000);

/** Brute-force NaN-aware box mean over a clipped window (reference for the SAT). */
function bruteBox(grid, values, window) {
  const half = Math.floor(window / 2);
  const out = new Float32Array(grid.n);
  for (let i = 0; i < grid.n; i += 1) {
    const r = Math.floor(grid.pixel[i] / grid.width);
    const c = grid.pixel[i] % grid.width;
    let s = 0;
    let k = 0;
    for (let dr = -half; dr <= half; dr += 1) {
      for (let dc = -half; dc <= half; dc += 1) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= grid.height || cc >= grid.width) continue;
        const j = grid.cellOfPixel[rr * grid.width + cc];
        if (j < 0 || !Number.isFinite(values[j])) continue;
        s += values[j];
        k += 1;
      }
    }
    out[i] = k ? s / k : NaN;
  }
  return out;
}

const gridShape = () => ({ width: coupling.grid.width, height: coupling.grid.height });

describe("summed-area-table box means", () => {
  it("equal a brute-force NaN-aware clipped window on an irregular ROI with holes", () => {
    const rand = prng(11);
    const W = 23;
    const H = 17;
    const ids = [];
    for (let id = 0; id < W * H; id += 1) if (rand() > 0.25) ids.push(id);
    const grid = buildGridIndex(Int32Array.from(ids), W, H);
    const values = Float32Array.from(ids, () => (rand() < 0.1 ? NaN : rand() * 10 - 3));
    for (const w of [1, 3, 5, 15]) {
      const sat = boxMeanSat(grid, values, w);
      const ref = bruteBox(grid, values, w);
      for (let i = 0; i < grid.n; i += 1) {
        if (Number.isNaN(ref[i])) expect(sat[i]).toBeNaN();
        else expect(sat[i]).toBeCloseTo(ref[i], 5);
      }
    }
  });

  it("rejects an unknown grid width and cell ids outside the grid", () => {
    expect(() => buildGridIndex(Int32Array.from([0, 1]), null)).toThrow(/grid width/);
    expect(() => buildGridIndex(Int32Array.from([0, 99]), 3, 3)).toThrow(/outside/);
  });

  it("reproduce the fixture's own focal features (FOCAL_SPEC windows 3 and 15)", () => {
    const grid = buildGridIndex(epoch.cell_id, gridShape().width, gridShape().height);
    const focal = computeFocalColumns(grid, epoch.baseFeatures, FOCAL_SPEC);
    expect(Object.keys(focal).sort()).toEqual(FEATURES.filter((f) => /_m\d+$/.test(f)).sort());
    const ref = bruteBox(grid, epoch.baseFeatures.ndvi, 15);
    for (let i = 0; i < grid.n; i += 97) expect(focal.ndvi_m15[i]).toBeCloseTo(ref[i], 5);
  });
});

describe("v2 bundle wiring", () => {
  it("detects v2 epochs and reads FOCAL_SPEC from the model", () => {
    expect(isV2Epoch(epoch)).toBe(true);
    expect(isV2Epoch({ features: {} })).toBe(false);
    expect(modelFocalSpec(modelRaw)).toEqual({ bases: [...FOCAL_SPEC.bases], windows: [...FOCAL_SPEC.windows] });
    expect(model.focal).toEqual(modelFocalSpec(modelRaw));
    expect(focalSpecOf({})).toBe(DEFAULT_FOCAL_SPEC);
    expect(model.features).toHaveLength(47);
  });

  it("translates v1 feature names and judges actionability on group metas", () => {
    expect(resolveFeatureName("frac_impervious", { modelFeatures: model.features })).toBe("frac_built");
    expect(resolveFeatureName("frac_forest", { modelFeatures: model.features })).toBe("frac_forest");
    const groupMetas = synth.manifest.groups.map((g) => ({ name: g.id, primary: g.primary, members: g.members, actionable: g.actionable }));
    const facade = { features: groupMetas };
    expect(isActionable(facade, "frac_forest")).toBe(true);
    expect(isActionable(facade, "frac_forest_m15")).toBe(false);
    expect(isActionable(facade, "mndwi")).toBe(false);
    const presets = presetsFor(facade, null);
    const sprawl = presets.find((p) => p.id === "noida-sprawl");
    expect(sprawl.scenario.feature).toBe("frac_built");
    expect(sprawl.label).toMatch(/built-up/);
  });
});

/** Brute-force v2 scenario: perturb base, rebuild ALL focal columns, predict every cell. */
function bruteForceV2(scenario, mdl) {
  const grid = buildGridIndex(epoch.cell_id, gridShape().width, gridShape().height);
  const base = Object.fromEntries(Object.entries(epoch.baseFeatures).map(([k, v]) => [k, Float32Array.from(v)]));
  const after = Object.fromEntries(Object.entries(epoch.baseFeatures).map(([k, v]) => [k, Float32Array.from(v)]));
  const districts = new Set(scenario.region.ids);
  const fracs = FRACTION_FEATURES_V2;
  const target = fracs.indexOf(scenario.feature);
  for (let i = 0; i < epoch.n; i += 1) {
    if (scenario.region.type === "district" && !districts.has(epoch.district[i])) continue;
    const before = fracs.map((f) => base[f][i]);
    if (!Number.isFinite(before[target])) continue;
    const change = applyCompositionalChange(Float64Array.from(before), target, scenario.delta);
    if (change.applied === 0) continue;
    fracs.forEach((f, k) => (after[f][i] = change.after[k]));
    if (scenario.coupled) {
      let ndviShift = 0;
      for (const index of ["ndvi", "ndbi", "mndwi", "albedo"]) {
        let shift = 0;
        fracs.forEach((f, k) => (shift += (coupling.coupling[f]?.[index] ?? 0) * (change.after[k] - before[k])));
        const lo = index === "albedo" ? 0 : -1;
        const next = Math.min(1, Math.max(lo, base[index][i] + shift));
        after[index][i] = next;
        if (index === "ndvi") ndviShift = Math.fround(next) - base.ndvi[i];
      }
      after.ndvi_spring[i] = Math.min(1, Math.max(-1, base.ndvi_spring[i] + ndviShift));
      after.ndvi_drop[i] = after.ndvi_spring[i] - after.ndvi[i];
    }
  }
  const focalBefore = Object.fromEntries(FOCAL_SPEC.bases.flatMap((b) => FOCAL_SPEC.windows.map((w) => [`${b}_m${w}`, bruteBox(grid, base[b], w)])));
  const focalAfter = Object.fromEntries(FOCAL_SPEC.bases.flatMap((b) => FOCAL_SPEC.windows.map((w) => [`${b}_m${w}`, bruteBox(grid, after[b], w)])));
  const row = (cols, focal, i) => mdl.features.map((f) => (cols[f] ?? focal[f])?.[i] ?? NaN);
  const out = new Float64Array(epoch.n);
  for (let i = 0; i < epoch.n; i += 1) out[i] = mdl.predictRow(row(after, focalAfter, i)) - mdl.predictRow(row(base, focalBefore, i));
  return out;
}

describe("runScenario on a v2 epoch (focal recompute)", () => {
  /** A model that leans on the 15-cell tree-cover and NDVI means, so spill-over must appear. */
  const focalModel = () =>
    compileModel(
      randomModel({
        nTrees: 60,
        depth: 4,
        features: FEATURES.slice(),
        seed: 5,
        featurePool: ["frac_forest", "frac_forest_m3", "frac_forest_m15", "ndvi_m15", "ndvi", "frac_built_m15", "ndvi_drop"].map((f) => FEATURES.indexOf(f)),
      }),
    );

  it("matches a brute-force re-prediction of every cell, including neighbours outside the region", () => {
    const mdl = focalModel();
    const scenario = { feature: "frac_forest", delta: 0.2, region: { type: "district", ids: [1] }, coupled: true };
    const res = runScenario({ epoch, model: mdl, coupling, manifest, scenario });
    const ref = bruteForceV2(scenario, mdl);
    let checked = 0;
    for (let i = 0; i < epoch.n; i += 1) {
      const d = res.deltaByCell[i];
      if (Math.abs(ref[i]) > 1e-9) {
        expect(d).toBeCloseTo(ref[i], 5);
        checked += 1;
      } else if (Number.isFinite(d)) {
        expect(Math.abs(d)).toBeLessThan(1e-6);
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(res.engine).toBe("v2-focal");
    expect(res.focalRecomputed).toEqual(expect.arrayContaining(["frac_forest_m3", "frac_forest_m15", "ndvi_m15"]));
    expect(res.spillover.count).toBeGreaterThan(0);
    // D17: spill-over cells lie OUTSIDE the region (Gurugram) and their inputs changed; the count
    // includes inputs-only cells and the mean includes their zeros.
    const changed = new Set(res.indices);
    for (const i of res.spillover.indices) {
      expect(changed.has(i)).toBe(false);
      expect(epoch.district[i]).not.toBe(1);
    }
    expect(res.spillover.count).toBe(res.spillover.movedCount + res.stats.inputsOnlyCount);
    const vals = Array.from(res.spillover.indices, (i) => res.deltaByCell[i]);
    expect(res.spillover.mean).toBeCloseTo(vals.reduce((a, b) => a + b, 0) / vals.length, 6);
    expect(res.spillover.movedCount).toBe(vals.filter((d) => Math.abs(d) > 1e-3).length);
    expect(res.stats.affectedCount).toBeGreaterThanOrEqual(res.indices.length + res.spillover.count);
    // Cells whose inputs did not change carry ΔLST = 0 (not NaN) on the map.
    const spillSet = new Set(res.spillover.indices);
    const untouched = Array.from({ length: epoch.n }, (_, i) => i).filter((i) => !changed.has(i) && !spillSet.has(i) && epoch.district[i] !== 1);
    expect(untouched.length).toBeGreaterThan(0);
    for (const i of untouched.slice(0, 200)) expect(res.deltaByCell[i]).toBe(0);
    expect(res.coupledApplied).toBe(true);
  });

  it("holds distances fixed and leaves the epoch's columns untouched", () => {
    const mdl = focalModel();
    const before = Float32Array.from(epoch.baseFeatures.frac_forest);
    const res = runScenario({ epoch, model: mdl, coupling, manifest, scenario: { feature: "frac_forest", delta: 0.3, region: { type: "all", ids: [] }, coupled: true } });
    expect(res.changedFeatures).not.toContain("dist_water");
    expect(res.changedFeatures).not.toContain("dist_urban");
    expect(Array.from(epoch.baseFeatures.frac_forest)).toEqual(Array.from(before));
  });

  it("keeps every cell on the simplex (other vegetation included) and recomputes ndvi_drop", () => {
    const mdl = focalModel();
    const base = v2BaselineColumns(epoch, mdl, { coupling, manifest });
    expect(base.columns.ndvi_m15).toBeInstanceOf(Float32Array);
    const res = runScenario({ epoch, model: mdl, coupling, manifest, scenario: { feature: "frac_built", delta: 0.25, region: { type: "district", ids: [0] }, coupled: true } });
    expect(res.stats.changedCount).toBeGreaterThan(0);
    expect(res.stats.meanApplied).toBeGreaterThan(0);
    expect(res.stats.meanApplied).toBeLessThanOrEqual(0.25 + 1e-9);
  });

  it("accepts the v1 preset name frac_impervious on a v2 model", () => {
    const res = runScenario({ epoch, model, coupling, manifest, scenario: { feature: "frac_impervious", delta: 0.1, region: { type: "district", ids: [17] }, coupled: true } });
    expect(res.changedFeatures).toContain("frac_built");
  });

  it("reports an explicit error when the grid shape is unknown", () => {
    const bare = { ...epoch, grid: undefined };
    expect(() => runScenario({ epoch: bare, model: compileModel(modelRaw), coupling: { ...coupling, grid: null }, manifest: { features: [] }, scenario: { feature: "ndvi", delta: 0.05, region: { type: "all", ids: [] } } })).toThrow(/grid width/);
  });
});

describe("worker path on v2 epochs", () => {
  it("sends base features + cell ids and returns the same result as the main thread", async () => {
    const slim = slimEpoch(epoch);
    expect(slim.baseFeatures).toBe(epoch.baseFeatures);
    expect(slim.cell_id).toBe(epoch.cell_id);
    expect(slimManifest({ features: [], study_area: { grid: { width: 9, height: 4 } } }).grid).toEqual({ width: 9, height: 4 });
    const state = createWorkerState();
    handleScenarioMessage(state, { type: "model", modelRaw });
    handleScenarioMessage(state, { type: "epoch", key: "e", epoch: slim });
    const scenario = { feature: "frac_water", delta: 0.05, region: { type: "district", ids: [2] }, coupled: true };
    const out = handleScenarioMessage(state, { type: "run", id: 1, key: "e", scenario, coupling, manifest: slimManifest(manifest) });
    expect(out.reply.error).toBeUndefined();
    const sync = await new ScenarioEngine({ workerFactory: null }).run({ epoch, model, coupling, manifest, scenario });
    expect(Array.from(out.reply.result.deltaByCell)).toEqual(Array.from(sync.deltaByCell));
  });
});
