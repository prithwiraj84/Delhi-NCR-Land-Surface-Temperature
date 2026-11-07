/**
 * Value cubes (SPEC §5.2): per mode × series, [frames × n] quantised arrays in canonical cell
 * order. A cube keeps the RAW Int16 values (the map engine binds them straight into GPU slots
 * with `scale`), plus helpers that decode one exact frame to Float32 °C for readouts and charts.
 *
 *   obs cube   (`cube_obs_<mode>`):  lst int16 (0.01 °C, nodata −32768); aoa_out uint8;
 *                                     p05_off, p95_off uint8 (0.05 °C; 0 for observed frames)
 *   ssp cube   (`cube_<ssp>_<mode>`): p50 int16; p05_off, p25_off, p75_off, p95_off uint8 (0.05 °C,
 *                                     non-negative offsets from p50); flags uint8 (bit0 outside AOA,
 *                                     bits1–2 VSUP tier)
 *   zones cube (`cube_zones_<mode>`): obs uint8 [F_obs, n]; <ssp> uint8 [F_proj, n]; 255 = nodata
 *
 * Quantiles below p50 subtract their offset, above add it: p05 = p50 − p05_off, p95 = p50 + p95_off.
 * `spread` = p95 − p05 (0 for observed frames, NaN where p50 is nodata).
 */

import { columnFrame, decodeColumn, LstbError, quantize, requireColumn } from "./lstb.js";

export const QUANTILES = Object.freeze(["p05", "p25", "p50", "p75", "p95"]);
export const ZONE_NODATA = 255;
const INT16_NODATA = -32768;

/** Bit layout of the per-cell flags byte (SPEC §3.7 / §3.8). */
export const FLAG_OUTSIDE_AOA = 0x01;
export const flagVsupTier = (flags) => (flags >> 1) & 0x03;

function framesFromMeta(meta, F, fallbackYears) {
  const frames = Array.isArray(meta?.frames) ? meta.frames.map(Number) : null;
  if (frames && frames.length === F) return frames;
  if (fallbackYears && fallbackYears.length === F) return fallbackYears.slice();
  throw new LstbError(`cube has ${F} frames but meta.frames lists ${frames?.length ?? 0}`, "shape");
}

/** Per-frame levels from cube meta (array aligned with frames or {year: level}). */
function levelsFromMeta(meta, years) {
  const raw = meta?.levels;
  if (Array.isArray(raw) && raw.length === years.length) return raw.map((v) => (v === null ? NaN : Number(v)));
  if (raw && typeof raw === "object") return years.map((y) => (raw[y] === null || raw[y] === undefined ? NaN : Number(raw[y])));
  return years.map(() => NaN);
}

/**
 * Wrap a decoded LSTB "cube" file.
 * @param {object} file   parsed LSTB (see lstb.js)
 * @param {{mode: string, series: string, years?: number[]}} options years = expected frame list
 * @returns {Cube} {kind, mode, series, years, F, n, valueColumn, values, scale, offset, nodata,
 *                  columns, tiers, levels, meta, method}
 */
export function cubeFromLstb(file, { mode, series, years = null } = {}) {
  if (file?.kind !== "cube") throw new LstbError(`expected an LSTB "cube" file, got kind ${JSON.stringify(file?.kind)}`, "kind");
  const valueColumn = file.columns.lst ? "lst" : "p50";
  const main = requireColumn(file, valueColumn);
  if (main.shape.length !== 2) throw new LstbError(`cube column "${valueColumn}" must be 2-D [frames, n]`, "shape");
  const [F, n] = main.shape;
  if (Number.isFinite(file.n) && file.n !== n) throw new LstbError(`cube header n=${file.n} but column has n=${n}`, "shape");
  for (const col of Object.values(file.columns)) {
    if (col.shape.length !== 2 || col.shape[0] !== F || col.shape[1] !== n) {
      throw new LstbError(`cube column "${col.name}" has shape ${JSON.stringify(col.shape)}, expected [${F}, ${n}]`, "shape");
    }
  }
  const frames = framesFromMeta(file.meta, F, years);
  const tiers = Array.isArray(file.meta?.tiers) && file.meta.tiers.length === F ? file.meta.tiers.slice() : frames.map(() => null);
  return {
    kind: "cube",
    mode: mode ?? file.meta?.mode ?? null,
    series: series ?? (valueColumn === "lst" ? "obs" : file.meta?.scenario ?? null),
    years: frames,
    F,
    n,
    valueColumn,
    values: main.raw,
    scale: main.scale,
    offset: main.offset,
    nodata: main.nodata,
    columns: file.columns,
    tiers,
    levels: levelsFromMeta(file.meta, frames),
    method: file.meta?.method ?? null,
    meta: file.meta ?? {},
  };
}

/** Frame index of an exact year in the cube, or -1. */
export const cubeFrameIndex = (cube, year) => (cube?.years ? cube.years.indexOf(Number(year)) : -1);

