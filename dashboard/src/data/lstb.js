/**
 * LSTB binary container (SPEC §5.1): reader, frame decoders and a Python-compatible writer.
 *
 * Layout (all little-endian), usually wrapped in gzip on disk (`*.lstb.gz`):
 *
 *   "LSTB" | u8 version=1 | u8[3] reserved=0 | u32le header_len | header (UTF-8 JSON)
 *   | zero padding to an 8-byte boundary (relative to file start) | data section
 *
 *   header = {kind, n, meta, columns: [{name, dtype, shape, scale, offset, nodata,
 *                                       byte_offset (from data start, multiple of 8), byte_length}]}
 *   value  = raw * scale + offset;  raw == nodata -> NaN;  multi-dim shapes are row-major ([frames, n]).
 *
 * Engineering notes
 * - Columns are exposed as zero-copy typed-array VIEWS into the inflated buffer. Views need the
 *   absolute byte offset to be a multiple of the element size; the format guarantees 8-byte
 *   alignment relative to the file start, so a buffer that starts at byte 0 of its ArrayBuffer is
 *   always aligned. A Uint8Array that is a sub-view at an odd offset (possible after some
 *   transports) is copied once into a fresh buffer instead of failing.
 * - Readers detect gzip by the magic bytes (0x1f 0x8b) and accept already-inflated payloads
 *   (a server that sent `Content-Encoding: gzip` hands the browser inflated bytes under a .gz name).
 * - The writer mirrors the notebook's `lstb_write`: raw = round((value - offset) / scale) with
 *   numpy's round-half-to-even, NaN -> nodata, clipped to the dtype range (never onto nodata), so
 *   fixtures written here decode bit-identically to files written by Python.
 */

import { isGzipBytes } from "../lib/data.js";

export const LSTB_MAGIC = "LSTB";
export const LSTB_VERSION = 1;
const PREAMBLE_BYTES = 12; // magic(4) + version(1) + reserved(3) + header_len(4)

/** dtype name -> typed-array constructor (the four dtypes SPEC §5.1 allows). */
export const LSTB_DTYPES = Object.freeze({
  int16: Int16Array,
  uint8: Uint8Array,
  int32: Int32Array,
  float32: Float32Array,
});

/** Representable range of each integer dtype (float32 is unbounded for our purposes). */
const DTYPE_RANGE = Object.freeze({
  int16: [-32768, 32767],
  uint8: [0, 255],
  int32: [-2147483648, 2147483647],
  float32: [-Infinity, Infinity],
});

/** Error raised for malformed containers; `code` makes failures easy to test and to report. */
export class LstbError extends Error {
  constructor(message, code = "malformed") {
    super(message);
    this.name = "LstbError";
    this.code = code;
  }
}

const align8 = (x) => Math.ceil(x / 8) * 8;
const product = (shape) => shape.reduce((a, b) => a * b, 1);

/** True when the bytes start with the (uncompressed) LSTB magic. */
export function isLstbBytes(bytes) {
  return (
    bytes != null &&
    bytes.length >= 4 &&
    bytes[0] === 0x4c && // L
    bytes[1] === 0x53 && // S
    bytes[2] === 0x54 && // T
    bytes[3] === 0x42 // B
  );
}

/**
 * One-chunk ReadableStream over bytes. Used instead of `new Blob([bytes]).stream()` because some
 * environments (jsdom, older WebViews) ship a Blob without `stream()`; ReadableStream exists in
 * every browser, worker and Node >= 18.
 */
