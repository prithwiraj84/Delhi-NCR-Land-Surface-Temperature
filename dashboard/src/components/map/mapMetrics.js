/**
 * Pure data preparation for the spatial digital twin.
 *
 * Everything in this module works on the columnar epoch object delivered by
 * `useData().epoch` (typed arrays, NaN = null) and returns typed arrays or small
 * plain objects. Nothing here touches React or deck.gl, so the heavy per-cell work
 * (~55k cells x 17 features) can be memoised by the caller and unit-tested in Node.
 *
 * Colour philosophy (see dataviz skill):
 *   - magnitude (LST)          -> sequential thermal ramp over the robust p02..p98 range
 *   - polarity (residual, SHAP, scenario delta) -> diverging cyan (cooling) / rose (warming),
 *     symmetric domain so 0 degC always sits on the neutral midpoint
 *   - identity (zones, dominant driver) -> fixed categorical slots keyed by the entity
 *     (zone id / feature index), never by rank, so colours do not repaint between epochs.
 */
import {
  sequentialScale,
  divergingScale,
  categoricalPalette,
  ZONE_COLORS,
  ZONE_NAMES,
  NAN_COLOR,
  hexToRgb,
} from "../../lib/colors.js";

/** Layer registry: id -> presentation + encoding kind. Order = order in the layer switcher. */
export const LAYER_DEFS = [
  { id: "lst_obs", label: "Raw LST", hint: "MODIS observed land surface temperature", kind: "sequential" },
  { id: "lst_pred", label: "Predicted LST", hint: "Final XGBoost model prediction", kind: "sequential" },
  { id: "resid_oof", label: "Residuals (OOF)", hint: "Observed minus spatial-CV out-of-fold prediction", kind: "diverging" },
  { id: "shap", label: "SHAP attribution", hint: "TreeSHAP contribution of one feature", kind: "diverging" },
  { id: "driver", label: "Dominant driver", hint: "Feature with the largest |SHAP| in each cell", kind: "categorical" },
  { id: "zones", label: "Governance zones", hint: "K-means clusters of SHAP signatures", kind: "categorical" },
  { id: "scenario", label: "Scenario delta", hint: "Simulated change from the Threshold Explorer", kind: "diverging" },
];

/** Lookup table built once from LAYER_DEFS. */
export const LAYER_BY_ID = Object.fromEntries(LAYER_DEFS.map((d) => [d.id, d]));

/**
 * Base column height (metres) for a fully "hot" cell at elevation-scale 1.
 * At the initial zoom (~7.7, ~650 m/px at 28.6 N) 1 km cells are ~1.5 px wide, so the
 * relief must be tens of kilometres tall to be legible; the slider scales it 0-3x.
 */
export const MAX_ELEVATION_M = 22000;

/** Minimum relative height so that even the coolest valid cell reads as a solid prism. */
const MIN_ELEVATION_FRACTION = 0.03;

/** Cells without a value: the shared recessive slate from the colour system. */
export const NODATA_RGBA = NAN_COLOR;

/** Cells outside a scenario's region: dim and flat so the affected area pops. */
export const UNAFFECTED_RGBA = [100, 116, 139, 34];

/** Sentinel for "no dominant driver" (all SHAP values missing). */
export const NO_DRIVER = 255;

/** Floor for symmetric diverging domains so an all-zero layer does not divide by zero. */
const MIN_SYMMETRIC_DOMAIN = 0.05;

/**
 * Normalise any colour representation used by src/lib/colors.js to an [r,g,b,a] array.
 * Accepts "#rrggbb" strings, [r,g,b] and [r,g,b,a] arrays.
 */
export function toRgba(color, alpha = 255) {
  if (Array.isArray(color) || ArrayBuffer.isView(color)) {
    return [color[0], color[1], color[2], color.length > 3 ? color[3] : alpha];
  }
  if (typeof color === "string") {
    try {
      const rgb = hexToRgb(color);
      return [rgb[0], rgb[1], rgb[2], alpha];
    } catch (_error) {
      // Malformed colour in the bundle: fall through to the no-data colour.
    }
  }
  return [...NODATA_RGBA];
}

