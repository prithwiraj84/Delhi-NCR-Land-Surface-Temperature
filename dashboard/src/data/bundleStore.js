/**
 * BundleStore (UI_SPEC §7 "DataContext.jsx: BundleStore"): the single owner of the web bundle in
 * memory — source resolution, boot sequence with real progress events, and a keyed resource
 * state machine for everything loaded lazily (cubes, XAI frames, rasters, small assets, epochs).
 *
 * It is a vanilla zustand store (no React), so the map engine and tests can use it directly
 * (`getState()`, `subscribe()`); React reads it through the hooks in `hooks.js`.
 *
 * Resource state machine (per key):   idle ──ensure──▶ loading ──▶ ready | unavailable | error
 *   - `unavailable` = the bundle legitimately does not have it (v1 bundle has no night; frame has
 *     no XAI; file 404): `reason` says why, in user-facing words;
 *   - `error` = it should exist but failed (network, corrupt file, contract violation);
 *   - concurrent `ensure(key)` calls share one in-flight promise; `ensure` never rejects;
 *   - every async step checks the load generation, so results of a superseded bundle are dropped.
 *
 * Keys
 *   cells · series · districts · rasterIndex · asset:<shapGlobal|dependence|zones|metrics|
 *   interactions|coupling|provenance> · model:<mode> · cube:<day|night|dtr>:<obs|sspXXX> ·
 *   zones:<mode> · xai:<year>:<mode> · xaiFeatures:<year> · epoch:<year>:<mode> (v1-shaped, for
 *   the useData() facade) · raster:<mode>_<year>[:preview]
 *
 * Boot (status "ready" when done): v2 → manifest, cells (required), series, districts, raster
 * index, the observation cube of the first available mode; v1 → manifest + every epoch (the
 * adapter needs them all to build the cube, domains and series) and districts.
 */

import { createStore } from "zustand/vanilla";
import { DataLoadError, prepareEpoch, setDataBaseUrl } from "../lib/data.js";
import { bundleFileUrl, detectSchema, resolveBundleSource } from "./bundle.js";
import { cellsFromLstb } from "./cells.js";
import { cubeFromLstb, deriveDtrCube, zoneFrame, zonesFromLstb } from "./cubes.js";
import { fetchBytes, parseJsonBytes } from "./fetch.js";
import { parseLstb } from "./lstb.js";
import { createLru, disposeRaster, normalizeRasterIndex, rasterEntry, RASTER_LRU_CAPACITY } from "./rasters.js";
import { normalizeSeries } from "./series.js";
import { buildTimeline, cubeFileFor, frameAt, modeUnavailableReason, normalizeSspId, seriesYears } from "./timeline.js";
import { adaptV1Bundle, V1_UNAVAILABLE, wrapV1Asset } from "./v1Adapter.js";
import { createWorkerClient } from "./workerClient.js";
import { groupFeatureMetas, v1EpochFromXai, xaiFromLstb } from "./xai.js";

export const IDLE = Object.freeze({ status: "idle", data: null, reason: null });
export const RESOURCE_STATUSES = Object.freeze(["idle", "loading", "ready", "unavailable", "error"]);

/** manifest.files key of each small asset. */
export const ASSET_FILES = Object.freeze({
  shapGlobal: "shap_global",
  dependence: "dependence",
  zones: "zones",
  metrics: "metrics",
  interactions: "interactions",
  coupling: "coupling",
  provenance: "provenance",
});

/**
 * The data layer inflates every gzip / PNG payload with the platform DecompressionStream (no
 * bundled inflater: SPEC §6 allow-list). Without it the app shows this explicit unsupported-browser
 * state at boot (D22 f) instead of a generic "cells could not be loaded".
 */
export const UNSUPPORTED_BROWSER_MESSAGE = "This browser cannot decompress the data bundle (needs Chrome/Edge 80+, Firefox 113+ or Safari 16.4+).";

/** True when the platform can inflate gzip / deflate streams. */
export const decompressionSupported = () => typeof globalThis.DecompressionStream === "function";

const XAI_LRU = 6;
const EPOCH_LRU = 4;
const PROGRESS_THROTTLE_MS = 100;

const entry = (status, data = null, reason = null, extra = null) => Object.freeze({ status, data, reason, ...(extra ?? {}) });
const unavailable = (reason) => entry("unavailable", null, reason);

