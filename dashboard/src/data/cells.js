/**
 * Canonical cells (SPEC §1.1, §5.2 `cells.lstb.gz`): every per-cell array in the bundle uses the
 * order of ROI cells sorted by `cell_id = row · W + col`, with the same length `n`.
 *
 * `cellsFromLstb` turns the LSTB "cells" file into the in-memory Cells object shared by the map
 * engine, the inspector and the v1 facade; `buildCellLocator` builds a lon/lat bin index once so
 * the raster hover readout can find the 1 km parent cell without GPU picking (UI_SPEC §6.3).
 */

import { LstbError, requireColumn } from "./lstb.js";

/**
 * @param {object} file parsed LSTB with kind "cells"
 * @param {object} manifest (for `study_area.grid` / `grid_res_m`)
 * @returns {Cells} {n, cell_id Int32Array, row Int16Array, col Int16Array, lon/lat Float32Array,
 *                   lon64/lat64 Float64Array, district Int16Array, grid: {crs,res,x0,y0,width,height}}
 */
export function cellsFromLstb(file, manifest = null) {
  if (file?.kind !== "cells") throw new LstbError(`expected an LSTB "cells" file, got kind ${JSON.stringify(file?.kind)}`, "kind");
  const n = Number(file.n);
  const col = (name) => {
    const c = requireColumn(file, name);
    if (c.raw.length !== n) throw new LstbError(`cells column "${name}" has ${c.raw.length} values, expected n=${n}`, "shape");
    return c.raw;
  };
  const lon = col("lon");
  const lat = col("lat");
  const grid = manifest?.study_area?.grid ?? {};
  return {
    n,
    cell_id: col("cell_id"),
    row: file.columns.row ? col("row") : null,
    col: file.columns.col ? col("col") : null,
    lon,
    lat,
    lon64: Float64Array.from(lon),
    lat64: Float64Array.from(lat),
    district: col("district"),
    grid: {
      crs: grid.crs ?? manifest?.study_area?.crs ?? null,
      res: Number(grid.res ?? manifest?.study_area?.grid_res_m) || null,
      x0: grid.x0 ?? null,
      y0: grid.y0 ?? null,
      width: Number(grid.width ?? file.meta?.grid?.width) || null,
      height: Number(grid.height ?? file.meta?.grid?.height) || null,
      inferred: false,
    },
  };
}

/** Index of a cell id (binary search over the canonical, strictly increasing order); −1 if absent. */
export function indexOfCellId(cells, cellId) {
  const ids = cells?.cell_id;
  if (!ids) return -1;
  let lo = 0;
  let hi = ids.length - 1;
  const target = Number(cellId);
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = ids[mid];
    if (v === target) return mid;
    if (v < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/**
 * Nearest-cell locator over a uniform lon/lat bin grid (built once, O(n)); a query inspects the
 * 3 × 3 neighbouring bins. Returns −1 when no cell centre lies within `maxDistDeg`.
 */
export function buildCellLocator(cells, { binDeg = null } = {}) {
  const n = cells.n;
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (let i = 0; i < n; i += 1) {
    if (cells.lon[i] < minLon) minLon = cells.lon[i];
    if (cells.lon[i] > maxLon) maxLon = cells.lon[i];
    if (cells.lat[i] < minLat) minLat = cells.lat[i];
    if (cells.lat[i] > maxLat) maxLat = cells.lat[i];
  }
  // Default bin ≈ 2 cell spacings, estimated from the bbox and n.
  const step = binDeg ?? Math.max(1e-4, Math.sqrt(((maxLon - minLon || 1) * (maxLat - minLat || 1)) / Math.max(1, n)) * 2);
  const nx = Math.max(1, Math.ceil((maxLon - minLon) / step) + 1);
  const ny = Math.max(1, Math.ceil((maxLat - minLat) / step) + 1);
  const heads = new Int32Array(nx * ny).fill(-1);
  const next = new Int32Array(n).fill(-1);
  const binOf = (lon, lat) => {
    const bx = Math.floor((lon - minLon) / step);
    const by = Math.floor((lat - minLat) / step);
    return bx < 0 || by < 0 || bx >= nx || by >= ny ? -1 : by * nx + bx;
  };
  for (let i = 0; i < n; i += 1) {
    const b = binOf(cells.lon[i], cells.lat[i]);
    next[i] = heads[b];
    heads[b] = i;
  }
  const maxDefault = step;
  return {
    /** Index of the nearest cell centre to (lon, lat) within maxDistDeg (default ≈ one bin). */
    nearest(lon, lat, maxDistDeg = maxDefault) {
      const bx = Math.floor((lon - minLon) / step);
      const by = Math.floor((lat - minLat) / step);
      let best = -1;
      let bestD = maxDistDeg * maxDistDeg;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const x = bx + dx;
          const y = by + dy;
          if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
          for (let i = heads[y * nx + x]; i !== -1; i = next[i]) {
            const d = (cells.lon[i] - lon) ** 2 + (cells.lat[i] - lat) ** 2;
            if (d <= bestD) {
              bestD = d;
              best = i;
            }
          }
        }
      }
      return best;
    },
  };
}