/** Raw Int16 values of frame f (zero-copy subarray, for GPU slot binding). */
export const cubeFrameRaw = (cube, f) => columnFrame(cube.columns[cube.valueColumn], f);

function offsetColumn(cube, q) {
  return cube.columns[`${q}_off`] ?? null;
}

/**
 * Decode one frame of a cube to Float32 °C for the requested quantile.
 * @param {Cube} cube
 * @param {number} f frame index
 * @param {{q?: "p05"|"p25"|"p50"|"p75"|"p95"|"spread", out?: Float32Array}} [options]
 *   Observed cubes have no p25/p75 offsets: those quantiles equal the value (observations carry
 *   no ensemble spread; modelled frames carry p05/p95 only).
 */
export function decodeCubeFrame(cube, f, { q = "p50", out = null } = {}) {
  const main = cube.columns[cube.valueColumn];
  const base = decodeColumn(main, { frame: f, out });
  if (q === "p50") return base;
  if (q === "spread") {
    const lo = offsetColumn(cube, "p05");
    const hi = offsetColumn(cube, "p95");
    const rawLo = lo ? columnFrame(lo, f) : null;
    const rawHi = hi ? columnFrame(hi, f) : null;
    for (let i = 0; i < base.length; i += 1) {
      if (Number.isNaN(base[i])) continue;
      base[i] = (rawLo ? rawLo[i] * lo.scale + lo.offset : 0) + (rawHi ? rawHi[i] * hi.scale + hi.offset : 0);
    }
    return base;
  }
  if (!QUANTILES.includes(q)) throw new LstbError(`unknown quantile ${JSON.stringify(q)}`, "quantile");
  const col = offsetColumn(cube, q);
  if (!col) return base;
  const raw = columnFrame(col, f);
  const sign = q === "p05" || q === "p25" ? -1 : 1;
  for (let i = 0; i < base.length; i += 1) {
    if (!Number.isNaN(base[i])) base[i] += sign * (raw[i] * col.scale + col.offset);
  }
  return base;
}

/** Decoded AOA-outside mask (bool per cell) of frame f, from `aoa_out` or flags bit0. */
export function cubeAoaOutside(cube, f) {
  const col = cube.columns.aoa_out ?? cube.columns.flags;
  if (!col) return null;
  const raw = columnFrame(col, f);
  const out = new Uint8Array(raw.length);
  const isFlags = col.name === "flags";
  for (let i = 0; i < raw.length; i += 1) out[i] = isFlags ? raw[i] & FLAG_OUTSIDE_AOA : raw[i] ? 1 : 0;
  return out;
}

/** Per-frame value of one cell for one quantile (NaN for nodata). */
export function cellValues(cube, index, q = "p50") {
  const out = new Float32Array(cube.F);
  const main = cube.columns[cube.valueColumn];
  const col = q === "p50" || q === "spread" ? null : offsetColumn(cube, q);
  const sign = q === "p05" || q === "p25" ? -1 : 1;
  for (let f = 0; f < cube.F; f += 1) {
    const r = main.raw[f * cube.n + index];
    if (main.nodata !== null && r === main.nodata) {
      out[f] = NaN;
      continue;
    }
    let v = r * main.scale + main.offset;
    if (col) v += sign * (col.raw[f * cube.n + index] * col.scale + col.offset);
    out[f] = v;
  }
  return out;
}

/** Per-frame quantile record of one cell: [{year, p05, p25, p50, p75, p95, outsideAoa, tier}]. */
export function cellQuantiles(cube, index) {
  const q = Object.fromEntries(QUANTILES.map((name) => [name, cellValues(cube, index, name)]));
  const aoaCol = cube.columns.aoa_out ?? cube.columns.flags;
  return cube.years.map((year, f) => {
    const flag = aoaCol ? aoaCol.raw[f * cube.n + index] : 0;
    return {
      year,
      p05: q.p05[f],
      p25: q.p25[f],
      p50: q.p50[f],
      p75: q.p75[f],
      p95: q.p95[f],
      outsideAoa: aoaCol ? Boolean(aoaCol.name === "flags" ? flag & FLAG_OUTSIDE_AOA : flag) : null,
      vsupTier: cube.columns.flags ? flagVsupTier(cube.columns.flags.raw[f * cube.n + index]) : null,
      tier: cube.tiers[f] ?? null,
    };
  });
}

/**
 * Build a cube from Float32 frames (v1 adapter, derived cubes). Values are quantised exactly like
 * the notebook writes them (0.01 °C, nodata −32768), so every consumer sees one format.
 */
