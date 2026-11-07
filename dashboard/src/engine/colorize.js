/**
 * CPU colour + elevation path (UI_SPEC §6.2 "CPU fallback"): the reference the GPU extension
 * mirrors, and the path used for `?shader=off`, shader failures, perf tier 3, categorical
 * layers and the two compare instances.
 *
 * Inputs are display values (°C or the layer's unit, NaN = nodata) of two slots plus a weight
 * (one number for a fade, or a per-cell Float32Array from `mixWeights` for sweep/radial).
 *
 * Two blend modes, chosen by whether both slots share one colour channel (ramp + domain):
 *   value mix   (same channel: time tween)        v = mixValue(A, B, m) → LUT(v)
 *   colour mix  (different channels: Day↔Night sweep, layer cross-fade)
 *               colour = lerp(LUT_A(A), LUT_B(B), m); a side that is nodata fades via alpha
 *
 * Decoration never alters data pixels except the explicit, documented encodings:
 *   VSUP fog   projected slots blend toward their VSUP variant (weight = projected share × fog)
 *   AOA        outside-AOA cells darken by 35 % (the GPU hatches them in screen space instead)
 *   brush      unselected cells dim to 25 % while a Drivers brush is active
 */

import { ATLAS_WIDTH, atlasRow, thermalAtlas } from "./lut.js";

/** Height encodings (uniform `thermal.heightMode`). */
export const HEIGHT_MODE_CODES = Object.freeze({ flat: 0, anom: 1, abs: 2 });
/** Cap of the "°C above the NCR mean" height (D3). */
export const HEIGHT_CAP_C = 6;
/** Metres of prism per °C above the mean (cap 6 °C → 18 km, legible at the home zoom 7.7). */
export const ELEV_PER_DEGREE_ANOM = 3000;
/** Full relief (metres) of the absolute height mode across the colour domain (v1 MAX_ELEVATION_M). */
export const ABS_RELIEF_M = 22000;

export const AOA_DARKEN = 0.65;
export const BRUSH_DIM = 0.25;

/**
 * Height of one value.
 * @param {number} v display value
 * @param {number} mode 0 flat | 1 anom (clamp(v − ref, 0, cap)) | 2 abs (max(v − lo, 0))
 * @param {{ref:number, lo:number, cap:number, perUnit:number, perUnitAbs:number}} c
 */
export function elevationOf(v, mode, c) {
  if (Number.isNaN(v) || mode === 0) return 0;
  if (mode === 1) {
    const e = v - c.ref;
    return (e <= 0 ? 0 : e >= c.cap ? c.cap : e) * c.perUnit;
  }
  const e = v - c.lo;
  return (e > 0 ? e : 0) * c.perUnitAbs;
}

/** Height channel of a colour channel: metres per unit for both height modes. */
export function heightChannel({ lo, hi, ref, cap = HEIGHT_CAP_C }) {
  const span = hi - lo || 1;
  return { lo, ref: Number.isFinite(ref) ? ref : (lo + hi) / 2, cap, perUnit: ELEV_PER_DEGREE_ANOM, perUnitAbs: ABS_RELIEF_M / span };
}

/**
 * Colour two slots into RGBA bytes and (optionally) heights. Allocation-free when `out*` given.
 *
 * @param {object} p
 * @param {Float32Array} p.valuesA @param {Float32Array} p.valuesB
 * @param {number|Float32Array} p.weight mix weight (uniform or per cell)
 * @param {{rampIndex:number, lo:number, hi:number}} p.channelA @param {object} p.channelB
 * @param {boolean} p.valueMix  value-mix (same channel) or colour-mix
 * @param {Uint8Array|null} [p.vsupA] @param {Uint8Array|null} [p.vsupB] VSUP code per cell (0 none, 1..4 = U0..U3)
 * @param {number} [p.fogStrength=1]
 * @param {Uint8Array|null} [p.aoaA] @param {Uint8Array|null} [p.aoaB] 1 = outside the AOA
 * @param {boolean} [p.hatchOn=true]
 * @param {Uint8Array|null} [p.brush] 1 = selected; @param {boolean} [p.maskOn]
 * @param {number} [p.alpha=255]
 * @param {Uint8Array} p.outColors n·4
 * @param {Float32Array} [p.outValues] mixed display values (value mix) or the dominant side (colour mix)
 * @param {Float32Array} [p.outElevations] metres
 * @param {{mode:number, from?:number, blend?:number, A:object, B:object}} [p.height]
 *   height encoding: `mode` (target), `from` + `blend` morph between two modes (550 ms elev
 *   choreography); A/B = heightChannel of each slot
 */
