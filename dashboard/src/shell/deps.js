/**
 * Cross-stream module resolution for the shell.
 *
 * The v2 dashboard is built by five parallel streams (UI_SPEC_v2 §14). The shell must build,
 * test and run while sibling modules are still being written, so it resolves them through
 * `import.meta.glob`: a missing file simply yields no entry (instead of a build error) and the
 * shell falls back to a clearly marked placeholder. Once every stream has landed, the globs
 * resolve to exactly the same module instances a static import would (Vite de-duplicates
 * modules), so there is no second source of truth.
 *
 *   stores    E2  src/state/stores/{timeStore,viewStore,selectionStore}.js  (eager)
 *   hooks     E2  src/data/hooks.js                                         (eager)
 *   stage     E3  src/shell/ThermalStage.jsx                                (lazy)
 *   views     E4  src/views/control/MissionControl.jsx                      (lazy)
 *             E5  src/views/{timeline,drivers,zones,lab,sources}/*.jsx       (lazy)
 *   legacy    v1  src/components/{MapContainer,ShapDependenceViewer,…}.jsx  (lazy, M1 fallback)
 *
 * Fallback stores implement the §7 shapes and actions with plain zustand so the shell (and its
 * tests) behave correctly even before E2's stores exist. They are only created when the real
 * module is absent, and log a single console warning in development.
 */
import { create } from "zustand";

const storeModules = import.meta.glob(["../state/stores/*.js", "!../state/stores/*.test.js", "!../state/stores/index.js"], {
  eager: true,
});
const hookModules = import.meta.glob(["../data/hooks.js"], { eager: true });

/** Lazy loaders keyed by the path relative to this file. */
export const stageLoaders = import.meta.glob(["./ThermalStage.jsx"]);
export const viewLoaders = import.meta.glob([
  "../views/control/MissionControl.jsx",
  "../views/timeline/TimelineView.jsx",
  "../views/drivers/DriversView.jsx",
  "../views/zones/ZonesView.jsx",
  "../views/lab/ModelLab.jsx",
  "../views/sources/SourcesView.jsx",
]);
export const legacyLoaders = import.meta.glob([
  "../components/MapContainer.jsx",
  "../components/ShapDependenceViewer.jsx",
  "../components/GovernanceZoning.jsx",
  "../components/ModelPerformance.jsx",
]);

const warned = new Set();
function warnOnce(key, message) {
  if (warned.has(key) || !import.meta.env?.DEV || import.meta.env?.MODE === "test") return;
  warned.add(key);
  console.warn(`[shell] ${message}`);
}

/** True for a zustand bound hook (callable + getState/setState/subscribe). */
export function isStoreHook(candidate) {
  return (
    typeof candidate === "function" &&
    typeof candidate.getState === "function" &&
    typeof candidate.setState === "function" &&
    typeof candidate.subscribe === "function"
  );
}

function pickStore(file, names) {
  const mod = storeModules[`../state/stores/${file}`];
  if (!mod) return null;
  for (const name of names) if (isStoreHook(mod[name])) return mod[name];
  return Object.values(mod).find(isStoreHook) ?? null;
}

// ---------------------------------------------------------------------------------------
// Fallback stores (UI_SPEC §7 shapes) - used only while E2's stores are missing.
// ---------------------------------------------------------------------------------------

const FALLBACK_YEARS = Object.freeze([1990, 1995, 2000, 2005, 2010, 2015, 2020, 2025, 2030, 2035, 2040, 2045, 2050]);

