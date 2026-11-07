/**
 * Data hooks (UI_SPEC §7) — the interfaces every view codes against.
 *
 * Every hook returns `{status: "idle"|"loading"|"ready"|"unavailable"|"error", data, reason}`.
 * `useBracket()` and `useGuardedCopy()` additionally spread their data fields on the result
 * (the spec shows them as `{iA, iB, mix, yA, yB}` and `{text, guardPassed}`).
 *
 * Arguments that are `undefined` default to the current time-store state (year, mode, ssp), so
 * `useFrameStats()` means "stats of what the map shows now". Hooks subscribe coarsely: React
 * re-renders on committed changes (year, mode, ssp, bracket indices), never per scrub tick — the
 * engine reads `useTimeStore.getState()` for that.
 *
 * The BundleStore comes from `<BundleStoreContext.Provider>` (DataProvider sets it), else the
 * app-wide default store.
 */

import { createContext, useContext, useEffect, useMemo } from "react";
import { useStore } from "zustand";
import { useTimeStore } from "../state/stores/timeStore.js";
import { useViewStore } from "../state/stores/viewStore.js";
import { bundleStore, IDLE } from "./bundleStore.js";
import { copyStats, renderGuardedCopy } from "./copy.js";
import { cellQuantiles, cubeFrameIndex, decodeCubeFrame } from "./cubes.js";
import { computeFrameStats } from "./frameStats.js";
import { rasterResourceKey } from "./rasters.js";
import { scopeSeries } from "./series.js";
import { bracketAt, clampYear, domainFor, frameAt, frameTierInfo, isExactBracket, normalizeSspId, seriesForYear } from "./timeline.js";

/** Context carrying the BundleStore instance (vanilla zustand store). */
export const BundleStoreContext = createContext(null);

const LOADING = Object.freeze({ status: "loading", data: null, reason: null });
const result = (status, data = null, reason = null) => ({ status, data, reason });

/** The BundleStore of the nearest provider (or the default app store). */
export function useBundleStoreApi() {
  return useContext(BundleStoreContext) ?? bundleStore;
}

/** Select from the BundleStore state. */
export function useBundle(selector = (s) => s) {
  return useStore(useBundleStoreApi(), selector);
}

/** Bundle-level status mapped to the hook vocabulary ("empty" -> "unavailable"). */
function bundleGate(s) {
  if (s.status === "ready") return null;
  if (s.status === "error") return result("error", null, s.error?.message ?? "bundle failed to load");
  if (s.status === "empty") return result("unavailable", null, "no bundle installed — run the notebook and copy outputs/web/* to dashboard/public/data/");
  return LOADING;
}

/**
 * Subscribe to one resource and request it (in an effect) when `enabled`.
 * @returns {{status, data, reason}}
 */
export function useResource(key, { enabled = true } = {}) {
  const api = useBundleStoreApi();
  const status = useStore(api, (s) => s.status);
  const entry = useStore(api, (s) => (key ? s.resources[key] ?? IDLE : IDLE));
  useEffect(() => {
    if (!enabled || !key || status !== "ready") return;
    const current = api.getState().resources[key];
    if (!current || current.status === "idle") api.getState().ensure(key);
  }, [api, key, enabled, status, entry]);
  if (!key) return IDLE;
  if (status !== "ready" && entry.status === "idle") return bundleGate(api.getState()) ?? LOADING;
  if (enabled && entry.status === "idle") return LOADING;
  return entry;
}

/** Committed time state with `undefined` arguments filled in (coarse subscription). */
function useTimeDefaults(year, mode, ssp) {
  const storeYear = useTimeStore((s) => s.year);
  const storeMode = useTimeStore((s) => s.mode);
  const storeSsp = useTimeStore((s) => s.ssp);
  return {
    year: year === undefined ? storeYear : year,
    mode: mode === undefined ? storeMode : mode,
    ssp: ssp === undefined ? storeSsp : ssp,
  };
}

