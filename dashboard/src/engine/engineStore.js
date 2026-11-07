/**
 * Engine status store (vanilla zustand): the ONLY engine state React reads.
 *
 * It changes when the map's CONTENT or health changes (layer, legend channel, path, availability,
 * perf tier, hover target) — never per scrub tick — so the "React never re-renders on scrub" rule
 * holds while chrome (legend, hover card, PerfChip, Render switch) stays in sync with what is drawn.
 *
 * Shape:
 *   status   "idle" | "loading" | "ready" | "buffering" | "unavailable" | "error" | "webgl-lost"
 *   reason   user-facing text for unavailable / buffering / error (null otherwise)
 *   path     "gpu" | "cpu" (+ `pathReason` when the CPU path is forced)
 *   legend   {layer, kind: "sequential"|"diverging"|"categorical", ramp, lo, hi, unit, stretched,
 *             variable, mode, heightMode, categories, note} | null
 *   raster   {visible, available, reason, preview, key}
 *   lens     {on, available, reason}
 *   compare  {on, kind, splitPx, labels: [left, right]}
 *   hover    {index, x, y, lon, lat} | null   (30 Hz max; pointer position for the HoverCard)
 *   perf     {tier, ema, fps, gpuMB, auto}
 *   camera   {zoom, pitch, bearing} (quantised; for the Render "auto" switch and the scale bar)
 */

import { createStore } from "zustand/vanilla";

export function initialEngineState() {
  return {
    status: "idle",
    reason: null,
    path: "gpu",
    pathReason: null,
    legend: null,
    raster: { visible: false, available: false, reason: null, preview: false, key: null },
    lens: { on: false, available: false, reason: null },
    compare: { on: false, kind: null, splitPx: null, labels: null },
    hover: null,
    perf: { tier: 0, ema: null, fps: null, gpuMB: 0, auto: false },
    camera: { zoom: null, pitch: null, bearing: null },
  };
}

const shallowEqual = (a, b) => {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => Object.is(a[k], b[k]) || (Array.isArray(a[k]) && Array.isArray(b[k]) && a[k].length === b[k].length && a[k].every((x, i) => Object.is(x, b[k][i]))));
};

/** Create an engine store with a `patch` that only notifies when a slice really changed. */
export function createEngineStore() {
  const store = createStore(() => initialEngineState());
  store.patch = (partial) => {
    const s = store.getState();
    const next = {};
    let changed = false;
    for (const [k, v] of Object.entries(partial)) {
      if (!shallowEqual(s[k], v)) {
        next[k] = v;
        changed = true;
      }
    }
    if (changed) store.setState(next);
    return changed;
  };
  store.reset = () => store.setState(initialEngineState());
  return store;
}

/** App-wide engine store (one persistent stage per page). */
export const engineStore = createEngineStore();
