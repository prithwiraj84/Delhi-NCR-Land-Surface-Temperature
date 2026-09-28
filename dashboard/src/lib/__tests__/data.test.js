import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getDataBaseUrl,
  loadManifest,
  loadAsset,
  loadEpoch,
  prepareEpoch,
  clearDataCache,
  columnStats,
  DataLoadError,
  isGzipBytes,
  readBodyText,
} from "../data.js";
import { createFsFetch, fixture, gzippedFixture, FIXTURE_DIR } from "./testUtils.js";

function useFetch(impl) {
  vi.stubGlobal("fetch", impl);
  return impl;
}

beforeEach(() => clearDataCache());
afterEach(() => vi.unstubAllGlobals());

describe("getDataBaseUrl", () => {
  it("defaults to <BASE_URL>data without a trailing slash", () => {
    expect(getDataBaseUrl()).toBe("/data");
  });
});

describe("loadManifest", () => {
  it("loads and caches the manifest (one request for concurrent callers)", async () => {
    const fetchImpl = useFetch(createFsFetch(FIXTURE_DIR));
    const [a, b] = await Promise.all([loadManifest(), loadManifest()]);
    expect(a).toBe(b);
    expect(a.data_mode).toBe("synthetic");
    expect(fetchImpl.calls).toEqual(["/data/manifest.json"]);
  });

  it('maps a 404 to status "empty"', async () => {
    useFetch(createFsFetch(FIXTURE_DIR, { "manifest.json": { status: 404, contentType: "text/plain" } }));
    await expect(loadManifest()).rejects.toMatchObject({ name: "DataLoadError", status: "empty", httpStatus: 404 });
  });

  it('maps an SPA-fallback HTML page to status "empty"', async () => {
    useFetch(
      createFsFetch(FIXTURE_DIR, {
        "manifest.json": { status: 200, body: "<!doctype html><html></html>", contentType: "text/html" },
      }),
    );
    await expect(loadManifest()).rejects.toMatchObject({ status: "empty" });
  });

  it('maps server errors, network errors, bad JSON and malformed manifests to status "error"', async () => {
    useFetch(createFsFetch(FIXTURE_DIR, { "manifest.json": { status: 500, body: "boom" } }));
    await expect(loadManifest()).rejects.toMatchObject({ status: "error", httpStatus: 500 });

    clearDataCache();
    useFetch(createFsFetch(FIXTURE_DIR, { "manifest.json": new TypeError("Failed to fetch") }));
    await expect(loadManifest()).rejects.toThrow(/Network error/);

    clearDataCache();
    useFetch(createFsFetch(FIXTURE_DIR, { "manifest.json": { status: 200, body: "{not json" } }));
    await expect(loadManifest()).rejects.toThrow(/Invalid JSON/);

    clearDataCache();
    useFetch(createFsFetch(FIXTURE_DIR, { "manifest.json": { status: 200, body: '{"epochs": 3}' } }));
    await expect(loadManifest()).rejects.toThrow(/malformed/);
  });

  it("evicts failed requests so a retry can succeed", async () => {
    useFetch(createFsFetch(FIXTURE_DIR, { "manifest.json": { status: 503 } }));
    await expect(loadManifest()).rejects.toBeInstanceOf(DataLoadError);
    useFetch(createFsFetch(FIXTURE_DIR));
    await expect(loadManifest()).resolves.toMatchObject({ schema_version: "1.0" });
  });
});

describe("loadAsset", () => {
  it("loads declared assets and resolves null for undeclared keys", async () => {
    useFetch(createFsFetch(FIXTURE_DIR));
    const manifest = await loadManifest();
    const model = await loadAsset(manifest, "model");
    expect(model.format).toBe("lst-xgb-compact-v1");
    expect(await loadAsset(manifest, "not_a_file")).toBeNull();
    await expect(loadAsset(manifest, "epochs")).rejects.toThrow(/loadEpoch/);
  });

  it('reports a missing declared asset as status "error"', async () => {
    useFetch(createFsFetch(FIXTURE_DIR, { "zones.json": { status: 404, contentType: "text/plain" } }));
    const manifest = await loadManifest();
    await expect(loadAsset(manifest, "zones")).rejects.toMatchObject({ status: "error", httpStatus: 404 });
  });
});

