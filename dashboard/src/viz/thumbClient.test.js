/**
 * Thumbnail client <-> worker protocol (viz/thumbClient.js): a new grid under the same key (another
 * bundle) is re-sent and never served old bitmaps, and a grid the worker evicted is re-sent.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createThumbRenderer } from "./thumbClient.js";

/** Fake module worker: keeps ONE grid (eviction is the norm here), answers like thumbWorker.js. */
class FakeWorker {
  static last = null;
  constructor() {
    this.grids = new Map();
    this.messages = [];
    FakeWorker.last = this;
  }
  postMessage(msg) {
    this.messages.push(msg);
    queueMicrotask(() => {
      if (msg.type === "grid") {
        this.grids.clear();
        this.grids.set(msg.key, msg);
        return;
      }
      const grid = this.grids.get(msg.gridKey);
      this.onmessage?.({ data: grid ? { id: msg.id, bitmap: { grid: msg.gridKey, width: grid.width, v0: msg.values[0] } } : { id: msg.id, missingGrid: msg.gridKey } });
    });
  }
  terminate() {}
}

const saved = {};
beforeEach(() => {
  for (const k of ["Worker", "OffscreenCanvas", "ImageData"]) saved[k] = globalThis[k];
  globalThis.Worker = FakeWorker;
  globalThis.OffscreenCanvas = class {};
  globalThis.ImageData = class {};
});
afterEach(() => {
  for (const k of Object.keys(saved)) globalThis[k] = saved[k];
});

const grid = (width) => ({ width, height: 2, pixel: Int32Array.from([0, 1]) });
const job = (g, v, gridKey = "atlas") => ({ gridKey, grid: g, values: Float32Array.from([v, v]), lut: new Uint8Array(768), lo: 0, hi: 1 });

describe("thumbClient", () => {
  it("re-sends a new grid under the same key and never serves the old grid's bitmap", async () => {
    const r = createThumbRenderer();
    const a = await r.render("day-obs-2025", job(grid(4), 1));
    expect(a).toMatchObject({ width: 4, v0: 1 });
    // Bundle switch: same gridKey and item key, another grid object.
    const b = await r.render("day-obs-2025", job(grid(6), 2));
    expect(b).toMatchObject({ width: 6, v0: 2 });
    expect(FakeWorker.last.messages.filter((m) => m.type === "grid")).toHaveLength(2);
    // Same grid object again: served from the cache.
    const g = grid(8);
    const c1 = await r.render("k", job(g, 3));
    const c2 = await r.render("k", job(g, 3));
    expect(c2).toBe(c1);
  });

  it("re-sends a grid the worker evicted and retries the render", async () => {
    const r = createThumbRenderer();
    const atlas = grid(4);
    await r.render("a1", job(atlas, 1, "atlas"));
    await r.render("x1", job(grid(5), 1, "aoa")); // evicts "atlas" in the fake worker
    const again = await r.render("a2", job(atlas, 7, "atlas"));
    expect(again).toMatchObject({ width: 4, v0: 7 });
    const kinds = FakeWorker.last.messages.map((m) => m.type);
    expect(kinds.filter((k) => k === "grid")).toHaveLength(3); // atlas, aoa, atlas again
  });
});
