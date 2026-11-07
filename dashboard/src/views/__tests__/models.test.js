/**
 * Unit tests of the pure analysis models behind the E5 views (Timeline, Drivers, Zones,
 * Model Lab, Sources) and the viz helpers, on the synthetic v2 fixture's exported assets and
 * on hand-built v1-shaped inputs. The integrity rules are asserted explicitly: no bridging of
 * gaps, fans only where exported, trends only when the CI excludes zero, tiers never derived
 * from years, v1 metrics never presented as pooled.
 */
import { describe, expect, it } from "vitest";
import { createSynthV2 } from "../../data/fixtures/synthV2.js";
import { normalizeSeries, scopeSeries } from "../../data/series.js";
import { buildTimeline } from "../../data/timeline.js";
import { normalizeZones, alluvialColumns, alluvialRows, zoneShareTrajectories, isSeriesKeyedZones, zoneEpochs } from "../../components/zones/zoneModel.js";
import { featureGroupsFor, FAMILY_GROUPS, FEATURE_GROUPS } from "../../components/shap/shapMath.js";
import { bandPath, frameSpans, linePath, linearScale, nearestYear, niceDomain, tierStyle, bracketYears } from "../../viz/chartTheme.js";
import { buildFanModel, fanTableRows } from "../../viz/fanModel.js";
import { cellPixels, rasterizeCells } from "../../viz/thumbRaster.js";
import { barcodeDomain, barcodeRows, dumbbellRows, firstLastChange, firstYearAbove, ledgerRows, projectedChange, projectionAoa, rankBump, snapshotYear, thresholdRows, trendCopy, zoneShareSeries } from "../timeline/timelineModel.js";
import { brushMask, dependenceKeyResolver, importanceDiff, importanceTrend, nearestXaiYear, robustRange, scenarioMetas } from "../drivers/driversModel.js";
import { aoaSummary, budgetShares, downscalingSummary, errorDistanceRows, foldMap, honestSkill, isV1Slice, loeoRows, scoreboard, skillGain, v1Comparison, v1PanelMetrics } from "../lab/labModel.js";
import { buildCaveats, caveatGroupOf, caveatSlug, caveatsFor } from "../sources/caveats.js";
import { bundleFiles, citationText, frameRows, swimlanes } from "../sources/sourcesModel.js";

const synth = createSynthV2();
const asset = (name) => synth.files.get(name)();
const manifest = synth.manifest;
const timeline = buildTimeline(manifest);
const series = normalizeSeries(asset("timeline_series.json.gz"));
const metrics = asset("metrics.json");
const shapGlobal = asset("shap_global.json");
const dependence = asset("dependence.json.gz");
const zonesV2 = asset("zones.json");

