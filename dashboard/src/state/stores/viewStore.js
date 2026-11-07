/**
 * viewStore (UI_SPEC §7): what is shown and how.
 *
 * Shape (binding): { route, layer, shapFeature, variable, renderMode, heightMode, quantile, lens,
 *                    analyst: {opacity, h3, labels, boundaries, hillshade}, motionPref, perfTier,
 *                    briefing: {active, step}, domainMode }
 *
 * - `layer` is the base layer id; the URL form `shap:<feature>` is accepted by `setLayer` and
 *   split into `layer = "shap"` + `shapFeature`.
 * - `variable` default follows decision D2: "abs" when `manifest.timeline.harmonised`, else "anom"
 *   (applied by `configure` unless the user already chose one).
 * - `motionPref` ("system" | "full" | "reduced" | "off") persists in localStorage (try/catch:
 *   private windows and blocked storage must not break the app).
 * Every setter validates its input and returns false for values outside the vocabulary.
 */

import { create } from "zustand";

export const ROUTES = Object.freeze(["control", "timeline", "drivers", "zones", "lab", "sources"]);
export const LAYERS = Object.freeze(["lst", "pred", "resid", "shap", "driver", "zones", "whatif", "unc", "aoa"]);
export const VARIABLES = Object.freeze(["abs", "anom", "suhi", "delta"]);
export const RENDER_MODES = Object.freeze(["grid", "raster", "auto"]);
export const HEIGHT_MODES = Object.freeze(["flat", "anom", "abs"]);
export const QUANTILE_CHOICES = Object.freeze(["p05", "p25", "p50", "p75", "p95", "spread"]);
export const MOTION_PREFS = Object.freeze(["system", "full", "reduced", "off"]);
export const DOMAIN_MODES = Object.freeze(["fixed", "shared", "frame"]);
export const PERF_TIERS = Object.freeze([0, 1, 2, 3]);
export const MOTION_STORAGE_KEY = "ncr-thermal-ops:motion";

const DEFAULT_ANALYST = Object.freeze({ opacity: 0.92, h3: false, labels: true, boundaries: true, hillshade: false });

/** Read the persisted motion preference (falls back to "system"). */
export function readMotionPref() {
  try {
    const v = globalThis.localStorage?.getItem(MOTION_STORAGE_KEY);
    return MOTION_PREFS.includes(v) ? v : "system";
  } catch (_error) {
    return "system";
  }
}

function writeMotionPref(value) {
  try {
    globalThis.localStorage?.setItem(MOTION_STORAGE_KEY, value);
  } catch (_error) {
    // Storage blocked (private mode, sandboxed iframe): the preference lasts for this session only.
  }
}

function initialViewState() {
  return {
    route: "control",
    layer: "lst",
    shapFeature: null,
    variable: "abs",
    variableExplicit: false,
    renderMode: "auto",
    heightMode: "anom",
    quantile: "p50",
    lens: false,
    analyst: DEFAULT_ANALYST,
    motionPref: readMotionPref(),
    perfTier: 0,
    briefing: Object.freeze({ active: false, step: 0 }),
    domainMode: "fixed",
  };
}

/** Zustand initializer (exported for isolated vanilla stores in tests). */
export function viewStoreInitializer(set, get) {
  const choose = (key, allowed) => (value) => {
    if (!allowed.includes(value)) return false;
    if (get()[key] !== value) set({ [key]: value });
    return true;
  };
  return {
    ...initialViewState(),

    /** Apply bundle-driven defaults: D2 variable and the default SHAP feature/group. */
    configure({ harmonised = false, shapFeature = null } = {}) {
      const patch = {};
      if (!get().variableExplicit) patch.variable = harmonised ? "abs" : "anom";
      // Δ maps a frame-to-frame level difference: never on levels that are not harmonised
      // across sensors / overpass times (it would map sensor drift), even from a shared URL.
      else if (!harmonised && get().variable === "delta") patch.variable = "anom";
      if (shapFeature && !get().shapFeature) patch.shapFeature = shapFeature;
      if (Object.keys(patch).length) set(patch);
    },

    setRoute: choose("route", ROUTES),

    /** Accepts "lst" … "aoa" and the URL form "shap:<feature>". */
    setLayer(value) {
      const s = String(value ?? "");
      if (s.startsWith("shap:")) {
        const feature = s.slice(5);
        set({ layer: "shap", ...(feature ? { shapFeature: feature } : {}) });
        return true;
      }
      return choose("layer", LAYERS)(s);
    },

    setShapFeature(feature) {
      if (feature !== null && typeof feature !== "string") return false;
      set({ shapFeature: feature || null });
      return true;
    },

    setVariable(value) {
      if (!VARIABLES.includes(value)) return false;
      set({ variable: value, variableExplicit: true });
      return true;
    },

    setRenderMode: choose("renderMode", RENDER_MODES),
    /** `G`: grid → raster → auto → grid. */
    cycleRenderMode() {
      const i = RENDER_MODES.indexOf(get().renderMode);
      set({ renderMode: RENDER_MODES[(i + 1) % RENDER_MODES.length] });
    },
    setHeightMode: choose("heightMode", HEIGHT_MODES),
    setQuantile: choose("quantile", QUANTILE_CHOICES),
    setLens(on) {
      set({ lens: Boolean(on) });
      return true;
    },
    toggleLens: () => set({ lens: !get().lens }),

    /** Merge analyst options; opacity is clamped to [0.1, 1]. */
    setAnalyst(patch = {}) {
      const next = { ...get().analyst };
      for (const [k, v] of Object.entries(patch)) {
        if (!(k in DEFAULT_ANALYST)) continue;
        next[k] = k === "opacity" ? Math.min(1, Math.max(0.1, Number(v) || DEFAULT_ANALYST.opacity)) : Boolean(v);
      }
      set({ analyst: Object.freeze(next) });
    },

    setMotionPref(value) {
      if (!MOTION_PREFS.includes(value)) return false;
      writeMotionPref(value);
      set({ motionPref: value });
      return true;
    },
    /** `M`: system → full → reduced → off → system. */
    cycleMotionPref() {
      const i = MOTION_PREFS.indexOf(get().motionPref);
      get().setMotionPref(MOTION_PREFS[(i + 1) % MOTION_PREFS.length]);
    },

    setPerfTier(tier) {
      const t = Number(tier);
      if (!PERF_TIERS.includes(t)) return false;
      if (get().perfTier !== t) set({ perfTier: t });
      return true;
    },

    startBriefing: (step = 0) => set({ briefing: Object.freeze({ active: true, step: Math.max(0, Math.floor(step) || 0) }) }),
    stopBriefing: () => set({ briefing: Object.freeze({ active: false, step: 0 }) }),
    setBriefingStep(step, total = Infinity) {
      const s = Math.max(0, Math.min(Math.floor(Number(step) || 0), Number.isFinite(total) ? total - 1 : Infinity));
      set({ briefing: Object.freeze({ active: true, step: s }) });
    },

    setDomainMode: choose("domainMode", DOMAIN_MODES),
    reset: () => set(initialViewState()),
  };
}

export const useViewStore = create(viewStoreInitializer);
