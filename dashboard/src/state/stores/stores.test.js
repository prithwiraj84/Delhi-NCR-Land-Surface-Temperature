import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { buildTimeline } from "../../data/timeline.js";
import { createSynthV2 } from "../../data/fixtures/synthV2.js";
import { selectionStoreInitializer } from "./selectionStore.js";
import { selectExactYear, selectInterpolated, timeStoreInitializer, useTimeStore } from "./timeStore.js";
import { MOTION_STORAGE_KEY, viewStoreInitializer } from "./viewStore.js";

const timeline = buildTimeline(createSynthV2().manifest);
const v1Timeline = buildTimeline({ timeline: { now: 2025, frames: [2010, 2015, 2020, 2025].map((year) => ({ year, day: { tier: "observed" } })) } }, { schema: "v1" });

const timeStore = () => {
  const s = createStore(timeStoreInitializer);
  s.getState().configure(timeline);
  return s;
};

describe("timeStore (UI_SPEC §7 shape)", () => {
  it("exposes exactly the binding fields and actions", () => {
    const s = timeStore().getState();
    for (const key of ["year", "scrubT", "playing", "speed", "loop", "snap", "mode", "ssp", "bracket", "compare"]) expect(s).toHaveProperty(key);
    for (const fn of ["setYear", "scrubTo", "release", "play", "pause", "step", "jumpTier", "setMode", "cycleSsp", "setCompare"]) expect(typeof s[fn]).toBe("function");
    expect(s.bracket).toEqual({ iA: 7, iB: 7, mix: 0, yA: 2025, yB: 2025 });
    expect(s.compare).toEqual({ kind: null, a: null, b: null, splitPx: null });
    expect(typeof useTimeStore.getState).toBe("function");
  });

  it("configures to NOW / day / ssp245 and keeps valid prior or initial state", () => {
    const s = timeStore();
    expect(s.getState()).toMatchObject({ year: 2025, scrubT: 2025, mode: "day", ssp: "ssp245", first: 1990, last: 2050 });
    const t = createStore(timeStoreInitializer);
    t.getState().configure(timeline, { year: 2040, mode: "night", ssp: "585" });
    expect(t.getState()).toMatchObject({ year: 2040, mode: "night", ssp: "ssp585" });
    t.getState().configure(v1Timeline);
    expect(t.getState()).toMatchObject({ year: 2025, mode: "day", ssp: null, last: 2025 });
  });

  it("scrubs without committing the year, then snaps within 2.5 years on release", () => {
    const s = timeStore();
    const before = s.getState().bracket;
    s.getState().scrubTo(2032.2);
    expect(s.getState()).toMatchObject({ year: 2025, scrubT: 2032.2, dragging: true });
    expect(s.getState().bracket).toMatchObject({ iA: 8, iB: 9, yA: 2030, yB: 2035 });
    expect(s.getState().bracket).not.toBe(before);
    expect(selectInterpolated(s.getState())).toBe(true);
    expect(selectExactYear(s.getState())).toBeNull();
    s.getState().release();
    expect(s.getState()).toMatchObject({ year: 2030, scrubT: 2030, dragging: false });
    expect(selectExactYear(s.getState())).toBe(2030);
    s.getState().scrubTo(2033.4);
    s.getState().release({ snap: false }); // Shift held
    expect(s.getState().year).toBe(2033);
    s.getState().scrubTo(1800);
    expect(s.getState().scrubT).toBe(1990);
  });

  it("keeps the bracket identity while the playhead stays on the same values", () => {
    const s = timeStore();
    s.getState().setYear(2025);
    const b = s.getState().bracket;
    s.getState().setYear(2025);
    expect(s.getState().bracket).toBe(b);
  });

  it("steps between frames, nudges by whole years and jumps tier boundaries", () => {
    const s = timeStore();
    s.getState().step(1);
    expect(s.getState().year).toBe(2030);
    s.getState().nudge(2);
    expect(s.getState().year).toBe(2032);
    s.getState().step(-1);
    expect(s.getState().year).toBe(2030);
    s.getState().step(-1);
    expect(s.getState().year).toBe(2025);
    s.getState().setYear(2050);
    s.getState().step(1);
    expect(s.getState().year).toBe(2050);
    s.getState().setYear(1990);
    s.getState().setMode("night");
    s.getState().jumpTier(1);
    expect(s.getState().year).toBe(2000); // modelled -> reconstructed
    s.getState().jumpTier(1);
    expect(s.getState().year).toBe(2005); // -> observed
    s.getState().jumpTier(1);
    expect(s.getState().year).toBe(2025); // NOW
    s.getState().jumpTier(-1);
    expect(s.getState().year).toBe(2005);
    s.getState().setYear(2031.6, { snap: true });
    expect(s.getState().year).toBe(2030);
  });

  it("validates modes against the bundle (v1: day only) and cycles SSPs from the manifest", () => {
    const s = timeStore();
    expect(s.getState().setMode("dtr")).toBe(true);
    expect(s.getState().toggleDayNight()).toBe(true);
    expect(s.getState().mode).toBe("day"); // DTR -> day
    s.getState().toggleDayNight();
    expect(s.getState().mode).toBe("night");
    expect(s.getState().setMode("evening")).toBe(false);
    s.getState().cycleSsp();
    expect(s.getState().ssp).toBe("ssp585");
    s.getState().cycleSsp();
    expect(s.getState().ssp).toBe("ssp126");
    s.getState().cycleSsp(-1);
    expect(s.getState().ssp).toBe("ssp585");
    expect(s.getState().setSsp("370")).toBe(false);
    const v1 = createStore(timeStoreInitializer);
    v1.getState().configure(v1Timeline);
    expect(v1.getState().setMode("night")).toBe(false);
    expect(v1.getState().mode).toBe("day");
    v1.getState().cycleSsp();
    expect(v1.getState().ssp).toBeNull();
  });

  it("play restarts from the first frame at the end; compare validates kinds and normalises values", () => {
    const s = timeStore();
    s.getState().setYear(2050);
    s.getState().play();
    expect(s.getState()).toMatchObject({ playing: true, year: 1990 });
    s.getState().togglePlay();
    expect(s.getState().playing).toBe(false);
    expect(s.getState().setCompare({ kind: "y", a: 1980, b: 2050 })).toBe(true);
    expect(s.getState().compare).toMatchObject({ kind: "y", a: 1990, b: 2050, splitPx: null });
    s.getState().setCompare({ splitPx: 640 });
    expect(s.getState().compare.splitPx).toBe(640);
    expect(s.getState().setCompare({ kind: "s", a: "126", b: 585 })).toBe(true);
    expect(s.getState().compare).toMatchObject({ a: "ssp126", b: "ssp585" });
    expect(s.getState().setCompare({ kind: "x" })).toBe(false);
    s.getState().setCompare(null);
    expect(s.getState().compare.kind).toBeNull();
    s.getState().setSpeed(2);
    s.getState().setSpeed(7);
    expect(s.getState().speed).toBe(2);
  });
});

