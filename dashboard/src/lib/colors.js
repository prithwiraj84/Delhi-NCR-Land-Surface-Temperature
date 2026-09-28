/**
 * Colour system for the thermal digital twin (dark UI, dark CARTO basemap).
 *
 * Scales return deck.gl-ready RGBA arrays (`[r, g, b, a]`, 0..255). Ramps are interpolated
 * in OKLab (perceptually uniform) and pre-baked into 256-entry lookup tables so colouring
 * 55k cells per frame costs one array lookup per cell.
 *
 * - Sequential "thermal" ramp for LST: deep indigo -> violet -> magenta -> rose/orange ->
 *   amber -> pale yellow. Lightness rises monotonically, so hotter always reads brighter on
 *   the dark basemap; the dark end is still lifted off the #090d16 background.
 * - Diverging ramp for signed quantities (SHAP, residuals, scenario delta): cool cyan
 *   (negative = cooling) <-> warm rose (positive = warming) with a dark slate midpoint, so
 *   "no effect" recedes into the basemap and both arms gain lightness symmetrically.
 * - Categorical palette (>= 17 hues) for the dominant-driver map, in a fixed order.
 */

/** Design tokens (mirrors tailwind.config.js and the CSS variables in index.css). */
export const THEME = Object.freeze({
  bg: "#090d16",
  bgDeep: "#05080f",
  bgRaised: "#0f1624",
  panel: "#1e293b",
  border: "rgba(148, 163, 184, 0.16)",
  grid: "rgba(148, 163, 184, 0.10)",
  axis: "#475569",
  ink: "#e2e8f0",
  inkStrong: "#f8fafc",
  inkMuted: "#94a3b8",
  // WCAG AA (>= 4.5:1) for small text on every panel surface up to #1e293b (5.5:1 on #182130).
  inkFaint: "#8a97ab",
  cyan: "#22d3ee",
  violet: "#a78bfa",
  emerald: "#34d399",
  rose: "#fb7185",
  amber: "#fbbf24",
  // Status colours are reserved for state (validation, data mode) - never reuse for series.
  good: "#34d399",
  warning: "#fbbf24",
  critical: "#f87171",
});

/** Zone colours by canonical zone id (fallback when manifest.zones lacks colours). */
export const ZONE_COLORS = Object.freeze(["#34d399", "#22d3ee", "#a78bfa", "#fb7185"]);

/** Canonical zone names by id (SPEC §1). */
export const ZONE_NAMES = Object.freeze([
  "Ecological Cool Base",
  "Riparian Buffer",
  "Transition",
  "Heat Extreme Core",
]);

/** Colour used for missing values (NaN) on the map: dim slate, semi-transparent. */
export const NAN_COLOR = Object.freeze([71, 85, 105, 90]);

/** Thermal ramp stops (low -> high). */
export const THERMAL_STOPS = Object.freeze([
  "#2b2a7c",
  "#5b2bc4",
  "#9d2bc0",
  "#df2f7d",
  "#fb6a4a",
  "#fbb13c",
  "#fef3c7",
]);

/** Diverging ramp stops (most negative -> most positive). */
export const DIVERGING_STOPS = Object.freeze([
  "#a5f3fc",
  "#22d3ee",
  "#0e7490",
  "#2b3445",
  "#be123c",
  "#fb7185",
  "#fecdd3",
]);

/**
 * Categorical palette for identity encodings (dominant driver per cell, one per feature).
 * The ORDER is the colour-blind-safety mechanism: it was searched so that every adjacent
 * pair clears the OKLab x100 separation gates on the #090d16 surface (worst adjacent CVD
 * dE 14.1 protan, normal-vision dE 24.9, all >= 3:1 contrast). Seventeen hues cannot all be
 * pairwise distinct on a map, so identity is always backed by the legend + tooltip text.
 * The 17 model features map to slots 0..16 in manifest order; extra slots fold to slate.
 */
export const categoricalPalette = Object.freeze([
  "#ec4899",
  "#facc15",
  "#14b8a6",
  "#f59e0b",
  "#38bdf8",
  "#ea580c",
  "#a78bfa",
  "#ef4444",
  "#22d3ee",
  "#e11d48",
  "#4f46e5",
  "#34d399",
  "#3b82f6",
  "#a3e635",
  "#c084fc",
  "#16a34a",
  "#e879f9",
]);

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
// OKLab interpolation (Björn Ottosson's formulation) - perceptually even ramps.
// ---------------------------------------------------------------------------------------

