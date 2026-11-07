// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { useTimeStore } from "../../state/stores/timeStore.js";
import { useViewStore } from "../../state/stores/viewStore.js";
import { createBundleStore } from "../bundleStore.js";
import { createFixtureFetch, createSynthV2 } from "../fixtures/synthV2.js";
import {
  BundleStoreContext,
  useBracket,
  useBundleStatus,
  useCellTimeline,
  useCube,
  useDomain,
  useFrameStats,
  useFrameTier,
  useFrameValues,
  useGuardedCopy,
  useRaster,
  useResource,
  useSeries,
  useTimeline,
  useXai,
} from "../hooks.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const synth = createSynthV2();
let store;
const mounted = [];

function renderHook(hook, { api = store } = {}) {
  const result = { current: null, renders: 0 };
  function Probe() {
    result.current = hook();
    result.renders += 1;
    return null;
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(createElement(BundleStoreContext.Provider, { value: api }, createElement(Probe))));
  mounted.push(root);
  return result;
}

async function waitFor(check, timeout = 8000) {
  const start = Date.now();
  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() - start > timeout) throw error;
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  }
}

beforeAll(async () => {
  store = createBundleStore({ fixtureLoader: async () => ({ synth, fetchImpl: createFixtureFetch(synth, { compress: false }) }) });
  await store.getState().load({ source: { id: "fixture", baseUrl: null, explicit: true, reason: "test" } });
  useTimeStore.getState().configure(store.getState().timeline);
}, 60000);

afterEach(() => {
  while (mounted.length) {
    const root = mounted.pop();
    act(() => root.unmount());
  }
  act(() => {
    useTimeStore.getState().setYear(2025);
    useTimeStore.getState().setMode("day");
    useTimeStore.getState().setSsp("ssp245");
    useViewStore.getState().setDomainMode("fixed");
  });
});

afterAll(() => {
  useTimeStore.getState().reset();
  store.getState().dispose();
});