export function colorizeSlots(p) {
  const { valuesA, valuesB, weight, channelA, channelB, valueMix, vsupA = null, vsupB = null, fogStrength = 1, aoaA = null, aoaB = null, hatchOn = true, brush = null, maskOn = false, alpha = 255, outColors, outValues = null, outElevations = null, height = null } = p;
  const n = valuesA.length;
  if (valuesB.length !== n) throw new RangeError("colorizeSlots: slot lengths differ");
  if (!outColors || outColors.length < n * 4) throw new RangeError("colorizeSlots: outColors must hold n·4 bytes");
  // Hot loop (55k cells per frame on the CPU path): no per-cell calls or allocations. The atlas
  // indexing is lut.js `atlasRow` / `lutColumn` inlined: k = (row·256 + col)·4, row = ramp·5 + variant.
  const atlas = thermalAtlas().data;
  const ROW = ATLAS_WIDTH * 4;
  const baseA = atlasRow(channelA.rampIndex, 0) * ROW;
  const baseB = atlasRow(channelB.rampIndex, 0) * ROW;
  const loA = channelA.lo;
  const loB = channelB.lo;
  const spanA = channelA.hi - channelA.lo;
  const spanB = channelB.hi - channelB.lo;
  const invA = spanA > 0 ? 1 / spanA : 0;
  const invB = spanB > 0 ? 1 / spanB : 0;
  const uniformW = typeof weight === "number";
  const wU = uniformW ? weight : 0;
  const fogOn = fogStrength >= 0.5;
  const hMode = height ? height.mode : 0;
  const hFrom = height ? height.from ?? hMode : 0;
  const hBlend = height ? (height.blend === undefined ? 1 : height.blend) : 1;
  const heights = Boolean(outElevations && height && !(hMode === 0 && hFrom === 0));
  const hA = height?.A;
  const hB = height?.B;
  const elev = (v, mode, c) => {
    if (mode === 0) return 0;
    if (mode === 1) {
      const e = v - c.ref;
      return (e <= 0 ? 0 : e >= c.cap ? c.cap : e) * c.perUnit;
    }
    const e = v - c.lo;
    return (e > 0 ? e : 0) * c.perUnitAbs;
  };
  const colOf = (v, lo, inv) => {
    if (inv === 0) return 128;
    const t = (v - lo) * inv;
    return t <= 0 ? 0 : t >= 1 ? 255 : (t * 255 + 0.5) | 0;
  };
  for (let i = 0; i < n; i += 1) {
    const m = uniformW ? wU : weight[i];
    const a = valuesA[i];
    const b = valuesB[i];
    const o = i * 4;
    let r;
    let g;
    let bl;
    let al = alpha;
    let shown;
    const sideB = m >= 0.5;
    if (valueMix) {
      const v = m <= 0 ? a : m >= 1 ? b : a !== a || b !== b ? NaN : a + (b - a) * m;
      shown = v;
      if (v !== v) {
        outColors[o] = 0;
        outColors[o + 1] = 0;
        outColors[o + 2] = 0;
        outColors[o + 3] = 0;
        if (outValues) outValues[i] = NaN;
        if (outElevations) outElevations[i] = 0;
        continue;
      }
      const k = baseA + colOf(v, loA, invA) * 4;
      r = atlas[k];
      g = atlas[k + 1];
      bl = atlas[k + 2];
      const ca = vsupA ? vsupA[i] : 0;
      const cb = vsupB ? vsupB[i] : 0;
      if (ca > 0 || cb > 0) {
        const w = ((1 - m) * (ca > 0 ? 1 : 0) + m * (cb > 0 ? 1 : 0)) * fogStrength;
        const code = sideB ? cb || ca : ca || cb;
        if (w > 0 && code > 0) {
          const kv = k + (code > 4 ? 4 : code) * ROW;
          r += (atlas[kv] - r) * w;
          g += (atlas[kv + 1] - g) * w;
          bl += (atlas[kv + 2] - bl) * w;
        }
      }
    } else {
      const okA = a === a && m < 1;
      const okB = b === b && m > 0;
      if (!okA && !okB) {
        outColors[o] = 0;
        outColors[o + 1] = 0;
        outColors[o + 2] = 0;
        outColors[o + 3] = 0;
        if (outValues) outValues[i] = NaN;
        if (outElevations) outElevations[i] = 0;
        continue;
      }
      const wa = okA ? 1 - m : 0;
      const wb = okB ? m : 0;
      const sum = wa + wb || 1;
      r = 0;
      g = 0;
      bl = 0;
      if (okA) {
        const va = vsupA && fogOn ? vsupA[i] : 0;
        const k = baseA + (va > 4 ? 4 : va) * ROW + colOf(a, loA, invA) * 4;
        r += atlas[k] * wa;
        g += atlas[k + 1] * wa;
        bl += atlas[k + 2] * wa;
      }
      if (okB) {
        const vb = vsupB && fogOn ? vsupB[i] : 0;
        const k = baseB + (vb > 4 ? 4 : vb) * ROW + colOf(b, loB, invB) * 4;
        r += atlas[k] * wb;
        g += atlas[k + 1] * wb;
        bl += atlas[k + 2] * wb;
      }
      // Colour is weighted among the AVAILABLE sides; alpha carries the missing side's share.
      r /= sum;
      g /= sum;
      bl /= sum;
      al = alpha * (okA && okB ? 1 : okA ? 1 - m : m);
      shown = sideB ? (okB ? b : a) : okA ? a : b;
    }
    if (hatchOn && (sideB ? aoaB && aoaB[i] : aoaA && aoaA[i])) {
      r *= AOA_DARKEN;
      g *= AOA_DARKEN;
      bl *= AOA_DARKEN;
    }
    if (maskOn && brush && !brush[i]) {
      r *= BRUSH_DIM;
      g *= BRUSH_DIM;
      bl *= BRUSH_DIM;
    }
    outColors[o] = r + 0.5;
    outColors[o + 1] = g + 0.5;
    outColors[o + 2] = bl + 0.5;
    outColors[o + 3] = al + 0.5;
    if (outValues) outValues[i] = shown;
    if (outElevations) {
      if (!heights) outElevations[i] = 0;
      else if (valueMix) {
        const eTo = elev(shown, hMode, hA);
        outElevations[i] = hBlend >= 1 ? eTo : elev(shown, hFrom, hA) + (eTo - elev(shown, hFrom, hA)) * hBlend;
      } else {
        const ea = a !== a ? 0 : elev(a, hMode, hA);
        const eb = b !== b ? 0 : elev(b, hMode, hB);
        outElevations[i] = ea + (eb - ea) * m;
      }
    }
  }
  return outColors;
}

