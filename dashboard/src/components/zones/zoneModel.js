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

/**
 * Display name of a zone (D11): the exported `display_name` (zones.json / manifest), else the
 * canonical name. The canonical id, name and colour never change; only the label shown does
 * (e.g. "Moderate mosaic (no riparian signal)" when no cluster has a riparian signature).
 */
export function zoneDisplayName(z, fallback = null) {
  const d = z?.displayName ?? z?.display_name;
  if (typeof d === "string" && d.trim()) return d;
  return z?.name ?? fallback ?? (Number.isFinite(Number(z?.id)) ? ZONE_NAMES[Number(z.id)] ?? `Zone ${z.id}` : "Zone");
}

/** The zone's label caveat (D11 `label_caveat`), or null. */
export function zoneCaveat(z) {
  const c = z?.caveat ?? z?.label_caveat;
  return typeof c === "string" && c.trim() ? c : null;
}

/**
 * Normalised zone label entries of a mode: {id, name (canonical), color, displayName, caveat}
 * from manifest.zones[mode] (v2 per-mode lists), the old flat manifest list, or zones.json
 * modes[m].zones.
 */
export function zoneLabels(list) {
  return (Array.isArray(list) ? list : [])
    .filter((z) => z && Number.isFinite(Number(z.id)))
    .map((z) => {
      const id = Number(z.id);
      const name = z.name || ZONE_NAMES[id] || `Zone ${id}`;
      return { id, name, color: z.color || ZONE_COLORS[id] || "#94a3b8", displayName: zoneDisplayName({ ...z, name }), caveat: zoneCaveat(z) };
    });
}

