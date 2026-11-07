/**
 * Lazy resolution of route views and the map stage from the optional module globs in
 * deps.js (see there for why globs are used). Kept out of AppShell.jsx so the component file
 * only exports components (fast refresh) and so the resolution rules are unit-testable.
 */
import { lazy } from "react";
import { legacyLoaders, stageLoaders, viewLoaders } from "./deps.js";
import { DEFAULT_ROUTE, ROUTE_BY_ID } from "./routes.js";

const lazyCache = new Map();

/** Pick the component export of a lazily imported module (default, else first PascalCase export). */
export function pickComponent(mod) {
  if (typeof mod?.default === "function" || (mod?.default && typeof mod.default === "object")) return mod.default;
  const name = Object.keys(mod ?? {}).find((k) => /^[A-Z]/.test(k) && typeof mod[k] === "function");
  if (!name) throw new Error("Lazy module has no component export (expected a default or PascalCase export).");
  return mod[name];
}

/** React.lazy component for `path` in `loaders` (cached), or null when the file is absent. */
export function lazyFrom(loaders, path) {
  if (!path || typeof loaders[path] !== "function") return null;
  if (!lazyCache.has(path)) lazyCache.set(path, lazy(() => loaders[path]().then((mod) => ({ default: pickComponent(mod) }))));
  return lazyCache.get(path);
}

/** The persistent map stage (E3), or null while src/shell/ThermalStage.jsx is absent. */
export const ThermalStage = lazyFrom(stageLoaders, "./ThermalStage.jsx");

/** Which component renders a route: the v2 view, a v1 fallback, or nothing (placeholder). */
export function resolveRouteModule(routeId, { stageAvailable = Boolean(ThermalStage), views = viewLoaders, legacy = legacyLoaders } = {}) {
  const route = ROUTE_BY_ID[routeId] ?? ROUTE_BY_ID[DEFAULT_ROUTE];
  const v2 = lazyFrom(views, route.view);
  if (v2) return { route, Component: v2, kind: "v2" };
  // v1 MapContainer has its own map; only use it when the persistent stage is missing.
  if (route.legacy && (route.id !== "control" || !stageAvailable)) {
    const v1 = lazyFrom(legacy, route.legacy);
    if (v1) return { route, Component: v1, kind: "legacy" };
  }
  return { route, Component: null, kind: "missing" };
}
