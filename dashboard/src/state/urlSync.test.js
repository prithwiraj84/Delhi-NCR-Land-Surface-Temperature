/**
 * URL schema (UI_SPEC §2.2): pure codec + two-way sync against §7-shaped stores with a fake
 * window (debounced replaceState, pushState on route change, nothing during playback,
 * back/forward applies to the stores).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { create } from "zustand";
import { formatLocation, parseCamera, parseCompare, parseLocation, startUrlSync } from "./urlSync.js";

describe("codec", () => {
  it("parses the spec example", () => {
    const loc = parseLocation("#/control?y=2040&m=night&s=245&v=abs&l=lst&r=auto&h=anom&q=p50&c=48211&d=7&cmp=y:1990&cam=77.21,28.61,8.2,40,-12");
    expect(loc.route).toBe("control");
    expect(loc.params).toEqual({
      year: 2040,
      mode: "night",
      ssp: "ssp245",
      variable: "abs",
      layer: "lst",
      renderMode: "auto",
      heightMode: "anom",
      quantile: "p50",
      cell: 48211,
      district: 7,
      compare: { kind: "year", value: 1990 },
      camera: { longitude: 77.21, latitude: 28.61, zoom: 8.2, pitch: 40, bearing: -12 },
    });
  });

  it("drops invalid params instead of throwing", () => {
    const { route, params } = parseLocation("#/nowhere?y=1850&m=dusk&s=999&v=raw&l=bogus&c=-3&z=99&cmp=x:1&cam=1,2");
    expect(route).toBeNull();
    expect(params).toEqual({});
  });

  it("round-trips, omits static defaults and keeps shap features and anchors", () => {
    const hash = formatLocation({
      route: "drivers",
      params: { year: 2025, mode: "day", ssp: "ssp245", variable: "anom", layer: "shap", shapFeature: "ndvi", renderMode: "grid", heightMode: "anom", quantile: "p50" },
      anchor: "dependence",
    });
    expect(hash).toBe("#/drivers?y=2025&v=anom&l=shap:ndvi&r=grid#dependence");
    const back = parseLocation(hash);
    expect(back.route).toBe("drivers");
    expect(back.anchor).toBe("dependence");
    expect(back.params).toMatchObject({ year: 2025, layer: "shap", shapFeature: "ndvi", variable: "anom", renderMode: "grid" });
  });

  it("keeps ':' and ',' readable in compare and camera", () => {
    const hash = formatLocation({ route: "control", params: { year: 2050, compare: { kind: "year", a: 1990 }, camera: { longitude: 77.2, latitude: 28.6, zoom: 8, pitch: 40, bearing: -12 } } });
    expect(hash).toBe("#/control?y=2050&cmp=y:1990&cam=77.2000,28.6000,8.00,40,-12");
  });

  it("compare and camera helpers", () => {
    expect(parseCompare("s:585")).toEqual({ kind: "ssp", value: "ssp585" });
    expect(parseCompare("m:night")).toEqual({ kind: "mode", value: "night" });
    expect(parseCompare("y:2100")).toBeNull();
    expect(parseCamera("77,28,30,40,0")).toBeNull(); // zoom out of range
  });

  it("accepts v1 route aliases", () => {
    expect(parseLocation("#twin").route).toBe("control");
    expect(parseLocation("#/thresholds").route).toBe("drivers");
    expect(parseLocation("#performance").route).toBe("lab");
  });
});

function fakeWindow(hash = "") {
  const listeners = {};
  const win = {
    location: { hash, search: "", pathname: "/" },
    history: {
      state: null,
      pushState: vi.fn((state, __, url) => {
        win.history.state = state;
        win.location.hash = url;
      }),
      replaceState: vi.fn((state, __, url) => {
        win.history.state = state;
        win.location.hash = url;
      }),
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
    addEventListener: (type, fn) => (listeners[type] = fn),
    removeEventListener: (type) => delete listeners[type],
    fire: (type, event) => listeners[type]?.(event),
  };
  return win;
}

function makeStores() {
  return {
    time: create((set) => ({
      year: 2025,
      scrubT: 2025,
      playing: false,
      mode: "day",
      ssp: "ssp245",
      compare: null,
      setYear: (y) => set({ year: y, scrubT: y }),
      setMode: (mode) => set({ mode }),
      setCompare: (compare) => set({ compare }),
    })),
    view: create(() => ({ route: "control", layer: "lst", shapFeature: null, variable: "abs", renderMode: "auto", heightMode: "anom", quantile: "p50" })),
    selection: create(() => ({ pinnedIndex: null, districtId: null, zoneId: null })),
  };
}

describe("startUrlSync", () => {
  let stop = () => {};
  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  it("applies the URL on start (respecting available SSPs) and normalises it", () => {
    vi.useFakeTimers();
    const win = fakeWindow("#/timeline?y=2040&m=night&s=585&cmp=y:1990&d=3");
    const stores = makeStores();
    stop = startUrlSync(stores, { win, getAvailableSsps: () => ["ssp245"] });
    expect(stores.view.getState().route).toBe("timeline");
    expect(stores.time.getState().year).toBe(2040);
    expect(stores.time.getState().mode).toBe("night");
    expect(stores.time.getState().ssp).toBe("ssp245"); // 585 not in this bundle
    expect(stores.time.getState().compare).toEqual({ kind: "y", a: 1990, b: 2040 });
    expect(stores.selection.getState().districtId).toBe(3);
    expect(win.location.hash).toBe("#/timeline?y=2040&m=night&v=abs&r=auto&d=3&cmp=y:1990");
  });

  it("debounces param writes with replaceState and pushes route changes", () => {
    vi.useFakeTimers();
    const win = fakeWindow("#/control?y=2025");
    const stores = makeStores();
    stop = startUrlSync(stores, { win });
    win.history.replaceState.mockClear();
    stores.time.getState().setYear(2030);
    stores.time.getState().setYear(2035);
    expect(win.history.replaceState).not.toHaveBeenCalled();
    vi.advanceTimersByTime(260);
    expect(win.history.replaceState).toHaveBeenCalledTimes(1);
    expect(win.location.hash).toMatch(/y=2035/);
    stores.view.setState({ route: "lab" });
    expect(win.history.pushState).toHaveBeenCalledTimes(1);
    expect(win.location.hash).toMatch(/^#\/lab\?/);
  });

  it("writes nothing during playback and once when it stops", () => {
    vi.useFakeTimers();
    const win = fakeWindow("#/control?y=2025");
    const stores = makeStores();
    stop = startUrlSync(stores, { win });
    win.history.replaceState.mockClear();
    stores.time.setState({ playing: true });
    stores.time.getState().setYear(2030);
    stores.time.getState().setYear(2035);
    vi.advanceTimersByTime(1000);
    expect(win.history.replaceState).not.toHaveBeenCalled();
    stores.time.setState({ playing: false });
    vi.advanceTimersByTime(300);
    expect(win.history.replaceState).toHaveBeenCalledTimes(1);
    expect(win.location.hash).toMatch(/y=2035/);
  });

  it("applies back/forward navigation to the stores", () => {
    vi.useFakeTimers();
    const win = fakeWindow("#/control?y=2025");
    const stores = makeStores();
    stop = startUrlSync(stores, { win });
    win.location.hash = "#/zones?y=2010&l=zones&z=3";
    win.fire("popstate");
    expect(stores.view.getState().route).toBe("zones");
    expect(stores.view.getState().layer).toBe("zones");
    expect(stores.time.getState().year).toBe(2010);
    expect(stores.selection.getState().zoneId).toBe(3);
  });

  it("back/forward to a URL without a param restores its default (defaults are never written)", () => {
    vi.useFakeTimers();
    const win = fakeWindow("#/control?y=2040&m=night&cmp=y:1990&c=12");
    const stores = makeStores();
    stop = startUrlSync(stores, { win });
    expect(stores.time.getState().mode).toBe("night");
    expect(stores.selection.getState().pinnedIndex).toBe(12);
    // Back/forward onto an entry this module wrote (state marker): absent params = defaults.
    win.location.hash = "#/control?y=2040";
    win.history.state = { ncrUrlSync: 1 };
    win.fire("popstate", { state: { ncrUrlSync: 1 } });
    win.fire("hashchange");
    expect(stores.time.getState().mode).toBe("day");
    expect(stores.time.getState().compare).toBeNull();
    expect(stores.selection.getState().pinnedIndex).toBeNull();
    expect(stores.time.getState().year).toBe(2040);
  });

  it("an in-app hash link (#/control) keeps mode, SSP, layer and pin, then re-normalises the URL (T-F4-16)", () => {
    vi.useFakeTimers();
    const win = fakeWindow("#/timeline?y=2040&m=night&s=585&l=resid&c=12&d=4");
    const stores = makeStores();
    stores.time.setState({ setSsp: (ssp) => stores.time.setState({ ssp }) });
    stop = startUrlSync(stores, { win });
    expect(stores.time.getState().mode).toBe("night");
    expect(stores.view.getState().layer).toBe("resid");
    // The logo / a bare hash link: the browser creates a new entry without our state marker and
    // fires popstate (state null) then hashchange.
    win.location.hash = "#/control";
    win.history.state = null;
    win.fire("popstate", { state: null });
    win.fire("hashchange");
    expect(stores.view.getState().route).toBe("control");
    expect(stores.time.getState().mode).toBe("night");
    expect(stores.time.getState().ssp).toBe("ssp585");
    expect(stores.view.getState().layer).toBe("resid");
    expect(stores.selection.getState().pinnedIndex).toBe(12);
    expect(stores.selection.getState().districtId).toBe(4);
    expect(win.location.hash.startsWith("#/control?y=2040&m=night&s=585&v=abs&l=resid")).toBe(true);
    expect(win.location.hash).toMatch(/c=12&d=4/);
    // A hashchange alone (manual edit) behaves the same way.
    win.location.hash = "#/sources";
    win.fire("hashchange");
    expect(stores.view.getState().route).toBe("sources");
    expect(stores.time.getState().mode).toBe("night");
  });

  it("works against the real E2 stores (compare kinds, validated setters)", async () => {
    vi.useFakeTimers();
    const { timeStoreInitializer } = await import("./stores/timeStore.js");
    const { viewStoreInitializer } = await import("./stores/viewStore.js");
    const { selectionStoreInitializer } = await import("./stores/selectionStore.js");
    const stores = { time: create(timeStoreInitializer), view: create(viewStoreInitializer), selection: create(selectionStoreInitializer) };
    const win = fakeWindow("#/drivers?y=2045&m=night&s=585&l=shap:ndvi&cmp=s:126&d=4");
    stop = startUrlSync(stores, { win });
    expect(stores.view.getState().route).toBe("drivers");
    expect(stores.view.getState().layer).toBe("shap");
    expect(stores.view.getState().shapFeature).toBe("ndvi");
    expect(stores.time.getState().year).toBe(2045);
    expect(stores.time.getState().compare).toMatchObject({ kind: "s", a: "ssp126" });
    expect(stores.selection.getState().districtId).toBe(4);
    expect(parseLocation(win.location.hash).params).toMatchObject({ year: 2045, mode: "night", ssp: "ssp585", compare: { kind: "ssp", value: "ssp126" } });
  });

  it("stop() detaches every listener", () => {
    vi.useFakeTimers();
    const win = fakeWindow("#/control?y=2025");
    const stores = makeStores();
    startUrlSync(stores, { win })();
    win.history.replaceState.mockClear();
    stores.time.getState().setYear(2040);
    vi.advanceTimersByTime(500);
    expect(win.history.replaceState).not.toHaveBeenCalled();
  });
});
