/**
 * H3 hexagon aggregation of the active map metric.
 *
 * Why H3: the native 1 km grid is ideal for inspecting single cells, but for regional
 * reading (and for comparing epochs whose cell sets differ slightly) an equal-area-ish
 * hierarchical hexagon index is easier on the eye and on the GPU: res 6 (~36 km²) gives
 * ~1.5k hexes over the NCR, res 7 (~5 km²) ~11k.
 *
 * Cost model: `latLngToCell` for ~55k cells takes ~100-250 ms, so the cell -> hex index is
 * built once per (epoch, resolution) outside the render pass (in a timeout, so the UI
 * can first show an "indexing" state) and cached in a WeakMap keyed by the immutable
 * epoch object. Re-aggregating a new metric over a cached index is a single O(n) pass.
 */
import { useEffect, useMemo, useState } from "react";
import { latLngToCell } from "h3-js";
import {
  MAX_ELEVATION_M,
  NODATA_RGBA,
  NO_DRIVER,
  UNAFFECTED_RGBA,
  relativeElevation,
} from "./mapMetrics.js";

/** Resolutions offered in the UI. */
export const H3_RESOLUTIONS = [6, 7];

/** epoch -> Map(resolution -> {hexIds: string[], cellHex: Int32Array}) */
const indexCache = new WeakMap();

/** Cached cell -> hex index, or null when not built yet. */
function peekHexIndex(epoch, resolution) {
  return indexCache.get(epoch)?.get(resolution) ?? null;
}

/**
 * Build (or fetch) the cell -> hexagon index for an epoch. Cells with invalid
 * coordinates map to -1 and are skipped by the aggregation.
 */
export function getHexIndex(epoch, resolution) {
  const hit = peekHexIndex(epoch, resolution);
  if (hit) return hit;
  const { lon, lat, n } = epoch;
  const slotByHex = new Map();
  const hexIds = [];
  const cellHex = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    if (!Number.isFinite(lat[i]) || !Number.isFinite(lon[i])) {
      cellHex[i] = -1;
      continue;
    }
    const hex = latLngToCell(lat[i], lon[i], resolution);
    let slot = slotByHex.get(hex);
    if (slot === undefined) {
      slot = hexIds.length;
      hexIds.push(hex);
      slotByHex.set(hex, slot);
    }
    cellHex[i] = slot;
  }
  const index = { hexIds, cellHex };
  let perEpoch = indexCache.get(epoch);
  if (!perEpoch) {
    perEpoch = new Map();
    indexCache.set(epoch, perEpoch);
  }
  perEpoch.set(resolution, index);
  return index;
}

/** Mean of `values` per hexagon over finite entries. */
function meanPerHex(values, cellHex, nHex) {
  const sum = new Float64Array(nHex);
  const count = new Int32Array(nHex);
  if (values) {
    for (let i = 0; i < cellHex.length; i += 1) {
      const h = cellHex[i];
      const v = values[i];
      if (h < 0 || !Number.isFinite(v)) continue;
      sum[h] += v;
      count[h] += 1;
    }
  }
  const mean = new Float64Array(nHex);
  for (let h = 0; h < nHex; h += 1) mean[h] = count[h] ? sum[h] / count[h] : NaN;
  return { mean, count };
}

/**
 * Mode (most frequent category) per hexagon plus its within-hex share, for the
 * categorical layers (zones, dominant driver).
 */
function modePerHex(values, categories, cellHex, nHex) {
  const slotOfKey = new Map(categories.map((c, slot) => [c.key, slot]));
  const nCat = categories.length;
  const counts = new Int32Array(nHex * nCat);
  const totals = new Int32Array(nHex);
  for (let i = 0; i < cellHex.length; i += 1) {
    const h = cellHex[i];
    const v = values[i];
    if (h < 0 || v < 0 || v === NO_DRIVER || Number.isNaN(v)) continue;
    const slot = slotOfKey.get(v);
    if (slot === undefined) continue;
    counts[h * nCat + slot] += 1;
    totals[h] += 1;
  }
  const mode = new Int32Array(nHex).fill(-1);
  const share = new Float64Array(nHex);
  for (let h = 0; h < nHex; h += 1) {
    let best = -1;
    let bestCount = 0;
    for (let s = 0; s < nCat; s += 1) {
      const c = counts[h * nCat + s];
      if (c > bestCount) {
        bestCount = c;
        best = s;
      }
    }
    mode[h] = best;
    share[h] = totals[h] ? bestCount / totals[h] : 0;
  }
  return { mode, share, count: totals };
}