/** CSS rgba() string for an [r,g,b,a] colour (alpha 0-255). */
export function rgbaCss(rgba) {
  const a = rgba.length > 3 ? rgba[3] / 255 : 1;
  return `rgba(${rgba[0]}, ${rgba[1]}, ${rgba[2]}, ${a.toFixed(3)})`;
}

const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * Symmetric +/- bound for a diverging layer from epoch.stats-like objects: the larger
 * magnitude of the robust tails (p02/p98) when present, else of min/max.
 */
export function symmetricBound(stat) {
  if (!stat) return 1;
  const tails = [stat.p02, stat.p98].filter(isFiniteNumber);
  const extremes = tails.length ? tails : [stat.min, stat.max].filter(isFiniteNumber);
  const bound = extremes.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  return Math.max(bound, MIN_SYMMETRIC_DOMAIN);
}

/** Robust sequential domain [p02, p98] (falls back to min/max, then to the data). */
export function sequentialDomain(stat, values) {
  if (stat && isFiniteNumber(stat.p02) && isFiniteNumber(stat.p98) && stat.p98 > stat.p02) {
    return [stat.p02, stat.p98];
  }
  if (stat && isFiniteNumber(stat.min) && isFiniteNumber(stat.max) && stat.max > stat.min) {
    return [stat.min, stat.max];
  }
  let lo = Infinity;
  let hi = -Infinity;
  if (values) {
    for (let i = 0; i < values.length; i += 1) {
      const v = values[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!(hi > lo)) return [0, 1];
  return [lo, hi];
}

/* ------------------------------------------------------------------------------------ */
/* Per-epoch caches (WeakMap: the epoch object is immutable once loaded)                  */
/* ------------------------------------------------------------------------------------ */

const driverCache = new WeakMap();
const districtCache = new WeakMap();

/**
 * Dominant driver per cell = argmax_f |SHAP_f|. Returned codes are indices into
 * `featureNames` (NO_DRIVER when every SHAP value of the cell is missing).
 * Cached per (epoch, feature list) because it scans K x n values.
 */
export function computeDominantDriver(epoch, featureNames) {
  const cacheKey = featureNames.join("|");
  const perEpoch = driverCache.get(epoch);
  if (perEpoch && perEpoch.key === cacheKey) return perEpoch.value;

  const n = epoch.n;
  const driver = new Uint8Array(n).fill(NO_DRIVER);
  const best = new Float32Array(n);
  featureNames.forEach((name, fIdx) => {
    const col = epoch.shap?.[name];
    if (!col) return;
    for (let i = 0; i < n; i += 1) {
      const a = Math.abs(col[i]);
      if (a > best[i]) {
        best[i] = a;
        driver[i] = fIdx;
      }
    }
  });
  const counts = new Int32Array(featureNames.length);
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    if (driver[i] !== NO_DRIVER) {
      counts[driver[i]] += 1;
      total += 1;
    }
  }
  const value = { driver, counts, total };
  driverCache.set(epoch, { key: cacheKey, value });
  return value;
}

/**
 * District summaries from the epoch cells: centroid (mean lon/lat of cells), bbox,
 * cell count and mean observed LST. Districts with zero cells are omitted.
 */
export function summarizeDistricts(epoch, districts) {
  const cached = districtCache.get(epoch);
  if (cached && cached.districts === districts) return cached.value;

  const size = Math.max(
    (districts ?? []).reduce((m, d) => Math.max(m, d.id + 1), 0),
    1,
  );
  const acc = {
    count: new Int32Array(size),
    sumLon: new Float64Array(size),
    sumLat: new Float64Array(size),
    minLon: new Float64Array(size).fill(Infinity),
    minLat: new Float64Array(size).fill(Infinity),
    maxLon: new Float64Array(size).fill(-Infinity),
    maxLat: new Float64Array(size).fill(-Infinity),
    sumLst: new Float64Array(size),
    nLst: new Int32Array(size),
  };
  const { lon, lat, district, lst_obs: lst } = epoch;
  for (let i = 0; i < epoch.n; i += 1) {
    const d = district[i];
    if (d < 0 || d >= size) continue;
    acc.count[d] += 1;
    acc.sumLon[d] += lon[i];
    acc.sumLat[d] += lat[i];
    if (lon[i] < acc.minLon[d]) acc.minLon[d] = lon[i];
    if (lon[i] > acc.maxLon[d]) acc.maxLon[d] = lon[i];
    if (lat[i] < acc.minLat[d]) acc.minLat[d] = lat[i];
    if (lat[i] > acc.maxLat[d]) acc.maxLat[d] = lat[i];
    const t = lst?.[i];
    if (Number.isFinite(t)) {
      acc.sumLst[d] += t;
      acc.nLst[d] += 1;
    }
  }
  const byId = new Map((districts ?? []).map((d) => [d.id, d]));
  const value = [];
  for (let d = 0; d < size; d += 1) {
    if (acc.count[d] === 0) continue;
    const meta = byId.get(d);
    value.push({
      id: d,
      name: meta?.name ?? `District ${d}`,
      state: meta?.state ?? "",
      count: acc.count[d],
      lon: acc.sumLon[d] / acc.count[d],
      lat: acc.sumLat[d] / acc.count[d],
      bbox: [acc.minLon[d], acc.minLat[d], acc.maxLon[d], acc.maxLat[d]],
      meanLst: acc.nLst[d] ? acc.sumLst[d] / acc.nLst[d] : NaN,
    });
  }
  districtCache.set(epoch, { districts, value });
  return value;
}

/**
 * KPI summary for the chips: mean LST, hottest district by mean LST and the share of
 * valid-zone cells in the Heat Extreme Core (canonical zone id 3).
 */
export function computeEpochKpis(epoch, districts, heatCoreId = 3) {
  const summaries = summarizeDistricts(epoch, districts);
  const hottest = summaries.reduce(
    (best, d) => (Number.isFinite(d.meanLst) && (!best || d.meanLst > best.meanLst) ? d : best),
    null,
  );
  let zoned = 0;
  let core = 0;
  const zone = epoch.zone;
  if (zone) {
    for (let i = 0; i < epoch.n; i += 1) {
      const z = zone[i];
      if (z >= 0) {
        zoned += 1;
        if (z === heatCoreId) core += 1;
      }
    }
  }
  let meanLst = epoch.stats?.lst_obs?.mean;
  if (!isFiniteNumber(meanLst)) meanLst = columnMean(epoch.lst_obs);
  return { meanLst, hottest, heatCoreShare: zoned ? core / zoned : NaN };
}

/** Mean of the finite entries of a typed array (NaN when none). */
export function columnMean(values) {
  if (!values) return NaN;
  let s = 0;
  let c = 0;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (Number.isFinite(v)) {
      s += v;
      c += 1;
    }
  }
  return c ? s / c : NaN;
}

