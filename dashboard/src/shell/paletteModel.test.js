/**
 * Command palette model (UI_SPEC §2.4) and boot-sequence model (§3.1).
 */
import { describe, expect, it } from "vitest";
import { buildPaletteItems, matchScore, parseCellQuery, parseFrameQuery, searchPalette } from "./paletteModel.js";
import { bootFooter, fallbackLines, lineStatusText, normalizeProgress, overallFraction, shouldPlayCinematic } from "./bootModel.js";
import { deriveBundleMeta, isV2Manifest } from "./bundleMeta.js";
import { normalizeRoute, stageBehaviour } from "./routes.js";

const districts = [
  { id: 0, name: "Delhi NCT", state: "Delhi" },
  { id: 1, name: "Gurugram", state: "Haryana" },
  { id: 12, name: "Ghaziabad", state: "Uttar Pradesh" },
];
const years = [1990, 1995, 2000, 2005, 2010, 2015, 2020, 2025, 2030, 2035, 2040, 2045, 2050];

describe("palette query parsing", () => {
  it("parses year / mode / ssp in any order and spelling", () => {
    expect(parseFrameQuery("2045 night ssp585")).toEqual({ year: 2045, mode: "night", ssp: "ssp585" });
    expect(parseFrameQuery("night 2030 SSP2-4.5")).toEqual({ year: 2030, mode: "night", ssp: "ssp245" });
    expect(parseFrameQuery("1990")).toEqual({ year: 1990, mode: null, ssp: null });
    expect(parseFrameQuery("2100")).toBeNull();
    expect(parseFrameQuery("gurugram")).toBeNull();
  });
  it("parses cell ids", () => {
    expect(parseCellQuery("#48211")).toBe(48211);
    expect(parseCellQuery("cell 12")).toBe(12);
    expect(parseCellQuery("12")).toBeNull();
  });
  it("ranks exact > prefix > word prefix > substring > subsequence", () => {
    const s = (t) => matchScore("gur", t);
    expect(matchScore("gurugram", "Gurugram")).toBeGreaterThan(s("Gurugram"));
    expect(s("Gurugram")).toBeGreaterThan(s("New Gurgaon"));
    expect(matchScore("ugr", "Gurugram")).toBeGreaterThan(0);
    expect(matchScore("xyz", "Gurugram")).toBe(0);
  });
});

describe("palette search", () => {
  const items = buildPaletteItems({ districts, features: [{ name: "ndvi", label: "NDVI" }], scenarios: [{ id: "ssp245", label: "SSP2-4.5" }], years });

  it("empty query shows views and commands only", () => {
    const groups = new Set(searchPalette(items, "").map((i) => i.group));
    expect([...groups]).toEqual(["Views", "Commands"]);
  });
  it("a frame query yields a Years item first with a goToFrame action", () => {
    const res = searchPalette(items, "2045 night ssp585", { years });
    expect(res[0].group).toBe("Years");
    expect(res[0].action).toEqual({ type: "goToFrame", year: 2045, mode: "night", ssp: "ssp585" });
    expect(searchPalette(items, "2032", { years })[0].hint).toMatch(/interpolated/);
  });
  it("finds districts, cells, layers and commands", () => {
    expect(searchPalette(items, "gurug")[0]).toMatchObject({ group: "Districts", action: { type: "selectDistrict", districtId: 1 } });
    expect(searchPalette(items, "#77")[0]).toMatchObject({ group: "Cells", action: { type: "selectCell", cellIndex: 77 } });
    expect(searchPalette(items, "ndvi").some((i) => i.action.type === "setLayer" && i.action.shapFeature === "ndvi")).toBe(true);
    expect(searchPalette(items, "compare")[0].label).toBe("Compare 1990 vs 2050");
    expect(searchPalette(items, "zzzz")).toEqual([]);
  });
  it("results are grouped in the documented order", () => {
    const order = ["Years", "Districts", "Cells", "Layers", "Views", "Commands"];
    const res = searchPalette(items, "a");
    const idx = res.map((r) => order.indexOf(r.group));
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });
});

