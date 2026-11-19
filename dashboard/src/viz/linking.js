/**
 * Linked interaction across the analysis charts (UI_SPEC §3.5 "Linking"):
 *   - every chart cursor follows the global playhead (`timeStore.scrubT`) WITHOUT React
 *     re-renders: `useYearCursor` subscribes imperatively and moves a DOM node;
 *   - hovering a year on one chart shows a synced crosshair on its siblings (`hoverYear`);
 *   - hovering a district highlights it everywhere (`hoverScope`, e.g. "d:7");
 *   - clicking a chart's x position commits the year (snapped to the nearest frame, since
 *     only frames are data).
 */
import { useEffect, useState } from "react";
import { create } from "zustand";
import { useTimeStore } from "../state/stores/timeStore.js";

/** Ephemeral link state shared by charts (never persisted, never in the URL). */
export const useLinkStore = create((set, get) => ({
  hoverYear: null,
  hoverScope: null,
  setHoverYear: (y) => {
    const v = Number.isFinite(y) ? y : null;
    if (get().hoverYear !== v) set({ hoverYear: v });
  },
  setHoverScope: (s) => {
    const v = s ?? null;
    if (get().hoverScope !== v) set({ hoverScope: v });
  },
}));

/** Commit a year picked on a chart (snapped to the nearest frame). */
export function commitChartYear(year) {
  const y = Number(year);
  if (!Number.isFinite(y)) return;
  const s = useTimeStore.getState();
  if (typeof s.setYear === "function") s.setYear(y, { snap: true });
}

/**
 * Keep an SVG/HTML element on the playhead: `ref.current` gets `transform: translateX(px)`
 * and is hidden while the playhead is outside the x domain. No React state is touched.
 * @param {React.RefObject<Element>} ref
 * @param {(year: number) => number} x scale (year -> px); re-subscribes when it changes
 */
export function useYearCursor(ref, x) {
  // Re-apply when the ref moves to a new element (e.g. a chart's loading box → its plot).
  const [node, setNode] = useState(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- runs after every render on purpose (a ref change triggers no render); setNode fires only when the ref moved
  useEffect(() => {
    if (ref.current !== node) setNode(ref.current);
  });
  useEffect(() => {
    const apply = (t) => {
      const el = node;
      if (!el) return;
      const ok = Number.isFinite(t) && x && t >= x.domain[0] && t <= x.domain[1];
      el.style.opacity = ok ? "1" : "0";
      if (ok) el.setAttribute("transform", `translate(${x(t).toFixed(1)},0)`);
    };
    apply(useTimeStore.getState().scrubT);
    return useTimeStore.subscribe((s, prev) => {
      if (s.scrubT !== prev.scrubT) apply(s.scrubT);
    });
  }, [node, x]);
}
