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

/**
 * Files of the web bundle (name, bytes), for the downloads table. Files of one sub-folder level
 * (the 250 m rasters in raster/) are listed as "raster/<name>".
 */
function listFiles() {
  const out = [];
  const walk = (dir, prefix) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory() && !prefix) walk(full, `${e.name}/`);
      else if (e.isFile()) out.push({ name: `${prefix}${e.name}`, bytes: fs.statSync(full).size });
    }
  };
  try {
    walk(DATA, "");
  } catch {
    return [];
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

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
    const low = evidence.reduce((a, r) => (a === null || r.mean < a.mean ? r : a), null);
    const tierYears = (tier) => obs.filter((r) => r.tier === tier).map((r) => r.year);
    // Trends of the annual (not frame) series: ERA5-Land air temperature and the satellite record.
    const annualTrend = (key) => {
      const a = s.trend?.annual?.[key];
      if (!a || num(a.slope_per_decade) === null) return null;
      return { perDecade: round(a.slope_per_decade, 2), ci: a.ci?.map((v) => round(v, 2)) ?? null, period: a.period ?? null, n: a.n_years ?? null };
    };
    const air = annualTrend(mode === "day" ? "era5_tmax" : "era5_tmin");
    const sat = annualTrend("satellite");
    const sensors = [...new Set((s.annual?.satellite ?? []).map((r) => r.sensor).filter(Boolean))];
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
      low: low ? { year: low.year, mean: low.mean } : null,
      tiers: { sparse: tierYears("observed-sparse"), reconstructed: tierYears("reconstructed"), modelled: tierYears("modelled") },
      trend:
        s.trend?.obs && num(s.trend.obs.slope_per_decade) !== null
          ? {
              perDecade: round(s.trend.obs.slope_per_decade, 2),
              ci: s.trend.obs.ci?.map((v) => round(v, 2)) ?? null,
              period: s.trend.obs.period ?? null,
              n: s.trend.obs.n_frames ?? s.trend.obs.frames?.length ?? null,
              method: s.trend.obs.method ?? null,
            }
          : null,
      annual: {
        air: air ? { ...air, variable: mode === "day" ? "daily maximum" : "daily minimum" } : null,
        satellite: sat ? { ...sat, sensors } : null,
      },
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
    const headModel = m.headline?.spatial?.model ?? "xgboost";
    const district = (m.summary ?? []).find((r) => r.scheme === "district" && r.model === headModel);
    return {
      spatial: m.headline?.spatial ? { r2: round(m.headline.spatial.r2, 3), rmse: round(m.headline.spatial.rmse, 2), model: m.headline.spatial.model } : null,
      temporal: m.headline?.temporal ? { r2: round(m.headline.temporal.r2, 3), rmse: round(m.headline.temporal.rmse, 2) } : null,
      // Whole districts held out (a harder, smaller-sample spatial test than 20 km blocks).
      district: district && num(district.r2_pooled) !== null ? { r2: round(district.r2_pooled, 3), rmse: round(district.rmse_pooled, 2) } : null,
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

  // Scenarios whose climate deltas are pattern-scaled from another SSP (not in NEX-GDDP-CMIP6 on Earth Engine).
  const patternScaled = Object.entries(metrics?.cmip6?.scenarios ?? {})
    .filter(([, v]) => v?.method === "pattern-scaled" && v.source_scenario)
    .map(([id, v]) => {
      const r = Object.entries(v.gsat_ratio ?? {})
        .map(([y, x]) => [Number(y), num(x)])
        .filter(([, x]) => x !== null)
        .sort((a, b) => a[0] - b[0]);
      return { id, from: v.source_scenario, ratio: r.length ? { first: round(r[0][1], 2), firstYear: r[0][0], last: round(r.at(-1)[1], 2), lastYear: r.at(-1)[0] } : null };
    });

  // Driver groups the final model may only cool with (monotone constraint −1).
  const featureGroup = Object.fromEntries((manifest?.features ?? []).map((ft) => [ft.id ?? ft.name, ft.group]));
  const monotoneCooling = (mode) => [
    ...new Set(
      Object.entries(metrics?.modes?.[mode]?.monotone ?? {})
        .filter(([, sign]) => sign === -1)
        .map(([feat]) => groupLabel[featureGroup[feat]] ?? null)
        .filter(Boolean),
    ),
  ];
  const season = Array.isArray(manifest?.season) && manifest.season.length === 2 ? manifest.season.map((d) => MONTHS[Number(String(d).slice(0, 2)) - 1]) : null;

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
    seasonLabel: season && season.every(Boolean) ? `${season[0]}–${season[1]}` : null,
    years: { observed: observedYears, projected: projectedYears, all: frames.map((f) => f.year) },
    // Sensor of every observed frame per mode (manifest.timeline.frames[].{day,night}.sensor).
    frameSensors: Object.fromEntries(
      ["day", "night"].map((mode) => [mode, frames.filter((fr) => fr.kind === "observed" && fr[mode]?.sensor).map((fr) => ({ year: fr.year, sensor: fr[mode].sensor }))]),
    ),
    scenarios,
    features: { count: (manifest?.features ?? []).length, groups: (manifest?.groups ?? []).length },
    modes: (manifest?.modes ?? []).map((m) => ({ id: m.id, label: m.label, target: m.target, overpass: m.reference_overpass_ist ?? null })),
    monotone: { day: monotoneCooling("day"), night: monotoneCooling("night") },
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
    projection: projMeta ? { nMc: projMeta.n_mc, nGcm: projMeta.n_gcm, nLand: projMeta.n_land_real, omitted: projMeta.omitted_feedbacks ?? [], patternScaled } : null,
    bootstrap: manifest?.bootstrap?.day ? { n: manifest.bootstrap.day.n, blockKm: manifest.bootstrap.day.block_size_km } : null,
    hardware: metrics?.hardware ? { gpus: metrics.hardware.gpus ?? [], xgb: metrics.hardware.xgb_version, python: metrics.hardware.python } : null,
    downscale: metrics?.downscaling?.night?.scale_invariance?.available
      ? {
          r2: metrics.downscaling.night.scale_invariance.r2,
          bilinearR2: metrics.downscaling.night.scale_invariance.bilinear_r2,
          coarseM: num(metrics.downscaling.night.scale_invariance.coarse_res_m),
          fineM: num(metrics.downscaling.night.scale_invariance.fine_res_m),
        }
      : null,
    // Neighbourhood (focal) windows, in grid cells.
    focalWindows: (manifest?.focal?.windows ?? []).filter((w) => Number.isFinite(w)),
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
  // The sign follows the rounded value, so −0.02 at 1 dp prints "±0.0", never "−0.0".
  const r = Number(s);
  return `${r > 0 ? "+" : r < 0 ? "−" : "±"}${s.replace("-", "")}${unit}`;
}

/**
 * A [lo, hi] interval as "+0.73 to +1.40 °C" (null when it is not a finite pair). `plain`
 * drops the signs, for quantities that are not changes (e.g. the sensitivity β).
 */
export function rangeText(ci, dp = 2, unit = " °C", plain = false) {
  if (!(Array.isArray(ci) && ci.length === 2 && ci.every((v) => Number.isFinite(v)))) return null;
  return plain ? `${ci[0].toFixed(dp)} to ${ci[1].toFixed(dp)}${unit}` : `${signed(ci[0], dp, "")} to ${signed(ci[1], dp, unit)}`;
}

/**
 * One sentence comparing the frame trend with the bundle's annual series of the same mode
 * (ERA5-Land air temperature, satellite LST), or null when neither annual trend is exported.
 */
export function annualContrast(summary, mode, seasonLabel = null) {
  const a = summary?.annual ?? {};
  const parts = [];
  const span = (t) => (t.period ? `${t.period[0]}–${t.period[1]}` : null);
  const describe = (t, what) => {
    const r = rangeText(t.ci);
    const extra = [span(t), r ? `95 % range ${r}` : null].filter(Boolean).join(", ");
    return `${what} changed by ${signed(t.perDecade, 2)} per decade${extra ? ` (${extra})` : ""}`;
  };
  if (a.air) parts.push({ t: a.air, text: describe(a.air, `ERA5-Land${seasonLabel ? ` ${seasonLabel}` : ""} ${a.air.variable} air temperature`) });
  if (a.satellite) {
    const who = a.satellite.sensors?.length ? a.satellite.sensors.join(" and ") : "satellite";
    parts.push({ t: a.satellite, text: describe(a.satellite, `the ${who} ${mode === "night" ? "night-time" : "daytime"} surface temperature`) });
  }
  if (!parts.length) return null;
  const warming = (t) => Array.isArray(t.ci) && t.ci[0] > 0;
  const zero = (t) => Array.isArray(t.ci) && t.ci[0] <= 0 && t.ci[1] >= 0;
  const list = parts.map((p) => p.text).join(" and ");
  if (parts.every((p) => warming(p.t))) return `The annual records in the bundle also show warming: ${list}.`;
  const lead = parts.some((p) => warming(p.t)) ? "The annual records in the bundle give a mixed picture" : "The annual records in the bundle do not show the same warming";
  const tail = parts.every((p) => zero(p.t)) ? `; ${parts.length > 1 ? "neither range excludes" : "its range includes"} zero` : "";
  return `${lead}: ${list}${tail}.`;
}

/**
 * Why XGBoost is the main model even when another benchmark scores marginally higher on the
 * 20 km blocks (what the pipeline actually does: monotone constraints, exact GPU TreeSHAP).
 */
export function modelChoice(f, mode = "day") {
  const b = f.accuracy?.[mode]?.benchmarks ?? [];
  const xgb = b.find((r) => r.id === "xgboost");
  const best = b[0];
  if (!xgb || !best) return null;
  const cooling = (f.monotone?.[mode] ?? []).map((l) => l.charAt(0).toLowerCase() + l.slice(1));
  const coolList = cooling.length > 1 ? `${cooling.slice(0, -1).join(", ")} or ${cooling.at(-1)}` : cooling[0];
  const why = `${coolList ? `its final models are trained with monotone constraints, so more ${coolList} can never raise a cell's predicted temperature, and ` : ""}their SHAP values are computed exactly with TreeSHAP on the GPU`;
  const where = `${mode === "night" ? "night-time" : "daytime"} R² on the 20 km blocks`;
  if (best.id === "xgboost") return `XGBoost is the main model and also has the best ${where}; ${why}.`;
  return `${best.label} scores marginally higher (${where}: ${best.r2.toFixed(3)} vs ${xgb.r2.toFixed(3)}), but XGBoost stays the main model: ${why}.`;
}

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

/** A count in words for prose ("three"), numerals above twelve; "" when not an integer. */
export function spell(n, capital = false) {
  if (!Number.isInteger(n)) return "";
  const w = n >= 0 && n < WORDS.length ? WORDS[n] : String(n);
  return capital ? w[0].toUpperCase() + w.slice(1) : w;
}

/** Scenario labels. */
export const SSP_LABEL = Object.freeze({ ssp126: "SSP1-2.6", ssp245: "SSP2-4.5", ssp370: "SSP3-7.0", ssp585: "SSP5-8.5" });
export const SSP_STORY = Object.freeze({
  ssp126: "Sustainability: strong mitigation",
  ssp245: "Middle of the road",
  ssp585: "Fossil-fuelled development",
});
