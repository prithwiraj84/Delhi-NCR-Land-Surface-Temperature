/**
 * Thumbnail rasteriser core (pure; shared by thumbWorker.js and the main-thread fallback).
 *
 * Each canonical cell becomes one pixel of a W×H RGBA image at its grid (row, col); the image
 * is scaled up with nearest-neighbour sampling when drawn, so a 1 km cell stays a crisp square.
 * Colour = exact LUT colour of the value on the FIXED domain (UI_SPEC D4 — thumbnails of
 * different years are comparable); NaN / nodata pixels stay transparent. An optional mask
 * (Uint8Array, 1 = keep) dims the other cells (used for AOA-outside maps).
 */

/**
 * Pixel index (row * W + col) of every cell in an image of at most `maxSize` px per side.
 * Uses the grid rows/cols when known; otherwise bins lon/lat (v1 bundles whose grid width
 * could not be inferred).
 * @param {{n: number, row?: Int16Array, col?: Int16Array, lon?: ArrayLike<number>, lat?: ArrayLike<number>,
 *          grid?: {width?: number|null, height?: number|null}}} cells
 * @returns {{width: number, height: number, pixel: Int32Array}}
 */
export function cellPixels(cells, maxSize = 160) {
  const n = cells?.n ?? 0;
  const W = Number(cells?.grid?.width);
  const H = Number(cells?.grid?.height);
  const hasGrid = Number.isInteger(W) && W > 0 && Number.isInteger(H) && H > 0 && cells.row && cells.col && cells.row[0] >= 0;
  const pixel = new Int32Array(n);
  if (hasGrid) {
    for (let i = 0; i < n; i += 1) pixel[i] = cells.row[i] * W + cells.col[i];
    return { width: W, height: H, pixel };
  }
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const lo = cells.lon[i];
    const la = cells.lat[i];
    if (lo < x0) x0 = lo;
    if (lo > x1) x1 = lo;
    if (la < y0) y0 = la;
    if (la > y1) y1 = la;
  }
  const aspect = (x1 - x0) / Math.max(1e-9, y1 - y0);
  const w = Math.max(8, Math.round(aspect >= 1 ? maxSize : maxSize * aspect));
  const h = Math.max(8, Math.round(aspect >= 1 ? maxSize / aspect : maxSize));
  for (let i = 0; i < n; i += 1) {
    const c = Math.min(w - 1, Math.floor(((cells.lon[i] - x0) / Math.max(1e-9, x1 - x0)) * w));
    const r = Math.min(h - 1, Math.floor(((y1 - cells.lat[i]) / Math.max(1e-9, y1 - y0)) * h));
    pixel[i] = r * w + c;
  }
  return { width: w, height: h, pixel };
}

/**
 * RGBA pixels of one frame.
 * @param {{width: number, height: number, pixel: Int32Array, values: ArrayLike<number>,
 *          lut: Uint8Array, lo: number, hi: number, mask?: Uint8Array|null}} input
 *   lut = 256 × RGB bytes (design/ramps.js LUTS[name])
 * @returns {Uint8ClampedArray}
 */
export function rasterizeCells({ width, height, pixel, values, lut, lo, hi, mask = null }) {
  const out = new Uint8ClampedArray(width * height * 4);
  const span = hi - lo || 1e-9;
  const n = Math.min(pixel.length, values.length);
  for (let i = 0; i < n; i += 1) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const t = Math.max(0, Math.min(1, (v - lo) / span));
    const k = Math.round(t * 255) * 3;
    const o = pixel[i] * 4;
    out[o] = lut[k];
    out[o + 1] = lut[k + 1];
    out[o + 2] = lut[k + 2];
    out[o + 3] = mask && !mask[i] ? 70 : 255;
  }
  return out;
}