describe("loadEpoch / prepareEpoch", () => {
  it("converts columns to typed arrays with NaN for nulls and attaches index + stats", async () => {
    const fetchImpl = useFetch(createFsFetch(FIXTURE_DIR));
    const manifest = await loadManifest();
    const epoch = await loadEpoch(manifest, 2025);
    const raw = fixture("epoch_2025.json");

    expect(epoch.year).toBe(2025);
    expect(epoch.n).toBe(12);
    expect(epoch.cell_size_m).toBe(1000);
    expect(epoch.base_value_c).toBeCloseTo(39.95, 9);
    expect(epoch.lon).toBeInstanceOf(Float64Array);
    expect(epoch.lat).toBeInstanceOf(Float64Array);
    expect(epoch.cell_id).toBeInstanceOf(Int32Array);
    expect(epoch.district).toBeInstanceOf(Int16Array);
    expect(epoch.zone).toBeInstanceOf(Int8Array);
    for (const key of ["lst_obs", "lst_pred", "lst_pred_oof", "resid_oof"]) expect(epoch[key]).toBeInstanceOf(Float32Array);
    expect(Object.keys(epoch.features)).toEqual(manifest.features.map((f) => f.name));
    expect(Object.keys(epoch.shap)).toEqual(manifest.features.map((f) => f.name));
    expect(epoch.features.ndvi).toBeInstanceOf(Float32Array);
    expect(epoch.shap.ndvi).toBeInstanceOf(Float32Array);

    expect(Number.isNaN(epoch.features.ndvi[5])).toBe(true);
    expect(Number.isNaN(epoch.lst_pred_oof[3])).toBe(true);
    expect(Number.isNaN(epoch.resid_oof[3])).toBe(true);
    expect(epoch.lon[1]).toBe(raw.lon[1]);

    expect(epoch.index.get(raw.cell_id[7])).toBe(7);
    expect(epoch.index.size).toBe(12);

    const obs = raw.lst_obs;
    expect(epoch.stats.lst_obs.min).toBeCloseTo(Math.min(...obs), 4);
    expect(epoch.stats.lst_obs.max).toBeCloseTo(Math.max(...obs), 4);
    expect(epoch.stats.lst_obs.mean).toBeCloseTo(obs.reduce((a, b) => a + b, 0) / obs.length, 4);
    expect(epoch.stats.lst_obs.p02).toBeGreaterThanOrEqual(epoch.stats.lst_obs.min);
    expect(epoch.stats.lst_obs.p98).toBeLessThanOrEqual(epoch.stats.lst_obs.max);
    expect(epoch.stats.resid_oof.count).toBe(11);
    expect(Object.keys(epoch.stats.shapMaxAbs)).toEqual(manifest.features.map((f) => f.name));
    Object.values(epoch.stats.shapMaxAbs).forEach((v) => expect(v).toBeGreaterThan(0));

    // Cached: a second call makes no new request and returns the same object.
    const again = await loadEpoch(manifest, 2025);
    expect(again).toBe(epoch);
    expect(fetchImpl.calls.filter((u) => u.endsWith("epoch_2025.json"))).toHaveLength(1);
  });

  it("wraps malformed epochs in a DataLoadError", async () => {
    const broken = fixture("epoch_2020.json");
    broken.lat = broken.lat.slice(1);
    useFetch(createFsFetch(FIXTURE_DIR, { "epoch_2020.json": { status: 200, body: JSON.stringify(broken) } }));
    const manifest = await loadManifest();
    await expect(loadEpoch(manifest, 2020)).rejects.toThrow(/Epoch 2020 .* malformed: column "lat" has length 11/);
  });

  it("fills optional OOF columns with NaN and rejects missing features", () => {
    const manifest = fixture("manifest.json");
    const raw = fixture("epoch_2020.json");
    delete raw.lst_pred_oof;
    delete raw.resid_oof;
    const epoch = prepareEpoch(raw, manifest);
    expect(Array.from(epoch.lst_pred_oof).every(Number.isNaN)).toBe(true);
    delete raw.shap.ndbi;
    expect(() => prepareEpoch(raw, manifest)).toThrow(/shap\["ndbi"\]/);
  });
});

