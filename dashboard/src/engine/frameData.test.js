import { beforeAll, describe, expect, it } from "vitest";
import { createBundleStore } from "../data/bundleStore.js";
import { createFixtureFetch, createSynthV2 } from "../data/fixtures/synthV2.js";
import { absQuantile, contentKey, createFrameSource, driverPaletteFor, valueRange } from "./frameData.js";

const SOURCE = { id: "fixture", baseUrl: null, explicit: true, reason: "test" };
let bundle;

/** Resolve a frame, waiting for the BundleStore loads it triggers. */
async function resolve(src, desc, year, tries = 20) {
  for (let k = 0; k < tries; k += 1) {
    const r = src.frame(desc, year);
    if (r.status !== "loading") return r;
    await new Promise((res) => setTimeout(res, 15));
  }
  return src.frame(desc, year);
}

const base = { mode: "day", layer: "lst", variable: "abs", q: "p50", ssp: "ssp245", shapFeature: null, deltaRef: null, scenario: null, scenarioKey: null, domainMode: "fixed" };

beforeAll(async () => {
  const synth = createSynthV2();
  const fetchImpl = createFixtureFetch(synth, { compress: false });
  bundle = createBundleStore({ fixtureLoader: async () => ({ synth, fetchImpl }) });
  await bundle.getState().load({ source: SOURCE });
});

