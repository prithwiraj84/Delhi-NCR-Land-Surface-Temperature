/**
 * Pure decision helpers of DataContext (kept out of the JSX module so they can be unit tested).
 */

/**
 * Scenarios are computed only while visible: the Threshold Explorer (simulator) is open or
 * the map shows the scenario layer. Everywhere else an unopened simulator costs nothing.
 */
export function scenarioIsActive(view, mapLayer) {
  return view === "thresholds" || mapLayer === "scenario";
}

/**
 * The scenario result to expose for the current epoch: a result computed for another epoch
 * (row indices of a different grid) is hidden until the re-run for this epoch lands.
 */
export function currentScenarioResult(result, year) {
  if (!result || year === null || year === undefined) return null;
  if (result.epochYear === undefined) return result;
  return Number(result.epochYear) === Number(year) ? result : null;
}

/** Years of `epochs` that the validation state has not checked yet. */
export function uncheckedYears(validation, epochs) {
  const done = new Set((validation?.epochsChecked ?? []).map(Number));
  return Object.keys(epochs ?? {})
    .map(Number)
    .filter((y) => Number.isFinite(y) && epochs[y] && !done.has(y))
    .sort((a, b) => a - b);
}

/** Merge a per-epoch validation into the running validation state. */
export function mergeValidation(prev, next) {
  if (!prev) return next;
  const errors = [...(prev.errors ?? []), ...(next.errors ?? [])];
  const warnings = [...(prev.warnings ?? []), ...(next.warnings ?? [])];
  const epochsChecked = [...new Set([...(prev.epochsChecked ?? []), ...(next.epochsChecked ?? [])])].sort((a, b) => a - b);
  return { ...prev, ok: errors.length === 0, errors, warnings, epochsChecked };
}

// ---------------------------------------------------------------------------------------
// v1 facade over the v2 stores (DataContext.useData), UI_SPEC §7 "useData() facade"
// ---------------------------------------------------------------------------------------

/** v1 view id -> v2 route id. */
export const VIEW_TO_ROUTE = Object.freeze({ twin: "control", thresholds: "drivers", zones: "zones", performance: "lab" });
/** v2 route id -> v1 view id (routes without a v1 view map to "twin"). */
export const ROUTE_TO_VIEW = Object.freeze({ control: "twin", drivers: "thresholds", zones: "zones", lab: "performance", timeline: "twin", sources: "twin" });
/** v1 map layer -> v2 layer id. */
export const V1_LAYER_TO_V2 = Object.freeze({ lst_obs: "lst", lst_pred: "pred", resid_oof: "resid", shap: "shap", driver: "driver", zones: "zones", scenario: "whatif" });
/** v2 layer -> v1 map layer (v2-only layers fall back to "lst_obs"). */
export const V2_LAYER_TO_V1 = Object.freeze({ lst: "lst_obs", pred: "lst_pred", resid: "resid_oof", shap: "shap", driver: "driver", zones: "zones", whatif: "scenario", unc: "lst_obs", aoa: "lst_obs" });

export const viewForRoute = (route) => ROUTE_TO_VIEW[route] ?? "twin";
export const routeForView = (view) => VIEW_TO_ROUTE[view] ?? null;
export const v1LayerFor = (layer) => V2_LAYER_TO_V1[layer] ?? "lst_obs";
export const v2LayerFor = (mapLayer) => V1_LAYER_TO_V2[mapLayer] ?? null;

/** The physical mode the v1 facade explains (DTR has no XAI; it falls back to day). */
export const facadeMode = (mode) => (mode === "night" ? "night" : "day");

/**
 * Epoch year the v1 facade shows for a (possibly fractional) time-store year: the nearest frame
 * with XAI for the mode (ties to the earlier), or null when the mode has none.
 */
export function facadeYear(xaiYears, year) {
  if (!Array.isArray(xaiYears) || !xaiYears.length) return null;
  const y = Number(year);
  if (!Number.isFinite(y)) return xaiYears[xaiYears.length - 1];
  let best = xaiYears[0];
  for (const candidate of xaiYears) if (Math.abs(candidate - y) < Math.abs(best - y)) best = candidate;
  return best;
}

/**
 * v1-shaped manifest view for the legacy components (SPEC_v1 §4.1 keys) of the current mode:
 * v1 bundles pass through; v2 bundles get `features` = one entry per SHAP group, `zones` = the
 * mode's zone list, `epochs` = frames with XAI, `epoch_means` = frame levels, `bootstrap` of the mode.
 */
export function v1ManifestView(manifest, { schema, mode, timeline, groupFeatures }) {
  if (!manifest) return null;
  if (schema !== "v2") return manifest;
  const m = facadeMode(mode);
  const frames = timeline?.frames ?? [];
  const epochs = frames.filter((f) => f.xai?.[m]).map((f) => f.year);
  const zones = Array.isArray(manifest.zones) ? manifest.zones : manifest.zones?.[m] ?? [];
  return {
    ...manifest,
    features: groupFeatures,
    zones,
    epochs,
    epoch_means: Object.fromEntries(frames.filter((f) => f[m]?.level !== null && f[m]?.level !== undefined).map((f) => [String(f.year), f[m].level])),
    bootstrap: manifest.bootstrap?.[m] ?? manifest.bootstrap ?? null,
    files: { ...manifest.files, epochs: Object.fromEntries(epochs.map((y) => [String(y), manifest.files?.xai?.[m]?.[String(y)]?.shap ?? null])) },
    v2: true,
    mode: m,
  };
}
