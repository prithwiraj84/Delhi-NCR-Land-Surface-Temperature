import { describe, expect, it } from "vitest";
import { WEIGHT_GLSL } from "./shaders/thermal.glsl.js";
import { finiteMean, lonNormOf, maxDistance, mixFrame, mixValue, mixWeight, mixWeights, planarCoords, radialWeight, shapeCode, SHAPES, sweepWeight } from "./mixFrame.js";

const N = 55150;

function syntheticSlots(n = N) {
  const a = new Int16Array(n);
  const b = new Int16Array(n);
  for (let i = 0; i < n; i += 1) {
    a[i] = 3800 + ((i * 7919) % 900);
    b[i] = 4000 + ((i * 104729) % 1100);
  }
  return { a, b };
}

describe("mixWeight shapes (the contract the GLSL mirrors)", () => {
  it("fade = clamped global mix for every cell", () => {
    expect(mixWeight(0, { shape: "fade", mix: 0.25 })).toBe(0.25);
    expect(mixWeight(5, { shape: 0, mix: 1.7 })).toBe(1);
    expect(mixWeight(5, { shape: 0, mix: -1 })).toBe(0);
    expect(shapeCode("sweep")).toBe(SHAPES.sweep);
    expect(shapeCode("nope")).toBe(SHAPES.fade);
  });

  it("sweep runs EAST → WEST: at every progress the east edge has switched at least as far as the west", () => {
    for (const p of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const east = sweepWeight(1, p);
      const mid = sweepWeight(0.5, p);
      const west = sweepWeight(0, p);
      expect(east).toBeGreaterThanOrEqual(mid);
      expect(mid).toBeGreaterThanOrEqual(west);
    }
    // Endpoints: nothing switched at 0, everything at 1 (the feather never leaves cells behind).
    for (const u of [0, 0.25, 0.5, 0.75, 1]) {
      expect(sweepWeight(u, 0)).toBe(0);
      expect(sweepWeight(u, 1)).toBe(1);
    }
  });

  it("sweep weight is monotonic in progress and linear inside the feather", () => {
    let prev = -1;
    for (let p = 0; p <= 1.0001; p += 0.05) {
      const w = sweepWeight(0.4, p, 0.08);
      expect(w).toBeGreaterThanOrEqual(prev);
      prev = w;
    }
    // Inside the band the ramp is linear in u: midpoints average.
    const p = 0.5;
    const f = 0.08;
    const edge = 1 + f - p * (1 + 2 * f);
    const u0 = edge - f * 0.75;
    const u1 = edge - f * 0.25;
    expect(sweepWeight((u0 + u1) / 2, p, f)).toBeCloseTo((sweepWeight(u0, p, f) + sweepWeight(u1, p, f)) / 2, 6);
  });

  it("radial grows from the centre and reaches every cell inside the radius at mix = 1", () => {
    expect(radialWeight(0, 0, 1)).toBe(0);
    expect(radialWeight(0, 0.5, 1)).toBe(1);
    expect(radialWeight(0.9, 0.2, 1)).toBe(0);
    expect(radialWeight(1, 1, 1)).toBe(1);
    const near = mixWeight(0, { shape: "radial", mix: 0.4, x: [0.1], y: [0.1], cx: 0.1, cy: 0.12, radius: 1 });
    const far = mixWeight(0, { shape: "radial", mix: 0.4, x: [0.9], y: [0.9], cx: 0.1, cy: 0.12, radius: 1 });
    expect(near).toBeGreaterThan(far);
  });

  it("split is a hard step on normalised screen x (CPU uses two instances)", () => {
    expect(mixWeight(0, { shape: "split", x: 0.49, sweepPos: 0.5 })).toBe(0);
    expect(mixWeight(0, { shape: "split", x: 0.5, sweepPos: 0.5 })).toBe(1);
  });

  it("the GLSL weight function carries the same formulas", () => {
    // String guard: the shader must keep the CPU's edge, feather and front definitions.
    expect(WEIGHT_GLSL).toContain("float edge = 1.0 + f - clamp(p.y, 0.0, 1.0) * (1.0 + 2.0 * f);");
    expect(WEIGHT_GLSL).toContain("return clamp((u - edge) / f + 1.0, 0.0, 1.0);");
    expect(WEIGHT_GLSL).toContain("float front = clamp(p.x, 0.0, 1.0) * (r + f);");
    expect(WEIGHT_GLSL).toContain("return clamp((front - d) / f, 0.0, 1.0);");
  });
});