/* ------------------------------------------------------------------------------------ */
/* Metric resolution: (layer, epoch, feature, scenario) -> encodable metric                */
/* ------------------------------------------------------------------------------------ */

/** Zone categories from manifest.zones (fallback ZONE_COLORS) as {key,label,rgba}. */
export function zoneCategories(zonesMeta) {
  const source = Array.isArray(zonesMeta) && zonesMeta.length ? zonesMeta : null;
  if (source) {
    return source.map((z) => ({ key: z.id, label: z.name, rgba: toRgba(z.color ?? ZONE_COLORS[z.id]) }));
  }
  return ZONE_NAMES.map((label, id) => ({ key: id, label, rgba: toRgba(ZONE_COLORS[id]) }));
}

/** Driver categories: one fixed palette slot per feature index (stable across epochs). */
export function driverCategories(featureNames, labelOf) {
  return featureNames.map((name, idx) => ({
    key: idx,
    name,
    label: labelOf ? labelOf(name) : name,
    // Beyond the palette length, fold to the no-data slate rather than cycling hues.
    rgba: idx < categoricalPalette.length ? toRgba(categoricalPalette[idx]) : [...NODATA_RGBA],
  }));
}

/**
 * Resolve everything needed to encode the active layer.
 *
 * @returns {{
 *   layer: string, kind: "sequential"|"diverging"|"categorical", title: string, unit: string,
 *   values: ArrayLike<number>|null, domain: [number, number]|null,
 *   scale?: Function, colorOf: (v:number) => number[], categories: Array|null,
 *   elevationValues: ArrayLike<number>|null, elevationDomain: [number, number]|null,
 *   elevationKind: "sequential"|"diverging", available: boolean, emptyReason: string|null,
 *   isScenario: boolean
 * }}
 */
