/**
 * v1 → v2 adapter (SPEC §5.8, UI_SPEC §7 "v1 compatibility").
 *
 * A schema-1.x bundle (the user's real GEE bundle in public/data today) is presented through the
 * v2 model so every v2 view runs on it:
 *   - single mode "day"; frames = v1 epochs, tier "observed", sensor "MODIS Terra (MOD11A2)";
 *   - night, DTR, projections and 250 m rasters are `unavailable` with the reason
 *     "… unavailable in a v1 bundle — rerun notebook v2";
 *   - canonical cells = the epochs' cells sorted by cell_id (identical across v1 epochs);
 *     the grid width is inferred from the geometry (cell_id = row·W + col);
 *   - the day observation cube is built from `lst_obs` (quantised exactly like v2 cubes);
 *   - scope series (NCR, districts, zones) are computed from the epochs with the SPEC §4.7
 *     definitions (mean, p90, hot-core km² vs the pooled p90, signed surface UHI with
 *     frac_impervious standing in for frac_built). No level CIs and no trends are invented: v1
 *     never exported them, so the UI's guarded copy falls back to its alternates;
 *   - XAI comes from `epoch_<year>.json.gz` (each v1 feature is its own SHAP "group").
 */

import { cubeFromFloatFrames, ZONE_NODATA } from "./cubes.js";
import { normalizeSeries } from "./series.js";
import { buildTimeline, TIERS } from "./timeline.js";
import { xaiFromV1Epoch } from "./xai.js";

export const V1_UNAVAILABLE = "unavailable in a v1 bundle — rerun notebook v2";
const V1_SENSOR = "MODIS Terra (MOD11A2)";
const BUILT_FEATURE_V1 = "frac_impervious";

const isNum = Number.isFinite;

/** Sorted copy of the finite values. */
function sortedFinite(values, mask = null) {
  const out = [];
  for (let i = 0; i < values.length; i += 1) {
    if (mask && !mask[i]) continue;
    const v = values[i];
    if (isNum(v)) out.push(v);
  }
  return Float64Array.from(out).sort();
}