/** Zone profiles sorted by canonical id, with colour/name fallbacks from the manifest. */
export function orderedZones(zones, zonesMeta) {
  const list = Array.isArray(zones?.zones) ? zones.zones.filter((z) => z && isNum(Number(z.id))) : [];
  return [...list]
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((z) => {
      const id = Number(z.id);
      const meta = Array.isArray(zonesMeta) ? zonesMeta.find((m) => Number(m.id) === id) : null;
      const name = z.name || meta?.name || ZONE_NAMES[id] || `Zone ${id}`;
      return {
        ...z,
        id,
        name,
        displayName: zoneDisplayName(z.display_name ? z : meta?.display_name ? meta : { name }),
        caveat: zoneCaveat(z) ?? zoneCaveat(meta),
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
      name: zoneDisplayName(z),
      canonicalName: z.name,
      caveat: zoneCaveat(z),
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
        zoneName: zoneDisplayName(z),
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

// ---------------------------------------------------------------------------------------
// v2 zones.json (SPEC §5.5): series-keyed areas / means / transitions
// ---------------------------------------------------------------------------------------

/** True when a zones asset uses the v2 series-keyed shape (`area_km2.obs`, `transitions.obs`). */
export function isSeriesKeyedZones(zones) {
  const z = Array.isArray(zones?.zones) ? zones.zones[0] : null;
  return Boolean(z?.area_km2 && typeof z.area_km2 === "object" && z.area_km2.obs && typeof z.area_km2.obs === "object");
}

/** v2 recommendation -> the v1 row fields the policy table reads (action, priority, target …). */
function normalizeRecommendation(r) {
  if (!r || typeof r !== "object") return r;
  const delta = num(r.expected_delta_c);
  const priority = r.priority ?? (delta === null ? "low" : delta <= -1 ? "high" : delta <= -0.3 ? "medium" : "low");
  const action = r.action ?? (num(r.delta) !== null && r.delta < 0 ? "decrease" : "increase");
  const rationale =
    typeof r.rationale === "string"
      ? r.rationale
      : [r.label, num(r.feasible_share) !== null ? `feasible in ${Math.round(r.feasible_share * 100)}% of the zone's cells` : null, "model-based counterfactual with focal features recomputed, not a causal effect"].filter(Boolean).join(" · ");
  return { ...r, action, priority, rationale, target: r.target ?? null, current: r.current ?? null };
}

/**
 * Present a v2 zones asset (one mode) in the v1 shape the zone components read, for one
 * series ("obs" by default): `area_km2[year]`, `lst_obs_mean[year]`, flat `transitions`.
 * The full series-keyed data stays available on `series` (per zone) and `transitionsBySeries`.
 * v1 assets are returned unchanged.
 * @param {object|null} zones
 * @param {{series?: string}} [options]
 */
export function normalizeZones(zones, { series = "obs" } = {}) {
  if (!zones || !isSeriesKeyedZones(zones)) return zones;
  const list = zones.zones.map((z) => ({
    ...z,
    displayName: zoneDisplayName(z),
    caveat: zoneCaveat(z),
    area_km2: { ...(z.area_km2?.[series] ?? {}) },
    lst_obs_mean: { ...(z.lst_mean?.[series] ?? z.lst_obs_mean?.[series] ?? {}) },
    lst_pred_mean: z.lst_pred_mean?.[series] ?? {},
    series: { area_km2: z.area_km2, lst_mean: z.lst_mean ?? null },
    recommendations: Array.isArray(z.recommendations) ? z.recommendations.map(normalizeRecommendation) : [],
  }));
  const diag = zones.diagnostics ?? {};
  return {
    ...zones,
    zones: list,
    transitions: zones.transitions?.[series] ?? {},
    transitionsBySeries: zones.transitions ?? {},
    // v1 KDiagnostics reads `k`; v2 exports `k_range`.
    diagnostics: { ...diag, k: diag.k ?? diag.k_range ?? [] },
  };
}

/**
 * Area-share trajectory of one zone across observed frames and each SSP (v2), as
 * [{year, share}] per series key; shares are relative to the total mapped area of that frame.
 * @returns {Record<string, {year: number, share: number}[]>}
 */
export function zoneShareTrajectories(zonesV2, zoneId) {
  const out = {};
  const zs = Array.isArray(zonesV2?.zones) ? zonesV2.zones : [];
  const own = zs.find((z) => Number(z.id) === Number(zoneId));
  const seriesKeys = Object.keys(own?.series?.area_km2 ?? own?.area_km2 ?? {});
  for (const key of seriesKeys) {
    const years = Object.keys(own.series?.area_km2?.[key] ?? {}).map(Number).filter(Number.isInteger).sort((a, b) => a - b);
    out[key] = years.map((y) => {
      const a = num(own.series.area_km2[key][String(y)]);
      let total = 0;
      for (const z of zs) total += num(z.series?.area_km2?.[key]?.[String(y)]) ?? 0;
      return { year: y, share: a !== null && total > 0 ? a / total : NaN };
    });
  }
  return out;
}

/**
 * Ordered alluvial columns from transition matrices: observed pairs, then (optionally) one
 * scenario's projected pairs chained from the last observed frame.
 * @returns {{columns: {year: number, projected: boolean, totals: number[]}[], flows: {from: number, to: number, matrix: number[][], projected: boolean}[]}}
 */
export function alluvialColumns(transitionsBySeries, { ssp = null } = {}) {
  const pairs = [];
  for (const p of transitionPairs(transitionsBySeries?.obs ?? (isFlatTransitions(transitionsBySeries) ? transitionsBySeries : {}))) {
    pairs.push({ ...p, matrix: (transitionsBySeries?.obs ?? transitionsBySeries)[p.key], projected: false });
  }
  if (ssp && transitionsBySeries?.[ssp]) for (const p of transitionPairs(transitionsBySeries[ssp])) pairs.push({ ...p, matrix: transitionsBySeries[ssp][p.key], projected: true });
  pairs.sort((a, b) => a.from - b.from || a.to - b.to);
  const chain = [];
  for (const p of pairs) {
    const prev = chain[chain.length - 1];
    if (!prev || p.from === prev.to) chain.push(p);
  }
  const valid = chain.filter((p) => transitionStats(p.matrix));
  if (!valid.length) return { columns: [], flows: [] };
  const columns = [];
  valid.forEach((p, k) => {
    const st = transitionStats(p.matrix);
    if (k === 0) columns.push({ year: p.from, projected: false, totals: st.rowTotals });
    columns.push({ year: p.to, projected: p.projected, totals: st.colTotals });
  });
  return { columns, flows: valid.map((p) => ({ from: p.from, to: p.to, matrix: transitionStats(p.matrix).counts, projected: p.projected })) };
}

function isFlatTransitions(t) {
  return Boolean(t) && typeof t === "object" && Object.keys(t).some((k) => /^\s*\d{4}\s*-+>\s*\d{4}\s*$/.test(k));
}

/** Non-zero flows of alluvialColumns() as table rows (the alluvial chart's table twin). */
export function alluvialRows(data, zoneName) {
  const out = [];
  for (const f of data?.flows ?? []) {
    f.matrix.forEach((row, i) =>
      row.forEach((v, j) => {
        if (v > 0) out.push({ id: `${f.from}-${f.to}-${i}-${j}`, pair: `${f.from} → ${f.to}`, from: zoneName(i), to: zoneName(j), cells: v, kind: f.projected ? "projected" : "observed" });
      }),
    );
  }
  return out;
}