describe("chart helpers", () => {
  it("never bridge gaps and build closed bands only over finite runs", () => {
    const x = linearScale([0, 10], [0, 100]);
    const y = linearScale([0, 1], [100, 0]);
    expect(linePath([{ x: 0, y: 0 }, { x: 1, y: NaN }, { x: 2, y: 1 }, { x: 3, y: 1 }], x, y)).toBe("M0.0,100.0M20.0,0.0L30.0,0.0");
    expect(bandPath([{ x: 0, lo: 0, hi: 1 }, { x: 1, lo: NaN, hi: 1 }, { x: 2, lo: 0, hi: 1 }], x, y)).toBe("");
    expect(bandPath([{ x: 0, lo: 0, hi: 1 }, { x: 1, lo: 0, hi: 1 }], x, y)).toMatch(/^M.*Z$/);
  });

  it("encode every tier by dash + marker, and flag unknown tiers visibly", () => {
    expect(tierStyle("observed")).toMatchObject({ dash: null, marker: "filled", hatchCi: false });
    expect(tierStyle("observed-sparse").marker).toBe("hollow");
    expect(tierStyle("reconstructed")).toMatchObject({ dash: "2 4", hatchCi: true });
    expect(tierStyle("modelled")).toMatchObject({ marker: "diamond", hatchCi: true });
    expect(tierStyle("weird").label).toBe("weird");
  });

  it("paint frames as steps halfway to their neighbours (not interpolations)", () => {
    const spans = frameSpans([1990, 1995, 2000], [1990, 2000]);
    // Edge frames are clamped to the axis domain (± half a year), inner edges sit halfway.
    expect(spans.map((s) => [s.x0, s.x1])).toEqual([[1989.5, 1992.5], [1992.5, 1997.5], [1997.5, 2000.5]]);
    expect(frameSpans([2025], [1990, 2050])[0]).toMatchObject({ x0: 2022.5, x1: 2027.5 });
  });

  it("find the nearest data year within a radius and the bracket otherwise", () => {
    expect(nearestYear([1990, 1995], 1991)).toBe(1990);
    expect(nearestYear([1990, 1995], 1992.5)).toBeNull();
    expect(bracketYears([1990, 1995], 1992.5)).toEqual([1990, 1995]);
    expect(niceDomain([NaN])).toEqual([0, 1]);
    const [lo, hi] = niceDomain([40.2, 44.8]);
    expect(lo).toBeLessThanOrEqual(40.2);
    expect(hi).toBeGreaterThanOrEqual(44.8);
  });

  it("rasterise cells at their grid position with the exact LUT colour (NaN stays transparent)", () => {
    const cells = { n: 3, row: Int16Array.from([0, 0, 1]), col: Int16Array.from([0, 1, 1]), grid: { width: 2, height: 2 } };
    const g = cellPixels(cells);
    expect(Array.from(g.pixel)).toEqual([0, 1, 3]);
    const lut = new Uint8Array(768);
    for (let i = 0; i < 256; i += 1) lut.set([i, 255 - i, 7], i * 3);
    const rgba = rasterizeCells({ ...g, values: Float32Array.from([0, 10, NaN]), lut, lo: 0, hi: 10 });
    expect(Array.from(rgba.slice(0, 4))).toEqual([0, 255, 7, 255]);
    expect(Array.from(rgba.slice(4, 8))).toEqual([255, 0, 7, 255]);
    expect(rgba[3 * 4 + 3]).toBe(0);
    const v1 = cellPixels({ n: 2, lon: [77, 78], lat: [28, 29], grid: { width: null } }, 50);
    expect(v1.width).toBeGreaterThan(0);
  });
});

describe("fan model", () => {
  const ncrDay = scopeSeries(series, "ncr", "day");
  it("opens every SSP fan at NOW from the weather-normalised baseline (D14), never at the observed NOW point", () => {
    const m = buildFanModel({ series: ncrDay, ssps: timeline.scenarioIds, now: timeline.now });
    expect(m.status).toBe("ready");
    const base = series.baselineLevel.day;
    expect(Math.abs(base - ncrDay.frames.at(-1).mean)).toBeGreaterThan(0.1); // the fixture's weather anomaly
    for (const id of timeline.scenarioIds) {
      expect(m.fans[id][0]).toMatchObject({ x: 2025, anchor: true, baseline: true });
      expect(m.fans[id][0].p50).toBeCloseTo(ncrDay.decomposition[id]["2030"].baseline_c, 6);
      expect(m.fans[id][0].p50).toBeCloseTo(base, 6);
      expect(m.baselines[id]).toMatchObject({ x: 2025, source: "baseline_c" });
    }
    // Without baseline_c / baseline_level_c (older bundle): p50 − total gives the same baseline.
    const old = { ...ncrDay, baselineLevel: null, decomposition: Object.fromEntries(Object.entries(ncrDay.decomposition).map(([id, rows]) => [id, Object.fromEntries(Object.entries(rows).map(([y, r]) => [y, { climate: r.climate, land: r.land, total: r.total }]))])) };
    const mOld = buildFanModel({ series: old, ssps: ["ssp245"], now: 2025 });
    expect(mOld.fans.ssp245[0].p50).toBeCloseTo(ncrDay.ssp.ssp245[0].p50 - ncrDay.decomposition.ssp245["2030"].total, 6);
    // No baseline at all: the fan starts at the first projected frame (no zero-width observed anchor).
    const none = { ...old, decomposition: {} };
    expect(buildFanModel({ series: none, ssps: ["ssp245"], now: 2025 }).fans.ssp245[0].x).toBe(2030);
    expect(m.obs.find((p) => p.x === 1990).tier).toBe("observed-sparse");
    const rows = fanTableRows(m, ["ssp245"]);
    expect(rows.find((r) => r.year === 2050).ssp245_p50).toBeCloseTo(ncrDay.ssp.ssp245.at(-1).p50, 6);
    expect(rows.some((r) => r.year === 2025 && "ssp245_p50" in r)).toBe(false);
  });

  it("refuses to invent fans for metrics that were not projected", () => {
    const m = buildFanModel({ series: ncrDay, metric: "p90", ssps: ["ssp245"], now: 2025 });
    expect(Object.keys(m.fans)).toEqual([]);
    expect(m.fanReason).toMatch(/mean only/);
  });

  it("reports gaps instead of bridging them", () => {
    const s = { frames: [{ year: 1990, mean: 40, tier: "observed" }, { year: 1995, mean: NaN, tier: "observed" }, { year: 2000, mean: 41, tier: "observed" }], ssp: {} };
    expect(buildFanModel({ series: s }).gaps).toEqual([1995]);
    expect(buildFanModel({ series: { frames: [], ssp: {} } }).status).toBe("empty");
  });
});

