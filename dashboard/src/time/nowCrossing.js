/**
 * Crossing NOW (UI_SPEC_v2 §5.2 C): the moment the playhead passes from the last observed
 * frame into projections. Once per pass (re-armed when the playhead returns to ≤ NOW):
 *
 *   0 ms     the NOW rule pulses once                          (RibbonSparkline / TimeRibbon)
 *   0–600    fog ramps in, the projected track brightens, the tier chip flips (FrameCard)
 *   0–900    SSP strands unfurl in the sparkline (stroke-dashoffset, 120 ms stagger)
 *   400 ms   toast for 4 s, once per session: "Entering projections: model + CMIP6 …"
 *   playback holds an extra 400 ms at the first projected frame (time/playback.js)
 *
 * Reduced motion: fog jump + toast; Off: toast only (components read the motion matrix).
 * `crossingDetector` is pure (tests); `useNowCrossing` is the tiny store components watch.
 */

import { create } from "zustand";

/** Toast copy (UI_SPEC §5.2 C / §9 projection copy). */
export const NOW_TOAST = Object.freeze({
  id: "now-crossing",
  title: "Entering projections",
  body: "Model + CMIP6 scenario, not observations.",
  tone: "info",
  duration: 4000,
  oncePerSession: true,
});

/** Delay (ms) of the toast after the crossing in Full motion. */
export const NOW_TOAST_DELAY_MS = 400;

/**
 * Pure crossing detector. `update(t)` returns "enter" exactly once per pass when t moves from
 * ≤ now to > now, "exit" when it returns to ≤ now after having entered, else null.
 */
export function crossingDetector(now) {
  let prev = null;
  let inside = false;
  return {
    update(t) {
      if (!Number.isFinite(t) || !Number.isFinite(now)) return null;
      let event = null;
      if (t > now && !inside && (prev === null || prev <= now)) {
        inside = true;
        event = prev === null ? null : "enter"; // starting beyond NOW is not a crossing
      } else if (t <= now && inside) {
        inside = false;
        event = "exit";
      } else if (t > now && prev === null) {
        inside = true;
      }
      prev = t;
      return event;
    },
    reset() {
      prev = null;
      inside = false;
    },
  };
}

/** `seq` increments on every crossing; components key their one-shot animations on it. */
export const useNowCrossing = create((set, get) => ({
  seq: 0,
  at: null,
  projected: false,
  bump: (at) => set({ seq: get().seq + 1, at, projected: true }),
  leave: () => set({ projected: false }),
}));
