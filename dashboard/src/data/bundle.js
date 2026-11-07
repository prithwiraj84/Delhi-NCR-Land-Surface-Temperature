/**
 * Bundle resolution and schema detection (SPEC §6, UI_SPEC §10).
 *
 * Sources
 *   data     `${BASE_URL}data`  — the user's bundle (today the real v1 GEE bundle; later real v2)
 *   demo     `${BASE_URL}demo`  — the synthetic v2 demo bundle written by the notebook
 *   fixture  in-memory synthetic v2 bundle (`fixtures/synthV2.js`), served through a fake fetch;
 *            lets the UI run before any demo bundle exists
 *   custom   `VITE_DATA_BASE_URL`
 *
 * Resolution order
 *   1. `?bundle=data|demo|fixture` (explicit choice, e.g. from the Settings menu) wins;
 *   2. else `VITE_DATA_BASE_URL` when set (deployments that host the bundle elsewhere);
 *   3. else `data` when `<base>/data/manifest.json` exists, else `demo` when its manifest
 *      exists, else the in-memory `fixture` (flagged with a reason so the UI can say so).
 * An explicit source whose manifest is missing is NOT silently replaced: the store reports
 * status "empty" with instructions, exactly like v1.
 */

import { DataLoadError, getDefaultDataBaseUrl, isUsableManifest } from "../lib/data.js";
import { fetchBytes, parseJsonBytes } from "./fetch.js";

export const BUNDLE_IDS = Object.freeze(["data", "demo", "fixture"]);

const trimSlash = (s) => String(s).replace(/\/+$/, "");

function envOf(env) {
  if (env) return env;
  try {
    return import.meta.env ?? {};
  } catch (_error) {
    return {};
  }
}

/** Base URL of a named bundle directory ("data" | "demo") under Vite's BASE_URL. */
export function bundleBaseUrl(id, env = null) {
  const e = envOf(env);
  return trimSlash(`${e.BASE_URL ?? "/"}${id}`);
}

/** `?bundle=` value from a query string (null when absent or not one of BUNDLE_IDS). */
export function requestedBundle(search) {
  try {
    const value = new URLSearchParams(search ?? "").get("bundle");
    const id = value ? value.trim().toLowerCase() : null;
    return id && BUNDLE_IDS.includes(id) ? id : null;
  } catch (_error) {
    return null;
  }
}

/**
 * Fetch and parse `<base>/manifest.json`; resolves null when it does not exist (404 / HTML
 * fallback), rejects for other failures (network, server error, malformed JSON).
 */
export async function probeManifest(baseUrl, { fetchImpl = globalThis.fetch } = {}) {
  const url = `${trimSlash(baseUrl)}/manifest.json`;
  try {
    const { bytes } = await fetchBytes(url, { fetchImpl });
    const manifest = await parseJsonBytes(bytes, url);
    if (!isUsableManifest(manifest)) {
      throw new DataLoadError(`manifest.json at ${url} is malformed (missing "epochs"/"timeline.frames" or "files").`, { url });
    }
    return manifest;
  } catch (error) {
    if (error?.status === "missing") return null;
    throw error;
  }
}

/**
 * Decide which bundle to load.
 * @param {{search?: string, env?: object, fetchImpl?: Function, probe?: Function}} [options]
 *   `probe(baseUrl)` defaults to `probeManifest` (resolves the manifest or null).
 * @returns {Promise<{id: string, baseUrl: string|null, explicit: boolean, reason: string,
 *                    manifest: object|null}>}
 *   `manifest` is the probed manifest when one was fetched during resolution (saves a request).
 */
export async function resolveBundleSource({ search = typeof location !== "undefined" ? location.search : "", env = null, fetchImpl = globalThis.fetch, probe = null } = {}) {
  const e = envOf(env);
  const doProbe = probe ?? ((base) => probeManifest(base, { fetchImpl }));
  const explicit = requestedBundle(search);
  if (explicit === "fixture") return { id: "fixture", baseUrl: null, explicit: true, reason: "?bundle=fixture (in-memory synthetic v2 fixture)", manifest: null };
  if (explicit) {
    return { id: explicit, baseUrl: bundleBaseUrl(explicit, e), explicit: true, reason: `?bundle=${explicit}`, manifest: null };
  }
  const configured = typeof e.VITE_DATA_BASE_URL === "string" ? e.VITE_DATA_BASE_URL.trim() : "";
  if (configured) return { id: "custom", baseUrl: trimSlash(configured), explicit: true, reason: "VITE_DATA_BASE_URL", manifest: null };

  const dataBase = env ? bundleBaseUrl("data", e) : getDefaultDataBaseUrl();
  const dataManifest = await doProbe(dataBase).catch((error) => {
    console.warn("[bundle] probing the data bundle failed:", error?.message ?? error);
    return null;
  });
  if (dataManifest) return { id: "data", baseUrl: dataBase, explicit: false, reason: "default: public/data/manifest.json exists", manifest: dataManifest };
  const demoBase = bundleBaseUrl("demo", e);
  const demoManifest = await doProbe(demoBase).catch((error) => {
    console.warn("[bundle] probing the demo bundle failed:", error?.message ?? error);
    return null;
  });
  if (demoManifest) return { id: "demo", baseUrl: demoBase, explicit: false, reason: "default: no public/data bundle, using public/demo", manifest: demoManifest };
  return {
    id: "fixture",
    baseUrl: null,
    explicit: false,
    reason: "no bundle in public/data or public/demo: showing the in-memory synthetic fixture (run the notebook to produce a bundle)",
    manifest: null,
  };
}

/** Major schema version (1, 2, …) from a manifest; NaN when absent/unparseable. */
export function schemaMajor(manifest) {
  const v = String(manifest?.schema_version ?? "").trim();
  const major = Number.parseInt(v.split(".")[0], 10);
  return Number.isFinite(major) ? major : NaN;
}

/**
 * Schema of a manifest: "v2" for schema ≥ 2 (or a timeline block), "v1" for 1.x / epochs.
 * @throws {DataLoadError} when neither shape is recognisable or the major version is newer than 2
 */
export function detectSchema(manifest) {
  const major = schemaMajor(manifest);
  if (major > 2) throw new DataLoadError(`manifest schema_version ${manifest.schema_version} is newer than this dashboard understands (2.x)`);
  if (major === 2 || (!Number.isFinite(major) && Array.isArray(manifest?.timeline?.frames))) {
    if (!Array.isArray(manifest?.timeline?.frames)) throw new DataLoadError('schema 2.x manifest without "timeline.frames"');
    return "v2";
  }
  if (Array.isArray(manifest?.epochs)) return "v1";
  throw new DataLoadError("manifest has neither a v2 timeline nor v1 epochs");
}

/** Join a bundle base URL and a manifest-relative file name. */
export function bundleFileUrl(baseUrl, fileName) {
  const name = String(fileName).replace(/^\/+/, "");
  return baseUrl ? `${trimSlash(baseUrl)}/${name}` : `/fixture/${name}`;
}

/** Search string with `bundle` set (for the Settings menu's bundle switch links). */
export function withBundleParam(search, id) {
  const params = new URLSearchParams(search ?? "");
  if (id) params.set("bundle", id);
  else params.delete("bundle");
  const s = params.toString();
  return s ? `?${s}` : "";
}