describe("mixFrame", () => {
  it("decodes raw Int16 with scale and lerps value-linearly", () => {
    const out = mixFrame({ a: new Int16Array([4000, 3000]), b: new Int16Array([4200, 3400]), scaleA: 0.01, scaleB: 0.01, nodata: -32768, params: { mix: 0.25 } });
    expect(out[0]).toBeCloseTo(40.5, 5);
    expect(out[1]).toBeCloseTo(31, 5);
  });

  it("applies the shared nodata rule: endpoints show one side, interior needs both", () => {
    const nd = -32768;
    const a = new Int16Array([nd, 4000, nd]);
    const b = new Int16Array([4100, nd, nd]);
    const at = (m) => Array.from(mixFrame({ a, b, scaleA: 0.01, scaleB: 0.01, nodata: nd, params: { mix: m } }));
    expect(at(0)[0]).toBeNaN();
    expect(at(0)[1]).toBeCloseTo(40, 5);
    expect(at(1)[0]).toBeCloseTo(41, 5);
    expect(at(1)[1]).toBeNaN();
    const mid = at(0.5);
    expect(mid.every(Number.isNaN)).toBe(true);
    expect(mixValue(NaN, 3, 0.5)).toBeNaN();
    expect(mixValue(2, NaN, 0)).toBe(2);
  });

  it("never overshoots: every interpolated value lies between its two frame values", () => {
    const { a, b } = syntheticSlots(5000);
    for (const m of [0.1, 0.33, 0.5, 0.9]) {
      const out = mixFrame({ a, b, scaleA: 0.01, scaleB: 0.01, params: { mix: m } });
      for (let i = 0; i < out.length; i += 1) {
        const lo = Math.min(a[i], b[i]) * 0.01 - 1e-4;
        const hi = Math.max(a[i], b[i]) * 0.01 + 1e-4;
        expect(out[i] >= lo && out[i] <= hi).toBe(true);
      }
    }
  });

  it("supports offsets (anomaly), Float32 slots with NaN and per-cell sweep weights", () => {
    const a = new Float32Array([30, NaN, 32]);
    const b = new Float32Array([40, 41, 42]);
    const lonNorm = new Float32Array([0, 0.5, 1]);
    const out = mixFrame({ a, b, offsetA: -30, offsetB: -40, shape: "sweep", params: { lonNorm, sweepPos: 0.5, feather: 0.08 } });
    expect(out[2]).toBe(2); // east: switched to B (42 − 40)
    expect(out[0]).toBe(0); // west: still A (30 − 30)
    const w = mixWeights(3, "sweep", { lonNorm, sweepPos: 0.5 });
    expect(w[2]).toBe(1);
    expect(w[0]).toBe(0);
  });

  it("reuses the output buffer and validates inputs", () => {
    const out = new Float32Array(3);
    const res = mixFrame({ a: new Float32Array(3), b: new Float32Array(3), out });
    expect(res).toBe(out);
    expect(() => mixFrame({ a: new Float32Array(2), b: new Float32Array(3) })).toThrow(RangeError);
    expect(() => mixFrame({ a: null, b: new Float32Array(3) })).toThrow(TypeError);
  });

  it("geometry helpers: lonNorm, planar coords, max distance, mean", () => {
    const lon = new Float32Array([76, 77, 78]);
    const lat = new Float32Array([28, 28.5, 29]);
    expect(Array.from(lonNormOf(lon, [76, 78]))).toEqual([0, 0.5, 1]);
    const { x, y } = planarCoords(lon, lat, [76, 28, 78, 29]);
    expect(y[2]).toBeCloseTo(1, 6);
    expect(x[2]).toBeCloseTo(2 * Math.cos((28.5 * Math.PI) / 180), 5);
    expect(maxDistance(x, y, 0, 0)).toBeCloseTo(Math.hypot(x[2], 1), 5);
    expect(finiteMean(new Float32Array([1, NaN, 3]))).toBe(2);
    expect(finiteMean(new Float32Array([NaN]))).toBeNaN();
  });

  it("is fast enough for the CPU path at 55,150 cells (fade and sweep)", () => {
    const { a, b } = syntheticSlots();
    const lonNorm = new Float32Array(N).map((_, i) => (i % 297) / 296);
    const out = new Float32Array(N);
    const time = (fn) => {
      const samples = [];
      for (let k = 0; k < 15; k += 1) {
        const t0 = performance.now();
        fn(k);
        samples.push(performance.now() - t0);
      }
      samples.sort((x, y) => x - y);
      return samples[Math.floor(samples.length / 2)];
    };
    const fade = time((k) => mixFrame({ a, b, scaleA: 0.01, scaleB: 0.01, nodata: -32768, params: { mix: k / 15 }, out }));
    const sweep = time((k) => mixFrame({ a, b, scaleA: 0.01, scaleB: 0.01, nodata: -32768, shape: "sweep", params: { lonNorm, sweepPos: k / 15 }, out }));
    // Budget: ≤ 4 ms main-thread JS per frame (UI_SPEC §11); generous for slow CI machines.
    expect(fade).toBeLessThan(8);
    expect(sweep).toBeLessThan(12);
    console.info(`[perf] mixFrame 55,150 cells: fade median ${fade.toFixed(2)} ms, sweep median ${sweep.toFixed(2)} ms`);
  });
});
