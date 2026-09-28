/**
 * deck.gl layer factories for the spatial digital twin.
 *
 * Performance notes (~55k cells):
 *   - Cells are rendered from the columnar epoch with `data = {length: n}` and index
 *     accessors, so no per-cell JS objects are ever allocated.
 *   - The `data` object and the position accessor are cached per epoch: deck.gl treats a
 *     new `data` reference as "everything changed" and would re-run every accessor.
 *   - Colours/elevations are precomputed typed arrays (mapMetrics.buildCellAttributes);
 *     the accessors only copy from them, and `updateTriggers` carry a cheap identity key
 *     of those arrays so deck.gl refreshes exactly the attribute that changed.
 *   - Opacity, extrusion scale and the extruded flag are uniforms -> slider moves never
 *     touch per-cell attributes.
 */
import { AmbientLight, DirectionalLight, LightingEffect } from "@deck.gl/core";
import { ColumnLayer, GeoJsonLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import { H3HexagonLayer } from "@deck.gl/geo-layers";
import { CollisionFilterExtension } from "@deck.gl/extensions";

/** Shared instance: deck.gl compares extensions by identity, a new one per render would rebuild the layer. */
const COLLISION_FILTER = new CollisionFilterExtension();

/** Share of the cell footprint covered by a prism; the gap reads as a subtle grid. */
export const CELL_COVERAGE = 0.92;

/** Cyan accent (#22d3ee) used for highlight and pinned-cell rings. */
const ACCENT = [34, 211, 238];

/**
 * Scene lighting: a soft ambient fill plus a key light from the south-west and a cool
 * rim light, so extruded prisms get readable side shading without washing out colours.
 */
const LIGHTING_EFFECT = new LightingEffect({
  ambient: new AmbientLight({ color: [255, 255, 255], intensity: 1.05 }),
  key: new DirectionalLight({ color: [255, 244, 230], intensity: 0.85, direction: [-3, -9, -5] }),
  rim: new DirectionalLight({ color: [170, 200, 255], intensity: 0.45, direction: [4, 7, -3] }),
});

/** Stable `effects` prop for DeckGL (a new array per render would be diffed each frame). */
export const MAP_EFFECTS = [LIGHTING_EFFECT];

/** Satin material: mostly diffuse with a restrained specular glint on the column tops. */
const MATERIAL = { ambient: 0.6, diffuse: 0.55, shininess: 40, specularColor: [70, 80, 100] };

/** Draw overlays on top of extruded geometry regardless of depth (luma.gl v9 parameters). */
const ALWAYS_ON_TOP = { depthCompare: "always", depthWriteEnabled: false };

/** Cell footprint "radius" (centre -> corner, metres) for a square rendered as a 4-gon. */
export function cellRadius(cellSizeM) {
  const size = Number.isFinite(cellSizeM) && cellSizeM > 0 ? cellSizeM : 1000;
  return (size / Math.SQRT2) * CELL_COVERAGE;
}

const epochGeometryCache = new WeakMap();

/** Stable `{length}` data object + position accessor for an epoch. */
function epochGeometry(epoch) {
  let geometry = epochGeometryCache.get(epoch);
  if (!geometry) {
    const { lon, lat } = epoch;
    geometry = {
      data: { length: epoch.n },
      getPosition: (_, { index }) => [lon[index], lat[index]],
    };
    epochGeometryCache.set(epoch, geometry);
  }
  return geometry;
}

/**
 * The 3-D thermal grid: one square prism per 1 km (or 2 km) cell.
 *
 * @param {object} p
 * @param {object} p.epoch        columnar epoch (typed arrays)
 * @param {{colors: Uint8Array, elevations: Float32Array}} p.attributes
 * @param {string|number} p.attributesKey identity key of `attributes` (update trigger)
 */
export function createCellLayer({ epoch, attributes, attributesKey, extruded, elevationScale, opacity, onClick }) {
  const { data, getPosition } = epochGeometry(epoch);
  const { colors, elevations } = attributes;
  return new ColumnLayer({
    id: "thermal-cells",
    data,
    getPosition,
    getFillColor: (_, { index, target }) => {
      const o = index * 4;
      target[0] = colors[o];
      target[1] = colors[o + 1];
      target[2] = colors[o + 2];
      target[3] = colors[o + 3];
      return target;
    },
    getElevation: (_, { index }) => elevations[index],
    updateTriggers: { getFillColor: attributesKey, getElevation: attributesKey },
    diskResolution: 4,
    angle: 45,
    radius: cellRadius(epoch.cell_size_m),
    extruded,
    elevationScale: extruded ? elevationScale : 0,
    material: MATERIAL,
    opacity,
    pickable: true,
    autoHighlight: true,
    highlightColor: [...ACCENT, 230],
    transitions: { getElevation: { duration: 550 } },
    onClick,
  });
}

/** Aggregated H3 hexagons (extruded in 3-D mode). */
export function createHexLayer({ hexes, resolution, extruded, elevationScale, opacity, onClick }) {
  return new H3HexagonLayer({
    id: `h3-hexes-r${resolution}`,
    data: hexes,
    getHexagon: (d) => d.hex,
    getFillColor: (d) => d.rgba,
    getElevation: (d) => d.elevation,
    extruded,
    elevationScale: extruded ? elevationScale : 0,
    coverage: 0.94,
    stroked: !extruded,
    getLineColor: [9, 13, 22, 170],
    lineWidthUnits: "pixels",
    getLineWidth: 0.6,
    material: MATERIAL,
    opacity,
    pickable: true,
    autoHighlight: true,
    highlightColor: [...ACCENT, 230],
    onClick,
  });
}

/** Thin district outlines, no fill, drawn over the prisms. */
export function createBoundaryLayer(districtsGeo) {
  return new GeoJsonLayer({
    id: "district-boundaries",
    data: districtsGeo,
    stroked: true,
    filled: false,
    getLineColor: [148, 197, 255, 150],
    lineWidthUnits: "pixels",
    getLineWidth: 1.1,
    lineWidthMinPixels: 1,
    pickable: false,
    parameters: ALWAYS_ON_TOP,
  });
}

/**
 * District name labels at the centroid of each district's cells.
 * Neighbouring centroids (e.g. Faridabad / Gautam Buddh Nagar) overlap at NCR-wide zoom, so a
 * collision filter hides the lower-priority label until the user zooms in. Priority: Delhi NCT
 * first, then districts with more cells (deck.gl clamps priority to [-1000, 1000]).
 */
export function createLabelLayer(districtSummaries) {
  return new TextLayer({
    id: "district-labels",
    data: districtSummaries,
    getPosition: (d) => [d.lon, d.lat],
    getText: (d) => d.name,
    getSize: 12,
    sizeUnits: "pixels",
    getColor: [226, 232, 240, 235],
    fontFamily: "Inter, system-ui, sans-serif",
    fontWeight: 600,
    fontSettings: { sdf: true },
    outlineWidth: 3,
    outlineColor: [9, 13, 22, 235],
    getTextAnchor: "middle",
    getAlignmentBaseline: "center",
    pickable: false,
    parameters: ALWAYS_ON_TOP,
    extensions: [COLLISION_FILTER],
    collisionEnabled: true,
    getCollisionPriority: (d) => (d.id === 0 ? 1000 : Math.min(999, Math.round((d.count ?? 0) / 20))),
    // Collision footprint = rendered glyph box plus a few px of breathing room.
    collisionTestProps: { sizeScale: 1.25 },
  });
}

/**
 * Glowing ring marking the pinned cell, placed at the top of its prism so it stays
 * attached to the column in 3-D.
 */
export function createPinnedCellLayer({ epoch, index, elevation, extruded, elevationScale }) {
  const z = extruded ? elevation * elevationScale : 0;
  return new ScatterplotLayer({
    id: "pinned-cell",
    data: [{ position: [epoch.lon[index], epoch.lat[index], z] }],
    getPosition: (d) => d.position,
    radiusUnits: "meters",
    getRadius: (Number.isFinite(epoch.cell_size_m) ? epoch.cell_size_m : 1000) * 1.6,
    radiusMinPixels: 7,
    stroked: true,
    filled: true,
    getFillColor: [...ACCENT, 40],
    getLineColor: [...ACCENT, 255],
    lineWidthUnits: "pixels",
    getLineWidth: 2,
    pickable: false,
    parameters: ALWAYS_ON_TOP,
  });
}
