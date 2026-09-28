/**
 * Unit tests for the twin's pure data preparation (metric resolution, GPU attribute
 * arrays, dominant driver, waterfall additivity, district summaries, H3 aggregation).
 * Uses a tiny synthetic epoch with the same typed-array layout as data.prepareEpoch.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_ELEVATION_M,
  NO_DRIVER,
  buildCellAttributes,
  categoryShares,
  cellWaterfall,
  computeDominantDriver,
  computeEpochKpis,
  identityKey,
  resolveMetric,
  summarizeDistricts,
  symmetricBound,
  pickCell,
  PICK_MODES,
} from "./mapMetrics.js";
import { aggregateMetricToHexes, getHexIndex } from "./useH3Aggregation.js";

const FEATURES = ["ndvi", "frac_water", "ntl"];

/** 6 cells in two districts; cell 5 has no observation and no SHAP. */
function makeEpoch() {
  const n = 6;
  const shap = {
    ndvi: Float32Array.from([-1.0, 0.2, -0.1, 0.0, 0.5, NaN]),
    frac_water: Float32Array.from([0.1, -0.9, 0.05, 0.0, 0.1, NaN]),
    ntl: Float32Array.from([0.3, 0.1, 0.8, -0.2, -0.05, NaN]),
  };
  const base = 40;
  const lstPred = Float32Array.from([...Array(n).keys()].map((i) => base + FEATURES.reduce((s, f) => s + (Number.isFinite(shap[f][i]) ? shap[f][i] : 0), 0)));
  return {
    year: 2025,
    n,
    cell_size_m: 1000,
    base_value_c: base,
    cell_id: Int32Array.from([10, 11, 12, 20, 21, 22]),
    lon: Float64Array.from([77.0, 77.01, 77.02, 77.5, 77.51, 77.52]),
    lat: Float64Array.from([28.5, 28.5, 28.5, 28.7, 28.7, 28.7]),
    district: Int16Array.from([0, 0, 0, 1, 1, 1]),
    zone: Int8Array.from([3, 3, 0, 1, 2, -1]),
    lst_obs: Float32Array.from([41, 38, 42, 39, 40, NaN]),
    lst_pred: lstPred,
    resid_oof: Float32Array.from([0.5, -0.5, 1.0, -1.0, 0.0, NaN]),
    features: {
      ndvi: Float32Array.from([0.2, 0.5, 0.1, 0.3, 0.4, NaN]),
      frac_water: Float32Array.from([0, 0.3, 0, 0.1, 0, NaN]),
      ntl: Float32Array.from([3, 1, 4, 2, 2, NaN]),
    },
    shap,
    stats: {
      lst_obs: { min: 38, max: 42, mean: 40, p02: 38, p98: 42 },
      lst_pred: { min: 38, max: 42, mean: 40, p02: 38, p98: 42 },
      resid_oof: { min: -1, max: 1, mean: 0, p02: -1, p98: 1 },
      shapMaxAbs: { ndvi: 1, frac_water: 0.9, ntl: 0.8 },
    },
  };
}

const DISTRICTS = [
  { id: 0, name: "Delhi NCT", state: "Delhi" },
  { id: 1, name: "Gurugram", state: "Haryana" },
];

describe("resolveMetric + buildCellAttributes", () => {
  it("encodes observed LST with a p02-p98 sequential domain and NaN as flat no-data", () => {
    const epoch = makeEpoch();
    const metric = resolveMetric({ layer: "lst_obs", epoch, featureNames: FEATURES, zonesMeta: null });
    expect(metric.kind).toBe("sequential");
    expect(metric.domain).toEqual([38, 42]);
    const { colors, elevations } = buildCellAttributes(metric, epoch.n);
    expect(colors).toHaveLength(epoch.n * 4);
    expect(elevations[5]).toBe(0);
    // Hotter cell (42) is taller than the cooler one (38).
    expect(elevations[2]).toBeGreaterThan(elevations[1]);
    expect(elevations[2]).toBeLessThanOrEqual(MAX_ELEVATION_M * 1.2);
  });

  it("uses symmetric domains for signed layers", () => {
    const epoch = makeEpoch();
    const resid = resolveMetric({ layer: "resid_oof", epoch, featureNames: FEATURES });
    expect(resid.domain).toEqual([-1, 1]);
    const shap = resolveMetric({ layer: "shap", epoch, shapFeature: "ndvi", featureNames: FEATURES });
    expect(shap.domain).toEqual([-1, 1]);
    expect(symmetricBound({ p02: -0.2, p98: 0.7 })).toBeCloseTo(0.7);
  });

  it("dims and flattens cells outside a scenario region", () => {
    const epoch = makeEpoch();
    const deltaByCell = Float32Array.from([-0.5, NaN, -1.0, NaN, NaN, NaN]);
    const metric = resolveMetric({
      layer: "scenario",
      epoch,
      featureNames: FEATURES,
      scenarioResult: { deltaByCell, stats: { min: -1, max: -0.5 } },
    });
    expect(metric.available).toBe(true);
    const { elevations, colors } = buildCellAttributes(metric, epoch.n);
    expect(elevations[1]).toBe(0);
    expect(elevations[2]).toBeGreaterThan(elevations[0]);
    expect(colors[1 * 4 + 3]).toBeLessThan(colors[0 * 4 + 3]);
  });

  it("reports an unavailable scenario when the result belongs to another epoch", () => {
    const epoch = makeEpoch();
    const metric = resolveMetric({
      layer: "scenario",
      epoch,
      featureNames: FEATURES,
      scenarioResult: { deltaByCell: new Float32Array(3), stats: {} },
    });
    expect(metric.available).toBe(false);
    expect(metric.emptyReason).toMatch(/scenario/i);
  });

  it("never paints a same-length result computed for a different epoch year (DASH-06)", () => {
    const epoch = { ...makeEpoch(), year: 2025 };
    const deltaByCell = new Float32Array(epoch.n).fill(-0.5);
    const stale = resolveMetric({
      layer: "scenario",
      epoch,
      featureNames: FEATURES,
      scenarioResult: { deltaByCell, stats: { min: -0.5, max: -0.5 }, epochYear: 2020 },
    });
    expect(stale.available).toBe(false);
    const fresh = resolveMetric({
      layer: "scenario",
      epoch,
      featureNames: FEATURES,
      scenarioResult: { deltaByCell, stats: { min: -0.5, max: -0.5 }, epochYear: 2025 },
    });
    expect(fresh.available).toBe(true);
  });

  it("computes zone shares over valid cells only", () => {
    const epoch = makeEpoch();
    const metric = resolveMetric({ layer: "zones", epoch, featureNames: FEATURES, zonesMeta: null });
    const shares = categoryShares(metric, epoch.n);
    expect(shares[0].key).toBe(3);
    expect(shares[0].share).toBeCloseTo(2 / 5);
    expect(shares.reduce((s, c) => s + c.share, 0)).toBeCloseTo(1);
  });
});

