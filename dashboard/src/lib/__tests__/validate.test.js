import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { validateBundle, validateEpochs, CANONICAL_FEATURES } from "../validate.js";
import { prepareEpoch } from "../data.js";
import { existingBundleFile, fixture, publicDataExists, readJson, PUBLIC_DATA_DIR } from "./testUtils.js";

/** Fresh deep copy of the whole fixture bundle (tests mutate it freely). */
function fixtureBundle() {
  return {
    manifest: fixture("manifest.json"),
    epochs: { 2020: fixture("epoch_2020.json"), 2025: fixture("epoch_2025.json") },
    model: fixture("model_web.json"),
    dependence: fixture("dependence.json"),
    zones: fixture("zones.json"),
    metrics: fixture("metrics.json"),
    shapGlobal: fixture("shap_global.json"),
  };
}

describe("validateBundle on the fixture bundle", () => {
  it("passes with raw JSON epochs", () => {
    const result = validateBundle(fixtureBundle());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("passes with prepared typed-array epochs (Map and array forms)", () => {
    const bundle = fixtureBundle();
    const prepared = Object.values(bundle.epochs).map((e) => prepareEpoch(e, bundle.manifest));
    expect(validateBundle({ ...bundle, epochs: prepared }).errors).toEqual([]);
    expect(validateBundle({ ...bundle, epochs: new Map(prepared.map((e) => [e.year, e])) }).ok).toBe(true);
  });

  it("the fixture uses the canonical SPEC feature order", () => {
    expect(fixture("manifest.json").features.map((f) => f.name)).toEqual(CANONICAL_FEATURES);
  });
});

describe("validateBundle detects contract violations", () => {
  it("flags a broken SHAP waterfall invariant", () => {
    const bundle = fixtureBundle();
    bundle.epochs[2025].lst_pred = bundle.epochs[2025].lst_pred.map((v) => v + 0.5);
    const { ok, errors } = validateBundle(bundle);
    expect(ok).toBe(false);
    expect(errors.join("\n")).toMatch(/epoch 2025: lst_pred ≠ base_value_c \+ Σ shap on 12\/12/);
  });

  it("flags column length, key order, zone range and duplicate ids", () => {
    const bundle = fixtureBundle();
    const e = bundle.epochs[2020];
    e.lat = e.lat.slice(2);
    const { ndvi, ...rest } = e.shap;
    e.shap = { ...rest, ndvi };
    bundle.epochs[2025].zone[0] = 7;
    bundle.epochs[2025].cell_id[1] = bundle.epochs[2025].cell_id[0];
    const text = validateBundle(bundle).errors.join("\n");
    expect(text).toMatch(/epoch 2020: column "lat" has length 10, expected 12/);
    expect(text).toMatch(/epoch 2020: shap keys do not match/);
    expect(text).toMatch(/epoch 2025: 1 cells have a zone outside 0..3/);
    expect(text).toMatch(/epoch 2025: 1 duplicate cell_id/);
  });

  it("flags model/Python disagreement and feature-order mismatch", () => {
    const bundle = fixtureBundle();
    bundle.model.check.expected[0] += 0.5;
    bundle.model.features = [...bundle.model.features].reverse();
    const text = validateBundle(bundle).errors.join("\n");
    expect(text).toMatch(/model: features must equal the manifest feature order/);
    expect(text).toMatch(/check rows differ from Python/);
  });

  it("flags manifest, dependence, zones, metrics and shap_global problems", () => {
    const bundle = fixtureBundle();
    bundle.manifest.data_mode = "demo";
    delete bundle.manifest.files.epochs["2020"];
    bundle.dependence.features.ndvi.mean.pop();
    bundle.dependence.features.ndvi.threshold.direction = "sideways";
    bundle.zones.transitions["2020->2025"].pop();
    bundle.metrics.summary[0] = { scheme: "spatial" };
    bundle.shapGlobal.global.ci_lo.pop();
    const text = validateBundle(bundle).errors.join("\n");
    expect(text).toMatch(/data_mode must be "gee" or "synthetic"/);
    expect(text).toMatch(/files.epochs is missing 2020/);
    expect(text).toMatch(/dependence.ndvi: bin_centers\/mean/);
    expect(text).toMatch(/invalid threshold.direction "sideways"/);
    expect(text).toMatch(/transitions\["2020->2025"\] must be a 4x4 matrix/);
    expect(text).toMatch(/metrics: summary\[0\] missing model, r2_mean/);
    expect(text).toMatch(/shap_global: global.ci_lo must have 17 values/);
  });

  it("treats missing optional assets as warnings only", () => {
    const { manifest, epochs } = fixtureBundle();
    const result = validateBundle({ manifest, epochs: { 2025: epochs[2025] }, model: null });
    expect(result.ok).toBe(true);
    expect(result.warnings.join("\n")).toMatch(/model_web.json not provided/);
    expect(result.warnings.join("\n")).toMatch(/zones.json not provided/);
  });

  it("reports a missing manifest as an error", () => {
    expect(validateBundle({}).ok).toBe(false);
  });

  it("warns when an estimate lies outside its own interval or a CI has no estimate (DASH-02, SCI-05)", () => {
    const bundle = fixtureBundle();
    bundle.shapGlobal.global.ci_lo[0] = bundle.shapGlobal.global.mean_abs[0] + 0.01;
    bundle.shapGlobal.global.ci_hi[0] = bundle.shapGlobal.global.mean_abs[0] + 0.02;
    bundle.zones.zones[1].recommendations[0].expected_delta_c = -2.65;
    bundle.zones.zones[1].recommendations[0].ci = [-2.61, -2.39];
    const th = bundle.dependence.features.ndvi.threshold;
    th.saturation = null;
    th.saturation_ci = [0.2, 0.3];
    th.breakpoint_support = 1.5;
    const result = validateBundle(bundle);
    expect(result.ok).toBe(true);
    const text = result.warnings.join("\n");
    expect(text).toMatch(/shap_global: mean \|SHAP\| lies outside its bootstrap interval for 1 feature\(s\): ndvi/);
    expect(text).toMatch(/zone 1 recommendation 0 \(ndvi\): expected_delta_c -2.65 lies outside/);
    expect(text).toMatch(/dependence.ndvi: saturation_ci exported without a saturation estimate/);
    expect(text).toMatch(/breakpoint_support must be a fraction/);
  });

  it("warns about recommendations on non-actionable features (D2)", () => {
    const bundle = fixtureBundle();
    bundle.manifest.features.find((f) => f.name === "ndvi").actionable = false;
    expect(validateBundle(bundle).warnings.join("\n")).toMatch(/recommendation 0 \(ndvi\): feature is not actionable/);
  });

  it("checks interactions, coupling and districts when supplied (DASH-10)", () => {
    const bundle = fixtureBundle();
    const good = validateBundle({
      ...bundle,
      interactions: fixture("interactions.json"),
      coupling: fixture("scenario_coupling.json"),
      districts: fixture("districts.geojson"),
    });
    expect(good.errors).toEqual([]);
    expect(good.epochsChecked).toEqual([2020, 2025]);
    expect(good.waterfallSample).toBe(500);

    const coupling = fixture("scenario_coupling.json");
    coupling.coupling.frac_forest.ndvi = "steep";
    coupling.coupling.frac_moon = { ndvi: 0.1 };
    const interactions = fixture("interactions.json");
    interactions.global.pop();
    const text = validateBundle({ ...bundle, coupling, interactions, districts: { type: "Feature" } }).errors.join("\n");
    expect(text).toMatch(/coupling: frac_forest -> ndvi slope is not a finite number/);
    expect(text).toMatch(/coupling: unknown fraction "frac_moon"/);
    expect(text).toMatch(/interactions: global must be a 17x17 matrix/);
    expect(text).toMatch(/districts: must be a GeoJSON FeatureCollection/);
  });

  it("validateEpochs checks only the given epochs", () => {
    const bundle = fixtureBundle();
    bundle.epochs[2020].zone[0] = 9;
    const res = validateEpochs({ manifest: bundle.manifest, epochs: { 2020: bundle.epochs[2020] } });
    expect(res.epochsChecked).toEqual([2020]);
    expect(res.errors.join("\n")).toMatch(/epoch 2020: 1 cells have a zone outside 0..3/);
    expect(validateEpochs({ manifest: bundle.manifest, epochs: { 2025: bundle.epochs[2025] } }).ok).toBe(true);
  });
});

describe.skipIf(!publicDataExists("manifest.json"))("real bundle: public/data", () => {
  it("satisfies the SPEC §4 contract", () => {
    const manifest = readJson(PUBLIC_DATA_DIR, "manifest.json");
    // Declared names may be .json.gz (SPEC §4, gzip level 9) or plain .json; both are read.
    const load = (key) => {
      const file = existingBundleFile(PUBLIC_DATA_DIR, manifest.files?.[key]);
      return file ? readJson(PUBLIC_DATA_DIR, file) : null;
    };
    const epochs = {};
    for (const year of manifest.epochs) {
      const declared = manifest.files.epochs[String(year)];
      const file = existingBundleFile(PUBLIC_DATA_DIR, declared);
      expect(file, `epoch ${year}: ${declared} missing on disk`).toBeTruthy();
      expect(fs.existsSync(path.join(PUBLIC_DATA_DIR, declared)), `declared file ${declared} must exist`).toBe(true);
      epochs[year] = readJson(PUBLIC_DATA_DIR, file);
    }
    const result = validateBundle({
      manifest,
      epochs,
      model: load("model"),
      dependence: load("dependence"),
      zones: load("zones"),
      metrics: load("metrics"),
      shapGlobal: load("shap_global"),
      interactions: load("interactions"),
      coupling: load("coupling"),
      districts: load("districts"),
    });
    if (result.warnings.length) console.warn(`[real bundle] warnings:\n${result.warnings.join("\n")}`);
    expect(result.errors).toEqual([]);
  }, 120000);
});