describe("viewStore", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("has the binding shape, splits shap:<feature> and validates every setter", () => {
    const v = createStore(viewStoreInitializer);
    const s = v.getState();
    for (const key of ["route", "layer", "shapFeature", "variable", "renderMode", "heightMode", "quantile", "lens", "analyst", "motionPref", "perfTier", "briefing", "domainMode"]) expect(s).toHaveProperty(key);
    expect(s.analyst).toEqual({ opacity: 0.92, h3: false, labels: true, boundaries: true, hillshade: false });
    expect(s.setLayer("shap:built")).toBe(true);
    expect(v.getState()).toMatchObject({ layer: "shap", shapFeature: "built" });
    expect(v.getState().setLayer("glitter")).toBe(false);
    expect(v.getState().setRoute("lab")).toBe(true);
    expect(v.getState().setRoute("story")).toBe(false);
    v.getState().cycleRenderMode();
    expect(v.getState().renderMode).toBe("grid");
    v.getState().setAnalyst({ opacity: 3, h3: 1, bogus: true });
    expect(v.getState().analyst).toMatchObject({ opacity: 1, h3: true });
    expect(v.getState().analyst).not.toHaveProperty("bogus");
    expect(v.getState().setPerfTier(4)).toBe(false);
    v.getState().setBriefingStep(12, 9);
    expect(v.getState().briefing).toEqual({ active: true, step: 8 });
    v.getState().stopBriefing();
    expect(v.getState().briefing.active).toBe(false);
  });

  it("applies decision D2 (abs only for harmonised bundles) unless the user chose a variable", () => {
    const v = createStore(viewStoreInitializer);
    v.getState().configure({ harmonised: false });
    expect(v.getState().variable).toBe("anom");
    v.getState().configure({ harmonised: true, shapFeature: "ndvi" });
    expect(v.getState()).toMatchObject({ variable: "abs", shapFeature: "ndvi" });
    v.getState().setVariable("suhi");
    v.getState().configure({ harmonised: false });
    expect(v.getState().variable).toBe("suhi");
  });

  it("persists the motion preference and survives blocked storage", () => {
    const mem = new Map();
    vi.stubGlobal("localStorage", { getItem: (k) => mem.get(k) ?? null, setItem: (k, val) => mem.set(k, val) });
    const v = createStore(viewStoreInitializer);
    v.getState().cycleMotionPref();
    expect(v.getState().motionPref).toBe("full");
    expect(mem.get(MOTION_STORAGE_KEY)).toBe("full");
    expect(createStore(viewStoreInitializer).getState().motionPref).toBe("full");
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
    });
    const blocked = createStore(viewStoreInitializer);
    expect(blocked.getState().motionPref).toBe("system");
    expect(blocked.getState().setMotionPref("reduced")).toBe(true);
    expect(blocked.getState().motionPref).toBe("reduced");
  });
});

describe("selectionStore", () => {
  it("validates indices, toggles pins and clears everything", () => {
    const sel = createStore(selectionStoreInitializer);
    expect(sel.getState()).toEqual(expect.objectContaining({ hoverIndex: null, pinnedIndex: null, districtId: null, zoneId: null, brushMask: null }));
    expect(sel.getState().setHover(-1)).toBe(false);
    sel.getState().setHover(12);
    sel.getState().togglePin(5);
    expect(sel.getState().pinnedIndex).toBe(5);
    sel.getState().togglePin(5);
    expect(sel.getState().pinnedIndex).toBeNull();
    expect(sel.getState().setZone(4)).toBe(false);
    expect(sel.getState().setBrushMask([1, 0])).toBe(false);
    sel.getState().setBrushMask(new Uint8Array(3));
    sel.getState().setDistrict(7);
    sel.getState().clear();
    expect(sel.getState()).toMatchObject({ hoverIndex: null, districtId: null, brushMask: null });
  });
});
