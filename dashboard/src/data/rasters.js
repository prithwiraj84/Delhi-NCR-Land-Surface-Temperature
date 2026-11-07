/**
 * 250 m / 500 m thermal rasters (SPEC §4.8, §5.2; UI_SPEC §6.3).
 *
 * Each raster is an 8-bit RGB PNG on a regular EPSG:4326 grid covering `raster_index.bounds`:
 *   R = 0 nodata, else value = lo + (R − 1) · (hi − lo) / 254   (fixed per-mode lo/hi)
 *   G = flags (bit0 outside AOA, bits1–2 tier code: 0 observed, 1 sparse/reconstructed,
 *       2 modelled, 3 downscaled),  B = 0.
 *
 * Decoding happens in the data worker with the pure-JS `decodePngRgb` (8-bit non-interlaced
 * RGB/RGBA/grey PNGs, the format the notebook writes): exact bytes by construction, with no canvas
 * readback (colour management, premultiplication or anti-fingerprinting noise can alter
 * getImageData) and no ImageBitmap (D22 d). The CPU keeps one `Uint8Array` per channel for hover
 * readouts (MapEngine.readRaster) and the engine builds its texture from `values`/`flags`.
 *
 * Memory: an LRU of 8 decoded rasters (≈ 58 MB VRAM worst case at 250 m); the engine drops a
 * texture as soon as its resource leaves the LRU.
 */

import { inflateBytes } from "./fetch.js";
import { bytesStream } from "./lstb.js";

export const RASTER_LRU_CAPACITY = 8;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Raster key used by the index and the cache: "<mode>_<year>". */
export const rasterKey = (mode, year) => `${mode}_${year}`;

/** Resource key of a raster in the BundleStore ("raster:<mode>_<year>[:preview]"). */
export const rasterResourceKey = (key, preview = false) => `raster:${key}${preview ? ":preview" : ""}`;

/**
 * Normalise `raster_index.json`.
 * @returns {{crs, bounds:[W,S,E,N], width, height, preview:{width,height}|null, domains, frames: Object}}
 * @throws {Error} on a non-EPSG:4326 index or malformed bounds
 */
export function normalizeRasterIndex(raw) {
  if (!raw || typeof raw !== "object") throw new Error("raster_index.json is not an object");
  if (raw.crs && raw.crs !== "EPSG:4326") throw new Error(`raster_index.crs must be EPSG:4326 (got ${raw.crs})`);
  const b = raw.bounds;
  if (!Array.isArray(b) || b.length !== 4 || !b.every((v) => Number.isFinite(Number(v))) || !(b[2] > b[0] && b[3] > b[1])) {
    throw new Error("raster_index.bounds must be [W, S, E, N] with E > W and N > S");
  }
  const frames = {};
  for (const [key, f] of Object.entries(raw.frames ?? {})) {
    if (!f || typeof f.file !== "string") continue;
    frames[key] = {
      key,
      file: f.file,
      preview: typeof f.preview === "string" ? f.preview : null,
      lo: Number(f.lo),
      hi: Number(f.hi),
      tier: f.tier ?? null,
      downscaled: Boolean(f.downscaled),
    };
  }
  return {
    crs: "EPSG:4326",
    bounds: b.map(Number),
    width: Number(raw.width),
    height: Number(raw.height),
    preview: raw.preview && Number(raw.preview.width) > 0 ? { width: Number(raw.preview.width), height: Number(raw.preview.height) } : null,
    domains: raw.domains ?? null,
    frames,
  };
}

/**
 * Index entry for a raster key, or a reason why it is unavailable.
 * @returns {{entry: object|null, reason: string|null}}
 */
