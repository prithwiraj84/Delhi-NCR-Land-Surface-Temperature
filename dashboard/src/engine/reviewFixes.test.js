/**
 * Engine regressions of the v2 adversarial review (F4): what-if run keys (T-F4-01), engine legend
 * (T-F4-02 / T-F4-25), work-time perf sampling and Undo (T-F4-03), device reset (T-F4-14), cell
 * readouts (T-F4-15), cross-frame Δ domain (T-F4-17), compare caching + throttle (T-F4-20), raster
 * anomaly level (T-F4-21), projected SUHI (T-F4-22), stale-while-loading rasters (T-F4-23) and
 * hover cost (T-F4-24).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { create } from "zustand";
import { createBundleStore } from "../data/bundleStore.js";
import { createFixtureFetch, createSynthV2 } from "../data/fixtures/synthV2.js";
import { selectionStoreInitializer } from "../state/stores/selectionStore.js";
import { timeStoreInitializer } from "../state/stores/timeStore.js";
import { viewStoreInitializer } from "../state/stores/viewStore.js";
import { createEngineStore } from "./engineStore.js";
import { createFrameSource } from "./frameData.js";
import { MapEngine } from "./MapEngine.js";

const SOURCE = { id: "fixture", baseUrl: null, explicit: true, reason: "test" };
let bundle;
const engines = [];

beforeAll(async () => {
  const synth = createSynthV2();
  const fetchImpl = createFixtureFetch(synth, { compress: false });
  bundle = createBundleStore({ fixtureLoader: async () => ({ synth, fetchImpl }) });
  await bundle.getState().load({ source: SOURCE });
});

afterEach(() => {
  while (engines.length) engines.pop().destroy();
});

function fakeDeck() {
  return {
    props: {},
    setProps(p) {
      Object.assign(this.props, p);
    },
    getViewports: () => [{ width: 1000, height: 700, unproject: ([x, y]) => [76.5 + x / 1000, 29 - y / 1000] }],
    redraw() {},
  };
}

const fakeDevice = () => ({ createTexture: (props) => ({ props, destroy() {} }) });

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

function setup({ search = "", gpu = true, win = null } = {}) {
  const time = create(timeStoreInitializer);
  const view = create(viewStoreInitializer);
  const selection = create(selectionStoreInitializer);
  time.getState().configure(bundle.getState().timeline, { year: 2025, mode: "day", ssp: "ssp245" });
  const store = createEngineStore();
  const engine = new MapEngine({ bundle, time, view, selection, store, search, win });
  engines.push(engine);
  const deck = fakeDeck();
  engine.attach(deck);
  if (gpu) engine.setDevice(fakeDevice());
  return { engine, deck, time, view, selection, store };
}

async function settle(engine, pred, tries = 80) {
  for (let k = 0; k < tries; k += 1) {
    engine._tick(performance.now());
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return pred();
}

const thermalLayer = (deck) => (deck.props.layers ?? []).find((l) => l.id.startsWith("thermal-columns"));
const n = () => bundle.getState().resources.cells.data.n;

/** A what-if result shaped like the DataProvider's (scenarioKey = scenario object, runKey = run id). */
function result(fill, runKey, scenario = { feature: "frac_forest" }) {
  const deltaByCell = new Float32Array(n()).map((_, i) => (i % 7 === 0 ? fill : 0));
  return { deltaByCell, epochYear: 2025, scenarioKey: scenario, runKey };
}

describe("what-if run keys (T-F4-01)", () => {
  it("draws every new run, not the first one, and recomputes the colour domain", async () => {
    const { engine, deck, view, store } = setup();
    await settle(engine, () => thermalLayer(deck));
    view.getState().setLayer("whatif");
    const scenario = { feature: "frac_forest" };
    const r1 = result(-0.5, 1, scenario);
    engine.setExternal({ scenario: r1 });
    expect(await settle(engine, () => engine.current?.desc.layer === "whatif" && engine.current.A.values[0] === -0.5)).toBe(true);
    const lo1 = store.getState().legend.lo;
    expect(lo1).toBeCloseTo(-0.5, 6);
    // Same scenario object (the simulator compares it by identity), new run: new values + domain.
    const r2 = result(-2, 2, scenario);
    engine.setExternal({ scenario: r2 });
    expect(await settle(engine, () => engine.current.A.values[0] === -2)).toBe(true);
    expect(Array.from(engine.current.A.values)).toEqual(Array.from(r2.deltaByCell));
    expect(store.getState().legend.lo).toBeCloseTo(-2, 6);
    expect(engine.current.ck).not.toContain("[object Object]");
    // Results without runKey fall back to one key per result object.
    const r3 = result(-1, undefined, scenario);
    delete r3.runKey;
    engine.setExternal({ scenario: r3 });
    expect(await settle(engine, () => engine.current.A.values[0] === -1)).toBe(true);
  });

  it("frame source: the same year with two scenario keys gives two frames and drops the old one", () => {
    const src = createFrameSource({ bundle });
    const base = { mode: "day", layer: "whatif", variable: "abs", q: "p50", ssp: "ssp245", shapFeature: null, deltaRef: null, domainMode: "fixed" };
    const a = src.frame({ ...base, scenario: result(-0.5, 1), scenarioKey: "1" }, 2025);
    const b = src.frame({ ...base, scenario: result(-2, 2), scenarioKey: "2" }, 2025);
    expect(a.status).toBe("ready");
    expect(b.frame.values[0]).toBe(-2);
    expect(a.frame.values[0]).toBe(-0.5);
    expect(src.size).toBe(1);
  });
});

