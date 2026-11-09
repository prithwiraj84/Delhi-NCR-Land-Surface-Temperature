import { appEnv } from "../lib/env.js";
/**
 * Bundle source selection (SPEC §6): `?bundle=data|demo|fixture` in the page query string.
 *   data    -> public/data/ (the user's bundle: today the real v1 GEE bundle)
 *   demo    -> public/demo/ (the synthetic v2 demo bundle written by the notebook)
 *   fixture -> the in-memory synthetic v2 fixture (data/fixtures/synthV2.js), used before a
 *              demo bundle exists
 * The data layer (data/bundle.js) resolves the default when nothing is chosen: VITE_DATA_BASE_URL
 * when set, else data when public/data/manifest.json exists, else demo, else fixture. An explicit
 * `?bundle=` always wins. The shell prefers the data layer's `setBundleSource`; without it the
 * page navigates to the new query, so every cache, worker and GPU texture starts clean.
 */
export const BUNDLE_SOURCES = Object.freeze(["data", "demo", "fixture"]);

/** Explicit `?bundle=` value (null when absent/invalid). */
export function readBundleParam(search = typeof window !== "undefined" ? window.location.search : "") {
  try {
    const value = new URLSearchParams(search).get("bundle");
    return BUNDLE_SOURCES.includes(value) ? value : null;
  } catch {
    return null;
  }
}

/** Source id from useData().source ({id, …} object or plain string), else the URL param. */
export function currentBundleSource(dataSource, search) {
  const id = typeof dataSource === "string" ? dataSource : dataSource?.id;
  if (BUNDLE_SOURCES.includes(id)) return id;
  return readBundleParam(search) ?? (id === "custom" ? "custom" : "data");
}

/** True when a build-time VITE_DATA_BASE_URL provides the default source. */
export function hasCustomBaseUrl() {
  try {
    return Boolean(appEnv.VITE_DATA_BASE_URL);
  } catch {
    return false;
  }
}

/** URL (path + search + hash) that loads `source`, keeping every other query param and the hash. */
export function bundleSourceUrl(source, loc = typeof window !== "undefined" ? window.location : null) {
  if (!loc) return null;
  const params = new URLSearchParams(loc.search);
  params.set("bundle", source);
  return `${loc.pathname}?${params.toString()}${loc.hash ?? ""}`;
}

/**
 * Switch the bundle source: the data layer's own setter when it exposes one
 * (`setBundleSource`, which also updates the URL), otherwise a navigation (full reload).
 */
export function switchBundleSource(source, data) {
  if (!BUNDLE_SOURCES.includes(source)) return;
  if (typeof data?.setBundleSource === "function") {
    // Keep the choice in the URL so a reload (or a shared link) opens the same bundle.
    try {
      const url = bundleSourceUrl(source);
      if (url) window.history.replaceState(null, "", url);
    } catch {
      // history writes can be blocked (sandboxed frames); the in-memory switch still happens
    }
    data.setBundleSource(source);
    return;
  }
  const url = bundleSourceUrl(source);
  if (url) window.location.assign(url);
}
