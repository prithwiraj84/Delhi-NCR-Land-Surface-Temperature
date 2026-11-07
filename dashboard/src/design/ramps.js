/**
 * Data ramps for NCR THERMAL/OPS v2 (UI_SPEC_v2 §4.2): 256-entry OKLab LUTs, the GPU ramp
 * texture, ramp selection per mode x variable, and the VSUP (value-suppressing uncertainty
 * palette) used for projected frames and the uncertainty layer.
 *
 * The colour math (OKLab, LUT baking) lives in src/lib/colors.js; this module only arranges
 * it for the map engine and legends. The CPU colour path (engine CPU fallback, legends,
 * tooltips) and the GPU path sample the SAME LUT bytes, so a prism top face and its legend
 * swatch are identical by construction.
 */
import { buildLut, gradientCss, hexToRgb, LUT_SIZE, oklabToRgb, rgbToOklab } from "../lib/colors.js";
import { driverPalette, RAMP_ORDER, rampKind, ramps } from "./tokens.js";

export { LUT_SIZE, RAMP_ORDER };

/** Every named ramp baked once: name -> Uint8Array(256 * 3). */
export const LUTS = Object.freeze(Object.fromEntries(RAMP_ORDER.map((name) => [name, buildLut(ramps[name])])));

/** Row of the driver palette in the GPU texture (after the five continuous ramps). */
export const DRIVER_ROW = RAMP_ORDER.length;

/** Texture rows: 5 continuous ramps + the categorical driver palette = 6. */
export const RAMP_TEXTURE_ROWS = RAMP_ORDER.length + 1;

/** Texture row index of a ramp name (throws on unknown names - a typo must not render grey). */
export function rampRow(name) {
  const i = RAMP_ORDER.indexOf(name);
  if (i < 0) throw new Error(`rampRow: unknown ramp "${name}" (expected one of ${RAMP_ORDER.join(", ")})`);
  return i;
}

/**
 * The 256 x 6 RGBA8 ramp texture, row-major (row r starts at byte r * 256 * 4), alpha 255.
 * Row 5 holds the categorical driver palette in 15-texel blocks (slot k at texels
 * [15k, 15k + 15)), sampled with NEAREST filtering by slot centre `(15k + 7.5) / 256`.
 * @returns {{data: Uint8Array, width: number, height: number}}
 */
export function buildRampTexture() {
  const width = LUT_SIZE;
  const height = RAMP_TEXTURE_ROWS;
  const data = new Uint8Array(width * height * 4);
  RAMP_ORDER.forEach((name, row) => {
    const lut = LUTS[name];
    for (let i = 0; i < width; i += 1) {
      const o = (row * width + i) * 4;
      data[o] = lut[i * 3];
      data[o + 1] = lut[i * 3 + 1];
      data[o + 2] = lut[i * 3 + 2];
      data[o + 3] = 255;
    }
  });
  const block = Math.floor(width / driverPalette.length);
  for (let i = 0; i < width; i += 1) {
    const slot = Math.min(Math.floor(i / block), driverPalette.length - 1);
    const [r, g, b] = hexToRgb(driverPalette[slot]);
    const o = (DRIVER_ROW * width + i) * 4;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = 255;
  }
  return { data, width, height };
}

/** Texture u coordinate of driver slot `k` (NEAREST sampling at the block centre). */
export function driverSlotU(k) {
  const block = Math.floor(LUT_SIZE / driverPalette.length);
  return (block * k + block / 2) / LUT_SIZE;
}

/**
 * LUT colour for a value: t = (v - lo) / (hi - lo), clamped. Returns [r, g, b] or null for
 * NaN/null. Writes into `out` when given (no allocation on hot paths).
 */
export function lutRgb(name, value, lo, hi, out) {
  if (value == null || Number.isNaN(value)) return null;
  const lut = LUTS[name];
  if (!lut) throw new Error(`lutRgb: unknown ramp "${name}"`);
  const span = hi - lo || 1e-9;
  const t = Math.max(0, Math.min(1, (value - lo) / span));
  const i = Math.round(t * (LUT_SIZE - 1)) * 3;
  const target = out ?? [0, 0, 0];
  target[0] = lut[i];
  target[1] = lut[i + 1];
  target[2] = lut[i + 2];
  return target;
}

/** CSS gradient of a ramp for legend bars ("to right" by default). */
export function rampGradientCss(name, direction = "to right") {
  const stops = ramps[name];
  if (!stops) throw new Error(`rampGradientCss: unknown ramp "${name}"`);
  return gradientCss(stops, direction);
}