describe("dominant driver", () => {
  it("takes argmax |SHAP| per cell and marks all-missing cells", () => {
    const epoch = makeEpoch();
    const { driver, counts, total } = computeDominantDriver(epoch, FEATURES);
    expect(Array.from(driver)).toEqual([0, 1, 2, 2, 0, NO_DRIVER]);
    expect(total).toBe(5);
    expect(Array.from(counts)).toEqual([2, 1, 2]);
    // Cached per epoch.
    expect(computeDominantDriver(epoch, FEATURES).driver).toBe(driver);
  });
});

describe("cellWaterfall", () => {
  it("orders contributions by |SHAP| and satisfies additivity", () => {
    const epoch = makeEpoch();
    const wf = cellWaterfall(epoch, 0, FEATURES);
    expect(wf.contributions.map((c) => c.name)).toEqual(["ndvi", "ntl", "frac_water"]);
    expect(wf.reconstructed).toBeCloseTo(wf.prediction, 4);
    expect(Math.abs(wf.additivityError)).toBeLessThan(1e-4);
  });
});

describe("district summaries and KPIs", () => {
  it("computes centroids, bboxes, mean LST and the heat-core share", () => {
    const epoch = makeEpoch();
    const summaries = summarizeDistricts(epoch, DISTRICTS);
    expect(summaries).toHaveLength(2);
    expect(summaries[0].lon).toBeCloseTo(77.01);
    expect(summaries[0].meanLst).toBeCloseTo((41 + 38 + 42) / 3);
    expect(summaries[1].meanLst).toBeCloseTo(39.5);
    const kpis = computeEpochKpis(epoch, DISTRICTS);
    expect(kpis.hottest.name).toBe("Delhi NCT");
    expect(kpis.heatCoreShare).toBeCloseTo(2 / 5);
  });
});

describe("H3 aggregation", () => {
  it("indexes cells once per resolution and aggregates means and modes", () => {
    const epoch = makeEpoch();
    const index = getHexIndex(epoch, 6);
    expect(getHexIndex(epoch, 6)).toBe(index);
    expect(index.cellHex).toHaveLength(epoch.n);

    const lst = resolveMetric({ layer: "lst_obs", epoch, featureNames: FEATURES });
    const hexes = aggregateMetricToHexes(lst, index);
    const totalCells = hexes.reduce((s, h) => s + h.count, 0);
    expect(totalCells).toBe(5); // NaN cell excluded from the mean
    hexes.forEach((h) => expect(typeof h.hex).toBe("string"));

    const zones = resolveMetric({ layer: "zones", epoch, featureNames: FEATURES });
    const zoneHexes = aggregateMetricToHexes(zones, index);
    const hexOfCell0 = zoneHexes[index.cellHex[0]];
    expect(hexOfCell0.value).toBe(3);
  });
});

describe("identityKey", () => {
  it("is stable per object and distinct across objects", () => {
    const a = {};
    const b = {};
    expect(identityKey(a)).toBe(identityKey(a));
    expect(identityKey(a)).not.toBe(identityKey(b));
  });
});

describe("pickCell (keyboard cell inspection, DASH-14)", () => {
  it("finds the hottest, coolest and most strongly explained cell, optionally per district", () => {
    const epoch = makeEpoch();
    expect(pickCell(epoch, { mode: "hottest" })).toBe(2);
    expect(pickCell(epoch, { mode: "coolest" })).toBe(1);
    expect(pickCell(epoch, { mode: "max_shap", featureNames: FEATURES })).toBe(0);
    expect(pickCell(epoch, { mode: "coolest", district: 1 })).toBe(3);
    expect(pickCell(epoch, { mode: "max_shap", district: 1, featureNames: FEATURES })).toBe(4);
    expect(pickCell(epoch, { mode: "hottest", district: 9 })).toBeNull();
    expect(pickCell(null, { mode: "hottest" })).toBeNull();
    expect(PICK_MODES.map((m) => m.id)).toEqual(["hottest", "coolest", "max_shap"]);
  });
});
