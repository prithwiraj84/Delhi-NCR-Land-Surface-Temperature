/**
 * Vitest configuration (the app itself is built by Next.js; Vitest only needs the React JSX
 * transform). Pure modules run in Node; component / a11y tests opt into jsdom per file.
 */
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    include: ["src/**/*.test.js", "app/**/*.test.js", "lib/**/*.test.js"],
    // jsdom + axe suites render whole views over three bundles in parallel workers; the 5 s
    // default made the first axe pass of a file flaky under that load (it takes ~4 s alone).
    testTimeout: 20000,
  },
});
