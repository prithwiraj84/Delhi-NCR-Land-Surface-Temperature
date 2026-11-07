/**
 * Basemap style URLs (CARTO Dark Matter), kept in a dependency-free module so code that only
 * needs the URLs (the v2 ThermalStage choosing a style) does not import MapLibre with them.
 * Basemap.jsx re-exports both constants for the v1 map view.
 */

/** Dark Matter with place labels (used while the dashboard's own district labels are off). */
export const BASEMAP_STYLE_URL = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

/**
 * Same Dark Matter style without place labels. Used while the dashboard's own district
 * labels are on, so basemap city names ("PANIPAT", "Rohtak", ...) do not print on top of
 * (or next to duplicates of) the district labels. With district labels off, the labelled
 * style returns to give geographic context.
 */
export const BASEMAP_STYLE_NOLABELS_URL = "https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json";
