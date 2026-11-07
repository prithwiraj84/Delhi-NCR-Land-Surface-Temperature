#!/usr/bin/env node
/**
 * Bundle budget check (UI_SPEC_v2 §11) over the production build. Run after `npm run build`:
 *
 *   npm run budget            (exit 1 when a hard budget is exceeded)
 *
 * It reads Vite's build manifest (dist/.vite/manifest.json) and measures gzip sizes (kB = 1000
 * bytes, like Vite's own report) of the static-import closures that matter:
 *
 *   entry          index.html and everything it imports statically (shell, stores, data layer)
 *   control route  entry + ThermalStage + MissionControl closures: the JS on the critical path
 *                  of the default route's first map paint. Budget: <= 800 kB gzip.
 *   basemap        the MapLibre chunk, fetched in parallel with the first deck.gl paint (report)
 *   lazy routes    each non-Control route's own JS beyond the control-route set and the shared
 *                  vendor-charts chunk. Budget: <= 80 kB gzip each.
 *   fonts          the latin variable-font files the shell's text needs. Budget 100 kB
 *                  (reported as a warning: subsetting is a design decision, see UI_SPEC §4.3).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const manifestPath = join(dist, ".vite", "manifest.json");
if (!existsSync(manifestPath)) {
  console.error(`No build manifest at ${manifestPath}. Run \`npm run build\` first.`);
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const BUDGET = { controlRoute: 800, lazyRoute: 80, fonts: 100 };
const ROUTES = {
  timeline: "src/views/timeline/TimelineView.jsx",
  drivers: "src/views/drivers/DriversView.jsx",
  zones: "src/views/zones/ZonesView.jsx",
  lab: "src/views/lab/ModelLab.jsx",
  sources: "src/views/sources/SourcesView.jsx",
};

const gzCache = new Map();
/** gzip size (bytes) of a dist file. */
function gz(file) {
  if (!gzCache.has(file)) gzCache.set(file, gzipSync(readFileSync(join(dist, file)), { level: 9 }).length);
  return gzCache.get(file);
}
const kB = (bytes) => bytes / 1000;
const fmt = (bytes) => `${kB(bytes).toFixed(1)} kB`;

/**
 * Manifest record of a source path or manifest key. A dynamic entry that is also imported by
 * another lazy chunk (MissionControl, whose shared modules the lazy Briefing reuses) is keyed
 * by its chunk name ("_MissionControl-<hash>.js") instead of its source path.
 */
function lookup(key) {
  if (manifest[key]) return manifest[key];
  const name = key.split("/").pop().replace(/\.[jt]sx?$/, "");
  return Object.values(manifest).find((c) => c.src === key) ?? Object.values(manifest).find((c) => c.isDynamicEntry && c.name === name) ?? null;
}

/** Output files of the static-import closure of a manifest key or source path. */
function closure(key, out = new Set()) {
  const chunk = lookup(key);
  if (!chunk) throw new Error(`build manifest has no entry for ${key}`);
  if (out.has(chunk.file)) return out;
  out.add(chunk.file);
  for (const dep of chunk.imports ?? []) closure(dep, out);
  return out;
}
const total = (files) => [...files].reduce((sum, f) => sum + gz(f), 0);
const isVendor = (file, name) => new RegExp(`assets/${name}-[^/]+\\.js$`).test(file);

let failed = false;
const line = (ok, label, value, budget = null) => {
  if (!ok) failed = true;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label.padEnd(38)} ${value.padStart(10)}${budget ? `  (budget ${budget})` : ""}`);
};

const entry = closure("index.html");
const control = new Set([...entry, ...closure("src/shell/ThermalStage.jsx"), ...closure("src/views/control/MissionControl.jsx")]);
console.log("UI_SPEC_v2 §11 budgets (gzip, kB = 1000 B)\n");
line(true, "entry (shell + data layer)", fmt(total(entry)));
line(kB(total(control)) <= BUDGET.controlRoute, "control route, first map paint", fmt(total(control)), `${BUDGET.controlRoute} kB`);
const maplibre = Object.values(manifest).find((c) => isVendor(c.file, "vendor-maplibre"));
if (maplibre) line(true, "  + basemap (parallel, after paint)", fmt(gz(maplibre.file)));
for (const [id, key] of Object.entries(ROUTES)) {
  if (!lookup(key)) {
    line(false, `route ${id}`, "missing");
    continue;
  }
  const own = [...closure(key)].filter((f) => !control.has(f) && !isVendor(f, "vendor-charts") && !isVendor(f, "vendor-d3"));
  line(kB(total(own)) <= BUDGET.lazyRoute, `route ${id} (beyond shared vendors)`, fmt(total(own)), `${BUDGET.lazyRoute} kB`);
}

// Fonts: the latin subsets always load; other subsets (greek: Δ, σ) load on first use.
const assets = readdirSync(join(dist, "assets"));
const latin = assets.filter((f) => /-latin-wght-normal-[^.]+\.woff2$/.test(f));
const greek = assets.filter((f) => /-greek-wght-normal-[^.]+\.woff2$/.test(f));
const size = (f) => statSync(join(dist, "assets", f)).size;
const latinBytes = latin.reduce((s, f) => s + size(f), 0);
const greekBytes = greek.reduce((s, f) => s + size(f), 0);
const fontsOk = kB(latinBytes) <= BUDGET.fonts;
console.log(`${fontsOk ? "ok  " : "warn"}  ${"fonts (latin variable subsets)".padEnd(38)} ${fmt(latinBytes).padStart(10)}  (budget ${BUDGET.fonts} kB; +${fmt(greekBytes)} greek when Δ/σ render)`);

console.log(failed ? "\nBudget exceeded." : "\nAll hard budgets met.");
process.exit(failed ? 1 : 0);
