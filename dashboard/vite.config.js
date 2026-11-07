/**
 * Vite + Vitest configuration for NCR THERMAL/OPS v2.
 *
 * Chunking (UI_SPEC_v2 §11: initial JS <= 800 kB gzip; recharts, h3-js and every non-Control
 * route lazy). `manualChunks` only names cache-stable vendor groups; it never decides what is
 * eager - that is decided by the import graph (lazy routes, lazy ThermalStage). The groups are
 * chosen so that a chunk reached from the entry never *also* contains a lazy-only library,
 * because Rollup pulls an unassigned dependency of a manual chunk into that chunk: if `clsx`
 * (used by the shell AND by recharts) landed in vendor-charts, the entry would have to preload
 * all of recharts just to get clsx. Hence:
 *
 *   vendor-react   react, react-dom, scheduler                         (entry)
 *   vendor-ui      framer-motion, radix, floating-ui, zustand, clsx...  (entry)
 *   vendor-d3      d3-* + internmap (scales of the ribbon, charts)      (lazy, with the first route)
 *   vendor-geo     deck.gl + luma.gl (the persistent map stage)         (lazy ThermalStage; the
 *                  default Control route requests it immediately after boot)
 *   vendor-maplibre maplibre-gl + react-map-gl (the basemap)            (lazy LazyBasemap: fetched
 *                  in parallel with the first deck.gl paint, never ahead of it)
 *   vendor-h3      h3-js + deck geo/mesh/aggregation layers (Analyst H3 toggle, v1 map) (lazy)
 *   vendor-charts  recharts and its private deps                       (lazy routes only)
 *
 * Vitest runs the pure modules in Node; component/a11y tests opt into jsdom per file.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const NM = String.raw`[\\/]node_modules[\\/]`;
const pkg = (names) => new RegExp(`${NM}(${names})[\\\\/]`);

// h3-js plus the deck.gl layer packages only the H3 aggregation and the v1 map view use. Keeping
// @deck.gl/geo-layers out of vendor-geo stops vendor-geo from statically importing h3-js.
const H3_VENDOR = pkg(String.raw`h3-js|@deck\.gl[\\/]geo-layers|@deck\.gl[\\/]mesh-layers|@deck\.gl[\\/]aggregation-layers`);
// MapLibre ships as one prebuilt bundle (its @mapbox/* helpers are inlined), so the chunk is
// just maplibre-gl + react-map-gl. (@mapbox/tiny-sdf etc. in node_modules belong to deck.gl.)
const MAPLIBRE_VENDOR = pkg(String.raw`maplibre-gl|@maplibre|react-map-gl`);
const GEO_VENDOR = pkg(String.raw`@deck\.gl|deck\.gl|@luma\.gl|@loaders\.gl|@math\.gl|@probe\.gl|mjolnir\.js|gl-matrix|earcut`);
const CHART_VENDOR = pkg(
  String.raw`recharts|recharts-scale|victory-vendor|decimal\.js-light|react-smooth|fast-equals|eventemitter3|lodash|react-is|tiny-invariant|react-transition-group|dom-helpers`,
);
const D3_VENDOR = pkg(String.raw`d3-[a-z-]+|internmap`);
const UI_VENDOR = pkg(
  String.raw`clsx|tailwind-merge|class-variance-authority|@floating-ui|@radix-ui|zustand|framer-motion|motion-dom|motion-utils|lucide-react|use-sync-external-store|aria-hidden|react-remove-scroll|react-remove-scroll-bar|react-style-singleton|use-callback-ref|use-sidecar|get-nonce|detect-node-es|tslib`,
);
const REACT_VENDOR = pkg(String.raw`react|react-dom|scheduler`);

/**
 * Map a module id to a vendor chunk name (undefined = Rollup default).
 *
 * Two non-obvious rules:
 * - Rollup/Vite helper modules (`\0vite/preload-helper.js`, `\0commonjsHelpers.js`) are shared
 *   by the entry and by lazy chunks. Left unassigned, Rollup hoists them into the first manual
 *   chunk that needs them - which made the entry statically import all of vendor-geo just for
 *   the 1 kB preload helper. They are pinned to vendor-react, which the entry loads anyway.
 * - CSS from node_modules (maplibre-gl.css, imported by main.jsx) is left to the entry so its
 *   JS stub does not create an entry -> vendor-geo edge.
 */
export function vendorChunk(id) {
  if (/preload-helper|commonjsHelpers/.test(id)) return "vendor-react";
  // The H3 re-export module joins its vendor chunk. As a separate ~0.4 kB chunk Rollup folded an
  // unrelated tiny shared module (the basemap style URLs) into it, which made ThermalStage
  // statically import vendor-h3 and put h3-js on the first-paint path.
  if (/[\\/]src[\\/]engine[\\/]layers[\\/]h3Deps\.js$/.test(id)) return "vendor-h3";
  if (!id.includes("node_modules")) return undefined;
  if (/\.css($|\?)/.test(id)) return undefined;
  if (H3_VENDOR.test(id)) return "vendor-h3";
  if (MAPLIBRE_VENDOR.test(id)) return "vendor-maplibre";
  if (GEO_VENDOR.test(id)) return "vendor-geo";
  if (CHART_VENDOR.test(id)) return "vendor-charts";
  if (D3_VENDOR.test(id)) return "vendor-d3";
  if (UI_VENDOR.test(id)) return "vendor-ui";
  if (REACT_VENDOR.test(id)) return "vendor-react";
  return undefined;
}

export default defineConfig({
  plugins: [react()],
  worker: { format: "es" },
  build: {
    // dist/.vite/manifest.json: the chunk graph `npm run budget` (scripts/check-budgets.mjs) reads.
    manifest: true,
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      output: { manualChunks: vendorChunk },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.js"],
    // jsdom + axe suites render whole views over three bundles in parallel workers; the 5 s
    // default made the first axe pass of a file flaky under that load (it takes ~4 s alone).
    testTimeout: 20000,
  },
});
