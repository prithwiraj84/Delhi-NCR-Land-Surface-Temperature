import { describe, it, expect } from "vitest";
import {
  runScenario,
  rebalanceFractions,
  applyCompositionalChange,
  otherVegetationShare,
  resolvePresetScenario,
  mostWaterRichZone,
  presetsFor,
  isActionable,
  coupledBadgeVisible,
  findDistrictId,
  selectRegion,
  baselinePredictions,
  SCENARIO_PRESETS,
  FRACTION_FEATURES,
  CANONICAL_DISTRICTS,
} from "../scenario.js";
import { compileModel } from "../model.js";
import { prepareEpoch } from "../data.js";
import { fixture, randomModel, prng } from "./testUtils.js";

const manifest = fixture("manifest.json");
const coupling = fixture("scenario_coupling.json");
const modelJson = fixture("model_web.json");
const model = compileModel(modelJson);
const epoch = prepareEpoch(fixture("epoch_2025.json"), manifest);

const sum = (arr) => arr.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);

/** Independent brute-force scenario for one cell: returns the expected ΔLST. */
function bruteForceDelta(i, { feature, delta, coupled }) {
  const before = model.features.map((f) => epoch.features[f][i]);
  const after = before.slice();
  if (FRACTION_FEATURES.includes(feature)) {
    const idx = FRACTION_FEATURES.map((f) => model.features.indexOf(f));
    const fr = Array.from(applyCompositionalChange(idx.map((k) => before[k]), FRACTION_FEATURES.indexOf(feature), delta).after);
    idx.forEach((k, j) => (after[k] = fr[j]));
    if (coupled) {
      for (const index of ["ndvi", "ndwi", "ndbi"]) {
        const k = model.features.indexOf(index);
        if (!Number.isFinite(before[k])) continue;
        let shift = 0;
        FRACTION_FEATURES.forEach((f, j) => {
          const slope = coupling.coupling[f]?.[index] ?? 0;
          shift += slope * (fr[j] - before[idx[j]]);
        });
        after[k] = Math.min(1, Math.max(-1, Math.fround(before[k]) + shift));
      }
    }
  } else {
    const k = model.features.indexOf(feature);
    after[k] = Math.min(1, Math.max(-1, before[k] + delta));
  }
  return model.predictRow(after) - model.predictRow(before);
}

describe("rebalanceFractions", () => {
  it("adds to the target and removes proportionally from the others (sum preserved)", () => {
    const v = [0.2, 0.1, 0.05, 0.4, 0.15];
    const total = sum(v);
    const applied = rebalanceFractions(v, 1, 0.2);
    expect(applied).toBeCloseTo(0.2, 12);
    expect(v[1]).toBeCloseTo(0.3, 12);
    expect(sum(v)).toBeCloseTo(total, 12);
    // Others shrink by the same relative factor: 0.2 / (0.8) = 25 %.
    expect(v[0]).toBeCloseTo(0.2 * 0.75, 12);
    expect(v[3]).toBeCloseTo(0.4 * 0.75, 12);
  });

  it("caps the change by the land the other classes can give up and by [0, 1]", () => {
    const v = [0.05, 0.9, 0.02, 0.0, 0.0];
    const applied = rebalanceFractions(v, 1, 0.5);
    expect(applied).toBeCloseTo(0.07, 12);
    expect(v[1]).toBeCloseTo(0.97, 12);
    expect(v[0]).toBeCloseTo(0, 12);
    expect(v.every((x) => x >= 0 && x <= 1)).toBe(true);
  });

  it("handles negative deltas, empty others and missing values", () => {
    const v = [0.3, 0.1, 0.1, 0.2, 0.1];
    expect(rebalanceFractions(v, 1, -0.5)).toBeCloseTo(-0.1, 12);
    expect(v[1]).toBe(0);
    expect(sum(v)).toBeCloseTo(0.8, 12);

    const lonely = [0, 0.6, 0, 0, 0];
    expect(rebalanceFractions(lonely, 1, -0.2)).toBeCloseTo(-0.2, 12);
    expect(lonely[0]).toBeCloseTo(0.05, 12);
    expect(sum(lonely)).toBeCloseTo(0.6, 12);
    expect(rebalanceFractions([0, 0.6, 0, 0, 0], 1, 0.2)).toBe(0); // nothing left to convert

    const withNaN = [NaN, 0.2, 0.3, NaN, 0.1];
    rebalanceFractions(withNaN, 1, 0.1);
    expect(Number.isNaN(withNaN[0])).toBe(true);
    expect(sum(withNaN)).toBeCloseTo(0.6, 12);
    expect(rebalanceFractions([0.1, NaN, 0.2], 1, 0.1)).toBe(0);
  });
});