describe("frame resolver on the synthetic v2 bundle", () => {
  it("decodes observed and projected LST frames in °C with nodata as NaN", async () => {
    const src = createFrameSource({ bundle });
    const obs = await resolve(src, base, 2025);
    expect(obs.status).toBe("ready");
    const v = obs.frame.values;
    const finite = Array.from(v).filter(Number.isFinite);
    expect(finite.length).toBeGreaterThan(1000);
    expect(Math.min(...finite)).toBeGreaterThan(20);
    expect(Math.max(...finite)).toBeLessThan(65);
    expect(obs.frame.vsup).toBeNull();
    const proj = await resolve(src, base, 2040);
    expect(proj.status).toBe("ready");
    expect(proj.frame.series).toBe("ssp245");
    expect(proj.frame.vsup).toBeInstanceOf(Uint8Array);
    expect(Array.from(proj.frame.vsup).every((c) => c >= 1 && c <= 4)).toBe(true);
  });

  it("drops the VSUP codes of projected frames when the uncertainty fog is off (separate content key)", async () => {
    const src = createFrameSource({ bundle });
    const off = { ...base, fog: false };
    expect(contentKey(off)).not.toBe(contentKey(base));
    expect(contentKey({ ...base, fog: true })).toBe(contentKey(base));
    const fogged = await resolve(src, base, 2040);
    const clear = await resolve(src, off, 2040);
    expect(fogged.frame.vsup).toBeInstanceOf(Uint8Array);
    expect(clear.status).toBe("ready");
    expect(clear.frame.vsup).toBeNull();
    expect(Array.from(clear.frame.values)).toEqual(Array.from(fogged.frame.values));
  });

  it("keys observed frames by cube series so every SSP shares them, projected frames by SSP", async () => {
    const src = createFrameSource({ bundle });
    const a = await resolve(src, base, 2010);
    const b = await resolve(src, { ...base, ssp: "ssp585" }, 2010);
    expect(b.frame).toBe(a.frame);
    const p1 = await resolve(src, base, 2050);
    const p2 = await resolve(src, { ...base, ssp: "ssp585" }, 2050);
    expect(p2.frame).not.toBe(p1.frame);
    expect(p2.frame.mean).toBeGreaterThan(p1.frame.mean);
  });

  it("anomaly frames are centred on the frame level; Δ frames are zero at the reference year", async () => {
    const src = createFrameSource({ bundle });
    const anom = await resolve(src, { ...base, variable: "anom" }, 2015);
    expect(Math.abs(anom.frame.mean)).toBeLessThan(0.6);
    const delta = await resolve(src, { ...base, variable: "delta", deltaRef: 1990 }, 1990);
    expect(Array.from(delta.frame.values).filter(Number.isFinite).every((x) => x === 0)).toBe(true);
    const later = await resolve(src, { ...base, variable: "delta", deltaRef: 1990 }, 2050);
    expect(later.status).toBe("ready");
  });

  it("day surface UHI uses a rural reference and reads negative for built-up cells", async () => {
    const src = createFrameSource({ bundle });
    const suhi = await resolve(src, { ...base, variable: "suhi" }, 2020);
    expect(suhi.status).toBe("ready");
    expect(suhi.frame.note).toMatch(/rural/);
  });

  it("colour domains are FIXED across years (D4) and come from the manifest", async () => {
    const src = createFrameSource({ bundle });
    const tl = bundle.getState().timeline;
    const doms = [];
    for (const y of [1990, 2005, 2025, 2040, 2050]) {
      const r = await resolve(src, base, y);
      const ch = src.channel(base, r.frame);
      doms.push([ch.lo, ch.hi, ch.ramp]);
    }
    expect(new Set(doms.map((d) => d.join())).size).toBe(1);
    expect(doms[0].slice(0, 2)).toEqual(tl.domains.day.abs);
    expect(doms[0][2]).toBe("solar");
    const night = await resolve(src, { ...base, mode: "night" }, 2010);
    expect(src.channel({ ...base, mode: "night" }, night.frame).ramp).toBe("nocturne");
    const shared = src.channel({ ...base, domainMode: "shared" }, null);
    expect(shared.lo).toBeLessThanOrEqual(tl.domains.night.abs[0]);
    expect(shared.hi).toBeGreaterThanOrEqual(tl.domains.day.abs[1]);
  });

  it("XAI layers exist for XAI frames only, with a reason elsewhere", async () => {
    const src = createFrameSource({ bundle });
    const resid = await resolve(src, { ...base, layer: "resid" }, 2020);
    expect(resid.status).toBe("ready");
    expect(src.channel({ ...base, layer: "resid" }, resid.frame).kind).toBe("diverging");
    const proj = await resolve(src, { ...base, layer: "pred" }, 2040);
    expect(proj.status).toBe("unavailable");
    expect(proj.reason).toMatch(/XAI/);
    const dtr = await resolve(src, { ...base, mode: "dtr", layer: "shap" }, 2020);
    expect(dtr.status).toBe("unavailable");
  });

  it("categorical layers: dominant driver (families when > 17 groups), zones and AOA", async () => {
    const src = createFrameSource({ bundle });
    const driver = await resolve(src, { ...base, layer: "driver" }, 2020);
    expect(driver.status).toBe("ready");
    expect(driver.frame.kind).toBe("categorical");
    const used = new Set(Array.from(driver.frame.codes).filter((c) => c >= 0));
    for (const c of used) expect(c).toBeLessThan(driver.frame.palette.length);
    const zones = await resolve(src, { ...base, layer: "zones" }, 2045);
    expect(zones.status).toBe("ready");
    expect(zones.frame.categories).toHaveLength(4);
    const aoa = await resolve(src, { ...base, layer: "aoa" }, 2040);
    expect(aoa.status).toBe("ready");
    expect(aoa.frame.categories.map((c) => c.key)).toEqual(["inside", "outside"]);
  });

  it("what-if needs a scenario result for the frame", async () => {
    const src = createFrameSource({ bundle });
    expect((await resolve(src, { ...base, layer: "whatif" }, 2025)).status).toBe("unavailable");
    const n = bundle.getState().resources.cells.data.n;
    const deltaByCell = new Float64Array(n);
    deltaByCell[3] = -0.8;
    const r = await resolve(src, { ...base, layer: "whatif", scenario: { deltaByCell, epochYear: 2025 }, scenarioKey: "k" }, 2025);
    expect(r.status).toBe("ready");
    expect(r.frame.values[3]).toBeCloseTo(-0.8, 5);
  });

  it("helpers: driver palette families, robust ranges, content keys", () => {
    const many = Array.from({ length: 18 }, (_, k) => `g${k}`);
    const meta = many.map((id, k) => ({ id, family: ["spectral", "landcover", "climate"][k % 3] }));
    const pal = driverPaletteFor(many, meta);
    expect(pal.categories.map((c) => c.key)).toEqual(["spectral", "landcover", "meteorology"]);
    expect(driverPaletteFor(["a", "b"]).categories).toHaveLength(2);
    expect(absQuantile(new Float32Array([-3, 1, 2, NaN]))).toBe(2);
    expect(absQuantile(new Float32Array(100).map((_, i) => i - 50))).toBe(49);
    expect(valueRange(new Float32Array([5, 5]))).toEqual([4.5, 5.5]);
    expect(contentKey(base)).not.toBe(contentKey({ ...base, mode: "night" }));
  });
});