/**
 * Categorical colours (driver / zones / AOA): RGBA per cell from a palette of [r,g,b] by code
 * (−1 / 255 / NaN = nodata). Optional cross-fade from a previous RGBA buffer (220 ms layer fade).
 */
export function colorizeCategorical({ codes, palette, nodataCode = -1, alpha = 255, outColors, fromColors = null, weight = 1, brush = null, maskOn = false }) {
  const n = codes.length;
  const w = Math.max(0, Math.min(1, weight));
  for (let i = 0; i < n; i += 1) {
    const c = codes[i];
    const o = i * 4;
    const col = c === nodataCode || Number.isNaN(c) || c === undefined ? null : palette[c];
    let r = col ? col[0] : 0;
    let g = col ? col[1] : 0;
    let b = col ? col[2] : 0;
    let a = col ? alpha : 0;
    if (maskOn && brush && !brush[i] && col) {
      r *= BRUSH_DIM;
      g *= BRUSH_DIM;
      b *= BRUSH_DIM;
    }
    if (fromColors && w < 1) {
      r = fromColors[o] + (r - fromColors[o]) * w;
      g = fromColors[o + 1] + (g - fromColors[o + 1]) * w;
      b = fromColors[o + 2] + (b - fromColors[o + 2]) * w;
      a = fromColors[o + 3] + (a - fromColors[o + 3]) * w;
    }
    outColors[o] = r + 0.5;
    outColors[o + 1] = g + 0.5;
    outColors[o + 2] = b + 0.5;
    outColors[o + 3] = a + 0.5;
  }
  return outColors;
}
