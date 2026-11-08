/**
 * Frame resolver: what one map frame DISPLAYS, from the BundleStore resources (E2).
 *
 * `createFrameSource({bundle, onUpdate})` answers `frame(desc, year)` with
 *   {status: "ready", frame} | {status: "loading"} | {status: "unavailable"|"error", reason}
 * where a ready frame is either
 *   continuous  {kind, key, year, values: Float32Array (NaN = nodata), vsup: Uint8Array|null
 *               (0 none, 1..4 = VSUP U0..U3), aoa: Uint8Array|null (1 = outside AOA), mean, tier}
 *   categorical {kind, key, year, codes: Int16Array (−1 = nodata), palette: [[r,g,b]], categories}
 *
 * `desc` = {mode, layer, variable, q, ssp, shapFeature, deltaRef, scenario, scenarioKey}. Missing
 * resources are requested from the BundleStore (`ensure`) and `onUpdate()` fires when they land,
 * so the engine re-resolves; meanwhile it keeps drawing the previous frame (stale-while-loading:
 * "the map never blanks").
 *
 * Colour channels (`channel(desc, frame)`) are fixed per content (D4) and say where their domain
 * comes from (`crossFrame`, D22 c):
 *   - manifest `timeline.domains` for LST variables (the union of day and night for the shared
 *     scale): cross-frame;
 *   - Δ without a manifest domain: p98 of |Δ| over every frame of the mode (observation cube plus
 *     the selected SSP cube, the reference frame excluded) relative to the current reference year,
 *     from a strided sample, computed once per (mode, ssp, reference, quantile): cross-frame;
 *   - SHAP, residual, what-if: the symmetric p98 of |value| of the first resolved frame (not
 *     cross-frame; `domainYear` names that frame). A degenerate frame (no finite value, all zeros)
 *     never caches a domain, so the next real frame sets it.
 * "Contrast-stretched" (domainMode "frame") is the only per-frame domain and is flagged `stretched`.
 * Continuous LST frames carry `level` (the cube's frame level, else the finite mean of the absolute
 * values): the level the anomaly variable and the 250 m raster anomaly both subtract.
 */

import { driverFamilies, driverPalette, zoneColors } from "../design/tokens.js";
import { rampFor } from "../design/ramps.js";
import { hexToRgb } from "../lib/colors.js";
import { cubeAoaOutside, cubeFrameIndex, decodeCubeFrame, FLAG_OUTSIDE_AOA, zoneFrame } from "../data/cubes.js";
import { decodeColumn } from "../data/lstb.js";
import { domainFor, frameAt, frameModeAvailability, seriesForYear } from "../data/timeline.js";
import { rampIndexOf } from "./lut.js";
import { finiteMean } from "./mixFrame.js";

export const CONTINUOUS_LAYERS = Object.freeze(["lst", "pred", "resid", "shap", "whatif", "unc"]);
export const CATEGORICAL_LAYERS = Object.freeze(["driver", "zones", "aoa"]);
const FRAME_CACHE = 40;
/** Target number of cells per frame in the strided Δ-domain sample. */
const DELTA_SAMPLE_CELLS = 6000;
const WHATIF_PREFIX = "whatif|";

/** Neutral pair of the AOA layer: inside (muted slate) / outside (pale ink, hatched on the GPU). */
export const AOA_PALETTE = Object.freeze([Object.freeze([52, 64, 84]), Object.freeze([196, 206, 222])]);
/** Driver families the bundle may use that tokens.driverFamilies does not name. */
const FAMILY_ALIASES = Object.freeze({ climate: "meteorology", water: "landcover" });

const ok = (frame) => ({ status: "ready", frame });
const LOADING = Object.freeze({ status: "loading" });
const unavailable = (reason) => ({ status: "unavailable", reason });

