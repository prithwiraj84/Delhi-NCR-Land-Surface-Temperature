/**
 * Thermal LUT atlas: the ONE table of colours both render paths read (UI_SPEC §6.2 "Colour").
 *
 * Layout: 256 columns × (5 ramps × 5 variants) rows, RGBA8.
 *   row = rampIndex · 5 + variant
 *   variant 0      plain ramp (design/ramps.js LUTS, the legend bytes)
 *   variant 1..4   VSUP tiers U0..U3 (value bins coarsened, OKLab chroma reduced, mixed to fog —
 *                  `vsupRgb` from design/ramps.js evaluated at every LUT position)
 *
 * Baking VSUP once (instead of doing OKLab in the shader) makes the GPU path and the CPU path
 * bit-identical by construction: the shader does `texelFetch(atlas, ivec2(round(t·255), row))`
 * and the CPU indexes the same bytes with `Math.round(t·255)`, so "prism top-face colour equals
 * LUT(value)" holds on both paths (acceptance §15).
 */

import { LUT_SIZE, LUTS, RAMP_ORDER, vsupRgb } from "../design/ramps.js";

export const VARIANTS = 5;
export const ATLAS_WIDTH = LUT_SIZE;
export const ATLAS_ROWS = RAMP_ORDER.length * VARIANTS;

/** Row of the atlas for a ramp name and a VSUP variant (0 plain, 1..4 = U0..U3). */
export function atlasRow(rampIndex, variant = 0) {
  return rampIndex * VARIANTS + Math.max(0, Math.min(VARIANTS - 1, variant | 0));
}

/** Ramp index (texture row group) of a ramp name; throws on unknown names. */
export function rampIndexOf(name) {
  const i = RAMP_ORDER.indexOf(name);
  if (i < 0) throw new Error(`thermal LUT: unknown ramp "${name}" (expected ${RAMP_ORDER.join(", ")})`);
  return i;
}

let atlasCache = null;

/**
 * The baked atlas (cached): `{data: Uint8Array(width·rows·4), width, height}`.
 * Pure CPU work (~6.4k OKLab conversions), done once per page.
 */
export function thermalAtlas() {
  if (atlasCache) return atlasCache;
  const width = ATLAS_WIDTH;
  const height = ATLAS_ROWS;
  const data = new Uint8Array(width * height * 4);
  RAMP_ORDER.forEach((name, r) => {
    const lut = LUTS[name];
    for (let v = 0; v < VARIANTS; v += 1) {
      const row = atlasRow(r, v);
      for (let i = 0; i < width; i += 1) {
        const o = (row * width + i) * 4;
        if (v === 0) {
          data[o] = lut[i * 3];
          data[o + 1] = lut[i * 3 + 1];
          data[o + 2] = lut[i * 3 + 2];
        } else {
          const [cr, cg, cb] = vsupRgb(name, i / (width - 1), v - 1);
          data[o] = cr;
          data[o + 1] = cg;
          data[o + 2] = cb;
        }
        data[o + 3] = 255;
      }
    }
  });
  atlasCache = Object.freeze({ data, width, height });
  return atlasCache;
}

/** Atlas column of a value in a domain: round(clamp((v − lo)/(hi − lo)) · 255) — mirrored in GLSL. */
export function lutColumn(value, lo, hi) {
  const span = hi - lo;
  const t = span > 0 ? (value - lo) / span : 0.5;
  const c = t <= 0 ? 0 : t >= 1 ? 1 : t;
  return Math.floor(c * (ATLAS_WIDTH - 1) + 0.5);
}

/**
 * Write the atlas colour of a value into `out` at byte offset `o` (RGB only).
 * @returns {boolean} false for NaN (nothing written)
 */
export function atlasRgb(value, rampIndex, variant, lo, hi, out, o = 0) {
  if (Number.isNaN(value)) return false;
  const { data, width } = thermalAtlas();
  const k = (atlasRow(rampIndex, variant) * width + lutColumn(value, lo, hi)) * 4;
  out[o] = data[k];
  out[o + 1] = data[k + 1];
  out[o + 2] = data[k + 2];
  return true;
}