// ---------------------------------------------------------------------------------------
// Bundle-level hooks
// ---------------------------------------------------------------------------------------

/** {status, source, schema, progress, error, validation, warnings} of the bundle. */
export function useBundleStatus() {
  const api = useBundleStoreApi();
  const status = useStore(api, (s) => s.status);
  const source = useStore(api, (s) => s.source);
  const schema = useStore(api, (s) => s.schema);
  const progress = useStore(api, (s) => s.progress);
  const error = useStore(api, (s) => s.error);
  const validation = useStore(api, (s) => s.validation);
  const warnings = useStore(api, (s) => s.warnings);
  return useMemo(() => ({ status, source, schema, progress, error, validation, warnings }), [status, source, schema, progress, error, validation, warnings]);
}

/** Normalised timeline: frames[], now, tiers per year × mode, domains, scenarios, annotations, harmonised. */
export function useTimeline() {
  const api = useBundleStoreApi();
  const status = useStore(api, (s) => s.status);
  const timeline = useStore(api, (s) => s.timeline);
  return useMemo(() => {
    if (status === "ready" && timeline) return result("ready", timeline);
    return bundleGate(api.getState()) ?? (timeline ? result("ready", timeline) : LOADING);
  }, [api, status, timeline]);
}

/** Raw manifest (and the adapted v2 view for v1 bundles). */
export function useManifest() {
  const api = useBundleStoreApi();
  const manifest = useStore(api, (s) => s.manifest);
  const manifestV2 = useStore(api, (s) => s.manifestV2);
  const schema = useStore(api, (s) => s.schema);
  const status = useStore(api, (s) => s.status);
  const error = useStore(api, (s) => s.error);
  return useMemo(() => (manifest ? result("ready", { manifest, manifestV2, schema }) : bundleGate({ status, error }) ?? LOADING), [manifest, manifestV2, schema, status, error]);
}

/** Canonical cells (cell_id, row, col, lon, lat, district). */
export const useCells = () => useResource("cells");

/** Small v2-shaped assets: "shapGlobal" | "dependence" | "zones" | "metrics" | "interactions" | "coupling" | "provenance". */
export const useAsset = (name) => useResource(name ? `asset:${name}` : null);

/** Compact web model (v1 format on the 47 features) of a mode. */
export const useModel = (mode = "day") => useResource(mode === "dtr" ? null : `model:${mode}`);

/** District boundaries GeoJSON. */
export const useDistricts = () => useResource("districts");

/** Zones cube of a mode ({series: {obs, ssp…}}). */
export const useZonesCube = (mode) => useResource(mode ? `zones:${mode === "dtr" ? "day" : mode}` : null);

// ---------------------------------------------------------------------------------------
// Time hooks
// ---------------------------------------------------------------------------------------

/** {tier, sensor, overpass, window, scenes, coverage, …} of a (possibly fractional) year. */
export function useFrameTier(year, mode, ssp) {
  const t = useTimeDefaults(year, mode, ssp);
  const tl = useTimeline();
  return useMemo(() => {
    if (tl.status !== "ready") return tl;
    if (!Number.isFinite(Number(t.year))) return result("idle");
    const info = frameTierInfo(tl.data, t.year, t.mode, t.ssp);
    return info ? result(info.available ? "ready" : "unavailable", info, info.available ? null : info.reason) : result("unavailable", null, "no frame");
  }, [tl, t.year, t.mode, t.ssp]);
}

/**
 * Bracket of the playhead {iA, iB, mix, yA, yB}. Re-renders when the bracket indices change or
 * the quantised mix moves by `precision` (default 0.05); exact values: `useTimeStore.getState()`.
 */
export function useBracket({ precision = 0.05 } = {}) {
  const key = useTimeStore((s) => {
    const b = s.bracket;
    if (!b) return "none";
    return `${b.iA}|${b.iB}|${b.yA}|${b.yB}|${Math.round(b.mix / precision)}`;
  });
  return useMemo(() => {
    const b = useTimeStore.getState().bracket;
    if (!b || key === "none") return { status: "loading", data: null, reason: "timeline not configured" };
    const data = { iA: b.iA, iB: b.iB, mix: b.mix, yA: b.yA, yB: b.yB, exact: isExactBracket(b) };
    return { status: "ready", data, reason: null, ...data };
  }, [key]);
}

