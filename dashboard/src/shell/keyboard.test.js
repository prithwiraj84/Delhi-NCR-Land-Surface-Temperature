/**
 * Keyboard map (UI_SPEC §2.3): resolution rules (typing targets, slider ownership, overlays,
 * modifiers) and the action executor against §7-shaped stores.
 */
import { describe, expect, it, vi } from "vitest";
import { create } from "zustand";
import { isTypingTarget, resolveShortcut, SHORTCUTS } from "./keyboard.js";
import { runAction } from "./actions.js";

const el = (tagName, attrs = {}) => ({ tagName, type: attrs.type, isContentEditable: Boolean(attrs.editable), getAttribute: (k) => attrs[k] ?? null });
const key = (k, extra = {}) => ({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, target: el("BODY"), ...extra });

function makeStores() {
  const years = [1990, 1995, 2000, 2005, 2010, 2015, 2020, 2025, 2030, 2035, 2040, 2045, 2050];
  const time = create((set, get) => ({
    year: 2025,
    scrubT: 2025,
    playing: false,
    mode: "day",
    ssp: "ssp245",
    compare: null,
    setYear: vi.fn((y) => set({ year: y, scrubT: y })),
    play: vi.fn(() => set({ playing: true })),
    pause: vi.fn(() => set({ playing: false })),
    step: vi.fn((d) => {
      const i = years.indexOf(get().year);
      set({ year: years[Math.max(0, Math.min(years.length - 1, i + d))] });
    }),
    jumpTier: vi.fn(),
    setMode: vi.fn((mode) => set({ mode })),
    cycleSsp: vi.fn(),
    setCompare: vi.fn((compare) => set({ compare })),
  }));
  const view = create(() => ({ route: "control", renderMode: "auto", lens: false, motionPref: "system", perfTier: 0, briefing: { active: false, step: 0 } }));
  const selection = create(() => ({ pinnedIndex: null, districtId: null, zoneId: null }));
  return { time, view, selection, years };
}

