/**
 * How to label and sanity-check the bootstrap intervals exported by the notebook
 * (SPEC §4.5 / §4.6).
 *
 * - Intervals come from a spatial block bootstrap with B replicates. With B < 50 the 2.5 / 97.5
 *   percentiles are essentially the replicate minimum and maximum, so the dashboard calls them a
 *   "replicate range" rather than a "95% CI". The notebook may also say so explicitly with
 *   `manifest.bootstrap.replicate_range = true`.
 * - `manifest.bootstrap.ci_method` ("recentred-percentile" = the notebook's default, i.e. the
 *   replicate spread shifted onto the full-data estimate; also "basic" = pivot, "percentile") is shown
 *   when present, and `intervalContains()` flags an estimate that falls outside its own
 *   interval (possible with raw percentile intervals of a biased resampling statistic).
 */
import { isNum } from "./format.js";

/** Replicate count below which percentile bounds are not called a 95% CI. */
export const MIN_BOOTSTRAP_FOR_CI = 50;

const METHOD_LABELS = Object.freeze({
  basic: "basic (pivot) bootstrap",
  pivot: "basic (pivot) bootstrap",
  bca: "bias-corrected (BCa) bootstrap",
  percentile: "percentile bootstrap",
  "recentred-percentile": "recentred-percentile bootstrap",
  subsampling: "m-out-of-n block subsampling",
});

/**
 * Bootstrap metadata normalised from the manifest (preferred) or shap_global.json.
 * @returns {{n: number|null, mode: string|null, method: string|null, methodLabel: string|null,
 *   rangeOnly: boolean, label: string, shortLabel: string, describe: string}}
 *   `label` is "95% CI" or "replicate range"; `describe` is a one-line provenance note.
 */
export function bootstrapInfo(manifest, shapGlobal = null) {
  const b = manifest?.bootstrap && typeof manifest.bootstrap === "object" ? manifest.bootstrap : {};
  const rawN = b.n ?? shapGlobal?.n_bootstrap;
  const n = isNum(Number(rawN)) && rawN !== null && rawN !== undefined ? Number(rawN) : null;
  const mode = b.mode ?? shapGlobal?.bootstrap_mode ?? null;
  const methodRaw = b.ci_method ?? b.interval ?? shapGlobal?.ci_method ?? null;
  const method = typeof methodRaw === "string" ? methodRaw.toLowerCase() : null;
  const rangeOnly = b.replicate_range === true || (n !== null && n < MIN_BOOTSTRAP_FOR_CI);
  const label = rangeOnly ? "replicate range" : "95% CI";
  const methodLabel = method ? METHOD_LABELS[method] ?? method : null;
  const parts = [
    n !== null ? `${n} ${mode ? `${mode} ` : ""}bootstrap replicates` : "bootstrap replicates",
    methodLabel ? `${methodLabel} interval` : null,
    rangeOnly ? `fewer than ${MIN_BOOTSTRAP_FOR_CI} replicates, so the bounds are a replicate range, not a 95% CI` : null,
  ].filter(Boolean);
  return {
    n,
    mode,
    method,
    methodLabel,
    rangeOnly,
    label,
    shortLabel: rangeOnly ? "range" : "95% CI",
    describe: `${parts.join("; ")}.`,
  };
}

/** A [lo, hi] pair (sorted) or null when either end is missing. */
export function normalizeInterval(ci) {
  return Array.isArray(ci) && ci.length === 2 && isNum(ci[0]) && isNum(ci[1])
    ? [Math.min(ci[0], ci[1]), Math.max(ci[0], ci[1])]
    : null;
}

/**
 * True / false when the estimate lies inside / outside [lo, hi] (with a relative tolerance for
 * rounding in the export); null when either is missing.
 */
export function intervalContains(estimate, ci, tol = 1e-6) {
  const pair = normalizeInterval(ci);
  if (!pair || !isNum(estimate)) return null;
  const slack = tol * Math.max(1, Math.abs(estimate), Math.abs(pair[0]), Math.abs(pair[1]));
  return estimate >= pair[0] - slack && estimate <= pair[1] + slack;
}