/** Content key of a description (everything except the year). */
export function contentKey(desc) {
  const key = [desc.layer, desc.variable, desc.q, desc.mode, desc.ssp, desc.shapFeature ?? "", desc.deltaRef ?? "", desc.scenarioKey ?? "", desc.domainMode ?? "fixed"].join("|");
  // Uncertainty fog off (legend switch): a separate content, so the map cross-fades to it and no
  // cached fogged frame is reused. The default (fog on) keeps the historical key.
  return desc.fog === false ? `${key}|nofog` : key;
}

/**
 * p-quantile of |v| over finite values (symmetric diverging bound) with a degeneracy flag:
 * `degenerate` when no value is finite or the quantile is 0 (all zeros); `bound` is then the
 * fallback 1, which must never be cached as a content domain.
 */
export function absQuantileInfo(values, q = 0.98) {
  const abs = new Float32Array(values?.length ?? 0);
  let k = 0;
  for (let i = 0; i < abs.length; i += 1) {
    const v = values[i];
    if (Number.isFinite(v)) {
      abs[k] = Math.abs(v);
      k += 1;
    }
  }
  if (!k) return { bound: 1, degenerate: true };
  const sorted = abs.subarray(0, k).sort();
  const b = sorted[Math.min(k - 1, Math.floor(q * (k - 1)))];
  return b > 0 ? { bound: b, degenerate: false } : { bound: 1, degenerate: true };
}

/** p-quantile of |v| over finite values (symmetric diverging bound; 1 when degenerate). */
export function absQuantile(values, q = 0.98) {
  return absQuantileInfo(values, q).bound;
}

/** [p_lo, p_hi] of the finite values. */
export function valueRange(values, lo = 0.005, hi = 0.995) {
  const v = new Float32Array(values?.length ?? 0);
  let k = 0;
  for (let i = 0; i < v.length; i += 1) {
    if (Number.isFinite(values[i])) {
      v[k] = values[i];
      k += 1;
    }
  }
  if (!k) return [0, 1];
  const sorted = v.subarray(0, k).sort();
  const at = (q) => sorted[Math.min(k - 1, Math.max(0, Math.round(q * (k - 1))))];
  const a = at(lo);
  const b = at(hi);
  return a === b ? [a - 0.5, b + 0.5] : [a, b];
}

/** True when a frame cannot define a colour domain (no finite value, or one value everywhere). */
function isDegenerate(values) {
  if (!values) return true;
  let first = NaN;
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (Number.isNaN(first)) first = v;
    else if (v !== first) return false;
  }
  return true;
}

/** VSUP code per cell (0 none, 1..4 = U0..U3) for a projected cube frame. */
export function vsupCodes(cube, f) {
  const n = cube.n;
  const out = new Uint8Array(n);
  const flags = cube.columns.flags;
  if (flags) {
    const base = f * n;
    for (let i = 0; i < n; i += 1) out[i] = ((flags.raw[base + i] >> 1) & 3) + 1;
    return out;
  }
  const lo = cube.columns.p05_off;
  const hi = cube.columns.p95_off;
  if (!lo || !hi) return null;
  const base = f * n;
  for (let i = 0; i < n; i += 1) {
    const half = (lo.raw[base + i] * lo.scale + lo.offset + (hi.raw[base + i] * hi.scale + hi.offset)) / 2;
    out[i] = (half < 0.5 ? 0 : half < 1 ? 1 : half < 2 ? 2 : 3) + 1;
  }
  return out;
}