/** Variables that are signed (diverging Polar ramp, domain symmetric about 0). */
export const SIGNED_VARIABLES = Object.freeze(["anom", "suhi", "delta", "resid", "shap", "whatif"]);

/**
 * Ramp name for a mode x variable (x layer) combination.
 *   abs/pred      -> Solar (day) | Nocturne (night) | Amplitude (dtr); Solar for the shared scale
 *   anom/suhi/delta/resid/shap/whatif -> Polar (diverging)
 *   spread/unc    -> Mist
 * @param {{mode?: string, variable?: string, layer?: string, domainMode?: string}} sel
 */
export function rampFor({ mode = "day", variable = "abs", layer = "lst", domainMode } = {}) {
  const layerId = String(layer ?? "lst");
  if (layerId === "unc" || variable === "spread") return "mist";
  if (layerId === "resid" || layerId === "whatif" || layerId.startsWith("shap")) return "polar";
  if (SIGNED_VARIABLES.includes(variable)) return "polar";
  if (mode === "dtr") return "amplitude";
  if (domainMode === "shared") return "solar";
  return mode === "night" ? "nocturne" : "solar";
}

/** "sequential" | "diverging" for a ramp name. */
export function rampKindOf(name) {
  return rampKind[name] ?? "sequential";
}

// ---------------------------------------------------------------------------------------
// VSUP (value-suppressing uncertainty palette), UI_SPEC §4.2
// ---------------------------------------------------------------------------------------

/**
 * Uncertainty tiers by p5-p95 half-width (°C). Bins = number of value classes kept at that
 * tier (coarser as uncertainty grows), chroma = fraction of OKLab chroma kept, fog = mix
 * fraction towards the fog colour; U3 additionally hatches.
 */
export const VSUP_TIERS = Object.freeze([
  Object.freeze({ id: "U0", maxHalfWidth: 0.5, bins: 16, chroma: 1.0, fog: 0, hatch: false }),
  Object.freeze({ id: "U1", maxHalfWidth: 1, bins: 8, chroma: 0.75, fog: 0.15, hatch: false }),
  Object.freeze({ id: "U2", maxHalfWidth: 2, bins: 4, chroma: 0.5, fog: 0.35, hatch: false }),
  Object.freeze({ id: "U3", maxHalfWidth: Infinity, bins: 2, chroma: 0.3, fog: 0.6, hatch: true }),
]);

/** Fog colour the VSUP mixes towards (opaque equivalent of --fog over --void). */
export const VSUP_FOG_RGB = Object.freeze([140, 160, 200]);

/** Tier index 0..3 for a p5-p95 half-width in °C (NaN/negative -> 0). */
export function vsupTier(halfWidth) {
  if (!Number.isFinite(halfWidth) || halfWidth < 0.5) return 0;
  if (halfWidth < 1) return 1;
  if (halfWidth < 2) return 2;
  return 3;
}

/**
 * VSUP colour for a normalised value t in [0, 1] at uncertainty tier `tier` (0..3):
 * quantise t into the tier's bins (bin centres), look the LUT up, scale OKLab chroma, then
 * mix towards fog. Pure; the GLSL in engine/shaders mirrors it.
 * @param {string} name ramp name
 * @param {number} t normalised value
 * @param {number} tier 0..3
 * @returns {[number, number, number]}
 */
export function vsupRgb(name, t, tier) {
  const spec = VSUP_TIERS[Math.max(0, Math.min(3, tier | 0))];
  const clamped = Math.max(0, Math.min(1, Number.isFinite(t) ? t : 0));
  const bin = Math.min(spec.bins - 1, Math.floor(clamped * spec.bins));
  const tq = spec.bins >= LUT_SIZE ? clamped : (bin + 0.5) / spec.bins;
  const lut = LUTS[name];
  if (!lut) throw new Error(`vsupRgb: unknown ramp "${name}"`);
  const i = Math.round(tq * (LUT_SIZE - 1)) * 3;
  const [L, a, b] = rgbToOklab([lut[i], lut[i + 1], lut[i + 2]]);
  const desat = oklabToRgb([L, a * spec.chroma, b * spec.chroma]);
  const f = spec.fog;
  return [
    Math.round(desat[0] * (1 - f) + VSUP_FOG_RGB[0] * f),
    Math.round(desat[1] * (1 - f) + VSUP_FOG_RGB[1] * f),
    Math.round(desat[2] * (1 - f) + VSUP_FOG_RGB[2] * f),
  ];
}
