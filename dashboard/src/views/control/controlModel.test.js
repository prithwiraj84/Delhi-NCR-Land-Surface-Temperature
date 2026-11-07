/**
 * Pure Control-view models (controlModel.js, layerModel.js) on the synthetic v2 fixture and
 * hand-made v1-shaped inputs: tier-chip copy, honest skill labels, layer availability with
 * reasons, the legend domain being invariant across frames (UI_SPEC §15), the DescribeMap
 * sentence (signed UHI), cell walking, CSV export and compare sides.
 */
import { describe, expect, it } from "vitest";
import { buildTimeline, frameTierInfo } from "../../data/timeline.js";
import { createSynthV2 } from "../../data/fixtures/synthV2.js";
import {
  cellBox,
  cellTimelineCsv,
  compareSides,
  contextAnomaly,
  describeMapSentence,
  districtRank,
  hottestCellIndex,
  neighbourIndex,
  percentRank,
  skillHeadline,
  tierChipText,
  uhiCopy,
  waterfallForCell,
  windowLabel,
} from "./controlModel.js";
import { LAYER_ITEMS, layerAvailability, legendSpec, rasterAvailability, robustAbsBound, zoneEntries } from "./layerModel.js";

const synth = createSynthV2();
const timeline = buildTimeline(synth.manifest);
const v1Timeline = { ...timeline, schema: "v1", modeIds: ["day"], dtrAvailable: false, projYears: [], scenarios: [], scenarioIds: [], cubes: {} };

describe("tier chip and window copy", () => {
  it("formats observed, modelled and projected frames from the manifest", () => {
    expect(windowLabel([2024, 2026])).toBe("2024–26 Apr–Jun");
    expect(windowLabel([2025, 2025])).toBeNull();
    const obs = tierChipText(frameTierInfo(timeline, 2025, "day"), { mode: "day" });
    expect(obs.tier).toBe("observed");
    expect(obs.detail).toMatch(/Landsat .* · \d\d:\d\d IST · 2024–26 Apr–Jun · n=\d+ scenes/);
    const night1990 = tierChipText(frameTierInfo(timeline, 1990, "night"), { mode: "night" });
    expect(night1990.tier).toBe(synth.manifest.timeline.frames[0].night.tier);
    if (night1990.tier === "modelled") expect(night1990.detail).toMatch(/no satellite night LST for this frame/);
    const proj = tierChipText(frameTierInfo(timeline, 2040, "day", "ssp245"), { mode: "day", sspLabel: "SSP2-4.5", nGcm: 34 });
    expect(proj.detail).toBe("SSP2-4.5 · p50 [p5–p95] · 34 GCMs · model + CMIP6 scenario, not observations");
  });
});

describe("skill headline", () => {
  it("v2: pooled 20 km-block CV; v1: labelled mean-of-folds, never presented as pooled", () => {
    const v2 = skillHeadline({ modes: { day: { headline: { spatial: { r2: 0.861, rmse: 1.2 } } } } }, "day");
    expect(v2).toMatchObject({ pooled: true, short: "sp-CV R²" });
    expect(v2.label).toBe("Spatial-block CV R² 0.86 (pooled, 20 km blocks): skill in unseen areas");
    const v1 = skillHeadline({ modes: { day: { summary: [{ scheme: "spatial", model: "xgboost", r2_mean: 0.623, r2_std: 0.305, rmse_mean: 1.9 }] } } }, "day");
    expect(v1.pooled).toBe(false);
    expect(v1.label).toMatch(/v1: mean of per-fold R²/);
    expect(skillHeadline(null, "day")).toBeNull();
  });
});

describe("layer availability (reasons, never hidden)", () => {
  it("driver layers need an exact frame with XAI and a physical mode", () => {
    expect(layerAvailability("lst", { timeline, year: 2032, mode: "day" }).available).toBe(true);
    expect(layerAvailability("shap", { timeline, year: 2032, mode: "day" }).reason).toMatch(/exact frame/);
    expect(layerAvailability("shap", { timeline, year: 2040, mode: "day" }).reason).toMatch(/drivers exist for frames with XAI/);
    expect(layerAvailability("shap", { timeline, year: 2025, mode: "dtr" }).reason).toMatch(/not for DTR/);
    expect(layerAvailability("shap", { timeline, year: 2025, mode: "day" }).available).toBe(true);
    expect(layerAvailability("whatif", { timeline, year: 2025, mode: "day", scenarioReady: false }).available).toBe(false);
  });

  it("uncertainty follows the manifest tier; AOA and rasters are v2-only", () => {
    expect(layerAvailability("unc", { timeline, year: 2040, mode: "day" }).available).toBe(true);
    expect(layerAvailability("unc", { timeline, year: 2025, mode: "day" }).available).toBe(false);
    expect(layerAvailability("aoa", { timeline: v1Timeline, year: 2025, mode: "day" }).reason).toMatch(/rerun notebook v2/);
    expect(layerAvailability("unc", { timeline: v1Timeline, year: 2025, mode: "day" }).reason).toMatch(/rerun notebook v2/);
    expect(layerAvailability("lst", { timeline: v1Timeline, year: 2025, mode: "night" }).available).toBe(false);
    expect(rasterAvailability(v1Timeline, 2025, "day").reason).toMatch(/rerun notebook v2/);
    const f = timeline.frames.find((x) => x.raster.day);
    expect(rasterAvailability(timeline, f.year, "day").available).toBe(true);
    const noRaster = timeline.frames.find((x) => !x.raster.day);
    if (noRaster) expect(rasterAvailability(timeline, noRaster.year, "day").reason).toMatch(/not downscaled/);
    expect(LAYER_ITEMS.map((l) => l.id)).toEqual(["lst", "pred", "resid", "shap", "driver", "zones", "whatif", "unc", "aoa"]);
  });
});

