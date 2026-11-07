/**
 * Bundle metadata the shell needs (command bar, palette, boot, settings), derived from the
 * manifest and - when E2's hooks exist - from `useTimeline()`. Pure function + thin hook.
 *
 * v1 bundles (schema < 2.0, SPEC §5.8): one mode ("day"), frames = v1 epochs, no night, no
 * projections, no rasters. The shell then shows Night/DTR/SSP as unavailable with the reason
 * "rerun notebook v2" instead of hiding them.
 */
import { useMemo } from "react";
import { useData } from "../state/DataContext.jsx";
import { useTimelineHook } from "./deps.js";

export const V1_UNAVAILABLE_REASON = "Not in this v1 bundle — rerun notebook v2 for night, DTR and projections";

const num = (v) => (typeof v === "number" ? v : Number(v));

/** True when the manifest declares schema 2.x or later. */
export function isV2Manifest(manifest) {
  const major = Number.parseInt(String(manifest?.schema_version ?? "1").split(".")[0], 10);
  return Number.isFinite(major) && major >= 2;
}

/** Availability of a mode entry in a frame ({tier, available} or a bare tier string). */
function modeAvailable(entry) {
  if (!entry) return false;
  if (typeof entry === "string") return true;
  return entry.available !== false && entry.tier !== null && entry.tier !== undefined;
}

/**
 * Derive shell metadata.
 * @param {object|null} manifest
 * @param {{frames?: Array, scenarios?: Array, now?: number}|null} timeline data from useTimeline (optional)
 */
export function deriveBundleMeta(manifest, timeline = null) {
  const v2 = isV2Manifest(manifest);
  const frames = timeline?.frames ?? (v2 ? manifest?.timeline?.frames : null) ?? [];
  let years = frames.map((f) => num(f.year)).filter(Number.isFinite);
  if (!years.length && Array.isArray(manifest?.epochs)) years = manifest.epochs.map(num).filter(Number.isFinite);
  years = [...new Set(years)].sort((a, b) => a - b);

  const day = v2 ? frames.some((f) => modeAvailable(f.day)) : years.length > 0;
  const night = v2 ? frames.some((f) => modeAvailable(f.night)) : false;
  const dtr = v2 ? frames.some((f) => modeAvailable(f.day) && modeAvailable(f.night)) : false;
  const rawScenarios = timeline?.scenarios ?? (v2 ? manifest?.timeline?.scenarios : null) ?? [];
  const scenarios = rawScenarios
    .map((s) => (typeof s === "string" ? { id: s, label: s } : s))
    .filter((s) => s && typeof s.id === "string")
    .map((s) => ({ id: s.id.toLowerCase().startsWith("ssp") ? s.id.toLowerCase() : `ssp${s.id}`, label: s.label ?? s.id, n_gcm: s.n_gcm ?? null }));

  const notes = Array.isArray(manifest?.notes) ? manifest.notes.filter((n) => typeof n === "string" && n.trim()) : [];
  const districts = Array.isArray(manifest?.districts) ? manifest.districts : [];
  const gridRes = num(manifest?.study_area?.grid?.res ?? manifest?.study_area?.grid_res_m);
  const areaKm2 = num(manifest?.study_area?.area_km2);
  // Cell count: explicit when exported, else area / cell area (one cell per grid square).
  const nCells = num(manifest?.study_area?.n_cells ?? (Number.isFinite(areaKm2) && gridRes > 0 ? Math.round(areaKm2 / (gridRes / 1000) ** 2) : NaN));
  return {
    schema: manifest?.schema_version ?? null,
    isV2: v2,
    dataMode: manifest?.data_mode ?? null,
    generatedAt: manifest?.generated_at ?? null,
    years,
    now: num(timeline?.now ?? manifest?.timeline?.now ?? (years.length ? Math.min(2025, years.at(-1)) : 2025)),
    availableModes: { day, night, dtr },
    modeReasons: {
      day: day ? null : "No frames in this bundle",
      night: night ? null : v2 ? "No night frames in this bundle" : V1_UNAVAILABLE_REASON,
      dtr: dtr ? null : v2 ? "DTR needs both day and night for the same frame" : V1_UNAVAILABLE_REASON,
    },
    scenarios,
    districts,
    features: Array.isArray(manifest?.features) ? manifest.features : [],
    groups: Array.isArray(manifest?.groups) ? manifest.groups : [],
    notesCount: notes.length,
    nCells,
    gridRes,
    fineRes: num(manifest?.study_area?.fine_res_m),
  };
}

/** React hook: bundle metadata for the shell (memoised on manifest + timeline data). */
export function useBundleMeta() {
  const data = useData();
  const timeline = useTimelineHook();
  const timelineData = timeline?.status === "ready" ? timeline.data : null;
  return useMemo(() => deriveBundleMeta(data?.manifest ?? null, timelineData), [data?.manifest, timelineData]);
}
