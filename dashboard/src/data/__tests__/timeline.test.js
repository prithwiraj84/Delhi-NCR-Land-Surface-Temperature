import { describe, expect, it } from "vitest";
import { createSynthV2 } from "../fixtures/synthV2.js";
import {
  bracketAt,
  bracketLabel,
  buildTimeline,
  cubeFileFor,
  domainFor,
  frameTierInfo,
  modeAvailable,
  modeUnavailableReason,
  nearestFrameIndex,
  normalizeSspId,
  seriesForYear,
  tierBoundaries,
  tierOf,
  weakerTier,
  xaiYears,
} from "../timeline.js";

const synth = createSynthV2();
const tl = buildTimeline(synth.manifest);

describe("buildTimeline", () => {
  it("normalises frames, modes, scenarios and domains from the manifest", () => {
    expect(tl.years).toEqual([1990, 1995, 2000, 2005, 2010, 2015, 2020, 2025, 2030, 2035, 2040, 2045, 2050]);
    expect(tl.obsYears.at(-1)).toBe(2025);
    expect(tl.projYears).toEqual([2030, 2035, 2040, 2045, 2050]);
    expect(tl.now).toBe(2025);
    expect(tl.harmonised).toBe(true);
    expect(tl.modeIds).toEqual(["day", "night"]);
    expect(tl.dtrAvailable).toBe(true);
    expect(tl.scenarioIds).toEqual(["ssp126", "ssp245", "ssp585"]);
    expect(tl.scenarios[1]).toMatchObject({ id: "ssp245", short: "245", label: "SSP2-4.5" });
    expect(domainFor(tl, "day", "abs")[0]).toBeLessThan(domainFor(tl, "day", "abs")[1]);
    expect(cubeFileFor(tl, "night", "ssp585")).toBe("cube_ssp585_night.lstb.gz");
    expect(cubeFileFor(tl, "day", "zones")).toBe("cube_zones_day.lstb.gz");
    expect(xaiYears(tl, "night")).toEqual(tl.obsYears);
    expect(Object.isFrozen(tl)).toBe(true);
  });

  it("rejects empty or unordered frame lists", () => {
    expect(() => buildTimeline({ timeline: { frames: [] } })).toThrow(/missing or empty/);
    expect(() => buildTimeline({ timeline: { frames: [{ year: 2000 }, { year: 1990 }] } })).toThrow(/strictly increasing/);
  });

  it("marks modes without any available frame as unavailable, with a v1 reason for v1 bundles", () => {
    const dayOnly = buildTimeline({ timeline: { frames: [{ year: 2010, day: { tier: "observed" } }, { year: 2015, day: { tier: "observed" } }] } }, { schema: "v1" });
    expect(dayOnly.modeIds).toEqual(["day"]);
    expect(modeAvailable(dayOnly, "night")).toBe(false);
    expect(modeAvailable(dayOnly, "dtr")).toBe(false);
    expect(modeUnavailableReason(dayOnly, "night")).toMatch(/rerun notebook v2/);
    expect(modeUnavailableReason(tl, "night")).toBeNull();
  });
});

describe("brackets", () => {
  const years = tl.years;
  it("is exact on frames and mixes linearly between them", () => {
    expect(bracketAt(years, 2025)).toEqual({ iA: 7, iB: 7, mix: 0, yA: 2025, yB: 2025 });
    const b = bracketAt(years, 2032);
    expect(b).toMatchObject({ iA: 8, iB: 9, yA: 2030, yB: 2035 });
    expect(b.mix).toBeCloseTo(0.4, 10);
    expect(bracketLabel(b)).toBe("2030 ↔ 2035");
    expect(bracketLabel(bracketAt(years, 2030))).toBeNull();
    expect(bracketAt(years, 1900)).toMatchObject({ iA: 0, iB: 0, mix: 0 });
    expect(bracketAt(years, 2100)).toMatchObject({ iA: 12, iB: 12, mix: 0 });
    expect(nearestFrameIndex(years, 2032.4)).toBe(8);
    expect(nearestFrameIndex(years, 2033)).toBe(9);
  });
});

describe("tiers come from the manifest (never from the year)", () => {
  it("reads the per-mode tiers and the weaker tier for DTR and interpolated years", () => {
    expect(tierOf(tl, 1990, "day")).toBe("observed-sparse");
    expect(tierOf(tl, 1990, "night")).toBe("modelled");
    expect(tierOf(tl, 2000, "night")).toBe("reconstructed");
    expect(tierOf(tl, 2010, "night")).toBe("observed");
    expect(tierOf(tl, 2040, "day")).toBe("projected");
    expect(tierOf(tl, 1990, "dtr")).toBe("modelled");
    expect(tierOf(tl, 1991, "day")).toBeNull();
    expect(weakerTier("observed", "projected")).toBe("projected");
    expect(weakerTier("reconstructed", "observed-sparse")).toBe("reconstructed");
    const mutated = buildTimeline({ ...synth.manifest, timeline: { ...synth.manifest.timeline, frames: synth.manifest.timeline.frames.map((f) => (f.year === 2010 ? { ...f, day: { ...f.day, tier: "observed-sparse" } } : f)) } });
    expect(tierOf(mutated, 2010, "day")).toBe("observed-sparse");
  });

  it("frameTierInfo flags interpolation and names the bracket", () => {
    const exact = frameTierInfo(tl, 2025, "day", "ssp245");
    expect(exact).toMatchObject({ exact: true, interpolated: false, tier: "observed", kind: "observed", series: "obs", available: true });
    expect(exact.sensor).toMatch(/Landsat/);
    const between = frameTierInfo(tl, 2027, "night", "245");
    expect(between).toMatchObject({ exact: false, interpolated: true, tier: "projected" });
    expect(between.bracket).toMatchObject({ yA: 2025, yB: 2030 });
    const projected = frameTierInfo(tl, 2045, "day", "ssp585");
    expect(projected).toMatchObject({ kind: "projected", series: "ssp585", ssp: "ssp585" });
  });

  it("tier boundaries include first frame, tier changes, NOW and the last frame", () => {
    expect(tierBoundaries(tl, "day")).toEqual([1990, 2000, 2025, 2030, 2050]);
    expect(tierBoundaries(tl, "night")).toEqual([1990, 2000, 2005, 2025, 2030, 2050]);
  });
});

describe("series and scenario ids", () => {
  it("maps years to the observation cube or the selected SSP", () => {
    expect(seriesForYear(tl, 2010, "ssp585")).toBe("obs");
    expect(seriesForYear(tl, 2040, "585")).toBe("ssp585");
    expect(seriesForYear(tl, 2040, "ssp370")).toBeNull();
    expect(normalizeSspId(245)).toBe("ssp245");
    expect(normalizeSspId("SSP126")).toBe("ssp126");
    expect(normalizeSspId(null)).toBeNull();
  });
});
