/**
 * Data-layer regressions of the v2 review fixes (F4): exact pure-JS raster decoding (T-F4-19),
 * the unsupported-browser boot state (T-F4-29), lazy facade-epoch statistics (T-F4-04) and the
 * spill-over box-mean snapping (T-F4-27).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBundleStore, UNSUPPORTED_BROWSER_MESSAGE } from "../bundleStore.js";
import { decodePngRgb, decodeRasterBytes, splitChannels } from "../rasters.js";
import { runWorkerOp } from "../workerOps.js";
import { encodePngRgb } from "../fixtures/png.js";
import { v1EpochFromXai } from "../xai.js";
import { boxMeanSat, buildGridIndex } from "../../lib/scenario.js";
import { PUBLIC_DEMO_DIR } from "../../lib/__tests__/testUtils.js";
import checksums from "../__fixtures__/demo_raster_checksums.json";

const sha1 = (bytes) => createHash("sha1").update(bytes).digest("hex");

function testPng(w = 37, h = 23) {
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i += 1) {
    rgb[i * 3] = (i * 7) % 256;
    rgb[i * 3 + 1] = (i * 13) % 8;
  }
  return { bytes: encodePngRgb(w, h, rgb), rgb, w, h };
}

describe("raster decoding is the exact pure-JS decoder (T-F4-19)", () => {
  const saved = {};
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  });

  it("ignores canvas readback even when it is available and perturbed (no ImageBitmap)", async () => {
    const { bytes, rgb, w, h } = testPng();
    // A canvas path whose getImageData flips low bits (anti-fingerprinting noise) must not be used.
    saved.createImageBitmap = globalThis.createImageBitmap;
    saved.OffscreenCanvas = globalThis.OffscreenCanvas;
    let used = false;
    globalThis.createImageBitmap = async () => {
      used = true;
      return { width: w, height: h, close() {} };
    };
    globalThis.OffscreenCanvas = class {
      getContext() {
        return {
          drawImage() {},
          getImageData: () => {
            used = true;
            const data = new Uint8ClampedArray(w * h * 4);
            for (let i = 0; i < w * h; i += 1) {
              data[i * 4] = rgb[i * 3] ^ 1;
              data[i * 4 + 1] = rgb[i * 3 + 1] ^ 2;
            }
            return { data };
          },
        };
      }
    };
    const fetchImpl = async () => new Response(bytes, { status: 200, headers: { "content-type": "image/png" } });
    const { result, transfer } = await runWorkerOp("raster", { url: "/x.png" }, { fetchImpl });
    const ref = await decodePngRgb(bytes);
    const exact = splitChannels(ref.data, ref.width, ref.height, ref.channels);
    expect(used).toBe(false);
    expect(result.bitmap).toBeUndefined();
    expect(Array.from(result.values)).toEqual(Array.from(exact.values));
    expect(Array.from(result.flags)).toEqual(Array.from(exact.flags));
    expect(transfer).toHaveLength(2);
  });

  const demoDir = path.join(PUBLIC_DEMO_DIR, "raster");
  const files = fs.existsSync(demoDir) ? Object.keys(checksums.files).filter((f) => fs.existsSync(path.join(demoDir, f))) : [];
  it.skipIf(!files.length)("decodes every demo raster to the same R/G bytes as Pillow", async () => {
    let compared = 0;
    for (const f of files) {
      const bytes = new Uint8Array(fs.readFileSync(path.join(demoDir, f)));
      const ref = checksums.files[f];
      // A stale fixture must fail loudly (it would otherwise compare nothing): after the demo
      // bundle is regenerated, run `python dashboard/scripts/raster_checksums.py`.
      expect(sha1(bytes), `${f}: checksum fixture is stale - rerun dashboard/scripts/raster_checksums.py`).toBe(ref.file_sha1);
      const dec = await decodeRasterBytes(bytes);
      expect([dec.width, dec.height]).toEqual([ref.width, ref.height]);
      expect(sha1(dec.values)).toBe(ref.r_sha1);
      expect(sha1(dec.flags)).toBe(ref.g_sha1);
      compared += 1;
    }
    expect(compared).toBe(files.length);
    expect(compared).toBeGreaterThan(0);
  });
});

describe("unsupported browser (T-F4-29)", () => {
  it("ends the boot in an explicit unsupported state when DecompressionStream is missing", async () => {
    const saved = globalThis.DecompressionStream;
    delete globalThis.DecompressionStream;
    try {
      const store = createBundleStore({ fixtureLoader: async () => ({ synth: null, fetchImpl: async () => new Response("{}") }) });
      await store.getState().load({ source: { id: "fixture", baseUrl: null, explicit: true, reason: "t" } });
      expect(store.getState().status).toBe("error");
      expect(store.getState().error).toMatchObject({ status: "unsupported", message: UNSUPPORTED_BROWSER_MESSAGE });
      expect(UNSUPPORTED_BROWSER_MESSAGE).toMatch(/Chrome\/Edge 80\+, Firefox 113\+ or Safari 16\.4\+/);
    } finally {
      globalThis.DecompressionStream = saved;
    }
  });
});

describe("lazy facade-epoch statistics (T-F4-04)", () => {
  it("builds a 55k-cell epoch without sorting; stats are computed on first read", () => {
    const n = 55000;
    const cells = { n, cell_id: Int32Array.from({ length: n }, (_, i) => i * 2), lon64: new Float64Array(n), lat64: new Float64Array(n), district: new Int16Array(n) };
    const col = () => Float32Array.from({ length: n }, (_, i) => Math.sin(i) * 3);
    const groups = Array.from({ length: 18 }, (_, k) => `g${k}`);
    const xai = { n, year: 2025, mode: "day", level: 40, baseValueC: 40, groups, shap: Object.fromEntries(groups.map((g) => [g, col()])), features: Object.fromEntries(groups.map((g) => [g, col()])), obs: col(), pred: col(), oof: col(), resid: col(), tier: "observed" };
    const sorts = { n: 0 };
    const orig = Float64Array.prototype.sort;
    Float64Array.prototype.sort = function patched(...args) {
      sorts.n += 1;
      return orig.apply(this, args);
    };
    let epoch;
    try {
      epoch = v1EpochFromXai(xai, { cells, groupsMeta: groups.map((g) => ({ id: g, primary: g })) });
      expect(sorts.n).toBe(0); // nothing is sorted until a statistic is read
      // Next epochs of the same cells reuse the cell index: well under one frame budget.
      const t0 = performance.now();
      const again = v1EpochFromXai(xai, { cells, groupsMeta: [] });
      expect(performance.now() - t0).toBeLessThan(20);
      expect(again.index).toBe(epoch.index);
    } finally {
      Float64Array.prototype.sort = orig;
    }
    const s = epoch.stats.lst_obs;
    expect(s.count).toBe(n);
    expect(s.p98).toBeGreaterThan(2.9);
    expect(epoch.stats.shapMaxAbs.g0).toBeGreaterThan(2.9);
    expect(epoch.stats.lst_obs).toBe(s); // cached
  });
});

describe("spill-over box means snap to zero (T-F4-27)", () => {
  it("an all-zero window gives exactly 0 even after a large change elsewhere", () => {
    const W = 40;
    const H = 30;
    const ids = Int32Array.from({ length: W * H }, (_, i) => i);
    const grid = buildGridIndex(ids, W, H);
    const v = new Float32Array(W * H);
    for (let i = 0; i < 40; i += 1) v[i] = 0.7 + i * 1e-3;
    const out = boxMeanSat(grid, v, 3);
    expect(out[W * H - 1]).toBe(0);
    expect(out[(H - 5) * W + 20]).toBe(0);
  });
});
