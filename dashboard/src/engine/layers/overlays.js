/**
 * Map overlays (UI_SPEC §6.1 items 5, 6, 8), ported from v1 `components/map/layers.js` and
 * restyled for v2:
 *   - district boundaries: hairline (ink @ 32 %), the hovered/selected district at 1.5 px ink;
 *   - district labels: TextLayer + CollisionFilterExtension (overlapping centroids at NCR zoom
 *     hide the lower-priority label until the user zooms in);
 *   - reticle: on-map selection is WHITE with a void halo, never the cyan chrome accent (D5), so
 *     UI state never reads as data on the teal/blue night ramp. Pinned = ring + halo; hover = a
 *     thinner ring. Both sit on the prism top so they stay attached in 3-D.
 */

import { CollisionFilterExtension } from "@deck.gl/extensions";
import { GeoJsonLayer, ScatterplotLayer, TextLayer } from "@deck.gl/layers";

/** deck compares extensions by identity: one shared instance. */
const COLLISION_FILTER = new CollisionFilterExtension();

/** Overlays draw over extruded geometry regardless of depth (luma v9 parameters). */
export const ALWAYS_ON_TOP = Object.freeze({ depthCompare: "always", depthWriteEnabled: false });

const INK = [223, 231, 242];
const INK_STRONG = [244, 247, 251];
const VOID = [5, 7, 13];

/** District hairlines; `highlightId` (district id) is drawn at 1.5 px full ink. */
export function createBoundaryLayer(districtsGeo, { highlightId = null, idOf = defaultDistrictId } = {}) {
  return new GeoJsonLayer({
    id: "district-boundaries",
    data: districtsGeo,
    stroked: true,
    filled: false,
    getLineColor: (f) => (highlightId !== null && idOf(f) === highlightId ? [...INK_STRONG, 235] : [...INK, 82]),
    getLineWidth: (f) => (highlightId !== null && idOf(f) === highlightId ? 1.5 : 1),
    lineWidthUnits: "pixels",
    lineWidthMinPixels: 1,
    updateTriggers: { getLineColor: highlightId, getLineWidth: highlightId },
    pickable: false,
    parameters: ALWAYS_ON_TOP,
  });
}

/** District id of a boundary feature (v1/v2 GeoJSON carry `properties.id`; else `district_id`). */
export function defaultDistrictId(feature) {
  const p = feature?.properties ?? {};
  const v = p.id ?? p.district_id ?? p.district ?? null;
  return v === null ? null : Number(v);
}

/**
 * Label anchors from the cells: centroid (mean lon/lat) and cell count per district id, named
 * from the manifest district table. Districts without cells are omitted.
 */
export function districtLabelData(cells, districts) {
  const names = new Map((districts ?? []).map((d) => [Number(d.id), d.name ?? d.label ?? `District ${d.id}`]));
  const acc = new Map();
  for (let i = 0; i < cells.n; i += 1) {
    const id = cells.district[i];
    if (id < 0) continue;
    let a = acc.get(id);
    if (!a) {
      a = { lon: 0, lat: 0, count: 0, minLon: Infinity, minLat: Infinity, maxLon: -Infinity, maxLat: -Infinity };
      acc.set(id, a);
    }
    const lon = cells.lon[i];
    const lat = cells.lat[i];
    a.lon += lon;
    a.lat += lat;
    a.count += 1;
    if (lon < a.minLon) a.minLon = lon;
    if (lon > a.maxLon) a.maxLon = lon;
    if (lat < a.minLat) a.minLat = lat;
    if (lat > a.maxLat) a.maxLat = lat;
  }
  return [...acc.entries()]
    .map(([id, a]) => ({ id, name: names.get(id) ?? `District ${id}`, lon: a.lon / a.count, lat: a.lat / a.count, count: a.count, bbox: [a.minLon, a.minLat, a.maxLon, a.maxLat] }))
    .sort((x, y) => x.id - y.id);
}

/** District name labels (priority: Delhi NCT id 0 first, then larger districts). */
export function createLabelLayer(labels) {
  return new TextLayer({
    id: "district-labels",
    data: labels,
    getPosition: (d) => [d.lon, d.lat],
    getText: (d) => d.name,
    getSize: 12,
    sizeUnits: "pixels",
    getColor: [...INK, 235],
    fontFamily: "'Inter Variable', Inter, system-ui, sans-serif",
    fontWeight: 600,
    fontSettings: { sdf: true },
    outlineWidth: 3,
    outlineColor: [...VOID, 235],
    getTextAnchor: "middle",
    getAlignmentBaseline: "center",
    pickable: false,
    parameters: ALWAYS_ON_TOP,
    extensions: [COLLISION_FILTER],
    collisionEnabled: true,
    getCollisionPriority: (d) => (d.id === 0 ? 1000 : Math.min(999, Math.round((d.count ?? 0) / 20))),
    collisionTestProps: { sizeScale: 1.25 },
  });
}

/**
 * Selection reticles: `pinned` and `hover` are `{lon, lat, z}` (z = prism top in metres × the
 * elevation scale) or null. White ring with a 2 px void halo (D5); hover is thinner.
 */
export function createReticleLayers({ pinned = null, hover = null, cellSizeM = 1000 }) {
  const out = [];
  const radius = (Number.isFinite(cellSizeM) ? cellSizeM : 1000) * 1.1;
  const ring = (id, d, width, minPx, alpha) => [
    new ScatterplotLayer({
      id: `${id}-halo`,
      data: [d],
      getPosition: (x) => [x.lon, x.lat, x.z],
      radiusUnits: "meters",
      getRadius: radius,
      radiusMinPixels: minPx,
      stroked: true,
      filled: false,
      getLineColor: [...VOID, Math.round(alpha * 0.9)],
      lineWidthUnits: "pixels",
      getLineWidth: width + 4,
      pickable: false,
      parameters: ALWAYS_ON_TOP,
    }),
    new ScatterplotLayer({
      id: `${id}-ring`,
      data: [d],
      getPosition: (x) => [x.lon, x.lat, x.z],
      radiusUnits: "meters",
      getRadius: radius,
      radiusMinPixels: minPx,
      stroked: true,
      filled: false,
      getLineColor: [...INK_STRONG, alpha],
      lineWidthUnits: "pixels",
      getLineWidth: width,
      pickable: false,
      parameters: ALWAYS_ON_TOP,
    }),
  ];
  if (hover && (!pinned || hover.index !== pinned.index)) out.push(...ring("reticle-hover", hover, 1, 6, 190));
  if (pinned) out.push(...ring("reticle-pinned", pinned, 2, 8, 255));
  return out;
}
