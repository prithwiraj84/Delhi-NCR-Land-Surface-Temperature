/**
 * H3 aggregation (Analyst ▸ H3 hexagons): resolution choice, the cell -> hexagon index built with
 * the real h3-js, mean / mode aggregation (NaN and nodata codes skipped) and the engine swapping
 * the prisms for the hexagon layer with the same LUT colours.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { latLngToCell } from "h3-js";
import { create } from "zustand";
import { createBundleStore } from "../data/bundleStore.js";
import { createFixtureFetch, createSynthV2 } from "../data/fixtures/synthV2.js";
import { selectionStoreInitializer } from "../state/stores/selectionStore.js";
import { timeStoreInitializer } from "../state/stores/timeStore.js";
import { viewStoreInitializer } from "../state/stores/viewStore.js";
import { createEngineStore } from "./engineStore.js";
import { buildHexIndex, h3ResolutionFor, hexMeans, hexModes } from "./layers/h3.js";
import { MapEngine } from "./MapEngine.js";

describe("H3 aggregation helpers", () => {
  it("picks the smallest resolution whose hexagon covers at least ~4 cells", () => {
    expect(h3ResolutionFor(1000)).toBe(7); // 5.2 km² >= 4 km²
    expect(h3ResolutionFor(250)).toBe(8);
    expect(h3ResolutionFor(2000)).toBe(6); // 36 km² >= 16 km²
    expect(h3ResolutionFor(5400)).toBe(5);
    expect(h3ResolutionFor(undefined)).toBe(7);
  });

  it("indexes cells with real h3-js and skips cells without coordinates", () => {
    const cells = { n: 4, lon: Float64Array.of(77.2, 77.2001, 77.9, NaN), lat: Float64Array.of(28.6, 28.6001, 28.1, 28.5) };
    const idx = buildHexIndex(cells, 7, latLngToCell);
    expect(idx.cellHex[0]).toBe(idx.cellHex[1]); // ~15 m apart: same res-7 hexagon
    expect(idx.cellHex[2]).not.toBe(idx.cellHex[0]);
    expect(idx.cellHex[3]).toBe(-1);
    expect(idx.hexIds).toHaveLength(2);
    expect(idx.data.map((d) => d.i)).toEqual([0, 1]);
    expect(idx.hexIds[0]).toBe(latLngToCell(28.6, 77.2, 7));
  });

  it("averages finite values and takes the modal category per hexagon", () => {
    const cellHex = Int32Array.of(0, 0, 0, 1, 1, -1, 2);
    const means = hexMeans(Float32Array.of(30, 32, NaN, 40, 41, 99, NaN), cellHex, 3);
    expect(means[0]).toBeCloseTo(31, 6);
    expect(means[1]).toBeCloseTo(40.5, 6);
    expect(Number.isNaN(means[2])).toBe(true);
    const modes = hexModes(Int16Array.of(2, 2, 1, 0, -1, 1, 7), cellHex, 3, 3);
    expect(Array.from(modes)).toEqual([2, 0, -1]); // code 7 is outside the palette -> nodata
  });
});

describe("MapEngine with the analyst H3 toggle", () => {
  let bundle;
  const engines = [];
  beforeAll(async () => {
    const synth = createSynthV2();
    bundle = createBundleStore({ fixtureLoader: async () => ({ synth, fetchImpl: createFixtureFetch(synth, { compress: false }) }) });
    await bundle.getState().load({ source: { id: "fixture", baseUrl: null, explicit: true, reason: "test" } });
  });
  afterEach(() => {
    while (engines.length) engines.pop().destroy();
  });

  it("replaces the prisms by hexagons coloured with the same LUT, and restores them when off", async () => {
    const time = create(timeStoreInitializer);
    const view = create(viewStoreInitializer);
    const selection = create(selectionStoreInitializer);
    time.getState().configure(bundle.getState().timeline, { year: 2025, mode: "day", ssp: "ssp245" });
    const engine = new MapEngine({ bundle, time, view, selection, store: createEngineStore(), search: "?shader=off", win: null });
    engines.push(engine);
    const deck = { props: {}, setProps(p) { Object.assign(this.props, p); }, getViewports: () => [], redraw() {} };
    engine.attach(deck);
    const find = (prefix) => (deck.props.layers ?? []).find((l) => l.id.startsWith(prefix));
    const settle = async (pred) => {
      for (let k = 0; k < 200; k += 1) {
        engine._tick(performance.now());
        if (pred()) return true;
        await new Promise((r) => setTimeout(r, 10));
      }
      return pred();
    };
    expect(await settle(() => Boolean(find("thermal-columns")))).toBe(true);

    view.getState().setAnalyst({ h3: true });
    expect(await settle(() => Boolean(find("thermal-h3")))).toBe(true);
    expect(find("thermal-columns")).toBeUndefined();
    const hex = find("thermal-h3");
    const { index, colors } = engine.h3;
    expect(hex.props.data).toBe(index.data);
    expect(index.hexIds.length).toBeGreaterThan(10);
    // Every hexagon that aggregates at least one finite cell is opaque; colours come from the LUT.
    const opaque = index.hexIds.filter((_, h) => colors[h * 4 + 3] === 255).length;
    expect(opaque).toBeGreaterThan(index.hexIds.length * 0.8);
    const version = engine.h3.version;
    engine._tick(performance.now());
    expect(engine.h3.version).toBe(version); // paused: no re-aggregation per frame

    view.getState().setAnalyst({ h3: false });
    expect(await settle(() => Boolean(find("thermal-columns")) && !find("thermal-h3"))).toBe(true);
  }, 60000);
});
