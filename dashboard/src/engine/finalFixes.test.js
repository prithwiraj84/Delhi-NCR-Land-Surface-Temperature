/**
 * Engine regressions closed by the final fix pass of the v2 review: the legend says when the
 * selected content is unavailable (T-F4-02 / T-F4-22), compare sides pick up the cross-frame Δ
 * channel once it exists (T-F4-17 / T-F4-20), provisional channels keep one identity per frame,
 * and PerfChip Undo after a user-chosen tier is a defined action (T-F4-03).
 */
import { afterEach, describe, expect, it } from "vitest";
import { create } from "zustand";
import { createBundleStore } from "../data/bundleStore.js";
import { createFixtureFetch, createSynthV2 } from "../data/fixtures/synthV2.js";
import { selectionStoreInitializer } from "../state/stores/selectionStore.js";
import { timeStoreInitializer } from "../state/stores/timeStore.js";
import { viewStoreInitializer } from "../state/stores/viewStore.js";
import { legendFromEngine, legendSpec } from "../views/control/layerModel.js";
import { createEngineStore } from "./engineStore.js";
import { createFrameSource } from "./frameData.js";
import { MapEngine } from "./MapEngine.js";

const SOURCE = { id: "fixture", baseUrl: null, explicit: true, reason: "test" };
const engines = [];

afterEach(() => {
  while (engines.length) engines.pop().destroy();
});

/** A fixture bundle; `slowSsp` delays the SSP cubes so the cross-frame Δ domain is pending first. */
async function makeBundle({ slowSsp = false } = {}) {
  const synth = createSynthV2();
  const fetchImpl = createFixtureFetch(synth, { compress: false });
  const slow = async (url, opts) => {
    if (slowSsp && /cube/.test(String(url)) && /ssp/.test(String(url))) await new Promise((r) => setTimeout(r, 300));
    return fetchImpl(url, opts);
  };
  const bundle = createBundleStore({ fixtureLoader: async () => ({ synth, fetchImpl: slow }) });
  await bundle.getState().load({ source: SOURCE });
  return bundle;
}

function fakeWin() {
  const listeners = {};
  return {
    innerWidth: 1000,
    innerHeight: 700,
    addEventListener: (type, fn) => ((listeners[type] ??= []).push(fn)),
    removeEventListener: (type, fn) => (listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn)),
    dispatch: (type, detail) => (listeners[type] ?? []).forEach((fn) => fn({ detail })),
  };
}

function setup(bundle, { year = 2025, win = null } = {}) {
  const time = create(timeStoreInitializer);
  const view = create(viewStoreInitializer);
  const selection = create(selectionStoreInitializer);
  time.getState().configure(bundle.getState().timeline, { year, mode: "day", ssp: "ssp245" });
  const store = createEngineStore();
  const engine = new MapEngine({ bundle, time, view, selection, store, search: "", win });
  engines.push(engine);
  const deck = {
    props: {},
    setProps(p) {
      Object.assign(this.props, p);
    },
    getViewports: () => [{ width: 1000, height: 700, unproject: ([x, y]) => [76.5 + x / 1000, 29 - y / 1000] }],
    redraw() {},
  };
  engine.attach(deck);
  engine.setDevice({ createTexture: (props) => ({ props, destroy() {} }) });
  return { engine, time, view, store };
}

async function settle(engine, pred, tries = 120) {
  for (let k = 0; k < tries; k += 1) {
    engine._tick(performance.now());
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return pred();
}

describe("legend of unavailable content (T-F4-02 / T-F4-22)", () => {
  it("surface UHI at a projected year: the engine legend carries the reason, no scale", async () => {
    const bundle = await makeBundle();
    const { engine, view, store } = setup(bundle, { year: 2050 });
    view.getState().setVariable("suhi");
    await settle(engine, () => store.getState().status === "unavailable");
    const L = store.getState().legend;
    expect(L.kind).toBe("unavailable");
    expect(L.ramp).toBeNull();
    expect(L.note).toMatch(/not exported for projected frames/);
    // merged into the view's legend spec: no domain, no "fixed all frames" claim, the reason as note
    const base = legendSpec({ layer: "lst", variable: "suhi", mode: "day", domainMode: "fixed", domain: [-6, 6], timeline: bundle.getState().timeline });
    const spec = legendFromEngine(base, L, { layer: "lst", mode: "day", variable: "suhi" });
    expect(spec.kind).toBe("unavailable");
    expect(spec.domain).toBeNull();
    expect(spec.fixed).toBe(false);
    expect(spec.note).toMatch(/not exported for projected frames/);
  });
});

describe("compare + Δ channel (T-F4-17 / T-F4-20)", () => {
  it("a side first coloured with the provisional Δ scale is rebuilt with the cross-frame one", async () => {
    const bundle = await makeBundle({ slowSsp: true });
    const { engine, view, time, store } = setup(bundle, { year: 2020 });
    await settle(engine, () => store.getState().status === "ready");
    view.getState().setVariable("delta");
    time.getState().setCompare({ kind: "y", a: 1990, b: null, splitPx: 500 });
    await settle(engine, () => Boolean(engine.compareCache.sides?.right?.display), 20);
    const ok = await settle(engine, () => {
      const side = engine.compareCache.sides?.right;
      return Boolean(side?.display?.channel?.crossFrame) && bundle.getState().resources["cube:day:ssp245"]?.status === "ready";
    }, 200);
    expect(ok).toBe(true);
    const side = engine.compareCache.sides.right;
    const L = store.getState().legend;
    expect(side.display.channel.crossFrame).toBe(true);
    expect([side.display.channel.lo, side.display.channel.hi]).toEqual([L.lo, L.hi]);
    expect(side.display.channel).toBe(engine.frames.cachedChannel(side.display.desc));
  });
});

describe("provisional channels keep their identity (T-F4-24)", () => {
  it("a stretched channel of the same frame is the same object on every call", async () => {
    const bundle = await makeBundle();
    const src = createFrameSource({ bundle });
    const desc = { mode: "day", layer: "lst", variable: "abs", q: "p50", ssp: "ssp245", shapFeature: null, deltaRef: null, scenario: null, scenarioKey: null, domainMode: "frame" };
    let r;
    for (let k = 0; k < 60; k += 1) {
      r = src.frame(desc, 2020);
      if (r.status !== "loading") break;
      await new Promise((res) => setTimeout(res, 10));
    }
    expect(r.status).toBe("ready");
    const a = src.channel(desc, r.frame);
    const b = src.channel(desc, r.frame);
    expect(a.stretched).toBe(true);
    expect(b).toBe(a);
    expect(src.cachedChannel(desc)).toBeNull();
  });
});

describe("PerfChip Undo after a user-chosen tier (T-F4-03)", () => {
  it("is left to the chip, which writes the store as a new user choice (floor lowered)", async () => {
    const bundle = await makeBundle();
    const win = fakeWin();
    const { engine, view } = setup(bundle, { win });
    view.getState().setPerfTier(3); // Settings / palette "Performance mode"
    expect(engine.governor.floor).toBe(3);
    const detail = { from: 3, to: 0, handled: false };
    win.dispatch("ncr:perf-undo", detail);
    expect(detail.handled).toBe(false);
    // PerfChip's fallback when unhandled
    view.getState().setPerfTier(detail.to);
    expect(view.getState().perfTier).toBe(0);
    expect(engine.governor.tier).toBe(0);
    expect(engine.governor.floor).toBe(0);
  });
});