export function bytesStream(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Inflate gzip bytes to a Uint8Array (DecompressionStream; browsers, workers and Node >= 18). */
export async function gunzipBytes(bytes) {
  if (typeof DecompressionStream !== "function") {
    throw new LstbError("this environment cannot decompress gzip (DecompressionStream is unavailable)", "unsupported");
  }
  const stream = bytesStream(bytes).pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Inflate when the payload is gzip (magic bytes), else return it unchanged. */
export async function inflateIfGzip(bytes) {
  return isGzipBytes(bytes) ? gunzipBytes(bytes) : bytes;
}

/** Ensure `bytes` starts at offset 0 of its own ArrayBuffer so typed views are aligned. */
function ownBuffer(bytes) {
  if (bytes.byteOffset % 8 === 0) return bytes;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function validateColumnHeader(col, i, dataLength) {
  const where = `column ${i} (${col?.name ?? "?"})`;
  if (!col || typeof col.name !== "string" || !col.name) throw new LstbError(`${where}: missing name`);
  const Ctor = LSTB_DTYPES[col.dtype];
  if (!Ctor) throw new LstbError(`${where}: unsupported dtype ${JSON.stringify(col.dtype)}`);
  if (!Array.isArray(col.shape) || !col.shape.length || !col.shape.every((d) => Number.isInteger(d) && d >= 0)) {
    throw new LstbError(`${where}: shape must be a non-empty list of non-negative integers`);
  }
  const offset = Number(col.byte_offset);
  const length = Number(col.byte_length);
  if (!Number.isInteger(offset) || offset < 0 || offset % 8 !== 0) {
    throw new LstbError(`${where}: byte_offset ${col.byte_offset} must be a non-negative multiple of 8`);
  }
  const expected = product(col.shape) * Ctor.BYTES_PER_ELEMENT;
  if (length !== expected) {
    throw new LstbError(`${where}: byte_length ${col.byte_length} != prod(shape) x ${Ctor.BYTES_PER_ELEMENT} = ${expected}`);
  }
  if (offset + length > dataLength) {
    throw new LstbError(`${where}: byte range ${offset}..${offset + length} exceeds the data section (${dataLength} bytes)`, "truncated");
  }
  return { Ctor, offset, length };
}

/**
 * Parse an INFLATED LSTB payload into typed-array views (no copies of the data section).
 * @param {Uint8Array|ArrayBuffer} input
 * @returns {{version:number, kind:string, n:number, meta:object, header:object,
 *            columns: Object<string, LstbColumn>, order:string[], byteLength:number}}
 *   where LstbColumn = {name, dtype, shape, scale, offset, nodata, raw: TypedArray}
 */
export function parseLstb(input) {
  let bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  if (!(bytes instanceof Uint8Array)) throw new LstbError("parseLstb expects a Uint8Array or ArrayBuffer", "type");
  if (isGzipBytes(bytes)) throw new LstbError("payload is still gzip-compressed; call decodeLstbBytes()", "gzip");
  if (bytes.length < PREAMBLE_BYTES || !isLstbBytes(bytes)) throw new LstbError("not an LSTB container (bad magic bytes)", "magic");
  bytes = ownBuffer(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(4);
  if (version !== LSTB_VERSION) throw new LstbError(`unsupported LSTB version ${version} (reader knows ${LSTB_VERSION})`, "version");
  const headerLength = view.getUint32(8, true);
  if (PREAMBLE_BYTES + headerLength > bytes.length) throw new LstbError("header extends past the end of the file", "truncated");

  let header;
  try {
    header = JSON.parse(new TextDecoder("utf-8").decode(bytes.subarray(PREAMBLE_BYTES, PREAMBLE_BYTES + headerLength)));
  } catch (cause) {
    throw new LstbError(`header is not valid JSON: ${cause.message}`, "header");
  }
  if (!header || typeof header !== "object" || !Array.isArray(header.columns)) {
    throw new LstbError('header must be an object with a "columns" list', "header");
  }
  const dataStart = align8(PREAMBLE_BYTES + headerLength);
  const dataLength = bytes.length - dataStart;
  if (dataLength < 0) throw new LstbError("missing data section", "truncated");

  const columns = {};
  const order = [];
  header.columns.forEach((col, i) => {
    const { Ctor, offset, length } = validateColumnHeader(col, i, dataLength);
    if (columns[col.name]) throw new LstbError(`duplicate column name "${col.name}"`);
    const absolute = bytes.byteOffset + dataStart + offset;
    columns[col.name] = {
      name: col.name,
      dtype: col.dtype,
      shape: col.shape.slice(),
      scale: Number.isFinite(Number(col.scale)) ? Number(col.scale) : 1,
      offset: Number.isFinite(Number(col.offset)) ? Number(col.offset) : 0,
      nodata: col.nodata === null || col.nodata === undefined ? null : Number(col.nodata),
      raw: new Ctor(bytes.buffer, absolute, length / Ctor.BYTES_PER_ELEMENT),
    };
    order.push(col.name);
  });

  return {
    version,
    kind: String(header.kind ?? ""),
    n: Number(header.n),
    meta: header.meta && typeof header.meta === "object" ? header.meta : {},
    header,
    columns,
    order,
    byteLength: bytes.byteLength,
  };
}

/** Inflate (when gzip) and parse LSTB bytes. */
export async function decodeLstbBytes(input) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  return parseLstb(await inflateIfGzip(bytes));
}

/** Column accessor with a precise error (used by every consumer of LSTB files). */
export function requireColumn(file, name) {
  const column = file?.columns?.[name];
  if (!column) throw new LstbError(`${file?.kind || "LSTB"} file has no column "${name}"`, "column");
  return column;
}

/** Number of elements of one "row" (frame) of a column: the product of all but the first dim. */
export function rowLength(column) {
  return column.shape.length > 1 ? product(column.shape.slice(1)) : column.shape[0];
}

/** Raw (still quantised) values of frame `f` of a [F, n] column, as a subarray (no copy). */
export function columnFrame(column, f) {
  if (column.shape.length < 2) {
    if (f !== 0) throw new LstbError(`column "${column.name}" is 1-D; frame ${f} does not exist`, "range");
    return column.raw;
  }
  const frames = column.shape[0];
  if (!Number.isInteger(f) || f < 0 || f >= frames) {
    throw new LstbError(`frame ${f} out of range for column "${column.name}" with ${frames} frames`, "range");
  }
  const len = rowLength(column);
  return column.raw.subarray(f * len, (f + 1) * len);
}

/**
 * Decode raw values to physical units: v = raw * scale + offset, raw == nodata -> NaN.
 * @param {LstbColumn} column
 * @param {{frame?: number, out?: Float32Array}} [options] frame of a [F, n] column (default: all)
 * @returns {Float32Array}
 */
export function decodeColumn(column, { frame = null, out = null } = {}) {
  const raw = frame === null ? column.raw : columnFrame(column, frame);
  const target = out ?? new Float32Array(raw.length);
  if (target.length < raw.length) throw new LstbError(`output buffer too small (${target.length} < ${raw.length})`, "range");
  const { scale, offset, nodata } = column;
  const checkNodata = nodata !== null;
  const isFloat = column.dtype === "float32";
  for (let i = 0; i < raw.length; i += 1) {
    const r = raw[i];
    target[i] = (checkNodata && r === nodata) || (isFloat && Number.isNaN(r)) ? NaN : r * scale + offset;
  }
  return target;
}

/** Decode a single raw value (convenience for readouts). */
export function decodeValue(column, raw) {
  if (raw === undefined || (column.nodata !== null && raw === column.nodata) || Number.isNaN(raw)) return NaN;
  return raw * column.scale + column.offset;
}

// ---------------------------------------------------------------------------------------
// Writer (fixtures, tests, in-browser exports) — mirrors the notebook's lstb_write
// ---------------------------------------------------------------------------------------

/** numpy-compatible round-half-to-even. */
export function roundHalfEven(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/**
 * Quantise physical values into a typed array of `dtype`.
 * raw = round((v - offset) / scale); non-finite -> nodata; clipped to the dtype range, and a
 * valid value never lands on the nodata code (it is moved one step inside the range).
 */
export function quantize(values, { dtype = "int16", scale = 1, offset = 0, nodata = null } = {}) {
  const Ctor = LSTB_DTYPES[dtype];
  if (!Ctor) throw new LstbError(`unsupported dtype ${JSON.stringify(dtype)}`, "dtype");
  const out = new Ctor(values.length);
  if (dtype === "float32") {
    for (let i = 0; i < values.length; i += 1) {
      const v = values[i];
      out[i] = v === null || v === undefined || !Number.isFinite(v) ? (nodata ?? NaN) : (v - offset) / scale;
    }
    return out;
  }
  let [lo, hi] = DTYPE_RANGE[dtype];
  if (nodata !== null && nodata !== undefined) {
    if (nodata === lo) lo += 1;
    else if (nodata === hi) hi -= 1;
  }
  const fill = nodata ?? 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (v === null || v === undefined || !Number.isFinite(v)) {
      out[i] = fill;
      continue;
    }
    const q = roundHalfEven((v - offset) / scale);
    out[i] = q < lo ? lo : q > hi ? hi : q;
  }
  return out;
}

/**
 * Encode an LSTB container (uncompressed bytes; gzip with CompressionStream if needed).
 * @param {{kind: string, n: number, meta?: object, columns: Array<{name: string, dtype: string,
 *          shape?: number[], scale?: number, offset?: number, nodata?: number|null,
 *          raw?: TypedArray, values?: ArrayLike<number>}>}} spec
 *   Pass `raw` (already quantised, exact dtype) or `values` (physical units; quantised here).
 * @returns {Uint8Array}
 */
export function encodeLstb({ kind, n, meta = {}, columns }) {
  if (!Array.isArray(columns) || !columns.length) throw new LstbError("encodeLstb needs at least one column", "header");
  const prepared = columns.map((c) => {
    const Ctor = LSTB_DTYPES[c.dtype];
    if (!Ctor) throw new LstbError(`column "${c.name}": unsupported dtype ${JSON.stringify(c.dtype)}`, "dtype");
    const scale = c.scale ?? 1;
    const offset = c.offset ?? 0;
    const nodata = c.nodata ?? null;
    let raw = c.raw;
    if (raw && !(raw instanceof Ctor)) raw = Ctor.from(raw);
    if (!raw) raw = quantize(c.values ?? [], { dtype: c.dtype, scale, offset, nodata });
    const shape = c.shape ?? [raw.length];
    if (product(shape) !== raw.length) {
      throw new LstbError(`column "${c.name}": shape ${JSON.stringify(shape)} does not match ${raw.length} values`, "header");
    }
    return { name: c.name, dtype: c.dtype, shape, scale, offset, nodata, raw };
  });

  let cursor = 0;
  const headerColumns = prepared.map((c) => {
    const entry = {
      name: c.name,
      dtype: c.dtype,
      shape: c.shape,
      scale: c.scale,
      offset: c.offset,
      nodata: c.nodata,
      byte_offset: cursor,
      byte_length: c.raw.byteLength,
    };
    cursor = align8(cursor + c.raw.byteLength);
    return entry;
  });
  const headerBytes = new TextEncoder().encode(JSON.stringify({ kind, n, meta, columns: headerColumns }));
  const dataStart = align8(PREAMBLE_BYTES + headerBytes.length);
  const out = new Uint8Array(dataStart + cursor);
  out.set([0x4c, 0x53, 0x54, 0x42, LSTB_VERSION, 0, 0, 0], 0);
  new DataView(out.buffer).setUint32(8, headerBytes.length, true);
  out.set(headerBytes, PREAMBLE_BYTES);
  prepared.forEach((c, i) => {
    out.set(new Uint8Array(c.raw.buffer, c.raw.byteOffset, c.raw.byteLength), dataStart + headerColumns[i].byte_offset);
  });
  return out;
}

/** gzip-compress bytes with CompressionStream (async; used to emit `.lstb.gz` in tests). */
export async function gzipBytes(bytes) {
  if (typeof CompressionStream !== "function") throw new LstbError("CompressionStream is unavailable", "unsupported");
  const stream = bytesStream(bytes).pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
