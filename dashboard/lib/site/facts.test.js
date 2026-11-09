/**
 * The content pages print numbers from lib/site/facts.js; these checks make a malformed or
 * re-structured bundle fail loudly instead of silently printing "n/a" or wrong values.
 * Skipped when public/data holds no v2 bundle.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getFacts, signed } from "./facts.js";
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
});
