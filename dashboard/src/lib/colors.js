/**
 * Colour system for NCR THERMAL/OPS v2 (dark UI, dark CARTO basemap).
 *
 * All values come from `src/design/tokens.js` (the single source of truth); this module adds
 * the colour MATH: hex/RGB conversion, OKLab (Björn Ottosson's formulation) interpolation, LUT
 * baking and the v1 scale API (`sequentialScale`, `divergingScale`, `categoricalColor`, …)
 * that the reused v1 components and deck.gl layers call.
 *
 * Scales return deck.gl-ready RGBA arrays (`[r, g, b, a]`, 0..255). Ramps are interpolated in
 * OKLab (perceptually uniform) and pre-baked into 256-entry lookup tables, so colouring 55k
 * cells per frame costs one array lookup per cell.
 *
 * - `sequentialScale` uses the Solar ramp (Day LST) by default; pass `{ramp: "nocturne"}` for
 *   night LST or "amplitude" for DTR. Lightness rises monotonically, so hotter always reads
 *   brighter on the dark basemap.
 * - `divergingScale` uses the Polar ramp: azure (negative = cooler) <-> rose (positive =
 *   warmer) with a dark slate midpoint, so "no effect" recedes into the basemap.
 * - The categorical driver palette (17 hues, fixed order) colours the dominant-driver map.
 */
import { color, driverPalette, legacy, ramps, zoneColors } from "../design/tokens.js";

/**
 * Design tokens for code that needs literal colours (SVG charts, canvas, deck.gl).
 * Keys are the v1 names (kept for the reused components) plus the v2 names.
 */
export const THEME = Object.freeze({
  // v1 names, re-pointed at the v2 palette
  bg: color.bg,
  bgDeep: color.void,
  bgRaised: color.surface2,
  panel: color.surface3,
  border: color.hairline,
  grid: "rgba(160, 185, 225, 0.08)",
  axis: "#55627A",
  ink: color.ink,
  inkStrong: color.inkStrong,
  inkMuted: color.inkMuted,
  inkFaint: color.inkFaint,
  cyan: color.signal,
  violet: legacy.violet.DEFAULT,
  emerald: color.ok,
  rose: legacy.rose.DEFAULT,
  amber: color.warn,
  // Status colours are reserved for state (validation, data mode) - never reuse for series.
  good: color.ok,
  warning: color.warn,
  critical: color.crit,
  // v2 names
  void: color.void,
  surface1: color.surface1,
  surface2: color.surface2,
  surface3: color.surface3,
  hairline: color.hairline,
  hairlineStrong: color.hairlineStrong,
  controlBorder: color.controlBorder,
  signal: color.signal,
  reticle: color.reticle,
  solar: color.solar,
  lunar: color.lunar,
  ssp126: color.ssp126,
  ssp245: color.ssp245,
  ssp370: color.ssp370,
  ssp585: color.ssp585,
  ok: color.ok,
  warn: color.warn,
  crit: color.crit,
  fog: color.fog,
  hatch: color.hatch,
});

/** Zone colours by canonical zone id (fallback when manifest.zones lacks colours). */
export const ZONE_COLORS = zoneColors;

/** Canonical zone names by id (SPEC §1.5). */
export const ZONE_NAMES = Object.freeze([
  "Ecological Cool Base",
  "Riparian Buffer",
  "Transition",
  "Heat Extreme Core",
]);

/** Colour used for missing values (NaN) on the map: dim slate, semi-transparent. */
export const NAN_COLOR = Object.freeze([71, 85, 105, 90]);

/** Sequential ramp stops for LST (Solar, low -> high). Kept under the v1 name. */
export const THERMAL_STOPS = ramps.solar;

/** Diverging ramp stops (Polar, most negative -> most positive). Kept under the v1 name. */
export const DIVERGING_STOPS = ramps.polar;

/**
 * Categorical palette for identity encodings (dominant driver per cell, one per feature).
 * The ORDER is the colour-blind-safety mechanism: every adjacent pair clears the OKLab x100
 * separation gates on the dark surface. Seventeen hues cannot all be pairwise distinct on a
 * map, so identity is always backed by the legend + tooltip text. Slots beyond the palette
 * fold to slate ("Other").
 */