describe("findDistrictId", () => {
  it("resolves SPEC §1.1 names and aliases", () => {
    expect(findDistrictId(manifest.districts, "Noida")).toBe(17);
    expect(findDistrictId(manifest.districts, "Gurgaon")).toBe(1);
    expect(findDistrictId(manifest.districts, "gurugram")).toBe(1);
    expect(findDistrictId(manifest.districts, "GAUTAM BUDDHA NAGAR")).toBe(17);
    expect(findDistrictId(manifest.districts, "Delhi NCT")).toBe(0);
    expect(findDistrictId(manifest.districts, "Mewat")).toBe(4);
    expect(findDistrictId(null, "noida")).toBe(17);
  });

  it("returns null for unknown names or ids absent from the list", () => {
    expect(findDistrictId(manifest.districts, "Atlantis")).toBeNull();
    expect(findDistrictId(manifest.districts, "")).toBeNull();
    expect(findDistrictId([{ id: 0, name: "Delhi NCT" }], "Noida")).toBeNull();
    expect(CANONICAL_DISTRICTS).toHaveLength(25);
  });
});

describe("SCENARIO_PRESETS", () => {
  it("contains the SPEC presets with resolved regions", () => {
    expect(SCENARIO_PRESETS.length).toBeGreaterThanOrEqual(4);
    const byLabel = Object.fromEntries(SCENARIO_PRESETS.map((p) => [p.label, p]));
    expect(byLabel["+20% tree canopy in Gurugram"].scenario).toMatchObject({
      feature: "frac_forest",
      delta: 0.2,
      region: { type: "district", ids: [1] },
    });
    expect(byLabel["+10% impervious surface in Noida"].scenario).toMatchObject({
      feature: "frac_impervious",
      delta: 0.1,
      region: { type: "district", ids: [17] },
    });
    expect(SCENARIO_PRESETS.some((p) => p.scenario.feature === "frac_water")).toBe(true);
    expect(SCENARIO_PRESETS.some((p) => p.scenario.region.type === "all")).toBe(true);
    for (const p of SCENARIO_PRESETS) {
      expect(p.id && p.label && p.description).toBeTruthy();
      expect(model.features).toContain(p.scenario.feature);
    }
  });
});

