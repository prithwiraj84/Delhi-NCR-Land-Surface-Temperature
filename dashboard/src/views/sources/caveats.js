/**
 * Caveat model shared by the Sources route (CaveatsList, anchors `#/sources#caveat-<id>`) and
 * the in-context CaveatPips (Zones, Model Lab, Timeline). Caveats are the notebook's own
 * sentences (`manifest.notes`, plus `data_caveats` when a v2 bundle exports them) grouped by
 * topic with stable ids, plus UI-derived caveats that follow from the bundle itself (v1
 * compatibility mode, synthetic data, projections). Nothing is paraphrased: the text shown is
 * the exported text.
 */

/** Caveat groups in display order, with the keywords that route a note into the group. */
export const CAVEAT_GROUPS = Object.freeze([
  Object.freeze({ id: "synthetic", label: "Synthetic data", keys: [/synthetic|fixture|simulated/i] }),
  Object.freeze({ id: "sensor", label: "Sensors, orbits & calibration", keys: [/terra|aqua|viirs|landsat|orbit|drift|overpass|slc|dmsp|calibrat|sensor|modis/i] }),
  Object.freeze({ id: "landcover", label: "Land cover & population inputs", keys: [/land.?cover|glc|worldcover|dynamic world|ghs|ghsl|worldpop|population|built/i] }),
  Object.freeze({ id: "projection", label: "Projections & scenarios", keys: [/projection|scenario|ssp|cmip6|forecast|2050|future/i] }),
  Object.freeze({ id: "model", label: "Model, validation & explanations", keys: [/shap|model|cross-validation|surrogate|validation|zone|recommendation|anomaly|causal/i] }),
  Object.freeze({ id: "other", label: "Other", keys: [] }),
]);

/** Short stable slug of a sentence (first words + a 32-bit FNV-1a hash). */
export function caveatSlug(text) {
  const s = String(text ?? "");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const words = s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4)
    .join("-");
  return `${words || "note"}-${h.toString(36).slice(0, 5)}`;
}

/** Group id of a caveat sentence. */
export function caveatGroupOf(text) {
  for (const g of CAVEAT_GROUPS) if (g.keys.some((re) => re.test(String(text)))) return g.id;
  return "other";
}

/**
 * All caveats of a bundle.
 * @param {object|null} manifest raw manifest
 * @param {{schema?: string|null}} [ctx]
 * @returns {Array<{id: string, group: string, text: string, source: "notebook"|"dashboard"}>}
 */
export function buildCaveats(manifest, { schema = null } = {}) {
  const out = [];
  const seen = new Set();
  const push = (text, source) => {
    const t = String(text ?? "").trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push({ id: caveatSlug(t), group: caveatGroupOf(t), text: t, source });
  };
  const notes = Array.isArray(manifest?.notes) ? manifest.notes : [];
  for (const n of notes) push(typeof n === "string" ? n : n?.text, "notebook");
  const extra = manifest?.data_caveats;
  if (Array.isArray(extra)) for (const c of extra) push(typeof c === "string" ? c : c?.text ?? c?.message, "notebook");
  else if (extra && typeof extra === "object") for (const v of Object.values(extra)) (Array.isArray(v) ? v : [v]).forEach((c) => push(typeof c === "string" ? c : c?.text, "notebook"));
  if (manifest?.data_mode === "synthetic") push(`SYNTHETIC bundle: ${manifest.data_mode_reason ?? "generated data for testing"} — values are not observations.`, "dashboard");
  if (schema === "v1") {
    push("v1 bundle (schema 1.x): day only (MODIS Terra), four epochs, no night LST, no 250 m rasters and no projections — those panels show 'unavailable — rerun notebook v2'.", "dashboard");
    push("v1 accuracy is the mean of per-fold R² over 5×5 spatial blocks; v2 reports pooled out-of-fold R² over 20 km blocks. The two metrics are not directly comparable.", "dashboard");
  }
  if (schema === "v2" && (manifest?.timeline?.frames ?? []).some((f) => f.kind === "projected")) {
    push("Projected frames are a model + CMIP6 scenario, not observations or a forecast; uncertainty bands come from a Monte-Carlo over GCM, climate sensitivity, land-use realisation and model error.", "dashboard");
  }
  const order = new Map(CAVEAT_GROUPS.map((g, i) => [g.id, i]));
  return out.sort((a, b) => order.get(a.group) - order.get(b.group));
}

/** Caveats of one or more groups (for in-context pips). */
export function caveatsFor(caveats, groups) {
  const wanted = new Set(Array.isArray(groups) ? groups : [groups]);
  return caveats.filter((c) => wanted.has(c.group));
}

/** DOM anchor id of a caveat on the Sources route. */
export const caveatAnchor = (id) => `caveat-${id}`;
