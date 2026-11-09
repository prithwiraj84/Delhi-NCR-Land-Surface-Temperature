/**
 * The six routes of the Delhi NCR Heat Atlas explorer (UI_SPEC_v2 §2.1) and what the persistent map stage
 * does behind each of them. Hash routing: `#/<route>?<params>` (params: state/urlSync.js).
 */
import { BrainCircuit, Database, FlaskConical, Hexagon, LineChart, Map as MapIcon } from "lucide-react";

/**
 * Stage behaviour per route:
 *   live        full-bleed, interactive (Control)
 *   dimmed      40 % opacity, paused, non-interactive; mini-map docked (Timeline)
 *   dock-right  docked right 40 %, live (Drivers)
 *   dock-left   docked left 45 % (Zones)
 *   hidden      not visible; paused (Model Lab, Sources)
 * On mobile (< 640 px) the stage is unmounted behind every non-Control route.
 */
export const ROUTES = Object.freeze([
  Object.freeze({
    id: "control",
    key: "1",
    label: "Heat map",
    short: "Map",
    icon: MapIcon,
    stage: "live",
    view: "../views/control/MissionControl.jsx",
    legacy: "../components/MapContainer.jsx",
    description: "Map, telemetry, inspector, time ribbon, layers, compare and briefing",
  }),
  Object.freeze({
    id: "timeline",
    key: "2",
    label: "Timeline",
    short: "Timeline",
    icon: LineChart,
    stage: "dimmed",
    view: "../views/timeline/TimelineView.jsx",
    legacy: null,
    description: "1990–2050 fan charts, atlas, district ledger, day vs night, decomposition",
  }),
  Object.freeze({
    id: "drivers",
    key: "3",
    label: "AI drivers",
    short: "Drivers",
    icon: BrainCircuit,
    stage: "dock-right",
    view: "../views/drivers/DriversView.jsx",
    legacy: "../components/ShapDependenceViewer.jsx",
    description: "SHAP importance, dependence and thresholds, interactions, what-if simulator",
  }),
  Object.freeze({
    id: "zones",
    key: "4",
    label: "Heat zones",
    short: "Zones",
    icon: Hexagon,
    stage: "dock-left",
    view: "../views/zones/ZonesView.jsx",
    legacy: "../components/GovernanceZoning.jsx",
    description: "Governance zones, share band, alluvial across frames, policy table",
  }),
  Object.freeze({
    id: "lab",
    key: "5",
    label: "Model lab",
    short: "Model",
    icon: FlaskConical,
    stage: "hidden",
    view: "../views/lab/ModelLab.jsx",
    legacy: "../components/ModelPerformance.jsx",
    description: "Honest skill, fold map, AOA, downscaling, hindcast, uncertainty budget",
  }),
  Object.freeze({
    id: "sources",
    key: "6",
    label: "Data sources",
    short: "Data",
    icon: Database,
    stage: "hidden",
    view: "../views/sources/SourcesView.jsx",
    legacy: null,
    description: "Provenance swimlanes, frame provenance, caveats, validation, downloads",
  }),
]);

export const ROUTE_IDS = Object.freeze(ROUTES.map((r) => r.id));
export const DEFAULT_ROUTE = "control";
export const ROUTE_BY_ID = Object.freeze(Object.fromEntries(ROUTES.map((r) => [r.id, r])));

/** v1 hash ids (#twin …) -> v2 routes, so old links keep working. */
export const LEGACY_ROUTE_ALIASES = Object.freeze({
  twin: "control",
  thresholds: "drivers",
  performance: "lab",
  models: "lab",
  story: "control",
  futures: "timeline",
});

/** Route id for any input (unknown -> null). */
export function normalizeRoute(id) {
  if (typeof id !== "string") return null;
  const key = id.trim().toLowerCase();
  if (ROUTE_BY_ID[key]) return key;
  return LEGACY_ROUTE_ALIASES[key] ?? null;
}

/** Mobile tab bar: four primary routes + "More" (Model Lab, Sources). */
export const MOBILE_PRIMARY = Object.freeze(["control", "timeline", "drivers", "zones"]);
export const MOBILE_MORE = Object.freeze(["lab", "sources"]);

/**
 * Effective stage behaviour for a route at a viewport width (px): on mobile everything but
 * Control unmounts the stage ("unmounted").
 */
export function stageBehaviour(routeId, width = Infinity) {
  const route = ROUTE_BY_ID[routeId] ?? ROUTE_BY_ID[DEFAULT_ROUTE];
  if (width < 640 && route.id !== "control") return "unmounted";
  return route.stage;
}