describe("legend spec", () => {
  it("the LST colour domain is fixed: identical for every frame of a mode × variable", () => {
    for (const mode of ["day", "night"]) {
      const domains = timeline.years.map((y) => legendSpec({ layer: "lst", variable: "abs", mode, timeline, year: y }).domain);
      expect(new Set(domains.map((d) => d.join(","))).size).toBe(1);
      expect(domains[0]).toEqual(synth.manifest.timeline.domains[mode].abs);
    }
    const night = legendSpec({ layer: "lst", variable: "abs", mode: "night", timeline });
    expect(night.ramp).toBe("nocturne");
    expect(legendSpec({ layer: "lst", variable: "suhi", mode: "day", timeline })).toMatchObject({ ramp: "polar", signed: true });
    expect(legendSpec({ layer: "lst", variable: "abs", mode: "dtr", timeline }).ramp).toBe("amplitude");
    expect(legendSpec({ layer: "lst", variable: "abs", mode: "day", timeline, domainMode: "shared" }).shared).toBe(true);
    expect(legendSpec({ layer: "lst", variable: "abs", mode: "day", timeline, domain: { domain: [40, 46], stretched: true } })).toMatchObject({ stretched: true, fixed: false });
  });

  it("signed layers are symmetric about zero; categorical layers list zones by number and name", () => {
    const resid = legendSpec({ layer: "resid", variable: "abs", mode: "day", timeline, xai: { resid: Float32Array.from([-3, -1, 0, 1, 2, NaN]) } });
    expect(resid.domain[0]).toBe(-resid.domain[1]);
    expect(robustAbsBound(Float32Array.from([NaN, NaN]), 0.5)).toBe(0.5);
    const zones = legendSpec({ layer: "zones", variable: "abs", mode: "night", timeline, manifest: synth.manifest });
    expect(zones.kind).toBe("categorical");
    expect(zones.entries.map((e) => e.id)).toEqual([0, 1, 2, 3]);
    expect(zoneEntries({ zones: [{ id: 3, name: "Heat Extreme Core", color: "#fb7185" }] }, "day")[0].label).toBe("Heat Extreme Core");
  });
});

