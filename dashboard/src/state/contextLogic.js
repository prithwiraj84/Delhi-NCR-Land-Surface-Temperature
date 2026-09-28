/**
 * Pure decision helpers of DataContext (kept out of the JSX module so they can be unit tested).
 */

/**
 * Scenarios are computed only while visible: the Threshold Explorer (simulator) is open or
 * the map shows the scenario layer. Everywhere else an unopened simulator costs nothing.
 */
export function scenarioIsActive(view, mapLayer) {
  return view === "thresholds" || mapLayer === "scenario";
}

/**
 * The scenario result to expose for the current epoch: a result computed for another epoch
 * (row indices of a different grid) is hidden until the re-run for this epoch lands.
 */
export function currentScenarioResult(result, year) {
  if (!result || year === null || year === undefined) return null;
  if (result.epochYear === undefined) return result;
  return Number(result.epochYear) === Number(year) ? result : null;
}

/** Years of `epochs` that the validation state has not checked yet. */
export function uncheckedYears(validation, epochs) {
  const done = new Set((validation?.epochsChecked ?? []).map(Number));
  return Object.keys(epochs ?? {})
    .map(Number)
    .filter((y) => Number.isFinite(y) && epochs[y] && !done.has(y))
    .sort((a, b) => a - b);
}

/** Merge a per-epoch validation into the running validation state. */
export function mergeValidation(prev, next) {
  if (!prev) return next;
  const errors = [...(prev.errors ?? []), ...(next.errors ?? [])];
  const warnings = [...(prev.warnings ?? []), ...(next.warnings ?? [])];
  const epochsChecked = [...new Set([...(prev.epochsChecked ?? []), ...(next.epochsChecked ?? [])])].sort((a, b) => a - b);
  return { ...prev, ok: errors.length === 0, errors, warnings, epochsChecked };
}
