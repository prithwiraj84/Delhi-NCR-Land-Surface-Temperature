/**
 * Scenario vocabulary: land-cover fraction names, the canonical district table and the
 * what-if presets (SPEC §4.8 / §5.1).
 *
 * Split out of lib/scenario.js so the app shell (DataContext needs `presetsFor` at boot) does
 * not pull the ~50 kB scenario engine into the initial bundle: the engine itself runs in the
 * scenario worker and is only imported on the main thread for the no-worker fallback.
 * lib/scenario.js re-exports everything here, so `import { SCENARIO_PRESETS } from
 * "./scenario.js"` keeps working unchanged.
 */

export const FRACTION_FEATURES = Object.freeze([
  "frac_impervious",
  "frac_forest",
  "frac_water",
  "frac_cropland",
  "frac_barren",
]);

/**
 * v2 land-cover fractions (SPEC §4.1): built-up comes from GHSL as `frac_built`; the other four
 * keep their v1 names. Same class order as FRACTION_FEATURES (index k = the same land cover).
 */
export const FRACTION_FEATURES_V2 = Object.freeze(["frac_built", "frac_forest", "frac_water", "frac_cropland", "frac_barren"]);

/** Feature renames between bundle generations (v1 name <-> v2 name). */
export const FEATURE_ALIASES = Object.freeze({ frac_impervious: "frac_built", frac_built: "frac_impervious", ndwi: "mndwi", mndwi: "ndwi" });

/** True for a land-cover fraction of either bundle generation. */
export const isFractionFeature = (name) => FRACTION_FEATURES.includes(name) || FRACTION_FEATURES_V2.includes(name);

/**
 * FOCAL_SPEC of SPEC §3.3 / §4.1 (the notebook ships it as `model_web_<mode>.json.focal` and
 * `scenario_coupling.json.focal`); used only when a v2 bundle omits it.
 */
export const DEFAULT_FOCAL_SPEC = Object.freeze({
  bases: Object.freeze(["ndvi", "ndbi", "albedo", "frac_built", "frac_forest", "frac_water", "frac_barren"]),
  windows: Object.freeze([3, 15]),
});


/** Canonical districts (SPEC §1.1): id = index. Aliases are matched case/space-insensitively. */
export const CANONICAL_DISTRICTS = Object.freeze([
  { id: 0, name: "Delhi NCT", state: "Delhi", aliases: ["delhi", "nct of delhi", "new delhi", "delhi nct", "nct delhi"] },
  { id: 1, name: "Gurugram", state: "Haryana", aliases: ["gurgaon", "gurugram"] },
  { id: 2, name: "Faridabad", state: "Haryana", aliases: ["faridabad"] },
  { id: 3, name: "Palwal", state: "Haryana", aliases: ["palwal"] },
  { id: 4, name: "Nuh", state: "Haryana", aliases: ["mewat", "nuh"] },
  { id: 5, name: "Rewari", state: "Haryana", aliases: ["rewari"] },
  { id: 6, name: "Jhajjar", state: "Haryana", aliases: ["jhajjar"] },
  { id: 7, name: "Rohtak", state: "Haryana", aliases: ["rohtak"] },
  { id: 8, name: "Sonipat", state: "Haryana", aliases: ["sonipat", "sonepat"] },
  { id: 9, name: "Panipat", state: "Haryana", aliases: ["panipat"] },
  { id: 10, name: "Karnal", state: "Haryana", aliases: ["karnal"] },
  { id: 11, name: "Jind", state: "Haryana", aliases: ["jind"] },
  { id: 12, name: "Bhiwani", state: "Haryana", aliases: ["bhiwani"] },
  { id: 13, name: "Charkhi Dadri", state: "Haryana", aliases: ["charkhi dadri"] },
  { id: 14, name: "Mahendragarh", state: "Haryana", aliases: ["mahendragarh", "mahendergarh", "narnaul"] },
  { id: 15, name: "Meerut", state: "Uttar Pradesh", aliases: ["meerut"] },
  { id: 16, name: "Ghaziabad", state: "Uttar Pradesh", aliases: ["ghaziabad"] },
  {
    id: 17,
    name: "Gautam Buddh Nagar",
    state: "Uttar Pradesh",
    aliases: ["gautam buddha nagar", "gautam buddh nagar", "gautambudhnagar", "noida"],
  },
  { id: 18, name: "Bulandshahr", state: "Uttar Pradesh", aliases: ["bulandshahr", "bulandshahar"] },
  { id: 19, name: "Baghpat", state: "Uttar Pradesh", aliases: ["baghpat", "bagpat"] },
  { id: 20, name: "Hapur", state: "Uttar Pradesh", aliases: ["hapur", "panchsheel nagar"] },
  { id: 21, name: "Shamli", state: "Uttar Pradesh", aliases: ["shamli", "prabudh nagar"] },
  { id: 22, name: "Muzaffarnagar", state: "Uttar Pradesh", aliases: ["muzaffarnagar"] },
  { id: 23, name: "Alwar", state: "Rajasthan", aliases: ["alwar"] },
  { id: 24, name: "Bharatpur", state: "Rajasthan", aliases: ["bharatpur"] },
]);

