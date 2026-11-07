/**
 * Pure-model regressions of the v2 review fixes (F4): projected change vs the weather-normalised
 * baseline (T-F4-05), observed-evidence change frames and the harmonised guard (T-F4-08), per-sensor
 * annual context (T-F4-09), DTR copy (T-F4-10), cell headline + hover quantity (T-F4-06 / T-F4-15),
 * block-size rows (T-F4-26), the optional bundle keys (T-F4-31).
 */
import { describe, expect, it } from "vitest";
import { createSynthV2 } from "../../data/fixtures/synthV2.js";
import { normalizeSeries, scopeBaseline, scopeSeries } from "../../data/series.js";
import { buildTimeline } from "../../data/timeline.js";
import { validateV2 } from "../../data/validateV2.js";
import { annualRuns, buildFanModel } from "../../viz/fanModel.js";
import { cellHeadline, describeMapSentence, firstComparableFrame, hoverQuantity, uhiCopy } from "../control/controlModel.js";
import { legendSpec, zoneEntries } from "../control/layerModel.js";
import { barcodeRows, changeFrames, firstLastChange, LEVELS_NOT_HARMONISED, ledgerRows, projectedChange } from "../timeline/timelineModel.js";
import { ablationSummary, blockSizeRows, landModelSummary, v1v2Story } from "../lab/labModel.js";

const synth = createSynthV2();
const plain = createSynthV2({ optionalKeys: false });
const series = normalizeSeries(synth.files.get("timeline_series.json.gz")());
const seriesPlain = normalizeSeries(plain.files.get("timeline_series.json.gz")());

describe("projected change vs the weather-normalised baseline (T-F4-05)", () => {
  it("delta equals the decomposition total and differs from p50 − observed NOW", () => {
    for (const s of [series, seriesPlain]) {
      const ncr = scopeSeries(s, "ncr", "day");
      const p = projectedChange(ncr, "ssp245", 2050, 2025);
      const total = ncr.decomposition.ssp245["2050"].total;
      expect(p.delta).toBeCloseTo(total, 2);
      expect(Math.abs(p.p50 - p.observedNow - p.delta)).toBeGreaterThan(0.2);
      expect(p.lo).toBeLessThanOrEqual(p.delta);
      // Consistent with the threshold years (first p50 − baseline ≥ +1 °C).
      const plus1 = ncr.thresholdYears.ssp245["+1"];
      const first = ncr.ssp.ssp245.find((r) => r.p50 - p.base >= 1)?.year ?? null;
      expect(first).toBe(plus1);
    }
  });

  it("base source order: baseline_c, then p50 − total, then baseline_level_c (NCR only)", () => {
    const ncr = scopeSeries(series, "ncr", "night");
    expect(scopeBaseline(ncr, "ssp585").source).toBe("baseline_c");
    expect(scopeBaseline(scopeSeries(seriesPlain, "ncr", "night"), "ssp585").source).toBe("p50-total");
    const bare = { ...ncr, decomposition: {} };
    expect(scopeBaseline(bare, "ssp585")).toEqual({ base: series.baselineLevel.night, source: "baseline_level_c", year: 2030 });
    const district = scopeSeries(series, "d:3", "day");
    expect(district.baselineLevel).toBeNull();
    expect(scopeBaseline({ ...district, decomposition: {} }, "ssp245")).toBeNull();
    // Without any baseline there is no projected change (never against the observed NOW frame).
    expect(projectedChange({ ...district, decomposition: {} }, "ssp245", 2050, 2025)).toBeNull();
  });

  it("ledger p50 delta uses the same baseline", () => {
    const rows = ledgerRows(series, { now: 2025, ssp: "ssp245", lastYear: 2050 });
    const d = scopeSeries(series, rows[0].id, "day");
    expect(rows[0].p2050Delta).toBeCloseTo(projectedChange(d, "ssp245", 2050, 2025).delta, 9);
    expect(rows[0].spark.baseline).toBeCloseTo(scopeBaseline(d, "ssp245").base, 9);
  });
});

