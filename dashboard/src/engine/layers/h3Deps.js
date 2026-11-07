/**
 * The two H3 dependencies of the analyst hexagon aggregation, behind ONE dynamic import
 * (layers/h3.js `loadH3`). Static named re-exports keep Rollup's tree-shaking: a bare
 * `import("@deck.gl/geo-layers")` would pull every geo layer (tiles, 3D tiles, MVT, terrain and
 * their loaders.gl dependencies) into the bundle, because a dynamic import of a package
 * namespace cannot be tree-shaken.
 */
export { H3HexagonLayer } from "@deck.gl/geo-layers";
export { latLngToCell } from "h3-js";