describe("hook state machines", () => {
  it("useResource goes loading -> ready and shares the store entry", async () => {
    const r = renderHook(() => useResource("xai:2015:day"));
    expect(r.current.status).toBe("loading");
    await waitFor(() => expect(r.current.status).toBe("ready"));
    expect(r.current.data.groups).toHaveLength(18);
    expect(store.getState().resources["xai:2015:day"]).toBe(r.current);
  });

  it("reports loading before the bundle is ready and unavailable for an empty bundle", async () => {
    const pending = createBundleStore({ fetchImpl: async () => new Response("no", { status: 404 }) });
    const r = renderHook(() => useTimeline(), { api: pending });
    expect(r.current.status).toBe("loading");
    await act(async () => {
      await pending.getState().load({ source: { id: "data", baseUrl: "/data", explicit: true, reason: "t" } });
    });
    expect(r.current.status).toBe("unavailable");
    expect(r.current.reason).toMatch(/no bundle installed/);
    const status = renderHook(() => useBundleStatus(), { api: pending });
    expect(status.current.status).toBe("empty");
  });

  it("useTimeline / useFrameTier read tiers from the manifest and default to the time store", async () => {
    const tl = renderHook(() => useTimeline());
    expect(tl.current.status).toBe("ready");
    expect(tl.current.data.years).toHaveLength(13);
    const tier = renderHook(() => useFrameTier());
    expect(tier.current.data).toMatchObject({ year: 2025, tier: "observed", exact: true });
    act(() => {
      useTimeStore.getState().setMode("night");
      useTimeStore.getState().setYear(1995);
    });
    expect(tier.current.data).toMatchObject({ year: 1995, tier: "modelled" });
    const explicit = renderHook(() => useFrameTier(2042, "day", "585"));
    expect(explicit.current.data).toMatchObject({ interpolated: true, tier: "projected", series: "ssp585" });
  });

  it("useBracket re-renders coarsely while scrubbing and spreads {iA, iB, mix, yA, yB}", () => {
    const b = renderHook(() => useBracket());
    expect(b.current).toMatchObject({ status: "ready", iA: 7, iB: 7, mix: 0, exact: true });
    const before = b.renders;
    act(() => {
      useTimeStore.getState().scrubTo(2030.1);
      useTimeStore.getState().scrubTo(2030.11);
      useTimeStore.getState().scrubTo(2030.12);
    });
    expect(b.current).toMatchObject({ iA: 8, iB: 9, yA: 2030, yB: 2035 });
    expect(b.renders - before).toBeLessThanOrEqual(2);
    act(() => useTimeStore.getState().release());
    expect(b.current).toMatchObject({ iA: 8, iB: 8, exact: true });
  });

  it("useCube / useFrameValues decode exact frames and refuse interpolated years", async () => {
    const cube = renderHook(() => useCube("night", "ssp585"));
    await waitFor(() => expect(cube.current.status).toBe("ready"));
    expect(cube.current.data.values).toBeInstanceOf(Int16Array);
    expect(cube.current.data.years).toEqual([2030, 2035, 2040, 2045, 2050]);
    const values = renderHook(() => useFrameValues(2045, "night", "ssp585", "p95"));
    await waitFor(() => expect(values.current.status).toBe("ready"));
    expect(values.current.data).toMatchObject({ year: 2045, series: "ssp585", q: "p95", tier: "projected" });
    expect(values.current.data.values).toBeInstanceOf(Float32Array);
    const between = renderHook(() => useFrameValues(2043, "night", "ssp585"));
    expect(between.current.status).toBe("unavailable");
    expect(between.current.reason).toMatch(/not a frame year/);
    const dtr = renderHook(() => useFrameValues(2025, "dtr", undefined, "p95"));
    expect(dtr.current.reason).toMatch(/median only/);
    const dtr50 = renderHook(() => useFrameValues(2025, "dtr"));
    await waitFor(() => expect(dtr50.current.status).toBe("ready"));
  });

  it("useCellTimeline gathers observed and every SSP for one cell", async () => {
    const r = renderHook(() => useCellTimeline(42, "day"));
    await waitFor(() => expect(r.current.status === "ready" && !r.current.data.partial).toBe(true));
    expect(r.current.data.obs).toHaveLength(8);
    expect(Object.keys(r.current.data.ssp)).toEqual(["ssp126", "ssp245", "ssp585"]);
    expect(r.current.data.ssp.ssp585[4].p95).toBeGreaterThan(r.current.data.ssp.ssp585[4].p05);
    expect(renderHook(() => useCellTimeline(null, "day")).current.status).toBe("idle");
  });

  it("useSeries / useFrameStats / useGuardedCopy expose the bundle numbers", async () => {
    const s = renderHook(() => useSeries("z:3", "night"));
    await waitFor(() => expect(s.current.status).toBe("ready"));
    expect(s.current.data.scope).toBe("z:night:3");
    expect(renderHook(() => useSeries("d:99", "day")).current.status).not.toBe("ready");
    const stats = renderHook(() => useFrameStats());
    await waitFor(() => expect(stats.current.status).toBe("ready"));
    expect(stats.current.data.uhi).toBeLessThan(0);
    act(() => useTimeStore.getState().setYear(2037));
    await waitFor(() => expect(stats.current.data.year).toBe(2037));
    expect(stats.current.data.interpolated).toBe(true);
    const copy = renderHook(() => useGuardedCopy("uhi_night"));
    await waitFor(() => expect(copy.current.status).toBe("ready"));
    expect(copy.current.guardPassed).toBe(true);
    expect(copy.current.text).toMatch(/at night/);
  });

  it("useDomain is fixed across years by default, shared/stretched on request", async () => {
    const d = renderHook(() => useDomain("day", "abs"));
    const fixed = d.current.data.domain;
    act(() => useTimeStore.getState().setYear(1990));
    expect(d.current.data.domain).toEqual(fixed);
    act(() => useTimeStore.getState().setYear(2050));
    expect(d.current.data.domain).toEqual(fixed);
    act(() => useViewStore.getState().setDomainMode("shared"));
    const night = store.getState().timeline.domains.night.abs;
    expect(d.current.data.domain).toEqual([Math.min(fixed[0], night[0]), Math.max(fixed[1], night[1])]);
    act(() => {
      useViewStore.getState().setDomainMode("frame");
      useTimeStore.getState().setYear(2025);
    });
    await waitFor(() => expect(d.current.data.stretched).toBe(true));
    expect(d.current.data.fixed).toEqual(fixed);
  });

  it("useXai / useRaster: lazy frames with reasons when absent", async () => {
    const x = renderHook(() => useXai(2005, "night"));
    await waitFor(() => expect(x.current.status).toBe("ready"));
    expect(x.current.data.tier).toBe("observed");
    const proj = renderHook(() => useXai(2050, "day"));
    await waitFor(() => expect(proj.current.status).toBe("unavailable"));
    expect(proj.current.reason).toMatch(/no day drivers/);
    const raster = renderHook(() => useRaster("night_2020", { preview: true }));
    await waitFor(() => expect(raster.current.status).toBe("ready"));
    expect(raster.current.data).toMatchObject({ preview: true, downscaled: true });
    expect(raster.current.data.values.length).toBe(raster.current.data.width * raster.current.data.height);
  });
});