describe("observed changes use observed-evidence frames only (T-F4-08)", () => {
  it("night change starts at the trend's first frame (2000), day still at 1990", () => {
    const night = scopeSeries(series, "ncr", "night");
    const day = scopeSeries(series, "ncr", "day");
    expect(firstLastChange(night, 2025).from).toBe(2000);
    expect(night.trend.obs.period[0]).toBe(2000);
    expect(firstLastChange(day, 2025).from).toBe(1990);
    // Without exported trend frames: tiers decide (modelled 1990/1995 dropped).
    const noTrend = { ...night, trend: null };
    expect(changeFrames(noTrend, 2025)[0].year).toBe(2000);
    // DTR (weaker tier) drops 1990/1995 too.
    const dtr = scopeSeries(series, "ncr", "dtr");
    expect(firstLastChange(dtr, 2025).from).toBe(2000);
    expect(firstComparableFrame(night.frames).year).toBe(2000);
  });

  it("non-harmonised levels: no frame differences in the ledger; barcode shows within-frame anomalies, Δ sort off", () => {
    const rows = ledgerRows(series, { now: 2025, ssp: "ssp245", harmonised: false });
    expect(rows.every((r) => Number.isNaN(r.dayDelta) && Number.isNaN(r.nightDelta))).toBe(true);
    const tl = buildTimeline(synth.manifest);
    const bc = barcodeRows(series, { mode: "day", ssp: "ssp245", years: tl.years, referencePeriod: [2000, 2020], now: 2025, sort: "delta", harmonised: false });
    expect(bc.every((r) => Number.isNaN(r.delta))).toBe(true);
    const names = bc.map((r) => r.label);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    const ncr2010 = scopeSeries(series, "ncr", "day").frames.find((f) => f.year === 2010).mean;
    const cell = bc[0].cells.find((c) => c.year === 2010);
    expect(cell.value).toBeCloseTo(cell.raw - ncr2010, 6);
  });
});

describe("annual satellite context per sensor (T-F4-09)", () => {
  it("one monotone path per sensor with drift flags kept", () => {
    const night = scopeSeries(series, "ncr", "night");
    const m = buildFanModel({ series: night, ssps: [], now: 2025 });
    expect(Object.keys(m.annualBySensor).sort()).toEqual(["MODIS Aqua", "VIIRS (Aqua-calibrated)"]);
    for (const pts of Object.values(m.annualBySensor)) for (let i = 1; i < pts.length; i += 1) expect(pts[i].x).toBeGreaterThan(pts[i - 1].x);
    expect(m.annualBySensor["MODIS Aqua"].filter((p) => p.drift).map((p) => p.x)).toEqual([2022, 2023, 2024, 2025]);
    const runs = annualRuns(m.annualBySensor["MODIS Aqua"]);
    expect(runs.map((r) => r.drift)).toEqual([false, true]);
    expect(runs[1].pts[0].x).toBe(2021); // the segment into the first drift year is drawn as drift
  });
});

describe("DTR copy (T-F4-10)", () => {
  it("speaks of the diurnal range, never 'cooler than rural' or 'Hottest district'", () => {
    expect(uhiCopy(-1.2, "dtr")).toBe("Urban − rural diurnal range −1.2 °C: built-up land swings less between day and night");
    expect(uhiCopy(0.8, "dtr")).toMatch(/swings more/);
    const s = describeMapSentence({ stats: { year: 2025, mean: 14, uhi: -1.2, hottestDistrict: { label: "Nuh", value: 16.2 } }, info: { tier: "observed" }, mode: "dtr" });
    expect(s).toMatch(/Largest diurnal range: Nuh at 16\.2\s?°C/);
    expect(s).not.toMatch(/cooler than rural|Hottest district/);
  });
});

describe("inspector headline and hover quantity (T-F4-06 / T-F4-15)", () => {
  it("labels from the manifest tier", () => {
    expect(cellHeadline({ tier: "observed", obs: 40.1, map: 40.3 })).toMatchObject({ label: "Obs", value: 40.1 });
    expect(cellHeadline({ tier: "observed-sparse", obs: NaN, map: 39 })).toMatchObject({ label: "Map", value: 39 });
    expect(cellHeadline({ tier: "reconstructed", obs: 25, map: 25.4 })).toMatchObject({ label: "Reconstructed", value: 25.4 });
    const m = cellHeadline({ tier: "modelled", map: 24, pred: 23.5 });
    expect(m).toMatchObject({ label: "Map (modelled)", predLabel: "Pred (model)", showPred: true });
    expect(cellHeadline({ tier: "modelled", map: 24, pred: 24.02 }).showPred).toBe(false);
    expect(cellHeadline({ frameKind: "projected", tier: "projected", sspLabel: "SSP5-8.5", map: 45 }).label).toBe("SSP5-8.5 p50");
    expect(cellHeadline({ mode: "dtr", tier: "observed", map: 13 })).toMatchObject({ label: "DTR", predLabel: "Day pred", residLabel: "Day resid" });
  });

  it("names the displayed quantity", () => {
    expect(hoverQuantity({ layer: "lst", variable: "abs", q: "p95" }).prefix).toBe("p95");
    expect(hoverQuantity({ layer: "lst", variable: "anom", q: "p50" })).toEqual({ prefix: "anomaly", signed: true });
    expect(hoverQuantity({ layer: "unc" }).prefix).toBe("spread");
    expect(hoverQuantity({ layer: "lst", variable: "delta", q: "p50", deltaRef: null }, { firstYear: 1990 }).prefix).toBe("Δ vs 1990");
    expect(hoverQuantity({ layer: "whatif" }).prefix).toBe("what-if Δ");
    expect(hoverQuantity({ layer: "lst", variable: "abs", q: "p50" }).prefix).toBe("");
  });
});

