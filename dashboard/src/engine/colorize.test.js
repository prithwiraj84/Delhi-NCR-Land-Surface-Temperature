import { describe, expect, it } from "vitest";
import { buildRampTexture, LUTS, RAMP_ORDER, vsupRgb } from "../design/ramps.js";
import { colorizeCategorical, colorizeSlots, elevationOf, heightChannel, HEIGHT_CAP_C } from "./colorize.js";
import { atlasRgb, atlasRow, lutColumn, rampIndexOf, thermalAtlas, VARIANTS } from "./lut.js";

const SOLAR = rampIndexOf("solar");

describe("thermal LUT atlas", () => {
  it("variant 0 rows are byte-identical to the design LUTs and E1's GPU ramp texture", () => {
    const atlas = thermalAtlas();
    const e1 = buildRampTexture();
    expect(atlas.height).toBe(RAMP_ORDER.length * VARIANTS);
    RAMP_ORDER.forEach((name, r) => {
      const row = atlasRow(r, 0);
      for (let i = 0; i < 256; i += 1) {
        const o = (row * 256 + i) * 4;
        expect([atlas.data[o], atlas.data[o + 1], atlas.data[o + 2]]).toEqual([LUTS[name][i * 3], LUTS[name][i * 3 + 1], LUTS[name][i * 3 + 2]]);
        const e = (r * 256 + i) * 4;
        expect(atlas.data[o]).toBe(e1.data[e]);
      }
    });
  });

  it("VSUP variants equal design/ramps vsupRgb at every LUT position", () => {
    const atlas = thermalAtlas();
    for (const name of ["solar", "nocturne"]) {
      for (let tier = 0; tier < 4; tier += 1) {
        const row = atlasRow(rampIndexOf(name), tier + 1);
        for (const i of [0, 37, 128, 255]) {
          const o = (row * 256 + i) * 4;
          expect([atlas.data[o], atlas.data[o + 1], atlas.data[o + 2]]).toEqual(vsupRgb(name, i / 255, tier));
        }
      }
    }
  });

  it("columns round like the GLSL floor(t·255 + 0.5) and clamp out-of-domain values", () => {
    expect(lutColumn(30, 30, 50)).toBe(0);
    expect(lutColumn(50, 30, 50)).toBe(255);
    expect(lutColumn(99, 30, 50)).toBe(255);
    expect(lutColumn(-5, 30, 50)).toBe(0);
    expect(lutColumn(40, 30, 50)).toBe(Math.floor(0.5 * 255 + 0.5));
    expect(atlasRgb(NaN, 0, 0, 0, 1, [0, 0, 0])).toBe(false);
  });
});