export function resolveMetric({ layer, epoch, shapFeature, scenarioResult, featureNames, zonesMeta, labelOf }) {
  const def = LAYER_BY_ID[layer] ?? LAYER_BY_ID.lst_obs;
  const stats = epoch.stats ?? {};
  const lstDomain = sequentialDomain(stats.lst_obs, epoch.lst_obs);
  const base = {
    layer: def.id,
    kind: def.kind,
    unit: "°C",
    categories: null,
    available: true,
    emptyReason: null,
    isScenario: false,
    elevationValues: epoch.lst_obs,
    elevationDomain: lstDomain,
    elevationKind: "sequential",
  };

  switch (def.id) {
    case "lst_obs":
    case "lst_pred": {
      const values = epoch[def.id];
      // Both LST layers share the observed p02-p98 domain so their colours are directly
      // comparable (a prediction is judged against the observed thermal range).
      const domain = lstDomain;
      const scale = sequentialScale(domain);
      return {
        ...base,
        title: def.id === "lst_obs" ? "Observed LST" : "Predicted LST",
        values,
        domain,
        scale,
        colorOf: (v) => toRgba(scale(v)),
        elevationValues: values,
        elevationDomain: domain,
      };
    }
    case "resid_oof": {
      const bound = symmetricBound(stats.resid_oof);
      const scale = divergingScale(bound);
      return {
        ...base,
        title: "OOF residual (obs − pred)",
        values: epoch.resid_oof,
        domain: [-bound, bound],
        scale,
        colorOf: (v) => toRgba(scale(v)),
        elevationValues: epoch.resid_oof,
        elevationDomain: [-bound, bound],
        elevationKind: "diverging",
      };
    }
    case "shap": {
      const values = epoch.shap?.[shapFeature] ?? null;
      const rawBound = stats.shapMaxAbs?.[shapFeature];
      const bound = Math.max(isFiniteNumber(rawBound) ? rawBound : MIN_SYMMETRIC_DOMAIN, MIN_SYMMETRIC_DOMAIN);
      const scale = divergingScale(bound);
      return {
        ...base,
        title: `SHAP · ${labelOf ? labelOf(shapFeature) : shapFeature}`,
        unit: "°C contribution",
        values,
        domain: [-bound, bound],
        scale,
        colorOf: (v) => toRgba(scale(v)),
        elevationValues: values,
        elevationDomain: [-bound, bound],
        elevationKind: "diverging",
        available: Boolean(values),
        emptyReason: values ? null : "No SHAP values for this feature in the bundle.",
      };
    }
    case "driver": {
      const { driver } = computeDominantDriver(epoch, featureNames);
      const categories = driverCategories(featureNames, labelOf);
      return {
        ...base,
        title: "Dominant driver (max |SHAP|)",
        unit: "",
        values: driver,
        domain: null,
        categories,
        colorOf: (code) => (code === NO_DRIVER ? NODATA_RGBA : categories[code]?.rgba ?? NODATA_RGBA),
      };
    }
    case "zones": {
      const categories = zoneCategories(zonesMeta);
      const byKey = new Map(categories.map((c) => [c.key, c.rgba]));
      return {
        ...base,
        title: "Governance zones",
        unit: "",
        values: epoch.zone ?? null,
        domain: null,
        categories,
        colorOf: (code) => byKey.get(code) ?? NODATA_RGBA,
        available: Boolean(epoch.zone),
        emptyReason: epoch.zone ? null : "Zone labels are missing from this epoch.",
      };
    }
    case "scenario": {
      const delta = scenarioResult?.deltaByCell;
      // Row indices are epoch-specific: a result computed for another epoch is never painted,
      // even when both grids happen to have the same number of cells.
      const sameEpoch =
        scenarioResult?.epochYear === undefined || Number(scenarioResult.epochYear) === Number(epoch.year);
      const matches = Boolean(delta && delta.length === epoch.n && sameEpoch);
      const st = scenarioResult?.stats;
      const bound = matches
        ? Math.max(Math.abs(st?.min ?? 0), Math.abs(st?.max ?? 0), MIN_SYMMETRIC_DOMAIN)
        : 1;
      const scale = divergingScale(bound);
      return {
        ...base,
        title: "Scenario ΔLST",
        values: matches ? delta : null,
        domain: [-bound, bound],
        scale,
        colorOf: (v) => toRgba(scale(v)),
        elevationValues: matches ? delta : null,
        elevationDomain: [-bound, bound],
        elevationKind: "diverging",
        isScenario: true,
        available: matches,
        emptyReason: matches ? null : "No scenario has been run for this epoch yet.",
      };
    }
    default:
      throw new Error(`Unknown map layer "${layer}"`);
  }
}

