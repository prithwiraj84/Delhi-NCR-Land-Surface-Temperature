/**
 * ThermalColumnLayer (UI_SPEC §6.1 item 3, §6.2): 1 km square prisms for the thermal grid.
 *
 * A ColumnLayer subclass whose only shader change is the `thermalColumn` module:
 *   - TOP faces (normal.z > 0.9) carry the exact LUT colour, unlit ("data-pure" tops, B's graft);
 *   - SIDE faces keep deck's satin lighting plus a faint Fresnel rim (0.25; 0 at perf tier ≥ 2).
 * Everything else (geometry, picking, binary attributes) is the stock ColumnLayer, so picking
 * parity with the rendered geometry is guaranteed.
 *
 * Two data paths feed it:
 *   CPU (milestone M1): binary `getFillColor` (RGBA from colorize.js) and `getElevation` (metres);
 *   GPU (milestone M2): add ThermalSlotsExtension; `getFillColor` is the constant white and
 *        `getElevation` the constant 0 — colour and height come from the two value slots.
 *
 * `createThermalColumns()` builds the props from engine state; `columnGeometry()` caches the
 * stable binary position buffer per Cells object (positions upload once per bundle).
 */

import { ColumnLayer } from "@deck.gl/layers";
import { thermalColumnModule } from "../shaders/thermal.glsl.js";

/** Share of the cell footprint covered by a prism; the gap reads as a subtle grid (v1). */
export const CELL_COVERAGE = 0.92;

/** v1 satin material: mostly diffuse with a restrained specular glint. */
export const MATERIAL = Object.freeze({ ambient: 0.6, diffuse: 0.55, shininess: 40, specularColor: [70, 80, 100] });
/** Flat material (perf tier ≥ 2): ambient only, no specular. */
export const FLAT_MATERIAL = Object.freeze({ ambient: 1, diffuse: 0, shininess: 1, specularColor: [0, 0, 0] });

/** Cell footprint "radius" (centre → corner, metres) for a square rendered as a 4-gon. */
export function cellRadius(cellSizeM) {
  const size = Number.isFinite(cellSizeM) && cellSizeM > 0 ? cellSizeM : 1000;
  return (size / Math.SQRT2) * CELL_COVERAGE;
}

export default class ThermalColumnLayer extends ColumnLayer {
  getShaders() {
    const shaders = super.getShaders();
    return { ...shaders, modules: [...shaders.modules, thermalColumnModule] };
  }

  draw(opts) {
    const slots = (this.props.extensions ?? []).some((e) => e?.constructor?.extensionName === "ThermalSlotsExtension");
    this.setShaderModuleProps({ thermalColumn: { opts: [this.props.thermalRim ?? 0.25, slots ? 1 : 0, 0, 0] } });
    super.draw(opts);
  }
}

ThermalColumnLayer.layerName = "ThermalColumnLayer";
ThermalColumnLayer.defaultProps = {
  ...ColumnLayer.defaultProps,
  thermalRim: { type: "number", value: 0.25 },
};

const geometryCache = new WeakMap();
const dataCache = new Map();

/**
 * Stable `data` object per layer id: reused while every attribute wrapper is identical, so deck
 * sees no data change (no attribute invalidation) on frames where only uniforms move.
 */
function columnData(id, geometry, attributes) {
  const prev = dataCache.get(id);
  const keys = Object.keys(attributes);
  if (prev && prev.geometry === geometry && prev.keys.length === keys.length && keys.every((k) => prev.attributes[k] === attributes[k])) return prev.data;
  const data = { length: geometry.n, attributes: { getPosition: geometry.getPosition, ...attributes } };
  dataCache.set(id, { geometry, keys, attributes: { ...attributes }, data });
  return data;
}

/**
 * Stable binary positions for a Cells object: `{n, getPosition: {value: Float32Array(n·3), size: 3}}`.
 * The wrapper identity never changes, so deck uploads positions exactly once.
 */
export function columnGeometry(cells) {
  let g = geometryCache.get(cells);
  if (!g) {
    const positions = new Float32Array(cells.n * 3);
    for (let i = 0; i < cells.n; i += 1) {
      positions[i * 3] = cells.lon[i];
      positions[i * 3 + 1] = cells.lat[i];
    }
    g = { n: cells.n, getPosition: { value: positions, size: 3 } };
    geometryCache.set(cells, g);
  }
  return g;
}

/**
 * Props of one ThermalColumnLayer instance.
 * @param {object} p
 * @param {string} p.id
 * @param {object} p.cells canonical cells
 * @param {object} p.attributes binary attributes (`getFillColor`, `getElevation` on the CPU path;
 *   `getValueA`, `getValueB`, `getThermalAux` on the GPU path); wrappers must change identity when
 *   their content changes
 * @param {Array} [p.extensions]
 */
export function createThermalColumns({ id, cells, attributes, extensions = [], extruded = true, elevationScale = 1, opacity = 0.92, pickable = true, material = MATERIAL, rim = 0.25, cellSizeM = 1000, gpu = false, ...rest }) {
  const geometry = columnGeometry(cells);
  return new ThermalColumnLayer({
    id,
    data: columnData(id, geometry, attributes),
    diskResolution: 4,
    angle: 45,
    radius: cellRadius(cellSizeM),
    coverage: 1,
    extruded,
    elevationScale,
    material,
    thermalRim: rim,
    opacity,
    pickable,
    autoHighlight: false,
    getFillColor: gpu ? [255, 255, 255, 255] : [0, 0, 0, 0],
    getElevation: 0,
    extensions,
    ...rest,
  });
}