// ---------------------------------------------------------------------------------------
// Cubes and frames
// ---------------------------------------------------------------------------------------

function cubeKey(mode, series) {
  if (!mode || !series) return null;
  const s = series === "obs" ? "obs" : normalizeSspId(series);
  return `cube:${mode}:${s}`;
}

/** Value cube of mode × series ("obs" | "ssp245" …): {values: Int16Array, years, n, scale, nodata, columns, tiers, …}. */
export function useCube(mode, series = "obs") {
  return useResource(cubeKey(mode, series));
}

/**
 * Decoded Float32 °C values of one EXACT frame (inspector, charts). A fractional year is not a
 * frame: status "unavailable" with a reason (the map tweens; readouts must say "≈").
 * @param {number} [year] @param {string} [mode] @param {string} [ssp] @param {string} [q] "p50" default
 */
export function useFrameValues(year, mode, ssp, q = "p50") {
  const t = useTimeDefaults(year, mode, ssp);
  const tl = useTimeline();
  const frame = tl.status === "ready" ? frameAt(tl.data, t.year) : null;
  const series = tl.status === "ready" && frame ? seriesForYear(tl.data, frame.year, t.ssp) : null;
  const dtrQuantile = t.mode === "dtr" && q !== "p50";
  const cube = useResource(frame && series && !dtrQuantile ? cubeKey(t.mode, series) : null);
  return useMemo(() => {
    if (tl.status !== "ready") return tl;
    if (!frame) return result("unavailable", null, `${t.year} is not a frame year (interpolated between frames)`);
    if (!series) return result("unavailable", null, "no scenario projections in this bundle");
    if (dtrQuantile) return result("unavailable", null, "DTR exposes the median only (a difference of quantiles is not a quantile)");
    if (cube.status !== "ready") return cube;
    const f = cubeFrameIndex(cube.data, frame.year);
    if (f < 0) return result("unavailable", null, `${frame.year} is not in the ${series} cube`);
    try {
      const values = decodeCubeFrame(cube.data, f, { q });
      return result("ready", { values, year: frame.year, mode: t.mode, series, q, tier: cube.data.tiers[f] ?? frame[t.mode]?.tier ?? null, n: cube.data.n });
    } catch (error) {
      return result("error", null, error.message);
    }
  }, [tl, frame, series, dtrQuantile, cube, t.year, t.mode, q]);
}

/** Per-cell values across all frames (observed + every SSP) from the cubes. */
export function useCellTimeline(index, mode) {
  const t = useTimeDefaults(undefined, mode, undefined);
  const tl = useTimeline();
  const scenarioIds = useMemo(() => (tl.status === "ready" ? tl.data.scenarioIds : []), [tl]);
  const valid = Number.isInteger(index) && index >= 0;
  const obs = useResource(valid ? cubeKey(t.mode, "obs") : null);
  const s0 = useResource(valid && scenarioIds[0] ? cubeKey(t.mode, scenarioIds[0]) : null);
  const s1 = useResource(valid && scenarioIds[1] ? cubeKey(t.mode, scenarioIds[1]) : null);
  const s2 = useResource(valid && scenarioIds[2] ? cubeKey(t.mode, scenarioIds[2]) : null);
  const s3 = useResource(valid && scenarioIds[3] ? cubeKey(t.mode, scenarioIds[3]) : null);
  return useMemo(() => {
    if (tl.status !== "ready") return tl;
    if (!valid) return result("idle", null, "no cell selected");
    if (obs.status !== "ready") return obs;
    if (index >= obs.data.n) return result("error", null, `cell index ${index} out of range (n=${obs.data.n})`);
    const ssp = {};
    const pending = [];
    [s0, s1, s2, s3].forEach((r, k) => {
      const id = scenarioIds[k];
      if (!id) return;
      if (r.status === "ready") ssp[id] = cellQuantiles(r.data, index);
      else if (r.status === "loading" || r.status === "idle") pending.push(id);
    });
    const obsRows = cellQuantiles(obs.data, index).map((row) => ({ ...row, value: row.p50 }));
    return result("ready", { index, mode: t.mode, years: tl.data.years, obs: obsRows, ssp, partial: pending.length > 0, pending });
  }, [tl, valid, obs, s0, s1, s2, s3, index, scenarioIds, t.mode]);
}

