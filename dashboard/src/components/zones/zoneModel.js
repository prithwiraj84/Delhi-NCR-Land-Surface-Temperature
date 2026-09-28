/**
 * Pure derivations over `zones.json` (SPEC §4.6) for the Governance Zoning view.
 *
 * Science notes
 * - Zones are K-means clusters of the per-cell SHAP vectors (pooled over epochs), so a
 *   zone is a *mechanism* ("what drives heat here"), not an LST band. Canonical ids:
 *   0 Ecological Cool Base, 1 Riparian Buffer, 2 Transition, 3 Heat Extreme Core.
 * - Area shares are per epoch (cells of that epoch in the zone / all cells of the epoch);
 *   mean LST per epoch is in absolute °C, so it also carries the inter-annual climate
 *   offset - the anomaly vs the NCR epoch mean isolates the zone's relative heat.
 * - Transition matrices count the same grid cells in two epochs (rows = from zone,
 *   columns = to zone). Net flow into a zone = inflow from other zones − outflow to them.
 * - Silhouette quality bands follow Kaufman & Rousseeuw (1990): > 0.5 strong structure,
 *   0.25–0.5 reasonable, < 0.25 weak / overlapping.
 */
import { ZONE_COLORS, ZONE_NAMES } from "../../lib/colors.js";
import { isNum } from "../../lib/format.js";

/** Finite number or null (Number(null) would be 0). */
export const num = (v) => (isNum(v) ? v : null);

/** Priority ranks (lower = more urgent) and labels. */
export const PRIORITIES = Object.freeze([
  { id: "high", label: "High", rank: 0, variant: "cyan" },
  { id: "medium", label: "Medium", rank: 1, variant: "violet" },
  { id: "low", label: "Low", rank: 2, variant: "outline" },
]);

export function priorityMeta(id) {
  return PRIORITIES.find((p) => p.id === id) ?? { id: String(id ?? "unknown"), label: String(id ?? "—"), rank: 3, variant: "default" };
}

export const HEAT_CORE_ID = 3;

/** Sorted epoch years present in the zone profiles (area_km2 keys), numbers. */
export function zoneEpochs(zones, manifest) {
  const years = new Set();
  for (const z of Array.isArray(zones?.zones) ? zones.zones : []) {
    for (const k of Object.keys(z?.area_km2 ?? {})) if (isNum(Number(k))) years.add(Number(k));
  }
  if (!years.size) for (const y of manifest?.epochs ?? []) if (isNum(Number(y))) years.add(Number(y));
  return [...years].sort((a, b) => a - b);
}

/** The requested year if the zones cover it, else the latest covered year (or null). */
export function resolveEpoch(years, year) {
  if (!years.length) return null;
  const y = Number(year);
  return years.includes(y) ? y : years[years.length - 1];
}

/** Epoch before `year` in `years` (null for the first). */
export function previousEpoch(years, year) {
  const i = years.indexOf(year);
  return i > 0 ? years[i - 1] : null;
}

/** Zone profiles sorted by canonical id, with colour/name fallbacks from the manifest. */
export function orderedZones(zones, zonesMeta) {
  const list = Array.isArray(zones?.zones) ? zones.zones.filter((z) => z && isNum(Number(z.id))) : [];
  return [...list]
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((z) => {
      const id = Number(z.id);
      const meta = Array.isArray(zonesMeta) ? zonesMeta.find((m) => Number(m.id) === id) : null;
      return {
        ...z,
        id,
        name: z.name || meta?.name || ZONE_NAMES[id] || `Zone ${id}`,
        color: z.color || meta?.color || ZONE_COLORS[id] || "#94a3b8",
      };
    });
}

const at = (obj, year) => (year === null || year === undefined ? null : num(obj?.[String(year)]));

/** Total mapped area (km²) of an epoch across all zones. */
export function totalArea(zoneList, year) {
  let total = 0;
  let any = false;
  for (const z of zoneList) {
    const a = at(z.area_km2, year);
    if (a !== null) {
      total += a;
      any = true;
    }
  }
  return any ? total : null;
}

/**
 * Per-zone headline numbers for the current epoch plus the per-epoch series used by the
 * sparklines.
 * @returns {{id, name, color, area, share, prevArea, prevShare, deltaArea, deltaSharePp,
 *            lstObs, lstPred, prevLstObs, deltaLst, anomaly, nCells,
 *            series: {year, share, lst, anomaly}[]}[]}
 */
export function zoneSummaries(zoneList, years, year, epochMeans) {
  const prev = previousEpoch(years, year);
  const totals = Object.fromEntries(years.map((y) => [y, totalArea(zoneList, y)]));
  const shareOf = (z, y) => {
    const a = at(z.area_km2, y);
    const t = totals[y];
    return a !== null && t ? a / t : null;
  };
  const meanOf = (y) => num(epochMeans?.[String(y)]);
  return zoneList.map((z) => {
    const area = at(z.area_km2, year);
    const prevArea = at(z.area_km2, prev);
    const share = shareOf(z, year);
    const prevShare = prev !== null ? shareOf(z, prev) : null;
    const lstObs = at(z.lst_obs_mean, year);
    const prevLstObs = at(z.lst_obs_mean, prev);
    const epochMean = meanOf(year);
    return {
      id: z.id,
      name: z.name,
      color: z.color,
      area,
      share,
      prevYear: prev,
      prevArea,
      prevShare,
      deltaArea: area !== null && prevArea !== null ? area - prevArea : null,
      deltaSharePp: share !== null && prevShare !== null ? (share - prevShare) * 100 : null,
      lstObs,
      lstPred: at(z.lst_pred_mean, year),
      prevLstObs,
      deltaLst: lstObs !== null && prevLstObs !== null ? lstObs - prevLstObs : null,
      anomaly: lstObs !== null && epochMean !== null ? lstObs - epochMean : null,
      nCells: at(z.n_cells, year),
      series: years.map((y) => {
        const lst = at(z.lst_obs_mean, y);
        const m = meanOf(y);
        return { year: y, share: shareOf(z, y), lst, anomaly: lst !== null && m !== null ? lst - m : null };
      }),
    };
  });
}

