/**
 * Unit tests for the pure zone derivations (zones.json -> view model).
 * Uses the scaffold fixture plus small hand-made inputs with known answers.
 */
import { describe, expect, it } from "vitest";
import zonesFixture from "../../lib/__tests__/fixtures/zones.json";
import manifestFixture from "../../lib/__tests__/fixtures/manifest.json";
import {
  cellAreaKm2,
  defaultPair,
  diagnosticsRows,
  mergeRecommendations,
  orderedZones,
  previousEpoch,
  resolveEpoch,
  shapSignature,
  signatureMaxAbs,
  silhouetteQuality,
  totalArea,
  transitionPairs,
  transitionStats,
  zoneEpochs,
  zoneSummaries,
} from "./zoneModel.js";

describe("epochs", () => {
  it("reads epochs from area_km2 keys and resolves the shown epoch", () => {
    const years = zoneEpochs(zonesFixture, manifestFixture);
    expect(years).toEqual([2020, 2025]);
    expect(resolveEpoch(years, 2025)).toBe(2025);
    expect(resolveEpoch(years, 2010)).toBe(2025);
    expect(resolveEpoch([], 2025)).toBeNull();
    expect(previousEpoch(years, 2025)).toBe(2020);
    expect(previousEpoch(years, 2020)).toBeNull();
  });

  it("falls back to manifest epochs when profiles carry no areas", () => {
    expect(zoneEpochs({ zones: [{ id: 0 }] }, { epochs: [2015, 2010] })).toEqual([2010, 2015]);
  });
});

describe("zone summaries", () => {
  const list = orderedZones(zonesFixture, manifestFixture.zones);

  it("orders by canonical id and keeps colours", () => {
    expect(list.map((z) => z.id)).toEqual([0, 1, 2, 3]);
    expect(list[3].color).toBe("#fb7185");
    const shuffled = orderedZones({ zones: [{ id: 2 }, { id: 0 }] }, []);
    expect(shuffled.map((z) => z.name)).toEqual(["Ecological Cool Base", "Transition"]);
  });

  it("computes shares, changes and anomalies", () => {
    const years = [2020, 2025];
    expect(totalArea(list, 2025)).toBe(12);
    const s = zoneSummaries(list, years, 2025, { 2020: 37.6, 2025: 39.9 });
    expect(s[0].share).toBeCloseTo(0.25);
    expect(s[0].deltaArea).toBe(0);
    expect(s[0].deltaSharePp).toBeCloseTo(0);
    expect(s[3].anomaly).toBeCloseTo(42 - 39.9);
    expect(s[3].deltaLst).toBeCloseTo(2);
    expect(s[0].series.map((p) => p.year)).toEqual([2020, 2025]);
  });

  it("handles a missing current epoch without NaN", () => {
    const s = zoneSummaries(list, [], null, null);
    expect(s[0].area).toBeNull();
    expect(s[0].share).toBeNull();
    expect(s[0].prevYear).toBeNull();
  });
});

describe("signatures and recommendations", () => {
  it("ranks SHAP means by magnitude", () => {
    const sig = shapSignature({ shap_means: { a: 0.1, b: -0.5, c: 0.3, d: null } }, 2);
    expect(sig).toEqual([
      { feature: "b", value: -0.5 },
      { feature: "c", value: 0.3 },
    ]);
    expect(signatureMaxAbs([sig, [{ feature: "x", value: 0.9 }]])).toBe(0.9);
    expect(signatureMaxAbs([])).toBe(1);
  });

  it("merges recommendations with zone identity and validates CIs", () => {
    const rows = mergeRecommendations([
      { id: 3, name: "Core", color: "#f00", recommendations: [{ feature: "ndvi", expected_delta_c: -1.2, ci: [-1.5, -0.9], priority: "high" }] },
      { id: 0, name: "Cool", color: "#0f0", recommendations: [{ feature: "frac_forest", expected_delta_c: -0.2, ci: null, priority: "low" }, {}] },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ zoneId: 3, delta: -1.2, ci: [-1.5, -0.9], priorityRank: 0, action: "increase" });
    expect(rows[1].ci).toBeNull();
  });
});

describe("transitions", () => {
  it("parses and orders epoch pairs and picks a sensible default", () => {
    const pairs = transitionPairs({ "2015->2020": [], "2010->2015": [], junk: [] });
    expect(pairs.map((p) => p.key)).toEqual(["2010->2015", "2015->2020"]);
    expect(defaultPair(pairs, 2020)).toBe("2015->2020");
    expect(defaultPair(pairs, 2010)).toBe("2010->2015");
    expect(defaultPair(pairs, 2030)).toBe("2015->2020");
    expect(defaultPair([], 2020)).toBeNull();
  });

  it("derives row shares and net flows that sum to zero", () => {
    const st = transitionStats(zonesFixture.transitions["2020->2025"]);
    expect(st.total).toBe(12);
    expect(st.rowPct[0][0]).toBeCloseTo(2 / 3);
    expect(st.inflow[3]).toBe(1);
    expect(st.outflow[3]).toBe(0);
    expect(st.net.reduce((a, b) => a + b, 0)).toBe(0);
    expect(st.persistence).toBeCloseTo(9 / 12);
  });

  it("rejects ragged matrices", () => {
    expect(transitionStats([[1, 2], [3]])).toBeNull();
    expect(transitionStats(null)).toBeNull();
  });
});

describe("misc", () => {
  it("cell area, silhouette bands and diagnostics", () => {
    expect(cellAreaKm2({ study_area: { grid_res_m: 2000 } })).toBe(4);
    expect(cellAreaKm2(null)).toBe(1);
    expect(silhouetteQuality(0.6).label).toBe("strong structure");
    expect(silhouetteQuality(0.1).tone).toBe("amber");
    expect(diagnosticsRows({ k: [3, 2], inertia: [5, 9], silhouette: [0.3, null] })).toEqual([
      { k: 2, inertia: 9, silhouette: null },
      { k: 3, inertia: 5, silhouette: 0.3 },
    ]);
  });
});