function srgbToLinear(c) {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(x) {
  const c = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  return Math.round(Math.max(0, Math.min(1, c)) * 255);
}

/** [r,g,b] (0..255) -> [L, a, b] OKLab. */
export function rgbToOklab([r, g, b]) {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
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

const LUT_SIZE = 256;

/** Bake evenly spaced hex stops into a LUT_SIZE x 3 Uint8Array (OKLab interpolation). */
function buildLut(stops) {
  const labs = stops.map((hex) => rgbToOklab(hexToRgb(hex)));
  const lut = new Uint8Array(LUT_SIZE * 3);
  const segments = labs.length - 1;
  for (let i = 0; i < LUT_SIZE; i += 1) {
    const t = (i / (LUT_SIZE - 1)) * segments;
    const k = Math.min(Math.floor(t), segments - 1);
    const u = t - k;
    const a = labs[k];
    const b = labs[k + 1];
    const rgb = oklabToRgb([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u]);
    lut.set(rgb, i * 3);
  }
  return lut;
}

const THERMAL_LUT = buildLut(THERMAL_STOPS);
const DIVERGING_LUT = buildLut(DIVERGING_STOPS);

/** CSS linear-gradient for a legend bar built from ramp stops. */
function gradientCss(stops, direction = "to right") {
  const parts = stops.map((c, i) => `${c} ${((i / (stops.length - 1)) * 100).toFixed(1)}%`);
  return `linear-gradient(${direction}, ${parts.join(", ")})`;
}

export const THERMAL_GRADIENT_CSS = gradientCss(THERMAL_STOPS);
export const DIVERGING_GRADIENT_CSS = gradientCss(DIVERGING_STOPS);

function lutColor(lut, t, alpha) {
  const i = Math.round(Math.max(0, Math.min(1, t)) * (LUT_SIZE - 1)) * 3;
  return [lut[i], lut[i + 1], lut[i + 2], alpha];
}

/**
 * Sequential thermal scale over `domain = [min, max]` (e.g. epoch.stats.lst_obs p02/p98).
 * Values outside the domain clamp to the end colours; NaN/null -> NAN_COLOR.
 * The returned function also exposes `domain`, `gradientCss` and `stops` for legends.
 * @param {[number, number]} domain
 * @param {{alpha?: number}} [options] alpha 0..255 (default 235)
 * @returns {((v: number) => number[]) & {domain: number[], gradientCss: string, stops: readonly string[]}}
 */
export function sequentialScale(domain, { alpha = 235 } = {}) {
  let [lo, hi] = Array.isArray(domain) ? domain : [0, 1];
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) [lo, hi] = [0, 1];
  if (hi === lo) hi = lo + 1e-9;
  const span = hi - lo;
  const scale = (v) => (v == null || Number.isNaN(v) ? NAN_COLOR : lutColor(THERMAL_LUT, (v - lo) / span, alpha));
  scale.domain = [lo, hi];
  scale.gradientCss = THERMAL_GRADIENT_CSS;
  scale.stops = THERMAL_STOPS;
  return scale;
}

/**
 * Diverging cyan (negative) <-> rose (positive) scale symmetric around 0 over
 * [-maxAbs, +maxAbs]. NaN/null -> NAN_COLOR.
 * The returned function also exposes `domain`, `gradientCss` and `stops` for legends.
 * @param {number} maxAbs
 * @param {{alpha?: number}} [options]
 */
export function divergingScale(maxAbs, { alpha = 235 } = {}) {
  const m = Number.isFinite(maxAbs) && maxAbs > 0 ? Math.abs(maxAbs) : 1;
  const scale = (v) => (v == null || Number.isNaN(v) ? NAN_COLOR : lutColor(DIVERGING_LUT, (v / m + 1) / 2, alpha));
  scale.domain = [-m, m];
  scale.gradientCss = DIVERGING_GRADIENT_CSS;
  scale.stops = DIVERGING_STOPS;
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
