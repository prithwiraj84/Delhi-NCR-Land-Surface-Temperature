/**
 * Bundle validation for the DataProvider (kept out of the JSX module so it is unit-testable and
 * React-refresh friendly): validates whatever the BundleStore has loaded so far.
 *   v1 bundles: the SPEC_v1 §4 contract on the raw files (lib/validate.validateBundle: first epoch
 *               + every small asset) AND the SPEC §5 invariants on the adapted v2 structure;
 *   v2 bundles: validateV2 on manifest, timeline, cells, cubes, zones, XAI frames, series, rasters.
 */
import { validateBundle } from "../lib/validate.js";
import { ASSET_FILES } from "../data/bundleStore.js";
import { assetForMode } from "../data/v1Adapter.js";
import { validateV2 } from "../data/validateV2.js";

const ASSET_NAMES = Object.keys(ASSET_FILES);

/** All ready resources whose key starts with a prefix, as {suffix: data}. */
function readyByPrefix(resources, prefix) {
  const out = {};
  for (const [key, entry] of Object.entries(resources)) {
    if (entry?.status === "ready" && key.startsWith(prefix)) out[key.slice(prefix.length)] = entry.data;
  }
  return out;
}

/**
 * Validation of whatever is loaded (pure; called when idle).
 * @param {object} state BundleStore state
 * @returns {{ok, errors, warnings, epochsChecked?, framesChecked, checked, schema}}
 */
export function validateLoadedBundle(state) {
  const { schema, manifest, manifestV2, timeline, resources } = state;
  const data = (key) => (resources[key]?.status === "ready" ? resources[key].data : null);
  const cubes = {};
  const zones = {};
  const xai = {};
  for (const [key, entry] of Object.entries(resources)) {
    if (entry?.status !== "ready") continue;
    if (key.startsWith("cube:") && !key.startsWith("cube:dtr")) cubes[key.slice(5)] = entry.data;
    else if (key.startsWith("zones:")) zones[key.slice(6)] = entry.data;
    else if (key.startsWith("xai:")) xai[key.slice(4)] = entry.data;
  }
  const assets = Object.fromEntries(ASSET_NAMES.map((n) => [n, data(`asset:${n}`)]).filter(([, v]) => v));
  const v2 = validateV2({ manifest: manifestV2 ?? manifest, timeline, cells: data("cells"), cubes, zones, xai, series: data("series"), rasterIndex: data("rasterIndex"), assets, adapted: schema === "v1" });
  if (schema !== "v1") return { ...v2, framesChecked: Object.keys(xai), schema };
  // v1: the SPEC_v1 §4 contract on the raw files (first epoch + every small asset) as before.
  const epochs = readyByPrefix(resources, "epoch:");
  const firstKey = Object.keys(epochs).sort()[0];
  const unwrap = (name) => {
    const a = data(`asset:${name}`);
    return a?.modes ? assetForMode(name, a, "day") : a;
  };
  const v1 = validateBundle({
    manifest,
    epochs: firstKey ? { [firstKey.split(":")[0]]: epochs[firstKey] } : {},
    model: data("model:day"),
    dependence: unwrap("dependence"),
    zones: unwrap("zones"),
    metrics: unwrap("metrics"),
    shapGlobal: unwrap("shapGlobal"),
    interactions: unwrap("interactions"),
    coupling: data("asset:coupling"),
    districts: data("districts"),
  });
  return {
    ok: v1.ok && v2.ok,
    errors: [...v1.errors, ...v2.errors],
    warnings: [...v1.warnings, ...v2.warnings],
    epochsChecked: v1.epochsChecked,
    framesChecked: Object.keys(xai),
    waterfallSample: v1.waterfallSample,
    checked: v2.checked,
    schema,
  };
}
