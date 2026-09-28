/**
 * DataContext decision helpers: scenario gating (DASH-05), epoch-keyed results (DASH-06) and
 * incremental validation (DASH-10).
 */
import { describe, expect, it } from "vitest";
import { currentScenarioResult, mergeValidation, scenarioIsActive, uncheckedYears } from "./contextLogic.js";

describe("scenarioIsActive", () => {
  it("runs scenarios only while the simulator or the scenario layer is visible", () => {
    expect(scenarioIsActive("twin", "lst_obs")).toBe(false);
    expect(scenarioIsActive("zones", "zones")).toBe(false);
    expect(scenarioIsActive("performance", "shap")).toBe(false);
    expect(scenarioIsActive("thresholds", "lst_obs")).toBe(true);
    expect(scenarioIsActive("twin", "scenario")).toBe(true);
  });
});

describe("currentScenarioResult", () => {
  it("hides a result computed for another epoch until the re-run lands", () => {
    const result = { epochYear: 2020, stats: { count: 3 } };
    expect(currentScenarioResult(result, 2020)).toBe(result);
    expect(currentScenarioResult(result, 2025)).toBeNull();
    expect(currentScenarioResult(null, 2025)).toBeNull();
    expect(currentScenarioResult(result, null)).toBeNull();
    const legacy = { stats: {} };
    expect(currentScenarioResult(legacy, 2025)).toBe(legacy);
  });
});

describe("incremental validation", () => {
  it("finds epochs loaded after the first check and merges their results", () => {
    const first = { ok: true, errors: [], warnings: ["w0"], epochsChecked: [2025], waterfallSample: 500 };
    const epochs = { 2025: {}, 2020: {}, 2015: null };
    expect(uncheckedYears(first, epochs)).toEqual([2020]);
    const merged = mergeValidation(first, { ok: false, errors: ["epoch 2020: bad"], warnings: [], epochsChecked: [2020] });
    expect(merged.epochsChecked).toEqual([2020, 2025]);
    expect(merged.ok).toBe(false);
    expect(merged.errors).toEqual(["epoch 2020: bad"]);
    expect(merged.warnings).toEqual(["w0"]);
    expect(merged.waterfallSample).toBe(500);
    expect(uncheckedYears(merged, epochs)).toEqual([]);
  });
});