describe("gzip-compressed bundle files (SPEC §4, decision D3)", () => {
  /** Fixture manifest whose epoch/dependence names point at .json.gz files. */
  function gzManifestBody() {
    const manifest = fixture("manifest.json");
    manifest.files.epochs = { 2020: "epoch_2020.json.gz", 2025: "epoch_2025.json.gz" };
    manifest.files.dependence = "dependence.json.gz";
    return JSON.stringify(manifest);
  }

  it("detects the gzip magic bytes", () => {
    expect(isGzipBytes(gzippedFixture("zones.json"))).toBe(true);
    expect(isGzipBytes(new TextEncoder().encode("{}"))).toBe(false);
    expect(isGzipBytes(new Uint8Array(1))).toBe(false);
    expect(isGzipBytes(null)).toBe(false);
  });

  it("inflates gzipped epoch and asset bytes to the same data as the plain files", async () => {
    useFetch(
      createFsFetch(FIXTURE_DIR, {
        "manifest.json": { status: 200, body: gzManifestBody() },
        "epoch_2025.json.gz": { status: 200, body: gzippedFixture("epoch_2025.json"), contentType: "application/gzip" },
        "dependence.json.gz": {
          status: 200,
          body: gzippedFixture("dependence.json"),
          contentType: "application/octet-stream",
        },
      }),
    );
    const manifest = await loadManifest();
    const epoch = await loadEpoch(manifest, 2025);
    const plain = prepareEpoch(fixture("epoch_2025.json"), manifest);
    expect(epoch.n).toBe(plain.n);
    expect(Array.from(epoch.lst_obs)).toEqual(Array.from(plain.lst_obs));
    expect(Array.from(epoch.shap.ndvi)).toEqual(Array.from(plain.shap.ndvi));
    expect(await loadAsset(manifest, "dependence")).toEqual(fixture("dependence.json"));
  });

  it("accepts a .gz name whose body the server already inflated (Content-Encoding: gzip)", async () => {
    const plainBody = new TextEncoder().encode(JSON.stringify(fixture("epoch_2025.json")));
    useFetch(
      createFsFetch(FIXTURE_DIR, {
        "manifest.json": { status: 200, body: gzManifestBody() },
        "epoch_2025.json.gz": { status: 200, body: plainBody, contentType: "application/json" },
      }),
    );
    const manifest = await loadManifest();
    const epoch = await loadEpoch(manifest, 2025);
    expect(epoch.n).toBe(12);
    expect(epoch.year).toBe(2025);
  });

  it("keeps plain .json files working and reads them through arrayBuffer()", async () => {
    const fetchImpl = useFetch(createFsFetch(FIXTURE_DIR));
    const manifest = await loadManifest();
    const epoch = await loadEpoch(manifest, 2020);
    expect(epoch.year).toBe(2020);
    expect(fetchImpl.calls).toContain("/data/epoch_2020.json");
  });

  it("reports corrupt gzip data as a load error", async () => {
    const corrupt = gzippedFixture("epoch_2025.json").slice(0, 40);
    useFetch(
      createFsFetch(FIXTURE_DIR, {
        "manifest.json": { status: 200, body: gzManifestBody() },
        "epoch_2025.json.gz": { status: 200, body: corrupt, contentType: "application/gzip" },
      }),
    );
    const manifest = await loadManifest();
    await expect(loadEpoch(manifest, 2025)).rejects.toMatchObject({ name: "DataLoadError", status: "error" });
  });

  it("readBodyText falls back to text() for Response-likes without arrayBuffer()", async () => {
    await expect(readBodyText({ text: async () => '{"a":1}' })).resolves.toBe('{"a":1}');
  });
});

describe("columnStats", () => {
  it("ignores non-finite values and interpolates percentiles", () => {
    const s = columnStats(Float32Array.from([NaN, 0, 10, 20, 30, 40, Infinity]));
    expect(s).toMatchObject({ min: 0, max: 40, mean: 20, count: 5 });
    expect(s.p02).toBeCloseTo(0.8, 6);
    expect(s.p98).toBeCloseTo(39.2, 6);
    expect(columnStats(new Float32Array(0)).count).toBe(0);
  });
});