function initialState() {
  return {
    status: "idle",
    error: null,
    source: null,
    schema: null,
    manifest: null,
    manifestV2: null,
    timeline: null,
    groupsMeta: [],
    resources: {},
    progress: [],
    bootProgress: null,
    warnings: [],
    validation: null,
    generation: 0,
  };
}

const describeError = (error) => ({
  message: error?.message ?? String(error),
  status: error?.status ?? "error",
  url: error?.url ?? null,
  httpStatus: error?.httpStatus ?? null,
});

/**
 * Create a BundleStore.
 * @param {{fetchImpl?: Function|null, workerClient?: object|null, fixtureLoader?: (() => Promise<object>)|null,
 *          env?: object|null}} [options]
 *   `fetchImpl` overrides `globalThis.fetch` for real URL sources (tests); `fixtureLoader` returns
 *   `{synth, fetchImpl}` for the in-memory fixture (defaults to a dynamic import of synthV2.js).
 */
export function createBundleStore({ fetchImpl = null, workerClient = null, fixtureLoader = null, env = null } = {}) {
  /** Per-load context (not in state: holds functions, caches and decoded intermediates). */
  let ctx = null;
  const inflight = new Map();

  const store = createStore((set, get) => {
    // ---- progress -------------------------------------------------------------------------
    function progressStart(id, label, file = null, status = "loading") {
      const gen = get().generation;
      set((s) => {
        if (s.generation !== gen) return {};
        const others = s.progress.filter((p) => p.id !== id);
        return { progress: [...others, { id, label, file, status, bytes: 0, total: null, ms: 0, startedAt: Date.now() }] };
      });
      let last = 0;
      const update = (patch) =>
        set((s) => {
          if (s.generation !== gen) return {};
          return { progress: s.progress.map((p) => (p.id === id ? { ...p, ...patch, ms: Date.now() - p.startedAt } : p)) };
        });
      return {
        bytes: ({ loaded, total }) => {
          const now = Date.now();
          if (now - last < PROGRESS_THROTTLE_MS) return;
          last = now;
          update({ bytes: loaded, total: total ?? null });
        },
        done: (status = "ok", extra = {}) => update({ status, ...extra }),
      };
    }

    // ---- resource bookkeeping ----------------------------------------------------------------
    function setResource(key, value, gen) {
      set((s) => (s.generation !== gen ? {} : { resources: { ...s.resources, [key]: value } }));
    }

    function dropResource(key) {
      set((s) => {
        if (!(key in s.resources)) return {};
        const next = { ...s.resources };
        delete next[key];
        return { resources: next };
      });
    }

    // ---- file access ---------------------------------------------------------------------------
    function fileUrl(name) {
      return bundleFileUrl(ctx.baseUrl, name);
    }

    async function getBytes(name, { label = name, progressId = null } = {}) {
      const progress = progressId ? progressStart(progressId, label, name) : null;
      try {
        const result = await ctx.worker.run("inflate", { url: fileUrl(name) }, { onProgress: progress?.bytes });
        progress?.done("ok", { bytes: result.compressedBytes, total: result.compressedBytes });
        return new Uint8Array(result.buffer);
      } catch (error) {
        progress?.done(error?.status === "missing" ? "missing" : "error", { error: error?.message ?? String(error) });
        throw error;
      }
    }

    async function getJson(name, opts) {
      const bytes = await getBytes(name, opts);
      return parseJsonBytes(bytes, fileUrl(name));
    }

    async function getLstb(name, opts) {
      const bytes = await getBytes(name, opts);
      try {
        return parseLstb(bytes);
      } catch (cause) {
        throw new DataLoadError(`${name}: ${cause.message}`, { url: fileUrl(name), cause });
      }
    }

    // ---- loaders (return data, or throw; `Unavailable` for legitimate absence) -------------------
    class Unavailable extends Error {}
    const isV1 = () => get().schema === "v1";
    const manifest = () => get().manifest;
    const timeline = () => get().timeline;

    async function loadCells() {
      if (isV1()) return ctx.adapted.cells;
      const name = manifest().files?.cells;
      if (!name) throw new DataLoadError("manifest.files.cells is not declared");
      return cellsFromLstb(await getLstb(name, { progressId: "cells", label: "cells" }), manifest());
    }

    async function loadSeries() {
      if (isV1()) return ctx.adapted.series;
      const name = manifest().files?.series;
      if (!name) throw new Unavailable("this bundle has no timeline series");
      return normalizeSeries(await getJson(name, { progressId: "series", label: "timeline series" }));
    }

    async function loadDistricts() {
      const name = manifest().files?.districts;
      if (!name) throw new Unavailable("this bundle has no district boundaries");
      return getJson(name, { progressId: "districts", label: "district boundaries" });
    }

    async function loadRasterIndex() {
      if (isV1()) throw new Unavailable(`250 m rasters are ${V1_UNAVAILABLE}`);
      const name = timeline().rasterIndexFile ?? manifest().files?.raster_index;
      if (!name) throw new Unavailable("this bundle has no 250 m rasters");
      return normalizeRasterIndex(await getJson(name, { progressId: "raster_index", label: "raster index" }));
    }

    async function loadAsset(name) {
      const fileKey = ASSET_FILES[name];
      if (!fileKey) throw new Unavailable(`unknown asset "${name}"`);
      const file = manifest().files?.[fileKey];
      if (typeof file !== "string" || !file) throw new Unavailable(`this bundle has no ${fileKey}`);
      const json = await getJson(file, { progressId: `asset:${name}`, label: file });
      return isV1() ? wrapV1Asset(name, json) : json;
    }

    async function loadModel(mode) {
      const files = manifest().files?.model;
      const file = typeof files === "string" ? (mode === "day" ? files : null) : files?.[mode];
      if (!file) throw new Unavailable(isV1() && mode !== "day" ? `${mode} model ${V1_UNAVAILABLE}` : `no ${mode} model in this bundle`);
      return getJson(file, { progressId: `model:${mode}`, label: file });
    }

    async function loadCube(mode, series) {
      const tl = timeline();
      if (mode === "dtr") {
        const [day, night] = await Promise.all([ensureData(`cube:day:${series}`), ensureData(`cube:night:${series}`)]);
        return deriveDtrCube(day, night);
      }
      const reason = modeUnavailableReason(tl, mode);
      if (reason) throw new Unavailable(reason);
      if (isV1()) {
        const cube = ctx.adapted.cubes[`${mode}:${series}`];
        if (!cube) throw new Unavailable(series === "obs" ? `${mode} observations ${V1_UNAVAILABLE}` : `projections are ${V1_UNAVAILABLE}`);
        return cube;
      }
      if (series !== "obs" && !tl.scenarioIds.includes(series)) throw new Unavailable(`scenario ${series} is not in this bundle`);
      const file = cubeFileFor(tl, mode, series);
      if (!file) throw new Unavailable(`no ${series} cube for ${mode} in this bundle`);
      const lstb = await getLstb(file, { progressId: `cube:${mode}:${series}`, label: file });
      return cubeFromLstb(lstb, { mode, series, years: seriesYears(tl, series) });
    }

    async function loadZones(mode) {
      const tl = timeline();
      if (isV1()) {
        const z = ctx.adapted.zones[mode];
        if (!z) throw new Unavailable(`${mode} zones ${V1_UNAVAILABLE}`);
        return z;
      }
      const file = cubeFileFor(tl, mode, "zones");
      if (!file) throw new Unavailable(`no ${mode} zones cube in this bundle`);
      const lstb = await getLstb(file, { progressId: `zones:${mode}`, label: file });
      const yearsBySeries = { obs: tl.obsYears, ...Object.fromEntries(tl.scenarioIds.map((s) => [s, tl.projYears])) };
      return zonesFromLstb(lstb, { mode, yearsBySeries });
    }

    async function loadXaiFeatures(year) {
      const file = ["day", "night"].map((m) => manifest().files?.xai?.[m]?.[String(year)]?.features).find(Boolean);
      if (!file) throw new Unavailable(`${year}: no feature file`);
      return getLstb(file, { progressId: `xaiFeatures:${year}`, label: file });
    }

    async function loadXai(year, mode) {
      const tl = timeline();
      const frame = frameAt(tl, year);
      if (!frame) throw new Unavailable(`${year} is not a frame year`);
      if (mode === "dtr") throw new Unavailable("drivers are explained per mode (day or night), not for DTR");
      if (!frame.xai?.[mode]) {
        const withXai = tl.frames.filter((f) => f.xai?.[mode]).map((f) => f.year);
        const span = withXai.length ? `${withXai[0]}–${withXai[withXai.length - 1]}` : "none";
        throw new Unavailable(isV1() && mode !== "day" ? `${mode} drivers ${V1_UNAVAILABLE}` : `${year}: no ${mode} drivers (frames with XAI: ${span})`);
      }
      if (isV1()) {
        await ensureData(`epoch:${year}:day`);
        return ctx.adapted.xai(year);
      }
      const files = manifest().files?.xai?.[mode]?.[String(year)];
      if (!files?.shap) throw new DataLoadError(`manifest.files.xai.${mode}.${year} is missing although the frame has xai=true`);
      const [shapFile, featuresFile] = await Promise.all([
        getLstb(files.shap, { progressId: `xai:${year}:${mode}`, label: files.shap }),
        files.features ? ensureData(`xaiFeatures:${year}`) : Promise.resolve(null),
      ]);
      return xaiFromLstb({ shapFile, featuresFile, groups: (manifest().groups ?? []).map((g) => g.id), year, mode });
    }

    async function loadEpoch(year, mode) {
      if (isV1()) {
        if (mode !== "day") throw new Unavailable(`${mode} ${V1_UNAVAILABLE}`);
        const epoch = ctx.adapted?.epochs?.[year];
        if (!epoch) throw new Unavailable(`${year} is not an epoch of this bundle`);
        return epoch;
      }
      const [xai, cells, zones] = await Promise.all([ensureData(`xai:${year}:${mode}`), ensureData("cells"), ensureEntry(`zones:${mode}`)]);
      return v1EpochFromXai(xai, {
        cells,
        groupsMeta: get().groupsMeta,
        zone: zones.status === "ready" ? zoneFrame(zones.data, "obs", year) : null,
        cellSizeM: Number(manifest().study_area?.grid_res_m) || 1000,
      });
    }

    async function loadRaster(key, preview) {
      const index = await ensureData("rasterIndex");
      const { entry: e, reason } = rasterEntry(index, key, { preview });
      if (!e) throw new Unavailable(reason);
      const file = preview ? e.preview : e.file;
      const progressId = `raster:${key}${preview ? ":preview" : ""}`;
      const progress = progressStart(progressId, file, file);
      let result;
      try {
        result = await ctx.worker.run("raster", { url: fileUrl(file) }, { onProgress: progress.bytes });
        progress.done("ok", { bytes: result.compressedBytes });
      } catch (error) {
        progress.done(error?.status === "missing" ? "missing" : "error", { error: error?.message });
        throw error;
      }
      return {
        key,
        preview,
        values: result.values,
        flags: result.flags,
        width: result.width,
        height: result.height,
        bounds: index.bounds,
        lo: e.lo,
        hi: e.hi,
        tier: e.tier,
        downscaled: e.downscaled,
      };
    }

    /** Dispatch a resource key to its loader. */
    function loaderFor(key) {
      const parts = key.split(":");
      switch (parts[0]) {
        case "cells":
          return loadCells;
        case "series":
          return loadSeries;
        case "districts":
          return loadDistricts;
        case "rasterIndex":
          return loadRasterIndex;
        case "asset":
          return () => loadAsset(parts[1]);
        case "model":
          return () => loadModel(parts[1]);
        case "cube":
          return () => loadCube(parts[1], parts[2] === "obs" ? "obs" : normalizeSspId(parts[2]));
        case "zones":
          return () => loadZones(parts[1]);
        case "xaiFeatures":
          return () => loadXaiFeatures(Number(parts[1]));
        case "xai":
          return () => loadXai(Number(parts[1]), parts[2]);
        case "epoch":
          return () => loadEpoch(Number(parts[1]), parts[2] ?? "day");
        case "raster":
          return () => loadRaster(parts[1], parts[2] === "preview");
        default:
          return null;
      }
    }

    function touchLru(key) {
      if (!ctx) return;
      if (key.startsWith("raster:")) ctx.rasterLru.set(key, true);
      else if (key.startsWith("xai:")) ctx.xaiLru.set(key, true);
      else if (key.startsWith("epoch:") && get().schema === "v2") ctx.epochLru.set(key, true);
    }

    /**
     * Ensure a resource is loaded; resolves with its (frozen) entry {status, data, reason}.
     * Never rejects.
     */
    function ensureEntry(key) {
      const current = get().resources[key];
      if (current && current.status !== "idle" && current.status !== "loading") {
        if (current.status === "ready") touchLru(key);
        return Promise.resolve(current);
      }
      if (inflight.has(key)) return inflight.get(key);
      const state = get();
      if (!ctx || state.status === "idle" || state.status === "error" || state.status === "empty") {
        return Promise.resolve(unavailable(state.status === "loading" ? "bundle still loading" : "bundle not loaded"));
      }
      const loader = loaderFor(key);
      if (!loader) return Promise.resolve(unavailable(`unknown resource "${key}"`));
      const gen = state.generation;
      setResource(key, entry("loading"), gen);
      const promise = (async () => {
        let result;
        try {
          const data = await loader();
          result = entry("ready", data);
        } catch (error) {
          if (error instanceof Unavailable) result = unavailable(error.message);
          else if (error?.status === "missing") result = unavailable(`file missing: ${error.url ?? key}`);
          else {
            console.warn(`[bundle] ${key} failed:`, error);
            result = entry("error", null, error?.message ?? String(error), { error: describeError(error) });
          }
        }
        if (get().generation === gen) {
          setResource(key, result, gen);
          if (result.status === "ready") touchLru(key);
        }
        return result;
      })().finally(() => {
        if (inflight.get(key) === promise) inflight.delete(key);
      });
      inflight.set(key, promise);
      return promise;
    }

    /** Ensure + unwrap: resolves with data, rejects with the reason (for internal composition). */
    async function ensureData(key) {
      const e = await ensureEntry(key);
      if (e.status === "ready") return e.data;
      const err = e.status === "unavailable" ? new Unavailable(e.reason) : new DataLoadError(e.reason ?? `${key} failed`);
      throw err;
    }

    // ---- boot -----------------------------------------------------------------------------------
    async function bootV2(gen) {
      const tl = get().timeline;
      const firstMode = tl.modeIds[0] ?? "day";
      const required = ensureEntry("cells");
      const optional = [ensureEntry("series"), ensureEntry("districts"), ensureEntry("rasterIndex"), ensureEntry(`cube:${firstMode}:obs`)];
      const cells = await required;
      await Promise.all(optional);
      if (get().generation !== gen) return;
      if (cells.status !== "ready") throw new DataLoadError(`cells could not be loaded: ${cells.reason}`);
    }

    async function bootV1(gen, m) {
      const years = m.epochs.map(Number);
      const epochs = {};
      await Promise.all(
        years.map(async (y) => {
          const file = m.files?.epochs?.[String(y)] ?? `epoch_${y}.json`;
          const raw = await getJson(file, { progressId: `epoch:${y}`, label: file });
          epochs[y] = prepareEpoch(raw, m);
        }),
      );
      if (get().generation !== gen) return;
      const adapted = adaptV1Bundle({ manifest: m, epochs });
      ctx.adapted = adapted;
      set({
        manifestV2: adapted.manifestV2,
        timeline: adapted.timeline,
        groupsMeta: m.features ?? [],
        resources: {
          ...get().resources,
          cells: entry("ready", adapted.cells),
          series: entry("ready", adapted.series),
          "cube:day:obs": entry("ready", adapted.cubes["day:obs"]),
          "zones:day": entry("ready", adapted.zones.day),
          ...Object.fromEntries(years.map((y) => [`epoch:${y}:day`, entry("ready", epochs[y])])),
        },
      });
      await ensureEntry("districts");
    }

    function disposeContext() {
      if (!ctx) return;
      try {
        ctx.rasterLru.clear();
      } catch (_error) {
        // ignore
      }
      ctx.worker?.dispose?.();
      ctx = null;
    }

    /**
     * Load a bundle (resolves the source first). Safe to call again (reload / bundle switch):
     * the previous load is superseded and its resources are released.
     * @param {{search?: string, source?: object}} [options] `source` skips resolution
     */
    async function load({ search = typeof location !== "undefined" ? location.search : "", source = null } = {}) {
      const gen = get().generation + 1;
      disposeContext();
      inflight.clear();
      set({ ...initialState(), status: "loading", generation: gen });
      if (!decompressionSupported()) {
        set({ status: "error", error: { message: UNSUPPORTED_BROWSER_MESSAGE, status: "unsupported", url: null, httpStatus: null } });
        return get();
      }
      const t0 = Date.now();
      try {
        const resolved = source ?? (await resolveBundleSource({ search, env: env ?? undefined, fetchImpl: fetchImpl ?? globalThis.fetch }));
        if (get().generation !== gen) return get();
        let effectiveFetch = fetchImpl ?? null;
        let fixture = null;
        if (resolved.id === "fixture") {
          const loader = fixtureLoader ?? (async () => {
            const mod = await import("./fixtures/synthV2.js");
            const synth = mod.createSynthV2();
            return { synth, fetchImpl: mod.createFixtureFetch(synth) };
          });
          fixture = await loader();
          effectiveFetch = fixture.fetchImpl;
        }
        setDataBaseUrl(resolved.baseUrl ?? null);
        const rasterLru = createLru(RASTER_LRU_CAPACITY, (key) => {
          const res = get().resources[key];
          if (res?.data) disposeRaster(res.data);
          dropResource(key);
        });
        ctx = {
          baseUrl: resolved.baseUrl,
          fetchImpl: effectiveFetch ?? globalThis.fetch,
          worker: workerClient ?? createWorkerClient({ fetchImpl: effectiveFetch }),
          rasterLru,
          xaiLru: createLru(XAI_LRU, (key) => dropResource(key)),
          epochLru: createLru(EPOCH_LRU, (key) => dropResource(key)),
          adapted: null,
          fixture,
        };
        set({ source: { id: resolved.id, baseUrl: resolved.baseUrl, explicit: resolved.explicit, reason: resolved.reason } });

        const progress = progressStart("manifest", "manifest.json", "manifest.json");
        let m = resolved.manifest ?? null;
        if (m) progress.done("ok");
        else {
          try {
            const { bytes } = await fetchBytes(bundleFileUrl(ctx.baseUrl, "manifest.json"), { fetchImpl: ctx.fetchImpl, onProgress: progress.bytes });
            m = await parseJsonBytes(bytes, "manifest.json");
            progress.done("ok", { bytes: bytes.byteLength });
          } catch (error) {
            progress.done(error?.status === "missing" ? "missing" : "error");
            if (error?.status === "missing") {
              set({ status: "empty", error: describeError(error) });
              return get();
            }
            throw error;
          }
        }
        if (get().generation !== gen) return get();
        const schema = detectSchema(m);
        set({ schema, manifest: m });
        if (schema === "v2") {
          const tl = buildTimeline(m, { schema: "v2" });
          set({ manifestV2: m, timeline: tl, groupsMeta: groupFeatureMetas(m) });
          await bootV2(gen);
        } else {
          await bootV1(gen, m);
        }
        if (get().generation !== gen) return get();
        // `bootProgress` freezes the boot log (the DataProvider facade exposes it after boot, so
        // later background loads do not re-render every useData() consumer).
        set({ status: "ready", loadedAt: Date.now(), bootMs: Date.now() - t0, bootProgress: get().progress });
      } catch (error) {
        if (get().generation !== gen) return get();
        console.warn("[bundle] load failed:", error);
        set({ status: error?.status === "empty" ? "empty" : "error", error: describeError(error) });
      }
      return get();
    }

    return {
      ...initialState(),
      load,
      reload: () => load({ source: get().source ? { ...get().source, manifest: null } : null }),
      ensure: ensureEntry,
      ensureData: (key) => ensureData(key),
      /** Mark a ready resource as used (LRU recency; rasters / XAI / epochs). No load, no state change. */
      touch: (key) => {
        if (get().resources[key]?.status === "ready") touchLru(key);
      },
      /** Current entry of a key (IDLE when never requested). */
      getResource: (key) => get().resources[key] ?? IDLE,
      /** Kick off several loads without awaiting (idle prefetch). */
      prefetch: (keys) => {
        for (const key of keys ?? []) ensureEntry(key);
      },
      /** Drop a ready resource (frees memory; it reloads on the next ensure). */
      release: (key) => {
        const res = get().resources[key];
        if (key.startsWith("raster:") && res?.data) disposeRaster(res.data);
        dropResource(key);
      },
      setValidation: (validation) => set({ validation }),
      addWarning: (message) => set((s) => ({ warnings: [...s.warnings, message] })),
      /** Fixture handle (in-memory bundle) when the source is "fixture". */
      fixture: () => ctx?.fixture ?? null,
      dispose: () => {
        disposeContext();
        inflight.clear();
        set({ ...initialState(), generation: get().generation + 1 });
      },
    };
  });
  return store;
}

/** App-wide default store (the DataProvider uses it unless given another one). */
export const bundleStore = createBundleStore();