export const categoricalPalette = driverPalette;

/** "#22d3ee" | "#2d3" -> [34, 211, 238]. Throws on malformed input. */
export function hexToRgb(hex) {
  if (typeof hex !== "string") throw new TypeError(`hexToRgb: expected a string, got ${typeof hex}`);
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(h)) throw new Error(`hexToRgb: invalid colour "${hex}"`);
  const rgb = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  if (h.length === 8) rgb.push(parseInt(h.slice(6, 8), 16));
  return rgb;
}

/** [r, g, b] (0..255) -> "#rrggbb" (values are rounded and clamped). */
export function rgbToHex(rgb) {
  return `#${rgb
    .slice(0, 3)
    .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** [r, g, b] or [r, g, b, a(0..255)] -> CSS colour string. */
export function rgbToCss(rgb) {
  if (!rgb || rgb.length < 3) return "transparent";
  const [r, g, b] = rgb.map((v) => Math.round(v));
  if (rgb.length > 3 && rgb[3] !== undefined && rgb[3] !== 255) {
    const alpha = Math.max(0, Math.min(1, rgb[3] / 255));
    return `rgba(${r}, ${g}, ${b}, ${Number(alpha.toFixed(3))})`;
  }
  return `rgb(${r}, ${g}, ${b})`;
}

/** Hex colour with an alpha channel (0..1) as CSS rgba() string. */
export function withAlpha(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ---------------------------------------------------------------------------------------
// sRGB <-> linear <-> OKLab
// ---------------------------------------------------------------------------------------

/** sRGB channel (0..255) -> linear light (0..1). */
export function srgbToLinear(c) {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

/** Linear light (0..1) -> sRGB channel (0..255, rounded, clamped). */
export function linearToSrgb(x) {
  const c = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  return Math.round(Math.max(0, Math.min(1, c)) * 255);
}

/** Linear RGB (0..1) -> [L, a, b] OKLab. */
export function linearToOklab([lr, lg, lb]) {
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** [r,g,b] (0..255) -> [L, a, b] OKLab. */
export function rgbToOklab([r, g, b]) {
  return linearToOklab([srgbToLinear(r), srgbToLinear(g), srgbToLinear(b)]);
}

/** [L, a, b] OKLab -> [r,g,b] (0..255, gamut-clipped). */
export function oklabToRgb([L, A, B]) {
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** WCAG 2.x relative luminance of a hex colour. */
export function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(srgbToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two opaque hex colours (1..21). */
export function contrastRatio(a, b) {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Alpha-composite `fg` (hex) at `alpha` over opaque `bg` (hex) -> opaque hex. */
export function compositeOver(fg, alpha, bg) {
  const f = hexToRgb(fg);
  const b = hexToRgb(bg);
  return rgbToHex(f.map((c, i) => c * alpha + b[i] * (1 - alpha)));
}

// ---------------------------------------------------------------------------------------
// LUT baking
// ---------------------------------------------------------------------------------------

export const LUT_SIZE = 256;

/**
 * Bake evenly spaced hex stops into a `size` x 3 Uint8Array (OKLab interpolation).
 * @param {readonly string[]} stops at least two hex colours
 * @param {number} [size]
 */
export function buildLut(stops, size = LUT_SIZE) {
  if (!Array.isArray(stops) && !(stops && typeof stops.length === "number")) throw new TypeError("buildLut: stops must be an array");
  if (stops.length < 2) throw new Error("buildLut: need at least two stops");
  const labs = Array.from(stops, (hex) => rgbToOklab(hexToRgb(hex)));
  const lut = new Uint8Array(size * 3);
  const segments = labs.length - 1;
  for (let i = 0; i < size; i += 1) {
    const t = (i / (size - 1)) * segments;
    const k = Math.min(Math.floor(t), segments - 1);
    const u = t - k;
    const a = labs[k];
    const b = labs[k + 1];
    const rgb = oklabToRgb([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]);
    lut.set(rgb, i * 3);
  }
  return lut;
}

/** CSS linear-gradient for a legend bar built from ramp stops. */
export function gradientCss(stops, direction = "to right") {
  const parts = Array.from(stops, (c, i) => `${c} ${((i / (stops.length - 1)) * 100).toFixed(1)}%`);
  return `linear-gradient(${direction}, ${parts.join(", ")})`;
}

const LUTS = new Map();

/** Cached LUT for a named ramp ("solar" | "nocturne" | "polar" | "amplitude" | "mist"). */
export function rampLut(name) {
  let lut = LUTS.get(name);
  if (!lut) {
    const stops = ramps[name];
    if (!stops) throw new Error(`rampLut: unknown ramp "${name}"`);
    lut = buildLut(stops);
    LUTS.set(name, lut);
  }
  return lut;
}

export const THERMAL_GRADIENT_CSS = gradientCss(THERMAL_STOPS);
export const DIVERGING_GRADIENT_CSS = gradientCss(DIVERGING_STOPS);

function lutColor(lut, t, alpha) {
  const i = Math.round(Math.max(0, Math.min(1, t)) * (LUT_SIZE - 1)) * 3;
  return [lut[i], lut[i + 1], lut[i + 2], alpha];
}

/**
 * Sequential scale over `domain = [min, max]` (fixed per mode x variable in v2, from
 * manifest.timeline.domains). Values outside the domain clamp to the end colours;
 * NaN/null -> NAN_COLOR. The returned function also exposes `domain`, `gradientCss`, `stops`
 * and `ramp` for legends.
 * @param {[number, number]} domain
 * @param {{alpha?: number, ramp?: "solar"|"nocturne"|"amplitude"|"mist"}} [options] alpha 0..255 (default 235)
 * @returns {((v: number) => number[]) & {domain: number[], gradientCss: string, stops: readonly string[], ramp: string}}
 */
export function sequentialScale(domain, { alpha = 235, ramp = "solar" } = {}) {
  let [lo, hi] = Array.isArray(domain) ? domain : [0, 1];
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) [lo, hi] = [0, 1];
  if (hi === lo) hi = lo + 1e-9;
  const span = hi - lo;
  const lut = rampLut(ramp);
  const stops = ramps[ramp];
  const scale = (v) => (v == null || Number.isNaN(v) ? NAN_COLOR : lutColor(lut, (v - lo) / span, alpha));
  scale.domain = [lo, hi];
  scale.gradientCss = ramp === "solar" ? THERMAL_GRADIENT_CSS : gradientCss(stops);
  scale.stops = stops;
  scale.ramp = ramp;
  return scale;
}

/**
 * Diverging azure (negative) <-> rose (positive) scale symmetric around 0 over
 * [-maxAbs, +maxAbs]. NaN/null -> NAN_COLOR.
 * The returned function also exposes `domain`, `gradientCss`, `stops` and `ramp` for legends.
 * @param {number} maxAbs
 * @param {{alpha?: number}} [options]
 */
export function divergingScale(maxAbs, { alpha = 235 } = {}) {
  const m = Number.isFinite(maxAbs) && maxAbs > 0 ? Math.abs(maxAbs) : 1;
  const lut = rampLut("polar");
  const scale = (v) => (v == null || Number.isNaN(v) ? NAN_COLOR : lutColor(lut, (v / m + 1) / 2, alpha));
  scale.domain = [-m, m];
  scale.gradientCss = DIVERGING_GRADIENT_CSS;
  scale.stops = DIVERGING_STOPS;
  scale.ramp = "polar";
  return scale;
}

/** Categorical colour (RGBA) for slot `i`; slots beyond the palette fold to slate "Other". */
export function categoricalColor(i, alpha = 235) {
  const hex = i >= 0 && i < categoricalPalette.length ? categoricalPalette[i] : THEME.inkFaint;
  return [...hexToRgb(hex), alpha];
}

/** Zone colour (hex) by id, preferring the colours carried in manifest.zones. */
export function zoneColor(zoneId, zonesMeta) {
  const fromMeta = zonesMeta?.find?.((z) => z.id === zoneId)?.color;
  return fromMeta || ZONE_COLORS[zoneId] || THEME.inkFaint;
}

/** SSP accent colour by scenario id ("ssp245") or short code ("245"); unknown -> ink-muted. */
export function sspColor(id) {
  const key = String(id ?? "").startsWith("ssp") ? String(id) : `ssp${id}`;
  return color[key] ?? color.inkMuted;
}
