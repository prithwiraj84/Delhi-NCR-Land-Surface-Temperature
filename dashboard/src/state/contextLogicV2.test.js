// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { createFsFetch, PUBLIC_DATA_DIR, PUBLIC_DEMO_DIR, publicDataExists, publicDemoExists, readJson } from "../lib/__tests__/testUtils.js";
import { createBundleStore } from "../data/bundleStore.js";
import { createFixtureFetch, createSynthV2 } from "../data/fixtures/synthV2.js";
import { buildTimeline } from "../data/timeline.js";
import { useCube, useTimeline } from "../data/hooks.js";
import {
  facadeMode,
  facadeYear,
  routeForView,
  v1LayerFor,
  v1ManifestView,
  v2LayerFor,
  viewForRoute,
} from "./contextLogic.js";
import { DataProvider, useData } from "./DataContext.jsx";
import { useSelectionStore } from "./stores/selectionStore.js";
import { useTimeStore } from "./stores/timeStore.js";
import { useViewStore } from "./stores/viewStore.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const synth = createSynthV2();
const mounted = [];

afterEach(() => {
  while (mounted.length) {
    const root = mounted.pop();
    act(() => root.unmount());
  }
  useTimeStore.getState().reset();
  useViewStore.getState().reset();
  useSelectionStore.getState().clear();
});

async function waitFor(check, timeout = 20000) {
  const start = Date.now();
  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() - start > timeout) throw error;
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
}

function mountProvider(store) {
  const out = { data: null, timeline: null, cube: null };
  function Probe() {
    out.data = useData();
    out.timeline = useTimeline();
    out.cube = useCube("day", "obs");
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(DataProvider, { store }, createElement(Probe))));
  mounted.push(root);
  return out;
}

describe("facade mapping helpers", () => {
  it("maps v1 views/layers to v2 routes/layers and back", () => {
    expect(routeForView("thresholds")).toBe("drivers");
    expect(viewForRoute("lab")).toBe("performance");
    expect(viewForRoute("sources")).toBe("twin");
    expect(routeForView("nope")).toBeNull();
    expect(v2LayerFor("scenario")).toBe("whatif");
    expect(v1LayerFor("resid")).toBe("resid_oof");
    expect(v1LayerFor("aoa")).toBe("lst_obs");
    expect(facadeMode("dtr")).toBe("day");
    expect(facadeYear([2010, 2015, 2020, 2025], 2017.4)).toBe(2015);
    expect(facadeYear([2010, 2015, 2020, 2025], 2040)).toBe(2025);
    expect(facadeYear([], 2040)).toBeNull();
  });

  it("builds a v1 manifest view of a v2 manifest for the current mode", () => {
    const tl = buildTimeline(synth.manifest);
    const view = v1ManifestView(synth.manifest, { schema: "v2", mode: "night", timeline: tl, groupFeatures: [{ name: "built" }] });
    expect(view.features).toEqual([{ name: "built" }]);
    expect(view.zones).toHaveLength(4);
    expect(view.epochs).toEqual(tl.obsYears);
    expect(view.epoch_means["2025"]).toBe(synth.manifest.timeline.frames[7].night.level);
    expect(view.files.epochs["2010"]).toBe("xai_2010_night.lstb.gz");
    const v1 = { schema_version: "1.0" };
    expect(v1ManifestView(v1, { schema: "v1" })).toBe(v1);
  });
});