export function quantile(sorted, q) {
  const n = sorted.length;
  if (!n) return NaN;
  const pos = (n - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, n - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Infer the grid width W from cell ids and coordinates: for vertically adjacent cells
 * (same column, next row south) cell_id differs by exactly W. Votes over a sample of cells.
 * @returns {number|null}
 */
export function inferGridWidth(cellId, lon, lat, { sample = 3000 } = {}) {
  const n = cellId.length;
  if (n < 4) return null;
  const byId = new Map();
  for (let i = 0; i < n; i += 1) byId.set(cellId[i], i);
  // Cell size in degrees from horizontally adjacent ids (same row): median |Δlon|.
  const dLon = [];
  for (let i = 1; i < n && dLon.length < 500; i += 1) {
    if (cellId[i] === cellId[i - 1] + 1) dLon.push(Math.abs(lon[i] - lon[i - 1]));
  }
  if (!dLon.length) return null;
  dLon.sort((a, b) => a - b);
  const step = dLon[dLon.length >> 1];
  const votes = new Map();
  const stride = Math.max(1, Math.floor(n / sample));
  for (let i = 0; i < n; i += stride) {
    // The nearest cell directly south: |Δlon| < step/2 and Δlat ≈ step (within 50 %).
    let best = null;
    // Bounded scan: the southern neighbour is at most a few rows of cells ahead in id order.
    for (let j = i + 1, end = Math.min(n, i + 6000); j < end; j += 1) {
      const dy = lat[i] - lat[j];
      if (Math.abs(lon[j] - lon[i]) < step * 0.5 && dy > step * 0.5 && dy < step * 1.5) {
        best = cellId[j] - cellId[i];
        break;
      }
    }
    if (best !== null) votes.set(best, (votes.get(best) ?? 0) + 1);
  }
  let W = null;
  let max = 0;
  for (const [w, c] of votes) {
    if (c > max) {
      max = c;
      W = w;
    }
  }
  return W && byId.size === n ? W : null;
}

/**
 * Canonical cells (SPEC §5.2 `cells.lstb.gz` shape) from a prepared v1 epoch.
 * @returns {Cells} {n, cell_id Int32, row Int16, col Int16, lon/lat Float32, lon64/lat64 Float64,
 *                   district Int16, grid: {width, height, res, inferred}}
 */
export function cellsFromV1Epoch(epoch, manifest) {
  const n = epoch.n;
  for (let i = 1; i < n; i += 1) {
    if (epoch.cell_id[i] <= epoch.cell_id[i - 1]) throw new Error("v1 epoch cells are not sorted by cell_id (canonical order)");
  }
  const width = inferGridWidth(epoch.cell_id, epoch.lon, epoch.lat);
  const row = new Int16Array(n);
  const col = new Int16Array(n);
  let maxRow = 0;
  if (width) {
    for (let i = 0; i < n; i += 1) {
      row[i] = Math.floor(epoch.cell_id[i] / width);
      col[i] = epoch.cell_id[i] % width;
      if (row[i] > maxRow) maxRow = row[i];
    }
  } else {
    row.fill(-1);
    col.fill(-1);
  }
  return {
    n,
    cell_id: Int32Array.from(epoch.cell_id),
    row,
    col,
    lon: Float32Array.from(epoch.lon),
    lat: Float32Array.from(epoch.lat),
    lon64: epoch.lon,
    lat64: epoch.lat,
    district: Int16Array.from(epoch.district),
    grid: {
      crs: manifest?.study_area?.crs ?? "EPSG:32643",
      res: Number(manifest?.study_area?.grid_res_m) || epoch.cell_size_m || 1000,
      width: width ?? null,
      height: width ? maxRow + 1 : null,
      inferred: true,
    },
  };
}

/**
 * Scope statistics of one frame (SPEC §4.7 frame statistics).
 * @param {Float32Array} values absolute °C per cell
 * @param {{mask?: Uint8Array|null, fracBuilt?: ArrayLike|null, fracWater?: ArrayLike|null,
 *          hotThreshold?: number, cellAreaKm2?: number, tier?: string}} options
 */
export function frameScopeStats(values, { mask = null, fracBuilt = null, fracWater = null, hotThreshold = NaN, cellAreaKm2 = 1, tier = "observed" } = {}) {
  let sum = 0;
  let count = 0;
  let hot = 0;
  let urbanSum = 0;
  let urbanN = 0;
  let ruralSum = 0;
  let ruralN = 0;
  for (let i = 0; i < values.length; i += 1) {
    if (mask && !mask[i]) continue;
    const v = values[i];
    if (!isNum(v)) continue;
    sum += v;
    count += 1;
    if (v >= hotThreshold) hot += 1;
    if (fracBuilt) {
      const b = fracBuilt[i];
      if (b >= 0.5) {
        urbanSum += v;
        urbanN += 1;
      } else if (b <= 0.05 && (!fracWater || fracWater[i] < 0.2)) {
        ruralSum += v;
        ruralN += 1;
      }
    }
  }
  const sorted = sortedFinite(values, mask);
  const round = (x, dp = 2) => (isNum(x) ? Number(x.toFixed(dp)) : null);
  return {
    mean: round(count ? sum / count : NaN),
    ci: null,
    p90: round(quantile(sorted, 0.9)),
    hot_core_km2: isNum(hotThreshold) ? round(hot * cellAreaKm2, 1) : null,
    uhi: urbanN && ruralN ? round(urbanSum / urbanN - ruralSum / ruralN) : null,
    n_cells: count,
    tier,
  };
}

/** p0.5–p99.5 of all finite values across frames, rounded outward to 1 °C. */
export function absDomain(frames) {
  const all = [];
  for (const f of frames) for (let i = 0; i < f.length; i += 1) if (isNum(f[i])) all.push(f[i]);
  const sorted = Float64Array.from(all).sort();
  return [Math.floor(quantile(sorted, 0.005)), Math.ceil(quantile(sorted, 0.995))];
}

/** Symmetric domain [−a, a] with a = p99.5 of |v| (rounded up to 0.5 °C). */
export function symmetricDomain(frames) {
  const all = [];
  for (const f of frames) for (let i = 0; i < f.length; i += 1) if (isNum(f[i])) all.push(Math.abs(f[i]));
  const a = Math.ceil(quantile(Float64Array.from(all).sort(), 0.995) * 2) / 2 || 1;
  return [-a, a];
}

function anomalyFrames(frames) {
  return frames.map((f) => {
    let s = 0;
    let c = 0;
    for (let i = 0; i < f.length; i += 1) if (isNum(f[i])) (s += f[i]), (c += 1);
    const m = c ? s / c : 0;
    return f.map((v) => v - m);
  });
}

function suhiFrames(frames, epochs) {
  return frames.map((f, k) => {
    const built = epochs[k].features?.[BUILT_FEATURE_V1];
    const water = epochs[k].features?.frac_water;
    let s = 0;
    let c = 0;
    for (let i = 0; i < f.length; i += 1) {
      if (built && built[i] <= 0.05 && (!water || water[i] < 0.2) && isNum(f[i])) (s += f[i]), (c += 1);
    }
    const ref = c ? s / c : NaN;
    return f.map((v) => v - ref);
  });
}

/**
 * Adapt a v1 bundle.
 * @param {{manifest: object, epochs: Object<number, object>}} input epochs = ALL manifest epochs,
 *   prepared with lib/data.prepareEpoch
 * @returns {{schema:"v1", manifestV2, timeline, cells, cubes:{"day:obs": Cube}, zones:{day},
 *            series, xai: (year) => Xai|null, epochs}}
 */
export function adaptV1Bundle({ manifest, epochs }) {
  const years = (manifest?.epochs ?? []).map(Number).filter(Number.isInteger).sort((a, b) => a - b);
  if (!years.length) throw new Error("v1 manifest lists no epochs");
  const missing = years.filter((y) => !epochs?.[y]);
  if (missing.length) throw new Error(`v1 adapter needs every epoch; missing ${missing.join(", ")}`);
  const ordered = years.map((y) => epochs[y]);
  const ref = ordered[0];
  ordered.forEach((e, k) => {
    if (e.n !== ref.n || e.cell_id.some((id, i) => id !== ref.cell_id[i])) {
      throw new Error(`v1 epoch ${years[k]} does not share the cell set of epoch ${years[0]} (canonical order required)`);
    }
  });
  const cells = cellsFromV1Epoch(ref, manifest);
  const cellAreaKm2 = (cells.grid.res / 1000) ** 2;
  const lstFrames = ordered.map((e) => e.lst_obs);
  const domainAbs = absDomain(lstFrames);
  const refPeriod = [2000, 2020];
  const refYears = years.filter((y) => y >= refPeriod[0] && y <= refPeriod[1]);
  const pooled = sortedFinite(Float32Array.from((refYears.length ? refYears : years).flatMap((y) => Array.from(epochs[y].lst_obs))));
  const hotThreshold = Number(quantile(pooled, 0.9).toFixed(2));

  const cube = cubeFromFloatFrames(lstFrames, {
    years,
    mode: "day",
    series: "obs",
    tiers: years.map(() => "observed"),
    levels: ordered.map((e) => e.epoch_mean),
    extraColumns: {
      aoa_out: { dtype: "uint8", raw: new Uint8Array(years.length * cells.n) },
      p05_off: { dtype: "uint8", scale: 0.05, raw: new Uint8Array(years.length * cells.n) },
      p95_off: { dtype: "uint8", scale: 0.05, raw: new Uint8Array(years.length * cells.n) },
    },
  });

  // Zones cube (uint8, 255 = nodata) from the per-epoch zone column.
  const zoneRaw = new Uint8Array(years.length * cells.n);
  ordered.forEach((e, f) => {
    for (let i = 0; i < cells.n; i += 1) {
      const z = e.zone[i];
      zoneRaw[f * cells.n + i] = z >= 0 && z <= 3 ? z : ZONE_NODATA;
    }
  });
  const zones = { day: { kind: "zones", mode: "day", n: cells.n, series: { obs: { years, F: years.length, n: cells.n, values: zoneRaw } } } };

  // ---- scope series ---------------------------------------------------------------------
  const districts = manifest.districts ?? [];
  const zonesMeta = Array.isArray(manifest.zones) ? manifest.zones : [];
  const scopes = [
    { id: "ncr", label: manifest.study_area?.name ?? "Delhi NCR", kind: "ncr" },
    ...districts.map((d) => ({ id: `d:${d.id}`, label: d.name, kind: "district", state: d.state ?? null })),
    ...zonesMeta.map((z) => ({ id: `z:day:${z.id}`, label: z.name, kind: "zone", mode: "day", color: z.color })),
  ];
  const masks = new Map();
  masks.set("ncr", null);
  for (const d of districts) {
    const m = new Uint8Array(cells.n);
    for (let i = 0; i < cells.n; i += 1) m[i] = cells.district[i] === d.id ? 1 : 0;
    masks.set(`d:${d.id}`, m);
  }
  const seriesRaw = {};
  const zoneShareObs = {};
  for (const scope of scopes) {
    const framesOut = ordered.map((e, f) => {
      let mask = masks.get(scope.id);
      if (scope.kind === "zone") {
        const zid = Number(scope.id.split(":")[2]);
        mask = new Uint8Array(cells.n);
        for (let i = 0; i < cells.n; i += 1) mask[i] = zoneRaw[f * cells.n + i] === zid ? 1 : 0;
      }
      return {
        year: years[f],
        ...frameScopeStats(e.lst_obs, {
          mask,
          fracBuilt: e.features?.[BUILT_FEATURE_V1] ?? null,
          fracWater: e.features?.frac_water ?? null,
          hotThreshold,
          cellAreaKm2,
        }),
      };
    });
    seriesRaw[scope.id] = { day: { frames: framesOut, annual: {}, ssp: {}, trend: null, decomposition: {}, uncertainty_budget: {}, threshold_years: {} } };
  }
  years.forEach((y, f) => {
    const counts = [0, 0, 0, 0];
    let total = 0;
    for (let i = 0; i < cells.n; i += 1) {
      const z = zoneRaw[f * cells.n + i];
      if (z <= 3) (counts[z] += 1), (total += 1);
    }
    zoneShareObs[String(y)] = counts.map((c) => (total ? Number((c / total).toFixed(4)) : 0));
  });
  const series = normalizeSeries({
    reference_period: refYears.length ? [refYears[0], refYears[refYears.length - 1]] : [years[0], years[years.length - 1]],
    hot_core_threshold_c: { day: hotThreshold },
    scopes,
    series: seriesRaw,
    zone_share: { day: { obs: zoneShareObs } },
  });

  // ---- synthesised v2 manifest + timeline ----------------------------------------------------
  const frames = ordered.map((e, f) => {
    let valid = 0;
    for (let i = 0; i < cells.n; i += 1) if (isNum(e.lst_obs[i])) valid += 1;
    return {
      year: years[f],
      window: [years[f], years[f]],
      kind: "observed",
      day: {
        tier: "observed",
        sensor: V1_SENSOR,
        overpass_ist: "10:30",
        scenes: null,
        coverage: Number((valid / cells.n).toFixed(4)),
        native_m: 1000,
        available: true,
        level: isNum(e.epoch_mean) ? e.epoch_mean : null,
        level_ci: null,
      },
      night: { tier: null, available: false, reason: `night LST ${V1_UNAVAILABLE}` },
      xai: { day: true, night: false },
      raster: { day: false, night: false },
    };
  });
  const groups = (manifest.features ?? []).map((f) => ({
    id: f.name,
    label: f.label ?? f.name,
    primary: f.name,
    family: f.group ?? null,
    actionable: Boolean(f.actionable),
    members: [f.name],
  }));
  const manifestV2 = {
    ...manifest,
    schema_version: manifest.schema_version ?? "1.0",
    adapted_from: "v1",
    modes: [{ id: "day", label: "Day · ~10:30 IST", target: `${V1_SENSOR} LST_Day_1km (v1 bundle)`, ramp: "solar" }],
    groups,
    zones: { day: zonesMeta },
    timeline: {
      now: years[years.length - 1],
      harmonised: false,
      reference_period: series.referencePeriod,
      frames,
      scenarios: [],
      domains: {
        day: { abs: domainAbs, anom: symmetricDomain(anomalyFrames(lstFrames)), suhi: symmetricDomain(suhiFrames(lstFrames, ordered)) },
        night: {},
        dtr: {},
        spread: [0, 1],
      },
      annotations: [],
      tiers: TIERS.slice(),
      cubes: {},
      raster_index: null,
    },
  };
  const timeline = buildTimeline(manifestV2, { schema: "v1" });
  return {
    schema: "v1",
    manifestV2,
    timeline,
    cells,
    cubes: { "day:obs": cube },
    zones,
    series,
    hotThreshold,
    epochs,
    xai: (year) => (epochs[year] ? xaiFromV1Epoch(epochs[year], manifest) : null),
  };
}

/**
 * Wrap v1 small assets into the v2 per-mode shape (SPEC §5.5: `{modes: {day: {...}}}`), adding
 * the v2 key names next to the v1 ones (`groups` = v1 `features`, `by_frame` = v1 `by_epoch`).
 * Assets that are already v2 (have `modes`) are returned unchanged.
 */
export function wrapV1Asset(name, asset) {
  if (!asset || typeof asset !== "object" || asset.modes) return asset ?? null;
  switch (name) {
    case "shapGlobal":
      return { modes: { day: { ...asset, groups: asset.features, by_frame: asset.by_epoch ?? asset.by_frame } } };
    case "dependence":
      return { modes: { day: { ...asset, groups: asset.features } } };
    case "interactions":
      return { modes: { day: { ...asset, groups: asset.features } } };
    case "zones":
    case "metrics":
      return { modes: { day: asset } };
    default:
      return asset;
  }
}

/**
 * Per-mode view of a (v2-shaped) asset for the v1 facade: v1 components expect the v1 keys
 * (`features` for dependence/shap_global/interactions).
 */
export function assetForMode(name, asset, mode) {
  if (!asset || typeof asset !== "object") return null;
  if (!asset.modes) return asset;
  const m = asset.modes[mode === "dtr" ? "day" : mode] ?? asset.modes.day ?? null;
  if (!m) return null;
  if (name === "dependence" || name === "shapGlobal" || name === "interactions") {
    // The v1 components index these assets by `features`, aligned with the importance arrays.
    // In a v2 bundle that list is `groups` (SPEC §5.5); a v2 `features` key, when present, is
    // something else - e.g. the notebook's per-raw-feature importance `{names, mean_abs}` in
    // shap_global - so `groups` wins whenever it exists (v1 wrapped assets carry both, equal).
    return { ...m, features: m.groups ?? m.features, by_epoch: m.by_epoch ?? m.by_frame };
  }
  return m;
}
