/**
 * Number / label formatting helpers shared by all views.
 *
 * Conventions
 * - Missing values (null, undefined, NaN, +/-Infinity) render as an em dash so a table
 *   never shows "NaN".
 * - Negative numbers use the typographic minus sign (U+2212), which has the same width as
 *   "+" and keeps signed columns visually aligned.
 * - Intl.NumberFormat instances are cached per option set (constructing them is slow).
 */

export const MISSING = "\u2014";
const MINUS = "\u2212";

const formatterCache = new Map();

/** Cached Intl.NumberFormat for the given options (en-US grouping). */
function numberFormatter(options) {
  const key = JSON.stringify(options);
  let formatter = formatterCache.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat("en-US", options);
    formatterCache.set(key, formatter);
  }
  return formatter;
}

/** True for finite numbers only (rejects null, undefined, NaN, Infinity, strings). */
export function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function clampDp(dp) {
  const d = Number.isInteger(dp) ? dp : 2;
  return Math.min(Math.max(d, 0), 10);
}

/** Replace the ASCII hyphen-minus produced by Intl with a true minus sign. */
function withMinus(text) {
  return text.startsWith("-") ? MINUS + text.slice(1) : text;
}

/**
 * Fixed-decimal number with thousands grouping: fmt(1234.567, 1) -> "1,234.6".
 * Values that round to zero never show as "-0".
 */
export function fmt(n, dp = 2) {
  if (!isNum(n)) return MISSING;
  const d = clampDp(dp);
  const rounded = Number(n.toFixed(d));
  const value = Object.is(rounded, -0) || rounded === 0 ? 0 : n;
  return withMinus(numberFormatter({ minimumFractionDigits: d, maximumFractionDigits: d }).format(value));
}

/** Temperature in degrees Celsius: fmtC(38.456) -> "38.5 °C". */
export function fmtC(n, dp = 1) {
  if (!isNum(n)) return MISSING;
  return `${fmt(n, dp)}\u00a0°C`;
}

/** Explicitly signed number: fmtSigned(0.3) -> "+0.30", fmtSigned(-1.2, 1) -> "−1.2". */
export function fmtSigned(n, dp = 2) {
  if (!isNum(n)) return MISSING;
  const text = fmt(n, dp);
  if (text.startsWith(MINUS)) return text;
  const isZero = Number(n.toFixed(clampDp(dp))) === 0;
  return isZero ? `\u00b1${text}` : `+${text}`;
}

/** Signed temperature difference: fmtDeltaC(-1.23) -> "−1.23 °C". */
export function fmtDeltaC(n, dp = 2) {
  if (!isNum(n)) return MISSING;
  return `${fmtSigned(n, dp)}\u00a0°C`;
}

/** Fraction (0..1) as percent: fmtPct(0.214) -> "21%", fmtPct(0.214, 1) -> "21.4%". */
export function fmtPct(frac, dp = 0) {
  if (!isNum(frac)) return MISSING;
  return `${fmt(frac * 100, dp)}%`;
}

/** Integer with grouping: fmtInt(55012) -> "55,012". */
export function fmtInt(n) {
  if (!isNum(n)) return MISSING;
  return withMinus(numberFormatter({ maximumFractionDigits: 0 }).format(Math.round(n)));
}

/** Compact notation for large magnitudes: 12900 -> "12.9K", 4.2e6 -> "4.2M". */
export function fmtCompact(n, dp = 1) {
  if (!isNum(n)) return MISSING;
  if (Math.abs(n) < 1000) return fmt(n, Math.abs(n) < 10 && !Number.isInteger(n) ? dp : 0);
  return withMinus(
    numberFormatter({ notation: "compact", maximumFractionDigits: clampDp(dp) }).format(n),
  );
}

/** Number with `sig` significant digits, compact for |n| >= 10k: fmtSig(0.0012345, 3) -> "0.00123". */
export function fmtSig(n, sig = 3) {
  if (!isNum(n)) return MISSING;
  if (n === 0) return "0";
  if (Math.abs(n) >= 10000) return fmtCompact(n, 1);
  return withMinus(numberFormatter({ maximumSignificantDigits: Math.max(1, sig) }).format(n));
}

/** Area in km²: fmtKm2(1234.5) -> "1,235 km²". */
export function fmtKm2(n) {
  if (!isNum(n)) return MISSING;
  return `${n >= 100 ? fmtInt(n) : fmt(n, 1)}\u00a0km²`;
}

/**
 * Format a feature value according to its manifest metadata:
 * display "percent" -> "21.4%", "index" -> 3 decimals, "number" -> 3 significant digits + unit.
 */
export function fmtFeatureValue(meta, v) {
  if (!isNum(v)) return MISSING;
  const display = meta?.display ?? "number";
  if (display === "percent") return fmtPct(v, 1);
  if (display === "index") return fmt(v, 3);
  const unit = meta?.unit ? `\u00a0${meta.unit}` : "";
  return `${fmtSig(v, 3)}${unit}`;
}

/** Human label for a feature name from the manifest (falls back to the raw name). */
export function featureLabel(manifest, name) {
  if (!name) return "";
  const meta = manifest?.features?.find?.((f) => f.name === name);
  return meta?.label || name;
}

/** Feature metadata object from the manifest (or null). */
export function featureMeta(manifest, name) {
  return manifest?.features?.find?.((f) => f.name === name) ?? null;
}
