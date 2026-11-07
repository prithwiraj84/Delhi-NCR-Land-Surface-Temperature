/**
 * Data-worker operations, written once and run either inside `dataWorker.js` (preferred: keeps
 * gzip inflation and image decoding off the main thread) or inline on the main thread (tests,
 * fixtures served from memory, browsers where a module worker cannot start).
 *
 * Every op returns `{result, transfer}`: `transfer` lists the ArrayBuffers to move
 * (zero-copy) to the main thread.
 *
 *   inflate {url}            fetch -> gunzip if gzip -> ArrayBuffer (LSTB / JSON payloads)
 *   inflateBytes {buffer}    gunzip bytes already fetched (fixture fetch on the main thread)
 *   raster {url}             fetch -> pure-JS PNG decode (exact bytes) -> {values, flags, width,
 *                            height}; no canvas readback, no ImageBitmap (D22 d)
 */

import { fetchBytes, inflateBytes } from "./fetch.js";
import { decodeRasterBytes } from "./rasters.js";

/** An ArrayBuffer that holds exactly these bytes (copy only when the view is partial). */
function exactBuffer(bytes) {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) return bytes.buffer;
  return bytes.slice().buffer;
}

async function opInflate({ url }, ctx) {
  const { bytes } = await fetchBytes(url, { fetchImpl: ctx.fetchImpl, onProgress: ctx.onProgress, binary: true });
  const inflated = await inflateBytes(bytes, url);
  const buffer = exactBuffer(inflated);
  return { result: { buffer, compressedBytes: bytes.byteLength, bytes: buffer.byteLength }, transfer: [buffer] };
}

async function opInflateBytes({ buffer, url }) {
  const inflated = await inflateBytes(new Uint8Array(buffer), url);
  const out = exactBuffer(inflated);
  return { result: { buffer: out, compressedBytes: buffer.byteLength, bytes: out.byteLength }, transfer: [out] };
}

/**
 * Raster PNG -> {values, flags, width, height}. Always the pure-JS decoder (D22 d): its bytes are
 * exact by construction, while a createImageBitmap -> OffscreenCanvas -> getImageData readback can
 * be altered by colour management, premultiplication or canvas fingerprinting protection (which
 * randomises low bits) in some browsers. No ImageBitmap is created, so nothing idle is kept on the
 * GPU process; the engine builds its texture from `values` / `flags`.
 */
async function opRaster({ url, bytes: givenBytes = null }, ctx) {
  let bytes = givenBytes ? new Uint8Array(givenBytes) : null;
  if (!bytes) bytes = (await fetchBytes(url, { fetchImpl: ctx.fetchImpl, onProgress: ctx.onProgress, binary: true })).bytes;
  bytes = await inflateBytes(bytes, url);
  const decoded = await decodeRasterBytes(bytes);
  return { result: { ...decoded, compressedBytes: bytes.byteLength }, transfer: [decoded.values.buffer, decoded.flags.buffer] };
}

const OPS = Object.freeze({ inflate: opInflate, inflateBytes: opInflateBytes, raster: opRaster });

/**
 * Run one op.
 * @param {string} op
 * @param {object} args
 * @param {{fetchImpl?: Function, onProgress?: Function}} ctx
 */
export async function runWorkerOp(op, args, ctx = {}) {
  const fn = OPS[op];
  if (!fn) throw new Error(`unknown data-worker op "${op}"`);
  return fn(args ?? {}, { fetchImpl: ctx.fetchImpl ?? globalThis.fetch, onProgress: ctx.onProgress ?? null });
}

/** Serialise an Error (DataLoadError fields included) for postMessage. */
export function serializeError(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    status: error?.status ?? "error",
    url: error?.url ?? null,
    httpStatus: error?.httpStatus ?? null,
  };
}