describe("runScenario on the fixture epoch", () => {
  it("returns null until data is available and rejects invalid scenarios", () => {
    expect(runScenario({ epoch: null, model, scenario: SCENARIO_PRESETS[0].scenario })).toBeNull();
    expect(() => runScenario({ epoch, model, scenario: { feature: "nope", delta: 0.1, region: { type: "all" } } })).toThrow(
      /not a model feature/,
    );
    expect(() =>
      runScenario({ epoch, model, scenario: { feature: "ndvi", delta: NaN, region: { type: "all" } } }),
    ).toThrow(/finite/);
  });

  it("+20% tree canopy in Gurugram (coupled) matches a brute-force re-prediction per cell", () => {
    const scenario = SCENARIO_PRESETS[0].scenario;
    const res = runScenario({ epoch, model, coupling, manifest, scenario });
    const expectedRows = [0, 1, 2, 9]; // fixture cells in district 1
    expect(Array.from(res.indices)).toEqual(expectedRows);
    expect(res.changedFeatures).toEqual(expect.arrayContaining([...FRACTION_FEATURES, "ndvi", "ndwi", "ndbi"]));
    res.indices.forEach((i, j) => {
      expect(res.delta[j]).toBeCloseTo(bruteForceDelta(i, scenario), 9);
      expect(res.scenario[j] - res.baseline[j]).toBeCloseTo(res.delta[j], 12);
      expect(res.deltaByCell[i]).toBeCloseTo(res.delta[j], 5);
    });
    for (let i = 0; i < epoch.n; i += 1) {
      if (!expectedRows.includes(i)) expect(Number.isNaN(res.deltaByCell[i])).toBe(true);
    }
    // Baseline in °C = model margin + epoch mean (anomaly mode).
    const i0 = res.indices[0];
    const rowValues = model.features.map((f) => epoch.features[f][i0]);
    expect(res.baseline[0]).toBeCloseTo(model.predictRow(rowValues) + epoch.epoch_mean, 9);

    expect(res.stats.count).toBe(4);
    expect(res.stats.areaKm2).toBeCloseTo(4, 12);
    expect(res.stats.min).toBeLessThanOrEqual(res.stats.p10);
    expect(res.stats.p90).toBeLessThanOrEqual(res.stats.max);
    expect(res.stats.scenarioMeanC - res.stats.baselineMeanC).toBeCloseTo(res.stats.mean, 9);
    expect(sum(res.histogram.map((b) => b.count))).toBe(4);
    expect(res.histogram).toHaveLength(24);
    expect(res.byDistrict).toEqual([{ id: 1, name: "Gurugram", count: 4, mean: expect.any(Number) }]);
  });

  it("uncoupled mode leaves spectral indices untouched", () => {
    const scenario = { ...SCENARIO_PRESETS[0].scenario, coupled: false };
    const res = runScenario({ epoch, model, coupling, manifest, scenario });
    expect(res.changedFeatures).not.toContain("ndvi");
    res.indices.forEach((i, j) => expect(res.delta[j]).toBeCloseTo(bruteForceDelta(i, scenario), 9));
  });

  it("direct index shifts skip cells whose value is missing (differential tree path)", () => {
    const scenario = { feature: "ndvi", delta: 0.4, region: { type: "all", ids: [] }, coupled: true };
    const res = runScenario({ epoch, model, coupling, manifest, scenario });
    expect(res.stats.count).toBe(11); // cell 5 has ndvi = null in 2025
    expect(res.regionCount).toBe(12);
    expect(Number.isNaN(res.deltaByCell[5])).toBe(true);
    res.indices.forEach((i, j) => expect(res.delta[j]).toBeCloseTo(bruteForceDelta(i, scenario), 9));
    expect(res.byDistrict.map((d) => d.mean)).toEqual([...res.byDistrict.map((d) => d.mean)].sort((a, b) => a - b));
  });

  it("zone regions select by zone id; empty selections give NaN stats", () => {
    const zoneRes = runScenario({
      epoch,
      model,
      coupling,
      manifest,
      scenario: { feature: "frac_water", delta: 0.05, region: { type: "zone", ids: [1] }, coupled: true },
    });
    expect(Array.from(zoneRes.indices)).toEqual([4, 6, 9]);
    const empty = runScenario({
      epoch,
      model,
      coupling,
      manifest,
      scenario: { feature: "frac_water", delta: 0.05, region: { type: "district", ids: [] }, coupled: true },
    });
    expect(empty.stats.count).toBe(0);
    expect(Number.isNaN(empty.stats.mean)).toBe(true);
    expect(empty.histogram).toEqual([]);
    expect(empty.byDistrict).toEqual([]);
    expect(() => selectRegion(epoch, { type: "planet", ids: [] })).toThrow(/unknown region/);
  });

  it("caches baseline predictions per epoch and model", () => {
    expect(baselinePredictions(epoch, model)).toBe(baselinePredictions(epoch, model));
  });
});

