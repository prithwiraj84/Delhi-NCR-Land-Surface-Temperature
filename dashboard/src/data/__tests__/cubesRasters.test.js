import { describe, expect, it, vi } from "vitest";
import { buildCellLocator, indexOfCellId } from "../cells.js";
import { cellQuantiles, cubeFromFloatFrames, cubeFromLstb, cubeQuantiles, decodeCubeFrame, deriveDtrCube, flagVsupTier, zoneFrame, zonesFromLstb } from "../cubes.js";
import { encodePngRgb } from "../fixtures/png.js";
import { encodeLstb, parseLstb } from "../lstb.js";
import { createLru, decodePngRgb, decodeRasterByte, decodeRasterBytes, normalizeRasterIndex, rasterEntry, rasterRangeInBox, rasterValueAt } from "../rasters.js";
import { gzipBytes } from "../lstb.js";

function sspCube() {
  const F = 2;
  const n = 3;
  return cubeFromLstb(
    parseLstb(
      encodeLstb({
        kind: "cube",
        n,
        meta: { mode: "night", scenario: "ssp245", frames: [2030, 2035], tiers: ["projected", "projected"] },
        columns: [
          { name: "p50", dtype: "int16", shape: [F, n], scale: 0.01, nodata: -32768, values: [30, 31, NaN, 32, 33, 34] },
          { name: "p05_off", dtype: "uint8", shape: [F, n], scale: 0.05, raw: new Uint8Array([20, 20, 0, 40, 40, 40]) },
          { name: "p25_off", dtype: "uint8", shape: [F, n], scale: 0.05, raw: new Uint8Array([8, 8, 0, 16, 16, 16]) },
          { name: "p75_off", dtype: "uint8", shape: [F, n], scale: 0.05, raw: new Uint8Array([9, 9, 0, 17, 17, 17]) },
          { name: "p95_off", dtype: "uint8", shape: [F, n], scale: 0.05, raw: new Uint8Array([22, 22, 0, 44, 44, 44]) },
          { name: "flags", dtype: "uint8", shape: [F, n], raw: new Uint8Array([0, 1, 0, 2, 4 | 1, 6]) },
        ],
      }),
    ),
    { mode: "night", series: "ssp245" },
  );
}

describe("cubes", () => {
  it("decodes quantiles as p50 ± offsets and spread = p95 − p05", () => {
    const cube = sspCube();
    expect(cube.years).toEqual([2030, 2035]);
    expect(cube.values).toBeInstanceOf(Int16Array);
    expect(cube.scale).toBe(0.01);
    const p05 = decodeCubeFrame(cube, 0, { q: "p05" });
    const p95 = decodeCubeFrame(cube, 0, { q: "p95" });
    expect(p05[0]).toBeCloseTo(29, 5);
    expect(p95[0]).toBeCloseTo(31.1, 5);
    expect(Number.isNaN(p05[2])).toBe(true);
    expect(decodeCubeFrame(cube, 1, { q: "spread" })[0]).toBeCloseTo(4.2, 5);
    expect(decodeCubeFrame(cube, 1, { q: "p25" })[1]).toBeCloseTo(32.2, 5);
    expect(() => decodeCubeFrame(cube, 0, { q: "p99" })).toThrow(/unknown quantile/);
    const rows = cellQuantiles(cube, 1);
    expect(rows[1]).toMatchObject({ year: 2035, outsideAoa: true, vsupTier: 2, tier: "projected" });
    expect(rows[1].p05).toBeLessThan(rows[1].p25);
    expect(rows[1].p75).toBeLessThan(rows[1].p95);
    expect(flagVsupTier(6)).toBe(3);
  });

  it("rejects cubes whose columns disagree on shape or frame count", () => {
    const bad = parseLstb(
      encodeLstb({
        kind: "cube",
        n: 2,
        meta: { frames: [2030] },
        columns: [
          { name: "p50", dtype: "int16", shape: [1, 2], raw: new Int16Array(2) },
          { name: "flags", dtype: "uint8", shape: [2, 1], raw: new Uint8Array(2) },
        ],
      }),
    );
    expect(() => cubeFromLstb(bad, {})).toThrow(/shape/);
    const wrongFrames = parseLstb(encodeLstb({ kind: "cube", n: 2, meta: { frames: [2030, 2035] }, columns: [{ name: "p50", dtype: "int16", shape: [1, 2], raw: new Int16Array(2) }] }));
    expect(() => cubeFromLstb(wrongFrames, {})).toThrow(/meta.frames/);
    expect(() => cubeFromLstb({ kind: "xai", columns: {} }, {})).toThrow(/expected an LSTB "cube"/);
  });

  it("derives DTR = day − night (nodata propagates) and computes domain quantiles", () => {
    const day = cubeFromFloatFrames([Float32Array.from([40, 42, NaN])], { years: [2025], mode: "day", tiers: ["observed"] });
    const night = cubeFromFloatFrames([Float32Array.from([28, 27.5, 26])], { years: [2025], mode: "night", tiers: ["observed"] });
    const dtr = deriveDtrCube(day, night);
    const v = decodeCubeFrame(dtr, 0);
    expect(v[0]).toBeCloseTo(12, 5);
    expect(v[1]).toBeCloseTo(14.5, 5);
    expect(Number.isNaN(v[2])).toBe(true);
    expect(dtr.tiers).toEqual(["observed"]);
    const [lo, hi] = cubeQuantiles(day, [0, 1]);
    expect(lo).toBeCloseTo(40, 5);
    expect(hi).toBeCloseTo(42, 5);
  });

  it("reads zone cubes with 255 = nodata and converts frames to the v1 Int8 convention", () => {
    const file = parseLstb(
      encodeLstb({
        kind: "zones",
        n: 3,
        meta: { mode: "day" },
        columns: [
          { name: "obs", dtype: "uint8", shape: [2, 3], raw: new Uint8Array([0, 3, 255, 1, 2, 3]) },
          { name: "ssp245", dtype: "uint8", shape: [1, 3], raw: new Uint8Array([3, 3, 3]) },
        ],
      }),
    );
    const z = zonesFromLstb(file, { yearsBySeries: { obs: [2020, 2025], ssp245: [2030] } });
    expect(Array.from(zoneFrame(z, "obs", 2020))).toEqual([0, 3, -1]);
    expect(Array.from(zoneFrame(z, "ssp245", 2030))).toEqual([3, 3, 3]);
    expect(zoneFrame(z, "obs", 2030)).toBeNull();
    expect(() => zonesFromLstb(file, {})).toThrow(/cannot resolve/);
  });
});

