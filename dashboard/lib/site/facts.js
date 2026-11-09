/**
 * Build-time facts for the content pages, read from the REAL web bundle in public/data.
 *
 * Runs only on the server (Node fs) while Next.js statically generates the pages, so every
 * number on the landing / findings pages comes from the exported pipeline run, never from
 * hand-typed copy. Missing files degrade to nulls (the pages hide what is absent).
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const DATA = path.join(process.cwd(), "public", "data");
const MEDIA = path.join(process.cwd(), "public", "media");

function readJson(dir, name) {
  try {
    let bytes = fs.readFileSync(path.join(dir, name));
    if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = zlib.gunzipSync(bytes);
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const round = (v, dp = 1) => (num(v) === null ? null : Math.round(v * 10 ** dp) / 10 ** dp);

let cache = null;

/** Files of the web bundle (name, bytes), for the downloads table. */
function listFiles() {
  try {
    return fs
      .readdirSync(DATA, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith("."))
      .map((e) => ({ name: e.name, bytes: fs.statSync(path.join(DATA, e.name)).size }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/** All facts, computed once per build. */
export function getFacts() {
  if (cache) return cache;
  const manifest = readJson(DATA, "manifest.json");
  const metrics = readJson(DATA, "metrics.json");
  const series = readJson(DATA, "timeline_series.json.gz");
  const shap = readJson(DATA, "shap_global.json");

  const media = readJson(MEDIA, "media.json");
  const districtShapes = readJson(MEDIA, "districts.json");

  const groupLabel = Object.fromEntries((manifest?.groups ?? []).map((g) => [g.id, g.label]));
  const groupFamily = Object.fromEntries((manifest?.groups ?? []).map((g) => [g.id, g.family]));
  const tl = manifest?.timeline ?? {};
  const frames = tl.frames ?? [];
  const observedYears = frames.filter((f) => f.kind === "observed").map((f) => f.year);
  const projectedYears = frames.filter((f) => f.kind === "projected").map((f) => f.year);
  const scenarios = series?.scenarios ?? [];
  const ncr = series?.series?.ncr ?? {};

  // ---- per-mode NCR summaries ------------------------------------------------------------
  const modeSummary = (mode) => {
    const s = ncr[mode];
    if (!s) return null;
    const obs = (s.frames ?? []).filter((r) => num(r.mean) !== null);
    // Observed change uses evidence frames only: modelled hindcasts (night 1990/1995) are excluded.
    const evidence = obs.filter((r) => r.tier !== "modelled");
    const first = evidence[0];
    const last = evidence.at(-1);
    const dec = s.decomposition ?? {};
    const proj = Object.fromEntries(
      scenarios.map((id) => {
        const rows = s.ssp?.[id] ?? [];
        const r2050 = rows.find((r) => r.year === 2050);
        const d = dec[id]?.["2050"];
        const base = num(d?.baseline_c) ?? num(series?.baseline_level_c?.[mode]);
        return [
          id,
          {
            rows: rows.map((r) => ({ year: r.year, p05: r.p05, p25: r.p25, p50: r.p50, p75: r.p75, p95: r.p95 })),
            p50: num(r2050?.p50),
            delta: base !== null && num(r2050?.p50) !== null ? round(r2050.p50 - base, 2) : null,
            lo: base !== null && num(r2050?.p05) !== null ? round(r2050.p05 - base, 2) : null,
            hi: base !== null && num(r2050?.p95) !== null ? round(r2050.p95 - base, 2) : null,
            climate: num(d?.climate),
            land: num(d?.land),
            baseline: base,
          },
        ];
      }),
    );
    return {
      frames: obs.map((r) => ({ year: r.year, mean: r.mean, ci: r.ci, tier: r.tier, hotCoreKm2: r.hot_core_km2, uhi: r.uhi })),
      first: first ? { year: first.year, mean: first.mean } : null,
      last: last ? { year: last.year, mean: last.mean } : null,
      change: first && last ? round(last.mean - first.mean, 1) : null,
      trend: s.trend?.obs ? { perDecade: round(s.trend.obs.slope_per_decade, 2), ci: s.trend.obs.ci?.map((v) => round(v, 2)), period: s.trend.obs.period } : null,
      baseline: num(series?.baseline_level_c?.[mode]),
      uhi: num(obs.at(-1)?.uhi),
      hotCoreKm2: num(obs.at(-1)?.hot_core_km2),
      projections: proj,
      budget: s.uncertainty_budget ?? null,
    };
  };

  // ---- model accuracy ----------------------------------------------------------------------
  const MODEL_LABEL = { xgboost: "XGBoost", lightgbm: "LightGBM", random_forest: "Random forest", gnn: "Graph neural net", ridge: "Ridge regression" };
  const accuracy = (mode) => {
    const m = metrics?.modes?.[mode];
    if (!m) return null;
    const block = (m.summary ?? []).filter((r) => r.scheme === "block20");
    return {
      spatial: m.headline?.spatial ? { r2: round(m.headline.spatial.r2, 3), rmse: round(m.headline.spatial.rmse, 2), model: m.headline.spatial.model } : null,
      temporal: m.headline?.temporal ? { r2: round(m.headline.temporal.r2, 3), rmse: round(m.headline.temporal.rmse, 2) } : null,
      benchmarks: block
        .map((r) => ({ id: r.model, label: MODEL_LABEL[r.model] ?? r.model, r2: round(r.r2_pooled, 3), rmse: round(r.rmse_pooled, 2), mae: round(r.mae_pooled, 2), n: r.n }))
        .sort((a, b) => b.r2 - a.r2),
      nTrain: m.summary?.[0]?.n ?? null,
    };
  };

  // ---- SHAP drivers --------------------------------------------------------------------------
  const drivers = (mode) => {
    const s = shap?.modes?.[mode];
    if (!s?.global) return [];
    return (s.order ?? s.groups.map((_, i) => i)).map((i) => ({
      id: s.groups[i],
      label: groupLabel[s.groups[i]] ?? s.groups[i],
      family: groupFamily[s.groups[i]] ?? null,
      value: round(s.global.mean_abs[i], 2),
      lo: round(s.global.ci_lo?.[i], 2),
      hi: round(s.global.ci_hi?.[i], 2),
    }));
  };

  // ---- districts: 2025 day mean and change since the first frame ---------------------------
  const districtNames = Object.fromEntries((manifest?.districts ?? []).map((d) => [d.id, d]));
  const districts = Object.entries(series?.series ?? {})
    .filter(([id]) => id.startsWith("d:"))
    .map(([id, s]) => {
      const d = districtNames[Number(id.slice(2))];
      const day = (s.day?.frames ?? []).filter((r) => num(r.mean) !== null);
      const night = (s.night?.frames ?? []).filter((r) => num(r.mean) !== null);
      const p2050 = s.day?.ssp?.ssp245?.find((r) => r.year === 2050)?.p50 ?? null;
      return {
        id,
        name: d?.name ?? id,
        state: d?.state ?? "",
        day2025: num(day.at(-1)?.mean),
        night2025: num(night.at(-1)?.mean),
        dayChange: day.length > 1 ? round(day.at(-1).mean - day[0].mean, 1) : null,
        day2050: num(p2050),
      };
    })
    .filter((d) => d.day2025 !== null)
    .sort((a, b) => b.day2025 - a.day2025);

  // ---- zones ----------------------------------------------------------------------------------
  const zones = (mode) =>
    (manifest?.zones?.[mode] ?? []).map((z) => ({ id: z.id, name: z.display_name ?? z.name, color: z.color, caveat: z.label_caveat ?? null }));

  const cs = metrics?.climate_sensitivity ?? {};
  const projMeta = metrics?.projection_meta?.day?.ssp245 ?? null;

  cache = {
    generatedAt: manifest?.generated_at ?? null,
    dataMode: manifest?.data_mode ?? null,
    profile: metrics?.profile ?? manifest?.generator?.profile ?? null,
    area: {
      km2: manifest?.study_area?.area_km2 ?? null,
      cells: manifest?.study_area?.n_cells ?? null,
      gridM: manifest?.study_area?.grid_res_m ?? null,
      fineM: manifest?.study_area?.fine_res_m ?? null,
      bbox: manifest?.study_area?.bbox ?? null,
      center: manifest?.study_area?.center ?? null,
      districts: (manifest?.districts ?? []).length,
    },
    season: manifest?.season ?? null,
    years: { observed: observedYears, projected: projectedYears, all: frames.map((f) => f.year) },
    scenarios,
    features: { count: (manifest?.features ?? []).length, groups: (manifest?.groups ?? []).length },
    modes: (manifest?.modes ?? []).map((m) => ({ id: m.id, label: m.label, target: m.target })),
    day: modeSummary("day"),
    night: modeSummary("night"),
    accuracy: { day: accuracy("day"), night: accuracy("night") },
    drivers: { day: drivers("day"), night: drivers("night") },
    districts,
    zones: { day: zones("day"), night: zones("night") },
    sensitivity: {
      day: cs.day ? { beta: round(cs.day.beta, 2), ci: cs.day.ci?.map((v) => round(v, 2)), years: cs.day.n_years } : null,
      night: cs.night ? { beta: round(cs.night.beta, 2), ci: cs.night.ci?.map((v) => round(v, 2)), years: cs.night.n_years } : null,
    },
    projection: projMeta ? { nMc: projMeta.n_mc, nGcm: projMeta.n_gcm, nLand: projMeta.n_land_real, omitted: projMeta.omitted_feedbacks ?? [] } : null,
    bootstrap: manifest?.bootstrap?.day ? { n: manifest.bootstrap.day.n, blockKm: manifest.bootstrap.day.block_size_km } : null,
    hardware: metrics?.hardware ? { gpus: metrics.hardware.gpus ?? [], xgb: metrics.hardware.xgb_version, python: metrics.hardware.python } : null,
    downscale: metrics?.downscaling?.night?.scale_invariance?.available
      ? { r2: metrics.downscaling.night.scale_invariance.r2, bilinearR2: metrics.downscaling.night.scale_invariance.bilinear_r2 }
      : null,
    notes: manifest?.notes ?? [],
    files: listFiles(),
    media,
    districtShapes,
  };
  return cache;
}

/** Format a signed temperature change ("+1.9 °C"). */
export function signed(v, dp = 1, unit = " °C") {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  const s = v.toFixed(dp);
  return `${v > 0 ? "+" : v < 0 ? "−" : "±"}${s.replace("-", "")}${unit}`;
}

/** Scenario labels. */
export const SSP_LABEL = Object.freeze({ ssp126: "SSP1-2.6", ssp245: "SSP2-4.5", ssp370: "SSP3-7.0", ssp585: "SSP5-8.5" });
export const SSP_STORY = Object.freeze({
  ssp126: "Sustainability: strong mitigation",
  ssp245: "Middle of the road",
  ssp585: "Fossil-fuelled development",
});
