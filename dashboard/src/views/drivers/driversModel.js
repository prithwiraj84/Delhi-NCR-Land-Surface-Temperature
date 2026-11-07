/**
 * Pure derivations for the Drivers route (UI_SPEC §3.6) over shap_global.json and
 * dependence.json (SPEC §5.5, both `{modes: {day, night}}`; v1 bundles are wrapped as
 * `{modes: {day}}` by the data layer) and the facade epoch.
 *
 * Science notes
 *   - Mean |SHAP| (°C) measures how much a driver moves predictions, not its direction.
 *   - Direction comes from the dependence analysis (`threshold.direction`: sign of Spearman
 *     ρ(x, SHAP), "warming" / "cooling"); a Day−Night sign flip is the key v2 finding (e.g.
 *     built-up land cools by mid-morning but warms at night).
 *   - SHAP explains the model, not causal effects.
 */

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** Per-mode slice of a v2-shaped asset (null when the mode is absent). */
export function modeSlice(asset, mode) {
  if (!asset) return null;
  if (!asset.modes) return mode === "day" ? asset : null;
  return asset.modes[mode] ?? null;
}

/** Group/feature ids of a shap_global slice (v2 `groups`, v1 `features`). */
export const sliceIds = (slice) => (Array.isArray(slice?.groups) ? slice.groups : Array.isArray(slice?.features) ? slice.features : []);

/** Direction of a driver in a dependence slice: "warming" | "cooling" | null. */
export function driverDirection(depSlice, id) {
  const entry = depSlice?.groups?.[id] ?? depSlice?.features?.[id] ?? null;
  const d = entry?.threshold?.direction;
  if (d === "warming" || d === "cooling") return d;
  const rho = Number(entry?.threshold?.spearman ?? entry?.threshold?.rho);
  if (isNum(rho) && rho !== 0) return rho > 0 ? "warming" : "cooling";
  return null;
}

/**
 * Day vs Night importance per driver.
 * @returns {Array<{id, day: number, night: number, diff: number, dirDay, dirNight, flip: boolean}>}
 *   sorted by |day − night| (largest first)
 */
export function importanceDiff(shapGlobal, dependence) {
  const day = modeSlice(shapGlobal, "day");
  const night = modeSlice(shapGlobal, "night");
  if (!day || !night) return [];
  const dayIds = sliceIds(day);
  const nightIds = sliceIds(night);
  const depDay = modeSlice(dependence, "day");
  const depNight = modeSlice(dependence, "night");
  return dayIds
    .filter((id) => nightIds.includes(id))
    .map((id) => {
      const d = Number(day.global?.mean_abs?.[dayIds.indexOf(id)]);
      const n = Number(night.global?.mean_abs?.[nightIds.indexOf(id)]);
      const dirDay = driverDirection(depDay, id);
      const dirNight = driverDirection(depNight, id);
      return { id, day: d, night: n, diff: d - n, dirDay, dirNight, flip: Boolean(dirDay && dirNight && dirDay !== dirNight) };
    })
    .filter((r) => isNum(r.day) && isNum(r.night))
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
}

/**
 * Importance through time: mean |SHAP| per frame for the top-`top` drivers (by global importance).
 * @returns {{years: number[], lines: Array<{id, points: {x: number, y: number}[], global: number}>}}
 */
export function importanceTrend(slice, top = 8) {
  const ids = sliceIds(slice);
  const byFrame = slice?.by_frame ?? slice?.by_epoch ?? {};
  const years = Object.keys(byFrame).map(Number).filter(Number.isInteger).sort((a, b) => a - b);
  const global = slice?.global?.mean_abs ?? [];
  const ranked = ids.map((id, i) => ({ id, i, g: Number(global[i]) })).filter((r) => isNum(r.g)).sort((a, b) => b.g - a.g).slice(0, top);
  return {
    years,
    lines: ranked.map((r) => ({ id: r.id, global: r.g, points: years.map((y) => ({ x: y, y: Number(byFrame[String(y)]?.mean_abs?.[r.i]) })) })),
  };
}

/** Robust [p2, p98] of finite values (brush extent). */
export function robustRange(values) {
  const v = [];
  for (let i = 0; i < (values?.length ?? 0); i += 1) if (Number.isFinite(values[i])) v.push(values[i]);
  if (!v.length) return null;
  v.sort((a, b) => a - b);
  const q = (p) => v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))];
  const lo = q(0.02);
  const hi = q(0.98);
  return hi > lo ? [lo, hi] : [v[0], v[v.length - 1] + 1e-6];
}

/**
 * Brushing mask (selectionStore.brushMask): 1 for cells whose value lies in [lo, hi], 0
 * otherwise (NaN cells are never selected). The map dims unselected cells to 25 %.
 * @returns {{mask: Uint8Array, count: number}}
 */
export function brushMask(values, [lo, hi]) {
  const n = values?.length ?? 0;
  const mask = new Uint8Array(n);
  let count = 0;
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  for (let i = 0; i < n; i += 1) {
    const v = values[i];
    if (v >= a && v <= b) {
      mask[i] = 1;
      count += 1;
    }
  }
  return { mask, count };
}

/** Nearest year with XAI (ties to the later frame, which is the better-observed one). */
export function nearestXaiYear(xaiYears, year) {
  if (!xaiYears?.length) return null;
  const y = Number(year);
  if (!Number.isFinite(y)) return xaiYears[xaiYears.length - 1];
  return xaiYears.reduce((best, c) => (Math.abs(c - y) < Math.abs(best - y) || (Math.abs(c - y) === Math.abs(best - y) && c > best) ? c : best), xaiYears[0]);
}

/**
 * Feature metas the what-if simulator offers: for v2 bundles the actionable BASE features of
 * the raw manifest (5 fractions, NDVI, 3 landscape metrics — never focal means); for v1 the
 * facade features.
 * @returns {Map<string, object>}
 */
export function scenarioMetas({ schema, manifest, features }) {
  if (schema === "v2") {
    const list = (manifest?.features ?? []).filter((f) => f && f.base !== false && !/_m\d+$/.test(f.name));
    return new Map(list.map((f) => [f.name, f]));
  }
  return new Map((features ?? []).map((f) => [f.name, f]));
}

/** Map a base feature to the SHAP group whose dependence curve plots it (v2), identity for v1. */
export function dependenceKeyResolver({ schema, manifest }) {
  if (schema !== "v2") return (f) => f;
  const groups = manifest?.groups ?? [];
  const byPrimary = new Map(groups.map((g) => [g.primary, g.id]));
  const byMember = new Map(groups.flatMap((g) => (g.members ?? []).map((m) => [m, g.id])));
  return (f) => byPrimary.get(f) ?? byMember.get(f) ?? f;
}