describe("colorizeSlots (CPU path)", () => {
  it("prism top colour equals LUT(value) for the readout value (acceptance §15 pixel test)", () => {
    const n = 64;
    const values = new Float32Array(n).map((_, i) => 28 + (i / (n - 1)) * 24);
    const out = new Uint8Array(n * 4);
    const shown = new Float32Array(n);
    colorizeSlots({ valuesA: values, valuesB: values, weight: 0, channelA: { rampIndex: SOLAR, lo: 28, hi: 52 }, channelB: { rampIndex: SOLAR, lo: 28, hi: 52 }, valueMix: true, outColors: out, outValues: shown });
    const lut = LUTS.solar;
    for (let i = 0; i < n; i += 1) {
      const c = lutColumn(shown[i], 28, 52) * 3;
      expect([out[i * 4], out[i * 4 + 1], out[i * 4 + 2], out[i * 4 + 3]]).toEqual([lut[c], lut[c + 1], lut[c + 2], 255]);
    }
  });

  it("value-mixes the time tween and hides interior nodata", () => {
    const a = new Float32Array([30, NaN]);
    const b = new Float32Array([40, 41]);
    const out = new Uint8Array(8);
    const shown = new Float32Array(2);
    const ch = { rampIndex: SOLAR, lo: 28, hi: 52 };
    colorizeSlots({ valuesA: a, valuesB: b, weight: 0.5, channelA: ch, channelB: ch, valueMix: true, outColors: out, outValues: shown });
    expect(shown[0]).toBe(35);
    expect(out[7]).toBe(0);
    expect(shown[1]).toBeNaN();
  });

  it("colour-mixes different channels (Day ↔ Night) and fades a missing side through alpha", () => {
    const day = { rampIndex: rampIndexOf("solar"), lo: 28, hi: 52 };
    const night = { rampIndex: rampIndexOf("nocturne"), lo: 18, hi: 34 };
    const a = new Float32Array([40, 40]);
    const b = new Float32Array([26, NaN]);
    const out = new Uint8Array(8);
    colorizeSlots({ valuesA: a, valuesB: b, weight: 0.5, channelA: day, channelB: night, valueMix: false, outColors: out });
    const ca = [0, 0, 0];
    const cb = [0, 0, 0];
    atlasRgb(40, day.rampIndex, 0, 28, 52, ca);
    atlasRgb(26, night.rampIndex, 0, 18, 34, cb);
    expect(out[0]).toBe(Math.floor((ca[0] + cb[0]) / 2 + 0.5));
    expect(out[3]).toBe(255);
    expect(out[4]).toBe(ca[0]);
    expect(out[7]).toBe(128);
  });

  it("blends projected slots toward their VSUP variant with the projected share", () => {
    const ch = { rampIndex: SOLAR, lo: 28, hi: 52 };
    const v = new Float32Array([44]);
    const plain = new Uint8Array(4);
    const fogged = new Uint8Array(4);
    colorizeSlots({ valuesA: v, valuesB: v, weight: 1, channelA: ch, channelB: ch, valueMix: true, outColors: plain });
    colorizeSlots({ valuesA: v, valuesB: v, weight: 1, channelA: ch, channelB: ch, valueMix: true, vsupB: new Uint8Array([4]), outColors: fogged });
    const u3 = [0, 0, 0];
    atlasRgb(44, SOLAR, 4, 28, 52, u3);
    expect([fogged[0], fogged[1], fogged[2]]).toEqual(u3);
    expect(fogged[0] === plain[0] && fogged[1] === plain[1] && fogged[2] === plain[2]).toBe(false);
  });

  it("darkens outside-AOA cells and dims unbrushed cells", () => {
    const ch = { rampIndex: SOLAR, lo: 28, hi: 52 };
    const v = new Float32Array([40, 40, 40]);
    const out = new Uint8Array(12);
    colorizeSlots({ valuesA: v, valuesB: v, weight: 0, channelA: ch, channelB: ch, valueMix: true, aoaA: new Uint8Array([0, 1, 0]), brush: new Uint8Array([1, 1, 0]), maskOn: true, outColors: out });
    expect(out[4]).toBe(Math.floor(out[0] * 0.65 + 0.5));
    expect(out[8]).toBe(Math.floor(out[0] * 0.25 + 0.5));
  });

  it("height: anomaly-relative with a 6 °C cap, absolute above the domain floor, morphing between them", () => {
    const hc = heightChannel({ lo: 28, hi: 52, ref: 40 });
    expect(elevationOf(39, 1, hc)).toBe(0);
    expect(elevationOf(43, 1, hc)).toBe(3 * hc.perUnit);
    expect(elevationOf(60, 1, hc)).toBe(HEIGHT_CAP_C * hc.perUnit);
    expect(elevationOf(52, 2, hc)).toBeCloseTo(22000, 6);
    expect(elevationOf(45, 0, hc)).toBe(0);
    const ch = { rampIndex: SOLAR, ...{ lo: 28, hi: 52 } };
    const elev = new Float32Array(1);
    colorizeSlots({ valuesA: new Float32Array([43]), valuesB: new Float32Array([43]), weight: 0, channelA: ch, channelB: ch, valueMix: true, outColors: new Uint8Array(4), outElevations: elev, height: { mode: 1, from: 2, blend: 0.5, A: hc, B: hc } });
    expect(elev[0]).toBeCloseTo((elevationOf(43, 1, hc) + elevationOf(43, 2, hc)) / 2, 3);
  });

  it("is fast enough at 55,150 cells (value mix + VSUP + heights)", () => {
    const n = 55150;
    const a = new Float32Array(n).map((_, i) => 30 + (i % 200) / 10);
    const b = new Float32Array(n).map((_, i) => 31 + (i % 180) / 10);
    const vs = new Uint8Array(n).fill(2);
    const out = new Uint8Array(n * 4);
    const elev = new Float32Array(n);
    const ch = { rampIndex: SOLAR, lo: 28, hi: 52 };
    const hc = heightChannel({ lo: 28, hi: 52, ref: 40 });
    const samples = [];
    for (let k = 0; k < 12; k += 1) {
      const t0 = performance.now();
      colorizeSlots({ valuesA: a, valuesB: b, weight: k / 12, channelA: ch, channelB: ch, valueMix: true, vsupB: vs, outColors: out, outElevations: elev, height: { mode: 1, A: hc, B: hc } });
      samples.push(performance.now() - t0);
    }
    samples.sort((x, y) => x - y);
    const median = samples[6];
    console.info(`[perf] colorizeSlots 55,150 cells: median ${median.toFixed(2)} ms`);
    expect(median).toBeLessThan(25);
  });
});

describe("colorizeCategorical", () => {
  it("paints palette slots, hides nodata and cross-fades from previous colours", () => {
    const codes = new Int16Array([0, 1, -1]);
    const palette = [
      [10, 20, 30],
      [200, 100, 50],
    ];
    const out = new Uint8Array(12);
    colorizeCategorical({ codes, palette, outColors: out });
    expect(Array.from(out.slice(0, 4))).toEqual([10, 20, 30, 255]);
    expect(out[11]).toBe(0);
    const from = new Uint8Array(12).fill(0);
    colorizeCategorical({ codes, palette, outColors: out, fromColors: from, weight: 0.5 });
    expect(out[4]).toBe(100);
  });
});