describe("DescribeMap sentence and UHI copy", () => {
  it("is signed, mode-tagged and names the bracket when interpolated", () => {
    expect(uhiCopy(-1.62, "day")).toBe("Surface UHI (urban − rural) −1.6 °C by day: built-up land is cooler than rural land");
    expect(uhiCopy(1.1, "night")).toMatch(/\+1\.1 °C at night: built-up land is warmer/);
    const info = frameTierInfo(timeline, 2025, "day");
    const exact = describeMapSentence({ stats: { year: 2025, mean: 41.24, ci: [40.6, 41.8], uhi: -1.6, hotCorePct: 27, hottestDistrict: { label: "Bharatpur", value: 44 } }, info, mode: "day", legend: { domain: [38, 48], unit: "°C" } });
    expect(exact).toMatch(/^Day 2025, observed \(Landsat/);
    expect(exact).toMatch(/NCR mean 41\.2\s°C \[40\.6–41\.8\]/);
    expect(exact).toMatch(/−1\.6 °C by day/);
    expect(exact).toMatch(/fixed scale 38\.0 to 48\.0 °C\./);
    const interp = describeMapSentence({ stats: { year: 2032, interpolated: true, bracket: { yA: 2030, yB: 2035 }, mean: 42, uhi: null, uhiReason: "surface UHI is not exported for projected frames" }, info: frameTierInfo(timeline, 2032, "day", "ssp245"), mode: "day", sspLabel: "SSP2-4.5" });
    expect(interp).toMatch(/about 2032 \(interpolated between 2030 and 2035\)/);
    expect(interp).toMatch(/NCR mean ≈42\.0/);
    expect(interp).toMatch(/Surface UHI is not exported for projected frames\./);
  });
});

describe("inspector maths", () => {
  const cells = { n: 5, cell_id: Int32Array.from([0, 1, 10, 11, 12]), grid: { width: 10 }, district: Int16Array.from([1, 1, 2, 2, 2]) };

  it("walks to grid neighbours through the canonical cell_id and stops at the ROI edge", () => {
    expect(neighbourIndex(cells, 0, 0, 1)).toBe(1);
    expect(neighbourIndex(cells, 0, 1, 0)).toBe(2);
    expect(neighbourIndex(cells, 3, 0, 1)).toBe(4);
    expect(neighbourIndex(cells, 1, 0, 1)).toBe(-1); // cell 2 is outside the ROI
    expect(neighbourIndex(cells, 0, -1, 0)).toBe(-1);
    expect(neighbourIndex(cells, 0, 0, -1)).toBe(-1);
  });

  it("finds the hottest cell, percent ranks and district ranks", () => {
    const v = Float32Array.from([30, NaN, 45, 44, 41]);
    expect(hottestCellIndex(v)).toBe(2);
    expect(hottestCellIndex(v, { district: 1, districtOf: cells.district })).toBe(0);
    expect(percentRank(Float32Array.from([1, 2, 3, 4]), 3)).toBeCloseTo(62.5, 9);
    expect(districtRank([{ id: "d:1", value: -1 }, { id: "d:2", value: 2 }, { id: "d:3", value: NaN }], "d:1")).toEqual({ rank: 2, of: 2 });
    const [w, s, e, n] = cellBox(77, 28.5, 1000);
    expect(e - w).toBeGreaterThan(0.009);
    expect(n - s).toBeCloseTo(1000 / 111320, 6);
  });

  it("adapts grouped SHAP to the waterfall (sorted by |SHAP|, additivity error)", () => {
    const wf = waterfallForCell({ base: 40, contributions: [{ group: "ndvi", value: -0.5 }, { group: "built", value: 1.2 }, { group: "water", value: NaN }], pred: 40.71 }, (g) => (g === "built" ? 0.6 : undefined));
    expect(wf.contributions.map((c) => c.name)).toEqual(["built", "ndvi", "water"]);
    expect(wf.contributions[0].value).toBe(0.6);
    expect(wf.reconstructed).toBeCloseTo(40.7, 9);
    expect(wf.additivityError).toBeCloseTo(-0.01, 9);
  });

  it("exports the cell timeline as RFC 4180 CSV", () => {
    const csv = cellTimelineCsv({ cellId: 7, mode: "day", lon: 77.1, lat: 28.6, district: 'Gurugram, "HR"', obs: [{ year: 2025, tier: "observed", p05: 40, p25: 40, p50: 40, p75: 40, p95: 40, outsideAoa: false }], ssp: { ssp245: [{ year: 2030, p05: 40.5, p25: 41, p50: 41.2, p75: 41.4, p95: 42, outsideAoa: true }] } });
    const lines = csv.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('7,77.10,28.60,"Gurugram, ""HR""",day,obs,2025,observed,40.00,40.00,40.00,40.00,40.00,0');
    expect(lines[2]).toMatch(/,ssp245,2030,projected,40\.50,41\.00,41\.20,41\.40,42\.00,1$/);
  });
});

describe("compare sides and weather context", () => {
  it("maps compare kinds to (year, mode, ssp) frames", () => {
    expect(compareSides({ kind: "y", a: 1990, b: 2050 }, { year: 2025, mode: "day", ssp: "ssp245", timeline })).toEqual({ A: { year: 1990, mode: "day", ssp: "ssp245" }, B: { year: 2050, mode: "day", ssp: "ssp245" } });
    expect(compareSides({ kind: "s", a: "ssp126", b: "ssp585" }, { year: 2025, mode: "night", ssp: "ssp245", timeline }).A).toEqual({ year: 2050, mode: "night", ssp: "ssp126" });
    expect(compareSides({ kind: "m", a: "day", b: "night" }, { year: 2010, mode: "day", ssp: null, timeline }).B.mode).toBe("night");
    expect(compareSides({ kind: null }, { year: 2010, mode: "day", ssp: null, timeline })).toBeNull();
  });

  it("weather context averages the ERA5-Land anomaly over the frame window, or is absent", () => {
    const ncr = { annual: { era5_skin: [{ year: 2024, anomaly: 0.6 }, { year: 2025, anomaly: 1.0 }, { year: 2026, anomaly: 0.8 }, { year: 2023, anomaly: 5 }] } };
    expect(contextAnomaly(ncr, { window: [2024, 2026] }).anomaly).toBeCloseTo(0.8, 9);
    expect(contextAnomaly({ annual: {} }, { window: [2024, 2026] })).toBeNull();
  });
});