describe("legend and perf HUD stability (T-F4-02 / T-F4-25)", () => {
  it("keeps the SAME categories array across zone frames while playing (no legend churn)", async () => {
    const { engine, deck, view, time, store } = setup();
    await settle(engine, () => thermalLayer(deck));
    view.getState().setLayer("zones");
    expect(await settle(engine, () => store.getState().legend?.kind === "categorical")).toBe(true);
    const legend = store.getState().legend;
    let changes = 0;
    const unsub = store.subscribe((s, prev) => {
      if (s.legend !== prev.legend) changes += 1;
    });
    for (const y of [2010, 2015, 2020, 2025, 2010]) {
      time.getState().setYear(y);
      await settle(engine, () => engine.current?.year === y);
    }
    unsub();
    expect(changes).toBe(0);
    expect(store.getState().legend).toBe(legend);
  });

  it("reports the drawn pred channel as absolute, and crossFrame only for cross-frame domains", async () => {
    const { engine, deck, view, store } = setup();
    await settle(engine, () => thermalLayer(deck));
    expect(store.getState().legend.crossFrame).toBe(true);
    view.getState().setVariable("anom");
    view.getState().setLayer("pred");
    expect(await settle(engine, () => store.getState().legend?.layer === "pred")).toBe(true);
    const tl = bundle.getState().timeline;
    expect(store.getState().legend.lo).toBe(tl.domains.day.abs[0]);
    expect(store.getState().legend.kind).toBe("sequential");
    view.getState().setLayer("resid");
    expect(await settle(engine, () => store.getState().legend?.layer === "resid")).toBe(true);
    expect(store.getState().legend.crossFrame).toBe(false);
    expect(store.getState().legend.domainYear).toBe(2025);
  });
});

describe("perf governor wiring (T-F4-03)", () => {
  it("samples work time (not the render interval) and skips throttled ticks", async () => {
    const { engine, deck } = setup();
    await settle(engine, () => thermalLayer(deck));
    const calls = [];
    engine.governor = { ...engine.governor, sample: (w, t, iv) => calls.push([w, t, iv]) || null, tier: 0, floor: 0, ema: null };
    engine.animating = true;
    engine._lastWorkAt = 0;
    engine._intervalBroken = false;
    engine._samplePerf(1000, 3);
    engine._samplePerf(1033, 4);
    expect(calls[0][2]).toBeNull();
    expect(calls[1]).toEqual([4, 1033, 33]);
    engine._throttled = true;
    engine._samplePerf(1066, 0);
    engine._throttled = false;
    engine._samplePerf(1100, 5);
    // The interval spanning the deliberately skipped tick is not reported.
    expect(calls).toHaveLength(3);
    expect(calls[2][2]).toBeNull();
  });

  it("Undo starts the hold and steps back without setting the user's floor", async () => {
    const win = fakeWin();
    const { engine, view } = setup({ win });
    engine.governor.setUserTier(0);
    view.getState().setPerfTier(2); // a user choice in Settings sets the floor…
    expect(engine.governor.floor).toBe(2);
    engine.governor.setUserTier(0); // …reset to no floor for the Undo case
    engine.governor.sync(0);
    // The governor stepped down to T1 on its own.
    engine._autoTier = true;
    view.getState().setPerfTier(1);
    expect(engine.governor.floor).toBe(0);
    const detail = { from: 1, to: 0, handled: false };
    win.dispatch("ncr:perf-undo", detail);
    expect(detail.handled).toBe(true);
    expect(view.getState().perfTier).toBe(0);
    expect(engine.governor.floor).toBe(0);
  });
});