describe("boot model", () => {
  it("normalises the bundle store's progress events", () => {
    const lines = normalizeProgress([
      { id: "manifest", label: "manifest.json", file: "manifest.json", status: "ok", bytes: 22000, total: 22000, ms: 41 },
      { id: "cube:day:obs", label: "cube_obs_day.lstb.gz", file: "cube_obs_day.lstb.gz", status: "loading", bytes: 430000, total: 610000, ms: 300 },
      { id: "xai", label: "xai_2025_day", status: "queued", deferred: true },
      { id: "series", label: "timeline series", file: "timeline_series.json.gz", status: "missing" },
    ]);
    expect(lines.map((l) => l.status)).toEqual(["ok", "loading", "queued", "missing"]);
    expect(lineStatusText(lines[0])).toBe("ok  22 KB  41 ms");
    expect(lineStatusText(lines[1])).toBe("70 %  430 KB / 610 KB");
    expect(lineStatusText(lines[2])).toBe("deferred to idle");
    expect(lineStatusText(lines[3])).toBe("not in bundle");
    expect(overallFraction(lines)).toBeCloseTo((1 + 430 / 610) / 3, 5);
  });
  it("accepts object-map progress and falls back to status-only lines", () => {
    expect(normalizeProgress({ "manifest.json": { status: "done" } })[0]).toMatchObject({ file: "manifest.json", status: "ok" });
    expect(fallbackLines("loading")[0].status).toBe("loading");
    expect(fallbackLines("empty")[0].status).toBe("missing");
    expect(normalizeProgress(null)).toEqual([]);
  });
  it("plays the cinematic once per session and only in Full motion", () => {
    const store = new Map();
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
    expect(shouldPlayCinematic("reduced", storage)).toBe(false);
    expect(shouldPlayCinematic("full", storage)).toBe(true);
    storage.setItem("ncr-ops.boot-played", "1");
    expect(shouldPlayCinematic("full", storage)).toBe(false);
    const throwing = { getItem: () => { throw new Error("SecurityError"); } };
    expect(shouldPlayCinematic("full", throwing)).toBe(true);
  });
  it("formats the footer", () => {
    expect(bootFooter({ nCells: 55150, gridRes: 1000, fineRes: 250, years: [1990, 2050], dataMode: "gee" })).toBe("55,150 cells · 1 km · 250 m · 1990 ─ 2050 · REAL · GEE");
    expect(bootFooter({ dataMode: "synthetic" })).toBe("SYNTHETIC · DEMO");
  });
});

describe("bundle metadata", () => {
  it("v1 manifests: day only, no scenarios, reasons name the v2 rerun", () => {
    const meta = deriveBundleMeta({ schema_version: "1.0", epochs: [2010, 2015, 2020, 2025], data_mode: "gee", study_area: { area_km2: 55150, grid_res_m: 1000 } });
    expect(isV2Manifest({ schema_version: "1.0" })).toBe(false);
    expect(meta.years).toEqual([2010, 2015, 2020, 2025]);
    expect(meta.availableModes).toEqual({ day: true, night: false, dtr: false });
    expect(meta.modeReasons.night).toMatch(/rerun notebook v2/);
    expect(meta.scenarios).toEqual([]);
    expect(meta.nCells).toBe(55150);
  });
  it("v2 manifests: modes and scenarios from timeline.frames", () => {
    const meta = deriveBundleMeta({
      schema_version: "2.0",
      timeline: {
        now: 2025,
        frames: [
          { year: 1990, day: { tier: "observed-sparse", available: true }, night: { tier: "modelled", available: true } },
          { year: 2030, day: { tier: "projected", available: true }, night: { tier: "projected", available: false } },
        ],
        scenarios: [{ id: "ssp245", label: "SSP2-4.5" }, { id: "ssp585", label: "SSP5-8.5" }],
      },
    });
    expect(meta.isV2).toBe(true);
    expect(meta.availableModes).toEqual({ day: true, night: true, dtr: true });
    expect(meta.scenarios.map((s) => s.id)).toEqual(["ssp245", "ssp585"]);
    expect(meta.now).toBe(2025);
  });
});

describe("routes", () => {
  it("normalises ids and stage behaviour", () => {
    expect(normalizeRoute("LAB")).toBe("lab");
    expect(normalizeRoute("nope")).toBeNull();
    expect(stageBehaviour("timeline")).toBe("dimmed");
    expect(stageBehaviour("drivers")).toBe("dock-right");
    expect(stageBehaviour("drivers", 390)).toBe("unmounted");
    expect(stageBehaviour("control", 390)).toBe("live");
  });
});