describe("timeline model", () => {
  const ncr = scopeSeries(series, "ncr", "day");
  it("computes frame changes with CIs in quadrature, never as a trend", () => {
    const c = firstLastChange(ncr, 2025);
    expect(c.from).toBe(1990);
    expect(c.to).toBe(2025);
    expect(c.delta).toBeCloseTo(ncr.frames.at(-1).mean - ncr.frames[0].mean, 6);
    expect(c.ci).toBeGreaterThan(0);
    expect(firstLastChange({ frames: [{ year: 2010, mean: 1, ci: null }] })).toBeNull();
  });

  it("states a trend only when the exported CI excludes zero", () => {
    expect(trendCopy({ trend: { obs: { slope_per_decade: 0.3, ci: [-0.1, 0.6], period: [1990, 2025] } } }, "Day").text).toBe("No clear trend: year-to-year weather dominates.");
    const ok = trendCopy({ trend: { obs: { slope_per_decade: 0.3, ci: [0.1, 0.5], period: [1990, 2025] } } }, "Day");
    expect(ok.guardPassed).toBe(true);
    expect(ok.text).toMatch(/\+0\.30 °C per decade/);
    expect(trendCopy({ trend: null }, "Day").guardPassed).toBe(false);
  });

  it("derives projected change, threshold rows and first year above a level", () => {
    const p = projectedChange(ncr, "ssp585", 2050, 2025);
    expect(p.lo).toBeLessThanOrEqual(p.delta);
    expect(p.hi).toBeGreaterThanOrEqual(p.delta);
    expect(firstYearAbove(ncr, 1000, "ssp245")).toBeNull();
    expect(firstYearAbove(ncr, 0, null)).toMatchObject({ year: 1990, kind: "observed" });
    const rows = thresholdRows(series, "day", ["ssp245"]);
    expect(rows[0].id).toBe("ncr");
    expect(rows.length).toBe(1 + series.scopes.filter((s) => s.kind === "district").length);
  });

  it("builds ledger, dumbbell, rank bump, barcode and zone-share data for 25 districts", () => {
    const ledger = ledgerRows(series, { now: 2025, ssp: "ssp245", lastYear: 2050 });
    expect(ledger).toHaveLength(25);
    expect(ledger.filter((r) => r.rank !== null).map((r) => r.rank).sort((a, b) => a - b)[0]).toBe(1);
    const db = dumbbellRows(series, 2025);
    for (let i = 1; i < db.length; i += 1) expect(db[i - 1].dtr).toBeGreaterThanOrEqual(db[i].dtr);
    const rb = rankBump(series, { mode: "day", years: timeline.years, ssp: "ssp245" });
    expect(rb.lines).toHaveLength(25);
    expect(new Set(rb.lines.map((l) => l.ranks[0]))).toEqual(new Set(Array.from({ length: 25 }, (_, k) => k + 1)));
    const bc = barcodeRows(series, { mode: "day", ssp: "ssp245", years: timeline.years, referencePeriod: [2000, 2020], now: 2025, sort: "end" });
    expect(bc[0].end).toBeGreaterThanOrEqual(bc[1].end);
    expect(bc[0].cells.find((c) => c.year === 2050).projected).toBe(true);
    const [a, b] = barcodeDomain(bc);
    expect(a).toBe(-b);
    const zs = zoneShareSeries(series, "day", "ssp245");
    expect(zs.find((r) => r.year === 2050).projected).toBe(true);
    expect(snapshotYear(timeline, 2040)).toBe(2025);
  });

  it("reads the projection AOA share of the selected SSP from metrics.projection_meta (the real metrics shape)", () => {
    // The synthetic bundle's metrics.json carries projection_meta[mode][ssp].pct_outside_aoa.
    const outside = metrics.projection_meta.day.ssp585.pct_outside_aoa["2050"];
    expect(projectionAoa(metrics, "day", 2050, "ssp585")).toEqual({ year: 2050, ssp: "ssp585", pct: 1 - outside, source: "projection" });
    const night = projectionAoa(metrics, "night", 2050, "ssp585");
    expect(night.pct).toBeCloseTo(1 - metrics.projection_meta.night.ssp585.pct_outside_aoa["2050"], 9);
    // Another SSP gives its own share (never another scenario's value).
    expect(projectionAoa(metrics, "day", 2050, "ssp126").pct).toBeCloseTo(1 - metrics.projection_meta.day.ssp126.pct_outside_aoa["2050"], 9);
  });

  it("falls back to the cube flags, then to the observed share labelled as observed", () => {
    const flagsCube = { years: [2050], n: 4, F: 1, valueColumn: "p50", columns: { p50: { name: "p50", raw: Int16Array.from([100, 200, -32768, 300]), scale: 0.01, offset: 0, nodata: -32768, shape: [1, 4] }, flags: { name: "flags", raw: Uint8Array.from([1, 0, 1, 0]), shape: [1, 4] } } };
    // 3 finite cells, 1 outside (the nodata cell's flag is ignored).
    const fromCube = projectionAoa({ modes: { day: {} } }, "day", 2050, "ssp245", { cube: flagsCube });
    expect(fromCube).toMatchObject({ year: 2050, ssp: "ssp245", source: "cube" });
    expect(fromCube.pct).toBeCloseTo(2 / 3, 12);
    const old = { modes: { day: { aoa: { pct_inside: { 2025: 0.99, 2045: 0.95, 2050: 0.94 } } }, night: { aoa: { pct_inside: { 2025: 0.98, 2045: 0.9 } } } } };
    expect(projectionAoa(old, "day", 2050, "ssp245")).toEqual({ year: 2050, ssp: null, pct: 0.94, source: "observed" });
    expect(projectionAoa(old, "night", 2050)).toEqual({ year: 2045, ssp: null, pct: 0.9, source: "observed" });
    expect(projectionAoa({ modes: { day: {} } }, "day", 2050)).toBeNull();
    expect(projectionAoa(null, "day", 2050)).toBeNull();
  });
});