describe("resolveShortcut", () => {
  it("maps the documented keys", () => {
    expect(resolveShortcut(key("3"))).toEqual({ type: "route", index: 2 });
    expect(resolveShortcut(key("7"))).toBeNull();
    expect(resolveShortcut(key(" "))).toEqual({ type: "togglePlay" });
    expect(resolveShortcut(key("ArrowRight"))).toEqual({ type: "stepFrame", dir: 1 });
    expect(resolveShortcut(key("]"))).toEqual({ type: "stepFrame", dir: 1 });
    expect(resolveShortcut(key("[", {}))).toEqual({ type: "stepFrame", dir: -1 });
    expect(resolveShortcut(key("ArrowLeft", { shiftKey: true }))).toEqual({ type: "jumpTier", dir: -1 });
    expect(resolveShortcut(key(","))).toEqual({ type: "stepYear", delta: -1 });
    expect(resolveShortcut(key("PageUp"))).toEqual({ type: "stepYear", delta: 10 });
    expect(resolveShortcut(key("PageDown"))).toEqual({ type: "stepYear", delta: -10 });
    expect(resolveShortcut(key("Home"))).toEqual({ type: "setYear", year: 1990 });
    expect(resolveShortcut(key("End"))).toEqual({ type: "setYear", year: 2050 });
    expect(resolveShortcut(key("d"))).toEqual({ type: "mode", mode: "day" });
    expect(resolveShortcut(key("N"))).toEqual({ type: "mode", mode: "night" }); // caps lock
    expect(resolveShortcut(key("t"))).toEqual({ type: "toggleDayNight" });
    expect(resolveShortcut(key("a"))).toEqual({ type: "mode", mode: "dtr" });
    for (const [k, type] of [
      ["s", "cycleSsp"],
      ["l", "focusLayerDock"],
      ["g", "cycleRender"],
      ["z", "toggleLens"],
      ["c", "toggleCompare"],
      ["h", "probeHottest"],
      ["b", "toggleBriefing"],
      ["m", "cycleMotion"],
    ]) {
      expect(resolveShortcut(key(k)).type).toBe(type);
    }
    expect(resolveShortcut(key("?", { shiftKey: true }))).toEqual({ type: "openShortcuts" });
    expect(resolveShortcut(key("k", { ctrlKey: true }))).toEqual({ type: "openPalette" });
    expect(resolveShortcut(key("K", { metaKey: true }))).toEqual({ type: "openPalette" });
    expect(resolveShortcut(key("Escape"))).toEqual({ type: "escape" });
  });

  it("ignores keys while typing, except Escape and Ctrl+K", () => {
    const input = el("INPUT", { type: "text" });
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(el("INPUT", { type: "checkbox" }))).toBe(false);
    expect(isTypingTarget(el("DIV", { editable: true }))).toBe(true);
    expect(isTypingTarget(el("DIV", { role: "combobox" }))).toBe(true);
    expect(resolveShortcut(key("d", { target: input }))).toBeNull();
    expect(resolveShortcut(key("1", { target: el("TEXTAREA") }))).toBeNull();
    expect(resolveShortcut(key("Escape", { target: input }))).toEqual({ type: "escape" });
    expect(resolveShortcut(key("k", { ctrlKey: true, target: input }))).toEqual({ type: "openPalette" });
  });

  it("lets the ribbon slider own arrows/Home/End/Page keys, but not letters", () => {
    const slider = el("DIV", { role: "slider" });
    for (const k of ["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]) expect(resolveShortcut(key(k, { target: slider }))).toBeNull();
    expect(resolveShortcut(key("n", { target: slider }))).toEqual({ type: "mode", mode: "night" });
  });

  it("only Escape and Ctrl+K resolve while an overlay is open or before the bundle is ready", () => {
    expect(resolveShortcut(key("d"), { overlayOpen: true })).toBeNull();
    expect(resolveShortcut(key("Escape"), { overlayOpen: true })).toEqual({ type: "escape" });
    expect(resolveShortcut(key(" "), { ready: false })).toBeNull();
    expect(resolveShortcut(key("k", { ctrlKey: true }), { ready: false })).toEqual({ type: "openPalette" });
  });

  it("leaves browser chords and Space-on-button alone", () => {
    expect(resolveShortcut(key("d", { ctrlKey: true }))).toBeNull();
    expect(resolveShortcut(key("1", { altKey: true }))).toBeNull();
    expect(resolveShortcut(key(" ", { target: el("BUTTON") }))).toBeNull();
    expect(resolveShortcut(key(" ", { repeat: true }))).toBeNull();
  });

  it("every letter shortcut in the sheet resolves to an action", () => {
    const letters = SHORTCUTS.filter((s) => s.keys.length === 1 && /^[A-Z]$/.test(s.keys[0])).map((s) => s.keys[0]);
    for (const l of letters) expect(resolveShortcut(key(l.toLowerCase())), l).not.toBeNull();
  });
});

describe("runAction", () => {
  it("routes, plays/pauses, steps and clamps years", () => {
    const stores = makeStores();
    const ctx = { stores, years: stores.years, win: null };
    runAction({ type: "route", index: 3 }, ctx);
    expect(stores.view.getState().route).toBe("zones");
    runAction({ type: "togglePlay" }, ctx);
    expect(stores.time.getState().playing).toBe(true);
    runAction({ type: "togglePlay" }, ctx);
    expect(stores.time.getState().playing).toBe(false);
    runAction({ type: "stepFrame", dir: 1 }, ctx);
    expect(stores.time.getState().year).toBe(2030);
    runAction({ type: "stepYear", delta: 30 }, ctx);
    expect(stores.time.getState().year).toBe(2050);
    runAction({ type: "setYear", year: 1990 }, ctx);
    runAction({ type: "stepYear", delta: -10 }, ctx);
    expect(stores.time.getState().year).toBe(1990);
  });

  it("refuses unavailable modes with a toast + announcement instead of switching", () => {
    const stores = makeStores();
    const toast = vi.fn();
    const announce = vi.fn();
    runAction({ type: "mode", mode: "night" }, { stores, availableModes: { day: true, night: false, dtr: false }, toast, announce, win: null });
    expect(stores.time.getState().mode).toBe("day");
    expect(toast).toHaveBeenCalledOnce();
    expect(announce.mock.calls[0][0]).toMatch(/Night is unavailable/);
    runAction({ type: "toggleDayNight" }, { stores, availableModes: { day: true, night: true, dtr: true }, win: null });
    expect(stores.time.getState().mode).toBe("night");
  });

  it("cycles render mode and motion preference, toggles lens/compare/briefing", () => {
    const stores = makeStores();
    const ctx = { stores, years: stores.years, win: null };
    runAction({ type: "cycleRender" }, ctx);
    expect(stores.view.getState().renderMode).toBe("grid");
    runAction({ type: "cycleMotion" }, ctx);
    expect(stores.view.getState().motionPref).toBe("full");
    runAction({ type: "toggleLens" }, ctx);
    expect(stores.view.getState().lens).toBe(true);
    runAction({ type: "toggleCompare" }, ctx);
    expect(stores.time.getState().compare).toEqual({ kind: "y", a: 1990, b: 2050 });
    runAction({ type: "toggleCompare" }, ctx);
    expect(stores.time.getState().compare).toBeNull();
    stores.view.setState({ route: "lab" });
    runAction({ type: "toggleBriefing" }, ctx);
    expect(stores.view.getState().briefing.active).toBe(true);
    expect(stores.view.getState().route).toBe("control");
  });

  it("Escape closes an overlay first, then unpins, then ends the briefing", () => {
    const stores = makeStores();
    stores.selection.setState({ pinnedIndex: 42 });
    stores.view.setState({ briefing: { active: true, step: 3 } });
    let overlayOpen = true;
    const ctx = { stores, win: null, ui: { closeOverlay: () => (overlayOpen ? !(overlayOpen = false) : false) } };
    expect(runAction({ type: "escape" }, ctx)).toBe(true);
    expect(stores.selection.getState().pinnedIndex).toBe(42);
    runAction({ type: "escape" }, ctx);
    expect(stores.selection.getState().pinnedIndex).toBeNull();
    runAction({ type: "escape" }, ctx);
    expect(stores.view.getState().briefing.active).toBe(false);
    expect(runAction({ type: "escape" }, ctx)).toBe(false);
  });

  it("delivers cross-stream actions as window events", () => {
    const stores = makeStores();
    const events = [];
    const win = { CustomEvent: class {
      constructor(type, init) {
        this.type = type;
        this.detail = init?.detail;
      }
    }, dispatchEvent: (e) => events.push(e) };
    runAction({ type: "probeHottest" }, { stores, win });
    runAction({ type: "selectDistrict", districtId: 7 }, { stores, win });
    expect(events.map((e) => e.type)).toEqual(["ncr:probe-hottest", "ncr:fly-to"]);
    expect(events[1].detail).toEqual({ districtId: 7 });
    expect(stores.selection.getState().districtId).toBe(7);
  });
});

describe("scrollToAnchor keeps the urlSync history marker (T-F4-16)", () => {
  it("replaces the URL with the anchor but keeps history.state", async () => {
    const { scrollToAnchor } = await import("./actions.js");
    const calls = [];
    const el = { scrollIntoView() {}, focus() {}, tabIndex: -1 };
    const win = {
      document: { getElementById: (id) => (id === "caveats" ? el : null) },
      location: { hash: "#/sources?m=day" },
      history: { state: { ncrUrlSync: 1 }, replaceState: (state, title, url) => calls.push([state, url]) },
      dispatchEvent() {},
      setTimeout: (fn) => fn(),
    };
    scrollToAnchor(win, "caveats");
    expect(calls).toEqual([[{ ncrUrlSync: 1 }, "#/sources?m=day#caveats"]]);
  });
});