export function rasterEntry(index, key, { preview = false } = {}) {
  if (!index) return { entry: null, reason: "this bundle has no 250 m rasters" };
  const entry = index.frames[key];
  if (!entry) {
    const [mode, year] = String(key).split("_");
    return { entry: null, reason: `${year ?? key}: ${mode ?? ""} not downscaled`.replace(/\s+/g, " ").trim() };
  }
  if (preview && !entry.preview) return { entry: null, reason: `${key}: no 500 m preview` };
  return { entry, reason: null };
}

/** Physical value of an R byte (NaN for 0 = nodata). */
export function decodeRasterByte(r, lo, hi) {
  if (!r) return NaN;
  return lo + ((r - 1) * (hi - lo)) / 254;
}

/** Pixel of a lon/lat on the raster grid, or null outside the bounds. */
export function lonLatToPixel(raster, lon, lat) {
  const [W, S, E, N] = raster.bounds;
  if (!(lon >= W && lon < E && lat > S && lat <= N)) return null;
  const px = Math.min(raster.width - 1, Math.floor(((lon - W) / (E - W)) * raster.width));
  const py = Math.min(raster.height - 1, Math.floor(((N - lat) / (N - S)) * raster.height));
  return { px, py, i: py * raster.width + px };
}

/**
 * CPU hover readout (UI_SPEC §6.3): value (°C, NaN for nodata) and flags at a lon/lat.
 * @returns {{value:number, flags:number, outsideAoa:boolean, tierCode:number, px:number, py:number}|null}
 */
export function rasterValueAt(raster, lon, lat) {
  if (!raster?.values) return null;
  const p = lonLatToPixel(raster, lon, lat);
  if (!p) return null;
  const r = raster.values[p.i];
  const flags = raster.flags ? raster.flags[p.i] : 0;
  return {
    value: decodeRasterByte(r, raster.lo, raster.hi),
    flags,
    outsideAoa: Boolean(flags & 1),
    tierCode: (flags >> 1) & 3,
    px: p.px,
    py: p.py,
  };
}

/**
 * Min / max of the raster values inside a lon/lat box (e.g. one 1 km cell: "250 m: 40.1–43.0 °C
 * within this cell" in the inspector). Returns null when no valid pixel falls inside.
 */
export function rasterRangeInBox(raster, [west, south, east, north]) {
  if (!raster?.values) return null;
  const a = lonLatToPixel(raster, Math.max(west, raster.bounds[0]), Math.min(north, raster.bounds[3]));
  const b = lonLatToPixel(raster, Math.min(east, raster.bounds[2] - 1e-9), Math.max(south, raster.bounds[1] + 1e-9));
  if (!a || !b) return null;
  let lo = Infinity;
  let hi = -Infinity;
  let count = 0;
  for (let y = a.py; y <= b.py; y += 1) {
    for (let x = a.px; x <= b.px; x += 1) {
      const v = decodeRasterByte(raster.values[y * raster.width + x], raster.lo, raster.hi);
      if (Number.isNaN(v)) continue;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
      count += 1;
    }
  }
  return count ? { min: lo, max: hi, count } : null;
}

/** Split interleaved pixel bytes (RGBA or RGB) into R (values) and G (flags). */
export function splitChannels(pixels, width, height, stride = 4) {
  const n = width * height;
  const values = new Uint8Array(n);
  const flags = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i += 1, j += stride) {
    values[i] = pixels[j];
    flags[i] = pixels[j + 1];
  }
  return { values, flags };
}

