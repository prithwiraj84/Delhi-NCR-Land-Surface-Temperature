/**
 * Ribbon geometry and decisions (time/ribbonScale.js), on the synthetic v2 fixture timeline
 * and on the user's REAL v1 bundle (read-only) through the v1 adapter. Also the acceptance
 * grep: no hard-coded tier-by-year mapping in the time / Control code (UI_SPEC §15).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildTimeline, tierOf } from "../data/timeline.js";
import { createSynthV2 } from "../data/fixtures/synthV2.js";
import { normalizeSeries, scopeSeries } from "../data/series.js";
import { adaptV1Bundle } from "../data/v1Adapter.js";
import { prepareEpoch } from "../lib/data.js";
import { PUBLIC_DATA_DIR, publicDataExists, readJson } from "../lib/__tests__/testUtils.js";
import {
  bracketTier,
  compareFromDrag,
  createRibbonScale,
  frameTicks,
  hoverInfo,
  momentumTarget,
  referenceMean,
  ribbonValueText,
  snapEase,
  snapTarget,
  spokenC,
  stripeCells,
  tapeLayout,
  tickLabelled,
  tickLabelStride,
  tierSegments,
} from "./ribbonScale.js";

const synth = createSynthV2();
const timeline = buildTimeline(synth.manifest);

describe("createRibbonScale", () => {
  it("maps first/last to the gutters and inverts exactly, clamping out-of-range input", () => {
    const s = createRibbonScale({ first: 1990, last: 2050, width: 640, left: 20, right: 40 });
    expect(s.x(1990)).toBe(20);
    expect(s.x(2050)).toBe(600);
    expect(s.invert(s.x(2032.4))).toBeCloseTo(2032.4, 9);
    expect(s.x(1900)).toBe(20);
    expect(s.invert(10_000)).toBe(2050);
    expect(s.pxPerYear).toBeCloseTo(580 / 60, 9);
  });

  it("never degenerates (zero width / single year)", () => {
    const s = createRibbonScale({ first: 2025, last: 2025, width: 0 });
    expect(Number.isFinite(s.x(2025))).toBe(true);
    expect(Number.isFinite(s.invert(5))).toBe(true);
  });
});

describe("frameTicks / tierSegments (tiers from the manifest)", () => {
  const scale = createRibbonScale({ first: timeline.first, last: timeline.last, width: 900 });

  it("reads each tick's tier from timeline.frames[].{day,night}.tier", () => {
    for (const mode of ["day", "night", "dtr"]) {
      const ticks = frameTicks(timeline, mode, scale);
      expect(ticks).toHaveLength(timeline.frames.length);
      ticks.forEach((t) => expect(t.tier).toBe(tierOf(timeline, t.year, mode)));
    }
    const night = frameTicks(timeline, "night", scale);
    expect(night[0].tier).toBe(synth.manifest.timeline.frames[0].night.tier);
    expect(night.at(-1).tier).toBe("projected");
    const day = frameTicks(timeline, "day", scale);
    expect(day[0].window).toEqual(synth.manifest.timeline.frames[0].window);
    expect(day[0].wx0).toBeLessThanOrEqual(day[0].x);
  });

  it("merges equal neighbours, splits half-way between frames and covers the whole track", () => {
    const ticks = frameTicks(timeline, "night", scale);
    const segs = tierSegments(ticks, scale);
    expect(segs[0].x0).toBe(scale.x0);
    expect(segs.at(-1).x1).toBe(scale.x1);
    for (let i = 1; i < segs.length; i += 1) {
      expect(segs[i].x0).toBeCloseTo(segs[i - 1].x1, 9);
      expect(segs[i].tier !== segs[i - 1].tier || segs[i].available !== segs[i - 1].available).toBe(true);
    }
    expect(segs.flatMap((s) => s.years)).toEqual(timeline.years);
    const proj = segs.find((s) => s.tier === "projected");
    expect(proj.years).toEqual(timeline.projYears);
  });

  it("thins labels without dropping first, NOW and last", () => {
    const narrow = createRibbonScale({ first: timeline.first, last: timeline.last, width: 260 });
    const ticks = frameTicks(timeline, "day", narrow);
    const stride = tickLabelStride(narrow, ticks.length);
    expect(stride).toBeGreaterThan(1);
    const labelled = ticks.filter((_, i) => tickLabelled(ticks, i, stride, timeline.now)).map((t) => t.year);
    expect(labelled).toContain(timeline.first);
    expect(labelled).toContain(timeline.now);
    expect(labelled).toContain(timeline.last);
    for (let i = 1; i < labelled.length; i += 1) expect(narrow.x(labelled[i]) - narrow.x(labelled[i - 1])).toBeGreaterThan(30);
  });
});

describe("snapping, compare bracket, hover", () => {
  const years = timeline.years;

  it("snaps to the nearest frame within 2.5 years; Shift (snap off) rounds to a whole year", () => {
    expect(snapTarget(2032.4, years)).toBe(2030);
    expect(snapTarget(2032.6, years)).toBe(2035);
    expect(snapTarget(2032.6, years, { snap: false })).toBe(2033);
    expect(snapTarget(2032.6, [2020, 2040])).toBe(2033); // no frame within 2.5 years
    expect(snapTarget(NaN, years)).toBeNull();
  });

  it("snap easing is monotone, starts at 0 and lands exactly on 1 (no overshoot)", () => {
    let prev = -1;
    for (let p = 0; p <= 1.0001; p += 0.02) {
      const v = snapEase(p);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(v).toBeLessThanOrEqual(1 + 1e-12);
      prev = v;
    }
    expect(snapEase(0)).toBe(0);
    expect(snapEase(1)).toBeCloseTo(1, 12);
  });

  it("builds an ordered A<B bracket snapped to frames; collapsed drags give null", () => {
    expect(compareFromDrag(2048, 1991, years)).toEqual({ a: 1990, b: 2050 });
    expect(compareFromDrag(2011, 2012, years)).toBeNull();
  });

  it("hover names a frame near a tick and reports interpolation in between", () => {
    expect(hoverInfo(2040.6, timeline).frame.year).toBe(2040);
    const mid = hoverInfo(2037.4, timeline);
    expect(mid.frame).toBeNull();
    expect(mid.interpolated).toBe(true);
    expect(mid.bracket).toMatchObject({ yA: 2035, yB: 2040 });
  });
});

describe("warming stripes", () => {
  const series = normalizeSeries(synth.files.get(synth.manifest.files.series)());

  it("are frame mean − reference-period mean, projected from the selected SSP, symmetric domain", () => {
    const ncr = scopeSeries(series, "ncr", "day");
    const scale = createRibbonScale({ first: timeline.first, last: timeline.last, width: 900 });
    const { cells, reference, maxAbs } = stripeCells(timeline, ncr, "ssp245", scale);
    expect(cells).toHaveLength(timeline.years.length);
    const ref = referenceMean(ncr.frames, timeline.referencePeriod);
    expect(reference.mean).toBeCloseTo(ref.mean, 9);
    expect(reference.label).toBe(`${timeline.referencePeriod[0]}–${timeline.referencePeriod[1]}`);
    const f2025 = ncr.frames.find((f) => f.year === 2025);
    expect(cells.find((c) => c.year === 2025).value).toBeCloseTo(f2025.mean - ref.mean, 9);
    const c2050 = cells.find((c) => c.year === 2050);
    expect(c2050.projected).toBe(true);
    expect(c2050.value).toBeCloseTo(ncr.ssp.ssp245.at(-1).p50 - ref.mean, 9);
    expect(maxAbs).toBeGreaterThanOrEqual(Math.max(...cells.map((c) => Math.abs(c.value))));
    for (let i = 1; i < cells.length; i += 1) expect(cells[i].x0).toBeCloseTo(cells[i - 1].x1, 9);
  });

  it("falls back to all observed frames when the reference period has no frame", () => {
    const r = referenceMean([{ year: 2010, mean: 40 }, { year: 2015, mean: 42 }], [1950, 1960]);
    expect(r.mean).toBe(41);
    expect(r.label).toBe("mean of 2 frames");
  });
});

describe("aria-valuetext", () => {
  it("speaks the tier, scenario, mode and NCR mean with its interval", () => {
    const bracket = { iA: 10, iB: 10, mix: 0, yA: 2040, yB: 2040 };
    const text = ribbonValueText({ t: 2040, bracket, tier: "projected", mode: "night", sspLabel: "SSP2-4.5", stats: { mean: 31.24, ci: [30.41, 32.08] } });
    expect(text).toBe("2040, projected under SSP2-4.5, night, NCR mean 31.2 °C (30.4 to 32.1)");
  });

  it("says 'interpolated between' and 'about' between frames, and spells minus", () => {
    const bracket = { iA: 9, iB: 10, mix: 0.4, yA: 2035, yB: 2040 };
    const text = ribbonValueText({ t: 2037, bracket, tier: "projected", mode: "day", stats: { mean: 39.04 } });
    expect(text).toBe("2037, interpolated between 2035 and 2040, day, NCR mean about 39.0 °C");
    expect(spokenC(-1.62)).toBe("minus 1.6 °C");
    expect(spokenC(-0.01)).toBe("0.0 °C");
  });

  it("bracketTier is the weaker tier of the bracket (manifest-driven)", () => {
    expect(bracketTier(timeline, { iA: 7, iB: 8, mix: 0.4, yA: 2025, yB: 2030 }, "day")).toBe("projected");
    expect(bracketTier(timeline, { iA: 0, iB: 0, mix: 0, yA: 1990, yB: 1990 }, "night")).toBe(tierOf(timeline, 1990, "night"));
  });
});

describe("mobile tape", () => {
  it("keeps the playhead fixed at the centre and snaps a flick to a frame", () => {
    const { offset, x } = tapeLayout({ t: 35, pxPerYear: 10, width: 300 });
    expect(x(35) + offset).toBe(150);
    expect(momentumTarget(2026, 0, timeline.years)).toBe(2025);
    expect(momentumTarget(2026, 0.02, timeline.years)).toBe(2030); // 0.02 y/ms × 325 ms ≈ 6.5 y
    expect(momentumTarget(2049, 1, timeline.years)).toBe(2050); // clamped to the last frame
  });
});

// ---------------------------------------------------------------------------------------
// Real v1 bundle (read-only): day-only, four observed epochs
// ---------------------------------------------------------------------------------------

const realV1 = publicDataExists("manifest.json") && String(readJson(PUBLIC_DATA_DIR, "manifest.json").schema_version ?? "").startsWith("1");

describe.skipIf(!realV1)("ribbon on the REAL v1 bundle", () => {
  it("spans only the v1 epochs, all observed by day, with night and DTR unavailable", () => {
    const manifest = readJson(PUBLIC_DATA_DIR, "manifest.json");
    const year = manifest.epochs.at(-1);
    const epochs = { [year]: prepareEpoch(readJson(PUBLIC_DATA_DIR, manifest.files.epochs[String(year)]), manifest) };
    const adapted = adaptV1Bundle({ manifest: { ...manifest, epochs: [year] }, epochs });
    const tl = adapted.timeline;
    const scale = createRibbonScale({ first: tl.first, last: tl.last, width: 600 });
    const day = frameTicks(tl, "day", scale);
    expect(day.every((t) => t.tier === "observed" && t.available)).toBe(true);
    const night = frameTicks(tl, "night", scale);
    expect(night.every((t) => !t.available && t.tier === null)).toBe(true);
    expect(night[0].reason).toBeTruthy();
    expect(tierSegments(night, scale).every((s) => !s.available)).toBe(true);
  }, 60000);
});

// ---------------------------------------------------------------------------------------
// Acceptance grep: no tier-by-year mapping in E4 code
// ---------------------------------------------------------------------------------------

describe("no hard-coded tier-by-year mapping (UI_SPEC §15)", () => {
  it("time/ and views/control/ never pair a year literal with a tier string", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const roots = [here, path.resolve(here, "../views/control")];
    const files = [];
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(js|jsx)$/.test(e.name) && !/\.test\.js$/.test(e.name)) files.push(p);
      }
    };
    roots.forEach(walk);
    expect(files.length).toBeGreaterThan(5);
    const pattern = /\b(19|20)\d\d\b["']?\s*[:=]{1,3}\s*["'](observed|observed-sparse|reconstructed|modelled|projected)["']|["'](observed|observed-sparse|reconstructed|modelled|projected)["']\s*[:,]\s*\[?\s*(19|20)\d\d\b/;
    const offenders = files.filter((f) => pattern.test(fs.readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