// ---------------------------------------------------------------------------------------
// Series, stats, domains, copy
// ---------------------------------------------------------------------------------------

/** Scope series: scope "ncr" | "d:<id>" | "z:<id>" (zone of the mode) | "z:<mode>:<id>". */
export function useSeries(scope = "ncr", mode) {
  const t = useTimeDefaults(undefined, mode, undefined);
  const series = useResource("series");
  return useMemo(() => {
    if (series.status !== "ready") return series;
    const s = scopeSeries(series.data, scope, t.mode);
    return s ? result("ready", s) : result("unavailable", null, `no ${t.mode} series for scope "${scope}"`);
  }, [series, scope, t.mode]);
}

/** NCR mean, signed surface UHI, hot-core %, hottest district for a (possibly fractional) year. */
export function useFrameStats(year, mode, ssp) {
  const t = useTimeDefaults(year, mode, ssp);
  const tl = useTimeline();
  const series = useResource("series");
  const cells = useResource("cells");
  const bracket = tl.status === "ready" && Number.isFinite(Number(t.year)) ? bracketAt(tl.data.years, clampYear(tl.data, t.year)) : null;
  const projKey = (y) => {
    if (!bracket || tl.status !== "ready") return null;
    const f = frameAt(tl.data, y);
    return f?.kind === "projected" ? cubeKey(t.mode, seriesForYear(tl.data, y, t.ssp)) : null;
  };
  const cubeA = useResource(bracket ? projKey(bracket.yA) : null);
  const cubeB = useResource(bracket && bracket.yB !== bracket.yA ? projKey(bracket.yB) : null);
  return useMemo(() => {
    if (tl.status !== "ready") return tl;
    if (series.status !== "ready") return series;
    if (!Number.isFinite(Number(t.year))) return result("idle");
    const res = Number(cells.data?.grid?.res) || 1000;
    const cellAreaKm2 = (res / 1000) ** 2;
    try {
      const stats = computeFrameStats({
        timeline: tl.data,
        series: series.data,
        year: t.year,
        mode: t.mode,
        ssp: t.ssp,
        cubes: { A: cubeA.status === "ready" ? cubeA.data : null, B: cubeB.status === "ready" ? cubeB.data : null },
        cellAreaKm2,
        totalAreaKm2: cells.data ? cells.data.n * cellAreaKm2 : NaN,
      });
      return stats ? result("ready", stats) : result("unavailable", null, "no statistics");
    } catch (error) {
      return result("error", null, error.message);
    }
  }, [tl, series, cells, cubeA, cubeB, t.year, t.mode, t.ssp]);
}

/**
 * Colour domain for mode × variable: fixed from the manifest (default); "shared" = union of the
 * day and night absolute domains (honest day-vs-night magnitude); "frame" = contrast-stretched
 * p2–p98 of the exact current frame (opt-in; `stretched: true` so the legend warns).
 */