/** Driver palette for the SHAP groups: per group when ≤ 17, else grouped into families (§4.2). */
export function driverPaletteFor(groups, groupsMeta = []) {
  const meta = new Map((groupsMeta ?? []).map((g) => [g.id, g]));
  const byGroup = groups.length <= driverPalette.length;
  const familyNames = [];
  const codeOfGroup = groups.map((g, k) => {
    if (byGroup) return k;
    const fam0 = meta.get(g)?.family ?? "landcover";
    const fam = FAMILY_ALIASES[fam0] ?? fam0;
    let idx = familyNames.indexOf(fam);
    if (idx < 0) {
      familyNames.push(fam);
      idx = familyNames.length - 1;
    }
    return idx;
  });
  const categories = byGroup
    ? groups.map((g, k) => ({ id: k, key: g, label: meta.get(g)?.label ?? g, color: driverPalette[k] }))
    : familyNames.map((fam, k) => ({ id: k, key: fam, label: fam, color: driverPalette[driverFamilies[fam] ?? (k * 3) % driverPalette.length] }));
  return { codeOfGroup, categories, palette: categories.map((c) => hexToRgb(c.color)) };
}

/**
 * @param {{bundle: object, onUpdate?: () => void}} options `bundle` is the vanilla BundleStore
 */
