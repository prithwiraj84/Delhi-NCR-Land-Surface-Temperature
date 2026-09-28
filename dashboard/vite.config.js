/**
 * Vite + Vitest configuration for the Delhi NCR thermal digital twin.
 *
 * - The React plugin provides fast refresh in dev and the automatic JSX runtime.
 * - `manualChunks` splits the heavy WebGL stack (deck.gl + luma.gl + maplibre), the
 *   charting stack (recharts + d3) and React itself into separately cacheable chunks,
 *   so a redeploy that only touches app code does not invalidate megabytes of vendor JS.
 * - Vitest runs the pure `src/lib` modules in a Node environment (no DOM needed).
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const GEO_VENDOR =
  /[\\/]node_modules[\\/](@deck\.gl|deck\.gl|@luma\.gl|@loaders\.gl|@math\.gl|@probe\.gl|maplibre-gl|react-map-gl|h3-js|mjolnir\.js|gl-matrix)[\\/]/;
const CHART_VENDOR =
  /[\\/]node_modules[\\/](recharts|recharts-scale|victory-vendor|decimal\.js-light|d3-[a-z-]+)[\\/]/;
const REACT_VENDOR = /[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/;

/** Map a module id from node_modules to a vendor chunk name (undefined = Rollup default). */
function vendorChunk(id) {
  if (!id.includes("node_modules")) return undefined;
  if (GEO_VENDOR.test(id)) return "vendor-geo";
  if (CHART_VENDOR.test(id)) return "vendor-charts";
  if (REACT_VENDOR.test(id)) return "vendor-react";
  return undefined;
}

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      output: { manualChunks: vendorChunk },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.js"],
  },
});