export function useDomain(mode, variable) {
  const t = useTimeDefaults(undefined, mode, undefined);
  const storeVariable = useViewStore((s) => s.variable);
  const domainMode = useViewStore((s) => s.domainMode);
  const v = variable === undefined ? storeVariable : variable;
  const tl = useTimeline();
  const needFrame = domainMode === "frame";
  // Decode the current frame only for the opt-in contrast stretch (null year = no request).
  const frameValues = useFrameValues(needFrame ? undefined : null, t.mode, undefined, "p50");
  return useMemo(() => {
    if (tl.status !== "ready") return tl;
    const fixed = domainFor(tl.data, t.mode, v);
    if (!fixed) return result("unavailable", null, `no fixed ${v} domain for ${t.mode} in this bundle`);
    let domain = fixed;
    let stretched = false;
    if (domainMode === "shared" && v === "abs") {
      const d = domainFor(tl.data, "day", "abs");
      const n = domainFor(tl.data, "night", "abs");
      if (d && n) domain = [Math.min(d[0], n[0]), Math.max(d[1], n[1])];
    } else if (needFrame && v === "abs" && frameValues.status === "ready") {
      const vals = Array.from(frameValues.data.values).filter(Number.isFinite).sort((a, b) => a - b);
      if (vals.length > 10) {
        domain = [vals[Math.floor(0.02 * (vals.length - 1))], vals[Math.ceil(0.98 * (vals.length - 1))]];
        stretched = true;
      }
    }
    return result("ready", { domain, fixed, mode: t.mode, variable: v, domainMode, stretched });
  }, [tl, t.mode, v, domainMode, needFrame, frameValues]);
}

/** Guarded headline copy: {status, data: {text, guardPassed, vars}, text, guardPassed}. */
export function useGuardedCopy(templateId) {
  const tl = useTimeline();
  const series = useResource("series");
  const metrics = useResource("asset:metrics");
  const cells = useResource("cells");
  const dayCube = useResource(tl.status === "ready" && tl.data.modeIds.includes("day") ? "cube:day:obs" : null);
  return useMemo(() => {
    const base = (status, reason) => ({ status, data: null, reason, text: null, guardPassed: false });
    if (tl.status !== "ready") return base(tl.status, tl.reason);
    if (series.status !== "ready") return base(series.status, series.reason);
    try {
      const res = Number(cells.data?.grid?.res) || 1000;
      const stats = copyStats({
        timeline: tl.data,
        series: series.data,
        metrics: metrics.status === "ready" ? metrics.data : null,
        cubes: { day: dayCube.status === "ready" ? dayCube.data : null },
        cellAreaKm2: (res / 1000) ** 2,
      });
      const data = renderGuardedCopy(templateId, stats);
      return { status: "ready", data, reason: data.unavailable, text: data.text, guardPassed: data.guardPassed };
    } catch (error) {
      return base("error", error.message);
    }
  }, [tl, series, metrics, cells, dayCube, templateId]);
}

// ---------------------------------------------------------------------------------------
// XAI and rasters
// ---------------------------------------------------------------------------------------

/**
 * XAI frame (features + grouped SHAP + pred/oof/obs/resid) for frames with `xai: true`.
 * A non-frame or XAI-less year is `unavailable` with the frames that do have drivers.
 */
export function useXai(year, mode) {
  const t = useTimeDefaults(year, mode, undefined);
  const tl = useTimeline();
  const frame = tl.status === "ready" ? frameAt(tl.data, t.year) : null;
  const key = frame ? `xai:${frame.year}:${t.mode}` : null;
  const entry = useResource(key);
  return useMemo(() => {
    if (tl.status !== "ready") return tl;
    if (!frame) return result("unavailable", null, `${t.year} is not a frame year`);
    return entry;
  }, [tl, frame, entry, t.year]);
}

/** Schedule idle prefetches of XAI frames (Drivers route, after first paint). */
export function prefetchXai(api, frames) {
  const run = () => api.getState().prefetch(frames.map(([y, m]) => `xai:${y}:${m}`));
  if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 2000 });
  else setTimeout(run, 50);
}

/**
 * Raster of key "<mode>_<year>" ({values, flags, width, height, bounds, lo, hi, tier,
 * downscaled}); `{preview: true}` = the 500 m preview (playback). LRU-managed (8).
 */
export function useRaster(key, { preview = false, enabled = true } = {}) {
  return useResource(key ? rasterResourceKey(key, preview) : null, { enabled });
}
