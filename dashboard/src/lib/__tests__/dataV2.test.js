import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDataCache,
  dataUrl,
  getDataBaseUrl,
  getDefaultDataBaseUrl,
  gunzipToBytes,
  gunzipToText,
  isUsableManifest,
  loadManifest,
  setDataBaseUrl,
} from "../data.js";
import { buildTimeline } from "../../data/timeline.js";
import { createSynthV2 } from "../../data/fixtures/synthV2.js";
import { manifestSchemaMajor, validateAnyBundle } from "../validate.js";
import { createFsFetch, fixture, FIXTURE_DIR } from "./testUtils.js";

beforeEach(() => clearDataCache());
afterEach(() => {
  setDataBaseUrl(null);
  vi.unstubAllGlobals();
});

describe("lib/data v2 extensions", () => {
  it("switches the bundle base at run time (bundle resolver) and restores the default", () => {
    expect(getDataBaseUrl()).toBe("/data");
    setDataBaseUrl("/demo/");
    expect(getDataBaseUrl()).toBe("/demo");
    expect(dataUrl("manifest.json")).toBe("/demo/manifest.json");
    expect(getDefaultDataBaseUrl()).toBe("/data");
    setDataBaseUrl("  ");
    expect(getDataBaseUrl()).toBe("/data");
  });

  it("accepts v1 (epochs) and v2 (timeline.frames) manifests, rejects others", async () => {
    expect(isUsableManifest({ epochs: [2010], files: {} })).toBe(true);
    expect(isUsableManifest({ timeline: { frames: [{ year: 2025 }] }, files: {} })).toBe(true);
    expect(isUsableManifest({ timeline: {}, files: {} })).toBe(false);
    expect(isUsableManifest({ epochs: [2010] })).toBe(false);
    const v2 = JSON.stringify(createSynthV2().manifest);
    vi.stubGlobal("fetch", createFsFetch(FIXTURE_DIR, { "manifest.json": { status: 200, body: v2 } }));
    const m = await loadManifest();
    expect(m.schema_version).toBe("2.0");
  });

  it("inflates gzip to bytes and text with a stream source (works without Blob.stream)", async () => {
    const raw = new TextEncoder().encode('{"a": [1, 2, 3]}');
    const gz = new Uint8Array(zlib.gzipSync(raw));
    expect(Array.from(await gunzipToBytes(gz))).toEqual(Array.from(raw));
    expect(await gunzipToText(gz)).toBe('{"a": [1, 2, 3]}');
  });
});

describe("lib/validate validateAnyBundle", () => {
  it("routes v1 manifests to the SPEC_v1 validator and v2 to validateV2", () => {
    expect(manifestSchemaMajor({ schema_version: "2.0" })).toBe(2);
    expect(manifestSchemaMajor({})).toBe(1);
    const v1 = validateAnyBundle({ manifest: fixture("manifest.json"), epochs: { 2025: fixture("epoch_2025.json") } });
    expect(v1.schema).toBe("v1");
    expect(v1.errors).toEqual([]);
    const synth = createSynthV2();
    const v2 = validateAnyBundle({ manifest: synth.manifest, timeline: buildTimeline(synth.manifest) });
    expect(v2.schema).toBe("v2");
    expect(v2.errors).toEqual([]);
    expect(v2.checked).toEqual(["manifest", "timeline"]);
  });
});
