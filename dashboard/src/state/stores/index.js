/**
 * Store barrel (UI_SPEC §7). Each store is a zustand hook with `getState()`, `subscribe()` and
 * `setState()`; the map engine reads them imperatively, React components through selectors.
 */
export { useTimeStore, timeStoreInitializer, selectInterpolated, selectExactYear, SNAP_RADIUS_YEARS, SPEEDS, COMPARE_KINDS } from "./timeStore.js";
export {
  useViewStore,
  viewStoreInitializer,
  readMotionPref,
  ROUTES,
  LAYERS,
  VARIABLES,
  RENDER_MODES,
  HEIGHT_MODES,
  QUANTILE_CHOICES,
  MOTION_PREFS,
  DOMAIN_MODES,
  PERF_TIERS,
  MOTION_STORAGE_KEY,
} from "./viewStore.js";
export { useSelectionStore, selectionStoreInitializer } from "./selectionStore.js";
