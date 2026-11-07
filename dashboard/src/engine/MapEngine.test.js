import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { create } from "zustand";
import { createBundleStore } from "../data/bundleStore.js";
import { createFixtureFetch, createSynthV2 } from "../data/fixtures/synthV2.js";
import { selectionStoreInitializer } from "../state/stores/selectionStore.js";
import { timeStoreInitializer } from "../state/stores/timeStore.js";
import { viewStoreInitializer } from "../state/stores/viewStore.js";
import { createEngineStore } from "./engineStore.js";
import { MapEngine, zoomElevationFactor } from "./MapEngine.js";
import { SHAPES } from "./mixFrame.js";

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

/** Run engine frames until `pred()` holds (resources load asynchronously). */
async function settle(engine, pred, tries = 60) {
  for (let k = 0; k < tries; k += 1) {
    engine._tick(performance.now());
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return pred();
}

const thermalLayer = (deck) => (deck.props.layers ?? []).find((l) => l.id.startsWith("thermal-columns"));

describe("MapEngine", () => {
  it("draws the GPU slot path and keeps slots bound while scrubbing inside one bracket", async () => {
    const { engine, deck, time, store } = setup();
    expect(await settle(engine, () => thermalLayer(deck)?.id === "thermal-columns-gpu")).toBe(true);
    expect(store.getState().path).toBe("gpu");
    time.getState().scrubTo(2016);
    await settle(engine, () => thermalLayer(deck).props.thermal.shape[0] > 0);
    const l1 = thermalLayer(deck);
    const a1 = l1.props.data.attributes.getValueA;
    const b1 = l1.props.data.attributes.getValueB;
    expect(l1.props.thermal.shape[0]).toBeCloseTo(0.2, 6);
    time.getState().scrubTo(2018.5);
    engine._tick(performance.now());
    const l2 = thermalLayer(deck);
    expect(l2.props.data.attributes.getValueA).toBe(a1);
    expect(l2.props.data.attributes.getValueB).toBe(b1);
    expect(l2.props.thermal.shape[0]).toBeCloseTo(0.7, 6);
    expect(l2.props.getElevation).toBe(0);
    // Crossing into the next bracket rebinds: the old B slot becomes the new A slot.
    time.getState().scrubTo(2021);
    await settle(engine, () => thermalLayer(deck).props.data.attributes.getValueA === b1);
    expect(thermalLayer(deck).props.data.attributes.getValueA).toBe(b1);
  });

  it("crosses NOW into the projection cube and fogs projected cells via VSUP aux codes", async () => {
    const { engine, deck, time } = setup();
    time.getState().scrubTo(2027.5);
    expect(await settle(engine, () => thermalLayer(deck)?.props.thermal.shape[0] === 0.5)).toBe(true);
    const aux = thermalLayer(deck).props.data.attributes.getThermalAux.value;
    let projected = 0;
    for (let i = 1; i < aux.length; i += 4) if (aux[i] > 0) projected += 1;
    expect(projected).toBeGreaterThan(0);
    expect(aux[0]).toBe(0);
  });

  it("runs the Day → Night switch as an east→west sweep with a colour cross-fade", async () => {
    const { engine, deck, time } = setup();
    await settle(engine, () => thermalLayer(deck));
    time.getState().setMode("night");
    await settle(engine, () => thermalLayer(deck)?.props.thermal.shape[3] === SHAPES.sweep);
    const l = thermalLayer(deck);
    expect(l.props.thermal.shape[3]).toBe(SHAPES.sweep);
    expect(l.props.thermal.lonRange[2]).toBe(0);
    expect(l.props.thermal.slotA[3]).not.toBe(l.props.thermal.slotB[3]);
    // After 700 ms the sweep ends on the night ramp with a plain value mix.
    await new Promise((r) => setTimeout(r, 750));
    engine._tick(performance.now());
    const done = thermalLayer(deck);
    expect(done.props.thermal.shape[3]).toBe(SHAPES.fade);
    expect(done.props.thermal.lonRange[2]).toBe(1);
  });

  it("falls back to the CPU colour path with ?shader=off (binary colours + heights)", async () => {
    const { engine, deck, store } = setup({ search: "?shader=off" });
    expect(await settle(engine, () => thermalLayer(deck)?.id === "thermal-columns-cpu")).toBe(true);
    const attrs = thermalLayer(deck).props.data.attributes;
    expect(attrs.getFillColor.value).toBeInstanceOf(Uint8Array);
    expect(attrs.getElevation.value).toBeInstanceOf(Float32Array);
    expect(store.getState().pathReason).toBe("?shader=off");
    expect(store.getState().legend).toMatchObject({ layer: "lst", ramp: "solar", kind: "sequential" });
  });

  it("renders categorical layers on the CPU path with a categorical legend", async () => {
    const { engine, deck, view, store } = setup();
    await settle(engine, () => thermalLayer(deck));
    view.getState().setLayer("zones");
    expect(await settle(engine, () => store.getState().legend?.kind === "categorical")).toBe(true);
    expect(thermalLayer(deck).id).toBe("thermal-columns-cpu");
    expect(store.getState().legend.categories).toHaveLength(4);
  });

  it("splits compare into two CPU instances with ScreenSplitExtension", async () => {
    const { engine, deck, time, store } = setup();
    await settle(engine, () => thermalLayer(deck));
    time.getState().setCompare({ kind: "y", a: 1990, b: 2050, splitPx: 400 });
    expect(await settle(engine, () => (deck.props.layers ?? []).filter((l) => l.id.startsWith("thermal-compare")).length === 2)).toBe(true);
    const [left, right] = deck.props.layers.filter((l) => l.id.startsWith("thermal-compare"));
    expect(left.props.splitSide).toBe("left");
    expect(right.props.splitSide).toBe("right");
    expect(left.props.splitX).toBeCloseTo(0.4, 6);
    expect(store.getState().compare.on).toBe(true);
  });

  it("reports an unavailable layer instead of drawing stale data", async () => {
    const { engine, deck, time, view, store } = setup();
    await settle(engine, () => thermalLayer(deck));
    view.getState().setLayer("resid");
    time.getState().setYear(2040);
    expect(await settle(engine, () => store.getState().status === "unavailable")).toBe(true);
    expect(store.getState().reason).toMatch(/XAI/);
    expect(thermalLayer(deck)).toBeUndefined();
  });

  it("probes the hottest cell, pins it and reads it back", async () => {
    const { engine, deck, selection } = setup();
    await settle(engine, () => thermalLayer(deck));
    const index = engine.probeHottest();
    expect(selection.getState().pinnedIndex).toBe(index);
    const r = engine.readCell(index);
    expect(r.kind).toBe("continuous");
    expect(Number.isFinite(r.value)).toBe(true);
    const all = engine.current.A.values;
    expect(Array.from(all).filter(Number.isFinite).every((v) => v <= r.value)).toBe(true);
  });

  it("answers ncr:probe-hottest only when no view claimed it (no double pin / announcement)", async () => {
    const win = new EventTarget();
    const { engine, deck, selection } = setup({ win });
    await settle(engine, () => thermalLayer(deck));
    const macrotask = () => new Promise((r) => setTimeout(r, 5));
    const hottest = () => {
      const v = engine._mixedValues(engine.current);
      let best = -1;
      for (let i = 0; i < v.length; i += 1) if (best < 0 || v[i] > v[best]) best = i;
      return best;
    };

    // Unclaimed (Control route not mounted yet): the engine is the fallback handler.
    win.dispatchEvent(new CustomEvent("ncr:probe-hottest", { detail: {} }));
    expect(selection.getState().pinnedIndex).toBeNull();
    await macrotask();
    expect(selection.getState().pinnedIndex).toBe(hottest());

    // Claimed by a view's probe fly-to in the same dispatch: the engine stays out of it.
    selection.getState().pin(3);
    win.addEventListener("ncr:probe-hottest", function view() {
      win.dispatchEvent(new CustomEvent("ncr:fly-to", { detail: { cellIndex: 3, source: "probe-hottest" } }));
      win.removeEventListener("ncr:probe-hottest", view);
    });
    win.dispatchEvent(new CustomEvent("ncr:probe-hottest", { detail: {} }));
    await macrotask();
    expect(selection.getState().pinnedIndex).toBe(3);

    // Claimed explicitly with detail.handled (e.g. the view announced "still loading").
    win.dispatchEvent(new CustomEvent("ncr:probe-hottest", { detail: { handled: true } }));
    await macrotask();
    expect(selection.getState().pinnedIndex).toBe(3);
  });

  it("damps relief beyond the home zoom (v1 factor)", () => {
    expect(zoomElevationFactor(7.7)).toBe(1);
    expect(zoomElevationFactor(6)).toBe(1);
    expect(zoomElevationFactor(9.7)).toBeCloseTo(2 ** -1.7, 6);
    expect(zoomElevationFactor(30)).toBe(0.03);
  });
});