describe("Model Lab helpers (T-F4-13 / T-F4-26 / T-F4-30)", () => {
  it("block-size rows keep a random row labelled", () => {
    const rows = blockSizeRows({ block_size_curve: [{ block_km: 5, r2_pooled: 0.9 }, { label: "random", r2_pooled: 0.97 }] });
    expect(rows.map((r) => [r.id, r.block])).toEqual([["5", 5], ["random", "random"]]);
  });

  it("v1 → v2 story and ablation, land-model verdict", () => {
    const metrics = synth.files.get("metrics.json")();
    expect(ablationSummary(metrics.modes.day)).toBeNull();
    const story = v1v2Story({ ...metrics, data_mode: "synthetic" }, "day");
    expect(story[0]).toMatch(/0\.62 → /);
    expect(story.join(" ")).toMatch(/not comparable with the real v1 run/);
    expect(landModelSummary(metrics)).toMatchObject({ verdict: "mixed", truth: expect.stringMatching(/extrapolated/) });
    expect(landModelSummary(plain.files.get("metrics.json")())).toMatchObject({ verdict: null, checks: [], fomBeats: true });
  });
});

describe("optional bundle keys (T-F4-31)", () => {
  const tl = buildTimeline(synth.manifest);
  const assets = (s) => ({ zones: s.files.get("zones.json")(), metrics: s.files.get("metrics.json")() });

  it("series keep frame coverage; zone entries carry display name and caveat", () => {
    const f = scopeSeries(series, "ncr", "day").frames[0];
    expect(f.coverage).toBeGreaterThan(0);
    expect(f.coverage).toBeLessThanOrEqual(1);
    expect(Number.isNaN(scopeSeries(seriesPlain, "ncr", "day").frames[0].coverage)).toBe(true);
    const night = zoneEntries(synth.manifest, "night");
    expect(night[1]).toMatchObject({ name: "Riparian Buffer", label: "Moderate mosaic (no riparian signal)" });
    expect(night[1].caveat).toMatch(/Named Riparian Buffer/);
    expect(zoneEntries(plain.manifest, "night")[1]).toMatchObject({ label: "Riparian Buffer", caveat: null });
  });

  it("validateV2 accepts bundles with and without the keys and type-checks them", () => {
    for (const s of [synth, plain]) {
      const v = validateV2({ manifest: s.manifest, timeline: buildTimeline(s.manifest), series: normalizeSeries(s.files.get("timeline_series.json.gz")()), assets: assets(s) });
      expect(v.errors).toEqual([]);
    }
    const badSeries = normalizeSeries(synth.files.get("timeline_series.json.gz")());
    badSeries.raw.ncr.day.frames[0] = { ...badSeries.raw.ncr.day.frames[0], coverage: 1.2 };
    expect(validateV2({ manifest: synth.manifest, timeline: tl, series: badSeries }).errors.join(" ")).toMatch(/coverage must lie in \[0, 1\]/);
    const badManifest = structuredClone(synth.manifest);
    badManifest.zones.night[1].display_name = "";
    expect(validateV2({ manifest: badManifest, timeline: tl }).errors.join(" ")).toMatch(/display_name must be a non-empty string/);
    const badMetrics = assets(synth);
    badMetrics.metrics.land_model.verdict = "great";
    badMetrics.metrics.modes.day.aoa.resid_rho_block20 = 1.4;
    const errs = validateV2({ manifest: synth.manifest, timeline: tl, assets: badMetrics }).errors.join(" ");
    expect(errs).toMatch(/land_model.verdict/);
    expect(errs).toMatch(/resid_rho_block20/);
    const badDec = normalizeSeries(synth.files.get("timeline_series.json.gz")());
    badDec.raw.ncr.day.decomposition.ssp245["2050"].baseline_c = null;
    expect(validateV2({ manifest: synth.manifest, timeline: tl, series: badDec }).errors.join(" ")).toMatch(/baseline_c must be a finite number/);
  });
});

describe("Δ legend on non-harmonised levels (T-F4-08 / T-F4-02)", () => {
  it("states the not-harmonised reason instead of a missing-domain note", () => {
    const v1Like = { schema: "v1", harmonised: false, domains: {} };
    expect(legendSpec({ layer: "lst", variable: "delta", mode: "day", timeline: v1Like }).note).toBe(LEVELS_NOT_HARMONISED);
    const harmonised = { schema: "v2", harmonised: true, domains: {} };
    expect(legendSpec({ layer: "lst", variable: "delta", mode: "day", timeline: harmonised }).note).not.toBe(LEVELS_NOT_HARMONISED);
  });
});
