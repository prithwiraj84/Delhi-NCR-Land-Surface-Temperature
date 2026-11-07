/**
 * Data hooks shared by the Control view components (E4). Thin compositions of E2's §7 hooks
 * (src/data/hooks.js) and the time stream's throttled playhead (time/hooks.js useScrubYear),
 * so every panel reads the same committed / live state:
 *
 *   useTimelineData()  normalised timeline or null
 *   useManifestData()  raw manifest (v1 or v2) or null
 *   useLiveFrame()     playhead (≤ 10 Hz while moving) + frameTierInfo + frame statistics
 *   useSkill(mode)     honest headline skill (pooled v2 / labelled v1)
 *   useDistrictMeta()  Map id -> {id, name, state}
 *   useShapOptions()   SHAP drivers [{id, label}] (v2 groups / v1 features)
 */

import { useMemo } from "react";
import { useAsset, useFrameStats, useManifest, useSeries, useTimeline } from "../../data/hooks.js";
import { frameTierInfo } from "../../data/timeline.js";
import { useTimeStore } from "../../state/stores/timeStore.js";
import { useScrubYear } from "../../time/hooks.js";
import { skillHeadline } from "./controlModel.js";

export function useTimelineData() {
  const tl = useTimeline();
  return tl.status === "ready" ? tl.data : null;
}

export function useManifestData() {
  const m = useManifest();
  return m.status === "ready" ? m.data.manifest : null;
}

/**
 * Live playhead view: `t` follows the scrub at ≤ 10 Hz, `info` is the tier/provenance of that
 * position, `stats` the NCR statistics (interpolated between frames, flagged). Pass
 * `{withStats: false}` when only the tier/provenance is needed (no statistics recomputation).
 */
export function useLiveFrame({ withStats = true } = {}) {
  const live = useScrubYear();
  const mode = useTimeStore((s) => s.mode ?? "day");
  const ssp = useTimeStore((s) => s.ssp);
  const timeline = useTimelineData();
  // Quantise the scrub to 0.05 y so the stats memo is not recomputed for sub-pixel moves.
  const tq = Number.isFinite(live.t) ? Math.round(live.t * 20) / 20 : live.t;
  // NaN = "no year": useFrameStats returns idle without computing (panels that only need the tier).
  const statsRes = useFrameStats(withStats ? tq : NaN, mode, ssp);
  const info = useMemo(() => (timeline && Number.isFinite(tq) ? frameTierInfo(timeline, tq, mode, ssp) : null), [timeline, tq, mode, ssp]);
  const ncrRes = useSeries("ncr", mode);
  return {
    t: tq,
    exact: live.exact,
    bracket: live.bracket,
    moving: live.dragging || live.playing,
    dragging: live.dragging,
    playing: live.playing,
    mode,
    ssp,
    timeline,
    info,
    stats: statsRes.status === "ready" ? statsRes.data : null,
    statsStatus: statsRes.status,
    statsReason: statsRes.reason,
    ncr: ncrRes.status === "ready" ? ncrRes.data : null,
  };
}

export function useSkill(mode) {
  const metrics = useAsset("metrics");
  return useMemo(() => (metrics.status === "ready" ? skillHeadline(metrics.data, mode) : null), [metrics, mode]);
}

export function useDistrictMeta() {
  const manifest = useManifestData();
  return useMemo(() => new Map((manifest?.districts ?? []).map((d) => [Number(d.id), d])), [manifest]);
}

/** SHAP drivers for feature selects: v2 manifest groups (18), else v1 features. */
export function useShapOptions() {
  const manifest = useManifestData();
  return useMemo(() => {
    const groups = Array.isArray(manifest?.groups) && manifest.groups.length ? manifest.groups.map((g) => ({ id: g.id, label: g.label ?? g.id })) : null;
    return groups ?? (manifest?.features ?? []).map((f) => ({ id: f.name, label: f.label ?? f.name }));
  }, [manifest]);
}