/** Lower-case and drop everything that is not a letter or digit ("Gautam Buddh-Nagar" -> "gautambuddhnagar"). */
export function normalizeName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

const ALIAS_TO_ID = new Map(
  CANONICAL_DISTRICTS.flatMap((d) => [d.name, ...d.aliases].map((a) => [normalizeName(a), d.id])),
);

/**
 * Resolve a district display name or alias to its canonical id.
 * Matches the given `districts` list by name first, then the SPEC §1.1 alias table
 * ("Noida" -> 17, "Gurgaon"/"Gurugram" -> 1). Returns null when unknown or when the id is
 * absent from a non-empty `districts` list.
 */
export function findDistrictId(districts, aliasOrName) {
  const key = normalizeName(aliasOrName);
  if (!key) return null;
  const list = Array.isArray(districts) ? districts : [];
  const direct = list.find((d) => normalizeName(d.name) === key);
  if (direct) return direct.id;
  const id = ALIAS_TO_ID.get(key);
  if (id === undefined) return null;
  if (list.length && !list.some((d) => d.id === id)) return null;
  return id;
}

/**
 * Scenario presets. District ids are canonical (SPEC §1.1), resolved through the alias table
 * so the presets stay correct if the display names change.
 */
export const SCENARIO_PRESETS = Object.freeze([
  {
    id: "gurugram-canopy",
    label: "+20% tree canopy in Gurugram",
    description:
      "Convert 20% of each Gurugram cell to tree cover (taken proportionally from the other land covers), with NDVI/NDWI/NDBI following the land-cover change.",
    scenario: {
      feature: "frac_forest",
      delta: 0.2,
      region: { type: "district", ids: [findDistrictId(CANONICAL_DISTRICTS, "Gurugram")] },
      coupled: true,
    },
  },
  {
    id: "noida-sprawl",
    label: "+10% impervious surface in Noida",
    description:
      "Urban expansion stress test: 10% more built-up surface across Gautam Buddh Nagar (Noida), spectral indices coupled.",
    scenario: {
      feature: "frac_impervious",
      delta: 0.1,
      region: { type: "district", ids: [findDistrictId(CANONICAL_DISTRICTS, "Noida")] },
      coupled: true,
    },
  },
  {
    id: "riparian-restoration",
    label: "Wetland restoration: +5% open water",
    description:
      "Restore wetlands and water bodies: +5% water fraction in the most water-rich governance zone (picked from the zone profiles of this bundle, whatever its name).",
    scenario: {
      feature: "frac_water",
      delta: 0.05,
      // `pick` is resolved at runtime by resolvePresetScenario(); ids is the fallback.
      region: { type: "zone", ids: [1], pick: "max_water" },
      coupled: true,
    },
  },
  {
    id: "ncr-greening",
    label: "NCR-wide greening: +10% tree cover",
    description: "Region-wide afforestation programme adding 10% tree cover to every cell in the NCR.",
    scenario: {
      feature: "frac_forest",
      delta: 0.1,
      region: { type: "all", ids: [] },
      coupled: true,
    },
  },
  {
    id: "heat-core-cooling",
    label: "Cool the Heat Extreme Core: +15% trees",
    description: "Targeted urban forestry: +15% tree cover only inside Heat Extreme Core cells.",
    scenario: {
      feature: "frac_forest",
      delta: 0.15,
      region: { type: "zone", ids: [3] },
      coupled: true,
    },
  },
]);

/**
 * True when the manifest marks `feature` as a lever planners can move (SPEC §4.1
 * `features[].actionable`). NDWI / NDBI are spectral diagnostics (actionable = false): they
 * move only through land-cover change in the coupled mode. Without a manifest every model
 * feature is allowed (tests, partial bundles).
 */