/**
 * Relative column height in [0, ~1.15] for a value under the metric's elevation encoding:
 * sequential -> position within the p02..p98 range; diverging -> |value| / bound.
 * NaN values give 0 (flat).
 */
export function relativeElevation(value, kind, domain) {
  if (!Number.isFinite(value) || !domain) return 0;
  let t;
  if (kind === "diverging") {
    t = Math.abs(value) / domain[1];
  } else {
    t = (value - domain[0]) / (domain[1] - domain[0]);
  }
  if (!(t > 0)) t = 0;
  if (t > 1.15) t = 1.15;
  return MIN_ELEVATION_FRACTION + t;
}

/**
 * Precompute per-cell GPU attributes for the active metric: RGBA colours (Uint8Array n*4)
 * and elevations in metres (Float32Array n). Computing these once per (layer, epoch,
 * feature, scenario) keeps deck.gl accessors trivial array reads during interaction.
 */
export function buildCellAttributes(metric, n) {
  const colors = new Uint8Array(n * 4);
  const elevations = new Float32Array(n);
  const { values, colorOf, kind, isScenario, elevationValues, elevationDomain, elevationKind } = metric;

  for (let i = 0; i < n; i += 1) {
    let rgba;
    let elevation = 0;
    if (!values) {
      rgba = isScenario ? UNAFFECTED_RGBA : NODATA_RGBA;
    } else {
      const v = values[i];
      const missing = kind === "categorical" ? v < 0 || v === NO_DRIVER || Number.isNaN(v) : !Number.isFinite(v);
      if (missing) {
        rgba = isScenario ? UNAFFECTED_RGBA : NODATA_RGBA;
      } else {
        rgba = colorOf(v);
        elevation = relativeElevation(elevationValues ? elevationValues[i] : NaN, elevationKind, elevationDomain);
      }
    }
    const o = i * 4;
    colors[o] = rgba[0];
    colors[o + 1] = rgba[1];
    colors[o + 2] = rgba[2];
    colors[o + 3] = rgba[3] ?? 255;
    elevations[i] = elevation * MAX_ELEVATION_M;
  }
  return { colors, elevations };
}

