/**
 * Main-thread client for thumbnail rendering.
 *
 * Uses the module worker (thumbWorker.js + OffscreenCanvas) when the browser supports both;
 * otherwise (older Safari, tests) rasterises on the main thread into an ImageBitmap (or a
 * canvas when createImageBitmap is missing). Results are cached by key in a small LRU; the
 * bitmaps are closed when evicted (GPU/CPU memory is released, not left to GC).
 */
import { rasterizeCells } from "./thumbRaster.js";

const CACHE_LIMIT = 64;

function canUseWorker() {
  return typeof Worker === "function" && typeof OffscreenCanvas === "function" && typeof ImageData === "function";
}

/** Render one RGBA buffer to a drawable (ImageBitmap | HTMLCanvasElement) on the main thread. */
async function renderMain(grid, rgba) {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = grid.width;
  canvas.height = grid.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.putImageData(new ImageData(rgba, grid.width, grid.height), 0, 0);
  if (typeof createImageBitmap === "function") {
    try {
      return await createImageBitmap(canvas);
    } catch {
      return canvas;
    }
  }
  return canvas;
}

export function createThumbRenderer() {
  let worker = null;
  let failed = false;
  let nextId = 1;
  const pending = new Map();
  const sentGrids = new Set();
  const cache = new Map();
  // Grids are identified by the caller's key AND the grid object: after a bundle switch the same
  // key ("atlas") names another grid, which must be re-sent and never matched to old bitmaps.
  const gridIds = new WeakMap();
  let nextGridId = 1;
  const wireKeyOf = (job) => {
    let gid = gridIds.get(job.grid);
    if (!gid) {
      gid = nextGridId;
      nextGridId += 1;
      gridIds.set(job.grid, gid);
    }
    return `${job.gridKey}#${gid}`;
  };

  const ensureWorker = () => {
    if (worker || failed || !canUseWorker()) return worker;
    try {
      worker = new Worker(new URL("./thumbWorker.js", import.meta.url), { type: "module", name: "lst-thumbs" });
      worker.onmessage = (event) => {
        const p = pending.get(event.data?.id);
        if (!p) return;
        pending.delete(event.data.id);
        if (event.data.missingGrid) p.resend();
        else if (event.data.error) p.reject(new Error(event.data.error));
        else p.resolve(event.data.bitmap);
      };
      worker.onerror = (event) => {
        event?.preventDefault?.();
        failed = true;
        worker?.terminate();
        worker = null;
        sentGrids.clear();
        for (const p of pending.values()) p.retry();
        pending.clear();
      };
    } catch {
      failed = true;
      worker = null;
    }
    return worker;
  };

  const remember = (key, bitmap) => {
    cache.set(key, bitmap);
    while (cache.size > CACHE_LIMIT) {
      const [oldKey, old] = cache.entries().next().value;
      cache.delete(oldKey);
      old?.close?.();
    }
    return bitmap;
  };

  /**
   * @param {string} key cache key (e.g. "day:obs:2025:solar:38:50")
   * @param {{gridKey: string, grid: {width, height, pixel}, values: Float32Array, lut: Uint8Array,
   *          lo: number, hi: number, mask?: Uint8Array|null}} job
   * @returns {Promise<ImageBitmap|HTMLCanvasElement|null>}
   */
  /** Post one render to the worker (sending its grid first when the worker lacks it). */
  function postRender(w, wireKey, job, main, attempt = 0) {
    if (!sentGrids.has(wireKey)) {
      w.postMessage({ type: "grid", key: wireKey, width: job.grid.width, height: job.grid.height, pixel: job.grid.pixel });
      sentGrids.add(wireKey);
    }
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      pending.set(id, {
        resolve,
        reject,
        retry: () => main().then(resolve, reject),
        // The worker keeps only a few grids and reports an evicted one: re-send it and try again
        // (once; then the main-thread path).
        resend: () => {
          sentGrids.delete(wireKey);
          const again = attempt < 1 && worker ? postRender(worker, wireKey, job, main, attempt + 1) : main();
          again.then(resolve, reject);
        },
      });
      // Copy the values so the cube's decoded frame stays usable on the main thread.
      const values = Float32Array.from(job.values);
      w.postMessage({ type: "render", id, gridKey: wireKey, values, lut: job.lut, lo: job.lo, hi: job.hi, mask: job.mask ?? null }, [values.buffer]);
    });
  }

  function render(key, job) {
    const wireKey = wireKeyOf(job);
    const cacheKey = `${wireKey}|${key}`;
    if (cache.has(cacheKey)) {
      const hit = cache.get(cacheKey);
      cache.delete(cacheKey);
      cache.set(cacheKey, hit);
      return Promise.resolve(hit);
    }
    const main = () => renderMain(job.grid, rasterizeCells({ ...job.grid, values: job.values, lut: job.lut, lo: job.lo, hi: job.hi, mask: job.mask ?? null })).then((b) => remember(cacheKey, b));
    const w = ensureWorker();
    if (!w) return main();
    return postRender(w, wireKey, job, main).then((bitmap) => remember(cacheKey, bitmap));
  }

  function dispose() {
    worker?.terminate();
    worker = null;
    for (const b of cache.values()) b?.close?.();
    cache.clear();
    pending.clear();
    sentGrids.clear();
  }

  return { render, dispose };
}

let shared = null;
/** App-wide renderer (one worker for every atlas / AOA mini map). */
export function sharedThumbRenderer() {
  shared ??= createThumbRenderer();
  return shared;
}