describe("runScenario at NCR scale (55k cells, 400 trees of depth 6)", () => {
  const features = model.features;
  const n = 55000;
  const rand = prng(3);
  const big = {
    year: 2025,
    n,
    cell_size_m: 1000,
    epoch_mean: 39,
    district: Int16Array.from({ length: n }, (_, i) => i % 25),
    zone: Int8Array.from({ length: n }, (_, i) => i % 4),
    features: {},
  };
  for (const f of features) big.features[f] = Float32Array.from({ length: n }, () => rand());
  // Normalise fractions so they sum to <= 1 per cell.
  for (let i = 0; i < n; i += 1) {
    const s = FRACTION_FEATURES.reduce((a, f) => a + big.features[f][i], 0) * 1.2;
    for (const f of FRACTION_FEATURES) big.features[f][i] /= s;
  }
  const bigModel = compileModel(randomModel({ nTrees: 400, depth: 6, features, seed: 5 }));

  it("computes an NCR-wide coupled scenario within an interactive budget", () => {
    const t0 = performance.now();
    baselinePredictions(big, bigModel);
    const t1 = performance.now();
    const res = runScenario({
      epoch: big,
      model: bigModel,
      coupling,
      manifest,
      scenario: { feature: "frac_forest", delta: 0.1, region: { type: "all", ids: [] }, coupled: true },
    });
    const t2 = performance.now();
    expect(res.stats.count).toBe(n);
    expect(res.stats.areaKm2).toBeCloseTo(n, 6);
    // Generous CI bound; typical desktop timings are a few hundred ms each.
    expect(t1 - t0).toBeLessThan(8000);
    expect(t2 - t1).toBeLessThan(8000);
    console.info(`[perf] baseline ${(t1 - t0).toFixed(0)} ms, scenario ${(t2 - t1).toFixed(0)} ms for ${n} cells`);
  }, 30000);
});

describe("other vegetation as a compositional donor (SCI-10)", () => {
  it("converts a 100% other-vegetation cell (no model fraction to give up)", () => {
    const change = applyCompositionalChange([0, 0, 0, 0, 0], 1, 0.2);
    expect(change.applied).toBeCloseTo(0.2, 12);
    expect(change.after[1]).toBeCloseTo(0.2, 12);
    expect(change.otherBefore).toBeCloseTo(1, 12);
    expect(change.otherAfter).toBeCloseTo(0.8, 12);
  });

  it("takes land proportionally from the other fractions AND other vegetation", () => {
    const input = [0.1, 0, 0.1, 0.2, 0];
    const change = applyCompositionalChange(input, 1, 0.5);
    expect(change.applied).toBeCloseTo(0.5, 12);
    expect(change.otherBefore).toBeCloseTo(0.6, 12);
    expect(change.otherBefore - change.otherAfter).toBeCloseTo(0.3, 12);
    expect(change.after[0]).toBeCloseTo(0.05, 12);
    expect(change.after[3]).toBeCloseTo(0.1, 12);
    // Input untouched; 5-fraction sum + other stays 1 and never exceeds 1.
    expect(input).toEqual([0.1, 0, 0.1, 0.2, 0]);
    const total = Array.from(change.after).reduce((a, b) => a + b, 0);
    expect(total + change.otherAfter).toBeCloseTo(1, 12);
    expect(total).toBeLessThanOrEqual(1 + 1e-12);
  });

  it("returns removed land to all classes including other vegetation", () => {
    const change = applyCompositionalChange([0.2, 0.5, 0, 0.1, 0], 1, -0.2);
    expect(change.applied).toBeCloseTo(-0.2, 12);
    expect(change.otherAfter - change.otherBefore).toBeCloseTo(0.2 * (0.2 / 0.5), 12);
    expect(otherVegetationShare([0.5, 0.6, NaN])).toBe(0);
  });
});