// ---------------------------------------------------------------------------------------
// Pure-JS PNG decoder (the only raster path; exact bytes, no colour management)
// ---------------------------------------------------------------------------------------

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Inflate zlib-wrapped deflate data (PNG IDAT) with DecompressionStream("deflate"). */
async function inflateZlib(bytes) {
  if (typeof DecompressionStream !== "function") throw new Error("DecompressionStream is unavailable");
  const stream = bytesStream(bytes).pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Decode an 8-bit, non-interlaced PNG (grey, grey+alpha, RGB, RGBA) to interleaved bytes.
 * @returns {Promise<{width:number, height:number, channels:number, data:Uint8Array}>}
 */
export async function decodePngRgb(input) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  if (!PNG_SIGNATURE.every((b, i) => bytes[i] === b)) throw new Error("not a PNG file (bad signature)");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  while (pos + 8 <= bytes.length) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(pos + 8);
      height = view.getUint32(pos + 12);
      const bitDepth = bytes[pos + 16];
      const colorType = bytes[pos + 17];
      const interlace = bytes[pos + 20];
      if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth} (expected 8)`);
      if (interlace !== 0) throw new Error("interlaced PNGs are not supported");
      channels = CHANNELS[colorType];
      if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + length;
  }
  if (!width || !height || !idat.length) throw new Error("PNG has no IHDR/IDAT data");
  const joined = new Uint8Array(idat.reduce((s, c) => s + c.length, 0));
  let at = 0;
  for (const c of idat) {
    joined.set(c, at);
    at += c.length;
  }
  const raw = await inflateZlib(joined);
  const stride = width * channels;
  if (raw.length < height * (stride + 1)) throw new Error("PNG image data is truncated");
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? out[dst + x - channels] : 0;
      const b = y > 0 ? out[dst - stride + x] : 0;
      const c = x >= channels && y > 0 ? out[dst - stride + x - channels] : 0;
      const v = raw[src + x];
      let r;
      switch (filter) {
        case 0:
          r = v;
          break;
        case 1:
          r = v + a;
          break;
        case 2:
          r = v + b;
          break;
        case 3:
          r = v + ((a + b) >> 1);
          break;
        case 4:
          r = v + paeth(a, b, c);
          break;
        default:
          throw new Error(`invalid PNG filter type ${filter} on row ${y}`);
      }
      out[dst + x] = r & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/**
 * Decode raster file bytes off the GPU path: PNG (possibly gzip-wrapped) → {values, flags}.
 * Used by the data worker (opRaster) and by tests.
 */
export async function decodeRasterBytes(bytes) {
  const png = await decodePngRgb(await inflateBytes(bytes));
  return { width: png.width, height: png.height, ...splitChannels(png.data, png.width, png.height, png.channels) };
}

// ---------------------------------------------------------------------------------------
// LRU cache
// ---------------------------------------------------------------------------------------

/**
 * Release memory held by a decoded raster. Rasters carry plain typed arrays (no ImageBitmap since
 * D22 d), released by GC; a legacy `bitmap` field (null or absent) is still closed if present.
 */
export function disposeRaster(raster) {
  try {
    raster?.bitmap?.close?.();
  } catch (_error) {
    // A transferred or already-closed bitmap throws; nothing else to release.
  }
}

/**
 * Small LRU (Map insertion order). `onEvict(key, value)` runs for entries pushed out by capacity
 * or removed with `delete`/`clear`.
 */
export function createLru(capacity = RASTER_LRU_CAPACITY, onEvict = null) {
  const map = new Map();
  const evict = (key, value) => {
    try {
      onEvict?.(key, value);
    } catch (error) {
      console.warn("[rasters] eviction callback failed", error);
    }
  };
  return {
    get capacity() {
      return capacity;
    },
    get size() {
      return map.size;
    },
    has: (key) => map.has(key),
    keys: () => [...map.keys()],
    /** Read and mark as most recently used. */
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
      return value;
    },
    /** Insert / replace; returns the keys evicted to respect the capacity. */
    set(key, value) {
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      const evicted = [];
      while (map.size > capacity) {
        const oldest = map.keys().next().value;
        const old = map.get(oldest);
        map.delete(oldest);
        evicted.push(oldest);
        evict(oldest, old);
      }
      return evicted;
    },
    delete(key) {
      if (!map.has(key)) return false;
      const value = map.get(key);
      map.delete(key);
      evict(key, value);
      return true;
    },
    clear() {
      for (const [key, value] of map) evict(key, value);
      map.clear();
    },
  };
}