/** Top-n SHAP means by |value| (the zone's "signature"), strongest first. */
export function shapSignature(zone, n = 8) {
  return Object.entries(zone?.shap_means ?? {})
    .map(([feature, value]) => ({ feature, value: num(value) }))
    .filter((r) => r.value !== null)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, n);
}

/** Max |value| across every zone's signature (shared scale so cards compare fairly). */
export function signatureMaxAbs(signatures) {
  let m = 0;
  for (const sig of signatures) for (const r of sig) m = Math.max(m, Math.abs(r.value));
  return m || 1;
}

/**
 * Flatten every zone's recommendations into policy-table rows.
 * Rows keep the zone identity (id, name, colour) and a stable id.
 */
export function mergeRecommendations(zoneList) {
  const rows = [];
  for (const z of zoneList) {
    (Array.isArray(z.recommendations) ? z.recommendations : []).forEach((r, i) => {
      if (!r?.feature) return;
      const ci = Array.isArray(r.ci) && r.ci.length === 2 && isNum(r.ci[0]) && isNum(r.ci[1]) ? [r.ci[0], r.ci[1]] : null;
      rows.push({
        id: `${z.id}-${r.feature}-${i}`,
        zoneId: z.id,
        zoneName: z.name,
        zoneColor: z.color,
        feature: r.feature,
        action: r.action === "decrease" ? "decrease" : "increase",
        current: num(r.current),
        target: num(r.target),
        delta: num(r.expected_delta_c),
        ci,
        priority: r.priority ?? "low",
        priorityRank: priorityMeta(r.priority).rank,
        rationale: typeof r.rationale === "string" ? r.rationale : "",
      });
    });
  }
  return rows;
}

/** Parse "2010->2015" into {key, from, to}; invalid keys are dropped. Sorted by from, to. */
export function transitionPairs(transitions) {
  return Object.keys(transitions ?? {})
    .map((key) => {
      const m = /^\s*(\d{4})\s*-+>\s*(\d{4})\s*$/.exec(key);
      return m ? { key, from: Number(m[1]), to: Number(m[2]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.from - b.from || a.to - b.to);
}

/** Default pair: the one ending at `year`, else the one starting at it, else the latest. */
export function defaultPair(pairs, year) {
  if (!pairs.length) return null;
  return (
    pairs.find((p) => p.to === year) ?? pairs.find((p) => p.from === year) ?? pairs[pairs.length - 1]
  ).key;
}

/**
 * Validate a K×K count matrix and derive row/column totals, row percentages and per-zone
 * inflow / outflow / net flow (off-diagonal only). Returns null for malformed input.
 */
export function transitionStats(matrix) {
  if (!Array.isArray(matrix) || !matrix.length) return null;
  const k = matrix.length;
  if (!matrix.every((row) => Array.isArray(row) && row.length === k)) return null;
  const counts = matrix.map((row) => row.map((v) => (isNum(v) && v >= 0 ? v : 0)));
  const rowTotals = counts.map((row) => row.reduce((a, b) => a + b, 0));
  const colTotals = counts[0].map((_, j) => counts.reduce((a, row) => a + row[j], 0));
  const total = rowTotals.reduce((a, b) => a + b, 0);
  const rowPct = counts.map((row, i) => row.map((v) => (rowTotals[i] ? v / rowTotals[i] : null)));
  const inflow = counts[0].map((_, j) => colTotals[j] - counts[j][j]);
  const outflow = counts.map((row, i) => rowTotals[i] - row[i]);
  const net = inflow.map((v, j) => v - outflow[j]);
  const stayed = counts.reduce((a, row, i) => a + row[i], 0);
  let maxOff = 0;
  counts.forEach((row, i) => row.forEach((v, j) => {
    if (i !== j) maxOff = Math.max(maxOff, v);
  }));
  return { k, counts, rowTotals, colTotals, total, rowPct, inflow, outflow, net, persistence: total ? stayed / total : null, maxOff };
}

/** Cell area in km² from the manifest grid resolution (1 km default). */
export function cellAreaKm2(manifest) {
  const res = num(manifest?.study_area?.grid_res_m) ?? 1000;
  return (res / 1000) ** 2;
}

/** Kaufman & Rousseeuw silhouette interpretation. */
export function silhouetteQuality(s) {
  if (!isNum(s)) return { label: "unknown", tone: "default" };
  if (s > 0.5) return { label: "strong structure", tone: "emerald" };
  if (s >= 0.25) return { label: "reasonable structure", tone: "cyan" };
  return { label: "weak / overlapping", tone: "amber" };
}

/** Validated K-diagnostics rows [{k, inertia, silhouette}] sorted by k. */
export function diagnosticsRows(diagnostics) {
  const ks = Array.isArray(diagnostics?.k) ? diagnostics.k : [];
  return ks
    .map((k, i) => ({ k: Number(k), inertia: num(diagnostics?.inertia?.[i]), silhouette: num(diagnostics?.silhouette?.[i]) }))
    .filter((r) => isNum(r.k))
    .sort((a, b) => a.k - b.k);
}
