/**
 * H3 hexagon aggregation of the displayed map (Analyst ▸ "H3 hexagons"; v1 parity, UI_SPEC §3.2).
 *
 * Why hexagons: the native grid is right for inspecting single cells, but for regional reading
 * an equal-area-ish hierarchical hexagon index is easier on the eye (and on the GPU). The
 * aggregate is computed from exactly what the columns would show - the CPU-mixed values of the
 * current display (so an interpolated year aggregates the same "≈" field the map tweens), or
 * the categorical codes of a driver / zone / AOA layer - and coloured with the SAME LUT and
 * domain as the columns (colorize.js), so switching aggregation never changes colours:
 *   continuous   mean of the finite cell values per hexagon
 *   categorical  most frequent category per hexagon (ties -> the lower code)
 *
 * Resolution follows the bundle's grid: the smallest H3 resolution whose average hexagon is at
 * least ~4 cells (1 km grid -> res 7 ≈ 5.2 km², 2 km -> res 6 ≈ 36 km², coarser -> res 5), so
 * every hexagon aggregates several cells and none is left empty between cell centres.
 *
 * Cost: h3-js and @deck.gl/geo-layers (~65 kB gzip, chunk `vendor-h3`) are loaded only when the
 * toggle is first switched on. The cell -> hexagon index (`latLngToCell` for ~55k cells,
 * ~100-250 ms) is built once per cell set and resolution; re-aggregating a frame is one O(n)
 * pass plus an O(hexagons) colouring, and only the colour/elevation attributes are re-uploaded
 * (the hexagon list keeps its identity, so deck.gl never recomputes the hexagon geometry).
 */

/** Average hexagon area per H3 resolution (km², H3 documentation). */
const H3_AREA_KM2 = Object.freeze({ 5: 252.9, 6: 36.13, 7: 5.161, 8: 0.7373 });
/** Minimum number of grid cells an average hexagon should cover. */
const CELLS_PER_HEX = 4;

/** H3 resolution for a grid of `cellSizeM` metres (5..8). */
export function h3ResolutionFor(cellSizeM) {
  const cellKm2 = (Math.max(1, Number(cellSizeM) || 1000) / 1000) ** 2;
  for (const res of [8, 7, 6, 5]) {
    if (H3_AREA_KM2[res] >= CELLS_PER_HEX * cellKm2) return res;
  }
  return 5;
}

let modulePromise = null;

/**
 * Lazily load h3-js + deck.gl's H3HexagonLayer (one shared promise; a failed load can be
 * retried by calling again).
 * @returns {Promise<{latLngToCell: Function, H3HexagonLayer: Function}>}
 */
export function loadH3() {
  if (!modulePromise) {
    // One module with static named re-exports (h3Deps.js) so the geo-layers package tree-shakes.
    modulePromise = import("./h3Deps.js")
      .then((mod) => ({ latLngToCell: mod.latLngToCell, H3HexagonLayer: mod.H3HexagonLayer }))
      .catch((error) => {
        modulePromise = null;
        throw error;
      });
  }
  return modulePromise;
}

/**
 * Cell -> hexagon index. Cells with non-finite coordinates map to -1 and are skipped.
 * @param {{n: number, lon: ArrayLike<number>, lat: ArrayLike<number>}} cells
 * @param {number} resolution
 * @param {(lat: number, lon: number, res: number) => string} latLngToCell
 * @returns {{cells: object, resolution: number, hexIds: string[], cellHex: Int32Array, data: Array<{hex: string, i: number}>}}
 */
export function buildHexIndex(cells, resolution, latLngToCell) {
  const slotByHex = new Map();
  const hexIds = [];
  const cellHex = new Int32Array(cells.n);
  for (let i = 0; i < cells.n; i += 1) {
    const lat = cells.lat[i];
    const lon = cells.lon[i];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      cellHex[i] = -1;
      continue;
    }
    const hex = latLngToCell(lat, lon, resolution);
    let slot = slotByHex.get(hex);
    if (slot === undefined) {
      slot = hexIds.length;
      hexIds.push(hex);
      slotByHex.set(hex, slot);
    }
    cellHex[i] = slot;
  }
  // Stable data objects: deck.gl keys its geometry on the array identity.
  const data = hexIds.map((hex, i) => ({ hex, i }));
  return { cells, resolution, hexIds, cellHex, data };
}

/**
 * Mean of the finite `values` per hexagon (NaN where a hexagon has no finite cell).
 * @param {ArrayLike<number>} values per cell
 * @param {Int32Array} cellHex per-cell hexagon slot (-1 = none)
 * @param {number} nHex
 * @param {Float32Array} [out]
 */
export function hexMeans(values, cellHex, nHex, out = new Float32Array(nHex)) {
  const sum = new Float64Array(nHex);
  const count = new Uint32Array(nHex);
  const n = Math.min(values.length, cellHex.length);
  for (let i = 0; i < n; i += 1) {
    const h = cellHex[i];
    const v = values[i];
    if (h < 0 || v !== v) continue; // v !== v: NaN (nodata)
    sum[h] += v;
    count[h] += 1;
  }
  for (let h = 0; h < nHex; h += 1) out[h] = count[h] ? sum[h] / count[h] : NaN;
  return out;
}

/**
 * Most frequent category code per hexagon (-1 where none). Codes outside [0, nCodes) are nodata.
 * @param {ArrayLike<number>} codes per cell
 * @param {Int32Array} cellHex
 * @param {number} nHex
 * @param {number} nCodes palette size
 * @param {Int16Array} [out]
 */
export function hexModes(codes, cellHex, nHex, nCodes, out = new Int16Array(nHex)) {
  const k = Math.max(1, nCodes | 0);
  const counts = new Uint32Array(nHex * k);
  const n = Math.min(codes.length, cellHex.length);
  for (let i = 0; i < n; i += 1) {
    const h = cellHex[i];
    const c = codes[i];
    if (h < 0 || !(c >= 0) || c >= k) continue;
    counts[h * k + c] += 1;
  }
  for (let h = 0; h < nHex; h += 1) {
    let best = -1;
    let bestCount = 0;
    for (let c = 0; c < k; c += 1) {
      const x = counts[h * k + c];
      if (x > bestCount) {
        bestCount = x;
        best = c;
      }
    }
    out[h] = best;
  }
  return out;
}

/**
 * The hexagon layer. `colors` (RGBA bytes) and `elevations` (metres) are indexed by hexagon
 * slot; bump `version` whenever their content changes (only those attributes are rebuilt).
 */
export function createH3Layer({ H3HexagonLayer, index, colors, elevations, version, extruded, elevationScale, opacity, material }) {
  return new H3HexagonLayer({
    id: `thermal-h3-r${index.resolution}`,
    data: index.data,
    getHexagon: (d) => d.hex,
    getFillColor: (d, info) => {
      const o = d.i * 4;
      // deck passes a reusable `target` for non-binary attributes; allocate only without one.
      const target = info?.target ?? [0, 0, 0, 0];
      target[0] = colors[o];
      target[1] = colors[o + 1];
      target[2] = colors[o + 2];
      target[3] = colors[o + 3];
      return target;
    },
    getElevation: (d) => elevations[d.i] || 0,
    updateTriggers: { getFillColor: version, getElevation: version },
    extruded,
    elevationScale: extruded ? elevationScale : 0,
    coverage: 0.94,
    stroked: !extruded,
    getLineColor: [7, 11, 20, 170],
    lineWidthUnits: "pixels",
    getLineWidth: 0.6,
    material,
    opacity,
    // Readouts stay per cell (inspector / H / district walking); hexagons are a reading aid.
    pickable: false,
  });
}