describe("applied change and changed cells (DASH-01)", () => {
  /** Tiny synthetic epoch: frac_forest = [0, 0.3, 0.5], everything else neutral. */
  function tinyEpoch() {
    const n = 3;
    const features = {};
    for (const f of model.features) features[f] = new Float32Array(n).fill(f.startsWith("frac_") ? 0.1 : 0.2);
    features.frac_forest = Float32Array.from([0, 0.3, 0.5]);
    return {
      year: 2025,
      n,
      cell_size_m: 1000,
      epoch_mean: 40,
      district: Int16Array.from([1, 1, 2]),
      zone: Int8Array.from([0, 1, 2]),
      features,
    };
  }

  it("counts only the cells that really changed and reports the mean applied change", () => {
    const res = runScenario({
      epoch: tinyEpoch(),
      model,
      coupling,
      manifest,
      scenario: { feature: "frac_forest", delta: -0.2, region: { type: "all", ids: [] }, coupled: true },
    });
    expect(res.stats.regionCount).toBe(3);
    expect(res.stats.applicableCount).toBe(3);
    expect(res.stats.changedCount).toBe(2);
    expect(res.stats.count).toBe(2);
    expect(Array.from(res.indices)).toEqual([1, 2]);
    expect(res.stats.meanApplied).toBeCloseTo(-0.2, 6);
    expect(res.stats.requested).toBeCloseTo(-0.2, 12);
    expect(res.stats.areaKm2).toBeCloseTo(2, 12);
    expect(res.stats.regionAreaKm2).toBeCloseTo(3, 12);
    expect(res.stats.mean).toBeCloseTo((res.delta[0] + res.delta[1]) / 2, 12);
    expect(res.stats.regionMean).toBeCloseTo((res.delta[0] + res.delta[1]) / 3, 9);
    // The unchanged cell is in the region: shown as exactly 0 on the map, not NaN.
    expect(res.deltaByCell[0]).toBe(0);
    expect(res.epochYear).toBe(2025);
  });

  it("reports a partly applied change (cap by the land available)", () => {
    const res = runScenario({
      epoch: tinyEpoch(),
      model,
      coupling,
      manifest,
      scenario: { feature: "frac_forest", delta: -0.4, region: { type: "all", ids: [] }, coupled: false },
    });
    expect(res.stats.changedCount).toBe(2);
    expect(res.stats.meanApplied).toBeCloseTo((-0.3 + -0.4) / 2, 6);
  });

  it("flags coupling only when indices really moved", () => {
    const base = { delta: 0.1, region: { type: "all", ids: [] }, coupled: true };
    const frac = runScenario({ epoch, model, coupling, manifest, scenario: { ...base, feature: "frac_forest" } });
    expect(frac.coupledApplied).toBe(true);
    const ndvi = runScenario({ epoch, model, coupling, manifest, scenario: { ...base, feature: "ndvi" } });
    expect(ndvi.coupledApplied).toBe(false);
    const noTable = runScenario({ epoch, model, coupling: null, manifest, scenario: { ...base, feature: "frac_forest" } });
    expect(noTable.coupledApplied).toBe(false);
  });
});

describe("presets resolved from the bundle (DASH-08, D2)", () => {
  const zones = {
    zones: [
      { id: 0, feature_means: { frac_water: 0.1445 } },
      { id: 1, feature_means: { frac_water: 0.0008 } },
      { id: 2, feature_means: { frac_water: 0.0004 } },
      { id: 3, feature_means: { frac_water: 0.0012 } },
    ],
  };

  it("targets the most water-rich zone, whatever its id or name", () => {
    expect(mostWaterRichZone(zones)).toBe(0);
    const preset = SCENARIO_PRESETS.find((p) => p.scenario.feature === "frac_water");
    const resolved = resolvePresetScenario(preset, { zones });
    expect(resolved.region).toEqual({ type: "zone", ids: [0] });
    // Without zone profiles the canonical fallback id stays.
    expect(resolvePresetScenario(preset, { zones: null }).region).toEqual({ type: "zone", ids: [1] });
    // SHAP fallback when feature means are missing.
    expect(
      mostWaterRichZone({ zones: [{ id: 2, shap_means: { frac_water: -0.1 } }, { id: 1, shap_means: { frac_water: -0.9 } }] }),
    ).toBe(1);
  });

  it("offers only presets on actionable features", () => {
    const m = { features: manifest.features.map((f) => ({ ...f, actionable: f.name !== "frac_water" })) };
    const list = presetsFor(m, zones);
    expect(list.some((p) => p.scenario.feature === "frac_water")).toBe(false);
    expect(list.length).toBe(SCENARIO_PRESETS.length - 1);
    expect(list.every((p) => !("pick" in p.scenario.region))).toBe(true);
    expect(isActionable({ features: [{ name: "ndwi", actionable: false }] }, "ndwi")).toBe(false);
    expect(isActionable(null, "ndwi")).toBe(true);
  });
});

describe("coupled-indices badge (DASH-11)", () => {
  it("is shown only when coupling really applied", () => {
    expect(coupledBadgeVisible({ feature: "ndvi", coupled: true })).toBe(false);
    expect(coupledBadgeVisible({ feature: "lm_pd", coupled: true }, { coupledApplied: false })).toBe(false);
    expect(coupledBadgeVisible({ feature: "frac_forest", coupled: true })).toBe(true);
    expect(coupledBadgeVisible({ feature: "frac_forest", coupled: true }, { coupledApplied: false })).toBe(false);
    expect(coupledBadgeVisible({ feature: "frac_forest", coupled: false }, { coupledApplied: true })).toBe(false);
  });
});
