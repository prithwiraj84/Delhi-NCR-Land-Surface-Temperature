import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  columnFrame,
  decodeColumn,
  decodeLstbBytes,
  decodeValue,
  encodeLstb,
  gzipBytes,
  isLstbBytes,
  LstbError,
  parseLstb,
  quantize,
  roundHalfEven,
} from "../lstb.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PY_FIXTURE_DIR = path.resolve(here, "../__fixtures__/lstb");

function sampleFile() {
  return encodeLstb({
    kind: "cube",
    n: 3,
    meta: { mode: "day", frames: [2020, 2025] },
    columns: [
      { name: "lst", dtype: "int16", shape: [2, 3], scale: 0.01, offset: 0, nodata: -32768, values: [40.123, NaN, 38.5, 41, 42.006, -1] },
      { name: "aoa_out", dtype: "uint8", shape: [2, 3], raw: new Uint8Array([0, 1, 0, 0, 0, 1]) },
      { name: "p05_off", dtype: "uint8", shape: [2, 3], scale: 0.05, raw: new Uint8Array([0, 0, 0, 10, 20, 255]) },
      { name: "ids", dtype: "int32", raw: new Int32Array([7, 70000, -5]) },
      { name: "lat", dtype: "float32", raw: new Float32Array([28.5, NaN, 29.25]) },
    ],
  });
}

describe("LSTB container (SPEC §5.1)", () => {
  it("round-trips every dtype with scale/offset/nodata decoding and 2-D frames", () => {
    const bytes = sampleFile();
    expect(isLstbBytes(bytes)).toBe(true);
    const file = parseLstb(bytes);
    expect(file.kind).toBe("cube");
    expect(file.n).toBe(3);
    expect(file.meta.frames).toEqual([2020, 2025]);
    expect(file.order).toEqual(["lst", "aoa_out", "p05_off", "ids", "lat"]);
    const lst = file.columns.lst;
    expect(lst.raw).toBeInstanceOf(Int16Array);
    expect(Array.from(lst.raw)).toEqual([4012, -32768, 3850, 4100, 4201, -100]);
    const decoded = decodeColumn(lst);
    expect(decoded[0]).toBeCloseTo(40.12, 5);
    expect(Number.isNaN(decoded[1])).toBe(true);
    expect(decoded[5]).toBeCloseTo(-1, 5);
    expect(Array.from(decodeColumn(lst, { frame: 1 }))).toEqual([41, 42.01, -1].map((v) => Math.fround(v)));
    expect(Array.from(columnFrame(lst, 0))).toEqual([4012, -32768, 3850]);
    expect(decodeColumn(file.columns.p05_off, { frame: 1 })[2]).toBeCloseTo(12.75, 5);
    expect(Array.from(file.columns.ids.raw)).toEqual([7, 70000, -5]);
    const lat = decodeColumn(file.columns.lat);
    expect(lat[0]).toBe(28.5);
    expect(Number.isNaN(lat[1])).toBe(true);
    expect(decodeValue(lst, -32768)).toBeNaN();
    expect(decodeValue(lst, 100)).toBeCloseTo(1, 6);
  });

  it("keeps every column 8-byte aligned relative to the file start and uses zero-copy views", () => {
    const bytes = sampleFile();
    const headerLength = new DataView(bytes.buffer).getUint32(8, true);
    const dataStart = Math.ceil((12 + headerLength) / 8) * 8;
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + headerLength)));
    for (const col of header.columns) expect((dataStart + col.byte_offset) % 8).toBe(0);
    for (let i = 12 + headerLength; i < dataStart; i += 1) expect(bytes[i]).toBe(0);
    const file = parseLstb(bytes);
    expect(file.columns.lst.raw.buffer).toBe(bytes.buffer);
  });

  it("decodes gzip payloads (CompressionStream and node zlib) and already-inflated ones", async () => {
    const bytes = sampleFile();
    const viaStream = await decodeLstbBytes(await gzipBytes(bytes));
    const viaZlib = await decodeLstbBytes(new Uint8Array(zlib.gzipSync(bytes, { level: 9 })));
    const plain = await decodeLstbBytes(bytes);
    for (const file of [viaStream, viaZlib, plain]) expect(Array.from(file.columns.lst.raw)).toEqual([4012, -32768, 3850, 4100, 4201, -100]);
  });

  it("copies a misaligned sub-view instead of failing", () => {
    const bytes = sampleFile();
    const shifted = new Uint8Array(bytes.length + 3);
    shifted.set(bytes, 3);
    const file = parseLstb(shifted.subarray(3));
    expect(Array.from(file.columns.ids.raw)).toEqual([7, 70000, -5]);
  });

  it("rejects malformed containers with precise error codes", () => {
    const good = sampleFile();
    const bad = (mutate) => {
      const b = good.slice();
      mutate(b);
      return b;
    };
    const code = (fn) => {
      try {
        fn();
      } catch (e) {
        expect(e).toBeInstanceOf(LstbError);
        return e.code;
      }
      return null;
    };
    expect(code(() => parseLstb(bad((b) => (b[0] = 0x58))))).toBe("magic");
    expect(code(() => parseLstb(bad((b) => (b[4] = 2))))).toBe("version");
    expect(code(() => parseLstb(good.subarray(0, good.length - 8)))).toBe("truncated");
    expect(code(() => parseLstb(new Uint8Array(zlib.gzipSync(good))))).toBe("gzip");
    expect(code(() => parseLstb(bad((b) => new DataView(b.buffer).setUint32(8, 1e6, true))))).toBe("truncated");
    const headerLength = new DataView(good.buffer).getUint32(8, true);
    const header = JSON.parse(new TextDecoder().decode(good.subarray(12, 12 + headerLength)));
    const rebuilt = (h) => {
      const hb = new TextEncoder().encode(JSON.stringify(h));
      const start = Math.ceil((12 + hb.length) / 8) * 8;
      const oldStart = Math.ceil((12 + headerLength) / 8) * 8;
      const out = new Uint8Array(start + good.length - oldStart);
      out.set(good.subarray(0, 8));
      new DataView(out.buffer).setUint32(8, hb.length, true);
      out.set(hb, 12);
      out.set(good.subarray(oldStart), start);
      return out;
    };
    expect(code(() => parseLstb(rebuilt({ ...header, columns: [{ ...header.columns[0], byte_offset: 4 }] })))).toBe("malformed");
    expect(code(() => parseLstb(rebuilt({ ...header, columns: [{ ...header.columns[0], dtype: "float64" }] })))).toBe("malformed");
    expect(code(() => parseLstb(rebuilt({ ...header, columns: [header.columns[0], header.columns[0]] })))).toBe("malformed");
    expect(code(() => parseLstb(rebuilt({ ...header, columns: [{ ...header.columns[0], byte_length: 10 }] })))).toBe("malformed");
    expect(() => columnFrame(parseLstb(good).columns.lst, 2)).toThrow(/out of range/);
  });

  it("quantises like numpy (round half to even, NaN -> nodata, clipping never lands on nodata)", () => {
    expect(roundHalfEven(0.5)).toBe(0);
    expect(roundHalfEven(1.5)).toBe(2);
    expect(roundHalfEven(2.5)).toBe(2);
    expect(roundHalfEven(-0.5)).toBe(-0);
    expect(roundHalfEven(-1.5)).toBe(-2);
    expect(roundHalfEven(2.4)).toBe(2);
    const q = quantize([1e9, -1e9, NaN, 0.004, 0.005, 0.015], { dtype: "int16", scale: 0.01, nodata: -32768 });
    expect(Array.from(q)).toEqual([32767, -32767, -32768, 0, 0, 2]);
    const u = quantize([300, -2, 7.4], { dtype: "uint8" });
    expect(Array.from(u)).toEqual([255, 0, 7]);
    expect(() => quantize([1], { dtype: "float64" })).toThrow(LstbError);
  });
});