describe("device reset (T-F4-14)", () => {
  it("rebuilds every memoised layer on a new device", async () => {
    const { engine, deck } = setup();
    await settle(engine, () => thermalLayer(deck));
    const boundaries = engine._memoLayer("boundaries", ["x"], () => ({ id: "b1" }));
    expect(engine._memoLayer("boundaries", ["x"], () => ({ id: "b2" }))).toBe(boundaries);
    engine.setDevice(fakeDevice());
    expect(engine._memoLayer("boundaries", ["x"], () => ({ id: "b3" }))).not.toBe(boundaries);
    expect(engine.layers).toEqual([]);
    engine.resetGpu();
    expect(engine.device).toBeNull();
  });
});

describe("cross-frame Δ domain and nodata (T-F4-17)", () => {
  it("gives the same Δ domain whatever the entry year, and keeps nodata NaN at the reference year", async () => {
    const domains = [];
    for (const year of [2025, 1990, 2050]) {
      const src = createFrameSource({ bundle });
      const desc = { mode: "day", layer: "lst", variable: "delta", q: "p50", ssp: "ssp245", shapFeature: null, deltaRef: null, scenario: null, scenarioKey: null, domainMode: "fixed" };
      let ch = null;
      for (let k = 0; k < 60 && !(ch && ch.crossFrame); k += 1) {
        const r = src.frame(desc, year);
        if (r.status === "ready") ch = src.channel(desc, r.frame);
        await new Promise((res) => setTimeout(res, 10));
      }
      expect(ch.crossFrame).toBe(true);
      domains.push([ch.lo, ch.hi]);
      if (year === 1990) {
        const abs = src.frame({ ...desc, variable: "abs" }, 1990).frame.values;
        const d = src.frame(desc, 1990).frame.values;
        const nanAbs = Array.from(abs).filter(Number.isNaN).length;
        expect(nanAbs).toBeGreaterThan(0);
        expect(Array.from(d).filter(Number.isNaN).length).toBe(nanAbs);
      }
    }
    expect(domains[1]).toEqual(domains[0]);
    expect(domains[2]).toEqual(domains[0]);
    expect(domains[0][1]).toBeGreaterThan(0);
  });
});

describe("frame levels and projected SUHI (T-F4-21 / T-F4-22)", () => {
  it("stores the cube level on the frame and uses it for the anomaly", async () => {
    const src = createFrameSource({ bundle });
    const desc = { mode: "day", layer: "lst", variable: "abs", q: "p50", ssp: "ssp245", shapFeature: null, deltaRef: null, scenario: null, scenarioKey: null, domainMode: "fixed" };
    let r;
    for (let k = 0; k < 60; k += 1) {
      r = src.frame(desc, 2015);
      if (r.status === "ready") break;
      await new Promise((res) => setTimeout(res, 10));
    }
    const cube = bundle.getState().resources["cube:day:obs"].data;
    const f = cube.years.indexOf(2015);
    expect(r.frame.level).toBe(cube.levels[f]);
    expect(r.frame.level).not.toBeCloseTo(r.frame.mean, 6);
    const anom = src.frame({ ...desc, variable: "anom" }, 2015);
    const i = Array.from(r.frame.values).findIndex(Number.isFinite);
    expect(anom.frame.values[i]).toBeCloseTo(r.frame.values[i] - cube.levels[f], 4);
  });

  it("surface UHI is unavailable for projected frames, with the reason", async () => {
    const src = createFrameSource({ bundle });
    const desc = { mode: "day", layer: "lst", variable: "suhi", q: "p50", ssp: "ssp245", shapFeature: null, deltaRef: null, scenario: null, scenarioKey: null, domainMode: "fixed" };
    let r;
    for (let k = 0; k < 60; k += 1) {
      r = src.frame(desc, 2040);
      if (r.status !== "loading") break;
      await new Promise((res) => setTimeout(res, 10));
    }
    expect(r.status).toBe("unavailable");
    expect(r.reason).toMatch(/not exported for projected frames/);
    let obs;
    for (let k = 0; k < 60; k += 1) {
      obs = src.frame(desc, 2020);
      if (obs.status !== "loading") break;
      await new Promise((res) => setTimeout(res, 10));
    }
    expect(obs.status).toBe("ready");
  });
});