describe("drivers model", () => {
  it("finds day/night sign flips from the dependence directions", () => {
    const rows = importanceDiff(shapGlobal, dependence);
    expect(rows.length).toBe(18);
    for (let i = 1; i < rows.length; i += 1) expect(Math.abs(rows[i - 1].diff)).toBeGreaterThanOrEqual(Math.abs(rows[i].diff));
    for (const r of rows) expect(r.flip).toBe(Boolean(r.dirDay && r.dirNight && r.dirDay !== r.dirNight));
    expect(importanceDiff({ modes: { day: shapGlobal.modes.day } }, dependence)).toEqual([]);
  });

  it("builds the importance trend, brush masks and nearest XAI frames", () => {
    const t = importanceTrend(shapGlobal.modes.day, 5);
    expect(t.lines).toHaveLength(5);
    expect(t.years).toEqual([1990, 1995, 2000, 2005, 2010, 2015, 2020, 2025]);
    const { mask, count } = brushMask(Float32Array.from([0, 0.5, NaN, 1, 2]), [0.5, 1]);
    expect(Array.from(mask)).toEqual([0, 1, 0, 1, 0]);
    expect(count).toBe(2);
    expect(robustRange(Float32Array.from([NaN]))).toBeNull();
    expect(nearestXaiYear([2010, 2015, 2020, 2025], 2040)).toBe(2025);
    expect(nearestXaiYear([2010, 2020], 2015)).toBe(2020);
  });

  it("offers base actionable features (never focal means) to the v2 what-if", () => {
    const metas = scenarioMetas({ schema: "v2", manifest });
    expect(metas.has("frac_built")).toBe(true);
    expect([...metas.keys()].some((k) => /_m\d+$/.test(k))).toBe(false);
    const key = dependenceKeyResolver({ schema: "v2", manifest });
    expect(key("frac_built")).toBe("built");
    expect(key("frac_forest")).toBe("forest");
    expect(dependenceKeyResolver({ schema: "v1" })("ndvi")).toBe("ndvi");
    expect(featureGroupsFor([{ group: "urban" }])).toBe(FAMILY_GROUPS);
    expect(featureGroupsFor([{ group: "socioeconomic" }])).toBe(FEATURE_GROUPS);
  });
});

