/**
 * The content pages print numbers from lib/site/facts.js; these checks make a malformed or
 * re-structured bundle fail loudly instead of silently printing "n/a" or wrong values.
 * Skipped when public/data holds no v2 bundle.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { annualContrast, getFacts, rangeText, signed, spell } from "./facts.js";
import { pageMetadata } from "./meta.js";
import { absoluteUrl } from "./config.js";

const manifestPath = path.join(process.cwd(), "public", "data", "manifest.json");
const isV2 = (() => {
  try {
    return String(JSON.parse(fs.readFileSync(manifestPath, "utf8")).schema_version).startsWith("2");
  } catch {
    return false;
  }
})();

describe("signed()", () => {
  it("formats signs with a true minus and a ± for zero", () => {
    expect(signed(1.94)).toBe("+1.9 °C");
    expect(signed(-0.45, 2)).toBe("−0.45 °C");
    expect(signed(0, 1, "")).toBe("±0.0");
    expect(signed(null)).toBe("n/a");
  });
  it("takes the sign of the rounded value (no '−0.0')", () => {
    expect(signed(-0.02, 1, "")).toBe("±0.0");
    expect(signed(0.04, 1, "")).toBe("±0.0");
  });
  it("formats intervals, signed or plain, and small counts in words", () => {
    expect(rangeText([0.73, 1.4])).toBe("+0.73 to +1.40 °C");
    expect(rangeText([0.0067, 1.537], 2, "", true)).toBe("0.01 to 1.54");
    expect(rangeText([1, null])).toBeNull();
    expect(spell(3, true)).toBe("Three");
    expect(spell(35)).toBe("35");
    expect(spell(undefined)).toBe("");
  });
});

describe("pageMetadata()", () => {
  it("always carries canonical, Open Graph image and Twitter card", () => {
    const m = pageMetadata({ title: "X", description: "Y", path: "/x", type: "article" });
    expect(m.alternates.canonical).toBe("/x");
    expect(m.openGraph.images[0]).toMatchObject({ url: "/opengraph-image", width: 1200, height: 630 });
    expect(m.openGraph.type).toBe("article");
    expect(m.twitter.card).toBe("summary_large_image");
    expect(absoluteUrl("/x")).toMatch(/\/x$/);
  });
});

describe.skipIf(!isV2)("build-time facts from public/data", () => {
  const f = getFacts();

  it("reads the study area, frames and scenarios", () => {
    expect(f.area.km2).toBeGreaterThan(10000);
    expect(f.area.cells).toBeGreaterThan(10000);
    expect(f.years.observed.length).toBeGreaterThanOrEqual(2);
    expect(f.years.all[0]).toBeLessThan(f.years.all.at(-1));
  });

  it("observed change uses evidence frames only (no modelled night hindcasts)", () => {
    for (const mode of ["day", "night"]) {
      const s = f[mode];
      expect(Number.isFinite(s.change)).toBe(true);
      const first = s.frames.find((r) => r.year === s.first.year);
      expect(first.tier).not.toBe("modelled");
    }
  });

  it("projections are relative to the weather-normalised baseline and ordered p05 <= p50 <= p95", () => {
    for (const id of f.scenarios) {
      const p = f.day.projections[id];
      expect(Number.isFinite(p.delta)).toBe(true);
      expect(p.lo).toBeLessThanOrEqual(p.delta);
      expect(p.hi).toBeGreaterThanOrEqual(p.delta);
    }
  });

  it("accuracy, drivers and districts are present and sane", () => {
    expect(f.accuracy.day.spatial.r2).toBeGreaterThan(0);
    expect(f.accuracy.day.spatial.r2).toBeLessThanOrEqual(1);
    expect(f.drivers.day.length).toBeGreaterThan(3);
    expect(f.drivers.day[0].value).toBeGreaterThanOrEqual(f.drivers.day[1].value);
    expect(f.districts.length).toBeGreaterThan(3);
    expect(f.districts[0].day2025).toBeGreaterThanOrEqual(f.districts.at(-1).day2025);
  });

  it("lists the raster/ PNGs with the bundle files (the /data page counts them)", () => {
    const png = f.files.filter((x) => x.name.endsWith(".png"));
    expect(png.length).toBeGreaterThan(0);
    expect(png.every((x) => x.name.startsWith("raster/") && x.bytes > 0)).toBe(true);
  });

  it("exports the frame trend with its CI and the annual series it is compared with", () => {
    const t = f.day.trend;
    expect(Number.isFinite(t.perDecade)).toBe(true);
    expect(t.ci[0]).toBeLessThanOrEqual(t.perDecade);
    expect(t.ci[1]).toBeGreaterThanOrEqual(t.perDecade);
    expect(t.n).toBeGreaterThanOrEqual(2);
    const text = annualContrast(f.day, "day", f.seasonLabel);
    if (f.day.annual.air || f.day.annual.satellite) {
      expect(text).toMatch(/per decade/);
      expect(text).not.toMatch(/undefined|NaN|null/);
    }
  });
});