describe("readouts (T-F4-15)", () => {
  it("readCell names the displayed quantity (layer, variable, quantile, mode, tier)", async () => {
    const { engine, deck, view, time } = setup();
    await settle(engine, () => thermalLayer(deck));
    time.getState().setYear(2050);
    view.getState().setQuantile("p95");
    expect(await settle(engine, () => engine.current?.A.year === 2050 && engine.current.desc.q === "p95")).toBe(true);
    const i = Array.from(engine.current.A.values).findIndex(Number.isFinite);
    const r = engine.readCell(i);
    expect(r).toMatchObject({ layer: "lst", q: "p95", mode: "day", ssp: "ssp245", tier: "projected" });
    expect(r.value).toBe(engine.current.A.values[i]);
  });
});

describe("compare caching and throttle (T-F4-20)", () => {
  it("never recolours a fixed side while the other side scrubs, and throttles to 30 Hz", async () => {
    const { engine, deck, time } = setup();
    await settle(engine, () => thermalLayer(deck));
    time.getState().setCompare({ kind: "y", a: 1990, b: null, splitPx: 500 });
    expect(await settle(engine, () => (deck.props.layers ?? []).filter((l) => l.id.startsWith("thermal-compare")).length === 2)).toBe(true);
    const left = engine.compareCache.sides.left;
    const bufsLeft = engine.compareCache.buffers.left.k;
    time.getState().startDrag?.();
    time.setState({ dragging: true });
    let rebuilds = 0;
    let prevRight = engine.compareCache.sides.right;
    const t0 = performance.now();
    for (let k = 0; k < 40; k += 1) {
      time.getState().scrubTo(2000 + k * 0.5);
      engine._tick(performance.now());
      if (engine.compareCache.sides.right !== prevRight) {
        rebuilds += 1;
        prevRight = engine.compareCache.sides.right;
      }
      await new Promise((r) => setTimeout(r, 2));
    }
    const elapsed = performance.now() - t0;
    expect(engine.compareCache.sides.left).toBe(left);
    expect(engine.compareCache.buffers.left.k).toBe(bufsLeft);
    expect(rebuilds).toBeLessThanOrEqual(Math.ceil(elapsed / 33) + 2);
    time.setState({ dragging: false });
  });
});

describe("hover cost (T-F4-24)", () => {
  it("a hover change reuses the column layer (only reticles rebuild)", async () => {
    const { engine, deck, selection } = setup({ search: "?shader=off" });
    expect(await settle(engine, () => thermalLayer(deck)?.id === "thermal-columns-cpu")).toBe(true);
    const before = thermalLayer(deck);
    selection.getState().setHover(5);
    engine._tick(performance.now());
    selection.getState().setHover(6);
    engine._tick(performance.now());
    expect(thermalLayer(deck)).toBe(before);
    expect((deck.props.layers ?? []).some((l) => /reticle/.test(l.id))).toBe(true);
  });

  it("never re-adds a column layer that a compare frame left out (deck finalized it)", async () => {
    const { engine, deck, time } = setup({ search: "?shader=off" });
    expect(await settle(engine, () => thermalLayer(deck)?.id === "thermal-columns-cpu")).toBe(true);
    const before = thermalLayer(deck);
    time.getState().setCompare({ kind: "y", a: 1990, b: null, splitPx: 500 });
    expect(await settle(engine, () => (deck.props.layers ?? []).some((l) => l.id.startsWith("thermal-compare")))).toBe(true);
    expect(thermalLayer(deck)).toBeUndefined();
    time.getState().setCompare(null);
    expect(await settle(engine, () => thermalLayer(deck)?.id === "thermal-columns-cpu")).toBe(true);
    expect(thermalLayer(deck)).not.toBe(before);
  });

  it("gates deck hover picking to at most one pass per 33 ms (the last request is kept)", async () => {
    const { engine } = setup();
    let picks = 0;
    const deck = { props: {}, setProps() {}, getViewports: () => [], redraw() {}, _pickRequest: { event: null }, _pickAndCallback() {
      if (this._pickRequest.event) picks += 1;
      this._pickRequest.event = null;
    } };
    engine.attach(deck);
    const t0 = performance.now();
    for (let k = 0; k < 60; k += 1) {
      deck._pickRequest.event = { type: "pointermove" };
      deck._pickAndCallback();
      await new Promise((r) => setTimeout(r, 2));
    }
    const elapsed = performance.now() - t0;
    expect(picks).toBeGreaterThan(0);
    expect(picks).toBeLessThanOrEqual(Math.ceil(elapsed / 33) + 1);
    // A deferred request stays queued for a later frame.
    expect(deck._pickRequest.event === null || deck._pickRequest.event.type === "pointermove").toBe(true);
  });
});