/** Share of cells per category (for categorical legends), sorted by share, zero-count dropped. */
export function categoryShares(metric, n) {
  if (!metric.categories || !metric.values) return [];
  const counts = new Map();
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    const v = metric.values[i];
    if (v < 0 || v === NO_DRIVER || Number.isNaN(v)) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
    total += 1;
  }
  return metric.categories
    .map((c) => ({ ...c, count: counts.get(c.key) ?? 0, share: total ? (counts.get(c.key) ?? 0) / total : 0 }))
    .filter((c) => c.count > 0)
    .sort((a, b) => b.share - a.share);
}

/**
 * Per-cell SHAP waterfall data: base value, contributions sorted by |SHAP| desc,
 * the predicted LST and the additivity check (base + sum SHAP vs lst_pred).
 */
export function cellWaterfall(epoch, index, featureNames) {
  const contributions = [];
  let sum = 0;
  featureNames.forEach((name) => {
    const s = epoch.shap?.[name]?.[index];
    const shap = Number.isFinite(s) ? s : 0;
    sum += shap;
    contributions.push({ name, shap, value: epoch.features?.[name]?.[index] });
  });
  contributions.sort((a, b) => Math.abs(b.shap) - Math.abs(a.shap));
  const base = Number.isFinite(epoch.base_value_c) ? epoch.base_value_c : 0;
  const pred = epoch.lst_pred?.[index];
  const reconstructed = base + sum;
  return {
    base,
    contributions,
    sum,
    reconstructed,
    prediction: Number.isFinite(pred) ? pred : reconstructed,
    additivityError: Number.isFinite(pred) ? reconstructed - pred : NaN,
  };
}

/** Stable integer id for an object identity (used as a cheap deck.gl updateTrigger). */
const identityIds = new WeakMap();
let identityCounter = 0;
export function identityKey(obj) {
  if (obj === null || typeof obj !== "object") return String(obj);
  let id = identityIds.get(obj);
  if (id === undefined) {
    identityCounter += 1;
    id = identityCounter;
    identityIds.set(obj, id);
  }
  return id;
}

/** Keyboard cell-picking modes (the pointer-free way to pin a cell). */
export const PICK_MODES = Object.freeze([
  { id: "hottest", label: "Hottest" },
  { id: "coolest", label: "Coolest" },
  { id: "max_shap", label: "Largest |SHAP|" },
]);

/**
 * Row index of the cell to inspect without a pointer: the hottest / coolest observed LST
 * (predicted LST where the observation is missing) or the largest total |SHAP| (the most
 * strongly "explained" cell), optionally restricted to one district. Null when no cell
 * qualifies.
 * @param {object} epoch prepared epoch
 * @param {{mode: "hottest"|"coolest"|"max_shap", district?: number|null, featureNames?: string[]}} options
 */
export function pickCell(epoch, { mode, district = null, featureNames = null }) {
  if (!epoch?.n) return null;
  const names = featureNames ?? Object.keys(epoch.shap ?? {});
  const shapCols = mode === "max_shap" ? names.map((f) => epoch.shap?.[f]).filter(Boolean) : [];
  let best = null;
  let bestScore = -Infinity;
  for (let i = 0; i < epoch.n; i += 1) {
    if (district !== null && district !== undefined && epoch.district?.[i] !== district) continue;
    let score;
    if (mode === "max_shap") {
      score = 0;
      let any = false;
      for (const col of shapCols) {
        const v = col[i];
        if (Number.isFinite(v)) {
          score += Math.abs(v);
          any = true;
        }
      }
      if (!any) continue;
    } else {
      const obs = epoch.lst_obs?.[i];
      const value = Number.isFinite(obs) ? obs : epoch.lst_pred?.[i];
      if (!Number.isFinite(value)) continue;
      score = mode === "coolest" ? -value : value;
    }
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}