function createFallbackTimeStore() {
  return create((set, get) => ({
    years: FALLBACK_YEARS,
    year: 2025,
    scrubT: 2025,
    playing: false,
    speed: 1,
    loop: false,
    snap: true,
    mode: "day",
    ssp: "ssp245",
    bracket: { iA: 7, iB: 7, mix: 0 },
    compare: null,
    setYear: (year) => {
      const y = Math.max(1990, Math.min(2050, Math.round(Number(year))));
      if (Number.isFinite(y)) set({ year: y, scrubT: y });
    },
    scrubTo: (t) => set({ scrubT: Math.max(1990, Math.min(2050, Number(t))) }),
    release: () => {
      const { scrubT, years } = get();
      const nearest = years.reduce((best, y) => (Math.abs(y - scrubT) < Math.abs(best - scrubT) ? y : best), years[0]);
      set({ year: nearest, scrubT: nearest });
    },
    play: () => set({ playing: true }),
    pause: () => set({ playing: false }),
    step: (dir) => {
      const { year, years } = get();
      const next = dir > 0 ? years.find((y) => y > year) : [...years].reverse().find((y) => y < year);
      if (next !== undefined) set({ year: next, scrubT: next });
    },
    jumpTier: (dir) => {
      const { year } = get();
      const marks = [1990, 2025, 2050];
      const next = dir > 0 ? marks.find((y) => y > year) : [...marks].reverse().find((y) => y < year);
      if (next !== undefined) set({ year: next, scrubT: next });
    },
    setMode: (mode) => set({ mode }),
    cycleSsp: () => {
      const order = ["ssp126", "ssp245", "ssp585"];
      const i = order.indexOf(get().ssp);
      set({ ssp: order[(i + 1) % order.length] });
    },
    setCompare: (compare) => set({ compare: compare ?? null }),
  }));
}

function createFallbackViewStore() {
  return create((set) => ({
    route: "control",
    layer: "lst",
    shapFeature: null,
    variable: "abs",
    renderMode: "auto",
    heightMode: "anom",
    quantile: "p50",
    lens: false,
    analyst: { opacity: 1, h3: false, labels: true, boundaries: true, hillshade: false },
    motionPref: "system",
    perfTier: 0,
    briefing: { active: false, step: 0 },
    domainMode: "fixed",
    setRoute: (route) => set({ route }),
  }));
}

function createFallbackSelectionStore() {
  return create(() => ({ hoverIndex: null, pinnedIndex: null, districtId: null, zoneId: null, brushMask: null }));
}

function resolveStore(file, names, factory) {
  const real = pickStore(file, names);
  if (real) return { store: real, fallback: false };
  warnOnce(file, `src/state/stores/${file} not found - using the shell's FALLBACK store (UI_SPEC §7 shape).`);
  return { store: factory(), fallback: true };
}

const time = resolveStore("timeStore.js", ["useTimeStore", "timeStore", "default"], createFallbackTimeStore);
const view = resolveStore("viewStore.js", ["useViewStore", "viewStore", "default"], createFallbackViewStore);
const selection = resolveStore("selectionStore.js", ["useSelectionStore", "selectionStore", "default"], createFallbackSelectionStore);

/** zustand hooks of E2's stores (or the fallbacks). Call as hooks or use `.getState()`. */
export const useTimeStore = time.store;
export const useViewStore = view.store;
export const useSelectionStore = selection.store;

/** Which stores are fallbacks (shown by the dev perf HUD and asserted in tests). */
export const storeFallbacks = Object.freeze({ time: time.fallback, view: view.fallback, selection: selection.fallback });

/**
 * Set one field on a store through its dedicated action when it exists (e.g. `setRoute`,
 * `setMotionPref`), otherwise through `setState` - so the shell never depends on optional
 * action names beyond the frozen §7 list.
 */
export function setStoreField(store, key, value) {
  const state = store.getState();
  const action = state[`set${key[0].toUpperCase()}${key.slice(1)}`];
  if (typeof action === "function") action(value);
  else store.setState({ [key]: value });
}

/** Call a store action by name if present; returns true when it ran. */
export function callAction(store, name, ...args) {
  const fn = store.getState()[name];
  if (typeof fn !== "function") return false;
  fn(...args);
  return true;
}

// ---------------------------------------------------------------------------------------
// Data hooks (E2 src/data/hooks.js) with "unavailable" fallbacks
// ---------------------------------------------------------------------------------------

const hooksModule = hookModules["../data/hooks.js"] ?? null;
const UNAVAILABLE = Object.freeze({ status: "unavailable", data: null, reason: "src/data/hooks.js is not built yet" });
const unavailableHook = () => UNAVAILABLE;

/** `useTimeline()` from E2, or a hook that reports `unavailable` (shell then reads the manifest). */
export const useTimelineHook = typeof hooksModule?.useTimeline === "function" ? hooksModule.useTimeline : unavailableHook;
/** `useFrameStats(year, mode, ssp)` from E2, or `unavailable`. */
export const useFrameStatsHook = typeof hooksModule?.useFrameStats === "function" ? hooksModule.useFrameStats : unavailableHook;
export const hooksAvailable = Boolean(hooksModule);