describe("DataProvider on the in-memory v2 fixture", () => {
  it("keeps the v1 useData() contract on top of the v2 stores", async () => {
    const store = createBundleStore({ fixtureLoader: async () => ({ synth, fetchImpl: createFixtureFetch(synth, { compress: false }) }) });
    act(() => {
      store.getState().load({ source: { id: "fixture", baseUrl: null, explicit: true, reason: "test" } });
    });
    const out = mountProvider(store);
    await waitFor(() => expect(out.data.status).toBe("ready"));
    // T-F4-04: on the Control route nothing reads the v1 facade epoch, so none is synthesised.
    act(() => useViewStore.getState().setRoute("control"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });
    expect(Object.keys(store.getState().resources).filter((k) => k.startsWith("epoch:"))).toEqual([]);
    expect(out.data.epochLoading).toBe(false);
    // The Drivers route consumes it.
    act(() => useViewStore.getState().setRoute("drivers"));
    await waitFor(() => expect(out.data.epoch).not.toBeNull());
    const d = out.data;
    expect(d.schema).toBe("v2");
    expect(d.manifest.schema_version).toBe("2.0"); // raw manifest (the shell detects v2 from it)
    expect(d.features.map((f) => f.name)).toEqual(synth.manifest.groups.map((g) => g.id));
    expect(d.v1Manifest.features).toBe(d.features);
    expect(d.zonesMeta).toHaveLength(4);
    expect(d.year).toBe(2025);
    expect(d.epoch.year).toBe(2025);
    expect(Object.keys(d.epoch.shap)).toEqual(d.features.map((f) => f.name));
    expect(out.timeline.status).toBe("ready");
    expect(out.cube.status).toBe("ready");
    expect(useTimeStore.getState().years).toHaveLength(13);
    expect(useViewStore.getState().variable).toBe("abs"); // harmonised bundle (D2)

    await waitFor(() => expect(d.shapGlobal ?? out.data.shapGlobal).toBeTruthy());
    expect(out.data.shapGlobal.features).toEqual(synth.manifest.groups.map((g) => g.id));
    await waitFor(() => expect(out.data.shapFeature).toBeTruthy());

    act(() => out.data.setView("thresholds"));
    expect(useViewStore.getState().route).toBe("drivers");
    expect(out.data.view).toBe("thresholds");
    act(() => out.data.setMapLayer("resid_oof"));
    expect(useViewStore.getState().layer).toBe("resid");
    act(() => out.data.setSelectedCell(17));
    expect(useSelectionStore.getState().pinnedIndex).toBe(17);
    expect(out.data.selectedCell).toBe(17);

    // Switching to night swaps the explained epoch; the pinned cell (canonical index) survives.
    act(() => useTimeStore.getState().setMode("night"));
    await waitFor(() => expect(out.data.epoch?.mode).toBe("night"));
    expect(out.data.mode).toBe("night");
    expect(out.data.selectedCell).toBe(17);
    // An interpolated time-store year shows the nearest XAI frame.
    act(() => useTimeStore.getState().setYear(2012));
    await waitFor(() => expect(out.data.year).toBe(2010));
    expect(out.data.epochs["2010"]).toBe(out.data.epoch);

    await waitFor(() => expect(out.data.validation).not.toBeNull());
    expect(out.data.validation.errors).toEqual([]);
    expect(out.data.progress.length).toBeGreaterThan(3);
    expect(typeof out.data.setBundleSource).toBe("function");

    // Background loads (rasters, other XAI frames) must not change the facade value (no
    // re-render of every useData() consumer while the map prefetches during playback).
    act(() => out.data.setView("twin")); // scenario engine idle (its lifecycle is not a background load)
    await waitFor(() => expect(out.data.model).not.toBeNull());
    await waitFor(() => expect(out.data.scenarioPending).toBe(false));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });
    const before = out.data;
    await act(async () => {
      await Promise.all(["raster:day_2020", "raster:night_2015:preview", "raster:day_2010"].map((k) => store.getState().ensure(k)));
      await new Promise((r) => setTimeout(r, 200));
    });
    const changed = Object.keys(before).filter((k) => before[k] !== out.data[k]);
    expect(changed).toEqual([]);
    expect(out.data === before).toBe(true);
    expect(store.getState().progress.length).toBeGreaterThan(out.data.progress.length);
  }, 60000);
});

const realV1 = publicDataExists("manifest.json") && readJson(PUBLIC_DATA_DIR, "manifest.json").schema_version?.startsWith("1");

describe.skipIf(!realV1)("DataProvider on the REAL v1 bundle (public/data, read-only)", () => {
  it("serves the v1 facade and the v2 hooks from the same store, and validates the bundle", async () => {
    const store = createBundleStore({ fetchImpl: createFsFetch(PUBLIC_DATA_DIR) });
    act(() => {
      store.getState().load({ source: { id: "data", baseUrl: "/data", explicit: true, reason: "test" } });
    });
    const out = mountProvider(store);
    await waitFor(() => expect(out.data.status).toBe("ready"), 60000);
    await waitFor(() => expect(out.data.epoch).not.toBeNull());
    const manifest = readJson(PUBLIC_DATA_DIR, "manifest.json");
    expect(out.data.schema).toBe("v1");
    expect(out.data.year).toBe(Math.max(...manifest.epochs));
    expect(out.data.features).toBe(out.data.manifest.features);
    expect(out.data.epoch.n).toBe(manifest.study_area.area_km2);
    expect(useViewStore.getState().variable).toBe("anom"); // v1 is not harmonised (D2)
    expect(useTimeStore.getState().setMode("night")).toBe(false);
    await waitFor(() => expect(out.data.model).not.toBeNull(), 30000);
    await waitFor(() => expect(out.data.validation).not.toBeNull(), 30000);
    expect(out.data.validation.errors).toEqual([]);
    expect(out.data.validation.epochsChecked).toHaveLength(1);
    act(() => out.data.setYear(2015));
    await waitFor(() => expect(out.data.year).toBe(2015));
    expect(out.data.epoch.year).toBe(2015);
  }, 120000);
});

describe.skipIf(!publicDemoExists("manifest.json"))("DataProvider on the notebook's synthetic v2 demo bundle (public/demo)", () => {
  it("boots as a v2 bundle, flags it as synthetic and passes the SPEC §5 contract checks", async () => {
    const store = createBundleStore({ fetchImpl: createFsFetch(PUBLIC_DEMO_DIR) });
    act(() => {
      store.getState().load({ source: { id: "demo", baseUrl: "/demo", explicit: true, reason: "test" } });
    });
    const out = mountProvider(store);
    await waitFor(() => expect(out.data.status).toBe("ready"), 60000);
    const manifest = readJson(PUBLIC_DEMO_DIR, "manifest.json");
    expect(out.data.schema).toBe("v2");
    expect(manifest.data_mode).toBe("synthetic");
    expect(useTimeStore.getState().years.length).toBe(manifest.timeline.frames.length);
    // The validators load lazily on idle; the demo must satisfy every hard invariant.
    await waitFor(() => expect(out.data.validation).not.toBeNull(), 30000);
    expect(out.data.validation.errors).toEqual([]);
  }, 120000);
});