export function createFrameSource({ bundle, onUpdate = null }) {
  const cache = new Map();
  const channels = new Map();
  // Provisional (uncached) channels — stretched, degenerate or Δ-pending — memoised per content
  // and frame values, so an unchanged frame keeps ONE channel object (the engine's memoised
  // column layer then hits) and its quantile scan is not repeated every tick.
  const provisional = new Map();
  const PROVISIONAL_MAX = 16;
  const deltaDomains = new Map();
  const requested = new Set();
  let generation = 0;
  let whatifKey = null;

  /**
   * A new what-if run replaces the previous one: drop its frames and channel so the caches stay
   * bounded and the colour domain is recomputed for the new result (T-F4-01).
   */
  function noteWhatif(desc) {
    if (desc.layer !== "whatif") return;
    const k = String(desc.scenarioKey ?? "");
    if (k === whatifKey) return;
    whatifKey = k;
    // Nothing of the new run is cached yet: every what-if entry belongs to an older run.
    for (const key of [...cache.keys()]) if (key.startsWith(WHATIF_PREFIX)) cache.delete(key);
    for (const key of [...channels.keys()]) if (key.startsWith(WHATIF_PREFIX)) channels.delete(key);
    for (const key of [...provisional.keys()]) if (key.startsWith(WHATIF_PREFIX)) provisional.delete(key);
  }

  const state = () => bundle.getState();

  function resource(key) {
    const r = state().resources[key];
    if (r && r.status !== "idle") return r;
    if (!requested.has(key)) {
      requested.add(key);
      const gen = generation;
      Promise.resolve(state().ensure(key))
        .catch(() => null)
        .finally(() => {
          requested.delete(key);
          if (gen === generation) onUpdate?.();
        });
    }
    return LOADING;
  }

  function remember(key, frame) {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, frame);
    while (cache.size > FRAME_CACHE) cache.delete(cache.keys().next().value);
    return frame;
  }

  /** Frame of the observation/SSP cube that holds `year` (raw decode, before the variable). */
  function cubeFrame(desc, year, q) {
    const tl = state().timeline;
    const series = seriesForYear(tl, year, desc.ssp);
    if (!series) return { res: unavailable("no scenario projections in this bundle") };
    const fr = frameAt(tl, year);
    const avail = frameModeAvailability(fr, desc.mode);
    if (!avail.available) return { res: unavailable(avail.reason) };
    const r = resource(`cube:${desc.mode}:${series}`);
    if (r.status === "loading") return { res: LOADING };
    if (r.status !== "ready") return { res: { status: r.status, reason: r.reason } };
    const cube = r.data;
    const f = cubeFrameIndex(cube, year);
    if (f < 0) return { res: unavailable(`${year} is not in the ${series} ${desc.mode} cube`) };
    return { cube, f, series, values: decodeCubeFrame(cube, f, { q }) };
  }

  /** Rural reference mask (built ≤ 5 %, water < 20 %) from the nearest frame with features. */
  function ruralMask(desc, year) {
    const tl = state().timeline;
    const featMode = desc.mode === "dtr" ? "day" : desc.mode;
    const candidates = tl.frames.filter((f) => f.xai?.[featMode] || f.xai?.day).map((f) => f.year);
    if (!candidates.length) return { res: unavailable("surface UHI needs land-cover fractions (no XAI frames in this bundle)") };
    const near = candidates.reduce((best, y) => (Math.abs(y - year) < Math.abs(best - year) ? y : best), candidates[0]);
    let built = null;
    let water = null;
    if (tl.schema === "v1") {
      const r = resource(`epoch:${near}:day`);
      if (r.status === "loading") return { res: LOADING };
      if (r.status !== "ready") return { res: unavailable(r.reason ?? "no land-cover fractions") };
      built = r.data.features?.frac_built ?? r.data.features?.frac_impervious ?? null;
      water = r.data.features?.frac_water ?? null;
    } else {
      const r = resource(`xaiFeatures:${near}`);
      if (r.status === "loading") return { res: LOADING };
      if (r.status !== "ready") return { res: unavailable(r.reason ?? "no land-cover fractions") };
      const cols = r.data.columns ?? {};
      built = cols.frac_built ? decodeColumn(cols.frac_built) : null;
      water = cols.frac_water ? decodeColumn(cols.frac_water) : null;
    }
    if (!built) return { res: unavailable("surface UHI needs the built-up fraction feature") };
    const mask = new Uint8Array(built.length);
    let count = 0;
    for (let i = 0; i < built.length; i += 1) {
      if (built[i] <= 0.05 && (!water || water[i] < 0.2)) {
        mask[i] = 1;
        count += 1;
      }
    }
    if (count < 30) return { res: unavailable(`surface UHI: only ${count} rural reference cells`) };
    return { mask, featureYear: near };
  }

  function lstFrame(desc, year, key) {
    const q = desc.layer === "unc" ? "spread" : desc.mode === "dtr" && desc.q !== "spread" ? "p50" : desc.q ?? "p50";
    const c = cubeFrame(desc, year, q);
    if (c.res) return c.res;
    const { cube, f, series } = c;
    const values = c.values;
    const projected = series !== "obs";
    const vsup = projected && q !== "spread" && desc.fog !== false ? vsupCodes(cube, f) : null;
    let aoa = cubeAoaOutside(cube, f);
    if (aoa && cube.columns.flags && !cube.columns.aoa_out) for (let i = 0; i < aoa.length; i += 1) aoa[i] &= FLAG_OUTSIDE_AOA;
    // The frame level that the anomaly variable AND the 250 m raster anomaly subtract (T-F4-21).
    const level = q === "spread" ? null : Number.isFinite(cube.levels?.[f]) ? cube.levels[f] : finiteMean(values);
    let note = null;
    if (desc.layer === "lst" && q !== "spread") {
      if (desc.variable === "anom") {
        for (let i = 0; i < values.length; i += 1) values[i] -= level;
        note = `anomaly vs the ${year} NCR level ${level.toFixed(2)} °C`;
      } else if (desc.variable === "suhi") {
        // Same policy as the KPIs (frameStats.js): there is no projected land-cover reference.
        if (projected) return unavailable("surface UHI is not exported for projected frames (no projected land-cover reference)");
        const r = ruralMask(desc, year);
        if (r.res) return r.res;
        let s = 0;
        let k = 0;
        for (let i = 0; i < values.length; i += 1) {
          if (r.mask[i] && Number.isFinite(values[i])) {
            s += values[i];
            k += 1;
          }
        }
        const rural = k ? s / k : NaN;
        if (!Number.isFinite(rural)) return unavailable("surface UHI: no rural reference value in this frame");
        for (let i = 0; i < values.length; i += 1) values[i] -= rural;
        note = `surface UHI vs the rural mean ${rural.toFixed(2)} °C (land cover ${r.featureYear})`;
      } else if (desc.variable === "delta") {
        // A frame-to-frame level difference maps sensor / overpass drift when the bundle's
        // levels are not harmonised (v1): never drawn there (T-F4-08).
        if (state().timeline.harmonised !== true) return unavailable("levels are not harmonised across sensors/overpass times in this bundle; compare anomalies instead");
        const refYear = Number.isFinite(desc.deltaRef) ? desc.deltaRef : state().timeline.years[0];
        if (refYear !== year) {
          const ref = frame({ ...desc, variable: "abs", deltaRef: null }, refYear);
          if (ref.status !== "ready") return ref.status === "loading" ? LOADING : unavailable(`Δ reference ${refYear}: ${ref.reason ?? "unavailable"}`);
          const rv = ref.frame.values;
          for (let i = 0; i < values.length; i += 1) values[i] = Number.isNaN(rv[i]) ? NaN : values[i] - rv[i];
        } else {
          // The reference frame itself: zero where observed, nodata stays nodata (D22 c).
          for (let i = 0; i < values.length; i += 1) if (!Number.isNaN(values[i])) values[i] = 0;
        }
        note = `change vs ${refYear}`;
      }
    }
    const frameTier = cube.tiers?.[f] ?? frameAt(state().timeline, year)?.[desc.mode]?.tier ?? null;
    return ok(remember(key, { kind: "continuous", key, year, series, values, vsup, aoa, mean: finiteMean(values), level, tier: frameTier, note }));
  }

  /**
   * Cross-frame Δ domain (D22 c): p98 of |Δ| over every frame of the mode — the observation cube
   * plus the selected SSP cube, the reference frame excluded — relative to `refValues` (the
   * reference frame at the same quantile), from a strided sample. Cached per (mode, ssp, ref, q).
   * Returns null while a cube is still loading or when no Δ is defined (degenerate).
   */
  function deltaDomain(desc, refYear, q, refValues) {
    const tl = state().timeline;
    const proj = tl.projYears.length ? seriesForYear(tl, tl.projYears[0], desc.ssp) : null;
    const dkey = `${desc.mode}|${proj ?? "-"}|${refYear}|${q}`;
    if (deltaDomains.has(dkey)) return deltaDomains.get(dkey) || null;
    const cubes = [];
    for (const s of proj ? ["obs", proj] : ["obs"]) {
      const r = resource(`cube:${desc.mode}:${s}`);
      if (r.status === "loading") return null;
      if (r.status === "ready") cubes.push(r.data);
    }
    if (!cubes.length || !refValues) return null;
    const n = refValues.length;
    const stride = Math.max(1, Math.floor(n / DELTA_SAMPLE_CELLS));
    const samples = [];
    for (const cube of cubes) {
      if (cube.n !== n) continue;
      const main = cube.columns[cube.valueColumn];
      const off = q === "p50" ? null : cube.columns[`${q}_off`] ?? null;
      const sign = q === "p05" || q === "p25" ? -1 : 1;
      for (let f = 0; f < cube.F; f += 1) {
        if (cube.years[f] === refYear) continue;
        const base = f * n;
        for (let i = 0; i < n; i += stride) {
          const rv = refValues[i];
          if (!Number.isFinite(rv)) continue;
          const raw = main.raw[base + i];
          if (main.nodata !== null && raw === main.nodata) continue;
          let v = raw * main.scale + main.offset;
          if (off) v += sign * (off.raw[base + i] * off.scale + off.offset);
          samples.push(Math.abs(v - rv));
        }
      }
    }
    const info = absQuantileInfo(Float32Array.from(samples));
    if (info.degenerate) {
      // Every cube is loaded and no frame differs from the reference: there is no Δ scale to
      // find, so remember that (false) instead of rescanning the cubes on every call.
      deltaDomains.set(dkey, false);
      return null;
    }
    const out = Object.freeze({ bound: info.bound, n: samples.length });
    deltaDomains.set(dkey, out);
    return out;
  }

  function xaiFrame(desc, year, key) {
    if (desc.mode === "dtr") return unavailable("drivers are explained per mode (day or night), not for DTR");
    const fr = frameAt(state().timeline, year);
    if (!fr?.xai?.[desc.mode]) {
      const span = state().timeline.frames.filter((f) => f.xai?.[desc.mode]).map((f) => f.year);
      return unavailable(span.length ? `drivers exist for frames with XAI: ${span[0]}–${span[span.length - 1]}` : "this bundle has no XAI frames");
    }
    const r = resource(`xai:${year}:${desc.mode}`);
    if (r.status === "loading") return LOADING;
    if (r.status !== "ready") return { status: r.status, reason: r.reason };
    const xai = r.data;
    if (desc.layer === "driver") {
      const groups = (xai.groups ?? Object.keys(xai.shap ?? {})).filter((g) => xai.shap?.[g]);
      if (!groups.length) return unavailable("no SHAP columns in this frame");
      const { codeOfGroup, categories, palette } = driverPaletteFor(groups, state().manifest?.groups ?? state().groupsMeta);
      const n = xai.shap[groups[0]].length;
      const codes = new Int16Array(n).fill(-1);
      for (let i = 0; i < n; i += 1) {
        let best = -1;
        let bestAbs = -1;
        for (let k = 0; k < groups.length; k += 1) {
          const v = xai.shap[groups[k]][i];
          if (Number.isFinite(v) && Math.abs(v) > bestAbs) {
            bestAbs = Math.abs(v);
            best = k;
          }
        }
        codes[i] = best < 0 ? -1 : codeOfGroup[best];
      }
      return ok(remember(key, { kind: "categorical", key, year, codes, palette, categories, tier: xai.tier ?? null }));
    }
    let src;
    if (desc.layer === "pred") src = xai.pred;
    else if (desc.layer === "resid") src = xai.resid;
    else {
      const groups = xai.groups ?? Object.keys(xai.shap ?? {});
      const g = desc.shapFeature && xai.shap?.[desc.shapFeature] ? desc.shapFeature : groups[0];
      src = xai.shap?.[g];
      if (!src) return unavailable(`no SHAP column "${desc.shapFeature}" in ${year}`);
    }
    if (!src) return unavailable(`${desc.layer} is not exported for ${year}`);
    const values = Float32Array.from(src);
    return ok(remember(key, { kind: "continuous", key, year, series: "obs", values, vsup: null, aoa: null, mean: finiteMean(values), tier: xai.tier ?? null, note: null }));
  }

  function categoricalCubeFrame(desc, year, key) {
    const tl = state().timeline;
    if (desc.layer === "zones") {
      const mode = desc.mode === "dtr" ? "day" : desc.mode;
      const series = seriesForYear(tl, year, desc.ssp);
      if (!series) return unavailable("no scenario projections in this bundle");
      const r = resource(`zones:${mode}`);
      if (r.status === "loading") return LOADING;
      if (r.status !== "ready") return { status: r.status, reason: r.reason };
      const z = zoneFrame(r.data, series, year);
      if (!z) return unavailable(`${year}: no ${mode} zones`);
      const codes = Int16Array.from(z);
      const meta = state().manifest?.zones?.[mode] ?? state().manifestV2?.zones?.[mode] ?? (Array.isArray(state().manifest?.zones) ? state().manifest.zones : []);
      // Zone labels use the data-driven display name (D11); ids and colours stay canonical.
      const entryOf = (k) => (Array.isArray(meta) ? meta.find((z) => Number(z?.id) === k) ?? meta[k] : null);
      const categories = zoneColors.map((color, k) => {
        const z = entryOf(k);
        return { id: k, key: k, label: z?.display_name ?? z?.name ?? `Zone ${k}`, color: z?.color ?? color, caveat: z?.label_caveat ?? null };
      });
      return ok(remember(key, { kind: "categorical", key, year, codes, palette: categories.map((c) => hexToRgb(c.color)), categories, tier: null }));
    }
    const c = cubeFrame(desc, year, "p50");
    if (c.res) return c.res;
    const out = cubeAoaOutside(c.cube, c.f);
    if (!out) return unavailable(`${year}: the cube has no AOA flags`);
    const codes = new Int16Array(out.length);
    for (let i = 0; i < out.length; i += 1) codes[i] = Number.isNaN(c.values[i]) ? -1 : out[i] & FLAG_OUTSIDE_AOA ? 1 : 0;
    const categories = [
      { id: 0, key: "inside", label: "Inside the area of applicability", color: "#344054" },
      { id: 1, key: "outside", label: "Outside the AOA (extrapolation)", color: "#C4CEDE" },
    ];
    return ok(remember(key, { kind: "categorical", key, year, codes, palette: AOA_PALETTE, categories, tier: null }));
  }

  function whatIfFrame(desc, year, key) {
    const s = desc.scenario;
    const delta = s?.deltaByCell;
    if (!delta) return unavailable("run a what-if scenario first (Drivers → simulator)");
    if (s.epochYear !== undefined && Number(s.epochYear) !== Number(year)) return unavailable(`the what-if result is for ${s.epochYear}`);
    const values = Float32Array.from(delta);
    return ok(remember(key, { kind: "continuous", key, year, series: "obs", values, vsup: null, aoa: null, mean: 0, tier: null, note: "simulated change (what-if)" }));
  }

  /** Resolve one frame of a description. */
  function frame(desc, year) {
    const st = state();
    if (st.status !== "ready" || !st.timeline) return LOADING;
    noteWhatif(desc);
    // Observed frames are the same for every SSP: key the cache by the cube series, not the SSP.
    const series = seriesForYear(st.timeline, year, desc.ssp) ?? desc.ssp;
    const key = `${contentKey({ ...desc, ssp: series })}@${year}`;
    if (cache.has(key)) {
      const fr = cache.get(key);
      cache.delete(key);
      cache.set(key, fr);
      return ok(fr);
    }
    try {
      switch (desc.layer) {
        case "lst":
        case "unc":
          return lstFrame(desc, year, key);
        case "pred":
        case "resid":
        case "shap":
        case "driver":
          return xaiFrame(desc, year, key);
        case "zones":
        case "aoa":
          return categoricalCubeFrame(desc, year, key);
        case "whatif":
          return whatIfFrame(desc, year, key);
        default:
          return unavailable(`unknown layer "${desc.layer}"`);
      }
    } catch (error) {
      console.warn("[engine] frame resolution failed", desc, year, error);
      return { status: "error", reason: error?.message ?? String(error) };
    }
  }

  /**
   * Colour channel {ramp, rampIndex, lo, hi, unit, kind, stretched, crossFrame, domainYear} of a
   * description, fixed per content (see module doc). `fr` is any resolved frame (used only when no
   * cross-frame domain exists). A channel from a degenerate frame or a pending Δ domain is
   * returned but not cached, so the next call can replace it.
   */
  function channel(desc, fr) {
    noteWhatif(desc);
    const ck = contentKey(desc);
    const stretch = desc.domainMode === "frame" && desc.layer === "lst" && desc.variable === "abs";
    if (!stretch && channels.has(ck)) return channels.get(ck);
    const memo = provisional.get(ck);
    const memoHit = Boolean(memo && fr?.values && memo.values === fr.values);
    // Stretched / degenerate fallbacks depend only on the frame values: reuse the same object.
    if (memoHit && !memo.deltaPending) return memo.out;
    const tl = state().timeline;
    const rampVariable = desc.layer === "unc" || (desc.layer === "lst" && desc.q === "spread") ? "spread" : desc.layer === "pred" ? "abs" : desc.variable;
    const ramp = rampFor({ mode: desc.mode, variable: rampVariable, layer: desc.layer, domainMode: desc.domainMode });
    let domain = null;
    let stretched = false;
    let crossFrame = false;
    let cacheable = !stretch;
    let kind = "sequential";
    if (desc.layer === "lst" || desc.layer === "pred") {
      // The pred layer always shows absolute predicted LST (D22 b).
      const variable = desc.layer === "pred" ? "abs" : desc.q === "spread" ? "spread" : desc.variable;
      domain = domainFor(tl, desc.mode, variable);
      if (variable === "abs" && desc.domainMode === "shared") {
        const d = domainFor(tl, "day", "abs");
        const n = domainFor(tl, "night", "abs");
        if (d && n) domain = [Math.min(d[0], n[0]), Math.max(d[1], n[1])];
      }
      crossFrame = Boolean(domain);
      if (!domain && variable === "delta" && desc.layer === "lst") {
        const q = desc.mode === "dtr" ? "p50" : desc.q ?? "p50";
        const refYear = Number.isFinite(desc.deltaRef) ? desc.deltaRef : tl.years[0];
        const ref = frame({ ...desc, variable: "abs", deltaRef: null }, refYear);
        const dd = ref.status === "ready" ? deltaDomain(desc, refYear, q, ref.frame.values) : null;
        if (dd) {
          domain = [-dd.bound, dd.bound];
          crossFrame = true;
        } else {
          cacheable = false; // cubes still loading (or no Δ at all): per-frame fallback below
          if (memoHit) return memo.out; // same frame, domain still pending: same provisional channel
        }
      }
      if (stretch && fr?.values) {
        domain = valueRange(fr.values, 0.02, 0.98);
        stretched = true;
        crossFrame = false;
      }
      kind = variable === "abs" || variable === "spread" ? "sequential" : "diverging";
    } else if (desc.layer === "unc") {
      domain = tl.domains?.spread ?? null;
      crossFrame = Boolean(domain);
    }
    let domainYear = null;
    if (!domain && fr?.values) {
      if (isDegenerate(fr.values)) cacheable = false;
      if (ramp === "polar") {
        // What-if: cells the scenario cannot reach are exactly 0; the scale follows the cells
        // that change (p98 of |Δ| over non-zero cells), so a local scenario is not saturated.
        const b = absQuantileInfo(desc.layer === "whatif" ? fr.values.filter((v) => v !== 0) : fr.values);
        if (b.degenerate) cacheable = false;
        domain = [-b.bound, b.bound];
        kind = "diverging";
      } else domain = valueRange(fr.values);
      domainYear = Number.isFinite(fr.year) ? fr.year : null;
    }
    if (!domain) return null;
    if (ramp === "polar") kind = "diverging";
    const out = Object.freeze({ ramp, rampIndex: rampIndexOf(ramp), lo: domain[0], hi: domain[1], unit: "°C", kind, stretched, crossFrame, domainYear });
    if (cacheable) {
      channels.set(ck, out);
      provisional.delete(ck);
    } else if (fr?.values) {
      provisional.delete(ck);
      provisional.set(ck, { values: fr.values, out, deltaPending: desc.layer === "lst" && desc.variable === "delta" && !crossFrame });
      if (provisional.size > PROVISIONAL_MAX) provisional.delete(provisional.keys().next().value);
    }
    return out;
  }

  /** The cached (final) channel of a description, or null while only a provisional one exists. */
  function cachedChannel(desc) {
    return channels.get(contentKey(desc)) ?? null;
  }

  return {
    frame,
    channel,
    cachedChannel,
    /** Drop every cached frame and channel (bundle switch). */
    clear() {
      generation += 1;
      cache.clear();
      channels.clear();
      provisional.clear();
      deltaDomains.clear();
      requested.clear();
      whatifKey = null;
    },
    get size() {
      return cache.size;
    },
  };
}