/**
 * Aggregate a resolved metric (see mapMetrics.resolveMetric) onto a hex index.
 * Returns plain objects (a few thousand) ready for H3HexagonLayer.
 */
export function aggregateMetricToHexes(metric, index) {
  const { hexIds, cellHex } = index;
  const nHex = hexIds.length;
  const elevation = meanPerHex(metric.elevationValues, cellHex, nHex).mean;
  const hexes = new Array(nHex);

  if (metric.kind === "categorical" && metric.values && metric.categories) {
    const { mode, share, count } = modePerHex(metric.values, metric.categories, cellHex, nHex);
    for (let h = 0; h < nHex; h += 1) {
      const category = mode[h] >= 0 ? metric.categories[mode[h]] : null;
      hexes[h] = {
        hex: hexIds[h],
        count: count[h],
        value: category ? category.key : NaN,
        label: category?.label ?? null,
        share: share[h],
        rgba: category ? category.rgba : NODATA_RGBA,
        elevation: category
          ? relativeElevation(elevation[h], metric.elevationKind, metric.elevationDomain) * MAX_ELEVATION_M
          : 0,
      };
    }
    return hexes;
  }

  const { mean, count } = meanPerHex(metric.values, cellHex, nHex);
  const emptyColor = metric.isScenario ? UNAFFECTED_RGBA : NODATA_RGBA;
  for (let h = 0; h < nHex; h += 1) {
    const valid = count[h] > 0;
    hexes[h] = {
      hex: hexIds[h],
      count: count[h],
      value: mean[h],
      label: null,
      share: 1,
      rgba: valid ? metric.colorOf(mean[h]) : emptyColor,
      elevation: valid
        ? relativeElevation(elevation[h], metric.elevationKind, metric.elevationDomain) * MAX_ELEVATION_M
        : 0,
    };
  }
  return hexes;
}

/**
 * React hook: aggregated hexagons for the active metric.
 *
 * @param {{epoch: object|null, metric: object|null, enabled: boolean, resolution: number}} args
 * @returns {{hexes: Array|null, status: "idle"|"indexing"|"ready"|"error", error: Error|null}}
 */
export function useH3Aggregation({ epoch, metric, enabled, resolution }) {
  const [, setBuiltVersion] = useState(0);
  const [failure, setFailure] = useState(null);
  const index = enabled && epoch ? peekHexIndex(epoch, resolution) : null;
  const needsIndex = Boolean(enabled && epoch && !index);

  useEffect(() => {
    if (!needsIndex) return undefined;
    let cancelled = false;
    // Defer one frame so the "indexing" state is painted before the blocking loop.
    const handle = setTimeout(() => {
      try {
        getHexIndex(epoch, resolution);
        if (!cancelled) {
          setFailure(null);
          setBuiltVersion((v) => v + 1);
        }
      } catch (error) {
        if (!cancelled) setFailure({ epoch, resolution, error });
      }
    }, 16);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [needsIndex, epoch, resolution]);

  const hexes = useMemo(
    () => (index && metric ? aggregateMetricToHexes(metric, index) : null),
    [index, metric],
  );

  const failed = failure && failure.epoch === epoch && failure.resolution === resolution;
  if (!enabled || !epoch) return { hexes: null, status: "idle", error: null };
  if (failed) return { hexes: null, status: "error", error: failure.error };
  if (!hexes) return { hexes: null, status: "indexing", error: null };
  return { hexes, status: "ready", error: null };
}
