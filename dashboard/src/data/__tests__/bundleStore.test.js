import { describe, expect, it, vi } from "vitest";
import { createBundleStore, IDLE } from "../bundleStore.js";
import { bundleBaseUrl, bundleFileUrl, detectSchema, requestedBundle, resolveBundleSource, schemaMajor, withBundleParam } from "../bundle.js";
import { createFixtureFetch, createSynthV2 } from "../fixtures/synthV2.js";

const synth = createSynthV2();
const FIXTURE_SOURCE = { id: "fixture", baseUrl: null, explicit: true, reason: "test" };

/** Fixture fetch wrapper that counts requests and can override files (404 / corrupt / delay). */
function instrumentedFetch(overrides = {}) {
  const base = createFixtureFetch(synth, { compress: false });
  const calls = [];
  const impl = async (url, init) => {
    const name = String(url).replace(/^.*\/fixture\//, "");
    calls.push(name);
    const o = overrides[name];
    if (o?.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
    if (o?.status) return new Response(o.body ?? "x", { status: o.status });
    if (o?.body) return new Response(o.body, { status: 200 });
    return base(url, init);
  };
  impl.calls = calls;
  return impl;
}

async function fixtureStore(overrides = {}) {
  const fetchImpl = instrumentedFetch(overrides);
  const store = createBundleStore({ fixtureLoader: async () => ({ synth, fetchImpl }) });
  await store.getState().load({ source: FIXTURE_SOURCE });
  return { store, fetchImpl };
}

describe("BundleStore resource state machine", () => {
  it("idle -> loading -> ready, with concurrent ensures sharing one request", async () => {
    const { store, fetchImpl } = await fixtureStore();
    const key = "xai:2010:night";
    expect(store.getState().getResource(key)).toBe(IDLE);
    const seen = [];
    const unsub = store.subscribe((s) => seen.push(s.resources[key]?.status ?? "idle"));
    const [a, b] = await Promise.all([store.getState().ensure(key), store.getState().ensure(key)]);
    unsub();
    expect(a).toBe(b);
    expect(a.status).toBe("ready");
    expect(seen).toContain("loading");
    expect(seen.at(-1)).toBe("ready");
    expect(fetchImpl.calls.filter((c) => c === "xai_2010_night.lstb.gz")).toHaveLength(1);
    expect(fetchImpl.calls.filter((c) => c === "xai_2010_features.lstb.gz")).toHaveLength(1);
    // A second frame of the same year reuses the shared feature file.
    await store.getState().ensure("xai:2010:day");
    expect(fetchImpl.calls.filter((c) => c === "xai_2010_features.lstb.gz")).toHaveLength(1);
  });

  it("legitimately absent resources are 'unavailable' with a reason, broken ones 'error'", async () => {
    const { store } = await fixtureStore({ "cube_ssp585_day.lstb.gz": { status: 404 }, "cube_ssp126_day.lstb.gz": { body: "not an lstb" } });
    const projectedXai = await store.getState().ensure("xai:2040:day");
    expect(projectedXai.status).toBe("unavailable");
    expect(projectedXai.reason).toMatch(/no day drivers.*1990–2025/);
    expect((await store.getState().ensure("xai:2041:day")).reason).toMatch(/not a frame year/);
    const missing = await store.getState().ensure("cube:day:ssp585");
    expect(missing.status).toBe("unavailable");
    expect(missing.reason).toMatch(/file missing/);
    const corrupt = await store.getState().ensure("cube:day:ssp126");
    expect(corrupt.status).toBe("error");
    expect(corrupt.reason).toMatch(/bad magic/);
    expect((await store.getState().ensure("cube:day:ssp370")).reason).toMatch(/not in this bundle/);
    expect((await store.getState().ensure("bogus:key")).reason).toMatch(/unknown resource/);
    expect((await store.getState().ensure("xai:2025:dtr")).status).toBe("unavailable");
  });

  it("derives the DTR cube from day and night", async () => {
    const { store } = await fixtureStore();
    const dtr = await store.getState().ensure("cube:dtr:obs");
    expect(dtr.status).toBe("ready");
    expect(dtr.data.mode).toBe("dtr");
    expect(dtr.data.years).toEqual(store.getState().timeline.obsYears);
  });

  it("builds v1-shaped facade epochs from XAI frames (keyed by SHAP group)", async () => {
    const { store } = await fixtureStore();
    const e = await store.getState().ensure("epoch:2025:night");
    expect(e.status).toBe("ready");
    const epoch = e.data;
    expect(Object.keys(epoch.shap)).toEqual(synth.manifest.groups.map((g) => g.id));
    expect(epoch.features.built).toBe(epoch.baseFeatures.frac_built);
    expect(epoch.index.get(epoch.cell_id[5])).toBe(5);
    expect(epoch.zone).toBeInstanceOf(Int8Array);
    expect(epoch.lon).toBeInstanceOf(Float64Array);
    expect(Number.isFinite(epoch.stats.lst_obs.p98)).toBe(true);
  });

  it("keeps at most 8 rasters (LRU), releasing evicted ones", async () => {
    const { store } = await fixtureStore();
    const keys = store.getState().timeline.obsYears.map((y) => `raster:day_${y}`);
    keys.push("raster:night_2025");
    for (const k of keys) {
      const r = await store.getState().ensure(k);
      expect(r.status, k).toBe("ready");
    }
    const resources = store.getState().resources;
    const held = Object.keys(resources).filter((k) => k.startsWith("raster:"));
    expect(held).toHaveLength(8);
    expect(held).not.toContain("raster:day_1990");
    const r = resources["raster:night_2025"].data;
    expect(r.values).toBeInstanceOf(Uint8Array);
    expect(r.values.length).toBe(r.width * r.height);
    expect(r.bitmap).toBeUndefined(); // pure-PNG decoder only (D22 d): no ImageBitmap is kept
    expect((await store.getState().ensure("raster:day_2040")).reason).toMatch(/2040: day not downscaled/);
    const preview = await store.getState().ensure("raster:day_2025:preview");
    expect(preview.data.width).toBeLessThan(r.width);
  });

  it("drops results of a superseded load (bundle switch) and reports progress per file", async () => {
    const fetchImpl = instrumentedFetch({ "cube_obs_day.lstb.gz": { delayMs: 30 } });
    const store = createBundleStore({ fixtureLoader: async () => ({ synth, fetchImpl }) });
    const first = store.getState().load({ source: FIXTURE_SOURCE });
    await new Promise((r) => setTimeout(r, 5));
    const second = store.getState().load({ source: FIXTURE_SOURCE });
    await Promise.all([first, second]);
    const s = store.getState();
    expect(s.status).toBe("ready");
    expect(s.generation).toBe(2);
    const ids = s.progress.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    const cubeLine = s.progress.find((p) => p.id === "cube:day:obs");
    expect(cubeLine.status).toBe("ok");
    expect(cubeLine.bytes).toBeGreaterThan(0);
  });

  it('reports status "empty" when the manifest is missing and "error" for a broken manifest', async () => {
    const fetch404 = vi.fn(async () => new Response("nope", { status: 404 }));
    const store = createBundleStore({ fetchImpl: fetch404 });
    await store.getState().load({ source: { id: "data", baseUrl: "/data", explicit: true, reason: "test" } });
    expect(store.getState().status).toBe("empty");
    expect((await store.getState().ensure("cells")).status).toBe("unavailable");

    const html = vi.fn(async () => new Response("<!doctype html><html></html>", { status: 200, headers: { "content-type": "text/html" } }));
    const store2 = createBundleStore({ fetchImpl: html });
    await store2.getState().load({ source: { id: "demo", baseUrl: "/demo", explicit: true, reason: "test" } });
    expect(store2.getState().status).toBe("empty");

    const bad = vi.fn(async () => new Response(JSON.stringify({ schema_version: "7.0", files: {}, timeline: { frames: [] } }), { status: 200 }));
    const store3 = createBundleStore({ fetchImpl: bad });
    await store3.getState().load({ source: { id: "data", baseUrl: "/data", explicit: true, reason: "test" } });
    expect(store3.getState().status).toBe("error");
    expect(store3.getState().error.message).toMatch(/newer than this dashboard/);
  });

  it("fails the boot with status 'error' when the required cells file is missing", async () => {
    const { store } = await fixtureStore({ "cells.lstb.gz": { status: 404 } });
    expect(store.getState().status).toBe("error");
    expect(store.getState().error.message).toMatch(/cells could not be loaded/);
  });
});

describe("bundle source resolution (SPEC §6)", () => {
  const env = { BASE_URL: "/" };
  const probeWith = (existing) => async (base) => (existing.includes(base) ? { schema_version: "2.0", files: {}, timeline: { frames: [{ year: 2025 }] } } : null);

  it("honours ?bundle= first, then VITE_DATA_BASE_URL, then data -> demo -> fixture", async () => {
    expect((await resolveBundleSource({ search: "?bundle=demo", env, probe: probeWith([]) })).id).toBe("demo");
    expect((await resolveBundleSource({ search: "?bundle=fixture", env, probe: probeWith([]) })).id).toBe("fixture");
    const custom = await resolveBundleSource({ search: "", env: { ...env, VITE_DATA_BASE_URL: "https://cdn.example/ncr/" }, probe: probeWith([]) });
    expect(custom).toMatchObject({ id: "custom", baseUrl: "https://cdn.example/ncr" });
    const data = await resolveBundleSource({ search: "", env, probe: probeWith(["/data", "/demo"]) });
    expect(data).toMatchObject({ id: "data", baseUrl: "/data", explicit: false });
    expect(data.manifest).toBeTruthy();
    expect((await resolveBundleSource({ search: "", env, probe: probeWith(["/demo"]) })).id).toBe("demo");
    const none = await resolveBundleSource({ search: "", env, probe: probeWith([]) });
    expect(none.id).toBe("fixture");
    expect(none.reason).toMatch(/run the notebook/);
    const failing = await resolveBundleSource({ search: "", env, probe: async () => Promise.reject(new Error("boom")) });
    expect(failing.id).toBe("fixture");
  });

  it("parses, detects and rewrites bundle parameters and schemas", () => {
    expect(requestedBundle("?bundle=DATA")).toBe("data");
    expect(requestedBundle("?bundle=evil")).toBeNull();
    expect(withBundleParam("?y=2040&bundle=data", "demo")).toBe("?y=2040&bundle=demo");
    expect(withBundleParam("?bundle=data", null)).toBe("");
    expect(bundleBaseUrl("demo", { BASE_URL: "/app/" })).toBe("/app/demo");
    expect(bundleFileUrl("/data/", "x.json")).toBe("/data/x.json");
    expect(bundleFileUrl(null, "x.json")).toBe("/fixture/x.json");
    expect(schemaMajor({ schema_version: "2.0" })).toBe(2);
    expect(detectSchema({ schema_version: "1.0", epochs: [2010], files: {} })).toBe("v1");
    expect(detectSchema({ schema_version: "2.1", timeline: { frames: [] }, files: {} })).toBe("v2");
    expect(detectSchema({ timeline: { frames: [] }, files: {} })).toBe("v2");
    expect(() => detectSchema({ files: {} })).toThrow(/neither/);
  });
});
