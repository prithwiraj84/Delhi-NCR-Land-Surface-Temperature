/**
 * Unit tests for the pure metrics.json derivations behind the Model Performance view.
 */
import { describe, expect, it } from "vitest";
import metricsFixture from "../../lib/__tests__/fixtures/metrics.json";
import {
  bestModelsByScheme,
  buildInterpretations,
  deriveKpis,
  foldPoints,
  formatDuration,
  formatP,
  groupedMetricData,
  hardwareInfo,
  rapidsBackends,
  moranScatterData,
  summaryMeans,
  summaryTableRows,
  timingRows,
} from "./perfModel.js";

describe("KPIs and interpretation", () => {
  it("leads with the best spatial-CV model and its optimism gap", () => {
    const k = deriveKpis(metricsFixture);
    expect(k.bestScheme).toBe("spatial");
    expect(k.best.model).toBe("gnn");
    expect(k.temporal.model).toBe("gnn");
    expect(k.gap).toBeCloseTo(0.05);
    expect(k.moranModel).toBe("xgboost");
    expect(k.moranYear).toBe(2025);
    expect(k.moranTarget.I).toBe(0.6);
  });

  it("produces plain-language callouts", () => {
    const k = deriveKpis(metricsFixture);
    const items = buildInterpretations(metricsFixture, k, 2025);
    expect(items.map((i) => i.id)).toEqual(["optimism", "temporal", "moran", "benchmark"]);
    expect(items[0].body).toContain("lower than random CV");
    expect(items[2].tone).toBe("warning");
  });

  it("degrades gracefully without metrics", () => {
    const k = deriveKpis(null);
    expect(k.best).toBeNull();
    expect(buildInterpretations(null, k, null)).toEqual([]);
    expect(summaryTableRows(null)).toEqual([]);
    expect(groupedMetricData(null, "r2")).toEqual([]);
  });
});

describe("chart data", () => {
  it("groups summary rows per model and finds the best per scheme", () => {
    const rows = groupedMetricData(metricsFixture, "rmse");
    expect(rows).toHaveLength(6);
    expect(rows[0].values.spatial).toEqual({ mean: 1.5, sd: 0.05 });
    expect(bestModelsByScheme(metricsFixture.summary, ["random", "spatial"], "rmse")).toEqual({ random: "gnn", spatial: "gnn" });
    expect(summaryMeans(metricsFixture, "r2")["spatial|xgboost"]).toBe(0.73);
    expect(foldPoints(metricsFixture, "r2")).toHaveLength(18);
  });

  it("builds table rows with undefined for missing values", () => {
    const rows = summaryTableRows({
      schemes: ["spatial"],
      models: ["a", "b"],
      summary: [
        { scheme: "spatial", model: "b", r2_mean: 0.5, r2_std: null, rmse_mean: 1, mae_mean: null, n_folds: 5 },
        { scheme: "spatial", model: "a", r2_mean: 0.7, rmse_mean: 2, n_folds: 5 },
      ],
      folds: [{ scheme: "spatial", model: "a", fold: 0, fit_seconds: 2, device: "cuda:0" }],
    });
    expect(rows.map((r) => r.model)).toEqual(["a", "b"]);
    expect(rows[0].best).toMatchObject({ r2: true, rmse: false });
    expect(rows[1].r2_std).toBeUndefined();
    expect(rows[1].mae_mean).toBeUndefined();
    expect(rows[0].devices).toEqual(["cuda:0"]);
    expect(rows[0].meanFitSeconds).toBe(2);
  });

  it("classifies Moran scatter quadrants and skips invalid points", () => {
    const d = moranScatterData({ moran_scatter: { m: { year: 2025, z: [1, -1, 1, -1, null], lag: [1, -1, -1, 1, 0], slope: 0.2 } } }, "m");
    expect(d.counts).toEqual({ HH: 1, LL: 1, HL: 1, LH: 1 });
    expect(d.points).toHaveLength(4);
    expect(d.slope).toBe(0.2);
    expect(moranScatterData(metricsFixture, "missing")).toBeNull();
  });
});

describe("hardware and formatting", () => {
  it("folds long timing tails and normalises hardware", () => {
    const timings = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`s${i}`, i + 1]));
    const { rows, total } = timingRows(timings, 10);
    expect(rows).toHaveLength(10);
    expect(rows[0].stage).toBe("s11");
    expect(rows[9].folded).toBe(true);
    expect(rows[9].seconds).toBe(1 + 2 + 3);
    expect(total).toBe(78);
    const hw = hardwareInfo(metricsFixture);
    expect(hw.gpus).toEqual([]);
    expect(hw.foldDevices).toEqual(["cpu", "cuda:0"]);
    expect(hw.rapids).toBe(false);
    expect(hw.rapidsUsed).toEqual([]);
  });

  it("lists the RAPIDS components that actually ran (GPU-03)", () => {
    expect(rapidsBackends(["cuml_rf", "cudf"])).toEqual(["cuml_rf", "cudf"]);
    expect(rapidsBackends({ cuml_rf: true, cuml_kmeans: false, cudf: true })).toEqual(["cuml_rf", "cudf"]);
    expect(rapidsBackends(null)).toEqual([]);
    const hw = hardwareInfo({ hardware: { rapids: true, rapids_used: { cuml_knn: true } } });
    expect(hw.rapidsUsed).toEqual(["cuml_knn"]);
  });

  it("formats p-values and durations", () => {
    expect(formatP(0.0004)).toBe("p < 0.001");
    expect(formatP(0.031)).toBe("p = 0.031");
    expect(formatDuration(8.25)).toBe("8.3 s");
    expect(formatDuration(245)).toBe("4 m 05 s");
    expect(formatDuration(3720)).toBe("1 h 02 m");
  });
});
