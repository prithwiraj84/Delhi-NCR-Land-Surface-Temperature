import { describe, it, expect } from "vitest";
import {
  compileModel,
  checkModelAgainstPython,
  predictionToCelsius,
  MODEL_FORMAT,
} from "../model.js";
import {
  fixture,
  randomModel,
  referencePredict,
  prng,
  publicDataExists,
  readJson,
  PUBLIC_DATA_DIR,
} from "./testUtils.js";

const modelJson = fixture("model_web.json");
const K = modelJson.features.length;

/** Row with named overrides; everything else 0.25 (matches the fixture generator). */
function row(overrides) {
  return modelJson.features.map((f) => (f in overrides ? overrides[f] : 0.25));
}

describe("compileModel (fixture: 3 hand-made trees)", () => {
  const model = compileModel(modelJson);

  it("exposes metadata", () => {
    expect(model.features).toEqual(modelJson.features);
    expect(model.nTrees).toBe(3);
    expect(model.baseScore).toBeCloseTo(0.1, 12);
    expect(model.targetMode).toBe("anomaly");
    expect(modelJson.format).toBe(MODEL_FORMAT);
  });

  it("reproduces every embedded check row exactly", () => {
    modelJson.check.rows.forEach((r, i) => {
      expect(model.predictRow(r)).toBeCloseTo(modelJson.check.expected[i], 9);
    });
    const report = checkModelAgainstPython(model, modelJson, 1e-9);
    expect(report).toMatchObject({ n: 5, failures: 0 });
  });

  it("routes a value equal to the float32 threshold to the right (x >= t)", () => {
    // 0.3 as float32 equals the stored threshold, so XGBoost goes right (-0.5).
    // A naive double comparison 0.3 < 0.30000001192 would wrongly go left.
    const pred = model.predictRow(row({ ndvi: 0.3, frac_impervious: 0.5, frac_forest: 0.9, frac_water: 0.05 }));
    expect(pred).toBeCloseTo(0.1 - 0.5 + 1.0 + 0, 12);
  });

  it("sends null, undefined, NaN and absent values along the default direction", () => {
    const allMissing = 0.1 + 0.5 + 1.0 - 0.8; // tree0 d=1 left, tree1 d=0 right, tree2 d=0 right
    expect(model.predictRow(new Array(K).fill(null))).toBeCloseTo(allMissing, 12);
    expect(model.predictRow(new Array(K).fill(undefined))).toBeCloseTo(allMissing, 12);
    expect(model.predictRow(new Float32Array(K).fill(NaN))).toBeCloseTo(allMissing, 12);
    expect(model.predictRow([])).toBeCloseTo(allMissing, 12);
    // Missing frac_forest (d=1 -> left leaf 0.2) under a left frac_impervious split.
    const r = row({ ndvi: NaN, frac_impervious: 0.4, frac_forest: null, frac_water: 0.1 });
    expect(model.predictRow(r)).toBeCloseTo(0.1 + 0.5 + 0.2 - 0.8, 12);
  });

  it("predictMany matches predictRow for arbitrary index subsets", () => {
    const rows = modelJson.check.rows;
    const indices = Int32Array.from([4, 0, 2]);
    const out = model.predictMany((f, i) => rows[i][f], indices);
    expect(out).toBeInstanceOf(Float64Array);
    expect(Array.from(out)).toEqual(Array.from(indices, (i) => model.predictRow(rows[i])));
    expect(model.predictMany(() => 0, [])).toHaveLength(0);
  });

  it("identifies trees by the features they split on and sums tree subsets", () => {
    expect(Array.from(model.treesUsingFeatures([0]))).toEqual([0]);
    expect(Array.from(model.treesUsingFeatures([10]))).toEqual([1]);
    expect(Array.from(model.treesUsingFeatures([9, 11]))).toEqual([1, 2]);
    expect(Array.from(model.treesUsingFeatures([3]))).toEqual([]);
    const rows = modelJson.check.rows;
    const part = model.predictTrees((f, i) => rows[i][f], [0], Int32Array.from([1, 2]));
    expect(part[0]).toBeCloseTo(1.0 + 0, 12);
  });

  it("rejects malformed models with explicit messages", () => {
    expect(() => compileModel(null)).toThrow(/missing/);
    expect(() => compileModel({ ...modelJson, format: "other" })).toThrow(/unsupported format/);
    expect(() => compileModel({ ...modelJson, features: [] })).toThrow(/feature list/);
    const cyclic = { f: [0, -1], t: [0.5, 0], l: [0, -1], r: [1, -1], d: [0, 0], v: [0, 1] };
    expect(() => compileModel({ ...modelJson, trees: [cyclic] })).toThrow(/invalid children/);
    const badFeature = { f: [99, -1, -1], t: [0.5, 0, 0], l: [1, -1, -1], r: [2, -1, -1], d: [0, 0, 0], v: [0, 1, 2] };
    expect(() => compileModel({ ...modelJson, trees: [badFeature] })).toThrow(/unknown feature/);
    const shared = { f: [0, 1, 1, -1, -1], t: [0.5, 0.5, 0.5, 0, 0], l: [1, 3, 3, -1, -1], r: [2, 4, 4, -1, -1], d: [0, 0, 0, 0, 0], v: [0, 0, 0, 1, 2] };
    expect(() => compileModel({ ...modelJson, trees: [shared] })).toThrow(/several parents/);
    const orphan = { f: [0, -1, -1, -1], t: [0.5, 0, 0, 0], l: [1, -1, -1, -1], r: [2, -1, -1, -1], d: [0, 0, 0, 0], v: [0, 1, 2, 3] };
    expect(() => compileModel({ ...modelJson, trees: [orphan] })).toThrow(/unreachable/);
    const ragged ={ f: [0, -1, -1], t: [0.5], l: [1, -1, -1], r: [2, -1, -1], d: [0, 0, 0], v: [0, 1, 2] };
    expect(() => compileModel({ ...modelJson, trees: [ragged] })).toThrow(/length/);
  });
});