describe("rasters", () => {
  const W = 4;
  const H = 3;
  const rgb = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i += 1) {
    rgb[i * 3] = i === 0 ? 0 : i * 20;
    rgb[i * 3 + 1] = i % 2 ? 1 | (3 << 1) : 0;
  }
  const png = encodePngRgb(W, H, rgb);

  it("decodes exact R/G bytes from a PNG (also when gzip-wrapped)", async () => {
    const decoded = await decodePngRgb(png);
    expect(decoded).toMatchObject({ width: W, height: H, channels: 3 });
    expect(Array.from(decoded.data)).toEqual(Array.from(rgb));
    const split = await decodeRasterBytes(await gzipBytes(png));
    expect(split.values[5]).toBe(100);
    expect(split.flags[5]).toBe(7);
    await expect(decodePngRgb(new Uint8Array([1, 2, 3]))).rejects.toThrow(/signature/);
  });

  it("maps lon/lat to pixels and decodes values with the fixed lo/hi", async () => {
    const { values, flags } = await decodeRasterBytes(png);
    const raster = { values, flags, width: W, height: H, bounds: [76, 28, 78, 29.5], lo: 20, hi: 50 };
    expect(decodeRasterByte(0, 20, 50)).toBeNaN();
    expect(decodeRasterByte(1, 20, 50)).toBe(20);
    expect(decodeRasterByte(255, 20, 50)).toBe(50);
    const nodata = rasterValueAt(raster, 76.1, 29.4);
    expect(nodata.value).toBeNaN();
    const p = rasterValueAt(raster, 77.6, 28.1); // last row, col 3 -> i = 11
    expect(p).toMatchObject({ px: 3, py: 2, flags: 7, outsideAoa: true, tierCode: 3 });
    expect(p.value).toBeCloseTo(20 + ((220 - 1) * 30) / 254, 6);
    expect(rasterValueAt(raster, 80, 28.5)).toBeNull();
    const range = rasterRangeInBox(raster, [76, 28, 78, 29.5]);
    expect(range.count).toBe(11);
    expect(range.max).toBeCloseTo(50 - ((255 - 220) * 30) / 254, 6);
  });

  it("normalises the raster index and explains missing frames", () => {
    expect(() => normalizeRasterIndex({ crs: "EPSG:32643", bounds: [0, 0, 1, 1] })).toThrow(/EPSG:4326/);
    expect(() => normalizeRasterIndex({ bounds: [1, 0, 0, 1] })).toThrow(/bounds/);
    const idx = normalizeRasterIndex({ crs: "EPSG:4326", bounds: [76, 28, 78, 29.5], width: 4, height: 3, frames: { day_2025: { file: "raster/day_2025.png", lo: 20, hi: 50, tier: "observed" } } });
    expect(rasterEntry(idx, "day_2025").entry.file).toBe("raster/day_2025.png");
    expect(rasterEntry(idx, "day_2025", { preview: true }).reason).toMatch(/no 500 m preview/);
    expect(rasterEntry(idx, "day_1990").reason).toBe("1990: day not downscaled");
    expect(rasterEntry(null, "day_1990").reason).toMatch(/no 250 m rasters/);
  });

  it("LRU keeps the most recently used entries and calls onEvict", () => {
    const evicted = vi.fn();
    const lru = createLru(2, evicted);
    lru.set("a", 1);
    lru.set("b", 2);
    lru.get("a");
    expect(lru.set("c", 3)).toEqual(["b"]);
    expect(evicted).toHaveBeenCalledWith("b", 2);
    expect(lru.keys()).toEqual(["a", "c"]);
    lru.delete("a");
    lru.clear();
    expect(evicted).toHaveBeenCalledTimes(3);
    expect(lru.size).toBe(0);
  });
});

describe("cells", () => {
  const cells = { n: 4, cell_id: Int32Array.from([3, 8, 9, 20]), lon: Float32Array.from([77, 77.01, 77.02, 77.5]), lat: Float32Array.from([28, 28, 28, 28.5]) };
  it("finds cell ids by binary search and the nearest cell by lon/lat bins", () => {
    expect(indexOfCellId(cells, 9)).toBe(2);
    expect(indexOfCellId(cells, 10)).toBe(-1);
    const locator = buildCellLocator(cells, { binDeg: 0.05 });
    expect(locator.nearest(77.012, 28.001)).toBe(1);
    expect(locator.nearest(77.49, 28.49)).toBe(3);
    expect(locator.nearest(79, 30)).toBe(-1);
  });
});