describe("zones model (v2 normalisation)", () => {
  const day = zonesV2.modes.day;
  it("presents series-keyed zones in the v1 component shape", () => {
    expect(isSeriesKeyedZones(day)).toBe(true);
    const z = normalizeZones(day);
    expect(isSeriesKeyedZones(z)).toBe(false);
    expect(zoneEpochs(z, null)).toEqual([1990, 1995, 2000, 2005, 2010, 2015, 2020, 2025]);
    expect(Object.keys(z.transitions)[0]).toBe("1990->1995");
    expect(z.zones[0].recommendations[0]).toMatchObject({ action: "increase" });
    expect(["high", "medium", "low"]).toContain(z.zones[0].recommendations[0].priority);
    expect(normalizeZones({ zones: [{ id: 0, area_km2: { 2010: 1 } }] }).zones[0].area_km2).toEqual({ 2010: 1 });
  });

  it("chains observed and projected transitions into alluvial columns that conserve cells", () => {
    const z = normalizeZones(day);
    const a = alluvialColumns(z.transitionsBySeries, { ssp: "ssp245" });
    expect(a.columns.map((c) => c.year)).toEqual([1990, 1995, 2000, 2005, 2010, 2015, 2020, 2025, 2030, 2035, 2040, 2045, 2050]);
    expect(a.columns.at(-1).projected).toBe(true);
    for (const f of a.flows) {
      const out = f.matrix.flat().reduce((x, y) => x + y, 0);
      expect(out).toBeGreaterThan(0);
    }
    expect(alluvialRows(a, (i) => `z${i}`).every((r) => r.cells > 0)).toBe(true);
    const traj = zoneShareTrajectories(z, 3);
    expect(Object.keys(traj)).toEqual(expect.arrayContaining(["obs", "ssp245"]));
  });
});