export function cubeFromFloatFrames(frames, { years, mode, series = "obs", tiers = null, levels = null, extraColumns = {} } = {}) {
  if (!Array.isArray(frames) || !frames.length) throw new LstbError("cubeFromFloatFrames needs at least one frame", "shape");
  const n = frames[0].length;
  const F = frames.length;
  const flat = new Float32Array(F * n);
  frames.forEach((frame, f) => {
    if (frame.length !== n) throw new LstbError(`frame ${f} has ${frame.length} values, expected ${n}`, "shape");
    flat.set(frame, f * n);
  });
  const valueColumn = series === "obs" ? "lst" : "p50";
  const raw = quantize(flat, { dtype: "int16", scale: 0.01, offset: 0, nodata: INT16_NODATA });
  const columns = {
    [valueColumn]: { name: valueColumn, dtype: "int16", shape: [F, n], scale: 0.01, offset: 0, nodata: INT16_NODATA, raw },
  };
  for (const [name, col] of Object.entries(extraColumns)) columns[name] = { name, shape: [F, n], scale: 1, offset: 0, nodata: null, ...col };
  return cubeFromLstb(
    { kind: "cube", n, meta: { mode, frames: years, tiers, levels }, columns },
    { mode, series, years },
  );
}

/**
 * Derived DTR cube = day − night per frame (both cubes must share frames and n). Nodata where
 * either is nodata; uncertainty offsets are not propagated (a difference of quantiles is not a
 * quantile), so DTR exposes p50 only.
 */
export function deriveDtrCube(dayCube, nightCube) {
  if (!dayCube || !nightCube) throw new LstbError("DTR needs both a day and a night cube", "missing");
  if (dayCube.n !== nightCube.n) throw new LstbError(`DTR: day n=${dayCube.n} != night n=${nightCube.n}`, "shape");
  const years = dayCube.years.filter((y) => nightCube.years.includes(y));
  if (!years.length) throw new LstbError("DTR: day and night cubes share no frames", "shape");
  const frames = years.map((y) => {
    const a = decodeCubeFrame(dayCube, dayCube.years.indexOf(y));
    const b = decodeCubeFrame(nightCube, nightCube.years.indexOf(y));
    for (let i = 0; i < a.length; i += 1) a[i] = Number.isNaN(a[i]) || Number.isNaN(b[i]) ? NaN : a[i] - b[i];
    return a;
  });
  const tiers = years.map((y) => {
    const ta = dayCube.tiers[dayCube.years.indexOf(y)];
    const tb = nightCube.tiers[nightCube.years.indexOf(y)];
    return ta && tb ? (ta === tb ? ta : `${ta}|${tb}`) : ta ?? tb ?? null;
  });
  return cubeFromFloatFrames(frames, { years, mode: "dtr", series: dayCube.series, tiers });
}

/** Wrap a decoded LSTB "zones" file: {mode, series: {obs: {years, values, F, n}, ssp245: …}}. */
export function zonesFromLstb(file, { mode = null, yearsBySeries = {} } = {}) {
  if (file?.kind !== "zones") throw new LstbError(`expected an LSTB "zones" file, got kind ${JSON.stringify(file?.kind)}`, "kind");
  const series = {};
  for (const [name, col] of Object.entries(file.columns)) {
    if (col.dtype !== "uint8" || col.shape.length !== 2) throw new LstbError(`zones column "${name}" must be uint8 [frames, n]`, "shape");
    const [F, n] = col.shape;
    const metaYears = file.meta?.frames?.[name] ?? (name === "obs" ? file.meta?.frames_obs : file.meta?.frames_proj);
    const years = Array.isArray(metaYears) && metaYears.length === F ? metaYears.map(Number) : yearsBySeries[name] ?? null;
    if (!years || years.length !== F) throw new LstbError(`zones column "${name}": cannot resolve ${F} frame years`, "shape");
    series[name] = { years, F, n, values: col.raw };
  }
  return { kind: "zones", mode: mode ?? file.meta?.mode ?? null, series, n: file.n };
}

/** Zone ids of one frame as an Int8Array (−1 = nodata) — the v1 epoch `zone` convention. */
export function zoneFrame(zones, series, year) {
  const s = zones?.series?.[series];
  if (!s) return null;
  const f = s.years.indexOf(Number(year));
  if (f < 0) return null;
  const raw = s.values.subarray(f * s.n, (f + 1) * s.n);
  const out = new Int8Array(s.n);
  for (let i = 0; i < s.n; i += 1) out[i] = raw[i] === ZONE_NODATA ? -1 : raw[i];
  return out;
}

/** Quantile (q in [0,1]) over all finite decoded values of all frames (for domain checks). */
export function cubeQuantiles(cube, qs = [0.005, 0.995]) {
  const main = cube.columns[cube.valueColumn];
  const vals = new Float32Array(main.raw.length);
  let k = 0;
  for (let i = 0; i < main.raw.length; i += 1) {
    const r = main.raw[i];
    if (main.nodata !== null && r === main.nodata) continue;
    vals[k] = r * main.scale + main.offset;
    k += 1;
  }
  const sorted = vals.subarray(0, k).sort();
  return qs.map((q) => {
    if (!k) return NaN;
    const pos = (k - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, k - 1);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  });
}