describe("compileModel (random deep ensemble vs reference evaluator)", () => {
  const json = randomModel({ nTrees: 60, depth: 6, features: modelJson.features, seed: 11, leafProb: 0.2 });
  const model = compileModel(json);
  const rand = prng(99);

  it("agrees with an independent recursive evaluator incl. missing values", () => {
    for (let s = 0; s < 300; s += 1) {
      const r = Array.from({ length: K }, () => (rand() < 0.1 ? null : rand()));
      expect(model.predictRow(r)).toBeCloseTo(referencePredict(json, r), 9);
    }
  });

  it("batch evaluation (interleaved rows + remainder) equals row-by-row evaluation", () => {
    const rows = Array.from({ length: 103 }, () => Array.from({ length: K }, () => (rand() < 0.05 ? NaN : rand())));
    const out = model.predictMany((f, i) => rows[i][f], Int32Array.from({ length: rows.length }, (_, i) => i));
    rows.forEach((r, i) => expect(out[i]).toBeCloseTo(referencePredict(json, r), 9));
    expect(model.maxDepth).toBeLessThanOrEqual(6);
  });
});

describe("predictionToCelsius", () => {
  it("adds the epoch mean in anomaly mode only", () => {
    expect(predictionToCelsius(1.5, "anomaly", 38)).toBeCloseTo(39.5, 12);
    expect(predictionToCelsius(41.2, "absolute", 38)).toBeCloseTo(41.2, 12);
    expect(predictionToCelsius(1.5, "anomaly", NaN)).toBeCloseTo(1.5, 12);
  });
});

describe.skipIf(!publicDataExists("model_web.json"))("real bundle: public/data/model_web.json", () => {
  it("matches every Python check row within 1e-4", () => {
    const real = readJson(PUBLIC_DATA_DIR, "model_web.json");
    const model = compileModel(real);
    const rows = real.check?.rows ?? [];
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((r, i) => {
      const diff = Math.abs(model.predictRow(r) - real.check.expected[i]);
      expect(diff, `check row ${i}`).toBeLessThan(1e-4);
    });
  });
});