// ---------------------------------------------------------------------------------------
// Files written by the notebook's Python `lstb_write` (optional; skipped when absent)
// ---------------------------------------------------------------------------------------

const pyFiles = fs.existsSync(PY_FIXTURE_DIR) ? fs.readdirSync(PY_FIXTURE_DIR).filter((f) => /\.lstb(\.gz)?$/.test(f)) : [];

describe.skipIf(!pyFiles.length)("Python-written LSTB fixtures (src/data/__fixtures__/lstb)", () => {
  for (const name of pyFiles) {
    it(`decodes ${name}${fs.existsSync(path.join(PY_FIXTURE_DIR, name.replace(/\.lstb(\.gz)?$/, ".json"))) ? " and matches its expected values" : ""}`, async () => {
      const file = await decodeLstbBytes(new Uint8Array(fs.readFileSync(path.join(PY_FIXTURE_DIR, name))));
      expect(typeof file.kind).toBe("string");
      expect(file.order.length).toBeGreaterThan(0);
      for (const col of Object.values(file.columns)) {
        const expectedLength = col.shape.reduce((a, b) => a * b, 1);
        expect(col.raw.length).toBe(expectedLength);
      }
      // Optional sibling `<base>.json`: {"columns": {name: [decoded values, null = NaN]}} (or a flat
      // {name: [...]}) written by the notebook test alongside the container.
      const expectedPath = path.join(PY_FIXTURE_DIR, name.replace(/\.lstb(\.gz)?$/, ".json"));
      if (!fs.existsSync(expectedPath)) return;
      const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
      const columns = expected.columns ?? expected;
      if (expected.kind) expect(file.kind).toBe(expected.kind);
      if (Number.isFinite(expected.n)) expect(file.n).toBe(expected.n);
      for (const [colName, values] of Object.entries(columns)) {
        if (!Array.isArray(values)) continue;
        const col = file.columns[colName];
        expect(col, `column ${colName}`).toBeTruthy();
        const decoded = decodeColumn(col);
        const flat = values.flat(Infinity);
        expect(decoded.length).toBe(flat.length);
        const tol = Math.abs(col.scale) / 2 + 1e-6 + (col.dtype === "float32" ? 1e-5 : 0);
        flat.forEach((v, i) => {
          if (v === null) expect(Number.isNaN(decoded[i]), `${colName}[${i}] should be NaN`).toBe(true);
          else expect(Math.abs(decoded[i] - v), `${colName}[${i}]`).toBeLessThanOrEqual(tol * Math.max(1, Math.abs(v)) + tol);
        });
      }
    });
  }
});
