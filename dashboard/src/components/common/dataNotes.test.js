/**
 * Data-provenance helpers (DASH-03, DASH-13).
 */
import { describe, expect, it } from "vitest";
import {
  crossEpochCaveats,
  dataModeBadge,
  dataSourceRows,
  formatGeneratedDate,
  manifestNotes,
  syntheticReasonText,
} from "./dataNotes.js";

const notes = [
  "Land cover comes from different products per epoch (GLC_FCS30D, ESA WorldCover, Dynamic World).",
  "Terra's orbit drifts after 2022.",
  "SHAP values explain the model, not causal effects.",
];

describe("syntheticReasonText", () => {
  it("does not claim Earth Engine was unavailable for an explicit synthetic run", () => {
    const text = syntheticReasonText("LST_RUN_MODE=synthetic");
    expect(text).toMatch(/on purpose/);
    expect(text).not.toMatch(/unavailable/);
  });

  it("quotes the fallback reason and stays neutral without one", () => {
    expect(syntheticReasonText("Earth Engine unavailable (no credentials)")).toMatch(/fell back .*no credentials/);
    expect(syntheticReasonText(undefined)).toBe("This bundle was generated in synthetic mode.");
  });
});

describe("dataModeBadge", () => {
  it("labels a GEE bundle as a dated snapshot, never live", () => {
    const badge = dataModeBadge({ data_mode: "gee", generated_at: "2026-09-27T10:00:00Z" });
    expect(badge.text).toBe("GEE snapshot · 27 Sep 2026");
    expect(badge.text).not.toMatch(/live/i);
    expect(dataModeBadge({ data_mode: "gee" }).text).toBe("GEE snapshot");
    expect(dataModeBadge({ data_mode: "synthetic" }).text).toMatch(/SYNTHETIC/);
    expect(formatGeneratedDate("nonsense")).toBeNull();
  });
});

describe("notes and sources", () => {
  it("lists every manifest note and picks the cross-epoch caveats", () => {
    const manifest = { data_mode: "gee", notes: [...notes, "", 7] };
    expect(manifestNotes(manifest)).toEqual(notes);
    expect(crossEpochCaveats(manifest)).toEqual(notes.slice(0, 2));
  });

  it("flattens data_sources per variable", () => {
    const rows = dataSourceRows({ data_sources: { ntl: { 2015: "VIIRS", 2010: "DMSP" }, elev: { all: "SRTM" } } });
    expect(rows.map((r) => r.variable)).toEqual(["elev", "ntl"]);
    expect(rows[1].entries).toEqual([
      { key: "2010", value: "DMSP" },
      { key: "2015", value: "VIIRS" },
    ]);
  });
});