describe("lab model", () => {
  it("reads the v2 headline as pooled block20 + LOEO, random as optimistic", () => {
    const s = honestSkill(metrics, "day");
    expect(s.v1).toBe(false);
    expect(s.spatial).toMatchObject({ scheme: "block20", pooled: true, r2: 0.86 });
    expect(s.temporal.scheme).toBe("loeo");
    expect(s.random.r2).toBeLessThan(1);
    expect(v1Comparison(s.comparison).xgb).toEqual([0.623, 0.305]);
  });

  it("labels v1 metrics as mean-of-folds and never as pooled", () => {
    const v1 = { modes: { day: { schemes: ["random", "spatial", "temporal"], summary: [{ scheme: "spatial", model: "xgboost", r2_mean: 0.62, r2_std: 0.31, rmse_mean: 2.1 }, { scheme: "random", model: "xgboost", r2_mean: 0.95 }] } } };
    expect(isV1Slice(v1.modes.day)).toBe(true);
    const s = honestSkill(v1, "day");
    expect(s.v1).toBe(true);
    expect(s.spatial).toMatchObject({ pooled: false, r2: 0.62, r2FoldSd: 0.31 });
    expect(honestSkill(v1, "night")).toBeNull();
    expect(v1PanelMetrics(v1.modes.day, v1)).toBe(v1.modes.day);
  });

  it("derives scoreboard, distance bins, fold map, LOEO, AOA, downscaling and budget", () => {
    const slice = metrics.modes.day;
    const sb = scoreboard(slice);
    expect(sb.schemes[0]).toBe("block20");
    expect(sb.cells["block20|xgboost"].folds.length).toBe(5);
    expect(errorDistanceRows(slice).at(-1).label).toBe("≥ 40 km");
    const fm = foldMap(slice);
    expect(fm.rows * fm.cols).toBe(16);
    expect(fm.worst.rmse).toBe(Math.max(...fm.cells.map((c) => c.rmse)));
    expect(loeoRows(slice)[0]).toMatchObject({ year: 1990 });
    expect(aoaSummary(slice).pct.at(-1).year).toBe(2050);
    const d = downscalingSummary(metrics);
    expect(skillGain(d.night.rmse, d.night.bilinear)).toBeGreaterThan(0);
    // A downscaler that loses to bilinear has a negative gain (the panel then says "higher error"),
    // and the panel labels follow the bundle's resolutions (e.g. 8 km → 2 km on the smoke grid).
    expect(skillGain(0.41, 0.38)).toBeLessThan(0);
    const smoke = downscalingSummary({ downscaling: { fine_res_m: 500, night: { scale_invariance: { r2: 0.8, rmse: 0.41, bilinear_rmse: 0.38, coarse_res_m: 8000, fine_res_m: 2000 } } } });
    expect(smoke).toMatchObject({ fineResM: 500, night: { coarseM: 8000, fineM: 2000 } });
    expect(budgetShares({ gcm: 1, sensitivity: 1, land: 1, model: 1 })).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect(budgetShares(null)).toBeNull();
    const panel = v1PanelMetrics(slice, metrics);
    expect(panel.moran.every((r) => r.scheme === "block20")).toBe(true);
    expect(panel.summary[0].r2_mean).toBeDefined();
  });
});

describe("sources model and caveats", () => {
  it("groups exported caveats with stable anchors and adds bundle-derived notes", () => {
    const list = buildCaveats(manifest, { schema: "v2" });
    expect(list.some((c) => c.group === "synthetic")).toBe(true);
    expect(list.some((c) => c.group === "projection")).toBe(true);
    expect(new Set(list.map((c) => c.id)).size).toBe(list.length);
    expect(caveatSlug("Terra orbit drifts")).toBe(caveatSlug("Terra orbit drifts"));
    expect(caveatGroupOf("Terra's orbit drifts after 2022")).toBe("sensor");
    const v1 = buildCaveats({ notes: ["SHAP values explain the model, not causal effects."] }, { schema: "v1" });
    expect(caveatsFor(v1, "model").length).toBeGreaterThanOrEqual(1);
    expect(v1.some((c) => /mean of per-fold/.test(c.text))).toBe(true);
  });

  it("lists swimlanes, frame provenance (tiers from the manifest) and files", () => {
    const lanes = swimlanes(asset("provenance.json"), manifest);
    expect(lanes.length).toBe(4);
    expect(lanes.some((l) => l.group === "projections")).toBe(true);
    const narrow = swimlanes(null, { data_sources: {} });
    expect(narrow).toEqual([]);
    const derived = swimlanes(null, { data_sources: { lst_day_c: { 2010: "MODIS/061/MOD11A2 …", 2015: "x" } } });
    expect(derived[0]).toMatchObject({ derived: true, start: 2010, end: 2015 });
    const rows = frameRows(timeline);
    expect(rows).toHaveLength(timeline.frames.length * 2);
    expect(rows.find((r) => r.year === 1990 && r.mode === "night").tier).toBe("modelled");
    const files = bundleFiles(manifest);
    expect(files.map((f) => f.file)).toEqual(expect.arrayContaining(["manifest.json", "cells.lstb.gz", "cube_obs_day.lstb.gz", "raster_index.json"]));
    expect(citationText(manifest)).toMatch(/SYNTHETIC/);
  });
});
