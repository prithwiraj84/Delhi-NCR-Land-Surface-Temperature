/**
 * Threshold-card logic (SCI-05 / DASH-07 / SCI-06 / SCI-03): intervals only next to an
 * estimate, bootstrap support, multiple zero crossings and the interval label.
 */
import { describe, expect, it } from "vitest";
import { appliedChangeText, buildThresholdCards, emptyScenarioMessage, LOW_SUPPORT } from "./shapMath.js";

const meta = { name: "elevation", label: "Elevation", display: "number", unit: "m", stats: { p01: 180, p99: 320 } };
const byKey = (cards) => Object.fromEntries(cards.map((c) => [c.key, c]));

describe("buildThresholdCards", () => {
  it("drops an interval exported without its point estimate", () => {
    const cards = byKey(
      buildThresholdCards({
        meta,
        threshold: { saturation: null, saturation_ci: [211.6, 258.4], direction: "cooling" },
        curve: [],
      }),
    );
    expect(cards.saturation.value).toBeNull();
    expect(cards.saturation.ci).toBeNull();
    expect(cards.saturation.missingText).toBe("not detected");
    expect(cards.saturation.interpretation).toMatch(/does not saturate/);
  });

  it("shows the interval with the estimate and uses the given label", () => {
    const threshold = { saturation: 221.5, saturation_ci: [210, 230], direction: "cooling" };
    const ci95 = byKey(buildThresholdCards({ meta, threshold, curve: [] }));
    expect(ci95.saturation.ci).toMatch(/^95% CI /);
    const range = byKey(buildThresholdCards({ meta, threshold, curve: [], ciLabel: "replicate range" }));
    expect(range.saturation.ci).toMatch(/^replicate range /);
    // Estimate without an interval: value shown, no CI line.
    const noCi = byKey(buildThresholdCards({ meta, threshold: { saturation: 0.2549, direction: "warming" }, curve: [] }));
    expect(noCi.saturation.value).not.toBeNull();
    expect(noCi.saturation.ci).toBeNull();
  });

  it("reports bootstrap support and flags low support", () => {
    const strong = byKey(
      buildThresholdCards({ meta, threshold: { breakpoint: 250, breakpoint_support: 0.95, slope_before: -0.02, slope_after: -0.001 }, curve: [] }),
    );
    expect(strong.breakpoint.support).toBe("found in 95% of bootstrap replicates");
    expect(strong.breakpoint.lowSupport).toBe(false);
    const weak = byKey(
      buildThresholdCards({ meta, threshold: { breakpoint: 250, breakpoint_support: LOW_SUPPORT - 0.2, slope_before: -0.02, slope_after: -0.001 }, curve: [] }),
    );
    expect(weak.breakpoint.lowSupport).toBe(true);
    expect(weak.breakpoint.interpretation).toMatch(/tentative/);
    // Support without an estimate is ignored.
    const none = byKey(buildThresholdCards({ meta, threshold: { breakpoint: null, breakpoint_support: 0.3 }, curve: [] }));
    expect(none.breakpoint.support).toBeNull();
  });

  it("reports multiple zero crossings instead of a single value and explains the reference", () => {
    const multi = byKey(
      buildThresholdCards({ meta, threshold: { zero_crossing: null, zero_crossing_flag: "multiple", zero_crossing_ci: [1, 2] }, curve: [] }),
    );
    expect(multi.zero.value).toBeNull();
    expect(multi.zero.ci).toBeNull();
    expect(multi.zero.missingText).toBe("multiple crossings");
    const single = byKey(buildThresholdCards({ meta, threshold: { zero_crossing: 260, direction: "cooling" }, curve: [] }));
    expect(single.zero.interpretation).toMatch(/relative to the average cell/);
    expect(single.zero.detail).toMatch(/average cell/);
  });

  it("labels a missing threshold object as not exported", () => {
    const cards = buildThresholdCards({ meta, threshold: null, curve: [] });
    expect(cards.every((c) => c.missingText === "not exported" && c.support === null)).toBe(true);
  });
});

describe("scenario result messages (DASH-12, DASH-01)", () => {
  it("explains an empty region separately from missing values and inapplicable changes", () => {
    const empty = { regionCount: 0, stats: { count: 0, applicableCount: 0 } };
    expect(emptyScenarioMessage({ result: empty, featureLabel: "Tree cover", regionKind: "district", year: 2025 })).toBe(
      "This district has no cells in the 2025 epoch – choose another region.",
    );
    const noValues = { regionCount: 12, stats: { count: 0, applicableCount: 0 } };
    expect(emptyScenarioMessage({ result: noValues, featureLabel: "Tree cover", regionKind: "zone" })).toMatch(
      /No cells in this region have a value for Tree cover/,
    );
    const inapplicable = { regionCount: 12, stats: { count: 0, applicableCount: 12 } };
    expect(emptyScenarioMessage({ result: inapplicable, featureLabel: "Tree cover" })).toMatch(/cannot be applied to any of the 12 cells/);
    expect(emptyScenarioMessage({ result: { regionCount: 3, stats: { count: 2 } }, featureLabel: "x" })).toBeNull();
  });

  it("spells out requested vs applied change only when they differ", () => {
    const fmtPp = (d) => `${Math.round(d * 100)} pp`;
    expect(appliedChangeText({ requested: -0.2, meanApplied: -0.13 }, fmtPp)).toBe("requested -20 pp · mean applied -13 pp");
    expect(appliedChangeText({ requested: -0.2, meanApplied: -0.2 }, fmtPp)).toBeNull();
    expect(appliedChangeText({ requested: -0.2, meanApplied: NaN }, fmtPp)).toBeNull();
  });
});