export function isActionable(manifest, feature) {
  const list = manifest?.features;
  if (!Array.isArray(list) || !list.length) return true;
  const direct = list.find((f) => f?.name === feature);
  if (direct) return Boolean(direct.actionable);
  // v2 facade manifests list one entry per SHAP GROUP (name = group id, `primary`, `members`):
  // a base feature is actionable when its group is actionable and it is the group's primary
  // feature or one of its non-focal members (focal means are derived, never levers).
  if (/_m\d+$/.test(String(feature))) return false;
  const group = list.find((f) => f?.primary === feature) ?? list.find((f) => Array.isArray(f?.members) && f.members.includes(feature));
  return Boolean(group?.actionable);
}

/** Whether a feature name exists in a manifest (direct feature or a group member/primary). */
export function manifestHasFeature(manifest, feature) {
  const list = manifest?.features;
  if (!Array.isArray(list) || !list.length) return false;
  return list.some((f) => f?.name === feature || f?.primary === feature || (Array.isArray(f?.members) && f.members.includes(feature)));
}

/**
 * The name this bundle uses for a feature: the name itself when the bundle (manifest or model)
 * knows it, else its v1/v2 alias when that is known (frac_impervious <-> frac_built,
 * ndwi <-> mndwi), else the name unchanged.
 */
export function resolveFeatureName(feature, { manifest = null, modelFeatures = null } = {}) {
  const known = (name) => (Array.isArray(modelFeatures) && modelFeatures.includes(name)) || manifestHasFeature(manifest, name);
  if (known(feature)) return feature;
  const alias = FEATURE_ALIASES[feature];
  return alias && known(alias) ? alias : feature;
}

/** Zone id with the largest mean water fraction (then most negative water SHAP), or null. */
export function mostWaterRichZone(zones) {
  const profiles = Array.isArray(zones?.zones) ? zones.zones : [];
  const byMean = profiles
    .filter((z) => Number.isInteger(z?.id) && Number.isFinite(z?.feature_means?.frac_water))
    .sort((a, b) => b.feature_means.frac_water - a.feature_means.frac_water || a.id - b.id);
  if (byMean.length) return byMean[0].id;
  const waterShap = (z) => (z?.shap_means?.frac_water ?? NaN) + (z?.shap_means?.ndwi ?? 0);
  const byShap = profiles
    .filter((z) => Number.isInteger(z?.id) && Number.isFinite(waterShap(z)))
    .sort((a, b) => waterShap(a) - waterShap(b) || a.id - b.id);
  return byShap.length ? byShap[0].id : null;
}

/**
 * The runnable scenario of a preset for this bundle: data-driven regions (`region.pick`) are
 * resolved from zones.json, and `pick` is dropped so the result is a plain scenario object.
 */
export function resolvePresetScenario(preset, { zones = null } = {}) {
  const scenario = preset?.scenario ?? preset;
  if (!scenario) return null;
  const { pick, ...region } = scenario.region ?? { type: "all", ids: [] };
  let ids = [...(region.ids ?? [])];
  if (pick === "max_water") {
    const id = mostWaterRichZone(zones);
    if (id !== null) ids = [id];
  }
  return { ...scenario, region: { ...region, ids } };
}

/**
 * Whether a "coupled indices" badge is honest for this scenario: only when the engine really
 * moved NDVI/NDWI/NDBI (`result.coupledApplied`). Without a result, only coupled scenarios on
 * a land-cover fraction qualify; a coupled flag on NDVI or a landscape metric never does.
 */
export function coupledBadgeVisible(scenario, result = null) {
  if (!scenario?.coupled) return false;
  if (typeof result?.coupledApplied === "boolean") return result.coupledApplied;
  return isFractionFeature(scenario.feature);
}

/**
 * Presets usable with this bundle: feature names translated to the bundle's generation
 * (a v2 bundle runs "+10% impervious" on `frac_built`), only actionable features, regions
 * resolved. Labels say "built-up" for v2 bundles.
 */
export function presetsFor(manifest, zones = null) {
  return SCENARIO_PRESETS.map((p) => {
    const feature = resolveFeatureName(p.scenario.feature, { manifest });
    if (feature === p.scenario.feature) return p;
    const relabel = (text) => text.replace(/impervious surface/g, "built-up surface");
    return { ...p, label: relabel(p.label), description: relabel(p.description), scenario: { ...p.scenario, feature } };
  })
    .filter((p) => isActionable(manifest, p.scenario.feature))
    .map((p) => ({ ...p, scenario: resolvePresetScenario(p, { zones }) }));
}
