/**
 * Atlas thumbnail worker (UI_SPEC §3.5 "worker-rasterised ImageBitmaps"): rasterises cube
 * frames to RGBA on an OffscreenCanvas and transfers an ImageBitmap back, so 26 thumbnails
 * never block the main thread.
 *
 * Protocol
 *   {type: "grid", key, width, height, pixel}                 cache a cell -> pixel index
 *   {type: "render", id, gridKey, values, lut, lo, hi, mask?}  -> {id, bitmap} | {id, error}
 *                                                                 | {id, missingGrid: key} (evicted: re-send it)
 */
import { rasterizeCells } from "./thumbRaster.js";

const grids = new Map();

self.onmessage = (event) => {
  const msg = event.data ?? {};
  if (msg.type === "grid") {
    grids.set(msg.key, { width: msg.width, height: msg.height, pixel: msg.pixel });
    if (grids.size > 4) grids.delete(grids.keys().next().value);
    return;
  }
  if (msg.type !== "render") return;
  if (!grids.has(msg.gridKey)) {
    // Only the last few grids are kept: the client re-sends an evicted one and retries.
    self.postMessage({ id: msg.id, missingGrid: msg.gridKey });
    return;
  }
  try {
    const grid = grids.get(msg.gridKey);
    const rgba = rasterizeCells({ ...grid, values: msg.values, lut: msg.lut, lo: msg.lo, hi: msg.hi, mask: msg.mask ?? null });
    const canvas = new OffscreenCanvas(grid.width, grid.height);
    const ctx = canvas.getContext("2d");
    ctx.putImageData(new ImageData(rgba, grid.width, grid.height), 0, 0);
    const bitmap = canvas.transferToImageBitmap();
    self.postMessage({ id: msg.id, bitmap }, [bitmap]);
  } catch (error) {
    self.postMessage({ id: msg.id, error: String(error?.message ?? error) });
  }
};
